use crate::{ToolContext, ToolError};
use chrono::{DateTime, Utc};
use kcoder_skills::{
    ExpectedSkillRevision, SkillCommitRequest, SkillMetadataDelta, SkillMetadataPatch,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile,
    SkillStore, canonical_package_revision,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const BUNDLED_MANIFEST_FILE: &str = ".bundled_manifest";
const BUNDLED_MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundledManifest {
    #[serde(default = "default_bundled_manifest_version")]
    pub version: u32,
    #[serde(default)]
    pub skills: BTreeMap<String, BundledManifestEntry>,
}

impl Default for BundledManifest {
    fn default() -> Self {
        Self {
            version: BUNDLED_MANIFEST_VERSION,
            skills: BTreeMap::new(),
        }
    }
}

fn default_bundled_manifest_version() -> u32 {
    BUNDLED_MANIFEST_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundledManifestEntry {
    pub bundled_hash: String,
    pub installed_hash: String,
    #[serde(default)]
    pub source: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct SkillBundledSyncResult {
    success: bool,
    message: String,
    path: String,
    actions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) transaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) runtime_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) warning: Option<String>,
}

pub(crate) fn sync_for_hub(
    ctx: &ToolContext,
    status_only: bool,
    dry_run: bool,
    force: bool,
) -> Result<SkillBundledSyncResult, ToolError> {
    let cwd = ctx.state.cwd();
    let root = project_skills_root(&cwd);
    let mut result = sync_bundled_with_actor(
        &root,
        status_only || dry_run,
        !status_only && force,
        SkillMutationActor::SkillHub {
            session_id: ctx.state.session_id(),
            source_kind: "bundled".to_string(),
        },
    )?;
    if !status_only && !dry_run {
        let mut refresh = ctx.clone();
        refresh.record_project_skill_telemetry = false;
        let store = SkillStore::open(&root).map_err(skill_store_error)?;
        match refresh.reload_skill_registry() {
            Ok(_) => {
                result.runtime_status = Some("registry_reloaded".to_string());
                if let Some(transaction_id) = result.transaction_id.as_deref()
                    && let Err(error) = store.record_reload_status(transaction_id, true)
                {
                    result.warning =
                        Some(format!("failed to clear registry reload state: {error}"));
                }
            }
            Err(error) => {
                result.runtime_status = Some("committed_reload_pending".to_string());
                result.warning = Some(format!(
                    "disk transaction committed; registry reload failed, so retry only the reload: {error}"
                ));
                if let Some(transaction_id) = result.transaction_id.as_deref()
                    && let Err(marker_error) = store.record_reload_status(transaction_id, false)
                {
                    result.warning = Some(format!(
                        "{}; failed to persist registry reload state: {marker_error}",
                        result.warning.as_deref().unwrap_or_default()
                    ));
                }
            }
        }
    }
    Ok(result)
}

pub fn sync_bundled(
    root: &Path,
    dry_run: bool,
    force: bool,
) -> Result<SkillBundledSyncResult, ToolError> {
    sync_bundled_with_actor(
        root,
        dry_run,
        force,
        SkillMutationActor::System {
            component: "bundled_sync".to_string(),
            session_id: None,
        },
    )
}

