use anyhow::{Context, Result, bail};
use kcoder_app_protocol::{
    ProviderDeleteParams, ProviderSettingsProfile, ProviderSettingsResult, ProviderUpsertParams,
};
use kcoder_config::{ApiFormat, CredentialStore, ProviderConfig, Settings};
use kcoder_engine::QueryEngine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub(super) fn templates(params: Value) -> Result<Value> {
    let _: kcoder_app_protocol::ProviderTemplatesParams = serde_json::from_value(params)
        .map_err(|_| anyhow::anyhow!("Provider templates do not accept parameters"))?;
    let templates = kcoder_config::provider_templates::provider_templates()
        .iter()
        .map(|template| kcoder_app_protocol::ProviderTemplateInfo {
            authentication: template.authentication,
            id: template.id.into(),
            display_name: template.display_name.into(),
            api_format: template.api_format.as_str().into(),
            endpoint: template.endpoint.into(),
            documentation_url: template.documentation_url.into(),
        })
        .collect();
    Ok(serde_json::to_value(
        kcoder_app_protocol::ProviderTemplatesResult {
            templates,
            supports_authentication_policy: true,
        },
    )?)
}

pub(super) async fn upsert(
    engine: QueryEngine,
    state: ProviderSettingsState,
    params: Value,
) -> Result<Value> {
    let input: ProviderUpsertParams = serde_json::from_value(params)
        .map_err(|_| anyhow::anyhow!("Invalid provider configuration fields"))?;
    let (id, format, key) = validate_input(&input)?;
    let path = engine
        .settings_persistence_path()
        .context("Provider configuration is unavailable for this runtime")?;
    let baseline = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("Runtime settings are unavailable"))?
        .clone();
    let snapshot = SaveSnapshot::read(&path, &id)?;
    ensure_editor_revision(&snapshot.user, input.expected_revision.as_deref())?;
    let profile: ProviderConfig = serde_json::from_value(profile_value(
        &baseline,
        &snapshot.user,
        &id,
        &input,
        format,
    )?)?;
    // Validate the model being saved, not the provider's unchanged default model.
    let profile = profile.effective_for_model(input.model.trim())?;
    let key = if snapshot
        .user
        .get("providers")
        .is_some_and(|profiles| profiles.get(&id).is_none())
    {
        // Recreating a removed provider must not resurrect a deleted key from live memory.
        key.or(snapshot.credential.clone())
    } else {
        candidate_key(&baseline, &id, &profile, key, snapshot.credential.clone())
    };
    super::provider_probe::verify(&baseline, &id, profile, key).await?;
    // Never hold a filesystem lock while awaiting an upstream network response.
    // Recheck the snapshot under the normal mutation/scope locks before committing.
    let saved_revision =
        tokio::task::spawn_blocking(move || commit(&path, &baseline, input, Some(&snapshot)))
            .await??;
    let mut response = request(
        &engine,
        &Ok(state),
        kcoder_app_protocol::method::PROVIDERS_LIST,
        json!({}),
    )?;
    response["savedRevision"] = json!(saved_revision);
    Ok(response)
}

#[derive(Clone)]
pub(super) struct ProviderSettingsState {
    new_session_reload: bool,
    turn_model_reload: bool,
    startup_user_ids: BTreeSet<String>,
    startup_user_model: Option<Value>,
    startup_user_selection: Option<Value>,
}

impl ProviderSettingsState {
    pub(super) fn with_turn_model_reload(mut self, enabled: bool) -> Self {
        self.turn_model_reload = enabled;
        self
    }

    pub(super) fn with_session_reload(mut self, enabled: bool) -> Self {
        self.new_session_reload = enabled;
        self
    }
}

fn candidate_key(
    baseline: &Settings,
    id: &str,
    profile: &ProviderConfig,
    submitted: Option<String>,
    stored: Option<String>,
) -> Option<String> {
    if !profile.authentication.is_api_key() {
        return None;
    }
    submitted.or(stored).or_else(|| {
        if !baseline.providers.contains_key(id) {
            return None;
        }
        let mut candidate = baseline.clone();
        candidate.providers.insert(id.to_owned(), profile.clone());
        candidate.resolve_provider_api_key(Some(id), None)
    })
}

pub(super) fn capture_state(engine: &QueryEngine) -> Result<ProviderSettingsState> {
    let user = match engine.settings_persistence_path() {
        Some(path) => kcoder_config::read_settings_file(&path)?,
        None => json!({}),
    };
    Ok(ProviderSettingsState {
        new_session_reload: false,
        turn_model_reload: false,
        startup_user_ids: user_provider_ids(&user),
        startup_user_model: user.get("model").cloned(),
        startup_user_selection: user.get("active_model_selection").cloned(),
    })
}

fn user_provider_ids(user: &Value) -> BTreeSet<String> {
    user.get("providers")
        .and_then(Value::as_object)
        .map(|providers| providers.keys().cloned().collect())
        .unwrap_or_default()
}

pub(super) fn request(
    engine: &QueryEngine,
    state: &Result<ProviderSettingsState>,
    method: &str,
    params: Value,
) -> Result<Value> {
    let state = state.as_ref().map_err(|_| anyhow::anyhow!("Provider configuration snapshot is unavailable; reconnect after repairing the settings file"))?;
    let path = engine
        .settings_persistence_path()
        .context("Provider configuration is unavailable for this runtime")?;
    let baseline = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("Runtime settings lock is unavailable"))?
        .clone();
    let mut warning = None;
    if method == kcoder_app_protocol::method::PROVIDERS_DELETE {
        let input: ProviderDeleteParams = serde_json::from_value(params)
            .map_err(|_| anyhow::anyhow!("Invalid provider deletion fields"))?;
        warning = remove_provider(&path, &baseline, input)?;
    } else if method == kcoder_app_protocol::method::PROVIDERS_UPSERT {
        bail!("Provider saving requires connection validation");
    } else if !params.as_object().is_some_and(|object| object.is_empty()) {
        bail!("Provider list does not accept parameters");
    }
    if method == kcoder_app_protocol::method::PROVIDERS_VALIDATE {
        validate_startup(&path, &baseline, &state.startup_user_ids)?;
        return Ok(json!({"valid": true}));
    }
    let mut result = list(&path, &baseline)?;
    if let Some(sources) = engine.model_configuration_file_sources()? {
        for profile in &mut result.profiles {
            let source = sources.iter().find(|source| source.provider == profile.id && source.model == profile.model);
            profile.available_in_current_config = Some(source.is_some());
            profile.file_sources = source.map(|source| source.fields.clone());
        }
    }

    let saved = kcoder_config::read_settings_file(&path)?;
    let saved_ids = user_provider_ids(&saved);
    result.restart_required |= !state.startup_user_ids.is_subset(&saved_ids);
    result.restart_required |= state.startup_user_model.as_ref() != saved.get("model");
    result.restart_required |=
        state.startup_user_selection.as_ref() != saved.get("active_model_selection");
    result.supports_new_session_reload = state.new_session_reload;
    result.supports_turn_model_reload = state.turn_model_reload;
    if state.new_session_reload {
        result.restart_required = false;
    }
    result.warning = warning;
    Ok(serde_json::to_value(result)?)
}

// Hold this cross-process guard across both files so a delete cannot erase a
// newly saved key after another App client recreates the same provider ID.
fn lock_provider_mutation(path: &Path) -> Result<std::fs::File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("Cannot prepare provider settings directory")?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("providers.lock"))
        .context("Cannot open provider mutation lock")?;
    fs2::FileExt::lock_exclusive(&lock).context("Cannot lock provider configuration")?;
    Ok(lock)
}

