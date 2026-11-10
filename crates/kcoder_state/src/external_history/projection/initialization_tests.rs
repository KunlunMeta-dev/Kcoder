use super::*;
use kcoder_types::migration::MigrationSourceKind;
fn fixture() -> (tempfile::TempDir, ExternalHistoryReader) {
    let root = tempfile::tempdir().unwrap();
    let source = b"{}\n";
    let snapshot = ExternalHistorySnapshot {
        original: None,
        source_bytes: source.len() as u64,
        source_sha256: hash(source),
        record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_artifact_id: None,
            source_instance: "owned".into(),
            source_session_id: "foreign".into(),
            source_format: "fixture/1".into(),
            adapter_revision: "fixture/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
    };
    let store = ExternalHistoryStore::open(root.path()).unwrap();
    let mut operation = store.begin("projection-init", &snapshot).unwrap();
    operation
        .stage_source(&mut &source[..], &mut |_| true)
        .unwrap();
    let id = operation.finish(&mut |_| true).unwrap().receipt.archive_id;
    (root, store.reader(&id).unwrap())
}
fn directory(reader: &ExternalHistoryReader, revision: &str, create: bool) -> PrivateDirectory {
    reader
        .directory
        .open_child(
            OsStr::new(&format!("normalized-{}", hash(revision.as_bytes()))),
            create,
        )
        .unwrap()
}
#[test]
fn incomplete_schema_publication_is_absent_but_a_ready_schema_loss_remains_an_error() {
    let (_root, reader) = fixture();
    let revision = "fixture-init/1";
    let dir = directory(&reader, revision, true);
    let receipt = reader.receipt().unwrap().unwrap();
    let scope = serde_json::to_string(&(
        "external-history-projection/v1",
        &receipt.archive_id,
        &receipt.source_sha256,
        revision,
    ))
    .unwrap();
    let binding = schema_binding(&dir, &scope).unwrap();
    let lease = dir
        .try_exclusive_lock(OsStr::new("build.lock"))
        .unwrap()
        .unwrap();
    publish_schema_marker(&dir, SCHEMA_INTENT, &binding).unwrap();
    let opened = files::open_database_in(dir, &scope, true, DATABASE_BYTES)
        .unwrap()
        .unwrap();
    assert!(
        reader.projection(revision, false).unwrap().is_none(),
        "an authenticated in-progress schema is not published data"
    );
    drop(opened);
    drop(lease);
    let writer = reader.projection(revision, true).unwrap().unwrap();
    assert_eq!(writer.progress().unwrap().normalized_records, 0);
    assert!(
        reader.projection(revision, false).unwrap().is_some(),
        "published data remains readable while a writer exists"
    );
    writer
        .connection
        .execute_batch("DROP TABLE projection_rows; DROP TABLE projection_header;")
        .unwrap();
    assert!(
        reader.projection(revision, false).is_err(),
        "a ready schema must never be hidden as initializing"
    );
    drop(writer);
    assert!(
        reader.projection(revision, true).is_err(),
        "a lost ready schema cannot be silently recreated"
    );
}
#[test]
fn legacy_valid_tables_need_no_markers_and_legacy_empty_tables_are_not_assumed_pending() {
    let (_root, reader) = fixture();
    let revision = "fixture-legacy/1";
    let writer = reader.projection(revision, true).unwrap().unwrap();
    let dir = directory(&reader, revision, false);
    dir.remove_regular_file(OsStr::new(SCHEMA_INTENT)).unwrap();
    dir.remove_regular_file(OsStr::new(SCHEMA_READY)).unwrap();
    assert!(reader.projection(revision, false).unwrap().is_some());
    writer
        .connection
        .execute_batch("DROP TABLE projection_rows; DROP TABLE projection_header;")
        .unwrap();
    assert!(reader.projection(revision, false).is_err());
}
