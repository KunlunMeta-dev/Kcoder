//! Host-injected model refresh at an idle client turn boundary.
use super::*;
use kcoder_types::{ModelSelectionMode, ReasoningEffort};
mod continuation;
pub use continuation::ClientModelContinuationOptions;

/// A session owns this source. Hosts preserve its template/CLI overlay identity.
pub trait ClientModelConfiguration: Send + Sync {
    fn settings(&self, selection: &str) -> Result<Settings>;
    fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>>;
    /// Resolve values and provenance from one host configuration read. Older hosts
    /// report no provenance rather than joining labels from a later file version.
    fn settings_with_sources(&self, selection: &str) -> Result<(Settings, std::collections::BTreeMap<String, std::collections::BTreeSet<String>>)> {
        Ok((self.settings(selection)?, Default::default()))
    }
    /// Resolve the current target default with this session's pinned overlays.
    /// None means the host does not support an explicit follow-default selection.
    fn default_settings(&self) -> Result<Option<Settings>> { Ok(None) }
    /// Capability declaration must not perform configuration IO during initialize.
    fn supports_default_selection(&self) -> bool { false }
    /// Read the session-bound catalog without changing its running model snapshot.
    fn catalog_settings(&self) -> Result<Option<Settings>> { Ok(None) }
    /// File-layer provenance without configuration values; None is an older host.
    fn configuration_file_sources(&self) -> Result<Option<Vec<kcoder_config::ModelConfigurationFieldSources>>> { Ok(None) }

    /// Authority labels for already-resolved model fields; no environment values.
    fn configuration_runtime_sources(&self, _settings: &Settings) -> Result<std::collections::BTreeMap<String, std::collections::BTreeSet<String>>> { Ok(Default::default()) }

