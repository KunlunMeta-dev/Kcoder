use crate::agent::AgentKind;
use crate::background;
use crate::review_vote::ReviewVoteChannel;
use crate::sandbox::Sandbox;
use crate::user_question::{DenyAllUserQuestioner, UserQuestioner};
use crate::verifier_vote::{VerifierVoteChannel, VerifierVoteRecord};
use crate::{ToolError, ToolExecutionMetadata, ToolOutput};
use async_trait::async_trait;
use kcoder_config::{GoalProTestScope, ToolLimitsSettings};
use kcoder_memory::{MemoryManager, MemoryStore};
use kcoder_skills::{Skill, SkillMutationActor, SkillRegistry};
use kcoder_state::AppState;
use kcoder_types::{ContentBlock, Message};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

/// Error returned by an agent runner.
#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent runner not available")]
    NotAvailable,
    #[error("agent execution cancelled: {0}")]
    Cancelled(String),
    #[error("agent paused at a safe boundary: {0}")]
    Paused(String),
    #[error("agent halted at a safe boundary: {0}")]
    Halted(String),
    #[error("agent execution failed: {0}")]
    Execution(String),
}

fn record_loaded_skill_metadata<'a>(
    cwd: &Path,
    external_dirs: &[PathBuf],
    skills: impl Iterator<Item = &'a Skill>,
) {
    let skills = skills
        .map(|skill| (skill.name.clone(), skill.source.clone()))
        .collect::<Vec<_>>();
    if let Err(error) =
        crate::skill_provenance::persist_loaded_skill_metadata(cwd, external_dirs, &skills)
    {
        tracing::warn!(%error, "failed to persist loaded skill metadata transaction");
    }
}

/// Trait for running a sub-agent from within a tool.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SubagentContextMode {
    /// Select a role-aware default at spawn time.
    #[default]
    Auto,
    /// Start from only the delegated task prompt.
    None,
    /// Keep stable user intent and completed assistant text while removing
    /// reasoning and tool traffic.
    Semantic,
    /// Keep the last `context_turns` semantic user turns.
    Recent,
    /// Copy the complete compacted and tool-sequence-repaired parent snapshot.
    Full,
}

/// Maximum public parent-to-child delegation depth. A main conversation is
/// depth 0 and its direct sub-agents are depth 1.
pub const MAX_SUBAGENT_DEPTH: u32 = 1;

/// Trait for running a sub-agent from within a tool.
#[derive(Debug, Clone)]
pub struct AgentRunOptions {
    /// Paths this sub-agent is allowed to create or modify. Empty means the
    /// runner should not add an extra Arrangement write-scope restriction.
    pub allowed_write_paths: Vec<String>,
    /// Shell command prefixes explicitly delegated to this child. The shell
    /// tool still validates every top-level segment and keeps parent deny
    /// rules authoritative.
    pub allowed_shell_prefixes: Vec<String>,
    /// Explicit file declarations; not filesystem validation or write authority.
    pub artifact_requirements: Vec<kcoder_state::ArtifactRequirement>,
    /// When true, shell commands that appear to mutate files are blocked even
    /// without an explicit write path scope. Used for read-only sub-agent roles.
    pub block_shell_file_mutation: bool,
    /// Arrangement semantics latched by the tool context that spawned or
    /// resumed this sub-agent.
    pub arrangement_mode: bool,
    /// Optional cancellation token owned by the caller of this agent run.
    pub abort_token: Option<CancellationToken>,
    /// Parent conversation inheritance policy for the first child turn.
    /// Continuations always use the child transcript instead.
    pub context_mode: SubagentContextMode,
    /// Number of semantic user turns retained by `Recent`.
    pub context_turns: usize,
    /// Isolated git worktree the child runs in (spawn_agent
    /// `isolation="worktree"`). When set, the fork's session cwd is this path
    /// instead of the parent workspace.
    pub worktree_path: Option<std::path::PathBuf>,
    /// Built-in orchestration persona name; None for regular roles.
    pub persona_name: Option<String>,
    /// Provider/model slot resolved from configuration; initial and resumed runs must use the same selection.
    pub runtime_selection: Option<AgentRuntimeSelection>,
    /// User-configurable restrictive allowlist; may only intersect the base-role tool set.
    pub tool_allowlist: Option<Vec<String>>,
    /// Structured verdict channel available only to critics.
    pub review_vote_channel: Option<ReviewVoteChannel>,
    pub orchestrate_work_id: Option<String>,
    pub critic_max_cycles: usize,
    pub critic_max_infrastructure_retries: usize,
    /// Stable ID and lease for the current reliable message delivery; None for an agent's initial run.
    pub delivery: Option<AgentDeliveryContext>,
    /// Local lease timeout for sub-agent messages; does not replace provider request timeouts.
    pub delivery_lease_timeout_seconds: u64,
    /// Mark a message blocked after this many attempts; never discard it automatically.
    pub delivery_max_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDeliveryContext {
    pub message_id: String,
    pub lease_id: String,
}

/// Non-sensitive provider/model selection used by an internal sub-agent runtime.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentRuntimeSelection {
    pub profile: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// Complete orchestration-persona policy at a sub-agent execution boundary.
///
/// Pass these related fields as one value so callers do not depend on a fragile
/// positional-argument order when policy fields are added.
#[derive(Debug, Clone)]
pub struct AgentPersonaOptions {
    pub name: String,
    pub runtime: AgentRuntimeSelection,
    pub tool_allowlist: Option<Vec<String>>,
    pub review_vote_channel: Option<ReviewVoteChannel>,
    pub work_id: String,
    pub critic_max_cycles: usize,
    pub critic_max_infrastructure_retries: usize,
}

/// Isolation policy that the engine must enforce for a Goal Pro verifier runtime.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VerifierRunOptions {
    pub isolate_environment: bool,
    pub block_dependency_mutation: bool,
    pub verify_workspace_unchanged: bool,
    /// Minimum test scope enforced before execution; None means this verifier does not require a test.
    pub minimum_test_scope: Option<GoalProTestScope>,
    /// Reject shell commands that would hide the test process's original exit code.
    pub require_raw_exit_code: bool,
    /// Allow the verifier to run an identically signed behavior probe on a read-only baseline.
    pub require_behavior_delta: bool,
    /// Private baseline bundle saved when the goal is created and no Git HEAD is available.
    pub workspace_baseline: Option<VerifierWorkspaceBaseline>,
}

/// Persisted baseline reference used by Goal Pro in non-Git or unborn-HEAD workspaces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifierWorkspaceBaseline {
    pub bundle_path: PathBuf,
    pub bundle_sha256: String,
    pub commit: String,
    pub source_root: PathBuf,
}

/// One actual tool-execution record from a sub-agent.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentToolExecution {
    pub name: String,
    pub input: Value,
    pub output: String,
    pub is_error: Option<bool>,
    /// Engine-classified test provenance; models cannot set this field.
    pub test_origin: Option<VerifierTestOrigin>,
    /// Canonical invocation directory relative to the authenticated Candidate
    /// or Baseline root. Pairing requires this value to match on both sides.
    pub verifier_relative_workdir: Option<PathBuf>,
    /// Typed process status parsed only from trusted shell ToolResult headers captured by the engine.
    pub process_exit_code: Option<i32>,
    pub process_signal: Option<i32>,
    pub process_cwd: Option<PathBuf>,
    /// Trusted artifact metadata emitted directly by file tools, never reread or inferred from model-supplied paths.
    pub artifacts: Vec<AgentArtifactExecution>,
    /// Whether the command preserves the tested process's original exit status; always false for pipelines or trailing commands.
    pub raw_exit_code: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentArtifactExecution {
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifierTestOrigin {
    Candidate,
    Baseline,
}

/// Sub-agent result with a tool trace; Goal Pro does not rely solely on model-generated verdict text.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRunResult {
    pub output: String,
    pub tool_executions: Vec<AgentToolExecution>,
    /// Changed paths extracted by the engine from the isolated candidate snapshot; verifier text cannot forge them.
    pub candidate_changed_paths: Vec<String>,
    /// Content fingerprint of the isolated candidate when the verifier starts.
    pub candidate_fingerprint: Option<String>,
    pub tool_trace_complete: bool,
    pub environment_isolated: bool,
    pub dependency_mutation_blocked: bool,
    pub workspace_snapshot_verified: bool,
    pub workspace_unchanged: bool,
    /// Canonical baseline path used only while classifying recorded commands.
    pub verifier_baseline_root: Option<PathBuf>,
    /// Runtime-validated structured verifier verdict; takes precedence over output-text parsing.
    pub verifier_vote: Option<VerifierVoteRecord>,
}

impl AgentRunResult {
    pub fn untraced(output: String) -> Self {
        Self {
            output,
            tool_executions: Vec::new(),
            candidate_changed_paths: Vec::new(),
            candidate_fingerprint: None,
            tool_trace_complete: false,
            environment_isolated: false,
            dependency_mutation_blocked: false,
            workspace_snapshot_verified: false,
            workspace_unchanged: false,
            verifier_baseline_root: None,
            verifier_vote: None,
        }
    }

    pub fn from_messages(
        output: String,
        messages: &[Message],
        environment_isolated: bool,
        dependency_mutation_blocked: bool,
        workspace_snapshot_verified: bool,
        workspace_unchanged: bool,
    ) -> Self {
        Self::from_messages_with_trusted_tool_results(
            output,
            messages,
            &std::collections::HashMap::new(),
            environment_isolated,
            dependency_mutation_blocked,
            workspace_snapshot_verified,
            workspace_unchanged,
        )
    }

