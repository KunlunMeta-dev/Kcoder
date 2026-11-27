//! Observe the peer registry using the active Engine's verified workspace and settings source.
use anyhow::Result;
use kcoder_engine::QueryEngine;
use kcoder_native_scope::NativeIntegrationContext;

pub use kcoder_native_journal::remote_registry::{
    NativeFirstPartyPeer, NativeRemoteRegistry, file_identity, program_pin,
};

pub fn observe(
    context: &NativeIntegrationContext,
    engine: &QueryEngine,
) -> Result<Option<NativeRemoteRegistry>> {
    NativeRemoteRegistry::observe(
        context,
        &|| engine.state.cwd(),
        &|| engine.settings_persistence_path(),
        kcoder_cli_commands::build_identity::version(),
    )
}
