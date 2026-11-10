//! Thread deletion over the existing source tombstone, receipt and Accepted
//! journals. No public cleanup RPC, device authority revival or Provider work.
use super::attachment_retention::cleanup::{AdministrativeCleanupProof, CleanupQuery};
use super::attachment_retention::{NoAcceptedTurnProof, RetentionFailure};
use super::*;
use kcoder_app_protocol::{
    RetentionAdministrativeReasonV1, RetentionCleanupStatusV1, RetentionReceiptStateV1,
};
use kcoder_config::PrivateDirectory;
use std::collections::BTreeSet;

struct DeletedSourceProof(CleanupQuery);

impl AdministrativeCleanupProof for DeletedSourceProof {
    fn is_exactly_durable(&self, query: &CleanupQuery) -> Result<bool> {
        // The source witness/roots are verified before minting, outside the
        // namespace lock. Service callbacks only compare this immutable tuple.
        Ok(self.0 == *query)
    }
}

/// Caller holds the cross-process lifecycle gate and exclusive SessionLease,
/// after removing only an idle runtime. No proof/session artifacts are purged
/// until this returns success. Replays never dispatch a turn or change IDs.
pub(super) fn complete(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    history: &Path,
    witness: &kcoder_state::DeletedHistoryProof,
) -> Result<()> {
    witness.verify(history, &engine.cwd)?;
    let (workspace, principal) = authority.administrative_workspace_binding()?;
    let service = authority.retention_service();
    let candidates = service.thread_cleanup_candidates(
        witness.thread_id(),
        workspace,
        &principal,
        witness.sha256(),
    )?;
    // A retry skips already validated terminal receipts. Reaching the work
    // limit keeps the original source tombstone and all target proof artifacts.
    let budget_exceeded = candidates.len() > 32;
    for mut candidate in candidates.into_iter().take(32) {
        witness.verify(history, &engine.cwd)?;
        authority.administrative_workspace_binding()?;
        let mut accepted = None;
        if let Some(query) = service
            .thread_cleanup_transfer_query(&candidate.scope, &candidate.receipt.retention_id)?
        {
            ensure!(
                query.identity.thread_id == witness.thread_id(),
                RetentionFailure::Conflict
            );
            let session = engine.session_storage_dir_for(witness.thread_id());
            let parent = PrivateDirectory::open_existing(&session.join("attachments"))?;
            // Full batch lookup rejects legacy, duplicate, cross-scope and
            // unknown attempts. Missing proof never means not Accepted.
            let proof = turn_attempts::verified_retained_acceptance_in(
                &session,
                &candidate.scope,
                &query.identity,
                &query.input.client_message_id,
                &query.request_fingerprint,
                &parent,
            )?;
            let record = turn_attempts::records(engine, witness.thread_id())?
                .into_iter()
                .find(|record| record.identity == query.identity)
                .context("accepted deletion attempt missing")?;
            if record.status == kcoder_types::TurnAttemptStatus::Accepted {
                // The actual idle-runtime removal + held SessionLease proves
                // there is no task. A failed terminal write leaves same-ID
                // recovery pending; this path never invokes a Provider.
                retained_turn::interrupt_unstarted(
                    engine,
                    &query.identity,
                    "retained thread deleted before execution resumed",
                )?;
            }
            if candidate.receipt.state == RetentionReceiptStateV1::Materializing {
                let owners: BTreeSet<_> = query
                    .input
                    .artifacts
                    .iter()
                    .map(|artifact| artifact.owner_id.clone())
                    .collect();
                let leases = service.retained_owner_leases(
                    &candidate.scope,
                    &owners.into_iter().collect::<Vec<_>>(),
                )?;
                candidate.receipt = service.finish_retained_transfer(
                    &candidate.scope,
                    &leases.iter().collect::<Vec<_>>(),
                    &candidate.receipt.retention_id,
                    &parent,
                    &proof,
                )?;
                candidate.request.expected_revision = candidate.receipt.revision;
            }
            accepted = Some(proof);
        }
        let query = service.cleanup_query(&candidate.scope, &candidate.request)?;
        ensure!(
            query.thread_id == witness.thread_id()
                && query.scope == candidate.scope
                && matches!(&query.request.reason,
                RetentionAdministrativeReasonV1::ThreadDeleted { thread_id, proof_sha256 }
                if thread_id == witness.thread_id() && proof_sha256 == witness.sha256()),
            RetentionFailure::Conflict
        );
        witness.verify(history, &engine.cwd)?;
        let no_accepted = NoAcceptedTurnProof;
        let accepted: &dyn attachment_retention::AcceptedTurnProof = accepted
            .as_ref()
            .map(|proof| proof as &dyn attachment_retention::AcceptedTurnProof)
            .unwrap_or(&no_accepted);
        let status = service.resume_administrative_cleanup(
            &candidate.scope,
            &candidate.request,
            &DeletedSourceProof(query),
            accepted,
        )?;
        ensure!(
            !matches!(status, RetentionCleanupStatusV1::Pending),
            RetentionFailure::CompletionUnknown
        );
    }
    ensure!(!budget_exceeded, RetentionFailure::CompletionUnknown);
    witness.verify(history, &engine.cwd)?;
    authority.administrative_workspace_binding()?;
    ensure!(
        service
            .thread_cleanup_candidates(
                witness.thread_id(),
                workspace,
                &principal,
                witness.sha256(),
            )?
            .is_empty(),
        RetentionFailure::CompletionUnknown
    );
    Ok(())
}

/// An old/unconfigured parent cannot purge an existing retained proof store.
/// Ordinary legacy threads keep their original delete behavior.
pub(super) fn require_legacy_only(engine: &QueryEngine, thread: &str) -> Result<()> {
    ensure!(
        turn_attempts::records(engine, thread)?
            .iter()
            .all(|record| record.retained_input.is_none()),
        RetentionFailure::ProofUnavailable
    );
    Ok(())
}

pub(super) fn requires_cleanup(
    authority: Option<&retention_context::VerifiedRetentionAuthority>,
    engine: &QueryEngine,
    thread: &str,
) -> Result<bool> {
    let Some(authority) = authority else {
        require_legacy_only(engine, thread)?;
        return Ok(false);
    };
    authority.administrative_workspace_binding()?;
    Ok(authority
        .retention_service()
        .has_registered_thread_receipts(thread)?
        || turn_attempts::records(engine, thread)?
            .iter()
            .any(|r| r.retained_input.is_some()))
}
