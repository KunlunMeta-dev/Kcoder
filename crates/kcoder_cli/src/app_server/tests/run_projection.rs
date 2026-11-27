// Authoritative run projection (S1/S4).
//
// The resident runtime is the single fact source: a running turn, pending
// approvals/questions, background jobs, persisted tasks and pending delivery.
// Every assertion here is about what the server reports, never about what a
// client could infer from tool text or socket traffic.

use super::thread_runtime::test_support::test_runtime;

fn legacy_snapshot() -> Value {
    json!({
        "id": "thread-1",
        "status": "running",
        "createdAt": "1",
        "updatedAt": "1"
    })
}

fn runtime_manager(history: &std::path::Path) -> (thread_runtime::ThreadManager, String) {
    let mut manager = thread_runtime::ThreadManager::default();
    let runtime = test_runtime("run-projection", history);
    let thread_id = runtime.engine().session_id();
    assert!(matches!(manager.insert(runtime), Ok(None)));
    (manager, thread_id)
}

#[tokio::test]
async fn run_facts_report_pending_approval_as_the_actionable_state() {
    let root = tempfile::tempdir().unwrap();
    let (manager, thread_id) = runtime_manager(&root.path().join("history.jsonl"));

    let idle = manager
        .thread_run_facts(&thread_id)
        .expect("resident facts");
    assert_eq!(idle.state(), kcoder_app_protocol::ThreadStatus::Idle);
    assert_eq!(
        idle.summary().main_turn,
        kcoder_app_protocol::ThreadMainTurn::Idle
    );

    let turn_state = manager.turn_state(&thread_id).expect("resident turn state");
    let (sender, _receiver) = oneshot::channel();
    turn_state
        .pending_approvals
        .lock()
        .unwrap()
        .insert(1, sender);

    let waiting = manager
        .thread_run_facts(&thread_id)
        .expect("resident facts");
    assert_eq!(
        waiting.state(),
        kcoder_app_protocol::ThreadStatus::WaitingForApproval
    );
    assert_eq!(waiting.pending_approvals, Some(1));

    let mut snapshot = legacy_snapshot();
    ThreadRunProjection::for_thread(&manager, true, &thread_id).apply(&mut snapshot);
    assert_eq!(snapshot["status"], "waiting_for_approval");
    assert_eq!(snapshot["runSummary"]["pendingApprovals"], 1);
    assert_eq!(snapshot["runSummary"]["mainTurn"], "idle");
}

#[tokio::test]
async fn run_facts_keep_background_work_visible_after_the_main_turn_ends() {
    let root = tempfile::tempdir().unwrap();
    let history = root.path().join("history.jsonl");
    let (manager, thread_id) = runtime_manager(&history);

    let mut task = kcoder_state::Task::new("background-agent", "fixture");
    task.kind = kcoder_state::TaskKind::Subagent;
    task.status = kcoder_state::TaskStatus::Running;
    manager
        .engine(&thread_id)
        .expect("resident engine")
        .state
        .upsert_task(task);

    let facts = manager
        .thread_run_facts(&thread_id)
        .expect("resident facts");
    assert_eq!(facts.main_turn_running, Some(false));
    assert_eq!(facts.tasks_running, Some(1));
    assert_eq!(facts.state(), kcoder_app_protocol::ThreadStatus::Background);

    let mut snapshot = legacy_snapshot();
    ThreadRunProjection::for_thread(&manager, true, &thread_id).apply(&mut snapshot);
    assert_eq!(snapshot["status"], "background");
    assert_eq!(snapshot["runSummary"]["tasksRunning"], 1);
    assert_eq!(snapshot["runSummary"]["activeJobs"], 0);
}

#[tokio::test]
async fn run_facts_stay_absent_for_threads_without_a_runtime_here() {
    let root = tempfile::tempdir().unwrap();
    let (manager, thread_id) = runtime_manager(&root.path().join("history.jsonl"));

    assert!(manager.thread_run_facts("thread-absent").is_none());

    // A thread this connection cannot observe keeps the legacy projection: the
    // server must not invent an idle state for it.
    let mut snapshot = legacy_snapshot();
    ThreadRunProjection::for_thread(&manager, true, "thread-absent").apply(&mut snapshot);
    assert_eq!(snapshot["status"], "running");
    assert!(snapshot.get("runSummary").is_none());

    // The negotiated capability is still reported by the server.
    assert!(
        server_capabilities(true)
            .experimental
            .get(kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1)
            .copied()
            .unwrap_or(false)
    );

    let _ = thread_id;
}

#[test]
fn server_advertises_the_capabilities_clients_gate_recovery_on() {
    // A client may only send `retryFromTurnId`, `retryOperationId` or a bound
    // interaction reply after the server says it understands them; an unadvertised
    // capability would make the client either guess or silently re-send work.
    let capabilities = server_capabilities(true).experimental;
    for capability in [
        kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1,
        kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1,
        kcoder_app_protocol::CAPABILITY_TURN_SUBMISSION_V1,
        kcoder_app_protocol::CAPABILITY_TURN_RETRY_OPERATION_V1,
        kcoder_app_protocol::CAPABILITY_FAILED_TURN_CONTINUATION_V1,
    ] {
        assert!(
            capabilities.get(capability).copied().unwrap_or(false),
            "{capability} must be advertised before clients gate their fields on it"
        );
    }
}

#[test]
fn run_projection_requires_both_negotiation_and_authoritative_facts() {
    let facts = kcoder_app_protocol::ThreadRunFacts {
        main_turn_running: Some(true),
        ..Default::default()
    };

    let mut without_negotiation = legacy_snapshot();
    ThreadRunProjection {
        negotiated: false,
        facts: Some(facts),
    }
    .apply(&mut without_negotiation);
    assert_eq!(without_negotiation["status"], "running");
    assert!(without_negotiation.get("runSummary").is_none());

    let mut without_facts = legacy_snapshot();
    ThreadRunProjection {
        negotiated: true,
        facts: None,
    }
    .apply(&mut without_facts);
    assert_eq!(without_facts["status"], "running");
    assert!(without_facts.get("runSummary").is_none());

    let mut negotiated = legacy_snapshot();
    ThreadRunProjection {
        negotiated: true,
        facts: Some(facts),
    }
    .apply(&mut negotiated);
    assert_eq!(negotiated["status"], "running");
    assert_eq!(negotiated["runSummary"]["mainTurn"], "running");

    // Unreadable facts must never be published as a confident idle.
    let mut unknown = legacy_snapshot();
    ThreadRunProjection {
        negotiated: true,
        facts: Some(kcoder_app_protocol::ThreadRunFacts::default()),
    }
    .apply(&mut unknown);
    assert_eq!(unknown["status"], "unknown");
    assert_eq!(unknown["runSummary"]["mainTurn"], "unknown");
    assert_eq!(unknown["runSummary"]["pendingApprovals"], Value::Null);
}
