#[tokio::test]
async fn active_turn_only_matches_its_own_interrupt() {
    let active = ActiveTurn {
        desktop_owner: None,
        input_owner: None,
        attempt: None,
        origin: request_origin::RequestOrigin::Unverified,
        handle: tokio::spawn(std::future::pending()),
        cancel: CancellationToken::new(),
        thread_id: "thread-2".into(),
        turn_id: "turn-2".into(),
    };
    assert!(!active.matches(Some("thread-1"), Some("turn-1")));
    assert!(!active.matches(Some("thread-2"), Some("turn-1")));
    assert!(active.matches(Some("thread-2"), Some("turn-2")));
    active.handle.abort();
}

#[tokio::test]
async fn active_attempt_observation_requires_the_exact_live_attempt_and_origin() {
    let (outbound, _receiver) = mpsc::channel(1);
    let state = ResidentTurnState::new(
        outbound,
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(1)),
        Arc::new(StdMutex::new(InteractionReceipts::default())),
    );
    let attempt = kcoder_types::TurnAttemptIdentity {
        thread_id: "thread".into(),
        turn_id: "turn".into(),
        attempt_id: "attempt-a".into(),
    };
    let cancel = CancellationToken::new();
    state.running.store(true, Ordering::SeqCst);
    let _gate = state.activity_gate.lock().await;
    *state.active_turn.lock().await = Some(ActiveTurn {
        desktop_owner: None,
        input_owner: None,
        handle: tokio::spawn(std::future::pending()),
        cancel: cancel.clone(),
        thread_id: attempt.thread_id.clone(),
        turn_id: attempt.turn_id.clone(),
        attempt: Some(attempt.clone()),
        origin: request_origin::RequestOrigin::ClientFrame,
    });
    assert_eq!(
        state.try_matches_active_attempt(
            &attempt,
            Some(request_origin::RequestOrigin::ClientFrame),
        ),
        Some(true)
    );
    let mut retry = attempt.clone();
    retry.attempt_id = "attempt-b".into();
    assert_eq!(state.try_matches_active_attempt(&retry, None), Some(false));
    assert_eq!(
        state
            .try_matches_active_attempt(&attempt, Some(request_origin::RequestOrigin::Automation),),
        Some(false)
    );
    let active = state.active_turn.lock().await;
    assert_eq!(state.try_matches_active_attempt(&attempt, None), None);
    drop(active);
    cancel.cancel();
    assert_eq!(
        state.try_matches_active_attempt(&attempt, None),
        Some(false)
    );
    let active = state.active_turn.lock().await.take().unwrap();
    active.handle.abort();
    let _ = active.handle.await;
}

#[tokio::test]
async fn lagged_reconcile_claims_terminal_followup_exactly_once() {
    let state = BackgroundFollowupState::default();
    let mut task = Task::new("job-lagged", "lagged recovery");
    task.kind = TaskKind::Subagent;
    task.status = TaskStatus::Completed;
    task.output = Some("done".into());

    let mut projection = BackgroundProjectionState::default();
    projection.terminal_jobs.insert(task.id.clone());
    assert!(background_task_is_routable(
        &projection,
        &task.id,
        "tool-call-already-removed"
    ));

    let (recovered_id, summary) = reconciled_background_followup(&task, true).unwrap();
    assert_eq!(recovered_id, task.id);
    assert!(reconciled_background_followup(&task, false).is_none());
    let engine = catalog_list_test_engine(std::path::Path::new("/tmp"));
    engine.state.upsert_task(task.clone());
    queue_recovered_background_followups(
        &engine,
        &state,
        vec![(task.id.clone(), summary.clone())],
        |_| true,
    )
    .await;
    let first = take_ready_background_followup(&state, false, |_| true)
        .await
        .unwrap();
    assert!(first.contains("job-lagged"));

    // Reconciliation and normal broadcast may observe the same terminal event in
    // sequence. Even if the scheduler consumed it first, the same session epoch must
    // never start another automatic aggregation turn.
    queue_recovered_background_followups(&engine, &state, vec![(task.id.clone(), summary)], |_| {
        true
    })
    .await;
    assert!(
        take_ready_background_followup(&state, false, |_| true)
            .await
            .is_none()
    );

    clear_background_followups(&state).await;
    assert!(
        queue_background_followup_once(
            &state,
            task.id,
            None,
            "same id in a new session epoch".into(),
            true,
        )
        .await
    );
}

async fn take_ready_background_followup(
    state: &BackgroundFollowupState,
    has_running: bool,
    should_trigger: impl Fn(&str) -> bool,
) -> Option<String> {
    take_ready_background_followup_batch(state, has_running, None, should_trigger)
        .await
        .map(|(summary, _)| summary)
}
