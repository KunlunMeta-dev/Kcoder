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
mod config_templates;
mod cron_processor;
mod engine_factory;
mod failed_turn;
mod recent_error;
mod git;
mod goal_lifecycle;
mod history_catalog;
mod history_refresh_processor;
mod hook_configuration;
mod indexed_read_gate;
mod indexed_transcript;
mod mcp_authorization_processor;
mod mcp_configuration;
mod mcp_processor;
mod plugin_processor;
mod private_files;
mod project_automations;
mod protocol_io;
mod provider_probe;
mod provider_settings;
mod resources_processor;
mod session_configuration;
mod skill_processor;
mod storage_diagnostics;
mod storage_scans;
mod snapshot_leases;
mod terminal;
mod thread_list_snapshots;
mod thread_runtime;
mod tools_catalog;
mod tracked_history_list;
mod transcript_artifact_journal;
#[cfg(test)]
mod transcript_context_oracle;
mod transcript_window;
mod turn_admissions;
mod turn_attempts;
mod turn_execution;
mod thread_creations;
mod turn_receipts;
mod workflow_canvas;
mod turn_file_changes_settings;
mod usage_processor;
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

fn goal_pro_verifier_selection(engine: &QueryEngine) -> GoalVerifierSelection {
    let goal_pro = engine.settings.read().unwrap().goal_pro.clone();
    GoalVerifierSelection {
        profile: non_empty_setting(goal_pro.verifier_profile),
        provider: non_empty_setting(goal_pro.verifier_provider),
        model: non_empty_setting(goal_pro.verifier_model),
        verifier_panel: kcoder_config::normalize_goal_pro_verifier_panel(goal_pro.verifier_models),
        verifier_max_turns: goal_pro.verifier_max_turns.max(1),
        completion_rejection_limit: Some(goal_pro.completion_rejection_limit.max(1)),
        verification: goal_pro.verification,
    }
}

fn non_empty_setting(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

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

fn approval_response_timeout() -> Duration {
    #[cfg(debug_assertions)]
    {
        let configured = std::env::var(E2E_APPROVAL_TIMEOUT_ENV).ok();
        if let Some(timeout) = parse_e2e_approval_timeout(configured.as_deref()) {
            return timeout;
        }
        if configured.is_some() {
            tracing::warn!(
                variable = E2E_APPROVAL_TIMEOUT_ENV,
                "ignoring invalid E2E approval timeout and using the production default"
            );
        }
    }
    DEFAULT_APPROVAL_RESPONSE_TIMEOUT
}

#[cfg(any(debug_assertions, test))]
fn parse_e2e_approval_timeout(raw: Option<&str>) -> Option<Duration> {
    let milliseconds = raw?.parse::<u64>().ok()?;
    (10..=30_000)
        .contains(&milliseconds)
        .then(|| Duration::from_millis(milliseconds))
}

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

impl Default for ClientWorktreeSettings {
    fn default() -> Self {
        Self {
            worktree_root: String::new(),
            resolved_worktree_root: String::new(),
            auto_cleanup_enabled: true,
            keep_count: 15,
        }
    }
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

impl ClientWorktreeStore {
    fn new(engine: &QueryEngine) -> Self {
        let base = engine
            .client_storage_root()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| engine.client_storage_root());
        Self {
            state_path: base.join("managed-worktrees.json"),
            lock_path: base.join("managed-worktrees.lock"),
            default_root: base.join("managed-worktrees"),
        }
    }

    fn lock(&self) -> Result<std::fs::File> {
        if let Some(parent) = self.lock_path.parent() {
            std::fs::create_dir_all(parent).context("failed to create worktree state directory")?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options
            .open(&self.lock_path)
            .context("failed to open worktree state lock file")?;
        if !file
            .metadata()
            .context("failed to inspect worktree state lock file")?
            .is_file()
        {
            anyhow::bail!("worktree state lock is not a regular file")
        }
        file.try_lock_exclusive()
            .context("worktree state is busy in another app-server")?;
        Ok(file)
    }

    fn load(&self) -> Result<ClientWorktreeState> {
        match std::fs::symlink_metadata(&self.state_path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                anyhow::bail!("managed worktree registry is not a regular file")
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("failed to inspect managed worktree registry"),
        }
        let mut state: ClientWorktreeState = match std::fs::read(&self.state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| {
                format!(
                    "managed worktree registry is invalid: {}",
                    self.state_path.display()
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to read managed worktree registry {}",
                        self.state_path.display()
                    )
                });
            }
        };
        if state.version > 2 {
            anyhow::bail!(
                "managed worktree registry version {} is newer than supported version 2",
                state.version
            )
        }
        state.version = 2;
        if state.settings.resolved_worktree_root.is_empty() {
            state.settings.resolved_worktree_root =
                self.default_root.to_string_lossy().into_owned();
        }
        self.validate_state(&mut state)?;
        Ok(state)
    }

    fn validate_state(&self, state: &mut ClientWorktreeState) -> Result<()> {
        let root = Path::new(&state.settings.resolved_worktree_root);
        if !safe_absolute_path(root) {
            anyhow::bail!("managed worktree registry has an unsafe root")
        }
        for (key, record) in &mut state.records {
            if key != &record.path {
                anyhow::bail!("managed worktree registry key does not match its path")
            }
            let path = Path::new(&record.path);
            if !safe_absolute_path(path) || !path.starts_with(root) || path == root {
                anyhow::bail!("managed worktree registry contains a path outside its managed root")
            }
            validate_worktree_id(&record.worktree_id)
                .context("managed worktree registry contains an invalid worktree id")?;
            let expected_lease_key = hex_sha256(record.path.as_bytes());
            if record.lease_key.is_empty() {
                record.lease_key = expected_lease_key.clone();
            } else if record.lease_key != expected_lease_key {
                anyhow::bail!("managed worktree registry contains an invalid lease key")
            }
            let expected_snapshot_ref = format!(
                "refs/kcoder/worktree-snapshots/{}",
                hex_sha256(record.path.as_bytes())
            );
            if record
                .snapshot_ref
                .as_deref()
                .is_some_and(|reference| reference != expected_snapshot_ref)
            {
                anyhow::bail!("managed worktree registry contains an invalid snapshot ref")
            }
            if record
                .snapshot_commit
                .as_deref()
                .is_some_and(|commit| !valid_git_object_id(commit))
                || record
                    .base_commit
                    .as_deref()
                    .is_some_and(|commit| !valid_git_object_id(commit))
            {
                anyhow::bail!("managed worktree registry contains an invalid Git object id")
            }
            if record
                .source_path
                .as_deref()
                .is_some_and(|source| !safe_absolute_path(Path::new(source)))
                || record
                    .git_common_dir
                    .as_deref()
                    .is_some_and(|common| !safe_absolute_path(Path::new(common)))
            {
                anyhow::bail!("managed worktree registry contains an unsafe repository path")
            }
            if !matches!(
                record.state.as_str(),
                "active" | "snapshot_ready" | "restorable" | "restoring" | "missing" | "deleted"
            ) {
                anyhow::bail!("managed worktree registry contains an invalid lifecycle state")
            }
            if matches!(
                record.state.as_str(),
                "snapshot_ready" | "restorable" | "restoring"
            ) && (record.snapshot_ref.is_none()
                || record.snapshot_commit.is_none()
                || record.git_common_dir.is_none()
                || record.source_path.is_none())
            {
                anyhow::bail!("managed worktree registry contains an incomplete snapshot state")
            }
            if record
                .archived_conversations
                .iter()
                .any(|conversation| conversation.workspace_path != record.path)
            {
                anyhow::bail!("managed worktree registry contains a mismatched conversation")
            }
        }
        Ok(())
    }

    fn save(&self, state: &ClientWorktreeState) -> Result<()> {
        (|| -> Result<()> {
            let parent = self
                .state_path
                .parent()
                .context("worktree state directory is missing")?;
            std::fs::create_dir_all(parent).context("failed to create worktree state directory")?;
            // Use an exclusive temporary file and clean it up if replacement fails.
            let mut temporary = tempfile::Builder::new()
                .prefix("managed-worktrees-")
                .suffix(".tmp")
                .tempfile_in(parent)
                .context("failed to create temporary worktree state file")?;
            temporary
                .write_all(&serde_json::to_vec_pretty(state)?)
                .context("failed to write worktree state file")?;
            temporary
                .as_file()
                .sync_all()
                .context("failed to flush worktree state file")?;
            let persisted = temporary
                .persist(&self.state_path)
                .map_err(|error| error.error)
                .context("failed to replace worktree state file")?;
            drop(persisted);
            // Windows cannot open directories as ordinary files or fsync them.
            // Keep the directory durability barrier on Unix without changing ACLs.
            #[cfg(unix)]
            std::fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .context("failed to flush worktree state directory")?;
            Ok(())
        })()
        .context("failed to save worktree state")
    }

    fn workspace_runtime_lease_path(&self, workspace: &Path) -> Result<PathBuf> {
        let canonical = std::fs::canonicalize(workspace).with_context(|| {
            format!(
                "failed to resolve workspace runtime lease path {}",
                workspace.display()
            )
        })?;
        self.workspace_runtime_lease_path_for_key(&hex_sha256(
            canonical.to_string_lossy().as_bytes(),
        ))
    }

    fn workspace_runtime_lease_path_for_key(&self, lease_key: &str) -> Result<PathBuf> {
        if lease_key.len() != 64 || !lease_key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            anyhow::bail!("managed worktree lease key is invalid")
        }
        Ok(kcoder_config::Settings::config_dir()?
            .join("workspace-runtime-leases")
            .join(format!("{lease_key}.lock")))
    }

    fn open_workspace_runtime_lease(&self, workspace: &Path) -> Result<std::fs::File> {
        let path = self.workspace_runtime_lease_path(workspace)?;
        std::fs::create_dir_all(
            path.parent()
                .context("workspace lease directory is missing")?,
        )?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&path)?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("workspace runtime lease is not a regular file")
        }
        Ok(file)
    }

    fn acquire_workspace_archive_lease(&self, workspace: &Path) -> Result<std::fs::File> {
        let file = self.open_workspace_runtime_lease(workspace)?;
        FileExt::try_lock_exclusive(&file).with_context(|| {
            format!(
                "workspace is active in another app-server: {}",
                workspace.display()
            )
        })?;
        Ok(file)
    }

    fn acquire_workspace_archive_lease_by_key(&self, lease_key: &str) -> Result<std::fs::File> {
        let path = self.workspace_runtime_lease_path_for_key(lease_key)?;
        std::fs::create_dir_all(
            path.parent()
                .context("workspace lease directory is missing")?,
        )?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&path)?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("workspace runtime lease is not a regular file")
        }
        FileExt::try_lock_exclusive(&file).context("workspace is active in another app-server")?;
        Ok(file)
    }
}

fn safe_absolute_path(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().is_some()
        && !path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
}

fn valid_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) fn acquire_app_server_workspace_runtime_lease(
    workspace: &Path,
) -> Result<WorkspaceRuntimeLease> {
    let canonical = std::fs::canonicalize(workspace).with_context(|| {
        format!(
            "failed to resolve app-server workspace {}",
            workspace.display()
        )
    })?;
    let directory = kcoder_config::Settings::config_dir()?.join("workspace-runtime-leases");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!(
        "{}.lock",
        hex_sha256(canonical.to_string_lossy().as_bytes())
    ));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(&path)?;
    if !file.metadata()?.is_file() {
        anyhow::bail!("workspace runtime lease is not a regular file")
    }
    FileExt::try_lock_shared(&file)
        .with_context(|| format!("workspace is being archived: {}", workspace.display()))?;
    Ok(WorkspaceRuntimeLease { _file: file })
}

impl ClientWorkspaceStore {
    fn new(engine: &QueryEngine) -> Self {
        let base = engine
            .client_storage_root()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| engine.client_storage_root());
        Self {
            state_path: base.join("client-workspaces.json"),
            lock_path: base.join("client-workspaces.lock"),
        }
    }

    fn lock(&self) -> Result<std::fs::File> {
        if let Some(parent) = self.lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options.open(&self.lock_path)?;
        if !file.metadata()?.is_file() {
            anyhow::bail!("workspace state lock is not a regular file")
        }
        // Brief cross-process writes (or a fork before exec closes inherited handles)
        // must not turn an ordinary sidebar update into a spurious failure.
        let deadline = std::time::Instant::now() + Duration::from_millis(100);
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => break,
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(error) => {
                    return Err(error).context("workspace state is busy in another app-server");
                }
            }
        }
        Ok(file)
    }

    fn load(&self) -> ClientWorkspaceState {
        let mut state: ClientWorkspaceState = std::fs::read(&self.state_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        state.version = 1;
        state
    }

    fn save(&self, state: &ClientWorkspaceState) -> Result<()> {
        let parent = self
            .state_path
            .parent()
            .context("workspace state directory is missing")?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!("client-workspaces-{}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(state)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &self.state_path)?;
        Ok(())
    }
}

impl Drop for SessionLease {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self._file);
    }
}

impl SessionLease {
    fn acquire(session_target: &Path) -> Result<Self> {
        Self::open(session_target, true)
    }

    fn open(session_target: &Path, create: bool) -> Result<Self> {
        let lease_path = session_target.with_extension("lease");
        if create && let Some(parent) = lease_path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create session lease directory {}",
                    parent.display()
                )
            })?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(create).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = options
            .open(&lease_path)
            .with_context(|| format!("failed to open session lease {}", lease_path.display()))?;
        if !file.metadata()?.is_file() {
            anyhow::bail!(
                "session lease is not a regular file: {}",
                lease_path.display()
            )
        }
        file.try_lock_exclusive().with_context(|| {
            format!(
                "session is already active in another app-server: {}",
                session_target.display()
            )
        })?;
        Ok(Self {
            _file: file,
            session_target: session_target.to_path_buf(),
        })
    }

    fn matches_engine(&self, engine: &QueryEngine) -> bool {
        engine.session_lease_target() == self.session_target
    }

    fn acquire_existing_history(history_path: &Path) -> Result<Self> {
        let lease_path = history_path.with_extension("lease");
        match std::fs::symlink_metadata(&lease_path) {
            Ok(_) => return Self::open(history_path, false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect session lease {}", lease_path.display())
                });
            }
        }
        let metadata = std::fs::symlink_metadata(history_path)
            .with_context(|| format!("persisted thread not found: {}", history_path.display()))?;
        if !metadata.file_type().is_file() {
            anyhow::bail!(
                "persisted thread is not a regular file: {}",
                history_path.display()
            )
        }
        Self::acquire(history_path)
    }
}

#[derive(Debug, Default)]
struct ConnectionState {
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

impl BackgroundFollowupQueue {
    /// Insert a wake-up claim for one terminal run. Returns false when this
    /// exact run was already claimed.
    fn claim_run(&mut self, id: &str, run_started_at_ms: Option<u64>) -> bool {
        self.claimed_terminal_ids
            .insert((id.to_string(), run_started_at_ms))
    }
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

impl ResidentTurnState {
    fn new(
        outbound_tx: mpsc::Sender<Value>,
        permission_mode: kcoder_config::PermissionMode,
        next_question_id: Arc<AtomicU64>,
        next_approval_id: Arc<AtomicU64>,
        receipts: Arc<StdMutex<InteractionReceipts>>,
    ) -> Self {
        let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
        let question_context = Arc::new(StdMutex::new(None));
        let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
        let approval_context = Arc::new(StdMutex::new(None));
        let approval_artifact_dir = Arc::new(StdMutex::new(None));
        let permission_prompt = AppServerPermissionPrompt {
            mode: permission_mode,
            outbound_tx: outbound_tx.clone(),
            pending: Arc::clone(&pending_approvals),
            receipts: Arc::clone(&receipts),
            next_id: next_approval_id,
            context: Arc::clone(&approval_context),
            artifact_dir: approval_artifact_dir,
            response_timeout: approval_response_timeout(),
        };
        let user_questioner: Arc<dyn UserQuestioner> = Arc::new(AppServerQuestioner {
            outbound_tx,
            pending: Arc::clone(&pending_questions),
            receipts: Arc::clone(&receipts),
            next_id: next_question_id,
            context: Arc::clone(&question_context),
        });
        Self {
            interaction_receipts: receipts,
            accepting_turns: Arc::new(AtomicBool::new(true)),
            running: Arc::new(AtomicBool::new(false)),
            activity_gate: Arc::new(Mutex::new(())),
            active_turn: Arc::new(Mutex::new(None)),
            question_context,
            pending_questions,
            approval_context,
            pending_approvals,
            permission_prompt,
            user_questioner,
        }
    }

    fn configure_for_engine(&mut self, engine: &QueryEngine) {
        // New sessions use the freshly loaded policy, not the bootstrap connection mode.
        self.permission_prompt.mode = engine
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .permission_mode;
        *self
            .permission_prompt
            .artifact_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(
            engine
                .session_storage_dir_for(&engine.session_id())
                .join("approval-decisions"),
        );
    }

    fn resolve_response(&self, response: &Value, require_binding: bool) -> InteractionReply {
        resolve_server_response(
            response,
            &self.pending_approvals,
            &self.pending_questions,
            &self.interaction_receipts,
            require_binding,
        )
    }

    fn clear_pending(&self) {
        self.pending_approvals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.pending_questions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Must be called under `activity_gate`. A second closed-state check covers the
    /// interleaving window between shutdown and scheduler CAS, preventing a turn from
    /// starting after its runtime has been removed.
    fn try_claim_turn(&self) -> bool {
        if !self.accepting_turns.load(Ordering::SeqCst)
            || self
                .running
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return false;
        }
        if self.accepting_turns.load(Ordering::SeqCst) {
            true
        } else {
            self.running.store(false, Ordering::SeqCst);
            false
        }
    }

    /// Claim an idle runtime and retain the activity gate until the caller publishes the active handle.
    ///
    /// A very fast turn may finish immediately after `tokio::spawn` returns and reset
    /// `running`. Releasing the gate before publishing its handle would let the
    /// background scheduler register a new turn in that window, only to have its handle
    /// overwritten by the old one. Returning an owned guard makes claim-to-publish one critical section.
    async fn claim_turn_registration(&self) -> Option<tokio::sync::OwnedMutexGuard<()>> {
        let guard = Arc::clone(&self.activity_gate).lock_owned().await;
        self.try_claim_turn().then_some(guard)
    }

    fn stop_accepting_turns(&self) {
        self.accepting_turns.store(false, Ordering::SeqCst);
    }

    fn resume_accepting_turns(&self) {
        self.accepting_turns.store(true, Ordering::SeqCst);
    }

    fn clear_matching_turn(&self, thread_id: &str, turn_id: &str) {
        let clear_questions = {
            let mut context = self
                .question_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let matches = context.as_ref().is_some_and(|context| {
                context.thread_id == thread_id && context.turn_id == turn_id
            });
            if matches {
                *context = None;
            }
            matches
        };
        if clear_questions {
            self.pending_questions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
        let clear_approvals = {
            let mut context = self
                .approval_context
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let matches = context.as_ref().is_some_and(|context| {
                context.thread_id == thread_id && context.turn_id == turn_id
            });
            if matches {
                *context = None;
            }
            matches
        };
        if clear_approvals {
            self.pending_approvals
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clear();
        }
    }

    fn clear_all_turn_state(&self) {
        self.clear_pending();
        *self
            .question_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .approval_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.running.store(false, Ordering::SeqCst);
    }
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

#[async_trait]
impl PermissionPrompt for AppServerPermissionPrompt {
    async fn ask(&self, tool_name: &str, description: String, input: &Value) -> PermissionResponse {
        self.ask_context(&PermissionRequestContext {
            tool_name: tool_name.to_string(),
            description,
            input: input.clone(),
            risk: kcoder_permissions::PermissionRisk::None,
            detail_lines: Vec::new(),
        })
        .await
    }

    async fn ask_context(&self, request: &PermissionRequestContext) -> PermissionResponse {
        if self.mode != kcoder_config::PermissionMode::Ask {
            return HeadlessPermissionPrompt { mode: self.mode }
                .ask_context(request)
                .await;
        }

        let Some(context) = self
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            tracing::warn!(tool = %request.tool_name, "app-server permission requested outside an active turn");
            return PermissionResponse::DenyOnce;
        };
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let approval_id = format!("approval-{request_id}");
        let params = ApprovalRequestParams {
            server_id: context.server_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            approval_id,
            action: approval_action_for(request),
            reason: request.description.clone(),
        };
        let requested_at_ms = unix_timestamp_ms();
        let resolved_approval_id = params.approval_id.clone();
        let resolved_thread_id = params.thread_id.clone();
        let resolved_turn_id = params.turn_id.clone();
        let (response_tx, response_rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id, response_tx);
        let request_frame = json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": method::APPROVAL_REQUEST,
            "params": params,
        });
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .track_request(
                request_id,
                InteractionBinding {
                    interaction_id: params.approval_id.clone(),
                    thread_id: params.thread_id.clone(),
                    turn_id: params.turn_id.clone(),
                },
                request_frame.clone(),
            );
        if self.outbound_tx.send(request_frame).await.is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            self.receipts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .forget_request(request_id);
            tracing::warn!(tool = %request.tool_name, "app-server connection closed while requesting approval");
            return PermissionResponse::DenyOnce;
        }

        let response = tokio::time::timeout(self.response_timeout, response_rx).await;
        // `resolve_server_response` normally removes the response path first. Perform
        // idempotent cleanup here on timeout or sender failure so long-lived connections
        // do not accumulate stale approvals.
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&request_id);
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .forget_request(request_id);
        let (permission, decision, reason) = match response {
            Err(_) => {
                tracing::warn!(tool = %request.tool_name, "app-server approval request timed out");
                (
                    PermissionResponse::DenyOnce,
                    ApprovalDecision::Decline,
                    "timeout",
                )
            }
            Ok(Ok(Ok(response))) => {
                let permission = match &response.decision {
                    ApprovalDecision::Accept => PermissionResponse::AllowOnce,
                    ApprovalDecision::AcceptForSession => PermissionResponse::AllowForSession,
                    ApprovalDecision::Decline | ApprovalDecision::Cancel => {
                        PermissionResponse::DenyOnce
                    }
                };
                (permission, response.decision, "client_response")
            }
            Ok(Ok(Err(error))) => {
                tracing::warn!(tool = %request.tool_name, %error, "app-server approval request failed");
                (
                    PermissionResponse::DenyOnce,
                    ApprovalDecision::Cancel,
                    "response_error",
                )
            }
            Ok(Err(_)) => {
                tracing::warn!(tool = %request.tool_name, "app-server approval request was cancelled");
                (
                    PermissionResponse::DenyOnce,
                    ApprovalDecision::Cancel,
                    "cancelled",
                )
            }
        };
        if let Err(error) = self.persist_decision(ApprovalDecisionArtifact {
            version: 1,
            artifact_id: hex_sha256(
                format!(
                    "{}\0{}\0{}\0{}",
                    params.thread_id, params.turn_id, params.approval_id, requested_at_ms
                )
                .as_bytes(),
            ),
            thread_id: params.thread_id.clone(),
            turn_id: params.turn_id.clone(),
            approval_id: params.approval_id.clone(),
            action: params.action.clone(),
            reason: params.reason.clone(),
            decision: decision.clone(),
            resolution_reason: reason.into(),
            requested_at_ms,
            resolved_at_ms: unix_timestamp_ms(),
        }) {
            tracing::warn!(%error, approval_id = %params.approval_id, "failed to persist app-server approval decision");
        }
        let resolved = notification(
            method::APPROVAL_RESOLVED,
            serde_json::to_value(ApprovalResolvedParams {
                request_id,
                approval_id: resolved_approval_id,
                thread_id: resolved_thread_id,
                turn_id: resolved_turn_id,
                decision,
                reason: reason.into(),
            })
            .expect("approval resolution serializes"),
        );
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(request_id, resolved.clone());
        let _ = self.outbound_tx.send(resolved).await;
        permission
    }
}

impl AppServerPermissionPrompt {
    fn persist_decision(&self, artifact: ApprovalDecisionArtifact) -> Result<()> {
        let Some(artifact_dir) = self
            .artifact_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        else {
            return Ok(());
        };
        transcript_artifact_journal::write(
            &artifact_dir,
            &artifact.thread_id,
            transcript_artifact_journal::Kind::ApprovalDecisions,
            || {
                write_private_artifact_file(
                    &artifact_dir.join(format!("{}.json", artifact.artifact_id)),
                    &serde_json::to_vec_pretty(&artifact)?,
                )
            },
        )
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn approval_action_for(request: &PermissionRequestContext) -> ApprovalAction {
    let normalized = request.tool_name.to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "bash" | "bashtool" | "powershell" | "powershelltool" | "repl" | "repltool"
    ) && let Some(command) = request.input.get("command").and_then(Value::as_str)
    {
        return ApprovalAction::Command {
            command: command.to_string(),
        };
    }
    if matches!(
        normalized.as_str(),
        "write" | "filewritetool" | "edit" | "fileedittool"
    ) && let Some(path) = request
        .input
        .get("file_path")
        .or_else(|| request.input.get("path"))
        .and_then(Value::as_str)
    {
        return ApprovalAction::FileChange {
            path: path.to_string(),
        };
    }
    // apply_patch carries no `file_path`/`path` key; classify single-file
    // patches as FileChange and let multi-file patches fall through to the
    // generic Tool action (its input carries the full patch text).
    if matches!(normalized.as_str(), "apply_patch" | "applypatchtool")
        && let Some(patch) = request.input.get("patch").and_then(Value::as_str)
    {
        let paths = kcoder_tools::apply_patch::patch_affected_paths(patch);
        if paths.len() == 1 {
            return ApprovalAction::FileChange {
                path: paths[0].clone(),
            };
        }
    }
    ApprovalAction::Tool {
        name: request.tool_name.clone(),
        input: request.input.clone(),
    }
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

fn resolve_server_response(
    response: &Value,
    pending_approvals: &PendingApprovalResponses,
    pending_questions: &PendingQuestionResponses,
    receipts: &Arc<StdMutex<InteractionReceipts>>,
    require_binding: bool,
) -> InteractionReply {
    let Some(request_id) = response.get("id").and_then(Value::as_u64) else {
        return InteractionReply::Unmatched;
    };
    // A connection that negotiated `interactionBindingV1` must name the
    // interaction, so a transport id issued by an earlier connection generation
    // can never be applied to a new turn. An error frame carries no decision and
    // can only fail the interaction, so it stays accepted without a binding.
    let expected = receipts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .expected_binding(request_id)
        .cloned();
    let error_frame = response.get("error").is_some();
    let verify = |reply: ReplyBinding| match (&expected, require_binding, error_frame) {
        (Some(expected), true, false) => reply.matches(expected),
        _ => true,
    };

    if pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&request_id)
    {
        let parsed = if let Some(error) = response.get("error") {
            Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("approval request failed")
                .to_string())
        } else {
            match serde_json::from_value::<ApprovalResponse>(
                response.get("result").cloned().unwrap_or(Value::Null),
            ) {
                Ok(reply) => {
                    if !verify(ReplyBinding::from(&reply)) {
                        return InteractionReply::Misattributed;
                    }
                    Ok(reply)
                }
                Err(error) => return InteractionReply::Unmatched.tap_invalid(&error),
            }
        };
        return deliver_approval_response(pending_approvals, request_id, parsed);
    }

    if pending_questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains_key(&request_id)
    {
        let parsed = if let Some(error) = response.get("error") {
            Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("question request failed")
                .to_string())
        } else {
            match serde_json::from_value::<QuestionResponse>(
                response.get("result").cloned().unwrap_or(Value::Null),
            ) {
                Ok(reply) => {
                    if !verify(ReplyBinding::from(&reply)) {
                        return InteractionReply::Misattributed;
                    }
                    Ok(reply)
                }
                Err(error) => return InteractionReply::Unmatched.tap_invalid(&error),
            }
        };
        return deliver_question_response(pending_questions, request_id, parsed);
    }

    InteractionReply::Unmatched
}

impl InteractionReply {
    /// An unparseable result frame is not an answer; keep it observable.
    fn tap_invalid(self, error: &impl std::fmt::Display) -> Self {
        tracing::warn!(%error, "app-server interaction reply was not a valid result frame");
        self
    }
}

/// Identity fields a reply must echo, borrowed from the parsed reply.
#[derive(Clone, Copy)]
struct ReplyBinding<'a> {
    interaction_id: Option<&'a str>,
    thread_id: Option<&'a str>,
    turn_id: Option<&'a str>,
}

impl<'a> From<&'a ApprovalResponse> for ReplyBinding<'a> {
    fn from(reply: &'a ApprovalResponse) -> Self {
        Self {
            interaction_id: reply.approval_id.as_deref(),
            thread_id: reply.thread_id.as_deref(),
            turn_id: reply.turn_id.as_deref(),
        }
    }
}

impl<'a> From<&'a QuestionResponse> for ReplyBinding<'a> {
    fn from(reply: &'a QuestionResponse) -> Self {
        Self {
            interaction_id: reply.question_id.as_deref(),
            thread_id: reply.thread_id.as_deref(),
            turn_id: reply.turn_id.as_deref(),
        }
    }
}

impl ReplyBinding<'_> {
    fn matches(&self, expected: &InteractionBinding) -> bool {
        self.interaction_id == Some(expected.interaction_id.as_str())
            && self.thread_id == Some(expected.thread_id.as_str())
            && self.turn_id == Some(expected.turn_id.as_str())
    }
}

fn deliver_approval_response(
    pending_approvals: &PendingApprovalResponses,
    request_id: u64,
    parsed: std::result::Result<ApprovalResponse, String>,
) -> InteractionReply {
    let Some(response_tx) = pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id)
    else {
        return InteractionReply::Unmatched;
    };
    let _ = response_tx.send(parsed);
    InteractionReply::Delivered
}

fn deliver_question_response(
    pending_questions: &PendingQuestionResponses,
    request_id: u64,
    parsed: std::result::Result<QuestionResponse, String>,
) -> InteractionReply {
    let Some(response_tx) = pending_questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&request_id)
    else {
        return InteractionReply::Unmatched;
    };
    let _ = response_tx.send(parsed);
    InteractionReply::Delivered
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

impl InteractionReceipts {
    /// Registers an interaction that is now waiting for a reply.
    fn track_request(&mut self, request_id: u64, binding: InteractionBinding, request: Value) {
        self.outstanding
            .insert(request_id, OutstandingInteraction { binding, request });
    }

    /// Drops an interaction that ended without a terminal answer to replay
    /// (timeout or closed connection); no receipt is kept for it.
    fn forget_request(&mut self, request_id: u64) {
        self.outstanding.remove(&request_id);
    }

    fn expected_binding(&self, request_id: u64) -> Option<&InteractionBinding> {
        self.outstanding
            .get(&request_id)
            .map(|entry| &entry.binding)
    }

    fn outstanding_request(&self, request_id: u64) -> Option<Value> {
        self.outstanding
            .get(&request_id)
            .map(|entry| entry.request.clone())
    }

    fn note_misattributed(&mut self) {
        self.misattributed_replies = self.misattributed_replies.saturating_add(1);
    }

    fn record(&mut self, request_id: u64, notification: Value) {
        self.outstanding.remove(&request_id);
        while self.resolved.len() >= INTERACTION_RECEIPT_LIMIT {
            self.resolved.pop_front();
        }
        self.resolved.push_back((request_id, notification));
    }

    /// Returns the terminal answer already sent for `request_id`, if any.
    fn replay(&mut self, request_id: u64) -> Option<Value> {
        let found = self
            .resolved
            .iter()
            .find(|(id, _)| *id == request_id)
            .map(|(_, notification)| notification.clone());
        if found.is_some() {
            self.duplicate_replies = self.duplicate_replies.saturating_add(1);
        }
        found
    }

    fn note_unmatched(&mut self) {
        self.unmatched_replies = self.unmatched_replies.saturating_add(1);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.resolved.len()
    }

    #[cfg(test)]
    fn counters(&self) -> (u64, u64) {
        (self.duplicate_replies, self.unmatched_replies)
    }

    #[cfg(test)]
    fn outstanding_len(&self) -> usize {
        self.outstanding.len()
    }
}

#[derive(Clone)]
struct AppServerQuestioner {
    outbound_tx: mpsc::Sender<Value>,
    pending: PendingQuestionResponses,
    receipts: Arc<StdMutex<InteractionReceipts>>,
    next_id: Arc<AtomicU64>,
    context: Arc<StdMutex<Option<QuestionContext>>>,
}

#[async_trait]
impl UserQuestioner for AppServerQuestioner {
    async fn ask(
        &self,
        request: UserQuestionRequest,
    ) -> std::result::Result<UserQuestionResponse, String> {
        let context = self
            .context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
            .ok_or_else(|| {
                "question was requested outside an active app-server turn".to_string()
            })?;
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let question_id = format!("question-{request_id}");
        let questions = request
            .questions
            .iter()
            .enumerate()
            .map(|(index, question)| Question {
                id: format!("question-{}", index + 1),
                header: question.header.clone(),
                prompt: question.question.clone(),
                options: question
                    .options
                    .iter()
                    .map(|option| QuestionOption {
                        label: option.label.clone(),
                        value: option.label.clone(),
                        description: option.description.clone(),
                        preview: option.preview.clone(),
                    })
                    .collect(),
                allows_freeform: true,
                multi_select: question.multi_select,
            })
            .collect::<Vec<_>>();
        let params = QuestionRequestParams {
            server_id: context.server_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            question_id,
            questions,
            annotations: request.annotations.clone(),
        };
        let resolved_question_id = params.question_id.clone();
        let resolved_thread_id = params.thread_id.clone();
        let resolved_turn_id = params.turn_id.clone();
        let (response_tx, response_rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(request_id, response_tx);
        let request_frame = json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": request_id,
            "method": method::QUESTION_REQUEST,
            "params": params,
        });
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .track_request(
                request_id,
                InteractionBinding {
                    interaction_id: resolved_question_id.clone(),
                    thread_id: resolved_thread_id.clone(),
                    turn_id: resolved_turn_id.clone(),
                },
                request_frame.clone(),
            );
        if self.outbound_tx.send(request_frame).await.is_err() {
            self.pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&request_id);
            self.receipts
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .forget_request(request_id);
            return Err("app-server connection closed while asking a question".to_string());
        }
        let response = response_rx.await;
        let reason = match &response {
            Ok(Ok(_)) => "client_response",
            Ok(Err(error)) if error == "the user cancelled the question request" => "cancelled",
            Ok(Err(_)) => "response_error",
            Err(_) => "cancelled",
        };
        let resolved = notification(
            method::QUESTION_RESOLVED,
            serde_json::to_value(QuestionResolvedParams {
                request_id,
                question_id: resolved_question_id,
                thread_id: resolved_thread_id,
                turn_id: resolved_turn_id,
                reason: reason.into(),
            })
            .expect("question resolution serializes"),
        );
        self.receipts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(request_id, resolved.clone());
        let _ = self.outbound_tx.send(resolved).await;
        let response = response.map_err(|_| "app-server question was cancelled".to_string())??;
        let mut answers = HashMap::new();
        for (index, question) in request.questions.iter().enumerate() {
            let id = format!("question-{}", index + 1);
            let selected = response
                .answers
                .get(&id)
                .map(|answer| answer.answers.join(", "))
                .unwrap_or_default();
            if !selected.trim().is_empty() {
                answers.insert(question.question.clone(), selected);
            }
        }
        Ok(UserQuestionResponse {
            questions: request.questions,
            answers,
            annotations: response.annotations.or(request.annotations),
        })
    }
}

impl ActiveTurn {
    fn matches(&self, thread_id: Option<&str>, turn_id: Option<&str>) -> bool {
        thread_id == Some(self.thread_id.as_str()) && turn_id == Some(self.turn_id.as_str())
    }
}

async fn cancel_active_turn_with_timeout(
    mut active: ActiveTurn,
    turn_state: &ResidentTurnState,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    background_followups: &Arc<BackgroundFollowupState>,
    timeout: Duration,
) {
    let thread_id = active.thread_id.clone();
    let turn_id = active.turn_id.clone();
    active.cancel.cancel();
    {
        let _gate = turn_state.activity_gate.lock().await;
        let has_newer_turn = turn_state
            .active_turn
            .lock()
            .await
            .as_ref()
            .is_some_and(|current| !current.matches(Some(&thread_id), Some(&turn_id)));
        if !has_newer_turn {
            // Release this turn's interaction waiters first; otherwise question/approval
            // futures may prevent cooperative cancellation from finishing within the bound.
            turn_state.clear_pending();
            turn_state.clear_matching_turn(&thread_id, &turn_id);
        }
    }
    if tokio::time::timeout(timeout, &mut active.handle)
        .await
        .is_err()
    {
        active.handle.abort();
        let _ = active.handle.await;
    }
    let _gate = turn_state.activity_gate.lock().await;
    let mut current = turn_state.active_turn.lock().await;
    if current
        .as_ref()
        .is_some_and(|active| !active.matches(Some(&thread_id), Some(&turn_id)))
    {
        return;
    }
    if current
        .as_ref()
        .is_some_and(|active| active.matches(Some(&thread_id), Some(&turn_id)))
    {
        current.take();
    }
    drop(current);
    turn_state.clear_pending();
    turn_state.clear_matching_turn(&thread_id, &turn_id);
    clear_active_background_projection(background_projection, &thread_id, &turn_id).await;
    turn_state.running.store(false, Ordering::SeqCst);
    background_followups.notify.notify_waiters();
}

async fn cancel_active_turn_bounded(
    active: ActiveTurn,
    turn_state: &ResidentTurnState,
    background_projection: &Arc<Mutex<BackgroundProjectionState>>,
    background_followups: &Arc<BackgroundFollowupState>,
) {
    cancel_active_turn_with_timeout(
        active,
        turn_state,
        background_projection,
        background_followups,
        ACTIVE_TURN_SHUTDOWN_TIMEOUT,
    )
    .await;
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

impl StreamProjection {
    fn new(
        server_id: String,
        thread_id: String,
        turn_id: String,
        sequence: Arc<AtomicU64>,
    ) -> Self {
        Self {
            server_id,
            thread_id,
            item_namespace: turn_id.clone(),
            turn_id,
            sequence,
            next_item: 1,
            assistant_item: None,
        }
    }

    fn params(&self, payload: Value) -> Value {
        with_event_context(
            &self.server_id,
            &self.thread_id,
            Some(&self.turn_id),
            &self.sequence,
            payload,
        )
    }

    fn project(&mut self, event: EngineEvent) -> Vec<Value> {
        self.project_with_client_message_id(event, None)
    }

    fn project_with_client_message_id(
        &mut self,
        event: EngineEvent,
        client_message_id: Option<String>,
    ) -> Vec<Value> {
        if let EngineEvent::BackgroundScoped { identity, event } = event {
            let mut messages = self.project_with_client_message_id(*event, client_message_id);
            for message in &mut messages {
                if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
                    params.insert(
                        "identity".into(),
                        serde_json::to_value(&identity).expect("background identity serializes"),
                    );
                }
            }
            return messages;
        }
        match event {
            EngineEvent::SubagentSteerApplied {
                agent_id,
                message_id,
                queue_depth,
            } => vec![notification(
                method::AGENT_STEER_APPLIED,
                serde_json::to_value(AgentSteerAppliedParams {
                    identity: None,
                    context: kcoder_app_protocol::EventContext {
                        server_id: self.server_id.clone(),
                        thread_id: self.thread_id.clone(),
                        turn_id: Some(self.turn_id.clone()),
                        sequence: self.sequence.fetch_add(1, Ordering::SeqCst),
                    },
                    agent_id,
                    message_id,
                    queue_depth,
                    applied_at_ms: now_millis(),
                    client_message_id,
                })
                .expect("agent steer applied params serialize"),
            )],
            EngineEvent::AssistantMessageStarted => {
                let id = format!("{}-assistant-{}", self.item_namespace, self.next_item);
                self.next_item += 1;
                self.assistant_item = Some(id.clone());
                vec![notification(
                    "item/started",
                    self.params(json!({"item": {"id": id, "type": "agentMessage"}})),
                )]
            }
            EngineEvent::AssistantTextDelta(text) => {
                let id = self.assistant_item.clone().unwrap_or_else(|| {
                    let id = format!("{}-assistant-{}", self.item_namespace, self.next_item);
                    self.next_item += 1;
                    self.assistant_item = Some(id.clone());
                    id
                });
                vec![notification(
                    "item/delta",
                    self.params(json!({"itemId": id, "delta": {"text": text}})),
                )]
            }
            EngineEvent::AssistantMessageDone => self
                .assistant_item
                .take()
                .map(|id| {
                    notification(
                        "item/completed",
                        self.params(json!({
                            "item": {"id": id, "type": "agentMessage", "status": "completed"}
                        })),
                    )
                })
                .into_iter()
                .collect(),
            EngineEvent::ToolUseStarted { id, name, input } => vec![notification(
                "item/started",
                self.params(json!({
                    "item": {"id": id, "type": "toolCall", "name": name, "input": input}
                })),
            )],
            EngineEvent::ToolResult { id, name, output } => {
                let raw = engine_event_json(EngineEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    output,
                });
                vec![notification(
                    "item/completed",
                    self.params(json!({
                        "item": {
                            "id": id,
                            "type": "toolCall",
                            "name": name,
                            "status": if raw.get("is_error").and_then(Value::as_bool).unwrap_or(false) { "failed" } else { "completed" },
                            "output": raw.get("text").cloned().unwrap_or(Value::Null),
                        },
                    })),
                )]
            }
            other => vec![notification(
                "item/event",
                self.params(json!({"event": engine_event_json(other)})),
            )],
        }
    }
}

fn background_event_id(event: &EngineEvent) -> Option<&str> {
    match event.background_payload() {
        EngineEvent::BackgroundJobStarted { id, .. }
        | EngineEvent::SubagentSteerApplied { agent_id: id, .. }
        | EngineEvent::BackgroundJobAssociated { id, .. }
        | EngineEvent::BackgroundJobPromoted { id }
        | EngineEvent::BackgroundJobProgress { id, .. }
        | EngineEvent::BackgroundJobPaused { id, .. }
        | EngineEvent::BackgroundJobHalted { id, .. }
        | EngineEvent::BackgroundJobCompleted { id, .. }
        | EngineEvent::BackgroundJobFailed { id, .. }
        | EngineEvent::BackgroundJobCancelled { id, .. } => Some(id),
        _ => None,
    }
}

fn tool_can_spawn_managed_background_job(name: &str) -> bool {
    matches!(
        name,
        "spawn_agent" | "explore_agent" | "PlanAgent" | "Workflow"
    )
}

fn is_background_terminal_event(event: &EngineEvent) -> bool {
    matches!(
        event.background_payload(),
        EngineEvent::BackgroundJobCompleted { .. }
            | EngineEvent::BackgroundJobFailed { .. }
            | EngineEvent::BackgroundJobHalted { .. }
            | EngineEvent::BackgroundJobCancelled { .. }
    )
}

async fn set_active_background_projection(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    thread_id: &str,
    turn_id: &str,
    projection: Arc<Mutex<StreamProjection>>,
) {
    state.lock().await.active = Some(BackgroundTurnProjection {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        projection,
    });
}

async fn clear_active_background_projection(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    thread_id: &str,
    turn_id: &str,
) {
    let mut state = state.lock().await;
    if state
        .active
        .as_ref()
        .is_some_and(|active| active.thread_id == thread_id && active.turn_id == turn_id)
    {
        state.active = None;
    }
}

async fn rotate_background_projection(state: &Arc<Mutex<BackgroundProjectionState>>) {
    let mut state = state.lock().await;
    state.active = None;
    state.jobs.clear();
    state.tool_calls.clear();
    state.job_tools.clear();
    state.pending.clear();
    state.associated_jobs.clear();
    state.terminal_jobs.clear();
    state.current_runs.clear();
    state.last_contexts.clear();
    state.forwarded_events.clear();
    state.forwarded_order.clear();
    state.steer_response_gates.clear();
    state.steer_correlations.clear();
}

async fn begin_agent_steer_response_gate(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    agent_id: &str,
    client_message_id: Option<String>,
) -> Result<()> {
    let mut state = state.lock().await;
    if state.steer_response_gates.contains_key(agent_id) {
        anyhow::bail!("another agent/steer response is pending for this agent");
    }
    state.steer_response_gates.insert(
        agent_id.to_string(),
        AgentSteerResponseGate {
            client_message_id,
            deferred_applied: Vec::new(),
        },
    );
    Ok(())
}

async fn finish_agent_steer_response_gate(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    agent_id: &str,
    message_id: Option<&str>,
) -> Result<()> {
    let deferred = {
        let mut state = state.lock().await;
        let Some(gate) = state.steer_response_gates.remove(agent_id) else {
            return Ok(());
        };
        if let Some(message_id) = message_id {
            const MAX_STEER_CORRELATIONS: usize = 256;
            if state.steer_correlations.len() >= MAX_STEER_CORRELATIONS
                && let Some(oldest) = state.steer_correlations.keys().next().cloned()
            {
                state.steer_correlations.remove(&oldest);
            }
            state.steer_correlations.insert(
                message_id.to_string(),
                AgentSteerCorrelation {
                    agent_id: agent_id.to_string(),
                    client_message_id: gate.client_message_id,
                },
            );
        }
        gate.deferred_applied
    };
    for (context, event) in deferred {
        let Some(context) = context else {
            project_engine_background_event(state, outbound_tx, event).await?;
            continue;
        };
        let client_message_id = if let EngineEvent::SubagentSteerApplied { message_id, .. } =
            event.background_payload()
        {
            state
                .lock()
                .await
                .steer_correlations
                .remove(message_id)
                .and_then(|correlation| correlation.client_message_id)
        } else {
            None
        };
        let messages = context
            .projection
            .lock()
            .await
            .project_with_client_message_id(event, client_message_id);
        for message in messages {
            send(outbound_tx, message).await?;
        }
    }
    Ok(())
}

async fn clear_background_followups(state: &BackgroundFollowupState) {
    let mut queue = state.queue.lock().await;
    queue.pending.clear();
    queue.claimed_terminal_ids.clear();
    drop(queue);
    state.notify.notify_waiters();
}

async fn queue_background_followup_once(
    state: &BackgroundFollowupState,
    id: String,
    run_started_at_ms: Option<u64>,
    summary: String,
    should_trigger: bool,
) -> bool {
    if !should_trigger {
        return false;
    }
    let mut queue = state.queue.lock().await;
    if !queue.claim_run(&id, run_started_at_ms) {
        return false;
    }
    queue.pending.insert(id, summary);
    drop(queue);
    state.notify.notify_waiters();
    true
}

fn followup_run_key(value: &str) -> Option<kcoder_types::BackgroundRunKey> {
    serde_json::from_str(value).ok()
}
fn followup_key_is_eligible(engine: &QueryEngine, value: &str) -> bool {
    if let Some(key) = followup_run_key(value) {
        return engine
            .state
            .task_for_background_run(&key)
            .is_some_and(|task| {
                task.kind == TaskKind::Subagent && task.notify_parent_on_completion
            })
            && engine
                .state
                .background_run_record(&key)
                .is_some_and(|record| {
                    record.terminal.is_some()
                        && record.delivered_message_id.is_some()
                        && record.pending_result_message_id.is_none()
                        && !record.suppressed
                        && !record.followup_handled
                        && !record.followup_started
                        && record.delivery == TaskDelivery::Background
                });
    }
    engine.background_job_triggers_followup(value)
}

async fn queue_recovered_background_followups(
    engine: &QueryEngine,
    state: &BackgroundFollowupState,
    recovered: Vec<(String, String)>,
    should_trigger: impl Fn(&str) -> bool,
) {
    for (id, summary) in recovered {
        if !should_trigger(&id) {
            continue;
        }
        if let Some(key) = engine.state.task(&id).and_then(|task| task.background_run) {
            let value = serde_json::to_string(&key).expect("run identity serializes");
            if followup_key_is_eligible(engine, &value) {
                queue_background_followup_once(state, value, None, summary, true).await;
            }
        } else {
            let started = engine
                .state
                .task(&id)
                .and_then(|task| task.run_started_at_ms);
            queue_background_followup_once(state, id, started, summary, true).await;
        }
    }
}

async fn register_background_tool_call(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    tool_call_id: &str,
    thread_id: &str,
    turn_id: &str,
    projection: Arc<Mutex<StreamProjection>>,
) {
    state.lock().await.tool_calls.insert(
        tool_call_id.to_string(),
        BackgroundTurnProjection {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            projection,
        },
    );
}

fn retire_background_projection(state: &mut BackgroundProjectionState, id: &str) {
    state.terminal_jobs.insert(id.to_owned());
    state.jobs.remove(id);
    state.associated_jobs.remove(id);
    if let Some(tool_call_id) = state.job_tools.remove(id) {
        state.tool_calls.remove(&tool_call_id);
    }
}

async fn project_engine_background_event(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: EngineEvent,
) -> Result<()> {
    if let EngineEvent::SubagentSteerApplied { agent_id, .. } = event.background_payload() {
        let mut state = state.lock().await;
        if state.steer_response_gates.contains_key(agent_id) {
            // Capture the projection context now: the run may retire before the
            // steer response is on the wire, and an accepted steer must still be
            // acknowledged afterwards.
            let context = state
                .jobs
                .get(agent_id)
                .cloned()
                .or_else(|| state.last_contexts.get(agent_id).cloned())
                .or_else(|| state.active.clone());
            if let Some(gate) = state.steer_response_gates.get_mut(agent_id) {
                gate.deferred_applied.push((context, event));
            }
            return Ok(());
        }
    }
    let Some(id) = background_event_id(&event).map(str::to_string) else {
        return Ok(());
    };
    let agent_id = id;
    let id = event
        .background_identity()
        .map(|identity| serde_json::to_string(&identity.run).expect("run key serializes"))
        .unwrap_or_else(|| agent_id.clone());
    let mut retired = false;
    let routed = {
        let mut state = state.lock().await;
        if event.background_identity().is_some() {
            if let Some(current) = state.current_runs.get(&agent_id) {
                if current != &id
                    && !matches!(
                        event.background_payload(),
                        EngineEvent::BackgroundJobStarted { .. }
                            | EngineEvent::BackgroundJobAssociated { .. }
                    )
                {
                    return Ok(());
                }
            }
            if state.terminal_jobs.contains(&id) {
                return Ok(());
            }
            if let Some(previous) = state.current_runs.insert(agent_id.clone(), id.clone()) {
                if previous != id {
                    state.terminal_jobs.insert(previous.clone());
                    state.jobs.remove(&previous);
                    state.pending.remove(&previous);
                    state.associated_jobs.remove(&previous);
                    state.job_tools.remove(&previous);
                }
            }
        } else if state.current_runs.contains_key(&agent_id) {
            // An unscoped late event must not mutate a run-aware projection.
            return Ok(());
        }
        if state.terminal_jobs.contains(&id) {
            return Ok(());
        }
        if let EngineEvent::BackgroundJobAssociated { tool_call_id, .. } =
            event.background_payload()
        {
            if state.associated_jobs.contains(&id) {
                return Ok(());
            }
            let context = state
                .jobs
                .get(&id)
                .cloned()
                .or_else(|| state.tool_calls.get(tool_call_id).cloned())
                .or_else(|| {
                    event
                        .background_identity()
                        .and_then(|_| state.active.clone())
                })
                .or_else(|| {
                    event
                        .background_identity()
                        .and_then(|_| state.last_contexts.get(&agent_id).cloned())
                });
            let Some(context) = context else {
                let pending = state.pending.entry(id).or_default();
                if pending.len() < 64 {
                    pending.push(event);
                }
                return Ok(());
            };
            state
                .last_contexts
                .insert(agent_id.clone(), context.clone());
            state.jobs.insert(id.clone(), context.clone());
            state.job_tools.insert(id.clone(), tool_call_id.clone());
            state.associated_jobs.insert(id.clone());
            let pending = state.pending.remove(&id).unwrap_or_default();
            let mut ordered = pending
                .iter()
                .filter(|event| {
                    matches!(
                        event.background_payload(),
                        EngineEvent::BackgroundJobStarted { .. }
                    )
                })
                .cloned()
                .map(|event| (context.clone(), event))
                .collect::<Vec<_>>();
            ordered.push((context.clone(), event));
            ordered.extend(
                pending
                    .into_iter()
                    .filter(|event| {
                        !matches!(
                            event.background_payload(),
                            EngineEvent::BackgroundJobStarted { .. }
                        )
                    })
                    .map(|event| (context.clone(), event)),
            );
            ordered.retain(|(_, event)| {
                if retired
                    && !matches!(
                        event.background_payload(),
                        EngineEvent::SubagentSteerApplied { .. }
                    )
                {
                    return false;
                }
                if !is_background_terminal_event(event) {
                    return true;
                }
                if retired {
                    return false;
                }
                retired = true;
                true
            });
            if retired {
                retire_background_projection(&mut state, &id);
            }
            ordered
        } else {
            if is_background_terminal_event(&event) && state.terminal_jobs.contains(&id) {
                return Ok(());
            }
            let Some(context) = state.jobs.get(&id).cloned() else {
                let pending = state.pending.entry(id).or_default();
                let duplicate_start = matches!(
                    event.background_payload(),
                    EngineEvent::BackgroundJobStarted { .. }
                ) && pending.iter().any(|event| {
                    matches!(
                        event.background_payload(),
                        EngineEvent::BackgroundJobStarted { .. }
                    )
                });
                let must_deliver = matches!(
                    event.background_payload(),
                    EngineEvent::SubagentSteerApplied { .. }
                );
                if pending.len() < 64 && !duplicate_start {
                    pending.push(event);
                } else if must_deliver {
                    if let Some(index) = pending.iter().position(|event| {
                        matches!(
                            event.background_payload(),
                            EngineEvent::BackgroundJobProgress { .. }
                        )
                    }) {
                        pending.remove(index);
                    }
                    pending.push(event);
                }
                return Ok(());
            };
            if is_background_terminal_event(&event) {
                retire_background_projection(&mut state, &id);
                retired = true;
            }
            vec![(context, event)]
        }
    };
    let result = async {
        for (context, event) in routed {
            if let Some(identity) = event.background_identity() {
                let key = serde_json::to_string(&(&identity.run, &identity.event_id))
                    .expect("event key serializes");
                let mut projection_state = state.lock().await;
                if !projection_state.forwarded_events.insert(key.clone()) {
                    continue;
                }
                projection_state.forwarded_order.push_back(key);
                if projection_state.forwarded_order.len() > 65_536 {
                    if let Some(oldest) = projection_state.forwarded_order.pop_front() {
                        projection_state.forwarded_events.remove(&oldest);
                    }
                }
            }
            let client_message_id =
                if let EngineEvent::SubagentSteerApplied { message_id, .. } =
                    event.background_payload()
                {
                    state
                        .lock()
                        .await
                        .steer_correlations
                        .remove(message_id)
                        .and_then(|correlation| correlation.client_message_id)
                } else {
                    None
                };
            let messages = context
                .projection
                .lock()
                .await
                .project_with_client_message_id(event, client_message_id);
            for message in messages {
                send(outbound_tx, message).await?;
            }
        }
        Ok(())
    }
    .await;
    if retired {
        state
            .lock()
            .await
            .steer_correlations
            .retain(|_, correlation| correlation.agent_id != agent_id);
    }
    result
}

async fn project_managed_background_event(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: EngineEvent,
) -> Result<()> {
    let Some(id) = background_event_id(&event) else {
        return Ok(());
    };
    if let Some(identity) = event.background_identity() {
        if engine
            .state
            .task(id)
            .is_some_and(|task| task.background_run.as_ref() != Some(&identity.run))
        {
            // Reconnection must not project an old completion onto the current run.
            // Its durable parent delivery is handled separately by the engine.
            return Ok(());
        }
    }
    // Generic tool wrappers never produce a managed agent/tool association.
    // Their model notifications and hooks are still consumed by the engine.
    match engine.state.task_kind(id) {
        Some(TaskKind::Subagent | TaskKind::Workflow) => {}
        Some(TaskKind::Generic) => return Ok(()),
        None => {
            // Goal-stop can remove the durable task before broadcasting its terminal event.
            let projection = state.lock().await;
            if !projection.jobs.contains_key(id)
                && !projection.pending.contains_key(id)
                && !projection.terminal_jobs.contains(id)
                && !projection.current_runs.contains_key(id)
            {
                return Ok(());
            }
        }
    }
    let resumed_association = if matches!(
        event.background_payload(),
        EngineEvent::BackgroundJobStarted { .. }
    ) {
        event.background_identity().and_then(|identity| {
            engine.state.task(id).and_then(|task| {
                task.parent_tool_call_id
                    .map(|tool_call_id| EngineEvent::BackgroundScoped {
                        identity: kcoder_types::BackgroundEventIdentity {
                            run: identity.run.clone(),
                            event_id: format!("{}:association", identity.run.run_id),
                            run_sequence: 0,
                        },
                        event: Box::new(EngineEvent::BackgroundJobAssociated {
                            id: id.to_owned(),
                            tool_call_id,
                            run_in_background: matches!(task.delivery, TaskDelivery::Background),
                        }),
                    })
            })
        })
    } else {
        None
    };
    project_engine_background_event(state, outbound_tx, event).await?;
    if let Some(association) = resumed_association {
        project_engine_background_event(state, outbound_tx, association).await?;
    }
    Ok(())
}

#[cfg(test)]
async fn project_background_broadcast_event(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: BackgroundJobEvent,
) -> Result<()> {
    project_engine_background_event(state, outbound_tx, event.into()).await
}

async fn project_flushed_background_events(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    events: Vec<EngineEvent>,
) -> Result<()> {
    for event in events {
        if background_event_id(&event).is_some() {
            project_managed_background_event(engine, state, outbound_tx, event).await?;
        }
    }
    Ok(())
}

async fn reconcile_background_jobs(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
) -> Result<Vec<(String, String)>> {
    let mut followups = Vec::new();
    for task in engine.state.tasks().into_values() {
        let Some(tool_call_id) = task.parent_tool_call_id.clone() else {
            continue;
        };
        let routable = {
            let state = state.lock().await;
            background_task_is_routable(&state, &task.id, &tool_call_id)
        };
        let followup = reconciled_background_followup(&task, routable);
        if !routable {
            continue;
        }
        let run = task.background_run.clone();
        let stored_terminal = run
            .as_ref()
            .and_then(|run| engine.state.background_run_record(run))
            .and_then(|record| record.terminal);
        let association = EngineEvent::BackgroundJobAssociated {
            id: task.id.clone(),
            tool_call_id,
            run_in_background: matches!(task.delivery, TaskDelivery::Background),
        };
        let association = if let Some(run) = run.clone() {
            EngineEvent::BackgroundScoped {
                identity: kcoder_types::BackgroundEventIdentity {
                    event_id: format!("{}:association", run.run_id),
                    run,
                    run_sequence: 0,
                },
                event: Box::new(association),
            }
        } else {
            association
        };
        project_engine_background_event(state, outbound_tx, association).await?;
        let terminal = match task.status {
            TaskStatus::Completed => Some(EngineEvent::BackgroundJobCompleted {
                id: task.id.clone(),
                output: kcoder_tools::ToolOutput::text(task.output.unwrap_or_default()),
            }),
            TaskStatus::Failed => Some(EngineEvent::BackgroundJobFailed {
                id: task.id.clone(),
                error: task
                    .output
                    .unwrap_or_else(|| "background job failed".into()),
            }),
            TaskStatus::Cancelled => Some(EngineEvent::BackgroundJobCancelled {
                id: task.id.clone(),
                reason: task
                    .output
                    .unwrap_or_else(|| "background job cancelled".into()),
            }),
            TaskStatus::Halted => Some(EngineEvent::BackgroundJobHalted {
                id: task.id.clone(),
                reason: task
                    .output
                    .unwrap_or_else(|| "background job halted".into()),
            }),
            TaskStatus::Paused => Some(EngineEvent::BackgroundJobPaused {
                id: task.id.clone(),
                reason: task
                    .control
                    .reason
                    .map(|reason| reason.message)
                    .unwrap_or_else(|| "background job paused".into()),
            }),
            TaskStatus::Pending | TaskStatus::Running => None,
        };
        if let Some(terminal) = terminal {
            let terminal = if let Some(identity) = stored_terminal {
                Some(EngineEvent::BackgroundScoped {
                    identity,
                    event: Box::new(terminal),
                })
            } else if matches!(
                terminal.background_payload(),
                EngineEvent::BackgroundJobPaused { .. }
            ) {
                Some(if let Some(run) = run.clone() {
                    EngineEvent::BackgroundScoped {
                        identity: kcoder_types::BackgroundEventIdentity {
                            event_id: format!("{}:paused", run.run_id),
                            run,
                            run_sequence: 0,
                        },
                        event: Box::new(terminal),
                    }
                } else {
                    terminal
                })
            } else if run.is_none() {
                Some(terminal)
            } else {
                None
            };
            if let Some(terminal) = terminal {
                project_engine_background_event(state, outbound_tx, terminal).await?;
            }
        }
        if let Some(followup) = followup {
            followups.push(followup);
        }
    }
    Ok(followups)
}

fn reconciled_background_followup(task: &Task, routable: bool) -> Option<(String, String)> {
    routable
        .then(|| background_task_terminal_summary(task))
        .flatten()
        .map(|summary| (task.id.clone(), summary))
}

fn background_task_is_routable(
    state: &BackgroundProjectionState,
    task_id: &str,
    tool_call_id: &str,
) -> bool {
    state.jobs.contains_key(task_id)
        || state.current_runs.get(task_id).is_some_and(|key| state.jobs.contains_key(key) || state.terminal_jobs.contains(key))
        || state.tool_calls.contains_key(tool_call_id)
    // flush_background_jobs_with_hooks may already have delivered a terminal event
    // and cleared jobs/tool_calls. terminal_jobs belongs to the current session epoch,
    // remains a reliable reconciliation-scope marker, and cannot import jobs from an old session.
        || state.terminal_jobs.contains(task_id)
}

fn background_task_terminal_summary(task: &Task) -> Option<String> {
    match task.status {
        TaskStatus::Completed => Some(format!("background sub-agent `{}` completed", task.id)),
        TaskStatus::Failed => Some(format!(
            "background sub-agent `{}` failed: {}",
            task.id,
            task.output.as_deref().unwrap_or("background job failed")
        )),
        TaskStatus::Cancelled => Some(format!(
            "background sub-agent `{}` was cancelled: {}",
            task.id,
            task.output.as_deref().unwrap_or("background job cancelled")
        )),
        TaskStatus::Halted => Some(format!(
            "background sub-agent `{}` was halted: {}",
            task.id,
            task.output.as_deref().unwrap_or("background job halted")
        )),
        TaskStatus::Paused | TaskStatus::Pending | TaskStatus::Running => None,
    }
}

fn agent_summary(task: Task) -> AgentSummary {
    let queue_depth = task.message_queue.len();
    let status = match task.status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Paused => "paused",
        TaskStatus::Halted => "halted",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    };
    let (head_message_id, head_status) = task
        .message_queue
        .first()
        .map(|message| {
            let status = match message.status {
                AgentMessageStatus::Queued => "queued",
                AgentMessageStatus::Leased => "leased",
                AgentMessageStatus::Blocked => "blocked",
                AgentMessageStatus::Acknowledged => "acknowledged",
                AgentMessageStatus::DeadLetter => "dead_letter",
            };
            (Some(message.message_id.clone()), Some(status.to_string()))
        })
        .unwrap_or((None, None));
    let output_path = task
        .output_path
        .as_deref()
        .map(|path| dunce::simplified(path).to_string_lossy().into_owned());
    let transcript_path = task
        .transcript_path
        .as_deref()
        .map(|path| dunce::simplified(path).to_string_lossy().into_owned());
    AgentSummary {
        retained_runs: task.background_runs.len(),
        retained_run_limit: kcoder_state::MAX_BACKGROUND_RUNS_PER_TASK,
        capacity_warning: task.background_runs.len()
            >= kcoder_state::MAX_BACKGROUND_RUNS_PER_TASK * 4 / 5,
        background_run: task.background_run,
        parent_tool_call_id: task.parent_tool_call_id,
        agent_id: task.id,
        agent_name: task.roster_name,
        status: status.to_string(),
        accepting_messages: task.accepting_subagent_messages,
        queue_depth,
        head_message_id,
        head_status,
        output_path,
        transcript_path,
    }
}

fn background_terminal_summary(event: &BackgroundJobEvent) -> Option<(&str, String)> {
    match event.payload() {
        BackgroundJobEvent::Completed { id, .. } => {
            Some((id, format!("background sub-agent `{id}` completed")))
        }
        BackgroundJobEvent::Failed { id, error } => {
            Some((id, format!("background sub-agent `{id}` failed: {error}")))
        }
        BackgroundJobEvent::Halted { id, reason } => Some((
            id,
            format!("background sub-agent `{id}` was halted: {reason}"),
        )),
        BackgroundJobEvent::Cancelled { id, reason } => Some((
            id,
            format!("background sub-agent `{id}` was cancelled: {reason}"),
        )),
        _ => None,
    }
}

fn has_running_background_followups(engine: &QueryEngine) -> bool {
    engine.state.tasks().into_values().any(|task| {
        matches!(task.kind, TaskKind::Subagent)
            && task.notify_parent_on_completion
            && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
    })
}

async fn take_ready_background_followup_batch(
    state: &BackgroundFollowupState,
    has_running: bool,
    engine: Option<&QueryEngine>,
    should_trigger: impl Fn(&str) -> bool,
) -> Option<(String, Vec<kcoder_types::BackgroundRunKey>)> {
    if has_running {
        return None;
    }
    let mut queue = state.queue.lock().await;
    // `close_agent` removes the task record; drop queued summaries that no
    // longer correspond to a follow-up-triggering agent so an aggregate turn
    // never mentions a closed agent.
    queue.pending.retain(|id, _| should_trigger(id));
    if queue.pending.is_empty() {
        return None;
    }
    // Recover an already frozen batch before admitting later arrivals into a new batch.
    let existing_batch = engine.and_then(|engine| {
        queue.pending.keys().find_map(|value| {
            followup_run_key(value)
                .and_then(|key| engine.state.background_run_record(&key))
                .and_then(|record| record.followup_turn_id)
        })
    });
    let selected: Vec<_> = queue
        .pending
        .keys()
        .filter(|value| match (&existing_batch, engine) {
            (Some(batch), Some(engine)) => followup_run_key(value)
                .and_then(|key| engine.state.background_run_record(&key))
                .is_some_and(|record| record.followup_turn_id.as_ref() == Some(batch)),
            _ => true,
        })
        .cloned()
        .collect();
    if selected.is_empty() {
        return None;
    }
    let summary = selected
        .iter()
        .filter_map(|key| queue.pending.remove(key))
        .collect::<Vec<_>>()
        .join(" ");
    let keys = selected
        .iter()
        .filter_map(|key| followup_run_key(key))
        .collect();
    Some((summary, keys))
}

#[cfg(test)]
async fn take_ready_background_followup(
    state: &BackgroundFollowupState,
    has_running: bool,
    should_trigger: impl Fn(&str) -> bool,
) -> Option<String> {
    take_ready_background_followup_batch(state, has_running, None, should_trigger)
        .await
        .map(|(summary, _)| summary)
}

fn background_followup_nudge(summary: &str) -> String {
    format!(
        "[system] All tracked background sub-agents have finished. Aggregate their results now \
         using the available `<subagent_notification .../>` entries and output files. Events: \
         {summary}. Continue the original task, do not repeat work already delegated to a \
         sub-agent, and do not give a final conclusion until the relevant results have been \
         inspected."
    )
}

async fn run_background_event_pump(
    engine: QueryEngine,
    mut receiver: tokio::sync::broadcast::Receiver<BackgroundJobEvent>,
    state: Arc<Mutex<BackgroundProjectionState>>,
    followups: Arc<BackgroundFollowupState>,
    outbound_tx: mpsc::Sender<Value>,
    cancel: CancellationToken,
) {
    let mut idle_tick = tokio::time::interval(std::time::Duration::from_millis(500));
    idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = idle_tick.tick() => {
                // Emergency drain for the boundary window: a terminal event can
                // arrive while a turn is active but after the turn loop's last
                // drain. While a turn is active the turn loop owns the claim;
                // when idle, flush and reconcile so the event cannot wait for
                // an unrelated broadcast to appear.
                if engine.turn_driver_active() {
                    continue;
                }
                let events = engine.flush_background_jobs_with_hooks().await;
                if project_flushed_background_events(&engine, &state, &outbound_tx, events)
                    .await
                    .is_err()
                {
                    break;
                }
                match reconcile_background_jobs(&engine, &state, &outbound_tx).await {
                    Ok(recovered_followups) => {
                        queue_recovered_background_followups(
                            &engine,
                            &followups,
                            recovered_followups,
                            |id| engine.background_job_triggers_followup(id),
                        )
                        .await;
                    }
                    Err(_) => break,
                }
            }
            received = receiver.recv() => {
                match received {
                    Ok(event) => {
                        let terminal_summary = background_terminal_summary(&event)
                            .map(|(id, summary)| (event.identity().map(|identity| serde_json::to_string(&identity.run).expect("run identity serializes")).unwrap_or_else(|| id.to_string()), summary));
                        // Flush first on terminal delivery so hook events retain their engine order;
                        // terminal deduplication makes the following broadcast projection harmless.
                        if matches!(event.payload(), BackgroundJobEvent::Completed { .. }
                            | BackgroundJobEvent::Failed { .. }
                            | BackgroundJobEvent::Halted { .. }
                            | BackgroundJobEvent::Cancelled { .. })
                            && !engine.turn_driver_active()
                        {
                            let events = engine.flush_background_jobs_with_hooks().await;
                            if project_flushed_background_events(&engine, &state, &outbound_tx, events).await.is_err() {
                                break;
                            }
                        }
                        if project_managed_background_event(&engine, &state, &outbound_tx, event.into()).await.is_err() {
                            break;
                        }
                        if let Some((id, summary)) = terminal_summary
                            && followup_key_is_eligible(&engine, &id)
                            && !engine.turn_driver_active()
                        {
                            let run_started_at_ms = engine
                                .state
                                .task(&id)
                                .and_then(|task| task.run_started_at_ms);
                            queue_background_followup_once(
                                &followups,
                                id,
                                run_started_at_ms,
                                summary,
                                true,
                            )
                            .await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "app-server background event pump lagged");
                        let events = engine.flush_background_jobs_with_hooks().await;
                        if project_flushed_background_events(&engine, &state, &outbound_tx, events).await.is_err() {
                            break;
                        }
                        match reconcile_background_jobs(&engine, &state, &outbound_tx).await {
                            Ok(recovered_followups) => {
                                queue_recovered_background_followups(
                                    &engine,
                                    &followups,
                                    recovered_followups,
                                    |id| engine.background_job_triggers_followup(id),
                                )
                                .await;
                            }
                            Err(_) => break,
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

impl BackgroundEventPump {
    fn spawn(
        engine: &QueryEngine,
        state: Arc<Mutex<BackgroundProjectionState>>,
        followups: Arc<BackgroundFollowupState>,
        outbound_tx: mpsc::Sender<Value>,
    ) -> Self {
        let cancel = CancellationToken::new();
        let receiver = engine.subscribe_background_jobs();
        let handle = tokio::spawn(run_background_event_pump(
            engine.clone(),
            receiver,
            state,
            followups,
            outbound_tx,
            cancel.clone(),
        ));
        Self { cancel, handle }
    }

    async fn stop(mut self) {
        self.cancel.cancel();
        if tokio::time::timeout(BACKGROUND_PUMP_SHUTDOWN_TIMEOUT, &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = self.handle.await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_background_followup_turn(
    engine: QueryEngine,
    summary: String,
    followup_runs: Vec<kcoder_types::BackgroundRunKey>,
    goal_turn: goal_lifecycle::GoalTurn,
    outbound_tx: mpsc::Sender<Value>,
    running: Arc<AtomicBool>,
    thread_id: String,
    turn_id: String,
    server_id: String,
    sequence: Arc<AtomicU64>,
    projection: Arc<Mutex<StreamProjection>>,
    background_projection: Arc<Mutex<BackgroundProjectionState>>,
    followups: Arc<BackgroundFollowupState>,
    question_context: Arc<StdMutex<Option<QuestionContext>>>,
    pending_questions: PendingQuestionResponses,
    approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
    pending_approvals: PendingApprovalResponses,
    permission_prompt: AppServerPermissionPrompt,
    cancel: CancellationToken,
) {
    let is_goal_continuation = summary.starts_with("[system] Continue working toward the active");
    if is_goal_continuation {
        goal_lifecycle::publish_continuation(
            &engine,
            &outbound_tx,
            "started",
            Some(&turn_id),
            None,
        )
        .await;
    }
    let turn_permissions =
        turn_permissions::TurnPermissions::new(engine.clone(), goal_turn.permission_mode);
    let _ = send(
        &outbound_tx,
        notification(
            "turn/started",
            with_event_context(
                &server_id,
                &thread_id,
                Some(&turn_id),
                &sequence,
                json!({"turn": {
                    "id": turn_id,
                    "threadId": thread_id,
                    "status": "running",
                    "internal": true,
                }}),
            ),
        ),
    )
    .await;

    let (hook_events, stop_followup) = if is_goal_continuation {
        (Vec::new(), false)
    } else {
        engine
            .run_teammate_idle_hooks(
                "subagent_followup",
                json!({
                    "reason": "subagent_followup",
                    "summary": summary,
                    "cwd": engine.state.cwd(),
                }),
            )
            .await
    };
    let mut status = "completed";
    let mut terminal_error = None;
    let mut provider_failure = None;
    for event in hook_events {
        let messages = if background_event_id(&event).is_some() {
            if project_managed_background_event(
                &engine,
                &background_projection,
                &outbound_tx,
                event,
            )
            .await
            .is_err()
            {
                cancel.cancel();
            }
            Vec::new()
        } else {
            projection.lock().await.project(event)
        };
        for message in messages {
            if send(&outbound_tx, message).await.is_err() {
                cancel.cancel();
                break;
            }
        }
    }

    if !stop_followup && !cancel.is_cancelled() {
        let nudge = if summary.starts_with("[system] Orchestrate durable plan continuation.")
            || summary.starts_with("[scheduled task ")
            || is_goal_continuation
        {
            summary.clone()
        } else {
            background_followup_nudge(&summary)
        };
        let committed = if followup_runs.is_empty() {
            append_background_followup_message(
                &engine,
                &followups,
                nudge,
                if summary.starts_with("[scheduled task ") {
                    kcoder_types::MessageOrigin::User
                } else {
                    kcoder_types::MessageOrigin::Runtime
                },
            )
        } else {
            match engine
                .state
                .commit_message_with_uuid(kcoder_types::Message::runtime_text(nudge), &turn_id)
                .await
            {
                Ok(()) => engine
                    .state
                    .mark_background_followup_started(&followup_runs, &turn_id)
                    .and_then(|started| {
                        anyhow::ensure!(started, "background followup start rejected");
                        Ok(())
                    }),
                Err(error) => Err(error),
            }
        };
        if let Err(error) = committed {
            status = "failed";
            terminal_error = Some(error.to_string());
        } else {
            let mut stream = engine.run_turn_stream(&permission_prompt);
            while let Some(event) = stream.next().await {
                if let Some((next_status, error)) = terminal_outcome(&event, cancel.is_cancelled())
                {
                    status = next_status;
                    terminal_error = Some(error);
                    provider_failure = match &event {
                        EngineEvent::ProviderFailed { details, .. } => Some(details.clone()),
                        _ => None,
                    };
                    if let Err(error) = save_turn_outcome(
                        &engine,
                        &thread_id,
                        &turn_id,
                        status,
                        terminal_error.as_deref(),
                        provider_failure.as_ref(),
                    ) {
                        tracing::warn!(%error, "failed to persist background terminal outcome");
                    }
                }
                if let EngineEvent::ToolUseStarted { id, name, .. } = &event
                    && tool_can_spawn_managed_background_job(name)
                {
                    register_background_tool_call(
                        &background_projection,
                        id,
                        &thread_id,
                        &turn_id,
                        Arc::clone(&projection),
                    )
                    .await;
                }
                let messages = if background_event_id(&event).is_some() {
                    if project_managed_background_event(
                        &engine,
                        &background_projection,
                        &outbound_tx,
                        event,
                    )
                    .await
                    .is_err()
                    {
                        cancel.cancel();
                    }
                    Vec::new()
                } else {
                    projection.lock().await.project(event)
                };
                for message in messages {
                    if send(&outbound_tx, message).await.is_err() {
                        cancel.cancel();
                        break;
                    }
                }
                if status != "completed" || cancel.is_cancelled() {
                    break;
                }
            }
        }
    }
    if cancel.is_cancelled() {
        status = "interrupted";
        terminal_error = Some("cancelled by user".into());
        provider_failure = None;
        if let Err(error) = save_turn_outcome(
            &engine,
            &thread_id,
            &turn_id,
            status,
            terminal_error.as_deref(),
            None,
        ) {
            tracing::warn!(%error, "failed to persist cancelled background outcome");
        }
    }
    if status == "completed" && !followup_runs.is_empty() {
        if let Err(error) = engine.state.flush_history().await.and_then(|()| {
            engine
                .state
                .finish_background_followup(&followup_runs, &turn_id)
        }) {
            tracing::warn!(%error, %turn_id, "background followup completion receipt remains uncertain");
        }
    }
    let publish_goal = goal_turn.tracks_goal() || engine.state.goal().is_some();
    followups.goals.lock().unwrap().finish(
        &engine,
        goal_turn,
        if stop_followup { "failed" } else { status },
        provider_failure.as_ref(),
    );
    drop(turn_permissions);
    if publish_goal {
        goal_lifecycle::publish(&engine, &outbound_tx).await;
    }
    if is_goal_continuation {
        goal_lifecycle::publish_continuation(
            &engine,
            &outbound_tx,
            "settled",
            Some(&turn_id),
            None,
        )
        .await;
    }
    if let Err(error) = engine.record_orchestrate_continuation_outcome(status != "completed") {
        tracing::warn!(%error, turn_id = %turn_id, "failed to persist Orchestrate continuation outcome");
        if terminal_error.is_none() {
            terminal_error = Some(error.to_string());
            status = "failed";
        }
    }
    if let Err(error) = engine.state.flush_history().await {
        tracing::warn!(%error, turn_id = %turn_id, "failed to flush automatic subagent follow-up transcript");
    }
    pending_questions
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    pending_approvals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
    {
        let mut context = question_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if context
            .as_ref()
            .is_some_and(|context| context.thread_id == thread_id && context.turn_id == turn_id)
        {
            *context = None;
        }
    }
    {
        let mut context = approval_context
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if context
            .as_ref()
            .is_some_and(|context| context.thread_id == thread_id && context.turn_id == turn_id)
        {
            *context = None;
        }
    }
    let _ = send(
        &outbound_tx,
        notification(
            "turn/completed",
            with_event_context(
                &server_id,
                &thread_id,
                Some(&turn_id),
                &sequence,
                json!({
                    "turn": {
                        "id": turn_id,
                        "threadId": thread_id,
                        "status": status,
                        "internal": true,
                    },
                    "error": turn_completion_error(terminal_error, provider_failure),
                    "fileChanges": Value::Null,
                }),
            ),
        ),
    )
    .await;
    clear_active_background_projection(&background_projection, &thread_id, &turn_id).await;
    running.store(false, Ordering::SeqCst);
    followups.notify.notify_waiters();
}

fn append_background_followup_message(
    engine: &QueryEngine,
    followups: &BackgroundFollowupState,
    text: String,
    origin: kcoder_types::MessageOrigin,
) -> Result<()> {
    let message = kcoder_types::Message::user_text(text).with_origin(origin);
    if kcoder_engine::agent::is_real_user_message(&message) {
        followups.client_turn_count.increment()?;
    }
    engine.state.add_message(message);
    Ok(())
}

fn reconstruct_client_turn_count(engine: &QueryEngine) -> Result<usize> {
    match engine.state.history_path() {
        Some(path) => kcoder_state::load_transcript_history(&path)
            .map(|entries| client_transcript_turn_count(&entries))
            .context("failed to reconstruct resident turn count"),
        None => Ok(engine.client_turn_count()),
    }
}

fn explicit_turn_appended_user_message(
    engine: &QueryEngine,
    event: &EngineEvent,
    moa_plan_baseline: Option<usize>,
) -> bool {
    if let Some(baseline) = moa_plan_baseline {
        // MoA planning appends directly and does not compact the parent conversation.
        // Its first progress/error/result event follows the append, if one occurred.
        return engine.client_turn_count() > baseline;
    }
    matches!(event, EngineEvent::UserMessageAdded)
        && engine
            .state
            .last_message()
            .as_ref()
            .is_some_and(kcoder_engine::agent::is_real_user_message)
}

fn update_client_turn_count_after_rewind(
    engine: &QueryEngine,
    followups: &BackgroundFollowupState,
    conversation: Option<kcoder_state::ConversationRewindOutcome>,
) -> Result<()> {
    let Some(conversation) = conversation else {
        return Ok(());
    };
    // A file-only rewind or a missing durable anchor cannot lower the transcript watermark.
    if engine.state.history_path().is_some() && !conversation.boundary_recorded {
        return Ok(());
    }
    followups.client_turn_count.invalidate();
    let count = reconstruct_client_turn_count(engine)?;
    followups.client_turn_count.reset(count);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_background_followup_scheduler(
    engine: QueryEngine,
    followups: Arc<BackgroundFollowupState>,
    activity_gate: Arc<Mutex<()>>,
    accepting_turns: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    active_turn: Arc<Mutex<Option<ActiveTurn>>>,
    background_projection: Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: mpsc::Sender<Value>,
    server_id: String,
    sequence: Arc<AtomicU64>,
    next_turn_id: Arc<AtomicU64>,
    question_context: Arc<StdMutex<Option<QuestionContext>>>,
    pending_questions: PendingQuestionResponses,
    approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
    pending_approvals: PendingApprovalResponses,
    permission_prompt: AppServerPermissionPrompt,
    cancel: CancellationToken,
) {
    loop {
        let notified = followups.notify.notified();
        let mut spawned = false;
        {
            // Share the latch with explicit turn/start and thread switching so only one claimant can acquire idle state.
            let _gate = tokio::select! {
                _ = cancel.cancelled() => break,
                gate = activity_gate.lock() => gate,
            };
            let has_pending_followup = !followups.queue.lock().await.pending.is_empty();
            let has_goal_work = followups.goals.lock().unwrap().ready(&engine);
            let orchestrate_store =
                kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
            let has_orchestrate_work = engine.state.session_mode().is_orchestrate()
                && orchestrate_store.read_active_work().is_ok_and(|snapshot| {
                    let cooldown = engine
                        .settings
                        .read()
                        .unwrap()
                        .orchestrate
                        .continuation
                        .cooldown_seconds;
                    let continuation = orchestrate_store
                        .read_continuation_state(&snapshot.work.work_id)
                        .unwrap_or_default();
                    snapshot.work.progress.completed < snapshot.work.progress.total
                        && !continuation.manual_intervention_required
                        && chrono::Utc::now()
                            .signed_duration_since(
                                continuation
                                    .last_claimed_at
                                    .unwrap_or(snapshot.work.updated_at),
                            )
                            .num_seconds()
                            >= cooldown as i64
                });
            if accepting_turns.load(Ordering::SeqCst)
                && !running.load(Ordering::SeqCst)
                && followups.client_turn_count.get().is_some()
                && !followups.goals.lock().unwrap().is_suspended()
                && !has_running_background_followups(&engine)
                && (has_pending_followup || has_orchestrate_work || has_goal_work)
                && running
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_ok()
            {
                if !accepting_turns.load(Ordering::SeqCst) {
                    running.store(false, Ordering::SeqCst);
                    continue;
                }
                let allowed = followups.goals.lock().unwrap().automatic_allowed(&engine);
                if !allowed {
                    let notice = followups.goals.lock().unwrap().take_limit_notice(&engine);
                    if let Some(notice) = notice {
                        goal_lifecycle::publish_continuation(
                            &engine,
                            &outbound_tx,
                            "settled",
                            None,
                            Some(notice.clone()),
                        )
                        .await;
                        let mut projection = StreamProjection::new(
                            server_id.clone(),
                            engine.session_id(),
                            "goal-status".into(),
                            Arc::clone(&sequence),
                        );
                        for event in projection.project(EngineEvent::SystemNotice(notice)) {
                            let _ = send(&outbound_tx, event).await;
                        }
                    }
                    running.store(false, Ordering::SeqCst);
                    // Wait for a real state change, not a busy loop at the limit.
                } else {
                    // `take_ready_background_followup` drops queued entries whose
                    // agent was closed, so the queue can be empty even though
                    // `has_pending_followup` was true when it was computed. Fall
                    // through to the orchestrate/goal continuations instead of
                    // panicking on the now-empty queue.
                    let pending_summary = if has_pending_followup {
                        take_ready_background_followup_batch(
                            &followups,
                            false,
                            Some(&engine),
                            |id| followup_key_is_eligible(&engine, id),
                        )
                        .await
                    } else {
                        None
                    };
                    let followup_runs = pending_summary
                        .as_ref()
                        .map(|(_, keys)| keys.clone())
                        .unwrap_or_default();
                    let summary = if let Some((summary, _)) = pending_summary {
                        summary
                    } else if has_orchestrate_work {
                        match engine.claim_orchestrate_idle_continuation(
                        kcoder_engine::orchestrate::continuation::IdleRequest {
                            cooldown_elapsed: true,
                            ..Default::default()
                        },
                    ) {
                        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued { prompt }) => prompt,
                        Ok(_) => {
                            running.store(false, Ordering::SeqCst);
                            drop(_gate);
                            tokio::select! {
                                _ = cancel.cancelled() => break,
                                _ = tokio::time::sleep(goal_lifecycle::COOLDOWN) => {}
                            }
                            continue;
                        }
                        Err(error) => {
                            tracing::warn!(%error, "app-server Orchestrate continuation failed");
                            running.store(false, Ordering::SeqCst);
                            drop(_gate);
                            tokio::select! {
                                _ = cancel.cancelled() => break,
                                _ = tokio::time::sleep(goal_lifecycle::COOLDOWN) => {}
                            }
                            continue;
                        }
                    }
                    } else {
                        match goal_lifecycle::GoalLifecycle::prompt(&engine) {
                            Some(prompt) => prompt,
                            None => {
                                running.store(false, Ordering::SeqCst);
                                continue;
                            }
                        }
                    };
                    let thread_id = engine.session_id();
                    let turn_sequence = next_turn_id.fetch_add(1, Ordering::SeqCst);
                    let turn_id = if let Some(first) = followup_runs.first() {
                        engine
                            .state
                            .background_run_record(first)
                            .and_then(|record| record.followup_turn_id)
                            .unwrap_or_else(|| format!("background-followup-{}", first.run_id))
                    } else if summary.starts_with("[scheduled task ")
                        || summary.starts_with("[system] Continue working toward the active")
                    {
                        // A resumed recurring task must not reuse a prior run's projection id.
                        let nonce = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_nanos();
                        let kind = if summary.starts_with("[scheduled task ") {
                            "cron"
                        } else {
                            "goal"
                        };
                        format!(
                            "background-followup-{kind}-{}-{nonce}-{turn_sequence}",
                            std::process::id()
                        )
                    } else {
                        format!("background-followup-{turn_sequence}")
                    };
                    if !followup_runs.is_empty() {
                        match engine
                            .state
                            .reserve_background_followup(&followup_runs, &turn_id)
                        {
                            Ok(true) => {}
                            result => {
                                tracing::warn!(
                                    ?result,
                                    "background followup reservation was not committed"
                                );
                                let mut queue = followups.queue.lock().await;
                                for key in &followup_runs {
                                    let value = serde_json::to_string(key)
                                        .expect("run identity serializes");
                                    queue.claimed_terminal_ids.remove(&(value, None));
                                }
                                running.store(false, Ordering::SeqCst);
                                continue;
                            }
                        }
                    }
                    let projection = Arc::new(Mutex::new(StreamProjection::new(
                        server_id.clone(),
                        thread_id.clone(),
                        turn_id.clone(),
                        Arc::clone(&sequence),
                    )));
                    set_active_background_projection(
                        &background_projection,
                        &thread_id,
                        &turn_id,
                        Arc::clone(&projection),
                    )
                    .await;
                    *question_context
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(QuestionContext {
                        server_id: server_id.clone(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    });
                    *approval_context
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ApprovalContext {
                        server_id: server_id.clone(),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    });
                    let turn_cancel = CancellationToken::new();
                    let turn_engine = engine.clone().with_cancel_token(turn_cancel.clone());
                    let goal_turn = followups.goals.lock().unwrap().begin(
                        &engine,
                        None,
                        Some(turn_cancel.clone()),
                    );
                    let summary =
                        if summary.starts_with("[system] Continue working toward the active") {
                            goal_lifecycle::GoalLifecycle::prompt(&engine).unwrap_or(summary)
                        } else {
                            summary
                        };
                    let mut automatic_permission_prompt = permission_prompt.clone();
                    if let Some(mode) = goal_turn.permission_mode {
                        automatic_permission_prompt.mode = mode;
                    }
                    let handle = tokio::spawn(run_background_followup_turn(
                        turn_engine,
                        summary,
                        followup_runs,
                        goal_turn,
                        outbound_tx.clone(),
                        Arc::clone(&running),
                        thread_id.clone(),
                        turn_id.clone(),
                        server_id.clone(),
                        Arc::clone(&sequence),
                        projection,
                        Arc::clone(&background_projection),
                        Arc::clone(&followups),
                        Arc::clone(&question_context),
                        Arc::clone(&pending_questions),
                        Arc::clone(&approval_context),
                        Arc::clone(&pending_approvals),
                        automatic_permission_prompt,
                        turn_cancel.clone(),
                    ));
                    *active_turn.lock().await = Some(ActiveTurn {
                        handle,
                        cancel: turn_cancel,
                        thread_id,
                        turn_id,
                    });
                    spawned = true;
                }
            }
        }
        if spawned {
            continue;
        }
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = notified => {}
            _ = tokio::time::sleep(goal_lifecycle::COOLDOWN), if followups.goals.lock().unwrap().pending() => {}
            _ = tokio::time::sleep(Duration::from_secs(
                engine.settings.read().unwrap().orchestrate.continuation.cooldown_seconds.max(1)
            )), if engine.state.session_mode().is_orchestrate() => {}
        }
    }
}

impl BackgroundFollowupScheduler {
    #[cfg(test)]
    fn disabled_for_test() -> Self {
        let cancel = CancellationToken::new();
        let child_cancel = cancel.clone();
        let handle = tokio::spawn(async move {
            child_cancel.cancelled().await;
        });
        Self { cancel, handle }
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        engine: &QueryEngine,
        followups: Arc<BackgroundFollowupState>,
        activity_gate: Arc<Mutex<()>>,
        accepting_turns: Arc<AtomicBool>,
        running: Arc<AtomicBool>,
        active_turn: Arc<Mutex<Option<ActiveTurn>>>,
        background_projection: Arc<Mutex<BackgroundProjectionState>>,
        outbound_tx: mpsc::Sender<Value>,
        server_id: String,
        sequence: Arc<AtomicU64>,
        question_context: Arc<StdMutex<Option<QuestionContext>>>,
        pending_questions: PendingQuestionResponses,
        approval_context: Arc<StdMutex<Option<ApprovalContext>>>,
        pending_approvals: PendingApprovalResponses,
        permission_prompt: AppServerPermissionPrompt,
    ) -> Self {
        let cancel = CancellationToken::new();
        let handle = tokio::spawn(run_background_followup_scheduler(
            engine.clone(),
            followups,
            activity_gate,
            accepting_turns,
            running,
            active_turn,
            background_projection,
            outbound_tx,
            server_id,
            sequence,
            Arc::new(AtomicU64::new(1)),
            question_context,
            pending_questions,
            approval_context,
            pending_approvals,
            permission_prompt,
            cancel.clone(),
        ));
        Self { cancel, handle }
    }

    async fn stop(mut self) {
        self.cancel.cancel();
        if tokio::time::timeout(BACKGROUND_PUMP_SHUTDOWN_TIMEOUT, &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = self.handle.await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn build_resident_thread_runtime(
    engine: QueryEngine,
    lease: SessionLease,
    volatile_turn_count: usize,
    turn_state: ResidentTurnState,
    outbound_tx: mpsc::Sender<Value>,
    server_id: String,
    sequence: Arc<AtomicU64>,
) -> ThreadRuntime {
    let background_projection = Arc::new(Mutex::new(BackgroundProjectionState::default()));
    let background_followups = Arc::new(BackgroundFollowupState::default());
    background_followups
        .client_turn_count
        .reset(volatile_turn_count);
    let background_pump = BackgroundEventPump::spawn(
        &engine,
        Arc::clone(&background_projection),
        Arc::clone(&background_followups),
        outbound_tx.clone(),
    );
    let background_followup_scheduler = BackgroundFollowupScheduler::spawn(
        &engine,
        Arc::clone(&background_followups),
        Arc::clone(&turn_state.activity_gate),
        Arc::clone(&turn_state.accepting_turns),
        Arc::clone(&turn_state.running),
        Arc::clone(&turn_state.active_turn),
        Arc::clone(&background_projection),
        outbound_tx,
        server_id,
        sequence,
        Arc::clone(&turn_state.question_context),
        Arc::clone(&turn_state.pending_questions),
        Arc::clone(&turn_state.approval_context),
        Arc::clone(&turn_state.pending_approvals),
        turn_state.permission_prompt.clone(),
    );
    ThreadRuntime::new(
        engine,
        lease,
        background_projection,
        background_followups,
        (background_pump, background_followup_scheduler),
        turn_state,
    )
}

impl ConnectionState {
    fn configure_turn_engine(
        &self,
        engine: &QueryEngine,
        cancel: CancellationToken,
    ) -> QueryEngine {
        engine
            .clone()
            .with_cancel_token(cancel)
            .with_tool_path_previews(self.tool_path_preview_v1)
    }

    fn require_initialized(&self, id: Value) -> Option<Value> {
        (!self.initialized).then(|| error_response(id, NOT_INITIALIZED, "Not initialized"))
    }

    fn initialize(&mut self, id: Value, params: &Value, engine: &QueryEngine) -> Value {
        if self.initialized {
            return error_response(id, -32600, "Already initialized");
        }
        let params = match serde_json::from_value::<InitializeParams>(params.clone()) {
            Ok(params) => params,
            Err(error) => return error_response(id, -32602, &error.to_string()),
        };
        if params.protocol_version != PROTOCOL_VERSION {
            return error_response(
                id,
                -32602,
                &format!(
                    "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                    params.protocol_version
                ),
            );
        }
        let mut capabilities = server_capabilities(engine.state.history_path().is_some());
        capabilities.experimental.insert(kcoder_app_protocol::CAPABILITY_TOOL_PROFILES_V1.into(), self.tool_profiles_v1);
        capabilities.experimental.insert("modelSelectionModeV1".into(), engine.supports_target_default_model_selection());
        capabilities.experimental.insert(kcoder_app_protocol::CAPABILITY_RETRY_MODEL_CONFIGURATION_V1.into(), engine.supports_target_default_model_selection());
        let result = InitializeResult {
            protocol_version: PROTOCOL_VERSION.to_string(),
            server_info: ImplementationInfo {
                name: "kcoder-app-server".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            capabilities,
            session_id: Some(engine.session_id()),
            cwd: Some(engine.state.cwd().to_string_lossy().into_owned()),
            model: Some(engine.client_model_selector()),
        };
        self.tool_path_preview_v1 = params
            .capabilities
            .experimental
            .get("toolPathPreviewV1")
            .copied()
            .unwrap_or(false);
        self.run_summary_v1 = params
            .capabilities
            .experimental
            .get(kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1)
            .copied()
            .unwrap_or(false);
        self.interaction_binding_v1 = params
            .capabilities
            .experimental
            .get(kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1)
            .copied()
            .unwrap_or(false);
        self.initialized = true;
        success_response(
            id,
            serde_json::to_value(result).expect("initialize result serializes"),
        )
    }
}

fn server_capabilities(thread_resume: bool) -> ServerCapabilities {
    ServerCapabilities {
        approvals: true,
        questions: true,
        thread_resume,
        experimental: BTreeMap::from([
            ("toolPathPreviewV1".to_string(), true),
            (kcoder_app_protocol::CAPABILITY_WORKFLOW_CANVAS_V1.to_string(), true),
            (kcoder_app_protocol::CAPABILITY_GOAL_CANCELLATION_V1.to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_THREAD_RUN_SUMMARY_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_INTERACTION_BINDING_V1.to_string(),
                true,
            ),
            // The client declares this one, but it is answered here as well: a
            // client reads the negotiated set before it decides whether it may
            // send `resubmit`, and an unanswered declaration looks like a server
            // that would refuse the field.
            (
                kcoder_app_protocol::CAPABILITY_TURN_SUBMISSION_V1.to_string(),
                true,
            ),
            ("toolsCatalog".to_string(), true),
            ("settingsTemplatesV1".to_string(), true),
            ("storageDiagnosticsV1".to_string(), true),
            ("browserAttachments".to_string(), true),
            ("browserPreflight".to_string(), true),
            ("ephemeralThreads".to_string(), true),
            (
                "browserSessions".to_string(),
                browser::browser_sessions_available(),
            ),
            ("terminalSessions".to_string(), true),
            ("workspaceFiles".to_string(), true),
            ("workspaceRegistry".to_string(), true),
            ("sidebarRootPinning".to_string(), true),
            ("residentThreads".to_string(), true),
            (
                kcoder_app_protocol::CAPABILITY_FAILED_TURN_CONTINUATION_V1.to_string(),
                true,
            ),
            (
                kcoder_app_protocol::CAPABILITY_TURN_RETRY_OPERATION_V1.to_string(),
                true,
            ),
            (kcoder_app_protocol::CAPABILITY_TURN_ATTEMPT_RETRY_V1.to_string(), true),
            (kcoder_app_protocol::CAPABILITY_THREAD_CREATION_RECEIPTS_V1.to_string(), thread_resume),
            (kcoder_app_protocol::CAPABILITY_TURN_RECEIPTS_V1.to_string(), true),
            ("threadListCompleteness".to_string(), true),
            ("threadHistoryIndexRefresh".to_string(), true),
            ("threadIndexedPagesV1".to_string(), true),
            ("serverResourceSnapshotV1".to_string(), true),
            ("serverIdleShutdownV1".to_string(), true),
            ("goalContinuation".to_string(), true),
            ("sessionModes".to_string(), true),
            ("agentSteering".to_string(), true),
            ("plugins".to_string(), true),
            ("providerConfiguration".to_string(), true),
            ("providerConnectionValidation".to_string(), true),
            ("providerTemplates".to_string(), true),
            ("providerAuthenticationPolicy".to_string(), true),
            ("providerModelCapabilities".to_string(), true),
            ("qualifiedModelSelectionV1".to_string(), true),
            ("providerDeletion".to_string(), true),
            ("marketplaces".to_string(), true),
            ("pluginDownloadProxy".to_string(), true),
            ("marketplaceDirectoryTrust".to_string(), true),
            (kcoder_app_protocol::HOOK_CONFIGURATION_CAPABILITY.to_string(), true),
            ("pluginTrustManagement".to_string(), true),
            ("pluginInstallCancellation".to_string(), true),
            ("backgroundRunIdentityV1".to_string(), true),
            ("pluginIcons".to_string(), true),
            ("marketplaceGitRefresh".to_string(), true),
            ("turnPermissions".to_string(), true),
            ("scheduledTasks".to_string(), true),
            ("projectAutomations".to_string(), true),
            (kcoder_app_protocol::CAPABILITY_CRON_TIMEZONE_V1.to_string(), true),
            (kcoder_app_protocol::CAPABILITY_CRON_PREVIEW_V1.to_string(), true),
            (kcoder_app_protocol::CAPABILITY_CRON_DELIVERY_DIAGNOSTICS_V1.to_string(), true),
            (kcoder_app_protocol::CAPABILITY_STORAGE_SCAN_CANCELLATION_V1.to_string(), true),
            ("agentArtifactsV1".to_string(), true),
            ("usageHistory".to_string(), true),
        ]),
    }
}

fn agent_steer_result_from_receipt(
    client_message_id: Option<String>,
    receipt: kcoder_tools::SubagentSteerReceipt,
) -> AgentSteerResult {
    let status = match receipt.status {
        kcoder_tools::SubagentSteerStatus::QueuedLive => AgentSteerStatus::QueuedLive,
        kcoder_tools::SubagentSteerStatus::QueuedPaused => AgentSteerStatus::QueuedPaused,
        kcoder_tools::SubagentSteerStatus::QueuedBehindBlocked => {
            AgentSteerStatus::QueuedBehindBlocked
        }
        kcoder_tools::SubagentSteerStatus::Resuming => AgentSteerStatus::Resuming,
        kcoder_tools::SubagentSteerStatus::Finishing => AgentSteerStatus::Finishing,
        kcoder_tools::SubagentSteerStatus::Cancelled => AgentSteerStatus::Cancelled,
        kcoder_tools::SubagentSteerStatus::Closed => AgentSteerStatus::Closed,
        kcoder_tools::SubagentSteerStatus::Rejected => AgentSteerStatus::Rejected,
    };
    AgentSteerResult {
        agent_id: receipt.agent_id,
        message_id: receipt.message_id,
        status,
        queued: receipt.queued,
        queue_position: receipt.queue_position,
        reason_code: receipt.reason_code,
        client_message_id,
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

/// Serialize one outbound frame under the gateway's line-delimited limit.
///
/// The Studio gateway rejects app-server frames larger than 2 MiB and (before
/// the broker resilience fix) tore down every client of the workspace. Keep
/// responses attributable by degrading them to a structured error with the
/// same id; oversized notifications are unrecoverable and are dropped.
fn bounded_outbound_frame(message: Value, limit: usize) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(&message).ok()?;
    if bytes.len() <= limit {
        return Some(bytes);
    }
    if let Some(id) = message.get("id").cloned().filter(|value| !value.is_null()) {
        tracing::warn!(
            bytes = bytes.len(),
            limit,
            "outbound app-server frame exceeded the transport limit"
        );
        let replacement = error_response(
            id,
            OUTBOUND_FRAME_LIMIT_CODE,
            "app-server response exceeds the transport frame limit",
        );
        return serde_json::to_vec(&replacement).ok();
    }
    tracing::warn!(
        bytes = bytes.len(),
        limit,
        method = message
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown"),
        "dropping oversized outbound app-server notification"
    );
    None
}

fn turn_file_changes_review_payload(diff: String, limit: usize) -> Value {
    // `truncate_utf8_bytes` 的第三个返回值是字符数（original_chars），字节数必须
    // 在这里自行计算，否则非 ASCII diff 的 diffOriginalBytes 会误报。
    let diff_original_bytes = diff.len();
    let (diff, diff_truncated, _) = truncate_utf8_bytes(diff, limit);
    json!({
        "success": true,
        "diff": diff,
        "diffTruncated": diff_truncated,
        "diffOriginalBytes": diff_original_bytes,
    })
}

pub async fn run(
    mut engine: QueryEngine,
    engine_factory: AppServerEngineFactory,
    permission_mode: kcoder_config::PermissionMode,
) -> Result<()> {
    let workspace_engine = engine.clone();
    let provider_settings_state =
        provider_settings::capture_state(&workspace_engine).map(|state| {
            state
                .with_session_reload(engine_factory.supports_session_reload())
                .with_turn_model_reload(engine_factory.supports_turn_model_reload())
        });
    tokio::task::spawn_blocking(|| {
        if let Err(error) = scavenge_stale_attachment_directories(
            &std::env::temp_dir(),
            SystemTime::now(),
            ATTACHMENT_TTL,
        ) {
            tracing::warn!(%error, "failed to scavenge stale browser attachments");
        }
    });
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Value>(OUTBOUND_CAPACITY);
    let next_question_id = Arc::new(AtomicU64::new(1_000_000));
    let next_approval_id = Arc::new(AtomicU64::new(2_000_000));
    // Replies to an already resolved interaction are answered from here, so a
    // repeated reply is never delivered twice and never applied to a new turn.
    let connection_receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
    let mut writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = outbound_rx.recv().await {
            let Some(mut bytes) = bounded_outbound_frame(message, OUTBOUND_FRAME_LIMIT_BYTES)
            else {
                continue;
            };
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });

    let resident_thread_limit = std::env::var("KCODER_APP_SERVER_RESIDENT_THREAD_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=1024).contains(value))
        .unwrap_or(thread_runtime::DEFAULT_RESIDENT_THREAD_LIMIT);
    let mut thread_manager = ThreadManager::with_resident_limit(resident_thread_limit);
    let next_terminal_id = AtomicU64::new(1);
    let terminals = TerminalRegistry::default();
    let _terminal_guard = TerminalRegistryGuard(terminals.clone());
    let server_id = format!("server-{}", engine.session_id());
    let sequence = Arc::new(AtomicU64::new(1));
    let mut state = ConnectionState {
        tool_profiles_v1: engine_factory.supports_session_reload(),
        ..ConnectionState::default()
    };
    let mut attachment_directories = AttachmentDirectories::default();
    let mut thread_list_snapshots = thread_list_snapshots::ThreadListSnapshots::default();
    let mut history_refresh = history_refresh_processor::HistoryRefreshProcessor::default();
    let mut browsers = BrowserRegistry::new();
    let plugin_settings = engine.settings.read().unwrap().plugins.clone();
    let plugin_processor = PluginProcessor::open(&engine.state.cwd(), plugin_settings)
        .context("failed to initialize app-server plugin processor")?;
    let mcp_authorization = mcp_authorization_processor::McpAuthorizationProcessor::default();
    let mut plugin_tasks = tokio::task::JoinSet::new();
    let mut provider_tasks = tokio::task::JoinSet::new();
    let storage_scans = storage_scans::StorageScans::default();
    let mut indexed_read_tasks = tokio::task::JoinSet::new();
    let mut indexed_read_gates = indexed_read_gate::IndexedReadGate::default();
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut input_state = protocol_io::JsonRpcLineState::default();
    let mut automations = project_automations::ProjectAutomations::new(
        workspace_engine.cron_scheduler(),
        !workspace_engine.settings.read().unwrap().training_mode,
    );
    let mut automation_tick = tokio::time::interval(Duration::from_millis(500));
    let mut automation_requested = false;
    let mut idle_shutdown_requested = false;
    #[cfg(unix)]
    let mut terminate_signal =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .context("failed to install app-server SIGTERM handler")?;
    #[cfg(unix)]
    let mut terminated_by_signal = false;

    loop {
        while let Some(result) = provider_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "provider validation task failed");
            }
        }
        while let Some(result) = indexed_read_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "indexed transcript task failed");
            }
        }
        while let Some(result) = plugin_tasks.try_join_next() {
            if let Err(error) = result {
                tracing::warn!(%error, "app-server plugin request task failed");
            }
        }
        let queued = automations.next_request();
        let automation_fire = queued.as_ref().and_then(|(_, fire)| fire.clone());
        let next_line = if let Some((request, _)) = queued {
            Some(JsonRpcLine::Line(request.to_string()))
        } else {
            #[cfg(unix)]
            let result = tokio::select! {
                result = input_state.read(&mut stdin) => result.context("failed to read app-server stdin")?,
                _ = terminate_signal.recv() => {
                    terminated_by_signal = true;
                    None
                },
                _ = automations.receive() => continue,
                _ = automation_tick.tick() => {
                if state.initialized && automation_requested {
                        automations.activate();
                        automations.queue_if_idle(thread_manager.project_is_idle());
                        if let Some(params) = automations.take_state_change() {
                            send(&outbound_tx, notification(kcoder_app_protocol::method::AUTOMATION_STATE_CHANGED, params)).await?;
                        }
                    }
                    continue;
                },
            };
            #[cfg(not(unix))]
            let result = tokio::select! {
                result = input_state.read(&mut stdin) => result.context("failed to read app-server stdin")?,
                _ = automations.receive() => continue,
                _ = automation_tick.tick() => {
                if state.initialized && automation_requested {
                        automations.activate();
                        automations.queue_if_idle(thread_manager.project_is_idle());
                        if let Some(params) = automations.take_state_change() {
                            send(&outbound_tx, notification(kcoder_app_protocol::method::AUTOMATION_STATE_CHANGED, params)).await?;
                        }
                    }
                    continue;
                },
            };
            result
        };
        let Some(next_line) = next_line else { break };
        let line = match next_line {
            JsonRpcLine::Line(line) => line,
            JsonRpcLine::InvalidUtf8 => {
                send(
                    &outbound_tx,
                    error_response(Value::Null, -32700, "Request is not valid UTF-8"),
                )
                .await?;
                continue;
            }
            JsonRpcLine::TooLarge => {
                send(
                    &outbound_tx,
                    error_response(Value::Null, -32600, "Request is too large"),
                )
                .await?;
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(
                    frame_bytes = line.len(),
                    object_offset = line.find('{'),
                    %error,
                    "invalid app-server JSON-RPC frame"
                );
                send(
                    &outbound_tx,
                    error_response(
                        Value::Null,
                        -32700,
                        &format!(
                            "{error} (frame bytes: {}, object offset: {:?})",
                            line.len(),
                            line.find('{')
                        ),
                    ),
                )
                .await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

        if method.is_empty() && !id.is_null() {
            let mut outcome = InteractionReply::Unmatched;
            for turn_state in thread_manager.turn_states() {
                outcome = turn_state.resolve_response(&request, state.interaction_binding_v1);
                if !matches!(outcome, InteractionReply::Unmatched) {
                    break;
                }
            }
            if matches!(outcome, InteractionReply::Misattributed)
                && let Some(request_id) = id.as_u64()
            {
                // The interaction is still pending: replay its request so the
                // client can answer with the identity the connection requires,
                // and never accept the unattributable decision.
                let request_notification = {
                    let mut receipts = connection_receipts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let request = receipts.outstanding_request(request_id);
                    receipts.note_misattributed();
                    request
                };
                tracing::warn!(
                    request_id,
                    "app-server interaction reply did not name its interaction and was rejected"
                );
                if let Some(notification) = request_notification {
                    send(&outbound_tx, notification).await?;
                }
                continue;
            }
            if matches!(outcome, InteractionReply::Unmatched)
                && let Some(request_id) = id.as_u64()
            {
                let replayed = {
                    let mut receipts = connection_receipts
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    receipts.replay(request_id)
                };
                match replayed {
                    Some(notification) => send(&outbound_tx, notification).await?,
                    None => {
                        connection_receipts
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .note_unmatched();
                        tracing::warn!(
                            request_id,
                            "app-server reply matched no pending interaction and was not applied"
                        );
                    }
                }
            }
            continue;
        }

        if method == "initialize" {
            let response = state.initialize(id, &params, &workspace_engine);
            if state.initialized
                && params["capabilities"]["experimental"]["projectAutomations"] == true
            {
                automation_requested = true;
            }
            send(&outbound_tx, response).await?;
            continue;
        }
        if let Some(response) = state.require_initialized(id.clone()) {
            send(&outbound_tx, response).await?;
            continue;
        }
        if method == method::THREAD_READ_INDEXED {
            if indexed_read_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(
                        id,
                        -32044,
                        "Indexed history read capacity reached; retry later",
                    ),
                )
                .await?;
                continue;
            }
            let params = match serde_json::from_value::<ThreadReadParams>(params) {
                Ok(params) => params,
                Err(_) => {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "invalid indexed transcript params"),
                    )
                    .await?;
                    continue;
                }
            };
            let target = thread_manager
                .engine(&params.thread_id)
                .unwrap_or_else(|| workspace_engine.clone());
            let read_gate = match indexed_read_gates.for_thread(&params.thread_id) {
                Ok(gate) => gate,
                Err(_) => {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "invalid transcript thread"),
                    )
                    .await?;
                    continue;
                }
            };
            let running = thread_manager.running_thread_ids();
            let run_projection = ThreadRunProjection::for_thread(
                &thread_manager,
                state.run_summary_v1,
                &params.thread_id,
            );
            let outbound = outbound_tx.clone();
            indexed_read_tasks.spawn(async move {
                let read_guard = read_gate.lock_owned().await;
                let read = indexed_transcript::read(&target, params, &running, run_projection);
                let response = match read.await {
                    Ok(mut result) => {
                        recent_error::decorate(&target, &mut result.thread, run_projection.negotiated);
                        success_response(id, serde_json::to_value(result).expect("transcript serializes"))
                    },
                    Err(error) => {
                        let message = error.to_string();
                        error_response(
                            id,
                            if message == "TRANSCRIPT_CURSOR_STALE" {
                                -32041
                            } else {
                                -32021
                            },
                            &message,
                        )
                    }
                };
                drop(read_guard);
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send indexed transcript");
                }
            });
            continue;
        }
        if matches!(method, method::SKILL_IMPORT | method::SKILL_REMOVE) {
            if plugin_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(
                        id,
                        -32044,
                        "Extension management capacity reached; retry later",
                    ),
                )
                .await?;
                continue;
            }
            let outbound = outbound_tx.clone();
            let operation = method.to_owned();
            plugin_tasks.spawn(async move {
                let result = if operation == method::SKILL_IMPORT {
                    match serde_json::from_value::<kcoder_app_protocol::SkillImportParams>(params) {
                        Ok(params) => skill_processor::import(params).await,
                        Err(_) => Err(anyhow::anyhow!("Invalid skill import parameters")),
                    }
                } else {
                    match serde_json::from_value::<kcoder_app_protocol::SkillRemoveParams>(params) {
                        Ok(params) => skill_processor::remove(params).await,
                        Err(_) => Err(anyhow::anyhow!("Invalid skill removal parameters")),
                    }
                };
                let response = match result {
                    Ok(result) => success_response(
                        id,
                        serde_json::to_value(result).expect("skill result serializes"),
                    ),
                    Err(error) => error_response(id, -32021, &error.to_string()),
                };
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send skill management response");
                }
            });
            continue;
        }
        if matches!(
            method,
            method::HOOK_CONFIGURATION_READ | method::HOOK_CONFIGURATION_UPDATE
        ) {
            if plugin_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(id, -32044, "Hook management capacity reached; retry later"),
                )
                .await?;
                continue;
            }
            let factory = engine_factory.clone();
            let outbound = outbound_tx.clone();
            let operation = method.to_owned();
            plugin_tasks.spawn(async move {
                let response = hook_configuration::process(factory, id, operation, params).await;
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send Hook configuration response");
                }
            });
            continue;
        }
        if matches!(
            method,
            method::MCP_LIST
                | method::MCP_INSTALL
                | method::MCP_REMOVE
                | method::MCP_LOGOUT
                | method::MCP_LOGIN
                | method::MCP_CALLBACK
                | method::MCP_CANCEL
        ) {
            if plugin_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(id, -32044, "MCP management capacity reached; retry later"),
                )
                .await?;
                continue;
            }
            let factory = engine_factory.clone();
            let outbound = outbound_tx.clone();
            let operation = method.to_owned();
            let authorization = mcp_authorization.clone();
            plugin_tasks.spawn(async move {
                let result = if operation == method::MCP_LIST {
                    mcp_processor::list(factory)
                        .await
                        .and_then(|result| Ok(serde_json::to_value(result)?))
                } else if operation == method::MCP_INSTALL {
                    match serde_json::from_value::<kcoder_app_protocol::McpInstallParams>(params) {
                        Ok(params) => mcp_processor::install(factory, params)
                            .await
                            .and_then(|value| Ok(serde_json::to_value(value)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP installation parameters")),
                    }
                } else if operation == method::MCP_REMOVE {
                    match serde_json::from_value::<kcoder_app_protocol::McpServerParams>(params) {
                        Ok(params) => mcp_processor::remove(factory, params)
                            .await
                            .and_then(|value| Ok(serde_json::to_value(value)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP removal parameters")),
                    }
                } else if operation == method::MCP_LOGIN {
                    match serde_json::from_value::<kcoder_app_protocol::McpLoginParams>(params) {
                        Ok(params) => authorization
                            .login(factory, params)
                            .await
                            .and_then(|value| Ok(serde_json::to_value(value)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP login parameters")),
                    }
                } else if operation == method::MCP_CALLBACK {
                    match serde_json::from_value::<kcoder_app_protocol::McpCallbackParams>(params) {
                        Ok(params) => authorization
                            .callback(factory, params)
                            .await
                            .map(|()| json!({"authorized":true})),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP callback parameters")),
                    }
                } else if operation == method::MCP_CANCEL {
                    match serde_json::from_value::<kcoder_app_protocol::McpCancelParams>(params) {
                        Ok(params) => authorization
                            .cancel(params)
                            .await
                            .map(|()| json!({"cancelled":true})),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP cancellation parameters")),
                    }
                } else {
                    match serde_json::from_value::<kcoder_app_protocol::McpServerParams>(params) {
                        Ok(params) => mcp_processor::logout(factory, params)
                            .await
                            .and_then(|result| Ok(serde_json::to_value(result)?)),
                        Err(_) => Err(anyhow::anyhow!("Invalid MCP server selection")),
                    }
                };
                let response = match result {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32021, &error.to_string()),
                };
                if let Err(error) = send(&outbound, response).await {
                    tracing::warn!(%error, "failed to send MCP management response");
                }
            });
            continue;
        }
        if PluginProcessor::handles(method) {
            let processor = plugin_processor.clone();
            let outbound_tx = outbound_tx.clone();
            let method = method.to_string();
            plugin_tasks.spawn(async move {
                let response = processor.process(id, &method, params).await;
                if let Err(error) = send(&outbound_tx, response).await {
                    tracing::warn!(%error, "failed to send app-server plugin response");
                }
            });
            continue;
        }

        if method == kcoder_app_protocol::method::PROVIDERS_UPSERT {
            if provider_tasks.len() >= 4 {
                send(
                    &outbound_tx,
                    error_response(
                        id,
                        -32034,
                        "[provider_probe_busy] Too many API validations; retry shortly",
                    ),
                )
                .await?;
                continue;
            }
            let Ok(snapshot) = provider_settings_state.as_ref() else {
                send(
                    &outbound_tx,
                    error_response(id, -32602, "Provider configuration snapshot is unavailable"),
                )
                .await?;
                continue;
            };
            let snapshot = snapshot.clone();
            let target = workspace_engine.clone();
            let outbound = outbound_tx.clone();
            provider_tasks.spawn(async move {
                let response = match provider_settings::upsert(target, snapshot, params).await {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32602, &error.to_string()),
                };
                let _ = send(&outbound, response).await;
            });
            continue;
        }

        match method {
            "initialized" => {}
            kcoder_app_protocol::method::USAGE_STATS => {
                let response = usage_processor::process(id, params, &workspace_engine).await;
                send(&outbound_tx, response).await?;
            }
            "cron/list" | "cron/create" | "cron/delete" | method::CRON_PREVIEW => {
                let result = (|| -> Result<_> {
                    let target = if let Some(thread_id) =
                        params.get("threadId").and_then(Value::as_str)
                    {
                        let target = thread_manager
                            .engine(thread_id)
                            .context("thread/start or thread/resume is required")?;
                        ensure_active_thread(&target, thread_manager.lease(thread_id), thread_id)?;
                        target
                    } else {
                        workspace_engine.clone()
                    };
                    cron_processor::process(&target, method, params.clone())
                })();
                if result.is_ok() && method != kcoder_app_protocol::method::CRON_PREVIEW {
                    automation_requested = true;
                }
                let response = match result {
                    Ok(value) => success_response(id, value),
                    Err(error) => error_response(id, -32602, &error.to_string()),
                };
                send(&outbound_tx, response).await?;
            }
            "server/info" => {
                // `engine` caches the most recently selected turn runtime. Once that
                // resident runtime is deleted, connection-level state APIs must not expose the removed thread.
                let info_engine = thread_manager
                    .engine(&engine.session_id())
                    .filter(|resident| !thread_manager.is_ephemeral(&resident.session_id()))
                    .or_else(|| {
                        thread_manager
                            .resident_engines()
                            .into_iter()
                            .find(|resident| !thread_manager.is_ephemeral(&resident.session_id()))
                    });
                let response = match info_engine {
                    Some(info_engine) => success_response(
                        id,
                        thread_snapshot(
                            &info_engine,
                            thread_manager.is_turn_running(&info_engine.session_id()),
                        ),
                    ),
                    None => error_response(id, -32022, "thread/start or thread/resume is required"),
                };
                send(&outbound_tx, response).await?;
            }
            method::SERVER_IDLE_SHUTDOWN => {
                let parsed = serde_json::from_value::<kcoder_app_protocol::ServerIdleShutdownParams>(
                    params.clone(),
                );
                let valid = params.is_object()
                    && parsed.as_ref().is_ok_and(|params| {
                        params.instance_id == resources_processor::instance_id()
                    });
                if !valid {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "idle shutdown requires the current instanceId"),
                    )
                    .await?;
                    continue;
                }
                if terminals.resource_count() != Some(0)
                    || browsers.resource_count() != 0
                    || !plugin_tasks.is_empty()
                    || !provider_tasks.is_empty()
                    || !indexed_read_tasks.is_empty()
                    || history_refresh.is_active()
                {
                    send(
                        &outbound_tx,
                        success_response(id, json!({"accepted":false,"reason":"resources"})),
                    )
                    .await?;
                    continue;
                }
                let reservation = match thread_manager
                    .try_reserve_workspace_idle_with_reason(&workspace_engine)
                {
                    Ok(reservation) => reservation,
                    Err(reason) => {
                        send(
                            &outbound_tx,
                            success_response(id, json!({"accepted":false,"reason":reason})),
                        )
                        .await?;
                        continue;
                    }
                };
                if !automations.stop_if_idle() {
                    drop(reservation);
                    send(
                        &outbound_tx,
                        success_response(id, json!({"accepted":false,"reason":"automations"})),
                    )
                    .await?;
                    continue;
                }
                // No await between the final checks and closing all engine admissions.
                reservation.commit();
                idle_shutdown_requested = true;
                let _ = send(&outbound_tx, success_response(id, json!({"accepted":true}))).await;
                break;
            }
            method::SERVER_RESOURCES_READ => {
                let (resident_threads, running_turns) = thread_manager.resource_counts();
                let task_activity = thread_manager.task_activity_counts(&workspace_engine);
                let interactions = thread_manager.interaction_activity_counts();
                let automation_activity = automations.resource_activity();
                let background = thread_manager.background_activity_counts(&workspace_engine);
                let activity = kcoder_app_protocol::ServerResourceActivity {
                    resident_threads: Some(resident_threads),
                    running_turns: Some(running_turns),
                    terminal_sessions: terminals.resource_count(),
                    browser_sessions: Some(browsers.resource_count()),
                    pending_service_requests: Some(
                        plugin_tasks.len() + provider_tasks.len() + indexed_read_tasks.len(),
                    ),
                    history_refresh_active: Some(history_refresh.is_active()),
                    pending_tasks: task_activity.map(|counts| counts.0),
                    running_tasks: task_activity.map(|counts| counts.1),
                    pending_approvals: interactions.map(|counts| counts.0),
                    pending_questions: interactions.map(|counts| counts.1),
                    queued_followups: interactions.map(|counts| counts.2),
                    pending_goal_continuations: interactions.map(|counts| counts.3),
                    cached_scheduled_jobs: automation_activity.0,
                    pending_automation_requests: Some(automation_activity.1),
                    automation_subscribed: Some(automation_activity.2),
                    registered_background_jobs: background.map(|counts| counts.0),
                    background_cancellation_markers: background.map(|counts| counts.1),
                    registered_prefires: background.map(|counts| counts.2),
                };
                send(
                    &outbound_tx,
                    resources_processor::process(id, params, activity),
                )
                .await?;
            }
            method::AGENT_LIST => {
                let result = serde_json::from_value::<AgentListParams>(params)
                    .context("invalid agent/list params")
                    .and_then(|params| {
                        let target_engine = thread_manager
                            .engine(&params.thread_id)
                            .context("thread/start or thread/resume is required")?;
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&params.thread_id),
                            &params.thread_id,
                        )?;
                        let session_id = target_engine.session_id();
                        let mut agents = target_engine
                            .state
                            .tasks()
                            .into_values()
                            .filter(|task| {
                                task.kind == TaskKind::Subagent
                                    && task.parent_session_id.as_deref()
                                        == Some(session_id.as_str())
                            })
                            .map(agent_summary)
                            .collect::<Vec<_>>();
                        agents.sort_by(|left, right| left.agent_id.cmp(&right.agent_id));
                        Ok(AgentListResult {
                            thread_id: params.thread_id,
                            agents,
                        })
                    });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32024, &error.to_string())).await?;
                    }
                }
            }
            method::AGENT_ARTIFACT_READ => {
                let params = match serde_json::from_value::<AgentArtifactReadParams>(params) {
                    Ok(params) => params,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                };
                let thread_id = params.thread_id.clone();
                let result = thread_manager
                    .engine(&thread_id)
                    .context("thread/start or thread/resume is required")
                    .and_then(|target_engine| {
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&thread_id),
                            &thread_id,
                        )?;
                        agent_artifacts::read(&target_engine, &params)
                    });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        let unavailable =
                            error.downcast_ref::<agent_artifacts::ArtifactUnavailable>();
                        let code = if unavailable.is_some() {
                            -32026
                        } else {
                            -32024
                        };
                        let message = unavailable
                            .map(|unavailable| unavailable.0.clone())
                            .unwrap_or_else(|| error.to_string());
                        send(&outbound_tx, error_response(id, code, &message)).await?;
                    }
                }
            }
            method::DIAGNOSTICS_STORAGE_READ => {
                let scan = (|| -> Result<_> {
                    anyhow::ensure!(provider_tasks.len() < 4, "diagnostics are busy");
                    let input: kcoder_app_protocol::StorageScanParams = serde_json::from_value(params.clone())?;
                    storage_scans.start(input.scan_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))
                })();
                match scan {
                    Ok(scan) => {
                        let outbound = outbound_tx.clone();
                        provider_tasks.spawn(async move {
                            let result = tokio::task::spawn_blocking(move || { let scan_guard = scan; storage_diagnostics::read_report(&scan_guard.token) }).await;
                            let response = match result {
                                Ok(Ok(report)) => success_response(id, json!(report)),
                                Ok(Err(error)) => error_response(id, if error.is::<storage_diagnostics::StorageScanCancelled>() { -32800 } else { -32602 }, &error.to_string()),
                                Err(error) => error_response(id, -32603, &error.to_string()),
                            };
                            let _ = send(&outbound, response).await;
                        });
                    }
                    Err(error) => { send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?; }
                }
            }
            method::DIAGNOSTICS_STORAGE_CANCEL => {
                let result = serde_json::from_value::<kcoder_app_protocol::StorageScanCancelParams>(params.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|params| storage_scans.cancel(&params.scan_id));
                let response = match result {
                    Ok(cancelled) => success_response(id, json!(kcoder_app_protocol::StorageScanCancelResult { cancelled })),
                    Err(error) => error_response(id, -32602, &error.to_string()),
                };
                send(&outbound_tx, response).await?;
            }
            method::DIAGNOSTICS_STORAGE_CLEAN => {
                let input = serde_json::from_value::<StorageCleanParams>(params.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|input| {
                        anyhow::ensure!(provider_tasks.len() < 4, "diagnostics are busy");
                        Ok(input)
                    });
                match input {
                    Ok(input) => {
                        let outbound = outbound_tx.clone();
                        provider_tasks.spawn(async move {
                            let result = tokio::task::spawn_blocking(move || storage_diagnostics::clean(&input.target, input.confirm)).await;
                            let response = match result {
                                Ok(Ok(result)) => success_response(id, json!(result)),
                                Ok(Err(error)) => error_response(id, if error.is::<storage_diagnostics::StorageBusyError>() { -32034 } else { -32602 }, &error.to_string()),
                                Err(error) => error_response(id, -32603, &error.to_string()),
                            };
                            let _ = send(&outbound, response).await;
                        });
                    }
                    Err(error) => { send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?; }
                }
            }
            method::DIAGNOSTICS_DEBUG_LOG_DISABLE => {
                match storage_diagnostics::disable_debug_log() {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::WORKFLOW_LIST | method::WORKFLOW_READ | method::WORKFLOW_CREATE | method::WORKFLOW_SAVE | method::WORKFLOW_UPSERT_NODE | method::WORKFLOW_REMOVE_NODE => {
                let result = workflow_canvas::request(&workspace_engine, method, params.clone());
                match result {
                    Ok(value) => send(&outbound_tx, success_response(id, value)).await?,
                    Err(error) => send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?,
                }
            }
            method::SETTINGS_TOOLS_READ | method::SETTINGS_TOOLS_SAVE => {
                let result = if method == method::SETTINGS_TOOLS_READ {
                    serde_json::from_value::<kcoder_app_protocol::ToolsSettingsReadParams>(params.clone())
                        .map_err(anyhow::Error::from).and_then(|_| engine_factory.tool_profile_settings(None))
                } else {
                    serde_json::from_value::<kcoder_app_protocol::ToolsSettingsSaveParams>(params.clone())
                        .map_err(anyhow::Error::from).and_then(|value| engine_factory.tool_profile_settings(Some(value.profile)))
                };
                match result {
                    Ok(value) => send(&outbound_tx, success_response(id, serde_json::to_value(value)?)).await?,
                    Err(error) => send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?,
                }
            }
            method::SETTINGS_TURN_FILE_CHANGES_READ => {
                match turn_file_changes_settings::read(&workspace_engine) {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::SETTINGS_TURN_FILE_CHANGES_SAVE => {
                let result = serde_json::from_value::<TurnFileChangesPolicy>(params.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|policy| {
                        turn_file_changes_settings::save(&workspace_engine, &policy)
                    });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::SETTINGS_TEMPLATES_LIST => {
                let result = user_template_store().and_then(|store| store.list());
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::SETTINGS_TEMPLATES_READ => {
                let result = serde_json::from_value::<SettingsTemplateReadParams>(params.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|params| user_template_store()?.read(&params.id));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::SETTINGS_TEMPLATES_SAVE => {
                let result = serde_json::from_value::<SettingsTemplateSaveParams>(params.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|params| user_template_store()?.save(&params));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::SETTINGS_TEMPLATES_DELETE => {
                let result = serde_json::from_value::<SettingsTemplateDeleteParams>(params.clone())
                    .map_err(anyhow::Error::from)
                    .and_then(|params| user_template_store()?.delete(&params.id));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::SETTINGS_TEMPLATES_DEFAULT => {
                let result =
                    serde_json::from_value::<SettingsTemplateDefaultParams>(params.clone())
                        .map_err(anyhow::Error::from)
                        .and_then(|params| {
                            user_template_store()?.set_default(params.id.as_deref())
                        });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    }
                }
            }
            method::AGENT_STEER => {
                let params = match serde_json::from_value::<AgentSteerParams>(params.clone()) {
                    Ok(params) => params,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                };
                if params.message.trim().is_empty() {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "agent steer message must not be empty"),
                    )
                    .await?;
                    continue;
                }
                if params
                    .client_message_id
                    .as_ref()
                    .is_some_and(|value| value.is_empty() || value.len() > 128)
                {
                    send(
                        &outbound_tx,
                        error_response(
                            id,
                            -32602,
                            "clientMessageId must contain 1..=128 bytes when provided",
                        ),
                    )
                    .await?;
                    continue;
                }
                let Some(target_engine) = thread_manager.engine(&params.thread_id) else {
                    send(
                        &outbound_tx,
                        error_response(id, -32025, "agent_not_found_or_not_owned"),
                    )
                    .await?;
                    continue;
                };
                if ensure_active_thread(
                    &target_engine,
                    thread_manager.lease(&params.thread_id),
                    &params.thread_id,
                )
                .is_err()
                    || !target_engine
                        .state
                        .task(&params.agent_id)
                        .is_some_and(|task| {
                            task.kind == TaskKind::Subagent
                                && task.parent_session_id.as_deref()
                                    == Some(target_engine.session_id().as_str())
                        })
                {
                    send(
                        &outbound_tx,
                        error_response(id, -32025, "agent_not_found_or_not_owned"),
                    )
                    .await?;
                    continue;
                }
                let Some(background_projection) = thread_manager.projection(&params.thread_id)
                else {
                    send(
                        &outbound_tx,
                        error_response(id, -32025, "agent_not_found_or_not_owned"),
                    )
                    .await?;
                    continue;
                };
                if let Err(error) = begin_agent_steer_response_gate(
                    &background_projection,
                    &params.agent_id,
                    params.client_message_id.clone(),
                )
                .await
                {
                    send(&outbound_tx, error_response(id, -32037, &error.to_string())).await?;
                    continue;
                }
                let receipt = match target_engine
                    .steer_subagent(&params.agent_id, params.message.trim())
                    .await
                {
                    Ok(receipt) => receipt,
                    Err(error) => {
                        finish_agent_steer_response_gate(
                            &background_projection,
                            &outbound_tx,
                            &params.agent_id,
                            None,
                        )
                        .await?;
                        send(&outbound_tx, error_response(id, -32036, &error.to_string())).await?;
                        continue;
                    }
                };
                let message_id = receipt.message_id.clone();
                let result = agent_steer_result_from_receipt(params.client_message_id, receipt);
                send(
                    &outbound_tx,
                    success_response(id, serde_json::to_value(result)?),
                )
                .await?;
                finish_agent_steer_response_gate(
                    &background_projection,
                    &outbound_tx,
                    &params.agent_id,
                    message_id.as_deref(),
                )
                .await?;
            }
            method::DEVICE_EXECUTE => {
                match match serde_json::from_value::<DeviceExecuteParams>(params) {
                    Ok(params) if params.command_key == "ls_skills" => {
                        let registry = match params.thread_id.as_deref() {
                            Some(thread_id) => thread_manager
                                .engine(thread_id)
                                .context("Skill catalog conversation is not resident")
                                .and_then(|thread| {
                                    thread
                                        .skill_registry
                                        .read()
                                        .map(|registry| registry.clone())
                                        .map_err(|_| {
                                            anyhow::anyhow!("Skill registry is unavailable")
                                        })
                                }),
                            None => engine_factory.current_skills(),
                        };
                        registry.map(|registry| {
                            let cwd = workspace_engine.state.cwd();
                            let skills = registry.list().into_iter().map(|skill| {
                                let project = skill.source.starts_with(&cwd);
                                json!({
                                    "name": skill.name, "description": skill.description,
                                    "short_description": Value::Null, "path": skill.source,
                                    "can_remove": skill_processor::user_managed(skill),
                                    "source": "kcoder", "scope": if project { "repo" } else { "user" },
                                    "source_label": "KCoder", "source_priority": if project { 10 } else { 20 }, "origin": "local",
                                })
                            }).collect::<Vec<_>>();
                            DeviceExecuteResult { success: true, exit_code: 0, stdout: skills.into(), stderr: String::new() }
                        })
                    }
                    Ok(params)
                        if matches!(
                            params.command_key.as_str(),
                            "turn_file_changes_review" | "turn_file_changes_revert"
                        ) =>
                    {
                        let requested_thread_id = params
                            .thread_id
                            .clone()
                            .or_else(|| thread_manager.sole_thread_id());
                        let target_engine = requested_thread_id
                            .as_deref()
                            .context(
                                "turn file changes command requires threadId when multiple resident threads exist",
                            )
                            .and_then(|thread_id| {
                                let target_engine = thread_manager
                                    .engine(thread_id)
                                    .context("thread/start or thread/resume is required")?;
                                ensure_active_thread(
                                    &target_engine,
                                    thread_manager.lease(thread_id),
                                    thread_id,
                                )?;
                                Ok(target_engine)
                            });
                        match target_engine {
                            Ok(target_engine) => {
                                turn_file_changes_command(&target_engine, &params).await
                            }
                            Err(error) => Err(error),
                        }
                    }
                    Ok(params)
                        if matches!(
                            params.command_key.as_str(),
                            "git_add_all"
                                | "git_commit"
                                | "git_commit_all"
                                | "git_push"
                                | "git_pull_ff"
                                | "git_merge"
                                | "git_apply_reverse"
                                | "git_checkout"
                                | "git_checkout_new"
                        ) && thread_manager
                            .resident_engines()
                            .iter()
                            .any(|engine| thread_manager.is_turn_running(&engine.session_id())) =>
                    {
                        Err(anyhow::anyhow!(
                            "git mutations are unavailable while an agent turn is running"
                        ))
                    }
                    Ok(params) => device_execute(&workspace_engine.state.cwd(), &params).await,
                    Err(error) => Err(error).context("invalid device/execute params"),
                } {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            "runtime.models.list" => {
                if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                    match thread_manager.engine(thread_id) {
                        Some(thread) => {
                            send(
                                &outbound_tx,
                                match thread.current_configured_model_profiles() {
                                    Ok(profiles) => match thread.active_model_configuration_summary() {
                                        Ok(active) => { let mut result = configured_model_catalog_response(profiles); result["activeConfiguration"] = serde_json::to_value(active)?; success_response(id, result) },
                                        Err(error) => error_response(id, -32602, &error.to_string()),
                                    },
                                    Err(error) => error_response(id, -32602, &error.to_string()),
                                },
                            )
                            .await?
                        }
                        None => {
                            send(
                                &outbound_tx,
                                error_response(
                                    id,
                                    -32602,
                                    "Model catalog conversation is not resident",
                                ),
                            )
                            .await?
                        }
                    }
                } else {
                    match engine_factory.current_model_profiles() {
                        Ok(profiles) => {
                            send(
                                &outbound_tx,
                                success_response(
                                    id,
                                    configured_model_catalog_response(
                                        profiles,
                                    ),
                                ),
                            )
                            .await?
                        }
                        Err(error) => {
                            send(&outbound_tx, error_response(id, -32602, &error.to_string()))
                                .await?
                        }
                    }
                }
            }
            kcoder_app_protocol::method::PROVIDERS_TEMPLATES => {
                match provider_settings::templates(params.clone()) {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            "runtime.providers.list"
            | "runtime.providers.upsert"
            | "runtime.providers.delete"
            | "runtime.providers.validate" => {
                match provider_settings::request(
                    &workspace_engine,
                    &provider_settings_state,
                    method,
                    params.clone(),
                ) {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            "runtime.context.get" | "runtime.context.update" => {
                match runtime_context_request(&workspace_engine, method, &params) {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            "runtime.workspace.search" => {
                match workspace_search_request(&workspace_engine, &params).await {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            "runtime.worktrees.settings.get"
            | "runtime.worktrees.settings.update"
            | "runtime.worktrees.prepare"
            | "runtime.worktrees.list"
            | "runtime.worktrees.archive.preview"
            | "runtime.worktrees.archive"
            | "runtime.worktrees.delete"
            | "runtime.worktrees.restore"
            | "runtime.worktrees.forget"
            | "runtime.worktrees.conversations.link"
            | "runtime.worktrees.conversations.remove"
            | "runtime.worktrees.prune" => {
                match worktree_request(&workspace_engine, method, &params).await {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(
                            &outbound_tx,
                            error_response(id, -32602, &format!("{method}: {error:#}")),
                        )
                        .await?
                    }
                }
            }
            "runtime.workspaces.open"
            | "runtime.workspaces.prepare"
            | "runtime.workspaces.delete"
            | "runtime.projects.upsert_local"
            | "runtime.workspaces.rename"
            | "runtime.workspaces.remove"
            | "runtime.workspaces.list"
            | "runtime.sidebar.projects.reorder"
            | "runtime.sidebar.projects.pin"
            | "runtime.sidebar.projects.appearance"
            | "runtime.sidebar.projects.sync_remote"
            | "runtime.sidebar.projects.activate"
            | "runtime.sidebar.tasks.reorder"
            | "runtime.sidebar.tasks.pin" => {
                match workspace_request(&workspace_engine, method, &params).await {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::ATTACHMENT_SAVE => match serde_json::from_value::<AttachmentSaveParams>(params)
                .context("invalid attachment/save params")
                .and_then(|params| {
                    attachment_save(
                        &workspace_engine.session_id(),
                        &params,
                        &mut attachment_directories,
                    )
                }) {
                Ok(result) => {
                    send(
                        &outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            },
            method::ATTACHMENT_UPLOAD_START => {
                match serde_json::from_value::<AttachmentUploadStartParams>(params)
                    .context("invalid attachment/upload/start params")
                    .and_then(|params| {
                        attachment_upload_start(
                            &workspace_engine.session_id(),
                            &params,
                            &mut attachment_directories,
                        )
                    }) {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::ATTACHMENT_UPLOAD_CHUNK => {
                match serde_json::from_value::<AttachmentUploadChunkParams>(params)
                    .context("invalid attachment/upload/chunk params")
                    .and_then(|params| {
                        attachment_upload_chunk(&params, &mut attachment_directories)
                    }) {
                    Ok(()) => {
                        send(
                            &outbound_tx,
                            success_response(id, json!({"accepted": true})),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::ATTACHMENT_UPLOAD_FINISH => {
                match serde_json::from_value::<AttachmentUploadFinishParams>(params)
                    .context("invalid attachment/upload/finish params")
                    .and_then(|params| {
                        attachment_upload_finish(&params, &mut attachment_directories)
                    }) {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::ATTACHMENT_UPLOAD_CANCEL => {
                match serde_json::from_value::<AttachmentUploadCancelParams>(params)
                    .context("invalid attachment/upload/cancel params")
                    .and_then(|params| {
                        attachment_upload_cancel(&params.upload_id, &mut attachment_directories)
                    }) {
                    Ok(()) => {
                        send(
                            &outbound_tx,
                            success_response(id, json!({"cancelled": true})),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::ATTACHMENT_DELETE => {
                match serde_json::from_value::<AttachmentDeleteParams>(params)
                    .context("invalid attachment/delete params")
                    .and_then(|params| {
                        let path = PathBuf::from(params.path);
                        if !attachment_directories.contains(&path) {
                            anyhow::bail!("attachment was not staged by this app-server connection")
                        }
                        attachment_directories.consume(&path)
                    }) {
                    Ok(()) => {
                        send(&outbound_tx, success_response(id, json!({"removed": true}))).await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::ATTACHMENT_READ => match serde_json::from_value::<AttachmentReadParams>(params)
                .context("invalid attachment/read params")
                .and_then(|params| {
                    let target_engine = thread_manager
                        .engine(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&params.thread_id),
                        &params.thread_id,
                    )?;
                    attachment_read(&target_engine, &params, &attachment_directories)
                }) {
                Ok(result) => {
                    send(
                        &outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(&outbound_tx, error_response(id, -32038, &error.to_string())).await?
                }
            },
            method::ATTACHMENT_READ_CHUNK => {
                match serde_json::from_value::<AttachmentReadChunkParams>(params)
                    .context("invalid attachment/read/chunk params")
                    .and_then(|params| {
                        let target_engine = thread_manager
                            .engine(&params.thread_id)
                            .context("thread/start or thread/resume is required")?;
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&params.thread_id),
                            &params.thread_id,
                        )?;
                        attachment_read_chunk(&target_engine, &params, &attachment_directories)
                    }) {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32038, &error.to_string())).await?
                    }
                }
            }
            method::TERMINAL_START => {
                let result = match serde_json::from_value::<TerminalStartParams>(params) {
                    Ok(params) => {
                        terminal_start(
                            &workspace_engine.state.cwd(),
                            &workspace_engine.session_id(),
                            next_terminal_id.fetch_add(1, Ordering::Relaxed),
                            params,
                            terminals.clone(),
                            outbound_tx.clone(),
                        )
                        .await
                    }
                    Err(error) => Err(error).context("invalid terminal/start params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::TERMINAL_LIST => {
                let result = serde_json::from_value::<TerminalListParams>(params)
                    .context("invalid terminal/list params")
                    .map(|_| terminal_list(&terminals));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::TERMINAL_ATTACH => {
                let result = serde_json::from_value::<TerminalAttachParams>(params)
                    .context("invalid terminal/attach params")
                    .and_then(|params| terminal_attach(&terminals, params));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::TERMINAL_WRITE => {
                let result = serde_json::from_value::<TerminalWriteParams>(params)
                    .context("invalid terminal/write params")
                    .and_then(|params| terminal_write(&terminals, params));
                match result {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::TERMINAL_RESIZE => {
                let result = serde_json::from_value::<TerminalResizeParams>(params)
                    .context("invalid terminal/resize params")
                    .and_then(|params| terminal_resize(&terminals, params));
                match result {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::TERMINAL_CLOSE => {
                let result = serde_json::from_value::<TerminalCloseParams>(params)
                    .context("invalid terminal/close params")
                    .and_then(|params| terminal_close(&terminals, params));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::BROWSER_PREFLIGHT => {
                if !params.as_object().is_some_and(|object| object.is_empty()) {
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "browser/preflight does not accept parameters"),
                    )
                    .await?;
                } else {
                    send(
                        &outbound_tx,
                        success_response(
                            id,
                            serde_json::to_value(browser::browser_preflight_result())?,
                        ),
                    )
                    .await?;
                }
            }
            method::BROWSER_START => {
                let result = match serde_json::from_value::<BrowserStartParams>(params) {
                    Ok(params) => browsers.start(&workspace_engine.session_id(), params).await,
                    Err(error) => Err(error).context("invalid browser/start params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::BROWSER_SCREENSHOT => {
                let result = match serde_json::from_value::<BrowserSessionParams>(params) {
                    Ok(params) => browsers.screenshot(params).await,
                    Err(error) => Err(error).context("invalid browser/screenshot params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::BROWSER_ACTION => {
                let result = match serde_json::from_value::<BrowserActionParams>(params) {
                    Ok(params) => browsers.action(params).await,
                    Err(error) => Err(error).context("invalid browser/action params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::BROWSER_EVALUATE => {
                let result = match serde_json::from_value::<BrowserEvaluateParams>(params) {
                    Ok(params) => browsers.evaluate(params).await,
                    Err(error) => Err(error).context("invalid browser/evaluate params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::BROWSER_CLOSE => {
                let result = match serde_json::from_value::<BrowserSessionParams>(params) {
                    Ok(params) => browsers.close(params).await,
                    Err(error) => Err(error).context("invalid browser/close params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            browser_success_response(id, result, MAX_DEVICE_RESULT_BYTES)?,
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::SESSION_MODES => {
                let result =
                    serde_json::from_value::<kcoder_app_protocol::SessionModesParams>(params)
                        .map_err(anyhow::Error::from)
                        .and_then(|params| {
                            let selected = match params.thread_id.as_deref() {
                                Some(id) => thread_manager
                                    .engine(id)
                                    .context("thread is not resident")?,
                                None => workspace_engine.clone(),
                            };
                            let mut result = turn_execution::inspect(&selected);
                            let thread_id =
                                params.thread_id.unwrap_or_else(|| selected.session_id());
                            // Reported read-only so a running session can show its bound template.
                            result.settings_template =
                                recorded_settings_template_binding(&selected, &thread_id);
                            Ok(result)
                        });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_SESSION_MODE_SET => {
                let result = async {
                    let params: kcoder_app_protocol::ThreadSessionModeSetParams =
                        serde_json::from_value(params)?;
                    let turn = thread_manager
                        .turn_state(&params.thread_id)
                        .context("thread is not resident")?;
                    let _gate = turn.activity_gate.lock().await;
                    anyhow::ensure!(
                        !turn.running.load(Ordering::SeqCst),
                        "session mode cannot change after a turn has started"
                    );
                    let selected = thread_manager
                        .engine(&params.thread_id)
                        .context("thread is not resident")?;
                    turn_execution::set_mode(&selected, params.mode)?;
                    Ok::<_, anyhow::Error>(json!({"thread":thread_snapshot(&selected, false)}))
                }
                .await;
                match result {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_START => {
                let start_params = match serde_json::from_value::<ThreadStartParams>(params) {
                    Ok(params) => params,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                };
                if let Some(requested_cwd) = start_params.cwd.as_deref()
                    && let Err(error) = ensure_same_workspace(
                        &workspace_engine.state.cwd(),
                        Path::new(requested_cwd),
                    )
                    .await
                {
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
                match thread_creations::replay(&workspace_engine, &start_params) {
                    Ok(Some(result)) => { send(&outbound_tx, success_response(id, result)).await?; continue; }
                    Ok(None) => {}
                    Err(error) => { send(&outbound_tx, error_response(id, -32059, &error.to_string())).await?; continue; }
                }
                let settings_template = match start_params.settings_template.as_deref() {
                    Some(template_id) => match resolve_session_template(template_id) {
                        Ok(resolved) => Some(resolved),
                        Err(error) => {
                            send(&outbound_tx, error_response(id, -32602, &error.to_string()))
                                .await?;
                            continue;
                        }
                    },
                    // Without an explicit choice the store's default template keeps
                    // new sessions from needing a manual switch every time.
                    None => config_templates::default_session_template(),
                };
                let mut turn_state = ResidentTurnState::new(
                    outbound_tx.clone(),
                    permission_mode,
                    Arc::clone(&next_question_id),
                    Arc::clone(&next_approval_id),
                    Arc::clone(&connection_receipts),
                );
                let next_engine = match engine_factory
                    .create_fresh_thread_with_template(
                        settings_template.as_ref().map(|(path, _)| path.clone()),
                        Arc::clone(&turn_state.user_questioner),
                    )
                    .await
                {
                    Ok(engine) => engine,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32022, &error.to_string())).await?;
                        continue;
                    }
                };
                turn_state.configure_for_engine(&next_engine);
                if let Some(model) = start_params.model.as_deref()
                    && let Err(error) = next_engine.select_client_model(model)
                {
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
                let lease = match SessionLease::acquire(&next_engine.session_lease_target()) {
                    Ok(lease) => lease,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32023, &error.to_string())).await?;
                        continue;
                    }
                };
                match thread_creations::reserve(&workspace_engine, &start_params, &next_engine.session_id()) {
                    Ok(true) => {}
                    Ok(false) => {
                        let response = match thread_creations::replay(&workspace_engine, &start_params) {
                            Ok(Some(result)) => success_response(id, result),
                            Ok(None) => error_response(id, -32059, "creation reservation disappeared"),
                            Err(error) => error_response(id, -32059, &error.to_string()),
                        };
                        send(&outbound_tx, response).await?;
                        continue;
                    }
                    Err(error) => { send(&outbound_tx, error_response(id, -32059, &error.to_string())).await?; continue; }
                }
                engine = next_engine;
                let runtime = build_resident_thread_runtime(
                    engine.clone(),
                    lease,
                    0,
                    turn_state,
                    outbound_tx.clone(),
                    server_id.clone(),
                    Arc::clone(&sequence),
                );
                if let Some((_, binding)) = settings_template.as_ref()
                    && let Err(error) = record_thread_settings_template(&engine, binding)
                {
                    tracing::warn!(%error, "failed to record the session settings template binding");
                }
                match thread_manager.insert(runtime) {
                    Ok(Some(evicted)) => evicted.shutdown().await,
                    Ok(None) => {}
                    Err(rejected) => {
                        (*rejected).shutdown().await;
                        send(
                            &outbound_tx,
                            error_response(
                                id,
                                -32039,
                                "resident thread capacity is full; no idle runtime can be evicted",
                            ),
                        )
                        .await?;
                        continue;
                    }
                }
                // Materialize a new thread only after admission to the resident manager;
                // capacity rejection must not leave invisible empty history or session sidecars.
                engine.activate_client_session();
                if let Some(mode) = start_params.session_mode
                    && let Err(error) = turn_execution::set_mode(&engine, mode)
                {
                    if let Ok(Some(runtime)) = thread_manager.remove_if_idle(&engine.session_id()) {
                        runtime.shutdown().await;
                    }
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
                let _ = engine.run_startup_hooks().await;
                if let Some(fire) = automation_fire.as_ref() {
                    let title: String = fire
                        .prompt
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(80)
                        .collect();
                    let patch = serde_json::from_value(
                        json!({"threadId": engine.session_id(), "title": title}),
                    )?;
                    if let Err(error) = update_thread_metadata(
                        &engine,
                        patch,
                        &thread_manager.running_thread_ids(),
                        true,
                    ) {
                        tracing::warn!(%error, "failed to persist automation conversation title");
                    }
                }
                if start_params.client_request_id.is_some()
                    && let Err(error) = engine.state.materialize_history()
                {
                    send(&outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                    continue;
                }
                let thread = thread_snapshot(&engine, false);
                if let Some(request_id) = start_params.client_request_id.as_deref()
                    && let Err(error) = thread_creations::complete(&workspace_engine, request_id, thread.clone())
                {
                    send(&outbound_tx, error_response(id, -32059, &error.to_string())).await?;
                    continue;
                }
                if let Some(fire) = automation_fire.as_ref() {
                    let thread_id = engine.session_id();
                    automations.start_turn(fire, &thread_id);
                    send(&outbound_tx, notification("automation/runStarted", json!({
                        "jobId": fire.id, "threadId": thread_id, "thread": thread,
                        "workspacePath": engine.state.cwd(), "title": fire.prompt.chars().take(80).collect::<String>()
                    }))).await?;
                }
                send(
                    &outbound_tx,
                    success_response(id, json!({"thread": thread.clone()})),
                )
                .await?;
                send(
                    &outbound_tx,
                    notification(
                        "thread/started",
                        with_event_context(
                            &server_id,
                            thread["id"].as_str().unwrap_or_default(),
                            None,
                            &sequence,
                            json!({"thread": thread}),
                        ),
                    ),
                )
                .await?;
            }
            method::THREAD_LIST => {
                let running_thread_ids = thread_manager.running_thread_ids();
                let result = serde_json::from_value::<ThreadListParams>(params)
                    .context("invalid thread/list params")
                    .and_then(|params| {
                        let limit = params.limit.unwrap_or(100).clamp(1, 100) as usize;
                        let archived = params.archived;
                        let allow_partial = params.allow_partial.unwrap_or(false);
                        if let Some(cursor) = params.cursor {
                            return thread_list_snapshots.page_report(
                                &cursor,
                                limit,
                                archived,
                                params.query.as_deref(),
                                allow_partial,
                            );
                        }
                        let query = params
                            .query
                            .map(|value| value.trim().to_lowercase())
                            .filter(|value| !value.is_empty());
                        let mut seen = HashSet::new();
                        let mut resident_issues = 0_u64;
                        let mut thread_values = thread_manager
                            .resident_engines()
                            .into_iter()
                            .filter(|resident| !thread_manager.is_ephemeral(&resident.session_id()))
                            .filter_map(|resident| {
                                let thread_id = resident.session_id();
                                seen.insert(thread_id.clone());
                                match thread_snapshot_with_metadata_policy(&resident, running_thread_ids.contains(&thread_id), true) {
                                    Ok(mut snapshot) => {
                                        ThreadRunProjection::for_thread(
                                            &thread_manager,
                                            state.run_summary_v1,
                                            &thread_id,
                                        )
                                        .apply(&mut snapshot);
                                        Some(snapshot)
                                    }
                                    Err(error) => {
                                        resident_issues = resident_issues.saturating_add(1);
                                        tracing::warn!(%error, "skipping unreadable resident thread metadata");
                                        None
                                    }
                                }
                            })
                            .collect::<Vec<_>>();
                        let persisted = persisted_thread_snapshot_report(
                            &workspace_engine,
                            &running_thread_ids,
                            &seen,
                        )?;
                        thread_values.extend(persisted.threads.into_iter().filter(|value| {
                            value["id"]
                                .as_str()
                                .is_some_and(|thread_id| seen.insert(thread_id.to_string()))
                        }));
                        let threads = thread_values
                            .into_iter()
                            .map(serde_json::from_value)
                            .collect::<std::result::Result<Vec<Thread>, _>>()?
                            .into_iter()
                            .filter(|thread| {
                                archived
                                    .is_none_or(|expected| thread.archived_at.is_some() == expected)
                            })
                            .filter(|thread| {
                                query.as_ref().is_none_or(|needle| {
                                    [&thread.title, &thread.cwd, &thread.model]
                                        .into_iter()
                                        .flatten()
                                        .any(|value| value.to_lowercase().contains(needle))
                                })
                            })
                            .collect::<Vec<_>>();
                        thread_list_snapshots.start_report(
                            threads,
                            limit,
                            archived,
                            query,
                            persisted.issue_count.saturating_add(resident_issues),
                            allow_partial,
                        )
                    });
                match result {
                    Ok(mut result) => {
                        for thread in &mut result.threads {
                            recent_error::decorate(&workspace_engine, thread, state.run_summary_v1);
                        }
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32020, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_HISTORY_REFRESH => {
                let result = serde_json::from_value::<
                    kcoder_app_protocol::ThreadHistoryRefreshParams,
                >(params)
                .context("invalid thread/history/refresh params")
                .and_then(|params| history_refresh.process(&workspace_engine, params));
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32020, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_METADATA_UPDATE => {
                let running_thread_ids = thread_manager.running_thread_ids();
                let result = serde_json::from_value::<ThreadMetadataUpdateParams>(params)
                    .context("invalid thread/metadata/update params")
                    .and_then(|params| {
                        let target_engine = thread_manager
                            .engine(&params.thread_id)
                            .unwrap_or_else(|| workspace_engine.clone());
                        let active_thread_owned = thread_manager
                            .lease(&params.thread_id)
                            .is_some_and(|lease| lease.matches_engine(&target_engine));
                        update_thread_metadata(
                            &target_engine,
                            params,
                            &running_thread_ids,
                            active_thread_owned,
                        )
                    });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32037, &error.to_string())).await?
                    }
                }
            }
            method::TOOLS_CATALOG => {
                match tools_catalog::query(params, &thread_manager, &workspace_engine).await {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32038, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_CREATION_READ => {
                let result = serde_json::from_value::<kcoder_app_protocol::ThreadCreationReadParams>(params)
                    .context("invalid thread creation query")
                    .and_then(|params| thread_creations::query(&workspace_engine, &params.client_request_id));
                match result {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => send(&outbound_tx, error_response(id, -32059, &error.to_string())).await?,
                }
            }
            method::TURN_RECEIPT_READ => {
                match turn_receipts::query(params, &thread_manager, &workspace_engine).await {
                    Ok(result) => send(&outbound_tx, success_response(id, serde_json::to_value(result)?)).await?,
                    Err(error) => send(&outbound_tx, error_response(id, -32046, &error.to_string())).await?,
                }
            }
            method::THREAD_READ => {
                let running_thread_ids = thread_manager.running_thread_ids();
                let result = match serde_json::from_value::<ThreadReadParams>(params)
                    .context("invalid thread/read params")
                {
                    Ok(params) => {
                        let target_engine = thread_manager
                            .engine(&params.thread_id)
                            .unwrap_or_else(|| workspace_engine.clone());
                        let run_projection = ThreadRunProjection::for_thread(
                            &thread_manager,
                            state.run_summary_v1,
                            &params.thread_id,
                        );
                        thread_transcript(
                            &target_engine,
                            params,
                            &running_thread_ids,
                            run_projection,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        let message = error.to_string();
                        send(&outbound_tx, error_response(id, -32021, &message)).await?
                    }
                }
            }
            method::THREAD_RESUME => {
                if params.get("settingsTemplate").is_some() {
                    send(
                        &outbound_tx,
                        error_response(
                            id,
                            -32602,
                            "cannot change the settings template of an existing thread; start a new thread instead",
                        ),
                    )
                    .await?;
                    continue;
                }
                let requested = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .context("thread/resume requires threadId");
                let result = requested.and_then(|thread_id| {
                    validate_thread_id(thread_id)?;
                    if thread_manager.owns(thread_id) {
                        Ok(PreparedThreadResume::Resident {
                            thread_id: thread_id.to_string(),
                        })
                    } else {
                        let settings_template =
                            recorded_settings_template_path(&workspace_engine, thread_id);
                        prepare_persisted_thread_resume(&workspace_engine, thread_id).map(
                            |(prepared, lease, client_turn_count)| {
                                PreparedThreadResume::Persisted {
                                    prepared: Box::new(prepared),
                                    lease,
                                    client_turn_count,
                                    settings_template,
                                }
                            },
                        )
                    }
                });
                match result {
                    Ok(prepared_resume) => match prepared_resume {
                        PreparedThreadResume::Resident { thread_id } => {
                            engine = thread_manager
                                .select(&thread_id)
                                .expect("resident runtime disappeared");
                            let mut thread = thread_snapshot(
                                &engine,
                                thread_manager.is_turn_running(&thread_id),
                            );
                            let followups = thread_manager
                                .followups(&thread_id)
                                .expect("resident runtime disappeared");
                            if followups.client_turn_count.get().is_none() {
                                let turn_state = thread_manager
                                    .turn_state(&thread_id)
                                    .expect("resident runtime disappeared");
                                let _activity = turn_state.activity_gate.lock().await;
                                match reconstruct_client_turn_count(&engine) {
                                    Ok(count) => {
                                        followups.client_turn_count.reset(count);
                                        followups.notify.notify_waiters();
                                    }
                                    Err(error) => {
                                        send(
                                            &outbound_tx,
                                            error_response(id, -32022, &error.to_string()),
                                        )
                                        .await?;
                                        continue;
                                    }
                                }
                            }
                            ThreadRunProjection::for_thread(
                                &thread_manager,
                                state.run_summary_v1,
                                &thread_id,
                            )
                            .apply(&mut thread);
                            send(
                                &outbound_tx,
                                success_response(id, json!({"thread": thread})),
                            )
                            .await?;
                        }
                        PreparedThreadResume::Persisted {
                            prepared,
                            lease,
                            client_turn_count,
                            settings_template,
                        } => {
                            let reserved = match thread_manager.reserve_capacity() {
                                Ok(reserved) => reserved,
                                Err(()) => {
                                    send(
                                            &outbound_tx,
                                            error_response(
                                                id,
                                                -32039,
                                                "resident thread capacity is full; no idle runtime can be evicted",
                                            ),
                                        )
                                        .await?;
                                    continue;
                                }
                            };
                            if let Some(evicted) = reserved {
                                evicted.shutdown().await;
                            }
                            let mut turn_state = ResidentTurnState::new(
                                outbound_tx.clone(),
                                permission_mode,
                                Arc::clone(&next_question_id),
                                Arc::clone(&next_approval_id),
                                Arc::clone(&connection_receipts),
                            );
                            let next_engine = match engine_factory
                                .resume_fresh_thread_with_template(
                                    settings_template.clone(),
                                    *prepared,
                                    Arc::clone(&turn_state.user_questioner),
                                )
                                .await
                            {
                                Ok((engine, _)) => engine,
                                Err(error) => {
                                    send(
                                        &outbound_tx,
                                        error_response(id, -32022, &error.to_string()),
                                    )
                                    .await?;
                                    continue;
                                }
                            };
                            turn_state.configure_for_engine(&next_engine);
                            next_engine.activate_client_session();
                            engine = next_engine;
                            let runtime = build_resident_thread_runtime(
                                engine.clone(),
                                lease,
                                client_turn_count,
                                turn_state,
                                outbound_tx.clone(),
                                server_id.clone(),
                                Arc::clone(&sequence),
                            );
                            match thread_manager.insert(runtime) {
                                Ok(Some(evicted)) => evicted.shutdown().await,
                                Ok(None) => {}
                                Err(rejected) => {
                                    (*rejected).shutdown().await;
                                    send(
                                            &outbound_tx,
                                            error_response(
                                                id,
                                                -32039,
                                                "resident thread capacity is full; no idle runtime can be evicted",
                                            ),
                                        )
                                        .await?;
                                    continue;
                                }
                            }
                            let _ = engine.run_startup_hooks().await;
                            let mut thread = thread_snapshot(&engine, false);
                            ThreadRunProjection::for_thread(
                                &thread_manager,
                                state.run_summary_v1,
                                &engine.session_id(),
                            )
                            .apply(&mut thread);
                            let response = success_response(id, json!({"thread": thread}));
                            send(&outbound_tx, response).await?;
                        }
                    },
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32022, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_FORK => {
                if params.get("ephemeral").and_then(Value::as_bool) == Some(true) {
                    let result: Result<Value> = async {
                        let params: ThreadForkParams = serde_json::from_value(params)?;
                        anyhow::ensure!(
                            !thread_manager.is_turn_running(&params.thread_id),
                            "temporary chat requires a completed source turn; wait for the current response to finish"
                        );
                        let source = thread_manager.engine(&params.thread_id)
                            .context("source thread must be started or resumed before a temporary fork")?;
                        ensure_active_thread(&source, thread_manager.lease(&params.thread_id), &params.thread_id)?;
                        if let Some(cwd) = params.cwd.as_deref() {
                            ensure_same_workspace(&source.state.cwd(), Path::new(cwd)).await?;
                        }
                        let mut messages = if params.last_turn_id.is_empty() {
                            source.state.messages()
                        } else {
                            let path = thread_history_path(&source, &params.thread_id)?;
                            turn_admissions::fork_transcript(
                                &kcoder_state::load_transcript_history(&path)?,
                                &turn_admissions::bindings(&source, &params.thread_id)?,
                                &params.last_turn_id,
                            )?
                        };
                        anyhow::ensure!(!messages.is_empty(), "source thread has no completed context to fork");
                        let mut turn_state = ResidentTurnState::new(
                            outbound_tx.clone(), permission_mode,
                            Arc::clone(&next_question_id),
                            Arc::clone(&next_approval_id),
                            Arc::clone(&connection_receipts),
                        );
                        let child = engine_factory.create_ephemeral_thread(
                            &source, messages.clone(), Arc::clone(&turn_state.user_questioner),
                        )?;
                        attachments::clone_fork_attachments_between(
                            &source, &child, &params.thread_id, &child.session_id(), &mut messages,
                        )?;
                        child.state.set_messages(messages);
                        child.state.save_history()?;
                        let lease = SessionLease::acquire(&child.session_lease_target())?;
                        turn_state.configure_for_engine(&child);
                        child.activate_client_session();
                        let snapshot = thread_snapshot(&child, false);
                        let runtime = build_resident_thread_runtime(
                            child.clone(), lease, child.client_turn_count(), turn_state,
                            outbound_tx.clone(), server_id.clone(), Arc::clone(&sequence),
                        ).with_ephemeral();
                        match thread_manager.insert(runtime) {
                            Ok(Some(evicted)) => evicted.shutdown().await,
                            Ok(None) => {},
                            Err(rejected) => {
                                (*rejected).shutdown().await;
                                anyhow::bail!("resident thread capacity is full; close another temporary chat first");
                            }
                        }
                        Ok(json!({"thread":snapshot,"ephemeral":true}))
                    }.await;
                    let response = match result {
                        Ok(result) => success_response(id, result),
                        Err(error) => error_response(id, -32036, &error.to_string()),
                    };
                    send(&outbound_tx, response).await?;
                    continue;
                }
                let result = match serde_json::from_value::<ThreadForkParams>(params) {
                    Ok(params) => {
                        if thread_manager.is_ephemeral(&params.thread_id) {
                            Err(anyhow::anyhow!(
                                "temporary threads cannot be forked into durable conversations"
                            ))
                        } else if thread_manager.is_turn_running(&params.thread_id) {
                            Err(anyhow::anyhow!("cannot fork an incomplete turn"))
                        } else {
                            let target_engine = thread_manager
                                .select(&params.thread_id)
                                .context("thread/start or thread/resume is required");
                            target_engine.and_then(|target_engine| {
                                ensure_active_thread(
                                    &target_engine,
                                    thread_manager.lease(&params.thread_id),
                                    &params.thread_id,
                                )
                                .and_then(|_| {
                                    if let Some(cwd) = params.cwd.as_deref() {
                                        let expected =
                                            std::fs::canonicalize(target_engine.state.cwd())?;
                                        let requested = std::fs::canonicalize(cwd)?;
                                        if requested != expected {
                                            anyhow::bail!(
                                                "fork cwd does not match the active workspace"
                                            )
                                        }
                                    }
                                    let source_history =
                                        thread_history_path(&target_engine, &params.thread_id)?;
                                    let transcript =
                                        kcoder_state::load_transcript_history(&source_history)?;
                                    let mut messages = turn_admissions::fork_transcript(
                                        &transcript,
                                        &turn_admissions::bindings(&target_engine, &params.thread_id)?,
                                        &params.last_turn_id,
                                    )?;
                                    let history_dir = source_history
                                        .parent()
                                        .context("session history path has no parent")?;
                                    let fork_state =
                                        kcoder_state::AppState::new(target_engine.state.cwd());
                                    let fork_id = fork_state.session_id();
                                    let fork_path =
                                        candidate_thread_history_path(history_dir, &fork_id)?;
                                    fork_state.with_history_path(&fork_path);
                                    if let Err(error) = clone_fork_attachments(
                                        &target_engine,
                                        &params.thread_id,
                                        &fork_id,
                                        &mut messages,
                                    ) {
                                        let _ = std::fs::remove_dir_all(
                                            target_engine.session_storage_dir_for(&fork_id),
                                        );
                                        return Err(error);
                                    }
                                    if let Err(error) = fork_state.enter_session_mode_before_first_message(
                                        target_engine.state.session_mode(),
                                    ) {
                                        let _ = std::fs::remove_dir_all(
                                            target_engine.session_storage_dir_for(&fork_id),
                                        );
                                        let _ =
                                            kcoder_state::delete_session_history_files(&fork_path);
                                        return Err(error);
                                    }
                                    fork_state.set_messages(messages);
                                    if let Err(error) = fork_state.save_history() {
                                        let _ = std::fs::remove_dir_all(
                                            target_engine.session_storage_dir_for(&fork_id),
                                        );
                                        let _ =
                                            kcoder_state::delete_session_history_files(&fork_path);
                                        return Err(error);
                                    }
                                    if let Err(error) = clone_turn_client_message_ids(
                                        &target_engine,
                                        &params.thread_id,
                                        &fork_id,
                                    ) {
                                        let _ = std::fs::remove_dir_all(
                                            target_engine.session_storage_dir_for(&fork_id),
                                        );
                                        let _ =
                                            kcoder_state::delete_session_history_files(&fork_path);
                                        return Err(error);
                                    }
                                    let thread = serde_json::from_value(persisted_thread_value(
                                        &target_engine,
                                        &fork_id,
                                        &fork_path,
                                        false,
                                    )?)?;
                                    Ok(ThreadForkResult {
                                        thread,
                                        ephemeral: false,
                                    })
                                })
                            })
                        }
                    }
                    Err(error) => Err(error).context("invalid thread/fork params"),
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32036, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_COMPACT => {
                let result = match serde_json::from_value::<ThreadCompactParams>(params) {
                    Ok(params) => {
                        if thread_manager.is_turn_running(&params.thread_id) {
                            Err(anyhow::anyhow!("cannot compact while a turn is running"))
                        } else {
                            thread_manager
                                .select(&params.thread_id)
                                .context("thread/start or thread/resume is required")
                                .and_then(|target_engine| {
                                    ensure_active_thread(
                                        &target_engine,
                                        thread_manager.lease(&params.thread_id),
                                        &params.thread_id,
                                    )?;
                                    Ok((params, target_engine))
                                })
                        }
                    }
                    Err(error) => Err(error).context("invalid thread/compact params"),
                };
                match result {
                    Ok((params, target_engine)) => match target_engine.compact_conversation().await
                    {
                        Ok(result) => {
                            let response = ThreadCompactResult {
                                thread_id: params.thread_id,
                                compacted: result.did_compact,
                                pre_tokens: result.pre_compact_tokens,
                                post_tokens: result.post_compact_tokens,
                            };
                            send(
                                &outbound_tx,
                                success_response(id, serde_json::to_value(response)?),
                            )
                            .await?;
                        }
                        Err(error) => {
                            send(&outbound_tx, error_response(id, -32030, &error.to_string()))
                                .await?;
                        }
                    },
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32030, &error.to_string())).await?;
                    }
                }
            }
            method::THREAD_ROLLBACK => {
                let result = serde_json::from_value::<ThreadRollbackParams>(params)
                    .context("invalid thread/rollback params")
                    .and_then(|params| {
                        if thread_manager.is_turn_running(&params.thread_id) {
                            anyhow::bail!("cannot rollback while a turn is running")
                        }
                        let target_engine = thread_manager
                            .select(&params.thread_id)
                            .context("thread/start or thread/resume is required")?;
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&params.thread_id),
                            &params.thread_id,
                        )?;
                        let turn = params
                            .turn
                            .or_else(|| {
                                target_engine
                                    .user_request_turn_previews()
                                    .last()
                                    .map(|(turn, _)| *turn)
                            })
                            .context("thread has no user turn to rollback")?;
                        Ok((params.thread_id, turn, target_engine))
                    });
                match result {
                    Ok((thread_id, turn, target_engine)) => {
                        let turn_state = thread_manager
                            .turn_state(&thread_id)
                            .expect("resident runtime disappeared");
                        let _activity = turn_state.activity_gate.lock().await;
                        if turn_state.running.load(Ordering::SeqCst) {
                            send(
                                &outbound_tx,
                                error_response(
                                    id,
                                    -32031,
                                    "cannot rollback while a turn is running",
                                ),
                            )
                            .await?;
                            continue;
                        }
                        match target_engine.checkpoints_rewind(turn).await {
                            Ok((report, conversation)) => {
                                let followups = thread_manager
                                    .followups(&thread_id)
                                    .expect("resident runtime disappeared");
                                if let Err(error) = update_client_turn_count_after_rewind(
                                    &target_engine,
                                    &followups,
                                    conversation,
                                ) {
                                    send(
                                        &outbound_tx,
                                        error_response(id, -32031, &error.to_string()),
                                    )
                                    .await?;
                                    continue;
                                }
                                let response = ThreadRollbackResult {
                                    thread_id,
                                    turn,
                                    removed_messages: conversation
                                        .map(|value| value.removed)
                                        .unwrap_or(0),
                                    restored_files: report.restored.len(),
                                    deleted_files: report.deleted.len(),
                                    failed_files: report.failed.len(),
                                };
                                send(
                                    &outbound_tx,
                                    success_response(id, serde_json::to_value(response)?),
                                )
                                .await?;
                            }
                            Err(error) => {
                                // Rewind may already have changed memory before a durable write fails.
                                thread_manager
                                    .followups(&thread_id)
                                    .expect("resident runtime disappeared")
                                    .client_turn_count
                                    .invalidate();
                                send(&outbound_tx, error_response(id, -32031, &error.to_string()))
                                    .await?;
                            }
                        }
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32031, &error.to_string())).await?;
                    }
                }
            }
            method::THREAD_GOAL_GET => {
                let result = serde_json::from_value::<ThreadGoalParams>(params)
                    .context("invalid thread/goal/get params")
                    .and_then(|params| {
                        let goal =
                            if let Some(target_engine) = thread_manager.select(&params.thread_id) {
                                ensure_active_thread(
                                    &target_engine,
                                    thread_manager.lease(&params.thread_id),
                                    &params.thread_id,
                                )?;
                                target_engine.state.goal()
                            } else {
                                let history_path =
                                    thread_history_path(&workspace_engine, &params.thread_id)?;
                                kcoder_state::history_persisted_goal(&history_path)?
                            };
                        Ok(ThreadGoalGetResult {
                            thread_id: params.thread_id.clone(),
                            goal: goal.map(|goal| thread_goal(&params.thread_id, &goal)),
                        })
                    });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32032, &error.to_string())).await?;
                    }
                }
            }
            method::THREAD_GOAL_HISTORY => {
                let result = serde_json::from_value::<ThreadGoalParams>(params)
                    .context("invalid thread/goal/history params")
                    .and_then(|params| {
                        let (mut goals, current) =
                            if let Some(target_engine) = thread_manager.select(&params.thread_id) {
                                ensure_active_thread(
                                    &target_engine,
                                    thread_manager.lease(&params.thread_id),
                                    &params.thread_id,
                                )?;
                                (
                                    target_engine.state.goal_history(),
                                    target_engine.state.goal(),
                                )
                            } else {
                                let history_path =
                                    thread_history_path(&workspace_engine, &params.thread_id)?;
                                (
                                    kcoder_state::history_persisted_goal_history(&history_path)?,
                                    kcoder_state::history_persisted_goal(&history_path)?,
                                )
                            };
                        if let Some(goal) = current
                            && goal.status.is_history_worthy()
                            && !goals.iter().any(|entry| entry.goal_id == goal.goal_id)
                        {
                            goals.push(goal);
                        }
                        Ok(ThreadGoalHistoryResult {
                            goals: goals
                                .iter()
                                .map(|goal| thread_goal(&params.thread_id, goal))
                                .collect(),
                            thread_id: params.thread_id,
                        })
                    });
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32040, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_GOAL_SET => {
                let goal_turn_state = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .and_then(|id| thread_manager.turn_state(id));
                let _goal_gate = match goal_turn_state.as_ref() {
                    Some(state) => Some(state.activity_gate.lock().await),
                    None => None,
                };
                let goal_turn_cancel = match goal_turn_state.as_ref() {
                    Some(state) => state.active_turn.lock().await.as_ref().map(|turn| turn.cancel.clone()),
                    None => None,
                };
                let result = serde_json::from_value::<ThreadGoalSetParams>(params)
                    .context("invalid thread/goal/set params")
                    .and_then(|params| {
                        let target_engine = thread_manager
                            .select(&params.thread_id)
                            .context("thread/start or thread/resume is required")?;
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&params.thread_id),
                            &params.thread_id,
                        )?;
                        let status = params
                            .status
                            .as_deref()
                            .map(parse_goal_status)
                            .transpose()?;
                        let mode = params.mode.as_deref().map(parse_goal_mode).transpose()?;
                        let verification_kind = params
                            .verification_kind
                            .as_deref()
                            .map(parse_goal_verification_kind)
                            .transpose()?;
                        let current_goal = target_engine.state.goal();
                        if params.edit
                            && (params.expected_goal_id.is_none()
                                || params.expected_revision.is_none())
                        {
                            anyhow::bail!("goal edit requires expectedGoalId and expectedRevision")
                        }
                        ensure_goal_precondition(
                            current_goal.as_ref(),
                            params.expected_goal_id.as_deref(),
                            params.expected_revision,
                            params.require_no_goal,
                        )?;
                        if params.objective.is_some()
                            && mode == Some(GoalMode::Strict)
                            && status == Some(GoalStatus::Complete)
                        {
                            anyhow::bail!(
                                "strict goal completion must pass the update_goal verifier gate"
                            )
                        }
                        let resume_requested = params.objective.is_none() && status == Some(GoalStatus::Active) && !params.edit;
                        let followups = thread_manager.followups(&params.thread_id).context("thread has no scheduler")?;
                        let mut lifecycle = followups.goals.lock().unwrap();
                        let mut goal = if let Some(objective) = params.objective {
                            let objective = objective.trim();
                            if objective.is_empty() {
                                anyhow::bail!("goal objective must not be empty")
                            }
                            if params.edit {
                                if mode.is_some() || verification_kind.is_some() || status.is_some() {
                                    anyhow::bail!("goal edit cannot change mode, verification kind, or status")
                                }
                                let existing = target_engine
                                    .state
                                    .goal()
                                    .context("thread has no active goal")?;
                                if !existing.status.is_unfinished() {
                                    anyhow::bail!("terminal goal cannot be edited")
                                }
                                target_engine
                                    .state
                                    .edit_goal(objective, None, params.token_budget)
                                    .context("goal disappeared while editing")?
                            } else {
                            let mode = mode.unwrap_or(GoalMode::Standard);
                            let verification_kind =
                                verification_kind.unwrap_or(GoalVerificationKind::Artifact);
                            let context_snapshot = kcoder_state::goal_context_snapshot(
                                &target_engine.state.messages(),
                            );
                            let verifier_selection = if mode.is_strict() {
                                goal_pro_verifier_selection(&target_engine)
                            } else {
                                GoalVerifierSelection::default()
                            };
                            let goal = target_engine
                                .state
                                .set_goal_prepared_with_mode_and_verification_and_verifier(
                                    objective,
                                    None,
                                    params.token_budget,
                                    mode,
                                    verification_kind,
                                    verifier_selection,
                                )?;
                            let goal = if mode.is_strict() {
                                target_engine
                                    .state
                                    .set_goal_context_snapshot(context_snapshot)
                                    .unwrap_or(goal)
                            } else {
                                goal
                            };
                            match status {
                                Some(GoalStatus::Active) | None => goal,
                                Some(GoalStatus::Cancelled) => {
                                    lifecycle.invalidate();
                                    target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                                    target_engine.state.cancel_goal_by_user()?.context("goal cannot be cancelled")?
                                }
                                Some(status) => target_engine
                                    .state
                                    .update_goal_status(status)
                                    .context("goal disappeared while updating status")?,
                            }
                            }
                        } else {
                            if params.edit {
                                anyhow::bail!("goal edit requires an objective")
                            }
                            if mode.is_some() {
                                anyhow::bail!("goal mode can only be supplied when creating a goal")
                            }
                            if verification_kind.is_some() {
                                anyhow::bail!(
                                    "goal verification kind can only be supplied when creating a goal"
                                )
                            }
                            let existing = target_engine
                                .state
                                .goal()
                                .context("thread has no active goal")?;
                            ensure_goal_status_transition(existing.status, status)?;
                            if existing.mode.is_strict() && status == Some(GoalStatus::Complete) {
                                anyhow::bail!(
                                    "strict goal completion must pass the update_goal verifier gate"
                                )
                            }
                            match status {
                                Some(GoalStatus::Cancelled) => {
                                    lifecycle.invalidate();
                                    target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                                    target_engine.state.cancel_goal_by_user()?.context("goal cannot be cancelled")?
                                }
                                Some(status) if status != existing.status => target_engine
                                    .state
                                    .update_goal_status(status)
                                    .context("goal disappeared while updating status")?,
                                _ => existing,
                            }
                        };
                        if params.clear_token_budget || params.token_budget.is_some() {
                            goal = target_engine
                                .state
                                .update_goal_token_budget(params.token_budget)
                                .context("goal disappeared while updating token budget")?;
                        }
                        if goal.status == GoalStatus::Cancelled { target_engine.cancel_goal_execution(goal_turn_cancel.as_ref()); }
                        if resume_requested { lifecycle.resume(&target_engine); } else { lifecycle.invalidate(); }
                        followups.notify.notify_one();
                        Ok(ThreadGoalSetResult {
                            thread_id: params.thread_id.clone(),
                            goal: thread_goal(&params.thread_id, &goal),
                        })
                    });
                match result {
                    Ok(mut result) => {
                        if let Some(target_engine) = thread_manager.select(&result.thread_id)
                            && let Some(goal) = target_engine.state.goal()
                            && goal.mode.is_strict()
                        {
                            match kcoder_engine::agent::ensure_goal_pro_workspace_baseline(
                                &target_engine.state,
                                &goal,
                            )
                            .await
                            {
                                Ok(goal) => {
                                    result.goal = thread_goal(&result.thread_id, &goal);
                                }
                                Err(error) => {
                                    target_engine.state.clear_goal();
                                    send(
                                        &outbound_tx,
                                        error_response(
                                            id,
                                            -32033,
                                            &format!(
                                                "failed to capture Goal Pro verifier baseline; the goal was cleared: {error}"
                                            ),
                                        ),
                                    )
                                    .await?;
                                    continue;
                                }
                            }
                        }
                        if let Some(engine) = thread_manager.engine(&result.thread_id) {
                            goal_lifecycle::publish(&engine, &outbound_tx).await;
                        }
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32033, &error.to_string())).await?;
                    }
                }
            }
            method::THREAD_GOAL_CLEAR => {
                let goal_turn_state = params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .and_then(|id| thread_manager.turn_state(id));
                let _goal_gate = match goal_turn_state.as_ref() {
                    Some(state) => Some(state.activity_gate.lock().await),
                    None => None,
                };
                let goal_turn_cancel = match goal_turn_state.as_ref() {
                    Some(state) => state.active_turn.lock().await.as_ref().map(|turn| turn.cancel.clone()),
                    None => None,
                };
                let result = serde_json::from_value::<ThreadGoalParams>(params)
                    .context("invalid thread/goal/clear params")
                    .and_then(|params| {
                        let target_engine = thread_manager
                            .select(&params.thread_id)
                            .context("thread/start or thread/resume is required")?;
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&params.thread_id),
                            &params.thread_id,
                        )?;
                        let current_goal = target_engine.state.goal();
                        ensure_goal_precondition(
                            current_goal.as_ref(),
                            params.expected_goal_id.as_deref(),
                            params.expected_revision,
                            false,
                        )?;
                        let followups = thread_manager
                            .followups(&params.thread_id)
                            .context("thread has no scheduler")?;
                        let mut lifecycle = followups.goals.lock().unwrap();
                        lifecycle.invalidate();
                        followups.notify.notify_one();
                        if current_goal.as_ref().is_some_and(|goal| goal.status.is_unfinished() || goal.status.is_user_resumable()) {
                            target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                        }
                        let removed = target_engine.state.clear_goal_by_user()?;
                        Ok(ThreadGoalClearResult {
                            thread_id: params.thread_id,
                            cleared: removed.is_some(),
                        })
                    });
                match result {
                    Ok(result) => {
                        if let Some(engine) = thread_manager.engine(&result.thread_id) {
                            goal_lifecycle::publish(&engine, &outbound_tx).await;
                        }
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32034, &error.to_string())).await?;
                    }
                }
            }
            method::THREAD_AUTOMATION_SUSPEND => {
                let result = async {
                    let params: ThreadGoalParams = serde_json::from_value(params)?;
                    let turn = thread_manager
                        .turn_state(&params.thread_id)
                        .context("thread is not resident")?;
                    let _gate = turn.activity_gate.lock().await;
                    let followups = thread_manager
                        .followups(&params.thread_id)
                        .context("thread has no scheduler")?;
                    followups.goals.lock().unwrap().suspend();
                    followups.notify.notify_one();
                    Ok::<_, anyhow::Error>(json!({"suspended":true}))
                }
                .await;
                match result {
                    Ok(result) => send(&outbound_tx, success_response(id, result)).await?,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
            method::THREAD_DISPOSE => {
                let result: Result<Value> = async {
                    let params: ThreadDeleteParams = serde_json::from_value(params)?;
                    validate_thread_id(&params.thread_id)?;
                    let runtime = thread_manager.remove_ephemeral(&params.thread_id)?;
                    let disposed = runtime.is_some();
                    if engine.session_id() == params.thread_id {
                        engine = workspace_engine.clone();
                    }
                    if let Some(runtime) = runtime {
                        runtime.shutdown().await;
                    }
                    Ok(json!({"threadId":params.thread_id,"disposed":disposed}))
                }
                .await;
                let response = match result {
                    Ok(result) => success_response(id, result),
                    Err(error) => error_response(id, -32036, &error.to_string()),
                };
                send(&outbound_tx, response).await?;
            }
            method::THREAD_DELETE => {
                let parsed = serde_json::from_value::<ThreadDeleteParams>(params)
                    .context("invalid thread/delete params");
                let result = match parsed {
                    Err(error) => Err(error),
                    Ok(params) => {
                        async {
                            // Lock the cross-process lifecycle before removing the resident runtime,
                            // eliminating the window between closing its lease and deleting persisted
                            // files in which another app-server could recover the same thread.
                            let _lifecycle_lock = acquire_thread_lifecycle_locks(
                                &workspace_engine,
                                &[params.thread_id.as_str()],
                            )?;
                            let mut resident_paths = None;
                            let resident = thread_manager
                                .remove_if_idle(&params.thread_id)
                                .map_err(|()| {
                                    anyhow::anyhow!(
                                        "cannot delete while the resident runtime is active"
                                    )
                                })?;
                            if engine.session_id() == params.thread_id {
                                engine = workspace_engine.clone();
                            }
                            if let Some(runtime) = resident {
                                resident_paths = Some(runtime.persistence_paths());
                                runtime.shutdown().await;
                            }
                            (|| {
                                // Repeat every mutable path and ownership check under the stable lifecycle lock.
                                let history_path = resident_paths
                                    .as_ref()
                                    .and_then(|(history_path, _)| history_path.clone())
                                    .map(Ok)
                                    .unwrap_or_else(|| {
                                        thread_history_path(&workspace_engine, &params.thread_id)
                                    })?;
                                let resident_history = resident_paths
                                    .as_ref()
                                    .is_some_and(|(history, _)| history.is_some());
                                let lease = if history_path.exists() {
                                    Some(SessionLease::acquire_existing_history(&history_path)?)
                                } else if resident_history {
                                    Some(SessionLease::acquire(&history_path)?)
                                } else {
                                    None
                                };
                                let mut deleted_files = if history_path.exists() || resident_history
                                {
                                    kcoder_state::delete_session_history_files(&history_path)?
                                } else {
                                    Vec::new()
                                };
                                if let Some(state_path) = resident_paths
                                    .as_ref()
                                    .and_then(|(_, state_path)| state_path.as_ref())
                                    && state_path.exists()
                                {
                                    std::fs::remove_file(state_path).with_context(|| {
                                        format!(
                                            "failed to delete session state {}",
                                            state_path.display()
                                        )
                                    })?;
                                    deleted_files.push(state_path.clone());
                                }
                                let client_artifacts =
                                    workspace_engine.session_storage_dir_for(&params.thread_id);
                                match std::fs::symlink_metadata(&client_artifacts) {
                                    Ok(metadata) if metadata.file_type().is_dir() => {
                                        std::fs::remove_dir_all(&client_artifacts).with_context(
                                            || {
                                                format!(
                                                    "failed to delete client session artifacts {}",
                                                    client_artifacts.display()
                                                )
                                            },
                                        )?;
                                        deleted_files.push(client_artifacts);
                                    }
                                    Ok(_) => anyhow::bail!(
                                        "client session artifact path is not a directory: {}",
                                        client_artifacts.display()
                                    ),
                                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                                    Err(error) => return Err(error.into()),
                                }
                                drop(lease);
                                // Retain the stable lease file for handles already opened by peers.
                                Ok(ThreadDeleteResult {
                                    thread_id: params.thread_id,
                                    deleted: true,
                                    deleted_files: deleted_files.len(),
                                })
                            })()
                        }
                        .await
                    }
                };
                match result {
                    Ok(result) => {
                        send(
                            &outbound_tx,
                            success_response(id, serde_json::to_value(result)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32035, &error.to_string())).await?;
                    }
                }
            }
            "turn/start" => {
                let turn_params = match serde_json::from_value::<TurnStartParams>(params.clone()) {
                    Ok(params) => params,
                    Err(error) => {
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                };
                if let Err(error) = turn_params.validate_model_selection() {
                    send(&outbound_tx, error_response(id, -32602, error)).await?;
                    continue;
                }
                let requested_permission_mode = match turn_params
                    .permission_mode
                    .as_ref()
                    .map(|mode| {
                        serde_json::from_value::<kcoder_config::PermissionMode>(json!(mode))
                    })
                    .transpose()
                {
                    Ok(mode) => mode,
                    Err(error) => {
                        send(
                            &outbound_tx,
                            error_response(id, -32602, &format!("invalid permissionMode: {error}")),
                        )
                        .await?;
                        continue;
                    }
                };
                if !thread_manager.owns(&turn_params.thread_id) {
                    let (code, message) = if thread_manager.is_empty() {
                        (-32024, "thread/start or thread/resume is required")
                    } else {
                        (-32025, "turn threadId does not match active thread")
                    };
                    send(&outbound_tx, error_response(id, code, message)).await?;
                    continue;
                }
                let turn_state = thread_manager
                    .turn_state(&turn_params.thread_id)
                    .expect("resident runtime has turn state");
                let turn_running = Arc::clone(&turn_state.running);
                let active_turn = Arc::clone(&turn_state.active_turn);
                let question_context = Arc::clone(&turn_state.question_context);
                let approval_context = Arc::clone(&turn_state.approval_context);
                let permission_prompt = turn_state.permission_prompt.clone();
                let Some(turn_registration) = turn_state.claim_turn_registration().await else {
                    send(
                        &outbound_tx,
                        error_response(id, TURN_ALREADY_RUNNING, "Turn already running"),
                    )
                    .await?;
                    continue;
                };
                engine = thread_manager
                    .select(&turn_params.thread_id)
                    .expect("resident runtime disappeared under activity gate");
                if !thread_manager
                    .lease(&turn_params.thread_id)
                    .is_some_and(|lease| lease.matches_engine(&engine))
                {
                    turn_running.store(false, Ordering::SeqCst);
                    send(
                        &outbound_tx,
                        error_response(id, -32024, "thread/start or thread/resume is required"),
                    )
                    .await?;
                    continue;
                }
                let background_projection = thread_manager
                    .projection(&turn_params.thread_id)
                    .expect("resident runtime has projection state");
                let background_followups = thread_manager
                    .followups(&turn_params.thread_id)
                    .expect("resident runtime has follow-up state");
                let continuing = turn_params.retry_from_turn_id.is_some();
                let legacy_turn_count = thread_manager
                    .volatile_turn_count(&turn_params.thread_id)
                    .max(engine.client_turn_count());
                let latest_turn = match turn_admissions::latest(&engine, &turn_params.thread_id, legacy_turn_count) {
                    Ok(number) => number,
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                        continue;
                    }
                };
                if turn_params.retry_from_attempt_id.is_some() && turn_params.retry_from_turn_id.is_none() {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32602, "retryFromAttemptId requires retryFromTurnId")).await?;
                    continue;
                }
                if let Some(failed_turn_id) = turn_params.retry_from_turn_id.as_deref() {
                    let replay_result = if let Some(attempt) = turn_params.retry_from_attempt_id.as_deref() {
                        turn_attempts::request_fingerprint(&turn_params).and_then(|fingerprint| turn_attempts::retry_admission(&engine, &turn_params.thread_id, failed_turn_id, attempt, turn_params.retry_operation_id.as_deref(), &fingerprint,
                            turn_params.retry_model_configuration != Some(kcoder_types::RetryModelConfiguration::Current) && turn_params.model.is_none() && turn_params.reasoning_effort.is_none() && turn_params.proxy_url.is_none() && turn_params.service_tier.is_none()))
                    } else { replay_accepted_continuation(
                        &engine, &turn_params.thread_id, failed_turn_id, latest_turn,
                    ) };
                    let replayed = match replay_result {
                        Ok(replayed) => replayed,
                        Err(error) => {
                            turn_running.store(false, Ordering::SeqCst);
                            background_followups.notify.notify_waiters();
                            send(&outbound_tx, error_response(id, -32046, &error.to_string())).await?;
                            continue;
                        }
                    };
                    if let Some(replayed) = replayed {
                        // A lost response gets the existing attempt without executing it again.
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(&outbound_tx, success_response(id, replayed)).await?;
                        continue;
                    }
                }
                let retry_operation_id = turn_params
                    .retry_operation_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                if let Some(failed_turn_id) = turn_params.retry_from_turn_id.as_deref() {
                    // A retry operation names one recovery. Finding it committed
                    // under another failed turn is an identity conflict, not a
                    // missing recovery point (S2/R034 family).
                    if let Some(operation) = retry_operation_id
                        && let Some(committed) = turn_continuation_for_operation(
                            &engine,
                            &turn_params.thread_id,
                            operation,
                        )
                        && committed.turn_id != failed_turn_id
                    {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(
                            &outbound_tx,
                            error_response(
                                id,
                                -32047,
                                &format!(
                                    "retry operation {operation} was already committed as {}; query that attempt instead",
                                    committed.turn_id
                                ),
                            ),
                        )
                        .await?;
                        continue;
                    }
                    let validation = (|| -> Result<()> {
                        anyhow::ensure!(
                            turn_params.input.is_empty()
                                && turn_params.client_message_id.is_none()
                                && turn_params.turn_mode.is_none(),
                            "Continuation cannot submit another user input or execution mode"
                        );

                        failed_turn::validate(&engine, failed_turn_id, latest_turn)?;
                        Ok(())
                    })();
                    if let Err(error) = validation {
                        turn_running.store(false, Ordering::SeqCst);
                        send(&outbound_tx, error_response(id, -32046, &error.to_string())).await?;
                        continue;
                    }
                }
                if !continuing && let Some(operation) = retry_operation_id {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(
                        &outbound_tx,
                        error_response(
                            id,
                            -32602,
                            &format!(
                                "retry operation {operation} requires a failed turn to continue"
                            ),
                        ),
                    )
                    .await?;
                    continue;
                }
                if !continuing
                    && let Some(client_message_id) = turn_params
                        .client_message_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    && !turn_params.resubmit.unwrap_or(false)
                {
                    let committed = load_turn_client_message_ids(&engine, &turn_params.thread_id);
                    if let Some(existing_turn) =
                        committed_turn_for_client_message(&committed, client_message_id)
                    {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(
                            &outbound_tx,
                            error_response(
                                id,
                                -32047,
                                &format!(
                                    "client message {client_message_id} was already committed as {existing_turn}; resubmit to start another attempt"
                                ),
                            ),
                        )
                        .await?;
                        continue;
                    }
                }
                let prepared_model = if continuing {
                    turn_attempts::prepare_continuation_model(&engine, &turn_params)
                } else if turn_params.model_selection_mode == Some(kcoder_types::ModelSelectionMode::FollowTargetDefault) {
                    engine.follow_target_default_model()
                } else {
                    engine.prepare_client_model_for_turn(turn_params.model.as_deref(), continuing)
                };
                if let Err(error) = prepared_model {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
                if !continuing && let Some(reasoning_effort) = turn_params.reasoning_effort.as_deref()
                    && let Err(error) = engine.set_client_reasoning_effort(reasoning_effort)
                {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
                if !continuing && (turn_params.proxy_url.is_some() || turn_params.service_tier.is_some())
                    && let Err(error) = engine.set_client_runtime_options(
                        turn_params.proxy_url.as_deref(),
                        turn_params.service_tier.as_deref(),
                    )
                {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    continue;
                }
                let Some(prompt) = (if continuing {
                    Some(String::new())
                } else {
                    prompt_from_params(&params)
                }) else {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(
                        &outbound_tx,
                        error_response(id, -32602, "turn/start requires non-empty prompt"),
                    )
                    .await?;
                    continue;
                };
                let turn_mode = turn_params.turn_mode.unwrap_or_default();
                if turn_mode == kcoder_app_protocol::TurnExecutionMode::MoaPlan {
                    let preflight = engine.moa_plan_preflight().and_then(|_| {
                        anyhow::ensure!(
                            turn_params.input.iter().all(|input| matches!(
                                input,
                                kcoder_app_protocol::UserInput::Text { .. }
                            )),
                            "MoA planning requires a text planning request"
                        );
                        anyhow::ensure!(
                            !prompt.contains("<kcoder_attachments "),
                            "MoA planning requires a text planning request"
                        );
                        Ok(())
                    });
                    if let Err(error) = preflight {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                }
                if let Err(error) = engine.acknowledge_orchestrate_user_input() {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    let response =
                        protocol_io::local_runtime_error_response(id, &error.to_string());
                    send(&outbound_tx, response).await?;
                    continue;
                }
                // The counter is initialized from the durable transcript on resume and reset on
                // thread/start. Keeping it in the owning app-server process avoids racing the
                // asynchronous first JSONL flush while remaining independent of compacted model
                // context.
                // Scheduled prompts can append genuine user-role turns between
                // explicit requests. Never reuse their durable turn numbers.
                if background_followups.client_turn_count.get().is_none() {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32022,
                        "resident turn count is unavailable; resume the thread before starting another turn")).await?;
                    continue;
                }
                let completed_turns = thread_manager
                    .volatile_turn_count(&turn_params.thread_id)
                    .max(engine.client_turn_count());
                thread_manager.set_volatile_turn_count(&turn_params.thread_id, completed_turns);
                let turn_id = turn_params
                    .retry_from_turn_id
                    .clone()
                    .unwrap_or_else(|| format!("turn-{}", latest_turn.saturating_add(1)));
                let thread_id = engine.session_id();
                let task_attempt_id = if continuing {
                    format!("{}-retry-{}", turn_id, uuid::Uuid::new_v4())
                } else { turn_id.clone() };
                let task_attempt_identity = kcoder_types::TurnAttemptIdentity {
                    thread_id: thread_id.clone(), turn_id: turn_id.clone(), attempt_id: task_attempt_id.clone(),
                };
                if let Err(error) = turn_attempts::save_model_snapshot(&engine, &task_attempt_identity) {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                    continue;
                }
                // Only validated requests may acquire an accepted-operation identity.
                // Otherwise an invalid model/proxy request poisons the valid retry that follows.
                if continuing {
                    let receipt = input_context_hash(&engine.state.messages()).and_then(|hash| {
                        save_turn_continuation_receipt(
                            &engine, &thread_id, &turn_id, &hash, retry_operation_id,
                        )
                    });
                    if let Err(error) = receipt {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                        continue;
                    }
                }
                if let Err(error) = clear_turn_outcome(&engine, &thread_id, &turn_id) {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                    continue;
                }
                if !continuing
                    && let Err(error) = save_turn_client_message_id(
                        &engine,
                        &thread_id,
                        &turn_id,
                        turn_params.client_message_id.as_deref(),
                    )
                {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                    continue;
                }
                let prompt = match materialize_turn_attachments(
                    &engine,
                    &thread_id,
                    &turn_id,
                    &prompt,
                    &mut attachment_directories,
                ) {
                    Ok(prompt) => prompt,
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                };
                let model_message = match model_message_from_materialized_prompt(&prompt) {
                    Ok(Some(message)) => message,
                    Ok(None) => kcoder_types::Message::user_text(prompt.clone()),
                    Err(error) => {
                        turn_running.store(false, Ordering::SeqCst);
                        background_followups.notify.notify_waiters();
                        send(&outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                        continue;
                    }
                };
                if !continuing && let Err(error) = turn_admissions::accept(&engine, &thread_id, latest_turn.saturating_add(1)) {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                    continue;
                }
                let mut attempt_inputs = engine.state.messages();
                if !continuing { attempt_inputs.push(model_message.clone()); }
                let attempt_start = serde_json::to_vec(&attempt_inputs)
                    .context("failed to hash attempt context")
                    .and_then(|bytes| turn_attempts::begin(&engine, &task_attempt_identity,
                        continuing, retry_operation_id, hex_sha256(&bytes), turn_attempts::request_fingerprint(&turn_params)?));
                if let Err(error) = attempt_start {
                    turn_running.store(false, Ordering::SeqCst);
                    background_followups.notify.notify_waiters();
                    send(&outbound_tx, error_response(id, -32603, &error.to_string())).await?;
                    continue;
                }
                let turn_artifact_dir = engine
                    .session_storage_dir_for(&thread_id)
                    .join("turn-file-changes");
                send(
                    &outbound_tx,
                    success_response(id, json!({"turn": {"id": turn_id, "threadId": thread_id, "attemptId": task_attempt_id, "status": "running"}})),
                )
                .await?;

                let cancel = CancellationToken::new();
                let task_engine = state.configure_turn_engine(&engine, cancel.clone());
                let task_tx = outbound_tx.clone();
                let task_running = Arc::clone(&turn_running);
                let task_turn_id = turn_id.clone();
                let task_thread_id = thread_id.clone();
                let task_server_id = server_id.clone();
                let task_sequence = Arc::clone(&sequence);
                let task_cancel = cancel.clone();
                let task_projection = Arc::new(Mutex::new(StreamProjection::new(
                    task_server_id.clone(),
                    task_thread_id.clone(),
                    task_turn_id.clone(),
                    Arc::clone(&task_sequence),
                )));
                task_projection.lock().await.item_namespace = task_attempt_id.clone();
                set_active_background_projection(
                    &background_projection,
                    &task_thread_id,
                    &task_turn_id,
                    Arc::clone(&task_projection),
                )
                .await;
                let task_background_projection = Arc::clone(&background_projection);
                let task_background_followups = Arc::clone(&background_followups);
                *question_context
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(QuestionContext {
                    server_id: task_server_id.clone(),
                    thread_id: task_thread_id.clone(),
                    turn_id: task_turn_id.clone(),
                });
                *approval_context
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ApprovalContext {
                    server_id: task_server_id.clone(),
                    thread_id: task_thread_id.clone(),
                    turn_id: task_turn_id.clone(),
                });
                let task_turn_state = turn_state.clone();
                let mut task_permission_prompt = permission_prompt.clone();
                if let Some(mode) = requested_permission_mode {
                    task_permission_prompt.mode = mode;
                }
                let task_artifact_dir = turn_artifact_dir.clone();
                let task_workspace = engine.state.cwd().to_path_buf();
                let task_snapshot_policy =
                    engine.settings.read().unwrap().turn_file_changes.clone();
                let goal_turn = task_background_followups.goals.lock().unwrap().begin(
                    &task_engine,
                    requested_permission_mode,
                    None,
                );
                let handle = tokio::spawn(async move {
                    let turn_permissions = turn_permissions::TurnPermissions::new(
                        task_engine.clone(),
                        requested_permission_mode,
                    );
                    let _ = send(
                        &task_tx,
                        notification(
                            "turn/started",
                            with_event_context(
                                &task_server_id,
                                &task_thread_id,
                                Some(&task_turn_id),
                                &task_sequence,
                                json!({"attemptId": task_attempt_id, "turn": {
                                    "id": task_turn_id,
                                    "threadId": task_thread_id,
                                    "status": "running"
                                }}),
                            ),
                        ),
                    )
                    .await;
                    let moa_plan_baseline = (turn_mode
                        == kcoder_app_protocol::TurnExecutionMode::MoaPlan)
                        .then(|| task_engine.client_turn_count());
                    let mut counted_user_message = false;
                    let mut stream = if continuing {
                        turn_execution::continue_failed(task_engine.clone(), task_permission_prompt)
                    } else {
                        turn_execution::stream(
                            task_engine.clone(),
                            model_message,
                            prompt,
                            task_permission_prompt,
                            turn_mode,
                            task_cancel.clone(),
                        )
                    };
                    let mut before_tree = None;
                    let mut snapshot_attempted = false;
                    let mut status = "completed";
                    let mut terminal_error = None;
                    let mut provider_failure = None;
                    let mut terminal_outcome_persisted = false;
                    let mut attempt_partial = turn_attempts::PartialOutput::default();
                    while let Some(event) = stream.next().await {
                        attempt_partial.observe(&event);
                        if !counted_user_message
                            && explicit_turn_appended_user_message(
                                &task_engine,
                                &event,
                                moa_plan_baseline,
                            )
                        {
                            if let Err(error) =
                                task_background_followups.client_turn_count.increment()
                            {
                                status = "failed";
                                terminal_error = Some(error.to_string());
                                break;
                            }
                            if !continuing && let Err(error) = turn_admissions::bind_user(&task_engine, &task_thread_id, &task_turn_id) {
                                status = "failed";
                                terminal_error = Some(error.to_string());
                                break;
                            }
                            counted_user_message = true;
                        }
                        // ToolUseStarted yields the event stream before actual execution. Send the
                        // state to the client, then establish a file baseline as needed before the next poll executes the tool.
                        let should_snapshot = !snapshot_attempted
                            && matches!(
                                &event,
                                EngineEvent::ToolUseStarted { name, input, .. }
                                    if tool_may_mutate_workspace(name, input)
                            );
                        if let Some((next_status, error)) =
                            terminal_outcome(&event, task_cancel.is_cancelled())
                        {
                            status = next_status;
                            terminal_error = Some(error.clone());
                            provider_failure = match &event {
                                EngineEvent::ProviderFailed { details, .. } => {
                                    Some(details.clone())
                                }
                                _ => None,
                            };
                            // The page may refresh immediately after a terminal notification reaches the
                            // client. Make failure/interruption artifacts readable first so thread/read
                            // never temporarily restores history without its failure card.
                            match save_turn_outcome_with_continuation(
                                &task_engine,
                                &task_thread_id,
                                &task_turn_id,
                                status,
                                Some(&error),
                                provider_failure.as_ref(),
                                turn_mode == kcoder_app_protocol::TurnExecutionMode::Standard,
                            ) {
                                Ok(()) => terminal_outcome_persisted = true,
                                Err(error) => {
                                    tracing::warn!(%error, turn_id = %task_turn_id, "failed to persist terminal turn outcome before projection")
                                }
                            }
                        }
                        if let EngineEvent::ToolUseStarted { id, name, .. } = &event
                            && tool_can_spawn_managed_background_job(name)
                        {
                            register_background_tool_call(
                                &task_background_projection,
                                id,
                                &task_thread_id,
                                &task_turn_id,
                                Arc::clone(&task_projection),
                            )
                            .await;
                        }
                        // Background lifecycle presentation is owned exclusively by the
                        // connection-level broadcast pump. The engine stream may also surface a
                        // terminal event for conversation injection; projecting it here would
                        // duplicate the same job on the wire.
                        let messages = if background_event_id(&event).is_some() {
                            if project_managed_background_event(
                                &task_engine,
                                &task_background_projection,
                                &task_tx,
                                event,
                            )
                            .await
                            .is_err()
                            {
                                task_turn_state.clear_pending();
                                task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                                task_running.store(false, Ordering::SeqCst);
                                task_background_followups.notify.notify_waiters();
                                clear_active_background_projection(
                                    &task_background_projection,
                                    &task_thread_id,
                                    &task_turn_id,
                                )
                                .await;
                                return;
                            }
                            Vec::new()
                        } else {
                            task_projection.lock().await.project(event)
                        };
                        for message in messages {
                            if send(&task_tx, message).await.is_err() {
                                task_turn_state.clear_pending();
                                task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                                task_running.store(false, Ordering::SeqCst);
                                task_background_followups.notify.notify_waiters();
                                clear_active_background_projection(
                                    &task_background_projection,
                                    &task_thread_id,
                                    &task_turn_id,
                                )
                                .await;
                                return;
                            }
                        }
                        if should_snapshot && task_snapshot_policy.enabled {
                            snapshot_attempted = true;
                            before_tree = match capture_worktree_tree_with_policy(
                                &task_workspace,
                                &task_artifact_dir,
                                &task_turn_id,
                                "before",
                                &task_snapshot_policy,
                            )
                            .await
                            {
                                Ok(snapshot) => snapshot,
                                Err(error) => {
                                    tracing::warn!(%error, turn_id = %task_turn_id, "failed to snapshot worktree before mutating app-server tool");
                                    None
                                }
                            };
                        }
                        if status != "completed" {
                            break;
                        }
                    }
                    if task_cancel.is_cancelled() {
                        status = "interrupted";
                        terminal_error = Some("cancelled by user".into());
                        provider_failure = None;
                        terminal_outcome_persisted = false;
                    }
                    let publish_goal =
                        goal_turn.tracks_goal() || task_engine.state.goal().is_some();
                    task_background_followups.goals.lock().unwrap().finish(
                        &task_engine,
                        goal_turn,
                        status,
                        provider_failure.as_ref(),
                    );
                    if publish_goal {
                        goal_lifecycle::publish(&task_engine, &task_tx).await;
                    }
                    if let Err(error) = task_engine.state.flush_history().await {
                        tracing::warn!(%error, turn_id = %task_turn_id, "failed to flush app-server transcript before turn completion");
                    }
                    if !terminal_outcome_persisted
                        && let Err(error) = save_turn_outcome_with_continuation(
                            &task_engine,
                            &task_thread_id,
                            &task_turn_id,
                            status,
                            terminal_error.as_deref(),
                            provider_failure.as_ref(),
                            turn_mode == kcoder_app_protocol::TurnExecutionMode::Standard,
                        )
                    {
                        tracing::warn!(%error, turn_id = %task_turn_id, "failed to persist terminal turn outcome");
                    }
                    if let Err(error) = turn_attempts::finish(&task_engine, &task_attempt_identity,
                        status, terminal_error.as_deref(), provider_failure.as_ref(), &attempt_partial) {
                        tracing::warn!(%error, turn_id = %task_turn_id, "failed to persist attempt terminal evidence");
                    }
                    let file_changes = match before_tree {
                        Some(before_tree) => match finalize_turn_file_changes_with_policy(
                            &task_workspace,
                            &task_artifact_dir,
                            &task_thread_id,
                            &task_turn_id,
                            before_tree,
                            &task_snapshot_policy,
                        )
                        .await
                        {
                            Ok(Some(artifact)) => Some(turn_file_changes_summary(&artifact)),
                            Ok(None) => None,
                            Err(error) => {
                                tracing::warn!(%error, turn_id = %task_turn_id, "failed to create turn file changes artifact");
                                None
                            }
                        },
                        None => None,
                    };
                    drop(turn_permissions);
                    task_turn_state.clear_pending();
                    task_turn_state.clear_matching_turn(&task_thread_id, &task_turn_id);
                    let _ = send(
                        &task_tx,
                        notification(
                            "turn/completed",
                            with_event_context(
                                &task_server_id,
                                &task_thread_id,
                                Some(&task_turn_id),
                                &task_sequence,
                                json!({
                                    "turn": {
                                        "id": task_turn_id,
                                        "threadId": task_thread_id,
                                        "status": status,
                                    },
                                    "error": turn_completion_error(terminal_error, provider_failure),
                                    "fileChanges": file_changes,
                                }),
                            ),
                        ),
                    )
                    .await;
                    clear_active_background_projection(
                        &task_background_projection,
                        &task_thread_id,
                        &task_turn_id,
                    )
                    .await;
                    task_running.store(false, Ordering::SeqCst);
                    task_background_followups.notify.notify_waiters();
                });
                *active_turn.lock().await = Some(ActiveTurn {
                    handle,
                    cancel,
                    thread_id,
                    turn_id,
                });
                drop(turn_registration);
            }
            "turn/shorten_wait" => {
                let requested_thread = params.get("threadId").and_then(Value::as_str);
                let requested_turn = params.get("turnId").and_then(Value::as_str);
                let candidate_states = if let Some(thread_id) = requested_thread {
                    thread_manager.turn_state(thread_id).into_iter().collect()
                } else {
                    thread_manager.turn_states()
                };
                let mut matched_thread_id = None;
                for turn_state in candidate_states {
                    if !turn_state.running.load(Ordering::SeqCst) {
                        continue;
                    }
                    let guard = turn_state.active_turn.lock().await;
                    // Peek only: the active-turn record must survive the
                    // shorten request, or a following `turn/interrupt` could
                    // no longer match and cancel the same turn.
                    matched_thread_id = guard
                        .as_ref()
                        .filter(|active| active.matches(requested_thread, requested_turn))
                        .map(|active| active.thread_id.clone());
                    if matched_thread_id.is_some() {
                        break;
                    }
                }
                let Some(thread_id) = matched_thread_id else {
                    send(
                        &outbound_tx,
                        success_response(id, json!({"shortened": false})),
                    )
                    .await?;
                    continue;
                };
                // TUI Escape 的第一段语义：把运行中的 Sleep/wait 剩余等待折叠到
                // 短宽限期，turn 继续而不是取消。信号是一次性的，对之后才启动
                // 的等待无效；没有 waiter 时调用也无害。
                let shortened = thread_manager
                    .engine(&thread_id)
                    .map(|engine| {
                        engine.shorten_waiting_tools();
                        true
                    })
                    .unwrap_or(false);
                send(
                    &outbound_tx,
                    success_response(id, json!({"shortened": shortened})),
                )
                .await?;
                continue;
            }
            "turn/interrupt" => {
                let requested_thread = params.get("threadId").and_then(Value::as_str);
                let requested_turn = params.get("turnId").and_then(Value::as_str);
                let candidate_states = if let Some(thread_id) = requested_thread {
                    thread_manager.turn_state(thread_id).into_iter().collect()
                } else {
                    thread_manager.turn_states()
                };
                let mut matched = None;
                for turn_state in candidate_states {
                    if !turn_state.running.load(Ordering::SeqCst) {
                        continue;
                    }
                    let mut guard = turn_state.active_turn.lock().await;
                    if guard
                        .as_ref()
                        .is_some_and(|active| active.matches(requested_thread, requested_turn))
                    {
                        matched = guard.take().map(|active| (turn_state.clone(), active));
                        break;
                    }
                }
                let Some((turn_state, active)) = matched else {
                    send(
                        &outbound_tx,
                        success_response(id, json!({"interrupted": false})),
                    )
                    .await?;
                    continue;
                };
                let interrupted_thread_id = active.thread_id.clone();
                {
                    let _gate = turn_state.activity_gate.lock().await;
                    if let Some(followups) = thread_manager.followups(&interrupted_thread_id) {
                        followups.goals.lock().unwrap().suspend();
                    }
                    if let Some(engine) = thread_manager.engine(&interrupted_thread_id)
                        && engine
                            .state
                            .goal()
                            .is_some_and(|goal| goal.status.is_active())
                    {
                        engine.state.update_goal_status(GoalStatus::Paused);
                        goal_lifecycle::publish(&engine, &outbound_tx).await;
                    }
                }
                active.cancel.cancel();
                send(
                    &outbound_tx,
                    success_response(id, json!({"interrupted": true})),
                )
                .await?;
                let background_projection = thread_manager
                    .projection(&interrupted_thread_id)
                    .expect("matched resident turn has projection state");
                let background_followups = thread_manager
                    .followups(&interrupted_thread_id)
                    .expect("matched resident turn has follow-up state");
                cancel_active_turn_bounded(
                    active,
                    &turn_state,
                    &background_projection,
                    &background_followups,
                )
                .await;
            }
            _ => {
                send(&outbound_tx, error_response(id, -32601, "Method not found")).await?;
            }
        }
    }

    drop(automations);
    plugin_processor.cancel();
    indexed_read_tasks.abort_all();
    while indexed_read_tasks.join_next().await.is_some() {}
    drop(storage_scans);
    provider_tasks.abort_all();
    while provider_tasks.join_next().await.is_some() {}
    if tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(result) = plugin_tasks.join_next().await {
            if let Err(error) = result {
                tracing::warn!(%error, "app-server plugin request task failed during shutdown");
            }
        }
    })
    .await
    .is_err()
    {
        plugin_tasks.abort_all();
        while plugin_tasks.join_next().await.is_some() {}
    }
    let diagnostic_deadline =
        std::time::Instant::now() + thread_runtime::DIAGNOSTIC_SHUTDOWN_TIMEOUT;
    for runtime in thread_manager.drain() {
        runtime
            .shutdown_with_diagnostic_deadline(diagnostic_deadline)
            .await;
    }
    workspace_engine.prepare_session_replacement();
    workspace_engine
        .flush_workspace_diagnostics_until(diagnostic_deadline)
        .await;
    terminals.shutdown_all();
    drop(_terminal_guard);
    drop(terminals);
    browsers.shutdown_all().await;
    drop(browsers);
    drop(attachment_directories);
    drop(outbound_tx);
    // Explicitly release host aliases before process::exit skips stack destructors.
    // The selected engine may still own an ephemeral session after its runtime is drained.
    drop(engine);
    drop(engine_factory);
    drop(workspace_engine);
    #[cfg(unix)]
    if terminated_by_signal {
        // Tokio's process-global stdin reader uses a blocking read which cannot be cancelled.
        // Returning from this async function after SIGTERM can therefore leave runtime shutdown
        // waiting forever. All owned subprocesses and temporary data are explicitly released
        // above, so terminate the app-server itself without waiting on that blocked reader.
        writer.abort();
        std::process::exit(0);
    }
    let writer_result = match tokio::time::timeout(Duration::from_secs(2), &mut writer).await {
        Ok(result) => result
            .context("app-server stdout task failed")
            .and_then(|result| result),
        Err(_) => {
            writer.abort();
            let _ = writer.await;
            if idle_shutdown_requested {
                Err(anyhow::anyhow!("idle shutdown stdout flush timed out"))
            } else {
                Ok(())
            }
        }
    };
    if idle_shutdown_requested {
        // The stdin blocking reader can still be waiting; owned resources were released above.
        std::process::exit(if writer_result.is_ok() { 0 } else { 1 });
    }
    writer_result
}

#[cfg(test)]
async fn capture_worktree_tree(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
) -> Result<Option<GitTreeSnapshot>> {
    capture_worktree_tree_with_policy(
        workspace,
        artifact_dir,
        turn_id,
        stage,
        &kcoder_config::TurnFileChangesSettings::default(),
    )
    .await
}

async fn capture_worktree_tree_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<Option<GitTreeSnapshot>> {
    let probe = run_git_command(
        workspace,
        &["rev-parse", "--is-inside-work-tree"],
        4096,
        Duration::from_secs(10),
    )
    .await?;
    let backend = if probe.success && probe.stdout.as_str().map(str::trim) == Some("true") {
        GitSnapshotBackend::Workspace
    } else {
        GitSnapshotBackend::Isolated
    };
    capture_worktree_tree_with_backend(workspace, artifact_dir, turn_id, stage, backend, policy)
        .await
        .map(Some)
}

/// Output bound for snapshot path listings (they are NUL-separated paths).
const SNAPSHOT_PATH_LISTING_BYTES: usize = 8 * 1024 * 1024;

/// Decides which staged paths stay out of a snapshot.
///
/// `size_of` receives the repository-relative path so callers can stat the
/// worktree without this helper touching the filesystem.
pub(super) fn snapshot_exclusions(
    policy: &kcoder_config::TurnFileChangesSettings,
    ignore: &globset::GlobSet,
    staged_paths: &[String],
    mut size_of: impl FnMut(&str) -> u64,
) -> Vec<String> {
    staged_paths
        .iter()
        .filter(|path| {
            let relative = Path::new(path.as_str());
            policy.excludes(relative, ignore) || policy.file_exceeds_limit(size_of(path))
        })
        .cloned()
        .collect()
}

async fn run_snapshot_git_command(
    workspace: &Path,
    args: &[&str],
    private_git_dir: Option<&Path>,
    index_path: &Path,
    stdin: Option<&str>,
) -> Result<DeviceExecuteResult> {
    let timeout = Duration::from_secs(30);
    match private_git_dir {
        Some(git_dir) => {
            run_git_command_with_private_repository(
                workspace,
                args,
                git_dir,
                Some(workspace),
                Some(index_path),
                stdin,
                SNAPSHOT_PATH_LISTING_BYTES,
                timeout,
            )
            .await
        }
        None => match stdin {
            Some(stdin) => {
                run_git_command_with_index_and_stdin(
                    workspace,
                    args,
                    index_path,
                    stdin,
                    SNAPSHOT_PATH_LISTING_BYTES,
                    timeout,
                )
                .await
            }
            None => {
                run_git_command_with_index(
                    workspace,
                    args,
                    index_path,
                    SNAPSHOT_PATH_LISTING_BYTES,
                    timeout,
                )
                .await
            }
        },
    }
}

/// Drops staged entries the snapshot policy excludes (ignored globs, oversized files).
async fn prune_policy_excluded_paths(
    workspace: &Path,
    private_git_dir: Option<&Path>,
    index_path: &Path,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<usize> {
    if !policy.enabled || (policy.ignore_globs.is_empty() && policy.max_file_bytes == 0) {
        return Ok(0);
    }
    let ignore = policy.compile_ignore_globs()?;
    let listing = run_snapshot_git_command(
        workspace,
        &["ls-files", "-z", "--cached"],
        private_git_dir,
        index_path,
        None,
    )
    .await?;
    if !listing.success {
        anyhow::bail!("failed to list staged snapshot paths: {}", listing.stderr);
    }
    let staged: Vec<String> = listing
        .stdout
        .as_str()
        .unwrap_or_default()
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect();
    let excluded = snapshot_exclusions(policy, &ignore, &staged, |path| {
        std::fs::metadata(workspace.join(path))
            .map(|meta| meta.len())
            .unwrap_or_default()
    });
    if excluded.is_empty() {
        return Ok(0);
    }
    let stdin = format!("{}\0", excluded.join("\0"));
    let removal = run_snapshot_git_command(
        workspace,
        &["update-index", "--force-remove", "-z", "--stdin"],
        private_git_dir,
        index_path,
        Some(&stdin),
    )
    .await?;
    if !removal.success {
        anyhow::bail!(
            "failed to prune excluded snapshot paths: {}",
            removal.stderr
        );
    }
    Ok(excluded.len())
}

fn private_snapshot_repository(artifact_dir: &Path, turn_id: &str) -> PathBuf {
    artifact_dir.join(format!(
        "snapshot-repository-{}",
        hex_sha256(turn_id.as_bytes())
    ))
}

#[derive(Debug)]
struct RemovePrivateDirectoryOnDrop {
    path: PathBuf,
    _lease: std::fs::File,
}

#[derive(Debug)]
struct RemovePrivateFileOnDrop(PathBuf);

impl Drop for RemovePrivateFileOnDrop {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.0)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, path = %self.0.display(), "failed to remove private Git index");
        }
    }
}

impl RemovePrivateDirectoryOnDrop {
    fn armed(path: PathBuf) -> Result<Self> {
        let parent = path.parent().context("snapshot repository has no parent")?;
        let lease = snapshot_leases::active(parent)?;
        Ok(Self { path, _lease: lease })
    }
}

impl Drop for RemovePrivateDirectoryOnDrop {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, path = %self.path.display(), "failed to remove private Git repository");
        }
    }
}

async fn capture_worktree_tree_with_backend(
    workspace: &Path,
    artifact_dir: &Path,
    turn_id: &str,
    stage: &str,
    backend: GitSnapshotBackend,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<GitTreeSnapshot> {
    ensure_private_artifact_directory(artifact_dir)?;
    let private_git_dir = private_snapshot_repository(artifact_dir, turn_id);
    let mut private_repository_cleanup = None;
    if backend == GitSnapshotBackend::Isolated && stage == "before" {
        private_repository_cleanup =
            Some(RemovePrivateDirectoryOnDrop::armed(private_git_dir.clone())?);
        match std::fs::remove_dir_all(&private_git_dir) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let init = run_git_command_with_private_repository(
            workspace,
            &["init", "--bare"],
            &private_git_dir,
            None,
            None,
            None,
            4096,
            Duration::from_secs(15),
        )
        .await?;
        if !init.success {
            anyhow::bail!(
                "failed to initialize isolated Git snapshot repository: {}",
                init.stderr
            )
        }
        // Snapshots must stay inspectable with plain `git --git-dir=…` (P2-1).
        ensure_bare_snapshot_layout(&private_git_dir)?;
    }
    let key = format!("{turn_id}\0{stage}");
    let index_name = format!("snapshot-{}.index", hex_sha256(key.as_bytes()));
    let index_path = artifact_dir.join(index_name);
    match std::fs::remove_file(&index_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let _index_cleanup = RemovePrivateFileOnDrop(index_path.clone());
    let read_tree = match backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_index(
                workspace,
                &["read-tree", "HEAD"],
                &index_path,
                4096,
                Duration::from_secs(15),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                &["read-tree", "--empty"],
                &private_git_dir,
                Some(workspace),
                Some(&index_path),
                None,
                4096,
                Duration::from_secs(15),
            )
            .await?
        }
    };
    if !read_tree.success {
        let empty = match backend {
            GitSnapshotBackend::Workspace => {
                run_git_command_with_index(
                    workspace,
                    &["read-tree", "--empty"],
                    &index_path,
                    4096,
                    Duration::from_secs(15),
                )
                .await?
            }
            GitSnapshotBackend::Isolated => read_tree,
        };
        if !empty.success {
            let _ = std::fs::remove_file(&index_path);
            anyhow::bail!(
                "failed to initialize private Git snapshot index: {}",
                empty.stderr
            )
        }
    }
    let ignored_workspace = backend == GitSnapshotBackend::Workspace
        && run_git_command(
            workspace,
            &["check-ignore", "--quiet", "--", "."],
            4096,
            Duration::from_secs(10),
        )
        .await?
        .success;
    // An isolated test workspace may lie entirely inside an ignored repository path.
    // Force inclusion only for such small workspaces; normal repository workspaces
    // must honor .gitignore to avoid scanning artifacts such as target.
    let add_args = if ignored_workspace {
        &["add", "-A", "--force", "--", "."][..]
    } else {
        &["add", "-A", "--", "."][..]
    };
    let add = match backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_index(
                workspace,
                add_args,
                &index_path,
                4096,
                Duration::from_secs(5),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                add_args,
                &private_git_dir,
                Some(workspace),
                Some(&index_path),
                None,
                4096,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !add.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!("failed to snapshot worktree files: {}", add.stderr)
    }
    let private_git_dir_for_pruning =
        (backend == GitSnapshotBackend::Isolated).then_some(private_git_dir.as_path());
    if let Err(error) =
        prune_policy_excluded_paths(workspace, private_git_dir_for_pruning, &index_path, policy)
            .await
    {
        tracing::warn!(%error, "failed to apply the snapshot exclusion policy");
    }
    let tree = match backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_index(
                workspace,
                &["write-tree"],
                &index_path,
                4096,
                Duration::from_secs(30),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                &["write-tree"],
                &private_git_dir,
                Some(workspace),
                Some(&index_path),
                None,
                4096,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !tree.success {
        anyhow::bail!("failed to write private Git snapshot tree: {}", tree.stderr)
    }
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("Git snapshot returned an invalid tree id")?;
    Ok(GitTreeSnapshot {
        tree: tree.to_string(),
        backend,
        _private_repository_cleanup: private_repository_cleanup,
    })
}

fn tool_may_mutate_workspace(name: &str, input: &Value) -> bool {
    if matches!(name, "bash" | "PowerShell") {
        return !input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    matches!(
        name,
        "write"
            | "edit"
            | "apply_patch"
            | "FileWriteTool"
            | "FileEditTool"
            | "ApplyPatchTool"
            | "spawn_agent"
            | "Agent"
            | "PlanAgent"
            | "Workflow"
            | "WritePlan"
            | "WriteReport"
            | "EditPlan"
            | "EditReport"
            | "AppendNotepad"
            | "SpecInit"
            | "SpecUpdate"
            | "SpecNewChange"
            | "SpecArchive"
            | "SpecConfig"
            | "SpecRecordVerification"
            | "SpecReview"
            | "SpecParallelDraft"
            | "ReviewWriteback"
            | "SpecSync"
            | "skill_manage"
            | "skill_curator"
            | "EnterWorktree"
            | "ExitWorktree"
            | "WorktreeCreate"
            | "WorktreeRemove"
    )
}

#[cfg(test)]
async fn finalize_turn_file_changes(
    workspace: &Path,
    artifact_dir: &Path,
    thread_id: &str,
    turn_id: &str,
    before: GitTreeSnapshot,
) -> Result<Option<TurnFileChangesArtifact>> {
    finalize_turn_file_changes_with_policy(
        workspace,
        artifact_dir,
        thread_id,
        turn_id,
        before,
        &kcoder_config::TurnFileChangesSettings::default(),
    )
    .await
}

async fn finalize_turn_file_changes_with_policy(
    workspace: &Path,
    artifact_dir: &Path,
    thread_id: &str,
    turn_id: &str,
    before: GitTreeSnapshot,
    policy: &kcoder_config::TurnFileChangesSettings,
) -> Result<Option<TurnFileChangesArtifact>> {
    let private_git_dir = private_snapshot_repository(artifact_dir, turn_id);
    let after = capture_worktree_tree_with_backend(
        workspace,
        artifact_dir,
        turn_id,
        "after",
        before.backend,
        policy,
    )
    .await?;
    if before.tree == after.tree {
        return Ok(None);
    }
    let diff_args = [
        "diff",
        "--binary",
        "--no-ext-diff",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let diff = match before.backend {
        GitSnapshotBackend::Workspace => {
            run_git_command(
                workspace,
                &diff_args,
                MAX_TURN_FILE_CHANGES_BYTES,
                Duration::from_secs(60),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                workspace,
                &diff_args,
                &private_git_dir,
                Some(workspace),
                None,
                None,
                MAX_TURN_FILE_CHANGES_BYTES,
                Duration::from_secs(60),
            )
            .await?
        }
    };
    if !diff.success {
        anyhow::bail!("failed to generate turn file changes: {}", diff.stderr)
    }
    let patch = diff.stdout.as_str().unwrap_or_default();
    if patch.is_empty() {
        return Ok(None);
    }
    let status_args = [
        "diff",
        "--name-status",
        "--find-renames",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let numstat_args = [
        "diff",
        "--numstat",
        "--find-renames",
        &before.tree,
        &after.tree,
        "--",
        ".",
    ];
    let (status, numstat) = match before.backend {
        GitSnapshotBackend::Workspace => (
            run_git_command(
                workspace,
                &status_args,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
            run_git_command(
                workspace,
                &numstat_args,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
        ),
        GitSnapshotBackend::Isolated => (
            run_git_command_with_private_repository(
                workspace,
                &status_args,
                &private_git_dir,
                Some(workspace),
                None,
                None,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
            run_git_command_with_private_repository(
                workspace,
                &numstat_args,
                &private_git_dir,
                Some(workspace),
                None,
                None,
                2 * 1024 * 1024,
                Duration::from_secs(30),
            )
            .await?,
        ),
    };
    if !status.success || !numstat.success {
        anyhow::bail!("failed to summarize turn file changes")
    }
    let counts = numstat
        .stdout
        .as_str()
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let mut fields = line.splitn(3, '\t');
            let additions = fields.next().unwrap_or("-");
            let deletions = fields.next().unwrap_or("-");
            (
                additions.parse::<u64>().unwrap_or(0),
                deletions.parse::<u64>().unwrap_or(0),
                additions == "-" || deletions == "-",
            )
        })
        .collect::<Vec<_>>();
    let files = status
        .stdout
        .as_str()
        .unwrap_or_default()
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let fields = line.split('\t').collect::<Vec<_>>();
            let code = fields.first()?.chars().next()?;
            let (old_path, path) = if matches!(code, 'R' | 'C') {
                (
                    fields.get(1).map(|value| (*value).to_string()),
                    fields.get(2)?,
                )
            } else {
                (None, fields.get(1)?)
            };
            let (additions, deletions, binary) = counts.get(index).copied().unwrap_or_default();
            Some(TurnFileChangeItem {
                old_path,
                path: (*path).to_string(),
                change_type: match code {
                    'A' => "created",
                    'D' => "deleted",
                    'R' | 'C' => "renamed",
                    _ => "modified",
                }
                .to_string(),
                additions,
                deletions,
                binary,
            })
        })
        .collect::<Vec<_>>();
    let workspace_path = dunce::canonicalize(workspace)?
        .to_string_lossy()
        .into_owned();
    let patch_sha256 = hex_sha256(patch.as_bytes());
    let artifact_id = hex_sha256(
        format!(
            "{thread_id}\0{turn_id}\0{workspace_path}\0{}\0{}\0{patch_sha256}",
            before.tree, after.tree
        )
        .as_bytes(),
    );
    let artifact = TurnFileChangesArtifact {
        version: 1,
        status: "active".into(),
        artifact_id: artifact_id.clone(),
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        workspace_path,
        snapshot_backend: before.backend,
        before_tree: before.tree,
        after_tree: after.tree,
        patch_sha256,
        file_count: files.len(),
        additions: files.iter().map(|file| file.additions).sum(),
        deletions: files.iter().map(|file| file.deletions).sum(),
        files,
        created_at: chrono::Utc::now().to_rfc3339(),
        reverted_at: None,
    };
    save_turn_file_changes_artifact_with_patch(artifact_dir, &artifact, Some(patch.as_bytes()))?;
    Ok(Some(artifact))
}

fn save_turn_file_changes_artifact(
    artifact_dir: &Path,
    artifact: &TurnFileChangesArtifact,
) -> Result<()> {
    save_turn_file_changes_artifact_with_patch(artifact_dir, artifact, None)
}

fn save_turn_file_changes_artifact_with_patch(
    artifact_dir: &Path,
    artifact: &TurnFileChangesArtifact,
    patch: Option<&[u8]>,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(artifact)?;
    transcript_artifact_journal::write(
        artifact_dir,
        &artifact.thread_id,
        transcript_artifact_journal::Kind::TurnFileChanges,
        || {
            if let Some(patch) = patch {
                write_private_artifact_file(
                    &artifact_dir.join(format!("{}.patch", artifact.artifact_id)),
                    patch,
                )?;
            }
            write_private_artifact_file(
                &artifact_dir.join(format!("{}.json", artifact.artifact_id)),
                &bytes,
            )
        },
    )
}

fn valid_artifact_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn load_turn_file_changes_artifact(
    engine: &QueryEngine,
    artifact_id: &str,
) -> Result<(PathBuf, TurnFileChangesArtifact, String)> {
    if !valid_artifact_id(artifact_id) {
        anyhow::bail!("invalid turn file changes artifact id")
    }
    let artifact_dir = engine
        .session_storage_dir_for(&engine.session_id())
        .join("turn-file-changes");
    let metadata_path = artifact_dir.join(format!("{artifact_id}.json"));
    let metadata = std::fs::symlink_metadata(&metadata_path)
        .context("turn file changes artifact metadata is missing")?;
    if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
        anyhow::bail!("turn file changes artifact metadata is invalid")
    }
    let artifact: TurnFileChangesArtifact =
        serde_json::from_slice(&std::fs::read(&metadata_path)?)?;
    if artifact.artifact_id != artifact_id || artifact.thread_id != engine.session_id() {
        anyhow::bail!("turn file changes artifact binding is invalid")
    }
    let expected_workspace = dunce::canonicalize(engine.state.cwd())?;
    if dunce::canonicalize(&artifact.workspace_path)? != expected_workspace {
        anyhow::bail!("turn file changes artifact belongs to another workspace")
    }
    let patch_path = artifact_dir.join(format!("{artifact_id}.patch"));
    let patch_metadata =
        std::fs::symlink_metadata(&patch_path).context("turn file changes patch is missing")?;
    if !patch_metadata.file_type().is_file()
        || patch_metadata.len() == 0
        || patch_metadata.len() > MAX_TURN_FILE_CHANGES_BYTES as u64
    {
        anyhow::bail!("turn file changes patch is invalid")
    }
    let patch = std::fs::read_to_string(&patch_path)?;
    if hex_sha256(patch.as_bytes()) != artifact.patch_sha256 {
        anyhow::bail!("turn file changes patch checksum mismatch")
    }
    Ok((artifact_dir, artifact, patch))
}

fn turn_file_changes_summary(artifact: &TurnFileChangesArtifact) -> Value {
    let workspace_path = dunce::simplified(Path::new(&artifact.workspace_path))
        .to_string_lossy()
        .into_owned();
    json!({
        "version": artifact.version,
        "status": artifact.status,
        "artifact_id": artifact.artifact_id,
        "device_id": "kcoder",
        "workspace_path": workspace_path,
        "file_count": artifact.file_count,
        "additions": artifact.additions,
        "deletions": artifact.deletions,
        "files": artifact.files,
        "reverted_at": artifact.reverted_at,
        "revertible": artifact.status == "active",
    })
}

async fn turn_file_changes_command(
    engine: &QueryEngine,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
    if params.args.len() != 1 {
        anyhow::bail!("{} requires exactly one artifact id", params.command_key)
    }
    let requested_path = params
        .path
        .as_deref()
        .context("turn file changes command requires workspace path")?;
    if std::fs::canonicalize(requested_path)? != std::fs::canonicalize(engine.state.cwd())? {
        anyhow::bail!("turn file changes workspace does not match the active thread")
    }
    let (artifact_dir, mut artifact, patch) =
        load_turn_file_changes_artifact(engine, &params.args[0])?;
    let workspace_cwd = engine.state.cwd();
    if params.command_key == "turn_file_changes_review" {
        return Ok(DeviceExecuteResult {
            success: true,
            exit_code: 0,
            stdout: turn_file_changes_review_payload(
                git::review_diff_without_binary_payload(&patch).into_owned(),
                MAX_TURN_FILE_CHANGES_REVIEW_BYTES,
            ),
            stderr: String::new(),
        });
    }
    if artifact.status == "reverted" {
        return Ok(DeviceExecuteResult {
            success: true,
            exit_code: 0,
            stdout: json!({"success": true, "file_changes": turn_file_changes_summary(&artifact)}),
            stderr: String::new(),
        });
    }
    let apply_args = [
        "apply",
        "--reverse",
        "--check",
        "--binary",
        "--whitespace=nowarn",
        "-",
    ];
    let private_revert_git_dir =
        artifact_dir.join(format!("revert-repository-{}", artifact.artifact_id));
    let _private_revert_repository_cleanup = (artifact.snapshot_backend
        == GitSnapshotBackend::Isolated)
        .then(|| RemovePrivateDirectoryOnDrop::armed(private_revert_git_dir.clone()))
        .transpose()?;
    if artifact.snapshot_backend == GitSnapshotBackend::Isolated {
        let _ = std::fs::remove_dir_all(&private_revert_git_dir);
        let init = run_git_command_with_private_repository(
            &workspace_cwd,
            &["init", "--bare"],
            &private_revert_git_dir,
            None,
            None,
            None,
            4096,
            Duration::from_secs(15),
        )
        .await?;
        if !init.success {
            anyhow::bail!(
                "failed to initialize isolated Git revert repository: {}",
                init.stderr
            )
        }
        ensure_bare_snapshot_layout(&private_revert_git_dir)?;
    }
    let check = match artifact.snapshot_backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_stdin(
                &workspace_cwd,
                &apply_args,
                &patch,
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                &workspace_cwd,
                &apply_args,
                &private_revert_git_dir,
                Some(&workspace_cwd),
                None,
                Some(&patch),
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !check.success {
        artifact.status = "conflicted".into();
        save_turn_file_changes_artifact(&artifact_dir, &artifact)?;
        return Ok(DeviceExecuteResult {
            success: true,
            exit_code: 0,
            stdout: json!({
                "success": false,
                "error": if check.stderr.is_empty() { "Git cannot safely reverse this artifact" } else { &check.stderr },
                "file_changes": turn_file_changes_summary(&artifact),
            }),
            stderr: String::new(),
        });
    }
    let apply_args = ["apply", "--reverse", "--binary", "--whitespace=nowarn", "-"];
    let applied = match artifact.snapshot_backend {
        GitSnapshotBackend::Workspace => {
            run_git_command_with_stdin(
                &workspace_cwd,
                &apply_args,
                &patch,
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
        GitSnapshotBackend::Isolated => {
            run_git_command_with_private_repository(
                &workspace_cwd,
                &apply_args,
                &private_revert_git_dir,
                Some(&workspace_cwd),
                None,
                Some(&patch),
                64 * 1024,
                Duration::from_secs(30),
            )
            .await?
        }
    };
    if !applied.success {
        artifact.status = "conflicted".into();
        save_turn_file_changes_artifact(&artifact_dir, &artifact)?;
    } else {
        artifact.status = "reverted".into();
        artifact.reverted_at = Some(chrono::Utc::now().to_rfc3339());
        save_turn_file_changes_artifact(&artifact_dir, &artifact)?;
    }
    Ok(DeviceExecuteResult {
        success: true,
        exit_code: 0,
        stdout: json!({
            "success": applied.success,
            "error": (!applied.success).then_some(applied.stderr),
            "file_changes": turn_file_changes_summary(&artifact),
        }),
        stderr: String::new(),
    })
}

async fn device_execute(
    workspace_root: &Path,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
    let command = params.command_key.as_str();
    if matches!(
        command,
        "git_is_worktree"
            | "git_branch"
            | "git_branch_list"
            | "git_branch_diff"
            | "git_branch_diff_shortstat"
            | "git_diff_working"
            | "git_diff_unstaged"
            | "git_diff_staged"
            | "git_diff_last_commit"
            | "git_status_porcelain"
            | "git_status_porcelain_z"
            | "git_sync_status"
            | "git_remote_url"
            | "git_add_all"
            | "git_commit"
            | "git_commit_all"
            | "git_push"
            | "git_pull_ff"
            | "git_merge"
            | "git_apply_reverse"
            | "git_checkout"
            | "git_checkout_new"
            | "git_generate_commit_message"
    ) {
        return git_device_execute(workspace_root, params).await;
    }
    let stdout = match command {
        "home_dir" => dirs::home_dir()
            .context("home directory is unavailable")?
            .to_string_lossy()
            .into_owned()
            .into(),
        "project_workspace_root" => workspace_root.to_string_lossy().into_owned().into(),
        "ls_dirs" => {
            let requested = params.path.as_deref().context("ls_dirs requires path")?;
            workspace_list_directories(workspace_root, Path::new(requested)).await?
        }
        "mkdir_p" => {
            let requested = params
                .args
                .first()
                .map(String::as_str)
                .context("mkdir_p requires a path")?;
            workspace_create_directory(workspace_root, Path::new(requested)).await?
        }
        "workspace_tree" => {
            let requested = params
                .path
                .as_deref()
                .context("workspace_tree requires path")?;
            workspace_tree(workspace_root, Path::new(requested)).await?
        }
        "workspace_read_text_file" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_read_text_file requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_read_text_file requires a filename")?;
            let max_bytes = params
                .max_output_bytes
                .unwrap_or(MAX_WORKSPACE_TEXT_BYTES as u64)
                .clamp(1, MAX_WORKSPACE_TEXT_BYTES as u64) as usize;
            workspace_read_text_file(workspace_root, Path::new(parent), name, max_bytes).await?
        }
        "workspace_read_file_chunk" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_read_file_chunk requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_read_file_chunk requires a filename")?;
            let offset = params
                .args
                .get(1)
                .context("workspace_read_file_chunk requires an offset")?
                .parse::<u64>()
                .context("workspace file offset must be a non-negative integer")?;
            workspace_read_file_chunk(workspace_root, Path::new(parent), name, offset).await?
        }
        "workspace_write_text_file" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_write_text_file requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_write_text_file requires a filename")?;
            let expected_revision = params
                .args
                .get(1)
                .map(String::as_str)
                .context("workspace_write_text_file requires an expected revision")?;
            let content = params
                .stdin
                .as_deref()
                .context("workspace_write_text_file requires stdin content")?;
            workspace_write_text_file(
                workspace_root,
                Path::new(parent),
                name,
                expected_revision,
                content,
            )
            .await?
        }
        "workspace_create_text_file" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_create_text_file requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_create_text_file requires a filename")?;
            workspace_create_text_file(
                workspace_root,
                Path::new(parent),
                name,
                params.stdin.as_deref().unwrap_or_default(),
            )
            .await?
        }
        "workspace_create_directory" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_create_directory requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_create_directory requires a name")?;
            workspace_create_workspace_directory(workspace_root, Path::new(parent), name).await?
        }
        "workspace_rename_entry" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_rename_entry requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_rename_entry requires a name")?;
            let new_name = params
                .args
                .get(1)
                .map(String::as_str)
                .context("workspace_rename_entry requires a new name")?;
            workspace_rename_entry(workspace_root, Path::new(parent), name, new_name).await?
        }
        "workspace_delete_entry" => {
            let parent = params
                .path
                .as_deref()
                .context("workspace_delete_entry requires path")?;
            let name = params
                .args
                .first()
                .map(String::as_str)
                .context("workspace_delete_entry requires a name")?;
            let recursive = params.args.get(1).is_some_and(|value| value == "true");
            workspace_delete_entry(workspace_root, Path::new(parent), name, recursive).await?
        }
        _ => anyhow::bail!("unsupported device command: {command}"),
    };
    Ok(DeviceExecuteResult {
        success: true,
        exit_code: 0,
        stdout,
        stderr: String::new(),
    })
}

async fn canonical_workspace_directory(raw: &str) -> Result<PathBuf> {
    if raw.trim().is_empty() || raw.len() > 4096 {
        anyhow::bail!("workspacePath is invalid")
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        anyhow::bail!("workspacePath must be absolute")
    }
    let canonical = dunce::canonicalize(path)
        .with_context(|| format!("workspace root does not exist: {raw}"))?;
    if !tokio::fs::metadata(&canonical).await?.is_dir() {
        anyhow::bail!("workspace root is not a directory: {raw}")
    }
    Ok(canonical)
}

fn workspace_record_matches(record: &ClientWorkspaceRecord, project_key: &str) -> bool {
    record.project_key == project_key || record.workspace_path == project_key
}

fn workspace_label(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

async fn workspace_request(engine: &QueryEngine, method: &str, params: &Value) -> Result<Value> {
    let store = ClientWorkspaceStore::new(engine);
    let device_id = params
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or("local");
    if let Some(runtime) = params.get("runtime").and_then(Value::as_str)
        && !matches!(runtime, "kcoder" | "codex")
    {
        anyhow::bail!("only the kcoder runtime supports client workspaces")
    }
    match method {
        "runtime.workspaces.prepare" => {
            let raw = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let action = params
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("select");
            if !matches!(action, "create" | "select") {
                anyhow::bail!("action must be create or select")
            }
            let raw_path = Path::new(raw);
            if !raw_path.is_absolute() || raw_path.parent().is_none() {
                anyhow::bail!("workspacePath must be an absolute non-root directory")
            }
            if action == "create" {
                tokio::fs::create_dir_all(raw_path).await?;
            }
            let path = canonical_workspace_directory(raw).await?;
            let workspace_path = path.to_string_lossy().into_owned();
            let label = params
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| workspace_label(&path));
            let project_id = params.get("projectId").and_then(Value::as_i64).unwrap_or(0);
            let project_key = format!("project:{project_id}");
            let _guard = store.lock()?;
            let mut state = store.load();
            let now = app_server_now_ms();
            let prior = state.records.remove(&workspace_path).unwrap_or_default();
            state.records.insert(
                workspace_path.clone(),
                ClientWorkspaceRecord {
                    workspace_path: workspace_path.clone(),
                    label: label.clone(),
                    project_key: project_key.clone(),
                    roots: vec![workspace_path.clone()],
                    created_at: if prior.created_at == 0 {
                        now
                    } else {
                        prior.created_at
                    },
                    updated_at: now,
                    ..prior
                },
            );
            if !state.project_order.contains(&project_key) {
                state.project_order.push(project_key);
            }
            store.save(&state)?;
            Ok(json!({
                "mapping": {
                    "id": project_id,
                    "userId": 0,
                    "projectId": project_id,
                    "deviceId": device_id,
                    "workspacePath": workspace_path,
                    "label": label,
                    "createdAt": now.to_string(),
                    "updatedAt": now.to_string(),
                },
                "preparedAction": if action == "create" { "created" } else { "selected" },
            }))
        }
        "runtime.workspaces.delete" => {
            let workspace_path = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let _guard = store.lock()?;
            let mut state = store.load();
            let before = state.records.len();
            let removed_keys = state
                .records
                .values()
                .filter(|record| record.workspace_path == workspace_path)
                .map(|record| record.project_key.clone())
                .collect::<HashSet<_>>();
            state
                .records
                .retain(|_, record| record.workspace_path != workspace_path);
            state
                .project_order
                .retain(|key| !removed_keys.contains(key));
            let deleted = state.records.len() != before;
            store.save(&state)?;
            Ok(json!({"deleted": deleted}))
        }
        "runtime.workspaces.open" => {
            let raw = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let path = canonical_workspace_directory(raw).await?;
            let workspace_path = path.to_string_lossy().into_owned();
            let label = params
                .get("label")
                .or_else(|| params.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| workspace_label(&path));
            if label.len() > 256 {
                anyhow::bail!("workspace label is too long")
            }
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&workspace_path)
                .to_string();
            let _guard = store.lock()?;
            let mut state = store.load();
            let now = app_server_now_ms();
            let prior = state.records.remove(&workspace_path).unwrap_or_default();
            state.records.insert(
                workspace_path.clone(),
                ClientWorkspaceRecord {
                    workspace_path: workspace_path.clone(),
                    label,
                    project_key: project_key.clone(),
                    roots: vec![workspace_path.clone()],
                    created_at: if prior.created_at == 0 {
                        now
                    } else {
                        prior.created_at
                    },
                    updated_at: now,
                    ..prior
                },
            );
            if !state.project_order.contains(&project_key) {
                state.project_order.insert(0, project_key);
            }
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "workspacePath": workspace_path,
                "runtime": "kcoder",
            }))
        }
        "runtime.projects.upsert_local" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .context("projectKey is required")?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("name is required")?;
            if project_key.len() > 512 || name.len() > 256 {
                anyhow::bail!("projectKey or name is too long")
            }
            let raw_roots = params
                .get("roots")
                .and_then(Value::as_array)
                .context("roots is required")?;
            if raw_roots.is_empty() || raw_roots.len() > 64 {
                anyhow::bail!("roots must contain between 1 and 64 directories")
            }
            let mut roots = Vec::with_capacity(raw_roots.len());
            for raw in raw_roots {
                let raw = raw.as_str().context("each root must be a string")?;
                roots.push(
                    canonical_workspace_directory(raw)
                        .await?
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            let mut seen_roots = HashSet::with_capacity(roots.len());
            roots.retain(|root| seen_roots.insert(root.clone()));
            let _guard = store.lock()?;
            let mut state = store.load();
            state
                .records
                .retain(|path, record| record.project_key != project_key || roots.contains(path));
            let now = app_server_now_ms();
            for root in &roots {
                let prior = state.records.remove(root).unwrap_or_default();
                state.records.insert(
                    root.clone(),
                    ClientWorkspaceRecord {
                        workspace_path: root.clone(),
                        label: name.to_string(),
                        project_key: project_key.to_string(),
                        roots: roots.clone(),
                        created_at: if prior.created_at == 0 {
                            now
                        } else {
                            prior.created_at
                        },
                        updated_at: now,
                        ..prior
                    },
                );
            }
            if !state.project_order.iter().any(|value| value == project_key) {
                state.project_order.insert(0, project_key.to_string());
            }
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "projectKey": project_key,
                "name": name,
                "roots": roots,
                "runtime": "kcoder",
            }))
        }
        "runtime.workspaces.rename" => {
            let workspace_path = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let project_key = params.get("projectKey").and_then(Value::as_str);
            let label = params
                .get("label")
                .or_else(|| params.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("name is required")?;
            if label.len() > 256 {
                anyhow::bail!("workspace label is too long")
            }
            let _guard = store.lock()?;
            let mut state = store.load();
            let mut matched = false;
            for record in state.records.values_mut() {
                if project_key.is_some_and(|key| workspace_record_matches(record, key))
                    || record.workspace_path == workspace_path
                {
                    record.label = label.to_string();
                    record.updated_at = app_server_now_ms();
                    matched = true;
                }
            }
            if !matched {
                anyhow::bail!("workspace was not found")
            }
            store.save(&state)?;
            Ok(
                json!({"success": true, "accepted": true, "deviceId": device_id, "workspacePath": workspace_path, "runtime": "kcoder"}),
            )
        }
        "runtime.workspaces.remove" => {
            let workspace_path = params
                .get("workspacePath")
                .and_then(Value::as_str)
                .context("workspacePath is required")?;
            let project_key = params.get("projectKey").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            let removed_keys = state
                .records
                .values()
                .filter(|record| {
                    project_key.is_some_and(|key| workspace_record_matches(record, key))
                        || record.workspace_path == workspace_path
                })
                .map(|record| record.project_key.clone())
                .collect::<HashSet<_>>();
            state.records.retain(|_, record| {
                !(project_key.is_some_and(|key| workspace_record_matches(record, key))
                    || record.workspace_path == workspace_path)
            });
            state
                .project_order
                .retain(|key| !removed_keys.contains(key));
            store.save(&state)?;
            Ok(
                json!({"success": true, "accepted": true, "deviceId": device_id, "workspacePath": workspace_path, "runtime": "kcoder"}),
            )
        }
        "runtime.workspaces.list" => {
            let _guard = store.lock()?;
            let state = store.load();
            let positions = state
                .project_order
                .iter()
                .enumerate()
                .map(|(index, key)| (key.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut records = state.records.values().collect::<Vec<_>>();
            records.sort_by_key(|record| {
                (
                    positions
                        .get(record.project_key.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                    record.workspace_path.as_str(),
                )
            });
            let items = records
                .into_iter()
                .map(|record| {
                    let available = Path::new(&record.workspace_path).is_dir();
                    json!({
                        "deviceId": device_id,
                        "workspacePath": record.workspace_path,
                        "workspaceKind": "workspace",
                        "workspaceSource": "local",
                        "available": available,
                        "error": (!available).then_some("workspace directory is unavailable"),
                        "label": record.label,
                        "projectName": record.label,
                        "projectKey": record.project_key,
                        "projectRoots": record.roots,
                        "projectSource": "legacy_root",
                        "projectPinned": record.pinned,
                        "projectPinnedOrder": record.pinned_order,
                        "projectActive": record.active,
                        "projectAppearance": record.appearance,
                        "createdAt": record.created_at,
                        "updatedAt": record.updated_at,
                        "tasks": [],
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "items": items,
                "pinnedTaskIds": state.pinned_tasks,
                "rootProjectPinned": state.root_project_pinned.unwrap_or(true),
                "taskOrders": state.task_orders,
            }))
        }
        "runtime.sidebar.projects.reorder" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let before = params.get("beforeProjectKey").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            if !state
                .records
                .values()
                .any(|record| workspace_record_matches(record, project_key))
            {
                anyhow::bail!("project was not found")
            }
            state.project_order.retain(|key| key != project_key);
            let index = before
                .and_then(|before| state.project_order.iter().position(|key| key == before))
                .unwrap_or(state.project_order.len());
            state.project_order.insert(index, project_key.to_string());
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.pin" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let pinned = params
                .get("pinned")
                .and_then(Value::as_bool)
                .context("pinned is required")?;
            let root_project = match params.get("rootProject") {
                None => false,
                Some(Value::Bool(value)) => *value,
                _ => anyhow::bail!("rootProject must be a boolean"),
            };
            if root_project
                && std::fs::canonicalize(project_key)? != std::fs::canonicalize(engine.state.cwd())?
            {
                anyhow::bail!("root project must match the app-server workspace")
            }
            let _guard = store.lock()?;
            let mut state = store.load();
            let mut matched = root_project;
            if root_project {
                state.root_project_pinned = Some(pinned);
            }
            for record in state.records.values_mut() {
                if !root_project && workspace_record_matches(record, project_key) {
                    record.pinned = pinned;
                    record.pinned_order = pinned.then_some(0);
                    record.updated_at = app_server_now_ms();
                    matched = true;
                }
            }
            if !matched {
                anyhow::bail!("project was not found")
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.appearance" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let appearance = params.get("appearance").cloned().unwrap_or(Value::Null);
            if serde_json::to_vec(&appearance)?.len() > 16 * 1024 {
                anyhow::bail!("project appearance is too large")
            }
            let _guard = store.lock()?;
            let mut state = store.load();
            let mut matched = false;
            for record in state.records.values_mut() {
                if workspace_record_matches(record, project_key) {
                    record.appearance = appearance.clone();
                    record.updated_at = app_server_now_ms();
                    matched = true;
                }
            }
            if !matched {
                anyhow::bail!("project was not found")
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.activate" => {
            let project_key = params.get("projectKey").and_then(Value::as_str);
            let workspace_path = params.get("workspacePath").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            for record in state.records.values_mut() {
                record.active = project_key
                    .is_some_and(|key| workspace_record_matches(record, key))
                    || workspace_path.is_some_and(|path| record.workspace_path == path);
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.tasks.pin" => {
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .context("threadId is required")?;
            let pinned = params
                .get("pinned")
                .and_then(Value::as_bool)
                .context("pinned is required")?;
            let _guard = store.lock()?;
            let mut state = store.load();
            state.pinned_tasks.retain(|value| value != thread_id);
            if pinned {
                let before = params.get("beforeThreadId").and_then(Value::as_str);
                let index = before
                    .and_then(|before| state.pinned_tasks.iter().position(|item| item == before))
                    .unwrap_or(state.pinned_tasks.len());
                state.pinned_tasks.insert(index, thread_id.to_string());
            }
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.tasks.reorder" => {
            let project_key = params
                .get("projectKey")
                .and_then(Value::as_str)
                .context("projectKey is required")?;
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .context("threadId is required")?;
            let before = params.get("beforeThreadId").and_then(Value::as_str);
            let _guard = store.lock()?;
            let mut state = store.load();
            let order = state
                .task_orders
                .entry(project_key.to_string())
                .or_default();
            order.retain(|item| item != thread_id);
            let index = before
                .and_then(|before| order.iter().position(|item| item == before))
                .unwrap_or(order.len());
            order.insert(index, thread_id.to_string());
            store.save(&state)?;
            Ok(json!({"success": true, "accepted": true, "deviceId": device_id}))
        }
        "runtime.sidebar.projects.sync_remote" => Ok(json!({
            "success": true,
            "accepted": true,
            "deviceId": device_id,
        })),
        _ => anyhow::bail!("unsupported workspace method: {method}"),
    }
}

async fn authorized_worktree_source(
    engine: &QueryEngine,
    configured_root: &Path,
    requested: &Path,
) -> Result<PathBuf> {
    if !requested.is_absolute() {
        anyhow::bail!("sourcePath must be absolute")
    }
    let resolved = dunce::canonicalize(requested)
        .with_context(|| format!("failed to resolve {}", requested.display()))?;
    if resolved == configured_root || resolved.starts_with(configured_root) {
        return Ok(resolved);
    }

    let workspace_store = ClientWorkspaceStore::new(engine);
    let registered_roots = {
        let _guard = workspace_store.lock()?;
        let state = workspace_store.load();
        state
            .records
            .values()
            .flat_map(|record| {
                std::iter::once(record.workspace_path.clone()).chain(record.roots.iter().cloned())
            })
            .collect::<Vec<_>>()
    };
    for root in registered_roots {
        let Ok(root) = dunce::canonicalize(root) else {
            continue;
        };
        if resolved == root || resolved.starts_with(root) {
            return Ok(resolved);
        }
    }
    anyhow::bail!("sourcePath is outside the configured or registered workspaces")
}

async fn snapshot_client_worktree(
    path: &Path,
    snapshot_dir: &Path,
) -> Result<ClientWorktreeSnapshot> {
    std::fs::create_dir_all(snapshot_dir)?;
    let head = run_git_command(path, &["rev-parse", "HEAD"], 4096, Duration::from_secs(15)).await?;
    let common = run_git_command(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !head.success || !common.success {
        anyhow::bail!("failed to resolve managed worktree snapshot metadata")
    }
    let head = head
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree HEAD is invalid")?;
    let git_common_dir = common
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("managed worktree Git common directory is invalid")?
        .to_string();
    let canonical = std::fs::canonicalize(path)?;
    let created_at = app_server_now_ms();
    let index_key = format!(
        "{}\0{}\0{}",
        canonical.display(),
        std::process::id(),
        created_at
    );
    let index_path = snapshot_dir.join(format!(
        "managed-worktree-snapshot-{}.index",
        hex_sha256(index_key.as_bytes())
    ));
    let _ = std::fs::remove_file(&index_path);

    let read_tree = run_git_command_with_index(
        path,
        &["read-tree", head],
        &index_path,
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !read_tree.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!(
            "failed to initialize managed worktree snapshot: {}",
            read_tree.stderr
        )
    }
    let add = run_git_command_with_index(
        path,
        &["add", "-A", "--", "."],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    if !add.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!("failed to capture managed worktree files: {}", add.stderr)
    }
    let tree = run_git_command_with_index(
        path,
        &["write-tree"],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    let _ = std::fs::remove_file(&index_path);
    if !tree.success {
        anyhow::bail!(
            "failed to write managed worktree snapshot tree: {}",
            tree.stderr
        )
    }
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree snapshot tree is invalid")?;
    let commit = run_git_command(
        path,
        &[
            "-c",
            "user.name=KCoder Worktree Snapshot",
            "-c",
            "user.email=snapshot@kcoder.local",
            "commit-tree",
            tree,
            "-p",
            head,
            "-m",
            "KCoder managed worktree snapshot",
        ],
        4096,
        Duration::from_secs(30),
    )
    .await?;
    if !commit.success {
        anyhow::bail!(
            "failed to commit managed worktree snapshot: {}",
            commit.stderr
        )
    }
    let commit = commit
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree snapshot commit is invalid")?
        .to_string();
    let reference = format!(
        "refs/kcoder/worktree-snapshots/{}",
        hex_sha256(canonical.to_string_lossy().as_bytes())
    );
    let update = run_git_command(
        path,
        &["update-ref", &reference, &commit],
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !update.success {
        anyhow::bail!(
            "failed to retain managed worktree snapshot: {}",
            update.stderr
        )
    }
    Ok(ClientWorktreeSnapshot {
        reference,
        commit,
        git_common_dir,
        created_at,
    })
}

async fn managed_worktree_content_token(path: &Path, scratch_dir: &Path) -> Result<String> {
    std::fs::create_dir_all(scratch_dir)?;
    let head = run_git_command(path, &["rev-parse", "HEAD"], 4096, Duration::from_secs(15)).await?;
    if !head.success {
        anyhow::bail!("failed to resolve managed worktree HEAD: {}", head.stderr)
    }
    let head = head
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree HEAD is invalid")?;
    let index_key = format!(
        "preview\0{}\0{}\0{}",
        path.display(),
        std::process::id(),
        app_server_now_ms()
    );
    let index_path = scratch_dir.join(format!(
        "managed-worktree-preview-{}.index",
        hex_sha256(index_key.as_bytes())
    ));
    let _ = std::fs::remove_file(&index_path);
    let read_tree = run_git_command_with_index(
        path,
        &["read-tree", head],
        &index_path,
        4096,
        Duration::from_secs(15),
    )
    .await?;
    if !read_tree.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!(
            "failed to initialize worktree preview index: {}",
            read_tree.stderr
        )
    }
    let add = run_git_command_with_index(
        path,
        &["add", "-A", "--", "."],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    if !add.success {
        let _ = std::fs::remove_file(&index_path);
        anyhow::bail!("failed to inspect managed worktree content: {}", add.stderr)
    }
    let tree = run_git_command_with_index(
        path,
        &["write-tree"],
        &index_path,
        4096,
        Duration::from_secs(30),
    )
    .await?;
    let _ = std::fs::remove_file(&index_path);
    if !tree.success {
        anyhow::bail!("failed to hash managed worktree content: {}", tree.stderr)
    }
    let tree = tree
        .stdout
        .as_str()
        .map(str::trim)
        .filter(|value| value.len() == 40 || value.len() == 64)
        .context("managed worktree content tree is invalid")?;
    Ok(hex_sha256(format!("{head}\0{tree}").as_bytes()))
}

async fn preview_client_worktree_archive(
    store: &ClientWorktreeStore,
    record: &ClientManagedWorktree,
    check_runtime_lease: bool,
) -> Result<ClientWorktreeArchivePreview> {
    let path = Path::new(&record.path);
    let mut blocking_reasons = Vec::new();
    if !path.exists() {
        blocking_reasons.push("worktree directory is unavailable".to_string());
        return Ok(ClientWorktreeArchivePreview {
            path: record.path.clone(),
            state: record.state.clone(),
            revision: record.revision,
            content_token: None,
            dirty: false,
            untracked_file_count: 0,
            ignored_entry_count: 0,
            dirty_submodule_count: 0,
            nested_repository_count: 0,
            baseline_known: record.base_commit.is_some(),
            commits_since_creation: None,
            requires_confirmation: false,
            archive_allowed: false,
            blocking_reasons,
        });
    }

    if check_runtime_lease {
        let runtime_lease = store.acquire_workspace_archive_lease(path);
        if let Err(error) = runtime_lease {
            blocking_reasons.push(error.to_string());
        }
    }
    let status = run_git_command(
        path,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignored=matching",
        ],
        MAX_GIT_OUTPUT_BYTES,
        Duration::from_secs(15),
    )
    .await?;
    if !status.success {
        anyhow::bail!(
            "failed to inspect managed worktree status: {}",
            status.stderr
        )
    }
    let status_text = status.stdout.as_str().unwrap_or_default();
    let dirty = status_text.lines().any(|line| !line.starts_with("!! "));
    let untracked_file_count = status_text
        .lines()
        .filter(|line| line.starts_with("?? "))
        .count();
    let ignored_entry_count = status_text
        .lines()
        .filter(|line| line.starts_with("!! "))
        .count();
    if ignored_entry_count > 0 {
        blocking_reasons.push(
            "ignored files are present and cannot be preserved by the worktree snapshot"
                .to_string(),
        );
    }
    let submodules = run_git_command(
        path,
        &[
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            "test -z \"$(git status --porcelain=v1 --untracked-files=all)\" || echo \"$sm_path\"",
        ],
        MAX_GIT_OUTPUT_BYTES,
        Duration::from_secs(30),
    )
    .await?;
    let dirty_submodule_count = if submodules.success {
        submodules
            .stdout
            .as_str()
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count()
    } else {
        blocking_reasons.push("submodule state cannot be verified".to_string());
        0
    };
    if dirty_submodule_count > 0 {
        blocking_reasons.push(
            "dirty submodules are present and cannot be preserved by the worktree snapshot"
                .to_string(),
        );
    }
    let mut nested_repository_count = 0_usize;
    let mut scanned_entries = 0_usize;
    let mut nested_scan_failed = false;
    for entry in WalkDir::new(path).follow_links(false) {
        scanned_entries = scanned_entries.saturating_add(1);
        if scanned_entries > 100_000 {
            nested_scan_failed = true;
            break;
        }
        match entry {
            Ok(entry) if entry.depth() > 1 && entry.file_name() == std::ffi::OsStr::new(".git") => {
                nested_repository_count = nested_repository_count.saturating_add(1);
            }
            Ok(_) => {}
            Err(_) => nested_scan_failed = true,
        }
    }
    if nested_repository_count > 0 {
        blocking_reasons
            .push("nested Git repositories are present and cannot be preserved safely".to_string());
    }
    if nested_scan_failed {
        blocking_reasons.push("nested repository scan could not be completed".to_string());
    }
    let commits_since_creation = if let Some(base_commit) = record.base_commit.as_deref() {
        let range = format!("{base_commit}..HEAD");
        let count = run_git_command(
            path,
            &["rev-list", "--count", &range],
            4096,
            Duration::from_secs(15),
        )
        .await?;
        if count.success {
            Some(
                count
                    .stdout
                    .as_str()
                    .and_then(|value| value.trim().parse::<u64>().ok())
                    .unwrap_or(0),
            )
        } else {
            blocking_reasons.push("managed worktree baseline cannot be verified".to_string());
            None
        }
    } else {
        None
    };
    let scratch_dir = store
        .state_path
        .parent()
        .context("worktree state directory is missing")?;
    let content_token = managed_worktree_content_token(path, scratch_dir).await?;
    let requires_confirmation = dirty
        || commits_since_creation.is_none()
        || commits_since_creation.is_some_and(|count| count > 0);
    Ok(ClientWorktreeArchivePreview {
        path: record.path.clone(),
        state: record.state.clone(),
        revision: record.revision,
        content_token: Some(content_token),
        dirty,
        untracked_file_count,
        ignored_entry_count,
        dirty_submodule_count,
        nested_repository_count,
        baseline_known: record.base_commit.is_some(),
        commits_since_creation,
        requires_confirmation,
        archive_allowed: blocking_reasons.is_empty(),
        blocking_reasons,
    })
}

async fn worktree_request(engine: &QueryEngine, method: &str, params: &Value) -> Result<Value> {
    let store = ClientWorktreeStore::new(engine);
    let device_id = params
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or("local");
    match method {
        "runtime.worktrees.settings.get" => {
            let _guard = store.lock()?;
            let state = store.load()?;
            let mut value = serde_json::to_value(state.settings)?;
            value["deviceId"] = device_id.into();
            Ok(value)
        }
        "runtime.worktrees.settings.update" => {
            let _guard = store.lock()?;
            let mut state = store.load()?;
            if let Some(root) = params.get("worktreeRoot").and_then(Value::as_str) {
                let root = root.trim();
                if root.is_empty() {
                    state.settings.worktree_root.clear();
                    state.settings.resolved_worktree_root =
                        store.default_root.to_string_lossy().into_owned();
                } else {
                    let path = PathBuf::from(root);
                    if !path.is_absolute() || path.parent().is_none() {
                        anyhow::bail!("worktreeRoot must be an absolute non-root directory")
                    }
                    if path.file_name().and_then(|name| name.to_str()) == Some(".kcoder") {
                        anyhow::bail!("worktreeRoot must not be a project .kcoder directory")
                    }
                    std::fs::create_dir_all(&path)?;
                    let resolved = dunce::canonicalize(&path)?;
                    state.settings.worktree_root = root.to_string();
                    state.settings.resolved_worktree_root = resolved.to_string_lossy().into_owned();
                }
            }
            if let Some(enabled) = params.get("autoCleanupEnabled").and_then(Value::as_bool) {
                state.settings.auto_cleanup_enabled = enabled;
            }
            if let Some(keep_count) = params.get("keepCount").and_then(Value::as_u64) {
                if keep_count == 0 || keep_count > 10_000 {
                    anyhow::bail!("keepCount must be between 1 and 10000")
                }
                state.settings.keep_count = keep_count as usize;
            }
            let resolved_root = Path::new(&state.settings.resolved_worktree_root);
            if state.records.values().any(|record| {
                let path = Path::new(&record.path);
                !path.starts_with(resolved_root) || path == resolved_root
            }) {
                anyhow::bail!(
                    "worktreeRoot cannot change while managed worktrees remain under another root"
                )
            }
            std::fs::create_dir_all(&state.settings.resolved_worktree_root)?;
            store.save(&state)?;
            let mut value = serde_json::to_value(state.settings)?;
            value["deviceId"] = device_id.into();
            Ok(value)
        }
        "runtime.worktrees.prepare" => {
            let source_path = params
                .get("sourcePath")
                .or_else(|| params.get("source_path"))
                .and_then(Value::as_str)
                .context("sourcePath is required")?;
            let worktree_id = params
                .get("worktreeId")
                .or_else(|| params.get("worktree_id"))
                .and_then(Value::as_str)
                .context("worktreeId is required")?;
            validate_worktree_id(worktree_id)?;
            let configured_root = dunce::canonicalize(engine.state.cwd())?;
            let source =
                authorized_worktree_source(engine, &configured_root, Path::new(source_path))
                    .await?;
            if !tokio::fs::metadata(&source).await?.is_dir() {
                anyhow::bail!("sourcePath is not a directory")
            }
            let repository_name = source
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("repository");
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let root = PathBuf::from(&state.settings.resolved_worktree_root);
            if !root.is_absolute() || root.parent().is_none() {
                anyhow::bail!("managed worktree root is unsafe")
            }
            std::fs::create_dir_all(&root)?;
            let root = dunce::canonicalize(root)?;
            let target = managed_worktree_target_path(&root, worktree_id, repository_name)?;
            if !target.exists() {
                std::fs::create_dir_all(target.parent().context("worktree parent is missing")?)?;
                let target_value = target.to_string_lossy().into_owned();
                let mut args = vec!["worktree", "add", "--detach", target_value.as_str()];
                let git_ref = params
                    .get("ref")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty());
                if let Some(git_ref) = git_ref {
                    let revision = format!("{git_ref}^{{commit}}");
                    let valid = run_git_command(
                        &source,
                        &["rev-parse", "--verify", "--quiet", &revision],
                        4096,
                        Duration::from_secs(15),
                    )
                    .await?;
                    if !valid.success {
                        return Ok(json!({
                            "success": false,
                            "deviceId": device_id,
                            "error": valid.stderr,
                        }));
                    }
                    args.push(git_ref);
                }
                let added =
                    run_git_command(&source, &args, 64 * 1024, Duration::from_secs(60)).await?;
                if !added.success {
                    anyhow::bail!("failed to create Git worktree: {}", added.stderr)
                }
            }
            let now = app_server_now_ms();
            let key = target.to_string_lossy().into_owned();
            let lease_key = hex_sha256(key.as_bytes());
            let head = run_git_command(
                &target,
                &["rev-parse", "--verify", "HEAD"],
                4096,
                Duration::from_secs(15),
            )
            .await?;
            if !head.success {
                anyhow::bail!(
                    "failed to resolve managed worktree baseline: {}",
                    head.stderr
                )
            }
            let head = head
                .stdout
                .as_str()
                .map(str::trim)
                .filter(|value| value.len() == 40 || value.len() == 64)
                .context("managed worktree baseline is invalid")?
                .to_string();
            let previous = state.records.remove(&key).unwrap_or_default();
            let base_commit = if previous.created_at == 0 {
                Some(head)
            } else {
                previous.base_commit.clone()
            };
            let record = ClientManagedWorktree {
                worktree_id: worktree_id.into(),
                path: key.clone(),
                repository_name: repository_name.into(),
                source_path: Some(source.to_string_lossy().into_owned()),
                permanent: params
                    .get("permanent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                revision: previous.revision.saturating_add(1).max(1),
                base_commit,
                lease_key,
                created_at: if previous.created_at != 0 {
                    previous.created_at
                } else {
                    now
                },
                updated_at: now,
                state: "active".into(),
                ..previous
            };
            state.records.insert(key, record.clone());
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "path": record.path,
                "worktree": record,
            }))
        }
        "runtime.worktrees.list" => {
            let measure_bytes = params
                .get("measureBytes")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let mut changed = false;
            for record in state.records.values_mut() {
                let detected_state = if Path::new(&record.path).exists() {
                    "active"
                } else if (record.snapshot_ref.is_some() || record.snapshot_commit.is_some())
                    && record.git_common_dir.is_some()
                {
                    "restorable"
                } else {
                    "missing"
                };
                if record.state != detected_state {
                    changed = true;
                    record.state = detected_state.into();
                    record.revision = record.revision.saturating_add(1);
                    record.updated_at = app_server_now_ms();
                }
            }
            if changed {
                store.save(&state)?;
            }
            let items = state
                .records
                .values()
                .rev()
                .map(|record| {
                    let bytes = measure_bytes
                        .then(|| measured_path_bytes(Path::new(&record.path), 100_000))
                        .transpose()
                        .ok()
                        .flatten();
                    json!({
                        "deviceId": device_id,
                        "worktreeId": record.worktree_id,
                        "path": record.path,
                        "repositoryName": record.repository_name,
                        "sourcePath": record.source_path,
                        "permanent": record.permanent,
                        "revision": record.revision,
                        "baseCommit": record.base_commit,
                        "createdAt": record.created_at,
                        "updatedAt": record.updated_at,
                        "state": record.state,
                        "snapshotAt": record.snapshot_at,
                        "lastError": record.last_error,
                        "bytes": bytes,
                        "conversations": record.archived_conversations,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({"success": true, "deviceId": device_id, "items": items}))
        }
        "runtime.worktrees.archive.preview" => {
            let requested_path = params
                .get("path")
                .and_then(Value::as_str)
                .context("path is required")?;
            let _guard = store.lock()?;
            let state = store.load()?;
            let record = state
                .records
                .get(requested_path)
                .context("managed worktree was not found")?;
            let preview = preview_client_worktree_archive(&store, record, true).await?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "preview": preview,
            }))
        }
        "runtime.worktrees.archive" => {
            let requested_path = params
                .get("path")
                .and_then(Value::as_str)
                .context("path is required")?;
            let expected_revision = params
                .get("expectedRevision")
                .or_else(|| params.get("expected_revision"))
                .and_then(Value::as_u64)
                .context("expectedRevision is required")?;
            let expected_content_token = params
                .get("expectedContentToken")
                .or_else(|| params.get("expected_content_token"))
                .and_then(Value::as_str)
                .context("expectedContentToken is required")?;
            let risk_accepted = params
                .get("riskAccepted")
                .or_else(|| params.get("risk_accepted"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let archived_conversations = params
                .get("archivedConversations")
                .or_else(|| params.get("archived_conversations"))
                .map(|value| {
                    serde_json::from_value::<Vec<ClientWorktreeConversation>>(value.clone())
                        .context("archivedConversations is invalid")
                })
                .transpose()?;
            if archived_conversations
                .as_ref()
                .is_some_and(|conversations| {
                    conversations
                        .iter()
                        .any(|conversation| conversation.workspace_path != requested_path)
                })
            {
                anyhow::bail!("archived conversation workspace does not match the worktree")
            }
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let current = state
                .records
                .get(requested_path)
                .context("managed worktree was not found")?
                .clone();
            if current.revision != expected_revision {
                anyhow::bail!(
                    "managed worktree changed; expected revision {}, current revision {}",
                    expected_revision,
                    current.revision
                )
            }
            if current.state != "active" {
                anyhow::bail!("only an active managed worktree can be archived")
            }
            let path = PathBuf::from(&current.path);
            let _archive_lease = store.acquire_workspace_archive_lease(&path)?;
            let preview = preview_client_worktree_archive(&store, &current, false).await?;
            if preview.content_token.as_deref() != Some(expected_content_token) {
                anyhow::bail!("managed worktree content changed after preview")
            }
            if !preview.archive_allowed {
                anyhow::bail!(
                    "managed worktree cannot be archived safely: {}",
                    preview.blocking_reasons.join("; ")
                )
            }
            if preview.requires_confirmation && !risk_accepted {
                anyhow::bail!(
                    "managed worktree has local changes; explicit risk acceptance is required"
                )
            }
            let snapshot_dir = store
                .state_path
                .parent()
                .context("worktree state directory is missing")?;
            let snapshot = snapshot_client_worktree(&path, snapshot_dir).await?;
            let post_snapshot = preview_client_worktree_archive(&store, &current, false).await?;
            if post_snapshot.content_token.as_deref() != Some(expected_content_token) {
                let _ = run_git_command(
                    &path,
                    &["update-ref", "-d", &snapshot.reference],
                    4096,
                    Duration::from_secs(15),
                )
                .await;
                anyhow::bail!("managed worktree content changed while creating its snapshot")
            }
            {
                let record = state
                    .records
                    .get_mut(requested_path)
                    .context("managed worktree was not found")?;
                record.snapshot_ref = Some(snapshot.reference.clone());
                record.snapshot_commit = Some(snapshot.commit.clone());
                record.snapshot_at = Some(snapshot.created_at);
                record.git_common_dir = Some(snapshot.git_common_dir.clone());
                if record.lease_key.is_empty() {
                    record.lease_key = hex_sha256(record.path.as_bytes());
                }
                if let Some(conversations) = archived_conversations {
                    // Archival enumeration may only add or refresh references; a temporarily empty
                    // thread/list must not overwrite protection registered at creation. References
                    // are removed through conversations.remove, with revision CAS preventing stale previews from re-adding them.
                    for conversation in conversations {
                        if let Some(existing) = record
                            .archived_conversations
                            .iter_mut()
                            .find(|item| item.task_id == conversation.task_id)
                        {
                            *existing = conversation;
                        } else {
                            record.archived_conversations.push(conversation);
                        }
                    }
                }
                record.state = "snapshot_ready".into();
                record.last_error = None;
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
            }
            // Persist the recoverable snapshot identity before removing the directory. If the
            // process exits afterward, the next list can still mark the missing-directory record
            // as restorable without losing the snapshot index.
            store.save(&state)?;
            let source = PathBuf::from(
                current
                    .source_path
                    .as_deref()
                    .context("source repository is missing")?,
            );
            let removed = run_git_command(
                &source,
                &["worktree", "remove", "--force", requested_path],
                64 * 1024,
                Duration::from_secs(60),
            )
            .await?;
            if !removed.success {
                let record = state
                    .records
                    .get_mut(requested_path)
                    .context("managed worktree was not found")?;
                record.state = "active".into();
                record.last_error = Some(format!(
                    "failed to archive Git worktree: {}",
                    removed.stderr
                ));
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
                store.save(&state)?;
                anyhow::bail!("failed to archive Git worktree: {}", removed.stderr)
            }
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            record.state = "restorable".into();
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            let response_record = record.clone();
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "worktree": response_record,
            }))
        }
        "runtime.worktrees.delete" => {
            if params
                .get("preserveSnapshot")
                .or_else(|| params.get("preserve_snapshot"))
                .and_then(Value::as_bool)
                == Some(false)
            {
                anyhow::bail!(
                    "irreversible worktree deletion is disabled; archive it first, then use forget"
                )
            }
            let preview = Box::pin(worktree_request(
                engine,
                "runtime.worktrees.archive.preview",
                params,
            ))
            .await?
            .get("preview")
            .cloned()
            .context("managed worktree archive preview is missing")?;
            if preview
                .get("requiresConfirmation")
                .and_then(Value::as_bool)
                .unwrap_or(true)
            {
                anyhow::bail!(
                    "managed worktree has local changes; use archive.preview and explicit archive confirmation"
                )
            }
            let mut archive_params = json!({
                "deviceId": device_id,
                "path": params.get("path").cloned().unwrap_or(Value::Null),
                "expectedRevision": preview.get("revision").cloned().unwrap_or(Value::Null),
                "expectedContentToken": preview.get("contentToken").cloned().unwrap_or(Value::Null),
                "riskAccepted": false,
            });
            if let Some(conversations) = params
                .get("archivedConversations")
                .or_else(|| params.get("archived_conversations"))
            {
                archive_params["archivedConversations"] = conversations.clone();
            }
            Box::pin(worktree_request(
                engine,
                "runtime.worktrees.archive",
                &archive_params,
            ))
            .await
        }
        "runtime.worktrees.restore" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let expected_revision = params
                .get("expectedRevision")
                .or_else(|| params.get("expected_revision"))
                .and_then(Value::as_u64)
                .context("expectedRevision is required")?;
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            let path = PathBuf::from(&record.path);
            if record.revision != expected_revision {
                anyhow::bail!(
                    "managed worktree changed; expected revision {}, current revision {}",
                    expected_revision,
                    record.revision
                )
            }
            if record.state != "restorable" {
                anyhow::bail!("only a restorable managed worktree can be restored")
            }
            if path.exists() {
                anyhow::bail!(
                    "restore target already exists; refusing to bind a colliding directory"
                )
            }
            let lease_key = if record.lease_key.is_empty() {
                hex_sha256(record.path.as_bytes())
            } else {
                record.lease_key.clone()
            };
            let _restore_lease = store.acquire_workspace_archive_lease_by_key(&lease_key)?;
            let snapshot = record
                .snapshot_ref
                .as_deref()
                .or(record.snapshot_commit.as_deref())
                .context("worktree snapshot is unavailable")?
                .to_string();
            let common = record
                .git_common_dir
                .as_deref()
                .context("source repository is unavailable")?
                .to_string();
            let source = PathBuf::from(
                record
                    .source_path
                    .as_deref()
                    .context("source repository is missing")?,
            );
            record.lease_key = lease_key;
            record.state = "restoring".into();
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            store.save(&state)?;
            std::fs::create_dir_all(path.parent().context("worktree parent is missing")?)?;
            let restored = run_git_command(
                &source,
                &[
                    "--git-dir",
                    &common,
                    "worktree",
                    "add",
                    "--detach",
                    requested_path,
                    &snapshot,
                ],
                64 * 1024,
                Duration::from_secs(60),
            )
            .await?;
            if !restored.success {
                let record = state
                    .records
                    .get_mut(requested_path)
                    .context("managed worktree was not found")?;
                record.state = "restorable".into();
                record.last_error = Some(format!(
                    "failed to restore Git worktree: {}",
                    restored.stderr
                ));
                record.revision = record.revision.saturating_add(1);
                record.updated_at = app_server_now_ms();
                store.save(&state)?;
                anyhow::bail!("failed to restore Git worktree: {}", restored.stderr)
            }
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            record.state = "active".into();
            record.last_error = None;
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            let response_record = record.clone();
            store.save(&state)?;
            Ok(json!({"success": true, "deviceId": device_id, "worktree": response_record}))
        }
        "runtime.worktrees.forget" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let expected_revision = params
                .get("expectedRevision")
                .or_else(|| params.get("expected_revision"))
                .and_then(Value::as_u64)
                .context("expectedRevision is required")?;
            let confirmed = params
                .get("confirmPermanent")
                .or_else(|| params.get("confirm_permanent"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !confirmed {
                anyhow::bail!("permanent worktree deletion requires explicit confirmation")
            }
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let record = state
                .records
                .get(requested_path)
                .context("managed worktree was not found")?
                .clone();
            if record.revision != expected_revision {
                anyhow::bail!(
                    "managed worktree changed; expected revision {}, current revision {}",
                    expected_revision,
                    record.revision
                )
            }
            if Path::new(&record.path).exists() {
                anyhow::bail!("active worktree must be archived before it can be forgotten")
            }
            if !matches!(record.state.as_str(), "restorable" | "deleted" | "missing") {
                anyhow::bail!("managed worktree operation is not in a forgettable state")
            }
            if !record.archived_conversations.is_empty() {
                anyhow::bail!("managed worktree still has archived conversation references")
            }
            let lease_key = if record.lease_key.is_empty() {
                hex_sha256(record.path.as_bytes())
            } else {
                record.lease_key.clone()
            };
            let _forget_lease = store.acquire_workspace_archive_lease_by_key(&lease_key)?;
            if let (Some(reference), Some(common)) = (
                record.snapshot_ref.as_deref(),
                record.git_common_dir.as_deref(),
            ) {
                let source = PathBuf::from(
                    record
                        .source_path
                        .as_deref()
                        .context("source repository is missing")?,
                );
                let deleted = run_git_command(
                    &source,
                    &["--git-dir", common, "update-ref", "-d", reference],
                    4096,
                    Duration::from_secs(15),
                )
                .await?;
                if !deleted.success {
                    anyhow::bail!(
                        "failed to delete managed worktree snapshot: {}",
                        deleted.stderr
                    )
                }
            }
            state.records.remove(requested_path);
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "deviceId": device_id,
                "path": requested_path,
                "forgotten": true,
            }))
        }
        "runtime.worktrees.conversations.link" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let conversation_value = params
                .get("conversation")
                .context("conversation is required")?;
            let conversation =
                serde_json::from_value::<ClientWorktreeConversation>(conversation_value.clone())
                    .context("conversation is invalid")?;
            if conversation.workspace_path != requested_path {
                anyhow::bail!("conversation workspace does not match the worktree")
            }
            if conversation.task_id.is_empty() || conversation.thread_id.is_empty() {
                anyhow::bail!("conversation taskId and threadId are required")
            }
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            if let Some(existing) = record
                .archived_conversations
                .iter_mut()
                .find(|item| item.task_id == conversation.task_id)
            {
                *existing = conversation;
            } else {
                record.archived_conversations.push(conversation);
            }
            record.revision = record.revision.saturating_add(1);
            record.updated_at = app_server_now_ms();
            let revision = record.revision;
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "path": requested_path,
                "revision": revision,
                "linked": true,
            }))
        }
        "runtime.worktrees.conversations.remove" => {
            let requested_path = params
                .get("path")
                .or_else(|| params.get("workspacePath"))
                .and_then(Value::as_str)
                .context("path is required")?;
            let task_id = params
                .get("taskId")
                .or_else(|| params.get("task_id"))
                .and_then(Value::as_str)
                .context("taskId is required")?;
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let record = state
                .records
                .get_mut(requested_path)
                .context("managed worktree was not found")?;
            let before = record.archived_conversations.len();
            record
                .archived_conversations
                .retain(|conversation| conversation.task_id != task_id);
            record.updated_at = app_server_now_ms();
            let removed = before != record.archived_conversations.len();
            if removed {
                record.revision = record.revision.saturating_add(1);
            }
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "path": requested_path,
                "taskId": task_id,
                "removed": removed,
            }))
        }
        "runtime.worktrees.prune" => {
            let _guard = store.lock()?;
            let mut state = store.load()?;
            let before = state.records.len();
            if state.settings.auto_cleanup_enabled {
                let mut inactive = state
                    .records
                    .iter()
                    .filter(|(_, record)| {
                        !Path::new(&record.path).exists()
                            && !record.permanent
                            && record.snapshot_ref.is_none()
                            && record.snapshot_commit.is_none()
                            && record.archived_conversations.is_empty()
                    })
                    .map(|(key, record)| (key.clone(), record.updated_at))
                    .collect::<Vec<_>>();
                inactive.sort_by_key(|(_, updated_at)| std::cmp::Reverse(*updated_at));
                for (key, _) in inactive.into_iter().skip(state.settings.keep_count) {
                    state.records.remove(&key);
                }
            }
            let pruned_count = before.saturating_sub(state.records.len());
            store.save(&state)?;
            Ok(json!({
                "success": true,
                "accepted": true,
                "deviceId": device_id,
                "prunedCount": pruned_count,
            }))
        }
        _ => anyhow::bail!("unsupported worktree method: {method}"),
    }
}

fn measured_path_bytes(path: &Path, max_entries: usize) -> Result<u64> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut bytes = 0u64;
    let mut visited = 0usize;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            visited = visited.saturating_add(1);
            if visited > max_entries {
                anyhow::bail!("path contains more than {max_entries} entries")
            }
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(bytes)
}

fn managed_worktree_target_path(
    root: &Path,
    worktree_id: &str,
    repository_name: &str,
) -> Result<PathBuf> {
    validate_worktree_id(worktree_id)?;
    let target = root.join(worktree_id).join(repository_name);
    if !target.starts_with(root) {
        anyhow::bail!("managed worktree path escaped its root")
    }
    Ok(target)
}

fn app_server_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn configured_models_response(engine: &QueryEngine) -> Value {
    match engine.current_configured_model_profiles() {
        Ok(profiles) => configured_model_catalog_response(profiles),
        Err(error) => json!({"data": [], "providers": [], "error": error.to_string()}),
    }
}

fn configured_model_catalog_response(
    profiles: Vec<kcoder_engine::ConfiguredModelProfile>,
) -> Value {
    let mut groups =
        std::collections::BTreeMap::<String, Vec<kcoder_engine::ConfiguredModelProfile>>::new();
    for profile in profiles {
        groups
            .entry(profile.profile_name.clone())
            .or_default()
            .push(profile);
    }
    let mut models = Vec::new();
    let providers = groups
        .into_iter()
        .map(|(provider_id, profiles)| {
            let current = profiles.iter().any(|profile| profile.current);
            let available = profiles.iter().any(|profile| profile.available);
            let provider_name = profiles[0].provider.clone();
            let error = if available { None } else { profiles.iter().find_map(|profile| profile.error.clone()) };
            let data = profiles.into_iter().map(|profile| {
            let reasoning_efforts = if profile.reasoning {
                profile.reasoning_effort.iter().cloned().collect()
            } else { Vec::new() };
            let entry = kcoder_app_protocol::RuntimeModelCatalogEntry {
                id: format!("{}::{}", profile.profile_name, profile.model),
                model: profile.model.clone(), display_name: profile.model,
                provider_id: profile.profile_name, provider_name: profile.provider,
                provider_type: "provider".into(), provider_current: current,
                description: None, hidden: false, is_default: profile.current,
                default_reasoning_effort: if profile.reasoning { profile.reasoning_effort } else { None },
                supported_reasoning_efforts: reasoning_efforts, supports_fast_mode: false,
                supports_vision: profile.vision, configuration: profile.configuration,
                available: profile.available, error: profile.error,
            };
            // All fields are finite scalar values and containers; this serialization
            // cannot contain credentials or arbitrary vendor request objects.
            let model = json!(entry);
            models.push(model.clone());
            model
            }).collect::<Vec<_>>();
            json!({
                "id": provider_id,
                "displayName": provider_name,
                "type": "provider",
                "current": current,
                "available": available,
                "error": error,
                "data": data,
            })
        })
        .collect::<Vec<_>>();
    json!({"data": models, "providers": providers})
}

fn runtime_context_request(engine: &QueryEngine, method: &str, params: &Value) -> Result<Value> {
    const MAX_INSTRUCTIONS_BYTES: usize = 64 * 1024;
    let settings_path = engine.settings_persistence_path().context(
        "runtime context persistence is disabled because this engine has no explicit user settings path",
    )?;
    let user = if method == "runtime.context.update" {
        let object = params
            .as_object()
            .context("runtime.context.update params must be an object")?;
        let only_if_unconfigured = object
            .get("onlyIfUnconfigured")
            .map(|value| {
                value
                    .as_bool()
                    .context("onlyIfUnconfigured must be a boolean")
            })
            .transpose()?
            .unwrap_or(false);
        if !object.contains_key("instructions") && !object.contains_key("personality") {
            anyhow::bail!("runtime.context.update requires instructions or personality");
        }
        kcoder_config::update_settings_file(&settings_path, |user| {
            let instructions_configured = context_field_configured(user, "instructions")?;
            if let Some(value) = object.get("instructions") {
                let instructions = value.as_str().context("instructions must be a string")?;
                if instructions.len() > MAX_INSTRUCTIONS_BYTES {
                    anyhow::bail!("instructions exceed the 64 KiB limit");
                }
                if !only_if_unconfigured || !instructions_configured {
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.instructions",
                        Value::String(instructions.to_string()),
                    )?;
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.instructions_configured",
                        Value::Bool(true),
                    )?;
                }
            }
            let personality_configured = context_field_configured(user, "personality")?;
            if let Some(value) = object.get("personality") {
                let personality = value.as_str().context("personality must be a string")?;
                if !matches!(personality, "friendly" | "pragmatic") {
                    anyhow::bail!("personality must be friendly or pragmatic");
                }
                if !only_if_unconfigured || !personality_configured {
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.personality",
                        Value::String(personality.to_string()),
                    )?;
                    kcoder_config::set_dotted_value(
                        user,
                        "studio_context.personality_configured",
                        Value::Bool(true),
                    )?;
                }
            }
            Ok(())
        })?
    } else {
        kcoder_config::read_settings_file(&settings_path)?
    };
    let instructions_configured = context_field_configured(&user, "instructions")?;
    let personality_configured = context_field_configured(&user, "personality")?;
    let instructions = kcoder_config::dotted_value(&user, "studio_context.instructions")?
        .and_then(Value::as_str)
        .unwrap_or_default();
    let personality = kcoder_config::dotted_value(&user, "studio_context.personality")?
        .and_then(Value::as_str)
        .unwrap_or("pragmatic");
    Ok(json!({
        "instructions": instructions,
        "personality": personality,
        "instructionsConfigured": instructions_configured,
        "personalityConfigured": personality_configured,
        "configPath": settings_path,
    }))
}

fn context_field_configured(user: &Value, field: &str) -> Result<bool> {
    let marker = format!("studio_context.{field}_configured");
    if let Some(value) = kcoder_config::dotted_value(user, &marker)? {
        return value
            .as_bool()
            .with_context(|| format!("{marker} must be a boolean"));
    }
    Ok(kcoder_config::dotted_value(user, &format!("studio_context.{field}"))?.is_some())
}

async fn workspace_search_request(engine: &QueryEngine, params: &Value) -> Result<Value> {
    let root = params
        .get("root")
        .and_then(Value::as_str)
        .context("root is required")?;
    let query = params
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if query.is_empty() {
        return Ok(json!({"files": []}));
    }
    if query.len() > 256 {
        anyhow::bail!("workspace search query is too long")
    }
    let root = dunce::canonicalize(root)?;
    if !tokio::fs::metadata(&root).await?.is_dir() {
        anyhow::bail!("workspace search root is not a directory")
    }
    let configured = dunce::canonicalize(engine.state.cwd())?;
    let inside_configured = root == configured || root.starts_with(&configured);
    let managed = if inside_configured {
        false
    } else {
        let store = ClientWorktreeStore::new(engine);
        let _guard = store.lock()?;
        store
            .load()?
            .records
            .values()
            .filter(|record| Path::new(&record.path).exists())
            .filter_map(|record| dunce::canonicalize(&record.path).ok())
            .any(|allowed| root == allowed || root.starts_with(allowed))
    };
    if !inside_configured && !managed {
        anyhow::bail!("workspace search root has not been opened")
    }
    let query = query.to_lowercase();
    let scan_root = root.clone();
    let files = tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
        let mut pending = vec![(scan_root.clone(), 0_usize)];
        let mut visited = 0_usize;
        let mut matches = Vec::<(usize, Value)>::new();
        while let Some((directory, depth)) = pending.pop() {
            if depth > 20 || visited >= 50_000 {
                continue;
            }
            let entries = match std::fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                visited += 1;
                if visited > 50_000 {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(name.as_str(), ".git" | "node_modules" | "target" | ".next") {
                    continue;
                }
                let entry_path = entry.path();
                let metadata = match std::fs::symlink_metadata(&entry_path) {
                    Ok(metadata) if !metadata.file_type().is_symlink() => metadata,
                    _ => continue,
                };
                let relative = entry_path
                    .strip_prefix(&scan_root)
                    .unwrap_or(&entry_path)
                    .to_string_lossy()
                    .replace('\\', "/");
                let haystack = relative.to_lowercase();
                if let Some(index) = haystack.find(&query) {
                    let score = 10_000_usize
                        .saturating_sub(index * 10)
                        .saturating_sub(depth * 25)
                        .saturating_sub(relative.len());
                    matches.push((
                        score,
                        json!({
                            "root": scan_root,
                            "path": relative,
                            "fileName": name,
                            "matchType": if metadata.is_dir() { "directory" } else { "file" },
                            "score": score,
                            "indices": (index..index + query.len()).collect::<Vec<_>>(),
                        }),
                    ));
                }
                if metadata.is_dir() {
                    pending.push((entry_path, depth + 1));
                }
            }
        }
        matches.sort_by_key(|item| std::cmp::Reverse(item.0));
        matches.truncate(200);
        Ok(matches.into_iter().map(|(_, value)| value).collect())
    })
    .await
    .context("workspace search task failed")??;
    Ok(json!({"files": files}))
}

async fn git_device_execute(
    workspace_root: &Path,
    params: &DeviceExecuteParams,
) -> Result<DeviceExecuteResult> {
    let requested = params.path.as_deref().unwrap_or_else(|| {
        workspace_root
            .to_str()
            .expect("configured workspace path is valid UTF-8")
    });
    let root = dunce::canonicalize(workspace_root).with_context(|| {
        format!(
            "failed to resolve workspace root {}",
            workspace_root.display()
        )
    })?;
    let cwd = workspace_path(&root, Path::new(requested)).await?;
    if !tokio::fs::metadata(&cwd).await?.is_dir() {
        anyhow::bail!("git command path is not a directory")
    }
    let max_bytes = params
        .max_output_bytes
        .unwrap_or(64 * 1024)
        .clamp(1, MAX_GIT_OUTPUT_BYTES as u64) as usize;
    let timeout = Duration::from_secs(params.timeout_seconds.unwrap_or(10).clamp(1, 120));
    match params.command_key.as_str() {
        "git_is_worktree" => {
            run_git_command(
                &cwd,
                &["rev-parse", "--is-inside-work-tree"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_branch" => {
            run_git_command(&cwd, &["branch", "--show-current"], max_bytes, timeout).await
        }
        "git_branch_list" => {
            run_git_command(
                &cwd,
                &["branch", "--format=%(refname:short)"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_status_porcelain" => {
            run_git_command(&cwd, &["status", "--porcelain"], max_bytes, timeout).await
        }
        "git_status_porcelain_z" => {
            run_git_command(
                &cwd,
                &[
                    "-c",
                    "core.quotePath=false",
                    "status",
                    "--porcelain=v1",
                    "-z",
                ],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_sync_status" => {
            let branch =
                run_git_command(&cwd, &["branch", "--show-current"], 64 * 1024, timeout).await?;
            if !branch.success {
                return Ok(branch);
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success {
                return Ok(dirty);
            }
            let remote =
                run_git_command(&cwd, &["remote", "get-url", "origin"], 64 * 1024, timeout).await?;
            let upstream = run_git_command(
                &cwd,
                &[
                    "rev-parse",
                    "--abbrev-ref",
                    "--symbolic-full-name",
                    "@{upstream}",
                ],
                64 * 1024,
                timeout,
            )
            .await?;
            let (ahead, behind) = if upstream.success {
                let counts = run_git_command(
                    &cwd,
                    &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                    64 * 1024,
                    timeout,
                )
                .await?;
                let values = counts
                    .stdout
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                    .filter_map(|value| value.parse::<u64>().ok())
                    .collect::<Vec<_>>();
                (
                    values.first().copied().unwrap_or(0),
                    values.get(1).copied().unwrap_or(0),
                )
            } else {
                (0, 0)
            };
            Ok(DeviceExecuteResult {
                success: true,
                exit_code: 0,
                stdout: json!({
                    "currentBranch": branch.stdout.as_str().unwrap_or_default().trim(),
                    "dirty": !dirty.stdout.as_str().unwrap_or_default().is_empty(),
                    "hasRemote": remote.success,
                    "remoteUrl": remote.success.then(|| remote.stdout.as_str().unwrap_or_default().trim()),
                    "hasUpstream": upstream.success,
                    "upstream": upstream.success.then(|| upstream.stdout.as_str().unwrap_or_default().trim()),
                    "ahead": ahead,
                    "behind": behind,
                }),
                stderr: String::new(),
            })
        }
        "git_remote_url" => {
            run_git_command(&cwd, &["remote", "get-url", "origin"], max_bytes, timeout).await
        }
        "git_branch_diff_shortstat" => git_branch_diff_shortstat(&cwd, max_bytes, timeout).await,
        "git_branch_diff" => git_branch_diff(&cwd, max_bytes, timeout).await,
        "git_diff_unstaged" => {
            run_git_command(
                &cwd,
                &["-c", "core.quotePath=false", "diff", "--"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_diff_working" => git_working_diff(&cwd, max_bytes, timeout).await,
        "git_diff_staged" => {
            run_git_command(
                &cwd,
                &["-c", "core.quotePath=false", "diff", "--cached", "--"],
                max_bytes,
                timeout,
            )
            .await
        }
        "git_diff_last_commit" => git_last_commit_diff(&cwd, max_bytes, timeout).await,
        "git_add_all" => run_git_command(&cwd, &["add", "--all"], max_bytes, timeout).await,
        "git_commit" => {
            if params.args.len() != 2 || params.args[0] != "-m" || params.args[1].len() > 10_000 {
                anyhow::bail!("git_commit requires one bounded -m message")
            }
            run_git_command(&cwd, &["commit", "-m", &params.args[1]], max_bytes, timeout).await
        }
        "git_commit_all" => {
            if params.args.len() != 2 || params.args[0] != "-m" || params.args[1].len() > 10_000 {
                anyhow::bail!("git_commit_all requires one bounded -m message")
            }
            let staged = run_git_command(&cwd, &["add", "--all"], max_bytes, timeout).await?;
            if !staged.success {
                return Ok(staged);
            }
            run_git_command(&cwd, &["commit", "-m", &params.args[1]], max_bytes, timeout).await
        }
        "git_push" => {
            if !params.args.is_empty() {
                anyhow::bail!("git_push does not accept arguments")
            }
            let upstream = run_git_command(
                &cwd,
                &["rev-parse", "--abbrev-ref", "@{upstream}"],
                4096,
                timeout,
            )
            .await?;
            if upstream.success {
                run_git_command_with_auth(&cwd, &["push"], max_bytes, timeout).await
            } else {
                run_git_command_with_auth(
                    &cwd,
                    &["push", "-u", "origin", "HEAD"],
                    max_bytes,
                    timeout,
                )
                .await
            }
        }
        "git_pull_ff" => {
            if !params.args.is_empty() {
                anyhow::bail!("git_pull_ff does not accept arguments")
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success || !dirty.stdout.as_str().unwrap_or_default().is_empty() {
                return Ok(DeviceExecuteResult {
                    success: false,
                    exit_code: 1,
                    stdout: Value::String(String::new()),
                    stderr: "pull requires a clean working tree".into(),
                });
            }
            run_git_command_with_auth(&cwd, &["pull", "--ff-only"], max_bytes, timeout).await
        }
        "git_merge" => {
            if params.args.len() != 1 || params.args[0].starts_with('-') {
                anyhow::bail!("git_merge requires exactly one branch or ref")
            }
            let target = &params.args[0];
            let verify = run_git_command(
                &cwd,
                &["rev-parse", "--verify", &format!("{target}^{{commit}}")],
                4096,
                timeout,
            )
            .await?;
            if !verify.success {
                return Ok(verify);
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success || !dirty.stdout.as_str().unwrap_or_default().is_empty() {
                return Ok(DeviceExecuteResult {
                    success: false,
                    exit_code: 1,
                    stdout: Value::String(String::new()),
                    stderr: "merge requires a clean working tree".into(),
                });
            }
            let merged =
                run_git_command(&cwd, &["merge", "--no-edit", target], max_bytes, timeout).await?;
            if !merged.success {
                let aborted =
                    run_git_command(&cwd, &["merge", "--abort"], 64 * 1024, timeout).await?;
                if !aborted.success {
                    return Ok(DeviceExecuteResult {
                        stderr: format!(
                            "{}\nmerge --abort failed: {}",
                            merged.stderr, aborted.stderr
                        ),
                        ..merged
                    });
                }
            }
            Ok(merged)
        }
        "git_apply_reverse" => {
            let patch = params.stdin.as_deref().context("stdin patch is required")?;
            if patch.is_empty() || patch.len() > MAX_GIT_OUTPUT_BYTES {
                anyhow::bail!("git reverse patch must contain between 1 byte and 5 MiB")
            }
            run_git_command_with_stdin(
                &cwd,
                &["apply", "--reverse", "--whitespace=nowarn", "-"],
                patch,
                max_bytes,
                timeout,
            )
            .await
        }
        "git_checkout" | "git_checkout_new" => {
            if params.args.len() != 1 {
                anyhow::bail!("{} requires exactly one branch name", params.command_key)
            }
            let dirty =
                run_git_command(&cwd, &["status", "--porcelain"], 512 * 1024, timeout).await?;
            if !dirty.success || !dirty.stdout.as_str().unwrap_or_default().is_empty() {
                return Ok(DeviceExecuteResult {
                    success: false,
                    exit_code: 1,
                    stdout: Value::String(String::new()),
                    stderr: "branch changes require a clean working tree".into(),
                });
            }
            let branch = &params.args[0];
            let validation = run_git_command(
                &cwd,
                &["check-ref-format", "--branch", branch],
                4096,
                timeout,
            )
            .await?;
            if !validation.success {
                return Ok(validation);
            }
            let args = if params.command_key == "git_checkout_new" {
                vec!["checkout", "-b", branch.as_str()]
            } else {
                vec!["checkout", branch.as_str()]
            };
            run_git_command(&cwd, &args, max_bytes, timeout).await
        }
        "git_generate_commit_message" => {
            let names = run_git_command(
                &cwd,
                &["diff", "--cached", "--name-only", "--"],
                64 * 1024,
                timeout,
            )
            .await?;
            if !names.success {
                return Ok(names);
            }
            let files = names
                .stdout
                .as_str()
                .unwrap_or_default()
                .lines()
                .filter(|line| !line.trim().is_empty())
                .collect::<Vec<_>>();
            let stdout = if files.is_empty() {
                json!({"success": false, "error": "No staged changes"})
            } else if files.len() == 1 {
                json!({"success": true, "message": format!("Update {}", files[0])})
            } else {
                json!({"success": true, "message": format!("Update {} files", files.len())})
            };
            Ok(DeviceExecuteResult {
                success: true,
                exit_code: 0,
                stdout,
                stderr: String::new(),
            })
        }
        command => anyhow::bail!("unsupported git command: {command}"),
    }
}

fn prompt_from_params(params: &Value) -> Option<String> {
    if let Some(prompt) = params.get("prompt").and_then(Value::as_str) {
        return (!prompt.trim().is_empty()).then(|| prompt.to_string());
    }
    params
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
        .into_non_empty()
}

trait IntoNonEmpty {
    fn into_non_empty(self) -> Option<String>;
}

impl IntoNonEmpty for String {
    fn into_non_empty(self) -> Option<String> {
        (!self.is_empty()).then_some(self)
    }
}

fn ensure_active_thread(
    engine: &QueryEngine,
    session_lease: Option<&SessionLease>,
    thread_id: &str,
) -> Result<()> {
    if thread_id != engine.session_id() {
        anyhow::bail!("threadId does not match the active thread")
    }
    if !session_lease.is_some_and(|lease| lease.matches_engine(engine)) {
        anyhow::bail!("thread/start or thread/resume is required")
    }
    Ok(())
}

fn ensure_goal_precondition(
    current: Option<&Goal>,
    expected_goal_id: Option<&str>,
    expected_revision: Option<u64>,
    require_no_goal: bool,
) -> Result<()> {
    if require_no_goal {
        if expected_goal_id.is_some() || expected_revision.is_some() {
            anyhow::bail!("requireNoGoal cannot be combined with an expected goal")
        }
        if current.is_some() {
            anyhow::bail!("goal changed concurrently: expected no current goal")
        }
        return Ok(());
    }
    if expected_revision.is_some() && expected_goal_id.is_none() {
        anyhow::bail!("expectedRevision requires expectedGoalId")
    }
    let Some(expected_goal_id) = expected_goal_id else {
        return Ok(());
    };
    let current =
        current.context("goal changed concurrently: expected goal is no longer current")?;
    if current.goal_id != expected_goal_id {
        anyhow::bail!("goal changed concurrently: expected goal is no longer current")
    }
    if expected_revision.is_some_and(|revision| revision != current.revision) {
        anyhow::bail!("goal changed concurrently: expected revision is stale")
    }
    Ok(())
}

fn parse_goal_status(value: &str) -> Result<GoalStatus> {
    match value.trim() {
        "active" => Ok(GoalStatus::Active),
        "paused" => Ok(GoalStatus::Paused),
        "blocked" => Ok(GoalStatus::Blocked),
        "usageLimited" | "usage_limited" => Ok(GoalStatus::UsageLimited),
        "budgetLimited" | "budget_limited" => Ok(GoalStatus::BudgetLimited),
        "complete" => Ok(GoalStatus::Complete),
        "cancelled" => Ok(GoalStatus::Cancelled),
        other => anyhow::bail!("unsupported goal status: {other}"),
    }
}

/// Validate explicit goal-state transitions in the app-server.
///
/// `usageLimited` is terminal for automatic execution, but after the user adds
/// allowance it must support the same narrow transition back to active as paused or
/// blocked. complete and budgetLimited remain irreversible, and other terminal-state
/// rewrites require clear first to preserve the goal lifecycle.
fn ensure_goal_status_transition(
    existing: GoalStatus,
    requested: Option<GoalStatus>,
) -> Result<()> {
    let Some(requested) = requested else {
        return Ok(());
    };
    if requested == existing
        || existing.is_unfinished()
        || (requested == GoalStatus::Active && existing.is_user_resumable())
    {
        return Ok(());
    }
    anyhow::bail!(
        "terminal goal status `{}` cannot be changed; clear it before starting a new goal",
        existing.as_str()
    )
}

fn parse_goal_mode(value: &str) -> Result<GoalMode> {
    match value.trim() {
        "standard" => Ok(GoalMode::Standard),
        "arrangement" => Ok(GoalMode::Arrangement),
        "strict" => Ok(GoalMode::Strict),
        other => anyhow::bail!("unsupported goal mode: {other}"),
    }
}

fn parse_goal_verification_kind(value: &str) -> Result<GoalVerificationKind> {
    match value.trim() {
        "artifact" => Ok(GoalVerificationKind::Artifact),
        "answer" => Ok(GoalVerificationKind::Answer),
        other => anyhow::bail!("unsupported goal verification kind: {other}"),
    }
}

fn thread_goal(thread_id: &str, goal: &Goal) -> ThreadGoal {
    let status = match goal.status {
        GoalStatus::Active => "active",
        GoalStatus::Paused => "paused",
        GoalStatus::Blocked => "blocked",
        GoalStatus::UsageLimited => "usageLimited",
        GoalStatus::BudgetLimited => "budgetLimited",
        GoalStatus::Complete => "complete",
        GoalStatus::Cancelled => "cancelled",
    };
    ThreadGoal {
        thread_id: thread_id.to_string(),
        goal_id: goal.goal_id.clone(),
        objective: kcoder_state::goal_objective_text(goal)
            .unwrap_or_else(|_| goal.objective.clone()),
        mode: goal.mode.as_str().to_string(),
        verification_kind: goal.verification_kind.as_str().to_string(),
        status: status.to_string(),
        token_budget: goal.token_budget,
        tokens_used: goal.tokens_used,
        time_used_seconds: goal.time_used_seconds,
        turn_count: goal.turn_count,
        blocked_candidate_count: goal.blocked_candidate_count,
        blocker_id: goal.blocked_candidate_id.clone(),
        blocker_reason: goal.blocked_candidate_reason.clone(),
        created_at: goal.created_at_ms,
        updated_at: goal.updated_at_ms,
        revision: goal.revision,
        events: goal
            .events
            .iter()
            .rev()
            .take(5)
            .rev()
            .map(|event| ThreadGoalEvent {
                kind: event.kind.as_str().to_string(),
                timestamp: event.timestamp_ms,
                summary: event.summary.clone(),
            })
            .collect(),
    }
}

fn thread_snapshot(engine: &QueryEngine, running: bool) -> Value {
    thread_snapshot_with_metadata_policy(engine, running, false)
        .expect("best-effort thread metadata decoration is infallible")
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

impl ThreadRunProjection {
    fn for_thread(
        thread_manager: &thread_runtime::ThreadManager,
        negotiated: bool,
        thread_id: &str,
    ) -> Self {
        Self {
            negotiated,
            facts: negotiated
                .then(|| thread_manager.thread_run_facts(thread_id))
                .flatten(),
        }
    }

    /// Facts that must replace the legacy projection, if any.
    fn authoritative(self) -> Option<kcoder_app_protocol::ThreadRunFacts> {
        if self.negotiated { self.facts } else { None }
    }

    /// Replaces the legacy projection on a typed thread snapshot.
    fn apply_thread(self, thread: &mut kcoder_app_protocol::Thread) {
        let Some(facts) = self.authoritative() else {
            return;
        };
        thread.status = facts.state();
        thread.run_summary = Some(facts.summary());
    }

    fn apply(self, snapshot: &mut Value) {
        let Some(facts) = self.authoritative() else {
            return;
        };
        let Some(object) = snapshot.as_object_mut() else {
            return;
        };
        object.insert("status".to_string(), json!(facts.state()));
        object.insert(
            "runSummary".to_string(),
            serde_json::to_value(facts.summary()).expect("run summary serializes"),
        );
    }
}

fn thread_snapshot_with_metadata_policy(
    engine: &QueryEngine,
    running: bool,
    strict_metadata: bool,
) -> Result<Value> {
    let (created_at, updated_at) = engine.state.session_timestamps_ms();
    let mut snapshot = json!({
        "id": engine.session_id(),
        "cwd": dunce::simplified(&engine.state.cwd()).to_string_lossy().into_owned(),
        "model": engine.client_model_selector(),
        "modelSelectionMode": engine.state.model_selection_mode(),
        "selectedModel": engine.state.selected_model(),
        "sessionMode": turn_execution::mode(engine),
        "status": if running { "running" } else { "idle" },
        "messageCount": engine.state.message_count(),
        "createdAt": created_at.to_string(),
        "updatedAt": updated_at.to_string(),
    });
    decorate_thread_snapshot(engine, &mut snapshot, strict_metadata)?;
    Ok(snapshot)
}

fn update_thread_metadata(
    engine: &QueryEngine,
    params: ThreadMetadataUpdateParams,
    running_thread_ids: &HashSet<String>,
    active_thread_owned: bool,
) -> Result<ThreadMetadataUpdateResult> {
    validate_thread_metadata_patch(&params)?;
    let mut lock_ids = vec![params.thread_id.as_str()];
    if let MetadataUpdate::Set(parent) = &params.parent {
        lock_ids.push(parent.thread_id.as_str());
    }
    let _lifecycle_locks = acquire_thread_lifecycle_locks(engine, &lock_ids)?;

    // Reconfirm the entity after locking its stable parent directory. Before the first
    // turn, a historyless active thread is identified by the current connection's
    // session lease and does not require a JSONL file that does not yet exist.
    let history_path = if active_thread_owned {
        engine.state.history_path()
    } else {
        if params.thread_id == engine.session_id() {
            anyhow::bail!("thread is not active in this app-server connection")
        }
        Some(thread_history_path(engine, &params.thread_id)?)
    };
    if let MetadataUpdate::Set(parent) = &params.parent {
        validate_thread_parent(engine, &params.thread_id, parent)?;
    }
    let storage_dir = ensure_thread_metadata_directory(engine, &params.thread_id)?;
    let workspace = canonical_workspace(engine)?;
    {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        // Activation and all metadata read/modify/write operations share this short fence.
        let mut fence = JournalFence::try_acquire(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
        )?;
        let mut metadata = read_thread_metadata(engine, &params.thread_id)?.unwrap_or_else(|| {
            ThreadClientMetadata {
                version: 1,
                revision: 0,
                thread_id: params.thread_id.clone(),
                workspace: workspace.clone(),
                fields: BTreeMap::new(),
                updated_at: unix_millis_string(),
            }
        });
        let previous_fields = metadata.fields.clone();
        apply_metadata_update(&mut metadata.fields, "title", params.title);
        apply_metadata_update(&mut metadata.fields, "model", params.model);
        apply_metadata_update(&mut metadata.fields, "archivedAt", params.archived_at);
        apply_parent_metadata_update(&mut metadata.fields, params.parent)?;
        if metadata.fields != previous_fields {
            metadata.revision = metadata.revision.saturating_add(1);
            metadata.updated_at = unix_millis_string();
            write_thread_metadata(&storage_dir, &metadata, &mut fence)?;
        }
    }

    let thread_value = if active_thread_owned {
        thread_snapshot(engine, running_thread_ids.contains(&params.thread_id))
    } else {
        let history_path = history_path.context("persisted thread history is missing")?;
        persisted_thread_value(
            engine,
            &params.thread_id,
            &history_path,
            running_thread_ids.contains(&params.thread_id),
        )?
    };
    Ok(ThreadMetadataUpdateResult {
        thread: serde_json::from_value(thread_value)?,
    })
}

fn validate_thread_metadata_patch(params: &ThreadMetadataUpdateParams) -> Result<()> {
    if params.title.is_unchanged()
        && params.model.is_unchanged()
        && params.archived_at.is_unchanged()
        && params.parent.is_unchanged()
    {
        anyhow::bail!("thread metadata update contains no changes")
    }
    validate_metadata_text("title", &params.title, 200)?;
    validate_metadata_text("model", &params.model, 256)?;
    validate_metadata_text("archivedAt", &params.archived_at, 128)?;
    Ok(())
}

fn validate_thread_parent(
    engine: &QueryEngine,
    thread_id: &str,
    parent: &ThreadParent,
) -> Result<()> {
    validate_plain_metadata_text("parent.taskId", &parent.task_id, 512)?;
    validate_thread_id(&parent.thread_id).context("thread parent id is invalid")?;
    validate_plain_metadata_text("parent.lastTurnId", &parent.last_turn_id, 64)?;
    if parent.thread_id == thread_id {
        anyhow::bail!("thread parent cannot reference itself")
    }
    let history_path = thread_history_path(engine, &parent.thread_id)
        .context("thread parent does not exist in the active workspace")?;
    let entries = kcoder_state::load_transcript_history(&history_path)?;
    turn_admissions::fork_transcript(
        &entries,
        &turn_admissions::bindings(engine, &parent.thread_id)?,
        &parent.last_turn_id,
    )
    .context("thread parent lastTurnId does not exist")?;
    Ok(())
}

fn validate_metadata_text(
    field: &str,
    update: &MetadataUpdate<String>,
    max_chars: usize,
) -> Result<()> {
    let MetadataUpdate::Set(value) = update else {
        return Ok(());
    };
    if value.trim().is_empty() {
        anyhow::bail!("thread metadata {field} must not be empty; use null to clear it")
    }
    if value.chars().count() > max_chars {
        anyhow::bail!("thread metadata {field} exceeds {max_chars} characters")
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("thread metadata {field} contains control characters")
    }
    Ok(())
}

fn validate_plain_metadata_text(field: &str, value: &str, max_chars: usize) -> Result<()> {
    if value.trim().is_empty() {
        anyhow::bail!("thread metadata {field} must not be empty")
    }
    if value.chars().count() > max_chars {
        anyhow::bail!("thread metadata {field} exceeds {max_chars} characters")
    }
    if value.chars().any(char::is_control) {
        anyhow::bail!("thread metadata {field} contains control characters")
    }
    Ok(())
}

fn apply_metadata_update(
    fields: &mut BTreeMap<String, Option<String>>,
    field: &str,
    update: MetadataUpdate<String>,
) {
    match update {
        MetadataUpdate::Unchanged => {}
        MetadataUpdate::Set(value) => {
            fields.insert(field.to_string(), Some(value));
        }
        MetadataUpdate::Clear => {
            fields.insert(field.to_string(), None);
        }
    }
}

fn apply_parent_metadata_update(
    fields: &mut BTreeMap<String, Option<String>>,
    update: MetadataUpdate<ThreadParent>,
) -> Result<()> {
    match update {
        MetadataUpdate::Unchanged => {}
        MetadataUpdate::Set(parent) => {
            fields.insert("parent".into(), Some(serde_json::to_string(&parent)?));
        }
        MetadataUpdate::Clear => {
            fields.insert("parent".into(), None);
        }
    }
    Ok(())
}

fn canonical_workspace(engine: &QueryEngine) -> Result<String> {
    Ok(dunce::canonicalize(engine.state.cwd())?
        .to_string_lossy()
        .into_owned())
}

fn acquire_thread_lifecycle_locks(
    engine: &QueryEngine,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    acquire_thread_lifecycle_locks_at_root(&engine.client_storage_root(), thread_ids)
}

fn acquire_thread_lifecycle_locks_at_root(
    root: &Path,
    thread_ids: &[&str],
) -> Result<Vec<std::fs::File>> {
    let mut thread_ids = thread_ids.to_vec();
    thread_ids.sort_unstable();
    thread_ids.dedup();
    for thread_id in &thread_ids {
        validate_thread_id(thread_id)?;
    }

    std::fs::create_dir_all(root)
        .with_context(|| format!("failed to create client storage root {}", root.display()))?;
    let root = std::fs::canonicalize(root)?;
    let lock_directory = root.join(THREAD_LIFECYCLE_LOCK_DIRECTORY);
    match std::fs::symlink_metadata(&lock_directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => anyhow::bail!(
            "thread lifecycle lock path is not a real directory: {}",
            lock_directory.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&lock_directory) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &lock_directory,
                            std::fs::Permissions::from_mode(0o700),
                        )?;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    let lock_directory = std::fs::canonicalize(&lock_directory)?;
    if lock_directory.parent() != Some(root.as_path()) {
        anyhow::bail!("thread lifecycle lock directory escapes the client storage root")
    }

    let mut locks = Vec::with_capacity(thread_ids.len());
    for thread_id in thread_ids {
        let path = lock_directory.join(format!("{thread_id}.lock"));
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
            options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let lock = options
            .open(&path)
            .with_context(|| format!("failed to open thread lifecycle lock {}", path.display()))?;
        if !lock.metadata()?.is_file() {
            anyhow::bail!(
                "thread lifecycle lock is not a regular file: {}",
                path.display()
            )
        }
        lock.lock_exclusive().with_context(|| {
            format!("failed to acquire thread lifecycle lock {}", path.display())
        })?;
        locks.push(lock);
    }
    Ok(locks)
}

fn ensure_thread_metadata_directory(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    let root = engine.client_storage_root();
    std::fs::create_dir_all(&root)
        .with_context(|| format!("failed to create client storage root {}", root.display()))?;
    let root = std::fs::canonicalize(&root)?;
    let directory = validated_thread_storage_dir(&root, thread_id)?;
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => anyhow::bail!(
            "thread metadata path is not a real directory: {}",
            directory.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&directory) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(
                            &directory,
                            std::fs::Permissions::from_mode(0o700),
                        )?;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.file_type().is_dir() {
        anyhow::bail!(
            "thread metadata path is not a real directory: {}",
            directory.display()
        )
    }
    let resolved = std::fs::canonicalize(&directory)?;
    if resolved.parent() != Some(root.as_path()) {
        anyhow::bail!("thread metadata path escapes the client storage root")
    }
    Ok(resolved)
}

fn thread_metadata_path(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    candidate_thread_metadata_path(&engine.client_storage_root(), thread_id)
}

fn candidate_thread_metadata_path(root: &Path, thread_id: &str) -> Result<PathBuf> {
    Ok(validated_thread_storage_dir(root, thread_id)?.join(THREAD_METADATA_FILE))
}

fn validated_thread_storage_dir(root: &Path, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    Ok(root.join(thread_id))
}

/// Persists the frozen session template binding into client thread metadata.
fn record_thread_settings_template(
    engine: &QueryEngine,
    binding: &SettingsTemplateBinding,
) -> Result<()> {
    let thread_id = engine.session_id();
    let storage_dir = ensure_thread_metadata_directory(engine, &thread_id)?;
    let workspace = canonical_workspace(engine)?;
    {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let mut fence = JournalFence::try_acquire(
            &engine.client_storage_root(),
            JournalDomain::ClientMetadata,
        )?;
        let mut metadata =
            read_thread_metadata(engine, &thread_id)?.unwrap_or_else(|| ThreadClientMetadata {
                version: 1,
                revision: 0,
                thread_id: thread_id.clone(),
                workspace: workspace.clone(),
                fields: BTreeMap::new(),
                updated_at: unix_millis_string(),
            });
        let encoded = serde_json::to_string(binding)?;
        if metadata.fields.get("settingsTemplate") != Some(&Some(encoded.clone())) {
            metadata
                .fields
                .insert("settingsTemplate".into(), Some(encoded));
            metadata.revision = metadata.revision.saturating_add(1);
            metadata.updated_at = unix_millis_string();
            write_thread_metadata(&storage_dir, &metadata, &mut fence)?;
        }
    }
    Ok(())
}

/// Overlay path for a thread's recorded settings template.
///
/// A deleted or unreadable template keeps the baseline settings so resume is
/// never blocked; the binding stays reported for drift/missing diagnostics.
fn recorded_settings_template_binding(
    engine: &QueryEngine,
    thread_id: &str,
) -> Option<SettingsTemplateBinding> {
    read_thread_metadata(engine, thread_id)
        .ok()
        .flatten()
        .and_then(|metadata| metadata.fields.get("settingsTemplate").cloned().flatten())
        .and_then(|value| serde_json::from_str::<SettingsTemplateBinding>(&value).ok())
}

fn recorded_settings_template_path(engine: &QueryEngine, thread_id: &str) -> Option<PathBuf> {
    let binding = recorded_settings_template_binding(engine, thread_id)?;
    match config_templates::resolve_session_template(&binding.id) {
        Ok((path, _)) => Some(path),
        Err(error) => {
            tracing::warn!(
                thread_id,
                template = %binding.id,
                %error,
                "recorded settings template is unavailable; resuming with baseline settings"
            );
            None
        }
    }
}

fn read_thread_metadata(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<Option<ThreadClientMetadata>> {
    let path = thread_metadata_path(engine, thread_id)?;
    let file_metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !file_metadata.file_type().is_file() || file_metadata.len() > MAX_THREAD_METADATA_BYTES {
        anyhow::bail!("thread metadata file is invalid: {}", path.display())
    }
    let metadata: ThreadClientMetadata = serde_json::from_slice(&std::fs::read(&path)?)?;
    if metadata.version != 1 || metadata.thread_id != thread_id {
        anyhow::bail!("thread metadata identity does not match its session")
    }
    if !same_workspace_form(&metadata.workspace, &canonical_workspace(engine)?) {
        anyhow::bail!("thread metadata belongs to another workspace")
    }
    Ok(Some(metadata))
}

/// Workspace identity must survive path-form drift: older builds stamped the
/// verbatim (`\\?\`) or otherwise non-canonical form of the same directory, and
/// a plain string comparison then rejected every legacy thread as foreign —
/// each one permanently inflating the history-index issue count.
fn same_workspace_form(stored: &str, current: &str) -> bool {
    if stored == current {
        return true;
    }
    match (
        dunce::canonicalize(Path::new(stored)),
        dunce::canonicalize(Path::new(current)),
    ) {
        (Ok(stored), Ok(current)) => stored == current,
        _ => false,
    }
}

fn write_thread_metadata(
    directory: &Path,
    metadata: &ThreadClientMetadata,
    fence: &mut kcoder_state::history_index::journal::JournalFence,
) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(metadata)?;
    if bytes.len() as u64 > MAX_THREAD_METADATA_BYTES {
        anyhow::bail!("thread metadata exceeds 64 KiB")
    }
    let target = directory.join(THREAD_METADATA_FILE);
    if let Ok(existing) = std::fs::symlink_metadata(&target)
        && !existing.file_type().is_file()
    {
        anyhow::bail!("thread metadata target is not a regular file")
    }
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(&bytes)?;
    temporary.as_file_mut().sync_all()?;
    let mutation = fence.begin(&metadata.thread_id)?;
    temporary.persist(&target).map_err(|error| error.error)?;
    // Authority is already committed; a failed tracking receipt must never replay it.
    if let Err(error) = mutation.finish() {
        tracing::warn!(%error, thread_id = %metadata.thread_id, "client metadata committed but journal completion failed");
    }
    Ok(())
}

fn decorate_thread_snapshot(
    engine: &QueryEngine,
    snapshot: &mut Value,
    strict: bool,
) -> Result<()> {
    let Some(thread_id) = snapshot
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return Ok(());
    };
    let stored = match read_thread_metadata(engine, &thread_id) {
        Ok(metadata) => metadata,
        Err(error) if strict => return Err(error),
        Err(error) => {
            tracing::warn!(thread_id, %error, "ignoring invalid client thread metadata");
            None
        }
    };
    decorate_thread_snapshot_with_metadata(snapshot, stored.as_ref(), strict)
}

fn decorate_thread_snapshot_with_metadata(
    snapshot: &mut Value,
    stored: Option<&ThreadClientMetadata>,
    strict: bool,
) -> Result<()> {
    let thread_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let Some(object) = snapshot.as_object_mut() else {
        return Ok(());
    };
    if let Some(metadata) = stored.as_ref() {
        for field in ["title", "model", "archivedAt"] {
            let Some(value) = metadata.fields.get(field) else {
                continue;
            };
            match value {
                Some(value) => {
                    object.insert(field.to_string(), Value::String(value.clone()));
                }
                None => {
                    object.remove(field);
                }
            }
        }
        if let Some(value) = metadata.fields.get("settingsTemplate") {
            match value {
                Some(value) => match serde_json::from_str::<SettingsTemplateBinding>(value) {
                    Ok(binding) => {
                        object.insert(
                            "settingsTemplate".into(),
                            serde_json::to_value(binding)
                                .expect("settings template binding serializes"),
                        );
                    }
                    Err(error) if strict => return Err(error.into()),
                    Err(error) => {
                        tracing::warn!(
                            thread_id,
                            %error,
                            "ignoring invalid stored settings template binding"
                        );
                        object.remove("settingsTemplate");
                    }
                },
                None => {
                    object.remove("settingsTemplate");
                }
            }
        }
        if let Some(value) = metadata.fields.get("parent") {
            match value {
                Some(value) => match serde_json::from_str::<ThreadParent>(value) {
                    Ok(parent) => {
                        object.insert("parent".into(), serde_json::to_value(parent).unwrap());
                    }
                    Err(error) if strict => return Err(error.into()),
                    Err(error) => {
                        tracing::warn!(thread_id, %error, "ignoring invalid stored thread parent");
                        object.remove("parent");
                    }
                },
                None => {
                    object.remove("parent");
                }
            }
        }
        let should_update = object
            .get("updatedAt")
            .and_then(Value::as_str)
            .is_none_or(|current| {
                metadata.updated_at.parse::<u64>().unwrap_or_default()
                    > current.parse::<u64>().unwrap_or_default()
            });
        if should_update {
            object.insert(
                "updatedAt".into(),
                Value::String(metadata.updated_at.clone()),
            );
        }
    }
    let authoritative = ThreadMetadata {
        schema: THREAD_METADATA_SCHEMA.into(),
        version: 1,
        revision: stored.as_ref().map_or(0, |metadata| metadata.revision),
        title: object
            .get("title")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model: object
            .get("model")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        archived_at: object
            .get("archivedAt")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        parent: object
            .get("parent")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
    };
    object.insert(
        "metadata".into(),
        serde_json::to_value(authoritative).expect("thread metadata serializes"),
    );
    Ok(())
}

fn unix_millis_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

async fn ensure_same_workspace(actual: &Path, requested: &Path) -> Result<()> {
    let actual = tokio::fs::canonicalize(actual).await.with_context(|| {
        format!(
            "failed to resolve app-server workspace {}",
            actual.display()
        )
    })?;
    let requested = tokio::fs::canonicalize(requested).await.with_context(|| {
        format!(
            "failed to resolve requested workspace {}",
            requested.display()
        )
    })?;
    if actual != requested {
        anyhow::bail!(
            "requested workspace {} does not match app-server workspace {}",
            requested.display(),
            actual.display()
        );
    }
    Ok(())
}

#[cfg(test)]
fn persisted_thread_snapshots(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
) -> Result<Vec<Value>> {
    Ok(persisted_thread_snapshot_report(engine, running_thread_ids, &HashSet::new())?.threads)
}

#[derive(Default)]
struct PersistedThreadSnapshotReport {
    threads: Vec<Value>,
    issue_count: u64,
}

fn persisted_thread_snapshot_report(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
    excluded_ids: &HashSet<String>,
) -> Result<PersistedThreadSnapshotReport> {
    match tracked_history_list::TrackedHistoryList::try_list(
        engine,
        running_thread_ids,
        excluded_ids,
        tracked_history_list::ListBudget::default(),
    ) {
        Ok(Some(report)) => return Ok(report),
        Ok(None) => {}
        Err(error) => tracing::debug!(%error, "tracked list unavailable; using authoritative scan"),
    }
    // Full-hash parsing reuse failed the component performance gate and remains test-only.
    persisted_thread_snapshot_report_with_catalog(
        engine,
        running_thread_ids,
        excluded_ids,
        history_catalog::ListCatalog::default(),
    )
}

/// History directories to scan for persisted threads: the authoritative one
/// first, then Windows compat roots derived from `project_data_dirs_for_read`
/// (pre-canonicalization builds persisted sessions under verbatim-derived keys).
fn history_scan_roots(
    history_dir: &Path,
    project_dir: &Path,
    compat_project_dirs: &[PathBuf],
) -> Vec<PathBuf> {
    let mut roots = vec![history_dir.to_path_buf()];
    let Ok(relative) = history_dir.strip_prefix(project_dir) else {
        return roots;
    };
    for candidate in compat_project_dirs {
        // The legacy verbatim-derived key keeps its `?` after the separator
        // replacement; such a name can never be a real Windows directory, and
        // scanning it fails with ERROR_INVALID_NAME (os error 123) instead of
        // NotFound. Skip roots that cannot exist on any filesystem.
        if !scan_root_can_exist(candidate) {
            continue;
        }
        let dir = candidate.join(relative);
        if !roots.contains(&dir) {
            roots.push(dir);
        }
    }
    roots
}

/// True when the path could name a real directory: Windows path components
/// cannot contain `? * < > | "`, and no KCoder-generated key form embeds them
/// elsewhere.
fn scan_root_can_exist(root: &Path) -> bool {
    !root
        .to_string_lossy()
        .chars()
        .any(|c| matches!(c, '?' | '*' | '<' | '>' | '|' | '"'))
}

struct MergedHistoryScan {
    candidates: Vec<(String, PathBuf, std::time::SystemTime)>,
    issue_count: u64,
}

fn scan_history_roots(roots: &[PathBuf]) -> Result<MergedHistoryScan> {
    let mut merged = MergedHistoryScan {
        candidates: Vec::new(),
        issue_count: 0,
    };
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let scan = kcoder_state::recent_session_candidates_report(root)?;
        merged.issue_count = merged.issue_count.saturating_add(scan.issue_count);
        for candidate in scan.candidates {
            if seen.insert(candidate.0.clone()) {
                merged.candidates.push(candidate);
            }
        }
    }
    Ok(merged)
}

fn persisted_thread_snapshot_report_with_catalog(
    engine: &QueryEngine,
    running_thread_ids: &HashSet<String>,
    excluded_ids: &HashSet<String>,
    mut catalog: history_catalog::ListCatalog,
) -> Result<PersistedThreadSnapshotReport> {
    let Some(history_path) = engine.state.history_path() else {
        return Ok(PersistedThreadSnapshotReport::default());
    };
    let history_dir = history_path
        .parent()
        .context("session history path has no parent")?;
    // strip 基准取 `project_data_dirs_for_read` 首项（当前项目目录，与 CLI 读路径
    // 候选同源）。默认布局 transcript 平铺在项目目录（main.rs:1386-1392），相对
    // 路径为空 → 兼容根 = 裸 key 目录（正确，旧 build 同样平铺写入）；嵌套/自定义
    // 布局按相对子路径拼接；history_dir 不在基准的祖先链上时 strip 失败、回退单根。
    let roots = match kcoder_config::Settings::project_data_dirs_for_read(engine.state.cwd()) {
        Ok(project_dirs) if !project_dirs.is_empty() => {
            history_scan_roots(history_dir, &project_dirs[0], &project_dirs)
        }
        _ => vec![history_dir.to_path_buf()],
    };
    let root = std::fs::canonicalize(engine.state.cwd())?;
    let scan = scan_history_roots(&roots)?;
    let mut report = PersistedThreadSnapshotReport {
        threads: Vec::new(),
        issue_count: scan.issue_count,
    };
    for (session_id, path, _) in scan.candidates {
        if excluded_ids.contains(&session_id) {
            continue;
        }
        // Empty files are pre-transcript placeholders, not persisted conversations.
        // Do not infer visibility from the possibly compacted model message count.
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() > 0 => {}
            Ok(_) => continue,
            Err(_) => {
                report.issue_count = report.issue_count.saturating_add(1);
                continue;
            }
        }
        if validate_thread_id(&session_id).is_err() {
            report.issue_count = report.issue_count.saturating_add(1);
            tracing::warn!(
                session_id,
                "skipping persisted app-server thread with invalid id"
            );
            continue;
        }
        let metadata = match kcoder_state::prepare_session_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                report.issue_count = report.issue_count.saturating_add(1);
                tracing::warn!(
                    session_id,
                    path = %path.display(),
                    %error,
                    "skipping unreadable persisted app-server thread"
                );
                continue;
            }
        };
        let Some(base_cwd) = metadata.base_cwd() else {
            report.issue_count = report.issue_count.saturating_add(1);
            continue;
        };
        let Ok(base_cwd) = std::fs::canonicalize(base_cwd) else {
            // The session's recorded working directory no longer exists (deleted
            // project, removed worktree, cleaned temp dir). It cannot belong to
            // any workspace list; skip it silently — the same treatment as a
            // session that belongs to another directory. Counting it as a
            // listing issue made every project with such a session show a
            // permanent "incomplete (N issues)" banner that no transport-side
            // fix could ever clear.
            tracing::debug!(
                session_id,
                cwd = ?metadata.base_cwd(),
                "skipping persisted thread whose working directory no longer exists"
            );
            continue;
        };
        if base_cwd != root {
            continue;
        }
        let snapshot = catalog.snapshot(
            engine,
            &session_id,
            &path,
            &metadata,
            running_thread_ids.contains(&session_id),
        );
        match snapshot {
            Ok(snapshot) => report.threads.push(snapshot),
            Err(error) => {
                report.issue_count = report.issue_count.saturating_add(1);
                tracing::warn!(
                    session_id,
                    path = %path.display(),
                    %error,
                    "skipping invalid persisted app-server thread"
                );
            }
        }
    }
    catalog.publish();
    Ok(report)
}

async fn thread_transcript(
    engine: &QueryEngine,
    params: ThreadReadParams,
    running_thread_ids: &HashSet<String>,
    run_projection: ThreadRunProjection,
) -> Result<ThreadReadResult> {
    let history_path = thread_history_path(engine, &params.thread_id)?;
    let resident = params.thread_id == engine.session_id();
    if resident {
        engine
            .state
            .flush_history()
            .await
            .context("failed to flush resident thread before reading transcript")?;
    }
    // A newly-created resident thread has a lease and session sidecar before its first JSONL
    // entry. Treat that valid pre-turn state as an empty transcript; a reload must not convert
    // this short window into ENOENT and then tear down the recovered task connection.
    let entries = if resident {
        let mut attempts = 0_u8;
        loop {
            match kcoder_state::load_transcript_history(&history_path) {
                Ok(entries) => break entries,
                Err(error) if error_is_not_found(&error) && attempts < 2 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) if error_is_not_found(&error) => break Vec::new(),
                Err(error) => return Err(error),
            }
        }
    } else {
        kcoder_state::load_transcript_history(&history_path)?
    };
    let thread_value = if resident {
        thread_snapshot(engine, running_thread_ids.contains(&params.thread_id))
    } else {
        persisted_thread_value(
            engine,
            &params.thread_id,
            &history_path,
            running_thread_ids.contains(&params.thread_id),
        )?
    };
    let mut thread: Thread = serde_json::from_value(thread_value)?;
    run_projection.apply_thread(&mut thread);
    recent_error::decorate(engine, &mut thread, run_projection.negotiated);
    let transcript_window::Page {
        mut start,
        end,
        mut messages,
    } = transcript_window::project(
        entries,
        transcript_window::Artifacts {
            attempts: turn_attempts::records(engine, &params.thread_id)?,
            turn_ids: turn_admissions::bindings(engine, &params.thread_id)?,
            client_ids: load_turn_client_message_ids(engine, &params.thread_id),
            outcomes: load_turn_outcomes(engine, &params.thread_id),
            approvals: load_approval_decisions(engine, &params.thread_id),
            file_changes: load_turn_file_change_summaries(engine, &params.thread_id),
        },
        params.limit,
        params.before_cursor.as_deref(),
    );
    while messages.len() > 1 && serde_json::to_vec(&messages)?.len() > MAX_TRANSCRIPT_RESPONSE_BYTES
    {
        messages.remove(0);
        start += 1;
    }
    Ok(ThreadReadResult {
        thread,
        messages,
        range_start: start,
        range_end: end,
        has_more_before: start > 0,
        before_cursor: (start > 0).then(|| start.to_string()),
    })
}

fn load_approval_decisions(engine: &QueryEngine, thread_id: &str) -> Vec<ApprovalDecisionArtifact> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("approval-decisions");
    let Ok(entries) = std::fs::read_dir(artifact_dir) else {
        return Vec::new();
    };
    let mut artifacts = entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
                return None;
            }
            let artifact =
                serde_json::from_slice::<ApprovalDecisionArtifact>(&std::fs::read(path).ok()?)
                    .ok()?;
            (artifact.version == 1
                && artifact.thread_id == thread_id
                && valid_artifact_id(&artifact.artifact_id))
            .then_some(artifact)
        })
        .collect::<Vec<_>>();
    artifacts.sort_by_key(|artifact| artifact.requested_at_ms);
    artifacts
}

fn approval_action_description(action: &ApprovalAction) -> String {
    match action {
        ApprovalAction::Command { command } => format!("Command: {command}"),
        ApprovalAction::FileChange { path } => format!("File change: {path}"),
        ApprovalAction::Tool { name, input } => {
            let input = serde_json::to_string_pretty(input).unwrap_or_else(|_| "{}".into());
            format!("Tool: {name}\n{input}")
        }
    }
}

fn approval_decision_label(decision: &ApprovalDecision) -> &'static str {
    match decision {
        ApprovalDecision::Accept => "Allow once",
        ApprovalDecision::AcceptForSession => "Always allow for this session",
        ApprovalDecision::Decline => "Decline",
        ApprovalDecision::Cancel => "Cancelled",
    }
}

fn attach_approval_decision_blocks(
    messages: &mut [ThreadMessage],
    artifacts: Vec<ApprovalDecisionArtifact>,
) {
    for artifact in artifacts {
        let Some(message) = messages.iter_mut().find(|message| {
            message.turn_id.as_deref() == Some(artifact.turn_id.as_str())
                && message.role == "assistant"
        }) else {
            continue;
        };
        let question = [
            artifact.reason.as_str(),
            approval_action_description(&artifact.action).as_str(),
        ]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
        let label = approval_decision_label(&artifact.decision);
        let render_payload = json!({
            "kind": "request_user_input",
            "itemId": artifact.approval_id,
            "questions": [{
                "id": artifact.approval_id,
                "header": "Permission request",
                "question": question,
                "options": [
                    {"label": "Allow once", "description": "Allow this operation once."},
                    {"label": "Decline", "description": "Decline this operation."}
                ],
                "isOther": false,
                "multiSelect": false
            }],
            "response": {
                "itemId": artifact.approval_id,
                "answers": {
                    artifact.approval_id.clone(): {"answers": [label]}
                }
            }
        });
        message.blocks.insert(
            0,
            json!({
                "id": format!("approval-history-{}", artifact.artifact_id),
                "type": "tool",
                "tool_name": "request_user_input",
                "toolName": "request_user_input",
                "status": "done",
                "timestamp": artifact.requested_at_ms,
                "completed_at": artifact.resolved_at_ms,
                "tool_output": artifact.resolution_reason,
                "render_payload": render_payload.clone(),
                "renderPayload": render_payload
            }),
        );
    }
}

fn save_turn_outcome(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    status: &str,
    error: Option<&str>,
    provider_failure: Option<&kcoder_types::ProviderFailureDetails>,
) -> Result<()> {
    save_turn_outcome_with_continuation(
        engine,
        thread_id,
        turn_id,
        status,
        error,
        provider_failure,
        false,
    )
}

fn save_turn_outcome_with_continuation(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    status: &str,
    error: Option<&str>,
    provider_failure: Option<&kcoder_types::ProviderFailureDetails>,
    allow_continuation: bool,
) -> Result<()> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes");
    let artifact = TurnOutcomeArtifact {
        version: 1,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        status: status.to_string(),
        error: error.map(str::to_string),
        provider_failure: provider_failure.cloned(),
        continuation_context_hash: if allow_continuation
            && !engine.state.session_mode().is_orchestrate()
            && status == "failed"
            && provider_failure.is_some()
        {
            failed_turn::context_hash(&engine.state.messages()).ok()
        } else {
            None
        },
        completed_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
    };
    let filename = format!("{}.json", hex_sha256(turn_id.as_bytes()));
    transcript_artifact_journal::write(
        &artifact_dir,
        thread_id,
        transcript_artifact_journal::Kind::TurnOutcomes,
        || {
            write_private_artifact_file(
                &artifact_dir.join(filename),
                &serde_json::to_vec_pretty(&artifact)?,
            )
        },
    )
}

fn clear_turn_outcome(engine: &QueryEngine, thread_id: &str, turn_id: &str) -> Result<()> {
    let path = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes")
        .join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    transcript_artifact_journal::remove(
        &path,
        thread_id,
        transcript_artifact_journal::Kind::TurnOutcomes,
    )
    .context("failed to clear prior turn outcome")
}

fn save_turn_client_message_id(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    client_message_id: Option<&str>,
) -> Result<()> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-client-messages");
    let path = artifact_dir.join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let Some(client_message_id) = client_message_id.map(str::trim).filter(|id| !id.is_empty())
    else {
        return transcript_artifact_journal::remove(
            &path,
            thread_id,
            transcript_artifact_journal::Kind::TurnClientMessages,
        )
        .context("failed to clear prior client message identity");
    };
    let artifact = TurnClientMessageArtifact {
        version: 1,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        client_message_id: client_message_id.to_string(),
    };
    transcript_artifact_journal::write(
        &artifact_dir,
        thread_id,
        transcript_artifact_journal::Kind::TurnClientMessages,
        || write_private_artifact_file(&path, &serde_json::to_vec_pretty(&artifact)?),
    )
}

/// Records that this turn already accepted a continuation against `context_hash`.
fn save_turn_continuation_receipt(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    context_hash: &str,
    retry_operation_id: Option<&str>,
) -> Result<()> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations");
    let path = artifact_dir.join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let artifact = TurnContinuationArtifact {
        version: 1,
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        context_hash: context_hash.to_string(),
        retry_operation_id: retry_operation_id.map(str::to_string),
        accepted_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or_default(),
    };
    transcript_artifact_journal::write(
        &artifact_dir,
        thread_id,
        transcript_artifact_journal::Kind::TurnContinuations,
        || write_private_artifact_file(&path, &serde_json::to_vec_pretty(&artifact)?),
    )
}

fn load_turn_continuation_receipt(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
) -> Option<TurnContinuationArtifact> {
    let path = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations")
        .join(format!("{}.json", hex_sha256(turn_id.as_bytes())));
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
        return None;
    }
    let artifact =
        serde_json::from_slice::<TurnContinuationArtifact>(&std::fs::read(path).ok()?).ok()?;
    (artifact.version == 1 && artifact.thread_id == thread_id && artifact.turn_id == turn_id)
        .then_some(artifact)
}

/// The receipt for a retry operation identity, whichever turn it committed.
///
/// A retry operation names one recovery, so finding it under a different failed
/// turn means the identity is being reused rather than repeated.
fn turn_continuation_for_operation(
    engine: &QueryEngine,
    thread_id: &str,
    retry_operation_id: &str,
) -> Option<TurnContinuationArtifact> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-continuations");
    let entries = std::fs::read_dir(artifact_dir).ok()?;
    entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
                return None;
            }
            serde_json::from_slice::<TurnContinuationArtifact>(&std::fs::read(path).ok()?).ok()
        })
        .find(|artifact| {
            artifact.version == 1
                && artifact.thread_id == thread_id
                && artifact.retry_operation_id.as_deref() == Some(retry_operation_id)
        })
}

/// Answers a repeated continuation with the attempt that was already accepted.
///
/// The receipt only applies while the committed context still matches the
/// boundary it was accepted against and the failed turn is still the latest one;
/// otherwise the caller falls through to the normal validation, which refuses.
/// Digest of the committed *user inputs* only.
///
/// The accepted attempt appends assistant output and tool results of its own, so
/// the full-context digest of `failed_turn` cannot be used to recognise a replay.
/// Inputs are what a rollback, a compaction or a newer turn changes, and they are
/// never rewritten by the attempt itself.
fn input_context_hash(messages: &[kcoder_types::Message]) -> Result<String> {
    use kcoder_types::{ContentBlock, Message};
    let inputs = messages
        .iter()
        .filter(|message| match message {
            Message::User { content, .. } => content.iter().any(|block| {
                matches!(
                    block,
                    ContentBlock::Text { .. } | ContentBlock::Image { .. }
                )
            }),
            Message::Assistant { .. } => false,
        })
        .collect::<Vec<_>>();
    ensure!(!inputs.is_empty(), "No committed input to continue");
    Ok(hex_sha256(&serde_json::to_vec(&inputs)?))
}

fn replay_accepted_continuation(
    engine: &QueryEngine,
    thread_id: &str,
    failed_turn_id: &str,
    latest_turn: usize,
) -> Result<Option<Value>> {
    let Some(receipt) = load_turn_continuation_receipt(engine, thread_id, failed_turn_id) else {
        return Ok(None);
    };
    if failed_turn_id != format!("turn-{latest_turn}") {
        return Ok(None);
    }
    if input_context_hash(&engine.state.messages())? != receipt.context_hash {
        return Ok(None);
    }
    // The caller owns a fresh registration guard, so its running flag describes
    // this lookup, not the already accepted attempt. Read durable terminal evidence.
    let status = turn_receipts::terminal_status(engine, thread_id, failed_turn_id)
        .context("accepted continuation has no verifiable terminal status; inspect the existing attempt before retrying")?;
    Ok(Some(json!({
        "turn": { "id": failed_turn_id, "status": status, "threadId": thread_id }
    })))
}

/// The turn that already committed this client message identity, if any (S2/R034, S5/R045).
///
/// A commit is durable: the receipt is the per-turn artifact written when the
/// turn starts, so a retry after an unknown outcome finds it even across a
/// restart.
fn committed_turn_for_client_message(
    committed: &HashMap<String, String>,
    client_message_id: &str,
) -> Option<String> {
    committed
        .iter()
        .find(|(_, value)| value.as_str() == client_message_id)
        .map(|(turn_id, _)| turn_id.clone())
}

fn load_turn_client_message_ids(engine: &QueryEngine, thread_id: &str) -> HashMap<String, String> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-client-messages");
    let Ok(entries) = std::fs::read_dir(artifact_dir) else {
        return HashMap::new();
    };
    entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
                return None;
            }
            let artifact =
                serde_json::from_slice::<TurnClientMessageArtifact>(&std::fs::read(path).ok()?)
                    .ok()?;
            (artifact.version == 1
                && artifact.thread_id == thread_id
                && !artifact.client_message_id.trim().is_empty())
            .then_some((artifact.turn_id, artifact.client_message_id))
        })
        .collect()
}

fn apply_turn_client_message_ids(
    messages: &mut [ThreadMessage],
    client_message_ids: HashMap<String, String>,
) {
    for message in messages {
        if message.role != "user" {
            continue;
        }
        let Some(turn_id) = message.turn_id.as_deref() else {
            continue;
        };
        if let Some(client_message_id) = client_message_ids.get(turn_id) {
            message.client_message_id = Some(client_message_id.clone());
        }
    }
}

fn clone_turn_client_message_ids(
    engine: &QueryEngine,
    source_thread_id: &str,
    target_thread_id: &str,
) -> Result<()> {
    for (turn_id, client_message_id) in load_turn_client_message_ids(engine, source_thread_id) {
        save_turn_client_message_id(engine, target_thread_id, &turn_id, Some(&client_message_id))?;
    }
    Ok(())
}

fn load_turn_outcomes(
    engine: &QueryEngine,
    thread_id: &str,
) -> HashMap<String, TurnOutcomeArtifact> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-outcomes");
    let Ok(entries) = std::fs::read_dir(artifact_dir) else {
        return HashMap::new();
    };
    entries
        .take(10_000)
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 64 * 1024 {
                return None;
            }
            let artifact =
                serde_json::from_slice::<TurnOutcomeArtifact>(&std::fs::read(path).ok()?).ok()?;
            (artifact.version == 1
                && artifact.thread_id == thread_id
                && matches!(artifact.status.as_str(), "interrupted" | "failed"))
            .then_some((artifact.turn_id.clone(), artifact))
        })
        .collect()
}

fn apply_turn_outcomes(
    messages: &mut Vec<ThreadMessage>,
    outcomes: HashMap<String, TurnOutcomeArtifact>,
) {
    for (turn_id, outcome) in outcomes {
        if let Some(message) = messages.iter_mut().rfind(|message| {
            message.turn_id.as_deref() == Some(turn_id.as_str()) && message.role == "assistant"
        }) {
            apply_turn_outcome_to_message(message, &outcome);
            continue;
        }
        let Some(index) = messages
            .iter()
            .rposition(|message| message.turn_id.as_deref() == Some(turn_id.as_str()))
        else {
            continue;
        };
        messages.insert(
            index + 1,
            ThreadMessage {
                id: format!("turn-outcome-{}", hex_sha256(turn_id.as_bytes())),
                client_message_id: None,
                turn_id: Some(turn_id),
                role: "assistant".into(),
                content: String::new(),
                status: None,
                error: None,
                error_type: None,
                provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
                blocks: Vec::new(),
                timestamp_ms: outcome.completed_at_ms,
                content_truncated: false,
                content_original_chars: None,
            },
        );
        apply_turn_outcome_to_message(&mut messages[index + 1], &outcome);
    }
}

fn apply_turn_outcome_to_message(message: &mut ThreadMessage, outcome: &TurnOutcomeArtifact) {
    if outcome.status == "interrupted" {
        message.status = Some("cancelled".into());
        return;
    }
    message.status = Some("failed".into());
    message.error = outcome
        .error
        .clone()
        .or_else(|| Some("Task execution failed".into()));
    message.error_type = Some(
        outcome
            .provider_failure
            .as_ref()
            .map_or("response.failed", |details| details.category.as_str())
            .into(),
    );
    message.provider_failure = outcome.provider_failure.clone();
}

fn coalesce_assistant_tool_fragments(messages: &mut Vec<ThreadMessage>) {
    let mut coalesced = Vec::<ThreadMessage>::with_capacity(messages.len());
    for mut message in messages.drain(..) {
        let merge_with_previous = coalesced.last().is_some_and(|previous| {
            previous.role == "assistant"
                && message.role == "assistant"
                && previous.attempt_id.is_none()
                && message.attempt_id.is_none()
                && previous.turn_id.is_some()
                && previous.turn_id == message.turn_id
                && (!previous.blocks.is_empty() || !message.blocks.is_empty())
                && (previous.content.trim().is_empty() || message.content.trim().is_empty())
        });
        if !merge_with_previous {
            coalesced.push(message);
            continue;
        }

        let previous = coalesced.last_mut().expect("previous message exists");
        if !previous.content.trim().is_empty() && !message.blocks.is_empty() {
            // Commentary belongs before the next event, not below the accumulated tools.
            previous.blocks.push(json!({
                "id": format!("{}-text", previous.id),
                "type": "text",
                "content": std::mem::take(&mut previous.content),
                "status": "done",
                "timestamp": previous.timestamp_ms,
                "content_truncated": previous.content_truncated,
                "content_original_chars": previous.content_original_chars,
            }));
            previous.content_truncated = false;
            previous.content_original_chars = None;
        }
        if previous.content.trim().is_empty() && !message.content.trim().is_empty() {
            previous.content = std::mem::take(&mut message.content);
            previous.content_truncated = message.content_truncated;
            previous.content_original_chars = message.content_original_chars;
        }
        previous.blocks.append(&mut message.blocks);
        if message.status.is_some() {
            previous.status = message.status;
        }
    }
    let turn_started_at = coalesced
        .iter()
        .filter(|message| message.role == "user")
        .filter_map(|message| {
            message
                .turn_id
                .as_ref()
                .map(|turn_id| (turn_id.clone(), message.timestamp_ms))
        })
        .collect::<HashMap<_, _>>();
    for message in &mut coalesced {
        if message.role != "assistant" || message.blocks.is_empty() {
            continue;
        }
        if let Some(started_at) = message
            .turn_id
            .as_ref()
            .and_then(|turn_id| turn_started_at.get(turn_id))
        {
            message.timestamp_ms = message.timestamp_ms.min(*started_at);
        }
    }
    *messages = coalesced;
}

fn error_is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn load_turn_file_change_summaries(
    engine: &QueryEngine,
    thread_id: &str,
) -> HashMap<String, Value> {
    let artifact_dir = engine
        .session_storage_dir_for(thread_id)
        .join("turn-file-changes");
    let Ok(entries) = std::fs::read_dir(&artifact_dir) else {
        return HashMap::new();
    };
    entries
        .take(10_000)
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                return None;
            }
            let metadata = std::fs::symlink_metadata(&path).ok()?;
            if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
                return None;
            }
            let mut artifact =
                serde_json::from_slice::<TurnFileChangesArtifact>(&std::fs::read(&path).ok()?)
                    .ok()?;
            if artifact.thread_id != thread_id || !valid_artifact_id(&artifact.artifact_id) {
                return None;
            }
            let patch_path = artifact_dir.join(format!("{}.patch", artifact.artifact_id));
            if !std::fs::symlink_metadata(patch_path)
                .ok()
                .is_some_and(|metadata| {
                    metadata.file_type().is_file()
                        && metadata.len() > 0
                        && metadata.len() <= MAX_TURN_FILE_CHANGES_BYTES as u64
                })
            {
                artifact.status = "artifact_missing".into();
            }
            Some((
                artifact.turn_id.clone(),
                turn_file_changes_summary(&artifact),
            ))
        })
        .collect()
}

fn attach_turn_file_change_blocks(
    messages: &mut [ThreadMessage],
    summaries: HashMap<String, Value>,
) {
    for (turn_id, summary) in summaries {
        let target_index = messages
            .iter_mut()
            .rposition(|message| {
                message.turn_id.as_deref() == Some(turn_id.as_str()) && message.role == "assistant"
            })
            .or_else(|| {
                messages
                    .iter()
                    .rposition(|message| message.turn_id.as_deref() == Some(turn_id.as_str()))
            });
        if let Some(index) = target_index {
            let message = &mut messages[index];
            message.blocks.push(json!({
                "id": format!("file-changes-{}", summary["artifact_id"].as_str().unwrap_or("missing")),
                "type": "file_changes",
                "status": "done",
                "fileChanges": summary.clone(),
                "file_changes": summary,
            }));
        }
    }
}

fn client_transcript_turn_count(entries: &[kcoder_state::HistoryEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| kcoder_engine::agent::is_real_user_message(&entry.message))
        .count()
}

fn thread_history_path(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    if thread_id == engine.session_id() {
        return engine
            .state
            .history_path()
            .context("session history is disabled");
    }
    let history_path = engine
        .state
        .history_path()
        .context("session history is disabled")?;
    let history_dir = history_path
        .parent()
        .context("session history path has no parent")?;
    let path = candidate_thread_history_path(history_dir, thread_id)?;
    let metadata = std::fs::symlink_metadata(&path)
        .with_context(|| format!("persisted thread not found: {thread_id}"))?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("persisted thread is not a regular file: {thread_id}")
    }
    let expected = std::fs::canonicalize(engine.state.cwd())?;
    let persisted = kcoder_state::history_persisted_base_cwd(&path)?
        .context("persisted thread has no base cwd")?;
    if std::fs::canonicalize(&persisted)? != expected {
        anyhow::bail!("persisted thread belongs to another workspace")
    }
    Ok(path)
}

fn candidate_thread_history_path(history_dir: &Path, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    Ok(history_dir.join(format!("{thread_id}.jsonl")))
}

fn validate_thread_id(thread_id: &str) -> Result<()> {
    if !is_valid_external_artifact_id(thread_id) {
        anyhow::bail!("invalid thread id")
    }
    Ok(())
}

fn validate_worktree_id(worktree_id: &str) -> Result<()> {
    if !is_valid_external_artifact_id(worktree_id) {
        anyhow::bail!("invalid worktree id")
    }
    Ok(())
}

fn is_valid_external_artifact_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        && !is_windows_reserved_basename(id)
}

fn is_windows_reserved_basename(value: &str) -> bool {
    let trimmed = value.trim_end_matches(['.', ' ']);
    let basename = trimmed.split('.').next().unwrap_or(trimmed);
    matches!(
        basename.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn history_entry_thread_message(
    index: usize,
    entry: kcoder_state::HistoryEntry,
    turn_id: Option<String>,
    tool_contexts: &TranscriptToolContexts,
) -> Option<ThreadMessage> {
    let serialized = serde_json::to_value(&entry.message).ok()?;
    let mut role = serialized.get("role")?.as_str()?.to_owned();
    let content_blocks = serialized.get("content")?.as_array()?;
    let mut text_parts = Vec::new();
    let mut blocks = Vec::new();
    let mut tool_result_only = !content_blocks.is_empty();
    for (block_index, block) in content_blocks.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if role == "user"
                        && matches!(
                            entry.message.origin(),
                            kcoder_types::MessageOrigin::Runtime
                                | kcoder_types::MessageOrigin::Compaction
                        )
                    {
                        continue;
                    }
                    tool_result_only = false;
                    let has_later_activity = role == "assistant"
                        && content_blocks[block_index + 1..].iter().any(|block| {
                            matches!(
                                block.get("type").and_then(Value::as_str),
                                Some("tool_use" | "thinking" | "redacted_thinking")
                            )
                        });
                    if has_later_activity {
                        let (content, truncated, original_chars) =
                            truncate_utf8_bytes(text.to_owned(), MAX_TRANSCRIPT_MESSAGE_BYTES);
                        blocks.push(json!({
                            "id": format!("{}-text-{block_index}", entry.uuid.as_deref().unwrap_or(&entry.session_id)),
                            "type": "text", "content": content, "status": "done",
                            "timestamp": entry.timestamp_ms,
                            "content_truncated": truncated, "content_original_chars": original_chars,
                        }));
                    } else {
                        text_parts.push(text);
                    }
                }
            }
            Some("thinking") => {
                tool_result_only = false;
                let content = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !content.is_empty() {
                    blocks.push(json!({
                        "id": format!("{}-thinking-{block_index}", entry.uuid.as_deref().unwrap_or(&entry.session_id)),
                        "type": "thinking",
                        "content": content,
                        "status": "done",
                        "timestamp": entry.timestamp_ms,
                    }));
                }
            }
            Some("redacted_thinking") => {
                tool_result_only = false;
                blocks.push(json!({
                    "id": format!("{}-thinking-{block_index}", entry.uuid.as_deref().unwrap_or(&entry.session_id)),
                    "type": "thinking",
                    "content": "[redacted thinking]",
                    "status": "done",
                    "timestamp": entry.timestamp_ms,
                }));
            }
            Some("tool_use") => {
                tool_result_only = false;
                let Some(id) = block.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let context = transcript_tool_context(tool_contexts, id, index);
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                let input = block.get("input").cloned().unwrap_or_else(|| json!({}));
                blocks.push(transcript_tool_block(
                    id,
                    name,
                    input,
                    context.and_then(|context| context.output.clone()),
                    context.is_some_and(|context| context.is_error),
                    context
                        .map(|context| context.started_at_ms)
                        .unwrap_or(entry.timestamp_ms),
                    context.and_then(|context| context.completed_at_ms),
                ));
            }
            Some("tool_result") => {
                let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                    continue;
                };
                let context = transcript_tool_context(tool_contexts, id, index);
                // Completed calls stay at their original call position, even when
                // parallel results arrive out of order. Orphan results remain visible.
                if context.is_some_and(|context| context.has_tool_use) {
                    continue;
                }
                let output = nested_text_content(block.get("content"));
                let is_error = block
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                blocks.push(transcript_tool_block(
                    id,
                    context
                        .map(|context| context.name.as_str())
                        .unwrap_or("tool"),
                    context
                        .map(|context| context.input.clone())
                        .unwrap_or_else(|| json!({})),
                    Some(output),
                    is_error,
                    context
                        .map(|context| context.started_at_ms)
                        .unwrap_or(entry.timestamp_ms),
                    context
                        .and_then(|context| context.completed_at_ms)
                        .or(Some(entry.timestamp_ms)),
                ));
            }
            Some("image") => {
                tool_result_only = false;
                text_parts.push("[image]");
            }
            _ => tool_result_only = false,
        }
    }
    if role == "user" && tool_result_only && !blocks.is_empty() {
        role = "assistant".to_string();
    }
    let content = text_parts.join("\n");
    let (content, attachment_blocks) = split_history_attachment_envelope(content);
    blocks.extend(attachment_blocks);
    if content.trim().is_empty() && blocks.is_empty() {
        return None;
    }
    let (content, content_truncated, content_original_chars) =
        truncate_utf8_bytes(content, MAX_TRANSCRIPT_MESSAGE_BYTES);
    Some(ThreadMessage {
        id: entry
            .uuid
            .unwrap_or_else(|| format!("{}-{index}", entry.session_id)),
        client_message_id: None,
        turn_id,
        role,
        content,
        status: None,
        error: None,
        error_type: None,
        provider_failure: None,
                attempt_id: None,
                continued_by_attempt_id: None,
        blocks,
        timestamp_ms: entry.timestamp_ms,
        content_truncated,
        content_original_chars: content_truncated.then_some(content_original_chars),
    })
}

#[derive(Clone)]
#[cfg_attr(test, derive(serde::Serialize))]
struct TranscriptToolContext {
    entry_index: usize,
    last_reference_index: usize,
    name: String,
    input: Value,
    has_tool_use: bool,
    output: Option<String>,
    is_error: bool,
    started_at_ms: u64,
    completed_at_ms: Option<u64>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct TranscriptToolId(Arc<str>);

impl From<&str> for TranscriptToolId {
    fn from(value: &str) -> Self {
        Self(Arc::from(value))
    }
}
impl std::borrow::Borrow<str> for TranscriptToolId {
    fn borrow(&self) -> &str {
        &self.0
    }
}
#[cfg(test)]
impl serde::Serialize for TranscriptToolId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

type TranscriptToolContexts = HashMap<TranscriptToolId, Vec<TranscriptToolContext>>;

#[cfg(test)]
fn transcript_tool_contexts(entries: &[kcoder_state::HistoryEntry]) -> TranscriptToolContexts {
    let mut contexts = TranscriptToolContexts::new();
    transcript_context_oracle::extend(&mut contexts, entries, 0);
    contexts
}

fn extend_transcript_tool_contexts(
    contexts: &mut TranscriptToolContexts,
    entries: &[kcoder_state::HistoryEntry],
    offset: usize,
) {
    use kcoder_types::{ContentBlock, Message};
    for (entry_index, entry) in entries.iter().enumerate() {
        let entry_index = offset + entry_index;
        let blocks = match &entry.message {
            Message::User { content, .. } | Message::Assistant { content, .. } => content,
        };
        for block in blocks {
            match block {
                ContentBlock::ToolUse { id, name, input } => {
                    contexts
                        .entry(id.as_str().into())
                        .or_default()
                        .push(TranscriptToolContext {
                            entry_index,
                            last_reference_index: entry_index,
                            name: name.clone(),
                            input: input.clone(),
                            has_tool_use: true,
                            output: None,
                            is_error: false,
                            started_at_ms: entry.timestamp_ms,
                            completed_at_ms: None,
                        });
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let calls = contexts.entry(tool_use_id.as_str().into()).or_default();
                    if calls.is_empty() {
                        calls.push(TranscriptToolContext {
                            entry_index,
                            last_reference_index: entry_index,
                            name: "tool".to_string(),
                            input: json!({}),
                            has_tool_use: false,
                            output: None,
                            is_error: false,
                            started_at_ms: entry.timestamp_ms,
                            completed_at_ms: Some(entry.timestamp_ms),
                        });
                    }
                    if let Some(context) = calls.last_mut() {
                        context.last_reference_index = entry_index;
                        context.completed_at_ms = Some(entry.timestamp_ms);
                        context.output = Some(
                            content
                                .iter()
                                .filter_map(|block| match block {
                                    ContentBlock::Text { text } => Some(text.as_str()),
                                    _ => None,
                                })
                                .collect::<Vec<_>>()
                                .join("\n"),
                        );
                        context.is_error = is_error.unwrap_or(false);
                    }
                }
                _ => {}
            }
        }
    }
}

fn transcript_tool_context<'a>(
    contexts: &'a TranscriptToolContexts,
    id: &str,
    entry_index: usize,
) -> Option<&'a TranscriptToolContext> {
    // Providers may reuse a call id in a later turn. Bind each result to the
    // preceding occurrence instead of replacing older calls with the latest result.
    let calls = contexts.get(id)?;
    let position = calls.partition_point(|call| call.entry_index <= entry_index);
    calls.get(position.checked_sub(1)?)
}

fn nested_text_content(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn transcript_tool_block(
    id: &str,
    name: &str,
    input: Value,
    output: Option<String>,
    is_error: bool,
    started_at_ms: u64,
    completed_at_ms: Option<u64>,
) -> Value {
    let render_payload = if name.eq_ignore_ascii_case("AskUserQuestion")
        || name.eq_ignore_ascii_case("ask_user_question")
    {
        let questions = input
            .get("questions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
            .map(|(index, value)| {
                let mut question = value.clone();
                if let Some(object) = question.as_object_mut() {
                    object
                        .entry("id")
                        .or_insert_with(|| json!(format!("question-{}", index + 1)));
                }
                question
            })
            .collect::<Vec<_>>();
        let response = output
            .as_deref()
            .and_then(|value| transcript_user_question_response(id, &questions, value));
        Some(json!({
            "kind": "request_user_input",
            "itemId": id,
            "questions": questions,
            "response": response,
        }))
    } else {
        None
    };
    json!({
        "id": id,
        "type": "tool",
        "tool_use_id": id,
        "tool_name": name,
        "tool_input": input,
        "tool_output": output,
        "render_payload": render_payload,
        "status": if output.is_none() { "pending" } else if is_error { "error" } else { "done" },
        "timestamp": started_at_ms,
        "completed_at": completed_at_ms,
    })
}

fn transcript_user_question_response(id: &str, questions: &[Value], output: &str) -> Option<Value> {
    let parsed = serde_json::from_str::<Value>(output).ok()?;
    let raw_answers = parsed.get("answers").and_then(Value::as_object)?;
    let answers = questions
        .iter()
        .filter_map(|question| {
            let question_id = question.get("id").and_then(Value::as_str)?;
            let question_text = question.get("question").and_then(Value::as_str);
            let raw_answer = raw_answers
                .get(question_id)
                .or_else(|| question_text.and_then(|text| raw_answers.get(text)))?;
            let answer = match raw_answer {
                Value::String(value) => json!({ "answers": [value] }),
                Value::Array(values) => json!({ "answers": values }),
                Value::Object(object)
                    if object.get("answers").and_then(Value::as_array).is_some() =>
                {
                    raw_answer.clone()
                }
                _ => return None,
            };
            Some((question_id.to_string(), answer))
        })
        .collect::<serde_json::Map<_, _>>();

    Some(json!({
        "itemId": id,
        "answers": answers,
    }))
}

fn truncate_utf8_bytes(mut value: String, max_bytes: usize) -> (String, bool, usize) {
    let original_chars = value.chars().count();
    if value.len() <= max_bytes {
        return (value, false, original_chars);
    }
    let mut boundary = max_bytes.min(value.len());
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    (value, true, original_chars)
}

fn persisted_thread_value(
    engine: &QueryEngine,
    session_id: &str,
    path: &Path,
    running: bool,
) -> Result<Value> {
    let metadata = kcoder_state::prepare_session_metadata(path)?;
    persisted_thread_value_with_metadata(engine, session_id, &metadata, running, false)
}

fn persisted_thread_value_with_metadata(
    engine: &QueryEngine,
    session_id: &str,
    metadata: &kcoder_state::PreparedSessionMetadata,
    running: bool,
    strict_metadata: bool,
) -> Result<Value> {
    let (created_at, updated_at) = metadata.timestamps_ms()?;
    let cwd = metadata
        .base_cwd()
        .map(|base| dunce::simplified(base).to_string_lossy().into_owned());
    let mut snapshot = json!({
        "id": session_id,
        "cwd": cwd,
        "sessionMode": metadata.session_mode(),
        "title": metadata.first_prompt(80),
        "status": if running { "running" } else { "idle" },
        "createdAt": created_at.to_string(),
        "updatedAt": updated_at.to_string(),
    });
    decorate_thread_snapshot(engine, &mut snapshot, strict_metadata)?;
    Ok(snapshot)
}

fn prepare_persisted_thread_resume(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<(kcoder_state::PreparedSessionResume, SessionLease, usize)> {
    // Resolve the lease from the validated session id before parsing history. A completed turn's
    // transcript is flushed asynchronously, but its lease already exists; this ordering makes an
    // immediate contender deterministically report "active" instead of racing with persistence.
    let current_history = engine
        .state
        .history_path()
        .context("session history is disabled")?;
    let history_dir = current_history
        .parent()
        .context("session history path has no parent")?;
    let path = candidate_thread_history_path(history_dir, thread_id)?;
    let lease = SessionLease::acquire_existing_history(&path)?;
    let path = thread_history_path(engine, thread_id)?;
    let (prepared, client_turn_count) =
        kcoder_state::prepare_session_resume_real_user_counting(&path)?;
    let expected = std::fs::canonicalize(engine.state.cwd())?;
    let persisted = prepared
        .persisted_base_cwd()
        .context("persisted thread has no base cwd")?;
    if std::fs::canonicalize(persisted)? != expected {
        anyhow::bail!("persisted thread belongs to another workspace")
    }
    Ok((prepared, lease, client_turn_count))
}

fn with_event_context(
    server_id: &str,
    thread_id: &str,
    turn_id: Option<&str>,
    sequence: &AtomicU64,
    mut payload: Value,
) -> Value {
    let object = payload
        .as_object_mut()
        .expect("event notification payload must be an object");
    object.insert("serverId".into(), json!(server_id));
    object.insert("threadId".into(), json!(thread_id));
    if let Some(turn_id) = turn_id {
        object.insert("turnId".into(), json!(turn_id));
    }
    object.insert(
        "sequence".into(),
        json!(sequence.fetch_add(1, Ordering::Relaxed)),
    );
    payload
}

fn turn_completion_error(
    message: Option<String>,
    details: Option<kcoder_types::ProviderFailureDetails>,
) -> Option<Value> {
    message.map(|message| json!({"code": -32010, "message": message, "details": details}))
}

fn terminal_outcome(event: &EngineEvent, cancelled: bool) -> Option<(&'static str, String)> {
    match event {
        EngineEvent::Error(message) | EngineEvent::ProviderFailed { message, .. } => {
            Some(("failed", message.clone()))
        }
        EngineEvent::StreamAborted { reason } => Some((
            if cancelled { "interrupted" } else { "failed" },
            reason.clone(),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod outbound_frame_limit_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn small_frames_pass_through_unchanged() {
        let message = json!({"jsonrpc": "2.0", "id": 7, "result": {"ok": true}});
        let bytes = bounded_outbound_frame(message.clone(), 4096).expect("small frame kept");
        assert_eq!(bytes, serde_json::to_vec(&message).unwrap());
    }

    #[test]
    fn oversized_responses_become_an_error_with_the_same_id() {
        let message = json!({"jsonrpc": "2.0", "id": 7, "result": {"blob": "x".repeat(4096)}});
        let bytes =
            bounded_outbound_frame(message, 1024).expect("response degrades, connection kept");
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["id"], json!(7));
        assert_eq!(value["error"]["code"], json!(OUTBOUND_FRAME_LIMIT_CODE));
        assert!(value.get("result").is_none());
    }

    #[test]
    fn oversized_notifications_are_dropped() {
        let message =
            json!({"jsonrpc": "2.0", "method": "turn/item", "params": {"blob": "x".repeat(4096)}});
        assert!(bounded_outbound_frame(message, 1024).is_none());
    }

    #[test]
    fn review_payload_marks_truncation_and_keeps_the_prefix() {
        let small = turn_file_changes_review_payload("tiny diff".to_string(), 4096);
        assert_eq!(small["diff"], json!("tiny diff"));
        assert_eq!(small["diffTruncated"], json!(false));

        let large = turn_file_changes_review_payload("x".repeat(8192), 1024);
        assert_eq!(large["diffTruncated"], json!(true));
        assert_eq!(large["diffOriginalBytes"], json!(8192));
        let diff = large["diff"].as_str().unwrap();
        assert!(diff.len() <= 1024);
    }

    #[test]
    fn review_payload_counts_original_bytes_not_chars() {
        // truncate_utf8_bytes 的第三返回值是字符数；本测试钉住字节语义
        //（"日本語".repeat(2) = 6 字符 × 3 字节 = 18 字节）。
        let payload = turn_file_changes_review_payload("日本語".repeat(2), 1024);
        assert_eq!(payload["diffOriginalBytes"], json!(18));
        assert_eq!(payload["diffTruncated"], json!(false));
    }
}
