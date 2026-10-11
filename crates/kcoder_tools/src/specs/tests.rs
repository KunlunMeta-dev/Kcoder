use super::*;
use kcoder_state::AppState;
use std::sync::{Arc, RwLock};

fn spec_ctx(cwd: &std::path::Path, active: Vec<&str>) -> ToolContext {
    spec_ctx_with_options(cwd, active, false, None)
}

fn spec_ctx_with_options(
    cwd: &std::path::Path,
    active: Vec<&str>,
    auto_lessons_learned: bool,
    registry: Option<Arc<RwLock<kcoder_skills::SkillRegistry>>>,
) -> ToolContext {
    let mut ctx = ToolContext::new(AppState::new(cwd)).with_active_skills(Arc::new(RwLock::new(
        active.into_iter().map(str::to_string).collect(),
    )));
    if let Some(registry) = registry {
        ctx = ctx.with_skill_registry(registry);
    }
    ctx.with_auto_lessons_learned(auto_lessons_learned)
}

fn complete_change_tasks(cwd: &std::path::Path, name: &str) {
    fs::write(
        cwd.join(".kcoder/specs/changes")
            .join(name)
            .join("tasks.md"),
        "- [x] done\n- [x] cargo test\n",
    )
    .unwrap();
}

fn text_output(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn spec_subagent_schemas_bound_max_turns() {
    for schema in [
        ReviewDispatchStage.input_schema(),
        SpecParallelDraftTool.input_schema(),
    ] {
        let max_turns = schema.get("properties").unwrap().get("max_turns").unwrap();
        assert_eq!(max_turns.get("minimum").unwrap(), MIN_AGENT_MAX_TURNS);
        assert_eq!(max_turns.get("maximum").unwrap(), MAX_AGENT_MAX_TURNS);
    }
}

#[tokio::test]
async fn spec_init_reloads_runtime_registry_and_activates_using_specs() {
    let tmp = tempfile::tempdir().unwrap();
    let registry = Arc::new(RwLock::new(
        kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
    ));
    let active = Arc::new(RwLock::new(Vec::new()));
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_skill_registry(Arc::clone(&registry))
        .with_active_skills(Arc::clone(&active));
    let tool = SpecInitTool;

    tool.call(serde_json::json!({}), &ctx)
        .await
        .expect("spec init should reload runtime skills");

    assert!(registry.read().unwrap().get_active("using-specs").is_some());
    assert!(
        registry
            .read()
            .unwrap()
            .get_active("using-superpowers")
            .is_some()
    );
    assert!(
        active
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "using-specs")
    );
    assert!(
        active
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "using-superpowers")
    );
    let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    let bundled = provenance.skills.get("using-superpowers").unwrap();
    assert_eq!(
        bundled.origin,
        crate::skill_provenance::SkillOrigin::Bundled
    );
    assert!(bundled.bundled_hash.is_some());
    assert_eq!(
        provenance.skills.get("using-specs").unwrap().origin,
        crate::skill_provenance::SkillOrigin::Bundled
    );
    let manifest_path = tmp.path().join(".kcoder/skills/.bundled_manifest");
    assert!(
        manifest_path.is_file(),
        "SpecInit should initialize the bundled skill sync manifest"
    );
    let manifest: crate::bundled_skills::BundledManifest =
        serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest.version, 1);
    let using_superpowers = manifest.skills.get("using-superpowers").unwrap();
    assert_eq!(
        using_superpowers.source,
        "crates/kcoder_specs/src/skills/using-superpowers/SKILL.md"
    );
    assert!(manifest.skills.contains_key("brainstorming"));
    assert!(
        !tmp.path()
            .join(".kcoder/skills/using-superpowers/references/codex-tools.md")
            .exists(),
        "SpecInit should not restore removed external tool mappings"
    );
}

