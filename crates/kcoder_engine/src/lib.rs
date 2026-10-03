use anyhow::{Context, Result};
use async_stream::stream;
use futures::{Stream, StreamExt, stream::FuturesUnordered};
use kcoder_api::{Provider, ProviderFactory, ProviderKind};
use kcoder_config::{
    DoomLoopSettings, GoalProTestScope, MAX_CONCURRENT_SUBAGENTS, MemoryObserverMode,
    PermissionMode, Settings, dotted_value, remove_dotted_value, set_dotted_value,
    update_settings_file,
};
use kcoder_memory::{
    MemoryManager, MemoryObserverDraft, MemoryObserverDraftValidationIssue,
    MemoryObserverEventBundle, MemoryObserverQueue, MemoryObserverQueueConfig,
    MemoryObserverQueueOverflowPolicy, MemoryObserverQueueStats, MemoryObserverQueueSubmitResult,
    MemoryObserverSanitizationOptions, MemorySessionInput, MemoryStore,
    deterministic_memory_observer_draft, memory_observer_draft_to_structured_writes,
    memory_observer_output_schema, validate_memory_observer_draft,
};
use kcoder_permissions::{
    PermissionDecision, PermissionEngine, PermissionPrompt, PermissionRequestContext,
    classify_bash_read_only, request_context_for,
};
use kcoder_skills::SkillRegistry;
use kcoder_state::{
    AppState, CompactionTranscriptEvent, CompactionTrigger, GoalStatus, RecoveryDecision,
    RecoveryOutcome, SessionMemorySnapshot, TaskKind, TaskStatus, TodoItem, TodoStatus,
};
use kcoder_tools::{
    BackgroundJobSpawner, CronFire, CronScheduler, LifecycleHookEmitter, LifecycleHookResult,
    Sandbox, ShellEnvironmentSnapshot, SkillCuratorTool, SkillGuardPolicy, Tool, ToolContext,
    ToolDescriptionContext, ToolError, ToolOutput, ToolPermissionMode, ToolRegistry,
    UserQuestionRequest, UserQuestionResponse, UserQuestioner,
};
use kcoder_types::{
    ContentBlock, ContentDelta, Message, MessagesRequest, ResponseJsonSchema, StreamEvent, Usage,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque, hash_map::DefaultHasher};
