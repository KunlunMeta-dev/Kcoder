use super::*;

#[test]
fn original_receipt_read_waits_for_its_short_writer_without_replaying_a_mutation() -> Result<()> {
    use std::{
        sync::{Arc, mpsc},
        time::Duration,
    };
    let root = tempfile::tempdir()?;
    let private = PrivateDirectory::open_or_create(root.path())?;
    let store = Arc::new(queue(&private)?);
    let original = store.enqueue(&source(), intent("writer-busy"), store.revision()?)?;
    let before = store.queue_body_io_counts().1;
    let writer = store.lease(true)?;
    let (entered, started) = mpsc::channel();
    let (finished, result) = mpsc::channel();
    let reader = store.clone();
    let worker = std::thread::spawn(move || {
        entered.send(()).unwrap();
        finished
            .send(reader.get_receipt_binding_by_client_id(&source(), "writer-busy"))
            .unwrap();
    });
    started.recv_timeout(Duration::from_secs(2))?;
    let premature = result.recv_timeout(Duration::from_millis(20));
    drop(writer);
    let waited = matches!(premature, Err(mpsc::RecvTimeoutError::Timeout));
    let observed = match premature {
        Ok(value) => value,
        Err(mpsc::RecvTimeoutError::Timeout) => result.recv_timeout(Duration::from_secs(2))?,
        Err(error) => return Err(error.into()),
    };
    worker.join().unwrap();
    assert!(
        waited,
        "a still-owned writer must not produce a spurious unknown receipt"
    );
    assert_eq!(observed?.unwrap().receipt, original);
    assert_eq!(
        store.queue_body_io_counts().1,
        before,
        "receipt observation never writes or resends"
    );
    Ok(())
}

#[test]
fn receipt_and_provenance_query_share_one_snapshot_across_terminal_transition() -> Result<()> {
    let root = tempfile::tempdir()?;
    let private = PrivateDirectory::open_or_create(root.path())?;
    let store = queue(&private)?;
    let queued = store.enqueue(&source(), intent("snapshot"), store.revision()?)?;
    let live = store
        .get_receipt_binding_by_client_id(&source(), "snapshot")?
        .unwrap();
    assert_eq!(live.receipt, queued);
    let terminal = store.reject_queued(&queued.message_id, "owned_rejection", store.revision()?)?;
    let binding = store
        .get_receipt_binding_by_client_id(&source(), "snapshot")?
        .unwrap();
    assert_ne!(
        binding.receipt, queued,
        "a prior independent receipt is stale"
    );
    assert_eq!(binding.receipt, terminal);
    assert_eq!(binding.body_sha256, live.body_sha256);
    let other = CrossSessionMessageSource {
        principal_id: "another-principal".into(),
        ..source()
    };
    assert!(
        store
            .get_receipt_binding_by_client_id(&other, "snapshot")?
            .is_none()
    );
    store.maintain(crate::now_millis() + BODY_RETENTION_MS + 1)?;
    let before = store.queue_body_io_counts();
    for _ in 0..10 {
        let archived = store
            .get_receipt_binding_by_client_id(&source(), "snapshot")?
            .unwrap();
        assert_eq!(archived.receipt, terminal);
        assert_eq!(archived.body_sha256, live.body_sha256);
    }
    assert_eq!(
        store.queue_body_io_counts().1,
        before.1,
        "warm receipt queries never write"
    );
    Ok(())
}

fn scope() -> CrossSessionMessageScope {
    CrossSessionMessageScope {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: "owned-workspace".into(),
    }
}
fn source() -> CrossSessionMessageSource {
    CrossSessionMessageSource {
        thread_id: "owned-source".into(),
        principal_id: "owned-principal".into(),
        address: None,
    }
}
fn intent(id: &str) -> AgentMessageIntent {
    AgentMessageIntent {
        reply_to_message_id: None,
        client_message_id: id.into(),
        target_thread_id: "owned-target-thread".into(),
        target_address: None,
        mode: AgentMessageMode::EnqueueOnly,
        expected_turn_id: None,
        text: format!("Original private body for {id}"),
    }
}
fn queue(root: &PrivateDirectory) -> Result<CrossSessionMessageStore> {
    CrossSessionMessageStore::create_in(root, OsStr::new("queue"), &scope())
}

