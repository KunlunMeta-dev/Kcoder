use super::*;
use kcoder_state::continuous_work::WorkInputSource;
use kcoder_types::continuous_work::{
    WorkIdentity, WorkInputKind, WorkInputReceipt, WorkInputState, WorkRecord, WorkScope,
};
use serde_json::json;

fn recorded_work(artifact_refs: Vec<&str>) -> WorkRecord {
    serde_json::from_value(json!({
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
            "requiredInputSequence": 2, "appliedInputSequence": 2},
        "result": {
            "resultId": "run:run-1:event-1",
            "basis": {"requirementsRevision": 2, "controlEpoch": 1,
                "ownerEpoch": 5, "appliedInputSequence": 2},
            "artifactRefs": artifact_refs,
            "evidenceRefs": ["background:event-1"],
            "requiredDeliveryIds": []
        }
    }))
    .unwrap()
}

#[test]
fn a_recorded_result_projects_its_artifacts_without_claiming_completion() {
    let work = recorded_work(vec!["artifact-report-1", "artifact-log-2"]);
    let view = result_view(&work).expect("a recorded result must be projected");
    assert_eq!(view.result_id, "run:run-1:event-1");
    assert_eq!(
        view.artifact_refs,
        vec![
            "artifact-report-1".to_string(),
            "artifact-log-2".to_string()
        ],
        "the recorded artifacts are the client's only deliverable reference"
    );
    assert!(!view.ready, "a recorded result is not business completion");
    view.validate_observation().unwrap();
}

#[test]
fn a_work_item_without_a_result_projects_nothing() {
    let mut work = recorded_work(vec![]);
    work.result = None;
    assert!(result_view(&work).is_none());
}

fn pending_entry(sequence: u64, state: WorkInputState) -> PendingInputEntry {
    PendingInputEntry {
        source: WorkInputSource {
            kind: "foreground".into(),
            instance_id: "target-1".into(),
            conversation_id: "thread-1".into(),
        },
        receipt: WorkInputReceipt {
            work: WorkIdentity {
                scope: WorkScope {
                    account_id: "account-1".into(),
                    target_id: "target-1".into(),
                    workspace_id: "workspace-1".into(),
                },
                work_id: "work-1".into(),
            },
            input_id: format!("input-{sequence}"),
            request_id: format!("request-{sequence}"),
            request_digest: "a".repeat(64),
            payload_ref: format!("payload-{sequence}"),
            sequence,
            kind: WorkInputKind::Requirement,
            state,
            requirements_revision: Some(sequence),
        },
    }
}

fn pending_page(states: Vec<WorkInputState>) -> PendingInputPage {
    PendingInputPage {
        inputs: states
            .into_iter()
            .enumerate()
            .map(|(index, state)| pending_entry(index as u64 + 1, state))
            .collect(),
        next_after_sequence: None,
    }
}

#[test]
fn observed_pending_inputs_keep_the_sequence_order_and_the_real_states() {
    let page = pending_page(vec![
        WorkInputState::Queued,
        WorkInputState::Unknown("future_state".into()),
    ]);
    let pending = observed_pending_inputs(Ok(page)).expect("a readable queue is projected");
    assert_eq!(
        pending
            .iter()
            .map(|input| input.input_id.as_str())
            .collect::<Vec<_>>(),
        ["input-1", "input-2"]
    );
    assert_eq!(
        pending
            .iter()
            .map(|input| input.sequence)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(pending[0].state, WorkInputState::Queued);
    assert_eq!(
        pending[1].state,
        WorkInputState::Unknown("future_state".into())
    );
    let view = view_from(recorded_work(vec![]), Some(pending)).expect("projected view");
    let inputs = view.pending_inputs.expect("pending inputs");
    assert_eq!(inputs.len(), 2);
    assert!(!inputs[1].state.is_known());
    // The queue is an observation: the rest of the record is untouched.
    assert_eq!(view.freshness, WorkObservationFreshness::Partial);
    assert_eq!(view.unconsumed_inputs, Some(1));
    assert_eq!(view.usage.expect("usage").automatic_turns, 0);
}

#[test]
fn an_unobserved_queue_omits_the_field_and_leaves_the_record_unchanged() {
    let observed = view_from(
        recorded_work(vec!["artifact-report-1"]),
        observed_pending_inputs(Ok(pending_page(vec![WorkInputState::Accepted]))),
    )
    .expect("projected view");
    let unobserved = view_from(
        recorded_work(vec!["artifact-report-1"]),
        observed_pending_inputs(Err(anyhow::anyhow!("CONTINUOUS_WORK_BUSY"))),
    )
    .expect("a failed queue read must not fail the record");
    assert!(unobserved.pending_inputs.is_none());
    assert!(observed.pending_inputs.is_some());
    // A read that could not observe the queue changes nothing else.
    assert_eq!(unobserved.work_id, observed.work_id);
    assert_eq!(unobserved.thread_id, observed.thread_id);
    assert_eq!(unobserved.phase, observed.phase);
    assert_eq!(unobserved.revision, observed.revision);
    assert_eq!(
        unobserved.requirements_revision,
        observed.requirements_revision
    );
    assert_eq!(unobserved.freshness, observed.freshness);
    assert_eq!(unobserved.usage, observed.usage);
    assert_eq!(unobserved.unconsumed_inputs, observed.unconsumed_inputs);
    assert_eq!(unobserved.result, observed.result);
}

#[test]
fn one_record_never_forwards_more_than_the_bounded_pending_queue() {
    let states = (0..MAX_PENDING_INPUT_VIEWS + 4)
        .map(|_| WorkInputState::Accepted)
        .collect();
    let pending = pending_input_views(&pending_page(states));
    assert_eq!(pending.len(), MAX_PENDING_INPUT_VIEWS);
    assert_eq!(pending.last().expect("last input").sequence, 8);
}
