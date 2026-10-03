//! Turn-bound client facade. The engine supplies trusted owner metadata once;
//! model arguments contain only the upstream tool arguments, never a lease.
use crate::client::{ClientError, DesktopClient};
use kcoder_types::computer_use::{
    DesktopLease, DesktopOperation, DesktopOwner, DesktopSessionState,
};
use serde_json::Value;
use std::time::Duration;
use tokio::sync::{Mutex, watch};

pub struct DesktopSession {
    client: DesktopClient,
    owner: DesktopOwner,
    lease: DesktopLease,
    stopped: Mutex<bool>,
    lifecycle: watch::Sender<DesktopSessionState>,
}

// Cancellation while awaiting a receipt is not proof of successful cleanup.
struct StopObservation(watch::Sender<DesktopSessionState>, bool);
impl Drop for StopObservation {
    fn drop(&mut self) {
        if !self.1 {
            self.0.send_replace(DesktopSessionState::StopFailed);
        }
    }
}
impl DesktopSession {
    pub async fn acquire(client: DesktopClient, owner: DesktopOwner) -> Result<Self, ClientError> {
        let result = client
            .request(
                DesktopOperation::Acquire {
                    owner: owner.clone(),
                },
                Duration::from_secs(10),
            )
            .await?;
        let lease: DesktopLease =
            serde_json::from_value(result.get("lease").cloned().ok_or(ClientError::Protocol)?)
                .map_err(|_| ClientError::Protocol)?;
        if lease.generation == 0 || uuid::Uuid::parse_str(&lease.id).is_err() {
            return Err(ClientError::Protocol);
        }
        Ok(Self {
            client,
            owner,
            lease,
            stopped: Mutex::new(false),
            lifecycle: watch::channel(DesktopSessionState::Active).0,
        })
    }
    pub fn owner(&self) -> &DesktopOwner {
        &self.owner
    }
    pub fn subscribe_state(&self) -> watch::Receiver<DesktopSessionState> {
        self.lifecycle.subscribe()
    }
    pub async fn call(
        &self,
        tool: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<Value, ClientError> {
        if !crate::policy::TOOLS.contains(&tool) || !arguments.is_object() {
            return Err(ClientError::Protocol);
        }
        if *self.stopped.lock().await || *self.lifecycle.borrow() != DesktopSessionState::Active {
            return Err(ClientError::Disconnected);
        }
        // Releasing the local lock before I/O allows stop to race safely. Broker
        // generation checks ensure the late call cannot act after revocation.
        let result = self
            .client
            .request(
                DesktopOperation::Call {
                    owner: self.owner.clone(),
                    lease: self.lease.clone(),
                    tool: tool.into(),
                    arguments,
                },
                timeout,
            )
            .await;
        if matches!(
            &result,
            Err(ClientError::Execution {
                cleanup_confirmed: true,
                ..
            })
        ) {
            *self.stopped.lock().await = true;
            self.lifecycle.send_replace(DesktopSessionState::Stopped);
        }
        if let Err(error) = &result
            && crate::failure::requires_new_authorization(error)
        {
            // A missing result is not a cleanup receipt. Stop accepting further
            // input on this lease and make the uncertainty visible immediately.
            self.lifecycle.send_if_modified(|state| {
                if *state == DesktopSessionState::Active {
                    *state = DesktopSessionState::StopFailed;
                    true
                } else {
                    false
                }
            });
        }
        result
    }
    /// Engine turn completion, cancellation, plugin disable and window close must
    /// await this before reporting control released. Drop closes the connection
    /// as a fallback, but is not a successful cleanup receipt.
    pub async fn stop(&self) -> Result<(), ClientError> {
        let mut stopped = self.stopped.lock().await;
        if *stopped {
            return Ok(());
        }
        self.lifecycle.send_replace(DesktopSessionState::Stopping);
        let mut observation = StopObservation(self.lifecycle.clone(), false);
        let result = self
            .client
            .request(
                DesktopOperation::Stop {
                    owner: self.owner.clone(),
                    lease: self.lease.clone(),
                },
                Duration::from_secs(40),
            )
            .await?;
        if result.get("stopped").and_then(Value::as_bool) != Some(true) {
            return Err(ClientError::Protocol);
        }
        *stopped = true;
        self.lifecycle.send_replace(DesktopSessionState::Stopped);
        observation.1 = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        admission::Admissions,
        broker::DesktopBroker,
        connection::serve_authenticated,
        worker::{DesktopWorker, WorkerError, WorkerHandle},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    struct Fixture(Arc<AtomicUsize>, Arc<tokio::sync::Notify>);
    #[async_trait::async_trait]
    impl DesktopWorker for Fixture {
        async fn call(&mut self, name: &str, args: Value) -> Result<Value, WorkerError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            if name == "Screenshot" && args["oversized"] == true {
                return Ok(Value::String("x".repeat(crate::framing::MAX_REPLY_BYTES)));
            }
            Ok(serde_json::json!({"name":name,"arguments":args}))
        }
        async fn shutdown(&mut self) -> Result<(), WorkerError> {
            self.1.notified().await;
            Ok(())
        }
    }
    #[tokio::test]
    async fn turn_session_acquires_calls_and_stops_without_exposing_lease_arguments() {
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let mut grants = Admissions::default();
        let (id, secret) = grants.issue(7, 3, owner.clone()).unwrap();
        let identity = grants
            .consume(&id, secret.expose_for_bootstrap(), 7, 3)
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let cleanup = Arc::new(tokio::sync::Notify::new());
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(
                Fixture(calls.clone(), cleanup.clone()),
                Duration::from_secs(3),
            ),
            3,
        )
        .unwrap();
        let (client, server) = tokio::io::duplex(4096);
        let serving = tokio::spawn(serve_authenticated(server, identity, broker));
        let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
            .await
            .unwrap();
        let result = session
            .call(
                "Screenshot",
                serde_json::json!({"use_annotation":false}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(
            result["arguments"],
            serde_json::json!({"use_annotation":false})
        );
        // Exercise the real broker framing limit, not a mocked error code.
        let oversized = session
            .call(
                "Screenshot",
                serde_json::json!({"oversized":true}),
                Duration::from_secs(3),
            )
            .await;
        assert_eq!(
            oversized,
            Err(ClientError::Remote("result_too_large".into()))
        );
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::Active
        );
        let guidance = crate::failure::operation_failure(&oversized.unwrap_err());
        assert_eq!(guidance["channelAvailable"], true);
        assert_eq!(guidance["automaticRetryAllowed"], false);
        session
            .call(
                "Snapshot",
                serde_json::json!({"use_vision":false}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        let session = Arc::new(session);
        let mut lifecycle = session.subscribe_state();
        assert_eq!(*lifecycle.borrow_and_update(), DesktopSessionState::Active);
        let stopping = tokio::spawn({
            let session = session.clone();
            async move { session.stop().await }
        });
        tokio::time::timeout(Duration::from_secs(1), lifecycle.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(*lifecycle.borrow(), DesktopSessionState::Stopping);
        assert!(!stopping.is_finished());
        cleanup.notify_one();
        stopping.await.unwrap().unwrap();
        assert_eq!(*lifecycle.borrow(), DesktopSessionState::Stopped);
        session.stop().await.unwrap();
        assert_eq!(
            session
                .call("Click", serde_json::json!({}), Duration::from_secs(1))
                .await,
            Err(ClientError::Disconnected)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        drop(session);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), serving)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn lost_cleanup_receipt_is_not_reported_as_stopped() {
        let (state, receiver) = watch::channel(DesktopSessionState::Stopping);
        drop(StopObservation(state, false));
        assert_eq!(*receiver.borrow(), DesktopSessionState::StopFailed);
    }

    #[tokio::test]
    async fn lost_response_retires_session_and_does_not_replay_input() {
        use crate::framing::{MAX_REPLY_BYTES, read_frame, write_frame};
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let (client, mut server) = tokio::io::duplex(4096);
        let seen = Arc::new(AtomicUsize::new(0));
        let server_seen = seen.clone();
        let server_task = tokio::spawn(async move {
            let bytes = read_frame(&mut server, crate::policy::MAX_REQUEST_BYTES)
                .await
                .unwrap();
            let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let response = serde_json::json!({"protocolVersion":1,"requestId":request["requestId"],
                "result":{"lease":{"id":uuid::Uuid::new_v4().to_string(),"generation":1}}});
            write_frame(
                &mut server,
                &serde_json::to_vec(&response).unwrap(),
                MAX_REPLY_BYTES,
            )
            .await
            .unwrap();
            let _ = read_frame(&mut server, crate::policy::MAX_REQUEST_BYTES)
                .await
                .unwrap();
            server_seen.fetch_add(1, Ordering::SeqCst);
            // The input may already have occurred; lose its reply deliberately.
        });
        let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
            .await
            .unwrap();
        assert!(
            session
                .call("Click", serde_json::json!({}), Duration::from_secs(1))
                .await
                .is_err()
        );
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::StopFailed
        );
        assert_eq!(
            session
                .call("Click", serde_json::json!({}), Duration::from_secs(1))
                .await,
            Err(ClientError::Disconnected)
        );
        server_task.await.unwrap();
        assert_eq!(seen.load(Ordering::SeqCst), 1);
    }
}
