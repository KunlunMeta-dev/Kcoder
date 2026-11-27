//! Private, successful node checkpoints and explicit source-run admission.
use super::*;
use anyhow::Result;
pub(super) use kcoder_workflow_observations::checkpoints::{ensure_effects_known, load, save};
use sha2::{Digest, Sha256};

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
}
