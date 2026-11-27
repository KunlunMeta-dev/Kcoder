use kcoder_migration::history_records::{CODEX_ROLLOUT_BASELINE, parse_reader};
use kcoder_types::{imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn parse(value: &Value) -> (HistoricalRecord, Vec<u8>) {
    let bytes = serde_json::to_vec(value).unwrap();
    let record = parse_reader(MigrationSourceKind::Codex, 7, &bytes[..], |_| true).unwrap();
    (record, bytes)
}

fn has(record: &HistoricalRecord, code: &str) -> bool {
    record
        .diagnostics
        .iter()
        .any(|issue| issue.code == code && issue.blocks_continuation)
}

fn checkpoint(record: &HistoricalRecord) -> &HistoricalCompaction {
    let HistoricalRecordData::Compaction { checkpoint } = &record.data else {
        panic!("compaction expected")
    };
    checkpoint
}

fn item(role: &str, text: &str) -> Value {
    json!({"type":"message","role":role,"content":[{"type":"input_text","text":text}]})
}

#[test]
fn physical_prefix_and_logical_fork_keep_separate_source_identities() {
    let (record, _) = parse(&json!({"type":"session_meta","payload":{
        "id":"stable-thread","session_id":"root-thread","cli_version":CODEX_ROLLOUT_BASELINE,
        "forked_from_id":"logical-parent","forked_from_ordinal_exclusive":42,
        "subagent_history_start_ordinal":50,"history_mode":"paginated",
        "history_base":{"thread_id":"immutable-rollout","end_ordinal_exclusive":45,"end_byte_offset":2718}}}));
    let metadata = record.codex.as_ref().unwrap();
    assert_eq!(metadata.thread_id.as_deref(), Some("stable-thread"));
    assert_eq!(metadata.root_session_id.as_deref(), Some("root-thread"));
    assert_eq!(metadata.forked_from_id.as_deref(), Some("logical-parent"));
    assert_eq!(metadata.forked_before_ordinal, Some(42));
    let base = metadata.history_base.as_ref().unwrap();
    assert_eq!(base.rollout_id, "immutable-rollout");
    assert_eq!(base.end_ordinal_exclusive, 45);
    assert_eq!(base.end_byte_offset, 2718);
    assert!(has(&record, "source_history_base_required"));
    assert!(!has(&record, "invalid_codex_history_base"));
    assert!(matches!(
        record.data,
        HistoricalRecordData::Session {
            inherited_before_ordinal: Some(50),
            ..
        }
    ));
}

#[test]
fn malformed_prefix_fields_never_become_a_guessed_ordinal() {
    for base in [
        json!({"thread_id":"rollout","ordinal":12}),
        json!({"thread_id":"rollout","end_ordinal_exclusive":12}),
        json!({"thread_id":"rollout","end_ordinal_exclusive":-1,"end_byte_offset":20}),
        json!({"thread_id":"rollout","end_ordinal_exclusive":12,"end_byte_offset":"20"}),
        json!({"thread_id":"","end_ordinal_exclusive":12,"end_byte_offset":20}),
        json!([]),
    ] {
        let (record, _) = parse(
            &json!({"type":"session_meta","payload":{"id":"s","cli_version":CODEX_ROLLOUT_BASELINE,"history_base":base}}),
        );
        assert!(has(&record, "invalid_codex_history_base"));
        assert!(record.codex.unwrap().history_base.is_none());
    }
}

#[test]
fn replacement_items_and_parallel_metadata_preserve_order_offsets_and_opaque_values() {
    let long = format!("{}中文", "x".repeat(9000));
    let (record, bytes) = parse(&json!({"type":"compacted","payload":{
        "message":"summary","window_number":3,
        "replacement_history":[
            item("user", "human request"),
            {"type":"function_call","call_id":"old-call","name":"write","arguments":long,
             "internal_chat_message_metadata_passthrough":{"turn_id":"old-turn","executed_tool_calls":[{"name":"must-not-run"}]}},
            {"type":"reasoning","encrypted_content":"OPAQUE-CANARY"}],
        "replacement_history_metadata":[{"client_authored":true,"user_input_order":8},{"user_input_order":8},{"compaction_output":true}],
        "resume_metadata":{"last_started_turn_id":"old-turn"},
        "retained_context":{},"guardian_history":{}}}));
    assert!(record.diagnostics.is_empty());
    let cp = checkpoint(&record);
    assert_eq!(cp.window_number, Some(3));
    let entries = cp.replacement.as_ref().unwrap();
    assert_eq!(
        entries.iter().map(|entry| entry.index).collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert!(entries[0].metadata.client_authored);
    assert_eq!(entries[0].metadata.user_turn_boundary, Some(true));
    assert_eq!(entries[1].metadata.user_input_order, Some(8));
    assert!(entries[2].metadata.compaction_output);
    let HistoricalRecordData::Message { blocks, .. } = &entries[1].data else {
        panic!("message expected")
    };
    assert_eq!(blocks.len(), 1);
    let HistoricalBlock::ToolCall { name, input, .. } = &blocks[0] else {
        panic!("call expected")
    };
    assert_eq!(name, "write");
    assert_eq!(input.record, 7);
    let raw = &bytes[input.offset as usize..(input.offset + input.bytes) as usize];
    assert_eq!(serde_json::from_slice::<String>(raw).unwrap(), long);
    assert_eq!(
        input.decoded_sha256.as_deref(),
        Some(format!("{:x}", Sha256::digest(long.as_bytes())).as_str())
    );
    assert_eq!(input.preview.as_ref().unwrap().len(), 4096);
    let encoded = serde_json::to_string(&record).unwrap();
    assert!(!encoded.contains("OPAQUE-CANARY"));
    assert!(!encoded.contains("must-not-run"));
    for value in [
        &cp.resume_metadata,
        &cp.retained_context,
        &cp.guardian_history,
    ] {
        let value = value.as_ref().unwrap();
        assert!(value.preview.is_none());
        assert!(
            serde_json::from_slice::<Value>(
                &bytes[value.offset as usize..(value.offset + value.bytes) as usize]
            )
            .unwrap()
            .is_object()
        );
    }
}

#[test]
fn empty_replacement_is_an_explicit_checkpoint_but_missing_replacement_is_not() {
    let (empty, _) = parse(
        &json!({"type":"compacted","payload":{"message":"summary","replacement_history":[],"replacement_history_metadata":[],"window_id":5}}),
    );
    assert!(empty.diagnostics.is_empty());
    assert!(checkpoint(&empty).replacement.as_ref().unwrap().is_empty());
    assert_eq!(checkpoint(&empty).window_number, Some(5));
    let (missing, _) = parse(
        &json!({"type":"compacted","payload":{"message":"summary","replacement_history_metadata":[],"window_number":6}}),
    );
    assert!(has(&missing, "unresolved_compaction_history"));
    assert!(has(&missing, "compaction_metadata_length_mismatch"));
    assert!(checkpoint(&missing).replacement.is_none());
}

#[test]
fn malformed_checkpoint_shapes_and_item_metadata_remain_blocking_evidence() {
    for (payload, code) in [
        (
            json!({"message":"s","replacement_history":{}}),
            "invalid_compaction_history",
        ),
        (
            json!({"message":false,"replacement_history":[]}),
            "invalid_compaction_summary",
        ),
        (
            json!({"message":"s","replacement_history":[],"replacement_history_metadata":[{}]}),
            "compaction_metadata_length_mismatch",
        ),
        (
            json!({"message":"s","replacement_history":[item("user","x")],"replacement_history_metadata":[null]}),
            "invalid_compaction_item_metadata",
        ),
        (
            json!({"message":"s","replacement_history":[item("user","x")],"replacement_history_metadata":[{"user_input_order":-2}]}),
            "invalid_codex_input_order",
        ),
        (
            json!({"message":"s","replacement_history":[item("user","x")],"replacement_history_metadata":[{"client_authored":"yes"}]}),
            "invalid_codex_harness_metadata",
        ),
        (
            json!({"message":"s","replacement_history":[],"window_number":"3"}),
            "invalid_codex_window_number",
        ),
    ] {
        let (record, _) = parse(&json!({"type":"compacted","payload":payload}));
        assert!(has(&record, code), "expected {code}");
    }
    for key in ["resume_metadata", "retained_context", "guardian_history"] {
        let mut payload = json!({"message":"s","replacement_history":[]});
        payload[key] = json!(["invalid"]);
        let (record, _) = parse(&json!({"type":"compacted","payload":payload}));
        assert!(has(&record, "invalid_compaction_checkpoint"));
        let cp = checkpoint(&record);
        let reference = match key {
            "resume_metadata" => &cp.resume_metadata,
            "retained_context" => &cp.retained_context,
            _ => &cp.guardian_history,
        };
        assert!(reference.is_some());
    }
}

#[test]
fn malformed_source_order_and_child_boundaries_do_not_turn_into_missing_defaults() {
    for key in [
        "forked_from_ordinal_exclusive",
        "subagent_history_start_ordinal",
    ] {
        let mut payload = json!({"id":"s","cli_version":CODEX_ROLLOUT_BASELINE});
        payload[key] = "wrong".into();
        let (record, _) = parse(&json!({"type":"session_meta","payload":payload}));
        assert!(has(&record, "invalid_codex_history_boundary"));
    }
    let (record, _) = parse(
        &json!({"type":"response_item","metadata":{"user_input_order":1.5},"payload":item("user","x")}),
    );
    assert!(has(&record, "invalid_codex_input_order"));
    assert!(record.codex.unwrap().user_input_order.is_none());
    let (record, _) = parse(
        &json!({"type":"session_meta","payload":{"id":"s","cli_version":CODEX_ROLLOUT_BASELINE,"history_mode":"future-mode"}}),
    );
    assert!(has(&record, "unsupported_codex_history_mode"));
    let (record, _) = parse(&json!({"type":"event_msg","payload":{"type":"task_started"}}));
    assert!(has(&record, "invalid_codex_turn_identity"));
    let (record, _) = parse(
        &json!({"type":"response_item","payload":{"type":"message","role":"user","content":[],"internal_chat_message_metadata_passthrough":{"turn_id":"x".repeat(5000)}}}),
    );
    assert!(has(&record, "invalid_codex_turn_identity"));
    for resume in [
        json!({"last_started_turn_id":false}),
        json!({"turn_attribution":[]}),
        json!({"turn_attribution":{}}),
    ] {
        let (record, _) = parse(
            &json!({"type":"compacted","payload":{"message":"s","replacement_history":[],"resume_metadata":resume}}),
        );
        assert!(has(&record, "invalid_compaction_checkpoint"));
    }
}
