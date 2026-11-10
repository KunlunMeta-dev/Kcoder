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
        "迁移 Claude Code / Codex 历史（本地命令）"
    }
    fn usage(&self) -> &'static str {
        "/migration [scan|select|run|jobs|read|page|blocks|text|search|branch|check|continue|local-attachment|continuation-read|continuation-resume|stop] [--options]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        if args.trim().is_empty() {
            app.push_message(MessageRole::System, "历史迁移为本地操作，不向模型发送内容。配置和兼容资产请用 /migrate 向导。\n1. /migration scan --source claude-code --source-root \"来源目录\"\n2. /migration select --source claude-code --source-root \"来源目录\" --source-session-id <来源 ID> --request-id <UUID>\n3. /migration run --job-id <作业 UUID> --expected-sequence <最新序列>\n4. /migration page --job-id <作业 UUID>\n5. /migration branch --job-id <作业 UUID>\n6. /migration check --job-id <作业 UUID> --view-id <分支 ID>\n7. /migration continue --job-id <作业 UUID> --view-id <分支 ID> --request-id <新 UUID>\n接续只创建空闲 KCoder 会话，再使用 /resume <会话 ID> 打开；不会自动提问或重放工具。每页最多 10 项，长正文用 text 和 nextOffset 阅读。/migration stop 停止当前本地命令，随后须 read 核对持久状态。可用 /migration --help 查看全部参数。");
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
                    "已请求停止本地迁移命令。等待所属进程结束后回读原作业；发布结果未知时不要创建新请求重复执行。",
                );
            } else {
                app.migration_task.take();
                app.push_message(MessageRole::System, "当前没有运行中的本地迁移命令。");
            }
            return SlashResult::Handled;
        }
        match migration_terminal::arguments(args) {
            Ok(arguments) => SlashResult::StartMigration(arguments),
            Err(error) => {
                app.push_message(MessageRole::System, format!("迁移参数错误：{error}"));
                SlashResult::Handled
            }
        }
    }
}
