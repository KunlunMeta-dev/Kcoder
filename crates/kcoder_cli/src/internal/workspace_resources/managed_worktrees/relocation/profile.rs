//! One bounded registry collector for first capture and original-operation
//! reconciliation. Recovery reads the existing Git receipt, never a second snapshot.
use super::*;
use std::{collections::BTreeSet, ffi::OsString, time::SystemTime};

pub(super) struct RegisteredProfile {
    pub source_identity: String,
    pub registries: Vec<(PathBuf, FileStamp)>,
    source: PathBuf,
    projects: Option<(PrivateDirectory, String, SystemTime)>,
    directories: Vec<(OsString, String, SystemTime)>,
}

impl RegisteredProfile {
    pub(super) fn verify(&self) -> Result<()> {
        ensure!(
            directory(&self.source)?.directory_identity()? == self.source_identity,
            "managed_worktree_profile_source_changed"
        );
        let path = self.source.join("projects");
        let Some((projects, identity, modified)) = &self.projects else {
            ensure!(
                self.directories.is_empty() && absent(&path)?,
                "managed_worktree_profile_projects_changed"
            );
            return Ok(());
        };
        ensure!(
            projects.directory_identity()? == *identity
                && directory(&path)?.directory_identity()? == *identity
                && projects.directory_metadata()?.modified()? == *modified,
            "managed_worktree_profile_projects_changed"
        );
        for (name, identity, modified) in &self.directories {
            let project = projects.open_child(name, false)?;
            ensure!(
                project.directory_identity()? == *identity
                    && project.directory_metadata()?.modified()? == *modified,
                "managed_worktree_profile_project_changed"
            );
        }
        for (path, stamp) in &self.registries {
            ensure!(
                read_path(path)?.1 == *stamp,
                "managed_worktree_profile_source_registry_changed"
            );
        }
        Ok(())
    }
}

/// First capture and read-only resume use the same bounded registry namespace.
/// Unrelated project metadata may change between them without changing this
/// owner set; changes during either observation fail its consistency check.
pub(super) fn registered_profile(source: &Path) -> Result<RegisteredProfile> {
    let root = directory(source)?;
    let mut observed = RegisteredProfile {
        source_identity: root.directory_identity()?,
        registries: Vec::new(),
        source: source.into(),
        projects: None,
        directories: Vec::new(),
    };
    let projects_path = source.join("projects");
    if absent(&projects_path)? {
        return Ok(observed);
    }
    let projects = root
        .open_child(OsStr::new("projects"), false)
        .context("managed_worktree_profile_projects_invalid")?;
    let identity = projects.directory_identity()?;
    let modified = projects.directory_metadata()?.modified()?;
    let mut names = projects.entry_names_bounded(MAX_PROFILE_PROJECTS + 1)?;
    ensure!(
        names.len() <= MAX_PROFILE_PROJECTS,
        "managed_worktree_profile_project_limit"
    );
    names.sort();
    for name in names {
        let entry = projects.open_entry_handle(&name)?;
        if entry.metadata().is_file() {
            continue;
        }
        ensure!(
            entry.metadata().is_dir(),
            "managed_worktree_profile_project_invalid"
        );
        let project = entry.open_child_directory()?;
        observed.directories.push((
            name.clone(),
            project.directory_identity()?,
            project.directory_metadata()?.modified()?,
        ));
        let registry_path = projects_path.join(&name).join("managed-worktrees.json");
        if absent(&registry_path)? {
            continue;
        }
        let registry = project.open_entry_handle(OsStr::new("managed-worktrees.json"))?;
        ensure!(
            registry.metadata().is_file(),
            "managed_worktree_profile_registry_invalid"
        );
        let stamp = read_leaf(&project, OsStr::new("managed-worktrees.json"))?.1;
        observed.registries.push((registry_path, stamp));
    }
    observed.projects = Some((projects, identity, modified));
    observed.verify()?;
    Ok(observed)
}

