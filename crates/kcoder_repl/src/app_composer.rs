//! Composer history, attachments, submission, and model metadata.

use super::*;

impl ReplApp {
    pub(super) fn set_input_history_path(&mut self, path: std::path::PathBuf) {
        if self.input_history_path.as_ref() != Some(&path) {
            self.input_history_save =
                Arc::new(crate::input_history::InputHistorySaveState::default());
        }
        self.input_history_path = Some(path);
    }

    pub(super) fn load_input_history(&mut self) {
        let Some(path) = self.input_history_path.as_ref() else {
            return;
        };
        if !path.exists() {
            return;
        }
        match load_input_history_file(path) {
            Ok(history) => self.input_history = history,
            Err(e) => warn!("failed to load input history: {}", e),
        }
    }

    pub(super) fn push_input_history(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        let new_entry = self.input_history.last().map(String::as_str) != Some(&text);
        if new_entry {
            self.input_history.push(text.clone());
            if self.input_history.len() > INPUT_HISTORY_MAX_ENTRIES {
                self.input_history.remove(0);
            }
        }
        if let Some(path) = self.input_history_path.clone() {
            let save = Arc::clone(&self.input_history_save);
            let revision = save.record(new_entry.then_some(text));
            tokio::task::spawn_blocking(move || {
                if let Err(e) = save.save_latest(&path, revision) {
                    warn!("failed to save input history: {}", e);
                }
            });
        }
    }

    pub(super) fn reset_input_history_navigation(&mut self) {
        self.input_history_index = None;
        self.input_history_draft = None;
    }

    pub(super) fn composer_draft_snapshot(&self) -> ComposerDraftSnapshot {
        ComposerDraftSnapshot {
            input: self.input.clone(),
            cursor_grapheme_index: self.cursor_grapheme_index,
            pending_pastes: self.pending_pastes.clone(),
            local_image_attachments: self.local_image_attachments.clone(),
            remote_image_urls: self.remote_image_urls.clone(),
            selected_remote_image_index: self.selected_remote_image_index,
        }
    }

