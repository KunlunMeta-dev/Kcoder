//! Explicit instruction captures and immutable previews do not enable runtime context.
use super::*;
use kcoder_migration::instruction_sources::InstructionSourceSnapshot;
use std::{path::Path, sync::Arc};
mod projection;

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_INSTRUCTION_CAPTURE
            | method::MIGRATION_INSTRUCTION_PAGE
            | method::MIGRATION_INSTRUCTION_BODY
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    factory: &dyn MigrationHost,
    profile: &Path,
    operation: &str,
    value: Value,
) -> Result<Value> {
    if operation == method::MIGRATION_INSTRUCTION_CAPTURE {
        let params: MigrationInstructionCaptureParams = decode(value)?;
        ensure!(
            params.confirm_static_subset,
            "migration_instruction_static_subset_confirmation_required"
        );
        ensure!(
            processor
                .uploaded_choice
                .lock()
                .map_err(|_| anyhow::anyhow!("migration_busy"))?
                .is_none(),
            "migration_instruction_uploaded_root_unsupported"
        );
        let actual = factory
            .migration_source_roots()?
            .project
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_root_untrusted"))?;
        ensure!(
            Path::new(&params.source_cwd) == actual,
            "migration_instruction_source_workspace_changed"
        );
        let cancellation = processor.history.cancellation();
        let capture = processor
            .instructions
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?
            .capture(
                profile,
                &params.capture_id,
                kcoder_migration::instruction_sources::InstructionCaptureRequest {
                    source: params.source,
                    root: Path::new(&params.source_root),
                    cwd: &actual,
                    include_descendants: params.include_descendants,
                },
                |_| !cancellation.is_cancelled(),
            )?;
        return Ok(serde_json::to_value(MigrationInstructionCaptureResult {
            capture_id: params.capture_id,
            source: capture.snapshot.source(),
            format_revision: projection::revision(&capture.snapshot)?,
            source_revision: capture.snapshot.semantic_revision()?,
            total_items: capture.snapshot.summaries().len() as u32,
            complete_authorized_static_chain: capture.snapshot.complete_launch_chain(),
            dynamic_scope_present: capture.snapshot.dynamic_scope_present(),
            remaining_ms: capture.remaining_ms,
        })?);
    }
    if operation == method::MIGRATION_INSTRUCTION_PAGE {
        let params: MigrationInstructionPageParams = decode(value)?;
        let (items, total) = match &params.target {
            MigrationInstructionReadTarget::Job { job_id } => {
                let store = MigrationStore::open_existing(profile)?;
                let job = store.read(job_id)?;
                let rows = job
                    .inventory
                    .items
                    .iter()
                    .filter(|item| {
                        item.preview.category
                            == kcoder_types::migration::MigrationCategory::Instructions
                    })
                    .collect::<Vec<_>>();
                let start = projection::page_start(params.page_index, rows.len())?;
                let selected = rows.iter().skip(start).take(10).collect::<Vec<_>>();
                let ids = selected
                    .iter()
                    .map(|item| item.preview.id.clone())
                    .collect::<Vec<_>>();
                let snapshots = store.instruction_snapshots_for_items(job_id, &ids)?;
                let mut result = Vec::new();
                for (item, snapshot) in selected.into_iter().zip(snapshots) {
                    if let Some((snapshot, entry)) = snapshot {
                        let mut row = projection::item(&snapshot, &entry)?;
                        row.item_id = item.preview.id.clone();
                        result.push(row);
                    } else {
                        result.push(MigrationInstructionItem {
                            item_id: item.preview.id.clone(),
                            display_name: item.preview.source_name.clone(),
                            source: job
                                .batch
                                .as_ref()
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "migration_instruction_legacy_preview_unsupported"
                                    )
                                })?
                                .source_for(&item.preview.id)?
                                .kind(),
                            scoped: false,
                            format_revision: None,
                            source_revision: None,
                            relative_path: None,
                            relative_scope: None,
                            role: None,
                            trigger: None,
                            disposition: InstructionSourceDisposition::RequiresReview,
                            bytes: None,
                            complete_authorized_static_chain: false,
                            reason_code: Some(
                                "migration_instruction_legacy_scope_unobserved".into(),
                            ),
                        });
                    }
                }
                (result, rows.len())
            }
            _ => {
                let snapshot = snapshot(processor, profile, &params.target)?;
                let rows = snapshot.summaries();
                let start = projection::page_start(params.page_index, rows.len())?;
                (
                    rows.iter()
                        .skip(start)
                        .take(10)
                        .map(|row| projection::item(&snapshot, &row.id))
                        .collect::<Result<Vec<_>>>()?,
                    rows.len(),
                )
            }
        };
        let start = params.page_index as usize * 10;
        return Ok(serde_json::to_value(MigrationInstructionPageResult {
            target: params.target,
            page_index: params.page_index,
            items,
            total_items: total as u32,
            next_page: (start + 10 < total).then_some(params.page_index + 1),
        })?);
    }
    let params: MigrationInstructionBodyParams = decode(value)?;
    let (snapshot, item_id) = if let MigrationInstructionReadTarget::Job { job_id } = &params.target
    {
        MigrationStore::open_existing(profile)?
            .instruction_snapshots_for_items(job_id, std::slice::from_ref(&params.item_id))?
            .pop()
            .flatten()
            .ok_or_else(|| anyhow::anyhow!("migration_instruction_legacy_preview_unsupported"))?
    } else {
        (
            snapshot(processor, profile, &params.target)?,
            params.item_id.clone(),
        )
    };
    projection::body(params, &snapshot, &item_id).and_then(|value| Ok(serde_json::to_value(value)?))
}
fn snapshot(
    processor: &MigrationProcessor,
    profile: &Path,
    target: &MigrationInstructionReadTarget,
) -> Result<Arc<InstructionSourceSnapshot>> {
    match target {
        MigrationInstructionReadTarget::Source { capture_id } => Ok(processor
            .instructions
            .lock()
            .map_err(|_| anyhow::anyhow!("migration_busy"))?
            .read(profile, capture_id)?
            .snapshot),
        MigrationInstructionReadTarget::Received {
            request_id,
            manifest_sha256,
            entry_id,
        } => {
            let cancellation = processor.history.cancellation();
            kcoder_migration::source_transfer::IncomingTransfers::open_existing(profile)?
                .received_instruction_snapshot(request_id, manifest_sha256, entry_id, |_| {
                    !cancellation.is_cancelled()
                })
        }
        MigrationInstructionReadTarget::Job { .. } => anyhow::bail!("migration_invalid_parameters"),
    }
}
