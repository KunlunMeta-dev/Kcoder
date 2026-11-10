use super::*;
use kcoder_host_transport::protocol_io::success_response;

#[test]
fn file_progress_keeps_scope_sequence_and_tool_identity() {
    use kcoder_types::tool_ui::WorkspaceFileProgress;

    let sequence = AtomicU64::new(9);
    let counts = WorkspaceFileProgress {
        additions: 2,
        files: 1,
        ..WorkspaceFileProgress::default()
    };
    let workspace =
        file_progress_notification("server", "thread", "turn", &sequence, None, counts.clone());
    let tool =
        file_progress_notification("server", "thread", "turn", &sequence, Some("call"), counts);

    assert_eq!(workspace["method"], "item/event");
    assert_eq!(workspace["params"]["serverId"], "server");
    assert_eq!(workspace["params"]["threadId"], "thread");
    assert_eq!(workspace["params"]["turnId"], "turn");
    assert_eq!(workspace["params"]["sequence"], 9);
    assert_eq!(
        workspace["params"]["event"]["type"],
        "workspace_file_progress"
    );
    assert!(workspace["params"]["event"].get("id").is_none());
    assert_eq!(tool["params"]["sequence"], 10);
    assert_eq!(tool["params"]["event"]["type"], "tool_file_progress");
    assert_eq!(tool["params"]["event"]["id"], "call");
    assert_eq!(tool["params"]["event"]["counts"]["additions"], 2);
}

#[tokio::test]
async fn background_projection_retires_late_association_and_preserves_steer_receipt() {
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let (sender, mut receiver) = mpsc::channel(16);
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    register_background_tool_call(&state, "tool", "thread", "turn", projection).await;
    state.lock().await.steer_correlations.insert(
        "message".into(),
        AgentSteerCorrelation {
            agent_id: "job".into(),
            client_message_id: Some("client-message".into()),
        },
    );
    for event in [
        EngineEvent::BackgroundJobStarted {
            id: "job".into(),
            description: "fixture".into(),
        },
        EngineEvent::SubagentSteerApplied {
            agent_id: "job".into(),
            message_id: "message".into(),
            queue_depth: 0,
        },
        EngineEvent::BackgroundJobCompleted {
            id: "job".into(),
            output: kcoder_tools::ToolOutput::text("done"),
        },
        EngineEvent::BackgroundJobCompleted {
            id: "job".into(),
            output: kcoder_tools::ToolOutput::text("duplicate"),
        },
        EngineEvent::BackgroundJobAssociated {
            id: "job".into(),
            tool_call_id: "tool".into(),
            run_in_background: true,
        },
    ] {
        project_engine_background_event(&state, &sender, event)
            .await
            .unwrap();
    }
    let mut messages = Vec::new();
    while let Ok(message) = receiver.try_recv() {
        messages.push(message);
    }
    assert_eq!(
        messages
            .iter()
            .filter(|message| message["params"]["event"]["type"] == "background_job_completed")
            .count(),
        1
    );
    let applied = messages
        .iter()
        .find(|message| message["method"] == method::AGENT_STEER_APPLIED)
        .unwrap();
    assert_eq!(applied["params"]["clientMessageId"], "client-message");
    let state = state.lock().await;
    assert!(state.jobs.is_empty() && state.tool_calls.is_empty() && state.pending.is_empty());
    assert!(state.job_tools.is_empty() && state.associated_jobs.is_empty());
    assert!(state.steer_correlations.is_empty());
    assert!(state.terminal_jobs.contains("job"));
}

