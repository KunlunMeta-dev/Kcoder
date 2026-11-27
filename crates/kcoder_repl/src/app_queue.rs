//! Queued input and steer acknowledgements; queue ownership remains on ReplApp.

use super::*;

impl ReplApp {
    pub(super) fn has_current_input_uncertainty(&self) -> bool {
        self.input_shutdown_uncertain
            && match (&self.input_uncertainty_owner, &self.input_session_owner) {
                (Some(original), Some(current)) => original.same_lifecycle(current),
                _ => true,
            }
    }

    pub(super) fn mark_input_uncertain_for(
        &mut self,
        owner: Option<kcoder_state::AppStateLifecycleIdentity>,
    ) {
        if let (Some(original), Some(current)) = (&owner, &self.input_session_owner)
            && !original.same_lifecycle(current)
        {
            return;
        }
        self.input_shutdown_uncertain = true;
        self.input_uncertainty_owner = owner;
    }

    pub(super) fn has_cancelled_input_barrier(&self) -> bool {
        self.has_current_input_uncertainty()
            || self.input_admission.as_ref().is_some_and(|admission| {
                admission.cancelled
                    && self
                        .input_session_owner
                        .as_ref()
                        .is_none_or(|owner| admission.owner.same_lifecycle(owner))
            })
    }

    pub(super) fn show_cancelled_input_notice(&mut self) {
        let text = if self.has_current_input_uncertainty() {
            crate::input_admission::UNCERTAIN_INPUT_NOTICE
        } else {
            crate::input_admission::CANCELLED_INPUT_NOTICE
        };
        if self
            .messages
            .iter()
            .rev()
            .take(4)
            .any(|message| message.role == MessageRole::System && message.text == text)
        {
            self.set_transient_status(text);
        } else {
            self.push_message(MessageRole::System, text);
        }
    }

    pub(super) fn show_unconfirmed_input_notice(&mut self) {
        if self.has_cancelled_input_barrier() {
            self.show_cancelled_input_notice();
        } else {
            self.push_message(MessageRole::System, "An input is still being saved. Wait or check the conversation before trying again.");
        }
    }

    pub(super) fn can_replace_input_owner(&self) -> bool {
        let guarded = self.input_admission.is_some() || self.has_current_input_uncertainty();
        let confirmed = self.input_admission.as_ref().is_some_and(|admission| {
            admission.observer.is_none()
                && admission.witness.is_some()
                && !self.has_current_input_uncertainty()
        });
        let admission_room = self.input_admission.is_none()
            || confirmed
            || self.retired_input_admissions.len() < crate::input_admission::MAX_RETIRED_ADMISSIONS;
        let pending_count = self.retired_queued_inputs.len()
            + self.retired_pending_steers.len()
            + self.user_message_queue.len()
            + self.rejected_turn_steers.len()
            + self.pending_turn_steers.len();
        admission_room
            && (!guarded || pending_count <= crate::input_admission::MAX_RETIRED_ADMISSIONS)
    }

    pub(super) fn retire_stale_input_admission(&mut self) -> bool {
        if !self.can_replace_input_owner() {
            return false;
        }
        if let Some(admission) = self.input_admission.take()
            && (admission.observer.is_some()
                || admission.witness.is_none()
                || self.has_current_input_uncertainty())
        {
            // Unknown outcomes retain their original observer; they are never reissued.
            self.retired_input_admissions.push(admission);
        }
        true
    }

    pub(super) fn install_input_owner(&mut self, owner: kcoder_state::AppStateLifecycleIdentity) {
        let changed = self
            .input_session_owner
            .as_ref()
            .is_none_or(|old| !old.same_lifecycle(&owner));
        if changed {
            if self.input_admission.is_some() || self.has_current_input_uncertainty() {
                self.retired_queued_inputs
                    .extend(self.user_message_queue.drain(..));
                self.retired_queued_inputs
                    .extend(self.rejected_turn_steers.drain(..));
                self.retired_pending_steers
                    .extend(self.pending_turn_steers.drain(..));
            }
            if self
                .input_admission
                .as_ref()
                .is_some_and(|admission| !admission.owner.same_lifecycle(&owner))
            {
                let retired = self.retire_stale_input_admission();
                debug_assert!(retired, "session replacement must reserve an observer slot");
            }
            if self
                .input_uncertainty_owner
                .as_ref()
                .is_some_and(|old| !old.same_lifecycle(&owner))
            {
                self.input_shutdown_uncertain = false;
                self.input_uncertainty_owner = None;
                self.input_unknown_diagnostic = None;
            }
            self.input_start_retry_at = None;
        }
        self.input_session_owner = Some(owner);
        self.sync_input_preparation_indicator();
    }

