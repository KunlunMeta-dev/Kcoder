//! Spec-driven development tools for KCoder.
//!
//! These tools expose the `kcoder_specs` crate operations to the model so it
//! can initialize, create, validate, and archive spec-driven changes.

use crate::agent::{MAX_AGENT_MAX_TURNS, MIN_AGENT_MAX_TURNS, clamp_agent_max_turns};
use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::task::JoinSet;

/// Initialize the spec subsystem for the current project.
#[derive(Debug, Default)]
pub struct SpecInitTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecInitInput {
    /// Overwrite existing skill files with the bundled versions.
    #[serde(default)]
    pub force_update: bool,
}

/// Update bundled spec workflow skills for the current project.
#[derive(Debug, Default)]
pub struct SpecUpdateTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecUpdateInput {
    /// Report planned updates without writing files.
    #[serde(default)]
    pub dry_run: bool,
    /// Overwrite bundled Superpowers skills even when local content differs.
    #[serde(default)]
    pub force_update: bool,
}

/// Create a new spec-driven change.
#[derive(Debug, Default)]
pub struct SpecNewChangeTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecNewChangeInput {
    /// Kebab-case change name.
    pub name: String,
    /// Optional human-readable title.
    pub title: Option<String>,
}

/// Archive a completed change.
#[derive(Debug, Default)]
pub struct SpecArchiveTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecArchiveInput {
    /// Name of the change to archive.
    pub name: String,
}

/// Show the status of a change.
#[derive(Debug, Default)]
pub struct SpecStatusTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecStatusInput {
    /// Name of the change to report on using the quick dashboard.
    #[serde(default)]
    pub name: Option<String>,
    /// Name of the change to read deeply, including its artifact files.
    #[serde(default)]
    pub change: Option<String>,
    /// Include delta spec markdown files for a deep read. Defaults to true.
    #[serde(default = "default_include_specs")]
    pub include_specs: bool,
    /// Maximum bytes to return per file during a deep read.
    #[serde(default = "default_spec_show_max_bytes")]
    pub max_file_bytes: usize,
}

/// Show structured details and files for a spec-driven change.
#[derive(Debug, Default)]
pub struct StatusDeepRead;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct StatusDeepReadInput {
    /// Name of the change to show.
    pub name: String,
    /// Include delta spec markdown files under specs/**. Defaults to true.
    #[serde(default = "default_include_specs")]
    pub include_specs: bool,
    /// Maximum bytes to return per file. Defaults to 65536.
    #[serde(default = "default_spec_show_max_bytes")]
    pub max_file_bytes: usize,
}

/// Run apply-time preflight checks for a spec-driven change.
#[derive(Debug, Default)]
pub struct SpecPreflightOperation;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecPreflightOperationInput {
    /// Name of the change to check.
    pub name: String,
}

fn default_include_specs() -> bool {
    true
}

fn default_spec_show_max_bytes() -> usize {
    65_536
}

/// Validate a change or the whole spec subsystem.
#[derive(Debug, Default)]
pub struct CheckValidateStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckValidateStageInput {
    /// Optional specific change to validate. If omitted, all active changes are validated.
    pub change: Option<String>,
}

/// Compare spec scenarios against the project's test suite.
#[derive(Debug, Default)]
pub struct CheckVerifyStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CheckVerifyStageInput {}

