use crate::ToolError;
use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tracing::warn;

const USAGE_FILE: &str = ".usage.json";
const USAGE_STORE_VERSION: u32 = 1;
pub const HIGH_REDUNDANCY_THRESHOLD: f64 = 0.80;

/// Skill lifecycle state recorded in `.usage.json`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillState {
    #[default]
    Active,
    Stale,
    Archived,
}

/// Lightweight quality score reserved for curator/review heuristics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillQuality {
    #[serde(
        default,
        alias = "helpfulness",
        skip_serializing_if = "Option::is_none"
    )]
    pub helpful_score: Option<f64>,
    #[serde(default, alias = "redundancy", skip_serializing_if = "Option::is_none")]
    pub redundancy_score: Option<f64>,
    #[serde(
        default,
        alias = "specificity",
        skip_serializing_if = "Option::is_none"
    )]
    pub specificity_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default = "default_timestamp")]
    pub updated_at: DateTime<Utc>,
}

/// Telemetry record persisted for one skill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillTelemetry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub view_count: u64,
    #[serde(default)]
    pub use_count: u64,
    #[serde(default)]
    pub patch_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_viewed_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_patched_at: Option<DateTime<Utc>>,
    #[serde(default = "default_timestamp")]
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub state: SkillState,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<SkillQuality>,
}

