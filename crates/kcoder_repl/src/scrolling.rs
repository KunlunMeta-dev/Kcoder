//! Scroll state tracking for the transcript view.
//!
//! The transcript uses a flat line-offset model where `offset` points at the top visible
//! **display row** (after wrapping), and `usize::MAX` is reserved as a sentinel
//! meaning "stuck to the live tail".

#[cfg(test)]
use std::time::{Duration, Instant};

pub(crate) const WHEEL_LINES_PER_TICK: i32 = 3;

/// Flat line-offset scroll state for the transcript view.
///
/// Absolute offsets are used for scrollbar dragging and jumps. Wheel input
/// leaving the live tail is stored as a distance from the tail, because the
/// virtual row index can be refined between frames. Keeping that anchor avoids
/// swallowing the first wheel ticks or jumping when estimated and exact row
/// counts differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranscriptScroll {
    anchor: TranscriptScrollAnchor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptScrollAnchor {
    Tail,
    Absolute(usize),
    Pinned(usize),
    FromTail(usize),
}

impl Default for TranscriptScroll {
    /// Default state is "stuck to live tail".
    fn default() -> Self {
        Self::to_bottom()
    }
}

impl TranscriptScroll {
    /// State that follows the live tail (default).
    #[must_use]
    pub const fn to_bottom() -> Self {
        Self {
            anchor: TranscriptScrollAnchor::Tail,
        }
    }

    /// State pinned to a specific display row.
    #[must_use]
    pub const fn at_line(offset: usize) -> Self {
        Self {
            anchor: TranscriptScrollAnchor::Absolute(offset),
        }
    }

    /// Semantic review must not resume automatic tail following implicitly, even when it lands on the final screen.
    pub(crate) const fn pinned(offset: usize) -> Self {
        Self {
            anchor: TranscriptScrollAnchor::Pinned(offset),
        }
    }

    pub(crate) const fn pinned_top(self) -> Option<usize> {
        match self.anchor {
            TranscriptScrollAnchor::Pinned(offset) => Some(offset),
            _ => None,
        }
    }

    #[must_use]
    pub const fn from_tail(distance: usize) -> Self {
        if distance == 0 {
            Self::to_bottom()
        } else {
            Self {
                anchor: TranscriptScrollAnchor::FromTail(distance),
            }
        }
    }

    /// Returns true when the view is following the live tail.
    #[must_use]
    pub const fn is_at_tail(self) -> bool {
        matches!(self.anchor, TranscriptScrollAnchor::Tail)
    }

    /// Returns true when the position was produced by wheel/key scrolling
    /// away from the live tail and should survive row-count refinement as a
    /// distance from that tail.
    #[must_use]
    pub const fn is_tail_relative(self) -> bool {
        matches!(self.anchor, TranscriptScrollAnchor::FromTail(_))
    }

    /// Resolve the scroll state to a concrete top display row.
    ///
    /// `max_start` is `total_lines.saturating_sub(visible_lines)`. The
    /// returned state is the canonicalized state — if the resolved top
    /// reaches the tail (or the transcript fits in one screen) we collapse
    /// to [`TranscriptScroll::to_bottom`].
    #[must_use]
    pub fn resolve_top(self, total_lines: usize, visible_lines: usize) -> (Self, usize) {
        if let TranscriptScrollAnchor::Pinned(offset) = self.anchor {
            let top = offset.min(total_lines.saturating_sub(visible_lines));
            return (Self::pinned(top), top);
        }
        if total_lines <= visible_lines {
            return (Self::to_bottom(), 0);
        }
        let max_start = total_lines.saturating_sub(visible_lines);
        match self.anchor {
            TranscriptScrollAnchor::Pinned(_) => unreachable!(),
            TranscriptScrollAnchor::Tail => (Self::to_bottom(), max_start),
            TranscriptScrollAnchor::Absolute(offset) => {
                let top = offset.min(max_start);
                if top >= max_start {
                    (Self::to_bottom(), max_start)
                } else {
                    (Self::at_line(top), top)
                }
            }
            TranscriptScrollAnchor::FromTail(distance) => {
                let distance = distance.min(max_start);
                let top = max_start.saturating_sub(distance);
                if distance == 0 {
                    (Self::to_bottom(), max_start)
                } else if top == 0 {
                    (Self::at_line(0), 0)
                } else {
                    (Self::from_tail(distance), top)
                }
            }
        }
    }

