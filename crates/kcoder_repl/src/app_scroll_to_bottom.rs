//! Contextual transcript navigation in the existing composer spacer row.
use super::*;

impl ReplApp {
    pub(super) fn can_return_to_bottom(&self) -> bool {
        (!self.transcript_viewport.is_at_tail() || self.navigation.anchor.is_some())
            && !self.shutdown_in_progress
            && (!self.has_active_overlay()
                || (self.active_overlay == Some(OverlayKind::Transcript) && self.navigation.inline))
            && self.pending_permission.is_none()
            && self.permission_editor.is_none()
            && self.pending_question.is_none()
            && self.pending_goal_replacement.is_none()
            && self.slash_menu.is_none()
            && self.mention_menu.is_none()
            && !self.footer_shortcuts_overlay
            && self.transcript_selection.is_none()
    }

    pub(super) fn draw_scroll_to_bottom(&mut self, frame: &mut Frame, area: Rect) {
        self.last_scroll_to_bottom_area = None;
        if !self.can_return_to_bottom() || area.height == 0 || area.width == 0 {
            return;
        }
        let label = if area.width >= 24 {
            if cfg!(windows) {
                " v Back to bottom | Esc "
            } else {
                " ↓ Back to bottom · Esc "
            }
        } else if area.width >= 16 {
            if cfg!(windows) {
                " v Bottom | Esc "
            } else {
                " ↓ Bottom · Esc "
            }
        } else if cfg!(windows) {
            " v Bottom "
        } else {
            " ↓ Bottom "
        };
        let width = (Line::from(label).width().min(usize::from(area.width))) as u16;
        let button = Rect::new(area.x + (area.width - width) / 2, area.y, width, 1);
        let hovered = self
            .last_mouse_pos
            .is_some_and(|(x, y)| rect_contains(button, x, y));
        let mut style = Style::default().fg(KCODER_UI_THEME.accent_primary);
        if hovered {
            style = style
                .bg(KCODER_UI_THEME.elevated_bg)
                .add_modifier(Modifier::BOLD);
        }
        frame.render_widget(Paragraph::new(label).style(style), button);
        self.last_scroll_to_bottom_area = Some(button);
    }

    pub(super) fn click_scroll_to_bottom(&mut self, column: u16, row: u16) -> bool {
        if self.can_return_to_bottom()
            && self
                .last_scroll_to_bottom_area
                .is_some_and(|area| rect_contains(area, column, row))
        {
            self.jump_transcript("latest");
            self.last_scroll_to_bottom_area = None;
            return true;
        }
        false
    }
}
