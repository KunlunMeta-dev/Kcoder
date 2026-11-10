struct LimitedSchedulerFixture {
    _workspace: tempfile::TempDir,
    scheduler: Option<BackgroundFollowupScheduler>,
    followups: Arc<BackgroundFollowupState>,
    gate: Arc<Mutex<()>>,
    running: Arc<AtomicBool>,
    outbound: mpsc::Receiver<Value>,
    _lease_owner: Arc<AtomicBool>,
    _viewer: ConnectionState,
}

impl LimitedSchedulerFixture {
    fn new() -> Self {
        let workspace = tempfile::tempdir().unwrap();
        let engine = runtime_context_test_engine(workspace.path(), None);
        engine.settings.write().unwrap().goal_max_auto_continuations = 0;
        engine.state.set_goal("owned scheduler fixture", None);
        let followups = Arc::new(BackgroundFollowupState::default());
        let viewer = ConnectionState::default();
        followups
            .session_activity
            .attach(
                &viewer,
                &uuid::Uuid::new_v4().to_string(),
                &uuid::Uuid::new_v4().to_string(),
            )
            .unwrap();
        followups.goals.lock().unwrap().resume(&engine);
        let (outbound, receiver) = mpsc::channel(1);
        outbound.try_send(json!({"occupied": true})).unwrap();
        let turn_state = ResidentTurnState::new(
            outbound.clone(),
            kcoder_config::PermissionMode::Ask,
            Arc::new(AtomicU64::new(1)),
            Arc::new(StdMutex::new(InteractionReceipts::default())),
        );
        let gate = Arc::clone(&turn_state.activity_gate);
        let running = Arc::clone(&turn_state.running);
        let lease_owner = Arc::new(AtomicBool::new(true));
        let scheduler = BackgroundFollowupScheduler::spawn(
            &engine,
            Arc::clone(&followups),
            Arc::clone(&gate),
            Arc::clone(&turn_state.accepting_turns),
            Arc::clone(&running),
            Arc::clone(&turn_state.active_turn),
            Arc::new(Mutex::new(BackgroundProjectionState::default())),
            outbound,
            "owned-server".into(),
            Arc::new(AtomicU64::new(1)),
            Arc::clone(&turn_state.question_context),
            Arc::clone(&turn_state.pending_questions),
            Arc::clone(&turn_state.approval_context),
            Arc::clone(&turn_state.pending_approvals),
            turn_state.permission_prompt.clone(),
            engine.session_lease_target(),
            engine.state.try_inspection_lifecycle_identity(),
            Arc::downgrade(&lease_owner),
        );
        Self {
            _workspace: workspace,
            scheduler: Some(scheduler),
            followups,
            gate,
            running,
            outbound: receiver,
            _lease_owner: lease_owner,
            _viewer: viewer,
        }
    }

    async fn wait_until_limit_observed(&self) -> bool {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if !self.followups.goals.lock().unwrap().pending() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok()
    }

    async fn stop(&mut self) {
        if let Some(scheduler) = self.scheduler.take() {
            scheduler.stop().await;
        }
    }
}

#[tokio::test]
async fn scheduler_backpressure_full_channel_does_not_hold_registration_gate() {
    let mut fixture = LimitedSchedulerFixture::new();
    let observed = fixture.wait_until_limit_observed().await;
    let acquired = tokio::time::timeout(Duration::from_secs(1), fixture.gate.lock())
        .await
        .is_ok();
    let running = fixture.running.load(Ordering::SeqCst);
    let filler = fixture.outbound.recv().await;
    let first = tokio::time::timeout(Duration::from_secs(1), fixture.outbound.recv()).await;
    let second = tokio::time::timeout(Duration::from_secs(1), fixture.outbound.recv()).await;
    fixture.stop().await;
    assert!(observed, "scheduler did not reach the automatic limit");
    assert!(acquired, "backpressure held the registration gate");
    assert!(!running, "a notice must not reserve a running turn");
    assert_eq!(filler.unwrap()["occupied"], true);
    assert_eq!(
        first.unwrap().unwrap()["method"],
        method::THREAD_GOAL_CONTINUATION
    );
    assert_eq!(second.unwrap().unwrap()["method"], "item/event");
}

