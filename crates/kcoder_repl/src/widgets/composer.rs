//! Composer (input) widget for KCoder.
//!
//! Renders the user's message input area with the live prefix,
//! subtle message background, and a separate footer row for hints/status.

use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph, Widget, Wrap},
};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::{self, UiTheme};
use crate::widgets::{clear_area, truncate_to_width};

/// Columns reserved for live prefixes (`› `, status rows, and similar UI elements).
pub(crate) const LIVE_PREFIX_COLS: u16 = 2;
const COMPOSER_RIGHT_MARGIN: u16 = 1;

pub(crate) fn composer_text_width(width: u16) -> u16 {
    width
        .saturating_sub(LIVE_PREFIX_COLS)
        .saturating_sub(COMPOSER_RIGHT_MARGIN)
        .max(1)
}

pub(crate) fn composer_text_area(area: Rect) -> Rect {
    Rect {
        x: area.x.saturating_add(LIVE_PREFIX_COLS),
        y: area.y.saturating_add(1),
        width: composer_text_width(area.width),
        height: area.height.saturating_sub(2),
    }
}

/// Composer rendering data.
pub struct ComposerData<'a> {
    pub text: &'a str,
    pub placeholder: &'a str,
    pub is_focused: bool,
    pub ui_theme: &'a UiTheme,
    pub scroll: usize,
    shell_prompt: bool,
    image_placeholders: Vec<&'a str>,
    paste_placeholders: Vec<&'a str>,
    remote_image_count: usize,
    selected_remote_image_index: Option<usize>,
}

impl<'a> ComposerData<'a> {
    pub fn new(
        text: &'a str,
        placeholder: &'a str,
        is_focused: bool,
        _show_hints: bool,
        _hint: &'a str,
        ui_theme: &'a UiTheme,
        scroll: usize,
    ) -> Self {
        Self {
            text,
            placeholder,
            is_focused,
            ui_theme,
            scroll,
            shell_prompt: false,
            image_placeholders: Vec::new(),
            paste_placeholders: Vec::new(),
            remote_image_count: 0,
            selected_remote_image_index: None,
        }
    }

    pub fn with_shell_prompt(mut self, shell_prompt: bool) -> Self {
        self.shell_prompt = shell_prompt;
        self
    }

    pub fn with_image_placeholders(mut self, placeholders: Vec<&'a str>) -> Self {
        self.image_placeholders = placeholders;
        self
    }

    pub fn with_paste_placeholders(mut self, placeholders: Vec<&'a str>) -> Self {
        self.paste_placeholders = placeholders;
        self
    }

    pub fn with_remote_images(mut self, count: usize, selected_index: Option<usize>) -> Self {
        self.remote_image_count = count;
        self.selected_remote_image_index = selected_index.filter(|index| *index < count);
        self
    }
}

/// Composer widget.
pub struct ComposerWidget<'a> {
    data: ComposerData<'a>,
}

impl<'a> ComposerWidget<'a> {
    pub fn new(data: ComposerData<'a>) -> Self {
        Self { data }
    }
}

impl crate::widgets::Renderable for ComposerWidget<'_> {
    fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.height == 0 || area.width < 2 {
            return;
        }

        let surface_bg = theme::user_surface_bg();
        clear_area(area, buf, surface_bg);
        if area.height < 3 || area.width < 4 {
            self.render_compact(area, buf);
            return;
        }

        Block::default()
            .style(Style::default().bg(surface_bg))
            .render(area, buf);
        let [remote_images_area, text_area] =
            composer_content_areas(area, self.data.remote_image_count);
        if remote_images_area.is_empty() && text_area.is_empty() {
            return;
        }

        if !remote_images_area.is_empty() {
            Paragraph::new(remote_image_lines(&self.data))
                .style(Style::default().bg(surface_bg))
                .render(remote_images_area, buf);
        }

        // Render the composer with the SAME wrapping the app uses for cursor
        // and scroll math (`crate::wrap_text_rows`). ratatui's WordWrapper
        // breaks at word boundaries while our math breaks at grapheme
        // boundaries, so wrapping the paragraph twice (once for math, once by
        // ratatui) desynchronized scroll and cursor on long input and caused
        // visible misalignment.
        self.render_wrapped_rows(text_area, buf);

        let prompt_x = text_area.x.saturating_sub(LIVE_PREFIX_COLS);
        buf.set_span(
            prompt_x,
            text_area.y,
            &Span::styled(prompt_symbol(&self.data), prompt_style(&self.data)),
            LIVE_PREFIX_COLS,
        );
    }

    fn desired_height(&self, _width: u16) -> u16 {
        let remote_rows: u16 = self
            .data
            .remote_image_count
            .min(usize::from(u16::MAX))
            .try_into()
            .unwrap_or(u16::MAX);
        3u16.saturating_add(remote_rows)
            .saturating_add(u16::from(remote_rows > 0))
    }
}