fn sync_bundled_with_actor(
    root: &Path,
    dry_run: bool,
    force: bool,
    actor: SkillMutationActor,
) -> Result<SkillBundledSyncResult, ToolError> {
    let mut manifest = load_manifest(root).map_err(to_tool_error)?;
    let provenance = crate::skill_provenance::load_store(root).ok();
    let mut actions = Vec::new();
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let mut mutations = Vec::new();
    let mut metadata = SkillMetadataDelta::default();
    let mut transaction_id = None;

    for (name, bundled_content) in kcoder_specs::SUPERPOWER_SKILLS {
        let skill_dir = root.join(name);
        let skill_file = skill_dir.join("SKILL.md");
        let local_content = std::fs::read_to_string(&skill_file).ok();
        let local_legacy_hash = local_content.as_deref().map(stable_hash);
        let explicit_non_bundled = has_explicit_non_bundled_provenance(provenance.as_ref(), name);
        let desired = bundled_package(name, bundled_content);
        let desired_revision = canonical_package_revision(&desired).map_err(skill_store_error)?;

        if explicit_non_bundled && local_content.is_some() && !force {
            if local_content.as_deref() == Some(*bundled_content) {
                actions.push(format!("protected: {name} (non-bundled provenance)"));
            } else {
                let new_file = skill_dir.join("SKILL.md.new");
                actions.push(format!("conflict: {name} -> {}", new_file.display()));
                if !dry_run {
                    insert_auxiliary_if_changed(
                        root,
                        &mut metadata,
                        PathBuf::from(name).join("SKILL.md.new"),
                        bundled_content.as_bytes(),
                    );
                }
            }
            continue;
        }

        let previous = manifest.skills.get(*name);
        let current = store.read_package(name);
        let current = match current {
            Ok(package) => package,
            Err(_) if force => None,
            Err(_) => {
                let new_file = skill_dir.join("SKILL.md.new");
                actions.push(format!("conflict: {name} -> {}", new_file.display()));
                if !dry_run {
                    insert_auxiliary_if_changed(
                        root,
                        &mut metadata,
                        PathBuf::from(name).join("SKILL.md.new"),
                        bundled_content.as_bytes(),
                    );
                }
                continue;
            }
        };
        let current_revision = current
            .as_ref()
            .map(canonical_package_revision)
            .transpose()
            .map_err(skill_store_error)?;
        let unchanged_from_manifest = previous
            .map(|entry| {
                current_revision
                    .as_ref()
                    .is_some_and(|revision| revision.0 == entry.installed_hash)
                    || local_legacy_hash
                        .as_ref()
                        .is_some_and(|hash| hash == &entry.installed_hash)
            })
            .unwrap_or(local_content.is_none());

        let main_matches = local_content.as_deref() == Some(*bundled_content);
        let may_update_main = force || unchanged_from_manifest;
        if !main_matches && may_update_main {
            actions.push(if local_content.is_some() {
                format!("update: {name}")
            } else {
                format!("install: {name}")
            });
        } else if !main_matches {
            let new_file = skill_dir.join("SKILL.md.new");
            actions.push(format!("conflict: {name} -> {}", new_file.display()));
            if !dry_run {
                insert_auxiliary_if_changed(
                    root,
                    &mut metadata,
                    PathBuf::from(name).join("SKILL.md.new"),
                    bundled_content.as_bytes(),
                );
            }
            continue;
        } else {
            actions.push(format!("unchanged: {name}"));
        }

        if dry_run {
            preview_asset_actions(name, current.as_ref(), force, &mut actions);
            continue;
        }

        let (planned, auxiliary) = merge_bundled_package(name, current.as_ref(), &desired, force);
        metadata.auxiliary_files.extend(auxiliary);
        let planned_revision = canonical_package_revision(&planned).map_err(skill_store_error)?;
        preview_asset_actions(name, current.as_ref(), force, &mut actions);
        let package_changed = current_revision.as_ref() != Some(&planned_revision);
        if package_changed {
            mutations.push(SkillMutation::PutPackage {
                package: planned,
                expected: if force {
                    ExpectedSkillRevision::Unconditional
                } else {
                    current_revision
                        .clone()
                        .map(ExpectedSkillRevision::Exact)
                        .unwrap_or(ExpectedSkillRevision::Absent)
                },
            });
        }
        upsert_manifest_entry(
            &mut manifest,
            name,
            &desired_revision.0,
            &planned_revision.0,
        );
        if package_changed
            || bundled_metadata_needed(provenance.as_ref(), name, &desired_revision.0)
        {
            record_bundled_metadata(&mut metadata, name, &desired_revision.0);
        }
    }

    if !dry_run {
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| ToolError::Execution(error.to_string()))?;
        if std::fs::read(manifest_path(root)).ok().as_deref() != Some(manifest_bytes.as_slice()) {
            metadata.bundled_manifest = Some(manifest_bytes);
        }
        if !mutations.is_empty() || metadata != SkillMetadataDelta::default() {
            let operation_id = bundled_operation_id(force, &mutations, &metadata)?;
            let receipt = store
                .commit(SkillCommitRequest {
                    operation_id,
                    actor,
                    operation: SkillOperationKind::BundledSync,
                    preconditions: Vec::new(),
                    mutations,
                    metadata,
                })
                .map_err(skill_store_error)?;
            transaction_id = Some(receipt.transaction_id);
        }
    }

    Ok(SkillBundledSyncResult {
        success: true,
        message: if dry_run {
            format!("Skill sync dry-run found {} action(s).", actions.len())
        } else {
            format!("Skill sync applied {} action(s).", actions.len())
        },
        path: manifest_path(root).display().to_string(),
        actions,
        transaction_id,
        runtime_status: None,
        warning: None,
    })
}