fn remove_provider(
    path: &Path,
    baseline: &Settings,
    input: ProviderDeleteParams,
) -> Result<Option<String>> {
    anyhow::ensure!(
        input.confirm,
        "Provider deletion requires explicit confirmation"
    );
    let id = kcoder_config::validate_provider_id(&input.id)?;
    anyhow::ensure!(id.len() <= 128, "Provider ID is too long");
    let _mutation_lock = lock_provider_mutation(path)?;
    if input.model.is_some() {
        remove_model(path, baseline, &id, &input)?;
        return Ok(None);
    }
    anyhow::ensure!(
        input.replacement_model.is_none(),
        "Model replacement requires a model deletion"
    );
    if input.remove_credentials {
        CredentialStore::load_from(&path.with_file_name("credentials.json"))
            .context("Cannot safely read the credential file for removal")?;
    }
    kcoder_config::update_settings_file(path, |user| {
        let selected = user
            .get("active_provider")
            .map(Value::as_str)
            .unwrap_or(baseline.active_provider.as_deref())
            .map(str::to_owned);
        let providers = user
            .get_mut("providers")
            .and_then(Value::as_object_mut)
            .context("Only user-configured API profiles can be deleted here")?;
        anyhow::ensure!(
            providers.contains_key(&id),
            "This API is not defined in user settings"
        );
        if selected.as_deref() == Some(&id) {
            if let Some(replacement) = input.replacement_provider.as_deref() {
                anyhow::ensure!(
                    replacement != id && providers.contains_key(replacement),
                    "Replacement provider must be a different user-configured API"
                );
            }
        } else {
            anyhow::ensure!(
                input.replacement_provider.is_none(),
                "Replacement provider is only valid when deleting the default API"
            );
        }
        providers.remove(&id);
        let next_default = input
            .replacement_provider
            .clone()
            .or_else(|| providers.keys().min().cloned());
        rewrite_user_model_references(user, baseline, &id, None, None)?;
        if selected.as_deref() == Some(&id) || selected.is_none() {
            user["active_provider"] = json!(next_default);
        }
        // Keep the explicit map, even when empty, so deleted built-ins cannot reappear.
        Ok(())
    })?;
    if input.remove_credentials {
        let result =
            CredentialStore::update_file(&path.with_file_name("credentials.json"), |credentials| {
                credentials.remove_api_key(&id)?;
                Ok(())
            });
        if result.is_err() {
            return Ok(Some("API configuration was removed, but credential cleanup failed; check the target credential file permissions".into()));
        }
    }
    Ok(None)
}

fn remove_model(
    path: &Path,
    baseline: &Settings,
    id: &str,
    input: &ProviderDeleteParams,
) -> Result<()> {
    anyhow::ensure!(
        !input.remove_credentials && input.replacement_provider.is_none(),
        "Deleting one model cannot remove shared credentials or replace its provider"
    );
    let model = input
        .model
        .as_deref()
        .context("Model deletion requires a model")?;
    kcoder_config::update_settings_file(path, |user| {
        let saved = user
            .get("providers")
            .and_then(|value| value.get(id))
            .context("Only user-configured models can be deleted here")?;
        let mut value = baseline
            .providers
            .get(id)
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(json!({}));
        merge_profile_fields(&mut value, saved);
        let profile: ProviderConfig = serde_json::from_value(value.clone())?;
        let mut models = profile.model_profiles();
        anyhow::ensure!(models.contains_key(model), "The model no longer exists");
        anyhow::ensure!(
            models.len() > 1,
            "Delete the entire API to remove its last model"
        );
        if model == profile.default_model {
            let replacement = input
                .replacement_model
                .clone()
                .or_else(|| {
                    models
                        .keys()
                        .find(|candidate| candidate.as_str() != model)
                        .cloned()
                })
                .context("No remaining model")?;
            anyhow::ensure!(
                replacement != model && models.contains_key(&replacement),
                "Replacement must be another model of the same provider"
            );
            value["default_model"] = json!(replacement);
        } else {
            anyhow::ensure!(
                input.replacement_model.is_none(),
                "Replacement is only valid for the provider's default model"
            );
        }
        models.remove(model);
        value["models"] = serde_json::to_value(models)?;
        synchronize_default_model(&mut value)?;
        rewrite_user_model_references(user, baseline, id, Some(model), None)?;
        // The explicit table is authoritative, including before the runtime restarts.
        user["providers"][id] = value;
        Ok(())
    })
    .map(|_| ())
}

fn validate_startup(
    path: &Path,
    baseline: &Settings,
    startup_user_ids: &BTreeSet<String>,
) -> Result<()> {
    let user = kcoder_config::read_settings_file(path)?;
    let mut merged = serde_json::to_value(baseline)?;
    let saved_ids = user_provider_ids(&user);
    for id in startup_user_ids.difference(&saved_ids) {
        merged["providers"]
            .as_object_mut()
            .context("Invalid runtime providers")?
            .remove(id);
    }
    merge_fields(&mut merged, &user);
    let mut settings = kcoder_config::validate_and_resolve_settings_document(&merged)
        .map_err(|_| anyhow::anyhow!("Saved provider configuration is invalid"))?;
    settings.stored_provider_credentials =
        CredentialStore::load_from(&path.with_file_name("credentials.json"))?.credentials;
    settings.credential_overrides = baseline.credential_overrides.clone();
    // Empty explicit catalogs retain settings/history access without a usable model.
    if settings.providers.is_empty() && settings.active_provider.is_none() {
        return Ok(());
    }
    let id = settings
        .active_provider
        .clone()
        .context("No default provider is configured")?;
    // Provider construction validates credentials and transport settings without an API request.
    kcoder_api::ProviderFactory::new(&settings)
        .build_profile(&id)
        .map_err(|_| {
            anyhow::anyhow!(
                "Saved provider cannot start; check its API key and connection settings"
            )
        })?;
    Ok(())
}

