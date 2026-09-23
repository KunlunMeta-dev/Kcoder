use super::*;

#[derive(Clone)]
struct SessionMemoryUpdateJob {
    summary_provider: Arc<dyn Provider>,
    summary_model: String,
    request: MessagesRequest,
    summary_path: PathBuf,
    update_end: usize,
    model_visible_tokens: usize,
    prior_snapshot: Option<SessionMemorySnapshot>,
    prefix_signature: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionMemoryUpdateOutcome {
    Updated,
    Skipped(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionMemoryWaitOutcome {
    NotRunning,
    Completed,
    Stale,
    TimedOut,
}

impl QueryEngine {
    /// Schedule the per-session memory refresh after a completed
    /// turn without blocking the user's next action.
    pub(super) fn maybe_spawn_session_memory_update(
        &self,
        turn_count: usize,
        recent_tools: &[String],
    ) {
        let _admission = recover_read_lock(&self.memory_idle_gate, "memory_idle_gate");
        if self.memory_idle_reserved.load(Ordering::SeqCst) {
            return;
        }
        let Some(job) = self.prepare_session_memory_update(turn_count, recent_tools) else {
            return;
        };

        if self
            .session_memory_update_running
            .swap(true, Ordering::SeqCst)
        {
            return;
        }
        self.mark_session_memory_update_started();

        let engine = self.clone();
        let handle = tokio::spawn(async move {
            let result = engine.run_session_memory_update_job(job).await;
            engine.mark_session_memory_update_finished();
            match result {
                Ok(SessionMemoryUpdateOutcome::Updated) => {
                    debug!("background session-memory update completed");
                }
                Ok(SessionMemoryUpdateOutcome::Skipped(reason)) => {
                    debug!("background session-memory update skipped: {}", reason);
                }
                Err(error) => {
                    warn!("background session-memory update failed: {}", error);
                }
            }
        });
        *self
            .session_memory_update_handle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
    }

    fn mark_session_memory_update_started(&self) {
        let mut started_at = self
            .session_memory_update_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *started_at = Some(Instant::now());
    }

    pub(super) fn mark_session_memory_update_finished(&self) {
        self.session_memory_update_running
            .store(false, Ordering::SeqCst);
        {
            let mut started_at = self
                .session_memory_update_started_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *started_at = None;
        }
        self.session_memory_update_notify.notify_waiters();
    }

    fn session_memory_update_age(&self) -> Option<Duration> {
        let started_at = self
            .session_memory_update_started_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        started_at.map(|started| started.elapsed())
    }

    pub(super) async fn wait_for_session_memory_update_before_compact(&self) {
        let _ = self
            .wait_for_session_memory_update_before_compact_with_limits(
                SESSION_MEMORY_COMPACT_WAIT_TIMEOUT,
                SESSION_MEMORY_UPDATE_STALE_AFTER,
            )
            .await;
    }

    async fn wait_for_session_memory_update_before_compact_with_limits(
        &self,
        wait_timeout: Duration,
        stale_after: Duration,
    ) -> SessionMemoryWaitOutcome {
        let wait_started_at = Instant::now();
        let mut observed_running = false;
        loop {
            let notified = self.session_memory_update_notify.notified();
            if !self.session_memory_update_running.load(Ordering::SeqCst) {
                return if observed_running {
                    SessionMemoryWaitOutcome::Completed
                } else {
                    SessionMemoryWaitOutcome::NotRunning
                };
            }
            observed_running = true;

            match self.session_memory_update_age() {
                Some(age) if age >= stale_after => {
                    warn!(
                        "session-memory update is stale after {:?}; compact will continue with current summary",
                        age
                    );
                    return SessionMemoryWaitOutcome::Stale;
                }
                Some(_) => {}
                None => return SessionMemoryWaitOutcome::NotRunning,
            }

            let elapsed = wait_started_at.elapsed();
            if elapsed >= wait_timeout {
                warn!(
                    "timed out waiting {:?} for session-memory update before compact; continuing",
                    wait_timeout
                );
                return SessionMemoryWaitOutcome::TimedOut;
            }
            let remaining = wait_timeout.saturating_sub(elapsed);
            if timeout(remaining, notified).await.is_err() {
                warn!(
                    "timed out waiting {:?} for session-memory update before compact; continuing",
                    wait_timeout
                );
                return SessionMemoryWaitOutcome::TimedOut;
            }
        }
    }

    fn prepare_session_memory_update(
        &self,
        turn_count: usize,
        recent_tools: &[String],
    ) -> Option<SessionMemoryUpdateJob> {
        let settings = {
            let settings = recover_read_lock(&self.settings, "settings");
            if settings.training_mode {
                return None;
            }
            settings.session_memory.clone()
        };
        if !settings.enabled || !settings.update_enabled {
            return None;
        }
        if settings.update_interval_turns > 1
            && !turn_count.is_multiple_of(settings.update_interval_turns)
        {
            return None;
        }

        let all_messages = self.state.messages();
        let visible_start = latest_compact_boundary(&all_messages)
            .map(|boundary| boundary.summary_index)
            .unwrap_or(0);
        let model_visible_messages = &all_messages[visible_start..];
        if !model_visible_messages.iter().any(message_has_text) {
            return None;
        }
        let model_visible_tokens = TokenCounter::count(model_visible_messages);
        let prior_snapshot = self.state.session_memory();
        let update_start = prior_snapshot
            .as_ref()
            .map(|snapshot| snapshot.updated_message_count)
            .unwrap_or(visible_start)
            .max(visible_start)
            .min(all_messages.len());
        let has_pending_backlog = prior_snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.pending_update_backlog && update_start < all_messages.len()
        });
        let token_gate_passed = match prior_snapshot.as_ref() {
            Some(snapshot) => {
                has_pending_backlog
                    || model_visible_tokens
                        >= snapshot
                            .updated_model_tokens
                            .saturating_add(settings.update_min_token_delta)
            }
            None => model_visible_tokens >= settings.init_min_tokens,
        };
        if !token_gate_passed {
            return None;
        }
        let has_tool_threshold = recent_tools.len() >= settings.tool_call_threshold;
        let has_natural_break = all_messages.last().is_some_and(|message| {
            matches!(message, Message::Assistant { content, .. } if !content.iter().any(|block| matches!(block, ContentBlock::ToolUse { .. })))
        });
        if prior_snapshot.is_some()
            && !has_pending_backlog
            && !has_tool_threshold
            && !has_natural_break
        {
            return None;
        }

        let update_end = all_messages
            .len()
            .min(update_start.saturating_add(settings.max_update_messages.max(1)));
        if update_start >= update_end {
            return None;
        }
        let update_messages = &all_messages[update_start..update_end];
        let summary_path = self.state.session_memory_summary_path().unwrap_or_else(|| {
            kcoder_state::session_memory_summary_path(&self.cwd, &self.state.session_id())
        });
        let current_notes = match fs::read_to_string(&summary_path) {
            Ok(content) => content,
            Err(_) => DEFAULT_SESSION_MEMORY_TEMPLATE.to_string(),
        };

        let (_, summary_model, summary_runtime_max_tokens, summary_provider) =
            match self.summary_runtime() {
                Ok(runtime) => runtime,
                Err(error) => {
                    warn!("failed to build session-memory update runtime: {}", error);
                    return None;
                }
            };

        let prompt = build_session_memory_update_prompt(Some(&current_notes), update_messages);
        let request = MessagesRequest::new(&summary_model, vec![Message::user_text(prompt)])
            .with_max_tokens(
                settings
                    .update_max_tokens
                    .min(summary_runtime_max_tokens)
                    .max(1),
            )
            .with_debug_session_id(self.state.session_id());
        Some(SessionMemoryUpdateJob {
            summary_provider,
            summary_model,
            request,
            summary_path,
            update_end,
            model_visible_tokens,
            prior_snapshot,
            prefix_signature: session_memory_prefix_signature(&all_messages, update_end),
        })
    }

    async fn run_session_memory_update_job(
        &self,
        job: SessionMemoryUpdateJob,
    ) -> Result<SessionMemoryUpdateOutcome> {
        let SessionMemoryUpdateJob {
            summary_provider,
            summary_model,
            request,
            summary_path,
            update_end,
            model_visible_tokens,
            prior_snapshot,
            prefix_signature,
        } = job;
        let permit = match crate::request_admission::acquire(
            &summary_provider,
            crate::request_admission::RequestClass::SessionMemory,
        )
        .await
        {
            Ok(permit) => permit,
            Err(error) => return Ok(SessionMemoryUpdateOutcome::Skipped(error.to_string())),
        };
        let diagnostic_request = kcoder_state::DiagnosticRequest::new(request);
        let request = diagnostic_request.request().clone();
        let mut capture = self
            .state
            .begin_llm_exchange(diagnostic_request, true)
            .await;
        let mut stream = match summary_provider.stream_messages(request) {
            Ok(stream) => permit.wrap(default_timed_stream(stream)),
            Err(error) => {
                capture.finish_with_summary(error.safe_summary());
                return Err(anyhow::Error::new(error)
                    .context("failed to start session-memory update stream"));
            }
        };

        let mut raw = String::new();
        while let Some(event) = stream.next().await {
            if let Ok(event) = &event {
                capture.observe(event);
            }
            match event {
                Ok(StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::TextDelta { text },
                    ..
                }) => raw.push_str(&text),
                Ok(StreamEvent::MessageStop) => break,
                Ok(StreamEvent::Error { error }) => {
                    let error_text = error.safe_summary();
                    warn!("{}", error_text);
                    capture.finish_with_summary(kcoder_types::ProviderErrorSummary::new(
                        &error.error_type,
                        None,
                    ));
                    return Err(anyhow::Error::new(kcoder_api::ApiErrorKind::Api {
                        error_type: error.error_type,
                        message: error.message,
                    })
                    .context("API error during session-memory update"));
                }
                Err(error) => {
                    capture.finish_with_summary(error.safe_summary());
                    return Err(anyhow::Error::new(error)
                        .context("stream error during session-memory update"));
                }
                _ => {}
            }
        }

        let updated_notes = extract_session_memory_markdown(&raw);
        if updated_notes.trim().is_empty() {
            capture.finish(Some("session-memory update returned empty markdown"));
            anyhow::bail!("session-memory update returned empty markdown");
        }
        if !session_memory_has_required_sections(&updated_notes) {
            capture.finish(Some(
                "session-memory update returned markdown without required sections",
            ));
            anyhow::bail!("session-memory update returned markdown without required sections");
        }
        capture.finish(None);

        let current_messages = self.state.messages();
        if update_end > current_messages.len()
            || session_memory_prefix_signature(&current_messages, update_end) != prefix_signature
        {
            return Ok(SessionMemoryUpdateOutcome::Skipped(
                "conversation changed before update finished".to_string(),
            ));
        }

        if let Some(parent) = summary_path.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                anyhow::bail!(
                    "failed to create session-memory directory {:?}: {}",
                    parent,
                    error
                );
            }
            kcoder_config::set_user_only_dir_permissions(parent).with_context(|| {
                format!(
                    "failed to secure session-memory directory {:?} before writing",
                    parent
                )
            })?;
        }
        if let Err(error) = fs::write(&summary_path, updated_notes) {
            anyhow::bail!(
                "failed to write session-memory summary {:?}: {}",
                summary_path,
                error
            );
        }
        if let Err(error) = kcoder_config::set_user_only_file_permissions(&summary_path) {
            let _ = fs::remove_file(&summary_path);
            return Err(error).with_context(|| {
                format!(
                    "failed to secure session-memory summary {:?} after writing",
                    summary_path
                )
            });
        }

        let update_count = prior_snapshot
            .as_ref()
            .map(|snapshot| snapshot.update_count.saturating_add(1))
            .unwrap_or(1);
        self.state.set_session_memory(
            SessionMemorySnapshot::new(
                summary_path,
                update_end,
                if update_end == current_messages.len() {
                    model_visible_tokens
                } else {
                    prior_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.updated_model_tokens)
                        .unwrap_or(0)
                },
                update_count,
                format!("model:{summary_model}"),
            )
            .with_pending_update_backlog(update_end < current_messages.len()),
        );
        Ok(SessionMemoryUpdateOutcome::Updated)
    }
}

fn session_memory_prefix_signature(messages: &[Message], end: usize) -> u64 {
    let mut hasher = DefaultHasher::new();
    end.hash(&mut hasher);
    for message in messages.iter().take(end) {
        match message {
            Message::User { .. } => "user".hash(&mut hasher),
            Message::Assistant { .. } => "assistant".hash(&mut hasher),
        }
        message.preview(20_000).hash(&mut hasher);
    }
    hasher.finish()
}

#[cfg(test)]
#[path = "tests/session_memory_runtime_unit.rs"]
mod tests;
