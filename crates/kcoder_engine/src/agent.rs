use crate::{EngineEvent, QueryEngine, WorkspacePersistenceMode};
use futures::StreamExt;
use kcoder_api::{Provider, ProviderFactory};
use kcoder_config::GoalProTestScope;
use kcoder_config::{PermissionMode, Settings};
use kcoder_permissions::{AutoDenyPrompt, PermissionEngine};
use kcoder_state::{AgentDeliveryClaimOutcome, AppState, Goal, GoalWorkspaceBaseline};
use kcoder_tools::{
    AgentDeliveryContext, AgentError, AgentKind, AgentRunOptions, AgentRunResult, AgentRunner,
    SkillGuardPolicy, SubagentContextMode, ToolContext, ToolOutput, ToolRegistry,
    VerifierRunOptions, VerifierWorkspaceBaseline,
};
use kcoder_types::{ContentBlock, Message};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::error::Error as StdError;
use std::fmt;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use tracing::warn;

mod artifact_validation;
mod context_projection;
#[cfg(test)]
pub(crate) use context_projection::recent_parent_start;
mod tool_policy;

const SUBAGENT_MODEL_DETAIL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

#[allow(unused_imports)]
use context_projection::project_parent_messages;
pub use context_projection::{CacheSafeParams, is_real_user_message};
use context_projection::{initial_agent_messages, validate_full_context_compatibility};
pub use tool_policy::{
    agent_kind_allowed_tools, all_agent_disallowed_tools, async_agent_allowed_tools,
    background_review_allowed_tools, filter_tools_by_names, filter_tools_by_owned_names,
    filter_tools_for_agent, filter_tools_for_agent_kind, filter_tools_for_agent_kind_in_mode,
};
use tool_policy::{
    subagent_permission_mode, subagent_session_allowed_shell_prefixes,
    subagent_session_allowed_tools,
};

const MAX_LIVE_SUBAGENT_DELIVERIES_PER_BOUNDARY: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppliedSubagentSteer {
    pub(crate) agent_id: String,
    pub(crate) message_id: String,
    pub(crate) queue_depth: usize,
}

/// Context overrides for a subagent fork.
#[derive(Debug, Clone, Default)]
pub struct SubagentContextOverrides {
    /// Completed delivery replay bypasses the model but still restores child authority for observation.
    pub artifact_replay_output: Option<String>,
    /// Share AppState writes with the parent.
    pub share_set_app_state: bool,
    /// Share response-length updates with the parent.
    pub share_set_response_length: bool,
    /// Inherit parent cancellation through a one-way child token.
    /// Cancelling the child never cancels its parent or siblings.
    pub share_abort_controller: bool,
    /// Use a caller-owned cancellation token instead of the parent controller.
    pub abort_token: Option<CancellationToken>,
    /// Optional write scope inherited from an Arrangement delegation contract.
    pub allowed_write_paths: Vec<String>,
    /// Explicit shell prefixes inherited from the delegation contract. These
    /// are separate from role-wide validation grants because the scoped shell
    /// mutation guard must only honor parent-delegated targets.
    pub scoped_allowed_shell_prefixes: Vec<String>,
    /// Block shell commands that appear to mutate files.
    pub block_shell_file_mutation: bool,
    /// Block package/dependency installation, removal, and update commands.
    pub block_dependency_mutation: bool,
    /// Private verifier environment root used for HOME/cache/temp isolation.
    pub shell_isolation_root: Option<PathBuf>,
    /// Minimum test scope required before Goal Pro verifier shell execution.
    pub verifier_minimum_test_scope: Option<GoalProTestScope>,
    /// Whether the Goal Pro verifier rejects commands that hide test exit codes before execution.
    pub verifier_require_raw_exit_code: bool,
    /// Whether the Goal Pro verifier requires identically signed candidate/baseline behavior probes.
    pub verifier_require_behavior_delta: bool,
    /// On the final internal turn, expose only VerifierVote for the final verdict and no other tools.
    pub verifier_terminal_verdict: bool,
    /// Constrain verifier shell writes to a private workspace and temporary paths.
    pub isolate_shell_writes: bool,
    /// Repository root used by the verifier shell sandbox. This can differ from
    /// the process cwd when a Goal starts in a repository subdirectory.
    pub shell_write_root: Option<PathBuf>,
    /// Engine-created pristine baseline available only to the verifier.
    pub verifier_baseline_root: Option<PathBuf>,
    /// Vote channel shared by a Goal Pro verifier session: vote slot plus engine-authenticated tool IDs.
    pub verifier_vote_channel: Option<kcoder_tools::VerifierVoteChannel>,
    /// Work/revision-bound verdict channel shared by an orchestration critic session.
    pub review_vote_channel: Option<kcoder_tools::ReviewVoteChannel>,
    /// Arrangement mode latched by the spawning tool execution.
    pub arrangement_mode: Option<bool>,
    /// Role identity injected into the child system prompt. The delegated
    /// task itself remains a user message.
    pub role_system_prompt: Option<String>,
    /// Safer non-interactive mode used only when the parent is in the default
    /// interactive Ask mode. Explicit parent modes remain authoritative.
    pub permission_mode_if_parent_asks: Option<PermissionMode>,
    /// Narrow session-only allow patterns for an explicitly authorized
    /// internal child workflow. Parent deny rules still take precedence, and
    /// the child's filtered registry remains the outer capability boundary.
    pub session_allowed_tools: Vec<String>,
    /// Shell command prefixes explicitly authorized for this child session.
    /// This is used for validation roles because tests/builds execute project
    /// code and therefore must not be classified as universally read-only.
    pub session_allowed_shell_prefixes: Vec<String>,
    /// Optional session cwd override (spawn_agent `isolation="worktree"`).
    /// The fork's AppState is rooted here instead of the parent workspace so
    /// the child's relative paths and shell commands stay inside the
    /// isolation worktree.
    pub cwd_override: Option<PathBuf>,
    /// Stable job identity for an internal skill reviewer. When present, the
    /// sub-agent's skill_manage transaction records a BackgroundReview actor directly.
    pub skill_review_job_id: Option<String>,
}

