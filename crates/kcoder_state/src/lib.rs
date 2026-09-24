pub mod turn_attempt_store;
use anyhow::Context;
use fs2::FileExt;
use kcoder_types::{ContentBlock, Message, MessageRole, MessagesRequest, StreamEvent, Usage};
use serde::{Deserialize, Serialize};
pub mod short_id;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::SystemTime;
use tokio::sync::{mpsc, oneshot};
use tracing::{info, warn};

mod agent_breaker;
mod message_revision;
pub use message_revision::MessageRevision;

/// A freshly allocated identity, reserved before an existing session is changed.
pub struct ReservedSessionId(String);
mod agent_fleet;
mod artifact_requirements;
mod artifacts;
pub use artifact_requirements::{
    ArtifactBaseline, ArtifactBaselineState, ArtifactRequirement, ArtifactValidationEntry,
    ArtifactValidationReport, ArtifactValidationRun, ArtifactValidationStatus,
    artifact_declarations_sha256, deserialize_artifact_requirements,
    validate_artifact_requirements,
};
mod diagnostic_capture;
mod diagnostic_writer;
mod goal;
mod goal_state;
mod history;
mod history_flusher;
pub mod history_index;
mod history_metadata;
mod history_store;
mod llm_history;
mod model;
pub mod orchestrate_store;
mod recovery_record;
mod runtime_audit;
pub use recovery_record::{RecoveryCapture, RecoveryDecision, RecoveryOutcome};
mod background_delivery;
pub use background_delivery::{MAX_BACKGROUND_RUNS_PER_TASK, MAX_BACKGROUND_TASK_IDENTITIES};
mod session_persistence;
mod task_state;
pub use background_delivery::{BackgroundHookReceipt, BackgroundRunRecord};
pub mod usage_history;

pub use artifacts::{
    artifact_id_path_component, goal_workspace_baseline_bundle_path, llm_request_history_dir_path,
    managed_task_output_path, session_dir_path, session_memory_llm_request_history_dir_path,
    session_memory_summary_path, session_state_path, subagent_llm_request_history_dir_path,
    subagent_output_path, subagent_transcript_path,
};
pub use diagnostic_capture::{DiagnosticRequest, LlmExchangeCapture};
pub use diagnostic_writer::{DiagnosticBarrier, DiagnosticWriter, DiagnosticWriterStats};
pub use goal::{
    GOAL_CONTEXT_SNAPSHOT_CHAR_LIMIT, GOAL_EVENT_CAPACITY, GOAL_OBJECTIVE_INLINE_CHAR_LIMIT, Goal,
    GoalEvent, GoalEventKind, GoalMode, GoalStatus, GoalVerificationCommitOutcome,
    GoalVerificationKind, GoalVerificationVerdict, GoalVerifierSelection, GoalWorkspaceBaseline,
    PreparedGoalObjective, goal_context_snapshot, goal_objective_text, goal_report_relative_path,
    prepare_goal_objective,
};
pub use history::{
    BoundedTranscriptReader, PreparedSessionResume, PreparedTranscriptHistory,
    ProjectedTranscriptReader, SessionCandidateBatch, SessionCandidateScan,
    SessionCandidateScanner, delete_session_history_files, history_has_persisted_session_cwd,
    history_persisted_base_cwd, history_persisted_goal, history_persisted_goal_history,
    history_persisted_session_mode, load_history, load_transcript_history,
    load_transcript_history_bounded, prepare_session_resume, prepare_session_resume_counting,
    prepare_session_resume_real_user_counting, prune_session_history, recent_session_candidates,
    recent_session_candidates_report, recent_sessions, session_first_prompt,
    session_first_timestamp_ms, session_timestamps_ms,
};
use history_flusher::*;
pub use history_metadata::{
    PreparedSessionMetadata, prepare_session_metadata, prepare_session_metadata_bounded,
};
use history_store::HistorySource;
use llm_history::*;
pub use model::{
    AgentBreakerState, AgentControlAction, AgentControlBoundaryOutcome, AgentControlReceipt,
    AgentControlState, AgentDeliveryClaim, AgentDeliveryClaimOutcome, AgentDeliveryEnqueueReceipt,
    AgentDeliveryFailureOutcome, AgentFleetDelta, AgentFleetSnapshot, AgentMessageLease,
    AgentMessageStatus, AgentRunMode, AgentUsageSummary, BoundedDiagnostic, BreakerDecision,
    BreakerStage, CompactionTranscriptEvent, CompactionTrigger, ConversationRewindOutcome,
    FileReadSnapshot, FleetMemberSnapshot, HistoryEntry, PendingSteer, PruneSessionHistoryReport,
    QueuedAgentMessage, ReadRangeKey, SessionMemorySnapshot, SessionMode, SessionSnapshot, Task,
    TaskDelivery, TaskKind, TaskStatus, TodoItem, TodoStatus, TranscriptDeliveryAnchor,
    WorktreeSessionState,
};
use model::{CompactionTranscriptMetadata, PreservedTranscriptSegment};
pub use runtime_audit::{
    OrchestrateRuntimeAuditPolicy, OrchestrateRuntimeDiagnosticExport, OrchestrateRuntimeEvent,
};
use session_persistence::*;

/// Opaque weak identity for owner-bound, in-memory read snapshots. It does not
/// retain conversation payloads or expose the persistence lock.
#[derive(Clone)]
pub struct AppStateIdentity(std::sync::Weak<RwLock<AppStateInner>>);
impl AppStateIdentity {
    pub fn matches(&self, state: &AppState) -> bool {
        std::sync::Weak::ptr_eq(&self.0, &Arc::downgrade(&state.inner))
    }
}

/// Central application state shared across the REPL, engine, and tools.
#[derive(Debug, Clone)]
pub struct AppState {
    inner: Arc<RwLock<AppStateInner>>,
    usage_history_root: Arc<RwLock<Option<PathBuf>>>,
    diagnostic_context: Arc<diagnostic_capture::DiagnosticContext>,
    session_state_persist_lock: Arc<Mutex<()>>,
    /// Fleet construction reads AppState and PlanStore; this ordering gate prevents concurrent snapshots from committing digests out of order.
    fleet_snapshot_lock: Arc<Mutex<()>>,
    /// The runtime is the sole audit-file writer. This lock is separate from core sidecar locks so diagnostic I/O cannot block state transactions.
    runtime_audit_lock: Arc<Mutex<()>>,
    runtime_audit_policy: Arc<RwLock<OrchestrateRuntimeAuditPolicy>>,
    /// Explicit degradation reason retained when core state commits but a diagnostic event cannot be persisted.
    runtime_audit_degradation: Arc<RwLock<Option<String>>>,
}

#[derive(Debug)]
struct AppStateInner {
    pub short_id_registry: Option<PathBuf>,
    pub messages: kcoder_types::SharedMessages,
    pub message_revision: MessageRevision,
    /// Permanently set once the first message enters this session. Compaction,
    /// rewind, and internal message replacement must not reopen SessionMode's set-once gate.
    pub conversation_started: bool,
    pub cwd: PathBuf,
    /// Sole source of truth for session-level mode; the goal lifecycle cannot clear it.
    pub session_mode: SessionMode,
    pub workflow_definition_id: Option<String>,
    pub model_selection_mode: kcoder_types::ModelSelectionMode,
    pub selected_model: Option<String>,
    /// The original working directory used to start the session. Restored by
    /// ExitWorktree when leaving a git worktree.
    pub base_cwd: PathBuf,
    pub session_id: String,
    pub session_created_at_ms: u64,
    pub session_updated_at_ms: u64,
    pub history_path: Option<PathBuf>,
    /// Optional raw model exchange directory for forked sub-agent engines.
    pub llm_request_history_override: Option<LlmRequestHistoryLocation>,
    /// Optional session artifact root for in-memory/forked engines that do not
    /// own a transcript history path. This prevents nested task artifacts from
    /// falling back to `<cwd>/.kcoder/projects`.
    pub session_artifact_override: Option<SessionArtifactLocation>,
    /// Sidecar state file for session metadata not represented as model
    /// messages, such as `/goal` status.
    pub session_state_path: Option<PathBuf>,
    /// Transcript UUIDs aligned with `messages`; `None` means the message is
    /// model-only state that is not represented by a JSONL transcript entry.
    pub message_history_ids: Vec<Option<String>>,
    /// Last UUID in the append-only transcript, used for parent chaining.
    pub last_history_uuid: Option<String>,
    /// Timestamp of the latest assistant message in the active model history.
    /// Kept separately because provider `Message` values intentionally contain
    /// no persistence metadata.
    pub last_assistant_message_timestamp_ms: Option<u64>,
    /// Background history flusher, if one has been started.
    pub history_flusher: Option<HistoryFlusher>,
    /// Fixed source identity shared by direct writes, snapshots, and the background worker.
    pub history_source: Option<HistorySource>,
    /// Direct writes stay disabled after any unretained write failure.
    pub history_write_fault: Option<String>,
    /// Maximum number of messages to keep in the in-memory buffer.
    pub history_max_messages: usize,
    pub todos: Vec<TodoItem>,
    pub tasks: HashMap<String, Task>,
    /// When set, the session is in plan mode and these instructions should be
    /// injected into the system prompt / compact attachments.
    pub plan_mode: Option<String>,
    /// Active or recently stopped `/goal` objective.
    pub goal: Option<Goal>,
    /// Terminal `/goal` objectives from this session.
    pub goal_history: Vec<Goal>,
    /// Per-session Markdown memory metadata.
    pub session_memory: Option<SessionMemorySnapshot>,
    /// Files read during this session, used to reject stale write/edit calls.
    pub file_reads: HashMap<PathBuf, FileReadSnapshot>,
    /// Retain the most recent full read independently from range reads so a range snapshot cannot overwrite the compaction anchor.
    pub full_file_reads: HashMap<PathBuf, FileReadSnapshot>,
    /// Absolute normalized key frozen when Read executes. Compaction must not reinterpret historical tool input through a cwd that may have changed.
    read_tool_call_keys: HashMap<String, FileReadKey>,
    /// Worktree entered or created by this session, if any. This lets
    /// ExitWorktree fail closed instead of operating on arbitrary directories.
    pub active_worktree: Option<WorktreeSessionState>,
    /// Increment only when the observable fleet digest changes; not persisted to a sidecar.
    fleet_revision: u64,
    last_fleet_digest: Option<String>,
    /// Bounded fleet baseline most recently inserted into model context, used only to generate deltas.
    last_injected_fleet_digest: Option<String>,
    last_injected_fleet_members: HashMap<String, String>,
}

#[derive(Debug, Clone)]
struct SessionArtifactLocation {
    project_dir: PathBuf,
    session_id: String,
}

impl AppState {
    /// Allocate a durable short ID before exposing a new persistent session.
    pub fn new_with_short_id(cwd: impl Into<PathBuf>, registry: &Path) -> anyhow::Result<Self> {
        let id = short_id::reserve_short_id(registry)?;
        let state = Self::new(cwd);
        state.write_inner().session_id = id;
        state.set_short_id_registry(registry);
        Ok(state)
    }

    pub fn set_short_id_registry(&self, registry: &Path) {
        self.write_inner().short_id_registry = Some(registry.to_path_buf());
    }

