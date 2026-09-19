use serde::{Deserialize, Serialize};

/// Explicit capability flags using the existing settings field names.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderModelCapabilities {
    pub text: bool,
    pub tools: bool,
    pub vision: bool,
    pub reasoning: bool,
    pub structured_output: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderTemplatesParams {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTemplateInfo {
    pub authentication: kcoder_types::ProviderAuthentication,
    pub id: String,
    pub display_name: String,
    pub api_format: String,
    pub endpoint: String,
    pub documentation_url: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTemplatesResult {
    pub supports_authentication_policy: bool,
    pub templates: Vec<ProviderTemplateInfo>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderDeleteParams {
    pub id: String,
    pub confirm: bool,
    #[serde(default)]
    pub replacement_provider: Option<String>,
    #[serde(default)]
    pub remove_credentials: bool,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub replacement_model: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUpsertParams {
    /// Explicit edit/rename target; omission adds or updates only the submitted model.
    #[serde(default)]
    pub original_model: Option<String>,
    #[serde(default)]
    pub capabilities: Option<ProviderModelCapabilities>,
    #[serde(default)]
    pub authentication: Option<kcoder_types::ProviderAuthentication>,
    pub id: String,
    pub api_format: String,
    pub endpoint: String,
    pub model: String,
    pub context_window_tokens: usize,
    pub max_output_tokens: u32,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub make_default: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsProfile {
    #[serde(default)]
    pub is_provider_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ProviderModelCapabilities>,
    #[serde(default)]
    pub authentication: kcoder_types::ProviderAuthentication,
    pub id: String,
    pub api_format: String,
    pub endpoint: String,
    pub model: String,
    pub context_window_tokens: usize,
    pub max_output_tokens: u32,
    pub api_key_configured: bool,
    pub is_default: bool,
    #[serde(default)]
    pub can_delete: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsResult {
    #[serde(default)]
    pub supports_new_session_reload: bool,
    #[serde(default)]
    pub supports_multiple_models: bool,
    #[serde(default)]
    pub supports_model_capabilities: bool,
    pub profiles: Vec<ProviderSettingsProfile>,
    pub restart_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
