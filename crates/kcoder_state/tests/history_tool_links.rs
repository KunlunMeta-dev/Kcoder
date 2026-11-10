use kcoder_state::external_history::{
    ExternalHistoryReader, ExternalHistoryStore, tool_links::HistoricalToolLinks,
};
use kcoder_types::{
    external_history::*, historical_tool_links::*, imported_transcript::*,
    migration::MigrationSourceKind,
};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};

const REVISION: &str = "synthetic-tool-relations/1";
const SELECTION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
static SERIAL: Mutex<()> = Mutex::new(());
fn guard() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|error| error.into_inner())
}

fn value(record: u64) -> HistoricalValueRef {
    HistoricalValueRef {
        record,
        offset: 0,
        bytes: 2,
        encoding: HistoricalValueEncoding::Json,
        decoded_bytes: None,
        decoded_sha256: None,
        preview: None,
    }
}
fn call(record: u64, id: &str) -> HistoricalBlock {
    HistoricalBlock::ToolCall {
        call_id: id.into(),
        name: "write".into(),
        namespace: Some("office".into()),
        source_type: Some("function_call".into()),
        input: value(record),
    }
}
fn result(record: u64, id: &str, outcome: HistoricalToolOutcome) -> HistoricalBlock {
    HistoricalBlock::ToolResult {
        call_id: id.into(),
        output: value(record),
        outcome,
    }
}
fn row(ordinal: u64, blocks: Vec<HistoricalBlock>, turn: Option<&str>) -> HistoricalRecord {
    HistoricalRecord {
        source: MigrationSourceKind::Codex,
        record: ordinal,
        source_id: None,
        parent_id: None,
        logical_parent_id: None,
        source_session_id: Some("source".into()),
        timestamp: None,
        source_version: None,
        turn_id: turn.map(Into::into),
        persisted_ordinal: None,
        sidechain: false,
        hidden: false,
        compact_summary: false,
        codex: None,
        data: HistoricalRecordData::Message {
            role: HistoricalRole::Assistant,
            phase: None,
            blocks,
        },
        diagnostics: Vec::new(),
    }
}
fn event(
    ordinal: u64,
    id: &str,
    outcome: HistoricalToolOutcome,
    turn: Option<&str>,
) -> HistoricalRecord {
    let mut record = row(ordinal, Vec::new(), turn);
    record.data = HistoricalRecordData::Event {
        source_type: "exec_command_end".into(),
        payload: value(ordinal),
        call_id: Some(id.into()),
        outcome: Some(outcome),
    };
    record
}
fn prepare(root: &Path, records: Vec<HistoricalRecord>) -> ExternalHistoryReader {
    let bytes = b"{}\n".repeat(records.len());
    let snapshot = ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "owned-synthetic-records".into(),
            source_session_id: "source".into(),
            source_format: "synthetic-state-facts".into(),
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
    let mut import = store.begin("tool-links", &snapshot).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let reader = store.reader(&receipt.archive_id).unwrap();
    let mut projection = reader.projection(REVISION, true).unwrap().unwrap();
    for chunk in records.chunks(10) {
        projection.append(chunk[0].record, chunk).unwrap();
    }
    projection.finish().unwrap();
    reader
}
fn feed(reader: &ExternalHistoryReader, count: u64) -> HistoricalToolLinks {
    let mut links = reader
        .tool_links(REVISION, SELECTION, true)
        .unwrap()
        .unwrap();
    for ordinal in 0..count {
        links.append(ordinal, ordinal).unwrap();
    }
    links.seal(count).unwrap();
    links
}

#[test]
fn results_remain_distinct_from_success_and_closed_ids_can_be_reused_sequentially() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            row(0, vec![call(0, "same")], None),
            row(
                1,
                vec![result(1, "same", HistoricalToolOutcome::RecordedResult)],
                None,
            ),
            row(2, vec![call(2, "same")], None),
            row(
                3,
                vec![result(3, "same", HistoricalToolOutcome::RecordedError)],
                None,
            ),
            row(4, vec![call(4, "missing")], None),
        ],
    );
    let links = feed(&reader, 5);
    let page = links.page(None, 10).unwrap();
    assert_eq!(page.links.len(), 3);
    assert_eq!(page.links[0].status, HistoricalToolLinkStatus::Linked);
    assert_eq!(page.links[0].outcome, HistoricalToolOutcome::RecordedResult);
    assert_eq!(page.links[0].namespace.as_deref(), Some("office"));
    assert_eq!(page.links[1].call.as_ref().unwrap().record, 2);
    assert_eq!(page.links[1].outcome, HistoricalToolOutcome::RecordedError);
    assert_eq!(
        page.links[2].status,
        HistoricalToolLinkStatus::MissingResult
    );
    assert_eq!(page.links[2].outcome, HistoricalToolOutcome::OutcomeUnknown);
    assert_eq!(page.progress.unresolved_links, 1);
}

