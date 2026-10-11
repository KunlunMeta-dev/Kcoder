//! Widgets for the KCoder TUI.
//!
//! These widgets are intentionally thin: they receive pre-computed data and
//! render themselves onto a ratatui `Buffer`. They do not own application
//! state; that stays in `crate::ReplApp`.

use ratatui::{buffer::Buffer, layout::Rect};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub mod composer;
pub mod footer;
pub mod header;
pub(crate) mod outline;
pub mod pending_input_preview;
pub mod status_indicator;

pub use crate::render::renderable::Renderable;
pub use composer::{ComposerData, ComposerWidget};
pub(crate) use composer::{composer_content_areas, composer_text_width};
pub(crate) use footer::{
    FooterData, FooterHint, FooterWidget, shortcut_overlay_lines_with_mode_switch,
};
pub(crate) use pending_input_preview::PendingInputPreview;
pub(crate) use status_indicator::{
    STATUS_INDICATOR_MAX_HEIGHT, StatusDetailsCapitalization, StatusIndicatorControls,
    StatusIndicatorData, StatusIndicatorWidget,
};

/// Clear characters and all styles in an overlay area so underlying Markdown modifiers cannot bleed through.
pub fn clear_area(area: Rect, buf: &mut Buffer, bg: ratatui::style::Color) {
    for y in area.top()..area.bottom() {
        for x in area.left()..area.right() {
            let cell = &mut buf[(x, y)];
            cell.reset();
            cell.set_bg(bg);
        }
    }
}

/// Helper: truncate a string to fit within `max_width` display columns,
/// adding an ellipsis when truncation occurs.
pub fn truncate_to_width(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    let width = unicode_width::UnicodeWidthStr::width(text);
    if width <= max_width {
        return text.to_string();
    }
    if max_width <= 3 {
        return truncate_without_ellipsis(text, max_width);
    }
    let mut out = String::new();
    let mut used = 0usize;
    let limit = max_width.saturating_sub(3);
    for grapheme in text.graphemes(true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if used + grapheme_width > limit {
            break;
        }
        out.push_str(grapheme);
        used += grapheme_width;
    }
    out.push_str("...");
    out
}

fn truncate_without_ellipsis(text: &str, max_width: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for grapheme in text.graphemes(true) {
        let grapheme_width = UnicodeWidthStr::width(grapheme);
        if used + grapheme_width > max_width {
            break;
        }
        out.push_str(grapheme);
        used += grapheme_width;
    }
    out
}

/// Helper: total display width of a slice of spans.
pub fn span_width(spans: &[ratatui::text::Span<'_>]) -> usize {
    spans.iter().map(|s| s.content.width()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_area_resets_inherited_cell_style_without_touching_neighbors() {
        use ratatui::{
            buffer::Cell,
            style::{Color, Modifier, Style},
        };

        let mut dirty = Cell::default();
        dirty.set_symbol("底").set_skip(true).set_style(
            Style::default()
                .fg(Color::Cyan)
                .bg(Color::Red)
                .add_modifier(
                    Modifier::UNDERLINED | Modifier::ITALIC | Modifier::BOLD | Modifier::REVERSED,
                ),
        );
        let mut buffer = Buffer::filled(Rect::new(0, 0, 14, 6), dirty.clone());
        let area = Rect::new(2, 1, 8, 3);
        clear_area(area, &mut buffer, Color::Black);
        let mut cleared = Cell::default();
        cleared.set_bg(Color::Black);
        for y in 0..6 {
            for x in 0..14 {
                let expected = if area.contains((x, y).into()) {
                    &cleared
                } else {
                    &dirty
                };
                assert_eq!(&buffer[(x, y)], expected, "cell ({x}, {y})");
            }
        }
    }

    #[test]
    fn truncate_to_width_keeps_ascii_behavior() {
        assert_eq!(truncate_to_width("abcdef", 6), "abcdef");
        assert_eq!(truncate_to_width("abcdef", 5), "ab...");
        assert_eq!(truncate_to_width("abcdef", 3), "abc");
    }

    #[test]
    fn truncate_to_width_does_not_split_grapheme_clusters() {
        let family = "👨‍👩‍👧‍👦";

        assert_eq!(
            truncate_to_width(
                &format!("{family}abcdef"),
                UnicodeWidthStr::width(family) + 4
            ),
            format!("{family}a...")
        );
        assert_eq!(truncate_to_width(&format!("{family}abc"), 1), "");
    }
}