#[tokio::test]
async fn spec_init_force_update_preserves_project_config() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
    kcoder_specs::config::config_set(&specs_dir, "context", "Preserve this tool-level context.")
        .unwrap();
    let active = Arc::new(RwLock::new(Vec::new()));
    let registry = Arc::new(RwLock::new(
        kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
    ));
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_skill_registry(Arc::clone(&registry))
        .with_active_skills(active);

    SpecInitTool
        .call(serde_json::json!({"force_update": true}), &ctx)
        .await
        .expect("forced SpecInit should refresh skills without resetting config");

    let config = kcoder_specs::config::read_or_default(&specs_dir).unwrap();
    assert_eq!(config.schema, "spec-driven-superpowers");
    assert_eq!(
        config.context.as_deref(),
        Some("Preserve this tool-level context.")
    );
    let using_specs = registry
        .read()
        .unwrap()
        .get_active("using-specs")
        .unwrap()
        .content
        .clone();
    assert!(using_specs.contains("spec-driven-superpowers"));
    assert!(using_specs.contains("Preserve this tool-level context."));
}

#[tokio::test]
async fn spec_init_rejects_malformed_config_before_activating_skills() {
    let tmp = tempfile::tempdir().unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    fs::create_dir_all(&specs_dir).unwrap();
    fs::write(
        specs_dir.join(kcoder_specs::config::CONFIG_FILE),
        "schema: [unterminated\n",
    )
    .unwrap();
    let active = Arc::new(RwLock::new(Vec::new()));
    let ctx = ToolContext::new(AppState::new(tmp.path())).with_active_skills(Arc::clone(&active));

    let error = SpecInitTool
        .call(serde_json::json!({}), &ctx)
        .await
        .expect_err("malformed config should fail SpecInit");

    assert!(error.to_string().contains("failed to parse"));
    assert!(active.read().unwrap().is_empty());
}

#[tokio::test]
async fn spec_init_preserves_user_created_provenance_for_existing_local_skills() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join(".kcoder").join("skills");
    let local_superpowers = r#"---
name: using-superpowers
description: Local root protocol
user_invocable: false
paths:
  - ".kcoder/specs/**"
---

# Local Using Superpowers
"#;
    let local_using_specs = r#"---
name: using-specs
description: Local spec protocol
user_invocable: false
paths:
  - ".kcoder/specs/**"
---

# Local Using Specs
"#;
    fs::create_dir_all(root.join("using-superpowers")).unwrap();
    fs::write(
        root.join("using-superpowers").join("SKILL.md"),
        local_superpowers,
    )
    .unwrap();
    fs::create_dir_all(root.join("using-specs")).unwrap();
    fs::write(root.join("using-specs").join("SKILL.md"), local_using_specs).unwrap();
    crate::skill_provenance::record_user_created(tmp.path(), "using-superpowers");
    crate::skill_provenance::record_user_created(tmp.path(), "using-specs");

    let registry = Arc::new(RwLock::new(
        kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
    ));
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_skill_registry(registry)
        .with_active_skills(Arc::new(RwLock::new(Vec::new())));
    let tool = SpecInitTool;

    tool.call(serde_json::json!({}), &ctx)
        .await
        .expect("spec init should preserve existing local skills by default");

    assert_eq!(
        fs::read_to_string(root.join("using-superpowers").join("SKILL.md")).unwrap(),
        local_superpowers
    );
    assert_eq!(
        fs::read_to_string(root.join("using-specs").join("SKILL.md")).unwrap(),
        local_using_specs
    );
    let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    for name in ["using-superpowers", "using-specs"] {
        let record = provenance.skills.get(name).unwrap();
        assert_eq!(
            record.origin,
            crate::skill_provenance::SkillOrigin::UserCreated
        );
        assert!(record.bundled_hash.is_none());
    }
    assert!(
        root.join("using-superpowers")
            .join("SKILL.md.new")
            .is_file(),
        "conflicting bundled Superpowers updates should be staged separately"
    );
}

