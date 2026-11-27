//! History search, command completion, and nonblocking overlays.

use super::*;

impl ReplApp {
    pub(super) fn open_history_search(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.expand_deferred_resumed_transcript();
        let search = HistorySearch {
            query: String::new(),
            selected: 0,
            matches: Vec::new(),
            status: HistorySearchStatus::Idle,
            original_input: self.input.clone(),
            original_cursor_grapheme_index: self.cursor_grapheme_index,
            original_input_scroll_row: self.input_scroll_row,
        };
        self.history_search = Some(search);
        self.open_overlay_state(OverlayKind::HistorySearch);
    }

    pub(super) fn history_search_matches_for_query(&self, query: &str) -> Vec<usize> {
        if query.is_empty() {
            return Vec::new();
        }
        let query = query.to_lowercase();
        self.messages
            .iter()
            .enumerate()
            .filter(|(_, msg)| msg.role == MessageRole::User)
            .filter_map(|(i, msg)| {
                if query.is_empty() || msg.text.to_lowercase().contains(&query) {
                    Some(i)
                } else {
                    None
                }
            })
            .collect()
    }

    pub(super) fn restore_history_search_original_draft(&mut self, search: &HistorySearch) {
        self.input = search.original_input.clone();
        self.cursor_grapheme_index = search.original_cursor_grapheme_index;
        self.input_scroll_row = search.original_input_scroll_row;
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn preview_history_search_match(&mut self, message_index: usize) {
        let Some(message) = self.messages.get(message_index) else {
            return;
        };
        self.input = sanitize_tui_text(&message.text);
        self.cursor_grapheme_index = self.input_graphemes().len();
        self.input_scroll_row = 0;
        self.clamp_input_scroll(self.last_input_width);
    }

    pub(super) fn refresh_history_search_preview(&mut self, mut search: HistorySearch) {
        search.matches = self.history_search_matches_for_query(&search.query);
        if search.matches.is_empty() {
            search.selected = 0;
            search.status = if search.query.is_empty() {
                HistorySearchStatus::Idle
            } else {
                HistorySearchStatus::NoMatch
            };
            self.restore_history_search_original_draft(&search);
        } else {
            if search.selected >= search.matches.len() {
                search.selected = search.matches.len().saturating_sub(1);
            }
            search.status = HistorySearchStatus::Match;
            if let Some(&message_index) = search.matches.get(search.selected) {
                self.preview_history_search_match(message_index);
            }
        }
        self.history_search = Some(search);
    }

    pub(super) fn update_history_search_query(&mut self, mut search: HistorySearch, query: String) {
        search.query = query;
        search.selected = usize::MAX;
        self.refresh_history_search_preview(search);
    }

    pub(super) fn close_history_search_accepting_preview(&mut self) {
        self.history_search = None;
        self.close_overlay_state(OverlayKind::HistorySearch);
        self.clear_edit_previous_prompt();
    }

    pub(super) fn cancel_history_search(&mut self, search: HistorySearch) {
        self.restore_history_search_original_draft(&search);
        self.history_search = None;
        self.close_overlay_state(OverlayKind::HistorySearch);
        self.clear_edit_previous_prompt();
    }

    pub(super) fn handle_history_key(&mut self, key: KeyEvent) {
        let mut search = self.history_search.take().unwrap();
        let altgr = key_hint::is_altgr(key.modifiers);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL) && !altgr;
        let alt = key.modifiers.contains(KeyModifiers::ALT) && !altgr;

        match key.code {
            KeyCode::Esc => {
                self.cancel_history_search(search);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'c') => {
                self.cancel_history_search(search);
                return;
            }
            KeyCode::Char('\u{0003}') if key.modifiers.is_empty() => {
                self.cancel_history_search(search);
                return;
            }
            KeyCode::Enter => {
                if search.status == HistorySearchStatus::Match {
                    self.close_history_search_accepting_preview();
                } else {
                    self.history_search = Some(search);
                }
                return;
            }
            KeyCode::Up => {
                if search.selected > 0 {
                    search.selected -= 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Down => {
                if search.selected + 1 < search.matches.len() {
                    search.selected += 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'r') => {
                if search.selected > 0 {
                    search.selected -= 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'s') => {
                if search.selected + 1 < search.matches.len() {
                    search.selected += 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Home => {
                search.selected = 0;
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::End => {
                search.selected = search.matches.len().saturating_sub(1);
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::PageUp => {
                search.selected = search.selected.saturating_sub(8);
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::PageDown => {
                search.selected = search
                    .selected
                    .saturating_add(8)
                    .min(search.matches.len().saturating_sub(1));
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Backspace if !search.query.is_empty() => {
                let graphemes: Vec<&str> = search.query.graphemes(true).collect();
                let query = graphemes[..graphemes.len() - 1].concat();
                self.update_history_search_query(search, query);
                return;
            }
            KeyCode::Char(c)
                if ctrl && c.eq_ignore_ascii_case(&'h') && !search.query.is_empty() =>
            {
                let graphemes: Vec<&str> = search.query.graphemes(true).collect();
                let query = graphemes[..graphemes.len() - 1].concat();
                self.update_history_search_query(search, query);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'u') => {
                self.update_history_search_query(search, String::new());
                return;
            }
            KeyCode::Char(c) if !ctrl && !alt && !c.is_ascii_control() => {
                let mut query = search.query.clone();
                query.push(c);
                self.update_history_search_query(search, query);
                return;
            }
            _ => {}
        }

        self.history_search = Some(search);
    }

    pub(super) fn open_slash_menu(&mut self) {
        if self.has_active_overlay() {
            return;
        }
        self.slash_menu = Some(SlashMenu { selected: 0 });
    }

    pub(super) fn close_slash_menu(&mut self) {
        self.slash_menu = None;
    }

    pub(super) fn cancel_slash_menu_draft(&mut self) {
        self.close_slash_menu();
        if self.input.starts_with('/') {
            self.reset_input_history_navigation();
            self.input.clear();
            self.cursor_grapheme_index = 0;
            self.input_scroll_row = 0;
            self.last_input_width = 0;
        }
        self.clear_edit_previous_prompt();
        self.force_next_viewport_redraw();
    }

    pub(super) fn accept_slash_menu_selection(&mut self, selected: usize) {
        let selected_name = self
            .slash_menu_matches()
            .get(selected)
            .map(|cmd| cmd.name().to_string());
        if let Some(name) = selected_name {
            self.input = format!("{} ", name);
            self.cursor_grapheme_index = self.input_graphemes().len();
            self.clamp_input_scroll(self.last_input_width);
        }
        self.close_slash_menu();
    }

    pub(super) fn submit_slash_menu_selection(&mut self, selected: usize) -> Option<UserAction> {
        if self
            .slash_menu_matches()
            .get(selected)
            .is_some_and(|cmd| cmd.needs_arguments())
        {
            self.accept_slash_menu_selection(selected);
            return None;
        }
        let selected_name = self
            .slash_menu_matches()
            .get(selected)
            .map(|cmd| cmd.name().to_string());
        self.close_slash_menu();
        let name = selected_name?;

        self.reset_input_history_navigation();
        self.input.clear();
        self.pending_pastes.clear();
        self.local_image_attachments.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.cursor_grapheme_index = 0;
        self.input_scroll_row = 0;
        self.last_input_width = 0;
        self.last_submit_at = Some(std::time::Instant::now());
        self.push_input_history(name.clone());
        self.force_next_viewport_redraw();
        Some(UserAction::SlashCommand(name))
    }

    pub(super) fn open_context_inspector(&mut self, breakdown: ContextBreakdown) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.context_inspector = Some(ContextInspector { breakdown });
        self.open_overlay_state(OverlayKind::ContextInspector);
    }

    pub(super) fn close_context_inspector(&mut self) {
        self.context_inspector = None;
        self.close_overlay_state(OverlayKind::ContextInspector);
    }

    pub(super) fn handle_context_inspector_key(&mut self, key: KeyEvent) {
        if is_ctrl_c_key(&key) {
            self.close_context_inspector();
            return;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.close_context_inspector();
            }
            _ => {}
        }
    }

    pub(super) fn open_settings_inspector(&mut self, lines: Vec<String>) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.settings_inspector = Some(SettingsInspector {
            lines,
            scroll: 0,
            max_scroll: 0,
            page_rows: 0,
        });
        self.open_overlay_state(OverlayKind::SettingsInspector);
    }

    pub(super) fn close_settings_inspector(&mut self) {
        self.settings_inspector = None;
        self.close_overlay_state(OverlayKind::SettingsInspector);
    }

    pub(super) fn handle_settings_inspector_key(&mut self, key: KeyEvent) {
        if is_ctrl_c_key(&key) {
            self.close_settings_inspector();
            return;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.close_settings_inspector();
            }
            code => {
                if let Some(inspector) = self.settings_inspector.as_mut() {
                    inspector.scroll_key(code);
                }
            }
        }
    }

    pub(super) fn open_keys_overlay(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.keys_overlay = Some(KeysOverlay);
        self.open_overlay_state(OverlayKind::Keys);
    }

    pub(super) fn close_keys_overlay(&mut self) {
        self.keys_overlay = None;
        self.close_overlay_state(OverlayKind::Keys);
    }

    pub(super) fn handle_keys_overlay_key(&mut self, key: KeyEvent) {
        if is_ctrl_c_key(&key) {
            self.close_keys_overlay();
            return;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('?') => {
                self.close_keys_overlay();
            }
            _ => {}
        }
    }

    pub(super) fn toggle_footer_shortcuts_overlay(&mut self) {
        self.footer_shortcuts_overlay = !self.footer_shortcuts_overlay;
        self.force_next_viewport_redraw();
    }

    pub(super) fn close_footer_shortcuts_overlay(&mut self) {
        if self.footer_shortcuts_overlay {
            self.footer_shortcuts_overlay = false;
            self.force_next_viewport_redraw();
        }
    }

    pub(super) fn open_transcript_overlay(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.expand_deferred_resumed_transcript();
        self.transcript_overlay = Some(TranscriptOverlay::new_at_bottom());
        self.open_overlay_state(OverlayKind::Transcript);
        self.force_next_viewport_redraw();
    }

    pub(super) fn close_transcript_overlay(&mut self) {
        if self.navigation.inline {
            let previous = self.navigation.inline_previous_position.unwrap_or_default();
            self.navigation = transcript_navigation::NavigationState::default();
            self.transcript_viewport.set_position(previous);
        }
        self.transcript_overlay = None;
        self.close_overlay_state(OverlayKind::Transcript);
        self.force_next_viewport_redraw();
    }

    pub(super) fn handle_transcript_overlay_key(&mut self, key: KeyEvent) {
        if self.navigation.inline {
            let step = match key.code {
                KeyCode::Up => Some(-3),
                KeyCode::Down => Some(3),
                KeyCode::PageUp => Some(-(self.transcript_viewport.viewport_rows() as i32).max(1)),
                KeyCode::PageDown => Some(self.transcript_viewport.viewport_rows().max(1) as i32),
                _ => None,
            };
            if let Some(step) = step {
                self.transcript_viewport.scroll_lines(step);
                return;
            }
            if key.code == KeyCode::End {
                self.jump_transcript("latest");
                return;
            }
        }
        if is_ctrl_c_key(&key) {
            self.close_transcript_overlay();
            return;
        }
        if is_tool_transcript_toggle_shortcut(&key) {
            self.toggle_tool_transcript_expanded();
            return;
        }
        match key.code {
            KeyCode::Esc if key.modifiers.is_empty() => {
                self.close_transcript_overlay();
            }
            KeyCode::Char('q')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                self.close_transcript_overlay();
            }
            _ if is_transcript_overlay_shortcut(&key) => {
                self.close_transcript_overlay();
            }
            KeyCode::Up => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_by(-3);
                }
            }
            KeyCode::Down => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_by(3);
                }
            }
            KeyCode::PageUp => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.page_by(-1);
                }
            }
            KeyCode::PageDown => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.page_by(1);
                }
            }
            KeyCode::Home => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_home();
                }
            }
            KeyCode::End => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_end();
                }
            }
            _ => {}
        }
    }

    #[cfg(test)]
    pub(super) fn open_picker_overlay(
        &mut self,
        title: &'static str,
        items: Vec<String>,
        on_confirm: PickerAction,
    ) {
        self.open_picker_overlay_with_selected(title, items, on_confirm, 0);
    }

    pub(super) fn open_picker_overlay_with_selected(
        &mut self,
        title: &'static str,
        items: Vec<String>,
        on_confirm: PickerAction,
        selected: usize,
    ) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        let selected = selected.min(items.len().saturating_sub(1));
        self.picker_overlay = Some(PickerOverlay {
            title,
            all_items: items,
            item_values: Vec::new(),
            selected,
            filter: String::new(),
            item_turns: Vec::new(),
            on_confirm,
        });
        self.open_overlay_state(OverlayKind::Picker);
    }

    /// Open the rewind picker: one row per past user prompt, each carrying
    /// its checkpoint turn number. Confirming emits `/rewind <turn>`.
    pub(crate) fn open_rewind_picker(&mut self, entries: Vec<(u64, String)>) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        let items: Vec<String> = entries
            .iter()
            .map(|(turn, preview)| format!("{turn}. {preview}"))
            .collect();
        let item_turns: Vec<u64> = entries.into_iter().map(|(turn, _)| turn).collect();
        // Preselect the latest prompt: rewinding usually targets a recent turn.
        let selected = items.len().saturating_sub(1);
        self.picker_overlay = Some(PickerOverlay {
            title: "Rewind to before which prompt? (files and conversation are restored)",
            all_items: items,
            item_values: Vec::new(),
            selected,
            filter: String::new(),
            item_turns,
            on_confirm: PickerAction::RewindToTurn,
        });
        self.open_overlay_state(OverlayKind::Picker);
    }

    pub(super) fn close_picker_overlay(&mut self) {
        self.picker_overlay = None;
        self.close_overlay_state(OverlayKind::Picker);
    }

    pub(super) fn handle_picker_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        let altgr = key_hint::is_altgr(key.modifiers);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL) && !altgr;
        let alt = key.modifiers.contains(KeyModifiers::ALT) && !altgr;
        if is_ctrl_c_key(&key) {
            self.close_picker_overlay();
            return None;
        }
        let picker = self.picker_overlay.as_mut()?;
        let matches = picker.matches();
        match key.code {
            KeyCode::Esc => {
                self.close_picker_overlay();
                None
            }
            KeyCode::Up => {
                if picker.selected > 0 {
                    picker.selected -= 1;
                }
                None
            }
            KeyCode::Char('p') if key.modifiers == KeyModifiers::CONTROL => {
                if picker.selected > 0 {
                    picker.selected -= 1;
                }
                None
            }
            KeyCode::Down => {
                if picker.selected + 1 < matches.len() {
                    picker.selected += 1;
                }
                None
            }
            KeyCode::Char('n') if key.modifiers == KeyModifiers::CONTROL => {
                if picker.selected + 1 < matches.len() {
                    picker.selected += 1;
                }
                None
            }
            KeyCode::Home => {
                picker.selected = 0;
                None
            }
            KeyCode::End => {
                picker.selected = matches.len().saturating_sub(1);
                None
            }
            KeyCode::PageUp => {
                picker.selected = picker.selected.saturating_sub(PICKER_MAX_ITEMS);
                None
            }
            KeyCode::PageDown => {
                picker.selected = picker
                    .selected
                    .saturating_add(PICKER_MAX_ITEMS)
                    .min(matches.len().saturating_sub(1));
                None
            }
            KeyCode::Backspace => {
                if !picker.filter.is_empty() {
                    picker.filter.pop();
                    picker.selected = 0;
                }
                None
            }
            KeyCode::Char(c) if (!ctrl && !alt || altgr) && !c.is_ascii_control() => {
                picker.filter.push(c);
                picker.selected = 0;
                None
            }
            KeyCode::Enter => {
                let indexed = picker.matches_indexed();
                let (item_index, item) = indexed.get(picker.selected).cloned()?;
                let value = picker.value_for_original_index(item_index, &item);
                let action = picker.on_confirm;
                let rewind_turn = if matches!(action, PickerAction::RewindToTurn) {
                    picker.selected_turn()
                } else {
                    None
                };
                self.close_picker_overlay();
                match action {
                    PickerAction::ViewAgent => {
                        Some(UserAction::SlashCommand(format!("/agent view {value}")))
                    }
                    PickerAction::SwitchModel => {
                        Some(UserAction::SlashCommand(format!("/model {}", value)))
                    }
                    PickerAction::SwitchTheme => {
                        Some(UserAction::SlashCommand(format!("/theme {}", item)))
                    }
                    PickerAction::RewindToTurn => {
                        rewind_turn.map(|turn| UserAction::SlashCommand(format!("/rewind {turn}")))
                    }
                }
            }
            _ => None,
        }
    }

    pub(super) fn slash_menu_query(&self) -> &str {
        self.input.strip_prefix('/').unwrap_or("")
    }

    pub(super) fn slash_menu_query_is_empty(&self) -> bool {
        self.slash_menu_query().trim_start().is_empty()
    }

    pub(super) fn slash_menu_query_has_arguments(&self) -> bool {
        self.slash_menu_query()
            .contains(|c: char| c.is_whitespace())
    }

    pub(super) fn slash_menu_can_accept_selection(&self) -> bool {
        !self.slash_menu_query_has_arguments()
    }

    pub(super) fn slash_menu_matches(&self) -> Vec<&dyn slash::SlashCommand> {
        let query = self.slash_menu_query().trim_start().to_lowercase();
        if query.is_empty() {
            return self.slash_registry.iter().collect();
        }

        let mut exact = Vec::new();
        let mut prefix = Vec::new();
        for cmd in self.slash_registry.iter() {
            match slash_menu_match_kind(cmd, &query) {
                SlashMenuMatchKind::Exact => exact.push(cmd),
                SlashMenuMatchKind::Prefix => prefix.push(cmd),
                SlashMenuMatchKind::None => {}
            }
        }
        exact.extend(prefix);
        exact
    }

    pub(super) fn move_slash_menu_selection_up(&mut self) {
        if let Some(menu) = self.slash_menu.as_mut()
            && menu.selected > 0
        {
            menu.selected -= 1;
        }
    }

    pub(super) fn move_slash_menu_selection_down(&mut self) {
        let count = self.slash_menu_matches().len();
        if let Some(menu) = self.slash_menu.as_mut()
            && menu.selected + 1 < count
        {
            menu.selected += 1;
        }
    }

    /// Handle keys for the slash-command menu. Returns `true` if the event was
    /// consumed by the menu.
    pub(super) fn handle_slash_menu_key(&mut self, key: KeyEvent) -> bool {
        if self.slash_menu.is_none() {
            return false;
        }

        match key.code {
            KeyCode::Esc => {
                self.cancel_slash_menu_draft();
                true
            }
            KeyCode::Up => {
                self.move_slash_menu_selection_up();
                true
            }
            KeyCode::Char('p') if key.modifiers == KeyModifiers::CONTROL => {
                self.move_slash_menu_selection_up();
                true
            }
            KeyCode::Down => {
                self.move_slash_menu_selection_down();
                true
            }
            KeyCode::Char('n') if key.modifiers == KeyModifiers::CONTROL => {
                self.move_slash_menu_selection_down();
                true
            }
            KeyCode::Home => {
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = 0;
                }
                true
            }
            KeyCode::End => {
                let count = self.slash_menu_matches().len();
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = count.saturating_sub(1);
                }
                true
            }
            KeyCode::PageUp => {
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = menu.selected.saturating_sub(8);
                }
                true
            }
            KeyCode::PageDown => {
                let count = self.slash_menu_matches().len();
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = menu.selected.saturating_add(8).min(count.saturating_sub(1));
                }
                true
            }
            KeyCode::Enter | KeyCode::Tab => {
                if !self.slash_menu_can_accept_selection() {
                    self.close_slash_menu();
                    return false;
                }
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                self.accept_slash_menu_selection(selected);
                true
            }
            KeyCode::Char('/') if key.modifiers.is_empty() => {
                if self.slash_menu_query_is_empty() {
                    return true;
                }
                if !self.slash_menu_can_accept_selection() {
                    self.close_slash_menu();
                    return false;
                }
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                self.accept_slash_menu_selection(selected);
                true
            }
            _ => false,
        }
    }

    /// Open or close the slash menu based on the current input.
    pub(super) fn sync_slash_menu(&mut self) {
        if self.mention_menu.is_some() {
            self.close_slash_menu();
            return;
        }
        if self.has_active_overlay() {
            self.close_slash_menu();
            return;
        }
        let should_open =
            self.input.starts_with('/') && !self.input.contains(|c: char| c.is_whitespace());
        if should_open && self.slash_menu.is_none() {
            self.open_slash_menu();
        } else if !should_open {
            self.close_slash_menu();
        }
        let count = self.slash_menu_matches().len();
        if let Some(menu) = self.slash_menu.as_mut()
            && menu.selected >= count
        {
            menu.selected = count.saturating_sub(1);
        }
    }

    pub(super) fn sync_mention_menu(&mut self) {
        if self.has_active_overlay() || self.input.starts_with('/') {
            self.mention_menu = None;
            return;
        }
        let cursor = self.byte_index_for_grapheme(self.cursor_grapheme_index);
        let prefix = &self.input[..cursor.min(self.input.len())];
        let Some(at) = prefix.rfind('@') else {
            self.mention_menu = None;
            return;
        };
        if at > 0
            && !prefix[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
        {
            self.mention_menu = None;
            return;
        }
        let query = &prefix[at + 1..];
        if query.contains(char::is_whitespace) {
            self.mention_menu = None;
            return;
        }
        let previous_selected = self
            .mention_menu
            .as_ref()
            .and_then(|menu| menu.candidates.get(menu.selected))
            .cloned();
        if self.mention_file_index.is_empty() {
            self.mention_file_index = project_file_index(Path::new(&self.display_cwd), 20_000);
        }
        let mut candidates = fuzzy_file_candidates(&self.mention_file_index, query, 40);
        if candidates.is_empty() {
            self.mention_menu = None;
            return;
        }
        let selected = previous_selected
            .and_then(|path| candidates.iter().position(|candidate| candidate == &path))
            .unwrap_or(0);
        candidates.truncate(40);
        self.mention_menu = Some(MentionMenu {
            replace_start: at,
            replace_end: cursor,
            candidates,
            selected,
        });
    }

    pub(super) fn accept_mention_selection(&mut self) {
        let Some(menu) = self.mention_menu.take() else {
            return;
        };
        let Some(path) = menu.candidates.get(menu.selected) else {
            return;
        };
        let replacement = format!("@{} ", path.replace(' ', "\\ "));
        self.input
            .replace_range(menu.replace_start..menu.replace_end, &replacement);
        let byte_cursor = menu.replace_start + replacement.len();
        self.cursor_grapheme_index = self.input[..byte_cursor].graphemes(true).count();
        self.sync_composer_sidecars();
    }
}