/// Return only candidates proven to belong to physically moving registered roots.
/// This reads registry bytes and explicit ancestor metadata, never tree contents
/// or Git. The result is refusal evidence, not a relocation or access proof.
pub fn profile_relocation_reference_paths(
    source: &Path,
    target: &Path,
    candidates: &BTreeSet<PathBuf>,
) -> Result<BTreeSet<PathBuf>> {
    if source == target {
        return Ok(BTreeSet::new());
    }
    validate_roots(source, target)?;
    let source_identity =
        serde_json::to_string(&directory(source)?.portable_directory_handle_identity()?)?;
    let candidates = candidates
        .iter()
        .filter_map(|path| {
            #[cfg(not(windows))]
            if !path.starts_with(source) {
                return None;
            }
            let ancestors = reference_ancestors(path);
            ancestors
                .contains(&source_identity)
                .then_some((path, ancestors))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(BTreeSet::new());
    }
    let registered = registered_profile(source)?;
    let mut owned = BTreeSet::new();
    for (registry, stamp) in &registered.registries {
        let store = ClientWorktreeStore::from_client_storage_root(
            registry.parent().unwrap().join("client-sessions"),
            true,
        );
        let state = store.load()?;
        ensure!(
            read_path(registry)?.1 == *stamp,
            "managed_worktree_profile_source_changed"
        );
        let root = Path::new(&state.settings.resolved_worktree_root);
        #[cfg(not(windows))]
        if !root.starts_with(source) {
            continue;
        }
        if !reference_ancestors(root).contains(&source_identity) {
            continue;
        }
        for record in state.records.values() {
            let path = Path::new(&record.path);
            ensure!(
                path == root.join(&record.worktree_id).join(&record.repository_name)
                    && matches!(
                        Path::new(&record.repository_name)
                            .components()
                            .collect::<Vec<_>>()
                            .as_slice(),
                        [std::path::Component::Normal(_)]
                    ),
                "managed_worktree_relocation_unproven_owned_path"
            );
        }
        // Only an actual registered directory supplies a match. Missing roots
        // cannot turn an arbitrary external locator into an owned address.
        if let Ok(root) = PrivateDirectory::open_existing(root) {
            owned.insert(serde_json::to_string(
                &root.portable_directory_handle_identity()?,
            )?);
        }
    }
    registered.verify()?;
    Ok(candidates
        .into_iter()
        .filter_map(|(path, ancestors)| (!ancestors.is_disjoint(&owned)).then_some(path.clone()))
        .collect())
}

pub(super) fn reference_ancestors(path: &Path) -> BTreeSet<String> {
    let Ok(path) = kcoder_config::storage::node_storage_path(path) else {
        return BTreeSet::new();
    };
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return BTreeSet::new();
        };
        let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
            return BTreeSet::new();
        };
        let drive = [u16::from(drive), b':' as u16, b'\\' as u16, 0];
        // Query only the drive root. UNC, remote drives and unknown devices do
        // not enter this local metadata-only fallback.
        // SAFETY: drive is a live NUL-terminated three-character root.
        if !matches!(
            unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(drive.as_ptr()) },
            2 | 3 | 5 | 6
        ) {
            return BTreeSet::new();
        }
    }
    // Existing no-follow handles prove aliases, including case and 8.3 names.
    // Unobservable external names remain opaque; no payload or children are read.
    path.ancestors()
        .take(256)
        .filter_map(|path| {
            let root = PrivateDirectory::open_existing(path).ok()?;
            serde_json::to_string(&root.portable_directory_handle_identity().ok()?).ok()
        })
        .collect()
}

/// After publication, recover the original source from its per-registry Git
/// receipt. The component and original control handle are mandatory; returned
/// snapshots are evidence, and public relocate/verify still issue fresh facts.
pub async fn profile_relocation_snapshots_for_operation(
    source: &Path,
    target: &Path,
    operation_id: &str,
    control: &PrivateDirectory,
    published: &StoragePublishedComponent,
) -> Result<Vec<ProfileManagedWorktreeRelocation>> {
    validate_operation(operation_id)?;
    validate_roots(source, target)?;
    control.verify_private_directory()?;
    published.verify()?;
    ensure!(
        published.operation_id() == operation_id
            && published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && published.source_path() == source
            && published.destination_path() == target
            && directory(source)?.directory_identity()? == published.source_identity()
            && directory(target)?.directory_identity()?
                == published.directory().directory_identity()?,
        "managed_worktree_relocation_published_component_mismatch"
    );
    collect(source, target, Some((operation_id, control, published)))
        .await
        .context("managed_worktree_relocation_unsettled_original_operation_do_not_replay")
}