#[test]
fn results_before_calls_and_overlapping_duplicate_ids_are_preserved_without_guessing_a_pair() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            row(
                0,
                vec![result(0, "early", HistoricalToolOutcome::RecordedResult)],
                None,
            ),
            row(1, vec![call(1, "early")], None),
            row(2, vec![call(2, "duplicate"), call(2, "duplicate")], None),
            row(
                3,
                vec![result(
                    3,
                    "duplicate",
                    HistoricalToolOutcome::RecordedSuccess,
                )],
                None,
            ),
        ],
    );
    let links = feed(&reader, 4);
    let page = links.page(None, 10).unwrap();
    assert_eq!(page.links.len(), 5);
    assert_eq!(page.links[0].status, HistoricalToolLinkStatus::OrphanResult);
    assert_eq!(
        page.links[1].status,
        HistoricalToolLinkStatus::MissingResult
    );
    assert!(
        page.links[2..]
            .iter()
            .all(|link| link.status == HistoricalToolLinkStatus::Ambiguous)
    );
    assert_eq!(page.progress.unresolved_links, 5);
}

#[test]
fn explicit_turns_disambiguate_parallel_reuse_and_contradictory_outcomes_stay_conflicted() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            row(0, vec![call(0, "same")], Some("turn-a")),
            row(1, vec![call(1, "same")], Some("turn-b")),
            row(
                2,
                vec![result(2, "same", HistoricalToolOutcome::RecordedResult)],
                Some("turn-b"),
            ),
            event(
                3,
                "same",
                HistoricalToolOutcome::RecordedSuccess,
                Some("turn-b"),
            ),
            row(
                4,
                vec![result(4, "same", HistoricalToolOutcome::RecordedError)],
                Some("turn-a"),
            ),
            event(
                5,
                "same",
                HistoricalToolOutcome::RecordedSuccess,
                Some("turn-a"),
            ),
            event(
                6,
                "same",
                HistoricalToolOutcome::RecordedSuccess,
                Some("turn-a"),
            ),
        ],
    );
    let links = feed(&reader, 7);
    let page = links.page(None, 10).unwrap();
    assert_eq!(page.links.len(), 2);
    assert_eq!(
        page.links[0].status,
        HistoricalToolLinkStatus::ConflictingOutcome
    );
    assert_eq!(page.links[0].outcome, HistoricalToolOutcome::OutcomeUnknown);
    assert_eq!(page.links[1].status, HistoricalToolLinkStatus::Linked);
    assert_eq!(
        page.links[1].outcome,
        HistoricalToolOutcome::RecordedSuccess
    );
    assert_eq!(page.links[1].result.as_ref().unwrap().record, 2);
    assert_eq!(page.progress.unresolved_links, 1);
}

#[test]
fn late_execution_events_do_not_attach_to_an_arbitrary_reused_call_id() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let mut records = Vec::new();
    for index in 0..4 {
        records.push(row(index * 2, vec![call(index * 2, "reused")], None));
        records.push(row(
            index * 2 + 1,
            vec![result(
                index * 2 + 1,
                "reused",
                HistoricalToolOutcome::RecordedResult,
            )],
            None,
        ));
    }
    records.push(event(
        8,
        "reused",
        HistoricalToolOutcome::RecordedSuccess,
        None,
    ));
    let reader = prepare(root.path(), records);
    let links = feed(&reader, 9);
    let page = links.page(None, 10).unwrap();
    assert_eq!(page.links.len(), 5);
    assert!(
        page.links[..4]
            .iter()
            .all(|link| link.outcome == HistoricalToolOutcome::RecordedResult)
    );
    assert_eq!(
        page.links[4].status,
        HistoricalToolLinkStatus::UnmatchedExecutionEvent
    );
}

