//! Non-mutating compatibility for the known deployment TOML shape only.
//! Wiring requires the existing locked toml 0.8.23 dependency. Publication and
//! credential transfer remain separate coordinated transactions with backups.
use serde_json::{Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsDocumentSyntax {
    Jsonc,
    LegacyDeploymentToml,
}

pub struct CompatibleSettingsDocument {
    pub value: Value,
    pub syntax: SettingsDocumentSyntax,
}
impl std::fmt::Debug for CompatibleSettingsDocument {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("CompatibleSettingsDocument")
            .field("syntax", &self.syntax)
            .field("value", &"<private settings>")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsCompatibilityError {
    Malformed,
    UnsupportedLegacy,
    CredentialsNeedTransaction,
}
impl SettingsCompatibilityError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "settings_parse_failed",
            _ => "settings_schema_invalid",
        }
    }
}
impl std::fmt::Display for SettingsCompatibilityError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for SettingsCompatibilityError {}

pub fn parse_compatible_settings_document(
    source: &str,
) -> Result<CompatibleSettingsDocument, SettingsCompatibilityError> {
    let json = if source.trim().is_empty() {
        Ok(Value::Object(Map::new()))
    } else {
        jsonc_parser::parse_to_serde_value(source, &Default::default())
    };
    if let Ok(value) = json {
        if !value.is_object() {
            return Err(SettingsCompatibilityError::Malformed);
        }
        return Ok(CompatibleSettingsDocument {
            value,
            syntax: SettingsDocumentSyntax::Jsonc,
        });
    }
    // A broken JSON object never gains a second, more permissive interpretation.
    if source.trim_start().starts_with('{') {
        return Err(SettingsCompatibilityError::Malformed);
    }
    let parsed: toml::Value =
        toml::from_str(source).map_err(|_| SettingsCompatibilityError::Malformed)?;
    let mut value =
        serde_json::to_value(parsed).map_err(|_| SettingsCompatibilityError::Malformed)?;
    let root = value
        .as_object_mut()
        .ok_or(SettingsCompatibilityError::Malformed)?;
    let legacy = root
        .remove("model_providers")
        .ok_or(SettingsCompatibilityError::UnsupportedLegacy)?;
    if !legacy.is_object() {
        return Err(SettingsCompatibilityError::UnsupportedLegacy);
    }
    const ROOT_FIELDS: &[&str] = &[
        "provider",
        "active_provider",
        "model",
        "api_format",
        "providers",
        "permission_mode",
        "credential_store",
        "max_retries",
        "model_discovery",
        "tui",
        "tools",
        "context_window_tokens",
        "context_output_headroom",
        "max_tokens",
    ];
    if root.keys().any(|key| !ROOT_FIELDS.contains(&key.as_str())) {
        return Err(SettingsCompatibilityError::UnsupportedLegacy);
    }
    let selected = root
        .get("active_provider")
        .or_else(|| root.get("provider"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let model = root.get("model").cloned();
    let format = root.remove("api_format");
    root.remove("provider");
    if !root.contains_key("active_provider")
        && let Some(selected) = &selected
    {
        root.insert("active_provider".into(), Value::String(selected.clone()));
    }
    if !root.contains_key("providers") {
        let mut providers = Map::new();
        for (id, value) in legacy.as_object().unwrap() {
            let mut provider = value
                .as_object()
                .ok_or(SettingsCompatibilityError::UnsupportedLegacy)?
                .clone();
            if has_secret_field(&Value::Object(provider.clone())) {
                return Err(SettingsCompatibilityError::CredentialsNeedTransaction);
            }
            const PROVIDER_FIELDS: &[&str] = &[
                "api_format",
                "endpoint",
                "base_url",
                "default_model",
                "model",
                "context_window_tokens",
                "output_headroom_tokens",
                "max_output_tokens",
                "request_timeout_secs",
                "authentication",
                "credential_env",
                "discover_models",
                "no_proxy",
                "max_retries",
            ];
            if provider
                .keys()
                .any(|key| !PROVIDER_FIELDS.contains(&key.as_str()))
            {
                return Err(SettingsCompatibilityError::UnsupportedLegacy);
            }
            move_alias(&mut provider, "base_url", "endpoint");
            move_alias(&mut provider, "model", "default_model");
            if selected.as_deref() == Some(id) {
                if !provider.contains_key("default_model")
                    && let Some(model) = &model
                {
                    provider.insert("default_model".into(), model.clone());
                }
                if !provider.contains_key("api_format")
                    && let Some(format) = &format
                {
                    provider.insert("api_format".into(), format.clone());
                }
            }
            if let Some(format) = provider.get_mut("api_format") {
                match format.as_str() {
                    Some("openai") => *format = Value::String("openai_chat_completions".into()),
                    Some(
                        "openai_chat_completions"
                        | "openai_responses"
                        | "anthropic_messages"
                        | "gemini_generate_content",
                    ) => {}
                    _ => return Err(SettingsCompatibilityError::UnsupportedLegacy),
                }
            }
            // Missing model, authentication or limits stay missing. Neither an
            // endpoint nor an empty key proves anonymous access or a budget.
            providers.insert(id.clone(), Value::Object(provider));
        }
        root.insert("providers".into(), Value::Object(providers));
    }
    Ok(CompatibleSettingsDocument {
        value,
        syntax: SettingsDocumentSyntax::LegacyDeploymentToml,
    })
}

fn move_alias(object: &mut Map<String, Value>, old: &str, current: &str) {
    if let Some(value) = object.remove(old) {
        object.entry(current).or_insert(value);
    }
}
fn has_secret_field(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "api_key" | "apikey" | "access_token" | "token" | "password" | "secret"
            ) || has_secret_field(value)
        }),
        Value::Array(values) => values.iter().any(has_secret_field),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LEGACY: &str = "provider = \"CaseSensitive\"\nmodel = \"\"\napi_format = \"openai\"\n[model_providers.CaseSensitive]\nbase_url = \"http://127.0.0.1:1/v1\"\n";
    #[test]
    fn known_legacy_is_non_mutating_and_never_invents_model_limits_auth_or_permissions() {
        let parsed = parse_compatible_settings_document(LEGACY).unwrap();
        assert_eq!(parsed.syntax, SettingsDocumentSyntax::LegacyDeploymentToml);
        assert_eq!(parsed.value["active_provider"], "CaseSensitive");
        assert_eq!(
            parsed.value["providers"]["CaseSensitive"]["default_model"],
            ""
        );
        assert_eq!(
            parsed.value["providers"]["CaseSensitive"]["api_format"],
            "openai_chat_completions"
        );
        assert!(
            parsed.value["providers"]["CaseSensitive"]
                .get("context_window_tokens")
                .is_none()
        );
        assert!(
            parsed.value["providers"]["CaseSensitive"]
                .get("authentication")
                .is_none()
        );
        assert!(parsed.value.get("permission_mode").is_none());
    }
    #[test]
    fn content_selects_json_even_when_a_target_names_the_file_toml() {
        let parsed = parse_compatible_settings_document("{\"providers\":{}}").unwrap();
        assert_eq!(parsed.syntax, SettingsDocumentSyntax::Jsonc);
        assert_eq!(parsed.value, serde_json::json!({"providers":{}}));
        assert!(parse_compatible_settings_document("{ broken = true").is_err());
    }
    #[test]
    fn explicit_modern_provider_ownership_never_restores_the_legacy_catalog() {
        let parsed = parse_compatible_settings_document(
            "providers = {}\n[model_providers.Old]\nbase_url = \"http://127.0.0.1:1/v1\"\n",
        )
        .unwrap();
        assert_eq!(parsed.value["providers"], serde_json::json!({}));
    }
    #[test]
    fn plaintext_credentials_need_the_existing_controlled_credential_transaction() {
        let source = format!("{LEGACY}api_key = \"owned-secret-never-output\"\n");
        let error = parse_compatible_settings_document(&source).unwrap_err();
        assert_eq!(
            error,
            SettingsCompatibilityError::CredentialsNeedTransaction
        );
        assert!(!format!("{error:?}").contains("owned-secret"));
    }
}
