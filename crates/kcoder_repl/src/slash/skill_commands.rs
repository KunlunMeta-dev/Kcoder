use crate::ReplApp;
use kcoder_engine::QueryEngine;
use kcoder_types::MessageRole;
use kcoder_types::tool_ui::{ToolUiGroup, ToolUiIcon};

use super::{SlashCommand, SlashResult};

#[derive(Default)]
pub(super) struct SkillCommand;

#[async_trait::async_trait]
impl SlashCommand for SkillCommand {
    fn name(&self) -> &'static str {
        "/skill"
    }
    fn description(&self) -> &'static str {
        "Activate, deactivate, or inspect a skill."
    }
    fn usage(&self) -> &'static str {
        "/skill [--off] <name> [args...]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let args = args.trim();
        if args.is_empty() {
            let active = engine.active_skills.read().unwrap().clone();
            app.push_message(
                MessageRole::System,
                format!("Active skills: {}", active.join(", ")),
            );
            return SlashResult::Handled;
        }

        let mut tokens = args.split_whitespace();
        let first = tokens.next().unwrap();

        // Deactivate mode.
        if first == "--off" || first == "-d" {
            let name = tokens.next().unwrap_or("");
            if name.is_empty() {
                app.push_message(MessageRole::System, "Usage: /skill --off <name>");
                return SlashResult::Handled;
            }
            let mut active = engine.active_skills.write().unwrap();
            active.retain(|s| s != name);
            app.push_message(MessageRole::System, format!("Deactivated skill: {}", name));
            return SlashResult::Handled;
        }

        let name = first;
        let rest: Vec<&str> = tokens.collect();
        let skill_info = {
            let registry = engine.skill_registry.read().unwrap();
            registry
                .get_active(name)
                .map(|skill| (skill.name.clone(), skill.description.clone()))
        };
        if let Some((skill_name, skill_description)) = skill_info {
            let mut active = engine.active_skills.write().unwrap();
            if !active.iter().any(|s| s == name) {
                active.push(name.to_string());
            }
            let mut msg = format!("Activated skill: {} ({})", skill_name, skill_description);
            if !rest.is_empty() {
                msg.push_str(&format!(" with args: {}", rest.join(" ")));
            }
            app.push_message(MessageRole::System, msg);
        } else {
            app.push_message(
                MessageRole::System,
                format!(
                    "Skill '{}' not found. Use /skills to list available skills.",
                    name
                ),
            );
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct SkillsCommand;

#[async_trait::async_trait]
impl SlashCommand for SkillsCommand {
    fn name(&self) -> &'static str {
        "/skills"
    }
    fn description(&self) -> &'static str {
        "List available skills."
    }
    fn usage(&self) -> &'static str {
        "/skills"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let skill_infos: Vec<_> = {
            let registry = engine.skill_registry.read().unwrap();
            registry
                .names()
                .into_iter()
                .map(|name| {
                    let description = registry
                        .get(&name)
                        .map(|skill| skill.description.clone())
                        .unwrap_or_default();
                    (name, description)
                })
                .collect()
        };
        if skill_infos.is_empty() {
            app.push_message(MessageRole::System, "No skills found.");
        } else {
            let active = engine.active_skills.read().unwrap();
            let lines: Vec<String> = skill_infos
                .into_iter()
                .map(|(name, description)| {
                    let marker = if active.contains(&name) { "x" } else { " " };
                    if description.is_empty() {
                        format!("- [{}] `{name}`", marker)
                    } else {
                        format!("- [{marker}] `{name}` - {description}")
                    }
                })
                .collect();
            app.push_message(
                MessageRole::System,
                format!("## Available skills\n\n{}", lines.join("\n")),
            );
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct ToolsCommand;

#[async_trait::async_trait]
impl SlashCommand for ToolsCommand {
    fn name(&self) -> &'static str {
        "/tools"
    }
    fn description(&self) -> &'static str {
        "List available tools."
    }
    fn usage(&self) -> &'static str {
        "/tools"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let tools = engine.effective_tool_catalog().await;
        let registry = engine.active_tool_registry();
        app.push_message(MessageRole::System, catalog_message(tools, &registry));
        SlashResult::Handled
    }
}

