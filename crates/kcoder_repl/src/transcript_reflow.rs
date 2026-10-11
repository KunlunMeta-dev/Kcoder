//! Tracks terminal size observations for the inline TUI.
//!
//! KCoder intentionally does not rebuild terminal scrollback on resize. The
//! host terminal owns historical rows; rebuilding them here would require
//! clearing the real terminal scrollback and replaying only KCoder's transcript,
//! which drops shell history. Size tracking is still useful for current-frame
//! layout decisions and tests.

use ratatui::layout::Size;

#[derive(Debug, Default)]
pub(crate) struct TranscriptReflowState {
    last_observed_size: Option<Size>,
}

impl TranscriptReflowState {
    pub(crate) fn clear(&mut self) {
        *self = Self::default();
    }

    pub(crate) fn note_size(&mut self, size: Size) -> TranscriptSizeChange {
        let previous = self.last_observed_size.replace(size);
        TranscriptSizeChange {
            initialized: previous.is_none(),
            width_changed: previous.is_some_and(|prev| prev.width != size.width),
            height_changed: previous.is_some_and(|prev| prev.height != size.height),
        }
    }
}

pub(crate) struct TranscriptSizeChange {
    initialized: bool,
    width_changed: bool,
    height_changed: bool,
}

impl TranscriptSizeChange {
    pub(crate) fn initialized(&self) -> bool {
        self.initialized
    }

    pub(crate) fn width_changed(&self) -> bool {
        self.width_changed
    }

    pub(crate) fn height_changed(&self) -> bool {
        self.height_changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_size_sets_baseline() {
        let mut state = TranscriptReflowState::default();

        let change = state.note_size(Size::new(80, 24));

        assert!(change.initialized);
        assert!(!change.width_changed);
        assert!(!change.height_changed);
    }

    #[test]
    fn width_and_height_changes_are_reported() {
        let mut state = TranscriptReflowState::default();
        state.note_size(Size::new(80, 24));

        let change = state.note_size(Size::new(100, 40));

        assert!(!change.initialized);
        assert!(change.width_changed);
        assert!(change.height_changed);
    }

    #[test]
    fn clear_forgets_observed_size() {
        let mut state = TranscriptReflowState::default();
        state.note_size(Size::new(80, 24));

        state.clear();
        let change = state.note_size(Size::new(80, 24));

        assert!(change.initialized);
    }
}
