//! Authoritative state machine for the committed transcript viewport.
//!
//! Rendering may estimate and later refine wrapped row counts, but it never
//! owns scroll state. Wheel, keyboard and scrollbar input all enter here and
//! resolve against the same frame layout. A drag freezes its row-count
//! snapshot so streaming output cannot move the thumb under the pointer; the
//! position is remapped once, when the drag ends.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use ratatui::layout::Rect;

use crate::scrolling::{MouseScrollState, ScrollDirection, TranscriptScroll, WHEEL_LINES_PER_TICK};

pub(crate) const MIN_THUMB_CELLS: usize = 3;
const FAST_PATH_DURATION: Duration = Duration::from_millis(250);
/// Coalesce at most two wheel events per draw frame so render throttling cannot amplify an event burst into a large jump.
const MAX_PENDING_WHEEL_LINES: i32 = WHEEL_LINES_PER_TICK * 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScrollbarCellFill {
    Empty,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScrollbarHitTest {
    Thumb,
    Track,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ScrollbarCommand {
    SetOffset(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ScrollbarMetrics {
    content_len: usize,
    viewport_len: usize,
    track_len: usize,
    pub(crate) thumb_len: usize,
    pub(crate) thumb_start: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg(test)]
pub(crate) struct ScrollbarGeometry {
    pub(crate) area: Rect,
    pub(crate) thumb_start: u16,
    pub(crate) thumb_len: u16,
}

impl ScrollbarMetrics {
    pub(crate) fn new(
        content_len: usize,
        viewport_len: usize,
        offset: usize,
        track_cells: u16,
    ) -> Self {
        let track_len = usize::from(track_cells);
        if track_len == 0 {
            return Self {
                content_len,
                viewport_len,
                track_len,
                thumb_len: 0,
                thumb_start: 0,
            };
        }

        let content_len = content_len.max(1);
        let viewport_len = viewport_len.min(content_len).max(1);
        let max_offset = content_len.saturating_sub(viewport_len);
        let offset = offset.min(max_offset);
        let thumb_len = track_len
            .saturating_mul(viewport_len)
            .saturating_div(content_len)
            .max(MIN_THUMB_CELLS)
            .min(track_len);
        let thumb_travel = track_len.saturating_sub(thumb_len);
        // Round symmetrically rather than downward. Floor makes the thumb systematically
        // lag content by almost one track cell at most positions, especially during drag
        // round trips. Since offset <= max_offset, the result remains within thumb_travel
        // and endpoints stay exactly aligned.
        let thumb_start = thumb_travel
            .saturating_mul(offset)
            .saturating_add(max_offset / 2)
            .checked_div(max_offset)
            .unwrap_or(0);

        Self {
            content_len,
            viewport_len,
            track_len,
            thumb_len,
            thumb_start,
        }
    }

    pub(crate) fn max_offset(&self) -> usize {
        self.content_len.saturating_sub(self.viewport_len)
    }

    pub(crate) fn thumb_travel(&self) -> usize {
        self.track_len.saturating_sub(self.thumb_len)
    }

    pub(crate) fn hit_test(&self, position: usize) -> ScrollbarHitTest {
        if position >= self.thumb_start
            && position < self.thumb_start.saturating_add(self.thumb_len)
        {
            ScrollbarHitTest::Thumb
        } else {
            ScrollbarHitTest::Track
        }
    }

    pub(crate) fn offset_for_thumb_start(&self, thumb_start: usize) -> usize {
        let thumb_start = thumb_start.min(self.thumb_travel());
        // Use symmetric rounding with the forward thumb_start mapping so a
        // track-cell -> offset -> track-cell drag round trip returns to the original
        // cell and keeps the thumb under the pointer's grab point.
        self.max_offset()
            .saturating_mul(thumb_start)
            .saturating_add(self.thumb_travel() / 2)
            .checked_div(self.thumb_travel())
            .unwrap_or(0)
    }

    pub(crate) fn cell_fill(&self, cell_index: usize) -> ScrollbarCellFill {
        if self.thumb_len > 0
            && cell_index >= self.thumb_start
            && cell_index < self.thumb_start.saturating_add(self.thumb_len)
        {
            ScrollbarCellFill::Full
        } else {
            ScrollbarCellFill::Empty
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct ViewportLayout {
    generation: u64,
    content_rows: usize,
    viewport_rows: usize,
    visible_top: usize,
    transcript_area: Option<Rect>,
    scrollbar_area: Option<Rect>,
}

#[derive(Debug, Clone, Copy, Default)]
struct ScrollbarDrag {
    active: bool,
    grab_subcells: usize,
    frozen_content_rows: Option<usize>,
    latest_content_rows: Option<usize>,
    painted_live_top: Option<usize>,
    visible_at_top: bool,
    visible_at_bottom: bool,
}

#[derive(Debug)]
pub(crate) struct TranscriptViewport {
    position: TranscriptScroll,
    pending_delta: i32,
    mouse_scroll: MouseScrollState,
    layout: ViewportLayout,
    drag: ScrollbarDrag,
    fast_path_until: Option<Instant>,
    tui_lab_trace_sequence: u64,
    tui_lab_input_sequence: u64,
    tui_lab_applied_through_input_sequence: u64,
    tui_lab_applied_delta: i32,
    tui_lab_requested_delta: i32,
    tui_lab_accepted_delta: i32,
    tui_lab_cancelled_pending_delta: i32,
}

impl Default for TranscriptViewport {
    fn default() -> Self {
        Self {
            position: TranscriptScroll::default(),
            pending_delta: 0,
            mouse_scroll: MouseScrollState::new(),
            layout: ViewportLayout::default(),
            drag: ScrollbarDrag::default(),
            fast_path_until: None,
            tui_lab_trace_sequence: 0,
            tui_lab_input_sequence: 0,
            tui_lab_applied_through_input_sequence: 0,
            tui_lab_applied_delta: 0,
            tui_lab_requested_delta: 0,
            tui_lab_accepted_delta: 0,
            tui_lab_cancelled_pending_delta: 0,
        }
    }
}

impl TranscriptViewport {
    pub(crate) fn begin_navigation(&mut self, top: usize) {
        self.drag = ScrollbarDrag::default();
        self.mouse_scroll = MouseScrollState::new();
        self.pending_delta = 0;
        self.fast_path_until = None;
        self.position = TranscriptScroll::pinned(top);
    }

    pub(crate) fn position(&self) -> TranscriptScroll {
        self.position
    }

    pub(crate) fn set_position(&mut self, position: TranscriptScroll) {
        self.position = position;
        self.pending_delta = 0;
    }

    pub(crate) fn snap_to_bottom(&mut self) {
        self.set_position(TranscriptScroll::to_bottom());
    }

    pub(crate) fn is_at_tail(&self) -> bool {
        // Pause automatic tail following as soon as an upward scroll is queued; do not wait for a draw frame to protect user intent.
        self.position.is_at_tail() && self.pending_delta >= 0
    }

    pub(crate) fn is_tail_relative(&self) -> bool {
        self.position.is_tail_relative()
    }

    /// Pin the review position before new body content arrives; row-estimate corrections do not use this entry point.
    pub(crate) fn preserve_review_before_content_change(&mut self) {
        if !self.drag.active && !self.is_at_tail() && self.layout.content_rows > 0 {
            let top = self.resolve_top(self.layout.content_rows, self.layout.viewport_rows);
            self.position = TranscriptScroll::pinned(top);
        }
    }

    pub(crate) fn resolve_top(&self, content_rows: usize, viewport_rows: usize) -> usize {
        self.position.resolve_top(content_rows, viewport_rows).1
    }

    pub(crate) fn begin_frame(&mut self, transcript_area: Rect) {
        let layout_changed = self
            .layout
            .transcript_area
            .is_some_and(|previous| previous != transcript_area);
        if layout_changed {
            // Pointer coordinates from the previous terminal geometry are no
            // longer meaningful. Finish that gesture before installing the
            // new frame snapshot, then force a fresh row measurement.
            self.invalidate_layout();
        }
        self.layout.transcript_area = Some(transcript_area);
        self.layout.viewport_rows = usize::from(transcript_area.height);
        self.layout.scrollbar_area = None;
    }

    pub(crate) fn transcript_area(&self) -> Option<Rect> {
        self.layout.transcript_area
    }

    pub(crate) fn viewport_rows(&self) -> usize {
        self.layout.viewport_rows
    }

    pub(crate) fn live_content_rows(&self) -> usize {
        self.layout.content_rows
    }

    pub(crate) fn content_rows(&self) -> usize {
        if self.drag.active {
            self.drag
                .frozen_content_rows
                .unwrap_or(self.layout.content_rows)
        } else {
            self.layout.content_rows
        }
    }

    pub(crate) fn invalidate_content_layout(&mut self) {
        // Pending wheel input belongs to the current row map. Preserve the
        // user's intent before discarding that coordinate system.
        self.apply_pending_scroll();
        if self.drag.active {
            // Keep the gesture's frozen coordinate system. The next render is
            // recorded as `latest_content_rows` and remapped on release.
            self.drag.latest_content_rows = None;
        } else {
            self.layout.content_rows = 0;
        }
        self.layout.generation = self.layout.generation.saturating_add(1);
    }

    pub(crate) fn invalidate_layout(&mut self) {
        self.apply_pending_scroll();
        if self.drag.active {
            let latest_rows = self
                .drag
                .latest_content_rows
                .unwrap_or(self.layout.content_rows);
            let live_top = self.drag.painted_live_top.unwrap_or_else(|| {
                let frozen_rows = self.content_rows();
                let frozen_top = self
                    .position
                    .resolve_top(frozen_rows, self.layout.viewport_rows)
                    .1;
                remap_top(
                    frozen_top,
                    frozen_rows,
                    latest_rows,
                    self.layout.viewport_rows,
                )
            });
            self.position = canonical_position(live_top, latest_rows, self.layout.viewport_rows);
        }
        // Pointer coordinates are invalid now, but the last actually painted
        // top is already expressed in the live content coordinate system.
        self.drag = ScrollbarDrag::default();
        self.fast_path_until = None;
        self.layout.content_rows = 0;
        self.layout.scrollbar_area = None;
        self.layout.generation = self.layout.generation.saturating_add(1);
    }

    pub(crate) fn replace_content(&mut self) {
        self.end_drag();
        self.position = TranscriptScroll::to_bottom();
        self.pending_delta = 0;
        self.mouse_scroll = MouseScrollState::new();
        self.layout.content_rows = 0;
        self.layout.scrollbar_area = None;
        self.layout.generation = self.layout.generation.saturating_add(1);
        self.fast_path_until = None;
    }

    #[cfg(test)]
    pub(crate) fn set_live_content_rows(&mut self, rows: usize) {
        self.prime_content_rows(rows);
    }

    /// When input handling replaces the transcript source, first install the estimated
    /// total from the same row index so the triggering wheel or key event maps directly
    /// into the new coordinate system.
    pub(crate) fn prime_content_rows(&mut self, rows: usize) {
        self.layout.content_rows = rows;
    }

    fn observe_rendered_content_rows(&mut self, rows: usize) {
        if self.drag.active {
            self.drag.latest_content_rows = Some(rows);
            if self.drag.frozen_content_rows.is_none() {
                self.drag.frozen_content_rows = Some(self.layout.content_rows);
            }
        } else {
            // Fast rendering is a presentation policy, not a second layout
            // snapshot. Outside a drag, geometry always follows the rows that
            // were actually committed for this frame.
            self.layout.content_rows = rows;
        }
    }

    pub(crate) fn commit_render(&mut self, content_rows: usize, visible_top: usize) {
        self.observe_rendered_content_rows(content_rows);
        self.layout.visible_top = visible_top;
        if self.drag.active {
            self.drag.painted_live_top = Some(visible_top);
        }
        if !self.drag.active {
            self.position = self
                .position
                .resolve_top(content_rows, self.layout.viewport_rows)
                .0;
        }
        let direction = match self.tui_lab_applied_delta.cmp(&0) {
            std::cmp::Ordering::Less => Some("up"),
            std::cmp::Ordering::Greater => Some("down"),
            std::cmp::Ordering::Equal => None,
        };
        self.trace_tui_lab_viewport("commit", direction, self.tui_lab_applied_delta);
        self.tui_lab_applied_delta = 0;
    }

    pub(crate) fn queue_wheel(&mut self, direction: ScrollDirection) {
        let update = self.mouse_scroll.on_scroll(direction);
        let previous_pending = self.pending_delta;
        self.pending_delta = if self.pending_delta != 0
            && self.pending_delta.signum() != update.delta_lines.signum()
        {
            update.delta_lines
        } else {
            self.pending_delta
                .saturating_add(update.delta_lines)
                .clamp(-MAX_PENDING_WHEEL_LINES, MAX_PENDING_WHEEL_LINES)
        };
        let reversed =
            previous_pending != 0 && previous_pending.signum() != update.delta_lines.signum();
        self.tui_lab_requested_delta = update.delta_lines;
        self.tui_lab_cancelled_pending_delta = if reversed { previous_pending } else { 0 };
        // Replacing an opposite burst cancels old work; that cancellation is not
        // additional movement accepted for the new direction.
        self.tui_lab_accepted_delta = if reversed {
            self.pending_delta
        } else {
            self.pending_delta - previous_pending
        };
        self.activate_fast_path();
        self.tui_lab_input_sequence = self.tui_lab_input_sequence.saturating_add(1);
        let direction = match direction {
            ScrollDirection::Up => "up",
            ScrollDirection::Down => "down",
        };
        self.trace_tui_lab_viewport("input", Some(direction), self.tui_lab_accepted_delta);
    }

    fn tui_lab_viewport_diagnostic(
        &self,
        phase: &str,
        direction: Option<&str>,
        applied_delta: i32,
        timestamp_micros: u64,
    ) -> serde_json::Value {
        let content_rows = self.layout.content_rows;
        let viewport_rows = self.layout.viewport_rows;
        let resolved_top = self.position.resolve_top(content_rows, viewport_rows).1;
        let max_top = content_rows.saturating_sub(viewport_rows);
        let boundary = if content_rows <= viewport_rows {
            "fit"
        } else if self.layout.visible_top == 0 {
            "top"
        } else if self.layout.visible_top >= max_top {
            "bottom"
        } else {
            "none"
        };
        serde_json::json!({
            "id": format!("{phase}-{}", self.tui_lab_trace_sequence),
            "sequence": self.tui_lab_trace_sequence,
            "input_sequence": self.tui_lab_input_sequence,
            "applied_through_input_sequence": self.tui_lab_applied_through_input_sequence,
            "timestamp_micros": timestamp_micros,
            "phase": phase,
            "direction": direction,
            "applied_delta": applied_delta,
            "requested_delta": (phase == "input").then_some(self.tui_lab_requested_delta),
            "accepted_delta": (phase == "input").then_some(self.tui_lab_accepted_delta),
            "coalesced_delta": (phase == "input").then_some(
                self.tui_lab_requested_delta - self.tui_lab_accepted_delta
            ),
            "cancelled_pending_delta": (phase == "input").then_some(self.tui_lab_cancelled_pending_delta),
            "minimum_progress_rows": WHEEL_LINES_PER_TICK.unsigned_abs(),
            "pending_delta": self.pending_delta,
            "top": self.layout.visible_top,
            "resolved_top": resolved_top,
            "visible_top": self.layout.visible_top,
            "content_rows": content_rows,
            "viewport_rows": viewport_rows,
            "anchor": format!("{:?}", self.position),
            "boundary": boundary,
            "generation": self.layout.generation,
        })
    }

    fn trace_tui_lab_viewport(&mut self, phase: &str, direction: Option<&str>, applied_delta: i32) {
        self.tui_lab_trace_sequence = self.tui_lab_trace_sequence.saturating_add(1);
        let Some(run_dir) = std::env::var_os("KCODER_TUI_LAB_RUN_DIR") else {
            return;
        };
        if run_dir.is_empty() {
            return;
        }
        static TRACE_ORIGIN: OnceLock<Instant> = OnceLock::new();
        let elapsed = TRACE_ORIGIN.get_or_init(Instant::now).elapsed().as_micros();
        let timestamp_micros = u64::try_from(elapsed).unwrap_or(u64::MAX);
        let path = Path::new(&run_dir).join("viewport-trace.jsonl");
        let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        // Emit this diagnostic only when the tui-lab environment is present; it changes neither production scroll state nor public APIs.
        let diagnostic =
            self.tui_lab_viewport_diagnostic(phase, direction, applied_delta, timestamp_micros);
        if serde_json::to_writer(&mut file, &diagnostic).is_ok() {
            let _ = file.write_all(b"\n");
        }
    }

    pub(crate) fn apply_pending_scroll(&mut self) {
        if self.pending_delta == 0 {
            return;
        }
        let applied_delta = self.pending_delta;
        self.position = self.position.scrolled_by(
            applied_delta,
            self.layout.content_rows,
            self.layout.viewport_rows,
        );
        self.tui_lab_applied_delta = self.tui_lab_applied_delta.saturating_add(applied_delta);
        self.tui_lab_applied_through_input_sequence = self.tui_lab_input_sequence;
        self.pending_delta = 0;
    }

    pub(crate) fn scroll_lines(&mut self, delta_lines: i32) {
        self.position =
            self.position
                .scrolled_by(delta_lines, self.content_rows(), self.layout.viewport_rows);
        self.pending_delta = 0;
        self.activate_fast_path();
    }

    #[cfg(test)]
    pub(crate) fn pending_delta(&self) -> i32 {
        self.pending_delta
    }

    pub(crate) fn trace_state(&self) -> String {
        format!(
            "generation={} drag={} scroll={:?} frozen={:?} latest={:?} visible_top={} visible_bottom={} area={:?}",
            self.layout.generation,
            self.drag.active,
            self.position,
            self.drag.frozen_content_rows,
            self.drag.latest_content_rows,
            self.drag.visible_at_top,
            self.drag.visible_at_bottom,
            self.layout.scrollbar_area,
        )
    }

    pub(crate) fn fast_path_active(&self) -> bool {
        self.drag.active
            || self
                .fast_path_until
                .is_some_and(|deadline| Instant::now() <= deadline)
    }

    pub(crate) fn drag_active(&self) -> bool {
        self.drag.active
    }

    pub(crate) fn scrollbar_area(&self) -> Option<Rect> {
        self.layout.scrollbar_area
    }

    pub(crate) fn set_scrollbar_area(&mut self, area: Option<Rect>) {
        self.layout.scrollbar_area = area;
        if area.is_none() {
            self.end_drag();
        }
    }

    pub(crate) fn drag_column_contains(&self, column: u16) -> bool {
        self.layout
            .scrollbar_area
            .is_some_and(|area| column >= area.x && column < area.right())
    }

    pub(crate) fn begin_drag(&mut self, row: u16) -> Option<ScrollbarCommand> {
        let area = self.layout.scrollbar_area?;
        let content_rows = self.layout.content_rows;
        let viewport_rows = self.layout.viewport_rows.max(1);
        if content_rows <= viewport_rows {
            return None;
        }
        // Grab the thumb last seen by the user, not a wheel/output position that has not been drawn yet.
        let top = self
            .layout
            .visible_top
            .min(content_rows.saturating_sub(viewport_rows));
        let metrics = ScrollbarMetrics::new(content_rows, viewport_rows, top, area.height);
        let position = scrollbar_row_subcell_position(area, row);
        match metrics.hit_test(position) {
            ScrollbarHitTest::Thumb => {
                self.position = canonical_position(top, content_rows, viewport_rows);
                self.pending_delta = 0;
                self.drag = ScrollbarDrag {
                    active: true,
                    grab_subcells: position.saturating_sub(metrics.thumb_start),
                    frozen_content_rows: Some(content_rows),
                    latest_content_rows: None,
                    painted_live_top: Some(self.layout.visible_top),
                    visible_at_top: metrics.thumb_start == 0,
                    visible_at_bottom: metrics.thumb_start >= metrics.thumb_travel(),
                };
                None
            }
            ScrollbarHitTest::Track => {
                self.end_drag();
                let thumb_start = position.saturating_sub(metrics.thumb_len / 2);
                Some(ScrollbarCommand::SetOffset(
                    metrics.offset_for_thumb_start(thumb_start),
                ))
            }
        }
    }

    pub(crate) fn drag_to_row(&mut self, row: u16) {
        let Some(area) = self.layout.scrollbar_area else {
            return;
        };
        let viewport_rows = self.layout.viewport_rows.max(1);
        let content_rows = self.content_rows();
        if content_rows <= viewport_rows {
            self.snap_to_bottom();
            return;
        }
        let top = scrollbar_row_to_top(
            area,
            row,
            content_rows,
            viewport_rows,
            self.drag.grab_subcells,
        );
        self.set_offset(top);
    }

    pub(crate) fn apply_command(&mut self, command: ScrollbarCommand) {
        match command {
            ScrollbarCommand::SetOffset(top) => self.set_offset(top),
        }
    }

    pub(crate) fn set_offset(&mut self, top: usize) {
        let viewport_rows = self.layout.viewport_rows.max(1);
        let content_rows = self.content_rows();
        self.position = canonical_position(top, content_rows, viewport_rows);
        self.activate_fast_path();
        self.pending_delta = 0;
    }

    fn activate_fast_path(&mut self) {
        let deadline = Instant::now() + FAST_PATH_DURATION;
        self.fast_path_until = Some(
            self.fast_path_until
                .map_or(deadline, |current| current.max(deadline)),
        );
    }

    /// Record the thumb-edge state actually drawn in the current frame.
    /// `content_rows` and `top` must come from the basis used by this frame's render,
    /// not the frozen drag coordinate system, so edge detection matches the visible thumb.
    pub(crate) fn update_painted_drag_edges(
        &mut self,
        content_rows: usize,
        top: usize,
        track_height: u16,
    ) {
        if !self.drag.active {
            return;
        }
        let metrics = ScrollbarMetrics::new(
            content_rows,
            self.layout.viewport_rows.max(1),
            top,
            track_height,
        );
        self.drag.visible_at_top = metrics.thumb_start == 0;
        self.drag.visible_at_bottom = metrics.thumb_start >= metrics.thumb_travel();
    }

    pub(crate) fn end_drag(&mut self) {
        if self.drag.active {
            let viewport_rows = self.layout.viewport_rows.max(1);
            let frozen_rows = self
                .drag
                .frozen_content_rows
                .unwrap_or(self.layout.content_rows);
            let latest_rows = self
                .drag
                .latest_content_rows
                .unwrap_or(self.layout.content_rows);
            let latest_max = latest_rows.saturating_sub(viewport_rows);
            let frozen_top = self.position.resolve_top(frozen_rows, viewport_rows).1;
            let frozen_metrics = ScrollbarMetrics::new(
                frozen_rows,
                viewport_rows,
                frozen_top,
                self.layout.scrollbar_area.map_or(0, |area| area.height),
            );
            let latest_top = if self.drag.visible_at_top || frozen_metrics.thumb_start == 0 {
                0
            } else if self.drag.visible_at_bottom
                || frozen_metrics.thumb_start >= frozen_metrics.thumb_travel()
            {
                latest_max
            } else {
                self.drag
                    .painted_live_top
                    .unwrap_or_else(|| {
                        remap_top(frozen_top, frozen_rows, latest_rows, viewport_rows)
                    })
                    .min(latest_max)
            };
            self.position = if latest_top >= latest_max {
                TranscriptScroll::to_bottom()
            } else {
                TranscriptScroll::at_line(latest_top)
            };
            self.layout.content_rows = latest_rows;
        }
        self.drag = ScrollbarDrag::default();
        self.fast_path_until = None;
    }

    pub(crate) fn force_release_at_top(&mut self) {
        self.end_drag();
        self.set_position(TranscriptScroll::at_line(0));
    }

    pub(crate) fn force_release_at_bottom(&mut self) {
        self.end_drag();
        self.snap_to_bottom();
    }

    pub(crate) fn release_drag(&mut self, column: u16, row: u16) -> bool {
        if !self.drag.active {
            return false;
        }
        let release_edge = self.layout.scrollbar_area.map(|area| {
            let edge_rows = MIN_THUMB_CELLS.min(usize::from(area.height)) as u16;
            (
                row < area.y.saturating_add(edge_rows),
                row >= area.bottom().saturating_sub(edge_rows),
            )
        });
        if self.drag_column_contains(column) {
            self.drag_to_row(row);
        }
        match release_edge {
            Some((true, _)) => self.force_release_at_top(),
            Some((_, true)) => self.force_release_at_bottom(),
            _ => self.end_drag(),
        }
        true
    }

    #[cfg(test)]
    pub(crate) fn with_layout(
        position: TranscriptScroll,
        content_rows: usize,
        viewport_rows: usize,
        scrollbar_area: Option<Rect>,
    ) -> Self {
        let visible_top = position.resolve_top(content_rows, viewport_rows).1;
        Self {
            position,
            layout: ViewportLayout {
                generation: 0,
                content_rows,
                viewport_rows,
                visible_top,
                transcript_area: None,
                scrollbar_area,
            },
            ..Self::default()
        }
    }
}

pub(crate) fn scrollbar_area(
    area: Rect,
    content_rows: usize,
    viewport_rows: usize,
) -> Option<Rect> {
    if content_rows <= viewport_rows || area.width == 0 || area.height < 2 {
        return None;
    }
    Some(Rect::new(
        area.right().saturating_sub(2).max(area.x),
        area.y,
        1,
        area.height,
    ))
}

pub(crate) fn scrollbar_vertical_symbol(fill: ScrollbarCellFill) -> &'static str {
    // Windows' legacy console host uses the active CJK font/code-page rules
    // for Block Elements. It can therefore render U+2591/U+2588 as two cells
    // even though unicode-width and ratatui classify them as one. The trailing
    // console cell then corrupts the rail and subsequent differential paints.
    #[cfg(windows)]
    {
        return match fill {
            ScrollbarCellFill::Empty => ":",
            ScrollbarCellFill::Full => "|",
        };
    }

    // Use a matched box-drawing pair so the rail remains centered while the
    // heavier thumb stays visually distinct without Block Element drift.
    #[cfg(not(windows))]
    match fill {
        ScrollbarCellFill::Empty => "│",
        ScrollbarCellFill::Full => "┃",
    }
}

#[cfg(test)]
pub(crate) fn scrollbar_geometry(
    area: Rect,
    content_rows: usize,
    viewport_rows: usize,
    top: usize,
) -> Option<ScrollbarGeometry> {
    let area = scrollbar_area(area, content_rows, viewport_rows)?;
    let metrics = ScrollbarMetrics::new(content_rows, viewport_rows, top, area.height);
    Some(ScrollbarGeometry {
        area,
        thumb_start: metrics
            .thumb_start
            .min(usize::from(area.height.saturating_sub(1))) as u16,
        thumb_len: metrics.thumb_len.max(1).min(usize::from(area.height)) as u16,
    })
}

pub(crate) fn scrollbar_row_subcell_position(scrollbar_area: Rect, row: u16) -> usize {
    if scrollbar_area.height == 0 || row < scrollbar_area.y {
        return 0;
    }
    if row >= scrollbar_area.bottom() {
        return usize::from(scrollbar_area.height);
    }
    usize::from(
        row.saturating_sub(scrollbar_area.y)
            .min(scrollbar_area.height.saturating_sub(1)),
    )
}

pub(crate) fn scrollbar_row_to_top(
    area: Rect,
    row: u16,
    content_rows: usize,
    viewport_rows: usize,
    grab_subcells: usize,
) -> usize {
    let metrics = ScrollbarMetrics::new(content_rows, viewport_rows, 0, area.height);
    if metrics.max_offset() == 0 || area.height == 0 {
        return 0;
    }
    let position = scrollbar_row_subcell_position(area, row);
    metrics.offset_for_thumb_start(position.saturating_sub(grab_subcells))
}

fn canonical_position(top: usize, content_rows: usize, viewport_rows: usize) -> TranscriptScroll {
    let max_start = content_rows.saturating_sub(viewport_rows);
    if max_start == 0 || top >= max_start {
        TranscriptScroll::to_bottom()
    } else {
        TranscriptScroll::at_line(top)
    }
}

fn remap_top(
    top: usize,
    from_content_rows: usize,
    to_content_rows: usize,
    viewport_rows: usize,
) -> usize {
    let from_max = from_content_rows.saturating_sub(viewport_rows);
    let to_max = to_content_rows.saturating_sub(viewport_rows);
    if from_max == 0 {
        return 0;
    }
    // Use the same symmetric rounding as rendering-side remap_scroll_top_proportionally
    // so drag drawing and release/invalidation remapping cannot differ by one cell.
    top.min(from_max)
        .saturating_mul(to_max)
        .saturating_add(from_max / 2)
        / from_max
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollbar_track_and_thumb_use_platform_safe_single_width_symbols() {
        let track = scrollbar_vertical_symbol(ScrollbarCellFill::Empty);
        let thumb = scrollbar_vertical_symbol(ScrollbarCellFill::Full);

        #[cfg(windows)]
        {
            assert_eq!(track, ":");
            assert_eq!(thumb, "|");
            assert!(
                track.is_ascii() && thumb.is_ascii(),
                "Windows CJK console hosts can render ambiguous-width block elements as two cells"
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(track, "│");
            assert_eq!(thumb, "┃");
        }
        assert_eq!(unicode_width::UnicodeWidthStr::width(track), 1);
        assert_eq!(unicode_width::UnicodeWidthStr::width(thumb), 1);
    }

    #[test]
    fn scrollbar_grab_uses_last_painted_position() {
        let area = Rect::new(79, 0, 1, 20);
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 200, 20, Some(area));
        viewport.set_position(TranscriptScroll::pinned(80));
        assert!(viewport.begin_drag(18).is_none());
        assert!(viewport.drag_active());
        assert_eq!(viewport.resolve_top(200, 20), 180);
    }

    #[test]
    fn wheel_drag_and_layout_share_one_snapshot() {
        let area = Rect::new(99, 0, 1, 20);
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 110, 10, Some(area));

        viewport.scroll_lines(-3);
        assert_eq!(viewport.resolve_top(110, 10), 97);

        viewport.begin_drag(18);
        viewport.drag_to_row(0);
        viewport.update_painted_drag_edges(110, 0, area.height);
        viewport.force_release_at_top();
        assert_eq!(viewport.position(), TranscriptScroll::at_line(0));
    }

    #[test]
    fn content_growth_during_drag_is_remapped_on_release() {
        let area = Rect::new(99, 0, 1, 20);
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(50), 110, 10, Some(area));
        viewport.begin_drag(10);
        viewport.commit_render(220, 100);
        viewport.end_drag();

        assert_eq!(viewport.live_content_rows(), 220);
        assert!(!viewport.is_at_tail());
    }

    #[test]
    fn wheel_and_keyboard_use_the_same_layout_snapshot() {
        let mut wheel =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 200, 20, None);
        let mut keyboard =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 200, 20, None);

        wheel.queue_wheel(ScrollDirection::Up);
        assert!(wheel.fast_path_active());
        wheel.apply_pending_scroll();
        keyboard.scroll_lines(-3);

        assert_eq!(wheel.position(), keyboard.position());
        assert_eq!(wheel.resolve_top(200, 20), 177);
    }

    #[test]
    fn wheel_diagnostics_separate_requested_accepted_and_coalesced_input() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 500, 20, None);
        for index in 0..40 {
            viewport.queue_wheel(ScrollDirection::Up);
            let diagnostic = viewport.tui_lab_viewport_diagnostic("input", Some("up"), 0, 42);
            assert_eq!(diagnostic["requested_delta"], -3);
            assert_eq!(diagnostic["accepted_delta"], if index < 2 { -3 } else { 0 });
            assert_eq!(
                diagnostic["coalesced_delta"],
                if index < 2 { 0 } else { -3 }
            );
        }
        assert_eq!(viewport.pending_delta(), -6);
        viewport.queue_wheel(ScrollDirection::Down);
        let diagnostic = viewport.tui_lab_viewport_diagnostic("input", Some("down"), 3, 42);
        assert_eq!(diagnostic["accepted_delta"], 3);
        assert_eq!(diagnostic["cancelled_pending_delta"], -6);
        assert_eq!(viewport.pending_delta(), 3);
    }

    #[test]
    fn queued_wheel_burst_is_bounded_before_the_next_frame() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 500, 20, None);

        for _ in 0..40 {
            viewport.queue_wheel(ScrollDirection::Up);
        }

        assert_eq!(viewport.pending_delta(), -6);
        viewport.apply_pending_scroll();
        assert_eq!(viewport.resolve_top(500, 20), 474);
    }

    #[test]
    fn reversed_wheel_input_discards_the_opposite_pending_burst() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(200), 500, 20, None);
        for _ in 0..20 {
            viewport.queue_wheel(ScrollDirection::Up);
        }

        viewport.queue_wheel(ScrollDirection::Down);

        assert_eq!(viewport.pending_delta(), 3);
        viewport.apply_pending_scroll();
        assert_eq!(viewport.resolve_top(500, 20), 203);
    }

    #[test]
    fn resize_preserves_tail_relative_intent() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::from_tail(24), 300, 30, None);

        viewport.begin_frame(Rect::new(0, 0, 80, 12));
        viewport.commit_render(340, 304);

        assert_eq!(viewport.position(), TranscriptScroll::from_tail(24));
        assert_eq!(viewport.resolve_top(340, 12), 304);
    }

    #[test]
    fn disappearing_scrollbar_cancels_drag_and_clears_frozen_rows() {
        let area = Rect::new(99, 0, 1, 20);
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(40), 110, 10, Some(area));
        viewport.begin_drag(7);
        assert!(viewport.drag_active());

        viewport.set_scrollbar_area(None);

        assert!(!viewport.drag_active());
        assert_eq!(viewport.content_rows(), viewport.live_content_rows());
    }

    #[test]
    fn all_scroll_commands_stay_inside_layout_bounds() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 137, 19, None);

        for delta in [-10_000, -41, -3, 3, 47, 10_000] {
            viewport.scroll_lines(delta);
            let top = viewport.resolve_top(137, 19);
            assert!(top <= 118, "delta {delta} produced top {top}");
        }
    }

    #[test]
    fn content_that_fits_normalizes_to_tail() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(12), 50, 20, None);
        viewport.commit_render(10, 0);

        assert!(viewport.is_at_tail());
        assert_eq!(viewport.resolve_top(10, 20), 0);
    }

    #[test]
    fn release_is_resolved_by_the_drag_snapshot() {
        let area = Rect::new(99, 4, 1, 20);
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(50), 200, 20, Some(area));
        viewport.begin_drag(10);
        viewport.commit_render(260, 50);

        assert!(viewport.release_drag(99, area.y));
        assert_eq!(viewport.position(), TranscriptScroll::at_line(0));
        assert_eq!(viewport.live_content_rows(), 260);
        assert!(!viewport.drag_active());
    }

    #[test]
    fn fast_path_does_not_freeze_non_drag_row_measurements() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(50), 200, 20, None);
        viewport.set_offset(40);
        assert!(viewport.fast_path_active());

        viewport.commit_render(260, 40);

        assert_eq!(viewport.live_content_rows(), 260);
        assert_eq!(viewport.content_rows(), 260);
    }

    #[test]
    fn content_replacement_and_resize_cancel_stale_drag_sessions() {
        let area = Rect::new(99, 0, 1, 20);
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(50), 200, 20, Some(area));
        viewport.begin_drag(5);
        assert!(viewport.drag_active());
        viewport.replace_content();
        assert!(!viewport.drag_active());
        assert!(viewport.is_at_tail());
        assert_eq!(viewport.live_content_rows(), 0);

        viewport =
            TranscriptViewport::with_layout(TranscriptScroll::at_line(50), 200, 20, Some(area));
        viewport.begin_frame(Rect::new(0, 0, 100, 20));
        viewport.set_scrollbar_area(Some(area));
        viewport.begin_drag(5);
        viewport.commit_render(240, 50);
        let position_before_resize = viewport.position();
        viewport.begin_frame(Rect::new(0, 0, 80, 12));
        assert!(!viewport.drag_active());
        assert_eq!(viewport.position(), position_before_resize);
        assert_eq!(viewport.live_content_rows(), 0);
    }

    #[test]
    fn invalidation_consumes_pending_wheel_before_discarding_row_map() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 200, 20, None);
        viewport.queue_wheel(ScrollDirection::Up);

        viewport.invalidate_content_layout();

        assert_eq!(viewport.position(), TranscriptScroll::from_tail(3));
        assert_eq!(viewport.pending_delta(), 0);
        assert_eq!(viewport.live_content_rows(), 0);
    }

    #[test]
    fn tui_lab_viewport_diagnostic_reports_real_committed_geometry() {
        let mut viewport =
            TranscriptViewport::with_layout(TranscriptScroll::from_tail(20), 200, 20, None);
        viewport.commit_render(200, 160);
        viewport.queue_wheel(ScrollDirection::Up);
        viewport.apply_pending_scroll();
        let diagnostic = viewport.tui_lab_viewport_diagnostic("commit", Some("up"), -3, 42);

        assert_eq!(diagnostic["timestamp_micros"], 42);
        assert_eq!(diagnostic["phase"], "commit");
        assert_eq!(diagnostic["sequence"], 2);
        assert_eq!(diagnostic["input_sequence"], 1);
        assert_eq!(diagnostic["applied_through_input_sequence"], 1);
        assert_eq!(diagnostic["applied_delta"], -3);
        assert_eq!(diagnostic["minimum_progress_rows"], 3);
        assert_eq!(diagnostic["direction"], "up");
        assert_eq!(diagnostic["visible_top"], 160);
        assert_eq!(diagnostic["resolved_top"], 157);
        assert_eq!(diagnostic["content_rows"], 200);
        assert_eq!(diagnostic["viewport_rows"], 20);
        assert_eq!(diagnostic["boundary"], "none");
        assert!(diagnostic["anchor"].as_str().unwrap().contains("FromTail"));
    }

    #[test]
    fn thumb_round_trip_returns_pointer_to_the_same_track_cell() {
        // Dragging is a track-cell -> offset_for_thumb_start -> thumb_start round trip.
        // With symmetric rounding every cell must map to itself; otherwise the thumb
        // consistently lags the pointer by one cell.
        for (content, viewport, track) in [
            (200usize, 40usize, 20u16),
            (5000, 50, 40),
            (1000, 100, 25),
            (137, 19, 20),
            (30, 20, 20),
        ] {
            let probe = ScrollbarMetrics::new(content, viewport, 0, track);
            for cell in 0..=probe.thumb_travel() {
                let offset = probe.offset_for_thumb_start(cell);
                let painted = ScrollbarMetrics::new(content, viewport, offset, track).thumb_start;
                assert_eq!(
                    painted, cell,
                    "content={content} viewport={viewport} track={track} cell={cell} offset={offset}"
                );
            }
        }
    }

    #[test]
    fn thumb_mapping_stays_monotonic_with_exact_endpoints() {
        for (content, viewport, track) in [
            (200usize, 40usize, 30u16),
            (5000, 50, 40),
            (137, 19, 20),
            (21, 20, 20),
        ] {
            let probe = ScrollbarMetrics::new(content, viewport, 0, track);
            let max_offset = probe.max_offset();
            assert_eq!(
                ScrollbarMetrics::new(content, viewport, 0, track).thumb_start,
                0
            );
            assert_eq!(
                ScrollbarMetrics::new(content, viewport, max_offset, track).thumb_start,
                probe.thumb_travel(),
                "底部端点必须精确对齐轨道末端"
            );
            assert_eq!(probe.offset_for_thumb_start(0), 0);
            assert_eq!(
                probe.offset_for_thumb_start(probe.thumb_travel()),
                max_offset
            );
            let mut previous = 0;
            for offset in 1..=max_offset {
                let thumb_start =
                    ScrollbarMetrics::new(content, viewport, offset, track).thumb_start;
                assert!(
                    thumb_start >= previous && thumb_start - previous <= 1,
                    "content={content} offset={offset}: {previous} -> {thumb_start} 必须单调且单步不超过一格"
                );
                previous = thumb_start;
            }
        }
    }

    #[test]
    fn remap_top_rounds_like_the_render_side() {
        // Rendering uses symmetric rounding in remap_scroll_top_proportionally;
        // require viewport remap_top to use the same rule, because floor would return 0.
        assert_eq!(remap_top(1, 8, 5, 0), 1);
        // Endpoint remapping remains exact.
        assert_eq!(remap_top(8, 8, 5, 0), 5);
        assert_eq!(remap_top(0, 8, 5, 0), 0);
        assert_eq!(remap_top(3, 8, 5, 10), 0, "源坐标系放不下时应归零");
    }
}
