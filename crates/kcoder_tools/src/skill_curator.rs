use crate::skill_telemetry::{load_store, project_skills_root};
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use kcoder_skill_support::{
    SkillSupportError,
    curator::{self, CuratorHost},
};
use kcoder_skills::SkillMutationActor;
use serde_json::Value;
use std::path::PathBuf;

pub use kcoder_skill_support::curator::{SkillCuratorAction, SkillCuratorInput};

/// Curate the project skill lifecycle using usage/provenance telemetry.
#[derive(Debug, Default)]
pub struct SkillCuratorTool;

impl CuratorHost for ToolContext {
    fn cwd(&self) -> PathBuf {
        self.state.cwd()
    }

    fn session_id(&self) -> String {
        self.state.session_id()
    }

    fn mutation_actor(&self) -> Option<&SkillMutationActor> {
        self.skill_mutation_actor.as_ref()
    }

    fn tool_call_id(&self) -> Option<&str> {
        self.tool_call_id.as_deref()
    }

    fn reload_registry(&self) -> Result<(), SkillSupportError> {
        let mut refresh = self.clone();
        refresh.record_project_skill_telemetry = false;
        refresh
            .reload_skill_registry()
            .map(|_| ())
            .map_err(|error| match error {
                ToolError::Execution(message) => SkillSupportError::Execution(message),
                ToolError::InvalidInput(message) => SkillSupportError::InvalidInput(message),
                other => SkillSupportError::Execution(other.to_string()),
            })
    }
}

#[async_trait]
impl Tool for SkillCuratorTool {
    fn name(&self) -> String {
        "skill_curator".to_string()
    }

