//! Untrusted plain-text presentation metadata, separate from model tool definitions.
use serde::{Deserialize, Serialize};

pub const TOOL_DISPLAY_NAME_LIMIT: usize = 128;
pub const TOOL_DESCRIPTION_LIMIT: usize = 512;
pub const TOOL_CATALOG_LIMIT: usize = 512;
pub const TOOL_CATALOG_BYTE_LIMIT: usize = 1024 * 1024;
pub const TOOL_CATALOG_CONTENT_BYTE_LIMIT: usize = TOOL_CATALOG_BYTE_LIMIT - 4096;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolUiGroup {
    #[default]
    Other,
    Files,
    Search,
    Terminal,
    Agents,
    Web,
    Planning,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolUiIcon {
    #[default]
    Tool,
    File,
    Search,
    Terminal,
    Agent,
    Globe,
    Checklist,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUiMetadata {
    pub display_name: String,
    pub group: ToolUiGroup,
    pub icon: ToolUiIcon,
    pub description: String,
}

impl ToolUiMetadata {
    /// Render unknown historical names without requiring a live registration.
    pub fn fallback(name: &str) -> Self {
        Self {
            display_name: bounded_text(name, TOOL_DISPLAY_NAME_LIMIT),
            group: ToolUiGroup::Other,
            icon: ToolUiIcon::Tool,
            description: String::new(),
        }
    }

    /// Apply the wire budget even when a plugin overrides the default metadata.
    pub fn bounded(mut self, name: &str) -> Self {
        self.display_name = bounded_text(&self.display_name, TOOL_DISPLAY_NAME_LIMIT);
        if self.display_name.trim().is_empty() {
            self.display_name = bounded_text(name, TOOL_DISPLAY_NAME_LIMIT);
        }
        self.description = bounded_text(&self.description, TOOL_DESCRIPTION_LIMIT);
        self
    }
}

fn bounded_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(limit)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCatalogEntry {
    /// Exact invocation key; display text must never replace this identity.
    pub name: String,
    #[serde(flatten)]
    pub ui: ToolUiMetadata,
}

pub struct ToolCatalogSnapshot {
    pub tools: Vec<ToolCatalogEntry>,
    pub total: usize,
    pub truncated: bool,
}

/// Bound presentation snapshots only; never shorten invocation keys or model definitions.
pub fn bounded_tool_catalog(mut tools: Vec<ToolCatalogEntry>) -> ToolCatalogSnapshot {
    let total = tools.len();
    tools.truncate(TOOL_CATALOG_LIMIT);
    let mut remaining = TOOL_CATALOG_CONTENT_BYTE_LIMIT;
    let mut retained = 0;
    for tool in &tools {
        let size =
            serde_json::to_vec(tool).map_or(usize::MAX, |value| value.len().saturating_add(1));
        let Some(next) = remaining.checked_sub(size) else {
            break;
        };
        remaining = next;
        retained += 1;
    }
    tools.truncate(retained);
    ToolCatalogSnapshot {
        truncated: tools.len() < total,
        tools,
        total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_snapshot_bounds_count_bytes_and_preserves_unicode_identity() {
        let entry = ToolCatalogEntry {
            name: "工具😀".repeat(100),
            ui: ToolUiMetadata::fallback("tool"),
        };
        let snapshot = bounded_tool_catalog(vec![entry.clone(); 513]);
        assert_eq!(snapshot.tools.len(), 512);
        assert_eq!(snapshot.total, 513);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.tools[0].name, entry.name);
        let huge = ToolCatalogEntry {
            name: "😀".repeat(1024 * 1024),
            ..entry
        };
        let snapshot = bounded_tool_catalog(vec![huge]);
        assert!(snapshot.tools.is_empty());
        assert_eq!(snapshot.total, 1);
        assert!(snapshot.truncated);
    }

    #[test]
    fn unknown_history_and_untrusted_metadata_have_safe_fallbacks() {
        let name = "已卸载插件".repeat(100);
        let fallback = ToolUiMetadata::fallback(&name);
        assert_eq!(
            fallback.display_name.chars().count(),
            TOOL_DISPLAY_NAME_LIMIT
        );
        assert_eq!(fallback.icon, ToolUiIcon::Tool);
        let metadata = ToolUiMetadata {
            display_name: "\u{1b}\n".into(),
            description: format!("\u{1b}{}", "界".repeat(1000)),
            ..fallback
        }
        .bounded("unknown");
        assert_eq!(metadata.display_name, "unknown");
        assert_eq!(metadata.description.chars().count(), TOOL_DESCRIPTION_LIMIT);
        assert!(!metadata.description.chars().any(char::is_control));
        assert!(serde_json::from_str::<ToolUiIcon>("\"https://example.com/icon.svg\"").is_err());
    }
}
