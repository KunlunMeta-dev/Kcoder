//! Operation-owned credential imports. Only the credential store holds plaintext secrets.
use crate::{
    CredentialBackend, CredentialStore, CredentialStoreMode, PrivateDirectory, marker_for_provider,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, io::Read, path::Path};
use zeroize::{Zeroize, Zeroizing};

pub const NAMESPACE: &str = "$kcoder_credential_imports";
const MAX_BYTES: u64 = 16 * 1024 * 1024;
mod group;
pub mod mcp;
mod staging;
pub use group::{CredentialGroupOutcome, CredentialGroupReceipt};
pub(crate) use group::{JOURNAL as GROUP_JOURNAL, recover_in as recover_group_in};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStorage {
    File,
    Keyring,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportState {
    Staged,
    Published,
    Undoing,
    Undone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialImportRef {
    #[serde(default, skip_serializing_if = "mcp::CredentialSubject::is_provider")]
    pub subject: mcp::CredentialSubject,
    pub operation_id: String,
    pub provider: String,
    pub storage: ImportStorage,
    pub account: String,
    pub profile_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedCredentialReceipt {
    pub reference: CredentialImportRef,
    pub fingerprint: String,
    pub state: ImportState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) staged_key: Option<StagedKey>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct StagedKey(String);
impl Drop for StagedKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedCredentialDocument {
    pub receipts: BTreeMap<String, ImportedCredentialReceipt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub groups: BTreeMap<String, CredentialGroupReceipt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    mcp_bindings: BTreeMap<String, StagedKey>,
}
impl std::fmt::Debug for ImportedCredentialDocument {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportedCredentialDocument")
            .field("receipt_count", &self.receipts.len())
            .finish()
    }
}
impl ImportedCredentialDocument {
    pub fn validate(&self) -> Result<()> {
        self.validate_mcp_bindings()?;
        ensure!(
            self.receipts.len() <= 4096 && self.groups.len() <= 4096,
            "credential_import_budget_exceeded"
        );
        for (id, group) in &self.groups {
            group.validate()?;
            ensure!(id == &group.group_id, "credential_group_invalid_metadata");
        }
        for (id, receipt) in &self.receipts {
            validate_reference(&receipt.reference)?;
            ensure!(
                id == &receipt.reference.operation_id
                    && receipt.fingerprint.len() == 64
                    && receipt
                        .fingerprint
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit()),
                "credential_import_invalid_metadata"
            );
            if let Some(key) = &receipt.staged_key {
                ensure!(
                    receipt.reference.storage == ImportStorage::File
                        && matches!(receipt.state, ImportState::Staged | ImportState::Undoing),
                    "credential_import_invalid_metadata"
                );
                validate_secret(&receipt.reference, &key.0)?;
                ensure!(
                    hash(&key.0) == receipt.fingerprint,
                    "credential_import_invalid_metadata"
                );
            }
        }
        Ok(())
    }
}
struct PrivateCredentials(CredentialStore);
impl Drop for PrivateCredentials {
    fn drop(&mut self) {
        for key in self.0.credentials.values_mut() {
            key.zeroize();
        }
    }
}

pub struct ImportedCredentialStore {
    directory: PrivateDirectory,
}
impl ImportedCredentialStore {
    pub fn open(profile: &Path) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_trusted_config_directory()?;
        Ok(Self { directory })
    }
    pub fn prepare(
        &self,
        provider: &str,
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialImportRef> {
        self.prepare_subject(provider, mcp::CredentialSubject::Provider, mode, backend)
    }
    fn prepare_subject(
        &self,
        provider: &str,
        subject: mcp::CredentialSubject,
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialImportRef> {
        self.prepare_subject_extension(provider, subject, mode, backend, None)
    }
    fn prepare_subject_extension(
        &self,
        provider: &str,
        subject: mcp::CredentialSubject,
        mode: CredentialStoreMode,
        backend: &dyn CredentialBackend,
        predecessor: Option<String>,
    ) -> Result<CredentialImportRef> {
        mcp::validate_owner(&subject, provider)?;
        let _lock = self.lock("credentials.json.lock", false)?;
        let store = self.read()?;
        ensure!(
            store.0.imported_credentials.receipts.len() < 4096,
            "credential_import_budget_exceeded"
        );
        let storage = match mode {
            CredentialStoreMode::File => ImportStorage::File,
            CredentialStoreMode::Keyring => {
                ensure!(backend.available(), "credential_import_keyring_unavailable");
                ImportStorage::Keyring
            }
            CredentialStoreMode::Auto => {
                if backend.available() {
                    ImportStorage::Keyring
                } else {
                    ImportStorage::File
                }
            }
        };
        let reference = CredentialImportRef {
            subject,
            operation_id: random_id("cred-")?,
            provider: provider.into(),
            storage,
            account: random_id("import-")?,
            profile_identity: self.directory.directory_identity()?,
            predecessor,
        };
        mcp::extensions::require_available(&store.0, &reference)?;
        Ok(reference)
    }
    pub fn install(
        &self,
        reference: &CredentialImportRef,
        key: &str,
        backend: &dyn CredentialBackend,
        verify: impl FnOnce(&Value) -> Result<()>,
    ) -> Result<ImportState> {
        self.check(reference)?;
        ensure!(
            reference.predecessor.is_none(),
            "mcp_credential_extension_requires_group"
        );
        validate_secret(reference, key)?;
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _settings = self.lock("settings.json.lock", false)?;
        verify(&self.settings()?)?;
        let _credential_lock = self.lock("credentials.json.lock", true)?;
        let mut store = self.read()?;
        let fingerprint = hash(key);
        if let Some(receipt) = store
            .0
            .imported_credentials
            .receipts
            .get(&reference.operation_id)
        {
            ensure!(
                receipt.reference == *reference && receipt.fingerprint == fingerprint,
                "credential_import_receipt_conflict"
            );
            ensure!(
                !matches!(receipt.state, ImportState::Undone | ImportState::Undoing),
                "credential_import_undone"
            );
            if receipt.state == ImportState::Published {
                self.check_binding(&store.0, reference, &fingerprint, backend)?;
                return Ok(ImportState::Published);
            }
        } else {
            ensure!(
                !mcp::occupied(&store.0, reference),
                "credential_import_target_exists"
            );
            ensure!(
                !store
                    .0
                    .imported_credentials
                    .receipts
                    .values()
                    .any(|receipt| receipt.reference.same_owner(reference)
                        && receipt.state != ImportState::Undone),
                "credential_import_target_exists"
            );
            ensure!(
                store.0.imported_credentials.receipts.len() < 4096,
                "credential_import_budget_exceeded"
            );
            if reference.storage == ImportStorage::Keyring {
                ensure!(backend.available(), "credential_import_keyring_unavailable");
                ensure!(
                    backend
                        .get(&reference.account)
                        .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                        .is_none(),
                    "credential_import_account_exists"
                );
            }
            store.0.imported_credentials.receipts.insert(
                reference.operation_id.clone(),
                ImportedCredentialReceipt {
                    reference: reference.clone(),
                    fingerprint: fingerprint.clone(),
                    state: ImportState::Staged,
                    staged_key: None,
                },
            );
            self.save(&store.0)?;
        }
        ensure!(
            !mcp::occupied(&store.0, reference),
            "credential_import_target_exists"
        );
        let binding = match reference.storage {
            ImportStorage::File => Zeroizing::new(key.to_owned()),
            ImportStorage::Keyring => {
                ensure!(backend.available(), "credential_import_keyring_unavailable");
                match backend
                    .get(&reference.account)
                    .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                {
                    Some(existing) => {
                        let existing = Zeroizing::new(existing);
                        ensure!(
                            hash(&existing) == fingerprint,
                            "credential_import_account_changed"
                        );
                    }
                    None => backend
                        .set(&reference.account, key)
                        .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?,
                }
                Zeroizing::new(marker_for_provider(&reference.account))
            }
        };
        mcp::set_binding(&mut store.0, reference, binding.to_string())?;
        store
            .0
            .imported_credentials
            .receipts
            .get_mut(&reference.operation_id)
            .unwrap()
            .state = ImportState::Published;
        store
            .0
            .imported_credentials
            .receipts
            .get_mut(&reference.operation_id)
            .unwrap()
            .staged_key = None;
        self.save(&store.0)?;
        Ok(ImportState::Published)
    }
    pub fn state(
        &self,
        reference: &CredentialImportRef,
        backend: &dyn CredentialBackend,
    ) -> Result<Option<ImportState>> {
        self.check(reference)?;
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.recover_group_locked()?;
        let _lock = self.lock("credentials.json.lock", false)?;
        let store = self.read()?;
        let Some(receipt) = store
            .0
            .imported_credentials
            .receipts
            .get(&reference.operation_id)
        else {
            return Ok(None);
        };
        ensure!(
            receipt.reference == *reference,
            "credential_import_receipt_conflict"
        );
        if receipt.state == ImportState::Published {
            self.check_binding(&store.0, reference, &receipt.fingerprint, backend)?;
        }
        Ok(Some(receipt.state))
    }
    pub fn undo(
        &self,
        reference: &CredentialImportRef,
        backend: &dyn CredentialBackend,
    ) -> Result<ImportState> {
        self.check(reference)?;
        let _coordinator = self.lock(".provider-transaction.json.lock", true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let _lock = self.lock("credentials.json.lock", true)?;
        let mut store = self.read()?;
        let receipt = store
            .0
            .imported_credentials
            .receipts
            .get(&reference.operation_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("credential_import_receipt_required"))?;
        ensure!(
            receipt.reference == *reference,
            "credential_import_receipt_conflict"
        );
        if receipt.state == ImportState::Undone {
            return Ok(ImportState::Undone);
        }
        mcp::extensions::require_unreferenced(&store.0, reference)?;
        ensure!(
            !store
                .0
                .imported_credentials
                .groups
                .values()
                .any(|group| group.outcome == CredentialGroupOutcome::Committed
                    && group
                        .references
                        .iter()
                        .any(|owned| owned.operation_id == reference.operation_id)),
            "credential_import_referenced"
        );
        if receipt.state == ImportState::Published {
            self.check_binding(&store.0, reference, &receipt.fingerprint, backend)?;
        } else if receipt.state == ImportState::Staged {
            ensure!(
                !mcp::occupied(&store.0, reference),
                "credential_import_target_changed"
            );
        } else {
            ensure!(
                mcp::binding(&store.0, reference).is_none() && mcp::revoked(&store.0, reference),
                "credential_import_target_changed"
            );
        }
        if reference.storage == ImportStorage::Keyring {
            let marker = marker_for_provider(&reference.account);
            ensure!(
                !mcp::binding_used_elsewhere(&store.0, reference, &marker),
                "credential_import_referenced"
            );
            if receipt.state != ImportState::Undoing {
                mcp::remove_binding(&mut store.0, reference, true);
                store
                    .0
                    .imported_credentials
                    .receipts
                    .get_mut(&reference.operation_id)
                    .unwrap()
                    .state = ImportState::Undoing;
                self.save(&store.0)?;
            }
            if let Some(value) = backend
                .get(&reference.account)
                .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
            {
                let value = Zeroizing::new(value);
                ensure!(
                    hash(&value) == receipt.fingerprint,
                    "credential_import_target_changed"
                );
                backend
                    .delete(&reference.account)
                    .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?;
            }
        }
        mcp::remove_binding(&mut store.0, reference, false);
        store
            .0
            .imported_credentials
            .receipts
            .get_mut(&reference.operation_id)
            .unwrap()
            .state = ImportState::Undone;
        store
            .0
            .imported_credentials
            .receipts
            .get_mut(&reference.operation_id)
            .unwrap()
            .staged_key = None;
        self.save(&store.0)?;
        Ok(ImportState::Undone)
    }
    fn check_binding(
        &self,
        store: &CredentialStore,
        reference: &CredentialImportRef,
        fingerprint: &str,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        let value = mcp::binding(store, reference)
            .ok_or_else(|| anyhow::anyhow!("credential_import_target_changed"))?;
        ensure!(
            !mcp::revoked(store, reference),
            "credential_import_target_changed"
        );
        match reference.storage {
            ImportStorage::File => ensure!(
                hash(value) == fingerprint,
                "credential_import_target_changed"
            ),
            ImportStorage::Keyring => {
                ensure!(
                    value == marker_for_provider(&reference.account),
                    "credential_import_target_changed"
                );
                let secret = Zeroizing::new(
                    backend
                        .get(&reference.account)
                        .map_err(|_| anyhow::anyhow!("credential_import_backend_unavailable"))?
                        .ok_or_else(|| {
                            anyhow::anyhow!("credential_import_keyring_entry_missing")
                        })?,
                );
                ensure!(
                    hash(&secret) == fingerprint,
                    "credential_import_target_changed"
                );
            }
        }
        Ok(())
    }
    fn check(&self, reference: &CredentialImportRef) -> Result<()> {
        validate_reference(reference)?;
        ensure!(
            self.directory.directory_identity()? == reference.profile_identity,
            "credential_import_wrong_profile"
        );
        self.directory.verify_trusted_config_directory()
    }
    fn lock(&self, name: &str, exclusive: bool) -> Result<std::fs::File> {
        crate::profile_settings_file::acquire_imported_credential_lease(
            &self.directory,
            OsStr::new(name),
            exclusive,
        )
    }
    fn require_no_pending_pair(&self) -> Result<()> {
        match self
            .directory
            .entry_metadata(OsStr::new(".provider-transaction.json"))
        {
            Ok(_) => anyhow::bail!("credential_import_configuration_recovery_required"),
            Err(error) if missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }
    fn read(&self) -> Result<PrivateCredentials> {
        let Some(bytes) = self.read_file("credentials.json")? else {
            return Ok(PrivateCredentials(CredentialStore::default()));
        };
        Ok(PrivateCredentials(serde_json::from_slice(&bytes).map_err(
            |_| anyhow::anyhow!("credential_import_invalid_metadata"),
        )?))
    }
    fn settings(&self) -> Result<Value> {
        let Some(bytes) = self.read_file("settings.json")? else {
            return Ok(serde_json::json!({}));
        };
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| anyhow::anyhow!("credential_import_invalid_settings"))?;
        jsonc_parser::parse_to_serde_value(text, &Default::default())
            .map_err(|_| anyhow::anyhow!("credential_import_invalid_settings"))
    }
    fn read_file(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let file = match self
            .directory
            .open_single_link_regular_file(OsStr::new(name))
        {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(_) => anyhow::bail!("credential_import_unsafe_file"),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = file.metadata()?;
            // SAFETY: geteuid only observes the active process identity.
            ensure!(
                metadata.uid() == unsafe { libc::geteuid() }
                    && (name == "settings.json" || metadata.permissions().mode() & 0o077 == 0),
                "credential_import_unsafe_file"
            );
        }
        ensure!(
            file.metadata()?.len() <= MAX_BYTES,
            "credential_import_budget_exceeded"
        );
        let mut bytes = Zeroizing::new(Vec::new());
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "credential_import_budget_exceeded"
        );
        Ok(Some(bytes))
    }
    fn save(&self, store: &CredentialStore) -> Result<()> {
        store.imported_credentials.validate()?;
        let bytes = Zeroizing::new(serde_json::to_vec(store)?);
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "credential_import_budget_exceeded"
        );
        self.directory
            .atomic_replace(OsStr::new("credentials.json"), &bytes)
    }
}
fn validate_reference(reference: &CredentialImportRef) -> Result<()> {
    mcp::validate_subject(&reference.subject)?;
    mcp::validate_owner(&reference.subject, &reference.provider)?;
    ensure!(
        reference.operation_id.len() == 37
            && reference.operation_id.starts_with("cred-")
            && reference.operation_id[5..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            && reference.account.len() == 39
            && reference.account.starts_with("import-")
            && reference.account[7..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit()),
        "credential_import_invalid_reference"
    );
    ensure!(
        !reference.profile_identity.is_empty() && reference.profile_identity.len() <= 256,
        "credential_import_invalid_reference"
    );
    if let Some(previous) = &reference.predecessor {
        ensure!(
            !reference.subject.is_provider()
                && previous != &reference.operation_id
                && previous.len() == 37
                && previous.starts_with("cred-")
                && previous[5..].bytes().all(|b| b.is_ascii_hexdigit()),
            "credential_import_invalid_reference"
        );
    }
    Ok(())
}
fn validate_key(key: &str) -> Result<()> {
    ensure!(
        !key.is_empty()
            && key.len() <= 16 * 1024
            && key.trim() == key
            && !key.chars().any(char::is_control)
            && !crate::credential_store::is_marker(key),
        "credential_import_invalid_api_key"
    );
    Ok(())
}
fn validate_secret(reference: &CredentialImportRef, value: &str) -> Result<()> {
    if reference.subject.is_provider() {
        validate_key(value)
    } else {
        mcp::McpSecretValues::decode(value)?.validate_subject(&reference.subject)
    }
}
fn random_id(prefix: &str) -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("credential_import_random_unavailable"))?;
    Ok(format!(
        "{prefix}{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}
fn hash(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
mod tests;
