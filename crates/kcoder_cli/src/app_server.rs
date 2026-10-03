//! Machine-readable app-server transport for GUI and remote clients.
//!
//! The first transport is deliberately small: one JSON object per line on
//! stdin/stdout. Logs must stay on stderr so an SSH process can use stdout as a
//! clean bidirectional protocol stream.

use crate::{HeadlessPermissionPrompt, engine_event_json};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use fs2::FileExt;
use futures::StreamExt;
use kcoder_app_protocol::{
    AgentArtifactReadParams, AgentListParams, AgentListResult, AgentSteerAppliedParams,
    AgentSteerParams, AgentSteerResult, AgentSteerStatus, AgentSummary, ApprovalAction,
    ApprovalDecision, ApprovalRequestParams, ApprovalResolvedParams, ApprovalResponse,
    AttachmentDeleteParams, AttachmentReadChunkParams, AttachmentReadParams, AttachmentSaveParams,
    AttachmentUploadCancelParams, AttachmentUploadChunkParams, AttachmentUploadFinishParams,
    AttachmentUploadStartParams, BrowserActionParams, BrowserEvaluateParams, BrowserSessionParams,
    BrowserStartParams, DeviceExecuteParams, DeviceExecuteResult, ImplementationInfo,
    InitializeParams, InitializeResult, JSONRPC_VERSION, MetadataUpdate, PROTOCOL_VERSION,
    Question, QuestionOption, QuestionRequestParams, QuestionResolvedParams, QuestionResponse,
    ServerCapabilities, SettingsTemplateBinding, SettingsTemplateDefaultParams,
    SettingsTemplateDeleteParams, SettingsTemplateReadParams, SettingsTemplateSaveParams,
    StorageCleanParams, THREAD_METADATA_SCHEMA, TerminalAttachParams, TerminalCloseParams,
    TerminalListParams, TerminalResizeParams, TerminalStartParams, TerminalWriteParams, Thread,
    ThreadCompactParams, ThreadCompactResult, ThreadDeleteParams, ThreadDeleteResult,
    ThreadForkParams, ThreadForkResult, ThreadGoal, ThreadGoalClearResult, ThreadGoalEvent,
    ThreadGoalGetResult, ThreadGoalHistoryResult, ThreadGoalParams, ThreadGoalSetParams,
    ThreadGoalSetResult, ThreadListParams, ThreadMessage, ThreadMetadata,
    ThreadMetadataUpdateParams, ThreadMetadataUpdateResult, ThreadParent, ThreadReadParams,
    ThreadReadResult, ThreadRollbackParams, ThreadRollbackResult, ThreadStartParams,
    TurnFileChangesPolicy, TurnStartParams, method,
};
use kcoder_engine::{BackgroundJobEvent, EngineEvent, QueryEngine};
use kcoder_permissions::{PermissionPrompt, PermissionRequestContext, PermissionResponse};
use kcoder_state::{
    AgentMessageStatus, Goal, GoalMode, GoalStatus, GoalVerificationKind, GoalVerifierSelection,
    Task, TaskDelivery, TaskKind, TaskStatus,
};
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse, UserQuestioner};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;

mod agent_artifacts;
mod attachments;
mod browser;
mod computer_use_status;
mod config_templates;
mod cron_processor;
#[cfg(any(windows, test))]
mod desktop_notifications;
#[cfg(windows)]
mod desktop_turn;
mod engine_factory;
mod failed_turn;
mod git;
mod goal_lifecycle;
mod history_catalog;
mod history_refresh_processor;
mod hook_configuration;
mod indexed_read_gate;
mod indexed_transcript;
mod knowledge_directory;
mod knowledge_documents;
mod knowledge_job_runner;
mod knowledge_model;
mod knowledge_requests;
mod knowledge_transfer;
pub(crate) mod knowledge_worker;
mod knowledge_worker_model;
mod mcp_authorization_processor;
mod mcp_configuration;
mod mcp_processor;
mod plugin_processor;
mod private_files;
mod project_automations;
mod protocol_io;
mod provider_probe;
mod provider_settings;
mod recent_error;
mod resources_processor;
mod session_configuration;
mod skill_processor;
mod snapshot_leases;
mod storage_diagnostics;
mod storage_scans;
mod terminal;
mod thread_creations;
mod thread_list_snapshots;
mod thread_runtime;
mod tool_images;
mod tools_catalog;
mod tracked_history_list;
mod transcript_artifact_journal;
#[cfg(test)]
mod transcript_context_oracle;
mod transcript_window;
mod turn_admissions;
mod turn_attempts;
mod turn_execution;
mod turn_file_changes_settings;
mod turn_receipts;
mod usage_processor;
mod workflow_canvas;
mod workspace_fs;

