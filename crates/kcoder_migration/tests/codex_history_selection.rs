use kcoder_migration::{
    history_codex::select_codex_history,
    history_normalization::{HISTORY_NORMALIZATION_REVISION, HistoryNormalizer},
    history_records::CODEX_ROLLOUT_BASELINE,
};
use kcoder_state::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;

fn prepare(root: &Path, records: Vec<Value>) -> ExternalHistoryReader {
    let mut bytes = Vec::new();
    for record in records {
        serde_json::to_writer(&mut bytes, &record).unwrap();
        bytes.push(b'\n');
    }
    let snapshot = ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "owned-fixture".into(),
            source_session_id: "s1".into(),
            source_format: "synthetic-codex-jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        source_bytes: bytes.len() as u64,
        source_sha256: format!("{:x}", Sha256::digest(&bytes)),
        record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
    };
    let store = ExternalHistoryStore::open(root).unwrap();
    let mut job = store.begin("codex-select", &snapshot).unwrap();
    job.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = job.finish(&mut |_| true).unwrap().receipt;
    let mut normalizer =
        HistoryNormalizer::open(store.reader(&receipt.archive_id).unwrap()).unwrap();
    while !normalizer.progress().unwrap().normalization_complete {
        normalizer.step(10, |_| true).unwrap();
    }
    drop(normalizer);
    store.reader(&receipt.archive_id).unwrap()
}
fn session(mode: &str) -> Value {
    json!({"type":"session_meta","payload":{"id":"s1","session_id":"s1","cli_version":CODEX_ROLLOUT_BASELINE,"history_mode":mode}})
}
fn content(role: &str, text: &str, turn: &str) -> Value {
    json!({"type":"message","role":role,"content":[{"type":"input_text","text":text}],"internal_chat_message_metadata_passthrough":{"turn_id":turn}})
}
fn response(role: &str, text: &str, turn: &str) -> Value {
    json!({"type":"response_item","payload":content(role,text,turn)})
}
fn event(kind: &str, turn: &str) -> Value {
    json!({"type":"event_msg","payload":{"type":kind,"turn_id":turn}})
}
fn rollback(turns: u64) -> Value {
    json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":turns}})
}
fn compact(items: Vec<Value>, window: u64) -> Value {
    json!({"type":"compacted","payload":{"message":"summary","replacement_history":items,"window_number":window}})
}

#[test]
fn rollback_removes_real_user_turns_and_their_context_prefix_but_keeps_base_context() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            session("legacy"),
            response("system", "old identity", "t0"),
            response("developer", "persistent base", "t0"),
            response("user", "first request", "t1"),
            response("assistant", "first answer", "t1"),
            response(
                "user",
                "<environment_context>second-turn update</environment_context>",
                "t2",
            ),
            response(
                "developer",
                "<model_switch>different model</model_switch>",
                "t2",
            ),
            response("user", "second request", "t2"),
            response("assistant", "second answer", "t2"),
            rollback(1),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(selection.complete_window());
    assert_eq!(
        selection
            .items()
            .iter()
            .map(|item| item.record)
            .collect::<Vec<_>>(),
        [2, 3, 4]
    );
    assert_eq!(selection.checkpoint(), None);
    assert_eq!(index.progress().unwrap().source_records, 10);
}

#[test]
fn acceptance_order_removes_queued_assistant_output_and_calls_recorded_before_removed_input() {
    let root = tempfile::tempdir().unwrap();
    let mut records = vec![
        session("legacy"),
        response("user", "keep", "t1"),
        response("assistant", "keep answer", "t1"),
        response("assistant", "queued answer", "t1"),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"write","arguments":"{\"path\":\"NEVER_EXECUTE\"}"}}),
        response("user", "queued request", "t1"),
        response("assistant", "late answer", "t1"),
        rollback(1),
    ];
    for at in [1, 2] {
        records[at]["metadata"] = json!({"user_input_order":1});
    }
    for at in [3, 4, 5, 6] {
        records[at]["metadata"] = json!({"user_input_order":2});
    }
    let reader = prepare(root.path(), records);
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(selection.complete_window());
    assert_eq!(
        selection
            .items()
            .iter()
            .map(|item| item.record)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert!(!root.path().join("NEVER_EXECUTE").exists());
}

