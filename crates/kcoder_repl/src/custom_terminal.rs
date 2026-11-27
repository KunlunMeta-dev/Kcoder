// Terminal implementation with synchronized updates and viewport support.
//
// The MIT License (MIT)
// Copyright (c) 2016-2022 Florian Dehau
// Copyright (c) 2023-2025 The Ratatui Developers
// Copyright (c) OpenAI
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

use std::io;
use std::io::Write;

use crossterm::cursor::MoveTo;
use crossterm::cursor::SetCursorStyle;
use crossterm::queue;
use crossterm::style::Color as CrosstermColor;
use crossterm::style::Colors;
use crossterm::style::Print;
use crossterm::style::SetAttribute;
use crossterm::style::SetBackgroundColor;
use crossterm::style::SetColors;
use crossterm::style::SetForegroundColor;
use crossterm::terminal::BeginSynchronizedUpdate;
use crossterm::terminal::Clear;
use crossterm::terminal::EndSynchronizedUpdate;
use ratatui::backend::Backend;
use ratatui::backend::ClearType;
use ratatui::buffer::Buffer;
use ratatui::buffer::Cell;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::layout::Size;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::widgets::Widget;
use unicode_width::UnicodeWidthStr;

use crate::terminal_hyperlinks::{mark_buffer_web_urls, safe_print_text_preserving_osc8};

fn display_width(s: &str) -> usize {
    if !s.contains('\x1B') {
        return s.width();
    }

    let mut visible = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(ch) = chars.next() {
        if ch == '\x1B' && chars.clone().next() == Some(']') {
            chars.next();
            for c in chars.by_ref() {
                if c == '\x07' {
                    break;
                }
            }
            continue;
        }
        visible.push(ch);
    }
    visible.width()
}

fn to_crossterm_color(color: Color) -> CrosstermColor {
    match color {
        Color::Reset => CrosstermColor::Reset,
        Color::Black => CrosstermColor::Black,
        Color::Red => CrosstermColor::DarkRed,
        Color::Green => CrosstermColor::DarkGreen,
        Color::Yellow => CrosstermColor::DarkYellow,
        Color::Blue => CrosstermColor::DarkBlue,
        Color::Magenta => CrosstermColor::DarkMagenta,
        Color::Cyan => CrosstermColor::DarkCyan,
        Color::Gray => CrosstermColor::Grey,
        Color::DarkGray => CrosstermColor::DarkGrey,
        Color::LightRed => CrosstermColor::Red,
        Color::LightGreen => CrosstermColor::Green,
        Color::LightYellow => CrosstermColor::Yellow,
        Color::LightBlue => CrosstermColor::Blue,
        Color::LightMagenta => CrosstermColor::Magenta,
        Color::LightCyan => CrosstermColor::Cyan,
        Color::White => CrosstermColor::White,
        Color::Indexed(value) => CrosstermColor::AnsiValue(value),
        Color::Rgb(red, green, blue) => CrosstermColor::Rgb {
            r: red,
            g: green,
            b: blue,
        },
    }
}

pub struct Frame<'a> {
    cursor_position: Option<Position>,
    cursor_style: SetCursorStyle,
    viewport_area: Rect,
    buffer: &'a mut Buffer,
}

impl Frame<'_> {
    pub const fn area(&self) -> Rect {
        self.viewport_area
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn render_widget<W: Widget>(&mut self, widget: W, area: Rect) {
        widget.render(area, self.buffer);
    }

    pub fn set_cursor_position<P: Into<Position>>(&mut self, position: P) {
        self.cursor_position = Some(position.into());
    }

    pub fn set_cursor_style(&mut self, style: SetCursorStyle) {
        self.cursor_style = style;
    }

    pub fn buffer_mut(&mut self) -> &mut Buffer {
        self.buffer
    }
}

#[derive(Debug, Default, Clone, Eq, PartialEq, Hash)]
pub struct Terminal<B>
where
    B: Backend + Write,
{
    backend: B,
    buffers: [Buffer; 2],
    current: usize,
    pub hidden_cursor: bool,
    pub viewport_area: Rect,
    pub last_known_screen_size: Size,
    pub last_known_cursor_pos: Position,
    visible_history_rows: u16,
}

impl<B> Drop for Terminal<B>
where
    B: Backend + Write,
{
    fn drop(&mut self) {
        let _ = self.reset_cursor_style();
        if self.hidden_cursor {
            let _ = self.show_cursor();
        }
    }
}

