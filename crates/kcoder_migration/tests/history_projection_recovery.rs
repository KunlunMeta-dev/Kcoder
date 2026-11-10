use kcoder_migration::{history_jobs::HistoryJobStore, history_sources::HistorySourceBinding};
use kcoder_state::history_index::HistoryCatalogRecoveryRequired;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use std::{fs, path::Path};

#[test]
fn corrupt_projection_is_not_replaced_with_a_recovery_required_checkpoint() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    fs::write(
        source.path().join("selected.jsonl"),
        b"{\"type\":\"future_record\"}\n",
    )
    .unwrap();
    let binding = HistorySourceBinding::capture(
        source.path(),
        Path::new("selected.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-recovery-fixture".into(),
            source_session_id: "recovery-fixture".into(),
            source_artifact_id: None,
            source_format: "synthetic-jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        &mut |_, _| true,
    )
    .unwrap();
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = store.create(&id, &binding).unwrap();
    while job.stage != HistoryImportStage::Normalized {
        job = store.step(&id, job.sequence, 10, |_| true).unwrap();
        assert_ne!(job.stage, HistoryImportStage::Failed);
    }
    let archive = profile
        .path()
        .join("external-history")
        .join(job.archive_id.as_ref().unwrap());
    let projection = fs::read_dir(archive)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("normalized-")
        })
        .unwrap();
    let database = projection.join("catalog.sqlite3");
    let corrupt = vec![b'X'; 4096];
    fs::write(&database, &corrupt).unwrap();
    let envelope = profile
        .path()
        .join("migrations/history")
        .join(format!("{id}.json"));
    let checkpoint = fs::read(&envelope).unwrap();
    for error in [
        store.read(&id).unwrap_err(),
        store.step(&id, job.sequence, 10, |_| true).unwrap_err(),
    ] {
        assert!(HistoryCatalogRecoveryRequired::from_error(&error).is_none());
    }
    assert_eq!(fs::read(envelope).unwrap(), checkpoint);
    assert_eq!(fs::read(database).unwrap(), corrupt);
    assert!(!projection.join("catalog.sqlite3-journal").exists());
}
