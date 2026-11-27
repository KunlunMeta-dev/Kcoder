//! Explicit offline physical identity associations. Business journals are never rewritten.
use super::*;
use kcoder_config::storage::StoragePublishedComponent;
use kcoder_state::history_storage_relocation::{
    self as history_relocation, HistoryRelocationMetadata,
};
use kcoder_types::PrivateFileIdentityV1;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

pub(super) const RECORD: &str = ".retention-relocation.json";
const MAX_ENTRIES: usize = 32_768;
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

#[path = "relocation/references.rs"]
mod references;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileSnapshot {
    identity: PrivateFileIdentityV1,
    size: u64,
    sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TreeSnapshot {
    directories: BTreeMap<PathBuf, PrivateFileIdentityV1>,
    history_metadata: BTreeMap<PathBuf, HistoryRelocationMetadata>,
    files: BTreeMap<PathBuf, FileSnapshot>,
    previous_map_sha256: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionRelocationSnapshot {
    account: PathBuf,
    account_identity: String,
    scope_account_identity: PrivateFileIdentityV1,
    namespace: String,
    tree: TreeSnapshot,
    artifacts: BTreeMap<PathBuf, TreeSnapshot>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityBinding {
    recorded: PrivateFileIdentityV1,
    actual: PrivateFileIdentityV1,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IdentityMap {
    version: u32,
    operation_id: String,
    namespace: String,
    source_snapshot_sha256: String,
    root_identity: PrivateFileIdentityV1,
    account_identity: PrivateFileIdentityV1,
    scope_account_identity: PrivateFileIdentityV1,
    bindings: BTreeMap<String, IdentityBinding>,
}
fn identity_key(identity: &PrivateFileIdentityV1) -> String {
    digest(&serde_json::to_vec(identity).expect("identity serialization"))
}
impl IdentityMap {
    pub(super) fn scope_account_identity(&self) -> &PrivateFileIdentityV1 {
        &self.scope_account_identity
    }
    /// This is evidence for a native operation, never a substitute native identity.
    pub(super) fn physical<'a>(
        &'a self,
        expected: &'a PrivateFileIdentityV1,
    ) -> &'a PrivateFileIdentityV1 {
        self.bindings
            .get(&identity_key(expected))
            .filter(|binding| binding.recorded == *expected)
            .map(|binding| &binding.actual)
            .unwrap_or(expected)
    }
    pub(super) fn load(
        root: &PrivateDirectory,
        namespace: &str,
        account_identity: &PrivateFileIdentityV1,
    ) -> Result<Option<Self>> {
        let Some(bytes) = read_map(root)? else {
            return Ok(None);
        };
        let map: Self = serde_json::from_slice(&bytes)?;
        ensure!(
            map.version == 1
                && valid_operation(&map.operation_id)
                && map.namespace == namespace
                && map.root_identity == root.retention_identity()?
                && map.account_identity == *account_identity
                && map.bindings.len() <= MAX_ENTRIES * 4,
            "retention relocation owner changed"
        );
        sha(&map.source_snapshot_sha256)?;
        for (key, binding) in &map.bindings {
            ensure!(
                *key == identity_key(&binding.recorded),
                "retention relocation identity key changed"
            );
        }
        Ok(Some(map))
    }
}
fn valid_operation(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn read_map(root: &PrivateDirectory) -> Result<Option<Vec<u8>>> {
    let file = match root.open_regular_file(OsStr::new(RECORD)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    root.retention_regular_identity(OsStr::new(RECORD))?;
    ensure!(
        file.metadata()?.len() <= MAX_BYTES,
        "retention relocation record exceeds bound"
    );
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES,
        "retention relocation record exceeds bound"
    );
    Ok(Some(bytes))
}
fn hash_file(file: &std::fs::File) -> Result<(u64, String)> {
    use sha2::Digest;
    let size = file.metadata()?.len();
    ensure!(
        size <= MAX_FILE_BYTES,
        "retention relocation payload exceeds bound"
    );
    let mut hash = sha2::Sha256::new();
    let mut total = 0u64;
    let mut file = file;
    let mut bytes = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure!(total <= size, "retention relocation payload changed");
        hash.update(&bytes[..count]);
    }
    ensure!(
        total == size && file.metadata()?.len() == size,
        "retention relocation payload changed"
    );
    Ok((size, format!("{:x}", hash.finalize())))
}
fn scan(
    root: &PrivateDirectory,
    namespace_root: bool,
    published: Option<(
        &StoragePublishedComponent,
        &BTreeMap<PathBuf, HistoryRelocationMetadata>,
    )>,
) -> Result<TreeSnapshot> {
    let mut snapshot = TreeSnapshot {
        directories: BTreeMap::new(),
        history_metadata: BTreeMap::new(),
        files: BTreeMap::new(),
        previous_map_sha256: if namespace_root {
            read_map(root)?.as_deref().map(digest)
        } else {
            None
        },
    };
    scan_child(
        root,
        Path::new(""),
        &mut snapshot,
        namespace_root,
        published,
    )?;
    Ok(snapshot)
}
fn scan_child(
    directory: &PrivateDirectory,
    path: &Path,
    snapshot: &mut TreeSnapshot,
    namespace_root: bool,
    published: Option<(
        &StoragePublishedComponent,
        &BTreeMap<PathBuf, HistoryRelocationMetadata>,
    )>,
) -> Result<()> {
    ensure!(
        path.components().count() <= 16
            && snapshot.directories.len() + snapshot.files.len() < MAX_ENTRIES,
        "retention relocation tree exceeds bound"
    );
    snapshot
        .directories
        .insert(path.into(), directory.retention_identity()?);
    let metadata = match published {
        Some((proof, original)) => history_relocation::verify_relocation_metadata(
            proof,
            directory,
            original
                .get(path)
                .context("retention source directory fact missing")?,
        )?,
        None => history_relocation::observe_relocation_metadata(directory)?,
    };
    for name in directory.entry_names_bounded(MAX_ENTRIES)? {
        if metadata.is_metadata_entry(directory, &name)? {
            continue;
        }
        if namespace_root && path.as_os_str().is_empty() && name == OsStr::new(RECORD) {
            continue;
        }
        let relative = path.join(&name);
        match directory.open_regular_file(&name) {
            Ok(file) => {
                let identity = directory.retention_regular_handle_identity(&file)?;
                let (size, sha256) = hash_file(&file)?;
                directory.open_verified_regular(&name, &identity)?;
                ensure!(
                    snapshot.directories.len() + snapshot.files.len() < MAX_ENTRIES,
                    "retention relocation entry bound"
                );
                snapshot.files.insert(
                    relative,
                    FileSnapshot {
                        identity,
                        size,
                        sha256,
                    },
                );
            }
            Err(file_error) => {
                let child = directory.open_child(&name, false).with_context(|| {
                    format!("unsupported retained attachment entry: {file_error}")
                })?;
                scan_child(&child, &relative, snapshot, false, published)?;
            }
        }
    }
    snapshot.history_metadata.insert(path.into(), metadata);
    Ok(())
}
fn existing(account: &Path) -> Result<RetentionService> {
    Ok(RetentionService {
        store: Store::open_readonly(account, Limits::default())?,
    })
}
fn owner_leases(service: &RetentionService) -> Result<Vec<VerifiedPrivateEntry>> {
    let owners = service
        .store
        .relocation_root()
        .open_child(OsStr::new("owners"), false)?;
    let mut leases = Vec::new();
    let mut count = 0usize;
    owners.visit_regular_files(
        |_| true,
        |name, file| {
            count += 1;
            ensure!(count <= MAX_ENTRIES, "retention owner record bound");
            ensure!(
                file.metadata()?.len() <= RECORD_BYTES,
                "retention owner record exceeds bound"
            );
            let mut bytes = Vec::new();
            file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
            let owner: Owner = serde_json::from_slice(&bytes)?;
            ensure!(
                canonical_scope(&owner.scope)? == owner.scope
                    && name == OsStr::new(&storage::leaf(&owner.id)),
                "retention relocation owner scope changed"
            );
            let terminal = matches!(owner.phase, OwnerPhase::Retired | OwnerPhase::Cancelled);
            let parent = service.store.leases()?;
            if owner.layout_version == 2 {
                let name = [
                    owner_init::manifest_name(&owner.id),
                    owner_init::manifest_quarantine(&owner.id),
                ]
                .into_iter()
                .find(|name| parent.open_regular_file(OsStr::new(name)).is_ok());
                if let Some(name) = name {
                    let lease = service.verified_owner_manifest(&owner, &name)?;
                    ensure!(
                        lease.try_exclusive_lease()?,
                        "retention relocation owner is busy"
                    );
                    leases.push(lease);
                } else {
                    ensure!(
                        terminal,
                        "retention owner manifest publication is incomplete"
                    );
                }
            } else {
                ensure!(
                    owner.layout_version == 1,
                    "unsupported retention owner layout"
                );
                if matches!(owner.phase, OwnerPhase::Active | OwnerPhase::Unknown)
                    && owner.data_identity.is_some()
                {
                    service.owner_data(&owner)?;
                }
                let directory = [owner.id.clone(), format!("q-lease-{}", owner.id)]
                    .into_iter()
                    .find_map(|name| parent.open_child(OsStr::new(&name), false).ok());
                if let Some(directory) = directory {
                    directory.verify_retention_identity(
                        service.store.physical(
                            owner
                                .lease_directory_identity
                                .as_ref()
                                .context("retention lease parent missing")?,
                        ),
                    )?;
                    let identity = owner
                        .lease_identity
                        .as_ref()
                        .context("retention lease identity missing")?;
                    match directory.try_existing_verified_lock(
                        OsStr::new("lock"),
                        service.store.physical(identity),
                        PrivateLeaseMode::Exclusive,
                    ) {
                        Ok(Some(lease)) => leases.push(lease),
                        Err(error) if terminal && missing(&error) => (),
                        _ => anyhow::bail!("retention relocation owner is busy or changed"),
                    }
                } else {
                    ensure!(terminal, "retention owner lease publication is incomplete");
                }
            }
            Ok(())
        },
    )?;
    Ok(leases)
}
fn namespace_lease(service: &RetentionService) -> Result<VerifiedPrivateEntry> {
    let root = service.store.relocation_root();
    let lease = root
        .try_existing_verified_lock(
            OsStr::new("namespace.lock"),
            service.store.physical(&service.store.header.lock_identity),
            PrivateLeaseMode::Exclusive,
        )?
        .context("retention relocation namespace is busy")?;
    for name in ["initializing", "transaction"] {
        match root.open_regular_file(OsStr::new(name)) {
            Err(error) if missing(&error) => (),
            Err(error) => return Err(error),
            Ok(_) => {
                anyhow::bail!("retention journal requires its original recovery before relocation")
            }
        }
    }
    Ok(lease)
}
fn snapshot_locked(
    account: &Path,
    service: &RetentionService,
    artifacts: &[PathBuf],
) -> Result<RetentionRelocationSnapshot> {
    ensure!(artifacts.len() <= 256, "retention artifact parent bound");
    let mut parents = BTreeMap::new();
    let mut total = 0usize;
    for path in artifacts {
        let path = path.canonicalize()?;
        let parent = PrivateDirectory::open_existing(&path)?;
        let tree = scan(&parent, false, None)?;
        total += tree.files.len() + tree.directories.len();
        ensure!(
            total <= MAX_ENTRIES,
            "retention artifact relocation entry bound"
        );
        ensure!(
            parents.insert(path, tree).is_none(),
            "duplicate retention artifact parent"
        );
    }
    let mut used_parents = BTreeSet::new();
    let receipts = service
        .store
        .relocation_root()
        .open_child(OsStr::new("receipts"), false)?;
    let mut receipt_count = 0usize;
    receipts.visit_regular_files(
        |_| true,
        |_, file| {
            receipt_count += 1;
            ensure!(
                receipt_count <= MAX_ENTRIES,
                "retention receipt record bound"
            );
            ensure!(
                file.metadata()?.len() <= RECORD_BYTES,
                "retention receipt record exceeds bound"
            );
            let mut bytes = Vec::new();
            file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
            let receipt: Receipt = serde_json::from_slice(&bytes)?;
            if let Some(intent) = &receipt.transfer_intent {
                let parent = parents
                    .iter()
                    .find(|(_, tree)| {
                        &tree.directories[Path::new("")]
                            == service.store.physical(&intent.artifact_parent)
                    })
                    .context("retention artifact parent is missing from relocation scope")?;
                used_parents.insert(parent.0.clone());
                ensure!(
                    receipt.wire.thread_id == intent.identity.thread_id,
                    "retention transfer thread changed"
                );
            }
            Ok(())
        },
    )?;
    ensure!(
        used_parents.len() == parents.len(),
        "unreferenced external retention parent cannot be adopted"
    );
    let tree = scan(service.store.relocation_root(), true, None)?;
    let entries = service
        .store
        .relocation_root()
        .open_child(OsStr::new("entries"), false)?;
    entries.visit_regular_files(
        |_| true,
        |name, file| {
            ensure!(
                file.metadata()?.len() <= RECORD_BYTES,
                "retention entry record exceeds bound"
            );
            let mut bytes = Vec::new();
            file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
            let entry: Entry = serde_json::from_slice(&bytes)?;
            ensure!(
                name == OsStr::new(&storage::leaf(&entry.id)),
                "retention entry ID changed"
            );
            if matches!(
                entry.phase,
                EntryPhase::Sealed
                    | EntryPhase::Ready
                    | EntryPhase::Materializing
                    | EntryPhase::Copied
            ) {
                let identity = entry
                    .payload_identity
                    .as_ref()
                    .context("retention payload identity missing")?;
                let file = tree
                    .files
                    .values()
                    .find(|file| &file.identity == service.store.physical(identity))
                    .context("retention payload identity changed")?;
                ensure!(
                    file.size == entry.size && file.sha256 == entry.content_sha256,
                    "retention payload hash changed"
                );
            }
            Ok(())
        },
    )?;
    Ok(RetentionRelocationSnapshot {
        account: account.canonicalize()?,
        account_identity: PrivateDirectory::open_existing(account)?.directory_identity()?,
        scope_account_identity: service.store.scope_account_identity().clone(),
        namespace: service.namespace().into(),
        tree,
        artifacts: parents,
    })
}
/// Read-only, stopped source inventory. All supplied parents belong to this account's retained inputs.
pub fn relocation_snapshot(
    account: &Path,
    artifact_parents: &[PathBuf],
) -> Result<RetentionRelocationSnapshot> {
    let service = existing(account)?;
    let _namespace = namespace_lease(&service)?;
    let _owners = owner_leases(&service)?;
    snapshot_locked(account, &service, artifact_parents)
}

/// Select receipt-owned parents from State's already verified session registry.
/// The supplied paths are candidates only; an unreferenced directory is never adopted.
pub fn relocation_snapshot_registered(
    account: &Path,
    registered_artifact_parents: &[PathBuf],
) -> Result<RetentionRelocationSnapshot> {
    ensure!(
        registered_artifact_parents.len() <= MAX_ENTRIES * 2,
        "retention registered session bound"
    );
    let service = existing(account)?;
    let _namespace = namespace_lease(&service)?;
    let _owners = owner_leases(&service)?;
    let mut candidates = BTreeMap::new();
    for path in registered_artifact_parents {
        let path = path.canonicalize()?;
        let parent = PrivateDirectory::open_existing(&path)?;
        let identity = parent.retention_identity()?;
        ensure!(
            candidates
                .insert(identity_key(&identity), (path, identity))
                .is_none(),
            "duplicate registered retention parent"
        );
    }
    let mut selected = BTreeSet::new();
    let receipts = service
        .store
        .relocation_root()
        .open_child(OsStr::new("receipts"), false)?;
    let mut count = 0usize;
    receipts.visit_regular_files(
        |_| true,
        |_, file| {
            count += 1;
            ensure!(
                count <= MAX_ENTRIES && file.metadata()?.len() <= RECORD_BYTES,
                "retention receipt record bound"
            );
            let mut bytes = Vec::new();
            file.take(RECORD_BYTES + 1).read_to_end(&mut bytes)?;
            let receipt: Receipt = serde_json::from_slice(&bytes)?;
            if let Some(intent) = receipt.transfer_intent {
                let physical = service.store.physical(&intent.artifact_parent);
                let (path, actual) = candidates.get(&identity_key(physical)).context(
                    "retention artifact parent is absent from the registered session scope",
                )?;
                ensure!(actual == physical, "registered retention parent changed");
                selected.insert(path.clone());
            }
            Ok(())
        },
    )?;
    snapshot_locked(account, &service, &selected.into_iter().collect::<Vec<_>>())
}

impl RetentionRelocationSnapshot {
    pub fn artifact_parents(&self) -> impl Iterator<Item = &Path> {
        self.artifacts.keys().map(PathBuf::as_path)
    }
}
fn same_copy(source: &TreeSnapshot, target: &TreeSnapshot) -> Result<()> {
    ensure!(
        source.directories.keys().eq(target.directories.keys())
            && source.files.keys().eq(target.files.keys()),
        "retention relocation copy differs"
    );
    for (name, original) in &source.files {
        let copy = &target.files[name];
        ensure!(
            original.size == copy.size && original.sha256 == copy.sha256,
            "retention relocation bytes differ"
        );
    }
    Ok(())
}
fn append_bindings(
    source: &TreeSnapshot,
    target: &TreeSnapshot,
    previous: Option<&IdentityMap>,
    references: &BTreeSet<String>,
    bindings: &mut BTreeMap<String, IdentityBinding>,
) -> Result<()> {
    same_copy(source, target)?;
    let mut pairs = Vec::new();
    for (name, identity) in &source.directories {
        pairs.push((identity, &target.directories[name]));
    }
    for (name, file) in &source.files {
        pairs.push((&file.identity, &target.files[name].identity));
    }
    let mut previous_by_actual: BTreeMap<String, Vec<&IdentityBinding>> = BTreeMap::new();
    if let Some(previous) = previous {
        for binding in previous.bindings.values() {
            previous_by_actual
                .entry(identity_key(&binding.actual))
                .or_default()
                .push(binding);
        }
    }
    for (source, actual) in pairs {
        if let Some(previous) = previous_by_actual.get(&identity_key(source)) {
            for binding in previous.iter().filter(|binding| binding.actual == *source) {
                bindings.insert(
                    identity_key(&binding.recorded),
                    IdentityBinding {
                        recorded: binding.recorded.clone(),
                        actual: actual.clone(),
                    },
                );
            }
        }
        // Preserve birth facts and identities actually named by durable records.
        // A new placement alone is not another historical identity.
        if references.contains(&identity_key(source)) {
            bindings.insert(
                identity_key(source),
                IdentityBinding {
                    recorded: source.clone(),
                    actual: actual.clone(),
                },
            );
        }
    }
    ensure!(
        bindings.len() <= MAX_ENTRIES * 4,
        "retention relocation identity bound"
    );
    Ok(())
}
fn publish_map(
    root: &PrivateDirectory,
    expected: &IdentityMap,
    prior: &Option<String>,
    publish: bool,
) -> Result<()> {
    let previous = read_map(root)?;
    let committed = previous
        .as_deref()
        .map(serde_json::from_slice::<IdentityMap>)
        .transpose()?
        .as_ref()
        == Some(expected);
    if !committed {
        ensure!(
            publish && previous.as_deref().map(digest) == *prior,
            "retention relocation target operation changed"
        );
        let bytes = serde_json::to_vec(expected)?;
        ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "retention relocation record exceeds bound"
        );
        root.atomic_replace(OsStr::new(RECORD), &bytes)?;
    }
    ensure!(
        IdentityMap::load(root, &expected.namespace, &expected.account_identity)?.as_ref()
            == Some(expected),
        "retention relocation publication is unknown"
    );
    Ok(())
}
/// Convert only owner-owned physical associations at the final copied destinations.
pub fn relocate(
    source: &Path,
    target: &Path,
    operation_id: &str,
    expected: &RetentionRelocationSnapshot,
    artifact_targets: &BTreeMap<PathBuf, PathBuf>,
    published: &StoragePublishedComponent,
) -> Result<()> {
    relocation_target(
        source,
        target,
        operation_id,
        expected,
        artifact_targets,
        published,
        true,
    )
}
/// Verify the original operation without rewriting business rows or replaying a transfer.
pub fn verify_relocation(
    source: &Path,
    target: &Path,
    operation_id: &str,
    expected: &RetentionRelocationSnapshot,
    artifact_targets: &BTreeMap<PathBuf, PathBuf>,
    published: &StoragePublishedComponent,
) -> Result<()> {
    relocation_target(
        source,
        target,
        operation_id,
        expected,
        artifact_targets,
        published,
        false,
    )
}
fn relocation_target(
    source: &Path,
    target: &Path,
    operation_id: &str,
    expected: &RetentionRelocationSnapshot,
    artifact_targets: &BTreeMap<PathBuf, PathBuf>,
    published: &StoragePublishedComponent,
    publish: bool,
) -> Result<()> {
    verify_published(published, source, target, operation_id)?;
    for (source, target) in artifact_targets {
        verify_published(published, source, target, operation_id)?;
    }
    ensure!(
        valid_operation(operation_id) && expected.artifacts.keys().eq(artifact_targets.keys()),
        "retention relocation operation or artifact parents differ"
    );
    let service = existing(source)?;
    let _source_namespace = namespace_lease(&service)?;
    let _source_owners = owner_leases(&service)?;
    let parents = expected.artifacts.keys().cloned().collect::<Vec<_>>();
    ensure!(
        snapshot_locked(source, &service, &parents)? == *expected,
        "retention relocation source changed"
    );
    let references = references::referenced_identities(&service, expected)?;
    let account = PrivateDirectory::open_existing(target)?;
    ensure!(
        account.directory_identity()? != expected.account_identity,
        "retention relocation source aliases target"
    );
    let root = account.open_child(OsStr::new("attachment-retention-v1"), false)?;
    let target_tree = scan(
        &root,
        true,
        Some((published, &expected.tree.history_metadata)),
    )?;
    same_copy(&expected.tree, &target_tree)?;
    let root_lock = root.retention_regular_identity(OsStr::new("namespace.lock"))?;
    let _target_namespace = root
        .try_existing_verified_lock(
            OsStr::new("namespace.lock"),
            &root_lock,
            PrivateLeaseMode::Exclusive,
        )?
        .context("retention relocation target is busy")?;
    let sha256 = digest(&serde_json::to_vec(expected)?);
    let mut map = IdentityMap {
        version: 1,
        operation_id: operation_id.into(),
        namespace: expected.namespace.clone(),
        source_snapshot_sha256: sha256,
        root_identity: target_tree.directories[Path::new("")].clone(),
        account_identity: account.retention_identity()?,
        scope_account_identity: expected.scope_account_identity.clone(),
        bindings: BTreeMap::new(),
    };
    append_bindings(
        &expected.tree,
        &target_tree,
        service.store.relocation_map(),
        &references,
        &mut map.bindings,
    )?;
    for (source_path, original) in &expected.artifacts {
        let target_parent = PrivateDirectory::open_existing(&artifact_targets[source_path])?;
        let copy = scan(
            &target_parent,
            false,
            Some((published, &original.history_metadata)),
        )?;
        ensure!(
            original.directories[Path::new("")] != copy.directories[Path::new("")],
            "retention artifact target aliases source"
        );
        append_bindings(
            original,
            &copy,
            service.store.relocation_map(),
            &references,
            &mut map.bindings,
        )?;
    }
    ensure!(
        map.bindings.len() <= MAX_ENTRIES * 4,
        "retention relocation identity bound"
    );
    publish_map(&root, &map, &expected.tree.previous_map_sha256, publish)?;
    let relocated = existing(target)?;
    let _owners = owner_leases(&relocated)?;
    verify_published(published, source, target, operation_id)
}

fn verify_published(
    published: &StoragePublishedComponent,
    source: &Path,
    target: &Path,
    operation_id: &str,
) -> Result<()> {
    published.verify()?;
    ensure!(
        published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN
            && published.operation_id() == operation_id
            && PrivateDirectory::open_existing(published.source_path())?.directory_identity()?
                == published.source_identity(),
        "retention relocation publication differs"
    );
    ensure!(
        source
            .canonicalize()?
            .strip_prefix(published.source_path().canonicalize()?)?
            == target
                .canonicalize()?
                .strip_prefix(published.destination_path().canonicalize()?)?,
        "retention relocation is outside the published component"
    );
    Ok(())
}
