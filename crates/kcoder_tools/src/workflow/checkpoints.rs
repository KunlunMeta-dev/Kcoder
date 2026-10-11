//! Private, successful node checkpoints and explicit source-run admission.
use super::*;
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

const MAX_CHECKPOINT_BYTES: usize = 4 * 1024 * 1024 + 4096;
const MAX_CHECKPOINT_STORAGE_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn configuration(ctx: &ToolContext) -> Result<Value, ToolError> {
    let mut value = json!({"workspace":ctx.state.cwd(),"arrangementMode":ctx.arrangement_mode,
        "model":ctx.runtime_model,"provider":ctx.runtime_provider});
    let policy = json!({"allowedWritePaths":ctx.allowed_write_paths,
        "allowedShellPrefixes":ctx.allowed_shell_prefixes,
        "blockShellFileMutation":ctx.block_shell_file_mutation,
        "blockDependencyMutation":ctx.block_dependency_mutation,
        "fileEditSurface":ctx.file_edit_surface,"toolLimits":ctx.tool_limits,
        "shellIsolationRoot":ctx.shell_isolation_root,
        "verifierMinimumTestScope":ctx.verifier_minimum_test_scope,
        "verifierRequireRawExitCode":ctx.verifier_require_raw_exit_code,
        "verifierRequireBehaviorDelta":ctx.verifier_require_behavior_delta,
        "verifierBaselineRoot":ctx.verifier_baseline_root,
        "sandbox":ctx.sandbox.as_ref().map(|sandbox| sandbox.reanchored_config()),
        "sandboxWritableRoots":ctx.sandbox.as_ref().map(|sandbox| sandbox.writable_roots()),
        "blockedSkillNames":ctx.blocked_skill_names,
        "trustExternalSkills":ctx.trust_external_skills,
        "skillRegistryGeneration":ctx.skill_registry_generation.as_ref().map(|generation|generation.load(Ordering::Acquire))});
    value["runtimePolicySha256"] = json!(format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&policy).map_err(|e| ToolError::Execution(e.to_string()))?
        )
    ));
    if let Some(settings) = &ctx.runtime_settings {
        let settings = settings
            .read()
            .map_err(|_| ToolError::Execution("Workflow settings lock poisoned".into()))?;
        value["settingsSha256"] = json!(format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({"settings":*settings,
                    "sessionAllowedTools":settings.session_allowed_tools,
                    "sessionDeniedTools":settings.session_denied_tools,
                    "sessionPermissionRules":settings.session_permission_rules,
                    "trainingMode":settings.training_mode}))
                .map_err(|e| ToolError::Execution(e.to_string()))?
            )
        ));
    }
    if let Some(runner) = &ctx.agent_runner {
        value["configuration"] = serde_json::to_value(
            runner
                .workflow_model_configuration()
                .map_err(|e| ToolError::Execution(e.to_string()))?,
        )
        .map_err(|e| ToolError::Execution(e.to_string()))?;
    }
    Ok(value)
}

pub(super) fn ensure_effects_known(run_dir: &Path) -> Result<()> {
    let directory = kcoder_config::PrivateDirectory::open_existing(run_dir)?;
    for (_, file) in directory.open_regular_files(|name| {
        name.to_string_lossy().starts_with("tool-") && name.to_string_lossy().ends_with(".json")
    })? {
        ensure!(
            file.metadata()?.len() <= 256 * 1024,
            "workflow_tool: invalid prior receipt"
        );
        let receipt: Value = serde_json::from_reader(file.take(256 * 1024 + 1))?;
        ensure!(
            matches!(receipt["status"].as_str(), Some("completed" | "blocked")),
            "workflow_tool: prior effect outcome is unknown; inspect it before continuing"
        );
    }
    Ok(())
}

pub(super) fn validate_source(
    run_dir: &Path,
    definition_id: &str,
) -> Result<WorkflowRunState, ToolError> {
    validated_source(run_dir, definition_id)?.ok_or_else(|| ToolError::InvalidInput("workflow_checkpoint_unavailable: this historical run predates dependency-closed node checkpoints; inspect its effects before explicitly starting a fresh run".into()))
}

pub(super) fn validated_source(
    run_dir: &Path,
    definition_id: &str,
) -> Result<Option<WorkflowRunState>, ToolError> {
    let source = WorkflowRunStore::open_for_resume(run_dir.into())?;
    let state = source.state.lock().unwrap().clone();
    let bytes = secure_read_file(&run_dir.join("definition.json"), 128 * 1024).map_err(|e| {
        ToolError::Execution(format!("reuse_from_run requires a pinned graph: {e}"))
    })?;
    if state.definition_sha256.as_deref() != Some(format!("{:x}", Sha256::digest(&bytes)).as_str())
    {
        return Err(ToolError::Execution(
            "workflow_corrupt: source graph checksum changed".into(),
        ));
    }
    let definition: kcoder_types::workflow::WorkflowDefinition =
        serde_json::from_slice(&bytes).map_err(|e| ToolError::Execution(e.to_string()))?;
    if definition.id != definition_id
        || state.source
            != format!(
                "definition:{}@{}",
                definition.id,
                definition.saved_version.unwrap_or(0)
            )
    {
        return Err(ToolError::InvalidInput(
            "reuse_from_run must belong to the same workflow definition".into(),
        ));
    }
    ensure_effects_known(run_dir).map_err(|e| ToolError::Execution(format!("{e:#}")))?;
    match state.checkpoint_format {
        Some(1) => Ok(Some(state)),
        None => Ok(None),
        Some(_) => Err(ToolError::InvalidInput(
            "workflow_checkpoint_unavailable: unsupported source checkpoint format".into(),
        )),
    }
}

