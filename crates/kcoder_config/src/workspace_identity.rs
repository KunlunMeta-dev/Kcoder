//! Profile-owned workspace continuity facts, separate from live authorization.
//!
//! Only a managed-worktree owner's stopped relocation may issue a workspace
//! mapping. Native owners still check their actual directories and revocation.
use crate::{PortableLeaseIdentity, PrivateDirectory, storage::StoragePublishedComponent};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::File,
    path::{Component, Path, PathBuf},
};

mod observation;
mod relocation;
mod storage;
pub use observation::WorkspaceAddressReader;
use storage::HeldDocument;

const INDEX: &str = ".workspace-identity-addresses.json";
const MAX_RECORD_BYTES: u64 = 16 * 1024;
const MAX_INDEX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WORKSPACES: usize = 4096;
const MAX_ADDRESSES: usize = 16384;

/// Implemented by the existing managed-worktree relocation owner, never by RPC
/// data or a deserialized receipt. Each verify rechecks its original Git owner,
/// registry, operation and held publication. This is not a shutdown allow flag.
pub trait ManagedWorkspaceRelocationProof {
    fn verify(&self) -> Result<()>;
    fn operation_id(&self) -> &str;
    fn worktree_id(&self) -> &str;
    fn source_path(&self) -> &Path;
    fn destination_path(&self) -> &Path;
    fn relative_path(&self) -> &Path;
    fn source_directory(&self) -> &PrivateDirectory;
    fn target_directory(&self) -> &PrivateDirectory;
    fn published_component(&self) -> &StoragePublishedComponent;
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    operation_id: String,
    worktree_id: String,
    logical_seed: String,
    workspace_identity: String,
    workspace_path: PathBuf,
    project_storage_key: String,
    storage_workspace_path: PathBuf,
    source_profile_identity: String,
    source_workspace_identity: String,
    source_record_sha256: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddressIndex {
    operation_id: String,
    source_profile_identity: String,
    source_index_sha256: Option<String>,
    current: BTreeSet<String>,
    addresses: BTreeMap<PathBuf, AddressBinding>,
    moved: BTreeMap<String, String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddressBinding {
    current_identity: String,
    source_identity: String,
}

/// A held mapping observation. Missing metadata retains the legacy physical seed
/// without creating a registry, lock, directory or workspace file.
pub struct WorkspaceIdentity {
    profile_identity: String,
    workspace_identity: String,
    logical_seed: String,
    record: Option<HeldDocument<Record>>,
}

impl std::fmt::Debug for WorkspaceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WorkspaceIdentity { physical_binding: held }")
    }
}

/// A locator only. A moved address must be explicitly restored to its current
/// directory; it must not reopen the retained old directory as a new scope.
pub enum WorkspaceAddressLookup {
    Current(WorkspaceLocation),
    Moved(WorkspaceLocation),
}

pub struct WorkspaceLocation {
    requested: PathBuf,
    source_identity: String,
    path: PathBuf,
    workspace: PrivateDirectory,
    identity: WorkspaceIdentity,
    observation: std::sync::Arc<WorkspaceAddressReader>,
}

impl WorkspaceLocation {
    pub fn workspace_path(&self) -> &Path {
        &self.path
    }
    pub fn logical_seed(&self) -> &str {
        self.identity.logical_seed()
    }
    pub fn recorded_directory_identity(&self) -> &str {
        &self.source_identity
    }
    pub fn directory_identity(&self) -> &str {
        &self.identity.workspace_identity
    }
    pub fn project_storage_key(&self) -> &str {
        self.identity
            .project_storage_key()
            .expect("mapped location")
    }
    /// Preserve legacy project-history read candidates after the original cwd
    /// has gone. This address is not a directory to execute or authorize.
    pub fn storage_workspace_path(&self) -> &Path {
        self.identity
            .storage_workspace_path()
            .expect("mapped location")
    }
    pub fn verify(&self, profile: &PrivateDirectory) -> Result<()> {
        self.observation.verify(profile)?;
        self.identity.verify_record_only(profile, &self.workspace)?;
        ensure!(
            PrivateDirectory::open_existing(&self.path)?.directory_identity()?
                == self.identity.workspace_identity,
            "WORKSPACE_IDENTITY_DIRECTORY_CHANGED"
        );
        self.observation.verify_location(
            &self.requested,
            &self.identity.workspace_identity,
            &self.source_identity,
        )?;
        self.observation.verify(profile)
    }
}