    /// Reconstruct a tool trace from the transcript, preferring results captured by the engine during execution.
    ///
    /// Large results are replaced with a `<persisted-output>` preview before transcript
    /// persistence, while verifier machine gates still require the original exit code
    /// and failure summary. `trusted_tool_results` must come only from EngineEvents in
    /// the same run and must never be reread through transcript file paths, which would
    /// cross the persisted-file path security boundary.
    pub fn from_messages_with_trusted_tool_results(
        output: String,
        messages: &[Message],
        trusted_tool_results: &std::collections::HashMap<String, ToolOutput>,
        environment_isolated: bool,
        dependency_mutation_blocked: bool,
        workspace_snapshot_verified: bool,
        workspace_unchanged: bool,
    ) -> Self {
        let mut tool_uses = std::collections::HashMap::new();
        let mut matched_tool_results = std::collections::HashSet::new();
        let mut trace_has_protocol_error = false;
        let mut tool_executions = Vec::new();
        for message in messages {
            match message {
                Message::Assistant { content, .. } => {
                    for block in content {
                        if let ContentBlock::ToolUse { id, name, input } = block
                            && tool_uses
                                .insert(id.clone(), (name.clone(), input.clone()))
                                .is_some()
                        {
                            trace_has_protocol_error = true;
                        }
                    }
                }
                Message::User { content } => {
                    for block in content {
                        let ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                        } = block
                        else {
                            continue;
                        };
                        let Some((name, input)) = tool_uses.get(tool_use_id) else {
                            trace_has_protocol_error = true;
                            continue;
                        };
                        if !matched_tool_results.insert(tool_use_id.clone()) {
                            trace_has_protocol_error = true;
                            continue;
                        }
                        let trusted = trusted_tool_results.get(tool_use_id);
                        let execution_content =
                            trusted.map_or(content.as_slice(), |output| output.content.as_slice());
                        let output = execution_content
                            .iter()
                            .filter_map(|block| match block {
                                ContentBlock::Text { text } => Some(text.as_str()),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        let process_metadata = trusted.and_then(|output| {
                            output
                                .execution_metadata
                                .iter()
                                .find_map(|metadata| match metadata {
                                    ToolExecutionMetadata::Process {
                                        exit_code,
                                        signal,
                                        cwd,
                                    } => Some((*exit_code, *signal, cwd.clone())),
                                    ToolExecutionMetadata::Artifact { .. }
                                    | ToolExecutionMetadata::ArtifactValidation(_) => None,
                                })
                        });
                        let process_exit_code =
                            process_metadata.as_ref().and_then(|(code, _, _)| *code);
                        let process_signal =
                            process_metadata.as_ref().and_then(|(_, signal, _)| *signal);
                        let process_cwd = process_metadata.map(|(_, _, cwd)| cwd);
                        let artifacts = trusted
                            .into_iter()
                            .flat_map(|output| &output.execution_metadata)
                            .filter_map(|metadata| match metadata {
                                ToolExecutionMetadata::Artifact { path, sha256 } => {
                                    Some(AgentArtifactExecution {
                                        path: path.clone(),
                                        sha256: sha256.clone(),
                                    })
                                }
                                ToolExecutionMetadata::Process { .. }
                                | ToolExecutionMetadata::ArtifactValidation(_) => None,
                            })
                            .collect();
                        let raw_exit_code = trusted.is_some()
                            && process_exit_code.is_some()
                            && input
                                .get("command")
                                .and_then(Value::as_str)
                                .is_some_and(command_preserves_raw_exit_code);
                        tool_executions.push(AgentToolExecution {
                            name: name.clone(),
                            input: input.clone(),
                            output,
                            is_error: trusted.map(|output| output.is_error).or(*is_error),
                            test_origin: None,
                            verifier_relative_workdir: None,
                            process_exit_code,
                            process_signal,
                            process_cwd,
                            artifacts,
                            raw_exit_code,
                        });
                    }
                }
            }
        }
        let tool_trace_complete = !trace_has_protocol_error
            && tool_uses
                .keys()
                .all(|tool_use_id| matched_tool_results.contains(tool_use_id));
        Self {
            output,
            tool_executions,
            candidate_changed_paths: Vec::new(),
            candidate_fingerprint: None,
            tool_trace_complete,
            environment_isolated,
            dependency_mutation_blocked,
            workspace_snapshot_verified,
            workspace_unchanged,
            verifier_baseline_root: None,
            verifier_vote: None,
        }
    }
}

fn command_preserves_raw_exit_code(command: &str) -> bool {
    if shell_status_can_be_masked(command) {
        return false;
    }
    let Some(words) = crate::bash::shell_words(command) else {
        return false;
    };
    nested_shell_scripts(&words)
        .into_iter()
        .all(command_preserves_raw_exit_code)
}

/// Treat only control syntax actually parsed by the current shell as exit-code
/// contamination. Quoted Python or Ruby programs may contain semicolons, but
/// command substitution inside double quotes is still executed by the shell and must be rejected.
fn shell_status_can_be_masked(command: &str) -> bool {
    let mut single_quoted = false;
    let mut double_quoted = false;
    let mut escaped = false;
    let chars = command.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if ch == '\\' && !single_quoted {
            escaped = true;
            index += 1;
            continue;
        }
        if ch == '\'' && !double_quoted {
            single_quoted = !single_quoted;
            index += 1;
            continue;
        }
        if ch == '"' && !single_quoted {
            double_quoted = !double_quoted;
            index += 1;
            continue;
        }
        if single_quoted {
            index += 1;
            continue;
        }
        if ch == '`'
            || (ch == '$'
                && chars
                    .get(index + 1)
                    .is_some_and(|next| matches!(next, '?' | '(')))
        {
            return true;
        }
        if !double_quoted && matches!(ch, ';' | '|' | '&' | '\n' | '\r') {
            return true;
        }
        index += 1;
    }
    single_quoted || double_quoted || escaped
}

/// A host command such as `docker exec ... bash -lc 'pytest | tail'` has no outer
/// pipeline, but its inner shell can still hide the real exit code. Recursively
/// inspect every explicit `sh -c` or `bash -lc` script.
fn nested_shell_scripts(words: &[String]) -> Vec<&str> {
    let mut scripts = Vec::new();
    for (index, word) in words.iter().enumerate() {
        let executable = std::path::Path::new(word)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(word);
        if !matches!(executable, "sh" | "bash" | "dash" | "zsh" | "ksh") {
            continue;
        }
        let Some(option) = words.get(index + 1) else {
            continue;
        };
        if !option.starts_with('-') || !option[1..].contains('c') {
            continue;
        }
        if let Some(script) = words.get(index + 2) {
            scripts.push(script.as_str());
        }
    }
    scripts
}

impl Default for AgentRunOptions {
    fn default() -> Self {
        Self::with_allowed_write_paths(Vec::new())
    }
}

impl AgentRunOptions {
    pub fn with_allowed_write_paths(paths: Vec<String>) -> Self {
        Self {
            allowed_write_paths: paths,
            allowed_shell_prefixes: Vec::new(),
            artifact_requirements: Vec::new(),
            block_shell_file_mutation: false,
            arrangement_mode: false,
            abort_token: None,
            context_mode: SubagentContextMode::default(),
            context_turns: 2,
            worktree_path: None,
            persona_name: None,
            runtime_selection: None,
            tool_allowlist: None,
            review_vote_channel: None,
            orchestrate_work_id: None,
            critic_max_cycles: 3,
            critic_max_infrastructure_retries: 2,
            delivery: None,
            delivery_lease_timeout_seconds: 120,
            delivery_max_attempts: 8,
        }
    }

    pub fn has_write_scope(&self) -> bool {
        !self.allowed_write_paths.is_empty()
    }

    pub fn with_artifact_requirements(
        mut self,
        requirements: Vec<kcoder_state::ArtifactRequirement>,
    ) -> Self {
        self.artifact_requirements = requirements;
        self
    }

    /// The persisted task owns declaration identity, including an empty declaration set.
    pub fn restore_artifact_requirements(
        &mut self,
        task: &kcoder_state::Task,
    ) -> Result<(), AgentError> {
        kcoder_state::validate_artifact_requirements(&self.artifact_requirements)
            .map_err(AgentError::Execution)?;
        kcoder_state::validate_artifact_requirements(&task.artifact_requirements)
            .map_err(AgentError::Execution)?;
        if !self.artifact_requirements.is_empty()
            && self.artifact_requirements != task.artifact_requirements
        {
            return Err(AgentError::Execution(
                "artifact_requirements conflict with persisted task declarations".into(),
            ));
        }
        self.artifact_requirements = task.artifact_requirements.clone();
        Ok(())
    }

    pub fn with_allowed_shell_prefixes(mut self, prefixes: Vec<String>) -> Self {
        self.allowed_shell_prefixes = prefixes;
        self
    }

    pub fn with_block_shell_file_mutation(mut self, enabled: bool) -> Self {
        self.block_shell_file_mutation = enabled;
        self
    }

    pub fn with_arrangement_mode(mut self, enabled: bool) -> Self {
        self.arrangement_mode = enabled;
        self
    }

    pub fn with_abort_token(mut self, token: CancellationToken) -> Self {
        self.abort_token = Some(token);
        self
    }

    pub fn with_context_inheritance(mut self, mode: SubagentContextMode, turns: usize) -> Self {
        self.context_mode = mode;
        self.context_turns = turns.max(1);
        self
    }

    pub fn with_worktree_path(mut self, path: Option<std::path::PathBuf>) -> Self {
        self.worktree_path = path;
        self
    }

    pub fn with_persona(mut self, persona: AgentPersonaOptions) -> Self {
        self.persona_name = Some(persona.name);
        self.runtime_selection = Some(persona.runtime);
        self.tool_allowlist = persona.tool_allowlist;
        self.review_vote_channel = persona.review_vote_channel;
        self.orchestrate_work_id = Some(persona.work_id);
        self.critic_max_cycles = persona.critic_max_cycles;
        self.critic_max_infrastructure_retries = persona.critic_max_infrastructure_retries;
        self
    }