use std::hash::{Hash, Hasher};
use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::{
    fs,
    path::{Path, PathBuf},
    pin::Pin,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::time::{Duration, timeout};
use tokio_util::sync::CancellationToken;
use tracing::{debug, error, warn};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientSkillSummary {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: String,
}

pub mod agent;
pub mod agent_live_view;
mod attempt_diagnostic_requests;
pub mod background;
mod background_runtime;
mod session_inspection;
mod token_estimate_cache;
mod tool_input_hints;
mod tool_serialization_cache;
mod turn_driver;
pub use background_runtime::BackgroundWorkIdleReservation;
pub mod checkpoint;
mod client_model_configuration;
mod client_session_runtime;
mod compaction_runtime;
pub mod context;
mod event;
mod forking;
pub mod goal_continuation;
mod lifecycle;
mod memory_idle;
mod memory_observer;
mod memory_recording_runtime;
mod message_repair;
mod moa_plan;
mod moa_runtime;
pub mod orchestrate;
mod path_preview;
mod path_preview_runtime;
mod permission_runtime;
mod prompt_runtime;
mod provider_runtime;
mod skill_catalog_runtime;
mod tool_compaction_runtime;
pub use client_model_configuration::{ClientModelConfiguration, ClientModelContinuationOptions};
mod recovery_deadline;
mod recovery_record;
mod request_admission;
#[cfg(test)]
mod request_assembly_measurements;
mod retry_policy;
mod session_end_runtime;
mod session_memory_runtime;
mod skill_maintenance_runtime;
pub mod skill_review;
pub mod stream;
mod summary_runtime;
pub mod tdd_guard;
#[cfg(test)]
mod test_support;
mod todo_runtime;
mod tool_failure_runtime;
mod tool_file_observation;
mod tool_input_log;
mod tool_repair;
mod tool_schema_runtime;
mod usage;
mod verification_target;
mod write_preview;

pub use background::{BackgroundJobEvent, BackgroundJobManager};
pub use client_session_runtime::client_turn_ids_for_messages;
pub use event::{EngineEvent, ProviderRetryDetails};
pub(crate) use lifecycle::EngineLifecycleHookEmitter;
pub use memory_observer::{
    MemoryObserverEventLogDiagnostics, MemoryObserverRecoveryAuditDiagnostics,
    MemoryObserverValidationFailureDiagnostics, MemoryObserverWorkerDiagnostics,
};
use memory_recording_runtime::count_memory_prompt_candidates;
pub(crate) use message_repair::repair_tool_message_sequence;
use permission_runtime::{apply_edited_input, permission_response_to_decision};
pub use provider_runtime::{
    ConfiguredModelProfile, DiscoveredModelGroup, model_configuration_summary,
};
pub use usage::UsageAccumulator;
pub use write_preview::{WRITE_PREVIEW_LINES, WriteInputPreview};

use crate::stream::{
    DEFAULT_STREAM_IDLE_TIMEOUT, default_timed_stream, graded_idle_timeout, timed_stream,
};
use compaction_runtime::{AutoCompactState, PrefireOwner};
use context::{
    CompactionRequest, ContextBudget, ContextManager, ConversationCompactor,
    DEFAULT_SESSION_MEMORY_TEMPLATE, MicroCompactConfig, PostCompactAttachments,
    SessionMemoryCompactionPlan, TimeBasedMicroCompactConfig, TokenCount, TokenCountSource,
    TokenCounter, ToolResultStorage, apply_micro_compact, apply_time_based_micro_compact,
    build_session_memory_compaction_plan, build_session_memory_update_prompt,
    collect_recent_file_attachments, extract_session_memory_markdown, latest_compact_boundary,
    messages_after_latest_compact_boundary, session_memory_has_required_sections,
};
use message_repair::{content_blocks_plain_text, interrupted_tool_result};
pub use moa_plan::{MoaPlanPreflight, MoaPlanProgress, MoaPlanResult};
use moa_runtime::*;
use prompt_runtime::*;
use provider_runtime::schedule_provider_prewarm;
use retry_policy::*;
use skill_maintenance_runtime::record_loaded_skill_metadata;
use todo_runtime::TodoUpdateReminderTracker;
use tool_failure_runtime::{
    ToolFailureRecord, ToolFailureTracker, VerificationFailureRecord, tool_output_text,
};
use tool_file_observation::{
    changed_snapshot_paths, collect_touched_paths, is_direct_file_mutation_tool_name,
    is_shell_tool_name, should_track_shell_file_changes, snapshot_files_async,
};
use tool_input_log::tool_input_log_summary;
use tool_schema_runtime::{
    build_tool_caches, format_schema_example_for_prompt, normalize_freeform_tool_input,
};
use usage::{merge_stream_usage, usage_increment};
use verification_target::verification_target_from_tool_input;

const SESSION_MEMORY_COMPACT_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_MEMORY_UPDATE_STALE_AFTER: Duration = Duration::from_secs(60);
const PROVIDER_PREWARM_TIMEOUT: Duration = Duration::from_secs(10);
const TOOL_INPUT_PROGRESS_STEP_CHARS: usize = 128;
const WRITE_INPUT_PREVIEW_STEP_CHARS: usize = 512;
const COMPACT_CONTINUATION_PREFIX: &str =
    "This session is being continued from a previous conversation";

/// Maximum number of tool-backed agent rounds in a single turn.
const MAX_AGENT_TURNS: usize = 99_999;

/// Maximum consecutive auto-compact failures before the circuit breaker trips.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: usize = 3;

/// Extra tokens an active goal may consume to finish the in-flight response
/// after its token budget trips mid-stream. The bounded grace lets the model
/// wrap up (and record a complete/blocked verdict) instead of losing a
/// response it already paid for; exceeding the grace still hard-aborts the
/// stream, and no further API calls start once the budget has tripped.
const GOAL_BUDGET_GRACE_TOKENS: u64 = 4_000;

/// Maximum consecutive continuation nudges when the model ends a response
/// with no visible text and no tool calls (e.g. a thinking-only message).
/// Without the nudge such a response is treated as turn completion, and a
/// headless session would silently end as "success" mid-task.
const EMPTY_RESPONSE_NUDGE_LIMIT: usize = 3;

/// Internal follow-up injected when the model finishes a response without
/// any visible text or tool calls, so the turn continues instead of
/// silently completing.
const EMPTY_RESPONSE_NUDGE: &str = "<system-reminder>Your previous response contained no visible text and no tool calls, so nothing was done or answered. Continue the task now: take the next concrete step with the available tools, or write your final answer as visible text. Do not stop at internal reasoning.</system-reminder>";

/// Minimum turn distance before auto-compaction may run again.
///
/// A successful compaction usually leaves the transcript close to the trigger
/// threshold. Without a short cooldown, the next tool loop can immediately
/// re-enter compaction before enough new conversation has accumulated.
const AUTOCOMPACT_COOLDOWN_TURNS: usize = 2;

const MEMORY_OBSERVER_EVENT_LOG_SCHEMA_VERSION: u32 = 1;
const MEMORY_OBSERVER_EVENT_LOG_FILE: &str = "memory-observer-events.jsonl";

const SHELL_TOOL_CLEANUP_GRACE_MS: u64 = 5_000;

const SUPERPOWERS_ROOT_SKILL_NAME: &str = "using-superpowers";
const SPEC_WORKFLOW_SKILL_NAME: &str = "using-specs";
const TDD_SKILL_NAME: &str = "test-driven-development";
const INTERNAL_SKILL_CURATOR_PREFIX: &str = "[internal:skill-curator]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkspacePersistenceMode {
    Interactive,
    Client,
}

