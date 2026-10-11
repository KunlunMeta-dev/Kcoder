//! Spec skill updates adapter behavior; domain operations remain in kcoder_specs.

use super::*;

pub(super) fn activate_skill(ctx: &ToolContext, name: &str) -> bool {
    let Some(active_skills) = ctx.active_skills.as_ref() else {
        return false;
    };

    let mut active = active_skills.write().unwrap();
    if active.iter().any(|skill| skill == name) {
        return false;
    }
    active.push(name.to_string());
    true
}

pub(super) fn activate_using_specs_skill(ctx: &ToolContext) -> bool {
    activate_skill(ctx, USING_SPECS_SKILL_NAME)
}

pub(super) fn activate_superpowers_root_skill(ctx: &ToolContext) -> bool {
    activate_skill(ctx, SUPERPOWERS_ROOT_SKILL_NAME)
}

pub(super) fn reload_skill_registry(ctx: &ToolContext) -> Result<bool, ToolError> {
    ctx.reload_skill_registry()
}

pub(super) fn rendered_using_specs_content(cwd: &Path) -> String {
    let specs_dir = cwd.join(kcoder_specs::SPECS_DIR);
    let config = kcoder_specs::config::read_or_default(&specs_dir).ok();
    kcoder_specs::render_using_specs_skill(config.as_ref())
}

pub(super) fn plan_using_specs_update(
    cwd: &Path,
    expected_content: &str,
    force_update: bool,
) -> UsingSpecsUpdatePlan {
    let skill_file = cwd.join(kcoder_specs::SPEC_SKILL_DIR).join("SKILL.md");
    let new_file = skill_file.with_file_name("SKILL.md.new");
    let expected_hash = crate::bundled_skills::stable_hash(expected_content);
    let explicit_non_bundled = crate::skill_provenance::load_project_provenance(cwd)
        .ok()
        .and_then(|store| store.skills.get("using-specs").cloned())
        .is_some_and(|record| record.origin != crate::skill_provenance::SkillOrigin::Bundled);

    let action = match fs::read_to_string(&skill_file) {
        Ok(local) if crate::bundled_skills::stable_hash(&local) == expected_hash => {
            "unchanged: using-specs".to_string()
        }
        Ok(_) if explicit_non_bundled && !force_update => {
            format!("conflict: using-specs -> {}", new_file.display())
        }
        Ok(_) => format!("update: using-specs -> {}", skill_file.display()),
        Err(_) => format!("install: using-specs -> {}", skill_file.display()),
    };
    let conflict = action.starts_with("conflict: ");
    UsingSpecsUpdatePlan {
        action,
        conflict,
        new_file,
    }
}

pub(super) fn maybe_generate_lessons_learned_skill(
    ctx: &ToolContext,
    change_name: &str,
    archive_dir: &Path,
) -> Result<Option<PathBuf>, ToolError> {
    if !ctx.auto_lessons_learned {
        return Ok(None);
    }
    let skill_name = format!("lessons-learned-{}", sanitize_skill_name(change_name));
    let skill_dir = project_skills_root(&ctx.state.cwd()).join(&skill_name);
    let skill_file = skill_dir.join("SKILL.md");
    if skill_file.exists() {
        return Ok(None);
    }

    let content = render_lessons_skill(&ctx.state.cwd(), change_name, archive_dir, &skill_name)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut provenance = kcoder_skills::SkillMetadataPatch::default();
    provenance
        .create
        .insert("origin".to_string(), serde_json::json!("agent_created"));
    provenance
        .create
        .insert("created_by".to_string(), serde_json::json!("agent"));
    provenance
        .create
        .insert("created_at".to_string(), serde_json::json!(now.clone()));
    provenance.update.insert(
        "write_origin".to_string(),
        serde_json::json!(format!("lessons_learned:{change_name}")),
    );
    let mut usage = kcoder_skills::SkillMetadataPatch::default();
    usage
        .create
        .insert("created_at".to_string(), serde_json::json!(now));
    usage
        .create
        .insert("state".to_string(), serde_json::json!("active"));
    usage
        .create
        .insert("pinned".to_string(), serde_json::json!(false));
    let root = project_skills_root(&ctx.state.cwd());
    let store = kcoder_skills::SkillStore::open(&root).map_err(skill_store_error)?;
    let session_id = ctx.state.session_id();
    let operation_identity = ctx
        .tool_call_id
        .clone()
        .unwrap_or_else(|| session_id.clone());
    let receipt = store
        .commit(kcoder_skills::SkillCommitRequest {
            operation_id: format!("lessons-learned:{}:{}", skill_name, operation_identity),
            actor: kcoder_skills::SkillMutationActor::System {
                component: format!("lessons_learned:{change_name}"),
                session_id: Some(session_id),
            },
            operation: kcoder_skills::SkillOperationKind::LessonsLearned,
            preconditions: Vec::new(),
            mutations: vec![kcoder_skills::SkillMutation::PutPackage {
                package: kcoder_skills::SkillPackage {
                    name: skill_name.clone(),
                    files: vec![kcoder_skills::SkillPackageFile {
                        relative_path: PathBuf::from("SKILL.md"),
                        content: content.into_bytes(),
                        executable: false,
                    }],
                },
                expected: kcoder_skills::ExpectedSkillRevision::Absent,
            }],
            metadata: kcoder_skills::SkillMetadataDelta {
                provenance: std::collections::BTreeMap::from([(skill_name.clone(), provenance)]),
                usage: std::collections::BTreeMap::from([(skill_name.clone(), usage)]),
                ..Default::default()
            },
        })
        .map_err(skill_store_error)?;
    let mut refresh = ctx.clone();
    refresh.record_project_skill_telemetry = false;
    match refresh.reload_skill_registry() {
        Ok(_) => record_spec_reload_status(&root, Some(&receipt.transaction_id), true),
        Err(error) => {
            record_spec_reload_status(&root, Some(&receipt.transaction_id), false);
            tracing::warn!(%error, "lessons-learned transaction committed but registry reload is pending");
        }
    }
    Ok(Some(skill_file))
}