#[tokio::test]
async fn deferred_steer_applied_survives_a_run_that_retires_before_the_response() {
    // A steer response gate defers `agent/steer/applied` until the RPC response
    // is on the wire. If the steered run reaches a terminal event inside that
    // window, the projection state retires the job - and the deferred
    // acknowledgement must still be delivered, otherwise the client waits
    // forever for the receipt of a steer the server already accepted.
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let (sender, mut receiver) = mpsc::channel(16);
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    register_background_tool_call(&state, "tool", "thread", "turn", projection).await;
    project_engine_background_event(
        &state,
        &sender,
        EngineEvent::BackgroundJobAssociated {
            id: "job".into(),
            tool_call_id: "tool".into(),
            run_in_background: true,
        },
    )
    .await
    .unwrap();
    while receiver.try_recv().is_ok() {}

    begin_agent_steer_response_gate(&state, "job", Some("client-message".into()))
        .await
        .unwrap();
    project_engine_background_event(
        &state,
        &sender,
        EngineEvent::SubagentSteerApplied {
            agent_id: "job".into(),
            message_id: "message".into(),
            queue_depth: 0,
        },
    )
    .await
    .unwrap();
    project_engine_background_event(
        &state,
        &sender,
        EngineEvent::BackgroundJobCompleted {
            id: "job".into(),
            output: kcoder_tools::ToolOutput::text("done"),
        },
    )
    .await
    .unwrap();
    let mut while_running = Vec::new();
    while let Ok(message) = receiver.try_recv() {
        while_running.push(message);
    }
    assert!(
        !while_running
            .iter()
            .any(|message| message["method"] == method::AGENT_STEER_APPLIED),
        "the applied notification must wait for the steer response"
    );

    finish_agent_steer_response_gate(&state, &sender, "job", Some("message"))
        .await
        .unwrap();

    let mut messages = Vec::new();
    while let Ok(message) = receiver.try_recv() {
        messages.push(message);
    }
    assert!(
        messages
            .iter()
            .any(|message| message["method"] == method::AGENT_STEER_APPLIED),
        "the deferred applied notification must be delivered after the response, got {messages:?}"
    );
    assert!(state.lock().await.steer_response_gates.is_empty());
}

#[test]
fn stream_projection_builds_agent_item_lifecycle() {
    let mut projection = StreamProjection::new(
        "server-1".into(),
        "thread-1".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(1)),
    );
    let started = projection.project(EngineEvent::AssistantMessageStarted);
    let delta = projection.project(EngineEvent::AssistantTextDelta("hello".into()));
    let completed = projection.project(EngineEvent::AssistantMessageDone);
    assert_eq!(started[0]["method"], "item/started");
    assert_eq!(started[0]["params"]["item"]["type"], "agentMessage");
    assert_eq!(delta[0]["method"], "item/delta");
    assert_eq!(delta[0]["params"]["delta"]["text"], "hello");
    assert_eq!(completed[0]["method"], "item/completed");
    assert_eq!(
        started[0]["params"]["item"]["id"],
        delta[0]["params"]["itemId"]
    );
    assert_eq!(started[0]["params"]["serverId"], "server-1");
    assert_eq!(started[0]["params"]["sequence"], 1);
    assert_eq!(delta[0]["params"]["sequence"], 2);
}

#[test]
fn agent_steer_domain_receipt_maps_to_typed_wire_status() {
    let receipt = kcoder_tools::SubagentSteerReceipt {
        agent_id: "agent-1".to_string(),
        message_id: Some("msg-1".to_string()),
        status: kcoder_tools::SubagentSteerStatus::QueuedLive,
        queued: true,
        queue_position: Some(2),
        output_file: None,
        next_action: "wait".to_string(),
        reason_code: None,
        is_error: false,
    };
    let result = agent_steer_result_from_receipt(Some("client-1".to_string()), receipt);
    assert_eq!(result.status, AgentSteerStatus::QueuedLive);
    assert_eq!(result.message_id.as_deref(), Some("msg-1"));
    assert_eq!(result.queue_position, Some(2));
    assert_eq!(result.client_message_id.as_deref(), Some("client-1"));
}

#[tokio::test]
async fn background_projection_forwards_associated_progress_and_completed_once() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server-1".into(),
        "thread-1".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    set_active_background_projection(&state, "thread-1", "turn-1", projection).await;
    let projection = state
        .lock()
        .await
        .active
        .as_ref()
        .unwrap()
        .projection
        .clone();
    register_background_tool_call(&state, "tool-1", "thread-1", "turn-1", projection).await;

    for event in [
        kcoder_engine::BackgroundJobEvent::Associated {
            id: "job-1".into(),
            tool_call_id: "tool-1".into(),
            run_in_background: true,
        },
        kcoder_engine::BackgroundJobEvent::Progress {
            id: "job-1".into(),
            message: "working".into(),
            detail: Some("step one".into()),
            current: Some(1),
            total: Some(2),
        },
        kcoder_engine::BackgroundJobEvent::Completed {
            id: "job-1".into(),
            output: kcoder_tools::ToolOutput::text("done"),
        },
        kcoder_engine::BackgroundJobEvent::Completed {
            id: "job-1".into(),
            output: kcoder_tools::ToolOutput::text("duplicate"),
        },
    ] {
        project_background_broadcast_event(&state, &outbound_tx, event)
            .await
            .unwrap();
    }

    let associated = outbound_rx.recv().await.unwrap();
    let progress = outbound_rx.recv().await.unwrap();
    let completed = outbound_rx.recv().await.unwrap();
    assert_eq!(
        associated["params"]["event"]["type"],
        "background_job_associated"
    );
    assert_eq!(
        progress["params"]["event"]["type"],
        "background_job_progress"
    );
    assert_eq!(
        completed["params"]["event"]["type"],
        "background_job_completed"
    );
    for message in [&associated, &progress, &completed] {
        assert_eq!(message["params"]["threadId"], "thread-1");
        assert_eq!(message["params"]["turnId"], "turn-1");
    }
    assert!(
        outbound_rx.try_recv().is_err(),
        "terminal event must be exactly once"
    );
}

