//! Real native history/lease regressions; no polling fixture or Provider call.
use super::*;
use kcoder_cli_storage::session_lease::SessionLease;
use kcoder_state::PeerAutoWakeClaim;
use kcoder_types::{Message, cross_session_messages::*};
use std::{
    ffi::OsStr,
    sync::atomic::{AtomicBool, Ordering},
};

struct TransientResolver {
    target: String,
    unavailable: AtomicBool,
    wake: Arc<AtomicBool>,
}
struct CurrentAuthority {
    target: String,
    wake: Arc<AtomicBool>,
}
#[async_trait]
impl PeerDeliveryAuthorizationResolver for TransientResolver {
    async fn resolve(
        &self,
        _: &PeerMessageCall,
        _: &CrossSessionMessageRecord,
    ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError> {
        if self.unavailable.swap(false, Ordering::SeqCst) {
            return Err(PeerDeliveryResolutionError::Unavailable {
                code: "owned_source_transport_interrupted",
            });
        }
        Ok(Arc::new(CurrentAuthority {
            target: self.target.clone(),
            wake: self.wake.clone(),
        }))
    }
}
#[async_trait]
impl PeerMessageAuthorization for CurrentAuthority {
    async fn check_current(
        &self,
        access: PeerHistoryAccess,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            owner.try_matches(state) == Some(true)
                && state.session_id() == self.target
                && record.intent.target_thread_id == self.target
                && record.source.thread_id == "owned-source",
            "owned native destination changed"
        );
        ensure!(
            access != PeerHistoryAccess::Wake || self.wake.load(Ordering::SeqCst),
            "owned current wake check failed"
        );
        Ok(())
    }
}