#[tokio::test]
async fn spec_update_regenerates_using_specs_from_config_and_reloads_registry() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(
        &specs_dir,
        "context",
        "Project uses a Rust workspace with spec-first changes.",
    )
    .unwrap();
    let using_specs_file = tmp
        .path()
        .join(kcoder_specs::SPEC_SKILL_DIR)
        .join("SKILL.md");
    fs::write(
            &using_specs_file,
            "---\nname: using-specs\ndescription: stale\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Stale",
        )
        .unwrap();
    let registry = Arc::new(RwLock::new(
        kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
    ));
    let active = Arc::new(RwLock::new(Vec::new()));
    let ctx = ToolContext::new(AppState::new(tmp.path()))
        .with_skill_registry(Arc::clone(&registry))
        .with_active_skills(Arc::clone(&active));
    let tool = SpecUpdateTool;

    let output = tool
        .call(serde_json::json!({}), &ctx)
        .await
        .expect("spec update should refresh workflow skills");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["dry_run"], false);
    assert!(
        output["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action.as_str().unwrap().starts_with("update: using-specs"))
    );
    let content = fs::read_to_string(&using_specs_file).unwrap();
    assert!(content.contains("Project uses a Rust workspace"));
    assert!(content.contains("SpecStatus"));
    assert!(
        registry
            .read()
            .unwrap()
            .get_active("using-specs")
            .unwrap()
            .content
            .contains("Project uses a Rust workspace")
    );
    assert!(
        active
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "using-specs")
    );
    assert!(
        active
            .read()
            .unwrap()
            .iter()
            .any(|skill| skill == "using-superpowers")
    );
}

#[tokio::test]
async fn spec_update_dry_run_reports_without_writing_using_specs() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&specs_dir, "context", "Dry run context").unwrap();
    let using_specs_file = tmp
        .path()
        .join(kcoder_specs::SPEC_SKILL_DIR)
        .join("SKILL.md");
    fs::write(
            &using_specs_file,
            "---\nname: using-specs\ndescription: stale\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Stale",
        )
        .unwrap();
    let before = fs::read_to_string(&using_specs_file).unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecUpdateTool;

    let output = tool
        .call(serde_json::json!({"dry_run": true}), &ctx)
        .await
        .expect("dry-run spec update should report planned changes");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["dry_run"], true);
    assert!(
        output["actions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|action| action.as_str().unwrap().starts_with("update: using-specs"))
    );
    assert_eq!(fs::read_to_string(&using_specs_file).unwrap(), before);
}

#[tokio::test]
async fn spec_update_does_not_restore_removed_codex_tool_mapping() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let asset = tmp
        .path()
        .join(".kcoder/skills/using-superpowers/references/codex-tools.md");
    assert!(!asset.exists());
    let ctx = spec_ctx(tmp.path(), vec![]);

    let output = SpecUpdateTool
        .call(serde_json::json!({}), &ctx)
        .await
        .expect("SpecUpdate should preserve the current bundled skill inventory");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert!(!asset.exists());
    assert!(
        output["bundled"]["actions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|action| !action.as_str().unwrap().contains("codex-tools.md"))
    );
}

#[tokio::test]
async fn spec_update_preserves_non_bundled_using_specs_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&specs_dir, "context", "Conflict context").unwrap();
    let using_specs_file = tmp
        .path()
        .join(kcoder_specs::SPEC_SKILL_DIR)
        .join("SKILL.md");
    let local_content = "---\nname: using-specs\ndescription: local\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Local";
    fs::write(&using_specs_file, local_content).unwrap();
    crate::skill_provenance::record_user_created(tmp.path(), "using-specs");
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecUpdateTool;

    let output = tool
        .call(serde_json::json!({}), &ctx)
        .await
        .expect("spec update should stage conflicted using-specs updates");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert!(output["actions"].as_array().unwrap().iter().any(|action| {
        action
            .as_str()
            .unwrap()
            .starts_with("conflict: using-specs")
    }));
    assert_eq!(
        fs::read_to_string(&using_specs_file).unwrap(),
        local_content
    );
    let staged = using_specs_file.with_file_name("SKILL.md.new");
    assert!(
        fs::read_to_string(staged)
            .unwrap()
            .contains("Conflict context")
    );
}

