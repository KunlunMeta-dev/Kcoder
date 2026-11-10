use kcoder_migration::{
    history_display::HistoryArchiveView, history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
};
use kcoder_types::{
    external_history::*, historical_display::*, imported_transcript::*,
    migration::MigrationSourceKind,
};
use serde_json::{Value, json};
use std::{fs, path::Path};
#[path = "history_display/search.rs"]
mod search;

struct Fixture {
    _profile: tempfile::TempDir,
    view: HistoryArchiveView,
    archive: std::path::PathBuf,
}
fn fixture(source: MigrationSourceKind, lines: Vec<Value>) -> Fixture {
    fixture_text(
        source,
        lines
            .into_iter()
            .map(|line| line.to_string() + "\n")
            .collect::<String>(),
    )
}
fn fixture_text(source: MigrationSourceKind, text: String) -> Fixture {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("selected.jsonl"), text).unwrap();
    let binding = HistorySourceBinding::capture(
        root.path(),
        Path::new("selected.jsonl"),
        ExternalHistoryOrigin {
            source,
            source_instance: "fixture".into(),
            source_session_id: "session".into(),
            source_artifact_id: None,
            source_format: "jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: Some("Original title".into()),
            created_at: None,
            updated_at: None,
            project: Some("original-project".into()),
            archived: false,
            parent_session_id: None,
        },
        &mut |_, _| true,
    )
    .unwrap();
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = store.create(&id, &binding).unwrap();
    for _ in 0..100 {
        if job.stage == HistoryImportStage::Normalized {
            break;
        }
        job = store.step(&id, job.sequence, 10, |_| true).unwrap();
    }
    assert_eq!(job.stage, HistoryImportStage::Normalized);
    let archive = profile
        .path()
        .join("external-history")
        .join(job.archive_id.unwrap());
    let view = HistoryArchiveView::open(store.archive_reader(&id).unwrap()).unwrap();
    Fixture {
        _profile: profile,
        view,
        archive,
    }
}
fn claude(blocks: Value) -> Value {
    json!({"type":"assistant","uuid":"message","sessionId":"session","version":"2.1.301","message":{"role":"assistant","content":blocks}})
}
fn full_text(view: &HistoryArchiveView, record: u64, index: u32) -> String {
    let mut offset = 0;
    let mut output = String::new();
    for _ in 0..100 {
        let chunk = view.text(record, index, offset, |_| true).unwrap();
        assert!(chunk.text.len() <= 64 * 1024);
        output.push_str(&chunk.text);
        match chunk.next_offset {
            Some(next) => {
                assert!(next > offset);
                offset = next;
            }
            None => return output,
        }
    }
    panic!("bounded fixture failed to finish")
}

#[test]
fn long_utf8_and_escaped_strings_round_trip_in_bounded_native_positions() {
    let text = "中文😀\\\n\t\"".repeat(25_000);
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([{"type":"text","text":text}]))],
    );
    let page = fixture.view.page(0, |_| true).unwrap();
    assert_eq!(page.title.as_deref(), Some("Original title"));
    let body = &page.items[0].blocks[0];
    assert!(body.preview.as_ref().unwrap().len() <= 512);
    assert_eq!(body.decoded_bytes, Some(text.len() as u64));
    assert_eq!(full_text(&fixture.view, 0, 0), text);
    assert!(fixture.view.text(0, 0, u64::MAX, |_| true).is_err());
    assert!(fixture.view.text(0, 99, 0, |_| true).is_err());
}

#[test]
fn surrogate_pairs_and_json_escape_tokens_are_not_split_at_chunk_boundaries() {
    let prefix = "x".repeat(64 * 1024 - 2);
    let raw = format!(
        "{{\"type\":\"assistant\",\"uuid\":\"m\",\"sessionId\":\"session\",\"message\":{{\"role\":\"assistant\",\"content\":\"{prefix}\\ud83d\\ude00\\u4e2d\\n\\\\\\\"\"}}}}\n"
    );
    let fixture = fixture_text(MigrationSourceKind::ClaudeCode, raw);
    assert_eq!(
        full_text(&fixture.view, 0, 0),
        format!("{prefix}😀中\n\\\"")
    );
}

#[test]
fn history_rows_and_block_lists_both_use_ten_item_pages_and_report_instead_of_hiding_unknown_records()
 {
    let blocks = (0..25)
        .map(|index| json!({"type":"text","text":format!("block-{index}")}))
        .collect::<Vec<_>>();
    let mut records = (0..24).map(|_| claude(json!(blocks))).collect::<Vec<_>>();
    records.push(json!({"type":"future-source-record","secret":"NO-UNKNOWN-PREVIEW"}));
    let fixture = fixture(MigrationSourceKind::ClaudeCode, records);
    let page = fixture.view.page(0, |_| true).unwrap();
    assert_eq!(page.items.len(), 10);
    assert_eq!(page.next_cursor, Some(10));
    assert_eq!(page.items[0].blocks.len(), 10);
    assert_eq!(page.items[0].total_blocks, 25);
    assert_eq!(page.items[0].next_block_cursor, Some(10));
    let next = fixture.view.blocks(0, 10, |_| true).unwrap();
    assert_eq!(next.blocks.len(), 10);
    assert_eq!(next.next_cursor, Some(20));
    assert_eq!(
        fixture.view.blocks(0, 20, |_| true).unwrap().blocks.len(),
        5
    );
    let final_page = fixture.view.page(20, |_| true).unwrap();
    assert_eq!(final_page.items.len(), 5);
    assert!(final_page.next_cursor.is_none());
    assert!(final_page.items.last().unwrap().kind == HistoricalDisplayKind::Unknown);
    assert!(
        !serde_json::to_string(&final_page)
            .unwrap()
            .contains("NO-UNKNOWN-PREVIEW")
    );
}

