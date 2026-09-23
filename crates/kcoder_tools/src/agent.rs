use crate::background::{
    ForegroundWaitOutcome, ManagedForegroundJob, wait_for_foreground_completion,
    wait_with_foreground_budget,
};
use crate::{
    AgentError, AgentRunOptions, MAX_SUBAGENT_DEPTH, SubagentContextMode, Tool, ToolContext,
    ToolError, ToolOutput, clean_schema, parse_input,
};
use async_trait::async_trait;
use kcoder_state::{
    SessionMode, Task, TaskDelivery, TaskKind, TaskStatus, orchestrate_store::PlanStore,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

const SYNTHETIC_CONTEXT_ORIGIN_NOTE: &str = "Origin boundary: parent Message records currently have no structural origin tag, so semantic/recent identify KCoder-generated user-role blocks by reserved leading wrappers after whitespace. The reserved prefixes are continuation summaries ('This session is being continued...' and 'Earlier conversation summary:'), <project-instructions>, <skill_content, <relevant-memories>, <subagent_notification, <task_notification, <workflow_notification, <system-reminder, 'Project instructions', 'Additional instructions', 'Relevant memories', 'Active skills', 'You are currently in plan mode:', 'Recent file read retained after compaction', 'Available tools after compaction', '[system]', and 'TodoList maintenance reminder:'. A genuine user text beginning with one of these reserved wrappers can therefore be treated as generated; rephrase that leading text or choose full when byte-for-byte retention is required. Continuation-summary text is retained by semantic cleanup but does not consume a recent-turn count.";
const BACKGROUND_PARENT_COORDINATION_GUIDANCE: &str = "If this background result contributes to the requested final answer, keep the parent task open and wait for every relevant background sub-agent to reach a terminal state before final synthesis. Continue only non-overlapping work while agents run. Do not repeat work already delegated to a running agent. To redirect one running tracked agent, use SendMessage with its canonical agent_id; the durable instruction is applied at that agent's next protocol-safe model/tool boundary without cancelling its siblings. A queued delivery is not a completed result, so do not poll reflexively. Do not produce the final aggregation from partial results or while required evidence is still missing; inspect each relevant completion or failure first, resolve material gaps, and then synthesize once.";

/// First-class role for a delegated sub-agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    General,
    Explore,
    Plan,
    Review,
    Implementer,
    Verifier,
    ToolAgent,
}

impl AgentKind {
    pub fn from_agent_type(agent_type: Option<&str>) -> Self {
        agent_type
            .and_then(Self::from_alias)
            .unwrap_or(AgentKind::General)
    }

    pub fn from_alias(agent_type: &str) -> Option<Self> {
        let normalized = agent_type
            .trim()
            .to_ascii_lowercase()
            .replace(['-', ' '], "_");

        match normalized.as_str() {
            "" | "general" | "default" | "worker" | "general_purpose" | "generic" => {
                Some(Self::General)
            }
            "explore" | "explorer" | "exploration" | "explore_agent" => Some(Self::Explore),
            "plan" | "planner" | "planning" | "plan_agent" => Some(Self::Plan),
            "review" | "reviewer" | "code_review" | "code_reviewer" => Some(Self::Review),
            "implement" | "implementer" | "implementation" | "builder" | "build" => {
                Some(Self::Implementer)
            }
            "verify" | "verifier" | "verification" | "validator" | "tester" | "test" => {
                Some(Self::Verifier)
            }
            "tool" | "tool_agent" | "executor" | "execution" | "shell" => Some(Self::ToolAgent),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Explore => "explore",
            Self::Plan => "plan",
            Self::Review => "review",
            Self::Implementer => "implementer",
            Self::Verifier => "verifier",
            Self::ToolAgent => "tool_agent",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Explore => "Explore",
            Self::Plan => "Plan",
            Self::Review => "Review",
            Self::Implementer => "Implementer",
            Self::Verifier => "Verifier",
            Self::ToolAgent => "Tool",
        }
    }

    pub fn default_context_mode(self, arrangement_mode: bool) -> SubagentContextMode {
        if arrangement_mode {
            return SubagentContextMode::None;
        }
        match self {
            Self::General => SubagentContextMode::Semantic,
            Self::Explore | Self::Plan | Self::Review => SubagentContextMode::Recent,
            Self::Implementer | Self::Verifier | Self::ToolAgent => SubagentContextMode::None,
        }
    }

    pub fn system_prompt(self) -> &'static str {
        self.role_prompt()
    }

    pub fn spawn_agent_schema_values() -> &'static [&'static str] {
        &[
            "general",
            "plan",
            "review",
            "implementer",
            "verifier",
            "tool_agent",
        ]
    }

    pub fn build_prompt(self, task: &str) -> String {
        self.build_prompt_with_contract(task, None)
    }

    pub fn build_prompt_with_contract(
        self,
        task: &str,
        contract: Option<&AgentTaskContract>,
    ) -> String {
        let task = task.trim();
        let contract_text = contract
            .map(AgentTaskContract::to_prompt_section)
            .filter(|section| !section.is_empty())
            .unwrap_or_default();
        format!(
            "{role}\n\n\
             Task:\n{task}\n\n\
             {contract_text}\
             Global sub-agent contract:\n\
             - Stay inside this delegated task; do not broaden scope.\n\
             - Prefer focused tool use and return a final report only when finished.\n\
             - Do not ask the user questions; state assumptions and blockers instead.\n\
             - Cite exact file paths, line numbers, commands, and observed outputs when relevant.\n\
             - Keep the final report concise enough for the main agent to integrate quickly.",
            role = self.role_prompt(),
            task = task,
            contract_text = contract_text,
        )
    }

    fn role_prompt(self) -> &'static str {
        match self {
            Self::General => {
                "You are a KCoder general sub-agent. Complete the assigned bounded task autonomously. Use only the tools needed for the task, avoid unrelated exploration, and report concrete results."
            }
            Self::Explore => {
                "You are a KCoder Explore sub-agent: a read-only codebase reconnaissance specialist. Your job is to rapidly map relevant files, symbols, flows, and risks. Do not create, edit, delete, move, copy, or format files. Use read/search tools first, parallelize independent searches when possible, and return compressed findings with path:line evidence. Changes: None."
            }
            Self::Plan => {
                "You are a KCoder Plan sub-agent: a read-only implementation planner. Explore enough code to produce a grounded plan, compare viable approaches, identify critical files, risks, and verification steps. For large or multi-step work, decompose the plan into atomic subtasks with explicit ownership, scoped context/write boundaries, acceptance criteria, expected artifacts, out-of-scope notes, and verifier checks. Do not create, edit, delete, move, copy, or format implementation files. In Arrangement mode, if an attached capability authorizes writing a plan artifact, use that capability before your final report and write only under .kcoder/arrangement/plans/. Return a prioritized plan, not a patch. Implementation changes: None."
            }
            Self::Review => {
                "You are a KCoder Review sub-agent: a read-only code reviewer. Prioritize correctness bugs, regressions, security issues, missing tests, and user-visible risks. Do not create, edit, delete, move, copy, or format files. Report findings by severity with file:line evidence; if there are no findings, say so clearly. Changes: None."
            }
            Self::Implementer => {
                "You are a KCoder Implementer sub-agent. Make the smallest coherent code change required by the delegated task, respect existing patterns, avoid unrelated refactors, and keep all edits inside delegated allowed_write_paths when a write scope is provided. Use only attached, authorized file-mutation capabilities for scoped source/config/test/script or formatting fixes. Do not bypass a write scope with shell commands that appear to mutate files, such as plain cargo fmt, rustfmt, prettier --write, eslint --fix, sed -i, tee, shell redirection, or inline script rewrites. If allowed_shell_prefixes are present, they are narrow execution capabilities explicitly delegated by the parent; use only those exact targets and do not append unrelated host commands. Verify the change when practical with read-only commands, and return changed files, verification commands, and any residual risks."
            }
            Self::Verifier => {
                "You are a KCoder Verifier sub-agent. Independently inspect the complete candidate diff and affected production paths, then run the target test suite and relevant regression checks. A minimal reproduction alone is not sufficient evidence of root-cause correctness. Never edit source or test files, install/uninstall/update dependencies, pipe test output through head/tail/grep, or mask a failing exit status. If target tests or required dependencies are unavailable, return FLAKY. Return PASS, FAIL, or FLAKY as the first non-empty line, followed by exact commands, raw exit codes, relevant output excerpts, and suspected causes."
            }
            Self::ToolAgent => {
                "You are a KCoder Tool sub-agent. Execute a small tool-heavy task quickly, avoid broad reasoning, avoid file edits unless the delegated task explicitly requires them and the current request exposes an authorized file-mutation capability, and return compact facts."
            }
        }
    }
}

/// Build the JSON value representing a task's current status.
pub(crate) fn agent_status_json(task: &Task) -> Value {
    match task.status {
        TaskStatus::Pending => serde_json::json!("pending"),
        TaskStatus::Running => serde_json::json!("running"),
        TaskStatus::Paused => serde_json::json!("paused"),
        TaskStatus::Halted => serde_json::json!("halted"),
        TaskStatus::Cancelled => serde_json::json!("cancelled"),
        TaskStatus::Completed => serde_json::json!({"completed": task.output.as_deref()}),
        TaskStatus::Failed => {
            serde_json::json!({"failed": task.output.as_deref().unwrap_or("unknown error")})
        }
    }
}

/// Spawn a sub-agent to work on a delegated task in the background.
#[derive(Default)]
pub struct AgentTool;

/// Spawn a read-only exploration sub-agent for codebase reconnaissance.
#[derive(Default)]
pub struct ExploreAgentTool;

/// Spawn a dedicated Arrangement planning sub-agent.
#[derive(Default)]
pub struct PlanAgentTool;

