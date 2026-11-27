use super::*;
use std::{path::PathBuf, sync::Mutex};

struct ContinuedProvider {
    calls: Arc<AtomicUsize>,
    source: Arc<CurrentHost>,
    revoke_after_first: bool,
    path: PathBuf,
    writer_released: Arc<AtomicBool>,
}
impl Provider for ContinuedProvider {
    fn name(&self) -> &'static str {
        "owned-claimed-two-request"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        let number = self.calls.fetch_add(1, Ordering::SeqCst);
        assert!(
            number < 2,
            "the original successful request must never replay"
        );
        if number == 1 {
            assert!(self.writer_released.load(Ordering::Acquire));
        }
        let source = self.source.clone();
        let revoke = self.revoke_after_first;
        let path = self.path.clone();
        Ok(Box::pin(async_stream::stream! {
            let content_block = if number == 0 {
                ContentBlock::ToolUse { id: "original-safe-read".into(), name: "read".into(),
                    input: serde_json::json!({"file_path":path}) }
            } else { ContentBlock::Text {text:"Original stream continuation finished".into()} };
            yield Ok(StreamEvent::ContentBlockStart { index:0, content_block });
            yield Ok(StreamEvent::ContentBlockStop {index:0});
            if number == 0 && revoke { source.source_allowed.store(false, Ordering::Release); }
            yield Ok(StreamEvent::MessageStop);
        }))
    }
}

struct ContinuedHost {
    inner: Arc<CurrentHost>,
    contend_second: bool,
    held_once: AtomicBool,
    writer_released: Arc<AtomicBool>,
    workers: Mutex<Vec<std::thread::JoinHandle<()>>>,
    proofs: Mutex<Vec<(usize, uuid::Uuid)>>,
    claims: AtomicUsize,
    contend_settlement: bool,
    revoke_during_settlement: bool,
    settlement_held: AtomicBool,
    queue_lock: PathBuf,
}
impl Drop for ContinuedHost {
    fn drop(&mut self) {
        for worker in self
            .workers
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
        {
            let _ = worker.join();
        }
    }
}
#[async_trait]
impl PeerMessageHost for ContinuedHost {
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        self.inner.apply_at_boundary(call).await
    }
    async fn claim_idle_wake(
        &self,
        call: PeerMessageCall,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<PeerAutoWakeClaim, String> {
        self.claims.fetch_add(1, Ordering::SeqCst);
        self.inner.claim_idle_wake(call, witnesses).await
    }
    async fn settle_idle_wakes_in_provider_context(
        &self,
        call: PeerMessageCall,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<(), String> {
        if self.contend_settlement && !self.settlement_held.swap(true, Ordering::AcqRel) {
            assert!(call.has_current_claimed_peer_start());
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&self.queue_lock)
                .unwrap();
            lock.lock_shared().unwrap();
            let source = self.inner.clone();
            let revoke = self.revoke_during_settlement;
            self.workers
                .lock()
                .unwrap()
                .push(std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    if revoke {
                        source.source_allowed.store(false, Ordering::Release);
                    }
                    lock.unlock().unwrap();
                }));
        }
        self.inner
            .settle_idle_wakes_in_provider_context(call, messages)
            .await
    }
    async fn authorize_claimed_provider_start(
        &self,
        call: PeerMessageCall,
        permit: &PeerAutoWakePermit,
    ) -> Result<(), String> {
        self.inner
            .authorize_claimed_provider_start(call.clone(), permit)
            .await?;
        self.proofs.lock().unwrap().push((
            permit as *const PeerAutoWakePermit as usize,
            permit.bound_provider_stream().unwrap(),
        ));
        if self.contend_second
            && self.inner.provider_checks.load(Ordering::Acquire) == 4
            && !self.held_once.swap(true, Ordering::AcqRel)
        {
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(
                    call.state()
                        .history_path()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join(".kcoder-history.lock"),
                )
                .unwrap();
            lock.lock().unwrap();
            let busy = permit
                .verify_provider_start(call.state(), call.owner())
                .unwrap_err();
            assert!(PeerAutoWakePermit::is_temporary_start_contention(&busy));
            assert!(
                busy.chain()
                    .any(|cause| cause.to_string() == "peer_source_history_writer_busy")
            );
            self.writer_released.store(false, Ordering::Release);
            let released = self.writer_released.clone();
            self.workers
                .lock()
                .unwrap()
                .push(std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(30));
                    lock.unlock().unwrap();
                    released.store(true, Ordering::Release);
                }));
        }
        Ok(())
    }
}

