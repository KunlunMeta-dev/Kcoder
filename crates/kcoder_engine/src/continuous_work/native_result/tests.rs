use super::*;
use kcoder_state::Task;
use kcoder_tools::workflow_runs::{RunObservation, observe_read};
use kcoder_types::{Message, workflow_runs::WorkflowRunSnapshot};

fn fixture(kind: TaskKind) -> (tempfile::TempDir, AppState, BackgroundRunKey) {
    let directory = tempfile::tempdir().unwrap();
    let state = AppState::new(directory.path());
    state.with_history_path(
        directory
            .path()
            .join(format!("{}.jsonl", state.session_id())),
    );
    let mut task = Task::new("owned-job", "native fixture");
    task.kind = kind;
    task.managed = true;
    let run = state.start_background_task_run(task).unwrap();
    (directory, state, run)
}

fn attempt(run: &BackgroundRunKey) -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: run.parent_session_id.clone(),
        turn_id: "turn-1".into(),
        attempt_id: "attempt-1".into(),
    }
}

#[test]
fn real_outboxes_preserve_each_kind_and_distinct_terminal_outcomes() {
    for kind in [TaskKind::Generic, TaskKind::Subagent, TaskKind::Workflow] {
        for (status, outcome) in [
            (TaskStatus::Completed, NativeTerminalOutcome::Completed),
            (TaskStatus::Failed, NativeTerminalOutcome::Failed),
            (TaskStatus::Cancelled, NativeTerminalOutcome::Cancelled),
            (TaskStatus::Halted, NativeTerminalOutcome::Halted),
        ] {
            let (_directory, state, run) = fixture(kind);
            let event = BackgroundEventIdentity::terminal(run.clone());
            state
                .commit_background_terminal(&event, status, None)
                .unwrap();
            let observed = observe_run(&state, &run, Some(&attempt(&run)), Some(&event)).unwrap();
            assert_eq!(observed.recorded_current_task_kind, Some(kind));
            assert_eq!(
                observed.state,
                NativeRunState::RecordedTerminal { event, outcome }
            );
            assert_eq!(
                observed.parent_attempt,
                ParentAttemptObservation::Unverified(attempt(&run))
            );
            assert_eq!(
                observed.delivery,
                NativeDeliveryObservation::NoReceiptObserved
            );
        }
    }
}

#[test]
fn active_pause_and_uncommitted_completion_are_not_terminal_receipts() {
    let (_directory, state, run) = fixture(TaskKind::Subagent);
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().state,
        NativeRunState::RecordedRunning
    );
    state.update_task(&run.agent_id, |task| task.status = TaskStatus::Paused);
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().state,
        NativeRunState::RecordedPaused
    );
    // A task snapshot can become terminal before its run outbox commit.
    state.update_task(&run.agent_id, |task| task.status = TaskStatus::Completed);
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().state,
        NativeRunState::Unknown(NativeUnknownReason::TerminalReceiptMissing)
    );
}

#[test]
fn pending_unknown_and_disagreeing_snapshots_are_not_reported_as_running() {
    let (_directory, state, run) = fixture(TaskKind::Generic);
    state.update_task(&run.agent_id, |task| {
        task.status = TaskStatus::Pending;
        task.background_runs
            .iter_mut()
            .find(|record| record.key == run)
            .unwrap()
            .status = TaskStatus::Pending;
    });
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().state,
        NativeRunState::RecordedPending
    );
    state.update_task(&run.agent_id, |task| task.status = TaskStatus::Running);
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().state,
        NativeRunState::Unknown(NativeUnknownReason::InconsistentCurrentStatus)
    );
    state.update_task(&run.agent_id, |task| {
        task.status = TaskStatus::Unknown("future_wait".into());
    });
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().state,
        NativeRunState::Unknown(NativeUnknownReason::FutureStatus("future_wait".into()))
    );
}

#[test]
fn a_history_receipt_without_a_terminal_receipt_is_not_trusted() {
    let (_directory, state, run) = fixture(TaskKind::Generic);
    state.update_task(&run.agent_id, |task| {
        task.background_runs
            .iter_mut()
            .find(|record| record.key == run)
            .unwrap()
            .delivered_message_id = Some("orphan-receipt".into());
    });
    assert_eq!(
        observe_run(&state, &run, None, None).unwrap().delivery,
        NativeDeliveryObservation::Unknown
    );
}

