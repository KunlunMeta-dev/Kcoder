//! Target-owned Studio tool selection; saves never mutate existing sessions.
use kcoder_types::{StudioWorkMode, tool_ui::ToolUiMetadata};
use serde::{Deserialize, Serialize};
pub const CAPABILITY_TOOL_SELECTIONS_V1: &str = "toolSelectionsV1";
pub const CAPABILITY_LUNA_TOOL_SELECTIONS_V1: &str = "lunaToolSelectionsV1";
pub const CAPABILITY_TOOL_SELECTION_RESOLUTION_V1: &str = "toolSelectionResolutionV1";
pub const CAPABILITY_EXPERT_TOOL_SELECTION_V1: &str = "expertToolSelectionV1";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct ToolSelectionsReadParams {
    /// Request the Luna projection only after observing lunaToolSelectionsV1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_luna_baseline: Option<bool>,
    /// Pure next-session preview; never loads resources or changes a task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_resolution: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_expert: Option<kcoder_types::integrations::office::OfficeAssistantDefinition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_expert_tool_selection: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ToolSelectionRestrictionSource {
    ModeSelection,
    LunaBaseline,
    ExpertSelection,
    SkillSelection,
    ModelToolsDisabled,
    DisabledByConfiguration,
    InactiveEditSurface,
    UnsupportedMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSelectionRestriction {
    pub source: ToolSelectionRestrictionSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedStudioTool {
    pub name: String,
    pub effective: bool,
    pub restrictions: Vec<ToolSelectionRestriction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioToolResolution {
    pub mode: StudioWorkMode,
    pub tools: Vec<ResolvedStudioTool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSelectionsSaveParams {
    pub mode: StudioWorkMode,
    pub allowed_tools: Vec<String>,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectableStudioTool {
    pub name: String,
    pub ui: ToolUiMetadata,
    pub available: bool,
    pub supported_modes: Vec<StudioWorkMode>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudioModeToolSelection {
    pub mode: StudioWorkMode,
    pub editable: bool,
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolSelectionsResult {
    pub revision: String,
    pub modes: Vec<StudioModeToolSelection>,
    /// Expert baseline from target settings, independent of Studio mode defaults.
    /// Omission means an older target cannot report it; an empty list disables all tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub luna_allowed_tools: Option<Vec<String>>,
    /// Available only on an explicitly requested preview. It is not execution authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Vec<StudioToolResolution>>,
    /// The selected expert replaces the ordinary task's user tool selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expert_tools_independent: Option<bool>,
    pub tools: Vec<SelectableStudioTool>,
    pub total: usize,
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_are_explicit_and_legacy_response_shape_stays_unchanged() {
        let read: ToolSelectionsReadParams = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(read.include_resolution.is_none());
        assert!(read.preview_expert.is_none());
        let result = ToolSelectionsResult {
            revision: "revision".into(),
            modes: vec![],
            luna_allowed_tools: None,
            resolution: None,
            expert_tools_independent: None,
            tools: vec![],
            total: 0,
            truncated: false,
        };
        let value = serde_json::to_value(result).unwrap();
        assert!(value.get("resolution").is_none());
        assert!(value.get("expertToolsIndependent").is_none());
        assert!(value.get("lunaAllowedTools").is_none());
    }
}
