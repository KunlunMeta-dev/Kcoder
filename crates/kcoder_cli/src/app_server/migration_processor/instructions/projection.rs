//! Public projections expose captured relative scope and bounded text, never private filesystem proof.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_migration::instruction_sources::{
    InstructionDisposition, InstructionRole, InstructionTrigger,
};
use sha2::{Digest, Sha256};
pub(super) fn revision(snapshot: &InstructionSourceSnapshot) -> Result<InstructionFormatRevision> {
    match snapshot.format_revision() {
        "scoped-instructions/v1" => Ok(InstructionFormatRevision::ScopedV1),
        "scoped-instructions/v2" => Ok(InstructionFormatRevision::ScopedV2),
        _ => anyhow::bail!("migration_instruction_parser_unsupported"),
    }
}
pub(super) fn page_start(page: u32, total: usize) -> Result<usize> {
    ensure!(page <= 102, "migration_invalid_page");
    let start = page as usize * 10;
    ensure!(start < total || start == 0, "migration_invalid_page");
    Ok(start)
}
pub(super) fn item(
    snapshot: &InstructionSourceSnapshot,
    id: &str,
) -> Result<MigrationInstructionItem> {
    let row = snapshot
        .summaries()
        .into_iter()
        .find(|row| row.id == id)
        .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
    Ok(MigrationInstructionItem {
        item_id: row.id,
        display_name: row.relative_path.clone(),
        source: snapshot.source(),
        scoped: true,
        format_revision: Some(revision(snapshot)?),
        source_revision: Some(snapshot.semantic_revision()?),
        relative_path: Some(row.relative_path),
        relative_scope: Some(row.relative_scope),
        role: Some(match row.role {
            InstructionRole::Shared => InstructionSourceRole::Shared,
            InstructionRole::Local => InstructionSourceRole::Local,
            InstructionRole::Override => InstructionSourceRole::Override,
            InstructionRole::Ordinary => InstructionSourceRole::Ordinary,
            InstructionRole::Fallback => InstructionSourceRole::Fallback,
        }),
        trigger: Some(match row.trigger {
            InstructionTrigger::Launch => InstructionSourceTrigger::Launch,
            InstructionTrigger::OnRead => InstructionSourceTrigger::OnRead,
            InstructionTrigger::OnCwd => InstructionSourceTrigger::OnCwd,
        }),
        disposition: match row.disposition {
            InstructionDisposition::Selected => InstructionSourceDisposition::Selected,
            InstructionDisposition::Empty => InstructionSourceDisposition::Empty,
            InstructionDisposition::Shadowed => InstructionSourceDisposition::Shadowed,
            InstructionDisposition::RequiresReview => InstructionSourceDisposition::RequiresReview,
        },
        bytes: Some(row.bytes),
        complete_authorized_static_chain: snapshot.complete_launch_chain(),
        reason_code: row.reason_code,
    })
}
pub(super) fn body(
    params: MigrationInstructionBodyParams,
    snapshot: &InstructionSourceSnapshot,
    id: &str,
) -> Result<MigrationInstructionBodyResult> {
    let bytes = match params.representation {
        InstructionRepresentation::Original => snapshot.original_bytes(id)?.to_vec(),
        InstructionRepresentation::Compiled => snapshot.compiled_text(id)?.into_bytes(),
    };
    let start =
        usize::try_from(params.offset).map_err(|_| anyhow::anyhow!("migration_invalid_page"))?;
    ensure!(start <= bytes.len(), "migration_invalid_page");
    let mut end = (start + INSTRUCTION_BODY_WINDOW).min(bytes.len());
    let text = std::str::from_utf8(&bytes).ok();
    if let Some(text) = text {
        ensure!(text.is_char_boundary(start), "migration_invalid_page");
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    Ok(MigrationInstructionBodyResult {
        target: params.target,
        item_id: params.item_id,
        representation: params.representation,
        format_revision: Some(revision(snapshot)?),
        offset: params.offset,
        encoding: if text.is_some() {
            InstructionBodyEncoding::Utf8
        } else {
            InstructionBodyEncoding::Binary
        },
        bytes_base64: STANDARD.encode(&bytes[start..end]),
        text: text.map(|text| text[start..end].to_owned()),
        total_bytes: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        next_offset: (end < bytes.len()).then_some(end as u64),
        enabled_by_preview: false,
    })
}
