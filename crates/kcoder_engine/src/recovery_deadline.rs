//! One absolute deadline shared by all attempts of a logical Provider request.

use crate::EngineEvent;
use std::time::Duration;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

pub(super) const DEADLINE_ERROR: &str = "Provider recovery deadline exceeded (recovery.provider.total_timeout_ms); no further request will be sent.";

#[derive(Clone, Copy, Default)]
pub(super) struct RecoveryDeadline {
    started: bool,
    deadline: Option<Instant>,
}

impl RecoveryDeadline {
    pub(super) fn start(&mut self, timeout_ms: Option<u64>) {
        if !self.started {
            self.started = true;
            self.deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
        }
    }

    pub(super) fn is_active(self) -> bool {
        self.deadline.is_some()
    }

    pub(super) async fn elapsed(self) {
        match self.deadline {
            Some(deadline) => tokio::time::sleep_until(deadline).await,
            None => std::future::pending().await,
        }
    }

    pub(super) fn stop_event(self, cancel: &CancellationToken) -> Option<EngineEvent> {
        if cancel.is_cancelled() {
            Some(EngineEvent::StreamAborted {
                reason: "cancelled by user".into(),
            })
        } else if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            Some(EngineEvent::Error(DEADLINE_ERROR.into()))
        } else {
            None
        }
    }

    pub(super) async fn backoff(
        self,
        cancel: CancellationToken,
        delay: Duration,
    ) -> Option<EngineEvent> {
        if !self.is_active() {
            return if crate::retry_policy::sleep_or_cancel(cancel, delay).await {
                None
            } else {
                Some(EngineEvent::StreamAborted {
                    reason: "cancelled by user".into(),
                })
            };
        }
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {},
            _ = self.elapsed() => {},
            _ = tokio::time::sleep(delay) => {},
        }
        self.stop_event(&cancel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_request_samples_disabled_timeout_only_once() {
        let mut deadline = RecoveryDeadline::default();
        deadline.start(None);
        deadline.start(Some(1));
        assert!(!deadline.is_active());
    }

    #[test]
    fn logical_request_never_rebases_enabled_timeout() {
        let mut deadline = RecoveryDeadline::default();
        deadline.start(Some(1));
        let original = deadline.deadline;
        deadline.start(Some(86_400_000));
        deadline.start(None);
        assert_eq!(deadline.deadline, original);
    }
}
