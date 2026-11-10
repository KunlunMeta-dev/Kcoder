//! Explicit server controls are checked before process/network activity.
use crate::PrivateValues;
use anyhow::{Result, bail, ensure};
use kcoder_types::McpServerConfig;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct CredentialContext {
    pub config_dir: std::path::PathBuf,
    pub mode: kcoder_config::CredentialStoreMode,
}

pub fn validate_account(account: Option<&str>) -> Result<()> {
    if account.is_some_and(|value| {
        value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }) {
        bail!("Invalid MCP OAuth account slot");
    }
    Ok(())
}

pub fn validate(config: &McpServerConfig) -> Result<()> {
    let policy = &config.policy;
    validate_account(policy.oauth_account.as_deref())?;
    ensure!(
        policy.oauth_account.is_none()
            || (config.transport == "http"
                && policy.credential_ref.is_none()
                && policy.bearer_token_env_var.is_none()
                && !config
                    .headers
                    .keys()
                    .chain(policy.env_http_headers.keys())
                    .any(|name| name.eq_ignore_ascii_case("authorization"))),
        "MCP OAuth account slots require HTTP browser authorization"
    );
    if let Some(reference) = &policy.credential_ref {
        ensure!(
            reference.id.len() == 37
                && reference.id.starts_with("cred-")
                && reference.id[5..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                && !config.name.starts_with("plugin.")
                && matches!(config.transport.as_str(), "stdio" | "http" | "sse"),
            "invalid MCP credential reference"
        );
    }
    if let Some(workspace) = &policy.workspace {
        ensure!(
            std::path::Path::new(workspace).is_absolute(),
            "MCP workspace scope must be absolute"
        );
    }
    ensure!(
        policy
            .startup_timeout_secs
            .is_none_or(|n| (1..=3600).contains(&n))
            && policy
                .tool_timeout_secs
                .is_none_or(|n| (1..=3600).contains(&n)),
        "invalid MCP timeout"
    );
    ensure!(
        policy.env_vars.len()
            + policy.env_aliases.len()
            + policy.env_http_headers.len()
            + usize::from(policy.bearer_token_env_var.is_some())
            <= 32
            && policy.required_env.len() + policy.required_headers.len() <= 32,
        "MCP environment reference limit exceeded"
    );
    for name in policy
        .env_vars
        .iter()
        .chain(policy.env_aliases.keys())
        .chain(policy.env_aliases.values())
        .chain(policy.required_env.iter())
        .chain(policy.env_http_headers.values())
        .chain(policy.bearer_token_env_var.iter())
    {
        kcoder_config::plugin_credentials::validate_name(name)?;
    }
    let mut headers = std::collections::BTreeSet::new();
    for name in config.headers.keys().chain(policy.env_http_headers.keys()) {
        ensure!(
            headers.insert(name.to_ascii_lowercase()),
            "conflicting MCP header sources"
        );
    }
    if cfg!(windows) {
        let mut variables = std::collections::BTreeSet::new();
        for name in policy.env_aliases.keys() {
            ensure!(
                variables.insert(name.to_ascii_lowercase()),
                "conflicting MCP environment aliases"
            );
        }
    }
    for name in policy
        .enabled_tools
        .iter()
        .flatten()
        .chain(policy.disabled_tools.iter())
    {
        ensure!(
            !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control),
            "invalid MCP tool restriction"
        );
    }
    ensure!(
        policy
            .enabled_tools
            .as_ref()
            .is_none_or(|v| v.len() <= 4096)
            && policy.disabled_tools.len() <= 4096,
        "MCP tool restriction limit exceeded"
    );
    if let Some(cwd) = &policy.cwd {
        ensure!(
            config.transport == "stdio"
                && std::path::Path::new(cwd).is_absolute()
                && !cwd.contains('\0'),
            "MCP working directory must be absolute and use stdio"
        );
    }
    ensure!(
        config.transport == "stdio"
            || (policy.env_vars.is_empty()
                && policy.env_aliases.is_empty()
                && policy.required_env.is_empty()),
        "MCP environment inheritance requires stdio"
    );
    ensure!(
        matches!(config.transport.as_str(), "http" | "sse")
            || (policy.env_http_headers.is_empty()
                && policy.bearer_token_env_var.is_none()
                && policy.required_headers.is_empty()),
        "MCP environment headers require HTTP/SSE"
    );
    for name in &policy.required_headers {
        ensure!(name.len() <= 128, "MCP header reference name exceeds limit");
        http::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid MCP required header"))?;
    }
    for name in policy.env_http_headers.keys() {
        ensure!(name.len() <= 128, "MCP header reference name exceeds limit");
        http::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| anyhow::anyhow!("invalid MCP header reference"))?;
        ensure!(
            !config
                .headers
                .keys()
                .any(|other| other.eq_ignore_ascii_case(name)),
            "conflicting MCP header sources"
        );
    }
    if policy.bearer_token_env_var.is_some() {
        ensure!(
            !config
                .headers
                .keys()
                .chain(policy.env_http_headers.keys())
                .any(|name| name.eq_ignore_ascii_case("authorization")),
            "conflicting MCP authorization sources"
        );
    }
    Ok(())
}

