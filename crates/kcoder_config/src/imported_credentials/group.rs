//! The settings rename is the publication point; recovery never serializes secret snapshots.
use super::*;
use crate::profile_settings_file::{ProfileSettingsFile, render_settings_update};
use std::io::Write;

pub(crate) const JOURNAL: &str = ".credential-import-group.json";
#[cfg(test)]
thread_local! { static FAIL_AT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(super) fn inject_failure(point: u8) {
    FAIL_AT.with(|value| value.set(point));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialGroupOutcome {
    Committed,
    Aborted,
    Undone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialGroupReceipt {
    pub group_id: String,
    pub outcome: CredentialGroupOutcome,
    pub before_revision: String,
    pub after_revision: String,
    pub references: Vec<CredentialImportRef>,
}
impl CredentialGroupReceipt {
    pub(super) fn validate(&self) -> Result<()> {
        ensure!(
            self.group_id.len() == 38
                && self.group_id.starts_with("group-")
                && self.group_id[6..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                && !self.references.is_empty()
                && self.references.len() <= 128
                && [self.before_revision.as_str(), self.after_revision.as_str()]
                    .iter()
                    .all(|hash| hash.len() == 64
                        && hash.bytes().all(|byte| byte.is_ascii_hexdigit())),
            "credential_group_invalid_metadata"
        );
        let mut providers = std::collections::BTreeSet::new();
        let mut ids = std::collections::BTreeSet::new();
        for reference in &self.references {
            validate_reference(reference)?;
            ensure!(
                providers.insert((reference.subject.is_provider(), &reference.provider))
                    && ids.insert(&reference.operation_id),
                "credential_group_invalid_metadata"
            );
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    version: u8,
    receipt: CredentialGroupReceipt,
    before_file: Option<String>,
    after_file: String,
    #[serde(default)]
    undo: bool,
}
fn prepared_name(id: &str) -> String {
    format!(".credential-{id}.settings")
}
pub(super) fn revision(value: &Value) -> Result<String> {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key, canonical(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .map(|(key, value)| (key.clone(), value))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical(value))?)
    ))
}

impl ImportedCredentialStore {
    /// Publish staged credential bindings and a settings edit under the normal reader coordinator.
    /// The callback only edits its document; it must not reacquire configuration or credential locks.
    pub fn publish_group(
        &self,
        group_id: &str,
        references: &[CredentialImportRef],
        backend: &dyn CredentialBackend,
        update: impl FnOnce(&mut Value) -> Result<()>,
    ) -> Result<CredentialGroupReceipt> {
        self.publish_group_checked(group_id, references, backend, |document, _| {
            update(document)
        })
    }

    /// Validation receives occupied credential names, never secret values or keyring accounts.
    pub fn publish_group_checked(
        &self,
        group_id: &str,
        references: &[CredentialImportRef],
        backend: &dyn CredentialBackend,
        update: impl FnOnce(&mut Value, &std::collections::BTreeSet<String>) -> Result<()>,
    ) -> Result<CredentialGroupReceipt> {
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _settings = self.lock("settings.json.lock", true)?;
        let _credentials = self.lock("credentials.json.lock", true)?;
        let credential_version = self.optional_identity("credentials.json")?;
        let mut store = self.read()?;
        ensure!(
            credential_version == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        if let Some(previous) = store.0.imported_credentials.groups.get(group_id) {
            for reference in &previous.references {
                self.check(reference)?;
            }
            ensure!(
                previous.references == references,
                "credential_group_receipt_conflict"
            );
            ensure!(
                previous.outcome == CredentialGroupOutcome::Committed,
                "credential_group_aborted_replan_required"
            );
            return Ok(previous.clone());
        }
        ensure!(
            store.0.imported_credentials.groups.len() < 4096,
            "credential_import_budget_exceeded"
        );
        let settings = ProfileSettingsFile::new(self.directory.try_clone()?)?;
        let before_file = self.optional_identity("settings.json")?;
        let (source, original) = settings.read_document()?;
        ensure!(
            before_file == self.optional_identity("settings.json")?,
            "credential_group_settings_changed"
        );
        let mut next = original.clone();
        let occupied = store
            .0
            .credentials
            .keys()
            .chain(store.0.revoked.iter())
            .cloned()
            .chain(
                store
                    .0
                    .imported_credentials
                    .receipts
                    .values()
                    .filter(|receipt| {
                        receipt.state != ImportState::Undone
                            && receipt.reference.subject.is_provider()
                    })
                    .map(|receipt| receipt.reference.provider.clone()),
            )
            .collect::<std::collections::BTreeSet<_>>();
        update(&mut next, &occupied)?;
        crate::validate_and_resolve_settings_document(&next)?;
        ensure!(next != original, "credential_group_settings_unchanged");
        let receipt = CredentialGroupReceipt {
            group_id: group_id.into(),
            outcome: CredentialGroupOutcome::Committed,
            before_revision: revision(&original)?,
            after_revision: revision(&next)?,
            references: references.to_vec(),
        };
        receipt.validate()?;
        for reference in references {
            self.check(reference)?;
            mcp::verify_settings(reference, &next)?;
        }
        let bindings = self.staged_bindings(&store.0, references, backend)?;
        for (reference, binding) in references.iter().zip(bindings) {
            mcp::set_binding(&mut store.0, reference, binding.to_string())?;
            let saved = store
                .0
                .imported_credentials
                .receipts
                .get_mut(&reference.operation_id)
                .unwrap();
            saved.state = ImportState::Published;
            saved.staged_key = None;
        }
        store
            .0
            .imported_credentials
            .groups
            .insert(group_id.into(), receipt.clone());
        store.0.imported_credentials.validate()?;
        let final_bytes = Zeroizing::new(serde_json::to_vec(&store.0)?);
        ensure!(
            final_bytes.len() as u64 <= MAX_BYTES,
            "credential_import_budget_exceeded"
        );
        drop(final_bytes);
        store.0.imported_credentials.groups.remove(group_id);
        ensure!(
            credential_version == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        let rendered = Zeroizing::new(render_settings_update(source.as_deref(), &original, &next)?);
        let name = prepared_name(group_id);
        let mut prepared = self
            .directory
            .open_read_write_file(OsStr::new(&name), true)
            .map_err(|error| {
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|cause| cause.kind() == std::io::ErrorKind::AlreadyExists)
                }) {
                    anyhow::anyhow!("credential_group_prepared_exists")
                } else {
                    error.context("credential_group_prepare_failed")
                }
            })?;
        prepared.write_all(&rendered)?;
        prepared.sync_all()?;
        drop(prepared);
        let after_file = self.directory.regular_file_identity(OsStr::new(&name))?;
        let pending = Pending {
            version: 1,
            receipt: receipt.clone(),
            before_file,
            after_file,
            undo: false,
        };
        self.directory
            .atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&pending)?)?;
        fail(1)?;
        ensure!(
            credential_version == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        self.save(&store.0)?;
        let published_credentials = self.optional_identity("credentials.json")?;
        fail(2)?;
        ensure!(
            pending.before_file == self.optional_identity("settings.json")?,
            "credential_group_settings_changed"
        );
        self.directory.publish_prepared(
            OsStr::new(&name),
            OsStr::new("settings.json"),
            &pending.after_file,
        )?;
        fail(3)?;
        ensure!(
            published_credentials == self.optional_identity("credentials.json")?,
            "credential_group_credentials_changed"
        );
        store
            .0
            .imported_credentials
            .groups
            .insert(group_id.into(), receipt.clone());
        self.save(&store.0)?;
        self.directory.remove_regular_file(OsStr::new(JOURNAL))?;
        Ok(receipt)
    }

    /// Return authoritative publication history; recovery only settles the original rename.
    pub fn group_receipt(&self, group_id: &str) -> Result<Option<CredentialGroupReceipt>> {
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _credentials = self.lock("credentials.json.lock", false)?;
        let receipt = self
            .read()?
            .0
            .imported_credentials
            .groups
            .get(group_id)
            .cloned();
        if let Some(receipt) = &receipt {
            for reference in &receipt.references {
                self.check(reference)?;
            }
        }
        Ok(receipt)
    }

    /// Reconcile a committed receipt against the complete current pair without writing it again.
    pub fn verify_group(&self, group_id: &str, backend: &dyn CredentialBackend) -> Result<()> {
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _settings = self.lock("settings.json.lock", false)?;
        let _credentials = self.lock("credentials.json.lock", false)?;
        let store = self.read()?;
        let group = store
            .0
            .imported_credentials
            .groups
            .get(group_id)
            .ok_or_else(|| anyhow::anyhow!("credential_group_receipt_required"))?;
        ensure!(
            group.outcome == CredentialGroupOutcome::Committed,
            "credential_group_aborted_replan_required"
        );
        ensure!(
            revision(&self.settings()?)? == group.after_revision,
            "credential_group_settings_changed"
        );
        for reference in &group.references {
            self.check(reference)?;
            let receipt = store
                .0
                .imported_credentials
                .receipts
                .get(&reference.operation_id)
                .ok_or_else(|| anyhow::anyhow!("credential_import_receipt_required"))?;
            ensure!(
                receipt.reference == *reference && receipt.state == ImportState::Published,
                "credential_import_target_changed"
            );
            self.check_binding(&store.0, reference, &receipt.fingerprint, backend)?;
        }
        Ok(())
    }

    fn staged_bindings(
        &self,
        store: &CredentialStore,
        references: &[CredentialImportRef],
        backend: &dyn CredentialBackend,
    ) -> Result<Vec<Zeroizing<String>>> {
        references
            .iter()
            .map(|reference| {
                let receipt = store
                    .imported_credentials
                    .receipts
                    .get(&reference.operation_id)
                    .ok_or_else(|| anyhow::anyhow!("credential_import_receipt_required"))?;
                ensure!(
                    receipt.reference == *reference
                        && receipt.state == ImportState::Staged
                        && !mcp::occupied(store, reference),
                    "credential_import_target_changed"
                );
                let binding = match reference.storage {
                    ImportStorage::File => Zeroizing::new(
                        receipt
                            .staged_key
                            .as_ref()
                            .ok_or_else(|| anyhow::anyhow!("credential_import_staged_key_missing"))?
                            .0
                            .clone(),
                    ),
                    ImportStorage::Keyring => Zeroizing::new(
                        backend
                            .get(&reference.account)
                            .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                            .ok_or_else(|| {
                                anyhow::anyhow!("credential_import_staged_key_missing")
                            })?,
                    ),
                };
                ensure!(
                    hash(&binding) == receipt.fingerprint,
                    "credential_import_target_changed"
                );
                self.validate_mcp_extension(store, reference, &binding, backend)?;
                Ok(if reference.storage == ImportStorage::File {
                    binding
                } else {
                    Zeroizing::new(marker_for_provider(&reference.account))
                })
            })
            .collect()
    }

    fn optional_identity(&self, name: &str) -> Result<Option<String>> {
        match self.directory.regular_file_identity(OsStr::new(name)) {
            Ok(identity) => Ok(Some(identity)),
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(crate) fn recover_group_locked(&self) -> Result<()> {
        let Some(bytes) = self.read_file(JOURNAL)? else {
            return Ok(());
        };
        self.require_no_pending_pair()?;
        let pending: Pending = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("credential_group_invalid_metadata"))?;
        pending.receipt.validate()?;
        ensure!(
            pending.version == 1
                && !pending.after_file.is_empty()
                && pending.after_file.len() <= 256
                && pending
                    .before_file
                    .as_ref()
                    .is_none_or(|id| !id.is_empty() && id.len() <= 256),
            "credential_group_invalid_metadata"
        );
        for reference in &pending.receipt.references {
            self.check(reference)?;
        }
        let _settings = self.lock("settings.json.lock", true)?;
        let _credentials = self.lock("credentials.json.lock", true)?;
        let mut store = self.read()?;
        if let Some(previous) = store
            .0
            .imported_credentials
            .groups
            .get(&pending.receipt.group_id)
        {
            ensure!(
                previous.references == pending.receipt.references,
                "credential_group_receipt_conflict"
            );
            if !pending.undo || previous.outcome == CredentialGroupOutcome::Undone {
                self.directory.remove_regular_file(OsStr::new(JOURNAL))?;
                return Ok(());
            }
        }
        if pending.undo {
            return self.recover_undo_locked(pending, store);
        }
        let current_id = self.optional_identity("settings.json")?;
        let current = self.settings()?;
        let current_revision = revision(&current)?;
        let committed = current_id.as_deref() == Some(&pending.after_file)
            && current_revision == pending.receipt.after_revision;
        let aborted = current_id == pending.before_file
            && current_revision == pending.receipt.before_revision;
        ensure!(committed || aborted, "credential_group_settings_conflict");
        // First verify every binding. A conflict must preserve all user replacements.
        for reference in &pending.receipt.references {
            let receipt = store
                .0
                .imported_credentials
                .receipts
                .get(&reference.operation_id)
                .ok_or_else(|| anyhow::anyhow!("credential_import_receipt_required"))?;
            ensure!(
                receipt.reference == *reference,
                "credential_import_receipt_conflict"
            );
            match receipt.state {
                ImportState::Published => {
                    self.check_binding_metadata(&store.0, reference, &receipt.fingerprint)?
                }
                ImportState::Staged if aborted => ensure!(
                    !mcp::occupied(&store.0, reference),
                    "credential_import_target_changed"
                ),
                _ => anyhow::bail!("credential_import_target_changed"),
            }
        }
        if aborted {
            for reference in &pending.receipt.references {
                let published = store
                    .0
                    .imported_credentials
                    .receipts
                    .get(&reference.operation_id)
                    .unwrap()
                    .state
                    == ImportState::Published;
                let binding = if published {
                    mcp::remove_binding(&mut store.0, reference, false)
                } else {
                    None
                };
                let receipt = store
                    .0
                    .imported_credentials
                    .receipts
                    .get_mut(&reference.operation_id)
                    .unwrap();
                if receipt.state == ImportState::Published {
                    if reference.storage == ImportStorage::File {
                        receipt.staged_key = Some(StagedKey(binding.unwrap().to_string()));
                    }
                    receipt.state = ImportState::Staged;
                }
            }
        }
        let mut receipt = pending.receipt;
        receipt.outcome = if committed {
            CredentialGroupOutcome::Committed
        } else {
            CredentialGroupOutcome::Aborted
        };
        store
            .0
            .imported_credentials
            .groups
            .insert(receipt.group_id.clone(), receipt.clone());
        self.save(&store.0)?;
        let name = prepared_name(&receipt.group_id);
        if self.optional_identity(&name)?.as_deref() == Some(&pending.after_file) {
            self.directory.remove_regular_file(OsStr::new(&name))?;
        }
        self.directory.remove_regular_file(OsStr::new(JOURNAL))
    }

    fn check_binding_metadata(
        &self,
        store: &CredentialStore,
        reference: &CredentialImportRef,
        fingerprint: &str,
    ) -> Result<()> {
        let value = mcp::binding(store, reference)
            .ok_or_else(|| anyhow::anyhow!("credential_import_target_changed"))?;
        ensure!(
            !mcp::revoked(store, reference),
            "credential_import_target_changed"
        );
        ensure!(
            if reference.storage == ImportStorage::File {
                hash(value) == fingerprint
            } else {
                value == marker_for_provider(&reference.account)
            },
            "credential_import_target_changed"
        );
        Ok(())
    }
}

/// The caller already holds the standard settings/credential coordinator.
pub(crate) fn recover_in(directory: &PrivateDirectory) -> Result<()> {
    ImportedCredentialStore {
        directory: directory.try_clone()?,
    }
    .recover_group_locked()
}
fn fail(point: u8) -> Result<()> {
    #[cfg(test)]
    if FAIL_AT.with(|fail| {
        if fail.get() == point {
            fail.set(0);
            true
        } else {
            false
        }
    }) {
        anyhow::bail!("credential_group_injected_interruption")
    }
    let _ = point;
    Ok(())
}

#[cfg(test)]
mod coordination_tests;
#[cfg(test)]
mod tests;
mod undo;
