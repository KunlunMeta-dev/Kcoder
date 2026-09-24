use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use chrono::Utc;
use kcoder_skills::{
    ExpectedSkillRevision, SkillCommitReceipt, SkillCommitRequest, SkillMetadataDelta,
    SkillMetadataPatch, SkillMetadataPrecondition, SkillMetadataPredicate, SkillMetadataStore,
    SkillMutation, SkillMutationActor, SkillOperationKind, SkillPackage, SkillPackageFile,
    SkillRevision, SkillStore, SkillStoreCommitStatus, SkillStoreError,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;
use walkdir::WalkDir;

const MAX_SKILL_NAME_CHARS: usize = 64;
const MAX_SKILL_CONTENT_CHARS: usize = 100_000;
const MAX_SUPPORTING_FILE_BYTES: usize = 1_048_576;
const SUPPORTING_DIRS: &[&str] = &["references", "templates", "scripts", "assets"];

/// Manage project skills under `.kcoder/skills/`.
#[derive(Debug, Default)]
pub struct SkillManageTool;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillManageAction {
    List,
    View,
    Create,
    Edit,
    Patch,
    WriteFile,
    RemoveFile,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SkillManageInput {
    /// Action to perform.
    pub action: SkillManageAction,
    /// Skill name. Required except for `list`.
    #[serde(default)]
    pub name: Option<String>,
    /// Full SKILL.md content. Required for `create` and `edit`.
    #[serde(default)]
    pub content: Option<String>,
    /// Supporting file path under references/, templates/, scripts/, or assets/.
    /// For `patch`, omit this or use SKILL.md to patch the main skill file.
    #[serde(default)]
    pub file_path: Option<String>,
    /// Full supporting file content. Required for `write_file`.
    #[serde(default)]
    pub file_content: Option<String>,
    /// Text to find. Required for `patch`.
    #[serde(default)]
    pub old_string: Option<String>,
    /// Replacement text. Required for `patch`; use an empty string to delete.
    #[serde(default)]
    pub new_string: Option<String>,
    /// Replace all matches for `patch`; otherwise replace exactly one match.
    #[serde(default)]
    pub replace_all: bool,
    /// Revision returned by `view`. Required for race-safe updates; omission is
    /// temporarily accepted for one compatibility release and emits a warning.
    #[serde(default)]
    pub expected_revision: Option<String>,
}

#[derive(Debug, Serialize)]
struct SkillManageResult {
    success: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    skill: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skills: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transaction_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

struct MutationCommit {
    receipt: SkillCommitReceipt,
    runtime_status: &'static str,
    reload_warning: Option<String>,
    compatibility_warning: Option<String>,
}

#[async_trait]
impl Tool for SkillManageTool {
    fn name(&self) -> String {
        "skill_manage".to_string()
    }

    fn description(&self) -> String {
        "Manage KCoder skills as procedural memory — the authoring layer: create and edit skills under the project's \
         `.kcoder/skills/<name>/` directory. Use `list` and `view` before updating. \
         Prefer `patch` for small corrections, `edit` for full SKILL.md rewrites, \
         `create` for durable reusable procedures, and `write_file` for supporting \
         references/templates/scripts/assets. Do not save one-off details; save \
         recurring workflow knowledge, pitfalls, verification steps, and user-corrected \
         procedures. This is for writing skills: activation, community installation, and lifecycle housekeeping require separate attached controls."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        clean_schema(schemars::schema_for!(SkillManageInput))
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SkillManageInput = parse_input(&input)?;
        let action = input.action;
        let root = project_skills_root(&ctx.state.cwd());
        let result = match action {
            SkillManageAction::List => list_skills(ctx),
            SkillManageAction::View => {
                let name = required_name(input.name)?;
                validate_skill_name(&name)?;
                view_skill(ctx, &root, &name)
            }
            SkillManageAction::Create => {
                let name = required_name(input.name)?;
                validate_skill_name(&name)?;
                let content = input.content.ok_or_else(|| {
                    ToolError::InvalidInput("content is required for create".to_string())
                })?;
                create_skill(ctx, &root, &name, &content).await
            }
            SkillManageAction::Edit => {
                let name = required_name(input.name)?;
                validate_skill_name(&name)?;
                let content = input.content.ok_or_else(|| {
                    ToolError::InvalidInput("content is required for edit".to_string())
                })?;
                edit_skill(
                    ctx,
                    &root,
                    &name,
                    &content,
                    input.expected_revision.as_deref(),
                )
                .await
            }
            SkillManageAction::Patch => {
                let name = required_name(input.name)?;
                validate_skill_name(&name)?;
                let old = input.old_string.ok_or_else(|| {
                    ToolError::InvalidInput("old_string is required for patch".to_string())
                })?;
                let new = input.new_string.ok_or_else(|| {
                    ToolError::InvalidInput("new_string is required for patch".to_string())
                })?;
                patch_skill(
                    ctx,
                    &root,
                    &name,
                    input.file_path.as_deref(),
                    &old,
                    &new,
                    input.replace_all,
                    input.expected_revision.as_deref(),
                )
                .await
            }
            SkillManageAction::WriteFile => {
                let name = required_name(input.name)?;
                validate_skill_name(&name)?;
                let file_path = input.file_path.ok_or_else(|| {
                    ToolError::InvalidInput("file_path is required for write_file".to_string())
                })?;
                let content = input.file_content.ok_or_else(|| {
                    ToolError::InvalidInput("file_content is required for write_file".to_string())
                })?;
                write_supporting_file(
                    ctx,
                    &root,
                    &name,
                    &file_path,
                    &content,
                    input.expected_revision.as_deref(),
                )
                .await
            }
            SkillManageAction::RemoveFile => {
                let name = required_name(input.name)?;
                validate_skill_name(&name)?;
                let file_path = input.file_path.ok_or_else(|| {
                    ToolError::InvalidInput("file_path is required for remove_file".to_string())
                })?;
                remove_supporting_file(
                    ctx,
                    &root,
                    &name,
                    &file_path,
                    input.expected_revision.as_deref(),
                )
                .await
            }
        }?;

        serde_json::to_string(&result)
            .map(ToolOutput::text)
            .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))
    }
}

fn required_name(name: Option<String>) -> Result<String, ToolError> {
    let name = name.unwrap_or_default();
    if name.trim().is_empty() {
        return Err(ToolError::InvalidInput(
            "name is required for this action".to_string(),
        ));
    }
    Ok(name)
}

fn validate_skill_name(name: &str) -> Result<(), ToolError> {
    if name.chars().count() > MAX_SKILL_NAME_CHARS {
        return Err(ToolError::InvalidInput(format!(
            "skill name is too long; max {MAX_SKILL_NAME_CHARS} characters"
        )));
    }
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return Err(ToolError::InvalidInput(
            "skill name cannot be empty".to_string(),
        ));
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err(ToolError::InvalidInput(
            "skill name must start with a lowercase ASCII letter or digit".to_string(),
        ));
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    {
        return Err(ToolError::InvalidInput(
            "skill name may contain only lowercase ASCII letters, digits, '.', '_', and '-'"
                .to_string(),
        ));
    }
    Ok(())
}

fn project_skills_root(cwd: &Path) -> PathBuf {
    crate::skill_provenance::project_skills_root(cwd)
}

fn list_skills(ctx: &ToolContext) -> Result<SkillManageResult, ToolError> {
    let registry = ctx
        .skill_registry
        .as_ref()
        .ok_or_else(|| ToolError::Execution("skill registry is not available".to_string()))?;
    let registry = registry.read().unwrap();
    let mut skills: Vec<Value> = registry
        .iter_all()
        .map(|skill| {
            let revision = skill
                .source
                .parent()
                .and_then(|dir| kcoder_skills::skill_revision(dir).ok().flatten())
                .map(|revision| revision.0);
            serde_json::json!({
                "name": skill.name,
                "description": skill.description,
                "user_invocable": skill.user_invocable,
                "source": skill.source.display().to_string(),
                "revision_sha256": revision,
            })
        })
        .collect();
    skills.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(SkillManageResult {
        success: true,
        message: format!("Found {} skill(s).", skills.len()),
        skill: None,
        skills: Some(skills),
        path: None,
        revision: None,
        transaction_id: None,
        status: None,
        runtime_status: None,
        warning: None,
    })
}

fn view_skill(ctx: &ToolContext, root: &Path, name: &str) -> Result<SkillManageResult, ToolError> {
    let skill_md = registry_skill_md(ctx, name)
        .ok()
        .or_else(|| project_skill_md(root, name))
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
    let dir = skill_md.parent().ok_or_else(|| {
        ToolError::Execution(format!(
            "failed to resolve skill directory for {}",
            skill_md.display()
        ))
    })?;
    if !skill_md.is_file() {
        return Err(ToolError::InvalidInput(format!("skill '{name}' not found")));
    }
    let (content, support_files, revision) = if crate::sandbox::path_starts_with(dir, root)
        && dir.parent() == Some(root)
    {
        let package = SkillStore::open(root)
            .map_err(skill_store_error)?
            .read_package(name)
            .map_err(skill_store_error)?
            .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
        let revision = kcoder_skills::canonical_package_revision(&package)
            .map_err(skill_store_error)?
            .0;
        let content = package
            .files
            .iter()
            .find(|file| file.relative_path == Path::new("SKILL.md"))
            .and_then(|file| std::str::from_utf8(&file.content).ok())
            .ok_or_else(|| ToolError::Execution("SKILL.md is not valid UTF-8".to_string()))?
            .to_string();
        let mut support_files = package
            .files
            .iter()
            .filter(|file| file.relative_path != Path::new("SKILL.md"))
            .map(|file| {
                file.relative_path
                    .components()
                    .filter_map(|component| component.as_os_str().to_str())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .collect::<Vec<_>>();
        support_files.sort();
        (content, support_files, Some(revision))
    } else {
        (
            std::fs::read_to_string(&skill_md)
                .map_err(|e| ToolError::Execution(format!("failed to read {:?}: {e}", skill_md)))?,
            list_support_files(dir)?,
            kcoder_skills::skill_revision(dir)
                .map_err(skill_store_error)?
                .map(|revision| revision.0),
        )
    };
    if ctx.record_project_skill_telemetry {
        crate::skill_telemetry::record_skill_view_for_source(&ctx.state.cwd(), name, &skill_md);
    }
    Ok(SkillManageResult {
        success: true,
        message: format!("Skill '{name}' loaded."),
        skill: Some(serde_json::json!({
            "name": name,
            "content": content,
            "support_files": support_files,
            "revision_sha256": revision,
        })),
        skills: None,
        path: Some(skill_md.display().to_string()),
        revision,
        transaction_id: None,
        status: None,
        runtime_status: None,
        warning: None,
    })
}

async fn create_skill(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    content: &str,
) -> Result<SkillManageResult, ToolError> {
    validate_skill_content(content)?;
    let dir = skill_dir(root, name);
    let skill_md = dir.join("SKILL.md");
    if skill_md.exists() {
        return Err(ToolError::InvalidInput(format!(
            "skill '{name}' already exists; use patch or edit"
        )));
    }
    ensure_writable_project_skill_target(ctx, root, name, "create")?;
    if let Some(estimate) = crate::skill_telemetry::most_redundant_skill_for_content(
        root, name, content,
    )
    .map_err(|e| ToolError::Execution(format!("failed to estimate skill redundancy: {e}")))?
        && estimate.score >= crate::skill_telemetry::HIGH_REDUNDANCY_THRESHOLD
    {
        return Err(ToolError::InvalidInput(format!(
            "new skill '{name}' is highly redundant with existing skill '{}' (score {:.3}); use view plus patch/edit on the existing skill instead of creating a duplicate",
            estimate.name, estimate.score
        )));
    }
    let actor = mutation_actor(ctx);
    let request = SkillCommitRequest {
        operation_id: mutation_operation_id(ctx, "create", name),
        actor: actor.clone(),
        operation: SkillOperationKind::Create,
        preconditions: Vec::new(),
        mutations: vec![SkillMutation::PutPackage {
            package: SkillPackage {
                name: name.to_string(),
                files: vec![SkillPackageFile {
                    relative_path: PathBuf::from("SKILL.md"),
                    content: content.as_bytes().to_vec(),
                    executable: false,
                }],
            },
            expected: ExpectedSkillRevision::Absent,
        }],
        metadata: mutation_metadata(ctx, root, name, &actor, true),
    };
    let committed = commit_and_reload(ctx, root, request, None).await?;
    Ok(committed_result(name, &skill_md, "created", committed))
}

async fn edit_skill(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<SkillManageResult, ToolError> {
    ensure_skill_not_pinned(&ctx.state.cwd(), name, "editing")?;
    validate_skill_content(content)?;
    ensure_writable_project_skill_target(ctx, root, name, "edit")?;
    let skill_md = existing_skill_md(root, name)?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let package = store
        .read_package(name)
        .map_err(skill_store_error)?
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
    let (expected, warning) = expected_revision_or_current(&store, name, expected_revision)?;
    let mut files = package.files;
    let skill_file = files
        .iter_mut()
        .find(|file| file.relative_path == Path::new("SKILL.md"))
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' has no SKILL.md")))?;
    skill_file.content = content.as_bytes().to_vec();
    skill_file.executable = false;
    let actor = mutation_actor(ctx);
    let request = SkillCommitRequest {
        operation_id: mutation_operation_id(ctx, "edit", name),
        actor: actor.clone(),
        operation: SkillOperationKind::Edit,
        preconditions: skill_write_preconditions(name, false),
        mutations: vec![SkillMutation::PutPackage {
            package: SkillPackage {
                name: name.to_string(),
                files,
            },
            expected,
        }],
        metadata: mutation_metadata(ctx, root, name, &actor, false),
    };
    let committed = commit_and_reload(ctx, root, request, warning).await?;
    Ok(committed_result(name, &skill_md, "updated", committed))
}

#[allow(clippy::too_many_arguments)]
async fn patch_skill(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    file_path: Option<&str>,
    old: &str,
    new: &str,
    replace_all: bool,
    expected_revision: Option<&str>,
) -> Result<SkillManageResult, ToolError> {
    if old.is_empty() {
        return Err(ToolError::InvalidInput(
            "old_string cannot be empty".to_string(),
        ));
    }
    ensure_writable_project_skill_target(ctx, root, name, "patch")?;
    let dir = skill_dir(root, name);
    if !dir.join("SKILL.md").is_file() {
        return Err(ToolError::InvalidInput(format!("skill '{name}' not found")));
    }
    ensure_skill_not_pinned(&ctx.state.cwd(), name, "patching")?;
    let target = resolve_patch_target(&dir, file_path)?;
    let relative = target.strip_prefix(&dir).map_err(|_| {
        ToolError::InvalidInput("patch target escaped the skill directory".to_string())
    })?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let (expected, warning) = expected_revision_or_current(&store, name, expected_revision)?;
    let actor = mutation_actor(ctx);
    let request = SkillCommitRequest {
        operation_id: mutation_operation_id(ctx, "patch", name),
        actor: actor.clone(),
        operation: SkillOperationKind::Patch,
        preconditions: skill_write_preconditions(name, false),
        mutations: vec![SkillMutation::PatchText {
            name: name.to_string(),
            expected,
            relative_path: relative.to_path_buf(),
            old_string: old.to_string(),
            new_string: new.to_string(),
            replace_all,
        }],
        metadata: mutation_metadata(ctx, root, name, &actor, false),
    };
    let committed = commit_and_reload(ctx, root, request, warning).await?;
    Ok(committed_result(name, &target, "patched", committed))
}

async fn write_supporting_file(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    file_path: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<SkillManageResult, ToolError> {
    if content.len() > MAX_SUPPORTING_FILE_BYTES {
        return Err(ToolError::InvalidInput(format!(
            "supporting file exceeds {MAX_SUPPORTING_FILE_BYTES} bytes"
        )));
    }
    ensure_writable_project_skill_target(ctx, root, name, "write_file")?;
    let dir = skill_dir(root, name);
    if !dir.join("SKILL.md").is_file() {
        return Err(ToolError::InvalidInput(format!("skill '{name}' not found")));
    }
    ensure_skill_not_pinned(&ctx.state.cwd(), name, "writing supporting files")?;
    let target = resolve_supporting_path(&dir, file_path)?;
    let relative = target.strip_prefix(&dir).map_err(|_| {
        ToolError::InvalidInput("supporting file escaped the skill directory".to_string())
    })?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let mut package = store
        .read_package(name)
        .map_err(skill_store_error)?
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
    let (expected, warning) = expected_revision_or_current(&store, name, expected_revision)?;
    if let Some(file) = package
        .files
        .iter_mut()
        .find(|file| file.relative_path == relative)
    {
        file.content = content.as_bytes().to_vec();
        file.executable = false;
    } else {
        package.files.push(SkillPackageFile {
            relative_path: relative.to_path_buf(),
            content: content.as_bytes().to_vec(),
            executable: false,
        });
    }
    let actor = mutation_actor(ctx);
    let request = SkillCommitRequest {
        operation_id: mutation_operation_id(ctx, "write-file", name),
        actor: actor.clone(),
        operation: SkillOperationKind::WriteFile,
        preconditions: skill_write_preconditions(name, false),
        mutations: vec![SkillMutation::PutPackage { package, expected }],
        metadata: mutation_metadata(ctx, root, name, &actor, false),
    };
    let committed = commit_and_reload(ctx, root, request, warning).await?;
    Ok(committed_result(name, &target, "updated", committed))
}

async fn remove_supporting_file(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    file_path: &str,
    expected_revision: Option<&str>,
) -> Result<SkillManageResult, ToolError> {
    ensure_writable_project_skill_target(ctx, root, name, "remove_file")?;
    let dir = skill_dir(root, name);
    if !dir.join("SKILL.md").is_file() {
        return Err(ToolError::InvalidInput(format!("skill '{name}' not found")));
    }
    ensure_supporting_file_removal_allowed(&ctx.state.cwd(), name)?;
    let target = resolve_supporting_path(&dir, file_path)?;
    if !target.is_file() {
        return Err(ToolError::InvalidInput(format!(
            "supporting file '{}' not found",
            file_path
        )));
    }
    let relative = target.strip_prefix(&dir).map_err(|_| {
        ToolError::InvalidInput("supporting file escaped the skill directory".to_string())
    })?;
    let store = SkillStore::open(root).map_err(skill_store_error)?;
    let (expected, warning) = expected_revision_or_current(&store, name, expected_revision)?;
    let expected = match expected {
        ExpectedSkillRevision::Exact(revision) => revision,
        _ => unreachable!("existing skill revisions are exact"),
    };
    let actor = mutation_actor(ctx);
    let request = SkillCommitRequest {
        operation_id: mutation_operation_id(ctx, "remove-file", name),
        actor: actor.clone(),
        operation: SkillOperationKind::RemoveFile,
        preconditions: skill_write_preconditions(name, true),
        mutations: vec![SkillMutation::RemoveFile {
            name: name.to_string(),
            expected,
            relative_path: relative.to_path_buf(),
        }],
        metadata: mutation_metadata(ctx, root, name, &actor, false),
    };
    let committed = commit_and_reload(ctx, root, request, warning).await?;
    Ok(committed_result(name, &target, "updated", committed))
}

fn ensure_supporting_file_removal_allowed(cwd: &Path, name: &str) -> Result<(), ToolError> {
    ensure_skill_not_pinned(cwd, name, "removing supporting files")?;

    if crate::skill_provenance::load_project_provenance(cwd)
        .ok()
        .and_then(|provenance| provenance.skills.get(name).cloned())
        .is_some_and(|record| record.origin == crate::skill_provenance::SkillOrigin::Bundled)
    {
        return Err(ToolError::InvalidInput(format!(
            "skill '{name}' is bundled; skill_manage remove_file cannot delete bundled skill files"
        )));
    }

    Ok(())
}

fn ensure_skill_not_pinned(cwd: &Path, name: &str, action: &str) -> Result<(), ToolError> {
    if crate::skill_telemetry::load_project_usage(cwd)
        .ok()
        .and_then(|usage| usage.skills.get(name).cloned())
        .is_some_and(|usage| usage.pinned)
    {
        return Err(ToolError::InvalidInput(format!(
            "skill '{name}' is pinned; unpin it before {action}"
        )));
    }

    Ok(())
}

fn skill_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn existing_skill_md(root: &Path, name: &str) -> Result<PathBuf, ToolError> {
    project_skill_md(root, name)
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))
}

fn ensure_writable_project_skill_target(
    ctx: &ToolContext,
    root: &Path,
    name: &str,
    action: &str,
) -> Result<(), ToolError> {
    if project_skill_md(root, name).is_some() {
        return Ok(());
    }
    let Some(source) = registry_skill_md_opt(ctx, name)? else {
        return Ok(());
    };
    if crate::sandbox::path_starts_with(&source, root) {
        return Ok(());
    }
    Err(ToolError::InvalidInput(format!(
        "skill '{name}' is read-only because it is loaded from {}; skill_manage {action} only modifies project skills under {}",
        source.display(),
        root.display()
    )))
}

fn project_skill_md(root: &Path, name: &str) -> Option<PathBuf> {
    let skill_md = skill_dir(root, name).join("SKILL.md");
    skill_md.is_file().then_some(skill_md)
}

fn registry_skill_md(ctx: &ToolContext, name: &str) -> Result<PathBuf, ToolError> {
    registry_skill_md_opt(ctx, name)?
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))
}

fn registry_skill_md_opt(ctx: &ToolContext, name: &str) -> Result<Option<PathBuf>, ToolError> {
    let Some(registry) = ctx.skill_registry.as_ref() else {
        return Ok(None);
    };
    let registry = registry.read().unwrap();
    Ok(registry.get_active(name).map(|skill| skill.source.clone()))
}

fn resolve_patch_target(dir: &Path, file_path: Option<&str>) -> Result<PathBuf, ToolError> {
    match file_path.map(str::trim).filter(|p| !p.is_empty()) {
        None | Some("SKILL.md") => Ok(dir.join("SKILL.md")),
        Some(path) => resolve_supporting_path(dir, path),
    }
}

fn resolve_supporting_path(dir: &Path, file_path: &str) -> Result<PathBuf, ToolError> {
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
    let Some(first) = components.first().and_then(|s| s.to_str()) else {
        return Err(ToolError::InvalidInput(
            "file_path cannot be empty".to_string(),
        ));
    };
    if !SUPPORTING_DIRS.contains(&first) {
        return Err(ToolError::InvalidInput(format!(
            "file_path must start with one of: {}",
            SUPPORTING_DIRS.join(", ")
        )));
    }
    Ok(components
        .into_iter()
        .fold(dir.to_path_buf(), |acc, part| acc.join(part)))
}

fn list_support_files(dir: &Path) -> Result<Vec<String>, ToolError> {
    let mut files = Vec::new();
    for child in SUPPORTING_DIRS {
        let child_dir = dir.join(child);
        if !child_dir.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&child_dir).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            if let Ok(relative) = entry.path().strip_prefix(dir) {
                files.push(
                    relative
                        .components()
                        .filter_map(|component| match component {
                            std::path::Component::Normal(value) => value.to_str(),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
            if files.len() >= 100 {
                break;
            }
        }
    }
    files.sort();
    Ok(files)
}

fn validate_skill_content(content: &str) -> Result<(), ToolError> {
    if content.chars().count() > MAX_SKILL_CONTENT_CHARS {
        return Err(ToolError::InvalidInput(format!(
            "SKILL.md exceeds {MAX_SKILL_CONTENT_CHARS} characters"
        )));
    }
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Err(ToolError::InvalidInput(
            "SKILL.md must start with YAML frontmatter".to_string(),
        ));
    }
    let after_first = &trimmed[3..];
    let Some(end) = after_first.find("\n---") else {
        return Err(ToolError::InvalidInput(
            "SKILL.md frontmatter is not closed".to_string(),
        ));
    };
    let frontmatter = &after_first[..end];
    let body = &after_first[end + 4..];
    if !frontmatter
        .lines()
        .any(|line| line.trim_start().starts_with("name:"))
    {
        return Err(ToolError::InvalidInput(
            "SKILL.md frontmatter must include name".to_string(),
        ));
    }
    if !frontmatter
        .lines()
        .any(|line| line.trim_start().starts_with("description:"))
    {
        return Err(ToolError::InvalidInput(
            "SKILL.md frontmatter must include description".to_string(),
        ));
    }
    if body.trim().is_empty() {
        return Err(ToolError::InvalidInput(
            "SKILL.md must include instructions after frontmatter".to_string(),
        ));
    }
    Ok(())
}

async fn commit_and_reload(
    ctx: &ToolContext,
    root: &Path,
    request: SkillCommitRequest,
    compatibility_warning: Option<String>,
) -> Result<MutationCommit, ToolError> {
    let root = root.to_path_buf();
    let mut reload_context = ctx.clone();
    // Mutation metadata committed in the same transaction. Reload refreshes only
    // the in-memory snapshot and must not rerun the old post-hoc provenance/usage write path.
    reload_context.record_project_skill_telemetry = false;
    tokio::task::spawn_blocking(move || {
        let store = SkillStore::open(&root).map_err(skill_store_error)?;
        let receipt = store.commit(request).map_err(skill_store_error)?;
        let (runtime_status, mut reload_warning) = match reload_context.reload_skill_registry() {
            Ok(_) => ("registry_reloaded", None),
            Err(error) => (
                "committed_reload_pending",
                Some(format!(
                    "disk transaction committed; registry reload failed, so retry only the reload: {error}"
                )),
            ),
        };
        if let Err(error) = store.record_reload_status(
            &receipt.transaction_id,
            runtime_status == "registry_reloaded",
        ) {
            let marker = format!("failed to persist registry reload state: {error}");
            reload_warning = Some(
                reload_warning
                    .map(|warning| format!("{warning}; {marker}"))
                    .unwrap_or(marker),
            );
        }
        Ok(MutationCommit {
            receipt,
            runtime_status,
            reload_warning,
            compatibility_warning,
        })
    })
    .await
    .map_err(|error| ToolError::Execution(format!("skill transaction worker failed: {error}")))?
}

fn committed_result(
    name: &str,
    path: &Path,
    verb: &str,
    committed: MutationCommit,
) -> SkillManageResult {
    let revision = committed
        .receipt
        .after
        .iter()
        .find(|item| item.name == name)
        .and_then(|item| item.revision.as_ref())
        .map(|revision| revision.0.clone());
    let status = match committed.receipt.status {
        SkillStoreCommitStatus::Committed => "committed",
        SkillStoreCommitStatus::NoChange => "no_change",
    };
    let warning = [committed.compatibility_warning, committed.reload_warning]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("; ");
    SkillManageResult {
        success: true,
        message: format!("Skill '{name}' {verb}."),
        skill: None,
        skills: None,
        path: Some(path.display().to_string()),
        revision,
        transaction_id: Some(committed.receipt.transaction_id),
        status: Some(status.to_string()),
        runtime_status: Some(committed.runtime_status.to_string()),
        warning: (!warning.is_empty()).then_some(warning),
    }
}

fn expected_revision_or_current(
    store: &SkillStore,
    name: &str,
    expected_revision: Option<&str>,
) -> Result<(ExpectedSkillRevision, Option<String>), ToolError> {
    if let Some(revision) = expected_revision {
        return Ok((
            ExpectedSkillRevision::Exact(parse_revision(revision)?),
            None,
        ));
    }
    let current = store
        .current_revision(name)
        .map_err(skill_store_error)?
        .ok_or_else(|| ToolError::InvalidInput(format!("skill '{name}' not found")))?;
    Ok((
        ExpectedSkillRevision::Exact(current),
        Some(
            "expected_revision was omitted; this compatibility behavior will be removed in a future release. Call view first and return revision_sha256"
                .to_string(),
        ),
    ))
}

fn parse_revision(value: &str) -> Result<SkillRevision, ToolError> {
    let hash = value.strip_prefix("sha256:").ok_or_else(|| {
        ToolError::InvalidInput("expected_revision must use sha256:<64 hex> form".to_string())
    })?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ToolError::InvalidInput(
            "expected_revision must use sha256:<64 hex> form".to_string(),
        ));
    }
    Ok(SkillRevision(format!(
        "sha256:{}",
        hash.to_ascii_lowercase()
    )))
}