#[tokio::test]
async fn history_delivery_is_observed_only_after_the_real_receipt_is_committed() {
    let (_directory, state, run) = fixture(TaskKind::Subagent);
    let event = BackgroundEventIdentity::terminal(run.clone());
    state
        .commit_background_terminal(&event, TaskStatus::Completed, None)
        .unwrap();
    state
        .reserve_background_result_delivery(std::slice::from_ref(&run), "message-1")
        .unwrap();
    assert_eq!(
        observe_run(&state, &run, None, Some(&event))
            .unwrap()
            .delivery,
        NativeDeliveryObservation::PendingReconciliation
    );
    state
        .commit_message_with_uuid(Message::user_text("fixture result"), "message-1")
        .await
        .unwrap();
    state
        .confirm_background_result_delivery(&run, "message-1")
        .unwrap();
    assert_eq!(
        observe_run(&state, &run, None, Some(&event))
            .unwrap()
            .delivery,
        NativeDeliveryObservation::HistoryReceipt {
            message_id: "message-1".into()
        }
    );
}

#[test]
fn old_run_remains_distinct_from_the_new_run_even_if_output_path_is_reused() {
    let (directory, state, first) = fixture(TaskKind::Generic);
    let path = directory.path().join("reused-output.txt");
    std::fs::write(&path, "old output").unwrap();
    let old_event = BackgroundEventIdentity::terminal(first.clone());
    state
        .commit_background_terminal(&old_event, TaskStatus::Failed, Some(path.clone()))
        .unwrap();
    let previous_task = state.task(&first.agent_id).unwrap();
    let next = state.start_background_task_run(previous_task).unwrap();
    std::fs::write(&path, "new output").unwrap();
    let old = observe_run(&state, &first, None, Some(&old_event)).unwrap();
    assert!(!old.current_run);
    assert_eq!(old.recorded_current_task_kind, None);
    assert_eq!(old.parent_attempt, ParentAttemptObservation::Missing);
    assert_eq!(old.output, NativeOutputObservation::NotRead);
    assert_eq!(
        old.state,
        NativeRunState::RecordedTerminal {
            event: old_event,
            outcome: NativeTerminalOutcome::Failed,
        }
    );
    assert_eq!(
        observe_run(&state, &next, None, None).unwrap().state,
        NativeRunState::RecordedRunning
    );
}

#[test]
fn wrong_parent_and_wrong_terminal_event_never_borrow_another_run() {
    let (_directory, state, run) = fixture(TaskKind::Subagent);
    let mut foreign = run.clone();
    foreign.parent_session_id.push_str("-other");
    assert_eq!(
        observe_run(&state, &foreign, None, None),
        Err(NativeObservationError::WrongParent)
    );
    let mut wrong_attempt = attempt(&run);
    wrong_attempt.thread_id.push_str("-other");
    assert_eq!(
        observe_run(&state, &run, Some(&wrong_attempt), None),
        Err(NativeObservationError::WrongParent)
    );
    let mut wrong_event = BackgroundEventIdentity::terminal(run.clone());
    wrong_event.event_id.push_str("-other");
    assert_eq!(
        observe_run(&state, &run, None, Some(&wrong_event)),
        Err(NativeObservationError::TerminalNotObserved)
    );
    state
        .commit_background_terminal(
            &BackgroundEventIdentity::terminal(run.clone()),
            TaskStatus::Completed,
            None,
        )
        .unwrap();
    assert_eq!(
        observe_run(&state, &run, None, Some(&wrong_event)),
        Err(NativeObservationError::TerminalMismatch)
    );
}

#[test]
fn legacy_import_and_duplicate_receipts_cannot_masquerade_as_verified_results() {
    for imported in [false, true] {
        let (_directory, state, run) = fixture(TaskKind::Subagent);
        let event = BackgroundEventIdentity::terminal(run.clone());
        state
            .commit_background_terminal(&event, TaskStatus::Completed, None)
            .unwrap();
        state.update_task(&run.agent_id, |task| {
            let record = task
                .background_runs
                .iter_mut()
                .find(|record| record.key == run)
                .unwrap();
            record.imported_history = imported;
            record.legacy_uncertain = !imported;
        });
        let observed = observe_run(&state, &run, None, None).unwrap();
        assert_eq!(
            observed.state,
            NativeRunState::Unknown(if imported {
                NativeUnknownReason::ImportedHistory
            } else {
                NativeUnknownReason::LegacyUncertain
            })
        );
        assert_eq!(observed.delivery, NativeDeliveryObservation::Unknown);
    }
    let (_directory, state, run) = fixture(TaskKind::Workflow);
    state.update_task(&run.agent_id, |task| {
        task.background_runs.push(task.background_runs[0].clone());
    });
    assert_eq!(
        observe_run(&state, &run, None, None),
        Err(NativeObservationError::InvalidReference)
    );
}