    pub fn with_delivery_policy(mut self, lease_timeout_seconds: u64, max_attempts: u32) -> Self {
        self.delivery_lease_timeout_seconds = lease_timeout_seconds.clamp(30, 3600);
        self.delivery_max_attempts = max_attempts.clamp(1, 64);
        self
    }

    pub fn with_delivery(mut self, message_id: String, lease_id: String) -> Self {
        self.delivery = Some(AgentDeliveryContext {
            message_id,
            lease_id,
        });
        self
    }
}

/// Trait for running a sub-agent from within a tool.
#[async_trait]
pub trait AgentRunner: Send + Sync {
    /// Run a sub-agent with the given prompt and max turns, returning plain text
    /// output.
    async fn run_agent(&self, prompt: String, max_turns: usize) -> Result<String, AgentError>;

    /// Run a role-specialized sub-agent. Implementations that do not support
    /// role-specific tool filtering can fall back to the generic runner.
    async fn run_agent_with_kind(
        &self,
        prompt: String,
        max_turns: usize,
        _agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        self.run_agent(prompt, max_turns).await
    }

    /// Run a role-specific sub-agent with an optional independent runtime.
    /// Implementations without runtime selection fall back to `run_agent_with_kind`
    /// and continue using the parent runtime.
    async fn run_agent_with_kind_and_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        runtime: Option<AgentRuntimeSelection>,
    ) -> Result<String, AgentError> {
        let _ = runtime;
        self.run_agent_with_kind(prompt, max_turns, agent_kind)
            .await
    }

    /// Run an independent Goal Pro verifier and return the actual tool trace captured by the engine.
    /// Older implementations explicitly return no trace, causing strict completion gates to fail closed.
    async fn run_verifier_with_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        runtime: Option<AgentRuntimeSelection>,
        options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        let _ = options;
        self.run_agent_with_kind_and_runtime(prompt, max_turns, AgentKind::Verifier, runtime)
            .await
            .map(AgentRunResult::untraced)
    }

    /// Run the first turn of a resumable sub-agent session with a stable
    /// public agent id.
    async fn run_agent_session_with_kind(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        let _ = agent_id;
        self.run_agent_with_kind(prompt, max_turns, agent_kind)
            .await
    }

    async fn run_agent_session_with_options(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        let _ = options;
        self.run_agent_session_with_kind(agent_id, prompt, max_turns, agent_kind)
            .await
    }

    /// Continue an existing sub-agent session with a new user message.
    async fn send_message_to_agent_with_kind(
        &self,
        agent_id: String,
        message: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        let _ = (agent_id, message, max_turns, agent_kind);
        Err(AgentError::Execution(
            "agent runner does not support SendMessage".to_string(),
        ))
    }

    async fn send_message_to_agent_with_options(
        &self,
        agent_id: String,
        message: String,
        max_turns: usize,
        agent_kind: AgentKind,
        options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        let _ = options;
        self.send_message_to_agent_with_kind(agent_id, message, max_turns, agent_kind)
            .await
    }
}

/// Failure modes for [`BackgroundJobSpawner::spawn`].
#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("background task admission is closed for shutdown")]
    AdmissionClosed,
    /// The number of in-flight jobs has hit the configured cap. The caller
    /// should back off (e.g. by waiting for one of the running jobs to finish)
    /// and retry.
    #[error(
        "too many concurrent sub-agents ({running} running, limit {limit}); \
         wait for one of the existing sub-agents to finish before spawning more"
    )]
    TooManyConcurrent { running: usize, limit: usize },
    #[error("background task id {id} already exists")]
    AlreadyExists { id: String },
    #[error("sub-agent {id} is already running")]
    AlreadyRunning { id: String },
    #[error("sub-agent {id} not found")]
    NotFound { id: String },
    #[error("task {id} is not a sub-agent")]
    NotSubagent { id: String },
}

/// Trait for spawning delegated background work from within a tool.
pub trait BackgroundJobSpawner: Send + Sync {
    /// Spawn a background job described by `description` and return its ID.
    /// The optional `max_concurrent` cap is enforced best-effort by
    /// implementations that support generic background job caps; pass `None`
    /// to disable the check.
    fn spawn(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError>;

    /// Spawn work with a synchronous cancellation hook. Implementations should
    /// invoke the hook before dropping or aborting the work future so external
    /// resources (notably process groups) can begin orderly cleanup.
    fn spawn_cancellable(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = cancel;
        self.spawn(description, work, max_concurrent)
    }

    /// Register ordinary tool work as a foreground-managed task. The task is
    /// visible to the common task control plane immediately, but asynchronous
    /// delivery remains disabled until `promote_to_background` is called.
    fn spawn_foreground(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn(description, work, max_concurrent)
    }

    /// Foreground-managed variant for tools that own an external resource and
    /// must run a cancellation hook before their future is dropped.
    fn spawn_cancellable_foreground(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_cancellable(description, work, cancel, max_concurrent)
    }

    /// Spawn a sub-agent background job. Implementations can use the
    /// `max_concurrent` value to count only sub-agent jobs, leaving ordinary
    /// background commands outside the sub-agent cap.
    fn spawn_subagent(
        &self,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn(description, work, max_concurrent)
    }

    /// Spawn a sub-agent job using an already-known public agent id.
    fn spawn_subagent_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = id;
        self.spawn_subagent(description, work, max_concurrent)
    }

    /// Spawn a sub-agent whose caller-owned cancellation callback is invoked
    /// before any hard task abort.
    fn spawn_cancellable_subagent_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = cancel;
        self.spawn_subagent_with_id(id, description, work, max_concurrent)
    }

    /// Spawn a script-driven workflow using a caller-provided stable run ID.
    fn spawn_workflow_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = id;
        self.spawn(description, work, max_concurrent)
    }

    fn spawn_workflow_cancellable_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = cancel;
        self.spawn_workflow_with_id(id, description, work, max_concurrent)
    }

    /// Resume a previously terminal workflow using the same stable run ID.
    fn respawn_workflow(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_workflow_with_id(id, description, work, max_concurrent)
    }

    fn respawn_workflow_cancellable(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = cancel;
        self.respawn_workflow(id, description, work, max_concurrent)
    }

    /// Spawn a sub-agent whose completion is returned inline by the calling
    /// tool. Implementations should suppress asynchronous parent notification
    /// before the work starts so fast completions cannot race the foreground
    /// waiter.
    fn spawn_subagent_foreground_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_subagent_with_id(id, description, work, max_concurrent)
    }

    fn spawn_cancellable_subagent_foreground_with_id(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = cancel;
        self.spawn_subagent_foreground_with_id(id, description, work, max_concurrent)
    }

    /// Re-open an existing sub-agent id for another background turn.
    fn respawn_subagent(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = id;
        self.spawn_subagent(description, work, max_concurrent)
    }

    fn respawn_cancellable_subagent(
        &self,
        id: String,
        description: String,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let _ = cancel;
        self.respawn_subagent(id, description, work, max_concurrent)
    }

    /// Subscribe to background job lifecycle events.
    fn subscribe(&self) -> tokio::sync::broadcast::Receiver<background::BackgroundJobEvent>;

    /// Abort a running background job by ID. Returns true if the job existed
    /// and was running.
    fn abort(&self, id: &str) -> bool;

    /// Cancel and wait until bounded cleanup has completed. Implementations
    /// without cooperative lifecycle support retain the legacy immediate abort.
    fn abort_and_wait<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { self.abort(id) })
    }

    /// Change a foreground-delivered managed job into an asynchronously
    /// delivered background job without restarting it or changing its ID.
    fn promote_to_background(&self, id: &str) -> Result<(), SpawnError> {
        Err(SpawnError::NotFound { id: id.to_string() })
    }

    /// Associate a sub-agent's stable public ID with the model tool call that
    /// spawned it. Presentation clients use this metadata only; it does not
    /// affect scheduling or model-visible output.
    fn associate_subagent_tool_call(
        &self,
        _id: &str,
        _tool_call_id: &str,
        _run_in_background: bool,
    ) -> Result<(), SpawnError> {
        Ok(())
    }

    /// Complete inline delivery. Implementations may evict ephemeral
    /// foreground tool records while retaining durable agent records.
    fn finish_foreground_delivery(&self, _id: &str) {}

    /// Return whether this process still owns a live future for the job.
    fn is_running(&self, _id: &str) -> bool {
        false
    }
}

fn spawn_error_to_tool_error(error: SpawnError) -> ToolError {
    match error {
        SpawnError::TooManyConcurrent { running, limit } => ToolError::Execution(format!(
            "{error} (currently {running} running, cap {limit})"
        )),
        SpawnError::AdmissionClosed
        | SpawnError::AlreadyExists { .. }
        | SpawnError::AlreadyRunning { .. }
        | SpawnError::NotFound { .. }
        | SpawnError::NotSubagent { .. } => ToolError::Execution(error.to_string()),
    }
}

/// Result returned by a lifecycle hook emitter.
#[derive(Debug, Clone, Default)]
pub struct LifecycleHookResult {
    pub messages: Vec<(String, bool)>,
    pub blocking_error: Option<String>,
    pub prevent_continuation: bool,
    pub stop_reason: Option<String>,
}

impl LifecycleHookResult {
    pub fn should_block(&self) -> bool {
        self.blocking_error.is_some() || self.prevent_continuation
    }

    pub fn block_reason(&self) -> String {
        self.blocking_error
            .clone()
            .or_else(|| self.stop_reason.clone())
            .unwrap_or_else(|| "lifecycle hook prevented continuation".to_string())
    }
}

