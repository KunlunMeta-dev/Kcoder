//! Actual Native installers, retained in the app-server host.
use anyhow::Result;
use kcoder_engine::QueryEngine;

pub(super) fn install_native_engine(engine: QueryEngine) -> Result<QueryEngine> {
    let engine =
        if crate::app_server::integrations::core::NativeIntegrationContext::organization_launch_required()?
        {
            let native = crate::app_server::integrations::core::capture_scope(&engine)?;
            crate::app_server::integrations::core::organization_model::install(&native, engine)?
        } else {
            engine
        };
    crate::app_server::integrations::knowledge::install_native_wiki_reads(engine)
}