#[tokio::test]
async fn scheduler_backpressure_stale_notice_is_not_sent_after_control_change() {
    let mut fixture = LimitedSchedulerFixture::new();
    let observed = fixture.wait_until_limit_observed().await;
    let had_gate = {
        let acquired = tokio::time::timeout(Duration::from_secs(1), fixture.gate.lock()).await;
        if let Ok(guard) = acquired {
            fixture.followups.goals.lock().unwrap().invalidate();
            drop(guard);
            true
        } else {
            false
        }
    };
    fixture.outbound.recv().await;
    let stale = tokio::time::timeout(Duration::from_millis(200), fixture.outbound.recv()).await;
    fixture.stop().await;
    assert!(
        observed && had_gate,
        "scheduler did not release the registration gate"
    );
    assert!(
        stale.is_err(),
        "an obsolete goal limit notice was delivered"
    );
}

#[tokio::test]
async fn scheduler_backpressure_waiting_gate_does_not_reserve_response_slot() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    engine.settings.write().unwrap().goal_max_auto_continuations = 0;
    engine.state.set_goal("owned gate fixture", None);
    let followups = Arc::new(BackgroundFollowupState::default());
    let notice = followups
        .goals
        .lock()
        .unwrap()
        .take_limit_notice(&engine)
        .unwrap();
    let gate = Arc::new(Mutex::new(()));
    let held_gate = gate.lock().await;
    let (outbound, mut receiver) = mpsc::channel(1);
    let running = Arc::new(AtomicBool::new(false));
    let cancel = CancellationToken::new();
    let started = Arc::new(tokio::sync::Notify::new());
    let task = {
        let gate = Arc::clone(&gate);
        let followups = Arc::clone(&followups);
        let outbound = outbound.clone();
        let running = Arc::clone(&running);
        let cancel = cancel.clone();
        let started = Arc::clone(&started);
        tokio::spawn(async move {
            started.notify_one();
            background_scheduler::publish_goal_limit_notice(
                &engine,
                &followups,
                &gate,
                &running,
                &outbound,
                "owned-server",
                &Arc::new(AtomicU64::new(1)),
                &cancel,
                notice,
                None,
            )
            .await
        })
    };
    started.notified().await;
    tokio::task::yield_now().await;
    let control_queued = outbound.try_send(json!({"control": true})).is_ok();
    drop(held_gate);
    if control_queued {
        assert_eq!(receiver.recv().await.unwrap()["control"], true);
    }
    cancel.cancel();
    let stopped = tokio::time::timeout(Duration::from_secs(1), task).await;
    assert!(
        control_queued,
        "notice reserved capacity while waiting for the control gate"
    );
    assert!(
        stopped.is_ok(),
        "notice task did not respond to cancellation"
    );
}