/// Runtime bridge for tools that need to emit non-tool lifecycle events.
///
/// The tools crate intentionally does not depend on `kcoder_hooks`; the engine
/// provides an implementation that maps these string event names to concrete
/// hook events.
#[async_trait]
pub trait LifecycleHookEmitter: Send + Sync {
    async fn emit(&self, event: &str, query: String, data: Value) -> LifecycleHookResult;
}

/// Read-mostly data exposed to tools without capability handles.
pub struct ToolContextView<'a> {
    state: &'a AppState,
    max_output_bytes: usize,
    output_head_bytes: usize,
    output_tail_bytes: usize,
}

impl<'a> ToolContextView<'a> {
    pub fn cwd(&self) -> PathBuf {
        self.state.cwd()
    }

    pub fn session_id(&self) -> String {
        self.state.session_id()
    }

    pub fn output_limits(&self) -> (usize, usize, usize) {
        (
            self.max_output_bytes,
            self.output_head_bytes,
            self.output_tail_bytes,
        )
    }
}

/// Runtime capability handles supplied by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkillGuardPolicy {
    pub enabled: bool,
    pub block_high_risk: bool,
    pub block_medium_risk_for_community: bool,
}

impl Default for SkillGuardPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            block_high_risk: true,
            block_medium_risk_for_community: true,
        }
    }
}

/// Runtime capability handles supplied by the engine.
#[derive(Clone)]
pub struct ToolCapabilities {
    pub memory_manager: Option<Arc<MemoryManager>>,
    pub memory_store: Option<Arc<MemoryStore>>,
    pub skill_registry: Option<Arc<RwLock<SkillRegistry>>>,
    pub active_skills: Option<Arc<RwLock<Vec<String>>>>,
    /// Skill names hidden and unavailable in the current runtime mode.
    pub blocked_skill_names: Vec<String>,
    pub external_skill_dirs: Vec<PathBuf>,
    pub trust_external_skills: bool,
    pub skill_guard_policy: SkillGuardPolicy,
    pub auto_lessons_learned: bool,
    /// Whether passive skill discovery/activation may persist telemetry in the
    /// current project. Client-hosted engines disable this so read-only use of
    /// external or user skills cannot materialize `.kcoder` in a remote workspace.
    pub record_project_skill_telemetry: bool,
    pub abort_token: Option<CancellationToken>,
    pub agent_runner: Option<Arc<dyn AgentRunner>>,
    pub background_job_manager: Option<Arc<dyn BackgroundJobSpawner>>,
    pub user_questioner: Option<Arc<dyn UserQuestioner>>,
    pub lifecycle_hooks: Option<Arc<dyn LifecycleHookEmitter>>,
    pub sandbox: Option<Arc<Sandbox>>,
    pub max_concurrent_subagents: Option<usize>,
    /// Default maximum internal turns for sub-agents.
    pub default_subagent_max_turns: usize,
    /// Logical depth of the engine invoking the tool. Main conversations use
    /// 0; direct children use 1. Agent tools reject a child depth above the
    /// configured maximum before registering or starting work.
    pub agent_depth: u32,
    pub allowed_write_paths: Vec<String>,
    /// Shell command prefixes explicitly authorized for the current sub-agent.
    pub allowed_shell_prefixes: Vec<String>,
    pub block_shell_file_mutation: bool,
    /// Forbid shell-based dependency installation, removal, or updates; enabled by default for Goal Pro verifiers.
    pub block_dependency_mutation: bool,
    /// Verifier-specific home, cache, and temporary-directory roots.
    pub shell_isolation_root: Option<PathBuf>,
    /// Minimum test scope enforced before a Goal Pro verifier executes a shell command.
    pub verifier_minimum_test_scope: Option<GoalProTestScope>,
    /// Whether Goal Pro verifier test commands must preserve original exit codes.
    pub verifier_require_raw_exit_code: bool,
    /// Whether a Goal Pro verifier requires a behavioral difference between candidate and baseline.
    pub verifier_require_behavior_delta: bool,
    /// Engine-created pristine baseline used for exact failure comparison.
    pub verifier_baseline_root: Option<PathBuf>,
    /// Vote channel for a Goal Pro verifier session; always None for non-verifier sessions.
    pub verifier_vote_channel: Option<VerifierVoteChannel>,
    /// Bound vote channel for an orchestration critic session; always None for other sessions.
    pub review_vote_channel: Option<ReviewVoteChannel>,
    pub arrangement_mode: bool,
    /// Provider/model identity used to create or continue resumable sub-agent
    /// transcripts. Values contain identifiers only, never credentials.
    pub runtime_provider: Option<String>,
    pub runtime_model: Option<String>,
    pub tool_limits: ToolLimitsSettings,
}

impl fmt::Debug for ToolCapabilities {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolCapabilities")
            .field("memory_manager", &self.memory_manager.is_some())
            .field("memory_store", &self.memory_store.is_some())
            .field("skill_registry", &self.skill_registry.is_some())
            .field("active_skills", &self.active_skills.is_some())
            .field("blocked_skill_names", &self.blocked_skill_names)
            .field("external_skill_dirs", &self.external_skill_dirs)
            .field("trust_external_skills", &self.trust_external_skills)
            .field("skill_guard_policy", &self.skill_guard_policy)
            .field("auto_lessons_learned", &self.auto_lessons_learned)
            .field(
                "record_project_skill_telemetry",
                &self.record_project_skill_telemetry,
            )
            .field("abort_token", &self.abort_token.is_some())
            .field("agent_runner", &self.agent_runner.is_some())
            .field(
                "background_job_manager",
                &self.background_job_manager.is_some(),
            )
            .field("user_questioner", &self.user_questioner.is_some())
            .field("lifecycle_hooks", &self.lifecycle_hooks.is_some())
            .field("sandbox", &self.sandbox.is_some())
            .field("max_concurrent_subagents", &self.max_concurrent_subagents)
            .field(
                "default_subagent_max_turns",
                &self.default_subagent_max_turns,
            )
            .field("agent_depth", &self.agent_depth)
            .field("allowed_write_paths", &self.allowed_write_paths)
            .field("allowed_shell_prefixes", &self.allowed_shell_prefixes)
            .field("block_shell_file_mutation", &self.block_shell_file_mutation)
            .field("block_dependency_mutation", &self.block_dependency_mutation)
            .field("shell_isolation_root", &self.shell_isolation_root)
            .field(
                "verifier_minimum_test_scope",
                &self.verifier_minimum_test_scope,
            )
            .field(
                "verifier_require_raw_exit_code",
                &self.verifier_require_raw_exit_code,
            )
            .field(
                "verifier_require_behavior_delta",
                &self.verifier_require_behavior_delta,
            )
            .field("verifier_baseline_root", &self.verifier_baseline_root)
            .field(
                "verifier_vote_channel",
                &self.verifier_vote_channel.is_some(),
            )
            .field("review_vote_channel", &self.review_vote_channel.is_some())
            .field("arrangement_mode", &self.arrangement_mode)
            .field("runtime_provider", &self.runtime_provider)
            .field("runtime_model", &self.runtime_model)
            .field("tool_limits", &self.tool_limits)
            .finish()
    }
}

/// Context passed to every tool invocation.
type RuntimeSettingsObserver = Arc<dyn Fn(&kcoder_config::Settings) + Send + Sync + 'static>;

