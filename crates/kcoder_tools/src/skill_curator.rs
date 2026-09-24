use crate::skill_provenance::{SkillOrigin, SkillProvenanceStore, load_project_provenance};
use crate::skill_telemetry::{SkillState, load_store, project_skills_root};
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use flate2::Compression;
use flate2::write::GzEncoder;
use kcoder_skills::{
    ExpectedSkillRevision, SkillCommitReceipt, SkillCommitRequest, SkillMetadataDelta,
    SkillMetadataPatch, SkillMetadataPrecondition, SkillMetadataPredicate, SkillMetadataStore,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile,
    SkillStore,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const DEFAULT_STALE_AFTER_DAYS: i64 = 30;
const DEFAULT_ARCHIVE_AFTER_DAYS: i64 = 90;
const BACKUPS_DIR: &str = ".backups";
const QUALITY_RETAIN_HELPFUL_SCORE: f64 = 0.75;
const QUALITY_RETAIN_SPECIFICITY_SCORE: f64 = 0.75;
const MAX_PATCHED_SUPPORTING_FILE_BYTES: usize = 1_048_576;
const PATCHABLE_SUPPORTING_DIRS: &[&str] = &["references", "templates", "scripts", "assets"];

/// Curate the project skill lifecycle using usage/provenance telemetry.
#[derive(Debug, Default)]
pub struct SkillCuratorTool;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillCuratorAction {
    Status,
    Run,
    Pin,
    Unpin,
    Archive,
    Restore,
    Consolidate,
    ReviewAndPatch,
    Usage,
    MarkState,
    ScoreQuality,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SkillCuratorInput {
    /// Action to perform. `run` marks eligible AgentCreated skills stale and
    /// archives eligible stale AgentCreated skills; `status` reports usage/provenance; `pin`/`unpin`
    /// protect a skill from automatic archiving; `archive`/`restore` move a
    /// project skill into or out of `.kcoder/skills/.archive/`; `consolidate`
    /// creates an umbrella skill from multiple targets and archives them.
    pub action: SkillCuratorAction,
    /// Skill name. Required for pin/unpin/archive/restore. Also accepted as
    /// the destination name for consolidate when `into` is omitted.
    #[serde(default)]
    pub name: Option<String>,
    /// New lifecycle state. Required for mark_state.
    #[serde(default)]
    pub state: Option<SkillState>,
    /// Destination umbrella skill name for consolidate.
    #[serde(default)]
    pub into: Option<String>,
    /// Source skill names for consolidate.
    #[serde(default)]
    pub targets: Vec<String>,
    /// File to patch for review_and_patch. Defaults to SKILL.md. Supporting
    /// files must be under references/, templates/, scripts/, or assets/.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Exact existing string to replace for review_and_patch.
    #[serde(default)]
    pub old_string: Option<String>,
    /// Replacement string for review_and_patch.
    #[serde(default)]
    pub new_string: Option<String>,
    /// Replace every occurrence instead of the first occurrence.
    #[serde(default)]
    pub replace_all: bool,
    /// Short explanation from the reviewer/sub-agent for audit logs.
    #[serde(default)]
    pub review_notes: Option<String>,
    /// Override stale threshold in days for `run`. Defaults to 30.
    #[serde(default)]
    pub stale_after_days: Option<i64>,
    /// Override archive threshold in days for `run`. Defaults to 90.
    #[serde(default)]
    pub archive_after_days: Option<i64>,
    /// If true, `run` and `review_and_patch` only report planned changes
    /// without writing files.
    #[serde(default)]
    pub dry_run: bool,
    /// If true, `run`, manual `archive`, and `consolidate` may process
    /// non-AgentCreated, non-bundled skills. Defaults to false so user,
    /// hub-installed, and external-dir skills are not archived by accident.
    #[serde(default)]
    pub include_non_agent_created: bool,
    /// If true, `run`, manual `archive`, and `consolidate` may process bundled
    /// skills. This is intentionally separate from `include_non_agent_created`
    /// so built-in skills are only archived by an explicit prune_builtins path.
    #[serde(default)]
    pub include_bundled: bool,
}

#[derive(Debug, Serialize)]
struct CuratorResult {
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    actions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

#[async_trait]
impl Tool for SkillCuratorTool {
    fn name(&self) -> String {
        "skill_curator".to_string()
    }

    fn description(&self) -> String {
        "Govern the lifecycle of KCoder project skills using `.usage.json` and \
         `.provenance.json` — the housekeeping layer: stale detection, archiving, \
         and consolidation, not authoring or invoking. Use `status` to inspect skill health, `run` to mark \
         eligible AgentCreated skills stale and archive eligible AgentCreated skills, `pin`/`unpin` to \
         protect a skill from archiving, `usage` to inspect counters (optionally for one name), `mark_state` and `score_quality` to maintain telemetry, `archive`/`restore` to manually move skills under \
         `.kcoder/skills/.archive/`, `consolidate` to merge several narrow skills \
         into one new umbrella skill and archive the originals (one operation; different from \
         archiving each and recreating by hand), and \
         `review_and_patch` to apply an audited exact-string skill patch after \
         reviewer/sub-agent analysis. Authoring, activation, and bundled synchronization require separate attached controls."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SkillCuratorInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SkillCuratorInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let root = project_skills_root(&cwd);
        if matches!(input.action, SkillCuratorAction::Usage) {
            let output = crate::skill_telemetry::usage_query(&cwd, input.name.as_deref())?;
            return serde_json::to_string_pretty(&output)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize curator usage: {e}"))
                });
        }
        if matches!(input.action, SkillCuratorAction::ScoreQuality) {
            let worker_ctx = ctx.clone();
            let worker_root = root.clone();
            let name = input.name.clone();
            let (scored, usage) = tokio::task::spawn_blocking(move || {
                let scored = score_quality_transaction(&worker_ctx, &worker_root, name.as_deref())?;
                let usage =
                    load_store(&worker_root).map_err(|e| ToolError::Execution(e.to_string()))?;
                Ok::<_, ToolError>((scored, usage))
            })
            .await
            .map_err(|error| ToolError::Execution(format!("curator worker failed: {error}")))??;
            let output = serde_json::json!({
                "success": true,
                "scored": scored,
                "skills": usage.skills.values().collect::<Vec<_>>(),
            });
            return serde_json::to_string_pretty(&output)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize curator quality: {e}"))
                });
        }
        let worker_ctx = ctx.clone();
        let result = tokio::task::spawn_blocking(move || match input.action {
            SkillCuratorAction::Status => curator_status(&cwd),
            SkillCuratorAction::Run => run_curator(
                &worker_ctx,
                &root,
                input.stale_after_days.unwrap_or(DEFAULT_STALE_AFTER_DAYS),
                input
                    .archive_after_days
                    .unwrap_or(DEFAULT_ARCHIVE_AFTER_DAYS),
                input.dry_run,
                input.include_non_agent_created,
                input.include_bundled,
            ),
            SkillCuratorAction::Pin => {
                let name = required_name(input.name)?;
                let backup = create_curator_backup(&root)?;
                commit_usage_field(
                    &worker_ctx,
                    &root,
                    &name,
                    "pinned",
                    Value::Bool(true),
                    "pin",
                    &backup,
                )
            }
            SkillCuratorAction::Unpin => {
                let name = required_name(input.name)?;
                let backup = create_curator_backup(&root)?;
                commit_usage_field(
                    &worker_ctx,
                    &root,
                    &name,
                    "pinned",
                    Value::Bool(false),
                    "unpin",
                    &backup,
                )
            }
            SkillCuratorAction::Archive => {
                let name = required_name(input.name)?;
                archive_skill(
                    &worker_ctx,
                    &root,
                    &name,
                    input.include_non_agent_created,
                    input.include_bundled,
                )
            }
            SkillCuratorAction::Restore => {
                let name = required_name(input.name)?;
                restore_skill(&worker_ctx, &root, &name)
            }
            SkillCuratorAction::Consolidate => {
                let into = required_name(input.into.or(input.name))?;
                consolidate_skills(
                    &worker_ctx,
                    &root,
                    &into,
                    input.targets,
                    input.include_non_agent_created,
                    input.include_bundled,
                )
            }
            SkillCuratorAction::ReviewAndPatch => {
                let name = required_name(input.name)?;
                let old = required_text(input.old_string, "old_string")?;
                let new = input.new_string.unwrap_or_default();
                review_and_patch_skill(
                    &worker_ctx,
                    &root,
                    &name,
                    input.file_path.as_deref(),
                    &old,
                    &new,
                    input.replace_all,
                    input.review_notes.as_deref(),
                    input.dry_run,
                )
            }
            SkillCuratorAction::Usage => unreachable!(),
            SkillCuratorAction::MarkState => {
                let name = required_name(input.name)?;
                let state = input.state.ok_or_else(|| {
                    ToolError::InvalidInput("state is required for mark_state".to_string())
                })?;
                let backup = create_curator_backup(&root)?;
                commit_usage_field(
                    &worker_ctx,
                    &root,
                    &name,
                    "state",
                    serde_json::to_value(state)
                        .map_err(|error| ToolError::Execution(error.to_string()))?,
                    "mark_state",
                    &backup,
                )
            }
            SkillCuratorAction::ScoreQuality => unreachable!(),
        })
        .await
        .map_err(|error| ToolError::Execution(format!("curator worker failed: {error}")))??;

        serde_json::to_string_pretty(&result)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize curator result: {e}")))
    }
}

