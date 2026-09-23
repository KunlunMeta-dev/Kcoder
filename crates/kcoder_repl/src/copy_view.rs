//! The copy view retains immutable source text; selections use UTF-8 byte positions rather than screen row numbers.

use crate::{OverlayKind, ReplApp, custom_terminal::Frame};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use kcoder_types::{DisplayMessage, MessageRole};
use pulldown_cmark::{Event, Parser, Tag, TagEnd};
use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};
use std::{
    ops::Range,
    sync::Arc,
    time::{Duration, Instant},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const MAX_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 1024;

struct CopyEntry {
    title: String,
    text: Arc<str>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Click {
    Entry(usize),
    Copy,
    Close,
}

pub(super) struct CopyView {
    entries: Vec<CopyEntry>,
    selected: usize,
    rows: Vec<Range<usize>>,
    width: u16,
    top: usize,
    selection: Option<(usize, usize)>,
    drag: Option<(u16, u16)>,
    last_auto_scroll: Instant,
    body: Rect,
    list: Rect,
    list_top: usize,
    copy_button: Rect,
    close_button: Rect,
    press: Option<Click>,
    status: String,
    limited: bool,
}

impl CopyView {
    fn new<'a>(messages: impl DoubleEndedIterator<Item = &'a DisplayMessage>) -> Option<Self> {
        let mut answers = Vec::new();
        let mut bytes = 0usize;
        let mut limited = messages.size_hint().0 > 4096;
        for message in messages.rev().take(4096) {
            if answers.len() >= MAX_ENTRIES / 2 {
                limited = true;
                break;
            }
            if message.role != MessageRole::Assistant || message.text.is_empty() {
                continue;
            }
            if crate::message_render::display_text_is_hidden_internal_context(&message.text, false)
            {
                continue;
            }
            if bytes.saturating_add(message.text.len()) > MAX_SOURCE_BYTES {
                limited = true;
                continue;
            }
            bytes += message.text.len();
            answers.push(message.text.as_str());
        }
        answers.reverse();
        let answer_count = answers.len();
        let mut entries = Vec::new();
        let mut selected = 0;
        for (index, text) in answers.into_iter().enumerate() {
            if entries.len() >= MAX_ENTRIES {
                limited = true;
                break;
            }
            selected = entries.len();
            entries.push(CopyEntry {
                title: format!(
                    "Answer {} · {}",
                    index + 1,
                    text.lines()
                        .next()
                        .unwrap_or("")
                        .chars()
                        .take(24)
                        .collect::<String>()
                ),
                text: Arc::from(text),
            });
            let mut code: Option<String> = None;
            let mut language = String::new();
            let mut count = 0;
            for (events, event) in Parser::new(text).enumerate() {
                if events >= 200_000 {
                    limited = true;
                    break;
                }
                match event {
                    Event::Start(Tag::CodeBlock(kind)) => {
                        language = match kind {
                            pulldown_cmark::CodeBlockKind::Fenced(info) => info
                                .split([',', ' ', '\t'])
                                .next()
                                .unwrap_or("")
                                .chars()
                                .take(32)
                                .collect(),
                            _ => String::new(),
                        };
                        code = Some(String::new());
                    }
                    Event::Text(value) if code.is_some() => code.as_mut().unwrap().push_str(&value),
                    Event::End(TagEnd::CodeBlock) => {
                        let value = code.take().unwrap_or_default();
                        if bytes.saturating_add(value.len()) <= MAX_SOURCE_BYTES
                            && entries.len() < MAX_ENTRIES - (answer_count - index - 1)
                        {
                            bytes += value.len();
                            count += 1;
                            entries.push(CopyEntry {
                                title: format!("  Code {count} · {language}"),
                                text: Arc::from(value),
                            });
                        } else {
                            limited = true;
                        }
                    }
                    _ => {}
                }
            }
        }
        if entries.is_empty() {
            return None;
        }
        Some(Self {
            entries,
            selected,
            rows: Vec::new(),
            width: 0,
            top: 0,
            selection: None,
            drag: None,
            last_auto_scroll: Instant::now(),
            body: Rect::ZERO,
            list: Rect::ZERO,
            list_top: 0,
            copy_button: Rect::ZERO,
            close_button: Rect::ZERO,
            press: None,
            status: String::new(),
            limited,
        })
    }

    fn text(&self) -> &str {
        &self.entries[self.selected].text
    }

    fn reflow(&mut self, width: u16) {
        let width = width.max(1);
        if self.width == width {
            return;
        }
        let source_top = self.rows.get(self.top).map_or(0, |row| row.start);
        self.rows = source_rows(self.text(), usize::from(width));
        if self.rows.is_empty() {
            self.status = "Body exceeds 200,000 visual rows and cannot be previewed; full text can still be copied".to_string();
        }
        self.width = width;
        self.top = self
            .rows
            .iter()
            .rposition(|row| row.start <= source_top)
            .unwrap_or(0);
    }

    fn select_entry(&mut self, index: usize) {
        self.selected = index.min(self.entries.len() - 1);
        self.width = 0;
        self.rows.clear();
        self.top = 0;
        self.selection = None;
        self.drag = None;
        self.status.clear();
    }

    fn selected_text(&self) -> &str {
        match self.selection {
            Some((a, b)) if a != b => &self.text()[a.min(b)..a.max(b)],
            _ => self.text(),
        }
    }

    fn scroll(&mut self, delta: isize) {
        self.top = self
            .top
            .saturating_add_signed(delta)
            .min(self.rows.len().saturating_sub(self.body.height as usize));
    }

    fn point(&self, x: u16, y: u16) -> usize {
        let row = self.top
            + y.saturating_sub(self.body.y)
                .min(self.body.height.saturating_sub(1)) as usize;
        let Some(range) = self.rows.get(row) else {
            return self.text().len();
        };
        let column = x.saturating_sub(self.body.x).min(self.body.width) as usize;
        let mut cursor = 0;
        for (offset, grapheme) in self.text()[range.clone()].grapheme_indices(true) {
            let width = grapheme_width(grapheme, cursor);
            if cursor + width > column {
                return range.start + offset;
            }
            cursor += width;
        }
        range.end
    }

    fn update_drag(&mut self, x: u16, y: u16) {
        self.drag = Some((x, y));
        let point = self.point(x, y);
        if let Some((_, head)) = self.selection.as_mut() {
            *head = point;
        }
    }

    fn tick(&mut self) {
        let Some((x, y)) = self.drag else {
            return;
        };
        if self.last_auto_scroll.elapsed() < Duration::from_millis(60) {
            return;
        }
        let delta = if y <= self.body.y {
            -2
        } else if y >= self.body.bottom().saturating_sub(1) {
            2
        } else {
            0
        };
        if delta != 0 {
            self.scroll(delta);
            self.update_drag(x, y);
            self.last_auto_scroll = Instant::now();
        }
    }

    fn hit(&self, x: u16, y: u16) -> Option<Click> {
        if contains(self.copy_button, x, y) {
            Some(Click::Copy)
        } else if contains(self.close_button, x, y) {
            Some(Click::Close)
        } else if contains(self.list, x, y) {
            let index = self.list_top + (y - self.list.y) as usize;
            (index < self.entries.len()).then_some(Click::Entry(index))
        } else {
            None
        }
    }

    fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        frame.render_widget(Clear, area);
        let block = Block::default()
            .borders(Borders::ALL)
            .title("Copy view · fixed snapshot · Markdown / source code");
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if inner.height < 4 || inner.width < 36 {
            frame.render_widget(Paragraph::new("Window too small · Esc back"), inner);
            self.body = Rect::ZERO;
            self.list = Rect::ZERO;
            self.copy_button = Rect::ZERO;
            self.close_button = Rect::ZERO;
            self.drag = None;
            self.press = None;
            return;
        }
        let list_width = if inner.width >= 60 { 24 } else { 0 };
        self.list = Rect::new(inner.x, inner.y, list_width, inner.height - 2);
        let body = Rect::new(
            inner.x + list_width,
            inner.y,
            inner.width - list_width,
            inner.height - 2,
        );
        if body != self.body {
            self.drag = None;
            self.press = None;
        }
        self.body = body;
        self.reflow(self.body.width);
        self.scroll(0);
        self.tick();
        if self.selected < self.list_top {
            self.list_top = self.selected;
        }
        if self.selected >= self.list_top + self.list.height as usize {
            self.list_top = self
                .selected
                .saturating_sub(self.list.height.saturating_sub(1) as usize);
        }
        for (row, entry) in self
            .entries
            .iter()
            .skip(self.list_top)
            .take(self.list.height as usize)
            .enumerate()
        {
            let style = if self.list_top + row == self.selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            frame.render_widget(
                Paragraph::new(entry.title.as_str()).style(style),
                Rect::new(self.list.x, self.list.y + row as u16, self.list.width, 1),
            );
        }
        for (row, range) in self
            .rows
            .iter()
            .skip(self.top)
            .take(self.body.height as usize)
            .enumerate()
        {
            let mut spans = Vec::new();
            let mut column = 0;
            for (offset, grapheme) in self.text()[range.clone()].grapheme_indices(true) {
                let byte = range.start + offset;
                let width = grapheme_width(grapheme, column);
                let selected = self
                    .selection
                    .is_some_and(|(a, b)| byte >= a.min(b) && byte < a.max(b));
                let style = if selected {
                    Style::default().bg(crate::theme::selection_surface_bg())
                } else {
                    Style::default()
                };
                spans.push(Span::styled(
                    if grapheme == "\t" {
                        " ".repeat(width)
                    } else {
                        grapheme.to_string()
                    },
                    style,
                ));
                column += width;
            }
            frame.render_widget(
                Paragraph::new(Line::from(spans)),
                Rect::new(self.body.x, self.body.y + row as u16, self.body.width, 1),
            );
        }
        self.copy_button = Rect::new(inner.x, inner.bottom() - 2, 18.min(inner.width), 1);
        self.close_button = Rect::new(
            inner.right().saturating_sub(10),
            inner.bottom() - 2,
            10.min(inner.width),
            1,
        );
        frame.render_widget(
            Paragraph::new("[Copy text]").style(Style::default().fg(Color::Cyan)),
            self.copy_button,
        );
        frame.render_widget(Paragraph::new("[Esc back]"), self.close_button);
        let hint = if self.status.is_empty() {
            format!(
                "Ctrl+C copy · Ctrl+A select all · ←/→ switch · drag to edge to scroll{}",
                if self.limited {
                    " · showing answers within preview budget"
                } else {
                    ""
                }
            )
        } else {
            self.status.clone()
        };
        frame.render_widget(
            Paragraph::new(hint),
            Rect::new(inner.x, inner.bottom() - 1, inner.width, 1),
        );
    }
}