#[test]
fn binding_convergence_cold_queue_preserves_archived_receipts_and_unknown_delivery() -> Result<()> {
    let root = tempfile::tempdir()?;
    let private = PrivateDirectory::open_or_create(root.path())?;
    let store = queue(&private)?;
    let receipt = store.enqueue(&source(), intent("terminal-before-move"), store.revision()?)?;
    let terminal =
        store.reject_queued(&receipt.message_id, "owned_rejection", store.revision()?)?;
    let original = store
        .get_receipt_binding_by_client_id(&source(), "terminal-before-move")?
        .unwrap();
    let uncertain = store.enqueue(&source(), intent("unknown-before-move"), store.revision()?)?;
    let now = crate::now_millis();
    let lease = store
        .reserve_next("owned-target-thread", store.revision()?, now, now + 1000)?
        .unwrap();
    let unknown = store.mark_unknown(&lease, store.revision()?)?;
    assert_eq!(unknown.message_id, uncertain.message_id);
    drop(store);
    let old = root.path().join("old-queue");
    std::fs::rename(root.path().join("queue"), &old)?;
    let target = private.create_private_child(OsStr::new("queue"))?;
    for entry in std::fs::read_dir(&old)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            target.create_private_child(&entry.file_name())?;
            for file in std::fs::read_dir(entry.path())? {
                let file = file?;
                let to = root
                    .path()
                    .join("queue")
                    .join(entry.file_name())
                    .join(file.file_name());
                if file.file_name() == "setup.lock" {
                    std::fs::rename(file.path(), to)?;
                } else {
                    std::fs::copy(file.path(), to)?;
                }
            }
        } else {
            let to = root.path().join("queue").join(entry.file_name());
            if entry.file_name() == LOCK {
                std::fs::rename(entry.path(), to)?;
            } else {
                std::fs::copy(entry.path(), to)?;
            }
        }
    }
    let reopened =
        CrossSessionMessageStore::open_in(&private, OsStr::new("queue"), &scope())?.unwrap();
    let observed = reopened
        .get_receipt_binding_by_client_id(&source(), "terminal-before-move")?
        .unwrap();
    assert_eq!(observed.receipt, terminal);
    assert_eq!(observed.body_sha256, original.body_sha256);
    assert_eq!(
        reopened
            .get_receipt_binding_by_client_id(&source(), "unknown-before-move")?
            .unwrap()
            .receipt,
        unknown
    );
    assert!(
        reopened
            .reserve_next("owned-target-thread", reopened.revision()?, now, now + 1000)
            .is_err()
    );
    assert_eq!(
        std::fs::read(old.join(HEADER))?,
        std::fs::read(root.path().join("queue").join(HEADER))?
    );
    Ok(())
}
fn legacy_rejected(store: &CrossSessionMessageStore, id: &str) -> Result<AgentMessageReceipt> {
    let receipt = store.enqueue(&source(), intent(id), store.revision()?)?;
    // Build an owned pre-archive format fixture through its original private
    // namespace. No native write occurred, so this terminal is a rejection.
    let mut data: Data = serde_json::from_slice(&store.read(DATA, MAX_DATA_BYTES)?)?;
    let revision = next_revision(&data)?;
    let value = data
        .messages
        .values_mut()
        .find(|value| value.receipt.message_id == receipt.message_id)
        .unwrap();
    value.receipt.status = AgentMessageStatus::Rejected;
    value.receipt.revision = revision;
    value.receipt.reason_code = Some("owned_rejection".into());
    value.terminal_at_ms = Some(crate::now_millis());
    let receipt = value.receipt.clone();
    data.revision = revision;
    store.validate_data(&data)?;
    store
        .directory
        .atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&data)?)?;
    Ok(receipt)
}

#[test]
fn each_bootstrap_failure_preserves_original_ids_and_only_an_owner_resumes_exact_seed() -> Result<()>
{
    for point in [
        "reserved",
        "bootstrap_published",
        "seed_committed",
        "manifest_published",
        "before_sql_commit",
    ] {
        let root = kcoder_config::create_private_temp_dir("peer-archive-bootstrap")?;
        let parent = PrivateDirectory::open_existing(root.path())?;
        let store = queue(&parent)?;
        let original = legacy_rejected(&store, "original")?;
        FAILURE_POINT.with(|failure| failure.set(Some(point)));
        assert!(
            store
                .enqueue(&source(), intent("next"), store.revision()?)
                .is_err(),
            "fixture did not reach {point}"
        );
        assert!(FAILURE_POINT.with(|failure| failure.get()).is_none());
        let before = std::fs::read(root.path().join("queue/messages.json"))?;
        assert_eq!(
            store.get_by_client_id(&source(), "original")?,
            Some(original.clone())
        );
        assert_eq!(
            std::fs::read(root.path().join("queue/messages.json"))?,
            before,
            "read-only get must not finish bootstrap"
        );
        assert!(
            store.get_by_client_id(&source(), "next")?.is_none(),
            "partial SQL batch must remain invisible at {point}"
        );
        let next = store.enqueue(&source(), intent("next"), store.revision()?)?;
        assert_ne!(next.message_id, original.message_id);
        assert_eq!(store.enqueue(&source(), intent("original"), 1)?, original);
        let mut changed = intent("original");
        changed.text = "changed operation".into();
        assert!(
            store
                .enqueue(&source(), changed, store.revision()?)
                .is_err()
        );
        drop(store);
        let opened =
            CrossSessionMessageStore::open_in(&parent, OsStr::new("queue"), &scope())?.unwrap();
        assert_eq!(
            opened.get_by_message_id(&source(), &original.message_id)?,
            Some(original)
        );
    }
    Ok(())
}

