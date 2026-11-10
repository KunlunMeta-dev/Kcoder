use super::*;
use kcoder_runtime_driver::RuntimeOutputObservation;

#[test]
fn task_state_snapshot_uses_original_cas_revision_without_body_or_replay() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    accepted_turn(&fixture, &mut driver, "observed-original");
    let reference = IntegrationRuntimeReadTaskParams {
        thread_id: Some("thread-fixture".into()),
        turn_id: Some("turn-fixture".into()),
        task_id: None,
    };
    let running = driver
        .read_task_state(&fixture.context, &reference)
        .unwrap();
    running.validate().unwrap();
    assert!(running.snapshot);
    assert_eq!(running.operation_id, "observed-original");
    assert_eq!(running.scope, *fixture.context.scope());
    assert_eq!(running.sequence, running.revision);
    assert_eq!(running.state, IntegrationTaskState::Running);
    let (_, revision) = driver
        .read_task_with_revision(&fixture.context, "observed-original")
        .unwrap();
    assert_eq!(running.revision, revision);
    let value = serde_json::to_value(&running).unwrap();
    for key in [
        "output",
        "prompt",
        "artifactRefs",
        "credential",
        "authority",
    ] {
        assert!(value.get(key).is_none());
    }
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Completed),
        )
        .unwrap();
    let completed = driver
        .read_task_state(&fixture.context, &reference)
        .unwrap();
    assert!(completed.revision > running.revision);
    assert_eq!(completed.state, IntegrationTaskState::Completed);
    assert!(
        driver
            .observe_turn_completed(
                &fixture.context,
                &complete("thread-fixture", "turn-fixture", TurnStatus::Running),
            )
            .is_err()
    );
    let cold = NativeRuntimeDriver::load(&fixture.context)
        .unwrap()
        .unwrap();
    assert!(!cold.has_commands());
    let restored = cold.read_task_state(&fixture.context, &reference).unwrap();
    assert_eq!(restored.revision, completed.revision);
    assert_eq!(restored.state, completed.state);
    let mut wrong = reference.clone();
    wrong.turn_id = Some("another-turn".into());
    assert!(cold.read_task_state(&fixture.context, &wrong).is_err());
    assert!(
        cold.read_task_state(&Fixture::new().context, &reference)
            .is_err()
    );
    assert_eq!(
        cold.read_task_state(&fixture.context, &reference)
            .unwrap()
            .revision,
        completed.revision
    );
}

#[test]
fn task_read_keeps_unconfirmed_output_and_original_revision_together() {
    let fixture = Fixture::new();
    let mut driver = fixture.driver();
    let operation = "confirmed-reference";
    accepted_turn(&fixture, &mut driver, operation);
    driver
        .observe_turn_completed(
            &fixture.context,
            &complete("thread-fixture", "turn-fixture", TurnStatus::Completed),
        )
        .unwrap();
    let reference = IntegrationRuntimeReadTaskParams {
        thread_id: Some("thread-fixture".into()),
        turn_id: Some("turn-fixture".into()),
        task_id: None,
    };
    let mut binding = driver.storage().bindings().get(operation).unwrap().unwrap();
    let previous_revision = binding.revision;
    binding.output_observation = Some(RuntimeOutputObservation {
        state: RuntimeOutputObservationState::Unconfirmed,
        started_at_ms: 1,
        budget_ms: 1,
        reason_code: Some("RUNTIME_OUTPUT_SOURCE_UNCONFIRMED".into()),
    });
    let unconfirmed = driver
        .storage()
        .bindings()
        .save(binding, Some(previous_revision))
        .unwrap();
    assert!(
        driver
            .read_confirmed_task_reference(&fixture.context, &reference)
            .unwrap()
            .is_none()
    );
    let snapshot = NativeRuntimeDriver::read_original_task_evidence(&fixture.context, operation)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.revision, unconfirmed.revision);
    assert!(!snapshot.has_settled_result());
    assert_eq!(
        driver
            .read_task_state(&fixture.context, &reference)
            .unwrap()
            .revision,
        unconfirmed.revision
    );
    driver
        .observe_transcript(
            &fixture.context,
            operation,
            "thread-fixture",
            &[
                serde_json::from_value(json!({"id":"original-final","role":"assistant",
                "turnId":"turn-fixture","content":"canonical result","timestampMs":1}))
                .unwrap(),
            ],
        )
        .unwrap();
    let (task, revision) = driver
        .read_confirmed_task_reference(&fixture.context, &reference)
        .unwrap()
        .unwrap();
    assert_eq!(task.output.as_deref(), Some("canonical result"));
    assert!(revision > unconfirmed.revision);
    let snapshot = NativeRuntimeDriver::read_original_task_evidence(&fixture.context, operation)
        .unwrap()
        .unwrap();
    assert!(snapshot.has_settled_result());
    assert_eq!(snapshot.revision, revision);
    assert_eq!(snapshot.task, task);
    assert_eq!(
        driver
            .read_task_state(&fixture.context, &reference)
            .unwrap()
            .revision,
        revision
    );
    assert!(!driver.has_commands());
}
