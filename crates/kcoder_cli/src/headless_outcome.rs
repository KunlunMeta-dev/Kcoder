use kcoder_engine::{EngineEvent, QueryEngine};
use kcoder_state::{GoalStatus, TaskStatus, TodoStatus};
use kcoder_types::ContentBlock;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunStatus {
    Completed,
    Failed,
    Cancelled,
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskOutcomeStatus {
    Completed,
    Blocked,
    Partial,
    TimedOut,
    Failed,
    Cancelled,
}

impl TaskOutcomeStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Blocked => "blocked",
            Self::Partial => "partial",
            Self::TimedOut => "timed_out",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct HeadlessOutcome {
    run_status: RunStatus,
    task_status: TaskOutcomeStatus,
    termination_reason: &'static str,
    error: Option<String>,
    provider_failure: Option<kcoder_types::ProviderFailureDetails>,
    last_tool_error: Option<String>,
    last_permission_denial: Option<String>,
    last_compaction_failure: Option<Value>,
    work_remaining: Vec<String>,
    nudge_sent: bool,
    deliverable_written: bool,
    provider_retry_count: usize,
    retry_after_ms: Option<u64>,
    retryable: bool,
    resume_safe: bool,
}

impl Default for HeadlessOutcome {
    fn default() -> Self {
        Self {
            run_status: RunStatus::Completed,
            task_status: TaskOutcomeStatus::Completed,
            termination_reason: "completed",
            error: None,
            provider_failure: None,
            last_tool_error: None,
            last_permission_denial: None,
            last_compaction_failure: None,
            work_remaining: Vec::new(),
            nudge_sent: false,
            deliverable_written: false,
            provider_retry_count: 0,
            retry_after_ms: None,
            retryable: false,
            resume_safe: false,
        }
    }
}

impl HeadlessOutcome {
    pub(super) fn observe_event(&mut self, event: &EngineEvent) {
        match event {
            EngineEvent::ProviderFailed { message, details } => {
                self.run_status = RunStatus::Failed;
                self.task_status = TaskOutcomeStatus::Failed;
                self.termination_reason = "provider_failure";
                self.error = Some(format!("error: {message}"));
                self.retryable = details.retryable;
                self.resume_safe = details.resume_safe;
                self.retry_after_ms = details.retry_after_ms;
                self.provider_failure = Some(details.clone());
            }
            EngineEvent::Error(error) => {
                if self.provider_failure.take().is_some() {
                    self.retry_after_ms = None;
                }
                self.run_status = RunStatus::Failed;
                self.task_status = TaskOutcomeStatus::Failed;
                self.termination_reason = "engine_error";
                self.error = Some(format!("error: {error}"));
                self.retryable = is_retryable_failure(error);
                self.resume_safe = self.retryable;
                if self.retryable && self.retry_after_ms.is_none() {
                    self.retry_after_ms = recommended_retry_after_ms(error);
                }
            }
            EngineEvent::StreamAborted { reason } => self.observe_stream_abort(reason),
            EngineEvent::MaxTurnsReached {
                max_turns,
                turn_count,
            } => {
                self.mark_partial(
                    "max_turns",
                    format!("max_turns_reached: turn {turn_count} exceeded limit {max_turns}"),
                );
            }
            EngineEvent::ToolDenied { name, reason, .. } => {
                self.last_permission_denial = Some(format!("{name}: {reason}"));
                self.last_tool_error = self.last_permission_denial.clone();
            }
            EngineEvent::ToolResult { name, output, .. } => {
                if output.is_error {
                    let text = tool_output_text(&output.content);
                    let summary = if text.trim().is_empty() {
                        format!("{name}: tool failed")
                    } else {
                        format!("{name}: {}", truncate_chars(text.trim(), 500))
                    };
                    if text.to_ascii_lowercase().contains("permission denied") {
                        self.last_permission_denial = Some(summary.clone());
                    }
                    self.last_tool_error = Some(summary);
                } else {
                    if matches!(name.as_str(), "write" | "edit" | "apply_patch") {
                        self.deliverable_written = true;
                    }
                    self.last_tool_error = None;
                    self.last_permission_denial = None;
                }
            }
            EngineEvent::CompactionFailed { error, details } => {
                let mut failure = serde_json::json!({"error": error});
                if let (Some(details), Some(failure)) = (details, failure.as_object_mut())
                    && let Ok(Value::Object(fields)) = serde_json::to_value(details)
                {
                    failure.extend(fields);
                }
                self.last_compaction_failure = Some(failure);
            }
            EngineEvent::SystemNotice(text) if text.contains("wrap-up nudge") => {
                self.nudge_sent = true;
            }
            EngineEvent::ProviderRetry(details) => {
                self.provider_retry_count = self.provider_retry_count.saturating_add(1);
                if self.provider_failure.is_none() {
                    self.retry_after_ms = Some(details.retry_after_ms);
                }
            }
            _ => {}
        }
    }

    fn observe_stream_abort(&mut self, reason: &str) {
        self.provider_failure = None;
        self.retry_after_ms = None;
        self.retryable = false;
        let normalized = reason.trim().to_ascii_lowercase();
        if normalized == "cancelled by user" {
            self.run_status = RunStatus::Cancelled;
            self.task_status = TaskOutcomeStatus::Cancelled;
            self.termination_reason = "user_cancelled";
            self.error = Some("cancelled by user".to_string());
            self.resume_safe = true;
        } else if normalized == "max_duration" || normalized.contains("max-duration") {
            self.run_status = RunStatus::Completed;
            self.task_status = TaskOutcomeStatus::TimedOut;
            self.termination_reason = "max_duration";
            self.error = Some("task reached its max-duration deadline".to_string());
            self.resume_safe = true;
        } else if normalized == "goal_auto_continuation_limit" {
            self.mark_partial(
                "goal_auto_continuation_limit",
                "goal remains active after reaching the auto-continuation limit".to_string(),
            );
        } else if let Some(capability) = normalized.strip_prefix("permission_denial_limit:") {
            self.mark_blocked(
                "permission_denial_limit",
                format!("required capability remained denied in unattended mode: {capability}"),
            );
        } else if normalized.contains("doom loop") {
            self.mark_partial("doom_loop", format!("stream_aborted: {reason}"));
        } else {
            self.run_status = RunStatus::Failed;
            self.task_status = TaskOutcomeStatus::Failed;
            self.termination_reason = "stream_aborted";
            self.error = Some(format!("stream_aborted: {reason}"));
            self.retryable = is_retryable_failure(reason);
            self.resume_safe = self.retryable;
        }
    }

    fn mark_partial(&mut self, reason: &'static str, error: String) {
        if matches!(
            self.task_status,
            TaskOutcomeStatus::Failed | TaskOutcomeStatus::Cancelled | TaskOutcomeStatus::TimedOut
        ) {
            return;
        }
        self.run_status = RunStatus::Completed;
        self.task_status = TaskOutcomeStatus::Partial;
        self.termination_reason = reason;
        self.error = Some(error);
        self.resume_safe = true;
    }

    fn mark_blocked(&mut self, reason: &'static str, error: String) {
        if matches!(
            self.task_status,
            TaskOutcomeStatus::Failed | TaskOutcomeStatus::Cancelled | TaskOutcomeStatus::TimedOut
        ) {
            return;
        }
        self.run_status = RunStatus::Completed;
        self.task_status = TaskOutcomeStatus::Blocked;
        self.termination_reason = reason;
        self.error = Some(error);
        self.resume_safe = true;
    }

    pub(super) fn finalize(&mut self, engine: &QueryEngine) {
        let goal_status = engine.state.goal().map(|goal| goal.status);
        let final_text =
            kcoder_engine::goal_continuation::latest_assistant_text(&engine.state.messages());
        let mut work_remaining = engine
            .state
            .todos()
            .into_iter()
            .filter(|todo| matches!(todo.status, TodoStatus::Pending | TodoStatus::InProgress))
            .map(|todo| todo.content)
            .collect::<Vec<_>>();
        work_remaining.extend(
            engine
                .state
                .tasks()
                .into_values()
                .filter(|task| matches!(task.status, TaskStatus::Pending | TaskStatus::Running))
                .map(|task| task.description),
        );
        self.finalize_signals(goal_status, final_text.as_deref(), work_remaining);
    }

    fn finalize_signals(
        &mut self,
        goal_status: Option<GoalStatus>,
        final_text: Option<&str>,
        mut work_remaining: Vec<String>,
    ) {
        work_remaining.sort();
        work_remaining.dedup();
        self.work_remaining = work_remaining;

        if matches!(
            self.task_status,
            TaskOutcomeStatus::Failed
                | TaskOutcomeStatus::Cancelled
                | TaskOutcomeStatus::TimedOut
                | TaskOutcomeStatus::Blocked
        ) {
            return;
        }

        if goal_status == Some(GoalStatus::Complete) {
            self.run_status = RunStatus::Completed;
            self.task_status = TaskOutcomeStatus::Completed;
            self.termination_reason = "goal_completed";
            self.error = None;
            self.resume_safe = false;
            return;
        }

        match goal_status {
            Some(GoalStatus::Blocked) => {
                self.mark_blocked("goal_blocked", "goal is blocked".to_string())
            }
            Some(GoalStatus::Active | GoalStatus::Paused) => {
                self.mark_partial("goal_unfinished", "goal remains unfinished".to_string())
            }
            Some(GoalStatus::BudgetLimited) => self.mark_partial(
                "goal_budget_limited",
                "goal stopped at its token budget".to_string(),
            ),
            Some(GoalStatus::UsageLimited) => self.mark_partial(
                "goal_usage_limited",
                "goal stopped at its usage limit".to_string(),
            ),
            Some(GoalStatus::Complete) | None => {}
        }

        match final_text.and_then(declared_task_status) {
            Some(TaskOutcomeStatus::Blocked) => self.mark_blocked(
                "assistant_declared_blocked",
                "assistant declared the task blocked".to_string(),
            ),
            Some(TaskOutcomeStatus::Partial) => self.mark_partial(
                "assistant_declared_partial",
                "assistant declared the task incomplete".to_string(),
            ),
            _ => {}
        }

        if let Some(denial) = self.last_permission_denial.clone() {
            self.mark_blocked("permission_denied", denial);
        } else if let Some(tool_error) = self.last_tool_error.clone() {
            self.mark_partial("last_tool_error", tool_error);
        } else if !self.work_remaining.is_empty() {
            self.mark_partial(
                "work_remaining",
                "tracked work remains incomplete".to_string(),
            );
        }
    }

    pub(super) fn with_output_failure(&self) -> Self {
        let mut outcome = self.clone();
        outcome.run_status = RunStatus::Failed;
        outcome.task_status = TaskOutcomeStatus::Failed;
        outcome.termination_reason = "headless_output_error";
        outcome.error = Some("failed to write headless output".to_string());
        outcome.provider_failure = None;
        outcome.retry_after_ms = None;
        outcome.retryable = false;
        outcome.resume_safe = false;
        outcome
    }

    pub(super) fn is_success(&self) -> bool {
        self.run_status == RunStatus::Completed && self.task_status == TaskOutcomeStatus::Completed
    }

    pub(super) fn error_message(&self) -> String {
        self.error.clone().unwrap_or_else(|| {
            format!(
                "task ended with status {} ({})",
                self.task_status.as_str(),
                self.termination_reason
            )
        })
    }

    pub(super) fn hook_exit_reason(&self) -> String {
        if self.is_success() {
            "success".to_string()
        } else {
            format!("{}:{}", self.task_status.as_str(), self.termination_reason)
        }
    }

    pub(super) fn to_json(&self, session_id: String) -> Value {
        let retry_after_ms = (!self.is_success())
            .then_some(self.retry_after_ms)
            .flatten();
        let mut event = serde_json::json!({
            "type": "result",
            "subtype": if self.is_success() { "success" } else { "error" },
            "run_status": self.run_status.as_str(),
            "task_status": self.task_status.as_str(),
            "termination_reason": self.termination_reason,
            "session_id": session_id,
            "timed_out": self.task_status == TaskOutcomeStatus::TimedOut,
            "retryable": self.retryable,
            "provider_failure": self.provider_failure,
            "resume_safe": self.resume_safe,
            "nudge_sent": self.nudge_sent,
            "deliverable_written": self.deliverable_written,
            "provider_retry_count": self.provider_retry_count,
            "retry_after_ms": retry_after_ms,
            "work_remaining": self.work_remaining,
        });
        if let Some(error) = &self.error {
            event["error"] = Value::String(error.clone());
        }
        if let Some(failure) = &self.last_compaction_failure {
            event["last_compaction_failure"] = failure.clone();
        }
        event
    }
}

fn tool_output_text(content: &[ContentBlock]) -> String {
    content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn declared_task_status(text: &str) -> Option<TaskOutcomeStatus> {
    for raw_line in text.lines().filter(|line| !line.trim().is_empty()) {
        let line = raw_line
            .trim()
            .trim_start_matches(['#', '>', '-', ' '])
            .replace(['*', '`'], "")
            .trim()
            .to_ascii_lowercase();
        if matches_status_line(&line, "blocked")
            || matches_status_line(&line, "status: blocked")
            || matches_status_line(&line, "status：blocked")
            || matches_status_line(&line, "task status: blocked")
            || matches_status_line(&line, "task_status: blocked")
            || matches_status_line(&line, "阻塞")
            || matches_status_line(&line, "状态：阻塞")
            || matches_status_line(&line, "任务状态：阻塞")
        {
            return Some(TaskOutcomeStatus::Blocked);
        }
        if matches_status_line(&line, "partial")
            || matches_status_line(&line, "incomplete")
            || matches_status_line(&line, "status: partial")
            || matches_status_line(&line, "status: incomplete")
            || matches_status_line(&line, "部分完成")
            || matches_status_line(&line, "未完成")
            || matches_status_line(&line, "状态：部分完成")
        {
            return Some(TaskOutcomeStatus::Partial);
        }
    }
    None
}

fn matches_status_line(line: &str, marker: &str) -> bool {
    let Some(rest) = line.strip_prefix(marker) else {
        return false;
    };
    rest.is_empty()
        || rest.starts_with(':')
        || rest.starts_with('：')
        || rest.starts_with(" -")
        || rest.starts_with(" —")
        || rest.starts_with(" –")
}

pub(super) fn is_retryable_failure(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "stream idle",
        "timeout",
        "timed out",
        "rate limit",
        "overload",
        "429",
        "529",
        "500",
        "502",
        "503",
        "504",
        "connection",
        "network",
        "temporarily",
        "unavailable",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

pub(super) fn recommended_retry_after_ms(error: &str) -> Option<u64> {
    if !is_retryable_failure(error) {
        return None;
    }
    let lower = error.to_ascii_lowercase();
    if lower.contains("429") || lower.contains("rate limit") || lower.contains("too many requests")
    {
        Some(30_000)
    } else if lower.contains("529") || lower.contains("overload") {
        Some(5_000)
    } else {
        Some(1_000)
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_tools::ToolOutput;

    #[test]
    fn provider_failure_json_and_outcome_preserve_typed_facts() {
        for (category, retryable, partial) in [
            (
                kcoder_types::ProviderFailureCategory::InvalidParameter,
                false,
                false,
            ),
            (
                kcoder_types::ProviderFailureCategory::AuthenticationError,
                false,
                false,
            ),
            (
                kcoder_types::ProviderFailureCategory::ProviderError,
                true,
                false,
            ),
            (kcoder_types::ProviderFailureCategory::RateLimit, true, true),
            (
                kcoder_types::ProviderFailureCategory::TimeoutError,
                true,
                false,
            ),
            (
                kcoder_types::ProviderFailureCategory::TimeoutError,
                true,
                true,
            ),
        ] {
            let details = kcoder_types::ProviderFailureDetails {
                category,
                recovery_action: if retryable {
                    kcoder_types::ProviderFailureRecoveryAction::DiagnoseOnly
                } else {
                    kcoder_types::ProviderFailureRecoveryAction::NeedsHuman
                },
                http_status: if category == kcoder_types::ProviderFailureCategory::TimeoutError {
                    None
                } else {
                    Some(if retryable { 503 } else { 400 })
                },
                retryable,
                resume_safe: retryable && !partial,
                retry_after_ms: retryable.then_some(50),
            };
            let event = EngineEvent::ProviderFailed {
                message: "request-parameter error, not a network failure; timeout 429".into(),
                details: details.clone(),
            };
            let mut outcome = HeadlessOutcome::default();
            outcome.observe_event(&event);
            let wire = crate::headless::engine_event_json(event);
            let result = outcome.to_json("session".into());
            assert!(!outcome.is_success());
            assert_eq!(wire["type"], "error");
            assert_eq!(result["run_status"], "failed");
            for field in [
                "provider_failure",
                "retryable",
                "resume_safe",
                "retry_after_ms",
            ] {
                assert_eq!(wire[field], result[field], "{field}");
            }
            assert_eq!(
                wire["provider_failure"],
                serde_json::to_value(details).unwrap()
            );
            assert_eq!(wire["retryable"], retryable);
            assert_eq!(wire["resume_safe"], retryable && !partial);
            let mut cancelled = outcome.clone();
            cancelled.observe_event(&EngineEvent::StreamAborted {
                reason: "cancelled by user".into(),
            });
            let cancelled = cancelled.to_json("session".into());
            assert!(cancelled["provider_failure"].is_null());
            assert!(!cancelled["retryable"].as_bool().unwrap());
            assert!(cancelled["retry_after_ms"].is_null());
            outcome.observe_event(&EngineEvent::Error("different failure".into()));
            let replaced = outcome.to_json("session".into());
            assert!(replaced["provider_failure"].is_null());
            assert!(replaced["retry_after_ms"].is_null());
        }
    }

    #[test]
    fn timeout_has_clean_run_but_unsuccessful_task_status() {
        let mut outcome = HeadlessOutcome::default();
        outcome.observe_event(&EngineEvent::StreamAborted {
            reason: "max_duration".to_string(),
        });

        let event = outcome.to_json("session-timeout".to_string());
        assert_eq!(event["subtype"], "error");
        assert_eq!(event["run_status"], "completed");
        assert_eq!(event["task_status"], "timed_out");
        assert_eq!(event["termination_reason"], "max_duration");
        assert_eq!(event["timed_out"], true);
        assert_eq!(event["resume_safe"], true);
        assert!(!outcome.is_success());
    }

    #[test]
    fn permission_denial_and_blocked_declaration_are_blocked() {
        let mut outcome = HeadlessOutcome::default();
        outcome.observe_event(&EngineEvent::ToolDenied {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            reason: "permission denied".to_string(),
        });
        outcome.finalize_signals(None, Some("**BLOCKED** — npm test cannot run"), Vec::new());

        let event = outcome.to_json("session-blocked".to_string());
        assert_eq!(event["task_status"], "blocked");
        assert_eq!(event["termination_reason"], "permission_denied");
        assert_eq!(event["run_status"], "completed");
    }

    #[test]
    fn permission_denial_limit_is_a_stable_blocked_terminal_reason() {
        let mut outcome = HeadlessOutcome::default();
        outcome.observe_event(&EngineEvent::ToolDenied {
            id: "tool-1".to_string(),
            name: "bash".to_string(),
            reason: "permission denied".to_string(),
        });
        outcome.observe_event(&EngineEvent::StreamAborted {
            reason: "permission_denial_limit:shell_execute".to_string(),
        });
        outcome.finalize_signals(None, Some("BLOCKED: missing shell capability"), Vec::new());

        let event = outcome.to_json("session-denied".to_string());
        assert_eq!(event["task_status"], "blocked");
        assert_eq!(event["termination_reason"], "permission_denial_limit");
        assert_eq!(event["run_status"], "completed");
        assert_eq!(event["resume_safe"], true);
    }

    #[test]
    fn last_failed_tool_and_unfinished_goal_are_partial() {
        let mut outcome = HeadlessOutcome::default();
        outcome.observe_event(&EngineEvent::ToolResult {
            id: "tool-2".to_string(),
            name: "test".to_string(),
            output: ToolOutput::error("one regression remains"),
        });
        outcome.finalize_signals(
            Some(GoalStatus::Active),
            Some("Current progress"),
            Vec::new(),
        );

        let event = outcome.to_json("session-partial".to_string());
        assert_eq!(event["task_status"], "partial");
        assert_eq!(event["termination_reason"], "last_tool_error");
        assert_eq!(event["resume_safe"], true);
    }

    #[test]
    fn blocked_word_in_prose_does_not_change_status() {
        assert_eq!(
            declared_task_status("The BLOCKED status is described in the documentation."),
            None
        );
        assert_eq!(
            declared_task_status("Status: BLOCKED — missing capability"),
            Some(TaskOutcomeStatus::Blocked)
        );
    }

    #[test]
    fn provider_retry_metadata_is_retained_in_terminal_result() {
        let mut outcome = HeadlessOutcome::default();
        outcome.observe_event(&EngineEvent::ProviderRetry(
            kcoder_engine::ProviderRetryDetails {
                request_kind: "main".to_string(),
                provider: "test-provider".to_string(),
                model: "test-model".to_string(),
                attempt: 1,
                max_retries: 3,
                elapsed_ms: 10,
                turn_elapsed_ms: 20,
                transport_elapsed_ms: 20,
                retry_after_ms: 2_500,
                first_token_ms: None,
                last_token_ms: None,
                timeout_kind: None,
                reason: "overloaded".to_string(),
            },
        ));
        outcome.observe_event(&EngineEvent::Error("provider 529 overloaded".to_string()));

        let event = outcome.to_json("session-retry".to_string());
        assert_eq!(event["provider_retry_count"], 1);
        assert_eq!(event["retry_after_ms"], 2_500);
        assert_eq!(event["retryable"], true);
        assert_eq!(event["resume_safe"], true);
    }

    #[test]
    fn recovered_compaction_does_not_pollute_terminal_failure_metadata() {
        let mut outcome = HeadlessOutcome::default();
        outcome.observe_event(&EngineEvent::CompactionRecovered {
            details: kcoder_engine::context::CompactionFailureDetails {
                phase: "auto_full".to_string(),
                reason: "protocol_tag_count".to_string(),
                opening_summary_tags: 2,
                closing_summary_tags: 1,
                response_chars: 6842,
                response_fingerprint: "deadbeef".to_string(),
                stop_reason: Some("end_turn".to_string()),
                attempt: 1,
                will_retry: true,
                state_mutated: false,
            },
        });

        let event = outcome.to_json("session-recovered".to_string());
        assert!(event.get("last_compaction_failure").is_none());
        assert_eq!(event["subtype"], "success");
    }
}