fn catalog_message(
    tools: Vec<kcoder_types::tool_ui::ToolCatalogEntry>,
    registry: &kcoder_tools::ToolRegistry,
) -> String {
    use kcoder_types::tool_ui::{TOOL_CATALOG_CONTENT_BYTE_LIMIT, bounded_tool_catalog};
    let snapshot = bounded_tool_catalog(tools);
    let mut remaining = TOOL_CATALOG_CONTENT_BYTE_LIMIT;
    let lines: Vec<String> = snapshot
        .tools
        .iter()
        .map(|t| {
            let group = match t.ui.group {
                ToolUiGroup::Other => "Other",
                ToolUiGroup::Files => "Files",
                ToolUiGroup::Search => "Search",
                ToolUiGroup::Terminal => "Terminal",
                ToolUiGroup::Agents => "Agents",
                ToolUiGroup::Web => "Web",
                ToolUiGroup::Planning => "Planning",
            };
            let icon = match t.ui.icon {
                ToolUiIcon::Tool => "tool",
                ToolUiIcon::File => "file",
                ToolUiIcon::Search => "search",
                ToolUiIcon::Terminal => "terminal",
                ToolUiIcon::Agent => "agent",
                ToolUiIcon::Globe => "globe",
                ToolUiIcon::Checklist => "checklist",
            };
            let name: String = t.name.chars().filter(|ch| !ch.is_control()).collect();
            let fence = "`".repeat(name.split(|ch| ch != '`').map(str::len).max().unwrap_or(0) + 1);
            let mut line = format!(
                "- [{group}/{icon}] {} ({fence}{name}{fence})",
                catalog_plain_text(&t.ui.display_name),
            );
            if !t.ui.description.is_empty() {
                line.push_str(" - ");
                line.push_str(&catalog_plain_text(&t.ui.description));
            }
            if let Some(tool) = registry.get(&t.name) {
                if tool.is_read_only() {
                    line.push_str(" [read-only]");
                }
                if tool.is_destructive() {
                    line.push_str(" [destructive]");
                }
            }
            line
        })
        .take_while(|line| {
            // Markdown escaping and code fences can grow beyond the wire size.
            if let Some(next) = remaining.checked_sub(line.len().saturating_add(1)) {
                remaining = next;
                true
            } else {
                false
            }
        })
        .collect();
    if lines.len() < snapshot.total {
        format!(
            "## Tools\n\n{}\n\nCatalog truncated: showing {} of {} tools (display budget).",
            lines.join("\n"),
            lines.len(),
            snapshot.total
        )
    } else if lines.is_empty() {
        "## Tools\n\nNo tools available for this session.".into()
    } else {
        format!("## Tools\n\n{}", lines.join("\n"))
    }
}

fn catalog_plain_text(value: &str) -> String {
    let mut text = String::new();
    for ch in value.chars().filter(|ch| !ch.is_control()) {
        if "\\`*_{}[]<>()#!|~".contains(ch) {
            text.push('\\');
        }
        text.push(ch);
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn tools_text(engine: &QueryEngine) -> String {
        let mut app = ReplApp::default();
        ToolsCommand.run("", &mut app, engine).await;
        app.messages.last().unwrap().text.clone()
    }

    #[tokio::test]
    async fn tools_command_consumes_catalog_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let engine = crate::test_support::test_engine_with_default_tools(dir.path());
        let text = tools_text(&engine).await;
        assert!(text.contains("Files"), "{text}");
        assert!(text.contains("Read file (`read`)"), "{text}");
        assert!(text.contains("Run command (`bash`)"), "{text}");
        assert!(text.contains("[read-only]"));
        assert!(text.contains("`spawn_agent`"));
        assert!(text.contains("[Other/tool] CtxInspect (`CtxInspect`)"));
    }

    #[tokio::test]
    async fn tools_command_refreshes_effective_session_filters() {
        let dir = tempfile::tempdir().unwrap();
        let engine = crate::test_support::test_engine_with_default_tools(dir.path());
        engine.settings.write().unwrap().enable_training_mode();
        engine.settings.write().unwrap().permission_mode = kcoder_config::PermissionMode::Yolo;
        let text = tools_text(&engine).await;
        assert!(!text.contains("(`AskUserQuestion`)"));
        engine.settings.write().unwrap().tools.luna.allowed = vec!["read".into()];
        engine.set_luna_mode(true);
        let text = tools_text(&engine).await;
        assert!(text.contains("`read`"));
        assert!(!text.contains("`bash`"));
        engine.settings.write().unwrap().model_capabilities.tools = false;
        assert!(tools_text(&engine).await.contains("No tools available"));
    }

    #[test]
    fn catalog_text_cannot_inject_markdown_or_terminal_controls() {
        assert_eq!(
            catalog_plain_text("\u{1b}[link](https://example.test)\n<b>`x`"),
            "\\[link\\]\\(https://example.test\\)\\<b\\>\\`x\\`"
        );
    }

    #[test]
    fn catalog_message_bounds_count_and_post_escape_bytes() {
        use kcoder_types::tool_ui::{TOOL_CATALOG_BYTE_LIMIT, ToolCatalogEntry, ToolUiMetadata};
        let registry = kcoder_tools::ToolRegistry::new();
        let entry = ToolCatalogEntry {
            name: "工具😀".into(),
            ui: ToolUiMetadata::fallback("tool"),
        };
        let text = catalog_message(vec![entry.clone(); 513], &registry);
        assert_eq!(
            text.lines().filter(|line| line.starts_with("- ")).count(),
            512
        );
        assert!(text.contains("showing 512 of 513"));
        for name in ["😀".repeat(400_000), "`".repeat(400_000)] {
            let text = catalog_message(
                vec![ToolCatalogEntry {
                    name,
                    ..entry.clone()
                }],
                &registry,
            );
            assert!(text.len() <= TOOL_CATALOG_BYTE_LIMIT);
            assert!(text.contains("showing 0 of 1"));
            assert!(!text.contains("No tools available"));
        }
        let escaped = ToolCatalogEntry {
            name: "x".repeat(1700),
            ui: ToolUiMetadata {
                description: "*".repeat(512),
                ..entry.ui
            },
        };
        let text = catalog_message(vec![escaped; 460], &registry);
        assert!(text.len() <= TOOL_CATALOG_BYTE_LIMIT);
        assert!(text.contains("truncated"));
    }
}