impl ComposerWidget<'_> {
    /// Render the composer content with the same grapheme-boundary wrapping
    /// used for cursor/scroll computation, so a long paste can never desync
    /// the visible window from the cursor position.
    fn render_wrapped_rows(&self, text_area: Rect, buf: &mut Buffer) {
        if text_area.is_empty() {
            return;
        }
        if self.data.text.is_empty() {
            let placeholder = Line::from(vec![Span::styled(
                self.data.placeholder.to_string(),
                Style::default().fg(self.data.ui_theme.text_dim),
            )]);
            Paragraph::new(placeholder).render(text_area, buf);
            return;
        }

        let rows = crate::wrap_text_rows(self.data.text, text_area.width);
        let graphemes: Vec<&str> = self.data.text.graphemes(true).collect();
        let scroll = self.data.scroll.min(rows.len().saturating_sub(1));
        let surface_bg = theme::user_surface_bg();
        let bg = Style::default().bg(surface_bg);
        buf.set_style(text_area, bg);

        for (row_index, (start, end)) in rows.iter().enumerate().skip(scroll) {
            let y = text_area.y.saturating_add((row_index - scroll) as u16);
            if y >= text_area.y.saturating_add(text_area.height) {
                break;
            }
            let row_text: String = graphemes[*start..*end].concat();
            let line = styled_input_line(&row_text, &self.data);
            let mut x = text_area.x;
            for span in line.spans {
                let style = span.style.bg(surface_bg);
                for grapheme in span.content.graphemes(true) {
                    let width = unicode_width::UnicodeWidthStr::width(grapheme) as u16;
                    if width == 0 {
                        continue;
                    }
                    if x < text_area.x.saturating_add(text_area.width) {
                        buf[(x, y)].set_symbol(grapheme).set_style(style);
                    }
                    x = x.saturating_add(width);
                }
            }
        }
    }

    fn display_lines(&self) -> Vec<Line<'static>> {
        if self.data.text.is_empty() {
            vec![Line::from(vec![Span::styled(
                self.data.placeholder.to_string(),
                Style::default().fg(self.data.ui_theme.text_dim),
            )])]
        } else {
            self.data
                .text
                .split('\n')
                .map(|line| styled_input_line(line, &self.data))
                .collect()
        }
    }

    fn render_compact(&self, area: Rect, buf: &mut Buffer) {
        let prompt_width = LIVE_PREFIX_COLS.min(area.width);
        buf.set_span(
            area.x,
            area.y,
            &Span::styled(prompt_symbol(&self.data), prompt_style(&self.data)),
            prompt_width,
        );

        let text_x = area.x.saturating_add(prompt_width);
        let text_width = area.width.saturating_sub(prompt_width);
        if text_width == 0 {
            return;
        }
        Paragraph::new(self.display_lines())
            .wrap(Wrap { trim: false })
            .scroll((self.data.scroll.min(u16::MAX as usize) as u16, 0))
            .style(theme::user_surface_style())
            .render(Rect::new(text_x, area.y, text_width, 1), buf);
    }
}