impl WorkspaceIdentity {
    pub fn observe(profile: &PrivateDirectory, workspace: &PrivateDirectory) -> Result<Self> {
        profile.verify_config_root_directory()?;
        let workspace_identity = workspace.directory_identity()?;
        let index = read_index(profile)?;
        if let Some(target) = index
            .as_ref()
            .and_then(|index| index.value.value.moved.get(&workspace_identity))
        {
            let current =
                read_record(profile, target)?.context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
            anyhow::bail!(
                "WORKSPACE_IDENTITY_MOVED: {}",
                current.value.value.workspace_path.display()
            );
        }
        let record = read_record(profile, &workspace_identity)?;
        ensure!(
            record.is_some()
                == index.as_ref().is_some_and(|index| {
                    index.value.value.current.contains(&workspace_identity)
                }),
            "WORKSPACE_IDENTITY_INDEX_CHANGED"
        );
        if let (Some(index), Some(record)) = (&index, &record) {
            ensure!(
                index
                    .value
                    .value
                    .addresses
                    .get(&record.value.value.workspace_path)
                    == Some(&AddressBinding {
                        current_identity: workspace_identity.clone(),
                        source_identity: workspace_identity.clone(),
                    }),
                "WORKSPACE_IDENTITY_ADDRESS_CHANGED"
            );
        }
        Ok(Self::from_record(profile, workspace_identity, record)?)
    }

    pub fn logical_seed(&self) -> &str {
        &self.logical_seed
    }
    pub fn project_storage_key(&self) -> Option<&str> {
        self.record
            .as_ref()
            .map(|record| record.value.value.project_storage_key.as_str())
    }
    pub fn storage_workspace_path(&self) -> Option<&Path> {
        self.record
            .as_ref()
            .map(|record| record.value.value.storage_workspace_path.as_path())
    }
    pub fn verify(&self, profile: &PrivateDirectory, workspace: &PrivateDirectory) -> Result<()> {
        ensure!(
            profile.directory_identity()? == self.profile_identity
                && workspace.directory_identity()? == self.workspace_identity,
            "WORKSPACE_IDENTITY_DIRECTORY_CHANGED"
        );
        let current = Self::observe(profile, workspace)?;
        ensure!(
            current.logical_seed == self.logical_seed,
            "WORKSPACE_IDENTITY_RECORD_CHANGED"
        );
        match (&self.record, &current.record) {
            (None, None) => Ok(()),
            (Some(original), Some(current)) => {
                original.verify_anchor()?;
                ensure!(
                    original.bytes == current.bytes,
                    "WORKSPACE_IDENTITY_RECORD_CHANGED"
                );
                Ok(())
            }
            _ => anyhow::bail!("WORKSPACE_IDENTITY_RECORD_CHANGED"),
        }
    }

    fn verify_record_only(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        ensure!(
            profile.directory_identity()? == self.profile_identity
                && workspace.directory_identity()? == self.workspace_identity,
            "WORKSPACE_IDENTITY_DIRECTORY_CHANGED"
        );
        let record = read_record(profile, &self.workspace_identity)?
            .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
        let original = self
            .record
            .as_ref()
            .context("WORKSPACE_IDENTITY_RECORD_REQUIRED")?;
        original.verify_anchor()?;
        ensure!(
            original.bytes == record.bytes,
            "WORKSPACE_IDENTITY_RECORD_CHANGED"
        );
        Ok(())
    }