pub(super) async fn collect(
    source: &Path,
    target: &Path,
    operation: Option<(&str, &PrivateDirectory, &StoragePublishedComponent)>,
) -> Result<Vec<ProfileManagedWorktreeRelocation>> {
    ensure!(
        safe_absolute_path(source) && safe_absolute_path(target),
        "managed_worktree_profile_roots_invalid"
    );
    if absent(source)? || source == target {
        return Ok(Vec::new());
    }
    validate_roots(source, target)?;
    let registered = registered_profile(source)?;
    let mut result = Vec::new();
    for (registry_path, stamp) in &registered.registries {
        let project = registry_path.parent().unwrap();
        let source_store =
            ClientWorktreeStore::from_client_storage_root(project.join("client-sessions"), true);
        let target_store = ClientWorktreeStore::from_client_storage_root(
            target
                .join(project.strip_prefix(source)?)
                .join("client-sessions"),
            true,
        );
        let snapshot = if let Some((operation_id, control, published)) = operation {
            match read_optional(control, &receipt_name(registry_path))? {
                Some(bytes) => {
                    let receipt: Receipt = serde_json::from_slice(&bytes)?;
                    verify_registered_source(
                        &source_store,
                        &target_store,
                        source,
                        target,
                        stamp,
                        &receipt.source,
                    )?;
                    verify_publication(&receipt.source, operation_id, published)?;
                    check_receipt(&receipt, operation_id, control, &receipt.source)?;
                    verify_source(&receipt.source, &receipt)?;
                    verify_target_dotgit(&receipt)?;
                    verify_original_receipt(&source_store, &target_store, &receipt).await?;
                    receipt.source
                }
                None => {
                    let target_stamp = read_path(&target_store.state_path)?.1;
                    ensure!(
                        target_stamp.sha256 == stamp.sha256
                            && target_stamp.identity != stamp.identity,
                        "managed_worktree_relocation_original_receipt_missing_target_changed"
                    );
                    let snapshot = source_store
                        .relocation_snapshot(source, target)
                        .await?
                        .context("managed_worktree_profile_registry_disappeared")?;
                    verify_publication(&snapshot, operation_id, published)?;
                    verify_no_original_publication(&snapshot, operation_id)?;
                    snapshot
                }
            }
        } else {
            source_store
                .relocation_snapshot(source, target)
                .await
                .context("managed_worktree_profile_registry_invalid")?
                .context("managed_worktree_profile_registry_disappeared")?
        };
        ensure!(
            snapshot.source_data_root_identity == registered.source_identity
                && snapshot.registry == *stamp,
            "managed_worktree_profile_source_changed"
        );
        result.push(ProfileManagedWorktreeRelocation {
            source_store,
            target_store,
            snapshot,
        });
    }
    registered.verify()?;
    Ok(result)
}