impl SkillTelemetry {
    fn new(name: &str, now: DateTime<Utc>) -> Self {
        Self {
            name: name.to_string(),
            view_count: 0,
            use_count: 0,
            patch_count: 0,
            last_viewed_at: None,
            last_used_at: None,
            last_patched_at: None,
            created_at: now,
            state: SkillState::Active,
            pinned: false,
            quality: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillTelemetryStore {
    #[serde(default = "default_usage_store_version")]
    pub version: u32,
    #[serde(default)]
    pub skills: BTreeMap<String, SkillTelemetry>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillRedundancyEstimate {
    pub name: String,
    pub score: f64,
}

impl Default for SkillTelemetryStore {
    fn default() -> Self {
        Self {
            version: USAGE_STORE_VERSION,
            skills: BTreeMap::new(),
        }
    }
}

fn default_usage_store_version() -> u32 {
    USAGE_STORE_VERSION
}

fn default_timestamp() -> DateTime<Utc> {
    Utc::now()
}

#[derive(Debug, Clone, Copy)]
pub enum SkillTelemetryEvent {
    View,
    Use,
    Patch,
}

pub(crate) fn usage_query(cwd: &Path, name: Option<&str>) -> Result<Value, ToolError> {
    let root = project_skills_root(cwd);
    let output = match name {
        None => {
            let stores = load_usage_query_stores(cwd).map_err(to_tool_error)?;
            let project_store = stores
                .iter()
                .find(|store| store.scope == "project")
                .map(|store| &store.store)
                .ok_or_else(|| {
                    ToolError::Execution("project usage store was not loaded".to_string())
                })?;
            serde_json::json!({
                "success": true,
                "path": usage_path(&root).display().to_string(),
                "paths": usage_query_paths_json(&stores),
                "skills": project_store.skills.values().collect::<Vec<_>>(),
                "records": usage_records_json(&stores),
            })
        }
        Some(name) => {
            let stores = load_usage_query_stores(cwd).map_err(to_tool_error)?;
            let record = find_usage_record(&stores, name).ok_or_else(|| {
                ToolError::InvalidInput(format!("usage for skill '{name}' was not found"))
            })?;
            serde_json::json!({
                "success": true,
                "path": usage_path(record.root).display().to_string(),
                "scope": record.scope,
                "usage": record.usage,
            })
        }
    };
    Ok(output)
}

pub fn record_skill_view(cwd: &Path, name: &str) {
    record_skill_event(cwd, name, SkillTelemetryEvent::View);
}

pub fn record_skill_view_for_source(cwd: &Path, name: &str, source: &Path) {
    record_skill_event_for_source(cwd, name, source, SkillTelemetryEvent::View);
}

pub fn record_skill_use(cwd: &Path, name: &str) {
    record_skill_event(cwd, name, SkillTelemetryEvent::Use);
}

pub fn record_skill_use_for_source(cwd: &Path, name: &str, source: &Path) {
    record_skill_event_for_source(cwd, name, source, SkillTelemetryEvent::Use);
}

pub fn record_skill_patch(cwd: &Path, name: &str) {
    let root = project_skills_root(cwd);
    let mut patch = kcoder_skills::SkillMetadataPatch::default();
    patch.increment.insert("patch_count".to_string(), 1);
    patch
        .update
        .insert("last_patched_at".to_string(), serde_json::json!(Utc::now()));
    if let Err(error) = commit_usage_metadata(&root, name, patch, "record_skill_patch") {
        warn!("failed to record skill patch telemetry: {error}");
    }
}

pub fn record_skill_created(cwd: &Path, name: &str) {
    let root = project_skills_root(cwd);
    record_skill_created_at(&root, name);
}

pub fn record_skill_created_at(root: &Path, name: &str) {
    let mut patch = kcoder_skills::SkillMetadataPatch::default();
    patch
        .create
        .insert("created_at".to_string(), serde_json::json!(Utc::now()));
    patch
        .create
        .insert("state".to_string(), serde_json::json!("active"));
    patch
        .create
        .insert("pinned".to_string(), serde_json::json!(false));
    if let Err(e) = commit_usage_metadata(root, name, patch, "record_skill_created") {
        warn!("failed to record skill creation telemetry: {}", e);
    }
}

pub fn record_skill_created_for_source(cwd: &Path, name: &str, source: &Path) {
    let root = usage_root_for_source(cwd, source);
    record_skill_created_at(&root, name);
}

pub fn set_skill_state(cwd: &Path, name: &str, state: SkillState) -> anyhow::Result<()> {
    let root = project_skills_root(cwd);
    set_skill_state_at(&root, name, state)
}

pub fn set_skill_state_at(root: &Path, name: &str, state: SkillState) -> anyhow::Result<()> {
    let mut patch = kcoder_skills::SkillMetadataPatch::default();
    patch
        .update
        .insert("state".to_string(), serde_json::to_value(state)?);
    commit_usage_metadata(root, name, patch, "set_skill_state")
}

pub fn set_skill_pinned(cwd: &Path, name: &str, pinned: bool) -> anyhow::Result<()> {
    let root = project_skills_root(cwd);
    let mut patch = kcoder_skills::SkillMetadataPatch::default();
    patch
        .update
        .insert("pinned".to_string(), serde_json::json!(pinned));
    commit_usage_metadata(&root, name, patch, "set_skill_pinned")
}

pub fn load_project_usage(cwd: &Path) -> anyhow::Result<SkillTelemetryStore> {
    load_store(&project_skills_root(cwd))
}

pub fn refresh_quality_scores(
    root: &Path,
    name_filter: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    let mut store = load_store(root)?;
    let changed = score_quality_in_store(root, &mut store, name_filter)?;
    if changed.is_empty() {
        return Ok(changed);
    }
    let mut patches = BTreeMap::new();
    for name in &changed {
        let mut patch = kcoder_skills::SkillMetadataPatch::default();
        patch.update.insert(
            "quality".to_string(),
            serde_json::to_value(
                store
                    .skills
                    .get(name)
                    .and_then(|record| record.quality.as_ref()),
            )?,
        );
        patches.insert(name.clone(), patch);
    }
    kcoder_skills::SkillStore::open(root)?.commit(kcoder_skills::SkillCommitRequest {
        operation_id: format!("usage-quality:{}", uuid::Uuid::new_v4()),
        actor: kcoder_skills::SkillMutationActor::System {
            component: "refresh_quality_scores".to_string(),
            session_id: None,
        },
        operation: kcoder_skills::SkillOperationKind::MetadataOnly,
        preconditions: Vec::new(),
        mutations: Vec::new(),
        metadata: kcoder_skills::SkillMetadataDelta {
            usage: patches,
            ..Default::default()
        },
    })?;
    Ok(changed)
}

pub fn score_quality_in_store(
    root: &Path,
    store: &mut SkillTelemetryStore,
    name_filter: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    let names = name_filter.map(|name| BTreeSet::from([name.to_string()]));
    score_quality_in_store_for_name_set(root, store, names.as_ref(), name_filter)
}

pub fn score_quality_in_store_for_names(
    root: &Path,
    store: &mut SkillTelemetryStore,
    names: &BTreeSet<String>,
) -> anyhow::Result<Vec<String>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    score_quality_in_store_for_name_set(root, store, Some(names), None)
}

fn score_quality_in_store_for_name_set(
    root: &Path,
    store: &mut SkillTelemetryStore,
    names: Option<&BTreeSet<String>>,
    required_name: Option<&str>,
) -> anyhow::Result<Vec<String>> {
    let contents = load_skill_contents(root)?;
    let mut changed = Vec::new();
    let mut matched = false;
    let now = Utc::now();

    for (name, content) in &contents {
        if names.is_some_and(|names| !names.contains(name)) {
            continue;
        }
        matched = true;
        let usage = ensure_usage(store, name, now);
        let redundancy = max_redundancy(name, content, &contents);
        let specificity = specificity_score(content);
        let helpful = helpful_score(usage);
        let next_quality = SkillQuality {
            helpful_score: Some(helpful),
            redundancy_score: Some(redundancy),
            specificity_score: Some(specificity),
            notes: Some("heuristic quality score".to_string()),
            updated_at: now,
        };
        if usage
            .quality
            .as_ref()
            .is_none_or(|quality| !quality_scores_equal(quality, &next_quality))
        {
            usage.quality = Some(next_quality);
            changed.push(name.clone());
        }
    }

    if !matched && let Some(name_filter) = required_name {
        anyhow::bail!("skill '{}' was not found under {:?}", name_filter, root);
    }

    Ok(changed)
}

pub fn most_redundant_skill_for_content(
    root: &Path,
    candidate_name: &str,
    candidate_content: &str,
) -> anyhow::Result<Option<SkillRedundancyEstimate>> {
    let mut contents = load_skill_contents(root)?;
    if contents.is_empty() {
        return Ok(None);
    }
    contents.insert(candidate_name.to_string(), candidate_content.to_string());
    let document_count = contents.len();
    let frequencies = document_frequencies(contents.values());
    let candidate_vector = tf_idf_vector(candidate_content, &frequencies, document_count);
    if candidate_vector.is_empty() {
        return Ok(None);
    }

    Ok(contents
        .iter()
        .filter(|(name, _)| name.as_str() != candidate_name)
        .filter_map(|(name, content)| {
            let vector = tf_idf_vector(content, &frequencies, document_count);
            let score = cosine_similarity(&candidate_vector, &vector);
            (score > 0.0).then(|| SkillRedundancyEstimate {
                name: name.clone(),
                score,
            })
        })
        .max_by(|left, right| {
            left.score
                .partial_cmp(&right.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        }))
}

fn quality_scores_equal(left: &SkillQuality, right: &SkillQuality) -> bool {
    left.helpful_score == right.helpful_score
        && left.redundancy_score == right.redundancy_score
        && left.specificity_score == right.specificity_score
        && left.notes == right.notes
}

pub fn project_skills_root(cwd: &Path) -> PathBuf {
    crate::skill_provenance::project_skills_root(cwd)
}

pub fn usage_path(root: &Path) -> PathBuf {
    root.join(USAGE_FILE)
}

#[derive(Debug)]
struct UsageQueryStore {
    scope: &'static str,
    root: PathBuf,
    store: SkillTelemetryStore,
}

#[derive(Debug)]
struct UsageQueryRecord<'a> {
    scope: &'static str,
    root: &'a Path,
    usage: &'a SkillTelemetry,
}

fn load_usage_query_stores(cwd: &Path) -> anyhow::Result<Vec<UsageQueryStore>> {
    load_usage_query_stores_for_roots(project_skills_root(cwd), user_skills_root())
}

fn load_usage_query_stores_for_roots(
    project_root: PathBuf,
    user_root: Option<PathBuf>,
) -> anyhow::Result<Vec<UsageQueryStore>> {
    let project_store = load_store(&project_root)?;
    let mut stores = vec![UsageQueryStore {
        scope: "project",
        root: project_root.clone(),
        store: project_store,
    }];

    if let Some(user_root) = user_root
        && user_root != project_root
        && usage_path(&user_root).is_file()
    {
        match load_store(&user_root) {
            Ok(store) => stores.push(UsageQueryStore {
                scope: "user",
                store,
                root: user_root,
            }),
            Err(error) => warn!(
                "failed to load user skill usage telemetry from {}: {}",
                usage_path(&user_root).display(),
                error
            ),
        }
    }

    Ok(stores)
}

fn usage_query_paths_json(stores: &[UsageQueryStore]) -> Vec<Value> {
    stores
        .iter()
        .map(|store| {
            serde_json::json!({
                "scope": store.scope,
                "path": usage_path(&store.root).display().to_string(),
                "count": store.store.skills.len(),
            })
        })
        .collect()
}

fn usage_records_json(stores: &[UsageQueryStore]) -> Vec<Value> {
    stores
        .iter()
        .flat_map(|store| {
            store
                .store
                .skills
                .values()
                .map(|usage| usage_record_json(store.scope, &store.root, usage))
        })
        .collect()
}

fn usage_record_json(scope: &str, root: &Path, usage: &SkillTelemetry) -> Value {
    serde_json::json!({
        "scope": scope,
        "path": usage_path(root).display().to_string(),
        "usage": usage,
    })
}

fn find_usage_record<'a>(
    stores: &'a [UsageQueryStore],
    name: &str,
) -> Option<UsageQueryRecord<'a>> {
    stores.iter().find_map(|store| {
        store.store.skills.get(name).map(|usage| UsageQueryRecord {
            scope: store.scope,
            root: &store.root,
            usage,
        })
    })
}

fn record_skill_event(cwd: &Path, name: &str, event: SkillTelemetryEvent) {
    let root = project_skills_root(cwd);
    if let Err(e) = update_usage(&root, name, Some(event)) {
        warn!("failed to record skill usage telemetry: {}", e);
    }
}

fn record_skill_event_for_source(
    cwd: &Path,
    name: &str,
    source: &Path,
    event: SkillTelemetryEvent,
) {
    let root = usage_root_for_source(cwd, source);
    if let Err(e) = update_usage(&root, name, Some(event)) {
        warn!("failed to record skill usage telemetry: {}", e);
    }
}

pub(crate) fn usage_root_for_source(cwd: &Path, source: &Path) -> PathBuf {
    let project_root = project_skills_root(cwd);
    if crate::sandbox::path_starts_with(source, &project_root) {
        return project_root;
    }
    if let Some(user_root) = user_skills_root()
        && crate::sandbox::path_starts_with(source, &user_root)
    {
        return user_root;
    }
    project_root
}

fn user_skills_root() -> Option<PathBuf> {
    kcoder_config::user_config_dir()
        .ok()
        .map(|dir| dir.join("skills"))
}

#[cfg(test)]
fn user_skills_root_with_override(override_dir: Option<std::ffi::OsString>) -> Option<PathBuf> {
    override_dir
        .filter(|dir| !dir.is_empty())
        .map(|dir| PathBuf::from(dir).join("skills"))
}

fn update_usage(root: &Path, name: &str, event: Option<SkillTelemetryEvent>) -> anyhow::Result<()> {
    update_store_locked(root, |store| {
        let usage = ensure_usage(store, name, Utc::now());
        let now = Utc::now();
        match event {
            Some(SkillTelemetryEvent::View) => {
                usage.view_count += 1;
                usage.last_viewed_at = Some(now);
            }
            Some(SkillTelemetryEvent::Use) => {
                usage.use_count += 1;
                usage.last_used_at = Some(now);
            }
            Some(SkillTelemetryEvent::Patch) => {
                usage.patch_count += 1;
                usage.last_patched_at = Some(now);
            }
            None => {}
        }
        Ok(())
    })
}

fn commit_usage_metadata(
    root: &Path,
    name: &str,
    patch: kcoder_skills::SkillMetadataPatch,
    component: &str,
) -> anyhow::Result<()> {
    kcoder_skills::SkillStore::open(root)?.commit(kcoder_skills::SkillCommitRequest {
        operation_id: format!("usage-{component}:{}", uuid::Uuid::new_v4()),
        actor: kcoder_skills::SkillMutationActor::System {
            component: component.to_string(),
            session_id: None,
        },
        operation: kcoder_skills::SkillOperationKind::MetadataOnly,
        preconditions: Vec::new(),
        mutations: Vec::new(),
        metadata: kcoder_skills::SkillMetadataDelta {
            usage: BTreeMap::from([(name.to_string(), patch)]),
            ..Default::default()
        },
    })?;
    Ok(())
}

/// Serialize every read-modify-write of `usage.json` across both threads and
/// processes. All mutating entry points must use this helper so pin/state/
/// quality updates cannot overwrite telemetry counters (or vice versa).
pub(crate) fn update_store_locked<T>(
    root: &Path,
    update: impl FnOnce(&mut SkillTelemetryStore) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let _lock = kcoder_memory::MemoryFileLock::acquire(&usage_path(root))?;
    let mut store = load_store(root)?;
    let result = update(&mut store)?;
    save_store(root, &store)?;
    Ok(result)
}

fn ensure_usage<'a>(
    store: &'a mut SkillTelemetryStore,
    name: &str,
    now: DateTime<Utc>,
) -> &'a mut SkillTelemetry {
    store
        .skills
        .entry(name.to_string())
        .or_insert_with(|| SkillTelemetry::new(name, now))
}

