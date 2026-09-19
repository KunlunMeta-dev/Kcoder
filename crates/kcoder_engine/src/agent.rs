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

fn subagent_model_detail_due(last_emit: std::time::Instant, now: std::time::Instant) -> bool {
    now.saturating_duration_since(last_emit) >= SUBAGENT_MODEL_DETAIL_INTERVAL
}

#[allow(unused_imports)]
pub(crate) use context_projection::is_synthetic_parent_text;
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

async fn run_subagent_hook(
    parent: &QueryEngine,
    event: kcoder_hooks::HookEvent,
    agent_id: &str,
    data: serde_json::Value,
) -> anyhow::Result<()> {
    let (_events, effects, blocking_error) = parent
        .run_simple_hooks(event, agent_id.to_string(), data)
        .await;
    if let Some(reason) = blocking_error.or(effects.blocking_error) {
        return Err(anyhow::anyhow!(
            "{} hook blocked subagent operation: {}",
            event.as_str(),
            reason
        ));
    }
    if effects.prevent_continuation {
        return Err(anyhow::anyhow!(
            "{} hook prevented subagent continuation: {}",
            event.as_str(),
            effects
                .stop_reason
                .unwrap_or_else(|| "no reason provided".to_string())
        ));
    }
    Ok(())
}

pub(crate) async fn write_transcript_checkpoint(
    path: &std::path::Path,
    messages: &[Message],
) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let bytes = serde_json::to_vec_pretty(messages)?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, bytes).await?;
    if let Err(error) = tokio::fs::rename(&temporary, path).await {
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(error.into());
        }
        tokio::fs::remove_file(path).await?;
        tokio::fs::rename(&temporary, path).await?;
    }
    Ok(())
}