#[derive(Clone)]
pub struct ToolContext {
    pub state: AppState,
    /// File-edit surface pinned when the owning engine was created. The active
    /// session cannot switch surfaces mid-run; the Config tool reports this
    /// value and rejects in-session `tools.file_edit_tool` changes.
    pub file_edit_surface: kcoder_config::FileEditSurface,
    /// Merged runtime settings for the current engine. Config tools may read and
    /// update only this snapshot and must not infer configuration sources from process home.
    pub(crate) runtime_settings: Option<Arc<RwLock<kcoder_config::Settings>>>,
    /// User-settings file explicitly authorized by the host; None disables configuration persistence.
    pub(crate) settings_persistence_path: Option<PathBuf>,
    /// Ordering gate shared by all settings transactions in one engine. Config tools
    /// must read the latest runtime settings while holding the lock so concurrent calls
    /// cannot overwrite each other with stale snapshots.
    pub(crate) settings_persistence_order: Option<Arc<tokio::sync::Mutex<()>>>,
    /// Host callback after a configuration commit, used to refresh runtime components derived from Settings.
    pub(crate) runtime_settings_observer: Option<RuntimeSettingsObserver>,
    pub memory_manager: Option<Arc<MemoryManager>>,
    pub memory_store: Option<Arc<MemoryStore>>,
    pub skill_registry: Option<Arc<RwLock<SkillRegistry>>>,
    /// Monotonic generation for registry snapshots in the current engine.
    pub skill_registry_generation: Option<Arc<AtomicU64>>,
    pub active_skills: Option<Arc<RwLock<Vec<String>>>>,
    /// Skill names hidden and unavailable in the current runtime mode.
    pub blocked_skill_names: Vec<String>,
    /// External read-only/team skill directories that must be included when a
    /// mutating skill tool refreshes the runtime registry.
    pub external_skill_dirs: Vec<PathBuf>,
    /// Whether hub-installed and external-directory skills may activate without
    /// explicit user confirmation.
    pub trust_external_skills: bool,
    /// Runtime guard policy for community/hub skill installation.
    pub skill_guard_policy: SkillGuardPolicy,
    /// Whether successful SpecArchive calls should generate lessons-learned skills.
    pub auto_lessons_learned: bool,
    /// Persist passive skill usage/provenance metadata inside the project.
    /// Explicit project mutations remain governed by their own tool action.
    pub record_project_skill_telemetry: bool,
    pub abort_token: Option<CancellationToken>,
    /// Fires when the user asks wait-style tools (Sleep, wait) to collapse their
    /// remaining wait to a short grace period without cancelling the turn.
    pub shorten_signal: Option<Arc<tokio::sync::Notify>>,
    pub agent_runner: Option<Arc<dyn AgentRunner>>,
    pub background_job_manager: Option<Arc<dyn BackgroundJobSpawner>>,
    pub user_questioner: Option<Arc<dyn UserQuestioner>>,
    pub lifecycle_hooks: Option<Arc<dyn LifecycleHookEmitter>>,
    pub sandbox: Option<Arc<Sandbox>>,
    /// Per-text-block byte cap. 0 means "no cap" (legacy).
    pub max_output_bytes: usize,
    /// Head bytes preserved when truncating.
    pub output_head_bytes: usize,
    /// Tail bytes preserved when truncating.
    pub output_tail_bytes: usize,
    /// Hard cap on the number of background sub-agents the engine may
    /// run concurrently. `None` means no cap is enforced. The
    /// `spawn_agent` tool threads this through to the background job
    /// manager so a runaway fan-out is rejected before it starts.
    pub max_concurrent_subagents: Option<usize>,
    /// Default maximum internal turns for sub-agents.
    pub default_subagent_max_turns: usize,
    /// Logical depth of this tool context in the delegation tree.
    pub agent_depth: u32,
    /// Optional Arrangement write scope. When non-empty, mutating file tools
    /// must target one of these paths.
    pub allowed_write_paths: Vec<String>,
    /// Shell command prefixes explicitly authorized for the current sub-agent.
    pub allowed_shell_prefixes: Vec<String>,
    /// When true, shell commands that appear to mutate files are blocked.
    pub block_shell_file_mutation: bool,
    /// When true, shell dependency installation/removal/update commands are blocked.
    pub block_dependency_mutation: bool,
    /// Optional private root used to isolate verifier process state.
    pub shell_isolation_root: Option<PathBuf>,
    /// Minimum test scope enforced before a Goal Pro verifier executes shell commands.
    pub verifier_minimum_test_scope: Option<GoalProTestScope>,
    /// Whether Goal Pro verifier test commands must preserve original exit codes.
    pub verifier_require_raw_exit_code: bool,
    /// Whether a Goal Pro verifier requires a behavioral difference between candidate and baseline.
    pub verifier_require_behavior_delta: bool,
    /// Engine-created pristine baseline used for exact failure comparison.
    pub verifier_baseline_root: Option<PathBuf>,
    /// Vote channel for a Goal Pro verifier session; always None for non-verifier
    /// sessions, allowing VerifierVote to reject verdicts in regular sessions.
    pub verifier_vote_channel: Option<VerifierVoteChannel>,
    /// Bound vote channel for an orchestration critic session; always None for other sessions.
    pub review_vote_channel: Option<ReviewVoteChannel>,
    /// True when this context belongs to an Arrangement turn.
    pub arrangement_mode: bool,
    /// Live provider/model identifiers for resumable-agent compatibility
    /// checks. These fields never contain endpoint credentials or API keys.
    pub runtime_provider: Option<String>,
    pub runtime_model: Option<String>,
    /// Runtime limits configured for named tools.
    pub tool_limits: ToolLimitsSettings,
    /// Startup-built, validated shell environment snapshot. Bash calls load it
    /// when ready and otherwise retain their existing isolated environment.
    pub shell_environment_snapshot: Option<crate::ShellEnvironmentSnapshot>,
    /// Persistent scheduler facade used by cron_create/delete/list.
    pub cron_scheduler: Option<Arc<crate::CronScheduler>>,
    /// Provider tool-use ID for this invocation. It is presentation metadata,
    /// never part of the tool's model-visible schema.
    pub tool_call_id: Option<String>,
    /// Explicit skill-mutation identity. Background reviewers and curators must
    /// override the default foreground identity so transaction commit records do
    /// not need to infer the write source afterward.
    pub skill_mutation_actor: Option<SkillMutationActor>,
}

impl fmt::Debug for ToolContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ToolContext")
            .field("state", &self.state)
            .field("runtime_settings", &self.runtime_settings.is_some())
            .field("settings_persistence_path", &self.settings_persistence_path)
            .field(
                "settings_persistence_order",
                &self.settings_persistence_order.is_some(),
            )
            .field(
                "runtime_settings_observer",
                &self.runtime_settings_observer.is_some(),
            )
            .field("capabilities", &self.capabilities())
            .field("max_output_bytes", &self.max_output_bytes)
            .field("output_head_bytes", &self.output_head_bytes)
            .field("output_tail_bytes", &self.output_tail_bytes)
            .field("allowed_write_paths", &self.allowed_write_paths)
            .field("allowed_shell_prefixes", &self.allowed_shell_prefixes)
            .field("agent_depth", &self.agent_depth)
            .field("block_shell_file_mutation", &self.block_shell_file_mutation)
            .field("block_dependency_mutation", &self.block_dependency_mutation)
            .field("shell_isolation_root", &self.shell_isolation_root)
            .field(
                "verifier_minimum_test_scope",
                &self.verifier_minimum_test_scope,
            )
            .field(
                "verifier_require_raw_exit_code",
                &self.verifier_require_raw_exit_code,
            )
            .field(
                "verifier_require_behavior_delta",
                &self.verifier_require_behavior_delta,
            )
            .field("verifier_baseline_root", &self.verifier_baseline_root)
            .field(
                "verifier_vote_channel",
                &self.verifier_vote_channel.is_some(),
            )
            .field("review_vote_channel", &self.review_vote_channel.is_some())
            .field("arrangement_mode", &self.arrangement_mode)
            .field("runtime_provider", &self.runtime_provider)
            .field("runtime_model", &self.runtime_model)
            .field("tool_limits", &self.tool_limits)
            .field(
                "shell_environment_snapshot_ready",
                &self
                    .shell_environment_snapshot
                    .as_ref()
                    .and_then(crate::ShellEnvironmentSnapshot::ready_path)
                    .is_some(),
            )
            .field("cron_scheduler", &self.cron_scheduler.is_some())
            .field("tool_call_id", &self.tool_call_id)
            .finish()
    }
}

impl ToolContext {
    pub fn new(state: AppState) -> Self {
        Self {
            state,
            file_edit_surface: kcoder_config::FileEditSurface::default(),
            runtime_settings: None,
            settings_persistence_path: None,
            settings_persistence_order: None,
            runtime_settings_observer: None,
            memory_manager: None,
            memory_store: None,
            skill_registry: None,
            skill_registry_generation: None,
            active_skills: None,
            blocked_skill_names: Vec::new(),
            external_skill_dirs: Vec::new(),
            trust_external_skills: false,
            skill_guard_policy: SkillGuardPolicy::default(),
            auto_lessons_learned: false,
            record_project_skill_telemetry: true,
            abort_token: None,
            shorten_signal: None,
            agent_runner: None,
            background_job_manager: None,
            user_questioner: Some(Arc::new(DenyAllUserQuestioner)),
            lifecycle_hooks: None,
            sandbox: None,
            max_output_bytes: 100 * 1024,
            output_head_bytes: 60 * 1024,
            output_tail_bytes: 40 * 1024,
            max_concurrent_subagents: None,
            default_subagent_max_turns: kcoder_config::DEFAULT_SUBAGENT_MAX_TURNS,
            agent_depth: 0,
            allowed_write_paths: Vec::new(),
            allowed_shell_prefixes: Vec::new(),
            block_shell_file_mutation: false,
            block_dependency_mutation: false,
            shell_isolation_root: None,
            verifier_minimum_test_scope: None,
            verifier_require_raw_exit_code: false,
            verifier_require_behavior_delta: false,
            verifier_baseline_root: None,
            verifier_vote_channel: None,
            review_vote_channel: None,
            arrangement_mode: false,
            runtime_provider: None,
            runtime_model: None,
            tool_limits: ToolLimitsSettings::default(),
            shell_environment_snapshot: None,
            cron_scheduler: None,
            tool_call_id: None,
            skill_mutation_actor: None,
        }
    }