pub fn load_store(root: &Path) -> anyhow::Result<SkillTelemetryStore> {
    let path = usage_path(root);
    if !path.is_file() {
        return Ok(SkillTelemetryStore::default());
    }
    let content = std::fs::read_to_string(&path)?;
    if content.trim().is_empty() {
        return Ok(SkillTelemetryStore::default());
    }
    let mut stream =
        serde_json::Deserializer::from_str(&content).into_iter::<SkillTelemetryStore>();
    let mut store = stream
        .next()
        .transpose()?
        .unwrap_or_else(SkillTelemetryStore::default);
    let trailing = &content[stream.byte_offset()..];
    if !trailing.trim().is_empty() {
        warn!(
            "skill usage telemetry at {} contains trailing data; ignoring trailing bytes",
            path.display()
        );
    }
    normalize_usage_store(&mut store);
    Ok(store)
}

pub fn save_store(root: &Path, store: &SkillTelemetryStore) -> anyhow::Result<()> {
    std::fs::create_dir_all(root)?;
    atomic_write(&usage_path(root), &serde_json::to_string_pretty(store)?)
}

fn normalize_usage_store(store: &mut SkillTelemetryStore) {
    for (name, usage) in &mut store.skills {
        if usage.name.trim().is_empty() {
            usage.name = name.clone();
        }
    }
}

