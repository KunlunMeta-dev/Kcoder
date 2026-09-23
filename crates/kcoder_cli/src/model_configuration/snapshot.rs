//! Host-side durable model semantics. No Settings or credential object is serialized.
use super::*;
use kcoder_api::ProviderBuildOverrides;
use kcoder_config::{
    ApiFormat, ModelEndpointSnapshot, ModelRequestSnapshot, ProviderApiKeySource, ProviderConfig,
};
use kcoder_types::{ChatProtocol, ProviderAuthentication};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialBinding {
    selector: String,
    source: ProviderApiKeySource,
    credential_file: Option<PathBuf>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    request: ModelRequestSnapshot,
    kind: String,
    profile: Option<String>,
    provider_selector: Option<String>,
    credential_env: Vec<String>,
    format: ApiFormat,
    selection: Option<kcoder_config::ActiveModelSelection>,
    authentication: ProviderAuthentication,
    chat_protocol: ChatProtocol,
    endpoint: ModelEndpointSnapshot,
    proxy: Option<ModelEndpointSnapshot>,
    no_proxy: bool,
    timeout: Option<u64>,
    user_agent: Option<String>,
    credential: Option<CredentialBinding>,
}

fn explicit_key(overrides: &ProviderBuildOverrides, kind: ProviderKind) -> Option<String> {
    match kind {
        ProviderKind::Anthropic | ProviderKind::Kunlunmeta => overrides.api_key.clone(),
        ProviderKind::Openai => overrides.openai_api_key.clone(),
        ProviderKind::Local => [
            overrides.local_api_key.clone(),
            overrides.openai_api_key.clone(),
            overrides.api_key.clone(),
        ]
        .into_iter()
        .flatten()
        .find(|key| !key.trim().is_empty()),
        ProviderKind::Gemini => overrides.gemini_api_key.clone(),
        ProviderKind::Grok => overrides.grok_api_key.clone(),
    }
}

impl ModelConfiguration {
    pub(crate) fn snapshot_format(&self, bytes: &[u8]) -> Result<Option<ApiFormat>> {
        anyhow::ensure!(bytes.len() <= 512 * 1024, "Model snapshot exceeds storage limit");
        let snapshot: Snapshot = serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid model snapshot"))?;
        anyhow::ensure!(snapshot.version == 1, "Unsupported model snapshot version");
        Ok(Some(snapshot.format))
    }

    pub(crate) fn refreeze_snapshot(&self, bytes: &[u8], settings: &Settings) -> Result<Vec<u8>> {
        anyhow::ensure!(
            bytes.len() <= 512 * 1024,
            "Model snapshot exceeds storage limit"
        );
        let mut snapshot: Snapshot =
            serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid model snapshot"))?;
        anyhow::ensure!(
            snapshot.version == 1
                && snapshot.request.model == settings.model
                && snapshot.profile == settings.active_provider,
            "Cannot change snapshot model identity through runtime options"
        );
        snapshot.proxy = settings
            .provider_proxy_url
            .as_deref()
            .map(|value| ModelEndpointSnapshot::capture(value, &[]))
            .transpose()?;
        let (_, _, signature) =
            self.materialize_snapshot(&snapshot, settings.provider_proxy_url.as_deref())?;
        let mut checked = settings.clone();
        if signature.0.is_some() {
            checked.api_key = signature.0.clone();
        }
        snapshot.request = ModelRequestSnapshot::capture(&checked)?;
        let secrets = signature.0.as_deref().into_iter().collect::<Vec<_>>();
        snapshot.proxy = settings
            .provider_proxy_url
            .as_deref()
            .map(|value| ModelEndpointSnapshot::capture(value, &secrets))
            .transpose()?;
        let bytes = serde_json::to_vec(&snapshot)?;
        anyhow::ensure!(
            bytes.len() <= 512 * 1024,
            "Model snapshot exceeds storage limit"
        );
        Ok(bytes)
    }