fn bundled_package(name: &str, content: &str) -> SkillPackage {
    let mut files = vec![SkillPackageFile {
        relative_path: PathBuf::from("SKILL.md"),
        content: content.as_bytes().to_vec(),
        executable: false,
    }];
    files.extend(
        kcoder_specs::SUPERPOWER_SKILL_ASSETS
            .iter()
            .filter(|asset| asset.skill == name)
            .map(|asset| SkillPackageFile {
                relative_path: PathBuf::from(asset.relative_path),
                content: asset.content.as_bytes().to_vec(),
                executable: kcoder_specs::bundled_skill_asset_is_executable(
                    asset.skill,
                    asset.relative_path,
                ),
            }),
    );
    SkillPackage {
        name: name.to_string(),
        files,
    }
}

fn merge_bundled_package(
    name: &str,
    current: Option<&SkillPackage>,
    desired: &SkillPackage,
    force: bool,
) -> (SkillPackage, BTreeMap<PathBuf, Vec<u8>>) {
    let mut files = current
        .map(|package| {
            package
                .files
                .iter()
                .cloned()
                .map(|file| (file.relative_path.clone(), file))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut auxiliary = BTreeMap::new();
    for desired_file in &desired.files {
        match files.get_mut(&desired_file.relative_path) {
            None => {
                files.insert(desired_file.relative_path.clone(), desired_file.clone());
            }
            Some(current_file)
                if desired_file.relative_path == Path::new("SKILL.md")
                    || force
                    || current_file.content == desired_file.content =>
            {
                *current_file = desired_file.clone();
            }
            Some(_) => {
                let mut relative = desired_file.relative_path.clone().into_os_string();
                relative.push(".new");
                auxiliary.insert(
                    PathBuf::from(name).join(relative),
                    desired_file.content.clone(),
                );
            }
        }
    }
    (
        SkillPackage {
            name: name.to_string(),
            files: files.into_values().collect(),
        },
        auxiliary,
    )
}

fn preview_asset_actions(
    name: &str,
    current: Option<&SkillPackage>,
    force: bool,
    actions: &mut Vec<String>,
) {
    let current = current
        .map(|package| {
            package
                .files
                .iter()
                .map(|file| (file.relative_path.as_path(), file))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    for asset in kcoder_specs::SUPERPOWER_SKILL_ASSETS
        .iter()
        .filter(|asset| asset.skill == name)
    {
        let relative = Path::new(asset.relative_path);
        let label = format!("{name}/{}", asset.relative_path);
        match current.get(relative) {
            None => actions.push(format!("install: {label}")),
            Some(file) if file.content != asset.content.as_bytes() && force => {
                actions.push(format!("update: {label}"));
            }
            Some(file) if file.content != asset.content.as_bytes() => {
                actions.push(format!(
                    "conflict: {label} -> {}",
                    PathBuf::from(name)
                        .join(format!("{}.new", asset.relative_path))
                        .display()
                ));
            }
            Some(file)
                if kcoder_specs::bundled_skill_asset_is_executable(name, asset.relative_path)
                    && !file.executable =>
            {
                actions.push(format!("chmod: {label}"));
            }
            Some(_) => {}
        }
    }
}

fn upsert_manifest_entry(
    manifest: &mut BundledManifest,
    name: &str,
    bundled_hash: &str,
    installed_hash: &str,
) {
    let source = bundled_skill_source(name);
    if manifest.skills.get(name).is_some_and(|entry| {
        entry.bundled_hash == bundled_hash
            && entry.installed_hash == installed_hash
            && entry.source == source
    }) {
        return;
    }
    manifest.skills.insert(
        name.to_string(),
        BundledManifestEntry {
            bundled_hash: bundled_hash.to_string(),
            installed_hash: installed_hash.to_string(),
            source,
            updated_at: Utc::now(),
        },
    );
}

fn bundled_skill_source(name: &str) -> String {
    format!("crates/kcoder_specs/src/skills/{name}/SKILL.md")
}

fn record_bundled_metadata(metadata: &mut SkillMetadataDelta, name: &str, hash: &str) {
    let now = Utc::now().to_rfc3339();
    let mut provenance = SkillMetadataPatch::default();
    provenance
        .create
        .insert("created_at".to_string(), Value::String(now.clone()));
    provenance.create.insert(
        "created_by".to_string(),
        Value::String("kcoder".to_string()),
    );
    provenance
        .update
        .insert("origin".to_string(), Value::String("bundled".to_string()));
    provenance.update.insert(
        "write_origin".to_string(),
        Value::String("bundled_install".to_string()),
    );
    provenance
        .update
        .insert("bundled_hash".to_string(), Value::String(hash.to_string()));
    metadata.provenance.insert(name.to_string(), provenance);

    let mut usage = SkillMetadataPatch::default();
    usage
        .create
        .insert("created_at".to_string(), Value::String(now));
    usage
        .create
        .insert("state".to_string(), Value::String("active".to_string()));
    usage
        .create
        .insert("pinned".to_string(), Value::Bool(false));
    metadata.usage.insert(name.to_string(), usage);
}

fn bundled_metadata_needed(
    provenance: Option<&crate::skill_provenance::SkillProvenanceStore>,
    name: &str,
    desired_hash: &str,
) -> bool {
    !provenance
        .and_then(|store| store.skills.get(name))
        .is_some_and(|record| {
            record.origin == crate::skill_provenance::SkillOrigin::Bundled
                && record.bundled_hash.as_deref() == Some(desired_hash)
        })
}

fn insert_auxiliary_if_changed(
    root: &Path,
    metadata: &mut SkillMetadataDelta,
    relative: PathBuf,
    content: &[u8],
) {
    if std::fs::read(root.join(&relative)).ok().as_deref() != Some(content) {
        metadata.auxiliary_files.insert(relative, content.to_vec());
    }
}

fn bundled_operation_id(
    force: bool,
    mutations: &[SkillMutation],
    metadata: &SkillMetadataDelta,
) -> Result<String, ToolError> {
    let mut hasher = Sha256::new();
    hasher.update([u8::from(force)]);
    hasher.update(
        serde_json::to_vec(&(mutations, metadata))
            .map_err(|error| ToolError::Execution(error.to_string()))?,
    );
    Ok(format!("bundled-sync-{:x}", hasher.finalize()))
}

fn has_explicit_non_bundled_provenance(
    provenance: Option<&crate::skill_provenance::SkillProvenanceStore>,
    name: &str,
) -> bool {
    provenance
        .and_then(|store| store.skills.get(name))
        .is_some_and(|record| record.origin != crate::skill_provenance::SkillOrigin::Bundled)
}

fn project_skills_root(cwd: &Path) -> PathBuf {
    crate::skill_provenance::project_skills_root(cwd)
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(BUNDLED_MANIFEST_FILE)
}

fn load_manifest(root: &Path) -> anyhow::Result<BundledManifest> {
    let path = manifest_path(root);
    if !path.is_file() {
        return Ok(BundledManifest::default());
    }
    let content = std::fs::read_to_string(path)?;
    if content.trim().is_empty() {
        return Ok(BundledManifest::default());
    }
    Ok(serde_json::from_str(&content)?)
}

pub(crate) fn stable_hash(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn to_tool_error(error: anyhow::Error) -> ToolError {
    ToolError::Execution(error.to_string())
}

fn skill_store_error(error: kcoder_skills::SkillStoreError) -> ToolError {
    match error {
        kcoder_skills::SkillStoreError::Conflict {
            name,
            expected,
            actual,
        } => ToolError::InvalidInput(format!(
            "status=conflict; skill={name}; expected_revision={expected}; actual_revision={actual}"
        )),
        other => ToolError::Execution(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;

    #[test]
    fn bundled_manifest_defaults_and_legacy_json_use_version_one() {
        assert_eq!(BundledManifest::default().version, BUNDLED_MANIFEST_VERSION);

        let legacy: BundledManifest = serde_json::from_str(r#"{"skills":{}}"#).unwrap();
        assert_eq!(legacy.version, BUNDLED_MANIFEST_VERSION);
        assert!(legacy.skills.is_empty());

        let legacy_entry: BundledManifest = serde_json::from_str(
            r#"{"skills":{"using-superpowers":{"bundled_hash":"a","installed_hash":"a","updated_at":"2026-06-20T00:00:00Z"}}}"#,
        )
        .unwrap();
        assert_eq!(
            legacy_entry.skills.get("using-superpowers").unwrap().source,
            ""
        );
    }

    #[test]
    fn sync_writes_manifest_and_detects_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&root).unwrap();

        let first = sync_bundled(&root, false, false).unwrap();
        assert!(
            first
                .actions
                .iter()
                .any(|action| action.starts_with("install:"))
        );
        assert!(manifest_path(&root).is_file());
        let manifest: BundledManifest =
            serde_json::from_str(&std::fs::read_to_string(manifest_path(&root)).unwrap()).unwrap();
        assert_eq!(manifest.version, BUNDLED_MANIFEST_VERSION);
        let using_superpowers = manifest.skills.get("using-superpowers").unwrap();
        assert_eq!(
            using_superpowers.source,
            "crates/kcoder_specs/src/skills/using-superpowers/SKILL.md"
        );

        let skill = root.join("brainstorming").join("SKILL.md");
        std::fs::write(&skill, "local edit").unwrap();
        let second = sync_bundled(&root, false, false).unwrap();
        assert!(
            second
                .actions
                .iter()
                .any(|action| action.starts_with("conflict: brainstorming"))
        );
        assert!(root.join("brainstorming").join("SKILL.md.new").is_file());
    }

    #[test]
    fn sync_installs_bundled_assets_and_stages_local_asset_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder").join("skills");

        sync_bundled(&root, false, false).unwrap();

        let asset = root
            .join("systematic-debugging")
            .join("root-cause-tracing.md");
        assert_eq!(
            std::fs::read_to_string(&asset).unwrap(),
            include_str!(
                "../../kcoder_specs/src/skills/systematic-debugging/root-cause-tracing.md"
            )
        );
        std::fs::write(&asset, "local asset override").unwrap();

        let update = sync_bundled(&root, false, false).unwrap();
        assert_eq!(
            std::fs::read_to_string(&asset).unwrap(),
            "local asset override"
        );
        assert!(update.actions.iter().any(|action| {
            action.starts_with("conflict: systematic-debugging/root-cause-tracing.md")
        }));
        assert_eq!(
            std::fs::read_to_string(asset.with_file_name("root-cause-tracing.md.new")).unwrap(),
            include_str!(
                "../../kcoder_specs/src/skills/systematic-debugging/root-cause-tracing.md"
            )
        );

        sync_bundled(&root, false, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(asset).unwrap(),
            include_str!(
                "../../kcoder_specs/src/skills/systematic-debugging/root-cause-tracing.md"
            )
        );
    }

    #[tokio::test]
    async fn tool_records_bundled_provenance_for_synced_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        sync_for_hub(&ctx, false, false, false).unwrap();

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let using_superpowers = provenance.skills.get("using-superpowers").unwrap();
        assert_eq!(
            using_superpowers.origin,
            crate::skill_provenance::SkillOrigin::Bundled
        );
        assert_eq!(
            using_superpowers.write_origin.as_deref(),
            Some("bundled_install")
        );
        assert!(using_superpowers.bundled_hash.is_some());
    }

    #[tokio::test]
    async fn tool_does_not_mark_conflicted_local_skill_as_bundled() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(root.join("brainstorming")).unwrap();
        std::fs::write(root.join("brainstorming/SKILL.md"), "local edit").unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        sync_for_hub(&ctx, false, false, false).unwrap();

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        assert!(!provenance.skills.contains_key("brainstorming"));
        assert!(root.join("brainstorming/SKILL.md.new").is_file());
    }

    #[tokio::test]
    async fn tool_preserves_non_bundled_provenance_for_matching_local_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder").join("skills");
        let (name, content) = kcoder_specs::SUPERPOWER_SKILLS
            .iter()
            .find(|(name, _)| *name == "using-superpowers")
            .unwrap();
        std::fs::create_dir_all(root.join(name)).unwrap();
        std::fs::write(root.join(name).join("SKILL.md"), content).unwrap();
        crate::skill_provenance::record_user_created(tmp.path(), name);
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        sync_for_hub(&ctx, false, false, false).unwrap();

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let record = provenance.skills.get(*name).unwrap();
        assert_eq!(
            record.origin,
            crate::skill_provenance::SkillOrigin::UserCreated
        );
        assert!(record.bundled_hash.is_none());
        let manifest = load_manifest(&root).unwrap();
        assert!(!manifest.skills.contains_key(*name));
    }
}