fn atomic_write(path: &Path, content: &str) -> anyhow::Result<()> {
    // Unique tmp name per process: two writers racing the rename must not
    // unlink each other's temp file.
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn to_tool_error(error: anyhow::Error) -> ToolError {
    ToolError::Execution(error.to_string())
}

fn load_skill_contents(root: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let mut contents = BTreeMap::new();
    if !root.is_dir() {
        return Ok(contents);
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let skill_path = entry.path().join("SKILL.md");
        if skill_path.is_file() {
            contents.insert(name.into_owned(), fs::read_to_string(skill_path)?);
        }
    }
    Ok(contents)
}

fn max_redundancy(name: &str, content: &str, all_contents: &BTreeMap<String, String>) -> f64 {
    let document_count = all_contents.len();
    if document_count <= 1 {
        return 0.0;
    }
    let frequencies = document_frequencies(all_contents.values());
    let vector = tf_idf_vector(content, &frequencies, document_count);
    if vector.is_empty() {
        return 0.0;
    }
    all_contents
        .iter()
        .filter(|(other_name, _)| other_name.as_str() != name)
        .map(|(_, other)| {
            let other_vector = tf_idf_vector(other, &frequencies, document_count);
            cosine_similarity(&vector, &other_vector)
        })
        .fold(0.0, f64::max)
}

fn document_frequencies<'a>(contents: impl Iterator<Item = &'a String>) -> BTreeMap<String, usize> {
    let mut frequencies = BTreeMap::new();
    for content in contents {
        let unique_tokens: BTreeSet<String> = token_counts(content).into_keys().collect();
        for token in unique_tokens {
            *frequencies.entry(token).or_default() += 1;
        }
    }
    frequencies
}

