use anyhow::Context;
use chrono::{DateTime, Utc};
use kcoder_skills::{
    SkillCommitRequest, SkillMetadataDelta, SkillMetadataPatch, SkillMetadataPrecondition,
    SkillMetadataPredicate, SkillMetadataStore, SkillMutationActor, SkillOperationKind, SkillStore,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tracing::warn;

const PROVENANCE_FILE: &str = ".provenance.json";
const PROVENANCE_STORE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    Bundled,
    UserCreated,
    AgentCreated,
    HubInstalled,
    ExternalDir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillProvenance {
    #[serde(default)]
    pub name: String,
    pub origin: SkillOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_actor_kind: Option<String>,
    #[serde(default = "default_timestamp")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "default_timestamp")]
    pub updated_at: DateTime<Utc>,
}

impl SkillProvenance {
    fn new(name: &str, origin: SkillOrigin, now: DateTime<Utc>) -> Self {
        Self {
            name: name.to_string(),
            origin,
            created_by: None,
            write_origin: None,
            installed_from: None,
            bundled_hash: None,
            revision_sha256: None,
            last_transaction_id: None,
            last_actor_kind: None,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillProvenanceStore {
    #[serde(default = "default_provenance_store_version")]
    pub version: u32,
    #[serde(default)]
    pub skills: BTreeMap<String, SkillProvenance>,
}

impl Default for SkillProvenanceStore {
    fn default() -> Self {
        Self {
            version: PROVENANCE_STORE_VERSION,
            skills: BTreeMap::new(),
        }
    }
}

fn default_provenance_store_version() -> u32 {
    PROVENANCE_STORE_VERSION
}

fn default_timestamp() -> DateTime<Utc> {
    Utc::now()
}

pub fn record_user_created(cwd: &Path, name: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::UserCreated, false);
    patch
        .create
        .insert("created_by".to_string(), Value::String("user".to_string()));
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("skill_manage".to_string()),
    );
    if let Err(e) = commit_provenance_patch(
        &project_skills_root(cwd),
        name,
        patch,
        "record_user_created",
    ) {
        warn!("failed to record skill provenance: {}", e);
    }
}

pub fn record_agent_created(cwd: &Path, name: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::AgentCreated, false);
    patch
        .update
        .insert("created_by".to_string(), Value::String("agent".to_string()));
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("background_skill_review".to_string()),
    );
    if let Err(e) = commit_provenance_patch(
        &project_skills_root(cwd),
        name,
        patch,
        "record_agent_created",
    ) {
        warn!("failed to record agent-created skill provenance: {}", e);
    }
}

pub fn record_hub_installed(cwd: &Path, name: &str, installed_from: &str) {
    let root = project_skills_root(cwd);
    record_hub_installed_at(&root, name, installed_from);
}

pub fn record_hub_installed_at(root: &Path, name: &str, installed_from: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::HubInstalled, false);
    patch.update.insert(
        "installed_from".to_string(),
        Value::String(installed_from.to_string()),
    );
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("skill_hub".to_string()),
    );
    if let Err(e) = commit_provenance_patch(root, name, patch, "record_hub_installed") {
        warn!("failed to record hub skill provenance: {}", e);
    }
}

pub fn record_external_dir(cwd: &Path, name: &str, directory: &Path) {
    let mut patch = base_provenance_patch(name, SkillOrigin::ExternalDir, false);
    patch.update.insert(
        "installed_from".to_string(),
        Value::String(directory.display().to_string()),
    );
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("external_dir".to_string()),
    );
    if let Err(e) = commit_provenance_patch(
        &project_skills_root(cwd),
        name,
        patch,
        "record_external_dir",
    ) {
        warn!("failed to record external skill provenance: {}", e);
    }
}

pub fn record_bundled(cwd: &Path, name: &str, bundled_hash: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::Bundled, false);
    patch.create.insert(
        "created_by".to_string(),
        Value::String("kcoder".to_string()),
    );
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("bundled_install".to_string()),
    );
    patch.update.insert(
        "bundled_hash".to_string(),
        Value::String(bundled_hash.to_string()),
    );
    if let Err(e) =
        commit_provenance_patch(&project_skills_root(cwd), name, patch, "record_bundled")
    {
        warn!("failed to record bundled skill provenance: {}", e);
    }
}

pub fn record_curator_review_patch(cwd: &Path, name: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::AgentCreated, true);
    patch
        .create
        .insert("created_by".to_string(), Value::String("agent".to_string()));
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("curator_review_patch".to_string()),
    );
    if let Err(e) = commit_provenance_patch(
        &project_skills_root(cwd),
        name,
        patch,
        "record_curator_review_patch",
    ) {
        warn!("failed to record curator review patch provenance: {}", e);
    }
}

