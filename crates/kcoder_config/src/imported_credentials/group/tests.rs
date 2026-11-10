use super::*;

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
const ID: &str = "group-0123456789abcdef0123456789abcdef";
const KEY: &str = "SYNTHETIC_STAGED_KEY_MUST_STAY_PRIVATE";
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

#[test]
fn staged_keys_are_private_and_inactive_until_the_group_commits() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    let before = CredentialStore::load_from(&root.path().join("credentials.json")).unwrap();
    assert!(!before.credentials.contains_key("Imported"));
    assert!(!format!("{before:?}").contains(KEY));
    let receipt = store
        .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
        .unwrap();
    assert_eq!(receipt.outcome, CredentialGroupOutcome::Committed);
    assert!(!serde_json::to_string(&receipt).unwrap().contains(KEY));
    assert_eq!(
        CredentialStore::load_from(&root.path().join("credentials.json"))
            .unwrap()
            .credentials["Imported"],
        KEY
    );
    assert_eq!(
        crate::read_settings_file(&root.path().join("settings.json")).unwrap()["max_retries"],
        41
    );
    assert_eq!(
        store
            .publish_group(
                ID,
                std::slice::from_ref(&reference),
                &NoBackend,
                |_| panic!("a committed operation must not replay")
            )
            .unwrap(),
        receipt
    );
    assert_eq!(
        store.undo(&reference, &NoBackend).unwrap_err().to_string(),
        "credential_import_referenced"
    );
}

#[test]
fn interruption_before_the_settings_rename_restores_the_complete_old_view() {
    for point in [1, 2] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        std::fs::write(
            &path,
            "{\n// preserve this comment\n\"max_retries\":40\n}\n",
        )
        .unwrap();
        let original = std::fs::read(&path).unwrap();
        let (store, reference) = staged(root.path());
        FAIL_AT.with(|value| value.set(point));
        assert!(
            store
                .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
                .is_err()
        );
        assert!(
            !std::fs::read_to_string(root.path().join(JOURNAL))
                .unwrap()
                .contains(KEY)
        );
        // This is the ordinary settings reader, not a migration-specific recovery facade.
        assert_eq!(crate::read_settings_file(&path).unwrap()["max_retries"], 40);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let credentials =
            CredentialStore::load_from(&root.path().join("credentials.json")).unwrap();
        assert!(!credentials.credentials.contains_key("Imported"));
        assert_eq!(
            store.group_receipt(ID).unwrap().unwrap().outcome,
            CredentialGroupOutcome::Aborted
        );
        assert!(
            store
                .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
                .is_err()
        );
        store.undo(&reference, &NoBackend).unwrap();
        assert!(
            !std::fs::read_to_string(root.path().join("credentials.json"))
                .unwrap()
                .contains(KEY)
        );
    }
}

#[test]
fn interruption_after_the_settings_rename_recovers_the_owned_receipt_without_replaying() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    FAIL_AT.with(|value| value.set(3));
    assert!(
        store
            .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
            .is_err()
    );
    assert_eq!(
        crate::read_settings_file(&root.path().join("settings.json")).unwrap()["max_retries"],
        41
    );
    assert_eq!(
        store.group_receipt(ID).unwrap().unwrap().outcome,
        CredentialGroupOutcome::Committed
    );
    assert_eq!(
        store.state(&reference, &NoBackend).unwrap(),
        Some(ImportState::Published)
    );
    assert!(!root.path().join(JOURNAL).exists());
}

#[test]
fn a_user_replacement_of_the_old_settings_file_cannot_be_mistaken_for_an_unexecuted_rename() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    std::fs::write(&path, "{\"max_retries\":40}").unwrap();
    let (store, reference) = staged(root.path());
    FAIL_AT.with(|value| value.set(2));
    assert!(
        store
            .publish_group(ID, &[reference], &NoBackend, change)
            .is_err()
    );
    std::fs::write(
        root.path().join("user-replacement.json"),
        "{\"max_retries\":40}",
    )
    .unwrap();
    std::fs::rename(root.path().join("user-replacement.json"), &path).unwrap();
    assert!(crate::read_settings_file(&path).is_err());
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\"max_retries\":40}"
    );
    assert!(root.path().join(JOURNAL).exists());
}

