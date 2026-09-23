//! Shared model construction and credential refresh for CLI and app-server sessions.
use anyhow::{Context, Result};
use kcoder_api::{MissingApiKeyError, Provider, ProviderFactory, ProviderKind};
use kcoder_config::{Settings, SettingsLoader};
use std::sync::Arc;
mod credential_provider;
mod snapshot;

#[derive(Clone)]
pub(crate) struct ModelConfiguration {
    loader: SettingsLoader,
    cli: crate::Cli,
}

impl ModelConfiguration {
    pub(crate) fn new(loader: SettingsLoader, cli: crate::Cli) -> Self {
        Self { loader, cli }
    }

    fn selected_settings(&self, selection: &str, with_sources: bool) -> Result<(Settings, std::collections::BTreeMap<String, std::collections::BTreeSet<String>>)> {
        let loaded = self.loader.load()?;
        let mut settings = loaded.settings;
        let mut cli = self.cli.clone();
        if selection.contains("::") {
            cli.profile = None;
            cli.provider = None;
            cli.model = Some(selection.into());
        } else if settings.providers.contains_key(selection) {
            cli.profile = Some(selection.into());
            cli.provider = None;
            cli.model = None;
        } else {
            cli.model = Some(selection.into());
        }
        crate::apply_cli_settings_overrides(&mut settings, &cli)?;
        loaded.model_runtime_overrides.apply(&mut settings)?;
        // Explicit CLI values remain above file/overlay values, without changing
        // the already resolved session model selection a second time.
        cli.profile = None;
        cli.provider = None;
        cli.model = None;
        crate::apply_cli_settings_overrides(&mut settings, &cli)?;
        if let Some(path) = cli.credential_env_file.as_deref() {
            crate::apply_credential_env_file(&mut settings, path)?;
        }
        let fields = if with_sources { self.sources_from_read(&loaded.model_configuration_sources, &settings)? } else { Default::default() };
        Ok((settings, fields))
    }

    fn sources_from_read(&self, sources: &kcoder_config::ModelConfigurationSources, settings: &Settings) -> Result<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>> {
        let mut fields = match settings.active_provider.as_deref().and_then(|id| settings.providers.get(id).map(|profile| (id, profile))) {
            Some((id, profile)) => sources.model_fields(id, profile, &settings.model)?,
            None => Default::default(),
        };
        if self.cli.max_tokens.is_some() {
            fields.insert("max_output_tokens".into(), ["cli_environment".into()].into());
        }
        // Cli values may originate in clap's environment bindings; do not label
        // them as specifically argv values after that distinction has been erased.
        let kind = ProviderKind::from_settings(settings)?;
        if let Some(kind) = kind {
            let factory = ProviderFactory::new(settings).with_overrides(crate::provider_overrides_from_cli(&self.cli));
            match factory.endpoint_source(kind) {
                Some("configuration") if self.cli.base_url.as_deref().is_some_and(|value| !value.trim().is_empty()) => {
                    fields.insert("endpoint".into(), ["cli_environment".into()].into());
                }
                Some(source @ ("cli_environment" | "environment" | "default")) => {
                    fields.insert("endpoint".into(), [source.into()].into());
                }
                _ => {}
            }
        }
        Ok(fields)
    }

    pub(crate) fn provider_for_kind(
        &self,
        settings: &Settings,
        kind: ProviderKind,
    ) -> Result<Arc<dyn Provider>> {
        match ProviderFactory::new(settings)
            .with_overrides(crate::provider_overrides_from_cli(&self.cli))
            .build(kind, &settings.model)
        {
            Ok(provider) => self.with_live_credentials(settings, kind, provider),
            Err(error) if error.downcast_ref::<MissingApiKeyError>().is_some() => {
                Ok(Arc::new(crate::SignedOutProvider {
                    name: kind.as_str(),
                    error_message: error.to_string(),
                }))
            }
            Err(error) => Err(error).context("Cannot initialize the new conversation provider"),
        }
    }

