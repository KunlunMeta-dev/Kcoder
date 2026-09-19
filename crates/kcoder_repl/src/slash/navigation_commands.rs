use super::{SlashCommand, SlashResult};
use crate::ReplApp;
use kcoder_engine::QueryEngine;

#[derive(Default)]
pub struct OutlineCommand;
#[async_trait::async_trait]
impl SlashCommand for OutlineCommand {
    fn name(&self) -> &'static str {
        "/outline"
    }
    fn description(&self) -> &'static str {
        "Open the conversation outline and navigate by task or heading"
    }
    fn usage(&self) -> &'static str {
        "/outline [query]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        app.open_outline(args.trim());
        SlashResult::Handled
    }
}

#[derive(Default)]
pub struct JumpCommand;
#[async_trait::async_trait]
impl SlashCommand for JumpCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/jump"
    }
    fn description(&self) -> &'static str {
        "Jump to the answer start, adjacent tasks, or latest output"
    }
    fn usage(&self) -> &'static str {
        "/jump start|prev|next|latest"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        match args.trim() {
            action @ ("start" | "prev" | "next" | "latest") => app.jump_transcript(action),
            _ => app.set_transient_status("Usage: /jump start|prev|next|latest"),
        }
        SlashResult::Handled
    }
}
