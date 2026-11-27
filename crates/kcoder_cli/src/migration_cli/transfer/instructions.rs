//! Instruction query replies remain fixed to the original source capture and requested byte window.
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_app_protocol::*;
fn valid(value: bool) -> Result<()> {
    ensure!(value, "source_transfer_invalid_response");
    Ok(())
}
pub(super) fn capture(
    result: &MigrationInstructionCaptureResult,
    request: &MigrationInstructionCaptureParams,
) -> Result<()> {
    valid(
        result.capture_id == request.capture_id
            && result.source == request.source
            && result.format_revision == InstructionFormatRevision::ScopedV2
            && result.total_items <= 128
            && result.remaining_ms > 0
            && result.remaining_ms <= 600_000
            && sha(&result.source_revision),
    )
}
pub(super) fn page(
    result: &MigrationInstructionPageResult,
    request: &MigrationSourceInstructionPageParams,
) -> Result<()> {
    valid(result.items.iter().all(|item| {
        item.scoped && item.format_revision == Some(InstructionFormatRevision::ScopedV2)
    }))?;
    page_target(
        result,
        &MigrationInstructionPageParams {
            target: MigrationInstructionReadTarget::Source {
                capture_id: request.capture_id.clone(),
            },
            page_index: request.page_index,
        },
    )
}
pub(super) fn page_target(
    result: &MigrationInstructionPageResult,
    request: &MigrationInstructionPageParams,
) -> Result<()> {
    let start = u64::from(request.page_index) * 10;
    let expected = u64::from(result.total_items).saturating_sub(start).min(10) as usize;
    let mut ids = std::collections::BTreeSet::new();
    valid(
        result.target == request.target
            && result.page_index == request.page_index
            && result.total_items <= 128
            && result.items.len() == expected
            && (start < u64::from(result.total_items) || start == 0)
            && result.next_page
                == (start + 10 < u64::from(result.total_items)).then_some(request.page_index + 1)
            && result.items.iter().all(|item| {
                ids.insert(&item.item_id)
                    && item.item_id.len() <= 256
                    && if !item.scoped {
                        matches!(request.target, MigrationInstructionReadTarget::Job { .. })
                            && item.disposition == InstructionSourceDisposition::RequiresReview
                    } else {
                        item.format_revision.is_some()
                            && item.source_revision.as_deref().is_some_and(sha)
                            && item.bytes.is_some_and(|bytes| bytes <= 4 * 1024 * 1024)
                            && item.relative_path.is_some()
                            && item.relative_scope.is_some()
                            && item.role.is_some()
                            && item.trigger.is_some()
                    }
            }),
    )
}
pub(super) fn body(
    result: &MigrationInstructionBodyResult,
    request: &MigrationSourceInstructionBodyParams,
) -> Result<()> {
    valid(result.format_revision == Some(InstructionFormatRevision::ScopedV2))?;
    body_target(
        result,
        &MigrationInstructionBodyParams {
            target: MigrationInstructionReadTarget::Source {
                capture_id: request.capture_id.clone(),
            },
            item_id: request.item_id.clone(),
            representation: request.representation,
            offset: request.offset,
        },
    )
}
pub(super) fn body_target(
    result: &MigrationInstructionBodyResult,
    request: &MigrationInstructionBodyParams,
) -> Result<()> {
    valid(
        result.target == request.target
            && result.item_id == request.item_id
            && result.representation == request.representation
            && result.offset == request.offset
            && result.format_revision.is_some()
            && !result.enabled_by_preview
            && result.total_bytes <= 4 * 1024 * 1024
            && sha(&result.sha256)
            && result.bytes_base64.len() <= INSTRUCTION_BODY_WINDOW.div_ceil(3) * 4,
    )?;
    let bytes = STANDARD
        .decode(&result.bytes_base64)
        .map_err(|_| anyhow::anyhow!("source_transfer_invalid_response"))?;
    let end = result
        .offset
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| anyhow::anyhow!("source_transfer_invalid_response"))?;
    valid(
        STANDARD.encode(&bytes) == result.bytes_base64
            && bytes.len() <= INSTRUCTION_BODY_WINDOW
            && end <= result.total_bytes
            && (end > result.offset || end == result.total_bytes)
            && result.next_offset == (end < result.total_bytes).then_some(end)
            && match result.encoding {
                InstructionBodyEncoding::Utf8 => result
                    .text
                    .as_deref()
                    .is_some_and(|text| text.as_bytes() == bytes),
                InstructionBodyEncoding::Binary => result.text.is_none(),
            },
    )
}
fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn body_windows_cannot_cross_an_original_receipt_job_or_representation() {
        let target = MigrationInstructionReadTarget::Received {
            request_id: uuid::Uuid::new_v4().to_string(),
            manifest_sha256: "a".repeat(64),
            entry_id: "e0000-0000".into(),
        };
        let request = MigrationInstructionBodyParams {
            target: target.clone(),
            item_id: "instruction-owned".into(),
            representation: InstructionRepresentation::Original,
            offset: 0,
        };
        let mut result = MigrationInstructionBodyResult {
            target,
            item_id: request.item_id.clone(),
            representation: request.representation,
            format_revision: Some(InstructionFormatRevision::ScopedV2),
            offset: 0,
            encoding: InstructionBodyEncoding::Utf8,
            bytes_base64: STANDARD.encode("owned"),
            text: Some("owned".into()),
            total_bytes: 5,
            sha256: "b".repeat(64),
            next_offset: None,
            enabled_by_preview: false,
        };
        body_target(&result, &request).unwrap();
        result.target = MigrationInstructionReadTarget::Job {
            job_id: "mig-foreign".into(),
        };
        assert!(body_target(&result, &request).is_err());
        result.target = request.target.clone();
        result.representation = InstructionRepresentation::Compiled;
        assert!(body_target(&result, &request).is_err());
        result.representation = request.representation;
        result.enabled_by_preview = true;
        assert!(body_target(&result, &request).is_err());
        result.enabled_by_preview = false;
        result.text = Some("different".into());
        assert!(body_target(&result, &request).is_err());
    }
}
