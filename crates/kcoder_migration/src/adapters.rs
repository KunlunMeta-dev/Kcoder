//! Pure, bounded source parsers. No credential resolution, subprocess, or network IO.
use crate::model::{MigrationInventory, NormalizedItem, ProviderCandidate};
use anyhow::{Result, bail, ensure};
use kcoder_types::migration::{
    MigrationCategory as Category, MigrationIssue as Issue, MigrationIssueCode as Code,
    MigrationIssueSeverity as Severity, MigrationItemPreview, MigrationItemStatus,
    MigrationSourceKind,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_CONFIGURATION_BYTES: usize = 8 * 1024 * 1024;
const MAX_ITEMS: usize = 1024;

pub fn parse_claude_settings(text: &str) -> Result<MigrationInventory> {
    parse_claude_settings_with_redactions(text, &[])
}

pub(crate) fn parse_claude_settings_with_redactions(
    text: &str,
    inherited_private_values: &[&str],
) -> Result<MigrationInventory> {
    ensure!(
        text.len() <= MAX_CONFIGURATION_BYTES,
        "migration_source_budget_exceeded"
    );
    let document: Value = jsonc_parser::parse_to_serde_value(text, &Default::default())
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    ensure!(document.is_object(), "migration_invalid_source_format");
    ensure!(
        document.get("model").is_none_or(Value::is_string),
        "migration_invalid_source_format"
    );
    ensure!(
        document.get("env").is_none_or(Value::is_object),
        "migration_invalid_source_format"
    );
    let mut secrets = secret_values(&document);
    secrets.extend_from_slice(inherited_private_values);
    let mut inventory = MigrationInventory {
        source: MigrationSourceKind::ClaudeCode,
        adapter_revision: "claude-settings/v1".into(),
        items: Vec::new(),
        issues: Vec::new(),
    };
    let model = safe_text(document.get("model"), 512, &secrets);
    let env_model = safe_text(document.pointer("/env/ANTHROPIC_MODEL"), 512, &secrets);
    let mut provider = provider_item(
        "claude-code",
        "anthropic",
        ProviderCandidate {
            api_format: "anthropic_messages".into(),
            endpoint: safe_endpoint(document.pointer("/env/ANTHROPIC_BASE_URL"), &secrets),
            model: model.clone().or_else(|| env_model.clone()),
            context_window_tokens: None,
            output_headroom_tokens: None,
            max_output_tokens: None,
            credential_environment: None,
        },
    );
    if model.is_some() && env_model.is_some() && model != env_model {
        provider.provider.as_mut().unwrap().model = None;
        provider
            .preview
            .issues
            .push(issue(Code::RequiresReview, Severity::Blocking, "model"));
    }
    if document.pointer("/env/ANTHROPIC_BASE_URL").is_some()
        && provider.provider.as_ref().unwrap().endpoint.is_none()
    {
        provider
            .preview
            .issues
            .push(issue(Code::InvalidEndpoint, Severity::Blocking, "endpoint"));
    }
    if document.pointer("/env/ANTHROPIC_API_KEY").is_some() {
        provider.provider.as_mut().unwrap().credential_environment =
            Some("ANTHROPIC_API_KEY".into());
        provider
            .preview
            .issues
            .push(issue(Code::SecretExcluded, Severity::Notice, "credentials"));
    }
    if document.pointer("/env/ANTHROPIC_AUTH_TOKEN").is_some()
        || document.get("apiKeyHelper").is_some()
    {
        provider.preview.issues.push(issue(
            Code::UnsupportedAuthentication,
            Severity::Blocking,
            "authentication",
        ));
    }
    provider.preview.issues.push(issue(
        Code::CredentialResolutionRequired,
        Severity::Blocking,
        "credentials",
    ));
    validate_provider(&mut provider);
    if document.get("mcpServers").is_none()
        || document.get("model").is_some()
        || document.get("env").is_some()
        || document.get("apiKeyHelper").is_some()
    {
        inventory.items.push(provider);
    }
    collect_mcp(
        document.get("mcpServers"),
        "claude-code",
        &secrets,
        &mut inventory,
    )?;
    if document.get("permissions").is_some() {
        for item in inventory
            .items
            .iter_mut()
            .filter(|item| item.preview.category == Category::Mcp)
        {
            item.preview.issues.push(issue(
                Code::RequiresReview,
                Severity::Blocking,
                "permissions",
            ));
            item.preview.selected_by_default = false;
            item.preview.status = MigrationItemStatus::RequiresAction;
        }
    }
    for (field, category) in [
        ("hooks", Category::Hook),
        ("permissions", Category::Instructions),
    ] {
        if document.get(field).is_some() {
            inventory.items.push(review_item(
                "claude-code",
                field,
                category,
                Code::RequiresReview,
                field,
            ));
        }
    }
    let recognized = [
        "$schema",
        "model",
        "env",
        "apiKeyHelper",
        "mcpServers",
        "hooks",
        "permissions",
    ];
    record_unmapped_fields(&document, &recognized, &mut inventory);
    if document
        .get("env")
        .and_then(Value::as_object)
        .is_some_and(|env| {
            env.keys().any(|name| {
                ![
                    "ANTHROPIC_MODEL",
                    "ANTHROPIC_BASE_URL",
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_AUTH_TOKEN",
                ]
                .contains(&name.as_str())
            })
        })
    {
        inventory
            .issues
            .push(issue(Code::UnsupportedField, Severity::Blocking, "env"));
    }
    if !secrets.is_empty() {
        inventory
            .issues
            .push(issue(Code::SecretExcluded, Severity::Notice, "credentials"));
    }
    ensure!(
        inventory.items.len() <= MAX_ITEMS,
        "migration_source_budget_exceeded"
    );
    Ok(inventory)
}

pub fn parse_codex_config(text: &str) -> Result<MigrationInventory> {
    parse_codex_config_with_redactions(text, &[])
}

pub(crate) fn parse_codex_config_with_redactions(
    text: &str,
    inherited_private_values: &[&str],
) -> Result<MigrationInventory> {
    ensure!(
        text.len() <= MAX_CONFIGURATION_BYTES,
        "migration_source_budget_exceeded"
    );
    let value: toml::Value =
        toml::from_str(text).map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    let document = serde_json::to_value(value)
        .map_err(|_| anyhow::anyhow!("migration_invalid_source_format"))?;
    ensure!(document.is_object(), "migration_invalid_source_format");
    ensure!(
        ["model", "model_provider"]
            .iter()
            .all(|name| document.get(name).is_none_or(Value::is_string)),
        "migration_invalid_source_format"
    );
    let mut secrets = secret_values(&document);
    secrets.extend_from_slice(inherited_private_values);
    let mut inventory = MigrationInventory {
        source: MigrationSourceKind::Codex,
        adapter_revision: "codex-config/v1".into(),
        items: Vec::new(),
        issues: Vec::new(),
    };
    let active = document
        .get("model_provider")
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let providers = document.get("model_providers").and_then(Value::as_object);
    if document.get("model_providers").is_some() && providers.is_none() {
        bail!("migration_invalid_source_format");
    }
    if providers.is_some_and(|items| items.len() > MAX_ITEMS) {
        bail!("migration_source_budget_exceeded");
    }
    if let Some(providers) = providers {
        for (index, (name, source)) in providers.iter().enumerate() {
            ensure!(source.is_object(), "migration_invalid_source_format");
            let label = safe_label(name, &secrets).unwrap_or_else(|| format!("provider-{index}"));
            let selected = name == active;
            let mut item = provider_item(
                "codex",
                &label,
                ProviderCandidate {
                    api_format: "openai_responses".into(),
                    endpoint: safe_endpoint(source.get("base_url"), &secrets),
                    model: if selected {
                        safe_text(document.get("model"), 512, &secrets)
                    } else {
                        None
                    },
                    context_window_tokens: if selected {
                        positive(document.get("model_context_window"))
                    } else {
                        None
                    },
                    output_headroom_tokens: None,
                    max_output_tokens: None,
                    credential_environment: safe_text(source.get("env_key"), 128, &secrets)
                        .filter(|v| environment_name(v)),
                },
            );
            if source.get("base_url").is_some()
                && item.provider.as_ref().unwrap().endpoint.is_none()
            {
                item.preview.issues.push(issue(
                    Code::InvalidEndpoint,
                    Severity::Blocking,
                    "endpoint",
                ));
            }
            if source
                .get("wire_api")
                .is_some_and(|v| v.as_str() != Some("responses"))
            {
                item.preview.issues.push(issue(
                    Code::UnsupportedSourceFormat,
                    Severity::Blocking,
                    "wire_api",
                ));
            }
            if source.get("auth").is_some()
                || source.get("experimental_bearer_token").is_some()
                || source
                    .get("requires_openai_auth")
                    .is_some_and(|v| v != &Value::Bool(false))
            {
                item.preview.issues.push(issue(
                    Code::UnsupportedAuthentication,
                    Severity::Blocking,
                    "authentication",
                ));
            }
            for field in ["http_headers", "env_http_headers"] {
                if source.get(field).is_some() {
                    item.preview.issues.push(issue(
                        Code::RequiresReview,
                        Severity::Blocking,
                        field,
                    ));
                }
            }
            let known = [
                "name",
                "base_url",
                "wire_api",
                "env_key",
                "requires_openai_auth",
                "auth",
                "experimental_bearer_token",
                "http_headers",
                "env_http_headers",
            ];
            if source
                .as_object()
                .unwrap()
                .keys()
                .any(|name| !known.contains(&name.as_str()))
            {
                item.preview.issues.push(issue(
                    Code::UnsupportedField,
                    Severity::Blocking,
                    "model_providers",
                ));
            }
            item.preview.issues.push(issue(
                Code::CredentialResolutionRequired,
                Severity::Blocking,
                "credentials",
            ));
            validate_provider(&mut item);
            inventory.items.push(item);
        }
    }
    if !providers.is_some_and(|providers| providers.contains_key(active)) {
        let name = safe_label(active, &secrets).unwrap_or_else(|| "provider".into());
        let mut item = provider_item(
            "codex",
            &name,
            ProviderCandidate {
                api_format: "openai_responses".into(),
                endpoint: None,
                model: safe_text(document.get("model"), 512, &secrets),
                context_window_tokens: positive(document.get("model_context_window")),
                output_headroom_tokens: None,
                max_output_tokens: None,
                credential_environment: None,
            },
        );
        item.preview.issues.push(issue(
            Code::CredentialResolutionRequired,
            Severity::Blocking,
            "credentials",
        ));
        validate_provider(&mut item);
        inventory.items.push(item);
    }
    collect_mcp(
        document.get("mcp_servers"),
        "codex",
        &secrets,
        &mut inventory,
    )?;
    for field in ["profiles", "profile"] {
        if document.get(field).is_some() {
            inventory.items.push(review_item(
                "codex",
                field,
                Category::Provider,
                Code::RequiresReview,
                field,
            ));
        }
    }
    let known = [
        "model",
        "model_provider",
        "model_providers",
        "model_context_window",
        "model_reasoning_effort",
        "mcp_servers",
        "profiles",
        "profile",
    ];
    record_unmapped_fields(&document, &known, &mut inventory);
    if !secrets.is_empty() {
        inventory
            .issues
            .push(issue(Code::SecretExcluded, Severity::Notice, "credentials"));
    }
    ensure!(
        inventory.items.len() <= MAX_ITEMS,
        "migration_source_budget_exceeded"
    );
    Ok(inventory)
}

fn record_unmapped_fields(
    document: &Value,
    recognized: &[&str],
    inventory: &mut MigrationInventory,
) {
    if document.as_object().is_some_and(|fields| {
        fields
            .keys()
            .any(|name| !recognized.contains(&name.as_str()))
    }) {
        // Do not echo unknown keys: a malformed source can put secrets in key names.
        inventory.issues.push(issue(
            Code::UnsupportedField,
            Severity::Warning,
            "configuration",
        ));
    }
}

fn provider_item(source: &str, name: &str, provider: ProviderCandidate) -> NormalizedItem {
    let id = format!("{source}:provider:{:x}", Sha256::digest(name.as_bytes()));
    NormalizedItem {
        preview: MigrationItemPreview {
            id,
            category: Category::Provider,
            source_name: name.into(),
            status: MigrationItemStatus::RequiresAction,
            selected_by_default: false,
            issues: Vec::new(),
        },
        provider: Some(provider),
        mcp: None,
        asset: None,
        template: None,
    }
}

fn validate_provider(item: &mut NormalizedItem) {
    let candidate = item.provider.as_ref().unwrap();
    if candidate.model.is_none() {
        item.preview
            .issues
            .push(issue(Code::MissingModel, Severity::Blocking, "model"));
    }
    if candidate.endpoint.is_none() {
        item.preview
            .issues
            .push(issue(Code::RequiresReview, Severity::Blocking, "endpoint"));
    }
    if candidate.context_window_tokens.is_none()
        || candidate.max_output_tokens.is_none()
        || candidate.output_headroom_tokens.is_none()
    {
        item.preview.issues.push(issue(
            Code::MissingModelLimits,
            Severity::Blocking,
            "model_limits",
        ));
    }
}

fn collect_mcp(
    value: Option<&Value>,
    source: &str,
    secrets: &[&str],
    inventory: &mut MigrationInventory,
) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let servers = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("migration_invalid_source_format"))?;
    ensure!(
        servers.len().saturating_add(inventory.items.len()) <= MAX_ITEMS,
        "migration_source_budget_exceeded"
    );
    for (index, (name, definition)) in servers.iter().enumerate() {
        ensure!(definition.is_object(), "migration_invalid_source_format");
        let name = safe_label(name, secrets).unwrap_or_else(|| format!("server-{index}"));
        let mut item = review_item(source, &name, Category::Mcp, Code::RequiresReview, "mcp");
        crate::mcp_adapters::normalize(&mut item, definition, secrets);
        inventory.items.push(item);
    }
    Ok(())
}

