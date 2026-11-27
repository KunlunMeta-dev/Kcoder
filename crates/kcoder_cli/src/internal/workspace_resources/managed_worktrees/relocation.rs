//! Offline relocation of owned linked worktrees, never of their source repositories.
//!
//! The coordinator supplies stopped-tree authority, the complete final copy, and
//! its original operation directory. Ordinary loading does not call this module.
use super::*;
use crate::git::run_git_command_with_private_repository;
use kcoder_config::storage::StoragePublishedComponent;
use kcoder_config::workspace_identity::{ManagedWorkspaceRelocationProof, WorkspaceIdentity};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use sha2::Digest as _;
use std::{ffi::OsStr, fs::File, io::Read};

mod profile;
pub use profile::{profile_relocation_reference_paths, profile_relocation_snapshots_for_operation};

const LOCK: &str = "managed-worktrees-relocation.lock";
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 60_000;
const MAX_PROFILE_PROJECTS: usize = 16_384;

/// One explicitly registered project owner, including a new worktree that has
/// no State session yet. This set is not an execution or shutdown capability.
pub struct ProfileManagedWorktreeRelocation {
    pub source_store: ClientWorktreeStore,
    pub target_store: ClientWorktreeStore,
    pub snapshot: ManagedWorktreeRelocationSnapshot,
}

/// Collect only Native's immediate projects/<key>/managed-worktrees.json
/// namespace. Missing profiles/registries remain missing; unrelated same-name
/// files elsewhere are neither searched nor adopted.
pub async fn profile_relocation_snapshots(
    source_data_root: &Path,
    target_data_root: &Path,
) -> Result<Vec<ProfileManagedWorktreeRelocation>> {
    profile::collect(source_data_root, target_data_root, None).await
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileStamp {
    identity: PortableLeaseIdentity,
    sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitBinding {
    workspace_identity: String,
    common: PathBuf,
    common_identity: String,
    admin: PathBuf,
    admin_identity: String,
    dotgit: FileStamp,
    dotgit_bytes: String,
    gitdir: FileStamp,
    gitdir_bytes: String,
    commondir: FileStamp,
    head: String,
    status: String,
    admin_sha256: String,
    content_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    target: PathBuf,
    worktree_id: String,
    revision: u64,
    git: Option<GitBinding>,
    snapshot: Option<SnapshotRef>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRef {
    common: PathBuf,
    common_identity: String,
    old: String,
    new: String,
    commit: String,
}

/// Serializable evidence for one stopped source. Content hashes are taken only
/// here, after stopping, rather than in ordinary reads or the lightweight preview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedWorktreeRelocationSnapshot {
    source_data_root: PathBuf,
    source_data_root_identity: String,
    target_data_root: PathBuf,
    source_registry: PathBuf,
    target_registry: PathBuf,
    registry: FileStamp,
    source_root: PathBuf,
    target_root: PathBuf,
    entries: Vec<Entry>,
}

/// Redirecting an external Git registration makes the retained old directory
/// unsuitable for reopening. The coordinator must settle this before deferral.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedWorktreeRelocationResult {
    pub redirected_worktrees: Vec<PathBuf>,
    pub source_registration_preserved: bool,
}

/// Held copy/registration facts only. They grant no execution or domain access
/// and cannot be reconstructed from a serialized scope or client-supplied labels.
#[derive(Debug)]
pub struct OwnedManagedWorkspaceRelocation<'p> {
    published: &'p StoragePublishedComponent,
    operation_id: String,
    worktree_id: String,
    revision: u64,
    source_registry: PathBuf,
    registry: FileStamp,
    relative: PathBuf,
    source_path: PathBuf,
    target_path: PathBuf,
    source: PrivateDirectory,
    target: PrivateDirectory,
    source_identity: String,
    target_identity: String,
    git: GitBinding,
    registration: FileStamp,
    target_dotgit: FileStamp,
}

#[derive(Debug)]
pub struct VerifiedManagedWorktreeRelocation<'p> {
    summary: ManagedWorktreeRelocationResult,
    workspaces: Vec<OwnedManagedWorkspaceRelocation<'p>>,
}

impl<'p> VerifiedManagedWorktreeRelocation<'p> {
    pub fn summary(&self) -> &ManagedWorktreeRelocationResult {
        &self.summary
    }
    pub fn workspace_facts(&self) -> &[OwnedManagedWorkspaceRelocation<'p>] {
        &self.workspaces
    }
}

impl OwnedManagedWorkspaceRelocation<'_> {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn worktree_id(&self) -> &str {
        &self.worktree_id
    }
    pub fn source_path(&self) -> &Path {
        &self.source_path
    }
    pub fn destination_path(&self) -> &Path {
        &self.target_path
    }
    pub fn source_directory(&self) -> &PrivateDirectory {
        &self.source
    }
    pub fn target_directory(&self) -> &PrivateDirectory {
        &self.target
    }
    pub fn source_directory_identity(&self) -> &str {
        &self.source_identity
    }
    pub fn target_directory_identity(&self) -> &str {
        &self.target_identity
    }
    pub fn source_registry_path(&self) -> &Path {
        &self.source_registry
    }
    pub fn source_registry_identity(&self) -> &PortableLeaseIdentity {
        &self.registry.identity
    }
    pub fn source_record_revision(&self) -> u64 {
        self.revision
    }
    pub fn relative_path(&self) -> &Path {
        &self.relative
    }

    /// Issue only Config's single profile-owned continuity mapping after this
    /// original managed registration and published copy have been rechecked.
    pub fn relocate_workspace_identity(
        &self,
        source_profile: &PrivateDirectory,
        target_profile: &PrivateDirectory,
    ) -> Result<WorkspaceIdentity> {
        self.verify()?;
        WorkspaceIdentity::relocate(source_profile, target_profile, self)
    }

    pub fn verify_workspace_identity_relocation(
        &self,
        source_profile: &PrivateDirectory,
        target_profile: &PrivateDirectory,
    ) -> Result<WorkspaceIdentity> {
        self.verify()?;
        WorkspaceIdentity::verify_relocation(source_profile, target_profile, self)
    }

    /// Observe the current publication, original registry, and held directories.
    /// The logical workspace owner must independently verify its source state.
    pub fn verify(&self) -> Result<()> {
        self.published.verify()?;
        ensure!(
            self.published.operation_id() == self.operation_id
                && self.published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
                && self
                    .source_registry
                    .starts_with(self.published.source_path())
                && self.source_path == self.published.source_path().join(&self.relative)
                && self.target_path == self.published.destination_path().join(&self.relative),
            "managed_worktree_relocation_workspace_publication_changed"
        );
        let (bytes, registry) = read_path(&self.source_registry)?;
        ensure!(
            registry == self.registry,
            "managed_worktree_relocation_workspace_registry_changed"
        );
        let state: Value = serde_json::from_slice(&bytes)?;
        let version = state["version"].as_u64().unwrap_or(0);
        let root = state["settings"]["resolvedWorktreeRoot"]
            .as_str()
            .unwrap_or_default();
        let root = Path::new(root);
        let stored_path = super::registry::registry_storage_path(version, root, &self.source_path)?;
        let record = &state["records"][&stored_path];
        ensure!(
            record["path"].as_str() == Some(stored_path.as_str())
                && record["worktreeId"].as_str() == Some(self.worktree_id.as_str())
                && record["revision"].as_u64().unwrap_or(0) == self.revision,
            "managed_worktree_relocation_workspace_record_changed"
        );
        ensure!(
            self.source.directory_identity()? == self.source_identity
                && directory(&self.source_path)?.directory_identity()? == self.source_identity
                && self.target.directory_identity()? == self.target_identity
                && directory(&self.target_path)?.directory_identity()? == self.target_identity
                && self.source_identity != self.target_identity,
            "managed_worktree_relocation_workspace_identity_changed"
        );
        ensure!(
            read_path(&self.source_path.join(".git"))?.1 == self.git.dotgit
                && read_path(&self.target_path.join(".git"))?.1 == self.target_dotgit,
            "managed_worktree_relocation_workspace_git_binding_changed"
        );
        ensure!(
            directory(&self.git.common)?.directory_identity()? == self.git.common_identity
                && directory(&self.git.admin)?.directory_identity()? == self.git.admin_identity
                && read_path(&self.git.admin.join("commondir"))?.1 == self.git.commondir
                && read_path(&self.git.admin.join("gitdir"))?.1 == self.registration,
            "managed_worktree_relocation_workspace_registration_changed"
        );
        Ok(())
    }
}

