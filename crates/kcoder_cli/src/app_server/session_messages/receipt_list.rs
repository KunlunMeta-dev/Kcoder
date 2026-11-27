//! Observe original outgoing operations without replaying them or consulting a stale receipt.
use super::service::PeerMessageService;
use anyhow::{Result, ensure};
use kcoder_app_protocol::cross_session_router::PeerRouterStageV1;
use kcoder_types::cross_session_messages::{
    CrossSessionMessageReceiptListEntry, CrossSessionMessageReceiptListParams,
    CrossSessionMessageReceiptListResult, MAX_RECEIPT_LIST_BYTES, ReceiptConfirmation,
};
use kcoder_types::session_address::SessionAddressV1;

pub(crate) fn local_page(
    service: &PeerMessageService,
    source: &SessionAddressV1,
    query: &CrossSessionMessageReceiptListParams,
    current: impl Fn() -> Result<()>,
) -> Result<CrossSessionMessageReceiptListResult> {
    local_page_observed(service, source, query, current).map(|page| page.result)
}

/// A local page plus whether any examined candidate targets another runtime
/// target, whose current receipt only the authenticated parent route can read.
pub(crate) struct LocalReceiptPage {
    pub result: CrossSessionMessageReceiptListResult,
    pub remote_candidates: usize,
}

pub(crate) fn local_page_observed(
    service: &PeerMessageService,
    source: &SessionAddressV1,
    query: &CrossSessionMessageReceiptListParams,
    current: impl Fn() -> Result<()>,
) -> Result<LocalReceiptPage> {
    current()?;
    let identity = service.identity()?;
    let mut remote_candidates = 0usize;
    query.validate().map_err(anyhow::Error::msg)?;
    let authority = service.authority()?;
    ensure!(
        service.address(&source.thread_id)? == *source,
        "peer_message_source_changed"
    );
    let page = authority.store()?.source_operations_page(source, query)?;
    let mut result = CrossSessionMessageReceiptListResult {
        next_cursor: page.next_cursor.clone(),
        unconfirmed_count: page.unconfirmed_count,
        items: Vec::new(),
    };
    let mut previous = query.cursor.clone();
    let total = page.items.len();
    // Leave room for the envelope and a continuation cursor if a single page is byte-limited.
    let mut used = 4096;
    for (index, candidate) in page.items.into_iter().enumerate() {
        current()?;
        let op = candidate.operation;
        ensure!(
            op.source_address == *source && op.attestation.claims.source_address == *source,
            "peer_message_source_changed"
        );
        let prepared = op.stage == PeerRouterStageV1::Prepared;
        if !prepared && !identity.contains(&op.destination) {
            remote_candidates += 1;
        }
        let details = if prepared {
            None
        } else {
            Some(service.local_outgoing_receipt_details(&op))
        };
        let (confirmation, receipt, created_at_ms, expires_at_ms, reason_code) = match details {
            Some(Ok(details)) if details.receipt.is_some() => {
                let reason = details.receipt.as_ref().and_then(|r| r.reason_code.clone());
                (
                    ReceiptConfirmation::Confirmed,
                    details.receipt,
                    details.created_at_ms,
                    details.expires_at_ms,
                    reason,
                )
            }
            Some(Ok(_)) => (
                ReceiptConfirmation::Missing,
                None,
                None,
                None,
                Some("original_receipt_missing".into()),
            ),
            Some(Err(_)) => (
                ReceiptConfirmation::Unconfirmed,
                None,
                None,
                None,
                Some("receipt_query_unconfirmed".into()),
            ),
            None => (
                ReceiptConfirmation::Unconfirmed,
                None,
                None,
                None,
                Some("original_not_dispatched".into()),
            ),
        };
        let row = CrossSessionMessageReceiptListEntry {
            client_message_id: op.attestation.claims.client_message_id,
            target_address: op.destination,
            mode: op.attestation.claims.mode,
            confirmation,
            receipt,
            created_at_ms,
            expires_at_ms,
            reason_code,
        };
        if query.matches(&row) {
            let bytes = serde_json::to_vec(&row)?.len() + 1;
            if used + bytes > MAX_RECEIPT_LIST_BYTES {
                ensure!(
                    previous.is_some(),
                    "peer_message_receipt_list_entry_too_large"
                );
                result.next_cursor = previous;
                break;
            }
            used += bytes;
            result.items.push(row);
        }
        if confirmation == ReceiptConfirmation::Unconfirmed
            || confirmation == ReceiptConfirmation::Confirmed
                && created_at_ms.is_none()
                && (query.created_after_ms.is_some() || query.created_before_ms.is_some())
        {
            result.unconfirmed_count += 1;
        }
        previous = Some(candidate.cursor);
        if result.items.len() == query.page_size() {
            if index + 1 < total {
                result.next_cursor = previous;
            }
            break;
        }
    }
    current()?;
    result
        .validate(query, &source.thread_id, Some(source))
        .map_err(anyhow::Error::msg)?;
    Ok(LocalReceiptPage {
        result,
        remote_candidates,
    })
}
