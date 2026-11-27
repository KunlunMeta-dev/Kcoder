use crate::ReplApp;
use kcoder_config::PermissionMode;
use kcoder_engine::QueryEngine;
use kcoder_types::MessageRole;
use tracing::warn;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct PermissionCommand;

fn permission_mode_summary(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "ask before non-read-only tools",
        PermissionMode::Auto => "allow read-only tools, ask for the rest",
        PermissionMode::AcceptEdits => "allow read-only/edit/write tools, ask for the rest",
        PermissionMode::DontAsk => "deny tools that would require approval",
        PermissionMode::Bypass => "allow approval prompts automatically",
        PermissionMode::Yolo => "allow tools and suppress user-facing questions",
    }
}

#[async_trait::async_trait]
impl SlashCommand for PermissionCommand {
    fn name(&self) -> &'static str {
        "/permission"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/permissions"]
    }
    fn description(&self) -> &'static str {
        "Get or set permission mode."
    }
    fn usage(&self) -> &'static str {
        "/permission [ask|auto|accept-edits|dont-ask|bypass|yolo]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if args.is_empty() {
            let mode = engine.settings.read().unwrap().permission_mode;
            app.push_message(
                MessageRole::System,
                format!(
                    "Current permission mode: {:?} ({})",
                    mode,
                    permission_mode_summary(mode)
                ),
            );
            return SlashResult::Handled;
        }
        if let Some(mode) = PermissionMode::parse(args) {
            let settings_clone = {
                let mut settings = engine.settings.write().unwrap();
                settings.permission_mode = mode;
                engine
                    .permissions
                    .write()
                    .unwrap()
                    .refresh_persisted_settings(&settings);
                settings.clone()
            };
            if let Err(e) = engine
                .persist_settings_fields(settings_clone, &["permission_mode"])
                .await
            {
                warn!("failed to save permission setting: {}", e);
            }
            app.push_message(
                MessageRole::System,
                format!(
                    "Permission mode set to: {:?} ({})",
                    mode,
                    permission_mode_summary(mode)
                ),
            );
        } else {
            app.push_message(
                MessageRole::System,
                "Invalid mode. Use: ask, auto, accept-edits, dont-ask, bypass, yolo",
            );
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct AllowCommand;

#[async_trait::async_trait]
impl SlashCommand for AllowCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/allow"
    }
    fn description(&self) -> &'static str {
        "Allow a tool persistently or for this session."
    }
    fn usage(&self) -> &'static str {
        "/allow [--session] <tool-pattern>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let (session, pattern) = parse_session_flag(args);
        if pattern.is_empty() {
            let settings = engine.settings.read().unwrap();
            let allowed: Vec<String> = if session {
                engine.permissions.read().unwrap().session_allowed.clone()
            } else {
                settings.allowed_tools.clone()
            };
            let scope = if session {
                "Session allowed"
            } else {
                "Allowed tools"
            };
            app.push_message(
                MessageRole::System,
                format!("{}: {}", scope, allowed.join(", ")),
            );
            return SlashResult::Handled;
        }
        if session {
            let mut settings = engine.settings.write().unwrap();
            if !settings
                .session_allowed_tools
                .iter()
                .any(|tool| tool == pattern)
            {
                settings.session_allowed_tools.push(pattern.to_string());
            }
            settings.session_denied_tools.retain(|tool| tool != pattern);
            engine
                .permissions
                .write()
                .unwrap()
                .allow_for_session(pattern);
        } else {
            if let Err(error) = engine.persist_allowed_tool(pattern).await {
                warn!("failed to save allowed tool setting: {error}");
                app.push_message(
                    MessageRole::System,
                    format!("Failed to persist allowed tool '{pattern}': {error}"),
                );
                return SlashResult::Handled;
            }
        }
        let scope = if session { "Session" } else { "Persistently" };
        app.push_message(
            MessageRole::System,
            format!("{} allowed tool '{}'.", scope, pattern),
        );
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct DenyCommand;

