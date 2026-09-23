//! Frame-draw scheduling for the TUI.
//!
//! Widgets and runtime tasks can request a future redraw without enqueueing a
//! separate terminal event for every caller. The scheduler coalesces many
//! requests into one frame tick and clamps notifications to the shared frame
//! limiter.

use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::events::{AppEvent, AppEventSender};
use crate::frame_rate_limiter::FrameRateLimiter;

/// Lightweight handle for scheduling future TUI frame ticks.
#[derive(Clone, Debug)]
pub(crate) struct FrameRequester {
    frame_schedule_tx: mpsc::UnboundedSender<Instant>,
}

impl FrameRequester {
    pub(crate) fn new(event_tx: AppEventSender) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let scheduler = FrameScheduler::new(rx, event_tx);
        tokio::spawn(scheduler.run());
        Self {
            frame_schedule_tx: tx,
        }
    }

    pub(crate) fn schedule_frame(&self) {
        let _ = self.frame_schedule_tx.send(Instant::now());
    }

    pub(crate) fn schedule_frame_in(&self, dur: Duration) {
        let _ = self.frame_schedule_tx.send(Instant::now() + dur);
    }
}

struct FrameScheduler {
    receiver: mpsc::UnboundedReceiver<Instant>,
    event_tx: AppEventSender,
    rate_limiter: FrameRateLimiter,
}

impl FrameScheduler {
    fn new(receiver: mpsc::UnboundedReceiver<Instant>, event_tx: AppEventSender) -> Self {
        Self {
            receiver,
            event_tx,
            rate_limiter: FrameRateLimiter::default(),
        }
    }

    async fn run(mut self) {
        const ONE_YEAR: Duration = Duration::from_secs(60 * 60 * 24 * 365);
        let mut next_deadline: Option<Instant> = None;
        loop {
            let target = next_deadline.unwrap_or_else(|| Instant::now() + ONE_YEAR);
            let deadline = tokio::time::sleep_until(target.into());
            tokio::pin!(deadline);

            tokio::select! {
                draw_at = self.receiver.recv() => {
                    let Some(draw_at) = draw_at else {
                        break;
                    };
                    let draw_at = self.rate_limiter.clamp_deadline(draw_at);
                    next_deadline = Some(next_deadline.map_or(draw_at, |cur| cur.min(draw_at)));
                    continue;
                }
                _ = &mut deadline => {
                    if next_deadline.is_some() {
                        next_deadline = None;
                        self.rate_limiter.mark_emitted(target);
                        if !self.event_tx.send_ordered(AppEvent::FrameTick).await {
                            break;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Duration, timeout};

    #[tokio::test]
    async fn scheduled_frame_survives_a_full_event_queue() {
        let (tx, mut rx) = mpsc::channel(1);
        let event_tx = AppEventSender::new(tx);
        assert!(event_tx.send(AppEvent::SystemNotice("occupy queue".to_string())));
        let requester = FrameRequester::new(event_tx);

        requester.schedule_frame();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(matches!(rx.recv().await, Some(AppEvent::SystemNotice(_))));

        let delivered = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("frame scheduler must resume after queue capacity returns");
        assert!(matches!(delivered, Some(AppEvent::FrameTick)));
    }
}
