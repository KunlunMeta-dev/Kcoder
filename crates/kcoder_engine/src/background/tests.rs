use super::*;
use kcoder_state::AppState;
use kcoder_tools::BackgroundJobSpawner;
#[cfg(windows)]
use kcoder_tools::PowerShellTool;
use kcoder_tools::{BashTool, TaskOutputTool, TaskStopTool, Tool, ToolContext, ToolOutput};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_reservation_and_spawn_have_one_admission_winner() {
    let root = tempfile::tempdir().unwrap();
    for _ in 0..32 {
        let (manager, _events) = BackgroundJobManager::new(AppState::new(root.path()));
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let reserve_manager = manager.clone();
        let reserve_barrier = Arc::clone(&barrier);
        let reservation = tokio::spawn(async move {
            reserve_barrier.wait().await;
            reserve_manager.try_reserve_idle()
        });
        let spawn_manager = manager.clone();
        let work = tokio::spawn(async move {
            barrier.wait().await;
            spawn_manager.spawn("race", Box::pin(std::future::pending()))
        });
        let (reservation, work) = tokio::join!(reservation, work);
        let reservation = reservation.unwrap();
        let work = work.unwrap();
        assert_ne!(reservation.is_some(), work.is_ok());
        if reservation.is_some() {
            assert!(matches!(work, Err(SpawnError::AdmissionClosed)));
        }
        drop(reservation);
        manager.abort_all();
    }
}

#[tokio::test]
async fn idle_reservation_blocks_spawn_rolls_back_and_commits() {
    let root = tempfile::tempdir().unwrap();
    let (manager, mut events) = BackgroundJobManager::new(AppState::new(root.path()));
    let reservation = manager.try_reserve_idle().unwrap();
    assert!(manager.clone().try_reserve_idle().is_none());
    assert!(matches!(
        manager.spawn("blocked", Box::pin(async { ToolOutput::text("no") })),
        Err(SpawnError::AdmissionClosed)
    ));
    assert!(manager.state.tasks().is_empty());
    drop(reservation);
    let (finish, wait) = tokio::sync::oneshot::channel();
    manager
        .spawn(
            "active",
            Box::pin(async move {
                let _ = wait.await;
                ToolOutput::text("done")
            }),
        )
        .unwrap();
    assert!(manager.try_reserve_idle().is_none());
    finish.send(()).unwrap();
    while !matches!(
        events.recv().await.unwrap(),
        BackgroundJobEvent::Completed { .. }
    ) {}
    let held = manager.admission.lock().unwrap();
    assert!(manager.try_reserve_idle().is_none());
    drop(held);
    manager.try_reserve_idle().unwrap().commit();
    assert!(matches!(
        manager.spawn("sealed", Box::pin(async { ToolOutput::text("no") })),
        Err(SpawnError::AdmissionClosed)
    ));
}

#[tokio::test]
async fn background_resource_counts_observe_handles_without_waiting() {
    let root = tempfile::tempdir().unwrap();
    let (manager, mut events) = BackgroundJobManager::new(AppState::new(root.path()));
    let (finish, wait) = tokio::sync::oneshot::channel();
    manager
        .spawn(
            "resource fixture",
            Box::pin(async move {
                let _ = wait.await;
                ToolOutput::text("done")
            }),
        )
        .unwrap();
    assert_eq!(manager.try_resource_counts(), Some((1, 0)));
    let held = manager.handles.write().unwrap();
    assert_eq!(manager.try_resource_counts(), None);
    drop(held);
    finish.send(()).unwrap();
    loop {
        if matches!(
            events.recv().await.unwrap(),
            BackgroundJobEvent::Completed { .. }
        ) {
            break;
        }
    }
    assert_eq!(manager.try_resource_counts(), Some((0, 0)));
}

fn output_text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn spawn_runs_work_and_sends_completion() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    let id = manager
        .spawn(
            "test job",
            Box::pin(async move { ToolOutput::text("done") }),
        )
        .expect("spawn succeeds");
    let event = rx.recv().await.expect("started event");
    assert!(matches!(event, BackgroundJobEvent::Started { id: got, .. } if got == id));

    let event = rx.recv().await.expect("completed event");
    match event {
        BackgroundJobEvent::Completed { id: got, output } => {
            assert_eq!(got, id);
            assert_eq!(tool_output_to_text(&output), "done");
        }
        other => panic!("expected Completed, got {:?}", other),
    }
}

#[tokio::test]
async fn running_job_can_publish_bounded_progress() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state);
    let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();

    let id = manager
        .spawn_subagent_with_id_with_cap(
            "agent-progress".to_string(),
            "Explore agent: inspect project",
            Box::pin(async move {
                let _ = finish_rx.await;
                ToolOutput::text("done")
            }),
            None,
        )
        .expect("spawn succeeds");
    assert!(matches!(
        rx.recv().await.expect("started event"),
        BackgroundJobEvent::Started { .. }
    ));

    assert!(manager.report_progress(&id, "Running read", Some(2), Some(60)));
    assert!(matches!(
        rx.recv().await.expect("progress event"),
        BackgroundJobEvent::Progress {
            id: event_id,
            message,
            current: Some(2),
            total: Some(60),
            ..
        } if event_id == id && message == "Running read"
    ));
    let task = manager.state.task(&id).expect("progress task");
    assert_eq!(
        task.current_progress
            .as_ref()
            .map(|progress| progress.message.as_str()),
        Some("Running read")
    );

    let _ = finish_tx.send(());
}

#[tokio::test]
async fn running_subagent_can_publish_steer_applied_without_becoming_terminal() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state);
    let release = Arc::new(tokio::sync::Notify::new());
    let wait_release = Arc::clone(&release);
    let id = manager
        .spawn_subagent_with_id_with_cap(
            "agent-steer-event".to_string(),
            "General agent: wait for steering",
            Box::pin(async move {
                wait_release.notified().await;
                ToolOutput::text("done")
            }),
            None,
        )
        .unwrap();
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));

    assert!(manager.report_subagent_steer_applied(&id, "msg-1", 2));
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::SubagentSteerApplied {
            id: event_id,
            message_id,
            queue_depth: 2,
        } if event_id == id && message_id == "msg-1"
    ));
    assert_eq!(manager.state.task(&id).unwrap().status, TaskStatus::Running);
    release.notify_one();
}

