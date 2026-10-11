use crate::ApiFormat;
use serde::Serialize;

/// An inert connection suggestion, never a runtime deployment or credential.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTemplate {
    pub id: &'static str,
    pub display_name: &'static str,
    pub api_format: ApiFormat,
    pub endpoint: &'static str,
    pub documentation_url: &'static str,
    pub authentication: crate::ProviderAuthentication,
}

pub fn provider_templates() -> &'static [ProviderTemplate] {
    // Endpoint documentation checked on 2026-09-09. Models remain user-selected.
    &[
        ProviderTemplate {
            id: "deepseek",
            authentication: crate::ProviderAuthentication::ApiKey,
            display_name: "DeepSeek",
            api_format: ApiFormat::OpenaiChatCompletions,
            endpoint: "https://api.deepseek.com/v1",
            documentation_url: "https://api-docs.deepseek.com/",
        },
        ProviderTemplate {
            id: "mistral",
            authentication: crate::ProviderAuthentication::ApiKey,
            display_name: "Mistral",
            api_format: ApiFormat::OpenaiChatCompletions,
            endpoint: "https://api.mistral.ai/v1",
            documentation_url: "https://docs.mistral.ai/api/endpoint/chat",
        },
        ProviderTemplate {
            id: "openrouter",
            authentication: crate::ProviderAuthentication::ApiKey,
            display_name: "OpenRouter",
            api_format: ApiFormat::OpenaiChatCompletions,
            endpoint: "https://openrouter.ai/api/v1",
            documentation_url: "https://openrouter.ai/docs/quickstart",
        },
        ProviderTemplate {
            id: "local-openai",
            display_name: "Local OpenAI-compatible",
            api_format: ApiFormat::OpenaiChatCompletions,
            endpoint: "http://127.0.0.1:8000/v1",
            documentation_url: "https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/",
            authentication: crate::ProviderAuthentication::None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_unauthenticated_profile_never_resolves_any_key() {
        let mut document = crate::default_settings_document();
        document["providers"]["kunlunmeta"]["api_format"] =
            serde_json::json!("openai_chat_completions");
        document["providers"]["kunlunmeta"]["authentication"] = serde_json::json!({"mode":"none"});
        let mut settings: crate::Settings = serde_json::from_value(document).unwrap();
        settings
            .stored_provider_credentials
            .insert("kunlunmeta".into(), "stored-fixture".into());
        assert_eq!(
            settings.resolve_provider_api_key(Some("kunlunmeta"), Some("explicit-fixture".into())),
            None
        );
    }

    #[test]
    fn authentication_policy_schema_accepts_only_known_modes() {
        let mut document = crate::default_settings_document();
        document["providers"] =
            serde_json::json!({"private-local":document["providers"]["kunlunmeta"].clone()});
        document["active_provider"] = serde_json::json!("private-local");
        document["providers"]["private-local"]["api_format"] =
            serde_json::json!("openai_chat_completions");
        document["providers"]["private-local"]["authentication"] =
            serde_json::json!({"mode":"none"});
        crate::validate_and_resolve_settings_document(&document).unwrap();
        document["providers"]["private-local"]["api_format"] =
            serde_json::json!("anthropic_messages");
        assert!(crate::validate_and_resolve_settings_document(&document).is_err());
        document["providers"]["private-local"]["api_format"] =
            serde_json::json!("openai_chat_completions");
        document["providers"]["private-local"]["authentication"] =
            serde_json::json!({"mode":"unknown"});
        assert!(crate::validate_and_resolve_settings_document(&document).is_err());
    }

    #[test]
    fn provider_templates_have_documented_connections_without_model_or_secrets() {
        let templates = provider_templates();
        assert_eq!(
            templates.iter().map(|t| t.id).collect::<Vec<_>>(),
            ["deepseek", "mistral", "openrouter", "local-openai"]
        );
        for template in templates {
            let value = serde_json::to_value(template).unwrap();
            assert_eq!(value["apiFormat"], "openai_chat_completions");
            if template.id == "local-openai" {
                assert_eq!(template.endpoint, "http://127.0.0.1:8000/v1");
                assert_eq!(value["authentication"]["mode"], "none");
            } else {
                assert!(template.endpoint.starts_with("https://"));
                assert_eq!(value["authentication"]["mode"], "api_key");
            }
            assert!(template.documentation_url.starts_with("https://"));
            for forbidden in [
                "model",
                "default_model",
                "apiKey",
                "credential_env",
                "capabilities",
            ] {
                assert!(
                    value.get(forbidden).is_none(),
                    "unexpected field {forbidden}"
                );
            }
        }
        assert_eq!(
            crate::default_providers()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["kunlunmeta"]
        );
    }
}
