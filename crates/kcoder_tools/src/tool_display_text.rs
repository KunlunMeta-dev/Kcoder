//! Shipped tool activity copy, independent of model definitions and tool arguments.
use kcoder_types::tool_ui::{ToolDisplayText, default_tool_display_text};
use std::{collections::BTreeMap, sync::OnceLock};

pub fn tool_display_text(name: &str) -> ToolDisplayText {
    static CONFIG: OnceLock<BTreeMap<String, ToolDisplayText>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            serde_json::from_str(include_str!("../resources/tool-display-text.json"))
                .expect("bundled tool display text is valid")
        })
        .get(name)
        .cloned()
        .unwrap_or_else(default_tool_display_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_names_and_unknown_tools_have_localized_activity_copy() {
        for name in [
            "read",
            "WebSearch",
            "WebFetch",
            "explore_agent",
            "TodoWrite",
            "REPL",
        ] {
            let text = tool_display_text(name);
            assert!(!text["en"].is_empty());
            assert_ne!(text["zh-CN"], "正在调用工具", "{name}");
        }
        assert_eq!(
            tool_display_text("uninstalled_plugin")["zh-CN"],
            "正在调用工具"
        );
    }
}
