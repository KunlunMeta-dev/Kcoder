//! Four bounded handlers over the once-captured account-root service. This does
//! not enable retained uploads, accepted transfer, deletion or Mobile capability.
use super::attachment_retention::{NoAcceptedTurnProof, RetentionFailure};
use super::retention_context::VerifiedRetentionAuthority;
use anyhow::Result;
use kcoder_app_protocol::*;

pub(super) fn error_code(error: &anyhow::Error) -> i64 {
    match error.downcast_ref::<RetentionFailure>() {
        Some(RetentionFailure::Conflict) => RETENTION_ERROR_CONFLICT,
        Some(RetentionFailure::Capacity) => RETENTION_ERROR_CAPACITY,
        Some(RetentionFailure::ReservePrepaidSlotUnavailable) => {
            RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE
        }
        Some(RetentionFailure::ProofUnavailable) => RETENTION_ERROR_PROOF_UNAVAILABLE,
        _ => RETENTION_ERROR_UNKNOWN,
    }
}
pub(super) fn error_message(code: i64) -> &'static str {
    match code {
        -32602 => "Invalid private retention request",
        RETENTION_ERROR_AUTHORITY => "Private retention authority unavailable",
        RETENTION_ERROR_CAPACITY => {
            "Retention capacity reached; completion may require original-ID readback"
        }
        RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE => {
            "Referenced attachment prepaid cleanup slot unavailable; retry cannot replenish it"
        }
        RETENTION_ERROR_CONFLICT => "Retention identity or revision conflict",
        RETENTION_ERROR_PROOF_UNAVAILABLE => "Retention terminal proof unavailable",
        _ => "Retention completion unknown; preserve the original ID",
    }
}

pub(super) fn dispatch(
    authority: &VerifiedRetentionAuthority,
    request: &PrivateRetentionRequestV1,
) -> Result<AttachmentRetentionResult> {
    let scope = authority.retention_scope(request)?;
    let service = authority.retention_service();
    dispatch_in_scope(service, &scope, &request.method, &request.params)
}

// Authority is captured/validated by dispatch above; this helper shares the
// exact typed operation/ACK ordering with same-module service regression tests.
pub(super) fn dispatch_in_scope(
    service: &super::attachment_retention::RetentionService,
    scope: &super::attachment_retention::model::Scope,
    method: &str,
    params: &serde_json::Value,
) -> Result<AttachmentRetentionResult> {
    let (mut result, acks) = match method {
        METHOD_ATTACHMENT_RETENTION_RESERVE => {
            let params: AttachmentRetentionReserveParams = serde_json::from_value(params.clone())?;
            let receipt = service.reserve(
                scope,
                &params.client_request_id,
                &params.thread_id,
                &params.stage_refs,
            )?;
            (
                AttachmentRetentionResult {
                    receipt: Some(receipt),
                    epoch_retired: None,
                    consume_results: Vec::new(),
                },
                params.consume_acks,
            )
        }
        METHOD_ATTACHMENT_RETENTION_READ => {
            let params: AttachmentRetentionReadParams = serde_json::from_value(params.clone())?;
            (service.read(scope, &params.selector)?, params.consume_acks)
        }
        METHOD_ATTACHMENT_RETENTION_RELEASE => {
            let params: AttachmentRetentionReleaseParams = serde_json::from_value(params.clone())?;
            let receipt = service.release_receipt(
                scope,
                &params.retention_id,
                params.expected_revision,
                params.reason,
            )?;
            (
                AttachmentRetentionResult {
                    receipt: Some(receipt),
                    epoch_retired: None,
                    consume_results: Vec::new(),
                },
                params.consume_acks,
            )
        }
        METHOD_ATTACHMENT_RETENTION_CONSUME => {
            let params: AttachmentRetentionConsumeParams = serde_json::from_value(params.clone())?;
            (
                AttachmentRetentionResult {
                    receipt: None,
                    epoch_retired: None,
                    consume_results: Vec::new(),
                },
                params.acks,
            )
        }
        _ => anyhow::bail!(RetentionFailure::Conflict),
    };
    for ack in acks {
        // Only typed proof/conflict failures are authoritative rejection. An IO
        // error may have committed and must remain unknown, never false Rejected.
        let status = match service.consume(scope, &ack, &NoAcceptedTurnProof) {
            Ok(status) => status,
            Err(error) => match error.downcast_ref::<RetentionFailure>() {
                Some(RetentionFailure::Conflict) => RetentionConsumeStatusV1::Rejected {
                    reason: "ackConflict".into(),
                },
                Some(RetentionFailure::ProofUnavailable) => RetentionConsumeStatusV1::Rejected {
                    reason: "proofUnavailable".into(),
                },
                _ => return Err(error),
            },
        };
        result.consume_results.push(RetentionConsumeResultV1 {
            client_ack_id: ack.client_ack_id,
            status,
        });
    }
    // Piggyback ACK may have consumed the primary projection in this request.
    if let Some(receipt) = &result.receipt {
        let updated = service.read(
            scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: receipt.retention_id.clone(),
            },
        )?;
        result.receipt = updated.receipt;
        result.epoch_retired = updated.epoch_retired;
    }
    result
        .validate(service.namespace())
        .map_err(anyhow::Error::msg)?;
    Ok(result)
}

