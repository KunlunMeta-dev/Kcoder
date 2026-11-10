use super::{QueryEngine, read_thread_metadata};
use anyhow::Result;
use kcoder_state::PreparedSessionMetadata;
use serde_json::Value;
use std::path::Path;

#[derive(Default)]
pub(super) struct ListCatalog(kcoder_thread_metadata::history_catalog::ListCatalog);

impl ListCatalog {
    #[cfg(test)]
    pub(super) fn open(engine: &QueryEngine) -> Self {
        Self(kcoder_thread_metadata::history_catalog::ListCatalog::open(
            &engine.client_storage_root(),
            &engine.state.cwd(),
        ))
    }

    pub(super) fn snapshot(
        &mut self,
        engine: &QueryEngine,
        id: &str,
        path: &Path,
        prepared: &PreparedSessionMetadata,
        running: bool,
    ) -> Result<Value> {
        // Cache hits and fallback share the same validated metadata observation.
        let stored = read_thread_metadata(engine, id)?;
        self.0
            .snapshot(id, path, prepared, running, stored.as_ref())
    }

    pub(super) fn publish(self) {
        self.0.publish();
    }
}