    pub(crate) fn with_live_credentials(
        &self,
        settings: &Settings,
        kind: ProviderKind,
        provider: Arc<dyn Provider>,
    ) -> Result<Arc<dyn Provider>> {
        let overrides = crate::provider_overrides_from_cli(&self.cli);
        let Some((selector, original)) = ProviderFactory::new(settings)
            .with_overrides(overrides.clone())
            .credential_resolution(kind)
        else {
            return Ok(provider);
        };
        let source = original.source.clone();
        let snapshot = settings.clone();
        let loader = self.loader.clone();
        let env_file = self.cli.credential_env_file.clone();
        let cache = std::sync::Mutex::new((original, provider.clone()));
        let resolver = Arc::new(move || {
            let mut current = snapshot.clone();
            if !matches!(source, kcoder_config::ProviderApiKeySource::Explicit | kcoder_config::ProviderApiKeySource::CredentialFile) {
                loader
                    .refresh_stored_provider_credentials(&mut current)
                    .map_err(|_| credential_provider::unavailable())?;
            }
            if source == kcoder_config::ProviderApiKeySource::CredentialFile {
                current.credential_overrides.clear();
                let path = env_file
                    .as_deref()
                    .ok_or_else(credential_provider::unavailable)?;
                crate::apply_credential_env_file(&mut current, path)
                    .map_err(|_| credential_provider::unavailable())?;
            }
            let factory = ProviderFactory::new(&current).with_overrides(overrides.clone());
            let (_, credential) = factory
                .credential_resolution(kind)
                .filter(|(id, credential)| id == &selector && credential.source == source)
                .ok_or_else(credential_provider::unavailable)?;
            let mut cached = cache
                .lock()
                .map_err(|_| credential_provider::unavailable())?;
            if cached.0 != credential {
                let replacement = factory
                    .build(kind, &current.model)
                    .map_err(|_| credential_provider::unavailable())?;
                *cached = (credential, replacement);
            }
            Ok(cached.1.clone())
        });
        Ok(Arc::new(credential_provider::CredentialProvider::new(
            provider, resolver,
        )))
    }
}

impl kcoder_engine::ClientModelConfiguration for ModelConfiguration {
    fn snapshot_api_format(&self, snapshot: &[u8]) -> Result<Option<kcoder_config::ApiFormat>> { self.snapshot_format(snapshot) }

    fn freeze_model(&self, settings: &Settings, provider: &dyn Provider) -> Result<Option<Vec<u8>>> {
        self.capture_snapshot(settings, provider).map(Some)
    }

    fn thaw_model(&self, snapshot: &[u8], proxy_credentials: Option<String>) -> Result<(Settings, Arc<dyn Provider>)> {
        self.restore_snapshot_with_proxy(snapshot, proxy_credentials)
    }

    fn refreeze_model(&self, snapshot: &[u8], settings: &Settings) -> Result<Vec<u8>> {
        self.refreeze_snapshot(snapshot, settings)
    }

    fn thaw_model_with_proxy_override(&self, snapshot: &[u8], proxy_url: &str) -> Result<(Settings, Arc<dyn Provider>)> {
        self.restore_snapshot_with_proxy_override(snapshot, proxy_url)
    }

    fn supports_default_selection(&self) -> bool { true }

    fn default_settings(&self) -> Result<Option<Settings>> {
        let loaded = self.loader.load()?;
        let mut settings = loaded.settings;
        // Unlike catalog discovery, a default resolves through the original
        // session CLI overrides as well as its frozen template overlays.
        crate::apply_cli_settings_overrides(&mut settings, &self.cli)?;
        loaded.model_runtime_overrides.apply(&mut settings)?;
        let mut non_selection_cli = self.cli.clone();
        non_selection_cli.profile = None;
        non_selection_cli.provider = None;
        non_selection_cli.model = None;
        crate::apply_cli_settings_overrides(&mut settings, &non_selection_cli)?;
        if let Some(path) = self.cli.credential_env_file.as_deref() {
            crate::apply_credential_env_file(&mut settings, path)?;
        }
        Ok(Some(settings))
    }

