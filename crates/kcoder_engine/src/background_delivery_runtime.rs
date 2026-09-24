use super::*;

impl QueryEngine {
    pub(super) async fn apply_scoped_background_event_with_hooks(
        &self,
        identity: kcoder_types::BackgroundEventIdentity,
        event: BackgroundJobEvent,
    ) -> Vec<EngineEvent> {
        let Some(task) = self.state.task_for_background_run(&identity.run) else {
            tracing::warn!(event_id = %identity.event_id, "discarded unknown background run event");
            return Vec::new();
        };
        let scoped = || EngineEvent::BackgroundScoped {
            identity: identity.clone(),
            event: Box::new(event.clone().into()),
        };
        if let BackgroundJobEvent::Started { description, .. } = event.payload() {
            if description.starts_with(kcoder_tools::background::TOOL_BACKGROUND_TASK_PREFIX) {
                return Vec::new();
            }
            if !self
                .background_started_announced
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(identity.run.clone())
            {
                return Vec::new();
            }
            let (mut events, _, _) = self.run_simple_hooks(kcoder_hooks::HookEvent::Notification, identity.run.agent_id.clone(), serde_json::json!({"id":identity.run.agent_id,"run_id":identity.run.run_id,"event_id":identity.event_id,"status":"started","description":description})).await;
            events.push(scoped());
            return events;
        }
        let status = match event.payload() {
            BackgroundJobEvent::Completed { .. } => "completed",
            BackgroundJobEvent::Failed { .. } => "failed",
            BackgroundJobEvent::Cancelled { .. } => "cancelled",
            BackgroundJobEvent::Halted { .. } => "halted",
            _ => return vec![scoped()],
        };
        let Some(record) = self.state.background_run_record(&identity.run) else {
            return Vec::new();
        };
        if record.terminal.as_ref() != Some(&identity) {
            return Vec::new();
        }
        if !task.notify_parent_on_completion
            || record.delivery == kcoder_state::TaskDelivery::Foreground
        {
            return vec![scoped()];
        }
        if record.delivered_message_id.is_none()
            && !crate::agent::unmatched_tool_use_ids(&self.state.messages()).is_empty()
        {
            // A failed tool-result commit must be repaired before appending user context.
            return Vec::new();
        }
        let id = &identity.run.agent_id;
        let internal = Self::is_internal_background_task(&self.state, id);
        if internal {
            return vec![scoped()];
        }
        let tag = match task.kind {
            TaskKind::Subagent => "subagent",
            TaskKind::Workflow => "workflow",
            TaskKind::Generic => "task",
        };
        let output_file = record
            .output_path
            .as_ref()
            .map(|path| {
                format!(
                    " output_file=\"{}\"",
                    Self::sanitize_xml_attr(&path.display().to_string())
                )
            })
            .unwrap_or_default();
        let detail = match event.payload() {
            BackgroundJobEvent::Failed { error, .. } => format!(
                " error=\"{}\"",
                Self::sanitize_xml_attr(&error.chars().take(2048).collect::<String>())
            ),
            BackgroundJobEvent::Cancelled { reason, .. }
            | BackgroundJobEvent::Halted { reason, .. } => format!(
                " reason=\"{}\"",
                Self::sanitize_xml_attr(&reason.chars().take(2048).collect::<String>())
            ),
            _ => String::new(),
        };
        let current_run = self
            .state
            .task(id)
            .is_some_and(|current| current.background_run.as_ref() == Some(&identity.run));
        let artifact = if status == "completed" && !task.artifact_requirements.is_empty() {
            task.artifact_validation_report.as_ref().filter(|report| current_run && task.artifact_validation_run.as_ref() == Some(&report.run)
                && report.run.declarations_sha256 == kcoder_state::artifact_declarations_sha256(&task.artifact_requirements))
                .map(|report| format!(" artifact_report=\"available\" artifact_failures=\"{}\" artifact_unavailable=\"{}\"", report.failure_count(), report.unavailable_count()))
                .unwrap_or_else(|| " artifact_report=\"unavailable\"".into())
        } else {
            String::new()
        };
        let text = format!(
            "<{tag}_notification id=\"{}\" run_id=\"{}\" status=\"{status}\"{output_file}{detail}{artifact}/>",
            Self::sanitize_xml_attr(id),
            identity.run.run_id
        );
        let text = if status == "completed" && current_run {
            let text = crate::orchestrate::notification::enrich_completion_notification(
                &text,
                Self::orchestrate_acceptance_pending(&self.state, id),
            );
            crate::orchestrate::notification::enrich_review_vote_summary(
                &text,
                task.review_vote_summary.as_deref(),
            )
        } else {
            text
        };
        match self
            .state
            .deliver_background_notification(&identity, Message::runtime_text(text))
            .await
        {
            Ok(new_delivery) => {
                let mut events = Vec::new();
                let input = self.hook_input(kcoder_hooks::HookEvent::Notification, id.clone(), serde_json::json!({"id":id,"run_id":identity.run.run_id,"event_id":identity.event_id,"status":status}))
                    .with_extra("run_id", serde_json::json!(identity.run.run_id))
                    .with_extra("event_id", serde_json::json!(identity.event_id));
                let prepared = kcoder_hooks::prepare_hooks(&self.hook_registry, &input);
                match prepared {
                    Ok(prepared) => {
                        let ids: Vec<_> =
                            prepared.iter().map(|hook| hook.hook_id.clone()).collect();
                        match self.state.prepare_background_hooks(&identity.run, &ids) {
                            Ok(expected) => {
                                let mut results = Vec::new();
                                for hook_id in expected {
                                    match self
                                        .state
                                        .claim_background_hook_execution(&identity.run, &hook_id)
                                    {
                                        Ok(true) => {
                                            if let Some(hook) =
                                                prepared.iter().find(|hook| hook.hook_id == hook_id)
                                            {
                                                let hook_input = input.clone().with_extra(
                                                    "hook_execution_id",
                                                    serde_json::json!(format!(
                                                        "{}:{hook_id}",
                                                        identity.event_id
                                                    )),
                                                );
                                                results.push(
                                                    kcoder_hooks::execute_prepared_hook(
                                                        hook, hook_input,
                                                    )
                                                    .await,
                                                );
                                                if let Err(error) =
                                                    self.state.finish_background_hook_execution(
                                                        &identity.run,
                                                        &hook_id,
                                                    )
                                                {
                                                    tracing::warn!(run_id = %identity.run.run_id, %hook_id, %error, "background hook acknowledgement uncertain");
                                                }
                                            } else {
                                                tracing::warn!(run_id = %identity.run.run_id, %hook_id, "original background hook configuration unavailable; execution remains uncertain");
                                            }
                                        }
                                        Ok(false) => {}
                                        Err(error) => {
                                            tracing::warn!(run_id = %identity.run.run_id, %hook_id, %error, "background hook claim not committed")
                                        }
                                    }
                                }
                                let effects = kcoder_hooks::AggregatedEffects::aggregate(
                                    results
                                        .iter()
                                        .filter_map(|result| match &result.outcome {
                                            kcoder_hooks::HookOutcome::Effects(effects) => {
                                                Some(effects.clone())
                                            }
                                            _ => None,
                                        })
                                        .collect(),
                                );
                                events.extend(effects.messages.iter().map(|(text, is_error)| {
                                    EngineEvent::HookMessage {
                                        text: text.clone(),
                                        is_error: *is_error,
                                    }
                                }));
                                if let Some(error) = kcoder_hooks::first_blocking_error(&results) {
                                    events.push(EngineEvent::HookMessage {
                                        text: error,
                                        is_error: true,
                                    });
                                }
                            }
                            Err(error) => {
                                tracing::warn!(run_id = %identity.run.run_id, %error, "background hook snapshot remains pending")
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(run_id = %identity.run.run_id, %error, "failed to prepare background notification hooks")
                    }
                }
                let first_projection = self
                    .background_recovery_announced
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .insert(identity.run.clone());
                if new_delivery
                    || (first_projection
                        && !record.followup_handled
                        && !record.followup_started
                        && task.kind == TaskKind::Subagent)
                {
                    events.push(scoped());
                }
                events
            }
            Err(error) => {
                tracing::warn!(event_id = %identity.event_id, %error, "background notification remains pending after persistence failure");
                Vec::new()
            }
        }
    }

    pub fn background_event_triggers_followup(&self, event: &EngineEvent) -> bool {
        if !matches!(
            event.background_payload(),
            EngineEvent::BackgroundJobCompleted { .. }
                | EngineEvent::BackgroundJobFailed { .. }
                | EngineEvent::BackgroundJobCancelled { .. }
                | EngineEvent::BackgroundJobHalted { .. }
        ) {
            return false;
        }
        if let Some(identity) = event.background_identity() {
            return self
                .state
                .task_for_background_run(&identity.run)
                .is_some_and(|task| {
                    task.kind == TaskKind::Subagent && task.notify_parent_on_completion
                })
                && self
                    .state
                    .background_run_record(&identity.run)
                    .is_some_and(|record| {
                        !record.suppressed
                            && record.delivered_message_id.is_some()
                            && record.pending_result_message_id.is_none()
                            && !record.followup_handled
                            && !record.followup_started
                    });
        }
        match event.background_payload() {
            EngineEvent::BackgroundJobCompleted { id, .. }
            | EngineEvent::BackgroundJobFailed { id, .. }
            | EngineEvent::BackgroundJobCancelled { id, .. }
            | EngineEvent::BackgroundJobHalted { id, .. } => {
                self.background_job_triggers_followup(id)
            }
            _ => false,
        }
    }
}
