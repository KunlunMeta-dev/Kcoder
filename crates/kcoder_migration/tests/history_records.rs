use kcoder_migration::history_records::{
    CLAUDE_TRANSCRIPT_BASELINE, CODEX_ROLLOUT_BASELINE, parse_reader, parse_record,
};
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn parse(source: MigrationSourceKind, value: Value) -> HistoricalRecord {
    parse_reader(source, 4, &serde_json::to_vec(&value).unwrap()[..], |_| {
        true
    })
    .unwrap()
}

#[test]
fn structural_fixtures_record_the_pinned_upstream_versions_without_claiming_native_acceptance() {
    let baseline: Value =
        serde_json::from_str(include_str!("../fixtures/history-format-baselines.json")).unwrap();
    assert_eq!(baseline["codex"]["version"], CODEX_ROLLOUT_BASELINE);
    assert_eq!(
        baseline["claudeCode"]["version"],
        CLAUDE_TRANSCRIPT_BASELINE
    );
    assert_eq!(baseline["nativeSourceAcceptance"], false);
    for source in ["codex", "claudeCode"] {
        assert_eq!(baseline[source]["commit"].as_str().unwrap().len(), 40);
        for witness in baseline[source]["files"].as_array().unwrap() {
            assert_eq!(witness["sha256"].as_str().unwrap().len(), 64);
            assert!(!witness["path"].as_str().unwrap().contains(".."));
        }
    }
}

#[test]
fn claude_tool_results_do_not_become_human_messages_and_mixed_blocks_keep_order() {
    let common = json!({"type":"user","uuid":"m2","parentUuid":"m1","sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE,
        "timestamp":"2026-10-16T10:00:00Z","message":{"role":"user","content":[
            {"type":"text","text":"please continue"},{"type":"tool_result","tool_use_id":"call1","content":"failed","is_error":true}]}});
    let record = parse(MigrationSourceKind::ClaudeCode, common.clone());
    assert_eq!(record.source_id.as_deref(), Some("m2"));
    assert_eq!(record.parent_id.as_deref(), Some("m1"));
    let HistoricalRecordData::Message { role, blocks, .. } = record.data else {
        panic!("message expected")
    };
    assert_eq!(role, HistoricalRole::User);
    assert!(matches!(&blocks[0], HistoricalBlock::Text { .. }));
    assert!(
        matches!(&blocks[1],HistoricalBlock::ToolResult {call_id,outcome:HistoricalToolOutcome::RecordedError,..} if call_id=="call1")
    );
    let mut only = common;
    only["message"]["content"] = json!([{"type":"tool_result","tool_use_id":"call1","content":[{"type":"text","text":"done"}]}]);
    let record = parse(MigrationSourceKind::ClaudeCode, only);
    let HistoricalRecordData::Message { role, blocks, .. } = record.data else {
        panic!("message expected")
    };
    assert_eq!(role, HistoricalRole::Tool);
    assert!(
        matches!(&blocks[0],HistoricalBlock::ToolResult {outcome:HistoricalToolOutcome::RecordedResult,output,..} if output.encoding==HistoricalValueEncoding::Json)
    );
}

#[test]
fn codex_preserves_function_arguments_and_freeform_inputs_without_replaying_them() {
    for (kind, field, input) in [
        (
            "function_call",
            "arguments",
            r#"{"path":"file.txt","content":"hello"}"#,
        ),
        (
            "custom_tool_call",
            "input",
            "*** Begin Patch\nfreeform input\n*** End Patch",
        ),
    ] {
        let mut payload =
            json!({"type":kind,"call_id":"call1","name":"write","namespace":"office"});
        payload[field] = input.into();
        let record = parse(
            MigrationSourceKind::Codex,
            json!({"type":"response_item","payload":payload}),
        );
        let HistoricalRecordData::Message { role, blocks, .. } = record.data else {
            panic!("message expected")
        };
        assert_eq!(role, HistoricalRole::Assistant);
        let HistoricalBlock::ToolCall {
            call_id,
            name,
            namespace,
            source_type,
            input: value,
            ..
        } = &blocks[0]
        else {
            panic!("tool call expected")
        };
        assert_eq!(call_id, "call1");
        assert_eq!(name, "write");
        assert_eq!(namespace.as_deref(), Some("office"));
        assert_eq!(source_type.as_deref(), Some(kind));
        assert_eq!(value.preview.as_deref(), Some(input));
        assert!(value.encoding == HistoricalValueEncoding::JsonString);
    }
}

