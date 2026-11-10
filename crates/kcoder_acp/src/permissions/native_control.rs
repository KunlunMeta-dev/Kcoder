//! Private Native replies have a separate pending namespace, never permission outcomes.
use super::*;
use kcoder_types::integrations::core::{
    NATIVE_REMOTE_CONTROL_METHOD, NativeRemoteControlFrameV1, NativeRemoteControlReplyV1,
};

impl Permissions {
    pub(crate) async fn native_control(
        &self,
        frame: &NativeRemoteControlFrameV1,
        cancelled: &CancellationToken,
    ) -> Result<NativeRemoteControlReplyV1> {
        frame.validate_shape().map_err(anyhow::Error::msg)?;
        let id = format!(
            "native-control-{}",
            self.0.next.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .0
                .native_pending
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            ensure!(pending.len() < 16, "REMOTE_CONTROL_PENDING_CAPACITY");
            pending.insert(id.clone(), sender);
        }
        let _registration = NativeRegistration {
            state: self.clone(),
            id: id.clone(),
        };
        let wait = async {
            self.0.output.send(json!({"jsonrpc":"2.0","id":id,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":frame})).await?;
            let reply = receiver
                .await
                .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_SOURCE_REPLY_UNKNOWN"))?;
            ensure!(
                reply["jsonrpc"] == "2.0"
                    && reply.get("method").is_none()
                    && reply.get("error").is_none()
                    && reply.get("result").is_some()
                    && reply.as_object().is_some_and(|object| object
                        .keys()
                        .all(|key| ["jsonrpc", "id", "result"].contains(&key.as_str()))),
                "REMOTE_CONTROL_SOURCE_REPLY_INVALID"
            );
            let response: NativeRemoteControlReplyV1 =
                serde_json::from_value(reply["result"].clone())
                    .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_SOURCE_REPLY_INVALID"))?;
            ensure!(
                response.version == frame.version
                    && response.operation_id == frame.operation_id
                    && response.request_id == frame.request_id
                    && response.endpoint_revision == frame.endpoint_revision
                    && response.endpoint_instance_id == frame.endpoint_instance_id,
                "REMOTE_CONTROL_SOURCE_REPLY_MISMATCH"
            );
            Ok(response)
        };
        tokio::select! { biased;
            _ = cancelled.cancelled() => Err(anyhow::anyhow!("REMOTE_CONTROL_SOURCE_REPLY_UNKNOWN")),
            _ = self.0.closed.cancelled() => Err(anyhow::anyhow!("REMOTE_CONTROL_SOURCE_REPLY_UNKNOWN")),
            result = tokio::time::timeout(Duration::from_secs(30), wait) => result.map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_SOURCE_REPLY_UNKNOWN"))?,
        }
    }
}

struct NativeRegistration {
    state: Permissions,
    id: String,
}
impl Drop for NativeRegistration {
    fn drop(&mut self) {
        self.state
            .0
            .native_pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> NativeRemoteControlFrameV1 {
        serde_json::from_value(json!({"version":1,"operationId":"owned-operation","requestId":"owned-request","endpointRevision":"1","endpointInstanceId":"owned-endpoint","sourceAcceptedSha256":"a".repeat(64),"message":{"method":"observe_original"}})).unwrap()
    }
    fn reply(request: &Value, frame: &NativeRemoteControlFrameV1) -> Value {
        json!({"jsonrpc":"2.0","id":request["id"],"result":{"version":frame.version,"operationId":frame.operation_id,"requestId":frame.request_id,"endpointRevision":frame.endpoint_revision,"endpointInstanceId":frame.endpoint_instance_id,"state":"unavailable","data":{"kind":"diagnostic","code":"REMOTE_RECEIVER_EXECUTION_UNAVAILABLE"}}})
    }
    #[tokio::test]
    async fn private_reply_header_mismatch_cannot_settle_as_an_ordinary_permission() {
        let (out, mut incoming) = crate::queue::wire_queue();
        let state = Permissions::new(out);
        let pending = state.clone();
        let call = frame();
        let expected = call.clone();
        let task = tokio::spawn(async move {
            pending
                .native_control(&call, &CancellationToken::new())
                .await
        });
        let request: Value = serde_json::from_slice(&incoming.recv().await.unwrap().bytes).unwrap();
        assert!(
            request["id"]
                .as_str()
                .unwrap()
                .starts_with("native-control-")
        );
        let mut response = reply(&request, &expected);
        response["result"]["endpointInstanceId"] = json!("other-endpoint");
        state.receive(&response);
        assert!(task.await.unwrap().is_err());
        assert!(state.0.native_pending.lock().unwrap().is_empty());
        assert!(state.0.pending.lock().unwrap().is_empty());
    }
    #[tokio::test(start_paused = true)]
    async fn cancellation_timeout_close_and_late_native_replies_drop_only_original_pending() {
        for mode in ["cancel", "timeout", "close"] {
            let (out, mut incoming) = crate::queue::wire_queue();
            let state = Permissions::new(out);
            let pending = state.clone();
            let call = frame();
            let expected = call.clone();
            let cancel = CancellationToken::new();
            let owner = cancel.clone();
            let task = tokio::spawn(async move { pending.native_control(&call, &owner).await });
            let request: Value =
                serde_json::from_slice(&incoming.recv().await.unwrap().bytes).unwrap();
            match mode {
                "cancel" => cancel.cancel(),
                "close" => state.close(),
                _ => tokio::time::advance(Duration::from_secs(31)).await,
            }
            assert!(task.await.unwrap().is_err());
            state.receive(&reply(&request, &expected));
            assert!(state.0.native_pending.lock().unwrap().is_empty());
            assert!(state.0.pending.lock().unwrap().is_empty());
        }
    }
}