fn workflow_snapshot(state: &AppState, workspace: &Path) -> WorkflowRunSnapshot {
    WorkflowRunSnapshot {
        revision: 1,
        run_id: "workflow-fixture".into(),
        definition_id: Some("definition-fixture".into()),
        version: Some(3),
        thread_id: state.session_id(),
        workspace: workspace.to_str().unwrap().into(),
        status: "running".into(),
        error: None,
        started_at_ms: 1,
        updated_at_ms: 1,
        resume_count: 0,
        interaction_modified: false,
        node_states: vec![],
    }
}

fn workflow_reference(snapshot: &WorkflowRunSnapshot) -> PinnedWorkflowReference {
    PinnedWorkflowReference {
        thread_id: snapshot.thread_id.clone(),
        run_id: snapshot.run_id.clone(),
        definition_id: snapshot.definition_id.clone(),
        version: snapshot.version,
        resume_count: snapshot.resume_count,
        revision: snapshot.revision,
    }
}

#[test]
fn workflow_reads_real_pinned_run_without_recovering_or_mutating_it() {
    let (directory, state, _run) = fixture(TaskKind::Workflow);
    let root = directory.path().join("workflow-observations");
    let snapshot = workflow_snapshot(&state, directory.path());
    let reference = workflow_reference(&snapshot);
    let writer = RunObservation::start(root.clone(), snapshot).unwrap();
    let path = root.join("workflow-fixture.json");
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        observe_workflow(&root, directory.path(), &reference)
            .unwrap()
            .status,
        WorkflowRunStatus::Running
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    writer.update(|run| run.status = "failed".into()).unwrap();
    assert_eq!(
        observe_workflow(&root, directory.path(), &reference),
        Err(NativeObservationError::WorkflowReferenceMismatch)
    );
    let actual = observe_read(root.clone(), &reference.run_id).unwrap();
    assert_eq!(
        observe_workflow(&root, directory.path(), &workflow_reference(&actual))
            .unwrap()
            .status,
        WorkflowRunStatus::Failed
    );
}

#[test]
fn workflow_pins_thread_version_resume_and_actual_workspace() {
    let (directory, state, _run) = fixture(TaskKind::Workflow);
    let root = directory.path().join("workflow-observations");
    let snapshot = workflow_snapshot(&state, directory.path());
    let reference = workflow_reference(&snapshot);
    let _writer = RunObservation::start(root.clone(), snapshot).unwrap();
    let mut changed = reference.clone();
    changed.thread_id.push_str("-other");
    assert_eq!(
        observe_workflow(&root, directory.path(), &changed),
        Err(NativeObservationError::WorkflowReferenceMismatch)
    );
    changed = reference.clone();
    changed.version = Some(4);
    assert_eq!(
        observe_workflow(&root, directory.path(), &changed),
        Err(NativeObservationError::WorkflowReferenceMismatch)
    );
    changed = reference.clone();
    changed.resume_count += 1;
    assert_eq!(
        observe_workflow(&root, directory.path(), &changed),
        Err(NativeObservationError::WorkflowReferenceMismatch)
    );
    let other = tempfile::tempdir().unwrap();
    assert_eq!(
        observe_workflow(&root, other.path(), &reference),
        Err(NativeObservationError::WorkspaceMismatch)
    );
}