#[tokio::test]
async fn paused_subagent_can_be_cancelled_without_a_live_handle() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let mut task = Task::new("agent-paused-stop", "General agent: paused");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    task.status = TaskStatus::Paused;
    task.parent_session_id = Some(state.session_id());
    state.upsert_task(task);
    state
        .enqueue_subagent_delivery("agent-paused-stop", "queued while paused")
        .unwrap()
        .unwrap();

    assert!(manager.cancel_paused("agent-paused-stop"));
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Cancelled { id, .. } if id == "agent-paused-stop"
    ));
    let task = state.task("agent-paused-stop").unwrap();
    assert_eq!(task.status, TaskStatus::Cancelled);
    assert!(!task.accepting_subagent_messages);
    assert!(task.message_queue.is_empty());
    assert_eq!(task.dead_letter_messages.len(), 1);
}

#[tokio::test]
async fn subagent_association_and_bounded_detail_are_broadcast() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state);
    let release = Arc::new(tokio::sync::Notify::new());
    let wait_release = Arc::clone(&release);
    let id = manager
        .spawn_subagent_foreground_with_id_with_cap(
            "agent-ui",
            "Review agent: inspect UI",
            Box::pin(async move {
                wait_release.notified().await;
                ToolOutput::text("done")
            }),
            None,
        )
        .expect("spawn subagent");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));

    manager
        .associate_subagent_tool_call(&id, "tool-ui", false)
        .expect("associate tool call");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Associated {
            id: got_id,
            tool_call_id,
            run_in_background: false,
        } if got_id == id && tool_call_id == "tool-ui"
    ));
    let associated_task = manager.state.task(&id).expect("associated task");
    assert_eq!(
        associated_task.parent_tool_call_id.as_deref(),
        Some("tool-ui")
    );
    assert_eq!(associated_task.delivery, TaskDelivery::Foreground);

    let oversized = "x".repeat(2_100);
    assert!(manager.report_progress_with_detail(
        &id,
        "Writing response",
        Some(&oversized),
        Some(2),
        Some(60),
    ));
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Progress {
            detail: Some(detail),
            ..
        } if detail.chars().count() == 2_000
    ));
    release.notify_one();
}

#[tokio::test]
async fn worker_committed_cancellation_sends_cancelled_event() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let job_id = "self-cancelled".to_string();
    let state_for_work = state.clone();
    let id_for_work = job_id.clone();

    manager
        .spawn_subagent_with_id_with_cap(
            job_id.clone(),
            "cancelled worker",
            Box::pin(async move {
                state_for_work.update_task(&id_for_work, |task| {
                    task.status = TaskStatus::Cancelled;
                    task.output = Some("cancelled by parent".to_string());
                });
                ToolOutput::error("cancelled by parent")
            }),
            None,
        )
        .unwrap();

    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Cancelled { id, reason }
            if id == job_id && reason == "cancelled by parent"
    ));
    assert_eq!(state.task(&job_id).unwrap().status, TaskStatus::Cancelled);
}

#[tokio::test]
async fn generic_foreground_task_promotes_in_place_and_persists_output() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    state.with_history_path(tmp.path().join("session.jsonl"));
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager.clone());
    let release = Arc::new(tokio::sync::Notify::new());
    let run_release = Arc::clone(&release);

    let id = manager
        .spawn_foreground_with_cap(
            kcoder_tools::background::tool_background_description("bash", "sleep 1"),
            Box::pin(async move {
                run_release.notified().await;
                ToolOutput::text("stdout:\ndone")
            }),
            None,
        )
        .expect("register foreground task");
    assert!(
        matches!(rx.recv().await.unwrap(), BackgroundJobEvent::Started { id: got, .. } if got == id)
    );

    let foreground = state.task(&id).unwrap();
    assert!(foreground.managed);
    assert_eq!(foreground.delivery, TaskDelivery::Foreground);
    assert!(!foreground.notify_parent_on_completion);
    let output_path = foreground.output_path.clone().expect("managed output path");

    manager
        .promote_to_background_delivery(&id)
        .expect("promote same task");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Promoted { id: got } if got == id
    ));
    let promoted = state.task(&id).unwrap();
    assert_eq!(promoted.id, id);
    assert_eq!(promoted.delivery, TaskDelivery::Background);
    assert!(promoted.notify_parent_on_completion);

    let running = TaskOutputTool
        .call(serde_json::json!({"task_id": id, "block": false}), &ctx)
        .await
        .unwrap();
    let running: serde_json::Value = serde_json::from_str(&output_text(&running)).unwrap();
    assert_eq!(running["task"]["task_id"], id);
    assert_eq!(running["task"]["task_type"], "bash");
    assert_eq!(running["task"]["delivery"], "background");
    assert_eq!(running["task"]["status"], "in_progress");

    release.notify_one();
    assert!(
        matches!(rx.recv().await.unwrap(), BackgroundJobEvent::Completed { id: got, .. } if got == id)
    );
    assert_eq!(state.task(&id).unwrap().status, TaskStatus::Completed);
    assert_eq!(
        tokio::fs::read_to_string(output_path).await.unwrap(),
        "stdout:\ndone"
    );

    let completed = TaskOutputTool
        .call(serde_json::json!({"task_id": id, "block": false}), &ctx)
        .await
        .unwrap();
    let completed: serde_json::Value = serde_json::from_str(&output_text(&completed)).unwrap();
    assert_eq!(completed["task"]["status"], "completed");
    assert_eq!(completed["task"]["output"], "stdout:\ndone");
}