impl ManagedWorkspaceRelocationProof for OwnedManagedWorkspaceRelocation<'_> {
    fn verify(&self) -> Result<()> {
        OwnedManagedWorkspaceRelocation::verify(self)
    }
    fn operation_id(&self) -> &str {
        OwnedManagedWorkspaceRelocation::operation_id(self)
    }
    fn worktree_id(&self) -> &str {
        OwnedManagedWorkspaceRelocation::worktree_id(self)
    }
    fn source_path(&self) -> &Path {
        OwnedManagedWorkspaceRelocation::source_path(self)
    }
    fn destination_path(&self) -> &Path {
        OwnedManagedWorkspaceRelocation::destination_path(self)
    }
    fn relative_path(&self) -> &Path {
        OwnedManagedWorkspaceRelocation::relative_path(self)
    }
    fn source_directory(&self) -> &PrivateDirectory {
        OwnedManagedWorkspaceRelocation::source_directory(self)
    }
    fn target_directory(&self) -> &PrivateDirectory {
        OwnedManagedWorkspaceRelocation::target_directory(self)
    }
    fn published_component(&self) -> &StoragePublishedComponent {
        self.published
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetWorkspace {
    directory_identity: String,
    dotgit: FileStamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Replacement {
    parent: PathBuf,
    parent_identity: String,
    name: String,
    original: FileStamp,
    replacement_sha256: String,
    // Observed on the flushed candidate before its first namespace publication.
    candidate: Option<FileStamp>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RefState {
    NotStarted,
    Intent,
    Verified,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    version: u32,
    operation_id: String,
    control_identity: String,
    target_identity: String,
    source: ManagedWorktreeRelocationSnapshot,
    target_dotgit: BTreeMap<PathBuf, TargetWorkspace>,
    replacements: Vec<Replacement>,
    refs: Vec<RefState>,
    target_registry: FileStamp,
}

impl ClientWorktreeStore {
    /// Read-only support preview. Missing registries do not initialize storage.
    /// Unknown layouts return an error naming the unsupported owner boundary.
    pub async fn relocation_preview(
        &self,
        source_data_root: &Path,
        target_data_root: &Path,
    ) -> Result<bool> {
        self.capture_relocation(source_data_root, target_data_root, false)
            .await
            .map(|snapshot| snapshot.is_some())
    }

    pub async fn relocation_snapshot(
        &self,
        source_data_root: &Path,
        target_data_root: &Path,
    ) -> Result<Option<ManagedWorktreeRelocationSnapshot>> {
        self.capture_relocation(source_data_root, target_data_root, true)
            .await
    }

    async fn capture_relocation(
        &self,
        source_data_root: &Path,
        target_data_root: &Path,
        hash_content: bool,
    ) -> Result<Option<ManagedWorktreeRelocationSnapshot>> {
        validate_roots(source_data_root, target_data_root)?;
        ensure!(
            self.state_path.starts_with(source_data_root),
            "managed_worktree_relocation_registry_outside_data_root"
        );
        if absent(&self.state_path)? {
            return Ok(None);
        }
        let (bytes, registry) = read_path(&self.state_path)?;
        let state = self.load()?;
        let source_root = PathBuf::from(&state.settings.resolved_worktree_root);
        let target_root = mapped(&source_root, source_data_root, target_data_root);
        let mut snapshot = ManagedWorktreeRelocationSnapshot {
            source_data_root: source_data_root.into(),
            source_data_root_identity: directory(source_data_root)?.directory_identity()?,
            target_data_root: target_data_root.into(),
            source_registry: self.state_path.clone(),
            target_registry: mapped(&self.state_path, source_data_root, target_data_root),
            registry,
            source_root,
            target_root,
            entries: Vec::new(),
        };
        // Explicit external roots and all their source/common paths stay intact.
        if snapshot.source_root == snapshot.target_root {
            #[cfg(windows)]
            {
                let source_identity = serde_json::to_string(
                    &directory(source_data_root)?.portable_directory_handle_identity()?,
                )?;
                ensure!(
                    !profile::reference_ancestors(&snapshot.source_root).contains(&source_identity),
                    "STORAGE_MANAGED_WORKTREE_INTERNAL_ALIAS_UNSUPPORTED"
                );
            }
            return Ok(Some(snapshot));
        }
        validate_owned_root(&snapshot.source_root, &state)?;
        for record in state.records.values() {
            let path = PathBuf::from(&record.path);
            ensure!(
                path == snapshot
                    .source_root
                    .join(&record.worktree_id)
                    .join(&record.repository_name)
                    && matches!(
                        Path::new(&record.repository_name)
                            .components()
                            .collect::<Vec<_>>()
                            .as_slice(),
                        [std::path::Component::Normal(_)]
                    ),
                "managed_worktree_relocation_unproven_owned_path: {}",
                path.display()
            );
            ensure!(
                !matches!(record.state.as_str(), "restoring" | "snapshot_ready"),
                "managed_worktree_relocation_unsettled_lifecycle: {}",
                record.state
            );
            let target = mapped(&path, source_data_root, target_data_root);
            let source = record.source_path.as_deref().map(Path::new);
            ensure!(
                source.is_none_or(|source| !source.starts_with(source_data_root)),
                "managed_worktree_relocation_source_repository_inside_data_root"
            );
            let git = if record.state == "active" {
                let source = source.context("managed_worktree_relocation_source_missing")?;
                let binding = capture_git(&path, source, hash_content).await?;
                ensure!(
                    !binding.common.starts_with(source_data_root),
                    "managed_worktree_relocation_common_repository_inside_data_root"
                );
                if let Some(common) = record.git_common_dir.as_deref() {
                    ensure!(
                        Path::new(common) == binding.common,
                        "managed_worktree_relocation_common_mismatch"
                    );
                }
                Some(binding)
            } else {
                ensure!(
                    absent(&path)?,
                    "managed_worktree_relocation_nonactive_directory_present"
                );
                None
            };
            let retained = match (
                &record.snapshot_ref,
                &record.snapshot_commit,
                &record.git_common_dir,
            ) {
                (Some(old), Some(commit), Some(common)) => {
                    let common = PathBuf::from(common);
                    ensure!(
                        !common.starts_with(source_data_root),
                        "managed_worktree_relocation_common_repository_inside_data_root"
                    );
                    let new = format!(
                        "refs/kcoder/worktree-snapshots/{}",
                        hex_sha256(target.to_string_lossy().as_bytes())
                    );
                    let retained = SnapshotRef {
                        common_identity: directory(&common)?.directory_identity()?,
                        common,
                        old: old.clone(),
                        new,
                        commit: commit.clone(),
                    };
                    verify_old_ref(&retained).await?;
                    ensure!(
                        read_ref(&retained.common, &retained.new).await?.is_none(),
                        "managed_worktree_relocation_target_ref_exists"
                    );
                    Some(retained)
                }
                (None, None, _) => None,
                _ => anyhow::bail!("managed_worktree_relocation_incomplete_snapshot"),
            };
            snapshot.entries.push(Entry {
                path,
                target,
                worktree_id: record.worktree_id.clone(),
                revision: record.revision,
                git,
                snapshot: retained,
            });
        }
        ensure!(
            read_path(&self.state_path)?.0 == bytes,
            "managed_worktree_relocation_source_changed"
        );
        Ok(Some(snapshot))
    }

    /// Repair only exact owned Git administrative files. No broad Git repair,
    /// prune, reset, archive, restore, or queue operation is executed.
    pub async fn relocate<'p>(
        &self,
        final_target: &ClientWorktreeStore,
        operation_id: &str,
        control: &PrivateDirectory,
        expected: &ManagedWorktreeRelocationSnapshot,
        published: &'p StoragePublishedComponent,
    ) -> Result<VerifiedManagedWorktreeRelocation<'p>> {
        verify_publication(expected, operation_id, published)?;
        let summary = self
            .relocate_core(final_target, operation_id, control, expected)
            .await?;
        self.workspace_facts(summary, operation_id, control, expected, published)
    }

    async fn relocate_core(
        &self,
        final_target: &ClientWorktreeStore,
        operation_id: &str,
        control: &PrivateDirectory,
        expected: &ManagedWorktreeRelocationSnapshot,
    ) -> Result<ManagedWorktreeRelocationResult> {
        validate_operation(operation_id)?;
        let _lease = control
            .try_exclusive_lock(OsStr::new(LOCK))?
            .context("managed_worktree_relocation_operation_busy")?;
        let transformed = self.target_bytes(final_target, expected)?;
        let existing = read_optional(control, &receipt_name(&expected.source_registry))?;
        let mut receipt = if let Some(bytes) = existing {
            let receipt: Receipt = serde_json::from_slice(&bytes)?;
            check_receipt(&receipt, operation_id, control, expected)?;
            receipt
        } else {
            let receipt =
                prepare_receipt(final_target, operation_id, control, expected, &transformed)
                    .await?;
            let bytes = serde_json::to_vec(&receipt)?;
            control.atomic_publish_from_reader(
                OsStr::new(&receipt_name(&expected.source_registry)),
                &mut &bytes[..],
                false,
                || Ok(()),
            )?;
            receipt
        };
        verify_source(expected, &receipt)?;
        verify_target_dotgit(&receipt)?;
        let git_count = expected
            .entries
            .iter()
            .filter(|entry| entry.git.is_some())
            .count();
        for index in 0..git_count {
            let bytes = gitdir_replacement(
                &expected
                    .entries
                    .iter()
                    .filter(|entry| entry.git.is_some())
                    .nth(index)
                    .unwrap()
                    .target,
            )?;
            replace_owned(control, &mut receipt, index, &bytes)
                .context("managed_worktree_relocation_unsettled_do_not_reopen_source")?;
        }
        for (index, retained) in expected
            .entries
            .iter()
            .filter_map(|entry| entry.snapshot.as_ref())
            .enumerate()
        {
            verify_old_ref(retained).await?;
            match receipt.refs[index] {
                RefState::NotStarted => {
                    ensure!(
                        read_ref(&retained.common, &retained.new).await?.is_none(),
                        "managed_worktree_relocation_target_ref_exists"
                    );
                    receipt.refs[index] = RefState::Intent;
                    write_receipt(control, &receipt)?;
                    let zero = "0".repeat(retained.commit.len());
                    let result = git(
                        &retained.common,
                        None,
                        &[
                            "update-ref",
                            "--no-deref",
                            &retained.new,
                            &retained.commit,
                            &zero,
                        ],
                    )
                    .await;
                    // Even an error can follow a committed ref update. Reconcile
                    // this original intent rather than reissuing the command.
                    if read_ref(&retained.common, &retained.new).await?.as_deref()
                        != Some(&retained.commit)
                    {
                        return Err(result.err().unwrap_or_else(|| {
                            anyhow::anyhow!("managed_worktree_relocation_ref_unsettled")
                        }));
                    }
                    receipt.refs[index] = RefState::Verified;
                    write_receipt(control, &receipt)?;
                }
                RefState::Intent => {
                    ensure!(
                        read_ref(&retained.common, &retained.new).await?.as_deref()
                            == Some(&retained.commit),
                        "managed_worktree_relocation_ref_unsettled_do_not_replay"
                    );
                    receipt.refs[index] = RefState::Verified;
                    write_receipt(control, &receipt)?;
                }
                RefState::Verified => {
                    ensure!(
                        read_ref(&retained.common, &retained.new).await?.as_deref()
                            == Some(&retained.commit),
                        "managed_worktree_relocation_ref_changed"
                    );
                }
            }
        }
        if receipt.replacements.len() > git_count {
            let last = receipt.replacements.len() - 1;
            replace_owned(control, &mut receipt, last, &transformed)
                .context("managed_worktree_relocation_unsettled_do_not_reopen_source")?;
        }
        verify_all(final_target, &receipt, &transformed).await
    }

    /// Read-only reconciliation of the original operation at the final path.
    pub async fn verify_relocation<'p>(
        &self,
        final_target: &ClientWorktreeStore,
        operation_id: &str,
        control: &PrivateDirectory,
        expected: &ManagedWorktreeRelocationSnapshot,
        published: &'p StoragePublishedComponent,
    ) -> Result<VerifiedManagedWorktreeRelocation<'p>> {
        verify_publication(expected, operation_id, published)?;
        let summary = self
            .verify_relocation_core(final_target, operation_id, control, expected)
            .await?;
        self.workspace_facts(summary, operation_id, control, expected, published)
    }

    async fn verify_relocation_core(
        &self,
        final_target: &ClientWorktreeStore,
        operation_id: &str,
        control: &PrivateDirectory,
        expected: &ManagedWorktreeRelocationSnapshot,
    ) -> Result<ManagedWorktreeRelocationResult> {
        validate_operation(operation_id)?;
        let bytes = read_optional(control, &receipt_name(&expected.source_registry))?
            .context("managed_worktree_relocation_receipt_missing")?;
        let receipt: Receipt = serde_json::from_slice(&bytes)?;
        check_receipt(&receipt, operation_id, control, expected)?;
        let transformed = self.target_bytes(final_target, expected)?;
        verify_all(final_target, &receipt, &transformed).await
    }

    fn workspace_facts<'p>(
        &self,
        summary: ManagedWorktreeRelocationResult,
        operation_id: &str,
        control: &PrivateDirectory,
        expected: &ManagedWorktreeRelocationSnapshot,
        published: &'p StoragePublishedComponent,
    ) -> Result<VerifiedManagedWorktreeRelocation<'p>> {
        verify_publication(expected, operation_id, published)?;
        let bytes = read_optional(control, &receipt_name(&expected.source_registry))?
            .context("managed_worktree_relocation_receipt_missing")?;
        let receipt: Receipt = serde_json::from_slice(&bytes)?;
        check_receipt(&receipt, operation_id, control, expected)?;
        let mut workspaces = Vec::new();
        for (index, entry) in expected
            .entries
            .iter()
            .filter(|entry| entry.git.is_some())
            .enumerate()
        {
            let git = entry.git.as_ref().unwrap();
            let relative = entry.path.strip_prefix(&expected.source_data_root)?;
            ensure!(
                entry.target.strip_prefix(&expected.target_data_root)? == relative,
                "managed_worktree_relocation_workspace_relative_path_changed"
            );
            let target = receipt
                .target_dotgit
                .get(&entry.target)
                .context("managed_worktree_relocation_workspace_target_missing")?;
            let fact = OwnedManagedWorkspaceRelocation {
                published,
                operation_id: operation_id.into(),
                worktree_id: entry.worktree_id.clone(),
                revision: entry.revision,
                source_registry: expected.source_registry.clone(),
                registry: expected.registry.clone(),
                relative: relative.into(),
                source_path: entry.path.clone(),
                target_path: entry.target.clone(),
                source: directory(&entry.path)?,
                target: directory(&entry.target)?,
                source_identity: git.workspace_identity.clone(),
                target_identity: target.directory_identity.clone(),
                git: git.clone(),
                registration: receipt.replacements[index]
                    .candidate
                    .clone()
                    .context("managed_worktree_relocation_workspace_registration_unconfirmed")?,
                target_dotgit: target.dotgit.clone(),
            };
            fact.verify()?;
            workspaces.push(fact);
        }
        Ok(VerifiedManagedWorktreeRelocation {
            summary,
            workspaces,
        })
    }

    fn target_bytes(
        &self,
        target: &ClientWorktreeStore,
        expected: &ManagedWorktreeRelocationSnapshot,
    ) -> Result<Vec<u8>> {
        validate_roots(&expected.source_data_root, &expected.target_data_root)?;
        directory(&expected.target_data_root)?;
        ensure!(
            self.state_path == expected.source_registry
                && target.state_path == expected.target_registry,
            "managed_worktree_relocation_store_mismatch"
        );
        let (bytes, stamp) = read_path(&self.state_path)?;
        ensure!(
            stamp == expected.registry,
            "managed_worktree_relocation_source_registry_changed"
        );
        if expected.source_root == expected.target_root {
            return Ok(bytes);
        }
        let mut value: Value = serde_json::from_slice(&bytes)?;
        if expected.source_root != expected.target_root {
            let version = value["version"].as_u64().unwrap_or(0);
            if version >= 4 {
                ensure!(
                    value["settings"]["resolvedWorktreeRoot"].as_str()
                        == expected.source_root.to_str(),
                    "managed_worktree_relocation_source_root_changed"
                );
            }
            value["settings"]["resolvedWorktreeRoot"] = json!(expected.target_root);
            if value["settings"]["worktreeRoot"]
                .as_str()
                .is_some_and(|root| !root.is_empty())
            {
                value["settings"]["worktreeRoot"] = json!(expected.target_root);
            }
            let source_root = &expected.source_root;
            let target_root = &expected.target_root;
            let records = value["records"]
                .as_object_mut()
                .context("managed_worktree_relocation_records_missing")?;
            for entry in &expected.entries {
                let key =
                    super::registry::registry_storage_path(version, source_root, &entry.path)?;
                let mut record = records
                    .remove(&key)
                    .context("managed_worktree_relocation_record_missing")?;
                let target_key =
                    super::registry::registry_storage_path(4, target_root, &entry.target)?;
                record["path"] = json!(target_key);
                record["leaseKey"] = json!(hex_sha256(utf8(&entry.target)?.as_bytes()));
                if let Some(retained) = &entry.snapshot {
                    record["snapshotRef"] = json!(retained.new);
                }
                if let Some(conversations) = record["archivedConversations"].as_array_mut() {
                    for conversation in conversations {
                        conversation["workspacePath"] = json!(target_key);
                    }
                }
                ensure!(
                    records.insert(target_key, record).is_none(),
                    "managed_worktree_relocation_record_collision"
                );
            }
            value["version"] = json!(4);
        }
        // Preserve unknown fields, business IDs, revisions and user text.
        let mut state: ClientWorktreeState = serde_json::from_value(value.clone())?;
        super::registry::hydrate_relative_registry_paths(&mut state)?;
        target.validate_state(&mut state)?;
        Ok(serde_json::to_vec_pretty(&value)?)
    }
}

