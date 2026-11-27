//! Stopped same-account relocation verifies original credentials without exporting or replacing them.
use super::*;
use crate::profile_identity::ProfileIdentity;
use std::fs::File;

const LOCKS: [&str; 3] = [
    ".provider-transaction.json.lock",
    "settings.json.lock",
    "credentials.json.lock",
];
const KEYRING_UNAVAILABLE: &str = "CREDENTIAL_RELOCATION_KEYRING_UNAVAILABLE: use the original OS account and keyring; restore access or reauthenticate before relocation";
const KEYRING_MISSING: &str = "CREDENTIAL_RELOCATION_KEYRING_ENTRY_MISSING: restore the original OS credential or reauthenticate before relocation";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialRelocationSummary {
    pub provider_credentials: usize,
    pub plugin_scopes: usize,
    pub import_receipts: usize,
    pub keyring_accounts: usize,
}

struct Snapshot {
    identity: Option<String>,
    bytes: Option<Zeroizing<Vec<u8>>>,
}

/// The source coordinator remains held from recovery through the final copy check.
/// This does not prove process shutdown or authorize Native identity migration.
pub struct CredentialRelocation {
    source: ImportedCredentialStore,
    profile: ProfileIdentity,
    operation_id: String,
    credentials: Snapshot,
    settings: Snapshot,
    accounts: BTreeMap<String, Option<String>>,
    locks: Vec<File>,
}

