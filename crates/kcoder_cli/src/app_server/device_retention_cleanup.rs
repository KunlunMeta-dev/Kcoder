//! Trusted installation revoke producer. Revoked sessions are never restored
//! and Accepted target artifacts are never deleted by this source cleanup.
use super::attachment_retention::cleanup::{AdministrativeCleanupProof, CleanupQuery};
use super::*;
use kcoder_app_protocol::{
    DeviceRevocationProgressV1, PrivateDeviceRevocationV1, RetentionCleanupStatusV1,
    RetentionReceiptStateV1,
};

struct RevokedSourceProof(CleanupQuery);
impl AdministrativeCleanupProof for RevokedSourceProof {
    fn is_exactly_durable(&self, query: &CleanupQuery) -> Result<bool> {
        Ok(self.0 == *query)
    }
}

pub(super) async fn complete(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    manager: &mut ThreadManager,
    request: &PrivateDeviceRevocationV1,
) -> Result<DeviceRevocationProgressV1> {
    authority.verify_device_revocation(request)?;
    let (workspace, principal) = authority.administrative_workspace_binding()?;
    ensure!(
        principal == kcoder_app_protocol::RetentionPrincipalV1::LocalOs,
        "local revocation parent required"
    );
    let service = authority.retention_service();
    service.fence_revoked_device(request)?;
    let (candidates, mut pending) = service.device_cleanup_window(
        request,
        service.device_cleanup_candidates(request, workspace)?,
        false,
        |candidate| candidate.receipt.retention_id.as_str(),
    )?;
    for candidate in candidates {
        match complete_receipt(authority, engine, manager, request, candidate).await {
            Ok(incomplete) => pending |= incomplete,
            Err(_) => pending = true, // Exact durable intent remains retryable; continue peers.
        }
    }

    let (owners, more) = service.device_cleanup_window(
        request,
        service.unreserved_device_owners(request, workspace)?,
        true,
        |(_, id)| id.as_str(),
    )?;
    pending |= more;
    for (scope, id) in owners {
        authority.verify_device_revocation(request)?;
        let result = (|| -> Result<()> {
            if service.resume_revoked_owner_retirement(&scope, &id, &request.statement_sha256)? {
                return Ok(());
            }
            let leases = service.retained_owner_leases(&scope, std::slice::from_ref(&id))?;
            service.cancel_revoked_owner(&scope, &leases[0], &request.statement_sha256)
        })();
        pending |= result.is_err();
    }
    authority.verify_device_revocation(request)?;
    pending |= !service
        .device_cleanup_candidates(request, workspace)?
        .is_empty()
        || !service
            .unreserved_device_owners(request, workspace)?
            .is_empty();
    Ok(DeviceRevocationProgressV1 {
        version: 1,
        revocation_id: request.statement.revocation_id.clone(),
        route_id: request.route.route_id.clone(),
        complete: !pending,
    })
}

