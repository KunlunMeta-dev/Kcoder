//! Account-scoped workflow library. One bounded transaction file atomically owns
//! drafts and immutable saved versions; the caller supplies the authorized root.
use anyhow::{ensure, Context, Result};
use kcoder_config::PrivateDirectory;
use kcoder_types::workflow::{
    WorkflowDefinition, WorkflowNode, WorkflowStatus, WorkflowSummary, WorkflowVersionSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_WORKFLOWS: usize = 256;
pub const MAX_SAVED_VERSIONS: usize = 32;
pub const MAX_LIBRARY_BYTES: usize = 8 * 1024 * 1024;
const LIBRARY: &str = "library.json";
const LOCK: &str = "library.lock";

// Explicit unlock also releases a briefly inherited Unix open-file description
// during an unrelated fork; relying only on close can retain the lock until exec.
struct Lease(File);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[derive(Debug, Clone)]
pub struct WorkflowStore {
    root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Library {
    format_version: u32,
    records: BTreeMap<String, Record>,
}
impl Default for Library {
    fn default() -> Self {
        Self {
            format_version: 1,
            records: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    draft: WorkflowDefinition,
    versions: BTreeMap<u64, WorkflowDefinition>,
}

impl WorkflowStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn create(&self, title: &str, description: &str) -> Result<WorkflowDefinition> {
        self.transaction(|library| {
            ensure!(
                library.records.len() < MAX_WORKFLOWS,
                "workflow_quota: library is limited to {MAX_WORKFLOWS} workflows"
            );
            let now = now_ms()?;
            let definition = WorkflowDefinition {
                input_schema: None,
                id: uuid::Uuid::new_v4().to_string(),
                title: title.trim().into(),
                description: description.into(),
                revision: 1,
                status: WorkflowStatus::Draft,
                nodes: Vec::new(),
                created_at_ms: now,
                updated_at_ms: now,
                saved_version: None,
            };
            crate::graph::validate(&definition, false)?;
            library.records.insert(
                definition.id.clone(),
                Record {
                    draft: definition.clone(),
                    versions: BTreeMap::new(),
                },
            );
            Ok(definition)
        })
    }

    pub fn read(&self, id: &str) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        let library = self.read_library()?;
        Ok(find(&library, id)?.draft.clone())
    }

    pub fn list(&self) -> Result<Vec<WorkflowSummary>> {
        let library = self.read_library()?;
        let mut summaries: Vec<_> = library
            .records
            .values()
            .map(|record| WorkflowSummary::from(&record.draft))
            .collect();
        summaries.sort_by(|left, right| {
            right
                .updated_at_ms
                .cmp(&left.updated_at_ms)
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(summaries)
    }

    pub fn upsert_node(
        &self,
        id: &str,
        expected_revision: u64,
        mut node: WorkflowNode,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            if let Some(existing) = record
                .draft
                .nodes
                .iter_mut()
                .find(|item| item.id == node.id)
            {
                if *existing == node {
                    return Ok(record.draft.clone());
                }
                *existing = node;
            } else {
                // Model-created nodes omit position and start at (0, 0). Place
                // new collisions on a free grid without moving existing nodes.
                if record
                    .draft
                    .nodes
                    .iter()
                    .any(|existing| existing.position == node.position)
                {
                    for slot in 0..=crate::graph::MAX_NODES {
                        let position = kcoder_types::workflow::WorkflowPosition {
                            x: (slot % 4) as f64 * 260.0,
                            y: (slot / 4) as f64 * 140.0,
                        };
                        if !record
                            .draft
                            .nodes
                            .iter()
                            .any(|existing| existing.position == position)
                        {
                            node.position = position;
                            break;
                        }
                    }
                }
                record.draft.nodes.push(node);
            }
            touch(&mut record.draft)?;
            crate::graph::validate(&record.draft, false)?;
            Ok(record.draft.clone())
        })
    }

    pub fn remove_node(
        &self,
        id: &str,
        expected_revision: u64,
        node_id: &str,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        crate::graph::validate_id(node_id)?;
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            ensure!(
                record.draft.nodes.iter().any(|node| node.id == node_id),
                "workflow_not_found: node {node_id}"
            );
            record.draft.nodes.retain(|node| node.id != node_id);
            // A removed node cannot leave invisible edges behind in the editor.
            for node in &mut record.draft.nodes {
                node.depends_on.retain(|dependency| dependency != node_id);
            }
            touch(&mut record.draft)?;
            Ok(record.draft.clone())
        })
    }

    pub fn save(&self, id: &str, expected_revision: u64) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            crate::graph::validate(&record.draft, true)?;
            if record.draft.status == WorkflowStatus::Saved { return Ok(record.draft.clone()); }
            ensure!(record.versions.len() < MAX_SAVED_VERSIONS, "workflow_quota: at most {MAX_SAVED_VERSIONS} saved versions; existing versions were retained");
            let version = record.versions.last_key_value().map_or(1, |(version, _)| version + 1);
            touch(&mut record.draft)?;
            record.draft.status = WorkflowStatus::Saved;
            record.draft.saved_version = Some(version);
            // Refuse definitions whose encoded script cannot fit the existing runtime.
            // This is compilation only; saving never executes agents or other effects.
            if !crate::graph::is_rich(&record.draft) { crate::graph::compile(&record.draft, serde_json::Value::Null)?; }
            record.versions.insert(version, record.draft.clone());
            Ok(record.draft.clone())
        })
    }

    pub fn read_saved(&self, id: &str, version: Option<u64>) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        let library = self.read_library()?;
        let record = find(&library, id)?;
        let version = version
            .or(record.draft.saved_version)
            .context("workflow_unsaved: this workflow has no saved version")?;
        record
            .versions
            .get(&version)
            .cloned()
            .with_context(|| format!("workflow_not_found: saved version {version}"))
    }

    /// Metadata edits are draft changes, even when only the input contract changes.
    pub fn update_metadata(
        &self,
        id: &str,
        expected_revision: u64,
        title: &str,
        description: &str,
        input_schema: Option<serde_json::Value>,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            record.draft.title = title.trim().into();
            record.draft.description = description.into();
            record.draft.input_schema = input_schema;
            touch(&mut record.draft)?;
            crate::graph::validate(&record.draft, false)?;
            Ok(record.draft.clone())
        })
    }

    pub fn versions(&self, id: &str) -> Result<Vec<WorkflowVersionSummary>> {
        crate::graph::validate_id(id)?;
        let library = self.read_library()?;
        Ok(find(&library, id)?
            .versions
            .iter()
            .rev()
            .map(|(version, definition)| WorkflowVersionSummary {
                version: *version,
                revision: definition.revision,
                title: definition.title.clone(),
                node_count: definition.nodes.len(),
                saved_at_ms: definition.updated_at_ms,
            })
            .collect())
    }

    pub fn export(&self, id: &str, version: Option<u64>) -> Result<WorkflowDefinition> {
        if let Some(version) = version {
            self.read_saved(id, Some(version))
        } else {
            self.read(id)
        }
    }

    pub fn clone_workflow(
        &self,
        id: &str,
        version: Option<u64>,
        title: Option<&str>,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        self.transaction(|library| {
            let record = find(library, id)?;
            let mut definition = if let Some(version) = version {
                record
                    .versions
                    .get(&version)
                    .cloned()
                    .context("workflow_not_found: saved version")?
            } else {
                record.draft.clone()
            };
            if let Some(title) = title {
                definition.title = title.trim().into();
            }
            insert_copy(library, definition)
        })
    }

    /// Import never overwrites a known ID, revision or saved version.
    pub fn import(&self, definition: WorkflowDefinition) -> Result<WorkflowDefinition> {
        self.transaction(|library| insert_copy(library, definition))
    }

    fn open(&self, create: bool) -> Result<Option<PrivateDirectory>> {
        ensure!(
            self.root.is_absolute(),
            "workflow_path: library root must be absolute"
        );
        let result = if create {
            PrivateDirectory::open_or_create(&self.root)
        } else {
            PrivateDirectory::open_existing(&self.root)
        };
        match result {
            Ok(directory) => Ok(Some(directory)),
            Err(error) if !create && not_found(&error) => Ok(None),
            Err(error) => {
                Err(error).context("workflow_storage: cannot open private library directory")
            }
        }
    }

    fn read_library(&self) -> Result<Library> {
        let Some(directory) = self.open(false)? else {
            return Ok(Library::default());
        };
        let _lease = Lease(
            directory
                .try_shared_lock(OsStr::new(LOCK))?
                .context("workflow_busy: another process is updating this library; retry")?,
        );
        load(&directory)
    }

    fn transaction(
        &self,
        mutate: impl FnOnce(&mut Library) -> Result<WorkflowDefinition>,
    ) -> Result<WorkflowDefinition> {
        let directory = self.open(true)?.expect("create opens a directory");
        let _lease = Lease(
            directory
                .try_exclusive_lock(OsStr::new(LOCK))?
                .context("workflow_busy: another process owns the library; retry")?,
        );
        let mut library = load(&directory)?;
        let result = mutate(&mut library)?;
        if library.records.values().any(|record| {
            crate::graph::is_rich(&record.draft)
                || record.versions.values().any(crate::graph::is_rich)
        }) {
            library.format_version = 2;
        }
        validate_library(&library)?;
        let bytes = serde_json::to_vec(&library)?;
        ensure!(
            bytes.len() <= MAX_LIBRARY_BYTES,
            "workflow_quota: library exceeds {MAX_LIBRARY_BYTES} bytes; prior drafts and versions were retained"
        );
        directory
            .atomic_replace(OsStr::new(LIBRARY), &bytes)
            .context("workflow_storage: atomic commit was not confirmed; reload before retrying")?;
        Ok(result)
    }
}