#[tokio::test]
async fn spec_new_change_requires_using_specs_skill() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecNewChangeTool;

    let err = tool
        .call(serde_json::json!({"name": "guarded-change"}), &ctx)
        .await
        .expect_err("spec mutation should require using-specs and using-superpowers");

    assert!(err.to_string().contains("using-specs"));
    assert!(err.to_string().contains("using-superpowers"));
}

#[tokio::test]
async fn spec_new_change_requires_superpowers_root_skill() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let ctx = spec_ctx(tmp.path(), vec!["using-specs"]);
    let tool = SpecNewChangeTool;

    let err = tool
        .call(serde_json::json!({"name": "guarded-change"}), &ctx)
        .await
        .expect_err("spec mutation should require using-superpowers root protocol");

    assert!(err.to_string().contains("using-superpowers"));
}

#[tokio::test]
async fn spec_new_change_runs_when_superpowers_and_using_specs_are_active() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let ctx = spec_ctx(tmp.path(), vec!["using-superpowers", "using-specs"]);
    let tool = SpecNewChangeTool;

    tool.call(serde_json::json!({"name": "guarded-change"}), &ctx)
        .await
        .expect("active using-superpowers and using-specs should allow spec mutation");

    assert!(
        tmp.path()
            .join(".kcoder/specs/changes/guarded-change/proposal.md")
            .exists()
    );
}

#[tokio::test]
async fn spec_status_tool_reports_change_summary() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    complete_change_tasks(tmp.path(), "add-auth");
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecStatusTool;

    let output = tool
        .call(serde_json::json!({"name": "add-auth"}), &ctx)
        .await
        .expect("status should report an existing change");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["change"], "add-auth");
    assert_eq!(output["title"], "Add auth");
    assert_eq!(output["tasks"]["complete"], true);
    assert_eq!(output["drift"]["ok"], true);
    assert_eq!(output["artifacts"]["proposal.md"]["exists"], true);
    assert_eq!(output["artifacts"]["tasks.md"]["complete"], true);
    assert_eq!(output["ready_to_apply"], true);
}

#[tokio::test]
async fn spec_status_tool_reports_superpowers_apply_blockers() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
    let change_dir =
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    complete_change_tasks(tmp.path(), "add-auth");
    fs::write(
        change_dir.join("review.md"),
        "# Review\n\n## Readiness Decision\n\nblocked\n\n## Blocked By\n\napproval missing\n",
    )
    .unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecStatusTool;

    let output = tool
        .call(serde_json::json!({"name": "add-auth"}), &ctx)
        .await
        .expect("status should report blockers");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["schema"], "spec-driven-superpowers");
    assert_eq!(output["ready_to_apply"], false);
    assert!(
        output["apply"]["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|blocker| blocker.as_str().unwrap().contains("Readiness Decision"))
    );
}

#[tokio::test]
async fn spec_apply_preflight_tool_reports_plan_coverage() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
    let change_dir =
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    fs::write(
        change_dir.join("tasks.md"),
        "# Tasks\n\n- [ ] 1.1 Implement behavior\n- [ ] 1.2 Add tests\n",
    )
    .unwrap();
    fs::write(
        change_dir.join("plan.md"),
        "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run focused tests.\n",
    )
    .unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecPreflightOperation;

    let output = tool
        .call(serde_json::json!({"name": "add-auth"}), &ctx)
        .await
        .expect("preflight should report coverage");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["change_name"], "add-auth");
    assert_eq!(output["ok"], false);
    assert_eq!(output["task_coverage"]["uncovered_task_ids"][0], "1.2");
}

#[tokio::test]
async fn spec_record_verification_tool_writes_evidence_file() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = SpecRecordVerificationTool;

    let output = tool
        .call(
            serde_json::json!({
                "name": "add-auth",
                "completion_decision": "complete",
                "commands_run": ["cargo test -p kcoder_tools: passed"],
                "manual_checks": ["reviewed status output"],
                "evidence": ["target/debug/deps/kcoder_tools-*"],
                "residual_risks": ["none"]
            }),
            &ctx,
        )
        .await
        .expect("verification evidence should be written");

    assert!(text_output(&output).contains("Recorded verification evidence"));
    let verification = fs::read_to_string(
        tmp.path()
            .join(".kcoder/specs/changes/add-auth/verification.md"),
    )
    .unwrap();
    assert!(verification.contains("## Completion Decision"));
    assert!(verification.contains("cargo test -p kcoder_tools: passed"));
}