#[test]
fn first_turn_rollback_only_omits_resettable_developer_blocks_without_rewriting_source() {
    let root = tempfile::tempdir().unwrap();
    let developer = json!({"type":"response_item","payload":{"type":"message","role":"developer",
        "internal_chat_message_metadata_passthrough":{"turn_id":"t1"},"content":[
            {"type":"input_text","text":"persistent developer text"},
            {"type":"input_text","text":format!("{}<MODEL_SWITCH>old model</MODEL_SWITCH>","\u{2003}".repeat(2000))},
            {"type":"input_text","text":"<persistent_mode>old mode</persistent_mode>"}]}});
    let reader = prepare(
        root.path(),
        vec![
            session("legacy"),
            developer,
            response("user", "remove first turn", "t1"),
            response("assistant", "remove answer", "t1"),
            rollback(u64::MAX),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(selection.complete_window());
    assert_eq!(selection.items().len(), 1);
    assert_eq!(selection.items()[0].record, 1);
    assert_eq!(selection.items()[0].omitted_blocks, [1, 2]);
    let HistoricalRecordData::Message { blocks, .. } = selection.item(&index, 0).unwrap() else {
        panic!("message expected")
    };
    assert_eq!(blocks.len(), 1);
    let HistoricalBlock::Text { value } = &blocks[0] else {
        panic!("text expected")
    };
    assert_eq!(value.preview.as_deref(), Some("persistent developer text"));
    let HistoricalRecordData::Message { blocks, .. } = index.record(1).unwrap().data else {
        panic!("message expected")
    };
    assert_eq!(blocks.len(), 3);
}

#[test]
fn paginated_checkpoint_and_newer_rollback_keep_the_replacement_base() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            session("paginated"),
            response("user", "raw pre-compaction content", "t1"),
            compact(
                vec![
                    content("user", "retained first request", "t1"),
                    content("assistant", "compacted first answer", "t1"),
                ],
                1,
            ),
            event("task_started", "t2"),
            response("user", "remove newer request", "t2"),
            response("assistant", "remove newer answer", "t2"),
            event("task_complete", "t2"),
            rollback(1),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(selection.complete_window());
    assert_eq!(selection.checkpoint(), Some(2));
    assert_eq!(
        selection
            .items()
            .iter()
            .map(|item| (item.record, item.replacement_index))
            .collect::<Vec<_>>(),
        [(2, Some(0)), (2, Some(1))]
    );
    let HistoricalRecordData::Message { blocks, .. } = selection.item(&index, 1).unwrap() else {
        panic!("message expected")
    };
    assert!(
        matches!(&blocks[0],HistoricalBlock::Text {value} if value.preview.as_deref()==Some("compacted first answer"))
    );
}

#[test]
fn a_checkpoint_in_a_rolled_back_turn_does_not_replace_a_surviving_older_checkpoint() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            session("legacy"),
            event("task_started", "t1"),
            response("user", "first", "t1"),
            compact(
                vec![
                    content("user", "first", "t1"),
                    content("assistant", "surviving summary", "t1"),
                ],
                1,
            ),
            event("task_complete", "t1"),
            event("turn_started", "t2"),
            response("user", "second", "t2"),
            compact(
                vec![content(
                    "user",
                    "incorrect replacement after rollback",
                    "t2",
                )],
                2,
            ),
            response("assistant", "second answer", "t2"),
            event("task_complete", "t1"),
            event("turn_complete", "t2"),
            event("task_started", "automatic"),
            json!({"type":"turn_context","payload":{"turn_id":"automatic"}}),
            response(
                "user",
                "<environment_context>context only</environment_context>",
                "automatic",
            ),
            event("task_complete", "automatic"),
            rollback(1),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(selection.complete_window());
    assert_eq!(selection.checkpoint(), Some(3));
    assert_eq!(
        selection
            .items()
            .iter()
            .map(|item| (item.record, item.replacement_index))
            .collect::<Vec<_>>(),
        [(3, Some(0)), (3, Some(1))]
    );
}