#[tokio::test]
async fn goal_control_backpressure_releases_gate_and_publishes_current_state() {
    for clear in [false, true] {
        let workspace = tempfile::tempdir().unwrap();
        let (mut manager, thread_id) = runtime_manager(&workspace.path().join("history.jsonl"));
        let engine = manager.engine(&thread_id).unwrap();
        engine
            .state
            .with_history_path(workspace.path().join("history.jsonl"));
        let turn_state = manager.turn_state(&thread_id).unwrap();
        if clear {
            engine.state.set_goal("original goal", None);
        }
        let (outbound, mut receiver) = mpsc::channel(1);
        outbound.try_send(json!({"occupied": true})).unwrap();
        let method = if clear {
            method::THREAD_GOAL_CLEAR
        } else {
            method::THREAD_GOAL_SET
        };
        let params = if clear {
            json!({"threadId": thread_id})
        } else {
            json!({"threadId": thread_id, "objective": "original goal"})
        };
        let mut request = Box::pin(goal_requests::dispatch(
            method,
            json!(42),
            params,
            &engine,
            &outbound,
            &mut manager,
            None,
        ));
        assert!(
            futures::poll!(request.as_mut()).is_pending(),
            "request must wait for its full output queue"
        );
        let control = async {
            let reached = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let goal = engine.state.goal();
                    let changed = if clear {
                        goal.is_none()
                    } else {
                        goal.is_some_and(|goal| goal.objective == "original goal")
                    };
                    if changed {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            if reached.is_err() {
                receiver.recv().await;
                let diagnostic =
                    tokio::time::timeout(Duration::from_secs(1), receiver.recv()).await;
                panic!("goal operation did not reach its outbound wait: {diagnostic:?}");
            }
            let gate =
                tokio::time::timeout(Duration::from_secs(1), turn_state.activity_gate.lock())
                    .await
                    .expect("goal operation held the gate while waiting for output");
            engine.state.set_goal("newer goal", None);
            drop(gate);
            assert_eq!(receiver.recv().await.unwrap()["occupied"], true);
            let notification = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(notification["method"], method::THREAD_GOAL_UPDATED);
            assert_eq!(notification["params"]["goal"]["objective"], "newer goal");
            let response = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response["id"], 42);
            if clear {
                assert_eq!(response["result"]["cleared"], true);
            } else {
                assert_eq!(response["result"]["goal"]["objective"], "original goal");
            }
        };
        let (result, ()) = tokio::join!(request.as_mut(), control);
        assert!(result.is_ok());
        drop(request);
        for runtime in manager.drain() {
            runtime.shutdown().await;
        }
    }
}

#[tokio::test]
async fn goal_control_backpressure_error_releases_gate() {
    let workspace = tempfile::tempdir().unwrap();
    let (mut manager, thread_id) = runtime_manager(&workspace.path().join("history.jsonl"));
    let engine = manager.engine(&thread_id).unwrap();
    engine
        .state
        .with_history_path(workspace.path().join("history.jsonl"));
    let turn_state = manager.turn_state(&thread_id).unwrap();
    let (outbound, mut receiver) = mpsc::channel(1);
    outbound.try_send(json!({"occupied": true})).unwrap();
    let mut request = Box::pin(goal_requests::dispatch(
        method::THREAD_GOAL_SET,
        json!(43),
        json!({"threadId": thread_id, "status": "invalid status"}),
        &engine,
        &outbound,
        &mut manager,
        None,
    ));
    assert!(
        futures::poll!(request.as_mut()).is_pending(),
        "invalid request must wait for its full output queue"
    );
    let control = async {
        let gate = tokio::time::timeout(Duration::from_secs(1), turn_state.activity_gate.lock())
            .await
            .expect("invalid goal request held the activity gate");
        drop(gate);
        receiver.recv().await;
        let response = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("goal request did not send its error")
            .unwrap();
        assert_eq!(response["id"], 43);
        assert_eq!(response["error"]["code"], -32033);
        assert!(
            response["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("unsupported goal status"))
        );
    };
    let (result, ()) = tokio::join!(request.as_mut(), control);
    assert!(result.is_ok());
    drop(request);
    for runtime in manager.drain() {
        runtime.shutdown().await;
    }
}

#[tokio::test]
async fn goal_control_backpressure_waiting_gate_releases_output_slot() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    engine.state.set_goal("owned gate fixture", None);
    let gate = Arc::new(Mutex::new(()));
    let held_gate = gate.lock().await;
    let (outbound, mut receiver) = mpsc::channel(1);
    let (started_tx, started_rx) = oneshot::channel();
    let task = {
        let gate = Arc::clone(&gate);
        let outbound = outbound.clone();
        tokio::spawn(async move {
            let _ = started_tx.send(());
            goal_lifecycle::publish_current_guarded(&engine, &outbound, &gate).await;
        })
    };
    started_rx.await.unwrap();
    let control_queued = outbound.try_send(json!({"control": true})).is_ok();
    drop(held_gate);
    if control_queued {
        assert_eq!(receiver.recv().await.unwrap()["control"], true);
    }
    let notification = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
        .await
        .expect("goal notification did not complete")
        .unwrap();
    assert_eq!(notification["method"], method::THREAD_GOAL_UPDATED);
    let completed = tokio::time::timeout(Duration::from_secs(1), task).await;
    assert!(control_queued, "notification held the control output slot");
    assert!(completed.is_ok(), "notification task did not finish");
}

