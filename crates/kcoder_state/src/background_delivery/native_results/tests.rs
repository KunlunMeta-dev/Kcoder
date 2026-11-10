use super::*;
use kcoder_types::continuous_work::terminal_evidence::{
    BACKGROUND_TERMINAL_EVIDENCE_V1, BackgroundContentCompleteness, BackgroundPayloadKind,
    BackgroundPayloadRef, BackgroundProcessFacts, BackgroundProcessState,
};

fn attempt(state: &AppState) -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "turn-original".into(),
        attempt_id: "attempt-original".into(),
    }
}

fn new_run(state: &AppState, name: &str) -> BackgroundRunKey {
    let mut task = Task::new(name, "owned subagent fixture");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    state.start_background_task_run(task).unwrap()
}

fn reserve_run(
    state: &AppState,
    name: &str,
    call: &str,
    bytes: u64,
) -> (BackgroundRunKey, NativeSubagentResultReservation) {
    let capacity = state.reserve_native_subagent_capacity(call, bytes).unwrap();
    let mut task = Task::new(name, "gated subagent fixture");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    let reservation = state
        .admit_reserved_native_subagent_run(&capacity, task)
        .unwrap();
    (reservation.run().clone(), reservation)
}

fn terminal(
    run: &BackgroundRunKey,
    status: TaskStatus,
    body: Option<&str>,
) -> BackgroundTerminalEvidence {
    BackgroundTerminalEvidence {
        schema_version: BACKGROUND_TERMINAL_EVIDENCE_V1,
        event: BackgroundEventIdentity::terminal(run.clone()),
        status,
        payload_state: if body.is_some() {
            BackgroundPayloadState::Captured
        } else {
            BackgroundPayloadState::NotProvided
        },
        payload: body.map(|body| BackgroundPayloadRef {
            kind: BackgroundPayloadKind::ToolOutput,
            object_id: "inline-original".into(),
            sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
            bytes: body.len() as u64,
        }),
        completeness: BackgroundContentCompleteness::Unobserved,
        output_is_error: Some(false),
        process: BackgroundProcessFacts {
            state: BackgroundProcessState::NotReported,
            exit_code: None,
            signal: None,
        },
    }
}

async fn fixture() -> (tempfile::TempDir, AppState, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    let path = root.path().join(format!("{}.jsonl", state.session_id()));
    state.with_history_path(&path);
    state.add_message(kcoder_types::Message::user_text("owned fixture"));
    state.flush_history().await.unwrap();
    (root, state, path)
}

#[tokio::test]
async fn exact_subagent_terminal_and_private_body_survive_session_restart() {
    let (_root, state, path) = fixture().await;
    let current = attempt(&state);
    let scope = state.history_attempt_scope(current.clone()).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call-original", 1024) })
        .await;
    let body = r#"{"result":"owned result"}"#;
    let evidence = terminal(&run, TaskStatus::Completed, Some(body));
    assert!(
        state
            .commit_native_subagent_result(&reservation, evidence.clone(), Some(body.into()))
            .unwrap()
    );
    assert!(
        !state
            .commit_background_terminal(&evidence.event, TaskStatus::Completed, None)
            .unwrap()
    );
    assert!(
        !state
            .commit_native_subagent_result(&reservation, evidence.clone(), Some(body.into()))
            .unwrap()
    );
    state.update_task("agent", |task| {
        task.description = "later metadata update".into()
    });
    let original = state.observe_native_subagent_result(&run).unwrap().unwrap();
    assert_eq!(original.parent_attempt, current);
    assert_eq!(original.parent_tool_call_id, "call-original");
    assert_eq!(original.private_payload_json(), Some(body));
    assert!(!format!("{original:?}").contains("owned result"));
    drop(state);

    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(&path).unwrap();
    let observed = restored
        .observe_native_subagent_result(&run)
        .unwrap()
        .unwrap();
    assert_eq!(observed.parent_attempt, current);
    assert_eq!(observed.evidence.as_ref().unwrap().event, evidence.event);
    assert_eq!(observed.private_payload_json(), Some(body));
}