    fn description(&self) -> String {
        "Govern the lifecycle of KCoder project skills using `.usage.json` and \
         `.provenance.json` — the housekeeping layer: stale detection, archiving, \
         and consolidation, not authoring or invoking. Use `status` to inspect skill health, `run` to mark \
         eligible AgentCreated skills stale and archive eligible AgentCreated skills, `pin`/`unpin` to \
         protect a skill from archiving, `usage` to inspect counters (optionally for one name), `mark_state` and `score_quality` to maintain telemetry, `archive`/`restore` to manually move skills under \
         `.kcoder/skills/.archive/`, `consolidate` to merge several narrow skills \
         into one new umbrella skill and archive the originals (one operation; different from \
         archiving each and recreating by hand), and \
         `review_and_patch` to apply an audited exact-string skill patch after \
         reviewer/sub-agent analysis. Authoring, activation, and bundled synchronization require separate attached controls."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SkillCuratorInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SkillCuratorInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let root = project_skills_root(&cwd);
        if matches!(input.action, SkillCuratorAction::Usage) {
            let output = crate::skill_telemetry::usage_query(&cwd, input.name.as_deref())?;
            return serde_json::to_string_pretty(&output)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize curator usage: {e}"))
                });
        }
        if matches!(input.action, SkillCuratorAction::ScoreQuality) {
            let worker_ctx = ctx.clone();
            let worker_root = root.clone();
            let name = input.name.clone();
            let (scored, usage) = tokio::task::spawn_blocking(move || {
                let scored =
                    curator::score_quality_transaction(&worker_ctx, &worker_root, name.as_deref())?;
                let usage =
                    load_store(&worker_root).map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok::<_, ToolError>((scored, usage))
            })
            .await
            .map_err(|error| ToolError::Execution(format!("curator worker failed: {error}")))??;
            let output = serde_json::json!({
                "success": true,
                "scored": scored,
                "skills": usage.skills.values().collect::<Vec<_>>(),
            });
            return serde_json::to_string_pretty(&output)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize curator quality: {e}"))
                });
        }
        let worker_ctx = ctx.clone();
        let result =
            tokio::task::spawn_blocking(move || curator::execute(&worker_ctx, &cwd, &root, input))
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("curator worker failed: {error}"))
                })??;

        serde_json::to_string_pretty(&result)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize curator result: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Tool;
    use crate::skill_provenance::SkillOrigin;
    use crate::skill_telemetry::SkillState;
    use flate2::read::GzDecoder;
    use kcoder_skill_support::curator::QUALITY_RETAIN_SPECIFICITY_SCORE;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use std::io::Read;
    use std::path::Path;
    use std::sync::{Arc, RwLock};

    fn tool_output_text(output: &ToolOutput) -> String {
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

    #[tokio::test]
    async fn archives_and_restores_project_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        SkillCuratorTool
            .call(
                serde_json::json!({"action": "archive", "name": "demo"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/demo/SKILL.md")
                .is_file()
        );
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "demo/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"archive\""));
        assert!(log.contains("\"skill\":\"demo\""));

        SkillCuratorTool
            .call(
                serde_json::json!({"action": "restore", "name": "demo"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 2);
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"restore\""));
    }

    #[tokio::test]
    async fn archive_rejects_user_created_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_user_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({"action": "archive", "name": "demo"}),
                &ctx,
            )
            .await;

        let err = result.expect_err("user-created skills require an explicit override");
        assert!(err.to_string().contains("agent-created skills by default"));
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        assert!(!tmp.path().join(".kcoder/skills/.archive/demo").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn archive_rejects_pinned_agent_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "demo", true).unwrap();
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({"action": "archive", "name": "demo"}),
                &ctx,
            )
            .await;

        let err = result.expect_err("pinned skills should not be archived");
        assert!(err.to_string().contains("is pinned"));
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        assert!(!tmp.path().join(".kcoder/skills/.archive/demo").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn archive_explicit_override_allows_user_created_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_user_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "archive",
                    "name": "demo",
                    "include_non_agent_created": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/demo/SKILL.md")
                .is_file()
        );
        assert_eq!(backup_files(tmp.path()).len(), 1);
    }

    #[tokio::test]
    async fn archive_override_still_rejects_bundled_skill_without_include_bundled() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(tmp.path(), "bundled-demo", "# Bundled Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "bundled-demo");
        crate::skill_provenance::record_bundled(tmp.path(), "bundled-demo", "hash");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "archive",
                    "name": "bundled-demo",
                    "include_non_agent_created": true
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("bundled skills require include_bundled");
        assert!(err.to_string().contains("bundled skills by default"));
        assert!(
            tmp.path()
                .join(".kcoder/skills/bundled-demo/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/bundled-demo")
                .exists()
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn archive_include_bundled_allows_explicit_bundled_archive() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(tmp.path(), "bundled-demo", "# Bundled Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "bundled-demo");
        crate::skill_provenance::record_bundled(tmp.path(), "bundled-demo", "hash");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "archive",
                    "name": "bundled-demo",
                    "include_bundled": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/bundled-demo/SKILL.md")
                .is_file()
        );
        assert_eq!(backup_files(tmp.path()).len(), 1);
    }

    #[tokio::test]
    async fn run_include_bundled_does_not_archive_user_created_skills() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(tmp.path(), "bundled-demo", "# Bundled Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "bundled-demo");
        crate::skill_provenance::record_bundled(tmp.path(), "bundled-demo", "hash");
        write_test_skill(tmp.path(), "user-demo", "# User Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "user-demo");
        crate::skill_provenance::record_user_created(tmp.path(), "user-demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        let output = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0,
                    "include_bundled": true,
                    "include_non_agent_created": false
                }),
                &ctx,
            )
            .await
            .unwrap();
        let output = tool_output_text(&output);

        assert!(output.contains("archive: bundled-demo"));
        assert!(!output.contains("mark stale: user-demo"));
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/bundled-demo/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/user-demo/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/user-demo")
                .exists()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let user_usage = usage.skills.get("user-demo").unwrap();
        assert_eq!(user_usage.state, SkillState::Active);
        assert!(
            user_usage.quality.is_none(),
            "automatic curator run should not write quality telemetry for user-created skills"
        );
    }

    #[tokio::test]
    async fn run_archives_agent_skill_with_backup_and_audit_log() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/demo/SKILL.md")
                .is_file()
        );
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "demo/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"run\""));
        assert!(log.contains("archive: demo"));
    }

    #[tokio::test]
    async fn run_retains_high_quality_agent_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp
            .path()
            .join(".kcoder")
            .join("skills")
            .join("quality-demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: quality-demo\ndescription: Specific reusable workflow\n---\n\n\
             # Quality Demo\n\n\
             1. Run cargo test before completion.\n\
             2. Verify output and inspect errors.\n\
             3. Avoid reporting success without evidence.\n\
             4. Run git status before summarizing.\n\n\
             - Test the behavior, not only file existence.\n\
             - Verify failures before changing implementation.\n\n\
             ```bash\ncargo test\ngit status\n```",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "quality-demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "quality-demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/quality-demo/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/quality-demo/SKILL.md")
                .exists()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let record = usage.skills.get("quality-demo").unwrap();
        assert_eq!(record.state, SkillState::Stale);
        assert!(
            record
                .quality
                .as_ref()
                .and_then(|quality| quality.specificity_score)
                .unwrap_or_default()
                >= QUALITY_RETAIN_SPECIFICITY_SCORE
        );
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("retain high-quality: quality-demo"));
    }

    #[tokio::test]
    async fn run_audits_quality_only_usage_mutation_once() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(
            tmp.path(),
            "demo",
            "# Demo\n\n1. Run cargo test.\n2. Verify output.\n```bash\ncargo test\n```",
        );
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_skill_registry(Arc::clone(&registry));

        let first = SkillCuratorTool
            .call(serde_json::json!({"action": "run"}), &ctx)
            .await
            .unwrap();
        let first_text = output_text(&first);

        assert!(first_text.contains("Curator applied 1 action(s)."));
        assert!(first_text.contains("refresh quality scores: demo"));
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        assert!(!tmp.path().join(".kcoder/skills/.archive/demo").exists());
        assert_eq!(backup_files(tmp.path()).len(), 1);
        let log_path = tmp.path().join(".kcoder/skills/.curator.log");
        let log = std::fs::read_to_string(&log_path).unwrap();
        assert!(log.contains("\"action\":\"run\""));
        assert!(log.contains("refresh quality scores: demo"));

        let second = SkillCuratorTool
            .call(serde_json::json!({"action": "run"}), &ctx)
            .await
            .unwrap();
        let second_text = output_text(&second);

        assert!(second_text.contains("Curator applied 0 action(s)."));
        assert_eq!(backup_files(tmp.path()).len(), 1);
        assert_eq!(std::fs::read_to_string(&log_path).unwrap(), log);
    }

    #[tokio::test]
    async fn run_skips_usage_records_without_live_skill() {
        let tmp = tempfile::tempdir().unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "missing-demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "missing-demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let output = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0
                }),
                &ctx,
            )
            .await
            .unwrap();
        let output = output_text(&output);

        assert!(output.contains("Curator applied 0 action(s)."));
        assert!(!tmp.path().join(".kcoder/skills/.archive").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("missing-demo").unwrap().state,
            SkillState::Active
        );
    }

    #[tokio::test]
    async fn review_and_patch_updates_agent_skill_with_audit_usage_and_provenance() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_skill_registry(Arc::clone(&registry));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "# Demo\n",
                    "new_string": "# Demo\n\n- Verify with cargo test before completion.\n",
                    "review_notes": "Added verification guidance from review."
                }),
                &ctx,
            )
            .await
            .unwrap();

        let content = std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap();
        assert!(content.contains("Verify with cargo test before completion."));
        assert!(registry.read().unwrap().get("demo").is_some());
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("demo").unwrap();
        assert_eq!(usage.patch_count, 1);
        assert!(usage.last_patched_at.is_some());
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("demo").unwrap();
        assert_eq!(provenance.origin, SkillOrigin::AgentCreated);
        assert_eq!(
            provenance.write_origin.as_deref(),
            Some("curator_review_patch")
        );
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "demo/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"review_and_patch\""));
        assert!(log.contains("Added verification guidance from review."));
    }

    #[tokio::test]
    async fn review_and_patch_rejects_user_created_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_user_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "# Demo\n",
                    "new_string": "# Demo\n\n- Patched.\n"
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("user-created skills should not be curator-patched");
        assert!(err.to_string().contains("only modifies agent-created"));
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn review_and_patch_rejects_pinned_agent_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "demo", true).unwrap();
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "# Demo\n",
                    "new_string": "# Demo\n\n- Patched.\n"
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("pinned skills should not be curator-patched");
        assert!(err.to_string().contains("is pinned"));
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn review_and_patch_rejects_invalid_skill_content_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "description: Demo\n",
                    "new_string": ""
                }),
                &ctx,
            )
            .await;

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn consolidate_creates_umbrella_and_archives_targets() {
        let tmp = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("narrow-a", "# Narrow A\n\n- Verify with cargo test."),
            ("narrow-b", "# Narrow B\n\n- Avoid duplicate setup."),
        ] {
            let skill_dir = tmp.path().join(".kcoder").join("skills").join(name);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(
                skill_dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {name}\n---\n\n{body}\n"),
            )
            .unwrap();
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_agent_created(tmp.path(), name);
        }
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_skill_registry(Arc::clone(&registry));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await
            .unwrap();

        let umbrella =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/umbrella/SKILL.md")).unwrap();
        assert!(umbrella.contains("name: umbrella"));
        assert!(umbrella.contains("From `narrow-a`"));
        assert!(umbrella.contains("Verify with cargo test."));
        assert!(umbrella.contains("From `narrow-b`"));
        assert!(umbrella.contains("Avoid duplicate setup."));
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-b/SKILL.md")
                .is_file()
        );
        assert!(registry.read().unwrap().get("umbrella").is_some());
        assert!(registry.read().unwrap().get("narrow-a").is_none());

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        assert_eq!(
            provenance.skills.get("umbrella").unwrap().origin,
            SkillOrigin::AgentCreated
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("narrow-a").unwrap().state,
            SkillState::Archived
        );
        assert!(usage.skills.contains_key("umbrella"));
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "narrow-a/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"consolidate\""));
        assert!(log.contains("consolidate: narrow-a, narrow-b -> umbrella"));
    }

    #[tokio::test]
    async fn consolidate_is_idempotent_when_targets_already_archived() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["narrow-a", "narrow-b"] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_agent_created(tmp.path(), name);
        }
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await
            .unwrap();
        let first_log =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert_eq!(backup_files(tmp.path()).len(), 1);
        assert_eq!(first_log.lines().count(), 1);

        let output = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await
            .expect("repeat consolidate should be a no-op success");
        let output = tool_output_text(&output);

        assert!(output.contains("already consolidated"));
        assert_eq!(backup_files(tmp.path()).len(), 1);
        let second_log =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert_eq!(second_log.lines().count(), 1);

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "restore",
                    "name": "narrow-a"
                }),
                &ctx,
            )
            .await
            .expect("archived target should remain restorable after idempotent consolidate");

        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/narrow-a/SKILL.md")
                .exists()
        );
    }

    #[tokio::test]
    async fn consolidate_rejects_user_created_target_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        for (name, origin) in [
            ("narrow-a", SkillOrigin::UserCreated),
            ("narrow-b", SkillOrigin::AgentCreated),
        ] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            match origin {
                SkillOrigin::UserCreated => {
                    crate::skill_provenance::record_user_created(tmp.path(), name)
                }
                SkillOrigin::AgentCreated => {
                    crate::skill_provenance::record_agent_created(tmp.path(), name)
                }
                _ => unreachable!("test only uses user and agent origins"),
            }
        }
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("user-created consolidate targets require override");
        assert!(err.to_string().contains("agent-created skills by default"));
        assert!(!tmp.path().join(".kcoder/skills/umbrella").exists());
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-b/SKILL.md")
                .is_file()
        );
        assert!(!tmp.path().join(".kcoder/skills/.archive/narrow-a").exists());
        assert!(!tmp.path().join(".kcoder/skills/.archive/narrow-b").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn consolidate_rejects_pinned_agent_target_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["narrow-a", "narrow-b"] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_agent_created(tmp.path(), name);
        }
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "narrow-a", true).unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("pinned consolidate targets should be rejected");
        assert!(err.to_string().contains("is pinned"));
        assert!(!tmp.path().join(".kcoder/skills/umbrella").exists());
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-b/SKILL.md")
                .is_file()
        );
        assert!(!tmp.path().join(".kcoder/skills/.archive/narrow-a").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn consolidate_explicit_override_allows_user_created_targets() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["narrow-a", "narrow-b"] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_user_created(tmp.path(), name);
        }
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"],
                    "include_non_agent_created": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/umbrella/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-b/SKILL.md")
                .is_file()
        );
        assert_eq!(backup_files(tmp.path()).len(), 1);
    }

    fn write_test_skill(cwd: &Path, name: &str, body: &str) {
        let skill_dir = cwd.join(".kcoder").join("skills").join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {name}\n---\n\n{body}\n"),
        )
        .unwrap();
    }

    fn output_text(output: &ToolOutput) -> String {
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

    fn backup_files(cwd: &Path) -> Vec<PathBuf> {
        let mut backups = std::fs::read_dir(cwd.join(".kcoder/skills/.backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("gz"))
            .collect::<Vec<_>>();
        backups.sort();
        backups
    }

    fn assert_backup_contains(path: &Path, needle: &str) {
        let mut decoder = GzDecoder::new(std::fs::File::open(path).unwrap());
        let mut bytes = Vec::new();
        decoder.read_to_end(&mut bytes).unwrap();
        assert!(
            bytes
                .windows(needle.len())
                .any(|window| window == needle.as_bytes()),
            "backup {:?} should include tar entry {needle}",
            path
        );
    }
}
