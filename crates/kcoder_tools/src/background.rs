//! Shared background-job lifecycle helpers.

use crate::{BackgroundJobSpawner, ToolContext, ToolError, ToolOutput};
use kcoder_state::TaskStatus;
use std::sync::Arc;
use std::time::Duration;

/// Prefix used for background work spawned by shell-like tools.
///
/// These are user-visible background tasks, not sub-agents. The engine uses
/// this marker to avoid injecting `<subagent_notification .../>` messages for
/// command completions.
pub const TOOL_BACKGROUND_TASK_PREFIX: &str = "tool-background:";

pub fn tool_background_description(tool_name: &str, description: &str) -> String {
    let description = description.trim();
    let description = if description.is_empty() {
        "background command"
    } else {
        description
    };
    format!("{TOOL_BACKGROUND_TASK_PREFIX}{tool_name}: {description}")
}

pub fn is_tool_background_task_description(description: &str) -> bool {
    description.starts_with(TOOL_BACKGROUND_TASK_PREFIX)
}

pub fn tool_background_task_name(description: &str) -> Option<&str> {
    description
        .strip_prefix(TOOL_BACKGROUND_TASK_PREFIX)?
        .split_once(':')
        .map(|(name, _)| name.trim())
        .filter(|name| !name.is_empty())
}

/// Events emitted by the background job manager.
#[derive(Debug, Clone)]
pub enum BackgroundJobEvent {
    Scoped {
        identity: kcoder_types::BackgroundEventIdentity,
        event: Box<BackgroundJobEvent>,
    },
    /// A new background job was started.
    Started {
        id: String,
        description: String,
        /// True when this run reuses a completed sub-agent's public ID.
        continuation: bool,
    },
    /// Associates a managed sub-agent with the parent model tool call that
    /// created it. This lets presentation clients keep one stable row even
    /// when the run later moves from foreground to background delivery.
    Associated {
        id: String,
        tool_call_id: String,
        run_in_background: bool,
    },
    /// The same live foreground run was promoted to background delivery.
    Promoted { id: String },
    /// A running job published a bounded, user-safe progress update.
    ///
    /// `current` is the one-based current step when known. `total` is an
    /// upper bound (for sub-agents this is the configured maximum turn count),
    /// not a percentage or a promise that every step will be consumed.
    /// `message` must describe a lifecycle phase and must not contain raw
    /// model reasoning, tool input, or unbounded tool output. `detail` may
    /// contain only a bounded tail of user-visible assistant text; producers
    /// must never put hidden reasoning or raw tool payloads there.
    Progress {
        id: String,
        message: String,
        detail: Option<String>,
        current: Option<usize>,
        total: Option<usize>,
    },
    /// A targeted message was durably written to the sub-agent transcript and
    /// acknowledged from the reliable FIFO. This display-only event triggers neither a parent-model follow-up nor a Notification hook.
    SubagentSteerApplied {
        id: String,
        message_id: String,
        queue_depth: usize,
    },
    /// A background job finished successfully.
    Completed { id: String, output: ToolOutput },
    /// A background job failed.
    Failed { id: String, error: String },
    /// A sub-agent stopped at a complete Provider/tool boundary and remains resumable.
    Paused { id: String, reason: String },
    /// A sub-agent stopped gracefully at a complete boundary and is not resumable.
    Halted { id: String, reason: String },
    /// A background job was cancelled before completion.
    Cancelled { id: String, reason: String },
}

impl BackgroundJobEvent {
    pub fn payload(&self) -> &Self {
        match self {
            Self::Scoped { event, .. } => event.payload(),
            event => event,
        }
    }
    pub fn identity(&self) -> Option<&kcoder_types::BackgroundEventIdentity> {
        match self {
            Self::Scoped { identity, .. } => Some(identity),
            _ => None,
        }
    }
    pub fn into_payload(self) -> Self {
        match self {
            Self::Scoped { event, .. } => event.into_payload(),
            event => event,
        }
    }

    /// The job/agent ID this event refers to.
    pub fn id(&self) -> &str {
        match self {
            Self::Scoped { event, .. } => event.id(),
            Self::Started { id, .. }
            | Self::Associated { id, .. }
            | Self::Promoted { id }
            | Self::Progress { id, .. }
            | Self::SubagentSteerApplied { id, .. }
            | Self::Completed { id, .. }
            | Self::Failed { id, .. }
            | Self::Paused { id, .. }
            | Self::Halted { id, .. }
            | Self::Cancelled { id, .. } => id,
        }
    }

    /// Whether this event represents a terminal state.
    pub fn is_final(&self) -> bool {
        matches!(
            self.payload(),
            Self::Completed { .. }
                | Self::Failed { .. }
                | Self::Halted { .. }
                | Self::Cancelled { .. }
        )
    }
}