pub fn record_background_review_patch(cwd: &Path, name: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::UserCreated, true);
    patch
        .create
        .insert("created_by".to_string(), Value::String("user".to_string()));
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("background_skill_review".to_string()),
    );
    if let Err(e) = commit_provenance_patch(
        &project_skills_root(cwd),
        name,
        patch,
        "record_background_review_patch",
    ) {
        warn!("failed to record background review patch provenance: {}", e);
    }
}

fn base_provenance_patch(
    name: &str,
    origin: SkillOrigin,
    preserve_existing_origin: bool,
) -> SkillMetadataPatch {
    let mut patch = SkillMetadataPatch::default();
    patch
        .create
        .insert("name".to_string(), Value::String(name.to_string()));
    patch.create.insert(
        "created_at".to_string(),
        Value::String(Utc::now().to_rfc3339()),
    );
    let origin = serde_json::to_value(origin).unwrap_or(Value::String("user_created".to_string()));
    if preserve_existing_origin {
        patch.create.insert("origin".to_string(), origin);
    } else {
        patch.update.insert("origin".to_string(), origin);
    }
    patch
}

fn commit_provenance_patch(
    root: &Path,
    name: &str,
    patch: SkillMetadataPatch,
    component: &str,
) -> anyhow::Result<()> {
    SkillStore::open(root)?.commit(SkillCommitRequest {
        operation_id: format!("provenance-{component}:{}", uuid::Uuid::new_v4()),
        actor: SkillMutationActor::System {
            component: component.to_string(),
            session_id: None,
        },
        operation: SkillOperationKind::MetadataOnly,
        preconditions: Vec::new(),
        mutations: Vec::new(),
        metadata: SkillMetadataDelta {
            provenance: BTreeMap::from([(name.to_string(), patch)]),
            ..Default::default()
        },
    })?;
    Ok(())
}

/// Persist passive metadata needed during registry startup/refresh as a Store
/// transaction. Skill content remains unchanged and external directories remain read-only sources.
pub fn persist_loaded_skill_metadata(
    cwd: &Path,
    external_dirs: &[PathBuf],
    skills: &[(String, PathBuf)],
) -> anyhow::Result<()> {
    let project_root = project_skills_root(cwd);
    let now = Utc::now().to_rfc3339();
    let mut roots = BTreeMap::<PathBuf, SkillMetadataDelta>::new();
    for (name, source) in skills {
        let root = crate::skill_telemetry::usage_root_for_source(cwd, source);
        let delta = roots.entry(root).or_default();
        let mut usage = SkillMetadataPatch::default();
        usage
            .create
            .insert("created_at".to_string(), Value::String(now.clone()));
        usage
            .create
            .insert("state".to_string(), Value::String("active".to_string()));
        usage
            .create
            .insert("pinned".to_string(), Value::Bool(false));
        delta.usage.entry(name.clone()).or_insert(usage);

        if !crate::sandbox::path_starts_with(source, &project_root)
            && let Some(external) = external_dirs
                .iter()
                .find(|dir| crate::sandbox::path_starts_with(source, dir))
        {
            let delta = roots.entry(project_root.clone()).or_default();
            let mut provenance = SkillMetadataPatch::default();
            provenance
                .create
                .insert("created_at".to_string(), Value::String(now.clone()));
            provenance.update.insert(
                "origin".to_string(),
                Value::String("external_dir".to_string()),
            );
            provenance.update.insert(
                "write_origin".to_string(),
                Value::String("external_dir".to_string()),
            );
            provenance.update.insert(
                "installed_from".to_string(),
                Value::String(external.display().to_string()),
            );
            delta.provenance.insert(name.clone(), provenance);
        }
    }

    for (root, metadata) in roots {
        if metadata == SkillMetadataDelta::default() {
            continue;
        }
        SkillStore::open(&root)?.commit(SkillCommitRequest {
            operation_id: format!("registry-metadata:{}", uuid::Uuid::new_v4()),
            actor: SkillMutationActor::System {
                component: "registry_metadata".to_string(),
                session_id: None,
            },
            operation: SkillOperationKind::MetadataOnly,
            preconditions: Vec::new(),
            mutations: Vec::new(),
            metadata,
        })?;
    }
    Ok(())
}

