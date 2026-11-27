use super::*;
use crate::peer_agent_history::{PeerHistoryAccess, PeerMessageAuthorization};
use crate::{AppState, AppStateLifecycleIdentity, Message, PeerAutoWakeClaim, UserInputStart};
use std::sync::Arc;

struct OwnedAuthority;
#[async_trait::async_trait]
impl PeerMessageAuthorization for OwnedAuthority {
    async fn check_current(
        &self,
        _: PeerHistoryAccess,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            owner.try_matches(state) == Some(true)
                && record.source.thread_id == "owned-source"
                && record.intent.target_thread_id == state.session_id(),
            "owned idle wake scope changed"
        );
        Ok(())
    }
}

fn queue(parent: &kcoder_config::PrivateDirectory) -> Result<Arc<CrossSessionMessageStore>> {
    let scope = CrossSessionMessageScope {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: "owned-workspace".into(),
    };
    Ok(Arc::new(
        CrossSessionMessageStore::open_in(parent, OsStr::new("idle-queue"), &scope)?
            .map(Ok)
            .unwrap_or_else(|| {
                CrossSessionMessageStore::create_in(parent, OsStr::new("idle-queue"), &scope)
            })?,
    ))
}

async fn real_user(state: &AppState, text: &str) -> Result<crate::CommittedUserInput> {
    let UserInputStart::Accepted(pending) = state.try_begin_user_input(
        &state.inspection_lifecycle_identity(),
        Message::user_text(text),
    ) else {
        anyhow::bail!("owned original User was not admitted")
    };
    pending
        .wait_with_witness()
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))
}

async fn commit(
    store: &CrossSessionMessageStore,
    state: &AppState,
    id: &str,
    idle: bool,
    mode: AgentMessageMode,
) -> Result<PeerHistoryCommitWitness> {
    store.enqueue(
        &CrossSessionMessageSource {
            thread_id: "owned-source".into(),
            principal_id: "owned-principal".into(),
            address: None,
        },
        AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: state.session_id(),
            target_address: None,
            client_message_id: id.into(),
            mode,
            expected_turn_id: None,
            text: format!("Original native idle contribution {id}"),
        },
        store.revision()?,
    )?;
    let lease = store
        .reserve_next(&state.session_id(), store.revision()?, 100, 200)?
        .context("owned original delivery missing")?;
    let witness = state
        .commit_peer_message(
            &state.inspection_lifecycle_identity(),
            &lease,
            &OwnedAuthority,
        )
        .await?;
    if idle {
        store.finish_applied_at_idle(&lease, &witness, store.revision()?)?;
    } else {
        store.finish_applied(&lease, &witness, store.revision()?)?;
        // Reclassifying a historical Applied result as idle cannot backfill
        // the original admission that did not occur at its native boundary.
        store.finish_applied_at_idle(&lease, &witness, store.revision()?)?;
    }
    Ok(witness)
}

#[tokio::test]
async fn idle_settlement_with_no_obsolete_intent_shares_the_original_inventory_lease() -> Result<()>
{
    let root = kcoder_config::create_private_temp_dir("peer-idle-shared-settlement")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    real_user(&state, "Original owned User task").await?;
    let store = queue(&parent)?;
    let receipt = store.enqueue(
        &CrossSessionMessageSource {
            thread_id: "owned-source".into(),
            principal_id: "owned-principal".into(),
            address: None,
        },
        AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: state.session_id(),
            target_address: None,
            client_message_id: "original-shared-cid".into(),
            mode: AgentMessageMode::WakeIfIdle,
            expected_turn_id: None,
            text: "Original queued cold contribution".into(),
        },
        store.revision()?,
    )?;
    let revision = store.revision()?;
    let writes = store.writes.load(std::sync::atomic::Ordering::Relaxed);
    let held_inventory = store.lease(false)?;
    let settled = store
        .settle_peer_idle_wakes_absent_from_context(&state, &state.inspection_lifecycle_identity());
    drop(held_inventory);
    settled.context("an unchanged idle queue must not contend for an exclusive writer")?;
    assert_eq!(store.revision()?, revision);
    assert_eq!(
        store.writes.load(std::sync::atomic::Ordering::Relaxed),
        writes
    );
    let original = store
        .get_record_by_message_id(&receipt.message_id)?
        .unwrap();
    assert_eq!(original.receipt.status, AgentMessageStatus::Queued);
    assert_eq!(original.receipt.client_message_id, "original-shared-cid");
    store.access(false, |data| {
        let row = data
            .messages
            .values()
            .find(|row| row.receipt.message_id == receipt.message_id)
            .unwrap();
        assert!(row.reservation.is_none() && row.history_uuid.is_none());
        Ok(((), false))
    })?;
    assert_eq!(
        state
            .messages()
            .iter()
            .filter(|row| row.peer_agent_data().is_some())
            .count(),
        0
    );
    let lease = store
        .reserve_next(&state.session_id(), revision, 100, 200)?
        .unwrap();
    let witness = state
        .commit_peer_message(
            &state.inspection_lifecycle_identity(),
            &lease,
            &OwnedAuthority,
        )
        .await?;
    let applied = store.finish_applied_at_idle(&lease, &witness, store.revision()?)?;
    assert_eq!(applied.message_id, receipt.message_id);
    assert_eq!(applied.client_message_id, receipt.client_message_id);
    assert_eq!(applied.status, AgentMessageStatus::Applied);
    Ok(())
}

