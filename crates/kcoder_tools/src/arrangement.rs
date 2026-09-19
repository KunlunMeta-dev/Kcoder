use crate::{Tool, ToolContext, ToolError, ToolOutput, clean_schema, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default)]
pub struct WritePlanTool;

#[derive(Debug, Default)]
pub struct WriteReportTool;

#[derive(Debug, Default)]
pub struct EditPlanTool;

#[derive(Debug, Default)]
pub struct EditReportTool;

#[derive(Debug, Default)]
pub struct AppendNotepadTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArrangementWriteInput {
    /// Short human-readable title for the artifact.
    pub title: String,
    /// Markdown content to write.
    pub content: String,
    /// Optional stable file name. The tool sanitizes it and adds .md when absent.
    #[serde(default)]
    pub file_name: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArrangementAppendInput {
    /// Notepad name. Defaults to session.md.
    #[serde(default)]
    pub name: Option<String>,
    /// Markdown content to append.
    pub content: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArrangementEditReportInput {
    /// Existing report file name under .kcoder/arrangement/reports/.
    pub file_name: String,
    /// Full replacement Markdown content. Mutually exclusive with old_string/new_string.
    #[serde(default)]
    pub content: Option<String>,
    /// Exact existing text to replace in the report. Mutually exclusive with content.
    #[serde(default)]
    pub old_string: Option<String>,
    /// Replacement text used with old_string.
    #[serde(default)]
    pub new_string: Option<String>,
    /// Replace every occurrence of old_string instead of only the first one.
    #[serde(default)]
    pub replace_all: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ArrangementEditPlanInput {
    /// Existing plan file name under .kcoder/arrangement/plans/.
    pub file_name: String,
    /// Full replacement Markdown content. Mutually exclusive with old_string/new_string.
    #[serde(default)]
    pub content: Option<String>,
    /// Exact existing text to replace in the plan. Mutually exclusive with content.
    #[serde(default)]
    pub old_string: Option<String>,
    /// Replacement text used with old_string.
    #[serde(default)]
    pub new_string: Option<String>,
    /// Replace every occurrence of old_string instead of only the first one.
    #[serde(default)]
    pub replace_all: bool,
}

fn arrangement_write_schema(section: &str, artifact_kind: &str, tool_name: &str) -> Value {
    let mut schema = clean_schema(schemars::schema_for!(ArrangementWriteInput));
    let edit_tool = if artifact_kind == "plan" {
        "EditPlan"
    } else {
        "EditReport"
    };
    set_schema_metadata(
        &mut schema,
        format!(
            "{tool_name} creates or overwrites one Markdown {artifact_kind} artifact under .kcoder/arrangement/{section}/. It cannot write source files or arbitrary paths. Write a complete but focused initial artifact; avoid one huge dump. Later corrections or additions should go through {edit_tool}."
        ),
    );
    set_property_description(
        &mut schema,
        "title",
        format!(
            "Required short human-readable title for the {artifact_kind}. The tool writes it as the Markdown H1."
        ),
    );
    set_property_description(
        &mut schema,
        "content",
        format!(
            "Required complete Markdown body for the {artifact_kind}. Keep it focused and bounded. Do not dump full source files, raw logs, huge command outputs, or broad unrelated context. Later refinements should use {edit_tool}. This is not a source-code write channel."
        ),
    );
    set_property_description(
        &mut schema,
        "file_name",
        format!(
            "Optional stable file basename for .kcoder/arrangement/{section}/. Path separators and unsafe characters are sanitized, and .md is appended when absent. The final path cannot escape the {section} artifact directory."
        ),
    );
    schema
}

fn arrangement_edit_schema(section: &str, artifact_kind: &str, tool_name: &str) -> Value {
    let mut schema = if artifact_kind == "plan" {
        clean_schema(schemars::schema_for!(ArrangementEditPlanInput))
    } else {
        clean_schema(schemars::schema_for!(ArrangementEditReportInput))
    };
    set_schema_metadata(
        &mut schema,
        format!(
            "{tool_name} edits an existing Markdown {artifact_kind} artifact under .kcoder/arrangement/{section}/. It cannot create a missing artifact, write source files, or edit arbitrary paths."
        ),
    );
    set_property_description(
        &mut schema,
        "file_name",
        format!(
            "Required existing {artifact_kind} file under .kcoder/arrangement/{section}/. The value is sanitized and .md is appended when absent. The call fails if the resolved artifact does not already exist."
        ),
    );
    set_property_description(
        &mut schema,
        "content",
        format!(
            "Optional full replacement Markdown for the entire {artifact_kind}. Mutually exclusive with old_string/new_string; do not send both modes in one call."
        ),
    );
    set_property_description(
        &mut schema,
        "old_string",
        format!(
            "Optional exact text currently present in the {artifact_kind}. Use together with new_string for a targeted replacement. It must be non-empty and match exactly."
        ),
    );
    set_property_description(
        &mut schema,
        "new_string",
        "Replacement text used with old_string. Required when old_string is supplied. Omit content in this mode.",
    );
    set_property_description(
        &mut schema,
        "replace_all",
        "Optional boolean. Defaults to false, replacing only the first exact old_string match.",
    );
    schema
}

fn arrangement_append_schema() -> Value {
    let mut schema = clean_schema(schemars::schema_for!(ArrangementAppendInput));
    set_schema_metadata(
        &mut schema,
        "AppendNotepad appends a Markdown note under .kcoder/arrangement/notepads/. It is for durable orchestration memory, not source-code writes.",
    );
    set_property_description(
        &mut schema,
        "name",
        "Optional notepad basename under .kcoder/arrangement/notepads/. Defaults to session.md. Path separators and unsafe characters are sanitized, and .md is appended when absent.",
    );
    set_property_description(
        &mut schema,
        "content",
        "Required Markdown entry to append. Capture reusable decisions, evidence, blockers, verification observations, handoff notes, or unresolved risks. Keep each entry focused.",
    );
    schema
}

fn set_schema_metadata(schema: &mut Value, description: impl Into<String>) {
    if let Value::Object(map) = schema {
        map.insert("description".to_string(), Value::String(description.into()));
        map.insert("additionalProperties".to_string(), Value::Bool(false));
    }
}

fn set_property_description(schema: &mut Value, property: &str, description: impl Into<String>) {
    let Some(Value::Object(props)) = schema.get_mut("properties") else {
        return;
    };
    let Some(Value::Object(prop_schema)) = props.get_mut(property) else {
        return;
    };
    prop_schema.insert("description".to_string(), Value::String(description.into()));
}

#[async_trait]
impl Tool for WritePlanTool {
    fn name(&self) -> String {
        "WritePlan".to_string()
    }

    fn description(&self) -> String {
        "Create or overwrite an Arrangement plan artifact under .kcoder/arrangement/plans/. In Arrangement mode this is intended for PlanAgent or plan sub-agents: the plan sub-agent should use it before its final report to persist the complete executable plan with atomic subtasks, ownership, scoped context/write boundaries, acceptance criteria, expected artifacts, out-of-scope notes, risks, and verifier checks. The initial WritePlan content should be compact and focused: cite paths and short evidence instead of dumping source files, raw logs, long transcripts, or unrelated background. Do not use it for source code, config edits, tests, shell output dumps, or arbitrary project files.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        arrangement_write_schema("plans", "plan", "WritePlan")
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ArrangementWriteInput = parse_input(&input)?;
        write_artifact(
            ctx,
            "plans",
            &input.title,
            input.file_name.as_deref(),
            &input.content,
        )
        .await
    }
}

#[async_trait]
impl Tool for WriteReportTool {
    fn name(&self) -> String {
        "WriteReport".to_string()
    }

    fn description(&self) -> String {
        "Create or overwrite an Arrangement report artifact under .kcoder/arrangement/reports/. Use this for main-orchestrator supervision records, review summaries, verification summaries, handoff reports, acceptance decisions, residual-risk reports, and final task reports. Do not use it to write implementation files or plans; use PlanAgent/WritePlan for plans and implementer sub-agents for code/config/test/script edits.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        arrangement_write_schema("reports", "report", "WriteReport")
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ArrangementWriteInput = parse_input(&input)?;
        write_artifact(
            ctx,
            "reports",
            &input.title,
            input.file_name.as_deref(),
            &input.content,
        )
        .await
    }
}

#[async_trait]
impl Tool for EditPlanTool {
    fn name(&self) -> String {
        "EditPlan".to_string()
    }

    fn description(&self) -> String {
        "Edit an existing Arrangement plan artifact under .kcoder/arrangement/plans/. Use this only after PlanAgent or a plan sub-agent has already created the plan with WritePlan and the main orchestrator needs a focused revision. This tool cannot create a plan from scratch and cannot edit source code, tests, scripts, config, or arbitrary project files.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        arrangement_edit_schema("plans", "plan", "EditPlan")
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ArrangementEditPlanInput = parse_input(&input)?;
        edit_artifact(
            ctx,
            "EditPlan",
            "plans",
            "plan",
            ArtifactEdit {
                file_name: input.file_name,
                content: input.content,
                old_string: input.old_string,
                new_string: input.new_string,
                replace_all: input.replace_all,
            },
        )
        .await
    }
}

#[async_trait]
impl Tool for EditReportTool {
    fn name(&self) -> String {
        "EditReport".to_string()
    }

    fn description(&self) -> String {
        "Edit an existing Arrangement report artifact under .kcoder/arrangement/reports/. This tool cannot create a missing report and cannot edit source code, plans, or arbitrary project files.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        arrangement_edit_schema("reports", "report", "EditReport")
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ArrangementEditReportInput = parse_input(&input)?;
        edit_artifact(
            ctx,
            "EditReport",
            "reports",
            "report",
            ArtifactEdit {
                file_name: input.file_name,
                content: input.content,
                old_string: input.old_string,
                new_string: input.new_string,
                replace_all: input.replace_all,
            },
        )
        .await
    }
}

#[async_trait]
impl Tool for AppendNotepadTool {
    fn name(&self) -> String {
        "AppendNotepad".to_string()
    }

    fn description(&self) -> String {
        "Append a Markdown entry to an Arrangement notepad under .kcoder/arrangement/notepads/. Use this for durable orchestration memory that later sub-agents may need. It appends to the selected notepad, defaulting to session.md, and never replaces existing notes. Do not use it for implementation edits, report replacement, plan creation, or arbitrary project files.".to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        arrangement_append_schema()
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: ArrangementAppendInput = parse_input(&input)?;
        let name = input.name.as_deref().unwrap_or("session");
        let path = artifact_path(ctx.state.cwd(), "notepads", name);
        write_or_append(&path, &format!("\n\n{}\n", input.content.trim()), true).await?;
        Ok(ToolOutput::text(format!(
            "Arrangement notepad updated: {}",
            path.display()
        )))
    }
}

struct ArtifactEdit {
    file_name: String,
    content: Option<String>,
    old_string: Option<String>,
    new_string: Option<String>,
    replace_all: bool,
}

async fn edit_artifact(
    ctx: &ToolContext,
    tool_name: &str,
    section: &str,
    artifact_kind: &str,
    edit: ArtifactEdit,
) -> Result<ToolOutput, ToolError> {
    let path = artifact_path(ctx.state.cwd(), section, &edit.file_name);
    let current = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| match e.kind() {
            ErrorKind::NotFound => ToolError::InvalidInput(format!(
                "{artifact_kind} does not exist under .kcoder/arrangement/{section}/: {}",
                path.display()
            )),
            _ => ToolError::Execution(format!("failed to read {artifact_kind} artifact: {e}")),
        })?;

    let has_content = edit.content.is_some();
    let has_replacement = edit.old_string.is_some() || edit.new_string.is_some();
    if has_content && has_replacement {
        return Err(ToolError::InvalidInput(format!(
            "{tool_name} accepts either content for full replacement or old_string/new_string for exact replacement, not both"
        )));
    }

    let updated = if let Some(content) = edit.content {
        format!("{}\n", content.trim())
    } else {
        let old_string = edit.old_string.ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "{tool_name} requires content or both old_string and new_string"
            ))
        })?;
        let new_string = edit.new_string.ok_or_else(|| {
            ToolError::InvalidInput(format!(
                "{tool_name} requires content or both old_string and new_string"
            ))
        })?;
        if old_string.is_empty() {
            return Err(ToolError::InvalidInput(
                "old_string must not be empty".to_string(),
            ));
        }
        if !current.contains(&old_string) {
            return Err(ToolError::InvalidInput(format!(
                "old_string was not found in the {artifact_kind}"
            )));
        }
        if edit.replace_all {
            current.replace(&old_string, &new_string)
        } else {
            current.replacen(&old_string, &new_string, 1)
        }
    };

    write_or_append(&path, &updated, false).await?;
    Ok(ToolOutput::text(format!(
        "Arrangement {artifact_kind} edited: {}",
        path.display()
    )))
}