fn artifact_requirements_schema(
    _: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    serde_json::from_value(serde_json::json!({
        "type": "array", "maxItems": 32, "default": [],
        "description": "Explicit file requirements, not permission grants or verified evidence. Paths are preserved verbatim; runtime validation limits each path to 4096 UTF-8 bytes.",
        "items": {
            "type": "object", "additionalProperties": false, "required": ["path"],
            "properties": {
                "path": {"type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^[^\\u0000]+$"},
                "min_bytes": {"type": "integer", "minimum": 0, "maximum": 16777216, "default": 1},
                "required": {"type": "boolean", "default": true},
                "unique_content": {"type": "boolean", "default": false},
                "require_changed": {"type": "boolean", "default": false, "description": "Require a newly created file or changed raw content relative to the pre-execution baseline; this does not guarantee who made the change."},
                "forbidden_literals": {
                    "type": "array", "maxItems": 16, "default": [],
                    "items": {"type": "string", "minLength": 1, "maxLength": 256},
                    "description": "Optional exact UTF-8 byte matches forbidden in file content; no regex or case folding. Runtime limits each nonempty literal to 256 UTF-8 bytes and all literals to 4096 bytes. Empty means no content scanning."
                }
            }
        }
    })).expect("static artifact requirement schema")
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentInput {
    /// Explicit file declarations; separate from free-form expected_artifacts.
    #[serde(
        default,
        deserialize_with = "kcoder_state::deserialize_artifact_requirements"
    )]
    #[schemars(schema_with = "artifact_requirements_schema")]
    pub artifact_requirements: Vec<kcoder_state::ArtifactRequirement>,
    /// Self-contained task instruction for the sub-agent. Include relevant
    /// files, expected output, constraints, and what not to change.
    #[serde(alias = "description")]
    pub message: String,
    /// Optional specialized role. Prefer `plan`, `review`, `implementer`,
    /// `verifier`, or `tool_agent` when the task fits; omit for `general`. Use
    /// the dedicated `explore_agent` tool for read-only reconnaissance.
    #[serde(default)]
    pub agent_type: Option<String>,
    /// Maximum number of turns for the sub-agent. Use a JSON integer and omit
    /// unless the task genuinely needs a custom cap.
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    /// Parent conversation inheritance for the first child turn. `auto`
    /// selects a role-aware default; `none` sends only the delegated task;
    /// `semantic` keeps stable user messages and assistant text-only messages
    /// with no ToolUse; it drops mixed ToolUse messages, reasoning, and tool
    /// results. `recent` applies that projection to the last
    /// `context_turns` user turns; `full` copies the complete compacted parent
    /// snapshot. SendMessage continuations always use the child transcript.
    #[serde(default)]
    pub context_mode: SubagentContextMode,
    /// Number of parent user turns kept only when `context_mode` is `recent`.
    /// Must be at least one; ignored by every other mode.
    #[serde(default = "default_context_turns")]
    pub context_turns: usize,
    /// Paths this sub-agent is allowed to create or modify. In Arrangement
    /// mode, implementer agents must include at least one path. Verifier agents
    /// should omit this when running tests/builds; if paths are supplied, file
    /// writes are narrowed and shell execution is inspection-only because an
    /// executable validation command could write outside the declared scope.
    #[serde(default)]
    pub allowed_write_paths: Vec<String>,
    /// Shell command prefixes explicitly authorized for this child. Use the
    /// narrowest stable prefix, including an exact external container name
    /// when delegating `docker exec` or `podman exec`.
    #[serde(default)]
    pub allowed_shell_prefixes: Vec<String>,
    /// Concrete acceptance checks the main orchestrator will use before
    /// accepting the delegated result.
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    /// Files, reports, command outputs, or other artifacts expected in the
    /// final sub-agent result.
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
    /// Relevant files, symbols, or commands the sub-agent should inspect first.
    #[serde(default)]
    pub context_paths: Vec<String>,
    /// Explicitly out-of-scope changes or areas the sub-agent must avoid.
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    /// Verification commands or checks the sub-agent should run when practical.
    #[serde(default)]
    pub verification: Vec<String>,
    /// Run asynchronously and return immediately. Defaults to `false`, so the
    /// tool waits for completion. Large foreground results are previewed inline
    /// and remain complete in the returned `output_file`.
    #[serde(default)]
    pub run_in_background: bool,
    /// Optional inline wait budget. Defaults to zero, which blocks until
    /// completion or user cancellation. A positive value moves the same still-
    /// running sub-agent to background delivery when the budget expires.
    #[serde(default = "default_agent_foreground_timeout_ms")]
    pub foreground_timeout_ms: u64,
    /// Optional filesystem isolation. `worktree` runs the child in a dedicated
    /// git worktree so parallel mutable agents cannot collide with the parent
    /// workspace or each other; omit for the default shared-workspace behavior.
    #[serde(default)]
    pub isolation: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct AgentTaskContract {
    #[serde(default)]
    pub allowed_write_paths: Vec<String>,
    #[serde(default)]
    pub allowed_shell_prefixes: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
    #[serde(default)]
    pub context_paths: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    #[serde(default)]
    pub verification: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedPersonaRequest {
    pub(crate) name: String,
    pub(crate) base_role: AgentKind,
    pub(crate) runtime: crate::AgentRuntimeSelection,
    pub(crate) tool_allowlist: Option<Vec<String>>,
    pub(crate) context_mode: SubagentContextMode,
    pub(crate) review_vote_channel: Option<crate::ReviewVoteChannel>,
    pub(crate) work_id: String,
    pub(crate) critic_max_cycles: usize,
    pub(crate) critic_max_infrastructure_retries: usize,
}

pub(crate) fn resolve_agent_request(
    ctx: &ToolContext,
    requested: Option<&str>,
) -> Result<(AgentKind, Option<ResolvedPersonaRequest>), ToolError> {
    let requested = requested.unwrap_or("general").trim();
    // Historical aliases for regular roles must remain unchanged. Dynamic personas
    // handle only names that do not resolve to an existing AgentKind.
    if let Some(kind) = AgentKind::from_alias(requested) {
        return Ok((kind, None));
    }
    if ctx.state.session_mode() != SessionMode::Orchestrate {
        return Ok((AgentKind::General, None));
    }
    let settings = ctx
        .runtime_settings
        .as_ref()
        .ok_or_else(|| ToolError::Execution("runtime settings are unavailable".to_string()))?
        .read()
        .map_err(|_| ToolError::Execution("runtime settings lock is poisoned".to_string()))?;
    let roster = settings.orchestrate.roster.get(requested).ok_or_else(|| {
        ToolError::InvalidInput(format!("unknown Orchestrate persona {requested:?}"))
    })?;
    let base_role = kcoder_config::orchestrate_persona_base_role(requested)
        .and_then(AgentKind::from_alias)
        .ok_or_else(|| ToolError::Execution(format!("persona {requested:?} has no base role")))?;
    let tier = settings
        .orchestrate
        .tiers
        .get(&roster.tier)
        .ok_or_else(|| {
            ToolError::Execution(format!(
                "persona {requested:?} references unavailable tier {:?}",
                roster.tier
            ))
        })?;
    let runtime = crate::AgentRuntimeSelection {
        profile: tier.profile.clone(),
        provider: tier.provider.clone(),
        model: tier.model.clone(),
    };
    let context_mode = match roster.context_mode {
        kcoder_config::OrchestrateContextMode::None => SubagentContextMode::None,
        kcoder_config::OrchestrateContextMode::Fork => SubagentContextMode::Semantic,
        kcoder_config::OrchestrateContextMode::Full => SubagentContextMode::Full,
    };
    let snapshot = PlanStore::for_workspace(&ctx.state.cwd())
        .read_active_work()
        .map_err(|error| {
            ToolError::InvalidInput(format!(
                "Orchestrate persona delegation requires an active work plan: {error:#}"
            ))
        })?;
    let review_vote_channel = (requested == "critic").then(|| {
        crate::ReviewVoteChannel::new(crate::ReviewVoteExpectation {
            work_id: snapshot.work.work_id.clone(),
            plan_revision: snapshot.work.revision,
            plan_sha256: snapshot.work.plan_sha256.clone(),
        })
    });
    if requested == "critic"
        && PlanStore::for_workspace(&ctx.state.cwd())
            .read_critic_review_state(&snapshot.work.work_id)
            .map_err(|error| {
                ToolError::Execution(format!("failed to read critic state: {error:#}"))
            })?
            .is_some_and(|review| {
                review.revision == snapshot.work.revision
                    && review.plan_sha256 == snapshot.work.plan_sha256
                    && review.automatic_review_stopped
            })
    {
        return Err(ToolError::InvalidInput(
            "automatic critic review is closed for this plan revision; edit the plan to create a new revision or continue with user review"
                .to_string(),
        ));
    }
    Ok((
        base_role,
        Some(ResolvedPersonaRequest {
            name: requested.to_string(),
            base_role,
            runtime,
            tool_allowlist: roster.tool_allowlist.clone(),
            context_mode,
            review_vote_channel,
            work_id: snapshot.work.work_id,
            critic_max_cycles: settings.orchestrate.critic_max_cycles,
            critic_max_infrastructure_retries: settings
                .orchestrate
                .critic_max_infrastructure_retries,
        }),
    ))
}

impl AgentTaskContract {
    fn from_input(input: &AgentInput) -> Self {
        Self {
            allowed_write_paths: sanitize_list(&input.allowed_write_paths),
            allowed_shell_prefixes: sanitize_list(&input.allowed_shell_prefixes),
            acceptance_criteria: sanitize_list(&input.acceptance_criteria),
            expected_artifacts: sanitize_list(&input.expected_artifacts),
            context_paths: sanitize_list(&input.context_paths),
            out_of_scope: sanitize_list(&input.out_of_scope),
            verification: sanitize_list(&input.verification),
        }
    }

    fn to_run_options(
        &self,
        agent_kind: AgentKind,
        arrangement_mode: bool,
        context_mode: SubagentContextMode,
        context_turns: usize,
    ) -> AgentRunOptions {
        AgentRunOptions::with_allowed_write_paths(self.allowed_write_paths.clone())
            .with_allowed_shell_prefixes(self.allowed_shell_prefixes.clone())
            .with_block_shell_file_mutation(agent_kind_blocks_shell_file_mutation(
                agent_kind,
                arrangement_mode,
            ))
            .with_arrangement_mode(arrangement_mode)
            .with_context_inheritance(context_mode, context_turns)
    }

    fn to_prompt_section(&self) -> String {
        let mut lines = Vec::new();
        push_contract_list(&mut lines, "Allowed write paths", &self.allowed_write_paths);
        push_contract_list(
            &mut lines,
            "Allowed shell prefixes",
            &self.allowed_shell_prefixes,
        );
        push_contract_list(
            &mut lines,
            "Context paths to inspect first",
            &self.context_paths,
        );
        push_contract_list(&mut lines, "Acceptance criteria", &self.acceptance_criteria);
        push_contract_list(&mut lines, "Expected artifacts", &self.expected_artifacts);
        push_contract_list(&mut lines, "Out of scope", &self.out_of_scope);
        push_contract_list(&mut lines, "Verification", &self.verification);

        if lines.is_empty() {
            String::new()
        } else {
            format!("Delegation contract:\n{}\n\n", lines.join("\n"))
        }
    }
}

pub fn agent_kind_blocks_shell_file_mutation(
    agent_kind: AgentKind,
    arrangement_mode: bool,
) -> bool {
    matches!(
        agent_kind,
        AgentKind::Explore | AgentKind::Plan | AgentKind::Review | AgentKind::ToolAgent
    ) || (arrangement_mode && matches!(agent_kind, AgentKind::General))
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ExploreAgentInput {
    /// Self-contained read-only exploration task for the sub-agent. Include
    /// the question to answer, relevant paths or symbols, expected evidence,
    /// and any files/areas to prioritize. Do not ask it to edit files.
    #[serde(alias = "description")]
    pub message: String,
    /// Maximum number of turns for the exploration sub-agent. Use a JSON
    /// integer and omit unless the reconnaissance genuinely needs a custom
    /// cap.
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    #[serde(default)]
    pub context_mode: SubagentContextMode,
    #[serde(default = "default_context_turns")]
    pub context_turns: usize,
    /// Run asynchronously and return immediately instead of waiting for the
    /// exploration result.
    #[serde(default)]
    pub run_in_background: bool,
    /// Optional inline wait budget. Defaults to zero, which blocks until
    /// completion or cancellation. A positive value promotes the same live
    /// run to background delivery after the budget expires.
    #[serde(default = "default_agent_foreground_timeout_ms")]
    pub foreground_timeout_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct PlanAgentInput {
    #[serde(
        default,
        deserialize_with = "kcoder_state::deserialize_artifact_requirements"
    )]
    #[schemars(schema_with = "artifact_requirements_schema")]
    pub artifact_requirements: Vec<kcoder_state::ArtifactRequirement>,
    /// Self-contained planning request for the Plan sub-agent. Include the
    /// user goal, known constraints, context already gathered, and expected
    /// planning depth. The Plan sub-agent owns the final plan artifact.
    #[serde(alias = "description")]
    pub message: String,
    /// Short human-readable title for the plan artifact written by WritePlan.
    #[serde(default)]
    pub title: Option<String>,
    /// Optional stable plan file name under .kcoder/arrangement/plans/.
    #[serde(default)]
    pub file_name: Option<String>,
    /// Maximum number of turns for the planning sub-agent.
    #[serde(default = "default_max_turns")]
    pub max_turns: usize,
    #[serde(default)]
    pub context_mode: SubagentContextMode,
    #[serde(default = "default_context_turns")]
    pub context_turns: usize,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
    #[serde(default)]
    pub context_paths: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    #[serde(default)]
    pub verification: Vec<String>,
    /// Run asynchronously and return immediately instead of waiting for the
    /// completed plan result.
    #[serde(default)]
    pub run_in_background: bool,
    /// Optional inline wait budget. Defaults to zero, which blocks until
    /// completion or cancellation. A positive value promotes the same live
    /// run to background delivery after the budget expires.
    #[serde(default = "default_agent_foreground_timeout_ms")]
    pub foreground_timeout_ms: u64,
}

fn default_max_turns() -> usize {
    DEFAULT_AGENT_MAX_TURNS
}

fn default_context_turns() -> usize {
    2
}

fn sanitize_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn invalid_allowed_shell_prefix(prefix: &str) -> bool {
    prefix.is_empty()
        || prefix
            .chars()
            .any(|character| matches!(character, '\n' | '\r' | ';' | '|' | '&' | '<' | '>' | '`'))
        || prefix.contains("$(")
        || prefix.contains("${")
}

fn push_contract_list(lines: &mut Vec<String>, label: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    lines.push(format!("- {label}:"));
    for value in values {
        lines.push(format!("  - {value}"));
    }
}

pub(crate) const DEFAULT_AGENT_MAX_TURNS: usize = kcoder_config::DEFAULT_SUBAGENT_MAX_TURNS;
pub(crate) const MIN_AGENT_MAX_TURNS: usize = kcoder_config::MIN_SUBAGENT_MAX_TURNS;
pub(crate) const MAX_AGENT_MAX_TURNS: usize = kcoder_config::MAX_SUBAGENT_MAX_TURNS;
pub(crate) const DEFAULT_AGENT_FOREGROUND_TIMEOUT_MS: u64 = 0;
pub(crate) const MIN_AGENT_FOREGROUND_TIMEOUT_MS: u64 = 100;
pub(crate) const MAX_AGENT_FOREGROUND_TIMEOUT_MS: u64 = 300_000;

fn default_agent_foreground_timeout_ms() -> u64 {
    DEFAULT_AGENT_FOREGROUND_TIMEOUT_MS
}

fn clamp_agent_foreground_timeout_ms(timeout_ms: u64) -> u64 {
    if timeout_ms == 0 {
        0
    } else {
        timeout_ms.clamp(
            MIN_AGENT_FOREGROUND_TIMEOUT_MS,
            MAX_AGENT_FOREGROUND_TIMEOUT_MS,
        )
    }
}

pub(crate) fn clamp_agent_max_turns(max_turns: usize) -> usize {
    max_turns.clamp(MIN_AGENT_MAX_TURNS, MAX_AGENT_MAX_TURNS)
}

pub(crate) fn apply_configured_default_max_turns(input: &mut Value, ctx: &ToolContext) {
    if let Value::Object(object) = input {
        object.entry("max_turns").or_insert_with(|| {
            Value::Number(serde_json::Number::from(ctx.default_subagent_max_turns))
        });
    }
}

pub(crate) fn resolved_delivery_policy(ctx: &ToolContext) -> Result<(u64, u32), ToolError> {
    let Some(settings) = ctx.runtime_settings.as_ref() else {
        return Ok((120, 8));
    };
    let settings = settings
        .read()
        .map_err(|_| ToolError::Execution("runtime settings lock is poisoned".to_string()))?;
    Ok((
        settings
            .orchestrate
            .delivery
            .lease_timeout_seconds
            .clamp(30, 3600),
        settings.orchestrate.delivery.max_attempts.clamp(1, 64),
    ))
}

pub(crate) fn generate_agent_job_id() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("job-{ts}")
}