fn tf_idf_vector(
    content: &str,
    frequencies: &BTreeMap<String, usize>,
    document_count: usize,
) -> BTreeMap<String, f64> {
    let counts = token_counts(content);
    let total_terms = counts.values().sum::<usize>();
    if total_terms == 0 {
        return BTreeMap::new();
    }
    counts
        .into_iter()
        .map(|(token, count)| {
            let term_frequency = count as f64 / total_terms as f64;
            let document_frequency = frequencies.get(&token).copied().unwrap_or_default() as f64;
            let inverse_document_frequency =
                ((document_count as f64 + 1.0) / (document_frequency + 1.0)).ln() + 1.0;
            (token, term_frequency * inverse_document_frequency)
        })
        .collect()
}

fn token_counts(content: &str) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for token in content.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        let token = token.trim().to_ascii_lowercase();
        if token.len() >= 3 {
            *counts.entry(token).or_default() += 1;
        }
    }
    counts
}

fn cosine_similarity(left: &BTreeMap<String, f64>, right: &BTreeMap<String, f64>) -> f64 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let dot = left
        .iter()
        .filter_map(|(token, left_weight)| {
            right
                .get(token)
                .map(|right_weight| left_weight * right_weight)
        })
        .sum::<f64>();
    let left_norm = left
        .values()
        .map(|weight| weight * weight)
        .sum::<f64>()
        .sqrt();
    let right_norm = right
        .values()
        .map(|weight| weight * weight)
        .sum::<f64>()
        .sqrt();
    if left_norm == 0.0 || right_norm == 0.0 {
        0.0
    } else {
        round_score(dot / (left_norm * right_norm))
    }
}

