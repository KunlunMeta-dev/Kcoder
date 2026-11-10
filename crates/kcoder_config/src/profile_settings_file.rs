//! Handle-relative user settings edits sharing the normal configuration locks.
use crate::{PrivateDirectory, validate_and_resolve_settings_document};
use anyhow::{Result, ensure};
use jsonc_parser::cst::CstRootNode;
use serde_json::{Value, json};
use std::{ffi::OsStr, fs::File, io::Read};

mod locking;
mod project;

const MAX_BYTES: u64 = 16 * 1024 * 1024;

/// The host binds the directory once; later renames cannot redirect reads or writes.
pub struct ProfileSettingsFile {
    directory: PrivateDirectory,
}

/// Credential groups share the same pinned lock identity and bounded wait as
/// normal configuration readers. Only acquisition repeats, never transactions.
pub(crate) fn acquire_imported_credential_lease(
    directory: &PrivateDirectory,
    name: &OsStr,
    exclusive: bool,
) -> Result<File> {
    locking::acquire(directory, name, exclusive).map_err(|error| match error.to_string().as_str() {
        "settings_busy" => anyhow::anyhow!("credential_import_busy"),
        "settings_lock_changed" => anyhow::anyhow!("credential_import_lock_changed"),
        _ => error,
    })
}

impl ProfileSettingsFile {
    /// Retain the caller's verified directory handle without reopening a path.
    pub fn from_directory_handle(directory: &PrivateDirectory) -> Result<Self> {
        Self::new(directory.try_clone()?)
    }
    pub fn directory_identity(&self) -> Result<String> {
        self.directory.directory_identity()
    }
    pub fn new(directory: PrivateDirectory) -> Result<Self> {
        directory.verify_trusted_config_directory()?;
        Ok(Self { directory })
    }

    pub fn read(&self) -> Result<Value> {
        self.inspect_locked(|document| Ok(document.clone()))
    }

    /// Keep the coordinated read snapshot stable while publishing a dependent native resource.
    pub fn inspect_locked<T>(&self, inspect: impl FnOnce(&Value) -> Result<T>) -> Result<T> {
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        crate::imported_credentials::recover_group_in(&self.directory)?;
        self.require_recovered_provider_transaction()?;
        let _settings = self.lock("settings.json.lock", false)?;
        inspect(&self.read_document()?.1)
    }

    /// Inspect bookkeeping only; keyring markers must never resolve secrets during migration.
    pub fn has_stored_credential_namespace(&self, name: &str) -> Result<bool> {
        let _credentials = self.lock("credentials.json.lock", false)?;
        let file = match self
            .directory
            .open_single_link_regular_file(OsStr::new("credentials.json"))
        {
            Ok(file) => file,
            Err(error) if is_missing(&error) => return Ok(false),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() <= MAX_BYTES,
            "credential metadata exceeds budget"
        );
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "credential metadata exceeds budget"
        );
        let document: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid credential metadata"))?;
        let root = document
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("invalid credential metadata"))?;
        Ok(root.contains_key(name)
            || root
                .get(crate::imported_credentials::NAMESPACE)
                .and_then(|document| document.get("receipts"))
                .and_then(Value::as_object)
                .is_some_and(|receipts| {
                    receipts.values().any(|receipt| {
                        receipt
                            .pointer("/reference/provider")
                            .and_then(Value::as_str)
                            == Some(name)
                            && receipt
                                .pointer("/reference/subject/kind")
                                .and_then(Value::as_str)
                                != Some("mcp")
                            && receipt.get("state").and_then(Value::as_str) != Some("undone")
                    })
                })
            || root
                .get("api_keys")
                .and_then(Value::as_object)
                .is_some_and(|keys| keys.contains_key(name)))
    }

    /// The callback and publication run under the same locks as path-based settings writers.
    /// A pending paired credentials transaction must be recovered by the ordinary loader first.
    pub fn update(&self, update: impl FnOnce(&mut Value) -> Result<()>) -> Result<Value> {
        self.update_validated(update, |_, next| {
            validate_and_resolve_settings_document(next).map(|_| ())
        })
    }

    fn update_validated(
        &self,
        update: impl FnOnce(&mut Value) -> Result<()>,
        validate: impl FnOnce(&Value, &Value) -> Result<()>,
    ) -> Result<Value> {
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        crate::imported_credentials::recover_group_in(&self.directory)?;
        self.require_recovered_provider_transaction()?;
        let _settings = self.lock("settings.json.lock", true)?;
        let (source, original) = self.read_document()?;
        crate::migrations::validate_version(&original)?;
        let mut next = original.clone();
        update(&mut next)?;
        validate(&original, &next)?;
        if next == original {
            return Ok(next);
        }
        let rendered = render_settings_update(source.as_deref(), &original, &next)?;
        self.directory
            .atomic_replace(OsStr::new("settings.json"), &rendered)?;
        Ok(next)
    }

    fn lock(&self, name: &str, exclusive: bool) -> Result<File> {
        locking::acquire(&self.directory, OsStr::new(name), exclusive)
    }

    fn require_recovered_provider_transaction(&self) -> Result<()> {
        match self
            .directory
            .open_regular_file(OsStr::new(".provider-transaction.json"))
        {
            Ok(_) => anyhow::bail!("settings_transaction_requires_recovery"),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn read_document(&self) -> Result<(Option<String>, Value)> {
        let file = match self
            .directory
            .open_regular_file(OsStr::new("settings.json"))
        {
            Ok(file) => file,
            Err(error) if is_missing(&error) => return Ok((None, json!({}))),
            Err(error) => return Err(error),
        };
        let metadata = file.metadata()?;
        ensure!(
            metadata.len() <= MAX_BYTES,
            "settings document exceeds budget"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid only observes the process identity.
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() } && metadata.nlink() == 1,
                "settings file must be owned and have one link"
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
            };
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            // SAFETY: the file owns a live handle and info is valid output storage.
            ensure!(
                unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut info) } != 0
                    && info.nNumberOfLinks == 1,
                "settings file must have one link"
            );
        }
        let mut source = String::new();
        file.take(MAX_BYTES + 1).read_to_string(&mut source)?;
        ensure!(
            source.len() as u64 <= MAX_BYTES,
            "settings document exceeds budget"
        );
        let value: Value = jsonc_parser::parse_to_serde_value(&source, &Default::default())?;
        ensure!(value.is_object(), "settings root must be an object");
        Ok((Some(source), value))
    }
}

