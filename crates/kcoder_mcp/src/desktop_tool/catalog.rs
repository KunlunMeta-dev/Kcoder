//! Configuration candidates only. No session, worker, package scan or authority.
use kcoder_types::tool_ui::{ToolCatalogEntry, ToolUiGroup, ToolUiIcon, ToolUiMetadata};

const SERVER_NAME: &str = "kcoder_computer_use";

/// Keep the static selector and the actual late-bound DesktopTool on one namespace.
pub fn desktop_tool_model_name(operation: &str) -> String {
    crate::mcp_tool_name(SERVER_NAME, operation)
}

pub fn desktop_tool_ui_metadata(operation: &str) -> ToolUiMetadata {
    ToolUiMetadata {
        display_name: format!("Desktop {operation}"),
        group: ToolUiGroup::Other,
        icon: ToolUiIcon::Tool,
        description: format!("Windows desktop {operation}. Requires separate desktop authorization, verified native components and an active owned desktop session."),
    }.bounded(&desktop_tool_model_name(operation))
}

/// Enumerate only the real desktop policy's names, without constructing a Tool.
pub fn desktop_tool_candidates() -> Vec<ToolCatalogEntry> {
    kcoder_computer_use::policy::TOOLS
        .iter()
        .map(|operation| ToolCatalogEntry {
            name: desktop_tool_model_name(operation),
            ui: desktop_tool_ui_metadata(operation),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_candidates_follow_the_actual_native_policy_and_model_namespace() {
        let candidates = desktop_tool_candidates();
        assert_eq!(candidates.len(), kcoder_computer_use::policy::TOOLS.len());
        for (candidate, operation) in candidates.iter().zip(kcoder_computer_use::policy::TOOLS) {
            assert_eq!(candidate.name, crate::mcp_tool_name(SERVER_NAME, operation));
            assert_eq!(candidate.ui, desktop_tool_ui_metadata(operation));
            assert!(
                candidate
                    .ui
                    .description
                    .contains("separate desktop authorization")
            );
        }
    }
}
