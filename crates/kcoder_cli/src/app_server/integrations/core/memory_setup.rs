//! Apply the saved memory opt-in during the authenticated native scope handshake.
use super::{NativeIntegrationContext, NativeMemoryService};
use kcoder_engine::QueryEngine;
mod source;
pub(super) use source::MemorySetupWitness;

pub(in crate::app_server) fn prepare_enabled_memory_for_connection(
    engine: &QueryEngine,
    native: &NativeIntegrationContext,
) {
    let enabled = engine
        .settings
        .read()
        .is_ok_and(|settings| settings.integrations.knowledge.memory_center_enabled);
    if enabled && let Err(error) = NativeMemoryService::prepare_enabled(native) {
        // Preserve the native context and the turn's fail-closed memory checks.
        // Neither setup failure nor a damaged source permits an empty fallback.
        warn_memory_failure("connection_setup", &error);
    }
}

/// Log only known codes, never arbitrary errors that can include private material.
pub(crate) fn warn_memory_failure(stage: &'static str, error: &anyhow::Error) {
    tracing::warn!(
        memory_stage = stage,
        memory_code = safe_memory_code(error),
        "Native memory context unavailable"
    );
}

fn safe_memory_code(error: &anyhow::Error) -> &'static str {
    const CODES: &[&str] = &[
        "MEMORY_TURN_SOURCE_UNAVAILABLE",
        "MEMORY_TURN_NATIVE_AUTHORITY_UNAVAILABLE",
        "MEMORY_RESOURCE_DENIED",
        "MEMORY_BUSY",
        "MEMORY_SETUP_SOURCE_MISSING",
        "MEMORY_SETUP_WITNESS_INVALID",
        "MEMORY_NATIVE_STORAGE_CHANGED",
        "MEMORY_TURN_SNAPSHOT_UNAVAILABLE",
        "MEMORY_TURN_STATE_MISMATCH",
        "MEMORY_TURN_CONFIGURATION_CHANGED",
        "MEMORY_TURN_SOURCE_OWNER_MISMATCH",
        "KNOWLEDGE_CALLER_SCOPE_MISMATCH",
        "KNOWLEDGE_RPC_CONFIGURATION_CHANGED",
        "INTEGRATION_IDENTITY_REVOKED",
        "INTEGRATION_SCOPE_MISMATCH",
        "INTEGRATION_STORAGE_BUSY",
        "INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED",
        "INTEGRATION_STORAGE_OWNER_MISMATCH",
        "INTEGRATION_STORAGE_CONTROL_CHANGED",
        "INTEGRATION_STORAGE_DIRECTORY_CHANGED",
    ];
    error
        .chain()
        .find_map(|cause| {
            let message = cause.to_string();
            CODES.iter().copied().find(|code| *code == message)
        })
        .unwrap_or("MEMORY_TURN_CONTEXT_UNAVAILABLE")
}

#[cfg(test)]
mod tests;
