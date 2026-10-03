//! Project confirmed desktop lifecycle independently of model/tool streaming.
use super::{
    notification_projection::with_event_context,
    protocol_io::{notification, send},
};
use kcoder_app_protocol::{ComputerUseStateChanged, ComputerUseTarget, method};
use kcoder_types::computer_use::{DesktopOwner, DesktopSessionState};
use std::{
    sync::{Arc, atomic::AtomicU64},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, watch};

pub(super) struct DesktopNotifications {
    task: tokio::task::JoinHandle<()>,
    finish: Option<oneshot::Sender<()>>,
}
impl Drop for DesktopNotifications {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl DesktopNotifications {
    pub(super) fn start(
        mut state: watch::Receiver<DesktopSessionState>,
        owner: DesktopOwner,
        sequence: Arc<AtomicU64>,
        tx: mpsc::Sender<serde_json::Value>,
    ) -> Self {
        let (finish, mut finished) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut finishing = false;
            let mut last = None;
            loop {
                let current = *state.borrow_and_update();
                if last != Some(current) {
                    let payload = ComputerUseStateChanged {
                        state: current,
                        target: ComputerUseTarget::LocalWindowsDesktop,
                    };
                    let Ok(payload) = serde_json::to_value(payload) else {
                        break;
                    };
                    let event = notification(
                        method::COMPUTER_USE_STATE_CHANGED,
                        with_event_context(
                            &owner.client_instance,
                            &owner.thread_id,
                            Some(&owner.turn_id),
                            &sequence,
                            payload,
                        ),
                    );
                    if send(&tx, event).await.is_err() {
                        break;
                    }
                    last = Some(current);
                }
                // A failed attempt may subsequently receive a successful cleanup
                // receipt. Only Stopped, or the owning turn's explicit finish,
                // ends projection; do not freeze the UI at an intermediate error.
                if current == DesktopSessionState::Stopped || finishing {
                    break;
                }
                tokio::select! {
                    _ = &mut finished => finishing = true,
                    result = state.changed() => if result.is_err() { break; },
                }
            }
        });
        Self {
            task,
            finish: Some(finish),
        }
    }
    /// Drain the terminal state before turn/completed. A disconnected/full
    /// outbound channel must not indefinitely retain desktop turn resources.
    pub(super) async fn finish(mut self) {
        if let Some(finish) = self.finish.take() {
            let _ = finish.send(());
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut self.task).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cleanup_recovery_is_published_after_an_earlier_failure() {
        let (state, receiver) = watch::channel(DesktopSessionState::Active);
        let (tx, mut rx) = mpsc::channel(4);
        let pump = DesktopNotifications::start(
            receiver,
            DesktopOwner {
                client_instance: "server".into(),
                thread_id: "thread".into(),
                turn_id: "turn".into(),
            },
            Arc::new(AtomicU64::new(1)),
            tx,
        );
        for next in [
            DesktopSessionState::Active,
            DesktopSessionState::StopFailed,
            DesktopSessionState::Stopping,
            DesktopSessionState::Stopped,
        ] {
            state.send_replace(next);
            let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                event["params"]["state"],
                serde_json::to_value(next).unwrap()
            );
        }
        pump.finish().await;
        assert!(rx.recv().await.is_none());
    }
    #[tokio::test]
    async fn lifecycle_events_preserve_owner_and_cleanup_failure() {
        let (state, receiver) = watch::channel(DesktopSessionState::Active);
        let (tx, mut rx) = mpsc::channel(4);
        let pump = DesktopNotifications::start(
            receiver,
            DesktopOwner {
                client_instance: "server".into(),
                thread_id: "thread".into(),
                turn_id: "turn".into(),
            },
            Arc::new(AtomicU64::new(7)),
            tx,
        );
        for (index, next) in [
            DesktopSessionState::Active,
            DesktopSessionState::Stopping,
            DesktopSessionState::StopFailed,
        ]
        .into_iter()
        .enumerate()
        {
            if index > 0 {
                state.send_replace(next);
            }
            let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(event["method"], method::COMPUTER_USE_STATE_CHANGED);
            assert_eq!(
                event["params"]["state"],
                serde_json::to_value(next).unwrap()
            );
            assert_eq!(event["params"]["threadId"], "thread");
            assert_eq!(event["params"]["turnId"], "turn");
            assert_eq!(event["params"]["sequence"], 7 + index as u64);
            assert!(event["params"].get("lease").is_none());
        }
        pump.finish().await;
        assert!(rx.recv().await.is_none());
    }
}
