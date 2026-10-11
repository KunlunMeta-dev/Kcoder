use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::windows_compat::UI_ELLIPSIS;

pub(crate) fn line_width(line: &Line<'_>) -> usize {
    line.iter()
        .map(|span| UnicodeWidthStr::width(span.content.as_ref()))
        .sum()
}

pub(crate) fn truncate_line_to_width(line: Line<'static>, max_width: usize) -> Line<'static> {
    if max_width == 0 {
        return Line::from(Vec::<Span<'static>>::new());
    }

    let Line {
        style,
        alignment,
        spans,
    } = line;
    let mut used = 0usize;
    let mut spans_out: Vec<Span<'static>> = Vec::with_capacity(spans.len());

    for span in spans {
        let span_width = UnicodeWidthStr::width(span.content.as_ref());

        if span_width == 0 {
            spans_out.push(span);
            continue;
        }

        if used >= max_width {
            break;
        }

        if used + span_width <= max_width {
            used += span_width;
            spans_out.push(span);
            continue;
        }

        let style = span.style;
        let text = span.content.as_ref();
        let mut end_idx = 0usize;
        for (idx, grapheme) in text.grapheme_indices(true) {
            let grapheme_width = UnicodeWidthStr::width(grapheme);
            if used + grapheme_width > max_width {
                break;
            }
            end_idx = idx + grapheme.len();
            used += grapheme_width;
        }

        if end_idx > 0 {
            spans_out.push(Span::styled(text[..end_idx].to_string(), style));
        }

        break;
    }

    Line {
        style,
        alignment,
        spans: spans_out,
    }
}

/// Truncate a styled line to `max_width` and append an ellipsis on overflow.
pub(crate) fn truncate_line_with_ellipsis_if_overflow(
    line: Line<'static>,
    max_width: usize,
) -> Line<'static> {
    if max_width == 0 {
        return Line::from(Vec::<Span<'static>>::new());
    }

    if line_width(&line) <= max_width {
        return line;
    }

    let truncated = truncate_line_to_width(line, max_width.saturating_sub(1));
    let Line {
        style,
        alignment,
        mut spans,
    } = truncated;
    let ellipsis_style = spans.last().map(|span| span.style).unwrap_or_default();
    spans.push(Span::styled(UI_ELLIPSIS, ellipsis_style));
    Line {
        style,
        alignment,
        spans,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::{Color, Style};

    fn plain(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>()
    }

    #[test]
    fn truncates_across_styled_spans() {
        let line = Line::from(vec![
            Span::styled("abc", Style::default().fg(Color::Red)),
            Span::styled("def", Style::default().fg(Color::Blue)),
        ]);

        let truncated = truncate_line_to_width(line, 4);

        assert_eq!(plain(&truncated), "abcd");
        assert_eq!(truncated.spans[0].style.fg, Some(Color::Red));
        assert_eq!(truncated.spans[1].style.fg, Some(Color::Blue));
    }

    #[test]
    fn ellipsis_uses_last_visible_span_style() {
        let line = Line::from(vec![
            Span::styled("abc", Style::default().fg(Color::Red)),
            Span::styled("def", Style::default().fg(Color::Blue)),
        ]);

        let truncated = truncate_line_with_ellipsis_if_overflow(line, 5);

        assert_eq!(plain(&truncated), format!("abcd{UI_ELLIPSIS}"));
        assert_eq!(truncated.spans.last().unwrap().style.fg, Some(Color::Blue));
    }

    #[test]
    fn wide_chars_do_not_overflow_width() {
        let line = Line::from(vec![Span::raw("a界b")]);

        let truncated = truncate_line_with_ellipsis_if_overflow(line, 3);

        assert_eq!(plain(&truncated), format!("a{UI_ELLIPSIS}"));
        assert_eq!(line_width(&truncated), 2);
    }

    #[test]
    fn truncation_does_not_split_grapheme_clusters() {
        let family = "👨‍👩‍👧‍👦";
        let line = Line::from(vec![Span::raw(format!("{family}abc"))]);
        let max_width = UnicodeWidthStr::width(family).saturating_add(1);

        let truncated = truncate_line_with_ellipsis_if_overflow(line, max_width);

        assert_eq!(plain(&truncated), format!("{family}{UI_ELLIPSIS}"));
        assert_eq!(line_width(&truncated), max_width);
    }
}
