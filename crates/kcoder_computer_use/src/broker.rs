//! Per-worker broker coordinator. Host authenticates the pipe, consumes a grant,
//! and supplies the prepared worker. No state mutex is held across worker I/O.
use crate::{
    DesktopControl,
    admission::AuthorizedConnection,
    policy::decode_request,
    worker::{WorkerError, WorkerHandle},
};
use kcoder_types::computer_use::{
    DesktopControlError, DesktopControlState, DesktopLease, DesktopOperation, DesktopOwner,
};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Debug)]
pub enum BrokerError {
    InvalidRequest(&'static str),
    Unauthorized,
    Control(DesktopControlError),
    Worker(WorkerError),
}
impl From<DesktopControlError> for BrokerError {
    fn from(error: DesktopControlError) -> Self {
        Self::Control(error)
    }
}

pub struct DesktopBroker {
    control: Mutex<DesktopControl>,
    worker: WorkerHandle,
    session_id: u32,
}
impl DesktopBroker {
    /// Host must have finished runtime/desktop preflight before providing worker.
    pub fn new(worker: WorkerHandle, session_id: u32) -> Result<Arc<Self>, BrokerError> {
        if session_id == 0 {
            return Err(BrokerError::Control(
                DesktopControlError::DesktopUnavailable,
            ));
        }
        let mut control = DesktopControl::default();
        control.ready_after_preflight()?;
        Ok(Arc::new(Self {
            control: Mutex::new(control),
            worker,
            session_id,
        }))
    }
    /// Authenticate/decode synchronously under a short connection lock, then
    /// release that lock before awaiting the operation. Stop can use this same
    /// connection while a call is outstanding, without being trapped behind I/O.
    pub async fn dispatch(
        &self,
        connection: &Mutex<AuthorizedConnection>,
        bytes: &[u8],
    ) -> Result<Value, BrokerError> {
        let request = decode_request(bytes).map_err(BrokerError::InvalidRequest)?;
        connection
            .lock()
            .await
            .validate(&request)
            .map_err(|_| BrokerError::Unauthorized)?;
        self.dispatch_validated(request).await
    }
    /// Only the authenticated connection service may call this after ordered
    /// validation. Never expose it directly to model arguments or raw IPC.
    pub(crate) async fn dispatch_validated(
        &self,
        request: kcoder_types::computer_use::DesktopRequest,
    ) -> Result<Value, BrokerError> {
        match request.operation {
            DesktopOperation::Status => Ok(
                json!({"state":self.control.lock().await.state(),"windowsSessionId":self.session_id}),
            ),
            DesktopOperation::Acquire { owner } => {
                let lease = self.control.lock().await.acquire_authorized(owner)?;
                Ok(json!({"lease":lease}))
            }
            DesktopOperation::Stop { owner, lease } => {
                self.stop(&owner, &lease).await?;
                Ok(json!({"stopped":true}))
            }
            DesktopOperation::Call {
                owner,
                lease,
                tool,
                arguments,
            } => {
                self.control
                    .lock()
                    .await
                    .begin_action(&owner, &lease, request.request_id)?;
                let result = self.worker.call(&tool, arguments).await;
                let accepted =
                    self.control
                        .lock()
                        .await
                        .finish_action(&owner, &lease, request.request_id);
                match result {
                    Ok(value) if matches!(accepted, Ok(true)) => Ok(value),
                    Ok(_) => Err(BrokerError::Control(DesktopControlError::LeaseRevoked)),
                    Err(error) => {
                        // A stop from a parallel request may already have reaped
                        // this lease. Never let its late result alter a new owner.
                        if let WorkerError::Execution { detail, .. } = error {
                            let cleanup_confirmed = self.stop(&owner, &lease).await.is_ok();
                            return Err(BrokerError::Worker(WorkerError::Execution {
                                detail,
                                cleanup_confirmed,
                            }));
                        }
                        if accepted.is_ok() {
                            self.stop(&owner, &lease).await?;
                        }
                        Err(BrokerError::Worker(error))
                    }
                }
            }
        }
    }
    pub async fn stop(
        &self,
        owner: &DesktopOwner,
        lease: &DesktopLease,
    ) -> Result<(), BrokerError> {
        self.control.lock().await.request_stop(owner, lease)?;
        self.worker.stop().await.map_err(BrokerError::Worker)?;
        let mut control = self.control.lock().await;
        // Two stop requests may share the same cleanup receipt. Only the first
        // owns the transition; there is no worker replacement inside this object.
        if control.state() != DesktopControlState::Unavailable {
            control.confirm_worker_stopped(lease)?;
        }
        Ok(())
    }
    /// Connection drop must invoke this even if its dispatch future was aborted.
    pub async fn disconnect(&self, connection: &AuthorizedConnection) -> Result<(), BrokerError> {
        self.disconnect_owner(connection.owner()).await
    }
    /// Trusted local host cleanup; exact owner is checked against the existing
    /// lease. A transport failure alone is never a worker cleanup receipt.
    pub async fn disconnect_owner(&self, owner: &DesktopOwner) -> Result<(), BrokerError> {
        let lease = self.control.lock().await.lease_for_owner(owner);
        if let Some(lease) = lease {
            self.stop(owner, &lease).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{admission::Admissions, worker::DesktopWorker};
    use std::time::Duration;
    struct Hanging(Arc<tokio::sync::Notify>);
    #[async_trait::async_trait]
    impl DesktopWorker for Hanging {
        async fn call(&mut self, _: &str, _: Value) -> Result<Value, WorkerError> {
            self.0.notify_one();
            std::future::pending().await
        }
        async fn shutdown(&mut self) -> Result<(), WorkerError> {
            Ok(())
        }
    }
    fn authorized_connection(owner: DesktopOwner) -> Mutex<AuthorizedConnection> {
        let mut grants = Admissions::default();
        let (id, secret) = grants.issue(42, 3, owner).unwrap();
        Mutex::new(
            grants
                .consume(&id, secret.expose_for_bootstrap(), 42, 3)
                .unwrap(),
        )
    }
    fn frame(id: u64, operation: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({"protocolVersion":1,"requestId":id,"operation":operation}))
            .unwrap()
    }
    #[tokio::test]
    async fn authenticated_stop_interrupts_call_on_same_connection_and_retires_worker() {
        let started = Arc::new(tokio::sync::Notify::new());
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(Hanging(started.clone()), Duration::from_secs(60)),
            3,
        )
        .unwrap();
        let owner = DesktopOwner {
            client_instance: "client".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        };
        let connection = Arc::new(authorized_connection(owner.clone()));
        let acquired = broker
            .dispatch(
                &connection,
                &frame(1, json!({"type":"acquire","owner":owner})),
            )
            .await
            .unwrap();
        let lease = acquired["lease"].clone();
        let mut unrelated = owner.clone();
        unrelated.turn_id = "another-turn".into();
        let unrelated = authorized_connection(unrelated).into_inner();
        broker.disconnect(&unrelated).await.unwrap();
        assert_eq!(
            broker.control.lock().await.state(),
            DesktopControlState::Active
        );
        let call = tokio::spawn({
            let broker = broker.clone();
            let connection = connection.clone();
            let owner = owner.clone();
            let lease = lease.clone();
            async move {
                broker.dispatch(&connection,&frame(2,json!({"type":"call","owner":owner,"lease":lease,"tool":"Screenshot","arguments":{}}))).await
            }
        });
        started.notified().await;
        let stopped = tokio::time::timeout(
            Duration::from_secs(1),
            broker.dispatch(
                &connection,
                &frame(3, json!({"type":"stop","owner":owner,"lease":lease})),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stopped["stopped"], true);
        assert!(call.await.unwrap().is_err());
        // Foreground turn teardown repeats stop after an earlier automatic stop.
        let completed_lease: DesktopLease = serde_json::from_value(lease.clone()).unwrap();
        broker.stop(&owner, &completed_lease).await.unwrap();
        broker.stop(&owner, &completed_lease).await.unwrap();
        assert_eq!(
            broker.control.lock().await.state(),
            DesktopControlState::Unavailable
        );
        assert!(
            broker
                .dispatch(
                    &connection,
                    &frame(4, json!({"type":"acquire","owner":owner}))
                )
                .await
                .is_err()
        );
    }
}