/// Background services created once per app-server workspace.
///
/// Independent client engines may share these handles, but never thread-level
/// state such as `AppState`, permission sessions, background task managers, or checkpoints.
#[derive(Clone)]
pub struct WorkspaceRuntimeServices {
    diagnostic_writer: kcoder_state::DiagnosticWriter,
    cron_scheduler: Arc<CronScheduler>,
    shell_environment_snapshot: ShellEnvironmentSnapshot,
    provider_prewarmed: Arc<AtomicBool>,
    client_storage: Option<(PathBuf, Option<Arc<kcoder_config::PrivateTempDir>>)>,
}

/// Non-interactive questioner used by yolo mode for internal trust prompts.
///
/// The model-facing AskUserQuestion tool is hidden/rejected in yolo mode, but
/// some internal tools still use the same questioner for "activate/cancel"
/// style confirmations. Yolo means the session should not block on those
/// prompts, so choose the first option and continue.
#[derive(Debug, Clone, Copy, Default)]
struct YoloUserQuestioner;

#[derive(Debug, Clone)]
struct ToolUseItem {
    index: usize,
    id: String,
    name: String,
    input: Value,
}

#[derive(Debug)]
struct ToolUseGroup {
    sequential: bool,
    items: Vec<ToolUseItem>,
}

const SUBAGENT_FINISH_REMINDER_INTERVAL_TURNS: usize = 5;

#[derive(Debug, Clone)]
struct SubagentFinishReminder {
    agent_id: String,
}

#[derive(Debug, Clone)]
struct SubagentFinishReminderState {
    agent_id: String,
    next_reminder_turn: usize,
    reminder_interval: usize,
}

/// Maximum steering inputs buffered for one active turn, aligned with the TUI input limit.
const TURN_STEER_QUEUE_MAX: usize = 64;

/// Stable reason returned when the current turn cannot accept steering input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnSteerError {
    NoActiveTurn,
    QueueFull { max: usize },
}

#[derive(Debug, Clone)]
struct PendingTurnSteer {
    id: u64,
    message: Message,
}

#[derive(Debug)]
struct ActiveTurnSteers {
    turn_id: u64,
    pending: VecDeque<PendingTurnSteer>,
}

#[derive(Debug, Default)]
struct TurnSteerMailbox {
    next_turn_id: u64,
    active: Option<ActiveTurnSteers>,
}

#[derive(Debug)]
pub struct TurnSteerSession {
    mailbox: Arc<Mutex<TurnSteerMailbox>>,
    turn_id: u64,
    closed: bool,
}

enum TurnSteerBoundary {
    Pending(Vec<PendingTurnSteer>),
    Finished,
}

/// High-level conversation orchestrator.
#[derive(Debug, Clone, Default)]
enum SettingsPersistenceTarget {
    #[default]
    Disabled,
    UserFile(PathBuf),
}

#[derive(Clone)]
struct SubagentRuntimeControl {
    parent_state: AppState,
    agent_id: String,
    transcript_path: PathBuf,
    checkpoint_writer: Arc<dyn SubagentCheckpointWriter>,
}

#[async_trait::async_trait]
trait SubagentCheckpointWriter: Send + Sync {
    async fn write(&self, path: &Path, messages: &[Message]) -> anyhow::Result<()>;
}