/// Validate, verify, or preflight the spec subsystem.
#[derive(Debug, Default)]
pub struct SpecCheckTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpecCheckAction {
    Validate,
    Verify,
    Preflight,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecCheckInput {
    pub action: SpecCheckAction,
    /// Optional change for validate; required for preflight.
    #[serde(default)]
    pub change: Option<String>,
    /// Compatibility field accepted as the preflight change name.
    #[serde(default)]
    pub name: Option<String>,
}

/// Record retained verification evidence for a spec-driven change.
#[derive(Debug, Default)]
pub struct SpecRecordVerificationTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecRecordVerificationInput {
    /// Name of the change whose verification.md should be updated.
    pub name: String,
    /// Completion decision, e.g. `complete`, `verified`, `pending`, or `failed`.
    pub completion_decision: String,
    /// Commands that were run and their outcome.
    #[serde(default)]
    pub commands_run: Vec<String>,
    /// Manual checks that were performed.
    #[serde(default)]
    pub manual_checks: Vec<String>,
    /// Evidence paths, logs, screenshots, or other supporting references.
    #[serde(default)]
    pub evidence: Vec<String>,
    /// Known residual risks or `none`.
    #[serde(default)]
    pub residual_risks: Vec<String>,
}

/// Write review findings back into spec-driven-superpowers artifacts.
#[derive(Debug, Default)]
pub struct ReviewWritebackStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReviewWritebackStageInput {
    /// Name of the change whose review findings should be written back.
    pub name: String,
    /// Review status to record, e.g. `findings-received`, `approved`, or `changes-requested`.
    pub review_status: String,
    /// Finding disposition summary lines for review.md.
    #[serde(default)]
    pub findings_summary: Vec<String>,
    /// Accepted findings that require implementation follow-up in tasks.md and plan.md.
    #[serde(default)]
    pub accepted_followups: Vec<String>,
    /// Accepted findings or risks that should be retained in verification.md.
    #[serde(default)]
    pub verification_notes: Vec<String>,
}

/// Build a code-review request for a spec-driven change.
#[derive(Debug, Default)]
pub struct SpecReviewTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecReviewInput {
    /// Review stage. Defaults to prepare.
    #[serde(default)]
    pub action: SpecReviewAction,
    /// Name of the change to review.
    pub name: String,
    /// Optional git base SHA or ref (defaults to origin/main or HEAD~1).
    #[serde(default)]
    pub base_sha: Option<String>,
    /// Maximum turns for dispatch.
    #[serde(default = "default_review_turns")]
    pub max_turns: usize,
    /// Review status for writeback.
    #[serde(default)]
    pub review_status: Option<String>,
    #[serde(default)]
    pub findings_summary: Vec<String>,
    #[serde(default)]
    pub accepted_followups: Vec<String>,
    #[serde(default)]
    pub verification_notes: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpecReviewAction {
    #[default]
    Prepare,
    Dispatch,
    Writeback,
}

/// Dispatch a code reviewer subagent for a spec-driven change.
#[derive(Debug, Default)]
pub struct ReviewDispatchStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ReviewDispatchStageInput {
    /// Name of the change to review.
    pub name: String,
    /// Optional git base SHA or ref.
    #[serde(default)]
    pub base_sha: Option<String>,
    /// Maximum turns for the reviewer subagent.
    #[serde(default = "default_review_turns")]
    pub max_turns: usize,
}

fn default_review_turns() -> usize {
    30
}

fn schema_with_agent_turn_bounds<T: JsonSchema>() -> Value {
    let mut schema = clean_schema(schemars::schema_for!(T));
    if let Value::Object(ref mut map) = schema
        && let Some(Value::Object(props)) = map.get_mut("properties")
    {
        props.insert(
            "max_turns".to_string(),
            serde_json::json!({
                "type": "integer",
                "minimum": MIN_AGENT_MAX_TURNS,
                "maximum": MAX_AGENT_MAX_TURNS,
                "description": format!(
                    "Maximum number of turns per subagent. Defaults to {}, min {}, max {}.",
                    default_review_turns(),
                    MIN_AGENT_MAX_TURNS,
                    MAX_AGENT_MAX_TURNS
                )
            }),
        );
    }
    schema
}

const USING_SPECS_SKILL_NAME: &str = "using-specs";
const SUPERPOWERS_ROOT_SKILL_NAME: &str = "using-superpowers";

fn activate_skill(ctx: &ToolContext, name: &str) -> bool {
    let Some(active_skills) = ctx.active_skills.as_ref() else {
        return false;
    };

    let mut active = active_skills.write().unwrap();
    if active.iter().any(|skill| skill == name) {
        return false;
    }
    active.push(name.to_string());
    true
}

fn activate_using_specs_skill(ctx: &ToolContext) -> bool {
    activate_skill(ctx, USING_SPECS_SKILL_NAME)
}

fn activate_superpowers_root_skill(ctx: &ToolContext) -> bool {
    activate_skill(ctx, SUPERPOWERS_ROOT_SKILL_NAME)
}

fn reload_skill_registry(ctx: &ToolContext) -> Result<bool, ToolError> {
    ctx.reload_skill_registry()
}

fn rendered_using_specs_content(cwd: &Path) -> String {
    let specs_dir = cwd.join(kcoder_specs::SPECS_DIR);
    let config = kcoder_specs::config::read_or_default(&specs_dir).ok();
    kcoder_specs::render_using_specs_skill(config.as_ref())
}

struct UsingSpecsUpdatePlan {
    action: String,
    conflict: bool,
    new_file: PathBuf,
}

fn plan_using_specs_update(
    cwd: &Path,
    expected_content: &str,
    force_update: bool,
) -> UsingSpecsUpdatePlan {
    let skill_file = cwd.join(kcoder_specs::SPEC_SKILL_DIR).join("SKILL.md");
    let new_file = skill_file.with_file_name("SKILL.md.new");
    let expected_hash = crate::bundled_skills::stable_hash(expected_content);
    let explicit_non_bundled = crate::skill_provenance::load_project_provenance(cwd)
        .ok()
        .and_then(|store| store.skills.get("using-specs").cloned())
        .is_some_and(|record| record.origin != crate::skill_provenance::SkillOrigin::Bundled);

    let action = match fs::read_to_string(&skill_file) {
        Ok(local) if crate::bundled_skills::stable_hash(&local) == expected_hash => {
            "unchanged: using-specs".to_string()
        }
        Ok(_) if explicit_non_bundled && !force_update => {
            format!("conflict: using-specs -> {}", new_file.display())
        }
        Ok(_) => format!("update: using-specs -> {}", skill_file.display()),
        Err(_) => format!("install: using-specs -> {}", skill_file.display()),
    };
    let conflict = action.starts_with("conflict: ");
    UsingSpecsUpdatePlan {
        action,
        conflict,
        new_file,
    }
}

fn maybe_generate_lessons_learned_skill(
    ctx: &ToolContext,
    change_name: &str,
    archive_dir: &Path,
) -> Result<Option<PathBuf>, ToolError> {
    if !ctx.auto_lessons_learned {
        return Ok(None);
    }
    let skill_name = format!("lessons-learned-{}", sanitize_skill_name(change_name));
    let skill_dir = project_skills_root(&ctx.state.cwd()).join(&skill_name);
    let skill_file = skill_dir.join("SKILL.md");
    if skill_file.exists() {
        return Ok(None);
    }

    let content = render_lessons_skill(&ctx.state.cwd(), change_name, archive_dir, &skill_name)?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut provenance = kcoder_skills::SkillMetadataPatch::default();
    provenance
        .create
        .insert("origin".to_string(), serde_json::json!("agent_created"));
    provenance
        .create
        .insert("created_by".to_string(), serde_json::json!("agent"));
    provenance
        .create
        .insert("created_at".to_string(), serde_json::json!(now.clone()));
    provenance.update.insert(
        "write_origin".to_string(),
        serde_json::json!(format!("lessons_learned:{change_name}")),
    );
    let mut usage = kcoder_skills::SkillMetadataPatch::default();
    usage
        .create
        .insert("created_at".to_string(), serde_json::json!(now));
    usage
        .create
        .insert("state".to_string(), serde_json::json!("active"));
    usage
        .create
        .insert("pinned".to_string(), serde_json::json!(false));
    let root = project_skills_root(&ctx.state.cwd());
    let store = kcoder_skills::SkillStore::open(&root).map_err(skill_store_error)?;
    let session_id = ctx.state.session_id();
    let operation_identity = ctx
        .tool_call_id
        .clone()
        .unwrap_or_else(|| session_id.clone());
    let receipt = store
        .commit(kcoder_skills::SkillCommitRequest {
            operation_id: format!("lessons-learned:{}:{}", skill_name, operation_identity),
            actor: kcoder_skills::SkillMutationActor::System {
                component: format!("lessons_learned:{change_name}"),
                session_id: Some(session_id),
            },
            operation: kcoder_skills::SkillOperationKind::LessonsLearned,
            preconditions: Vec::new(),
            mutations: vec![kcoder_skills::SkillMutation::PutPackage {
                package: kcoder_skills::SkillPackage {
                    name: skill_name.clone(),
                    files: vec![kcoder_skills::SkillPackageFile {
                        relative_path: PathBuf::from("SKILL.md"),
                        content: content.into_bytes(),
                        executable: false,
                    }],
                },
                expected: kcoder_skills::ExpectedSkillRevision::Absent,
            }],
            metadata: kcoder_skills::SkillMetadataDelta {
                provenance: std::collections::BTreeMap::from([(skill_name.clone(), provenance)]),
                usage: std::collections::BTreeMap::from([(skill_name.clone(), usage)]),
                ..Default::default()
            },
        })
        .map_err(skill_store_error)?;
    let mut refresh = ctx.clone();
    refresh.record_project_skill_telemetry = false;
    match refresh.reload_skill_registry() {
        Ok(_) => record_spec_reload_status(&root, Some(&receipt.transaction_id), true),
        Err(error) => {
            record_spec_reload_status(&root, Some(&receipt.transaction_id), false);
            tracing::warn!(%error, "lessons-learned transaction committed but registry reload is pending");
        }
    }
    Ok(Some(skill_file))
}

fn render_lessons_skill(
    cwd: &Path,
    change_name: &str,
    archive_dir: &Path,
    skill_name: &str,
) -> Result<String, ToolError> {
    let capability = change_name.replace('-', " ");
    let relative_archive = archive_dir.strip_prefix(cwd).unwrap_or(archive_dir);
    let mut content = String::new();
    let _ = writeln!(content, "---");
    let _ = writeln!(content, "name: {skill_name}");
    let _ = writeln!(
        content,
        "description: Use when working on {capability} to reuse lessons from archived spec change `{change_name}`."
    );
    let _ = writeln!(content, "---\n");
    let _ = writeln!(content, "# Lessons Learned: {capability}\n");
    let _ = writeln!(
        content,
        "From archived change `{change_name}` at `{}`.\n",
        relative_archive.display()
    );

    let proposal = read_optional(archive_dir.join("proposal.md"))?;
    let design = read_optional(archive_dir.join("design.md"))?;
    let tasks = read_optional(archive_dir.join("tasks.md"))?;
    let specs = collect_archived_spec_markdown(archive_dir)?;

    write_section(
        &mut content,
        "Context",
        extract_relevant_lines(&[proposal.as_deref(), design.as_deref()], 6),
        &[
            format!("Review archived change `{change_name}` before making related changes."),
            format!(
                "Use `{}` as the source artifact for full detail.",
                relative_archive.display()
            ),
        ],
    );
    write_section(
        &mut content,
        "Pitfalls",
        extract_keyword_lines(
            &[proposal.as_deref(), design.as_deref(), tasks.as_deref()],
            &[
                "risk",
                "pitfall",
                "caution",
                "block",
                "conflict",
                "migration",
                "rollback",
            ],
            8,
        ),
        &[format!(
            "Check proposal, design, and tasks from `{change_name}` for assumptions before reusing this approach."
        )],
    );
    write_section(
        &mut content,
        "Verification Steps",
        extract_keyword_lines(
            &[proposal.as_deref(), design.as_deref(), tasks.as_deref()],
            &["test", "verify", "validation", "precheck", "cargo", "run"],
            8,
        ),
        &[
            "Run the archived change's verification steps before claiming related work is complete.".to_string(),
            "Prefer project-specific precheck commands from `.kcoder/specs/config.yaml` when present.".to_string(),
        ],
    );
    write_section(
        &mut content,
        "Relevant Requirements",
        extract_relevant_lines(
            &specs
                .iter()
                .map(String::as_str)
                .map(Some)
                .collect::<Vec<_>>(),
            8,
        ),
        &[format!(
            "Inspect `{}/specs/` for the merged requirements that motivated this lesson.",
            relative_archive.display()
        )],
    );

    Ok(content)
}

fn write_section(content: &mut String, title: &str, items: Vec<String>, fallback: &[String]) {
    let _ = writeln!(content, "## {title}");
    let items = if items.is_empty() {
        fallback.to_vec()
    } else {
        items
    };
    for item in items {
        let _ = writeln!(content, "- {}", item.trim());
    }
    content.push('\n');
}

fn read_optional(path: impl AsRef<Path>) -> Result<Option<String>, ToolError> {
    let path = path.as_ref();
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", path)))
}

fn collect_archived_spec_markdown(archive_dir: &Path) -> Result<Vec<String>, ToolError> {
    let specs_dir = archive_dir.join("specs");
    if !specs_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_markdown_files(&specs_dir, &mut files)?;
    files.sort();
    files
        .into_iter()
        .map(|path| {
            fs::read_to_string(&path)
                .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", path)))
        })
        .collect()
}

fn extract_relevant_lines(inputs: &[Option<&str>], limit: usize) -> Vec<String> {
    let mut items = Vec::new();
    for input in inputs.iter().flatten() {
        for line in input.lines() {
            let raw = line.trim();
            if !is_heading_or_list_item(raw) {
                continue;
            }
            let line = clean_lesson_line(line);
            if line.is_empty() || line == "---" {
                continue;
            }
            push_unique_lesson(&mut items, line, limit);
            if items.len() >= limit {
                return items;
            }
        }
    }
    items
}

fn extract_keyword_lines(inputs: &[Option<&str>], keywords: &[&str], limit: usize) -> Vec<String> {
    let mut items = Vec::new();
    for input in inputs.iter().flatten() {
        for line in input.lines() {
            let line = clean_lesson_line(line);
            let lower = line.to_ascii_lowercase();
            if !line.is_empty() && keywords.iter().any(|keyword| lower.contains(keyword)) {
                push_unique_lesson(&mut items, line, limit);
                if items.len() >= limit {
                    return items;
                }
            }
        }
    }
    items
}

fn clean_lesson_line(line: &str) -> String {
    line.trim()
        .trim_start_matches('#')
        .trim_start_matches('-')
        .trim_start_matches('*')
        .trim()
        .to_string()
}

fn is_heading_or_list_item(line: &str) -> bool {
    line.starts_with('#')
        || line.starts_with('-')
        || line.starts_with('*')
        || line.contains("SHALL")
}

fn push_unique_lesson(items: &mut Vec<String>, item: String, limit: usize) {
    if item.len() > 240 || items.iter().any(|existing| existing == &item) {
        return;
    }
    if items.len() < limit {
        items.push(item);
    }
}

fn sanitize_skill_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "change".to_string()
    } else {
        trimmed.to_string()
    }
}

fn project_skills_root(cwd: &Path) -> PathBuf {
    crate::skill_provenance::project_skills_root(cwd)
}