fn review_item(
    source: &str,
    name: &str,
    category: Category,
    code: Code,
    field: &str,
) -> NormalizedItem {
    let input = format!("{source}:{category:?}:{name}");
    NormalizedItem {
        preview: MigrationItemPreview {
            id: format!("{source}:item:{:x}", Sha256::digest(input.as_bytes())),
            category,
            source_name: name.into(),
            status: MigrationItemStatus::RequiresAction,
            selected_by_default: false,
            issues: vec![issue(code, Severity::Blocking, field)],
        },
        provider: None,
        mcp: None,
        asset: None,
        template: None,
    }
}

pub(crate) fn issue(code: Code, severity: Severity, field: &str) -> Issue {
    Issue {
        code,
        severity,
        phase: if matches!(
            code,
            Code::CredentialResolutionRequired
                | Code::RequiresReauthentication
                | Code::UnsupportedAuthentication
        ) {
            kcoder_types::migration::MigrationIssuePhase::Activation
        } else {
            kcoder_types::migration::MigrationIssuePhase::Import
        },
        field: Some(field.into()),
    }
}
fn positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64).filter(|v| *v > 0)
}
pub(crate) fn safe_text(value: Option<&Value>, limit: usize, secrets: &[&str]) -> Option<String> {
    let text = value?.as_str()?;
    let decoded = percent_encoding::percent_decode_str(text).decode_utf8_lossy();
    (!text.is_empty()
        && text.len() <= limit
        && !text.chars().any(char::is_control)
        && !secrets.iter().any(|secret| {
            !secret.is_empty() && (text.contains(secret) || decoded.contains(secret))
        }))
    .then(|| text.to_owned())
}
fn safe_label(value: &str, secrets: &[&str]) -> Option<String> {
    safe_text(Some(&Value::String(value.into())), 128, secrets)
}
pub(crate) fn safe_endpoint(value: Option<&Value>, secrets: &[&str]) -> Option<String> {
    let text = safe_text(value, 4096, secrets)?;
    let parsed = url::Url::parse(&text).ok()?;
    (matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none())
    .then_some(text)
}
fn environment_name(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
pub(crate) fn secret_values(document: &Value) -> Vec<&str> {
    fn walk<'a>(value: &'a Value, sensitive: bool, output: &mut Vec<&'a str>) {
        match value {
            Value::String(text) if sensitive && !text.is_empty() => {
                output.push(text);
                if let Some((scheme, token)) = text.split_once(' ')
                    && (scheme.eq_ignore_ascii_case("bearer")
                        || scheme.eq_ignore_ascii_case("basic"))
                    && !token.trim().is_empty()
                {
                    output.push(token.trim());
                }
            }
            Value::Array(items) => {
                for value in items {
                    walk(value, sensitive, output)
                }
            }
            Value::Object(fields) => {
                for (name, value) in fields {
                    let lower = name.to_ascii_lowercase();
                    let secret = sensitive
                        || kcoder_config::looks_like_credential_env_key(name)
                        || [
                            "key",
                            "token",
                            "password",
                            "secret",
                            "api_key",
                            "access_token",
                            "refresh_token",
                            "auth_token",
                            "experimental_bearer_token",
                            "headers",
                            "http_headers",
                            "env_http_headers",
                            "apikeyhelper",
                            "apikey",
                            "authtoken",
                            "clientsecret",
                            "client_secret",
                        ]
                        .contains(&lower.as_str());
                    walk(value, secret, output);
                }
            }
            _ => {}
        }
    }
    let mut values = Vec::new();
    walk(document, false, &mut values);
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    const CANARY: &str = "SYNTHETIC_CREDENTIAL_CANARY_NOT_A_REAL_KEY";

    #[test]
    fn jsonc_source_comments_and_trailing_commas_are_read_without_rewriting_the_source() {
        let source = "// source comment\n{\"model\":\"source-model\",}\n";
        let inventory = parse_claude_settings(source).unwrap();
        assert_eq!(
            inventory.items[0]
                .provider
                .as_ref()
                .unwrap()
                .model
                .as_deref(),
            Some("source-model")
        );
    }
    #[test]
    fn claude_candidates_never_serialize_embedded_credentials_or_guess_model_limits() {
        let inventory =
            parse_claude_settings(include_str!("../tests/fixtures/claude-settings.json")).unwrap();
        let serialized = serde_json::to_string(&inventory).unwrap();
        assert!(!serialized.contains(CANARY));
        assert_eq!(
            inventory.items[0]
                .provider
                .as_ref()
                .unwrap()
                .model
                .as_deref(),
            Some("source-model")
        );
        assert!(
            inventory.items[0]
                .provider
                .as_ref()
                .unwrap()
                .max_output_tokens
                .is_none()
        );
        assert!(
            inventory.items[0]
                .preview
                .issues
                .iter()
                .any(|issue| issue.code == Code::MissingModelLimits)
        );
        assert!(
            inventory
                .items
                .iter()
                .all(|item| !item.preview.selected_by_default)
        );
    }
    #[test]
    fn codex_preserves_case_and_protocol_but_not_compression_as_output_budget() {
        let inventory =
            parse_codex_config(include_str!("../tests/fixtures/codex-config.toml")).unwrap();
        let serialized = serde_json::to_string(&inventory).unwrap();
        assert!(!serialized.contains(CANARY));
        let provider = inventory
            .items
            .iter()
            .find(|item| item.preview.source_name == "TeamGateway")
            .unwrap();
        let candidate = provider.provider.as_ref().unwrap();
        assert_eq!(candidate.api_format, "openai_responses");
        assert_eq!(candidate.context_window_tokens, Some(128000));
        assert_eq!(candidate.max_output_tokens, None);
        assert_eq!(
            candidate.credential_environment.as_deref(),
            Some("TEAM_GATEWAY_KEY")
        );
        let mcp = inventory
            .items
            .iter()
            .find(|item| item.preview.category == Category::Mcp)
            .unwrap();
        assert_eq!(
            mcp.mcp.as_ref().unwrap().config.policy.enabled_tools,
            Some(vec!["read".into()])
        );
        assert!(mcp.provider.is_none());
        assert!(
            inventory
                .issues
                .iter()
                .any(|issue| issue.code == Code::UnsupportedField)
        );
    }
    #[test]
    fn source_parser_errors_are_payload_free() {
        for source in [
            format!("model = \"{CANARY}"),
            format!("model_providers = \"{CANARY}\""),
        ] {
            assert!(
                !parse_codex_config(&source)
                    .unwrap_err()
                    .to_string()
                    .contains(CANARY)
            );
        }
        assert!(
            !parse_claude_settings(&format!(r#"{{"key":"{CANARY}""#))
                .unwrap_err()
                .to_string()
                .contains(CANARY)
        );
    }
    #[test]
    fn embedded_credentials_in_endpoint_or_label_cannot_escape_the_projection() {
        let source = format!(
            r#"{{"model":"{CANARY}","env":{{"ANTHROPIC_API_KEY":"{CANARY}","ANTHROPIC_BASE_URL":"https://user:{CANARY}@example.test"}}}}"#
        );
        let inventory = parse_claude_settings(&source).unwrap();
        assert!(!serde_json::to_string(&inventory).unwrap().contains(CANARY));
        assert!(
            inventory.items[0]
                .provider
                .as_ref()
                .unwrap()
                .model
                .is_none()
        );
        assert!(
            inventory.items[0]
                .preview
                .issues
                .iter()
                .any(|issue| issue.code == Code::InvalidEndpoint)
        );
    }
    #[test]
    fn unsupported_protocol_and_conflicting_model_sources_stay_blocked() {
        let source = "model='x'\nmodel_provider='Team'\n[model_providers.Team]\nbase_url='https://example.test/v1'\nwire_api='unknown'";
        let inventory = parse_codex_config(source).unwrap();
        assert!(
            inventory.items[0]
                .preview
                .issues
                .iter()
                .any(|issue| issue.code == Code::UnsupportedSourceFormat)
        );
        let inventory =
            parse_claude_settings(r#"{"model":"one","env":{"ANTHROPIC_MODEL":"two"}}"#).unwrap();
        assert!(
            inventory.items[0]
                .provider
                .as_ref()
                .unwrap()
                .model
                .is_none()
        );
    }

    #[test]
    fn percent_encoded_credentials_are_not_exported_as_endpoint_or_model() {
        let inventory = parse_claude_settings(
            r#"{
            "model":"private%2Fcredential",
            "env":{"ANTHROPIC_API_KEY":"private/credential",
                "ANTHROPIC_BASE_URL":"https://example.invalid/private%2Fcredential"}
        }"#,
        )
        .unwrap();
        let candidate = inventory.items[0].provider.as_ref().unwrap();
        assert!(candidate.endpoint.is_none());
        assert!(candidate.model.is_none());
    }
}