    fn configuration_file_sources(&self) -> Result<Option<Vec<kcoder_config::ModelConfigurationFieldSources>>> {
        let loaded = self.loader.load()?;
        let mut sources = Vec::new();
        for (id, profile) in &loaded.settings.providers {
            for model in profile.model_profiles().keys() {
                sources.push(kcoder_config::ModelConfigurationFieldSources {
                    provider: id.clone(), model: model.clone(),
                    fields: loaded.model_configuration_sources.model_fields(id, profile, model)?,
                });
            }
        }
        Ok(Some(sources))
    }

    fn configuration_runtime_sources(&self, settings: &Settings) -> Result<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>> {
        self.sources_from_read(&self.loader.load()?.model_configuration_sources, settings)
    }

    fn catalog_settings(&self) -> Result<Option<Settings>> {
        let loaded = self.loader.load()?;
        let mut settings = loaded.settings;
        let mut cli = self.cli.clone();
        // A deleted conversation selection must not prevent listing replacements.
        // Explicit overlays remain pinned in the session's loader.
        cli.profile = None;
        cli.provider = None;
        cli.model = None;
        crate::apply_cli_settings_overrides(&mut settings, &cli)?;
        if let Some(path) = cli.credential_env_file.as_deref() {
            crate::apply_credential_env_file(&mut settings, path)?;
        }
        Ok(Some(settings))
    }

    fn settings(&self, selection: &str) -> Result<Settings> {
        self.selected_settings(selection, false).map(|(settings, _)| settings)
    }

    fn settings_with_sources(&self, selection: &str) -> Result<(Settings, std::collections::BTreeMap<String, std::collections::BTreeSet<String>>)> {
        self.selected_settings(selection, true)
    }

    fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>> {
        let kind =
            ProviderKind::from_settings(settings)?.context("Selected model has no provider")?;
        self.provider_for_kind(settings, kind)
    }
}

#[cfg(test)]
mod default_selection_tests {
    use super::*;
    use clap::Parser;
    use kcoder_engine::ClientModelConfiguration;

    #[test]
    fn object_overlays_apply_to_default_and_explicit_models_without_copying_old_model_fields() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        std::fs::create_dir(&config).unwrap();
        let profile = |model: &str, body: serde_json::Value| {
            serde_json::json!({
                "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1",
                "default_model":model, "context_window_tokens":32000,
                "max_output_tokens":1024,"output_headroom_tokens":1024,
                "capabilities":{"tools":true,"vision":true}, "extra_body":body
            })
        };
        std::fs::write(
            config.join("settings.json"),
            serde_json::json!({
                "active_provider":"a", "providers": {
                    "a":profile("model-a", serde_json::json!({"temperature":0.1,"seed":11})),
                    "b":profile("model-b", serde_json::json!({"temperature":0.2,"top_p":0.8}))
                }
            })
            .to_string(),
        )
        .unwrap();
        let overlay = temp.path().join("template.json");
        std::fs::write(
            &overlay,
            r#"{"provider_extra_body":{"temperature":0.7},"model_capabilities":{"tools":false}}"#,
        )
        .unwrap();
        let source = ModelConfiguration::new(
            SettingsLoader::new(temp.path())
                .with_config_dir(config)
                .with_executable_dir(temp.path())
                .with_overlay_files([overlay])
                .freeze_overlays()
                .unwrap(),
            crate::Cli::parse_from(["kcoder"]),
        );
        let default = source.default_settings().unwrap().unwrap();
        assert_eq!(default.provider_extra_body["temperature"], 0.7);
        assert_eq!(default.provider_extra_body["seed"], 11);
        let selected = source.settings("b::model-b").unwrap();
        assert_eq!(selected.provider_extra_body["temperature"], 0.7);
        assert_eq!(selected.provider_extra_body["top_p"], 0.8);
        assert!(!selected.provider_extra_body.contains_key("seed"));
        assert!(!selected.model_capabilities.tools);
        assert!(selected.model_capabilities.vision);
    }

    #[test]
    fn target_default_reloads_but_frozen_overlay_and_cli_selections_remain_authoritative() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config");
        std::fs::create_dir(&config).unwrap();
        let path = config.join("settings.json");
        let profile = |model: &str| serde_json::json!({
            "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1",
            "default_model":model, "context_window_tokens":32000,
            "max_output_tokens":1024,"output_headroom_tokens":1024
        });
        let mut document = serde_json::json!({"active_provider":"a","providers":{
            "a":profile("model-a"),"b":profile("model-b")
        }});
        std::fs::write(&path, document.to_string()).unwrap();
        let loader = SettingsLoader::new(temp.path()).with_config_dir(&config)
            .with_executable_dir(temp.path());
        let live = ModelConfiguration::new(loader.clone(), crate::Cli::parse_from(["kcoder"]));
        assert_eq!(live.default_settings().unwrap().unwrap().model, "model-a");
        let overlay = temp.path().join("template.json");
        std::fs::write(&overlay, r#"{"active_provider":"a","max_tokens":128}"#).unwrap();
        let pinned = ModelConfiguration::new(loader.clone().with_overlay_files([overlay.clone()]).freeze_overlays().unwrap(),
            crate::Cli::parse_from(["kcoder"]));
        document["active_provider"] = serde_json::json!("b");
        std::fs::write(&path, document.to_string()).unwrap();
        std::fs::write(&overlay, r#"{"active_provider":"b","max_tokens":256}"#).unwrap();
        assert_eq!(live.default_settings().unwrap().unwrap().model, "model-b");
        let frozen = pinned.default_settings().unwrap().unwrap();
        assert_eq!(frozen.model, "model-a");
        assert_eq!(frozen.max_tokens, Some(128));
        let explicit = ModelConfiguration::new(loader, crate::Cli::parse_from(["kcoder", "--model", "a::model-a"]));
        assert_eq!(explicit.default_settings().unwrap().unwrap().model, "model-a");
    }
}