#[tokio::test]
async fn saturation_denies_before_child_dispatch_and_leaves_existing_reservation() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let first = scope
        .run(async {
            let (first, _reservation) = reserve_run(
                &state,
                "agent-a",
                "call-a",
                MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES,
            );
            assert!(
                state
                    .reserve_native_subagent_capacity(
                        "call-b",
                        MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES
                    )
                    .is_err()
            );
            first
        })
        .await;
    assert!(
        state
            .observe_native_subagent_result(&first)
            .unwrap()
            .is_some()
    );
    assert!(state.task("agent-b").is_none());
}

#[tokio::test]
async fn unbound_capacity_can_be_released_after_explicit_spawn_rejection() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    scope
        .run(async {
            let capacity = state
                .reserve_native_subagent_capacity("call-a", MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES)
                .unwrap();
            state.release_native_subagent_capacity(capacity).unwrap();
            let next = state
                .reserve_native_subagent_capacity("call-a", MAX_BACKGROUND_TERMINAL_PAYLOAD_BYTES)
                .unwrap();
            state.release_native_subagent_capacity(next).unwrap();
        })
        .await;
}

#[tokio::test]
async fn original_attempt_and_call_cannot_be_replayed_with_a_new_reservation_id() {
    let (_root, state, path) = fixture().await;
    let original = attempt(&state);
    let scope = state.history_attempt_scope(original.clone()).unwrap();
    scope
        .run(async {
            let (_run, _reservation) = reserve_run(&state, "agent", "call", 1024);
            assert!(
                state
                    .reserve_native_subagent_capacity("call", 1024)
                    .is_err()
            );
        })
        .await;
    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(&path).unwrap();
    let scope = restored.history_attempt_scope(original).unwrap();
    scope
        .run(async {
            assert!(
                restored
                    .reserve_native_subagent_capacity("call", 1024)
                    .is_err()
            );
        })
        .await;
}

#[tokio::test]
async fn failed_cancelled_and_missing_outputs_keep_distinct_terminal_facts() {
    for status in [
        TaskStatus::Failed,
        TaskStatus::Cancelled,
        TaskStatus::Halted,
    ] {
        let (_root, state, _path) = fixture().await;
        let scope = state.history_attempt_scope(attempt(&state)).unwrap();
        let (run, reservation) = scope
            .run(async { reserve_run(&state, "agent", "call", 1024) })
            .await;
        let evidence = terminal(&run, status.clone(), None);
        state
            .commit_background_terminal(&evidence.event, status.clone(), None)
            .unwrap();
        state
            .commit_native_subagent_result(&reservation, evidence, None)
            .unwrap();
        let result = state.observe_native_subagent_result(&run).unwrap().unwrap();
        assert_eq!(result.evidence.unwrap().status, status);
        assert!(result.payload_json.is_none());
    }
}

#[tokio::test]
async fn late_original_result_is_retained_only_under_its_exact_old_run() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (old, reservation) = scope
        .run(async { reserve_run(&state, "same-agent", "call-old", 1024) })
        .await;
    let body = r#"{"result":"old run only"}"#;
    let evidence = terminal(&old, TaskStatus::Completed, Some(body));
    state
        .commit_background_terminal(&evidence.event, TaskStatus::Completed, None)
        .unwrap();
    let new = new_run(&state, "same-agent");
    assert_ne!(old.run_id, new.run_id);
    state
        .commit_native_subagent_result(&reservation, evidence, Some(body.into()))
        .unwrap();
    assert!(
        state
            .observe_native_subagent_result(&old)
            .unwrap()
            .unwrap()
            .evidence
            .is_some()
    );
    assert!(
        state
            .observe_native_subagent_result(&new)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        state.task("same-agent").unwrap().status,
        TaskStatus::Running
    );
    assert_eq!(
        state
            .observe_native_subagent_result(&old)
            .unwrap()
            .unwrap()
            .private_payload_json(),
        Some(body)
    );
}

