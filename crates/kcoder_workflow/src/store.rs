//! Account-scoped workflow library with bounded legacy JSON or explicitly migrated
//! immutable objects. The caller supplies the authorized profile root.
use anyhow::{Context, Result, ensure};
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_WORKFLOWS: usize = 256;
pub const MAX_SAVED_VERSIONS: usize = 32;
pub const MAX_LIBRARY_BYTES: usize = 8 * 1024 * 1024;
const LIBRARY: &str = "library.json";
const LOCK: &str = "library.lock";
#[path = "store_history.rs"]
mod history;
pub use history::{
    HistoricalVersion, RunReferenceState, VersionCleanup, VersionPin, VersionReferences,
    VersionRunReference,
};
#[path = "store_legacy.rs"]
mod legacy;
#[path = "store_shards.rs"]
mod shards;
pub use shards::StorageMigration;
#[path = "store_verification.rs"]
mod verification;
pub use verification::{
    RuntimeVerification, StaticVerification, ToolContractVerification, VersionVerification,
    WorkflowScenarioRequest, WorkflowScenarioVerification, definition_fingerprint,
};

// Explicit unlock also releases a briefly inherited Unix open-file description
// during an unrelated fork; relying only on close can retain the lock until exec.
struct Lease(File);
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

/// Capacity counts and byte budgets are separate; history is never auto-pruned.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCapacity {
    pub backend: String,
    pub workflow_count: usize,
    pub workflow_limit: usize,
    pub saved_version_count: usize,
    pub saved_version_bytes: usize,
    pub version_bytes: BTreeMap<String, usize>,
    pub backup_bytes: usize,
    pub backup_byte_limit: usize,
    pub history_bytes: usize,
    pub history_byte_limit: usize,
    pub versions_per_workflow_limit: usize,
    pub used_bytes: usize,
    pub byte_limit: usize,
    pub near_limit: bool,
    pub versions: BTreeMap<String, usize>,
}

fn library_lease(directory: &PrivateDirectory, exclusive: bool) -> Result<Lease> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let lock = if exclusive {
            directory.try_exclusive_lock(OsStr::new(LOCK))?
        } else {
            directory.try_shared_lock(OsStr::new(LOCK))?
        };
        if let Some(file) = lock {
            return Ok(Lease(file));
        }
        ensure!(
            Instant::now() < deadline,
            "workflow_busy: library lock timed out after bounded wait; reload before retrying an unconfirmed write"
        );
        std::thread::sleep(Duration::from_millis(10));
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    layout_changes: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    static_checks: BTreeMap<u64, StaticVerification>,
}

