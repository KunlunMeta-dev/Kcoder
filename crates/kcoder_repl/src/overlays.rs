use crate::slash::ContextBreakdown;
use kcoder_permissions::{PermissionDialogResult, PermissionRisk};
use kcoder_state::{GoalMode, GoalVerificationKind};
use kcoder_tools::{UserQuestionRequest, UserQuestionResponse};

#[derive(Debug)]
pub(crate) struct HistorySearch {
    pub(crate) query: String,
    pub(crate) selected: usize,
    pub(crate) matches: Vec<usize>,
    pub(crate) status: HistorySearchStatus,
    pub(crate) original_input: String,
    pub(crate) original_cursor_grapheme_index: usize,
    pub(crate) original_input_scroll_row: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistorySearchStatus {
    Idle,
    Match,
    NoMatch,
}

#[derive(Debug)]
pub(crate) struct PermissionDialog {
    pub(crate) tool_name: String,
    pub(crate) description: String,
    pub(crate) input: serde_json::Value,
    #[allow(dead_code)]
    pub(crate) risk: PermissionRisk,
    pub(crate) detail_lines: Vec<String>,
    pub(crate) response_tx: tokio::sync::oneshot::Sender<PermissionDialogResult>,
    pub(crate) selected: usize,
}

#[derive(Debug)]
pub(crate) struct QuestionDialog {
    pub(crate) request: UserQuestionRequest,
    pub(crate) response_tx: tokio::sync::oneshot::Sender<UserQuestionResponse>,
    /// Per-question UI state. Answers are committed separately in
    /// `request.answers`; this state only preserves navigation/selection while
    /// the user reviews questions.
    pub(crate) states: Vec<QuestionDialogState>,
    /// Indices of selected options for the currently focused question.
    pub(crate) selected: Vec<usize>,
    /// Highlighted option row for keyboard/mouse navigation.
    pub(crate) cursor: usize,
    /// First visible option row when the list is taller than the dialog.
    pub(crate) scroll_top: usize,
    /// Index of the question currently being answered.
    pub(crate) focused: usize,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct QuestionDialogState {
    pub(crate) selected: Vec<usize>,
    pub(crate) cursor: usize,
    pub(crate) scroll_top: usize,
}

#[derive(Debug)]
pub(crate) struct GoalReplacementDialog {
    pub(crate) existing_summary: String,
    pub(crate) objective: String,
    pub(crate) token_budget: Option<u64>,
    pub(crate) mode: GoalMode,
    pub(crate) verification_kind: GoalVerificationKind,
    pub(crate) selected: usize,
}

/// Interactive slash-command menu with fuzzy matching.
#[derive(Debug)]
pub(crate) struct SlashMenu {
    pub(crate) selected: usize,
}

/// Context/token inspector overlay.
#[derive(Debug)]
pub(crate) struct ContextInspector {
    pub(crate) breakdown: ContextBreakdown,
}

/// Settings inspector overlay.
#[derive(Debug)]
pub(crate) struct SettingsInspector {
    pub(crate) lines: Vec<String>,
}

/// Tool input editor for the permission dialog's Edit option.
#[derive(Debug)]
pub(crate) struct PermissionEditor {
    pub(crate) tool_name: String,
    pub(crate) text: String,
    pub(crate) cursor_grapheme_index: usize,
    pub(crate) response_tx: tokio::sync::oneshot::Sender<PermissionDialogResult>,
}

/// Keyboard shortcuts help overlay.
#[derive(Debug)]
pub(crate) struct KeysOverlay;

/// Full transcript pager opened by Ctrl+T.
#[derive(Debug)]
pub(crate) struct TranscriptOverlay {
    pub(crate) scroll_top: usize,
    pub(crate) last_line_count: usize,
    pub(crate) last_height: u16,
}

impl TranscriptOverlay {
    pub(crate) fn new_at_bottom() -> Self {
        Self {
            scroll_top: usize::MAX,
            last_line_count: 0,
            last_height: 0,
        }
    }

    pub(crate) fn max_top(&self) -> usize {
        self.last_line_count
            .saturating_sub(self.last_height as usize)
    }

    pub(crate) fn resolved_top(&self) -> usize {
        if self.scroll_top == usize::MAX {
            self.max_top()
        } else {
            self.scroll_top.min(self.max_top())
        }
    }

    pub(crate) fn scroll_by(&mut self, delta: isize) {
        let current = self.resolved_top();
        self.scroll_top = if delta.is_negative() {
            current.saturating_sub(delta.unsigned_abs())
        } else {
            current.saturating_add(delta as usize).min(self.max_top())
        };
    }

    pub(crate) fn page_by(&mut self, pages: isize) {
        let rows = self.last_height.max(1) as isize;
        self.scroll_by(rows.saturating_mul(pages));
    }

    pub(crate) fn scroll_home(&mut self) {
        self.scroll_top = 0;
    }

    pub(crate) fn scroll_end(&mut self) {
        self.scroll_top = usize::MAX;
    }
}

/// Generic single-column picker overlay.
#[derive(Debug)]
pub(crate) struct PickerOverlay {
    pub(crate) title: &'static str,
    pub(crate) selected: usize,
    /// Filter typed by the user.
    pub(crate) filter: String,
    /// Original item list used when the filter is cleared.
    pub(crate) all_items: Vec<String>,
    /// Optional command values parallel to `all_items`. Empty means the
    /// display label itself is submitted.
    pub(crate) item_values: Vec<String>,
    /// Turn ids parallel to `all_items` (rewind picker only; empty otherwise).
    pub(crate) item_turns: Vec<u64>,
    /// What to do when the user confirms a selection.
    pub(crate) on_confirm: PickerAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PickerAction {
    ViewAgent,
    SwitchModel,
    SwitchTheme,
    RewindToTurn,
}

impl PickerOverlay {
    pub(crate) fn item_height(&self) -> u16 {
        if self.on_confirm == PickerAction::ViewAgent {
            2
        } else {
            1
        }
    }
    pub(crate) fn matches(&self) -> Vec<String> {
        self.matches_indexed()
            .into_iter()
            .map(|(_, item)| item)
            .collect()
    }

    /// Filtered items with their original `all_items` indices preserved, so
    /// parallel metadata (rewind turn ids) survives filtering.
    pub(crate) fn matches_indexed(&self) -> Vec<(usize, String)> {
        if self.filter.is_empty() {
            return self.all_items.iter().cloned().enumerate().collect();
        }
        let query = self.filter.to_lowercase();
        self.all_items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.to_lowercase().contains(&query))
            .map(|(index, item)| (index, item.clone()))
            .collect()
    }

    /// Turn id attached to the currently selected match (rewind picker only).
    /// The selection is clamped to the filtered list because callers that set
    /// `filter` directly may leave `selected` pointing past the end.
    pub(crate) fn selected_turn(&self) -> Option<u64> {
        let matches = self.matches_indexed();
        let selected = self.selected.min(matches.len().saturating_sub(1));
        let (index, _) = matches.into_iter().nth(selected)?;
        self.item_turns.get(index).copied()
    }

    pub(crate) fn value_for_original_index(&self, index: usize, label: &str) -> String {
        self.item_values
            .get(index)
            .cloned()
            .unwrap_or_else(|| label.to_string())
    }
}