fn mapped(path: &Path, source: &Path, target: &Path) -> PathBuf {
    path.strip_prefix(source)
        .map(|relative| target.join(relative))
        .unwrap_or_else(|_| path.to_owned())
}

fn verify_publication(
    expected: &ManagedWorktreeRelocationSnapshot,
    operation_id: &str,
    published: &StoragePublishedComponent,
) -> Result<()> {
    validate_operation(operation_id)?;
    published.verify()?;
    ensure!(
        published.operation_id() == operation_id
            && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && published.source_path() == expected.source_data_root
            && published.destination_path() == expected.target_data_root
            && expected
                .source_registry
                .starts_with(&expected.source_data_root)
            && expected.target_registry
                == mapped(
                    &expected.source_registry,
                    &expected.source_data_root,
                    &expected.target_data_root
                )
            && published.source_identity() == expected.source_data_root_identity
            && directory(&expected.source_data_root)?.directory_identity()?
                == expected.source_data_root_identity
            && directory(&expected.target_data_root)?.directory_identity()?
                == published.directory().directory_identity()?,
        "managed_worktree_relocation_published_component_mismatch"
    );
    Ok(())
}

fn validate_owned_root(root: &Path, state: &ClientWorktreeState) -> Result<()> {
    if absent(root)? {
        return Ok(());
    }
    let root = directory(root)?;
    let names = root.entry_names_bounded(MAX_ENTRIES + 1)?;
    ensure!(
        names.len() <= MAX_ENTRIES,
        "managed_worktree_relocation_inventory_too_large"
    );
    for name in names {
        let owned: Vec<_> = state
            .records
            .values()
            .filter(|record| OsStr::new(&record.worktree_id) == name)
            .collect();
        ensure!(
            !owned.is_empty(),
            "managed_worktree_relocation_unregistered_managed_entry"
        );
        let task = root.open_child(&name, false)?;
        let names = task.entry_names_bounded(MAX_ENTRIES + 1)?;
        ensure!(
            names.len() <= MAX_ENTRIES,
            "managed_worktree_relocation_inventory_too_large"
        );
        for name in names {
            ensure!(
                owned
                    .iter()
                    .any(|record| OsStr::new(&record.repository_name) == name),
                "managed_worktree_relocation_unregistered_managed_entry"
            );
        }
    }
    Ok(())
}