    pub fn short_id_registry(&self) -> Option<PathBuf> {
        self.read_inner().short_id_registry.clone()
    }

    pub fn reserve_new_session_id(&self) -> anyhow::Result<ReservedSessionId> {
        let id = match self.short_id_registry() {
            Some(registry) => short_id::reserve_short_id(&registry)?,
            None => generate_session_id(),
        };
        Ok(ReservedSessionId(id))
    }
    /// Compare ownership without acquiring the state lock.
    pub fn inspection_identity(&self) -> AppStateIdentity {
        AppStateIdentity(Arc::downgrade(&self.inner))
    }

    pub fn shares_state_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        let cwd = cwd.into();
        let timestamp_ms = now_millis();
        Self {
            usage_history_root: Arc::new(RwLock::new(None)),
            diagnostic_context: Arc::new(diagnostic_capture::DiagnosticContext::default()),
            session_state_persist_lock: Arc::new(Mutex::new(())),
            fleet_snapshot_lock: Arc::new(Mutex::new(())),
            runtime_audit_lock: Arc::new(Mutex::new(())),
            runtime_audit_policy: Arc::new(RwLock::new(OrchestrateRuntimeAuditPolicy::default())),
            runtime_audit_degradation: Arc::new(RwLock::new(None)),
            inner: Arc::new(RwLock::new(AppStateInner {
                short_id_registry: None,
                messages: Default::default(),
                message_revision: MessageRevision::default(),
                conversation_started: false,
                cwd: cwd.clone(),
                session_mode: SessionMode::Default,
                workflow_definition_id: None,
                model_selection_mode: Default::default(),
                selected_model: None,
                base_cwd: cwd,
                session_id: generate_session_id(),
                session_created_at_ms: timestamp_ms,
                session_updated_at_ms: timestamp_ms,
                history_path: None,
                llm_request_history_override: None,
                session_artifact_override: None,
                session_state_path: None,
                message_history_ids: Vec::new(),
                last_history_uuid: None,
                last_assistant_message_timestamp_ms: None,
                history_flusher: None,
                history_source: None,
                history_write_fault: None,
                history_max_messages: default_history_max_messages(),
                todos: Vec::new(),
                tasks: HashMap::new(),
                plan_mode: None,
                goal: None,
                goal_history: Vec::new(),
                session_memory: None,
                file_reads: HashMap::new(),
                full_file_reads: HashMap::new(),
                read_tool_call_keys: HashMap::new(),
                active_worktree: None,
                fleet_revision: 0,
                last_fleet_digest: None,
                last_injected_fleet_digest: None,
                last_injected_fleet_members: HashMap::new(),
            })),
        }
    }

    pub fn with_messages(cwd: impl Into<PathBuf>, messages: Vec<Message>) -> Self {
        let cwd = cwd.into();
        let timestamp_ms = now_millis();
        let message_count = messages.len();
        Self {
            usage_history_root: Arc::new(RwLock::new(None)),
            diagnostic_context: Arc::new(diagnostic_capture::DiagnosticContext::default()),
            session_state_persist_lock: Arc::new(Mutex::new(())),
            fleet_snapshot_lock: Arc::new(Mutex::new(())),
            runtime_audit_lock: Arc::new(Mutex::new(())),
            runtime_audit_policy: Arc::new(RwLock::new(OrchestrateRuntimeAuditPolicy::default())),
            runtime_audit_degradation: Arc::new(RwLock::new(None)),
            inner: Arc::new(RwLock::new(AppStateInner {
                short_id_registry: None,
                messages: messages.into(),
                message_revision: MessageRevision::default(),
                conversation_started: message_count > 0,
                cwd: cwd.clone(),
                session_mode: SessionMode::Default,
                workflow_definition_id: None,
                model_selection_mode: Default::default(),
                selected_model: None,
                base_cwd: cwd,
                session_id: generate_session_id(),
                session_created_at_ms: timestamp_ms,
                session_updated_at_ms: timestamp_ms,
                history_path: None,
                llm_request_history_override: None,
                session_artifact_override: None,
                session_state_path: None,
                message_history_ids: vec![None; message_count],
                last_history_uuid: None,
                last_assistant_message_timestamp_ms: None,
                history_flusher: None,
                history_source: None,
                history_write_fault: None,
                history_max_messages: default_history_max_messages(),
                todos: Vec::new(),
                tasks: HashMap::new(),
                plan_mode: None,
                goal: None,
                goal_history: Vec::new(),
                session_memory: None,
                file_reads: HashMap::new(),
                full_file_reads: HashMap::new(),
                read_tool_call_keys: HashMap::new(),
                active_worktree: None,
                fleet_revision: 0,
                last_fleet_digest: None,
                last_injected_fleet_digest: None,
                last_injected_fleet_members: HashMap::new(),
            })),
        }
    }

    fn lock_session_state_persistence(&self) -> MutexGuard<'_, ()> {
        maybe_wait_before_session_state_lock(Arc::as_ptr(&self.session_state_persist_lock) as usize);
        self.session_state_persist_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn read_inner(&self) -> RwLockReadGuard<'_, AppStateInner> {
        self.inner.read().unwrap_or_else(|poisoned| {
            warn!("AppState read lock was poisoned; recovering the contained state");
            poisoned.into_inner()
        })
    }

    fn write_inner(&self) -> RwLockWriteGuard<'_, AppStateInner> {
        self.inner.write().unwrap_or_else(|poisoned| {
            warn!("AppState write lock was poisoned; recovering the contained state");
            poisoned.into_inner()
        })
    }

    /// Route task/sub-agent artifacts for a history-less engine to an
    /// explicit session tree outside its workspace.
    pub fn with_session_artifact_project_dir(
        &self,
        project_dir: impl Into<PathBuf>,
        session_id: impl Into<String>,
    ) {
        self.write_inner().session_artifact_override = Some(SessionArtifactLocation {
            project_dir: project_dir.into(),
            session_id: session_id.into(),
        });
    }

    fn session_artifact_project_dir_and_id(inner: &AppStateInner) -> Option<(PathBuf, String)> {
        inner
            .history_path
            .as_ref()
            .and_then(|path| {
                let project_dir = path.parent()?.to_path_buf();
                let session_id =
                    session_id_from_history_path(path).unwrap_or_else(|_| inner.session_id.clone());
                Some((project_dir, session_id))
            })
            .or_else(|| {
                inner
                    .session_artifact_override
                    .as_ref()
                    .map(|location| (location.project_dir.clone(), location.session_id.clone()))
            })
    }

    fn fallback_session_artifact_project_dir(inner: &AppStateInner) -> PathBuf {
        inner.cwd.join(".kcoder").join("projects")
    }

    pub fn subagent_output_path(&self, agent_id: &str) -> PathBuf {
        let inner = self.read_inner();
        if let Some((project_dir, session_id)) = Self::session_artifact_project_dir_and_id(&inner) {
            return subagent_output_path(project_dir, &session_id, agent_id);
        }
        subagent_output_path(
            Self::fallback_session_artifact_project_dir(&inner),
            &inner.session_id,
            agent_id,
        )
    }

    pub fn managed_task_output_path(&self, task_id: &str) -> PathBuf {
        let inner = self.read_inner();
        if let Some((project_dir, session_id)) = Self::session_artifact_project_dir_and_id(&inner) {
            return managed_task_output_path(project_dir, &session_id, task_id);
        }
        managed_task_output_path(
            Self::fallback_session_artifact_project_dir(&inner),
            &inner.session_id,
            task_id,
        )
    }

    pub fn goal_workspace_baseline_bundle_path(&self, goal_id: &str) -> PathBuf {
        let inner = self.read_inner();
        if let Some((project_dir, session_id)) = Self::session_artifact_project_dir_and_id(&inner) {
            return goal_workspace_baseline_bundle_path(project_dir, &session_id, goal_id);
        }
        goal_workspace_baseline_bundle_path(
            Self::fallback_session_artifact_project_dir(&inner),
            &inner.session_id,
            goal_id,
        )
    }

    pub fn subagent_transcript_path(&self, agent_id: &str) -> PathBuf {
        let inner = self.read_inner();
        if let Some((project_dir, session_id)) = Self::session_artifact_project_dir_and_id(&inner) {
            return subagent_transcript_path(project_dir, &session_id, agent_id);
        }
        subagent_transcript_path(
            Self::fallback_session_artifact_project_dir(&inner),
            &inner.session_id,
            agent_id,
        )
    }

    pub fn subagent_llm_request_history_dir(&self, agent_id: &str) -> PathBuf {
        let inner = self.read_inner();
        if let Some((project_dir, session_id)) = Self::session_artifact_project_dir_and_id(&inner) {
            return subagent_llm_request_history_dir_path(project_dir, &session_id, agent_id);
        }
        subagent_llm_request_history_dir_path(
            Self::fallback_session_artifact_project_dir(&inner),
            &inner.session_id,
            agent_id,
        )
    }

    /// Set the maximum number of messages to keep in memory.
    pub fn set_history_max_messages(&self, limit: usize) {
        let mut inner = self.write_inner();
        inner.history_max_messages = limit.max(1);
        Self::truncate_messages(&mut inner);
    }

    pub fn cwd(&self) -> PathBuf {
        self.read_inner().cwd.clone()
    }

    pub fn history_path(&self) -> Option<PathBuf> {
        self.read_inner().history_path.clone()
    }

    pub fn session_state_path(&self) -> Option<PathBuf> {
        self.read_inner().session_state_path.clone()
    }

    /// Directory containing the transcript and session artifacts.
    pub fn session_project_dir(&self) -> Option<PathBuf> {
        self.read_inner()
            .history_path
            .as_ref()
            .and_then(|path| path.parent().map(Path::to_path_buf))
    }

    /// Effective project directory for session artifacts. Unlike
    /// `session_project_dir`, this also returns an explicit history-less
    /// override installed for forked/client engines.
    pub fn session_artifact_project_dir(&self) -> Option<PathBuf> {
        let inner = self.read_inner();
        Self::session_artifact_project_dir_and_id(&inner).map(|(project_dir, _)| project_dir)
    }

    /// Path to the current session-memory summary file, if history is enabled.
    pub fn session_memory_summary_path(&self) -> Option<PathBuf> {
        let inner = self.read_inner();
        Self::session_artifact_project_dir_and_id(&inner)
            .map(|(project_dir, session_id)| session_memory_summary_path(project_dir, &session_id))
    }

    /// Record that a file has been read during the current session.
    pub fn record_file_read(
        &self,
        path: impl Into<PathBuf>,
        content: Option<String>,
        modified: Option<SystemTime>,
        offset: Option<usize>,
        limit: Option<usize>,
    ) {
        let mut inner = self.write_inner();
        let path = normalize_read_snapshot_path(&path.into(), &inner.cwd);
        let range = ReadRangeKey::new(offset, limit);
        let (offset, limit) = range.stored_parts();
        let snapshot = FileReadSnapshot {
            source_encoding_hint: None,
            content: content.map(Arc::<str>::from),
            modified,
            offset,
            limit,
            from_read_tool: false,
            anchor_pending: false,
            full_body_compacted: false,
        };
        inner.file_reads.insert(path.clone(), snapshot);
        // File state produced by Write/Edit cannot retain a full-read anchor from before the modification.
        inner.full_file_reads.remove(&path);
    }

    /// Record that a file was returned by the Read tool.  Mutating tools also
    /// update file snapshots for stale-write protection, but only true Read
    /// snapshots are eligible for duplicate-read suppression.
    pub fn record_read_tool_snapshot(
        &self,
        path: impl Into<PathBuf>,
        content: Option<String>,
        modified: Option<SystemTime>,
        offset: Option<usize>,
        limit: Option<usize>,
    ) {
        self.record_read_tool_snapshot_with_encoding(path, content, modified, offset, limit, "auto");
    }

    /// Record a decoder-bound read so cached text cannot cross encoding selections.
    pub fn record_read_tool_snapshot_with_encoding(
        &self,
        path: impl Into<PathBuf>,
        content: Option<String>,
        modified: Option<SystemTime>,
        offset: Option<usize>,
        limit: Option<usize>,
        source_encoding_hint: &str,
    ) {
        let mut inner = self.write_inner();
        let path = normalize_read_snapshot_path(&path.into(), &inner.cwd);
        let range = ReadRangeKey::new(offset, limit);
        let (offset, limit) = range.stored_parts();
        let content = content.map(Arc::<str>::from);
        let full_body_compacted = range.is_full()
            && inner.full_file_reads.get(&path).is_some_and(|previous| {
                (previous.full_body_compacted || previous.anchor_pending)
                    && previous.modified == modified
                    && previous.content == content
            });
        let snapshot = FileReadSnapshot {
            source_encoding_hint: Some(source_encoding_hint.to_owned()),
            content,
            modified,
            offset,
            limit,
            from_read_tool: true,
            anchor_pending: false,
            full_body_compacted,
        };
        inner.file_reads.insert(path.clone(), snapshot.clone());
        if range.is_full() {
            inner.full_file_reads.insert(path, snapshot);
        }
    }

    /// Freeze the tool-call mapping to an absolute normalized path/range when Read actually executes.
    pub fn record_read_tool_call_key(
        &self,
        tool_call_id: impl Into<String>,
        path: impl Into<PathBuf>,
        offset: Option<usize>,
        limit: Option<usize>,
    ) {
        let mut inner = self.write_inner();
        let path = normalize_read_snapshot_path(&path.into(), &inner.cwd);
        inner.read_tool_call_keys.insert(
            tool_call_id.into(),
            FileReadKey {
                path,
                range: ReadRangeKey::new(offset, limit),
            },
        );
    }

    /// Get the latest session read snapshot for a file, if any.
    pub fn file_read_snapshot(&self, path: &Path) -> Option<FileReadSnapshot> {
        let inner = self.read_inner();
        let path = normalize_read_snapshot_path(path, &inner.cwd);
        inner.file_reads.get(&path).cloned()
    }

    /// Retrieve a snapshot exactly matching this Read's normalized range. Full reads
    /// use an independently retained full snapshot that later range reads cannot overwrite.
    pub fn file_read_snapshot_for_request(
        &self,
        path: &Path,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Option<FileReadSnapshot> {
        let inner = self.read_inner();
        let path = normalize_read_snapshot_path(path, &inner.cwd);
        let range = ReadRangeKey::new(offset, limit);
        if range.is_full() {
            return inner.full_file_reads.get(&path).cloned();
        }
        inner
            .file_reads
            .get(&path)
            .filter(|snapshot| ReadRangeKey::new(snapshot.offset, snapshot.limit) == range)
            .cloned()
    }

    /// Retrieve the most recent full-read snapshot. Whether an explicit range truly
    /// covers the whole file can be determined only after Read obtains the current body,
    /// so exact-range queries cannot replace this interface.
    pub fn full_file_read_snapshot(&self, path: &Path) -> Option<FileReadSnapshot> {
        let inner = self.read_inner();
        let path = normalize_read_snapshot_path(path, &inner.cwd);
        inner.full_file_reads.get(&path).cloned()
    }

    /// Mark every Read body as removed from model context while retaining content and modification-time snapshots.
    ///
    /// Full reads enter an anchor-pending state so the next read can return a bounded,
    /// meaningful anchor instead of reinserting the entire large file. Range reads
    /// continue normally. Edit/Write still use retained snapshots for stale-write checks.
    pub fn revoke_duplicate_read_suppression(&self) {
        let mut inner = self.write_inner();
        for snapshot in inner.file_reads.values_mut() {
            if !snapshot.from_read_tool {
                continue;
            }
            snapshot.anchor_pending = snapshot.is_full_read() && snapshot.content.is_some();
            snapshot.full_body_compacted = snapshot.anchor_pending;
            snapshot.from_read_tool = false;
        }
        for snapshot in inner.full_file_reads.values_mut() {
            if snapshot.from_read_tool {
                snapshot.anchor_pending = snapshot.content.is_some();
                snapshot.full_body_compacted = snapshot.anchor_pending;
                snapshot.from_read_tool = false;
            }
        }
    }

    /// Precisely mark Read results actually removed by micro-compaction.
    ///
    /// Modify only the newest snapshot exactly matching tool_use path/offset/limit,
    /// so clearing one old Read cannot incorrectly unlock other files still in context for repeated reads.
    pub fn mark_read_tool_results_compacted(
        &self,
        messages: &[Message],
        cleared_tool_use_ids: &[String],
    ) {
        if cleared_tool_use_ids.is_empty() {
            return;
        }
        let cleared = cleared_tool_use_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let visible_tool_ids = tool_use_ids(messages);
        let mut inner = self.write_inner();
        for tool_use_id in cleared {
            if let Some(key) = inner.read_tool_call_keys.get(tool_use_id).cloned() {
                mark_file_read_snapshot_compacted(&mut inner, &key);
            }
        }
        inner
            .read_tool_call_keys
            .retain(|tool_use_id, _| visible_tool_ids.contains(tool_use_id));
    }

    pub fn session_id(&self) -> String {
        self.read_inner().session_id.clone()
    }

    pub fn artifact_session_id(&self) -> String {
        let inner = self.read_inner();
        Self::session_artifact_project_dir_and_id(&inner)
            .map(|(_, session_id)| session_id)
            .unwrap_or_else(|| inner.session_id.clone())
    }

    pub fn messages(&self) -> Vec<Message> {
        self.read_inner().messages.to_vec()
    }

    /// Capture immutable shared messages and their revision under the same lock.
    pub fn shared_messages_with_revision(&self) -> (kcoder_types::SharedMessages, MessageRevision) {
        let inner = self.read_inner();
        (inner.messages.clone(), inner.message_revision.clone())
    }

    /// Project the newest matching message without cloning the history.
    /// The synchronous projector runs under a read lock: do not reenter this state or block.
    pub fn find_latest_message_map<T>(
        &self,
        project: impl FnMut(&Message) -> Option<T>,
    ) -> Option<T> {
        self.read_inner().messages.iter().rev().find_map(project)
    }

    /// Capture at most the newest limit messages in chronological order under one lock.
    pub fn recent_messages(&self, limit: usize) -> Vec<Message> {
        let inner = self.read_inner();
        inner
            .messages
            .iter()
            .skip(inner.messages.len().saturating_sub(limit))
            .cloned()
            .collect()
    }

    pub fn message_revision(&self) -> MessageRevision {
        self.read_inner().message_revision.clone()
    }

    /// Capture content and its revision under one lock; separate reads may race a writer.
    pub fn messages_with_revision(&self) -> (Vec<Message>, MessageRevision) {
        let inner = self.read_inner();
        (inner.messages.to_vec(), inner.message_revision.clone())
    }

    pub fn message_count(&self) -> usize {
        self.read_inner().messages.len()
    }

    /// Stable session creation and latest content timestamps, independent of snapshot reads.
    pub fn session_timestamps_ms(&self) -> (u64, u64) {
        let inner = self.read_inner();
        (inner.session_created_at_ms, inner.session_updated_at_ms)
    }

    /// Timestamp of the most recent assistant message, including after a
    /// persisted session is resumed.
    pub fn last_assistant_message_timestamp_ms(&self) -> Option<u64> {
        self.read_inner().last_assistant_message_timestamp_ms
    }

    pub fn add_message(&self, message: Message) {
        if let Err(error) =
            self.enqueue_message_with_uuid(message, &generate_transcript_uuid(), false)
        {
            warn!("failed to append history: {error:#}");
        }
    }

    /// Queue a stable transcript identity. Call `flush_history` before acknowledging delivery.
    pub fn add_message_with_uuid(&self, message: Message, uuid: &str) -> anyhow::Result<()> {
        self.enqueue_message_with_uuid(message, uuid, true)
    }

    fn enqueue_message_with_uuid(
        &self,
        message: Message,
        uuid: &str,
        require_healthy_writer: bool,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !uuid.is_empty() && uuid.len() <= 128,
            "invalid history message identity"
        );
        let mut inner = self.write_inner();
        inner.conversation_started = true;
        let timestamp_ms = now_millis();
        inner.session_updated_at_ms = inner.session_updated_at_ms.max(timestamp_ms);
        if require_healthy_writer {
            check_direct_history_fault(&inner)?;
        }
        if inner
            .message_history_ids
            .iter()
            .flatten()
            .any(|id| id == uuid)
        {
            return Ok(());
        }
        let uuid = uuid.to_owned();
        let parent_uuid = inner.last_history_uuid.clone();
        inner.last_history_uuid = Some(uuid.clone());
        if matches!(message, Message::Assistant { .. }) {
            inner.last_assistant_message_timestamp_ms = Some(timestamp_ms);
        }
        inner.message_revision = MessageRevision::default();
        inner.messages.push(message.clone());
        inner.message_history_ids.push(Some(uuid.clone()));
        Self::truncate_messages(&mut inner);
        let entry = HistoryEntry {
            session_id: inner.session_id.clone(),
            timestamp_ms,
            uuid: Some(uuid),
            parent_uuid,
            message,
        };
        // Enqueue while the same state lock still protects UUID creation and
        // parent chaining. If the flusher is absent or closed, keep the direct
        // append inside that lock too; otherwise concurrent fallback writers
        // could still reorder the JSONL chain.
        let path = inner.history_path.clone();
        if let Some(flusher) = inner.history_flusher.as_ref() {
            if let Err(command) = flusher.send(HistoryFlusherCommand::Entry(entry))
                && let Some(path) = path
            {
                flusher.process_direct(&path, *command);
                flusher.queue.flush(&path)?;
            }
        } else if path.is_some() {
            let result = direct_history_write(&mut inner, |inner| {
                flush_bound_history_batch(require_history_source(inner)?, &mut vec![entry])
            });
            result?;
        }
        Ok(())
    }

    fn truncate_messages(inner: &mut AppStateInner) {
        let max = inner.history_max_messages;
        if inner.messages.len() <= max {
            return;
        }
        // Keep the first system message if it exists; drop the oldest remaining messages.
        let drain_start = inner
            .messages
            .iter()
            .position(|m| m.role() == MessageRole::System)
            .filter(|&i| i == 0)
            .map(|_| 1)
            .unwrap_or(0);
        let minimum_cut = inner.messages.len().saturating_sub(max).max(drain_start);
        let Some(drain_end) = (minimum_cut..inner.messages.len()).find(|&index| {
            matches!(
                &inner.messages[index],
                Message::User { content, .. }
                    if content.iter().any(|block| !matches!(block, ContentBlock::ToolResult { .. }))
            )
        }) else {
            return;
        };
        if drain_end <= drain_start {
            return;
        }
        inner.message_revision = MessageRevision::default();
        inner.messages.remove_range(drain_start..drain_end);
        if inner.message_history_ids.len() >= drain_end {
            inner.message_history_ids.drain(drain_start..drain_end);
        } else {
            inner.message_history_ids = vec![None; inner.messages.len()];
        }
    }

    pub fn set_messages(&self, messages: Vec<Message>) {
        let mut inner = self.write_inner();
        if inner.messages != messages {
            inner.message_revision = MessageRevision::default();
            inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
        }
        inner.conversation_started |= !messages.is_empty();
        inner.message_history_ids = vec![None; messages.len()];
        inner.messages = messages.into();
    }

    /// Replace model-visible message content without discarding transcript
    /// identity metadata when the message count is unchanged.
    ///
    /// This is used by in-place context reductions such as cold-cache
    /// micro-compaction. The append-only transcript remains untouched while a
    /// later full compaction can still identify its preserved recent segment.
    pub fn set_messages_preserving_history_ids(&self, messages: Vec<Message>) {
        let mut inner = self.write_inner();
        if inner.messages != messages {
            inner.message_revision = MessageRevision::default();
            inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
        }
        inner.conversation_started |= !messages.is_empty();
        if inner.message_history_ids.len() != messages.len() {
            inner.message_history_ids = vec![None; messages.len()];
        }
        inner.messages = messages.into();
    }

    /// Replace the current in-memory model conversation and persist metadata.
    ///
    /// The primary JSONL history is append-only and is not rewritten here. We
    /// flush queued transcript entries first so they are durable before
    /// metadata is recorded.
    pub async fn set_messages_and_save_history(
        &self,
        messages: Vec<Message>,
    ) -> anyhow::Result<()> {
        let flush_done = {
            let mut inner = self.write_inner();
            if inner.messages != messages {
                inner.message_revision = MessageRevision::default();
                inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
            }
            inner.conversation_started |= !messages.is_empty();
            inner.message_history_ids = vec![None; messages.len()];
            inner.messages = messages.into();
            check_direct_history_fault(&inner)?;
            inner.history_flusher.as_ref().map(|flusher| {
                let (done_tx, done_rx) = oneshot::channel();
                if let Err(command) = flusher.send(HistoryFlusherCommand::Flush(done_tx))
                    && let Some(path) = inner.history_path.as_ref()
                {
                    flusher.process_direct(path, *command);
                }
                done_rx
            })
        };

        if let Some(done) = flush_done {
            done.await
                .context("history flusher stopped before flush completed")??;
        }

        self.persist_latest_session_state();

        Ok(())
    }

    /// Wait until every transcript entry enqueued before this call is durable.
    /// This does not rewrite model-visible state or transcript identities.
    /// Make an accepted empty session resumable without adding a conversation message.
    pub fn materialize_history(&self) -> anyhow::Result<()> {
        let source = {
            let inner = self.read_inner();
            check_direct_history_fault(&inner)?;
            require_history_source(&inner)?.clone()
        };
        source.materialize()
    }

    pub async fn flush_history(&self) -> anyhow::Result<()> {
        let flush_done = {
            let inner = self.read_inner();
            check_direct_history_fault(&inner)?;
            inner.history_flusher.as_ref().map(|flusher| {
                let (done_tx, done_rx) = oneshot::channel();
                if let Err(command) = flusher.send(HistoryFlusherCommand::Flush(done_tx))
                    && let Some(path) = inner.history_path.as_ref()
                {
                    flusher.process_direct(path, *command);
                }
                done_rx
            })
        };
        if let Some(done) = flush_done {
            done.await
                .context("history flusher stopped before flush completed")??;
        }
        Ok(())
    }

    /// Replace the current model conversation after a full compaction and
    /// append compact-boundary records to the transcript.
    ///
    /// The transcript remains append-only: old user/assistant records are not
    /// rewritten. Resume reconstructs model-visible context from the latest
    /// compact boundary and summary record, not from a compacted-message
    /// sidecar.
    pub async fn set_messages_after_compaction(
        &self,
        messages: Vec<Message>,
        event: CompactionTranscriptEvent,
    ) -> anyhow::Result<()> {
        let append_done = {
            let mut inner = self.write_inner();
            inner.conversation_started = true;
            inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
            let removed_read_keys =
                removed_read_result_keys(&inner.messages, &messages, &inner.read_tool_call_keys);
            let visible_tool_ids = tool_use_ids(&messages);
            let transcript_metadata = build_compaction_transcript_metadata(&inner, &messages);
            let next_ids = compacted_message_history_ids(&messages, &transcript_metadata);
            inner.message_revision = MessageRevision::default();
            inner.messages = messages.into();
            inner.message_history_ids = next_ids;
            inner.last_history_uuid = Some(transcript_metadata.summary_uuid.clone());
            // Mark only Read bodies actually removed by full compaction. Reads retained
            // verbatim in the recent tail keep normal duplicate suppression; removed full
            // reads move to anchor-pending state.
            for key in removed_read_keys {
                mark_file_read_snapshot_compacted(&mut inner, &key);
            }
            inner
                .read_tool_call_keys
                .retain(|tool_use_id, _| visible_tool_ids.contains(tool_use_id));
            if let Some(flusher) = inner.history_flusher.as_ref() {
                let (done_tx, done_rx) = oneshot::channel();
                let command = HistoryFlusherCommand::AppendCompaction {
                    session_id: inner.session_id.clone(),
                    event: event.clone(),
                    metadata: transcript_metadata.clone(),
                    done: done_tx,
                };
                if let Err(command) = flusher.send(command)
                    && let Some(path) = inner.history_path.as_ref()
                {
                    // Preserve the shared batch and any sticky fault after worker exit.
                    flusher.process_direct(path, *command);
                }
                Some(done_rx)
            } else if let Some(path) = inner.history_path.clone() {
                // With no asynchronous flusher, append while the state lock
                // still excludes add_message so the boundary cannot be
                // overtaken by a concurrent direct history write.
                direct_history_write(&mut inner, |inner| {
                    append_compaction_transcript_records(
                        require_history_source(inner)?,
                        &path,
                        &inner.session_id,
                        &event,
                        &transcript_metadata,
                    )
                })?;
                None
            } else {
                None
            }
        };

        if let Some(done) = append_done {
            done.await
                .context("history flusher stopped before compaction completed")??;
        }

        self.mark_session_content_changed();
        self.persist_latest_session_state();

        Ok(())
    }

    /// Truncate the conversation to the first `cut` messages and append a
    /// rewind boundary record so a later resume reconstructs the truncated
    /// context instead of replaying the full append-only transcript.
    ///
    /// The boundary anchors on the history uuid of the last surviving message
    /// (walking back to the nearest message that has one). When no anchor
    /// exists — possible after in-memory-only rewrites — the truncation still
    /// happens, but no boundary is written because replay could not tell which
    /// transcript entries to drop; `boundary_recorded` reports that.
    pub async fn truncate_messages_for_rewind(
        &self,
        cut: usize,
        turn: u64,
    ) -> anyhow::Result<ConversationRewindOutcome> {
        let (append_done, outcome) = {
            let mut inner = self.write_inner();
            let len = inner.messages.len();
            if cut >= len {
                return Ok(ConversationRewindOutcome {
                    removed: 0,
                    boundary_recorded: false,
                });
            }
            let removed = len - cut;
            inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
            let anchor_uuid = (0..cut)
                .rev()
                .find_map(|index| inner.message_history_ids.get(index).cloned().flatten());
            // A rewind to zero messages legitimately anchors on "nothing":
            // replay then discards every entry before the boundary.
            let can_record = cut == 0 || anchor_uuid.is_some();
            inner.message_revision = MessageRevision::default();
            inner.messages.truncate(cut);
            inner.message_history_ids.truncate(cut);
            // Timestamps are transcript-side metadata, so the last-assistant
            // marker cannot be recomputed from kept messages; clear it.
            inner.last_assistant_message_timestamp_ms = None;
            let boundary_uuid = can_record.then(generate_transcript_uuid);
            let parent_uuid = boundary_uuid
                .as_ref()
                .and_then(|_| inner.last_history_uuid.clone());
            inner.last_history_uuid = boundary_uuid.clone().or_else(|| anchor_uuid.clone());
            let append_done = match boundary_uuid {
                Some(ref boundary_uuid) => {
                    if let Some(flusher) = inner.history_flusher.as_ref() {
                        let (done_tx, done_rx) = oneshot::channel();
                        let command = HistoryFlusherCommand::AppendRewind {
                            session_id: inner.session_id.clone(),
                            boundary_uuid: boundary_uuid.clone(),
                            parent_uuid: parent_uuid.clone(),
                            anchor_uuid: anchor_uuid.clone(),
                            turn,
                            done: done_tx,
                        };
                        if let Err(command) = flusher.send(command)
                            && let Some(path) = inner.history_path.as_ref()
                        {
                            flusher.process_direct(path, *command);
                        }
                        Some(done_rx)
                    } else if inner.history_path.is_some() {
                        direct_history_write(&mut inner, |inner| {
                            append_rewind_transcript_record(
                                require_history_source(inner)?,
                                &inner.session_id,
                                boundary_uuid,
                                parent_uuid.as_deref(),
                                anchor_uuid.as_deref(),
                                turn,
                            )
                        })?;
                        None
                    } else {
                        None
                    }
                }
                None => None,
            };
            let outcome = ConversationRewindOutcome {
                removed,
                boundary_recorded: boundary_uuid.is_some(),
            };
            (append_done, outcome)
        };

        if let Some(done) = append_done {
            done.await
                .context("history flusher stopped before rewind completed")??;
        }

        self.mark_session_content_changed();
        self.persist_latest_session_state();

        Ok(outcome)
    }

    pub fn clear_messages(&self) {
        let mut inner = self.write_inner();
        if !inner.messages.is_empty() {
            inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
        }
        inner.message_revision = MessageRevision::default();
        inner.messages.clear();
        inner.last_assistant_message_timestamp_ms = None;
    }

    fn mark_session_content_changed(&self) {
        let mut inner = self.write_inner();
        inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
    }

    /// Replace the entire todo list.
    pub fn set_todos(&self, todos: Vec<TodoItem>) {
        self.write_inner().todos = todos;
    }

    /// Get a clone of the current todo list.
    pub fn todos(&self) -> Vec<TodoItem> {
        self.read_inner().todos.clone()
    }

    /// Enter plan mode with the given instructions.
    pub fn enter_plan_mode(&self, instructions: impl Into<String>) {
        self.write_inner().plan_mode = Some(instructions.into());
    }

    /// Exit plan mode.
    pub fn exit_plan_mode(&self) {
        self.write_inner().plan_mode = None;
    }

    /// Get the current plan-mode instructions, if any.
    pub fn plan_mode(&self) -> Option<String> {
        self.read_inner().plan_mode.clone()
    }

    /// Durable identity paired with the latest matching message, without cloning its contents.
    pub fn latest_message_history_id_matching(&self, matches: impl Fn(&Message) -> bool) -> Option<String> {
        let inner = self.read_inner();
        inner.messages.iter().zip(inner.message_history_ids.iter()).rev()
            .find(|(message, _)| matches(message)).and_then(|(_, id)| id.clone())
    }

    pub fn last_message(&self) -> Option<Message> {
        self.read_inner().messages.last().cloned()
    }

    /// Remove the last contiguous run of assistant messages (and any trailing
    /// tool-result pairs) so the user can retry their last prompt.
    pub fn pop_last_assistant_turn(&self) -> usize {
        let mut inner = self.write_inner();
        let original_len = inner.messages.len();
        while let Some(msg) = inner.messages.last() {
            if msg.role() == MessageRole::Assistant {
                let retained = inner.messages.len() - 1;
                inner.messages.truncate(retained);
            } else {
                break;
            }
        }
        if original_len != inner.messages.len() {
            inner.message_revision = MessageRevision::default();
        }
        original_len - inner.messages.len()
    }

    /// Search in-memory messages by substring, optionally filtered by role.
    pub fn search_messages(
        &self,
        query: &str,
        roles: Option<&[MessageRole]>,
        limit: usize,
    ) -> Vec<(usize, Message)> {
        let inner = self.read_inner();
        let q = query.to_lowercase();
        inner
            .messages
            .iter()
            .enumerate()
            .filter(|(_, m)| {
                if let Some(roles) = roles
                    && !roles.contains(&m.role())
                {
                    return false;
                }
                q.is_empty() || m.preview(10_000).to_lowercase().contains(&q)
            })
            .rev()
            .take(limit)
            .map(|(i, m)| (i, m.clone()))
            .collect()
    }

    /// Persist the current conversation to the configured history file.
    pub fn save_history(&self) -> anyhow::Result<()> {
        let _persist = self.lock_session_state_persistence();
        {
            let mut inner = self.write_inner();
            if inner.history_path.is_none() {
                return Ok(());
            }
            ensure_message_history_ids(&mut inner);
            let source = require_history_source(&inner)?;
            let write = || {
                write_history_snapshot(
                    source,
                    &inner.session_id,
                    inner.messages.iter(),
                    &inner.message_history_ids,
                )?;
                // A committed body supersedes old commands even if its sidecar fails.
                persist_snapshot_session_state(&inner)
                    .map_err(crate::history_store::incomplete_snapshot)
            };
            // Lock order is persistence -> inner -> batch. Never await the worker here.
            let result = match inner.history_flusher.as_ref() {
                Some(flusher) => flusher.queue.replace_snapshot(write),
                None => write(),
            };
            if result.is_ok() {
                inner.history_write_fault = None;
            } else if let Err(error) = &result
                && crate::history_store::is_uncertain_mutation(error)
            {
                inner.history_write_fault = Some(format!("{error:#}"));
            }
            result?;
        }
        Ok(())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }
}