#[test]
fn incomplete_latest_compaction_never_silently_uses_an_older_boundary_as_complete() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            session("paginated"),
            event("task_started", "t1"),
            response("user", "old", "t1"),
            compact(vec![content("user", "old", "t1")], 1),
            event("task_complete", "t1"),
            event("task_started", "t2"),
            response("user", "new", "t2"),
            json!({"type":"compacted","payload":{"message":"legacy summary","window_number":2}}),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(!selection.complete_window());
    assert!(
        selection
            .issues()
            .contains("legacy_codex_compaction_unresolved")
    );
    assert!(selection.issues().contains("source_records_require_review"));
    assert_eq!(selection.source_records_with_diagnostics(), 1);
}

#[test]
fn unresolved_external_prefix_and_unknown_records_stay_explicit_without_following_source_ids() {
    let root = tempfile::tempdir().unwrap();
    let mut meta = session("paginated");
    meta["payload"]["history_base"] =
        json!({"thread_id":"../../never-follow","end_ordinal_exclusive":1,"end_byte_offset":100});
    let reader = prepare(
        root.path(),
        vec![
            meta,
            response("user", "local suffix", "t1"),
            json!({"type":"future_private_record","payload":{"untrusted":"data"}}),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(!selection.complete_window());
    assert!(selection.issues().contains("codex_history_base_unresolved"));
    assert!(selection.issues().contains("source_records_require_review"));
    assert_eq!(selection.source_records_with_diagnostics(), 2);
    assert_eq!(selection.items().len(), 1);
}

#[test]
fn selection_is_stable_bound_to_its_archive_and_cancelled_before_or_during_replay() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            session("legacy"),
            response("user", "first", "t1"),
            response("assistant", "answer", "t1"),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selected = select_codex_history(&index, |_| true).unwrap();
    let again = select_codex_history(&index, |_| true).unwrap();
    assert_eq!(selected.selection_sha256(), again.selection_sha256());
    assert_eq!(selected.items(), again.items());
    assert!(select_codex_history(&index, |_| false).is_err());
    let mut checks = 0;
    assert!(
        select_codex_history(&index, |_| {
            checks += 1;
            checks < 5
        })
        .is_err()
    );
    assert!(checks >= 4);
    let other_root = tempfile::tempdir().unwrap();
    let other = prepare(
        other_root.path(),
        vec![session("legacy"), response("user", "different", "t1")],
    );
    let other_index = other
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert!(selected.item(&other_index, 0).is_err());
    assert!(selected.item(&index, usize::MAX).is_err());
}

#[test]
fn absent_session_header_does_not_falsely_certify_a_source_version() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            response("user", "request without a header", "t1"),
            rollback(0),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(!selection.complete_window());
    assert!(
        selection
            .issues()
            .contains("codex_session_metadata_missing")
    );
    assert_eq!(selection.items().len(), 1);
}

#[test]
fn partial_subagent_initialization_is_not_a_complete_window() {
    let root = tempfile::tempdir().unwrap();
    let mut meta = session("paginated");
    meta["payload"]["subagent_history_start_ordinal"] = 10.into();
    meta["ordinal"] = 0.into();
    let mut input = response("user", "inherited input only", "t1");
    input["ordinal"] = 1.into();
    let reader = prepare(root.path(), vec![meta, input]);
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selection = select_codex_history(&index, |_| true).unwrap();
    assert!(!selection.complete_window());
    assert!(
        selection
            .issues()
            .contains("codex_child_history_incomplete")
    );
    assert_eq!(selection.items().len(), 1);
}

