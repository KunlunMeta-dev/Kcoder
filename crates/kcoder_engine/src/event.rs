use crate::context::CompactionFailureDetails;
use crate::{BackgroundJobEvent, WriteInputPreview};
use kcoder_tools::ToolOutput;
use serde::Serialize;

/// Structured retry diagnostic for transient provider errors; fields contain no request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderRetryDetails {
    pub request_kind: String,
    pub provider: String,
    pub model: String,
    pub attempt: usize,
    pub max_retries: usize,
    pub elapsed_ms: u64,
    pub turn_elapsed_ms: u64,
    pub transport_elapsed_ms: u64,
    pub retry_after_ms: u64,
    pub first_token_ms: Option<u64>,
    pub last_token_ms: Option<u64>,
    pub timeout_kind: Option<String>,
    pub reason: String,
}

impl ProviderRetryDetails {
    pub fn notice_text(&self) -> String {
        let timeout = self
            .timeout_kind
            .as_deref()
            .map(|kind| format!("; timeout={kind}"))
            .unwrap_or_default();
        format!(
            "Provider {} request failed for {} model {} ({}{}); retrying {}/{} after {}ms...",
            self.request_kind,
            self.provider,
            self.model,
            self.reason,
            timeout,
            self.attempt,
            self.max_retries,
            self.retry_after_ms,
        )
    }
}

/// Events emitted by the query engine during a turn.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    /// User message was added to history.
    UserMessageAdded,
    /// New input submitted during a regular turn reached a safe model boundary and entered that same turn.
    TurnSteerApplied { id: u64 },
    /// A targeted sub-agent message was written to its transcript checkpoint and acknowledged from the reliable FIFO.
    SubagentSteerApplied {
        agent_id: String,
        message_id: String,
        queue_depth: usize,
    },
    /// The assistant started a new message (may happen multiple times in an
    /// agent loop after tool calls).
    AssistantMessageStarted,
    /// Assistant text delta arrived.
    AssistantTextDelta(String),
    /// Assistant thinking delta arrived.
    AssistantThinkingDelta(String),
    /// Retire transient parameter-generation indicators before a new provider attempt.
    ToolInputReset,
    /// Assistant is still streaming JSON input for a tool call. Only the tool
    /// use id, tool name and accumulated character count are exposed so large or sensitive
    /// arguments never need to pass through the UI event queue.
    ToolInputProgress {
        id: String,
        name: String,
        chars: usize,
    },
    /// Bounded live content preview for the built-in `write` tool.
    ToolInputPreview {
        id: String,
        preview: WriteInputPreview,
    },
    /// Untrusted, temporary path hint scoped to one provider invocation; None retracts it.
    /// Consumers must also clear temporary state when a turn ends or its stream is dropped.
    ToolPathPreview {
        attempt_id: String,
        id: String,
        path: Option<String>,
    },
    /// Assistant finished its message.
    AssistantMessageDone,
    /// Assistant requested to use a tool.
    ToolUseStarted {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Tool was denied by permission engine.
    ToolDenied {
        id: String,
        name: String,
        reason: String,
    },
    /// Tool produced output.
    ToolResult {
        id: String,
        name: String,
        output: ToolOutput,
    },
    /// One MoA reference model finished and produced visible advisory text.
    MoaReference {
        label: String,
        text: String,
        index: usize,
        count: usize,
    },
    /// MoA reference collection finished and the aggregator is synthesizing the
    /// private guidance that will be appended to the acting model request.
    MoaAggregating { aggregator: String },
    /// Informational notice for the user (e.g. auto-retry).
    SystemNotice(String),
    /// A provider request failed transiently and is waiting for backoff before retry.
    ProviderRetry(ProviderRetryDetails),
    /// An error occurred.
    Error(String),
    /// Terminal provider failure; consumers must not infer recovery from its message.
    ProviderFailed {
        message: String,
        details: kcoder_types::ProviderFailureDetails,
    },
    /// The maximum number of agent turns was reached.
    MaxTurnsReached { max_turns: usize, turn_count: usize },
    /// The stream was aborted (timeout or cancellation).
    StreamAborted { reason: String },
    /// Context compaction failed.
    CompactionFailed {
        error: String,
        details: Option<CompactionFailureDetails>,
    },
    /// A compaction-protocol response was invalid, but repair retry succeeded and the final compaction result is valid.
    CompactionRecovered { details: CompactionFailureDetails },
    /// Message produced by a lifecycle hook.
    HookMessage { text: String, is_error: bool },
    /// A background job was started by a tool.
    BackgroundJobStarted { id: String, description: String },
    /// A sub-agent was bound to its parent provider tool call.
    BackgroundJobAssociated {
        id: String,
        tool_call_id: String,
        run_in_background: bool,
    },
    /// A foreground sub-agent kept the same run ID and moved to background delivery.
    BackgroundJobPromoted { id: String },
    /// Presentation-only progress from a running background job.
    BackgroundJobProgress {
        id: String,
        message: String,
        detail: Option<String>,
        current: Option<usize>,
        total: Option<usize>,
    },
    /// A background job finished successfully.
    BackgroundJobCompleted { id: String, output: ToolOutput },
    /// A background job failed.
    BackgroundJobFailed { id: String, error: String },
    /// A sub-agent paused at a safe boundary and remains resumable.
    BackgroundJobPaused { id: String, reason: String },
    /// A sub-agent halted gracefully at a safe boundary.
    BackgroundJobHalted { id: String, reason: String },
    /// A background job was cancelled.
    BackgroundJobCancelled { id: String, reason: String },
}

