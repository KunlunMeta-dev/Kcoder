//! Terminal commands use the authoritative upload RPC, never a second local job store.
use super::*;
use crate::cli_args::{HistoryLocalAction, HistoryLocalBindings, HistoryLocalSelection};
use base64::Engine as _;
use kcoder_app_protocol::{
    MigrationHistoryAttachmentChunkResult, MigrationLocalAttachmentStateResult, method,
};
use kcoder_types::{
    historical_attachment::*, historical_context::HistoricalLocalAttachmentBinding,
    local_attachment::HistoricalLocalAttachmentStage, local_attachment_upload::*,
};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
#[path = "local_attachment/transfer.rs"]
mod transfer;

fn selection(value: &HistoryLocalSelection) -> HistoricalAttachmentSelection {
    HistoricalAttachmentSelection {
        job_id: value.job_id.clone(),
        view_id: value.view_id.clone(),
        position: value.position,
        block_index: value.block,
        tool_item_index: value.tool_item_index,
    }
}
fn parse_binding(value: &str) -> Result<HistoricalLocalAttachmentBinding> {
    ensure!(
        value.len() <= 8192,
        "local_attachment_cli_binding_budget_exceeded"
    );
    serde_json::from_str(value).map_err(|_| anyhow::anyhow!("local_attachment_cli_invalid_binding"))
}
pub(super) fn parse_bindings(
    values: &HistoryLocalBindings,
) -> Result<Vec<HistoricalLocalAttachmentBinding>> {
    ensure!(
        values.local_attachment_binding.len() <= 256,
        "local_attachment_cli_binding_budget_exceeded"
    );
    ensure!(
        values.local_attachment_binding.is_empty() || values.confirm_local_attachments,
        "local_attachment_cli_binding_confirmation_required"
    );
    values
        .local_attachment_binding
        .iter()
        .map(|value| parse_binding(value))
        .collect()
}
fn state(value: Value, operation: &str) -> Result<MigrationLocalAttachmentStateResult> {
    let state: MigrationLocalAttachmentStateResult = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("local_attachment_cli_invalid_result"))?;
    ensure!(
        state.upload.operation_id == operation
            && state.upload.part_bytes == HISTORICAL_LOCAL_UPLOAD_PART_BYTES
            && state.upload.received_bytes <= state.upload.bytes.unwrap_or(0),
        "local_attachment_cli_invalid_result"
    );
    Ok(state)
}
fn call(
    client: &mut rpc::Client,
    method: &str,
    params: Value,
    operation: &str,
) -> Result<MigrationLocalAttachmentStateResult> {
    state(client.call(method, params)?, operation)
}
fn read(client: &mut rpc::Client, operation: &str) -> Result<MigrationLocalAttachmentStateResult> {
    call(
        client,
        method::MIGRATION_LOCAL_ATTACHMENT_READ,
        json!({"operationId":operation}),
        operation,
    )
}
fn print(result: &MigrationLocalAttachmentStateResult) -> Result<()> {
    let mut value = serde_json::to_value(result)?;
    let binding = if let Some(job) = &result.upload.local_job
        && job.state.stage == HistoricalLocalAttachmentStage::Ready
    {
        ensure!(
            job.selection == result.upload.selection
                && job.state.operation_id == result.upload.operation_id
                && !job.historical_content_verified,
            "local_attachment_cli_invalid_result"
        );
        Some(HistoricalLocalAttachmentBinding {
            operation_id: result.upload.operation_id.clone(),
            selection: job.selection.clone(),
            receipt: job
                .state
                .receipt
                .clone()
                .context("local_attachment_cli_receipt_missing")?,
        })
    } else {
        None
    };
    value
        .as_object_mut()
        .context("local_attachment_cli_invalid_result")?
        .insert("binding".into(), serde_json::to_value(binding)?);
    super::super::batch::print(&value)
}
fn active(cancelled: &AtomicBool) -> Result<()> {
    ensure!(!cancelled.load(Ordering::Acquire), "migration_cancelled");
    Ok(())
}
fn wait(
    client: &mut rpc::Client,
    operation: &str,
    mut result: MigrationLocalAttachmentStateResult,
    cancelled: &AtomicBool,
) -> Result<MigrationLocalAttachmentStateResult> {
    let deadline = Instant::now() + Duration::from_secs(300);
    while result.worker_running {
        active(cancelled)?;
        ensure!(
            Instant::now() < deadline,
            "local_attachment_cli_wait_expired_use_read"
        );
        std::thread::sleep(Duration::from_millis(30));
        result = read(client, operation)?;
    }
    Ok(result)
}
fn operation(action: &HistoryLocalAction) -> Option<&str> {
    match action {
        HistoryLocalAction::Prepare { request_id, .. }
        | HistoryLocalAction::Upload { request_id, .. } => Some(request_id),
        HistoryLocalAction::Read { operation_id }
        | HistoryLocalAction::Resume { operation_id, .. }
        | HistoryLocalAction::Finish { operation_id, .. }
        | HistoryLocalAction::Run { operation_id, .. }
        | HistoryLocalAction::Cancel { operation_id } => Some(operation_id),
        _ => None,
    }
}
pub(super) fn run(
    action: &HistoryLocalAction,
    context: &Context,
    overlays: &[PathBuf],
    cancelled: &AtomicBool,
) -> Result<()> {
    let mut emitted = false;
    let outcome = (|| {
        let mut client = rpc::Client::start(context, overlays)?;
        client.require_capability("migrationLocalAttachmentsV1")?;
        match action {
            HistoryLocalAction::CatalogRead { selection: chosen } => {
                client.require_capability("migrationHistoryToolAttachmentsV1")?;
                ensure!(
                    chosen.tool_item_index.is_none(),
                    "history_tool_attachments_select_collection"
                );
                super::super::batch::print(&client.call(
                    method::MIGRATION_TOOL_ATTACHMENTS_READ,
                    json!({"selection":selection(chosen)}),
                )?)
            }
            HistoryLocalAction::Items {
                selection: chosen,
                cursor,
            } => {
                client.require_capability("migrationHistoryToolAttachmentsV1")?;
                ensure!(
                    chosen.tool_item_index.is_none(),
                    "history_tool_attachments_select_collection"
                );
                super::super::batch::print(&client.call(
                    method::MIGRATION_TOOL_ATTACHMENTS_ITEMS,
                    json!({"selection":selection(chosen),"cursor":cursor}),
                )?)
            }
            HistoryLocalAction::Catalog {
                selection: chosen,
                resume_sequence,
            } => {
                client.require_capability("migrationHistoryToolAttachmentsV1")?;
                ensure!(
                    chosen.tool_item_index.is_none(),
                    "history_tool_attachments_select_collection"
                );
                let selected = selection(chosen);
                let method = if resume_sequence.is_some() {
                    method::MIGRATION_TOOL_ATTACHMENTS_RESUME
                } else {
                    method::MIGRATION_TOOL_ATTACHMENTS_RUN
                };
                let params = match resume_sequence {
                    Some(sequence) => json!({"selection":selected,"expectedSequence":sequence}),
                    None => json!({"selection":selected}),
                };
                let mut result = client.call(method, params)?;
                let deadline = Instant::now() + Duration::from_secs(300);
                while result["workerRunning"] == true {
                    active(cancelled)?;
                    ensure!(
                        Instant::now() < deadline,
                        "local_attachment_cli_wait_expired_use_read"
                    );
                    std::thread::sleep(Duration::from_millis(30));
                    result = client.call(
                        method::MIGRATION_TOOL_ATTACHMENTS_READ,
                        json!({"selection":selected}),
                    )?;
                }
                super::super::batch::print(&result)?;
                ensure!(
                    result["job"]["stage"] == "catalogued" && result["workerError"].is_null(),
                    "history_tool_attachments_not_ready"
                );
                Ok(())
            }
            HistoryLocalAction::List {
                selection: chosen,
                cursor,
            } => super::super::batch::print(&client.call(
                method::MIGRATION_LOCAL_ATTACHMENT_LIST,
                json!({"selection":selection(chosen),"cursor":cursor}),
            )?),
            HistoryLocalAction::Chunk {
                binding,
                offset,
                limit,
                confirm,
            } => {
                ensure!(*confirm, "local_attachment_cli_confirmation_required");
                let binding = parse_binding(binding)?;
                let value=client.call(method::MIGRATION_LOCAL_ATTACHMENT_CHUNK,json!({"operationId":binding.operation_id,"selection":binding.selection,"expectedReceipt":binding.receipt,"offset":offset,"limit":limit}))?;
                let chunk: MigrationHistoryAttachmentChunkResult = serde_json::from_value(value)
                    .map_err(|_| anyhow::anyhow!("local_attachment_cli_invalid_result"))?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(&chunk.data_base64)
                    .map_err(|_| anyhow::anyhow!("local_attachment_cli_invalid_result"))?;
                ensure!(
                    chunk.receipt == binding.receipt
                        && chunk.offset == *offset
                        && bytes.len() <= *limit as usize
                        && format!("{:x}", Sha256::digest(&bytes)) == chunk.data_sha256,
                    "local_attachment_cli_invalid_result"
                );
                super::super::batch::print(&chunk)
            }
            _ => {
                let id = operation(action).context("migration_unknown_operation")?;
                active(cancelled)?;
                let result = match action {
                    HistoryLocalAction::Prepare {
                        selection: chosen, ..
                    } => call(
                        &mut client,
                        method::MIGRATION_LOCAL_ATTACHMENT_PREPARE,
                        json!({"requestId":id,"selection":selection(chosen)}),
                        id,
                    )?,
                    HistoryLocalAction::Read { .. } => read(&mut client, id)?,
                    HistoryLocalAction::Upload {
                        selection: chosen,
                        expected_sequence,
                        file,
                        confirm,
                        ..
                    } => {
                        ensure!(*confirm, "local_attachment_cli_confirmation_required");
                        transfer::upload(
                            &mut client,
                            id,
                            &selection(chosen),
                            *expected_sequence,
                            file,
                            context,
                            cancelled,
                        )?
                    }
                    HistoryLocalAction::Resume {
                        expected_sequence, ..
                    } => call(
                        &mut client,
                        method::MIGRATION_LOCAL_ATTACHMENT_RESUME,
                        json!({"operationId":id,"expectedSequence":expected_sequence}),
                        id,
                    )?,
                    HistoryLocalAction::Cancel { .. } => call(
                        &mut client,
                        method::MIGRATION_LOCAL_ATTACHMENT_CANCEL,
                        json!({"operationId":id}),
                        id,
                    )?,
                    HistoryLocalAction::Finish {
                        expected_sequence, ..
                    }
                    | HistoryLocalAction::Run {
                        expected_sequence, ..
                    } => {
                        let method = if matches!(action, HistoryLocalAction::Finish { .. }) {
                            method::MIGRATION_LOCAL_ATTACHMENT_FINISH
                        } else {
                            method::MIGRATION_LOCAL_ATTACHMENT_RUN
                        };
                        let started = call(
                            &mut client,
                            method,
                            json!({"operationId":id,"expectedSequence":expected_sequence}),
                            id,
                        )?;
                        wait(&mut client, id, started, cancelled)?
                    }
                    _ => anyhow::bail!("migration_unknown_operation"),
                };
                active(cancelled)?;
                print(&result)?;
                emitted = true;
                ensure!(
                    !matches!(
                        action,
                        HistoryLocalAction::Upload { .. }
                            | HistoryLocalAction::Resume { .. }
                            | HistoryLocalAction::Finish { .. }
                            | HistoryLocalAction::Run { .. }
                    ) || (result.worker_error.is_none()
                        && result.upload.failure_code.is_none()
                        && result.upload.local_job.as_ref().is_none_or(|job| !matches!(
                            job.state.stage,
                            HistoricalLocalAttachmentStage::Failed
                                | HistoricalLocalAttachmentStage::OutcomeUnknown
                        ))),
                    "local_attachment_cli_operation_requires_read"
                );
                Ok(())
            }
        }
    })();
    if let Err(error) = outcome {
        // A fresh connection avoids consuming a late mutation reply as a later status response.
        if !emitted
            && let Some(id) = operation(action)
            && let Ok(mut client) = rpc::Client::start(context, overlays)
            && client
                .require_capability("migrationLocalAttachmentsV1")
                .is_ok()
        {
            // Dropping the prior connection stops only its workers; observation
            // must never turn a local interruption into cancellation of a peer.
            let observed = read(&mut client, id);
            if let Ok(observed) = observed {
                let _ = print(&observed);
            }
        }
        return Err(error);
    }
    Ok(())
}