fn prompt_symbol(data: &ComposerData<'_>) -> &'static str {
    if data.shell_prompt { "!" } else { "›" }
}

fn prompt_style(data: &ComposerData<'_>) -> Style {
    if data.shell_prompt {
        Style::default()
            .fg(data.ui_theme.error_fg)
            .add_modifier(Modifier::BOLD)
    } else if data.is_focused {
        Style::default()
            .fg(data.ui_theme.accent_primary)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(data.ui_theme.text_dim)
    }
}

pub(crate) fn composer_content_areas(area: Rect, remote_image_count: usize) -> [Rect; 2] {
    let mut text_area = composer_text_area(area);
    if text_area.is_empty() || remote_image_count == 0 {
        return [Rect::default(), text_area];
    }

    let remote_height: u16 = remote_image_count
        .min(usize::from(text_area.height.saturating_sub(2)))
        .try_into()
        .unwrap_or(0);
    if remote_height == 0 {
        return [Rect::default(), text_area];
    }

    let remote_images_area = Rect {
        height: remote_height,
        ..text_area
    };
    let consumed = remote_height.saturating_add(1);
    text_area.y = text_area.y.saturating_add(consumed);
    text_area.height = text_area.height.saturating_sub(consumed);
    [remote_images_area, text_area]
}

fn remote_image_lines(data: &ComposerData<'_>) -> Vec<Line<'static>> {
    let theme = data.ui_theme;
    (0..data.remote_image_count)
        .map(|index| {
            let style = if data.selected_remote_image_index == Some(index) {
                Style::default()
                    .fg(theme.accent_primary)
                    .add_modifier(Modifier::REVERSED)
            } else {
                Style::default().fg(theme.accent_primary)
            };
            Line::from(Span::styled(format!("[Image #{}]", index + 1), style))
        })
        .collect()
}

fn styled_input_line(line: &str, data: &ComposerData<'_>) -> Line<'static> {
    let theme = data.ui_theme;
    let body_style = Style::default().fg(theme.text_body);
    let image_style = Style::default()
        .fg(theme.accent_primary)
        .add_modifier(Modifier::BOLD);
    let paste_style = Style::default().fg(theme.text_dim);
    let mut elements: Vec<(&str, Style)> = data
        .image_placeholders
        .iter()
        .copied()
        .filter(|placeholder| !placeholder.is_empty())
        .map(|placeholder| (placeholder, image_style))
        .collect();
    elements.extend(
        data.paste_placeholders
            .iter()
            .copied()
            .filter(|placeholder| !placeholder.is_empty())
            .map(|placeholder| (placeholder, paste_style)),
    );

    if elements.is_empty()
        || !elements
            .iter()
            .any(|(placeholder, _)| line.contains(placeholder))
    {
        return Line::from(vec![Span::styled(line.to_string(), body_style)]);
    }

    let mut spans = Vec::new();
    let mut rest = line;
    while !rest.is_empty() {
        let mut best: Option<(usize, &str, Style)> = None;
        for (placeholder, style) in &elements {
            let Some(pos) = rest.find(placeholder) else {
                continue;
            };
            if best.as_ref().is_none_or(|(best_pos, best_placeholder, _)| {
                pos < *best_pos || (pos == *best_pos && placeholder.len() > best_placeholder.len())
            }) {
                best = Some((pos, placeholder, *style));
            }
        }

        let Some((pos, placeholder, style)) = best else {
            spans.push(Span::styled(rest.to_string(), body_style));
            break;
        };
        if pos > 0 {
            spans.push(Span::styled(rest[..pos].to_string(), body_style));
        }
        spans.push(Span::styled(placeholder.to_string(), style));
        rest = &rest[pos + placeholder.len()..];
    }

    Line::from(spans)
}

/// Render a compact single-line composer when height is tight.
#[allow(dead_code)]
pub fn compact_composer_line(
    text: &str,
    placeholder: &str,
    theme: &UiTheme,
    area: Rect,
    buf: &mut Buffer,
) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let display = if text.is_empty() {
        format!("> {} ({})", placeholder, theme.accent_primary)
    } else {
        format!("> {}", truncate_to_width(text, area.width as usize))
    };
    let line = Line::from(vec![Span::styled(
        display,
        Style::default().fg(theme.text_body),
    )]);
    Paragraph::new(line).render(area, buf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::KCODER_UI_THEME;
    use crate::widgets::Renderable;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    fn render_composer(width: u16, height: u16, data: ComposerData<'_>) -> Buffer {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, height));
        ComposerWidget::new(data).render(buf.area, &mut buf);
        buf
    }

    fn row_text(buf: &Buffer, row: u16) -> String {
        (0..buf.area.width)
            .map(|col| buf[(col, row)].symbol())
            .collect()
    }

    fn row_text_from(buf: &Buffer, row: u16, start_col: u16) -> String {
        (start_col..buf.area.width)
            .map(|col| buf[(col, row)].symbol())
            .collect()
    }

    #[test]
    fn composer_shows_placeholder_when_empty() {
        let data = ComposerData::new("", "Type a message…", false, false, "", &KCODER_UI_THEME, 0);
        let buf = render_composer(40, 5, data);
        let text: String = buf
            .content
            .chunks(buf.area.width as usize)
            .take(3)
            .flat_map(|line| line.iter().map(|c| c.symbol()))
            .collect();
        assert!(text.contains("Type a message…"));
    }

    #[test]
    fn composer_renders_input_text() {
        let data = ComposerData::new("hello world", "", false, false, "", &KCODER_UI_THEME, 0);
        let buf = render_composer(40, 5, data);
        let text: String = buf
            .content
            .chunks(buf.area.width as usize)
            .take(3)
            .flat_map(|line| line.iter().map(|c| c.symbol()))
            .collect();
        assert!(text.contains("hello world"));
    }

    #[test]
    fn compact_height_one_still_renders_prompt_and_placeholder() {
        let data = ComposerData::new(
            "",
            "Ask KCoder to do anything",
            true,
            false,
            "",
            &KCODER_UI_THEME,
            0,
        );
        let buf = render_composer(24, 1, data);
        let row = row_text(&buf, 0);

        assert!(row.starts_with("› "));
        assert!(row.contains("Ask KCoder"));
    }

    #[test]
    fn compact_height_one_still_renders_input_text() {
        let data = ComposerData::new("hello world", "", true, false, "", &KCODER_UI_THEME, 0);
        let buf = render_composer(24, 1, data);
        let row = row_text(&buf, 0);

        assert!(row.starts_with("› "));
        assert!(row.contains("hello world"));
    }

    #[test]
    fn composer_highlights_image_and_paste_placeholders() {
        let paste = "[Pasted Content 1200 chars]";
        let data = ComposerData::new(
            "[Image #1] and [Pasted Content 1200 chars]",
            "",
            true,
            false,
            "",
            &KCODER_UI_THEME,
            0,
        )
        .with_image_placeholders(vec!["[Image #1]"])
        .with_paste_placeholders(vec![paste]);
        let buf = render_composer(60, 5, data);

        assert_eq!(buf[(2, 1)].fg, KCODER_UI_THEME.accent_primary);
        assert_eq!(buf[(17, 1)].fg, KCODER_UI_THEME.text_dim);
    }

    #[test]
    fn composer_renders_codex_live_prefix_without_border_box() {
        let data = ComposerData::new("", "Type a message…", true, true, "", &KCODER_UI_THEME, 0);
        let buf = render_composer(40, 5, data);
        let text: String = buf.content.iter().map(|c| c.symbol()).collect();
        assert!(text.contains("›"));
        assert!(
            buf[(0, 1)].modifier.contains(Modifier::BOLD),
            "focused live prompt should match Codex's bold prompt styling"
        );
        for ch in ["┌", "┐", "└", "┘", "│", "─"] {
            assert!(!text.contains(ch), "unexpected composer border glyph {ch}");
        }
    }

    #[test]
    fn composer_renders_shell_prompt_prefix() {
        let data = ComposerData::new("git status", "", true, false, "", &KCODER_UI_THEME, 0)
            .with_shell_prompt(true);
        let buf = render_composer(40, 5, data);
        let text: String = buf
            .content
            .chunks(buf.area.width as usize)
            .take(3)
            .flat_map(|line| line.iter().map(|c| c.symbol()))
            .collect();

        assert_eq!(buf[(0, 1)].symbol(), "!");
        assert_eq!(buf[(0, 1)].fg, KCODER_UI_THEME.error_fg);
        assert!(
            buf[(0, 1)].modifier.contains(Modifier::BOLD),
            "shell prompt should match Codex's bold red bang"
        );
        assert!(text.contains("git status"));
        assert!(!text.contains("!git status"));
    }

    #[test]
    fn long_input_scroll_window_matches_the_app_wrap_math() {
        // Words sized so that ratatui's word-boundary WordWrapper and the
        // app's grapheme-boundary wrap_text_rows produce different rows;
        // the visible window must follow the app's math (single source).
        let text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn";
        let width = 30u16; // text_area.width = 27
        let rows = crate::wrap_text_rows(text, 27);
        assert!(rows.len() >= 3, "test text must wrap into several rows");

        let scroll = 1usize;
        let data = ComposerData::new(text, "", true, false, "", &KCODER_UI_THEME, scroll);
        let buf = render_composer(width, 5, data);

        let graphemes: Vec<&str> = text.graphemes(true).collect();
        let expected_first: String = graphemes[rows[scroll].0..rows[scroll].1].concat();
        let visible_first = row_text_from(&buf, 1, 2);
        assert!(
            visible_first.starts_with(expected_first.trim_end()),
            "first visible row must be the app's wrapped row {scroll}: expected {expected_first:?}, got {visible_first:?}"
        );
        // The ratatui WordWrapper would have started this row at a word
        // boundary instead; assert the grapheme-boundary cut is what renders.
        assert!(
            visible_first.starts_with("ff "),
            "row must cut mid-word per the app's math, got {visible_first:?}"
        );
    }

    #[test]
    fn long_cjk_input_scroll_window_stays_aligned() {
        let text = "项目需要支持超长上下文压缩策略，并且要在不丢失最近几轮对话的前提下，把早期工具输出持久化到磁盘。";
        let width = 24u16; // text_area.width = 21
        let rows = crate::wrap_text_rows(text, 21);
        assert!(rows.len() >= 3);

        let scroll = 2usize;
        let data = ComposerData::new(text, "", true, false, "", &KCODER_UI_THEME, scroll);
        let buf = render_composer(width, 5, data);

        let graphemes: Vec<&str> = text.graphemes(true).collect();
        let expected_first: String = graphemes[rows[scroll].0..rows[scroll].1].concat();
        // Wide CJK glyphs occupy two cells, and the continuation cell reads
        // back as a space, so compare with spaces stripped.
        let visible_first: String = row_text_from(&buf, 1, 2).replace(' ', "");
        let expected: String = expected_first.replace(' ', "");
        assert!(
            visible_first.starts_with(expected.trim_end()),
            "CJK wrapped row {scroll} mismatch: expected {expected:?}, got {visible_first:?}"
        );
    }

    #[test]
    fn multiline_and_trailing_newline_do_not_misalign_scroll() {
        let text = "first line\n\nthird line that is quite a bit longer than the width here\n";
        let width = 22u16; // text_area.width = 19
        let rows = crate::wrap_text_rows(text, 19);
        let scroll = rows.len().saturating_sub(2);
        let data = ComposerData::new(text, "", true, false, "", &KCODER_UI_THEME, scroll);
        let buf = render_composer(width, 5, data);
        // Rendering must not panic or overflow on empty wrapped rows.
        let visible_first = row_text_from(&buf, 1, 2);
        let graphemes: Vec<&str> = text.graphemes(true).collect();
        let expected_first: String = graphemes[rows[scroll].0..rows[scroll].1].concat();
        assert!(visible_first.starts_with(expected_first.trim_end()));
    }

    #[test]
    fn focused_composer_does_not_draw_fake_cursor_block() {
        let data = ComposerData::new("hello world", "", true, false, "", &KCODER_UI_THEME, 0);
        let buf = render_composer(40, 5, data);
        let text: String = buf.content.iter().map(|c| c.symbol()).collect();
        assert!(
            !text.contains('█'),
            "composer should rely on the terminal cursor instead of drawing a second block"
        );
    }

    #[test]
    fn composer_desired_height_is_three() {
        let data = ComposerData::new("", "", false, false, "", &KCODER_UI_THEME, 0);
        assert_eq!(ComposerWidget::new(data).desired_height(100), 3);
    }

    #[test]
    fn composer_remote_image_rows_render_above_textarea() {
        let data = ComposerData::new("describe these", "", true, false, "", &KCODER_UI_THEME, 0)
            .with_remote_images(2, None);
        let buf = render_composer(60, 6, data);
        let text: String = buf.content.iter().map(|c| c.symbol()).collect();

        assert!(row_text(&buf, 1).contains("[Image #1]"));
        assert!(row_text(&buf, 2).contains("[Image #2]"));
        assert_eq!(buf[(0, 4)].symbol(), "›");
        assert!(text.contains("[Image #1]"));
        assert!(text.contains("[Image #2]"));
        assert!(text.contains("describe these"));
    }

    #[test]
    fn composer_remote_image_rows_can_be_selected() {
        let data = ComposerData::new("describe these", "", true, false, "", &KCODER_UI_THEME, 0)
            .with_remote_images(2, Some(1));
        let buf = render_composer(60, 6, data);

        assert_eq!(buf[(2, 1)].fg, KCODER_UI_THEME.accent_primary);
        assert!(!buf[(2, 1)].modifier.contains(Modifier::REVERSED));
        assert_eq!(buf[(2, 2)].fg, KCODER_UI_THEME.accent_primary);
        assert!(buf[(2, 2)].modifier.contains(Modifier::REVERSED));
    }

    #[test]
    fn composer_remote_image_rows_leave_text_row_when_height_is_tight() {
        let [remote_area, text_area] = composer_content_areas(Rect::new(0, 0, 40, 5), 8);

        assert_eq!(remote_area.height, 1);
        assert_eq!(text_area.height, 1);
    }

    #[test]
    fn composer_desired_height_includes_remote_image_rows() {
        let data = ComposerData::new("", "", false, false, "", &KCODER_UI_THEME, 0)
            .with_remote_images(2, None);
        assert_eq!(ComposerWidget::new(data).desired_height(100), 6);
    }

    #[test]
    fn composer_renders_scrolled_slice() {
        let data = ComposerData::new(
            "line1\nline2\nline3\nline4\nline5",
            "",
            true,
            false,
            "",
            &KCODER_UI_THEME,
            2,
        );
        let buf = render_composer(40, 5, data);
        let text: String = buf.content.iter().map(|c| c.symbol()).collect();

        assert!(text.contains("line3"));
        assert!(text.contains("line4"));
        assert!(!text.contains("line1"));
    }

    #[test]
    fn composer_scrolls_by_wrapped_visual_rows() {
        let data = ComposerData::new(
            "111111122222223333333",
            "",
            true,
            false,
            "",
            &KCODER_UI_THEME,
            1,
        );
        let buf = render_composer(10, 4, data);

        assert!(row_text(&buf, 1).contains("2222222"));
        assert!(row_text(&buf, 2).contains("3333333"));
        assert!(!row_text(&buf, 1).contains("1111111"));
    }

    #[test]
    fn composer_preserves_trailing_empty_line() {
        let data = ComposerData::new("first\n", "", true, false, "", &KCODER_UI_THEME, 1);
        let buf = render_composer(20, 3, data);

        assert!(
            row_text(&buf, 1)
                .chars()
                .skip(2)
                .collect::<String>()
                .trim()
                .is_empty()
        );
        assert_eq!(buf[(0, 1)].symbol(), "›");
    }
}
