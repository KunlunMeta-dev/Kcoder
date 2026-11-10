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
        "迁移配置和工作资产、查看记录与恢复（本地向导）"
    }
    fn usage(&self) -> &'static str {
        "/migrate [configure|transfer|records|status|items|answer <promptId> [回答]|stop] [--options]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let arguments = match migration_terminal::arguments(args) {
            Ok(a) => a,
            Err(_) => {
                app.push_message(MessageRole::System, "迁移参数格式无效；未发送给模型。");
                return SlashResult::Handled;
            }
        };
        if arguments.first().is_some_and(|a| a == "stop") {
            if let Some(task) = &app.migration_task {
                task.request_stop();
                app.push_message(
                    MessageRole::System,
                    "已请求停止所属迁移；先回读原记录，未知回执不能换新请求重放。",
                );
            } else {
                app.push_message(MessageRole::System, "当前没有本地迁移。");
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
                        "未接受回答：{error}。只使用当前向导的 promptId，必要时先 read 原作业。"
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