fn contains(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x && x < area.right() && y >= area.y && y < area.bottom()
}
fn grapheme_width(value: &str, column: usize) -> usize {
    if value == "\t" {
        8 - column % 8
    } else {
        value.width()
    }
}

fn source_rows(text: &str, width: usize) -> Vec<Range<usize>> {
    let mut rows = Vec::new();
    let mut offset = 0;
    for raw in text.split_inclusive('\n') {
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);
        let mut start = offset;
        let mut column = 0;
        for (byte, grapheme) in line.grapheme_indices(true) {
            if rows.len() >= 200_000 {
                return Vec::new();
            }
            let mut size = grapheme_width(grapheme, column);
            if column > 0 && column + size > width.max(1) {
                rows.push(start..offset + byte);
                start = offset + byte;
                column = 0;
                size = grapheme_width(grapheme, column);
            }
            column += size;
        }
        rows.push(start..offset + line.len());
        if rows.len() >= 200_000 {
            return Vec::new();
        }
        offset += raw.len();
    }
    if rows.is_empty() || text.ends_with('\n') {
        rows.push(text.len()..text.len());
    }
    rows
}

impl ReplApp {
    pub(crate) fn open_copy_view(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        let active = self.active_turn_display_messages_for_render();
        let messages = self
            .agent_view
            .as_ref()
            .map_or(&self.messages, |view| &view.transcript);
        if let Some(view) = CopyView::new(messages.iter().chain(active.iter())) {
            self.clear_transcript_selection();
            self.copy_view = Some(view);
            self.open_overlay_state(OverlayKind::Copy);
        } else {
            self.set_transient_status(
                "No copyable answer is available, or the answer exceeds the 8 MiB copy budget",
            );
        }
    }

