//! Background job execution for long-running delegated work (subagents).
//!
//! Tools can spawn a background job instead of blocking the main turn loop.
//! The manager keeps an in-memory `Task` record in `AppState`, runs the work on
//! a `tokio` task, and notifies the engine via an async channel when the job
//! finishes or fails.

use futures::FutureExt;
use kcoder_config::MAX_CONCURRENT_SUBAGENTS;
use kcoder_state::{BoundedDiagnostic, Task, TaskDelivery, TaskKind, TaskStatus};
use kcoder_tools::{SpawnError, ToolOutput};

pub use kcoder_tools::background::BackgroundJobEvent;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::sync::{
    Arc, Mutex, RwLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

mod spawner;

const SUBAGENT_CANCELLATION_GRACE_PERIOD: std::time::Duration = std::time::Duration::from_secs(5);

/// Manager for delegated background work.
#[derive(Clone)]
pub struct BackgroundJobManager {
    pub(crate) live_views: crate::agent_live_view::AgentLiveViews,
    state: kcoder_state::AppState,
    tx: broadcast::Sender<BackgroundJobEvent>,
    handles: Arc<RwLock<HashMap<String, BackgroundJobHandle>>>,
    cancelled: Arc<RwLock<HashSet<String>>>,
    admission: Arc<Mutex<()>>,
    idle_reserved: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}

/// Holds background admission closed after an atomic empty-registry check.
/// Dropping rolls back the reservation unless the owner commits shutdown.
#[must_use = "dropping the reservation reopens background admission"]
pub struct BackgroundIdleReservation {
    reserved: Arc<AtomicBool>,
    committed: bool,
}

impl BackgroundIdleReservation {
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for BackgroundIdleReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.reserved.store(false, Ordering::SeqCst);
        }
    }
}

struct BackgroundJobHandle {
    join: JoinHandle<()>,
    cancel: Option<Arc<dyn Fn() + Send + Sync>>,
    generation: u64,
}

struct SpawnPolicy {
    cancel: Option<Arc<dyn Fn() + Send + Sync>>,
    max_concurrent: Option<usize>,
    kind: TaskKind,
    count_subagents_only: bool,
    reuse_existing: bool,
    notify_parent_on_completion: bool,
}

/// Capacity of the broadcast channel that fans job-lifecycle events out to
/// subscribers (the engine, the REPL, and any tool holding a wait handle).
///
/// 256 is too small: a single large fan-out (e.g. several sub-agents
/// completing while a parent is still streaming) silently drops events, and
/// `tokio::sync::broadcast::Receiver::recv` then returns `RecvError::Lagged`
/// which used to make the `wait` tool abort with `timed_out: true`. 4096 is
/// large enough for very chatty sessions without an unbounded queue growing
/// without limit if a subscriber dies.
const BACKGROUND_EVENT_CHANNEL_CAPACITY: usize = 4096;