async fn write_artifact(
    ctx: &ToolContext,
    section: &str,
    title: &str,
    file_name: Option<&str>,
    content: &str,
) -> Result<ToolOutput, ToolError> {
    let path = if let Some(file_name) = file_name {
        artifact_path(ctx.state.cwd(), section, file_name)
    } else {
        artifact_path(
            ctx.state.cwd(),
            section,
            &format!("{}-{}", now_millis(), slugify(title)),
        )
    };
    let body = format!("# {}\n\n{}\n", title.trim(), content.trim());
    write_or_append(&path, &body, false).await?;
    Ok(ToolOutput::text(format!(
        "Arrangement artifact written: {}",
        path.display()
    )))
}

fn artifact_path(cwd: impl AsRef<Path>, section: &str, name: &str) -> PathBuf {
    let trimmed = name.trim();
    let stem = if trimmed.to_ascii_lowercase().ends_with(".md") {
        &trimmed[..trimmed.len().saturating_sub(3)]
    } else {
        trimmed
    };
    let mut file_name = slugify(stem);
    if file_name.is_empty() {
        file_name = "artifact".to_string();
    }
    file_name.push_str(".md");
    cwd.as_ref()
        .join(".kcoder")
        .join("arrangement")
        .join(section)
        .join(file_name)
}

