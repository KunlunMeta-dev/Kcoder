use anyhow::{Context, Result, bail};
use kcoder_app_protocol::{ProviderDeleteParams, ProviderUpsertParams};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_provider_transactions::{
    SaveSnapshot, USER_RUNTIME_OVERRIDE_FIELDS, candidate_key, commit, ensure_editor_revision,
    list, lock_provider_mutation, merge_profile_fields, remove_provider, settings_revision,
    user_provider_ids, validate_endpoint, validate_input, validate_startup, verify_before_save,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
mod discovery;
pub(super) use discovery::discover_models;

pub(super) fn templates(params: Value) -> Result<Value> {
    let _: kcoder_app_protocol::ProviderTemplatesParams = rpc_codec::decode(params)
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
    Ok(rpc_codec::encode(
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
    let validated = validate_input(&input)?;
    let path = engine
        .settings_persistence_path()
        .context("Provider configuration is unavailable for this runtime")?;
    let baseline = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("Runtime settings are unavailable"))?
        .clone();
    let snapshot = verify_before_save(&path, &baseline, &input, validated).await?;
    let thread_id = input.thread_id.clone();
    let saved_revision =
        tokio::task::spawn_blocking(move || commit(&path, &baseline, input, snapshot.as_ref()))
            .await??;
    let mut response = request(
        &engine,
        &Ok(state),
        kcoder_app_protocol::method::PROVIDERS_LIST,
        json!({"threadId":thread_id}),
    )?;
    response["savedRevision"] = json!(saved_revision);
    Ok(response)
}

/// Test the saved target configuration without committing, selecting a model,
/// or changing any accepted turn. Both settings and private credential authority
/// are rechecked after the await so a concurrent edit cannot yield stale success.
pub(super) async fn probe(engine: QueryEngine, params: Value) -> Result<Value> {
    let input: kcoder_app_protocol::ProviderProbeParams =
        rpc_codec::decode(params).map_err(|_| anyhow::anyhow!("Invalid provider probe fields"))?;
    let path = engine
        .settings_persistence_path()
        .context("Provider configuration unavailable")?;
    let before = SaveSnapshot::read(&path, &input.id)?;
    ensure_editor_revision(before.user(), Some(&input.expected_revision))?;
    let qualified = format!("{}::{}", input.id, input.model);
    let resolved = engine
        .resolve_client_model_configuration(&qualified)
        .map_err(|_| {
            anyhow::anyhow!("[provider_probe_configuration] Model or credentials unavailable")
        })?;
    let configuration_revision = kcoder_engine::model_configuration_summary(
        &resolved.0,
        kcoder_types::ModelConfigurationBoundary::NextTurn,
    )?
    .revision;
    anyhow::ensure!(
        input
            .expected_configuration_revision
            .as_ref()
            .is_none_or(|expected| *expected == configuration_revision),
        "[provider_probe_changed] Effective model configuration changed; refresh and test again"
    );
    let credential = resolved.0.resolve_provider_api_key(Some(&input.id), None);
    let outcome = super::provider_probe::verify_settings(&engine, resolved.0).await;
    let after = engine
        .resolve_client_model_configuration(&qualified)
        .map_err(|_| {
            anyhow::anyhow!(
                "[provider_probe_changed] Model configuration changed during the connection test"
            )
        })?;
    anyhow::ensure!(
        kcoder_engine::model_configuration_summary(
            &after.0,
            kcoder_types::ModelConfigurationBoundary::NextTurn
        )?
        .revision
            == configuration_revision
            && after.0.resolve_provider_api_key(Some(&input.id), None) == credential,
        "[provider_probe_changed] Effective model configuration or credentials changed during the connection test"
    );
    anyhow::ensure!(
        SaveSnapshot::read(&path, &input.id)? == before,
        "[provider_probe_changed] Configuration or credentials changed during the connection test; refresh and test again"
    );
    let error_type = outcome.err().map(|error| probe_error_category(&error));
    Ok(rpc_codec::encode(
        kcoder_app_protocol::ProviderProbeResult {
            configuration_revision,
            provider: input.id,
            model: input.model,
            revision: input.expected_revision,
            success: error_type.is_none(),
            error_type,
        },
    )?)
}

fn probe_error_category(error: &anyhow::Error) -> String {
    let message = error.to_string();
    [
        "authentication",
        "permission",
        "quota",
        "rate_limit",
        "overloaded",
        "model",
        "timeout",
        "network",
        "configuration",
        "response",
    ]
    .into_iter()
    .find(|category| message.starts_with(&format!("[provider_probe_{category}]")))
    .unwrap_or("configuration")
    .into()
}

/// Only this profile's user file owns these root fields. Never interpret a
/// submitted path, remove a model-specific setting, or edit a higher layer.
pub(super) fn clear_user_override(
    engine: &QueryEngine,
    state: &Result<ProviderSettingsState>,
    params: Value,
) -> Result<Value> {
    let input: kcoder_app_protocol::ProviderClearUserOverrideParams =
        rpc_codec::decode(params).map_err(|_| anyhow::anyhow!("Invalid user override fields"))?;
    anyhow::ensure!(
        USER_RUNTIME_OVERRIDE_FIELDS.contains(&input.field.as_str()),
        "Unsupported user override field"
    );
    let path = engine
        .settings_persistence_path()
        .context("Provider configuration unavailable")?;
    let _mutation_lock = lock_provider_mutation(&path)?;
    let saved = kcoder_config::update_settings_file(&path, |user| {
        ensure_editor_revision(user, Some(&input.expected_revision))?;
        let object = user.as_object_mut().context("settings must be an object")?;
        anyhow::ensure!(
            object.remove(&input.field).is_some(),
            "User override no longer exists; refresh settings"
        );
        Ok(())
    })?;
    let mut response = request(
        engine,
        state,
        kcoder_app_protocol::method::PROVIDERS_LIST,
        json!({"threadId":input.thread_id}),
    )?;
    response["savedRevision"] = json!(settings_revision(&saved)?);
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
    let mut thread_id = None;
    if method == kcoder_app_protocol::method::PROVIDERS_DELETE {
        let input: ProviderDeleteParams = serde_json::from_value(params)
            .map_err(|_| anyhow::anyhow!("Invalid provider deletion fields"))?;
        warning = remove_provider(&path, &baseline, input)?;
    } else if method == kcoder_app_protocol::method::PROVIDERS_UPSERT {
        bail!("Provider saving requires the asynchronous transaction handler");
    } else {
        let input: kcoder_app_protocol::ProviderListParams = rpc_codec::decode(params)
            .map_err(|_| anyhow::anyhow!("Invalid provider list scope"))?;
        thread_id = input.thread_id;
    }
    if method == kcoder_app_protocol::method::PROVIDERS_VALIDATE {
        validate_startup(&path, &baseline, &state.startup_user_ids)?;
        return Ok(json!({"valid": true}));
    }
    let mut result = list(&path, &baseline, kcoder_engine::model_configuration_summary)?;
    if let Some(sources) = engine.model_configuration_file_sources()? {
        for profile in &mut result.profiles {
            let source = sources
                .iter()
                .find(|source| source.provider == profile.id && source.model == profile.model);
            profile.available_in_current_config = Some(source.is_some());
            profile.file_sources = source.map(|source| source.fields.clone());
        }
    }

    let next_profiles = engine.current_configured_model_profiles()?;
    for profile in &mut result.profiles {
        profile.next_turn_configuration = next_profiles
            .iter()
            .find(|model| model.profile_name == profile.id && model.model == profile.model)
            .and_then(|model| model.configuration.clone());
    }
    // The host validates the selected resident thread and its connection owner.
    // An unscoped bootstrap Engine is never a user conversation snapshot.
    result.current_turn_configuration = if thread_id.is_some() {
        Some(engine.active_model_configuration_summary()?)
    } else {
        None
    };
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