#[tokio::test]
async fn task_output_reads_bash_output_while_promoted_process_is_running() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    state.with_history_path(tmp.path().join("session.jsonl"));
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone())
        .with_background_job_manager(manager)
        .with_bash_foreground_budget_ms(20);

    let started = BashTool
        .call(
            serde_json::json!({
                "command": "printf early; sleep 1; printf late",
                "timeout": 2000
            }),
            &ctx,
        )
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_str(&output_text(&started)).unwrap();
    let id = started["task_id"].as_str().unwrap();

    let live = loop {
        let live = TaskOutputTool
            .call(serde_json::json!({"task_id": id, "block": false}), &ctx)
            .await
            .unwrap();
        let live: serde_json::Value = serde_json::from_str(&output_text(&live)).unwrap();
        if live["task"]["output"]
            .as_str()
            .is_some_and(|output| output.contains("early"))
        {
            break live;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(live["task"]["status"], "in_progress");
    assert!(live["task"]["output"].as_str().unwrap().contains("early"));
    assert!(!live["task"]["output"].as_str().unwrap().contains("late"));

    let completed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let completed = TaskOutputTool
                .call(serde_json::json!({"task_id": id, "block": false}), &ctx)
                .await
                .unwrap();
            let completed: serde_json::Value =
                serde_json::from_str(&output_text(&completed)).unwrap();
            if completed["task"]["status"] == "completed" {
                break completed;
            }
        }
    })
    .await
    .expect("promoted shell should complete");
    assert_eq!(completed["task"]["status"], "completed");
    assert!(
        completed["task"]["output"]
            .as_str()
            .unwrap()
            .contains("late")
    );
}

#[tokio::test]
async fn completed_generic_foreground_task_is_evicted_after_inline_delivery() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let id = manager
        .spawn_foreground_with_cap(
            kcoder_tools::background::tool_background_description("ocr", "scan"),
            Box::pin(async move { ToolOutput::text("done inline") }),
            None,
        )
        .expect("register foreground task");
    let output_path = state.task(&id).unwrap().output_path.unwrap();
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Completed { .. }
    ));
    assert!(output_path.exists());

    BackgroundJobSpawner::finish_foreground_delivery(&manager, &id);
    assert!(state.task(&id).is_none());
    assert!(!output_path.exists());
}

#[tokio::test]
async fn spawn_updates_task_in_app_state() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    let id = manager
        .spawn("test job", Box::pin(async move { ToolOutput::text("ok") }))
        .expect("spawn succeeds");
    // Wait for completion.
    let _ = rx.recv().await;
    let _ = rx.recv().await;

    let task = state.task(&id).expect("task exists");
    assert_eq!(task.status, TaskStatus::Completed);
    assert_eq!(task.output.as_deref(), Some("ok"));
}

#[tokio::test]
async fn foreground_subagent_disables_parent_notification_before_start() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    manager
        .spawn_subagent_foreground_with_id_with_cap(
            "agent-foreground",
            "General agent: foreground",
            Box::pin(async { ToolOutput::text("done") }),
            None,
        )
        .expect("spawn foreground subagent");

    let started = rx.recv().await.expect("started event");
    assert!(matches!(started, BackgroundJobEvent::Started { .. }));
    assert!(
        state
            .task("agent-foreground")
            .is_some_and(|task| !task.notify_parent_on_completion)
    );
    let _ = rx.recv().await.expect("completed event");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn immediately_completed_jobs_do_not_leave_stale_handles() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state);
    let jobs = 2_000usize;

    for index in 0..jobs {
        let output = if index % 2 == 0 {
            ToolOutput::text("ok")
        } else {
            ToolOutput::error("failed")
        };
        manager
            .spawn("instant job", Box::pin(async move { output }))
            .expect("spawn succeeds");
    }

    let mut finals = 0usize;
    while finals < jobs {
        if rx.recv().await.expect("background event").is_final() {
            finals += 1;
        }
    }
    tokio::task::yield_now().await;

    assert!(
        crate::recover_read_lock(&manager.handles, "background_job_handles").is_empty(),
        "completed jobs must remove every handle"
    );
}

#[tokio::test]
async fn panicked_subagent_commits_failed_state_and_closes_message_queue() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let id = "agent-panics";

    manager
        .spawn_subagent_with_id_with_cap(
            id,
            "General agent: panic regression",
            Box::pin(async { panic!("deliberate subagent panic") }),
            None,
        )
        .expect("spawn succeeds");

    assert!(matches!(
        rx.recv().await.expect("started event"),
        BackgroundJobEvent::Started { id: got, .. } if got == id
    ));
    let failed = tokio::time::timeout(Duration::from_secs(1), rx.recv())
        .await
        .expect("panic must produce a terminal event")
        .expect("event channel remains open");
    assert!(matches!(
        failed,
        BackgroundJobEvent::Failed { id: got, error }
            if got == id && error.contains("deliberate subagent panic")
    ));

    let task = state.task(id).expect("failed task remains inspectable");
    assert_eq!(task.status, TaskStatus::Failed);
    assert!(!task.accepting_subagent_messages);
    assert!(
        task.output
            .as_deref()
            .is_some_and(|output| output.contains("deliberate subagent panic"))
    );
    assert_eq!(state.enqueue_subagent_message(id, "too late"), None);
    assert!(!manager.is_running(id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_admission_never_exceeds_cap() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state);
    let barrier = Arc::new(tokio::sync::Barrier::new(17));
    let mut attempts = Vec::new();
    for index in 0..16 {
        let manager = manager.clone();
        let barrier = Arc::clone(&barrier);
        attempts.push(tokio::spawn(async move {
            barrier.wait().await;
            manager.spawn_with_cap(
                format!("job {index}"),
                Box::pin(std::future::pending()),
                Some(4),
            )
        }));
    }
    barrier.wait().await;
    let mut admitted = 0;
    for attempt in attempts {
        if attempt.await.unwrap().is_ok() {
            admitted += 1;
        }
    }
    assert_eq!(admitted, 4);
    assert_eq!(manager.count_running(), 4);
    manager.abort_all();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_same_id_admits_exactly_one_job() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state);
    let barrier = Arc::new(tokio::sync::Barrier::new(3));
    let mut attempts = Vec::new();
    for _ in 0..2 {
        let manager = manager.clone();
        let barrier = Arc::clone(&barrier);
        attempts.push(tokio::spawn(async move {
            barrier.wait().await;
            manager.spawn_subagent_with_id_with_cap(
                "same-id",
                "same job",
                Box::pin(std::future::pending()),
                Some(4),
            )
        }));
    }
    barrier.wait().await;
    let mut admitted = 0;
    for attempt in attempts {
        if attempt.await.unwrap().is_ok() {
            admitted += 1;
        }
    }
    assert_eq!(admitted, 1);
    assert_eq!(
        crate::recover_read_lock(&manager.handles, "background_job_handles").len(),
        1
    );
    manager.abort_all();
}