fn reserve_agent_job_id(state: &kcoder_state::AppState) -> Result<String, ToolError> {
    if let Some(registry) = state.short_id_registry() {
        kcoder_state::short_id::reserve_short_id(&registry)
            .map_err(|error| ToolError::Execution(format!("cannot allocate agent ID: {error}")))
    } else {
        Ok(generate_agent_job_id())
    }
}

pub(crate) async fn run_initial_subagent_loop(
    state: kcoder_state::AppState,
    runner: Arc<dyn crate::AgentRunner>,
    agent_id: String,
    prompt: String,
    max_turns: usize,
    agent_kind: AgentKind,
    options: AgentRunOptions,
) -> ToolOutput {
    run_subagent_loop(
        state,
        runner,
        agent_id,
        Some(SubagentLoopStart::Initial(prompt)),
        max_turns,
        agent_kind,
        options,
    )
    .await
}

pub(crate) async fn run_continued_subagent_loop(
    state: kcoder_state::AppState,
    runner: Arc<dyn crate::AgentRunner>,
    agent_id: String,
    max_turns: usize,
    agent_kind: AgentKind,
    mut options: AgentRunOptions,
) -> ToolOutput {
    let Some(task) = state.task(&agent_id) else {
        return ToolOutput::error("agent has no persisted task declarations");
    };
    if let Err(error) = options.restore_artifact_requirements(&task) {
        return ToolOutput::error(error.to_string());
    }
    run_subagent_loop(
        state, runner, agent_id, None, max_turns, agent_kind, options,
    )
    .await
}

enum SubagentLoopStart {
    Initial(String),
}

async fn run_subagent_loop(
    state: kcoder_state::AppState,
    runner: Arc<dyn crate::AgentRunner>,
    agent_id: String,
    start: Option<SubagentLoopStart>,
    max_turns: usize,
    agent_kind: AgentKind,
    options: AgentRunOptions,
) -> ToolOutput {
    let mut latest_output = String::new();
    if let Some(SubagentLoopStart::Initial(prompt)) = start {
        let result = runner
            .run_agent_session_with_options(
                agent_id.clone(),
                prompt,
                max_turns,
                agent_kind,
                options.clone(),
            )
            .await;
        let review_diagnostic = record_critic_review_result(&state, &agent_id, &options, &result);
        match result {
            Ok(text) => {
                latest_output = text;
                if let Some(diagnostic) = review_diagnostic {
                    latest_output.push_str("\n\n");
                    latest_output.push_str(&diagnostic);
                }
            }
            Err(AgentError::Cancelled(reason)) => {
                state.update_task(&agent_id, |task| {
                    task.status = TaskStatus::Cancelled;
                    task.output = Some(reason.clone());
                    task.accepting_subagent_messages = false;
                });
                return ToolOutput::error(format!("agent execution cancelled: {reason}"));
            }
            Err(AgentError::Paused(reason)) => {
                return ToolOutput::error(format!("agent paused: {reason}"));
            }
            Err(AgentError::Halted(reason)) => {
                return ToolOutput::error(format!("agent halted: {reason}"));
            }
            Err(error) => {
                // Close atomically before the background manager publishes the
                // terminal Failed state. Otherwise SendMessage can enqueue in
                // this short window even though no worker remains to consume it.
                state.update_task(&agent_id, |task| {
                    task.accepting_subagent_messages = false;
                });
                return ToolOutput::error(error.to_string());
            }
        }
    }

    loop {
        let claim = match state.claim_next_subagent_delivery(
            &agent_id,
            options.delivery_lease_timeout_seconds,
            options.delivery_max_attempts,
        ) {
            Ok(claim) => claim,
            Err(error) => return ToolOutput::error(error.to_string()),
        };
        let claim = match claim {
            kcoder_state::AgentDeliveryClaimOutcome::Claimed(claim) => claim,
            kcoder_state::AgentDeliveryClaimOutcome::Empty => {
                match state.close_subagent_delivery_queue_if_empty(&agent_id) {
                    Ok(true) => break,
                    Ok(false) => continue,
                    Err(error) => return ToolOutput::error(error.to_string()),
                }
            }
            kcoder_state::AgentDeliveryClaimOutcome::Busy {
                message_id,
                expires_at_ms,
            } => {
                return ToolOutput::error(format!(
                    "delivery {message_id} is still leased until {expires_at_ms}; refusing duplicate worker"
                ));
            }
            kcoder_state::AgentDeliveryClaimOutcome::Blocked {
                message_id,
                attempts,
                last_error,
            } => {
                return ToolOutput::error(format!(
                    "delivery {message_id} is blocked after {attempts} attempts: {}",
                    last_error.unwrap_or_else(|| "no diagnostic was recorded".to_string())
                ));
            }
        };
        let delivery_options = options
            .clone()
            .with_delivery(claim.message_id.clone(), claim.lease_id.clone());
        let result = runner
            .send_message_to_agent_with_options(
                agent_id.clone(),
                claim.body.clone(),
                max_turns,
                agent_kind,
                delivery_options,
            )
            .await;
        match result {
            Ok(text) => {
                latest_output = text;
                if let Err(error) =
                    state.ack_subagent_delivery(&agent_id, &claim.message_id, &claim.lease_id)
                {
                    return ToolOutput::error(format!(
                        "sub-agent completed delivery {}, but ack persistence failed: {error:#}",
                        claim.message_id
                    ));
                }
            }
            Err(AgentError::Cancelled(reason)) => {
                let _ = fail_delivery_if_still_leased(
                    &state,
                    &agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    options.delivery_max_attempts,
                    &reason,
                );
                state.update_task(&agent_id, |task| {
                    task.status = TaskStatus::Cancelled;
                    task.output = Some(reason.clone());
                    task.accepting_subagent_messages = false;
                });
                return ToolOutput::error(format!("agent execution cancelled: {reason}"));
            }
            Err(AgentError::Paused(reason)) => {
                let _ = fail_delivery_if_still_leased(
                    &state,
                    &agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    options.delivery_max_attempts,
                    &reason,
                );
                return ToolOutput::error(format!("agent paused: {reason}"));
            }
            Err(AgentError::Halted(reason)) => {
                let _ = fail_delivery_if_still_leased(
                    &state,
                    &agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    options.delivery_max_attempts,
                    &reason,
                );
                return ToolOutput::error(format!("agent halted: {reason}"));
            }
            Err(error) => {
                let failure = fail_delivery_if_still_leased(
                    &state,
                    &agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    options.delivery_max_attempts,
                    &error.to_string(),
                );
                if let Err(persist_error) = failure {
                    return ToolOutput::error(format!(
                        "agent execution failed: {error}; additionally failed to persist delivery retry state: {persist_error:#}"
                    ));
                }
                return ToolOutput::error(error.to_string());
            }
        }
    }

    ToolOutput::text(latest_output)
}

