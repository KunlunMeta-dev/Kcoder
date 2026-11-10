//! Bounded private responses on the original ACP-parent connection.
use anyhow::{Context, Result, ensure};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_types::integrations::core::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const PREFIX: &str = "native-receiver-control-";

pub(super) struct ControlClient {
    outgoing: tokio::sync::mpsc::Sender<Value>,
    namespace: String,
    pending: Mutex<BTreeMap<String, mpsc::SyncSender<Value>>>,
    issued: Mutex<BTreeSet<String>>,
    closed: AtomicBool,
}

impl ControlClient {
    pub(super) fn new(outgoing: tokio::sync::mpsc::Sender<Value>) -> Self {
        Self {
            outgoing,
            namespace: format!("{PREFIX}{}-", uuid::Uuid::new_v4().simple()),
            pending: Mutex::default(),
            issued: Mutex::default(),
            closed: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    pub(super) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    pub(super) fn route_response(&self, frame: &Value) -> bool {
        let Some(id) = frame["id"].as_str().filter(|id| id.starts_with(PREFIX)) else {
            return false;
        };
        if frame.get("method").is_none()
            && id.starts_with(&self.namespace)
            && let Some(waiting) = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(id)
        {
            let _ = waiting.try_send(frame.clone());
        }
        true
    }

    /// No retry or new identity is manufactured after timeout. A lost response
    /// retains the Source reservation and must be reconciled by its original ID.
    pub(super) fn request(
        &self,
        control: &NativeRemoteControlFrameV1,
        deadline: Instant,
        check_owner: impl Fn() -> Result<()>,
    ) -> Result<NativeRemoteControlReplyV1> {
        control.validate_shape().map_err(anyhow::Error::msg)?;
        check_owner()?;
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "REMOTE_RECEIVER_CONTROL_CLOSED"
        );
        let id = format!("{}{}", self.namespace, control.request_id);
        {
            let mut issued = self
                .issued
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_CONTROL_UNAVAILABLE"))?;
            ensure!(
                issued.len() < 4096 && issued.insert(id.clone()),
                "REMOTE_RECEIVER_CONTROL_RECONCILE_ORIGINAL"
            );
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_CONTROL_UNAVAILABLE"))?;
            ensure!(
                pending.len() < 8 && !pending.contains_key(&id),
                "REMOTE_RECEIVER_CONTROL_CAPACITY"
            );
            pending.insert(id.clone(), sender);
        }
        let result = (|| -> Result<NativeRemoteControlReplyV1> {
            self.outgoing.try_send(json!({"jsonrpc":"2.0","id":id,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":control}))
                .map_err(|_| anyhow::anyhow!("REMOTE_RECEIVER_CONTROL_OUTCOME_UNKNOWN"))?;
            let wait = || -> Result<Value> {
                loop {
                    check_owner()?;
                    ensure!(
                        !self.closed.load(Ordering::Acquire),
                        "REMOTE_RECEIVER_CONTROL_CLOSED"
                    );
                    let remaining = deadline
                        .checked_duration_since(Instant::now())
                        .context("REMOTE_RECEIVER_CONTROL_DEADLINE")?;
                    match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
                        Ok(reply) => break Ok(reply),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => anyhow::bail!("REMOTE_RECEIVER_CONTROL_OUTCOME_UNKNOWN"),
                    }
                }
            };
            let reply = match tokio::runtime::Handle::try_current() {
                Ok(handle)
                    if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread =>
                {
                    tokio::task::block_in_place(wait)
                }
                Ok(_) => Err(anyhow::anyhow!(
                    "REMOTE_RECEIVER_CONTROL_RUNTIME_UNSUPPORTED"
                )),
                Err(_) => wait(),
            }?;
            check_owner()?;
            ensure!(
                reply["jsonrpc"] == "2.0" && reply.get("error").is_none(),
                "REMOTE_RECEIVER_CONTROL_REJECTED"
            );
            let reply: NativeRemoteControlReplyV1 = rpc_codec::decode(reply["result"].clone())?;
            ensure!(
                reply.version == control.version
                    && reply.operation_id == control.operation_id
                    && reply.request_id == control.request_id
                    && reply.endpoint_revision == control.endpoint_revision
                    && reply.endpoint_instance_id == control.endpoint_instance_id
                    && reply.state == NativeRemoteReceiptStateV1::Received,
                "REMOTE_RECEIVER_CONTROL_RECEIPT_CHANGED"
            );
            Ok(reply)
        })();
        self.pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn control() -> NativeRemoteControlFrameV1 {
        serde_json::from_value(json!({"version":1,"operationId":"owned-operation","requestId":"original-read",
            "endpointRevision":"owned-revision","endpointInstanceId":"owned-endpoint","sourceAcceptedSha256":"a".repeat(64),
            "message":{"method":"observe_original"}})).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn synchronous_provider_callback_yields_the_only_async_worker_for_its_original_reply() {
        let (outgoing, mut incoming) = tokio::sync::mpsc::channel(8);
        let client = Arc::new(ControlClient::new(outgoing));
        let responder = client.clone();
        let response = tokio::spawn(async move {
            let request = incoming.recv().await.unwrap();
            let control: NativeRemoteControlFrameV1 =
                serde_json::from_value(request["params"].clone()).unwrap();
            responder.route_response(&json!({"jsonrpc":"2.0","id":request["id"],"result":NativeRemoteControlReplyV1 {
                version:control.version,operation_id:control.operation_id,request_id:control.request_id,
                endpoint_revision:control.endpoint_revision,endpoint_instance_id:control.endpoint_instance_id,
                state:NativeRemoteReceiptStateV1::Received,data:NativeRemoteReceiptDataV1::Diagnostic{code:"OWNED_REPLY".into()}
            }}));
        });
        let caller = client.clone();
        let job = tokio::spawn(async move {
            caller.request(&control(), Instant::now() + Duration::from_secs(2), || {
                Ok(())
            })
        });
        assert!(job.await.unwrap().is_ok());
        response.await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_the_original_response_settles_and_an_issued_request_cannot_replay() {
        let (outgoing, mut incoming) = tokio::sync::mpsc::channel(8);
        let client = Arc::new(ControlClient::new(outgoing));
        let caller = client.clone();
        let original = control();
        let request = original.clone();
        let job = tokio::task::spawn_blocking(move || {
            caller.request(&request, Instant::now() + Duration::from_secs(2), || Ok(()))
        });
        let sent = incoming.recv().await.unwrap();
        assert!(client.route_response(
            &json!({"jsonrpc":"2.0","id":"native-receiver-control-old-1","result":{}})
        ));
        assert!(!job.is_finished());
        let receipt = NativeRemoteControlReplyV1 {
            version: original.version,
            operation_id: original.operation_id.clone(),
            request_id: original.request_id.clone(),
            endpoint_revision: original.endpoint_revision.clone(),
            endpoint_instance_id: original.endpoint_instance_id.clone(),
            state: NativeRemoteReceiptStateV1::Received,
            data: NativeRemoteReceiptDataV1::Diagnostic {
                code: "OWNED_OBSERVATION".into(),
            },
        };
        client.route_response(&json!({"jsonrpc":"2.0","id":sent["id"],"result":receipt}));
        assert!(job.await.unwrap().is_ok());
        assert!(
            client
                .request(
                    &original,
                    Instant::now() + Duration::from_secs(1),
                    || Ok(())
                )
                .is_err()
        );
        assert!(incoming.try_recv().is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn closing_the_owner_settles_pending_calls_and_late_replies_stay_private() {
        let (outgoing, mut incoming) = tokio::sync::mpsc::channel(8);
        let client = Arc::new(ControlClient::new(outgoing));
        let caller = client.clone();
        let job = tokio::task::spawn_blocking(move || {
            caller.request(&control(), Instant::now() + Duration::from_secs(30), || {
                Ok(())
            })
        });
        let sent = incoming.recv().await.unwrap();
        client.close();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), job)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(client.route_response(&json!({"jsonrpc":"2.0","id":sent["id"],"result":{}})));
        assert!(client.pending.lock().unwrap().is_empty());
    }
}