#[tokio::test]
async fn session_generation_suppresses_old_terminal_events() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state);
    manager
        .spawn("old session", Box::pin(std::future::pending()))
        .unwrap();
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    assert_eq!(manager.advance_generation_and_abort_all(), 1);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(matches!(
        rx.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

#[tokio::test]
async fn spawn_subagent_writes_output_file() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    let id = manager
        .spawn_subagent_with_cap(
            "subagent job",
            Box::pin(async move { ToolOutput::text("subagent result") }),
            Some(1),
        )
        .expect("spawn succeeds");
    let _ = rx.recv().await;
    let _ = rx.recv().await;

    let task = state.task(&id).expect("task exists");
    let output_path = task.output_path.expect("subagent output path");
    assert_eq!(
        tokio::fs::read_to_string(&output_path).await.unwrap(),
        "subagent result"
    );
    assert!(output_path.ends_with("output.md"));
}

#[tokio::test]
async fn respawn_subagent_reuses_same_task_id() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    manager
        .spawn_subagent_with_id_with_cap(
            "job-1",
            "General agent: first",
            Box::pin(async move { ToolOutput::text("first result") }),
            Some(1),
        )
        .expect("initial spawn succeeds");
    let _ = rx.recv().await;
    let _ = rx.recv().await;
    assert_eq!(
        state.task("job-1").unwrap().output.as_deref(),
        Some("first result")
    );

    manager
        .respawn_subagent_with_cap(
            "job-1",
            "General agent: continuation",
            Box::pin(async move { ToolOutput::text("second result") }),
            Some(1),
        )
        .expect("respawn succeeds");
    let _ = rx.recv().await;
    let _ = rx.recv().await;

    let task = state.task("job-1").expect("task remains under same id");
    assert_eq!(task.status, TaskStatus::Completed);
    assert_eq!(task.description, "General agent: first");
    assert_eq!(task.output.as_deref(), Some("second result"));
    assert!(task.output_path.unwrap().ends_with("output.md"));
    assert!(task.transcript_path.unwrap().ends_with("transcript.json"));
}

#[tokio::test]
async fn same_id_respawn_stamps_a_fresh_run_start_for_followup_claims() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    manager
        .spawn_subagent_with_id_with_cap(
            "job-run",
            "General agent: first",
            Box::pin(async move { ToolOutput::text("first result") }),
            Some(1),
        )
        .expect("initial spawn succeeds");
    let _ = rx.recv().await;
    let _ = rx.recv().await;
    let first_run_start = state.task("job-run").unwrap().run_started_at_ms;
    assert!(
        first_run_start.is_some(),
        "every spawn must stamp a run start: the app-server follow-up claim key \
         is (id, run_started_at_ms) and a `None` key must never absorb a later run"
    );

    manager
        .respawn_subagent_with_cap(
            "job-run",
            "General agent: continuation",
            Box::pin(async move { ToolOutput::text("second result") }),
            Some(1),
        )
        .expect("respawn succeeds");
    let respawned = state.task("job-run").unwrap();
    let second_run_start = respawned.run_started_at_ms;
    assert!(
        second_run_start.is_some(),
        "a respawned run must stamp a fresh Some(run_started_at_ms) so its \
         completion can wake the parent again"
    );
    assert!(second_run_start >= first_run_start);
    assert_eq!(
        respawned.notification_injected_at_ms, None,
        "a respawned run must become claimable again"
    );
    let _ = rx.recv().await;
    let _ = rx.recv().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terminal_event_allows_immediate_same_id_respawn() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, mut rx) = BackgroundJobManager::new(state);
    let id = "reusable-agent";

    for iteration in 0..200 {
        let output = ToolOutput::text(format!("result-{iteration}"));
        if iteration == 0 {
            manager
                .spawn_subagent_with_id_with_cap(
                    id,
                    "initial",
                    Box::pin(async move { output }),
                    Some(1),
                )
                .expect("initial spawn succeeds");
        } else {
            manager
                .respawn_subagent_with_cap(
                    id,
                    "continuation",
                    Box::pin(async move { output }),
                    Some(1),
                )
                .expect("terminal event must make the ID reusable");
        }
        assert!(matches!(
            rx.recv().await.expect("started event"),
            BackgroundJobEvent::Started { .. }
        ));
        assert!(rx.recv().await.expect("terminal event").is_final());
        assert!(
            crate::recover_read_lock(&manager.handles, "background_job_handles")
                .get(id)
                .is_none()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_id_continuation_never_overtakes_previous_terminal_event() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, mut rx) = BackgroundJobManager::new(state);
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let id = "ordered-agent";

    manager
        .spawn_subagent_with_id_with_cap(
            id,
            "initial",
            Box::pin(async move {
                let _ = release_rx.await;
                ToolOutput::text("first")
            }),
            Some(1),
        )
        .expect("initial spawn succeeds");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));

    let retrying_manager = manager.clone();
    let respawn = tokio::spawn(async move {
        loop {
            match retrying_manager.respawn_subagent_with_cap(
                id,
                "continuation",
                Box::pin(std::future::pending()),
                Some(1),
            ) {
                Ok(_) => break,
                Err(SpawnError::AlreadyRunning { .. })
                | Err(SpawnError::TooManyConcurrent { .. }) => tokio::task::yield_now().await,
                Err(error) => panic!("unexpected respawn error: {error}"),
            }
        }
    });
    release_tx.send(()).unwrap();

    assert!(rx.recv().await.unwrap().is_final());
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    respawn.await.unwrap();
    assert!(manager.abort(id));
}