fn fail_delivery_if_still_leased(
    state: &kcoder_state::AppState,
    agent_id: &str,
    message_id: &str,
    lease_id: &str,
    max_attempts: u32,
    error: &str,
) -> anyhow::Result<()> {
    let still_leased = state.task(agent_id).is_some_and(|task| {
        task.message_queue.first().is_some_and(|message| {
            message.message_id == message_id
                && message.status == kcoder_state::AgentMessageStatus::Leased
                && message
                    .lease
                    .as_ref()
                    .is_some_and(|lease| lease.lease_id == lease_id)
        })
    });
    if still_leased {
        state
            .fail_subagent_delivery(agent_id, message_id, lease_id, max_attempts, error)
            .map(|_| ())?;
    }
    Ok(())
}

fn record_critic_review_result(
    state: &kcoder_state::AppState,
    agent_id: &str,
    options: &AgentRunOptions,
    result: &Result<String, AgentError>,
) -> Option<String> {
    let channel = options.review_vote_channel.as_ref()?;
    let expected = channel.expectation();
    let outcome = match channel.recorded_vote().map(|vote| vote.input.verdict) {
        Some(crate::ReviewVoteOutcome::Okay) => {
            kcoder_state::orchestrate_store::CriticReviewOutcome::Okay
        }
        Some(crate::ReviewVoteOutcome::Reject) => {
            kcoder_state::orchestrate_store::CriticReviewOutcome::Reject
        }
        None => kcoder_state::orchestrate_store::CriticReviewOutcome::InfrastructureError,
    };
    let store = PlanStore::for_workspace(&state.cwd());
    match store.record_critic_review(
        &expected.work_id,
        expected.plan_revision,
        &expected.plan_sha256,
        outcome,
        options.critic_max_cycles,
        options.critic_max_infrastructure_retries,
    ) {
        Ok(review) => {
            state.record_orchestrate_runtime_event_after_commit(
                "critic_vote_recorded",
                Some(&expected.work_id),
                None,
                Some(agent_id),
                None,
                serde_json::json!({
                    "plan_revision": expected.plan_revision,
                    "outcome": match outcome {
                        kcoder_state::orchestrate_store::CriticReviewOutcome::Okay => "okay",
                        kcoder_state::orchestrate_store::CriticReviewOutcome::Reject => "reject",
                        kcoder_state::orchestrate_store::CriticReviewOutcome::InfrastructureError => "infrastructure_error",
                    },
                    "reject_count": review.reject_count,
                    "infrastructure_retry_count": review.infrastructure_retry_count,
                }),
            );
            let summary = match outcome {
                kcoder_state::orchestrate_store::CriticReviewOutcome::Okay => {
                    "ReviewVote: Okay".to_string()
                }
                kcoder_state::orchestrate_store::CriticReviewOutcome::Reject => format!(
                    "ReviewVote: Reject ({}/{})",
                    review.reject_count, options.critic_max_cycles
                ),
                kcoder_state::orchestrate_store::CriticReviewOutcome::InfrastructureError => {
                    format!(
                        "ReviewVote: unavailable ({}/{} infrastructure retries)",
                        review.infrastructure_retry_count,
                        options.critic_max_infrastructure_retries
                    )
                }
            };
            state.update_task(agent_id, |task| {
                task.review_vote_summary = Some(summary.clone());
            });
            Some(format!(
                "{summary}; automatic_review_stopped={}",
                review.automatic_review_stopped
            ))
        }
        Err(error) => Some(format!(
            "ReviewVote was not applied to PlanStore because the bound revision became stale or review state was closed: {error:#}. Agent result status: {}.",
            if result.is_ok() {
                "completed"
            } else {
                "failed"
            }
        )),
    }
}

fn build_plan_agent_message(input: &PlanAgentInput) -> String {
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Arrangement Plan");
    let file_name = input
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut message = format!(
        "You are the dedicated Arrangement PlanAgent. The main orchestrator must not draft the executable plan directly; you own planning and plan-artifact creation.\n\n\
         Planning request:\n{}\n\n\
         Plan artifact requirements:\n\
         - Produce a grounded, executable plan with sequencing, dependencies, delegation boundaries, risks, acceptance criteria, and verifier checks.\n\
         - For large or multi-step work, include an atomic subtask breakdown with one outcome, one responsible role or agent, scoped context/write boundaries, acceptance criteria, expected artifacts, out-of-scope notes, and verifier checks.\n\
         - Do not edit implementation files and do not run executable validation commands yourself.\n\
         - Before your final report, call WritePlan with title {:?}",
        input.message.trim(),
        title,
    );
    if let Some(file_name) = file_name {
        message.push_str(&format!(" and file_name {:?}", file_name));
    }
    message.push_str(
        ".\n\
         - The WritePlan content must be the complete plan, not a placeholder.\n\
         - Keep the initial WritePlan focused and bounded: do not dump full source files, raw logs, long transcripts, or unrelated background.\n\
         - Your final report must include the plan artifact path returned by WritePlan and a concise summary for the main orchestrator.",
    );
    message
}

#[async_trait]
impl Tool for PlanAgentTool {
    fn name(&self) -> String {
        "PlanAgent".to_string()
    }