    pub(crate) fn capture_snapshot(
        &self,
        settings: &Settings,
        provider: &dyn Provider,
    ) -> Result<Vec<u8>> {
        let kind =
            ProviderKind::from_settings(settings)?.context("Model snapshot has no provider")?;
        let resolved = ProviderFactory::new(settings)
            .with_overrides(crate::provider_overrides_from_cli(&self.cli))
            .credential_resolution(kind);
        let key = resolved.as_ref().map(|(_, value)| value.clone().into_key());
        let secrets = key.as_deref().into_iter().collect::<Vec<_>>();
        let mut checked = settings.clone();
        if key.is_some() {
            checked.api_key = key.clone();
        }
        let authentication = settings
            .active_provider
            .as_ref()
            .and_then(|id| settings.providers.get(id))
            .map(|profile| profile.authentication.clone())
            .unwrap_or_default();
        anyhow::ensure!(
            !authentication.is_api_key() || resolved.is_some() || kind == ProviderKind::Local,
            "Model snapshot requires a resolved credential authority"
        );
        let credential = resolved.map(|(selector, value)| CredentialBinding {
            selector,
            credential_file: (value.source == ProviderApiKeySource::CredentialFile)
                .then(|| self.cli.credential_env_file.clone())
                .flatten(),
            source: value.source,
        });
        if let Some(agent) = &settings.openai_user_agent {
            anyhow::ensure!(
                !secrets.iter().any(|key| agent.contains(key)),
                "Model user agent contains credential material"
            );
        }
        let snapshot = Snapshot {
            version: 1,
            request: ModelRequestSnapshot::capture(&checked)?,
            kind: kind.as_str().into(),
            profile: settings.active_provider.clone(),
            provider_selector: settings.provider.clone(),
            credential_env: settings
                .active_provider
                .as_ref()
                .and_then(|id| settings.providers.get(id))
                .map(|profile| profile.credential_env.clone())
                .unwrap_or_default(),
            selection: settings.active_model_selection.clone(),
            format: settings.api_format.unwrap_or(match kind {
                ProviderKind::Anthropic | ProviderKind::Kunlunmeta => ApiFormat::AnthropicMessages,
                ProviderKind::Gemini => ApiFormat::GeminiGenerateContent,
                _ => ApiFormat::OpenaiChatCompletions,
            }),
            authentication,
            chat_protocol: settings.provider_chat_protocol,
            endpoint: ModelEndpointSnapshot::capture(
                provider
                    .endpoint()
                    .context("Provider has no snapshot endpoint")?,
                &secrets,
            )?,
            proxy: settings
                .provider_proxy_url
                .as_deref()
                .map(|url| ModelEndpointSnapshot::capture(url, &secrets))
                .transpose()?,
            no_proxy: settings.provider_no_proxy,
            timeout: provider.request_timeout_secs(),
            user_agent: settings.openai_user_agent.clone(),
            credential,
        };
        let bytes = serde_json::to_vec(&snapshot)?;
        anyhow::ensure!(
            bytes.len() <= 512 * 1024,
            "Model snapshot exceeds storage limit"
        );
        Ok(bytes)
    }

    pub(crate) fn restore_snapshot(&self, bytes: &[u8]) -> Result<(Settings, Arc<dyn Provider>)> {
        self.restore_snapshot_with_proxy(bytes, None)
    }

    /// Current proxy credentials are supplied in memory and are never written back into the snapshot.
    pub(crate) fn restore_snapshot_with_proxy(
        &self,
        bytes: &[u8],
        current_proxy: Option<String>,
    ) -> Result<(Settings, Arc<dyn Provider>)> {
        self.restore_snapshot_transport(bytes, current_proxy, false)
    }

    pub(crate) fn restore_snapshot_with_proxy_override(
        &self,
        bytes: &[u8],
        proxy_url: &str,
    ) -> Result<(Settings, Arc<dyn Provider>)> {
        let proxy = proxy_url.trim();
        anyhow::ensure!(
            proxy.len() <= 4096 && !proxy.chars().any(char::is_whitespace),
            "Invalid client proxy URL"
        );
        anyhow::ensure!(
            proxy.is_empty()
                || ["http://", "https://", "socks5://"]
                    .iter()
                    .any(|scheme| proxy.starts_with(scheme)),
            "Invalid client proxy scheme"
        );
        self.restore_snapshot_transport(bytes, Some(proxy.into()), true)
    }