pub(super) async fn run() {
    run_cases(&[
        ("ordinary", false, false, false, false),
        ("writer-contention", true, false, false, false),
        ("revoked", false, true, false, false),
    ])
    .await;
}
pub(super) async fn run_settlement() {
    run_cases(&[
        ("first-reader-contention", false, false, true, false),
        ("source-revoked-during-first-wait", false, false, true, true),
    ])
    .await;
}
async fn run_cases(cases: &[(&str, bool, bool, bool, bool)]) {
    for &(name, contend, revoke, contend_settlement, revoke_during_settlement) in cases {
        let root = crate::test_support::owned_case::owned_tempdir();
        let file = root.path().join(format!("{name}.txt"));
        std::fs::write(&file, "Owned actual safe read result").unwrap();
        let store = Arc::new(
            CrossSessionMessageStore::create_in(
                &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
                OsStr::new("continued-queue"),
                &CrossSessionMessageScope {
                    account_id: "owned-account".into(),
                    target_id: "owned-target".into(),
                    workspace_id: "owned-workspace".into(),
                },
            )
            .unwrap(),
        );
        let inner = Arc::new(CurrentHost {
            store: store.clone(),
            source_allowed: AtomicBool::new(true),
            provider_checks: AtomicUsize::new(0),
            settlement_unavailable: AtomicBool::new(false),
        });
        let calls = Arc::new(AtomicUsize::new(0));
        let released = Arc::new(AtomicBool::new(true));
        let host = Arc::new(ContinuedHost {
            inner: inner.clone(),
            contend_second: contend,
            held_once: AtomicBool::new(false),
            writer_released: released.clone(),
            workers: Mutex::new(vec![]),
            proofs: Mutex::new(vec![]),
            claims: AtomicUsize::new(0),
            contend_settlement,
            revoke_during_settlement,
            settlement_held: AtomicBool::new(false),
            queue_lock: root.path().join("continued-queue/messages.lock"),
        });
        let engine = TestEngineBuilder::new(root.path())
            .owned_test_fixture()
            .provider(Arc::new(ContinuedProvider {
                calls: calls.clone(),
                source: inner.clone(),
                revoke_after_first: revoke,
                path: file,
                writer_released: released,
            }))
            .tool_registry(kcoder_tools::ToolRegistry::new().register(kcoder_tools::FileReadTool))
            .build_with_profile_directory()
            .with_peer_message_host(host.clone());
        engine
            .state
            .with_history_path(root.path().join(format!("{}.jsonl", engine.session_id())));
        engine
            .state
            .add_message(Message::user_text("Original actual User task"));
        engine.state.flush_history().await.unwrap();
        store
            .enqueue(
                &CrossSessionMessageSource {
                    thread_id: "owned-original-source".into(),
                    principal_id: "owned-principal".into(),
                    address: None,
                },
                AgentMessageIntent {
                    reply_to_message_id: None,
                    target_thread_id: engine.session_id(),
                    target_address: None,
                    client_message_id: format!("original-{name}"),
                    mode: AgentMessageMode::WakeIfIdle,
                    expected_turn_id: None,
                    text: "Original same-stream peer contribution".into(),
                },
                store.revision().unwrap(),
            )
            .unwrap();
        let witnesses = engine.apply_peer_messages_at_idle().await.unwrap();
        let PeerAutoWakeClaim::Permit(permit) =
            engine.claim_peer_auto_wake(&witnesses).await.unwrap()
        else {
            panic!("one original permit required")
        };
        assert_eq!(permit.observed_budget_usage().unwrap(), (1, 1));
        let peer = engine
            .clone()
            .prepare_peer_auto_wake_start(permit)
            .await
            .unwrap();
        let proof = peer.peer_auto_wake_start.as_ref().unwrap().clone();
        let events = peer
            .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
            .collect::<Vec<_>>()
            .await;
        for worker in host.workers.lock().unwrap().drain(..) {
            worker.join().unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if revoke_during_settlement {
                0
            } else if revoke {
                1
            } else {
                2
            },
            "{name}: {events:?}"
        );
        assert!(
            inner.provider_checks.load(Ordering::SeqCst)
                >= if revoke_during_settlement { 1 } else { 2 }
        );
        assert_eq!(host.claims.load(Ordering::SeqCst), 1);
        assert_eq!(proof.observed_budget_usage().unwrap(), (1, 1));
        let proofs = host.proofs.lock().unwrap();
        assert!(proofs.iter().all(|proof| proof == &proofs[0]));
        if revoke_during_settlement {
            assert!(proofs.is_empty());
            assert!(proof.provider_dispatch_pending());
        } else {
            assert!(!proofs.is_empty());
            assert_eq!(proofs[0].0, Arc::as_ptr(&proof) as usize);
            assert_eq!(Some(proofs[0].1), proof.bound_provider_stream());
        }
        let messages = engine.state.messages();
        assert_eq!(
            messages
                .iter()
                .filter(|message| kcoder_types::is_real_user_message(message))
                .count(),
            1
        );
        let has_tool_result = messages.iter().any(|message| {
            message.origin() == kcoder_types::MessageOrigin::Runtime && matches!(message,
                Message::User {content,..} if content.iter().any(|block|matches!(block,ContentBlock::ToolResult{..})))
        });
        assert_eq!(has_tool_result, !revoke_during_settlement);
        assert!(engine.state.goal().is_none());
        if contend {
            assert!(host.held_once.load(Ordering::Acquire));
        }
        if !revoke && !revoke_during_settlement {
            assert!(
                !events.iter().any(|event| matches!(
                    event,
                    EngineEvent::ProviderFailed { .. } | EngineEvent::Error(_)
                )),
                "{events:?}"
            );
        } else {
            assert!(
                events.iter().any(|event| matches!(
                    event,
                    EngineEvent::ProviderFailed { .. } | EngineEvent::Error(_)
                )),
                "{events:?}"
            );
        }
    }
}
