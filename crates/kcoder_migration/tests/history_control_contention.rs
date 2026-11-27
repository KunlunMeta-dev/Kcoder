use kcoder_config::PrivateDirectory;
use kcoder_migration::{history_discovery::HistoryCatalog, history_jobs::HistoryJobStore};
use kcoder_types::migration::MigrationSourceKind;
use std::{ffi::OsStr, time::Duration};

fn fixture() -> (tempfile::TempDir, std::path::PathBuf, String) {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    PrivateDirectory::open_or_create(&profile).unwrap();
    let source = root.path().join("source");
    let sessions = source.join("projects/owned");
    std::fs::create_dir_all(&sessions).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(sessions.join(format!("{id}.jsonl")), format!("{{\"type\":\"user\",\"uuid\":\"owned\",\"sessionId\":\"{id}\",\"message\":{{\"role\":\"user\",\"content\":\"Owned control fixture\"}}}}\n")).unwrap();
    let catalog =
        HistoryCatalog::discover(&source, MigrationSourceKind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    let source = catalog
        .selection(&page.items[0].source_handle)
        .unwrap()
        .pin()
        .unwrap();
    HistoryJobStore::open(&profile)
        .unwrap()
        .create_selected(&id, source)
        .unwrap();
    (root, profile, id)
}

#[test]
fn brief_control_contention_settles_before_the_single_cancel_mutation() {
    let (_root, profile, id) = fixture();
    let directory = PrivateDirectory::open_existing(&profile.join("migrations/history")).unwrap();
    let lock = directory
        .try_exclusive_lock(OsStr::new("control.lock"))
        .unwrap()
        .unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let join = std::thread::spawn(move || {
        ready_tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(15));
        drop(lock);
    });
    ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    let result = HistoryJobStore::open_existing(&profile)
        .unwrap()
        .unwrap()
        .request_cancel(&id);
    join.join().unwrap();
    assert!(result.unwrap().cancel_requested);
}

#[test]
fn sustained_control_contention_returns_busy_without_creating_a_cancel_marker() {
    let (_root, profile, id) = fixture();
    let directory = PrivateDirectory::open_existing(&profile.join("migrations/history")).unwrap();
    let _lock = directory
        .try_exclusive_lock(OsStr::new("control.lock"))
        .unwrap()
        .unwrap();
    let error = HistoryJobStore::open_existing(&profile)
        .unwrap()
        .unwrap()
        .request_cancel(&id)
        .unwrap_err();
    assert_eq!(error.to_string(), "history_job_busy");
    assert!(
        !profile
            .join("migrations/history")
            .join(format!("{id}.cancel.json"))
            .exists()
    );
}