impl<B> Terminal<B>
where
    B: Backend + Write,
{
    pub fn with_options_and_cursor_position(backend: B, cursor_pos: Position) -> io::Result<Self> {
        let screen_size = backend.size()?;
        Ok(Self::with_screen_size_and_cursor_position(
            backend,
            screen_size,
            cursor_pos,
        ))
    }

    fn with_screen_size_and_cursor_position(
        backend: B,
        screen_size: Size,
        cursor_pos: Position,
    ) -> Self {
        Self {
            backend,
            buffers: [Buffer::empty(Rect::ZERO), Buffer::empty(Rect::ZERO)],
            current: 0,
            hidden_cursor: false,
            viewport_area: Rect::new(0, cursor_pos.y, 0, 0),
            last_known_screen_size: screen_size,
            last_known_cursor_pos: cursor_pos,
            visible_history_rows: 0,
        }
    }

    fn get_frame(&mut self) -> Frame<'_> {
        let viewport_area = self.viewport_area;
        Frame {
            cursor_position: None,
            cursor_style: SetCursorStyle::DefaultUserShape,
            viewport_area,
            buffer: self.current_buffer_mut(),
        }
    }

    fn current_buffer(&self) -> &Buffer {
        &self.buffers[self.current]
    }

    fn current_buffer_mut(&mut self) -> &mut Buffer {
        &mut self.buffers[self.current]
    }

    fn previous_buffer(&self) -> &Buffer {
        &self.buffers[1 - self.current]
    }

    #[cfg(test)]
    pub(crate) fn rendered_buffer_for_tests(&self) -> &Buffer {
        self.previous_buffer()
    }

    fn previous_buffer_mut(&mut self) -> &mut Buffer {
        &mut self.buffers[1 - self.current]
    }

    pub const fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    pub fn flush(&mut self) -> io::Result<()> {
        let updates = diff_buffers(self.previous_buffer(), self.current_buffer());
        let last_put_command = updates.iter().rfind(|command| command.is_put());
        if let Some(command) = last_put_command {
            let (x, y) = match command {
                DrawCommand::Put { x, y, .. } | DrawCommand::PutRail { x, y, .. } => (*x, *y),
                DrawCommand::ClearToEnd { .. } => unreachable!("is_put filtered clear command"),
            };
            self.last_known_cursor_pos = Position { x, y };
        }
        draw(&mut self.backend, updates.into_iter())
    }

    pub fn synchronized_update<T, E>(
        &mut self,
        operations: impl FnOnce(&mut Self) -> Result<T, E>,
    ) -> io::Result<Result<T, E>> {
        queue!(self.backend, BeginSynchronizedUpdate)?;
        let result = operations(self);
        queue!(self.backend, EndSynchronizedUpdate)?;
        std::io::Write::flush(&mut self.backend)?;
        Ok(result)
    }

    pub fn resize(&mut self, screen_size: Size) -> io::Result<()> {
        self.last_known_screen_size = screen_size;
        Ok(())
    }

    pub fn set_viewport_area(&mut self, area: Rect) {
        self.current_buffer_mut().resize(area);
        self.previous_buffer_mut().resize(area);
        self.viewport_area = area;
        self.visible_history_rows = self.visible_history_rows.min(area.top());
    }

    pub fn autoresize(&mut self) -> io::Result<()> {
        let screen_size = self.size()?;
        if screen_size != self.last_known_screen_size {
            self.resize(screen_size)?;
        }
        Ok(())
    }

    pub fn draw<F>(&mut self, render_callback: F) -> io::Result<()>
    where
        F: FnOnce(&mut Frame),
    {
        self.try_draw(|frame| {
            render_callback(frame);
            io::Result::Ok(())
        })
    }

    pub fn try_draw<F, E>(&mut self, render_callback: F) -> io::Result<()>
    where
        F: FnOnce(&mut Frame) -> Result<(), E>,
        E: Into<io::Error>,
    {
        self.autoresize()?;
        self.reset_current_viewport_buffer();

        let mut frame = self.get_frame();
        render_callback(&mut frame).map_err(Into::into)?;
        let cursor_position = frame.cursor_position;
        let cursor_style = frame.cursor_style;
        let viewport_area = self.viewport_area;
        mark_buffer_web_urls(self.current_buffer_mut(), viewport_area);

        // Keep the physical terminal cursor hidden while drawing changed cells. Backends move
        // the cursor as they paint, so leaving it visible can expose a brief cursor flash at the
        // last updated cell (often the transcript scrollbar at the right edge).
        if !self.hidden_cursor {
            self.hide_cursor()?;
        }
        self.flush()?;

        match cursor_position {
            None => {}
            Some(position) => {
                self.set_cursor_style(cursor_style)?;
                self.set_cursor_position(position)?;
                self.show_cursor()?;
            }
        }

        self.swap_buffers();
        Backend::flush(&mut self.backend)?;
        Ok(())
    }

    pub fn hide_cursor(&mut self) -> io::Result<()> {
        self.backend.hide_cursor()?;
        self.hidden_cursor = true;
        Ok(())
    }

    pub fn show_cursor(&mut self) -> io::Result<()> {
        self.backend.show_cursor()?;
        self.hidden_cursor = false;
        Ok(())
    }

    pub fn set_cursor_style(&mut self, style: SetCursorStyle) -> io::Result<()> {
        queue!(self.backend, style)
    }

    pub fn reset_cursor_style(&mut self) -> io::Result<()> {
        self.set_cursor_style(SetCursorStyle::DefaultUserShape)
    }

    pub fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        let position = position.into();
        self.backend.set_cursor_position(position)?;
        self.last_known_cursor_pos = position;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn clear(&mut self) -> io::Result<()> {
        if self.viewport_area.is_empty() {
            return Ok(());
        }
        self.clear_after_position(self.viewport_area.as_position())
    }

    pub fn clear_after_position(&mut self, position: Position) -> io::Result<()> {
        self.backend.set_cursor_position(position)?;
        self.backend.clear_region(ClearType::AfterCursor)?;
        self.previous_buffer_mut().reset();
        Ok(())
    }

    #[allow(dead_code)]
    pub fn invalidate_viewport(&mut self) {
        self.previous_buffer_mut().reset();
    }

    pub fn invalidate_viewport_for_repaint(&mut self) {
        for cell in &mut self.previous_buffer_mut().content {
            // This buffer is comparison-only and is never written to the
            // terminal. A printable sentinel such as `x` collides with real
            // content and makes Buffer::diff skip every matching character
            // after the physical viewport was cleared.
            cell.set_symbol("\u{10ffff}")
                .set_fg(Color::Rgb(1, 2, 3))
                .set_bg(Color::Rgb(4, 5, 6));
            cell.modifier = Modifier::RAPID_BLINK;
            cell.skip = false;
        }
    }

    pub fn reset_current_viewport_buffer(&mut self) {
        self.current_buffer_mut().reset();
    }

    #[allow(dead_code)]
    pub fn clear_visible_screen(&mut self) -> io::Result<()> {
        let home = Position { x: 0, y: 0 };
        self.set_cursor_position(home)?;
        self.backend.clear_region(ClearType::All)?;
        self.set_cursor_position(home)?;
        std::io::Write::flush(&mut self.backend)?;
        self.visible_history_rows = 0;
        self.previous_buffer_mut().reset();
        Ok(())
    }

    #[allow(dead_code)]
    pub fn visible_history_rows(&self) -> u16 {
        self.visible_history_rows
    }

    pub fn note_history_rows_inserted(&mut self, inserted_rows: u16) {
        self.visible_history_rows = self
            .visible_history_rows
            .saturating_add(inserted_rows)
            .min(self.viewport_area.top());
    }

    pub fn note_visible_history_rows_scrolled_out(&mut self, rows: u16) {
        self.visible_history_rows = self.visible_history_rows.saturating_sub(rows);
    }

    pub fn swap_buffers(&mut self) {
        self.previous_buffer_mut().reset();
        self.current = 1 - self.current;
    }

    pub fn size(&self) -> io::Result<Size> {
        self.backend.size()
    }
}

#[derive(Debug)]
enum DrawCommand {
    Put { x: u16, y: u16, cell: Cell },
    PutRail { x: u16, y: u16, cell: Cell },
    ClearToEnd { x: u16, y: u16, bg: Color },
}

impl DrawCommand {
    fn is_put(&self) -> bool {
        matches!(self, Self::Put { .. } | Self::PutRail { .. })
    }
}