#[test]
fn readable_reconstruction_uses_original_messages_and_respects_rollback() {
    use kcoder_migration::history_codex::reconstruct_readable_history;
    let root = tempfile::tempdir().unwrap();
    let mut records = vec![
        session("paginated"),
        response("user", "keep request", "t1"),
        response("assistant", "keep answer", "t1"),
        response(
            "user",
            "<environment_context>untrusted source instructions</environment_context>",
            "t1",
        ),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"old-call","name":"write","arguments":"{\"path\":\"NEVER_EXECUTE\"}"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"old-call","output":"recorded result"}}),
        compact(
            vec![json!({"type":"compaction","id":"opaque","encrypted_content":"OPAQUE-CANARY"})],
            1,
        ),
        response("user", "rolled back", "t2"),
        response("assistant", "rolled back answer", "t2"),
        rollback(1),
        response("user", "new request", "t3"),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let reader = prepare(root.path(), records);
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let original = select_codex_history(&index, |_| true).unwrap();
    assert!(!original.complete_window());
    let reconstructed = reconstruct_readable_history(&index, |_| true).unwrap();
    assert_eq!(reconstructed.opaque_checkpoints(), 1);
    assert_eq!(
        reconstructed.selection_sha256(),
        reconstruct_readable_history(&index, |_| true)
            .unwrap()
            .selection_sha256()
    );
    assert!(matches!(
        reconstructed.tool_record(&index, 1),
        Ok(HistoricalRecordData::Message {
            role: HistoricalRole::Tool,
            ..
        })
    ));
    assert_eq!(
        reconstructed.source_fingerprint(),
        index.source_fingerprint()
    );
    assert_eq!(
        reconstructed
            .items()
            .iter()
            .map(|item| item.record)
            .collect::<Vec<_>>(),
        [1, 2, 10]
    );
    assert_eq!(
        reconstructed
            .tool_records()
            .iter()
            .map(|item| item.record)
            .collect::<Vec<_>>(),
        [4, 5]
    );
    assert!(!root.path().join("NEVER_EXECUTE").exists());
    let other_root = tempfile::tempdir().unwrap();
    let other_reader = prepare(
        other_root.path(),
        vec![session("paginated"), response("user", "other source", "t1")],
    );
    let other_index = other_reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert!(reconstructed.item(&other_index, 0).is_err());
    assert!(reconstructed.tool_record(&other_index, 0).is_err());
    assert!(matches!(
        reconstructed.item(&index, 0),
        Ok(HistoricalRecordData::Message {
            role: HistoricalRole::User,
            ..
        })
    ));
    assert!(
        reconstructed
            .items()
            .iter()
            .all(|item| item.replacement_index.is_none())
    );
    assert!(!root.path().join("OPAQUE-CANARY").exists());
}

#[test]
fn readable_reconstruction_refuses_gaps_and_unknown_checkpoint_items() {
    use kcoder_migration::history_codex::reconstruct_readable_history;
    for (gap, kind, encrypted) in [
        (false, "unknown_checkpoint_item", json!("cipher")),
        (true, "compaction", json!("cipher")),
        (false, "compaction", json!("")),
        (false, "compaction", json!({"bad": true})),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut records = vec![
            session("paginated"),
            response("user", "request", "t1"),
            compact(vec![json!({"type":kind,"encrypted_content":encrypted})], 1),
        ];
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal + usize::from(gap && ordinal == 1));
        }
        let reader = prepare(root.path(), records);
        let index = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        let error = match reconstruct_readable_history(&index, |_| true) {
            Ok(_) => panic!("unsafe reconstruction was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().starts_with("history_reconstruction_"));
    }
}

#[test]
fn readable_reconstruction_omits_verified_old_tool_declarations_without_executing_them() {
    use kcoder_migration::history_codex::{
        reconstruct_readable_history, reconstruct_readable_history_with_tool_declarations,
    };
    let root = tempfile::tempdir().unwrap();
    let mut records = vec![
        session("paginated"),
        response("user", "original request", "t1"),
        response("assistant", "original answer", "t1"),
        compact(
            vec![
                json!({"type":"additional_tools","role":"developer","id":"tools-1","tools":[{"name":"OLD_TOOL_SECRET","command":"NEVER_EXECUTE","description":"x".repeat(100_000)}]}),
                json!({"type":"compaction","id":"opaque","encrypted_content":"OPAQUE-CANARY"}),
            ],
            1,
        ),
        response("user", "continue", "t2"),
    ];
    for (ordinal, record) in records.iter_mut().enumerate() {
        record["ordinal"] = json!(ordinal);
    }
    let reader = prepare(root.path(), records);
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert!(reconstruct_readable_history(&index, |_| true).is_err());
    let reconstructed =
        reconstruct_readable_history_with_tool_declarations(&index, &reader, |_| true).unwrap();
    assert_eq!(reconstructed.opaque_checkpoints(), 1);
    assert_eq!(reconstructed.omitted_tool_declarations(), 1);
    assert_eq!(
        reconstructed
            .items()
            .iter()
            .map(|item| item.record)
            .collect::<Vec<_>>(),
        [1, 2, 4]
    );
    assert!(reconstructed.tool_records().is_empty());
    assert!(!root.path().join("NEVER_EXECUTE").exists());
    let other = tempfile::tempdir().unwrap();
    let other_reader = prepare(
        other.path(),
        vec![session("paginated"), response("user", "other", "t1")],
    );
    assert!(
        reconstruct_readable_history_with_tool_declarations(&index, &other_reader, |_| true)
            .is_err()
    );
}

