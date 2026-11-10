//! The existing SpecStatus adapter for transient, source-bound project knowledge.

use super::*;
use anyhow::Context as _;
use kcoder_specs::project_knowledge::{
    DEFAULT_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_BYTES, MAX_KNOWLEDGE_FILES, ProjectKnowledgeAccess,
};

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectKnowledgeInput {
    /// Explicit project-relative Markdown paths relevant to this task; 1..=8 sources.
    pub paths: Vec<String>,
    /// Total source bytes; default 32768, hard maximum 65536. No truncated facts are returned.
    #[serde(default = "default_knowledge_bytes")]
    pub max_total_bytes: usize,
    /// Exact scope returned by this task's source read; required for candidate updates.
    #[serde(default)]
    pub scope: Option<String>,
    /// Candidate replacements to preview. Existing documents are never modified.
    #[serde(default)]
    pub updates: Vec<ProjectKnowledgeUpdateInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectKnowledgeUpdateInput {
    pub path: String,
    /// SHA-256 revision returned by a previous source read in this task/scope.
    pub expected_revision: String,
    pub replacement: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectKnowledgeChangeBaseInput {
    pub scope: String,
    pub sources: Vec<ProjectKnowledgeSourceGuardInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectKnowledgeSourceGuardInput {
    pub path: String,
    pub revision: String,
}

pub(super) fn new_change(
    ctx: &ToolContext,
    name: &str,
    title: Option<String>,
    base: ProjectKnowledgeChangeBaseInput,
) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        !base.sources.is_empty() && base.sources.len() <= MAX_KNOWLEDGE_FILES,
        "project_knowledge_source_guards: provide 1..=8 source revisions"
    );
    check_paths(ctx, base.sources.iter().map(|source| source.path.as_str()))
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let access = access(ctx).map_err(|error| anyhow::anyhow!("{error}"))?;
    access.new_change(
        name,
        title,
        &kcoder_specs::project_knowledge::ProjectKnowledgeChangeBase {
            scope: base.scope,
            sources: base
                .sources
                .into_iter()
                .map(
                    |source| kcoder_specs::project_knowledge::ProjectKnowledgeSourceGuard {
                        path: source.path,
                        revision: source.revision,
                    },
                )
                .collect(),
        },
    )
}

fn check_paths<'a>(
    ctx: &ToolContext,
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<(), ToolError> {
    if let Some(sandbox) = &ctx.sandbox {
        for path in paths {
            sandbox
                .check_path(&ctx.state.cwd().join(path), false)
                .map_err(ToolError::Execution)?;
        }
    }
    Ok(())
}

fn default_knowledge_bytes() -> usize {
    DEFAULT_KNOWLEDGE_BYTES
}

fn access(ctx: &ToolContext) -> Result<ProjectKnowledgeAccess, ToolError> {
    let profile = ctx.settings_persistence_path.as_deref().and_then(Path::parent)
        .ok_or_else(|| ToolError::Execution("project_knowledge_missing_profile: the target host must bind its settings profile; no ambient account profile is inferred".into()))?;
    let principal = std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID")
        .map(Some)
        .or_else(|error| {
            if matches!(error, std::env::VarError::NotPresent) {
                Ok(None)
            } else {
                Err(error)
            }
        })
        .map_err(|_| ToolError::Execution("project_knowledge_invalid_account_identity".into()))?;
    ProjectKnowledgeAccess::open(
        &ctx.state.cwd(),
        profile,
        principal.as_deref(),
        &ctx.state.session_id(),
    )
    .map_err(|error| ToolError::Execution(format!("{error:#}")))
}

pub(super) fn execute(
    input: ProjectKnowledgeInput,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let result = (|| -> anyhow::Result<Value> {
        anyhow::ensure!(!input.paths.is_empty() && input.paths.len() <= MAX_KNOWLEDGE_FILES,
            "project_knowledge_paths: provide 1..=8 relevant Markdown paths");
        check_paths(ctx, input.paths.iter().map(String::as_str)).map_err(|error| anyhow::anyhow!("{error}"))?;
        anyhow::ensure!(input.updates.len() <= 8, "project_knowledge_updates: at most 8 candidates");
        let replacement_bytes = input.updates.iter().try_fold(0usize, |size, update| size.checked_add(update.replacement.len()))
            .context("project_knowledge_proposal_budget_exceeded")?;
        anyhow::ensure!(replacement_bytes <= MAX_KNOWLEDGE_BYTES, "project_knowledge_proposal_budget_exceeded");
        let access = access(ctx).map_err(|error| anyhow::anyhow!("{error}"))?;
        let view = access.read(&input.paths, input.max_total_bytes,
            || !ctx.abort_token.as_ref().is_some_and(|token| token.is_cancelled()))?;
        let mut candidates = Vec::new();
        for update in input.updates {
            let scope = input.scope.as_deref().context("project_knowledge_update_requires_scope")?;
            candidates.push(access.propose(&view, scope, &update.path, &update.expected_revision, &update.replacement)?);
        }
        anyhow::ensure!(!ctx.abort_token.as_ref().is_some_and(|token| token.is_cancelled()), "project_knowledge_cancelled");
        Ok(serde_json::json!({"knowledge":view,"candidates":candidates,
            "interpretation":"authoritative_spec is the current Specs source; candidate_spec and candidate_update are unconfirmed; historical_change is retained history; project_document records document text without asserting verified implementation facts. Model summaries are derived, not confirmed knowledge. Reconcile contradictions against current source revisions. No content was saved or published."}))
    })().map_err(|error| ToolError::Execution(format!("{error:#}")))?;
    Ok(ToolOutput::text(result.to_string()))
}

/// Pure selection only; the Engine must execute the resulting request through its normal tool boundary.
pub fn task_source_paths(prompt: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for token in prompt.split(|c: char| c.is_whitespace() || "`\"'()[]{}<>,;!?".contains(c)) {
        let token = token.trim_end_matches(['.', ':', '。', '，', '：']);
        if token.ends_with(".md") && !paths.iter().any(|path| path == token) {
            paths.push(token.to_owned());
            // Preserve a visible quota error instead of silently dropping a requested source.
            if paths.len() > 8 {
                break;
            }
        }
    }
    paths
}

#[cfg(test)]
#[path = "project_knowledge_tests.rs"]
mod tests;
