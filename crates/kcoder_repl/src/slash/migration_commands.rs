//! Migration is a local command, not a model prompt or a historical tool replay.
use super::{SlashCommand, SlashResult};
use crate::{MessageRole, ReplApp, migration_terminal};
use kcoder_engine::QueryEngine;
#[derive(Default)]
pub(super) struct MigrationCommand;
#[async_trait::async_trait]
impl SlashCommand for MigrationCommand {
    fn name(&self) -> &'static str {
        "/migration"
    }
    fn description(&self) -> &'static str {
        "Migrate Claude Code / Codex history (local command)."
    }
    fn usage(&self) -> &'static str {
        "/migration [scan|select|run|jobs|read|page|blocks|text|search|branch|check|continue|local-attachment|continuation-read|continuation-resume|stop] [--options]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        if args.trim().is_empty() {
            app.push_message(MessageRole::System, "History migration runs locally and sends no content to the model. Use /migrate for configuration and compatible assets.\n1. /migration scan --source claude-code --source-root \"source directory\"\n2. /migration select --source claude-code --source-root \"source directory\" --source-session-id <source ID> --request-id <UUID>\n3. /migration run --job-id <job UUID> --expected-sequence <latest sequence>\n4. /migration page --job-id <job UUID>\n5. /migration branch --job-id <job UUID>\n6. /migration check --job-id <job UUID> --view-id <view ID>\n7. /migration continue --job-id <job UUID> --view-id <view ID> --request-id <new UUID>\nContinuation only creates an idle KCoder session. Open it with /resume <session ID>; no prompts or tools are replayed automatically. Pages contain up to 10 items; use text and nextOffset for longer content. /migration stop stops the current local command; then use read to check persisted state. Use /migration --help for all options.");
            return SlashResult::Handled;
        }
        if args.trim() == "stop" {
            if app
                .migration_task
                .as_ref()
                .is_some_and(|task| !task.finished())
            {
                app.migration_task
                    .as_ref()
                    .expect("active migration task")
                    .request_stop();
                app.push_message(
                    MessageRole::System,
                    "Local migration stop requested. Wait for its process to exit, then read the original job. If publication is unconfirmed, do not create a new request to repeat it.",
                );
            } else {
                app.migration_task.take();
                app.push_message(
                    MessageRole::System,
                    "No local migration command is running.",
                );
            }
            return SlashResult::Handled;
        }
        match migration_terminal::arguments(args) {
            Ok(arguments) => SlashResult::StartMigration(arguments),
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Invalid migration arguments: {error}"),
                );
                SlashResult::Handled
            }
        }
    }
}
