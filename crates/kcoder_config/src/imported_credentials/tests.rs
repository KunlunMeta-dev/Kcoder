use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

#[derive(Default)]
struct Backend {
    keys: Mutex<BTreeMap<String, String>>,
    calls: Mutex<Vec<&'static str>>,
    available: bool,
    fail_set: AtomicBool,
    fail_delete: AtomicBool,
}
impl CredentialBackend for Backend {
    fn describe(&self) -> String {
        "isolated-memory-backend".into()
    }
    fn available(&self) -> bool {
        self.calls.lock().unwrap().push("available");
        self.available
    }
    fn get(&self, account: &str) -> Result<Option<String>> {
        self.calls.lock().unwrap().push("get");
        Ok(self.keys.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, key: &str) -> Result<()> {
        self.calls.lock().unwrap().push("set");
        self.keys.lock().unwrap().insert(account.into(), key.into());
        ensure!(
            !self.fail_set.swap(false, Ordering::SeqCst),
            "injected_lost_backend_reply"
        );
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<()> {
        self.calls.lock().unwrap().push("delete");
        self.keys.lock().unwrap().remove(account);
        ensure!(
            !self.fail_delete.swap(false, Ordering::SeqCst),
            "injected_lost_backend_delete_reply"
        );
        Ok(())
    }
}

#[test]
fn file_import_is_atomic_idempotent_private_and_does_not_call_a_keyring() {
    let root = tempfile::tempdir().unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = Backend::default();
    let reference = store
        .prepare("Imported", CredentialStoreMode::File, &backend)
        .unwrap();
    let key = "SYNTHETIC_FILE_CREDENTIAL_CANARY";
    assert_eq!(
        store
            .install(&reference, key, &backend, |_| Ok(()))
            .unwrap(),
        ImportState::Published
    );
    assert_eq!(
        store
            .install(&reference, key, &backend, |_| Ok(()))
            .unwrap(),
        ImportState::Published
    );
    let saved = CredentialStore::load_from(&root.path().join("credentials.json")).unwrap();
    assert_eq!(saved.credentials["Imported"], key);
    assert!(!format!("{saved:?}").contains(key));
    assert!(!serde_json::to_string(&reference).unwrap().contains(key));
    for entry in std::fs::read_dir(root.path()).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != "credentials.json" {
            assert!(
                !std::fs::read(entry.path())
                    .unwrap()
                    .windows(key.len())
                    .any(|bytes| bytes == key.as_bytes())
            );
        }
    }
    assert_eq!(
        store.undo(&reference, &backend).unwrap(),
        ImportState::Undone
    );
    assert_eq!(
        store.undo(&reference, &backend).unwrap(),
        ImportState::Undone
    );
    assert!(
        store
            .install(&reference, key, &backend, |_| Ok(()))
            .is_err()
    );
    assert!(backend.calls.lock().unwrap().is_empty());
}

#[test]
fn keyring_reply_loss_reconciles_and_undo_reply_loss_cannot_reinstall_the_key() {
    let root = tempfile::tempdir().unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = Backend {
        available: true,
        ..Default::default()
    };
    let reference = store
        .prepare("Imported", CredentialStoreMode::Keyring, &backend)
        .unwrap();
    let key = "SYNTHETIC_KEYRING_CREDENTIAL_CANARY";
    backend.fail_set.store(true, Ordering::SeqCst);
    assert!(
        store
            .install(&reference, key, &backend, |_| Ok(()))
            .is_err()
    );
    assert_eq!(
        store.state(&reference, &backend).unwrap(),
        Some(ImportState::Staged)
    );
    assert!(
        !std::fs::read_to_string(root.path().join("credentials.json"))
            .unwrap()
            .contains(key)
    );
    store
        .install(&reference, key, &backend, |_| Ok(()))
        .unwrap();
    assert_eq!(
        backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| **call == "set")
            .count(),
        1
    );
    let saved = CredentialStore::load_from(&root.path().join("credentials.json")).unwrap();
    let (resolved, _) = crate::resolve_stored_credentials(
        &saved.credentials,
        &backend,
        CredentialStoreMode::Keyring,
    );
    assert_eq!(resolved["Imported"], key);
    backend.fail_delete.store(true, Ordering::SeqCst);
    assert!(store.undo(&reference, &backend).is_err());
    assert_eq!(
        store.state(&reference, &backend).unwrap(),
        Some(ImportState::Undoing)
    );
    assert!(
        store
            .install(&reference, key, &backend, |_| Ok(()))
            .is_err()
    );
    assert_eq!(
        store.undo(&reference, &backend).unwrap(),
        ImportState::Undone
    );
    assert!(
        !backend
            .keys
            .lock()
            .unwrap()
            .contains_key(&reference.account)
    );
}

#[test]
fn forced_keyring_never_falls_back_and_existing_names_and_user_edits_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = Backend::default();
    assert!(
        store
            .prepare("Imported", CredentialStoreMode::Keyring, &backend)
            .is_err()
    );
    assert!(!root.path().join("credentials.json").exists());
    let reference = store
        .prepare("Imported", CredentialStoreMode::File, &backend)
        .unwrap();
    store
        .install(&reference, "SYNTHETIC_IMPORT_KEY", &backend, |_| Ok(()))
        .unwrap();
    CredentialStore::update_file(&root.path().join("credentials.json"), |credentials| {
        credentials.set_api_key("Imported", "SYNTHETIC_USER_REPLACEMENT".into())
    })
    .unwrap();
    assert!(store.undo(&reference, &backend).is_err());
    assert!(
        store
            .prepare("Imported", CredentialStoreMode::File, &backend)
            .is_err()
    );
    assert_eq!(
        CredentialStore::load_from(&root.path().join("credentials.json"))
            .unwrap()
            .credentials["Imported"],
        "SYNTHETIC_USER_REPLACEMENT"
    );
}

#[test]
fn destination_checks_and_profile_binding_run_before_any_secret_is_published() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = Backend::default();
    let reference = store
        .prepare("Imported", CredentialStoreMode::File, &backend)
        .unwrap();
    assert!(
        store
            .install(&reference, "SYNTHETIC_KEY", &backend, |_| anyhow::bail!(
                "provider_changed"
            ))
            .is_err()
    );
    assert!(!root.path().join("credentials.json").exists());
    assert!(
        ImportedCredentialStore::open(other.path())
            .unwrap()
            .install(&reference, "SYNTHETIC_KEY", &backend, |_| Ok(()))
            .is_err()
    );
    assert!(!other.path().join("credentials.json").exists());
}