/// The actual registered source is independent evidence. A receipt's source
/// cannot authorize itself by equality with the same deserialized JSON value.
fn verify_registered_source(
    store: &ClientWorktreeStore,
    target_store: &ClientWorktreeStore,
    source: &Path,
    target: &Path,
    stamp: &FileStamp,
    snapshot: &ManagedWorktreeRelocationSnapshot,
) -> Result<()> {
    let state = store.load()?;
    let root = Path::new(&state.settings.resolved_worktree_root);
    ensure!(
        snapshot.source_data_root == source
            && snapshot.target_data_root == target
            && snapshot.source_registry == store.state_path
            && snapshot.target_registry == target_store.state_path
            && snapshot.registry == *stamp
            && snapshot.source_root == root
            && snapshot.target_root == mapped(root, source, target),
        "managed_worktree_relocation_original_registry_binding_changed"
    );
    if snapshot.source_root == snapshot.target_root {
        ensure!(
            snapshot.entries.is_empty(),
            "managed_worktree_relocation_external_root_changed"
        );
        return Ok(());
    }
    ensure!(
        snapshot.entries.len() == state.records.len(),
        "managed_worktree_relocation_original_records_changed"
    );
    validate_owned_root(root, &state)?;
    for (entry, record) in snapshot.entries.iter().zip(state.records.values()) {
        let path = Path::new(&record.path);
        ensure!(
            entry.path == path
                && entry.target == mapped(path, source, target)
                && entry.worktree_id == record.worktree_id
                && entry.revision == record.revision
                && path == root.join(&record.worktree_id).join(&record.repository_name)
                && matches!(
                    Path::new(&record.repository_name)
                        .components()
                        .collect::<Vec<_>>()
                        .as_slice(),
                    [std::path::Component::Normal(_)]
                )
                && !matches!(record.state.as_str(), "restoring" | "snapshot_ready")
                && record
                    .source_path
                    .as_deref()
                    .is_none_or(|path| !Path::new(path).starts_with(source)),
            "managed_worktree_relocation_original_record_changed"
        );
        if record.state == "active" {
            let git = entry
                .git
                .as_ref()
                .context("managed_worktree_relocation_original_git_missing")?;
            let (dotgit, dotgit_stamp) = read_path(&path.join(".git"))?;
            let admin = PathBuf::from(
                single_line(&dotgit)?
                    .strip_prefix("gitdir: ")
                    .context("managed_worktree_relocation_not_linked_worktree")?,
            );
            let worktrees = admin
                .parent()
                .context("managed_worktree_relocation_admin_invalid")?;
            let common = worktrees
                .parent()
                .context("managed_worktree_relocation_common_missing")?;
            let (commondir, commondir_stamp) = read_path(&admin.join("commondir"))?;
            let original_gitdir = gitdir_replacement(path)?;
            ensure!(
                worktrees.file_name() == Some(OsStr::new("worktrees"))
                    && git.admin == admin
                    && git.common == common
                    && !common.starts_with(source)
                    && dotgit == git.dotgit_bytes.as_bytes()
                    && dotgit_stamp == git.dotgit
                    && commondir_stamp == git.commondir
                    && dunce::canonicalize(admin.join(single_line(&commondir)?))? == common
                    && git.gitdir_bytes.as_bytes() == original_gitdir
                    && git.gitdir.sha256 == hex_sha256(&original_gitdir)
                    && record.source_path.is_some()
                    && record
                        .git_common_dir
                        .as_deref()
                        .is_none_or(|path| Path::new(path) == common),
                "managed_worktree_relocation_original_git_binding_changed"
            );
        } else {
            ensure!(
                entry.git.is_none() && absent(path)?,
                "managed_worktree_relocation_original_nonactive_changed"
            );
        }
        match (
            record.snapshot_ref.as_deref(),
            record.snapshot_commit.as_deref(),
            record.git_common_dir.as_deref(),
            &entry.snapshot,
        ) {
            (Some(old), Some(commit), Some(common), Some(retained)) => ensure!(
                retained.old == old
                    && retained.commit == commit
                    && retained.common == Path::new(common)
                    && !retained.common.starts_with(source)
                    && retained.new
                        == format!(
                            "refs/kcoder/worktree-snapshots/{}",
                            hex_sha256(utf8(&entry.target)?.as_bytes())
                        ),
                "managed_worktree_relocation_original_snapshot_ref_changed"
            ),
            (None, None, _, None) => {}
            _ => anyhow::bail!("managed_worktree_relocation_original_snapshot_ref_changed"),
        }
    }
    Ok(())
}