async fn complete_receipt(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    manager: &mut ThreadManager,
    request: &PrivateDeviceRevocationV1,
    mut candidate: attachment_retention::cleanup::ThreadCleanupCandidate,
) -> Result<bool> {
    let service = authority.retention_service();
    let thread = candidate.receipt.thread_id.clone();
    let _lifecycle = acquire_thread_lifecycle_locks(engine, &[thread.as_str()])?;
    let runtime = manager
        .remove_if_idle(&thread)
        .map_err(|()| anyhow::anyhow!("revoked thread is active"))?;
    if let Some(runtime) = runtime {
        runtime.shutdown().await;
    }
    let root = engine
        .state
        .history_path()
        .context("session history disabled")?;
    let history =
        candidate_thread_history_path(root.parent().context("history parent missing")?, &thread)?;
    // A source that disappeared without a valid tombstone is not proof that
    // target artifacts or an Accepted record can safely be reclaimed.
    if !history.exists() {
        kcoder_state::read_session_history_deletion(&history, &engine.cwd)?
            .context("revoked history source unknown")?
            .verify(&history, &engine.cwd)?;
    } else {
        ensure!(
            thread_history_path(engine, &thread)? == history,
            "revoked history source mismatch"
        );
    }
    let _lease = SessionLease::acquire(&history)?;
    authority.verify_device_revocation(request)?;
    if !history.exists() {
        kcoder_state::read_session_history_deletion(&history, &engine.cwd)?
            .context("revoked history source unknown")?
            .verify(&history, &engine.cwd)?;
    } else {
        ensure!(
            thread_history_path(engine, &thread)? == history,
            "revoked history source mismatch"
        );
    }
    let id = candidate.receipt.retention_id.clone();
    if let Some(query) = service.device_abort_query(&candidate.scope, &id)? {
        let session = engine.session_storage_dir_for(&thread);
        let mapped =
            turn_attempts::strict_client_message_turn(&session, &thread, &query.client_message_id)?;
        let records = turn_attempts::records(engine, &thread)?;
        if conclusively_unaccepted(
            &records,
            mapped.as_deref(),
            &query.identity,
            &query.client_message_id,
        )? {
            let parent =
                kcoder_config::PrivateDirectory::open_existing(&session.join("attachments"))?;
            let leases = service.retained_owner_leases(&candidate.scope, &query.owners)?;
            service.abort_unaccepted_device_transfer(
                &query,
                &id,
                &request.statement_sha256,
                &leases.iter().collect::<Vec<_>>(),
                &parent,
            )?;
            candidate = service
                .device_cleanup_candidates(
                    request,
                    authority.administrative_workspace_binding()?.0,
                )?
                .into_iter()
                .find(|item| item.receipt.retention_id == id)
                .context("aborted receipt missing")?;
        }
    }
    let mut accepted = None;
    if !service.device_transfer_aborted(&candidate.scope, &id)?
        && let Some(query) = service
            .thread_cleanup_transfer_query(&candidate.scope, &candidate.receipt.retention_id)?
    {
        let session = engine.session_storage_dir_for(&thread);
        let parent = kcoder_config::PrivateDirectory::open_existing(&session.join("attachments"))?;
        let proof = turn_attempts::verified_retained_acceptance_in(
            &session,
            &candidate.scope,
            &query.identity,
            &query.input.client_message_id,
            &query.request_fingerprint,
            &parent,
        )?;
        let record = turn_attempts::records(engine, &thread)?
            .into_iter()
            .find(|record| record.identity == query.identity)
            .context("revoked retained attempt missing")?;
        if record.status == kcoder_types::TurnAttemptStatus::Accepted {
            retained_turn::interrupt_unstarted(
                engine,
                &query.identity,
                "device revoked before execution resumed",
            )?;
        }
        if candidate.receipt.state == RetentionReceiptStateV1::Materializing {
            let owners = query
                .input
                .artifacts
                .iter()
                .map(|a| a.owner_id.clone())
                .collect::<std::collections::BTreeSet<_>>();
            let leases = service
                .retained_owner_leases(&candidate.scope, &owners.into_iter().collect::<Vec<_>>())?;
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
    authority.verify_device_revocation(request)?;
    let none = attachment_retention::NoAcceptedTurnProof;
    let proof: &dyn attachment_retention::AcceptedTurnProof = accepted
        .as_ref()
        .map(|p| p as &dyn attachment_retention::AcceptedTurnProof)
        .unwrap_or(&none);
    Ok(matches!(
        service.resume_administrative_cleanup(
            &candidate.scope,
            &candidate.request,
            &RevokedSourceProof(query),
            proof
        )?,
        RetentionCleanupStatusV1::Pending
    ))
}

// Absence is established only from both complete existing catalogs, under the
// exclusive session lease. A legacy or foreign-scope record is never absence.
// The existing client map is committed before Accepted, and Accepted is fsynced
// before dispatch. A same-turn map with no attempt is therefore a pre-Accept
// crash under the durable-store contract. External removal/rollback of committed
// attempt files is outside that contract; malformed catalogs remain Unknown.
fn conclusively_unaccepted(
    records: &[kcoder_state::turn_attempt_store::TurnAttemptRecord],
    mapped: Option<&str>,
    identity: &kcoder_types::TurnAttemptIdentity,
    client_message_id: &str,
) -> Result<bool> {
    for record in records {
        record.validate()?;
        if record.identity.turn_id == identity.turn_id
            || record
                .retained_input
                .as_ref()
                .is_some_and(|input| input.client_message_id == client_message_id)
            || (mapped.is_none() && record.retained_input.is_none())
        {
            return Ok(false);
        }
    }
    Ok(mapped.is_none_or(|turn| turn == identity.turn_id))
}

#[cfg(test)]
mod device_revocation_absence_review {
    use super::*;
    use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
    use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};

    #[test]
    fn device_cleanup_absence_uses_durable_catalogs_and_original_map_only() {
        let temp = tempfile::tempdir().unwrap();
        let session = temp.path().join("thread");
        let identity = TurnAttemptIdentity {
            thread_id: "thread".into(),
            turn_id: "turn-1".into(),
            attempt_id: "attempt-1".into(),
        };
        assert!(
            TurnAttemptStore::open_existing(&session, "thread")
                .unwrap()
                .is_none()
        );
        assert!(
            conclusively_unaccepted(&[], Some("turn-1"), &identity, "message").unwrap(),
            "map-before-Accept crash is recoverable without inventing an Accepted record"
        );
        assert!(!conclusively_unaccepted(&[], Some("other-turn"), &identity, "message").unwrap());
        let mut accepted = TurnAttemptRecord {
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        };
        let store = TurnAttemptStore::open(&session, "thread").unwrap();
        store.begin(accepted.clone()).unwrap();
        let reopened = TurnAttemptStore::open_existing(&session, "thread")
            .unwrap()
            .unwrap();
        let records = reopened.list().unwrap();
        assert!(!conclusively_unaccepted(&records, Some("turn-1"), &identity, "message").unwrap());
        accepted.status = TurnAttemptStatus::Unknown("future-outcome".into());
        assert!(
            !conclusively_unaccepted(&[accepted.clone()], Some("turn-1"), &identity, "message")
                .unwrap()
        );
        accepted.identity.turn_id = "legacy-other".into();
        assert!(
            !conclusively_unaccepted(&[accepted.clone()], None, &identity, "message").unwrap(),
            "legacy map absence cannot prove a different attempt unrelated"
        );
        accepted.version = 99;
        assert!(
            conclusively_unaccepted(&[accepted], Some("turn-1"), &identity, "message").is_err()
        );
        let directory = session.join("turn-attempts");
        let record = std::fs::read_dir(&directory)
            .unwrap()
            .find_map(|entry| {
                let path = entry.unwrap().path();
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .ends_with(".attempt.json")
                    .then_some(path)
            })
            .unwrap();
        std::fs::write(record, b"{corrupt").unwrap();
        assert!(
            reopened.list().is_err(),
            "corrupt disk catalog is not absence"
        );
    }
}