    /// Retain one immutable mapping observation for a bounded read page. This
    /// caches facts only; every lookup checks the actual index name and stamp.
    pub fn observe_addresses(
        profile: &PrivateDirectory,
    ) -> Result<std::sync::Arc<WorkspaceAddressReader>> {
        WorkspaceAddressReader::observe(profile).map(std::sync::Arc::new)
    }

    /// One bounded index read and one exact current leaf. The old directory is
    /// never opened, scanned, canonicalized or recreated by address recovery.
    pub fn lookup(
        profile: &PrivateDirectory,
        address: &Path,
    ) -> Result<Option<WorkspaceAddressLookup>> {
        Self::observe_addresses(profile)?.lookup(profile, address)
    }

    fn from_record(
        profile: &PrivateDirectory,
        workspace_identity: String,
        record: Option<HeldDocument<Record>>,
    ) -> Result<Self> {
        Ok(Self {
            profile_identity: profile.directory_identity()?,
            logical_seed: record.as_ref().map_or_else(
                || workspace_identity.clone(),
                |record| record.value.value.logical_seed.clone(),
            ),
            workspace_identity,
            record,
        })
    }
}

fn record_name(workspace_identity: &str) -> String {
    format!(
        ".workspace-identity-{}.json",
        digest(workspace_identity.as_bytes())
    )
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn valid_operation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn valid_hash(value: &Option<String>) -> bool {
    value.as_ref().is_none_or(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}
fn validate_path(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute()
            && path.to_str().is_some_and(|path| text(path, 4096))
            && !path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir)),
        "WORKSPACE_IDENTITY_PATH_INVALID"
    );
    Ok(())
}
fn read_record(profile: &PrivateDirectory, identity: &str) -> Result<Option<HeldDocument<Record>>> {
    let record = storage::read::<Record>(profile, &record_name(identity), MAX_RECORD_BYTES)?;
    if let Some(record) = &record {
        let value = &record.value.value;
        validate_path(&value.workspace_path)?;
        validate_path(&value.storage_workspace_path)?;
        ensure!(
            valid_operation(&value.operation_id)
                && text(&value.worktree_id, 256)
                && text(&value.logical_seed, 256)
                && value.workspace_identity == identity
                && text(&value.source_profile_identity, 256)
                && text(&value.source_workspace_identity, 256)
                && text(&value.project_storage_key, 256)
                && matches!(
                    Path::new(&value.project_storage_key)
                        .components()
                        .collect::<Vec<_>>()
                        .as_slice(),
                    [Component::Normal(_)]
                )
                && valid_hash(&value.source_record_sha256),
            "WORKSPACE_IDENTITY_RECORD_INVALID"
        );
    }
    Ok(record)
}
fn read_index(profile: &PrivateDirectory) -> Result<Option<HeldDocument<AddressIndex>>> {
    let index = storage::read::<AddressIndex>(profile, INDEX, MAX_INDEX_BYTES)?;
    if let Some(index) = &index {
        validate_index(&index.value.value)?;
    }
    Ok(index)
}
fn validate_index(value: &AddressIndex) -> Result<()> {
    ensure!(
        valid_operation(&value.operation_id)
            && text(&value.source_profile_identity, 256)
            && valid_hash(&value.source_index_sha256)
            && value.current.len() <= MAX_WORKSPACES
            && value.addresses.len() <= MAX_ADDRESSES
            && value.moved.len() <= MAX_ADDRESSES
            && value.current.iter().all(|id| text(id, 256))
            && value.addresses.values().all(|binding| {
                value.current.contains(&binding.current_identity)
                    && (binding.source_identity == binding.current_identity
                        || value.moved.get(&binding.source_identity)
                            == Some(&binding.current_identity))
            })
            && value.moved.iter().all(|(old, current)| {
                text(old, 256) && !value.current.contains(old) && value.current.contains(current)
            }),
        "WORKSPACE_IDENTITY_INDEX_INVALID"
    );
    for path in value.addresses.keys() {
        validate_path(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
