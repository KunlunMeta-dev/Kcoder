//! Direction-scoped permission requests. A reply can authorize only its live owner.
use crate::queue::WireSender;
use agent_client_protocol::schema::v1::{
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
};
use anyhow::{Result, ensure};
use kcoder_app_protocol::ApprovalDecision;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
mod native_control;

#[derive(Clone)]
pub(crate) struct Permissions(Arc<State>);
struct State {
    output: WireSender,
    pending: Mutex<BTreeMap<String, oneshot::Sender<Value>>>,
    native_pending: Mutex<BTreeMap<String, oneshot::Sender<Value>>>,
    next: AtomicU64,
    closed: CancellationToken,
    timeout: Duration,
}

impl Permissions {
    pub(crate) fn new(output: WireSender) -> Self {
        Self(Arc::new(State {
            output,
            pending: Mutex::default(),
            native_pending: Mutex::default(),
            next: AtomicU64::new(1),
            closed: CancellationToken::new(),
            timeout: Duration::from_secs(300),
        }))
    }

    pub(crate) fn close(&self) {
        self.0.closed.cancel();
        self.0
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.0
            .native_pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    pub(crate) fn receive(&self, reply: &Value) {
        if let Some(id) = reply["id"]
            .as_str()
            .filter(|id| id.starts_with("native-control-"))
        {
            if let Some(sender) = self
                .0
                .native_pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(id)
            {
                let _ = sender.send(reply.clone());
            }
            return;
        }
        if let Some(id) = reply["id"].as_str()
            && let Some(sender) = self
                .0
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(id)
        {
            let _ = sender.send(reply.clone());
        }
    }

    pub(crate) async fn request(
        &self,
        params: RequestPermissionRequest,
        cancelled: &CancellationToken,
    ) -> Result<ApprovalDecision> {
        let id = format!("permission-{}", self.0.next.fetch_add(1, Ordering::Relaxed));
        let session = params.session_id.to_string();
        let offered = params
            .options
            .iter()
            .map(|option| option.option_id.to_string())
            .collect::<std::collections::BTreeSet<_>>();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.0.pending.lock().unwrap_or_else(|p| p.into_inner());
            ensure!(
                pending.len() < 16,
                "ACP permission capacity reached; request refused"
            );
            pending.insert(id.clone(), sender);
        }
        let _registration = Registration {
            state: self.clone(),
            id: id.clone(),
        };
        let wait = async {
            self.0.output.send(json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":params})).await?;
            let reply = receiver
                .await
                .map_err(|_| anyhow::anyhow!("Permission request closed without a decision"))?;
            ensure!(
                reply.get("error").is_none(),
                "Permission client returned an error; operation refused"
            );
            let result = reply.get("result").ok_or_else(|| {
                anyhow::anyhow!("Permission result is missing; operation refused")
            })?;
            ensure!(
                result
                    .get("sessionId")
                    .is_none_or(|id| id.as_str() == Some(session.as_str())),
                "Permission response belongs to another session"
            );
            let response: RequestPermissionResponse = serde_json::from_value(result.clone())
                .map_err(|_| anyhow::anyhow!("Invalid permission response; operation refused"))?;
            match response.outcome {
                RequestPermissionOutcome::Cancelled => Ok(ApprovalDecision::Cancel),
                RequestPermissionOutcome::Selected(selected) => {
                    ensure!(
                        offered.contains(&selected.option_id.to_string()),
                        "Permission option was not offered; operation refused"
                    );
                    match selected.option_id.to_string().as_str() {
                        "allow_once" => Ok(ApprovalDecision::Accept),
                        "reject_once" => Ok(ApprovalDecision::Decline),
                        _ => Err(anyhow::anyhow!(
                            "Permission option was not offered; operation refused"
                        )),
                    }
                }
                _ => Err(anyhow::anyhow!(
                    "Unsupported permission outcome; operation refused"
                )),
            }
        };
        tokio::select! {
            biased;
            _=cancelled.cancelled()=>Ok(ApprovalDecision::Cancel),
            _=self.0.closed.cancelled()=>Ok(ApprovalDecision::Cancel),
            result=tokio::time::timeout(self.0.timeout,wait)=>result.map_err(|_|anyhow::anyhow!("Permission response timed out; operation refused"))?,
        }
    }
}

struct Registration {
    state: Permissions,
    id: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.state
            .0
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

pub(crate) fn request_for(
    session: &str,
    approval: &kcoder_app_protocol::ApprovalRequestParams,
) -> Result<RequestPermissionRequest> {
    let id = approval
        .tool_call_id
        .as_deref()
        .filter(|id| !id.is_empty() && id.len() <= 1024)
        .ok_or_else(|| anyhow::anyhow!("Approval is missing its negotiated tool identity"))?;
    let description = bounded(&serde_json::to_string(&approval.action)?, 64 * 1024);
    let id = crate::projection::tool_id(&approval.turn_id, id);
    Ok(serde_json::from_value(json!({"sessionId":session,
        "toolCall":{"toolCallId":id,"status":"pending","title":bounded(&approval.reason,1024),
            "content":[{"type":"content","content":{"type":"text","text":description}}]},
        "options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},
            {"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}))?)
}

fn bounded(text: &str, maximum: usize) -> String {
    if text.len() <= maximum {
        return text.into();
    }
    let mut end = maximum.saturating_sub(64);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[Permission preview truncated; input is unchanged]",
        &text[..end]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::{QueuedFrame, wire_queue};
    use tokio::sync::mpsc;

    fn parameters() -> RequestPermissionRequest {
        request_for(
            "session",
            &kcoder_app_protocol::ApprovalRequestParams {
                app_server_epoch: None,
                server_id: "native".into(),
                thread_id: "thread".into(),
                turn_id: "turn".into(),
                approval_id: "approval".into(),
                tool_call_id: Some("tool".into()),
                action: kcoder_app_protocol::ApprovalAction::Command {
                    command: "echo fixture".into(),
                },
                reason: "Run fixture".into(),
            },
        )
        .unwrap()
    }
    async fn next(receiver: &mut mpsc::Receiver<QueuedFrame>) -> Value {
        serde_json::from_slice(&receiver.recv().await.unwrap().bytes).unwrap()
    }
    fn selected(id: Value, option: &str) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"selected","optionId":option}}})
    }
    #[tokio::test]
    async fn decisions_are_one_time_direction_scoped_and_old_replies_cannot_authorize_the_next_request()
     {
        let (sender, mut frames) = wire_queue();
        let bridge = Permissions::new(sender);
        let pending = bridge.clone();
        let first = tokio::spawn(async move {
            pending
                .request(parameters(), &CancellationToken::new())
                .await
        });
        let frame = next(&mut frames).await;
        assert_eq!(
            frame["params"]["toolCall"]["toolCallId"],
            crate::projection::tool_id("turn", "tool")
        );
        assert_eq!(frame["params"]["options"].as_array().unwrap().len(), 2);
        bridge.receive(&selected(json!(1), "allow_once"));
        assert_eq!(bridge.0.pending.lock().unwrap().len(), 1);
        bridge.receive(&selected(frame["id"].clone(), "allow_once"));
        assert_eq!(first.await.unwrap().unwrap(), ApprovalDecision::Accept);
        let pending = bridge.clone();
        let second = tokio::spawn(async move {
            pending
                .request(parameters(), &CancellationToken::new())
                .await
        });
        let current = next(&mut frames).await;
        assert_ne!(frame["id"], current["id"]);
        bridge.receive(&selected(frame["id"].clone(), "allow_once"));
        assert_eq!(bridge.0.pending.lock().unwrap().len(), 1);
        bridge.receive(&selected(current["id"].clone(), "reject_once"));
        assert_eq!(second.await.unwrap().unwrap(), ApprovalDecision::Decline);
        assert!(bridge.0.pending.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn unoffered_options_foreign_session_and_client_errors_never_grant_permission() {
        for mode in ["allow_always", "foreign", "error", "not_offered"] {
            let (sender, mut frames) = wire_queue();
            let bridge = Permissions::new(sender);
            let pending = bridge.clone();
            let mut parameters = parameters();
            if mode == "not_offered" {
                parameters
                    .options
                    .retain(|option| option.option_id.to_string() == "reject_once");
            }
            let task = tokio::spawn(async move {
                pending.request(parameters, &CancellationToken::new()).await
            });
            let frame = next(&mut frames).await;
            let mut response = selected(
                frame["id"].clone(),
                if mode == "allow_always" {
                    mode
                } else {
                    "allow_once"
                },
            );
            if mode == "foreign" {
                response["result"]["sessionId"] = json!("other-session");
            }
            if mode == "error" {
                response.as_object_mut().unwrap().remove("result");
                response["error"] = json!({"code":-32603,"message":"client failure"});
            }
            bridge.receive(&response);
            assert!(task.await.unwrap().is_err());
            assert!(bridge.0.pending.lock().unwrap().is_empty());
        }
    }
    #[tokio::test(start_paused = true)]
    async fn cancellation_disconnect_timeout_and_late_replies_release_pending_authority() {
        for mode in ["cancel", "close", "timeout"] {
            let (sender, mut frames) = wire_queue();
            let bridge = Permissions::new(sender);
            let pending = bridge.clone();
            let token = CancellationToken::new();
            let owned = token.clone();
            let task = tokio::spawn(async move { pending.request(parameters(), &owned).await });
            let frame = next(&mut frames).await;
            match mode {
                "cancel" => token.cancel(),
                "close" => bridge.close(),
                _ => tokio::time::advance(Duration::from_secs(301)).await,
            }
            let outcome = task.await.unwrap();
            if mode == "timeout" {
                assert!(outcome.is_err());
            } else {
                assert_eq!(outcome.unwrap(), ApprovalDecision::Cancel);
            }
            bridge.receive(&selected(frame["id"].clone(), "allow_once"));
            assert!(bridge.0.pending.lock().unwrap().is_empty());
        }
    }
    #[test]
    fn large_permission_previews_are_bounded_without_changing_input_or_inventing_an_identity() {
        let mut request = kcoder_app_protocol::ApprovalRequestParams {
            app_server_epoch: None,
            server_id: "native".into(),
            thread_id: "thread".into(),
            turn_id: "turn".into(),
            approval_id: "approval".into(),
            tool_call_id: Some("real-call".into()),
            action: kcoder_app_protocol::ApprovalAction::Tool {
                name: "external".into(),
                input: json!({"text":"中".repeat(40000)}),
            },
            reason: "中".repeat(1000),
        };
        let params = serde_json::to_value(request_for("session", &request).unwrap()).unwrap();
        assert_eq!(
            params["toolCall"]["toolCallId"],
            crate::projection::tool_id("turn", "real-call")
        );
        assert!(params["toolCall"]["title"].as_str().unwrap().len() <= 1024);
        assert!(
            params["toolCall"]["content"][0]["content"]["text"]
                .as_str()
                .unwrap()
                .len()
                <= 65536
        );
        request.tool_call_id = None;
        assert!(request_for("session", &request).is_err());
    }
}
