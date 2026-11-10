use kcoder_state::external_history::{ExternalHistoryReader, ExternalHistoryStore};
use kcoder_types::{external_history::*, imported_transcript::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn archive(root: &Path, count: usize) -> (ExternalHistoryReader, PathBuf) {
    let bytes = b"{}\n".repeat(count);
    let snapshot = ExternalHistorySnapshot {
        original: None,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "owned-fixture".into(),
            source_session_id: "source".into(),
            source_format: "synthetic-jsonl".into(),
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
    let mut import = store.begin("projection", &snapshot).unwrap();
    import.stage_source(&mut &bytes[..], &mut |_| true).unwrap();
    let receipt = import.finish(&mut |_| true).unwrap().receipt;
    let directory = root.join("external-history").join(&receipt.archive_id);
    (store.reader(&receipt.archive_id).unwrap(), directory)
}

fn record(ordinal: u64, preview: &str) -> HistoricalRecord {
    HistoricalRecord {
        source: MigrationSourceKind::Codex,
        record: ordinal,
        source_id: None,
        parent_id: None,
        logical_parent_id: None,
        source_session_id: Some("source".into()),
        timestamp: None,
        source_version: None,
        turn_id: None,
        persisted_ordinal: Some(ordinal),
        sidechain: false,
        hidden: false,
        compact_summary: false,
        codex: None,
        data: HistoricalRecordData::Message {
            role: HistoricalRole::Assistant,
            phase: None,
            blocks: vec![HistoricalBlock::Text {
                value: HistoricalValueRef {
                    record: ordinal,
                    offset: 0,
                    bytes: 2,
                    encoding: HistoricalValueEncoding::JsonString,
                    decoded_bytes: Some(preview.len() as u64),
                    decoded_sha256: Some(format!("{:x}", Sha256::digest(preview.as_bytes()))),
                    preview: Some(preview.into()),
                },
            }],
        },
        diagnostics: vec![],
    }
}

fn database(directory: &Path, revision: &str) -> PathBuf {
    directory
        .join(format!(
            "normalized-{:x}",
            Sha256::digest(revision.as_bytes())
        ))
        .join("catalog.sqlite3")
}

#[test]
fn durable_cursor_reopens_with_ten_record_pages_and_keeps_replays_idempotent() {
    let root = tempfile::tempdir().unwrap();
    let (archive, _) = archive(root.path(), 23);
    assert!(archive.projection("records/1", false).unwrap().is_none());
    let mut projection = archive.projection("records/1", true).unwrap().unwrap();
    let mut first = (0..10)
        .map(|id| record(id, "中文 / visible historical text"))
        .collect::<Vec<_>>();
    first[3].diagnostics.push(HistoricalDiagnostic {
        code: "unknown_result".into(),
        blocks_continuation: true,
    });
    let saved = projection.append(0, &first).unwrap();
    assert_eq!(saved.normalized_records, 10);
    assert_eq!(saved.records_with_diagnostics, 1);
    assert!(!saved.normalization_complete);
    assert!(projection.finish().is_err());
    drop(projection);
    let mut projection = archive.projection("records/1", true).unwrap().unwrap();
    assert_eq!(projection.append(0, &first).unwrap(), saved);
    let mut changed = first.clone();
    changed[0].hidden = true;
    assert!(projection.append(0, &changed).is_err());
    assert!(projection.append(11, &[record(11, "gap")]).is_err());
    assert!(
        projection
            .append(u64::MAX, &[record(0, "overflow")])
            .is_err()
    );
    for cursor in [10, 20] {
        let values = (cursor..23.min(cursor + 10))
            .map(|id| record(id, "tail"))
            .collect::<Vec<_>>();
        projection.append(cursor, &values).unwrap();
    }
    assert!(projection.finish().unwrap().normalization_complete);
    assert!(projection.record(3).unwrap() == first[3]);
    let mut cursor = 0;
    let mut lengths = vec![];
    loop {
        let page = projection.page(cursor, 10).unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 1024 * 1024);
        lengths.push(page.items.len());
        assert!(page.items.iter().all(|item| item.value.is_some()));
        let Some(next) = page.next_cursor else {
            break;
        };
        cursor = next;
    }
    assert_eq!(lengths, [10, 10, 3]);
    assert!(projection.page(0, 11).is_err());
    assert!(projection.page(24, 10).is_err());
    assert!(projection.record(23).is_err());
    assert!(projection.page(23, 10).unwrap().items.is_empty());
    let other = archive.projection("records/2", true).unwrap().unwrap();
    assert_eq!(other.progress().unwrap().normalized_records, 0);
    assert_eq!(projection.progress().unwrap().normalized_records, 23);
}

#[test]
fn only_one_builder_owns_the_projection_and_readers_cannot_mutate_it() {
    let root = tempfile::tempdir().unwrap();
    let (archive, _) = archive(root.path(), 2);
    let mut writer = archive.projection("records/1", true).unwrap().unwrap();
    writer.append(0, &[record(0, "first")]).unwrap();
    assert!(archive.projection("records/1", true).is_err());
    let mut reader = archive.projection("records/1", false).unwrap().unwrap();
    assert_eq!(reader.page(0, 10).unwrap().items.len(), 1);
    assert!(reader.append(1, &[record(1, "forbidden")]).is_err());
    assert!(reader.finish().is_err());
    writer.append(1, &[record(1, "second")]).unwrap();
    assert_eq!(reader.page(0, 10).unwrap().items.len(), 2);
    drop(writer);
    assert!(archive.projection("records/1", true).unwrap().is_some());
}

#[test]
fn large_records_use_bounded_chunks_instead_of_overflowing_page_responses() {
    let root = tempfile::tempdir().unwrap();
    let (archive, _) = archive(root.path(), 2);
    let mut projection = archive.projection("records/1", true).unwrap().unwrap();
    let long = record(0, &"x".repeat(1200 * 1024));
    projection
        .append(0, &[long.clone(), record(1, "small")])
        .unwrap();
    let page = projection.page(0, 10).unwrap();
    assert!(page.items[0].value.is_none());
    assert!(page.items[1].value.is_some());
    assert!(serde_json::to_vec(&page).unwrap().len() < 1024 * 1024);
    let mut bytes = vec![];
    loop {
        let chunk = projection
            .read_entry_chunk(0, bytes.len() as u64, EXTERNAL_HISTORY_CHUNK_BYTES)
            .unwrap();
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= EXTERNAL_HISTORY_CHUNK_BYTES);
        bytes.extend(chunk);
    }
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        page.items[0].sha256
    );
    assert!(serde_json::from_slice::<HistoricalRecord>(&bytes).unwrap() == long);
    assert!(
        projection
            .read_entry_chunk(0, 0, EXTERNAL_HISTORY_CHUNK_BYTES + 1)
            .is_err()
    );
    assert!(projection.append(2, &[record(2, "range")]).is_err());
}

