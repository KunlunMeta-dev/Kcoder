use crate::events::{AppEvent, AppEventSender};

pub(crate) struct TurnCompletionGuard {
    tx: AppEventSender,
    completed: bool,
}

impl TurnCompletionGuard {
    pub(crate) fn new(tx: AppEventSender) -> Self {
        Self {
            tx,
            completed: false,
        }
    }

    pub(crate) fn finish(&mut self) {
        if self.completed {
            return;
        }
        let _ = self.tx.send(AppEvent::TurnFinished);
        self.completed = true;
    }

    pub(crate) async fn finish_ordered(&mut self) {
        if self.completed {
            return;
        }
        let _ = self.tx.send_ordered(AppEvent::TurnFinished).await;
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
