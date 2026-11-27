use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc,
};

const ID: &str = "group-0123456789abcdef0123456789abcdef";
const KEY: &str = "SYNTHETIC_COORDINATED_CREDENTIAL";
struct NoBackend;
impl CredentialBackend for NoBackend {
    fn describe(&self) -> String {
        "no-backend-allowed".into()
    }
    fn available(&self) -> bool {
        panic!("file mode must not probe a keyring")
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        panic!("file mode must not read a keyring")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        panic!("file mode must not write a keyring")
    }
    fn delete(&self, _: &str) -> Result<()> {
        panic!("file mode must not delete a keyring")
    }
}
fn staged(root: &Path) -> (ImportedCredentialStore, CredentialImportRef) {
    let store = ImportedCredentialStore::open(root).unwrap();
    let reference = store
        .prepare("Imported", CredentialStoreMode::File, &NoBackend)
        .unwrap();
    store.stage(&reference, KEY, &NoBackend).unwrap();
    (store, reference)
}
fn change(document: &mut Value) -> Result<()> {
    document["max_retries"] = serde_json::json!(41);
    document["providers"] = serde_json::json!({"Imported":{
        "api_format":"anthropic_messages","endpoint":"https://example.invalid",
        "default_model":"fixture","context_window_tokens":64000,
        "max_output_tokens":8192,"output_headroom_tokens":8192
    }});
    document["active_provider"] = serde_json::json!("Imported");
    document["credential_store"] = serde_json::json!("file");
    Ok(())
}
struct ReaderLease {
    _file: Option<std::fs::File>,
    release: Option<mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for ReaderLease {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release.send(()).unwrap();
        }
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
    }
}
fn reader(root: &Path, name: &str) -> ReaderLease {
    if name == ".provider-transaction.json.lock" {
        // Hold the formal native read snapshot across its inspection callback.
        let path = root.to_path_buf();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            ProfileSettingsFile::new(PrivateDirectory::open_existing(&path).unwrap())
                .unwrap()
                .inspect_locked(|_| {
                    ready_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(())
                })
                .unwrap();
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        ReaderLease {
            _file: None,
            release: Some(release_tx),
            thread: Some(thread),
        }
    } else {
        let file = PrivateDirectory::open_existing(root)
            .unwrap()
            .try_shared_lock(OsStr::new(name))
            .unwrap()
            .unwrap();
        ReaderLease {
            _file: Some(file),
            release: None,
            thread: None,
        }
    }
}
fn after_short_reader<T: Send>(root: &Path, name: &str, work: impl FnOnce() -> T + Send) -> T {
    let lease = reader(root, name);
    std::thread::scope(|scope| {
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = scope.spawn(move || {
            ready_tx.send(()).unwrap();
            work()
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        drop(lease);
        worker.join().unwrap()
    })
}

#[test]
fn coordination_short_readers_do_not_turn_group_publication_into_an_unknown_outcome() {
    for name in [
        ".provider-transaction.json.lock",
        "settings.json.lock",
        "credentials.json.lock",
    ] {
        let root = tempfile::tempdir().unwrap();
        let (store, reference) = staged(root.path());
        let callbacks = AtomicUsize::new(0);
        let result = after_short_reader(root.path(), name, || {
            store.publish_group(
                ID,
                std::slice::from_ref(&reference),
                &NoBackend,
                |document| {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                    change(document)
                },
            )
        })
        .unwrap();
        assert_eq!(callbacks.load(Ordering::SeqCst), 1);
        assert_eq!(result.outcome, CredentialGroupOutcome::Committed);
        assert_eq!(
            store.state(&reference, &NoBackend).unwrap(),
            Some(ImportState::Published)
        );
        assert_eq!(
            store
                .publish_group(
                    ID,
                    std::slice::from_ref(&reference),
                    &NoBackend,
                    |_| panic!("a committed publication must not replay its callback")
                )
                .unwrap(),
            result
        );
    }
}

#[test]
fn coordination_persistent_readers_do_not_enter_callbacks_or_change_private_state() {
    for name in [
        ".provider-transaction.json.lock",
        "settings.json.lock",
        "credentials.json.lock",
    ] {
        let root = tempfile::tempdir().unwrap();
        let (store, reference) = staged(root.path());
        let before = std::fs::read(root.path().join("credentials.json")).unwrap();
        let lease = reader(root.path(), name);
        let callbacks = AtomicUsize::new(0);
        let error = store
            .publish_group(ID, &[reference], &NoBackend, |_| {
                callbacks.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "credential_import_busy");
        assert_eq!(callbacks.load(Ordering::SeqCst), 0);
        assert_eq!(
            std::fs::read(root.path().join("credentials.json")).unwrap(),
            before
        );
        assert!(!root.path().join("settings.json").exists());
        assert!(!root.path().join(JOURNAL).exists());
        drop(lease);
    }
}

#[test]
fn coordination_wait_never_retries_a_cancelled_callback_or_a_lost_publication_receipt() {
    for cancelled in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let (store, reference) = staged(root.path());
        let callbacks = AtomicUsize::new(0);
        let error = after_short_reader(root.path(), ".provider-transaction.json.lock", || {
            if !cancelled {
                FAIL_AT.with(|value| value.set(3));
            }
            store.publish_group(
                ID,
                std::slice::from_ref(&reference),
                &NoBackend,
                |document| {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                    ensure!(!cancelled, "migration_cancelled");
                    change(document)
                },
            )
        })
        .unwrap_err();
        assert_eq!(callbacks.load(Ordering::SeqCst), 1);
        if cancelled {
            assert_eq!(error.to_string(), "migration_cancelled");
            assert!(!root.path().join("settings.json").exists());
            assert_eq!(store.group_receipt(ID).unwrap(), None);
            assert_eq!(
                store.state(&reference, &NoBackend).unwrap(),
                Some(ImportState::Staged)
            );
        } else {
            assert!(root.path().join(JOURNAL).exists());
            assert_eq!(
                store.group_receipt(ID).unwrap().unwrap().outcome,
                CredentialGroupOutcome::Committed
            );
            assert_eq!(
                store
                    .publish_group(
                        ID,
                        std::slice::from_ref(&reference),
                        &NoBackend,
                        |_| panic!("a lost acknowledgement must reconcile without replay")
                    )
                    .unwrap()
                    .outcome,
                CredentialGroupOutcome::Committed
            );
        }
        assert_eq!(callbacks.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn coordination_readers_over_the_old_window_still_publish_exactly_once() {
    for name in [
        ".provider-transaction.json.lock",
        "settings.json.lock",
        "credentials.json.lock",
    ] {
        let root = tempfile::tempdir().unwrap();
        let (store, reference) = staged(root.path());
        let held = reader(root.path(), name);
        let callbacks = AtomicUsize::new(0);
        let receipt = std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel();
            let store = &store;
            let reference = &reference;
            let callbacks = &callbacks;
            let worker = scope.spawn(move || {
                tx.send(()).unwrap();
                store.publish_group(
                    ID,
                    std::slice::from_ref(reference),
                    &NoBackend,
                    |document| {
                        callbacks.fetch_add(1, Ordering::SeqCst);
                        change(document)
                    },
                )
            });
            rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(120));
            drop(held);
            worker.join().unwrap()
        })
        .unwrap();
        assert_eq!(callbacks.load(Ordering::SeqCst), 1);
        assert_eq!(receipt.outcome, CredentialGroupOutcome::Committed);
        assert_eq!(
            store.state(&reference, &NoBackend).unwrap(),
            Some(ImportState::Published)
        );
        assert_eq!(store.group_receipt(ID).unwrap().as_ref(), Some(&receipt));
    }
}
#[test]
fn coordination_observation_waits_for_a_short_existing_credentials_writer() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    let held = directory
        .try_exclusive_lock(OsStr::new("credentials.json.lock"))
        .unwrap()
        .unwrap();
    let state = std::thread::scope(|scope| {
        let (tx, rx) = mpsc::channel();
        let store = &store;
        let reference = &reference;
        let worker = scope.spawn(move || {
            tx.send(()).unwrap();
            store.state(reference, &NoBackend)
        });
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(120));
        drop(held);
        worker.join().unwrap()
    })
    .unwrap();
    assert_eq!(state, Some(ImportState::Staged));
}
