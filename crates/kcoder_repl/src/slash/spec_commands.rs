use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_tools::{
    SkillGuardPolicy, SpecArchiveTool, SpecCheckTool, SpecConfigTool, SpecInitTool,
    SpecNewChangeTool, SpecRecordVerificationTool, SpecReviewTool, SpecStatusTool, SpecSyncTool,
    SpecUpdateTool, Tool, ToolContext,
};
use kcoder_types::{ContentBlock, MessageRole};
use serde_json::json;
use std::sync::Arc;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct SpecCommand;

#[async_trait::async_trait]
impl SlashCommand for SpecCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/spec"
    }
    fn description(&self) -> &'static str {
        "Manage spec-driven development changes."
    }
    fn usage(&self) -> &'static str {
        "/spec <init|update|new|status|show|preflight|archive|validate|sync|verify|verification|review|review-writeback|config>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let mut parts = args.splitn(2, char::is_whitespace);
        let sub = parts.next().unwrap_or("").trim();
        let rest = parts.next().unwrap_or("").trim();

        match sub {
            "init" => {
                let input = match spec_init_input(rest) {
                    Ok(input) => input,
                    Err(usage) => {
                        app.push_message(MessageRole::System, usage);
                        return SlashResult::Handled;
                    }
                };
                call_spec_tool(app, engine, SpecInitTool, input).await;
            }
            "update" => {
                let input = match spec_update_input(rest) {
                    Ok(input) => input,
                    Err(usage) => {
                        app.push_message(MessageRole::System, usage);
                        return SlashResult::Handled;
                    }
                };
                call_spec_tool(app, engine, SpecUpdateTool, input).await;
            }
            "show" => {
                let input = match spec_show_input(rest) {
                    Ok(input) => input,
                    Err(usage) => {
                        app.push_message(MessageRole::System, usage);
                        return SlashResult::Handled;
                    }
                };
                call_spec_tool(app, engine, SpecStatusTool, input).await;
            }
            "preflight" | "apply-preflight" => {
                let name = rest.trim();
                if name.is_empty() {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /spec preflight <name>".to_string(),
                    );
                    return SlashResult::Handled;
                }
                call_spec_tool(app, engine, SpecCheckTool, json!({"action": "preflight", "change": name})).await;
            }
            "new" => {
                let mut name_parts = rest.splitn(2, char::is_whitespace);
                let name = name_parts.next().unwrap_or("").trim();
                let title = name_parts.next().map(|s| s.trim().to_string());
                if name.is_empty() {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /spec new <name> [title]".to_string(),
                    );
                    return SlashResult::Handled;
                }
                let mut input = json!({"name": name});
                if let Some(title) = title {
                    input["title"] = json!(title);
                }
                call_spec_tool(app, engine, SpecNewChangeTool, input).await;
            }
            "status" => {
                if rest.is_empty() {
                    call_spec_tool(app, engine, SpecStatusTool, json!({})).await;
                } else {
                    let input = match spec_status_input(rest) {
                        Ok(input) => input,
                        Err(usage) => {
                            app.push_message(MessageRole::System, usage);
                            return SlashResult::Handled;
                        }
                    };
                    call_spec_tool(app, engine, SpecStatusTool, input).await;
                }
            }
            "archive" => {
                let name = rest.trim();
                if name.is_empty() {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /spec archive <name>".to_string(),
                    );
                    return SlashResult::Handled;
                }
                call_spec_tool(app, engine, SpecArchiveTool, json!({"name": name})).await;
            }
            "validate" => {
                let mut input = json!({"action": "validate"});
                if !rest.is_empty() {
                    input["change"] = json!(rest);
                }
                call_spec_tool(app, engine, SpecCheckTool, input).await;
            }
            "sync" => {
                let name = rest.trim();
                if name.is_empty() {
                    app.push_message(MessageRole::System, "Usage: /spec sync <name>".to_string());
                    return SlashResult::Handled;
                }
                call_spec_tool(app, engine, SpecSyncTool, json!({"name": name})).await;
            }
            "verify" => call_spec_tool(app, engine, SpecCheckTool, json!({"action": "verify"})).await,
            "verification" | "record-verification" => {
                let mut verification_parts = rest.splitn(2, char::is_whitespace);
                let name = verification_parts.next().unwrap_or("").trim();
                let decision = verification_parts.next().unwrap_or("").trim();
                if name.is_empty() || decision.is_empty() {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /spec verification <name> <completion-decision>".to_string(),
                    );
                    return SlashResult::Handled;
                }
                call_spec_tool(
                    app,
                    engine,
                    SpecRecordVerificationTool,
                    json!({"name": name, "completion_decision": decision}),
                )
                .await;
            }
            "review" => {
                let mut review_parts = rest.splitn(2, char::is_whitespace);
                let name = review_parts.next().unwrap_or("").trim();
                let base = review_parts.next().map(|s| s.trim().to_string());
                if name.is_empty() {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /spec review <name> [base-sha]".to_string(),
                    );
                    return SlashResult::Handled;
                }
                let mut input = json!({"name": name});
                if let Some(base) = base {
                    input["base_sha"] = json!(base);
                }
                call_spec_tool(app, engine, SpecReviewTool, input).await;
            }
            "review-writeback" => {
                let mut parts = rest.splitn(3, char::is_whitespace);
                let name = parts.next().unwrap_or("").trim();
                let status = parts.next().unwrap_or("").trim();
                let summary = parts.next().unwrap_or("").trim();
                if name.is_empty() || status.is_empty() || summary.is_empty() {
                    app.push_message(
                        MessageRole::System,
                        "Usage: /spec review-writeback <name> <status> <summary>".to_string(),
                    );
                    return SlashResult::Handled;
                }
                let mut input = json!({
                    "name": name,
                    "review_status": status,
                    "findings_summary": [summary],
                });
                if summary.to_ascii_lowercase().contains("accepted") {
                    input["accepted_followups"] = json!([summary]);
                }
                input["action"] = json!("writeback");
                call_spec_tool(app, engine, SpecReviewTool, input).await;
            }
            "config" => {
                let mut cfg_parts = rest.splitn(3, char::is_whitespace);
                let action = cfg_parts.next().unwrap_or("").trim();
                let key = cfg_parts.next().map(|s| s.trim().to_string());
                let value = cfg_parts.next().map(|s| s.trim().to_string());
                match action {
                    "get" => {
                        let mut input = json!({"action": "get"});
                        if let Some(key) = key {
                            input["key"] = json!(key);
                        }
                        call_spec_tool(app, engine, SpecConfigTool, input).await;
                    }
                    "set" => {
                        let Some(key) = key else {
                            app.push_message(
                                MessageRole::System,
                                "Usage: /spec config set <key> <value>".to_string(),
                            );
                            return SlashResult::Handled;
                        };
                        let Some(value) = value else {
                            app.push_message(
                                MessageRole::System,
                                "Usage: /spec config set <key> <value>".to_string(),
                            );
                            return SlashResult::Handled;
                        };
                        call_spec_tool(
                            app,
                            engine,
                            SpecConfigTool,
                            json!({"action": "set", "key": key, "value": value}),
                        )
                        .await;
                    }
                    _ => app.push_message(
                        MessageRole::System,
                        "Usage: /spec config get [key]\n       /spec config set <key> <value>"
                            .to_string(),
                    ),
                }
            }
            "" => app.push_message(
                MessageRole::System,
                "Usage: /spec <init|update|new|status|show|preflight|archive|validate|sync|verify|verification|review|review-writeback|config>"
                    .to_string(),
            ),
            other => app.push_message(
                MessageRole::System,
                format!("Unknown /spec subcommand: {}", other),
            ),
        }
        SlashResult::Handled
    }
}

