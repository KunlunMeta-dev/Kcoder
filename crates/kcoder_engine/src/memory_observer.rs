use super::*;
use crate::tool_file_observation::is_shell_tool_name;
use crate::verification_target::verification_command_label;

mod diagnostics;
mod model_codec;

pub use diagnostics::{
    MemoryObserverEventLogDiagnostics, MemoryObserverRecoveryAuditDiagnostics,
    MemoryObserverValidationFailureDiagnostics, MemoryObserverWorkerDiagnostics,
};
use diagnostics::{MemoryObserverRecoveryAuditItem, latest_recovery_audit_item};
use model_codec::{
    MemoryObserverFailurePhase, MemoryObserverModelDraftError, MemoryObserverModelFallbackKind,
    memory_observer_model_fallback_kind_name, memory_observer_model_system_prompt,
    memory_observer_model_user_prompt, parse_memory_observer_model_draft,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct MemoryObserverWriteResult {
    observations_written: usize,
    summaries_written: usize,
}

impl QueryEngine {
    pub(super) fn record_verification_observation(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        input: &Value,
        is_error: bool,
    ) {
        if !self.auto_tool_memory_enabled_for_tool(tool_name) {
            return;
        }
        if is_error || !is_shell_tool_name(tool_name) {
            return;
        }
        if input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return;
        }
        let Some(command) = input.get("command").and_then(Value::as_str) else {
            return;
        };
        let Some(label) = verification_command_label(command) else {
            return;
        };
        let command = command.trim();
        if command.is_empty() {
            return;
        }
        let mut bundle = self.memory_observer_event_bundle();
        bundle.add_verification_passed_event(tool_call_id, tool_name, label, Some(command));
        self.record_memory_observer_bundle(bundle);
    }

    pub(super) fn record_failure_recovery_observation(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        _input: &Value,
        recovered_failure: Option<&ToolFailureRecord>,
    ) {
        if !self.auto_tool_memory_enabled_for_tool(tool_name) {
            return;
        }
        let Some(failure) = recovered_failure else {
            return;
        };
        let mut bundle = self.memory_observer_event_bundle();
        bundle.add_failure_recovery_event(
            tool_call_id,
            tool_name,
            failure.count,
            Some(failure.input_preview.as_str()),
        );
        self.record_memory_observer_bundle(bundle);
    }

    pub(super) fn record_verification_target_recovery_observation(
        &self,
        tool_call_id: &str,
        tool_name: &str,
        input: &Value,
        recovered_failure: Option<&VerificationFailureRecord>,
    ) {
        if !self.auto_tool_memory_enabled_for_tool(tool_name) {
            return;
        }
        let Some(failure) = recovered_failure else {
            return;
        };
        let command = input
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let mut bundle = self.memory_observer_event_bundle();
        bundle.add_verification_target_recovery_event(
            tool_call_id,
            tool_name,
            failure.target.as_str(),
            failure.count,
            Some(failure.command_preview.as_str()),
            Some(command),
        );
        self.record_memory_observer_bundle(bundle);
    }

    pub(super) fn auto_tool_memory_enabled_for_tool(&self, tool_name: &str) -> bool {
        let settings = recover_read_lock(&self.settings, "settings");
        settings.auto_memory_enabled
            && settings.auto_tool_memory_enabled
            && !settings
                .memory
                .skip_tools
                .iter()
                .any(|skipped| skipped == tool_name)
    }

    pub fn memory_observer_queue_stats(&self) -> MemoryObserverQueueStats {
        recover_read_lock(&self.memory_observer_queue, "memory_observer_queue").stats()
    }

    pub fn memory_observer_last_validation_failure(
        &self,
    ) -> Option<MemoryObserverValidationFailureDiagnostics> {
        recover_read_lock(
            &self.memory_observer_last_validation_failure,
            "memory_observer_last_validation_failure",
        )
        .clone()
    }

    pub fn memory_observer_worker_diagnostics(&self) -> MemoryObserverWorkerDiagnostics {
        recover_read_lock(
            &self.memory_observer_worker_diagnostics,
            "memory_observer_worker_diagnostics",
        )
        .clone()
    }

    pub fn memory_observer_event_log_diagnostics(&self) -> MemoryObserverEventLogDiagnostics {
        let path = self.memory_observer_event_log_path();
        let Ok(raw) = fs::read_to_string(&path) else {
            return MemoryObserverEventLogDiagnostics {
                path,
                ..MemoryObserverEventLogDiagnostics::default()
            };
        };
        let mut diagnostics = MemoryObserverEventLogDiagnostics {
            path,
            ..MemoryObserverEventLogDiagnostics::default()
        };
        for line in raw.lines().filter(|line| !line.trim().is_empty()) {
            diagnostics.event_count = diagnostics.event_count.saturating_add(1);
            if let Ok(value) = serde_json::from_str::<Value>(line) {
                diagnostics.last_event_type = value
                    .get("event_type")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                diagnostics.last_event_at_epoch =
                    value.get("occurred_at_epoch").and_then(Value::as_u64);
            }
        }
        diagnostics
    }

    pub fn memory_observer_recovery_audit(&self) -> MemoryObserverRecoveryAuditDiagnostics {
        let path = self.memory_observer_event_log_path();
        let Ok(raw) = fs::read_to_string(&path) else {
            return MemoryObserverRecoveryAuditDiagnostics {
                path,
                ..MemoryObserverRecoveryAuditDiagnostics::default()
            };
        };
        let mut diagnostics = MemoryObserverRecoveryAuditDiagnostics {
            path,
            ..MemoryObserverRecoveryAuditDiagnostics::default()
        };
        let mut queued = VecDeque::new();
        let mut processing = VecDeque::new();

        for line in raw.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                diagnostics.malformed_event_count =
                    diagnostics.malformed_event_count.saturating_add(1);
                continue;
            };
            let Some(event_type) = value.get("event_type").and_then(Value::as_str) else {
                diagnostics.malformed_event_count =
                    diagnostics.malformed_event_count.saturating_add(1);
                continue;
            };
            diagnostics.event_count = diagnostics.event_count.saturating_add(1);
            let item = MemoryObserverRecoveryAuditItem {
                event_type: event_type.to_string(),
                occurred_at_epoch: value.get("occurred_at_epoch").and_then(Value::as_u64),
            };

            match event_type {
                "enqueue" => queued.push_back(item),
                "dequeue" => {
                    if queued.pop_front().is_none() {
                        diagnostics.orphan_dequeue_count =
                            diagnostics.orphan_dequeue_count.saturating_add(1);
                    }
                    processing.push_back(item);
                }
                "dropped_oldest" if queued.pop_front().is_some() => {
                    diagnostics.dropped_queued_before_dequeue =
                        diagnostics.dropped_queued_before_dequeue.saturating_add(1);
                }
                "model_success" if processing.pop_front().is_none() => {
                    diagnostics.orphan_terminal_count =
                        diagnostics.orphan_terminal_count.saturating_add(1);
                }
                "deterministic_success" => {
                    processing.pop_front();
                }
                _ => {}
            }
        }

        diagnostics.pending_enqueued = queued.len();
        diagnostics.pending_dequeued = processing.len();
        if let Some(item) = latest_recovery_audit_item(queued.iter().chain(processing.iter())) {
            diagnostics.last_incomplete_event_type = Some(item.event_type.clone());
            diagnostics.last_incomplete_at_epoch = item.occurred_at_epoch;
        }
        diagnostics
    }

    pub fn memory_observer_event_log_path(&self) -> PathBuf {
        self.session_dir().join(MEMORY_OBSERVER_EVENT_LOG_FILE)
    }

    fn memory_observer_sanitization_options(&self) -> MemoryObserverSanitizationOptions {
        let settings = recover_read_lock(&self.settings, "settings");
        MemoryObserverSanitizationOptions {
            private_by_default: settings.memory.private_by_default,
            private_file_paths: settings.memory.private_file_paths,
            private_verification_targets: settings.memory.private_verification_targets,
            record_prompt_placeholders: settings.memory.record_prompt_placeholders,
        }
    }

    fn memory_observer_mode(&self) -> MemoryObserverMode {
        let settings = recover_read_lock(&self.settings, "settings");
        if settings.training_mode {
            MemoryObserverMode::Disabled
        } else {
            settings.memory.observer_mode
        }
    }

    pub(super) fn memory_observer_event_bundle(&self) -> MemoryObserverEventBundle {
        MemoryObserverEventBundle::new(
            self.state.session_id(),
            String::new(),
            self.current_memory_prompt_number(),
            None,
            self.memory_observer_sanitization_options(),
        )
    }

    pub(super) fn record_memory_observer_bundle(&self, bundle: MemoryObserverEventBundle) {
        let _admission = recover_read_lock(&self.memory_idle_gate, "memory_idle_gate");
        if self.memory_idle_reserved.load(Ordering::SeqCst) {
            return;
        }
        match self.memory_observer_mode() {
            MemoryObserverMode::Disabled => {}
            MemoryObserverMode::Deterministic => {
                self.process_memory_observer_bundle_deterministically(bundle);
            }
            MemoryObserverMode::Model => {
                self.submit_memory_observer_bundle(bundle);
            }
        }
    }

    fn submit_memory_observer_bundle(&self, bundle: MemoryObserverEventBundle) {
        let submitted_event_count = bundle.events.len();
        let submitted_prompt_number = bundle.prompt_number;
        let result = {
            let mut queue =
                recover_write_lock(&self.memory_observer_queue, "memory_observer_queue");
            queue.submit(bundle)
        };

        match result {
            MemoryObserverQueueSubmitResult::Queued => {
                self.record_memory_observer_event_log(
                    "enqueue",
                    None,
                    serde_json::json!({
                        "bundle_event_count": submitted_event_count,
                        "prompt_number": submitted_prompt_number,
                        "queue": self.memory_observer_queue_stats_details(),
                    }),
                );
                debug!("memory observer model mode queued bundle");
                self.spawn_memory_observer_model_worker_or_drain_deterministically();
            }
            MemoryObserverQueueSubmitResult::InlineFallback(bundle) => {
                self.record_memory_observer_event_log(
                    "fallback",
                    Some(&bundle),
                    serde_json::json!({
                        "kind": "inline_queue_full",
                        "reason": "memory observer queue full; using deterministic inline fallback",
                        "queue": self.memory_observer_queue_stats_details(),
                    }),
                );
                debug!("memory observer queue full; using deterministic inline fallback");
                self.process_memory_observer_bundle_deterministically(bundle);
            }
            MemoryObserverQueueSubmitResult::DroppedNewest(bundle) => {
                self.record_memory_observer_event_log(
                    "dropped_newest",
                    Some(&bundle),
                    serde_json::json!({
                        "reason": "memory observer queue dropped newest bundle",
                        "queue": self.memory_observer_queue_stats_details(),
                    }),
                );
                warn!(
                    event_count = bundle.events.len(),
                    "memory observer queue dropped newest bundle"
                );
            }
            MemoryObserverQueueSubmitResult::DroppedOldest(bundle) => {
                self.record_memory_observer_event_log(
                    "dropped_oldest",
                    Some(&bundle),
                    serde_json::json!({
                        "reason": "memory observer queue dropped oldest bundle",
                        "queue": self.memory_observer_queue_stats_details(),
                    }),
                );
                warn!(
                    event_count = bundle.events.len(),
                    "memory observer queue dropped oldest bundle"
                );
                self.spawn_memory_observer_model_worker_or_drain_deterministically();
            }
        }
    }

    fn spawn_memory_observer_model_worker_or_drain_deterministically(&self) {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                if self
                    .memory_observer_worker_running
                    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    debug!("memory observer model worker already running");
                    return;
                }
                let engine = self.clone();
                let worker = handle.spawn(async move {
                    engine.drain_memory_observer_queue_with_model().await;
                });
                *self
                    .memory_observer_worker_handle
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
            }
            Err(error) => {
                debug!(
                    error = %error,
                    "memory observer model worker unavailable; draining deterministic fallback"
                );
                self.drain_memory_observer_queue_deterministically();
            }
        }
    }

    fn drain_memory_observer_queue_deterministically(&self) {
        let bundles = {
            let mut queue =
                recover_write_lock(&self.memory_observer_queue, "memory_observer_queue");
            queue.drain_all()
        };
        for bundle in bundles {
            self.record_memory_observer_event_log(
                "dequeue",
                Some(&bundle),
                serde_json::json!({
                    "mode": "deterministic_fallback",
                    "queue": self.memory_observer_queue_stats_details(),
                }),
            );
            self.process_memory_observer_bundle_deterministically(bundle);
        }
    }

    async fn drain_memory_observer_queue_with_model(&self) {
        loop {
            let bundles = {
                let mut queue =
                    recover_write_lock(&self.memory_observer_queue, "memory_observer_queue");
                queue.drain_all()
            };

            if bundles.is_empty() {
                self.memory_observer_worker_running
                    .store(false, Ordering::SeqCst);
                let queued =
                    recover_read_lock(&self.memory_observer_queue, "memory_observer_queue")
                        .stats()
                        .queued;
                if queued > 0
                    && self
                        .memory_observer_worker_running
                        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    continue;
                }
                break;
            }

            for bundle in bundles {
                self.record_memory_observer_event_log(
                    "dequeue",
                    Some(&bundle),
                    serde_json::json!({
                        "mode": "model",
                        "queue": self.memory_observer_queue_stats_details(),
                    }),
                );
                self.process_memory_observer_bundle_with_model(bundle).await;
            }
        }
    }

    async fn process_memory_observer_bundle_with_model(&self, bundle: MemoryObserverEventBundle) {
        match self.request_memory_observer_model_draft(&bundle).await {
            Ok((draft, observer_model)) => {
                if let Err(issues) = validate_memory_observer_draft(&bundle, &draft) {
                    self.record_memory_observer_validation_failure(&issues);
                    self.record_memory_observer_validation_failure_event(&bundle, &issues);
                    self.record_memory_observer_model_fallback(
                        MemoryObserverModelFallbackKind::Validation,
                        format!(
                            "observer draft validation failed with {} issue(s)",
                            issues.len()
                        ),
                    );
                    self.record_memory_observer_model_fallback_event(
                        &bundle,
                        MemoryObserverModelFallbackKind::Validation,
                        format!(
                            "observer draft validation failed with {} issue(s)",
                            issues.len()
                        ),
                        MemoryObserverFailurePhase::Validation,
                        None,
                    );
                    warn!(
                        issue_count = issues.len(),
                        "model memory observer draft failed validation; using deterministic fallback"
                    );
                    self.process_memory_observer_bundle_deterministically(bundle);
                    return;
                }
                let write_result =
                    self.write_memory_observer_draft(&bundle, &draft, Some(observer_model.clone()));
                self.record_memory_observer_event_log(
                    "model_success",
                    Some(&bundle),
                    serde_json::json!({
                        "observer_model": observer_model,
                        "observations_written": write_result.observations_written,
                        "summaries_written": write_result.summaries_written,
                    }),
                );
                self.record_memory_observer_model_success();
            }
            Err(error) => {
                self.record_memory_observer_model_fallback(error.kind, error.reason.clone());
                self.record_memory_observer_model_fallback_event(
                    &bundle,
                    error.kind,
                    error.reason.clone(),
                    error.phase,
                    error.failure.as_ref(),
                );
                warn!(
                    error = error.reason,
                    "model memory observer failed; using deterministic fallback"
                );
                self.process_memory_observer_bundle_deterministically(bundle);
            }
        }
    }

    async fn request_memory_observer_model_draft(
        &self,
        bundle: &MemoryObserverEventBundle,
    ) -> Result<(MemoryObserverDraft, String), MemoryObserverModelDraftError> {
        let observer_model = self.memory_observer_model_name();
        let request = self.memory_observer_model_request(bundle, &observer_model);
        let mut stream = self
            .current_provider()
            .stream_messages(request)
            .map(default_timed_stream)
            .map_err(|error| {
                MemoryObserverModelDraftError::provider(error, MemoryObserverFailurePhase::Start)
            })?;
        let mut text = String::new();

        while let Some(event) = stream.next().await {
            match event.map_err(|error| {
                MemoryObserverModelDraftError::provider(error, MemoryObserverFailurePhase::Stream)
            })? {
                StreamEvent::ContentBlockStart {
                    content_block: ContentBlock::Text { text: block_text },
                    ..
                } => text.push_str(&block_text),
                StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text: delta_text },
                    ..
                } => text.push_str(&delta_text),
                StreamEvent::Error { error } => {
                    return Err(MemoryObserverModelDraftError::provider(
                        kcoder_api::ApiErrorKind::Api {
                            error_type: error.error_type,
                            message: error.message,
                        },
                        MemoryObserverFailurePhase::Stream,
                    ));
                }
                _ => {}
            }
        }

        if text.trim().is_empty() {
            return Err(MemoryObserverModelDraftError::parse(
                "provider returned no observer draft text",
            ));
        }

        let mut draft = parse_memory_observer_model_draft(&text)
            .map_err(MemoryObserverModelDraftError::parse)?;
        if draft.audit.model.is_none() {
            draft.audit.model = Some(observer_model.clone());
        }
        if draft.audit.generated_at_epoch.is_none() {
            draft.audit.generated_at_epoch = Some(current_time_millis());
        }
        Ok((draft, observer_model))
    }

    fn memory_observer_model_name(&self) -> String {
        let settings = recover_read_lock(&self.settings, "settings");
        settings
            .memory
            .observer_model
            .clone()
            .unwrap_or_else(|| settings.model.clone())
    }

    pub(super) fn memory_observer_model_request(
        &self,
        bundle: &MemoryObserverEventBundle,
        observer_model: &str,
    ) -> MessagesRequest {
        let system = memory_observer_model_system_prompt(observer_model);
        let user = memory_observer_model_user_prompt(bundle);
        let supports_structured_output = recover_read_lock(&self.settings, "settings")
            .model_capabilities
            .structured_output;
        let request =
            MessagesRequest::new(observer_model.to_string(), vec![Message::user_text(user)])
                .with_system(system)
                .with_tools(Vec::new())
                .with_max_tokens(4096)
                .with_debug_session_id(self.state.session_id());
        if supports_structured_output {
            request.with_response_json_schema(
                ResponseJsonSchema::new("memory_observer_draft", memory_observer_output_schema())
                    .with_description("KCoder memory observer draft"),
            )
        } else {
            request
        }
    }

    fn record_memory_observer_event_log(
        &self,
        event_type: &str,
        bundle: Option<&MemoryObserverEventBundle>,
        details: Value,
    ) {
        let mut entry = serde_json::json!({
            "schema_version": MEMORY_OBSERVER_EVENT_LOG_SCHEMA_VERSION,
            "event_type": event_type,
            "session_id": self.state.session_id(),
            "occurred_at_epoch": current_time_millis(),
            "details": details,
        });
        if let Some(bundle) = bundle
            && let Value::Object(map) = &mut entry
        {
            map.insert(
                "prompt_number".to_string(),
                bundle.prompt_number.map(Value::from).unwrap_or(Value::Null),
            );
            map.insert(
                "bundle_event_count".to_string(),
                Value::from(bundle.events.len()),
            );
        }

        match serde_json::to_string(&entry) {
            Ok(line) => {
                if let Err(error) = append_memory_observer_event_log_line(
                    &self.memory_observer_event_log_path(),
                    &line,
                ) {
                    warn!("failed to append memory observer event log: {error}");
                }
            }
            Err(error) => warn!("failed to serialize memory observer event log: {error}"),
        }
    }

    fn memory_observer_queue_stats_details(&self) -> Value {
        let stats = self.memory_observer_queue_stats();
        serde_json::json!({
            "capacity": stats.capacity,
            "queued": stats.queued,
            "submitted": stats.submitted,
            "enqueued": stats.enqueued,
            "drained": stats.drained,
            "overflowed": stats.overflowed,
            "inline_fallbacks": stats.inline_fallbacks,
            "dropped_newest": stats.dropped_newest,
            "dropped_oldest": stats.dropped_oldest,
        })
    }

    fn process_memory_observer_bundle_deterministically(&self, bundle: MemoryObserverEventBundle) {
        let draft = deterministic_memory_observer_draft(&bundle);
        if let Err(issues) = validate_memory_observer_draft(&bundle, &draft) {
            self.record_memory_observer_validation_failure(&issues);
            self.record_memory_observer_validation_failure_event(&bundle, &issues);
            warn!(
                issue_count = issues.len(),
                "memory observer draft failed validation"
            );
            return;
        }
        let write_result = self.write_memory_observer_draft(&bundle, &draft, None);
        self.record_memory_observer_event_log(
            "deterministic_success",
            Some(&bundle),
            serde_json::json!({
                "observations_written": write_result.observations_written,
                "summaries_written": write_result.summaries_written,
            }),
        );
    }

    fn write_memory_observer_draft(
        &self,
        bundle: &MemoryObserverEventBundle,
        draft: &MemoryObserverDraft,
        generated_by_model: Option<String>,
    ) -> MemoryObserverWriteResult {
        let writes = memory_observer_draft_to_structured_writes(
            bundle,
            draft,
            current_time_millis(),
            generated_by_model,
        );

        let mut result = MemoryObserverWriteResult::default();
        for write in writes.observations {
            match self.memory_manager.save_structured_observation(write.input) {
                Ok(Some(id)) => {
                    result.observations_written = result.observations_written.saturating_add(1);
                    debug!(
                        observation_id = id,
                        "recorded observer structured observation"
                    );
                    self.record_memory_source(
                        "observation",
                        id,
                        &write.source_type,
                        write.source_ref,
                        write.source_metadata,
                    );
                }
                Ok(None) => {}
                Err(error) => warn!("failed to record observer structured observation: {error}"),
            }
        }

        for write in writes.summaries {
            match self.memory_manager.save_structured_summary(write.input) {
                Ok(Some(id)) => {
                    result.summaries_written = result.summaries_written.saturating_add(1);
                    debug!(summary_id = id, "recorded observer structured summary");
                    self.record_memory_source(
                        "summary",
                        id,
                        &write.source_type,
                        write.source_ref,
                        write.source_metadata,
                    );
                }
                Ok(None) => {}
                Err(error) => warn!("failed to record observer structured summary: {error}"),
            }
        }
        result
    }

    fn record_memory_observer_validation_failure(
        &self,
        issues: &[MemoryObserverDraftValidationIssue],
    ) {
        let first_issue = issues.first();
        let diagnostics = MemoryObserverValidationFailureDiagnostics {
            issue_count: issues.len(),
            first_issue_path: first_issue.map(|issue| issue.path.clone()),
            first_issue_message: first_issue
                .map(|_| "observer draft validation failed; response details withheld".into()),
            occurred_at_epoch: current_time_millis(),
        };
        *recover_write_lock(
            &self.memory_observer_last_validation_failure,
            "memory_observer_last_validation_failure",
        ) = Some(diagnostics);
    }

    fn record_memory_observer_validation_failure_event(
        &self,
        bundle: &MemoryObserverEventBundle,
        issues: &[MemoryObserverDraftValidationIssue],
    ) {
        let first_issue = issues.first();
        self.record_memory_observer_event_log(
            "validation_failure",
            Some(bundle),
            serde_json::json!({
                "issue_count": issues.len(),
                "first_issue_path": first_issue.map(|issue| issue.path.as_str()),
                "first_issue_message": first_issue.map(|_| "observer draft validation failed; response details withheld"),
            }),
        );
    }

    fn record_memory_observer_model_success(&self) {
        let mut diagnostics = recover_write_lock(
            &self.memory_observer_worker_diagnostics,
            "memory_observer_worker_diagnostics",
        );
        diagnostics.model_successes = diagnostics.model_successes.saturating_add(1);
    }

    fn record_memory_observer_model_fallback(
        &self,
        kind: MemoryObserverModelFallbackKind,
        reason: impl Into<String>,
    ) {
        let mut diagnostics = recover_write_lock(
            &self.memory_observer_worker_diagnostics,
            "memory_observer_worker_diagnostics",
        );
        diagnostics.model_fallbacks = diagnostics.model_fallbacks.saturating_add(1);
        match kind {
            MemoryObserverModelFallbackKind::Provider => {
                diagnostics.model_provider_failures =
                    diagnostics.model_provider_failures.saturating_add(1);
            }
            MemoryObserverModelFallbackKind::Parse => {
                diagnostics.model_parse_failures =
                    diagnostics.model_parse_failures.saturating_add(1);
            }
            MemoryObserverModelFallbackKind::Validation => {
                diagnostics.model_validation_failures =
                    diagnostics.model_validation_failures.saturating_add(1);
            }
        }
        diagnostics.last_fallback_reason = Some(reason.into());
        diagnostics.last_fallback_at_epoch = Some(current_time_millis());
    }

    fn record_memory_observer_model_fallback_event(
        &self,
        bundle: &MemoryObserverEventBundle,
        kind: MemoryObserverModelFallbackKind,
        reason: impl Into<String>,
        phase: MemoryObserverFailurePhase,
        failure: Option<&kcoder_types::ProviderFailureDetails>,
    ) {
        self.record_memory_observer_event_log(
            "model_fallback",
            Some(bundle),
            serde_json::json!({
                "kind": memory_observer_model_fallback_kind_name(kind),
                "reason": reason.into(),
                "purpose": "memory_observer",
                "phase": phase,
                "failure": failure,
                "outcome": "deterministic_fallback",
            }),
        );
    }
}

fn append_memory_observer_event_log_line(path: &Path, line: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{line}")?;
    Ok(())
}

#[cfg(test)]
#[path = "tests/memory_observer_unit.rs"]
mod tests;