fn utf8(path: &Path) -> Result<&str> {
    path.to_str()
        .context("managed_worktree_relocation_non_utf8_path")
}

fn validate_operation(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
        "managed_worktree_relocation_invalid_operation"
    );
    Ok(())
}

fn validate_roots(source: &Path, target: &Path) -> Result<()> {
    ensure!(
        safe_absolute_path(source)
            && safe_absolute_path(target)
            && source != target
            && !source.starts_with(target)
            && !target.starts_with(source),
        "managed_worktree_relocation_overlapping_roots"
    );
    directory(source)?;
    Ok(())
}

fn directory(path: &Path) -> Result<PrivateDirectory> {
    ensure!(
        safe_absolute_path(path) && dunce::canonicalize(path)? == path,
        "managed_worktree_relocation_path_alias: {}",
        path.display()
    );
    PrivateDirectory::open_existing(path)
}

fn absent(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.into()),
    }
}

fn file_bytes(mut file: &File) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "managed_worktree_relocation_file_too_large"
    );
    Ok(bytes)
}

fn read_leaf(parent: &PrivateDirectory, name: &OsStr) -> Result<(Vec<u8>, FileStamp)> {
    let file = parent.open_single_link_regular_file(name)?;
    let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
    let bytes = file_bytes(&file)?;
    let sha256 = hex_sha256(&bytes);
    Ok((bytes, FileStamp { identity, sha256 }))
}