use attachments::{
    ATTACHMENT_TTL, AttachmentDirectories, attachment_read, attachment_read_chunk, attachment_save,
    attachment_upload_cancel, attachment_upload_chunk, attachment_upload_finish,
    attachment_upload_start, clone_fork_attachments, materialize_turn_attachments,
    model_message_from_materialized_prompt, scavenge_stale_attachment_directories,
    split_history_attachment_envelope,
};
use browser::BrowserRegistry;
use config_templates::{resolve_session_template, user_template_store};
pub(super) use engine_factory::AppServerEngineFactory;
use git::{
    ensure_bare_snapshot_layout, git_branch_diff, git_branch_diff_shortstat, git_last_commit_diff,
    git_working_diff, run_git_command, run_git_command_with_auth, run_git_command_with_index,
    run_git_command_with_index_and_stdin, run_git_command_with_private_repository,
    run_git_command_with_stdin,
};
use plugin_processor::PluginProcessor;
mod turn_permissions;
use private_files::{ensure_private_artifact_directory, hex_sha256, write_private_artifact_file};
use protocol_io::{
    JsonRpcLine, browser_success_response, error_response, notification, send, success_response,
};
#[cfg(test)]
use protocol_io::{MAX_ERROR_MESSAGE_BYTES, MAX_JSONRPC_LINE_BYTES, read_bounded_jsonrpc_line};
use terminal::{
    TerminalRegistry, TerminalRegistryGuard, attach as terminal_attach, close as terminal_close,
    list as terminal_list, resize as terminal_resize, start as terminal_start,
    write as terminal_write,
};
use thread_runtime::{ThreadManager, ThreadRuntime};
use workspace_fs::{
    MAX_WORKSPACE_TEXT_BYTES, create_directory as workspace_create_directory,
    create_text_file as workspace_create_text_file,
    create_workspace_directory as workspace_create_workspace_directory,
    delete_entry as workspace_delete_entry, list_directories as workspace_list_directories,
    path as workspace_path, read_file_chunk as workspace_read_file_chunk,
    read_text_file as workspace_read_text_file, rename_entry as workspace_rename_entry,
    tree as workspace_tree, write_text_file as workspace_write_text_file,
};

const OUTBOUND_CAPACITY: usize = 512;
const OUTBOUND_FRAME_LIMIT_BYTES: usize = 1_900_000;
const OUTBOUND_FRAME_LIMIT_CODE: i64 = -32045;
const NOT_INITIALIZED: i64 = -32002;
const TURN_ALREADY_RUNNING: i64 = -32003;
const MAX_GIT_OUTPUT_BYTES: usize = 5 * 1024 * 1024;
const MAX_TURN_FILE_CHANGES_BYTES: usize = 20 * 1024 * 1024;
const MAX_TURN_FILE_CHANGES_REVIEW_BYTES: usize = 1_800_000;
const MAX_DEVICE_RESULT_BYTES: usize = 1_800_000;
const MAX_TRANSCRIPT_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_TRANSCRIPT_RESPONSE_BYTES: usize = 1_500_000;
const MAX_THREAD_METADATA_BYTES: u64 = 64 * 1024;
const THREAD_METADATA_FILE: &str = "thread-metadata.json";
const THREAD_LIFECYCLE_LOCK_DIRECTORY: &str = ".thread-lifecycle-locks";
const DEFAULT_APPROVAL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const BACKGROUND_PUMP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const ACTIVE_TURN_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(debug_assertions)]
const E2E_APPROVAL_TIMEOUT_ENV: &str = "KCODER_E2E_APPROVAL_TIMEOUT_MS";