async fn obsolete_idle_fixture() -> Result<(
    kcoder_config::PrivateTempDir,
    Arc<CrossSessionMessageStore>,
    AppState,
    PeerHistoryCommitWitness,
)> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-original-cleanup")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    let witness = commit(
        &store,
        &state,
        "original-idle-cleanup",
        true,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    state.set_messages_preserving_history_ids(
        state
            .messages()
            .iter()
            .filter(|message| message.peer_agent_data().is_none())
            .cloned()
            .collect(),
    );
    Ok((root, store, state, witness))
}

#[tokio::test]
async fn idle_settlement_waits_only_for_its_original_writer_acquisition() -> Result<()> {
    let (_root, store, state, _) = obsolete_idle_fixture().await?;
    let owner = state.inspection_lifecycle_identity();
    let revision = store.revision()?;
    let writes = store.writes.load(std::sync::atomic::Ordering::Relaxed);
    let shared = store.lease(false)?;
    let released = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(shared);
    });
    store.settle_peer_idle_wakes_absent_from_context(&state, &owner)?;
    released.join().unwrap();
    assert_eq!(store.revision()?, revision + 1);
    assert_eq!(
        store.writes.load(std::sync::atomic::Ordering::Relaxed),
        writes + 1
    );
    assert!(!store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    let (_root, store, state, _) = obsolete_idle_fixture().await?;
    let revision = store.revision()?;
    let writes = store.writes.load(std::sync::atomic::Ordering::Relaxed);
    let shared = store.lease(false)?;
    let began = std::time::Instant::now();
    let error = store
        .settle_peer_idle_wakes_absent_from_context(&state, &state.inspection_lifecycle_identity())
        .unwrap_err();
    assert_eq!(error.to_string(), "AGENT_MESSAGE_BUSY");
    assert!(began.elapsed() < std::time::Duration::from_secs(1));
    drop(shared);
    assert_eq!(store.revision()?, revision);
    assert_eq!(
        store.writes.load(std::sync::atomic::Ordering::Relaxed),
        writes
    );
    assert!(store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    Ok(())
}

#[tokio::test]
async fn idle_settlement_uses_post_lock_messages_and_rejects_later_revision_drift() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_root, store, state, witness) = obsolete_idle_fixture().await?;
    let owner = state.inspection_lifecycle_identity();
    let shared = store.lease(false)?;
    let changed = state.clone();
    let other = store.clone();
    let peer = witness.message().clone();
    let (entered, pause) = std::sync::mpsc::channel();
    let (resume, ready) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || -> Result<()> {
        pause.recv().unwrap();
        // Restore only this already-committed native peer; no new admission is created.
        changed.add_message(peer);
        drop(shared);
        other.enqueue(
            &CrossSessionMessageSource {
                thread_id: "owned-source".into(),
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                reply_to_message_id: None,
                target_thread_id: changed.session_id(),
                target_address: None,
                client_message_id: "concurrent-original-cid".into(),
                mode: AgentMessageMode::EnqueueOnly,
                expected_turn_id: None,
                text: "Concurrent original contribution".into(),
            },
            other.revision()?,
        )?;
        resume.send(()).unwrap();
        Ok(())
    });
    let checks = AtomicUsize::new(0);
    store.settle_peer_idle_wakes_absent_from_context_checked(&state, &owner, || {
        if checks.fetch_add(1, Ordering::SeqCst) == 2 {
            entered.send(()).unwrap();
            ready.recv().unwrap();
        }
        Ok(())
    })?;
    writer.join().unwrap()?;
    assert!(store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    assert_eq!(store.pending_for_target(&state.session_id())?.len(), 1);
    let (_root, store, state, _) = obsolete_idle_fixture().await?;
    let owner = state.inspection_lifecycle_identity();
    let revision = store.revision()?;
    let checks = AtomicUsize::new(0);
    let result = store.settle_peer_idle_wakes_absent_from_context_checked(&state, &owner, || {
        if checks.fetch_add(1, Ordering::SeqCst) == 4 {
            state.add_message(Message::assistant_text("Concurrent snapshot update"));
        }
        Ok(())
    });
    assert_eq!(
        result.unwrap_err().to_string(),
        "PEER_IDLE_WAKE_CONTEXT_CHANGED"
    );
    assert_eq!(store.revision()?, revision);
    assert!(store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    Ok(())
}

#[tokio::test]
async fn idle_settlement_does_not_retry_revocation_or_an_unknown_transaction() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (_root, store, state, _) = obsolete_idle_fixture().await?;
    let revision = store.revision()?;
    let shared = store.lease(false)?;
    let checks = AtomicUsize::new(0);
    let error = store
        .settle_peer_idle_wakes_absent_from_context_checked(
            &state,
            &state.inspection_lifecycle_identity(),
            || {
                ensure!(
                    checks.fetch_add(1, Ordering::SeqCst) < 3,
                    "owned_original_host_revoked"
                );
                Ok(())
            },
        )
        .unwrap_err();
    drop(shared);
    assert_eq!(error.to_string(), "owned_original_host_revoked");
    assert_eq!(store.revision()?, revision);
    assert!(store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    super::super::archive::FAILURE_POINT.with(|point| point.set(Some("after_sql_commit")));
    let result = store
        .settle_peer_idle_wakes_absent_from_context(&state, &state.inspection_lifecycle_identity());
    super::super::archive::FAILURE_POINT.with(|point| point.set(None));
    assert!(
        result.is_err(),
        "a submitted transaction's unknown result cannot be retried"
    );
    assert_eq!(store.revision()?, revision + 1);
    Ok(())
}

#[tokio::test]
async fn ordinary_provider_context_without_wake_intents_shares_the_inventory_lock() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-user-provider-empty-cleanup")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    real_user(&state, "Actual original User").await?;
    let store = queue(&parent)?;
    let _reply = commit(
        &store,
        &state,
        "original-enqueue-only-reply",
        true,
        AgentMessageMode::EnqueueOnly,
    )
    .await?;
    let (messages, _, owner) = state.shared_messages_with_lifecycle();
    let before = store.revision()?;
    let shared = store.lease(false)?;
    let result = store.settle_peer_idle_wakes_in_provider_context(&state, &owner, &messages);
    drop(shared);
    result.context(
        "ordinary User model context with only enqueue-only replies needs no exclusive cleanup",
    )?;
    assert_eq!(store.revision()?, before);
    assert!(!store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    Ok(())
}

#[tokio::test]
async fn ordinary_provider_context_retires_only_its_frozen_ids_in_one_transaction() -> Result<()> {
    let (_root, store, state, first) = obsolete_idle_fixture().await?;
    let frozen: kcoder_types::SharedMessages = vec![first.message().clone()].into();
    let later = commit(
        &store,
        &state,
        "later-original-context",
        true,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    let revision = store.revision()?;
    let writes = store.writes.load(std::sync::atomic::Ordering::Relaxed);
    let shared = store.lease(false)?;
    let release = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(shared);
    });
    store.settle_peer_idle_wakes_in_provider_context(
        &state,
        &state.inspection_lifecycle_identity(),
        &frozen,
    )?;
    release.join().unwrap();
    assert_eq!(store.revision()?, revision + 1);
    assert_eq!(
        store.writes.load(std::sync::atomic::Ordering::Relaxed),
        writes + 1
    );
    let remaining = store.pending_peer_idle_wakes_for_target(&state.session_id())?;
    assert_eq!(remaining.len(), 1);
    assert_eq!(
        remaining[0].receipt.message_id,
        later.message().peer_agent_data().unwrap().0.message_id
    );
    let all: kcoder_types::SharedMessages = vec![later.message().clone()].into();
    super::super::archive::FAILURE_POINT.with(|point| point.set(Some("after_sql_commit")));
    let failed = store.settle_peer_idle_wakes_in_provider_context(
        &state,
        &state.inspection_lifecycle_identity(),
        &all,
    );
    super::super::archive::FAILURE_POINT.with(|point| point.set(None));
    assert!(
        failed.is_err(),
        "unknown transaction outcome must not rerun cleanup"
    );
    assert_eq!(store.revision()?, revision + 2);
    Ok(())
}