fn list(path: &Path, baseline: &Settings) -> Result<ProviderSettingsResult> {
    let user = kcoder_config::read_settings_file(path)?;
    // This editor owns user-scope definitions. The execution model catalog still
    // exposes project/startup profiles; deleting a user entry never edits those layers.
    let mut providers = if user.get("providers").is_some() {
        BTreeMap::new()
    } else {
        baseline.providers.clone()
    };
    let saved_ids = user_provider_ids(&user);
    if let Some(value) = user.get("providers") {
        for (id, saved) in value.as_object().context("providers must be an object")? {
            let mut merged = baseline
                .providers
                .get(id)
                .map(serde_json::to_value)
                .transpose()?
                .unwrap_or_else(|| json!({}));
            merge_profile_fields(&mut merged, saved);
            providers.insert(
                id.clone(),
                serde_json::from_value(merged).context("Invalid saved provider configuration")?,
            );
        }
    }
    let selected = user
        .get("active_provider")
        .map(Value::as_str)
        .unwrap_or(baseline.active_provider.as_deref());
    let credentials = CredentialStore::load_from(&path.with_file_name("credentials.json"))?;
    let restart_required = providers
        .iter()
        .any(|(id, profile)| baseline.providers.get(id) != Some(profile))
        || selected != baseline.active_provider.as_deref()
        || credentials.credentials.iter().any(|(id, key)| {
            providers
                .get(id)
                .is_some_and(|profile| profile.authentication.is_api_key())
                && baseline.resolve_provider_api_key(Some(id), None).as_ref() != Some(key)
        });
    let mut profiles = Vec::new();
    for (id, profile) in providers {
        let key_configured = candidate_key(
            baseline,
            &id,
            &profile,
            None,
            credentials.credentials.get(&id).cloned(),
        )
        .is_some();
        for (model, _) in profile.model_profiles() {
            let effective = profile.effective_for_model(&model)?;
            profiles.push(ProviderSettingsProfile {
                file_sources: None,
                available_in_current_config: None,

                chat_protocol: profile.chat_protocol,
                reasoning_effort: effective.reasoning_effort.as_ref().map(ToString::to_string),
                reasoning_policy: effective.reasoning_policy.clone(),
                extra_body: effective.extra_body.clone(),
                capabilities: Some(kcoder_app_protocol::ProviderModelCapabilities {
                    text: effective.capabilities.text,
                    tools: effective.capabilities.tools,
                    vision: effective.capabilities.vision,
                    reasoning: effective.capabilities.reasoning,
                    structured_output: effective.capabilities.structured_output,
                }),
                authentication: profile.authentication,
                api_key_configured: key_configured,
                is_provider_default: model == profile.default_model,
                is_default: selected == Some(id.as_str()) && model == profile.default_model,
                can_delete: saved_ids.contains(&id),
                id: id.clone(),
                api_format: profile.api_format.as_str().into(),
                endpoint: profile.endpoint.clone(),
                model,
                context_window_tokens: effective.context_window_tokens,
                max_output_tokens: effective.max_output_tokens,
            });
        }
    }
    Ok(ProviderSettingsResult {
        supports_optimistic_concurrency: true,
        revision: Some(settings_revision(&user)?),
        saved_revision: None,
        supports_model_reasoning: true,
        supports_model_reasoning_policy: true,
        supports_chat_protocol: true,
        supports_new_session_reload: false,
        supports_turn_model_reload: false,
        supports_multiple_models: true,
        supports_model_capabilities: true,
        supports_extra_body: false,
        supports_model_extra_body: true,
        profiles,
        restart_required,
        warning: None,
    })
}

fn validate_input(input: &ProviderUpsertParams) -> Result<(String, ApiFormat, Option<String>)> {
    if input.original_model.as_deref().is_some_and(|model| {
        model.trim().is_empty() || model.len() > 512 || model.chars().any(char::is_control)
    }) {
        bail!("Original model name is invalid");
    }
    let id = kcoder_config::validate_provider_id(&input.id)?;
    if id.len() > 128
        || input.model.trim().is_empty()
        || input.model.len() > 512
        || input.model.chars().any(char::is_control)
    {
        bail!("Provider ID or model name is invalid");
    }
    let endpoint = reqwest::Url::parse(&input.endpoint)
        .map_err(|_| anyhow::anyhow!("Invalid API endpoint"))?;
    if input.endpoint.len() > 4096
        || !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.host_str().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
    {
        bail!("API endpoint must be an HTTP(S) URL without credentials, query or fragment");
    }
    let format: ApiFormat = serde_json::from_value(json!(input.api_format))
        .map_err(|_| anyhow::anyhow!("Unsupported API format"))?;
    if input.context_window_tokens < 1024
        || input.context_window_tokens > 100_000_000
        || input.max_output_tokens == 0
        || input.max_output_tokens as usize >= input.context_window_tokens
    {
        bail!("Token limits must be positive and output must be smaller than context");
    }
    let key = input
        .api_key
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned();
    if key
        .as_ref()
        .is_some_and(|value| value.len() > 16384 || value.chars().any(char::is_control))
    {
        bail!("Invalid API key");
    }
    Ok((id, format, key))
}

fn profile_value(
    baseline: &Settings,
    user: &Value,
    id: &str,
    input: &ProviderUpsertParams,
    format: ApiFormat,
) -> Result<Value> {
    let still_defined = user
        .get("providers")
        .map(|profiles| profiles.get(id).is_some())
        .unwrap_or(true);
    let mut value = baseline
        .providers
        .get(id)
        .filter(|_| still_defined)
        .map(serde_json::to_value)
        .transpose()?
        .unwrap_or_else(
            || json!({"capabilities":{"vision":false,"reasoning":false},"extra_body":{}}),
        );
    if let Some(saved) = user.get("providers").and_then(|profiles| profiles.get(id)) {
        merge_profile_fields(&mut value, saved);
    }
    anyhow::ensure!(
        input.extra_body.is_none(),
        "[provider_probe_configuration] Upgrade Studio to edit model-specific request bodies"
    );
    let previous: Option<ProviderConfig> = if value.get("default_model").is_some() {
        Some(serde_json::from_value(value.clone())?)
    } else {
        None
    };
    let model = input.model.trim();
    let mut models = previous
        .as_ref()
        .map(ProviderConfig::model_profiles)
        .unwrap_or_default();
    // Materialize legacy bodies before clearing the Provider default so siblings
    // retain their behavior and newly added models do not inherit unrelated parameters.
    for parameters in models.values_mut() {
        if parameters.extra_body.is_none() {
            parameters.extra_body = Some(
                previous
                    .as_ref()
                    .map(|p| p.extra_body.clone())
                    .unwrap_or_default(),
            );
        }
    }
    value["extra_body"] = json!({});
    if let Some(original) = &input.original_model {
        anyhow::ensure!(
            models.contains_key(original),
            "[provider_probe_changed] The edited model no longer exists"
        );
        anyhow::ensure!(
            original == model || !models.contains_key(model),
            "[provider_probe_configuration] Model rename would overwrite another model"
        );
    }
    if let Some(previous) = &previous {
        if input.original_model.is_none() && !models.contains_key(model) {
            anyhow::ensure!(
                previous.endpoint == input.endpoint.trim()
                    && previous.api_format == format
                    && input
                        .authentication
                        .is_none_or(|auth| auth == previous.authentication),
                "[provider_probe_configuration] Adding a model must preserve its provider connection; edit the API explicitly to change it"
            );
        }
    }
    let source_model = input.original_model.as_deref().unwrap_or(model);
    let mut model_value = models.get(source_model).map(serde_json::to_value).transpose()?
        .unwrap_or_else(|| json!({"capabilities":{"text":true,"tools":false,"vision":false,"reasoning":false,"structured_output":false}}));
    if let Some(extra_body) = &input.model_extra_body {
        kcoder_config::validate_extra_body(extra_body)
            .map_err(|error| anyhow::anyhow!("[provider_probe_configuration] {error}"))?;
        model_value["extra_body"] = json!(extra_body);
    } else if model_value.get("extra_body").is_none() {
        model_value["extra_body"] = json!({});
    }
    if let Some(effort) = &input.reasoning_effort {
        anyhow::ensure!(
            effort.len() <= 128 && !effort.trim().is_empty(),
            "Invalid reasoning effort"
        );
        model_value["reasoning_effort"] = if effort == "default" {
            Value::Null
        } else {
            json!(effort)
        };
    }
    if let Some(policy) = &input.reasoning_policy {
        model_value["reasoning_policy"] = serde_json::to_value(policy)?;
    }
    if let Some(capabilities) = &input.capabilities {
        model_value["capabilities"] = json!(capabilities);
    }
    model_value["context_window_tokens"] = json!(input.context_window_tokens);
    model_value["max_output_tokens"] = json!(input.max_output_tokens);
    model_value["output_headroom_tokens"] = json!(input.max_output_tokens);
    if let Some(original) = &input.original_model {
        models.remove(original);
    }
    let candidate: kcoder_config::ProviderModelConfig = serde_json::from_value(model_value)?;
    candidate.validate_reasoning_policy(&Default::default()).map_err(|error| anyhow::anyhow!("[provider_reasoning_policy] {error}"))?;
    models.insert(model.to_owned(), candidate);
    value["api_format"] = json!(format);
    if let Some(protocol) = input.chat_protocol {
        value["chat_protocol"] = json!(protocol);
    }
    if let Some(authentication) = input.authentication {
        value["authentication"] = json!(authentication);
    }
    value["endpoint"] = json!(input.endpoint.trim());
    if previous.is_none()
        || input.make_default
        || previous.as_ref().is_some_and(|profile| {
            input.original_model.as_deref() == Some(profile.default_model.as_str())
        })
    {
        value["default_model"] = json!(model);
    }
    value["models"] = serde_json::to_value(models)?;
    synchronize_default_model(&mut value)?;
    let profile: ProviderConfig =
        serde_json::from_value(value.clone()).context("Invalid provider configuration")?;
    if !profile.authentication.is_api_key()
        && input
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty())
    {
        bail!(
            "[provider_probe_configuration] Remove the new API key when authentication is disabled"
        );
    }
    kcoder_config::validate_and_resolve_settings_document(
        &json!({"providers":{id:value.clone()},"active_provider":id}),
    )
    .context("Invalid provider limits or capabilities")?;
    Ok(value)
}