impl BackgroundJobManager {
    pub fn try_reserve_idle(&self) -> Option<BackgroundIdleReservation> {
        let _admission = self.admission.try_lock().ok()?;
        if self.idle_reserved.load(Ordering::SeqCst)
            || !self.handles.try_read().ok()?.is_empty()
            || !self.cancelled.try_read().ok()?.is_empty()
        {
            return None;
        }
        self.idle_reserved.store(true, Ordering::SeqCst);
        Some(BackgroundIdleReservation {
            reserved: Arc::clone(&self.idle_reserved),
            committed: false,
        })
    }
    pub(crate) fn try_resource_counts(&self) -> Option<(usize, usize)> {
        let _admission = self.admission.try_lock().ok()?;
        let handles = self.handles.try_read().ok()?;
        let cancelled = self.cancelled.try_read().ok()?;
        Some((handles.len(), cancelled.len()))
    }
    /// Create a new manager together with one receiver for its event channel.
    pub fn new(state: kcoder_state::AppState) -> (Self, broadcast::Receiver<BackgroundJobEvent>) {
        let (tx, rx) = broadcast::channel(BACKGROUND_EVENT_CHANNEL_CAPACITY);
        let manager = Self {
            live_views: Default::default(),
            state,
            tx,
            handles: Arc::new(RwLock::new(HashMap::new())),
            cancelled: Arc::new(RwLock::new(HashSet::new())),
            admission: Arc::new(Mutex::new(())),
            idle_reserved: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(1)),
        };
        (manager, rx)
    }

    /// Subscribe to background job events. Multiple consumers (engine, REPL)
    /// can call this independently.
    pub fn subscribe(&self) -> broadcast::Receiver<BackgroundJobEvent> {
        self.tx.subscribe()
    }

    /// Publish a small lifecycle update for an active managed job.
    ///
    /// Progress is intentionally broadcast-only: it drives status surfaces
    /// and foreground wait heartbeats, but is never persisted as task output
    /// or injected into the model conversation. Messages are capped here so a
    /// buggy producer cannot turn the status channel into an output stream.
    pub fn report_progress(
        &self,
        id: &str,
        message: impl AsRef<str>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        self.report_progress_with_detail(id, message, None::<&str>, current, total)
    }

    pub fn report_progress_with_detail(
        &self,
        id: &str,
        message: impl AsRef<str>,
        detail: Option<impl AsRef<str>>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        if !self.state.task(id).is_some_and(|task| {
            task.managed && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
        }) {
            return false;
        }

        const MAX_PROGRESS_CHARS: usize = 160;
        let raw = message.as_ref().trim();
        if raw.is_empty() {
            return false;
        }
        let mut message = raw.chars().take(MAX_PROGRESS_CHARS).collect::<String>();
        if raw.chars().count() > MAX_PROGRESS_CHARS {
            message.push('…');
        }
        const MAX_DETAIL_CHARS: usize = 2_000;
        let detail = detail
            .map(|detail| detail.as_ref().trim().to_string())
            .filter(|detail| !detail.is_empty())
            .map(|detail| {
                let count = detail.chars().count();
                if count <= MAX_DETAIL_CHARS {
                    detail
                } else {
                    detail.chars().skip(count - MAX_DETAIL_CHARS).collect()
                }
            });
        let total = total.filter(|total| *total > 0);
        let current = match (current, total) {
            (Some(current), Some(total)) => Some(current.clamp(1, total)),
            (Some(current), None) => Some(current.max(1)),
            (None, _) => None,
        };
        let _ = self.state.record_agent_runtime_progress(
            id,
            BoundedDiagnostic {
                message: message.clone(),
                detail: detail.clone(),
                current,
                total,
                updated_at_ms: unix_timestamp_millis(),
            },
        );
        let _ = self.tx.send(BackgroundJobEvent::Progress {
            id: id.to_string(),
            message,
            detail,
            current,
            total,
        });
        true
    }

    /// Publish targeted sub-agent message state after checkpoint-before-ack completes.
    pub fn report_subagent_steer_applied(
        &self,
        id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        if !self.state.task(id).is_some_and(|task| {
            task.managed && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
        }) {
            return false;
        }
        let _ = self.tx.send(BackgroundJobEvent::SubagentSteerApplied {
            id: id.to_string(),
            message_id: message_id.to_string(),
            queue_depth,
        });
        true
    }

    pub fn associate_subagent_tool_call(
        &self,
        id: &str,
        tool_call_id: &str,
        run_in_background: bool,
    ) -> Result<(), SpawnError> {
        let associated = self.state.update_task(id, |task| {
            task.parent_tool_call_id = Some(tool_call_id.to_string());
            task.delivery = if run_in_background {
                TaskDelivery::Background
            } else {
                TaskDelivery::Foreground
            };
        });
        if associated.is_none() {
            return Err(SpawnError::NotFound { id: id.to_string() });
        }
        let _ = self.tx.send(BackgroundJobEvent::Associated {
            id: id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            run_in_background,
        });
        Ok(())
    }

    /// Spawn a background job and return its ID.
    ///
    /// Honours `max_concurrent` (if set) by refusing to spawn new jobs
    /// while that many are already in flight. The caller (typically
    /// `ToolContext::spawn_background`) translates the [`SpawnError`]
    /// return value into a structured error the model can react to
    /// (e.g. wait for one of the running sub-agents to finish before
    /// fanning out more work).
    pub fn spawn(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_cap(description, work, None)
    }

    /// Same as [`Self::spawn`] but allows the caller to pass a maximum
    /// number of concurrent jobs. The cap is best-effort: a value of
    /// `None` or `0` disables the check.
    pub fn spawn_with_cap(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_cap_and_kind(
            description,
            work,
            None,
            max_concurrent,
            TaskKind::Generic,
            false,
        )
    }

    fn spawn_cancellable_with_cap(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_cap_and_kind(
            description,
            work,
            Some(cancel),
            max_concurrent,
            TaskKind::Generic,
            false,
        )
    }

    fn spawn_foreground_with_cap(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let id = generate_job_id();
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            SpawnPolicy {
                cancel: None,
                max_concurrent,
                kind: TaskKind::Generic,
                count_subagents_only: false,
                reuse_existing: false,
                notify_parent_on_completion: false,
            },
        )
    }

    fn spawn_cancellable_foreground_with_cap(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let id = generate_job_id();
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent,
                kind: TaskKind::Generic,
                count_subagents_only: false,
                reuse_existing: false,
                notify_parent_on_completion: false,
            },
        )
    }

    /// Spawn a sub-agent job and enforce the cap against only currently
    /// running sub-agent jobs.
    pub fn spawn_subagent_with_cap(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_cap_and_kind(description, work, None, Some(cap), TaskKind::Subagent, true)
    }

    /// Spawn a new sub-agent using a caller-provided public ID.
    pub fn spawn_subagent_with_id_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: None,
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: false,
                notify_parent_on_completion: true,
            },
        )
    }

    /// Spawn a sub-agent with a cooperative cancellation callback.
    pub fn spawn_cancellable_subagent_with_id_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: false,
                notify_parent_on_completion: true,
            },
        )
    }

    /// Spawn a script workflow using a stable run ID. Workflow concurrency is
    /// enforced inside the workflow runtime against its agent semaphore.
    pub fn spawn_workflow_with_id_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: None,
                max_concurrent,
                kind: TaskKind::Workflow,
                count_subagents_only: false,
                reuse_existing: false,
                notify_parent_on_completion: true,
            },
        )
    }

    pub fn respawn_workflow_with_id_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: None,
                max_concurrent,
                kind: TaskKind::Workflow,
                count_subagents_only: false,
                reuse_existing: true,
                notify_parent_on_completion: true,
            },
        )
    }

    /// Spawn a sub-agent that is awaited by its calling tool. Notification
    /// delivery is disabled atomically before the job is allowed to start.
    pub fn spawn_subagent_foreground_with_id_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: None,
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: false,
                notify_parent_on_completion: false,
            },
        )
    }

    pub fn spawn_cancellable_subagent_foreground_with_id_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: false,
                notify_parent_on_completion: false,
            },
        )
    }

    /// Re-open an existing sub-agent ID for another background turn.
    pub fn respawn_subagent_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: None,
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: true,
                notify_parent_on_completion: true,
            },
        )
    }

    pub fn respawn_cancellable_subagent_with_cap(
        &self,
        id: impl Into<String>,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Arc<dyn Fn() + Send + Sync>,
        max_concurrent: Option<usize>,
    ) -> Result<String, SpawnError> {
        let cap = match max_concurrent {
            Some(cap) if cap > 0 => cap.min(MAX_CONCURRENT_SUBAGENTS),
            _ => MAX_CONCURRENT_SUBAGENTS,
        };
        self.spawn_with_id_and_kind(
            id.into(),
            description,
            work,
            SpawnPolicy {
                cancel: Some(cancel),
                max_concurrent: Some(cap),
                kind: TaskKind::Subagent,
                count_subagents_only: true,
                reuse_existing: true,
                notify_parent_on_completion: true,
            },
        )
    }

    fn spawn_with_cap_and_kind(
        &self,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        cancel: Option<Arc<dyn Fn() + Send + Sync>>,
        max_concurrent: Option<usize>,
        kind: TaskKind,
        count_subagents_only: bool,
    ) -> Result<String, SpawnError> {
        let id = generate_job_id();
        self.spawn_with_id_and_kind(
            id,
            description,
            work,
            SpawnPolicy {
                cancel,
                max_concurrent,
                kind,
                count_subagents_only,
                reuse_existing: false,
                notify_parent_on_completion: true,
            },
        )
    }

    fn spawn_with_id_and_kind(
        &self,
        id: String,
        description: impl Into<String>,
        work: Pin<Box<dyn Future<Output = ToolOutput> + Send>>,
        policy: SpawnPolicy,
    ) -> Result<String, SpawnError> {
        let SpawnPolicy {
            cancel,
            max_concurrent,
            kind,
            count_subagents_only,
            reuse_existing,
            notify_parent_on_completion,
        } = policy;
        // Capacity checks, duplicate-ID checks, task publication, and handle
        // publication form one admission transaction. Work remains gated by
        // start_rx, so holding this mutex cannot wait on user work.
        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.idle_reserved.load(Ordering::SeqCst) {
            return Err(SpawnError::AdmissionClosed);
        }
        if let Some(cap) = max_concurrent
            && cap > 0
        {
            let running = if count_subagents_only {
                self.count_running_subagents()
            } else {
                self.count_running()
            };
            if running >= cap {
                return Err(SpawnError::TooManyConcurrent {
                    running,
                    limit: cap,
                });
            }
        }
        let description = description.into();
        crate::recover_write_lock(&self.cancelled, "background_job_cancelled").remove(&id);
        {
            let handles = crate::recover_read_lock(&self.handles, "background_job_handles");
            if handles.contains_key(&id) {
                return Err(SpawnError::AlreadyRunning { id });
            }
        }

        let now = now_millis();
        let mut task = if reuse_existing {
            let mut task = self
                .state
                .task(&id)
                .ok_or_else(|| SpawnError::NotFound { id: id.clone() })?;
            if task.kind != kind {
                return Err(SpawnError::NotSubagent { id });
            }
            // The live-handle check above is authoritative. A restored
            // Pending/Running workflow has no handle after process restart and
            // is therefore an interrupted run that may be resumed.
            if !matches!(kind, TaskKind::Workflow)
                && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
            {
                return Err(SpawnError::AlreadyRunning { id });
            }
            // A continuation respawn must not erase the original delegation
            // description; only fill it in when the task never had one.
            if task.description.trim().is_empty() {
                task.description = description.clone();
            }
            task
        } else {
            if self.state.task(&id).is_some() {
                return Err(SpawnError::AlreadyExists { id });
            }
            Task::new(&id, &description)
        };
        task.status = TaskStatus::Running;
        task.output = None;
        task.updated_at_ms = now;
        task.run_started_at_ms = Some(now);
        task.notification_injected_at_ms = None;
        task.kind = kind;
        task.managed = true;
        task.delivery = if notify_parent_on_completion {
            TaskDelivery::Background
        } else {
            TaskDelivery::Foreground
        };
        task.notify_parent_on_completion = notify_parent_on_completion;
        if matches!(kind, TaskKind::Subagent) {
            task.accepting_subagent_messages = true;
            if task.output_path.is_none() {
                task.output_path = Some(self.state.subagent_output_path(&id));
            }
            if task.transcript_path.is_none() {
                task.transcript_path = Some(self.state.subagent_transcript_path(&id));
            }
        } else if matches!(kind, TaskKind::Generic) && task.output_path.is_none() {
            task.output_path = Some(self.state.managed_task_output_path(&id));
        }
        self.state.upsert_task(task);
        let _ = self.tx.send(BackgroundJobEvent::Started {
            id: id.clone(),
            description: description.clone(),
            continuation: reuse_existing,
        });

        let tx = self.tx.clone();
        let state = self.state.clone();
        let handles = Arc::clone(&self.handles);
        let cancelled = Arc::clone(&self.cancelled);
        let admission = Arc::clone(&self.admission);
        let generation = Arc::clone(&self.generation);
        let job_generation = generation.load(Ordering::SeqCst);
        let job_id = id.clone();
        let (start_tx, start_rx) = oneshot::channel();

        let handle = tokio::spawn(async move {
            // The handle must be visible before fast work can finish and run
            // its cleanup path. Otherwise completion can remove nothing and
            // spawn then inserts a permanently stale handle.
            let _ = start_rx.await;
            // A panic inside delegated work must still pass through the normal
            // terminal-state transaction below. Letting it unwind out of this
            // task would strand the persisted Task in Running, leave its
            // SendMessage queue open, and retain a stale concurrency handle.
            let output = match AssertUnwindSafe(work).catch_unwind().await {
                Ok(output) => output,
                Err(payload) => ToolOutput::error(format!(
                    "background job panicked: {}",
                    panic_payload_text(payload)
                )),
            };
            let is_error = output.is_error;
            let text = tool_output_to_text(&output);

            let mut task = state
                .task(&job_id)
                .unwrap_or_else(|| Task::new(&job_id, &description));
            if matches!(task.kind, TaskKind::Subagent | TaskKind::Generic) {
                let output_path = task.output_path.clone().unwrap_or_else(|| match task.kind {
                    TaskKind::Subagent => state.subagent_output_path(&job_id),
                    TaskKind::Generic => state.managed_task_output_path(&job_id),
                    TaskKind::Workflow => unreachable!(),
                });
                match write_managed_output_file(&output_path, &text).await {
                    Ok(()) => {
                        task.output_path = Some(output_path);
                    }
                    Err(error) => {
                        tracing::warn!(
                            agent_id = %job_id,
                            error = %error,
                            "failed to write subagent output file"
                        );
                    }
                }
            }
            // Keep terminal publication ordered with a continuation that
            // reuses this public agent ID. Spawn admission uses the same gate,
            // so subscribers must observe Completed(old) before Started(new),
            // never the reverse.
            let _admission = admission
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            {
                // Serialize the terminal state commit with abort(). Without
                // this gate, TaskStop can mark a task cancelled after this
                // future's check but before its Completed upsert.
                let cancelled = crate::recover_write_lock(&cancelled, "background_job_cancelled");
                // `abort_and_wait` owns removal of this marker. Keeping it
                // until the cancellation path publishes the terminal state
                // makes the job continue to consume admission capacity while
                // cooperative cleanup is still running.
                if cancelled.contains(&job_id) {
                    let mut handles = crate::recover_write_lock(&handles, "background_job_handles");
                    handles.remove(&job_id);
                    return;
                }
                if let Some(control_status) = state.task(&job_id).map(|task| task.status)
                    && matches!(control_status, TaskStatus::Paused | TaskStatus::Halted)
                {
                    state.update_task(&job_id, |current| {
                        current.output = Some(text.clone());
                        current.updated_at_ms = now_millis();
                    });
                    state.record_orchestrate_runtime_event_after_commit(
                        "agent_status_changed",
                        state
                            .task(&job_id)
                            .as_ref()
                            .and_then(|task| task.orchestrate_work_id.as_deref()),
                        None,
                        Some(&job_id),
                        None,
                        serde_json::json!({
                            "status": match control_status {
                                TaskStatus::Paused => "paused",
                                TaskStatus::Halted => "halted",
                                _ => unreachable!(),
                            },
                            "source": "safe_boundary_control",
                        }),
                    );
                    if control_status == TaskStatus::Halted
                        && let Err(error) = state.dead_letter_subagent_deliveries_on_close(
                            &job_id,
                            "agent was gracefully halted at a safe boundary",
                        )
                    {
                        tracing::warn!(
                            agent_id = %job_id,
                            error = %error,
                            "failed to retain halted agent deliveries in dead-letter"
                        );
                    }
                    crate::recover_write_lock(&handles, "background_job_handles").remove(&job_id);
                    drop(cancelled);
                    if generation.load(Ordering::SeqCst) == job_generation {
                        let event = match control_status {
                            TaskStatus::Paused => BackgroundJobEvent::Paused {
                                id: job_id.clone(),
                                reason: "paused at a safe boundary by parent Orchestrate session"
                                    .to_string(),
                            },
                            TaskStatus::Halted => BackgroundJobEvent::Halted {
                                id: job_id.clone(),
                                reason: "gracefully halted by parent Orchestrate session"
                                    .to_string(),
                            },
                            _ => unreachable!(),
                        };
                        let _ = tx.send(event);
                    }
                    return;
                }
                let output_path = task.output_path.clone();
                let committed = state.update_task(&job_id, |current| {
                    if matches!(current.status, TaskStatus::Cancelled) {
                        return false;
                    }
                    current.status = if is_error {
                        TaskStatus::Failed
                    } else {
                        TaskStatus::Completed
                    };
                    if matches!(current.kind, TaskKind::Subagent) {
                        current.accepting_subagent_messages = false;
                    }
                    current.output = Some(text.clone());
                    current.updated_at_ms = now_millis();
                    if output_path.is_some() {
                        current.output_path = output_path.clone();
                    }
                    true
                });
                if matches!(committed, Some(false)) {
                    if matches!(
                        state.task(&job_id).map(|task| task.status),
                        Some(TaskStatus::Cancelled)
                    ) && let Err(error) = state.dead_letter_subagent_deliveries_on_close(
                        &job_id,
                        "agent execution was cancelled",
                    ) {
                        tracing::warn!(
                            agent_id = %job_id,
                            error = %error,
                            "failed to retain cancelled agent deliveries in dead-letter"
                        );
                    }
                    let mut handles = crate::recover_write_lock(&handles, "background_job_handles");
                    handles.remove(&job_id);
                    drop(handles);
                    if matches!(
                        state.task(&job_id).map(|task| task.status),
                        Some(TaskStatus::Cancelled)
                    ) && generation.load(Ordering::SeqCst) == job_generation
                    {
                        let _ = tx.send(BackgroundJobEvent::Cancelled {
                            id: job_id.clone(),
                            reason: text.clone(),
                        });
                    }
                    return;
                }
                if committed.is_none() {
                    let mut current = Task::new(&job_id, &description);
                    current.status = if is_error {
                        TaskStatus::Failed
                    } else {
                        TaskStatus::Completed
                    };
                    current.output = Some(text.clone());
                    current.output_path = output_path;
                    current.updated_at_ms = now_millis();
                    current.kind = kind;
                    if matches!(kind, TaskKind::Subagent) {
                        current.accepting_subagent_messages = false;
                    }
                    current.managed = true;
                    current.delivery = if notify_parent_on_completion {
                        TaskDelivery::Background
                    } else {
                        TaskDelivery::Foreground
                    };
                    current.notify_parent_on_completion = notify_parent_on_completion;
                    state.upsert_task(current);
                }
                let terminal_status = if is_error { "failed" } else { "completed" };
                state.record_orchestrate_runtime_event_after_commit(
                    "agent_status_changed",
                    state
                        .task(&job_id)
                        .as_ref()
                        .and_then(|task| task.orchestrate_work_id.as_deref()),
                    None,
                    Some(&job_id),
                    None,
                    serde_json::json!({"status": terminal_status}),
                );
                state.record_orchestrate_runtime_event_after_commit(
                    "agent_closed",
                    state
                        .task(&job_id)
                        .as_ref()
                        .and_then(|task| task.orchestrate_work_id.as_deref()),
                    None,
                    Some(&job_id),
                    None,
                    serde_json::json!({"status": terminal_status}),
                );
                // Commit terminal state and remove the live handle under the
                // same lifecycle lock. TaskStop can no longer observe a
                // completed task while still obtaining a cancellable handle.
                crate::recover_write_lock(&handles, "background_job_handles").remove(&job_id);
            }

            let event = if is_error {
                BackgroundJobEvent::Failed {
                    id: job_id.clone(),
                    error: output
                        .content
                        .iter()
                        .filter_map(|b| match b {
                            kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<String>(),
                }
            } else {
                BackgroundJobEvent::Completed {
                    id: job_id.clone(),
                    output,
                }
            };
            // A terminal event is a public synchronization point: the handle
            // was removed in the same transaction that committed final state.
            if generation.load(Ordering::SeqCst) == job_generation {
                let _ = tx.send(event);
            }
        });

        crate::recover_write_lock(&self.handles, "background_job_handles").insert(
            id.clone(),
            BackgroundJobHandle {
                join: handle,
                cancel,
                generation: job_generation,
            },
        );
        let _ = start_tx.send(());
        Ok(id)
    }

    /// Number of background jobs currently in the `Running` state, as
    /// tracked in [`kcoder_state::AppState`]. Used by the concurrency
    /// cap to refuse new spawns when the limit has been hit.
    fn count_running(&self) -> usize {
        self.state
            .tasks()
            .values()
            .filter(|t| matches!(t.status, TaskStatus::Running))
            .count()
    }

    fn count_running_subagents(&self) -> usize {
        let cancelled = crate::recover_read_lock(&self.cancelled, "background_job_cancelled");
        self.state
            .tasks()
            .values()
            .filter(|t| {
                matches!(t.status, TaskStatus::Running) || cancelled.contains(t.id.as_str())
            })
            .filter(|t| matches!(t.kind, TaskKind::Subagent))
            .count()
    }

    /// Abort a running background job by ID, if it exists.
    pub fn abort(&self, id: &str) -> bool {
        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let handle = {
            // Serialize the running-state check with the completion commit.
            // TaskStop may race a command that has just produced its result.
            let _cancelled = crate::recover_write_lock(&self.cancelled, "background_job_cancelled");
            let Some(handle) =
                crate::recover_write_lock(&self.handles, "background_job_handles").remove(id)
            else {
                return false;
            };
            self.state.update_task(id, |task| {
                if matches!(task.status, TaskStatus::Pending | TaskStatus::Running) {
                    task.status = TaskStatus::Cancelled;
                    if matches!(task.kind, TaskKind::Subagent) {
                        task.accepting_subagent_messages = false;
                    }
                    // Managed command tools stream useful stdout/stderr to
                    // output_path while running. Leave their inline output
                    // unset so TaskOutput can return that partial capture
                    // after cancellation instead of overwriting it with the
                    // cancellation reason. Other task kinds keep the reason
                    // inline because their output files may belong to an
                    // earlier/resumable run.
                    task.output = if matches!(task.kind, TaskKind::Generic) {
                        None
                    } else {
                        Some("cancelled by user".to_string())
                    };
                    task.updated_at_ms = now_millis();
                }
            });
            if let Err(error) = self
                .state
                .dead_letter_subagent_deliveries_on_close(id, "agent was cancelled by user")
            {
                tracing::warn!(
                    agent_id = %id,
                    error = %error,
                    "failed to retain cancelled agent deliveries in dead-letter"
                );
            }
            self.state.record_orchestrate_runtime_event_after_commit(
                "agent_closed",
                self.state
                    .task(id)
                    .as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                None,
                serde_json::json!({"status": "cancelled", "source": "emergency_cancel"}),
            );
            handle
        };
        {
            if let Some(cancel) = handle.cancel {
                cancel();
            }
            handle.join.abort();
            if handle.generation == self.generation.load(Ordering::SeqCst) {
                let _ = self.tx.send(BackgroundJobEvent::Cancelled {
                    id: id.to_string(),
                    reason: "cancelled by user".to_string(),
                });
            }
            true
        }
    }

    /// Move an agent already stopped at a safe boundary with no live handle into the cancelled terminal state.
    pub fn cancel_paused(&self, id: &str) -> bool {
        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cancelled = self.state.update_task(id, |task| {
            if !task.managed || task.status != TaskStatus::Paused {
                return false;
            }
            task.status = TaskStatus::Cancelled;
            task.accepting_subagent_messages = false;
            task.output = Some("cancelled by user".to_string());
            task.updated_at_ms = unix_timestamp_millis();
            true
        });
        if cancelled != Some(true) {
            return false;
        }
        if let Err(error) = self
            .state
            .dead_letter_subagent_deliveries_on_close(id, "paused agent was cancelled by user")
        {
            tracing::warn!(
                agent_id = %id,
                error = %error,
                "failed to retain paused agent deliveries in dead-letter"
            );
        }
        self.state.record_orchestrate_runtime_event_after_commit(
            "agent_closed",
            self.state
                .task(id)
                .as_ref()
                .and_then(|task| task.orchestrate_work_id.as_deref()),
            None,
            Some(id),
            None,
            serde_json::json!({"status": "cancelled", "source": "paused_cancel"}),
        );
        let _ = self.tx.send(BackgroundJobEvent::Cancelled {
            id: id.to_string(),
            reason: "cancelled by user".to_string(),
        });
        true
    }

    /// Cooperatively cancel a managed job and wait for bounded cleanup before
    /// publishing its terminal cancelled state. Sub-agents use the grace
    /// window to repair tool protocol and persist transcript/output artifacts.
    pub async fn abort_and_wait(&self, id: &str) -> bool {
        let mut handle = {
            // Serialize this claim with the normal completion commit. The
            // cancellation marker retains admission capacity until cleanup
            // finishes, even if the agent loop observes cancellation first.
            let mut cancelled =
                crate::recover_write_lock(&self.cancelled, "background_job_cancelled");
            let Some(handle) =
                crate::recover_write_lock(&self.handles, "background_job_handles").remove(id)
            else {
                return false;
            };
            cancelled.insert(id.to_string());
            handle
        };

        if let Some(cancel) = handle.cancel.as_ref() {
            cancel();
        }

        if tokio::time::timeout(SUBAGENT_CANCELLATION_GRACE_PERIOD, &mut handle.join)
            .await
            .is_err()
        {
            handle.join.abort();
            let _ = handle.join.await;
        }

        let task = self.state.task(id);
        if let Some(task) = task.as_ref()
            && matches!(task.kind, TaskKind::Subagent)
        {
            let transcript_path = task
                .transcript_path
                .clone()
                .unwrap_or_else(|| self.state.subagent_transcript_path(id));
            if !transcript_path.exists() {
                let fallback = vec![kcoder_types::Message::user_text(format!(
                    "[sub-agent {id} was cancelled before its first transcript checkpoint completed]"
                ))];
                match serde_json::to_string_pretty(&fallback) {
                    Ok(fallback) => {
                        if let Err(error) =
                            write_managed_output_file(&transcript_path, &fallback).await
                        {
                            tracing::warn!(
                                agent_id = %id,
                                error = %error,
                                "failed to write cancelled subagent transcript fallback"
                            );
                        }
                    }
                    Err(error) => tracing::warn!(
                        agent_id = %id,
                        error = %error,
                        "failed to serialize cancelled subagent transcript fallback"
                    ),
                }
            }
            let output_path = task
                .output_path
                .clone()
                .unwrap_or_else(|| self.state.subagent_output_path(id));
            if !output_path.exists()
                && let Err(error) =
                    write_managed_output_file(&output_path, "cancelled by user").await
            {
                tracing::warn!(
                    agent_id = %id,
                    error = %error,
                    "failed to write cancelled subagent output file"
                );
            }
        }

        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        {
            // Publish the terminal state and release the cancellation marker
            // under one lifecycle gate. Admission cannot observe a gap where
            // cleanup is still represented by neither Running nor cancelling.
            let mut cancelled =
                crate::recover_write_lock(&self.cancelled, "background_job_cancelled");
            self.state.update_task(id, |task| {
                if matches!(task.status, TaskStatus::Pending | TaskStatus::Running) {
                    task.status = TaskStatus::Cancelled;
                    if matches!(task.kind, TaskKind::Subagent) {
                        task.accepting_subagent_messages = false;
                        task.output = Some("cancelled by user".to_string());
                    } else if !matches!(task.kind, TaskKind::Generic) {
                        task.output = Some("cancelled by user".to_string());
                    }
                    task.updated_at_ms = now_millis();
                }
            });
            if let Err(error) = self
                .state
                .dead_letter_subagent_deliveries_on_close(id, "agent was cancelled by user")
            {
                tracing::warn!(
                    agent_id = %id,
                    error = %error,
                    "failed to retain cancelled agent deliveries in dead-letter"
                );
            }
            self.state.record_orchestrate_runtime_event_after_commit(
                "agent_closed",
                self.state
                    .task(id)
                    .as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                None,
                serde_json::json!({"status": "cancelled", "source": "cooperative_cancel"}),
            );
            cancelled.remove(id);
        }

        if handle.generation == self.generation.load(Ordering::SeqCst) {
            let _ = self.tx.send(BackgroundJobEvent::Cancelled {
                id: id.to_string(),
                reason: "cancelled by user".to_string(),
            });
        }
        true
    }

    /// Promote a foreground-delivered job after its caller exhausts the
    /// foreground wait budget. The lifecycle gate serializes this update with
    /// terminal completion so `notify_parent_on_completion` cannot be lost.
    pub fn promote_to_background_delivery(&self, id: &str) -> Result<(), SpawnError> {
        let terminal_event = {
            let _lifecycle = crate::recover_write_lock(&self.cancelled, "background_job_cancelled");
            self.state
                .update_task(id, |task| {
                    task.delivery = TaskDelivery::Background;
                    task.notify_parent_on_completion = true;
                    task.notification_injected_at_ms = None;
                    match task.status {
                        TaskStatus::Completed => Some(BackgroundJobEvent::Completed {
                            id: id.to_string(),
                            output: ToolOutput::text(task.output.clone().unwrap_or_default()),
                        }),
                        TaskStatus::Failed => Some(BackgroundJobEvent::Failed {
                            id: id.to_string(),
                            error: task
                                .output
                                .clone()
                                .unwrap_or_else(|| "background task failed".to_string()),
                        }),
                        TaskStatus::Cancelled => Some(BackgroundJobEvent::Cancelled {
                            id: id.to_string(),
                            reason: task
                                .output
                                .clone()
                                .unwrap_or_else(|| "cancelled by user".to_string()),
                        }),
                        TaskStatus::Halted => Some(BackgroundJobEvent::Halted {
                            id: id.to_string(),
                            reason: "gracefully halted by parent Orchestrate session".to_string(),
                        }),
                        TaskStatus::Paused | TaskStatus::Pending | TaskStatus::Running => None,
                    }
                })
                .ok_or_else(|| SpawnError::NotFound { id: id.to_string() })?
        };

        let _ = self
            .tx
            .send(BackgroundJobEvent::Promoted { id: id.to_string() });

        // A completion may win the timeout race and its original event may
        // already have been consumed while foreground notifications were
        // disabled. Re-publishing is safe because notification injection is
        // claimed atomically by task ID.
        if let Some(event) = terminal_event {
            let _ = self.tx.send(event);
        }
        Ok(())
    }

    pub fn abort_all(&self) -> usize {
        let ids = crate::recover_read_lock(&self.handles, "background_job_handles")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ids.into_iter().filter(|id| self.abort(id)).count()
    }

    /// Move to a fresh owner generation and stop all jobs from the previous
    /// session. Terminal events from those jobs are suppressed so independent
    /// engine and REPL subscribers cannot apply stale UI or hook effects.
    pub fn advance_generation_and_abort_all(&self) -> usize {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.abort_all()
    }

    /// Cancel a live job because its owning goal hit a hard runtime stop.
    ///
    /// Unlike user-triggered aborts, this should not surface as a failed
    /// sub-agent or inject a failure notification into the parent transcript:
    /// the goal status itself is the user-visible terminal event.
    pub fn cancel_for_goal_stop(&self, id: &str, reason: &str) -> bool {
        let handle = crate::recover_write_lock(&self.handles, "background_job_handles").remove(id);
        if let Some(handle) = handle {
            if handle.cancel.is_some() {
                crate::recover_write_lock(&self.cancelled, "background_job_cancelled")
                    .insert(id.to_string());
            }
            self.state.remove_task(id);
            if let Some(cancel) = handle.cancel {
                cancel();
            } else {
                handle.join.abort();
            }
            let _ = self.tx.send(BackgroundJobEvent::Completed {
                id: id.to_string(),
                output: ToolOutput::text(reason.to_string()),
            });
            true
        } else {
            false
        }
    }
}

fn unix_timestamp_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn generate_job_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("job-{}", ts)
}

fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn write_managed_output_file(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, text).await
}

fn tool_output_to_text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|b| match b {
            kcoder_types::ContentBlock::Text { text } => Some(text.clone()),
            _ => None,
        })
        .collect::<String>()
}

fn panic_payload_text(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

#[cfg(test)]
#[path = "background/tests.rs"]
mod tests;