fn insert_copy(
    library: &mut Library,
    mut definition: WorkflowDefinition,
) -> Result<WorkflowDefinition> {
    ensure!(
        library.records.len() < MAX_WORKFLOWS,
        "workflow_quota: library is full"
    );
    definition.id = uuid::Uuid::new_v4().to_string();
    definition.revision = 1;
    definition.status = WorkflowStatus::Draft;
    definition.saved_version = None;
    definition.created_at_ms = now_ms()?;
    definition.updated_at_ms = definition.created_at_ms;
    crate::graph::validate(&definition, false)?;
    library.records.insert(
        definition.id.clone(),
        Record {
            draft: definition.clone(),
            versions: BTreeMap::new(),
        },
    );
    Ok(definition)
}

fn load(directory: &PrivateDirectory) -> Result<Library> {
    let file = match directory.open_regular_file(OsStr::new(LIBRARY)) {
        Ok(file) => file,
        Err(error) if not_found(&error) => return Ok(Library::default()),
        Err(error) => {
            return Err(error)
                .context("workflow_storage: library must be a regular non-symlink file");
        }
    };
    let bytes = bounded_read(file)?;
    let library: Library =
        serde_json::from_slice(&bytes).context("workflow_corrupt: invalid library JSON")?;
    validate_library(&library)?;
    Ok(library)
}
fn bounded_read(file: File) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() <= MAX_LIBRARY_BYTES as u64,
        "workflow_quota: library file is too large"
    );
    let mut bytes = Vec::new();
    file.take((MAX_LIBRARY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_LIBRARY_BYTES,
        "workflow_quota: library grew beyond its size limit"
    );
    Ok(bytes)
}
fn validate_library(library: &Library) -> Result<()> {
    ensure!(
        matches!(library.format_version, 1 | 2),
        "workflow_corrupt: unsupported library format version"
    );
    ensure!(
        library.records.len() <= MAX_WORKFLOWS,
        "workflow_quota: too many workflows"
    );
    for (id, record) in &library.records {
        crate::graph::validate(&record.draft, false)?;
        ensure!(
            &record.draft.id == id,
            "workflow_corrupt: workflow ID mismatch"
        );
        ensure!(
            record.versions.len() <= MAX_SAVED_VERSIONS,
            "workflow_quota: too many saved versions"
        );
        ensure!(
            record.draft.saved_version
                == record
                    .versions
                    .last_key_value()
                    .map(|(version, _)| *version),
            "workflow_corrupt: saved version pointer mismatch"
        );
        for (index, (version, definition)) in record.versions.iter().enumerate() {
            ensure!(
                *version == index as u64 + 1
                    && definition.saved_version == Some(*version)
                    && definition.status == WorkflowStatus::Saved
                    && definition.id == *id
                    && definition.revision <= record.draft.revision,
                "workflow_corrupt: invalid saved snapshot"
            );
            crate::graph::validate(definition, true)?;
        }
        if record.draft.status == WorkflowStatus::Saved {
            ensure!(
                record
                    .versions
                    .last_key_value()
                    .is_some_and(|(_, saved)| saved == &record.draft),
                "workflow_corrupt: saved draft differs from its immutable snapshot"
            );
        }
    }
    Ok(())
}
fn find<'a>(library: &'a Library, id: &str) -> Result<&'a Record> {
    library
        .records
        .get(id)
        .with_context(|| format!("workflow_not_found: {id}"))
}
fn find_mut<'a>(library: &'a mut Library, id: &str, revision: u64) -> Result<&'a mut Record> {
    let record = library
        .records
        .get_mut(id)
        .with_context(|| format!("workflow_not_found: {id}"))?;
    ensure!(
        record.draft.revision == revision,
        "workflow_conflict: expected revision {revision}, current revision {}; reload before editing",
        record.draft.revision
    );
    Ok(record)
}
fn touch(definition: &mut WorkflowDefinition) -> Result<()> {
    definition.revision = definition
        .revision
        .checked_add(1)
        .context("workflow_quota: revision exhausted")?;
    definition.updated_at_ms = now_ms()?.max(definition.updated_at_ms.saturating_add(1));
    definition.status = WorkflowStatus::Draft;
    Ok(())
}
fn now_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("workflow_storage: system clock is before epoch")?
        .as_millis()
        .try_into()?)
}
fn not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::workflow::WorkflowPosition;

    fn node(id: &str, deps: &[&str]) -> WorkflowNode {
        WorkflowNode {
            kind: Default::default(),
            config: Default::default(),
            run_if: None,
            id: id.into(),
            title: id.into(),
            prompt: format!("Perform {id}"),
            agent_type: "general".into(),
            max_turns: 3,
            depends_on: deps.iter().map(|id| (*id).into()).collect(),
            position: WorkflowPosition::default(),
            allowed_write_paths: vec![],
            acceptance_criteria: vec![],
            expected_artifacts: vec![],
        }
    }
    fn store(temp: &tempfile::TempDir) -> WorkflowStore {
        WorkflowStore::new(temp.path().canonicalize().unwrap().join("workflows"))
    }

    #[test]
    fn management_preserves_snapshots_and_imports_new_identity() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Original", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("work", &[]))
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let schema = serde_json::json!({"type":"object","required":["name"]});
        let edited = store
            .update_metadata(
                &saved.id,
                saved.revision,
                "Changed",
                "Description",
                Some(schema.clone()),
            )
            .unwrap();
        assert!(store
            .update_metadata(&saved.id, saved.revision, "Stale", "", None)
            .is_err());
        assert_eq!(store.read_saved(&saved.id, Some(1)).unwrap(), saved);
        assert_eq!(store.read(&saved.id).unwrap().input_schema, Some(schema));
        let second = store.save(&edited.id, edited.revision).unwrap();
        assert_eq!(
            store
                .versions(&saved.id)
                .unwrap()
                .iter()
                .map(|v| v.version)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        let cloned = store
            .clone_workflow(&saved.id, Some(1), Some("Copy"))
            .unwrap();
        assert_ne!(cloned.id, saved.id);
        assert_eq!(cloned.title, "Copy");
        assert_eq!(cloned.status, WorkflowStatus::Draft);
        assert_eq!(cloned.saved_version, None);
        assert_eq!(cloned.input_schema, None);
        let imported = store
            .import(store.export(&saved.id, Some(2)).unwrap())
            .unwrap();
        assert_ne!(imported.id, saved.id);
        assert_eq!(imported.revision, 1);
        assert_eq!(imported.saved_version, None);
        assert_eq!(imported.nodes, second.nodes);
        assert_eq!(store.read_saved(&saved.id, Some(1)).unwrap(), saved);
    }

    #[test]
    fn node_drafts_publish_immutable_versions_across_reopened_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        assert!(store.list().unwrap().is_empty());
        assert!(!store.root.exists());
        let draft = store.create("Build project", "A portable DAG").unwrap();
        assert!(store
            .save(&draft.id, draft.revision)
            .unwrap_err()
            .to_string()
            .contains("at least one node"));
        let mut incomplete = node("consumer", &["producer"]);
        incomplete.prompt.clear();
        let draft = store
            .upsert_node(&draft.id, draft.revision, incomplete)
            .unwrap();
        assert!(store.save(&draft.id, draft.revision).is_err());
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("consumer", &["producer"]))
            .unwrap();
        assert!(store
            .save(&draft.id, draft.revision)
            .unwrap_err()
            .to_string()
            .contains("unknown dependency"));
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("producer", &[]))
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        assert_eq!(saved.saved_version, Some(1));
        let reopened = WorkflowStore::new(store.root.clone());
        assert_eq!(reopened.read_saved(&saved.id, None).unwrap(), saved);
        let mut changed = node("producer", &[]);
        changed.prompt = "Changed instruction".into();
        let edited = reopened
            .upsert_node(&saved.id, saved.revision, changed)
            .unwrap();
        assert_eq!(edited.status, WorkflowStatus::Draft);
        assert_eq!(edited.saved_version, Some(1));
        assert_eq!(reopened.read_saved(&saved.id, Some(1)).unwrap(), saved);
        let next = reopened.save(&edited.id, edited.revision).unwrap();
        assert_eq!(next.saved_version, Some(2));
        assert_eq!(reopened.read_saved(&saved.id, Some(1)).unwrap(), saved);
        let removed = reopened
            .remove_node(&next.id, next.revision, "producer")
            .unwrap();
        assert!(removed.nodes[0].depends_on.is_empty());
        assert_eq!(reopened.read_saved(&next.id, None).unwrap(), next);
        assert_eq!(reopened.list().unwrap()[0].node_count, 1);
    }

    #[test]
    fn new_default_positions_do_not_overlap_and_existing_drag_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let first = store.create("Canvas", "").unwrap();
        let first = store
            .upsert_node(&first.id, first.revision, node("a", &[]))
            .unwrap();
        let second = store
            .upsert_node(&first.id, first.revision, node("b", &[]))
            .unwrap();
        assert_ne!(second.nodes[0].position, second.nodes[1].position);
        assert_eq!(
            second.nodes[1].position,
            WorkflowPosition { x: 260.0, y: 0.0 }
        );
        let mut dragged = second.nodes[0].clone();
        dragged.position = WorkflowPosition { x: 17.5, y: -42.0 };
        let moved = store
            .upsert_node(&second.id, second.revision, dragged.clone())
            .unwrap();
        let third = store
            .upsert_node(&moved.id, moved.revision, node("c", &[]))
            .unwrap();
        assert_eq!(third.nodes[0].position, dragged.position);
        assert_eq!(store.read(&third.id).unwrap(), third);
    }

    #[test]
    fn validation_and_conflicts_leave_committed_library_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Validate", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("a", &["b"]))
            .unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("b", &["a"]))
            .unwrap();
        let before = std::fs::read(store.root.join(LIBRARY)).unwrap();
        assert!(store
            .save(&draft.id, draft.revision)
            .unwrap_err()
            .to_string()
            .contains("cycle"));
        assert!(store
            .upsert_node(&draft.id, 1, node("new", &[]))
            .unwrap_err()
            .to_string()
            .contains("workflow_conflict"));
        let mut oversized = node("new", &[]);
        oversized.prompt = "x".repeat(16385);
        assert!(store
            .upsert_node(&draft.id, draft.revision, oversized)
            .is_err());
        assert_eq!(std::fs::read(store.root.join(LIBRARY)).unwrap(), before);
        for invalid in ["../outside", "/tmp/outside", "a/b", "a\\b", "", ".", ".."] {
            assert!(store.read(invalid).is_err());
            assert!(store.save(invalid, 1).is_err());
        }
    }

    #[test]
    fn version_and_library_byte_quotas_preserve_previous_data() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let mut current = store.create("Versions", "").unwrap();
        for version in 1..=MAX_SAVED_VERSIONS {
            let mut update = node("a", &[]);
            update.prompt = format!("Version {version}");
            current = store
                .upsert_node(&current.id, current.revision, update)
                .unwrap();
            current = store.save(&current.id, current.revision).unwrap();
        }
        let first = store.read_saved(&current.id, Some(1)).unwrap();
        let mut update = node("a", &[]);
        update.prompt = "quota overflow".into();
        current = store
            .upsert_node(&current.id, current.revision, update)
            .unwrap();
        let before = std::fs::read(store.root.join(LIBRARY)).unwrap();
        assert!(store
            .save(&current.id, current.revision)
            .unwrap_err()
            .to_string()
            .contains("workflow_quota"));
        assert_eq!(std::fs::read(store.root.join(LIBRARY)).unwrap(), before);
        assert_eq!(store.read_saved(&current.id, Some(1)).unwrap(), first);
        let file = File::options()
            .write(true)
            .open(store.root.join(LIBRARY))
            .unwrap();
        file.set_len((MAX_LIBRARY_BYTES + 1) as u64).unwrap();
        assert!(store
            .list()
            .unwrap_err()
            .to_string()
            .contains("workflow_quota"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_library_directory_file_and_lock_are_refused() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Links", "").unwrap();
        let outside = temp.path().join("outside.json");
        std::fs::rename(store.root.join(LIBRARY), &outside).unwrap();
        let before = std::fs::read(&outside).unwrap();
        symlink(&outside, store.root.join(LIBRARY)).unwrap();
        assert!(store.read(&draft.id).is_err());
        assert!(store.create("Unsafe", "").is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), before);
        std::fs::remove_file(store.root.join(LIBRARY)).unwrap();
        std::fs::rename(&outside, store.root.join(LIBRARY)).unwrap();
        std::fs::remove_file(store.root.join(LOCK)).unwrap();
        std::fs::write(&outside, "sentinel").unwrap();
        symlink(&outside, store.root.join(LOCK)).unwrap();
        assert!(store.create("Unsafe", "").is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "sentinel");
        let link = temp.path().join("linked-root");
        symlink(&store.root, &link).unwrap();
        assert!(WorkflowStore::new(link).list().is_err());
    }

    #[test]
    fn cross_process_edit_worker() {
        let Some(root) = std::env::var_os("KCODER_WORKFLOW_TEST_ROOT") else {
            return;
        };
        let id = std::env::var("KCODER_WORKFLOW_TEST_ID").unwrap();
        let result =
            WorkflowStore::new(PathBuf::from(root)).upsert_node(&id, 1, node("worker", &[]));
        let exit = match result {
            Ok(_) => 0,
            Err(error)
                if error.to_string().contains("workflow_busy")
                    || error.to_string().contains("workflow_conflict") =>
            {
                23
            }
            Err(_) => 24,
        };
        std::process::exit(exit);
    }

    #[test]
    fn concurrent_processes_cannot_both_commit_the_same_revision() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Concurrent", "").unwrap();
        let launch = || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "store::tests::cross_process_edit_worker",
                    "--nocapture",
                ])
                .env("KCODER_WORKFLOW_TEST_ROOT", &store.root)
                .env("KCODER_WORKFLOW_TEST_ID", &draft.id)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        };
        let mut left = launch();
        let mut right = launch();
        let statuses = [left.wait().unwrap().code(), right.wait().unwrap().code()];
        assert_eq!(
            statuses.iter().filter(|status| **status == Some(0)).count(),
            1
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == Some(23))
                .count(),
            1
        );
        assert_eq!(store.read(&draft.id).unwrap().revision, 2);
    }
}