fn spec_init_input(rest: &str) -> Result<serde_json::Value, String> {
    let mut force_update = false;
    for part in rest.split_whitespace() {
        match part {
            "--force" | "--force-update" => force_update = true,
            _ => return Err("Usage: /spec init [--force]".to_string()),
        }
    }
    Ok(json!({"force_update": force_update}))
}

fn spec_update_input(rest: &str) -> Result<serde_json::Value, String> {
    let mut dry_run = false;
    let mut force_update = false;
    for part in rest.split_whitespace() {
        match part {
            "--dry-run" => dry_run = true,
            "--force" | "--force-update" => force_update = true,
            _ => return Err("Usage: /spec update [--dry-run] [--force]".to_string()),
        }
    }
    Ok(json!({"dry_run": dry_run, "force_update": force_update}))
}

fn spec_show_input(rest: &str) -> Result<serde_json::Value, String> {
    let mut name = None;
    let mut include_specs = true;
    let mut max_file_bytes = None;
    let mut parts = rest.split_whitespace().peekable();
    while let Some(part) = parts.next() {
        match part {
            "--no-specs" => include_specs = false,
            value if value.starts_with("--max-bytes=") => {
                max_file_bytes = Some(parse_max_bytes(value.trim_start_matches("--max-bytes="))?);
            }
            "--max-bytes" => {
                let Some(value) = parts.next() else {
                    return Err(
                        "Usage: /spec show <name> [--no-specs] [--max-bytes <bytes>]".to_string(),
                    );
                };
                max_file_bytes = Some(parse_max_bytes(value)?);
            }
            value if value.starts_with("--") => {
                return Err(
                    "Usage: /spec show <name> [--no-specs] [--max-bytes <bytes>]".to_string(),
                );
            }
            value if name.is_none() => name = Some(value),
            _ => {
                return Err(
                    "Usage: /spec show <name> [--no-specs] [--max-bytes <bytes>]".to_string(),
                );
            }
        }
    }
    let Some(name) = name else {
        return Err("Usage: /spec show <name> [--no-specs] [--max-bytes <bytes>]".to_string());
    };
    let mut input = json!({"change": name, "include_specs": include_specs});
    if let Some(max_file_bytes) = max_file_bytes {
        input["max_file_bytes"] = json!(max_file_bytes);
    }
    Ok(input)
}