fn synchronize_default_model(value: &mut Value) -> Result<()> {
    let profile: ProviderConfig = serde_json::from_value(value.clone())?;
    let effective = serde_json::to_value(profile.effective_for_model(&profile.default_model)?)?;
    for field in [
        "context_window_tokens",
        "max_output_tokens",
        "output_headroom_tokens",
        "capabilities",
        "reasoning_effort",
        "reasoning_policy",
        "auto_compact_threshold_tokens",
    ] {
        value[field] = effective.get(field).cloned().unwrap_or(Value::Null);
    }
    Ok(())
}

fn rewrite_user_model_references(
    user: &mut Value,
    baseline: &Settings,
    id: &str,
    old_model: Option<&str>,
    new_model: Option<&str>,
) -> Result<()> {
    let active = user
        .get("active_provider")
        .and_then(Value::as_str)
        .or(baseline.active_provider.as_deref());
    if let Some(selected) = user.get("model").and_then(Value::as_str) {
        let (matches, qualified) = match selected.split_once("::") {
            Some((provider, model)) => (
                provider == id && old_model.is_none_or(|old| old == model),
                true,
            ),
            None => (
                active == Some(id) && old_model.is_none_or(|old| old == selected),
                false,
            ),
        };
        if matches {
            if let Some(model) = new_model {
                user["model"] = json!(if qualified {
                    format!("{id}::{model}")
                } else {
                    model.to_owned()
                });
            } else {
                user.as_object_mut()
                    .context("settings must be an object")?
                    .remove("model");
            }
        }
    }
    if user.get("active_model_selection").is_some_and(|selection| {
        selection["source_profile"].as_str() == Some(id)
            && old_model.is_none_or(|old| selection["model"].as_str() == Some(old))
    }) {
        if let Some(model) = new_model {
            user["active_model_selection"]["model"] = json!(model);
        } else {
            user.as_object_mut()
                .context("settings must be an object")?
                .remove("active_model_selection");
        }
    }
    Ok(())
}

// Hash only the editable settings document, never the credentials file. This
// opaque target-local token is returned by the private settings API, not catalog.
fn settings_revision(user: &Value) -> Result<String> {
    Ok(format!(
        "settings-v1:{:x}",
        Sha256::digest(serde_json::to_vec(user)?)
    ))
}

fn ensure_editor_revision(user: &Value, expected: Option<&str>) -> Result<()> {
    if let Some(expected) = expected {
        anyhow::ensure!(
            expected == settings_revision(user)?,
            "[provider_probe_changed] Configuration changed since this draft was loaded; reload and review before saving"
        );
    }
    Ok(())
}

#[derive(PartialEq)]
struct SaveSnapshot {
    user: Value,
    credential: Option<String>,
}

impl SaveSnapshot {
    fn read(path: &Path, id: &str) -> Result<Self> {
        Ok(Self {
            user: kcoder_config::read_settings_file(path)?,
            credential: CredentialStore::load_from(&path.with_file_name("credentials.json"))?
                .credentials
                .get(id)
                .cloned(),
        })
    }
}

#[cfg(test)]
fn save(path: &Path, baseline: &Settings, input: ProviderUpsertParams) -> Result<()> {
    commit(path, baseline, input, None).map(|_| ())
}

fn commit(
    path: &Path,
    baseline: &Settings,
    input: ProviderUpsertParams,
    expected: Option<&SaveSnapshot>,
) -> Result<String> {
    let (id, format, key) = validate_input(&input)?;
    let _mutation_lock = lock_provider_mutation(path)?;
    if let Some(expected) = expected {
        anyhow::ensure!(
            &SaveSnapshot::read(path, &id)? == expected,
            "[provider_probe_changed] Configuration changed during validation; retry saving"
        );
    }
    // Serialize concurrent App writers with the normal user-settings scope lock.
    // Credentials are stored separately; existing secrets never enter the response.
    let committed = kcoder_config::update_settings_and_credentials(path, |user, credentials| {
        ensure_editor_revision(user, input.expected_revision.as_deref())?;
        if let Some(expected) = expected {
            anyhow::ensure!(
                user == &expected.user,
                "[provider_probe_changed] Configuration changed during validation; retry saving"
            );
        }
        let value = profile_value(baseline, user, &id, &input, format)?;
        if let Some(original) = input.original_model.as_deref().filter(|original| *original != input.model.trim()) {
            rewrite_user_model_references(user, baseline, &id, Some(original), Some(input.model.trim()))?;
        }
        if user.get("providers").is_none() {
            // Materialize only the already-effective profiles, never built-in defaults.
            user["providers"] = serde_json::to_value(&baseline.providers)?;
        }
        user["providers"]
            .as_object_mut()
            .context("providers must be an object")?
            .insert(id.clone(), value);
        if input.make_default
            || user.get("active_provider").is_none() && baseline.active_provider.is_none()
        {
            user["active_provider"] = json!(id);
        }
        if input.make_default && user
            .get("active_provider")
            .and_then(Value::as_str)
            .or(baseline.active_provider.as_deref())
            == Some(id.as_str())
        {
            // Selecting/editing the default API owns its default model. Remove
            // an obsolete user-level override; project and CLI layers remain untouched.
            user.as_object_mut()
                .context("settings must be an object")?
                .remove("model");
            user.as_object_mut().context("settings must be an object")?.remove("active_model_selection");
        }
        if let Some(key) = &key {
            if let Some(expected) = expected {
                anyhow::ensure!(credentials.credentials.get(&id) == expected.credential.as_ref(),
                    "[provider_probe_changed] Credentials changed during validation; retry saving");
            }
            credentials.set_api_key(&id, key.trim().to_owned())?;
        }
        Ok(())
    })
    .map_err(|error| {
        if error.chain().any(|cause| cause.to_string().contains("[provider_transaction_pending]")) {
            anyhow::anyhow!("[provider_transaction_pending] Save interrupted; refresh to recover settings and credentials")
        } else if error.chain().any(|cause| cause.to_string().contains("[provider_probe_changed]")) {
            anyhow::anyhow!("[provider_probe_changed] Configuration changed during validation; refresh and retry")
        } else {
            error.context("Failed to save provider settings")
        }
    })?;
    settings_revision(&committed)
}

fn merge_fields(base: &mut Value, overlay: &Value) {
    merge_fields_at(base, overlay, &mut Vec::new(), false);
}

