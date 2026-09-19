use super::*;

/// Reserves jobs, prefire, and memory worker admission, not foreground turns.
#[must_use = "dropping the reservation reopens the admissions"]
pub struct BackgroundWorkIdleReservation {
    jobs: background::BackgroundIdleReservation,
    prefire: compaction_runtime::PrefireIdleReservation,
    memory: memory_idle::MemoryIdleReservation,
}

impl BackgroundWorkIdleReservation {
    pub fn commit(self) {
        self.jobs.commit();
        self.prefire.commit();
        self.memory.commit();
    }
}

impl QueryEngine {
    pub fn shares_idle_admission_with(&self, other: &Self) -> bool {
        self.shares_background_activity_with(other)
            && Arc::ptr_eq(&self.memory_idle_gate, &other.memory_idle_gate)
    }
    pub fn try_reserve_background_work_idle(&self) -> Option<BackgroundWorkIdleReservation> {
        let jobs = self.background_jobs.try_reserve_idle()?;
        let prefire = self.try_reserve_prefire_idle()?;
        let memory = self.try_reserve_memory_idle()?;
        Some(BackgroundWorkIdleReservation {
            jobs,
            prefire,
            memory,
        })
    }
    /// Nonblocking registry counts: job handles, cancellation markers, and prefire registrations.
    /// These observations are not a quiescence or child-process exit guarantee.
    pub fn try_background_activity_counts(&self) -> Option<(usize, usize, usize)> {
        let (jobs, cancellation_markers) = self.background_jobs.try_resource_counts()?;
        Some((
            jobs,
            cancellation_markers,
            usize::from(self.prefire_resource_registered()?),
        ))
    }

