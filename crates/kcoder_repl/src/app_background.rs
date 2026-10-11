//! Background task hints, agent views, and sub-agent panel reconciliation.

use super::*;

impl ReplApp {
    pub(super) fn prune_background_job_hints(
        &mut self,
        live_ids: &std::collections::HashSet<String>,
    ) {
        self.background_job_hints
            .retain(|hint| live_ids.contains(&hint.id));
        self.background_job_progress
            .retain(|id, _| live_ids.contains(id));
        self.background_job_lifetimes
            .retain(|id, _| live_ids.contains(id));
    }

    /// Record a new background status hint. The hint list is capped at 16
    /// entries — older hints fall off the end so a long session does not leak
    /// memory.
    pub(super) fn record_background_job_hint(&mut self, hint: BackgroundJobHint) {
        const MAX_HINTS: usize = 16;
        // Stable workflow IDs are intentionally reused by /workflow resume.
        // Replace an earlier lifecycle hint instead of stacking duplicate
        // Running entries that one terminal event can never all complete.
        let replacing_existing = self
            .background_job_hints
            .iter()
            .any(|existing| existing.id == hint.id);
        self.background_job_hints
            .retain(|existing| existing.id != hint.id);
        self.background_job_progress.remove(&hint.id);
        if replacing_existing {
            self.background_job_lifetimes.remove(&hint.id);
        }
        self.background_job_hints.push(hint);
        if self.background_job_hints.len() > MAX_HINTS {
            let drop = self.background_job_hints.len() - MAX_HINTS;
            self.background_job_hints.drain(0..drop);
        }
    }

    /// Mark a previously-registered hint as completed or failed. Returns
    /// `true` if a hint with the given id was found and updated. The
    /// `error` argument is stored on the hint so status surfaces can show
    /// the failure reason without re-fetching the task record.
    pub(super) fn complete_background_job_hint(
        &mut self,
        id: &str,
        state: BackgroundJobHintState,
        error: Option<String>,
    ) -> bool {
        if let Some(hint) = self.background_job_hints.iter_mut().find(|h| h.id == id) {
            hint.state = state;
            hint.error = error;
            self.background_job_progress.remove(id);
            self.background_job_lifetimes.remove(id);
            return true;
        }
        false
    }

    pub(super) fn update_background_job_progress(
        &mut self,
        id: &str,
        message: String,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        if !self
            .background_job_hints
            .iter()
            .any(|hint| hint.id == id && hint.state == BackgroundJobHintState::Running)
        {
            return false;
        }
        let now = Instant::now();
        if let Some(progress) = self.background_job_progress.get_mut(id) {
            let changed = progress.message != message
                || progress.current != current
                || progress.total != total;
            progress.message = message;
            progress.current = current;
            progress.total = total;
            progress.updated_at = now;
            return changed;
        }
        self.background_job_progress.insert(
            id.to_string(),
            BackgroundJobProgressHint {
                message,
                current,
                total,
                updated_at: now,
            },
        );
        true
    }

    pub(super) fn update_background_job_lifetime_from_tool_result(&mut self, text: &str) -> bool {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return false;
        };
        let Some(task_id) = value.get("task_id").and_then(serde_json::Value::as_str) else {
            return false;
        };
        let Some(total_ms) = value
            .get("total_lifetime_ms")
            .and_then(serde_json::Value::as_u64)
        else {
            return false;
        };
        let Some(expires_at_ms) = value
            .get("expires_at_ms")
            .and_then(serde_json::Value::as_u64)
        else {
            return false;
        };
        if value.get("status").and_then(serde_json::Value::as_str) != Some("running")
            || value
                .get("lifecycle_scope")
                .and_then(serde_json::Value::as_str)
                != Some("kcoder_session")
        {
            return false;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        self.background_job_lifetimes.insert(
            task_id.to_string(),
            BackgroundJobLifetimeHint {
                total_timeout: Duration::from_millis(total_ms),
                deadline: Instant::now()
                    + Duration::from_millis(expires_at_ms.saturating_sub(now_ms)),
            },
        );
        true
    }