    pub fn view(&self) -> ToolContextView<'_> {
        ToolContextView {
            state: &self.state,
            max_output_bytes: self.max_output_bytes,
            output_head_bytes: self.output_head_bytes,
            output_tail_bytes: self.output_tail_bytes,
        }
    }

    pub fn with_runtime_settings(mut self, settings: Arc<RwLock<kcoder_config::Settings>>) -> Self {
        self.runtime_settings = Some(settings);
        self
    }

    /// Pin the file-edit surface captured when the owning engine was created.
    pub fn with_file_edit_surface(mut self, surface: kcoder_config::FileEditSurface) -> Self {
        self.file_edit_surface = surface;
        self
    }

    pub fn with_settings_persistence_path(mut self, path: Option<PathBuf>) -> Self {
        self.settings_persistence_path = path;
        self
    }

    pub fn with_settings_persistence_order(mut self, order: Arc<tokio::sync::Mutex<()>>) -> Self {
        self.settings_persistence_order = Some(order);
        self
    }

    pub fn with_runtime_settings_observer(mut self, observer: RuntimeSettingsObserver) -> Self {
        self.runtime_settings_observer = Some(observer);
        self
    }

    pub fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities {
            memory_manager: self.memory_manager.clone(),
            memory_store: self.memory_store.clone(),
            skill_registry: self.skill_registry.clone(),
            active_skills: self.active_skills.clone(),
            blocked_skill_names: self.blocked_skill_names.clone(),
            external_skill_dirs: self.external_skill_dirs.clone(),
            trust_external_skills: self.trust_external_skills,
            skill_guard_policy: self.skill_guard_policy,
            auto_lessons_learned: self.auto_lessons_learned,
            record_project_skill_telemetry: self.record_project_skill_telemetry,
            abort_token: self.abort_token.clone(),
            agent_runner: self.agent_runner.clone(),
            background_job_manager: self.background_job_manager.clone(),
            user_questioner: self.user_questioner.clone(),
            lifecycle_hooks: self.lifecycle_hooks.clone(),
            sandbox: self.sandbox.clone(),
            max_concurrent_subagents: self.max_concurrent_subagents,
            default_subagent_max_turns: self.default_subagent_max_turns,
            agent_depth: self.agent_depth,
            allowed_write_paths: self.allowed_write_paths.clone(),
            allowed_shell_prefixes: self.allowed_shell_prefixes.clone(),
            block_shell_file_mutation: self.block_shell_file_mutation,
            block_dependency_mutation: self.block_dependency_mutation,
            shell_isolation_root: self.shell_isolation_root.clone(),
            verifier_minimum_test_scope: self.verifier_minimum_test_scope,
            verifier_require_raw_exit_code: self.verifier_require_raw_exit_code,
            verifier_require_behavior_delta: self.verifier_require_behavior_delta,
            verifier_baseline_root: self.verifier_baseline_root.clone(),
            verifier_vote_channel: self.verifier_vote_channel.clone(),
            review_vote_channel: self.review_vote_channel.clone(),
            arrangement_mode: self.arrangement_mode,
            runtime_provider: self.runtime_provider.clone(),
            runtime_model: self.runtime_model.clone(),
            tool_limits: self.tool_limits.clone(),
        }
    }

    pub fn with_memory_store(mut self, store: Arc<MemoryStore>) -> Self {
        self.memory_store = Some(store);
        self
    }

    pub fn with_shell_environment_snapshot(
        mut self,
        snapshot: crate::ShellEnvironmentSnapshot,
    ) -> Self {
        self.shell_environment_snapshot = Some(snapshot);
        self
    }

    pub fn with_cron_scheduler(mut self, scheduler: Arc<crate::CronScheduler>) -> Self {
        self.cron_scheduler = Some(scheduler);
        self
    }

    pub fn with_memory_manager(mut self, manager: Arc<MemoryManager>) -> Self {
        self.memory_manager = Some(manager);
        self
    }

    pub fn with_skill_registry(mut self, registry: Arc<RwLock<SkillRegistry>>) -> Self {
        self.skill_registry = Some(registry);
        self
    }

    pub fn with_active_skills(mut self, skills: Arc<RwLock<Vec<String>>>) -> Self {
        self.active_skills = Some(skills);
        self
    }

    /// Hide and reject the named skills for this tool context. Runtime modes
    /// use this to keep unavailable protocols out of both discovery and
    /// explicit Skill activation.
    pub fn with_blocked_skill_names(mut self, names: Vec<String>) -> Self {
        self.blocked_skill_names = names;
        self
    }

    pub fn is_skill_blocked(&self, name: &str) -> bool {
        let canonical = name.rsplit(':').next().unwrap_or(name);
        self.blocked_skill_names.iter().any(|blocked| {
            blocked == name || blocked.rsplit(':').next().unwrap_or(blocked) == canonical
        })
    }

    pub fn with_external_skill_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.external_skill_dirs = dirs;
        self
    }

    pub fn with_trust_external_skills(mut self, trusted: bool) -> Self {
        self.trust_external_skills = trusted;
        self
    }

    pub fn with_skill_guard_policy(mut self, policy: SkillGuardPolicy) -> Self {
        self.skill_guard_policy = policy;
        self
    }

    pub fn with_auto_lessons_learned(mut self, enabled: bool) -> Self {
        self.auto_lessons_learned = enabled;
        self
    }

    pub fn with_project_skill_telemetry(mut self, enabled: bool) -> Self {
        self.record_project_skill_telemetry = enabled;
        self
    }

    /// Reload the shared skill registry using the startup layer order: built-in
    /// skills, project skills, configured external directories, then user skills.
    pub fn reload_skill_registry(&self) -> Result<bool, ToolError> {
        let Some(registry) = self.skill_registry.as_ref() else {
            return Ok(false);
        };
        let refreshed = SkillRegistry::load_with_external_dirs(
            &self.state.cwd(),
            self.external_skill_dirs.iter(),
        )
        .map_err(|e| ToolError::Execution(format!("failed to reload skill registry: {e}")))?;
        if self.record_project_skill_telemetry {
            record_loaded_skill_metadata(
                &self.state.cwd(),
                &self.external_skill_dirs,
                refreshed.iter_all(),
            );
        }
        *registry.write().unwrap() = refreshed;
        if let Some(generation) = &self.skill_registry_generation {
            generation.fetch_add(1, Ordering::SeqCst);
        }
        Ok(true)
    }

    pub fn with_skill_registry_generation(mut self, generation: Arc<AtomicU64>) -> Self {
        self.skill_registry_generation = Some(generation);
        self
    }

    pub fn with_abort_token(mut self, token: CancellationToken) -> Self {
        self.abort_token = Some(token);
        self
    }

    pub fn with_shorten_signal(mut self, signal: Arc<tokio::sync::Notify>) -> Self {
        self.shorten_signal = Some(signal);
        self
    }

    pub fn with_agent_runner(mut self, runner: Arc<dyn AgentRunner>) -> Self {
        self.agent_runner = Some(runner);
        self
    }

    pub fn with_agent_runtime_identity(
        mut self,
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        self.runtime_provider = Some(provider.into());
        self.runtime_model = Some(model.into());
        self
    }

    pub fn with_background_job_manager(mut self, manager: Arc<dyn BackgroundJobSpawner>) -> Self {
        self.background_job_manager = Some(manager);
        self
    }

    pub fn with_tool_call_id(mut self, id: impl Into<String>) -> Self {
        self.tool_call_id = Some(id.into());
        self
    }

    pub fn with_skill_mutation_actor(mut self, actor: SkillMutationActor) -> Self {
        self.skill_mutation_actor = Some(actor);
        self
    }

    pub fn with_optional_skill_mutation_actor(mut self, actor: Option<SkillMutationActor>) -> Self {
        self.skill_mutation_actor = actor;
        self
    }

    pub fn with_user_questioner(mut self, questioner: Arc<dyn UserQuestioner>) -> Self {
        self.user_questioner = Some(questioner);
        self
    }

    pub fn with_lifecycle_hooks(mut self, emitter: Arc<dyn LifecycleHookEmitter>) -> Self {
        self.lifecycle_hooks = Some(emitter);
        self
    }

    pub fn with_sandbox(mut self, sandbox: Arc<Sandbox>) -> Self {
        self.sandbox = Some(sandbox);
        self
    }

    /// Override the truncation policy used by tools that opt in.
    /// Pass `0` to disable the limit (legacy unbounded behaviour).
    pub fn with_output_limits(
        mut self,
        max_bytes: usize,
        head_bytes: usize,
        tail_bytes: usize,
    ) -> Self {
        self.max_output_bytes = max_bytes;
        self.output_head_bytes = head_bytes;
        self.output_tail_bytes = tail_bytes;
        self
    }

    /// Set the maximum number of concurrent background sub-agents.
    /// `None` disables the check; `Some(0)` is treated the same as
    /// `None` by the engine (legacy unbounded behaviour).
    pub fn with_max_concurrent_subagents(mut self, cap: Option<usize>) -> Self {
        self.max_concurrent_subagents = cap;
        self
    }

    /// Set the default maximum internal turns for newly started or resumed sub-agents.
    pub fn with_default_subagent_max_turns(mut self, max_turns: usize) -> Self {
        self.default_subagent_max_turns = max_turns.clamp(
            kcoder_config::MIN_SUBAGENT_MAX_TURNS,
            kcoder_config::MAX_SUBAGENT_MAX_TURNS,
        );
        self
    }

    pub fn with_agent_depth(mut self, depth: u32) -> Self {
        self.agent_depth = depth;
        self
    }

    /// Restrict mutating file tools to the given paths. Relative paths are
    /// resolved against the session cwd. Empty disables this extra restriction.
    pub fn with_allowed_write_paths(mut self, paths: Vec<String>) -> Self {
        self.allowed_write_paths = paths;
        self
    }

    /// Inject shell command prefixes explicitly authorized by the parent orchestrator.
    pub fn with_allowed_shell_prefixes(mut self, prefixes: Vec<String>) -> Self {
        self.allowed_shell_prefixes = prefixes;
        self
    }

    pub fn with_block_shell_file_mutation(mut self, enabled: bool) -> Self {
        self.block_shell_file_mutation = enabled;
        self
    }

    pub fn with_block_dependency_mutation(mut self, enabled: bool) -> Self {
        self.block_dependency_mutation = enabled;
        self
    }

    pub fn with_shell_isolation_root(mut self, root: Option<PathBuf>) -> Self {
        self.shell_isolation_root = root;
        self
    }

    pub fn with_verifier_test_policy(
        mut self,
        minimum_scope: Option<GoalProTestScope>,
        require_raw_exit_code: bool,
    ) -> Self {
        self.verifier_minimum_test_scope = minimum_scope;
        self.verifier_require_raw_exit_code = require_raw_exit_code;
        self
    }

    pub fn with_verifier_behavior_delta(mut self, required: bool) -> Self {
        self.verifier_require_behavior_delta = required;
        self
    }

    pub fn with_verifier_baseline_root(mut self, root: Option<PathBuf>) -> Self {
        self.verifier_baseline_root = root;
        self
    }

    /// Inject the Goal Pro verifier vote channel; called only for verifier sessions.
    pub fn with_verifier_vote_channel(mut self, channel: Option<VerifierVoteChannel>) -> Self {
        self.verifier_vote_channel = channel;
        self
    }

    /// Inject the work/revision-bound vote channel for an orchestration critic.
    pub fn with_review_vote_channel(mut self, channel: Option<ReviewVoteChannel>) -> Self {
        self.review_vote_channel = channel;
        self
    }

    pub fn with_arrangement_mode(mut self, enabled: bool) -> Self {
        self.arrangement_mode = enabled;
        self
    }

    pub fn with_bash_foreground_budget_ms(mut self, budget_ms: u64) -> Self {
        self.tool_limits
            .foreground_budget_ms
            .tools
            .insert("bash".to_string(), budget_ms.max(1));
        self.tool_limits
            .foreground_budget_ms
            .tools
            .insert("PowerShell".to_string(), budget_ms.max(1));
        self
    }

    pub fn with_tool_limits(mut self, tool_limits: ToolLimitsSettings) -> Self {
        self.tool_limits = tool_limits;
        self
    }

    pub fn foreground_budget_ms_for(&self, tool_name: &str) -> u64 {
        self.tool_limits.foreground_budget_ms.for_tool(tool_name)
    }

    pub fn check_allowed_write_path(&self, path: &Path) -> Result<(), String> {
        check_allowed_write_path(&self.state.cwd(), &self.allowed_write_paths, path)
    }

    /// Return whether the explicit write domain covers the current platform's filesystem root.
    ///
    /// This supports the arrangement implementer's shell gate. Once the caller
    /// explicitly authorizes `/`, per-command inference about possible out-of-scope
    /// writes adds no protection and can block tasks that require an external executor
    /// such as `docker exec`. Read-only roles remain independently fail-closed through
    /// `block_shell_file_mutation`.
    pub fn allowed_write_scope_covers_filesystem_root(&self) -> bool {
        self.allowed_write_paths.iter().any(|allowed| {
            let resolved = resolve_against_cwd(Path::new(allowed), &self.state.cwd());
            policy_path(&resolved).is_ok_and(|path| path.parent().is_none())
        })
    }

    /// Truncate a single text string using the configured limits.
    /// Returns the (possibly truncated) text. Convenience for tool
    /// implementations that produce a single `ToolOutput::text(...)` result.
    /// When truncation drops content, the full text is spilled to the session
    /// tool-results directory and a `full output at: <path>` reference is
    /// appended so the model can recover it with `read`/`grep`.
    pub fn truncate(&self, text: &str) -> String {
        crate::truncate::truncate_and_spill(
            text,
            self.max_output_bytes,
            self.output_head_bytes,
            self.output_tail_bytes,
            &crate::truncate::spill_dir_for_state(&self.state),
        )
    }

    /// Returns true if the tool should abort its work.
    pub fn is_aborted(&self) -> bool {
        self.abort_token
            .as_ref()
            .map(CancellationToken::is_cancelled)
            .unwrap_or(false)
    }

    /// Wait until the tool's owning turn is cancelled. If this context has no
    /// cancellation token, this future remains pending.
    pub async fn cancelled(&self) {
        match self.abort_token.as_ref() {
            Some(token) => token.cancelled().await,
            None => std::future::pending::<()>().await,
        }
    }

    /// Wait until the user asks this wait-style tool to shorten its remaining
    /// wait to a short grace period. The signal is one-shot: only tools waiting
    /// at that moment wake up, while later waits start from a clean slate and
    /// run for their full requested duration. If this context has no signal,
    /// this future remains pending.
    pub async fn shortened(&self) {
        match self.shorten_signal.as_ref() {
            Some(signal) => signal.notified().await,
            None => std::future::pending::<()>().await,
        }
    }

    /// Spawn a generic background job and return its task ID, or an error if
    /// no manager is available or the session is aborted.
    pub fn spawn_background(
        &self,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn(description.into(), Box::pin(work), None)
            .map_err(spawn_error_to_tool_error)
    }

    /// Spawn a background job that owns an external resource requiring an
    /// explicit cancellation signal before the work future is dropped.
    pub fn spawn_cancellable_background(
        &self,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_cancellable(description.into(), Box::pin(work), cancel, None)
            .map_err(spawn_error_to_tool_error)
    }

    pub fn spawn_foreground(
        &self,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_foreground(description.into(), Box::pin(work), None)
            .map_err(spawn_error_to_tool_error)
    }

    pub fn spawn_cancellable_foreground(
        &self,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_cancellable_foreground(description.into(), Box::pin(work), cancel, None)
            .map_err(spawn_error_to_tool_error)
    }

    /// Spawn a sub-agent background job and enforce the configured sub-agent
    /// concurrency cap.
    pub fn spawn_subagent_background(
        &self,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_subagent(
                description.into(),
                Box::pin(work),
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    /// Spawn a sub-agent background job using a caller-provided public ID.
    pub fn spawn_subagent_background_with_id(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_subagent_with_id(
                id.into(),
                description.into(),
                Box::pin(work),
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    pub fn spawn_cancellable_subagent_background_with_id(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_cancellable_subagent_with_id(
                id.into(),
                description.into(),
                Box::pin(work),
                cancel,
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    /// Spawn a workflow background job with a stable public run ID.
    pub fn spawn_workflow_background_with_id(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_workflow_with_id(
                id.into(),
                description.into(),
                Box::pin(work),
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    pub fn spawn_cancellable_workflow_background_with_id(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_workflow_cancellable_with_id(
                id.into(),
                description.into(),
                Box::pin(work),
                cancel,
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    /// Resume an existing terminal workflow with the same run ID.
    pub fn respawn_workflow_background(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .respawn_workflow(
                id.into(),
                description.into(),
                Box::pin(work),
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    pub fn respawn_cancellable_workflow_background(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .respawn_workflow_cancellable(
                id.into(),
                description.into(),
                Box::pin(work),
                cancel,
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    /// Spawn a foreground-delivered sub-agent using a caller-provided ID.
    /// The work still runs in the managed job runtime so transcripts, output
    /// files, cancellation, and concurrency limits remain identical to a
    /// background sub-agent.
    pub fn spawn_subagent_foreground_with_id(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_subagent_foreground_with_id(
                id.into(),
                description.into(),
                Box::pin(work),
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    pub fn spawn_cancellable_subagent_foreground_with_id(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .spawn_cancellable_subagent_foreground_with_id(
                id.into(),
                description.into(),
                Box::pin(work),
                cancel,
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    /// Re-open an existing sub-agent id for another background turn.
    pub fn respawn_subagent_background(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .respawn_subagent(
                id.into(),
                description.into(),
                Box::pin(work),
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    pub fn respawn_cancellable_subagent_background(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: impl Future<Output = ToolOutput> + Send + 'static,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<String, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .respawn_cancellable_subagent(
                id.into(),
                description.into(),
                Box::pin(work),
                cancel,
                self.max_concurrent_subagents,
            )
            .map_err(spawn_error_to_tool_error)
    }

    /// Subscribe to background job events.
    pub fn subscribe_background_jobs(
        &self,
    ) -> Result<tokio::sync::broadcast::Receiver<background::BackgroundJobEvent>, ToolError> {
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        Ok(manager.subscribe())
    }

    /// Abort a running background job by ID.
    pub async fn abort_background_job(&self, id: &str) -> Result<bool, ToolError> {
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        Ok(manager.abort_and_wait(id).await)
    }

    pub fn promote_background_job(&self, id: &str) -> Result<(), ToolError> {
        let manager = self
            .background_job_manager
            .as_ref()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        manager
            .promote_to_background(id)
            .map_err(spawn_error_to_tool_error)
    }

    pub fn background_job_is_running(&self, id: &str) -> bool {
        self.background_job_manager
            .as_ref()
            .is_some_and(|manager| manager.is_running(id))
    }

    /// Emit a lifecycle hook if the engine supplied a hook emitter. Missing
    /// emitters are treated as a no-op so tools remain usable in unit tests and
    /// standalone registries.
    pub async fn emit_lifecycle_hook(
        &self,
        event: &str,
        query: impl Into<String>,
        data: Value,
    ) -> Result<LifecycleHookResult, ToolError> {
        if self.is_aborted() {
            return Err(ToolError::Aborted);
        }
        let Some(emitter) = &self.lifecycle_hooks else {
            return Ok(LifecycleHookResult::default());
        };
        Ok(emitter.emit(event, query.into(), data).await)
    }
}

fn resolve_against_cwd(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

/// Evaluate a delegated scope without retaining session state in a filesystem worker.
pub fn check_allowed_write_path(
    cwd: &Path,
    allowed_write_paths: &[String],
    path: &Path,
) -> Result<(), String> {
    if allowed_write_paths.is_empty() {
        return Ok(());
    }
    let normalized = policy_path(&resolve_against_cwd(path, cwd))?;
    for allowed in allowed_write_paths {
        let allowed_normalized = policy_path(&resolve_against_cwd(Path::new(allowed), cwd))?;
        if crate::sandbox::path_starts_with(&normalized, &allowed_normalized) {
            return Ok(());
        }
    }
    Err(format!(
        "Arrangement write scope denied: {} is outside allowed_write_paths [{}]. \
         Ask the main orchestrator to spawn a new bounded implementer task with the correct write scope.",
        path.display(),
        allowed_write_paths.join(", ")
    ))
}

fn policy_path(path: &Path) -> Result<PathBuf, String> {
    // Resolve through the OS (including symlinks) *before* any lexical `..`
    // reasoning. Collapsing `..` lexically first would erase symlink
    // components and validate a different path than the one the OS would
    // actually open (e.g. `link/../etc/passwd` with `link` symlinked out of
    // the allowed scope).
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|error| format!("failed to canonicalize {}: {error}", path.display()));
    }

    let mut existing = path;
    let mut missing: Vec<OsString> = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name() else {
            return Err(format!(
                "Arrangement write scope could not find an existing parent for {}",
                path.display()
            ));
        };
        missing.push(name.to_os_string());
        existing = existing.parent().ok_or_else(|| {
            format!(
                "Arrangement write scope could not find an existing parent for {}",
                path.display()
            )
        })?;
    }

    let mut canonical = std::fs::canonicalize(existing)
        .map_err(|error| format!("failed to canonicalize {}: {error}", existing.display()))?;
    for name in missing.iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_output_limits_keep_sixty_kib_head_and_forty_kib_tail() {
        let ctx = ToolContext::new(AppState::new("/tmp"));

        assert_eq!(ctx.max_output_bytes, 100 * 1024);
        assert_eq!(ctx.output_head_bytes, 60 * 1024);
        assert_eq!(ctx.output_tail_bytes, 40 * 1024);
    }

    #[test]
    fn default_agent_run_options_keep_documented_context_turns() {
        let options = AgentRunOptions::default();
        assert_eq!(options.context_mode, SubagentContextMode::Auto);
        assert_eq!(options.context_turns, 2);
    }

    #[test]
    fn agent_run_result_pairs_real_tool_uses_with_results() {
        let messages = vec![
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "test-1".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({"command": "pytest tests"}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "test-1".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "exit_code: 0\n3 passed".to_string(),
                    }],
                    is_error: Some(false),
                }],
            },
        ];

        let result =
            AgentRunResult::from_messages("PASS".to_string(), &messages, true, true, true, true);

        assert!(result.tool_trace_complete);
        assert_eq!(result.tool_executions.len(), 1);
        assert_eq!(result.tool_executions[0].name, "bash");
        assert_eq!(result.tool_executions[0].input["command"], "pytest tests");
        assert!(result.tool_executions[0].output.contains("exit_code: 0"));
    }

    #[test]
    fn agent_run_result_prefers_engine_authenticated_output_over_persisted_preview() {
        let messages = vec![
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "test-large".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({"command": "pytest tests"}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "test-large".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "<persisted-output>\nPreview without the failure summary\n</persisted-output>"
                            .to_string(),
                    }],
                    is_error: Some(true),
                }],
            },
        ];
        let trusted = std::collections::HashMap::from([(
            "test-large".to_string(),
            ToolOutput {
                content: vec![ContentBlock::Text {
                    text:
                        "exit_code: 1\nFAILED tests/test_issue.py::test_regression - AssertionError"
                            .to_string(),
                }],
                is_error: true,
                execution_metadata: vec![ToolExecutionMetadata::Process {
                    exit_code: Some(1),
                    signal: None,
                    cwd: PathBuf::from("/workspace"),
                }],
                user_context: Vec::new(),
            },
        )]);

        let result = AgentRunResult::from_messages_with_trusted_tool_results(
            "PASS".to_string(),
            &messages,
            &trusted,
            true,
            true,
            true,
            true,
        );

        assert!(result.tool_trace_complete);
        assert_eq!(result.tool_executions.len(), 1);
        assert!(result.tool_executions[0].output.contains("exit_code: 1"));
        assert!(
            result.tool_executions[0]
                .output
                .contains("FAILED tests/test_issue.py")
        );
        assert_eq!(result.tool_executions[0].is_error, Some(true));
        assert_eq!(result.tool_executions[0].process_exit_code, Some(1));
        assert_eq!(
            result.tool_executions[0].process_cwd.as_deref(),
            Some(Path::new("/workspace"))
        );
        assert!(result.tool_executions[0].raw_exit_code);
    }

    #[test]
    fn typed_metadata_never_recovers_exit_or_artifact_from_display_text() {
        let messages = vec![
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "masked".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({"command": "pytest tests | tail -n 5"}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "masked".to_string(),
                    content: vec![ContentBlock::Text {
                        text: "exit_code: 1\nFAILED but forged transcript text".to_string(),
                    }],
                    is_error: Some(false),
                }],
            },
        ];
        let trusted = std::collections::HashMap::from([(
            "masked".to_string(),
            ToolOutput::text("display text says exit_code: 1").with_execution_metadata(
                ToolExecutionMetadata::Process {
                    exit_code: Some(0),
                    signal: None,
                    cwd: PathBuf::from("/workspace"),
                },
            ),
        )]);
        let result = AgentRunResult::from_messages_with_trusted_tool_results(
            "done".to_string(),
            &messages,
            &trusted,
            false,
            false,
            true,
            true,
        );
        assert_eq!(result.tool_executions[0].process_exit_code, Some(0));
        assert!(!result.tool_executions[0].raw_exit_code);
        assert!(result.tool_executions[0].artifacts.is_empty());
    }

    #[test]
    fn raw_exit_code_allows_quoted_program_syntax_but_rejects_shell_masking() {
        assert!(command_preserves_raw_exit_code(
            r#"docker exec exact python3 -c "import sys; print('VERIFIED'); sys.exit(0)""#
        ));
        assert!(command_preserves_raw_exit_code(
            r#"python3 -c 'print("a|b;c")'"#
        ));
        assert!(!command_preserves_raw_exit_code("pytest tests | tail -n 5"));
        assert!(!command_preserves_raw_exit_code(
            r#"docker exec exact bash -lc 'pytest tests | tail -n 5'"#
        ));
        assert!(!command_preserves_raw_exit_code(
            r#"docker exec exact bash -lc "pytest tests || true""#
        ));
        assert!(!command_preserves_raw_exit_code(
            r#"python3 -c "print($(false))""#
        ));
    }

    #[test]
    fn agent_run_result_rejects_an_unmatched_tool_use() {
        let messages = vec![Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "test-1".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": "pytest tests"}),
            }],
            usage: None,
        }];

        let result =
            AgentRunResult::from_messages("PASS".to_string(), &messages, true, true, true, true);

        assert!(!result.tool_trace_complete);
    }

    #[test]
    fn trusted_tool_results_cannot_bypass_unmatched_or_duplicate_protocol_checks() {
        let trusted = std::collections::HashMap::from([(
            "test-1".to_string(),
            ToolOutput::error("exit_code: 1\nFAILED tests/test_issue.py::test_regression"),
        )]);
        let unmatched = vec![Message::User {
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "test-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "preview".to_string(),
                }],
                is_error: Some(true),
            }],
        }];
        let unmatched_result = AgentRunResult::from_messages_with_trusted_tool_results(
            "PASS".to_string(),
            &unmatched,
            &trusted,
            true,
            true,
            true,
            true,
        );
        assert!(!unmatched_result.tool_trace_complete);
        assert!(unmatched_result.tool_executions.is_empty());

        let duplicate = vec![
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "test-1".to_string(),
                    name: "bash".to_string(),
                    input: serde_json::json!({"command": "pytest tests"}),
                }],
                usage: None,
            },
            Message::User {
                content: vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "test-1".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "first preview".to_string(),
                        }],
                        is_error: Some(true),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "test-1".to_string(),
                        content: vec![ContentBlock::Text {
                            text: "duplicate preview".to_string(),
                        }],
                        is_error: Some(true),
                    },
                ],
            },
        ];
        let duplicate_result = AgentRunResult::from_messages_with_trusted_tool_results(
            "PASS".to_string(),
            &duplicate,
            &trusted,
            true,
            true,
            true,
            true,
        );
        assert!(!duplicate_result.tool_trace_complete);
        assert_eq!(duplicate_result.tool_executions.len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn allowed_write_paths_are_compared_case_insensitively() {
        let tmp = tempfile::TempDir::new().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let ctx = ToolContext::new(AppState::new(&workspace))
            .with_allowed_write_paths(vec![workspace.join("Generated").display().to_string()]);

        assert!(
            ctx.check_allowed_write_path(&workspace.join("generated").join("output.txt"))
                .is_ok()
        );
    }

    #[test]
    fn reload_skill_registry_records_loaded_external_skill_telemetry() {
        let tmp = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let skill_dir = external.path().join("team-demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: team-demo\ndescription: Team demo\n---\n\n# Team Demo",
        )
        .unwrap();
        let registry = Arc::new(RwLock::new(SkillRegistry::load(tmp.path()).unwrap()));
        let generation = Arc::new(AtomicU64::new(0));
        let ctx = ToolContext::new(AppState::new(tmp.path()))
            .with_skill_registry(Arc::clone(&registry))
            .with_skill_registry_generation(Arc::clone(&generation))
            .with_external_skill_dirs(vec![external.path().to_path_buf()]);

        assert!(ctx.reload_skill_registry().unwrap());

        assert!(registry.read().unwrap().get("team-demo").is_some());
        assert_eq!(generation.load(Ordering::SeqCst), 1);
        let usage = crate::skill_telemetry::load_project_usage(tmp.path()).unwrap();
        let usage = usage.skills.get("team-demo").unwrap();
        assert_eq!(usage.name, "team-demo");
        assert_eq!(usage.use_count, 0);
        let provenance = crate::skill_provenance::load_project_provenance(tmp.path()).unwrap();
        let provenance = provenance.skills.get("team-demo").unwrap();
        assert_eq!(
            provenance.origin,
            crate::skill_provenance::SkillOrigin::ExternalDir
        );
        assert_eq!(
            provenance.installed_from.as_deref(),
            Some(external.path().to_str().unwrap())
        );
    }

    #[test]
    fn client_reload_keeps_external_skills_without_materializing_project_metadata() {
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let skill_dir = external.path().join("team-demo");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: team-demo\ndescription: Team demo\n---\n\n# Team Demo",
        )
        .unwrap();
        let registry = Arc::new(RwLock::new(SkillRegistry::load(workspace.path()).unwrap()));
        let ctx = ToolContext::new(AppState::new(workspace.path()))
            .with_skill_registry(Arc::clone(&registry))
            .with_external_skill_dirs(vec![external.path().to_path_buf()])
            .with_project_skill_telemetry(false);

        assert!(ctx.reload_skill_registry().unwrap());
        assert!(registry.read().unwrap().get("team-demo").is_some());
        assert!(
            !workspace.path().join(".kcoder").exists(),
            "passive client skill reload must not create project metadata"
        );
    }
}