/// Result of keeping a managed task in the foreground for a bounded period.
pub enum ForegroundWaitOutcome {
    Completed(ToolOutput),
    TimedOut,
}

/// Keeps a managed foreground job alive while its tool call is waiting.
///
/// Dropping an armed guard means the foreground caller disappeared before it
/// could return a result, so the underlying task is cancelled. A timed-out
/// caller must explicitly promote the job before returning; promotion keeps
/// the same task and enables asynchronous completion delivery.
pub struct ManagedForegroundJob {
    manager: Arc<dyn BackgroundJobSpawner>,
    id: String,
    armed: bool,
}

impl ManagedForegroundJob {
    pub fn new(ctx: &ToolContext, id: impl Into<String>) -> Result<Self, ToolError> {
        let manager = ctx
            .background_job_manager
            .as_ref()
            .cloned()
            .ok_or_else(|| ToolError::Execution("background job manager not available".into()))?;
        Ok(Self {
            manager,
            id: id.into(),
            armed: true,
        })
    }

    pub fn complete(mut self) {
        self.manager.finish_foreground_delivery(&self.id);
        self.armed = false;
    }

    pub fn promote_to_background(mut self) -> Result<(), ToolError> {
        self.manager
            .promote_to_background(&self.id)
            .map_err(|error| {
                ToolError::Execution(format!(
                    "failed to move managed task `{}` to background delivery: {error}",
                    self.id
                ))
            })?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for ManagedForegroundJob {
    fn drop(&mut self) {
        if self.armed {
            self.manager.abort(&self.id);
        }
    }
}

/// Wait for one managed task without owning its future.
///
/// The future can therefore time out without cancelling the work. Callers use
/// [`ManagedForegroundJob::promote_to_background`] after `TimedOut`, then
/// return the task ID for `TaskOutput` / `TaskStop`.
pub async fn wait_with_foreground_budget(
    ctx: &ToolContext,
    id: &str,
    mut events: tokio::sync::broadcast::Receiver<BackgroundJobEvent>,
    budget: Duration,
) -> Result<ForegroundWaitOutcome, ToolError> {
    let run = ctx.state.task(id).and_then(|task| task.background_run);
    let deadline = tokio::time::sleep(budget);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => return Ok(ForegroundWaitOutcome::TimedOut),
            _ = ctx.cancelled() => return Err(ToolError::Aborted),
            event = events.recv() => {
                if let Ok(event) = &event
                    && let Some(run) = &run
                    && event.identity().map(|identity| &identity.run) != Some(run)
                {
                    continue;
                }
                match event.map(BackgroundJobEvent::into_payload) {
                Ok(BackgroundJobEvent::Started { .. }) => {}
                Ok(BackgroundJobEvent::Completed { id: event_id, output }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(output));
                }
                Ok(BackgroundJobEvent::Failed { id: event_id, error }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(error)));
                }
                Ok(BackgroundJobEvent::Paused { id: event_id, reason }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(reason)));
                }
                Ok(BackgroundJobEvent::Halted { id: event_id, reason }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(reason)));
                }
                Ok(BackgroundJobEvent::Cancelled { id: event_id, reason }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(reason)));
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(output) = terminal_output_from_state(ctx, id, run.as_ref()) {
                        return Ok(ForegroundWaitOutcome::Completed(output));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    if let Some(output) = terminal_output_from_state(ctx, id, run.as_ref()) {
                        return Ok(ForegroundWaitOutcome::Completed(output));
                    }
                    return Err(ToolError::Execution(
                        "background event channel closed before task completion".to_string(),
                    ));
                }
                }
            }
        }
    }
}

/// Wait for a managed foreground task until it completes or the user aborts
/// the current turn. Sub-agents use this for the default zero foreground
/// budget; callers opt into bounded waiting and promotion with a positive
/// budget.
pub async fn wait_for_foreground_completion(
    ctx: &ToolContext,
    id: &str,
    mut events: tokio::sync::broadcast::Receiver<BackgroundJobEvent>,
) -> Result<ForegroundWaitOutcome, ToolError> {
    let run = ctx.state.task(id).and_then(|task| task.background_run);
    loop {
        tokio::select! {
            _ = ctx.cancelled() => return Err(ToolError::Aborted),
            event = events.recv() => {
                if let Ok(event) = &event
                    && let Some(run) = &run
                    && event.identity().map(|identity| &identity.run) != Some(run)
                {
                    continue;
                }
                match event.map(BackgroundJobEvent::into_payload) {
                Ok(BackgroundJobEvent::Started { .. }) => {}
                Ok(BackgroundJobEvent::Completed { id: event_id, output }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(output));
                }
                Ok(BackgroundJobEvent::Failed { id: event_id, error }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(error)));
                }
                Ok(BackgroundJobEvent::Paused { id: event_id, reason }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(reason)));
                }
                Ok(BackgroundJobEvent::Halted { id: event_id, reason }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(reason)));
                }
                Ok(BackgroundJobEvent::Cancelled { id: event_id, reason }) if event_id == id => {
                    return Ok(ForegroundWaitOutcome::Completed(ToolOutput::error(reason)));
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(output) = terminal_output_from_state(ctx, id, run.as_ref()) {
                        return Ok(ForegroundWaitOutcome::Completed(output));
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    if let Some(output) = terminal_output_from_state(ctx, id, run.as_ref()) {
                        return Ok(ForegroundWaitOutcome::Completed(output));
                    }
                    return Err(ToolError::Execution(
                        "background event channel closed before task completion".to_string(),
                    ));
                }
                }
            }
        }
    }
}

