//! Drive private Receiver callbacks even while turn/start is awaiting its receipt.
use super::*;
use crate::queue::WireSender;
use serde_json::json;
use std::collections::BTreeMap;
use tokio::task::{JoinHandle, JoinSet};

pub(super) struct NativeBridge {
    stop: CancellationToken,
    worker: JoinHandle<()>,
}
impl Drop for NativeBridge {
    fn drop(&mut self) {
        self.stop.cancel();
        self.worker.abort();
    }
}

impl NativeBridge {
    pub(super) fn install(
        upstream: &mut Upstream,
        original: NativeRemoteControlFrameV1,
        source: Permissions,
        native_owner: std::sync::Arc<super::close::OwnerState>,
    ) -> Self {
        let (mut incoming, replies, closed) = upstream.native_bridge_parts();
        let (ordinary, events) = tokio::sync::mpsc::channel(256);
        upstream.events = events;
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let worker = tokio::spawn(async move {
            let mut jobs = JoinSet::<(String, Option<Value>)>::new();
            let mut seen = BTreeMap::<String, (String, Option<Value>)>::new();
            let mut cached = 0usize;
            loop {
                let next = tokio::select! { biased;
                    _ = cancelled.cancelled() => break,
                    _ = closed.cancelled() => break,
                    result = jobs.join_next(), if !jobs.is_empty() => {
                        if let Some(Ok((id, response))) = result
                            && let Some((_, retained)) = seen.get_mut(&id) {
                                let bytes = response.as_ref().and_then(|r|serde_json::to_vec(r).ok()).map_or(0,|r|r.len());
                                if cached.saturating_add(bytes) <= crate::queue::QUEUE_BYTES {
                                    cached += bytes; *retained = response;
                                }
                        }
                        continue;
                    }
                    frame = incoming.recv() => match frame { Some(frame) => frame, None => break },
                };
                let Ok(frame) = serde_json::from_slice::<Value>(&next.bytes) else {
                    closed.cancel();
                    break;
                };
                if frame["method"] != NATIVE_REMOTE_CONTROL_METHOD {
                    // Retain the original byte permit. A stalled ordinary event
                    // consumer cannot indefinitely block the private control pump.
                    if ordinary.try_send(next).is_err() {
                        closed.cancel();
                        break;
                    }
                    continue;
                }
                let parsed =
                    serde_json::from_value::<NativeRemoteControlFrameV1>(frame["params"].clone());
                let call = match parsed {
                    Ok(call)
                        if valid_callback(&original, &call)
                            && frame["id"].as_str().is_some_and(|id| {
                                id.starts_with("native-receiver-control-")
                                    && id.ends_with(&format!("-{}", call.request_id))
                                    && id.len() <= 768
                            }) =>
                    {
                        call
                    }
                    _ => {
                        let _ =
                            send_error(&replies, &frame["id"], "REMOTE_CONTROL_BINDING_MISMATCH")
                                .await;
                        closed.cancel();
                        break;
                    }
                };
                if let NativeRemoteControlDataV1::ReceiverAccepted(actual) = &call.message
                    && native_owner.observe_accepted(actual).is_err()
                {
                    closed.cancel();
                    break;
                }
                let digest = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&call).unwrap_or_default())
                );
                if let Some((previous, response)) = seen.get(&call.request_id) {
                    if previous != &digest {
                        let _ =
                            send_error(&replies, &frame["id"], "REMOTE_CONTROL_REQUEST_ID_REUSED")
                                .await;
                        closed.cancel();
                        break;
                    }
                    let response = response.clone().unwrap_or_else(|| unknown(&call));
                    if replies
                        .send(json!({"jsonrpc":"2.0","id":frame["id"],"result":response}))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
                if jobs.len() >= 16 || seen.len() >= 4096 {
                    let _ =
                        send_error(&replies, &frame["id"], "REMOTE_CONTROL_PENDING_CAPACITY").await;
                    continue;
                }
                seen.insert(call.request_id.clone(), (digest, None));
                let source = source.clone();
                let replies = replies.clone();
                let owner = closed.clone();
                jobs.spawn(async move {
                    let id = call.request_id.clone();
                    let response = match source.native_control(&call, &owner).await {
                        Ok(reply) => serde_json::to_value(reply).unwrap_or_else(|_| unknown(&call)),
                        Err(_) => unknown(&call),
                    };
                    let delivered = replies
                        .send(json!({"jsonrpc":"2.0","id":frame["id"],"result":response}))
                        .await
                        .is_ok();
                    (id, delivered.then_some(response))
                });
            }
        });
        Self { stop, worker }
    }
}

fn valid_callback(
    original: &NativeRemoteControlFrameV1,
    call: &NativeRemoteControlFrameV1,
) -> bool {
    call.validate_shape().is_ok()
        && call.version == original.version
        && call.operation_id == original.operation_id
        && call.endpoint_revision == original.endpoint_revision
        && call.endpoint_instance_id == original.endpoint_instance_id
        && call.source_accepted_sha256 == original.source_accepted_sha256
        && !matches!(
            call.message,
            NativeRemoteControlDataV1::BindOriginal(_)
                | NativeRemoteControlDataV1::CloseOriginal(_)
        )
}
async fn send_error(sender: &WireSender, id: &Value, code: &'static str) -> Result<()> {
    sender
        .send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32086,"message":code}}))
        .await
}
fn unknown(call: &NativeRemoteControlFrameV1) -> Value {
    serde_json::to_value(NativeRemoteControlReplyV1 {
        version: call.version,
        operation_id: call.operation_id.clone(),
        request_id: call.request_id.clone(),
        endpoint_revision: call.endpoint_revision.clone(),
        endpoint_instance_id: call.endpoint_instance_id.clone(),
        state: NativeRemoteReceiptStateV1::OutcomeUnknown,
        data: NativeRemoteReceiptDataV1::Diagnostic {
            code: "REMOTE_CONTROL_SOURCE_REPLY_UNKNOWN".into(),
        },
    })
    .expect("closed private reply")
}
