//! Dispatch validated retention scope operations without a connection owner.
#[cfg(test)]
use super::NoAcceptedTurnProof;
use super::RetentionFailure;
use anyhow::Result;
use kcoder_app_protocol::*;

pub fn error_code(error: &anyhow::Error) -> i64 {
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
pub fn error_message(code: i64) -> &'static str {
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

// Same-module service regressions use the unproven path; production supplies
// an authority-bound proof through dispatch_in_scope_with_proof.
#[cfg(test)]
pub fn dispatch_in_scope(
    service: &super::RetentionService,
    scope: &super::model::Scope,
    method: &str,
    params: &serde_json::Value,
) -> Result<AttachmentRetentionResult> {
    dispatch_in_scope_with_proof(service, scope, method, params, &NoAcceptedTurnProof)
}

/// A runtime adapter supplies a proof prepared outside the metadata lock.
/// The existing wire route continues to use NoAcceptedTurnProof.
pub fn dispatch_in_scope_with_proof(
    service: &super::RetentionService,
    scope: &super::model::Scope,
    method: &str,
    params: &serde_json::Value,
    proof: &dyn super::AcceptedTurnProof,
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
        let status = match service.consume(scope, &ack, proof) {
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