impl WorkflowStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn capacity(&self) -> Result<LibraryCapacity> {
        let (library, used_bytes, shard_versions, backup_bytes, backend, history_bytes) =
            match self.open(false)? {
                Some(directory) => {
                    let _lease = library_lease(&directory, false)?;
                    let library = load(&directory)?;
                    let shard_bytes = shards::usage(&directory)?;
                    let used_bytes = match shard_bytes {
                        Some(bytes) => bytes,
                        None => legacy::usage(&directory, &library)?,
                    };
                    let backend = if shard_bytes.is_some() {
                        "immutable_objects"
                    } else {
                        "legacy_json"
                    };
                    (
                        library,
                        used_bytes,
                        shards::version_usage(&directory)?,
                        shards::backup_usage(&directory)?,
                        backend,
                        history::usage(&directory)?,
                    )
                }
                None => (Library::default(), 0, None, 0, "legacy_json", 0),
            };
        let versions: BTreeMap<_, _> = library
            .records
            .iter()
            .map(|(id, record)| (id.clone(), record.versions.len()))
            .collect();
        let version_bytes = match shard_versions {
            Some(bytes) => bytes,
            None => library
                .records
                .iter()
                .map(|(id, record)| -> Result<_> {
                    let bytes = if record.versions.is_empty() {
                        0
                    } else {
                        serde_json::to_vec(&record.versions)?.len()
                            + serde_json::to_vec(&record.static_checks)?.len()
                    };
                    Ok((id.clone(), bytes))
                })
                .collect::<Result<BTreeMap<_, _>>>()?,
        };
        let workflow_count = library.records.len();
        Ok(LibraryCapacity {
            backend: backend.into(),
            workflow_count,
            workflow_limit: MAX_WORKFLOWS,
            saved_version_count: versions.values().sum(),
            saved_version_bytes: version_bytes.values().sum(),
            version_bytes,
            backup_bytes,
            backup_byte_limit: shards::MAX_BACKUP_BYTES,
            history_bytes,
            history_byte_limit: history::MAX_HISTORY_BYTES,
            versions_per_workflow_limit: MAX_SAVED_VERSIONS,
            used_bytes,
            byte_limit: MAX_LIBRARY_BYTES,
            near_limit: used_bytes >= MAX_LIBRARY_BYTES * 9 / 10
                || workflow_count >= MAX_WORKFLOWS * 9 / 10
                || backup_bytes >= shards::MAX_BACKUP_BYTES * 9 / 10
                || history_bytes >= history::MAX_HISTORY_BYTES * 9 / 10
                || versions
                    .values()
                    .any(|count| *count >= MAX_SAVED_VERSIONS * 9 / 10),
            versions,
        })
    }

    pub fn create(&self, title: &str, description: &str) -> Result<WorkflowDefinition> {
        self.create_with_schema(title, description, None)
    }

    pub fn create_with_schema(
        &self,
        title: &str,
        description: &str,
        input_schema: Option<serde_json::Value>,
    ) -> Result<WorkflowDefinition> {
        self.transaction(|library| {
            ensure!(
                library.records.len() < MAX_WORKFLOWS,
                "workflow_quota: library is limited to {MAX_WORKFLOWS} workflows"
            );
            let now = now_ms()?;
            let definition = WorkflowDefinition {
                input_schema,
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
                    layout_changes: BTreeMap::new(),
                    static_checks: BTreeMap::new(),
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

    /// Remove a library entry atomically; session run artifacts live separately.
    pub fn delete(&self, id: &str, expected_revision: u64) -> Result<()> {
        crate::graph::validate_id(id)?;
        self.transaction(|library| {
            find_mut(library, id, expected_revision)?;
            for (other_id, record) in &library.records {
                if other_id == id { continue; }
                for definition in std::iter::once(&record.draft).chain(record.versions.values()) {
                    ensure!(!definition.nodes.iter().any(|node| node.config.subworkflow.iter()
                        .chain(node.config.r#loop.iter().flat_map(|config| config.body.iter()))
                        .any(|reference| reference.definition_id == id)),
                        "workflow_referenced: {id} is pinned by {other_id}; retained versions cannot be removed");
                }
            }
            library.records.remove(id);
            Ok(())
        })
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

    /// Layout uses position CAS, independently of semantic draft revisions.
    pub fn move_node(
        &self,
        id: &str,
        node_id: &str,
        expected: kcoder_types::workflow::WorkflowPosition,
        position: kcoder_types::workflow::WorkflowPosition,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        ensure!(
            position.x.is_finite()
                && position.y.is_finite()
                && position.x.abs() <= 1_000_000.0
                && position.y.abs() <= 1_000_000.0,
            "workflow_invalid: position must be finite and within the canvas bounds"
        );
        self.transaction(|library| {
            let record = library
                .records
                .get_mut(id)
                .with_context(|| format!("workflow_not_found: {id}"))?;
            let node = record
                .draft
                .nodes
                .iter_mut()
                .find(|node| node.id == node_id)
                .with_context(|| format!("workflow_not_found: node {node_id}"))?;
            if node.position == position {
                return Ok(record.draft.clone());
            }
            ensure!(
                node.position == expected,
                "workflow_layout_conflict: node position changed; reload before moving"
            );
            node.position = position;
            record
                .layout_changes
                .retain(|id, _| record.draft.nodes.iter().any(|node| &node.id == id));
            record
                .layout_changes
                .insert(node_id.into(), record.draft.revision);
            record.draft.updated_at_ms =
                now_ms()?.max(record.draft.updated_at_ms.saturating_add(1));
            Ok(record.draft.clone())
        })
    }

    pub fn upsert_node(
        &self,
        id: &str,
        expected_revision: u64,
        node: WorkflowNode,
    ) -> Result<WorkflowDefinition> {
        self.upsert_node_validated(id, expected_revision, node, |_| Ok(()))
    }
    pub fn upsert_node_validated(
        &self,
        id: &str,
        expected_revision: u64,
        mut node: WorkflowNode,
        validate: impl FnOnce(&WorkflowDefinition) -> Result<()>,
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
                if record.layout_changes.get(&node.id) == Some(&expected_revision) {
                    node.position = existing.position;
                }
                if *existing == node {
                    validate(&record.draft)?;
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
            validate(&record.draft)?;
            Ok(record.draft.clone())
        })
    }

    /// Merge only fields present in model patches, then commit through the same CAS transaction.
    pub fn patch_fields(
        &self,
        id: &str,
        expected_revision: u64,
        patches: Vec<serde_json::Value>,
        remove_node_ids: Vec<String>,
    ) -> Result<WorkflowDefinition> {
        self.patch_fields_validated(id, expected_revision, patches, remove_node_ids, |_| Ok(()))
    }
    pub fn patch_fields_validated(
        &self,
        id: &str,
        expected_revision: u64,
        patches: Vec<serde_json::Value>,
        remove_node_ids: Vec<String>,
        validate: impl FnOnce(&WorkflowDefinition) -> Result<()>,
    ) -> Result<WorkflowDefinition> {
        ensure!(
            patches.len() <= crate::graph::MAX_NODES,
            "workflow_quota: graph patch is too large"
        );
        let snapshot = self.read(id)?;
        ensure!(
            snapshot.revision == expected_revision,
            "workflow_conflict: draft revision changed; read it again"
        );
        let mut nodes = Vec::with_capacity(patches.len());
        for patch in patches {
            let fields = patch
                .as_object()
                .context("workflow_invalid: node patch must be an object")?;
            let node_id = fields
                .get("id")
                .and_then(serde_json::Value::as_str)
                .context("workflow_invalid: node patch requires id")?;
            let mut value = snapshot
                .nodes
                .iter()
                .find(|node| node.id == node_id)
                .map(serde_json::to_value)
                .transpose()?
                .unwrap_or_else(|| serde_json::json!({"id":node_id}));
            let target = value
                .as_object_mut()
                .context("workflow_invalid: node must be an object")?;
            for (key, value) in fields {
                if key == "config" && value.is_object() {
                    let config = target
                        .entry("config")
                        .or_insert_with(|| serde_json::json!({}));
                    let config = config
                        .as_object_mut()
                        .context("workflow_invalid: config must be an object")?;
                    for (name, value) in value.as_object().unwrap() {
                        config.insert(name.clone(), value.clone());
                    }
                } else {
                    target.insert(key.clone(), value.clone());
                }
            }
            nodes.push(
                serde_json::from_value(value).context("workflow_invalid: invalid patched node")?,
            );
        }
        // If another writer changed the snapshot during merging, the existing CAS rejects this edit.
        self.patch_nodes_validated(id, expected_revision, nodes, remove_node_ids, validate)
    }

    /// Apply a complete graph edit under one revision check and disk transaction.
    /// Removed dependencies must be explicitly rewired; never broaden execution silently.
    pub fn patch_nodes(
        &self,
        id: &str,
        expected_revision: u64,
        nodes: Vec<WorkflowNode>,
        remove_node_ids: Vec<String>,
    ) -> Result<WorkflowDefinition> {
        self.patch_nodes_validated(id, expected_revision, nodes, remove_node_ids, |_| Ok(()))
    }
    pub fn patch_nodes_validated(
        &self,
        id: &str,
        expected_revision: u64,
        nodes: Vec<WorkflowNode>,
        remove_node_ids: Vec<String>,
        validate: impl FnOnce(&WorkflowDefinition) -> Result<()>,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        ensure!(
            nodes.len() <= crate::graph::MAX_NODES
                && remove_node_ids.len() <= crate::graph::MAX_NODES,
            "workflow_quota: graph patch is too large"
        );
        let mut touched = std::collections::HashSet::new();
        for node_id in nodes
            .iter()
            .map(|node| &node.id)
            .chain(remove_node_ids.iter())
        {
            crate::graph::validate_id(node_id)?;
            ensure!(
                touched.insert(node_id.clone()),
                "workflow_invalid: duplicate or conflicting patch node {node_id}"
            );
        }
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            let mut next = record.draft.clone();
            for removed in &remove_node_ids {
                ensure!(
                    next.nodes.iter().any(|node| &node.id == removed),
                    "workflow_not_found: node {removed}"
                );
            }
            next.nodes
                .retain(|node| !remove_node_ids.contains(&node.id));
            for mut node in nodes {
                if let Some(existing) = next.nodes.iter_mut().find(|item| item.id == node.id) {
                    if record.layout_changes.get(&node.id) == Some(&expected_revision) {
                        node.position = existing.position;
                    }
                    *existing = node;
                } else {
                    if next.nodes.iter().any(|item| item.position == node.position) {
                        for slot in 0..=crate::graph::MAX_NODES {
                            let position = kcoder_types::workflow::WorkflowPosition {
                                x: (slot % 4) as f64 * 260.0,
                                y: (slot / 4) as f64 * 140.0,
                            };
                            if !next.nodes.iter().any(|item| item.position == position) {
                                node.position = position;
                                break;
                            }
                        }
                    }
                    next.nodes.push(node);
                }
            }
            // Atomic patches must leave any nonempty graph executable, but an
            // empty editing draft is valid. Publishing/running still require nodes.
            crate::graph::validate(&next, !next.nodes.is_empty())?;
            validate(&next)?;
            if next == record.draft {
                return Ok(next);
            }
            touch(&mut next)?;
            record.draft = next.clone();
            Ok(next)
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
            ensure!(
                !record.draft.nodes.iter().any(|node| node.run_if.as_ref().is_some_and(|guard| guard.node_id == node_id)),
                "workflow_invalid: routing node is referenced by runIf; use patch_nodes to rewire or remove its branches atomically"
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
        self.save_with_tool_contracts(id, expected_revision, None)
    }

    pub fn save_with_tool_contracts(
        &self,
        id: &str,
        expected_revision: u64,
        tool_checks: Option<ToolContractVerification>,
    ) -> Result<WorkflowDefinition> {
        crate::graph::validate_id(id)?;
        self.transaction(|library| {
            let record = find_mut(library, id, expected_revision)?;
            crate::graph::validate(&record.draft, true)?;
            for node in &record.draft.nodes {
                ensure!(node.config.output_schema.as_ref().and_then(|schema| schema.get("validationRetries")).is_none(),
                    "workflow_invalid: node {} has validationRetries inside outputSchema; move it to config.validationRetries beside outputSchema", node.id);
            }
            if record.draft.status == WorkflowStatus::Saved { return Ok(record.draft.clone()); }
            ensure!(record.versions.len() < MAX_SAVED_VERSIONS, "workflow_quota: at most {MAX_SAVED_VERSIONS} saved versions; existing versions were retained");
            let version = record.versions.last_key_value().map_or(1, |(version, _)| version + 1);
            touch(&mut record.draft)?;
            record.draft.status = WorkflowStatus::Saved;
            record.draft.saved_version = Some(version);
            // Refuse definitions whose encoded script cannot fit the existing runtime.
            // This is compilation only; saving never executes agents or other effects.
            if !crate::graph::is_rich(&record.draft) { crate::graph::compile(&record.draft, serde_json::Value::Null)?; }
            let checks = StaticVerification::checked(&record.draft)?;
            let checks = match tool_checks {
                Some(tool_checks) => checks.with_tool_contracts(&record.draft, tool_checks)?,
                None => checks,
            };
            record.static_checks.insert(version, checks);
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
        let _lease = library_lease(&directory, false)?;
        load(&directory)
    }

    fn transaction<T>(&self, mutate: impl FnOnce(&mut Library) -> Result<T>) -> Result<T> {
        let directory = self.open(true)?.expect("create opens a directory");
        let _lease = library_lease(&directory, true)?;
        shards::recover(&directory)?;
        let mut library = load(&directory)?;
        let result = mutate(&mut library)?;
        if library.records.values().any(|record| {
            crate::graph::is_rich(&record.draft)
                || record.versions.values().any(crate::graph::is_rich)
        }) {
            library.format_version = library.format_version.max(2);
        }
        validate_library(&library)?;
        let bytes = serde_json::to_vec(&library)?;
        ensure!(
            bytes.len() <= MAX_LIBRARY_BYTES,
            "workflow_quota: library exceeds {MAX_LIBRARY_BYTES} bytes; prior drafts and versions were retained"
        );
        if shards::active(&directory)? {
            shards::commit(&directory, &library)?;
            return Ok(result);
        }
        legacy::stage_checks(&directory, &library)?;
        let bytes = legacy::compatible_bytes(&library)?;
        directory
            .atomic_replace(OsStr::new(LIBRARY), &bytes)
            .context("workflow_storage: atomic commit was not confirmed; reload before retrying")?;
        legacy::cleanup_checks(&directory, &library);
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
            layout_changes: BTreeMap::new(),
            static_checks: BTreeMap::new(),
        },
    );
    Ok(definition)
}

fn load(directory: &PrivateDirectory) -> Result<Library> {
    if let Some(library) = shards::load(directory)? {
        return Ok(library);
    }
    if let Some(library) = shards::pending_library(directory)? {
        return Ok(library);
    }
    load_legacy(directory)
}
fn load_legacy(directory: &PrivateDirectory) -> Result<Library> {
    let file = match directory.open_regular_file(OsStr::new(LIBRARY)) {
        Ok(file) => file,
        Err(error) if not_found(&error) => return Ok(Library::default()),
        Err(error) => {
            return Err(error)
                .context("workflow_storage: library must be a regular non-symlink file");
        }
    };
    let bytes = bounded_read(file)?;
    let mut library: Library =
        serde_json::from_slice(&bytes).context("workflow_corrupt: invalid library JSON")?;
    legacy::merge_checks(directory, &mut library)?;
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
        matches!(library.format_version, 1..=3),
        "workflow_corrupt: unsupported library format version"
    );
    ensure!(
        library.records.len() <= MAX_WORKFLOWS,
        "workflow_quota: too many workflows"
    );
    for (id, record) in &library.records {
        crate::graph::validate_stored(&record.draft, false)?;
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
        for (version, checks) in &record.static_checks {
            let definition = record
                .versions
                .get(version)
                .context("workflow_corrupt: static evidence has no saved version")?;
            ensure!(
                checks.saved_version == *version
                    && checks.definition_sha256 == definition_fingerprint(definition)?
                    && checks.checked_nodes
                        == definition
                            .nodes
                            .iter()
                            .map(|node| node.id.clone())
                            .collect::<Vec<_>>(),
                "workflow_corrupt: static evidence does not match saved version"
            );
        }
        for (index, (version, definition)) in record.versions.iter().enumerate() {
            ensure!(
                (library.format_version == 3 || *version == index as u64 + 1)
                    && *version > 0
                    && *version <= 9_007_199_254_740_991
                    && definition.saved_version == Some(*version)
                    && definition.status == WorkflowStatus::Saved
                    && definition.id == *id
                    && definition.revision <= record.draft.revision,
                "workflow_corrupt: invalid saved snapshot"
            );
            crate::graph::validate_stored(definition, true)?;
        }
        if record.draft.status == WorkflowStatus::Saved {
            ensure!(
                record.versions.last_key_value().is_some_and(|(_, saved)| {
                    // Layout is mutable presentation metadata; the immutable
                    // saved definition and all execution fields remain exact.
                    let mut semantic = record.draft.clone();
                    if record
                        .layout_changes
                        .values()
                        .any(|revision| *revision == semantic.revision)
                    {
                        semantic.updated_at_ms = saved.updated_at_ms;
                    }
                    for node in &mut semantic.nodes {
                        if record.layout_changes.get(&node.id) == Some(&semantic.revision)
                            && let Some(original) = saved.nodes.iter().find(|old| old.id == node.id)
                        {
                            node.position = original.position;
                        }
                    }
                    saved == &semantic
                }),
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

    #[test]
    fn capacity_distinguishes_counts_and_bytes_without_pruning() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let draft = store.create("Capacity", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("one", &[]))
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let capacity = store.capacity().unwrap();
        assert_eq!(capacity.workflow_count, 1);
        assert_eq!(capacity.saved_version_count, 1);
        assert_eq!(capacity.versions[&draft.id], 1);
        assert_eq!(
            capacity.used_bytes,
            std::fs::metadata(temp.path().join("library/library.json"))
                .unwrap()
                .len() as usize
                + serde_json::to_vec(
                    store
                        .verification(&draft.id, 1)
                        .unwrap()
                        .static_check
                        .as_ref()
                        .unwrap()
                )
                .unwrap()
                .len()
        );
        assert!(!capacity.near_limit);
        assert_eq!(store.read_saved(&draft.id, Some(1)).unwrap(), saved);
    }

    #[test]
    fn bounded_lock_wait_handles_short_contention_and_does_not_repeat_save() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path().join("library"));
        let draft = store.create("Contended", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("one", &[]))
            .unwrap();
        let directory = store.open(true).unwrap().unwrap();
        let held = directory
            .try_exclusive_lock(OsStr::new(LOCK))
            .unwrap()
            .unwrap();
        let cloned = store.clone();
        let id = draft.id.clone();
        let save = std::thread::spawn(move || cloned.save(&id, draft.revision));
        std::thread::sleep(Duration::from_millis(50));
        fs2::FileExt::unlock(&held).unwrap();
        assert_eq!(save.join().unwrap().unwrap().saved_version, Some(1));
        assert_eq!(store.versions(&draft.id).unwrap().len(), 1);
        let held = directory
            .try_exclusive_lock(OsStr::new(LOCK))
            .unwrap()
            .unwrap();
        let start = Instant::now();
        assert!(
            store
                .read(&draft.id)
                .unwrap_err()
                .to_string()
                .contains("workflow_busy")
        );
        assert!(start.elapsed() >= Duration::from_secs(2));
        assert!(start.elapsed() < Duration::from_secs(3));
        fs2::FileExt::unlock(&held).unwrap();
        assert_eq!(store.versions(&draft.id).unwrap().len(), 1);
    }

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
    fn layout_edits_do_not_conflict_with_content_or_change_saved_versions() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("layout", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("a", &[]))
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let original = saved.nodes[0].position;
        let target = WorkflowPosition { x: 120.0, y: 240.0 };
        let moved = store.move_node(&saved.id, "a", original, target).unwrap();
        assert_eq!(moved.revision, saved.revision);
        assert_eq!(moved.status, saved.status);
        assert!(moved.updated_at_ms > saved.updated_at_ms);
        assert_eq!(
            store
                .read_saved(&saved.id, saved.saved_version)
                .unwrap()
                .nodes[0]
                .position,
            original
        );
        let mut edit = saved.nodes[0].clone();
        edit.prompt = "new instructions".into();
        let updated = store.upsert_node(&saved.id, saved.revision, edit).unwrap();
        assert_eq!(updated.nodes[0].position, target);
        assert_eq!(updated.nodes[0].prompt, "new instructions");
        assert!(
            store
                .move_node(
                    &saved.id,
                    "a",
                    original,
                    WorkflowPosition { x: 300.0, y: 300.0 }
                )
                .unwrap_err()
                .to_string()
                .contains("workflow_layout_conflict")
        );
        let current = store.read(&saved.id).unwrap();
        let moved = store
            .move_node(
                &saved.id,
                "a",
                target,
                WorkflowPosition { x: 150.0, y: 240.0 },
            )
            .unwrap();
        let patched = store
            .patch_fields(
                &saved.id,
                current.revision,
                vec![serde_json::json!({"id":"a","prompt":"patched","position":{"x":120,"y":240}})],
                vec![],
            )
            .unwrap();
        assert_eq!(patched.nodes[0].position, moved.nodes[0].position);
        assert!(
            store
                .move_node(
                    &saved.id,
                    "missing",
                    WorkflowPosition::default(),
                    WorkflowPosition::default()
                )
                .is_err()
        );
    }

    #[test]
    fn legacy_invalid_loop_remains_readable_repairable_and_deletable() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path());
        let draft = store.create("legacy loop", "").unwrap();
        let loop_node: WorkflowNode = serde_json::from_value(serde_json::json!({
            "id":"revise","title":"revise","prompt":"score","kind":"loop",
            "config":{"loop":{"mode":"repeat","maxIterations":3,"until":{
                "op":"greater_than","pointer":"/iteration/score","value":52}}}
        }))
        .unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, loop_node)
            .unwrap();
        assert!(store.save(&draft.id, draft.revision).is_err());
        // Simulate a version saved by the previous release; no runtime migration
        // may rewrite immutable definitions or make the entire library unreadable.
        store
            .transaction(|library| {
                let record = library.records.get_mut(&draft.id).unwrap();
                record.draft.status = WorkflowStatus::Saved;
                record.draft.saved_version = Some(1);
                record.versions.insert(1, record.draft.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        let saved = store.read_saved(&draft.id, Some(1)).unwrap();
        assert!(crate::graph::validate(&saved, true).is_err());
        let mut repaired = saved.nodes[0].clone();
        repaired.config = serde_json::from_value(serde_json::json!({
            "outputSchema":{"type":"object","required":["score"],"properties":{"score":{"type":"number"}}},
            "loop":{"mode":"repeat","maxIterations":3,"until":{"op":"greater_than","pointer":"/iteration/output/score","value":52}}
        })).unwrap();
        let draft = store
            .upsert_node(&draft.id, saved.revision, repaired)
            .unwrap();
        let fixed = store.save(&draft.id, draft.revision).unwrap();
        assert_eq!(fixed.saved_version, Some(2));
        assert_eq!(store.read_saved(&draft.id, Some(1)).unwrap(), saved);
        store.delete(&fixed.id, fixed.revision).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn delete_is_revision_checked_and_persisted_without_touching_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(dir.path());
        let draft = store.create("delete me", "").unwrap();
        let other = store.create("keep me", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("A", &[]))
            .unwrap();
        let draft = store.save(&draft.id, draft.revision).unwrap();
        assert!(store.delete(&draft.id, draft.revision + 1).is_err());
        assert!(store.read(&draft.id).is_ok());
        store.delete(&draft.id, draft.revision).unwrap();
        let reopened = WorkflowStore::new(dir.path());
        assert!(reopened.read(&draft.id).is_err());
        assert!(reopened.read_saved(&draft.id, Some(1)).is_err());
        assert_eq!(reopened.list().unwrap().len(), 1);
        assert!(reopened.read(&other.id).is_ok());
    }

    #[test]
    fn partial_patch_preserves_branch_guards_and_explicit_null_can_clear_them() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Branches", "").unwrap();
        let mut route = node("route", &[]);
        route.kind = kcoder_types::workflow::WorkflowNodeKind::Condition;
        route.config.condition = Some(kcoder_types::workflow::WorkflowPredicate::Exists {
            pointer: "/input".into(),
        });
        let mut branch = node("branch", &["route"]);
        branch.run_if = Some(kcoder_types::workflow::WorkflowBranchGuard {
            node_id: "route".into(),
            equals: true.into(),
        });
        branch.config.output_schema = Some(serde_json::json!({"type":"object"}));
        let draft = store
            .patch_nodes(
                &draft.id,
                draft.revision,
                vec![route, branch.clone()],
                vec![],
            )
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let patched = store.patch_fields(&saved.id,saved.revision,vec![serde_json::json!({"id":"branch","prompt":"New prompt","config":{"validationRetries":2}})],vec![]).unwrap();
        let updated = patched
            .nodes
            .iter()
            .find(|node| node.id == "branch")
            .unwrap();
        assert_eq!(updated.run_if, branch.run_if);
        assert_eq!(updated.depends_on, branch.depends_on);
        assert_eq!(updated.config.output_schema, branch.config.output_schema);
        assert_eq!(updated.config.validation_retries, 2);
        assert_eq!(updated.max_turns, branch.max_turns);
        assert_eq!(store.read_saved(&saved.id, Some(1)).unwrap(), saved);
        let cleared = store
            .patch_fields(
                &saved.id,
                patched.revision,
                vec![serde_json::json!({"id":"branch","runIf":null,"dependsOn":[]})],
                vec!["route".into()],
            )
            .unwrap();
        assert!(cleared.nodes[0].run_if.is_none());
        assert!(cleared.nodes[0].depends_on.is_empty());
        assert!(
            store
                .patch_fields(
                    &saved.id,
                    saved.revision,
                    vec![serde_json::json!({"id":"branch","prompt":"stale"})],
                    vec![]
                )
                .is_err()
        );
    }

    #[test]
    fn publishing_rejects_retry_settings_hidden_inside_output_schema() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Repair", "").unwrap();
        let mut task = node("parse", &[]);
        task.config.output_schema =
            Some(serde_json::json!({"type":"object","validationRetries":1}));
        let draft = store
            .upsert_node(&draft.id, draft.revision, task.clone())
            .unwrap();
        let error = store
            .save(&draft.id, draft.revision)
            .unwrap_err()
            .to_string();
        assert!(error.contains("config.validationRetries"));
        assert_eq!(store.read(&draft.id).unwrap(), draft);
        task.config.output_schema = Some(serde_json::json!({"type":"object"}));
        task.config.validation_retries = 1;
        let fixed = store.upsert_node(&draft.id, draft.revision, task).unwrap();
        assert_eq!(
            store.save(&fixed.id, fixed.revision).unwrap().saved_version,
            Some(1)
        );
    }

    #[test]
    fn removing_a_live_condition_requires_explicit_branch_rewiring() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Guarded", "").unwrap();
        let mut condition = node("condition", &[]);
        condition.kind = kcoder_types::workflow::WorkflowNodeKind::Condition;
        condition.config.condition = Some(kcoder_types::workflow::WorkflowPredicate::Exists {
            pointer: "/input/enabled".into(),
        });
        let mut branch = node("branch", &["condition"]);
        branch.run_if = Some(kcoder_types::workflow::WorkflowBranchGuard {
            node_id: "condition".into(),
            equals: true.into(),
        });
        let draft = store
            .patch_nodes(&draft.id, draft.revision, vec![condition, branch], vec![])
            .unwrap();
        assert!(
            store
                .remove_node(&draft.id, draft.revision, "condition")
                .is_err()
        );
        assert!(
            store
                .patch_nodes(&draft.id, draft.revision, vec![], vec!["condition".into()])
                .is_err()
        );
        assert_eq!(store.read(&draft.id).unwrap(), draft);
        let rewired = store
            .patch_nodes(
                &draft.id,
                draft.revision,
                vec![node("branch", &[])],
                vec!["condition".into()],
            )
            .unwrap();
        assert_eq!(rewired.nodes.len(), 1);
        assert!(rewired.nodes[0].run_if.is_none());
    }

    #[test]
    fn workflow_contract_empty_draft_is_editable_but_not_publishable() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Replace graph", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("one", &[]))
            .unwrap();
        let empty = store
            .patch_nodes(&draft.id, draft.revision, vec![], vec!["one".into()])
            .unwrap();
        assert!(empty.nodes.is_empty());
        assert!(store.save(&empty.id, empty.revision).is_err());
        let draft = store
            .upsert_node(&empty.id, empty.revision, node("two", &[]))
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let empty = store
            .patch_nodes(&saved.id, saved.revision, vec![], vec!["two".into()])
            .unwrap();
        assert_eq!(empty.status, WorkflowStatus::Draft);
        assert!(empty.nodes.is_empty());
        let reopened = WorkflowStore::new(store.root.clone());
        assert!(reopened.read(&empty.id).unwrap().nodes.is_empty());
        assert_eq!(reopened.read_saved(&saved.id, Some(1)).unwrap(), saved);
        assert!(reopened.save(&empty.id, empty.revision).is_err());
        let draft = reopened
            .upsert_node(&empty.id, empty.revision, node("three", &[]))
            .unwrap();
        assert_eq!(
            reopened
                .save(&draft.id, draft.revision)
                .unwrap()
                .saved_version,
            Some(2)
        );
    }

    #[test]
    fn graph_patch_rewires_atomically_and_keeps_saved_versions() {
        let temp = tempfile::tempdir().unwrap();
        let store = store(&temp);
        let draft = store.create("Branching", "").unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("old", &[]))
            .unwrap();
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("end", &["old"]))
            .unwrap();
        let saved = store.save(&draft.id, draft.revision).unwrap();
        let patched = store
            .patch_nodes(
                &saved.id,
                saved.revision,
                vec![
                    node("left", &[]),
                    node("right", &[]),
                    node("end", &["left", "right"]),
                ],
                vec!["old".into()],
            )
            .unwrap();
        assert_eq!(patched.revision, saved.revision + 1);
        assert_eq!(patched.status, WorkflowStatus::Draft);
        assert_eq!(store.read_saved(&saved.id, Some(1)).unwrap(), saved);
        assert!(
            store
                .patch_nodes(&saved.id, saved.revision, vec![node("late", &[])], vec![])
                .is_err()
        );
        for (nodes, removed) in [
            (vec![], vec!["left".into()]),
            (vec![node("left", &["end"])], vec![]),
            (vec![node("new", &[]), node("new", &[])], vec![]),
            (vec![node("left", &[])], vec!["left".into()]),
            (vec![], vec!["missing".into()]),
        ] {
            assert!(
                store
                    .patch_nodes(&saved.id, patched.revision, nodes, removed)
                    .is_err()
            );
            assert_eq!(store.read(&saved.id).unwrap(), patched);
        }
        let published = store.save(&saved.id, patched.revision).unwrap();
        assert_eq!(published.saved_version, Some(2));
        assert_eq!(store.read_saved(&saved.id, Some(1)).unwrap(), saved);
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
        assert!(
            store
                .update_metadata(&saved.id, saved.revision, "Stale", "", None)
                .is_err()
        );
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
        assert!(
            store
                .save(&draft.id, draft.revision)
                .unwrap_err()
                .to_string()
                .contains("at least one node")
        );
        let mut incomplete = node("consumer", &["producer"]);
        incomplete.prompt.clear();
        let draft = store
            .upsert_node(&draft.id, draft.revision, incomplete)
            .unwrap();
        assert!(store.save(&draft.id, draft.revision).is_err());
        let draft = store
            .upsert_node(&draft.id, draft.revision, node("consumer", &["producer"]))
            .unwrap();
        assert!(
            store
                .save(&draft.id, draft.revision)
                .unwrap_err()
                .to_string()
                .contains("unknown dependency")
        );
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
        assert!(
            store
                .save(&draft.id, draft.revision)
                .unwrap_err()
                .to_string()
                .contains("cycle")
        );
        assert!(
            store
                .upsert_node(&draft.id, 1, node("new", &[]))
                .unwrap_err()
                .to_string()
                .contains("workflow_conflict")
        );
        let mut oversized = node("new", &[]);
        oversized.prompt = "x".repeat(16385);
        assert!(
            store
                .upsert_node(&draft.id, draft.revision, oversized)
                .is_err()
        );
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
        assert!(
            store
                .save(&current.id, current.revision)
                .unwrap_err()
                .to_string()
                .contains("workflow_quota")
        );
        assert_eq!(std::fs::read(store.root.join(LIBRARY)).unwrap(), before);
        assert_eq!(store.read_saved(&current.id, Some(1)).unwrap(), first);
        let file = File::options()
            .write(true)
            .open(store.root.join(LIBRARY))
            .unwrap();
        file.set_len((MAX_LIBRARY_BYTES + 1) as u64).unwrap();
        assert!(
            store
                .list()
                .unwrap_err()
                .to_string()
                .contains("workflow_quota")
        );
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

#[cfg(test)]
mod default_contract_regressions {
    use super::*;
    use serde_json::json;
    #[test]
    fn invalid_defaults_do_not_advance_revision_and_old_records_remain_repairable() {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkflowStore::new(temp.path());
        let created = store.create("Original", "").unwrap();
        let bad = json!({"type":"object","properties":{"days":{"type":"integer","default":"3"}}});
        let error = store
            .update_metadata(
                &created.id,
                created.revision,
                "Wrong",
                "",
                Some(bad.clone()),
            )
            .unwrap_err();
        assert!(
            error.to_string().contains("/properties/days/default"),
            "{error}"
        );
        assert_eq!(store.read(&created.id).unwrap(), created);
        let file = temp.path().join("library.json");
        let mut library: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        library["records"][&created.id]["draft"]["inputSchema"] = bad;
        std::fs::write(&file, serde_json::to_vec(&library).unwrap()).unwrap();
        assert!(store.read(&created.id).unwrap().input_schema.is_some());
        let repaired = store
            .update_metadata(&created.id, created.revision, "Repaired", "", None)
            .unwrap();
        assert!(repaired.input_schema.is_none());
    }
}