    pub(super) fn has_unconfirmed_input(&self) -> bool {
        self.input_admission.as_ref().is_some_and(|admission| {
            self.input_session_owner
                .as_ref()
                .is_none_or(|owner| admission.owner.same_lifecycle(owner))
        }) || self.has_current_input_uncertainty()
            || self.pending_turn_steers.iter().any(|pending| {
                pending.message.owner.as_ref().is_some_and(|owner| {
                    self.input_session_owner
                        .as_ref()
                        .is_none_or(|current| owner.same_lifecycle(current))
                })
            })
            || self
                .user_message_queue
                .iter()
                .chain(self.rejected_turn_steers.iter())
                .any(|queued| {
                    matches!(
                        queued.action,
                        QueuedInputAction::Admitting(_) | QueuedInputAction::Uncertain
                    ) && queued.owner.as_ref().is_none_or(|owner| {
                        self.input_session_owner
                            .as_ref()
                            .is_none_or(|current| owner.same_lifecycle(current))
                    })
                })
    }

    pub(super) fn has_running_side_questions(&mut self) -> bool {
        self.side_question_tasks
            .retain(|task| !task.handle.is_finished());
        !self.side_question_tasks.is_empty()
    }

    pub(super) fn cancel_side_questions_for(
        &mut self,
        owner: &kcoder_state::AppStateLifecycleIdentity,
    ) {
        for task in &self.side_question_tasks {
            if task.owner.same_lifecycle(owner) {
                task.cancel.cancel();
                task.handle.abort();
            }
        }
    }

    pub(super) fn cancel_all_side_questions(&mut self) {
        for task in &self.side_question_tasks {
            task.cancel.cancel();
            task.handle.abort();
        }
    }

    pub(super) fn hold_next_user_input(&mut self, reason: &str) {
        let front = if self.rejected_turn_steers.is_empty() {
            self.user_message_queue.front_mut()
        } else {
            self.rejected_turn_steers.front_mut()
        };
        if let Some(queued) = front {
            queued.action = QueuedInputAction::Held;
        }
        self.input_start_retry_at = None;
        self.sync_input_preparation_indicator();
        self.push_message(MessageRole::System, reason.to_string());
    }

    pub(super) fn cancel_preparing_inputs(&mut self) {
        self.input_preparation.cancel_all();
        if let Some(admission) = self.input_admission.as_mut() {
            admission.cancel_dispatch();
            let id = admission.id;
            for queued in self
                .user_message_queue
                .iter_mut()
                .chain(self.rejected_turn_steers.iter_mut())
            {
                if queued.action == QueuedInputAction::Admitting(id)
                    || queued.action == QueuedInputAction::Admitted(id)
                {
                    queued.action = QueuedInputAction::Uncertain;
                }
            }
        }
        if self.input_start_retry_at.take().is_some() {
            let front = if self.rejected_turn_steers.is_empty() {
                self.user_message_queue.front_mut()
            } else {
                self.rejected_turn_steers.front_mut()
            };
            if let Some(queued) = front.filter(|queued| queued.owner.is_some()) {
                queued.action = QueuedInputAction::Held;
            }
        }
        self.user_message_queue
            .retain(|queued| !matches!(queued.action, QueuedInputAction::Preparing(_)));
        self.sync_input_preparation_indicator();
    }

    pub(super) fn sync_input_preparation_indicator(&mut self) {
        if self.turn_state.is_active() || self.is_loading {
            return;
        }
        if self
            .input_admission
            .as_ref()
            .is_some_and(|admission| admission.observer.is_some())
        {
            self.foreground_operation_label = Some("Saving input".into());
            self.spinner.start();
        } else if self.input_preparation.is_pending() || self.input_start_retry_at.is_some() {
            self.foreground_operation_label = Some("Preparing input".into());
            self.spinner.start();
        } else if matches!(
            self.foreground_operation_label.as_deref(),
            Some("Preparing input" | "Saving input")
        ) {
            self.foreground_operation_label = None;
            self.spinner.stop();
        }
    }