#[tokio::test]
async fn original_first_provider_settlement_waits_only_before_acquiring_its_lease() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-first-settlement-owned")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    let original = commit(
        &store,
        &state,
        "first-settlement",
        true,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    let PeerAutoWakeClaim::Permit(permit) =
        store.claim_peer_auto_wake(&original, store.revision()?)?
    else {
        anyhow::bail!("one original permit required")
    };
    assert!(permit.try_begin()?);
    let stream = uuid::Uuid::new_v4();
    permit.bind_provider_stream(stream)?;
    let (messages, _, owner) = state.shared_messages_with_lifecycle();
    let original_pointer = permit.as_ref() as *const crate::PeerAutoWakePermit;
    let lease = store.lease(false)?;
    let released = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(lease);
    });
    let began = std::time::Instant::now();
    store
        .settle_peer_idle_wakes_before_first_provider(&state, &owner, &messages, &permit, stream)?;
    released.join().unwrap();
    assert!(began.elapsed() >= std::time::Duration::from_millis(20));
    assert_eq!(
        permit.as_ref() as *const crate::PeerAutoWakePermit,
        original_pointer
    );
    assert_eq!(permit.bound_provider_stream(), Some(stream));
    assert_eq!(permit.observed_budget_usage()?, (1, 1));
    assert!(permit.provider_dispatch_pending());

    let writer_state = state.clone();
    let (ready, held) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let guard = writer_state.inner.write().unwrap();
        ready.send(()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        drop(guard);
    });
    held.recv().unwrap();
    let began = std::time::Instant::now();
    store
        .settle_peer_idle_wakes_before_first_provider(&state, &owner, &messages, &permit, stream)?;
    writer.join().unwrap();
    assert!(began.elapsed() >= std::time::Duration::from_millis(20));
    assert_eq!(permit.observed_budget_usage()?, (1, 1));

    // A known post-commit failure is never mistaken for acquisition contention.
    super::super::archive::FAILURE_POINT.with(|point| point.set(Some("after_sql_commit")));
    let failed = store
        .settle_peer_idle_wakes_before_first_provider(&state, &owner, &messages, &permit, stream);
    super::super::archive::FAILURE_POINT.with(|point| point.set(None));
    assert!(
        failed.is_err(),
        "an unknown completed mutation must not be retried into success"
    );
    assert_eq!(
        CrossSessionMessageStore::provider_context_settlement_failure_reason(&failed.unwrap_err()),
        "peer_provider_settlement_unconfirmed"
    );
    assert_eq!(permit.observed_budget_usage()?, (1, 1));

    let fake_busy = anyhow::anyhow!("peer_provider_settlement_message_lease_busy");
    assert_eq!(
        CrossSessionMessageStore::provider_context_settlement_failure_reason(&fake_busy),
        "peer_provider_settlement_unconfirmed"
    );
    assert!(
        store
            .settle_peer_idle_wakes_before_first_provider(
                &state,
                &owner,
                &messages,
                &permit,
                uuid::Uuid::new_v4()
            )
            .is_err()
    );
    assert!(permit.provider_dispatch_pending());
    assert_eq!(permit.observed_budget_usage()?, (1, 1));
    Ok(())
}