/// Only the trusted-parent wire adapter adds the backend's full scope digest.
/// Service callers retain AttachmentRetentionResult and do not self-assert scope.
pub(super) fn dispatch_scoped(
    authority: &VerifiedRetentionAuthority,
    request: &PrivateRetentionRequestV1,
) -> Result<ScopedAttachmentRetentionResultV1> {
    let scope = authority.retention_scope(request)?;
    Ok(ScopedAttachmentRetentionResultV1 {
        scope_id: scope.hash,
        result: dispatch(authority, request)?,
    })
}

pub(super) fn dispatch_upload(
    authority: &VerifiedRetentionAuthority,
    request: &PrivateRetentionRequestV1,
) -> Result<RetentionUploadResultV1> {
    use base64::Engine;
    let scope = authority.retention_scope(request)?;
    let params: RetentionUploadParamsV1 = serde_json::from_value(request.params.clone())?;
    params
        .validate_for(&request.method)
        .map_err(anyhow::Error::msg)?;
    let service = authority.retention_service();
    let bytes = params
        .content_base64
        .as_ref()
        .map(|value| base64::engine::general_purpose::STANDARD.decode(value))
        .transpose()?;
    match request.method.as_str() {
        METHOD_RETENTION_UPLOAD_START => service.start_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_READ => service.read_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_CHUNK => service.chunk_wire_upload(
            &scope,
            &params,
            bytes.as_deref().ok_or(RetentionFailure::Conflict)?,
        ),
        METHOD_RETENTION_UPLOAD_FINISH => service.finish_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_CANCEL => service.cancel_wire_upload(&scope, &params),
        METHOD_RETENTION_UPLOAD_SAVE => {
            let bytes = bytes.as_deref().ok_or(RetentionFailure::Conflict)?;
            let size = params.size.ok_or(RetentionFailure::Conflict)?;
            anyhow::ensure!(
                bytes.len() as u64 == size
                    && size <= RETENTION_UPLOAD_SAVE_BYTES
                    && super::private_files::hex_sha256(bytes)
                        == params.content_sha256.as_deref().unwrap_or(""),
                RetentionFailure::Conflict
            );
            service.start_wire_upload(&scope, &params)?;
            if size > 0 {
                let mut chunk = params.clone();
                chunk.offset = Some(0);
                chunk.length = Some(size);
                chunk.chunk_sha256 = params.content_sha256.clone();
                service.chunk_wire_upload(&scope, &chunk, bytes)?;
            }
            service.finish_wire_upload(&scope, &params)
        }
        _ => anyhow::bail!(RetentionFailure::Conflict),
    }
}