    pub(super) fn push_subagent_pending(
        &mut self,
        tool_call_id: String,
        name: String,
        input: String,
    ) {
        self.spinner.mark_tool();
        self.drain_pending_streaming_text_all();
        self.streaming_message_done_pending = false;
        self.commit_streaming_thinking_summary();
        self.commit_streaming_text();
        self.consolidate_finished_assistant_stream();
        self.start_streaming_message();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.turn_had_work_activity = true;

        let delivery = subagent_requested_delivery(&input);
        let item_text = subagent_item_text(&name, &input);
        let reusable_panel_id = self.open_subagent_panel.filter(|panel_id| {
            self.subagent_panels
                .get(panel_id)
                .is_some_and(|panel| !panel.all_terminal())
        });
        let panel_id = reusable_panel_id.unwrap_or_else(|| {
            let id = self.next_subagent_panel_id;
            self.next_subagent_panel_id = self.next_subagent_panel_id.wrapping_add(1).max(1);
            self.subagent_panels.insert(id, SubagentPanel::new(id));
            self.subagent_animation_started_at = Instant::now();
            self.open_subagent_panel = Some(id);
            id
        });
        let panel = self
            .subagent_panels
            .entry(panel_id)
            .or_insert_with(|| SubagentPanel::new(panel_id));
        panel.add_pending(tool_call_id.clone(), item_text, delivery);
        self.sync_subagent_panel(panel_id);
        let pending_agent = self.pending_subagent_associations.iter().find_map(
            |(agent_id, (pending_tool_call_id, run_in_background))| {
                (pending_tool_call_id == &tool_call_id)
                    .then_some((agent_id.clone(), *run_in_background))
            },
        );
        if let Some((agent_id, run_in_background)) = pending_agent {
            self.pending_subagent_associations.remove(&agent_id);
            self.associate_subagent_panel(&agent_id, &tool_call_id, run_in_background);
        }
    }

    pub(super) fn convert_running_tool_to_subagent_panel(
        &mut self,
        tool_call_id: String,
        name: String,
        input: String,
    ) -> bool {
        let Some(entry_index) = self.active_turn.as_ref().and_then(|active| {
            active.entries.iter().rposition(|entry| {
                matches!(
                    entry,
                    ActiveEntry::Tool(ToolStatus::Running { id, .. }) if id == &tool_call_id
                )
            })
        }) else {
            return false;
        };

        let panel_id = self.next_subagent_panel_id;
        self.next_subagent_panel_id = self.next_subagent_panel_id.wrapping_add(1).max(1);
        let mut panel = SubagentPanel::new(panel_id);
        panel.add_pending(
            tool_call_id.clone(),
            subagent_item_text(&name, &input),
            SubagentDelivery::Background,
        );
        if let Some(active) = self.active_turn.as_mut() {
            active.entries[entry_index] = ActiveEntry::SubagentPanel(panel.clone());
        }
        self.subagent_panels.insert(panel_id, panel);
        self.open_subagent_panel = Some(panel_id);
        self.subagent_animation_started_at = Instant::now();

        let pending_agent = self.pending_subagent_associations.iter().find_map(
            |(agent_id, (pending_tool_call_id, run_in_background))| {
                (pending_tool_call_id == &tool_call_id)
                    .then_some((agent_id.clone(), *run_in_background))
            },
        );
        if let Some((agent_id, run_in_background)) = pending_agent {
            self.pending_subagent_associations.remove(&agent_id);
            self.associate_subagent_panel(&agent_id, &tool_call_id, run_in_background);
        } else {
            self.bump_active_turn_render_revision();
            self.fullscreen_transcript_render_cache = None;
            if self.transcript_viewport.is_at_tail() {
                self.snap_to_bottom();
            }
        }
        true
    }