fn generate_session_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{now:032x}-{:08x}-{counter:016x}", std::process::id())
}

fn generate_transcript_uuid() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let pid = u128::from(std::process::id());
    let value = now ^ (pid << 32) ^ u128::from(n);
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (value >> 96) as u32,
        (value >> 80) as u16,
        (value >> 64) as u16,
        (value >> 48) as u16,
        value & 0xffff_ffff_ffff
    )
}

fn now_iso_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn last_transcript_uuid(path: &Path) -> anyhow::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let file = fs::File::open(path)?;
    let reader = std::io::BufReader::new(file);
    let mut last_uuid = None;
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(uuid) = value.get("uuid").and_then(serde_json::Value::as_str) {
            last_uuid = Some(uuid.to_string());
        }
    }
    Ok(last_uuid)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FileReadKey {
    path: PathBuf,
    range: ReadRangeKey,
}

fn tool_use_ids(messages: &[Message]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for message in messages {
        let Message::Assistant { content, .. } = message else {
            continue;
        };
        for block in content {
            if let ContentBlock::ToolUse { id, .. } = block {
                ids.insert(id.clone());
            }
        }
    }
    ids
}

fn read_result_keys<'a>(
    messages: impl IntoIterator<Item = &'a Message>,
    tool_uses: &HashMap<String, FileReadKey>,
    require_meaningful_content: bool,
) -> HashSet<FileReadKey> {
    let mut keys = HashSet::new();
    for message in messages {
        let Message::User { content, .. } = message else {
            continue;
        };
        for block in content {
            let ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            else {
                continue;
            };
            if is_error.unwrap_or(false) {
                continue;
            }
            let Some(key) = tool_uses.get(tool_use_id) else {
                continue;
            };
            if require_meaningful_content && !read_result_has_meaningful_content(content) {
                continue;
            }
            keys.insert(key.clone());
        }
    }
    keys
}

