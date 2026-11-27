use kcoder_migration::{
    history_normalization::{HISTORY_NORMALIZATION_REVISION, HistoryNormalizer},
    history_records::CLAUDE_TRANSCRIPT_BASELINE,
    history_selection::{link_selected_claude_tools, select_claude_history},
};
use kcoder_state::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::{
    external_history::*, historical_tool_links::HistoricalToolLinkStatus,
    imported_transcript::HistoricalToolOutcome, migration::MigrationSourceKind,
};
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
            source: MigrationSourceKind::ClaudeCode,
            source_artifact_id: None,
            source_instance: "owned-fixture".into(),
            source_session_id: "s1".into(),
            source_format: "synthetic-claude-jsonl".into(),
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
    let mut import = store.begin("select-history", &snapshot).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let mut normalizer =
        HistoryNormalizer::open(store.reader(&receipt.archive_id).unwrap()).unwrap();
    while !normalizer.progress().unwrap().normalization_complete {
        normalizer.step(10, |_| true).unwrap();
    }
    store.reader(&receipt.archive_id).unwrap()
}

fn message(kind: &str, id: &str, parent: Option<&str>, content: Value) -> Value {
    json!({"type":kind,"uuid":id,"parentUuid":parent,"sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE,"message":{"role":kind,"content":content}})
}

fn text(value: &str) -> Value {
    json!([{"type":"text","text":value}])
}

#[test]
fn main_branch_uses_parent_links_and_never_pairs_a_result_from_a_sibling_or_sidechain() {
    let root = tempfile::tempdir().unwrap();
    let mut side = message("assistant", "side", Some("u"), text("later child output"));
    side["isSidechain"] = true.into();
    let reader = prepare(
        root.path(),
        vec![
            message("user", "u", None, text("produce a file")),
            message(
                "assistant",
                "old",
                Some("u"),
                json!([{"type":"tool_use","id":"same","name":"write","input":{"content":"old"}}]),
            ),
            message(
                "user",
                "old-result",
                Some("old"),
                json!([{"type":"tool_result","tool_use_id":"same","is_error":true,"content":"failed"}]),
            ),
            message(
                "assistant",
                "new",
                Some("u"),
                json!([{"type":"tool_use","id":"same","name":"write","input":{"content":"new"}}]),
            ),
            message(
                "user",
                "new-result",
                Some("new"),
                json!([{"type":"tool_result","tool_use_id":"same","is_error":false,"content":"saved"}]),
            ),
            json!({"type":"progress","uuid":"progress","parentUuid":"new-result","sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE}),
            side,
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selected = select_claude_history(&index, |_| true).unwrap();
    assert_eq!(selected.records(), [0, 3, 4]);
    assert_eq!(selected.leaf(), Some(4));
    assert!(selected.complete_path());
    assert_eq!(selected.incomplete_source_nodes(), 0);
    drop(index);
    let progress = link_selected_claude_tools(&reader, &selected, |_| true).unwrap();
    assert!(progress.sealed);
    assert_eq!(progress.recorded_links, 1);
    let ledger = reader
        .tool_links(
            HISTORY_NORMALIZATION_REVISION,
            selected.selection_sha256(),
            false,
        )
        .unwrap()
        .unwrap();
    let page = ledger.page(None, 10).unwrap();
    let link = &page.links[0];
    assert_eq!(link.status, HistoricalToolLinkStatus::Linked);
    assert_eq!(link.outcome, HistoricalToolOutcome::RecordedSuccess);
    assert_eq!(link.call.as_ref().unwrap().record, 3);
    assert_eq!(link.result.as_ref().unwrap().record, 4);
    assert!(!root.path().join("NEVER_EXECUTE").exists());
}

#[test]
fn duplicate_uuids_use_the_last_entry_but_shared_message_ids_do_not_merge_chunks() {
    let root = tempfile::tempdir().unwrap();
    let mut first = message("assistant", "a", Some("u"), text("partial"));
    first["message"]["id"] = "one-model-response".into();
    let mut second = message("assistant", "b", Some("a"), text("another chunk"));
    second["message"]["id"] = "one-model-response".into();
    let mut last = message("assistant", "a", Some("u"), text("final first chunk"));
    last["message"]["id"] = "one-model-response".into();
    let reader = prepare(
        root.path(),
        vec![
            message("user", "u", None, text("task")),
            first,
            second,
            last,
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selected = select_claude_history(&index, |_| true).unwrap();
    assert_eq!(selected.records(), [0, 3, 2]);
    assert_eq!(selected.leaf(), Some(2));
    assert!(selected.complete_path());
    assert_eq!(
        index.canonical_source_record("a").unwrap().unwrap().record,
        3
    );
}

#[test]
fn compaction_logical_parent_does_not_duplicate_pre_summary_context() {
    let root = tempfile::tempdir().unwrap();
    let mut summary = message("user", "summary", Some("compact"), text("retained summary"));
    summary["isCompactSummary"] = true.into();
    let reader = prepare(
        root.path(),
        vec![
            message("user", "u", None, text("original")),
            message("assistant", "a", Some("u"), text("old reply")),
            json!({"type":"system","subtype":"compact_boundary","uuid":"compact","parentUuid":null,"logicalParentUuid":"a","sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE}),
            summary,
            message("assistant", "final", Some("summary"), text("new reply")),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selected = select_claude_history(&index, |_| true).unwrap();
    assert_eq!(selected.records(), [2, 3, 4]);
    assert!(selected.complete_path());
}

#[test]
fn logical_parent_order_pairs_a_result_even_when_it_was_recorded_before_the_call() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            message("user", "u", None, text("task")),
            message(
                "user",
                "result",
                Some("call"),
                json!([{"type":"tool_result","tool_use_id":"c","content":"recorded output"}]),
            ),
            message(
                "assistant",
                "call",
                Some("u"),
                json!([{"type":"tool_use","id":"c","name":"write","input":{"target":"NEVER_EXECUTED"}}]),
            ),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selected = select_claude_history(&index, |_| true).unwrap();
    assert_eq!(selected.records(), [0, 2, 1]);
    drop(index);
    assert_eq!(
        link_selected_claude_tools(&reader, &selected, |_| true)
            .unwrap()
            .unresolved_links,
        0
    );
    let links = reader
        .tool_links(
            HISTORY_NORMALIZATION_REVISION,
            selected.selection_sha256(),
            false,
        )
        .unwrap()
        .unwrap();
    let page = links.page(None, 10).unwrap();
    assert_eq!(page.links[0].status, HistoricalToolLinkStatus::Linked);
    assert_eq!(page.links[0].outcome, HistoricalToolOutcome::RecordedResult);
    assert!(!root.path().join("NEVER_EXECUTED").exists());
}

#[test]
fn unknown_terminal_records_keep_archive_diagnostics_when_the_known_leaf_has_no_issues() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            message("user", "u", None, text("task")),
            message("assistant", "a", Some("u"), text("known answer")),
            json!({"type":"future_vendor_entry","uuid":"unknown","parentUuid":"a","sessionId":"s1","version":CLAUDE_TRANSCRIPT_BASELINE}),
        ],
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    let selected = select_claude_history(&index, |_| true).unwrap();
    assert_eq!(selected.leaf(), Some(1));
    assert!(selected.complete_path());
    assert_eq!(selected.selected_records_with_diagnostics(), 0);
    assert_eq!(selected.source_records_with_diagnostics(), 1);
}

#[test]
fn newer_cycles_and_dangling_parents_cannot_silently_select_an_older_valid_branch() {
    for cycle in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let mut records = vec![
            message("user", "u", None, text("old")),
            message("assistant", "a", Some("u"), text("old answer")),
            message(
                "assistant",
                "new-a",
                Some(if cycle { "new-b" } else { "missing" }),
                text("latest"),
            ),
        ];
        if cycle {
            records.push(message(
                "assistant",
                "new-b",
                Some("new-a"),
                text("latest cycle"),
            ));
        }
        let reader = prepare(root.path(), records);
        let index = reader
            .projection(HISTORY_NORMALIZATION_REVISION, false)
            .unwrap()
            .unwrap();
        let selected = select_claude_history(&index, |_| true).unwrap();
        assert_eq!(selected.leaf(), Some(if cycle { 3 } else { 2 }));
        assert!(!selected.complete_path());
        assert!(selected.incomplete_source_nodes() >= 1);
        assert!(!selected.records().contains(&1));
    }
}

#[test]
fn selection_cancels_without_writes_and_tool_linking_resumes_its_durable_cursor() {
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        (0..31)
            .map(|id| {
                message(
                    if id % 2 == 0 { "user" } else { "assistant" },
                    &format!("m{id}"),
                    if id == 0 {
                        None
                    } else {
                        Some(format!("m{}", id - 1))
                    }
                    .as_deref(),
                    text("historical"),
                )
            })
            .collect(),
    );
    let index = reader
        .projection(HISTORY_NORMALIZATION_REVISION, false)
        .unwrap()
        .unwrap();
    assert!(select_claude_history(&index, |count| count < 3).is_err());
    let selected = select_claude_history(&index, |_| true).unwrap();
    assert_eq!(selected.records().len(), 31);
    drop(index);
    assert!(link_selected_claude_tools(&reader, &selected, |count| count < 7).is_err());
    let ledger = reader
        .tool_links(
            HISTORY_NORMALIZATION_REVISION,
            selected.selection_sha256(),
            false,
        )
        .unwrap()
        .unwrap();
    assert_eq!(ledger.progress().unwrap().processed_records, 7);
    assert!(!ledger.progress().unwrap().sealed);
    drop(ledger);
    let finished = link_selected_claude_tools(&reader, &selected, |_| true).unwrap();
    assert_eq!(finished.processed_records, 31);
    assert!(finished.sealed);
}