    /// Apply a signed scroll delta and return the updated state.
    ///
    /// Negative `delta_lines` scrolls up, positive scrolls down. When the
    /// resolved offset hits the tail we snap to [`TranscriptScroll::to_bottom`]
    /// so subsequent appended content pulls the view along.
    #[must_use]
    pub fn scrolled_by(self, delta_lines: i32, total_lines: usize, visible_lines: usize) -> Self {
        if let TranscriptScrollAnchor::Pinned(offset) = self.anchor {
            if delta_lines == 0 {
                return self;
            }
            let max_start = total_lines.saturating_sub(visible_lines);
            let next = offset
                .saturating_add_signed(delta_lines as isize)
                .min(max_start);
            // Exit review only when the user explicitly scrolls down to the final screen; content changes and resize do not trigger it.
            if delta_lines > 0 && next >= max_start {
                return Self::to_bottom();
            }
            return Self::pinned(next);
        }
        if delta_lines == 0 {
            return self;
        }
        if total_lines <= visible_lines {
            // Whole transcript fits; only "tail" is meaningful.
            return Self::to_bottom();
        }
        let max_start = total_lines.saturating_sub(visible_lines);
        if matches!(
            self.anchor,
            TranscriptScrollAnchor::Tail | TranscriptScrollAnchor::FromTail(_)
        ) {
            let current_distance = match self.anchor {
                TranscriptScrollAnchor::FromTail(distance) => distance.min(max_start),
                _ => 0,
            };
            let new_distance = if delta_lines < 0 {
                current_distance
                    .saturating_add(delta_lines.unsigned_abs() as usize)
                    .min(max_start)
            } else {
                current_distance.saturating_sub(delta_lines as usize)
            };
            if new_distance == 0 {
                return Self::to_bottom();
            }
            if new_distance >= max_start {
                return Self::at_line(0);
            }
            return Self::from_tail(new_distance);
        }

        let current_top = match self.anchor {
            TranscriptScrollAnchor::Absolute(offset) => offset.min(max_start),
            _ => max_start,
        };
        let new_top = if delta_lines < 0 {
            current_top.saturating_sub(delta_lines.unsigned_abs() as usize)
        } else {
            let delta = usize::try_from(delta_lines).unwrap_or(usize::MAX);
            current_top.saturating_add(delta).min(max_start)
        };
        if new_top >= max_start {
            Self::to_bottom()
        } else {
            Self::at_line(new_top)
        }
    }
}

/// Direction for mouse scroll input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
}

impl ScrollDirection {
    fn sign(self) -> i32 {
        match self {
            ScrollDirection::Up => -1,
            ScrollDirection::Down => 1,
        }
    }
}

/// Mouse-wheel input tracker with a fixed step.
#[derive(Debug, Default)]
pub struct MouseScrollState;

/// A computed scroll delta from user input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollUpdate {
    pub delta_lines: i32,
}

impl MouseScrollState {
    /// Create a new scroll state tracker.
    #[must_use]
    pub fn new() -> Self {
        Self
    }

    /// Process a scroll event and return the resulting delta.
    pub fn on_scroll(&mut self, direction: ScrollDirection) -> ScrollUpdate {
        // Device event frequency already expresses scroll speed. Keep a fixed step per
        // event so timing thresholds cannot misclassify a wheel as a touchpad and jump from 6 to 24 rows.
        ScrollUpdate {
            delta_lines: direction.sign() * WHEEL_LINES_PER_TICK,
        }
    }

