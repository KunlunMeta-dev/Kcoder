//! Target-local tool profile settings; existing conversations keep their registry.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_TOOL_PROFILES_V1: &str = "toolProfilesV1";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolProfile {
    Full,
    Core,
    Nano,
    None,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolsSettingsReadParams {}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolsSettingsSaveParams {
    pub profile: ToolProfile,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsSettingsResult {
    pub profile: ToolProfile,
    pub effective_profile: ToolProfile,
    pub cli_override: Option<ToolProfile>,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_rejects_unknown_profiles_and_fields() {
        assert!(serde_json::from_value::<ToolsSettingsSaveParams>(
            serde_json::json!({"profile":"auto"})
        )
        .is_err());
        assert!(serde_json::from_value::<ToolsSettingsSaveParams>(
            serde_json::json!({"profile":"full","path":"other"})
        )
        .is_err());
    }
}