fn merge_profile_fields(base: &mut Value, overlay: &Value) {
    merge_fields_at(base, overlay, &mut Vec::new(), true);
}

fn merge_fields_at(base: &mut Value, overlay: &Value, path: &mut Vec<String>, profile_root: bool) {
    if let (Some(base), Some(overlay)) = (base.as_object_mut(), overlay.as_object()) {
        let provider = profile_root || path.len() == 2 && path[0] == "providers";
        for (key, value) in overlay {
            if provider && key == "model" && overlay.contains_key("default_model") {
                continue;
            }
            let key = if provider && key == "model" {
                "default_model"
            } else {
                key.as_str()
            };
            if (key == "models" || key == "extra_body") && provider {
                base.insert(key.to_owned(), value.clone());
                continue;
            }
            match base.get_mut(key) {
                Some(existing) => {
                    path.push(key.to_owned());
                    merge_fields_at(existing, value, path, false);
                    path.pop();
                }
                None => {
                    base.insert(key.to_owned(), value.clone());
                }
            }
        }
    } else {
        *base = overlay.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_rename_and_provider_delete_reconcile_only_matching_user_selections() {
        for selected in ["user-model", "custom::user-model"] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("settings.json");
            let baseline = Settings::default();
            save(&path, &baseline, input()).unwrap();
            kcoder_config::update_settings_file(&path, |user| {
                user["model"] = json!(selected);
                user["active_model_selection"] =
                    json!({"source_profile":"custom","model":"user-model"});
                Ok(())
            })
            .unwrap();
            let mut rename = input();
            rename.original_model = Some("user-model".into());
            rename.model = "renamed".into();
            rename.make_default = false;
            save(&path, &baseline, rename).unwrap();
            let saved = kcoder_config::read_settings_file(&path).unwrap();
            assert_eq!(
                saved["model"],
                if selected.contains("::") {
                    "custom::renamed"
                } else {
                    "renamed"
                }
            );
            assert_eq!(saved["active_model_selection"]["model"], "renamed");
            let resolved = kcoder_config::validate_and_resolve_settings_document(&saved).unwrap();
            assert!(resolved.providers["custom"].has_model("renamed"));
            let replacement = baseline.active_provider.as_deref().unwrap();
            remove_provider(
                &path,
                &baseline,
                deletion("custom", Some(replacement), false),
            )
            .unwrap();
            let saved = kcoder_config::read_settings_file(&path).unwrap();
            assert!(saved.get("model").is_none());
            assert!(saved.get("active_model_selection").is_none());
            kcoder_config::validate_and_resolve_settings_document(&saved).unwrap();
        }
        let baseline = Settings::default();
        let mut unrelated = json!({"active_provider":"other", "model":"other::same",
            "active_model_selection":{"source_profile":"other","model":"same"}});
        let before = unrelated.clone();
        rewrite_user_model_references(&mut unrelated, &baseline, "removed", None, None).unwrap();
        assert_eq!(unrelated, before);
    }

    #[test]
    fn editable_model_names_share_the_creation_length_limit() {
        let mut value = input();
        value.model = "m".repeat(512);
        value.original_model = Some(value.model.clone());
        assert!(validate_input(&value).is_ok());
        value.original_model = Some("m".repeat(513));
        assert!(validate_input(&value).is_err());
    }

    #[test]
    fn legacy_alias_is_retained_when_adding_another_model() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let mut baseline = Settings::default();
        let original = baseline.providers.values().next().unwrap().clone();
        baseline.providers.clear();
        let mut saved = serde_json::to_value(&original).unwrap();
        let name = saved
            .as_object_mut()
            .unwrap()
            .remove("default_model")
            .unwrap();
        saved["model"] = name.clone();
        kcoder_config::update_settings_file(&path, |user| {
            user["providers"] = json!({"custom":saved});
            user["active_provider"] = json!("custom");
            Ok(())
        })
        .unwrap();
        let mut next = input();
        next.endpoint = original.endpoint;
        next.api_format = original.api_format.as_str().into();
        next.make_default = false;
        save(&path, &baseline, next).unwrap();
        let value = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(
            value["providers"]["custom"]["models"]
                .as_object()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(value["providers"]["custom"]["default_model"], name);
        assert!(value["providers"]["custom"].get("model").is_none());
    }

    #[test]
    fn model_bodies_are_independent_and_new_models_do_not_inherit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        let mut first = input();
        first.model_extra_body = Some(
            json!({"thinking":{"type":"adaptive"}})
                .as_object()
                .unwrap()
                .clone(),
        );
        save(&path, &baseline, first).unwrap();
        let mut second = input();
        second.model = "second-model".into();
        second.make_default = false;
        second.api_key = None;
        save(&path, &baseline, second).unwrap();
        let rows = list(&path, &baseline).unwrap().profiles;
        assert_eq!(
            rows.iter()
                .find(|p| p.model == "user-model")
                .unwrap()
                .extra_body["thinking"]["type"],
            "adaptive"
        );
        assert!(
            rows.iter()
                .find(|p| p.model == "second-model")
                .unwrap()
                .extra_body
                .is_empty()
        );
        let user = kcoder_config::read_settings_file(&path).unwrap();
        let mut settings = kcoder_config::validate_and_resolve_settings_document(&user).unwrap();
        settings
            .apply_discovered_model("custom", "second-model")
            .unwrap();
        assert!(settings.provider_extra_body.is_empty());
        settings
            .apply_discovered_model("custom", "user-model")
            .unwrap();
        assert_eq!(settings.provider_extra_body["thinking"]["type"], "adaptive");
    }

    #[test]
    fn extra_body_round_trip_preserve_replace_and_clear() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let mut baseline = Settings::default();
        let mut request = input();
        request.model_extra_body = Some(
            json!({"thinking":{"type":"adaptive"},"reasoning_split":true})
                .as_object()
                .unwrap()
                .clone(),
        );
        save(&path, &baseline, request).unwrap();
        let saved = list(&path, &baseline).unwrap();
        assert!(saved.supports_model_extra_body);
        assert_eq!(
            saved
                .profiles
                .iter()
                .find(|p| p.id == "custom")
                .unwrap()
                .extra_body["thinking"]["type"],
            "adaptive"
        );
        let user = kcoder_config::read_settings_file(&path).unwrap();
        baseline.providers.insert(
            "custom".into(),
            serde_json::from_value(user["providers"]["custom"].clone()).unwrap(),
        );
        save(&path, &baseline, input()).unwrap();
        assert_eq!(
            list(&path, &baseline)
                .unwrap()
                .profiles
                .iter()
                .find(|p| p.id == "custom")
                .unwrap()
                .extra_body["reasoning_split"],
            true
        );
        let mut clear = input();
        clear.model_extra_body = Some(Default::default());
        save(&path, &baseline, clear).unwrap();
        assert!(
            list(&path, &baseline)
                .unwrap()
                .profiles
                .iter()
                .find(|p| p.id == "custom")
                .unwrap()
                .extra_body
                .is_empty()
        );
        let mut oversized = input();
        oversized.model_extra_body =
            Some(json!({"x":"x".repeat(65536)}).as_object().unwrap().clone());
        assert!(save(&path, &baseline, oversized).is_err());
    }

    #[test]
    fn recreating_deleted_provider_does_not_resurrect_old_models() {
        let (_directory, path, baseline) = deletion_fixture();
        remove_provider(&path, &baseline, deletion("beta", None, true)).unwrap();
        let mut recreated = input();
        recreated.id = "beta".into();
        recreated.make_default = false;
        save(&path, &baseline, recreated).unwrap();
        let value = kcoder_config::read_settings_file(&path).unwrap();
        let models = value["providers"]["beta"]["models"].as_object().unwrap();
        assert_eq!(models.len(), 1);
        assert!(models.contains_key("user-model"));
        assert_eq!(value["providers"]["beta"]["default_model"], "user-model");
    }

    #[test]
    fn multiple_models_preserve_original_default_limits_and_shared_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        save(&path, &baseline, input()).unwrap();
        let credentials = std::fs::read(path.with_file_name("credentials.json")).unwrap();
        let mut second = input();
        second.model = "second-model".into();
        second.context_window_tokens = 128000;
        second.max_output_tokens = 16000;
        second.make_default = false;
        second.api_key = None;
        save(&path, &baseline, second).unwrap();
        let saved = kcoder_config::read_settings_file(&path).unwrap();
        let profile = &saved["providers"]["custom"];
        assert_eq!(profile["default_model"], "user-model");
        assert_eq!(profile["models"].as_object().unwrap().len(), 2);
        assert_eq!(
            profile["models"]["user-model"]["context_window_tokens"],
            32000
        );
        assert_eq!(
            profile["models"]["second-model"]["context_window_tokens"],
            128000
        );
        assert_eq!(
            std::fs::read(path.with_file_name("credentials.json")).unwrap(),
            credentials
        );
        let listed = list(&path, &baseline).unwrap();
        assert!(listed.supports_multiple_models);
        let rows: Vec<_> = listed
            .profiles
            .iter()
            .filter(|row| row.id == "custom")
            .collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().filter(|row| row.is_default).count(), 1);
        assert!(rows.iter().all(|row| row.api_key_configured));
    }

    #[test]
    fn multiple_models_rename_and_delete_do_not_resurrect_or_remove_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        save(&path, &baseline, input()).unwrap();
        let mut second = input();
        second.model = "second".into();
        second.make_default = false;
        second.api_key = None;
        save(&path, &baseline, second).unwrap();
        let credentials = std::fs::read(path.with_file_name("credentials.json")).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut collision = input();
        collision.original_model = Some("user-model".into());
        collision.model = "second".into();
        assert!(save(&path, &baseline, collision).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let mut rename = input();
        rename.original_model = Some("user-model".into());
        rename.model = "renamed".into();
        rename.make_default = false;
        rename.api_key = None;
        save(&path, &baseline, rename).unwrap();
        let mut stale_baseline = baseline.clone();
        stale_baseline.providers.insert(
            "custom".into(),
            serde_json::from_value(
                kcoder_config::read_settings_file(&path).unwrap()["providers"]["custom"].clone(),
            )
            .unwrap(),
        );
        let mut deletion = deletion("custom", None, false);
        deletion.model = Some("renamed".into());
        remove_provider(&path, &stale_baseline, deletion).unwrap();
        let listed = list(&path, &stale_baseline).unwrap();
        let rows: Vec<_> = listed
            .profiles
            .iter()
            .filter(|row| row.id == "custom")
            .collect();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model, "second");
        assert!(rows[0].is_provider_default);
        assert_eq!(
            std::fs::read(path.with_file_name("credentials.json")).unwrap(),
            credentials
        );
        let mut last = self::deletion("custom", None, false);
        last.model = Some("second".into());
        assert!(remove_provider(&path, &stale_baseline, last).is_err());
    }

    #[test]
    fn adding_model_cannot_silently_replace_shared_connection() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        save(&path, &baseline, input()).unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut second = input();
        second.model = "another".into();
        second.endpoint = "https://different.example.invalid/v1".into();
        assert!(save(&path, &baseline, second).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn explicit_model_capabilities_are_saved_and_read_without_inference() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let mut value = serde_json::to_value(input()).unwrap();
        let capabilities = json!({"text":true,"tools":false,"vision":false,"reasoning":false,"structured_output":false});
        value["capabilities"] = capabilities.clone();
        let selected_input = serde_json::from_value::<ProviderUpsertParams>(value).unwrap();
        let baseline = Settings::default();
        save(&path, &baseline, selected_input).unwrap();
        let saved = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(saved["providers"]["custom"]["capabilities"], capabilities);
        let listed = serde_json::to_value(list(&path, &baseline).unwrap()).unwrap();
        assert_eq!(
            listed["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .find(|profile| profile["id"] == "custom")
                .unwrap()["capabilities"],
            capabilities
        );

        // Explicit renames may omit capability fields without resetting the model.
        let mut legacy_wire = serde_json::to_value(input()).unwrap();
        legacy_wire.as_object_mut().unwrap().remove("capabilities");
        legacy_wire["endpoint"] = json!("https://updated.example.invalid/v1");
        legacy_wire["model"] = json!("updated-user-model");
        legacy_wire["originalModel"] = json!("user-model");
        let legacy_input = serde_json::from_value::<ProviderUpsertParams>(legacy_wire).unwrap();
        assert!(legacy_input.capabilities.is_none());
        save(&path, &baseline, legacy_input).unwrap();

        let saved = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(saved["providers"]["custom"]["capabilities"], capabilities);
        assert_eq!(
            saved["providers"]["custom"]["endpoint"],
            "https://updated.example.invalid/v1"
        );
        assert_eq!(
            saved["providers"]["custom"]["default_model"],
            "updated-user-model"
        );
        let listed = serde_json::to_value(list(&path, &baseline).unwrap()).unwrap();
        assert_eq!(
            listed["profiles"]
                .as_array()
                .unwrap()
                .iter()
                .find(|profile| profile["id"] == "custom")
                .unwrap()["capabilities"],
            capabilities
        );
    }

    #[test]
    fn candidate_authentication_can_reenable_existing_environment_overrides() {
        let mut baseline = Settings::default();
        let mut profile = kcoder_config::default_active_provider_config();
        profile.authentication = kcoder_types::ProviderAuthentication::None;
        baseline
            .providers
            .insert("local-test".into(), profile.clone());
        baseline
            .credential_overrides
            .insert("local-test".into(), "environment-fixture-key".into());
        profile.authentication = kcoder_types::ProviderAuthentication::ApiKey;
        assert_eq!(
            candidate_key(&baseline, "local-test", &profile, None, None).as_deref(),
            Some("environment-fixture-key")
        );
        profile.authentication = kcoder_types::ProviderAuthentication::None;
        assert!(
            candidate_key(
                &baseline,
                "local-test",
                &profile,
                Some("new-key".into()),
                Some("stored-key".into())
            )
            .is_none()
        );
        profile.authentication = kcoder_types::ProviderAuthentication::ApiKey;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let mut saved_profile = serde_json::to_value(&profile).unwrap();
        saved_profile["authentication"] = json!({"mode":"api_key"});
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "providers":{"local-test":saved_profile},"active_provider":"local-test"
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(
            list(&path, &baseline)
                .unwrap()
                .profiles
                .iter()
                .find(|profile| profile.id == "local-test")
                .unwrap()
                .api_key_configured
        );
    }

    #[test]
    fn editor_revision_rejects_stale_writes_and_accepts_explicit_reload() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        save(&path, &baseline, input()).unwrap();
        let loaded = list(&path, &baseline).unwrap();
        assert!(loaded.supports_optimistic_concurrency);
        let old_revision = loaded.revision.unwrap();
        let mut first = input();
        first.expected_revision = Some(old_revision.clone());
        first.max_output_tokens = 2048;
        save(&path, &baseline, first).unwrap();
        let settings_before = std::fs::read(&path).unwrap();
        let credentials_before = std::fs::read(path.with_file_name("credentials.json")).unwrap();
        let mut stale = input();
        stale.expected_revision = Some(old_revision);
        stale.max_output_tokens = 1024;
        stale.api_key = Some("stale-candidate-key".into());
        let error = save(&path, &baseline, stale).unwrap_err().to_string();
        assert!(error.contains("[provider_probe_changed]"));
        assert!(!error.contains("stale-candidate-key"));
        assert_eq!(std::fs::read(&path).unwrap(), settings_before);
        assert_eq!(
            std::fs::read(path.with_file_name("credentials.json")).unwrap(),
            credentials_before
        );
        let mut refreshed = input();
        refreshed.expected_revision = list(&path, &baseline).unwrap().revision;
        refreshed.max_output_tokens = 1024;
        save(&path, &baseline, refreshed).unwrap();
        assert_eq!(
            list(&path, &baseline)
                .unwrap()
                .profiles
                .iter()
                .find(|profile| profile.id == "custom")
                .unwrap()
                .max_output_tokens,
            1024
        );
    }

    #[test]
    fn model_reasoning_policy_survives_save_read_and_rejects_conflicting_json() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        let mut draft = input();
        draft.capabilities = Some(kcoder_app_protocol::ProviderModelCapabilities { text: true, tools: true, vision: false, reasoning: true, structured_output: false });
        draft.reasoning_effort = Some("high".into());
        draft.reasoning_policy = Some(kcoder_types::ModelReasoningPolicy { mode: kcoder_types::ReasoningControlMode::Optional, efforts: vec![kcoder_types::ReasoningEffort::None, kcoder_types::ReasoningEffort::High] });
        save(&path, &baseline, draft).unwrap();
        let saved = list(&path, &baseline).unwrap();
        let profile = saved.profiles.iter().find(|profile| profile.id == "custom").unwrap();
        assert_eq!(profile.reasoning_policy.as_ref().unwrap().mode, kcoder_types::ReasoningControlMode::Optional);
        let before = std::fs::read(&path).unwrap();
        let mut draft = input();
        draft.model_extra_body = Some(json!({"thinking":{"type":"enabled"}}).as_object().unwrap().clone());
        assert!(save(&path, &baseline, draft).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    fn input() -> ProviderUpsertParams {
        ProviderUpsertParams {
            expected_revision: None,
            chat_protocol: None,
            reasoning_effort: None,
            reasoning_policy: None,
            extra_body: None,
            model_extra_body: None,
            original_model: None,
            capabilities: None,
            authentication: None,
            id: "custom".into(),
            api_format: "openai_chat_completions".into(),
            endpoint: "https://example.invalid/v1".into(),
            model: "user-model".into(),
            context_window_tokens: 32000,
            max_output_tokens: 4096,
            api_key: Some("fixture-secret".into()),
            make_default: true,
        }
    }

    #[test]
    fn provider_settings_reads_partial_overrides_and_keeps_removed_profiles_removed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        let id = baseline.providers.keys().next().unwrap().clone();
        kcoder_config::update_settings_file(&path, |user| {
            user["providers"] = json!({id.clone(): {"default_model": "partial-model"}});
            Ok(())
        })
        .unwrap();
        assert!(
            list(&path, &baseline)
                .unwrap()
                .profiles
                .iter()
                .any(|profile| profile.model == "partial-model")
        );
        kcoder_config::update_settings_file(&path, |user| {
            user["providers"] = json!({});
            Ok(())
        })
        .unwrap();
        let mut new_profile = input();
        new_profile.api_key = None;
        save(&path, &baseline, new_profile).unwrap();
        let persisted = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(persisted["providers"].as_object().unwrap().len(), 1);
        assert!(persisted["providers"].get(&id).is_none());
    }

    #[test]
    fn provider_settings_preflight_rejects_missing_credentials_without_network_requests() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        let mut missing = input();
        missing.api_key = None;
        save(&path, &baseline, missing).unwrap();
        assert!(validate_startup(&path, &baseline, &BTreeSet::new()).is_err());
        save(&path, &baseline, input()).unwrap();
        validate_startup(&path, &baseline, &BTreeSet::new()).unwrap();
    }

    #[test]
    fn provider_settings_persist_without_exposing_keys_and_preserve_other_fields() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let baseline = Settings::default();
        kcoder_config::update_settings_file(&path, |user| {
            user["studio_context"] = json!({"instructions":"preserve"});
            user["model"] = json!("stale-model");
            Ok(())
        })
        .unwrap();
        save(&path, &baseline, input()).unwrap();
        let first = list(&path, &baseline).unwrap();
        assert!(first.restart_required);
        assert!(
            first
                .profiles
                .iter()
                .any(|profile| profile.id == "custom" && profile.api_key_configured)
        );
        assert!(
            !serde_json::to_string(&first)
                .unwrap()
                .contains("fixture-secret")
        );
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(!stored.contains("fixture-secret"));
        assert!(stored.contains("preserve"));
        assert!(
            kcoder_config::read_settings_file(&path)
                .unwrap()
                .get("model")
                .is_none()
        );
        let mut update = input();
        update.api_key = None;
        update.model = "updated-model".into();
        save(&path, &baseline, update).unwrap();
        assert_eq!(
            CredentialStore::load_from(&path.with_file_name("credentials.json"))
                .unwrap()
                .credentials["custom"],
            "fixture-secret"
        );
        assert!(
            list(&path, &baseline)
                .unwrap()
                .profiles
                .iter()
                .any(|profile| profile.model == "updated-model")
        );
    }

    #[test]
    fn provider_settings_reject_unsafe_endpoint_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        for endpoint in [
            "file:///tmp/api",
            "https://key@example.invalid/v1",
            "https://example.invalid/?key=secret",
        ] {
            let mut value = input();
            value.endpoint = endpoint.into();
            assert!(save(&path, &Settings::default(), value).is_err());
            assert!(!path.exists());
            assert!(!path.with_file_name("credentials.json").exists());
        }
    }

    fn deletion_fixture() -> (tempfile::TempDir, std::path::PathBuf, Settings) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let mut baseline = Settings::default();
        let profile = baseline.providers.values().next().unwrap().clone();
        baseline.providers =
            BTreeMap::from([("alpha".into(), profile.clone()), ("beta".into(), profile)]);
        baseline.active_provider = Some("alpha".into());
        kcoder_config::update_settings_file(&path, |user| {
            user["providers"] = serde_json::to_value(&baseline.providers)?;
            user["active_provider"] = json!("alpha");
            user["studio_context"] = json!({"instructions": "preserve context"});
            Ok(())
        })
        .unwrap();
        CredentialStore::update_file(&path.with_file_name("credentials.json"), |credentials| {
            credentials.set_api_key("alpha", "fixture-alpha-key".into())?;
            credentials.set_api_key("beta", "fixture-beta-key".into())?;
            credentials.set_api_key("unrelated", "fixture-unrelated-key".into())
        })
        .unwrap();
        baseline.stored_provider_credentials =
            CredentialStore::load_from(&path.with_file_name("credentials.json"))
                .unwrap()
                .credentials;
        (directory, path, baseline)
    }

    fn deletion(
        id: &str,
        replacement: Option<&str>,
        remove_credentials: bool,
    ) -> ProviderDeleteParams {
        ProviderDeleteParams {
            model: None,
            replacement_model: None,
            id: id.into(),
            confirm: true,
            replacement_provider: replacement.map(str::to_owned),
            remove_credentials,
        }
    }

    #[test]
    fn provider_deletion_requires_confirmation_and_a_distinct_user_default_replacement() {
        let (_directory, path, baseline) = deletion_fixture();
        let before = std::fs::read(&path).unwrap();
        let credentials = std::fs::read(path.with_file_name("credentials.json")).unwrap();
        let mut unconfirmed = deletion("alpha", Some("beta"), true);
        unconfirmed.confirm = false;
        for request in [
            unconfirmed,
            deletion("alpha", Some("alpha"), true),
            deletion("alpha", Some("missing"), true),
            deletion("beta", Some("alpha"), true),
        ] {
            assert!(remove_provider(&path, &baseline, request).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(
                std::fs::read(path.with_file_name("credentials.json")).unwrap(),
                credentials
            );
        }
    }

    #[test]
    fn provider_deletion_replaces_default_without_reviving_it_and_respects_key_choice() {
        for remove_credentials in [false, true] {
            let (_directory, path, baseline) = deletion_fixture();
            assert!(
                remove_provider(
                    &path,
                    &baseline,
                    deletion("alpha", Some("beta"), remove_credentials)
                )
                .unwrap()
                .is_none()
            );
            let saved = kcoder_config::read_settings_file(&path).unwrap();
            assert_eq!(saved["active_provider"], "beta");
            assert!(saved["providers"].get("alpha").is_none());
            assert_eq!(saved["studio_context"]["instructions"], "preserve context");
            let listed = list(&path, &baseline).unwrap();
            assert_eq!(listed.profiles.len(), 1);
            assert_eq!(listed.profiles[0].id, "beta");
            assert!(listed.profiles[0].is_default);
            assert!(listed.restart_required);
            let keys =
                CredentialStore::load_from(&path.with_file_name("credentials.json")).unwrap();
            assert_eq!(keys.has_api_key("alpha"), !remove_credentials);
            assert!(keys.has_api_key("beta"));
            assert!(keys.has_api_key("unrelated"));
            assert!(
                !serde_json::to_string(&listed)
                    .unwrap()
                    .contains("fixture-alpha-key")
            );
            validate_startup(
                &path,
                &baseline,
                &BTreeSet::from(["alpha".into(), "beta".into()]),
            )
            .unwrap();
        }
    }

    #[test]
    fn provider_deletion_preserves_overlay_only_profiles_and_allows_empty_user_catalog() {
        let (_directory, path, mut baseline) = deletion_fixture();
        baseline
            .providers
            .insert("overlay-only".into(), baseline.providers["alpha"].clone());
        let before = std::fs::read(&path).unwrap();
        assert!(remove_provider(&path, &baseline, deletion("overlay-only", None, true)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        remove_provider(&path, &baseline, deletion("beta", None, false)).unwrap();
        remove_provider(&path, &baseline, deletion("alpha", None, false)).unwrap();
        let saved = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(saved["providers"], json!({}));
        assert_eq!(saved["active_provider"], Value::Null);
        assert!(list(&path, &baseline).unwrap().profiles.is_empty());
        assert!(baseline.providers.contains_key("overlay-only"));
        assert!(
            CredentialStore::load_from(&path.with_file_name("credentials.json"))
                .unwrap()
                .has_api_key("alpha")
        );
    }

    #[test]
    fn provider_deletion_selects_remaining_default_without_explicit_replacement() {
        let (_directory, path, baseline) = deletion_fixture();
        remove_provider(&path, &baseline, deletion("alpha", None, false)).unwrap();
        let saved = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(saved["active_provider"], "beta");
        assert_eq!(saved["providers"].as_object().unwrap().len(), 1);
        remove_provider(&path, &baseline, deletion("beta", None, false)).unwrap();
        let saved = kcoder_config::read_settings_file(&path).unwrap();
        assert_eq!(saved["providers"], json!({}));
        assert_eq!(saved["active_provider"], Value::Null);
        validate_startup(
            &path,
            &baseline,
            &BTreeSet::from(["alpha".into(), "beta".into()]),
        )
        .unwrap();
    }

    #[test]
    fn provider_deletion_and_concurrent_independent_writes_preserve_other_state() {
        let (_directory, path, baseline) = deletion_fixture();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        std::thread::scope(|scope| {
            let first = scope.spawn(|| {
                barrier.wait();
                remove_provider(&path, &baseline, deletion("beta", None, true)).unwrap();
            });
            let second = scope.spawn(|| {
                barrier.wait();
                let mut value = input();
                value.id = "gamma".into();
                value.make_default = false;
                save(&path, &baseline, value).unwrap();
            });
            let third = scope.spawn(|| {
                barrier.wait();
                kcoder_config::update_settings_file(&path, |user| {
                    user["studio_context"]["instructions"] = json!("concurrent context");
                    Ok(())
                })
                .unwrap();
                CredentialStore::update_file(&path.with_file_name("credentials.json"), |store| {
                    store.set_api_key("another", "fixture-another-key".into())
                })
                .unwrap();
            });
            first.join().unwrap();
            second.join().unwrap();
            third.join().unwrap();
        });
        let saved = kcoder_config::read_settings_file(&path).unwrap();
        assert!(saved["providers"].get("beta").is_none());
        assert!(saved["providers"].get("alpha").is_some());
        assert!(saved["providers"].get("gamma").is_some());
        assert_eq!(
            saved["studio_context"]["instructions"],
            "concurrent context"
        );
        let keys = CredentialStore::load_from(&path.with_file_name("credentials.json")).unwrap();
        assert!(!keys.has_api_key("beta"));
        for id in ["alpha", "gamma", "unrelated", "another"] {
            assert!(keys.has_api_key(id));
        }
    }

    #[test]
    fn provider_deletion_and_recreation_of_the_same_id_keep_configuration_and_key_together() {
        for _ in 0..16 {
            let (_directory, path, baseline) = deletion_fixture();
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let remove = scope.spawn(|| {
                    barrier.wait();
                    remove_provider(&path, &baseline, deletion("beta", None, true)).unwrap();
                });
                let recreate = scope.spawn(|| {
                    let mut value = input();
                    value.id = "beta".into();
                    value.make_default = false;
                    value.endpoint = baseline.providers["beta"].endpoint.clone();
                    value.api_format = baseline.providers["beta"].api_format.as_str().into();
                    value.context_window_tokens = baseline.providers["beta"].context_window_tokens;
                    value.max_output_tokens = baseline.providers["beta"].max_output_tokens;
                    barrier.wait();
                    save(&path, &baseline, value).unwrap();
                });
                remove.join().unwrap();
                recreate.join().unwrap();
            });
            let has_profile = kcoder_config::read_settings_file(&path).unwrap()["providers"]
                .get("beta")
                .is_some();
            let credentials =
                CredentialStore::load_from(&path.with_file_name("credentials.json")).unwrap();
            assert_eq!(has_profile, credentials.has_api_key("beta"));
            assert!(credentials.has_api_key("alpha"));
        }
    }

    #[test]
    fn provider_deletion_reports_partial_credential_cleanup_failure_without_undoing_removal() {
        let (_directory, path, baseline) = deletion_fixture();
        std::fs::rename(
            path.with_file_name("credentials.json.lock"),
            path.with_file_name("prior-credentials.lock"),
        )
        .unwrap();
        std::fs::create_dir(path.with_file_name("credentials.json.lock")).unwrap();
        let warning = remove_provider(&path, &baseline, deletion("beta", None, true)).unwrap();
        assert!(warning.unwrap().contains("credential cleanup failed"));
        assert!(
            kcoder_config::read_settings_file(&path).unwrap()["providers"]
                .get("beta")
                .is_none()
        );
        let credentials =
            CredentialStore::load_from(&path.with_file_name("credentials.json")).unwrap();
        assert!(credentials.has_api_key("beta"));
        assert!(credentials.has_api_key("alpha"));
    }
}
