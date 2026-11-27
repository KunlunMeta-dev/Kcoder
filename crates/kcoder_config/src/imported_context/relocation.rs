//! Offline verification retains project paths, activation and operation receipts.
use super::*;
use crate::PortableLeaseIdentity;
use sha2::{Digest, Sha256};

const LOCK: &str = ".imported-context.lock";
const RECEIPT: &str = ".imported-context-relocation.json";
const RECEIPT_LIMIT: u64 = 256 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedContextRelocationSnapshot {
    profile_identity: String,
    lock_identity: PortableLeaseIdentity,
    state_identity: PortableLeaseIdentity,
    state_sha256: String,
    relocation_sha256: Option<String>,
    external_directories: BTreeMap<PathBuf, String>,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelocationReceipt {
    version: u32,
    operation_id: String,
    source: ImportedContextRelocationSnapshot,
    target_profile_identity: String,
    target_lock_identity: PortableLeaseIdentity,
    target_state_identity: PortableLeaseIdentity,
}

impl ImportedContextStore {
    /// Observe only published context data. A lock left by an empty ordinary
    /// reader is not a store; incomplete state/receipt pairs are never initialized.
    pub fn observe(profile: &Path) -> Result<Option<Self>> {
        let store = match Self::open(profile) {
            Ok(store) => store,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let lease = match store.directory.try_existing_shared_lock(OsStr::new(LOCK)) {
            Ok(Some(lease)) => lease,
            Ok(None) => anyhow::bail!("imported_context_busy"),
            Err(error) if missing(&error) => {
                ensure!(
                    !entry_present(&store.directory, STATE)?
                        && !entry_present(&store.directory, RECEIPT)?,
                    "imported_context_initialization_unconfirmed"
                );
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        PortableLeaseIdentity::from_private_regular_handle(&lease)?;
        if !entry_present(&store.directory, STATE)? {
            ensure!(
                !entry_present(&store.directory, RECEIPT)?,
                "imported_context_initialization_unconfirmed"
            );
            return Ok(None);
        }
        store.relocation_snapshot_locked()?;
        Ok(Some(store))
    }

    /// No lock or state is created. Every project record must still identify
    /// its original trusted external workspace, including disabled notes.
    pub fn relocation_snapshot(&self) -> Result<ImportedContextRelocationSnapshot> {
        let _lease = self
            .directory
            .try_existing_shared_lock(OsStr::new(LOCK))?
            .ok_or_else(|| anyhow::anyhow!("imported_context_busy"))?;
        self.relocation_snapshot_locked()
    }

    /// The caller owns the stopped same-account operation and its exact copy.
    /// No imported text, project path, enabled flag or business receipt changes.
    pub fn relocate(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ImportedContextRelocationSnapshot,
    ) -> Result<Self> {
        self.relocation_target(final_target_profile, operation_id, expected)
    }

    pub fn verify_relocation(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ImportedContextRelocationSnapshot,
    ) -> Result<()> {
        self.relocation_target(final_target_profile, operation_id, expected)
            .map(|_| ())
    }

    fn verify_profile(&self) -> Result<()> {
        self.directory.verify_config_root_directory()?;
        ensure!(
            PrivateDirectory::open_existing(&self.profile)?.directory_identity()?
                == self.directory.directory_identity()?,
            "imported_context_relocation_profile_changed"
        );
        Ok(())
    }

    fn external_directories(&self, state: &State) -> Result<BTreeMap<PathBuf, String>> {
        let trust = crate::FolderTrustStore::load(&self.profile);
        let mut directories = BTreeMap::new();
        for record in state.records.values() {
            instructions::verify_record_target(&self.profile, record)?;
            self.verify_memory_scope(record)?;
            let ImportedContextScope::Project { root } = &record.scope else {
                continue;
            };
            for path in std::iter::once(root).chain(
                record
                    .instruction_provenance
                    .as_ref()
                    .map(|origin| &origin.target_root),
            ) {
                let directory = PrivateDirectory::open_existing(path)?;
                directory.verify_trusted_config_directory()?;
                ensure!(
                    path.canonicalize()? == *path
                        && trust.check(path) == crate::FolderTrust::Trusted,
                    "imported_context_relocation_workspace_untrusted"
                );
                directories.insert(path.clone(), directory.directory_identity()?);
            }
        }
        Ok(directories)
    }

    fn relocation_snapshot_locked(&self) -> Result<ImportedContextRelocationSnapshot> {
        self.verify_profile()?;
        let state = self.read()?;
        let data = read(&self.directory, STATE, MAX_BYTES)?;
        ensure!(
            serde_json::to_value(serde_json::from_slice::<State>(&data)?)?
                == serde_json::to_value(&state)?,
            "imported_context_relocation_source_changed"
        );
        let lock_identity = file_identity(&self.directory, LOCK)?;
        let prior_receipt = optional_receipt(&self.directory)?;
        if let Some(bytes) = &prior_receipt {
            let receipt: RelocationReceipt = serde_json::from_slice(bytes)?;
            ensure!(
                receipt.version == 1
                    && valid_operation(&receipt.operation_id)
                    && !receipt.target_profile_identity.is_empty()
                    && receipt.source.state_sha256.len() == 64,
                "imported_context_relocation_receipt_invalid"
            );
        }
        let snapshot = ImportedContextRelocationSnapshot {
            profile_identity: self.directory.directory_identity()?,
            lock_identity,
            state_identity: file_identity(&self.directory, STATE)?,
            state_sha256: digest(&data),
            relocation_sha256: prior_receipt.as_deref().map(digest),
            external_directories: self.external_directories(&state)?,
        };
        self.verify_profile()?;
        Ok(snapshot)
    }

    fn relocation_target(
        &self,
        final_target_profile: &Path,
        operation_id: &str,
        expected: &ImportedContextRelocationSnapshot,
    ) -> Result<Self> {
        ensure!(
            valid_operation(operation_id),
            "imported_context_invalid_operation"
        );
        let _source_lease = self
            .directory
            .try_existing_exclusive_lock(OsStr::new(LOCK))?
            .ok_or_else(|| anyhow::anyhow!("imported_context_busy"))?;
        ensure!(
            self.relocation_snapshot_locked()? == *expected,
            "imported_context_relocation_source_changed"
        );
        let target = Self::open(final_target_profile)?;
        ensure!(
            target.directory.directory_identity()? != expected.profile_identity,
            "imported_context_relocation_same_profile"
        );
        let _target_lease = target
            .directory
            .try_existing_exclusive_lock(OsStr::new(LOCK))?
            .ok_or_else(|| anyhow::anyhow!("imported_context_busy"))?;
        let original_receipt = optional_receipt(&self.directory)?;
        let data = read(&self.directory, STATE, MAX_BYTES)?;
        let target_state_identity = file_identity(&target.directory, STATE)?;
        let target_lock_identity = file_identity(&target.directory, LOCK)?;
        ensure!(
            read(&target.directory, STATE, MAX_BYTES)? == data
                && optional_receipt(&target.directory)? == original_receipt
                && target.external_directories(&target.read()?)? == expected.external_directories,
            "imported_context_relocation_data_changed"
        );
        // The original coordinator owns publication and unknown receipts. This
        // plain owner has no physical metadata to convert or second ledger to write.
        self.verify_profile()?;
        target.verify_profile()?;
        ensure!(
            self.relocation_snapshot_locked()? == *expected
                && file_identity(&target.directory, STATE)? == target_state_identity
                && file_identity(&target.directory, LOCK)? == target_lock_identity
                && read(&target.directory, STATE, MAX_BYTES)? == data
                && optional_receipt(&target.directory)? == original_receipt,
            "imported_context_relocation_data_changed"
        );
        Ok(target)
    }
}

fn optional_receipt(directory: &PrivateDirectory) -> Result<Option<Vec<u8>>> {
    match read(directory, RECEIPT, RECEIPT_LIMIT) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|cause| cause.kind() == std::io::ErrorKind::NotFound)
    })
}

fn entry_present(directory: &PrivateDirectory, name: &str) -> Result<bool> {
    match directory.entry_metadata(OsStr::new(name)) {
        Ok(_) => Ok(true),
        Err(error) if missing(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn file_identity(directory: &PrivateDirectory, name: &str) -> Result<PortableLeaseIdentity> {
    directory.verify_config_root_directory()?;
    PortableLeaseIdentity::from_private_regular_handle(
        &directory.open_single_link_regular_file(OsStr::new(name))?,
    )
}

fn read(directory: &PrivateDirectory, name: &str, max: u64) -> Result<Vec<u8>> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= max,
        "imported_context_budget_exceeded"
    );
    Ok(bytes)
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