/// Builder for a subagent execution context.
#[derive(Debug, Clone)]
pub struct SubagentContext {
    pub agent_id: String,
    pub depth: u32,
    pub state: AppState,
    pub tool_context: ToolContext,
    pub permissions: PermissionEngine,
    pub overrides: SubagentContextOverrides,
}

/// Result returned by a forked agent run.
#[derive(Debug, Clone)]
pub struct ForkedAgentResult {
    pub agent_id: String,
    pub messages: Vec<Message>,
    pub output_text: String,
    /// Verifier-only results captured by the engine during tool execution before
    /// large transcript results are persisted. This map is never recovered from
    /// transcript paths, preventing model-forged out-of-bounds reads.
    pub(crate) trusted_tool_results: HashMap<String, ToolOutput>,
}

const MAX_VERIFIER_TRUSTED_TOOL_RESULTS: usize = 256;
const MAX_VERIFIER_TRUSTED_TOOL_RESULT_BYTES: usize = 256 * 1024;
const MAX_VERIFIER_TRUSTED_TOOL_RESULTS_BYTES: usize = 16 * 1024 * 1024;

/// Complete input for starting or continuing one forked-agent engine. Grouping
/// these values keeps the transcript, capability profile, turn budget, and
/// role-filtered registry from being accidentally reordered at call sites.
pub struct ForkedAgentRequest {
    pub agent_id: Option<String>,
    pub messages: Vec<Message>,
    pub prompt_message_count: usize,
    /// Initial message leased to this continuation by the reliable FIFO. Acknowledge
    /// it immediately after the initial transcript checkpoint so later live steering is not blocked.
    pub initial_delivery: Option<AgentDeliveryContext>,
    pub overrides: SubagentContextOverrides,
    pub max_turns: usize,
    pub tools: ToolRegistry,
    /// Optional independent provider runtime. Regular sub-agents keep None and inherit the parent runtime.
    pub runtime: Option<ForkedAgentRuntime>,
}

#[derive(Clone)]
pub struct ForkedAgentRuntime {
    pub provider: Arc<dyn Provider>,
    pub settings: Settings,
}

#[derive(Debug)]
struct ForkedAgentAborted {
    reason: String,
    cancelled: bool,
}

#[derive(Debug)]
pub(crate) struct ForkedAgentMaxTurnsReached {
    pub(crate) max_turns: usize,
}

/// Agent runner backed by a parent `QueryEngine`.
#[derive(Clone)]
pub struct QueryEngineAgentRunner {
    engine: QueryEngine,
}

#[derive(Debug, Clone)]
struct VerifierRuntimeGuard {
    block_dependency_mutation: bool,
    minimum_test_scope: Option<GoalProTestScope>,
    require_raw_exit_code: bool,
    require_behavior_delta: bool,
    shell_isolation_root: Option<PathBuf>,
    cwd_override: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
    baseline_root: Option<PathBuf>,
    /// VerifierVote channel for this session; `run_verifier_with_runtime` owns the other endpoint.
    vote_channel: kcoder_tools::VerifierVoteChannel,
}

struct ProfileFingerprintInput<'a> {
    persona: &'a str,
    agent_kind: AgentKind,
    role_prompt: &'a str,
    tools: &'a ToolRegistry,
    runtime_provider: &'a str,
    runtime_model: &'a str,
    runtime_selection: Option<&'a kcoder_tools::AgentRuntimeSelection>,
    context_mode: SubagentContextMode,
    context_turns: usize,
    work_id: Option<&'a str>,
    parent_session_id: &'a str,
}

const MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_VERIFIER_UNTRACKED_COPY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VERIFIER_ISSUE_CONTEXT_BYTES: u64 = 1024 * 1024;
const MAX_VERIFIER_BASELINE_BUNDLE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug)]
struct VerifierWorkspaceIsolation {
    _private_root: kcoder_config::PrivateTempDir,
    _baseline_root: kcoder_config::PrivateTempDir,
    _repository_root: Option<kcoder_config::PrivateTempDir>,
    source_root: PathBuf,
    worktree_root: PathBuf,
    baseline_root: PathBuf,
    cwd: PathBuf,
    changed_paths: Vec<String>,
}

mod execution;
pub use execution::continue_forked_agent_with_tools;
pub(crate) use execution::is_forked_agent_max_turns_reached;
pub use execution::run_forked_agent;
pub(crate) use execution::run_forked_agent_from_messages;
pub use execution::run_forked_agent_with_tools;
use execution::*;

mod checkpoint;
pub(super) use checkpoint::unmatched_tool_use_ids;
pub(crate) use checkpoint::write_transcript_checkpoint;
use checkpoint::*;

mod delivery;

mod context;
use context::*;

mod usage;
use usage::*;

mod verification;
use verification::*;

mod evidence;
use evidence::*;

mod verification_workspace;
pub use verification_workspace::ensure_goal_pro_workspace_baseline;
use verification_workspace::*;

mod runner;

#[cfg(test)]
#[path = "agent/tests.rs"]
mod tests;

#[cfg(test)]
mod direct_workflow_tests;