    /// Host-defined credential-free model semantics; None denotes unsupported providers.
    fn snapshot_api_format(&self, _snapshot: &[u8]) -> Result<Option<kcoder_config::ApiFormat>> { Ok(None) }
    fn freeze_model(&self, _settings: &Settings, _provider: &dyn Provider) -> Result<Option<Vec<u8>>> { Ok(None) }
    fn thaw_model(&self, _snapshot: &[u8], _proxy_credentials: Option<String>) -> Result<(Settings, Arc<dyn Provider>)> {
        anyhow::bail!("This model source cannot restore durable snapshots")
    }
    fn refreeze_model(&self, _snapshot: &[u8], _settings: &Settings) -> Result<Vec<u8>> {
        anyhow::bail!("This model source cannot update a durable snapshot")
    }
    fn thaw_model_with_proxy_override(&self, _snapshot: &[u8], _proxy_url: &str) -> Result<(Settings, Arc<dyn Provider>)> {
        anyhow::bail!("This model source cannot override a snapshot proxy")
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DurableClientModel {
    version: u32,
    selection: String,
    mode: ModelSelectionMode,
    reasoning: Option<ReasoningEffort>,
    default_reasoning: Option<ReasoningEffort>,
    proxy_override: bool,
    service_tier: Option<String>,
    host: serde_json::Value,
}

fn decode_client_model(bytes: &[u8]) -> Result<DurableClientModel> {
    anyhow::ensure!(bytes.len() <= 512 * 1024, "Model snapshot exceeds storage limit");
    let snapshot: DurableClientModel = serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid client model snapshot"))?;
    anyhow::ensure!(snapshot.version == 1 && snapshot.host.is_object() && !snapshot.selection.trim().is_empty(), "Unsupported client model snapshot");
    Ok(snapshot)
}

#[derive(Clone, Default)]
pub(crate) struct ClientModelOptions {
    pub model_selection_mode: ModelSelectionMode,
    pub reasoning: Option<ReasoningEffort>,
    pub default_reasoning: Option<ReasoningEffort>,
    pub selection: Option<(Option<String>, String)>,
    pub proxy: Option<Option<String>>,
    pub service_tier: Option<String>,
    pub frozen_host: Option<Vec<u8>>,
}

impl ClientModelOptions {
    pub(crate) fn bind_model(&mut self, settings: &Settings) {
        let next = (settings.active_provider.clone(), settings.model.clone());
        if self.selection.as_ref().is_some_and(|old| old != &next) {
            // The proxy belongs to the conversation transport; reasoning and
            // service tier belong to the chosen model, including automatic switches.
            let proxy = self.proxy.clone();
            let model_selection_mode = self.model_selection_mode;
            *self = Self {
                proxy,
                model_selection_mode,
                default_reasoning: settings.model_reasoning_effort.clone(),
                ..Self::default()
            };
        }
        self.selection = Some(next);
    }
}

impl QueryEngine {
    pub fn model_configuration_file_sources(&self) -> Result<Option<Vec<kcoder_config::ModelConfigurationFieldSources>>> {
        match &self.client_model_configuration {
            Some(source) => source.configuration_file_sources(),
            None => Ok(None),
        }
    }

    pub fn active_model_configuration_summary(&self) -> Result<kcoder_types::ModelConfigurationSummary> {
        let settings = recover_read_lock(&self.settings, "settings").clone();
        let mut summary = crate::model_configuration_summary(&settings, kcoder_types::ModelConfigurationBoundary::SessionSnapshot)?;
        // Do not reload files for an active snapshot: the chosen model may have
        // been removed while its accepted turn is still completing.
        for field in ["endpoint", "api_format", "chat_protocol", "capabilities", "context_window_tokens", "max_output_tokens", "output_headroom_tokens", "reasoning_effort", "extra_body"] {
            summary.sources.insert(field.into(), ["session_snapshot".into()].into());
        }
        let options = recover_read_lock(&self.client_model_options, "client model options");
        if options.reasoning.is_some() {
            summary.sources.insert("reasoning_effort".into(), ["turn".into()].into());
        }
        Ok(summary)
    }

    /// Call under the owning session's execution gate, after explicit overrides.
    pub fn freeze_client_model(&self) -> Result<Option<Vec<u8>>> {
        let Some(source) = &self.client_model_configuration else { return Ok(None); };
        let provider = self.current_provider();
        if !provider.supports_client_runtime_reconfiguration() { return Ok(None); }
        let settings = recover_read_lock(&self.settings, "settings").clone();
        let options = recover_read_lock(&self.client_model_options, "client model options").clone();
        let host = if let Some(frozen) = &options.frozen_host {
            source.refreeze_model(frozen, &settings)?
        } else {
            let Some(host) = source.freeze_model(&settings, provider.as_ref())? else { return Ok(None); };
            host
        };
        let host: serde_json::Value = serde_json::from_slice(&host).map_err(|_| anyhow::anyhow!("Invalid host model snapshot"))?;
        anyhow::ensure!(host.is_object(), "Host model snapshot must be an object");
        let bytes = serde_json::to_vec(&DurableClientModel {
            version: 1, selection: canonical_selection(&settings, None)?, mode: options.model_selection_mode,
            reasoning: options.reasoning, default_reasoning: options.default_reasoning,
            proxy_override: options.proxy.is_some(), service_tier: options.service_tier, host,
        })?;
        anyhow::ensure!(bytes.len() <= 512 * 1024, "Model snapshot exceeds storage limit");
        Ok(Some(bytes))
    }

    /// Restore only after the caller verifies the parent attempt's accepted identity.
    /// Current permissions, tools and extensions remain owned by this runtime.
    pub fn thaw_client_model(&self, bytes: &[u8], proxy_credentials: Option<String>) -> Result<()> {
        self.thaw_client_model_with_mode(decode_client_model(bytes)?, proxy_credentials, None, None)
    }

    /// Resolve explicit changes relative to the failed model, not a new default.
    /// A deliberate replacement does not need the old provider's revoked key.
    pub fn prepare_client_model_from_snapshot(&self, bytes: &[u8], requested: Option<&str>, proxy_override: Option<&str>) -> Result<()> {
        self.prepare_client_model_continuation(bytes, ClientModelContinuationOptions {
            model: requested, proxy_url: proxy_override, ..Default::default()
        })
    }

    fn thaw_client_model_with_mode(&self, snapshot: DurableClientModel, proxy_credentials: Option<String>, mode: Option<ModelSelectionMode>, proxy_override: Option<&str>) -> Result<()> {
        let source = self.client_model_configuration.as_ref().context("Model snapshot restoration is unsupported")?;
        let previous = recover_read_lock(&self.settings, "settings").clone();
        let host = serde_json::to_vec(&snapshot.host)?;
        let (next, provider) = if let Some(proxy) = proxy_override {
            source.thaw_model_with_proxy_override(&host, proxy)?
        } else {
            source.thaw_model(&host, proxy_credentials.or_else(|| previous.provider_proxy_url.clone()))?
        };
        anyhow::ensure!(canonical_selection(&next, None)? == snapshot.selection, "Restored model selection does not match the snapshot");
        let options = ClientModelOptions {
            model_selection_mode: mode.unwrap_or(snapshot.mode), reasoning: snapshot.reasoning,
            default_reasoning: snapshot.default_reasoning,
            selection: Some((next.active_provider.clone(), next.model.clone())),
            proxy: (snapshot.proxy_override || proxy_override.is_some()).then(|| next.provider_proxy_url.clone()),
            service_tier: snapshot.service_tier,
            frozen_host: Some(serde_json::to_vec(&snapshot.host)?),
        };
        self.state.set_model_selection(options.model_selection_mode, Some(snapshot.selection))?;
        *recover_write_lock(&self.provider, "provider") = provider;
        *recover_write_lock(&self.settings, "settings") = retained_model_fields(previous, &next);
        *recover_write_lock(&self.client_model_options, "client model options") = options;
        Ok(())
    }

    pub fn with_client_model_configuration(
        mut self,
        source: Arc<dyn ClientModelConfiguration>,
    ) -> Self {
        self.client_model_configuration = Some(source);
        recover_write_lock(&self.client_model_options, "client model options").model_selection_mode = self.state.model_selection_mode();
        self
    }

    /// Forked private conversations retain their source's model configuration
    /// identity, but must not share mutable client option selections.
    pub fn with_client_model_configuration_from(mut self, source: &Self) -> Self {
        self.client_model_configuration = source.client_model_configuration.clone();
        self.client_model_options = Arc::new(RwLock::new(
            recover_read_lock(&source.client_model_options, "client model options").clone(),
        ));
        self
    }

    /// A continuation is still the same logical turn: keep its semantic snapshot
    /// unless the caller explicitly chooses a different model.
    pub fn prepare_client_model_for_turn(
        &self,
        requested: Option<&str>,
        continuing: bool,
    ) -> Result<()> {
        if continuing {
            let settings = recover_read_lock(&self.settings, "settings");
            if canonical_selection(&settings, requested)? == canonical_selection(&settings, None)? {
                if requested.is_some() {
                    self.state.set_model_selection_mode(ModelSelectionMode::Explicit)?;
                    recover_write_lock(&self.client_model_options, "client model options").model_selection_mode = ModelSelectionMode::Explicit;
                }
                return Ok(());
            }
        }
        if requested.is_none() && self.follows_target_default_model() {
            return self.refresh_client_default_model_configuration();
        }
        self.refresh_client_model_configuration(requested)
    }

    pub fn supports_target_default_model_selection(&self) -> bool {
        self.current_provider().supports_client_runtime_reconfiguration()
            && self.client_model_configuration.as_ref().is_some_and(|source| source.supports_default_selection())
    }

    pub fn follows_target_default_model(&self) -> bool {
        recover_read_lock(&self.client_model_options, "client model options").model_selection_mode == ModelSelectionMode::FollowTargetDefault
    }

    /// Enable follow-default only after the current target default can be built.
    /// Hosts must hold their idle execution gate. Persistence precedes activation.
    pub fn follow_target_default_model(&self) -> Result<()> {
        self.refresh_client_default_with_mode(Some(ModelSelectionMode::FollowTargetDefault))
    }

    /// The caller must hold the resident execution gate. Build completely before
    /// replacing the old runtime; an invalid/deleted model leaves history intact.
    pub fn refresh_client_model_configuration(&self, requested: Option<&str>) -> Result<()> {
        let Some(source) = &self.client_model_configuration else {
            return requested.map_or(Ok(()), |model| self.select_client_model(model));
        };
        if !self
            .current_provider()
            .supports_client_runtime_reconfiguration()
        {
            return requested.map_or(Ok(()), |model| self.select_client_model(model));
        }
        let previous = recover_read_lock(&self.settings, "settings").clone();
        let restored_selection = if requested.is_none() && !self.follows_target_default_model() {
            self.state.selected_model()
        } else { None };
        let selection = canonical_selection(&previous, requested.or(restored_selection.as_deref()))?;
        let next = source.settings(&selection)?;
        self.apply_resolved_client_model_configuration(source.as_ref(), previous, next,
            requested.map(|_| ModelSelectionMode::Explicit))
    }

    /// Explicitly resolve the target default at an idle turn boundary.
    /// This does not change persistent selection intent; the host owns that state.
    pub fn refresh_client_default_model_configuration(&self) -> Result<()> {
        self.refresh_client_default_with_mode(None)
    }

    fn refresh_client_default_with_mode(&self, mode: Option<ModelSelectionMode>) -> Result<()> {
        anyhow::ensure!(self.current_provider().supports_client_runtime_reconfiguration(),
            "This provider cannot follow target model defaults");
        let source = self.client_model_configuration.as_ref()
            .context("Target default model selection is not supported by this host")?;
        let next = source.default_settings()?
            .context("Target default model selection is not supported by this host")?;
        let previous = recover_read_lock(&self.settings, "settings").clone();
        self.apply_resolved_client_model_configuration(source.as_ref(), previous, next, mode)
    }

    fn apply_resolved_client_model_configuration(
        &self,
        source: &dyn ClientModelConfiguration,
        previous: Settings,
        mut next: Settings,
        mode: Option<ModelSelectionMode>,
    ) -> Result<()> {
        validate_client_selection(&previous, &next)?;
        let mut options =
            recover_read_lock(&self.client_model_options, "client model options").clone();
        options.bind_model(&next);
        options.default_reasoning = next.model_reasoning_effort.clone();
        if let Some(reasoning) = &options.reasoning {
            next.model_reasoning_effort = Some(reasoning.clone());
        }
        if let Some(proxy) = &options.proxy {
            next.provider_proxy_url = proxy.clone();
        }
        if let Some(tier) = &options.service_tier {
            next.provider_extra_body
                .insert("service_tier".into(), serde_json::json!(tier));
        }
        let provider = source.provider(&next)?;
        options.frozen_host = None;
        if let Some(mode) = mode {
            options.model_selection_mode = mode;
        }
        self.state.set_model_selection(options.model_selection_mode,
            Some(canonical_selection(&next, None)?))?;
        let retained = retained_model_fields(previous, &next);
        *recover_write_lock(&self.provider, "provider") = provider;
        *recover_write_lock(&self.settings, "settings") = retained;
        *recover_write_lock(&self.client_model_options, "client model options") = options;
        Ok(())
    }
}

fn validate_client_selection(previous: &Settings, next: &Settings) -> Result<()> {
        if let Some(profile) = next.active_provider.as_ref() {
            let was_configured = previous
                .providers
                .get(profile)
                .is_some_and(|p| p.has_model(&next.model));
            let still_configured = next
                .providers
                .get(profile)
                .is_some_and(|p| p.has_model(&next.model));
            if was_configured && !still_configured {
                anyhow::bail!(
                    "Selected model was removed from its provider; select an available model"
                );
            }
            if !still_configured {
                anyhow::ensure!(
                    next.providers.get(profile).is_some_and(|profile| profile
                        .discover_models
                        .unwrap_or(next.model_discovery.enabled)),
                    "Selected model is not configured and model discovery is disabled"
                );
            }
        }
    Ok(())
}

fn retained_model_fields(previous: Settings, next: &Settings) -> Settings {
    let mut retained = previous;
    // Only model/transport/context fields cross this boundary. In particular,
    // tools, extension registries, permissions, goals and memory stay pinned.
    macro_rules! copy_fields { ($($field:ident),* $(,)?) => { $(retained.$field = next.$field.clone();)* }; }
    copy_fields!(
        active_provider,
        providers,
        stored_provider_credentials,
        revoked_provider_credentials,
        credential_overrides,
        model_discovery,
        active_model_selection,
        model,
        model_reasoning_effort,
        model_reasoning_policy,
        provider,
        api_format,
        request_timeout_secs,
        provider_no_proxy,
        provider_proxy_url,
        provider_extra_body,
        provider_chat_protocol,
        model_capabilities,
        api_key,
        base_url,
        anthropic_api_key,
        anthropic_base_url,
        kunlunmeta_api_key,
        kunlunmeta_base_url,
        openai_api_key,
        openai_base_url,
        openai_user_agent,
        local_api_key,
        local_base_url,
        gemini_api_key,
        gemini_base_url,
        grok_api_key,
        grok_base_url,
        credential_store,
        context_window_tokens,
        context_output_headroom,
        auto_compact_threshold_tokens,
        max_tokens,
        max_retries,
        retry_base_delay_ms
    );
    retained
}

fn canonical_selection(settings: &Settings, requested: Option<&str>) -> Result<String> {
    let current = || {
        settings
            .active_provider
            .as_ref()
            .map(|provider| format!("{provider}::{}", settings.model))
            .unwrap_or_else(|| settings.model.clone())
    };
    let Some(requested) = requested else {
        return Ok(current());
    };
    let requested = requested.trim();
    anyhow::ensure!(!requested.is_empty(), "model selection is empty");
    if let Some((profile, model)) = requested.split_once("::") {
        anyhow::ensure!(
            !profile.is_empty() && !model.is_empty(),
            "model selection must include a provider and model"
        );
    }
    if requested.contains("::") || settings.providers.contains_key(requested) {
        return Ok(requested.into());
    }
    if requested == settings.model {
        return Ok(current());
    }
    if let Some(active) = settings.active_provider.as_ref()
        && settings
            .providers
            .get(active)
            .is_some_and(|profile| profile.has_model(requested))
    {
        return Ok(format!("{active}::{requested}"));
    }
    if let Some((id, _)) = settings
        .providers
        .iter()
        .find(|(_, profile)| profile.has_model(requested))
    {
        return Ok(format!("{id}::{requested}"));
    }
    Ok(settings
        .active_provider
        .as_ref()
        .map(|id| format!("{id}::{requested}"))
        .unwrap_or_else(|| requested.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{engine_builder::TestEngineBuilder, providers::EmptyProvider};

    struct DurableSource {
        live: Arc<RwLock<Settings>>,
        reject: Arc<std::sync::atomic::AtomicBool>,
    }
    impl ClientModelConfiguration for DurableSource {
        fn settings(&self, _: &str) -> Result<Settings> { Ok(self.live.read().unwrap().clone()) }
        fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> { Ok(Arc::new(EmptyProvider)) }
        fn refreeze_model(&self, _: &[u8], settings: &Settings) -> Result<Vec<u8>> {
            Ok(serde_json::to_vec(&kcoder_config::ModelRequestSnapshot::capture(settings)?)?)
        }
        fn freeze_model(&self, settings: &Settings, _: &dyn Provider) -> Result<Option<Vec<u8>>> {
            Ok(Some(serde_json::to_vec(&kcoder_config::ModelRequestSnapshot::capture(settings)?)?))
        }
        fn thaw_model(&self, bytes: &[u8], _: Option<String>) -> Result<(Settings, Arc<dyn Provider>)> {
            anyhow::ensure!(!self.reject.load(std::sync::atomic::Ordering::SeqCst), "credential rejected");
            let frozen: kcoder_config::ModelRequestSnapshot = serde_json::from_slice(bytes)?;
            let mut current = self.live.read().unwrap().clone();
            frozen.apply_to(&mut current);
            Ok((current, Arc::new(EmptyProvider)))
        }
        fn thaw_model_with_proxy_override(&self, bytes: &[u8], proxy_url: &str) -> Result<(Settings, Arc<dyn Provider>)> {
            let (mut settings, provider) = self.thaw_model(bytes, None)?;
            settings.provider_proxy_url = (!proxy_url.is_empty()).then(|| proxy_url.into());
            Ok((settings, provider))
        }
    }

    #[test]
    fn durable_model_restoration_preserves_intent_and_non_model_runtime_state() {
        let directory = tempfile::tempdir().unwrap();
        let mut original = Settings::default();
        original.active_provider = None;
        original.provider = Some("openai".into());
        original.model = "frozen-model".into();
        original.model_reasoning_effort = Some(ReasoningEffort::High);
        original.tools.disabled = vec!["pinned-tools".into()];
        let live = Arc::new(RwLock::new(original.clone()));
        let reject = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine = TestEngineBuilder::new(directory.path()).settings(original).build()
            .with_client_model_configuration(Arc::new(DurableSource { live: live.clone(), reject: reject.clone() }));
        {
            let mut options = engine.client_model_options.write().unwrap();
            options.model_selection_mode = ModelSelectionMode::FollowTargetDefault;
            options.reasoning = Some(ReasoningEffort::High);
            options.proxy = Some(Some("http://user:private-proxy-password@proxy.invalid".into()));
        }
        let frozen = engine.freeze_client_model().unwrap().unwrap();
        assert!(!String::from_utf8_lossy(&frozen).contains("private-proxy-password"));
        live.write().unwrap().tools.disabled = vec!["must-not-replace-tools".into()];
        engine.settings.write().unwrap().model = "current-default".into();
        engine.thaw_client_model(&frozen, None).unwrap();
        assert_eq!(engine.settings.read().unwrap().model, "frozen-model");
        assert_eq!(engine.settings.read().unwrap().tools.disabled, vec!["pinned-tools"]);
        assert!(engine.follows_target_default_model());
        assert_eq!(engine.client_model_options.read().unwrap().reasoning, Some(ReasoningEffort::High));
        assert_eq!(engine.state.selected_model().as_deref(), Some("frozen-model"));
        engine.set_client_runtime_options(None, Some("fast")).unwrap();
        let refrozen: serde_json::Value = serde_json::from_slice(&engine.freeze_client_model().unwrap().unwrap()).unwrap();
        assert_eq!(refrozen["host"]["extra_body"]["service_tier"], "priority");
        reject.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(engine.set_client_runtime_options(None, Some("standard")).is_err());
        assert_eq!(engine.settings.read().unwrap().provider_extra_body["service_tier"], "priority");
        assert!(engine.thaw_client_model(&frozen, None).is_err());
        assert_eq!(engine.settings.read().unwrap().model, "frozen-model");
        reject.store(false, std::sync::atomic::Ordering::SeqCst);
        let mut malformed: serde_json::Value = serde_json::from_slice(&frozen).unwrap();
        malformed["selection"] = serde_json::json!("another-model");
        assert!(engine.thaw_client_model(&serde_json::to_vec(&malformed).unwrap(), None).is_err());
        assert_eq!(engine.state.selected_model().as_deref(), Some("frozen-model"));
        malformed["mode"] = serde_json::json!("private-invalid-value");
        let error = engine.thaw_client_model(&serde_json::to_vec(&malformed).unwrap(), None).unwrap_err();
        assert!(!format!("{error:#}").contains("private-invalid-value"));
        reject.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(engine.prepare_client_model_from_snapshot(&frozen, Some("frozen-model"), None).is_err());
        assert!(engine.prepare_client_model_from_snapshot(&frozen, Some(" "), None).is_err());
        live.write().unwrap().model = "replacement-model".into();
        engine.prepare_client_model_from_snapshot(&frozen, Some("replacement-model"), None).unwrap();
        assert_eq!(engine.settings.read().unwrap().model, "replacement-model");
        assert!(!engine.follows_target_default_model());
        reject.store(false, std::sync::atomic::Ordering::SeqCst);
        engine.prepare_client_model_from_snapshot(&frozen, Some("frozen-model"), None).unwrap();
        assert_eq!(engine.settings.read().unwrap().model, "frozen-model");
        assert!(!engine.follows_target_default_model());
        engine.prepare_client_model_from_snapshot(&frozen, None, Some("http://new-proxy.invalid")).unwrap();
        assert_eq!(engine.settings.read().unwrap().provider_proxy_url.as_deref(), Some("http://new-proxy.invalid"));
        assert_eq!(engine.client_model_options.read().unwrap().proxy, Some(Some("http://new-proxy.invalid".into())));
        engine.prepare_client_model_from_snapshot(&frozen, None, Some("")).unwrap();
        assert_eq!(engine.client_model_options.read().unwrap().proxy, Some(None));
    }

    #[test]
    fn explicit_current_reloads_same_model_without_mutating_on_invalid_options() {
        let directory = tempfile::tempdir().unwrap();
        let mut initial = Settings::default();
        initial.active_provider = None;
        initial.model = "same-model".into();
        initial.provider_extra_body.insert("temperature".into(), serde_json::json!(0.2));
        let live = Arc::new(RwLock::new(initial.clone()));
        let reject = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let engine = TestEngineBuilder::new(directory.path()).settings(initial).build()
            .with_client_model_configuration(Arc::new(DurableSource { live: live.clone(), reject }));
        let frozen = engine.freeze_client_model().unwrap().unwrap();
        live.write().unwrap().provider_extra_body.insert("temperature".into(), serde_json::json!(0.9));
        engine.prepare_client_model_from_snapshot(&frozen, Some("same-model"), None).unwrap();
        assert_eq!(engine.settings.read().unwrap().provider_extra_body["temperature"], 0.2);
        let before = engine.state.selected_model();
        assert!(engine.prepare_client_model_continuation(&frozen, ClientModelContinuationOptions {
            model: Some("same-model"), configuration: kcoder_types::RetryModelConfiguration::Current,
            service_tier: Some("invalid"), ..Default::default()
        }).is_err());
        assert_eq!(engine.state.selected_model(), before);
        assert_eq!(engine.settings.read().unwrap().provider_extra_body["temperature"], 0.2);
        engine.prepare_client_model_continuation(&frozen, ClientModelContinuationOptions {
            model: Some("same-model"), configuration: kcoder_types::RetryModelConfiguration::Current, ..Default::default()
        }).unwrap();
        assert_eq!(engine.settings.read().unwrap().provider_extra_body["temperature"], 0.9);
    }

    struct Source(Arc<RwLock<Settings>>);
    impl ClientModelConfiguration for Source {
        fn settings(&self, selection: &str) -> Result<Settings> {
            let mut settings = self.0.read().unwrap().clone();
            let (profile, model) = selection.split_once("::").unwrap();
            settings.apply_discovered_model(profile, model)?;
            Ok(settings)
        }
        fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
            Ok(Arc::new(EmptyProvider))
        }
    }

    #[test]
    fn refresh_preserves_non_model_settings_and_explicit_effort_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let mut initial = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.default_model = "fixture".into();
        profile.models.clear();
        profile.discover_models = Some(false);
        profile.reasoning_effort = Some(ReasoningEffort::Low);
        profile
            .extra_body
            .insert("service_tier".into(), serde_json::json!("default"));
        initial.providers.insert("fixture".into(), profile);
        initial
            .apply_discovered_model("fixture", "fixture")
            .unwrap();
        initial.tools.disabled = vec!["keep-original-tools".into()];
        let latest = Arc::new(RwLock::new(initial.clone()));
        let engine = TestEngineBuilder::new(directory.path())
            .settings(initial.clone())
            .build()
            .with_client_model_configuration(Arc::new(Source(latest.clone())));
        // Explicitly selecting the old default must remain explicit after refresh.
        assert!(
            engine
                .refresh_client_model_configuration(Some("fixture::unknown"))
                .is_err()
        );
        assert!(
            engine
                .refresh_client_model_configuration(Some("::fixture"))
                .is_err()
        );
        engine.set_client_reasoning_effort("low").unwrap();
        engine
            .set_client_runtime_options(Some(""), Some("standard"))
            .unwrap();
        {
            let mut next = latest.write().unwrap();
            next.providers.get_mut("fixture").unwrap().reasoning_effort =
                Some(ReasoningEffort::Medium);
            next.providers
                .get_mut("fixture")
                .unwrap()
                .extra_body
                .insert("temperature".into(), serde_json::json!(0.7));
            next.tools.disabled = vec!["unwanted-tool-change".into()];
            next.provider_proxy_url = Some("http://127.0.0.1:9".into());
            next.providers
                .get_mut("fixture")
                .unwrap()
                .extra_body
                .insert("service_tier".into(), serde_json::json!("priority"));
        }
        engine.refresh_client_model_configuration(None).unwrap();
        {
            let current = engine.settings.read().unwrap();
            assert_eq!(current.model_reasoning_effort, Some(ReasoningEffort::Low));
            assert_eq!(current.provider_extra_body["temperature"], 0.7);
            assert_eq!(current.provider_extra_body["service_tier"], "default");
            assert!(current.provider_proxy_url.is_none());
            assert_eq!(current.tools.disabled, initial.tools.disabled);
            assert_eq!(current.permission_mode, initial.permission_mode);
        }
        latest
            .write()
            .unwrap()
            .providers
            .get_mut("fixture")
            .unwrap()
            .reasoning_effort = Some(ReasoningEffort::High);
        engine.set_client_reasoning_effort("default").unwrap();
        assert_eq!(
            engine.settings.read().unwrap().model_reasoning_effort,
            Some(ReasoningEffort::Medium)
        );
        engine.refresh_client_model_configuration(None).unwrap();
        assert_eq!(
            engine.settings.read().unwrap().model_reasoning_effort,
            Some(ReasoningEffort::High)
        );
        engine.set_client_reasoning_effort("low").unwrap();
        {
            let mut settings = latest.write().unwrap();
            let mut other = settings.providers["fixture"].clone();
            other.default_model = "other-model".into();
            settings.providers.insert("other".into(), other);
        }
        engine
            .refresh_client_model_configuration(Some("other::other-model"))
            .unwrap();
        {
            let current = engine.settings.read().unwrap();
            assert_eq!(current.model_reasoning_effort, Some(ReasoningEffort::High));
            assert_eq!(current.provider_extra_body["service_tier"], "priority");
            assert!(current.provider_proxy_url.is_none());
        }
        latest.write().unwrap().providers.remove("other");
        assert!(engine.refresh_client_model_configuration(None).is_err());
        assert_eq!(engine.model_name(), "other-model");
    }
    #[test]
    fn client_reconfiguration_keeps_the_session_provider_factory() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct CountedSource(Arc<AtomicUsize>);
        impl ClientModelConfiguration for CountedSource {
            fn settings(&self, _: &str) -> Result<Settings> {
                anyhow::bail!("reconfiguration must retain the current semantic snapshot")
            }
            fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(Arc::new(EmptyProvider))
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.default_model = "fixture".into();
        profile.models.clear();
        settings.providers.insert("fixture".into(), profile);
        settings.apply_discovered_model("fixture", "fixture").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let engine = TestEngineBuilder::new(directory.path()).settings(settings).build()
            .with_client_model_configuration(Arc::new(CountedSource(calls.clone())));
        engine.switch_provider_profile("fixture").unwrap();
        engine.switch_discovered_model("fixture", "fixture").unwrap();
        engine.set_client_runtime_options(Some("http://127.0.0.1:9"), None).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn discovery_uses_the_bound_source_for_each_deployment() {
        struct RejectingSource(Arc<std::sync::Mutex<Vec<String>>>);
        impl ClientModelConfiguration for RejectingSource {
            fn settings(&self, _: &str) -> Result<Settings> {
                anyhow::bail!("discovery must not reload semantic settings")
            }
            fn provider(&self, settings: &Settings) -> Result<Arc<dyn Provider>> {
                self.0.lock().unwrap().push(settings.active_provider.clone().unwrap());
                anyhow::bail!("bound credential rejected")
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        settings.providers.clear();
        settings.model_discovery.enabled = true;
        for name in ["fixture-a", "fixture-b"] {
            let mut profile = kcoder_config::default_active_provider_config();
            profile.discover_models = Some(true);
            settings.providers.insert(name.into(), profile);
        }
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let engine = TestEngineBuilder::new(directory.path()).settings(settings).build()
            .with_client_model_configuration(Arc::new(RejectingSource(calls.clone())));
        let groups = engine.discover_provider_models().await;
        assert_eq!(groups.len(), 2);
        assert_eq!(*calls.lock().unwrap(), vec!["fixture-a", "fixture-b"]);
        for group in groups {
            assert!(group.models.is_empty());
            assert!(group.error.is_some());
        }
    }

    #[tokio::test]
    async fn new_user_submission_reloads_before_appending_or_running_hooks() {
        struct RejectedSource;
        impl ClientModelConfiguration for RejectedSource {
            fn settings(&self, _: &str) -> Result<Settings> {
                anyhow::bail!("selected model was removed")
            }
            fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
                panic!("invalid settings must not construct a provider")
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(temp.path()).build()
            .with_client_model_configuration(Arc::new(RejectedSource));
        let before = engine.state.messages().len();
        let events = engine.submit_message("do not append", &kcoder_permissions::AutoAllowPrompt).await;
        assert_eq!(engine.state.messages().len(), before);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], EngineEvent::Error(message) if message.contains("selected model was removed")));
    }

    #[test]
    fn current_catalog_drops_deleted_profiles_without_mutating_the_running_model() {
        struct CatalogSource(Arc<RwLock<Settings>>);
        impl ClientModelConfiguration for CatalogSource {
            fn settings(&self, selection: &str) -> Result<Settings> {
                let mut selected = self.0.read().unwrap().clone();
                let (profile, model) = selection.split_once("::").unwrap();
                selected.apply_provider(Some(profile))?; selected.model = model.into(); Ok(selected)
            }
            fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> { Ok(Arc::new(EmptyProvider)) }
            fn catalog_settings(&self) -> Result<Option<Settings>> { Ok(Some(self.0.read().unwrap().clone())) }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut initial = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.default_model = "fixture-model".into();
        profile.models.clear();
        initial.providers.insert("fixture".into(), profile);
        initial.apply_provider(Some("fixture")).unwrap();
        let latest = Arc::new(RwLock::new(initial.clone()));
        let engine = TestEngineBuilder::new(temp.path()).settings(initial).build()
            .with_client_model_configuration(Arc::new(CatalogSource(latest.clone())));
        assert!(engine.current_configured_model_profiles().unwrap().iter().any(|p| p.profile_name == "fixture"));
        latest.write().unwrap().providers.remove("fixture");
        assert!(!engine.current_configured_model_profiles().unwrap().iter().any(|p| p.profile_name == "fixture"));
        assert_eq!(engine.model_name(), "fixture-model");
        assert!(engine.settings.read().unwrap().providers.contains_key("fixture"));
    }

    #[test]
    fn explicit_default_refresh_updates_only_model_state_and_preserves_it_on_failure() {
        struct Defaults(Arc<RwLock<Settings>>, Arc<std::sync::atomic::AtomicBool>);
        impl ClientModelConfiguration for Defaults {
            fn settings(&self, _: &str) -> Result<Settings> { anyhow::bail!("must resolve default directly") }
            fn default_settings(&self) -> Result<Option<Settings>> { Ok(Some(self.0.read().unwrap().clone())) }
            fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> {
                anyhow::ensure!(!self.1.load(std::sync::atomic::Ordering::SeqCst), "fixture build failure");
                Ok(Arc::new(EmptyProvider))
            }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut initial = Settings::default();
        for name in ["a", "b"] {
            let mut profile = kcoder_config::default_active_provider_config();
            profile.default_model = format!("model-{name}");
            profile.models.clear();
            initial.providers.insert(name.into(), profile);
        }
        initial.apply_provider(Some("a")).unwrap();
        initial.tools.disabled = vec!["pinned-tool".into()];
        let mut latest = initial.clone();
        latest.apply_provider(Some("b")).unwrap();
        latest.tools.disabled.clear();
        let latest = Arc::new(RwLock::new(latest));
        let failure = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let engine = TestEngineBuilder::new(temp.path()).settings(initial).build()
            .with_client_model_configuration(Arc::new(Defaults(latest.clone(), failure.clone())));
        assert!(engine.refresh_client_default_model_configuration().is_err());
        assert_eq!(engine.model_name(), "model-a");
        failure.store(false, std::sync::atomic::Ordering::SeqCst);
        engine.refresh_client_default_model_configuration().unwrap();
        assert_eq!(engine.model_name(), "model-b");
        assert_eq!(engine.settings.read().unwrap().tools.disabled, vec!["pinned-tool"]);
    }

    #[test]
    fn follow_default_changes_only_at_new_turns_and_explicit_selection_exits_it() {
        struct Source(Arc<RwLock<Settings>>);
        impl ClientModelConfiguration for Source {
            fn settings(&self, selection: &str) -> Result<Settings> {
                let mut settings = self.0.read().unwrap().clone();
                let (profile, model) = selection.split_once("::").unwrap();
                settings.apply_discovered_model(profile, model)?;
                Ok(settings)
            }
            fn default_settings(&self) -> Result<Option<Settings>> { Ok(Some(self.0.read().unwrap().clone())) }
            fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> { Ok(Arc::new(EmptyProvider)) }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut initial = Settings::default();
        for name in ["a", "b"] {
            let mut profile = kcoder_config::default_active_provider_config();
            profile.default_model = format!("model-{name}");
            profile.models.clear();
            initial.providers.insert(name.into(), profile);
        }
        initial.apply_provider(Some("a")).unwrap();
        let latest = Arc::new(RwLock::new(initial.clone()));
        let engine = TestEngineBuilder::new(temp.path()).settings(initial).build()
            .with_client_model_configuration(Arc::new(Source(latest.clone())));
        engine.follow_target_default_model().unwrap();
        assert_eq!(engine.state.model_selection_mode(), ModelSelectionMode::FollowTargetDefault);
        latest.write().unwrap().apply_provider(Some("b")).unwrap();
        engine.prepare_client_model_for_turn(None, true).unwrap();
        assert_eq!(engine.model_name(), "model-a");
        engine.prepare_client_model_for_turn(None, false).unwrap();
        assert_eq!(engine.model_name(), "model-b");
        assert!(engine.follows_target_default_model());
        assert!(engine.prepare_client_model_for_turn(Some("missing::model"), false).is_err());
        assert!(engine.follows_target_default_model());
        engine.prepare_client_model_for_turn(Some("b::model-b"), true).unwrap();
        assert!(!engine.follows_target_default_model());
        assert_eq!(engine.state.model_selection_mode(), ModelSelectionMode::Explicit);
        latest.write().unwrap().apply_provider(Some("a")).unwrap();
        engine.prepare_client_model_for_turn(None, false).unwrap();
        assert_eq!(engine.model_name(), "model-b");
    }

    #[test]
    fn default_mode_persistence_failure_does_not_activate_resolved_provider() {
        struct Source(Settings);
        impl ClientModelConfiguration for Source {
            fn settings(&self, _: &str) -> Result<Settings> { Ok(self.0.clone()) }
            fn default_settings(&self) -> Result<Option<Settings>> { Ok(Some(self.0.clone())) }
            fn provider(&self, _: &Settings) -> Result<Arc<dyn Provider>> { Ok(Arc::new(EmptyProvider)) }
        }
        let temp = tempfile::tempdir().unwrap();
        let mut initial = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.default_model = "replacement".into();
        profile.models.clear();
        initial.providers.insert("replacement".into(), profile);
        let mut next = initial.clone();
        next.apply_provider(Some("replacement")).unwrap();
        let engine = TestEngineBuilder::new(temp.path()).settings(initial).build()
            .with_client_model_configuration(Arc::new(Source(next)));
        let original_model = engine.model_name();
        let original_provider = engine.current_provider();
        let blocker = temp.path().join("not-a-directory");
        std::fs::write(&blocker, b"fixture").unwrap();
        engine.state.with_deferred_history_path(blocker.join("history.jsonl"));
        assert!(engine.follow_target_default_model().is_err());
        assert_eq!(engine.model_name(), original_model);
        assert!(Arc::ptr_eq(&original_provider, &engine.current_provider()));
        assert!(!engine.follows_target_default_model());
        assert_eq!(engine.state.model_selection_mode(), ModelSelectionMode::Explicit);
    }

    #[test]
    fn restored_follow_intent_is_read_when_the_host_source_is_attached() {
        let temp = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(temp.path()).build();
        engine.state.set_model_selection_mode(ModelSelectionMode::FollowTargetDefault).unwrap();
        let source = Source(Arc::new(RwLock::new(Settings::default())));
        let engine = engine.with_client_model_configuration(Arc::new(source));
        assert!(engine.follows_target_default_model());
    }

    #[test]
    fn restored_explicit_identity_wins_over_a_new_target_default_with_same_model_name() {
        let temp = tempfile::tempdir().unwrap();
        let mut settings = Settings::default();
        for id in ["vendor-a", "vendor-b"] {
            let mut profile = kcoder_config::default_active_provider_config();
            profile.default_model = "shared-model".into();
            profile.models.clear();
            settings.providers.insert(id.into(), profile);
        }
        settings.apply_provider(Some("vendor-b")).unwrap();
        let latest = Arc::new(RwLock::new(settings.clone()));
        let engine = TestEngineBuilder::new(temp.path()).settings(settings).build();
        engine.state.set_model_selection(ModelSelectionMode::Explicit, Some("vendor-a::shared-model".into())).unwrap();
        let engine = engine.with_client_model_configuration(Arc::new(Source(latest)));
        engine.prepare_client_model_for_turn(None, false).unwrap();
        assert_eq!(engine.settings.read().unwrap().active_provider.as_deref(), Some("vendor-a"));
        assert_eq!(engine.state.selected_model().as_deref(), Some("vendor-a::shared-model"));
        assert!(!engine.follows_target_default_model());
    }

}