#[tokio::test]
async fn applied_original_idle_intent_survives_dropped_callers_and_current_source_failures()
-> Result<()> {
    let root = kcoder_config::create_private_temp_dir("peer-idle-actual-native-lease")?;
    let engine = crate::app_server::tests::catalog_list_test_engine(root.path());
    let path = root
        .path()
        .join("original-artifact")
        .join(format!("{}.jsonl", engine.session_id()));
    let native = SessionLease::acquire(&path)?;
    engine.state.with_deferred_history_path(&path);
    let kcoder_state::UserInputStart::Accepted(input) = engine.state.try_begin_user_input(
        &engine.state.inspection_lifecycle_identity(),
        Message::user_text("Actual original User task"),
    ) else {
        anyhow::bail!("owned User was not admitted")
    };
    input
        .wait_with_witness()
        .await
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let store = Arc::new(CrossSessionMessageStore::create_in(
        &kcoder_config::PrivateDirectory::open_existing(root.path())?,
        OsStr::new("original-mailbox"),
        &CrossSessionMessageScope {
            account_id: "owned-account".into(),
            target_id: "owned-target".into(),
            workspace_id: "owned-workspace".into(),
        },
    )?);
    let source = CrossSessionMessageSource {
        thread_id: "owned-source".into(),
        principal_id: "owned-principal".into(),
        address: None,
    };
    let original = store.enqueue(
        &source,
        AgentMessageIntent {
            reply_to_message_id: None,
            target_thread_id: engine.session_id(),
            target_address: None,
            client_message_id: "original-stable-cid".into(),
            mode: AgentMessageMode::WakeIfIdle,
            expected_turn_id: None,
            text: "Actual original idle contribution".into(),
        },
        store.revision()?,
    )?;
    let wake = Arc::new(AtomicBool::new(true));
    let resolver = Arc::new(TransientResolver {
        target: engine.session_id(),
        unavailable: AtomicBool::new(false),
        wake: wake.clone(),
    });
    let driver = Arc::new(DestinationPeerMessageDriver::new(
        engine.state.clone(),
        engine.state.inspection_lifecycle_identity(),
        native.native_witness()?,
        store.clone(),
        resolver.clone(),
    )?);
    let engine = engine.with_peer_message_host(driver);
    let first = engine
        .apply_peer_messages_at_idle()
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(first.len(), 1);
    assert!(first[0].newly_inserted_into_context());
    assert!(first[0].has_pending_idle_wake_admission());
    resolver.unavailable.store(true, Ordering::SeqCst);
    assert_eq!(
        engine.peer_idle_wake_authorized(&first).await,
        Err("peer_wake_authorization_deferred".into())
    );
    drop(first);
    assert!(store.pending_for_target(&engine.session_id())?.is_empty());
    assert!(store.has_pending_peer_idle_wake_for_target(&engine.session_id())?);
    assert_eq!(
        store
            .get_by_message_id(&source, &original.message_id)?
            .unwrap()
            .status,
        AgentMessageStatus::Applied
    );

    // Refreshing the same real owner replaces its driver, never its original
    // stable message or native admission. No caller retains the fresh witness.
    let driver = Arc::new(DestinationPeerMessageDriver::new(
        engine.state.clone(),
        engine.state.inspection_lifecycle_identity(),
        native.native_witness()?,
        store.clone(),
        resolver,
    )?);
    let engine = engine.with_peer_message_host(driver);
    let recovered = engine
        .apply_peer_messages_at_idle()
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(recovered.len(), 1);
    assert!(!recovered[0].newly_inserted_into_context());
    assert!(recovered[0].has_pending_idle_wake_admission());
    assert_eq!(
        recovered[0]
            .message()
            .peer_agent_data()
            .unwrap()
            .0
            .message_id,
        original.message_id
    );
    wake.store(false, Ordering::SeqCst);
    assert_eq!(
        engine.peer_idle_wake_authorized(&recovered).await,
        Err("peer_wake_authorization_deferred".into())
    );
    assert!(store.has_pending_peer_idle_wake_for_target(&engine.session_id())?);
    wake.store(true, Ordering::SeqCst);
    assert!(
        engine
            .peer_idle_wake_authorized(&recovered)
            .await
            .map_err(anyhow::Error::msg)?
    );
    let PeerAutoWakeClaim::Permit(permit) = engine
        .claim_peer_auto_wake(&recovered)
        .await
        .map_err(anyhow::Error::msg)?
    else {
        anyhow::bail!("original pending admission did not receive its one permit")
    };
    drop(permit);
    assert!(matches!(
        engine
            .claim_peer_auto_wake(&recovered)
            .await
            .map_err(anyhow::Error::msg)?,
        PeerAutoWakeClaim::AlreadyClaimed
    ));
    assert!(
        engine
            .apply_peer_messages_at_idle()
            .await
            .map_err(anyhow::Error::msg)?
            .is_empty()
    );
    assert_eq!(
        kcoder_state::load_transcript_history(&path)?
            .iter()
            .filter(|entry| entry.message.has_peer_agent_metadata())
            .count(),
        1
    );
    drop(native);
    assert_eq!(
        engine.peer_idle_wake_authorized(&recovered).await,
        Err("peer_wake_owner_changed".into()),
        "the original kernel lease remains required"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_idle_settlement_cancel_and_native_retirement_drain_their_worker() -> Result<()> {
    for mode in ["cancel", "lease", "state-write"] {
        let root = kcoder_config::create_private_temp_dir("peer-idle-original-cancel")?;
        let mut engine = crate::app_server::tests::catalog_list_test_engine(root.path());
        let path = root.path().join(format!("{}.jsonl", engine.session_id()));
        let mut native = Some(SessionLease::acquire(&path)?);
        engine.state.with_deferred_history_path(&path);
        engine
            .state
            .commit_message_with_uuid(
                Message::user_text("Actual original User task"),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
        let store = Arc::new(CrossSessionMessageStore::create_in(
            &parent,
            OsStr::new("cancel-mailbox"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )?);
        store.enqueue(
            &CrossSessionMessageSource {
                thread_id: "owned-source".into(),
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                reply_to_message_id: None,
                target_thread_id: engine.session_id(),
                target_address: None,
                client_message_id: "original-cancel-cid".into(),
                mode: AgentMessageMode::WakeIfIdle,
                expected_turn_id: None,
                text: "Original actual native contribution".into(),
            },
            store.revision()?,
        )?;
        let driver = Arc::new(DestinationPeerMessageDriver::new(
            engine.state.clone(),
            engine.state.inspection_lifecycle_identity(),
            native.as_ref().unwrap().native_witness()?,
            store.clone(),
            Arc::new(TransientResolver {
                target: engine.session_id(),
                unavailable: AtomicBool::new(false),
                wake: Arc::new(AtomicBool::new(true)),
            }),
        )?);
        engine = engine.with_peer_message_host(driver.clone());
        assert_eq!(
            engine
                .apply_peer_messages_at_idle()
                .await
                .map_err(anyhow::Error::msg)?
                .len(),
            1
        );
        engine.state.set_messages_preserving_history_ids(
            engine
                .state
                .messages()
                .iter()
                .filter(|message| message.peer_agent_data().is_none())
                .cloned()
                .collect(),
        );
        let mut lock_task = kcoder_state::Task::new("owned-state-lock", "Owned state-lock fixture");
        lock_task.status = kcoder_types::TaskStatus::Completed;
        engine.state.upsert_task(lock_task);
        let before = store.revision()?;
        let directory = parent.open_child(OsStr::new("cancel-mailbox"), false)?;
        let identity = directory.portable_regular_identity(OsStr::new("messages.lock"))?;
        let shared = directory
            .try_existing_portable_lock(
                OsStr::new("messages.lock"),
                &identity,
                kcoder_config::PrivateLeaseMode::Shared,
            )?
            .unwrap();
        let cancel = tokio_util::sync::CancellationToken::new();
        let apply_engine = engine.clone().with_cancel_token(cancel.clone());
        let pending = tokio::spawn(async move { apply_engine.apply_peer_messages_at_idle().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while driver.settlement_workers.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await?;
        let mut writer = None;
        let mut release_writer = None;
        if mode == "state-write" {
            let state = engine.state.clone();
            let (held, ready) = std::sync::mpsc::channel();
            let (release, done) = std::sync::mpsc::channel();
            // Hold the actual State writer through cancellation and worker join.
            writer = Some(std::thread::spawn(move || {
                state.update_task("owned-state-lock", |_| {
                    held.send(()).unwrap();
                    done.recv().unwrap();
                });
            }));
            ready.recv().unwrap();
            release_writer = Some(release);
        }
        if mode == "lease" {
            drop(native.take());
        } else {
            cancel.cancel();
        }
        let outcome = tokio::time::timeout(Duration::from_secs(1), pending).await??;
        assert!(outcome.is_err() || outcome.as_ref().is_ok_and(|rows| rows.is_empty()));
        assert_eq!(
            driver.settlement_workers.load(Ordering::Acquire),
            0,
            "the original worker must have joined before releasing its owner"
        );
        if let Some(release) = release_writer {
            release.send(()).unwrap();
        }
        if let Some(writer) = writer {
            writer.join().unwrap();
        }
        drop(shared);
        assert_eq!(store.revision()?, before);
        assert!(store.has_pending_peer_idle_wake_for_target(&engine.session_id())?);
    }
    Ok(())
}

struct CancelStage {
    mode: &'static str,
    target: String,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    blocked: AtomicBool,
    read_dropped: Arc<AtomicBool>,
}
struct ReadScope(Arc<AtomicBool>);
impl Drop for ReadScope {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}
struct CancelStageResolver(Arc<CancelStage>);
struct CancelStageAuthority(Arc<CancelStage>);
#[async_trait]
impl PeerDeliveryAuthorizationResolver for CancelStageResolver {
    async fn resolve(
        &self,
        _: &PeerMessageCall,
        _: &CrossSessionMessageRecord,
    ) -> std::result::Result<Arc<dyn PeerMessageAuthorization>, PeerDeliveryResolutionError> {
        if self.0.mode == "resolve" && !self.0.blocked.swap(true, Ordering::AcqRel) {
            let _read = ReadScope(self.0.read_dropped.clone());
            self.0.entered.notify_one();
            self.0.release.notified().await;
        }
        Ok(Arc::new(CancelStageAuthority(self.0.clone())))
    }
}
#[async_trait]
impl PeerMessageAuthorization for CancelStageAuthority {
    async fn check_current(
        &self,
        access: PeerHistoryAccess,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            owner.try_matches(state) == Some(true)
                && state.session_id() == self.0.target
                && record.intent.target_thread_id == self.0.target,
            "owned_scope_changed"
        );
        let before_reservation = self.0.mode == "append"
            && access == PeerHistoryAccess::Append
            && record.receipt.status == AgentMessageStatus::Queued;
        let already_written = self.0.mode == "written"
            && access == PeerHistoryAccess::Observe
            && kcoder_state::load_history(&state.history_path().unwrap())?
                .iter()
                .any(|row| {
                    row.message.peer_agent_data().is_some_and(|(metadata, _)| {
                        metadata.message_id == record.receipt.message_id
                    })
                });
        if (before_reservation || already_written) && !self.0.blocked.swap(true, Ordering::AcqRel) {
            let _read = ReadScope(self.0.read_dropped.clone());
            self.0.entered.notify_one();
            self.0.release.notified().await;
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_idle_cancel_stops_only_unreserved_reads_and_drains_the_committed_write()
-> Result<()> {
    for mode in ["resolve", "append", "written"] {
        let root = kcoder_config::create_private_temp_dir("peer-original-cancel-stage")?;
        let mut engine = crate::app_server::tests::catalog_list_test_engine(root.path());
        let path = root.path().join(format!("{}.jsonl", engine.session_id()));
        let _lease = SessionLease::acquire(&path)?;
        engine.state.with_deferred_history_path(&path);
        engine
            .state
            .commit_message_with_uuid(
                Message::user_text("Original real receiving User"),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        let store = Arc::new(CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path())?,
            OsStr::new("cancel-stage-mailbox"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )?);
        let original = store.enqueue(
            &CrossSessionMessageSource {
                thread_id: "owned-source".into(),
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                reply_to_message_id: None,
                target_thread_id: engine.session_id(),
                target_address: None,
                client_message_id: "original-cancel-stage-cid".into(),
                mode: AgentMessageMode::EnqueueOnly,
                expected_turn_id: None,
                text: "Original identified peer message".into(),
            },
            store.revision()?,
        )?;
        let stage = Arc::new(CancelStage {
            mode,
            target: engine.session_id(),
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            blocked: AtomicBool::new(false),
            read_dropped: Arc::new(AtomicBool::new(false)),
        });
        let driver = Arc::new(DestinationPeerMessageDriver::new(
            engine.state.clone(),
            engine.state.inspection_lifecycle_identity(),
            _lease.native_witness()?,
            store.clone(),
            Arc::new(CancelStageResolver(stage.clone())),
        )?);
        engine = engine.with_peer_message_host(driver);
        let cancel = tokio_util::sync::CancellationToken::new();
        let caller = engine.clone().with_cancel_token(cancel.clone());
        let pending = tokio::spawn(async move { caller.apply_peer_messages_at_idle().await });
        tokio::time::timeout(Duration::from_secs(2), stage.entered.notified()).await?;
        cancel.cancel();
        if mode == "written" {
            tokio::task::yield_now().await;
            assert!(
                !pending.is_finished(),
                "an already-written operation must retain its original completion owner"
            );
            stage.release.notify_one();
        }
        let outcome = tokio::time::timeout(Duration::from_secs(2), pending).await??;
        assert!(
            outcome
                .as_ref()
                .is_err_and(|error| error == "peer_target_owner_changed"),
            "a cancelled caller must not consume a result after its work is drained"
        );
        assert!(stage.read_dropped.load(Ordering::Acquire));
        let receipt = store
            .get_record_by_message_id(&original.message_id)?
            .unwrap()
            .receipt;
        assert_eq!(receipt.client_message_id, original.client_message_id);
        let rows = kcoder_state::load_history(&path)?;
        let count = rows
            .iter()
            .filter(|row| row.message.peer_agent_data().is_some())
            .count();
        if mode == "written" {
            assert_eq!(count, 1);
            assert_eq!(receipt.status, AgentMessageStatus::Unknown);
            engine
                .apply_peer_messages_at_idle()
                .await
                .map_err(anyhow::Error::msg)?;
            assert_eq!(
                store
                    .get_record_by_message_id(&original.message_id)?
                    .unwrap()
                    .receipt
                    .status,
                AgentMessageStatus::Applied
            );
            assert_eq!(
                kcoder_state::load_history(&path)?
                    .iter()
                    .filter(|row| row.message.peer_agent_data().is_some())
                    .count(),
                1,
                "reconciliation cannot replay the identified writer"
            );
        } else {
            assert_eq!(count, 0);
            assert_eq!(receipt.status, AgentMessageStatus::Queued);
        }
    }
    Ok(())
}
