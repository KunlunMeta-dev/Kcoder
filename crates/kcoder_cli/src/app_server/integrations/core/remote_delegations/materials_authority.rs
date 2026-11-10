//! Bind the source material read to the actual Engine caller and accepted turn.
use anyhow::Result;
use kcoder_engine::QueryEngine;
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_tools::ToolContext;
use kcoder_types::{TurnAttemptIdentity, integrations::office::OfficeArtifactRef};

pub use kcoder_native_journal::{
    launch_record::RemoteMaterialDescriptor,
    remote_materials::{FrozenRemoteMaterial, MAX_MATERIAL_BYTES},
};

pub fn capture(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    attempt: &TurnAttemptIdentity,
    actual: &ToolContext,
    reference: &OfficeArtifactRef,
) -> Result<FrozenRemoteMaterial> {
    FrozenRemoteMaterial::capture(
        native,
        reference,
        &|| {
            super::authority::validate_caller(
                native,
                engine,
                attempt,
                actual,
                "freeze original remote material",
            )?;
            Ok(())
        },
        &|| actual.is_aborted(),
    )
}

#[cfg(test)]
#[path = "materials_tests.rs"]
mod tests;