    #[cfg(test)]
    fn on_scroll_at(&mut self, direction: ScrollDirection, _now: Instant) -> ScrollUpdate {
        self.on_scroll(direction)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_is_tail() {
        let state = TranscriptScroll::default();
        assert!(state.is_at_tail());
        let (resolved, top) = state.resolve_top(20, 8);
        assert!(resolved.is_at_tail());
        assert_eq!(top, 12);
    }

    #[test]
    fn resolve_top_keeps_position_when_in_range() {
        let state = TranscriptScroll::at_line(5);
        let (resolved, top) = state.resolve_top(20, 8);
        assert_eq!(resolved, TranscriptScroll::at_line(5));
        assert_eq!(top, 5);
    }

    #[test]
    fn resolve_top_clamps_when_offset_past_max_start() {
        let state = TranscriptScroll::at_line(100);
        let (resolved, top) = state.resolve_top(10, 8);
        assert!(resolved.is_at_tail());
        assert_eq!(top, 2);
    }

    #[test]
    fn scrolled_by_moves_up_from_tail() {
        let state = TranscriptScroll::to_bottom();
        let new_state = state.scrolled_by(-3, 20, 8);
        assert_eq!(new_state, TranscriptScroll::from_tail(3));
        assert_eq!(new_state.resolve_top(20, 8).1, 9);
        assert_eq!(new_state.resolve_top(40, 8).1, 29);
    }

    #[test]
    fn scrolled_by_snaps_to_tail_at_bottom() {
        let state = TranscriptScroll::at_line(10);
        let new_state = state.scrolled_by(3, 20, 8);
        assert!(new_state.is_at_tail());
    }

    #[test]
    fn scrolled_by_collapses_when_fits() {
        let state = TranscriptScroll::at_line(5);
        let new_state = state.scrolled_by(-10, 4, 8);
        assert!(new_state.is_at_tail());
    }

    #[test]
    fn mouse_scroll_single_wheel_tick_moves_three_lines() {
        let mut state = MouseScrollState::new();
        let start = Instant::now();
        assert_eq!(
            state.on_scroll_at(ScrollDirection::Down, start).delta_lines,
            3
        );
        assert_eq!(
            state.on_scroll_at(ScrollDirection::Up, start).delta_lines,
            -3,
            "rapid precise input must not start slower than a normal wheel tick"
        );
    }

    #[test]
    fn mouse_scroll_rapid_same_direction_keeps_fixed_step() {
        let mut state = MouseScrollState::new();
        let start = Instant::now();
        let deltas = [
            state.on_scroll_at(ScrollDirection::Down, start).delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(10))
                .delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(20))
                .delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(30))
                .delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(40))
                .delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(50))
                .delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(60))
                .delta_lines,
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(70))
                .delta_lines,
        ];
        assert_eq!(deltas, [3, 3, 3, 3, 3, 3, 3, 3]);
    }

    #[test]
    fn mouse_scroll_sustained_same_direction_keeps_fixed_step() {
        let mut state = MouseScrollState::new();
        let start = Instant::now();
        let mut last = 0;
        for step in 0..14 {
            last = state
                .on_scroll_at(
                    ScrollDirection::Down,
                    start + Duration::from_millis(step * 10),
                )
                .delta_lines;
        }

        assert_eq!(last, WHEEL_LINES_PER_TICK);
    }

    #[test]
    fn mouse_scroll_direction_change_keeps_fixed_step() {
        let mut state = MouseScrollState::new();
        let start = Instant::now();
        for step in 0..8 {
            let _ = state.on_scroll_at(
                ScrollDirection::Down,
                start + Duration::from_millis(step * 10),
            );
        }
        assert_eq!(
            state
                .on_scroll_at(ScrollDirection::Up, start + Duration::from_millis(90))
                .delta_lines,
            -3
        );
    }

    #[test]
    fn mouse_scroll_slow_gap_keeps_fixed_step() {
        let mut state = MouseScrollState::new();
        let start = Instant::now();
        assert_eq!(
            state.on_scroll_at(ScrollDirection::Down, start).delta_lines,
            3
        );
        assert_eq!(
            state
                .on_scroll_at(ScrollDirection::Down, start + Duration::from_millis(400))
                .delta_lines,
            3
        );
    }
}