    pub(super) fn associate_subagent_panel(
        &mut self,
        agent_id: &str,
        tool_call_id: &str,
        run_in_background: bool,
    ) -> bool {
        let delivery = if run_in_background {
            SubagentDelivery::Background
        } else {
            SubagentDelivery::Foreground
        };
        let Some(panel_id) = self
            .subagent_panels
            .iter()
            .find_map(|(id, panel)| panel.has_tool_call(tool_call_id).then_some(*id))
        else {
            self.detach_subagent_routing_for_continuation(agent_id);
            const MAX_PENDING_ASSOCIATIONS: usize = 32;
            if self.pending_subagent_associations.len() >= MAX_PENDING_ASSOCIATIONS
                && let Some(oldest) = self.pending_subagent_associations.keys().next().cloned()
            {
                self.pending_subagent_associations.remove(&oldest);
            }
            self.pending_subagent_associations.insert(
                agent_id.to_string(),
                (tool_call_id.to_string(), run_in_background),
            );
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.associate(tool_call_id, agent_id, delivery));
        if changed {
            self.subagent_panel_by_agent
                .insert(agent_id.to_string(), panel_id);
            if let Some(pending) = self.pending_subagent_progress.remove(agent_id)
                && let Some(panel) = self.subagent_panels.get_mut(&panel_id)
            {
                panel.update_progress(
                    agent_id,
                    &pending.message,
                    pending.detail.as_deref(),
                    pending.current,
                    pending.total,
                );
                if pending.promoted {
                    panel.promote(agent_id);
                }
            }
            if let Some((phase, status)) = self.pending_subagent_terminal.remove(agent_id)
                && let Some(panel) = self.subagent_panels.get_mut(&panel_id)
            {
                panel.finish(agent_id, phase, status);
            }
            if let Some(applied) = self.pending_subagent_steer_applied.remove(agent_id)
                && let Some(panel) = self.subagent_panels.get_mut(&panel_id)
            {
                panel.apply_steer(agent_id, &applied.message_id, applied.queue_depth);
            }
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn detach_subagent_routing_for_continuation(&mut self, agent_id: &str) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.remove(agent_id) else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| {
                panel.finish(agent_id, SubagentPhase::Completed, "Previous run finished")
            });
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        true
    }

