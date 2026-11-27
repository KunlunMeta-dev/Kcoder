//! A local delivery may recheck a stopped Source only after kernel-confirmed absence.
//! The original operation/signature remains provenance; the Native cold verifier
//! must independently acquire the original lease and read current permissions.
use super::{OriginalSourceCheck, OriginalSourceUnavailable, endpoint};
use crate::app_server::session_messages::{
    router_rpc::ColdPeerSourceVerifier, service::PeerMessageService,
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::cross_session_router::{
    PeerRouterHistoryAccess, PeerRouterMessageV1, PeerRouterOperationV1, PeerRouterStageV1,
};
use kcoder_state::{
    cross_session_messages::CrossSessionMessageRecord, peer_agent_history::PeerHistoryAccess,
};

fn current_local_operation(
    service: &PeerMessageService,
    record: &CrossSessionMessageRecord,
) -> Result<PeerRouterOperationV1> {
    service.require_enabled(false)?;
    let source = record
        .source
        .address
        .as_ref()
        .context("peer_source_original_address_required")?;
    ensure!(
        service
            .authority()?
            .store()?
            .read_incoming(source, &record.intent.client_message_id)?
            .is_none(),
        "peer_message_imported_route_requires_current_gateway"
    );
    let operation = service.verify_local_origin(record)?;
    ensure!(
        operation.stage != PeerRouterStageV1::Prepared,
        "peer_source_original_dispatch_required"
    );
    Ok(operation)
}

/// Keep the classification private. Only the actual kernel carrier call below
/// supplies `live`; no protocol string or historical JSON can select fallback.
fn after_live_check<T>(live: Result<T>, cold: impl FnOnce() -> Result<T>) -> Result<T> {
    match live {
        Ok(value) => Ok(value),
        Err(error) if error.downcast_ref::<OriginalSourceUnavailable>().is_some() => cold(),
        Err(error) => Err(error),
    }
}

/// Call on the existing owned authorization worker, once for each requested
/// Observe/Append/Wake access. No allow verdict is retained between calls.
pub(crate) fn verify_local_source_for_delivery(
    service: &PeerMessageService,
    record: &CrossSessionMessageRecord,
    access: PeerHistoryAccess,
    cold: Option<&dyn ColdPeerSourceVerifier>,
) -> Result<PeerRouterOperationV1> {
    let original = current_local_operation(service, record)?;
    let source = record
        .source
        .address
        .as_ref()
        .context("peer_source_original_address_required")?;
    let query = OriginalSourceCheck::for_intent(&record.intent)?;
    let observed = after_live_check(
        endpoint::check_original_source(service, source, &query),
        || {
            let verifier = cold.context("peer_local_cold_source_verifier_unavailable")?;
            let message = PeerRouterMessageV1 {
                reply_to_message_id: record.intent.reply_to_message_id.clone(),
                client_message_id: record.intent.client_message_id.clone(),
                mode: record.intent.mode,
                expected_turn_id: record.intent.expected_turn_id.clone(),
                text: record.intent.text.clone(),
            };
            let access = match access {
                PeerHistoryAccess::Observe => PeerRouterHistoryAccess::Observe,
                PeerHistoryAccess::Append => PeerRouterHistoryAccess::Append,
                PeerHistoryAccess::Wake => PeerRouterHistoryAccess::Wake,
            };
            verifier.check_current(&original, &message, access)?;
            // A new live owner may have appeared while the cold reader was proving
            // the original lease/configuration. Its denial cannot be bypassed.
            match endpoint::check_original_source(service, source, &query) {
                Ok(current) => Ok(current),
                Err(error) if error.downcast_ref::<OriginalSourceUnavailable>().is_some() => {
                    current_local_operation(service, record)
                }
                Err(error) => Err(error),
            }
        },
    )?;
    ensure!(
        observed.attestation == original.attestation,
        "peer_source_original_operation_changed"
    );
    let current = current_local_operation(service, record)?;
    ensure!(
        current.attestation == original.attestation,
        "peer_source_original_operation_changed"
    );
    Ok(current)
}

#[cfg(test)]
#[path = "cold_source/tests.rs"]
mod tests;