#[tokio::test]
async fn restored_or_wrong_attempt_cannot_reserve_or_commit_as_original_owner() {
    let (_root, state, path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    assert!(
        state
            .reserve_native_subagent_capacity("call", 1024)
            .is_err()
    );
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    let evidence = terminal(&run, TaskStatus::Failed, None);
    state
        .commit_background_terminal(&evidence.event, TaskStatus::Failed, None)
        .unwrap();
    state.resume_from_history(&path).unwrap();
    assert!(
        state
            .commit_native_subagent_result(&reservation, evidence, None)
            .is_err()
    );
    assert!(
        state
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
}

#[tokio::test]
async fn failed_sidecar_write_keeps_terminal_uncommitted_and_allows_exact_retry() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    let body = r#"{"result":"original"}"#;
    let evidence = terminal(&run, TaskStatus::Completed, Some(body));
    let sidecar = state.session_state_path().unwrap();
    let failure = crate::session_persistence::install_atomic_replace_failpoint(sidecar);
    assert!(
        state
            .commit_native_subagent_result(&reservation, evidence.clone(), Some(body.into()))
            .is_err()
    );
    assert!(
        state
            .background_run_record(&run)
            .unwrap()
            .terminal
            .is_none()
    );
    assert!(
        state
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
    drop(failure);
    assert!(
        state
            .commit_native_subagent_result(&reservation, evidence.clone(), Some(body.into()))
            .unwrap()
    );
    assert_eq!(
        state.background_run_record(&run).unwrap().terminal,
        Some(evidence.event)
    );
    assert_eq!(
        state
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .private_payload_json(),
        Some(body)
    );
}

#[tokio::test]
async fn restart_before_terminal_keeps_original_result_unknown_and_never_reissues_it() {
    let (_root, state, path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    drop(state);
    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(&path).unwrap();
    let observed = restored
        .observe_native_subagent_result(&run)
        .unwrap()
        .unwrap();
    assert!(observed.evidence.is_none());
    assert!(observed.private_payload_json().is_none());
    assert!(
        restored
            .commit_native_subagent_result(
                &reservation,
                terminal(&run, TaskStatus::Completed, None),
                None
            )
            .is_err()
    );
}

#[tokio::test]
async fn pending_native_run_is_not_synthesized_as_failed_after_restart() {
    let (_root, state, path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, _reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    assert_eq!(state.task("agent").unwrap().status, TaskStatus::Pending);
    assert_eq!(
        state.background_run_record(&run).unwrap().run_started_at_ms,
        None
    );
    drop(state);
    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(&path).unwrap();
    let record = restored.background_run_record(&run).unwrap();
    assert_eq!(record.status, TaskStatus::Pending);
    assert!(record.terminal.is_none());
    assert!(
        restored
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
}

#[tokio::test]
async fn pending_admission_and_binding_commit_together_and_cannot_be_reused() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    scope
        .run(async {
            let capacity = state
                .reserve_native_subagent_capacity("call", 1024)
                .unwrap();
            let mut task = Task::new("first", "first original run");
            task.kind = TaskKind::Subagent;
            task.managed = true;
            let sidecar = state.session_state_path().unwrap();
            let failure = crate::session_persistence::install_atomic_replace_failpoint(sidecar);
            assert!(
                state
                    .admit_reserved_native_subagent_run(&capacity, task.clone())
                    .is_err()
            );
            assert!(state.task("first").is_none());
            drop(failure);

            let reservation = state
                .admit_reserved_native_subagent_run(&capacity, task)
                .unwrap();
            let run = reservation.run().clone();
            let record = state.background_run_record(&run).unwrap();
            assert_eq!(record.status, TaskStatus::Pending);
            assert_eq!(record.run_started_at_ms, None);
            assert!(record.terminal.is_none());
            let observed = state.observe_native_subagent_result(&run).unwrap().unwrap();
            assert_eq!(observed.parent_attempt, attempt(&state));
            assert_eq!(observed.parent_tool_call_id, "call");
            assert!(observed.evidence.is_none());

            let mut second = Task::new("second", "must not reuse capacity");
            second.kind = TaskKind::Subagent;
            second.managed = true;
            assert!(
                state
                    .admit_reserved_native_subagent_run(&capacity, second)
                    .is_err()
            );
            assert!(state.task("second").is_none());
            assert!(state.release_native_subagent_capacity(capacity).is_err());

            let other = state
                .reserve_native_subagent_capacity("other-call", 1024)
                .unwrap();
            let mut same_id = Task::new("first", "must not replace the original run");
            same_id.kind = TaskKind::Subagent;
            same_id.managed = true;
            assert!(
                state
                    .admit_reserved_native_subagent_run(&other, same_id)
                    .is_err()
            );
            assert_eq!(
                state.task("first").unwrap().background_run.as_ref(),
                Some(&run)
            );
            state.release_native_subagent_capacity(other).unwrap();
        })
        .await;
}

#[tokio::test]
async fn original_capacity_cannot_admit_after_same_session_is_restored() {
    let (_root, state, path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let capacity = scope
        .run(async {
            state
                .reserve_native_subagent_capacity("call", 1024)
                .unwrap()
        })
        .await;
    state.resume_from_history(&path).unwrap();
    let mut task = Task::new("agent", "must not cross lifecycle");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    assert!(
        state
            .admit_reserved_native_subagent_run(&capacity, task)
            .is_err()
    );
    assert!(state.task("agent").is_none());
}

#[tokio::test]
async fn unbound_reservation_keeps_same_session_subagent_uncertain_on_restore() {
    let (_root, state, path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let _capacity = scope
        .run(async {
            state
                .reserve_native_subagent_capacity("call", 1024)
                .unwrap()
        })
        .await;
    // Simulate an older host that created a run but crashed before it could
    // bind the original reservation. No result or execution is inferred.
    let run = new_run(&state, "legacy-unbound");
    let mut generic = Task::new("unrelated-generic", "ordinary managed task");
    generic.managed = true;
    let generic = state.start_background_task_run(generic).unwrap();
    drop(state);

    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(&path).unwrap();
    let original = restored.background_run_record(&run).unwrap();
    assert_eq!(original.status, TaskStatus::Running);
    assert!(original.terminal.is_none());
    assert!(
        restored
            .observe_native_subagent_result(&run)
            .unwrap()
            .is_none()
    );
    let unrelated = restored.background_run_record(&generic).unwrap();
    assert_eq!(unrelated.status, TaskStatus::Failed);
    assert!(unrelated.terminal.is_some());
}

#[tokio::test]
async fn bound_running_run_without_terminal_stays_uncertain_after_restart() {
    let (_root, state, path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, _reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    state
        .transact_background("agent", |task| {
            task.status = TaskStatus::Running;
            task.background_runs.last_mut().unwrap().status = TaskStatus::Running;
            Ok(())
        })
        .unwrap();
    drop(state);
    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(&path).unwrap();
    let record = restored.background_run_record(&run).unwrap();
    assert_eq!(record.status, TaskStatus::Running);
    assert!(record.terminal.is_none());
    assert!(
        restored
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
}

#[tokio::test]
async fn invalid_payload_does_not_commit_a_terminal_or_change_the_pending_task() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    let body = r#"{"result":"original"}"#;
    let mut evidence = terminal(&run, TaskStatus::Completed, Some(body));
    evidence.payload.as_mut().unwrap().sha256 = "0".repeat(64);
    assert!(
        state
            .commit_native_subagent_result(&reservation, evidence, Some(body.into()))
            .is_err()
    );
    assert_eq!(state.task("agent").unwrap().status, TaskStatus::Pending);
    assert!(
        state
            .background_run_record(&run)
            .unwrap()
            .terminal
            .is_none()
    );
    assert!(
        state
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
}

#[tokio::test]
async fn original_terminal_and_output_error_remain_distinct_facts() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    let mut evidence = terminal(&run, TaskStatus::Failed, None);
    evidence.output_is_error = Some(false);
    state
        .commit_native_subagent_result(&reservation, evidence, None)
        .unwrap();
    let observed = state.observe_native_subagent_result(&run).unwrap().unwrap();
    let evidence = observed.evidence.as_ref().unwrap();
    assert_eq!(evidence.status, TaskStatus::Failed);
    assert_eq!(evidence.output_is_error, Some(false));
    assert!(observed.private_payload_json().is_none());
}

#[tokio::test]
async fn mutable_task_output_is_not_claimed_as_the_original_run_result() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    state
        .transact_background("agent", |task| {
            task.output = Some("unverified mutable snapshot".into());
            task.output_path = Some(PathBuf::from("unverified-output"));
            Ok(())
        })
        .unwrap();
    let body = r#"{"result":"original"}"#;
    state
        .commit_native_subagent_result(
            &reservation,
            terminal(&run, TaskStatus::Completed, Some(body)),
            Some(body.into()),
        )
        .unwrap();
    let record = state.background_run_record(&run).unwrap();
    assert!(record.output_path.is_none());
    assert!(record.output_snapshot.is_none());
    let result = state.observe_native_subagent_result(&run).unwrap().unwrap();
    assert_eq!(result.private_payload_json(), Some(body));
}

#[tokio::test]
async fn unknown_terminal_status_cannot_be_written_as_a_completed_run() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    let evidence = terminal(&run, TaskStatus::Unknown("future-status".into()), None);
    assert!(
        state
            .commit_native_subagent_result(&reservation, evidence, None)
            .is_err()
    );
    assert_eq!(state.task("agent").unwrap().status, TaskStatus::Pending);
    assert!(
        state
            .background_run_record(&run)
            .unwrap()
            .terminal
            .is_none()
    );
    assert!(
        state
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
}

#[tokio::test]
async fn future_outbox_raw_bytes_survive_metadata_save_and_restore() {
    for future_version in [false, true] {
        let (_root, state, path) = fixture().await;
        let scope = state.history_attempt_scope(attempt(&state)).unwrap();
        let (run, _reservation) = scope
            .run(async { reserve_run(&state, "agent", "call", 1024) })
            .await;
        let sidecar = state.session_state_path().unwrap();
        let source = state.read_inner().history_source.clone().unwrap();
        let mut original = String::new();
        source
            .write_metadata(&sidecar, || {
                let mut stored = load_owned_sidecar(&sidecar)?;
                let valid = stored.native_subagent_outbox.take().unwrap().0;
                let prefix = valid.get().strip_suffix('}').unwrap();
                let prefix = if future_version {
                    assert!(prefix.contains("\"version\":1"));
                    prefix.replacen("\"version\":1", "\"version\":999", 1)
                } else {
                    prefix.to_owned()
                };
                original = format!(
                    "{prefix},\n  \"futureField\" : {{ \"huge\" : 1234567890123456789012345678901234567890, \"spaces\" : [  1,  2 ] }}\n}}"
                );
                stored.native_subagent_outbox = Some(PrivateNativeOutbox(
                    serde_json::value::RawValue::from_string(original.clone())?,
                ));
                prepare_session_state_write(&sidecar, &stored)
            })
            .unwrap();
        let load_raw = || {
            load_owned_sidecar(&sidecar)
                .unwrap()
                .native_subagent_outbox
                .unwrap()
                .0
                .get()
                .to_owned()
        };
        assert_eq!(load_raw(), original);
        assert!(
            !format!("{:?}", load_owned_sidecar(&sidecar).unwrap())
                .contains("1234567890123456789012345678901234567890")
        );
        assert!(state.observe_native_subagent_result(&run).is_err());
        state.update_task("agent", |task| task.description = "metadata update".into());
        assert_eq!(load_raw(), original);
        state.save_history().unwrap();
        assert_eq!(load_raw(), original);
        drop(state);
        let restored = AppState::new(path.parent().unwrap());
        restored.resume_from_history(&path).unwrap();
        assert_eq!(load_raw(), original);
        assert_eq!(
            restored.background_run_record(&run).unwrap().status,
            TaskStatus::Pending
        );
        assert!(
            restored
                .background_run_record(&run)
                .unwrap()
                .terminal
                .is_none()
        );
        assert!(restored.observe_native_subagent_result(&run).is_err());
    }
}

#[tokio::test]
async fn poisoned_state_cannot_reserve_or_modify_the_original_sidecar() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let sidecar = state.session_state_path().unwrap();
    let before = std::fs::read(&sidecar).unwrap();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _locked = state.inner.write().unwrap();
        panic!("intentional poisoned State fixture");
    }));
    assert!(
        scope
            .run(async { state.reserve_native_subagent_capacity("call", 1024) })
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&sidecar).unwrap(), before);
}

#[tokio::test]
async fn conflicting_terminal_replay_cannot_replace_the_original_result() {
    let (_root, state, _path) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 1024) })
        .await;
    let body = r#"{"result":"first"}"#;
    let original = terminal(&run, TaskStatus::Completed, Some(body));
    state
        .commit_native_subagent_result(&reservation, original.clone(), Some(body.into()))
        .unwrap();
    let conflicting = terminal(&run, TaskStatus::Failed, None);
    assert!(
        state
            .commit_native_subagent_result(&reservation, conflicting, None)
            .is_err()
    );
    let other_body = r#"{"result":"replacement"}"#;
    assert!(
        state
            .commit_native_subagent_result(
                &reservation,
                terminal(&run, TaskStatus::Completed, Some(other_body)),
                Some(other_body.into()),
            )
            .is_err()
    );
    let observed = state.observe_native_subagent_result(&run).unwrap().unwrap();
    assert_eq!(observed.evidence.as_ref(), Some(&original));
    assert_eq!(observed.private_payload_json(), Some(body));
}

