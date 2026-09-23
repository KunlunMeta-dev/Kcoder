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
    /// User-settings revision captured when the editor read its draft.
    /// Omission preserves compatibility with clients without revision support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    #[serde(default)]
    pub chat_protocol: Option<kcoder_types::ChatProtocol>,
    /// "default" removes the explicit model override; omission preserves it.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_policy: Option<kcoder_types::ModelReasoningPolicy>,
    /// Legacy Provider-wide writes are rejected when a client has not negotiated model scope.
    #[serde(default)]
    pub extra_body: Option<serde_json::Map<String, serde_json::Value>>,
    /// Model-specific body; omission preserves the edited model.
    #[serde(default)]
    pub model_extra_body: Option<serde_json::Map<String, serde_json::Value>>,
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
    /// Predefined field names and file layers only; no values, paths, or secret keys.
    /// None means this runtime does not report provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_sources: Option<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_in_current_config: Option<bool>,

    #[serde(default)]
    pub chat_protocol: kcoder_types::ChatProtocol,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_policy: Option<kcoder_types::ModelReasoningPolicy>,
    #[serde(default)]
    pub extra_body: serde_json::Map<String, serde_json::Value>,
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
    pub supports_optimistic_concurrency: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Revision committed by this mutation; list reads omit it. A later writer
    /// may advance `revision` before the response's profile list is collected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_revision: Option<String>,
    #[serde(default)]
    pub supports_model_reasoning: bool,
    #[serde(default)]
    pub supports_model_reasoning_policy: bool,
    #[serde(default)]
    pub supports_chat_protocol: bool,
    #[serde(default)]
    pub supports_extra_body: bool,
    #[serde(default)]
    pub supports_model_extra_body: bool,
    #[serde(default)]
    pub supports_new_session_reload: bool,
    #[serde(default)]
    pub supports_turn_model_reload: bool,
    #[serde(default)]
    pub supports_multiple_models: bool,
    #[serde(default)]
    pub supports_model_capabilities: bool,
    pub profiles: Vec<ProviderSettingsProfile>,
    pub restart_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[cfg(test)]
mod revision_contract_tests {
    use super::*;

    #[test]
    fn old_settings_results_and_writes_remain_compatible() {
        let result: ProviderSettingsResult =
            serde_json::from_value(serde_json::json!({"profiles":[],"restartRequired":false}))
                .unwrap();
        assert!(!result.supports_optimistic_concurrency);
        assert!(result.revision.is_none());
        let wire = serde_json::json!({"id":"fixture","apiFormat":"openai_chat_completions","endpoint":"http://127.0.0.1:1/v1","model":"fixture","contextWindowTokens":32000,"maxOutputTokens":4096});
        let mut request: ProviderUpsertParams = serde_json::from_value(wire).unwrap();
        assert!(request.expected_revision.is_none());
        assert!(
            serde_json::to_value(&request)
                .unwrap()
                .get("expectedRevision")
                .is_none()
        );
        request.expected_revision = Some("opaque-v1".into());
        assert_eq!(
            serde_json::to_value(request).unwrap()["expectedRevision"],
            "opaque-v1"
        );
    }
}
