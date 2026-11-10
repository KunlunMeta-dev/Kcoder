//! Direct native composition for Root's already accepted ordinary turn.
use super::rpc::configuration::EngineSnapshot;
use super::{NativeReviewedMemorySource, prepare_current_turn_memory};
use crate::app_server::integrations::core::{NativeIntegrationContext, NativeMemoryService};
use anyhow::{Context, Result};
use kcoder_engine::QueryEngine;
use kcoder_types::TurnAttemptIdentity;
use std::sync::Arc;

/// The caller keeps this inside the original history_append_scope and passes the real receipt.
pub(crate) fn prepare_native_turn_memory(
    engine: QueryEngine,
    actual_native: Option<NativeIntegrationContext>,
    accepted: &TurnAttemptIdentity,
) -> Result<QueryEngine> {
    let enabled = engine
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("MEMORY_TURN_CONTEXT_UNAVAILABLE"))?
        .integrations
        .knowledge
        .memory_center_enabled;
    if !enabled {
        return Ok(engine);
    }
    compose(engine, actual_native, accepted).map_err(|error| {
        crate::app_server::integrations::core::warn_memory_failure("turn_composition", &error);
        anyhow::anyhow!("MEMORY_TURN_CONTEXT_UNAVAILABLE")
    })
}
fn compose(
    engine: QueryEngine,
    actual_native: Option<NativeIntegrationContext>,
    accepted: &TurnAttemptIdentity,
) -> Result<QueryEngine> {
    let native = actual_native.context("MEMORY_TURN_NATIVE_AUTHORITY_UNAVAILABLE")?;
    EngineSnapshot::capture(&engine)?.verify_binding(&engine, &native)?;
    let source = NativeMemoryService::load(&native)?.context("MEMORY_TURN_SOURCE_UNAVAILABLE")?;
    let source: Arc<dyn NativeReviewedMemorySource> = Arc::new(source);
    let prepared = prepare_current_turn_memory(&native, accepted, &engine, Some(source))?
        .context("MEMORY_TURN_CONTEXT_UNAVAILABLE")?;
    engine.with_native_reviewed_memory_turn_context(prepared.binding())
}