fn removed_read_result_keys(
    old_messages: &kcoder_types::SharedMessages,
    compacted_messages: &[Message],
    tool_uses: &HashMap<String, FileReadKey>,
) -> HashSet<FileReadKey> {
    let before = read_result_keys(old_messages.iter(), tool_uses, false);
    let retained = read_result_keys(compacted_messages, tool_uses, true);
    before.difference(&retained).cloned().collect()
}

fn read_result_has_meaningful_content(content: &[ContentBlock]) -> bool {
    content.iter().any(|block| {
        let ContentBlock::Text { text } = block else {
            return false;
        };
        let text = text.trim();
        !text.is_empty()
            && text != "[Old tool result content cleared]"
            && !text.starts_with("File unchanged since last read.")
    })
}

fn normalize_read_snapshot_path(path: &Path, cwd: &Path) -> PathBuf {
    use std::path::Component;

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(
                    normalized.components().next_back(),
                    Some(Component::Normal(_))
                ) {
                    normalized.pop();
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn mark_file_read_snapshot_compacted(inner: &mut AppStateInner, key: &FileReadKey) {
    if key.range.is_full()
        && let Some(snapshot) = inner.full_file_reads.get_mut(&key.path)
        && (snapshot.from_read_tool || snapshot.anchor_pending || snapshot.full_body_compacted)
    {
        snapshot.anchor_pending = snapshot.content.is_some();
        snapshot.full_body_compacted = snapshot.anchor_pending;
        snapshot.from_read_tool = false;
    }
    if let Some(snapshot) = inner.file_reads.get_mut(&key.path)
        && ReadRangeKey::new(snapshot.offset, snapshot.limit) == key.range
        && (snapshot.from_read_tool || snapshot.anchor_pending)
    {
        snapshot.anchor_pending = key.range.is_full() && snapshot.content.is_some();
        snapshot.full_body_compacted = snapshot.anchor_pending;
        snapshot.from_read_tool = false;
    }
}

fn default_history_max_messages() -> usize {
    99_999
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::{Message, MessagesRequest, ReasoningEffort, StreamEvent};
    use tempfile::TempDir;

    #[test]
    fn app_state_recovers_after_inner_lock_is_poisoned() {
        let state = AppState::new("/tmp/poison-recovery");
        let inner = Arc::clone(&state.inner);
        let result = std::thread::spawn(move || {
            let _guard = inner.write().unwrap();
            panic!("poison AppState for recovery test");
        })
        .join();
        assert!(result.is_err());

        assert_eq!(state.cwd(), PathBuf::from("/tmp/poison-recovery"));
        state.add_message(Message::user_text("still usable"));
        assert_eq!(state.messages().len(), 1);
    }

    #[test]
    fn shared_message_snapshots_survive_append_pop_replace_and_clear() {
        let original = vec![
            Message::user_text("root"),
            Message::assistant_text("answer"),
        ];
        let state = AppState::with_messages("/", original.clone());
        let (snapshot, revision) = state.shared_messages_with_revision();
        let (same, same_revision) = state.shared_messages_with_revision();
        assert_eq!(revision, same_revision);
        assert!(std::ptr::eq(snapshot.get(0).unwrap(), same.get(0).unwrap()));
        state.add_message(Message::assistant_text("next"));
        let (appended, appended_revision) = state.shared_messages_with_revision();
        assert_ne!(revision, appended_revision);
        assert!(std::ptr::eq(
            snapshot.get(0).unwrap(),
            appended.get(0).unwrap()
        ));
        assert_eq!(state.pop_last_assistant_turn(), 2);
        assert_eq!(appended.len(), 3);
        assert_eq!(state.messages(), vec![Message::user_text("root")]);
        state.set_messages_preserving_history_ids(vec![Message::user_text("replacement")]);
        state.clear_messages();
        assert!(state.messages().is_empty());
        assert_eq!(snapshot.to_vec(), original);
        assert_eq!(same.to_vec(), original);
        assert_eq!(appended.get(2), Some(&Message::assistant_text("next")));
    }

    #[tokio::test]
    async fn short_id_new_session_keeps_legacy_resume_identity() {
        let root = tempfile::tempdir().unwrap();
        let legacy = AppState::new(root.path());
        let legacy_id = legacy.session_id();
        let history = root.path().join(format!("{legacy_id}.jsonl"));
        legacy.with_history_path(&history);
        legacy.add_message(Message::user_text("old history"));
        legacy.flush_history().await.unwrap();
        let current = AppState::new_with_short_id(root.path(), &root.path().join("ids")).unwrap();
        assert_eq!(current.session_id().len(), 5);
        current.resume_from_history(&history).unwrap();
        assert_eq!(current.session_id(), legacy_id);
        assert_eq!(current.messages(), legacy.messages());
    }

    #[test]
    fn short_id_rotation_failure_preserves_current_session() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new_with_short_id(root.path(), &root.path().join("ids")).unwrap();
        let first = state.session_id();
        state.start_new_session().unwrap();
        assert_eq!(state.session_id().len(), 5);
        assert!(!state.session_id().eq_ignore_ascii_case(&first));
        state.add_message(Message::user_text("keep this conversation"));
        let before = state.messages_with_revision();
        let id = state.session_id();
        let invalid = root.path().join("not-a-directory");
        std::fs::write(&invalid, "occupied").unwrap();
        state.set_short_id_registry(&invalid);
        assert!(state.start_new_session().is_err());
        assert_eq!(state.session_id(), id);
        assert_eq!(state.messages_with_revision(), before);
    }

    #[tokio::test]
    async fn resume_imported_short_id_reserves_it_before_replacing_state() {
        let root = tempfile::tempdir().unwrap();
        let history = root.path().join("Ab123.jsonl");
        let source = AppState::new(root.path());
        source.with_history_path(&history);
        source.add_message(Message::user_text("imported history"));
        source.flush_history().await.unwrap();
        let target = AppState::new(root.path());
        let registry = root.path().join("ids");
        target.set_short_id_registry(&registry);
        target.resume_from_history(&history).unwrap();
        assert_eq!(target.session_id(), "Ab123");
        assert!(registry.join("ab123").is_file());
        let blocked = AppState::new(root.path());
        blocked.add_message(Message::user_text("keep current"));
        let before = blocked.messages_with_revision();
        let invalid = root.path().join("file");
        std::fs::write(&invalid, "occupied").unwrap();
        blocked.set_short_id_registry(&invalid);
        assert!(blocked.resume_from_history(&history).is_err());
        assert_eq!(blocked.messages_with_revision(), before);
    }

    #[test]
    fn latest_message_projection_stops_at_first_match_without_changing_revision() {
        let state = AppState::with_messages(
            "/",
            vec![
                Message::user_text("large older text".repeat(1000)),
                Message::user_text("selected"),
                Message::assistant_text("skip"),
            ],
        );
        let revision = state.message_revision();
        let mut visited = 0;
        let selected = state.find_latest_message_map(|message| {
            visited += 1;
            match message {
                Message::User { content, .. } => match &content[0] {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                },
                _ => None,
            }
        });
        assert_eq!(selected.as_deref(), Some("selected"));
        assert_eq!(visited, 2);
        assert_eq!(revision, state.message_revision());
        state.clear_messages();
        assert_eq!(selected.as_deref(), Some("selected"));
        assert_eq!(state.find_latest_message_map(|_| Some(1)), None);
    }

    #[test]
    fn recent_messages_preserve_suffix_order_and_snapshot_isolation() {
        let state = AppState::with_messages(
            "/",
            (0..12).map(|n| Message::user_text(n.to_string())).collect(),
        );
        let all = state.messages();
        for limit in [0, 1, 8, 12, usize::MAX] {
            assert_eq!(
                state.recent_messages(limit),
                all[all.len().saturating_sub(limit)..]
            );
        }
        let captured = state.recent_messages(8);
        let revision = state.message_revision();
        state.clear_messages();
        assert_eq!(captured, all[4..]);
        assert_ne!(revision, state.message_revision());
        assert!(state.recent_messages(8).is_empty());
    }

    #[test]
    fn pop_last_assistant_turn_removes_trailing_assistant() {
        let state = AppState::new("/");
        state.add_message(Message::user_text("hello"));
        state.add_message(Message::assistant_text("hi"));
        state.add_message(Message::assistant_text("more"));
        assert_eq!(state.pop_last_assistant_turn(), 2);
        assert_eq!(state.messages().len(), 1);
    }

    #[test]
    fn search_messages_by_role() {
        let state = AppState::new("/");
        state.add_message(Message::user_text("find my keys"));
        state.add_message(Message::assistant_text("searching"));
        let results = state.search_messages("keys", Some(&[MessageRole::User]), 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, 0);
    }

    fn read_tool_use(id: &str, path: &str, offset: Option<usize>) -> Message {
        let mut input = serde_json::json!({ "file_path": path });
        if let Some(offset) = offset {
            input["offset"] = serde_json::json!(offset);
            input["limit"] = serde_json::json!(10);
        }
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: id.to_string(),
                name: "read".to_string(),
                input,
            }],
            usage: None,
        }
    }

    fn read_tool_result(id: &str, text: &str) -> Message {
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.to_string(),
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                is_error: Some(false),
            }],
        }
    }

    #[test]
    fn micro_compaction_marks_only_the_exact_evicted_read_snapshot() {
        let state = AppState::new("/workspace");
        let old_path = PathBuf::from("/workspace/old.rs");
        let retained_path = PathBuf::from("/workspace/retained.rs");
        state.record_read_tool_snapshot(
            old_path.clone(),
            Some("old body".to_string()),
            None,
            None,
            None,
        );
        state.record_read_tool_snapshot(
            retained_path.clone(),
            Some("retained body".to_string()),
            None,
            None,
            None,
        );
        let messages = vec![
            read_tool_use("old", "old.rs", None),
            read_tool_result("old", "old body"),
            read_tool_use("retained", "retained.rs", None),
            read_tool_result("retained", "retained body"),
        ];
        state.record_read_tool_call_key("old", old_path.clone(), None, None);
        state.record_read_tool_call_key("retained", retained_path.clone(), None, None);

        state.mark_read_tool_results_compacted(&messages, &["old".to_string()]);

        let old = state.file_read_snapshot(&old_path).unwrap();
        assert!(!old.from_read_tool);
        assert!(old.anchor_pending);
        let retained = state.file_read_snapshot(&retained_path).unwrap();
        assert!(retained.from_read_tool);
        assert!(!retained.anchor_pending);
    }

    #[test]
    fn compacted_read_key_is_stable_across_cwd_changes() {
        let state = AppState::new("/workspace/one");
        let original = PathBuf::from("/workspace/one/same.rs");
        let other = PathBuf::from("/workspace/two/same.rs");
        state.record_read_tool_snapshot(
            original.clone(),
            Some("one".to_string()),
            None,
            None,
            None,
        );
        state.record_read_tool_snapshot(other.clone(), Some("two".to_string()), None, None, None);
        state.record_read_tool_call_key("old", "same.rs", None, None);
        state.set_cwd("/workspace/two");
        let messages = vec![
            read_tool_use("old", "same.rs", None),
            read_tool_result("old", "one"),
        ];

        state.mark_read_tool_results_compacted(&messages, &["old".to_string()]);

        assert!(
            state
                .file_read_snapshot_for_request(&original, None, None)
                .unwrap()
                .anchor_pending
        );
        assert!(
            state
                .file_read_snapshot_for_request(&other, None, None)
                .unwrap()
                .from_read_tool
        );
    }

    #[tokio::test]
    async fn full_compaction_marks_removed_read_but_preserves_visible_range() {
        let state = AppState::new("/workspace");
        let full_path = PathBuf::from("/workspace/full.rs");
        let range_path = PathBuf::from("/workspace/range.rs");
        state.record_read_tool_snapshot(
            full_path.clone(),
            Some("full body".to_string()),
            None,
            None,
            None,
        );
        state.record_read_tool_snapshot(range_path.clone(), None, None, Some(20), Some(10));
        let range_use = read_tool_use("range", "range.rs", Some(20));
        let range_result = read_tool_result("range", "selected lines");
        state.record_read_tool_call_key("full", full_path.clone(), None, None);
        state.record_read_tool_call_key("range", range_path.clone(), Some(20), Some(10));
        state.set_messages(vec![
            read_tool_use("full", "full.rs", None),
            read_tool_result("full", "full body"),
            range_use.clone(),
            range_result.clone(),
        ]);

        state
            .set_messages_after_compaction(
                vec![
                    Message::user_text("Earlier conversation summary"),
                    range_use,
                    range_result,
                ],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Auto,
                    pre_tokens: 100,
                    post_tokens: 20,
                    summary: "summary".to_string(),
                },
            )
            .await
            .unwrap();

        let full = state.file_read_snapshot(&full_path).unwrap();
        assert!(!full.from_read_tool);
        assert!(full.anchor_pending);
        let range = state.file_read_snapshot(&range_path).unwrap();
        assert!(range.from_read_tool);
        assert!(!range.anchor_pending);
    }

    include!("tests/session_persistence.rs");

    include!("tests/llm_history.rs");

    #[test]
    fn goal_tracks_status_usage_and_snapshot() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("snapshot.json");
        let state = AppState::new("/tmp");

        let goal = state.set_goal("finish the migration", Some(42));
        assert_eq!(goal.status, GoalStatus::Active);
        assert_eq!(state.goal().unwrap().token_budget, Some(42));

        state.account_goal_usage(25, 7);
        state.update_goal_status(GoalStatus::Paused);
        let updated = state.goal().unwrap();
        assert_eq!(updated.tokens_used, 25);
        assert_eq!(updated.time_used_seconds, 7);
        assert_eq!(updated.status, GoalStatus::Paused);

        let mut wire_snapshot = state.snapshot();
        wire_snapshot.goal_history = vec![updated.clone()];
        let persisted = serde_json::to_string(&wire_snapshot).unwrap();
        assert!(persisted.contains("\"goal\""));
        assert!(persisted.contains("\"goal_history\""));
        assert!(persisted.contains("\"goal_id\""));
        let removed_prefix = ["lo", "op"].concat();
        for removed_key in [
            format!("{removed_prefix}_goal"),
            format!("{removed_prefix}_history"),
            format!("{removed_prefix}_id"),
        ] {
            assert!(!persisted.contains(&format!("\"{removed_key}\"")));
        }
        state.export_snapshot(&path).unwrap();
        let restored = AppState::new("/tmp");
        restored.import_snapshot(&path).unwrap();
        assert_eq!(restored.goal().unwrap().objective, "finish the migration");

        let cleared = restored.clear_goal().unwrap();
        assert_eq!(cleared.status, GoalStatus::Paused);
        assert!(restored.goal().is_none());
    }

    #[test]
    fn goal_mode_defaults_to_standard_and_can_be_arrangement() {
        let state = AppState::new("/tmp");

        let standard = state.set_goal("ordinary goal", None);
        assert_eq!(standard.mode, GoalMode::Standard);

        let arrangement = state.set_goal_prepared_with_mode(
            "orchestrated goal",
            None,
            None,
            GoalMode::Arrangement,
        );
        assert_eq!(arrangement.mode, GoalMode::Arrangement);
        assert_eq!(state.goal().unwrap().mode, GoalMode::Arrangement);
    }

    #[test]
    fn goal_turn_start_counts_active_same_goal_only() {
        let state = AppState::new("/tmp");
        let goal = state.set_goal("finish docs", None);

        let counted = state
            .record_goal_turn_start(&goal.goal_id)
            .expect("active goal should count turn");
        assert_eq!(counted.turn_count, 1);
        assert!(state.record_goal_turn_start("other-goal").is_none());

        state.update_goal_status(GoalStatus::Paused);
        assert!(state.record_goal_turn_start(&goal.goal_id).is_none());
        assert_eq!(state.goal().unwrap().turn_count, 1);
    }

    #[test]
    fn active_goal_status_update_does_not_overwrite_paused_goal() {
        let state = AppState::new("/tmp");
        state.set_goal("finish docs", None);
        state.update_goal_status(GoalStatus::Paused);

        assert!(
            state
                .update_active_goal_status(GoalStatus::Complete)
                .is_none()
        );
        assert_eq!(state.goal().unwrap().status, GoalStatus::Paused);
    }

    #[test]
    fn terminal_goal_status_is_archived_and_persisted() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.set_goal("finish docs", Some(100));
        let completed = state.update_goal_status(GoalStatus::Complete).unwrap();
        state.save_history().unwrap();

        assert_eq!(state.goal_history(), vec![completed.clone()]);

        let restored = AppState::new(tmp.path());
        restored.with_history_path(tmp.path().join("restored.jsonl"));
        restored.resume_from_history(&path).unwrap();

        assert_eq!(restored.goal().unwrap().status, GoalStatus::Complete);
        assert_eq!(restored.goal_history(), vec![completed]);
    }

    #[test]
    fn completed_subagent_task_metadata_is_persisted_and_restored() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("start"));
        state.save_history().unwrap();
        let mut task = Task::new("agent-1", "Implementer agent: patch");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Completed;
        task.output_path = Some(tmp.path().join("subagents/agent-1/output.md"));
        task.transcript_path = Some(tmp.path().join("subagents/agent-1/transcript.json"));
        task.allowed_write_paths = vec!["src/parser.rs".to_string()];
        task.allowed_shell_prefixes = vec!["docker exec exact-container".to_string()];
        task.parent_session_id = Some("parent-session".to_string());
        task.agent_kind = Some("implementer".to_string());
        task.context_mode = Some("none".to_string());
        task.context_turns = Some(2);
        task.agent_depth = Some(1);
        task.max_turns = Some(60);
        task.arrangement_mode = Some(true);
        task.agent_provider = Some("anthropic".to_string());
        task.agent_model = Some("claude-test".to_string());
        task.parent_tool_call_id = Some("tool-parent-1".to_string());
        task.accepting_subagent_messages = false;
        task.notification_injected_at_ms = Some(123);
        task.notify_parent_on_completion = false;

        state.upsert_task(task.clone());

        let sidecar = load_session_state(&session_state_path(tmp.path(), "session")).unwrap();
        assert_eq!(
            sidecar.tasks["agent-1"].allowed_write_paths,
            vec!["src/parser.rs".to_string()]
        );

        let restored = AppState::new(tmp.path());
        restored.resume_from_history(&path).unwrap();

        let restored_task = restored.task("agent-1").unwrap();
        assert_eq!(restored_task.status, TaskStatus::Completed);
        assert_eq!(restored_task.kind, TaskKind::Subagent);
        assert_eq!(restored_task.allowed_write_paths, task.allowed_write_paths);
        assert_eq!(
            restored_task.allowed_shell_prefixes,
            task.allowed_shell_prefixes
        );
        assert_eq!(restored_task.transcript_path, task.transcript_path);
        assert_eq!(restored_task.output_path, task.output_path);
        assert_eq!(restored_task.parent_session_id, task.parent_session_id);
        assert_eq!(restored_task.agent_kind, task.agent_kind);
        assert_eq!(restored_task.context_mode, task.context_mode);
        assert_eq!(restored_task.context_turns, task.context_turns);
        assert_eq!(restored_task.agent_depth, task.agent_depth);
        assert_eq!(restored_task.max_turns, task.max_turns);
        assert_eq!(restored_task.arrangement_mode, task.arrangement_mode);
        assert_eq!(restored_task.agent_provider, task.agent_provider);
        assert_eq!(restored_task.agent_model, task.agent_model);
        assert_eq!(restored_task.parent_tool_call_id, task.parent_tool_call_id);
        assert_eq!(
            restored_task.accepting_subagent_messages,
            task.accepting_subagent_messages
        );
        assert_eq!(restored_task.notification_injected_at_ms, Some(123));
        assert!(!restored_task.notify_parent_on_completion);
    }

    #[test]
    fn managed_background_task_is_persisted_and_interrupted_on_resume() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("start command"));
        state.save_history().unwrap();

        let mut task = Task::new("job-shell", "tool-background:bash: cargo test --workspace");
        task.kind = TaskKind::Generic;
        task.managed = true;
        task.delivery = TaskDelivery::Background;
        task.status = TaskStatus::Running;
        task.output_path = Some(state.managed_task_output_path(&task.id));
        state.upsert_task(task);

        let sidecar = load_session_state(&session_state_path(tmp.path(), "session")).unwrap();
        assert_eq!(sidecar.tasks["job-shell"].status, TaskStatus::Running);

        let restored = AppState::new(tmp.path());
        restored.resume_from_history(&path).unwrap();
        let restored_task = restored.task("job-shell").unwrap();
        assert_eq!(restored_task.status, TaskStatus::Failed);
        assert!(
            restored_task
                .output
                .as_deref()
                .unwrap()
                .contains("owning KCoder process exited")
        );
        assert_eq!(
            fs::read_to_string(restored_task.output_path.unwrap()).unwrap(),
            "task was interrupted because its owning KCoder process exited"
        );
    }

    #[test]
    fn managed_foreground_task_is_not_persisted() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);

        let mut task = Task::new("job-inline", "tool-background:ocr: scan");
        task.managed = true;
        task.delivery = TaskDelivery::Foreground;
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        let sidecar = load_session_state(&session_state_path(tmp.path(), "session")).unwrap();
        assert!(!sidecar.tasks.contains_key("job-inline"));
    }

    #[test]
    fn concurrent_task_metadata_and_completion_keep_terminal_sidecar_state() {
        use std::sync::Barrier;

        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);

        let mut task = Task::new("agent-race", "Reviewer agent: inspect");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        state.upsert_task(task);

        for iteration in 0..32 {
            state.update_task("agent-race", |task| {
                task.status = TaskStatus::Running;
                task.output = None;
            });

            let barrier = Arc::new(Barrier::new(3));
            let metadata_state = state.clone();
            let metadata_barrier = Arc::clone(&barrier);
            let metadata = std::thread::spawn(move || {
                metadata_barrier.wait();
                metadata_state.update_task("agent-race", |task| {
                    task.output_path = Some(PathBuf::from(format!(
                        "/tmp/subagents/agent-race/output-{iteration}.md"
                    )));
                });
            });

            let completion_state = state.clone();
            let completion_barrier = Arc::clone(&barrier);
            let completion = std::thread::spawn(move || {
                completion_barrier.wait();
                completion_state.update_task("agent-race", |task| {
                    task.status = TaskStatus::Completed;
                    task.output = Some("done".to_string());
                });
            });

            barrier.wait();
            metadata.join().unwrap();
            completion.join().unwrap();

            let in_memory = state.task("agent-race").unwrap();
            let sidecar = load_session_state(&session_state_path(tmp.path(), "session")).unwrap();
            let persisted = &sidecar.tasks["agent-race"];
            assert_eq!(in_memory.status, TaskStatus::Completed);
            assert_eq!(persisted.status, in_memory.status);
            assert_eq!(persisted.output, in_memory.output);
            assert_eq!(persisted.output_path, in_memory.output_path);
        }
    }

    #[test]
    fn completed_workflow_task_metadata_is_persisted_and_restored() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("start"));
        state.save_history().unwrap();
        let mut task = Task::new("workflow-1", "Workflow: review");
        task.kind = TaskKind::Workflow;
        task.status = TaskStatus::Completed;
        task.output_path = Some(tmp.path().join("session/workflows/workflow-1/output.json"));
        state.upsert_task(task.clone());

        let restored = AppState::new(tmp.path());
        restored.resume_from_history(&path).unwrap();

        let restored_task = restored.task("workflow-1").unwrap();
        assert_eq!(restored_task.kind, TaskKind::Workflow);
        assert_eq!(restored_task.status, TaskStatus::Completed);
        assert_eq!(restored_task.output_path, task.output_path);
    }

    #[test]
    fn interrupted_and_cancelled_workflow_tasks_remain_resumable() {
        for status in [TaskStatus::Running, TaskStatus::Cancelled] {
            let tmp = TempDir::new().unwrap();
            let path = tmp.path().join("session.jsonl");
            let state = AppState::new(tmp.path());
            state.with_history_path(&path);
            state.add_message(Message::user_text("start"));
            state.save_history().unwrap();
            let mut task = Task::new("workflow-restore", "Workflow: restore");
            task.kind = TaskKind::Workflow;
            task.status = status;
            state.upsert_task(task);

            let restored = AppState::new(tmp.path());
            restored.resume_from_history(&path).unwrap();
            assert_eq!(restored.task("workflow-restore").unwrap().status, status);
        }
    }

    #[test]
    fn workflow_notification_claim_is_atomic_per_run() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("workflow-notify", "Workflow: notify");
        task.kind = TaskKind::Workflow;
        task.status = TaskStatus::Completed;
        task.run_started_at_ms = Some(now_millis());
        state.upsert_task(task);

        assert!(state.claim_task_notification_injected("workflow-notify"));
        assert!(!state.claim_task_notification_injected("workflow-notify"));
    }

    #[test]
    fn running_subagent_task_is_persisted_and_interrupted_on_resume() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("session.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&path);
        state.add_message(Message::user_text("delegate"));
        state.save_history().unwrap();

        let mut running = Task::new("agent-1", "Implementer agent: patch again");
        running.kind = TaskKind::Subagent;
        running.managed = true;
        running.status = TaskStatus::Running;
        running.transcript_path = Some(tmp.path().join("subagents/agent-1/transcript.json"));
        running.output_path = Some(tmp.path().join("subagents/agent-1/output.md"));
        state.upsert_task(running);

        let sidecar = load_session_state(&session_state_path(tmp.path(), "session")).unwrap();
        assert_eq!(sidecar.tasks["agent-1"].status, TaskStatus::Running);

        let restored = AppState::new(tmp.path());
        restored.resume_from_history(&path).unwrap();
        let restored_task = restored.task("agent-1").unwrap();
        assert_eq!(restored_task.status, TaskStatus::Failed);
        assert!(
            restored_task
                .output
                .as_deref()
                .unwrap()
                .contains("owning KCoder process exited")
        );
        assert!(restored_task.output_path.unwrap().exists());
    }

    #[test]
    fn active_goal_usage_does_not_mutate_completed_goal() {
        let state = AppState::new("/");
        state.set_goal("finish docs", None);
        state.account_active_goal_usage(10, 2);
        let completed = state.update_goal_status(GoalStatus::Complete).unwrap();

        assert!(state.account_active_goal_usage(5, 3).is_none());
        assert_eq!(state.goal().unwrap().tokens_used, completed.tokens_used);
        assert_eq!(
            state.goal().unwrap().time_used_seconds,
            completed.time_used_seconds
        );
    }

    #[test]
    fn goal_usage_updates_terminal_archive_when_directly_accounted() {
        let state = AppState::new("/");
        state.set_goal("finish docs", None);
        state.update_goal_status(GoalStatus::Complete).unwrap();

        let updated = state.account_goal_usage(5, 3).unwrap();

        assert_eq!(updated.tokens_used, 5);
        assert_eq!(state.goal_history(), vec![updated]);
    }

    #[test]
    fn history_max_messages_truncates_in_memory_buffer() {
        let state = AppState::new("/");
        state.set_history_max_messages(3);
        state.add_message(Message::user_text("one"));
        state.add_message(Message::user_text("two"));
        state.add_message(Message::user_text("three"));
        state.add_message(Message::user_text("four"));
        assert_eq!(state.messages().len(), 3);
        assert_eq!(state.last_message().unwrap().preview(10), "four");
    }

    #[test]
    fn history_limit_never_keeps_an_orphaned_tool_result() {
        let state = AppState::new("/");
        state.set_history_max_messages(3);
        state.add_message(Message::user_text("old turn"));
        state.add_message(Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-1".to_string(),
                name: "read".to_string(),
                input: serde_json::json!({"path": "old.txt"}),
            }],
            usage: None,
        });
        state.add_message(Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-1".to_string(),
                content: vec![ContentBlock::Text {
                    text: "result".to_string(),
                }],
                is_error: Some(false),
            }],
        });
        state.add_message(Message::assistant_text("old answer"));
        state.add_message(Message::user_text("new turn"));

        let messages = state.messages();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].preview(20), "new turn");
    }

    #[test]
    fn state_subagent_paths_follow_history_session_artifact_dir() {
        let tmp = TempDir::new().unwrap();
        let project_dir = tmp.path().join("kcoder/projects/_tmp_project");
        let history = project_dir.join("session-1.jsonl");
        let state = AppState::new(tmp.path().join("workspace"));
        state.with_history_path(&history);

        assert_eq!(state.artifact_session_id(), "session-1");
        assert_eq!(
            state.subagent_output_path("job-123"),
            project_dir
                .join("session-1")
                .join("subagents")
                .join("job-123")
                .join("output.md")
        );
        assert_eq!(
            state.subagent_transcript_path("job-123"),
            project_dir
                .join("session-1")
                .join("subagents")
                .join("job-123")
                .join("transcript.json")
        );
        assert_eq!(
            state.subagent_llm_request_history_dir("job-123"),
            project_dir
                .join("session-1")
                .join("subagents")
                .join("job-123")
                .join("llm-requests")
        );
    }

    #[test]
    fn historyless_state_can_route_nested_artifacts_outside_workspace() {
        let tmp = TempDir::new().unwrap();
        let workspace = tmp.path().join("workspace");
        let artifact_project_dir = tmp.path().join("client-data/projects/workspace-key");
        let state = AppState::new(&workspace);
        state.with_session_artifact_project_dir(&artifact_project_dir, "root-session");

        assert_eq!(state.artifact_session_id(), "root-session");
        assert_eq!(
            state.session_artifact_project_dir().as_deref(),
            Some(artifact_project_dir.as_path())
        );
        assert_eq!(
            state.managed_task_output_path("nested-job"),
            artifact_project_dir.join("root-session/tasks/nested-job/output.txt")
        );
        assert_eq!(
            state.subagent_transcript_path("nested-agent"),
            artifact_project_dir.join("root-session/subagents/nested-agent/transcript.json")
        );
        assert!(
            !state
                .managed_task_output_path("nested-job")
                .starts_with(&workspace)
        );

        state.start_new_session().unwrap();
        let rotated_session = state.session_id();
        assert_ne!(rotated_session, "root-session");
        assert_eq!(state.artifact_session_id(), rotated_session);
        assert_eq!(
            state.managed_task_output_path("next-job"),
            artifact_project_dir
                .join(state.session_id())
                .join("tasks/next-job/output.txt")
        );
    }

    #[test]
    fn subagent_pending_messages_are_fifo() {
        let state = AppState::new("/tmp");
        state.upsert_task(Task::new("job-1", "General agent: test"));

        assert_eq!(state.enqueue_subagent_message("job-1", "first"), Some(1));
        assert_eq!(state.enqueue_subagent_message("job-1", "second"), Some(2));
        assert_eq!(
            state.pop_subagent_message("job-1").as_deref(),
            Some("first")
        );
        assert_eq!(
            state.pop_subagent_message("job-1").as_deref(),
            Some("second")
        );
        assert!(state.pop_subagent_message("job-1").is_none());
    }

    #[test]
    fn closing_empty_subagent_queue_atomically_rejects_late_messages() {
        let state = AppState::new("/tmp");
        state.upsert_task(Task::new("job-closing", "General agent: test"));

        assert!(state.pop_or_close_subagent_message("job-closing").is_none());
        assert!(
            !state
                .task("job-closing")
                .unwrap()
                .accepting_subagent_messages
        );
        assert_eq!(
            state.enqueue_subagent_message("job-closing", "too late"),
            None
        );
        assert!(
            state
                .task("job-closing")
                .unwrap()
                .pending_messages
                .is_empty()
        );
    }

    #[test]
    fn atomic_task_metadata_update_preserves_terminal_state_and_output() {
        let state = AppState::new("/tmp");
        let mut task = Task::new("job-atomic", "General agent: test");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Completed;
        task.output = Some("finished".to_string());
        state.upsert_task(task);

        assert_eq!(
            state.update_task("job-atomic", |task| {
                task.output_path = Some(PathBuf::from("/tmp/job-atomic/output.md"));
                task.allowed_write_paths = vec!["src".to_string()];
                task.status
            }),
            Some(TaskStatus::Completed)
        );

        let task = state.task("job-atomic").unwrap();
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.output.as_deref(), Some("finished"));
        assert_eq!(task.allowed_write_paths, ["src"]);
    }

    #[test]
    fn workflow_binding_is_immutable_and_survives_snapshot_and_resume() {
        let temp = TempDir::new().unwrap();
        let history = temp.path().join("bound-workflow.jsonl");
        let state = AppState::new(temp.path());
        state.with_history_path(&history);
        assert!(state.bind_workflow_definition_before_first_message("draft-a").is_err());
        state.enter_workflow_draft_before_first_message().unwrap();
        state.bind_workflow_definition_before_first_message("draft-a").unwrap();
        assert!(state.bind_workflow_definition_before_first_message("draft-b").is_err());
        state.add_message(Message::user_text("Build my slides"));
        state.save_history().unwrap();
        let resumed = AppState::new(temp.path());
        resumed.resume_from_history(&history).unwrap();
        assert_eq!(resumed.workflow_definition_id().as_deref(), Some("draft-a"));
        assert_eq!(resumed.snapshot().workflow_definition_id.as_deref(), Some("draft-a"));
        assert_eq!(prepare_session_metadata(&history).unwrap().workflow_definition_id(), Some("draft-a"));
        let snapshot = temp.path().join("snapshot.json");
        state.export_snapshot(&snapshot).unwrap();
        let imported = AppState::new(temp.path());
        imported.import_snapshot(&snapshot).unwrap();
        assert_eq!(imported.workflow_definition_id().as_deref(), Some("draft-a"));
    }

    #[test]
    fn workflow_draft_mode_persists_and_cannot_be_escalated() {
        let temp = TempDir::new().unwrap();
        let history = temp.path().join("workflow-draft.jsonl");
        let state = AppState::new(temp.path());
        state.with_history_path(&history);
        assert!(state.enter_workflow_draft_before_first_message().unwrap());
        assert!(!state.enter_workflow_draft_before_first_message().unwrap());
        assert!(state.enter_orchestrate_before_first_message().is_err());
        state.add_message(Message::user_text("Design only"));
        state.save_history().unwrap();
        let resumed = AppState::new(temp.path());
        resumed.resume_from_history(&history).unwrap();
        assert_eq!(resumed.session_mode(), SessionMode::WorkflowDraft);
        assert!(resumed.enter_orchestrate_before_first_message().is_err());
        let ordinary = AppState::new(temp.path());
        ordinary.add_message(Message::user_text("Already started"));
        assert!(ordinary.enter_workflow_draft_before_first_message().is_err());
    }

    #[test]
    fn orchestrate_session_mode_is_set_once_before_first_message() {
        let state = AppState::new("/tmp/orchestrate-session");
        assert_eq!(state.session_mode(), SessionMode::Default);

        assert!(state.enter_orchestrate_before_first_message().unwrap());
        assert!(!state.enter_orchestrate_before_first_message().unwrap());
        assert_eq!(state.session_mode(), SessionMode::Orchestrate);
    }

    #[test]
    fn concurrent_orchestrate_entry_has_exactly_one_state_transition() {
        let state = AppState::new("/tmp/orchestrate-concurrent");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let state = state.clone();
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    state.enter_orchestrate_before_first_message().unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();

        let mut outcomes = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        outcomes.sort_unstable();
        assert_eq!(outcomes, [false, true]);
        assert_eq!(state.session_mode(), SessionMode::Orchestrate);
    }

    #[test]
    fn orchestrate_session_mode_rejects_entry_after_conversation_started() {
        let state = AppState::new("/tmp/orchestrate-session");
        state.add_message(Message::user_text("already started"));

        let error = state
            .enter_orchestrate_before_first_message()
            .expect_err("started session must reject mode changes");
        assert!(error.to_string().contains("before the first message"));
        assert_eq!(state.session_mode(), SessionMode::Default);
    }

    #[test]
    fn clearing_in_memory_messages_does_not_reopen_the_orchestrate_entry_gate() {
        let state = AppState::new("/tmp/orchestrate-session");
        state.add_message(Message::user_text("already started"));
        state.set_messages(Vec::new());

        let error = state.enter_orchestrate_before_first_message().unwrap_err();

        assert!(error.to_string().contains("before the first message"));
        assert_eq!(state.session_mode(), SessionMode::Default);
    }

    #[tokio::test]
    async fn orchestrate_entry_rejects_a_rewound_but_durably_started_session() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("rewound.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        state.add_message(Message::user_text("started"));
        state.save_history().unwrap();
        state.truncate_messages_for_rewind(0, 1).await.unwrap();
        assert!(state.messages().is_empty());

        let error = state.enter_orchestrate_before_first_message().unwrap_err();

        assert!(error.to_string().contains("before the first message"));
        assert_eq!(state.session_mode(), SessionMode::Default);
    }

    #[test]
    fn accepted_empty_history_materializes_without_replacing_existing_or_deleted_sources() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("accepted-empty.jsonl");
        let state = AppState::new(temp.path());
        state.with_history_path(&path);
        state.materialize_history().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert!(state.messages().is_empty());
        state.add_message(Message::user_text("preserve me"));
        state.save_history().unwrap();
        let bytes = std::fs::read(&path).unwrap();
        state.materialize_history().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        delete_session_history_files(&path).unwrap();
        assert!(state.materialize_history().is_err());
        assert!(!path.exists(), "materialization must not resurrect deleted history");
    }

    #[test]
    fn new_session_resets_orchestrate_mode() {
        let state = AppState::new("/tmp/orchestrate-session");
        state.enter_orchestrate_before_first_message().unwrap();

        state.start_new_session().unwrap();

        assert_eq!(state.session_mode(), SessionMode::Default);
    }

    #[test]
    fn session_snapshot_round_trips_orchestrate_mode_and_defaults_legacy_input() {
        let state = AppState::new("/tmp/orchestrate-session");
        state.enter_orchestrate_before_first_message().unwrap();
        let snapshot = state.snapshot();
        let encoded = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(encoded["session_mode"], "orchestrate");
        let decoded: SessionSnapshot = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.session_mode, SessionMode::Orchestrate);

        let mut legacy = serde_json::to_value(snapshot).unwrap();
        legacy.as_object_mut().unwrap().remove("session_mode");
        let decoded: SessionSnapshot = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.session_mode, SessionMode::Default);
    }

    #[test]
    fn orchestrate_mode_persists_in_session_sidecar_and_resume() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("session-orchestrate.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        state.enter_orchestrate_before_first_message().unwrap();
        state.add_message(Message::user_text("start orchestration"));
        state.save_history().unwrap();

        let sidecar = session_state_path(tmp.path(), "session-orchestrate");
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
        assert_eq!(persisted["session_mode"], "orchestrate");

        let resumed = AppState::new(tmp.path());
        resumed.resume_from_history(&history).unwrap();
        assert_eq!(resumed.session_mode(), SessionMode::Orchestrate);
    }

    #[test]
    fn orchestrate_entry_rolls_back_when_sidecar_write_fails() {
        let tmp = TempDir::new().unwrap();
        let history = tmp.path().join("session-rollback.jsonl");
        let sidecar = session_state_path(tmp.path(), "session-rollback");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        let _failpoint = install_atomic_replace_failpoint(sidecar);

        let error = state.enter_orchestrate_before_first_message().unwrap_err();

        assert!(error.to_string().contains("failed to persist"));
        assert_eq!(state.session_mode(), SessionMode::Default);
    }

    include!("tests/history_flusher.rs");
}