#[tokio::test]
async fn spec_review_writeback_tool_updates_review_artifacts() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
    let change_dir =
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = ReviewWritebackStage;

    let output = tool
        .call(
            serde_json::json!({
                "name": "add-auth",
                "review_status": "findings-received",
                "findings_summary": ["accepted: add auth regression coverage"],
                "accepted_followups": ["Add auth regression coverage"],
                "verification_notes": ["Retain auth regression evidence"]
            }),
            &ctx,
        )
        .await
        .expect("review writeback should update artifacts");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["change_name"], "add-auth");
    assert_eq!(output["tasks_updated"], true);
    assert_eq!(output["publication"]["committed"], true);
    assert_eq!(output["publication"]["recovery_pending"], false);
    let review = fs::read_to_string(change_dir.join("review.md")).unwrap();
    assert!(review.contains("findings-received"));
    let tasks = fs::read_to_string(change_dir.join("tasks.md")).unwrap();
    assert!(tasks.contains("Add auth regression coverage"));
    let plan = fs::read_to_string(change_dir.join("plan.md")).unwrap();
    assert!(plan.contains("Add auth regression coverage"));
    let verification = fs::read_to_string(change_dir.join("verification.md")).unwrap();
    assert!(verification.contains("Retain auth regression evidence"));
}

#[tokio::test]
async fn spec_publication_review_preflight_error_keeps_every_existing_document() {
    let temp = tempfile::tempdir().unwrap();
    kcoder_specs::init(temp.path()).unwrap();
    let root = temp.path().join(kcoder_specs::SPECS_DIR);
    kcoder_specs::config::config_set(&root, "schema", "spec-driven-superpowers").unwrap();
    let change = kcoder_specs::new_change(temp.path(), "writeback", None).unwrap();
    fs::write(
        change.join("verification.md"),
        "# Verification\n\nKeep previous evidence.\n",
    )
    .unwrap();
    fs::remove_file(change.join("plan.md")).unwrap();
    let before: Vec<_> = ["review.md", "tasks.md", "verification.md"]
        .into_iter()
        .map(|file| (file, fs::read(change.join(file)).unwrap()))
        .collect();
    let output = SpecReviewTool.call(serde_json::json!({
        "name":"writeback","action":"writeback","review_status":"findings-received",
        "findings_summary":["accepted: preserve state"],"accepted_followups":["Keep the followup"],
        "verification_notes":["Keep verification evidence"]
    }), &spec_ctx(temp.path(), vec!["using-superpowers", "using-specs"])).await;
    assert!(output.is_err());
    for (file, bytes) in before {
        assert_eq!(fs::read(change.join(file)).unwrap(), bytes);
    }
}

#[tokio::test]
async fn spec_publication_sync_tool_returns_the_typed_commit_receipt() {
    let temp = tempfile::tempdir().unwrap();
    kcoder_specs::init(temp.path()).unwrap();
    kcoder_specs::new_change(temp.path(), "synced", None).unwrap();
    let output = SpecSyncTool
        .call(
            serde_json::json!({"name":"synced"}),
            &spec_ctx(temp.path(), vec!["using-superpowers", "using-specs"]),
        )
        .await
        .unwrap();
    assert!(!output.is_error);
    let receipt: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(receipt["publication"]["committed"], true);
    assert_eq!(receipt["publication"]["recovery_pending"], false);
    assert_eq!(receipt["base_updated"], true);
    assert!(
        receipt["summary"]
            .as_str()
            .unwrap()
            .contains("Base snapshot updated")
    );
}

