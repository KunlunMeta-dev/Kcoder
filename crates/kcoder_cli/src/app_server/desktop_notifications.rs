//! Project confirmed desktop lifecycle independently of model/tool streaming.
use super::{
    notification_projection::with_event_context_at_sequence,
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
    #[cfg(test)]
    pub(super) fn start(
        state: watch::Receiver<DesktopSessionState>,
        owner: DesktopOwner,
        sequence: Arc<AtomicU64>,
        tx: mpsc::Sender<serde_json::Value>,
    ) -> Self {
        Self::start_observed(state, None, None, false, owner, sequence, tx)
    }
    pub(super) fn start_with_diagnostics(
        state: watch::Receiver<DesktopSessionState>,
        diagnostics: watch::Receiver<Option<kcoder_computer_use::session::OperationDiagnostic>>,
        grant: Arc<std::sync::Mutex<super::desktop_recovery::DesktopGrantState>>,
        expose_diagnostics: bool,
        owner: DesktopOwner,
        sequence: Arc<AtomicU64>,
        tx: mpsc::Sender<serde_json::Value>,
    ) -> Self {
        Self::start_observed(
            state,
            Some(diagnostics),
            Some(grant),
            expose_diagnostics,
            owner,
            sequence,
            tx,
        )
    }
    fn start_observed(
        mut state: watch::Receiver<DesktopSessionState>,
        mut diagnostics: Option<
            watch::Receiver<Option<kcoder_computer_use::session::OperationDiagnostic>>,
        >,
        grant: Option<Arc<std::sync::Mutex<super::desktop_recovery::DesktopGrantState>>>,
        expose_diagnostics: bool,
        owner: DesktopOwner,
        sequence: Arc<AtomicU64>,
        tx: mpsc::Sender<serde_json::Value>,
    ) -> Self {
        let (finish, mut finished) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut finishing = false;
            let mut last: Option<ComputerUseStateChanged> = None;
            loop {
                let wake_state = *state.borrow_and_update();
                if let Some(receiver) = diagnostics.as_mut() {
                    let _ = receiver.borrow_and_update();
                }
                let event = if let Some(grant) = &grant {
                    let (event_sequence, observed) =
                        kcoder_desktop_recovery::observe_turn_with_sequence(
                            grant, &owner, &sequence,
                        );
                    observed.and_then(|mut payload| {
                        if !expose_diagnostics {
                            payload.diagnostic = None;
                            payload.recovery_available = None;
                        }
                        if last.as_ref() == Some(&payload) {
                            return None;
                        }
                        Some((payload, event_sequence))
                    })
                } else {
                    let payload = ComputerUseStateChanged {
                        state: wake_state,
                        target: ComputerUseTarget::LocalWindowsDesktop,
                        diagnostic: None,
                        recovery_available: None,
                    };
                    (last.as_ref() != Some(&payload)).then(|| {
                        let event_sequence =
                            sequence.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        (payload, event_sequence)
                    })
                };
                let observed_state = event
                    .as_ref()
                    .map_or(wake_state, |(payload, _)| payload.state);
                if let Some((payload, event_sequence)) = event {
                    let last_payload = payload.clone();
                    let Ok(payload) = serde_json::to_value(payload) else {
                        break;
                    };
                    let event = notification(
                        method::COMPUTER_USE_STATE_CHANGED,
                        with_event_context_at_sequence(
                            &owner.client_instance,
                            &owner.thread_id,
                            Some(&owner.turn_id),
                            event_sequence,
                            payload,
                        ),
                    );
                    if send(&tx, event).await.is_err() {
                        break;
                    }
                    last = Some(last_payload);
                }
                // A failed attempt may subsequently receive a successful cleanup
                // receipt. Only Stopped, or the owning turn's explicit finish,
                // ends projection; do not freeze the UI at an intermediate error.
                if observed_state == DesktopSessionState::Stopped || finishing {
                    break;
                }
                tokio::select! {
                    _ = &mut finished => finishing = true,
                    result = state.changed() => if result.is_err() { break; },
                    result = async {
                        match diagnostics.as_mut() {
                            Some(receiver) => receiver.changed().await,
                            None => std::future::pending().await,
                        }
                    } => if result.is_err() { diagnostics = None; },
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
    async fn notification_uses_the_fresh_grant_snapshot_not_a_stale_watch_copy() {
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let grant = Arc::new(std::sync::Mutex::new(
            super::super::desktop_recovery::DesktopGrantState::default(),
        ));
        grant.lock().unwrap().begin_turn(&owner, None).unwrap();
        grant.lock().unwrap().confirm_cleanup(
            "turn",
            kcoder_app_protocol::ComputerUseCleanupState::Confirmed,
            true,
        );
        let (_state_tx, state) = watch::channel(DesktopSessionState::Active);
        let (_diagnostic_tx, diagnostics) = watch::channel(None);
        let (tx, mut events) = mpsc::channel(4);
        let sequence = Arc::new(AtomicU64::new(7));
        let pump = DesktopNotifications::start_with_diagnostics(
            state,
            diagnostics,
            grant,
            true,
            owner,
            sequence.clone(),
            tx,
        );
        let event = events.recv().await.unwrap();
        assert_eq!(event["params"]["state"], "stopped");
        assert_eq!(event["params"]["sequence"], 7);
        assert_eq!(sequence.load(std::sync::atomic::Ordering::Relaxed), 8);
        pump.finish().await;
    }

    #[tokio::test]
    async fn operation_diagnostics_publish_independently_of_lifecycle_without_screen_content() {
        use kcoder_computer_use::{
            admission::Admissions,
            broker::DesktopBroker,
            client::DesktopClient,
            connection::serve_authenticated,
            session::DesktopSession,
            worker::{DesktopWorker, WorkerError, WorkerHandle},
        };
        use serde_json::{Value, json};
        struct Observed;
        #[async_trait::async_trait]
        impl DesktopWorker for Observed {
            async fn call(&mut self, _: &str, _: Value) -> Result<Value, WorkerError> {
                Ok(
                    json!({"isError":true,"content":[{"type":"text","text":"private window title"}]}),
                )
            }
            async fn shutdown(&mut self) -> Result<(), WorkerError> {
                Ok(())
            }
        }
        let owner = DesktopOwner {
            client_instance: "server".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let mut admissions = Admissions::default();
        let (id, secret) = admissions.issue(1, 3, owner.clone()).unwrap();
        let identity = admissions
            .consume(&id, secret.expose_for_bootstrap(), 1, 3)
            .unwrap();
        let broker =
            DesktopBroker::new(WorkerHandle::spawn(Observed, Duration::from_secs(1)), 3).unwrap();
        let (client, stream) = tokio::io::duplex(4096);
        let serving = tokio::spawn(serve_authenticated(stream, identity, broker));
        let session = Arc::new(
            DesktopSession::acquire(DesktopClient::from_authenticated(client), owner.clone())
                .await
                .unwrap(),
        );
        session.set_worker_identity(123, 456);
        let grant = Arc::new(std::sync::Mutex::new(
            super::super::desktop_recovery::DesktopGrantState::default(),
        ));
        let generation = grant.lock().unwrap().begin_turn(&owner, None).unwrap();
        grant
            .lock()
            .unwrap()
            .attach_session(&owner, generation, session.clone())
            .unwrap();
        let (tx, mut events) = mpsc::channel(8);
        let pump = DesktopNotifications::start_with_diagnostics(
            session.subscribe_state(),
            session.subscribe_diagnostics(),
            grant.clone(),
            true,
            owner,
            Arc::new(AtomicU64::new(1)),
            tx,
        );
        let first = events.recv().await.unwrap();
        assert_eq!(first["params"]["diagnostic"]["authorization"], "valid");
        session
            .call("Snapshot", json!({}), Duration::from_secs(1))
            .await
            .unwrap();
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["params"]["state"], "active");
        assert_eq!(
            event["params"]["diagnostic"]["failureCode"],
            "recoverable_operation_error"
        );
        assert_eq!(event["params"]["diagnostic"]["channel"], "available");
        assert_eq!(event["params"]["diagnostic"]["workerPid"], 456);
        assert!(!event.to_string().contains("private window title"));
        session.stop().await.unwrap();
        pump.finish().await;
        drop(session);
        drop(grant);
        assert!(serving.await.unwrap().is_err());
    }
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
            assert!(event["params"].get("diagnostic").is_none());
            assert!(event["params"].get("recoveryAvailable").is_none());
        }
        pump.finish().await;
        assert!(rx.recv().await.is_none());
    }
}