#[tokio::test]
async fn original_idle_intent_survives_restart_without_reconstructing_freshness_or_permits()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-durable-owned")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    let path = root.path().join(format!("{}.jsonl", state.session_id()));
    state.with_deferred_history_path(&path);
    let _ = real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    let non_idle = commit(
        &store,
        &state,
        "active",
        false,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    let enqueue = commit(
        &store,
        &state,
        "enqueue",
        true,
        AgentMessageMode::EnqueueOnly,
    )
    .await?;
    assert!(non_idle.newly_inserted_into_context());
    assert!(enqueue.newly_inserted_into_context());
    assert!(
        store
            .pending_peer_idle_wakes_for_target(&state.session_id())?
            .is_empty()
    );
    assert!(matches!(
        store.claim_peer_auto_wake(&non_idle, store.revision()?)?,
        PeerAutoWakeClaim::NotEligible
    ));
    let original = commit(&store, &state, "idle", true, AgentMessageMode::WakeIfIdle).await?;
    assert!(original.newly_inserted_into_context());
    let target = state.session_id();
    let record = store.pending_peer_idle_wakes_for_target(&target)?.remove(0);
    drop((non_idle, enqueue, original));
    state.flush_history().await?;
    drop((state, store));

    let store = queue(&parent)?;
    let restored = AppState::new(root.path());
    restored.resume_from_history(&path)?;
    assert_eq!(restored.session_id(), target);
    let mut observed = restored
        .observe_peer_message_commit(
            &restored.inspection_lifecycle_identity(),
            &record,
            &OwnedAuthority,
        )
        .await?
        .context("original native row missing after restart")?;
    assert!(!observed.newly_inserted_into_context());
    assert!(store.attach_pending_peer_idle_wake(&mut observed)?);
    assert!(observed.has_pending_idle_wake_admission());
    assert!(
        !observed.newly_inserted_into_context(),
        "durable recovery never manufactures a fresh insertion"
    );
    let PeerAutoWakeClaim::Permit(permit) =
        store.claim_peer_auto_wake(&observed, store.revision()?)?
    else {
        anyhow::bail!("original unclaimed idle intent did not survive restart")
    };
    // Losing the original permit, including before provider startup, never
    // permits a second automatic attempt or refunds its durable quota.
    drop((permit, store));
    let store = queue(&parent)?;
    assert!(matches!(
        store.claim_peer_auto_wake(&observed, store.revision()?)?,
        PeerAutoWakeClaim::AlreadyClaimed
    ));
    assert!(!store.has_pending_peer_idle_wake_for_target(&target)?);
    Ok(())
}

