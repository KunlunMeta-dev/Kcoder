//! Explicit migration to immutable draft/version objects with a small atomic catalog.
//! A single catalog switch commits the transaction; legacy data stays available as backup.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::Write;
const CATALOG: &str = "storage.json";
const OBJECTS: &str = "objects";
const JOURNAL: &str = "storage-transition.json";
const PREPARED: &str = "storage-prepared.json";
const PREPARED_LEGACY: &str = "library-prepared.json";
const FENCE_BYTES: &[u8] = b"{\"formatVersion\":4294967295,\"records\":{}}";
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Transition {
    mode: String,
    legacy_backup: Option<String>,
    source_sha256: String,
    prepared_sha256: String,
    #[serde(default)]
    source_catalog_sha256: Option<String>,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn transition(directory: &PrivateDirectory) -> Result<Option<Transition>> {
    match directory.open_regular_file(OsStr::new(JOURNAL)) {
        Ok(file) => Ok(Some(
            serde_json::from_slice(&bounded_read(file)?)
                .context("workflow_corrupt: invalid storage transition")?,
        )),
        Err(error) if not_found(&error) => Ok(None),
        Err(error) => Err(error),
    }
}
fn leaf_bytes(directory: &PrivateDirectory, name: &str) -> Result<Vec<u8>> {
    bounded_read(directory.open_regular_file(OsStr::new(name))?)
}
fn remove_transition(directory: &PrivateDirectory) {
    let _ = directory.remove_regular_file(OsStr::new(JOURNAL));
    let _ = directory.remove_regular_file(OsStr::new(PREPARED));
    let _ = directory.remove_regular_file(OsStr::new(PREPARED_LEGACY));
}

pub(super) const MAX_BACKUP_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    format_version: u32,
    records: BTreeMap<String, Entry>,
    #[serde(default = "library_format_two")]
    library_format_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_fence_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_backup: Option<String>,
}
fn library_format_two() -> u32 {
    2
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    draft: String,
    versions: BTreeMap<u64, String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftObject {
    draft: WorkflowDefinition,
    layout_changes: BTreeMap<String, u64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionObject {
    definition: WorkflowDefinition,
    static_check: Option<StaticVerification>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageMigration {
    pub backend: String,
    pub migrated: bool,
    pub legacy_backup: Option<String>,
    pub workflow_count: usize,
    pub saved_version_count: usize,
}

fn catalog(directory: &PrivateDirectory) -> Result<Option<Catalog>> {
    let file = match directory.open_regular_file(OsStr::new(CATALOG)) {
        Ok(file) => file,
        Err(error) if not_found(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let bytes = bounded_read(file)?;
    let value: Catalog = serde_json::from_slice(&bytes)
        .context("workflow_corrupt: invalid sharded catalog; legacy backend will not be silently reactivated")?;
    ensure!(
        value.format_version == 1 && value.records.len() <= MAX_WORKFLOWS,
        "workflow_corrupt: invalid sharded storage version/count"
    );
    if let Some(fence) = &value.legacy_fence_sha256 {
        let source = leaf_bytes(directory, LIBRARY)?;
        if digest(&source) != *fence {
            let journal = transition(directory)?;
            ensure!(
                journal.is_some_and(|journal| journal.mode == "rollback"
                    && journal.source_sha256 == digest(&bytes)
                    && journal.prepared_sha256 == digest(&source)),
                "workflow_storage_fence_broken: legacy source changed after migration; both backends retained, stop incompatible writers and inspect before recovery"
            );
        }
    }
    Ok(Some(value))
}
pub(super) fn active(directory: &PrivateDirectory) -> Result<bool> {
    Ok(catalog(directory)?.is_some())
}
fn read_object<T: serde::de::DeserializeOwned>(
    objects: &PrivateDirectory,
    leaf: &str,
) -> Result<T> {
    ensure!(
        leaf.len() <= 192
            && leaf.ends_with(".json")
            && leaf
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.'),
        "workflow_corrupt: invalid storage object name"
    );
    let bytes = bounded_read(objects.open_regular_file(OsStr::new(leaf))?)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    ensure!(
        leaf.ends_with(&format!("-{hash}.json")),
        "workflow_corrupt: storage object hash mismatch"
    );
    serde_json::from_slice(&bytes).context("workflow_corrupt: invalid storage object")
}
pub(super) fn load(directory: &PrivateDirectory) -> Result<Option<Library>> {
    let Some(catalog) = catalog(directory)? else {
        return Ok(None);
    };
    Ok(Some(load_catalog(directory, catalog)?))
}
fn load_catalog(directory: &PrivateDirectory, catalog: Catalog) -> Result<Library> {
    let objects = directory.open_child(OsStr::new(OBJECTS), false)?;
    let mut records = BTreeMap::new();
    for (id, entry) in catalog.records {
        crate::graph::validate_id(&id)?;
        let draft: DraftObject = read_object(&objects, &entry.draft)?;
        let mut versions = BTreeMap::new();
        let mut static_checks = BTreeMap::new();
        ensure!(
            entry.versions.len() <= MAX_SAVED_VERSIONS,
            "workflow_quota: too many version objects"
        );
        for (version, leaf) in entry.versions {
            let saved: VersionObject = read_object(&objects, &leaf)?;
            if let Some(checks) = saved.static_check {
                static_checks.insert(version, checks);
            }
            versions.insert(version, saved.definition);
        }
        records.insert(
            id,
            Record {
                draft: draft.draft,
                versions,
                layout_changes: draft.layout_changes,
                static_checks,
            },
        );
    }
    let library = Library {
        format_version: catalog.library_format_version,
        records,
    };
    validate_library(&library)?;
    Ok(library)
}

fn immutable_object(objects: &PrivateDirectory, leaf: &str, bytes: &[u8]) -> Result<()> {
    match objects.open_regular_file(OsStr::new(leaf)) {
        Ok(file) => {
            let prior = bounded_read(file)?;
            ensure!(
                prior == bytes,
                "workflow_corrupt: immutable storage object was changed"
            );
            Ok(())
        }
        Err(error) if not_found(&error) => objects.atomic_replace(OsStr::new(leaf), bytes),
        Err(error) => Err(error),
    }
}
fn object_name(kind: &str, id: &str, bytes: &[u8]) -> String {
    format!("{kind}-{id}-{:x}.json", Sha256::digest(bytes))
}

fn prepare(
    directory: &PrivateDirectory,
    library: &Library,
    fence: Option<String>,
    backup: Option<String>,
) -> Result<(Vec<u8>, BTreeSet<String>)> {
    let objects = directory.open_child(OsStr::new(OBJECTS), true)?;
    let mut catalog = Catalog {
        format_version: 1,
        records: BTreeMap::new(),
        library_format_version: library.format_version,
        legacy_fence_sha256: fence,
        legacy_backup: backup,
    };
    let mut planned = BTreeMap::new();
    for (id, record) in &library.records {
        let bytes = serde_json::to_vec(&DraftObject {
            draft: record.draft.clone(),
            layout_changes: record.layout_changes.clone(),
        })?;
        let draft = object_name("draft", id, &bytes);
        planned.insert(draft.clone(), bytes);
        let mut versions = BTreeMap::new();
        for (version, definition) in &record.versions {
            let bytes = serde_json::to_vec(&VersionObject {
                definition: definition.clone(),
                static_check: record.static_checks.get(version).cloned(),
            })?;
            let leaf = object_name("version", id, &bytes);
            planned.insert(leaf.clone(), bytes);
            versions.insert(*version, leaf);
        }
        catalog
            .records
            .insert(id.clone(), Entry { draft, versions });
    }
    let bytes = serde_json::to_vec(&catalog)?;
    let used = planned
        .values()
        .map(Vec::len)
        .sum::<usize>()
        .saturating_add(bytes.len());
    ensure!(
        used <= MAX_LIBRARY_BYTES,
        "workflow_quota: active objects/catalog exceed {MAX_LIBRARY_BYTES} bytes; prior backend retained"
    );
    let mut staged_bytes = planned.values().map(Vec::len).sum::<usize>();
    for (leaf, file) in
        objects.open_regular_files(|leaf| leaf.to_string_lossy().ends_with(".json"))?
    {
        if !planned.contains_key(leaf.to_str().unwrap_or("")) {
            staged_bytes = staged_bytes.saturating_add(file.metadata()?.len() as usize);
        }
    }
    ensure!(
        staged_bytes <= MAX_LIBRARY_BYTES * 2,
        "workflow_quota: bounded object staging budget full; prior data retained"
    );
    for (leaf, bytes) in &planned {
        immutable_object(&objects, leaf, bytes)?;
    }
    Ok((bytes, planned.into_keys().collect()))
}
fn cleanup_objects(directory: &PrivateDirectory, referenced: &BTreeSet<String>) -> Result<()> {
    let objects = directory.open_child(OsStr::new(OBJECTS), false)?;
    if let Ok(files) = objects.open_regular_files(|leaf| leaf.to_string_lossy().ends_with(".json"))
    {
        for (leaf, _) in files {
            if !referenced.contains(leaf.to_str().unwrap_or("")) {
                let _ = objects.remove_regular_file(&leaf);
            }
        }
    }
    Ok(())
}
pub(super) fn commit(directory: &PrivateDirectory, library: &Library) -> Result<()> {
    let previous =
        catalog(directory)?.context("workflow_storage: objects backend is not active")?;
    ensure!(
        previous.legacy_fence_sha256.is_some(),
        "workflow_storage_upgrade_required: explicitly migrate the older unfenced objects backend before writing"
    );
    let (bytes, referenced) = prepare(
        directory,
        library,
        previous.legacy_fence_sha256,
        previous.legacy_backup,
    )?;
    directory
        .atomic_replace(OsStr::new(CATALOG), &bytes)
        .context("workflow_storage: catalog commit unconfirmed; reload before retrying")?;
    cleanup_objects(directory, &referenced)
}
fn activate_migration(
    directory: &PrivateDirectory,
    library: &Library,
    backup: &str,
    source: &[u8],
) -> Result<()> {
    let (bytes, referenced) = prepare(
        directory,
        library,
        Some(digest(FENCE_BYTES)),
        Some(backup.into()),
    )?;
    directory.atomic_replace(OsStr::new(PREPARED), &bytes)?;
    let journal = Transition {
        mode: "migrate".into(),
        legacy_backup: Some(backup.into()),
        source_sha256: digest(source),
        prepared_sha256: digest(&bytes),
        source_catalog_sha256: leaf_bytes(directory, CATALOG)
            .ok()
            .map(|bytes| digest(&bytes)),
    };
    directory.atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal)?)?;
    // Old programs acquire this same main lease and load library.json after it.
    // An unsupported sentinel prevents their normal transaction path from writing the old backend.
    directory.atomic_replace(OsStr::new(LIBRARY), FENCE_BYTES)?;
    directory.atomic_replace(OsStr::new(CATALOG),&bytes).context("workflow_storage: migration switch unconfirmed; recover the exact transition before retrying")?;
    remove_transition(directory);
    cleanup_objects(directory, &referenced)
}
pub(super) fn recover(directory: &PrivateDirectory) -> Result<Option<String>> {
    let Some(journal) = transition(directory)? else {
        return Ok(None);
    };
    if journal.mode == "migrate" {
        if let Ok(active_file) = directory.open_regular_file(OsStr::new(CATALOG)) {
            let active_bytes = bounded_read(active_file)?;
            let current: Catalog = serde_json::from_slice(&active_bytes)?;
            if current.legacy_fence_sha256.is_some() {
                catalog(directory)?;
                remove_transition(directory);
                return Ok(journal.legacy_backup);
            }
            ensure!(
                journal.source_catalog_sha256.as_deref() == Some(digest(&active_bytes).as_str()),
                "workflow_conflict: unfenced catalog changed while migration was interrupted; both states retained"
            );
        }
        let source = leaf_bytes(directory, LIBRARY)?;
        if digest(&source) == journal.source_sha256 {
            // Before the fence, a failed migration has not switched publication yet.
            remove_transition(directory);
            return Ok(None);
        }
        ensure!(
            source == FENCE_BYTES,
            "workflow_migration_recovery_required: source differs from backup/fence; all originals retained"
        );
        let backup = journal
            .legacy_backup
            .as_deref()
            .context("workflow_corrupt: missing migration backup")?;
        ensure!(
            backup.starts_with("library.pre-objects-") && backup.ends_with(".json"),
            "workflow_corrupt: invalid migration backup name"
        );
        ensure!(
            digest(&leaf_bytes(directory, backup)?) == journal.source_sha256,
            "workflow_corrupt: migration backup changed"
        );
        let prepared = leaf_bytes(directory, PREPARED)?;
        ensure!(
            digest(&prepared) == journal.prepared_sha256,
            "workflow_corrupt: prepared catalog changed"
        );
        let value: Catalog = serde_json::from_slice(&prepared)?;
        // Validate every staged object before accepting a interrupted visibility switch.
        load_catalog(directory, value)?;
        directory.atomic_replace(OsStr::new(CATALOG), &prepared)?;
        remove_transition(directory);
        Ok(journal.legacy_backup)
    } else if journal.mode == "rollback" {
        let prepared = leaf_bytes(directory, PREPARED_LEGACY)?;
        ensure!(
            digest(&prepared) == journal.prepared_sha256,
            "workflow_corrupt: prepared rollback changed"
        );
        if let Ok(active) = directory.open_regular_file(OsStr::new(CATALOG)) {
            ensure!(
                digest(&bounded_read(active)?) == journal.source_sha256,
                "workflow_conflict: active catalog changed during rollback; originals retained"
            );
        }
        let source = leaf_bytes(directory, LIBRARY)?;
        ensure!(
            source == FENCE_BYTES || digest(&source) == journal.prepared_sha256,
            "workflow_storage_fence_broken: rollback source changed externally"
        );
        directory.atomic_replace(OsStr::new(LIBRARY), &prepared)?;
        match directory.remove_regular_file(OsStr::new(CATALOG)) {
            Ok(()) => {}
            Err(error) if not_found(&error) => {}
            Err(error) => return Err(error),
        }
        remove_transition(directory);
        Ok(None)
    } else {
        anyhow::bail!("workflow_corrupt: unknown storage transition")
    }
}
pub(super) fn pending_library(directory: &PrivateDirectory) -> Result<Option<Library>> {
    let Some(journal) = transition(directory)? else {
        return Ok(None);
    };
    if journal.mode == "migrate" && leaf_bytes(directory, LIBRARY)? == FENCE_BYTES {
        let backup = journal
            .legacy_backup
            .as_deref()
            .context("workflow_corrupt: missing transition backup")?;
        let bytes = leaf_bytes(directory, backup)?;
        ensure!(
            digest(&bytes) == journal.source_sha256,
            "workflow_corrupt: pending backup changed"
        );
        let mut library: Library = serde_json::from_slice(&bytes)?;
        legacy::merge_checks(directory, &mut library)?;
        validate_library(&library)?;
        return Ok(Some(library));
    }
    Ok(None)
}

pub(super) fn usage(directory: &PrivateDirectory) -> Result<Option<usize>> {
    let Some(catalog) = catalog(directory)? else {
        return Ok(None);
    };
    let mut used = serde_json::to_vec(&catalog)?.len();
    let objects = directory.open_child(OsStr::new(OBJECTS), false)?;
    let names: BTreeSet<_> = catalog
        .records
        .values()
        .flat_map(|entry| std::iter::once(&entry.draft).chain(entry.versions.values()))
        .collect();
    for leaf in names {
        used = used.saturating_add(
            objects
                .open_regular_file(OsStr::new(leaf))?
                .metadata()?
                .len() as usize,
        );
    }
    Ok(Some(used))
}

pub(super) fn backup_usage(directory: &PrivateDirectory) -> Result<usize> {
    let mut total = 0usize;
    for (_, file) in directory.open_regular_files(|leaf| {
        leaf.to_string_lossy().starts_with("library.pre-objects-")
            && leaf.to_string_lossy().ends_with(".json")
    })? {
        total = total.saturating_add(file.metadata()?.len() as usize);
    }
    Ok(total)
}
pub(super) fn version_usage(
    directory: &PrivateDirectory,
) -> Result<Option<BTreeMap<String, usize>>> {
    let Some(catalog) = catalog(directory)? else {
        return Ok(None);
    };
    let objects = directory.open_child(OsStr::new(OBJECTS), false)?;
    let mut versions = BTreeMap::new();
    for (id, entry) in catalog.records {
        let mut total = 0usize;
        for leaf in entry.versions.values() {
            total = total.saturating_add(
                objects
                    .open_regular_file(OsStr::new(leaf))?
                    .metadata()?
                    .len() as usize,
            );
        }
        versions.insert(id, total);
    }
    Ok(Some(versions))
}

fn references(library: &Library) -> Result<()> {
    for record in library.records.values() {
        for definition in std::iter::once(&record.draft).chain(record.versions.values()) {
            for node in &definition.nodes {
                for reference in node.config.subworkflow.iter().chain(
                    node.config
                        .r#loop
                        .iter()
                        .flat_map(|config| config.body.iter()),
                ) {
                    let child = find(library, &reference.definition_id)?;
                    ensure!(
                        child.versions.contains_key(&reference.version),
                        "workflow_corrupt: missing pinned subworkflow {}@{}",
                        reference.definition_id,
                        reference.version
                    );
                }
            }
        }
    }
    Ok(())
}
impl WorkflowStore {
    pub fn storage_backend(&self) -> Result<&'static str> {
        let Some(directory) = self.open(false)? else {
            return Ok("legacy_json");
        };
        let _lease = library_lease(&directory, false)?;
        Ok(if active(&directory)? {
            "immutable_objects"
        } else {
            "legacy_json"
        })
    }
    /// Explicit, exclusive, one-way visibility switch. The retained backup is never dual-written.
    pub fn migrate_storage(&self) -> Result<StorageMigration> {
        let directory = self
            .open(true)?
            .context("workflow_storage: unavailable profile")?;
        let _lease = library_lease(&directory, true)?;
        let recovered = recover(&directory)?;
        let existing = catalog(&directory)?;
        let needs_switch = existing.is_none()
            || existing
                .as_ref()
                .is_some_and(|catalog| catalog.legacy_fence_sha256.is_none());
        let library = if existing.is_some() {
            super::load(&directory)?
        } else {
            load_legacy(&directory)?
        };
        let migrated = needs_switch || recovered.is_some();
        validate_library(&library)?;
        references(&library)?;
        let mut backup = recovered;
        if needs_switch {
            let leaf = format!("library.pre-objects-{}.json", uuid::Uuid::new_v4());
            let source = match directory.open_regular_file(OsStr::new(LIBRARY)) {
                Ok(file) => bounded_read(file)?,
                Err(error) if not_found(&error) => serde_json::to_vec(&library)?,
                Err(error) => return Err(error),
            };
            ensure!(
                backup_usage(&directory)?.saturating_add(source.len()) <= MAX_BACKUP_BYTES,
                "workflow_quota: retained migration backups exceed {MAX_BACKUP_BYTES} bytes; review backups before another migration"
            );
            let mut file = directory.open_read_write_file(OsStr::new(&leaf), true)?;
            file.write_all(&source)?;
            file.sync_all()?;
            directory.sync()?;
            // Validate every object before activating the catalog, including fixed child versions.
            activate_migration(&directory, &library, &leaf, &source)?;
            backup = Some(leaf);
        }
        Ok(StorageMigration {
            backend: "immutable_objects".into(),
            migrated,
            legacy_backup: backup,
            workflow_count: library.records.len(),
            saved_version_count: library
                .records
                .values()
                .map(|record| record.versions.len())
                .sum(),
        })
    }
    /// Export the current sharded state under the same exclusive lease, then disable that backend.
    /// A crash before marker removal leaves the sharded backend authoritative, with no lost edits.
    pub fn rollback_storage(&self) -> Result<()> {
        let directory = self
            .open(true)?
            .context("workflow_storage: unavailable profile")?;
        let _lease = library_lease(&directory, true)?;
        recover(&directory)?;
        if !active(&directory)? {
            return Ok(());
        }
        let mut library = super::load(&directory)?;
        history::restore_for_legacy(&directory, &mut library)?;
        validate_library(&library)?;
        references(&library)?;
        let bytes = legacy::compatible_bytes(&library)?;
        legacy::stage_checks(&directory, &library)?;
        ensure!(
            bytes.len() <= MAX_LIBRARY_BYTES,
            "workflow_quota: rollback export too large"
        );
        directory.atomic_replace(OsStr::new(PREPARED_LEGACY), &bytes)?;
        let source = leaf_bytes(&directory, CATALOG)?;
        let journal = Transition {
            mode: "rollback".into(),
            legacy_backup: None,
            source_sha256: digest(&source),
            prepared_sha256: digest(&bytes),
            source_catalog_sha256: None,
        };
        directory.atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal)?)?;
        recover(&directory).map(|_|()).context("workflow_storage: rollback switch unconfirmed; recover exact transition before retrying")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::workflow::WorkflowPosition;
    fn code(id: &str) -> WorkflowNode {
        serde_json::from_value(serde_json::json!({"id":id,"title":id,"kind":"code","config":{"code":{"source":"return 1;"}}})).unwrap()
    }
    fn saved(store: &WorkflowStore, title: &str) -> WorkflowDefinition {
        let draft = store.create(title, "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, code("one"))
            .unwrap();
        store.save(&draft.id, draft.revision).unwrap()
    }
    #[test]
    fn migration_preserves_versions_and_layout_writes_do_not_rewrite_version_objects() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let version1 = saved(&store, "First");
        let original = std::fs::read(store.root.join(LIBRARY)).unwrap();
        let migrated = store.migrate_storage().unwrap();
        assert!(migrated.migrated);
        let backup = migrated.legacy_backup.unwrap();
        assert_eq!(std::fs::read(store.root.join(&backup)).unwrap(), original);
        assert_eq!(store.read_saved(&version1.id, Some(1)).unwrap(), version1);
        let directory = store.open(false).unwrap().unwrap();
        let before = catalog(&directory).unwrap().unwrap();
        let leaf = before.records[&version1.id].versions[&1].clone();
        let version_path = store.root.join(OBJECTS).join(&leaf);
        let version_bytes = std::fs::read(&version_path).unwrap();
        let version_time = std::fs::metadata(&version_path)
            .unwrap()
            .modified()
            .unwrap();
        let moved = store
            .move_node(
                &version1.id,
                "one",
                version1.nodes[0].position,
                WorkflowPosition { x: 100.0, y: 200.0 },
            )
            .unwrap();
        assert_eq!(moved.revision, version1.revision);
        let after = catalog(&directory).unwrap().unwrap();
        assert_eq!(
            after.records[&version1.id].versions,
            before.records[&version1.id].versions
        );
        assert_ne!(
            after.records[&version1.id].draft,
            before.records[&version1.id].draft
        );
        assert_eq!(std::fs::read(&version_path).unwrap(), version_bytes);
        assert_eq!(
            std::fs::metadata(&version_path)
                .unwrap()
                .modified()
                .unwrap(),
            version_time
        );
        assert_eq!(
            std::fs::read(store.root.join(LIBRARY)).unwrap(),
            FENCE_BYTES
        );
        assert_eq!(store.capacity().unwrap().backend, "immutable_objects");
        assert!(!store.migrate_storage().unwrap().migrated);
        let latest = store
            .update_metadata(&moved.id, moved.revision, "Latest", "", None)
            .unwrap();
        store.rollback_storage().unwrap();
        assert_eq!(store.storage_backend().unwrap(), "legacy_json");
        assert_eq!(store.read(&latest.id).unwrap(), latest);
        assert_eq!(store.read_saved(&version1.id, Some(1)).unwrap(), version1);
        assert_eq!(std::fs::read(store.root.join(&backup)).unwrap(), original);
    }
    #[test]
    fn interruption_and_corruption_never_activate_or_fall_back_to_wrong_backend() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let definition = saved(&store, "Retained");
        let directory = store.open(false).unwrap().unwrap();
        let objects = directory.open_child(OsStr::new(OBJECTS), true).unwrap();
        objects
            .atomic_replace(OsStr::new("interrupted.json"), b"partial staged object")
            .unwrap();
        assert_eq!(store.read(&definition.id).unwrap(), definition);
        assert_eq!(store.storage_backend().unwrap(), "legacy_json");
        store.migrate_storage().unwrap();
        assert!(!store.root.join(OBJECTS).join("interrupted.json").exists());
        directory
            .atomic_replace(OsStr::new(CATALOG), b"bad active catalog")
            .unwrap();
        assert!(
            store
                .read(&definition.id)
                .unwrap_err()
                .to_string()
                .contains("workflow_corrupt")
        );
        assert!(store.rollback_storage().is_err());
        assert!(store.root.join(LIBRARY).exists());
    }
    #[test]
    fn corrupt_legacy_and_missing_pinned_versions_fail_preflight_without_switch() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let definition = saved(&store, "Retained");
        let directory = store.open(false).unwrap().unwrap();
        let original = std::fs::read(store.root.join(LIBRARY)).unwrap();
        directory
            .atomic_replace(OsStr::new(LIBRARY), b"bad legacy")
            .unwrap();
        assert!(store.migrate_storage().is_err());
        assert!(!store.root.join(CATALOG).exists());
        assert_eq!(
            std::fs::read(store.root.join(LIBRARY)).unwrap(),
            b"bad legacy"
        );
        directory
            .atomic_replace(OsStr::new(LIBRARY), &original)
            .unwrap();
        let parent = store.create("Parent", "").unwrap();
        let reference: WorkflowNode = serde_json::from_value(serde_json::json!({"id":"child","title":"Child","kind":"subworkflow","config":{"subworkflow":{"definitionId":definition.id,"version":2,"arguments":{}}}})).unwrap();
        store
            .upsert_node(&parent.id, parent.revision, reference)
            .unwrap();
        assert!(
            store
                .migrate_storage()
                .unwrap_err()
                .to_string()
                .contains("missing pinned subworkflow")
        );
        assert!(!store.root.join(CATALOG).exists());
        assert!(
            store
                .delete(&definition.id, definition.revision)
                .unwrap_err()
                .to_string()
                .contains("workflow_referenced")
        );
    }
    #[test]
    fn different_definitions_commit_without_rewriting_each_others_objects() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let left = saved(&store, "Left");
        let right = saved(&store, "Right");
        store.migrate_storage().unwrap();
        let a = store.clone();
        let left_id = left.id.clone();
        let b = store.clone();
        let right_id = right.id.clone();
        let t1 = std::thread::spawn(move || {
            a.update_metadata(&left_id, left.revision, "Left edited", "", None)
        });
        let t2 = std::thread::spawn(move || {
            b.update_metadata(&right_id, right.revision, "Right edited", "", None)
        });
        t1.join().unwrap().unwrap();
        t2.join().unwrap().unwrap();
        assert_eq!(store.read(&left.id).unwrap().title, "Left edited");
        assert_eq!(store.read(&right.id).unwrap().title, "Right edited");
        assert_eq!(store.read_saved(&left.id, Some(1)).unwrap(), left);
        assert_eq!(store.read_saved(&right.id, Some(1)).unwrap(), right);
    }
    #[test]
    fn retained_backup_budget_rejects_migration_without_destroying_source_or_history() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let definition = saved(&store, "Backup quota");
        let directory = store.open(false).unwrap().unwrap();
        let file = directory
            .open_read_write_file(OsStr::new("library.pre-objects-existing.json"), true)
            .unwrap();
        file.set_len(MAX_BACKUP_BYTES as u64).unwrap();
        file.sync_all().unwrap();
        let capacity = store.capacity().unwrap();
        assert_eq!(capacity.backup_bytes, MAX_BACKUP_BYTES);
        assert!(capacity.near_limit);
        assert!(
            store
                .migrate_storage()
                .unwrap_err()
                .to_string()
                .contains("migration backups")
        );
        assert_eq!(store.storage_backend().unwrap(), "legacy_json");
        assert_eq!(
            store.read_saved(&definition.id, Some(1)).unwrap(),
            definition
        );
        assert_eq!(
            std::fs::metadata(store.root.join("library.pre-objects-existing.json"))
                .unwrap()
                .len(),
            MAX_BACKUP_BYTES as u64
        );
    }
    #[test]
    fn old_writer_is_fenced_before_it_can_mutate_and_external_fence_breaks_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let definition = saved(&store, "Fenced");
        let original = std::fs::read(store.root.join(LIBRARY)).unwrap();
        let result = store.migrate_storage().unwrap();
        let source = std::fs::read(store.root.join(LIBRARY)).unwrap();
        let old: serde_json::Value = serde_json::from_slice(&source).unwrap();
        assert_eq!(old["formatVersion"], u32::MAX);
        assert!(!matches!(old["formatVersion"].as_u64(), Some(1 | 2)));
        // The old transaction obtains the same lease, then rejects its fresh source before writing.
        let directory = store.open(false).unwrap().unwrap();
        assert!(load_legacy(&directory).is_err());
        assert_eq!(source, FENCE_BYTES);
        assert_eq!(
            std::fs::read(store.root.join(result.legacy_backup.unwrap())).unwrap(),
            original
        );
        assert_eq!(store.read(&definition.id).unwrap(), definition);
        directory
            .atomic_replace(OsStr::new(LIBRARY), &original)
            .unwrap();
        assert!(
            store
                .read(&definition.id)
                .unwrap_err()
                .to_string()
                .contains("fence_broken")
        );
        assert!(
            store
                .update_metadata(
                    &definition.id,
                    definition.revision,
                    "Must not commit",
                    "",
                    None
                )
                .is_err()
        );
        directory
            .atomic_replace(OsStr::new(LIBRARY), FENCE_BYTES)
            .unwrap();
        assert_eq!(store.read(&definition.id).unwrap(), definition);
    }
    #[test]
    fn fenced_migration_interruption_reads_backup_and_recovers_exact_prepared_catalog() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let definition = saved(&store, "Interrupted fence");
        let directory = store.open(false).unwrap().unwrap();
        let library = load_legacy(&directory).unwrap();
        let source = leaf_bytes(&directory, LIBRARY).unwrap();
        let backup = "library.pre-objects-interrupted.json";
        directory
            .atomic_replace(OsStr::new(backup), &source)
            .unwrap();
        let (prepared, _) = prepare(
            &directory,
            &library,
            Some(digest(FENCE_BYTES)),
            Some(backup.into()),
        )
        .unwrap();
        directory
            .atomic_replace(OsStr::new(PREPARED), &prepared)
            .unwrap();
        let journal = Transition {
            mode: "migrate".into(),
            legacy_backup: Some(backup.into()),
            source_sha256: digest(&source),
            prepared_sha256: digest(&prepared),
            source_catalog_sha256: None,
        };
        directory
            .atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal).unwrap())
            .unwrap();
        directory
            .atomic_replace(OsStr::new(LIBRARY), FENCE_BYTES)
            .unwrap();
        assert!(!store.root.join(CATALOG).exists());
        assert_eq!(store.read(&definition.id).unwrap(), definition);
        let recovered = store.migrate_storage().unwrap();
        assert!(recovered.migrated);
        assert_eq!(recovered.legacy_backup.as_deref(), Some(backup));
        assert_eq!(store.storage_backend().unwrap(), "immutable_objects");
        assert_eq!(
            store.read_saved(&definition.id, Some(1)).unwrap(),
            definition
        );
    }
    #[test]
    fn rollback_interruption_after_legacy_export_is_recoverable_without_losing_new_edits() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let definition = saved(&store, "Rollback interrupted");
        store.migrate_storage().unwrap();
        let latest = store
            .update_metadata(&definition.id, definition.revision, "Latest edit", "", None)
            .unwrap();
        let directory = store.open(false).unwrap().unwrap();
        let mut library = super::super::load(&directory).unwrap();
        history::restore_for_legacy(&directory, &mut library).unwrap();
        legacy::stage_checks(&directory, &library).unwrap();
        let prepared = legacy::compatible_bytes(&library).unwrap();
        directory
            .atomic_replace(OsStr::new(PREPARED_LEGACY), &prepared)
            .unwrap();
        let journal = Transition {
            mode: "rollback".into(),
            legacy_backup: None,
            source_sha256: digest(&leaf_bytes(&directory, CATALOG).unwrap()),
            prepared_sha256: digest(&prepared),
            source_catalog_sha256: None,
        };
        directory
            .atomic_replace(OsStr::new(JOURNAL), &serde_json::to_vec(&journal).unwrap())
            .unwrap();
        directory
            .atomic_replace(OsStr::new(LIBRARY), &prepared)
            .unwrap();
        assert_eq!(store.read(&latest.id).unwrap(), latest);
        store.rollback_storage().unwrap();
        assert_eq!(store.storage_backend().unwrap(), "legacy_json");
        assert_eq!(store.read(&latest.id).unwrap(), latest);
        assert_eq!(
            store.read_saved(&definition.id, Some(1)).unwrap(),
            definition
        );
    }
}