    fn description(&self) -> String {
        format!(
            "Spawn the dedicated Arrangement PlanAgent to investigate and produce a grounded implementation strategy, then persist the complete plan with WritePlan under .kcoder/arrangement/plans/. Use this when the main orchestrator needs a new plan artifact; the orchestrator must delegate plan creation rather than drafting it directly. The PlanAgent should decompose large work into atomic subtasks with ownership, scoped context/write boundaries, acceptance criteria, expected artifacts, out-of-scope notes, risks, and verifier checks. It must not edit implementation files or dump huge raw transcripts/logs into the plan. By default the tool blocks until completion; a large result is previewed inline and remains complete in output_file. Set run_in_background=true to return immediately, or use a positive foreground_timeout_ms to promote the same live run to background delivery after that budget. {}",
            BACKGROUND_PARENT_COORDINATION_GUIDANCE
        )
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(PlanAgentInput));
        if let Value::Object(ref mut map) = schema
            && let Some(Value::Object(props)) = map.get_mut("properties")
        {
            props.insert(
                "context_mode".to_string(),
                serde_json::json!({
                    "type": "string",
                    "enum": ["auto", "none", "semantic", "recent", "full"],
                    "description": format!("Controls parent-conversation inheritance for the first PlanAgent turn only. Decision guide: auto (recommended) — recent outside Arrangement, none in Arrangement; context_turns is used only when auto resolves to recent. none — only the supplied planning request/context_paths, project instructions, Plan role prompt, cwd, and role-filtered tools. semantic — parent user intent, compact summaries, and assistant text-only messages; ToolUse, thinking, tool results, and generated blocks (task/workflow/sub-agent notifications, system/todo reminders) are removed. recent — semantic cleanup over the last context_turns real user turns. full — the entire snapshot including reasoning and tool traffic; use only for exact continuity, and it is rejected when the parent's provider or model changed since the snapshot or during a MoA aggregator turn. An explicitly supplied non-auto mode is honored in Arrangement. This field never selects the child's model, permissions, role, tools, or system prompt. SendMessage later appends to this child's saved transcript and never re-applies parent context. {}", SYNTHETIC_CONTEXT_ORIGIN_NOTE)
                }),
            );
            props.insert(
                "context_turns".to_string(),
                serde_json::json!({
                    "type": "integer",
                    "minimum": 1,
                    "default": 2,
                    "description": "Number of real parent user turns retained by recent mode; PlanAgent auto uses it only outside Arrangement, where auto resolves to recent. In Arrangement, PlanAgent auto resolves to none, so this value is ignored unless context_mode is explicitly recent. Tool-result messages and engine-generated compact summaries, project/skill/memory blocks, task/workflow/sub-agent notifications, system reminders, and todo reminders do not consume the count. Defaults to 2. After configured tool-input coercion it must be an integer >= 1; zero and negative values fail schema validation before the tool runs. Default semantic coercion may convert an integer-valued string such as \"2\"; strict/disabled coercion requires a JSON integer. none/semantic/full ignore this field."
                }),
            );
            props.insert(
                "run_in_background".to_string(),
                serde_json::json!({
                    "type": "boolean",
                    "default": false,
                    "description": format!("Return immediately with status=running and deliver the PlanAgent result asynchronously. Default false blocks until completion; large foreground results are previewed inline and remain complete in output_file. {}", BACKGROUND_PARENT_COORDINATION_GUIDANCE)
                }),
            );
            props.insert(
                "foreground_timeout_ms".to_string(),
                serde_json::json!({
                    "type": "integer",
                    "minimum": 0,
                    "maximum": MAX_AGENT_FOREGROUND_TIMEOUT_MS,
                    "default": 0,
                    "description": "Foreground wait budget in milliseconds. Default 0 blocks until completion or cancellation. After configured tool-input coercion it must be an integer in 0..=300000; values outside that range fail schema validation. Default semantic coercion may convert an integer-valued string such as \"1000\"; strict/disabled coercion requires a JSON integer. Values 1..99 then use the enforced 100 ms runtime minimum, while values 100..=300000 are used as supplied. Reaching the budget promotes the same still-running PlanAgent to background delivery without cancelling or restarting it."
                }),
            );
            props.insert(
                "max_turns".to_string(),
                serde_json::json!({
                    "type": "integer",
                    "minimum": MIN_AGENT_MAX_TURNS,
                    "maximum": MAX_AGENT_MAX_TURNS,
                    "description": "Maximum internal turns available to this PlanAgent run. When omitted, uses default_subagent_max_turns from settings.json (60 if unset). Explicit values must be in 60..=180; out-of-range values fail schema validation before the PlanAgent is spawned. Default semantic coercion may convert an integer-valued string such as \"60\"; strict/disabled coercion requires a JSON integer. This cap does not control parent-context inheritance; use context_mode/context_turns for that."
                }),
            );
        }
        schema
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut input = input;
        apply_configured_default_max_turns(&mut input, ctx);
        let input: PlanAgentInput = parse_input(&input)?;
        let message = build_plan_agent_message(&input);
        let mut expected_artifacts = input.expected_artifacts;
        expected_artifacts.push(
            "WritePlan artifact under .kcoder/arrangement/plans/ containing the complete plan"
                .to_string(),
        );
        let agent_input = AgentInput {
            artifact_requirements: input.artifact_requirements,
            message,
            agent_type: Some("plan".to_string()),
            max_turns: input.max_turns,
            context_mode: input.context_mode,
            context_turns: input.context_turns,
            allowed_write_paths: Vec::new(),
            allowed_shell_prefixes: Vec::new(),
            acceptance_criteria: input.acceptance_criteria,
            expected_artifacts,
            context_paths: input.context_paths,
            out_of_scope: input.out_of_scope,
            verification: input.verification,
            run_in_background: input.run_in_background,
            foreground_timeout_ms: input.foreground_timeout_ms,
            isolation: None,
        };
        spawn_agent_with_kind(ctx, AgentKind::Plan, None, agent_input).await
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct SpawnAgentResult {
    /// Identifier the model uses with `wait` / `close_agent` to refer to
    /// this sub-agent.
    agent_id: String,
    /// `"completed"`/`"failed"` for default foreground delivery, or
    /// `"running"` when `run_in_background=true` returns immediately.
    status: String,
    /// Canonical role selected for this sub-agent.
    agent_type: String,
    /// Echo of the description that was queued. Helps the model confirm it
    /// delegated the right task before moving on to other work.
    description: String,
    /// Stable file path where the final sub-agent output will be written.
    output_file: String,
    /// The maximum number of agent-internal turns the sub-agent is allowed
    /// to use. Lets the model reason about wall-clock cost.
    max_turns: usize,
    context_mode: SubagentContextMode,
    context_turns: usize,
    allowed_write_paths: Vec<String>,
    allowed_shell_prefixes: Vec<String>,
    /// Isolation worktree the child ran in, when `isolation="worktree"` was
    /// requested. The parent reviews/merges (or discards) this branch after
    /// integrating the result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_branch: Option<String>,
    /// Whether this call returned before the delegated work completed.
    run_in_background: bool,
    /// Whether a foreground call exhausted its budget and was promoted.
    auto_backgrounded: bool,
    /// Effective time the call was willing to wait for an inline result.
    foreground_timeout_ms: u64,
    /// Foreground result or a bounded head/tail preview when the child output
    /// exceeds the parent tool-output budget. Omitted for background calls.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    /// Original UTF-8 byte length of the foreground result. Omitted until a
    /// foreground run finishes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result_bytes: Option<usize>,
    /// True when `result` is only a preview. The complete result remains in
    /// `output_file` and can be read on demand.
    #[serde(default)]
    result_truncated: bool,
    /// Concrete next-step instructions for the selected delivery mode.
    next_action: String,
}

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

async fn spawn_agent_with_kind(
    ctx: &ToolContext,
    agent_kind: AgentKind,
    persona: Option<ResolvedPersonaRequest>,
    input: AgentInput,
) -> Result<ToolOutput, ToolError> {
    kcoder_state::validate_artifact_requirements(&input.artifact_requirements)
        .map_err(ToolError::InvalidInput)?;
    let child_depth = ctx.agent_depth.saturating_add(1);
    if child_depth > MAX_SUBAGENT_DEPTH {
        return Err(ToolError::InvalidInput(format!(
            "sub-agent depth limit exceeded: current depth is {}, requested child depth is {}, maximum is {}",
            ctx.agent_depth, child_depth, MAX_SUBAGENT_DEPTH
        )));
    }
    let runner = ctx
        .agent_runner
        .as_ref()
        .map(Arc::clone)
        .ok_or_else(|| ToolError::Execution("agent runner not available".into()))?;

    if ctx.is_aborted() {
        return Err(ToolError::Aborted);
    }

    let contract = AgentTaskContract::from_input(&input);
    if ctx.arrangement_mode
        && matches!(agent_kind, AgentKind::Implementer)
        && contract.allowed_write_paths.is_empty()
    {
        return Err(ToolError::InvalidInput(
            "Arrangement implementer agents require allowed_write_paths so code changes have an explicit write scope".to_string(),
        ));
    }
    if ctx.arrangement_mode
        && !matches!(agent_kind, AgentKind::Implementer | AgentKind::Verifier)
        && !contract.allowed_write_paths.is_empty()
    {
        return Err(ToolError::InvalidInput(
            "Only Arrangement implementer and verifier agents may receive allowed_write_paths; use agent_type=\"implementer\" for scoped edits or agent_type=\"verifier\" for validation work that needs write/edit access".to_string(),
        ));
    }
    if !matches!(agent_kind, AgentKind::Implementer | AgentKind::Verifier)
        && !contract.allowed_shell_prefixes.is_empty()
    {
        return Err(ToolError::InvalidInput(
            "Only implementer and verifier agents may receive allowed_shell_prefixes".to_string(),
        ));
    }
    if let Some(prefix) = contract
        .allowed_shell_prefixes
        .iter()
        .find(|prefix| invalid_allowed_shell_prefix(prefix))
    {
        return Err(ToolError::InvalidInput(format!(
            "allowed_shell_prefixes entry {prefix:?} contains shell control or expansion syntax; delegate a literal executable/argument prefix"
        )));
    }

    let isolation = input
        .isolation
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(value) = isolation
        && value != "worktree"
    {
        return Err(ToolError::InvalidInput(format!(
            "unknown isolation value \"{value}\"; the only supported value is \"worktree\""
        )));
    }

    let task = input.message.trim().to_string();
    let base_prompt = agent_kind.build_prompt_with_contract(&task, Some(&contract));
    let context_mode = persona.as_ref().map_or_else(
        || match input.context_mode {
            SubagentContextMode::Auto => agent_kind.default_context_mode(ctx.arrangement_mode),
            mode => mode,
        },
        |persona| persona.context_mode,
    );
    let context_turns = input.context_turns.max(1);
    let cancellation = CancellationToken::new();
    let max_turns = clamp_agent_max_turns(input.max_turns);
    let foreground_timeout_ms = clamp_agent_foreground_timeout_ms(input.foreground_timeout_ms);
    let delegated_type = persona
        .as_ref()
        .map(|persona| persona.name.as_str())
        .unwrap_or_else(|| agent_kind.as_str());
    let delegated_display = persona
        .as_ref()
        .map(|persona| persona.name.as_str())
        .unwrap_or_else(|| agent_kind.display_name());
    let description = format!("{} agent: {}", delegated_display, task);
    let requested_id = reserve_agent_job_id(&ctx.state)?;
    // Create the isolation worktree before registering the run so a failure
    // (e.g. cwd outside a git repository) aborts the spawn before any task
    // record or background job exists.
    let worktree = if isolation == Some("worktree") {
        Some(
            crate::worktree::create_agent_isolation_worktree(&ctx.state.cwd(), &requested_id)
                .await?,
        )
    } else {
        None
    };
    let mut prompt = match &worktree {
        Some((path, branch)) => format!(
            "{base_prompt}\n\nIsolation boundary: you are running in a dedicated git worktree at {} on branch {}. Relative paths and shell commands start from this directory; keep every change inside it and do not edit the parent workspace directly. Do not commit unless the task explicitly asks; the main agent reviews the worktree and merges or discards the branch after you finish.",
            path.display(),
            branch
        ),
        None => base_prompt,
    };
    if !input.artifact_requirements.is_empty() {
        prompt.push_str(
            "\n\nExplicit file requirements (declarations only; not evidence of verification):\n",
        );
        prompt.push_str(
            &serde_json::to_string(&input.artifact_requirements)
                .map_err(|error| ToolError::Execution(error.to_string()))?,
        );
    }
    let (delivery_lease_timeout_seconds, delivery_max_attempts) = resolved_delivery_policy(ctx)?;
    let mut options = contract
        .to_run_options(
            agent_kind,
            ctx.arrangement_mode,
            context_mode,
            context_turns,
        )
        .with_artifact_requirements(input.artifact_requirements.clone())
        .with_abort_token(cancellation.clone())
        .with_delivery_policy(delivery_lease_timeout_seconds, delivery_max_attempts)
        .with_worktree_path(worktree.as_ref().map(|(path, _)| path.clone()));
    if let Some(persona) = persona.as_ref() {
        debug_assert_eq!(persona.base_role, agent_kind);
        options = options.with_persona(crate::AgentPersonaOptions {
            name: persona.name.clone(),
            runtime: persona.runtime.clone(),
            tool_allowlist: persona.tool_allowlist.clone(),
            review_vote_channel: persona.review_vote_channel.clone(),
            work_id: persona.work_id.clone(),
            critic_max_cycles: persona.critic_max_cycles,
            critic_max_infrastructure_retries: persona.critic_max_infrastructure_retries,
        });
    }
    let worktree_path_text = worktree
        .as_ref()
        .map(|(path, _)| path.display().to_string());
    let worktree_branch_text = worktree.as_ref().map(|(_, branch)| branch.clone());
    let run_state = ctx.state.clone();
    let run_agent_id = requested_id.clone();
    let run_in_background = input.run_in_background;
    let foreground_events = if run_in_background {
        None
    } else {
        Some(ctx.subscribe_background_jobs()?)
    };
    let (declarations_ready, wait_for_declarations) = tokio::sync::oneshot::channel();
    let work = async move {
        // The task identity must be persisted before a concurrently scheduled runner reads it.
        if wait_for_declarations.await.is_err() {
            return ToolOutput::error("sub-agent task metadata was not initialized");
        }
        if options
            .abort_token
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return ToolOutput::error("sub-agent cancelled before initialization completed");
        }
        run_initial_subagent_loop(
            run_state,
            runner,
            run_agent_id,
            prompt,
            max_turns,
            agent_kind,
            options,
        )
        .await
    };
    let cancel: Arc<dyn Fn() + Send + Sync> = Arc::new(move || cancellation.cancel());
    let id = if run_in_background {
        ctx.spawn_cancellable_subagent_background_with_id(
            requested_id,
            description.clone(),
            work,
            cancel,
        )?
    } else {
        ctx.spawn_cancellable_subagent_foreground_with_id(
            requested_id,
            description.clone(),
            work,
            cancel,
        )?
    };
    let spawned_run = ctx.state.task(&id).and_then(|task| task.background_run);
    if let (Some(manager), Some(tool_call_id)) = (
        ctx.background_job_manager.as_ref(),
        ctx.tool_call_id.as_deref(),
    ) {
        manager
            .associate_subagent_tool_call(&id, tool_call_id, run_in_background)
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to associate sub-agent `{id}` with tool call `{tool_call_id}`: {error}"
                ))
            })?;
    }
    let registered_fallback = if ctx.state.task(&id).is_none() {
        // Custom BackgroundJobSpawner implementations are not required to own
        // AppState. Register a fallback record so the public agent contract and
        // continuation metadata remain available regardless of the spawner.
        let mut task_record = Task::new(id.clone(), description.clone());
        task_record.status = TaskStatus::Running;
        task_record.kind = TaskKind::Subagent;
        task_record.managed = true;
        task_record.delivery = if run_in_background {
            TaskDelivery::Background
        } else {
            TaskDelivery::Foreground
        };
        task_record.notify_parent_on_completion = run_in_background;
        task_record.output_path = Some(ctx.state.subagent_output_path(&id));
        task_record.transcript_path = Some(ctx.state.subagent_transcript_path(&id));
        ctx.state.upsert_task(task_record);
        true
    } else {
        false
    };
    let output_file = ctx
        .state
        .task(&id)
        .and_then(|task| task.output_path)
        .unwrap_or_else(|| ctx.state.subagent_output_path(&id));
    // Resolve state-owned values before update_task takes the task write lock.
    // Calling back into AppState from inside the closure can deadlock.
    let parent_session_id = ctx.state.session_id();
    let worktree_path_for_task = worktree.as_ref().map(|(path, _)| path.clone());
    let roster_name = persona.as_ref().map(|persona| persona.name.clone());
    let orchestrate_work_id = persona.as_ref().map(|persona| persona.work_id.clone());
    ctx.state
        .update_task(&id, |task| {
            task.output_path = Some(output_file.clone());
            task.allowed_write_paths = contract.allowed_write_paths.clone();
            task.allowed_shell_prefixes = contract.allowed_shell_prefixes.clone();
            task.worktree_path = worktree_path_for_task.clone();
            task.worktree_branch = worktree_branch_text.clone();
            task.parent_session_id = Some(parent_session_id.clone());
            task.agent_kind = Some(agent_kind.as_str().to_string());
            task.context_mode = Some(
                serde_json::to_value(context_mode)
                    .ok()
                    .and_then(|value| value.as_str().map(ToOwned::to_owned))
                    .unwrap_or_else(|| "semantic".to_string()),
            );
            task.context_turns = Some(context_turns);
            task.agent_depth = Some(child_depth);
            task.max_turns = Some(max_turns);
            task.arrangement_mode = Some(ctx.arrangement_mode);
            task.agent_provider = ctx.runtime_provider.clone();
            task.agent_model = ctx.runtime_model.clone();
            task.roster_name = roster_name.clone();
            task.orchestrate_work_id = orchestrate_work_id.clone();
            task.delivery_lease_timeout_seconds = delivery_lease_timeout_seconds;
            task.delivery_max_attempts = delivery_max_attempts;
            task.accepting_subagent_messages = true;
        })
        .ok_or_else(|| {
            ToolError::Execution("sub-agent task disappeared before metadata initialization".into())
        })?;
    if !input.artifact_requirements.is_empty() {
        ctx.state
            .bind_subagent_artifact_requirements(&id, &input.artifact_requirements)
            .map_err(|error| {
                ToolError::Execution(format!("failed to bind artifact declarations: {error:#}"))
            })?;
    }
    ctx.state.record_orchestrate_runtime_event_after_commit(
        "agent_spawned",
        orchestrate_work_id.as_deref(),
        None,
        Some(&id),
        None,
        serde_json::json!({
            "agent_kind": agent_kind.as_str(),
            "run_in_background": run_in_background,
            "continuation": false,
            "max_turns": max_turns,
            "delivery_max_attempts": delivery_max_attempts,
        }),
    );
    let _ = declarations_ready.send(());
    let output_file_text = output_file.display().to_string();

    if run_in_background {
        let next_action = format!(
            "Sub-agent `{id}` is now running in the background (max {max_turns} internal turns). \
         `{output_file_text}` is a live path, not an immutable terminal result. Use the final notification or TaskOutput for the completed run's output path. \
         Continue doing other useful work; do not poll reflexively. When the sub-agent \
         finishes you will automatically receive a `<subagent_notification id=\"{id}\" \
         status=\"completed\"|\"failed\" .../>` system reminder and the main loop will run a \
         follow-up turn. If you need the result right now for the next critical-path step, \
         call TaskOutput once with block=true and a short timeout (15000 or less); otherwise just \
         acknowledge and move on. If this result contributes to the final answer, keep that answer \
         pending and wait for every relevant background sub-agent before synthesizing. Do not repeat its \
         delegated work while it is running, and do not produce the final aggregation from partial \
         results or missing evidence."
        );
        return Ok(ToolOutput::text(
            serde_json::to_string(&SpawnAgentResult {
                agent_id: id.clone(),
                status: "running".to_string(),
                agent_type: delegated_type.to_string(),
                description,
                output_file: output_file_text,
                max_turns,
                context_mode,
                context_turns,
                allowed_write_paths: contract.allowed_write_paths,
                allowed_shell_prefixes: contract.allowed_shell_prefixes,
                worktree_path: worktree_path_text.clone(),
                worktree_branch: worktree_branch_text.clone(),
                run_in_background: true,
                auto_backgrounded: false,
                foreground_timeout_ms,
                result: None,
                result_bytes: None,
                result_truncated: false,
                next_action,
            })
            .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))?,
        )
        .with_artifact_validation(ctx.state.task(&id).as_ref()));
    }

    let guard = ManagedForegroundJob::new(ctx, id.clone())?;
    let foreground_events = foreground_events.expect("foreground receiver must exist");
    let outcome = if foreground_timeout_ms == 0 {
        wait_for_foreground_completion(ctx, &id, foreground_events).await?
    } else {
        wait_with_foreground_budget(
            ctx,
            &id,
            foreground_events,
            std::time::Duration::from_millis(foreground_timeout_ms),
        )
        .await?
    };
    let output = match outcome {
        ForegroundWaitOutcome::Completed(output) => {
            guard.complete();
            output
        }
        ForegroundWaitOutcome::TimedOut => {
            guard.promote_to_background()?;
            let next_action = format!(
                "Sub-agent `{id}` is still running after the {foreground_timeout_ms} ms foreground budget, so KCoder kept the same run alive in the background. `{output_file_text}` is a live path; use the final notification or TaskOutput for the completed run's immutable output path. Continue only non-overlapping useful work; use TaskOutput with task_id `{id}` for status/output, or TaskStop to cancel it. Completion will also arrive as a `<subagent_notification .../>`. If this result contributes to the final answer, keep that answer pending and wait for every relevant background sub-agent before synthesizing. Do not repeat its delegated work while it is running, and do not produce the final aggregation from partial results or missing evidence."
            );
            return Ok(ToolOutput::text(
                serde_json::to_string(&SpawnAgentResult {
                    agent_id: id.clone(),
                    status: "running".to_string(),
                    agent_type: delegated_type.to_string(),
                    description,
                    output_file: output_file_text,
                    max_turns,
                    context_mode,
                    context_turns,
                    allowed_write_paths: contract.allowed_write_paths,
                    allowed_shell_prefixes: contract.allowed_shell_prefixes,
                    worktree_path: worktree_path_text.clone(),
                    worktree_branch: worktree_branch_text.clone(),
                    run_in_background: true,
                    auto_backgrounded: true,
                    foreground_timeout_ms,
                    result: None,
                    result_bytes: None,
                    result_truncated: false,
                    next_action,
                })
                .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))?,
            )
            .with_artifact_validation(ctx.state.task(&id).as_ref()));
        }
    };
    let failed = output.is_error;
    let result_text = tool_output_text(&output);
    if registered_fallback {
        if let Some(parent) = output_file.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                ToolError::Execution(format!(
                    "failed to create fallback sub-agent output directory: {error}"
                ))
            })?;
        }
        tokio::fs::write(&output_file, result_text.as_bytes())
            .await
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to persist fallback sub-agent output: {error}"
                ))
            })?;
        ctx.state.update_task(&id, |task| {
            task.status = if failed {
                TaskStatus::Failed
            } else {
                TaskStatus::Completed
            };
            task.output = Some(result_text.clone());
        });
    }
    let artifact_task = foreground_result_task(ctx, &id, spawned_run.as_ref())?;
    let output_file_text = artifact_task
        .as_ref()
        .and_then(|task| task.output_path.as_ref())
        .map(|path| path.display().to_string())
        .unwrap_or(output_file_text);
    let result_bytes = result_text.len();
    let inline_result = ctx.truncate(&result_text);
    let result_truncated = inline_result != result_text;
    let mut next_action = if result_truncated {
        format!(
            "The sub-agent has finished. `result` is a bounded head/tail preview because the complete output is {result_bytes} bytes. Read `{output_file_text}` only if details missing from the preview are needed, then integrate the result; do not rerun this agent."
        )
    } else {
        "The sub-agent has finished. Integrate the returned result; do not query this run again."
            .to_string()
    };
    if let (Some(path), Some(branch)) = (&worktree_path_text, &worktree_branch_text) {
        next_action.push_str(&format!(
            " This agent ran in isolation worktree `{path}` on branch `{branch}`; review the changes there (git diff/log), merge or cherry-pick what you need into the parent workspace, then remove the worktree with WorktreeRemove when it is no longer needed."
        ));
    }
    let payload = serde_json::to_string(&SpawnAgentResult {
        agent_id: id,
        status: if failed { "failed" } else { "completed" }.to_string(),
        agent_type: agent_kind.as_str().to_string(),
        description,
        output_file: output_file_text,
        max_turns,
        context_mode,
        context_turns,
        allowed_write_paths: contract.allowed_write_paths,
        allowed_shell_prefixes: contract.allowed_shell_prefixes,
        worktree_path: worktree_path_text,
        worktree_branch: worktree_branch_text,
        run_in_background: false,
        auto_backgrounded: false,
        foreground_timeout_ms,
        result: Some(inline_result),
        result_bytes: Some(result_bytes),
        result_truncated,
        next_action,
    })
    .map_err(|e| ToolError::Execution(format!("failed to serialize result: {e}")))?;
    let mut result = (if failed {
        ToolOutput::error(payload)
    } else {
        ToolOutput::text(payload)
    })
    .with_artifact_validation(artifact_task.as_ref());
    if let Some(task) = artifact_task.as_ref() {
        result = result.with_background_result_delivery(task);
    }
    Ok(result)
}