#[derive(Debug)]
struct GitTreeSnapshot {
    tree: String,
    backend: GitSnapshotBackend,
    // The isolated-before snapshot owns cleanup, so object storage is released even if the event stream returns before finalize.
    _private_repository_cleanup: Option<RemovePrivateDirectoryOnDrop>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum GitSnapshotBackend {
    #[default]
    Workspace,
    Isolated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TurnFileChangeItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    old_path: Option<String>,
    path: String,
    change_type: String,
    additions: u64,
    deletions: u64,
    binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TurnFileChangesArtifact {
    version: u8,
    status: String,
    artifact_id: String,
    thread_id: String,
    turn_id: String,
    workspace_path: String,
    #[serde(default)]
    snapshot_backend: GitSnapshotBackend,
    before_tree: String,
    after_tree: String,
    patch_sha256: String,
    file_count: usize,
    additions: u64,
    deletions: u64,
    files: Vec<TurnFileChangeItem>,
    created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reverted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TurnOutcomeArtifact {
    version: u8,
    thread_id: String,
    turn_id: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_failure: Option<kcoder_types::ProviderFailureDetails>,
    completed_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    continuation_context_hash: Option<String>,
}

/// The attempt that already accepted a continuation of a failed turn (R054, R056).
///
/// A lost response or a repeated click must learn the accepted attempt instead of
/// starting a second one. The receipt is durable and carries the context digest it
/// was accepted against, so a changed recovery boundary refuses it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TurnContinuationArtifact {
    version: u8,
    thread_id: String,
    turn_id: String,
    context_hash: String,
    accepted_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry_operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TurnClientMessageArtifact {
    version: u8,
    thread_id: String,
    turn_id: String,
    client_message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApprovalDecisionArtifact {
    version: u8,
    artifact_id: String,
    thread_id: String,
    turn_id: String,
    approval_id: String,
    action: ApprovalAction,
    reason: String,
    decision: ApprovalDecision,
    resolution_reason: String,
    requested_at_ms: u64,
    resolved_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThreadClientMetadata {
    version: u8,
    #[serde(default)]
    revision: u64,
    thread_id: String,
    workspace: String,
    #[serde(default)]
    fields: BTreeMap<String, Option<String>>,
    updated_at: String,
}

#[derive(Debug)]
struct SessionLease {
    _file: std::fs::File,
    session_target: PathBuf,
}

enum PreparedThreadResume {
    Resident {
        thread_id: String,
    },
    Persisted {
        prepared: Box<kcoder_state::PreparedSessionResume>,
        lease: SessionLease,
        client_turn_count: usize,
        /// Overlay path of the thread's recorded settings template, if it still exists.
        settings_template: Option<PathBuf>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClientWorktreeSettings {
    worktree_root: String,
    resolved_worktree_root: String,
    auto_cleanup_enabled: bool,
    keep_count: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClientManagedWorktree {
    worktree_id: String,
    path: String,
    repository_name: String,
    source_path: Option<String>,
    permanent: bool,
    revision: u64,
    base_commit: Option<String>,
    lease_key: String,
    created_at: u64,
    updated_at: u64,
    snapshot_ref: Option<String>,
    snapshot_commit: Option<String>,
    snapshot_at: Option<u64>,
    git_common_dir: Option<String>,
    archived_conversations: Vec<ClientWorktreeConversation>,
    state: String,
    last_error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClientWorktreeConversation {
    device_id: String,
    task_id: String,
    thread_id: String,
    workspace_path: String,
    title: String,
    model: Option<String>,
    created_at: u64,
    updated_at: u64,
}

struct ClientWorktreeSnapshot {
    reference: String,
    commit: String,
    git_common_dir: String,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientWorktreeArchivePreview {
    path: String,
    state: String,
    revision: u64,
    content_token: Option<String>,
    dirty: bool,
    untracked_file_count: usize,
    ignored_entry_count: usize,
    dirty_submodule_count: usize,
    nested_repository_count: usize,
    baseline_known: bool,
    commits_since_creation: Option<u64>,
    requires_confirmation: bool,
    archive_allowed: bool,
    blocking_reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClientWorktreeState {
    version: u64,
    settings: ClientWorktreeSettings,
    records: BTreeMap<String, ClientManagedWorktree>,
}

struct ClientWorktreeStore {
    state_path: PathBuf,
    lock_path: PathBuf,
    default_root: PathBuf,
}

/// The app-server holds a shared workspace lease for its full lifetime. Worktree
/// archival must first obtain an exclusive lease on the same path so one process
/// cannot delete a working directory still used by another client.
pub(crate) struct WorkspaceRuntimeLease {
    _file: std::fs::File,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClientWorkspaceRecord {
    workspace_path: String,
    label: String,
    project_key: String,
    roots: Vec<String>,
    pinned: bool,
    pinned_order: Option<usize>,
    appearance: Value,
    active: bool,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClientWorkspaceState {
    version: u64,
    root_project_pinned: Option<bool>,
    project_order: Vec<String>,
    records: BTreeMap<String, ClientWorkspaceRecord>,
    pinned_tasks: Vec<String>,
    task_orders: BTreeMap<String, Vec<String>>,
}

struct ClientWorkspaceStore {
    state_path: PathBuf,
    lock_path: PathBuf,
}

#[derive(Debug, Default)]
struct ConnectionState {
    knowledge_tasks: tokio::task::JoinSet<()>,
    knowledge_rpc_tasks: tokio::task::JoinSet<()>,
    initialized: bool,
    tool_profiles_v1: bool,
    tool_path_preview_v1: bool,
    /// Set when the client negotiated `threadRunSummaryV1`; only then may thread
    /// snapshots carry the richer run status and `runSummary` payload.
    run_summary_v1: bool,
    /// Set when the client negotiated `interactionBindingV1`; replies must then
    /// name the interaction they answer.
    interaction_binding_v1: bool,
}

struct ActiveTurn {
    handle: tokio::task::JoinHandle<()>,
    cancel: CancellationToken,
    thread_id: String,
    turn_id: String,
}

#[derive(Clone)]
struct BackgroundTurnProjection {
    thread_id: String,
    turn_id: String,
    projection: Arc<Mutex<StreamProjection>>,
}

#[derive(Default)]
struct BackgroundProjectionState {
    active: Option<BackgroundTurnProjection>,
    jobs: HashMap<String, BackgroundTurnProjection>,
    tool_calls: HashMap<String, BackgroundTurnProjection>,
    job_tools: HashMap<String, String>,
    pending: HashMap<String, Vec<EngineEvent>>,
    associated_jobs: HashSet<String>,
    terminal_jobs: HashSet<String>,
    current_runs: HashMap<String, String>,
    last_contexts: HashMap<String, BackgroundTurnProjection>,
    forwarded_events: HashSet<String>,
    forwarded_order: std::collections::VecDeque<String>,
    steer_response_gates: HashMap<String, AgentSteerResponseGate>,
    steer_correlations: HashMap<String, AgentSteerCorrelation>,
}

#[derive(Default)]
struct AgentSteerResponseGate {
    client_message_id: Option<String>,
    deferred_applied: Vec<(Option<BackgroundTurnProjection>, EngineEvent)>,
}

struct AgentSteerCorrelation {
    agent_id: String,
    client_message_id: Option<String>,
}

struct BackgroundEventPump {
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

struct BackgroundFollowupScheduler {
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct BackgroundFollowupState {
    client_turn_count: thread_runtime::ClientTurnCounter,
    queue: Mutex<BackgroundFollowupQueue>,
    notify: tokio::sync::Notify,
    goals: StdMutex<goal_lifecycle::GoalLifecycle>,
}

#[derive(Default)]
struct BackgroundFollowupQueue {
    pending: BTreeMap<String, String>,
    /// `(agent id, run_started_at_ms)`. A respawned agent (`SendMessage`)
    /// starts a fresh run and must be able to wake the thread again. The
    /// field type mirrors `Task::run_started_at_ms` (`Option<u64>`,
    /// `kcoder_state/src/model.rs:180`) so call sites pass it through
    /// without conversion.
    claimed_terminal_ids: HashSet<(String, Option<u64>)>,
}

#[derive(Clone)]
struct QuestionContext {
    server_id: String,
    thread_id: String,
    turn_id: String,
}

type PendingQuestionResponses =
    Arc<StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<QuestionResponse, String>>>>>;

type PendingApprovalResponses =
    Arc<StdMutex<HashMap<u64, oneshot::Sender<std::result::Result<ApprovalResponse, String>>>>>;

#[derive(Clone)]
struct ApprovalContext {
    server_id: String,
    thread_id: String,
    turn_id: String,
}

/// Foreground execution and interaction state for one resident thread.
///
/// These fields must remain one ownership unit with the thread runtime. Sharing
/// them at workspace scope would make turns on different threads reject each other
/// or route questions, approvals, and interrupts to the wrong turn.
#[derive(Clone)]
struct ResidentTurnState {
    /// Terminal answers and outstanding interactions of the owning connection.
    interaction_receipts: Arc<StdMutex<InteractionReceipts>>,
    accepting_turns: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    activity_gate: Arc<Mutex<()>>,
    active_turn: Arc<Mutex<Option<ActiveTurn>>>,
    question_context: Arc<StdMutex<Option<QuestionContext>>>,
    pending_questions: PendingQuestionResponses,
    approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
    pending_approvals: PendingApprovalResponses,
    permission_prompt: AppServerPermissionPrompt,
    user_questioner: Arc<dyn UserQuestioner>,
}

#[derive(Clone)]
struct AppServerPermissionPrompt {
    mode: kcoder_config::PermissionMode,
    outbound_tx: mpsc::Sender<Value>,
    pending: PendingApprovalResponses,
    receipts: Arc<StdMutex<InteractionReceipts>>,
    next_id: Arc<AtomicU64>,
    context: Arc<StdMutex<Option<ApprovalContext>>>,
    artifact_dir: Arc<StdMutex<Option<PathBuf>>>,
    response_timeout: Duration,
}

/// Outcome of a reply frame (S5/R046).
enum InteractionReply {
    /// Delivered to the waiting tool.
    Delivered,
    /// A pending interaction matched, but the reply did not name it correctly.
    Misattributed,
    /// Nothing pending and nothing recorded for this transport id.
    Unmatched,
}

/// Identity fields a reply must echo, borrowed from the parsed reply.
#[derive(Clone, Copy)]
struct ReplyBinding<'a> {
    interaction_id: Option<&'a str>,
    thread_id: Option<&'a str>,
    turn_id: Option<&'a str>,
}

/// Upper bound of remembered interaction resolutions per connection.
const INTERACTION_RECEIPT_LIMIT: usize = 1024;

/// Identity of one interaction the connection is waiting on.
#[derive(Clone, PartialEq, Eq, Debug)]
struct InteractionBinding {
    /// Server-issued interaction id (`approval-…` / `question-…`).
    interaction_id: String,
    thread_id: String,
    turn_id: String,
}

struct OutstandingInteraction {
    binding: InteractionBinding,
    /// The exact request notification, replayed when a reply cannot be attributed.
    request: Value,
}

/// Bounded per-connection ledger of interaction resolutions (S5/R046).
///
/// Today a client only echoes the JSON-RPC transport id, so a repeated reply
/// must replay the terminal answer it may have missed. A reply that matches no
/// pending interaction is never treated as an accepted decision, and is counted
/// so the drop stays observable instead of silent.
#[derive(Default)]
struct InteractionReceipts {
    resolved: VecDeque<(u64, Value)>,
    outstanding: HashMap<u64, OutstandingInteraction>,
    duplicate_replies: u64,
    unmatched_replies: u64,
    misattributed_replies: u64,
}

#[derive(Clone)]
struct AppServerQuestioner {
    outbound_tx: mpsc::Sender<Value>,
    pending: PendingQuestionResponses,
    receipts: Arc<StdMutex<InteractionReceipts>>,
    next_id: Arc<AtomicU64>,
    context: Arc<StdMutex<Option<QuestionContext>>>,
}

struct StreamProjection {
    server_id: String,
    thread_id: String,
    turn_id: String,
    sequence: Arc<AtomicU64>,
    next_item: u64,
    item_namespace: String,
    assistant_item: Option<String>,
}

/// Output bound for snapshot path listings (they are NUL-separated paths).
const SNAPSHOT_PATH_LISTING_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug)]
struct RemovePrivateDirectoryOnDrop {
    path: PathBuf,
    _lease: std::fs::File,
}

#[derive(Debug)]
struct RemovePrivateFileOnDrop(PathBuf);

trait IntoNonEmpty {
    fn into_non_empty(self) -> Option<String>;
}

/// Capabilities-gated authoritative run projection for one thread snapshot.
///
/// The legacy `running`/`idle` status stays untouched for clients that did not
/// negotiate `threadRunSummaryV1`, and for threads whose runtime facts are not
/// observable from this connection (see `ThreadManager::thread_run_facts`).
#[derive(Clone, Copy)]
struct ThreadRunProjection {
    negotiated: bool,
    facts: Option<kcoder_app_protocol::ThreadRunFacts>,
}

#[derive(Default)]
struct PersistedThreadSnapshotReport {
    threads: Vec<Value>,
    issue_count: u64,
}

struct MergedHistoryScan {
    candidates: Vec<(String, PathBuf, std::time::SystemTime)>,
    issue_count: u64,
}

#[derive(Clone)]
#[cfg_attr(test, derive(serde::Serialize))]
struct TranscriptToolContext {
    entry_index: usize,
    last_reference_index: usize,
    name: String,
    input: Value,
    has_tool_use: bool,
    output_images: Vec<kcoder_app_protocol::ToolOutputImage>,
    images_omitted: bool,
    output: Option<String>,
    is_error: bool,
    started_at_ms: u64,
    completed_at_ms: Option<u64>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct TranscriptToolId(Arc<str>);

type TranscriptToolContexts = HashMap<TranscriptToolId, Vec<TranscriptToolContext>>;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod outbound_frame_limit_tests;

mod goal_requests_support;
use goal_requests_support::*;

mod interaction_requests;
use interaction_requests::*;

mod workspace_registry;

mod connection_state;
use connection_state::*;

mod notification_projection;
use notification_projection::*;

mod background_delivery;
use background_delivery::*;

mod background_scheduler;
use background_scheduler::*;

mod response_adapters;
use response_adapters::*;

mod worktree_artifacts;
use worktree_artifacts::*;

mod device_requests;
use device_requests::*;

mod workspace_requests;
use workspace_requests::*;

mod managed_worktrees;
use managed_worktrees::*;

mod runtime_configuration;
use runtime_configuration::*;

mod thread_requests_support;
use thread_requests_support::*;

mod thread_metadata;
use thread_metadata::*;

mod transcript_projection;
mod transcript_tool_recovery;
use transcript_projection::*;

mod turn_artifacts;
use turn_artifacts::*;

mod server_requests;

mod agent_requests;

mod settings_requests;

mod runtime_requests;

mod attachment_requests;

mod resource_requests;

mod session_requests;

mod thread_creation_requests;

mod thread_read_requests;

mod thread_restore_requests;

mod thread_rewind_requests;

mod goal_requests;

mod thread_delete_requests;

mod turn_requests;

mod connection_lifecycle;
pub use connection_lifecycle::run;

pub(crate) use workspace_registry::acquire_app_server_workspace_runtime_lease;

mod rpc_dispatch;

/// A handler may request the connection loop to enter its existing shutdown path.
enum DispatchControl {
    Continue,
    Shutdown,
}
