//! Authenticated broker stream service. The Windows pipe acceptor must verify
//! peer identity and consume a host-issued grant before entering this module.
use crate::{
    admission::AuthorizedConnection,
    broker::{BrokerError, DesktopBroker},
    framing::{MAX_REPLY_BYTES, read_frame, write_frame},
    policy::{MAX_REQUEST_BYTES, decode_request},
};
use anyhow::{Result, anyhow, ensure};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::mpsc,
    task::JoinSet,
};

struct ReaderTask(tokio::task::JoinHandle<()>);
impl Drop for ReaderTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Cleanup {
    broker: Arc<DesktopBroker>,
    owner: kcoder_types::computer_use::DesktopOwner,
    armed: bool,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.armed {
            let broker = self.broker.clone();
            let owner = self.owner.clone();
            // Normal exit awaits cleanup; this protects service task abortion.
            tokio::spawn(async move {
                let _ = broker.disconnect_owner(&owner).await;
            });
        }
    }
}

pub async fn serve_authenticated<S>(
    stream: S,
    identity: AuthorizedConnection,
    broker: Arc<DesktopBroker>,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    serve_authenticated_until(stream, identity, broker, std::future::pending()).await
}

/// The native acceptor supplies an OS process-lifetime signal independently of
/// pipe EOF. An inherited/duplicated pipe must not prolong a dead owner's lease.
pub(crate) async fn serve_authenticated_until<S, F>(
    stream: S,
    mut identity: AuthorizedConnection,
    broker: Arc<DesktopBroker>,
    owner_gone: F,
) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: std::future::Future<Output = ()>,
{
    tokio::pin!(owner_gone);
    let mut cleanup = Cleanup {
        broker: broker.clone(),
        owner: identity.owner().clone(),
        armed: true,
    };
    let (mut read, mut write) = tokio::io::split(stream);
    let (sender, mut frames) = mpsc::channel(4);
    // Dedicated reader preserves a partially read length/frame when a completion
    // wins the select below. read_exact must not be repeatedly cancelled.
    let mut reader = ReaderTask(tokio::spawn(async move {
        loop {
            let frame = read_frame(&mut read, MAX_REQUEST_BYTES).await;
            let failed = frame.is_err();
            if sender.send(frame).await.is_err() || failed {
                break;
            }
        }
    }));
    let mut work = JoinSet::new();
    let result:Result<()>=async{
        loop{
            tokio::select!{
                biased;
                _ = &mut owner_gone => return Err(anyhow!("desktop owner process exited or became unverifiable")),
                frame=frames.recv()=>{
                    let frame=frame.ok_or_else(||anyhow!("desktop connection closed"))??;
                    let request=decode_request(&frame).map_err(|error|anyhow!(error))?;
                    identity.validate(&request).map_err(|_|anyhow!("desktop request identity/replay rejected"))?;
                    ensure!(work.len()<8,"too many outstanding desktop requests");
                    let broker=broker.clone();let id=request.request_id;
                    work.spawn(async move{(id,broker.dispatch_validated(request).await)});
                }
                reply=work.join_next(),if !work.is_empty()=>{
                    let (id,result)=reply.unwrap()?;
                    let mut reply=match result {
                        Ok(result)=>json!({"requestId":id,"result":result}),
                        Err(BrokerError::Worker(crate::worker::WorkerError::Execution { detail, cleanup_confirmed })) =>
                            json!({"requestId":id,"error":{"code":"tool_execution_failed","detail":detail,"cleanupConfirmed":cleanup_confirmed}}),
                        Err(error)=>json!({"requestId":id,"error":{"code":error_code(&error)}}),
                    };
                    let mut bytes=serde_json::to_vec(&reply)?;
                    if bytes.len()>MAX_REPLY_BYTES {
                        reply=json!({"requestId":id,"error":{"code":"result_too_large"}});
                        bytes=serde_json::to_vec(&reply)?;
                    }
                    tokio::time::timeout(Duration::from_secs(5),write_frame(&mut write,&bytes,MAX_REPLY_BYTES)).await??;
                }
            }
        }
    }.await;
    reader.0.abort();
    let _ = (&mut reader.0).await;
    work.abort_all();
    while work.join_next().await.is_some() {}
    let stopped = broker.disconnect(&identity).await;
    cleanup.armed = false;
    stopped.map_err(|_| anyhow!("desktop cleanup was not confirmed"))?;
    result
}
fn error_code(error: &BrokerError) -> &'static str {
    use crate::worker::WorkerError;
    use kcoder_types::computer_use::DesktopControlError;
    match error {
        BrokerError::InvalidRequest(_) => "invalid_request",
        BrokerError::Unauthorized => "unauthorized",
        BrokerError::Control(DesktopControlError::DesktopBusy) => "desktop_busy",
        BrokerError::Control(DesktopControlError::DesktopUnavailable) => "desktop_unavailable",
        BrokerError::Control(DesktopControlError::OperationBusy) => "operation_busy",
        BrokerError::Control(_) => "lease_revoked",
        BrokerError::Worker(WorkerError::Timeout) => "operation_timeout",
        BrokerError::Worker(WorkerError::CleanupFailed(_)) => "cleanup_failed",
        BrokerError::Worker(WorkerError::Busy) => "operation_busy",
        BrokerError::Worker(WorkerError::Stopped) => "lease_revoked",
        BrokerError::Worker(WorkerError::Unavailable(code)) => match *code {
            "desktop_locked" => "desktop_locked",
            "desktop_unavailable" => "desktop_lost",
            "worker_exited" => "worker_exited",
            "input_observer_unavailable" => "input_observer_unavailable",
            "recovery_process_exited" => "recovery_process_exited",
            _ => "worker_failed",
        },
        BrokerError::Worker(_) => "worker_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        admission::Admissions,
        worker::{DesktopWorker, WorkerError, WorkerHandle},
    };
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Fixture(Arc<AtomicBool>);
    #[async_trait::async_trait]
    impl DesktopWorker for Fixture {
        async fn call(&mut self, _: &str, _: Value) -> std::result::Result<Value, WorkerError> {
            std::future::pending().await
        }
        async fn shutdown(&mut self) -> std::result::Result<(), WorkerError> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
    }
    struct DiagnosticFailure {
        cleanup_ok: bool,
    }
    #[async_trait::async_trait]
    impl DesktopWorker for DiagnosticFailure {
        async fn call(&mut self, _: &str, _: Value) -> std::result::Result<Value, WorkerError> {
            Ok(
                json!({"isError":true,"content":[{"type":"text","text":"Windows rejected input: test diagnostic"}]}),
            )
        }
        async fn shutdown(&mut self) -> std::result::Result<(), WorkerError> {
            if self.cleanup_ok {
                Ok(())
            } else {
                Err(WorkerError::CleanupFailed("test failure".into()))
            }
        }
    }
    #[tokio::test]
    async fn input_error_diagnostic_and_cleanup_state_reach_session_over_authenticated_stream() {
        use crate::{
            client::{ClientError, DesktopClient},
            session::DesktopSession,
        };
        use kcoder_types::computer_use::{DesktopOwner, DesktopSessionState};
        for cleanup_ok in [true, false] {
            let owner = DesktopOwner {
                client_instance: "c".into(),
                thread_id: "t".into(),
                turn_id: "r".into(),
            };
            let mut grants = Admissions::default();
            let (id, token) = grants.issue(1, 3, owner.clone()).unwrap();
            let identity = grants
                .consume(&id, token.expose_for_bootstrap(), 1, 3)
                .unwrap();
            let broker = DesktopBroker::new(
                WorkerHandle::spawn(DiagnosticFailure { cleanup_ok }, Duration::from_secs(1)),
                3,
            )
            .unwrap();
            let (client, server) = tokio::io::duplex(8192);
            let serving = tokio::spawn(serve_authenticated(server, identity, broker));
            let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
                .await
                .unwrap();
            let error = session
                .call("Click", json!({}), Duration::from_secs(1))
                .await
                .unwrap_err();
            assert_eq!(
                error,
                ClientError::Execution {
                    detail: "Windows rejected input: test diagnostic".into(),
                    cleanup_confirmed: cleanup_ok
                }
            );
            let model_error = crate::failure::operation_failure(&error);
            assert_eq!(model_error["cleanupConfirmed"], cleanup_ok);
            assert_eq!(model_error["automaticRetryAllowed"], false);
            assert!(
                model_error["detail"]
                    .as_str()
                    .unwrap()
                    .contains("Windows rejected input")
            );
            assert_eq!(
                *session.subscribe_state().borrow(),
                if cleanup_ok {
                    DesktopSessionState::Stopped
                } else {
                    DesktopSessionState::StopFailed
                }
            );
            drop(session);
            tokio::time::timeout(Duration::from_secs(1), serving)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err();
        }
    }

    struct TransportFailure;
    #[async_trait::async_trait]
    impl DesktopWorker for TransportFailure {
        async fn call(&mut self, _: &str, _: Value) -> std::result::Result<Value, WorkerError> {
            Err(WorkerError::Failed("transport-test".into()))
        }
        async fn shutdown(&mut self) -> std::result::Result<(), WorkerError> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn automatic_stop_then_turn_teardown_returns_existing_cleanup_receipt() {
        use crate::{
            client::{ClientError, DesktopClient},
            session::DesktopSession,
        };
        use kcoder_types::computer_use::{DesktopOwner, DesktopSessionState};
        let owner = DesktopOwner {
            client_instance: "c".into(),
            thread_id: "t".into(),
            turn_id: "r".into(),
        };
        let mut grants = Admissions::default();
        let (id, token) = grants.issue(1, 3, owner.clone()).unwrap();
        let identity = grants
            .consume(&id, token.expose_for_bootstrap(), 1, 3)
            .unwrap();
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(TransportFailure, Duration::from_secs(1)),
            3,
        )
        .unwrap();
        let (client, server) = tokio::io::duplex(8192);
        let serving = tokio::spawn(serve_authenticated(server, identity, broker));
        let session = DesktopSession::acquire(DesktopClient::from_authenticated(client), owner)
            .await
            .unwrap();
        assert_eq!(
            session
                .call("Click", json!({}), Duration::from_secs(1))
                .await,
            Err(ClientError::Remote("worker_failed".into()))
        );
        session.stop().await.unwrap();
        assert_eq!(
            *session.subscribe_state().borrow(),
            DesktopSessionState::Stopped
        );
        session.stop().await.unwrap();
        drop(session);
        tokio::time::timeout(Duration::from_secs(1), serving)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
    }

    #[tokio::test]
    async fn authenticated_stream_disconnect_reaps_lease() {
        let owner = kcoder_types::computer_use::DesktopOwner {
            client_instance: "c".into(),
            thread_id: "t".into(),
            turn_id: "r".into(),
        };
        let mut grants = Admissions::default();
        let (id, token) = grants.issue(1, 3, owner.clone()).unwrap();
        let identity = grants
            .consume(&id, token.expose_for_bootstrap(), 1, 3)
            .unwrap();
        let exited = Arc::new(AtomicBool::new(false));
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(Fixture(exited.clone()), Duration::from_secs(60)),
            3,
        )
        .unwrap();
        let (mut client, server) = tokio::io::duplex(4096);
        let task = tokio::spawn(serve_authenticated(server, identity, broker));
        let bytes=serde_json::to_vec(&json!({"protocolVersion":1,"requestId":1,"operation":{"type":"acquire","owner":owner}})).unwrap();
        write_frame(&mut client, &bytes, MAX_REQUEST_BYTES)
            .await
            .unwrap();
        let result: Value =
            serde_json::from_slice(&read_frame(&mut client, MAX_REPLY_BYTES).await.unwrap())
                .unwrap();
        assert!(result["result"]["lease"]["id"].is_string());
        drop(client);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(exited.load(Ordering::SeqCst));
    }
    #[tokio::test]
    async fn client_and_broker_roundtrip_then_drop_releases_worker() {
        use crate::client::DesktopClient;
        use kcoder_types::computer_use::{DesktopOperation, DesktopOwner};
        let owner = DesktopOwner {
            client_instance: "c".into(),
            thread_id: "t".into(),
            turn_id: "r".into(),
        };
        let mut grants = Admissions::default();
        let (id, token) = grants.issue(1, 3, owner.clone()).unwrap();
        let identity = grants
            .consume(&id, token.expose_for_bootstrap(), 1, 3)
            .unwrap();
        let exited = Arc::new(AtomicBool::new(false));
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(Fixture(exited.clone()), Duration::from_secs(60)),
            3,
        )
        .unwrap();
        let (client, server) = tokio::io::duplex(4096);
        let serving = tokio::spawn(serve_authenticated(server, identity, broker));
        let client = DesktopClient::from_authenticated(client);
        let acquired = client
            .request(
                DesktopOperation::Acquire {
                    owner: owner.clone(),
                },
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        let lease = serde_json::from_value(acquired["lease"].clone()).unwrap();
        let stopped = client
            .request(
                DesktopOperation::Stop { owner, lease },
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        assert_eq!(stopped["stopped"], true);
        assert!(exited.load(Ordering::SeqCst));
        drop(client);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), serving)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }

    #[tokio::test]
    async fn owner_exit_reaps_blocked_call_even_when_pipe_remains_open() {
        struct Tracked(Arc<tokio::sync::Notify>, Arc<AtomicBool>);
        #[async_trait::async_trait]
        impl DesktopWorker for Tracked {
            async fn call(&mut self, _: &str, _: Value) -> std::result::Result<Value, WorkerError> {
                self.0.notify_one();
                std::future::pending().await
            }
            async fn shutdown(&mut self) -> std::result::Result<(), WorkerError> {
                self.1.store(true, Ordering::SeqCst);
                Ok(())
            }
        }
        let owner = kcoder_types::computer_use::DesktopOwner {
            client_instance: "c".into(),
            thread_id: "t".into(),
            turn_id: "r".into(),
        };
        let mut grants = Admissions::default();
        let (id, token) = grants.issue(1, 3, owner.clone()).unwrap();
        let identity = grants
            .consume(&id, token.expose_for_bootstrap(), 1, 3)
            .unwrap();
        let cleaned = Arc::new(AtomicBool::new(false));
        let started = Arc::new(tokio::sync::Notify::new());
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(
                Tracked(started.clone(), cleaned.clone()),
                Duration::from_secs(60),
            ),
            3,
        )
        .unwrap();
        let (mut client, server) = tokio::io::duplex(4096);
        let (exit, exited) = tokio::sync::oneshot::channel::<()>();
        let serving = tokio::spawn(serve_authenticated_until(server, identity, broker, async {
            let _ = exited.await;
        }));
        let acquire = serde_json::to_vec(&json!({"protocolVersion":1,"requestId":1,
            "operation":{"type":"acquire","owner":owner}}))
        .unwrap();
        write_frame(&mut client, &acquire, MAX_REQUEST_BYTES)
            .await
            .unwrap();
        let reply: Value =
            serde_json::from_slice(&read_frame(&mut client, MAX_REPLY_BYTES).await.unwrap())
                .unwrap();
        let call = serde_json::to_vec(&json!({"protocolVersion":1,"requestId":2,
            "operation":{"type":"call","owner":owner,"lease":reply["result"]["lease"],
                "tool":"Type","arguments":{}}}))
        .unwrap();
        write_frame(&mut client, &call, MAX_REQUEST_BYTES)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), started.notified())
            .await
            .unwrap();
        exit.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), serving)
            .await
            .unwrap()
            .unwrap();
        assert!(result.unwrap_err().to_string().contains("owner process"));
        assert!(cleaned.load(Ordering::SeqCst));
        // The peer still owns its transport; OS lifetime, not EOF, caused cleanup.
        assert!(read_frame(&mut client, MAX_REPLY_BYTES).await.is_err());
    }
}