pub fn prepare(config: &McpServerConfig) -> Result<(McpServerConfig, Arc<PrivateValues>)> {
    prepare_in(config, None)
}

pub fn prepare_in(
    config: &McpServerConfig,
    context: Option<&CredentialContext>,
) -> Result<(McpServerConfig, Arc<PrivateValues>)> {
    prepare_with_credentials(
        config,
        |name| std::env::var(name).ok(),
        |config| {
            let backend = kcoder_config::OsCredentialBackend::new();
            if let Some(context) = context {
                kcoder_config::imported_credentials::ImportedCredentialStore::open(
                    &context.config_dir,
                )?
                .resolve_mcp_with_mode(config, context.mode, &backend)
            } else {
                let profile = kcoder_config::user_config_dir()?;
                kcoder_config::imported_credentials::ImportedCredentialStore::open(&profile)?
                    .resolve_mcp(config, &backend)
            }
        },
    )
}

/// Check references without starting a transport or returning private values.
pub fn validate_references(config: &McpServerConfig) -> Result<()> {
    prepare(config).map(|_| ())
}

#[cfg(test)]
fn prepare_with(
    config: &McpServerConfig,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<(McpServerConfig, Arc<PrivateValues>)> {
    prepare_with_credentials(config, lookup, |config| {
        let profile = kcoder_config::user_config_dir()?;
        kcoder_config::imported_credentials::ImportedCredentialStore::open(&profile)?
            .resolve_mcp(config, &kcoder_config::OsCredentialBackend::new())
    })
}

fn prepare_with_credentials(
    config: &McpServerConfig,
    lookup: impl Fn(&str) -> Option<String>,
    load: impl FnOnce(
        &McpServerConfig,
    ) -> Result<kcoder_config::imported_credentials::mcp::McpSecretValues>,
) -> Result<(McpServerConfig, Arc<PrivateValues>)> {
    validate(config)?;
    if config.policy.workspace.is_some() {
        check_workspace(&config.policy, &std::env::current_dir()?)?;
    }
    let mut resolved = config.clone();
    let mut private = Vec::new();
    if config.policy.credential_ref.is_some() {
        let values = load(config)?;
        ensure!(
            values.env.len()
                + values.headers.len()
                + config.policy.env_vars.len()
                + config.policy.env_aliases.len()
                + config.policy.env_http_headers.len()
                + usize::from(config.policy.bearer_token_env_var.is_some())
                <= 32,
            "MCP environment reference limit exceeded"
        );
        for (name, text) in &values.env {
            ensure!(
                environment_value(&resolved.env, name).is_none(),
                "conflicting MCP private environment sources"
            );
            resolved.env.insert(name.clone(), text.clone());
            private.push(text.clone());
        }
        for (name, text) in &values.headers {
            ensure!(
                !resolved
                    .headers
                    .keys()
                    .any(|header| header.eq_ignore_ascii_case(name)),
                "conflicting MCP private header sources"
            );
            resolved.headers.insert(name.clone(), text.clone());
            private.push(text.clone());
        }
    }
    let mut value = |name: &str| -> Result<String> {
        let value = lookup(name)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow::anyhow!("MCP referenced environment value is unavailable"))?;
        ensure!(value.len() <= 16384, "MCP referenced value exceeds limit");
        private.push(value.clone());
        Ok(value)
    };
    for (name, variable) in &config.policy.env_aliases {
        if environment_value(&resolved.env, name).is_none() {
            resolved.env.insert(name.clone(), value(variable)?);
        }
    }
    for name in &config.policy.env_vars {
        if environment_value(&resolved.env, name).is_none() {
            resolved.env.insert(name.clone(), value(name)?);
        }
    }
    for (header, variable) in &config.policy.env_http_headers {
        let text = value(variable)?;
        http::header::HeaderValue::from_str(&text)
            .map_err(|_| anyhow::anyhow!("invalid MCP referenced header value"))?;
        resolved.headers.insert(header.clone(), text);
    }
    if let Some(variable) = &config.policy.bearer_token_env_var {
        let text = format!("Bearer {}", value(variable)?);
        http::header::HeaderValue::from_str(&text)
            .map_err(|_| anyhow::anyhow!("invalid MCP bearer value"))?;
        resolved.headers.insert("Authorization".into(), text);
    }
    ensure!(
        config
            .policy
            .required_env
            .iter()
            .all(|name| environment_value(&resolved.env, name)
                .is_some_and(|value| !value.is_empty()))
            && config.policy.required_headers.iter().all(|name| resolved
                .headers
                .iter()
                .any(|(header, value)| header.eq_ignore_ascii_case(name) && !value.is_empty())),
        "MCP required private configuration is unavailable"
    );
    let values = PrivateValues::new(private)?;
    ensure!(
        !values.contains(&config.name),
        "MCP server identity contains private data"
    );
    Ok((resolved, values))
}