fn terminal_output_from_state(
    ctx: &ToolContext,
    id: &str,
    run: Option<&kcoder_types::BackgroundRunKey>,
) -> Option<ToolOutput> {
    let task = if let Some(run) = run {
        ctx.state.task_for_background_run(run)?
    } else {
        ctx.state.task(id)?
    };
    match task.status {
        TaskStatus::Completed => Some(ToolOutput::text(task.output.unwrap_or_default())),
        TaskStatus::Failed | TaskStatus::Cancelled => Some(ToolOutput::error(
            task.output
                .unwrap_or_else(|| "background task failed".to_string()),
        )),
        TaskStatus::Paused => Some(ToolOutput::error("sub-agent paused")),
        TaskStatus::Halted => Some(ToolOutput::error("sub-agent halted")),
        TaskStatus::Pending | TaskStatus::Running => None,
    }
}

#[cfg(test)]
mod tests {
    use super::BackgroundJobEvent;

    #[tokio::test]
    async fn foreground_waits_unwrap_scoped_events_and_reject_other_runs() {
        for bounded in [false, true] {
            let state = kcoder_state::AppState::new("/tmp");
            state.upsert_task(kcoder_state::Task::new("job", "foreground"));
            let run = state.begin_background_run("job").unwrap();
            let ctx = crate::ToolContext::new(state);
            let (tx, rx) = tokio::sync::broadcast::channel(4);
            let mut old_run = run.clone();
            old_run.run_id = "old-run".into();
            for (key, text) in [(old_run, "wrong old output"), (run, "current output")] {
                tx.send(BackgroundJobEvent::Scoped {
                    identity: kcoder_types::BackgroundEventIdentity::terminal(key),
                    event: Box::new(BackgroundJobEvent::Completed {
                        id: "job".into(),
                        output: crate::ToolOutput::text(text),
                    }),
                })
                .unwrap();
            }
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                if bounded {
                    super::wait_with_foreground_budget(
                        &ctx,
                        "job",
                        rx,
                        std::time::Duration::from_secs(1),
                    )
                    .await
                } else {
                    super::wait_for_foreground_completion(&ctx, "job", rx).await
                }
            })
            .await
            .expect("scoped completion must wake the foreground waiter")
            .unwrap();
            let super::ForegroundWaitOutcome::Completed(output) = outcome else {
                panic!("unexpected timeout")
            };
            assert!(
                matches!(&output.content[0], kcoder_types::ContentBlock::Text { text } if text == "current output")
            );
        }
    }

    #[test]
    fn cancelled_event_is_terminal_and_retains_its_id() {
        let event = BackgroundJobEvent::Cancelled {
            id: "cancelled-job".to_string(),
            reason: "stopped".to_string(),
        };

        assert_eq!(event.id(), "cancelled-job");
        assert!(event.is_final());
    }

    #[test]
    fn progress_event_is_non_terminal_and_retains_its_id() {
        let event = BackgroundJobEvent::Progress {
            id: "running-job".to_string(),
            message: "Running bash".to_string(),
            detail: None,
            current: Some(3),
            total: Some(60),
        };

        assert_eq!(event.id(), "running-job");
        assert!(!event.is_final());
    }

    #[test]
    fn association_and_promotion_events_are_non_terminal() {
        let associated = BackgroundJobEvent::Associated {
            id: "agent-1".to_string(),
            tool_call_id: "tool-1".to_string(),
            run_in_background: false,
        };
        let promoted = BackgroundJobEvent::Promoted {
            id: "agent-1".to_string(),
        };

        assert_eq!(associated.id(), "agent-1");
        assert!(!associated.is_final());
        assert_eq!(promoted.id(), "agent-1");
        assert!(!promoted.is_final());
    }
}