#[tokio::test]
async fn abort_stops_running_job() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    let id = manager
        .spawn(
            "slow job",
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                ToolOutput::text("should not finish")
            }),
        )
        .expect("spawn succeeds");
    let _ = rx.recv().await; // Started

    assert!(manager.abort(&id));
    let event = rx.recv().await.expect("cancelled event");
    assert!(matches!(event, BackgroundJobEvent::Cancelled { id: got, .. } if got == id));

    let task = state.task(&id).expect("task exists");
    assert_eq!(task.status, TaskStatus::Cancelled);
    assert!(
        crate::recover_read_lock(&manager.cancelled, "background_job_cancelled").is_empty(),
        "aborting a non-cooperative future must not retain a cancellation marker"
    );
}

#[tokio::test]
async fn abort_retains_subagent_delivery_in_dead_letter() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let id = "cancel-with-delivery".to_string();
    manager
        .spawn_subagent_with_id_with_cap(
            id.clone(),
            "sub-agent with pending delivery",
            Box::pin(std::future::pending()),
            Some(1),
        )
        .unwrap();
    let _ = rx.recv().await;
    let receipt = state
        .enqueue_subagent_delivery(&id, "retain after cancellation")
        .unwrap()
        .unwrap();

    assert!(manager.abort(&id));

    let task = state.task(&id).unwrap();
    assert_eq!(task.status, TaskStatus::Cancelled);
    assert!(task.message_queue.is_empty());
    assert_eq!(task.dead_letter_messages.len(), 1);
    assert_eq!(task.dead_letter_messages[0].message_id, receipt.message_id);
    assert_eq!(
        task.dead_letter_messages[0].body,
        "retain after cancellation"
    );
}

#[tokio::test]
async fn abort_stops_live_handle_even_if_session_state_was_replaced() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let id = manager
        .spawn(
            "old-session job",
            Box::pin(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                ToolOutput::text("late")
            }),
        )
        .unwrap();
    let _ = rx.recv().await;
    assert!(state.remove_task(&id));

    assert!(manager.abort(&id));
    assert!(
        crate::recover_read_lock(&manager.handles, "background_job_handles")
            .get(&id)
            .is_none()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn task_stop_kills_bash_process_group_and_keeps_cancelled_status_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone())
        .with_background_job_manager(manager.clone())
        .with_bash_foreground_budget_ms(10);
    let child_pid_path = tmp.path().join("child.pid");
    let command = format!(
        "sh -c 'echo $$ > {}; sleep 60' & wait",
        child_pid_path.display()
    );

    let started = BashTool
        .call(
            serde_json::json!({
                "command": command,
                "timeout": 60_000,
                "run_in_background": true
            }),
            &ctx,
        )
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_str(&output_text(&started)).unwrap();
    let task_id = started["task_id"].as_str().unwrap();

    let child_pid = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(&child_pid_path).await {
                // The file can be observed between creation and the shell
                // flushing its contents; keep polling on empty/partial reads.
                if let Ok(pid) = text.trim().parse::<libc::pid_t>() {
                    break pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child pid file should be written");

    assert_eq!(state.task(task_id).unwrap().status, TaskStatus::Running);
    let stopped = TaskStopTool
        .call(serde_json::json!({"task_id": task_id}), &ctx)
        .await
        .unwrap();
    let stopped: serde_json::Value = serde_json::from_str(&output_text(&stopped)).unwrap();
    assert_eq!(stopped["aborted_background_job"], true);
    assert_eq!(state.task(task_id).unwrap().status, TaskStatus::Cancelled);

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let exists = unsafe { libc::kill(child_pid, 0) == 0 };
            if !exists {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("TaskStop should not leave the shell child process alive");

    let task_output = TaskOutputTool
        .call(
            serde_json::json!({"task_id": task_id, "block": false}),
            &ctx,
        )
        .await
        .unwrap();
    let task_output: serde_json::Value = serde_json::from_str(&output_text(&task_output)).unwrap();
    assert_eq!(task_output["task"]["status"], "cancelled");

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if crate::recover_read_lock(&manager.cancelled, "background_job_cancelled").is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cooperative cancellation marker should be reclaimed");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn task_output_reports_stopped_bash_process_as_failed() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager);

    let started = BashTool
        .call(
            serde_json::json!({
                "command": "kill -STOP 0",
                "timeout": 3000,
                "run_in_background": true
            }),
            &ctx,
        )
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_str(&output_text(&started)).unwrap();
    let task_id = started["task_id"].as_str().unwrap();

    let output = TaskOutputTool
        .call(
            serde_json::json!({
                "task_id": task_id,
                "block": true,
                "timeout": 2000
            }),
            &ctx,
        )
        .await
        .unwrap();
    let output: serde_json::Value = serde_json::from_str(&output_text(&output)).unwrap();

    assert_eq!(output["retrieval_status"], "success");
    assert_eq!(output["task"]["status"], "failed");
    assert!(
        output["task"]["output"]
            .as_str()
            .unwrap()
            .contains("process group stopped")
    );
    assert_eq!(state.task(task_id).unwrap().status, TaskStatus::Failed);
}

#[tokio::test]
async fn task_stop_waits_for_subagent_cancellation_artifacts() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager.clone());
    let cancellation = tokio_util::sync::CancellationToken::new();
    let work_cancellation = cancellation.clone();
    let cancel_cancellation = cancellation.clone();
    let transcript_path = state.subagent_transcript_path("cancel-artifacts");
    let work_transcript_path = transcript_path.clone();

    manager
        .spawn_cancellable_subagent_with_id_with_cap(
            "cancel-artifacts",
            "subagent cancellation artifacts",
            Box::pin(async move {
                work_cancellation.cancelled().await;
                tokio::fs::create_dir_all(work_transcript_path.parent().unwrap())
                    .await
                    .unwrap();
                tokio::fs::write(&work_transcript_path, b"cancelled transcript")
                    .await
                    .unwrap();
                ToolOutput::error("cancelled by user")
            }),
            Arc::new(move || cancel_cancellation.cancel()),
            Some(1),
        )
        .unwrap();

    let stopped = TaskStopTool
        .call(serde_json::json!({"task_id": "cancel-artifacts"}), &ctx)
        .await
        .unwrap();
    let stopped: serde_json::Value = serde_json::from_str(&output_text(&stopped)).unwrap();

    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(
        tokio::fs::read_to_string(&transcript_path).await.unwrap(),
        "cancelled transcript"
    );
    assert_eq!(
        tokio::fs::read_to_string(state.subagent_output_path("cancel-artifacts"))
            .await
            .unwrap(),
        "cancelled by user"
    );
    assert!(!manager.is_running("cancel-artifacts"));
}