#[test]
fn terminal_rows_do_not_fill_pending_capacity_and_body_retirement_keeps_exact_receipts()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-archive-capacity")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let store = queue(&parent)?;
    let first = store.enqueue(&source(), intent("first"), 1)?;
    let original = store.reject_queued(&first.message_id, "owned_rejection", store.revision()?)?;
    for n in 0..260 {
        let receipt = store.enqueue(
            &source(),
            intent(&format!("terminal-{n}")),
            store.revision()?,
        )?;
        store.reject_queued(&receipt.message_id, "owned_rejection", store.revision()?)?;
    }
    assert!(store.pending_for_target("owned-target-thread")?.is_empty());
    let before = store.queue_body_io_counts();
    for _ in 0..10 {
        assert_eq!(
            store.get_by_client_id(&source(), "first")?,
            Some(original.clone())
        );
    }
    assert_eq!(
        store.queue_body_io_counts().1,
        before.1,
        "point get never writes"
    );
    let binding = store
        .get_receipt_binding_by_message_id(&original.message_id)?
        .unwrap();
    assert_eq!(
        binding.body_sha256,
        format!("{:x}", Sha256::digest(intent("first").text.as_bytes()))
    );
    assert_eq!(
        binding.intent_sha256,
        fingerprint(&source(), &intent("first"))?
    );
    store.maintain(crate::now_millis() + BODY_RETENTION_MS + 1)?;
    assert!(
        store
            .get_record_by_message_id(&original.message_id)
            .is_err(),
        "retired body is explicit, never fabricated empty text"
    );
    assert_eq!(
        store.get_by_message_id(&source(), &original.message_id)?,
        Some(original.clone())
    );
    assert_eq!(store.enqueue(&source(), intent("first"), 1)?, original);
    let other = CrossSessionMessageSource {
        principal_id: "other".into(),
        ..source()
    };
    assert!(
        store
            .get_by_message_id(&other, &original.message_id)?
            .is_none()
    );
    for n in 0..MAX_MESSAGES {
        store.enqueue(
            &source(),
            intent(&format!("pending-{n}")),
            store.revision()?,
        )?;
    }
    assert!(
        store
            .enqueue(&source(), intent("pending-overflow"), store.revision()?)
            .is_err()
    );
    Ok(())
}

#[test]
fn lost_or_replaced_authority_never_falls_back_to_legacy_empty_queue() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-archive-loss")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let store = queue(&parent)?;
    let receipt = legacy_rejected(&store, "original")?;
    let legacy = std::fs::read(root.path().join("queue/messages.json"))?;
    store.enqueue(&source(), intent("force-cutover"), store.revision()?)?;
    let bytes = std::fs::read(root.path().join("queue/messages.json"))?;
    let Disk::Sqlite { binding } = serde_json::from_slice(&bytes)? else {
        panic!("owned migration did not cut over")
    };
    store.directory.atomic_replace(OsStr::new(DATA), &legacy)?;
    assert!(
        store.get_by_client_id(&source(), "original").is_err(),
        "the original namespace fence rejects a pre-archive JSON rollback"
    );
    let old_bootstrap = Disk::Bootstrap {
        binding: binding.clone(),
        data: serde_json::from_slice(&legacy)?,
    };
    store
        .directory
        .atomic_replace(OsStr::new(DATA), &serde_json::to_vec(&old_bootstrap)?)?;
    assert!(
        store.get_by_client_id(&source(), "original").is_err(),
        "a committed fence rejects an old Bootstrap read as well"
    );
    assert!(
        store
            .enqueue(&source(), intent("blocked-downgrade"), 1)
            .is_err()
    );
    store.directory.atomic_replace(OsStr::new(DATA), &bytes)?;
    let child = serde_json::to_value(&binding)?["child"]
        .as_str()
        .unwrap()
        .to_owned();
    let directory = store
        .directory
        .open_entry_handle(OsStr::new(&child))?
        .open_child_directory()?;
    let archive_path = root.path().join("queue").join(child);
    // An open archive rejects replacement. A later request opens afresh and
    // verifies the original logical instance, scope, seed and exact receipts.
    let mut opened = DurableReceiptArchive::open(&store.directory, &binding, false)?;
    let held = directory.open_single_link_regular_file(OsStr::new("catalog.sqlite3"))?;
    let original = std::fs::read(archive_path.join("catalog.sqlite3"))?;
    directory.atomic_replace(OsStr::new("catalog.sqlite3"), &original)?;
    assert!(opened.access(|_| Ok(())).is_err());
    drop(opened);
    assert_eq!(
        store.get_by_client_id(&source(), "original")?,
        Some(receipt)
    );
    assert!(store.enqueue(&source(), intent("new"), 1).is_err());
    drop(held);
    std::fs::remove_file(archive_path.join("catalog.sqlite3"))?;
    assert!(CrossSessionMessageStore::open_in(&parent, OsStr::new("queue"), &scope()).is_err());
    assert!(!archive_path.join("catalog.sqlite3").exists());
    Ok(())
}

