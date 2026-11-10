//! Profile-owned notes remain distinct from verified memory retrieval and system instructions.
use super::*;
use kcoder_config::imported_context::{
    ImportedContext, ImportedContextKind, ImportedContextScope, ImportedContextStore,
    imported_context_revision,
};
use kcoder_types::imported_memory::*;
use std::path::Path;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_MEMORY_DISCOVER
            | method::MIGRATION_MEMORY_SOURCES
            | method::MIGRATION_MEMORY_LIST
            | method::MIGRATION_MEMORY_READ
            | method::MIGRATION_MEMORY_CONTROL
            | method::MIGRATION_MEMORY_CONTROL_READ
    )
}

pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    if matches!(
        operation,
        method::MIGRATION_MEMORY_DISCOVER | method::MIGRATION_MEMORY_SOURCES
    ) {
        let mut registry = processor
            .registry
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?;
        processor.initialize_registry(&mut registry, factory)?;
        let registry = registry
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("migration_source_selection_expired"))?;
        let cancel = processor.cancellation();
        let mut check = |_| !cancel.is_cancelled();
        let result = if operation == method::MIGRATION_MEMORY_DISCOVER {
            let params: MigrationMemoryDiscoverParams = decode(params)?;
            registry.discover_memories(params.source, &mut check)?
        } else {
            let params: MigrationMemorySourcesParams = decode(params)?;
            ensure!(
                params.catalog_id.len() <= 80
                    && params
                        .cursor
                        .as_ref()
                        .is_none_or(|value| value.len() <= 128),
                "migration_invalid_parameters"
            );
            registry.memory_page(&params.catalog_id, params.cursor.as_deref(), &mut check)?
        };
        return Ok(serde_json::to_value(result)?);
    }
    let store = ImportedContextStore::open(profile)?;
    let records = || {
        store.list().map(|records| {
            records
                .into_iter()
                .filter(|record| record.kind == ImportedContextKind::Memory)
                .collect::<Vec<_>>()
        })
    };
    match operation {
        method::MIGRATION_MEMORY_LIST => {
            let params: MigrationMemoryListParams = decode(params)?;
            ensure!(params.page_index < 13, "migration_invalid_page");
            let records = records()?;
            let start = params.page_index as usize * 10;
            ensure!(
                start < records.len() || start == 0,
                "migration_invalid_page"
            );
            Ok(serde_json::to_value(ImportedMemoryRecordPage {
                total_records: records.len() as u32,
                next_page: (start + 10 < records.len()).then_some(params.page_index + 1),
                items: records
                    .iter()
                    .skip(start)
                    .take(10)
                    .map(summary)
                    .collect::<Result<_>>()?,
            })?)
        }
        method::MIGRATION_MEMORY_READ => {
            let params: MigrationMemoryReadParams = decode(params)?;
            check_id(&params.id)?;
            let records = records()?;
            let record = records
                .iter()
                .find(|record| record.id == params.id)
                .ok_or_else(|| anyhow::anyhow!("imported_context_unavailable"))?;
            let start = usize::try_from(params.offset)
                .map_err(|_| anyhow::anyhow!("migration_invalid_page"))?;
            ensure!(
                start <= record.content.len() && record.content.is_char_boundary(start),
                "migration_invalid_page"
            );
            let mut end = (start + 8192).min(record.content.len());
            while !record.content.is_char_boundary(end) {
                end -= 1;
            }
            Ok(serde_json::to_value(ImportedMemoryRecordText {
                record: summary(record)?,
                text: record.content[start..end].into(),
                total_bytes: record.content.len() as u64,
                next_offset: (end < record.content.len()).then_some(end as u64),
            })?)
        }
        method::MIGRATION_MEMORY_CONTROL => {
            let params: MigrationMemoryControlParams = decode(params)?;
            let receipt = store.memory_control(&params)?;
            control_result(&store, Some(receipt))
        }
        method::MIGRATION_MEMORY_CONTROL_READ => {
            let params: MigrationMemoryControlReadParams = decode(params)?;
            control_result(&store, store.memory_control_receipt(&params.request_id)?)
        }
        _ => anyhow::bail!("migration_unknown_operation"),
    }
}

fn control_result(
    store: &ImportedContextStore,
    receipt: Option<ImportedMemoryControlReceipt>,
) -> Result<Value> {
    let current = match &receipt {
        Some(receipt) => store
            .list()?
            .iter()
            .find(|record| {
                record.kind == ImportedContextKind::Memory
                    && record.id == receipt.request.id
                    && record.operation_id == receipt.request.owner_operation_id
            })
            .map(summary)
            .transpose()?,
        None => None,
    };
    Ok(serde_json::to_value(ImportedMemoryControlResult {
        receipt,
        current,
    })?)
}
fn check_id(id: &str) -> Result<()> {
    ensure!(
        id.starts_with("ctx-")
            && id.len() <= 80
            && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "migration_invalid_parameters"
    );
    Ok(())
}
fn summary(record: &ImportedContext) -> Result<ImportedMemoryRecordSummary> {
    Ok(ImportedMemoryRecordSummary {
        id: record.id.clone(),
        owner_operation_id: record.operation_id.clone(),
        name: record.name.clone(),
        scope: match &record.scope {
            ImportedContextScope::Global => ImportedMemoryScope::Global,
            ImportedContextScope::Project { root } => ImportedMemoryScope::Project {
                root: root.to_string_lossy().into_owned(),
            },
        },
        enabled: record.enabled,
        revision: imported_context_revision(record)?,
        bytes: record.content.len() as u64,
        provenance: record.memory_provenance.as_deref().cloned(),
    })
}

pub(super) fn mapping(
    factory: &dyn MigrationHost,
    profile: &Path,
    mapping: Option<ImportedMemoryMapping>,
) -> Result<Option<ImportedContextScope>> {
    match mapping {
        None => Ok(None),
        Some(ImportedMemoryMapping::Global) => Ok(Some(ImportedContextScope::Global)),
        Some(ImportedMemoryMapping::CurrentWorkspace) => {
            let root = factory
                .migration_source_roots()?
                .project
                .ok_or_else(|| anyhow::anyhow!("imported_memory_workspace_untrusted"))?;
            let root = root
                .canonicalize()
                .map_err(|_| anyhow::anyhow!("imported_memory_workspace_unavailable"))?;
            let scope = ImportedContextScope::Project { root };
            ImportedContextStore::open(profile)?.capture_memory_workspace(&scope)?;
            Ok(Some(scope))
        }
    }
}