#[tokio::test]
async fn task_stop_allows_slow_subagent_checkpoint_to_finish() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager.clone());
    let cancellation = tokio_util::sync::CancellationToken::new();
    let work_cancellation = cancellation.clone();
    let cancel_cancellation = cancellation.clone();
    let transcript_path = state.subagent_transcript_path("slow-cancel-checkpoint");
    let work_transcript_path = transcript_path.clone();

    manager
        .spawn_cancellable_subagent_with_id_with_cap(
            "slow-cancel-checkpoint",
            "slow subagent cancellation checkpoint",
            Box::pin(async move {
                work_cancellation.cancelled().await;
                tokio::time::sleep(Duration::from_millis(750)).await;
                tokio::fs::create_dir_all(work_transcript_path.parent().unwrap())
                    .await
                    .unwrap();
                tokio::fs::write(&work_transcript_path, b"slow cancelled transcript")
                    .await
                    .unwrap();
                ToolOutput::error("cancelled by user")
            }),
            Arc::new(move || cancel_cancellation.cancel()),
            Some(1),
        )
        .unwrap();

    let stopped = TaskStopTool
        .call(
            serde_json::json!({"task_id": "slow-cancel-checkpoint"}),
            &ctx,
        )
        .await
        .unwrap();
    let stopped: serde_json::Value = serde_json::from_str(&output_text(&stopped)).unwrap();

    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(
        tokio::fs::read_to_string(&transcript_path).await.unwrap(),
        "slow cancelled transcript"
    );
    assert_eq!(
        tokio::fs::read_to_string(state.subagent_output_path("slow-cancel-checkpoint"))
            .await
            .unwrap(),
        "cancelled by user"
    );
}

#[tokio::test]
async fn cancelling_subagent_keeps_capacity_until_cleanup_finishes() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let cancellation = tokio_util::sync::CancellationToken::new();
    let work_cancellation = cancellation.clone();
    let cancel_cancellation = cancellation.clone();
    let cleanup_started = Arc::new(tokio::sync::Notify::new());
    let work_cleanup_started = cleanup_started.clone();
    let finish_cleanup = Arc::new(tokio::sync::Notify::new());
    let work_finish_cleanup = finish_cleanup.clone();
    let work_state = state.clone();

    manager
        .spawn_cancellable_subagent_with_id_with_cap(
            "cancelling-capacity",
            "cancelling subagent",
            Box::pin(async move {
                work_cancellation.cancelled().await;
                // The agent loop can observe cancellation before its
                // transcript/output cleanup has completed.
                work_state.update_task("cancelling-capacity", |task| {
                    task.status = TaskStatus::Cancelled;
                });
                work_cleanup_started.notify_one();
                work_finish_cleanup.notified().await;
                ToolOutput::error("cancelled by user")
            }),
            Arc::new(move || cancel_cancellation.cancel()),
            Some(1),
        )
        .unwrap();

    let abort_manager = manager.clone();
    let abort =
        tokio::spawn(async move { abort_manager.abort_and_wait("cancelling-capacity").await });
    cleanup_started.notified().await;

    let spawn = manager.spawn_subagent_with_id_with_cap(
        "replacement".to_string(),
        "replacement subagent",
        Box::pin(async { ToolOutput::text("replacement") }),
        Some(1),
    );
    assert!(matches!(
        spawn,
        Err(SpawnError::TooManyConcurrent {
            running: 1,
            limit: 1
        })
    ));

    finish_cleanup.notify_one();
    assert!(abort.await.unwrap());
    assert!(
        manager
            .spawn_subagent_with_id_with_cap(
                "replacement".to_string(),
                "replacement subagent",
                Box::pin(async { ToolOutput::text("replacement") }),
                Some(1),
            )
            .is_ok()
    );
}