fn spec_status_input(rest: &str) -> Result<serde_json::Value, String> {
    let mut parts = rest.split_whitespace();
    let Some(name) = parts.next() else {
        return Err("Usage: /spec status [name]".to_string());
    };
    if parts.next().is_some() {
        return Err("Usage: /spec status [name]".to_string());
    }
    Ok(json!({"name": name}))
}

fn parse_max_bytes(value: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| "Usage: /spec show <name> [--no-specs] [--max-bytes <bytes>]".to_string())
}

async fn call_spec_tool<T>(
    app: &mut ReplApp,
    engine: &QueryEngine,
    tool: T,
    input: serde_json::Value,
) where
    T: Tool,
{
    let (external_skill_dirs, trust_external_skills, skill_guard_policy, auto_lessons_learned) = {
        let settings = engine.settings.read().unwrap();
        (
            settings.skills.external_dirs.clone(),
            settings.skills.trust_external,
            SkillGuardPolicy {
                enabled: settings.skills.guard.enabled,
                block_high_risk: settings.skills.guard.block_high_risk,
                block_medium_risk_for_community: settings
                    .skills
                    .guard
                    .block_medium_risk_for_community,
            },
            settings.skills.auto_lessons_learned,
        )
    };
    let ctx = ToolContext::new(engine.state.clone())
        .with_skill_registry(Arc::clone(&engine.skill_registry))
        .with_active_skills(Arc::clone(&engine.active_skills))
        .with_external_skill_dirs(external_skill_dirs)
        .with_trust_external_skills(trust_external_skills)
        .with_skill_guard_policy(skill_guard_policy)
        .with_auto_lessons_learned(auto_lessons_learned);

    match tool.call(input, &ctx).await {
        Ok(output) => {
            let text = output
                .content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            app.push_message(MessageRole::System, text);
        }
        Err(error) => app.push_message(MessageRole::System, format!("Error: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
    use kcoder_config::Settings;
    use kcoder_memory::{MemoryManager, MemoryStore};
    use kcoder_permissions::PermissionEngine;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use kcoder_tools::{DenyAllUserQuestioner, ToolRegistry};
    use kcoder_types::MessagesRequest;
    use std::path::Path;
    use std::sync::Arc;

    #[test]
    fn spec_slash_inputs_match_tools() {
        assert_eq!(spec_init_input("").unwrap(), json!({"force_update": false}));
        assert_eq!(
            spec_init_input("--force").unwrap(),
            json!({"force_update": true})
        );
        assert_eq!(
            spec_init_input("--force-update").unwrap(),
            json!({"force_update": true})
        );
        assert_eq!(
            spec_update_input("").unwrap(),
            json!({"dry_run": false, "force_update": false})
        );
        assert_eq!(
            spec_update_input("--dry-run --force").unwrap(),
            json!({"dry_run": true, "force_update": true})
        );
        assert_eq!(
            spec_show_input("add-auth").unwrap(),
            json!({"change": "add-auth", "include_specs": true})
        );
        assert_eq!(
            spec_show_input("add-auth --no-specs --max-bytes 1024").unwrap(),
            json!({"change": "add-auth", "include_specs": false, "max_file_bytes": 1024})
        );
        assert_eq!(
            spec_show_input("add-auth --max-bytes=2048").unwrap(),
            json!({"change": "add-auth", "include_specs": true, "max_file_bytes": 2048})
        );
        assert_eq!(
            spec_status_input("add-auth").unwrap(),
            json!({"name": "add-auth"})
        );
    }

    #[test]
    fn spec_slash_inputs_report_usage_errors() {
        assert!(spec_init_input("--unknown").is_err());
        assert!(spec_update_input("--unknown").is_err());
        assert!(spec_show_input("").is_err());
        assert!(spec_show_input("add-auth extra").is_err());
        assert!(spec_show_input("add-auth --unknown").is_err());
        assert!(spec_show_input("add-auth --max-bytes").is_err());
        assert!(spec_show_input("add-auth --max-bytes nope").is_err());
        assert!(spec_status_input("").is_err());
        assert!(spec_status_input("add-auth extra").is_err());
    }

    #[tokio::test]
    async fn spec_init_and_update_slash_execute_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SpecCommand.run("init", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        assert!(
            tmp.path()
                .join(".kcoder/skills/using-specs/SKILL.md")
                .is_file()
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report spec init output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("Initialized spec subsystem"),
            "unexpected slash output: {}",
            message.text
        );
        let using_specs =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/using-specs/SKILL.md"))
                .unwrap();
        assert!(using_specs.contains("SpecStatus"));
        assert!(using_specs.contains("SpecStatus"));
        assert!(
            engine
                .active_skills
                .read()
                .unwrap()
                .iter()
                .any(|skill| skill == "using-specs")
        );

        let result = SpecCommand.run("update --dry-run", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        let report: serde_json::Value = serde_json::from_str(
            &app.messages
                .last()
                .expect("slash command should report spec update output")
                .text,
        )
        .unwrap();
        assert_eq!(report["success"], true);
        assert_eq!(report["dry_run"], true);
    }

    #[tokio::test]
    async fn spec_new_slash_executes_tool_and_requires_active_spec_skills() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SpecCommand
            .run("new gated-change Gated change", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        let message = app
            .messages
            .last()
            .expect("slash command should report gated new output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("using-superpowers") && message.text.contains("using-specs"),
            "unexpected slash output: {}",
            message.text
        );
        assert!(
            !tmp.path()
                .join(".kcoder/specs/changes/gated-change")
                .exists(),
            "gated /spec new should not create a change"
        );

        engine
            .active_skills
            .write()
            .unwrap()
            .extend(["using-superpowers".to_string(), "using-specs".to_string()]);
        let result = SpecCommand
            .run("new gated-change Gated change", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        assert!(
            tmp.path()
                .join(".kcoder/specs/changes/gated-change/proposal.md")
                .is_file()
        );
        let message = app
            .messages
            .last()
            .expect("slash command should report successful new output");
        assert!(
            message.text.contains("Created change at"),
            "unexpected slash output: {}",
            message.text
        );
    }

    #[tokio::test]
    async fn spec_config_set_slash_executes_tool_and_refreshes_using_specs() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let engine = test_engine(tmp.path());
        engine
            .active_skills
            .write()
            .unwrap()
            .extend(["using-superpowers".to_string(), "using-specs".to_string()]);
        let mut app = ReplApp::default();

        let result = SpecCommand
            .run(
                "config set context Workspace requires spec-aware config refresh.",
                &mut app,
                &engine,
            )
            .await;

        assert_eq!(result, SlashResult::Handled);
        let message = app
            .messages
            .last()
            .expect("slash command should report config set output");
        assert!(
            message.text.contains("regenerated"),
            "unexpected slash output: {}",
            message.text
        );
        let using_specs =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/using-specs/SKILL.md"))
                .unwrap();
        assert!(using_specs.contains("Workspace requires spec-aware config refresh."));
        assert!(
            engine
                .skill_registry
                .read()
                .unwrap()
                .get_active("using-specs")
                .unwrap()
                .content
                .contains("Workspace requires spec-aware config refresh.")
        );
    }

    #[tokio::test]
    async fn spec_status_and_show_slash_execute_tools() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        std::fs::write(
            change_dir.join("proposal.md"),
            "# Add auth\n\nImplement token refresh.\n",
        )
        .unwrap();
        let spec_dir = change_dir.join("specs/auth");
        std::fs::create_dir_all(&spec_dir).unwrap();
        std::fs::write(
            spec_dir.join("spec.md"),
            "## ADDED Requirements\n\n### Requirement: Token refresh\n",
        )
        .unwrap();

        let engine = test_engine(tmp.path());
        let mut app = ReplApp::default();

        let result = SpecCommand.run("status add-auth", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        let status: serde_json::Value = serde_json::from_str(
            &app.messages
                .last()
                .expect("slash command should report spec status output")
                .text,
        )
        .unwrap();
        assert_eq!(status["change"], "add-auth");
        assert_eq!(status["title"], "Add auth");
        assert_eq!(status["artifacts"]["proposal.md"]["exists"], true);
        assert_eq!(status["drift"]["ok"], true);

        let result = SpecCommand
            .run("show add-auth --no-specs --max-bytes 64", &mut app, &engine)
            .await;

        assert_eq!(result, SlashResult::Handled);
        let show: serde_json::Value = serde_json::from_str(
            &app.messages
                .last()
                .expect("slash command should report spec show output")
                .text,
        )
        .unwrap();
        assert_eq!(show["name"], "add-auth");
        assert_eq!(show["status"]["name"], "add-auth");
        let files = show["files"].as_array().unwrap();
        assert!(files.iter().any(|file| file["path"] == "proposal.md"));
        assert!(
            !files
                .iter()
                .any(|file| file["path"] == "specs/auth/spec.md")
        );
    }

    #[tokio::test]
    async fn spec_archive_slash_executes_tool_and_generates_lessons_when_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        std::fs::write(
            change_dir.join("proposal.md"),
            "# Add auth\n\n- Risk: stale sessions need rollback testing.\n",
        )
        .unwrap();
        std::fs::write(
            change_dir.join("design.md"),
            "## Verification\n\n- Run cargo test -p kcoder_tools.\n",
        )
        .unwrap();
        std::fs::write(
            change_dir.join("tasks.md"),
            "- [x] done\n- [x] cargo test\n",
        )
        .unwrap();
        let mut settings = Settings::default();
        settings.skills.auto_lessons_learned = true;
        let engine = test_engine_with_settings(tmp.path(), settings);
        engine
            .active_skills
            .write()
            .unwrap()
            .extend(["using-superpowers".to_string(), "using-specs".to_string()]);
        let mut app = ReplApp::default();

        let result = SpecCommand.run("archive add-auth", &mut app, &engine).await;

        assert_eq!(result, SlashResult::Handled);
        let message = app
            .messages
            .last()
            .expect("slash command should report spec archive output");
        assert_eq!(message.role, MessageRole::System);
        assert!(
            message.text.contains("generated lessons-learned skill"),
            "unexpected slash output: {}",
            message.text
        );
        let skill_name = "lessons-learned-add-auth";
        let skill_file = tmp
            .path()
            .join(".kcoder/skills")
            .join(skill_name)
            .join("SKILL.md");
        let skill = std::fs::read_to_string(&skill_file).unwrap();
        assert!(skill.contains("Risk: stale sessions need rollback testing."));
        assert!(skill.contains("Run cargo test -p kcoder_tools."));
        assert!(
            engine
                .skill_registry
                .read()
                .unwrap()
                .get_active(skill_name)
                .is_some()
        );
        let provenance =
            kcoder_tools::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        assert_eq!(
            provenance.skills.get(skill_name).unwrap().origin,
            kcoder_tools::skill_provenance::SkillOrigin::AgentCreated
        );
    }

    fn test_engine(cwd: &Path) -> QueryEngine {
        test_engine_with_settings(cwd, Settings::default())
    }

    fn test_engine_with_settings(cwd: &Path, settings: Settings) -> QueryEngine {
        QueryEngine::new(
            Arc::new(EmptyProvider),
            AppState::new(cwd),
            ToolRegistry::new(),
            PermissionEngine::from_settings(&settings),
            settings,
            MemoryManager::global_only(MemoryStore::empty()),
            SkillRegistry::load(cwd).unwrap(),
            Arc::new(DenyAllUserQuestioner),
            cwd.to_path_buf(),
        )
    }

    struct EmptyProvider;

    impl Provider for EmptyProvider {
        fn name(&self) -> &'static str {
            "empty"
        }

        fn stream_messages(
            &self,
            _request: MessagesRequest,
        ) -> Result<ProviderStream, ApiErrorKind> {
            Ok(Box::pin(futures::stream::empty()))
        }
    }
}