fn environment_value<'a>(
    values: &'a std::collections::HashMap<String, String>,
    name: &str,
) -> Option<&'a String> {
    if cfg!(windows) {
        values
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value)
    } else {
        values.get(name)
    }
}

pub fn check_workspace(
    policy: &kcoder_types::McpServerPolicy,
    cwd: &std::path::Path,
) -> Result<()> {
    if let Some(workspace) = &policy.workspace {
        let root = std::path::Path::new(workspace)
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("MCP workspace scope is unavailable"))?;
        let cwd = cwd
            .canonicalize()
            .map_err(|_| anyhow::anyhow!("MCP current workspace is unavailable"))?;
        ensure!(
            cwd.starts_with(&root),
            "MCP server is restricted to its source workspace"
        );
        ensure!(
            kcoder_config::FolderTrustStore::trust_all_from_environment()
                || kcoder_config::FolderTrustStore::load(&kcoder_config::user_config_dir()?)
                    .check(&root)
                    == kcoder_config::FolderTrust::Trusted,
            "MCP source workspace is not trusted"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_oauth_slots_require_browser_authorization_without_other_credential_sources() {
        let config: McpServerConfig = serde_json::from_value(serde_json::json!({"name":"slot","transport":"http","url":"https://mcp.example.test/mcp","policy":{"oauth_account":"work"}})).unwrap();
        validate(&config).unwrap();
        let mut unsupported = config.clone();
        unsupported.transport = "sse".into();
        assert!(validate(&unsupported).is_err());
        let mut configured = config.clone();
        configured
            .headers
            .insert("Authorization".into(), "SYNTHETIC_FIXTURE".into());
        assert!(validate(&configured).is_err());
        let mut referenced = config;
        referenced.policy.credential_ref = Some(kcoder_types::McpCredentialRef {
            id: format!("cred-{}", "a".repeat(32)),
        });
        assert!(validate(&referenced).is_err());
    }
    #[test]
    fn native_credentials_are_injected_only_at_connection_and_join_private_redaction() {
        let config: McpServerConfig = serde_json::from_value(serde_json::json!({"name":"fixture","command":"must-not-run","policy":{"required_env":["TOKEN"],"credential_ref":{"id":"cred-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}})).unwrap();
        let (resolved, values) = prepare_with_credentials(
            &config,
            |_| None,
            |_| {
                Ok(kcoder_config::imported_credentials::mcp::McpSecretValues {
                    env: std::collections::BTreeMap::from([(
                        "TOKEN".into(),
                        "synthetic-private-native-value".into(),
                    )]),
                    headers: Default::default(),
                })
            },
        )
        .unwrap();
        assert_eq!(resolved.env["TOKEN"], "synthetic-private-native-value");
        assert!(!config.env.contains_key("TOKEN"));
        assert!(values.contains("synthetic-private-native-value"));
        let http: McpServerConfig = serde_json::from_value(serde_json::json!({"name":"fixture","transport":"http","url":"https://example.invalid/mcp","policy":{"required_headers":["Authorization"],"credential_ref":{"id":"cred-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}})).unwrap();
        let (resolved, values) = prepare_with_credentials(
            &http,
            |_| None,
            |_| {
                Ok(kcoder_config::imported_credentials::mcp::McpSecretValues {
                    env: Default::default(),
                    headers: std::collections::BTreeMap::from([(
                        "Authorization".into(),
                        "Bearer synthetic-private-http-value".into(),
                    )]),
                })
            },
        )
        .unwrap();
        assert!(resolved.headers.contains_key("Authorization"));
        assert!(values.contains("Bearer synthetic-private-http-value"));
        assert!(http.headers.is_empty());
    }
    #[test]
    fn references_resolve_privately_and_never_overwrite_explicit_or_conflicting_sources() {
        let config: McpServerConfig = serde_json::from_value(serde_json::json!({"name":"fixture","transport":"stdio","command":"must-not-run","env":{"PUBLIC":"explicit"},"policy":{"env_vars":["PRIVATE","PUBLIC"],"enabled_tools":[],"disabled_tools":["write"]}})).unwrap();
        let (resolved, values) =
            prepare_with(&config, |_| Some("synthetic-secret".into())).unwrap();
        assert_eq!(resolved.env["PUBLIC"], "explicit");
        assert_eq!(resolved.env["PRIVATE"], "synthetic-secret");
        assert!(!config.env.contains_key("PRIVATE"));
        assert!(values.contains("synthetic-secret"));
        assert!(!config.policy.allows("read"));
        assert!(prepare_with(&config, |_| None).is_err());
        let http: McpServerConfig = serde_json::from_value(serde_json::json!({"name":"fixture","transport":"http","url":"https://example.invalid","headers":{"authorization":"literal"},"policy":{"bearer_token_env_var":"TOKEN"}})).unwrap();
        assert!(validate(&http).is_err());
    }
}