#[tokio::test]
async fn background_projection_maps_steer_applied_to_typed_notification() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(8);
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server-1".into(),
        "thread-1".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    register_background_tool_call(&state, "tool-steer", "thread-1", "turn-1", projection).await;
    project_background_broadcast_event(
        &state,
        &outbound_tx,
        kcoder_engine::BackgroundJobEvent::Associated {
            id: "agent-1".into(),
            tool_call_id: "tool-steer".into(),
            run_in_background: true,
        },
    )
    .await
    .unwrap();
    outbound_rx.recv().await.unwrap();

    project_background_broadcast_event(
        &state,
        &outbound_tx,
        kcoder_engine::BackgroundJobEvent::SubagentSteerApplied {
            id: "agent-1".into(),
            message_id: "msg-1".into(),
            queue_depth: 2,
        },
    )
    .await
    .unwrap();

    let applied = outbound_rx.recv().await.unwrap();
    assert_eq!(applied["method"], method::AGENT_STEER_APPLIED);
    assert_eq!(applied["params"]["threadId"], "thread-1");
    assert_eq!(applied["params"]["agentId"], "agent-1");
    assert_eq!(applied["params"]["messageId"], "msg-1");
    assert_eq!(applied["params"]["queueDepth"], 2);
    assert!(applied["params"].get("message").is_none());
    assert!(!state.lock().await.terminal_jobs.contains("agent-1"));
}

#[tokio::test]
async fn app_steer_gate_orders_response_before_correlated_applied_notification() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server-1".into(),
        "thread-1".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    set_active_background_projection(&state, "thread-1", "turn-1", projection.clone()).await;
    register_background_tool_call(&state, "tool-steer", "thread-1", "turn-1", projection).await;
    project_background_broadcast_event(
        &state,
        &outbound_tx,
        kcoder_engine::BackgroundJobEvent::Associated {
            id: "agent-1".into(),
            tool_call_id: "tool-steer".into(),
            run_in_background: true,
        },
    )
    .await
    .unwrap();
    outbound_rx.recv().await.unwrap();

    begin_agent_steer_response_gate(&state, "agent-1", Some("client-1".to_string()))
        .await
        .unwrap();
    project_engine_background_event(
        &state,
        &outbound_tx,
        EngineEvent::SubagentSteerApplied {
            agent_id: "agent-1".into(),
            message_id: "msg-1".into(),
            queue_depth: 0,
        },
    )
    .await
    .unwrap();
    assert!(outbound_rx.try_recv().is_err());

    outbound_tx
        .send(success_response(json!(44), json!({"queued": true})))
        .await
        .unwrap();
    finish_agent_steer_response_gate(&state, &outbound_tx, "agent-1", Some("msg-1"))
        .await
        .unwrap();

    let response = outbound_rx.recv().await.unwrap();
    let applied = outbound_rx.recv().await.unwrap();
    assert_eq!(response["id"], 44);
    assert_eq!(applied["method"], method::AGENT_STEER_APPLIED);
    assert_eq!(applied["params"]["messageId"], "msg-1");
    assert_eq!(applied["params"]["clientMessageId"], "client-1");
}

#[tokio::test]
async fn pending_projection_evicts_progress_instead_of_dropping_steer_applied() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(1);
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    {
        let mut state = state.lock().await;
        state.pending.insert(
            "agent-1".into(),
            (0..64)
                .map(|index| EngineEvent::BackgroundJobProgress {
                    id: "agent-1".into(),
                    message: format!("progress-{index}"),
                    detail: None,
                    current: None,
                    total: None,
                })
                .collect(),
        );
    }

    project_engine_background_event(
        &state,
        &outbound_tx,
        EngineEvent::SubagentSteerApplied {
            agent_id: "agent-1".into(),
            message_id: "msg-critical".into(),
            queue_depth: 0,
        },
    )
    .await
    .unwrap();

    assert!(outbound_rx.try_recv().is_err());
    let state = state.lock().await;
    let pending = &state.pending["agent-1"];
    assert_eq!(pending.len(), 64);
    assert!(pending.iter().any(|event| {
        matches!(
            event,
            EngineEvent::SubagentSteerApplied { message_id, .. }
                if message_id == "msg-critical"
        )
    }));
}

