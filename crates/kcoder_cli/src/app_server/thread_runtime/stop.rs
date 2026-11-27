//! A resident-owned stop operation; the dispatcher remains available for private replies.
use super::*;
use crate::app_server::{self, *};

impl ThreadManager {
    /// Use the existing metadata mutation and receipt, without another stop-operation ledger.
    /// The runtime retains its lease and owns cleanup even if the requesting client disconnects.
    pub(in crate::app_server) fn archive_resident(
        &mut self,
        params: ThreadMetadataUpdateParams,
        id: Value,
        outbound: mpsc::Sender<Value>,
        server_id: String,
        sequence: Arc<AtomicU64>,
    ) -> Result<bool> {
        let Some(runtime) = self.runtimes.get_mut(&params.thread_id) else {
            return Ok(false);
        };
        ensure!(
            runtime
                .archive_job
                .as_ref()
                .is_none_or(|job| job.is_finished()),
            "THREAD_STOP_IN_PROGRESS"
        );
        if !matches!(params.archived_at, MetadataUpdate::Set(_)) {
            return Ok(false);
        }
        ensure!(
            !runtime.ephemeral,
            "THREAD_ARCHIVE_PERSISTENT_TASK_REQUIRED"
        );
        validate_thread_metadata_patch(&params)?;
        ensure!(
            runtime
                .lease
                .matches_target(&runtime.engine.session_lease_target()),
            "THREAD_STOP_OWNER_CHANGED"
        );
        let engine = runtime.engine.clone();
        let turn = runtime.turn_state.clone();
        let projection = runtime.background_projection.clone();
        let followups = runtime.background_followups.clone();
        runtime.archive_job = Some(app_server::task_spawn::spawn(async move {
            let mut terminal_notice = None;
            let mut goal_changed = false;
            let result: Result<ThreadMetadataUpdateResult> = async {
                let (active, changed, accepted_input) = {
                    // A start response can precede release of its registration guard. Await
                    // that original boundary off-dispatcher, then fence before taking the handle.
                    // An earlier maintenance guard must finish its reopen before this stop.
                    let _gate = tokio::time::timeout(
                        ACTIVE_TURN_SHUTDOWN_TIMEOUT,
                        turn.activity_gate.lock(),
                    )
                    .await
                    .context("THREAD_STOP_UNCONFIRMED")?;
                    turn.stop_accepting_turns();
                    engine.stop_accepting_managed_work();
                    let active = turn.active_turn.lock().await.take();
                    let accepted_input = turn.accepted_input();
                    if let Some(active) = &active {
                        active.cancel.cancel();
                    }
                    followups.goals.lock().unwrap().suspend();
                    let changed = engine
                        .state
                        .goal()
                        .is_some_and(|goal| goal.status.is_active());
                    if changed {
                        engine.state.update_goal_status(GoalStatus::Paused);
                    }
                    (active, changed, accepted_input)
                };
                goal_changed = changed;
                let stop_turn = async {
                    let notice = if let Some(active) = active {
                        Some(
                            turn_interrupt::Interruption {
                                active,
                                turn_state: turn.clone(),
                                projection,
                                followups: followups.clone(),
                                engine: Some(engine.clone()),
                                outbound: outbound.clone(),
                                server_id,
                                sequence,
                            }
                            .settle()
                            .await,
                        )
                    } else {
                        // A previous interrupt may own the original handle already. Observe its
                        // settlement rather than treating a missing handle as proof of completion.
                        tokio::time::timeout(ACTIVE_TURN_SHUTDOWN_TIMEOUT, async {
                            loop {
                                let changed = followups.notify.notified();
                                tokio::pin!(changed);
                                changed.as_mut().enable();
                                if !turn.running.load(Ordering::SeqCst) {
                                    break;
                                }
                                changed.await;
                            }
                        })
                        .await
                        .context("THREAD_STOP_UNCONFIRMED")?;
                        None
                    };
                    Ok::<_, anyhow::Error>(notice)
                };
                let (turn_result, jobs_stopped) =
                    tokio::join!(stop_turn, engine.stop_managed_work());
                terminal_notice = turn_result?;
                ensure!(jobs_stopped, "THREAD_STOP_UNCONFIRMED");
                // TODO(lifecycle): optional owners should observe managed_work_stop_signal()
                // and close their own resources without joining this managed-execution wait set.
                // Detached/persistent services remain under their independent lifecycle.
                preserve_stopped_input(&engine, &turn, &followups, accepted_input).await?;
                update_thread_metadata(&engine, params, &HashSet::new(), true)
            }
            .await;
            // Slow or closed output must not gate the original owner's durable archive.
            // Failed persistence still publishes the already settled execution outcome.
            if let Some(notice) = terminal_notice {
                let _ = notice.publish().await;
            }
            if goal_changed {
                goal_lifecycle::publish_current_guarded(&engine, &outbound, &turn.activity_gate)
                    .await;
            }
            // Failed/unknown archival must not restart queued work or override a concurrent
            // shutdown. Retain the stop fence; retry archive or explicitly unarchive to reopen.
            let response = match result {
                Ok(result) => success_response(
                    id,
                    serde_json::to_value(result).expect("thread metadata serializes"),
                ),
                Err(error) => error_response(id, -32037, &error.to_string()),
            };
            let _ = send(&outbound, response).await;
        }));
        Ok(true)
    }