    pub(super) fn enqueue_user_message_for_turn(
        &mut self,
        message: impl Into<QueuedUserMessage>,
    ) -> bool {
        if self.pending_input_count() >= USER_MESSAGE_QUEUE_MAX {
            return false;
        }
        self.user_message_queue.push_back(message.into());
        true
    }

    pub(super) fn pop_user_message_for_turn(&mut self) -> Option<QueuedTurnInput> {
        if self
            .rejected_turn_steers
            .front()
            .or_else(|| self.user_message_queue.front())
            .is_some_and(|queued| {
                matches!(
                    queued.action,
                    QueuedInputAction::Preparing(_)
                        | QueuedInputAction::Admitting(_)
                        | QueuedInputAction::Uncertain
                        | QueuedInputAction::Held
                )
            })
        {
            return None;
        }
        self.rejected_turn_steers
            .pop_front()
            .or_else(|| self.user_message_queue.pop_front())
            .map(QueuedUserMessage::into_turn_input)
    }

    pub(super) fn restore_latest_queued_message_for_edit(&mut self) -> bool {
        if self
            .user_message_queue
            .back()
            .or_else(|| self.rejected_turn_steers.back())
            .is_some_and(|queued| {
                matches!(
                    queued.action,
                    QueuedInputAction::Admitting(_)
                        | QueuedInputAction::Admitted(_)
                        | QueuedInputAction::Uncertain
                )
            })
        {
            self.push_message(MessageRole::System, "The save result for this input is not yet confirmed. Check the conversation before submitting it again.".to_string());
            return false;
        }
        let Some(queued) = self
            .user_message_queue
            .pop_back()
            .or_else(|| self.rejected_turn_steers.pop_back())
        else {
            return false;
        };
        if let QueuedInputAction::Preparing(id) = queued.action {
            self.input_preparation.cancel_one(id);
            self.sync_input_preparation_indicator();
        }
        if self.user_message_queue.is_empty() && self.rejected_turn_steers.is_empty() {
            self.input_start_retry_at = None;
            self.sync_input_preparation_indicator();
        }
        self.prefill_input(queued.restore_text);
        self.local_image_attachments = queued.local_image_attachments;
        self.remote_image_urls = queued.remote_image_urls;
        self.selected_remote_image_index = None;
        self.pending_pastes = queued.pending_pastes;
        self.sync_composer_sidecars();
        self.force_next_viewport_redraw();
        true
    }

    pub(super) fn pending_input_count(&self) -> usize {
        self.user_message_queue.len()
            + self.pending_turn_steers.len()
            + self.rejected_turn_steers.len()
    }

    pub(super) fn next_turn_steer_id(&mut self) -> u64 {
        self.next_turn_steer_id = self.next_turn_steer_id.wrapping_add(1).max(1);
        self.next_turn_steer_id
    }

    pub(super) fn track_pending_turn_steer(&mut self, id: u64, message: QueuedUserMessage) {
        debug_assert!(self.pending_input_count() < USER_MESSAGE_QUEUE_MAX);
        self.pending_turn_steers
            .push_back(PendingTurnSteer { id, message });
        self.force_next_viewport_redraw();
    }

    pub(super) fn apply_pending_turn_steer(&mut self, id: u64) -> bool {
        let Some(index) = self
            .pending_turn_steers
            .iter()
            .position(|pending| pending.id == id)
        else {
            return false;
        };
        let Some(pending) = self.pending_turn_steers.remove(index) else {
            return false;
        };

        if pending.message.owner.as_ref().is_some_and(|owner| {
            self.input_session_owner
                .as_ref()
                .is_some_and(|current| !owner.same_lifecycle(current))
        }) {
            if self.retired_pending_steers.len() < crate::input_admission::MAX_RETIRED_ADMISSIONS {
                self.retired_pending_steers.push_back(pending);
            } else {
                self.pending_turn_steers.insert(index, pending);
            }
            return false;
        }

        self.push_scheduled_user_message(&pending.message.display_message);
        self.force_next_viewport_redraw();
        true
    }