fn is_missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

pub(crate) fn render_settings_update(
    source: Option<&str>,
    original: &Value,
    next: &Value,
) -> Result<Vec<u8>> {
    let rendered = match source {
        Some(source) => {
            let root = CstRootNode::parse(source, &Default::default())?;
            let object = root
                .object_value_or_create()
                .ok_or_else(|| anyhow::anyhow!("settings root must be an object"))?;
            crate::loader::reconcile_jsonc_object(
                &object,
                original
                    .as_object()
                    .ok_or_else(|| anyhow::anyhow!("invalid settings"))?,
                next.as_object()
                    .ok_or_else(|| anyhow::anyhow!("invalid settings"))?,
                "",
            )?;
            root.to_string()
        }
        None => format!("{}\n", serde_json::to_string_pretty(next)?),
    };
    ensure!(
        rendered.len() as u64 <= MAX_BYTES,
        "settings document exceeds budget"
    );
    let checked: Value = jsonc_parser::parse_to_serde_value(&rendered, &Default::default())?;
    ensure!(
        &checked == next,
        "settings edit did not reproduce the requested document"
    );
    Ok(rendered.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_short_reader_lease_delays_publication_without_replaying_the_update_callback() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
            mpsc,
        };
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("settings.json"), "{}").unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        let reader = directory
            .try_shared_lock(OsStr::new(".provider-transaction.json.lock"))
            .unwrap()
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let path = root.path().to_path_buf();
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let settings =
                ProfileSettingsFile::new(PrivateDirectory::open_existing(&path).unwrap()).unwrap();
            ready_tx.send(()).unwrap();
            settings.update(|value| {
                worker_calls.fetch_add(1, Ordering::SeqCst);
                value["max_retries"] = json!(42);
                Ok(())
            })
        });
        ready_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        drop(reader);
        assert_eq!(worker.join().unwrap().unwrap()["max_retries"], 42);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn persistent_contention_never_enters_the_update_callback_or_changes_settings() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("settings.json"), "{}").unwrap();
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        let _reader = directory
            .try_shared_lock(OsStr::new(".provider-transaction.json.lock"))
            .unwrap()
            .unwrap();
        let settings =
            ProfileSettingsFile::new(PrivateDirectory::open_existing(root.path()).unwrap())
                .unwrap();
        let mut called = false;
        let error = settings
            .update(|value| {
                called = true;
                value["max_retries"] = json!(42);
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "settings_busy");
        assert!(!called);
        assert_eq!(
            std::fs::read_to_string(root.path().join("settings.json")).unwrap(),
            "{}"
        );
    }
    #[test]
    fn comments_and_concurrent_changes_are_preserved() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("settings.json");
        std::fs::write(
            &path,
            "{\n// Keep this explanation.\n\"max_retries\": 40\n}\n",
        )
        .unwrap();
        let settings =
            ProfileSettingsFile::new(PrivateDirectory::open_existing(root.path()).unwrap())
                .unwrap();
        let before = settings.read().unwrap();
        crate::update_settings_file(&path, |value| {
            value["max_retries"] = json!(41);
            Ok(())
        })
        .unwrap();
        assert!(
            settings
                .update(|value| {
                    ensure!(*value == before, "conflict");
                    Ok(())
                })
                .is_err()
        );
        settings
            .update(|value| {
                value["max_retries"] = json!(42);
                Ok(())
            })
            .unwrap();
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("Keep this explanation.")
        );
        assert_eq!(crate::read_settings_file(&path).unwrap()["max_retries"], 42);
        std::fs::write(root.path().join(".provider-transaction.json"), "{}").unwrap();
        assert!(settings.read().is_err());
        assert!(settings.update(|_| Ok(())).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn directory_rename_cannot_redirect_publication_and_linked_leaves_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let moved = root.path().join("moved");
        std::fs::create_dir(&profile).unwrap();
        let settings =
            ProfileSettingsFile::new(PrivateDirectory::open_existing(&profile).unwrap()).unwrap();
        std::fs::rename(&profile, &moved).unwrap();
        std::fs::create_dir(&profile).unwrap();
        settings
            .update(|value| {
                value["max_retries"] = json!(43);
                Ok(())
            })
            .unwrap();
        assert!(!profile.join("settings.json").exists());
        assert!(moved.join("settings.json").exists());
        let linked = moved.join("settings.json");
        let saved = moved.join("other");
        std::fs::rename(&linked, &saved).unwrap();
        std::os::unix::fs::symlink(&saved, &linked).unwrap();
        assert!(settings.read().is_err());
        std::fs::remove_file(&linked).unwrap();
        std::fs::hard_link(&saved, &linked).unwrap();
        assert!(settings.update(|_| Ok(())).is_err());
    }
}