    pub(in crate::app_server) fn resume_unarchived<T>(
        &self,
        thread_id: &str,
        persist: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if let Some(runtime) = self.runtimes.get(thread_id) {
            ensure!(
                runtime
                    .archive_job
                    .as_ref()
                    .is_none_or(|job| job.is_finished()),
                "THREAD_STOP_IN_PROGRESS"
            );
            // Clearing archive metadata must not release a maintenance/handoff gate
            // whose owner never issued this managed stop signal.
            if !runtime.engine.managed_work_stop_signal().is_cancelled() {
                return persist();
            }
            // Reserve the original owner before clearing durable archive metadata. A
            // rejected restore or failed write must retain both admission fences.
            let _gate = runtime
                .turn_state
                .activity_gate
                .try_lock()
                .map_err(|_| anyhow::anyhow!("THREAD_STOP_UNCONFIRMED"))?;
            ensure!(
                !runtime.turn_state.running.load(Ordering::SeqCst),
                "THREAD_STOP_UNCONFIRMED"
            );
            let _background = runtime
                .engine
                .try_reserve_managed_work_idle()
                .context("THREAD_STOP_UNCONFIRMED")?;
            let result = persist()?;
            ensure!(
                runtime.engine.resume_accepting_managed_work(),
                "THREAD_STOP_UNCONFIRMED"
            );
            runtime.turn_state.resume_accepting_turns();
            return Ok(result);
        }
        persist()
    }

    pub(in crate::app_server) fn is_stopping(&self, thread_id: &str) -> bool {
        self.runtimes.get(thread_id).is_some_and(|runtime| {
            runtime
                .archive_job
                .as_ref()
                .is_some_and(|job| !job.is_finished())
        })
    }
}