#[test]
fn received_codex_output_is_not_falsely_marked_as_success() {
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":"Process exited with code 1"}}),
    );
    let HistoricalRecordData::Message { role, blocks, .. } = record.data else {
        panic!("message expected")
    };
    assert_eq!(role, HistoricalRole::Tool);
    assert!(matches!(
        &blocks[0],
        HistoricalBlock::ToolResult {
            outcome: HistoricalToolOutcome::RecordedResult,
            ..
        }
    ));
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"event_msg","payload":{"type":"exec_command_end","call_id":"call1","exit_code":-9}}),
    );
    assert!(matches!(
        record.data,
        HistoricalRecordData::Event {
            outcome: Some(HistoricalToolOutcome::RecordedError),
            ..
        }
    ));
}

#[test]
fn an_unrecognized_tool_namespace_is_not_silently_treated_as_an_unqualified_call() {
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"write","namespace":{"future":"namespace"},"arguments":"{}"}}),
    );
    assert!(record.diagnostics.iter().any(|issue| issue.code
        == "unsupported_historical_tool_namespace"
        && issue.blocks_continuation));
    assert!(matches!(record.data, HistoricalRecordData::Message { .. }));
}

#[test]
fn empty_claude_message_or_session_identity_keeps_a_blocking_diagnostic() {
    for (id, session) in [("", "s1"), ("m", "")] {
        let record = parse(
            MigrationSourceKind::ClaudeCode,
            json!({"type":"assistant","uuid":id,"sessionId":session,"version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"content":"retained text"}}),
        );
        assert!(
            record
                .diagnostics
                .iter()
                .any(|issue| issue.code == "missing_source_message_identity"
                    && issue.blocks_continuation)
        );
        assert!(matches!(record.data, HistoricalRecordData::Message { .. }));
    }
}

#[test]
fn encrypted_reasoning_and_signatures_have_no_plaintext_preview() {
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"visible summary"}],"encrypted_content":"OPAQUE-CANARY"}}),
    );
    let encoded = serde_json::to_string(&record).unwrap();
    assert!(!encoded.contains("OPAQUE-CANARY"));
    assert!(encoded.contains("visible summary"));
    let record = parse(
        MigrationSourceKind::ClaudeCode,
        json!({"type":"assistant","uuid":"m","sessionId":"s","version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"content":[{"type":"thinking","thinking":"visible thought","signature":"OPAQUE-CANARY"}]}}),
    );
    let encoded = serde_json::to_string(&record).unwrap();
    assert!(!encoded.contains("OPAQUE-CANARY"));
    assert!(encoded.contains("thinking_signature"));
}

#[test]
fn source_boundaries_remain_explicit_without_product_version_gates() {
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"session_meta","payload":{"id":"s","session_id":"s","cli_version":CODEX_ROLLOUT_BASELINE,"cwd":"C:\\project","history_mode":"paginated","history_base":{"thread_id":"parent","end_ordinal_exclusive":12,"end_byte_offset":400}}}),
    );
    assert!(
        record
            .diagnostics
            .iter()
            .any(|d| d.code == "source_history_base_required" && d.blocks_continuation)
    );
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"session_meta","payload":{"id":"s","cli_version":"999.0.0"}}),
    );
    assert!(
        record
            .diagnostics
            .iter()
            .all(|d| d.code != "unsupported_codex_source_version")
    );
    let record = parse(
        MigrationSourceKind::Codex,
        json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":2}}),
    );
    assert!(matches!(
        record.data,
        HistoricalRecordData::Boundary {
            rollback_turns: Some(2),
            ..
        }
    ));
    let record = parse(
        MigrationSourceKind::ClaudeCode,
        json!({"type":"system","subtype":"compact_boundary","uuid":"compact","logicalParentUuid":"before","parentUuid":null}),
    );
    assert_eq!(record.logical_parent_id.as_deref(), Some("before"));
    assert_eq!(record.parent_id, None);
    assert!(matches!(record.data, HistoricalRecordData::Boundary { .. }));
}

#[test]
fn supplemental_events_are_not_a_second_assistant_reply() {
    let event = parse(
        MigrationSourceKind::Codex,
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"same answer"}}),
    );
    let message = parse(
        MigrationSourceKind::Codex,
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"same answer"}]}}),
    );
    assert!(matches!(event.data, HistoricalRecordData::Event { .. }));
    assert!(
        matches!(message.data,HistoricalRecordData::Message {phase:Some(ref phase),..} if phase=="final_answer")
    );
}

