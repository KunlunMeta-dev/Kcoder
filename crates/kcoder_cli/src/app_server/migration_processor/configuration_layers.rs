//! A separate read-only method publishes safe provenance without altering legacy results.
use super::*;

pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &std::path::Path,
    params: Value,
) -> Result<Value> {
    let params: MigrationConfigurationLayersParams = decode(params)?;
    ensure!(params.page_index <= 102, "migration_invalid_page");
    let (binding, live) = selected_binding(processor, profile, &params.target)?;
    let applicable = binding
        .as_ref()
        .is_some_and(|source| source.has_configuration_layers());
    let report = match binding {
        Some(source) if live => source.layer_report()?,
        Some(source) => source.layer_snapshot_report()?,
        None => None,
    };
    let mut result = MigrationConfigurationLayersResult {
        target: params.target,
        status: if applicable {
            MigrationConfigurationLayersStatus::Unavailable
        } else {
            MigrationConfigurationLayersStatus::NotApplicable
        },
        page_index: params.page_index,
        adapter_revision: None,
        layers: vec![],
        fields: vec![],
        total_fields: 0,
        next_page: None,
        unobserved: vec![],
    };
    if let Some(report) = report {
        let start = params.page_index as usize * 10;
        ensure!(
            start < report.fields.len() || start == 0,
            "migration_invalid_page"
        );
        result.status = MigrationConfigurationLayersStatus::Available;
        result.total_fields = report.fields.len() as u32;
        result.next_page = (start + 10 < report.fields.len()).then_some(params.page_index + 1);
        result.fields = report.fields.into_iter().skip(start).take(10).collect();
        result.layers = report.layers;
        result.adapter_revision = Some(report.adapter_revision);
        result.unobserved = report.unobserved;
    } else {
        ensure!(params.page_index == 0, "migration_invalid_page");
    }
    Ok(serde_json::to_value(result)?)
}

pub(super) fn selected_binding(
    processor: &MigrationProcessor,
    profile: &std::path::Path,
    target: &MigrationConfigurationLayersTarget,
) -> Result<(
    Option<kcoder_migration::discovery::ConfigurationBinding>,
    bool,
)> {
    let value = match target {
        MigrationConfigurationLayersTarget::Source { source_id } => {
            let registry = processor
                .registry
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?;
            let binding = registry
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?
                .selected(source_id)?;
            (Some(binding), true)
        }
        MigrationConfigurationLayersTarget::Job { job_id, item_id } => {
            let store = MigrationStore::open_existing(profile)?;
            let job = store.read(job_id)?;
            let binding = if let Some(batch) = &job.batch {
                let item_id = item_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
                match batch.source_for(item_id)? {
                    kcoder_migration::batch::BatchSource::Configuration(binding) => {
                        Some(binding.clone())
                    }
                    _ => None,
                }
            } else {
                ensure!(
                    item_id.as_ref().is_none_or(|id| job
                        .inventory
                        .items
                        .iter()
                        .any(|item| &item.preview.id == id)),
                    "migration_unknown_item"
                );
                job.source_binding
            };
            (binding, false)
        }
    };
    Ok(value)
}
