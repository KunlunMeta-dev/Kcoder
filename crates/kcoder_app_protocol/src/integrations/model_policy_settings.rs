//! Finite opt-in edits to only the native profile's model-policy field.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_MODEL_POLICY_SETTINGS_V1: &str = "modelPolicySettingsV1";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum ModelPolicySettingsMethod {
    #[serde(rename = "integrations/models/settings/read")]
    Read,
    #[serde(rename = "integrations/models/settings/save")]
    Save,
    #[serde(rename = "integrations/models/settings/readOperation")]
    ReadOperation,
}