pub fn record_skill_manage_patch(cwd: &Path, name: &str) {
    let mut patch = base_provenance_patch(name, SkillOrigin::UserCreated, true);
    patch
        .create
        .insert("created_by".to_string(), Value::String("user".to_string()));
    patch.update.insert(
        "write_origin".to_string(),
        Value::String("skill_manage".to_string()),
    );
    if let Err(e) = commit_provenance_patch(
        &project_skills_root(cwd),
        name,
        patch,
        "record_skill_manage_patch",
    ) {
        warn!("failed to record skill_manage patch provenance: {}", e);
    }
}

pub fn load_project_provenance(cwd: &Path) -> anyhow::Result<SkillProvenanceStore> {
    load_store(&project_skills_root(cwd))
}

pub fn upsert_project_provenance<F>(
    cwd: &Path,
    name: &str,
    origin: SkillOrigin,
    update: F,
) -> anyhow::Result<()>
where
    F: FnOnce(&mut SkillProvenance),
{
    let root = project_skills_root(cwd);
    upsert_provenance(&root, name, origin, update)
}

pub fn upsert_provenance<F>(
    root: &Path,
    name: &str,
    origin: SkillOrigin,
    update: F,
) -> anyhow::Result<()>
where
    F: FnOnce(&mut SkillProvenance),
{
    let mut store = load_store(root)?;
    let now = Utc::now();
    let previous_updated_at = store
        .skills
        .get(name)
        .map(|record| record.updated_at.to_rfc3339());
    let record = store
        .skills
        .entry(name.to_string())
        .or_insert_with(|| SkillProvenance::new(name, origin.clone(), now));
    record.origin = origin;
    record.updated_at = now;
    update(record);
    let record = serde_json::to_value(record)?;
    let fields = record
        .as_object()
        .cloned()
        .context("serialized provenance record was not an object")?;
    let patch = SkillMetadataPatch {
        update: fields.into_iter().collect(),
        ..Default::default()
    };
    SkillStore::open(root)?.commit(SkillCommitRequest {
        operation_id: format!("provenance-upsert:{}", uuid::Uuid::new_v4()),
        actor: SkillMutationActor::System {
            component: "provenance_upsert".to_string(),
            session_id: None,
        },
        operation: SkillOperationKind::MetadataOnly,
        preconditions: vec![SkillMetadataPrecondition {
            store: SkillMetadataStore::Provenance,
            skill: name.to_string(),
            field: "updated_at".to_string(),
            predicate: SkillMetadataPredicate::MissingOrEquals,
            value: previous_updated_at
                .map(Value::String)
                .unwrap_or(Value::Null),
        }],
        mutations: Vec::new(),
        metadata: SkillMetadataDelta {
            provenance: BTreeMap::from([(name.to_string(), patch)]),
            ..Default::default()
        },
    })?;
    Ok(())
}

pub fn project_skills_root(cwd: &Path) -> PathBuf {
    let home_dir = dirs::home_dir();
    project_skills_root_with_home(cwd, home_dir.as_deref())
}

fn project_skills_root_with_home(cwd: &Path, home_dir: Option<&Path>) -> PathBuf {
    let mut current = Some(cwd);
    while let Some(dir) = current {
        if home_dir == Some(dir) {
            break;
        }
        let candidate = dir.join(".kcoder").join("skills");
        if candidate.is_dir() {
            return candidate;
        }
        current = dir.parent();
    }
    cwd.join(".kcoder").join("skills")
}

pub fn provenance_path(root: &Path) -> PathBuf {
    root.join(PROVENANCE_FILE)
}

pub fn load_store(root: &Path) -> anyhow::Result<SkillProvenanceStore> {
    let path = provenance_path(root);
    if !path.is_file() {
        return Ok(SkillProvenanceStore::default());
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(SkillProvenanceStore::default());
    }
    let mut store: SkillProvenanceStore = serde_json::from_str(&content)?;
    normalize_provenance_store(&mut store);
    Ok(store)
}

#[cfg(test)]
pub fn save_store(root: &Path, store: &SkillProvenanceStore) -> anyhow::Result<()> {
    std::fs::create_dir_all(root)?;
    atomic_write(
        &provenance_path(root),
        &serde_json::to_string_pretty(store)?,
    )
}

fn normalize_provenance_store(store: &mut SkillProvenanceStore) {
    for (name, provenance) in &mut store.skills {
        if provenance.name.trim().is_empty() {
            provenance.name = name.clone();
        }
    }
}