fn mutation_actor(ctx: &ToolContext) -> SkillMutationActor {
    match ctx.skill_mutation_actor.clone() {
        Some(SkillMutationActor::BackgroundReview {
            session_id,
            job_id,
            agent_id,
            ..
        }) => SkillMutationActor::BackgroundReview {
            session_id,
            job_id,
            agent_id,
            tool_call_id: ctx
                .tool_call_id
                .clone()
                .unwrap_or_else(|| format!("local-{}", Uuid::new_v4())),
        },
        Some(actor) => actor,
        None => SkillMutationActor::ForegroundAgent {
            session_id: ctx.state.session_id(),
            tool_call_id: ctx
                .tool_call_id
                .clone()
                .unwrap_or_else(|| format!("local-{}", Uuid::new_v4())),
        },
    }
}

fn mutation_operation_id(ctx: &ToolContext, action: &str, name: &str) -> String {
    let identity = ctx
        .tool_call_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    format!("skill-manage:{action}:{name}:{identity}")
        .chars()
        .take(256)
        .collect()
}

fn mutation_metadata(
    ctx: &ToolContext,
    project_root: &Path,
    name: &str,
    actor: &SkillMutationActor,
    create: bool,
) -> SkillMetadataDelta {
    let now = Utc::now().to_rfc3339();
    let agent_owned = matches!(
        actor,
        SkillMutationActor::BackgroundReview { .. } | SkillMutationActor::AutoCurator { .. }
    );
    let mut provenance = SkillMetadataPatch::default();
    provenance.create.insert(
        "origin".to_string(),
        Value::String(if agent_owned {
            "agent_created".to_string()
        } else {
            "user_created".to_string()
        }),
    );
    provenance.create.insert(
        "created_by".to_string(),
        Value::String(if agent_owned { "agent" } else { "user" }.to_string()),
    );
    provenance
        .create
        .insert("created_at".to_string(), Value::String(now.clone()));
    provenance.update.insert(
        "write_origin".to_string(),
        Value::String(if agent_owned {
            "background_skill_review".to_string()
        } else {
            "skill_manage".to_string()
        }),
    );

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
    usage.increment.insert("patch_count".to_string(), 1);
    usage
        .update
        .insert("last_patched_at".to_string(), Value::String(now.clone()));
    if create {
        usage
            .create
            .insert("view_count".to_string(), Value::from(0));
        usage.create.insert("use_count".to_string(), Value::from(0));
    }

    let mut delta = SkillMetadataDelta {
        provenance: BTreeMap::from([(name.to_string(), provenance)]),
        usage: BTreeMap::from([(name.to_string(), usage)]),
        ..Default::default()
    };
    if ctx.record_project_skill_telemetry
        && let Some(registry) = &ctx.skill_registry
    {
        let registry = registry.read().unwrap();
        for skill in registry.iter_all() {
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
            delta.usage.entry(skill.name.clone()).or_insert(usage);

            if !crate::sandbox::path_starts_with(&skill.source, project_root)
                && let Some(external_dir) = ctx
                    .external_skill_dirs
                    .iter()
                    .find(|dir| crate::sandbox::path_starts_with(&skill.source, dir))
            {
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
                    Value::String(external_dir.display().to_string()),
                );
                delta.provenance.insert(skill.name.clone(), provenance);
            }
        }
    }
    delta
}