#[derive(Debug, Default)]
struct FilesystemSubagentCheckpointWriter;

#[derive(Clone)]
pub struct QueryEngine {
    desktop_binding: desktop_binding::DesktopBindings,
    provider: Arc<RwLock<Arc<dyn Provider>>>,
    client_model_configuration: Option<Arc<dyn ClientModelConfiguration>>,
    client_model_options: Arc<RwLock<client_model_configuration::ClientModelOptions>>,
    request_class: request_admission::RequestClass,
    pub state: AppState,
    pub tools: ToolRegistry,
    /// Base registry used for sub-agents before role filtering.
    subagent_tools: Arc<RwLock<ToolRegistry>>,
    /// Model-facing tool definitions are immutable for the lifetime of an
    /// engine, so build them once instead of regenerating schemars output on
    /// every provider continuation.
    tool_definitions: Arc<Vec<kcoder_types::ToolDefinition>>,
    tool_input_hints: Arc<tool_input_hints::ToolInputHints>,
    tool_schema_revision: kcoder_tools::ToolRegistryRevision,
    /// Raw input schemas used for local coercion/validation before a tool runs.
    tool_input_schemas: Arc<HashMap<String, Value>>,
    pub permissions: Arc<RwLock<PermissionEngine>>,
    pub settings: Arc<RwLock<Settings>>,
    /// File-edit surface pinned when this engine was created. The session
    /// cannot switch surfaces mid-run; later `tools.file_edit_tool` changes
    /// in the live settings do not affect this engine.
    file_edit_surface: kcoder_config::FileEditSurface,
    /// Persistence target for user configuration. Disabled by default; writes are allowed only when the host supplies an explicit user file.
    settings_persistence_target: Arc<RwLock<SettingsPersistenceTarget>>,
    /// Shared ordering gate for every settings read-modify-write, preventing a stale snapshot from finishing later and overwriting newer state.
    settings_persistence_order: Arc<AsyncMutex<()>>,
    /// Serialize stateful tool calls shared by foreground and direct workflow execution.
    tool_execution_gate: Arc<tokio::sync::RwLock<()>>,
    pub memory_manager: Arc<MemoryManager>,
    pub memory_store: Arc<MemoryStore>,
    memory_prompt_counter: Arc<RwLock<u64>>,
    memory_observer_queue: Arc<RwLock<MemoryObserverQueue>>,
    memory_idle_gate: Arc<RwLock<()>>,
    memory_idle_reserved: Arc<AtomicBool>,
    memory_observer_last_validation_failure:
        Arc<RwLock<Option<MemoryObserverValidationFailureDiagnostics>>>,
    memory_observer_worker_diagnostics: Arc<RwLock<MemoryObserverWorkerDiagnostics>>,
    memory_observer_worker_running: Arc<AtomicBool>,
    memory_observer_worker_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    memory_session_end_summary_recorded: Arc<AtomicBool>,
    pub skill_registry: Arc<RwLock<SkillRegistry>>,
    pub active_skills: Arc<RwLock<Vec<String>>>,
    skill_registry_generation: Arc<AtomicU64>,
    /// Skill-mutation identity for internal reviewer/curator forks; None for regular foreground engines.
    skill_mutation_actor: Arc<Option<kcoder_skills::SkillMutationActor>>,
    pub cwd: PathBuf,
    /// Root for transient per-session artifacts such as large tool results and checkpoints.
    /// Client-hosted engines keep these outside the remote workspace.
    session_storage_root: PathBuf,
    /// Owns a fallback temporary root until the last engine/fork clone drops.
    client_storage_owner: Option<Arc<kcoder_config::PrivateTempDir>>,
    /// Controls all implicit workspace persistence. Client-hosted engines keep
    /// session artifacts outside the remote project and disable passive skill
    /// telemetry/maintenance; interactive TUI engines preserve legacy behavior.
    workspace_persistence_mode: WorkspacePersistenceMode,
    cancel_token: CancellationToken,
    /// Fail closed after an input durability failure until the session is reloaded.
    input_persistence_failed: Arc<AtomicBool>,
    /// One-shot signal that collapses running wait-style tools (Sleep, wait) to
    /// a short grace period without cancelling the turn. Shared across clones.
    shorten_signal: Arc<tokio::sync::Notify>,
    auto_compact_state: Arc<RwLock<AutoCompactState>>,
    token_estimate_cache: Arc<token_estimate_cache::TokenEstimateCache>,
    session_inspection_store: Arc<kcoder_tools::session_inspect::SessionInspectionStore>,
    session_request_observation: Arc<Mutex<Option<session_inspection::PreparedRequestObservation>>>,
    tool_serialization_cache: Arc<tool_serialization_cache::ToolSerializationCache>,
    prefire_owner: Arc<PrefireOwner>,
    /// Lifecycle hooks discovered from settings files.
    hook_registry: kcoder_hooks::HookRegistry,
    /// Plugin contributions frozen at startup; an engine and its clones do not rescan plugin directories.
    plugin_snapshot: Arc<kcoder_plugins::EffectivePluginSnapshot>,
    /// Project-directory trust decision completed during engine construction.
    folder_trusted: bool,
    /// Backend for interactive user questions.
    user_questioner: Arc<dyn UserQuestioner>,
    /// Runtime sandbox restricting filesystem and command access.
    sandbox: Arc<Sandbox>,
    /// Per-prompt file checkpoints (write/edit originals) for `/rewind`.
    checkpoints: checkpoint::CheckpointManager,
    /// Arrangement runtime mode for this engine/fork.
    arrangement_mode: Arc<AtomicBool>,
    luna_mode: Arc<AtomicBool>,
    /// Optional write scope inherited by forked Arrangement worker agents.
    allowed_write_paths: Arc<RwLock<Vec<String>>>,
    /// Shell prefixes explicitly delegated to a forked Arrangement worker.
    allowed_shell_prefixes: Arc<RwLock<Vec<String>>>,
    /// Optional shell mutation guard inherited by verifier/tool agents.
    block_shell_file_mutation: Arc<AtomicBool>,
    /// Whether a Goal Pro verifier is forbidden from modifying the shared dependency environment.
    block_dependency_mutation: Arc<AtomicBool>,
    /// Private home, cache, and temporary directories for a Goal Pro verifier.
    shell_isolation_root: Arc<RwLock<Option<PathBuf>>>,
    /// Test-scope gate applied before Goal Pro verifier execution.
    verifier_minimum_test_scope: Arc<RwLock<Option<GoalProTestScope>>>,
    /// Whether Goal Pro verifier test commands must preserve their original exit codes.
    verifier_require_raw_exit_code: Arc<AtomicBool>,
    /// Whether a Goal Pro verifier requires a behavioral difference between candidate and baseline.
    verifier_require_behavior_delta: Arc<AtomicBool>,
    /// Engine-created pristine baseline exposed only to verifier test runs.
    verifier_baseline_root: Arc<RwLock<Option<PathBuf>>>,
    /// Vote channel for a Goal Pro verifier session; always None for non-verifier sessions.
    verifier_vote_channel: Arc<RwLock<Option<kcoder_tools::VerifierVoteChannel>>>,
    /// Work/revision-bound vote channel for an orchestration critic session.
    review_vote_channel: Arc<RwLock<Option<kcoder_tools::ReviewVoteChannel>>>,
    /// Whether the final turn switches to verifier verdict collection with only VerifierVote available.
    terminal_verdict_turn: Arc<AtomicBool>,
    /// Host opt-in for temporary streamed path hints; not a user setting.
    tool_path_previews: bool,
    /// Logical depth in the public sub-agent tree (main engine = 0).
    agent_depth: Arc<AtomicU32>,
    /// Cache-safe params from the most recent main-thread turn, used for
    /// forked-agent prompt-cache sharing.
    last_cache_safe_params: Arc<RwLock<Option<Arc<crate::agent::CacheSafeParams>>>>,
    /// Project instructions frozen at engine creation and prepended as the
    /// same synthetic user message on every provider request. Keeping this
    /// byte-identical preserves the prompt-cache prefix across turns.
    project_user_context: Arc<Option<Message>>,
    /// Role identity for a forked sub-agent. This is kept separate from the
    /// delegated user task so role constraints have system-level priority.
    subagent_system_prompt: Arc<Option<String>>,
    /// Parent-task control state read by a forked child at every provider/tool safety boundary.
    subagent_runtime_control: Arc<Option<SubagentRuntimeControl>>,
    /// Cumulative API token usage observed across all assistant turns.
    cumulative_usage: Arc<RwLock<UsageAccumulator>>,
    /// Tool-iteration counter for the background skill sedimentation loop.
    auto_skill_review_counter: Arc<RwLock<usize>>,
    /// Prevent overlapping background skill-review forks.
    auto_skill_review_running: Arc<AtomicBool>,
    /// Last time the automatic non-LLM skill curator was scheduled.
    auto_curator_last_run: Arc<RwLock<Option<SystemTime>>>,
    /// Foreground activity marker used to honor curator idle-delay settings.
    auto_curator_last_activity: Arc<RwLock<SystemTime>>,
    /// Prevent overlapping automatic curator jobs.
    auto_curator_running: Arc<AtomicBool>,
    /// Prevent overlapping background session-memory refreshes. The refresh is
    /// intentionally not awaited by the main turn loop.
    session_memory_update_running: Arc<AtomicBool>,
    /// Start time for the current background session-memory refresh. Compact
    /// uses it to avoid waiting for stale jobs forever.
    session_memory_update_started_at: Arc<Mutex<Option<Instant>>>,
    /// Wakes compact if it is briefly waiting for a background session-memory
    /// refresh to finish.
    session_memory_update_notify: Arc<Notify>,
    session_memory_update_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Manager for delegated background work.
    background_jobs: Arc<BackgroundJobManager>,
    /// Hard limiter for live forked sub-agent execution. Tool-level caps reject
    /// excessive fan-out early; this semaphore catches direct runner calls and
    /// nested/internal fan-out paths.
    subagent_semaphore: Arc<Semaphore>,
    /// Receiver for background job completion events.
    background_recovery_announced: Arc<Mutex<HashSet<kcoder_types::BackgroundRunKey>>>,
    background_started_announced: Arc<Mutex<HashSet<kcoder_types::BackgroundRunKey>>>,
    background_job_rx:
        Arc<tokio::sync::Mutex<tokio::sync::broadcast::Receiver<BackgroundJobEvent>>>,
    /// Ownership signal for background notification delivery: set while a
    /// main-thread turn stream is alive on this engine.
    turn_driver_signal: turn_driver::TurnDriverSignal,
    /// Recent model-visible tool failures by tool name and normalized input.
    tool_failure_tracker: Arc<RwLock<ToolFailureTracker>>,
    /// Counts completed tool calls while an active TodoList exists and no
    /// successful TodoWrite update has happened.
    todo_update_reminder_tracker: Arc<RwLock<TodoUpdateReminderTracker>>,
    /// Current-session tool failure/success events, converted into repair
    /// examples only when the session ends.
    tool_repair_recorder: Arc<RwLock<tool_repair::ToolRepairSessionRecorder>>,
    /// Finalized repair examples from prior sessions. The current session
    /// buffer is intentionally excluded from retrieval.
    tool_repair_index: Arc<tool_repair::ToolRepairIndex>,
    /// One-shot MoA request set by `/moa`; consumed by the next foreground
    /// turn and never written into user-visible conversation history.
    next_moa_request: Arc<RwLock<Option<MoaTurnRequest>>>,
    /// Turn-local mailbox for user steering. Forked engines construct an
    /// independent mailbox; ordinary clones of one foreground engine share it.
    turn_steer_mailbox: Arc<Mutex<TurnSteerMailbox>>,
    /// Startup-built shell rc snapshot shared by the main engine and forks.
    shell_environment_snapshot: ShellEnvironmentSnapshot,
    cron_scheduler: Arc<CronScheduler>,
}

mod engine_support;
use engine_support::*;

mod workspace_services;
use workspace_services::*;

mod desktop_binding;
mod tool_context_runtime;
pub use desktop_binding::{DesktopTurnGuard, DesktopTurnRevoker};

mod subagent_finish_runtime;
use subagent_finish_runtime::*;

mod turn_steering;

mod subagent_boundary_runtime;
use subagent_boundary_runtime::*;

mod memory_extraction_runtime;
use memory_extraction_runtime::*;

mod context_injection;
use context_injection::*;

mod response_accounting;
use response_accounting::*;

mod tool_batch_runtime;
use tool_batch_runtime::*;

mod runtime_inspection;

mod engine_builder;

mod engine_configuration;

mod orchestrate_control_runtime;

mod session_transition_runtime;

mod workflow_agent_runtime;

mod turn_entry;

mod stream_response;

mod request_assembly;

#[cfg(test)]
#[path = "tests/retry_marker.rs"]
mod retry_marker_tests;

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;