fn specificity_score(content: &str) -> f64 {
    let lower = content.to_ascii_lowercase();
    let mut score = 0.0;
    score += (content.matches("```").count() as f64 * 0.12).min(0.24);
    score += (content
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.starts_with("- ") || trimmed.starts_with("* ")
        })
        .count() as f64
        * 0.04)
        .min(0.24);
    score += (content
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            trimmed.chars().next().is_some_and(|ch| ch.is_ascii_digit()) && trimmed.contains(". ")
        })
        .count() as f64
        * 0.05)
        .min(0.20);
    for signal in [
        "cargo ",
        "git ",
        "test",
        "verify",
        "run ",
        "error",
        "avoid",
        "before completion",
    ] {
        if lower.contains(signal) {
            score += 0.04;
        }
    }
    round_score(score.min(1.0))
}

fn helpful_score(usage: &SkillTelemetry) -> f64 {
    let views = usage.view_count.max(1) as f64;
    let use_ratio = (usage.use_count as f64 / views).min(1.0);
    let patch_signal = (usage.patch_count as f64 * 0.08).min(0.24);
    let pin_signal = if usage.pinned { 0.16 } else { 0.0 };
    round_score((use_ratio * 0.60 + patch_signal + pin_signal).min(1.0))
}

fn round_score(score: f64) -> f64 {
    (score * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn usage_store_defaults_and_legacy_json_use_version_one() {
        assert_eq!(SkillTelemetryStore::default().version, USAGE_STORE_VERSION);

        let legacy: SkillTelemetryStore = serde_json::from_str(r#"{"skills":{}}"#).unwrap();
        assert_eq!(legacy.version, USAGE_STORE_VERSION);
        assert!(legacy.skills.is_empty());
    }

    #[test]
    fn save_store_writes_usage_store_version() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");

        save_store(&skills, &SkillTelemetryStore::default()).unwrap();

        let raw = std::fs::read_to_string(skills.join(".usage.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], USAGE_STORE_VERSION);
    }

    #[test]
    fn concurrent_metadata_and_telemetry_updates_do_not_overwrite_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder").join("skills");
        let barrier = Arc::new(Barrier::new(3));

        let telemetry_root = root.clone();
        let telemetry_barrier = Arc::clone(&barrier);
        let telemetry = std::thread::spawn(move || {
            telemetry_barrier.wait();
            update_usage(&telemetry_root, "demo", Some(SkillTelemetryEvent::Use)).unwrap();
        });

        let metadata_root = root.clone();
        let metadata_barrier = Arc::clone(&barrier);
        let metadata = std::thread::spawn(move || {
            metadata_barrier.wait();
            update_store_locked(&metadata_root, |store| {
                ensure_usage(store, "demo", Utc::now()).pinned = true;
                Ok(())
            })
            .unwrap();
        });

        barrier.wait();
        telemetry.join().unwrap();
        metadata.join().unwrap();

        let usage = load_store(&root).unwrap().skills.remove("demo").unwrap();
        assert_eq!(usage.use_count, 1);
        assert!(usage.pinned);
    }

    #[test]
    fn load_store_backfills_legacy_usage_record_names_and_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(
            skills.join(".usage.json"),
            r#"{"skills":{"demo":{"view_count":2}}}"#,
        )
        .unwrap();

        let store = load_store(&skills).unwrap();

        let usage = store.skills.get("demo").unwrap();
        assert_eq!(usage.name, "demo");
        assert_eq!(usage.view_count, 2);
        assert_eq!(usage.use_count, 0);
        assert_eq!(usage.patch_count, 0);
        assert_eq!(usage.state, SkillState::Active);
    }

    #[test]
    fn load_store_ignores_trailing_usage_file_garbage_and_rewrites_clean_json() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(
            skills.join(".usage.json"),
            r#"{"skills":{"demo":{"view_count":2}}}stale tail"#,
        )
        .unwrap();

        let store = load_store(&skills).unwrap();

        assert_eq!(store.skills["demo"].view_count, 2);

        update_usage(&skills, "next", None).unwrap();
        let raw = std::fs::read_to_string(skills.join(".usage.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value["skills"]["demo"].is_object());
        assert!(value["skills"]["next"].is_object());
    }

    #[test]
    fn records_usage_counts_without_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&skills).unwrap();

        record_skill_view(tmp.path(), "demo");
        record_skill_use(tmp.path(), "demo");
        record_skill_patch(tmp.path(), "demo");

        let store = load_project_usage(tmp.path()).unwrap();
        let usage = store.skills.get("demo").unwrap();
        assert_eq!(usage.view_count, 1);
        assert_eq!(usage.use_count, 1);
        assert_eq!(usage.patch_count, 1);
        assert_eq!(usage.state, SkillState::Active);
        assert!(usage.last_viewed_at.is_some());
        assert!(usage.last_used_at.is_some());
        assert!(usage.last_patched_at.is_some());
    }

    #[test]
    fn usage_root_for_source_routes_user_skill_to_user_store() {
        let Some(user_root) = user_skills_root() else {
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        let project_root = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&project_root).unwrap();

        let project_source = project_root.join("project-demo").join("SKILL.md");
        let user_source = user_root.join("user-demo").join("SKILL.md");

        assert_eq!(
            usage_root_for_source(tmp.path(), &project_source),
            project_root
        );
        assert_eq!(usage_root_for_source(tmp.path(), &user_source), user_root);
    }

    #[test]
    fn record_skill_created_for_source_records_external_source_in_project_store() {
        let tmp = tempfile::tempdir().unwrap();
        let project_root = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&project_root).unwrap();
        let external = tempfile::tempdir().unwrap();
        let external_source = external.path().join("team-demo").join("SKILL.md");

        record_skill_created_for_source(tmp.path(), "team-demo", &external_source);

        let store = load_project_usage(tmp.path()).unwrap();
        let usage = store.skills.get("team-demo").unwrap();
        assert_eq!(usage.name, "team-demo");
        assert_eq!(usage.state, SkillState::Active);
        assert_eq!(usage.use_count, 0);
    }

    #[test]
    fn usage_query_stores_include_user_usage_when_file_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let project_root = tmp.path().join("project-skills");
        let user_root = tmp.path().join("user-skills");
        let now = Utc::now();
        let mut project_store = SkillTelemetryStore::default();
        project_store.skills.insert(
            "project-demo".to_string(),
            SkillTelemetry::new("project-demo", now),
        );
        let mut user_store = SkillTelemetryStore::default();
        user_store.skills.insert(
            "user-demo".to_string(),
            SkillTelemetry::new("user-demo", now),
        );
        save_store(&project_root, &project_store).unwrap();
        save_store(&user_root, &user_store).unwrap();

        let stores =
            load_usage_query_stores_for_roots(project_root.clone(), Some(user_root.clone()))
                .unwrap();

        assert_eq!(stores.len(), 2);
        assert_eq!(stores[0].scope, "project");
        assert_eq!(stores[0].root, project_root);
        assert_eq!(stores[1].scope, "user");
        assert_eq!(stores[1].root, user_root);
        assert!(stores[0].store.skills.contains_key("project-demo"));
        assert!(stores[1].store.skills.contains_key("user-demo"));

        let records = usage_records_json(&stores);
        assert!(
            records.iter().any(|record| {
                record["scope"] == "user" && record["usage"]["name"] == "user-demo"
            })
        );
    }

    #[test]
    fn usage_query_stores_skip_invalid_user_usage_without_blocking_project_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let project_root = tmp.path().join("project-skills");
        let user_root = tmp.path().join("user-skills");
        let now = Utc::now();
        let mut project_store = SkillTelemetryStore::default();
        project_store.skills.insert(
            "project-demo".to_string(),
            SkillTelemetry::new("project-demo", now),
        );
        save_store(&project_root, &project_store).unwrap();
        std::fs::create_dir_all(&user_root).unwrap();
        std::fs::write(usage_path(&user_root), r#"{"skills":"#).unwrap();

        let stores =
            load_usage_query_stores_for_roots(project_root.clone(), Some(user_root)).unwrap();

        assert_eq!(stores.len(), 1);
        assert_eq!(stores[0].scope, "project");
        assert_eq!(stores[0].root, project_root);
        assert!(stores[0].store.skills.contains_key("project-demo"));
    }

    #[test]
    fn usage_query_view_prefers_project_usage_over_user_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let project_root = tmp.path().join("project-skills");
        let user_root = tmp.path().join("user-skills");
        let now = Utc::now();
        let mut project_store = SkillTelemetryStore::default();
        let mut project_usage = SkillTelemetry::new("demo", now);
        project_usage.view_count = 7;
        project_store
            .skills
            .insert("demo".to_string(), project_usage);
        let mut user_store = SkillTelemetryStore::default();
        let mut user_usage = SkillTelemetry::new("demo", now);
        user_usage.view_count = 3;
        user_store.skills.insert("demo".to_string(), user_usage);
        save_store(&project_root, &project_store).unwrap();
        save_store(&user_root, &user_store).unwrap();

        let stores =
            load_usage_query_stores_for_roots(project_root.clone(), Some(user_root)).unwrap();
        let record = find_usage_record(&stores, "demo").unwrap();

        assert_eq!(record.scope, "project");
        assert_eq!(record.root, project_root);
        assert_eq!(record.usage.view_count, 7);
    }

    #[test]
    fn pins_and_marks_state() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(&skills).unwrap();

        set_skill_pinned(tmp.path(), "demo", true).unwrap();
        set_skill_state(tmp.path(), "demo", SkillState::Stale).unwrap();

        let store = load_project_usage(tmp.path()).unwrap();
        let usage = store.skills.get("demo").unwrap();
        assert!(usage.pinned);
        assert_eq!(usage.state, SkillState::Stale);
    }

    #[test]
    fn refresh_quality_scores_records_redundancy_and_specificity() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(skills.join("alpha")).unwrap();
        std::fs::create_dir_all(skills.join("beta")).unwrap();
        let shared_workflow = "\n# Shared Review Workflow\n\n1. Run cargo test.\n2. Run cargo fmt.\n3. Verify output.\n4. Review failure logs.\n5. Avoid duplicate setup.\n```bash\ncargo test\ncargo fmt\n```";
        std::fs::write(
            skills.join("alpha").join("SKILL.md"),
            format!("---\nname: alpha\ndescription: Alpha\n---\n{shared_workflow}"),
        )
        .unwrap();
        std::fs::write(
            skills.join("beta").join("SKILL.md"),
            format!("---\nname: beta\ndescription: Beta\n---\n{shared_workflow}"),
        )
        .unwrap();
        record_skill_view(tmp.path(), "alpha");
        record_skill_use(tmp.path(), "alpha");

        let scored = refresh_quality_scores(&skills, None).unwrap();

        assert_eq!(scored, vec!["alpha".to_string(), "beta".to_string()]);
        let store = load_project_usage(tmp.path()).unwrap();
        let quality = store.skills.get("alpha").unwrap().quality.as_ref().unwrap();
        assert!(quality.helpful_score.unwrap() > 0.0);
        assert!(quality.redundancy_score.unwrap() > 0.5);
        assert!(quality.specificity_score.unwrap() > 0.3);
        let first_updated_at = quality.updated_at;

        let rescored = refresh_quality_scores(&skills, None).unwrap();

        assert!(
            rescored.is_empty(),
            "unchanged quality scores should not be rewritten"
        );
        let store = load_project_usage(tmp.path()).unwrap();
        let quality = store.skills.get("alpha").unwrap().quality.as_ref().unwrap();
        assert_eq!(quality.updated_at, first_updated_at);
    }

    #[test]
    fn redundancy_score_uses_tfidf_cosine_term_frequency() {
        let mut contents = BTreeMap::new();
        contents.insert("alpha".to_string(), "cargo cargo cargo deploy".to_string());
        contents.insert("beta".to_string(), "cargo deploy deploy deploy".to_string());

        let redundancy = max_redundancy("alpha", contents.get("alpha").unwrap(), &contents);

        assert!(
            redundancy > 0.5 && redundancy < 0.9,
            "term-frequency cosine should not collapse to token-set overlap: {redundancy}"
        );
    }

    #[test]
    fn most_redundant_skill_for_content_returns_best_match() {
        let tmp = tempfile::tempdir().unwrap();
        let skills = tmp.path().join(".kcoder").join("skills");
        std::fs::create_dir_all(skills.join("review-workflow")).unwrap();
        std::fs::create_dir_all(skills.join("deploy-workflow")).unwrap();
        let review_body = "# Review Workflow\n\n1. Run cargo test.\n2. Run cargo fmt.\n3. Verify output.\n4. Review failure logs.\n5. Avoid duplicate setup.\n";
        std::fs::write(
            skills.join("review-workflow").join("SKILL.md"),
            format!("---\nname: review-workflow\ndescription: Review\n---\n\n{review_body}"),
        )
        .unwrap();
        std::fs::write(
            skills.join("deploy-workflow").join("SKILL.md"),
            "---\nname: deploy-workflow\ndescription: Deploy\n---\n\n# Deploy\n\nShip a release after tagging.",
        )
        .unwrap();
        let candidate =
            format!("---\nname: review-copy\ndescription: Review Copy\n---\n\n{review_body}");

        let estimate = most_redundant_skill_for_content(&skills, "review-copy", &candidate)
            .unwrap()
            .unwrap();

        assert_eq!(estimate.name, "review-workflow");
        assert!(estimate.score >= HIGH_REDUNDANCY_THRESHOLD);
    }

    #[test]
    fn user_skills_root_honours_config_dir_env() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = user_skills_root_with_override(Some(tmp.path().as_os_str().to_owned()));
        assert_eq!(resolved, Some(tmp.path().join("skills")));
    }
}
