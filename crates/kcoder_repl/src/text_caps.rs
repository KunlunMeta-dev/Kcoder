pub(crate) const ACTIVE_TURN_TEXT_MAX_CHARS: usize = 1_000_000;
pub(crate) const ACTIVE_TOOL_INPUT_MAX_CHARS: usize = 8_000;
pub(crate) const TUI_TRUNCATION_MARKER: &str = "TUI display truncated";

#[derive(Debug, Default)]
pub(crate) struct TuiTextCapState {
    bytes: usize,
    chars: usize,
    truncated: bool,
}

impl TuiTextCapState {
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn consume_prefix(&mut self, prefix: &str) {
        self.bytes = self.bytes.saturating_sub(prefix.len());
        self.chars = self.chars.saturating_sub(prefix.chars().count());
        if self.bytes == 0 {
            self.reset();
        }
    }

    fn synchronize(&mut self, existing: &str) {
        if existing.is_empty() {
            self.reset();
        } else if self.bytes != existing.len() {
            // Stable-prefix commits leave a suffix of the current text.
            self.truncated &= existing.len() < self.bytes;
            self.bytes = existing.len();
            self.chars = existing.chars().count();
        }
    }
}

pub(crate) fn append_capped_tui_text(
    existing: &mut String,
    text: &str,
    max_chars: usize,
    label: &str,
    state: &mut TuiTextCapState,
) {
    if text.is_empty() {
        return;
    }
    state.synchronize(existing);
    if state.truncated {
        return;
    }

    let remaining = max_chars.saturating_sub(state.chars);
    let mut chars = text.chars();
    for ch in chars.by_ref().take(remaining) {
        existing.push(ch);
        state.chars += 1;
    }
    if chars.next().is_some() {
        let notice = format!(
            "\n\n[{label} {TUI_TRUNCATION_MARKER} after {max_chars} chars; full content remains in session state.]"
        );
        state.chars += notice.chars().count();
        existing.push_str(&notice);
        state.truncated = true;
    }
    state.bytes = existing.len();
}

pub(crate) fn capped_tui_text(text: &str, max_chars: usize, label: &str) -> String {
    let mut out = String::new();
    append_capped_tui_text(
        &mut out,
        text,
        max_chars,
        label,
        &mut TuiTextCapState::default(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_cap_tracks_drained_prefix_and_resets_after_empty() {
        let mut text = String::new();
        let mut state = TuiTextCapState::default();
        append_capped_tui_text(&mut text, "你好吗", 4, "output", &mut state);
        let prefix: String = text.drain(.."你".len()).collect();
        state.consume_prefix(&prefix);
        append_capped_tui_text(&mut text, "世界", 4, "output", &mut state);
        assert_eq!(text, "好吗世界");
        append_capped_tui_text(&mut text, "额外", 4, "output", &mut state);
        assert!(text.contains(TUI_TRUNCATION_MARKER));
        assert!(!text.contains("额外"));
        let drained = std::mem::take(&mut text);
        state.consume_prefix(&drained);
        append_capped_tui_text(&mut text, "新的", 4, "output", &mut state);
        assert_eq!(text, "新的");
    }
}