#[tokio::test]
async fn legacy_sidecar_without_outbox_still_restores_and_accepts_a_new_reservation() {
    let (_root, state, history) = fixture().await;
    let sidecar = state.session_state_path().unwrap();
    let mut legacy = load_owned_sidecar(&sidecar).unwrap();
    legacy.schema_version = 1;
    legacy.delivery_format = None;
    legacy.native_subagent_outbox = None;
    let bytes = serde_json::to_vec_pretty(&legacy).unwrap();
    assert!(
        serde_json::from_slice::<Value>(&bytes)
            .unwrap()
            .get("native_subagent_outbox")
            .is_none()
    );
    std::fs::write(&sidecar, &bytes).unwrap();
    drop(state);

    let restored = AppState::new(history.parent().unwrap());
    restored.resume_from_history(&history).unwrap();
    assert!(
        load_owned_sidecar(&sidecar)
            .unwrap()
            .native_subagent_outbox
            .is_none()
    );
    let scope = restored.history_attempt_scope(attempt(&restored)).unwrap();
    let (run, _reservation) = scope
        .run(async { reserve_run(&restored, "agent", "new-call", 1024) })
        .await;
    assert_eq!(
        restored.background_run_record(&run).unwrap().status,
        TaskStatus::Pending
    );
    assert!(
        restored
            .observe_native_subagent_result(&run)
            .unwrap()
            .unwrap()
            .evidence
            .is_none()
    );
}