fn skill_write_preconditions(name: &str, reject_bundled: bool) -> Vec<SkillMetadataPrecondition> {
    let mut conditions = vec![SkillMetadataPrecondition {
        store: SkillMetadataStore::Usage,
        skill: name.to_string(),
        field: "pinned".to_string(),
        predicate: SkillMetadataPredicate::MissingOrEquals,
        value: Value::Bool(false),
    }];
    if reject_bundled {
        conditions.push(SkillMetadataPrecondition {
            store: SkillMetadataStore::Provenance,
            skill: name.to_string(),
            field: "origin".to_string(),
            predicate: SkillMetadataPredicate::NotEquals,
            value: Value::String("bundled".to_string()),
        });
    }
    conditions
}

fn skill_store_error(error: SkillStoreError) -> ToolError {
    match error {
        SkillStoreError::Conflict {
            name,
            expected,
            actual,
        } => ToolError::InvalidInput(format!(
            "status=conflict; skill={name}; expected_revision={expected}; actual_revision={actual}; next_action=view the current Skill again before deciding whether to modify it"
        )),
        SkillStoreError::PolicyRejected(message) => {
            ToolError::InvalidInput(format!("status=policy_rejected; {message}"))
        }
        SkillStoreError::Busy { root, timeout_ms } => ToolError::Execution(format!(
            "status=busy; root={}; timeout_ms={timeout_ms}; retry with backoff",
            root.display()
        )),
        SkillStoreError::RecoveryRequired {
            transaction_id,
            reason,
        } => ToolError::Execution(format!(
            "status=recovery_required; transaction_id={transaction_id}; {reason}"
        )),
        other => ToolError::Execution(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_skills::SkillRegistry;
    use kcoder_state::AppState;
    use std::sync::{Arc, RwLock};
    use tempfile::TempDir;

    fn skill_md(name: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: Demo skill\n---\n\n# Demo\n\nUse this after repeatable work."
        )
    }

    fn context(tmp: &TempDir) -> (ToolContext, Arc<RwLock<SkillRegistry>>) {
        let state = AppState::new(tmp.path());
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        (
            ToolContext::new(state).with_skill_registry(Arc::clone(&registry)),
            registry,
        )
    }

    fn output_json(output: &ToolOutput) -> Value {
        let text = output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn creates_skill_and_refreshes_registry() {
        let tmp = TempDir::new().unwrap();
        let (ctx, registry) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "repeatable-demo",
                    "content": "---\nname: repeatable-demo\ndescription: Repeatable demo\n---\n\n# Repeatable Demo\n\nUse this for a separate review workflow after release notes are prepared."
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/skills/repeatable-demo/SKILL.md")
                .is_file()
        );
        assert!(registry.read().unwrap().get("repeatable-demo").is_some());

        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("repeatable-demo").unwrap();
        assert_eq!(usage.patch_count, 1);
        assert!(usage.last_patched_at.is_some());
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("repeatable-demo").unwrap();
        assert_eq!(
            provenance.origin,
            crate::skill_provenance::SkillOrigin::UserCreated
        );
        assert_eq!(provenance.created_by.as_deref(), Some("user"));
        assert_eq!(provenance.write_origin.as_deref(), Some("skill_manage"));
    }

    #[tokio::test]
    async fn view_returns_revision_and_stale_edit_conflicts_without_overwrite() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);
        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        let view = SkillManageTool
            .call(serde_json::json!({"action": "view", "name": "demo"}), &ctx)
            .await
            .unwrap();
        let revision = output_json(&view)["skill"]["revision_sha256"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(revision.starts_with("sha256:"));

        let external =
            "---\nname: demo\ndescription: External edit\n---\n\n# Demo\n\nExternal content.";
        let path = tmp.path().join(".kcoder/skills/demo/SKILL.md");
        std::fs::write(&path, external).unwrap();
        let error = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "edit",
                    "name": "demo",
                    "content": "---\nname: demo\ndescription: Stale edit\n---\n\n# Demo\n\nStale.",
                    "expected_revision": revision,
                }),
                &ctx,
            )
            .await
            .expect_err("stale revision must conflict");
        assert!(error.to_string().contains("status=conflict"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), external);
    }

    #[tokio::test]
    async fn supporting_file_write_and_remove_advance_revision() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);
        let created = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        let created_revision = output_json(&created)["revision"]
            .as_str()
            .unwrap()
            .to_string();
        let written = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "write_file",
                    "name": "demo",
                    "file_path": "references/check.md",
                    "file_content": "# Check\n",
                    "expected_revision": created_revision.clone(),
                }),
                &ctx,
            )
            .await
            .unwrap();
        let written_revision = output_json(&written)["revision"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(created_revision, written_revision);
        let removed = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "remove_file",
                    "name": "demo",
                    "file_path": "references/check.md",
                    "expected_revision": written_revision.clone(),
                }),
                &ctx,
            )
            .await
            .unwrap();
        let removed_revision = output_json(&removed)["revision"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(written_revision, removed_revision);
        assert!(
            !tmp.path()
                .join(".kcoder/skills/demo/references/check.md")
                .exists()
        );
    }

    #[tokio::test]
    async fn view_records_skill_telemetry() {
        let tmp = TempDir::new().unwrap();
        let skill_dir = tmp.path().join(".kcoder").join("skills").join("demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), skill_md("demo")).unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "view",
                    "name": "demo"
                }),
                &ctx,
            )
            .await
            .expect("view should load a project skill");

        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("demo").unwrap();
        assert_eq!(usage.view_count, 1);
        assert!(usage.last_viewed_at.is_some());
        assert_eq!(usage.use_count, 0);
    }

    #[tokio::test]
    async fn create_rejects_highly_redundant_skill_content() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _registry) = context(&tmp);
        let shared_body = "# Review Workflow\n\n1. Run cargo test.\n2. Run cargo fmt.\n3. Verify output.\n4. Review failure logs.\n5. Avoid duplicate setup.\n";

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "review-workflow",
                    "content": format!("---\nname: review-workflow\ndescription: Review\n---\n\n{shared_body}")
                }),
                &ctx,
            )
            .await
            .unwrap();

        let err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "review-copy",
                    "content": format!("---\nname: review-copy\ndescription: Review Copy\n---\n\n{shared_body}")
                }),
                &ctx,
            )
            .await
            .expect_err("high-redundancy skill creation should be rejected");

        assert!(err.to_string().contains("highly redundant"));
        assert!(err.to_string().contains("review-workflow"));
        assert!(
            !tmp.path()
                .join(".kcoder/skills/review-copy/SKILL.md")
                .exists()
        );
    }

    #[tokio::test]
    async fn refresh_preserves_external_skill_dirs() {
        let tmp = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        let project_demo = tmp.path().join(".kcoder").join("skills").join("demo");
        let external_demo = external.path().join("demo");
        std::fs::create_dir_all(&project_demo).unwrap();
        std::fs::create_dir_all(&external_demo).unwrap();
        std::fs::write(project_demo.join("SKILL.md"), skill_md("demo")).unwrap();
        std::fs::write(
            external_demo.join("SKILL.md"),
            "---\nname: demo\ndescription: External override\n---\n\n# Demo\n\nExternal.",
        )
        .unwrap();

        let registry = Arc::new(RwLock::new(
            SkillRegistry::load_with_external_dirs(tmp.path(), [external.path()]).unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(Arc::clone(&registry))
            .with_external_skill_dirs(vec![external.path().to_path_buf()]);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "repeatable-demo",
                    "content": "---\nname: repeatable-demo\ndescription: Repeatable demo\n---\n\n# Release Review\n\nUse this after release notes are prepared and deployment approvals are collected."
                }),
                &ctx,
            )
            .await
            .unwrap();

        let registry = registry.read().unwrap();
        assert_eq!(
            registry.get("demo").unwrap().description,
            "External override"
        );
        assert!(registry.get("repeatable-demo").is_some());
        drop(registry);

        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let record = provenance.skills.get("demo").unwrap();
        assert_eq!(
            record.origin,
            crate::skill_provenance::SkillOrigin::ExternalDir
        );
        assert_eq!(
            record.installed_from.as_deref(),
            Some(external.path().to_str().unwrap())
        );
    }

    #[tokio::test]
    async fn view_reads_external_directory_skill_but_patch_stays_project_only() {
        let tmp = TempDir::new().unwrap();
        let external = TempDir::new().unwrap();
        let external_demo = external.path().join("team-demo");
        std::fs::create_dir_all(external_demo.join("references")).unwrap();
        let external_content = "---\nname: team-demo\ndescription: Team demo\n---\n\n# Team Demo\n\nExternal instructions.";
        std::fs::write(external_demo.join("SKILL.md"), external_content).unwrap();
        std::fs::write(
            external_demo.join("references/checklist.md"),
            "# Checklist\n\n- Read first.\n",
        )
        .unwrap();

        let registry = Arc::new(RwLock::new(
            SkillRegistry::load_with_external_dirs(tmp.path(), [external.path()]).unwrap(),
        ));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(registry)
            .with_external_skill_dirs(vec![external.path().to_path_buf()]);

        let output = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "view",
                    "name": "team-demo"
                }),
                &ctx,
            )
            .await
            .expect("external directory skills should be viewable");
        let output = output_json(&output);

        assert_eq!(output["skill"]["name"], "team-demo");
        assert!(
            output["skill"]["content"]
                .as_str()
                .unwrap()
                .contains("External instructions")
        );
        assert!(
            output["skill"]["support_files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|path| path == "references/checklist.md")
        );
        assert!(
            output["path"]
                .as_str()
                .unwrap()
                .starts_with(&external_demo.display().to_string())
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("team-demo").unwrap();
        assert_eq!(usage.view_count, 1);
        assert!(usage.last_viewed_at.is_some());

        let err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "patch",
                    "name": "team-demo",
                    "old_string": "External instructions.",
                    "new_string": "Project override."
                }),
                &ctx,
            )
            .await
            .expect_err("mutating external-only skills should stay project-only");

        assert!(err.to_string().contains("read-only"));
        assert!(err.to_string().contains("only modifies project skills"));
        assert_eq!(
            std::fs::read_to_string(external_demo.join("SKILL.md")).unwrap(),
            external_content
        );

        let err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "team-demo",
                    "content": "---\nname: team-demo\ndescription: Project shadow\n---\n\n# Team Demo\n\nProject shadow."
                }),
                &ctx,
            )
            .await
            .expect_err("creating a project shadow for an external skill should be explicit");

        assert!(err.to_string().contains("read-only"));
        assert!(
            !tmp.path()
                .join(".kcoder/skills/team-demo/SKILL.md")
                .exists(),
            "skill_manage create should not shadow an external directory skill"
        );
        assert_eq!(
            std::fs::read_to_string(external_demo.join("SKILL.md")).unwrap(),
            external_content
        );
    }

    #[tokio::test]
    async fn rejects_supporting_file_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();

        let err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "write_file",
                    "name": "demo",
                    "file_path": "../bad.md",
                    "file_content": "bad"
                }),
                &ctx,
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("file_path"));
    }

    #[tokio::test]
    async fn patches_skill_md() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "patch",
                    "name": "demo",
                    "old_string": "Use this after repeatable work.",
                    "new_string": "Use this after repeatable work. Verify with tests."
                }),
                &ctx,
            )
            .await
            .unwrap();

        let content =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/demo/SKILL.md")).unwrap();
        assert!(content.contains("Verify with tests."));

        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("demo").unwrap();
        assert_eq!(usage.patch_count, 2);
        assert!(usage.last_patched_at.is_some());
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("demo").unwrap();
        assert_eq!(
            provenance.origin,
            crate::skill_provenance::SkillOrigin::UserCreated
        );
        assert_eq!(provenance.created_by.as_deref(), Some("user"));
        assert_eq!(provenance.write_origin.as_deref(), Some("skill_manage"));
    }

    #[tokio::test]
    async fn edit_records_patch_usage_and_preserves_agent_provenance() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "edit",
                    "name": "demo",
                    "content": "---\nname: demo\ndescription: Demo skill edited\n---\n\n# Demo\n\nUse this after repeatable work. Verify with tests."
                }),
                &ctx,
            )
            .await
            .unwrap();

        let content =
            std::fs::read_to_string(tmp.path().join(".kcoder/skills/demo/SKILL.md")).unwrap();
        assert!(content.contains("Demo skill edited"));
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("demo").unwrap();
        assert_eq!(usage.patch_count, 2);
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("demo").unwrap();
        assert_eq!(
            provenance.origin,
            crate::skill_provenance::SkillOrigin::AgentCreated
        );
        assert_eq!(provenance.created_by.as_deref(), Some("agent"));
        assert_eq!(provenance.write_origin.as_deref(), Some("skill_manage"));
    }

    #[tokio::test]
    async fn pinned_skill_rejects_edit_patch_and_write_file_without_mutation() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "demo", true).unwrap();
        let skill_path = tmp.path().join(".kcoder/skills/demo/SKILL.md");
        let original = std::fs::read_to_string(&skill_path).unwrap();

        let edit_err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "edit",
                    "name": "demo",
                    "content": "---\nname: demo\ndescription: Edited\n---\n\n# Demo\n\nEdited."
                }),
                &ctx,
            )
            .await
            .expect_err("pinned skill should reject full edits");
        assert!(edit_err.to_string().contains("pinned"));

        let patch_err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "patch",
                    "name": "demo",
                    "old_string": "Use this after repeatable work.",
                    "new_string": "Changed."
                }),
                &ctx,
            )
            .await
            .expect_err("pinned skill should reject patches");
        assert!(patch_err.to_string().contains("pinned"));

        let write_err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "write_file",
                    "name": "demo",
                    "file_path": "references/checklist.md",
                    "file_content": "# Checklist\n"
                }),
                &ctx,
            )
            .await
            .expect_err("pinned skill should reject supporting file writes");
        assert!(write_err.to_string().contains("pinned"));

        assert_eq!(std::fs::read_to_string(&skill_path).unwrap(), original);
        assert!(
            !tmp.path()
                .join(".kcoder/skills/demo/references/checklist.md")
                .exists()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(usage.skills.get("demo").unwrap().patch_count, 1);
    }

    #[tokio::test]
    async fn support_file_changes_record_usage_and_preserve_origin() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        crate::skill_provenance::record_agent_created(tmp.path(), "demo");

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "write_file",
                    "name": "demo",
                    "file_path": "references/checklist.md",
                    "file_content": "# Checklist\n\n- Run tests.\n"
                }),
                &ctx,
            )
            .await
            .unwrap();

        let support_path = tmp
            .path()
            .join(".kcoder/skills/demo/references/checklist.md");
        assert!(support_path.is_file());

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "remove_file",
                    "name": "demo",
                    "file_path": "references/checklist.md"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!support_path.exists());
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("demo").unwrap();
        assert_eq!(usage.patch_count, 3);
        assert!(usage.last_patched_at.is_some());
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("demo").unwrap();
        assert_eq!(
            provenance.origin,
            crate::skill_provenance::SkillOrigin::AgentCreated
        );
        assert_eq!(provenance.created_by.as_deref(), Some("agent"));
        assert_eq!(provenance.write_origin.as_deref(), Some("skill_manage"));
    }

    #[tokio::test]
    async fn remove_file_rejects_pinned_skill() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "write_file",
                    "name": "demo",
                    "file_path": "references/checklist.md",
                    "file_content": "# Checklist\n\n- Run tests.\n"
                }),
                &ctx,
            )
            .await
            .unwrap();
        crate::skill_telemetry::set_skill_pinned(tmp.path(), "demo", true).unwrap();

        let err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "remove_file",
                    "name": "demo",
                    "file_path": "references/checklist.md"
                }),
                &ctx,
            )
            .await
            .expect_err("pinned skill support files should not be removed");

        assert!(err.to_string().contains("pinned"));
        assert!(
            tmp.path()
                .join(".kcoder/skills/demo/references/checklist.md")
                .is_file()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(usage.skills.get("demo").unwrap().patch_count, 2);
    }

    #[tokio::test]
    async fn remove_file_rejects_bundled_skill() {
        let tmp = TempDir::new().unwrap();
        let (ctx, _) = context(&tmp);

        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "create",
                    "name": "demo",
                    "content": skill_md("demo")
                }),
                &ctx,
            )
            .await
            .unwrap();
        SkillManageTool
            .call(
                serde_json::json!({
                    "action": "write_file",
                    "name": "demo",
                    "file_path": "references/checklist.md",
                    "file_content": "# Checklist\n\n- Run tests.\n"
                }),
                &ctx,
            )
            .await
            .unwrap();
        crate::skill_provenance::record_bundled(tmp.path(), "demo", "sha256:test");

        let err = SkillManageTool
            .call(
                serde_json::json!({
                    "action": "remove_file",
                    "name": "demo",
                    "file_path": "references/checklist.md"
                }),
                &ctx,
            )
            .await
            .expect_err("bundled skill support files should not be removed");

        assert!(err.to_string().contains("bundled"));
        assert!(
            tmp.path()
                .join(".kcoder/skills/demo/references/checklist.md")
                .is_file()
        );
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        assert_eq!(usage.skills.get("demo").unwrap().patch_count, 2);
    }
}