impl ImportedCredentialStore {
    /// Bounded read-only preflight. It never probes unrelated OS accounts, creates
    /// locks, recovers a transaction, or changes the credential-store policy.
    pub fn preview_relocation(
        &self,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialRelocationSummary> {
        let _leases = existing_locks(&self.directory)?;
        self.require_relocation_settled()?;
        let profile = ProfileIdentity::observe(&self.directory)?;
        let credentials = snapshot(self, "credentials.json")?;
        let settings = snapshot(self, "settings.json")?;
        let store = self.read()?;
        let accounts = self.relocation_accounts(&store.0, backend)?;
        verify_snapshot(self, "credentials.json", &credentials)?;
        verify_snapshot(self, "settings.json", &settings)?;
        self.require_relocation_settled()?;
        profile.verify(&self.directory)?;
        Ok(CredentialRelocationSummary {
            provider_credentials: store.0.credentials.len(),
            plugin_scopes: store.0.plugin_credentials.scopes.len(),
            import_receipts: store.0.imported_credentials.receipts.len(),
            keyring_accounts: accounts.len(),
        })
    }

    /// Call after confirmed shutdown and before copying. Recover only the original
    /// imported group journal; an unresolved provider pair or Undoing remains blocked.
    pub fn prepare_relocation(
        &self,
        operation_id: &str,
        backend: &dyn CredentialBackend,
    ) -> Result<CredentialRelocation> {
        ensure!(
            !operation_id.trim().is_empty() && operation_id.chars().count() <= 256,
            "CREDENTIAL_RELOCATION_INVALID_OPERATION"
        );
        let coordinator = self.lock(LOCKS[0], true)?;
        self.require_no_pending_pair()?;
        self.recover_group_locked()?;
        let settings_lock = self.lock(LOCKS[1], true)?;
        let credentials_lock = self.lock(LOCKS[2], true)?;
        self.require_relocation_settled()?;
        let source = Self {
            directory: self.directory.try_clone()?,
        };
        let prepared = CredentialRelocation {
            profile: ProfileIdentity::observe(&source.directory)?,
            credentials: snapshot(&source, "credentials.json")?,
            settings: snapshot(&source, "settings.json")?,
            accounts: source.relocation_accounts(&source.read()?.0, backend)?,
            source,
            operation_id: operation_id.into(),
            locks: vec![coordinator, settings_lock, credentials_lock],
        };
        prepared.verify_source(backend)?;
        Ok(prepared)
    }

    fn require_relocation_settled(&self) -> Result<()> {
        self.require_no_pending_pair()?;
        match self.directory.entry_metadata(OsStr::new(GROUP_JOURNAL)) {
            Ok(_) => anyhow::bail!("CREDENTIAL_RELOCATION_GROUP_RECOVERY_REQUIRED"),
            Err(error) if missing(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn relocation_accounts(
        &self,
        store: &CredentialStore,
        backend: &dyn CredentialBackend,
    ) -> Result<BTreeMap<String, Option<String>>> {
        store.imported_credentials.validate()?;
        let settings = self.settings()?;
        crate::migrations::validate_version(&settings)
            .map_err(|_| anyhow::anyhow!("CREDENTIAL_RELOCATION_SETTINGS_FORMAT_UNSUPPORTED"))?;
        let mode = settings
            .get("credential_store")
            .cloned()
            .map(serde_json::from_value::<CredentialStoreMode>)
            .transpose()
            .map_err(|_| anyhow::anyhow!("CREDENTIAL_RELOCATION_INVALID_POLICY"))?
            .unwrap_or_default();
        let mut required = BTreeMap::<String, bool>::new();
        for value in store.credentials.values() {
            if let Some(account) = crate::provider_from_marker(value) {
                required.insert(account.into(), true);
            }
        }
        for scope in store.plugin_credentials.scopes.values() {
            for secret in scope.values.values() {
                if let crate::plugin_credentials::PluginSecret::Keyring { account } = secret {
                    required.insert(account.clone(), true);
                }
            }
        }
        ensure!(
            mode != CredentialStoreMode::File || required.is_empty(),
            "CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED: restore the source keyring policy before relocation"
        );
        for receipt in store.imported_credentials.receipts.values() {
            self.check(&receipt.reference)?;
            ensure!(
                receipt.state != ImportState::Undoing,
                "CREDENTIAL_RELOCATION_UNDO_RECOVERY_REQUIRED"
            );
            if receipt.reference.subject.is_provider()
                && store.revoked.contains(&receipt.reference.provider)
                && !store.credentials.contains_key(&receipt.reference.provider)
            {
                // User logout owns this inactive outcome. Retain its original
                // receipt without requiring or recreating an old OS credential.
                continue;
            }
            ensure!(
                mode != CredentialStoreMode::File
                    || receipt.reference.storage != ImportStorage::Keyring
                    || receipt.state == ImportState::Undone,
                "CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED: restore the source keyring policy before relocation"
            );
            if receipt.state == ImportState::Published {
                self.check_binding(store, &receipt.reference, &receipt.fingerprint, backend)
                    .and_then(|()| self.verify_mcp_predecessors(store, &receipt.reference, backend))
                    .map_err(|error| match error.to_string().as_str() {
                        "credential_import_backend_unavailable" => {
                            anyhow::anyhow!(KEYRING_UNAVAILABLE)
                        }
                        "credential_import_keyring_entry_missing" => {
                            anyhow::anyhow!(KEYRING_MISSING)
                        }
                        _ => error,
                    })?;
            }
            if receipt.reference.storage == ImportStorage::Keyring
                && matches!(receipt.state, ImportState::Staged | ImportState::Published)
            {
                required
                    .entry(receipt.reference.account.clone())
                    .and_modify(|required| *required |= receipt.state == ImportState::Published)
                    .or_insert(receipt.state == ImportState::Published);
            }
        }
        for group in store.imported_credentials.groups.values() {
            for reference in &group.references {
                self.check(reference)?;
                ensure!(
                    store
                        .imported_credentials
                        .receipts
                        .get(&reference.operation_id)
                        .is_some_and(|receipt| receipt.reference == *reference),
                    "CREDENTIAL_RELOCATION_GROUP_RECEIPT_CHANGED"
                );
            }
        }
        ensure!(
            mode != CredentialStoreMode::File || required.is_empty(),
            "CREDENTIAL_RELOCATION_KEYRING_POLICY_BLOCKED: restore the source keyring policy before relocation"
        );
        let mut accounts = BTreeMap::new();
        for (account, required) in required {
            let value = backend
                .get(&account)
                .map_err(|_| anyhow::anyhow!(KEYRING_UNAVAILABLE))?
                .map(Zeroizing::new);
            ensure!(!required || value.is_some(), KEYRING_MISSING);
            if let Some(value) = &value {
                for receipt in store
                    .imported_credentials
                    .receipts
                    .values()
                    .filter(|receipt| {
                        receipt.reference.account == account
                            && receipt.reference.storage == ImportStorage::Keyring
                            && matches!(receipt.state, ImportState::Staged | ImportState::Published)
                    })
                {
                    ensure!(
                        hash(value) == receipt.fingerprint,
                        "CREDENTIAL_RELOCATION_KEYRING_VALUE_CHANGED"
                    );
                }
            }
            accounts.insert(account, value.as_ref().map(|value| hash(value)));
        }
        Ok(accounts)
    }
}

impl CredentialRelocation {
    fn verify_source(&self, backend: &dyn CredentialBackend) -> Result<()> {
        self.profile.verify(&self.source.directory)?;
        for (name, lock) in LOCKS.iter().zip(&self.locks) {
            ensure!(
                self.source
                    .directory
                    .regular_file_identity(OsStr::new(name))?
                    == PrivateDirectory::identity_of_file(lock)?,
                "CREDENTIAL_RELOCATION_SOURCE_LOCK_CHANGED"
            );
        }
        self.source.require_relocation_settled()?;
        verify_snapshot(&self.source, "credentials.json", &self.credentials)?;
        verify_snapshot(&self.source, "settings.json", &self.settings)?;
        ensure!(
            self.source
                .relocation_accounts(&self.source.read()?.0, backend)?
                == self.accounts,
            "CREDENTIAL_RELOCATION_KEYRING_VALUE_CHANGED"
        );
        Ok(())
    }

    /// Validate exact copied documents after Native's final logical mapping.
    /// This same-operation check, including lost-ack recovery, performs no
    /// credential or OS-backend write.
    pub fn verify_target(
        &self,
        final_target: &PrivateDirectory,
        backend: &dyn CredentialBackend,
    ) -> Result<()> {
        self.verify_source(backend)?;
        let target_profile = ProfileIdentity::observe(final_target)?;
        ensure!(
            final_target.directory_identity()? != self.source.directory.directory_identity()?
                && target_profile.logical_seed() == self.profile.logical_seed(),
            "CREDENTIAL_RELOCATION_TARGET_PROFILE_UNCONFIRMED"
        );
        // Verify only the already-published relationship for this operation.
        self.profile
            .verify_relocation(&self.source.directory, final_target, &self.operation_id)?;
        let target = ImportedCredentialStore {
            directory: final_target.try_clone()?,
        };
        let target_locks = existing_locks(final_target)?;
        ensure!(
            target_locks.len() == LOCKS.len(),
            "CREDENTIAL_RELOCATION_TARGET_LOCK_MISSING"
        );
        target.require_relocation_settled()?;
        ensure!(
            snapshot(&target, "credentials.json")?.bytes == self.credentials.bytes
                && snapshot(&target, "settings.json")?.bytes == self.settings.bytes,
            "CREDENTIAL_RELOCATION_TARGET_DATA_CHANGED"
        );
        ensure!(
            target.relocation_accounts(&target.read()?.0, backend)? == self.accounts,
            "CREDENTIAL_RELOCATION_KEYRING_VALUE_CHANGED"
        );
        target_profile.verify(final_target)?;
        self.verify_source(backend)
    }
}

fn snapshot(store: &ImportedCredentialStore, name: &str) -> Result<Snapshot> {
    let identity = store.optional_identity(name)?;
    let bytes = store.read_file(name)?;
    ensure!(
        identity == store.optional_identity(name)? && identity.is_some() == bytes.is_some(),
        "CREDENTIAL_RELOCATION_FILE_CHANGED"
    );
    Ok(Snapshot { identity, bytes })
}

fn verify_snapshot(store: &ImportedCredentialStore, name: &str, expected: &Snapshot) -> Result<()> {
    let actual = snapshot(store, name)?;
    ensure!(
        actual.identity == expected.identity && actual.bytes == expected.bytes,
        "CREDENTIAL_RELOCATION_SOURCE_CHANGED"
    );
    Ok(())
}

fn existing_locks(directory: &PrivateDirectory) -> Result<Vec<File>> {
    let mut leases = Vec::new();
    for name in LOCKS {
        // Match normal settings locking: existing coordination leaves need not
        // be private, while their actual descriptor and current name must agree.
        let file = match directory.open_read_write_file(OsStr::new(name), false) {
            Ok(file) => file,
            Err(error) if missing(&error) => continue,
            Err(error) => return Err(error),
        };
        let identity = PrivateDirectory::identity_of_file(&file)?;
        let acquired = fs2::FileExt::try_lock_shared(&file);
        ensure!(
            PrivateDirectory::identity_of_file(&file)? == identity
                && directory.regular_file_identity(OsStr::new(name))? == identity,
            "CREDENTIAL_RELOCATION_LOCK_CHANGED"
        );
        match acquired {
            Ok(()) => leases.push(file),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        Some(code) == fs2::lock_contended_error().raw_os_error()
                    }) =>
            {
                anyhow::bail!("CREDENTIAL_RELOCATION_BUSY")
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(leases)
}

#[cfg(test)]
mod tests;