fn switch_to_copied_source(root: &Path, state: &AppState, history: &Path) -> PathBuf {
    let original_sidecar = state.session_state_path().unwrap();
    let alternate = root.join("alternate");
    kcoder_config::PrivateDirectory::open_or_create(&alternate).unwrap();
    let alternate_history = alternate.join(history.file_name().unwrap());
    std::fs::copy(history, &alternate_history).unwrap();
    state.with_deferred_history_path(&alternate_history);
    let alternate_sidecar = state.session_state_path().unwrap();
    kcoder_config::PrivateDirectory::open_or_create(alternate_sidecar.parent().unwrap()).unwrap();
    std::fs::copy(&original_sidecar, &alternate_sidecar).unwrap();
    alternate_sidecar
}

#[tokio::test]
async fn copied_same_session_sidecar_cannot_adopt_an_original_result() {
    let (root, state, history) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 4096) })
        .await;
    let original_sidecar = state.session_state_path().unwrap();
    let original = std::fs::read(&original_sidecar).unwrap();
    let alternate = switch_to_copied_source(root.path(), &state, &history);
    assert!(reservation.lifecycle.matches(&state));
    assert!(!reservation.matches_state(&state));
    let before = std::fs::read(&alternate).unwrap();
    let body = r#"{"result":"original"}"#;
    let error = state
        .commit_native_subagent_result(
            &reservation,
            terminal(&run, TaskStatus::Completed, Some(body)),
            Some(body.into()),
        )
        .unwrap_err();
    assert!(format!("{error:#}").contains("NATIVE_RESULT_SOURCE_CHANGED"));
    assert_eq!(std::fs::read(&alternate).unwrap(), before);
    assert_eq!(std::fs::read(&original_sidecar).unwrap(), original);
}

