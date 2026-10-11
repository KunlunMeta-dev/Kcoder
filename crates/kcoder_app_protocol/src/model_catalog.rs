use serde::{Deserialize, Serialize};

/// Safe additive contract carried by runtime.models.list model entries.
/// Old clients can ignore it; absence denotes a target without this projection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalogEntry {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub provider_id: String,
    pub provider_name: String,
    pub provider_type: String,
    pub provider_current: bool,
    pub description: Option<String>,
    pub hidden: bool,
    pub is_default: bool,
    pub default_reasoning_effort: Option<String>,
    pub supported_reasoning_efforts: Vec<String>,
    pub supports_fast_mode: bool,
    pub supports_vision: bool,
    pub available: bool,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<kcoder_types::ModelConfigurationSummary>,
}