fn path(run_dir: &Path, node_id: &str, fingerprint: &str) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(format!("{node_id}:{fingerprint}")));
    run_dir.join("checkpoints").join(format!("{key}.json"))
}

pub(super) fn load(run_dir: &Path, node_id: &str, fingerprint: &str) -> Result<Option<Value>> {
    let bytes = match secure_read_file(&path(run_dir, node_id, fingerprint), MAX_CHECKPOINT_BYTES) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).context("workflow_checkpoint: cannot read checkpoint"),
    };
    let record: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        record["format"] == 1
            && record["status"] == "completed"
            && record["nodeId"] == node_id
            && record["fingerprint"] == fingerprint,
        "workflow_checkpoint: invalid checkpoint identity"
    );
    let output = record
        .get("output")
        .context("workflow_checkpoint: missing output")?;
    ensure!(
        record["outputSha256"] == format!("{:x}", Sha256::digest(serde_json::to_vec(output)?)),
        "workflow_checkpoint: output checksum changed"
    );
    Ok(Some(output.clone()))
}

pub(super) fn save(run_dir: &Path, node_id: &str, fingerprint: &str, output: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(&json!({"format":1,"status":"completed","nodeId":node_id,
        "fingerprint":fingerprint,"output":output,
        "outputSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(output)?))}))?;
    ensure!(
        bytes.len() <= MAX_CHECKPOINT_BYTES,
        "workflow_checkpoint: output exceeds checkpoint budget"
    );
    secure_create_dir(&run_dir.join("checkpoints"))?;
    let directory = kcoder_config::PrivateDirectory::open_existing(&run_dir.join("checkpoints"))?;
    let target = path(run_dir, node_id, fingerprint);
    let target_name = target
        .file_name()
        .context("workflow_checkpoint: invalid target")?;
    let total = directory
        .open_regular_files(|name| name != target_name)?
        .into_iter()
        .try_fold(bytes.len() as u64, |total, (_, file)| -> Result<u64> {
            Ok(total.saturating_add(file.metadata()?.len()))
        })?;
    ensure!(
        total <= MAX_CHECKPOINT_STORAGE_BYTES,
        "workflow_checkpoint: retained node checkpoints exceed 64 MiB; start a new run with an explicit source run"
    );
    atomic_write_file(&target, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checkpoint_configuration_includes_session_permissions_and_host_scope() {
        let temp = tempfile::tempdir().unwrap();
        let settings = Arc::new(std::sync::RwLock::new(kcoder_config::Settings::default()));
        let mut context = ToolContext::new(kcoder_state::AppState::new(temp.path()))
            .with_runtime_settings(settings.clone());
        let original = configuration(&context).unwrap();
        let public_settings = serde_json::to_value(&*settings.read().unwrap()).unwrap();
        settings
            .write()
            .unwrap()
            .session_denied_tools
            .push("Bash".into());
        assert_eq!(
            serde_json::to_value(&*settings.read().unwrap()).unwrap(),
            public_settings
        );
        assert_ne!(
            configuration(&context).unwrap(),
            original,
            "nonpersisted permission changes must invalidate checkpoints"
        );
        let restricted = configuration(&context).unwrap();
        context.allowed_write_paths = vec!["allowed-only".into()];
        assert_ne!(
            configuration(&context).unwrap(),
            restricted,
            "host-injected write scope must invalidate checkpoints"
        );
    }
    #[test]
    fn checkpoints_require_exact_identity_and_preserve_json_types() {
        let temp = tempfile::tempdir().unwrap();
        save(
            temp.path(),
            "../node",
            "fingerprint-1",
            &json!({"items":[1,"1",null]}),
        )
        .unwrap();
        assert_eq!(
            load(temp.path(), "../node", "fingerprint-1").unwrap(),
            Some(json!({"items":[1,"1",null]}))
        );
        assert!(
            load(temp.path(), "../node", "fingerprint-2")
                .unwrap()
                .is_none()
        );
        assert!(
            load(temp.path(), "other", "fingerprint-1")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn unknown_effect_blocks_cross_version_replay() {
        let temp = tempfile::tempdir().unwrap();
        atomic_write_file(
            &temp.path().join("tool-call.json"),
            br#"{"status":"pending"}"#,
        )
        .unwrap();
        assert!(
            ensure_effects_known(temp.path())
                .unwrap_err()
                .to_string()
                .contains("unknown")
        );
        atomic_write_file(
            &temp.path().join("tool-call.json"),
            br#"{"status":"completed"}"#,
        )
        .unwrap();
        ensure_effects_known(temp.path()).unwrap();
    }
}