    pub(super) fn update_subagent_panel_progress(
        &mut self,
        agent_id: &str,
        message: &str,
        detail: Option<&str>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            const MAX_PENDING_PROGRESS: usize = 32;
            if self.pending_subagent_progress.len() >= MAX_PENDING_PROGRESS
                && let Some(oldest) = self.pending_subagent_progress.keys().next().cloned()
            {
                self.pending_subagent_progress.remove(&oldest);
            }
            self.pending_subagent_progress.insert(
                agent_id.to_string(),
                PendingSubagentProgress {
                    message: message.to_string(),
                    detail: detail.map(str::to_string),
                    current,
                    total,
                    promoted: false,
                },
            );
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.update_progress(agent_id, message, detail, current, total));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn promote_subagent_panel(&mut self, agent_id: &str) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            self.pending_subagent_progress
                .entry(agent_id.to_string())
                .or_insert_with(|| PendingSubagentProgress {
                    message: "Running in background".to_string(),
                    detail: None,
                    current: None,
                    total: None,
                    promoted: true,
                })
                .promoted = true;
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.promote(agent_id));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn apply_subagent_steer_to_panel(
        &mut self,
        agent_id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        if let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        {
            view.steer_status = Some("Steering applied".to_string());
        }
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            const MAX_PENDING_STEER_EVENTS: usize = 32;
            if self.pending_subagent_steer_applied.len() >= MAX_PENDING_STEER_EVENTS
                && let Some(oldest) = self.pending_subagent_steer_applied.keys().next().cloned()
            {
                self.pending_subagent_steer_applied.remove(&oldest);
            }
            self.pending_subagent_steer_applied.insert(
                agent_id.to_string(),
                PendingSubagentSteerApplied {
                    message_id: message_id.to_string(),
                    queue_depth,
                },
            );
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.apply_steer(agent_id, message_id, queue_depth));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn queue_subagent_steer_in_panel(
        &mut self,
        agent_id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        if let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        {
            view.steer_status = Some("Steering queued".to_string());
        }
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.queue_steer(agent_id, message_id, queue_depth));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn set_agent_view_steer_status(
        &mut self,
        agent_id: &str,
        status: impl Into<String>,
    ) -> bool {
        let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        else {
            return false;
        };
        view.steer_status = Some(status.into());
        self.force_next_viewport_redraw();
        true
    }

    #[cfg(test)]
    pub(super) fn enter_agent_view(&mut self, agent_id: String, display_name: String) {
        self.enter_agent_view_with_transcript(
            agent_id,
            display_name,
            PathBuf::new(),
            Vec::new(),
            None,
        );
    }

    pub(super) fn enter_agent_view_with_transcript(
        &mut self,
        agent_id: String,
        display_name: String,
        transcript_path: PathBuf,
        messages: Vec<Message>,
        fingerprint: Option<AgentTranscriptFingerprint>,
    ) {
        if self.agent_view.is_some() {
            self.leave_agent_view();
        }
        let parent_viewport = std::mem::take(&mut self.transcript_viewport);
        self.close_outline();
        let parent_navigation = std::mem::take(&mut self.navigation);
        let parent_outline = std::mem::take(&mut self.outline);
        self.transcript_viewport.snap_to_bottom();
        self.agent_view = Some(AgentViewState {
            live_revision: None,
            agent_id,
            display_name,
            steer_status: None,
            transcript_path,
            transcript: Self::project_agent_transcript(&messages),
            fingerprint,
            pending_steers: Vec::new(),
            parent_viewport,
            parent_navigation,
            parent_outline,
            refresh_after: Instant::now(),
            load_error: None,
        });
        self.invalidate_transcript_rendering();
    }

    pub(super) async fn enter_agent_view_from_task(
        &mut self,
        engine: &QueryEngine,
        agent_id: String,
        display_name: String,
    ) -> Result<(), String> {
        let transcript_path = engine
            .state
            .task(&agent_id)
            .and_then(|task| task.transcript_path)
            .unwrap_or_else(|| engine.state.subagent_transcript_path(&agent_id));
        let (messages, fingerprint) = match tokio::fs::read(&transcript_path).await {
            Ok(bytes) => {
                let messages = serde_json::from_slice::<Vec<Message>>(&bytes)
                    .map_err(|error| format!("failed to parse child transcript: {error}"))?;
                let fingerprint =
                    tokio::fs::metadata(&transcript_path)
                        .await
                        .ok()
                        .map(|metadata| AgentTranscriptFingerprint {
                            len: metadata.len(),
                            modified: metadata.modified().ok(),
                        });
                (messages, fingerprint)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(error) => {
                return Err(format!(
                    "failed to read child transcript {}: {error}",
                    transcript_path.display()
                ));
            }
        };
        self.enter_agent_view_with_transcript(
            agent_id,
            display_name,
            transcript_path,
            messages,
            fingerprint,
        );
        self.refresh_agent_view_transcript(engine, true).await;
        Ok(())
    }

    pub(super) fn project_agent_transcript(messages: &[Message]) -> TranscriptStore {
        let mut projection = ReplApp::default();
        projection.replace_transcript_from_history(messages);
        projection.messages
    }

    pub(super) fn apply_agent_live_snapshot(
        &mut self,
        snapshot: kcoder_engine::agent_live_view::AgentLiveSnapshot,
    ) -> bool {
        self.preserve_review_before_content_change();
        let Some(view) = self.agent_view.as_mut() else {
            return false;
        };
        let mut transcript = Self::project_agent_transcript(&snapshot.messages);
        if snapshot.text_truncated {
            transcript.push(DisplayMessage { role: MessageRole::System, text: "Live preview shows the latest 256 KiB; the complete response will appear when committed.".into() });
        }
        if !snapshot.pending_text.is_empty() {
            transcript.push(DisplayMessage {
                role: MessageRole::Assistant,
                text: snapshot.pending_text,
            });
        }
        for pending in &view.pending_steers {
            if !transcript
                .iter()
                .any(|message| message.role == MessageRole::User && message.text == pending.body)
            {
                transcript.push(DisplayMessage {
                    role: MessageRole::User,
                    text: pending.body.clone(),
                });
                transcript.push(DisplayMessage {
                    role: MessageRole::System,
                    text: format!("Steering queued · {}", pending.message_id),
                });
            }
        }
        transcript.push(DisplayMessage {
            role: MessageRole::System,
            text: format!("Agent status: {}", snapshot.phase),
        });
        view.transcript.reconcile_projection(&transcript);
        view.live_revision = Some(snapshot.revision);
        view.load_error = None;
        self.invalidate_agent_transcript_rendering();
        true
    }

    pub(super) fn invalidate_agent_transcript_rendering(&mut self) {
        // Snapshots only change content. Preserve the last painted wheel geometry without forcing a full-screen repaint.
        self.render_cache.clear();
        self.fullscreen_transcript_render_cache = None;
        self.transcript_row_index = TranscriptRowIndex::default();
        self.clear_transcript_selection();
    }

    pub(super) async fn refresh_agent_view_transcript(
        &mut self,
        engine: &QueryEngine,
        force: bool,
    ) -> bool {
        let Some(view) = self.agent_view.as_mut() else {
            return false;
        };
        let now = Instant::now();
        if !force && now < view.refresh_after {
            return false;
        }
        view.refresh_after = now + Duration::from_millis(250);
        let id = view.agent_id.clone();
        let previous = if force { None } else { view.live_revision };
        if let Some(snapshot) = engine.subagent_live_snapshot(&id, previous) {
            return self.apply_agent_live_snapshot(snapshot);
        }
        if engine.has_subagent_live_view(&id) {
            return false;
        }
        // Once the writer exits, reload the final durable checkpoint even if
        // its metadata matches the file observed before entering the live view.
        let force = force || view.live_revision.take().is_some();
        if view.transcript_path.as_os_str().is_empty() {
            return false;
        }
        let transcript_path = view.transcript_path.clone();
        let previous_fingerprint = view.fingerprint;
        let metadata = match tokio::fs::metadata(&transcript_path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(error) => {
                view.load_error = Some(error.to_string());
                return true;
            }
        };
        let fingerprint = AgentTranscriptFingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        };
        if !force && previous_fingerprint == Some(fingerprint) {
            return false;
        }
        let bytes = match tokio::fs::read(&transcript_path).await {
            Ok(bytes) => bytes,
            Err(error) => {
                if let Some(view) = self.agent_view.as_mut() {
                    view.load_error = Some(error.to_string());
                }
                return true;
            }
        };
        let messages = match serde_json::from_slice::<Vec<Message>>(&bytes) {
            Ok(messages) => messages,
            Err(error) => {
                if let Some(view) = self.agent_view.as_mut() {
                    view.load_error = Some(error.to_string());
                }
                return true;
            }
        };
        let pending_steers = self
            .agent_view
            .as_ref()
            .map(|view| view.pending_steers.clone())
            .unwrap_or_default();
        let mut transcript = Self::project_agent_transcript(&messages);
        for pending in &pending_steers {
            if !transcript
                .iter()
                .any(|message| message.role == MessageRole::User && message.text == pending.body)
            {
                transcript.push(DisplayMessage {
                    role: MessageRole::User,
                    text: pending.body.clone(),
                });
            }
            transcript.push(DisplayMessage {
                role: MessageRole::System,
                text: format!("Steering queued · {}", pending.message_id),
            });
        }
        self.preserve_review_before_content_change();
        let Some(view) = self.agent_view.as_mut() else {
            return false;
        };
        view.transcript.reconcile_projection(&transcript);
        view.fingerprint = Some(fingerprint);
        view.load_error = None;
        self.invalidate_agent_transcript_rendering();
        true
    }

    pub(super) fn queue_agent_view_steer(
        &mut self,
        agent_id: &str,
        message_id: &str,
        body: &str,
    ) -> bool {
        let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        else {
            return false;
        };
        if view
            .pending_steers
            .iter()
            .any(|pending| pending.message_id == message_id)
        {
            return false;
        }
        let body = sanitize_tui_text(body);
        view.pending_steers.push(PendingAgentViewSteer {
            message_id: message_id.to_string(),
            body: body.clone(),
        });
        view.transcript.push(DisplayMessage {
            role: MessageRole::User,
            text: body,
        });
        view.transcript.push(DisplayMessage {
            role: MessageRole::System,
            text: format!("Steering queued · {message_id}"),
        });
        self.invalidate_transcript_rendering();
        true
    }

    pub(super) fn finish_agent_view_steer(&mut self, agent_id: &str, message_id: &str) -> bool {
        let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        else {
            return false;
        };
        let before = view.pending_steers.len();
        view.pending_steers
            .retain(|pending| pending.message_id != message_id);
        before != view.pending_steers.len()
    }

    pub(super) fn leave_agent_view(&mut self) -> bool {
        let Some(view) = self.agent_view.take() else {
            return false;
        };
        self.transcript_viewport = view.parent_viewport;
        self.close_outline();
        self.navigation = view.parent_navigation;
        self.outline = view.parent_outline;
        self.invalidate_transcript_rendering();
        true
    }

    pub(super) fn viewed_agent_id(&self) -> Option<&str> {
        self.agent_view.as_ref().map(|view| view.agent_id.as_str())
    }

    pub(super) fn pause_subagent_panel(
        &mut self,
        agent_id: &str,
        status: &str,
        detail: Option<&str>,
    ) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.pause(agent_id, status, detail));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn restart_subagent_panel(
        &mut self,
        agent_id: &str,
        delivery: SubagentDelivery,
    ) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.restart(agent_id, delivery));
        if changed {
            self.subagent_animation_started_at = Instant::now();
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn finish_subagent_panel(
        &mut self,
        agent_id: &str,
        phase: SubagentPhase,
        status: impl Into<String>,
    ) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            const MAX_PENDING_TERMINALS: usize = 32;
            if self.pending_subagent_terminal.len() >= MAX_PENDING_TERMINALS
                && let Some(oldest) = self.pending_subagent_terminal.keys().next().cloned()
            {
                self.pending_subagent_terminal.remove(&oldest);
            }
            self.pending_subagent_terminal
                .entry(agent_id.to_string())
                .or_insert_with(|| (phase, status.into()));
            return false;
        };
        let status = status.into();
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.finish(agent_id, phase, status));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn finish_subagent_tool_call(
        &mut self,
        tool_call_id: &str,
        text: &str,
        is_error: bool,
    ) -> bool {
        let Some(panel_id) = self
            .subagent_panels
            .iter()
            .find_map(|(id, panel)| panel.has_tool_call(tool_call_id).then_some(*id))
        else {
            return false;
        };
        let result = parse_subagent_result(text, is_error);
        let agent_id = result.agent_id.clone();
        if let Some(agent_id) = agent_id.as_deref() {
            self.associate_subagent_panel(agent_id, tool_call_id, result.background);
        }
        if let (Some(agent_id), Some(detail)) = (agent_id.as_deref(), result.detail.as_deref()) {
            self.update_subagent_panel_progress(
                agent_id,
                "Writing response",
                Some(detail),
                None,
                None,
            );
        }
        let changed = match (agent_id.as_deref(), result.status.as_str()) {
            (Some(agent_id), "running" | "resuming") => self.promote_subagent_panel(agent_id),
            (_, "queued" | "finishing") => {
                self.subagent_panels
                    .get_mut(&panel_id)
                    .is_some_and(|panel| {
                        panel.finish_tool_call(
                            tool_call_id,
                            if is_error {
                                SubagentPhase::Failed
                            } else {
                                SubagentPhase::Completed
                            },
                            if is_error { "Failed" } else { "Completed" },
                        )
                    })
            }
            (Some(agent_id), "failed") => {
                self.finish_subagent_panel(agent_id, SubagentPhase::Failed, "Failed")
            }
            (Some(agent_id), "cancelled") => {
                self.finish_subagent_panel(agent_id, SubagentPhase::Cancelled, "Cancelled")
            }
            (Some(agent_id), _) => {
                self.finish_subagent_panel(agent_id, SubagentPhase::Completed, "Completed")
            }
            (None, "running" | "resuming") => false,
            (None, _) => self
                .subagent_panels
                .get_mut(&panel_id)
                .is_some_and(|panel| {
                    panel.finish_tool_call(
                        tool_call_id,
                        if is_error {
                            SubagentPhase::Failed
                        } else {
                            SubagentPhase::Completed
                        },
                        if is_error { "Failed" } else { "Completed" },
                    )
                }),
        };
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    pub(super) fn sync_subagent_panel(&mut self, panel_id: u64) {
        let Some(panel) = self.subagent_panels.get(&panel_id).cloned() else {
            return;
        };
        let mut found = false;
        if let Some(active) = self.active_turn.as_mut()
            && let Some(entry) = active.entries.iter_mut().find(|entry| {
                matches!(entry, ActiveEntry::SubagentPanel(candidate) if candidate.id == panel_id)
            })
        {
            *entry = ActiveEntry::SubagentPanel(panel.clone());
            found = true;
        }
        let encoded = panel.encode_message();
        if self.messages.replace_first(
            |message| panel_message_id(&message.text) == Some(panel_id),
            DisplayMessage {
                role: MessageRole::System,
                text: encoded.clone(),
            },
        ) {
            found = true;
        }
        if !found {
            self.start_streaming_message();
            if let Some(active) = self.active_turn.as_mut() {
                active.entries.push(ActiveEntry::SubagentPanel(panel));
            }
        }
        self.bump_active_turn_render_revision();
        self.fullscreen_transcript_render_cache = None;
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(super) fn reconcile_subagent_panels_from_engine(&mut self, engine: &QueryEngine) {
        let mut tasks = engine
            .state
            .tasks()
            .into_values()
            .filter(|task| task.managed && task.kind == TaskKind::Subagent)
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.created_at_ms);
        for task in tasks {
            let Some(tool_call_id) = task.parent_tool_call_id.as_deref() else {
                continue;
            };
            self.associate_subagent_panel(
                &task.id,
                tool_call_id,
                task.delivery == TaskDelivery::Background,
            );
            if matches!(
                task.status,
                TaskStatus::Pending | TaskStatus::Running | TaskStatus::Paused
            ) {
                self.restart_subagent_panel(
                    &task.id,
                    if task.delivery == TaskDelivery::Background {
                        SubagentDelivery::Background
                    } else {
                        SubagentDelivery::Foreground
                    },
                );
            }
            match task.status {
                TaskStatus::Unknown(_) => {
                    self.finish_subagent_panel(
                        &task.id,
                        SubagentPhase::Unknown,
                        "Unknown task state (read only)",
                    );
                }
                TaskStatus::Pending | TaskStatus::Running
                    if task.delivery == TaskDelivery::Background =>
                {
                    self.promote_subagent_panel(&task.id);
                    let detail = orchestrate_agent_status_detail(&task);
                    self.update_subagent_panel_progress(
                        &task.id,
                        "Running in background",
                        Some(&detail),
                        Some(1),
                        task.max_turns,
                    );
                }
                TaskStatus::Pending | TaskStatus::Running => {
                    let detail = orchestrate_agent_status_detail(&task);
                    self.update_subagent_panel_progress(
                        &task.id,
                        "Running",
                        Some(&detail),
                        Some(1),
                        task.max_turns,
                    );
                }
                TaskStatus::Paused => {
                    let detail = orchestrate_agent_status_detail(&task);
                    self.pause_subagent_panel(&task.id, "Paused at a safe boundary", Some(&detail));
                }
                TaskStatus::Halted => {
                    self.finish_subagent_panel(&task.id, SubagentPhase::Halted, "Halted");
                }
                TaskStatus::Completed => {
                    self.finish_subagent_panel(&task.id, SubagentPhase::Completed, "Completed");
                }
                TaskStatus::Failed => {
                    self.finish_subagent_panel(
                        &task.id,
                        SubagentPhase::Failed,
                        task.output.as_deref().unwrap_or("Failed"),
                    );
                }
                TaskStatus::Cancelled => {
                    self.finish_subagent_panel(&task.id, SubagentPhase::Cancelled, "Cancelled");
                }
            }
        }
    }

    pub(super) fn latest_background_job_progress(&self) -> Option<&BackgroundJobProgressHint> {
        self.background_job_hints
            .iter()
            .filter(|hint| hint.state == BackgroundJobHintState::Running)
            .filter_map(|hint| self.background_job_progress.get(&hint.id))
            .max_by_key(|progress| progress.updated_at)
    }

    pub(super) fn tiny_terminal_subagent_status(&self, width: u16, height: u16) -> Option<String> {
        const FULL_PANEL_MIN_TERMINAL_HEIGHT: u16 = 18;
        (height < FULL_PANEL_MIN_TERMINAL_HEIGHT)
            .then(|| self.subagent_panels.values().max_by_key(|panel| panel.id))
            .flatten()
            .map(|panel| compact_panel_status(panel, width))
    }

    /// Public accessor used by status renderers.
    pub fn background_job_hints(&self) -> &[BackgroundJobHint] {
        &self.background_job_hints
    }

    pub(super) fn background_status_label(&self) -> String {
        let mut agent_running = 0usize;
        let mut agent_failed = 0usize;
        let mut task_running = 0usize;
        let mut task_failed = 0usize;

        for hint in &self.background_job_hints {
            let is_tool_task =
                kcoder_tools::background::is_tool_background_task_description(&hint.description);
            match (is_tool_task, hint.state) {
                (true, BackgroundJobHintState::Running) => task_running += 1,
                (true, BackgroundJobHintState::Failed) => task_failed += 1,
                (false, BackgroundJobHintState::Running) => agent_running += 1,
                (false, BackgroundJobHintState::Failed) => agent_failed += 1,
                (
                    _,
                    BackgroundJobHintState::Paused
                    | BackgroundJobHintState::Halted
                    | BackgroundJobHintState::Completed
                    | BackgroundJobHintState::Cancelled
                    | BackgroundJobHintState::Unknown,
                ) => {}
            }
        }

        let mut parts = Vec::new();
        if let Some(part) = background_status_group_label("agents", agent_running, agent_failed) {
            parts.push(part);
        }
        if let Some(part) = background_status_group_label("tasks", task_running, task_failed) {
            parts.push(part);
        }
        if let Some(progress) = self.latest_background_job_progress() {
            parts.push(progress.label());
        }
        let lifetime = self
            .background_job_hints
            .iter()
            .filter(|hint| {
                hint.state == BackgroundJobHintState::Running
                    && kcoder_tools::background::is_tool_background_task_description(
                        &hint.description,
                    )
            })
            .filter_map(|hint| self.background_job_lifetimes.get(&hint.id))
            .min_by_key(|lifetime| lifetime.deadline);
        if let Some(lifetime) = lifetime {
            parts.push(lifetime.label());
        }
        let quiet_for = self
            .background_job_hints
            .iter()
            .filter(|hint| hint.state == BackgroundJobHintState::Running)
            .filter_map(|hint| {
                self.background_job_progress
                    .get(&hint.id)
                    .map(|progress| progress.updated_at.elapsed())
                    .or_else(|| hint.started_at.map(|started| started.elapsed()))
            })
            .max()
            .filter(|elapsed| *elapsed >= Duration::from_secs(15));
        if let Some(quiet_for) = quiet_for {
            parts.push(format!(
                "no background update {}",
                format_worked_duration(quiet_for)
            ));
        }
        parts.join(" · ")
    }

    pub(super) fn has_running_background_job(&self) -> bool {
        self.background_job_hints
            .iter()
            .any(|hint| hint.state == BackgroundJobHintState::Running)
    }
}