    pub fn shares_background_activity_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.background_jobs, &other.background_jobs)
            && Arc::ptr_eq(&self.auto_compact_state, &other.auto_compact_state)
    }
    pub fn subagent_live_snapshot(
        &self,
        id: &str,
        previous: Option<u64>,
    ) -> Option<crate::agent_live_view::AgentLiveSnapshot> {
        let task = self.state.task(id)?;
        if task.parent_session_id.as_deref() != Some(self.state.session_id().as_str()) {
            return None;
        }
        self.background_jobs.live_views.snapshot(id, previous)
    }

    pub fn has_subagent_live_view(&self, id: &str) -> bool {
        self.background_jobs.live_views.contains(id)
    }
    /// Byte budget for the TUI preview that accompanies a
    /// `BackgroundJobCompleted` notification. Lets the user peek at the
    /// sub-agent's output without invoking the `wait` tool.
    pub fn background_completion_preview_bytes(&self) -> usize {
        recover_read_lock(&self.settings, "settings").background_completion_preview_bytes
    }

    /// Drain raw background job events from the receiver without applying them
    /// to conversation state yet. This lets the caller control message ordering.
    pub(super) fn drain_background_events(&self) -> Vec<BackgroundJobEvent> {
        let mut events = Vec::new();
        let Ok(mut rx) = self.background_job_rx.try_lock() else {
            return events;
        };
        while let Ok(event) = rx.try_recv() {
            // Progress is a presentation-only heartbeat consumed by the
            // REPL's independent broadcast subscriber. Never run notification
            // hooks for it or inject it into the model conversation.
            if !matches!(
                event,
                BackgroundJobEvent::Progress { .. }
                    | BackgroundJobEvent::SubagentSteerApplied { .. }
                    | BackgroundJobEvent::Associated { .. }
                    | BackgroundJobEvent::Promoted { .. }
            ) {
                events.push(event);
            }
        }
        events
    }

    /// Drain any background job events that have already completed and, for
    /// finished jobs, insert a synthetic user message so the next API call sees
    /// the result. Returns engine events for each drained job.
    fn drain_background_jobs(&self) -> Vec<EngineEvent> {
        let mut events: Vec<EngineEvent> = self
            .drain_background_events()
            .into_iter()
            .filter_map(|event| Self::apply_background_event(&self.state, event))
            .collect();
        events.extend(
            self.recover_final_background_events()
                .into_iter()
                .filter_map(|event| Self::apply_background_event(&self.state, event)),
        );
        events
    }

    /// Public wrapper around the internal background job drain. Callers outside
    /// the engine (the REPL, tests) can use this to force a flush of any
    /// background events that have already been broadcast so the next API
    /// call sees the corresponding `<subagent_notification .../>` message.
    pub fn flush_background_jobs(&self) -> Vec<EngineEvent> {
        self.drain_background_jobs()
            .into_iter()
            .filter(|event| !matches!(event, EngineEvent::BackgroundJobStarted { .. }))
            .collect()
    }

    /// Subscribe to background job completion events from outside the engine
    /// (e.g., the REPL).
    pub fn subscribe_background_jobs(
        &self,
    ) -> tokio::sync::broadcast::Receiver<BackgroundJobEvent> {
        self.background_jobs.subscribe()
    }

    pub(crate) fn report_background_job_progress(
        &self,
        id: &str,
        message: impl AsRef<str>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        self.background_jobs
            .report_progress(id, message, current, total)
    }

    pub(crate) fn report_background_job_progress_detail(
        &self,
        id: &str,
        message: impl AsRef<str>,
        detail: impl AsRef<str>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        self.background_jobs
            .report_progress_with_detail(id, message, Some(detail), current, total)
    }

    /// Abort a running background job by ID.
    ///
    /// Returns true when a live job handle was found and cancelled.
    pub fn abort_background_job(&self, id: &str) -> bool {
        self.background_jobs.abort(id)
    }

    /// Cooperatively cancel a running background job and wait for its bounded
    /// cleanup path to persist terminal artifacts before returning.
    pub async fn abort_background_job_and_wait(&self, id: &str) -> bool {
        self.background_jobs.abort_and_wait(id).await
    }

    /// Stop one managed task. A paused agent has no live handle, so commit its cancelled terminal state separately.
    pub async fn stop_background_task(&self, id: &str) -> bool {
        match self.state.task(id).map(|task| task.status) {
            Some(TaskStatus::Paused) => self.background_jobs.cancel_paused(id),
            Some(TaskStatus::Pending | TaskStatus::Running) => {
                self.background_jobs.abort_and_wait(id).await
            }
            _ => false,
        }
    }

    /// Whether a finished background job should wake the main model with a
    /// follow-up turn. Sub-agent and workflow jobs do this; internal
    /// maintenance jobs and explicit tool background tasks update state/UI but
    /// are consumed via their own mechanisms.
    pub fn background_job_triggers_followup(&self, id: &str) -> bool {
        self.state.task(id).is_some_and(|task| {
            matches!(task.kind, TaskKind::Subagent)
                && task.notify_parent_on_completion
                && !Self::is_internal_background_task(&self.state, id)
        })
    }

    /// Apply one lifecycle event and return it only when this event won the
    /// task's delivery claim. Terminal broadcasts can be duplicated by
    /// foreground-to-background promotion and recovery; returning `None` for
    /// those duplicates keeps notification injection, hooks, and parent
    /// follow-up scheduling on the same exactly-once boundary.
    pub(super) fn apply_background_event(
        state: &AppState,
        event: BackgroundJobEvent,
    ) -> Option<EngineEvent> {
        match &event {
            // A started event is sent by `BackgroundJobManager` *after* the
            // manager has already inserted the `running` task record. We do not
            // inject anything into the main conversation here: the
            // `spawn_agent` tool result itself already told the main model the
            // agent is running, so a second injection would just be noise that
            // can wake the model up at an awkward moment.
            BackgroundJobEvent::Started { description, .. } => {
                // Foreground tool executions (shell, ocr, ...) are registered
                // with the manager only so they can be promoted to background
                // delivery; their completion is consumed inline by the calling
                // tool and the task record is evicted immediately afterwards,
                // so no terminal event ever survives this channel. Emitting a
                // bare start would leave engine-event consumers (headless
                // NDJSON, future app-server clients) with a dangling "running"
                // job, so suppress it. Explicit sub-agent/workflow jobs keep
                // their started event.
                if description.starts_with(kcoder_tools::background::TOOL_BACKGROUND_TASK_PREFIX) {
                    return None;
                }
            }
            BackgroundJobEvent::Associated { .. } | BackgroundJobEvent::Promoted { .. } => {}
            BackgroundJobEvent::Progress { .. }
            | BackgroundJobEvent::SubagentSteerApplied { .. } => {}
            BackgroundJobEvent::Paused { .. } => {}
            BackgroundJobEvent::Completed { id, .. } => {
                if Self::is_internal_background_task(state, id) {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                if state.task(id).is_some_and(|task| {
                    matches!(task.kind, TaskKind::Generic) && !task.notify_parent_on_completion
                }) {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                if state
                    .task(id)
                    .is_some_and(|task| matches!(task.kind, TaskKind::Generic))
                {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    let output_file = Self::subagent_output_file_attr(state, id);
                    state.add_message(Message::user_text(format!(
                        "<task_notification id=\"{id}\" status=\"completed\"{output_file}/>"
                    )));
                    return Some(event.into());
                }
                if state
                    .task(id)
                    .is_some_and(|task| !task.notify_parent_on_completion)
                {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                // Inject a structured notification into the main conversation
                // so the next API call (or the idle follow-up turn) sees it.
                // We deliberately do NOT inline the full sub-agent output: the
                // main model can call `TaskOutput` to pull the result, or react
                // based on the short hint in the tag.
                //
                // Deduplication: if a previous turn loop already injected a
                // notification for this same id (e.g. a transient retry or a
                // duplicate broadcast) we skip the second insert so the model
                // does not see two `<subagent_notification .../>` messages for
                // the same job and get confused.
                if !Self::claim_subagent_notification(state, id) {
                    return None;
                }
                let output_file = Self::subagent_output_file_attr(state, id);
                let tag = Self::background_notification_tag(state, id);
                let artifact_report = state.task(id).map(|task| {
                    if task.artifact_requirements.is_empty() { return String::new(); }
                    task.artifact_validation_report.filter(|report| {
                        task.status == TaskStatus::Completed
                            && task.artifact_validation_run.as_ref() == Some(&report.run)
                            && report.run.declarations_sha256 == kcoder_state::artifact_declarations_sha256(&task.artifact_requirements)
                    }).map(|report| format!(" artifact_report=\"available\" artifact_failures=\"{}\" artifact_unavailable=\"{}\"", report.failure_count(), report.unavailable_count()))
                        .unwrap_or_else(|| " artifact_report=\"unavailable\"".into())
                }).unwrap_or_default();
                let notification = format!(
                    "<{tag}_notification id=\"{id}\" status=\"completed\"{output_file}{artifact_report}/>"
                );
                let notification = crate::orchestrate::notification::enrich_completion_notification(
                    &notification,
                    Self::orchestrate_acceptance_pending(state, id),
                );
                let review_vote_summary = state.task(id).and_then(|task| task.review_vote_summary);
                state.add_message(Message::user_text(
                    crate::orchestrate::notification::enrich_review_vote_summary(
                        &notification,
                        review_vote_summary.as_deref(),
                    ),
                ));
            }
            BackgroundJobEvent::Failed { id, error } => {
                if Self::is_internal_background_task(state, id) {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                if state.task(id).is_some_and(|task| {
                    matches!(task.kind, TaskKind::Generic) && !task.notify_parent_on_completion
                }) {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                if state
                    .task(id)
                    .is_some_and(|task| matches!(task.kind, TaskKind::Generic))
                {
                    let sanitized = Self::sanitize_xml_attr(error);
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    let output_file = Self::subagent_output_file_attr(state, id);
                    let status = if state
                        .task(id)
                        .is_some_and(|task| matches!(task.status, TaskStatus::Cancelled))
                    {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    state.add_message(Message::user_text(format!(
                        "<task_notification id=\"{id}\" status=\"{status}\"{output_file} error=\"{sanitized}\"/>"
                    )));
                    return Some(event.into());
                }
                if state
                    .task(id)
                    .is_some_and(|task| !task.notify_parent_on_completion)
                {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                // Sanitise newlines so we never break out of the XML-like
                // attribute with a stray quote.
                let sanitized = Self::sanitize_xml_attr(error);
                if !Self::claim_subagent_notification(state, id) {
                    return None;
                }
                let output_file = Self::subagent_output_file_attr(state, id);
                let tag = Self::background_notification_tag(state, id);
                let status = if state
                    .task(id)
                    .is_some_and(|task| matches!(task.status, TaskStatus::Cancelled))
                {
                    "cancelled"
                } else {
                    "failed"
                };
                state.add_message(Message::user_text(format!(
                    "<{tag}_notification id=\"{id}\" status=\"{status}\"{output_file} error=\"{sanitized}\"/>"
                )));
            }
            BackgroundJobEvent::Halted { id, reason } => {
                if !Self::claim_subagent_notification(state, id) {
                    return None;
                }
                let sanitized = Self::sanitize_xml_attr(reason);
                let output_file = Self::subagent_output_file_attr(state, id);
                let tag = Self::background_notification_tag(state, id);
                state.add_message(Message::user_text(format!(
                    "<{tag}_notification id=\"{id}\" status=\"halted\"{output_file} reason=\"{sanitized}\"/>"
                )));
            }
            BackgroundJobEvent::Cancelled { id, reason } => {
                if Self::is_internal_background_task(state, id)
                    || state
                        .task(id)
                        .is_some_and(|task| !task.notify_parent_on_completion)
                {
                    if !state.claim_task_notification_injected(id) {
                        return None;
                    }
                    return Some(event.into());
                }
                let sanitized = Self::sanitize_xml_attr(reason);
                if !Self::claim_subagent_notification(state, id) {
                    return None;
                }
                let output_file = Self::subagent_output_file_attr(state, id);
                let tag = Self::background_notification_tag(state, id);
                state.add_message(Message::user_text(format!(
                    "<{tag}_notification id=\"{id}\" status=\"cancelled\"{output_file} reason=\"{sanitized}\"/>"
                )));
            }
        }
        Some(event.into())
    }

    fn subagent_output_file_attr(state: &AppState, id: &str) -> String {
        state
            .task(id)
            .and_then(|task| task.output_path)
            .map(|path| {
                format!(
                    " output_file=\"{}\"",
                    Self::sanitize_xml_attr(&path.display().to_string())
                )
            })
            .unwrap_or_default()
    }

    fn background_notification_tag(state: &AppState, id: &str) -> &'static str {
        if state
            .task(id)
            .is_some_and(|task| matches!(task.kind, TaskKind::Workflow))
        {
            "workflow"
        } else {
            "subagent"
        }
    }

    fn orchestrate_acceptance_pending(state: &AppState, id: &str) -> bool {
        state.session_mode().is_orchestrate()
            && Self::background_notification_tag(state, id) == "subagent"
            && kcoder_state::orchestrate_store::PlanStore::for_workspace(&state.cwd())
                .active_work_id()
                .ok()
                .flatten()
                .is_some()
    }

    fn sanitize_xml_attr(value: &str) -> String {
        value.replace(['\n', '\r', '"'], " ")
    }

    fn is_internal_background_task(state: &AppState, id: &str) -> bool {
        state.task(id).is_some_and(|task| {
            task.description
                .starts_with(crate::skill_review::INTERNAL_SKILL_REVIEW_PREFIX)
                || task.description.starts_with(INTERNAL_SKILL_CURATOR_PREFIX)
        })
    }

    /// Reconstruct final background events from AppState for jobs whose
    /// broadcast event was missed by the engine receiver. This makes sub-agent
    /// completion notification best-effort durable within the current session:
    /// a completed task record is enough to nudge the parent model exactly once.
    fn recover_final_background_events(&self) -> Vec<BackgroundJobEvent> {
        self.state
            .tasks()
            .values()
            .filter(|task| task.notify_parent_on_completion)
            .filter(|task| task.notification_injected_at_ms.is_none())
            .filter_map(|task| match task.status {
                TaskStatus::Completed => Some(BackgroundJobEvent::Completed {
                    id: task.id.clone(),
                    output: ToolOutput::text(task.output.clone().unwrap_or_default()),
                }),
                TaskStatus::Failed => Some(BackgroundJobEvent::Failed {
                    id: task.id.clone(),
                    error: task
                        .output
                        .clone()
                        .unwrap_or_else(|| "background job failed".to_string()),
                }),
                TaskStatus::Cancelled => Some(BackgroundJobEvent::Cancelled {
                    id: task.id.clone(),
                    reason: task
                        .output
                        .clone()
                        .unwrap_or_else(|| "cancelled by user".to_string()),
                }),
                TaskStatus::Halted => Some(BackgroundJobEvent::Halted {
                    id: task.id.clone(),
                    reason: "gracefully halted by parent Orchestrate session".to_string(),
                }),
                TaskStatus::Paused | TaskStatus::Pending | TaskStatus::Running => None,
            })
            .collect()
    }

    /// Claim the right to inject a notification for this task. The explicit
    /// task marker prevents duplicates across repeated flushes, while the
    /// recent-message fallback avoids double-injecting notifications created by
    /// older code before the marker field existed.
    fn claim_subagent_notification(state: &AppState, id: &str) -> bool {
        if let Some(task) = state.task(id) {
            if task.run_started_at_ms.is_none()
                && Self::has_recent_background_notification(state, id)
            {
                state.mark_task_notification_injected(id);
                return false;
            }
            return state.claim_task_notification_injected(id);
        } else if Self::has_recent_background_notification(state, id) {
            return false;
        }
        false
    }

    /// Look at the most recent few messages in the conversation to see if
    /// a `<subagent_notification .../>` for the given `id` has already been
    /// injected. Used to deduplicate notifications so a single sub-agent
    /// completion does not produce two back-to-back reminders for the
    /// same job — for example when a retry or a duplicate broadcast event
    /// would otherwise cause the engine to call `apply_background_event`
    /// twice.
    fn has_recent_background_notification(state: &AppState, id: &str) -> bool {
        let tag = Self::background_notification_tag(state, id);
        let needle = format!("<{tag}_notification id=\"{}\"", id);
        state.recent_messages(8).iter().rev().any(|m| match m {
            Message::User { content } => content.iter().any(|b| match b {
                ContentBlock::Text { text } => text.contains(&needle),
                _ => false,
            }),
            _ => false,
        })
    }

    /// Async variant of [`Self::flush_background_jobs`] that also runs
    /// `Notification` lifecycle hooks for drained background events.
    pub async fn flush_background_jobs_with_hooks(&self) -> Vec<EngineEvent> {
        self.drain_background_jobs_with_hooks()
            .await
            .into_iter()
            .filter(|event| !matches!(event, EngineEvent::BackgroundJobStarted { .. }))
            .collect()
    }

    pub(super) async fn apply_background_event_with_hooks(
        &self,
        event: BackgroundJobEvent,
    ) -> Vec<EngineEvent> {
        match &event {
            BackgroundJobEvent::Progress {
                id,
                message,
                detail,
                current,
                total,
            } => {
                return vec![EngineEvent::BackgroundJobProgress {
                    id: id.clone(),
                    message: message.clone(),
                    detail: detail.clone(),
                    current: *current,
                    total: *total,
                }];
            }
            BackgroundJobEvent::SubagentSteerApplied { .. } => {
                return vec![event.into()];
            }
            BackgroundJobEvent::Paused { .. } => {
                return vec![event.into()];
            }
            BackgroundJobEvent::Associated { .. } | BackgroundJobEvent::Promoted { .. } => {
                return vec![event.into()];
            }
            _ => {}
        }
        let Some(applied_event) = Self::apply_background_event(&self.state, event.clone()) else {
            return Vec::new();
        };
        let (query, data) = match &event {
            BackgroundJobEvent::Started {
                id, description, ..
            } => (
                id.clone(),
                serde_json::json!({
                    "id": id,
                    "status": "started",
                    "description": description,
                }),
            ),
            BackgroundJobEvent::Associated { .. } | BackgroundJobEvent::Promoted { .. } => {
                unreachable!("presentation-only events returned above")
            }
            BackgroundJobEvent::Progress { .. }
            | BackgroundJobEvent::SubagentSteerApplied { .. } => {
                unreachable!("handled above")
            }
            BackgroundJobEvent::Completed { id, output } => (
                id.clone(),
                serde_json::json!({
                    "id": id,
                    "status": "completed",
                    "output": tool_output_text(output),
                }),
            ),
            BackgroundJobEvent::Failed { id, error } => (
                id.clone(),
                serde_json::json!({
                    "id": id,
                    "status": "failed",
                    "error": error,
                }),
            ),
            BackgroundJobEvent::Paused { .. } => unreachable!("handled above"),
            BackgroundJobEvent::Halted { id, reason } => (
                id.clone(),
                serde_json::json!({
                    "id": id,
                    "status": "halted",
                    "reason": reason,
                }),
            ),
            BackgroundJobEvent::Cancelled { id, reason } => (
                id.clone(),
                serde_json::json!({
                    "id": id,
                    "status": "cancelled",
                    "reason": reason,
                }),
            ),
        };
        let (mut events, _effects, _blocking_error) = self
            .run_simple_hooks(kcoder_hooks::HookEvent::Notification, query, data)
            .await;
        events.push(applied_event);
        events
    }

    pub(super) async fn drain_background_jobs_with_hooks(&self) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        for event in self.drain_background_events() {
            events.extend(self.apply_background_event_with_hooks(event).await);
        }
        for event in self.recover_final_background_events() {
            events.extend(self.apply_background_event_with_hooks(event).await);
        }
        events
    }
}

#[cfg(test)]
#[path = "tests/background_runtime_unit.rs"]
mod tests;