#[test]
fn recovery_preserves_a_user_replacement_of_a_credential_binding() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    FAIL_AT.with(|value| value.set(2));
    assert!(
        store
            .publish_group(ID, &[reference], &NoBackend, change)
            .is_err()
    );
    let path = root.path().join("credentials.json");
    let mut document = CredentialStore::load_from(&path).unwrap();
    document
        .set_api_key("Imported", "SYNTHETIC_USER_KEY".into())
        .unwrap();
    document.save_to(&path).unwrap();
    assert!(crate::read_settings_file(&root.path().join("settings.json")).is_err());
    assert_eq!(
        CredentialStore::load_from(&path).unwrap().credentials["Imported"],
        "SYNTHETIC_USER_KEY"
    );
}

#[test]
fn the_normal_layered_loader_never_restores_a_split_provider_and_key_snapshot() {
    for point in [2, 3] {
        let root = tempfile::tempdir().unwrap();
        let (store, reference) = staged(root.path());
        FAIL_AT.with(|value| value.set(point));
        assert!(
            store
                .publish_group(ID, &[reference], &NoBackend, change)
                .is_err()
        );
        let settings = crate::SettingsLoader::new(root.path())
            .with_config_dir(root.path())
            .with_executable_dir(root.path().join("no-executable-config"))
            .load()
            .unwrap()
            .settings;
        if point == 2 {
            assert!(!settings.providers.contains_key("Imported"));
            assert!(
                !settings
                    .stored_provider_credentials
                    .contains_key("Imported")
            );
        } else {
            assert!(settings.providers.contains_key("Imported"));
            assert_eq!(settings.stored_provider_credentials["Imported"], KEY);
        }
    }
}

#[test]
fn recovery_does_not_remove_a_replaced_prepared_file() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    FAIL_AT.with(|value| value.set(1));
    assert!(
        store
            .publish_group(ID, &[reference], &NoBackend, change)
            .is_err()
    );
    let prepared = root.path().join(prepared_name(ID));
    let retained = std::fs::File::open(&prepared).unwrap();
    std::fs::remove_file(&prepared).unwrap();
    std::fs::write(&prepared, "USER_REPLACEMENT_MUST_NOT_BE_REMOVED").unwrap();
    drop(retained);
    crate::read_settings_file(&root.path().join("settings.json")).unwrap();
    assert_eq!(
        std::fs::read_to_string(&prepared).unwrap(),
        "USER_REPLACEMENT_MUST_NOT_BE_REMOVED"
    );
}