#[cfg(windows)]
#[tokio::test]
async fn task_stop_kills_bash_process_tree_and_keeps_cancelled_status_readable() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone())
        .with_background_job_manager(manager.clone())
        .with_bash_foreground_budget_ms(10);
    let child_pid_path = tmp.path().join("child.pid");
    let escaped_pid_path = child_pid_path.display().to_string().replace("'", "''");
    let command = format!(
        "powershell.exe -NoLogo -NoProfile -Command '$PID | Set-Content -LiteralPath \"{escaped_pid_path}\"; Start-Sleep -Seconds 60' & wait"
    );

    let started = BashTool
        .call(
            serde_json::json!({
                "command": command,
                "timeout": 60_000,
                "run_in_background": true
            }),
            &ctx,
        )
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_str(&output_text(&started)).unwrap();
    let task_id = started["task_id"].as_str().unwrap();

    let child_pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(&child_pid_path).await
                && let Ok(pid) = text.trim().parse::<u32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("native PowerShell child pid file should be written");

    assert_eq!(state.task(task_id).unwrap().status, TaskStatus::Running);
    let stopped = TaskStopTool
        .call(serde_json::json!({"task_id": task_id}), &ctx)
        .await
        .unwrap();
    let stopped: serde_json::Value = serde_json::from_str(&output_text(&stopped)).unwrap();
    assert_eq!(stopped["aborted_background_job"], true);
    assert_eq!(state.task(task_id).unwrap().status, TaskStatus::Cancelled);

    tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let probe = std::process::Command::new("powershell.exe")
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        &format!(
                            "if (Get-Process -Id {child_pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
                        ),
                    ])
                    .status()
                    .unwrap();
                if !probe.success() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("TaskStop should not leave the native PowerShell child process alive");

    let task_output = TaskOutputTool
        .call(
            serde_json::json!({"task_id": task_id, "block": false}),
            &ctx,
        )
        .await
        .unwrap();
    let task_output: serde_json::Value = serde_json::from_str(&output_text(&task_output)).unwrap();
    assert_eq!(task_output["task"]["status"], "cancelled");
}

#[cfg(windows)]
#[tokio::test]
async fn task_stop_kills_native_powershell_process_tree() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager);
    let child_pid_path = tmp.path().join("powershell-child.pid");
    let escaped_pid_path = child_pid_path.display().to_string().replace("'", "''");
    let command = format!(
        "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; $child.Id | Set-Content -LiteralPath '{escaped_pid_path}'; Start-Sleep -Seconds 60"
    );

    let started = PowerShellTool
        .call(
            serde_json::json!({
                "command": command,
                "timeout": 60_000,
                "run_in_background": true
            }),
            &ctx,
        )
        .await
        .unwrap();
    let started: serde_json::Value = serde_json::from_str(&output_text(&started)).unwrap();
    let task_id = started["task_id"].as_str().unwrap();
    let child_pid = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(&child_pid_path).await
                && let Ok(pid) = text.trim().parse::<u32>()
            {
                break pid;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("PowerShell child pid file should be written");

    let stopped = TaskStopTool
        .call(serde_json::json!({"task_id": task_id}), &ctx)
        .await
        .unwrap();
    let stopped: serde_json::Value = serde_json::from_str(&output_text(&stopped)).unwrap();
    assert_eq!(stopped["aborted_background_job"], true);

    tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let probe = std::process::Command::new("powershell.exe")
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        &format!(
                            "if (Get-Process -Id {child_pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
                        ),
                    ])
                    .status()
                    .unwrap();
                if !probe.success() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("TaskStop should not leave the native PowerShell child process alive");
}

#[tokio::test]
async fn cancel_for_goal_stop_removes_task_without_failed_event() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());

    let id = manager
        .spawn_subagent_with_cap(
            "slow subagent",
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                ToolOutput::text("should not finish")
            }),
            Some(1),
        )
        .expect("spawn succeeds");
    let _ = rx.recv().await; // Started

    assert!(manager.cancel_for_goal_stop(&id, "goal budget reached"));
    let event = rx.recv().await.expect("completion-style event");
    assert!(matches!(event, BackgroundJobEvent::Completed { id: got, .. } if got == id));
    assert!(state.task(&id).is_none());
}

#[tokio::test]
async fn spawn_with_cap_rejects_when_limit_hit() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());

    // The first spawn must succeed.
    let _first = manager
        .spawn_with_cap(
            "first",
            Box::pin(async move {
                // Long enough to still be in `Running` while we try
                // the second spawn.
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                ToolOutput::text("first done")
            }),
            Some(1),
        )
        .expect("first spawn fits under the cap");

    // The second one is over the cap and must be refused.
    let second = manager
        .spawn_with_cap(
            "second",
            Box::pin(async move { ToolOutput::text("second done") }),
            Some(1),
        )
        .expect_err("second spawn must be refused");
    match second {
        SpawnError::TooManyConcurrent { running, limit } => {
            assert_eq!(running, 1);
            assert_eq!(limit, 1);
        }
        other => panic!("expected TooManyConcurrent, got {other:?}"),
    }
}

#[tokio::test]
async fn subagent_cap_ignores_generic_background_jobs() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());

    let _generic = manager
        .spawn_with_cap(
            "generic background job",
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                ToolOutput::text("generic done")
            }),
            Some(1),
        )
        .expect("generic job fits under its own cap");

    let subagent = manager
        .spawn_subagent_with_cap(
            "subagent job",
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                ToolOutput::text("subagent done")
            }),
            Some(1),
        )
        .expect("generic background jobs must not consume sub-agent slots");

    let task = state.task(&subagent).expect("subagent task exists");
    assert_eq!(task.kind, TaskKind::Subagent);
}

#[tokio::test]
async fn spawn_subagent_with_cap_rejects_when_subagent_limit_hit() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());

    let _first = manager
        .spawn_subagent_with_cap(
            "first subagent",
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                ToolOutput::text("first done")
            }),
            Some(1),
        )
        .expect("first subagent fits under the cap");

    let second = manager
        .spawn_subagent_with_cap(
            "second subagent",
            Box::pin(async move { ToolOutput::text("second done") }),
            Some(1),
        )
        .expect_err("second subagent must be refused");

    match second {
        SpawnError::TooManyConcurrent { running, limit } => {
            assert_eq!(running, 1);
            assert_eq!(limit, 1);
        }
        other => panic!("expected TooManyConcurrent, got {other:?}"),
    }
}

