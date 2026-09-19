use crossterm::event::Event as CEvent;
use kcoder_engine::WriteInputPreview;
use kcoder_permissions::{
    PermissionDialogResult, PermissionPrompt, PermissionRequestContext, PermissionResponse,
    PermissionRisk,
};
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse, UserQuestioner};
use std::path::PathBuf;
use tokio::sync::mpsc;

use crate::clipboard_image::ClipboardImage;

/// Permission prompt implementation that forwards requests to the TUI event loop.
#[derive(Clone)]
pub(crate) struct TuiPermissionPrompt {
    tx: AppEventSender,
}

impl TuiPermissionPrompt {
    pub(crate) fn new(tx: AppEventSender) -> Self {
        Self { tx }
    }
}

#[async_trait::async_trait]
impl PermissionPrompt for TuiPermissionPrompt {
    async fn ask(
        &self,
        tool_name: &str,
        description: String,
        input: &serde_json::Value,
    ) -> PermissionResponse {
        let context = PermissionRequestContext {
            tool_name: tool_name.to_string(),
            description,
            input: input.clone(),
            risk: PermissionRisk::Low,
            detail_lines: vec![input.to_string()],
        };
        self.ask_context(&context).await
    }

    async fn ask_context(&self, context: &PermissionRequestContext) -> PermissionResponse {
        self.ask_context_with_edit(context).await.response
    }

    async fn ask_context_with_edit(
        &self,
        context: &PermissionRequestContext,
    ) -> PermissionDialogResult {
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        let request = AppEvent::PermissionRequest {
            tool_name: context.tool_name.clone(),
            description: context.description.clone(),
            input: context.input.clone(),
            risk: context.risk,
            detail_lines: context.detail_lines.clone(),
            response_tx,
        };
        if !self.tx.send_ordered(request).await {
            return PermissionDialogResult {
                response: PermissionResponse::DenyOnce,
                modified_input: None,
            };
        }
        response_rx.await.unwrap_or(PermissionDialogResult {
            response: PermissionResponse::DenyOnce,
            modified_input: None,
        })
    }
}

/// User-question prompt implementation that forwards requests to the TUI event loop.
#[derive(Clone)]
pub(crate) struct TuiUserQuestioner {
    tx: AppEventSender,
}

impl TuiUserQuestioner {
    pub(crate) fn new(tx: AppEventSender) -> Self {
        Self { tx }
    }
}

#[async_trait::async_trait]
impl UserQuestioner for TuiUserQuestioner {
    async fn ask(&self, request: UserQuestionRequest) -> Result<UserQuestionResponse, String> {
        let (response_tx, response_rx) = tokio::sync::oneshot::channel();
        if !self
            .tx
            .send_ordered(AppEvent::UserQuestionRequest {
                request,
                response_tx,
            })
            .await
        {
            return Err("TUI event loop is no longer running".to_string());
        }
        response_rx
            .await
            .map_err(|_| "question was cancelled".to_string())
    }
}