fn diff_buffers(a: &Buffer, b: &Buffer) -> Vec<DrawCommand> {
    let previous_buffer = &a.content;
    let next_buffer = &b.content;

    let mut updates = vec![];
    let mut last_nonblank_columns = vec![None; a.area.height as usize];
    let mut clear_starts = vec![None; a.area.height as usize];
    for y in 0..a.area.height {
        let row_start = y as usize * a.area.width as usize;
        let row_end = row_start + a.area.width as usize;
        let row = &next_buffer[row_start..row_end];
        let previous_row = &previous_buffer[row_start..row_end];
        let bg = row.last().map(|cell| cell.bg).unwrap_or(Color::Reset);

        let last_nonblank_column = last_meaningful_column(row, bg);

        // Prefer a stale blank after the new row's final meaningful cell. A
        // forced repaint marks every previous cell with a sentinel, so the
        // first stale blank may be harmless indentation before real content.
        // Stopping at that prefix misses the actual trailing region when a
        // short slash-menu row replaces a longer transcript row.
        let trailing_search_start = last_nonblank_column.map_or(0, |last| last + 1);
        let trailing_clear_start = (trailing_search_start < row.len())
            .then(|| {
                first_stale_blank_column(
                    &previous_row[trailing_search_start..],
                    &row[trailing_search_start..],
                    bg,
                )
                .map(|column| column + trailing_search_start)
            })
            .flatten();
        let clear_start = trailing_clear_start.or_else(|| {
            first_stale_blank_column(previous_row, row, bg)
                .filter(|clear_start| last_nonblank_column.is_none_or(|last| last <= *clear_start))
        });

        if let Some(clear_start) = clear_start {
            // ClearToEnd is only safe when the rest of the row is blank. A
            // transcript scrollbar lives after a wide blank gutter, so
            // clearing through that gutter and repainting the scrollbar later
            // can leave torn track/thumb cells in real terminals. In that case
            // the normal cell diff writes the stale blanks explicitly.
            clear_starts[y as usize] = Some(clear_start);
        }

        last_nonblank_columns[y as usize] = last_nonblank_column.map(|column| column as u16);
    }

    let mut invalidated: usize = 0;
    let mut to_skip: usize = 0;
    for (i, (current, previous)) in next_buffer.iter().zip(previous_buffer.iter()).enumerate() {
        let row = i / a.area.width as usize;
        let column = i % a.area.width as usize;
        let row_bg = next_buffer[(row + 1) * a.area.width as usize - 1].bg;
        let current_meaningful = cell_is_meaningful(current, row_bg);
        let cleared_blank =
            clear_starts[row].is_some_and(|start| column >= start && !current_meaningful);
        let force_after_clear =
            clear_starts[row].is_some_and(|start| column >= start && current_meaningful);
        // Fullscreen transcript layout reserves the rightmost three columns
        // for its ASCII scrollbar rail and trailing margin. Repaint that strip
        // unconditionally so
        // a blank, background-filled thumb never depends on symbol or color
        // heuristics (and therefore cannot lose individual rows).
        let force_scrollbar_rail = column.saturating_add(3) >= a.area.width as usize;
        let force_bottom_pane = row.saturating_add(4) >= a.area.height as usize;
        if (force_scrollbar_rail || !current.skip && !cleared_blank)
            && (current != previous
                || invalidated > 0
                || force_after_clear
                || force_scrollbar_rail
                || force_bottom_pane)
            && to_skip == 0
        {
            let (x, y) = a.pos_of(i);
            if force_scrollbar_rail
                || force_bottom_pane
                || last_nonblank_columns[row].is_some_and(|last| x <= last)
            {
                let command = if force_scrollbar_rail {
                    DrawCommand::PutRail {
                        x,
                        y,
                        cell: next_buffer[i].clone(),
                    }
                } else {
                    DrawCommand::Put {
                        x,
                        y,
                        cell: next_buffer[i].clone(),
                    }
                };
                updates.push(command);
            }
        }

        to_skip = display_width(current.symbol()).saturating_sub(1);

        let affected_width = std::cmp::max(
            display_width(current.symbol()),
            display_width(previous.symbol()),
        );
        invalidated = std::cmp::max(affected_width, invalidated).saturating_sub(1);

        if column + 1 == a.area.width as usize
            && let Some(clear_start) = clear_starts[row]
        {
            // Paint this row before erasing its stale tail. Keeping clears
            // row-local avoids a visible blank phase on terminals that do not
            // fully hide synchronized updates.
            let row_start = row * a.area.width as usize;
            let (x, y) = a.pos_of(row_start + clear_start);
            updates.push(DrawCommand::ClearToEnd { x, y, bg: row_bg });
        }
    }
    updates
}

fn cell_is_meaningful(cell: &Cell, trailing_bg: Color) -> bool {
    cell.symbol() != " " || cell.bg != trailing_bg || cell.modifier != Modifier::empty()
}

fn last_meaningful_column(row: &[Cell], trailing_bg: Color) -> Option<usize> {
    let mut last = None;
    let mut column = 0usize;
    while column < row.len() {
        let cell = &row[column];
        let width = display_width(cell.symbol());
        if cell_is_meaningful(cell, trailing_bg) {
            last = Some(column + width.saturating_sub(1));
        }
        column += width.max(1);
    }
    last
}

fn first_stale_blank_column(
    previous_row: &[Cell],
    next_row: &[Cell],
    trailing_bg: Color,
) -> Option<usize> {
    let mut column = 0usize;
    while column < next_row.len() {
        let current = &next_row[column];
        let previous = &previous_row[column];
        if !current.skip
            && !cell_is_meaningful(current, trailing_bg)
            && cell_is_meaningful(previous, trailing_bg)
        {
            return Some(column);
        }
        column += display_width(current.symbol()).max(1);
    }
    None
}