#[cfg(test)]
mod summary_source_tests {
    use super::*;
    use clap::Parser;
    use kcoder_engine::ClientModelConfiguration;
    #[test]
    fn catalog_availability_uses_the_same_explicit_credential_as_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("profile");
        std::fs::create_dir(&config).unwrap();
        std::fs::write(config.join("settings.json"), serde_json::json!({
            "active_provider":"test", "providers":{"test":{
                "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1",
                "default_model":"model", "context_window_tokens":32000,
                "max_output_tokens":1024,"output_headroom_tokens":1024
            }}
        }).to_string()).unwrap();
        std::fs::write(config.join("credentials.json"), r#"{"test":{"type":"revoked"}}"#).unwrap();
        let loader = SettingsLoader::new(temp.path()).with_config_dir(&config);
        let source = ModelConfiguration::new(loader, crate::Cli::try_parse_from(["kcoder", "--openai-api-key", "synthetic-explicit-key"]).unwrap());
        let settings = source.settings("test::model").unwrap();
        assert_eq!(source.provider(&settings).unwrap().api_key_configured(), Some(true));
        let profiles = kcoder_engine::QueryEngine::configured_model_profiles_with_source(&settings, &source).unwrap();
        assert!(profiles[0].available, "catalog incorrectly discarded the explicit CLI credential");
        assert!(profiles[0].error.is_none());
    }

    #[test]
    fn next_turn_summary_resolves_cli_over_file_model_limits() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("profile");
        std::fs::create_dir(&config).unwrap();
        std::fs::write(config.join("settings.json"), serde_json::json!({
            "active_provider":"test", "providers":{"test":{
                "api_format":"openai_chat_completions", "endpoint":"http://127.0.0.1:1/v1",
                "authentication":{"mode":"none"}, "default_model":"model", "context_window_tokens":32000,
                "max_output_tokens":1024,"output_headroom_tokens":1024
            }}
        }).to_string()).unwrap();
        let loader = SettingsLoader::new(temp.path()).with_config_dir(&config);
        let source = ModelConfiguration::new(loader, crate::Cli::try_parse_from(["kcoder", "--max-tokens", "2048"]).unwrap());
        let settings = source.settings("test::model").unwrap();
        let profiles = kcoder_engine::QueryEngine::configured_model_profiles_with_source(&settings, &source).unwrap();
        let summary = profiles[0].configuration.as_ref().unwrap();
        assert_eq!(summary.max_output_tokens, Some(2048));
        assert!(summary.sources["max_output_tokens"].contains("cli_environment"));
        assert!(summary.sources["context_window_tokens"].contains("user"));
    }
}