#[tokio::test]
async fn spawn_subagent_with_unbounded_cap_still_uses_hard_limit() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());

    for i in 0..MAX_CONCURRENT_SUBAGENTS {
        manager
            .spawn_subagent_with_cap(
                format!("subagent-{i}"),
                Box::pin(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    ToolOutput::text("done")
                }),
                None,
            )
            .expect("subagent fits under hard limit");
    }

    let extra = manager
        .spawn_subagent_with_cap(
            "extra subagent",
            Box::pin(async move { ToolOutput::text("extra done") }),
            Some(0),
        )
        .expect_err("None/0 must not disable the sub-agent hard limit");

    match extra {
        SpawnError::TooManyConcurrent { running, limit } => {
            assert_eq!(running, MAX_CONCURRENT_SUBAGENTS);
            assert_eq!(limit, MAX_CONCURRENT_SUBAGENTS);
        }
        other => panic!("expected TooManyConcurrent, got {other:?}"),
    }
}

#[tokio::test]
async fn spawn_with_cap_zero_disables_check() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());

    for i in 0..5 {
        let r = manager.spawn_with_cap(
            format!("job-{i}"),
            Box::pin(async move { ToolOutput::text("ok") }),
            Some(0),
        );
        assert!(r.is_ok(), "cap=0 should disable the check (job {i})");
    }
}

#[tokio::test]
async fn aborting_workflow_runs_cancellation_hook_before_marking_task_cancelled() {
    let state = AppState::new("/tmp");
    let (manager, _rx) = BackgroundJobManager::new(state.clone());
    let hook_called = Arc::new(AtomicBool::new(false));
    let hook_flag = Arc::clone(&hook_called);

    manager
        .spawn_workflow_cancellable_with_id(
            "workflow-cancel-test".to_string(),
            "Workflow: cancellation test".to_string(),
            Box::pin(async move {
                std::future::pending::<()>().await;
                ToolOutput::text("unreachable")
            }),
            Arc::new(move || hook_flag.store(true, Ordering::SeqCst)),
            None,
        )
        .expect("spawn workflow");

    assert!(manager.abort("workflow-cancel-test"));
    assert!(hook_called.load(Ordering::SeqCst));
    assert_eq!(
        state.task("workflow-cancel-test").unwrap().status,
        TaskStatus::Cancelled
    );
}

#[tokio::test]
async fn foreground_subagent_can_be_promoted_without_restart() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let release = Arc::new(tokio::sync::Notify::new());
    let run_release = Arc::clone(&release);
    let id = "job-promote-running";

    manager
        .spawn_subagent_foreground_with_id_with_cap(
            id,
            "Review agent: inspect parser",
            Box::pin(async move {
                run_release.notified().await;
                ToolOutput::text("review complete")
            }),
            None,
        )
        .expect("spawn foreground subagent");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    assert!(!state.task(id).unwrap().notify_parent_on_completion);

    manager
        .promote_to_background_delivery(id)
        .expect("promote running subagent");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Promoted { id: got } if got == id
    ));
    assert!(state.task(id).unwrap().notify_parent_on_completion);
    release.notify_one();

    let event = rx.recv().await.unwrap();
    assert!(matches!(event, BackgroundJobEvent::Completed { id: got, .. } if got == id));
    assert_eq!(state.task(id).unwrap().status, TaskStatus::Completed);
}

#[tokio::test]
async fn promotion_republishes_completion_that_won_timeout_race() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let id = "job-promote-completed";

    manager
        .spawn_subagent_foreground_with_id_with_cap(
            id,
            "Review agent: fast result",
            Box::pin(async move { ToolOutput::text("already complete") }),
            None,
        )
        .expect("spawn foreground subagent");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Completed { .. }
    ));
    state.mark_task_notification_injected(id);

    manager
        .promote_to_background_delivery(id)
        .expect("promote completed subagent");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Promoted { id: got } if got == id
    ));

    let task = state.task(id).unwrap();
    assert!(task.notify_parent_on_completion);
    assert!(task.notification_injected_at_ms.is_none());
    assert!(
        matches!(rx.recv().await.unwrap(), BackgroundJobEvent::Completed { id: got, .. } if got == id)
    );
}

#[tokio::test]
async fn promoted_subagent_is_readable_and_stoppable_through_task_tools() {
    let state = AppState::new("/tmp");
    let (manager, mut rx) = BackgroundJobManager::new(state.clone());
    let manager = Arc::new(manager);
    let ctx = ToolContext::new(state.clone()).with_background_job_manager(manager.clone());
    let id = "job-promote-task-tools";

    manager
        .spawn_subagent_foreground_with_id_with_cap(
            id,
            "Verifier agent: wait for cancellation",
            Box::pin(async move {
                std::future::pending::<()>().await;
                ToolOutput::text("unreachable")
            }),
            None,
        )
        .expect("spawn foreground subagent");
    assert!(matches!(
        rx.recv().await.unwrap(),
        BackgroundJobEvent::Started { .. }
    ));
    manager
        .promote_to_background_delivery(id)
        .expect("promote subagent");

    let status = TaskOutputTool
        .call(serde_json::json!({"task_id": id, "block": false}), &ctx)
        .await
        .expect("read promoted subagent status");
    let status: serde_json::Value = serde_json::from_str(&output_text(&status)).unwrap();
    assert_eq!(status["task"]["task_id"], id);
    assert_eq!(status["task"]["task_type"], "subagent");
    assert_eq!(status["task"]["status"], "in_progress");

    let stopped = TaskStopTool
        .call(serde_json::json!({"task_id": id}), &ctx)
        .await
        .expect("stop promoted subagent");
    let stopped: serde_json::Value = serde_json::from_str(&output_text(&stopped)).unwrap();
    assert_eq!(stopped["task_id"], id);
    assert_eq!(stopped["task_type"], "subagent");
    assert_eq!(stopped["aborted_background_job"], true);
    assert_eq!(stopped["output"], "cancelled by user");
    assert_eq!(state.task(id).unwrap().status, TaskStatus::Cancelled);
    assert_eq!(
        state.task(id).unwrap().output.as_deref(),
        Some("cancelled by user")
    );
}