pub(super) fn project_skills_root(cwd: &Path) -> PathBuf {
    crate::skill_provenance::project_skills_root(cwd)
}

pub(super) fn write_using_specs_conflict(
    ctx: &ToolContext,
    root: &Path,
    path: &Path,
    content: &str,
) -> Result<kcoder_skills::SkillCommitReceipt, ToolError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        ToolError::InvalidInput("using-specs conflict path escaped the skill root".to_string())
    })?;
    let store = kcoder_skills::SkillStore::open(root).map_err(skill_store_error)?;
    store
        .commit(kcoder_skills::SkillCommitRequest {
            operation_id: format!(
                "spec-conflict:{}",
                ctx.tool_call_id
                    .clone()
                    .unwrap_or_else(|| ctx.state.session_id())
            ),
            actor: kcoder_skills::SkillMutationActor::ForegroundAgent {
                session_id: ctx.state.session_id(),
                tool_call_id: ctx
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "spec-update".to_string()),
            },
            operation: kcoder_skills::SkillOperationKind::SpecSync,
            preconditions: Vec::new(),
            mutations: Vec::new(),
            metadata: kcoder_skills::SkillMetadataDelta {
                auxiliary_files: std::collections::BTreeMap::from([(
                    relative.to_path_buf(),
                    content.as_bytes().to_vec(),
                )]),
                ..Default::default()
            },
        })
        .map_err(skill_store_error)
}

pub(super) fn skill_store_error(error: kcoder_skills::SkillStoreError) -> ToolError {
    match error {
        kcoder_skills::SkillStoreError::Conflict {
            name,
            expected,
            actual,
        } => ToolError::InvalidInput(format!(
            "status=conflict; skill={name}; expected_revision={expected}; actual_revision={actual}"
        )),
        other => ToolError::Execution(other.to_string()),
    }
}

pub(super) fn record_spec_reload_status(root: &Path, transaction_id: Option<&str>, reloaded: bool) {
    let Some(transaction_id) = transaction_id else {
        return;
    };
    match kcoder_skills::SkillStore::open(root)
        .and_then(|store| store.record_reload_status(transaction_id, reloaded))
    {
        Ok(()) => {}
        Err(error) => tracing::warn!(
            %error,
            transaction_id,
            "failed to persist spec skill registry reload status"
        ),
    }
}

pub(super) fn require_using_specs_skill(ctx: &ToolContext) -> Result<(), ToolError> {
    let Some(active_skills) = ctx.active_skills.as_ref() else {
        return Err(ToolError::Execution(
            "spec workflow requires active skill tracking; activate `using-superpowers` and `using-specs` before mutating specs"
                .to_string(),
        ));
    };

    let active = active_skills.read().unwrap();
    let has_using_specs = active.iter().any(|skill| skill == USING_SPECS_SKILL_NAME);
    let has_superpowers_root = active
        .iter()
        .any(|skill| skill == SUPERPOWERS_ROOT_SKILL_NAME);
    if has_using_specs && has_superpowers_root {
        return Ok(());
    }

    Err(ToolError::Execution(
        "spec workflow is locked: activate `using-superpowers` and `using-specs` before creating, \
         syncing, archiving, configuring, or delegating spec-driven changes"
            .to_string(),
    ))
}
