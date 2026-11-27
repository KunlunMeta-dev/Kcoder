//! One authenticated Gateway device WebSocket, owned by the original Source.
use super::gateway_auth::GatewayDeviceClient;
use anyhow::{Context, Result, ensure};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};
use tokio_util::sync::CancellationToken;

const MAX_FRAME: usize = 128 * 1024;
pub(super) struct GatewayTransportGrant {
    closed: CancellationToken,
    source: kcoder_types::session_address::SessionAddressV1,
}
impl GatewayTransportGrant {
    pub(super) fn verify(&self, source: &super::BoundPeerSource) -> Result<()> {
        ensure!(
            !self.closed.is_cancelled() && source.address()? == self.source,
            "peer_gateway_transport_owner_changed"
        );
        source.check_owner()
    }
}
pub(super) struct NativeGatewayRequest {
    pub grant: Arc<GatewayTransportGrant>,
    pub method: String,
    pub params: Value,
    pub reply: oneshot::Sender<Value>,
}
struct Outgoing {
    method: String,
    params: Value,
    reply: oneshot::Sender<Result<Value>>,
}
pub(super) struct GatewayPeerChannel {
    outgoing: mpsc::Sender<Outgoing>,
    closed: CancellationToken,
    discovery_search: AtomicBool,
    message_replies: AtomicBool,
    message_receipts: AtomicBool,
}
pub(super) struct GatewayPeerChannelOwner {
    channel: Arc<GatewayPeerChannel>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for GatewayPeerChannelOwner {
    fn drop(&mut self) {
        self.channel.closed.cancel();
        self.task.abort();
    }
}
impl GatewayPeerChannelOwner {
    pub(super) fn channel(&self) -> Arc<GatewayPeerChannel> {
        self.channel.clone()
    }
}

impl GatewayPeerChannel {
    pub(super) async fn connect(
        client: &GatewayDeviceClient,
        server: &str,
        workspace: &str,
        native: mpsc::Sender<NativeGatewayRequest>,
        source: kcoder_types::session_address::SessionAddressV1,
    ) -> Result<GatewayPeerChannelOwner> {
        let mut request = client
            .rpc_url(server, workspace)?
            .as_str()
            .into_client_request()
            .map_err(|_| anyhow::anyhow!("peer Gateway WebSocket request invalid"))?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", client.access_token()).parse()?,
        );
        request
            .headers_mut()
            .insert("sec-websocket-protocol", "kcoder-studio".parse()?);
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            connect_async_with_config(
                request,
                Some(
                    WebSocketConfig::default()
                        .max_message_size(Some(MAX_FRAME))
                        .max_frame_size(Some(MAX_FRAME)),
                ),
                false,
            ),
        )
        .await
        .map_err(|_| anyhow::anyhow!("peer Gateway connection deadline"))?
        .map_err(|_| anyhow::anyhow!("peer Gateway connection unconfirmed"))?;
        let (outgoing, mut receiver) = mpsc::channel::<Outgoing>(32);
        let closed = CancellationToken::new();
        let channel = Arc::new(Self {
            outgoing,
            closed: closed.clone(),
            discovery_search: AtomicBool::new(false),
            message_replies: AtomicBool::new(false),
            message_receipts: AtomicBool::new(false),
        });
        let grant = Arc::new(GatewayTransportGrant {
            closed: closed.clone(),
            source,
        });
        let task = tokio::spawn(async move {
            let (mut sink, mut input) = socket.split();
            let mut pending = HashMap::<String, (bool, oneshot::Sender<Result<Value>>)>::new();
            let (replies, mut response) = mpsc::channel::<Value>(32);
            let mut native_jobs = tokio::task::JoinSet::new();
            loop {
                tokio::select! {biased;
                    _=closed.cancelled()=>break,
                    _=native_jobs.join_next(),if !native_jobs.is_empty()=>{},
                    value=response.recv()=>{let Some(value)=value else {break};if send(&mut sink,value).await.is_err(){break;}},
                    item=receiver.recv()=>{
                        let Some(item)=item else {break};
                        pending.retain(|_,(_, reply)|!reply.is_closed());
                        if pending.len()>=32 {let _=item.reply.send(Err(anyhow::anyhow!("peer_gateway_request_capacity")));continue;}
                        let id=uuid::Uuid::new_v4().to_string();let value=json!({"jsonrpc":"2.0","id":id,"method":item.method,"params":item.params});
                        pending.insert(id,(item.method == "agentPeer/targets", item.reply));if send(&mut sink,value).await.is_err(){break;}
                    }
                    incoming=input.next()=>{
                        let Some(Ok(message))=incoming else {break};
                        match message {
                            Message::Ping(value)=>{if tokio::time::timeout(Duration::from_secs(10),sink.send(Message::Pong(value))).await.map_or(true,|result|result.is_err()){break;}},
                            Message::Pong(_)=>{},Message::Close(_)=>break,
                            Message::Text(text)=>{
                                if text.len()>MAX_FRAME {break;}
                                let value:Value=match serde_json::from_str(&text){Ok(value)=>value,Err(_)=>break};
                                if value.get("jsonrpc").and_then(Value::as_str)!=Some("2.0"){break;}
                                if value.get("method").is_none() {
                                    if let Some(id)=value.get("id").and_then(Value::as_str) && let Some((discovery,reply))=pending.remove(id) {
                                        let result = if let Some(error) = value.get("error") {
                                            let message = error.get("message").and_then(Value::as_str);
                                            match message.filter(|message|
                                                discovery && crate::app_server::session_discovery::router_read_rejection(message).is_some()) {
                                                Some(reason) => Err(anyhow::Error::msg(reason.to_owned())),
                                                // Only a closed Gateway code is kept as the inner diagnostic cause.
                                                None => Err(anyhow::Error::msg(message
                                                    .and_then(kcoder_tools::peer_diagnostics::normalized_code)
                                                    .unwrap_or_else(|| "peer_gateway_error_response".into()))
                                                    .context("peer_gateway_request_outcome_unconfirmed")),
                                            }
                                        } else {
                                            value.get("result").cloned().ok_or_else(|| anyhow::anyhow!("peer_gateway_response_invalid"))
                                        };
                                        let _=reply.send(result);
                                    }
                                }else{
                                    if native_jobs.len()>=8 {break;}
                                    let Some(id)=value.get("id").filter(|id|id.as_str().is_some_and(|id|!id.is_empty()&&id.len()<=256)||id.as_i64().is_some_and(|id|id.unsigned_abs()<=9007199254740991)).cloned() else {break};
                                    let Some(method)=value.get("method").and_then(Value::as_str).filter(|method|matches!(*method,"agentPeer/sourcePresence"|"agentPeer/nativeRequest")) else {break};
                                    let (reply,receive)=oneshot::channel();
                                    let request=NativeGatewayRequest {grant:grant.clone(),method:method.into(),params:value.get("params").cloned().unwrap_or(Value::Null),reply};
                                    if native.try_send(request).is_err(){break;}
                                    let replies=replies.clone();
                                    native_jobs.spawn(async move {let response=tokio::time::timeout(Duration::from_secs(10),receive).await.ok().and_then(Result::ok).unwrap_or_else(||json!({"error":{"code":-32034,"message":"PEER_NATIVE_SOURCE_UNAVAILABLE"}}));let value=if let Some(error)=response.get("error"){json!({"jsonrpc":"2.0","id":id,"error":error})}else{json!({"jsonrpc":"2.0","id":id,"result":response.get("result").cloned().unwrap_or(Value::Null)})};let _=replies.send(value).await;});
                                }
                            }
                            _=>break,
                        }
                    }
                }
            }
            closed.cancel();
            native_jobs.abort_all();
            while native_jobs.join_next().await.is_some() {}
            for (_, (_, reply)) in pending {
                let _ = reply.send(Err(anyhow::anyhow!(
                    "peer_gateway_channel_closed_outcome_unknown"
                )));
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), sink.close()).await;
        });
        Ok(GatewayPeerChannelOwner { channel, task })
    }
    pub(super) async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let started = std::time::Instant::now();
        let result = self.request_once(method, params).await;
        if let Err(error) = &result
            && crate::app_server::session_discovery::router_read_rejection(&error.to_string())
                .is_none()
        {
            let operation = match method {
                "agentPeer/targets" => "gateway.targets",
                "agentPeer/send" => "gateway.send",
                "agentPeer/get" => "gateway.get",
                "agentPeer/listReceipts" => "gateway.listReceipts",
                "agentPeer/enroll" => "gateway.enroll",
                _ => "gateway.other",
            };
            crate::app_server::session_messages::errors::report_failure(
                operation,
                "gateway_channel",
                &error.to_string(),
                Some(error),
                started,
            );
        }
        result
    }
    async fn request_once(&self, method: &str, params: Value) -> Result<Value> {
        ensure!(!self.closed.is_cancelled(), "peer_gateway_channel_closed");
        let (reply, receive) = oneshot::channel();
        self.outgoing
            .try_send(Outgoing {
                method: method.into(),
                params,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("peer_gateway_request_unconfirmed"))?;
        tokio::select! {biased;_=self.closed.cancelled()=>anyhow::bail!("peer_gateway_outcome_unknown"),result=tokio::time::timeout(Duration::from_secs(60),receive)=>result.context("peer_gateway_outcome_unknown")?.context("peer_gateway_outcome_unknown")?}
    }
    pub(super) async fn enroll(
        &self,
        source: &kcoder_types::session_address::SessionAddressV1,
    ) -> Result<kcoder_app_protocol::cross_session_router::PeerRouterIdentityV1> {
        let result = self
            .request(
                "agentPeer/enroll",
                json!({"sourceThreadId":source.thread_id}),
            )
            .await?;
        let capabilities = result
            .get("capabilities")
            .context("peer_gateway_capabilities_missing")?;
        ensure!(
            ["targets", "send", "get", "peerAgentMessagesV1"]
                .iter()
                .all(|name| capabilities.get(*name) == Some(&Value::Bool(true))),
            "peer_gateway_upgrade_required"
        );
        let actual: kcoder_types::session_address::SessionAddressV1 = serde_json::from_value(
            result
                .get("sourceAddress")
                .cloned()
                .context("peer_gateway_source_unconfirmed")?,
        )?;
        ensure!(&actual == source, "peer_gateway_source_scope_mismatch");
        let identity: kcoder_app_protocol::cross_session_router::PeerRouterIdentityV1 =
            serde_json::from_value(
                result
                    .get("logicalIdentity")
                    .cloned()
                    .context("peer_gateway_logical_identity_missing")?,
            )?;
        identity.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            identity.contains(source),
            "peer_gateway_logical_scope_mismatch"
        );
        self.message_replies.store(capabilities[kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_REPLIES_V1] == true, Ordering::Release);
        self.message_receipts.store(capabilities[kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_MESSAGE_RECEIPTS_V1] == true, Ordering::Release);
        self.discovery_search.store(
            capabilities[kcoder_app_protocol::cross_session_messages::CAPABILITY_CROSS_SESSION_DISCOVERY_SEARCH_V1] == true,
            Ordering::Release,
        );
        Ok(identity)
    }
    pub(super) fn supports_discovery_search(&self) -> bool {
        self.discovery_search.load(Ordering::Acquire)
    }
    pub(super) fn supports_message_replies(&self) -> bool {
        self.message_replies.load(Ordering::Acquire)
    }
    pub(super) fn supports_message_receipts(&self) -> bool {
        self.message_receipts.load(Ordering::Acquire)
    }
    pub(super) fn cancellation(&self) -> CancellationToken {
        self.closed.clone()
    }
    pub(super) fn close(&self) {
        self.closed.cancel();
    }
    pub(super) fn available(&self) -> bool {
        !self.closed.is_cancelled()
    }
}
async fn send<S>(sink: &mut S, value: Value) -> Result<()>
where
    S: futures::Sink<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    let text = serde_json::to_string(&value)?;
    ensure!(text.len() <= MAX_FRAME, "peer_gateway_frame_limit");
    tokio::time::timeout(
        Duration::from_secs(10),
        sink.send(Message::Text(text.into())),
    )
    .await
    .context("peer_gateway_outcome_unknown")?
    .context("peer_gateway_outcome_unknown")
}