    pub(super) fn defer_unapplied_turn_steers(&mut self, not_consumed: &[u64]) -> usize {
        let count = self.pending_turn_steers.len();
        if self.pending_turn_steers.iter().any(|pending| {
            !not_consumed.contains(&pending.id)
                && pending.message.owner.as_ref().is_some_and(|owner| {
                    self.input_session_owner
                        .as_ref()
                        .is_none_or(|current| owner.same_lifecycle(current))
                })
        }) {
            let owner = self.pending_turn_steers.iter().find_map(|pending| {
                pending
                    .message
                    .owner
                    .as_ref()
                    .filter(|owner| {
                        !not_consumed.contains(&pending.id) && {
                            self.input_session_owner
                                .as_ref()
                                .is_none_or(|current| owner.same_lifecycle(current))
                        }
                    })
                    .cloned()
            });
            self.mark_input_uncertain_for(owner);
        }
        self.rejected_turn_steers
            .extend(self.pending_turn_steers.drain(..).map(|pending| {
                let mut message = pending.message;
                if message.owner.is_some() && !not_consumed.contains(&pending.id) {
                    // A lost steer acknowledgement does not prove that
                    // the original writer did not accept the input.
                    message.action = QueuedInputAction::Uncertain;
                }
                message
            }));
        count
    }

    pub(super) fn push_scheduled_user_message(&mut self, message: &Message) -> usize {
        self.flush_active_turn();
        // A live panel holds the old active tail back. Move it into editable
        // transcript storage before the user boundary, not behind the new input.
        // sync_subagent_panel keeps it current; scrollback_commit_target still
        // prevents exporting a live panel into immutable native scrollback.
        let remaining = StreamController::flush(&mut self.active_turn, true);
        if !remaining.is_empty() {
            self.bump_active_turn_render_revision();
            for entry in remaining {
                self.push_message(entry.role, entry.text);
            }
        }
        self.consolidate_finished_assistant_stream();
        self.open_subagent_panel = None;
        let transcript_start = self.messages.len();
        let tool_uses = HashMap::new();
        let tool_results = HashMap::new();
        self.push_history_message(message, &tool_uses, &tool_results);
        transcript_start
    }

    pub(super) fn push_user_shell_help(&mut self) {
        self.push_message(
            MessageRole::System,
            format!("{USER_SHELL_COMMAND_HELP_TITLE}\n{USER_SHELL_COMMAND_HELP_HINT}"),
        );
    }

    pub(super) fn pending_input_preview(&self) -> widgets::PendingInputPreview<'_> {
        widgets::PendingInputPreview::new(
            self.user_message_queue
                .iter()
                .map(|message| queued_user_message_preview(&message.model_message))
                .collect(),
            &KCODER_UI_THEME,
        )
        .with_steers(
            self.pending_turn_steers
                .iter()
                .map(|pending| queued_user_message_preview(&pending.message.display_message))
                .collect(),
            self.rejected_turn_steers
                .iter()
                .map(|message| queued_user_message_preview(&message.display_message))
                .collect(),
        )
    }

    pub(super) fn pending_input_preview_height(&self, width: u16, status_height: u16) -> u16 {
        let preview_height = self.pending_input_preview().desired_height(width.max(1));
        pending_input_preview_layout_height(preview_height, status_height)
    }

    pub(super) fn bottom_pane_stack_heights(&self, width: u16) -> (u16, u16) {
        let status_height = status_indicator_height(self, width);
        let preview_height = self.pending_input_preview().desired_height(width.max(1));
        (
            status_indicator_layout_height(status_height, preview_height),
            self.pending_input_preview_height(width, status_height),
        )
    }

    pub(super) fn history_search_footer_cursor(&self, footer_area: Rect) -> Option<(u16, u16)> {
        let search = self.history_search.as_ref()?;
        if footer_area.is_empty() {
            return None;
        }

        const FOOTER_INDENT_COLS: u16 = 2;
        let prompt_width = unicode_width::UnicodeWidthStr::width("reverse-i-search: ") as u16;
        let query_width = unicode_width::UnicodeWidthStr::width(search.query.as_str()) as u16;
        let desired_x = footer_area
            .x
            .saturating_add(FOOTER_INDENT_COLS.min(footer_area.width))
            .saturating_add(prompt_width)
            .saturating_add(query_width);
        let max_x = footer_area
            .x
            .saturating_add(footer_area.width.saturating_sub(1));
        Some((desired_x.min(max_x), footer_area.y))
    }

    #[cfg(test)]
    pub(super) fn render_queued_user_message_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.pending_input_preview().lines(width)
    }
}