#[test]
fn workflow_future_status_is_preserved_as_unknown_and_never_repaired_by_read() {
    let (directory, state, _run) = fixture(TaskKind::Workflow);
    let root = directory.path().join("workflow-observations");
    let mut snapshot = workflow_snapshot(&state, directory.path());
    let reference = workflow_reference(&snapshot);
    let writer = RunObservation::start(root.clone(), snapshot.clone()).unwrap();
    drop(writer);
    snapshot.status = "future_wait".into();
    let path = root.join("workflow-fixture.json");
    std::fs::write(&path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert_eq!(
        observe_workflow(&root, directory.path(), &reference)
            .unwrap()
            .status,
        WorkflowRunStatus::Unknown("future_wait".into())
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

fn handoff_work(phase: &str, with_result: bool) -> WorkRecord {
    let mut value = serde_json::json!({
        "schemaVersion": 1,
        "identity": {
            "scope": {"accountId": "account-1", "targetId": "target-1", "workspaceId": "workspace-1"},
            "workId": "work-1"
        },
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": phase,
        "revision": {"revision": 4, "requirementsRevision": 2,
            "controlEpoch": 1, "ownerEpoch": 5, "acceptedInputSequence": 3,
            "requiredInputSequence": 2, "appliedInputSequence": 2}
    });
    if with_result {
        value["result"] = serde_json::json!({
            "resultId": "run:older:event-0",
            "basis": {"requirementsRevision": 1, "controlEpoch": 0,
                "ownerEpoch": 4, "appliedInputSequence": 1},
            "artifactRefs": [],
            "evidenceRefs": ["older"],
            "requiredDeliveryIds": []
        });
    }
    serde_json::from_value(value).unwrap()
}

fn handoff_observation(
    state: NativeRunState,
    delivery: NativeDeliveryObservation,
) -> NativeRunObservation {
    NativeRunObservation {
        run: BackgroundRunKey {
            parent_session_id: "thread-1".into(),
            agent_id: "agent-1".into(),
            run_id: "run-1".into(),
        },
        parent_attempt: ParentAttemptObservation::Missing,
        current_run: true,
        recorded_current_task_kind: None,
        state,
        delivery,
        output: NativeOutputObservation::NotRead,
    }
}

fn terminal(outcome: NativeTerminalOutcome) -> NativeRunState {
    NativeRunState::RecordedTerminal {
        event: BackgroundEventIdentity {
            run: BackgroundRunKey {
                parent_session_id: "thread-1".into(),
                agent_id: "agent-1".into(),
                run_id: "run-1".into(),
            },
            event_id: "event-1".into(),
            run_sequence: 7,
        },
        outcome,
    }
}

#[test]
fn a_verified_terminal_result_records_the_current_basis_once() {
    let work = handoff_work("running", false);
    let observation = handoff_observation(
        terminal(NativeTerminalOutcome::Failed),
        NativeDeliveryObservation::Suppressed,
    );
    let ResultHandoff::Record(draft) = plan_result_handoff(&work, &observation, true) else {
        panic!("a verified terminal run must be recordable");
    };
    assert_eq!(
        draft.basis,
        ResultBasis {
            requirements_revision: 2,
            control_epoch: 1,
            owner_epoch: 5,
            applied_input_sequence: 2,
        }
    );
    assert_eq!(draft.outcome, NativeTerminalOutcome::Failed);
    assert_eq!(draft.result_id, "run:run-1:event-1");
    // A replayed observation must not create a second result identity.
    let ResultHandoff::Record(replayed) = plan_result_handoff(&work, &observation, true) else {
        panic!("replay keeps the same decision");
    };
    assert_eq!(replayed.result_id, draft.result_id);
}

#[test]
fn non_terminal_and_untrusted_states_never_record() {
    let work = handoff_work("running", false);
    for state in [
        NativeRunState::RecordedPending,
        NativeRunState::RecordedRunning,
        NativeRunState::RecordedPaused,
    ] {
        let observation = handoff_observation(state, NativeDeliveryObservation::Suppressed);
        assert_eq!(
            plan_result_handoff(&work, &observation, true),
            ResultHandoff::Wait(ResultHandoffWait::NotTerminal)
        );
    }

    let unknown = handoff_observation(
        NativeRunState::Unknown(NativeUnknownReason::TerminalReceiptMissing),
        NativeDeliveryObservation::Suppressed,
    );
    assert_eq!(
        plan_result_handoff(&work, &unknown, true),
        ResultHandoff::Reconcile(ResultHandoffUnknown::RunState(
            NativeUnknownReason::TerminalReceiptMissing
        ))
    );
}

#[test]
fn a_pending_delivery_receipt_or_unproven_parent_requires_reconciliation() {
    let work = handoff_work("running", false);
    let pending = handoff_observation(
        terminal(NativeTerminalOutcome::Completed),
        NativeDeliveryObservation::PendingReconciliation,
    );
    assert_eq!(
        plan_result_handoff(&work, &pending, true),
        ResultHandoff::Reconcile(ResultHandoffUnknown::DeliveryPendingReconciliation)
    );

    let verified_delivery = handoff_observation(
        terminal(NativeTerminalOutcome::Completed),
        NativeDeliveryObservation::HistoryReceipt {
            message_id: "message-1".into(),
        },
    );
    assert_eq!(
        plan_result_handoff(&work, &verified_delivery, false),
        ResultHandoff::Reconcile(ResultHandoffUnknown::ParentAttemptUnverified)
    );
}

#[test]
fn a_terminal_or_already_recorded_work_item_keeps_the_newer_result_staged() {
    for phase in ["completed", "stopped", "failed"] {
        let work = handoff_work(phase, false);
        let observation = handoff_observation(
            terminal(NativeTerminalOutcome::Completed),
            NativeDeliveryObservation::Suppressed,
        );
        assert_eq!(
            plan_result_handoff(&work, &observation, true),
            ResultHandoff::Wait(ResultHandoffWait::NotAcceptable),
            "{phase} cannot accept a result"
        );
    }

    let recorded = handoff_work("running", true);
    let observation = handoff_observation(
        terminal(NativeTerminalOutcome::Completed),
        NativeDeliveryObservation::Suppressed,
    );
    assert_eq!(
        plan_result_handoff(&recorded, &observation, true),
        ResultHandoff::Wait(ResultHandoffWait::AlreadyRecorded)
    );
}

fn handoff_work_pinning(run_id: &str, attempt_id: &str) -> WorkRecord {
    let mut value = serde_json::json!({
        "schemaVersion": 1,
        "identity": {
            "scope": {"accountId": "account-1", "targetId": "target-1", "workspaceId": "workspace-1"},
            "workId": "work-1"
        },
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": "running",
        "revision": {"revision": 4, "requirementsRevision": 2,
            "controlEpoch": 1, "ownerEpoch": 5, "acceptedInputSequence": 3,
            "requiredInputSequence": 2, "appliedInputSequence": 2}
    });
    value["nativeRefs"] = serde_json::json!([{
        "kind": "background",
        "parentAttempt": {"threadId": "thread-1", "turnId": "turn-1", "attemptId": attempt_id},
        "run": {"parentSessionId": "thread-1", "agentId": "agent-1", "runId": run_id},
        "runKind": "subagent"
    }]);
    serde_json::from_value(value).unwrap()
}

fn observation_with_attempt(attempt_id: &str) -> NativeRunObservation {
    let mut observation = handoff_observation(
        terminal(NativeTerminalOutcome::Completed),
        NativeDeliveryObservation::Suppressed,
    );
    observation.parent_attempt = ParentAttemptObservation::Unverified(TurnAttemptIdentity {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        attempt_id: attempt_id.into(),
    });
    observation
}

#[test]
fn only_the_durable_binding_makes_a_terminal_run_recordable() {
    let pinned = handoff_work_pinning("run-1", "attempt-1");
    assert!(work_pins_run(
        &pinned,
        &observation_with_attempt("attempt-1")
    ));
    assert!(matches!(
        plan_bound_result_handoff(&pinned, &observation_with_attempt("attempt-1")),
        ResultHandoff::Record(_)
    ));

    // A different original attempt is still only a locator.
    assert!(!work_pins_run(
        &pinned,
        &observation_with_attempt("attempt-2")
    ));
    assert_eq!(
        plan_bound_result_handoff(&pinned, &observation_with_attempt("attempt-2")),
        ResultHandoff::Reconcile(ResultHandoffUnknown::ParentAttemptUnverified)
    );

    // A work item that pins nothing cannot consume any run.
    let unpinned = handoff_work("running", false);
    assert!(!work_pins_run(
        &unpinned,
        &observation_with_attempt("attempt-1")
    ));
    assert_eq!(
        plan_bound_result_handoff(&unpinned, &observation_with_attempt("attempt-1")),
        ResultHandoff::Reconcile(ResultHandoffUnknown::ParentAttemptUnverified)
    );
}