fn write_using_specs_conflict(
    ctx: &ToolContext,
    root: &Path,
    path: &Path,
    content: &str,
) -> Result<kcoder_skills::SkillCommitReceipt, ToolError> {
    let relative = path.strip_prefix(root).map_err(|_| {
        ToolError::InvalidInput("using-specs conflict path escaped the skill root".to_string())
    })?;
    let store = kcoder_skills::SkillStore::open(root).map_err(skill_store_error)?;
    store
        .commit(kcoder_skills::SkillCommitRequest {
            operation_id: format!(
                "spec-conflict:{}",
                ctx.tool_call_id
                    .clone()
                    .unwrap_or_else(|| ctx.state.session_id())
            ),
            actor: kcoder_skills::SkillMutationActor::ForegroundAgent {
                session_id: ctx.state.session_id(),
                tool_call_id: ctx
                    .tool_call_id
                    .clone()
                    .unwrap_or_else(|| "spec-update".to_string()),
            },
            operation: kcoder_skills::SkillOperationKind::SpecSync,
            preconditions: Vec::new(),
            mutations: Vec::new(),
            metadata: kcoder_skills::SkillMetadataDelta {
                auxiliary_files: std::collections::BTreeMap::from([(
                    relative.to_path_buf(),
                    content.as_bytes().to_vec(),
                )]),
                ..Default::default()
            },
        })
        .map_err(skill_store_error)
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

fn record_spec_reload_status(root: &Path, transaction_id: Option<&str>, reloaded: bool) {
    let Some(transaction_id) = transaction_id else {
        return;
    };
    match kcoder_skills::SkillStore::open(root)
        .and_then(|store| store.record_reload_status(transaction_id, reloaded))
    {
        Ok(()) => {}
        Err(error) => tracing::warn!(
            %error,
            transaction_id,
            "failed to persist spec skill registry reload status"
        ),
    }
}

fn require_using_specs_skill(ctx: &ToolContext) -> Result<(), ToolError> {
    let Some(active_skills) = ctx.active_skills.as_ref() else {
        return Err(ToolError::Execution(
            "spec workflow requires active skill tracking; activate `using-superpowers` and `using-specs` before mutating specs"
                .to_string(),
        ));
    };

    let active = active_skills.read().unwrap();
    let has_using_specs = active.iter().any(|skill| skill == USING_SPECS_SKILL_NAME);
    let has_superpowers_root = active
        .iter()
        .any(|skill| skill == SUPERPOWERS_ROOT_SKILL_NAME);
    if has_using_specs && has_superpowers_root {
        return Ok(());
    }

    Err(ToolError::Execution(
        "spec workflow is locked: activate `using-superpowers` and `using-specs` before creating, \
         syncing, archiving, configuring, or delegating spec-driven changes"
            .to_string(),
    ))
}

/// Delegate delta-spec drafting for multiple independent domains to parallel subagents.
#[derive(Debug, Default)]
pub struct SpecParallelDraftTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecParallelDraftInput {
    /// Name of the change whose deltas should be drafted.
    pub name: String,
    /// Independent capability domains to draft in parallel.
    pub domains: Vec<String>,
    /// Maximum turns per subagent.
    #[serde(default = "default_review_turns")]
    pub max_turns: usize,
}

/// Read a value from .kcoder/specs/config.yaml.
#[derive(Debug, Default)]
pub struct ConfigGetStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConfigGetStageInput {
    /// Config key to read (`schema`, `context`, `precheck`, `rules.<artifact>`).
    /// If omitted, returns the whole config file.
    #[serde(default)]
    pub key: Option<String>,
}

/// Set a value in .kcoder/specs/config.yaml.
#[derive(Debug, Default)]
pub struct ConfigSetStage;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ConfigSetStageInput {
    /// Config key to set (`schema`, `context`, `precheck`, `rules.<artifact>`).
    pub key: String,
    /// New value. For `rules.<artifact>` use a YAML list of strings.
    pub value: String,
}

#[derive(Debug, Default)]
pub struct SpecConfigTool;

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpecConfigAction {
    Get,
    Set,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecConfigInput {
    pub action: SpecConfigAction,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

/// Rebase a spec-driven change against the current authoritative specs.
#[derive(Debug, Default)]
pub struct SpecSyncTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SpecSyncInput {
    /// Name of the change to sync.
    pub name: String,
}

#[async_trait]
impl Tool for SpecInitTool {
    fn name(&self) -> String {
        "SpecInit".to_string()
    }

    fn description(&self) -> String {
        "Initialize the spec-driven development subsystem for this project. \
         Creates .kcoder/specs, a starter spec, and auto-triggered using-specs/Superpowers skills."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecInitInput))
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecInitInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let worker_cwd = cwd.clone();
        let force_update = input.force_update;
        let initialized = tokio::task::spawn_blocking(move || {
            let (path, receipts) = kcoder_specs::init_with_force_report(&worker_cwd, force_update)
                .map_err(|error| ToolError::Execution(format!("failed to init specs: {error}")))?;
            let bundled = crate::bundled_skills::sync_bundled(
                &project_skills_root(&worker_cwd),
                false,
                force_update,
            )?;
            Ok::<_, ToolError>((path, receipts, bundled))
        })
        .await
        .map_err(|error| ToolError::Execution(format!("spec init worker failed: {error}")))?;

        match initialized {
            Ok((path, receipts, bundled)) => {
                let transaction_id = bundled.transaction_id.clone().or_else(|| {
                    receipts
                        .last()
                        .map(|receipt| receipt.transaction_id.clone())
                });
                let mut text = format!("Initialized spec subsystem at {}", path.display());
                if input.force_update {
                    text.push_str(" (skills updated)");
                }
                match reload_skill_registry(ctx) {
                    Ok(true) => {
                        text.push_str("; skill registry reloaded");
                        record_spec_reload_status(
                            &project_skills_root(&ctx.state.cwd()),
                            transaction_id.as_deref(),
                            true,
                        );
                    }
                    Ok(false) => {}
                    Err(error) => {
                        text.push_str(&format!(
                            "; committed_reload_pending ({error}); only retry registry reload"
                        ));
                        record_spec_reload_status(
                            &project_skills_root(&ctx.state.cwd()),
                            transaction_id.as_deref(),
                            false,
                        );
                    }
                }
                if activate_using_specs_skill(ctx) {
                    text.push_str("; using-specs activated");
                }
                if activate_superpowers_root_skill(ctx) {
                    text.push_str("; using-superpowers activated");
                }
                Ok(ToolOutput::text(text))
            }
            Err(error) => Err(error),
        }
    }
}

#[async_trait]
impl Tool for SpecUpdateTool {
    fn name(&self) -> String {
        "SpecUpdate".to_string()
    }

    fn description(&self) -> String {
        "Update the project's spec workflow skills. Runs bundled Superpowers skill sync, \
         regenerates the auto-triggered using-specs skill from .kcoder/specs/config.yaml, \
         records bundled provenance, and reloads the live skill registry."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecUpdateInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecUpdateInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let root = project_skills_root(&cwd);
        let using_specs_content = rendered_using_specs_content(&cwd);
        let using_specs_plan =
            plan_using_specs_update(&cwd, &using_specs_content, input.force_update);
        let worker_root = root.clone();
        let dry_run = input.dry_run;
        let force_update = input.force_update;
        let bundled = tokio::task::spawn_blocking(move || {
            crate::bundled_skills::sync_bundled(&worker_root, dry_run, force_update)
        })
        .await
        .map_err(|error| ToolError::Execution(format!("bundled sync worker failed: {error}")))??;

        let mut actions = vec![using_specs_plan.action.clone()];
        if !input.dry_run {
            let transaction_id;
            if using_specs_plan.conflict {
                let worker_ctx = ctx.clone();
                let worker_root = root.clone();
                let new_file = using_specs_plan.new_file.clone();
                let content = using_specs_content.clone();
                let receipt = tokio::task::spawn_blocking(move || {
                    write_using_specs_conflict(&worker_ctx, &worker_root, &new_file, &content)
                })
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("spec conflict worker failed: {error}"))
                })??;
                transaction_id = Some(receipt.transaction_id);
            } else {
                let worker_cwd = cwd.clone();
                let (_, receipt) = tokio::task::spawn_blocking(move || {
                    kcoder_specs::sync_using_specs_skill_report(&worker_cwd)
                })
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("using-specs worker failed: {error}"))
                })?
                .map_err(|e| {
                    ToolError::Execution(format!("failed to regenerate using-specs skill: {e}"))
                })?;
                transaction_id = Some(receipt.transaction_id);
            }
            match reload_skill_registry(ctx) {
                Ok(_) => {
                    activate_using_specs_skill(ctx);
                    activate_superpowers_root_skill(ctx);
                    actions.push("skill registry reloaded".to_string());
                    record_spec_reload_status(&root, transaction_id.as_deref(), true);
                }
                Err(error) => {
                    actions.push(format!(
                        "committed_reload_pending: {error}; only retry registry reload"
                    ));
                    record_spec_reload_status(&root, transaction_id.as_deref(), false);
                }
            }
        }

        let output = serde_json::json!({
            "success": true,
            "dry_run": input.dry_run,
            "force_update": input.force_update,
            "bundled": bundled,
            "actions": actions,
        });
        serde_json::to_string_pretty(&output)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize spec update: {e}")))
    }
}

#[async_trait]
impl Tool for SpecNewChangeTool {
    fn name(&self) -> String {
        "SpecNewChange".to_string()
    }

