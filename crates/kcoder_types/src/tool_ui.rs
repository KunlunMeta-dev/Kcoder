//! Untrusted plain-text presentation metadata, separate from model tool definitions.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type ToolDisplayText = BTreeMap<String, String>;

pub fn default_tool_display_text() -> ToolDisplayText {
    display_text("Calling a tool", "正在调用工具")
}

pub fn thinking_display_text() -> ToolDisplayText {
    display_text("Analyzing the request", "正在分析请求")
}

fn display_text(en: &str, zh: &str) -> ToolDisplayText {
    [("en".into(), en.into()), ("zh-CN".into(), zh.into())].into()
}

pub const TOOL_DISPLAY_NAME_LIMIT: usize = 128;
pub const TOOL_DESCRIPTION_LIMIT: usize = 512;
pub const TOOL_CATALOG_LIMIT: usize = 512;
pub const TOOL_CATALOG_BYTE_LIMIT: usize = 1024 * 1024;
pub const TOOL_CATALOG_CONTENT_BYTE_LIMIT: usize = TOOL_CATALOG_BYTE_LIMIT - 4096;

/// Counts of generated tool arguments, not committed file changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputLineProgress {
    pub generated_lines: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaced_lines: Option<usize>,
}

/// Observed workspace differences while a turn is running; never a tool receipt.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileProgress {
    pub additions: u64,
    pub deletions: u64,
    pub files: u64,
    pub binary_files: u64,
    pub partial: bool,
}

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
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

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
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

#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUiMetadata {
    pub display_name: String,
    pub group: ToolUiGroup,
    pub icon: ToolUiIcon,
    pub description: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub display_text: ToolDisplayText,
}

impl ToolUiMetadata {
    /// Render unknown historical names without requiring a live registration.
    pub fn fallback(name: &str) -> Self {
        Self {
            display_name: bounded_text(name, TOOL_DISPLAY_NAME_LIMIT),
            group: ToolUiGroup::Other,
            icon: ToolUiIcon::Tool,
            description: String::new(),
            display_text: default_tool_display_text(),
        }
    }

    /// Apply the wire budget even when a plugin overrides the default metadata.
    pub fn bounded(mut self, name: &str) -> Self {
        self.display_name = bounded_text(&self.display_name, TOOL_DISPLAY_NAME_LIMIT);
        if self.display_name.trim().is_empty() {
            self.display_name = bounded_text(name, TOOL_DISPLAY_NAME_LIMIT);
        }
        self.description = bounded_text(&self.description, TOOL_DESCRIPTION_LIMIT);
        self.display_text = self
            .display_text
            .into_iter()
            .take(8)
            .map(|(locale, text)| {
                (
                    bounded_text(&locale, 32),
                    bounded_text(&text, TOOL_DISPLAY_NAME_LIMIT),
                )
            })
            .filter(|(locale, text)| !locale.trim().is_empty() && !text.trim().is_empty())
            .collect();
        if self.display_text.is_empty() {
            self.display_text = default_tool_display_text();
        }
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
    fn old_metadata_still_loads_and_display_text_is_bounded() {
        let old: ToolUiMetadata = serde_json::from_value(serde_json::json!({
            "displayName":"Read", "group":"files", "icon":"file", "description":"read"
        }))
        .unwrap();
        assert_eq!(old.bounded("read").display_text["zh-CN"], "正在调用工具");
        let mut custom = ToolUiMetadata::fallback("read");
        custom
            .display_text
            .insert("zh-CN".into(), format!("\u{1b}{}", "界".repeat(200)));
        assert_eq!(
            custom.bounded("read").display_text["zh-CN"].chars().count(),
            TOOL_DISPLAY_NAME_LIMIT
        );
    }

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