async fn verify_original_receipt(
    source_store: &ClientWorktreeStore,
    target_store: &ClientWorktreeStore,
    receipt: &Receipt,
) -> Result<()> {
    for item in &receipt.replacements {
        ensure!(
            item.candidate.as_ref().is_none_or(|candidate| {
                candidate.sha256 == item.replacement_sha256
                    && candidate.identity != item.original.identity
            }),
            "managed_worktree_relocation_original_candidate_changed"
        );
    }
    let snapshot = &receipt.source;
    let transformed = source_store.target_bytes(target_store, snapshot)?;
    ensure!(
        receipt.target_registry.sha256 == snapshot.registry.sha256
            && receipt.target_registry.identity != snapshot.registry.identity,
        "managed_worktree_relocation_original_target_copy_changed"
    );
    if snapshot.source_root != snapshot.target_root {
        let index = receipt.replacements.len() - 1;
        let item = &receipt.replacements[index];
        ensure!(
            item.replacement_sha256 == hex_sha256(&transformed),
            "managed_worktree_relocation_original_target_registry_changed"
        );
        if item.candidate.is_some() {
            verify_replacement(receipt, index)?;
        } else {
            ensure!(
                read_path(&target_store.state_path)?.1 == receipt.target_registry,
                "managed_worktree_relocation_original_target_registry_changed"
            );
        }
    } else {
        ensure!(
            read_path(&target_store.state_path)?.1 == receipt.target_registry,
            "managed_worktree_relocation_external_registry_changed"
        );
    }
    let state = source_store.load()?;
    for entry in &snapshot.entries {
        if let Some(binding) = &entry.git {
            let record = state
                .records
                .get(utf8(&entry.path)?)
                .context("managed_worktree_relocation_original_record_changed")?;
            let source = Path::new(
                record
                    .source_path
                    .as_deref()
                    .context("managed_worktree_relocation_original_source_missing")?,
            );
            let source_common = crate::git::run_git_command(
                source,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                4096,
                Duration::from_secs(15),
            )
            .await?;
            ensure!(
                source_common.success
                    && Path::new(source_common.stdout.as_str().unwrap_or_default().trim())
                        == binding.common
                    && git(
                        &binding.admin,
                        Some(&entry.target),
                        &["rev-parse", "--verify", "HEAD"]
                    )
                    .await?
                    .trim()
                        == binding.head
                    && git(
                        &binding.admin,
                        Some(&entry.target),
                        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                    )
                    .await?
                        == binding.status
                    && tree_hash(&directory(&entry.target)?, true, true, &[])?
                        == binding.content_sha256,
                "managed_worktree_relocation_original_git_content_changed"
            );
        }
    }
    for (index, retained) in snapshot
        .entries
        .iter()
        .filter_map(|entry| entry.snapshot.as_ref())
        .enumerate()
    {
        verify_old_ref(retained).await?;
        let current = read_ref(&retained.common, &retained.new).await?;
        ensure!(
            match receipt.refs[index] {
                RefState::NotStarted => current.is_none(),
                RefState::Intent | RefState::Verified =>
                    current.as_deref() == Some(&retained.commit),
            },
            "managed_worktree_relocation_original_ref_unsettled_do_not_replay"
        );
    }
    Ok(())
}

fn verify_no_original_publication(
    snapshot: &ManagedWorktreeRelocationSnapshot,
    operation_id: &str,
) -> Result<()> {
    let mut index = 0;
    for entry in &snapshot.entries {
        if let Some(git) = &entry.git {
            let parent = directory(&git.admin)?;
            ensure!(
                read_optional(&parent, &candidate_name(operation_id, index))?.is_none()
                    && read_optional(&parent, &previous_name(operation_id, index))?.is_none(),
                "managed_worktree_relocation_original_receipt_missing_publication_unsettled"
            );
            index += 1;
        }
    }
    if snapshot.source_root != snapshot.target_root {
        let parent = directory(snapshot.target_registry.parent().unwrap())?;
        ensure!(
            read_optional(&parent, &candidate_name(operation_id, index))?.is_none()
                && read_optional(&parent, &previous_name(operation_id, index))?.is_none(),
            "managed_worktree_relocation_original_receipt_missing_publication_unsettled"
        );
    }
    Ok(())
}