#[test]
fn readable_reconstruction_rejects_unverified_old_tool_declaration_shapes() {
    use kcoder_migration::history_codex::reconstruct_readable_history_with_tool_declarations;
    let variants = [
        json!({"type":"additional_tools","role":"user","id":"x","tools":[{}]}),
        json!({"type":"additional_tools","role":"developer","id":"x","tools":[{}],"extra":"unknown"}),
        json!({"type":"additional_tools","role":"developer","id":"x","tools":["not an object"]}),
        json!({"type":"additional_tools","role":"developer","id":"x","tools":[{"description":"x".repeat(1024 * 1024)}]}),
    ];
    for extra in variants {
        let root = tempfile::tempdir().unwrap();
        let mut records = vec![
            session("paginated"),
            response("user", "request", "t1"),
            compact(
                vec![
                    extra,
                    json!({"type":"compaction","id":"opaque","encrypted_content":"cipher"}),
                ],
                1,
            ),
        ];
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        let reader = prepare(root.path(), records);
        let index = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        let error =
            match reconstruct_readable_history_with_tool_declarations(&index, &reader, |_| true) {
                Ok(_) => panic!("unverified tool declaration was accepted"),
                Err(error) => error,
            };
        assert!(error.to_string().starts_with("history_reconstruction_"));
    }
}

#[test]
fn readable_reconstruction_omits_a_verified_top_level_tool_declaration() {
    use kcoder_migration::history_codex::{
        reconstruct_readable_history, reconstruct_readable_history_with_tool_declarations,
    };
    for declaration in [
        json!({"type":"additional_tools","role":"developer","id":"tools-1","tools":[{"name":"OLD_TOOL_SECRET"}]}),
        json!({"type":"additional_tools","role":"developer","tools":[]}),
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut records = vec![
            session("paginated"),
            json!({"type":"response_item","payload":declaration}),
            response("user", "real request", "t1"),
            response("assistant", "real answer", "t1"),
        ];
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        let reader = prepare(root.path(), records);
        let index = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        assert!(reconstruct_readable_history(&index, |_| true).is_err());
        let selected =
            reconstruct_readable_history_with_tool_declarations(&index, &reader, |_| true).unwrap();
        assert_eq!(selected.opaque_checkpoints(), 0);
        assert_eq!(selected.omitted_tool_declarations(), 1);
        assert_eq!(
            selected
                .items()
                .iter()
                .map(|item| item.record)
                .collect::<Vec<_>>(),
            [2, 3]
        );
    }
}