fn read_path(path: &Path) -> Result<(Vec<u8>, FileStamp)> {
    let parent = directory(
        path.parent()
            .context("managed_worktree_relocation_parent_missing")?,
    )?;
    read_leaf(
        &parent,
        path.file_name()
            .context("managed_worktree_relocation_name_missing")?,
    )
}

fn read_optional(parent: &PrivateDirectory, name: &str) -> Result<Option<Vec<u8>>> {
    match parent.entry_metadata(OsStr::new(name)) {
        Ok(_) => read_leaf(parent, OsStr::new(name)).map(|(bytes, _)| Some(bytes)),
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

async fn git(common: &Path, worktree: Option<&Path>, args: &[&str]) -> Result<String> {
    let result = run_git_command_with_private_repository(
        worktree.unwrap_or(common),
        args,
        common,
        worktree,
        None,
        None,
        5 * 1024 * 1024,
        Duration::from_secs(30),
    )
    .await?;
    ensure!(
        result.success,
        "managed_worktree_relocation_git_failed: {}",
        result.stderr
    );
    Ok(result
        .stdout
        .as_str()
        .context("managed_worktree_relocation_git_output_invalid")?
        .to_owned())
}

async fn read_ref(common: &Path, reference: &str) -> Result<Option<String>> {
    let symbolic = run_git_command_with_private_repository(
        common,
        &["symbolic-ref", "--quiet", reference],
        common,
        None,
        None,
        None,
        4096,
        Duration::from_secs(15),
    )
    .await?;
    ensure!(
        !symbolic.success && symbolic.exit_code == 1,
        "managed_worktree_relocation_symbolic_ref_unsupported"
    );
    let result = run_git_command_with_private_repository(
        common,
        &["rev-parse", "--verify", "--quiet", reference],
        common,
        None,
        None,
        None,
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if result.success {
        let value = result.stdout.as_str().unwrap_or_default().trim();
        ensure!(
            valid_git_object_id(value),
            "managed_worktree_relocation_invalid_ref"
        );
        Ok(Some(value.to_owned()))
    } else {
        ensure!(
            result.exit_code == 1,
            "managed_worktree_relocation_ref_unreadable"
        );
        Ok(None)
    }
}

async fn verify_old_ref(retained: &SnapshotRef) -> Result<()> {
    ensure!(
        directory(&retained.common)?.directory_identity()? == retained.common_identity
            && read_ref(&retained.common, &retained.old).await?.as_deref()
                == Some(&retained.commit),
        "managed_worktree_relocation_old_ref_changed"
    );
    ensure!(
        git(
            &retained.common,
            None,
            &["cat-file", "-t", &retained.commit]
        )
        .await?
        .trim()
            == "commit",
        "managed_worktree_relocation_snapshot_not_commit"
    );
    Ok(())
}

fn gitdir_replacement(target: &Path) -> Result<Vec<u8>> {
    Ok(format!("{}\n", utf8(&target.join(".git"))?).into_bytes())
}

fn single_line(bytes: &[u8]) -> Result<&str> {
    let value = std::str::from_utf8(bytes)?
        .strip_suffix('\n')
        .context("managed_worktree_relocation_unknown_git_file_format")?;
    ensure!(
        !value.is_empty() && !value.contains(['\n', '\r', '\0']),
        "managed_worktree_relocation_unknown_git_file_format"
    );
    Ok(value)
}

async fn capture_git(path: &Path, source: &Path, hash_content: bool) -> Result<GitBinding> {
    let workspace = directory(path)?;
    let (dotgit, dotgit_stamp) = read_path(&path.join(".git"))?;
    let admin = PathBuf::from(
        single_line(&dotgit)?
            .strip_prefix("gitdir: ")
            .context("managed_worktree_relocation_not_linked_worktree")?,
    );
    let admin_dir = directory(&admin)?;
    let worktrees = admin
        .parent()
        .context("managed_worktree_relocation_admin_invalid")?;
    ensure!(
        worktrees.file_name() == Some(OsStr::new("worktrees")),
        "managed_worktree_relocation_unknown_admin_layout"
    );
    let common = worktrees
        .parent()
        .context("managed_worktree_relocation_common_missing")?
        .to_owned();
    let common_dir = directory(&common)?;
    let (commondir_bytes, commondir) = read_leaf(&admin_dir, OsStr::new("commondir"))?;
    ensure!(
        dunce::canonicalize(admin.join(single_line(&commondir_bytes)?))? == common,
        "managed_worktree_relocation_commondir_mismatch"
    );
    let (gitdir_bytes, gitdir_stamp) = read_leaf(&admin_dir, OsStr::new("gitdir"))?;
    ensure!(
        Path::new(single_line(&gitdir_bytes)?) == path.join(".git"),
        "managed_worktree_relocation_original_registration_mismatch"
    );
    directory(source)?;
    let source_common = crate::git::run_git_command(
        source,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
        Duration::from_secs(15),
    )
    .await?;
    ensure!(
        source_common.success
            && Path::new(source_common.stdout.as_str().unwrap_or_default().trim()) == common,
        "managed_worktree_relocation_source_common_mismatch"
    );
    ensure!(
        absent(&admin.join("config.worktree"))?,
        "managed_worktree_relocation_custom_worktree_config_unsupported"
    );
    for pending in [
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
    ] {
        ensure!(
            absent(&admin.join(pending))?,
            "managed_worktree_relocation_git_operation_in_progress"
        );
    }
    let index = git(&admin, Some(path), &["ls-files", "--stage", "-z"]).await?;
    ensure!(
        !index.split('\0').any(|entry| entry.starts_with("160000 ")),
        "managed_worktree_relocation_submodules_unsupported"
    );
    let head = git(&admin, Some(path), &["rev-parse", "--verify", "HEAD"])
        .await?
        .trim()
        .to_owned();
    let status = git(
        &admin,
        Some(path),
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    ensure!(
        valid_git_object_id(&head),
        "managed_worktree_relocation_head_invalid"
    );
    let listing = git(&common, None, &["worktree", "list", "--porcelain", "-z"]).await?;
    ensure!(
        listing.split('\0').any(|line| line
            .strip_prefix("worktree ")
            .is_some_and(|value| Path::new(value) == path)),
        "managed_worktree_relocation_registration_missing"
    );
    let content_sha256 = tree_hash(&directory(path)?, true, hash_content, &[])?;
    let admin_sha256 = tree_hash(&admin_dir, false, hash_content, &[])?;
    Ok(GitBinding {
        workspace_identity: workspace.directory_identity()?,
        common,
        common_identity: common_dir.directory_identity()?,
        admin,
        admin_identity: admin_dir.directory_identity()?,
        dotgit: dotgit_stamp,
        dotgit_bytes: std::str::from_utf8(&dotgit)?.to_owned(),
        gitdir: gitdir_stamp,
        gitdir_bytes: std::str::from_utf8(&gitdir_bytes)?.to_owned(),
        commondir,
        head,
        status,
        admin_sha256,
        content_sha256,
    })
}

/// Bounded, handle-relative inventory. Links, nested repositories and special
/// entries have explicit unsupported branches; no external contents are read.
fn tree_hash(
    directory: &PrivateDirectory,
    working: bool,
    hash: bool,
    excluded: &[String],
) -> Result<String> {
    fn visit(
        directory: &PrivateDirectory,
        relative: &Path,
        working: bool,
        hash: bool,
        excluded: &[String],
        count: &mut usize,
        digest: &mut sha2::Sha256,
    ) -> Result<()> {
        let mut names = directory.entry_names_bounded(MAX_ENTRIES + 1)?;
        names.sort();
        for name in names {
            if (working && relative.as_os_str().is_empty() && name == OsStr::new(".git"))
                || (!working
                    && relative.as_os_str().is_empty()
                    && (name == OsStr::new("gitdir")
                        || excluded.iter().any(|excluded| name == OsStr::new(excluded))))
            {
                continue;
            }
            *count += 1;
            ensure!(
                *count <= MAX_ENTRIES,
                "managed_worktree_relocation_inventory_too_large"
            );
            ensure!(
                !(working && name == OsStr::new(".git")),
                "managed_worktree_relocation_nested_repository_unsupported"
            );
            ensure!(
                working || !name.to_string_lossy().ends_with(".lock"),
                "managed_worktree_relocation_git_operation_in_progress"
            );
            let child = relative.join(&name);
            let entry = directory.open_entry_handle(&name)?;
            let metadata = entry.metadata();
            ensure!(
                !metadata.file_type().is_symlink(),
                "managed_worktree_relocation_link_unsupported"
            );
            digest.update(utf8(&child)?.as_bytes());
            digest.update([0]);
            if metadata.is_dir() {
                digest.update(b"directory\0");
                visit(
                    &entry.open_child_directory()?,
                    &child,
                    working,
                    hash,
                    excluded,
                    count,
                    digest,
                )?;
            } else {
                ensure!(
                    metadata.is_file(),
                    "managed_worktree_relocation_special_entry_unsupported"
                );
                digest.update(b"file\0");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    digest.update((metadata.permissions().mode() & 0o111).to_le_bytes());
                }
                if hash {
                    let mut file = directory.open_single_link_regular_file(&name)?;
                    let mut content = sha2::Sha256::new();
                    let mut buffer = [0; 64 * 1024];
                    loop {
                        let bytes = file.read(&mut buffer)?;
                        if bytes == 0 {
                            break;
                        }
                        content.update(&buffer[..bytes]);
                    }
                    digest.update(content.finalize());
                }
            }
        }
        Ok(())
    }
    let mut digest = sha2::Sha256::new();
    visit(
        directory,
        Path::new(""),
        working,
        hash,
        excluded,
        &mut 0,
        &mut digest,
    )?;
    Ok(format!("{:x}", digest.finalize()))
}

fn write_receipt(control: &PrivateDirectory, receipt: &Receipt) -> Result<()> {
    control.atomic_replace(
        OsStr::new(&receipt_name(&receipt.source.source_registry)),
        &serde_json::to_vec(receipt)?,
    )
}

fn receipt_name(source_registry: &Path) -> String {
    format!(
        "managed-worktrees-{}.json",
        hex_sha256(source_registry.to_string_lossy().as_bytes())
    )
}

fn check_receipt(
    receipt: &Receipt,
    operation_id: &str,
    control: &PrivateDirectory,
    expected: &ManagedWorktreeRelocationSnapshot,
) -> Result<()> {
    ensure!(
        receipt.version == 1
            && receipt.operation_id == operation_id
            && receipt.control_identity == control.directory_identity()?
            && receipt.source == *expected,
        "managed_worktree_relocation_operation_mismatch"
    );
    ensure!(
        directory(&expected.target_data_root)?.directory_identity()? == receipt.target_identity,
        "managed_worktree_relocation_target_identity_changed"
    );
    let entries: Vec<_> = expected
        .entries
        .iter()
        .filter(|entry| entry.git.is_some())
        .collect();
    let has_registry_change = expected.source_root != expected.target_root;
    ensure!(
        receipt.replacements.len() == entries.len() + usize::from(has_registry_change)
            && receipt.refs.len()
                == expected
                    .entries
                    .iter()
                    .filter(|entry| entry.snapshot.is_some())
                    .count()
            && receipt.target_dotgit.len() == entries.len(),
        "managed_worktree_relocation_receipt_invalid"
    );
    for (index, entry) in entries.iter().enumerate() {
        let binding = entry.git.as_ref().unwrap();
        let item = &receipt.replacements[index];
        ensure!(
            item.parent == binding.admin
                && item.parent_identity == binding.admin_identity
                && item.name == "gitdir"
                && item.original == binding.gitdir
                && item.replacement_sha256 == hex_sha256(&gitdir_replacement(&entry.target)?)
                && receipt
                    .target_dotgit
                    .get(&entry.target)
                    .is_some_and(|target| target.dotgit.sha256 == binding.dotgit.sha256
                        && target.dotgit.identity != binding.dotgit.identity
                        && target.directory_identity != binding.workspace_identity),
            "managed_worktree_relocation_receipt_binding_invalid"
        );
    }
    if has_registry_change {
        let item = receipt.replacements.last().unwrap();
        ensure!(
            item.parent.join(&item.name) == expected.target_registry
                && item.original == receipt.target_registry,
            "managed_worktree_relocation_receipt_registry_invalid"
        );
    }
    Ok(())
}

fn replacement(
    parent: &Path,
    name: &str,
    original: FileStamp,
    bytes: &[u8],
) -> Result<Replacement> {
    Ok(Replacement {
        parent: parent.into(),
        parent_identity: directory(parent)?.directory_identity()?,
        name: name.into(),
        original,
        replacement_sha256: hex_sha256(bytes),
        candidate: None,
    })
}

async fn prepare_receipt(
    target: &ClientWorktreeStore,
    operation_id: &str,
    control: &PrivateDirectory,
    expected: &ManagedWorktreeRelocationSnapshot,
    transformed: &[u8],
) -> Result<Receipt> {
    let (target_bytes, target_stamp) = read_path(&target.state_path)?;
    ensure!(
        hex_sha256(&target_bytes) == expected.registry.sha256
            && target_stamp.identity != expected.registry.identity,
        "managed_worktree_relocation_target_not_original_copy"
    );
    let mut receipt = Receipt {
        version: 1,
        operation_id: operation_id.into(),
        control_identity: control.directory_identity()?,
        target_identity: directory(&expected.target_data_root)?.directory_identity()?,
        source: expected.clone(),
        target_dotgit: BTreeMap::new(),
        replacements: Vec::new(),
        refs: Vec::new(),
        target_registry: target_stamp.clone(),
    };
    for entry in &expected.entries {
        if let Some(binding) = &entry.git {
            let (_, stamp) = read_path(&entry.target.join(".git"))?;
            ensure!(
                stamp.sha256 == binding.dotgit.sha256 && stamp.identity != binding.dotgit.identity,
                "managed_worktree_relocation_target_dotgit_changed"
            );
            ensure!(
                tree_hash(&directory(&entry.target)?, true, true, &[])? == binding.content_sha256,
                "managed_worktree_relocation_target_content_changed"
            );
            receipt.target_dotgit.insert(
                entry.target.clone(),
                TargetWorkspace {
                    directory_identity: directory(&entry.target)?.directory_identity()?,
                    dotgit: stamp,
                },
            );
            receipt.replacements.push(replacement(
                &binding.admin,
                "gitdir",
                binding.gitdir.clone(),
                &gitdir_replacement(&entry.target)?,
            )?);
        } else {
            ensure!(
                absent(&entry.target)?,
                "managed_worktree_relocation_target_directory_collision"
            );
        }
        if let Some(retained) = &entry.snapshot {
            verify_old_ref(retained).await?;
            ensure!(
                read_ref(&retained.common, &retained.new).await?.is_none(),
                "managed_worktree_relocation_target_ref_exists"
            );
            receipt.refs.push(RefState::NotStarted);
        }
    }
    if expected.source_root != expected.target_root {
        receipt.replacements.push(replacement(
            target
                .state_path
                .parent()
                .context("managed_worktree_relocation_registry_parent_missing")?,
            utf8(Path::new(target.state_path.file_name().context(
                "managed_worktree_relocation_registry_name_missing",
            )?))?,
            target_stamp,
            transformed,
        )?);
    }
    for (index, item) in receipt.replacements.iter().enumerate() {
        let parent = directory(&item.parent)?;
        ensure!(
            read_optional(&parent, &candidate_name(operation_id, index))?.is_none()
                && read_optional(&parent, &previous_name(operation_id, index))?.is_none(),
            "managed_worktree_relocation_existing_publication"
        );
    }
    Ok(receipt)
}

fn candidate_name(operation: &str, index: usize) -> String {
    format!("kcoder-relocation-{operation}-{index}.candidate")
}
fn previous_name(operation: &str, index: usize) -> String {
    format!("kcoder-relocation-{operation}-{index}.previous")
}

fn replace_owned(
    control: &PrivateDirectory,
    receipt: &mut Receipt,
    index: usize,
    bytes: &[u8],
) -> Result<()> {
    let item = receipt.replacements[index].clone();
    let parent = directory(&item.parent)?;
    ensure!(
        parent.directory_identity()? == item.parent_identity
            && hex_sha256(bytes) == item.replacement_sha256,
        "managed_worktree_relocation_publication_changed"
    );
    let candidate = candidate_name(&receipt.operation_id, index);
    let previous = previous_name(&receipt.operation_id, index);
    if item.candidate.is_some() {
        return verify_replacement(receipt, index);
    }
    let original = read_leaf(&parent, OsStr::new(&item.name))?;
    ensure!(
        original.1 == item.original
            && read_optional(&parent, &candidate)?.is_none()
            && read_optional(&parent, &previous)?.is_none(),
        "managed_worktree_relocation_original_changed"
    );
    parent.atomic_publish_observed_from_reader(
        OsStr::new(&candidate),
        &mut &bytes[..],
        false,
        || {
            ensure!(
                read_leaf(&parent, OsStr::new(&item.name))?.1 == item.original,
                "managed_worktree_relocation_original_changed"
            );
            Ok(())
        },
        |file| {
            receipt.replacements[index].candidate = Some(FileStamp {
                identity: PortableLeaseIdentity::from_regular_handle(file)?,
                sha256: item.replacement_sha256.clone(),
            });
            write_receipt(control, receipt)
        },
    )?;
    // No-replace on both moves retains the exact displaced object. Unexpected
    // replacements remain preserved for reconciliation, never overwritten.
    parent.rename_no_replace(OsStr::new(&item.name), OsStr::new(&previous))?;
    ensure!(
        read_leaf(&parent, OsStr::new(&previous))?.1 == item.original,
        "managed_worktree_relocation_displaced_file_unknown_do_not_reopen_source"
    );
    parent.rename_no_replace(OsStr::new(&candidate), OsStr::new(&item.name))?;
    verify_replacement(receipt, index)
}

fn verify_replacement(receipt: &Receipt, index: usize) -> Result<()> {
    let item = &receipt.replacements[index];
    let parent = directory(&item.parent)?;
    ensure!(
        parent.directory_identity()? == item.parent_identity,
        "managed_worktree_relocation_publication_parent_changed"
    );
    let observed = read_leaf(&parent, OsStr::new(&item.name))
        .ok()
        .map(|(_, stamp)| stamp);
    let previous = read_leaf(
        &parent,
        OsStr::new(&previous_name(&receipt.operation_id, index)),
    )
    .ok()
    .map(|(_, stamp)| stamp);
    ensure!(
        item.candidate.is_some()
            && observed == item.candidate
            && previous.as_ref() == Some(&item.original)
            && read_optional(&parent, &candidate_name(&receipt.operation_id, index))?.is_none(),
        "managed_worktree_relocation_publication_unsettled_do_not_replay_or_reopen_source"
    );
    Ok(())
}

fn verify_source(expected: &ManagedWorktreeRelocationSnapshot, receipt: &Receipt) -> Result<()> {
    ensure!(
        directory(&expected.source_data_root)?.directory_identity()?
            == expected.source_data_root_identity,
        "managed_worktree_relocation_source_root_identity_changed"
    );
    ensure!(
        read_path(&expected.source_registry)?.1 == expected.registry,
        "managed_worktree_relocation_source_registry_changed"
    );
    let mut index = 0;
    for entry in &expected.entries {
        if let Some(binding) = &entry.git {
            ensure!(
                directory(&entry.path)?.directory_identity()? == binding.workspace_identity,
                "managed_worktree_relocation_source_workspace_identity_changed"
            );
            ensure!(
                directory(&binding.common)?.directory_identity()? == binding.common_identity
                    && directory(&binding.admin)?.directory_identity()? == binding.admin_identity,
                "managed_worktree_relocation_git_directory_changed"
            );
            ensure!(
                read_path(&entry.path.join(".git"))?.1 == binding.dotgit
                    && read_path(&binding.admin.join("commondir"))?.1 == binding.commondir,
                "managed_worktree_relocation_git_binding_changed"
            );
            if receipt.replacements[index].candidate.is_none() {
                ensure!(
                    read_path(&binding.admin.join("gitdir"))?.1 == binding.gitdir,
                    "managed_worktree_relocation_original_registration_changed"
                );
            } else {
                verify_replacement(receipt, index)?;
            }
            let excluded = [
                candidate_name(&receipt.operation_id, index),
                previous_name(&receipt.operation_id, index),
            ];
            ensure!(
                tree_hash(&directory(&entry.path)?, true, true, &[])? == binding.content_sha256
                    && tree_hash(&directory(&binding.admin)?, false, true, &excluded)?
                        == binding.admin_sha256,
                "managed_worktree_relocation_git_content_changed"
            );
            index += 1;
        }
    }
    Ok(())
}

fn verify_target_dotgit(receipt: &Receipt) -> Result<()> {
    for (path, target) in &receipt.target_dotgit {
        ensure!(
            directory(path)?.directory_identity()? == target.directory_identity
                && read_path(&path.join(".git"))?.1 == target.dotgit,
            "managed_worktree_relocation_target_dotgit_identity_changed"
        );
    }
    Ok(())
}

async fn verify_all(
    target: &ClientWorktreeStore,
    receipt: &Receipt,
    transformed: &[u8],
) -> Result<ManagedWorktreeRelocationResult> {
    verify_source(&receipt.source, receipt)?;
    verify_target_dotgit(receipt)?;
    for index in 0..receipt.replacements.len() {
        verify_replacement(receipt, index)?;
    }
    if receipt.source.source_root == receipt.source.target_root {
        ensure!(
            read_path(&target.state_path)?.1 == receipt.target_registry,
            "managed_worktree_relocation_external_registry_changed"
        );
    }
    ensure!(
        read_path(&target.state_path)?.0 == transformed,
        "managed_worktree_relocation_target_registry_changed"
    );
    target.load()?;
    let mut redirected_worktrees = Vec::new();
    for entry in &receipt.source.entries {
        if let Some(binding) = &entry.git {
            ensure!(
                read_path(&binding.admin.join("gitdir"))?.0 == gitdir_replacement(&entry.target)?
                    && tree_hash(&directory(&entry.target)?, true, true, &[])?
                        == binding.content_sha256,
                "managed_worktree_relocation_target_content_changed"
            );
            ensure!(
                git(&binding.admin, Some(&entry.target), &["rev-parse", "HEAD"])
                    .await?
                    .trim()
                    == binding.head,
                "managed_worktree_relocation_head_changed"
            );
            ensure!(
                git(
                    &binding.admin,
                    Some(&entry.target),
                    &["status", "--porcelain=v1", "-z", "--untracked-files=all"]
                )
                .await?
                    == binding.status,
                "managed_worktree_relocation_status_changed"
            );
            let listing = git(
                &binding.common,
                None,
                &["worktree", "list", "--porcelain", "-z"],
            )
            .await?;
            ensure!(
                listing.split('\0').any(|line| line
                    .strip_prefix("worktree ")
                    .is_some_and(|value| Path::new(value) == entry.target))
                    && !listing.split('\0').any(|line| line
                        .strip_prefix("worktree ")
                        .is_some_and(|value| Path::new(value) == entry.path)),
                "managed_worktree_relocation_target_registration_mismatch"
            );
            redirected_worktrees.push(entry.path.clone());
        }
        if let Some(retained) = &entry.snapshot {
            verify_old_ref(retained).await?;
            ensure!(
                read_ref(&retained.common, &retained.new).await?.as_deref()
                    == Some(&retained.commit),
                "managed_worktree_relocation_target_ref_changed"
            );
        }
    }
    ensure!(
        receipt
            .refs
            .iter()
            .all(|state| !matches!(state, RefState::NotStarted)),
        "managed_worktree_relocation_ref_without_intent"
    );
    Ok(ManagedWorktreeRelocationResult {
        source_registration_preserved: redirected_worktrees.is_empty(),
        redirected_worktrees,
    })
}

#[cfg(test)]
mod tests;