fn foreground_result_task(
    ctx: &ToolContext,
    id: &str,
    run: Option<&kcoder_types::BackgroundRunKey>,
) -> Result<Option<Task>, ToolError> {
    match run {
        Some(run) => {
            let mut task = ctx.state.task_for_background_run(run).ok_or_else(|| {
                ToolError::Execution(format!("sub-agent {id} completed run is unavailable"))
            })?;
            if !ctx
                .state
                .task(id)
                .is_some_and(|current| current.background_run.as_ref() == Some(run))
            {
                // Historical run records freeze output, but do not own newer artifact reports.
                task.artifact_validation_report = None;
                task.artifact_validation_run = None;
            }
            Ok(Some(task))
        }
        None => Ok(ctx.state.task(id)),
    }
}

#[async_trait]
impl Tool for AgentTool {
    fn name(&self) -> String {
        "spawn_agent".to_string()
    }

    fn description(&self) -> String {
        format!(
            "Spawn a sub-agent for a well-scoped, self-contained task. \
         By default this tool blocks until the sub-agent completes. A small result is returned inline; a large result is returned as a bounded head/tail preview with `result_truncated=true`, while the complete text remains at `output_file`. \
         Concurrency is role-aware. Multiple foreground `review` or `tool_agent` calls emitted in \
         one assistant response execute concurrently because those roles cannot modify files or \
         shared plan state. Foreground `general`, `plan`, `implementer`, and `verifier` calls are \
         serialized to prevent overlapping edits, plan writes, build artifacts, and other shared-state \
         races. For intentionally independent mutable work, give each task a disjoint scope and set \
         `run_in_background=true`; background dispatch returns promptly so the managed runs can make \
         progress independently. Set `run_in_background=true` to skip the foreground wait when the result is not required for the \
         immediate next step; this does not make the result optional when it is required for final aggregation. Background completion is delivered as a \
         `<subagent_notification .../>` system reminder and triggers a follow-up turn. \
         `TaskOutput` is only for a call that returned `status=\"running\"`; `TaskStop` cancels such a run, and `close_agent` releases a finished agent when it is no longer needed.\n\n\
         Parent-context inheritance (`context_mode`, first child turn only):\n\
         - `auto` (recommended default): selects a role-aware safe policy. Normal `general` uses `semantic`; `plan`, `review`, and `explore_agent` use `recent` with the requested `context_turns` (default 2); `implementer`, `verifier`, and `tool_agent` use `none`. Every Arrangement role defaults to `none`.\n\
         - `none`: send no parent conversation. The child still receives project instructions, its role system prompt, cwd, tools, and the self-contained delegated `message`. Prefer this for implementers and verifiers when the task contract already carries all required context.\n\
         - `semantic`: inherit stable parent user requests and assistant text-only messages containing no ToolUse. Any assistant message containing a ToolUse is dropped as a whole, including adjacent narration; thinking/reasoning, signatures, and tool-result messages are also removed. Prefer this when the child needs overall intent without execution noise.\n\
         - `recent`: like `semantic`, but only for the last `context_turns` real user turns. Prefer this for focused exploration, planning, or review of the current topic. Tool-result messages and engine-generated compact summaries, project/skill/memory blocks, sub-agent notifications, system reminders, and todo reminders do not consume the turn count.\n\
         - `full`: copy the complete compacted and tool-sequence-repaired parent snapshot, including reasoning and tool traffic. Because reasoning signatures and protocol blocks can be provider/model-specific, the call is rejected if the live parent changed provider or model after that snapshot. It is also rejected throughout an active MoA aggregator turn because the snapshot may contain mixed-runtime blocks; a later normal parent turn restores availability by capturing a clean compatible snapshot. This is the most expensive and least isolated mode; use it only when exact operational continuity is essential and semantic/recent context is insufficient.\n\
         Explicit modes are honored in Arrangement mode. `context_turns` is used only by `recent`, defaults to 2, and is ignored by other modes. SendMessage does not re-inherit the parent: it always appends to the selected child's own saved transcript.\n\
         {}\n\n\
         Guidelines:\n\
         - Delegation is limited to one level: the main conversation is depth 0 and may create \
           direct children at depth 1; a child cannot create another sub-agent. Calls beyond \
           this limit fail before a task is registered or work starts.\n\
         - Only spawn sub-agents for concrete, bounded subtasks that can run independently \
           alongside useful local work.\n\
         - Never keep more than 4 sub-agents running at the same time; if 4 are already \
           running, wait for one to finish before spawning another.\n\
         - Subtasks must materially advance the main task and should have disjoint write scopes. \
           For parallel mutable work, `isolation=\"worktree\"` gives each child its own git worktree \
           so edits never collide; the parent merges or discards each branch afterwards.\n\
         - Prefer the default blocking foreground call when the parent needs the result before answering.\n\
         - If background results contribute to the requested final answer, keep the parent task open and wait for every relevant background sub-agent to finish or fail before final synthesis. Continue only non-overlapping work, do not repeat work already delegated to a running agent, and do not produce the final aggregation from partial results or missing required evidence.\n\
         - Use TaskOutput only when the call returned status=running; do not poll reflexively.\n\
         - Do not redo delegated work yourself; focus on integrating results or tackling \
           non-overlapping work.\n\
         - Set `agent_type` when a specialized role fits: `plan` for read-only implementation \
           planning, `review` for read-only bug review, `implementer` for bounded edits, \
           `verifier` for tests/builds, and `tool_agent` for quick tool-heavy execution. \
           Use `explore_agent`, not `spawn_agent`, for read-only codebase reconnaissance. \
           Supply only a canonical `agent_type` value shown in the input schema; unknown values \
           and compatibility aliases are rejected by model-call schema validation.\n\
         - In Arrangement mode, `general`, `plan`, and `review` are read-only report roles. \
           `implementer` requires a non-empty `allowed_write_paths` array and must keep code, \
           config, test, and script edits inside that scope. `verifier` is the validation worker \
           for tests/builds/checks/repros and should omit `allowed_write_paths` when executable \
           validation is required. A verifier with write paths is shell-restricted to conservative \
           inspection commands because tests and builds can write outside the path scope. Only implementer and \
           verifier may receive write paths. For an external runtime, the parent may additionally \
           delegate literal `allowed_shell_prefixes` such as an exact `docker exec <container>` \
           prefix; use the narrowest target and never include shell control syntax. Never use \
           `spawn_agent(agent_type=\"explore\")`; \
           that value is rejected and `explore_agent` should be used instead.",
            SYNTHETIC_CONTEXT_ORIGIN_NOTE
        )
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(AgentInput));
        if let Value::Object(ref mut map) = schema
            && let Some(Value::Object(props)) = map.get_mut("properties")
        {
            props.insert(
                    "context_mode".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "enum": ["auto", "none", "semantic", "recent", "full"],
                        "description": format!("Controls parent-conversation inheritance for the first child turn only. Decision guide: auto (recommended) — role-aware default (general=semantic, plan/review=recent, implementer/verifier/tool_agent=none; every Arrangement role=none). none — only the delegated message, project instructions, role prompt, cwd, and role tools; best for self-contained work. semantic — parent user intent, compact summaries, and assistant text-only messages; ToolUse, thinking, tool results, and generated blocks (task/workflow/sub-agent notifications, system/todo reminders) are removed; use when the child needs overall intent without execution noise. recent — semantic cleanup over the last context_turns real user turns; use for a focused follow-up on the current topic. full — the entire snapshot including reasoning and tool traffic; use only for exact continuity, and it is rejected when the parent's provider or model changed since the snapshot or during a MoA aggregator turn. An explicitly supplied non-auto mode is honored in Arrangement. context_turns applies only to recent. This field never selects the child's model, permissions, role, tools, or system prompt. SendMessage appends to the child's saved transcript and never re-applies parent context. {}", SYNTHETIC_CONTEXT_ORIGIN_NOTE)
                    }),
                );
            props.insert(
                    "context_turns".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": 1,
                        "default": 2,
                        "description": "How many real parent user turns to retain when context_mode=recent. Tool-result messages and engine-generated compact summaries, project/skill/memory blocks, sub-agent notifications, system reminders, and todo reminders do not consume this count. Defaults to 2. After configured tool-input coercion it must be an integer >= 1; zero and negative values fail schema validation before the tool runs. Default semantic coercion may convert an integer-valued string such as \"2\"; strict/disabled coercion requires a JSON integer. Used by auto only when the selected role resolves auto to recent; ignored by none/semantic/full."
                    }),
                );
            props.insert(
                    "run_in_background".to_string(),
                    serde_json::json!({
                        "type": "boolean",
                        "description": format!("Return immediately and deliver completion asynchronously. Defaults to false, which blocks until completion. Background calls return status=running without a result; wait for the automatic subagent_notification, or call TaskOutput once only when the result is immediately required. {}", BACKGROUND_PARENT_COORDINATION_GUIDANCE)
                    }),
                );
            props.insert(
                    "foreground_timeout_ms".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_AGENT_FOREGROUND_TIMEOUT_MS,
                        "default": 0,
                        "description": "Foreground wait budget in milliseconds before the same live run is promoted to background delivery. Default 0 blocks until completion or user cancellation. After configured tool-input coercion it must be an integer in 0..=300000; values outside that range fail schema validation. Default semantic coercion may convert an integer-valued string such as \"1000\"; strict/disabled coercion requires a JSON integer. Values 1..99 then use the enforced 100 ms runtime minimum, while values 100..=300000 are used as supplied. Reaching the budget does not cancel or restart the child; the response returns status=running plus auto_backgrounded=true."
                    }),
                );
            props.insert(
                    "agent_type".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "enum": AgentKind::spawn_agent_schema_values(),
                        "description": "Specialized sub-agent role. Omit for general, or supply exactly one canonical enum value shown by this schema. Role guide: plan = read-only implementation planning; review = read-only code/bug review; implementer = bounded edits (in Arrangement it requires allowed_write_paths); verifier = tests/builds/validation; tool_agent = quick tool-heavy execution; general = anything that does not fit these. explore is NOT a valid value here — use the dedicated explore_agent tool for read-only codebase reconnaissance. In Arrangement mode, general/plan/review are read-only, implementer performs bounded edits, verifier performs validation, and only implementer/verifier may receive allowed_write_paths."
                    }),
                );
            props.insert(
                    "max_turns".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": MIN_AGENT_MAX_TURNS,
                        "maximum": MAX_AGENT_MAX_TURNS,
                        "description": format!(
                            "Maximum internal turns available to this child run. When omitted, uses default_subagent_max_turns from settings.json (60 if unset). Explicit values must be in {}..={}; out-of-range values fail schema validation before the child is spawned. Default semantic coercion may convert an integer-valued string such as \"60\"; strict/disabled coercion requires a JSON integer. This cap does not control parent-context inheritance.",
                            MIN_AGENT_MAX_TURNS,
                            MAX_AGENT_MAX_TURNS
                        )
                    }),
                );
            props.insert(
                    "allowed_write_paths".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Paths this sub-agent is allowed to create or modify. In Arrangement mode, implementer agents must provide a non-empty array with the exact files/directories they may edit. Verifier agents may omit this field for full validation permissions or include paths to narrow their write scope. General, plan, review, and tool_agent roles must not receive write paths."
                    }),
                );
            props.insert(
                    "allowed_shell_prefixes".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Literal shell command prefixes explicitly authorized for this child. Only implementer and verifier roles may receive them. Use the narrowest stable prefix and include the exact target, for example `docker exec <container-name>` or `docker exec -i <container-name>`. Shell control, redirection, command substitution, and expansion syntax are rejected in the prefix itself; the runtime separately rejects unapproved top-level command segments and host output redirection."
                    }),
                );
            props.insert(
                    "context_paths".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Files, directories, symbols, prior artifacts, or command outputs the sub-agent should inspect first. Use exact paths when known so the sub-agent starts grounded instead of wandering."
                    }),
                );
            props.insert(
                    "acceptance_criteria".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Concrete checks the main orchestrator will use before accepting the delegated result. Include user-visible behavior, file/content expectations, and failure conditions."
                    }),
                );
            props.insert(
                    "expected_artifacts".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Files, reports, command outputs, screenshots, diffs, plan/report artifacts, or other deliverables expected from the sub-agent result."
                    }),
                );
            props.insert(
                    "out_of_scope".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Explicitly out-of-scope changes, files, directories, behaviors, or refactors the sub-agent must avoid."
                    }),
                );
            props.insert(
                    "verification".to_string(),
                    serde_json::json!({
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Verification commands or checks the sub-agent should run when practical. In Arrangement mode, executable validation belongs to verifier agents, not explore/general/plan/review/tool_agent roles."
                    }),
                );
            props.insert(
                    "isolation".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "enum": ["worktree"],
                        "description": "Optional filesystem isolation for the child. \"worktree\" runs the child in a dedicated git worktree under .kcoder/worktrees/ (branch worktree-<agent_id>) so parallel mutable agents cannot collide with the parent workspace or each other. The child starts from a clean checkout of HEAD; the result reports worktree_path/worktree_branch, and the parent reviews, merges, or discards the branch afterwards. Requires the session cwd to be inside a git repository. Omit for the default shared-workspace behavior."
                    }),
                );
        }
        schema
    }

    fn is_concurrency_safe(&self, input: &Value) -> bool {
        if input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return true;
        }

        matches!(
            input.get("agent_type").and_then(Value::as_str),
            Some("review" | "tool_agent")
        )
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut input = input;
        apply_configured_default_max_turns(&mut input, ctx);
        let input = parse_input::<AgentInput>(&input)?;
        let (agent_kind, persona) = resolve_agent_request(ctx, input.agent_type.as_deref())?;
        if agent_kind == AgentKind::Explore && persona.is_none() {
            return Err(ToolError::InvalidInput(
                "spawn_agent no longer accepts agent_type=explore; use the dedicated explore_agent tool for read-only reconnaissance".to_string(),
            ));
        }
        spawn_agent_with_kind(ctx, agent_kind, persona, input).await
    }
}

