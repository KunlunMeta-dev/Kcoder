//! A sealed catalog declaration permits first configuration, never saved-state authority.
use super::{
    NativeConnectivityLeaseFacade, installed_resources::NativeConnectivityInstalledPaths,
    main_public::NativeConnectivityPublicCall,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::connectivity::ConnectivityMethod;
use kcoder_types::integrations::core::*;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {
    #[serde(default)]
    after: String,
    #[serde(default)]
    limit: Option<u64>,
    #[serde(default)]
    category: Option<String>,
}
pub(super) fn read(
    caller: &NativeConnectivityPublicCall,
    installed: &NativeConnectivityInstalledPaths,
) -> Result<Option<IntegrationReply>> {
    if caller.call().method != ConnectivityMethod::ListConnections
        || NativeConnectivityLeaseFacade::observe(caller.context())?.is_some()
    {
        return Ok(None);
    }
    caller.verify(caller.context().scope())?;
    let params: ListParams = serde_json::from_value(serde_json::Value::Object(
        caller.call().request.payload.clone(),
    ))?;
    ensure!(
        params.after.is_empty()
            && params.limit.is_none_or(|limit| (1..=10).contains(&limit))
            && params
                .category
                .as_deref()
                .is_none_or(|value| ["applications", "channels"].contains(&value)),
        "CONNECTIVITY_CATALOG_PARAMS_INVALID"
    );
    let catalog = installed
        .catalog
        .as_ref()
        .context("CONNECTIVITY_CATALOG_NOT_OBSERVED")?;
    let request = &caller.call().request;
    Ok(Some(IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        status: IntegrationStatus::Completed,
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: IntegrationNullable::Value(
            json!({"catalog":catalog,"items":[],"nextCursor":null,
            "connectionObservationState":"unknown","reasonCode":"CONNECTIVITY_STORE_NOT_OBSERVED",
            "sources":[],"sourcesState":"unknown","taskSourcesState":"unknown",
            "taskFirstRoutingSupported":installed.task_first_routing_supported})
            .as_object()
            .unwrap()
            .clone(),
        ),
        error: IntegrationNullable::Null,
    }))
}