/// Events produced by the async runtime and forwarded into the TUI event loop.
#[derive(Debug)]
pub enum AppEvent {
    /// A chunk of assistant text arrived.
    AssistantDelta(String),
    /// A chunk of assistant thinking arrived.
    AssistantThinkingDelta(String),
    /// The model is streaming a tool call's JSON input. The payload itself is
    /// deliberately kept out of the UI queue; only safe progress metadata is sent.
    ToolInputProgress { name: String, chars: usize },
    /// Transient path metadata, scoped to its foreground generation.
    ToolPathPreview {
        generation: u64,
        attempt_id: String,
        id: String,
        path: Option<String>,
    },
    /// Bounded live content window for a streamed `write` input.
    ToolInputPreview {
        id: String,
        preview: WriteInputPreview,
    },
    /// The assistant started producing output for a content block.
    AssistantMessageStarted,
    /// The assistant finished a content block.
    AssistantMessageDone,
    /// Assistant requested a tool.
    ToolUseStarted {
        id: String,
        name: String,
        input: String,
    },
    /// Tool produced output.
    ToolResult {
        id: String,
        name: String,
        text: String,
        is_error: bool,
    },
    /// Permission prompt is required.
    PermissionRequest {
        tool_name: String,
        description: String,
        input: serde_json::Value,
        risk: PermissionRisk,
        detail_lines: Vec<String>,
        response_tx: tokio::sync::oneshot::Sender<PermissionDialogResult>,
    },
    /// Interactive user question is required.
    UserQuestionRequest {
        request: UserQuestionRequest,
        response_tx: tokio::sync::oneshot::Sender<UserQuestionResponse>,
    },
    /// An error occurred.
    Error(String),
    /// A fatal runtime event requires the TUI to exit after showing the reason.
    Fatal(String),
    /// Informational notice from the engine (e.g. auto-retry).
    SystemNotice(String),
    /// A clipboard image has been normalized into a private temporary PNG.
    ClipboardImageReady(ClipboardImage),
    /// Clipboard image acquisition failed without changing composer contents.
    ClipboardImageFailed(String),
    /// One MoA reference model finished and should be committed to the transcript.
    MoaReference {
        label: String,
        text: String,
        index: usize,
        count: usize,
    },
    /// MoA references are ready and the configured acting model is starting.
    MoaAggregating { aggregator: String },
    /// Compact status for an MoA planning compound operation, excluded from conversation history.
    MoaPlanProgress {
        message: String,
        completed: usize,
        total: usize,
    },
    /// Terminal input event.
    Terminal(CEvent),
    /// A new turn started streaming.
    TurnStarted,
    /// The engine wrote a steering input at a safe boundary in the current turn.
    TurnSteerApplied { id: u64 },
    /// The current turn finished for any reason.
    TurnFinished,
    /// Manual context compaction completed successfully.
    ManualCompactionFinished {
        did_compact: bool,
        pre_compact_tokens: usize,
        post_compact_tokens: usize,
    },
    /// Manual context compaction failed.
    ManualCompactionFailed { error: String },
    /// A foreground MoA planning operation succeeded and wrote its final document to the session and artifact directory.
    MoaPlanFinished {
        final_path: PathBuf,
        draft_count: usize,
        failed_count: usize,
    },
    /// A foreground MoA planning operation failed or was cancelled.
    MoaPlanFailed { error: String },
    /// An isolated `/btw` request completed without touching the main turn.
    SideQuestionCompleted { id: u64, answer: String },
    /// An isolated `/btw` request failed or was cancelled.
    SideQuestionFailed { id: u64, error: String },
    /// Scheduled frame tick. This advances spinner/status animations and moves
    /// stable active-turn prefixes into committed transcript history.
    FrameTick,
    /// Conversation history changed (user message added, turn completed, etc).
    HistoryChanged,
    /// The event loop should try to start the next queued, follow-up, or goal turn.
    TurnWakeRequested,
    /// A background sub-agent completion should be consumed when the next
    /// non-user turn is scheduled. One id per event, same order; cron entries
    /// carry an empty id and always survive validation.
    BackgroundFollowupRequested {
        ids: Vec<String>,
        events: Vec<String>,
        summary: String,
    },
    /// A background job was started by a tool.
    BackgroundJobStarted {
        id: String,
        description: String,
        continuation: bool,
    },
    /// Stable association between a sub-agent and its parent tool-use block.
    BackgroundJobAssociated {
        id: String,
        tool_call_id: String,
        run_in_background: bool,
    },
    /// A blocking sub-agent continued as the same background run.
    BackgroundJobPromoted { id: String },
    /// A running background job reported a bounded lifecycle update.
    BackgroundJobProgress {
        id: String,
        message: String,
        detail: Option<String>,
        current: Option<usize>,
        total: Option<usize>,
    },
    /// A targeted message was written to the destination sub-agent transcript and acknowledged by the reliable queue.
    SubagentSteerApplied {
        id: String,
        message_id: String,
        queue_depth: usize,
    },
    /// Authoritative running state reconstructed after broadcast lag.
    BackgroundJobReconciledRunning {
        id: String,
        detail: Option<String>,
        current: Option<usize>,
        total: Option<usize>,
    },
    /// A background job finished successfully.
    BackgroundJobCompleted { id: String, summary: Option<String> },
    /// A background job failed.
    BackgroundJobFailed { id: String, error: String },
    /// A sub-agent paused at a safe protocol boundary.
    BackgroundJobPaused { id: String, reason: String },
    /// A sub-agent halted gracefully at a safe protocol boundary.
    BackgroundJobHalted { id: String, reason: String },
    /// A background job was cancelled.
    BackgroundJobCancelled { id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppEventBackpressure {
    MustDeliver,
    Coalescible,
    Droppable,
}

pub(crate) fn app_event_backpressure(event: &AppEvent) -> AppEventBackpressure {
    match event {
        AppEvent::ToolInputProgress { chars: 0, .. } => AppEventBackpressure::MustDeliver,
        AppEvent::ToolInputProgress { .. }
        | AppEvent::ToolInputPreview { .. }
        | AppEvent::MoaPlanProgress { .. }
        | AppEvent::BackgroundJobProgress { .. } => AppEventBackpressure::Droppable,
        AppEvent::AssistantDelta(_) | AppEvent::AssistantThinkingDelta(_) | AppEvent::FrameTick => {
            AppEventBackpressure::Coalescible
        }
        AppEvent::AssistantMessageStarted
        | AppEvent::ToolPathPreview { .. }
        | AppEvent::AssistantMessageDone
        | AppEvent::ToolUseStarted { .. }
        | AppEvent::ToolResult { .. }
        | AppEvent::PermissionRequest { .. }
        | AppEvent::UserQuestionRequest { .. }
        | AppEvent::Error(_)
        | AppEvent::Fatal(_)
        | AppEvent::SystemNotice(_)
        | AppEvent::ClipboardImageReady(_)
        | AppEvent::ClipboardImageFailed(_)
        | AppEvent::MoaReference { .. }
        | AppEvent::MoaAggregating { .. }
        | AppEvent::Terminal(_)
        | AppEvent::TurnStarted
        | AppEvent::TurnSteerApplied { .. }
        | AppEvent::TurnFinished
        | AppEvent::ManualCompactionFinished { .. }
        | AppEvent::ManualCompactionFailed { .. }
        | AppEvent::MoaPlanFinished { .. }
        | AppEvent::MoaPlanFailed { .. }
        | AppEvent::SideQuestionCompleted { .. }
        | AppEvent::SideQuestionFailed { .. }
        | AppEvent::HistoryChanged
        | AppEvent::TurnWakeRequested
        | AppEvent::BackgroundFollowupRequested { .. }
        | AppEvent::BackgroundJobStarted { .. }
        | AppEvent::BackgroundJobAssociated { .. }
        | AppEvent::BackgroundJobPromoted { .. }
        | AppEvent::SubagentSteerApplied { .. }
        | AppEvent::BackgroundJobReconciledRunning { .. }
        | AppEvent::BackgroundJobCompleted { .. }
        | AppEvent::BackgroundJobFailed { .. }
        | AppEvent::BackgroundJobPaused { .. }
        | AppEvent::BackgroundJobHalted { .. }
        | AppEvent::BackgroundJobCancelled { .. } => AppEventBackpressure::MustDeliver,
    }
}

#[derive(Clone)]
pub(crate) struct AppEventSender {
    tx: mpsc::Sender<AppEvent>,
}

impl AppEventSender {
    pub(crate) fn new(tx: mpsc::Sender<AppEvent>) -> Self {
        Self { tx }
    }

    pub(crate) fn send(&self, event: AppEvent) -> bool {
        match self.tx.try_send(event) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(event)) => self.handle_full(event),
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }

    pub(crate) async fn send_ordered(&self, event: AppEvent) -> bool {
        match app_event_backpressure(&event) {
            AppEventBackpressure::Droppable => self.send(event),
            AppEventBackpressure::MustDeliver | AppEventBackpressure::Coalescible => {
                self.tx.send(event).await.is_ok()
            }
        }
    }

    fn handle_full(&self, event: AppEvent) -> bool {
        match app_event_backpressure(&event) {
            AppEventBackpressure::Droppable => true,
            AppEventBackpressure::MustDeliver | AppEventBackpressure::Coalescible => {
                let tx = self.tx.clone();
                match tokio::runtime::Handle::try_current() {
                    Ok(handle) => {
                        handle.spawn(async move {
                            let _ = tx.send(event).await;
                        });
                        true
                    }
                    Err(_) => false,
                }
            }
        }
    }
}

pub(crate) const APP_EVENT_CHANNEL_CAPACITY: usize = 4096;