#[tokio::test]
async fn goal_control_backpressure_closed_output_cancels_gate_wait() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    engine.state.set_goal("owned gate fixture", None);
    let gate = Arc::new(Mutex::new(()));
    let held_gate = gate.lock().await;
    let (outbound, receiver) = mpsc::channel(1);
    let (started_tx, started_rx) = oneshot::channel();
    let task = {
        let gate = Arc::clone(&gate);
        tokio::spawn(async move {
            let _ = started_tx.send(());
            goal_lifecycle::publish_current_guarded(&engine, &outbound, &gate).await;
        })
    };
    started_rx.await.unwrap();
    drop(receiver);
    let completed = tokio::time::timeout(Duration::from_secs(1), task).await;
    drop(held_gate);
    assert!(
        completed.is_ok(),
        "closed output left the gate waiter alive"
    );
}

#[tokio::test]
async fn interrupt_backpressure_cancels_and_settles_before_outbound_drains() {
    let workspace = tempfile::tempdir().unwrap();
    let engine = runtime_context_test_engine(workspace.path(), None);
    engine.state.set_goal("interrupt fixture", None);
    let followups = Arc::new(BackgroundFollowupState::default());
    followups.goals.lock().unwrap().resume(&engine);
    let (outbound, mut receiver) = mpsc::channel(1);
    outbound.try_send(json!({"occupied": true})).unwrap();
    let turn_state = ResidentTurnState::new(
        outbound.clone(),
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(1)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    turn_state.running.store(true, Ordering::SeqCst);
    let cancel = CancellationToken::new();
    let handle = tokio::spawn(std::future::pending::<()>());
    // An aborted original handle requires a forced completion notification.
    handle.abort();
    let active = ActiveTurn {
        desktop_owner: None,
        input_owner: None,
        handle,
        cancel: cancel.clone(),
        thread_id: engine.session_id(),
        turn_id: "owned-turn".into(),
        attempt: None,
        origin: request_origin::RequestOrigin::Unverified,
    };
    let changed = turn_interrupt::pause_goal_and_cancel(
        &turn_state,
        Some(followups.as_ref()),
        Some(&engine),
        &cancel,
    )
    .await;
    assert!(changed && cancel.is_cancelled());
    assert_eq!(engine.state.goal().unwrap().status, GoalStatus::Paused);
    assert!(followups.goals.lock().unwrap().is_suspended());
    let interruption = turn_interrupt::Interruption {
        active,
        turn_state: turn_state.clone(),
        projection: Arc::new(Mutex::new(BackgroundProjectionState::default())),
        followups,
        engine: None,
        outbound: outbound.clone(),
        server_id: "owned-server".into(),
        sequence: Arc::new(AtomicU64::new(1)),
    };
    let settled = tokio::time::timeout(Duration::from_secs(1), interruption.settle())
        .await
        .expect("outbound backpressure prevented turn settlement");
    assert!(!turn_state.running.load(Ordering::SeqCst));
    assert!(turn_state.activity_gate.try_lock().is_ok());
    assert_eq!(receiver.recv().await.unwrap()["occupied"], true);
    send(
        &outbound,
        success_response(json!(42), json!({"interrupted": true})),
    )
    .await
    .unwrap();
    assert_eq!(receiver.recv().await.unwrap()["id"], 42);
    settled.publish().await.unwrap();
    let terminal = receiver.recv().await.unwrap();
    assert_eq!(terminal["method"], "turn/completed");
    assert_eq!(terminal["params"]["turn"]["status"], "interrupted");
}