#[async_trait]
impl Tool for ExploreAgentTool {
    fn name(&self) -> String {
        "explore_agent".to_string()
    }

    fn description(&self) -> String {
        "Spawn a dedicated read-only Explore sub-agent for codebase reconnaissance. \
         Prefer this tool over doing broad exploration yourself when the task requires \
         mapping unfamiliar code, finding relevant files/symbols, tracing flows, comparing \
         existing patterns, or collecting path:line evidence before implementation. \
         The Explore agent is intentionally read-only: it can inspect and search, but must \
         not create, edit, delete, move, copy, or format files. By default it blocks until completion; a large result is returned as a bounded preview with the complete report in output_file. Multiple calls in one response run \
         concurrently. Set `run_in_background=true` only when the result is not needed for the \
         immediate next step; this does not make it optional for final aggregation. If background exploration contributes to the requested final answer, keep the parent task open and wait for every relevant background sub-agent to finish or fail before final synthesis. Continue only non-overlapping work, do not repeat work already delegated to a running agent, and do not produce the final aggregation from partial results or missing required evidence. Never keep more than 4 sub-agents running \
         at the same time; if 4 are already running, wait for one to finish before spawning \
         another. Do not use it for edits, tests that require mutation, or final verification; \
         use implementer/verifier roles through `spawn_agent` when those are needed.\n\n\
         Input format:\n\
         - `message`: string, required. A self-contained read-only investigation request. \
         Include concrete paths, symbols, questions, expected output, and constraints.\n\
         - `context_mode`: optional `auto|none|semantic|recent|full`, default `auto`. For Explore, auto resolves to recent outside Arrangement and none in Arrangement; an explicit non-auto value is honored. none receives no parent transcript; semantic keeps user intent/images, compact summaries, and assistant text-only messages with no ToolUse, while dropping mixed ToolUse messages, reasoning, tool results, and duplicate engine reminders; recent applies that cleanup to the current topic; full copies the repaired compacted execution snapshot and is only for exact continuity. full is rejected after a provider/model switch and throughout an active MoA aggregator turn; a later normal parent turn captures a clean compatible snapshot and restores it. None of these values changes the read-only role, model, tools, permissions, or system prompt.\n\
         - `context_turns`: integer, optional, default 2. Used only by recent (including Explore auto outside Arrangement). Tool results and engine-generated summaries/reminders do not consume the count. After configured input coercion it must be >= 1; default semantic coercion can convert an integer-valued string, while strict coercion requires a JSON integer.\n\
         - `max_turns`: integer, optional. When omitted, uses `default_subagent_max_turns` from settings.json (60 by default). Explicit values must be in 60..=180; out-of-range values fail validation before Explore runs. Default semantic coercion can convert an integer-valued string, while strict coercion requires a JSON integer.\n\
         - `run_in_background`: boolean, optional. Defaults to false.\n\
         - `foreground_timeout_ms`: integer, optional. Defaults to 0, which waits until completion without automatic background delivery; set a positive value to permit automatic background delivery after that budget."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        let mut schema = clean_schema(schemars::schema_for!(ExploreAgentInput));
        if let Value::Object(ref mut map) = schema
            && let Some(Value::Object(props)) = map.get_mut("properties")
        {
            props.insert(
                    "context_mode".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "enum": ["auto", "none", "semantic", "recent", "full"],
                        "description": format!("Controls parent-conversation inheritance for the first Explore turn only. auto (recommended) resolves to recent outside Arrangement and to none in Arrangement; context_turns is used only when auto resolves to recent. none copies zero parent messages: Explore still receives the self-contained investigation message, project instructions, Explore role system prompt, cwd, and read-only role-filtered tools. semantic keeps real parent user text/images, compact-summary text, and assistant text-only messages containing no ToolUse. Any assistant message containing a ToolUse is dropped as a whole, including adjacent narration; thinking/reasoning, signatures, ToolResult messages, usage metadata, and duplicate engine-generated project/skill/memory/notification/reminder messages are also removed. recent finds the suffix beginning at the context_turns-th last real user turn and applies that semantic cleanup; only non-synthetic user messages containing text or an image consume the count. full copies the complete compacted, tool-sequence-repaired snapshot including reasoning and tool traffic and is rejected if the live provider or model changed after capture. full is also rejected throughout an active MoA aggregator turn because that snapshot may contain mixed-runtime blocks; a later normal parent turn captures a clean compatible snapshot and restores it. Use full only for exact operational continuity that recent/semantic cannot provide. An explicitly supplied non-auto mode is honored in Arrangement. This field does not change the child's model, role, permissions, tools, or system prompt. SendMessage appends to the child's saved transcript and never re-applies parent context. {}", SYNTHETIC_CONTEXT_ORIGIN_NOTE)
                    }),
                );
            props.insert(
                    "context_turns".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": 1,
                        "default": 2,
                        "description": "Number of real parent user turns retained by recent mode; Explore auto uses it only outside Arrangement, where auto resolves to recent. In Arrangement, Explore auto resolves to none, so this value is ignored unless context_mode is explicitly recent. Tool-result messages and engine-generated compact summaries, project/skill/memory blocks, task/workflow/sub-agent notifications, system reminders, and todo reminders do not consume the count. Defaults to 2. After configured tool-input coercion it must be an integer >= 1; zero and negative values fail schema validation before the tool runs. Default semantic coercion may convert an integer-valued string such as \"2\"; strict/disabled coercion requires a JSON integer. none/semantic/full ignore this field."
                    }),
                );
            props.insert(
                    "run_in_background".to_string(),
                    serde_json::json!({
                        "type": "boolean",
                        "description": format!("Return immediately instead of waiting for an inline exploration result. Defaults to false, which blocks until completion. {}", BACKGROUND_PARENT_COORDINATION_GUIDANCE)
                    }),
                );
            props.insert(
                    "foreground_timeout_ms".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": 0,
                        "maximum": MAX_AGENT_FOREGROUND_TIMEOUT_MS,
                        "default": 0,
                        "description": "Foreground wait budget in milliseconds. Default 0 blocks until completion or cancellation. After configured tool-input coercion it must be an integer in 0..=300000; values outside that range fail schema validation. Default semantic coercion may convert an integer-valued string such as \"1000\"; strict/disabled coercion requires a JSON integer. Values 1..99 then use the enforced 100 ms runtime minimum, while values 100..=300000 are used as supplied. Reaching the budget promotes the same still-running Explore agent to background delivery without cancelling or restarting it."
                    }),
                );
            props.insert(
                    "message".to_string(),
                    serde_json::json!({
                        "type": "string",
                        "description": "Self-contained read-only exploration task. Ask for codebase reconnaissance with concrete paths/symbols/questions and path:line evidence; do not request edits."
                    }),
                );
            props.insert(
                    "max_turns".to_string(),
                    serde_json::json!({
                        "type": "integer",
                        "minimum": MIN_AGENT_MAX_TURNS,
                        "maximum": MAX_AGENT_MAX_TURNS,
                        "description": format!(
                            "Maximum internal turns available to this Explore run. When omitted, uses default_subagent_max_turns from settings.json (60 if unset). Explicit values must be in {}..={}; out-of-range values fail schema validation before Explore is spawned. Default semantic coercion may convert an integer-valued string such as \"60\"; strict/disabled coercion requires a JSON integer. This cap does not control parent-context inheritance; omit it for normal exploration.",
                            MIN_AGENT_MAX_TURNS,
                            MAX_AGENT_MAX_TURNS
                        )
                    }),
                );
        }
        schema
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let mut input = input;
        apply_configured_default_max_turns(&mut input, ctx);
        let input = parse_input::<ExploreAgentInput>(&input)?;
        spawn_agent_with_kind(
            ctx,
            AgentKind::Explore,
            None,
            AgentInput {
                artifact_requirements: Vec::new(),
                message: input.message,
                agent_type: Some("explore".to_string()),
                max_turns: input.max_turns,
                context_mode: input.context_mode,
                context_turns: input.context_turns,
                allowed_write_paths: Vec::new(),
                allowed_shell_prefixes: Vec::new(),
                acceptance_criteria: Vec::new(),
                expected_artifacts: Vec::new(),
                context_paths: Vec::new(),
                out_of_scope: Vec::new(),
                verification: Vec::new(),
                run_in_background: input.run_in_background,
                foreground_timeout_ms: input.foreground_timeout_ms,
                isolation: None,
            },
        )
        .await
    }
}

#[cfg(test)]
#[rustfmt::skip]
#[path = "agent/tests.rs"]
mod tests;