#[tokio::test]
async fn returning_to_the_same_history_path_does_not_reuse_an_old_result_binding() {
    let (root, state, history) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let (run, reservation) = scope
        .run(async { reserve_run(&state, "agent", "call", 4096) })
        .await;
    let sidecar = state.session_state_path().unwrap();
    let _alternate = switch_to_copied_source(root.path(), &state, &history);
    state.with_deferred_history_path(&history);
    assert!(reservation.lifecycle.matches(&state));
    assert!(!reservation.matches_state(&state));
    let before = std::fs::read(&sidecar).unwrap();
    let body = r#"{"result":"original"}"#;
    assert!(
        state
            .commit_native_subagent_result(
                &reservation,
                terminal(&run, TaskStatus::Completed, Some(body)),
                Some(body.into()),
            )
            .is_err()
    );
    assert_eq!(std::fs::read(&sidecar).unwrap(), before);
}

#[tokio::test]
async fn copied_same_session_sidecar_cannot_admit_or_release_original_capacity() {
    let (root, state, history) = fixture().await;
    let scope = state.history_attempt_scope(attempt(&state)).unwrap();
    let capacity = scope
        .run(async {
            state
                .reserve_native_subagent_capacity("call", 4096)
                .unwrap()
        })
        .await;
    let original_sidecar = state.session_state_path().unwrap();
    let original = std::fs::read(&original_sidecar).unwrap();
    let alternate = switch_to_copied_source(root.path(), &state, &history);
    assert!(capacity.lifecycle.matches(&state));
    let before = std::fs::read(&alternate).unwrap();
    let mut task = Task::new("must-not-start", "owned child");
    task.kind = TaskKind::Subagent;
    task.managed = true;
    let error = state
        .admit_reserved_native_subagent_run(&capacity, task)
        .unwrap_err();
    assert!(format!("{error:#}").contains("NATIVE_RESULT_SOURCE_CHANGED"));
    let error = state
        .release_native_subagent_capacity(capacity)
        .unwrap_err();
    assert!(format!("{error:#}").contains("NATIVE_RESULT_SOURCE_CHANGED"));
    assert!(state.task("must-not-start").is_none());
    assert_eq!(std::fs::read(&alternate).unwrap(), before);
    assert_eq!(std::fs::read(&original_sidecar).unwrap(), original);
}