struct OwnedHistoryAuthority;
#[async_trait::async_trait]
impl crate::peer_agent_history::PeerMessageAuthorization for OwnedHistoryAuthority {
    async fn check_current(
        &self,
        _: crate::peer_agent_history::PeerHistoryAccess,
        state: &crate::AppState,
        owner: &crate::AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            owner.try_matches(state) == Some(true)
                && record.intent.target_thread_id == state.session_id()
                && record.source == source(),
            "owned archive target changed"
        );
        Ok(())
    }
}
async fn applied_wake(
    store: &CrossSessionMessageStore,
    state: &crate::AppState,
    id: &str,
) -> Result<crate::peer_agent_history::PeerHistoryCommitWitness> {
    let mut message = intent(id);
    message.mode = AgentMessageMode::WakeIfIdle;
    message.target_thread_id = state.session_id();
    store.enqueue(&source(), message, store.revision()?)?;
    let lease = store
        .reserve_next(
            &state.session_id(),
            store.revision()?,
            crate::now_millis(),
            crate::now_millis() + 1000,
        )?
        .unwrap();
    let witness = state
        .commit_peer_message(
            &state.inspection_lifecycle_identity(),
            &lease,
            &OwnedHistoryAuthority,
        )
        .await?;
    store.finish_applied_at_idle(&lease, &witness, store.revision()?)?;
    Ok(witness)
}

