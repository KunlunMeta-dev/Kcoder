use crate::events::{AppEvent, AppEventSender};

pub(crate) struct TurnCompletionGuard {
    tx: AppEventSender,
    completed: bool,
    steering: Option<kcoder_engine::TurnSteerSettlement>,
    unapplied_steers: Vec<u64>,
}

impl TurnCompletionGuard {
    pub(crate) fn new(tx: AppEventSender) -> Self {
        Self {
            tx,
            completed: false,
            steering: None,
            unapplied_steers: Vec::new(),
        }
    }

    pub(crate) fn set_steering(&mut self, steering: Option<kcoder_engine::TurnSteerSettlement>) {
        self.steering = steering;
    }

    pub(crate) fn close_steering(&mut self) {
        if let Some(steering) = &self.steering {
            self.unapplied_steers.extend(steering.close());
        }
    }

    fn finished_event(&mut self) -> AppEvent {
        self.close_steering();
        if self.steering.take().is_some() {
            AppEvent::TurnFinishedWithSteering {
                unapplied_steers: std::mem::take(&mut self.unapplied_steers),
            }
        } else {
            AppEvent::TurnFinished
        }
    }

    pub(crate) fn finish(&mut self) {
        if self.completed {
            return;
        }
        let event = self.finished_event();
        let _ = self.tx.send(event);
        self.completed = true;
    }

    pub(crate) async fn finish_ordered(&mut self) {
        if self.completed {
            return;
        }
        let event = self.finished_event();
        let _ = self.tx.send_ordered(event).await;
        self.completed = true;
    }
}

impl Drop for TurnCompletionGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::APP_EVENT_CHANNEL_CAPACITY;
    use tokio::sync::mpsc;

    #[test]
    fn sends_turn_finished_on_drop() {
        let (tx, mut rx) = mpsc::channel(APP_EVENT_CHANNEL_CAPACITY);
        let tx = AppEventSender::new(tx);

        {
            let _guard = TurnCompletionGuard::new(tx);
        }

        assert!(matches!(rx.try_recv(), Ok(AppEvent::TurnFinished)));
    }

    #[tokio::test]
    async fn dropped_turn_terminal_event_precedes_a_new_turn_after_backpressure() {
        let (raw_tx, mut rx) = mpsc::channel(1);
        raw_tx.send(AppEvent::FrameTick).await.unwrap();
        let tx = AppEventSender::new(raw_tx);
        drop(TurnCompletionGuard::new(tx.clone()));
        assert!(matches!(rx.recv().await, Some(AppEvent::FrameTick)));
        assert!(tx.send(AppEvent::TurnStarted));
        assert!(matches!(rx.recv().await, Some(AppEvent::TurnFinished)));
        assert!(matches!(rx.recv().await, Some(AppEvent::TurnStarted)));
    }

    #[tokio::test]
    async fn ordered_finish_waits_behind_prior_events() {
        let (raw_tx, mut rx) = mpsc::channel(1);
        raw_tx.send(AppEvent::FrameTick).await.unwrap();
        let tx = AppEventSender::new(raw_tx);
        let mut guard = TurnCompletionGuard::new(tx);

        let finish = tokio::spawn(async move {
            guard.finish_ordered().await;
        });

        tokio::task::yield_now().await;
        assert!(matches!(rx.recv().await, Some(AppEvent::FrameTick)));
        finish.await.unwrap();
        assert!(matches!(rx.recv().await, Some(AppEvent::TurnFinished)));
    }
}