#[test]
fn historical_tools_keep_original_names_and_unknown_outcomes_without_executing_or_exposing_opaque_payloads()
 {
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![
            claude(json!([
                {"type":"tool_use","id":"call","name":"Bash","input":{"command":"echo historical-only"}},
                {"type":"thinking","thinking":"Visible source thought","signature":"OPAQUE-SIGNATURE-CANARY"},
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"ATTACHMENT-CANARY"}},
            ])),
            json!({"type":"user","uuid":"result","sessionId":"session","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"Old result without execution status"}]}}),
        ],
    );
    let page = fixture.view.page(0, |_| true).unwrap();
    assert_eq!(page.items[0].blocks[0].name.as_deref(), Some("Bash"));
    assert_eq!(
        full_text(&fixture.view, 0, 0),
        r#"{"command":"echo historical-only"}"#
    );
    assert_eq!(full_text(&fixture.view, 0, 1), "Visible source thought");
    assert!(fixture.view.text(0, 2, 0, |_| true).is_err());
    assert!(fixture.view.text(0, 3, 0, |_| true).is_err());
    let wire = serde_json::to_string(&page).unwrap();
    assert!(!wire.contains("OPAQUE-SIGNATURE-CANARY"));
    assert!(!wire.contains("ATTACHMENT-CANARY"));
    assert_eq!(page.items[1].role, Some(HistoricalRole::Tool));
    assert_eq!(
        page.items[1].blocks[0].outcome,
        Some(HistoricalToolOutcome::RecordedResult)
    );
}

#[test]
fn control_character_expansion_cannot_overflow_the_serialized_page_budget() {
    let content = "\u{1}".repeat(4000);
    let blocks = (0..25)
        .map(|_| json!({"type":"text","text":content}))
        .collect::<Vec<_>>();
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        (0..15).map(|_| claude(json!(blocks))).collect(),
    );
    let page = fixture.view.page(0, |_| true).unwrap();
    assert!(serde_json::to_vec(&page).unwrap().len() <= 512 * 1024);
    assert!(page.items.len() <= 10);
    assert!(page.next_cursor.is_some());
    assert_eq!(full_text(&fixture.view, 0, 0), content);
}

#[test]
fn display_and_chunk_reads_observe_cancellation_and_refuse_corrupted_source_bytes() {
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([{"type":"text","text":"Body text"}]))],
    );
    assert!(fixture.view.page(0, |_| false).is_err());
    assert!(fixture.view.blocks(0, 0, |_| false).is_err());
    assert!(fixture.view.text(0, 0, 0, |_| false).is_err());
    let path = fixture.archive.join("source.bin");
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(path, bytes).unwrap();
    assert!(fixture.view.text(0, 0, 0, |_| true).is_err());
}

#[test]
fn codex_tool_results_are_displayed_as_recorded_results_and_empty_values_stay_empty() {
    let fixture = fixture(
        MigrationSourceKind::Codex,
        vec![
            json!({"type":"session_meta","payload":{"id":"session","cli_version":"0.163.0"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"c","name":"apply_patch","namespace":"tools","arguments":""}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c","output":""}}),
        ],
    );
    let page = fixture.view.page(0, |_| true).unwrap();
    assert_eq!(page.items[1].blocks[0].namespace.as_deref(), Some("tools"));
    assert_eq!(
        page.items[2].blocks[0].outcome,
        Some(HistoricalToolOutcome::RecordedResult)
    );
    assert_eq!(full_text(&fixture.view, 1, 0), "");
    assert_eq!(full_text(&fixture.view, 2, 0), "");
}

#[test]
fn non_string_text_and_thinking_values_are_opaque_instead_of_exposing_unknown_wrappers() {
    let fixture = fixture(
        MigrationSourceKind::ClaudeCode,
        vec![claude(json!([
            {"type":"thinking","thinking":{"signature":"UNKNOWN-WRAPPER-CANARY"}},
            {"type":"text","text":{"nested":"UNRECOGNIZED-TEXT-WRAPPER"}},
        ]))],
    );
    let page = fixture.view.page(0, |_| true).unwrap();
    for block in &page.items[0].blocks {
        assert!(block.kind == HistoricalDisplayBlockKind::Opaque);
        assert!(!block.body_available);
        assert!(block.preview.is_none());
        assert_eq!(block.source_type.as_deref(), Some("invalid_text_value"));
        assert!(fixture.view.text(0, block.index, 0, |_| true).is_err());
    }
    let wire = serde_json::to_string(&page).unwrap();
    assert!(!wire.contains("UNKNOWN-WRAPPER-CANARY"));
    assert!(!wire.contains("UNRECOGNIZED-TEXT-WRAPPER"));
}
