//! First-use static checks must not initialize the Office namespace. Native
//! identity and the metadata-only model resolver remain the actual authorities.
use super::super::startup_binding::NativeOfficeStartupBinding;
use super::*;
use crate::app_server::integrations::core::model_policy::NativeModelPolicyResolver;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_config::integrations::office::validate_office_definition;
#[cfg(test)]
#[path = "preflight_tests.rs"]
mod tests;

pub(super) fn authorize_observation(
    native: &NativeIntegrationContext,
    request: &IntegrationRequest,
) -> Result<()> {
    native.validate_scope(&request.scope)?;
    super::super::organization_policy::authorize(native, "read", &request.request_id)?;
    Ok(())
}

// The probe is a factory: neither constructing it nor polling it may happen
// before the current native read decision succeeds.
pub(super) async fn observe_after_authorization<T, A, O, F>(authorize: A, observe: O) -> Result<T>
where
    A: FnOnce() -> Result<()>,
    O: FnOnce() -> F,
    F: std::future::Future<Output = T>,
{
    authorize()?;
    Ok(observe().await)
}

pub(super) fn definition(request: &IntegrationRequest) -> Result<OfficeAssistantDefinition> {
    ensure!(request.payload.len() == 1, "OFFICE_INVALID_INPUT");
    let definition: OfficeAssistantDefinition = rpc_codec::decode(
        request
            .payload
            .get("definition")
            .cloned()
            .context("OFFICE_INVALID_INPUT")?,
    )?;
    validate_office_definition(&definition)?;
    Ok(definition)
}

pub(super) async fn generator(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    resources: Option<&NativeOfficeStartupBinding>,
    cancel: &CancellationToken,
) -> Value {
    let observed = async {
        resources
            .context("OFFICE_COMPONENT_UNAVAILABLE")?
            .resolve(native, engine, cancel)
            .await?
            .readiness(native, cancel)
            .await
    }
    .await;
    observed.unwrap_or_else(|_| json!({"status":"unknown","supportedFormats":[],"reasonCode":"OFFICE_COMPONENT_UNCONFIRMED"}))
}

pub(super) async fn uninitialized(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    request: &IntegrationRequest,
    generator: Value,
    readiness: Option<
        &Arc<crate::app_server::integrations::connectivity::NativeOfficeReadinessPort>,
    >,
    cancel: &CancellationToken,
) -> Result<Value> {
    authorize_observation(native, request)?;
    request.validate(false)?;
    let definition = definition(request)?;
    let settings = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("OFFICE_SETTINGS_UNAVAILABLE"))?
        .integrations
        .office
        .clone();
    settings.validate()?;
    ensure!(settings.enabled, "OFFICE_DISABLED");
    let mut model_request = request.clone();
    model_request.payload = serde_json::to_value(IntegrationModelResolutionRequest {
        selection: serde_json::from_value(serde_json::to_value(&definition.model_selection)?)?,
        requirements: IntegrationModelRequirements {
            tools: definition
                .allowed_tools
                .as_ref()
                .is_none_or(|tools| !tools.is_empty()),
            ..Default::default()
        },
    })?
    .as_object()
    .context("OFFICE_INVALID_INPUT")?
    .clone();
    let model = Arc::new(NativeModelPolicyResolver::capture(native, engine)?)
        .resolve_owned(model_request, cancel)
        .await;
    native.validate_scope(&request.scope)?;
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    let (model, model_reason) = match model {
        Ok(value) => (serde_json::to_value(value)?, None),
        Err(_) => (Value::Null, Some("OFFICE_MODEL_UNCONFIRMED")),
    };
    let readiness = match readiness {
        Some(port) => port.observe(native, cancel).await.ok(),
        None => None,
    }.unwrap_or_else(|| json!({"state":"unknown","observations":[],"capabilities":[],"reasonCode":"OFFICE_READINESS_UNOBSERVED"}));
    authorize_observation(native, request)?;
    ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
    let mut references = definition.resources.clone();
    if let Some(workflow) = &definition.workflow_ref {
        references.push(OfficeResourceRef {
            kind: "workflow".into(),
            id: workflow.definition_id.clone(),
            revision: workflow.version.to_string(),
        });
    }
    let observed_at = chrono::Utc::now().timestamp_millis();
    Ok(json!({
        "definitionValid":true,"staticOnly":true,"storageState":"not_initialized",
        "requiredCapabilities":definition.capabilities,"requiredResources":definition.resources,
        "generator":generator,"allowedFormats":settings.allowed_formats.iter().map(|format| format.extension()).collect::<Vec<_>>(),
        "model":model,"modelReasonCode":model_reason,
        "resources":references.into_iter().map(|reference| json!({"reference":reference,"state":"unknown","reasonCode":"OFFICE_SOURCE_UNCONFIRMED"})).collect::<Vec<_>>(),
        "readiness":readiness,
        "requiredInputFields":definition.input_schema.get("required").and_then(Value::as_array).cloned().unwrap_or_default(),
        "identityGeneration":request.scope.identity_generation,"targetRevision":request.scope.target_revision,
        "observedAtMs":observed_at,"expiresAtMs":observed_at.saturating_add(60_000),
        "adoptable":false,"reasonCode":"OFFICE_RECHECK_ON_ADOPTION"
    }))
}