#[cfg(test)]
fn atomic_write(path: &Path, content: &str) -> anyhow::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provenance_store_defaults_and_legacy_json_use_version_one() {
        assert_eq!(
            SkillProvenanceStore::default().version,
            PROVENANCE_STORE_VERSION
        );

        let legacy: SkillProvenanceStore = serde_json::from_str(r#"{"skills":{}}"#).unwrap();
        assert_eq!(legacy.version, PROVENANCE_STORE_VERSION);
        assert!(legacy.skills.is_empty());
    }

    #[test]
    fn save_store_writes_provenance_store_version() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");

        save_store(&skills, &SkillProvenanceStore::default()).unwrap();

        let raw = std::fs::read_to_string(skills.join(".provenance.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], PROVENANCE_STORE_VERSION);
    }

    #[test]
    fn load_store_backfills_legacy_provenance_record_names_and_timestamps() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(
            skills.join(".provenance.json"),
            r#"{"skills":{"demo":{"origin":"user_created"}}}"#,
        )
        .unwrap();

        let store = load_store(&skills).unwrap();

        let record = store.skills.get("demo").unwrap();
        assert_eq!(record.name, "demo");
        assert_eq!(record.origin, SkillOrigin::UserCreated);
    }

    #[test]
    fn records_user_created_provenance() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kcoder").join("skills")).unwrap();

        record_user_created(tmp.path(), "demo");

        let store = load_project_provenance(tmp.path()).unwrap();
        let record = store.skills.get("demo").unwrap();
        assert_eq!(record.origin, SkillOrigin::UserCreated);
        assert_eq!(record.created_by.as_deref(), Some("user"));
        assert_eq!(record.write_origin.as_deref(), Some("skill_manage"));
    }

    #[test]
    fn records_external_directory_provenance() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kcoder").join("skills")).unwrap();
        let external = tmp.path().join("team-skills");

        record_external_dir(tmp.path(), "team-demo", &external);

        let store = load_project_provenance(tmp.path()).unwrap();
        let record = store.skills.get("team-demo").unwrap();
        assert_eq!(record.origin, SkillOrigin::ExternalDir);
        assert_eq!(
            record.installed_from.as_deref(),
            Some(external.to_str().unwrap())
        );
        assert_eq!(record.write_origin.as_deref(), Some("external_dir"));
    }

    #[test]
    fn curator_review_patch_preserves_existing_origin() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kcoder").join("skills")).unwrap();
        record_user_created(tmp.path(), "demo");

        record_curator_review_patch(tmp.path(), "demo");

        let store = load_project_provenance(tmp.path()).unwrap();
        let record = store.skills.get("demo").unwrap();
        assert_eq!(record.origin, SkillOrigin::UserCreated);
        assert_eq!(record.created_by.as_deref(), Some("user"));
        assert_eq!(record.write_origin.as_deref(), Some("curator_review_patch"));
    }

    #[test]
    fn skill_manage_patch_preserves_existing_origin() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kcoder").join("skills")).unwrap();
        record_agent_created(tmp.path(), "demo");

        record_skill_manage_patch(tmp.path(), "demo");

        let store = load_project_provenance(tmp.path()).unwrap();
        let record = store.skills.get("demo").unwrap();
        assert_eq!(record.origin, SkillOrigin::AgentCreated);
        assert_eq!(record.created_by.as_deref(), Some("agent"));
        assert_eq!(record.write_origin.as_deref(), Some("skill_manage"));
    }

    #[test]
    fn skill_manage_patch_missing_record_defaults_to_user_created() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kcoder").join("skills")).unwrap();

        record_skill_manage_patch(tmp.path(), "demo");

        let store = load_project_provenance(tmp.path()).unwrap();
        let record = store.skills.get("demo").unwrap();
        assert_eq!(record.origin, SkillOrigin::UserCreated);
        assert_eq!(record.created_by.as_deref(), Some("user"));
        assert_eq!(record.write_origin.as_deref(), Some("skill_manage"));
    }

    #[test]
    fn background_review_patch_preserves_user_created_origin() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kcoder").join("skills")).unwrap();
        record_user_created(tmp.path(), "demo");

        record_background_review_patch(tmp.path(), "demo");

        let store = load_project_provenance(tmp.path()).unwrap();
        let record = store.skills.get("demo").unwrap();
        assert_eq!(record.origin, SkillOrigin::UserCreated);
        assert_eq!(record.created_by.as_deref(), Some("user"));
        assert_eq!(
            record.write_origin.as_deref(),
            Some("background_skill_review")
        );
    }

    #[test]
    fn project_root_search_does_not_reuse_the_user_home_skill_directory() {
        let home = tempfile::tempdir().unwrap();
        let workspace = home.path().join("AppData/Local/Temp/workspace");
        std::fs::create_dir_all(home.path().join(".kcoder/skills")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        assert_eq!(
            project_skills_root_with_home(&workspace, Some(home.path())),
            workspace.join(".kcoder/skills")
        );
    }
}
