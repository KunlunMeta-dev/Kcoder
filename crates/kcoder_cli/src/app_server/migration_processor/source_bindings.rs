//! Read-only Native grant classification does not extend old discover DTOs.
use super::*;
pub(super) fn execute(processor: &MigrationProcessor, params: Value) -> Result<Value> {
    let params: MigrationSourceBindingsParams = decode(params)?;
    let registry = processor
        .registry
        .lock()
        .map_err(|_| anyhow::anyhow!("migration_busy"))?;
    let registry = registry
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
    let bindings = params
        .source_ids
        .into_iter()
        .map(|source_id| {
            let family = registry.source_binding_family(&source_id)?;
            Ok(MigrationSourceBindingSummary { source_id, family })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(serde_json::to_value(MigrationSourceBindingsResult {
        bindings,
    })?)
}