fn score_quality_transaction(
    ctx: &ToolContext,
    root: &Path,
    name: Option<&str>,
) -> Result<Vec<String>, ToolError> {
    let mut usage = load_store(root).map_err(|error| ToolError::Execution(error.to_string()))?;
    let before = usage.clone();
    let scored = crate::skill_telemetry::score_quality_in_store(root, &mut usage, name)
        .map_err(|error| ToolError::Execution(error.to_string()))?;
    if scored.is_empty() {
        return Ok(scored);
    }
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let mut patches = BTreeMap::new();
    let mut mutations = Vec::new();
    for skill in &scored {
        let record = usage.skills.get(skill).ok_or_else(|| {
            ToolError::Execution(format!("quality scorer omitted record for '{skill}'"))
        })?;
        if record.quality
            == before
                .skills
                .get(skill)
                .and_then(|record| record.quality.clone())
        {
            continue;
        }
        let mut patch = SkillMetadataPatch::default();
        patch.update.insert(
            "quality".to_string(),
            serde_json::to_value(&record.quality)
                .map_err(|error| ToolError::Execution(error.to_string()))?,
        );
        patches.insert(skill.clone(), patch);
        let revision = store
            .current_revision(skill)
            .map_err(skill_store_error)?
            .ok_or_else(|| ToolError::InvalidInput(format!("skill '{skill}' not found")))?;
        let package = store
            .read_package(skill)
            .map_err(skill_store_error)?
            .ok_or_else(|| ToolError::InvalidInput(format!("skill '{skill}' not found")))?;
        mutations.push(SkillMutation::PutPackage {
            package,
            expected: ExpectedSkillRevision::Exact(revision),
        });
    }
    let backup = create_curator_backup(root)?;
    commit_curator(
        ctx,
        root,
        SkillCommitRequest {
            operation_id: curator_operation_id(ctx, "score-quality", name.unwrap_or("all")),
            actor: curator_actor(ctx),
            operation: SkillOperationKind::CuratorRun,
            preconditions: Vec::new(),
            mutations,
            metadata: SkillMetadataDelta {
                usage: patches,
                curator_log_entries: vec![curator_log_entry(
                    "score_quality",
                    name,
                    &backup,
                    &scored,
                )],
                ..Default::default()
            },
        },
    )?;
    Ok(scored)
}

fn curator_status(cwd: &Path) -> Result<CuratorResult, ToolError> {
    let usage = crate::skill_telemetry::load_project_usage(cwd)
        .map_err(|e| ToolError::Execution(e.to_string()))?;
    let provenance =
        load_project_provenance(cwd).map_err(|e| ToolError::Execution(e.to_string()))?;
    Ok(CuratorResult {
        success: true,
        message: format!(
            "Loaded {} usage record(s) and {} provenance record(s).",
            usage.skills.len(),
            provenance.skills.len()
        ),
        actions: None,
        data: Some(serde_json::json!({
            "usage": usage.skills,
            "provenance": provenance.skills,
        })),
    })
}

fn commit_usage_field(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    field: &str,
    value: Value,
    action: &str,
    backup: &Path,
) -> Result<CuratorResult, ToolError> {
    validate_curator_skill_name(name)?;
    let mut patch = SkillMetadataPatch::default();
    patch.update.insert(field.to_string(), value.clone());
    patch
        .create
        .insert("created_at".to_string(), serde_json::json!(Utc::now()));
    let (receipt, runtime_status) = commit_curator(
        ctx,
        root,
        SkillCommitRequest {
            operation_id: curator_operation_id(ctx, action, name),
            actor: curator_actor(ctx),
            operation: SkillOperationKind::MetadataOnly,
            preconditions: Vec::new(),
            mutations: Vec::new(),
            metadata: SkillMetadataDelta {
                usage: BTreeMap::from([(name.to_string(), patch)]),
                curator_log_entries: vec![curator_log_entry(action, Some(name), backup, &[])],
                ..Default::default()
            },
        },
    )?;
    Ok(CuratorResult {
        success: true,
        message: format!("Skill '{name}' {action} committed."),
        actions: None,
        data: Some(receipt_data(&receipt, runtime_status)),
    })
}

fn commit_curator(
    ctx: &ToolContext,
    root: &Path,
    request: SkillCommitRequest,
) -> Result<(SkillCommitReceipt, &'static str), ToolError> {
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let receipt = store.commit(request).map_err(skill_store_error)?;
    let mut refresh = ctx.clone();
    refresh.record_project_skill_telemetry = false;
    match refresh.reload_skill_registry() {
        Ok(_) => {
            if let Err(error) = store.record_reload_status(&receipt.transaction_id, true) {
                tracing::warn!(%error, "failed to clear curator registry reload marker");
            }
            Ok((receipt, "registry_reloaded"))
        }
        Err(error) => {
            tracing::warn!(
                transaction_id = %receipt.transaction_id,
                %error,
                "curator transaction committed but registry reload is pending"
            );
            if let Err(marker_error) = store.record_reload_status(&receipt.transaction_id, false) {
                tracing::warn!(%marker_error, "failed to persist curator registry reload marker");
            }
            Ok((receipt, "committed_reload_pending"))
        }
    }
}

fn curator_actor(ctx: &ToolContext) -> SkillMutationActor {
    ctx.skill_mutation_actor
        .clone()
        .unwrap_or_else(|| SkillMutationActor::ForegroundAgent {
            session_id: ctx.state.session_id(),
            tool_call_id: ctx
                .tool_call_id
                .clone()
                .unwrap_or_else(|| format!("curator-{}", uuid::Uuid::new_v4())),
        })
}

fn curator_operation_id(ctx: &ToolContext, action: &str, name: &str) -> String {
    let identity = ctx
        .tool_call_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    format!("skill-curator:{action}:{name}:{identity}")
        .chars()
        .take(256)
        .collect()
}

fn curator_log_entry(
    action: &str,
    skill: Option<&str>,
    backup: &Path,
    actions: &[String],
) -> Value {
    serde_json::json!({
        "timestamp": Utc::now(),
        "action": action,
        "skill": skill,
        "backup": backup.display().to_string(),
        "actions": actions,
    })
}

fn receipt_data(receipt: &SkillCommitReceipt, runtime_status: &str) -> Value {
    serde_json::json!({
        "transaction_id": receipt.transaction_id,
        "generation": receipt.generation,
        "status": receipt.status,
        "runtime_status": runtime_status,
        "before": receipt.before,
        "after": receipt.after,
    })
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
        kcoder_skills::SkillStoreError::PolicyRejected(message) => {
            ToolError::InvalidInput(format!("status=policy_rejected; {message}"))
        }
        kcoder_skills::SkillStoreError::RecoveryRequired {
            transaction_id,
            reason,
        } => ToolError::Execution(format!(
            "status=recovery_required; transaction_id={transaction_id}; {reason}"
        )),
        other => ToolError::Execution(other.to_string()),
    }
}