fn transcript_messages_sha256(messages: &[Message]) -> Result<String, AgentError> {
    let bytes = serde_json::to_vec(messages).map_err(|error| {
        AgentError::Execution(format!("failed to hash sub-agent transcript: {error}"))
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn is_exact_delivery_message(message: &Message, body: &str) -> bool {
    matches!(
        message,
        Message::User { content }
            if matches!(content.as_slice(), [ContentBlock::Text { text }] if text == body)
    )
}

fn completed_delivery_output(messages: &[Message], delivery_index: usize) -> Option<String> {
    if !unmatched_tool_use_ids(messages).is_empty() {
        return None;
    }
    let Message::Assistant { content, .. } = messages.last()? else {
        return None;
    };
    if messages.len() <= delivery_index.saturating_add(1)
        || content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
    {
        return None;
    }
    Some(
        content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    )
}

const MAX_LIVE_SUBAGENT_DELIVERIES_PER_BOUNDARY: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AppliedSubagentSteer {
    pub(crate) agent_id: String,
    pub(crate) message_id: String,
    pub(crate) queue_depth: usize,
}

impl QueryEngine {
    /// Apply reliable messages at complete provider/tool boundaries in a forked child.
    ///
    /// Each message first leases the queue head and records a transcript anchor, then
    /// writes the user message to an atomic checkpoint, and only then acknowledges it.
    /// The caller may issue the next provider request only after this function succeeds.
    pub(crate) async fn apply_pending_subagent_deliveries_at_safe_boundary(
        &self,
    ) -> anyhow::Result<Vec<AppliedSubagentSteer>> {
        let Some(control) = self.subagent_runtime_control.as_ref() else {
            return Ok(Vec::new());
        };
        let Some(task) = control.parent_state.task(&control.agent_id) else {
            // Internal forks, MoA runs, and some tests do not create resumable tasks and therefore have no reliable queue.
            return Ok(Vec::new());
        };
        if !matches!(
            task.status,
            kcoder_state::TaskStatus::Pending | kcoder_state::TaskStatus::Running
        ) || !task.accepting_subagent_messages
        {
            return Ok(Vec::new());
        }
        if !unmatched_tool_use_ids(&self.state.messages()).is_empty() {
            anyhow::bail!(
                "refusing to apply a sub-agent delivery inside an incomplete tool protocol"
            );
        }

        let lease_timeout_seconds = task.delivery_lease_timeout_seconds.clamp(30, 3600);
        let max_attempts = task.delivery_max_attempts.clamp(1, 64);
        let mut applied = Vec::new();

        for _ in 0..MAX_LIVE_SUBAGENT_DELIVERIES_PER_BOUNDARY {
            if !control
                .parent_state
                .task(&control.agent_id)
                .is_some_and(|task| {
                    matches!(
                        task.status,
                        kcoder_state::TaskStatus::Pending | kcoder_state::TaskStatus::Running
                    ) && task.accepting_subagent_messages
                })
            {
                break;
            }
            let claim = match control.parent_state.claim_next_subagent_delivery(
                &control.agent_id,
                lease_timeout_seconds,
                max_attempts,
            )? {
                AgentDeliveryClaimOutcome::Claimed(claim) => claim,
                AgentDeliveryClaimOutcome::Empty
                | AgentDeliveryClaimOutcome::Busy { .. }
                | AgentDeliveryClaimOutcome::Blocked { .. } => break,
            };

            let before_messages = self.state.messages();
            let mut messages = before_messages.clone();
            let reconcile = (|| -> Result<(), AgentError> {
                let body_sha256 = format!("{:x}", Sha256::digest(claim.body.as_bytes()));
                let anchor = if let Some(anchor) = claim.transcript_anchor.clone() {
                    if anchor.body_sha256 != body_sha256 {
                        return Err(AgentError::Execution(format!(
                            "delivery {} body changed after it was leased",
                            claim.message_id
                        )));
                    }
                    anchor
                } else {
                    let anchor = kcoder_state::TranscriptDeliveryAnchor {
                        baseline_message_count: messages.len(),
                        baseline_sha256: transcript_messages_sha256(&messages)?,
                        body_sha256,
                    };
                    let prepared = control
                        .parent_state
                        .prepare_subagent_delivery(
                            &control.agent_id,
                            &claim.message_id,
                            &claim.lease_id,
                            anchor.clone(),
                        )
                        .map_err(|error| AgentError::Execution(error.to_string()))?;
                    if !prepared {
                        return Err(AgentError::Execution(format!(
                            "delivery {} disappeared before transcript preparation",
                            claim.message_id
                        )));
                    }
                    anchor
                };

                if messages.len() < anchor.baseline_message_count {
                    return Err(AgentError::Execution(format!(
                        "delivery {} transcript is shorter than its persisted baseline",
                        claim.message_id
                    )));
                }
                let baseline = &messages[..anchor.baseline_message_count];
                if transcript_messages_sha256(baseline)? != anchor.baseline_sha256 {
                    return Err(AgentError::Execution(format!(
                        "delivery {} transcript baseline changed; refusing duplicate insertion",
                        claim.message_id
                    )));
                }
                if messages.len() == anchor.baseline_message_count {
                    messages.push(Message::user_text(claim.body.clone()));
                } else if !is_exact_delivery_message(
                    &messages[anchor.baseline_message_count],
                    &claim.body,
                ) {
                    return Err(AgentError::Execution(format!(
                        "delivery {} transcript anchor points to a different message",
                        claim.message_id
                    )));
                }
                Ok(())
            })();

            if let Err(error) = reconcile {
                let _ = control.parent_state.fail_subagent_delivery(
                    &control.agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    max_attempts,
                    &error.to_string(),
                );
                return Err(anyhow::Error::new(error));
            }

            self.state.set_messages(messages);
            if let Err(error) = control
                .checkpoint_writer
                .write(&control.transcript_path, &self.state.messages())
                .await
            {
                self.state.set_messages(before_messages);
                let _ = control.parent_state.fail_subagent_delivery(
                    &control.agent_id,
                    &claim.message_id,
                    &claim.lease_id,
                    max_attempts,
                    &error.to_string(),
                );
                return Err(error);
            }
            if !control.parent_state.ack_subagent_delivery(
                &control.agent_id,
                &claim.message_id,
                &claim.lease_id,
            )? {
                anyhow::bail!(
                    "delivery {} disappeared after its transcript checkpoint was committed",
                    claim.message_id
                );
            }
            let queue_depth = control
                .parent_state
                .task(&control.agent_id)
                .map(|task| task.message_queue.len())
                .unwrap_or_default();
            applied.push(AppliedSubagentSteer {
                agent_id: control.agent_id.clone(),
                message_id: claim.message_id,
                queue_depth,
            });
        }

        Ok(applied)
    }
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

fn resolve_subagent_abort_token(
    parent_token: CancellationToken,
    overrides: &SubagentContextOverrides,
) -> CancellationToken {
    overrides
        .abort_token
        .as_ref()
        .map(CancellationToken::child_token)
        .unwrap_or_else(|| {
            if overrides.share_abort_controller {
                parent_token.child_token()
            } else {
                CancellationToken::new()
            }
        })
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

fn generate_agent_id(parent: &QueryEngine) -> anyhow::Result<String> {
    if let Some(registry) = parent.state.short_id_registry() {
        return kcoder_state::short_id::reserve_short_id(&registry);
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(format!("agent-{}", ts))
}

impl SubagentContext {
    pub fn from_parent(
        parent: &QueryEngine,
        state: AppState,
        overrides: SubagentContextOverrides,
    ) -> anyhow::Result<Self> {
        Ok(Self::from_parent_with_agent_id(
            parent,
            state,
            overrides,
            generate_agent_id(parent)?,
        ))
    }

    pub fn from_parent_with_agent_id(
        parent: &QueryEngine,
        state: AppState,
        overrides: SubagentContextOverrides,
        agent_id: String,
    ) -> Self {
        let abort_token = resolve_subagent_abort_token(parent.cancel_token(), &overrides);
        let (external_skill_dirs, trust_external_skills, skill_guard_policy, auto_lessons_learned) = {
            let settings = crate::recover_read_lock(&parent.settings, "settings");
            (
                settings.skills.external_dirs.clone(),
                settings.skills.trust_external,
                SkillGuardPolicy {
                    enabled: settings.skills.guard.enabled,
                    block_high_risk: settings.skills.guard.block_high_risk,
                    block_medium_risk_for_community: settings
                        .skills
                        .guard
                        .block_medium_risk_for_community,
                },
                settings.skills.auto_lessons_learned,
            )
        };

        let arrangement_mode = overrides
            .arrangement_mode
            .unwrap_or_else(|| parent.is_arrangement_mode_active());
        let depth = parent.agent_depth().saturating_add(1);
        let mut tool_context = ToolContext::new(state.clone())
            .with_file_edit_surface(parent.file_edit_surface)
            .with_memory_manager(Arc::clone(&parent.memory_manager))
            .with_memory_store(Arc::clone(&parent.memory_store))
            .with_skill_registry(Arc::clone(&parent.skill_registry))
            .with_skill_registry_generation(Arc::clone(&parent.skill_registry_generation))
            .with_active_skills(Arc::clone(&parent.active_skills))
            .with_external_skill_dirs(external_skill_dirs)
            .with_trust_external_skills(trust_external_skills)
            .with_skill_guard_policy(skill_guard_policy)
            .with_auto_lessons_learned(auto_lessons_learned)
            .with_abort_token(abort_token)
            .with_agent_runtime_identity(parent.provider_name(), parent.model_name())
            .with_user_questioner(parent.effective_user_questioner())
            .with_agent_depth(depth)
            .with_allowed_write_paths(overrides.allowed_write_paths.clone())
            .with_allowed_shell_prefixes(overrides.scoped_allowed_shell_prefixes.clone())
            .with_block_shell_file_mutation(overrides.block_shell_file_mutation)
            .with_block_dependency_mutation(overrides.block_dependency_mutation)
            .with_shell_isolation_root(overrides.shell_isolation_root.clone())
            .with_verifier_test_policy(
                overrides.verifier_minimum_test_scope,
                overrides.verifier_require_raw_exit_code,
            )
            .with_verifier_behavior_delta(overrides.verifier_require_behavior_delta)
            .with_verifier_baseline_root(overrides.verifier_baseline_root.clone())
            .with_verifier_vote_channel(overrides.verifier_vote_channel.clone())
            .with_review_vote_channel(overrides.review_vote_channel.clone())
            .with_arrangement_mode(arrangement_mode)
            .with_lifecycle_hooks(Arc::new(crate::EngineLifecycleHookEmitter::new(
                parent.clone(),
            )));
        if let Some(job_id) = overrides.skill_review_job_id.as_ref() {
            tool_context = tool_context.with_skill_mutation_actor(
                kcoder_skills::SkillMutationActor::BackgroundReview {
                    session_id: state.session_id(),
                    job_id: job_id.clone(),
                    agent_id: agent_id.clone(),
                    tool_call_id: "pending".to_string(),
                },
            );
        }

        let mut permissions = crate::recover_read_lock(&parent.permissions, "permissions").clone();
        if permissions.mode == PermissionMode::Ask
            && let Some(mode) = overrides.permission_mode_if_parent_asks
        {
            permissions.mode = mode;
        }
        permissions
            .session_allowed
            .extend(overrides.session_allowed_tools.iter().cloned());
        permissions
            .session_allowed_shell_prefixes
            .extend(overrides.session_allowed_shell_prefixes.iter().cloned());

        Self {
            agent_id,
            depth,
            state,
            tool_context,
            permissions,
            overrides,
        }
    }
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

fn summarize_agent_usage(messages: &[Message]) -> kcoder_state::AgentUsageSummary {
    let mut summary = kcoder_state::AgentUsageSummary::default();
    for message in messages {
        let Message::Assistant {
            usage: Some(usage), ..
        } = message
        else {
            continue;
        };
        summary.input_tokens = summary
            .input_tokens
            .saturating_add(u64::from(usage.input_tokens));
        summary.output_tokens = summary
            .output_tokens
            .saturating_add(u64::from(usage.output_tokens));
        summary.cache_creation_input_tokens = summary
            .cache_creation_input_tokens
            .saturating_add(u64::from(usage.cache_creation_input_tokens.unwrap_or(0)));
        summary.cache_read_input_tokens = summary
            .cache_read_input_tokens
            .saturating_add(u64::from(usage.cache_read_input_tokens.unwrap_or(0)));
        if let Some(iterations) = usage.iterations.as_ref() {
            for iteration in iterations {
                summary.input_tokens = summary
                    .input_tokens
                    .saturating_add(u64::from(iteration.input_tokens));
                summary.output_tokens = summary
                    .output_tokens
                    .saturating_add(u64::from(iteration.output_tokens));
            }
        }
    }
    summary
}

fn checkpoint_agent_usage(parent: &QueryEngine, agent_id: &str, messages: &[Message]) {
    if let Err(error) = parent
        .state
        .record_agent_usage_summary(agent_id, summarize_agent_usage(messages))
    {
        warn!(%error, %agent_id, "failed to persist sub-agent usage checkpoint");
    }
}

fn record_agent_breaker_event(parent: &QueryEngine, agent_id: &str, event: &EngineEvent) {
    let result = match event {
        EngineEvent::ToolUseStarted { name, input, .. } => {
            let payload = serde_json::to_vec(&(name, input)).unwrap_or_default();
            let fingerprint = format!("{:x}", Sha256::digest(payload));
            parent
                .state
                .record_agent_action_signal(agent_id, &fingerprint)
        }
        EngineEvent::ToolResult { name, output, .. } => {
            let payload =
                serde_json::to_vec(&(name, &output.content, output.is_error)).unwrap_or_default();
            let fingerprint = format!("{:x}", Sha256::digest(payload));
            parent
                .state
                .record_agent_result_signal(agent_id, &fingerprint, output.is_error)
        }
        EngineEvent::Error(error) | EngineEvent::ProviderFailed { message: error, .. } => {
            let fingerprint = format!("{:x}", Sha256::digest(error.as_bytes()));
            parent
                .state
                .record_agent_result_signal(agent_id, &fingerprint, true)
        }
        _ => return,
    };
    if let Err(error) = result {
        warn!(%error, %agent_id, "failed to persist sub-agent breaker signal");
    }
}

fn acknowledge_persisted_breaker_steer(
    parent: &QueryEngine,
    agent_id: &str,
    messages: &[Message],
) -> anyhow::Result<()> {
    let Some(steer) = parent.state.pending_agent_steer(agent_id) else {
        return Ok(());
    };
    let marker = format!("[system][breaker_steer id=\"{}\"]", steer.steer_id);
    let persisted = messages.iter().any(|message| match message {
        Message::User { content } => content
            .iter()
            .any(|block| matches!(block, ContentBlock::Text { text } if text.starts_with(&marker))),
        Message::Assistant { .. } => false,
    });
    if persisted {
        parent
            .state
            .acknowledge_agent_steer(agent_id, &steer.steer_id)?;
    }
    Ok(())
}

const MAX_VERIFIER_TRUSTED_TOOL_RESULTS: usize = 256;
const MAX_VERIFIER_TRUSTED_TOOL_RESULT_BYTES: usize = 256 * 1024;
const MAX_VERIFIER_TRUSTED_TOOL_RESULTS_BYTES: usize = 16 * 1024 * 1024;

fn bounded_verifier_tool_result(name: &str, output: ToolOutput) -> Option<(ToolOutput, usize)> {
    // Goal Pro needs only raw shell results. Orchestration also retains tools for
    // which the runtime issued process/artifact metadata and specialized tools that
    // produce structured evidence. Ordinary read/search text does not become trusted
    // evidence merely because it appears in the transcript.
    if !matches!(name, "bash" | "PowerShell" | "SpecValidate" | "WebFetch")
        && output.execution_metadata.is_empty()
    {
        return None;
    }
    let text = output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    // exit_code/workdir are in the header while pytest/unittest failure summaries are usually at the tail; retain both ends.
    let text = kcoder_tools::truncate_text(
        &text,
        MAX_VERIFIER_TRUSTED_TOOL_RESULT_BYTES,
        if matches!(name, "bash" | "PowerShell") {
            64 * 1024
        } else {
            128 * 1024
        },
        if matches!(name, "bash" | "PowerShell") {
            192 * 1024
        } else {
            128 * 1024
        },
    )
    .text;
    let bytes = text.len();
    Some((
        ToolOutput {
            content: vec![ContentBlock::Text { text }],
            is_error: output.is_error,
            execution_metadata: output.execution_metadata,
            user_context: Vec::new(),
        },
        bytes,
    ))
}

/// Run a forked agent that shares the parent's cache-safe parameters.
///
/// The fork is an in-process same-runtime task. It reuses the parent's
/// provider and rebuilds the same system prompt for cache sharing.
pub async fn run_forked_agent(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    prompt_messages: Vec<Message>,
    overrides: SubagentContextOverrides,
    max_turns: usize,
) -> anyhow::Result<ForkedAgentResult> {
    run_forked_agent_with_tools(
        parent,
        cache_safe,
        prompt_messages,
        overrides,
        max_turns,
        filter_tools_for_agent_kind(&parent.tools, AgentKind::General, true),
    )
    .await
}

pub async fn run_forked_agent_with_tools(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    prompt_messages: Vec<Message>,
    overrides: SubagentContextOverrides,
    max_turns: usize,
    tools: ToolRegistry,
) -> anyhow::Result<ForkedAgentResult> {
    let prompt_message_count = prompt_messages.len();
    let mut initial_messages = cache_safe.fork_context_messages.to_vec();
    initial_messages.extend(prompt_messages);
    run_forked_agent_from_messages(
        parent,
        cache_safe,
        ForkedAgentRequest {
            agent_id: None,
            messages: initial_messages,
            prompt_message_count,
            initial_delivery: None,
            overrides,
            max_turns,
            tools,
            runtime: None,
        },
    )
    .await
}

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

/// Switch a verifier to an isolated write root while preserving parent read-deny and OS sandbox policies.
///
/// `denied_paths` may be relative to the parent workspace, so use the already
/// re-anchored configuration from the parent Sandbox instead of reinterpreting fork
/// Settings. The verifier may run tests in the candidate worktree, pristine read-only
/// baseline, and private runtime directory, but cannot escalate or write shared caches.
fn verifier_sandbox_from_parent(
    parent: &kcoder_tools::Sandbox,
    shell_write_root: PathBuf,
    baseline_root: Option<PathBuf>,
    runtime_write_root: PathBuf,
) -> kcoder_tools::Sandbox {
    let allowed_paths = std::iter::once(shell_write_root.display().to_string())
        .chain(baseline_root.iter().map(|path| path.display().to_string()))
        .collect();
    let readonly_paths = baseline_root.into_iter().collect();
    let mut config = parent.reanchored_config();
    config.enabled = true;
    config.readonly = false;
    config.allow_shell_escalation = false;
    config.require_shell_escalation_approval = true;
    config.shell_escalation_max_attempts = 0;
    config.allowed_paths = allowed_paths;

    kcoder_tools::Sandbox::new(shell_write_root, config)
        .with_readonly_paths(readonly_paths)
        .with_runtime_write_path(runtime_write_root)
        .without_shared_dev_cache_writes()
}

pub async fn continue_forked_agent_with_tools(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    request: ForkedAgentRequest,
) -> anyhow::Result<ForkedAgentResult> {
    debug_assert!(request.agent_id.is_some());
    run_forked_agent_from_messages(parent, cache_safe, request).await
}

#[derive(Debug)]
struct ForkedAgentAborted {
    reason: String,
    cancelled: bool,
}

impl fmt::Display for ForkedAgentAborted {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "forked agent aborted: {}", self.reason)
    }
}

impl StdError for ForkedAgentAborted {}

#[derive(Debug)]
pub(crate) struct ForkedAgentMaxTurnsReached {
    pub(crate) max_turns: usize,
}

impl fmt::Display for ForkedAgentMaxTurnsReached {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "forked agent reached maximum turns ({})",
            self.max_turns
        )
    }
}

impl StdError for ForkedAgentMaxTurnsReached {}

pub(crate) fn is_forked_agent_max_turns_reached(error: &anyhow::Error) -> bool {
    error.downcast_ref::<ForkedAgentMaxTurnsReached>().is_some()
}

fn map_forked_agent_error(error: anyhow::Error) -> AgentError {
    match error.downcast_ref::<ForkedAgentAborted>() {
        Some(aborted) if aborted.reason == "agent_control:paused" => {
            AgentError::Paused("pause requested by parent Orchestrate session".to_string())
        }
        Some(aborted) if aborted.reason == "agent_control:halted" => {
            AgentError::Halted("halt requested by parent Orchestrate session".to_string())
        }
        Some(aborted) if aborted.cancelled => AgentError::Cancelled(aborted.reason.clone()),
        _ => AgentError::Execution(error.to_string()),
    }
}

pub(crate) async fn run_forked_agent_from_messages(
    parent: &QueryEngine,
    cache_safe: &CacheSafeParams,
    request: ForkedAgentRequest,
) -> anyhow::Result<ForkedAgentResult> {
    let ForkedAgentRequest {
        agent_id: agent_id_override,
        messages: initial_messages,
        prompt_message_count,
        initial_delivery,
        overrides,
        max_turns,
        tools,
        runtime,
    } = request;
    let verifier_terminal_verdict = overrides.verifier_terminal_verdict;
    let artifact_replay_output = overrides.artifact_replay_output.clone();
    let verifier_vote_channel = overrides.verifier_vote_channel.clone();
    let review_vote_channel = overrides.review_vote_channel.clone();
    let terminal_verdict = verifier_terminal_verdict || review_vote_channel.is_some();
    let _subagent_permit = parent
        .acquire_subagent_permit()
        .await
        .map_err(anyhow::Error::msg)?;

    // Isolation worktrees re-root the child's session cwd; the engine-level
    // sandbox stays anchored at the parent workspace, which already contains
    // the managed `.kcoder/worktrees/` directory.
    let fork_cwd = overrides
        .cwd_override
        .clone()
        .unwrap_or_else(|| parent.cwd.clone());
    let fork_state = if let Some(registry) = parent.state.short_id_registry() {
        let state = AppState::new_with_short_id(fork_cwd.clone(), &registry)?;
        state.set_messages(initial_messages);
        state
    } else {
        AppState::with_messages(fork_cwd.clone(), initial_messages)
    };
    fork_state.set_usage_history_root(parent.state.usage_history_root().as_deref());
    if let Some(project_dir) = parent.state.session_artifact_project_dir() {
        fork_state
            .with_session_artifact_project_dir(project_dir, parent.state.artifact_session_id());
    }
    let allowed_write_paths = overrides.allowed_write_paths.clone();
    let allowed_shell_prefixes = overrides.scoped_allowed_shell_prefixes.clone();
    let block_shell_file_mutation = overrides.block_shell_file_mutation;
    let arrangement_mode = overrides
        .arrangement_mode
        .unwrap_or_else(|| parent.is_arrangement_mode_active());
    let subagent = if let Some(agent_id) = agent_id_override {
        SubagentContext::from_parent_with_agent_id(parent, fork_state, overrides, agent_id)
    } else {
        SubagentContext::from_parent(parent, fork_state, overrides)?
    };
    let agent_id = subagent.agent_id.clone();
    let transcript_path = parent
        .state
        .task(&agent_id)
        .and_then(|task| task.transcript_path)
        .unwrap_or_else(|| parent.state.subagent_transcript_path(&agent_id));
    subagent.state.with_llm_request_history_dir(
        parent.state.subagent_llm_request_history_dir(&agent_id),
        parent.state.artifact_session_id(),
    );
    let tool_names = tools.names();
    parent
        .state
        .record_agent_resolved_tool_allowlist(&agent_id, tool_names.clone())?;
    run_subagent_hook(
        parent,
        kcoder_hooks::HookEvent::SubagentStart,
        &agent_id,
        serde_json::json!({
            "agent_id": agent_id.clone(),
            "max_turns": max_turns,
            "prompt_messages": prompt_message_count,
            "tools": tool_names,
            "cwd": fork_cwd.display().to_string(),
        }),
    )
    .await?;

    let inherited_client_storage = matches!(
        parent.workspace_persistence_mode,
        WorkspacePersistenceMode::Client
    )
    .then(|| {
        Ok((
            parent.session_storage_root.clone(),
            parent.client_storage_owner.clone(),
        ))
    });
    let fork_provider = runtime
        .as_ref()
        .map(|runtime| Arc::clone(&runtime.provider))
        .unwrap_or_else(|| parent.current_provider());
    let fork_settings = runtime
        .as_ref()
        .map(|runtime| runtime.settings.clone())
        .unwrap_or_else(|| crate::recover_read_lock(&parent.settings, "settings").clone());
    let mut forked_engine = QueryEngine::try_new_with_folder_trust_and_project_skill_telemetry(
        fork_provider,
        subagent.state,
        tools,
        subagent.permissions,
        fork_settings,
        parent.memory_manager.as_ref().clone(),
        crate::recover_read_lock(&parent.skill_registry, "skill_registry").clone(),
        parent.effective_user_questioner(),
        fork_cwd.clone(),
        None,
        Some(parent.plugin_snapshot.as_ref().clone()),
        parent.workspace_persistence_mode,
        inherited_client_storage,
        Some(parent.workspace_runtime_services()),
        true,
    )?
    .with_project_user_context_from(parent)
    .with_subagent_system_prompt(subagent.overrides.role_system_prompt.clone())
    .with_subagent_runtime_control(
        parent.state.clone(),
        agent_id.clone(),
        transcript_path.clone(),
    )
    .with_subagent_tools(parent.active_subagent_tools_for_mode(arrangement_mode))
    // The supplied `tools` are already role-filtered for Arrangement worker
    // semantics. Do not put the forked worker engine into main-orchestrator
    // Arrangement mode, or its active registry/system prompt would be replaced
    // by the orchestrator profile and hide edit/write/bash from implementers.
    .with_arrangement_mode(false)
    .with_agent_depth(subagent.depth)
    .with_skill_mutation_actor(subagent.tool_context.skill_mutation_actor.clone())
    .with_allowed_write_paths(allowed_write_paths)
    .with_allowed_shell_prefixes(allowed_shell_prefixes)
    .with_block_shell_file_mutation(block_shell_file_mutation)
    .with_block_dependency_mutation(subagent.overrides.block_dependency_mutation)
    .with_shell_isolation_root(subagent.overrides.shell_isolation_root.clone())
    .with_verifier_test_policy(
        subagent.overrides.verifier_minimum_test_scope,
        subagent.overrides.verifier_require_raw_exit_code,
    )
    .with_verifier_behavior_delta(subagent.overrides.verifier_require_behavior_delta)
    .with_verifier_baseline_root(subagent.overrides.verifier_baseline_root.clone())
    .with_verifier_vote_channel(subagent.overrides.verifier_vote_channel.clone())
    .with_review_vote_channel(subagent.overrides.review_vote_channel.clone())
    .with_terminal_verdict_turn(
        subagent.overrides.verifier_terminal_verdict
            || subagent.overrides.review_vote_channel.is_some(),
    )
    .with_cancel_token(
        subagent
            .tool_context
            .abort_token
            .clone()
            .unwrap_or_default(),
    );
    forked_engine.request_class = parent.request_class;
    if subagent.overrides.isolate_shell_writes {
        let shell_write_root = subagent
            .overrides
            .shell_write_root
            .clone()
            .unwrap_or_else(|| forked_engine.state.cwd());
        let sandbox = verifier_sandbox_from_parent(
            parent.sandbox.as_ref(),
            shell_write_root,
            subagent.overrides.verifier_baseline_root.clone(),
            subagent
                .overrides
                .shell_isolation_root
                .clone()
                .unwrap_or_else(|| forked_engine.state.cwd()),
        );
        forked_engine = forked_engine.with_sandbox(sandbox);
    }

    // Regular sub-agents use the parent task's active runtime; an MoA planner may
    // explicitly carry independent provider settings. Cache-safe snapshots carry
    // context only and do not participate in runtime selection.
    {
        let mut settings = crate::recover_write_lock(&forked_engine.settings, "settings");
        if runtime.is_none() {
            let parent_settings = crate::recover_read_lock(&parent.settings, "settings");
            settings.model = parent_settings.model.clone();
            settings.model_reasoning_effort = parent_settings.model_reasoning_effort.clone();
            settings.max_tokens = parent_settings.max_tokens;
        }
        settings.auto_memory_enabled = false;
        settings.session_memory.update_enabled = false;
        settings.auto_skill_review_enabled = false;
    }
    *crate::recover_write_lock(&forked_engine.active_skills, "active_skills") =
        cache_safe.active_skills.clone();

    let (initial_messages, repaired_initial_sequence) =
        crate::repair_tool_message_sequence(forked_engine.state.messages());
    if repaired_initial_sequence {
        warn!(
            message_count = initial_messages.len(),
            "repaired legacy or interrupted ToolUse/ToolResult sequence before a forked provider request"
        );
        forked_engine.state.set_messages(initial_messages.clone());
    }
    debug_assert!(unmatched_tool_use_ids(&initial_messages).is_empty());

    let auto_prompt = AutoDenyPrompt;
    let artifact_run = artifact_validation::begin(
        parent,
        &forked_engine,
        &agent_id,
        initial_delivery.as_ref(),
        artifact_replay_output.is_some(),
    )
    .await?;
    if let Some(output_text) = artifact_replay_output {
        artifact_validation::finish(parent, &forked_engine, &agent_id, artifact_run).await?;
        return Ok(ForkedAgentResult {
            agent_id,
            messages: forked_engine.state.messages(),
            output_text,
            trusted_tool_results: HashMap::new(),
        });
    }
    write_transcript_checkpoint(&transcript_path, &forked_engine.state.messages()).await?;
    if let Some(delivery) = initial_delivery.as_ref()
        && !parent.state.ack_subagent_delivery(
            &agent_id,
            &delivery.message_id,
            &delivery.lease_id,
        )?
    {
        anyhow::bail!(
            "initial delivery {} disappeared before its transcript checkpoint could be acknowledged",
            delivery.message_id
        );
    }
    if let Some(delivery) = initial_delivery.as_ref() {
        let queue_depth = parent
            .state
            .task(&agent_id)
            .map(|task| task.message_queue.len())
            .unwrap_or_default();
        parent.background_jobs.report_subagent_steer_applied(
            &agent_id,
            &delivery.message_id,
            queue_depth,
        );
    }
    let mut stream = forked_engine.run_turn_stream_with_subagent_finish_reminders(
        &auto_prompt,
        max_turns,
        agent_id.clone(),
    );
    let mut streamed_output_text = String::new();
    let live_view = parent
        .background_jobs
        .live_views
        .register(&agent_id, forked_engine.state.messages());
    let mut trusted_tool_results = HashMap::new();
    let mut trusted_tool_result_bytes = 0usize;
    let mut pending_abort: Option<(String, bool)> = None;
    let mut forced_terminal_output: Option<String> = None;
    let mut current_turn = 1usize;
    let mut advance_turn_on_next_message = false;
    let mut last_progress = Some((1usize, "Waiting for model".to_string()));
    let mut latest_model_text = String::new();
    let mut last_model_detail_emit = std::time::Instant::now()
        .checked_sub(SUBAGENT_MODEL_DETAIL_INTERVAL)
        .unwrap_or_else(std::time::Instant::now);
    parent.report_background_job_progress(&agent_id, "Waiting for model", Some(1), Some(max_turns));

    while let Some(event) = stream.next().await {
        live_view.update(&event, || forked_engine.state.messages());
        record_agent_breaker_event(parent, &agent_id, &event);
        if let EngineEvent::SubagentSteerApplied {
            agent_id: applied_agent_id,
            message_id,
            queue_depth,
        } = &event
        {
            if applied_agent_id == &agent_id {
                parent.background_jobs.report_subagent_steer_applied(
                    applied_agent_id,
                    message_id,
                    *queue_depth,
                );
            } else {
                warn!(
                    expected_agent_id = %agent_id,
                    actual_agent_id = %applied_agent_id,
                    %message_id,
                    "ignored a cross-agent steer-applied event from a forked child"
                );
            }
        }
        if matches!(&event, EngineEvent::AssistantMessageStarted) && advance_turn_on_next_message {
            current_turn = current_turn.saturating_add(1);
            advance_turn_on_next_message = false;
        }
        let progress_message = match &event {
            EngineEvent::AssistantMessageStarted => Some("Receiving model response".to_string()),
            EngineEvent::AssistantThinkingDelta(_) => Some("Thinking".to_string()),
            EngineEvent::AssistantTextDelta(_) => Some("Writing response".to_string()),
            EngineEvent::ToolInputProgress { name, .. } => Some(format!("Preparing {name}")),
            EngineEvent::ToolUseStarted { name, .. } => Some(format!("Running {name}")),
            EngineEvent::ToolResult { name, .. } => Some(format!("Finished {name}")),
            EngineEvent::ToolDenied { name, .. } => Some(format!("Denied {name}")),
            EngineEvent::AssistantMessageDone => Some("Planning next step".to_string()),
            _ => None,
        };
        if let Some(message) = progress_message {
            let turn = current_turn;
            if last_progress.as_ref() != Some(&(turn, message.clone())) {
                parent.report_background_job_progress(
                    &agent_id,
                    &message,
                    Some(turn),
                    Some(max_turns),
                );
                last_progress = Some((turn, message));
            }
        }
        if let EngineEvent::AssistantTextDelta(delta) = &event {
            latest_model_text.push_str(delta);
            const MAX_LATEST_MODEL_CHARS: usize = 2_000;
            let char_count = latest_model_text.chars().count();
            if char_count > MAX_LATEST_MODEL_CHARS {
                latest_model_text = latest_model_text
                    .chars()
                    .skip(char_count - MAX_LATEST_MODEL_CHARS)
                    .collect();
            }
            let now = std::time::Instant::now();
            if subagent_model_detail_due(last_model_detail_emit, now) {
                parent.report_background_job_progress_detail(
                    &agent_id,
                    "Writing response",
                    &latest_model_text,
                    Some(current_turn),
                    Some(max_turns),
                );
                last_model_detail_emit = now;
            }
        }
        if matches!(&event, EngineEvent::AssistantMessageDone) {
            if !latest_model_text.is_empty() {
                parent.report_background_job_progress_detail(
                    &agent_id,
                    "Writing response",
                    &latest_model_text,
                    Some(current_turn),
                    Some(max_turns),
                );
                last_model_detail_emit = std::time::Instant::now();
            }
            // AssistantMessageDone closes one provider response but precedes
            // that response's tool execution. Advance only when the next
            // assistant message actually starts, after any tools complete.
            advance_turn_on_next_message = true;
        }
        if matches!(
            &event,
            EngineEvent::AssistantMessageStarted | EngineEvent::AssistantMessageDone
        ) {
            let checkpoint_messages = forked_engine.state.messages();
            // AssistantMessageDone precedes tool execution, while the next
            // AssistantMessageStarted follows the completed ToolResults from
            // the preceding response. Persist both protocol-complete
            // boundaries so a later hard-abort fallback retains every fully
            // completed tool cycle instead of falling back to the initial user
            // message.
            if unmatched_tool_use_ids(&checkpoint_messages).is_empty() {
                write_transcript_checkpoint(&transcript_path, &checkpoint_messages).await?;
            }
            if matches!(&event, EngineEvent::AssistantMessageDone) {
                checkpoint_agent_usage(parent, &agent_id, &checkpoint_messages);
            }
        }
        match event {
            EngineEvent::AssistantTextDelta(text) => streamed_output_text.push_str(&text),
            EngineEvent::ToolResult { id, name, output } => {
                // Authenticated IDs and trusted results share one source: both are captured by
                // the engine before transcript persistence and cross-checked against
                // VerifierVote verified_tool_use_ids.
                if verifier_terminal_verdict && let Some(channel) = verifier_vote_channel.as_ref() {
                    channel.record_authenticated_tool_use(&id);
                }
                if !trusted_tool_results.contains_key(&id)
                    && trusted_tool_results.len() < MAX_VERIFIER_TRUSTED_TOOL_RESULTS
                    && let Some((output, bytes)) = bounded_verifier_tool_result(&name, output)
                    && trusted_tool_result_bytes.saturating_add(bytes)
                        <= MAX_VERIFIER_TRUSTED_TOOL_RESULTS_BYTES
                {
                    trusted_tool_result_bytes += bytes;
                    trusted_tool_results.insert(id, output);
                }
            }
            EngineEvent::Error(err) | EngineEvent::ProviderFailed { message: err, .. } => {
                if pending_abort.is_some() {
                    // Cancellation can surface an additional provider/tool
                    // error while the engine is still committing interrupted
                    // ToolResults. Keep draining so the protocol is repaired.
                    continue;
                }
                let messages = forked_engine.state.messages();
                if unmatched_tool_use_ids(&messages).is_empty() {
                    write_transcript_checkpoint(&transcript_path, &messages).await?;
                }
                let stop_result = run_subagent_hook(
                    parent,
                    kcoder_hooks::HookEvent::SubagentStop,
                    &agent_id,
                    serde_json::json!({
                        "agent_id": agent_id.clone(),
                        "status": "failed",
                        "error": err.clone(),
                        "output_text": streamed_output_text.clone(),
                    }),
                )
                .await;
                if let Err(hook_error) = stop_result {
                    return Err(anyhow::anyhow!(
                        "forked agent error: {}; additionally {}",
                        err,
                        hook_error
                    ));
                }
                return Err(anyhow::anyhow!("forked agent error: {}", err));
            }
            EngineEvent::MaxTurnsReached { max_turns, .. } => {
                if pending_abort.is_some() {
                    continue;
                }
                if terminal_verdict {
                    let output = if verifier_terminal_verdict {
                        "FLAKY\nThe verifier reached its final decision boundary without an explicit verdict from the evidence already collected, so PASS or FAIL cannot be accepted safely."
                            .to_string()
                    } else {
                        "REVIEW_UNAVAILABLE\nThe critic reached its turn boundary without a valid ReviewVote; runtime will count this as an infrastructure retry, not a semantic reject."
                            .to_string()
                    };
                    forked_engine
                        .state
                        .add_message(Message::assistant_text(output.clone()));
                    forced_terminal_output = Some(output);
                    let messages = forked_engine.state.messages();
                    write_transcript_checkpoint(&transcript_path, &messages).await?;
                    break;
                }
                let messages = forked_engine.state.messages();
                if unmatched_tool_use_ids(&messages).is_empty() {
                    write_transcript_checkpoint(&transcript_path, &messages).await?;
                }
                let stop_result = run_subagent_hook(
                    parent,
                    kcoder_hooks::HookEvent::SubagentStop,
                    &agent_id,
                    serde_json::json!({
                        "agent_id": agent_id.clone(),
                        "status": "max_turns_reached",
                        "max_turns": max_turns,
                        "output_text": streamed_output_text.clone(),
                    }),
                )
                .await;
                if let Err(hook_error) = stop_result {
                    return Err(anyhow::anyhow!(
                        "forked agent reached maximum turns ({}); additionally {}",
                        max_turns,
                        hook_error
                    ));
                }
                return Err(anyhow::Error::new(ForkedAgentMaxTurnsReached { max_turns }));
            }
            EngineEvent::StreamAborted { reason } => {
                let cancelled =
                    reason == "cancelled by user" || forked_engine.cancel_token().is_cancelled();
                // Do not return here. During tool cancellation the engine emits
                // StreamAborted before it writes the synthetic interrupted
                // ToolResults. Dropping the stream now would persist an invalid
                // ToolUse-without-ToolResult transcript.
                pending_abort = Some((reason, cancelled));
                if unmatched_tool_use_ids(&forked_engine.state.messages()).is_empty() {
                    // Provider/idle cancellation has no pending tool protocol
                    // to repair, so there is nothing useful to drain.
                    break;
                }
            }
            _ => {}
        }
    }

    let messages = forked_engine.state.messages();
    write_transcript_checkpoint(&transcript_path, &messages).await?;
    acknowledge_persisted_breaker_steer(parent, &agent_id, &messages)?;
    // A control request may arrive while the final tool-free model response streams.
    // The turn loop may not reach another provider boundary, so claim once more after
    // the final protocol-complete checkpoint; otherwise a later Completed commit could
    // overwrite pause/halt.
    if pending_abort.is_none()
        && let Some(mode) = forked_engine.prepare_subagent_safe_boundary()?
    {
        pending_abort = Some((format!("agent_control:{mode}"), false));
    }
    if let Some((reason, cancelled)) = pending_abort {
        let status = if cancelled { "cancelled" } else { "aborted" };
        let stop_result = run_subagent_hook(
            parent,
            kcoder_hooks::HookEvent::SubagentStop,
            &agent_id,
            serde_json::json!({
                "agent_id": agent_id.clone(),
                "status": status,
                "reason": reason.clone(),
                "messages": messages.len(),
                "output_text": streamed_output_text.clone(),
            }),
        )
        .await;
        if let Err(hook_error) = stop_result {
            return Err(anyhow::Error::new(ForkedAgentAborted {
                reason: format!("{reason}; SubagentStop hook failed: {hook_error}"),
                cancelled,
            }));
        }
        return Err(anyhow::Error::new(ForkedAgentAborted { reason, cancelled }));
    }
    let output_text = verifier_vote_channel
        .as_ref()
        .and_then(|channel| channel.recorded_vote())
        .map(|vote| vote.input.summary.clone())
        .or_else(|| {
            review_vote_channel
                .as_ref()
                .and_then(|channel| channel.recorded_vote())
                .map(|vote| vote.input.summary.clone())
        })
        .or(forced_terminal_output)
        .or_else(|| latest_assistant_response_text(&messages))
        .unwrap_or_else(|| streamed_output_text.clone());
    run_subagent_hook(
        parent,
        kcoder_hooks::HookEvent::SubagentStop,
        &agent_id,
        serde_json::json!({
            "agent_id": agent_id.clone(),
            "status": "completed",
            "messages": messages.len(),
            "output_text": output_text.clone(),
        }),
    )
    .await?;

    persist_orchestrate_agent_evidence(
        parent,
        &agent_id,
        &messages,
        &trusted_tool_results,
        &fork_cwd,
        &output_text,
    )
    .await?;

    artifact_validation::finish(parent, &forked_engine, &agent_id, artifact_run).await?;
    Ok(ForkedAgentResult {
        agent_id,
        messages,
        output_text,
        trusted_tool_results,
    })
}

async fn persist_orchestrate_agent_evidence(
    parent: &QueryEngine,
    agent_id: &str,
    messages: &[Message],
    trusted_tool_results: &HashMap<String, ToolOutput>,
    execution_root: &Path,
    output: &str,
) -> anyhow::Result<()> {
    if !parent.state.session_mode().is_orchestrate() {
        return Ok(());
    }
    let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&parent.cwd);
    let Some(work_id) = store.active_work_id()? else {
        return Ok(());
    };
    let snapshot = store.read_work(&work_id)?;
    let run = AgentRunResult::from_messages_with_trusted_tool_results(
        output.to_string(),
        messages,
        trusted_tool_results,
        false,
        false,
        true,
        true,
    );
    if !run.tool_trace_complete {
        return Ok(());
    }
    let workspace_digest = workspace_evidence_digest(execution_root).await;
    for execution in run.tool_executions {
        if execution.is_error == Some(true) {
            continue;
        }
        let mut evidence_items = Vec::new();
        if matches!(execution.name.as_str(), "bash" | "PowerShell") {
            let Some(command) = execution
                .input
                .get("command")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            evidence_items.push(
                kcoder_state::orchestrate_store::AgentEvidenceKind::ProcessExit {
                    tool: execution.name.clone(),
                    command: command.to_string(),
                    exit_code: execution.process_exit_code,
                    signal: execution.process_signal,
                    cwd: execution
                        .process_cwd
                        .unwrap_or_else(|| execution_root.to_path_buf()),
                    raw_exit_code: execution.raw_exit_code,
                },
            );
        }
        for artifact in execution.artifacts {
            let visual = execution.name == "read"
                && artifact
                    .path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        matches!(
                            extension.to_ascii_lowercase().as_str(),
                            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
                        )
                    });
            evidence_items.push(if visual {
                kcoder_state::orchestrate_store::AgentEvidenceKind::Visual {
                    artifact_path: artifact.path,
                    sha256: artifact.sha256,
                }
            } else {
                kcoder_state::orchestrate_store::AgentEvidenceKind::Artifact {
                    tool: execution.name.clone(),
                    path: artifact.path,
                    sha256: artifact.sha256,
                }
            });
        }
        if execution.name == "SpecValidate" {
            evidence_items.push(kcoder_state::orchestrate_store::AgentEvidenceKind::Schema {
                subject: execution.input.to_string(),
                schema_sha256: format!("{:x}", Sha256::digest(execution.output.as_bytes())),
            });
        }
        if execution.name == "WebFetch"
            && let Some(url) = execution
                .input
                .get("url")
                .or_else(|| execution.input.get("query"))
                .and_then(serde_json::Value::as_str)
        {
            evidence_items.push(
                kcoder_state::orchestrate_store::AgentEvidenceKind::Citation {
                    url: url.to_string(),
                    source_date: None,
                },
            );
        }
        for evidence in evidence_items {
            let record = kcoder_state::orchestrate_store::AgentEvidence {
                evidence_id: String::new(),
                work_id: work_id.clone(),
                revision: snapshot.work.revision,
                plan_sha256: snapshot.work.plan_sha256.clone(),
                agent_id: agent_id.to_string(),
                workspace_digest: workspace_digest.clone(),
                recorded_at: chrono::Utc::now(),
                evidence,
            };
            // A plan tool that creates a new revision invalidates remaining evidence for the
            // old revision in this run. Treat this race as fail-closed without attributing the
            // partial-trace mismatch to agent failure.
            match store.append_evidence(&work_id, record) {
                Ok(saved) => {
                    let evidence_kind = match &saved.evidence {
                        kcoder_state::orchestrate_store::AgentEvidenceKind::ProcessExit {
                            ..
                        } => "process_exit",
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Artifact { .. } => {
                            "artifact"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Citation { .. } => {
                            "citation"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Manual { .. } => {
                            "manual"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Schema { .. } => {
                            "schema"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::Visual { .. } => {
                            "visual"
                        }
                        kcoder_state::orchestrate_store::AgentEvidenceKind::NotApplicable {
                            ..
                        } => "not_applicable",
                    };
                    parent.state.record_orchestrate_runtime_event_after_commit(
                        "evidence_recorded",
                        Some(&work_id),
                        None,
                        Some(agent_id),
                        None,
                        serde_json::json!({
                            "evidence_id": saved.evidence_id,
                            "revision": saved.revision,
                            "evidence_kind": evidence_kind,
                        }),
                    );
                }
                Err(error) => {
                    warn!(%error, %agent_id, "discarding stale Orchestrate evidence");
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

async fn workspace_evidence_digest(root: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(root.to_string_lossy().as_bytes());
    for args in [
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder/orchestrate/**",
        ] as &[&str],
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            ":(exclude).kcoder/orchestrate/**",
        ],
    ] {
        match tokio::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .await
        {
            Ok(output) => {
                digest.update(output.status.code().unwrap_or(-1).to_le_bytes());
                digest.update(&output.stdout);
                digest.update(&output.stderr);
            }
            Err(error) => digest.update(error.to_string().as_bytes()),
        }
    }
    format!("{:x}", digest.finalize())
}

fn latest_assistant_response_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|message| {
        let Message::Assistant { content, .. } = message else {
            return None;
        };
        let text = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        (!text.trim().is_empty()).then_some(text)
    })
}

fn unmatched_tool_use_ids(messages: &[Message]) -> Vec<String> {
    let mut unmatched = Vec::new();

    for (index, message) in messages.iter().enumerate() {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        let tool_use_ids = content
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        if tool_use_ids.is_empty() {
            continue;
        }

        let following_tool_results = messages
            .get(index + 1)
            .and_then(|message| match message {
                Message::User { content } => Some(
                    content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::ToolResult { tool_use_id, .. } => {
                                Some(tool_use_id.as_str())
                            }
                            _ => None,
                        })
                        .collect::<HashSet<_>>(),
                ),
                _ => None,
            })
            .unwrap_or_default();

        unmatched.extend(
            tool_use_ids
                .into_iter()
                .filter(|id| !following_tool_results.contains(id))
                .map(ToOwned::to_owned),
        );
    }

    unmatched
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

impl VerifierRuntimeGuard {
    fn role_system_prompt(&self, base: &str) -> String {
        let cwd = self
            .cwd_override
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<session cwd>".to_string());
        let workspace = self
            .workspace_root
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| cwd.clone());
        let baseline = self
            .baseline_root
            .as_deref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<unavailable>".to_string());
        if self.workspace_root.is_none() {
            return format!(
                "{base}\n\nGoal Pro external-artifact runtime boundary (authoritative):\n- Start directory: {cwd}\n- Candidate/Baseline git worktree isolation is disabled by the selected verification policy. Do not invent a repository diff or claim a pristine-baseline comparison.\n- Verify the artifact in the external environment named by the objective. For container tasks, run the concrete target command through one direct `docker exec` or `podman exec` Bash call and preserve the container process's raw exit code; do not pipe, filter, append commands after the test, or mask failures.\n- Inspect the requested deliverables and every stated constraint. A main-agent report is context, never proof by itself.\n- Do not modify the deliverable while verifying. If the external environment or required verification command is unavailable, vote flaky rather than pass.\n- Apply this verdict order exactly: PASS only with current executable evidence and a complete artifact audit; FAIL for a concrete correctness gap or failing target check; FLAKY only when the required external verification cannot be obtained.\n- The final response's first non-empty line must be exactly PASS, FAIL, or FLAKY."
            );
        }
        let behavior_delta = if self.require_behavior_delta {
            "\n- Behavior-delta gate is active. In addition to a successful target suite, run one issue-specific direct `python -c` probe first in the candidate, then rerun the exact same command with Bash `workdir` set to the pristine baseline. The command must contain the assertion message `KCODER_BEHAVIOR_DELTA`: candidate exits 0; baseline exits exactly 1 with terminal line `AssertionError: KCODER_BEHAVIOR_DELTA`. Put imports and environment setup before that assertion. If the old target behavior raises an expected business exception, catch only that concrete exception and convert it with `raise AssertionError(\"KCODER_BEHAVIOR_DELTA\") from None`; never catch ImportError, timeout, crash, or arbitrary Exception as delta. The probe must call the affected runtime API, leave the workspace unchanged, and avoid pipes/redirection/failure masking. A baseline exit 0 means the behavior already existed at unmodified HEAD and is regression evidence only, never credit for this diff. Inspect callers, early interception branches, and error remapping before attributing the behavior to the changed code."
        } else {
            ""
        };
        format!(
            "{base}\n\nGoal Pro runtime boundary (authoritative):\n- Isolated candidate repository: {workspace}\n- Start directory: {cwd}\n- Pristine baseline repository (read-only comparison): {baseline}\n- Run `pwd` first, then use this isolated repository and relative paths for every diff, search, import, and test. Absolute source paths copied from the parent transcript or recent evidence are stale/read-only context and MUST NOT be used for validation.\n- Read `issue.md` at the isolated repository root when present, then inspect the complete diff and search the entire repository for every removed/replaced API name, option key, literal, and related symbol. Inspect all relevant hits and sibling consumers such as clients, serializers, constants, adapters, and backends. A minimal reproduction or a suite in which the affected tests were skipped is insufficient.\n- Distinguish root-cause coverage from symptom coverage: state the invariant being repaired and test at least one adjacent/alternate path. Treat test collection import errors and missing candidate symbols as candidate failures unless evidence proves they are baseline-only.\n- If a candidate target suite fails and you suspect a pre-existing environment failure, rerun the exact same command once with Bash `workdir` set to the pristine baseline path above. Do not put `cd` or the baseline path inside the command: the candidate and baseline command strings must be identical. The machine gate accepts the failure only when both commands have matching raw exit codes and normalized failure evidence; do not create another baseline, stash, archive, copy, or worktree yourself.{behavior_delta}\n- If importing the source tree requires a native extension build, the only writable preparation recipe is direct `python setup.py build_ext --inplace` with optional bounded parallelism. Run the exact same recipe separately in candidate and baseline using Bash `workdir`; both builds must succeed before their test/probe evidence. Never copy a binary from the parent or between worktrees. The baseline becomes read-only again immediately after that one command.\n- Apply this verdict order exactly. PASS when the candidate has at least one successful focused functional check demonstrating the requested repair, the diff/root-cause audit finds no gap, and every nonzero broader check is proven baseline-only by the exact same command, raw exit code, and normalized failure evidence. A proven baseline-only failure is not a reason for FAIL or FLAKY. FAIL when the candidate introduces a failure absent from the baseline, adds candidate-only failure evidence, or the implementation/audit exposes a real correctness gap. FLAKY only when required tests or dependencies are unavailable, an exact candidate/baseline comparison cannot be obtained or paired, or no successful candidate-side functional check demonstrates the repair.\n- Run test commands directly. The runtime rejects pipelines, trailing commands, failure masking, shell-level directory changes, absolute test selectors, and narrower selectors than the configured policy before execution; correct the command once instead of retrying variants.\n- Do not spend repeated turns repairing the shared environment. Diagnose an unavailable dependency once and return FLAKY. Aim to finish the audit within 12 internal turns unless one already-started target suite is still running.\n- The final response's first non-empty line must be exactly PASS, FAIL, or FLAKY."
        )
    }
}

/// Goal Pro verifier tool surface: a read-only role surface plus a session-local
/// VerifierVote. A Goal Pro verifier always uses read-only role tools; Arrangement
/// cannot add edit/write back. VerifierVote belongs to no base registry and is
/// attached only after role filtering, so primary agents and other roles never receive it.
fn verifier_session_tools(base_tools: &ToolRegistry) -> ToolRegistry {
    filter_tools_for_agent_kind(base_tools, AgentKind::Verifier, true)
        .register(kcoder_tools::VerifierVoteTool)
}

fn orchestrate_role_prompt(agent_kind: AgentKind, persona: Option<&str>) -> String {
    if let Some(persona) = persona {
        let prompt = match persona {
            "junior" => include_str!("../prompts/orchestrate/junior.md"),
            "oracle" => include_str!("../prompts/orchestrate/oracle.md"),
            "librarian" => include_str!("../prompts/orchestrate/librarian.md"),
            "critic" => include_str!("../prompts/orchestrate/critic.md"),
            _ => agent_kind.system_prompt(),
        };
        return format!(
            "{}\n\nBase-role security boundary (authoritative): {}",
            prompt.trim(),
            agent_kind.system_prompt()
        );
    }
    match agent_kind {
        AgentKind::Plan => format!(
            "{}\n\nOrchestrate plan contract:\n{}",
            agent_kind.system_prompt(),
            include_str!("../prompts/orchestrate/plan_addendum.md").trim()
        ),
        AgentKind::Verifier => format!(
            "{}\n\nOrchestrate verifier contract:\n{}",
            agent_kind.system_prompt(),
            include_str!("../prompts/orchestrate/verifier_addendum.md").trim()
        ),
        _ => agent_kind.system_prompt().to_string(),
    }
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

fn resolved_profile_fingerprint(input: ProfileFingerprintInput<'_>) -> String {
    let mut tool_names = input.tools.names();
    tool_names.sort();
    let payload = serde_json::json!({
        "roster_name": input.persona,
        "base_role": input.agent_kind.as_str(),
        "prompt_sha256": format!("{:x}", Sha256::digest(input.role_prompt.as_bytes())),
        "effective_tools": tool_names,
        "runtime_provider": input.runtime_provider,
        "runtime_model": input.runtime_model,
        "runtime_profile": input.runtime_selection.and_then(|selection| selection.profile.as_deref()),
        "runtime_provider_override": input.runtime_selection.and_then(|selection| selection.provider.as_deref()),
        "runtime_model_override": input.runtime_selection.and_then(|selection| selection.model.as_deref()),
        "context_mode": input.context_mode,
        "context_turns": input.context_turns,
        "work_id": input.work_id,
        "parent_session_id": input.parent_session_id,
    });
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&payload).unwrap_or_default())
    )
}

/// Validate before consumption: the vote must come from an actually executed
/// VerifierVote call in this session transcript, and every referenced tool ID must
/// belong to the engine-authenticated set. Discard invalid votes and let the caller
/// fall back to text-verdict parsing.
fn validated_verifier_vote(
    channel: &kcoder_tools::VerifierVoteChannel,
    messages: &[Message],
) -> Option<kcoder_tools::VerifierVoteRecord> {
    let vote = channel.recorded_vote()?;
    let mut vote_tool_use_seen = false;
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            if let ContentBlock::ToolUse { id, name, .. } = block
                && name == kcoder_tools::VERIFIER_VOTE_TOOL_NAME
                && *id == vote.tool_use_id
            {
                vote_tool_use_seen = true;
            }
        }
    }
    if !vote_tool_use_seen {
        warn!(
            tool_use_id = %vote.tool_use_id,
            "discarding verifier vote: its tool_use id is missing from the verifier transcript"
        );
        return None;
    }
    if let Some(ids) = vote.input.verified_tool_use_ids.as_ref() {
        let unknown = ids
            .iter()
            .filter(|id| !channel.is_authenticated_tool_use(id))
            .cloned()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            warn!(
                unknown_ids = ?unknown,
                "discarding verifier vote: verified_tool_use_ids left the engine-authenticated set"
            );
            return None;
        }
    }
    Some(vote)
}

const MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_VERIFIER_UNTRACKED_COPY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_VERIFIER_ISSUE_CONTEXT_BYTES: u64 = 1024 * 1024;
const MAX_VERIFIER_BASELINE_BUNDLE_BYTES: usize = 256 * 1024 * 1024;

fn verifier_ignores_untracked_path(path: &str) -> bool {
    // These directories contain runtime state, not candidate patches. In particular,
    // pytest basetemp creates many symlinks named after tests; do not report them as test modifications.
    path.replace('\\', "/")
        .split('/')
        .map(str::to_ascii_lowercase)
        .any(|component| {
            component == ".kcoder"
                || component == ".pytest_cache"
                || component.starts_with("pytest-of-")
        })
}

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

impl Drop for VerifierWorkspaceIsolation {
    fn drop(&mut self) {
        let mut all_removed = true;
        for worktree in [&self.worktree_root, &self.baseline_root] {
            all_removed &= verifier_git_command()
                .arg("-C")
                .arg(verifier_git_path_arg(&self.source_root))
                .args(["worktree", "remove", "--force"])
                .arg(verifier_git_path_arg(worktree))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .as_std_mut()
                .status()
                .is_ok_and(|status| status.success());
        }
        if !all_removed {
            let _ = verifier_git_command()
                .arg("-C")
                .arg(verifier_git_path_arg(&self.source_root))
                .args(["worktree", "prune"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .as_std_mut()
                .status();
        }
    }
}

fn windows_verifier_git_argument(value: &str) -> std::borrow::Cow<'_, str> {
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        return format!("//{}", unc.replace('\\', "/")).into();
    }
    if let Some(dos) = value.strip_prefix(r"\\?\")
        && dos.as_bytes().get(1) == Some(&b':')
    {
        return dos.replace('\\', "/").into();
    }
    value.into()
}

fn verifier_git_argument(value: &str) -> std::borrow::Cow<'_, str> {
    if cfg!(windows) {
        windows_verifier_git_argument(value)
    } else {
        value.into()
    }
}

fn verifier_git_path_arg(path: &Path) -> std::ffi::OsString {
    path.to_str()
        .map(|value| std::ffi::OsString::from(verifier_git_argument(value).as_ref()))
        .unwrap_or_else(|| path.as_os_str().to_owned())
}

fn verifier_git_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("git");
    // Git for Windows expects DOS/UNC arguments, not Win32 verbatim paths.
    // Long-path support remains command-local and never changes user Git config.
    #[cfg(windows)]
    command
        .args(["-c", "core.longpaths=true"])
        .creation_flags(0x0800_0000);
    command.stdin(Stdio::null()).kill_on_drop(true);
    command
}

async fn verifier_git_working_directory(private_root: &Path) -> Result<PathBuf, AgentError> {
    // The private root retains its DELETE-capable identity handle for secure
    // cleanup. Windows chdir opens a conflicting handle, so run Git in a child
    // directory without releasing the root capability or changing its ACL.
    let directory = private_root.join("git-command");
    tokio::fs::create_dir(&directory).await.map_err(|error| {
        AgentError::Execution(format!(
            "failed to create private Git working directory: {error}"
        ))
    })?;
    Ok(directory)
}

async fn verifier_git_output(cwd: &std::path::Path, args: &[&str]) -> Result<Vec<u8>, AgentError> {
    let output = verifier_git_command()
        .arg("-C")
        .arg(verifier_git_path_arg(cwd))
        .args(
            args.iter()
                .map(|value| verifier_git_argument(value).into_owned()),
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .output()
        .await
        .map_err(|error| {
            AgentError::Execution(format!("failed to prepare verifier workspace: {error}"))
        })?;
    if !output.status.success() {
        return Err(AgentError::Execution(format!(
            "failed to prepare verifier workspace with `git {}`: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

async fn verifier_snapshot_git_output(
    git_dir: &Path,
    work_tree: Option<&Path>,
    index_file: Option<&Path>,
    args: &[&str],
) -> Result<Vec<u8>, AgentError> {
    let mut command = verifier_git_command();
    command
        .args(
            args.iter()
                .map(|value| verifier_git_argument(value).into_owned()),
        )
        .env("GIT_DIR", verifier_git_path_arg(git_dir))
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            verifier_git_path_arg(&git_dir.join("kcoder-no-global-config")),
        )
        .env("LC_ALL", "C");
    if let Some(work_tree) = work_tree {
        command.env("GIT_WORK_TREE", verifier_git_path_arg(work_tree));
    }
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", verifier_git_path_arg(index_file));
    }
    let output = command.output().await.map_err(|error| {
        AgentError::Execution(format!(
            "failed to prepare private verifier snapshot: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(AgentError::Execution(format!(
            "failed to prepare private verifier snapshot with `git {}`: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(output.stdout)
}

fn verifier_snapshot_pathspec() -> [&'static str; 6] {
    [
        "add",
        "-A",
        "--",
        ".",
        ":(exclude).kcoder",
        ":(exclude).kcoder/**",
    ]
}

async fn capture_verifier_workspace_baseline(
    source_cwd: &Path,
    bundle_path: &Path,
) -> Result<Option<VerifierWorkspaceBaseline>, AgentError> {
    let git_root = match verifier_git_output(source_cwd, &["rev-parse", "--show-toplevel"]).await {
        Ok(output) => Some(PathBuf::from(
            String::from_utf8(output)
                .map_err(|_| {
                    AgentError::Execution("git workspace root is not valid UTF-8".to_string())
                })?
                .trim(),
        )),
        Err(_) => None,
    };
    if let Some(git_root) = git_root.as_deref()
        && verifier_git_output(git_root, &["rev-parse", "--verify", "HEAD^{commit}"])
            .await
            .is_ok()
    {
        return Ok(None);
    }

    let source_root =
        dunce::canonicalize(git_root.as_deref().unwrap_or(source_cwd)).map_err(|error| {
            AgentError::Execution(format!(
                "failed to resolve Goal Pro baseline source `{}`: {error}",
                source_cwd.display()
            ))
        })?;
    let temporary =
        kcoder_config::create_private_temp_dir("kcoder-goal-capture").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate Goal Pro baseline capture directory: {error:#}"
            ))
        })?;
    let repository = temporary.path().join("repository.git");
    let index = temporary.path().join("baseline.index");
    let temporary_bundle = temporary.path().join("baseline.bundle");
    let git_cwd = verifier_git_working_directory(temporary.path()).await?;
    verifier_git_output(
        &git_cwd,
        &[
            "init",
            "--bare",
            repository.to_str().ok_or_else(|| {
                AgentError::Execution("Goal Pro baseline repository path is not UTF-8".to_string())
            })?,
        ],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        Some(&source_root),
        Some(&index),
        &["read-tree", "--empty"],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        Some(&source_root),
        Some(&index),
        &verifier_snapshot_pathspec(),
    )
    .await?;
    let tree = String::from_utf8(
        verifier_snapshot_git_output(
            &repository,
            Some(&source_root),
            Some(&index),
            &["write-tree"],
        )
        .await?,
    )
    .map_err(|_| AgentError::Execution("Goal Pro baseline tree id is not UTF-8".to_string()))?;
    let tree = tree.trim();
    let commit_output = verifier_git_command()
        .args(["commit-tree", tree, "-m", "KCoder Goal Pro baseline"])
        .env("GIT_DIR", verifier_git_path_arg(&repository))
        .env("GIT_AUTHOR_NAME", "KCoder")
        .env("GIT_AUTHOR_EMAIL", "kcoder@localhost")
        .env("GIT_COMMITTER_NAME", "KCoder")
        .env("GIT_COMMITTER_EMAIL", "kcoder@localhost")
        .env("GIT_AUTHOR_DATE", "2000-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2000-01-01T00:00:00Z")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            verifier_git_path_arg(&repository.join("kcoder-no-global-config")),
        )
        .env("LC_ALL", "C")
        .output()
        .await
        .map_err(|error| {
            AgentError::Execution(format!("failed to commit Goal Pro baseline: {error}"))
        })?;
    if !commit_output.status.success() {
        return Err(AgentError::Execution(format!(
            "failed to commit Goal Pro baseline: {}",
            String::from_utf8_lossy(&commit_output.stderr).trim()
        )));
    }
    let commit = String::from_utf8(commit_output.stdout)
        .map_err(|_| AgentError::Execution("Goal Pro baseline commit is not UTF-8".to_string()))?
        .trim()
        .to_string();
    verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &["update-ref", "refs/heads/baseline", &commit],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &[
            "bundle",
            "create",
            temporary_bundle.to_str().ok_or_else(|| {
                AgentError::Execution("Goal Pro baseline bundle path is not UTF-8".to_string())
            })?,
            "refs/heads/baseline",
        ],
    )
    .await?;
    let bytes = tokio::fs::read(&temporary_bundle).await.map_err(|error| {
        AgentError::Execution(format!("failed to read Goal Pro baseline bundle: {error}"))
    })?;
    if bytes.len() > MAX_VERIFIER_BASELINE_BUNDLE_BYTES {
        return Err(AgentError::Execution(
            "Goal Pro baseline bundle exceeds the 256 MiB limit".to_string(),
        ));
    }
    let bundle_sha256 = format!("{:x}", Sha256::digest(&bytes));
    let parent = bundle_path.parent().ok_or_else(|| {
        AgentError::Execution("Goal Pro baseline bundle has no parent directory".to_string())
    })?;
    let file_name = bundle_path.file_name().ok_or_else(|| {
        AgentError::Execution("Goal Pro baseline bundle has no file name".to_string())
    })?;
    kcoder_config::PrivateDirectory::open_or_create(parent)
        .and_then(|directory| directory.atomic_replace(file_name, &bytes))
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to persist Goal Pro baseline bundle `{}`: {error:#}",
                bundle_path.display()
            ))
        })?;
    Ok(Some(VerifierWorkspaceBaseline {
        bundle_path: bundle_path.to_path_buf(),
        bundle_sha256,
        commit,
        source_root,
    }))
}

/// Save a baseline for an artifact goal without a Git HEAD before the primary agent receives its first mutable turn.
pub async fn ensure_goal_pro_workspace_baseline(
    state: &AppState,
    goal: &Goal,
) -> Result<Goal, AgentError> {
    let policy = &goal.verifier_selection.verification;
    let requires_workspace_baseline = goal.mode.is_strict()
        && goal.verification_kind.is_artifact()
        && (!policy.allow_workspace_changes || policy.require_behavior_delta);
    if !requires_workspace_baseline || goal.workspace_baseline.is_some() {
        return Ok(goal.clone());
    }
    let bundle_path = state.goal_workspace_baseline_bundle_path(&goal.goal_id);
    let Some(captured) = capture_verifier_workspace_baseline(&state.cwd(), &bundle_path).await?
    else {
        return Ok(goal.clone());
    };
    state
        .set_goal_workspace_baseline_if_matches(
            &goal.goal_id,
            goal.revision,
            GoalWorkspaceBaseline {
                bundle_path: captured.bundle_path,
                bundle_sha256: captured.bundle_sha256,
                commit: captured.commit,
                source_root: captured.source_root,
            },
        )
        .ok_or_else(|| {
            AgentError::Execution(
                "Goal changed while its private verifier baseline was being captured".to_string(),
            )
        })
}

async fn read_verifier_workspace_baseline_bundle(
    baseline: &VerifierWorkspaceBaseline,
) -> Result<Vec<u8>, AgentError> {
    let path = baseline.bundle_path.clone();
    let bytes = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("baseline bundle has no parent directory"))?;
        let name = path
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("baseline bundle has no file name"))?;
        let directory = kcoder_config::PrivateDirectory::open_existing(parent)?;
        let mut file = directory.open_regular_file(name)?;
        let mut bytes = Vec::new();
        file.by_ref()
            .take((MAX_VERIFIER_BASELINE_BUNDLE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= MAX_VERIFIER_BASELINE_BUNDLE_BYTES,
            "baseline bundle exceeds the 256 MiB limit"
        );
        Ok(bytes)
    })
    .await
    .map_err(|error| AgentError::Execution(format!("Goal Pro baseline reader failed: {error}")))?
    .map_err(|error| {
        AgentError::Execution(format!(
            "failed to read Goal Pro baseline bundle: {error:#}"
        ))
    })?;
    let actual_sha256 = format!("{:x}", Sha256::digest(&bytes));
    if actual_sha256 != baseline.bundle_sha256 {
        return Err(AgentError::Execution(format!(
            "Goal Pro baseline bundle SHA-256 mismatch: expected {}, got {actual_sha256}",
            baseline.bundle_sha256
        )));
    }
    Ok(bytes)
}

async fn apply_verifier_candidate_patch(
    worktree_root: &Path,
    diff: &[u8],
) -> Result<(), AgentError> {
    if diff.is_empty() {
        return Ok(());
    }
    let mut child = verifier_git_command()
        .arg("-C")
        .arg(verifier_git_path_arg(worktree_root))
        .args(["apply", "--binary", "--whitespace=nowarn", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to apply candidate patch in verifier worktree: {error}"
            ))
        })?;
    child
        .stdin
        .take()
        .ok_or_else(|| {
            AgentError::Execution("verifier git apply stdin is unavailable".to_string())
        })?
        .write_all(diff)
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to stream candidate patch into verifier worktree: {error}"
            ))
        })?;
    let output = child.wait_with_output().await.map_err(|error| {
        AgentError::Execution(format!(
            "failed to apply candidate patch in verifier worktree: {error}"
        ))
    })?;
    if !output.status.success() {
        return Err(AgentError::Execution(format!(
            "candidate patch could not be reproduced in verifier worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

async fn copy_verifier_issue_context(
    source_root: &Path,
    worktree_root: &Path,
) -> Result<(), AgentError> {
    let source_issue = source_root.join("issue.md");
    let target_issue = worktree_root.join("issue.md");
    if target_issue.exists() {
        return Ok(());
    }
    let Ok(metadata) = tokio::fs::symlink_metadata(&source_issue).await else {
        return Ok(());
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.len() > MAX_VERIFIER_ISSUE_CONTEXT_BYTES {
        return Err(AgentError::Execution(
            "issue.md exceeds the 1 MiB verifier context limit".to_string(),
        ));
    }
    tokio::fs::copy(&source_issue, &target_issue)
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to copy verifier issue context `{}`: {error}",
                source_issue.display()
            ))
        })?;
    tokio::fs::set_permissions(&target_issue, metadata.permissions())
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to preserve verifier issue context permissions: {error}"
            ))
        })?;
    Ok(())
}

async fn create_snapshot_verifier_workspace_isolation(
    source_cwd: &Path,
    baseline: &VerifierWorkspaceBaseline,
) -> Result<VerifierWorkspaceIsolation, AgentError> {
    let canonical_cwd = dunce::canonicalize(source_cwd).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve verifier source cwd `{}`: {error}",
            source_cwd.display()
        ))
    })?;
    let canonical_source_root = dunce::canonicalize(&baseline.source_root).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve Goal Pro baseline source `{}`: {error}",
            baseline.source_root.display()
        ))
    })?;
    let relative_cwd = canonical_cwd
        .strip_prefix(&canonical_source_root)
        .map_err(|_| {
            AgentError::Execution(
                "current verifier cwd is outside the captured Goal Pro baseline source".to_string(),
            )
        })?;
    let bundle = read_verifier_workspace_baseline_bundle(baseline).await?;
    let private_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-worktree").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier worktree: {error:#}"
            ))
        })?;
    let baseline_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-baseline").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier baseline: {error:#}"
            ))
        })?;
    let repository_root = kcoder_config::create_private_temp_dir("kcoder-goal-repository")
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier repository: {error:#}"
            ))
        })?;
    let private_bundle = repository_root.path().join("baseline.bundle");
    let repository = repository_root.path().join("repository.git");
    let candidate_index = repository_root.path().join("candidate.index");
    let git_cwd = verifier_git_working_directory(repository_root.path()).await?;
    tokio::fs::write(&private_bundle, bundle)
        .await
        .map_err(|error| {
            AgentError::Execution(format!(
                "failed to materialize private Goal Pro baseline bundle: {error}"
            ))
        })?;
    verifier_git_output(
        &git_cwd,
        &[
            "clone",
            "--bare",
            private_bundle.to_str().ok_or_else(|| {
                AgentError::Execution("private baseline bundle path is not UTF-8".to_string())
            })?,
            repository.to_str().ok_or_else(|| {
                AgentError::Execution("private baseline repository path is not UTF-8".to_string())
            })?,
        ],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &["cat-file", "-e", &format!("{}^{{commit}}", baseline.commit)],
    )
    .await?;

    let worktree_root = private_root.path().join("workspace");
    let baseline_worktree_root = baseline_root.path().join("workspace");
    verifier_git_output(
        &repository,
        &[
            "worktree",
            "add",
            "--detach",
            worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier worktree path is not valid UTF-8".to_string())
            })?,
            &baseline.commit,
        ],
    )
    .await?;
    if let Err(error) = verifier_git_output(
        &repository,
        &[
            "worktree",
            "add",
            "--detach",
            baseline_worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier baseline path is not valid UTF-8".to_string())
            })?,
            &baseline.commit,
        ],
    )
    .await
    {
        let _ = verifier_git_output(
            &repository,
            &[
                "worktree",
                "remove",
                "--force",
                worktree_root.to_str().unwrap_or_default(),
            ],
        )
        .await;
        return Err(error);
    }

    verifier_snapshot_git_output(
        &repository,
        Some(&canonical_source_root),
        Some(&candidate_index),
        &["read-tree", &baseline.commit],
    )
    .await?;
    verifier_snapshot_git_output(
        &repository,
        Some(&canonical_source_root),
        Some(&candidate_index),
        &verifier_snapshot_pathspec(),
    )
    .await?;
    let candidate_tree = String::from_utf8(
        verifier_snapshot_git_output(
            &repository,
            Some(&canonical_source_root),
            Some(&candidate_index),
            &["write-tree"],
        )
        .await?,
    )
    .map_err(|_| AgentError::Execution("candidate snapshot tree id is not UTF-8".to_string()))?;
    let candidate_tree = candidate_tree.trim();
    let diff = verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &[
            "diff",
            "--binary",
            "--full-index",
            &baseline.commit,
            candidate_tree,
            "--",
            ".",
        ],
    )
    .await?;
    if diff.len() > MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES {
        return Err(AgentError::Execution(
            "verifier workspace diff exceeds the 64 MiB snapshot limit".to_string(),
        ));
    }
    apply_verifier_candidate_patch(&worktree_root, &diff).await?;
    copy_verifier_issue_context(&canonical_source_root, &worktree_root).await?;
    let changed_paths = verifier_snapshot_git_output(
        &repository,
        None,
        None,
        &[
            "diff",
            "--name-only",
            "-z",
            &baseline.commit,
            candidate_tree,
            "--",
            ".",
        ],
    )
    .await?
    .split(|byte| *byte == 0)
    .filter(|path| !path.is_empty())
    .map(|path| String::from_utf8_lossy(path).into_owned())
    .filter(|path| !verifier_ignores_untracked_path(path))
    .collect();

    Ok(VerifierWorkspaceIsolation {
        _private_root: private_root,
        _baseline_root: baseline_root,
        _repository_root: Some(repository_root),
        source_root: repository,
        cwd: worktree_root.join(relative_cwd),
        worktree_root,
        baseline_root: baseline_worktree_root,
        changed_paths,
    })
}

async fn create_verifier_workspace_isolation(
    source_cwd: &Path,
    baseline: Option<&VerifierWorkspaceBaseline>,
) -> Result<VerifierWorkspaceIsolation, AgentError> {
    match baseline {
        Some(baseline) => create_snapshot_verifier_workspace_isolation(source_cwd, baseline)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "goal_pro_workspace_baseline_unavailable: the captured private baseline cannot be reconstructed; clear and recreate the Goal Pro before continuing: {error}"
                ))
            }),
        None => create_git_verifier_workspace_isolation(source_cwd).await,
    }
}

async fn create_git_verifier_workspace_isolation(
    source_cwd: &std::path::Path,
) -> Result<VerifierWorkspaceIsolation, AgentError> {
    let source_root = PathBuf::from(
        String::from_utf8(
            verifier_git_output(source_cwd, &["rev-parse", "--show-toplevel"])
                .await
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "goal_pro_workspace_baseline_missing: this Goal has no captured private baseline and its workspace is not a usable Git repository; clear and recreate the Goal Pro so KCoder can capture a baseline before work starts: {error}"
                    ))
                })?,
        )
        .map_err(|_| AgentError::Execution("git workspace root is not valid UTF-8".to_string()))?
        .trim(),
    );
    let canonical_cwd = dunce::canonicalize(source_cwd).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve verifier source cwd `{}`: {error}",
            source_cwd.display()
        ))
    })?;
    let canonical_root = dunce::canonicalize(&source_root).map_err(|error| {
        AgentError::Execution(format!(
            "failed to resolve verifier repository `{}`: {error}",
            source_root.display()
        ))
    })?;
    verifier_git_output(
        &canonical_root,
        &["rev-parse", "--verify", "HEAD^{commit}"],
    )
    .await
    .map_err(|error| {
        AgentError::Execution(format!(
            "goal_pro_workspace_baseline_missing: this Goal has no captured private baseline and its Git repository has no usable HEAD; clear and recreate the Goal Pro so KCoder can capture a baseline before work starts: {error}"
        ))
    })?;
    let relative_cwd = canonical_cwd.strip_prefix(&canonical_root).map_err(|_| {
        AgentError::Execution("verifier cwd is outside its git repository".to_string())
    })?;
    let private_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-worktree").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier worktree: {error:#}"
            ))
        })?;
    let worktree_root = private_root.path().join("workspace");
    let baseline_root =
        kcoder_config::create_private_temp_dir("kcoder-goal-baseline").map_err(|error| {
            AgentError::Execution(format!(
                "failed to allocate isolated verifier baseline: {error:#}"
            ))
        })?;
    let baseline_worktree_root = baseline_root.path().join("workspace");
    verifier_git_output(
        &canonical_root,
        &[
            "worktree",
            "add",
            "--detach",
            worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier worktree path is not valid UTF-8".to_string())
            })?,
            "HEAD",
        ],
    )
    .await?;
    if let Err(error) = verifier_git_output(
        &canonical_root,
        &[
            "worktree",
            "add",
            "--detach",
            baseline_worktree_root.to_str().ok_or_else(|| {
                AgentError::Execution("verifier baseline path is not valid UTF-8".to_string())
            })?,
            "HEAD",
        ],
    )
    .await
    {
        let _ = verifier_git_output(
            &canonical_root,
            &[
                "worktree",
                "remove",
                "--force",
                worktree_root.to_str().unwrap_or_default(),
            ],
        )
        .await;
        return Err(error);
    }

    let mut isolation = VerifierWorkspaceIsolation {
        _private_root: private_root,
        _baseline_root: baseline_root,
        _repository_root: None,
        source_root: canonical_root.clone(),
        cwd: worktree_root.join(relative_cwd),
        worktree_root,
        baseline_root: baseline_worktree_root,
        changed_paths: Vec::new(),
    };
    let diff = verifier_git_output(
        &canonical_root,
        &[
            "diff",
            "--binary",
            "--full-index",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder",
            ":(exclude).kcoder/**",
        ],
    )
    .await?;
    if !diff.is_empty() {
        let mut child = verifier_git_command()
            .arg("-C")
            .arg(verifier_git_path_arg(&isolation.worktree_root))
            .args(["apply", "--binary", "--whitespace=nowarn", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to apply candidate patch in verifier worktree: {error}"
                ))
            })?;
        child
            .stdin
            .take()
            .ok_or_else(|| {
                AgentError::Execution("verifier git apply stdin is unavailable".to_string())
            })?
            .write_all(&diff)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to stream candidate patch into verifier worktree: {error}"
                ))
            })?;
        let output = child.wait_with_output().await.map_err(|error| {
            AgentError::Execution(format!(
                "failed to apply candidate patch in verifier worktree: {error}"
            ))
        })?;
        if !output.status.success() {
            return Err(AgentError::Execution(format!(
                "candidate patch could not be reproduced in verifier worktree: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
    }

    let untracked = verifier_git_output(
        &canonical_root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
    )
    .await?;
    let mut copied_bytes = 0u64;
    for raw_path in untracked.split(|byte| *byte == 0) {
        if raw_path.is_empty() {
            continue;
        }
        let relative = String::from_utf8_lossy(raw_path);
        if verifier_ignores_untracked_path(&relative) {
            continue;
        }
        let source = canonical_root.join(relative.as_ref());
        let target = isolation.worktree_root.join(relative.as_ref());
        let metadata = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to inspect untracked candidate file `{}`: {error}",
                    source.display()
                ))
            })?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to create verifier candidate directory `{}`: {error}",
                    parent.display()
                ))
            })?;
        }
        if metadata.file_type().is_symlink() {
            let link_target = tokio::fs::read_link(&source).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to read untracked candidate symlink `{}`: {error}",
                    source.display()
                ))
            })?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link_target, &target).map_err(|error| {
                AgentError::Execution(format!(
                    "failed to copy untracked candidate symlink `{}`: {error}",
                    source.display()
                ))
            })?;
            #[cfg(windows)]
            {
                let target_is_dir = tokio::fs::metadata(&source)
                    .await
                    .is_ok_and(|metadata| metadata.is_dir());
                let result = if target_is_dir {
                    std::os::windows::fs::symlink_dir(link_target, &target)
                } else {
                    std::os::windows::fs::symlink_file(link_target, &target)
                };
                result.map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to copy untracked candidate symlink `{}`: {error}",
                        source.display()
                    ))
                })?;
            }
        } else if metadata.is_file() {
            copied_bytes = copied_bytes.saturating_add(metadata.len());
            if copied_bytes > MAX_VERIFIER_UNTRACKED_COPY_BYTES {
                return Err(AgentError::Execution(
                    "untracked candidate files exceed the 256 MiB verifier isolation limit"
                        .to_string(),
                ));
            }
            tokio::fs::copy(&source, &target).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to copy untracked candidate file `{}`: {error}",
                    source.display()
                ))
            })?;
            tokio::fs::set_permissions(&target, metadata.permissions())
                .await
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to preserve verifier candidate permissions `{}`: {error}",
                        source.display()
                    ))
                })?;
        }
    }
    // Some evaluation harnesses place an ignored issue.md at the repository root,
    // causing ordinary untracked-file queries to omit verifier context. Copy only
    // the context file without counting it in candidate changes or workspace fingerprints.
    let source_issue = canonical_root.join("issue.md");
    let target_issue = isolation.worktree_root.join("issue.md");
    if !target_issue.exists()
        && let Ok(metadata) = tokio::fs::symlink_metadata(&source_issue).await
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        if metadata.len() > MAX_VERIFIER_ISSUE_CONTEXT_BYTES {
            return Err(AgentError::Execution(
                "issue.md exceeds the 1 MiB verifier context limit".to_string(),
            ));
        }
        tokio::fs::copy(&source_issue, &target_issue)
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to copy verifier issue context `{}`: {error}",
                    source_issue.display()
                ))
            })?;
        tokio::fs::set_permissions(&target_issue, metadata.permissions())
            .await
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to preserve verifier issue context permissions: {error}"
                ))
            })?;
    }
    let tracked_paths = verifier_git_output(
        &isolation.worktree_root,
        &[
            "diff",
            "--name-only",
            "-z",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder",
            ":(exclude).kcoder/**",
        ],
    )
    .await?;
    isolation.changed_paths = tracked_paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .chain(
            untracked
                .split(|byte| *byte == 0)
                .filter(|path| !path.is_empty())
                .map(|path| String::from_utf8_lossy(path).into_owned())
                .filter(|path| !verifier_ignores_untracked_path(path)),
        )
        .collect();
    isolation.changed_paths.sort();
    isolation.changed_paths.dedup();
    Ok(isolation)
}

async fn verifier_workspace_fingerprint(cwd: &std::path::Path) -> Result<String, AgentError> {
    async fn git_output(cwd: &std::path::Path, args: &[&str]) -> Result<Vec<u8>, AgentError> {
        let output = tokio::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("LC_ALL", "C")
            .output()
            .await
            .map_err(|error| {
                AgentError::Execution(format!("failed to inspect verifier workspace: {error}"))
            })?;
        if !output.status.success() {
            return Err(AgentError::Execution(format!(
                "failed to inspect verifier workspace with git: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(output.stdout)
    }

    let top_level_output = git_output(cwd, &["rev-parse", "--show-toplevel"]).await?;
    let top_level = PathBuf::from(
        String::from_utf8(top_level_output)
            .map_err(|_| {
                AgentError::Execution("git workspace root is not valid UTF-8".to_string())
            })?
            .trim(),
    );
    let diff = git_output(
        &top_level,
        &[
            "diff",
            "--binary",
            "--no-ext-diff",
            "HEAD",
            "--",
            ".",
            ":(exclude).kcoder",
            ":(exclude).kcoder/**",
        ],
    )
    .await?;
    if diff.len() > MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES {
        return Err(AgentError::Execution(
            "verifier workspace diff exceeds the 64 MiB snapshot limit".to_string(),
        ));
    }
    let untracked = git_output(
        &top_level,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ".",
        ],
    )
    .await?;
    let mut hasher = Sha256::new();
    hasher.update(b"tracked-diff\0");
    hasher.update(&diff);
    let mut total_bytes = diff.len();
    for raw_path in untracked.split(|byte| *byte == 0) {
        if raw_path.is_empty() {
            continue;
        }
        let relative = String::from_utf8_lossy(raw_path);
        if verifier_ignores_untracked_path(&relative) {
            continue;
        }
        let path = top_level.join(relative.as_ref());
        let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
            AgentError::Execution(format!(
                "failed to inspect untracked verifier file `{}`: {error}",
                path.display()
            ))
        })?;
        hasher.update(b"untracked\0");
        hasher.update(raw_path);
        hasher.update(b"\0");
        if metadata.file_type().is_symlink() {
            let target = tokio::fs::read_link(&path).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to inspect untracked verifier symlink `{}`: {error}",
                    path.display()
                ))
            })?;
            hasher.update(target.as_os_str().to_string_lossy().as_bytes());
        } else if metadata.is_file() {
            let size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
            total_bytes = total_bytes.saturating_add(size);
            if total_bytes > MAX_VERIFIER_WORKSPACE_SNAPSHOT_BYTES {
                return Err(AgentError::Execution(
                    "verifier workspace snapshot exceeds the 64 MiB limit".to_string(),
                ));
            }
            hasher.update(tokio::fs::read(&path).await.map_err(|error| {
                AgentError::Execution(format!(
                    "failed to read untracked verifier file `{}`: {error}",
                    path.display()
                ))
            })?);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn bash_result_workdir(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .find_map(|line| line.strip_prefix("workdir: "))
        .map(PathBuf::from)
}

fn bash_execution_workdir(execution: &kcoder_tools::AgentToolExecution) -> Option<PathBuf> {
    bash_result_workdir(&execution.output).or_else(|| {
        execution
            .input
            .get("workdir")
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
    })
}

fn verifier_test_provenance(
    workdir: &Path,
    candidate_root: &Path,
    baseline_root: &Path,
) -> Option<(kcoder_tools::VerifierTestOrigin, PathBuf)> {
    let canonical_workdir = std::fs::canonicalize(workdir).ok()?;
    let canonical_candidate = std::fs::canonicalize(candidate_root).ok()?;
    let canonical_baseline = std::fs::canonicalize(baseline_root).ok()?;
    if canonical_workdir.starts_with(&canonical_baseline) {
        Some((
            kcoder_tools::VerifierTestOrigin::Baseline,
            canonical_workdir
                .strip_prefix(&canonical_baseline)
                .ok()?
                .to_path_buf(),
        ))
    } else if canonical_workdir.starts_with(&canonical_candidate) {
        Some((
            kcoder_tools::VerifierTestOrigin::Candidate,
            canonical_workdir
                .strip_prefix(&canonical_candidate)
                .ok()?
                .to_path_buf(),
        ))
    } else {
        None
    }
}

impl QueryEngineAgentRunner {
    pub fn new(engine: QueryEngine) -> Self {
        Self { engine }
    }

    fn transcript_path(&self, agent_id: &str) -> PathBuf {
        self.engine
            .state
            .task(agent_id)
            .and_then(|task| task.transcript_path)
            .unwrap_or_else(|| self.engine.state.subagent_transcript_path(agent_id))
    }

    fn record_agent_runtime_identity(&self, agent_id: &str, runtime: Option<&ForkedAgentRuntime>) {
        let provider = runtime
            .map(|runtime| runtime.provider.name().to_string())
            .unwrap_or_else(|| self.engine.provider_name());
        let model = runtime
            .map(|runtime| runtime.settings.model.clone())
            .unwrap_or_else(|| self.engine.model_name());
        self.engine.state.update_task(agent_id, |task| {
            task.agent_provider = Some(provider.clone());
            task.agent_model = Some(model.clone());
        });
    }

    fn build_agent_runtime(
        &self,
        selection: &kcoder_tools::AgentRuntimeSelection,
    ) -> anyhow::Result<ForkedAgentRuntime> {
        let parent_settings = crate::recover_read_lock(&self.engine.settings, "settings").clone();
        let profile = selection
            .profile
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let provider_name = selection
            .provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let model = selection
            .model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        if profile.is_none() && provider_name.is_none() && model.is_none() {
            anyhow::bail!("verifier runtime selection is empty")
        }

        let mut settings = parent_settings.clone();
        let (provider, effective_model) = if profile
            .is_some_and(|value| value.eq_ignore_ascii_case("current"))
            || provider_name.is_some_and(|value| value.eq_ignore_ascii_case("current"))
        {
            let effective_model = model.unwrap_or_else(|| parent_settings.model.clone());
            settings.model = effective_model.clone();
            (self.engine.current_provider(), effective_model)
        } else if let Some(profile) = profile {
            settings.apply_provider(Some(profile))?;
            let effective_model = model.unwrap_or_else(|| settings.model.clone());
            settings.model = effective_model.clone();
            let provider =
                ProviderFactory::new(&settings).build_named(profile, &effective_model)?;
            (provider, effective_model)
        } else if let Some(provider_name) = provider_name {
            let effective_model = model.unwrap_or_else(|| parent_settings.model.clone());
            let provider = ProviderFactory::new(&parent_settings)
                .build_named_isolated(provider_name, &effective_model)?;
            if let Some(profile_name) = parent_settings
                .providers
                .keys()
                .find(|name| name.as_str() == provider_name)
                .cloned()
            {
                settings.apply_provider(Some(&profile_name))?;
            } else {
                settings.active_provider = None;
                settings.provider = Some(provider_name.to_string());
                settings.api_format = None;
                settings.base_url = None;
                settings.request_timeout_secs = None;
                settings.provider_no_proxy = false;
                settings.provider_extra_body.clear();
            }
            settings.model = effective_model.clone();
            (provider, effective_model)
        } else {
            let effective_model = model.expect("model selection checked above");
            settings.model = effective_model.clone();
            (self.engine.current_provider(), effective_model)
        };

        if let Some(profile_name) = settings.active_provider.clone()
            && settings
                .providers
                .get(&profile_name)
                .is_some_and(|profile| profile.has_model(&effective_model))
        {
            settings.apply_discovered_model(&profile_name, &effective_model)?;
        }
        settings.model = effective_model;
        Ok(ForkedAgentRuntime { provider, settings })
    }

    fn validate_continuation_runtime_identity(&self, agent_id: &str) -> Result<(), AgentError> {
        let task = self.engine.state.task(agent_id).ok_or_else(|| {
            AgentError::Execution(format!("agent {agent_id} has no persisted task metadata"))
        })?;
        let saved_provider = task.agent_provider.as_deref().ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} predates provider/model transcript tracking; spawn a fresh sub-agent"
            ))
        })?;
        let saved_model = task.agent_model.as_deref().ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} predates provider/model transcript tracking; spawn a fresh sub-agent"
            ))
        })?;
        let live_provider = self.engine.provider_name();
        let live_model = self.engine.model_name();
        if saved_provider == live_provider && saved_model == live_model {
            return Ok(());
        }
        Err(AgentError::Execution(format!(
            "agent {agent_id} transcript belongs to provider/model `{saved_provider}/{saved_model}`, but the live parent is `{live_provider}/{live_model}`; switch back before SendMessage or spawn a fresh sub-agent"
        )))
    }

    async fn write_transcript(
        &self,
        agent_id: &str,
        messages: &[Message],
    ) -> Result<(), AgentError> {
        let path = self.transcript_path(agent_id);
        write_transcript_checkpoint(&path, messages)
            .await
            .map_err(|e| AgentError::Execution(format!("failed to write transcript: {e}")))
    }

    async fn read_transcript(&self, agent_id: &str) -> Result<Vec<Message>, AgentError> {
        let path = self.transcript_path(agent_id);
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            AgentError::Execution(format!(
                "failed to read transcript `{}`: {e}",
                path.display()
            ))
        })?;
        serde_json::from_slice(&bytes).map_err(|e| {
            AgentError::Execution(format!(
                "failed to parse transcript `{}`: {e}",
                path.display()
            ))
        })
    }

    async fn run_agent_session_with_kind_and_runtime(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        runtime: Option<ForkedAgentRuntime>,
        verifier_guard: Option<VerifierRuntimeGuard>,
    ) -> Result<String, AgentError> {
        self.run_agent_session_result_with_kind_and_runtime(
            agent_id,
            prompt,
            max_turns,
            agent_kind,
            runtime,
            verifier_guard,
        )
        .await
        .map(|result| result.output_text)
    }

    async fn run_agent_session_result_with_kind_and_runtime(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        runtime: Option<ForkedAgentRuntime>,
        verifier_guard: Option<VerifierRuntimeGuard>,
    ) -> Result<ForkedAgentResult, AgentError> {
        // Children of the main loop share the parent's cancel token by
        // default. Without this, hitting Ctrl+C in the REPL would only
        // abort the current turn, leaving the still-running sub-agents to
        // keep producing background work.
        let cache_safe = self.engine.cache_safe_snapshot().ok_or_else(|| {
            AgentError::Execution("no cache-safe params available; run a turn first".to_string())
        })?;
        self.record_agent_runtime_identity(&agent_id, runtime.as_ref());
        let base_tools = self.engine.active_subagent_tools();
        let arrangement_mode = self.engine.is_arrangement_mode_active();
        let tools = if verifier_guard.is_some() {
            verifier_session_tools(&base_tools)
        } else {
            filter_tools_for_agent_kind_in_mode(&base_tools, agent_kind, true, arrangement_mode)
        };
        let role_system_prompt = verifier_guard
            .as_ref()
            .map(|guard| guard.role_system_prompt(agent_kind.system_prompt()))
            .unwrap_or_else(|| agent_kind.system_prompt().to_string());
        let result = continue_forked_agent_with_tools(
            &self.engine,
            &cache_safe,
            ForkedAgentRequest {
                agent_id: Some(agent_id.clone()),
                messages: initial_agent_messages(
                    &cache_safe,
                    prompt,
                    agent_kind.default_context_mode(arrangement_mode),
                    2,
                ),
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: SubagentContextOverrides {
                    share_abort_controller: true,
                    block_shell_file_mutation:
                        kcoder_tools::agent::agent_kind_blocks_shell_file_mutation(
                            agent_kind,
                            arrangement_mode,
                        ),
                    block_dependency_mutation: verifier_guard
                        .as_ref()
                        .is_some_and(|guard| guard.block_dependency_mutation),
                    verifier_minimum_test_scope: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.minimum_test_scope),
                    verifier_require_raw_exit_code: verifier_guard
                        .as_ref()
                        .is_some_and(|guard| guard.require_raw_exit_code),
                    verifier_require_behavior_delta: verifier_guard
                        .as_ref()
                        .is_some_and(|guard| guard.require_behavior_delta),
                    verifier_terminal_verdict: verifier_guard.is_some(),
                    shell_isolation_root: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.shell_isolation_root.clone()),
                    isolate_shell_writes: verifier_guard.is_some(),
                    shell_write_root: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.workspace_root.clone()),
                    verifier_baseline_root: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.baseline_root.clone()),
                    verifier_vote_channel: verifier_guard
                        .as_ref()
                        .map(|guard| guard.vote_channel.clone()),
                    arrangement_mode: Some(arrangement_mode),
                    role_system_prompt: Some(role_system_prompt),
                    permission_mode_if_parent_asks: Some(subagent_permission_mode(agent_kind)),
                    session_allowed_tools: subagent_session_allowed_tools(agent_kind),
                    session_allowed_shell_prefixes: subagent_session_allowed_shell_prefixes(
                        agent_kind,
                    ),
                    cwd_override: verifier_guard
                        .as_ref()
                        .and_then(|guard| guard.cwd_override.clone()),
                    ..SubagentContextOverrides::default()
                },
                max_turns,
                tools,
                runtime,
            },
        )
        .await
        .map_err(map_forked_agent_error)?;
        self.write_transcript(&agent_id, &result.messages).await?;
        Ok(result)
    }
}

#[async_trait::async_trait]
impl AgentRunner for QueryEngineAgentRunner {
    async fn run_agent(&self, prompt: String, max_turns: usize) -> Result<String, AgentError> {
        self.run_agent_session_with_kind(
            generate_agent_id(&self.engine).map_err(map_forked_agent_error)?,
            prompt,
            max_turns,
            AgentKind::General,
        )
        .await
    }

    async fn run_agent_with_kind(
        &self,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        self.run_agent_session_with_kind(
            generate_agent_id(&self.engine).map_err(map_forked_agent_error)?,
            prompt,
            max_turns,
            agent_kind,
        )
        .await
    }

    async fn run_agent_session_with_kind(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        self.run_agent_session_with_kind_and_runtime(
            agent_id, prompt, max_turns, agent_kind, None, None,
        )
        .await
    }

    async fn run_verifier_with_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        selection: Option<kcoder_tools::AgentRuntimeSelection>,
        options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        let runtime = selection
            .as_ref()
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to build agent runtime: {error}"))
            })?;
        let isolation = options
            .isolate_environment
            .then(|| kcoder_config::create_private_temp_dir("kcoder-goal-verifier"))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!(
                    "failed to create isolated verifier environment: {error:#}"
                ))
            })?;
        let isolation_root = isolation
            .as_ref()
            .map(|directory| directory.path().to_path_buf());
        let workspace_isolation = if options.verify_workspace_unchanged {
            Some(
                create_verifier_workspace_isolation(
                    &self.engine.state.cwd(),
                    options.workspace_baseline.as_ref(),
                )
                .await?,
            )
        } else {
            None
        };
        let workspace_before = if options.verify_workspace_unchanged {
            let candidate_root = workspace_isolation
                .as_ref()
                .map(|isolation| isolation.worktree_root.as_path())
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Goal Pro workspace verification is missing its isolated candidate"
                            .to_string(),
                    )
                })?;
            Some(verifier_workspace_fingerprint(candidate_root).await?)
        } else {
            None
        };
        let baseline_before = if options.verify_workspace_unchanged {
            let baseline = workspace_isolation
                .as_ref()
                .map(|isolation| isolation.baseline_root.as_path())
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Goal Pro workspace verification is missing its pristine baseline"
                            .to_string(),
                    )
                })?;
            Some(verifier_workspace_fingerprint(baseline).await?)
        } else {
            None
        };
        let agent_id = generate_agent_id(&self.engine).map_err(map_forked_agent_error)?;
        let vote_channel = kcoder_tools::VerifierVoteChannel::default();
        let forked_result = self
            .run_agent_session_result_with_kind_and_runtime(
                agent_id.clone(),
                prompt,
                max_turns,
                AgentKind::Verifier,
                runtime,
                Some(VerifierRuntimeGuard {
                    block_dependency_mutation: options.block_dependency_mutation,
                    minimum_test_scope: options.minimum_test_scope,
                    require_raw_exit_code: options.require_raw_exit_code,
                    require_behavior_delta: options.require_behavior_delta,
                    shell_isolation_root: isolation_root,
                    cwd_override: workspace_isolation
                        .as_ref()
                        .map(|isolation| isolation.cwd.clone()),
                    workspace_root: workspace_isolation
                        .as_ref()
                        .map(|isolation| isolation.worktree_root.clone()),
                    baseline_root: workspace_isolation
                        .as_ref()
                        .map(|isolation| isolation.baseline_root.clone()),
                    vote_channel: vote_channel.clone(),
                }),
            )
            .await?;
        let candidate_unchanged = if let Some(before) = workspace_before.as_deref() {
            let candidate_root = workspace_isolation
                .as_ref()
                .map(|isolation| isolation.worktree_root.as_path())
                .ok_or_else(|| {
                    AgentError::Execution(
                        "Goal Pro workspace verification lost its isolated candidate".to_string(),
                    )
                })?;
            verifier_workspace_fingerprint(candidate_root).await? == before
        } else {
            false
        };
        let baseline_unchanged = if let (Some(before), Some(isolation)) =
            (baseline_before.as_deref(), workspace_isolation.as_ref())
        {
            verifier_workspace_fingerprint(&isolation.baseline_root).await? == before
        } else {
            false
        };
        let workspace_snapshot_verified = workspace_before.is_some() && baseline_before.is_some();
        let workspace_unchanged = candidate_unchanged && baseline_unchanged;
        let mut result = AgentRunResult::from_messages_with_trusted_tool_results(
            forked_result.output_text,
            &forked_result.messages,
            &forked_result.trusted_tool_results,
            isolation.is_some(),
            options.block_dependency_mutation,
            workspace_snapshot_verified,
            workspace_unchanged,
        );
        result.verifier_vote = validated_verifier_vote(&vote_channel, &forked_result.messages);
        result.verifier_baseline_root = workspace_isolation
            .as_ref()
            .map(|isolation| isolation.baseline_root.clone());
        if let (Some(isolation), Some(baseline_root)) = (
            workspace_isolation.as_ref(),
            result.verifier_baseline_root.as_deref(),
        ) {
            for execution in &mut result.tool_executions {
                // Tool errors such as SandboxDenied lack a standard Bash result body, but
                // the engine still validates the requested workdir and uses it as the actual
                // execution boundary, so its provenance must be retained.
                let workdir = bash_execution_workdir(execution);
                let provenance = workdir.as_deref().and_then(|workdir| {
                    verifier_test_provenance(workdir, &isolation.worktree_root, baseline_root)
                });
                execution.test_origin = provenance.as_ref().map(|(origin, _)| *origin);
                execution.verifier_relative_workdir =
                    provenance.map(|(_, relative_workdir)| relative_workdir);
            }
        }
        result.candidate_fingerprint = workspace_before;
        result.candidate_changed_paths = workspace_isolation
            .as_ref()
            .map(|isolation| isolation.changed_paths.clone())
            .unwrap_or_default();
        Ok(result)
    }

    async fn run_agent_with_kind_and_runtime(
        &self,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        selection: Option<kcoder_tools::AgentRuntimeSelection>,
    ) -> Result<String, AgentError> {
        let runtime = selection
            .as_ref()
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to build agent runtime: {error}"))
            })?;
        self.run_agent_session_with_kind_and_runtime(
            generate_agent_id(&self.engine).map_err(map_forked_agent_error)?,
            prompt,
            max_turns,
            agent_kind,
            runtime,
            None,
        )
        .await
    }

    async fn run_agent_session_with_options(
        &self,
        agent_id: String,
        prompt: String,
        max_turns: usize,
        agent_kind: AgentKind,
        mut options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        kcoder_state::validate_artifact_requirements(&options.artifact_requirements)
            .map_err(AgentError::Execution)?;
        if let Some(task) = self.engine.state.task(&agent_id) {
            options.restore_artifact_requirements(&task)?;
        }
        let cache_safe = self.engine.cache_safe_snapshot().ok_or_else(|| {
            AgentError::Execution("no cache-safe params available; run a turn first".to_string())
        })?;
        // The spawning tool latches the child's capability profile into the
        // options. Do not OR it with mutable parent UI state: doing so can
        // silently upgrade a normal child when Arrangement is entered later.
        let arrangement_mode = options.arrangement_mode;
        let runtime = options
            .runtime_selection
            .as_ref()
            .filter(|selection| {
                selection.profile.is_some()
                    || selection.provider.is_some()
                    || selection.model.is_some()
            })
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to build persona runtime: {error:#}"))
            })?;
        let base_tools = self.engine.active_subagent_tools_for_mode(arrangement_mode);
        let mut tools =
            filter_tools_for_agent_kind_in_mode(&base_tools, agent_kind, true, arrangement_mode);
        if let Some(allowlist) = options.tool_allowlist.as_ref() {
            tools = filter_tools_by_owned_names(
                &tools,
                &allowlist.iter().cloned().collect::<HashSet<_>>(),
            );
        }
        if options.review_vote_channel.is_some() {
            tools = tools.register(kcoder_tools::ReviewVoteTool);
        }
        let context_mode = match options.context_mode {
            SubagentContextMode::Auto => agent_kind.default_context_mode(arrangement_mode),
            mode => mode,
        };
        validate_full_context_compatibility(&self.engine, &cache_safe, context_mode)?;
        if self.engine.state.task(&agent_id).is_none() && !options.artifact_requirements.is_empty()
        {
            let mut task = kcoder_state::Task::new(&agent_id, &prompt);
            task.kind = kcoder_state::TaskKind::Subagent;
            task.allowed_write_paths = options.allowed_write_paths.clone();
            task.worktree_path = options.worktree_path.clone();
            self.engine.state.upsert_task(task);
        }
        if !options.artifact_requirements.is_empty() {
            self.engine
                .state
                .bind_subagent_artifact_requirements(&agent_id, &options.artifact_requirements)
                .map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to bind artifact declarations: {error:#}"
                    ))
                })?;
        }
        let role_system_prompt =
            if self.engine.state.session_mode() == kcoder_state::SessionMode::Orchestrate {
                orchestrate_role_prompt(agent_kind, options.persona_name.as_deref())
            } else {
                agent_kind.system_prompt().to_string()
            };
        self.record_agent_runtime_identity(&agent_id, runtime.as_ref());
        if let Some(persona) = options.persona_name.as_deref() {
            let runtime_provider = runtime
                .as_ref()
                .map(|runtime| runtime.provider.name().to_string())
                .unwrap_or_else(|| self.engine.provider_name());
            let runtime_model = runtime
                .as_ref()
                .map(|runtime| runtime.settings.model.clone())
                .unwrap_or_else(|| self.engine.model_name());
            let work_id = options.orchestrate_work_id.clone();
            let parent_session_id = self.engine.state.session_id();
            let fingerprint = resolved_profile_fingerprint(ProfileFingerprintInput {
                persona,
                agent_kind,
                role_prompt: &role_system_prompt,
                tools: &tools,
                runtime_provider: &runtime_provider,
                runtime_model: &runtime_model,
                runtime_selection: options.runtime_selection.as_ref(),
                context_mode,
                context_turns: options.context_turns,
                work_id: work_id.as_deref(),
                parent_session_id: &parent_session_id,
            });
            self.engine.state.update_task(&agent_id, |task| {
                task.resolved_profile_fingerprint = Some(fingerprint.clone());
            });
            if let Some(work_id) = work_id.as_deref() {
                let store =
                    kcoder_state::orchestrate_store::PlanStore::for_workspace(&self.engine.cwd);
                let snapshot = store.read_work(work_id).map_err(|error| {
                    AgentError::Execution(format!(
                        "failed to bind persona session to Orchestrate work: {error:#}"
                    ))
                })?;
                store
                    .append_task_session(
                        work_id,
                        kcoder_state::orchestrate_store::TaskSessionRecord {
                            agent_id: agent_id.clone(),
                            parent_session_id: self.engine.state.session_id(),
                            plan_revision: snapshot.work.revision,
                            status: "spawned".to_string(),
                            profile_fingerprint: fingerprint,
                            recorded_at: chrono::Utc::now(),
                        },
                    )
                    .map_err(|error| {
                        AgentError::Execution(format!(
                            "failed to persist persona session audit: {error:#}"
                        ))
                    })?;
            }
        }
        let result = continue_forked_agent_with_tools(
            &self.engine,
            &cache_safe,
            ForkedAgentRequest {
                agent_id: Some(agent_id.clone()),
                messages: initial_agent_messages(
                    &cache_safe,
                    prompt,
                    context_mode,
                    options.context_turns,
                ),
                prompt_message_count: 1,
                initial_delivery: None,
                overrides: SubagentContextOverrides {
                    share_abort_controller: options.abort_token.is_none(),
                    abort_token: options.abort_token,
                    allowed_write_paths: options.allowed_write_paths,
                    scoped_allowed_shell_prefixes: options.allowed_shell_prefixes.clone(),
                    block_shell_file_mutation: options.block_shell_file_mutation,
                    arrangement_mode: Some(arrangement_mode),
                    role_system_prompt: Some(role_system_prompt),
                    permission_mode_if_parent_asks: Some(subagent_permission_mode(agent_kind)),
                    session_allowed_tools: subagent_session_allowed_tools(agent_kind),
                    session_allowed_shell_prefixes: subagent_session_allowed_shell_prefixes(
                        agent_kind,
                    )
                    .into_iter()
                    .chain(options.allowed_shell_prefixes)
                    .collect(),
                    cwd_override: options.worktree_path,
                    review_vote_channel: options.review_vote_channel,
                    ..SubagentContextOverrides::default()
                },
                max_turns,
                tools,
                runtime,
            },
        )
        .await
        .map_err(map_forked_agent_error)?;
        self.write_transcript(&agent_id, &result.messages).await?;
        Ok(result.output_text)
    }

    async fn send_message_to_agent_with_kind(
        &self,
        agent_id: String,
        message: String,
        max_turns: usize,
        agent_kind: AgentKind,
    ) -> Result<String, AgentError> {
        let task = self.engine.state.task(&agent_id).ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} has no persisted capability profile"
            ))
        })?;
        let arrangement_mode = task.arrangement_mode.ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} predates capability-profile tracking; spawn a fresh sub-agent"
            ))
        })?;
        let options = AgentRunOptions::with_allowed_write_paths(task.allowed_write_paths)
            .with_allowed_shell_prefixes(task.allowed_shell_prefixes)
            .with_artifact_requirements(task.artifact_requirements)
            .with_block_shell_file_mutation(
                kcoder_tools::agent::agent_kind_blocks_shell_file_mutation(
                    agent_kind,
                    arrangement_mode,
                ),
            )
            .with_arrangement_mode(arrangement_mode);
        self.send_message_to_agent_with_options(agent_id, message, max_turns, agent_kind, options)
            .await
    }

    async fn send_message_to_agent_with_options(
        &self,
        agent_id: String,
        message: String,
        max_turns: usize,
        agent_kind: AgentKind,
        mut options: AgentRunOptions,
    ) -> Result<String, AgentError> {
        let task = self.engine.state.task(&agent_id).ok_or_else(|| {
            AgentError::Execution(format!(
                "agent {agent_id} has no persisted task declarations"
            ))
        })?;
        options.restore_artifact_requirements(&task)?;
        if options.persona_name.is_none() {
            self.validate_continuation_runtime_identity(&agent_id)?;
        }
        let cache_safe = self.engine.cache_safe_snapshot().ok_or_else(|| {
            AgentError::Execution("no cache-safe params available; run a turn first".to_string())
        })?;
        let (mut messages, repaired_transcript) =
            crate::repair_tool_message_sequence(self.read_transcript(&agent_id).await?);
        if repaired_transcript {
            warn!(
                agent_id = %agent_id,
                "repaired persisted sub-agent transcript before SendMessage continuation"
            );
        }
        let mut appended_delivery_message = true;
        let mut artifact_replay_output = None;
        if let Some(delivery) = options.delivery.as_ref() {
            let task = self.engine.state.task(&agent_id).ok_or_else(|| {
                AgentError::Execution(format!("agent {agent_id} task state disappeared"))
            })?;
            let queued = task
                .message_queue
                .iter()
                .find(|queued| queued.message_id == delivery.message_id)
                .ok_or_else(|| {
                    AgentError::Execution(format!(
                        "delivery {} disappeared from agent {agent_id}",
                        delivery.message_id
                    ))
                })?;
            let body_sha256 = format!("{:x}", Sha256::digest(message.as_bytes()));
            let anchor = if let Some(anchor) = queued.transcript_anchor.clone() {
                if anchor.body_sha256 != body_sha256 {
                    return Err(AgentError::Execution(format!(
                        "delivery {} body changed after it was leased",
                        delivery.message_id
                    )));
                }
                anchor
            } else {
                let anchor = kcoder_state::TranscriptDeliveryAnchor {
                    baseline_message_count: messages.len(),
                    baseline_sha256: transcript_messages_sha256(&messages)?,
                    body_sha256,
                };
                let prepared = self
                    .engine
                    .state
                    .prepare_subagent_delivery(
                        &agent_id,
                        &delivery.message_id,
                        &delivery.lease_id,
                        anchor.clone(),
                    )
                    .map_err(|error| AgentError::Execution(error.to_string()))?;
                if !prepared {
                    return Err(AgentError::Execution(format!(
                        "delivery {} disappeared before transcript preparation",
                        delivery.message_id
                    )));
                }
                anchor
            };
            if messages.len() < anchor.baseline_message_count {
                return Err(AgentError::Execution(format!(
                    "delivery {} transcript is shorter than its persisted baseline",
                    delivery.message_id
                )));
            }
            let baseline = &messages[..anchor.baseline_message_count];
            if transcript_messages_sha256(baseline)? != anchor.baseline_sha256 {
                return Err(AgentError::Execution(format!(
                    "delivery {} transcript baseline changed; refusing duplicate insertion",
                    delivery.message_id
                )));
            }
            if messages.len() == anchor.baseline_message_count {
                messages.push(Message::user_text(message.clone()));
            } else if !is_exact_delivery_message(&messages[anchor.baseline_message_count], &message)
            {
                return Err(AgentError::Execution(format!(
                    "delivery {} transcript anchor points to a different message",
                    delivery.message_id
                )));
            } else {
                appended_delivery_message = false;
                if let Some(output) =
                    completed_delivery_output(&messages, anchor.baseline_message_count)
                {
                    if task.artifact_requirements.is_empty() {
                        return Ok(output);
                    }
                    artifact_replay_output = Some(output);
                }
            }
        } else {
            messages.push(Message::user_text(message));
        }
        // Continuation reuses the capability profile persisted at spawn time;
        // the parent's current UI/loop mode must not upgrade this child.
        let arrangement_mode = options.arrangement_mode;
        let runtime = options
            .runtime_selection
            .as_ref()
            .filter(|selection| {
                selection.profile.is_some()
                    || selection.provider.is_some()
                    || selection.model.is_some()
            })
            .map(|selection| self.build_agent_runtime(selection))
            .transpose()
            .map_err(|error| {
                AgentError::Execution(format!("failed to rebuild persona runtime: {error:#}"))
            })?;
        let base_tools = self.engine.active_subagent_tools_for_mode(arrangement_mode);
        let mut tools =
            filter_tools_for_agent_kind_in_mode(&base_tools, agent_kind, true, arrangement_mode);
        if let Some(allowlist) = options.tool_allowlist.as_ref() {
            tools = filter_tools_by_owned_names(
                &tools,
                &allowlist.iter().cloned().collect::<HashSet<_>>(),
            );
        }
        let role_system_prompt =
            if self.engine.state.session_mode() == kcoder_state::SessionMode::Orchestrate {
                orchestrate_role_prompt(agent_kind, options.persona_name.as_deref())
            } else {
                agent_kind.system_prompt().to_string()
            };
        if let Some(persona) = options.persona_name.as_deref() {
            let task = self.engine.state.task(&agent_id).ok_or_else(|| {
                AgentError::Execution(format!("agent {agent_id} task state disappeared"))
            })?;
            let provider = runtime
                .as_ref()
                .map(|runtime| runtime.provider.name().to_string())
                .unwrap_or_else(|| self.engine.provider_name());
            let model = runtime
                .as_ref()
                .map(|runtime| runtime.settings.model.clone())
                .unwrap_or_else(|| self.engine.model_name());
            if task.agent_provider.as_deref() != Some(provider.as_str())
                || task.agent_model.as_deref() != Some(model.as_str())
            {
                return Err(AgentError::Execution(
                    "the resolved persona runtime changed; spawn a fresh sub-agent".to_string(),
                ));
            }
            let parent_session_id = self.engine.state.session_id();
            let fingerprint = resolved_profile_fingerprint(ProfileFingerprintInput {
                persona,
                agent_kind,
                role_prompt: &role_system_prompt,
                tools: &tools,
                runtime_provider: &provider,
                runtime_model: &model,
                runtime_selection: options.runtime_selection.as_ref(),
                context_mode: options.context_mode,
                context_turns: options.context_turns,
                work_id: task.orchestrate_work_id.as_deref(),
                parent_session_id: &parent_session_id,
            });
            if task.resolved_profile_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                return Err(AgentError::Execution(
                    "the Orchestrate persona prompt/tools/runtime/context/work fingerprint changed; spawn a fresh sub-agent"
                        .to_string(),
                ));
            }
        }
        let allowed_write_paths = if options.has_write_scope() {
            options.allowed_write_paths
        } else {
            self.engine
                .state
                .task(&agent_id)
                .map(|task| task.allowed_write_paths)
                .unwrap_or_default()
        };
        let allowed_shell_prefixes = if !options.allowed_shell_prefixes.is_empty() {
            options.allowed_shell_prefixes
        } else {
            self.engine
                .state
                .task(&agent_id)
                .map(|task| task.allowed_shell_prefixes)
                .unwrap_or_default()
        };
        // Continuations re-enter the same isolation worktree the agent was
        // spawned in, so follow-up edits do not leak into the parent workspace.
        let cwd_override = self
            .engine
            .state
            .task(&agent_id)
            .and_then(|task| task.worktree_path);
        let result = continue_forked_agent_with_tools(
            &self.engine,
            &cache_safe,
            ForkedAgentRequest {
                agent_id: Some(agent_id.clone()),
                messages,
                prompt_message_count: usize::from(appended_delivery_message),
                initial_delivery: options.delivery.clone(),
                overrides: SubagentContextOverrides {
                    artifact_replay_output,
                    share_abort_controller: true,
                    allowed_write_paths,
                    scoped_allowed_shell_prefixes: allowed_shell_prefixes.clone(),
                    block_shell_file_mutation: options.block_shell_file_mutation,
                    arrangement_mode: Some(arrangement_mode),
                    role_system_prompt: Some(role_system_prompt),
                    permission_mode_if_parent_asks: Some(subagent_permission_mode(agent_kind)),
                    session_allowed_tools: subagent_session_allowed_tools(agent_kind),
                    session_allowed_shell_prefixes: subagent_session_allowed_shell_prefixes(
                        agent_kind,
                    )
                    .into_iter()
                    .chain(allowed_shell_prefixes)
                    .collect(),
                    cwd_override,
                    ..SubagentContextOverrides::default()
                },
                max_turns,
                tools,
                runtime,
            },
        )
        .await
        .map_err(map_forked_agent_error)?;
        self.write_transcript(&agent_id, &result.messages).await?;
        Ok(result.output_text)
    }
}

#[cfg(test)]
#[path = "agent/tests.rs"]
mod tests;