#[test]
fn guardian_snapshot_must_match_distinct_earlier_source_items_in_order() {
    use kcoder_migration::history_codex::reconstruct_readable_history_with_tool_declarations;
    for scenario in [
        "matched",
        "opaque_reasoning",
        "invalid_reasoning",
        "modified_assistant",
        "unknown",
        "duplicate",
        "reordered",
        "future",
        "other_invalid",
        "rollback",
    ] {
        let root = tempfile::tempdir().unwrap();
        let user = content("user", "original user request", "t1");
        let assistant = content("assistant", "original answer", "t1");
        let mut same_user = user.clone();
        same_user["id"] = json!("different-id");
        same_user["internal_chat_message_metadata_passthrough"] = json!({"turn_id":"different"});
        let mut same_assistant = assistant.clone();
        same_assistant["id"] = json!("different-assistant-id");
        same_assistant["internal_chat_message_metadata_passthrough"] =
            json!({"turn_id":"different"});
        let mut reasoning = json!({"type":"reasoning","id":"old","content":null,"encrypted_content":"cipher","summary":[{"type":"summary_text","text":"PRIVATE_REASONING"}]});
        if scenario == "invalid_reasoning" {
            reasoning["unexpected"] = json!("must not discard");
        }
        if scenario == "modified_assistant" {
            same_assistant["content"][0]["text"] = json!("modified");
        }
        let mut checkpoint = compact(
            vec![json!({"type":"compaction","id":"opaque","encrypted_content":"cipher"})],
            1,
        );
        checkpoint["payload"]["guardian_history"] = match scenario {
            "matched" => json!([same_user, assistant]),
            "opaque_reasoning" | "invalid_reasoning" | "modified_assistant" => {
                json!([same_user, reasoning, same_assistant])
            }
            "unknown" => {
                json!([same_user, {"type":"message","role":"user","content":[{"type":"input_text","text":"not in the source"}]}])
            }
            "duplicate" => json!([same_user, same_user]),
            "reordered" => json!([assistant, same_user]),
            "future" => {
                json!([{"type":"message","role":"user","content":[{"type":"input_text","text":"future message"}]}])
            }
            "other_invalid" | "rollback" => json!([same_user, assistant]),
            _ => unreachable!(),
        };
        if scenario == "other_invalid" {
            checkpoint["payload"]["retained_context"] = json!([]);
        }
        let mut records = vec![
            session("paginated"),
            json!({"type":"response_item","payload":user}),
            json!({"type":"response_item","payload":assistant}),
            checkpoint,
            response("user", "future message", "t2"),
        ];
        if scenario == "rollback" {
            records.insert(3, rollback(1));
        }
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        let reader = prepare(root.path(), records);
        let index = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        let result = reconstruct_readable_history_with_tool_declarations(&index, &reader, |_| true);
        if scenario == "matched" || scenario == "opaque_reasoning" {
            let selected = result.unwrap();
            assert_eq!(selected.verified_guardian_snapshots(), 1);
            assert_eq!(
                selected
                    .items()
                    .iter()
                    .map(|item| item.record)
                    .collect::<Vec<_>>(),
                [1, 2, 4]
            );
        } else {
            assert!(
                result.is_err(),
                "unsafe guardian scenario accepted: {scenario}"
            );
        }
    }
}

#[test]
fn readable_reconstruction_validates_historical_search_records() {
    use kcoder_migration::history_codex::{
        reconstruct_readable_history, reconstruct_readable_history_with_tool_declarations,
    };
    for scenario in [
        "valid",
        "unknown_action",
        "extra_field",
        "bad_execution",
        "too_large",
    ] {
        let root = tempfile::tempdir().unwrap();
        let mut web = json!({"type":"web_search_call","id":"ws","status":"completed","action":{"type":"search","query":"PRIVATE_QUERY"}});
        let mut call = json!({"type":"tool_search_call","call_id":"c","status":"completed","execution":"client","arguments":{"query":"PRIVATE_SEARCH"}});
        let output = json!({"type":"tool_search_output","call_id":"c","status":"completed","execution":"client","tools":[{"name":"OLD_TOOL_SECRET"}]});
        match scenario {
            "unknown_action" => web["action"]["type"] = json!("unknown"),
            "extra_field" => web["extra"] = json!(true),
            "bad_execution" => call["execution"] = json!("unknown"),
            "too_large" => web["action"]["query"] = json!("x".repeat(1024 * 1024)),
            _ => {}
        }
        let mut records = vec![
            session("paginated"),
            response("user", "request", "t1"),
            json!({"type":"response_item","payload":web}),
            json!({"type":"response_item","payload":call}),
            json!({"type":"response_item","payload":output}),
            response("assistant", "answer", "t1"),
        ];
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
        }
        let reader = prepare(root.path(), records);
        let index = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        assert!(reconstruct_readable_history(&index, |_| true).is_err());
        let result = reconstruct_readable_history_with_tool_declarations(&index, &reader, |_| true);
        if scenario == "valid" {
            let selected = result.unwrap();
            assert_eq!(selected.inert_search_records(), 3);
            assert_eq!(
                selected
                    .tool_records()
                    .iter()
                    .map(|item| item.record)
                    .collect::<Vec<_>>(),
                [2, 3, 4]
            );
            assert_eq!(
                selected
                    .items()
                    .iter()
                    .map(|item| item.record)
                    .collect::<Vec<_>>(),
                [1, 5]
            );
        } else {
            assert!(result.is_err(), "unsafe search record accepted: {scenario}");
        }
    }
}