#[tokio::test]
async fn background_projection_distinguishes_paused_from_terminal_halted() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(16);
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server-1".into(),
        "thread-1".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    set_active_background_projection(&state, "thread-1", "turn-1", projection).await;
    let projection = state
        .lock()
        .await
        .active
        .as_ref()
        .unwrap()
        .projection
        .clone();
    register_background_tool_call(&state, "tool-control", "thread-1", "turn-1", projection).await;
    for event in [
        kcoder_engine::BackgroundJobEvent::Associated {
            id: "job-control".into(),
            tool_call_id: "tool-control".into(),
            run_in_background: true,
        },
        kcoder_engine::BackgroundJobEvent::Paused {
            id: "job-control".into(),
            reason: "operator pause".into(),
        },
        kcoder_engine::BackgroundJobEvent::Halted {
            id: "job-control".into(),
            reason: "operator halt".into(),
        },
        kcoder_engine::BackgroundJobEvent::Halted {
            id: "job-control".into(),
            reason: "duplicate".into(),
        },
    ] {
        project_background_broadcast_event(&state, &outbound_tx, event)
            .await
            .unwrap();
    }

    let associated = outbound_rx.recv().await.unwrap();
    let paused = outbound_rx.recv().await.unwrap();
    let halted = outbound_rx.recv().await.unwrap();
    assert_eq!(
        associated["params"]["event"]["type"],
        "background_job_associated"
    );
    assert_eq!(paused["params"]["event"]["type"], "background_job_paused");
    assert_eq!(halted["params"]["event"]["type"], "background_job_halted");
    assert!(outbound_rx.try_recv().is_err());
    assert!(state.lock().await.terminal_jobs.contains("job-control"));
}