async fn write_or_append(path: &Path, content: &str, append: bool) -> Result<(), ToolError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| ToolError::Execution(format!("failed to create artifact dir: {e}")))?;
    }
    if append {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await
            .map_err(|e| ToolError::Execution(format!("failed to open artifact: {e}")))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| ToolError::Execution(format!("failed to append artifact: {e}")))?;
    } else {
        tokio::fs::write(path, content)
            .await
            .map_err(|e| ToolError::Execution(format!("failed to write artifact: {e}")))?;
    }
    Ok(())
}

fn slugify(input: &str) -> String {
    let mut slug = String::new();
    for ch in input.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch.is_whitespace() || matches!(ch, '/' | '\\' | ':' | '|'))
            && !slug.ends_with('-')
        {
            slug.push('-');
        }
    }
    slug.trim_matches('-').to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;

    #[test]
    fn slugify_removes_path_escape() {
        assert_eq!(slugify("../plans/Fix renderer.md"), "plans-fix-renderermd");
    }

    #[test]
    fn artifact_path_preserves_markdown_extension_intent() {
        let path = artifact_path("/tmp/project", "plans", "text-stats-plan.md");
        assert!(path.ends_with(".kcoder/arrangement/plans/text-stats-plan.md"));
    }

    #[test]
    fn write_plan_description_explains_compact_complete_plan_boundary() {
        let description = WritePlanTool.description();

        assert!(description.contains("complete executable plan"));
        assert!(description.contains("atomic subtasks"));
        assert!(description.contains("compact and focused"));
        assert!(description.contains("Do not use it for source code"));
    }

    #[tokio::test]
    async fn write_plan_stays_under_arrangement_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        WritePlanTool
            .call(
                serde_json::json!({
                    "title": "Plan",
                    "content": "Do work",
                    "file_name": "../escape"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(
            tmp.path()
                .join(".kcoder/arrangement/plans/escape.md")
                .exists()
        );
    }
}
