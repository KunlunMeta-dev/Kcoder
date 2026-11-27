//! Synthetic records follow pinned Codex 0.163.0 PatchApplyEndEvent, not live execution.
use kcoder_migration::history_records::parse_reader;
use kcoder_types::{
    imported_transcript::{HistoricalRecord, HistoricalRecordData, HistoricalToolOutcome},
    migration::MigrationSourceKind,
};
use serde_json::{Value, json};

fn parse(value: Value) -> HistoricalRecord {
    parse_reader(
        MigrationSourceKind::Codex,
        0,
        serde_json::to_vec(&value).unwrap().as_slice(),
        |_| true,
    )
    .unwrap()
}

fn patch(success: Value, status: Value) -> Value {
    json!({"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"patch-known",
        "turn_id":"turn-patch","stdout":"Untrusted text cannot determine success","stderr":"",
        "changes":{},"success":success,"status":status}})
}

#[test]
fn a_pinned_patch_end_preserves_explicit_execution_without_becoming_a_second_message() {
    let lines = include_str!("../fixtures/codex-patch-execution-0.163.0.jsonl")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let record = parse(lines[2].clone());
    assert_eq!(record.turn_id.as_deref(), Some("turn-patch"));
    assert!(record.diagnostics.is_empty());
    assert!(matches!(record.data, HistoricalRecordData::Event {
        ref source_type, ref call_id, outcome: Some(HistoricalToolOutcome::RecordedSuccess), ..
    } if source_type == "patch_apply_end" && call_id.as_deref() == Some("patch-known")));
    let result = parse(lines[3].clone());
    assert!(
        matches!(result.data, HistoricalRecordData::Message { ref blocks, .. }
        if matches!(blocks.first(), Some(kcoder_types::imported_transcript::HistoricalBlock::ToolResult {
            outcome: HistoricalToolOutcome::RecordedResult, .. })))
    );
}

#[test]
fn only_consistent_typed_patch_statuses_supply_execution_facts() {
    for (success, status, expected) in [
        (true, "completed", HistoricalToolOutcome::RecordedSuccess),
        (false, "failed", HistoricalToolOutcome::RecordedError),
    ] {
        let record = parse(patch(json!(success), json!(status)));
        assert!(record.diagnostics.is_empty());
        assert!(
            matches!(record.data, HistoricalRecordData::Event { outcome: Some(actual), .. } if actual == expected)
        );
    }
}

#[test]
fn a_declined_patch_does_not_manufacture_an_execution_cancellation() {
    let record = parse(patch(json!(false), json!("declined")));
    assert!(matches!(
        record.data,
        HistoricalRecordData::Event { outcome: None, .. }
    ));
    assert!(
        record
            .diagnostics
            .iter()
            .any(|issue| issue.code == "patch_execution_declined" && issue.blocks_continuation)
    );
}

#[test]
fn patch_execution_identity_must_be_a_direct_complete_source_string() {
    for call_id in [
        Value::Null,
        json!(""),
        json!(42),
        json!({"id":"patch-known"}),
        json!("x".repeat(5000)),
    ] {
        let mut value = patch(json!(true), json!("completed"));
        value["payload"]["call_id"] = call_id;
        let record = parse(value);
        assert!(matches!(
            record.data,
            HistoricalRecordData::Event { outcome: None, .. }
        ));
        assert!(
            record
                .diagnostics
                .iter()
                .any(|issue| issue.code == "invalid_patch_execution_identity"
                    && issue.blocks_continuation)
        );
    }
    let mut value = patch(json!(true), json!("completed"));
    value["payload"]["turn_id"] = Value::Null;
    assert!(
        parse(value)
            .diagnostics
            .iter()
            .any(|issue| issue.code == "invalid_patch_execution_identity"
                && issue.blocks_continuation)
    );
    let mut compatible = patch(json!(true), json!("completed"));
    compatible["payload"]
        .as_object_mut()
        .unwrap()
        .remove("turn_id");
    assert!(matches!(
        parse(compatible).data,
        HistoricalRecordData::Event {
            outcome: Some(HistoricalToolOutcome::RecordedSuccess),
            ..
        }
    ));
}

#[test]
fn malformed_or_conflicting_patch_receipts_remain_inert_and_block_continuation() {
    let mut missing = patch(json!(true), json!("completed"));
    missing["payload"]
        .as_object_mut()
        .unwrap()
        .remove("success");
    let mut missing_status = patch(json!(true), json!("completed"));
    missing_status["payload"]
        .as_object_mut()
        .unwrap()
        .remove("status");
    for value in [
        patch(json!(true), json!("failed")),
        patch(json!(false), json!("completed")),
        patch(json!(true), json!("declined")),
        patch(json!("true"), json!("completed")),
        patch(Value::Null, json!("completed")),
        patch(json!({"value":true}), json!("completed")),
        patch(json!(true), json!("future_status")),
        patch(json!(true), json!({"value":"completed"})),
        missing,
        missing_status,
    ] {
        let record = parse(value);
        assert!(matches!(
            record.data,
            HistoricalRecordData::Event { outcome: None, .. }
        ));
        assert!(
            record
                .diagnostics
                .iter()
                .any(|issue| issue.blocks_continuation)
        );
    }
}

#[test]
fn unknown_event_names_and_nested_success_do_not_acquire_patch_authority() {
    let record = parse(
        json!({"type":"event_msg","payload":{"type":"unknown_future_event",
        "call_id":"patch-known","success":true,"status":"completed"}}),
    );
    assert!(matches!(
        record.data,
        HistoricalRecordData::Event { outcome: None, .. }
    ));
    let record = parse(
        json!({"type":"event_msg","payload":{"type":"patch_apply_end",
        "call_id":"patch-known","status":"completed","wrapper":{"success":true}}}),
    );
    assert!(matches!(
        record.data,
        HistoricalRecordData::Event { outcome: None, .. }
    ));
    assert!(
        record
            .diagnostics
            .iter()
            .any(|issue| issue.blocks_continuation)
    );
}
