use super::*;

#[test]
fn lagged_background_watcher_error_emits_notice_and_continues() {
    let event = background_watcher_error_event(tokio::sync::broadcast::error::RecvError::Lagged(3));

    match event {
        Some(AppEvent::SystemNotice(text)) => {
            assert!(text.contains("skipped 3 stale status event"));
        }
        other => panic!("expected lag notice, got {other:?}"),
    }
}

#[test]
fn closed_background_watcher_error_stops_watcher() {
    let event = background_watcher_error_event(tokio::sync::broadcast::error::RecvError::Closed);

    assert!(event.is_none());
}

fn managed_subagent(id: &str, status: TaskStatus) -> kcoder_state::Task {
    let mut task = kcoder_state::Task::new(id, format!("Agent {id}"));
    task.managed = true;
    task.kind = TaskKind::Subagent;
    task.delivery = TaskDelivery::Background;
    task.status = status;
    task.parent_tool_call_id = Some(format!("tool-{id}"));
    task
}

#[test]
fn startup_reconciliation_restores_running_paused_and_halted_panels() {
    let mut running = managed_subagent("running", TaskStatus::Running);
    running.created_at_ms = 1;
    let mut paused = managed_subagent("paused", TaskStatus::Paused);
    paused.created_at_ms = 2;
    let mut halted = managed_subagent("halted", TaskStatus::Halted);
    halted.created_at_ms = 3;

    let events = reconciled_subagent_task_events_from_tasks(vec![halted, running, paused]);

    let associated = events
        .iter()
        .filter(|event| matches!(event, AppEvent::BackgroundJobAssociated { .. }))
        .count();
    assert_eq!(associated, 3);
    assert!(events.iter().any(|event| matches!(
        event,
        AppEvent::BackgroundJobReconciledRunning { id, .. } if id == "running"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        AppEvent::BackgroundJobPaused { id, .. } if id == "paused"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        AppEvent::BackgroundJobHalted { id, .. } if id == "halted"
    )));
}

#[test]
fn startup_reconciliation_ignores_unmanaged_or_unassociated_tasks() {
    let mut unmanaged = managed_subagent("unmanaged", TaskStatus::Running);
    unmanaged.managed = false;
    let mut unassociated = managed_subagent("unassociated", TaskStatus::Paused);
    unassociated.parent_tool_call_id = None;

    let events = reconciled_subagent_task_events_from_tasks(vec![unmanaged, unassociated]);

    assert!(events.is_empty());
}

#[test]
fn live_pause_detail_includes_durable_queue_and_breaker_state() {
    let temp = tempfile::tempdir().unwrap();
    let engine = crate::test_support::test_engine(temp.path());
    let mut task = managed_subagent("paused-live", TaskStatus::Paused);
    task.control.run_mode = kcoder_state::AgentRunMode::Paused;
    task.message_queue
        .push(kcoder_state::QueuedAgentMessage::new("private body"));
    engine.state.upsert_task(task);

    let detail = orchestrate_agent_terminal_control_detail(
        &engine,
        "paused-live",
        "pause requested by parent",
    );

    assert!(detail.contains("queue 1"), "{detail}");
    assert!(detail.contains("breaker healthy"), "{detail}");
    assert!(detail.contains("pause requested by parent"), "{detail}");
    assert!(!detail.contains("private body"), "{detail}");
}

#[tokio::test]
async fn background_progress_does_not_restart_or_replace_the_parent_spinner() {
    let temp = tempfile::tempdir().unwrap();
    let engine = crate::test_support::test_engine(temp.path());
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "agent-progress".to_string(),
        description: "General agent: inspect project".to_string(),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: Some(Instant::now()),
    });
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());

    let idle = handle_app_event(
        AppEvent::BackgroundJobProgress {
            id: "agent-progress".to_string(),
            message: "Writing response".to_string(),
            detail: Some("child output".to_string()),
            current: Some(1),
            total: Some(60),
        },
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert!(idle.redraw);
    assert!(!app.spinner.is_running());
    assert!(app.active_turn.is_none());

    app.start_loading();
    app.spinner.mark_thinking(10);
    let foreground_phase = app.spinner.snapshot().phase;
    handle_app_event(
        AppEvent::BackgroundJobProgress {
            id: "agent-progress".to_string(),
            message: "Running read".to_string(),
            detail: None,
            current: Some(1),
            total: Some(60),
        },
        &mut app,
        &engine,
        &tx,
        &prompt,
    )
    .await;

    assert_eq!(app.spinner.snapshot().phase, foreground_phase);
}

#[tokio::test]
async fn duplicate_background_progress_refreshes_heartbeat_without_redrawing() {
    let temp = tempfile::tempdir().unwrap();
    let engine = crate::test_support::test_engine(temp.path());
    let mut app = ReplApp::default();
    app.record_background_job_hint(BackgroundJobHint {
        id: "agent-duplicate".to_string(),
        description: "General agent: inspect project".to_string(),
        state: BackgroundJobHintState::Running,
        error: None,
        started_at: Some(Instant::now()),
    });
    let (raw_tx, _rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);
    let prompt = TuiPermissionPrompt::new(tx.clone());
    let progress = || AppEvent::BackgroundJobProgress {
        id: "agent-duplicate".to_string(),
        message: "Thinking".to_string(),
        detail: None,
        current: Some(2),
        total: Some(60),
    };

    let first = handle_app_event(progress(), &mut app, &engine, &tx, &prompt).await;
    let second = handle_app_event(progress(), &mut app, &engine, &tx, &prompt).await;

    assert!(first.redraw);
    assert!(!second.redraw);
}