    pub(super) fn restore_composer_draft(&mut self, draft: ComposerDraftSnapshot) {
        self.input = draft.input;
        self.cursor_grapheme_index = draft
            .cursor_grapheme_index
            .min(self.input.graphemes(true).count());
        self.pending_pastes = draft.pending_pastes;
        self.local_image_attachments = draft.local_image_attachments;
        self.remote_image_urls = draft.remote_image_urls;
        self.selected_remote_image_index = draft.selected_remote_image_index;
        self.input_scroll_row = 0;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn input_history_status_label(&self) -> String {
        let Some(idx) = self.input_history_index else {
            return String::new();
        };
        if self.input_history.is_empty() {
            return String::new();
        }
        format!(
            "history {}/{}",
            idx.saturating_add(1).min(self.input_history.len()),
            self.input_history.len()
        )
    }

    pub(super) fn recall_previous_input(&mut self) -> bool {
        if self.input_history.is_empty() {
            return false;
        }
        if self.input_history_index.is_none() {
            self.input_history_draft = Some(self.composer_draft_snapshot());
            self.input_history_index = Some(self.input_history.len().saturating_sub(1));
        } else if let Some(idx) = self.input_history_index
            && idx > 0
        {
            self.input_history_index = Some(idx - 1);
        }
        self.apply_history_recall();
        true
    }

    pub(super) fn recall_next_input(&mut self) -> bool {
        let Some(idx) = self.input_history_index else {
            return false;
        };
        if idx + 1 < self.input_history.len() {
            self.input_history_index = Some(idx + 1);
            self.apply_history_recall();
        } else {
            self.input_history_index = None;
            if let Some(draft) = self.input_history_draft.take() {
                self.restore_composer_draft(draft);
            } else {
                self.cursor_grapheme_index = self.input_graphemes().len();
            }
        }
        true
    }

    pub(super) fn apply_history_recall(&mut self) {
        if let Some(idx) = self.input_history_index
            && let Some(text) = self.input_history.get(idx).cloned()
        {
            self.input = text;
            self.pending_pastes.clear();
            self.local_image_attachments.clear();
            self.remote_image_urls.clear();
            self.selected_remote_image_index = None;
            self.cursor_grapheme_index = self.input_graphemes().len();
            self.input_scroll_row = 0;
            self.clamp_input_scroll(self.last_input_width);
        }
    }

    pub(super) fn insert_text_at_cursor(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.reset_input_history_navigation();
        let byte_pos = self.byte_index_for_grapheme(self.cursor_grapheme_index);
        self.input.insert_str(byte_pos, text);
        self.cursor_grapheme_index += text.graphemes(true).count();
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn enter_shell_prompt_mode_if_requested(&mut self, key: KeyEvent) -> bool {
        if key.code != KeyCode::Char('!')
            || !key.modifiers.is_empty()
            || !self.composer_is_empty_for_shortcuts()
        {
            return false;
        }

        self.reset_input_history_navigation();
        self.input = "!".to_string();
        self.cursor_grapheme_index = 1;
        self.input_scroll_row = 0;
        self.force_next_viewport_redraw();
        true
    }

    pub(super) fn enter_slash_menu_if_requested(&mut self, key: KeyEvent) -> bool {
        if key.code != KeyCode::Char('/')
            || !key.modifiers.is_empty()
            || !self.composer_is_empty_for_shortcuts()
        {
            return false;
        }

        self.reset_input_history_navigation();
        self.input = "/".to_string();
        self.cursor_grapheme_index = 1;
        self.input_scroll_row = 0;
        self.open_slash_menu();
        self.force_next_viewport_redraw();
        true
    }

    pub(super) fn insert_newline_at_cursor(&mut self) {
        self.insert_text_at_cursor("\n");
        self.sync_composer_sidecars();
    }

    pub(crate) fn prefill_input(&mut self, text: String) {
        self.reset_input_history_navigation();
        self.input = text;
        self.pending_pastes.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.cursor_grapheme_index = self.input_graphemes().len();
        self.input_scroll_row = 0;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn prune_pending_pastes(&mut self) {
        self.pending_pastes
            .retain(|(placeholder, _)| self.input.contains(placeholder));
    }

    pub(super) fn sync_composer_sidecars(&mut self) {
        self.prune_pending_pastes();
        self.sync_remote_image_selection();
        self.sync_local_image_attachments();
        self.sync_mention_menu();
        self.sync_slash_menu();
    }

    pub(super) fn sync_remote_image_selection(&mut self) {
        if self.remote_image_urls.is_empty() {
            self.selected_remote_image_index = None;
        } else if let Some(selected) = self.selected_remote_image_index {
            self.selected_remote_image_index = Some(selected.min(self.remote_image_urls.len() - 1));
        }
    }

    pub(super) fn clear_remote_image_selection(&mut self) {
        if self.selected_remote_image_index.take().is_some() {
            self.force_next_viewport_redraw();
        }
    }

    pub(super) fn remove_selected_remote_image(&mut self, selected_index: usize) {
        if selected_index >= self.remote_image_urls.len() {
            self.clear_remote_image_selection();
            return;
        }

        self.remote_image_urls.remove(selected_index);
        self.selected_remote_image_index = if self.remote_image_urls.is_empty() {
            None
        } else {
            Some(selected_index.min(self.remote_image_urls.len() - 1))
        };
        self.relabel_local_image_attachments();
        self.force_next_viewport_redraw();
    }

    pub(super) fn handle_remote_image_selection_key(&mut self, key: KeyEvent) -> bool {
        if self.remote_image_urls.is_empty()
            || key.modifiers != KeyModifiers::NONE
            || key.kind != KeyEventKind::Press
        {
            return false;
        }

        match key.code {
            KeyCode::Up => {
                if let Some(selected) = self.selected_remote_image_index {
                    self.selected_remote_image_index = Some(selected.saturating_sub(1));
                    self.force_next_viewport_redraw();
                    true
                } else if self.cursor_grapheme_index == 0 {
                    self.selected_remote_image_index = Some(self.remote_image_urls.len() - 1);
                    self.force_next_viewport_redraw();
                    true
                } else {
                    false
                }
            }
            KeyCode::Down => {
                if let Some(selected) = self.selected_remote_image_index {
                    if selected + 1 < self.remote_image_urls.len() {
                        self.selected_remote_image_index = Some(selected + 1);
                    } else {
                        self.selected_remote_image_index = None;
                    }
                    self.force_next_viewport_redraw();
                    true
                } else {
                    false
                }
            }
            KeyCode::Delete | KeyCode::Backspace => {
                if let Some(selected) = self.selected_remote_image_index {
                    self.remove_selected_remote_image(selected);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    pub(super) fn sync_local_image_attachments(&mut self) {
        if self.local_image_attachments.is_empty() {
            return;
        }

        let input = self.input.clone();
        let mut kept_images = Vec::new();
        for image in self.local_image_attachments.drain(..) {
            if input.contains(&image.placeholder) {
                kept_images.push(image);
            }
        }
        self.local_image_attachments = kept_images;
        self.relabel_local_image_attachments();
        let max_cursor = self.input_graphemes().len();
        self.cursor_grapheme_index = self.cursor_grapheme_index.min(max_cursor);
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn relabel_local_image_attachments(&mut self) {
        for index in 0..self.local_image_attachments.len() {
            let expected = local_image_placeholder(self.remote_image_urls.len() + index + 1);
            let image = &mut self.local_image_attachments[index];
            if image.placeholder == expected {
                continue;
            }
            self.input = self.input.replace(&image.placeholder, &expected);
            image.placeholder = expected;
        }
    }

    pub(super) fn next_large_paste_placeholder(&self, char_count: usize) -> String {
        let base = format!("[Pasted Content {char_count} chars]");
        let prefix = format!("{base} #");
        let mut max_suffix = 0usize;

        for (placeholder, _) in &self.pending_pastes {
            if placeholder == &base {
                max_suffix = max_suffix.max(1);
                continue;
            }
            if let Some(suffix) = placeholder.strip_prefix(&prefix)
                && let Ok(value) = suffix.parse::<usize>()
            {
                max_suffix = max_suffix.max(value);
            }
        }

        if max_suffix == 0 {
            base
        } else {
            format!("{base} #{}", max_suffix + 1)
        }
    }

    pub(super) fn insert_large_paste_placeholder(&mut self, pasted: String) {
        let char_count = pasted.chars().count();
        let placeholder = self.next_large_paste_placeholder(char_count);
        self.pending_pastes.push((placeholder.clone(), pasted));
        self.insert_text_at_cursor(&placeholder);
    }

    pub(super) fn handle_paste_text(&mut self, pasted: &str) -> Result<()> {
        let normalized = pasted.replace("\r\n", "\n").replace('\r', "\n");
        let sanitized = sanitize_tui_text(&normalized);
        if sanitized.chars().count() > LARGE_PASTE_CHAR_THRESHOLD {
            self.insert_large_paste_placeholder(sanitized);
        } else if !self.try_attach_pasted_image(&sanitized)? {
            self.insert_text_at_cursor(&sanitized);
        }
        self.sync_composer_sidecars();
        Ok(())
    }

    pub(super) fn handle_paste_text_for_active_overlay(&mut self, pasted: &str) -> bool {
        if self.history_search.is_some() {
            if let Some(query) = normalize_pasted_search_query(pasted) {
                let search = self.history_search.take().unwrap();
                let mut next_query = search.query.clone();
                next_query.push_str(&query);
                self.update_history_search_query(search, next_query);
            }
            return true;
        }

        if let Some(picker) = self.resume_session_picker.as_mut() {
            if let Some(query) = normalize_pasted_search_query(pasted) {
                picker.filter.push_str(&query);
                picker.selected = 0;
            }
            return true;
        }

        if let Some(picker) = self.picker_overlay.as_mut() {
            if let Some(query) = normalize_pasted_search_query(pasted) {
                picker.filter.push_str(&query);
                picker.selected = 0;
            }
            return true;
        }

        if let Some(editor) = self.permission_editor.as_mut() {
            let normalized = pasted.replace("\r\n", "\n").replace('\r', "\n");
            let sanitized = sanitize_tui_text(&normalized);
            if !sanitized.is_empty() {
                let byte_pos = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index);
                editor.text.insert_str(byte_pos, &sanitized);
                editor.cursor_grapheme_index += sanitized.graphemes(true).count();
            }
            return true;
        }

        self.has_active_overlay()
    }

    pub(super) fn try_attach_pasted_image(&mut self, pasted: &str) -> Result<bool> {
        let Some(path) = pasted_image_path(pasted, Path::new(&self.display_cwd)) else {
            return Ok(false);
        };
        let Some(media_type) = image_media_type(&path) else {
            return Ok(false);
        };
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => return Ok(false),
        };
        if self.local_image_attachments.len() >= MAX_IMAGE_ATTACHMENTS {
            anyhow::bail!("maximum image attachments reached ({MAX_IMAGE_ATTACHMENTS})");
        }
        if metadata.len() > MAX_IMAGE_BYTES {
            anyhow::bail!(
                "image {} is larger than {} MB",
                path.display(),
                MAX_IMAGE_BYTES / 1024 / 1024
            );
        }

        let placeholder = local_image_placeholder(
            self.remote_image_urls.len() + self.local_image_attachments.len() + 1,
        );
        self.local_image_attachments.push(LocalImageAttachment {
            path,
            placeholder: placeholder.clone(),
            media_type: media_type.to_string(),
            clipboard_image: None,
        });
        self.insert_text_at_cursor(&format!("{placeholder} "));
        Ok(true)
    }

    pub(super) fn attach_clipboard_image(&mut self, image: ClipboardImage) -> Result<()> {
        if self.local_image_attachments.len() >= MAX_IMAGE_ATTACHMENTS {
            anyhow::bail!("maximum image attachments reached ({MAX_IMAGE_ATTACHMENTS})");
        }
        let path = image.path().to_path_buf();
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("failed to inspect clipboard image {}", path.display()))?;
        if metadata.len() > MAX_IMAGE_BYTES {
            anyhow::bail!(
                "clipboard image is larger than {} MB after compression",
                MAX_IMAGE_BYTES / 1024 / 1024
            );
        }
        let placeholder = local_image_placeholder(
            self.remote_image_urls.len() + self.local_image_attachments.len() + 1,
        );
        self.local_image_attachments.push(LocalImageAttachment {
            path,
            placeholder: placeholder.clone(),
            media_type: "image/png".to_string(),
            clipboard_image: Some(image),
        });
        self.insert_text_at_cursor(&format!("{placeholder} "));
        self.sync_composer_sidecars();
        Ok(())
    }

    pub(super) fn take_submitted_message(&mut self) -> SubmittedMessage {
        self.sync_composer_sidecars();
        let visible_text = self.input.trim().to_string();
        let text = expand_pending_pastes(&visible_text, &self.pending_pastes);
        let pending_pastes = self.pending_pastes.clone();
        let remote_image_urls = self.remote_image_urls.clone();
        let images = self
            .local_image_attachments
            .iter()
            .filter(|image| visible_text.contains(&image.placeholder))
            .cloned()
            .collect();
        self.local_image_attachments.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.pending_pastes.clear();
        SubmittedMessage {
            visible_text,
            text,
            images,
            remote_image_urls,
            pending_pastes,
        }
    }

    pub(super) fn submit_composer_input(&mut self) -> Option<UserAction> {
        if self.input.trim().is_empty()
            && self.local_image_attachments.is_empty()
            && self.remote_image_urls.is_empty()
        {
            return None;
        }

        // Submitting is allowed even while a turn is in flight. The event loop
        // queues the new user message and only renders it as transcript history
        // when that queued turn actually starts.
        if self.spinner.is_running() {
            const MIN_SUBMIT_GAP_MS: u128 = 200;
            if let Some(last) = self.last_submit_at
                && last.elapsed().as_millis() < MIN_SUBMIT_GAP_MS
            {
                return None;
            }
        }

        let submitted = self.take_submitted_message();
        let text = submitted.text.clone();
        self.input.clear();
        self.cursor_grapheme_index = 0;
        self.input_scroll_row = 0;
        self.last_input_width = 0;
        self.startup_live_viewport_top_limit = None;
        self.close_slash_menu();
        self.force_next_viewport_redraw();
        self.input_history_index = None;
        self.input_history_draft = None;
        self.last_submit_at = Some(std::time::Instant::now());
        self.push_input_history(text.clone());
        if submitted.images.is_empty()
            && let Some(command) = shell_command_from_prompt(&text)
        {
            return Some(UserAction::RunShellCommand {
                command,
                history_text: text,
            });
        }
        if submitted.images.is_empty() && text.starts_with('/') {
            return Some(UserAction::SlashCommand(text));
        }
        Some(UserAction::Submit(submitted))
    }

    pub(super) fn refresh_engine_metadata(&mut self, engine: &QueryEngine) {
        let cwd = engine.state.cwd().display().to_string();
        if self.display_cwd != cwd {
            self.mention_file_index.clear();
            self.mention_menu = None;
        }
        self.display_cwd = cwd;
        let settings = engine.settings.read().unwrap();
        self.model_name = settings.model.clone();
        self.reasoning_effort = settings.model_reasoning_effort.clone();
        drop(settings);
        self.provider_name = engine.provider_name();
        self.session_id = engine.session_id();
        self.plan_mode = engine.state.plan_mode();
        self.session_mode = engine.state.session_mode();
        self.orchestrate_progress_label = if self.session_mode.is_orchestrate() {
            let store =
                kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
            store.read_active_work().ok().and_then(|snapshot| {
                let parsed = kcoder_state::orchestrate_store::parse_plan(&snapshot.plan).ok()?;
                let todo_total = parsed
                    .tasks
                    .iter()
                    .filter(|task| !task.is_final_verification)
                    .count();
                let todo_done = parsed
                    .tasks
                    .iter()
                    .filter(|task| !task.is_final_verification && task.completed)
                    .count();
                let wave_total = parsed
                    .tasks
                    .iter()
                    .filter(|task| task.is_final_verification)
                    .count();
                let wave_done = parsed
                    .tasks
                    .iter()
                    .filter(|task| task.is_final_verification && task.completed)
                    .count();
                Some(format!(
                    "{} r{} · TODOs {}/{} · Wave {}/{} · {}",
                    snapshot.work.display_slug,
                    snapshot.work.revision,
                    todo_done,
                    todo_total,
                    wave_done,
                    wave_total,
                    format!("{:?}", snapshot.work.status).to_ascii_lowercase(),
                ))
            })
        } else {
            None
        };
        self.goal = engine.state.goal();
        self.todos = engine.state.todos();
        self.token_count = engine.estimated_token_count();
        let budget = engine.context_budget();
        self.token_total = budget.hard_input_limit();
        self.token_threshold = budget.auto_compact_threshold();
        // Prune background job hints that the engine no longer tracks. This
        // keeps status surfaces in sync if the user closed a hint via
        // `close_agent` or the engine dropped the record.
        let live: std::collections::HashSet<String> =
            engine.state.tasks().keys().cloned().collect();
        self.prune_background_job_hints(&live);
    }

    pub(super) fn adjust_reasoning_effort(
        &mut self,
        engine: &QueryEngine,
        direction: ReasoningShortcutDirection,
    ) {
        let current_setting = engine
            .settings
            .read()
            .unwrap()
            .model_reasoning_effort
            .clone();
        let current_effort = reasoning_shortcut_anchor(current_setting.as_ref());
        let Some(next_effort) = next_reasoning_effort(&current_effort, direction) else {
            self.push_message(
                MessageRole::System,
                direction.bound_message(&current_effort),
            );
            return;
        };

        if let Err(error) = engine.set_client_reasoning_effort(&next_effort.to_string()) {
            self.push_message(
                MessageRole::System,
                format!("Cannot change reasoning: {error}"),
            );
            return;
        }
        self.reasoning_effort = Some(next_effort.clone());
        self.push_message(
            MessageRole::System,
            format!(
                "Reasoning set to {}.",
                reasoning_effort_sentence_label(&next_effort)
            ),
        );
    }
}
