use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_types::MessageRole;

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct MoaCommand;

#[derive(Default)]
pub(super) struct MoaPlanCommand;

#[async_trait::async_trait]
impl SlashCommand for MoaCommand {
    fn name(&self) -> &'static str {
        "/moa"
    }

    fn description(&self) -> &'static str {
        "Run the next prompt with Mixture-of-Agents advisory context."
    }

    fn usage(&self) -> &'static str {
        "/moa [prompt]"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let prompt = args.trim();
        if prompt.is_empty() {
            app.push_message(MessageRole::System, engine.moa_status_summary());
            return SlashResult::Handled;
        }

        engine.enable_moa_for_next_turn(None);
        SlashResult::Submit(prompt.to_string())
    }
}

#[async_trait::async_trait]
impl SlashCommand for MoaPlanCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/moa-plan"
    }

    fn description(&self) -> &'static str {
        "Generate one plan from independent model drafts and a final synthesis."
    }

    fn usage(&self) -> &'static str {
        "/moa-plan <planning request>"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let prompt = args.trim();
        if prompt.is_empty() {
            app.push_message(MessageRole::System, format!("Usage: {}", self.usage()));
            return SlashResult::Handled;
        }

        if let Err(error) = engine.moa_plan_preflight() {
            app.push_message(
                MessageRole::System,
                format!("/moa-plan unavailable: {error}"),
            );
            return SlashResult::Handled;
        }
        SlashResult::StartMoaPlan(prompt.to_string())
    }
}