#[derive(Default)]
struct MemoryBackend {
    keys: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
    sets: std::sync::atomic::AtomicUsize,
    lose_reply: std::sync::atomic::AtomicBool,
}
impl CredentialBackend for MemoryBackend {
    fn describe(&self) -> String {
        "owned-memory-keyring".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, name: &str) -> Result<Option<String>> {
        Ok(self.keys.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<()> {
        use std::sync::atomic::Ordering;
        self.sets.fetch_add(1, Ordering::SeqCst);
        self.keys.lock().unwrap().insert(name.into(), value.into());
        ensure!(
            !self.lose_reply.swap(false, Ordering::SeqCst),
            "lost_test_keyring_reply"
        );
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<()> {
        self.keys.lock().unwrap().remove(name);
        Ok(())
    }
}

#[test]
fn a_staged_keyring_reply_loss_is_reconciled_without_a_second_set_or_plaintext_file() {
    use std::sync::atomic::Ordering;
    let root = tempfile::tempdir().unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let backend = MemoryBackend::default();
    let reference = store
        .prepare("Imported", CredentialStoreMode::Keyring, &backend)
        .unwrap();
    backend.lose_reply.store(true, Ordering::SeqCst);
    assert!(store.stage(&reference, KEY, &backend).is_err());
    store.stage(&reference, KEY, &backend).unwrap();
    assert_eq!(backend.sets.load(Ordering::SeqCst), 1);
    FAIL_AT.with(|value| value.set(2));
    assert!(
        store
            .publish_group(ID, std::slice::from_ref(&reference), &backend, |document| {
                change(document)?;
                document["credential_store"] = serde_json::json!("keyring");
                Ok(())
            })
            .is_err()
    );
    crate::read_settings_file(&root.path().join("settings.json")).unwrap();
    for entry in std::fs::read_dir(root.path()).unwrap() {
        let entry = entry.unwrap();
        assert!(
            !std::fs::read(entry.path())
                .unwrap()
                .windows(KEY.len())
                .any(|part| part == KEY.as_bytes())
        );
    }
    store.undo(&reference, &backend).unwrap();
    assert!(backend.keys.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_dangling_recovery_journal_is_rejected_instead_of_ignored() {
    let root = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(root.path().join("missing"), root.path().join(JOURNAL)).unwrap();
    assert!(crate::read_settings_file(&root.path().join("settings.json")).is_err());
}

#[test]
fn credential_changes_during_preflight_are_preserved_before_any_group_is_published() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    let path = root.path().join("credentials.json");
    let error = store
        .publish_group(ID, &[reference], &NoBackend, |document| {
            let mut current = CredentialStore::load_from(&path)?;
            current.set_api_key("Unrelated", "SYNTHETIC_USER_ADDED_KEY".into())?;
            current.save_to(&path)?;
            change(document)
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "credential_group_credentials_changed");
    assert_eq!(
        CredentialStore::load_from(&path).unwrap().credentials["Unrelated"],
        "SYNTHETIC_USER_ADDED_KEY"
    );
    assert!(!root.path().join("settings.json").exists());
    assert!(!root.path().join(JOURNAL).exists());
}

#[test]
fn final_receipt_capacity_is_checked_before_a_partial_group_can_be_written() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    let path = root.path().join("credentials.json");
    let mut current = CredentialStore::load_from(&path).unwrap();
    current.set_api_key("Existing", "X".into()).unwrap();
    let overhead = serde_json::to_vec(&current).unwrap().len() - 1;
    current
        .set_api_key("Existing", "X".repeat(MAX_BYTES as usize - overhead - 128))
        .unwrap();
    current.save_to(&path).unwrap();
    let original = std::fs::read(&path).unwrap();
    assert_eq!(
        store
            .publish_group(ID, &[reference], &NoBackend, change)
            .unwrap_err()
            .to_string(),
        "credential_import_budget_exceeded"
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert!(!root.path().join("settings.json").exists());
    assert!(!root.path().join(JOURNAL).exists());
}

#[test]
fn copied_group_metadata_cannot_confer_authority_in_a_different_profile() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    store
        .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
        .unwrap();
    let destination = other.path().join("credentials.json");
    CredentialStore::load_from(&root.path().join("credentials.json"))
        .unwrap()
        .save_to(&destination)
        .unwrap();
    let before = std::fs::read(&destination).unwrap();
    let target = ImportedCredentialStore::open(other.path()).unwrap();
    assert_eq!(
        target.group_receipt(ID).unwrap_err().to_string(),
        "credential_import_wrong_profile"
    );
    assert!(
        target
            .publish_group(ID, &[reference], &NoBackend, change)
            .is_err()
    );
    assert_eq!(std::fs::read(&destination).unwrap(), before);
    assert!(!other.path().join("settings.json").exists());
}

fn remove_import(document: &mut Value) -> Result<()> {
    *document = serde_json::json!({});
    Ok(())
}

#[test]
fn group_undo_deactivates_the_pair_before_owned_secret_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    store
        .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
        .unwrap();
    assert_eq!(
        store
            .undo_group(ID, &NoBackend, remove_import)
            .unwrap()
            .outcome,
        CredentialGroupOutcome::Undone
    );
    assert_eq!(
        crate::read_settings_file(&root.path().join("settings.json")).unwrap(),
        serde_json::json!({})
    );
    let saved = CredentialStore::load_from(&root.path().join("credentials.json")).unwrap();
    assert!(!saved.credentials.contains_key("Imported"));
    assert_eq!(
        store.state(&reference, &NoBackend).unwrap(),
        Some(ImportState::Undoing)
    );
    store.undo(&reference, &NoBackend).unwrap();
    assert!(
        !std::fs::read_to_string(root.path().join("credentials.json"))
            .unwrap()
            .contains(KEY)
    );
    assert_eq!(
        store
            .undo_group(ID, &NoBackend, |_| panic!(
                "a completed undo must not replay"
            ))
            .unwrap()
            .outcome,
        CredentialGroupOutcome::Undone
    );
}

#[test]
fn interrupted_group_undo_restores_one_complete_view_without_deleting_a_backend_entry() {
    for point in [4, 5, 6] {
        let root = tempfile::tempdir().unwrap();
        let (store, reference) = staged(root.path());
        store
            .publish_group(ID, std::slice::from_ref(&reference), &NoBackend, change)
            .unwrap();
        FAIL_AT.with(|value| value.set(point));
        assert!(store.undo_group(ID, &NoBackend, remove_import).is_err());
        let settings = crate::SettingsLoader::new(root.path())
            .with_config_dir(root.path())
            .with_executable_dir(root.path().join("no-executable-config"))
            .load()
            .unwrap()
            .settings;
        let retained = point != 6;
        assert_eq!(settings.providers.contains_key("Imported"), retained);
        assert_eq!(
            settings
                .stored_provider_credentials
                .contains_key("Imported"),
            retained
        );
        assert_eq!(
            store.group_receipt(ID).unwrap().unwrap().outcome,
            if retained {
                CredentialGroupOutcome::Committed
            } else {
                CredentialGroupOutcome::Undone
            }
        );
        store.undo_group(ID, &NoBackend, remove_import).unwrap();
        store.undo(&reference, &NoBackend).unwrap();
        assert!(!root.path().join(JOURNAL).exists());
    }
}

#[test]
fn group_undo_preserves_user_edits_and_replacement_keys() {
    let root = tempfile::tempdir().unwrap();
    let (store, reference) = staged(root.path());
    store
        .publish_group(ID, &[reference], &NoBackend, change)
        .unwrap();
    let path = root.path().join("settings.json");
    crate::update_settings_file(&path, |document| {
        document["max_retries"] = serde_json::json!(99);
        Ok(())
    })
    .unwrap();
    assert_eq!(
        store
            .undo_group(ID, &NoBackend, remove_import)
            .unwrap_err()
            .to_string(),
        "credential_group_settings_changed"
    );
    assert_eq!(crate::read_settings_file(&path).unwrap()["max_retries"], 99);
    crate::update_settings_file(&path, |document| {
        document["max_retries"] = serde_json::json!(41);
        Ok(())
    })
    .unwrap();
    let credentials = root.path().join("credentials.json");
    CredentialStore::update_file(&credentials, |store| {
        store.set_api_key("Imported", "SYNTHETIC_USER_REPLACEMENT".into())
    })
    .unwrap();
    assert_eq!(
        store
            .undo_group(ID, &NoBackend, remove_import)
            .unwrap_err()
            .to_string(),
        "credential_import_target_changed"
    );
    assert_eq!(
        CredentialStore::load_from(&credentials)
            .unwrap()
            .credentials["Imported"],
        "SYNTHETIC_USER_REPLACEMENT"
    );
    assert!(crate::read_settings_file(&path).unwrap()["providers"]["Imported"].is_object());
}