#[async_trait::async_trait]
impl SlashCommand for DenyCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/deny"
    }
    fn description(&self) -> &'static str {
        "Deny a tool persistently or for this session."
    }
    fn usage(&self) -> &'static str {
        "/deny [--session] <tool-pattern>"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let (session, pattern) = parse_session_flag(args);
        if pattern.is_empty() {
            let settings = engine.settings.read().unwrap();
            let denied: Vec<String> = if session {
                engine.permissions.read().unwrap().session_denied.clone()
            } else {
                settings.denied_tools.clone()
            };
            let scope = if session {
                "Session denied"
            } else {
                "Denied tools"
            };
            app.push_message(
                MessageRole::System,
                format!("{}: {}", scope, denied.join(", ")),
            );
            return SlashResult::Handled;
        }
        if session {
            let mut settings = engine.settings.write().unwrap();
            if !settings
                .session_denied_tools
                .iter()
                .any(|tool| tool == pattern)
            {
                settings.session_denied_tools.push(pattern.to_string());
            }
            settings
                .session_allowed_tools
                .retain(|tool| tool != pattern);
            engine
                .permissions
                .write()
                .unwrap()
                .deny_for_session(pattern);
        } else {
            if let Err(error) = engine.persist_denied_tool(pattern).await {
                warn!("failed to save denied tool setting: {error}");
                app.push_message(
                    MessageRole::System,
                    format!("Failed to persist denied tool '{pattern}': {error}"),
                );
                return SlashResult::Handled;
            }
        }
        let scope = if session { "Session" } else { "Persistently" };
        app.push_message(
            MessageRole::System,
            format!("{} denied tool '{}'.", scope, pattern),
        );
        SlashResult::Handled
    }
}

fn parse_session_flag(args: &str) -> (bool, &str) {
    let trimmed = args.trim();
    if let Some(rest) = trimmed.strip_prefix("--session") {
        return (true, rest.trim());
    }
    if let Some(rest) = trimmed.strip_prefix("-s") {
        return (true, rest.trim());
    }
    (false, trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_engine;

    #[tokio::test]
    async fn independent_engine_slash_permission_mutations_merge_on_disk() {
        let workspace = tempfile::tempdir().unwrap();
        let first_engine = test_engine(workspace.path());
        let second_engine = test_engine(workspace.path());
        let mut first_app = ReplApp::default();
        let mut second_app = ReplApp::default();

        let (allowed, denied) = tokio::join!(
            AllowCommand.run("write", &mut first_app, &first_engine),
            DenyCommand.run("bash", &mut second_app, &second_engine),
        );
        assert_eq!(allowed, SlashResult::Handled);
        assert_eq!(denied, SlashResult::Handled);

        let document: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(workspace.path().join("test-config/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(document["allowed_tools"], serde_json::json!(["write"]));
        assert_eq!(document["denied_tools"], serde_json::json!(["bash"]));
    }

    #[tokio::test]
    async fn session_slash_permission_mutations_update_live_permission_engine() {
        let workspace = tempfile::tempdir().unwrap();
        let engine = test_engine(workspace.path());
        let mut app = ReplApp::default();

        assert_eq!(
            AllowCommand.run("--session write", &mut app, &engine).await,
            SlashResult::Handled
        );
        assert_eq!(
            DenyCommand.run("--session bash", &mut app, &engine).await,
            SlashResult::Handled
        );
        assert_eq!(
            DenyCommand.run("--session write", &mut app, &engine).await,
            SlashResult::Handled
        );
        assert_eq!(
            AllowCommand.run("--session write", &mut app, &engine).await,
            SlashResult::Handled
        );

        let permissions = engine.permissions.read().unwrap();
        assert_eq!(permissions.session_allowed, vec!["write"]);
        assert_eq!(permissions.session_denied, vec!["bash"]);
        assert_eq!(
            engine.settings.read().unwrap().session_allowed_tools,
            vec!["write"]
        );
        assert_eq!(
            engine.settings.read().unwrap().session_denied_tools,
            vec!["bash"]
        );
        assert!(!workspace.path().join("test-config/settings.json").exists());
    }

    #[tokio::test]
    async fn persistent_slash_permission_reports_write_failure_without_publishing_runtime_state() {
        let workspace = tempfile::tempdir().unwrap();
        let blocker = workspace.path().join("not-a-directory");
        std::fs::write(&blocker, "file").unwrap();
        let engine = test_engine(workspace.path())
            .with_settings_persistence_path(blocker.join("settings.json"));
        let mut app = ReplApp::default();

        assert_eq!(
            AllowCommand.run("write", &mut app, &engine).await,
            SlashResult::Handled
        );

        assert!(
            !engine
                .settings
                .read()
                .unwrap()
                .allowed_tools
                .contains(&"write".to_string())
        );
        assert!(
            !engine
                .permissions
                .read()
                .unwrap()
                .allowed_tools
                .contains(&"write".to_string())
        );
        assert!(app.messages.iter().any(|message| {
            message
                .text
                .contains("Failed to persist allowed tool 'write'")
        }));
        assert!(!blocker.join("settings.json").exists());
    }
}