async fn preserve_stopped_input(
    engine: &QueryEngine,
    turn: &ResidentTurnState,
    followups: &BackgroundFollowupState,
    input: Option<kcoder_app_events::resident_turn::AcceptedTurnInput>,
) -> Result<()> {
    engine.state.flush_history().await?;
    let Some(path) = engine.state.history_path() else {
        ensure!(input.is_none(), "THREAD_ARCHIVE_PERSISTENT_TASK_REQUIRED");
        return Ok(());
    };
    // Materialize an accepted empty task; never rewrite the existing transcript/model context.
    engine.state.materialize_history()?;
    if let Some(input) = input {
        ensure!(
            input.attempt.thread_id == engine.session_id(),
            "THREAD_STOP_OWNER_CHANGED"
        );
        let history = kcoder_state::load_transcript_history(&path)?;
        let committed = history.iter().find(|entry| {
            entry.history_attempt.as_ref() == Some(&input.attempt)
                && kcoder_engine::agent::is_real_user_message(&entry.message)
        });
        let uuid = if let Some(entry) = committed {
            entry
                .uuid
                .clone()
                .context("accepted input has no history identity")?
        } else {
            // Preserve accepted intent only. No Hooks, model, tools or input replay run here.
            engine
                .state
                .history_attempt_scope(input.attempt.clone())?
                .run(async {
                    engine.state.add_message((*input.message).clone());
                    engine.state.flush_history().await
                })
                .await?;
            engine
                .state
                .latest_message_history_id_matching(kcoder_engine::agent::is_real_user_message)
                .context("accepted input has no history identity")?
        };
        turn_admissions::bind_user_uuid(
            engine,
            &input.attempt.thread_id,
            &input.attempt.turn_id,
            uuid,
        )?;
        followups
            .client_turn_count
            .reset(reconstruct_client_turn_count(engine)?);
        turn.clear_accepted_input(&input.attempt);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::thread_runtime::test_support::test_runtime;

    fn private_root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn owned_runtime(root: &std::path::Path) -> ThreadRuntime {
        let mut runtime = test_runtime("archive", &root.join("unused.jsonl"));
        let history = root.join(format!("{}.jsonl", runtime.engine.session_id()));
        runtime.engine.settings.write().unwrap().history_enabled = true;
        runtime.engine.state.with_history_path(&history);
        runtime
            .engine
            .state
            .add_message(kcoder_types::Message::user_text(
                "controlled archive fixture",
            ));
        runtime.engine.state.save_history().unwrap();
        runtime.lease = SessionLease::acquire_existing_history(&history).unwrap();
        runtime
    }

    fn patch(thread: &str) -> ThreadMetadataUpdateParams {
        ThreadMetadataUpdateParams {
            thread_id: thread.into(),
            archived_at: MetadataUpdate::Set("2026-11-19T00:00:00Z".into()),
            ..Default::default()
        }
    }

    async fn response(rx: &mut mpsc::Receiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let frame = rx.recv().await.expect("archive owner must respond");
                if frame.get("id") == Some(&json!(1)) {
                    return frame;
                }
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn archive_fences_execution_keeps_peer_alive_and_can_be_restored_or_evicted() {
        let root = private_root();
        let runtime = owned_runtime(root.path());
        let engine = runtime.engine();
        let thread = engine.session_id();
        let turn = runtime.turn_state.clone();
        let cancel = CancellationToken::new();
        let running_cancel = cancel.clone();
        turn.running.store(true, Ordering::SeqCst);
        *turn.active_turn.lock().await = Some(ActiveTurn {
            desktop_owner: None,
            input_owner: None,
            handle: tokio::spawn(async move { running_cancel.cancelled().await }),
            cancel: cancel.clone(),
            thread_id: thread.clone(),
            turn_id: "turn-test".into(),
            attempt: None,
            origin: request_origin::RequestOrigin::ClientFrame,
        });
        // An independent service is deliberately outside the managed registry.
        let external = tokio::spawn(std::future::pending::<()>());
        let peer = test_runtime("peer", &root.path().join("peer.jsonl"));
        let peer_state = peer.turn_state.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        assert!(manager.insert(peer).is_ok());
        let (tx, mut rx) = mpsc::channel(32);
        let sequence = Arc::new(AtomicU64::new(1));
        assert!(
            manager
                .archive_resident(
                    patch(&thread),
                    json!(1),
                    tx.clone(),
                    "server".into(),
                    sequence.clone()
                )
                .unwrap()
        );
        assert!(peer_state.accepting_turns.load(Ordering::SeqCst));
        assert!(
            manager
                .archive_resident(patch(&thread), json!(2), tx, "server".into(), sequence)
                .is_err()
        );
        tokio::task::yield_now().await;
        assert!(cancel.is_cancelled());
        let result = response(&mut rx).await;
        assert!(result.get("error").is_none(), "{result}");
        assert_eq!(
            result["result"]["thread"]["archivedAt"],
            "2026-11-19T00:00:00Z"
        );
        assert!(!turn.running.load(Ordering::SeqCst));
        assert!(!turn.accepting_turns.load(Ordering::SeqCst));
        assert!(!external.is_finished());
        // Join the original worker before a restore, independent of its response delivery timing.
        manager
            .runtimes
            .get_mut(&thread)
            .unwrap()
            .archive_job
            .take()
            .unwrap()
            .await
            .unwrap();
        update_thread_metadata(
            &engine,
            ThreadMetadataUpdateParams {
                thread_id: thread.clone(),
                archived_at: MetadataUpdate::Clear,
                ..Default::default()
            },
            &HashSet::new(),
            true,
        )
        .unwrap();
        manager.resume_unarchived(&thread, || Ok(())).unwrap();
        assert!(turn.accepting_turns.load(Ordering::SeqCst));
        // A closed admission must not make an idle archived runtime impossible to evict/delete.
        turn.stop_accepting_turns();
        engine.stop_accepting_managed_work();
        // Restored archived owners have no in-memory archive job. Retained notifications
        // must not pin them resident forever, and must not be discarded to allow eviction.
        let retained = manager.followups(&thread).unwrap();
        retained
            .queue
            .lock()
            .await
            .pending
            .insert("retained".into(), "notification".into());
        assert!(manager.runtimes.get(&thread).unwrap().is_evictable());
        assert_eq!(retained.queue.lock().await.pending.len(), 1);
        manager
            .remove_if_idle(&thread)
            .unwrap()
            .unwrap()
            .shutdown()
            .await;
        external.abort();
        let _ = external.await;
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn accepted_input_is_preserved_without_duplicating_a_committed_attempt() {
        for committed in [false, true] {
            let root = private_root();
            let runtime = owned_runtime(root.path());
            let engine = runtime.engine();
            let thread = engine.session_id();
            let turn = runtime.turn_state.clone();
            let identity = kcoder_types::TurnAttemptIdentity {
                thread_id: thread.clone(),
                turn_id: "turn-1".into(),
                attempt_id: "attempt-1".into(),
            };
            let message = kcoder_types::Message::user_text("accepted original input");
            turn.retain_accepted_input(identity.clone(), Some(message.clone()));
            if committed {
                engine
                    .state
                    .history_attempt_scope(identity.clone())
                    .unwrap()
                    .run(async {
                        engine.state.add_message(message);
                        engine.state.flush_history().await.unwrap();
                    })
                    .await;
                engine
                    .state
                    .set_messages_after_compaction(
                        vec![kcoder_types::Message::compaction_text("summary")],
                        kcoder_state::CompactionTranscriptEvent {
                            trigger: kcoder_state::CompactionTrigger::Manual,
                            pre_tokens: 100,
                            post_tokens: 20,
                            summary: "summary".into(),
                        },
                    )
                    .await
                    .unwrap();
                engine.state.flush_history().await.unwrap();
            }
            let before = std::fs::read(engine.state.history_path().unwrap()).unwrap();
            let mut manager = ThreadManager::default();
            assert!(manager.insert(runtime).is_ok());
            let (tx, mut rx) = mpsc::channel(32);
            manager
                .archive_resident(
                    patch(&thread),
                    json!(1),
                    tx,
                    "server".into(),
                    Arc::new(AtomicU64::new(1)),
                )
                .unwrap();
            let frame = response(&mut rx).await;
            assert!(frame.get("error").is_none(), "{frame}");
            let history =
                kcoder_state::load_transcript_history(&engine.state.history_path().unwrap())
                    .unwrap();
            assert_eq!(
                history
                    .iter()
                    .filter(|entry| entry.history_attempt.as_ref() == Some(&identity))
                    .count(),
                1
            );
            assert!(turn.accepted_input().is_none());
            assert_eq!(manager.volatile_turn_count(&thread), 2);
            let uuid = history
                .iter()
                .find(|entry| entry.history_attempt.as_ref() == Some(&identity))
                .unwrap()
                .uuid
                .as_ref()
                .unwrap();
            assert_eq!(
                turn_admissions::bindings(&engine, &thread)
                    .unwrap()
                    .get(uuid),
                Some(&identity.turn_id)
            );
            if committed {
                assert_eq!(
                    std::fs::read(engine.state.history_path().unwrap()).unwrap(),
                    before
                );
            }
            for runtime in manager.drain() {
                runtime.shutdown().await;
            }
        }
    }

    #[tokio::test]
    async fn output_delivery_cannot_block_the_owned_archive_or_discard_input() {
        for backpressured in [false, true] {
            let root = private_root();
            let runtime = owned_runtime(root.path());
            let engine = runtime.engine();
            let thread = engine.session_id();
            let turn = runtime.turn_state.clone();
            let identity = kcoder_types::TurnAttemptIdentity {
                thread_id: thread.clone(),
                turn_id: "turn-closed".into(),
                attempt_id: "original".into(),
            };
            turn.retain_accepted_input(
                identity.clone(),
                Some(kcoder_types::Message::user_text(
                    "accepted before disconnect",
                )),
            );
            turn.running.store(true, Ordering::SeqCst);
            *turn.active_turn.lock().await = Some(ActiveTurn {
                desktop_owner: None,
                input_owner: None,
                handle: tokio::spawn(std::future::pending()),
                cancel: CancellationToken::new(),
                thread_id: thread.clone(),
                turn_id: identity.turn_id.clone(),
                attempt: Some(identity),
                origin: request_origin::RequestOrigin::ClientFrame,
            });
            let mut manager = ThreadManager::default();
            assert!(manager.insert(runtime).is_ok());
            let (tx, rx) = mpsc::channel(1);
            let mut listener = if backpressured {
                tx.try_send(json!({"occupied": true})).unwrap();
                Some(rx)
            } else {
                drop(rx);
                None
            };
            let sequence = Arc::new(AtomicU64::new(1));
            manager
                .archive_resident(
                    patch(&thread),
                    json!(1),
                    tx,
                    "server".into(),
                    sequence.clone(),
                )
                .unwrap();
            if let Some(rx) = listener.as_mut() {
                // Keep the sink full until both the stop and durable archive have completed.
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        if read_thread_metadata(&engine, &thread)
                            .unwrap()
                            .is_some_and(|metadata| {
                                metadata
                                    .fields
                                    .get("archivedAt")
                                    .and_then(Option::as_ref)
                                    .is_some()
                            })
                        {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("output backpressure blocked archive persistence");
                assert!(manager.is_stopping(&thread));
                let watermark = sequence.fetch_add(10, Ordering::SeqCst) + 10;
                assert_eq!(rx.recv().await.unwrap(), json!({"occupied": true}));
                let terminal = rx.recv().await.unwrap();
                assert_eq!(terminal["method"], "turn/completed");
                assert!(terminal["params"]["sequence"].as_u64().unwrap() >= watermark);
                assert_eq!(terminal["params"]["turn"]["status"], "interrupted");
                let receipt = response(rx).await;
                assert!(receipt.get("error").is_none(), "{receipt}");
            }
            manager
                .runtimes
                .get_mut(&thread)
                .unwrap()
                .archive_job
                .take()
                .unwrap()
                .await
                .unwrap();
            assert_eq!(
                read_thread_metadata(&engine, &thread)
                    .unwrap()
                    .unwrap()
                    .fields
                    .get("archivedAt"),
                Some(&Some("2026-11-19T00:00:00Z".into()))
            );
            let history =
                kcoder_state::load_transcript_history(&engine.state.history_path().unwrap())
                    .unwrap();
            assert!(history.iter().any(|entry| {
                entry
                    .message
                    .preview(100)
                    .contains("accepted before disconnect")
            }));
            assert!(!turn.running.load(Ordering::SeqCst));
            for runtime in manager.drain() {
                runtime.shutdown().await;
            }
        }
    }

    #[tokio::test]
    async fn archive_does_not_override_a_maintenance_reservations_reopen() {
        let root = private_root();
        let runtime = owned_runtime(root.path());
        let thread = runtime.engine.session_id();
        let state = runtime.turn_state.clone();
        let held = state.activity_gate.lock().await;
        state.stop_accepting_turns();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        manager.resume_unarchived(&thread, || Ok(())).unwrap();
        assert!(!state.accepting_turns.load(Ordering::SeqCst));
        assert!(manager.remove_if_idle(&thread).is_err());
        let (tx, mut rx) = mpsc::channel(4);
        assert!(
            manager
                .archive_resident(
                    patch(&thread),
                    json!(1),
                    tx,
                    "s".into(),
                    Arc::new(AtomicU64::new(1))
                )
                .unwrap()
        );
        tokio::task::yield_now().await;
        assert!(rx.try_recv().is_err());
        assert!(manager.is_stopping(&thread));
        state.resume_accepting_turns();
        drop(held);
        let frame = response(&mut rx).await;
        assert!(frame.get("error").is_none(), "{frame}");
        assert!(!state.accepting_turns.load(Ordering::SeqCst));
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn missing_handle_still_waits_for_the_original_interrupt_to_settle() {
        let root = private_root();
        let runtime = owned_runtime(root.path());
        let thread = runtime.engine.session_id();
        let state = runtime.turn_state.clone();
        let followups = runtime.background_followups.clone();
        state.running.store(true, Ordering::SeqCst);
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let (tx, mut rx) = mpsc::channel(32);
        manager
            .archive_resident(
                patch(&thread),
                json!(1),
                tx,
                "server".into(),
                Arc::new(AtomicU64::new(1)),
            )
            .unwrap();
        tokio::task::yield_now().await;
        assert!(
            rx.try_recv().is_err(),
            "a taken handle is not a stopped turn"
        );
        state.running.store(false, Ordering::SeqCst);
        followups.notify.notify_waiters();
        let frame = response(&mut rx).await;
        assert!(frame.get("error").is_none(), "{frame}");
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn failed_archive_keeps_execution_stopped_and_can_retry_without_replaying_work() {
        let root = private_root();
        let runtime = owned_runtime(root.path());
        let engine = runtime.engine();
        let thread = engine.session_id();
        let state = runtime.turn_state.clone();
        let invalid_file = engine
            .client_storage_root()
            .join(&thread)
            .join(THREAD_METADATA_FILE);
        std::fs::create_dir_all(&invalid_file).unwrap();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let (tx, mut rx) = mpsc::channel(32);
        let sequence = Arc::new(AtomicU64::new(1));
        manager
            .archive_resident(
                patch(&thread),
                json!(1),
                tx.clone(),
                "s".into(),
                sequence.clone(),
            )
            .unwrap();
        assert!(response(&mut rx).await.get("error").is_some());
        assert!(!state.accepting_turns.load(Ordering::SeqCst));
        manager
            .runtimes
            .get_mut(&thread)
            .unwrap()
            .archive_job
            .take()
            .unwrap()
            .await
            .unwrap();
        std::fs::remove_dir(&invalid_file).unwrap();
        manager
            .archive_resident(patch(&thread), json!(1), tx, "s".into(), sequence)
            .unwrap();
        let frame = response(&mut rx).await;
        assert!(frame.get("error").is_none(), "{frame}");
        assert!(!state.accepting_turns.load(Ordering::SeqCst));
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn restore_rejects_busy_owners_without_clearing_the_durable_archive() {
        for busy in ["turn", "gate", "background"] {
            let root = private_root();
            let runtime = owned_runtime(root.path());
            let engine = runtime.engine();
            let thread = engine.session_id();
            let state = runtime.turn_state.clone();
            update_thread_metadata(&engine, patch(&thread), &HashSet::new(), true).unwrap();
            let original = read_thread_metadata(&engine, &thread).unwrap().unwrap();
            state.stop_accepting_turns();
            engine.stop_accepting_managed_work();
            state.running.store(busy == "turn", Ordering::SeqCst);
            let gate = if busy == "gate" {
                Some(state.activity_gate.lock().await)
            } else {
                None
            };
            let background = if busy == "background" {
                Some(engine.try_reserve_managed_work_idle().unwrap())
            } else {
                None
            };
            let mut manager = ThreadManager::default();
            assert!(manager.insert(runtime).is_ok());
            let (tx, mut rx) = mpsc::channel(8);
            thread_read_requests::dispatch_original(
                method::THREAD_METADATA_UPDATE,
                json!(1),
                json!({"threadId":thread,"archivedAt":null}),
                &engine,
                &tx,
                &mut manager,
                &mut ConnectionState::default(),
                &mut thread_list_snapshots::ThreadListSnapshots::default(),
                &mut history_refresh_processor::HistoryRefreshProcessor::default(),
            )
            .await
            .unwrap();
            let frame = response(&mut rx).await;
            assert!(frame.get("error").is_some(), "{busy}: {frame}");
            let actual = read_thread_metadata(&engine, &thread).unwrap().unwrap();
            assert_eq!(actual.revision, original.revision, "{busy}");
            assert_eq!(actual.fields, original.fields, "{busy}");
            assert!(!state.accepting_turns.load(Ordering::SeqCst));
            assert!(engine.managed_work_stop_signal().is_cancelled());
            state.running.store(false, Ordering::SeqCst);
            drop(gate);
            drop(background);
            for runtime in manager.drain() {
                runtime.shutdown().await;
            }
        }
    }

    #[tokio::test]
    async fn restore_keeps_admissions_closed_until_metadata_persistence_succeeds() {
        let root = private_root();
        let runtime = owned_runtime(root.path());
        let engine = runtime.engine();
        let thread = engine.session_id();
        let state = runtime.turn_state.clone();
        state.stop_accepting_turns();
        engine.stop_accepting_managed_work();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let result: Result<()> = manager.resume_unarchived(&thread, || {
            assert!(!state.accepting_turns.load(Ordering::SeqCst));
            assert!(engine.managed_work_stop_signal().is_cancelled());
            anyhow::bail!("controlled metadata failure")
        });
        assert!(result.is_err());
        assert!(!state.accepting_turns.load(Ordering::SeqCst));
        assert!(engine.managed_work_stop_signal().is_cancelled());
        manager
            .resume_unarchived(&thread, || {
                assert!(!state.accepting_turns.load(Ordering::SeqCst));
                assert!(engine.managed_work_stop_signal().is_cancelled());
                Ok(())
            })
            .unwrap();
        assert!(state.accepting_turns.load(Ordering::SeqCst));
        assert!(!engine.managed_work_stop_signal().is_cancelled());
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }

    #[tokio::test]
    async fn finite_consumers_keep_idle_archive_and_explicit_restore() {
        let root = private_root();
        let runtime = owned_runtime(root.path());
        let engine = runtime.engine();
        let thread = engine.session_id();
        let state = runtime.turn_state.clone();
        let mut manager = ThreadManager::default();
        assert!(manager.insert(runtime).is_ok());
        let (tx, mut rx) = mpsc::channel(32);
        let mut connection = ConnectionState::default();
        let mut snapshots = thread_list_snapshots::ThreadListSnapshots::default();
        let mut refresh = history_refresh_processor::HistoryRefreshProcessor::default();
        for archived_at in [json!("2026-11-19T00:00:00Z"), Value::Null] {
            thread_read_requests::dispatch_original(
                method::THREAD_METADATA_UPDATE,
                json!(1),
                json!({"threadId":thread,"archivedAt":archived_at}),
                &engine,
                &tx,
                &mut manager,
                &mut connection,
                &mut snapshots,
                &mut refresh,
            )
            .await
            .unwrap();
            let frame = response(&mut rx).await;
            assert!(frame.get("error").is_none(), "{frame}");
            assert_eq!(
                state.accepting_turns.load(Ordering::SeqCst),
                archived_at.is_null()
            );
        }
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }
}