#[test]
fn an_exit_receipt_does_not_invent_the_missing_tool_result() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            row(0, vec![call(0, "c")], None),
            event(1, "c", HistoricalToolOutcome::RecordedSuccess, None),
            row(
                2,
                vec![result(2, "c", HistoricalToolOutcome::RecordedResult)],
                None,
            ),
        ],
    );
    let links = feed(&reader, 2);
    let page = links.page(None, 10).unwrap();
    assert_eq!(
        page.links[0].status,
        HistoricalToolLinkStatus::MissingResult
    );
    assert_eq!(page.links[0].outcome, HistoricalToolOutcome::OutcomeUnknown);
    assert!(page.links[0].execution_event.is_some());
    assert_eq!(
        page.links[0].execution_outcome,
        Some(HistoricalToolOutcome::RecordedSuccess)
    );
    assert_eq!(page.progress.unresolved_links, 1);
    drop(links);
    let mut complete = reader
        .tool_links(REVISION, &"c".repeat(64), true)
        .unwrap()
        .unwrap();
    for ordinal in 0..3 {
        complete.append(ordinal, ordinal).unwrap();
    }
    assert_eq!(complete.seal(3).unwrap().unresolved_links, 0);
    let page = complete.page(None, 10).unwrap();
    assert_eq!(page.links[0].status, HistoricalToolLinkStatus::Linked);
    assert_eq!(
        page.links[0].outcome,
        HistoricalToolOutcome::RecordedSuccess
    );
    assert_eq!(page.links[0].result.as_ref().unwrap().record, 2);
}

#[test]
fn receipt_replay_reopens_the_same_selection_and_different_streams_cannot_overwrite_it() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        vec![
            row(0, vec![call(0, "a")], None),
            row(
                1,
                vec![result(1, "a", HistoricalToolOutcome::RecordedResult)],
                None,
            ),
        ],
    );
    assert!(
        reader
            .tool_links(REVISION, SELECTION, false)
            .unwrap()
            .is_none()
    );
    let mut links = reader
        .tool_links(REVISION, SELECTION, true)
        .unwrap()
        .unwrap();
    let first = links.append(0, 0).unwrap();
    assert!(reader.tool_links(REVISION, SELECTION, true).is_err());
    let mut observer = reader
        .tool_links(REVISION, SELECTION, false)
        .unwrap()
        .unwrap();
    assert!(observer.append(1, 1).is_err());
    assert_eq!(observer.progress().unwrap(), first);
    drop(observer);
    drop(links);
    let mut links = reader
        .tool_links(REVISION, SELECTION, true)
        .unwrap()
        .unwrap();
    assert_eq!(links.append(0, 0).unwrap(), first);
    assert!(links.append(0, 1).is_err());
    assert!(links.append(2, 1).is_err());
    assert!(links.seal(2).is_err());
    links.append(1, 1).unwrap();
    let finished = links.seal(2).unwrap();
    assert!(finished.sealed);
    assert_eq!(finished.unresolved_links, 0);
    assert_eq!(links.append(1, 1).unwrap(), finished);
    let separate = reader
        .tool_links(REVISION, &"b".repeat(64), true)
        .unwrap()
        .unwrap();
    assert_eq!(separate.progress().unwrap().processed_records, 0);
}

#[test]
fn link_pages_are_bounded_and_each_row_hash_is_checked() {
    let _guard = guard();
    let root = tempfile::tempdir().unwrap();
    let reader = prepare(
        root.path(),
        (0..23)
            .map(|ordinal| row(ordinal, vec![call(ordinal, &format!("c{ordinal}"))], None))
            .collect(),
    );
    let links = feed(&reader, 23);
    let mut cursor = None;
    let mut lengths = Vec::new();
    loop {
        let page = links.page(cursor.as_deref(), 10).unwrap();
        lengths.push(page.links.len());
        assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024);
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = Some(next);
    }
    assert_eq!(lengths, [10, 10, 3]);
    assert!(links.page(None, 11).is_err());
    drop(links);
    let receipt = reader.receipt().unwrap().unwrap();
    let identity = serde_json::to_vec(&(REVISION, SELECTION)).unwrap();
    let db = root
        .path()
        .join("external-history")
        .join(receipt.archive_id)
        .join(format!("tool-links-{:x}", Sha256::digest(identity)))
        .join("catalog.sqlite3");
    let connection = rusqlite::Connection::open(db).unwrap();
    connection
        .execute(
            "UPDATE links SET body=?1 WHERE id=(SELECT min(id) FROM links)",
            [b"{}".as_slice()],
        )
        .unwrap();
    drop(connection);
    let links = reader
        .tool_links(REVISION, SELECTION, false)
        .unwrap()
        .unwrap();
    assert!(links.page(None, 10).is_err());
}
