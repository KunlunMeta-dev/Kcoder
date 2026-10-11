//! Wrapped, scrollable settings diagnostics with viewport-bound scroll state.
use crate::{SettingsInspector, theme::KCODER_UI_THEME};
use crossterm::event::KeyCode;
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, Paragraph, Widget, Wrap},
};

pub(super) fn settings_inspector_natural_height(line_count: usize) -> u16 {
    (line_count.min(usize::from(u16::MAX.saturating_sub(6))) as u16).saturating_add(6)
}

impl SettingsInspector {
    pub(crate) fn scroll_key(&mut self, key: KeyCode) {
        self.scroll = match key {
            KeyCode::Up => self.scroll.saturating_sub(1),
            KeyCode::Down => self.scroll.saturating_add(1),
            KeyCode::PageUp => self.scroll.saturating_sub(self.page_rows.max(1)),
            KeyCode::PageDown => self.scroll.saturating_add(self.page_rows.max(1)),
            KeyCode::Home => 0,
            KeyCode::End => self.max_scroll,
            _ => self.scroll,
        }
        .min(self.max_scroll);
    }
}

pub(super) fn draw_settings_inspector(
    frame: &mut crate::custom_terminal::Frame,
    inspector: &mut SettingsInspector,
) {
    let area = frame.area();
    render_settings_inspector(area, frame.buffer_mut(), inspector);
}

fn render_settings_inspector(
    area: Rect,
    buffer: &mut ratatui::buffer::Buffer,
    inspector: &mut SettingsInspector,
) {
    if area.is_empty() {
        return;
    }
    let width = ((area.width as f32 * 0.7).clamp(50.0, 90.0) as u16)
        .min(area.width.saturating_sub(4).max(1));
    let height = settings_inspector_natural_height(inspector.lines.len())
        .min(area.height.saturating_sub(4).max(1));
    let dialog = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let band = Rect::new(area.x, dialog.y, area.width, dialog.height);
    Clear.render(band, buffer);
    crate::widgets::clear_area(band, buffer, KCODER_UI_THEME.panel_bg);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
        .title(Span::styled(
            " Settings ",
            Style::default()
                .fg(KCODER_UI_THEME.accent_primary)
                .add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(dialog);
    block.render(dialog, buffer);
    let body = Rect::new(
        inner.x,
        inner.y,
        inner.width,
        inner.height.saturating_sub(2),
    );
    let lines = inspector
        .lines
        .iter()
        .map(|line| Line::from(line.clone()))
        .collect::<Vec<_>>();
    let paragraph = Paragraph::new(Text::from(lines))
        .style(
            Style::default()
                .fg(Color::White)
                .bg(KCODER_UI_THEME.panel_bg),
        )
        .wrap(Wrap { trim: false });
    inspector.page_rows = body.height;
    inspector.max_scroll = paragraph
        .line_count(body.width.max(1))
        .saturating_sub(body.height as usize)
        .min(u16::MAX as usize) as u16;
    inspector.scroll = inspector.scroll.min(inspector.max_scroll);
    paragraph.scroll((inspector.scroll, 0)).render(body, buffer);
    if inner.height > 1 {
        let hint = Rect::new(inner.x, inner.y + inner.height - 2, inner.width, 2);
        Paragraph::new("Up/Down PgUp/PgDn Home/End: scroll\nEsc/q: close. /set <key> <value>.")
            .style(Style::default().fg(KCODER_UI_THEME.text_muted))
            .render(hint, buffer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn settings_inspector_wraps_scrolls_to_end_and_clamps_after_resize() {
        let mut inspector = SettingsInspector {
            lines: (0..40)
                .map(|i| {
                    format!(
                        "field {i}: context configuration source and an output limit that wraps"
                    )
                })
                .chain(["Next turn END_SENTINEL".into()])
                .collect(),
            scroll: 0,
            max_scroll: 0,
            page_rows: 0,
        };
        let mut terminal = Terminal::new(TestBackend::new(48, 16)).unwrap();
        terminal
            .draw(|frame| {
                render_settings_inspector(frame.area(), frame.buffer_mut(), &mut inspector)
            })
            .unwrap();
        assert!(inspector.max_scroll > inspector.lines.len() as u16);
        inspector.scroll_key(KeyCode::End);
        terminal
            .draw(|frame| {
                render_settings_inspector(frame.area(), frame.buffer_mut(), &mut inspector)
            })
            .unwrap();
        let text = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.contains("END_SENTINEL"));
        inspector.scroll_key(KeyCode::Home);
        assert_eq!(inspector.scroll, 0);
        inspector.scroll_key(KeyCode::PageDown);
        assert_eq!(inspector.scroll, inspector.page_rows);
        inspector.scroll_key(KeyCode::End);
        let narrow_scroll = inspector.scroll;
        terminal.backend_mut().resize(140, 60);
        terminal.resize(Rect::new(0, 0, 140, 60)).unwrap();
        terminal
            .draw(|frame| {
                render_settings_inspector(frame.area(), frame.buffer_mut(), &mut inspector)
            })
            .unwrap();
        assert!(inspector.scroll < narrow_scroll);
        assert_eq!(inspector.scroll, inspector.max_scroll);
        inspector.scroll_key(KeyCode::Down);
        assert_eq!(inspector.scroll, inspector.max_scroll);
        inspector.scroll_key(KeyCode::PageUp);
        assert_eq!(
            inspector.scroll,
            inspector.max_scroll.saturating_sub(inspector.page_rows)
        );
    }

    #[test]
    fn settings_inspector_handles_tiny_viewport() {
        let mut inspector = SettingsInspector {
            lines: vec!["model diagnostics".into()],
            scroll: u16::MAX,
            max_scroll: 0,
            page_rows: 0,
        };
        let mut terminal = Terminal::new(TestBackend::new(2, 2)).unwrap();
        terminal
            .draw(|frame| {
                render_settings_inspector(frame.area(), frame.buffer_mut(), &mut inspector)
            })
            .unwrap();
        assert!(inspector.scroll <= inspector.max_scroll);
    }
}