impl From<BackgroundJobEvent> for EngineEvent {
    fn from(event: BackgroundJobEvent) -> Self {
        match event {
            BackgroundJobEvent::Started {
                id, description, ..
            } => EngineEvent::BackgroundJobStarted { id, description },
            BackgroundJobEvent::Associated {
                id,
                tool_call_id,
                run_in_background,
            } => EngineEvent::BackgroundJobAssociated {
                id,
                tool_call_id,
                run_in_background,
            },
            BackgroundJobEvent::Promoted { id } => EngineEvent::BackgroundJobPromoted { id },
            BackgroundJobEvent::Progress {
                id,
                message,
                detail,
                current,
                total,
            } => EngineEvent::BackgroundJobProgress {
                id,
                message,
                detail,
                current,
                total,
            },
            BackgroundJobEvent::SubagentSteerApplied {
                id,
                message_id,
                queue_depth,
            } => EngineEvent::SubagentSteerApplied {
                agent_id: id,
                message_id,
                queue_depth,
            },
            BackgroundJobEvent::Completed { id, output } => {
                EngineEvent::BackgroundJobCompleted { id, output }
            }
            BackgroundJobEvent::Failed { id, error } => {
                EngineEvent::BackgroundJobFailed { id, error }
            }
            BackgroundJobEvent::Paused { id, reason } => {
                EngineEvent::BackgroundJobPaused { id, reason }
            }
            BackgroundJobEvent::Halted { id, reason } => {
                EngineEvent::BackgroundJobHalted { id, reason }
            }
            BackgroundJobEvent::Cancelled { id, reason } => {
                EngineEvent::BackgroundJobCancelled { id, reason }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_started_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Started {
            id: "job-1".into(),
            description: "work".into(),
            continuation: true,
        });
        assert!(
            matches!(event, EngineEvent::BackgroundJobStarted { id, description } if id == "job-1" && description == "work")
        );
    }

    #[test]
    fn converts_associated_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Associated {
            id: "job-1".into(),
            tool_call_id: "tool-1".into(),
            run_in_background: true,
        });
        assert!(
            matches!(event, EngineEvent::BackgroundJobAssociated { id, tool_call_id, run_in_background } if id == "job-1" && tool_call_id == "tool-1" && run_in_background)
        );
    }

    #[test]
    fn converts_promoted_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Promoted { id: "job-1".into() });
        assert!(matches!(event, EngineEvent::BackgroundJobPromoted { id } if id == "job-1"));
    }

    #[test]
    fn converts_progress_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Progress {
            id: "job-1".into(),
            message: "running".into(),
            detail: Some("detail".into()),
            current: Some(2),
            total: Some(3),
        });
        assert!(
            matches!(event, EngineEvent::BackgroundJobProgress { id, message, detail, current, total } if id == "job-1" && message == "running" && detail.as_deref() == Some("detail") && current == Some(2) && total == Some(3))
        );
    }

    #[test]
    fn converts_subagent_steer_applied_event_without_terminal_semantics() {
        let event = BackgroundJobEvent::SubagentSteerApplied {
            id: "agent-1".into(),
            message_id: "msg-1".into(),
            queue_depth: 2,
        };
        assert!(!event.is_final());
        let event = EngineEvent::from(event);
        assert!(matches!(
            event,
            EngineEvent::SubagentSteerApplied {
                agent_id,
                message_id,
                queue_depth: 2,
            } if agent_id == "agent-1" && message_id == "msg-1"
        ));
    }

    #[test]
    fn converts_completed_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Completed {
            id: "job-1".into(),
            output: ToolOutput::text("done"),
        });
        assert!(
            matches!(event, EngineEvent::BackgroundJobCompleted { id, output } if id == "job-1" && !output.is_error)
        );
    }

    #[test]
    fn converts_failed_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Failed {
            id: "job-1".into(),
            error: "boom".into(),
        });
        assert!(
            matches!(event, EngineEvent::BackgroundJobFailed { id, error } if id == "job-1" && error == "boom")
        );
    }

    #[test]
    fn converts_cancelled_background_job_event() {
        let event = EngineEvent::from(BackgroundJobEvent::Cancelled {
            id: "job-1".into(),
            reason: "cancelled".into(),
        });
        assert!(
            matches!(event, EngineEvent::BackgroundJobCancelled { id, reason } if id == "job-1" && reason == "cancelled")
        );
    }
}