#[tokio::test]
async fn archived_claims_remain_one_shot_grace_is_frozen_and_new_user_does_not_revive_old_triggers()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-archive-wake")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let state = crate::AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let crate::UserInputStart::Accepted(pending) = state.try_begin_user_input(
        &state.inspection_lifecycle_identity(),
        crate::Message::user_text("Original actual User task"),
    ) else {
        panic!("owned original User was not admitted")
    };
    pending
        .wait_with_witness()
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let store = std::sync::Arc::new(queue(&parent)?);
    let first = applied_wake(&store, &state, "claimed-wake").await?;
    let crate::PeerAutoWakeClaim::Permit(permit) =
        store.claim_peer_auto_wake(&first, store.revision()?)?
    else {
        panic!("original fresh wake requires its single permit")
    };
    assert!(permit.try_begin()?);
    assert!(!permit.try_begin()?);
    assert!(matches!(
        store.claim_peer_auto_wake(&first, store.revision()?)?,
        crate::PeerAutoWakeClaim::AlreadyClaimed
    ));
    let second = applied_wake(&store, &state, "unclaimed-wake").await?;
    let third = applied_wake(&store, &state, "permit-clock-rollback").await?;
    let crate::PeerAutoWakeClaim::Permit(expired_permit) =
        store.claim_peer_auto_wake(&third, store.revision()?)?
    else {
        panic!("owned wake requires its original permit")
    };
    assert!(
        expired_permit
            .try_begin_at(crate::now_millis() + WAKE_GRACE_MS + 1)
            .is_err()
    );
    let rollback_error = expired_permit
        .try_begin_at(1)
        .expect_err("an already rejected original permit cannot revive when the clock rolls back");
    assert_eq!(
        crate::PeerAutoWakePermit::start_failure_reason(&rollback_error),
        "PEER_WAKE_PERMIT_REJECTED",
        "a clock rollback must keep returning the rejection rather than converting it to an unused permit"
    );
    let deadline = crate::now_millis() + WAKE_GRACE_MS + 1;
    assert!(matches!(
        store.claim_peer_auto_wake_at(&second, store.revision()?, deadline)?,
        crate::PeerAutoWakeClaim::NotEligible
    ));
    let sealed_revision = store.revision()?;
    let sealed_writes = store.queue_body_io_counts().1;
    assert!(
        matches!(
            store.claim_peer_auto_wake_at(&second, store.revision()?, 1)?,
            crate::PeerAutoWakeClaim::NotEligible
        ),
        "an expired observation is sealed before a maintenance tick, even if the clock rolls back"
    );
    assert!(matches!(
        store.claim_peer_auto_wake_at(&second, store.revision()?, deadline + 1000)?,
        crate::PeerAutoWakeClaim::NotEligible
    ));
    assert_eq!(
        store.revision()?,
        sealed_revision,
        "repeated observations of an already sealed deadline do not advance revision"
    );
    assert_eq!(
        store.queue_body_io_counts().1,
        sealed_writes,
        "an already sealed deadline does not rewrite the durable checkpoint"
    );
    assert!(
        permit.try_begin().is_err(),
        "the original permit cannot outlive its frozen server deadline"
    );
    assert!(matches!(
        store.claim_peer_auto_wake(&second, store.revision()?)?,
        crate::PeerAutoWakeClaim::NotEligible
    ));
    let owner = state.inspection_lifecycle_identity();
    let crate::UserInputStart::Accepted(pending) = state.try_begin_user_input(
        &owner,
        crate::Message::user_text("A real new User instruction"),
    ) else {
        panic!("owned real User was not admitted")
    };
    let committed = pending
        .wait_with_witness()
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let reset = committed.peer_wake_reset_witness()?.unwrap();
    store.record_fresh_peer_user_reset(&reset, store.revision()?)?;
    assert!(matches!(
        store.claim_peer_auto_wake(&first, store.revision()?)?,
        crate::PeerAutoWakeClaim::AlreadyClaimed
    ));
    assert!(
        matches!(
            store.claim_peer_auto_wake(&second, store.revision()?)?,
            crate::PeerAutoWakeClaim::NotEligible
        ),
        "a fresh User resets quota, never old message grace"
    );
    let id = first
        .message()
        .peer_agent_data()
        .unwrap()
        .0
        .message_id
        .clone();
    store.maintain(crate::now_millis() + BODY_RETENTION_MS + 1)?;
    let original = store.get_by_message_id(&source(), &id)?.unwrap();
    let before = store.queue_body_io_counts().1;
    assert_eq!(
        store.reconcile_applied(&id, &first, store.revision()?)?,
        original,
        "the original native witness still reconciles the permanent Applied binding after the inbox copy retires"
    );
    assert_eq!(store.queue_body_io_counts().1, before);
    assert!(
        store.get_record_by_message_id(&id).is_err(),
        "reconciliation never restores the retired copy"
    );
    Ok(())
}

#[tokio::test]
async fn committed_claim_with_lost_receipt_only_reconciles_original_marker() -> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-wake-claim-receipt-loss")?;
    let parent = PrivateDirectory::open_existing(root.path())?;
    let state = crate::AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    state.add_message(crate::Message::user_text("Original actual User task"));
    state.flush_history().await?;
    let store = std::sync::Arc::new(queue(&parent)?);
    let original = applied_wake(&store, &state, "original-claim").await?;
    let revision = store.revision()?;
    FAILURE_POINT.with(|point| point.set(Some("after_sql_commit")));
    assert!(
        store.claim_peer_auto_wake(&original, revision).is_err(),
        "the original observer must lose its reply after the SQL commit"
    );
    assert!(FAILURE_POINT.with(|point| point.get()).is_none());
    let revision = store.revision()?;
    let io = store.queue_body_io_counts();
    assert!(
        matches!(
            store.claim_peer_auto_wake(&original, revision)?,
            crate::PeerAutoWakeClaim::AlreadyClaimed
        ),
        "a committed claim never reissues a permit even before provider startup"
    );
    assert_eq!(store.revision()?, revision);
    assert_eq!(store.queue_body_io_counts().1, io.1);
    drop(store);
    let store = std::sync::Arc::new(
        CrossSessionMessageStore::open_in(&parent, OsStr::new("queue"), &scope())?.unwrap(),
    );
    assert!(matches!(
        store.claim_peer_auto_wake(&original, store.revision()?)?,
        crate::PeerAutoWakeClaim::AlreadyClaimed
    ));
    store.access(false, |data| {
        assert_eq!(data.peer_wake_budgets[&state.session_id()].used, 1);
        assert!(data.peer_idle_wakes.is_empty());
        Ok(((), false))
    })?;
    Ok(())
}