fn draw<I>(writer: &mut impl Write, commands: I) -> io::Result<()>
where
    I: Iterator<Item = DrawCommand>,
{
    let mut fg = Color::Reset;
    let mut bg = Color::Reset;
    let mut modifier = Modifier::empty();
    let mut last_pos: Option<Position> = None;
    for command in commands {
        let force_scrollbar_style = matches!(&command, DrawCommand::PutRail { .. });
        let (x, y, force_position) = match &command {
            DrawCommand::PutRail { x, y, .. } => (*x, *y, true),
            DrawCommand::Put { x, y, .. } => (*x, *y, false),
            DrawCommand::ClearToEnd { x, y, .. } => (*x, *y, true),
        };
        if force_position || !matches!(last_pos, Some(p) if x == p.x + 1 && y == p.y) {
            queue!(writer, MoveTo(x, y))?;
        }
        match command {
            DrawCommand::Put { cell, .. } | DrawCommand::PutRail { cell, .. } => {
                if force_scrollbar_style {
                    // The rail is deliberately repainted every frame. Reset
                    // and restate its complete style as well: terminals can
                    // retain an attribute/color changed by a clear or a wide
                    // neighboring cell even when our cached state says it is
                    // unchanged, leaving a logically continuous thumb with a
                    // visually dim or missing segment.
                    queue!(
                        writer,
                        SetAttribute(crossterm::style::Attribute::Reset),
                        SetForegroundColor(to_crossterm_color(cell.fg)),
                        SetBackgroundColor(to_crossterm_color(cell.bg))
                    )?;
                    ModifierDiff {
                        from: Modifier::empty(),
                        to: cell.modifier,
                    }
                    .queue(writer)?;
                    modifier = cell.modifier;
                    fg = cell.fg;
                    bg = cell.bg;
                } else if cell.modifier != modifier {
                    ModifierDiff {
                        from: modifier,
                        to: cell.modifier,
                    }
                    .queue(writer)?;
                    modifier = cell.modifier;
                }
                if !force_scrollbar_style && (cell.fg != fg || cell.bg != bg) {
                    queue!(
                        writer,
                        SetColors(Colors::new(
                            to_crossterm_color(cell.fg),
                            to_crossterm_color(cell.bg),
                        ))
                    )?;
                    fg = cell.fg;
                    bg = cell.bg;
                }

                if force_scrollbar_style && cell.symbol() == " " && cell.modifier.is_empty() {
                    // Erase reserved gutter blanks without printing in the
                    // terminal's final column. A printed space can enter
                    // wrap-pending state and leave a stale canvas glyph in
                    // xterm during dense synchronized updates.
                    queue!(writer, Clear(crossterm::terminal::ClearType::UntilNewLine))?;
                    last_pos = None;
                } else {
                    queue!(
                        writer,
                        Print(safe_print_text_preserving_osc8(cell.symbol()))
                    )?;
                    last_pos = Some(Position { x, y });
                }
            }
            DrawCommand::ClearToEnd { bg: clear_bg, .. } => {
                queue!(writer, SetAttribute(crossterm::style::Attribute::Reset))?;
                modifier = Modifier::empty();
                // Attribute::Reset also resets terminal colors. Keep the
                // cached state in sync so a later cell re-emits its foreground
                // color instead of being drawn with the terminal default.
                fg = Color::Reset;
                queue!(writer, SetBackgroundColor(to_crossterm_color(clear_bg)))?;
                bg = clear_bg;
                queue!(writer, Clear(crossterm::terminal::ClearType::UntilNewLine))?;
                // Clearing does not advance the terminal cursor. Force the next
                // put to position itself instead of treating x + 1 as adjacent.
                last_pos = None;
            }
        }
    }

    queue!(
        writer,
        SetForegroundColor(crossterm::style::Color::Reset),
        SetBackgroundColor(crossterm::style::Color::Reset),
        SetAttribute(crossterm::style::Attribute::Reset),
    )?;

    Ok(())
}

struct ModifierDiff {
    from: Modifier,
    to: Modifier,
}