#[test]
fn tampering_cannot_be_accepted_as_an_idempotent_replay_or_a_complete_page() {
    for delete in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (archive, directory) = archive(root.path(), 3);
        let original = (0..3).map(|id| record(id, "original")).collect::<Vec<_>>();
        let mut projection = archive.projection("records/1", true).unwrap().unwrap();
        projection.append(0, &original).unwrap();
        drop(projection);
        let db = rusqlite::Connection::open(database(&directory, "records/1")).unwrap();
        if delete {
            db.execute("DELETE FROM projection_rows WHERE ordinal=1", [])
                .unwrap();
        } else {
            db.execute(
                "UPDATE projection_rows SET body=?1 WHERE ordinal=1",
                [b"{}".as_slice()],
            )
            .unwrap();
        }
        drop(db);
        let mut projection = archive.projection("records/1", true).unwrap().unwrap();
        assert!(projection.page(0, 10).is_err());
        assert!(projection.append(0, &original).is_err());
        if delete {
            assert!(projection.finish().is_err());
        }
    }
}

#[test]
fn headers_remain_bound_to_the_original_source_and_schema_changes_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let (archive, directory) = archive(root.path(), 1);
    let projection = archive.projection("records/1", true).unwrap().unwrap();
    drop(projection);
    let db = rusqlite::Connection::open(database(&directory, "records/1")).unwrap();
    let bytes: Vec<u8> = db
        .query_row("SELECT body FROM projection_header", [], |row| row.get(0))
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    value["source_sha256"] = "0".repeat(64).into();
    let changed = serde_json::to_vec(&value).unwrap();
    db.execute(
        "UPDATE projection_header SET body=?1,sha=?2",
        rusqlite::params![&changed, Sha256::digest(&changed).as_slice()],
    )
    .unwrap();
    drop(db);
    assert!(archive.projection("records/1", false).is_err());
    let other = archive.projection("records/2", true).unwrap().unwrap();
    drop(other);
    let db = rusqlite::Connection::open(database(&directory, "records/2")).unwrap();
    db.execute_batch("CREATE TABLE unexpected(payload BLOB)")
        .unwrap();
    drop(db);
    assert!(archive.projection("records/2", false).is_err());
}

#[test]
fn encoded_record_budgets_reject_oversized_values_without_advancing_progress() {
    let root = tempfile::tempdir().unwrap();
    let (archive, _) = archive(root.path(), 1);
    let mut projection = archive.projection("records/1", true).unwrap().unwrap();
    let huge = record(0, &"x".repeat(9 * 1024 * 1024));
    let error = projection.append(0, &[huge]).unwrap_err().to_string();
    assert!(error.contains("budget_exceeded"));
    assert_eq!(projection.progress().unwrap().normalized_records, 0);
    projection.append(0, &[record(0, "bounded retry")]).unwrap();
    assert!(projection.finish().unwrap().normalization_complete);
}

#[test]
fn legacy_normalized_stores_stay_readable_without_an_unbounded_index_upgrade() {
    let root = tempfile::tempdir().unwrap();
    let (archive, directory) = archive(root.path(), 1);
    let mut projection = archive.projection("legacy/1", true).unwrap().unwrap();
    projection.append(0, &[record(0, "legacy body")]).unwrap();
    projection.finish().unwrap();
    drop(projection);
    let db = rusqlite::Connection::open(database(&directory, "legacy/1")).unwrap();
    db.execute_batch("DROP INDEX projection_rows_parent; DROP INDEX projection_rows_source;")
        .unwrap();
    drop(db);
    let projection = archive.projection("legacy/1", false).unwrap().unwrap();
    assert!(projection.progress().unwrap().normalization_complete);
    assert_eq!(projection.page(0, 10).unwrap().items.len(), 1);
    assert!(projection.canonical_source_record("m").is_err());
    assert!(projection.source_nodes(0, 10, true).is_err());
    let new_revision = archive.projection("current/2", true).unwrap().unwrap();
    assert_eq!(new_revision.progress().unwrap().normalized_records, 0);
}
