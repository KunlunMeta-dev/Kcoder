//! Native scope negotiation and read-only observation.
use super::NativeIntegrationContext;
use anyhow::{Context, Result};
use kcoder_app_protocol::integrations::host::IntegrationScopeReadParams;
use kcoder_engine::QueryEngine;
use serde_json::Value;

pub(in crate::app_server) fn capture_scope(
    engine: &QueryEngine,
) -> Result<NativeIntegrationContext> {
    let path = engine
        .settings_persistence_path()
        .context("native profile unavailable")?;
    let profile = path.parent().context("native profile unavailable")?;
    let revision = engine
        .active_model_configuration_summary()
        .map(|summary| summary.revision)
        .unwrap_or_else(|_| "native-connection-lifecycle-v1".into());
    let mut native = NativeIntegrationContext::capture(
        profile,
        &engine.state.cwd(),
        &format!("connection-{}", uuid::Uuid::new_v4()),
        &revision,
    )?;
    if engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("INTEGRATION_SETTINGS_UNAVAILABLE"))?
        .integrations
        .connectivity
        .enabled
    {
        native.pin_lifecycle_revision()?;
    }
    Ok(native)
}

pub(in crate::app_server) fn read_scope(
    engine: &QueryEngine,
    context: Option<&mut NativeIntegrationContext>,
    params: Value,
) -> Result<Value> {
    let _: IntegrationScopeReadParams = serde_json::from_value(params)
        .map_err(|_| anyhow::anyhow!("INTEGRATION_SCOPE_INVALID_PARAMS"))?;
    let context = context.ok_or_else(|| anyhow::anyhow!("INTEGRATION_SCOPE_UNAVAILABLE"))?;
    let revision = engine
        .active_model_configuration_summary()
        .map(|summary| summary.revision)
        .unwrap_or_else(|_| "native-connection-lifecycle-v1".into());
    context.refresh_configuration_revision(revision)?;
    serde_json::to_value(context.scope()).map_err(Into::into)
}
