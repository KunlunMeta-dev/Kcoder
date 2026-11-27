//! Only the CLI host sees the selected path; RPC carries an immutable manifest and bounded bytes.
use super::*;
use kcoder_state::external_history::local_attachment::SelectedLocalFile;
use std::{io::Read, path::Path};

pub(super) fn upload(
    client: &mut rpc::Client,
    id: &str,
    chosen: &HistoricalAttachmentSelection,
    sequence: u64,
    path: &Path,
    context: &Context,
    cancelled: &AtomicBool,
) -> Result<MigrationLocalAttachmentStateResult> {
    let mut result = call(
        client,
        method::MIGRATION_LOCAL_ATTACHMENT_PREPARE,
        json!({"requestId":id,"selection":chosen}),
        id,
    )?;
    ensure!(
        result.upload.selection == *chosen
            && result.upload.sequence == sequence
            && !result.worker_running,
        "local_attachment_cli_revision_conflict"
    );
    ensure!(
        !result.upload.cancel_requested
            && matches!(
                result.upload.stage,
                HistoricalLocalAttachmentUploadStage::Prepared
                    | HistoricalLocalAttachmentUploadStage::Receiving
            ),
        "local_attachment_cli_explicit_resume_or_finish_required"
    );
    active(cancelled)?;
    let absolute = super::super::super::absolute(path, Some(&context.cwd))?;
    let parent = absolute
        .parent()
        .context("local_attachment_cli_invalid_file")?;
    let leaf = absolute
        .file_name()
        .context("local_attachment_cli_invalid_file")?;
    let filename = leaf.to_str().context("local_attachment_cli_invalid_file")?;
    let selected = SelectedLocalFile::select(parent, Path::new(leaf), true, |_| {
        !cancelled.load(Ordering::Acquire)
    })
    .map_err(|_| anyhow::anyhow!("local_attachment_cli_selection_failed"))?;
    let bytes = selected.bytes();
    let sha256 = selected.sha256().to_owned();
    if let Some(previous) = result.upload.bytes {
        ensure!(
            previous == bytes
                && result.upload.sha256.as_deref() == Some(&sha256)
                && result.upload.filename.as_deref() == Some(filename),
            "local_attachment_cli_manifest_changed"
        );
    } else {
        result = call(
            client,
            method::MIGRATION_LOCAL_ATTACHMENT_BEGIN,
            json!({"operationId":id,"expectedSequence":sequence,"filename":filename,"bytes":bytes,"sha256":sha256}),
            id,
        )?;
    }
    ensure!(
        result.upload.selection == *chosen
            && result.upload.bytes == Some(bytes)
            && result.upload.sha256.as_deref() == Some(&sha256)
            && result.upload.received_bytes <= bytes
            && result.upload.part_bytes == HISTORICAL_LOCAL_UPLOAD_PART_BYTES,
        "local_attachment_cli_invalid_result"
    );
    let mut reader = selected
        .into_verified_reader()
        .map_err(|_| anyhow::anyhow!("local_attachment_cli_selection_failed"))?;
    let mut offset = 0u64;
    let mut buffer = vec![0u8; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize];
    while offset < bytes {
        active(cancelled)?;
        let count = (bytes - offset).min(buffer.len() as u64) as usize;
        reader
            .read_exact(&mut buffer[..count])
            .map_err(|_| anyhow::anyhow!("local_attachment_cli_source_changed"))?;
        let next = offset + count as u64;
        if next > result.upload.received_bytes {
            ensure!(
                offset == result.upload.received_bytes,
                "local_attachment_cli_invalid_prefix"
            );
            let before = result.upload.sequence;
            result = call(
                client,
                method::MIGRATION_LOCAL_ATTACHMENT_PART,
                json!({"operationId":id,"expectedSequence":before,"index":result.upload.received_parts,"contentBase64":base64::engine::general_purpose::STANDARD.encode(&buffer[..count])}),
                id,
            )?;
            ensure!(
                result.upload.selection == *chosen
                    && result.upload.received_bytes == next
                    && result.upload.sequence > before
                    && !result.upload.cancel_requested
                    && !result.worker_running,
                "local_attachment_cli_invalid_result"
            );
        }
        offset = next;
    }
    // Reading exactly bytes would skip VerifiedReader's final identity and complete-SHA check.
    active(cancelled)?;
    ensure!(
        reader
            .read(&mut [0u8; 1])
            .map_err(|_| anyhow::anyhow!("local_attachment_cli_source_changed"))?
            == 0,
        "local_attachment_cli_source_changed"
    );
    ensure!(
        result.upload.received_bytes == bytes,
        "local_attachment_cli_invalid_prefix"
    );
    Ok(result)
}