#[tokio::test]
async fn background_projection_rotation_drops_late_events_from_the_previous_thread() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(8);
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let first = Arc::new(Mutex::new(StreamProjection::new(
        "server-1".into(),
        "thread-1".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    set_active_background_projection(&state, "thread-1", "turn-1", first).await;
    let first = state
        .lock()
        .await
        .active
        .as_ref()
        .unwrap()
        .projection
        .clone();
    register_background_tool_call(&state, "old-tool", "thread-1", "turn-1", first).await;
    project_background_broadcast_event(
        &state,
        &outbound_tx,
        kcoder_engine::BackgroundJobEvent::Associated {
            id: "old-job".into(),
            tool_call_id: "old-tool".into(),
            run_in_background: true,
        },
    )
    .await
    .unwrap();
    outbound_rx.recv().await.unwrap();

    rotate_background_projection(&state).await;
    let second = Arc::new(Mutex::new(StreamProjection::new(
        "server-1".into(),
        "thread-2".into(),
        "turn-1".into(),
        Arc::new(AtomicU64::new(2)),
    )));
    set_active_background_projection(&state, "thread-2", "turn-1", second).await;
    project_background_broadcast_event(
        &state,
        &outbound_tx,
        kcoder_engine::BackgroundJobEvent::Completed {
            id: "old-job".into(),
            output: kcoder_tools::ToolOutput::text("late"),
        },
    )
    .await
    .unwrap();
    assert!(outbound_rx.try_recv().is_err());
}

#[tokio::test]
async fn background_followups_wait_for_all_jobs_and_merge_into_one_turn() {
    let state = BackgroundFollowups::default();
    assert!(
        queue_background_followup_once(
            &state,
            "job-1".into(),
            None,
            "job one completed".into(),
            true,
        )
        .await
    );
    assert!(
        take_ready_background_followup(&state, true, |_| true)
            .await
            .is_none()
    );
    assert!(
        queue_background_followup_once(
            &state,
            "job-2".into(),
            None,
            "job two completed".into(),
            true,
        )
        .await
    );
    let summary = take_ready_background_followup(&state, false, |_| true)
        .await
        .unwrap();
    assert!(summary.contains("job one completed"));
    assert!(summary.contains("job two completed"));
    assert!(
        take_ready_background_followup(&state, false, |_| true)
            .await
            .is_none()
    );
    assert!(
        background_followup_nudge(&summary)
            .starts_with("[system] All tracked background work has finished.")
    );
}

#[tokio::test]
async fn take_ready_background_followup_drops_invalidated_entries() {
    let state = BackgroundFollowups::default();
    assert!(
        queue_background_followup_once(
            &state,
            "job-closed".into(),
            None,
            "job closed completed".into(),
            true,
        )
        .await
    );

    // The agent was closed after its entry was queued: validation drops
    // the entry and the helper reports "nothing ready" instead of
    // returning a summary for a closed agent (or leaving the queue
    // half-consumed). The scheduler must treat `None` as "fall through",
    // which is why it no longer `expect()`s a summary.
    assert!(
        take_ready_background_followup(&state, false, |_| false)
            .await
            .is_none()
    );
    // The invalidated entry is gone: a later ready check stays empty even
    // when every id would pass validation.
    assert!(
        take_ready_background_followup(&state, false, |_| true)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn take_ready_background_followup_keeps_live_entries_only() {
    let state = BackgroundFollowups::default();
    assert!(
        queue_background_followup_once(
            &state,
            "job-live".into(),
            None,
            "job live completed".into(),
            true,
        )
        .await
    );
    assert!(
        queue_background_followup_once(
            &state,
            "job-closed".into(),
            None,
            "job closed completed".into(),
            true,
        )
        .await
    );

    // A mixed batch keeps the live entry, drops the closed one, and never
    // mentions the closed agent in the aggregate summary.
    let summary = take_ready_background_followup(&state, false, |id| id == "job-live")
        .await
        .expect("the live entry keeps the queue ready");
    assert!(summary.contains("job live completed"));
    assert!(!summary.contains("job closed completed"));
    // The invalidated entry was consumed with the batch.
    assert!(
        take_ready_background_followup(&state, false, |_| true)
            .await
            .is_none()
    );
}

#[tokio::test]
async fn scoped_background_projection_accepts_next_run_and_rejects_old_terminal() {
    let state = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let (sender, mut receiver) = mpsc::channel(32);
    let projection = Arc::new(Mutex::new(StreamProjection::new(
        "server".into(),
        "thread".into(),
        "turn".into(),
        Arc::new(AtomicU64::new(1)),
    )));
    set_active_background_projection(&state, "thread", "turn", projection.clone()).await;
    let scoped = |run_id: &str, event_id: &str, event: EngineEvent| EngineEvent::BackgroundScoped {
        identity: kcoder_types::BackgroundEventIdentity {
            run: kcoder_types::BackgroundRunKey {
                parent_session_id: "thread".into(),
                agent_id: "job".into(),
                run_id: run_id.into(),
            },
            event_id: event_id.into(),
            run_sequence: 1,
        },
        event: Box::new(event),
    };
    for run in ["one", "two"] {
        if run == "one" {
            register_background_tool_call(&state, "tool", "thread", "turn", projection.clone())
                .await;
        } else {
            clear_active_background_projection(&state, "thread", "turn").await;
        }
        project_engine_background_event(
            &state,
            &sender,
            scoped(
                run,
                "start",
                EngineEvent::BackgroundJobStarted {
                    id: "job".into(),
                    description: "fixture".into(),
                },
            ),
        )
        .await
        .unwrap();
        project_engine_background_event(
            &state,
            &sender,
            scoped(
                run,
                "association",
                EngineEvent::BackgroundJobAssociated {
                    id: "job".into(),
                    tool_call_id: "tool".into(),
                    run_in_background: true,
                },
            ),
        )
        .await
        .unwrap();
        if run == "two" {
            project_engine_background_event(
                &state,
                &sender,
                scoped(
                    "one",
                    "late-terminal",
                    EngineEvent::BackgroundJobCompleted {
                        id: "job".into(),
                        output: kcoder_tools::ToolOutput::text("stale"),
                    },
                ),
            )
            .await
            .unwrap();
            project_engine_background_event(
                &state,
                &sender,
                EngineEvent::BackgroundJobCompleted {
                    id: "job".into(),
                    output: kcoder_tools::ToolOutput::text("legacy stale"),
                },
            )
            .await
            .unwrap();
        }
        project_engine_background_event(
            &state,
            &sender,
            scoped(
                run,
                "terminal",
                EngineEvent::BackgroundJobCompleted {
                    id: "job".into(),
                    output: kcoder_tools::ToolOutput::text("done"),
                },
            ),
        )
        .await
        .unwrap();
    }
    let mut messages = Vec::new();
    while let Ok(message) = receiver.try_recv() {
        messages.push(message);
    }
    assert_eq!(messages.len(), 6);
    let terminal: Vec<_> = messages
        .iter()
        .filter(|m| m["params"]["event"]["type"] == "background_job_completed")
        .collect();
    assert_eq!(terminal.len(), 2);
    assert_eq!(terminal[0]["params"]["identity"]["run"]["runId"], "one");
    assert_eq!(terminal[1]["params"]["identity"]["run"]["runId"], "two");
}
