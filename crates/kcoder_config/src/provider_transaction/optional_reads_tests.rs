use super::*;
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn optional_project_read_leaves_a_missing_store_absent() {
    let workspace = tempfile::tempdir().unwrap();
    for name in ["settings.json", "settings.local.json"] {
        assert!(
            crate::read_settings_file_if_present(&workspace.path().join(".kcoder").join(name))
                .unwrap()
                .is_none()
        );
    }
    assert!(!workspace.path().join(".kcoder").exists());
}

#[test]
fn optional_project_read_waits_for_initial_provider_publication() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join(".kcoder/settings.json");
    assert!(
        crate::read_settings_file_if_present(&path)
            .unwrap()
            .is_none()
    );
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer_path = path.clone();
    let writer = std::thread::spawn(move || {
        update(&writer_path, |document, credentials| {
            assert!(!writer_path.exists());
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            *document = serde_json::json!({"model":"published", "providers":{}});
            credentials.set_api_key("fixture", "owned-fixture".into())
        })
        .unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (read_tx, read_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::channel();
    let reader_path = path.clone();
    let reader = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        read_tx
            .send(crate::read_settings_file_if_present(&reader_path))
            .unwrap();
    });
    // A coordinator exists before the first journal or settings file. The read
    // must wait for its owner instead of returning an unlocked empty projection.
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(read_rx.recv_timeout(Duration::from_millis(100)).is_err());
    release_tx.send(()).unwrap();
    writer.join().unwrap();
    let document = read_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap()
        .unwrap();
    reader.join().unwrap();
    assert_eq!(document["model"], "published");
    assert_eq!(document["providers"], serde_json::json!({}));
    assert!(
        CredentialStore::load_from(&path.with_file_name("credentials.json"))
            .unwrap()
            .has_api_key("fixture")
    );
    assert!(!path.with_file_name(JOURNAL).exists());
}

#[test]
fn optional_project_read_recovers_a_pending_pair_before_first_settings_file() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join(".kcoder/settings.json");
    let pending = Pending {
        version: 1,
        committed: false,
        settings_name: "settings.json".into(),
        source: None,
        original: serde_json::json!({}),
        next: serde_json::json!({"model":"recovered", "providers":{}}),
        credentials: Some(CredentialStore {
            credentials: BTreeMap::from([("fixture".into(), "owned-fixture".into())]),
            ..Default::default()
        }),
    };
    write_json_atomic(
        &path.with_file_name(JOURNAL),
        &serde_json::to_value(pending).unwrap(),
        true,
    )
    .unwrap();
    assert!(!path.exists());
    let document = crate::read_settings_file_if_present(&path)
        .unwrap()
        .unwrap();
    assert_eq!(document["model"], "recovered");
    assert_eq!(document["providers"], serde_json::json!({}));
    assert!(
        CredentialStore::load_from(&path.with_file_name("credentials.json"))
            .unwrap()
            .has_api_key("fixture")
    );
    assert!(!path.with_file_name(JOURNAL).exists());
}

#[test]
fn optional_project_read_does_not_ignore_a_pending_group_without_settings() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join(".kcoder/settings.json");
    let journal = path.with_file_name(crate::imported_credentials::GROUP_JOURNAL);
    write_json_atomic(&journal, &serde_json::json!({}), true).unwrap();
    assert!(crate::read_settings_file_if_present(&path).is_err());
    assert!(journal.exists());
    assert!(!path.exists());
}