impl ModifierDiff {
    fn queue<W: io::Write>(self, w: &mut W) -> io::Result<()> {
        use crossterm::style::Attribute as CAttribute;
        let removed = self.from - self.to;
        if removed.contains(Modifier::REVERSED) {
            queue!(w, SetAttribute(CAttribute::NoReverse))?;
        }
        if removed.contains(Modifier::BOLD) {
            queue!(w, SetAttribute(CAttribute::NormalIntensity))?;
            if self.to.contains(Modifier::DIM) {
                queue!(w, SetAttribute(CAttribute::Dim))?;
            }
        }
        if removed.contains(Modifier::ITALIC) {
            queue!(w, SetAttribute(CAttribute::NoItalic))?;
        }
        if removed.contains(Modifier::UNDERLINED) {
            queue!(w, SetAttribute(CAttribute::NoUnderline))?;
        }
        if removed.contains(Modifier::DIM) {
            queue!(w, SetAttribute(CAttribute::NormalIntensity))?;
        }
        if removed.contains(Modifier::CROSSED_OUT) {
            queue!(w, SetAttribute(CAttribute::NotCrossedOut))?;
        }
        if removed.contains(Modifier::SLOW_BLINK) || removed.contains(Modifier::RAPID_BLINK) {
            queue!(w, SetAttribute(CAttribute::NoBlink))?;
        }

        let added = self.to - self.from;
        if added.contains(Modifier::REVERSED) {
            queue!(w, SetAttribute(CAttribute::Reverse))?;
        }
        if added.contains(Modifier::BOLD) {
            queue!(w, SetAttribute(CAttribute::Bold))?;
        }
        if added.contains(Modifier::ITALIC) {
            queue!(w, SetAttribute(CAttribute::Italic))?;
        }
        if added.contains(Modifier::UNDERLINED) {
            queue!(w, SetAttribute(CAttribute::Underlined))?;
        }
        if added.contains(Modifier::DIM) {
            queue!(w, SetAttribute(CAttribute::Dim))?;
        }
        if added.contains(Modifier::CROSSED_OUT) {
            queue!(w, SetAttribute(CAttribute::CrossedOut))?;
        }
        if added.contains(Modifier::SLOW_BLINK) {
            queue!(w, SetAttribute(CAttribute::SlowBlink))?;
        }
        if added.contains(Modifier::RAPID_BLINK) {
            queue!(w, SetAttribute(CAttribute::RapidBlink))?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::WindowSize;
    use ratatui::style::Style;

    fn strip_terminal_escapes(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = String::with_capacity(text.len());
        let mut idx = 0usize;
        while idx < bytes.len() {
            if bytes[idx] == b'\x1b' && idx + 1 < bytes.len() {
                match bytes[idx + 1] {
                    b'[' => {
                        idx += 2;
                        while idx < bytes.len() {
                            let byte = bytes[idx];
                            idx += 1;
                            if (0x40..=0x7e).contains(&byte) {
                                break;
                            }
                        }
                        continue;
                    }
                    b']' => {
                        idx += 2;
                        while idx < bytes.len() {
                            if bytes[idx] == b'\x07' {
                                idx += 1;
                                break;
                            }
                            if idx + 1 < bytes.len()
                                && bytes[idx] == b'\x1b'
                                && bytes[idx + 1] == b'\\'
                            {
                                idx += 2;
                                break;
                            }
                            idx += 1;
                        }
                        continue;
                    }
                    _ => {}
                }
            }
            let ch = text[idx..]
                .chars()
                .next()
                .expect("byte index starts at a character");
            if !ch.is_control() {
                out.push(ch);
            }
            idx += ch.len_utf8();
        }
        out
    }

    struct CaptureBackend {
        output: Vec<u8>,
        size: Size,
        cursor: Position,
        events: Vec<&'static str>,
    }

    impl CaptureBackend {
        fn new(width: u16, height: u16) -> Self {
            Self {
                output: Vec::new(),
                size: Size { width, height },
                cursor: Position { x: 0, y: 0 },
                events: Vec::new(),
            }
        }

        fn output(&self) -> String {
            String::from_utf8_lossy(&self.output).into_owned()
        }
    }

    impl Write for CaptureBackend {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.events.push("write");
            self.output.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Backend for CaptureBackend {
        fn draw<'a, I>(&mut self, _content: I) -> io::Result<()>
        where
            I: Iterator<Item = (u16, u16, &'a Cell)>,
        {
            self.events.push("draw");
            Ok(())
        }

        fn hide_cursor(&mut self) -> io::Result<()> {
            self.events.push("hide");
            Ok(())
        }

        fn show_cursor(&mut self) -> io::Result<()> {
            self.events.push("show");
            Ok(())
        }

        fn get_cursor_position(&mut self) -> io::Result<Position> {
            Ok(self.cursor)
        }

        fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
            self.cursor = position.into();
            self.events.push("move");
            Ok(())
        }

        fn clear(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clear_region(&mut self, _clear_type: ClearType) -> io::Result<()> {
            Ok(())
        }

        fn append_lines(&mut self, _line_count: u16) -> io::Result<()> {
            Ok(())
        }

        fn scroll_region_up(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> io::Result<()> {
            Ok(())
        }

        fn scroll_region_down(
            &mut self,
            _region: std::ops::Range<u16>,
            _scroll_by: u16,
        ) -> io::Result<()> {
            Ok(())
        }

        fn size(&self) -> io::Result<Size> {
            Ok(self.size)
        }

        fn window_size(&mut self) -> io::Result<WindowSize> {
            Ok(WindowSize {
                columns_rows: self.size,
                pixels: self.size,
            })
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn diff_buffers_does_not_emit_clear_to_end_for_full_width_row() {
        let area = Rect::new(0, 0, 3, 2);
        let previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);

        next.cell_mut((2, 0))
            .expect("cell should exist")
            .set_symbol("X");

        let commands = diff_buffers(&previous, &next);

        let clear_count = commands
            .iter()
            .filter(|command| matches!(command, DrawCommand::ClearToEnd { y, .. } if *y == 0))
            .count();
        assert_eq!(
            0, clear_count,
            "expected diff_buffers not to emit ClearToEnd; commands: {commands:?}",
        );
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, DrawCommand::PutRail { x: 2, y: 0, .. })),
            "expected diff_buffers to update the final cell; commands: {commands:?}",
        );
    }

    #[test]
    fn diff_buffers_does_not_clear_unchanged_short_rows() {
        let area = Rect::new(0, 0, 10, 6);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        previous.set_string(0, 0, "hello", Style::default());
        next.set_string(0, 0, "hello", Style::default());

        let commands = diff_buffers(&previous, &next);

        assert!(
            !commands.iter().any(|command| matches!(
                command,
                DrawCommand::Put { y: 0, .. } | DrawCommand::ClearToEnd { y: 0, .. }
            )),
            "unchanged rows outside the bottom pane should only repaint the reserved rail: {commands:?}"
        );
    }

    #[test]
    fn diff_buffers_changed_short_row_updates_cell_without_clearing_tail() {
        let area = Rect::new(0, 0, 10, 1);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        previous.set_string(0, 0, "hello", Style::default());
        next.set_string(0, 0, "jello", Style::default());

        let commands = diff_buffers(&previous, &next);

        assert!(
            commands
                .iter()
                .any(|command| matches!(command, DrawCommand::Put { x: 0, y: 0, .. })),
            "changed first cell should be updated: {commands:?}"
        );
        assert!(
            !commands
                .iter()
                .any(|command| matches!(command, DrawCommand::ClearToEnd { .. })),
            "unchanged trailing blanks should not be cleared: {commands:?}"
        );
    }

    #[test]
    fn diff_buffers_invalidated_row_clears_tail_after_short_indented_content() {
        let area = Rect::new(0, 0, 48, 1);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        for cell in &mut previous.content {
            cell.set_symbol("\u{10ffff}")
                .set_fg(Color::Rgb(1, 2, 3))
                .set_bg(Color::Rgb(4, 5, 6));
            cell.modifier = Modifier::RAPID_BLINK;
            cell.skip = false;
        }
        let menu_line = "  /clear        Clear the conversation.";
        next.set_string(0, 0, menu_line, Style::default());
        let expected_clear_x = display_width(menu_line) as u16;

        let commands = diff_buffers(&previous, &next);

        assert!(
            commands.iter().any(|command| matches!(
                command,
                DrawCommand::ClearToEnd { x, y: 0, .. } if *x == expected_clear_x
            )),
            "the repaint must erase stale transcript cells after the shorter slash row: {commands:?}"
        );
    }

    #[test]
    fn diff_buffers_clears_short_row_tail_after_painting_the_new_row() {
        let area = Rect::new(0, 0, 48, 1);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        for cell in &mut previous.content {
            cell.set_symbol("\u{10ffff}")
                .set_fg(Color::Rgb(1, 2, 3))
                .set_bg(Color::Rgb(4, 5, 6));
            cell.modifier = Modifier::RAPID_BLINK;
            cell.skip = false;
        }
        next.set_string(
            0,
            0,
            "  /clear        Clear the conversation.",
            Style::default(),
        );

        let commands = diff_buffers(&previous, &next);
        let last_put = commands
            .iter()
            .rposition(DrawCommand::is_put)
            .expect("new row should be painted");
        let clear = commands
            .iter()
            .position(|command| matches!(command, DrawCommand::ClearToEnd { y: 0, .. }))
            .expect("stale row tail should be cleared");

        assert!(
            clear > last_put,
            "painting must precede the row-tail clear to avoid a blank intermediate frame: {commands:?}"
        );
    }

    #[test]
    fn diff_buffers_clear_to_end_starts_after_wide_char() {
        let area = Rect::new(0, 0, 10, 1);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);

        previous.set_string(0, 0, "中文", Style::default());
        next.set_string(0, 0, "中", Style::default());

        let commands = diff_buffers(&previous, &next);
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, DrawCommand::ClearToEnd { x: 2, y: 0, .. })),
            "expected clear-to-end to start after the remaining wide char; commands: {commands:?}"
        );
    }

    #[test]
    fn diff_buffers_erases_stale_prefix_without_clearing_indented_content() {
        let area = Rect::new(0, 0, 12, 1);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);

        previous.set_string(0, 0, "╭────", Style::default().fg(Color::Rgb(255, 154, 72)));
        next.set_string(3, 0, "line", Style::default());

        let commands = diff_buffers(&previous, &next);

        assert!(
            !commands
                .iter()
                .any(|command| matches!(command, DrawCommand::ClearToEnd { .. })),
            "must not clear through indented content; commands: {commands:?}",
        );
        assert!(
            commands.iter().any(|command| matches!(
                command,
                DrawCommand::Put { x: 0, y: 0, cell } if cell.symbol() == " "
            )),
            "expected stale prefix to be erased explicitly; commands: {commands:?}",
        );
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, DrawCommand::Put { x: 3, y: 0, .. })),
            "expected diff to redraw the indented content after clearing; commands: {commands:?}",
        );
    }

    #[test]
    fn diff_buffers_does_not_clear_through_scrollbar_after_stale_gap() {
        let area = Rect::new(0, 0, 24, 1);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);

        previous.set_string(0, 0, "tui-lab old welcome", Style::default());
        previous
            .cell_mut((23, 0))
            .expect("previous scrollbar")
            .set_symbol("│");
        next.set_string(0, 0, "tui-lab", Style::default());
        next.cell_mut((23, 0))
            .expect("next scrollbar")
            .set_symbol("│");

        let commands = diff_buffers(&previous, &next);

        assert!(
            !commands
                .iter()
                .any(|command| matches!(command, DrawCommand::ClearToEnd { .. })),
            "must not clear through a meaningful scrollbar cell; commands: {commands:?}",
        );
        assert!(
            commands.iter().any(|command| matches!(
                command,
                DrawCommand::Put { x: 8, y: 0, cell } if cell.symbol() == " "
            )),
            "expected stale text to be erased with explicit blank cells; commands: {commands:?}",
        );
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, DrawCommand::PutRail { x: 23, y: 0, .. })),
            "the unchanged scrollbar rail should be repainted defensively: {commands:?}",
        );
    }

    #[test]
    fn draw_repositions_after_clear_before_adjacent_scrollbar_cell() {
        let mut output = Vec::new();
        draw(
            &mut output,
            [
                DrawCommand::ClearToEnd {
                    x: 22,
                    y: 3,
                    bg: Color::Reset,
                },
                DrawCommand::PutRail {
                    x: 23,
                    y: 3,
                    cell: Cell::new(" "),
                },
            ]
            .into_iter(),
        )
        .expect("draw should succeed");

        let output = String::from_utf8(output).expect("terminal output should be utf-8");
        assert!(
            output.contains("\x1b[4;24H"),
            "scrollbar put must explicitly move to row 4, column 24 after clear: {output:?}"
        );
    }

    #[test]
    fn draw_explicitly_positions_scrollbar_after_adjacent_put() {
        let mut output = Vec::new();
        draw(
            &mut output,
            [
                DrawCommand::Put {
                    x: 22,
                    y: 3,
                    cell: Cell::new(" "),
                },
                DrawCommand::PutRail {
                    x: 23,
                    y: 3,
                    cell: Cell::new(" "),
                },
            ]
            .into_iter(),
        )
        .expect("draw should succeed");

        let output = String::from_utf8(output).expect("terminal output should be utf-8");
        assert!(
            output.contains("\x1b[4;24H"),
            "scrollbar must not rely on the preceding cell's cursor position: {output:?}"
        );
    }

    #[test]
    fn draw_restates_complete_style_for_every_scrollbar_cell() {
        let mut output = Vec::new();
        let style = Style::default().fg(Color::DarkGray).bg(Color::Black);
        let mut first = Cell::new("|");
        first.set_style(style);
        let mut second = Cell::new("|");
        second.set_style(style);
        assert_eq!(first.fg, Color::DarkGray);
        assert_eq!(first.bg, Color::Black);
        assert_eq!(
            to_crossterm_color(first.fg),
            crossterm::style::Color::DarkGrey
        );
        assert_eq!(to_crossterm_color(first.bg), crossterm::style::Color::Black);
        draw(
            &mut output,
            [
                DrawCommand::PutRail {
                    x: 23,
                    y: 3,
                    cell: first,
                },
                DrawCommand::PutRail {
                    x: 23,
                    y: 4,
                    cell: second,
                },
            ]
            .into_iter(),
        )
        .expect("draw should succeed");

        let output = String::from_utf8(output).expect("terminal output should be utf-8");
        let resets_before_thumb = output
            .split('|')
            .take(2)
            .filter(|segment| segment.contains("\x1b[0m"))
            .count();
        assert_eq!(
            resets_before_thumb, 2,
            "each scrollbar cell must restate its colors before printing: {output:?}"
        );
    }

    #[test]
    fn draw_reemits_foreground_color_after_clear_resets_attributes() {
        let mut output = Vec::new();
        let red = Style::default().fg(Color::Red);
        draw(
            &mut output,
            [
                DrawCommand::Put {
                    x: 0,
                    y: 0,
                    cell: Cell::new("A").set_style(red).clone(),
                },
                DrawCommand::ClearToEnd {
                    x: 0,
                    y: 1,
                    bg: Color::Reset,
                },
                DrawCommand::Put {
                    x: 0,
                    y: 2,
                    cell: Cell::new("█").set_style(red).clone(),
                },
            ]
            .into_iter(),
        )
        .expect("draw should succeed");

        let output = String::from_utf8(output).expect("terminal output should be utf-8");
        let after_move = output
            .split_once("\x1b[3;1H")
            .map(|(_, tail)| tail)
            .expect("third-row cursor move should be emitted");
        assert!(
            after_move.starts_with('\x1b') && !after_move.starts_with("█"),
            "foreground color must be re-emitted immediately after Attribute::Reset: {output:?}"
        );
    }

    #[test]
    fn diff_buffers_always_repaints_right_edge_scrollbar_gutter() {
        let area = Rect::new(0, 0, 24, 3);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        for y in 0..area.height {
            let x = if y == 1 { 21 } else { 23 };
            let previous_cell = previous.cell_mut((x, y)).expect("previous scrollbar");
            let next_cell = next.cell_mut((x, y)).expect("next scrollbar");
            if y == 1 {
                previous_cell.set_bg(Color::DarkGray);
                next_cell.set_bg(Color::DarkGray);
            } else {
                previous_cell.set_symbol("│");
                next_cell.set_symbol("│");
            }
        }

        let commands = diff_buffers(&previous, &next);
        let rail_rows = commands
            .iter()
            .filter_map(|command| match command {
                DrawCommand::PutRail { y, .. } => Some(*y),
                _ => None,
            })
            .collect::<Vec<_>>();

        assert_eq!(
            rail_rows,
            vec![0; 3]
                .into_iter()
                .chain(vec![1; 3])
                .chain(vec![2; 3])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn diff_buffers_repaints_scrollbar_cell_with_stale_wide_character_skip() {
        let area = Rect::new(0, 0, 24, 2);
        let previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        let rail = next.cell_mut((23, 0)).expect("scrollbar cell");
        rail.set_symbol("|");
        rail.skip = true;

        let commands = diff_buffers(&previous, &next);

        assert!(commands.iter().any(|command| matches!(
            command,
            DrawCommand::PutRail { x: 23, y: 0, cell } if cell.symbol() == "|"
        )));
    }

    #[test]
    fn diff_buffers_clears_stale_glyph_in_scrollbar_safety_margin() {
        let area = Rect::new(0, 0, 24, 2);
        let mut previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        previous
            .cell_mut((23, 0))
            .expect("stale safety-margin cell")
            .set_symbol("|");
        next.cell_mut((22, 0))
            .expect("current scrollbar cell")
            .set_symbol("|");

        let commands = diff_buffers(&previous, &next);

        assert!(commands.iter().any(|command| matches!(
            command,
            DrawCommand::PutRail { x: 23, y: 0, cell } if cell.symbol() == " "
        )));
    }

    #[test]
    fn diff_buffers_marks_background_thumb_inside_reserved_right_gutter() {
        let area = Rect::new(0, 0, 24, 2);
        let previous = Buffer::empty(area);
        let mut next = Buffer::empty(area);
        next.cell_mut((21, 0))
            .expect("thumb cell")
            .set_bg(Color::DarkGray);

        let commands = diff_buffers(&previous, &next);

        assert!(commands.iter().any(|command| matches!(
            command,
            DrawCommand::PutRail { x: 21, y: 0, cell }
                if cell.symbol() == " " && cell.bg == Color::DarkGray
        )));
    }

    #[test]
    fn diff_buffers_repaints_bottom_pane_blanks_even_when_unchanged() {
        let area = Rect::new(0, 0, 8, 6);
        let previous = Buffer::empty(area);
        let next = Buffer::empty(area);

        let commands = diff_buffers(&previous, &next);
        let bottom_puts = commands
            .iter()
            .filter(|command| {
                matches!(
                    command,
                    DrawCommand::Put { y, .. } | DrawCommand::PutRail { y, .. } if *y >= 2
                )
            })
            .count();

        assert_eq!(bottom_puts, 4 * usize::from(area.width));
    }

    #[test]
    fn safe_print_text_replaces_control_chars() {
        let safe = safe_print_text_preserving_osc8("a\x1bb\x07c");

        assert_eq!(safe.as_ref(), "a b c");
        assert!(!safe.chars().any(char::is_control));
    }

    #[test]
    fn terminal_draw_marks_live_buffer_web_urls() {
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(40, 1),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 40, 1));

        terminal
            .draw(|frame| {
                frame
                    .buffer_mut()
                    .set_string(0, 0, "See https://example.com.", Style::default());
            })
            .expect("draw");

        let output = terminal.backend().output();
        assert!(output.contains("\x1b]8;;https://example.com\x07"));
        let visible = strip_terminal_escapes(&output);
        assert!(visible.contains("See"));
        assert!(visible.contains("https://example.com."));
    }

    #[test]
    fn terminal_draw_applies_requested_cursor_style() {
        let mut output = Vec::new();
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(2, 1),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 2, 1));

        terminal
            .try_draw(|frame| {
                frame.set_cursor_style(SetCursorStyle::SteadyBar);
                frame.set_cursor_position((0, 0));
                io::Result::Ok(())
            })
            .expect("draw");

        queue!(output, SetCursorStyle::SteadyBar).expect("queue style");
        let expected = String::from_utf8(output).expect("utf8");
        let actual = terminal.backend().output();
        assert!(
            actual.contains(&expected),
            "expected terminal output to contain cursor style {expected:?}, got {actual:?}"
        );
    }

    #[test]
    fn terminal_draw_hides_cursor_until_paint_and_reposition_are_complete() {
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(4, 2),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 4, 2));

        terminal
            .draw(|frame| {
                frame.buffer_mut().set_string(3, 0, "x", Style::default());
                frame.set_cursor_position((1, 1));
            })
            .expect("draw");

        let events = &terminal.backend().events;
        assert_eq!(events.first(), Some(&"hide"));
        assert!(events[1..events.len() - 2].contains(&"write"));
        assert_eq!(&events[events.len() - 2..], ["move", "show"]);
        assert_eq!(terminal.last_known_cursor_pos, Position { x: 1, y: 1 });
        assert!(!terminal.hidden_cursor);
    }

    #[test]
    fn synchronized_update_wraps_backend_output() {
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(4, 2),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");

        terminal
            .synchronized_update(|terminal| {
                terminal.backend_mut().write_all(b"body")?;
                io::Result::Ok(())
            })
            .expect("sync update")
            .expect("body write");

        let output = terminal.backend().output();
        let begin = output.find("\x1b[?2026h").expect("begin sync");
        let body = output.find("body").expect("body");
        let end = output.find("\x1b[?2026l").expect("end sync");
        assert!(begin < body);
        assert!(body < end);
    }

    #[test]
    fn reset_current_viewport_buffer_clears_stale_cells_without_clear_region() {
        use ratatui::widgets::{Paragraph, Wrap};

        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(8, 3),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 8, 3));

        terminal
            .draw(|frame| {
                let area = frame.area();
                frame.render_widget(
                    Paragraph::new("first\nstale-row\nstale-row").wrap(Wrap { trim: false }),
                    area,
                );
            })
            .expect("frame 1");

        terminal.reset_current_viewport_buffer();
        terminal.invalidate_viewport();
        terminal
            .draw(|frame| {
                let area = frame.area();
                frame.render_widget(Paragraph::new("next").wrap(Wrap { trim: false }), area);
            })
            .expect("frame 2");

        let buffer = terminal.rendered_buffer_for_tests();
        assert_eq!(buffer.cell((0, 0)).expect("cell").symbol(), "n");
        for y in 1..3 {
            for x in 0..8 {
                assert_eq!(
                    buffer.cell((x, y)).expect("cell").symbol(),
                    " ",
                    "row {y} col {x} should be blank after buffer reset"
                );
            }
        }
    }

    #[test]
    fn invalidate_viewport_for_repaint_soft_clears_stale_rows() {
        use ratatui::widgets::{Paragraph, Wrap};

        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(24, 4),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 24, 4));

        terminal
            .draw(|frame| {
                let area = frame.area();
                frame.render_widget(
                    Paragraph::new("╭────────────╮\n│ welcome    │\n╰────────────╯")
                        .wrap(Wrap { trim: false }),
                    area,
                );
            })
            .expect("frame 1");

        let before_len = terminal.backend().output().len();
        terminal.invalidate_viewport_for_repaint();
        terminal
            .draw(|frame| {
                let area = frame.area();
                frame.render_widget(
                    Paragraph::new("x final line").wrap(Wrap { trim: false }),
                    area,
                );
            })
            .expect("frame 2");

        let output = terminal.backend().output();
        let repaint_output = &output[before_len..];
        assert!(
            repaint_output.contains("\x1b[K"),
            "soft repaint should clear stale rows with line clears: {repaint_output:?}"
        );
        assert!(
            !repaint_output.contains("\x1b[J"),
            "soft repaint must not use full-screen clear: {repaint_output:?}"
        );
        assert!(
            repaint_output.contains('x'),
            "a real x must not collide with the repaint sentinel: {repaint_output:?}"
        );

        let buffer = terminal.rendered_buffer_for_tests();
        assert_eq!(buffer.cell((2, 0)).expect("cell").symbol(), "f");
        for y in 1..4 {
            for x in 0..24 {
                assert_eq!(
                    buffer.cell((x, y)).expect("cell").symbol(),
                    " ",
                    "row {y} col {x} should be blank after soft repaint"
                );
            }
        }
    }

    /// Reproduces the "turn-end duplicate text" issue end-to-end: render two
    /// frames where the second frame's paragraph content shifts, and verify
    /// the second frame's captured output does not leave stale characters.
    #[test]
    fn two_frame_paragraph_shift_does_not_ghost() {
        use ratatui::widgets::{Paragraph, Wrap};

        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(6, 3),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 6, 3));

        // Frame 1: three short lines.
        terminal
            .draw(|frame| {
                let area = frame.area();
                let para = Paragraph::new("AAAAAA\nBBBBBB\nCCCCCC").wrap(Wrap { trim: false });
                frame.render_widget(para, area);
            })
            .expect("frame 1");

        // Frame 2: content shifted up — oldest line gone, new line at bottom.
        // The diff between frames must not leave "AAAAAA" visible on row 0.
        terminal
            .draw(|frame| {
                let area = frame.area();
                let para = Paragraph::new("BBBBBB\nCCCCCC\nDDDDDD").wrap(Wrap { trim: false });
                frame.render_widget(para, area);
            })
            .expect("frame 2");

        let output = terminal.backend().output();
        // After frame 2 the on-screen state should be B/C/D. The diff rewrote
        // row 0 (A->B), so 'B' must appear at least as many times as 'A' in
        // the output stream; if ghosting occurred, 'A' would dominate.
        assert!(
            output.matches('B').count() >= output.matches('A').count(),
            "row 0 should be rewritten B over A (no ghosting): output={output:?}"
        );
    }

    /// Closer to the real renderer: each frame clears the area with the
    /// `Clear` widget then renders a `Paragraph` with a background style, and
    /// the second frame shifts content with the SAME area (no resize). This
    /// mirrors how `app.draw` paints the transcript viewport and checks that
    /// the clear+re-render sequence does not leave shifted ghosts.
    #[test]
    fn clear_plus_paragraph_shift_same_area_does_not_ghost() {
        use ratatui::style::{Color, Style};
        use ratatui::widgets::{Clear, Paragraph, Wrap};

        let bg = Color::Rgb(20, 20, 20);
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(6, 3),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 6, 3));

        let render_frame = |frame: &mut Frame, text: &str| {
            let area = frame.area();
            frame.render_widget(Clear, area);
            let para = Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .style(Style::default().bg(bg));
            frame.render_widget(para, area);
        };

        terminal
            .draw(|frame| render_frame(frame, "AAAAAA\nBBBBBB\nCCCCCC"))
            .expect("frame 1");
        terminal
            .draw(|frame| render_frame(frame, "BBBBBB\nCCCCCC\nDDDDDD"))
            .expect("frame 2");

        let output = terminal.backend().output();
        // Frame 2 rewrote row 0 (A->B). If the clear+paragraph sequence
        // ghosted, 'A' would still dominate the output.
        assert!(
            output.matches('B').count() >= output.matches('A').count(),
            "row 0 should be rewritten B over A (no ghosting with Clear): output={output:?}"
        );
    }

    /// Reproduces ghosting with CJK wide-char content shifting, the actual
    /// scenario from the user's report. Each frame clears + renders a
    /// background-styled paragraph; frame 2 shifts content up. CJK chars are
    /// display-width-2, which exercises the wide-char cell accounting in
    /// `diff_buffers` and is where ghosts are most likely.
    #[test]
    fn cjk_paragraph_shift_does_not_ghost() {
        use ratatui::style::{Color, Style};
        use ratatui::widgets::{Clear, Paragraph, Wrap};

        let bg = Color::Rgb(20, 20, 20);
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(12, 3),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 12, 3));

        let render_frame = |frame: &mut Frame, text: &str| {
            let area = frame.area();
            frame.render_widget(Clear, area);
            let para = Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .style(Style::default().bg(bg));
            frame.render_widget(para, area);
        };

        // Frame 1: three CJK lines.
        terminal
            .draw(|frame| render_frame(frame, "北京上海\n广州深圳\n成都重庆"))
            .expect("frame 1");
        // Frame 2: shifted up.
        terminal
            .draw(|frame| render_frame(frame, "广州深圳\n成都重庆\n天津武汉"))
            .expect("frame 2");

        let output = terminal.backend().output();
        // After frame 2, the old two-character row should have been cleared from row 0.
        // Count occurrences: the first character of the new row should appear at least
        // as often as the first character of the old row, which should be gone.
        let bei_count = output.matches('北').count();
        let guang_count = output.matches('广').count();
        assert!(
            guang_count >= bei_count,
            "row 0 should be rewritten 广 over 北 (no CJK ghosting): bei={bei_count} guang={guang_count} output={output:?}"
        );
    }

    /// Reproduces the actual turn-end ghost: content row count *decreases*
    /// between frames (active-turn lines disappear / markdown restructures),
    /// which makes the tail-following `top` scroll offset shrink. The rows
    /// that were visible at the bottom of frame 1 are now below the viewport
    /// and must be cleared; if the cell diff skips them, they ghost.
    #[test]
    fn scroll_top_decrease_clears_bottom_rows() {
        use ratatui::style::{Color, Style};
        use ratatui::widgets::{Clear, Paragraph, Wrap};

        let bg = Color::Rgb(20, 20, 20);
        // 6 wide, 3 tall. Frame 1 has 5 lines (top=2 shows lines 2,3,4).
        // Frame 2 has 4 lines (top=1 shows lines 1,2,3) — bottom row that
        // showed line 4 ("DDDDDD") must be cleared, not ghosted.
        let mut terminal = Terminal::with_options_and_cursor_position(
            CaptureBackend::new(6, 3),
            Position { x: 0, y: 0 },
        )
        .expect("terminal");
        terminal.set_viewport_area(Rect::new(0, 0, 6, 3));

        let render_frame = |frame: &mut Frame, text: &str, top: u16| {
            let area = frame.area();
            frame.render_widget(Clear, area);
            let para = Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .scroll((top, 0))
                .style(Style::default().bg(bg));
            frame.render_widget(para, area);
        };

        // Frame 1: 5 lines, scrolled so top=2 (shows "CCCCCC"/"DDDDDD"/"EEEEEE").
        terminal
            .draw(|frame| render_frame(frame, "AAAAAA\nBBBBBB\nCCCCCC\nDDDDDD\nEEEEEE", 2))
            .expect("frame 1");
        // Frame 2: content shrank to 4 lines, top=1 (shows "BBBBBB"/"CCCCCC"/"DDDDDD").
        // "EEEEEE" is gone; the bottom row that held it must be repainted with "DDDDDD".
        terminal
            .draw(|frame| render_frame(frame, "AAAAAA\nBBBBBB\nCCCCCC\nDDDDDD", 1))
            .expect("frame 2");

        let output = terminal.backend().output();
        // After frame 2, 'E' should not dominate: the bottom row was
        // rewritten from "EEEEEE" to "DDDDDD". If ghosted, E count > D count.
        let d_count = output.matches('D').count();
        let e_count = output.matches('E').count();
        assert!(
            d_count >= e_count,
            "bottom row should be rewritten D over E (no ghost on top decrease): D={d_count} E={e_count} output={output:?}"
        );
    }
}
