//! App-server authority and test fault injection for retained turn dispatch.
use super::*;
#[cfg(all(test, target_os = "linux"))]
use kcoder_attachment_retention::model::Scope;
use kcoder_attachment_retention::{
    AcceptedTurnProof, RetentionFailure, transfer::AcceptedTurnQuery,
};
use kcoder_config::PrivateDirectory;
pub(super) use kcoder_turn_lifecycle::retained_turn::{
    Authority, Preparation, append_recovery_notice, interrupt_unstarted, prepare,
    recover_unstarted_on_resume,
};
use kcoder_turn_lifecycle::retained_turn::{Prepared, require_live_retained_thread};
#[cfg(all(test, target_os = "linux"))]
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use std::collections::BTreeSet;

pub(super) fn handoff(prepared: &Prepared<'_>, engine: &QueryEngine) -> Result<()> {
    #[cfg(all(test, target_os = "linux"))]
    tests::before_handoff(engine, prepared.identity())?;
    prepared.handoff(engine)
}

/// Tokens are minted outside every retention transaction; service callbacks
/// only perform immutable tuple comparison and cannot reenter ledger/file IO.
struct Proofs(Vec<turn_attempts::VerifiedAcceptedTurnProof>);
impl AcceptedTurnProof for Proofs {
    fn is_exactly_accepted(&self, query: &AcceptedTurnQuery) -> Result<bool> {
        let mut matches = 0;
        for proof in &self.0 {
            if proof.is_exactly_accepted(query)? {
                matches += 1;
            }
        }
        Ok(matches == 1)
    }
}

pub(super) fn dispatch_receipts(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    request: &kcoder_app_protocol::PrivateRetentionRequestV1,
) -> Result<kcoder_app_protocol::ScopedAttachmentRetentionResultV1> {
    use kcoder_app_protocol::*;
    let scope = authority.retention_scope(request)?;
    let service = authority.retention_service();
    let acks = match request.method.as_str() {
        METHOD_ATTACHMENT_RETENTION_RESERVE => {
            kcoder_app_rpc_codec::decode::<AttachmentRetentionReserveParams>(
                request.params.clone(),
            )?
            .consume_acks
        }
        METHOD_ATTACHMENT_RETENTION_READ => {
            kcoder_app_rpc_codec::decode::<AttachmentRetentionReadParams>(request.params.clone())?
                .consume_acks
        }
        METHOD_ATTACHMENT_RETENTION_RELEASE => {
            kcoder_app_rpc_codec::decode::<AttachmentRetentionReleaseParams>(
                request.params.clone(),
            )?
            .consume_acks
        }
        METHOD_ATTACHMENT_RETENTION_CONSUME => {
            kcoder_app_rpc_codec::decode::<AttachmentRetentionConsumeParams>(
                request.params.clone(),
            )?
            .acks
        }
        _ => anyhow::bail!(RetentionFailure::Conflict),
    };
    let mut tokens = Vec::new();
    let mut accepted = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for ack in acks {
        if !seen.insert(ack.retention_id.clone()) {
            continue;
        }
        if let Some(query) = service.retained_consume_query(&scope, &ack.retention_id)? {
            thread_history_path(engine, &query.identity.thread_id)?;
            let session = engine.session_storage_dir_for(&query.identity.thread_id);
            let parent = PrivateDirectory::open_existing(&session.join("attachments"))?;
            if accepted.insert((
                query.identity.thread_id.clone(),
                query.identity.attempt_id.clone(),
                query.input.client_message_id.clone(),
                query.request_fingerprint.clone(),
            )) {
                tokens.push(turn_attempts::verified_retained_acceptance_in(
                    &session,
                    &scope,
                    &query.identity,
                    &query.input.client_message_id,
                    &query.request_fingerprint,
                    &parent,
                )?);
            }
        }
    }
    // Only new reservations require a live source. Read/release/consume keep
    // their existing recovery routes after deletion. All proof IO above is
    // outside this short lifecycle -> namespace reservation boundary.
    let _lifecycle = if request.method == METHOD_ATTACHMENT_RETENTION_RESERVE {
        let params: AttachmentRetentionReserveParams =
            serde_json::from_value(request.params.clone())?;
        let gate = acquire_thread_lifecycle_locks(engine, &[&params.thread_id])?;
        require_live_retained_thread(engine, &params.thread_id)?;
        Some(gate)
    } else {
        None
    };
    let result = attachment_retention_dispatch::dispatch_in_scope_with_proof(
        service,
        &scope,
        &request.method,
        &request.params,
        &Proofs(tokens),
    )?;
    Ok(ScopedAttachmentRetentionResultV1 {
        scope_id: scope.hash,
        result,
    })
}

#[cfg(all(test, target_os = "linux"))]
#[path = "retained_turn_tests.rs"]
mod tests;
