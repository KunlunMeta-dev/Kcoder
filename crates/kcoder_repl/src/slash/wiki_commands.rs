//! Wiki discoverability uses the same target-scoped tools as the conversation.
use super::{SlashCommand, SlashResult};
use crate::{MessageRole, ReplApp};
use anyhow::{Context, Result};
use kcoder_engine::QueryEngine;
use kcoder_tools::{Tool, ToolContext, wiki::WikiTool};
use kcoder_types::ContentBlock;
use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct WikiCommand;

#[async_trait::async_trait]
impl SlashCommand for WikiCommand {
    fn name(&self) -> &'static str {
        "/wiki"
    }
    fn aliases(&self) -> &[&'static str] {
        &["/knowledge"]
    }
    fn description(&self) -> &'static str {
        "Show your Wiki and request enabling or disabling it."
    }
    fn usage(&self) -> &'static str {
        "/wiki [on | off]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let args = args.trim().to_ascii_lowercase();
        if let Some(request) = switch_request(&args) {
            return request;
        }
        if !args.is_empty() && args != "status" && args != "help" {
            app.push_message(MessageRole::System, "Usage: /wiki [on | off]");
            return SlashResult::Handled;
        }
        let result = status(engine)
            .await
            .unwrap_or_else(|error| format!("Cannot read Wiki: {error}"));
        app.push_message(MessageRole::System, result);
        SlashResult::Handled
    }
}

fn switch_request(args: &str) -> Option<SlashResult> {
    let enabled = match args {
        "on" => true,
        "off" => false,
        _ => return None,
    };
    // Submit an explicit user request through the existing Config permission,
    // persistence-order, sandbox and job-pause path. Do not create a second
    // settings transaction implementation inside the terminal UI.
    Some(SlashResult::SubmitWithDisplay {
        visible_text: format!("/wiki {args}"),
        model_text: format!(
            "I explicitly request that you {} Wiki for this execution target. Use the available Config tool to set knowledge.enabled to {enabled}. Change no other setting. Confirm the saved result; if the tool is unavailable or the write fails, explain that instead of claiming success. {}",
            if enabled { "enable" } else { "disable" },
            if enabled {
                "Do not resume previously paused organization jobs."
            } else {
                "Keep all Wiki content; disabling must pause background organization."
            },
        ),
    })
}

async fn status(engine: &QueryEngine) -> Result<String> {
    let path = engine
        .settings_persistence_path()
        .context("no persistent target profile")?;
    let document = kcoder_config::read_settings_file(&path)?;
    let settings: kcoder_config::KnowledgeSettings = serde_json::from_value(
        document
            .get("knowledge")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )?;
    if !settings.is_available() {
        return Ok("Wiki: off\n\nYour saved content is retained. Use /wiki on to request enabling Wiki.\nYou can also say: Enable Wiki, then save this explanation to it.".into());
    }
    if !settings.can_retrieve() {
        return Ok("Wiki: retrieval off · organization on\n\nOrganization is available. Retrieval is disabled independently; saved pages remain in Studio.".into());
    }
    let context = ToolContext::new(engine.state.clone()).with_settings_persistence_path(Some(path));
    let output = WikiTool.call(json!({"action":"pages"}), &context).await?;
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let value: Value = serde_json::from_str(&text)?;
    Ok(format!(
        "{}\nOrganization: {}",
        format_status(&value),
        if settings.can_organize() { "on" } else { "off" }
    ))
}

fn format_status(value: &Value) -> String {
    let detail = match value["status"].as_str() {
        Some("empty") => {
            "No Wiki yet. Ask: Create my personal Wiki and save this explanation.".into()
        }
        Some("choose_library") => {
            let names = value["libraries"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["archived"] != true)
                .filter_map(|item| item["name"].as_str())
                .take(5)
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "Choose a default Wiki in conversation: Use <name> as my default Wiki.\nAvailable: {names}"
            )
        }
        _ => format!(
            "Current Wiki: {}",
            value["library_name"].as_str().unwrap_or("selected Wiki")
        ),
    };
    format!(
        "Wiki: on\n\n{detail}\n\nAsk: Find an answer in my Wiki.\nAsk: Save and organize this material in my Wiki.\nUse Studio's Wiki page to import files, read pages and review changes.\n/wiki off requests disabling Wiki while retaining your content."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wiki_command_is_discoverable_by_both_names() {
        let registry = super::super::SlashRegistry::new();
        for alias in ["/wiki", "/knowledge"] {
            let command = registry.get(alias).unwrap();
            assert_eq!(command.name(), "/wiki");
            assert!(!command.needs_arguments());
        }
    }
    #[test]
    fn status_uses_human_titles_without_exposing_ids() {
        let text = format_status(&json!({"library":"opaque-secret-id", "library_name":"Research"}));
        assert!(text.contains("Current Wiki: Research"));
        assert!(!text.contains("opaque-secret-id"));
        assert!(format_status(&json!({"status":"empty"})).contains("No Wiki yet"));
        let choices = format_status(
            &json!({"status":"choose_library", "libraries":[{"id":"opaque-id", "name":"Work"}]}),
        );
        assert!(choices.contains("Available: Work"));
        assert!(!choices.contains("opaque-id"));
    }
    #[test]
    fn switch_is_an_explicit_request_not_a_claim_of_completion() {
        for arg in ["on", "off"] {
            let Some(SlashResult::SubmitWithDisplay {
                visible_text,
                model_text,
            }) = switch_request(arg)
            else {
                panic!("missing request")
            };
            assert_eq!(visible_text, format!("/wiki {arg}"));
            assert!(model_text.contains("knowledge.enabled"));
            assert!(model_text.contains("instead of claiming success"));
        }
        assert!(switch_request("delete").is_none());
    }
}