    fn restore_snapshot_transport(
        &self,
        bytes: &[u8],
        current_proxy: Option<String>,
        replace_proxy: bool,
    ) -> Result<(Settings, Arc<dyn Provider>)> {
        anyhow::ensure!(
            bytes.len() <= 512 * 1024,
            "Model snapshot exceeds storage limit"
        );
        let mut snapshot: Snapshot =
            serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid model snapshot"))?;
        anyhow::ensure!(snapshot.version == 1, "Unsupported model snapshot version");
        if replace_proxy {
            snapshot.proxy = current_proxy
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|value| ModelEndpointSnapshot::capture(value, &[]))
                .transpose()?;
        }
        let (settings, overrides, signature) =
            self.materialize_snapshot(&snapshot, current_proxy.as_deref())?;
        let kind = ProviderKind::parse(&snapshot.kind).context("Invalid snapshot provider kind")?;
        let provider = ProviderFactory::new(&settings)
            .with_overrides(overrides)
            .build(kind, &settings.model)?;
        let cache = std::sync::Mutex::new((signature, provider.clone()));
        let source = self.clone();
        let resolver = Arc::new(move || {
            let (settings, overrides, signature) = source
                .materialize_snapshot(&snapshot, current_proxy.as_deref())
                .map_err(|_| credential_provider::unavailable())?;
            let mut cache = cache
                .lock()
                .map_err(|_| credential_provider::unavailable())?;
            if cache.0 != signature {
                cache.1 = ProviderFactory::new(&settings)
                    .with_overrides(overrides)
                    .build(kind, &settings.model)
                    .map_err(|_| credential_provider::unavailable())?;
                cache.0 = signature;
            }
            Ok(cache.1.clone())
        });
        Ok((
            settings,
            Arc::new(credential_provider::CredentialProvider::new(
                provider, resolver,
            )),
        ))
    }

    fn materialize_snapshot(
        &self,
        snapshot: &Snapshot,
        current_proxy: Option<&str>,
    ) -> Result<(
        Settings,
        ProviderBuildOverrides,
        (Option<String>, String, Option<String>),
    )> {
        let kind = ProviderKind::parse(&snapshot.kind).context("Invalid snapshot provider kind")?;
        let mut current = self.loader.load()?.settings;
        let cli = crate::provider_overrides_from_cli(&self.cli);
        let key = if let Some(binding) = &snapshot.credential {
            if binding.source == ProviderApiKeySource::CredentialFile {
                anyhow::ensure!(
                    binding.credential_file == self.cli.credential_env_file,
                    "Credential file authority changed"
                );
                anyhow::ensure!(
                    binding.credential_file.is_some(),
                    "Missing credential file reference"
                );
            }
            if let Some(path) = self.cli.credential_env_file.as_deref() {
                // A newly supplied higher-priority file is also an authority
                // change; do not silently ignore it to keep a Stored binding.
                crate::apply_credential_env_file(&mut current, path)?;
            }
            Some(
                current
                    .resolve_bound_provider_api_key(
                        Some(&binding.selector),
                        explicit_key(&cli, kind),
                        &binding.source,
                    )?
                    .into_key(),
            )
        } else {
            None
        };
        // Reapply the original profile before resolving address credentials: the current
        // default may now belong to another model. CLI/legacy endpoint precedence must
        // remain identical to ordinary Provider construction.
        let mut endpoint_settings = current.clone();
        if let Some(profile) = &snapshot.profile {
            endpoint_settings.active_provider = Some(profile.clone());
            endpoint_settings.base_url = current.providers.get(profile).map(|p| p.endpoint.clone());
        }
        let current_endpoint = ProviderFactory::new(&endpoint_settings)
            .with_overrides(cli.clone())
            .endpoint_override(kind);
        let endpoint = snapshot.endpoint.restore(current_endpoint.as_deref())?;
        let proxy = snapshot
            .proxy
            .as_ref()
            .map(|proxy| proxy.restore(current_proxy.or(current.provider_proxy_url.as_deref())))
            .transpose()?;
        snapshot.request.apply_to(&mut current);
        current.active_provider = snapshot.profile.clone();
        current.provider = snapshot
            .provider_selector
            .clone()
            .or_else(|| Some(snapshot.kind.clone()));
        current.api_format = Some(snapshot.format);
        current.active_model_selection = snapshot.selection.clone();
        current.provider_chat_protocol = snapshot.chat_protocol;
        current.base_url = Some(endpoint.clone());
        current.anthropic_base_url = Some(endpoint.clone());
        current.openai_base_url = Some(endpoint.clone());
        current.local_base_url = Some(endpoint.clone());
        current.gemini_base_url = Some(endpoint.clone());
        current.grok_base_url = Some(endpoint.clone());
        current.kunlunmeta_base_url = Some(endpoint.clone());
        current.provider_no_proxy = snapshot.no_proxy;
        current.provider_proxy_url = proxy.clone();
        current.request_timeout_secs = snapshot.timeout;
        current.openai_user_agent = snapshot.user_agent.clone();
        if let Some(id) = &snapshot.profile {
            current.providers.insert(
                id.clone(),
                ProviderConfig {
                    reasoning_policy: current.model_reasoning_policy.clone(),
                    endpoint: endpoint.clone(),
                    api_format: snapshot.format,
                    authentication: snapshot.authentication.clone(),
                    default_model: current.model.clone(),
                    models: BTreeMap::new(),
                    credential_env: snapshot.credential_env.clone(),
                    discover_models: Some(false),
                    capabilities: current.model_capabilities.clone(),
                    reasoning_effort: current.model_reasoning_effort.clone(),
                    context_window_tokens: current.context_window_tokens.unwrap_or(128000),
                    auto_compact_threshold_tokens: current.auto_compact_threshold_tokens,
                    output_headroom_tokens: current.context_output_headroom.unwrap_or(1024),
                    max_output_tokens: current.max_tokens.unwrap_or(1024),
                    request_timeout_secs: snapshot.timeout,
                    user_agent: snapshot.user_agent.clone(),
                    max_retries: Some(current.max_retries),
                    retry_base_delay_ms: Some(current.retry_base_delay_ms),
                    no_proxy: snapshot.no_proxy,
                    chat_protocol: snapshot.chat_protocol,
                    extra_body: current.provider_extra_body.clone(),
                },
            );
        }
        let effective_key = key
            .clone()
            .or_else(|| (kind == ProviderKind::Local).then(|| "not-set".into()));
        let overrides = ProviderBuildOverrides {
            api_key: effective_key.clone(),
            openai_api_key: effective_key.clone(),
            local_api_key: effective_key.clone(),
            gemini_api_key: effective_key.clone(),
            grok_api_key: effective_key,
            base_url: Some(endpoint.clone()),
            openai_base_url: Some(endpoint.clone()),
            local_base_url: Some(endpoint.clone()),
            openai_user_agent: snapshot.user_agent.clone(),
        };
        Ok((current, overrides, (key, endpoint, proxy)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use futures::StreamExt;
    use kcoder_engine::ClientModelConfiguration;

    #[tokio::test]
    async fn rebuild_freezes_semantics_and_revalidates_the_bound_credential() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        std::fs::create_dir(&config).unwrap();
        let settings_path = config.join("settings.json");
        let credentials_path = config.join("credentials.json");
        let mut document = serde_json::json!({"active_provider":"fixture", "providers":{"fixture":{
            "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1", "default_model":"original-model",
            "credential_env":["SNAPSHOT_FIXTURE_API_KEY"],
            "context_window_tokens":128000, "output_headroom_tokens":1024, "max_output_tokens":1024,
            "no_proxy":true, "extra_body":{"temperature":0.2}
        }}});
        std::fs::write(&settings_path, document.to_string()).unwrap();
        std::fs::write(
            &credentials_path,
            r#"{"fixture":{"type":"api","key":"original-private-fixture"}}"#,
        )
        .unwrap();
        let source = ModelConfiguration::new(
            SettingsLoader::new(temp.path())
                .with_config_dir(&config)
                .with_executable_dir(temp.path()),
            crate::Cli::parse_from(["kcoder"]),
        );
        let settings = source.settings("fixture").unwrap();
        // CLI URLs can contain credentials independently of the API key. Read
        // rotated slots from the same address, never persist or redirect them.
        let mut cli_source = source.clone();
        cli_source.cli.openai_base_url = Some("http://127.0.0.1:3/v1?token=old-url-token".into());
        let cli_provider = cli_source.provider(&settings).unwrap();
        let cli_snapshot = cli_source
            .capture_snapshot(&settings, cli_provider.as_ref())
            .unwrap();
        assert!(!String::from_utf8_lossy(&cli_snapshot).contains("old-url-token"));
        cli_source.cli.openai_base_url = Some("http://127.0.0.1:3/v1?token=new-url-token".into());
        let (_, rotated_url_provider) = cli_source.restore_snapshot(&cli_snapshot).unwrap();
        assert_eq!(
            rotated_url_provider.endpoint(),
            Some("http://127.0.0.1:3/v1?token=new-url-token")
        );
        cli_source.cli.openai_base_url = Some("http://127.0.0.1:4/v1?token=new-url-token".into());
        assert!(cli_source.restore_snapshot(&cli_snapshot).is_err());
        cli_source.cli.openai_base_url = None;
        assert!(cli_source.restore_snapshot(&cli_snapshot).is_err());
        let provider = source.provider(&settings).unwrap();
        let bytes = source
            .capture_snapshot(&settings, provider.as_ref())
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("original-private-fixture"));
        let mut proxied = settings.clone();
        proxied.provider_proxy_url = Some("http://old-user:old-password@127.0.0.1:9000".into());
        let proxy_snapshot = source
            .capture_snapshot(&proxied, provider.as_ref())
            .unwrap();
        assert!(!String::from_utf8_lossy(&proxy_snapshot).contains("old-password"));
        assert!(source.restore_snapshot(&proxy_snapshot).is_err());
        assert!(
            source
                .restore_snapshot_with_proxy(
                    &proxy_snapshot,
                    Some("http://new-user:new-password@127.0.0.1:9001".into())
                )
                .is_err()
        );
        let (with_proxy, _) = source
            .restore_snapshot_with_proxy(
                &proxy_snapshot,
                Some("http://new-user:new-password@127.0.0.1:9000".into()),
            )
            .unwrap();
        assert!(
            with_proxy.provider_proxy_url.as_deref()
                == Some("http://new-user:new-password@127.0.0.1:9000/")
        );
        let (direct, _) = source
            .restore_snapshot_with_proxy_override(&proxy_snapshot, "")
            .unwrap();
        assert!(direct.provider_proxy_url.is_none());
        let (replaced, _) = source
            .restore_snapshot_with_proxy_override(
                &proxy_snapshot,
                "http://replacement:current-password@127.0.0.1:9001",
            )
            .unwrap();
        assert!(
            replaced.provider_proxy_url.as_deref()
                == Some("http://replacement:current-password@127.0.0.1:9001/")
        );
        assert!(
            source
                .restore_snapshot_with_proxy_override(&proxy_snapshot, "ftp://127.0.0.1:9001")
                .is_err()
        );
        document["providers"]["fixture"]["default_model"] = serde_json::json!("new-default");
        document["providers"]["fixture"]["endpoint"] = serde_json::json!("http://127.0.0.1:2/v1");
        document["providers"]["fixture"]["extra_body"] = serde_json::json!({"temperature":0.9});
        std::fs::write(&settings_path, document.to_string()).unwrap();
        std::fs::write(
            &credentials_path,
            r#"{"fixture":{"type":"api","key":"rotated-private-fixture"}}"#,
        )
        .unwrap();
        let (restored, provider) = source.restore_snapshot(&bytes).unwrap();
        assert_eq!(restored.model, "original-model");
        assert_eq!(restored.provider_extra_body["temperature"], 0.2);
        assert_eq!(provider.endpoint(), Some("http://127.0.0.1:1/v1"));
        let mut resumed_source = source.clone();
        let env_file = temp.path().join("new-credential.env");
        std::fs::write(&env_file, "SNAPSHOT_FIXTURE_API_KEY=new-file-credential\n").unwrap();
        resumed_source.cli.credential_env_file = Some(env_file);
        assert!(resumed_source.restore_snapshot(&bytes).is_err());
        resumed_source.cli.credential_env_file = None;
        resumed_source.cli.openai_base_url = Some("http://127.0.0.1:2/v1".into());
        let mut adjusted = restored.clone();
        adjusted
            .provider_extra_body
            .insert("service_tier".into(), serde_json::json!("priority"));
        assert_eq!(
            resumed_source.provider(&adjusted).unwrap().endpoint(),
            Some("http://127.0.0.1:2/v1")
        );
        let refrozen = resumed_source.refreeze_snapshot(&bytes, &adjusted).unwrap();
        let (adjusted, pinned_provider) = resumed_source.restore_snapshot(&refrozen).unwrap();
        assert_eq!(pinned_provider.endpoint(), Some("http://127.0.0.1:1/v1"));
        assert_eq!(adjusted.provider_extra_body["service_tier"], "priority");
        let snapshot: Snapshot = serde_json::from_slice(&bytes).unwrap();
        assert!(
            source
                .materialize_snapshot(&snapshot, None)
                .unwrap()
                .2
                .0
                .as_deref()
                == Some("rotated-private-fixture")
        );
        std::fs::write(&credentials_path, r#"{"fixture":{"type":"revoked"}}"#).unwrap();
        assert!(source.restore_snapshot(&bytes).is_err());
        let mut stream = provider
            .stream_messages(kcoder_types::MessagesRequest::new(
                "original-model",
                vec![kcoder_types::Message::user_text("fixture")],
            ))
            .unwrap();
        let error = stream.next().await.unwrap().err().unwrap();
        assert!(
            matches!(error, kcoder_api::ApiErrorKind::Api { error_type, .. } if error_type == "authentication_error")
        );
    }
}