#[tokio::test]
async fn original_native_tokens_do_not_keep_the_source_binding_or_lock_alive() {
    enum Token {
        Capacity(NativeSubagentResultCapacity),
        Reservation(NativeSubagentResultReservation),
    }
    for bind in [false, true] {
        let (_root, state, history) = fixture().await;
        let scope = state.history_attempt_scope(attempt(&state)).unwrap();
        let token = scope
            .run(async {
                let capacity = state
                    .reserve_native_subagent_capacity("call", 4096)
                    .unwrap();
                if bind {
                    let mut task = Task::new("agent", "owned child");
                    task.kind = TaskKind::Subagent;
                    task.managed = true;
                    Token::Reservation(
                        state
                            .admit_reserved_native_subagent_run(&capacity, task)
                            .unwrap(),
                    )
                } else {
                    Token::Capacity(capacity)
                }
            })
            .await;
        let source = match &token {
            Token::Capacity(capacity) => capacity.source.clone(),
            Token::Reservation(reservation) => reservation.source.clone(),
        };
        assert!(source.is_alive());
        drop(state);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while source.is_alive() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the original flusher must release its source binding");
        let directory =
            kcoder_config::PrivateDirectory::open_existing(history.parent().unwrap()).unwrap();
        let lock = directory
            .open_read_write_file(std::ffi::OsStr::new(".kcoder-history.lock"), false)
            .unwrap();
        fs2::FileExt::try_lock_exclusive(&lock).expect("the original source lock must be free");
        fs2::FileExt::unlock(&lock).unwrap();
        drop(token);
    }
}
