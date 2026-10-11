//! Draw-rate cap for the TUI render loop.
//!
//! When the model streams a long assistant response, every SSE chunk can
//! otherwise trigger a full screen redraw. The frame requester coalesces those
//! requests, and this limiter clamps the final draw notifications to KCoder's
//! 15 FPS target.

use std::time::{Duration, Instant};

/// 15 FPS minimum frame interval (≈66.67 ms).
pub const MIN_FRAME_INTERVAL: Duration = Duration::from_nanos(66_666_667);
/// 30 FPS frame interval while the user scrolls the transcript directly.
pub const INTERACTION_MIN_FRAME_INTERVAL: Duration = Duration::from_nanos(33_333_334);

#[derive(Debug, Default)]
pub struct FrameRateLimiter {
    last_emitted_at: Option<Instant>,
}

impl FrameRateLimiter {
    /// Returns the earliest instant at which the next draw is allowed.
    #[must_use]
    pub fn clamp_deadline(&self, requested: Instant) -> Instant {
        self.clamp_deadline_with_interval(requested, MIN_FRAME_INTERVAL)
    }

    #[must_use]
    pub fn clamp_deadline_with_interval(
        &self,
        requested: Instant,
        min_frame_interval: Duration,
    ) -> Instant {
        let Some(last_emitted_at) = self.last_emitted_at else {
            return requested;
        };
        let min_allowed = last_emitted_at
            .checked_add(min_frame_interval)
            .unwrap_or(last_emitted_at);
        requested.max(min_allowed)
    }

    /// Records that a draw was emitted at `emitted_at`.
    pub fn mark_emitted(&mut self, emitted_at: Instant) {
        self.last_emitted_at = Some(emitted_at);
    }

    /// Allows the next draw to happen immediately.
    pub fn reset(&mut self) {
        self.last_emitted_at = None;
    }

    /// `Some(d)` if the next draw must wait `d` from `now`; `None` if a draw
    /// is allowed right now.
    #[must_use]
    pub fn time_until_next_draw(&self, now: Instant) -> Option<Duration> {
        self.time_until_next_draw_with_interval(now, MIN_FRAME_INTERVAL)
    }

    #[must_use]
    pub fn time_until_next_draw_with_interval(
        &self,
        now: Instant,
        min_frame_interval: Duration,
    ) -> Option<Duration> {
        let clamped = self.clamp_deadline_with_interval(now, min_frame_interval);
        if clamped <= now {
            None
        } else {
            Some(clamped - now)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_does_not_clamp() {
        let t0 = Instant::now();
        let limiter = FrameRateLimiter::default();
        assert_eq!(limiter.clamp_deadline(t0), t0);
        assert!(limiter.time_until_next_draw(t0).is_none());
    }

    #[test]
    fn clamps_to_min_interval_since_last_emit() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        assert_eq!(limiter.clamp_deadline(t0), t0);
        limiter.mark_emitted(t0);

        let too_soon = t0 + Duration::from_millis(1);
        assert_eq!(limiter.clamp_deadline(too_soon), t0 + MIN_FRAME_INTERVAL);
    }

    #[test]
    fn time_until_next_draw_reports_remaining_window() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        limiter.mark_emitted(t0);

        let after_1ms = t0 + Duration::from_millis(1);
        let remaining = limiter.time_until_next_draw(after_1ms).unwrap();
        assert!(
            remaining > Duration::from_millis(65) && remaining < Duration::from_millis(66),
            "expected ~65.67ms, got {remaining:?}"
        );
    }

    #[test]
    fn time_until_next_draw_none_after_interval_elapsed() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        limiter.mark_emitted(t0);

        let well_past = t0 + Duration::from_millis(80);
        assert!(limiter.time_until_next_draw(well_past).is_none());
    }

    #[test]
    fn reset_allows_immediate_draw() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        limiter.mark_emitted(t0);
        limiter.reset();

        assert!(
            limiter
                .time_until_next_draw(t0 + Duration::from_millis(1))
                .is_none()
        );
    }

    #[test]
    fn interaction_interval_allows_30_fps_without_disabling_coalescing() {
        let t0 = Instant::now();
        let mut limiter = FrameRateLimiter::default();
        limiter.mark_emitted(t0);

        let after_1ms = t0 + Duration::from_millis(1);
        let interaction_deadline =
            limiter.clamp_deadline_with_interval(after_1ms, INTERACTION_MIN_FRAME_INTERVAL);
        assert_eq!(interaction_deadline, t0 + INTERACTION_MIN_FRAME_INTERVAL);
        assert!(
            limiter
                .time_until_next_draw_with_interval(
                    t0 + Duration::from_millis(34),
                    INTERACTION_MIN_FRAME_INTERVAL,
                )
                .is_none()
        );
    }
}
