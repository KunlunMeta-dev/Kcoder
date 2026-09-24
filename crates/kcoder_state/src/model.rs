use super::{Goal, now_millis};
use kcoder_types::Message;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use uuid::Uuid;

/// Session-level operating mode, independent of GoalMode and immutable after session creation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    #[default]
    Default,
    Orchestrate,
}

impl SessionMode {
    pub fn is_default(&self) -> bool {
        matches!(self, Self::Default)
    }

    pub fn is_orchestrate(self) -> bool {
        matches!(self, Self::Orchestrate)
    }
}

/// A single todo item tracked by the TodoWriteTool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

/// A delegated task tracked by the Task* tools.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub description: String,
    pub status: TaskStatus,
    pub output: Option<String>,
    /// File containing the final output for engine-managed jobs that also
    /// materialize their result on disk, such as sub-agents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<PathBuf>,
    /// File containing the serialized conversation transcript for resumable
    /// sub-agent sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<PathBuf>,
    /// Messages sent with SendMessage while the sub-agent is already running.
    /// Messages are consumed in FIFO order at protocol-safe provider/tool boundaries.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_messages: Vec<String>,
    /// Reliable sub-agent message queue with stable IDs, leases, and explicit terminal states.
    ///
    /// `pending_messages` is read only from old sidecars; new runtimes write only this field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub message_queue: Vec<QueuedAgentMessage>,
    /// Explicitly discarded messages remain in a bounded dead-letter area for audit and explicit retry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dead_letter_messages: Vec<QueuedAgentMessage>,
    /// Delivery policy resolved and persisted at spawn time; recovery cannot fall back to a source-code constant.
    #[serde(
        default = "default_delivery_lease_timeout_seconds",
        skip_serializing_if = "is_default_delivery_lease_timeout_seconds"
    )]
    pub delivery_lease_timeout_seconds: u64,
    #[serde(
        default = "default_delivery_max_attempts",
        skip_serializing_if = "is_default_delivery_max_attempts"
    )]
    pub delivery_max_attempts: u32,
    /// Optional Arrangement write scope for this sub-agent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_write_paths: Vec<String>,
    /// Shell prefixes explicitly authorized for this resumable sub-agent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_shell_prefixes: Vec<String>,
    /// Explicit declarations retained unchanged across continuations.
    #[serde(
        default,
        skip_serializing_if = "Vec::is_empty",
        deserialize_with = "crate::deserialize_artifact_requirements"
    )]
    pub artifact_requirements: Vec<crate::ArtifactRequirement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_validation_run: Option<crate::ArtifactValidationRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_baseline: Option<crate::ArtifactBaseline>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_validation_report: Option<crate::ArtifactValidationReport>,
    /// Isolated git worktree this sub-agent runs in when spawned with
    /// `isolation="worktree"`. Continuations reuse it so follow-up edits land
    /// in the same worktree instead of the parent workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<PathBuf>,
    /// Creation branch bound to the managed worktree path; must match the agent ID during recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// Stable parent session ownership for continuation validation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Canonical delegated role; avoids reconstructing identity from a mutable
    /// human-readable description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    /// Resolved first-turn parent context policy retained for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_turns: Option<usize>,
    /// Logical parent-child tree depth. Current public agents are depth one;
    /// storing it now keeps persisted topology explicit and extensible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<usize>,
    /// Arrangement capability profile captured at initial spawn. Continuation
    /// uses this persisted value instead of the parent's current UI mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrangement_mode: Option<bool>,
    /// Provider/model identity that owns the persisted child transcript.
    /// Continuations fail closed after a live runtime switch because reasoning
    /// signatures and protocol blocks may not be portable across identities.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_model: Option<String>,
    /// Orchestration persona and fully resolved profile; resuming an old task without it fails closed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roster_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_profile_fingerprint: Option<String>,
    /// Tool names actually registered to the child at spawn time; later gates may only take a subset.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_tool_allowlist: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrate_work_id: Option<String>,
    /// Generated only by the runtime from structured ReviewVote data and counters; notification layers must not parse free-form verdict text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_vote_summary: Option<String>,
    /// Bounded progress recorded by the runtime; Agent Fleet reads only this structured field and never model self-reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_progress: Option<BoundedDiagnostic>,
    /// Cumulative provider-token usage in the current sub-agent transcript.
    #[serde(default, skip_serializing_if = "AgentUsageSummary::is_zero")]
    pub usage: AgentUsageSummary,
    /// Persisted state for one agent control plane. Defaults preserve old-sidecar runtime semantics.
    #[serde(default, skip_serializing_if = "AgentControlState::is_default")]
    pub control: AgentControlState,
    /// Persisted state for the tiered circuit breaker; P4 is updated only through structured signals.
    #[serde(default, skip_serializing_if = "AgentBreakerState::is_default")]
    pub breaker: AgentBreakerState,
    /// Provider tool-use block that created this sub-agent. Kept in durable
    /// task state so presentation clients can reconcile after event lag and
    /// rebuild delegated-task panels after a restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    /// Whether the live sub-agent loop can still consume queued SendMessage
    /// payloads. The loop closes this atomically before returning, preventing
    /// messages from being queued into the completion race window.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub accepting_subagent_messages: bool,
    /// Timestamp for the currently active sub-agent run. Used to distinguish
    /// a fresh continuation from a stale completion notification.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_run: Option<kcoder_types::BackgroundRunKey>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub background_runs: Vec<crate::BackgroundRunRecord>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    /// Runtime category for engine-managed jobs. Older snapshots do not have
    /// this field, so it defaults to `Generic` on deserialize.
    #[serde(default, skip_serializing_if = "TaskKind::is_generic")]
    pub kind: TaskKind,
    /// Whether this task is owned by the runtime task manager rather than the
    /// user-facing TaskCreate/TaskUpdate planning tools.
    #[serde(default, skip_serializing_if = "is_false")]
    pub managed: bool,
    /// Whether the invoking tool still owns inline result delivery or has
    /// handed the task to TaskOutput/TaskStop and background notifications.
    #[serde(default)]
    pub delivery: TaskDelivery,
    /// Set after the engine has injected a sub-agent or workflow completion
    /// notification for this task's final status. Older snapshots do not have
    /// this field, so it defaults to `None` on deserialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_injected_at_ms: Option<u64>,
    /// Whether completion should be delivered asynchronously to the parent
    /// conversation. Foreground sub-agent calls return their result inline and
    /// therefore disable this to avoid a duplicate notification/follow-up.
    /// Older snapshots represent background jobs, so they default to `true`.
    #[serde(
        default = "default_notify_parent_on_completion",
        skip_serializing_if = "is_true"
    )]
    pub notify_parent_on_completion: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueuedAgentMessage {
    pub message_id: String,
    pub body: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub status: AgentMessageStatus,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<AgentMessageLease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_anchor: Option<TranscriptDeliveryAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl QueuedAgentMessage {
    pub fn new(body: impl Into<String>) -> Self {
        let now = now_millis();
        Self {
            message_id: format!("msg-{}", Uuid::new_v4()),
            body: body.into(),
            created_at_ms: now,
            updated_at_ms: now,
            status: AgentMessageStatus::Queued,
            attempts: 0,
            lease: None,
            transcript_anchor: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentMessageStatus {
    Queued,
    Leased,
    Blocked,
    Acknowledged,
    DeadLetter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentMessageLease {
    pub lease_id: String,
    pub run_started_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TranscriptDeliveryAnchor {
    pub baseline_message_count: usize,
    pub baseline_sha256: String,
    pub body_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDeliveryEnqueueReceipt {
    pub message_id: String,
    pub queue_position: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentDeliveryClaim {
    pub message_id: String,
    pub lease_id: String,
    pub body: String,
    pub attempts: u32,
    pub transcript_anchor: Option<TranscriptDeliveryAnchor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentDeliveryClaimOutcome {
    Claimed(AgentDeliveryClaim),
    Empty,
    Busy {
        message_id: String,
        expires_at_ms: u64,
    },
    Blocked {
        message_id: String,
        attempts: u32,
        last_error: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentDeliveryFailureOutcome {
    Requeued,
    Blocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentControlAction {
    Pause,
    Resume,
    Halt,
    GateTools,
    ClearToolGate,
    RetryMessage,
    DiscardMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentControlReceipt {
    pub agent_id: String,
    pub action: AgentControlAction,
    pub control_revision: u64,
    pub run_mode: AgentRunMode,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentControlBoundaryOutcome {
    Continue,
    Paused,
    Halted,
}

/// Bounded diagnostics safe for fleet state, audit events, and the TUI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoundedDiagnostic {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentUsageSummary {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

impl AgentUsageSummary {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }

    fn is_zero(&self) -> bool {
        self.input_tokens == 0
            && self.output_tokens == 0
            && self.cache_creation_input_tokens == 0
            && self.cache_read_input_tokens == 0
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentRunMode {
    #[default]
    Running,
    PauseRequested,
    Paused,
    HaltRequested,
    Halted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingSteer {
    pub steer_id: String,
    pub source: String,
    pub message: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentControlState {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub run_mode: AgentRunMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_gate: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_steer: Option<PendingSteer>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub requested_by_session_id: String,
    #[serde(default)]
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<BoundedDiagnostic>,
}

impl Default for AgentControlState {
    fn default() -> Self {
        Self {
            revision: 0,
            run_mode: AgentRunMode::Running,
            tool_gate: Vec::new(),
            pending_steer: None,
            requested_by_session_id: String::new(),
            updated_at_ms: 0,
            reason: None,
        }
    }
}

impl AgentControlState {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BreakerStage {
    #[default]
    Healthy,
    Steered,
    Constrained,
    Paused,
    Halted,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentBreakerState {
    #[serde(default)]
    pub stage: BreakerStage,
    #[serde(default)]
    pub repeated_action_count: u32,
    #[serde(default)]
    pub consecutive_runtime_errors: u32,
    #[serde(default)]
    pub no_progress_rounds: u32,
    #[serde(default)]
    pub token_total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_action_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool_result_fingerprint: Option<String>,
    #[serde(default)]
    pub signal_sequence: u64,
    #[serde(default)]
    pub last_evaluated_signal_sequence: u64,
    #[serde(default)]
    pub last_transition_at_ms: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reason_codes: Vec<String>,
    /// Temporary privilege-reducing gate imposed by the circuit breaker, separate from manual control so recovery cannot overwrite a human choice.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_gate: Vec<String>,
}

impl AgentBreakerState {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BreakerDecision {
    pub agent_id: String,
    pub previous_stage: BreakerStage,
    pub stage: BreakerStage,
    pub reason_codes: Vec<String>,
    pub signal_sequence: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentFleetSnapshot {
    pub session_id: String,
    pub fleet_revision: u64,
    pub generated_at_ms: u64,
    pub runtime_audit_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_audit_degradation: Option<String>,
    pub members: Vec<FleetMemberSnapshot>,
    pub omitted_members: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub digest_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentFleetDelta {
    pub fleet_revision: u64,
    pub digest_sha256: String,
    pub runtime_audit_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_audit_degradation: Option<String>,
    pub changed_members: Vec<FleetMemberSnapshot>,
    pub removed_agent_ids: Vec<String>,
    pub omitted_members: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FleetMemberSnapshot {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    pub agent_kind: String,
    pub status: String,
    pub control_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orchestrate_work_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_revision: Option<u64>,
    pub plan_revision_status: String,
    pub queue_depth: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leased_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_progress: Option<BoundedDiagnostic>,
    pub consecutive_failures: u32,
    pub breaker_stage: String,
    pub usage: AgentUsageSummary,
    pub worktree_state: String,
    pub capability_fingerprint_prefix: String,
}

fn default_notify_parent_on_completion() -> bool {
    true
}

fn default_true() -> bool {
    true
}

fn is_true(value: &bool) -> bool {
    *value
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    #[default]
    Generic,
    Subagent,
    Workflow,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskDelivery {
    Foreground,
    #[default]
    Background,
}

impl TaskKind {
    pub fn is_generic(&self) -> bool {
        matches!(self, Self::Generic)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Paused,
    Halted,
    Completed,
    Failed,
    Cancelled,
}

impl Task {
    pub fn new(id: impl Into<String>, description: impl Into<String>) -> Self {
        let now = now_millis();
        Self {
            id: id.into(),
            description: description.into(),
            status: TaskStatus::Pending,
            output: None,
            output_path: None,
            transcript_path: None,
            pending_messages: Vec::new(),
            message_queue: Vec::new(),
            dead_letter_messages: Vec::new(),
            delivery_lease_timeout_seconds: default_delivery_lease_timeout_seconds(),
            delivery_max_attempts: default_delivery_max_attempts(),
            allowed_write_paths: Vec::new(),
            allowed_shell_prefixes: Vec::new(),
            artifact_requirements: Vec::new(),
            artifact_validation_run: None,
            artifact_baseline: None,
            artifact_validation_report: None,
            worktree_path: None,
            worktree_branch: None,
            parent_session_id: None,
            agent_kind: None,
            context_mode: None,
            context_turns: None,
            agent_depth: None,
            max_turns: None,
            arrangement_mode: None,
            agent_provider: None,
            agent_model: None,
            roster_name: None,
            resolved_profile_fingerprint: None,
            resolved_tool_allowlist: Vec::new(),
            orchestrate_work_id: None,
            review_vote_summary: None,
            current_progress: None,
            usage: AgentUsageSummary::default(),
            control: AgentControlState::default(),
            breaker: AgentBreakerState::default(),
            parent_tool_call_id: None,
            accepting_subagent_messages: true,
            run_started_at_ms: None,
            background_run: None,
            background_runs: Vec::new(),
            created_at_ms: now,
            updated_at_ms: now,
            kind: TaskKind::Generic,
            managed: false,
            delivery: TaskDelivery::Background,
            notification_injected_at_ms: None,
            notify_parent_on_completion: true,
        }
    }

    /// Materialize a former `Vec<String>` queue as the new queue with stable IDs.
    ///
    /// Return true when migration occurs. If old and new queues are both nonempty,
    /// leave them unchanged and require the caller to fail closed rather than guess ordering.
    pub fn migrate_legacy_pending_messages(&mut self) -> bool {
        if self.pending_messages.is_empty() || !self.message_queue.is_empty() {
            return false;
        }
        self.message_queue = self
            .pending_messages
            .drain(..)
            .map(QueuedAgentMessage::new)
            .collect();
        self.updated_at_ms = now_millis();
        true
    }

    pub fn has_delivery_queue_migration_conflict(&self) -> bool {
        !self.pending_messages.is_empty() && !self.message_queue.is_empty()
    }

    /// Release leases held by workers that no longer exist after process recovery while preserving attempt counts.
    pub fn recover_interrupted_deliveries(&mut self, max_attempts: u32) -> usize {
        self.migrate_legacy_pending_messages();
        if self.has_delivery_queue_migration_conflict() {
            return 0;
        }
        let now = now_millis();
        let mut recovered = 0usize;
        for message in &mut self.message_queue {
            if message.status != AgentMessageStatus::Leased {
                continue;
            }
            message.lease = None;
            message.updated_at_ms = now;
            message.status = if message.attempts >= max_attempts.max(1) {
                AgentMessageStatus::Blocked
            } else {
                AgentMessageStatus::Queued
            };
            recovered = recovered.saturating_add(1);
        }
        if recovered > 0 {
            self.updated_at_ms = now;
        }
        recovered
    }
}

fn default_delivery_lease_timeout_seconds() -> u64 {
    120
}

fn is_default_delivery_lease_timeout_seconds(value: &u64) -> bool {
    *value == default_delivery_lease_timeout_seconds()
}

fn default_delivery_max_attempts() -> u32 {
    8
}

fn is_default_delivery_max_attempts(value: &u32) -> bool {
    *value == default_delivery_max_attempts()
}

/// A persisted history entry with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub session_id: String,
    pub timestamp_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(
        default,
        rename = "parentUuid",
        skip_serializing_if = "Option::is_none"
    )]
    pub parent_uuid: Option<String>,
    #[serde(flatten)]
    pub message: Message,
}

/// Metadata recorded in the transcript when context compaction occurs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompactionTranscriptEvent {
    pub trigger: CompactionTrigger,
    pub pre_tokens: usize,
    pub post_tokens: usize,
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompactionTrigger {
    Manual,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PreservedTranscriptSegment {
    pub(super) head_uuid: String,
    pub(super) tail_uuid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct CompactionTranscriptMetadata {
    pub(super) boundary_uuid: String,
    pub(super) summary_uuid: String,
    pub(super) parent_uuid: Option<String>,
    pub(super) preserved_ids: Vec<Option<String>>,
    pub(super) preserved_segment: Option<PreservedTranscriptSegment>,
}

/// Result of pruning persisted session history files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneSessionHistoryReport {
    pub kept_sessions: usize,
    pub deleted_sessions: usize,
    pub deleted_files: Vec<PathBuf>,
}

/// Outcome of truncating the conversation for a session rewind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConversationRewindOutcome {
    /// Messages removed from the in-memory conversation.
    pub removed: usize,
    /// Whether a durable rewind boundary was appended to the transcript.
    /// False when no trustworthy anchor exists (for example after an
    /// in-memory-only rewrite); a later resume then replays the full history.
    pub boundary_recorded: bool,
}

/// Serializable snapshot of a session for export/import and debugging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub cwd: PathBuf,
    #[serde(default, skip_serializing_if = "SessionMode::is_default")]
    pub session_mode: SessionMode,
    #[serde(default)]
    pub model_selection_mode: kcoder_types::ModelSelectionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_model: Option<String>,
    /// Whether the first message ever entered this session. Even if rewind clears
    /// all exported visible messages, import cannot reselect the set-once session mode.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub conversation_started: bool,
    pub messages: Vec<Message>,
    pub todos: Vec<TodoItem>,
    pub tasks: HashMap<String, Task>,
    pub plan_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<Goal>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub goal_history: Vec<Goal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_memory: Option<SessionMemorySnapshot>,
    /// Wall-clock time of the latest assistant message. This lets a resumed
    /// session decide whether its provider prompt cache has gone cold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_assistant_message_timestamp_ms: Option<u64>,
}

/// Metadata for the session-memory Markdown file.
///
/// The summary text itself is stored in `summary_path`; the sidecar keeps only
/// enough metadata to resume and reason about when it was refreshed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionMemorySnapshot {
    pub summary_path: PathBuf,
    pub updated_at_ms: u64,
    pub updated_message_count: usize,
    #[serde(default)]
    pub updated_model_tokens: usize,
    #[serde(default)]
    pub pending_update_backlog: bool,
    pub update_count: u64,
    pub source: String,
}

impl SessionMemorySnapshot {
    pub fn new(
        summary_path: impl Into<PathBuf>,
        updated_message_count: usize,
        updated_model_tokens: usize,
        update_count: u64,
        source: impl Into<String>,
    ) -> Self {
        Self {
            summary_path: summary_path.into(),
            updated_at_ms: now_millis(),
            updated_message_count,
            updated_model_tokens,
            pending_update_backlog: false,
            update_count,
            source: source.into(),
        }
    }

    pub fn with_pending_update_backlog(mut self, pending: bool) -> Self {
        self.pending_update_backlog = pending;
        self
    }
}

/// Runtime metadata for a worktree entered by the current session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorktreeSessionState {
    pub original_cwd: PathBuf,
    pub worktree_path: PathBuf,
    pub worktree_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_head_commit: Option<String>,
    #[serde(default)]
    pub created_by_session: bool,
}

/// Runtime record of a file read in the current session.
#[derive(Debug, Clone)]
pub struct FileReadSnapshot {
    /// Decoder selection that produced this snapshot; not inferred from text.
    pub source_encoding_hint: Option<String>,
    pub content: Option<Arc<str>>,
    pub modified: Option<SystemTime>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub from_read_tool: bool,
    /// The exact Read result was compacted out of model context. A later unchanged
    /// full read should return a bounded actionable anchor, neither referencing absent
    /// body text nor reinserting the entire large file.
    pub anchor_pending: bool,
    /// The full body was compacted out of model context. Preserve this state after
    /// returning the first anchor so the model cannot reinsert the body through an
    /// explicit range that effectively spans the full file. Clear it only after the
    /// file changes and new body text is actually returned.
    pub full_body_compacted: bool,
}

impl FileReadSnapshot {
    pub fn is_full_read(&self) -> bool {
        ReadRangeKey::new(self.offset, self.limit).is_full()
    }
}

/// Normalized range key for Read requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ReadRangeKey {
    Full,
    Range { offset: usize, limit: Option<usize> },
}

impl ReadRangeKey {
    pub fn new(offset: Option<usize>, limit: Option<usize>) -> Self {
        let normalized_offset = offset.unwrap_or(1).max(1);
        if limit.is_none() && normalized_offset == 1 {
            Self::Full
        } else {
            Self::Range {
                offset: normalized_offset,
                limit,
            }
        }
    }

    pub fn is_full(self) -> bool {
        matches!(self, Self::Full)
    }

    pub(crate) fn stored_parts(self) -> (Option<usize>, Option<usize>) {
        match self {
            Self::Full => (None, None),
            Self::Range { offset, limit } => (Some(offset), limit),
        }
    }
}