fn run_curator(
    ctx: &ToolContext,
    root: &Path,
    stale_after_days: i64,
    archive_after_days: i64,
    dry_run: bool,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> Result<CuratorResult, ToolError> {
    if stale_after_days < 0 || archive_after_days < 0 {
        return Err(ToolError::InvalidInput(
            "stale_after_days and archive_after_days must be non-negative".to_string(),
        ));
    }

    let provenance = load_project_provenance(&ctx.state.cwd())
        .map_err(|e| ToolError::Execution(e.to_string()))?;
    let mut usage = load_store(root).map_err(|e| ToolError::Execution(e.to_string()))?;
    let usage_before = usage.clone();
    let quality_candidates = curator_lifecycle_candidates(
        root,
        &usage,
        &provenance,
        include_non_agent_created,
        include_bundled,
    );
    let quality_changes = crate::skill_telemetry::score_quality_in_store_for_names(
        root,
        &mut usage,
        &quality_candidates,
    )
    .map_err(|e| ToolError::Execution(e.to_string()))?;
    let now = Utc::now();
    let mut actions = Vec::new();
    let mut archive_names = Vec::new();

    if !quality_changes.is_empty() {
        actions.push(format!(
            "refresh quality scores: {}",
            quality_changes.join(", ")
        ));
    }

    for record in usage.skills.values_mut() {
        if !root.join(&record.name).join("SKILL.md").is_file() {
            continue;
        }
        if record.pinned || record.state == SkillState::Archived {
            continue;
        }
        let age_days = (now - last_activity(record)).num_days();
        let origin = provenance
            .skills
            .get(&record.name)
            .map(|record| &record.origin);
        let can_process_lifecycle =
            can_archive_origin(origin, include_non_agent_created, include_bundled);
        if !can_process_lifecycle {
            continue;
        }
        if record.state == SkillState::Active && age_days >= stale_after_days {
            actions.push(format!("mark stale: {} (idle {age_days}d)", record.name));
            if !dry_run {
                record.state = SkillState::Stale;
            }
        }
        if age_days >= archive_after_days {
            if let Some(reason) = quality_retain_reason(record) {
                actions.push(format!(
                    "retain high-quality: {} (idle {age_days}d, {reason})",
                    record.name
                ));
                continue;
            }
            actions.push(format!("archive: {} (idle {age_days}d)", record.name));
            if !dry_run {
                record.state = SkillState::Archived;
                archive_names.push(record.name.clone());
            }
        }
    }

    if !dry_run && !actions.is_empty() {
        let backup = create_curator_backup(root)?;
        let store = SkillStore::open(root).map_err(skill_store_error)?;
        let archived = archive_names.iter().cloned().collect::<BTreeSet<_>>();
        let mut mutations = Vec::new();
        let mut usage_patches = BTreeMap::new();
        let mut provenance_patches = BTreeMap::new();
        let mut preconditions = Vec::new();
        for (name, record) in &usage.skills {
            let Some(before) = usage_before.skills.get(name) else {
                continue;
            };
            let state_changed = record.state != before.state;
            let quality_changed = record.quality != before.quality;
            if !state_changed && !quality_changed {
                continue;
            }
            let mut patch = SkillMetadataPatch::default();
            if state_changed {
                patch.update.insert(
                    "state".to_string(),
                    serde_json::to_value(record.state).unwrap(),
                );
            }
            if quality_changed {
                patch.update.insert(
                    "quality".to_string(),
                    serde_json::to_value(&record.quality).unwrap_or(Value::Null),
                );
            }
            usage_patches.insert(name.clone(), patch);
            preconditions.extend(archive_preconditions(
                name,
                include_non_agent_created,
                include_bundled,
            ));

            let revision = store
                .current_revision(name)
                .map_err(skill_store_error)?
                .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
            if archived.contains(name) {
                mutations.push(SkillMutation::Archive {
                    name: name.clone(),
                    expected: revision,
                    archive_name: name.clone(),
                });
                let mut provenance_patch = SkillMetadataPatch::default();
                provenance_patch.update.insert(
                    "write_origin".to_string(),
                    serde_json::json!("auto_curator_archive"),
                );
                provenance_patches.insert(name.clone(), provenance_patch);
            } else {
                let package = store
                    .read_package(name)
                    .map_err(skill_store_error)?
                    .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
                mutations.push(SkillMutation::PutPackage {
                    package,
                    expected: ExpectedSkillRevision::Exact(revision),
                });
            }
        }
        let (receipt, runtime_status) = commit_curator(
            ctx,
            root,
            SkillCommitRequest {
                operation_id: curator_operation_id(ctx, "run", "batch"),
                actor: curator_actor(ctx),
                operation: SkillOperationKind::CuratorRun,
                preconditions,
                mutations,
                metadata: SkillMetadataDelta {
                    provenance: provenance_patches,
                    usage: usage_patches,
                    curator_log_entries: vec![curator_log_entry("run", None, &backup, &actions)],
                    ..Default::default()
                },
            },
        )?;
        return Ok(CuratorResult {
            success: true,
            message: format!("Curator applied {} action(s).", actions.len()),
            actions: Some(actions),
            data: Some(receipt_data(&receipt, runtime_status)),
        });
    }

    Ok(CuratorResult {
        success: true,
        message: if dry_run {
            format!("Curator dry-run found {} action(s).", actions.len())
        } else {
            format!("Curator applied {} action(s).", actions.len())
        },
        actions: Some(actions),
        data: None,
    })
}

fn curator_lifecycle_candidates(
    root: &Path,
    usage: &crate::skill_telemetry::SkillTelemetryStore,
    provenance: &SkillProvenanceStore,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> BTreeSet<String> {
    usage
        .skills
        .values()
        .filter(|record| root.join(&record.name).join("SKILL.md").is_file())
        .filter(|record| !record.pinned && record.state != SkillState::Archived)
        .filter(|record| {
            let origin = provenance
                .skills
                .get(&record.name)
                .map(|record| &record.origin);
            can_archive_origin(origin, include_non_agent_created, include_bundled)
        })
        .map(|record| record.name.clone())
        .collect()
}

fn archive_skill(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> Result<CuratorResult, ToolError> {
    require_archive_allowed(
        &ctx.state.cwd(),
        root,
        name,
        include_non_agent_created,
        include_bundled,
    )?;
    let backup = create_curator_backup(root)?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let revision = store
        .current_revision(name)
        .map_err(skill_store_error)?
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
    let mut usage = SkillMetadataPatch::default();
    usage
        .update
        .insert("state".to_string(), serde_json::json!("archived"));
    let mut provenance = SkillMetadataPatch::default();
    provenance.update.insert(
        "write_origin".to_string(),
        serde_json::json!("curator_archive"),
    );
    let (receipt, runtime_status) = commit_curator(
        ctx,
        root,
        SkillCommitRequest {
            operation_id: curator_operation_id(ctx, "archive", name),
            actor: curator_actor(ctx),
            operation: SkillOperationKind::Archive,
            preconditions: archive_preconditions(name, include_non_agent_created, include_bundled),
            mutations: vec![SkillMutation::Archive {
                name: name.to_string(),
                expected: revision,
                archive_name: name.to_string(),
            }],
            metadata: SkillMetadataDelta {
                provenance: BTreeMap::from([(name.to_string(), provenance)]),
                usage: BTreeMap::from([(name.to_string(), usage)]),
                curator_log_entries: vec![curator_log_entry("archive", Some(name), &backup, &[])],
                ..Default::default()
            },
        },
    )?;
    Ok(CuratorResult {
        success: true,
        message: format!("Skill '{name}' archived."),
        actions: None,
        data: Some(receipt_data(&receipt, runtime_status)),
    })
}

fn require_archive_allowed(
    cwd: &Path,
    root: &Path,
    name: &str,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> Result<(), ToolError> {
    let usage = load_store(root).map_err(|e| ToolError::Execution(e.to_string()))?;
    if usage.skills.get(name).is_some_and(|record| record.pinned) {
        return Err(ToolError::InvalidInput(format!(
            "skill '{name}' is pinned; unpin it before archiving"
        )));
    }

    let provenance =
        load_project_provenance(cwd).map_err(|e| ToolError::Execution(e.to_string()))?;
    match provenance.skills.get(name).map(|record| &record.origin) {
        Some(SkillOrigin::AgentCreated) => Ok(()),
        Some(SkillOrigin::Bundled) if include_bundled => Ok(()),
        Some(SkillOrigin::Bundled) => Err(ToolError::InvalidInput(format!(
            "archive does not process bundled skills by default; skill '{name}' has bundled provenance. Set include_bundled=true only for an intentional prune_builtins override"
        ))),
        Some(_) if include_non_agent_created => Ok(()),
        Some(origin) => Err(ToolError::InvalidInput(format!(
            "archive only archives agent-created skills by default; skill '{name}' has origin {origin:?}. Set include_non_agent_created=true only for an intentional manual override"
        ))),
        None if include_non_agent_created => Ok(()),
        None => Err(ToolError::InvalidInput(format!(
            "archive requires agent-created provenance for skill '{name}' by default. Set include_non_agent_created=true only for an intentional manual override"
        ))),
    }
}

fn can_archive_origin(
    origin: Option<&SkillOrigin>,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> bool {
    match origin {
        Some(SkillOrigin::AgentCreated) => true,
        Some(SkillOrigin::Bundled) => include_bundled,
        Some(_) | None => include_non_agent_created,
    }
}

fn archive_preconditions(
    name: &str,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> Vec<SkillMetadataPrecondition> {
    let mut conditions = vec![SkillMetadataPrecondition {
        store: SkillMetadataStore::Usage,
        skill: name.to_string(),
        field: "pinned".to_string(),
        predicate: SkillMetadataPredicate::MissingOrEquals,
        value: Value::Bool(false),
    }];
    let origin = match (include_non_agent_created, include_bundled) {
        (true, true) => None,
        (true, false) => Some((
            SkillMetadataPredicate::NotEquals,
            serde_json::json!("bundled"),
        )),
        (false, true) => Some((
            SkillMetadataPredicate::In,
            serde_json::json!(["agent_created", "bundled"]),
        )),
        (false, false) => Some((
            SkillMetadataPredicate::Equals,
            serde_json::json!("agent_created"),
        )),
    };
    if let Some((predicate, value)) = origin {
        conditions.push(SkillMetadataPrecondition {
            store: SkillMetadataStore::Provenance,
            skill: name.to_string(),
            field: "origin".to_string(),
            predicate,
            value,
        });
    }
    conditions
}

fn restore_skill(ctx: &ToolContext, root: &Path, name: &str) -> Result<CuratorResult, ToolError> {
    let archived = archive_root(root).join(name);
    let live = root.join(name);
    if !archived.join("SKILL.md").is_file() {
        return Err(ToolError::InvalidInput(format!(
            "archived skill '{name}' not found"
        )));
    }
    if live.exists() {
        return Err(ToolError::InvalidInput(format!(
            "cannot restore skill '{name}': live skill already exists"
        )));
    }
    let backup = create_curator_backup(root)?;
    let archived_revision = kcoder_skills::skill_revision(&archived)
        .map_err(skill_store_error)?
        .ok_or_else(|| ToolError::InvalidInput(format!("archived skill '{name}' not found")))?;
    let mut usage = SkillMetadataPatch::default();
    usage
        .update
        .insert("state".to_string(), serde_json::json!("active"));
    let mut provenance = SkillMetadataPatch::default();
    provenance.update.insert(
        "write_origin".to_string(),
        serde_json::json!("curator_restore"),
    );
    let (receipt, runtime_status) = commit_curator(
        ctx,
        root,
        SkillCommitRequest {
            operation_id: curator_operation_id(ctx, "restore", name),
            actor: curator_actor(ctx),
            operation: SkillOperationKind::Restore,
            preconditions: Vec::new(),
            mutations: vec![SkillMutation::Restore {
                name: name.to_string(),
                archive_name: name.to_string(),
                expected_archive_revision: archived_revision,
                expected_live: ExpectedSkillRevision::Absent,
            }],
            metadata: SkillMetadataDelta {
                provenance: BTreeMap::from([(name.to_string(), provenance)]),
                usage: BTreeMap::from([(name.to_string(), usage)]),
                curator_log_entries: vec![curator_log_entry("restore", Some(name), &backup, &[])],
                ..Default::default()
            },
        },
    )?;
    Ok(CuratorResult {
        success: true,
        message: format!("Skill '{name}' restored."),
        actions: None,
        data: Some(receipt_data(&receipt, runtime_status)),
    })
}

fn consolidate_skills(
    ctx: &ToolContext,
    root: &Path,
    into: &str,
    targets: Vec<String>,
    include_non_agent_created: bool,
    include_bundled: bool,
) -> Result<CuratorResult, ToolError> {
    validate_curator_skill_name(into)?;
    let targets = normalize_targets(targets)?;
    if targets.len() < 2 {
        return Err(ToolError::InvalidInput(
            "consolidate requires at least two target skills".to_string(),
        ));
    }
    if targets.iter().any(|target| target == into) {
        return Err(ToolError::InvalidInput(
            "consolidate destination cannot also be a target".to_string(),
        ));
    }

    let destination = root.join(into);
    if destination.exists() {
        return consolidate_existing_result(ctx, root, into, &targets);
    }
    for target in &targets {
        validate_curator_skill_name(target)?;
        require_archive_allowed(
            &ctx.state.cwd(),
            root,
            target,
            include_non_agent_created,
            include_bundled,
        )?;
        if !root.join(target).join("SKILL.md").is_file() {
            return Err(ToolError::InvalidInput(format!(
                "target skill '{target}' not found"
            )));
        }
        if archive_root(root).join(target).exists() {
            return Err(ToolError::InvalidInput(format!(
                "archived skill '{target}' already exists"
            )));
        }
    }

    let mut sources = Vec::new();
    for target in &targets {
        let content = fs::read_to_string(root.join(target).join("SKILL.md")).map_err(|e| {
            ToolError::Execution(format!("failed to read target skill '{target}': {e}"))
        })?;
        sources.push((target.clone(), content));
    }

    let actions = vec![format!("consolidate: {} -> {}", targets.join(", "), into)];
    let backup = create_curator_backup(root)?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let mut expected_sources = Vec::new();
    let mut preconditions = Vec::new();
    let mut usage = BTreeMap::new();
    let mut provenance = BTreeMap::new();
    for target in &targets {
        let revision = store
            .current_revision(target)
            .map_err(skill_store_error)?
            .ok_or_else(|| ToolError::InvalidInput(format!("skill '{target}' not found")))?;
        expected_sources.push((target.clone(), revision));
        preconditions.extend(archive_preconditions(
            target,
            include_non_agent_created,
            include_bundled,
        ));
        let mut usage_patch = SkillMetadataPatch::default();
        usage_patch
            .update
            .insert("state".to_string(), serde_json::json!("archived"));
        usage.insert(target.clone(), usage_patch);
        let mut provenance_patch = SkillMetadataPatch::default();
        provenance_patch.update.insert(
            "write_origin".to_string(),
            serde_json::json!("curator_consolidate_source"),
        );
        provenance.insert(target.clone(), provenance_patch);
    }
    let now = Utc::now();
    let mut destination_usage = SkillMetadataPatch::default();
    destination_usage
        .create
        .insert("created_at".to_string(), serde_json::json!(now));
    destination_usage
        .update
        .insert("state".to_string(), serde_json::json!("active"));
    usage.insert(into.to_string(), destination_usage);
    let mut destination_provenance = SkillMetadataPatch::default();
    destination_provenance
        .update
        .insert("origin".to_string(), serde_json::json!("agent_created"));
    destination_provenance
        .create
        .insert("created_by".to_string(), serde_json::json!("agent"));
    destination_provenance.update.insert(
        "write_origin".to_string(),
        serde_json::json!("curator_consolidate"),
    );
    provenance.insert(into.to_string(), destination_provenance);
    let destination_package = SkillPackage {
        name: into.to_string(),
        files: vec![SkillPackageFile {
            relative_path: PathBuf::from("SKILL.md"),
            content: render_consolidated_skill(into, &sources).into_bytes(),
            executable: false,
        }],
    };
    let (receipt, runtime_status) = commit_curator(
        ctx,
        root,
        SkillCommitRequest {
            operation_id: curator_operation_id(ctx, "consolidate", into),
            actor: curator_actor(ctx),
            operation: SkillOperationKind::Consolidate,
            preconditions,
            mutations: vec![SkillMutation::Consolidate {
                sources: expected_sources,
                destination: destination_package,
                expected_destination: ExpectedSkillRevision::Absent,
            }],
            metadata: SkillMetadataDelta {
                provenance,
                usage,
                curator_log_entries: vec![curator_log_entry(
                    "consolidate",
                    Some(into),
                    &backup,
                    &actions,
                )],
                ..Default::default()
            },
        },
    )?;

    Ok(CuratorResult {
        success: true,
        message: format!("Consolidated {} skill(s) into '{into}'.", targets.len()),
        actions: Some(actions),
        data: Some(receipt_data(&receipt, runtime_status)),
    })
}

fn consolidate_existing_result(
    ctx: &ToolContext,
    root: &Path,
    into: &str,
    targets: &[String],
) -> Result<CuratorResult, ToolError> {
    let destination = root.join(into);
    if !destination.join("SKILL.md").is_file() {
        return Err(ToolError::InvalidInput(format!(
            "destination skill '{into}' already exists but is not a skill"
        )));
    }
    if load_project_provenance(&ctx.state.cwd())
        .ok()
        .and_then(|store| store.skills.get(into).cloned())
        .is_some_and(|record| record.origin != SkillOrigin::AgentCreated)
    {
        return Err(ToolError::InvalidInput(format!(
            "destination skill '{into}' already exists with non-agent provenance"
        )));
    }

    for target in targets {
        validate_curator_skill_name(target)?;
        if root.join(target).join("SKILL.md").exists() {
            return Err(ToolError::InvalidInput(format!(
                "destination skill '{into}' already exists; target skill '{target}' is still live"
            )));
        }
        if !archive_root(root).join(target).join("SKILL.md").is_file() {
            return Err(ToolError::InvalidInput(format!(
                "destination skill '{into}' already exists; archived target skill '{target}' not found"
            )));
        }
    }

    reload_registry(ctx)?;
    let actions = vec![format!(
        "unchanged: {} already consolidated into {}",
        targets.join(", "),
        into
    )];
    Ok(CuratorResult {
        success: true,
        message: format!("Consolidation into '{into}' already exists."),
        actions: Some(actions),
        data: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn review_and_patch_skill(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    file_path: Option<&str>,
    old: &str,
    new: &str,
    replace_all: bool,
    review_notes: Option<&str>,
    dry_run: bool,
) -> Result<CuratorResult, ToolError> {
    validate_curator_skill_name(name)?;
    if old.is_empty() {
        return Err(ToolError::InvalidInput(
            "old_string cannot be empty".to_string(),
        ));
    }
    let skill_dir = root.join(name);
    if !skill_dir.join("SKILL.md").is_file() {
        return Err(ToolError::InvalidInput(format!("skill '{name}' not found")));
    }
    require_review_patch_allowed(&ctx.state.cwd(), root, name)?;
    let target = resolve_review_patch_target(&skill_dir, file_path)?;
    let original = fs::read_to_string(&target)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", target)))?;
    let matches = original.matches(old).count();
    if matches == 0 {
        return Err(ToolError::InvalidInput(
            "old_string was not found in target file".to_string(),
        ));
    }
    let updated = if replace_all {
        original.replace(old, new)
    } else {
        original.replacen(old, new, 1)
    };
    if is_skill_md(&target) {
        validate_skill_content(&updated)?;
    } else if updated.len() > MAX_PATCHED_SUPPORTING_FILE_BYTES {
        return Err(ToolError::InvalidInput(format!(
            "supporting file exceeds {MAX_PATCHED_SUPPORTING_FILE_BYTES} bytes"
        )));
    }

    let replacements = if replace_all { matches } else { 1 };
    let mut actions = vec![format!(
        "review_and_patch: {} ({replacements} replacement{})",
        target.strip_prefix(root).unwrap_or(&target).display(),
        if replacements == 1 { "" } else { "s" }
    )];
    if let Some(notes) = review_notes
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
    {
        actions.push(format!("review notes: {notes}"));
    }

    if dry_run {
        return Ok(CuratorResult {
            success: true,
            message: format!("Curator review patch dry-run found {replacements} replacement(s)."),
            actions: Some(actions),
            data: None,
        });
    }

    let backup = create_curator_backup(root)?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let revision = store
        .current_revision(name)
        .map_err(skill_store_error)?
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
    let relative = target.strip_prefix(&skill_dir).map_err(|_| {
        ToolError::InvalidInput("review patch target escaped the skill directory".to_string())
    })?;
    let now = Utc::now();
    let mut usage = SkillMetadataPatch::default();
    usage.increment.insert("patch_count".to_string(), 1);
    usage
        .update
        .insert("last_patched_at".to_string(), serde_json::json!(now));
    let mut provenance = SkillMetadataPatch::default();
    provenance.update.insert(
        "write_origin".to_string(),
        serde_json::json!("curator_review_patch"),
    );
    let (receipt, runtime_status) = commit_curator(
        ctx,
        root,
        SkillCommitRequest {
            operation_id: curator_operation_id(ctx, "review-and-patch", name),
            actor: curator_actor(ctx),
            operation: SkillOperationKind::CuratorRun,
            preconditions: vec![
                SkillMetadataPrecondition {
                    store: SkillMetadataStore::Usage,
                    skill: name.to_string(),
                    field: "pinned".to_string(),
                    predicate: SkillMetadataPredicate::MissingOrEquals,
                    value: Value::Bool(false),
                },
                SkillMetadataPrecondition {
                    store: SkillMetadataStore::Provenance,
                    skill: name.to_string(),
                    field: "origin".to_string(),
                    predicate: SkillMetadataPredicate::Equals,
                    value: serde_json::json!("agent_created"),
                },
            ],
            mutations: vec![SkillMutation::PatchText {
                name: name.to_string(),
                expected: ExpectedSkillRevision::Exact(revision),
                relative_path: relative.to_path_buf(),
                old_string: old.to_string(),
                new_string: new.to_string(),
                replace_all,
            }],
            metadata: SkillMetadataDelta {
                provenance: BTreeMap::from([(name.to_string(), provenance)]),
                usage: BTreeMap::from([(name.to_string(), usage)]),
                curator_log_entries: vec![curator_log_entry(
                    "review_and_patch",
                    Some(name),
                    &backup,
                    &actions,
                )],
                ..Default::default()
            },
        },
    )?;

    Ok(CuratorResult {
        success: true,
        message: format!("Review patch applied to skill '{name}'."),
        actions: Some(actions),
        data: Some(serde_json::json!({
            "path": target.display().to_string(),
            "replacements": replacements,
            "transaction": receipt_data(&receipt, runtime_status),
        })),
    })
}

fn require_review_patch_allowed(cwd: &Path, root: &Path, name: &str) -> Result<(), ToolError> {
    let usage = load_store(root).map_err(|e| ToolError::Execution(e.to_string()))?;
    if usage.skills.get(name).is_some_and(|record| record.pinned) {
        return Err(ToolError::InvalidInput(format!(
            "skill '{name}' is pinned; curator review patches are disabled until it is unpinned"
        )));
    }

    let provenance =
        load_project_provenance(cwd).map_err(|e| ToolError::Execution(e.to_string()))?;
    match provenance.skills.get(name).map(|record| &record.origin) {
        Some(SkillOrigin::AgentCreated) => Ok(()),
        Some(origin) => Err(ToolError::InvalidInput(format!(
            "review_and_patch only modifies agent-created skills; skill '{name}' has origin {origin:?}"
        ))),
        None => Err(ToolError::InvalidInput(format!(
            "review_and_patch requires provenance for skill '{name}' and only modifies agent-created skills"
        ))),
    }
}

fn normalize_targets(targets: Vec<String>) -> Result<Vec<String>, ToolError> {
    let mut normalized = Vec::new();
    for target in targets {
        let target = target.trim();
        if target.is_empty() {
            continue;
        }
        if !normalized.iter().any(|existing| existing == target) {
            normalized.push(target.to_string());
        }
    }
    if normalized.is_empty() {
        return Err(ToolError::InvalidInput(
            "consolidate requires target skills".to_string(),
        ));
    }
    Ok(normalized)
}

fn resolve_review_patch_target(dir: &Path, file_path: Option<&str>) -> Result<PathBuf, ToolError> {
    match file_path.map(str::trim).filter(|path| !path.is_empty()) {
        None | Some("SKILL.md") => Ok(dir.join("SKILL.md")),
        Some(path) => resolve_review_supporting_path(dir, path),
    }
}

fn resolve_review_supporting_path(dir: &Path, file_path: &str) -> Result<PathBuf, ToolError> {
    let relative = Path::new(file_path);
    if relative.is_absolute() {
        return Err(ToolError::InvalidInput(
            "file_path must be relative".to_string(),
        ));
    }
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => components.push(part.to_owned()),
            _ => {
                return Err(ToolError::InvalidInput(
                    "file_path cannot contain '.', '..', prefixes, or root components".to_string(),
                ));
            }
        }
    }
    let Some(first) = components.first().and_then(|part| part.to_str()) else {
        return Err(ToolError::InvalidInput(
            "file_path cannot be empty".to_string(),
        ));
    };
    if !PATCHABLE_SUPPORTING_DIRS.contains(&first) {
        return Err(ToolError::InvalidInput(format!(
            "file_path must be SKILL.md or start with one of: {}",
            PATCHABLE_SUPPORTING_DIRS.join(", ")
        )));
    }
    let target = components
        .into_iter()
        .fold(dir.to_path_buf(), |acc, part| acc.join(part));
    if !target.is_file() {
        return Err(ToolError::InvalidInput(format!(
            "supporting file '{}' not found",
            file_path
        )));
    }
    Ok(target)
}

fn validate_curator_skill_name(name: &str) -> Result<(), ToolError> {
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if valid {
        Ok(())
    } else {
        Err(ToolError::InvalidInput(format!(
            "invalid skill name '{name}'; use letters, numbers, '-' or '_'"
        )))
    }
}

fn validate_skill_content(content: &str) -> Result<(), ToolError> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") || !trimmed[3..].contains("\n---") {
        return Err(ToolError::InvalidInput(
            "SKILL.md must contain YAML frontmatter".to_string(),
        ));
    }
    if !trimmed.contains("\nname:") && !trimmed.contains("\r\nname:") {
        return Err(ToolError::InvalidInput(
            "SKILL.md frontmatter must include name".to_string(),
        ));
    }
    if !trimmed.contains("\ndescription:") && !trimmed.contains("\r\ndescription:") {
        return Err(ToolError::InvalidInput(
            "SKILL.md frontmatter must include description".to_string(),
        ));
    }
    Ok(())
}

fn is_skill_md(path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md")
}

fn render_consolidated_skill(into: &str, sources: &[(String, String)]) -> String {
    let title = into.replace(['-', '_'], " ");
    let source_names = sources
        .iter()
        .map(|(name, _)| format!("`{name}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut content = String::new();
    let _ = writeln!(content, "---");
    let _ = writeln!(content, "name: {into}");
    let _ = writeln!(
        content,
        "description: Umbrella skill consolidated from {source_names}."
    );
    let _ = writeln!(content, "---\n");
    let _ = writeln!(content, "# {}\n", title);
    let _ = writeln!(
        content,
        "This umbrella skill consolidates reusable guidance from {source_names}.\n"
    );
    for (name, source) in sources {
        let _ = writeln!(content, "## From `{name}`\n");
        let body = strip_skill_frontmatter(source).trim();
        if body.is_empty() {
            let _ = writeln!(content, "- Review archived skill `{name}` for details.\n");
        } else {
            let _ = writeln!(content, "{body}\n");
        }
    }
    content
}

fn strip_skill_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return content;
    }
    let after_first = &trimmed[3..];
    if let Some(end) = after_first.find("\n---") {
        &after_first[end + 4..]
    } else {
        content
    }
}

fn archive_root(root: &Path) -> PathBuf {
    root.join(".archive")
}

fn last_activity(record: &crate::skill_telemetry::SkillTelemetry) -> DateTime<Utc> {
    [
        record.last_viewed_at,
        record.last_used_at,
        record.last_patched_at,
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(record.created_at)
}

fn quality_retain_reason(record: &crate::skill_telemetry::SkillTelemetry) -> Option<String> {
    let quality = record.quality.as_ref()?;
    let helpful = quality.helpful_score.unwrap_or_default();
    let specificity = quality.specificity_score.unwrap_or_default();
    if helpful >= QUALITY_RETAIN_HELPFUL_SCORE {
        Some(format!("helpful_score {helpful:.3}"))
    } else if specificity >= QUALITY_RETAIN_SPECIFICITY_SCORE {
        Some(format!("specificity_score {specificity:.3}"))
    } else {
        None
    }
}

fn reload_registry(ctx: &ToolContext) -> Result<(), ToolError> {
    let mut refresh = ctx.clone();
    refresh.record_project_skill_telemetry = false;
    refresh.reload_skill_registry()?;
    Ok(())
}

fn create_curator_backup(root: &Path) -> Result<PathBuf, ToolError> {
    let backup_dir = root.join(BACKUPS_DIR);
    fs::create_dir_all(&backup_dir)
        .map_err(|e| ToolError::Execution(format!("failed to create backup directory: {e}")))?;
    let backup = backup_dir.join(format!("{}.tar.gz", timestamp_slug()));
    let file = fs::File::create(&backup)
        .map_err(|e| ToolError::Execution(format!("failed to create backup {:?}: {e}", backup)))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    write_tar_archive(root, &mut encoder)
        .map_err(|e| ToolError::Execution(format!("failed to write curator backup: {e}")))?;
    encoder
        .finish()
        .map_err(|e| ToolError::Execution(format!("failed to finish curator backup: {e}")))?;
    Ok(backup)
}

fn timestamp_slug() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}-{:09}", now.as_secs(), now.subsec_nanos())
}

fn write_tar_archive(root: &Path, writer: &mut impl Write) -> io::Result<()> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
    {
        let entry = entry?;
        let relative = entry.path().strip_prefix(root).map_err(io::Error::other)?;
        if relative
            .components()
            .next()
            .and_then(|component| component.as_os_str().to_str())
            == Some(BACKUPS_DIR)
        {
            continue;
        }
        entries.push(entry.path().to_path_buf());
    }
    entries.sort();

    for path in entries {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        let relative = path.strip_prefix(root).map_err(io::Error::other)?;
        if relative == Path::new(".usage.json.lock") {
            // This advisory lock is held for the complete curator operation.
            // Windows denies reads of the locked file, and the ephemeral lock
            // has no value in a restore archive on any platform.
            continue;
        }
        if metadata.is_dir() {
            write_tar_header(writer, relative, 0, true, &metadata)?;
        } else if metadata.is_file() {
            let content = fs::read(&path)?;
            write_tar_header(writer, relative, content.len() as u64, false, &metadata)?;
            writer.write_all(&content)?;
            write_tar_padding(writer, content.len() as u64)?;
        }
    }
    writer.write_all(&[0u8; 1024])?;
    Ok(())
}

fn write_tar_header(
    writer: &mut impl Write,
    relative: &Path,
    size: u64,
    is_dir: bool,
    metadata: &fs::Metadata,
) -> io::Result<()> {
    let mut header = [0u8; 512];
    let path = tar_path(relative, is_dir);
    let (name, prefix) = split_tar_path(&path)?;
    write_bytes(&mut header, 0, 100, name.as_bytes());
    write_octal(&mut header, 100, 8, if is_dir { 0o755 } else { 0o644 });
    write_octal(&mut header, 108, 8, 0);
    write_octal(&mut header, 116, 8, 0);
    write_octal(&mut header, 124, 12, size);
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    write_octal(&mut header, 136, 12, mtime);
    for byte in &mut header[148..156] {
        *byte = b' ';
    }
    header[156] = if is_dir { b'5' } else { b'0' };
    write_bytes(&mut header, 257, 6, b"ustar\0");
    write_bytes(&mut header, 263, 2, b"00");
    write_bytes(&mut header, 345, 155, prefix.as_bytes());
    let checksum = header.iter().map(|byte| u32::from(*byte)).sum::<u32>();
    write_checksum(&mut header, checksum);
    writer.write_all(&header)
}

fn tar_path(path: &Path, is_dir: bool) -> String {
    let mut path = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if is_dir && !path.ends_with('/') {
        path.push('/');
    }
    path
}

fn split_tar_path(path: &str) -> io::Result<(&str, &str)> {
    if path.len() <= 100 {
        return Ok((path, ""));
    }
    for idx in path.match_indices('/').map(|(idx, _)| idx).rev() {
        let prefix = &path[..idx];
        let name = &path[idx + 1..];
        if prefix.len() <= 155 && name.len() <= 100 {
            return Ok((name, prefix));
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("tar path too long: {path}"),
    ))
}

fn write_bytes(header: &mut [u8; 512], offset: usize, len: usize, bytes: &[u8]) {
    let count = bytes.len().min(len);
    header[offset..offset + count].copy_from_slice(&bytes[..count]);
}

fn write_octal(header: &mut [u8; 512], offset: usize, len: usize, value: u64) {
    let encoded = format!("{value:0width$o}\0", width = len - 1);
    write_bytes(header, offset, len, encoded.as_bytes());
}

fn write_checksum(header: &mut [u8; 512], value: u32) {
    let encoded = format!("{value:06o}\0 ");
    write_bytes(header, 148, 8, encoded.as_bytes());
}

fn write_tar_padding(writer: &mut impl Write, size: u64) -> io::Result<()> {
    let padding = (512 - (size % 512)) % 512;
    if padding > 0 {
        writer.write_all(&vec![0u8; padding as usize])?;
    }
    Ok(())
}

fn required_name(name: Option<String>) -> Result<String, ToolError> {
    let name = name.unwrap_or_default();
    if name.trim().is_empty() {
        return Err(ToolError::InvalidInput(
            "name is required for this action".to_string(),
        ));
    }
    Ok(name.trim().to_string())
}

fn required_text(value: Option<String>, field: &str) -> Result<String, ToolError> {
    let value = value.unwrap_or_default();
    if value.is_empty() {
        return Err(ToolError::InvalidInput(format!(
            "{field} is required for review_and_patch"
        )));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Tool;
    use flate2::read::GzDecoder;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use std::io::Read;
    use std::sync::{Arc, RwLock};

    fn tool_output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[tokio::test]
    async fn archives_and_restores_project_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        SkillCuratorTool
            .call(
                serde_json::json!({"action": "archive", "name": "demo"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/demo/SKILL.md")
                .is_file()
        );
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "demo/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"archive\""));
        assert!(log.contains("\"skill\":\"demo\""));

        SkillCuratorTool
            .call(
                serde_json::json!({"action": "restore", "name": "demo"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 2);
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"restore\""));
    }

    #[tokio::test]
    async fn archive_rejects_user_created_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_user_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({"action": "archive", "name": "demo"}),
                &ctx,
            )
            .await;

        let err = result.expect_err("user-created skills require an explicit override");
        assert!(err.to_string().contains("agent-created skills by default"));
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        assert!(!tmp.path().join(".kcoder/skills/.archive/demo").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn archive_rejects_pinned_agent_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "demo", true).unwrap();
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({"action": "archive", "name": "demo"}),
                &ctx,
            )
            .await;

        let err = result.expect_err("pinned skills should not be archived");
        assert!(err.to_string().contains("is pinned"));
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        assert!(!tmp.path().join(".kcoder/skills/.archive/demo").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn archive_explicit_override_allows_user_created_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_user_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "archive",
                    "name": "demo",
                    "include_non_agent_created": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/demo/SKILL.md")
                .is_file()
        );
        assert_eq!(backup_files(tmp.path()).len(), 1);
    }

    #[tokio::test]
    async fn archive_override_still_rejects_bundled_skill_without_include_bundled() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(tmp.path(), "bundled-demo", "# Bundled Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "bundled-demo");
        crate::skill_provenance::record_bundled(tmp.path(), "bundled-demo", "hash");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "archive",
                    "name": "bundled-demo",
                    "include_non_agent_created": true
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("bundled skills require include_bundled");
        assert!(err.to_string().contains("bundled skills by default"));
        assert!(
            tmp.path()
                .join(".kcoder/skills/bundled-demo/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/bundled-demo")
                .exists()
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn archive_include_bundled_allows_explicit_bundled_archive() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(tmp.path(), "bundled-demo", "# Bundled Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "bundled-demo");
        crate::skill_provenance::record_bundled(tmp.path(), "bundled-demo", "hash");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "archive",
                    "name": "bundled-demo",
                    "include_bundled": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/bundled-demo/SKILL.md")
                .is_file()
        );
        assert_eq!(backup_files(tmp.path()).len(), 1);
    }

    #[tokio::test]
    async fn run_include_bundled_does_not_archive_user_created_skills() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(tmp.path(), "bundled-demo", "# Bundled Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "bundled-demo");
        crate::skill_provenance::record_bundled(tmp.path(), "bundled-demo", "hash");
        write_test_skill(tmp.path(), "user-demo", "# User Demo");
        crate::skill_telemetry::record_skill_created(tmp.path(), "user-demo");
        crate::skill_provenance::record_user_created(tmp.path(), "user-demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        let output = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0,
                    "include_bundled": true,
                    "include_non_agent_created": false
                }),
                &ctx,
            )
            .await
            .unwrap();
        let output = tool_output_text(&output);

        assert!(output.contains("archive: bundled-demo"));
        assert!(!output.contains("mark stale: user-demo"));
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/bundled-demo/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/user-demo/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/user-demo")
                .exists()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let user_usage = usage.skills.get("user-demo").unwrap();
        assert_eq!(user_usage.state, SkillState::Active);
        assert!(
            user_usage.quality.is_none(),
            "automatic curator run should not write quality telemetry for user-created skills"
        );
    }

    #[tokio::test]
    async fn run_archives_agent_skill_with_backup_and_audit_log() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/demo/SKILL.md")
                .is_file()
        );
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "demo/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"run\""));
        assert!(log.contains("archive: demo"));
    }

    #[tokio::test]
    async fn run_retains_high_quality_agent_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp
            .path()
            .join(".kcoder")
            .join("skills")
            .join("quality-demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: quality-demo\ndescription: Specific reusable workflow\n---\n\n\
             # Quality Demo\n\n\
             1. Run cargo test before completion.\n\
             2. Verify output and inspect errors.\n\
             3. Avoid reporting success without evidence.\n\
             4. Run git status before summarizing.\n\n\
             - Test the behavior, not only file existence.\n\
             - Verify failures before changing implementation.\n\n\
             ```bash\ncargo test\ngit status\n```",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "quality-demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "quality-demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_skill_registry(registry);

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/quality-demo/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/quality-demo/SKILL.md")
                .exists()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let record = usage.skills.get("quality-demo").unwrap();
        assert_eq!(record.state, SkillState::Stale);
        assert!(
            record
                .quality
                .as_ref()
                .and_then(|quality| quality.specificity_score)
                .unwrap_or_default()
                >= QUALITY_RETAIN_SPECIFICITY_SCORE
        );
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("retain high-quality: quality-demo"));
    }

    #[tokio::test]
    async fn run_audits_quality_only_usage_mutation_once() {
        let tmp = tempfile::tempdir().unwrap();
        write_test_skill(
            tmp.path(),
            "demo",
            "# Demo\n\n1. Run cargo test.\n2. Verify output.\n```bash\ncargo test\n```",
        );
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_skill_registry(Arc::clone(&registry));

        let first = SkillCuratorTool
            .call(serde_json::json!({"action": "run"}), &ctx)
            .await
            .unwrap();
        let first_text = output_text(&first);

        assert!(first_text.contains("Curator applied 1 action(s)."));
        assert!(first_text.contains("refresh quality scores: demo"));
        assert!(tmp.path().join(".kcoder/skills/demo/SKILL.md").is_file());
        assert!(!tmp.path().join(".kcoder/skills/.archive/demo").exists());
        assert_eq!(backup_files(tmp.path()).len(), 1);
        let log_path = tmp.path().join(".kcoder/skills/.curator.log");
        let log = std::fs::read_to_string(&log_path).unwrap();
        assert!(log.contains("\"action\":\"run\""));
        assert!(log.contains("refresh quality scores: demo"));

        let second = SkillCuratorTool
            .call(serde_json::json!({"action": "run"}), &ctx)
            .await
            .unwrap();
        let second_text = output_text(&second);

        assert!(second_text.contains("Curator applied 0 action(s)."));
        assert_eq!(backup_files(tmp.path()).len(), 1);
        assert_eq!(std::fs::read_to_string(&log_path).unwrap(), log);
    }

    #[tokio::test]
    async fn run_skips_usage_records_without_live_skill() {
        let tmp = tempfile::tempdir().unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "missing-demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "missing-demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let output = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "run",
                    "stale_after_days": 0,
                    "archive_after_days": 0
                }),
                &ctx,
            )
            .await
            .unwrap();
        let output = output_text(&output);

        assert!(output.contains("Curator applied 0 action(s)."));
        assert!(!tmp.path().join(".kcoder/skills/.archive").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("missing-demo").unwrap().state,
            SkillState::Active
        );
    }

    #[tokio::test]
    async fn review_and_patch_updates_agent_skill_with_audit_usage_and_provenance() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n",
        )
        .unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_skill_registry(Arc::clone(&registry));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "# Demo\n",
                    "new_string": "# Demo\n\n- Verify with cargo test before completion.\n",
                    "review_notes": "Added verification guidance from review."
                }),
                &ctx,
            )
            .await
            .unwrap();

        let content = std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap();
        assert!(content.contains("Verify with cargo test before completion."));
        assert!(registry.read().unwrap().get("demo").is_some());
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("demo").unwrap();
        assert_eq!(usage.patch_count, 1);
        assert!(usage.last_patched_at.is_some());
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("demo").unwrap();
        assert_eq!(provenance.origin, SkillOrigin::AgentCreated);
        assert_eq!(
            provenance.write_origin.as_deref(),
            Some("curator_review_patch")
        );
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "demo/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"review_and_patch\""));
        assert!(log.contains("Added verification guidance from review."));
    }

    #[tokio::test]
    async fn review_and_patch_rejects_user_created_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_user_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "# Demo\n",
                    "new_string": "# Demo\n\n- Patched.\n"
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("user-created skills should not be curator-patched");
        assert!(err.to_string().contains("only modifies agent-created"));
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn review_and_patch_rejects_pinned_agent_skill_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "demo", true).unwrap();
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "# Demo\n",
                    "new_string": "# Demo\n\n- Patched.\n"
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("pinned skills should not be curator-patched");
        assert!(err.to_string().contains("is pinned"));
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn review_and_patch_rejects_invalid_skill_content_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let original = "---\nname: demo\ndescription: Demo\n---\n\n# Demo\n";
        std::fs::write(skill_dir.join("SKILL.md"), original).unwrap();
        crate::skill_telemetry::record_skill_created(tmp.path(), "demo");
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "review_and_patch",
                    "name": "demo",
                    "old_string": "description: Demo\n",
                    "new_string": ""
                }),
                &ctx,
            )
            .await;

        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            original
        );
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn consolidate_creates_umbrella_and_archives_targets() {
        let tmp = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("narrow-a", "# Narrow A\n\n- Verify with cargo test."),
            ("narrow-b", "# Narrow B\n\n- Avoid duplicate setup."),
        ] {
            let skill_dir = tmp.path().join(".kcoder").join("skills").join(name);
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(
                skill_dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {name}\n---\n\n{body}\n"),
            )
            .unwrap();
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_agent_created(tmp.path(), name);
        }
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_skill_registry(Arc::clone(&registry));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await
            .unwrap();

        let umbrella =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/umbrella/SKILL.md")).unwrap();
        assert!(umbrella.contains("name: umbrella"));
        assert!(umbrella.contains("From `narrow-a`"));
        assert!(umbrella.contains("Verify with cargo test."));
        assert!(umbrella.contains("From `narrow-b`"));
        assert!(umbrella.contains("Avoid duplicate setup."));
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-b/SKILL.md")
                .is_file()
        );
        assert!(registry.read().unwrap().get("umbrella").is_some());
        assert!(registry.read().unwrap().get("narrow-a").is_none());

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        assert_eq!(
            provenance.skills.get("umbrella").unwrap().origin,
            SkillOrigin::AgentCreated
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(
            usage.skills.get("narrow-a").unwrap().state,
            SkillState::Archived
        );
        assert!(usage.skills.contains_key("umbrella"));
        let backups = backup_files(tmp.path());
        assert_eq!(backups.len(), 1);
        assert_backup_contains(&backups[0], "narrow-a/SKILL.md");
        let log = std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert!(log.contains("\"action\":\"consolidate\""));
        assert!(log.contains("consolidate: narrow-a, narrow-b -> umbrella"));
    }

    #[tokio::test]
    async fn consolidate_is_idempotent_when_targets_already_archived() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["narrow-a", "narrow-b"] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_agent_created(tmp.path(), name);
        }
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await
            .unwrap();
        let first_log =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert_eq!(backup_files(tmp.path()).len(), 1);
        assert_eq!(first_log.lines().count(), 1);

        let output = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await
            .expect("repeat consolidate should be a no-op success");
        let output = tool_output_text(&output);

        assert!(output.contains("already consolidated"));
        assert_eq!(backup_files(tmp.path()).len(), 1);
        let second_log =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/.curator.log")).unwrap();
        assert_eq!(second_log.lines().count(), 1);

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "restore",
                    "name": "narrow-a"
                }),
                &ctx,
            )
            .await
            .expect("archived target should remain restorable after idempotent consolidate");

        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            !tmp.path()
                .join(".kcoder/skills/.archive/narrow-a/SKILL.md")
                .exists()
        );
    }

    #[tokio::test]
    async fn consolidate_rejects_user_created_target_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        for (name, origin) in [
            ("narrow-a", SkillOrigin::UserCreated),
            ("narrow-b", SkillOrigin::AgentCreated),
        ] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            match origin {
                SkillOrigin::UserCreated => {
                    crate::skill_provenance::record_user_created(tmp.path(), name)
                }
                SkillOrigin::AgentCreated => {
                    crate::skill_provenance::record_agent_created(tmp.path(), name)
                }
                _ => unreachable!("test only uses user and agent origins"),
            }
        }
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("user-created consolidate targets require override");
        assert!(err.to_string().contains("agent-created skills by default"));
        assert!(!tmp.path().join(".kcoder/skills/umbrella").exists());
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-b/SKILL.md")
                .is_file()
        );
        assert!(!tmp.path().join(".kcoder/skills/.archive/narrow-a").exists());
        assert!(!tmp.path().join(".kcoder/skills/.archive/narrow-b").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn consolidate_rejects_pinned_agent_target_without_backup() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["narrow-a", "narrow-b"] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_agent_created(tmp.path(), name);
        }
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "narrow-a", true).unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        let result = SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"]
                }),
                &ctx,
            )
            .await;

        let err = result.expect_err("pinned consolidate targets should be rejected");
        assert!(err.to_string().contains("is pinned"));
        assert!(!tmp.path().join(".kcoder/skills/umbrella").exists());
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/narrow-b/SKILL.md")
                .is_file()
        );
        assert!(!tmp.path().join(".kcoder/skills/.archive/narrow-a").exists());
        assert!(!tmp.path().join(".kcoder/skills/.backups").exists());
        assert!(!tmp.path().join(".kcoder/skills/.curator.log").exists());
    }

    #[tokio::test]
    async fn consolidate_explicit_override_allows_user_created_targets() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["narrow-a", "narrow-b"] {
            write_test_skill(tmp.path(), name, &format!("# {name}\n\n- Keep guidance."));
            crate::skill_telemetry::record_skill_created(tmp.path(), name);
            crate::skill_provenance::record_user_created(tmp.path(), name);
        }
        let ctx = ToolContext::new(AppState::new(tmp.path()));

        SkillCuratorTool
            .call(
                serde_json::json!({
                    "action": "consolidate",
                    "into": "umbrella",
                    "targets": ["narrow-a", "narrow-b"],
                    "include_non_agent_created": true
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/umbrella/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-a/SKILL.md")
                .is_file()
        );
        assert!(
            tmp.path()
                .join(".kcoder/skills/.archive/narrow-b/SKILL.md")
                .is_file()
        );
        assert_eq!(backup_files(tmp.path()).len(), 1);
    }

    fn write_test_skill(cwd: &Path, name: &str, body: &str) {
        let skill_dir = cwd.join(".kcoder").join("skills").join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {name}\n---\n\n{body}\n"),
        )
        .unwrap();
    }

    fn output_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn backup_files(cwd: &Path) -> Vec<PathBuf> {
        let mut backups = std::fs::read_dir(cwd.join(".kcoder/skills/.backups"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("gz"))
            .collect::<Vec<_>>();
        backups.sort();
        backups
    }

    fn assert_backup_contains(path: &Path, needle: &str) {
        let mut decoder = GzDecoder::new(std::fs::File::open(path).unwrap());
        let mut bytes = Vec::new();
        decoder.read_to_end(&mut bytes).unwrap();
        assert!(
            bytes
                .windows(needle.len())
                .any(|window| window == needle.as_bytes()),
            "backup {:?} should include tar entry {needle}",
            path
        );
    }
}