    fn description(&self) -> String {
        "Create a new spec-driven change scaffold under .kcoder/specs/changes/. \
         Creates proposal.md, design.md, tasks.md, schema-specific artifacts such as \
         review.md/plan.md, and a starter delta spec at specs/<capability>/spec.md. \
         Requires the `using-superpowers` and `using-specs` skills to be active \
         first; activate them via the `skill` tool if this fails with a \
         workflow-locked error."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecNewChangeInput))
    }

    fn is_destructive(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecNewChangeInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::new_change(&ctx.state.cwd(), &input.name, input.title) {
            Ok(path) => Ok(ToolOutput::text(format!(
                "Created change at {}",
                path.display()
            ))),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to create change: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecArchiveTool {
    fn name(&self) -> String {
        "SpecArchive".to_string()
    }

    fn description(&self) -> String {
        "Archive a completed spec-driven change. Before merging, it automatically \
         rejects incomplete tasks and schema readiness blockers, syncs unchanged \
         deltas, runs the project precheck configured in .kcoder/specs/config.yaml, \
         and checks for unresolved spec conflicts or drift. \
         On success the change is moved to .kcoder/specs/changes/archive/."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecArchiveInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecArchiveInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;
        let worker_ctx = ctx.clone();
        let change_name = input.name;
        tokio::task::spawn_blocking(move || {
            match kcoder_specs::archive(&worker_ctx.state.cwd(), &change_name) {
                Ok(path) => {
                    let lessons =
                        maybe_generate_lessons_learned_skill(&worker_ctx, &change_name, &path)?;
                    let mut message = format!("Archived change to {}", path.display());
                    if let Some(lessons) = lessons {
                        message.push_str(&format!(
                            "; generated lessons-learned skill at {}",
                            lessons.display()
                        ));
                    }
                    Ok(ToolOutput::text(message))
                }
                Err(e) => Err(ToolError::Execution(format!(
                    "failed to archive change: {}",
                    e
                ))),
            }
        })
        .await
        .map_err(|error| ToolError::Execution(format!("spec archive worker failed: {error}")))?
    }
}

#[async_trait]
impl Tool for SpecStatusTool {
    fn name(&self) -> String {
        "SpecStatus".to_string()
    }

    fn description(&self) -> String {
        "List active spec changes, show one change's quick dashboard with name, or deeply read its artifacts with change. Validation, verification, and apply preflight require the corresponding attached checking capability."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecStatusInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecStatusInput = parse_input(&input)?;
        if let Some(change) = input.change {
            return StatusDeepRead
                .call(
                    serde_json::json!({
                        "name": change,
                        "include_specs": input.include_specs,
                        "max_file_bytes": input.max_file_bytes,
                    }),
                    ctx,
                )
                .await;
        }
        let Some(name) = input.name else {
            let changes = kcoder_specs::list_changes(&ctx.state.cwd())
                .map_err(|e| ToolError::Execution(format!("failed to list changes: {e}")))?;
            return serde_json::to_string_pretty(&serde_json::json!({"changes": changes}))
                .map(ToolOutput::text)
                .map_err(|e| ToolError::Execution(format!("failed to serialize status: {e}")));
        };

        match kcoder_specs::status(&ctx.state.cwd(), &name) {
            Ok(summary) => {
                let artifacts = summary
                    .artifacts
                    .iter()
                    .map(|artifact| {
                        (
                            artifact.name.clone(),
                            serde_json::json!({
                                "exists": artifact.present,
                                "complete": artifact.non_empty,
                            }),
                        )
                    })
                    .collect::<serde_json::Map<_, _>>();
                let required_artifacts_complete =
                    summary.artifacts.iter().all(|artifact| artifact.non_empty);
                let drift_ok = summary.drift_errors.is_empty();
                let apply_blockers = summary.apply_blockers.clone();
                let apply_ok = apply_blockers.is_empty();
                let ready_to_apply =
                    required_artifacts_complete && summary.tasks_complete && drift_ok && apply_ok;
                let output = serde_json::json!({
                    "change": summary.name,
                    "title": summary.title,
                    "schema": summary.schema,
                    "status": summary.status,
                    "artifacts": artifacts,
                    "tasks": {
                        "complete": summary.tasks_complete,
                    },
                    "drift": {
                        "ok": drift_ok,
                        "errors": summary.drift_errors,
                    },
                    "apply": {
                        "blockers": apply_blockers,
                    },
                    "completion": {
                        "blockers": summary.completion_blockers,
                    },
                    "verification": summary.verification,
                    "ready_to_apply": ready_to_apply,
                });
                serde_json::to_string_pretty(&output)
                    .map(ToolOutput::text)
                    .map_err(|e| ToolError::Execution(format!("failed to serialize status: {e}")))
            }
            Err(e) => Err(ToolError::Execution(format!("failed to get status: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for StatusDeepRead {
    fn name(&self) -> String {
        "SpecStatus".to_string()
    }

    fn description(&self) -> String {
        "Show a spec-driven change as structured JSON: status summary plus proposal, \
         tasks, optional design, and delta spec files. This is the deep read of one change; \
         for a quick drift/completion glance use SpecStatus, rule enforcement requires an attached checking capability. Prefer this over directly guessing paths under .kcoder/specs/changes."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(StatusDeepReadInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: StatusDeepReadInput = parse_input(&input)?;
        let cwd = ctx.state.cwd();
        let change_dir = cwd
            .join(kcoder_specs::SPECS_DIR)
            .join("changes")
            .join(&input.name);
        if !change_dir.is_dir() {
            return Err(ToolError::InvalidInput(format!(
                "change '{}' does not exist",
                input.name
            )));
        }
        let status = kcoder_specs::status(&cwd, &input.name)
            .map_err(|e| ToolError::Execution(format!("failed to get status: {e}")))?;
        let mut files = Vec::new();
        for file in [
            "proposal.md",
            "design.md",
            "review.md",
            "tasks.md",
            "plan.md",
            "verification.md",
        ] {
            let path = change_dir.join(file);
            if path.is_file() {
                files.push(read_spec_show_file(
                    &change_dir,
                    &path,
                    input.max_file_bytes,
                )?);
            }
        }
        if input.include_specs {
            let specs_dir = change_dir.join("specs");
            if specs_dir.is_dir() {
                collect_spec_show_files(&change_dir, &specs_dir, input.max_file_bytes, &mut files)?;
            }
        }
        let output = serde_json::json!({
            "name": input.name,
            "status": status,
            "files": files,
        });
        serde_json::to_string_pretty(&output)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize spec show: {e}")))
    }
}

#[async_trait]
impl Tool for SpecPreflightOperation {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Run apply-time preflight checks for a spec-driven change: the gate that decides whether a change may be applied/archived. \
         For spec-driven-superpowers changes, checks review.md readiness, active modes, \
         plan.md task coverage, validation mapping, and retained-verification requirements. \
         This is the go/no-go gate before apply; action=validate checks structure and \
         action=verify checks test coverage — neither is a substitute for this gate."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecPreflightOperationInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecPreflightOperationInput = parse_input(&input)?;
        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::apply_preflight(&ctx.state.cwd(), &input.name) {
            Ok(report) => serde_json::to_string_pretty(&report)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize apply preflight: {e}"))
                }),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to run apply preflight: {}",
                e
            ))),
        }
    }
}

fn collect_spec_show_files(
    change_dir: &std::path::Path,
    root: &std::path::Path,
    max_file_bytes: usize,
    files: &mut Vec<Value>,
) -> Result<(), ToolError> {
    let mut entries = Vec::new();
    collect_markdown_files(root, &mut entries)?;
    entries.sort();
    for path in entries {
        files.push(read_spec_show_file(change_dir, &path, max_file_bytes)?);
    }
    Ok(())
}

fn collect_markdown_files(
    root: &std::path::Path,
    out: &mut Vec<std::path::PathBuf>,
) -> Result<(), ToolError> {
    for entry in fs::read_dir(root)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", root)))?
    {
        let path = entry
            .map_err(|e| ToolError::Execution(format!("failed to read directory entry: {e}")))?
            .path();
        if path.is_dir() {
            collect_markdown_files(&path, out)?;
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

fn read_spec_show_file(
    change_dir: &std::path::Path,
    path: &std::path::Path,
    max_file_bytes: usize,
) -> Result<Value, ToolError> {
    let content = fs::read_to_string(path)
        .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", path)))?;
    let truncated = content.len() > max_file_bytes;
    let content = if truncated {
        truncate_utf8(&content, max_file_bytes).to_string()
    } else {
        content
    };
    let relative = path.strip_prefix(change_dir).unwrap_or(path);
    Ok(serde_json::json!({
        "path": relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
        "truncated": truncated,
        "content": content,
    }))
}

fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[async_trait]
impl Tool for SpecCheckTool {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Run read-only spec checks by action: validate structural and configured rules, verify scenario-to-test coverage, or preflight one change before apply/archive. Non-enforcing state inspection is a separate capability."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecCheckInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecCheckInput = parse_input(&input)?;
        match input.action {
            SpecCheckAction::Validate => {
                CheckValidateStage
                    .call(serde_json::json!({"change": input.change}), ctx)
                    .await
            }
            SpecCheckAction::Verify => CheckVerifyStage.call(serde_json::json!({}), ctx).await,
            SpecCheckAction::Preflight => {
                let name = input.change.or(input.name).ok_or_else(|| {
                    ToolError::InvalidInput("change is required for preflight".to_string())
                })?;
                SpecPreflightOperation
                    .call(serde_json::json!({"name": name}), ctx)
                    .await
            }
        }
    }
}

#[async_trait]
impl Tool for CheckValidateStage {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Validate a spec-driven change or the whole spec subsystem: structural checks on \
         required artifacts, spec/delta parsing, drift detection, and cross-platform/schema \
         rules from .kcoder/specs/config.yaml. This is the rule enforcer; SpecStatus only reads \
         state. Use action=verify for scenario-to-test coverage and action=preflight before archive."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CheckValidateStageInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: CheckValidateStageInput = parse_input(&input)?;

        match kcoder_specs::validate(&ctx.state.cwd(), input.change.as_deref()) {
            Ok(errors) => {
                if errors.is_empty() {
                    Ok(ToolOutput::text("Validation passed.".to_string()))
                } else {
                    let mut text = String::from("Validation errors:");
                    for err in errors {
                        let _ = writeln!(text, "\n- {}", err);
                    }
                    Ok(ToolOutput::text(text))
                }
            }
            Err(e) => Err(ToolError::Execution(format!("failed to validate: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for CheckVerifyStage {
    fn name(&self) -> String {
        "SpecCheck".to_string()
    }

    fn description(&self) -> String {
        "Compare spec scenarios against the project's test suite (cargo tests by default) and report coverage gaps. This differs from action=validate structural checks and action=preflight readiness checks."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(CheckVerifyStageInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let _: CheckVerifyStageInput = parse_input(&input)?;

        match kcoder_specs::verify(&ctx.state.cwd()) {
            Ok(report) => {
                let mut text = format!(
                    "Spec coverage: {} covered, {} gaps",
                    report.covered.len(),
                    report.gaps.len()
                );
                if !report.covered.is_empty() {
                    text.push_str("\n\nCovered:");
                    for item in &report.covered {
                        let _ = writeln!(text, "\n- {}", item);
                    }
                }
                if !report.gaps.is_empty() {
                    text.push_str("\n\nGaps:");
                    for item in &report.gaps {
                        let _ = writeln!(text, "\n- {}", item);
                    }
                }
                Ok(ToolOutput::text(text))
            }
            Err(e) => Err(ToolError::Execution(format!(
                "failed to verify specs: {:#}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecRecordVerificationTool {
    fn name(&self) -> String {
        "SpecRecordVerification".to_string()
    }

    fn description(&self) -> String {
        "Write retained verification evidence to `.kcoder/specs/changes/<name>/verification.md`. \
         Use this when Verification Mode is retained-recommended or retained-required, or when \
         commands/manual checks should be preserved with the change."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecRecordVerificationInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecRecordVerificationInput = parse_input(&input)?;
        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }
        let record = kcoder_specs::SpecVerificationRecord {
            completion_decision: input.completion_decision,
            commands_run: input.commands_run,
            manual_checks: input.manual_checks,
            evidence: input.evidence,
            residual_risks: input.residual_risks,
        };

        match kcoder_specs::record_verification(&ctx.state.cwd(), &input.name, record) {
            Ok(path) => Ok(ToolOutput::text(format!(
                "Recorded verification evidence at {}",
                path.display()
            ))),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to record verification: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for ReviewWritebackStage {
    fn name(&self) -> String {
        "SpecReview".to_string()
    }

    fn description(&self) -> String {
        "Write review findings back into the canonical spec-driven-superpowers artifacts (review stage 3 of 3). \
         Updates review.md Review Status and Findings Summary, appends accepted follow-ups \
         to tasks.md and plan.md, and can retain verification notes in verification.md while \
         preserving Manual Adjustments and Previous Iterations. Run this after SpecReview/ \
         action=dispatch produced findings (stages 1-2); it mutates the change artifacts."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ReviewWritebackStageInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReviewWritebackStageInput = parse_input(&input)?;
        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }
        if input.review_status.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "review_status cannot be empty".to_string(),
            ));
        }

        let record = kcoder_specs::SpecReviewWritebackRecord {
            review_status: input.review_status,
            findings_summary: input.findings_summary,
            accepted_followups: input.accepted_followups,
            verification_notes: input.verification_notes,
        };

        match kcoder_specs::review_writeback(&ctx.state.cwd(), &input.name, record) {
            Ok(report) => serde_json::to_string_pretty(&report)
                .map(ToolOutput::text)
                .map_err(|e| {
                    ToolError::Execution(format!("failed to serialize review writeback: {e}"))
                }),
            Err(e) => Err(ToolError::Execution(format!(
                "failed to write back review findings: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for SpecReviewTool {
    fn name(&self) -> String {
        "SpecReview".to_string()
    }

    fn description(&self) -> String {
        "Run the spec review lifecycle by action: prepare a reviewer prompt (default), dispatch a reviewer subagent, or writeback accepted findings into review/tasks/plan/verification artifacts. Writeback mutates files, so the consolidated tool is serialized."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        schema_with_agent_turn_bounds::<SpecReviewInput>()
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecReviewInput = parse_input(&input)?;

        match input.action {
            SpecReviewAction::Dispatch => {
                return ReviewDispatchStage
                    .call(
                        serde_json::json!({
                            "name": input.name,
                            "base_sha": input.base_sha,
                            "max_turns": input.max_turns,
                        }),
                        ctx,
                    )
                    .await;
            }
            SpecReviewAction::Writeback => {
                let review_status = input.review_status.ok_or_else(|| {
                    ToolError::InvalidInput("review_status is required for writeback".to_string())
                })?;
                return ReviewWritebackStage
                    .call(
                        serde_json::json!({
                            "name": input.name,
                            "review_status": review_status,
                            "findings_summary": input.findings_summary,
                            "accepted_followups": input.accepted_followups,
                            "verification_notes": input.verification_notes,
                        }),
                        ctx,
                    )
                    .await;
            }
            SpecReviewAction::Prepare => {}
        }

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::review(&ctx.state.cwd(), &input.name, input.base_sha.as_deref()) {
            Ok(report) => {
                let mut text = format!("# Code Review Request: {}\n\n", report.change_name);
                if let Some(title) = &report.title {
                    let _ = writeln!(text, "**Title:** {}\n", title);
                }
                let _ = writeln!(
                    text,
                    "**Base:** {}\n**Head:** {}\n",
                    report.git_base, report.git_head
                );
                if !report.git_diff_stat.is_empty() {
                    let _ = writeln!(text, "## Diff stat\n\n{}\n", report.git_diff_stat);
                }
                let _ = writeln!(
                    text,
                    "## Pre-review checks\n\n{}\n",
                    report.precheck_summary
                );
                let _ = writeln!(text, "## Reviewer prompt\n\n{}", report.reviewer_prompt);
                Ok(ToolOutput::text(text))
            }
            Err(e) => Err(ToolError::Execution(format!(
                "failed to build review: {}",
                e
            ))),
        }
    }
}

#[async_trait]
impl Tool for ReviewDispatchStage {
    fn name(&self) -> String {
        "SpecReview".to_string()
    }

    fn description(&self) -> String {
        "Dispatch a code reviewer subagent for a spec-driven change (review stage 2 of 3). \
         Builds the review prompt from the change metadata, deltas, git diff, \
         and pre-review checks, then runs a review subagent and returns its findings. \
         Prepare the prompt with SpecReview (stage 1) when you need to inspect or adjust it \
         first; persist accepted findings with action=writeback (stage 3)."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        schema_with_agent_turn_bounds::<ReviewDispatchStageInput>()
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ReviewDispatchStageInput = parse_input(&input)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        let report = kcoder_specs::review(&ctx.state.cwd(), &input.name, input.base_sha.as_deref())
            .map_err(|e| ToolError::Execution(format!("failed to build review: {}", e)))?;

        let runner = ctx
            .agent_runner
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| ToolError::Execution("agent runner not available".into()))?;

        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let prompt = report.reviewer_prompt;
        let max_turns = clamp_agent_max_turns(input.max_turns);
        let id =
            ctx.spawn_subagent_background(format!("spec review for {}", input.name), async move {
                match runner.run_agent(prompt, max_turns).await {
                    Ok(text) => ToolOutput::text(text),
                    Err(e) => ToolOutput::error(e.to_string()),
                }
            })?;

        Ok(ToolOutput::text(format!(
            "Started background spec review task {id}. It will run independently and the result will be incorporated automatically when it completes."
        )))
    }
}

#[async_trait]
impl Tool for SpecParallelDraftTool {
    fn name(&self) -> String {
        "SpecParallelDraft".to_string()
    }

    fn description(&self) -> String {
        "Draft delta specs for multiple independent domains in parallel. \
         Spawns one subagent per domain, each writing \
         `.kcoder/specs/changes/<name>/specs/<domain>/spec.md`."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        schema_with_agent_turn_bounds::<SpecParallelDraftInput>()
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecParallelDraftInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }
        if input.domains.is_empty() {
            return Err(ToolError::InvalidInput(
                "at least one domain must be specified".to_string(),
            ));
        }

        let cwd = ctx.state.cwd();
        let change_dir = cwd
            .join(".kcoder")
            .join("specs")
            .join("changes")
            .join(&input.name);
        if !change_dir.exists() {
            return Err(ToolError::Execution(format!(
                "change '{}' does not exist",
                input.name
            )));
        }

        let proposal = fs::read_to_string(change_dir.join("proposal.md")).unwrap_or_default();
        let runner = ctx
            .agent_runner
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| ToolError::Execution("agent runner not available".into()))?;

        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let name = input.name;
        let max_turns = clamp_agent_max_turns(input.max_turns);
        let domains: Vec<String> = input
            .domains
            .into_iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect();
        let id = ctx.spawn_subagent_background(
            format!("parallel spec draft for {} ({} domains)", name, domains.len()),
            async move {
                let mut join_set = JoinSet::new();
                for domain in domains {
                    let prompt = format!(
                        "You are drafting the spec delta for the '{domain}' capability as part of change \"{name}\".\n\n\
                         Context:\n\
                         - Proposal:\n{proposal}\n\n\
                         - Current authoritative spec: read `.kcoder/specs/specs/{domain}/spec.md` if it exists.\n\
                         - Change directory: `.kcoder/specs/changes/{name}/`\n\n\
                         Your task:\n\
                         1. Read the authoritative spec for '{domain}' if it exists.\n\
                         2. Write `.kcoder/specs/changes/{name}/specs/{domain}/spec.md` with ADDED/MODIFIED/REMOVED/RENAMED requirements as needed.\n\
                         3. Each requirement MUST use SHALL/MUST/SHOULD/MAY and each scenario MUST use WHEN/THEN.\n\
                         4. Do NOT edit other domains or implementation files.\n\n\
                         Return a concise summary of what you added/modified/removed.",
                        domain = domain,
                        name = name,
                        proposal = proposal
                    );
                    let runner = Arc::clone(&runner);
                    join_set.spawn(async move {
                        let result = runner.run_agent(prompt, max_turns).await;
                        (domain, result)
                    });
                }

                let mut summaries = Vec::new();
                while let Some(res) = join_set.join_next().await {
                    match res {
                        Ok((domain, Ok(output))) => {
                            summaries.push(format!("## Domain: {}\n\n{}", domain, output));
                        }
                        Ok((domain, Err(e))) => {
                            summaries.push(format!(
                                "## Domain: {}\n\nError: review subagent failed: {}",
                                domain, e
                            ));
                        }
                        Err(e) => {
                            summaries.push(format!(
                                "## Domain: (unknown)\n\nError: task panicked: {}",
                                e
                            ));
                        }
                    }
                }

                ToolOutput::text(summaries.join("\n\n"))
            },
        )?;

        Ok(ToolOutput::text(format!(
            "Started background parallel spec draft task {id}. It will run independently and the result will be incorporated automatically when it completes."
        )))
    }
}

#[async_trait]
impl Tool for SpecConfigTool {
    fn name(&self) -> String {
        "SpecConfig".to_string()
    }

    fn description(&self) -> String {
        "Read or update `.kcoder/specs/config.yaml` by action=get/set. Set regenerates the using-specs skill and reloads the registry; get is read-only, but this consolidated tool is serialized because set mutates files."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecConfigInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecConfigInput = parse_input(&input)?;
        match input.action {
            SpecConfigAction::Get => {
                ConfigGetStage
                    .call(serde_json::json!({"key": input.key}), ctx)
                    .await
            }
            SpecConfigAction::Set => {
                let key = input.key.ok_or_else(|| {
                    ToolError::InvalidInput("key is required for set".to_string())
                })?;
                let value = input.value.ok_or_else(|| {
                    ToolError::InvalidInput("value is required for set".to_string())
                })?;
                ConfigSetStage
                    .call(serde_json::json!({"key": key, "value": value}), ctx)
                    .await
            }
        }
    }
}

#[async_trait]
impl Tool for ConfigGetStage {
    fn name(&self) -> String {
        "SpecConfig".to_string()
    }

    fn description(&self) -> String {
        "Read a value from .kcoder/specs/config.yaml. \
         Supports keys: schema, context, precheck, rules.<artifact>. \
         Omit key to read the whole file."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ConfigGetStageInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ConfigGetStageInput = parse_input(&input)?;
        let specs_dir = ctx.state.cwd().join(".kcoder").join("specs");

        match kcoder_specs::config::config_get(&specs_dir, input.key.as_deref()) {
            Ok(value) => Ok(ToolOutput::text(value)),
            Err(e) => Err(ToolError::Execution(format!("failed to get config: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for ConfigSetStage {
    fn name(&self) -> String {
        "SpecConfig".to_string()
    }

    fn description(&self) -> String {
        "Set a value in .kcoder/specs/config.yaml. \
         Supports keys: schema, context, precheck, rules.<artifact>. \
         For rules.<artifact>, provide a YAML list of strings."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(ConfigSetStageInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ConfigSetStageInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;
        let specs_dir = ctx.state.cwd().join(".kcoder").join("specs");

        match kcoder_specs::config::config_set(&specs_dir, &input.key, &input.value) {
            Ok(()) => {
                let worker_cwd = ctx.state.cwd();
                let (skill_path, receipt) = tokio::task::spawn_blocking(move || {
                    kcoder_specs::sync_using_specs_skill_report(&worker_cwd)
                })
                .await
                .map_err(|error| {
                    ToolError::Execution(format!("using-specs worker failed: {error}"))
                })?
                .map_err(|e| {
                    ToolError::Execution(format!("failed to sync using-specs skill: {}", e))
                })?;
                let root = project_skills_root(&ctx.state.cwd());
                match reload_skill_registry(ctx) {
                    Ok(_) => {
                        record_spec_reload_status(&root, Some(&receipt.transaction_id), true);
                        Ok(ToolOutput::text(format!(
                            "Set {} in .kcoder/specs/config.yaml and regenerated {}",
                            input.key,
                            skill_path.display()
                        )))
                    }
                    Err(error) => {
                        record_spec_reload_status(&root, Some(&receipt.transaction_id), false);
                        Ok(ToolOutput::text(format!(
                            "Set {} and committed {}; committed_reload_pending ({error}); only retry registry reload",
                            input.key,
                            skill_path.display()
                        )))
                    }
                }
            }
            Err(e) => Err(ToolError::Execution(format!("failed to set config: {}", e))),
        }
    }
}

#[async_trait]
impl Tool for SpecSyncTool {
    fn name(&self) -> String {
        "SpecSync".to_string()
    }

    fn description(&self) -> String {
        "Rebase a spec-driven change against the current authoritative specs. \
         Fast-forwards unchanged deltas and inserts conflict markers when both \
         the live spec and the change edited the same requirement."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SpecSyncInput))
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecSyncInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }

        match kcoder_specs::sync(&ctx.state.cwd(), &input.name) {
            Ok(report) => {
                let mut text = String::new();
                if report.base_updated {
                    text.push_str("Base snapshot updated.\n");
                } else {
                    text.push_str("Base snapshot NOT updated due to unresolved conflicts.\n");
                }
                if !report.fast_forwards.is_empty() {
                    text.push_str("\nFast-forwarded:\n");
                    for r in &report.fast_forwards {
                        let _ = writeln!(text, "- specs/{}: {}", r.domain, r.name);
                    }
                }
                if !report.conflicts.is_empty() {
                    text.push_str("\nConflicts (resolve manually and re-run sync):\n");
                    for r in &report.conflicts {
                        let _ = writeln!(text, "- specs/{}: {}", r.domain, r.name);
                    }
                }
                if report.fast_forwards.is_empty() && report.conflicts.is_empty() {
                    text.push_str("No drift detected.");
                }
                Ok(ToolOutput::text(text))
            }
            Err(e) => Err(ToolError::Execution(format!(
                "failed to sync change: {}",
                e
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use std::sync::{Arc, RwLock};

    fn spec_ctx(cwd: &std::path::Path, active: Vec<&str>) -> ToolContext {
        spec_ctx_with_options(cwd, active, false, None)
    }

    fn spec_ctx_with_options(
        cwd: &std::path::Path,
        active: Vec<&str>,
        auto_lessons_learned: bool,
        registry: Option<Arc<RwLock<kcoder_skills::SkillRegistry>>>,
    ) -> ToolContext {
        let mut ctx = ToolContext::new(AppState::new(cwd)).with_active_skills(Arc::new(
            RwLock::new(active.into_iter().map(str::to_string).collect()),
        ));
        if let Some(registry) = registry {
            ctx = ctx.with_skill_registry(registry);
        }
        ctx.with_auto_lessons_learned(auto_lessons_learned)
    }

    fn complete_change_tasks(cwd: &std::path::Path, name: &str) {
        fs::write(
            cwd.join(".kcoder/specs/changes")
                .join(name)
                .join("tasks.md"),
            "- [x] done\n- [x] cargo test\n",
        )
        .unwrap();
    }

    fn text_output(output: &ToolOutput) -> String {
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

    #[test]
    fn spec_subagent_schemas_bound_max_turns() {
        for schema in [
            ReviewDispatchStage.input_schema(),
            SpecParallelDraftTool.input_schema(),
        ] {
            let max_turns = schema.get("properties").unwrap().get("max_turns").unwrap();
            assert_eq!(max_turns.get("minimum").unwrap(), MIN_AGENT_MAX_TURNS);
            assert_eq!(max_turns.get("maximum").unwrap(), MAX_AGENT_MAX_TURNS);
        }
    }

    #[tokio::test]
    async fn spec_init_reloads_runtime_registry_and_activates_using_specs() {
        let tmp = tempfile::tempdir().unwrap();
        let registry = Arc::new(RwLock::new(
            kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
        ));
        let active = Arc::new(RwLock::new(Vec::new()));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(Arc::clone(&registry))
            .with_active_skills(Arc::clone(&active));
        let tool = SpecInitTool;

        tool.call(serde_json::json!({}), &ctx)
            .await
            .expect("spec init should reload runtime skills");

        assert!(registry.read().unwrap().get_active("using-specs").is_some());
        assert!(
            registry
                .read()
                .unwrap()
                .get_active("using-superpowers")
                .is_some()
        );
        assert!(
            active
                .read()
                .unwrap()
                .iter()
                .any(|skill| skill == "using-specs")
        );
        assert!(
            active
                .read()
                .unwrap()
                .iter()
                .any(|skill| skill == "using-superpowers")
        );
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let bundled = provenance.skills.get("using-superpowers").unwrap();
        assert_eq!(
            bundled.origin,
            crate::skill_provenance::SkillOrigin::Bundled
        );
        assert!(bundled.bundled_hash.is_some());
        assert_eq!(
            provenance.skills.get("using-specs").unwrap().origin,
            crate::skill_provenance::SkillOrigin::Bundled
        );
        let manifest_path = tmp.path().join(".kcoder/skills/.bundled_manifest");
        assert!(
            manifest_path.is_file(),
            "SpecInit should initialize the bundled skill sync manifest"
        );
        let manifest: crate::bundled_skills::BundledManifest =
            serde_json::from_str(&std::fs::read_to_string(manifest_path).unwrap()).unwrap();
        assert_eq!(manifest.version, 1);
        let using_superpowers = manifest.skills.get("using-superpowers").unwrap();
        assert_eq!(
            using_superpowers.source,
            "crates/kcoder_specs/src/skills/using-superpowers/SKILL.md"
        );
        assert!(manifest.skills.contains_key("brainstorming"));
        assert!(
            !tmp.path()
                .join(".kcoder/skills/using-superpowers/references/codex-tools.md")
                .exists(),
            "SpecInit should not restore removed external tool mappings"
        );
    }

    #[tokio::test]
    async fn spec_init_force_update_preserves_project_config() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        kcoder_specs::config::config_set(
            &specs_dir,
            "context",
            "Preserve this tool-level context.",
        )
        .unwrap();
        let active = Arc::new(RwLock::new(Vec::new()));
        let registry = Arc::new(RwLock::new(
            kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(Arc::clone(&registry))
            .with_active_skills(active);

        SpecInitTool
            .call(serde_json::json!({"force_update": true}), &ctx)
            .await
            .expect("forced SpecInit should refresh skills without resetting config");

        let config = kcoder_specs::config::read_or_default(&specs_dir).unwrap();
        assert_eq!(config.schema, "spec-driven-superpowers");
        assert_eq!(
            config.context.as_deref(),
            Some("Preserve this tool-level context.")
        );
        let using_specs = registry
            .read()
            .unwrap()
            .get_active("using-specs")
            .unwrap()
            .content
            .clone();
        assert!(using_specs.contains("spec-driven-superpowers"));
        assert!(using_specs.contains("Preserve this tool-level context."));
    }

    #[tokio::test]
    async fn spec_init_rejects_malformed_config_before_activating_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        fs::create_dir_all(&specs_dir).unwrap();
        fs::write(
            specs_dir.join(kcoder_specs::config::CONFIG_FILE),
            "schema: [unterminated\n",
        )
        .unwrap();
        let active = Arc::new(RwLock::new(Vec::new()));
        let ctx =
            ToolContext::new(AppState::new(tmp.path())).with_active_skills(Arc::clone(&active));

        let error = SpecInitTool
            .call(serde_json::json!({}), &ctx)
            .await
            .expect_err("malformed config should fail SpecInit");

        assert!(error.to_string().contains("failed to parse"));
        assert!(active.read().unwrap().is_empty());
    }

    #[tokio::test]
    async fn spec_init_preserves_user_created_provenance_for_existing_local_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(".kcoder").join("skills");
        let local_superpowers = r#"---
name: using-superpowers
description: Local root protocol
user_invocable: false
paths:
  - ".kcoder/specs/**"
---

# Local Using Superpowers
"#;
        let local_using_specs = r#"---
name: using-specs
description: Local spec protocol
user_invocable: false
paths:
  - ".kcoder/specs/**"
---

# Local Using Specs
"#;
        fs::create_dir_all(root.join("using-superpowers")).unwrap();
        fs::write(
            root.join("using-superpowers").join("SKILL.md"),
            local_superpowers,
        )
        .unwrap();
        fs::create_dir_all(root.join("using-specs")).unwrap();
        fs::write(root.join("using-specs").join("SKILL.md"), local_using_specs).unwrap();
        crate::skill_provenance::record_user_created(tmp.path(), "using-superpowers");
        crate::skill_provenance::record_user_created(tmp.path(), "using-specs");

        let registry = Arc::new(RwLock::new(
            kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(registry)
            .with_active_skills(Arc::new(RwLock::new(Vec::new())));
        let tool = SpecInitTool;

        tool.call(serde_json::json!({}), &ctx)
            .await
            .expect("spec init should preserve existing local skills by default");

        assert_eq!(
            fs::read_to_string(root.join("using-superpowers").join("SKILL.md")).unwrap(),
            local_superpowers
        );
        assert_eq!(
            fs::read_to_string(root.join("using-specs").join("SKILL.md")).unwrap(),
            local_using_specs
        );
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        for name in ["using-superpowers", "using-specs"] {
            let record = provenance.skills.get(name).unwrap();
            assert_eq!(
                record.origin,
                crate::skill_provenance::SkillOrigin::UserCreated
            );
            assert!(record.bundled_hash.is_none());
        }
        assert!(
            root.join("using-superpowers")
                .join("SKILL.md.new")
                .is_file(),
            "conflicting bundled Superpowers updates should be staged separately"
        );
    }

    #[tokio::test]
    async fn spec_update_regenerates_using_specs_from_config_and_reloads_registry() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(
            &specs_dir,
            "context",
            "Project uses a Rust workspace with spec-first changes.",
        )
        .unwrap();
        let using_specs_file = tmp
            .path()
            .join(kcoder_specs::SPEC_SKILL_DIR)
            .join("SKILL.md");
        fs::write(
            &using_specs_file,
            "---\nname: using-specs\ndescription: stale\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Stale",
        )
        .unwrap();
        let registry = Arc::new(RwLock::new(
            kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
        ));
        let active = Arc::new(RwLock::new(Vec::new()));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(Arc::clone(&registry))
            .with_active_skills(Arc::clone(&active));
        let tool = SpecUpdateTool;

        let output = tool
            .call(serde_json::json!({}), &ctx)
            .await
            .expect("spec update should refresh workflow skills");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["dry_run"], false);
        assert!(
            output["actions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|action| action.as_str().unwrap().starts_with("update: using-specs"))
        );
        let content = fs::read_to_string(&using_specs_file).unwrap();
        assert!(content.contains("Project uses a Rust workspace"));
        assert!(content.contains("SpecStatus"));
        assert!(
            registry
                .read()
                .unwrap()
                .get_active("using-specs")
                .unwrap()
                .content
                .contains("Project uses a Rust workspace")
        );
        assert!(
            active
                .read()
                .unwrap()
                .iter()
                .any(|skill| skill == "using-specs")
        );
        assert!(
            active
                .read()
                .unwrap()
                .iter()
                .any(|skill| skill == "using-superpowers")
        );
    }

    #[tokio::test]
    async fn spec_update_dry_run_reports_without_writing_using_specs() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(&specs_dir, "context", "Dry run context").unwrap();
        let using_specs_file = tmp
            .path()
            .join(kcoder_specs::SPEC_SKILL_DIR)
            .join("SKILL.md");
        fs::write(
            &using_specs_file,
            "---\nname: using-specs\ndescription: stale\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Stale",
        )
        .unwrap();
        let before = fs::read_to_string(&using_specs_file).unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecUpdateTool;

        let output = tool
            .call(serde_json::json!({"dry_run": true}), &ctx)
            .await
            .expect("dry-run spec update should report planned changes");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["dry_run"], true);
        assert!(
            output["actions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|action| action.as_str().unwrap().starts_with("update: using-specs"))
        );
        assert_eq!(fs::read_to_string(&using_specs_file).unwrap(), before);
    }

    #[tokio::test]
    async fn spec_update_does_not_restore_removed_codex_tool_mapping() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let asset = tmp
            .path()
            .join(".kcoder/skills/using-superpowers/references/codex-tools.md");
        assert!(!asset.exists());
        let ctx = spec_ctx(tmp.path(), vec![]);

        let output = SpecUpdateTool
            .call(serde_json::json!({}), &ctx)
            .await
            .expect("SpecUpdate should preserve the current bundled skill inventory");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert!(!asset.exists());
        assert!(
            output["bundled"]["actions"]
                .as_array()
                .unwrap()
                .iter()
                .all(|action| !action.as_str().unwrap().contains("codex-tools.md"))
        );
    }

    #[tokio::test]
    async fn spec_update_preserves_non_bundled_using_specs_by_default() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(&specs_dir, "context", "Conflict context").unwrap();
        let using_specs_file = tmp
            .path()
            .join(kcoder_specs::SPEC_SKILL_DIR)
            .join("SKILL.md");
        let local_content = "---\nname: using-specs\ndescription: local\nuser_invocable: false\npaths:\n  - \".kcoder/specs/**\"\n---\n\n# Local";
        fs::write(&using_specs_file, local_content).unwrap();
        crate::skill_provenance::record_user_created(tmp.path(), "using-specs");
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecUpdateTool;

        let output = tool
            .call(serde_json::json!({}), &ctx)
            .await
            .expect("spec update should stage conflicted using-specs updates");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert!(output["actions"].as_array().unwrap().iter().any(|action| {
            action
                .as_str()
                .unwrap()
                .starts_with("conflict: using-specs")
        }));
        assert_eq!(
            fs::read_to_string(&using_specs_file).unwrap(),
            local_content
        );
        let staged = using_specs_file.with_file_name("SKILL.md.new");
        assert!(
            fs::read_to_string(staged)
                .unwrap()
                .contains("Conflict context")
        );
    }

    #[tokio::test]
    async fn spec_new_change_requires_using_specs_skill() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecNewChangeTool;

        let err = tool
            .call(serde_json::json!({"name": "guarded-change"}), &ctx)
            .await
            .expect_err("spec mutation should require using-specs and using-superpowers");

        assert!(err.to_string().contains("using-specs"));
        assert!(err.to_string().contains("using-superpowers"));
    }

    #[tokio::test]
    async fn spec_new_change_requires_superpowers_root_skill() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let ctx = spec_ctx(tmp.path(), vec!["using-specs"]);
        let tool = SpecNewChangeTool;

        let err = tool
            .call(serde_json::json!({"name": "guarded-change"}), &ctx)
            .await
            .expect_err("spec mutation should require using-superpowers root protocol");

        assert!(err.to_string().contains("using-superpowers"));
    }

    #[tokio::test]
    async fn spec_new_change_runs_when_superpowers_and_using_specs_are_active() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let ctx = spec_ctx(tmp.path(), vec!["using-superpowers", "using-specs"]);
        let tool = SpecNewChangeTool;

        tool.call(serde_json::json!({"name": "guarded-change"}), &ctx)
            .await
            .expect("active using-superpowers and using-specs should allow spec mutation");

        assert!(
            tmp.path()
                .join(".kcoder/specs/changes/guarded-change/proposal.md")
                .exists()
        );
    }

    #[tokio::test]
    async fn spec_status_tool_reports_change_summary() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        complete_change_tasks(tmp.path(), "add-auth");
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecStatusTool;

        let output = tool
            .call(serde_json::json!({"name": "add-auth"}), &ctx)
            .await
            .expect("status should report an existing change");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["change"], "add-auth");
        assert_eq!(output["title"], "Add auth");
        assert_eq!(output["tasks"]["complete"], true);
        assert_eq!(output["drift"]["ok"], true);
        assert_eq!(output["artifacts"]["proposal.md"]["exists"], true);
        assert_eq!(output["artifacts"]["tasks.md"]["complete"], true);
        assert_eq!(output["ready_to_apply"], true);
    }

    #[tokio::test]
    async fn spec_status_tool_reports_superpowers_apply_blockers() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        complete_change_tasks(tmp.path(), "add-auth");
        fs::write(
            change_dir.join("review.md"),
            "# Review\n\n## Readiness Decision\n\nblocked\n\n## Blocked By\n\napproval missing\n",
        )
        .unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecStatusTool;

        let output = tool
            .call(serde_json::json!({"name": "add-auth"}), &ctx)
            .await
            .expect("status should report blockers");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["schema"], "spec-driven-superpowers");
        assert_eq!(output["ready_to_apply"], false);
        assert!(
            output["apply"]["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|blocker| blocker.as_str().unwrap().contains("Readiness Decision"))
        );
    }

    #[tokio::test]
    async fn spec_apply_preflight_tool_reports_plan_coverage() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        fs::write(
            change_dir.join("tasks.md"),
            "# Tasks\n\n- [ ] 1.1 Implement behavior\n- [ ] 1.2 Add tests\n",
        )
        .unwrap();
        fs::write(
            change_dir.join("plan.md"),
            "# Plan\n\n## Covers\n\n- 1.1\n\n## Validation Per Step\n\n1. Run focused tests.\n",
        )
        .unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecPreflightOperation;

        let output = tool
            .call(serde_json::json!({"name": "add-auth"}), &ctx)
            .await
            .expect("preflight should report coverage");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["change_name"], "add-auth");
        assert_eq!(output["ok"], false);
        assert_eq!(output["task_coverage"]["uncovered_task_ids"][0], "1.2");
    }

    #[tokio::test]
    async fn spec_record_verification_tool_writes_evidence_file() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = SpecRecordVerificationTool;

        let output = tool
            .call(
                serde_json::json!({
                    "name": "add-auth",
                    "completion_decision": "complete",
                    "commands_run": ["cargo test -p kcoder_tools: passed"],
                    "manual_checks": ["reviewed status output"],
                    "evidence": ["target/debug/deps/kcoder_tools-*"],
                    "residual_risks": ["none"]
                }),
                &ctx,
            )
            .await
            .expect("verification evidence should be written");

        assert!(text_output(&output).contains("Recorded verification evidence"));
        let verification = fs::read_to_string(
            tmp.path()
                .join(".kcoder/specs/changes/add-auth/verification.md"),
        )
        .unwrap();
        assert!(verification.contains("## Completion Decision"));
        assert!(verification.contains("cargo test -p kcoder_tools: passed"));
    }

    #[tokio::test]
    async fn spec_review_writeback_tool_updates_review_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let specs_dir = tmp.path().join(kcoder_specs::SPECS_DIR);
        kcoder_specs::config::config_set(&specs_dir, "schema", "spec-driven-superpowers").unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = ReviewWritebackStage;

        let output = tool
            .call(
                serde_json::json!({
                    "name": "add-auth",
                    "review_status": "findings-received",
                    "findings_summary": ["accepted: add auth regression coverage"],
                    "accepted_followups": ["Add auth regression coverage"],
                    "verification_notes": ["Retain auth regression evidence"]
                }),
                &ctx,
            )
            .await
            .expect("review writeback should update artifacts");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["change_name"], "add-auth");
        assert_eq!(output["tasks_updated"], true);
        let review = fs::read_to_string(change_dir.join("review.md")).unwrap();
        assert!(review.contains("findings-received"));
        let tasks = fs::read_to_string(change_dir.join("tasks.md")).unwrap();
        assert!(tasks.contains("Add auth regression coverage"));
        let plan = fs::read_to_string(change_dir.join("plan.md")).unwrap();
        assert!(plan.contains("Add auth regression coverage"));
        let verification = fs::read_to_string(change_dir.join("verification.md")).unwrap();
        assert!(verification.contains("Retain auth regression evidence"));
    }

    #[tokio::test]
    async fn spec_show_tool_returns_status_and_change_files() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        fs::write(
            change_dir.join("proposal.md"),
            "# Add auth\n\nImplement token refresh.\n",
        )
        .unwrap();
        let spec_dir = change_dir.join("specs").join("auth");
        fs::create_dir_all(&spec_dir).unwrap();
        fs::write(
            spec_dir.join("spec.md"),
            "## ADDED Requirements\n\n### Requirement: Token refresh\n",
        )
        .unwrap();
        let ctx = spec_ctx(tmp.path(), vec![]);
        let tool = StatusDeepRead;

        let output = tool
            .call(
                serde_json::json!({"name": "add-auth", "max_file_bytes": 16}),
                &ctx,
            )
            .await
            .expect("show should serialize an existing change");

        let output: Value = serde_json::from_str(&text_output(&output)).unwrap();
        assert_eq!(output["name"], "add-auth");
        assert_eq!(output["status"]["name"], "add-auth");
        let files = output["files"].as_array().unwrap();
        assert!(files.iter().any(|file| file["path"] == "proposal.md"));
        assert!(
            files
                .iter()
                .any(|file| file["path"] == "specs/auth/spec.md")
        );
        let proposal = files
            .iter()
            .find(|file| file["path"] == "proposal.md")
            .unwrap();
        assert_eq!(proposal["truncated"], true);
        assert!(proposal["content"].as_str().unwrap().len() <= 16);
    }

    #[tokio::test]
    async fn spec_archive_generates_lessons_skill_when_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        let change_dir =
            kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        fs::write(
            change_dir.join("proposal.md"),
            "# Add auth\n\n- Risk: stale sessions need rollback testing.\n",
        )
        .unwrap();
        fs::write(
            change_dir.join("design.md"),
            "## Verification\n\n- Run cargo test -p kcoder_tools.\n",
        )
        .unwrap();
        complete_change_tasks(tmp.path(), "add-auth");

        let registry = Arc::new(RwLock::new(
            kcoder_skills::SkillRegistry::load(tmp.path()).unwrap(),
        ));
        let ctx = spec_ctx_with_options(
            tmp.path(),
            vec!["using-superpowers", "using-specs"],
            true,
            Some(Arc::clone(&registry)),
        );
        let tool = SpecArchiveTool;

        let output = tool
            .call(serde_json::json!({"name": "add-auth"}), &ctx)
            .await
            .expect("archive should generate lessons skill");

        let output = text_output(&output);
        assert!(output.contains("generated lessons-learned skill"));

        let skill_name = "lessons-learned-add-auth";
        let skill_file = tmp
            .path()
            .join(".kcoder")
            .join("skills")
            .join(skill_name)
            .join("SKILL.md");
        let skill = fs::read_to_string(&skill_file).unwrap();
        assert!(skill.contains("name: lessons-learned-add-auth"));
        assert!(skill.contains("From archived change `add-auth`"));
        assert!(skill.contains("Risk: stale sessions need rollback testing."));
        assert!(skill.contains("Run cargo test -p kcoder_tools."));

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        assert_eq!(
            provenance.skills.get(skill_name).unwrap().origin,
            crate::skill_provenance::SkillOrigin::AgentCreated
        );

        let usage: crate::skill_telemetry::SkillTelemetryStore = serde_json::from_str(
            &fs::read_to_string(tmp.path().join(".kcoder/skills/.usage.json")).unwrap(),
        )
        .unwrap();
        assert!(usage.skills.contains_key(skill_name));
        assert!(registry.read().unwrap().get_active(skill_name).is_some());
    }

    #[tokio::test]
    async fn spec_archive_skips_lessons_skill_by_default() {
        let tmp = tempfile::tempdir().unwrap();
        kcoder_specs::init(tmp.path()).unwrap();
        kcoder_specs::new_change(tmp.path(), "add-auth", Some("Add auth".into())).unwrap();
        complete_change_tasks(tmp.path(), "add-auth");
        let ctx = spec_ctx(tmp.path(), vec!["using-superpowers", "using-specs"]);
        let tool = SpecArchiveTool;

        let output = tool
            .call(serde_json::json!({"name": "add-auth"}), &ctx)
            .await
            .expect("archive should succeed without lessons generation");

        let output = text_output(&output);
        assert!(!output.contains("generated lessons-learned skill"));
        assert!(
            !tmp.path()
                .join(".kcoder/skills/lessons-learned-add-auth/SKILL.md")
                .exists()
        );
    }
}