#[tokio::test]
async fn provider_consumption_and_actual_user_settle_exact_pending_batch_without_extra_budget()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-batch-owned")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    let first = commit(&store, &state, "first", true, AgentMessageMode::WakeIfIdle).await?;
    let second = commit(&store, &state, "second", true, AgentMessageMode::WakeIfIdle).await?;
    let (request, _, _) = state.shared_messages_with_lifecycle();
    let third = commit(&store, &state, "third", true, AgentMessageMode::WakeIfIdle).await?;
    store.settle_peer_idle_wakes_in_provider_context(
        &state,
        &state.inspection_lifecycle_identity(),
        &request,
    )?;
    assert_eq!(
        store
            .pending_peer_idle_wakes_for_target(&state.session_id())?
            .len(),
        1
    );
    assert!(matches!(
        store.claim_peer_auto_wake(&first, store.revision()?)?,
        PeerAutoWakeClaim::NotEligible
    ));
    assert!(matches!(
        store.claim_peer_auto_wake(&second, store.revision()?)?,
        PeerAutoWakeClaim::NotEligible
    ));
    let PeerAutoWakeClaim::Permit(permit) =
        store.claim_peer_auto_wake(&third, store.revision()?)?
    else {
        anyhow::bail!("unconsumed native peer lost its original intent")
    };
    assert!(permit.try_begin()?);
    let fourth = commit(&store, &state, "fourth", true, AgentMessageMode::WakeIfIdle).await?;
    let fifth = commit(&store, &state, "fifth", true, AgentMessageMode::WakeIfIdle).await?;
    let PeerAutoWakeClaim::Permit(permit) =
        store.claim_peer_auto_wake(&fourth, store.revision()?)?
    else {
        anyhow::bail!("batch requires one original permit")
    };
    assert!(permit.try_begin()?);
    assert!(
        matches!(
            store.claim_peer_auto_wake(&fifth, store.revision()?)?,
            PeerAutoWakeClaim::NotEligible
        ),
        "one model context consumes the whole existing batch"
    );
    let old = commit(
        &store,
        &state,
        "before-user",
        true,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    let user = real_user(&state, "A real new User takes over").await?;
    let reset = user
        .peer_wake_reset_witness()?
        .context("new User proof missing")?;
    store.record_fresh_peer_user_reset(&reset, store.revision()?)?;
    assert!(matches!(
        store.claim_peer_auto_wake(&old, store.revision()?)?,
        PeerAutoWakeClaim::NotEligible
    ));
    assert!(!store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    Ok(())
}

#[tokio::test]
async fn grace_expiry_is_sealed_across_reopen_and_clock_rollback() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-expiry-owned")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    let mut original = commit(&store, &state, "idle", true, AgentMessageMode::WakeIfIdle).await?;
    assert!(store.attach_pending_peer_idle_wake(&mut original)?);
    store.maintain(crate::now_millis() + archive::WAKE_GRACE_MS + 1)?;
    drop(store);
    let store = queue(&parent)?;
    assert!(!store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    assert!(matches!(
        store.claim_peer_auto_wake_at(&original, store.revision()?, 1)?,
        PeerAutoWakeClaim::NotEligible
    ));
    let revision = store.revision()?;
    let io = store.queue_body_io_counts();
    store.maintain(1)?;
    assert_eq!(store.revision()?, revision);
    assert_eq!(store.queue_body_io_counts().1, io.1);
    Ok(())
}

#[tokio::test]
async fn pending_payload_reads_are_bounded_and_compaction_retires_original_intents() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-bounded-owned")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    for index in 0..MAX_IDLE_WAKE_OBSERVATIONS + 1 {
        let _ = commit(
            &store,
            &state,
            &format!("native-{index}"),
            true,
            AgentMessageMode::WakeIfIdle,
        )
        .await?;
    }
    let pending = store.pending_peer_idle_wakes_for_target(&state.session_id())?;
    assert_eq!(pending.len(), MAX_IDLE_WAKE_OBSERVATIONS);
    assert_eq!(pending[0].intent.client_message_id, "native-0");
    assert_eq!(pending.last().unwrap().intent.client_message_id, "native-7");
    state
        .set_messages_after_compaction(
            vec![Message::compaction_text("A real native compaction")],
            crate::CompactionTranscriptEvent {
                trigger: crate::CompactionTrigger::Manual,
                pre_tokens: 1000,
                post_tokens: 10,
                summary: "A real native compaction".into(),
            },
        )
        .await?;
    store.settle_peer_idle_wakes_absent_from_context(
        &state,
        &state.inspection_lifecycle_identity(),
    )?;
    assert!(!store.has_pending_peer_idle_wake_for_target(&state.session_id())?);
    Ok(())
}

