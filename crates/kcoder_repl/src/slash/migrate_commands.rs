//! Configuration and asset answers stay on the local migration connection.
use super::{SlashCommand, SlashResult};
use crate::{MessageRole, ReplApp, migration_terminal};
use kcoder_engine::QueryEngine;
#[derive(Default)]
pub(super) struct MigrateCommand;
#[async_trait::async_trait]
impl SlashCommand for MigrateCommand {
    fn name(&self) -> &'static str {
        "/migrate"
    }
    fn description(&self) -> &'static str {
        "Migrate configuration and work assets, review records and recover (local guide)."
    }
    fn usage(&self) -> &'static str {
        "/migrate [configure|transfer|records|status|items|answer <promptId> [answer]|stop] [--options]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let arguments = match migration_terminal::arguments(args) {
            Ok(a) => a,
            Err(_) => {
                app.push_message(
                    MessageRole::System,
                    "Invalid migration argument format; nothing was sent to the model.",
                );
                return SlashResult::Handled;
            }
        };
        if arguments.first().is_some_and(|a| a == "stop") {
            if let Some(task) = &app.migration_task {
                task.request_stop();
                app.push_message(
                    MessageRole::System,
                    "Stop requested for the owned migration. Read its original record first; an unknown receipt must not be retried with a new request.",
                );
            } else {
                app.push_message(MessageRole::System, "No local migration is running.");
            }
            return SlashResult::Handled;
        }
        if arguments.first().is_some_and(|a| a == "answer") {
            let result = if let (Some(task), Some(id)) = (&app.migration_task, arguments.get(1)) {
                task.answer(engine, id, &arguments[2..].join(" "))
            } else {
                Err(anyhow::anyhow!("migration_answer_unavailable"))
            };
            if let Err(error) = result {
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Answer not accepted: {error}. Use only the current guide promptId; read the original job first if needed."
                    ),
                );
            }
            return SlashResult::Handled;
        }
        SlashResult::StartMigrate(if arguments.is_empty() {
            vec!["configure".into()]
        } else {
            arguments
        })
    }
}