#[test]
fn malformed_records_remain_unknown_and_io_or_cancellation_is_not_hidden() {
    let record = parse(MigrationSourceKind::Codex, json!({"type":"response_item"}));
    assert!(record.diagnostics.iter().any(|d| d.blocks_continuation));
    assert!(matches!(record.data, HistoricalRecordData::Unknown { .. }));
    let record = parse(
        MigrationSourceKind::ClaudeCode,
        json!({"type":"assistant","uuid":"m","sessionId":"s","message":{"content":null}}),
    );
    assert!(
        record
            .diagnostics
            .iter()
            .any(|d| d.code == "invalid_source_message_content")
    );
    assert!(parse_reader(MigrationSourceKind::Codex, 0, &b"{}"[..], |_| false).is_err());
    struct Broken;
    impl std::io::Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("owned I/O failure"))
        }
    }
    assert!(parse_reader(MigrationSourceKind::Codex, 0, Broken, |_| true).is_err());
}

#[test]
fn large_tool_outputs_are_normalized_from_the_private_archive_as_bounded_references() {
    let root = tempfile::tempdir().unwrap();
    let text = "x".repeat(8 * 1024 * 1024);
    let value = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call1","output":text}});
    let bytes = serde_json::to_vec(&value).unwrap();
    let snapshot = ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "fixture".into(),
            source_session_id: "s".into(),
            source_format: "codex-rollout/v1".into(),
            adapter_revision: "records/1".into(),
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
    let store = kcoder_state::external_history::ExternalHistoryStore::open(root.path()).unwrap();
    let mut import = store.begin("record", &snapshot).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let reader = store.reader(&receipt.archive_id).unwrap();
    let record = parse_record(&reader, 0, |_| true).unwrap();
    assert!(serde_json::to_vec(&record).unwrap().len() < 16 * 1024);
    let HistoricalRecordData::Message { blocks, .. } = record.data else {
        panic!("message expected")
    };
    let HistoricalBlock::ToolResult { output, .. } = &blocks[0] else {
        panic!("result expected")
    };
    assert_eq!(output.decoded_bytes, Some(8 * 1024 * 1024));
    assert_eq!(output.preview.as_ref().unwrap().len(), 4096);
    assert_eq!(
        output.decoded_sha256.as_deref(),
        Some(format!("{:x}", Sha256::digest(text.as_bytes())).as_str())
    );
}

#[test]
fn product_versions_are_provenance_while_actual_record_shapes_are_validated() {
    for version in [Some("2.1.191"), Some("999.0.0"), None] {
        let mut value = json!({"type":"user","uuid":"u","parentUuid":null,"sessionId":"s", "message":{"role":"user","content":"keep historical input"}});
        if let Some(version) = version {
            value["version"] = json!(version);
        }
        let record = parse(MigrationSourceKind::ClaudeCode, value);
        assert_eq!(record.source_version.as_deref(), version);
        assert!(
            !record
                .diagnostics
                .iter()
                .any(|issue| issue.code == "unsupported_claude_source_version")
        );
        assert!(matches!(record.data, HistoricalRecordData::Message { .. }));
    }
    for version in [Some("0.1.0"), Some("999.0.0"), None] {
        let mut value = json!({"type":"session_meta","payload":{"id":"s"}});
        if let Some(version) = version {
            value["payload"]["cli_version"] = json!(version);
        }
        let record = parse(MigrationSourceKind::Codex, value);
        assert_eq!(record.source_version.as_deref(), version);
        assert!(
            !record
                .diagnostics
                .iter()
                .any(|issue| issue.code == "unsupported_codex_source_version")
        );
        assert!(matches!(record.data, HistoricalRecordData::Session { .. }));
    }
}

#[test]
fn historical_tool_identifiers_are_preserved_in_version_independent_records() {
    let source = parse(
        MigrationSourceKind::ClaudeCode,
        json!({"type":"assistant","uuid":"a","sessionId":"s","version":"2.1.191","message":{"role":"assistant","content":[{"type":"tool_use","id":"old","name":"Read","input":{"file_path":"source.txt"}}]}}),
    );
    let HistoricalRecordData::Message { blocks, .. } = source.data else {
        panic!("historical message expected")
    };
    assert!(matches!(&blocks[0],HistoricalBlock::ToolCall{name,..} if name=="Read"));
    let source = parse(
        MigrationSourceKind::Codex,
        json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"old","arguments":"{\"cmd\":\"read historical.txt\"}"}}),
    );
    let HistoricalRecordData::Message { blocks, .. } = source.data else {
        panic!("historical message expected")
    };
    assert!(matches!(&blocks[0],HistoricalBlock::ToolCall{name,..} if name=="exec_command"));
}
