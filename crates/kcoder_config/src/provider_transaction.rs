//! Recoverable paired settings/credential writes. Journal contents are private.
use super::*;

const JOURNAL: &str = ".provider-transaction.json";

#[cfg(test)]
thread_local! {
    static FAIL_BEFORE_CREDENTIAL_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_AFTER_CREDENTIAL_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    version: u32,
    #[serde(default)]
    committed: bool,
    settings_name: String,
    source: Option<String>,
    original: Value,
    next: Value,
    credentials: Option<CredentialStore>,
}

fn coordinator(path: &Path) -> Result<fs::File> {
    lock_settings_path(&path.with_file_name(".provider-transaction"))
}

fn read_pending(path: &Path) -> Result<Option<Pending>> {
    let path = path.with_file_name(JOURNAL);
    let parent = fs::canonicalize(
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new(".")),
    )?;
    let directory = crate::private_files::PrivateDirectory::open_existing(&parent)?;
    let file = match directory.open_regular_file(std::ffi::OsStr::new(JOURNAL)) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|e| {
                e.downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let info = file.metadata()?;
    anyhow::ensure!(
        info.len() <= 16 * 1024 * 1024,
        "Invalid provider transaction journal"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        anyhow::ensure!(
            info.permissions().mode() & 0o077 == 0 && info.uid() == unsafe { libc::geteuid() },
            "Provider transaction journal must be private and owned by this user"
        );
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 16 * 1024 * 1024,
        "Provider transaction journal exceeds limit"
    );
    let pending: Pending = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Invalid provider transaction journal"))?;
    anyhow::ensure!(
        pending.version == 1
            && Path::new(&pending.settings_name)
                .file_name()
                .and_then(|s| s.to_str())
                == Some(pending.settings_name.as_str())
            && pending.settings_name != "credentials.json"
            && pending.settings_name != JOURNAL,
        "Invalid provider transaction destination"
    );
    Ok(Some(pending))
}

fn recover_locked(path: &Path) -> Result<()> {
    let Some(mut pending) = read_pending(path)? else {
        return Ok(());
    };
    if pending.committed {
        fs::remove_file(path.with_file_name(JOURNAL))?;
        sync_parent(path)?;
        return Ok(());
    }
    let settings = path.with_file_name(&pending.settings_name);
    let credentials = path.with_file_name("credentials.json");
    let _settings_lock = lock_settings_path(&settings)?;
    let _credentials_lock = lock_settings_path(&credentials)?;
    validate_settings_document(&pending.next)?;
    if let Some(value) = &pending.credentials {
        value.save_to(&credentials)?;
    }
    write_jsonc_update_atomic(
        &settings,
        pending.source.as_deref(),
        &pending.original,
        &pending.next,
        true,
    )?;
    pending.committed = true;
    write_json_atomic(
        &path.with_file_name(JOURNAL),
        &serde_json::to_value(&pending)?,
        true,
    )?;
    fs::remove_file(path.with_file_name(JOURNAL))?;
    sync_parent(path)?;
    Ok(())
}

/// Hold for the complete layered read so a paired write cannot split its snapshot.
pub(super) fn read_guard(path: &Path) -> Result<Option<fs::File>> {
    let journal_exists = path.with_file_name(JOURNAL).try_exists()?;
    let guard = match coordinator(path) {
        Ok(guard) => guard,
        Err(error)
            if !journal_exists
                && error.chain().any(|cause| {
                    cause.downcast_ref::<std::io::Error>().is_some_and(|e| {
                        matches!(
                            e.kind(),
                            std::io::ErrorKind::PermissionDenied
                                | std::io::ErrorKind::ReadOnlyFilesystem
                        )
                    })
                }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error).context("Cannot lock or recover provider configuration"),
    };
    recover_locked(path)?;
    Ok(Some(guard))
}

pub(super) fn write_guard(path: &Path) -> Result<fs::File> {
    let guard = coordinator(path)?;
    recover_locked(path)?;
    Ok(guard)
}