#[tokio::test]
async fn actual_native_user_supersedes_pending_and_permit_even_when_budget_reset_is_unavailable()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-user-priority-owned")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let _ = real_user(&state, "Original real User task").await?;
    let store = queue(&parent)?;
    let original = commit(
        &store,
        &state,
        "claimed",
        true,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    let PeerAutoWakeClaim::Permit(permit) =
        store.claim_peer_auto_wake(&original, store.revision()?)?
    else {
        anyhow::bail!("original native permit missing")
    };
    let pending = commit(
        &store,
        &state,
        "unclaimed",
        true,
        AgentMessageMode::WakeIfIdle,
    )
    .await?;
    let (old_request, _, owner) = state.shared_messages_with_lifecycle();
    assert!(
        !state
            .peer_idle_wakes_superseded_by_native_user(&owner, &old_request)
            .await?
    );
    let _new_user = real_user(
        &state,
        "Actual User continues despite an unavailable peer ledger",
    )
    .await?;
    // Intentionally do not record/reset the queue's budget. The native User
    // fact must independently revoke the older automatic work, not refund it.
    let (request, _, owner) = state.shared_messages_with_lifecycle();
    assert!(
        state
            .peer_idle_wakes_superseded_by_native_user(&owner, &request)
            .await?
    );
    assert!(permit.try_begin().is_err());
    store.settle_peer_idle_wakes_absent_from_context(&state, &owner)?;
    assert!(matches!(
        store.claim_peer_auto_wake(&pending, store.revision()?)?,
        PeerAutoWakeClaim::NotEligible
    ));
    store.access(false, |data| {
        assert_eq!(data.peer_wake_budgets[&state.session_id()].used, 1);
        Ok(((), false))
    })?;
    Ok(())
}
