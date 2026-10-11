//! Turn-bound client facade. The engine supplies trusted owner metadata once;
//! model arguments contain only the upstream tool arguments, never a lease.
use crate::client::{ClientError, DesktopClient};
use kcoder_types::computer_use::{
    DesktopLease, DesktopOperation, DesktopOwner, DesktopSessionState,
};
use serde_json::Value;
use std::{
    sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, watch};

/// Bounded metadata only; never includes arguments, window text or screenshots.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationDiagnostic {
    pub sequence: u64,
    pub tool: String,
    pub elapsed_ms: u64,
    pub failure_code: Option<String>,
    pub channel_available: bool,
    pub cleanup_confirmed: Option<bool>,
    pub host_pid: Option<u32>,
    pub worker_pid: Option<u32>,
}

pub struct DesktopSession {
    client: DesktopClient,
    owner: DesktopOwner,
    lease: DesktopLease,
    stopped: Mutex<bool>,
    lifecycle: watch::Sender<DesktopSessionState>,
    observation_required: AtomicBool,
    sequence: AtomicU64,
    host_pid: AtomicU32,
    worker_pid: AtomicU32,
    diagnostics: watch::Sender<Option<OperationDiagnostic>>,
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
            observation_required: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            host_pid: AtomicU32::new(0),
            worker_pid: AtomicU32::new(0),
            diagnostics: watch::channel(None).0,
        })
    }
    /// Mark a real host cleanup attempt pending before awaiting its receipt.
    pub fn begin_host_cleanup(&self) {
        self.lifecycle.send_if_modified(|state| {
            if *state != DesktopSessionState::Stopped && *state != DesktopSessionState::Stopping {
                *state = DesktopSessionState::Stopping;
                true
            } else {
                false
            }
        });
    }
    /// Only the trusted host may call after its own broker confirms worker,
    /// input and resource cleanup. IPC EOF or elapsed time is not such proof.
    pub async fn confirm_host_cleanup(&self) {
        *self.stopped.lock().await = true;
        self.lifecycle.send_replace(DesktopSessionState::Stopped);
    }
    pub fn owner(&self) -> &DesktopOwner {
        &self.owner
    }
    pub fn subscribe_state(&self) -> watch::Receiver<DesktopSessionState> {
        self.lifecycle.subscribe()
    }
    /// Host calls this before exposing a replacement lease to the model. It does
    /// not grant permission, create a worker or replay the previous operation.
    pub fn require_current_observation(&self) {
        self.observation_required.store(true, Ordering::SeqCst);
    }
    /// Process identity comes from the owned native host, never tool arguments.
    pub fn set_worker_identity(&self, host_pid: u32, worker_pid: u32) {
        self.host_pid.store(host_pid, Ordering::Relaxed);
        self.worker_pid.store(worker_pid, Ordering::Relaxed);
    }
    /// Trusted availability monitors retire the lease with a specific observed
    /// cause. They must still await host cleanup before confirming release.
    pub fn note_host_failure(&self, code: &str) {
        let code = match code {
            "desktop_locked"
            | "desktop_unavailable"
            | "input_observer_unavailable"
            | "recovery_process_exited"
            | "worker_exited"
            | "lease_revoked"
            | "cleanup_failed" => code,
            _ => "worker_failed",
        };
        self.lifecycle.send_if_modified(|state| {
            if matches!(
                *state,
                DesktopSessionState::Active | DesktopSessionState::Stopping
            ) {
                *state = DesktopSessionState::StopFailed;
                true
            } else {
                false
            }
        });
        self.record(
            "Host",
            Instant::now(),
            &Err(ClientError::Remote(code.into())),
        );
    }
    pub fn subscribe_diagnostics(&self) -> watch::Receiver<Option<OperationDiagnostic>> {
        self.diagnostics.subscribe()
    }
    fn record(&self, tool: &str, started: Instant, result: &Result<Value, ClientError>) {
        let failure = result.as_ref().err().map(crate::failure::operation_failure);
        let tool_error = result
            .as_ref()
            .ok()
            .is_some_and(|value| value["isError"] == true);
        self.diagnostics.send_replace(Some(OperationDiagnostic {
            sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
            tool: tool.into(),
            elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            failure_code: failure
                .as_ref()
                .and_then(|value| value["errorCode"].as_str())
                .map(str::to_owned)
                .or_else(|| tool_error.then(|| "recoverable_operation_error".into())),
            channel_available: *self.lifecycle.borrow() == DesktopSessionState::Active,
            host_pid: match self.host_pid.load(Ordering::Relaxed) {
                0 => None,
                pid => Some(pid),
            },
            worker_pid: match self.worker_pid.load(Ordering::Relaxed) {
                0 => None,
                pid => Some(pid),
            },
            cleanup_confirmed: match *self.lifecycle.borrow() {
                DesktopSessionState::Stopped => Some(true),
                DesktopSessionState::StopFailed => Some(false),
                _ => None,
            },
        }));
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
        let started = Instant::now();
        let observation = matches!(tool, "Snapshot" | "Screenshot" | "DisplayInventory");
        let full_observation = crate::policy::supplies_full_observation(tool, &arguments);
        if self.observation_required.load(Ordering::SeqCst) && !observation {
            let result = Err(ClientError::Remote("desktop_observation_required".into()));
            self.record(tool, started, &result);
            return result;
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
            && crate::failure::retires_lease(error)
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
        if let Ok(value) = &result {
            if value.get("isError").and_then(Value::as_bool) == Some(true) {
                self.require_current_observation();
            } else if full_observation && *self.lifecycle.borrow() == DesktopSessionState::Active {
                self.observation_required.store(false, Ordering::SeqCst);
            }
        }
        self.record(tool, started, &result);
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

    #[tokio::test]
    async fn recovered_turn_requires_successful_full_observation_without_replaying_input() {
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "recovered".into(),
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
                Duration::from_secs(1),
            ),
            3,
        )
        .unwrap();
        let (client, server) = tokio::io::duplex(4096);
        let serving = tokio::spawn(serve_authenticated(server, identity, broker));
        let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
            .await
            .unwrap();
        session.require_current_observation();
        for tool in ["Click", "Type", "Shortcut", "App"] {
            assert_eq!(
                session
                    .call(tool, serde_json::json!({}), Duration::from_secs(1))
                    .await,
                Err(ClientError::Remote("desktop_observation_required".into()))
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        session
            .call(
                "DisplayInventory",
                serde_json::json!({}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        session
            .call(
                "Screenshot",
                serde_json::json!({"region":[0,0,100,100]}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert!(
            session
                .call("Click", serde_json::json!({}), Duration::from_secs(1))
                .await
                .is_err()
        );
        session
            .call(
                "Snapshot",
                serde_json::json!({"use_vision":false,"use_ui_tree":false}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert!(
            session
                .call("Click", serde_json::json!({}), Duration::from_secs(1))
                .await
                .is_err()
        );
        session
            .call(
                "Snapshot",
                serde_json::json!({"use_vision":false}),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        session
            .call("Click", serde_json::json!({}), Duration::from_secs(1))
            .await
            .unwrap();
        let diagnostic = session.subscribe_diagnostics().borrow().clone().unwrap();
        assert_eq!(diagnostic.tool, "Click");
        assert_eq!(diagnostic.sequence, 11);
        assert_eq!(calls.load(Ordering::SeqCst), 5);
        cleanup.notify_one();
        session.stop().await.unwrap();
        drop(session);
        assert!(serving.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn host_cleanup_has_pending_failed_and_confirmed_receipts() {
        use crate::framing::{MAX_REPLY_BYTES, read_frame, write_frame};
        let (client, mut server) = tokio::io::duplex(4096);
        let peer = tokio::spawn(async move {
            let bytes = read_frame(&mut server, crate::policy::MAX_REQUEST_BYTES)
                .await
                .unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            write_frame(&mut server, &serde_json::to_vec(&serde_json::json!({"requestId":request["requestId"],"result":{"lease":{"id":uuid::Uuid::new_v4().to_string(),"generation":1}}})).unwrap(), MAX_REPLY_BYTES).await.unwrap();
        });
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
            .await
            .unwrap();
        session.begin_host_cleanup();
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::Stopping
        );
        session.note_host_failure("cleanup_failed");
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::StopFailed
        );
        assert_eq!(
            session
                .subscribe_diagnostics()
                .borrow()
                .as_ref()
                .unwrap()
                .failure_code
                .as_deref(),
            Some("cleanup_failed")
        );
        session.confirm_host_cleanup().await;
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::Stopped
        );
        session.begin_host_cleanup();
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::Stopped
        );
        peer.await.unwrap();
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