pub(super) fn update<F>(path: &Path, update: F) -> Result<Value>
where
    F: FnOnce(&mut Value, &mut CredentialStore) -> Result<()>,
{
    let _coordinator = write_guard(path)?;
    let _settings_lock = lock_settings_path(path)?;
    let credential_path = path.with_file_name("credentials.json");
    let _credential_lock = lock_settings_path(&credential_path)?;
    let source = read_raw_optional_jsonc_object(path)?;
    let original = source
        .as_ref()
        .map(|s| s.value.clone())
        .unwrap_or_else(|| serde_json::json!({}));
    let credentials_existed = match fs::symlink_metadata(&credential_path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let previous_credentials = CredentialStore::load_from(&credential_path)?;
    let mut credentials = previous_credentials.clone();
    let mut next = original.clone();
    update(&mut next, &mut credentials)?;
    validate_settings_document(&next)?;
    let settings_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .context("Invalid settings filename")?
        .to_owned();
    let mut pending = Pending {
        version: 1,
        committed: false,
        settings_name,
        source: source.map(|s| s.source),
        original,
        next,
        credentials: (credentials != previous_credentials)
            .then_some(credentials),
    };
    let journal = path.with_file_name(JOURNAL);
    let journal_value = serde_json::to_value(&pending)?;
    anyhow::ensure!(
        serde_json::to_vec(&journal_value)?.len() <= 16 * 1024 * 1024,
        "Provider transaction exceeds the journal limit"
    );
    write_json_atomic(&journal, &journal_value, true)?;
    let result = (|| -> Result<()> {
        if let Some(credentials) = &pending.credentials {
            #[cfg(test)]
            if FAIL_BEFORE_CREDENTIAL_WRITE.with(|fail| fail.replace(false)) {
                bail!("injected credential write failure");
            }
            credentials.save_to(&credential_path)?;
        }
        #[cfg(test)]
        if FAIL_AFTER_CREDENTIAL_WRITE.with(|fail| fail.replace(false)) {
            bail!("injected failure after credential write");
        }
        write_jsonc_update_atomic(
            path,
            pending.source.as_deref(),
            &pending.original,
            &pending.next,
            true,
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        // Both locks are still held; a rollback cannot overwrite a concurrent writer.
        let restore_credentials = if pending.credentials.is_none() {
            Ok(())
        } else if credentials_existed {
            previous_credentials.save_to(&credential_path)
        } else {
            match fs::remove_file(&credential_path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            }
        };
        let rollback = restore_credentials.and_then(|_| {
            if let Some(source) = &pending.source {
                write_bytes_atomic(path, source.as_bytes(), true)
            } else {
                match fs::remove_file(path) {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(e.into()),
                }
            }
        });
        if rollback.is_ok() {
            pending.committed = true;
            write_json_atomic(&journal, &serde_json::to_value(&pending)?, true)?;
            fs::remove_file(&journal)?;
            sync_parent(path)?;
        } else {
            bail!(
                "[provider_transaction_pending] Save interrupted; reload to recover the private configuration transaction"
            );
        }
        return Err(error).context("Provider configuration save rolled back");
    }
    pending.committed = true;
    write_json_atomic(&journal, &serde_json::to_value(&pending)?, true).context(
        "[provider_transaction_pending] Configuration committed; reload to finish recovery",
    )?;
    fs::remove_file(&journal).context(
        "[provider_transaction_pending] Configuration committed; reload to finish recovery",
    )?;
    sync_parent(path)?;
    Ok(pending.next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_write_failure_preserves_pair_and_allows_retry() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let credential_path = path.with_file_name("credentials.json");
        let original = serde_json::json!({"model":"original"});
        write_json_atomic(&path, &original, true).unwrap();
        let store = CredentialStore {
            credentials: BTreeMap::from([("fixture".into(), "old-fixture".into())]),
            ..Default::default()
        };
        store.save_to(&credential_path).unwrap();
        let change = |settings: &mut Value, credentials: &mut CredentialStore| {
            settings["model"] = serde_json::json!("updated");
            credentials.set_api_key("fixture", "new-fixture".into())
        };
        FAIL_BEFORE_CREDENTIAL_WRITE.with(|fail| fail.set(true));
        let error = update(&path, change).unwrap_err();
        assert!(format!("{error:#}").contains("injected credential write failure"));
        {
            let _guard = read_guard(&path).unwrap();
            assert_eq!(
                read_raw_optional_json_object(&path).unwrap().unwrap(),
                original
            );
            assert!(CredentialStore::load_from(&credential_path).unwrap() == store);
        }
        assert!(!path.with_file_name(JOURNAL).exists());
        update(&path, change).unwrap();
        assert_eq!(
            read_raw_optional_json_object(&path).unwrap().unwrap()["model"],
            "updated"
        );
        assert!(
            CredentialStore::load_from(&credential_path).unwrap().credentials["fixture"]
                == "new-fixture"
        );
        assert!(!path.with_file_name(JOURNAL).exists());
    }

    #[test]
    fn interrupted_pair_is_recovered_before_read() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let credentials = CredentialStore {
            credentials: BTreeMap::from([("fixture".into(), "new-fixture".into())]),
            ..Default::default()
        };
        let pending = Pending {
            version: 1,
            committed: false,
            settings_name: "settings.json".into(),
            source: None,
            original: serde_json::json!({}),
            next: serde_json::json!({"model":"updated"}),
            credentials: Some(credentials),
        };
        write_json_atomic(
            &path.with_file_name(JOURNAL),
            &serde_json::to_value(pending).unwrap(),
            true,
        )
        .unwrap();
        let _guard = read_guard(&path).unwrap();
        assert_eq!(
            read_raw_optional_json_object(&path).unwrap().unwrap()["model"],
            "updated"
        );
        assert!(
            CredentialStore::load_from(&path.with_file_name("credentials.json"))
                .unwrap()
                .has_api_key("fixture")
        );
        assert!(!path.with_file_name(JOURNAL).exists());
    }

    #[test]
    fn failure_after_credential_write_restores_the_pair_and_removes_journal() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let credential_path = path.with_file_name("credentials.json");
        let original_source =
            "{\n  // Preserve the user's comments.\n  \"model\": \"original\"\n}\n";
        write_bytes_atomic(&path, original_source.as_bytes(), true).unwrap();
        let original_credentials = CredentialStore {
            credentials: BTreeMap::from([("fixture".into(), "old-fixture".into())]),
            ..Default::default()
        };
        original_credentials.save_to(&credential_path).unwrap();
        FAIL_AFTER_CREDENTIAL_WRITE.with(|fail| fail.set(true));
        let result = update(&path, |settings, credentials| {
            settings["model"] = serde_json::json!("changed");
            credentials.set_api_key("fixture", "new-fixture".into())?;
            credentials.set_api_key("added", "added-fixture".into())?;
            Ok(())
        });
        let error = result.unwrap_err();
        assert!(format!("{error:#}").contains("injected failure after credential write"));
        assert_eq!(fs::read_to_string(&path).unwrap(), original_source);
        assert_eq!(
            CredentialStore::load_from(&credential_path)
                .unwrap()
                .credentials,
            original_credentials.credentials
        );
        assert!(!path.with_file_name(JOURNAL).exists());
        assert!(!FAIL_AFTER_CREDENTIAL_WRITE.with(|fail| fail.get()));
    }

    #[test]
    fn credential_update_recovers_pending_pair_before_editing_another_provider() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let credential_path = path.with_file_name("credentials.json");
        let pending = Pending {
            version: 1,
            committed: false,
            settings_name: "settings.json".into(),
            source: None,
            original: serde_json::json!({}),
            next: serde_json::json!({"model":"recovered"}),
            credentials: Some(CredentialStore {
                credentials: BTreeMap::from([("fixture".into(), "recovered-fixture".into())]),
            ..Default::default()
            }),
        };
        write_json_atomic(
            &path.with_file_name(JOURNAL),
            &serde_json::to_value(pending).unwrap(),
            true,
        )
        .unwrap();
        CredentialStore::update_file(&credential_path, |credentials| {
            assert_eq!(
                credentials.credentials.get("fixture").map(String::as_str),
                Some("recovered-fixture")
            );
            credentials.set_api_key("other", "other-fixture".into())
        })
        .unwrap();
        // A later coordinated read must not replay a stale journal over the new key.
        let _guard = read_guard(&path).unwrap();
        assert_eq!(
            read_raw_optional_json_object(&path).unwrap().unwrap()["model"],
            "recovered"
        );
        let saved = CredentialStore::load_from(&credential_path).unwrap();
        assert_eq!(
            saved.credentials.get("fixture").map(String::as_str),
            Some("recovered-fixture")
        );
        assert_eq!(
            saved.credentials.get("other").map(String::as_str),
            Some("other-fixture")
        );
        assert!(!path.with_file_name(JOURNAL).exists());
    }

    #[cfg(unix)]
    #[test]
    fn model_only_save_preserves_an_existing_readonly_credential_link() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let vault = temp.path().join("vault.json");
        let store = CredentialStore {
            credentials: BTreeMap::from([("fixture".into(), "fixture-only".into())]),
            ..Default::default()
        };
        store.save_to(&vault).unwrap();
        let original = fs::read(&vault).unwrap();
        symlink(&vault, path.with_file_name("credentials.json")).unwrap();
        update(&path, |value, _| {
            *value = serde_json::json!({"model":"updated"});
            Ok(())
        })
        .unwrap();
        assert!(
            fs::symlink_metadata(path.with_file_name("credentials.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(fs::read(vault).unwrap(), original);
        assert!(!path.with_file_name(JOURNAL).exists());
    }

    #[test]
    fn interrupted_first_save_restores_missing_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        FAIL_AFTER_CREDENTIAL_WRITE.with(|fail| fail.set(true));
        assert!(
            update(&path, |value, credentials| {
                *value = serde_json::json!({"model":"updated"});
                credentials.set_api_key("fixture", "fixture-only".into())
            })
            .is_err()
        );
        assert!(!path.exists());
        assert!(!path.with_file_name("credentials.json").exists());
        assert!(!path.with_file_name(JOURNAL).exists());
    }

    #[test]
    fn validation_failure_does_not_rotate_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        let result = update(&path, |value, credentials| {
            credentials.set_api_key("fixture", "fixture-only".into())?;
            *value = serde_json::json!({"providers":"invalid"});
            Ok(())
        });
        assert!(result.is_err());
        assert!(!path.with_file_name("credentials.json").exists());
        assert!(!path.with_file_name(JOURNAL).exists());
    }
    #[test]
    fn failed_revocation_only_transaction_restores_authority_state() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.json");
        write_json_atomic(&path, &serde_json::json!({}), true).unwrap();
        let credentials_path = path.with_file_name("credentials.json");
        CredentialStore::default().save_to(&credentials_path).unwrap();
        FAIL_AFTER_CREDENTIAL_WRITE.with(|fail| fail.set(true));
        let result = update(&path, |_, credentials| {
            credentials.remove_api_key("fixture")?;
            Ok(())
        });
        assert!(result.is_err());
        assert!(CredentialStore::load_from(&credentials_path).unwrap().revoked.is_empty());
        update(&path, |_, credentials| {
            credentials.remove_api_key("fixture")?;
            Ok(())
        }).unwrap();
        assert!(CredentialStore::load_from(&credentials_path).unwrap().revoked.contains("fixture"));
    }

}