    fn close_copy_view(&mut self) {
        self.copy_view = None;
        self.close_overlay_state(OverlayKind::Copy);
        self.force_next_viewport_redraw();
    }

    fn copy_view_text(&mut self) {
        let Some(view) = &self.copy_view else {
            return;
        };
        let result = crate::clipboard_copy::copy_to_clipboard(view.selected_text());
        match result {
            Ok(result) => {
                let (lease, kind) = result.into_parts();
                self.clipboard_lease = lease;
                self.copy_view.as_mut().unwrap().status =
                    if kind == crate::clipboard_copy::ClipboardCopyKind::Osc52 {
                        crate::clipboard_copy::OSC52_COPY_NOTICE.to_string()
                    } else {
                        "Copied source text without display wrapping or UI prefixes".to_string()
                    };
            }
            Err(error) => self.copy_view.as_mut().unwrap().status = format!("Copy failed: {error}"),
        }
    }

    pub(super) fn handle_copy_key(&mut self, key: KeyEvent) {
        if matches!(key.code, KeyCode::Esc | KeyCode::F(9)) {
            self.close_copy_view();
            return;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.copy_view_text();
            return;
        }
        let Some(view) = self.copy_view.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                view.drag = None;
                view.selection = Some((0, view.text().len()));
            }
            KeyCode::Home if key.modifiers.contains(KeyModifiers::CONTROL) => view.select_entry(0),
            KeyCode::End if key.modifiers.contains(KeyModifiers::CONTROL) => {
                view.select_entry(view.entries.len() - 1)
            }
            KeyCode::Left => view.select_entry(view.selected.saturating_sub(1)),
            KeyCode::Right => view.select_entry(view.selected.saturating_add(1)),
            KeyCode::Up => view.scroll(-1),
            KeyCode::Down => view.scroll(1),
            KeyCode::PageUp => view.scroll(-(view.body.height as isize)),
            KeyCode::PageDown => view.scroll(view.body.height as isize),
            KeyCode::Home => view.top = 0,
            KeyCode::End => view.top = view.rows.len().saturating_sub(view.body.height as usize),
            _ => {}
        }
        if let Some((x, y)) = view.drag {
            view.update_drag(x, y);
        }
    }

    pub(super) fn handle_copy_mouse(&mut self, mouse: MouseEvent) -> bool {
        let Some(view) = self.copy_view.as_mut() else {
            return false;
        };
        let (x, y) = (mouse.column, mouse.row);
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                view.press = view.hit(x, y);
                if contains(view.body, x, y) {
                    let point = view.point(x, y);
                    view.selection = Some((point, point));
                    view.update_drag(x, y);
                }
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                view.press = None;
                if view.drag.is_some() {
                    view.update_drag(x, y);
                }
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if view.drag.is_some() {
                    view.update_drag(x, y);
                    view.drag = None;
                }
                if let Some(pressed) = view
                    .press
                    .take()
                    .filter(|pressed| Some(*pressed) == view.hit(x, y))
                {
                    match pressed {
                        Click::Copy => self.copy_view_text(),
                        Click::Close => self.close_copy_view(),
                        Click::Entry(index) => view.select_entry(index),
                    }
                }
            }
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let delta = if mouse.kind == MouseEventKind::ScrollUp {
                    -3
                } else {
                    3
                };
                if contains(view.list, x, y) {
                    view.select_entry(view.selected.saturating_add_signed(delta));
                } else {
                    view.scroll(delta);
                }
                if let Some((x, y)) = view.drag {
                    view.update_drag(x, y);
                }
            }
            MouseEventKind::Moved => {
                view.drag = None;
                view.press = None;
            }
            _ => {}
        }
        true
    }

    pub(super) fn draw_copy_view(&mut self, frame: &mut Frame) {
        if let Some(view) = self.copy_view.as_mut() {
            view.draw(frame);
        }
    }

    pub(super) fn copy_needs_tick(&self) -> bool {
        self.copy_view
            .as_ref()
            .is_some_and(|view| view.drag.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn view(text: &str) -> CopyView {
        CopyView::new(
            [DisplayMessage {
                role: MessageRole::Assistant,
                text: text.to_string(),
            }]
            .iter(),
        )
        .unwrap()
    }

    #[test]
    fn copying_soft_wraps_keeps_original_newlines_indent_and_unicode() {
        let source = "    中文e\u{301}🙂 abcdefghijklmnop\r\n\tsecond line\n";
        let mut view = view(source);
        view.reflow(8);
        assert!(view.rows.len() > 3);
        view.selection = Some((4, source.len()));
        assert_eq!(view.selected_text(), &source[4..]);
        view.reflow(20);
        assert_eq!(view.selected_text(), &source[4..]);
    }

    #[test]
    fn code_entry_omits_fences_and_keeps_indentation() {
        let view = view("回答\n\n```rust\nfn main() {\n    println!(\"中文\");\n}\n```\n");
        assert_eq!(view.entries.len(), 2);
        assert_eq!(
            &*view.entries[1].text,
            "fn main() {\n    println!(\"中文\");\n}\n"
        );
    }

    #[test]
    fn edge_drag_extends_selection_across_screen_and_stops_on_release() {
        let source = (0..100)
            .map(|i| format!("line-{i:03}\n"))
            .collect::<String>();
        let mut view = view(&source);
        view.body = Rect::new(2, 2, 40, 5);
        view.reflow(40);
        view.selection = Some((0, 0));
        view.update_drag(40, 7);
        for _ in 0..10 {
            view.last_auto_scroll = Instant::now() - Duration::from_millis(100);
            view.tick();
        }
        assert!(view.selected_text().contains("line-020"));
        view.drag = None;
        let selected = view.selected_text().to_string();
        view.scroll(20);
        view.reflow(12);
        assert_eq!(view.selected_text(), selected);
    }

    #[test]
    fn copy_view_preserves_draft_and_snapshot_through_live_append() {
        let mut app = ReplApp::default();
        app.push_message(MessageRole::Assistant, "old source\n");
        app.input = "未提交的草稿".to_string();
        app.open_copy_view();
        assert_eq!(app.active_overlay, Some(OverlayKind::Copy));
        app.push_message(MessageRole::Assistant, "new live source");
        assert_eq!(
            app.copy_view.as_ref().unwrap().selected_text(),
            "old source\n"
        );
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.copy_view.is_none());
        assert_eq!(app.input, "未提交的草稿");
        app.assert_overlay_state_consistent();
    }

    #[test]
    fn normal_selection_copies_the_original_screen_after_live_redraw() {
        let mut app = ReplApp {
            last_transcript_visible_rows: vec!["original text".to_string()],
            ..ReplApp::default()
        };
        app.transcript_viewport.begin_frame(Rect::new(0, 0, 40, 5));
        assert!(app.begin_transcript_selection(0, 0));
        assert!(app.finish_transcript_selection(8, 0));
        app.last_transcript_visible_rows = vec!["replaced text".to_string()];
        assert!(app.copy_transcript_selection_with(|text| {
            assert_eq!(text, "original");
            Ok(crate::clipboard_copy::ClipboardCopyResult::Native(None))
        }));
    }

    #[test]
    fn code_catalog_budget_cannot_hide_latest_answer() {
        let messages = [
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "```text\nx\n```\n".repeat(MAX_ENTRIES + 1),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "latest answer".to_string(),
            },
        ];
        let view = CopyView::new(messages.iter()).unwrap();
        assert!(view.entries.len() <= MAX_ENTRIES);
        assert_eq!(view.text(), "latest answer");
        assert!(view.limited);
    }

    #[test]
    fn hidden_user_context_and_thinking_never_enter_copy_catalog() {
        let messages = [
            DisplayMessage {
                role: MessageRole::User,
                text: "[system] internal context".to_string(),
            },
            DisplayMessage {
                role: MessageRole::System,
                text: "[Thinking] raw thinking".to_string(),
            },
            DisplayMessage {
                role: MessageRole::Assistant,
                text: "public answer".to_string(),
            },
        ];
        let view = CopyView::new(messages.iter()).unwrap();
        assert_eq!(view.entries.len(), 1);
        assert_eq!(view.text(), "public answer");
    }

    #[test]
    fn redraw_before_first_drag_does_not_turn_copy_into_interrupt() {
        let mut app = ReplApp {
            last_transcript_visible_rows: vec!["old".to_string()],
            ..ReplApp::default()
        };
        app.transcript_viewport.begin_frame(Rect::new(0, 0, 20, 5));
        assert!(app.begin_transcript_selection(0, 0));
        app.last_transcript_visible_rows = vec!["new".to_string()];
        assert!(app.copy_transcript_selection_with(|_| panic!("空选区不能复制其它正文")));
    }
}