#[tokio::test]
async fn spec_show_tool_returns_status_and_change_files() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let change_dir =
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    fs::write(
        change_dir.join("proposal.md"),
        "# Add auth\n\nImplement token refresh.\n",
    )
    .unwrap();
    let spec_dir = change_dir.join("specs").join("auth");
    fs::create_dir_all(&spec_dir).unwrap();
    fs::write(
        spec_dir.join("spec.md"),
        "## ADDED Requirements\n\n### Requirement: Token refresh\n",
    )
    .unwrap();
    let ctx = spec_ctx(tmp.path(), vec![]);
    let tool = StatusDeepRead;

    let output = tool
        .call(
            serde_json::json!({"name": "add-auth", "max_file_bytes": 16}),
            &ctx,
        )
        .await
        .expect("show should serialize an existing change");

    let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
    assert_eq!(output["name"], "add-auth");
    assert_eq!(output["status"]["name"], "add-auth");
    let files = output["files"].as_array().unwrap();
    assert!(files.iter().any(|file| file["path"] == "proposal.md"));
    assert!(
        files
            .iter()
            .any(|file| file["path"] == "specs/auth/spec.md")
    );
    let proposal = files
        .iter()
        .find(|file| file["path"] == "proposal.md")
        .unwrap();
    assert_eq!(proposal["truncated"], true);
    assert!(proposal["content"].as_str().unwrap().len() <= 16);
}

#[tokio::test]
async fn spec_archive_generates_lessons_skill_when_enabled() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    let change_dir =
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    fs::write(
        change_dir.join("proposal.md"),
        "# Add auth\n\n- Risk: stale sessions need rollback testing.\n",
    )
    .unwrap();
    fs::write(
        change_dir.join("design.md"),
        "## Verification\n\n- Run cargo test -p kcoder_tools.\n",
    )
    .unwrap();
    complete_change_tasks(tmp.path(), "add-auth");

    let registry = Arc::new(RwLock::new(
        kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
    ));
    let ctx = spec_ctx_with_options(
        tmp.path(),
        vec!["using-superpowers", "using-specs"],
        true,
        Some(Arc::clone(&registry)),
    );
    let tool = SpecArchiveTool;

    let output = tool
        .call(serde_json::json!({"name": "add-auth"}), &ctx)
        .await
        .expect("archive should generate lessons skill");

    let output = text_output(&output);
    assert!(output.contains("generated lessons-learned skill"));

    let skill_name = "lessons-learned-add-auth";
    let skill_file = tmp
        .path()
        .join(".kcoder")
        .join("skills")
        .join(skill_name)
        .join("SKILL.md");
    let skill = fs::read_to_string(&skill_file).unwrap();
    assert!(skill.contains("name: lessons-learned-add-auth"));
    assert!(skill.contains("From archived change `add-auth`"));
    assert!(skill.contains("Risk: stale sessions need rollback testing."));
    assert!(skill.contains("Run cargo test -p kcoder_tools."));

    let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
    assert_eq!(
        provenance.skills.get(skill_name).unwrap().origin,
        crate::skill_provenance::SkillOrigin::AgentCreated
    );

    let usage: crate::skill_telemetry::SkillTelemetryStore = serde_json::from_str(
        &fs::read_to_string(tmp.path().join(".kcoder/skills/.usage.json")).unwrap(),
    )
    .unwrap();
    assert!(usage.skills.contains_key(skill_name));
    assert!(registry.read().unwrap().get_active(skill_name).is_some());
}

#[tokio::test]
async fn spec_archive_skips_lessons_skill_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    kcoder_specs::init(tmp.path()).unwrap();
    kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
    complete_change_tasks(tmp.path(), "add-auth");
    let ctx = spec_ctx(tmp.path(), vec!["using-superpowers", "using-specs"]);
    let tool = SpecArchiveTool;

    let output = tool
        .call(serde_json::json!({"name": "add-auth"}), &ctx)
        .await
        .expect("archive should succeed without lessons generation");

    let output = text_output(&output);
    assert!(!output.contains("generated lessons-learned skill"));
    assert!(
        !tmp.path()
            .join(".kcoder/skills/lessons-learned-add-auth/SKILL.md")
            .exists()
    );
}
