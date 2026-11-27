//! Explicit authenticated Gateway attachment for the existing interactive owner.
use super::gateway_channel::{GatewayPeerChannel, GatewayPeerChannelOwner, NativeGatewayRequest};
use super::*;
use crate::app_server::session_messages::{
    delivery::DestinationPeerMessageDriver,
    remote_delivery::{OriginalSourceVerifier, RoutedPeerDeliveryResolver},
};
use async_trait::async_trait;
use kcoder_app_protocol::cross_session_router::*;
use kcoder_engine::peer_message_runtime::PeerMessageCall;
use kcoder_tools::{
    ToolError,
    session_discovery::SessionDiscoveryHost,
    session_messages::{SessionMessageSendError, SessionMessagesHost},
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

pub(crate) struct GatewayPeerRuntime {
    // Closing the authenticated owner makes every outstanding request unknown;
    // dropping this guard never replays a model operation or removes peer data.
    _channel: GatewayPeerChannelOwner,
    native: tokio::task::JoinHandle<()>,
    renewal: tokio::task::JoinHandle<()>,
}
impl Drop for GatewayPeerRuntime {
    fn drop(&mut self) {
        self.native.abort();
        self.renewal.abort();
    }
}
struct GatewayHost {
    source: Arc<BoundPeerSource>,
    channel: Arc<GatewayPeerChannel>,
}
fn unavailable() -> ToolError {
    ToolError::Execution("peer_gateway_current_owner_unavailable".into())
}

#[async_trait]
impl SessionDiscoveryHost for GatewayHost {
    async fn list(
        &self,
        call: SessionDiscoveryCall,
        cursor: Option<String>,
    ) -> std::result::Result<Value, ToolError> {
        let params = call.input(cursor.as_deref());
        self.source
            .check_discovery_call(&call, &params)
            .map_err(|_| unavailable())?;
        let wire = crate::app_server::session_discovery::gateway_search_input(
            params.clone(),
            self.channel.supports_discovery_search(),
        )?;
        let value = self
            .channel
            .request("agentPeer/targets", wire)
            .await
            .map_err(|error| {
                crate::app_server::session_discovery::router_read_rejection(&error.to_string())
                    .map_or_else(unavailable, |message| ToolError::Execution(message.into()))
            })?;
        self.source
            .check_discovery_call(&call, &params)
            .map_err(|_| unavailable())?;
        let _: kcoder_app_protocol::cross_session_messages::AgentMessageTargetsResult =
            serde_json::from_value(value.clone()).map_err(|_| unavailable())?;
        Ok(value)
    }
}
#[async_trait]
impl SessionMessagesHost for GatewayHost {
    async fn send(
        &self,
        call: SessionMessageCall,
        mut intent: AgentMessageIntent,
    ) -> std::result::Result<Value, SessionMessageSendError> {
        let rejected = || SessionMessageSendError::Rejected {
            code: "peer_gateway_source_unavailable",
        };
        let unknown = || SessionMessageSendError::Unconfirmed {
            code: "peer_gateway_receipt_unconfirmed",
        };
        if intent.reply_to_message_id.is_some() && !self.channel.supports_message_replies() {
            return Err(SessionMessageSendError::Rejected {
                code: "peer_message_reply_unsupported",
            });
        }
        let original = serde_json::to_value(&intent).map_err(|_| rejected())?;
        self.source
            .check_message_call(&call, &original)
            .map_err(|_| rejected())?;
        if intent.target_address.is_none() {
            intent.target_address = Some(
                self.source
                    .service()
                    .address(&intent.target_thread_id)
                    .map_err(|_| rejected())?,
            );
        }
        let source = self.source.clone();
        let prepared = intent.clone();
        // This is Native immutable admission, never remote delivery. The router
        // must still authorize both current targets and reconcile the same ID.
        tokio::task::spawn_blocking(move || {
            source.service().prepare_original(
                source.state(),
                source.owner(),
                source.as_ref(),
                &prepared,
            )
        })
        .await
        .map_err(|_| unknown())?
        .map_err(|_| unknown())?;
        self.source
            .check_message_call(&call, &original)
            .map_err(|_| unknown())?;
        let value = self
            .channel
            .request(
                "agentPeer/send",
                serde_json::to_value(&intent).map_err(|_| unknown())?,
            )
            .await
            .map_err(|_| unknown())?;
        self.source
            .check_message_call(&call, &original)
            .map_err(|_| unknown())?;
        let receipt: AgentMessageReceipt =
            serde_json::from_value(value.clone()).map_err(|_| unknown())?;
        ensure_receipt(
            &receipt,
            &self.source.address().map_err(|_| unknown())?,
            &intent,
        )
        .map_err(|_| unknown())?;
        Ok(value)
    }
    async fn list_receipts(
        &self,
        call: SessionMessageCall,
        query: kcoder_types::cross_session_messages::CrossSessionMessageReceiptListParams,
    ) -> std::result::Result<
        kcoder_types::cross_session_messages::CrossSessionMessageReceiptListResult,
        ToolError,
    > {
        if !self.channel.supports_message_receipts() {
            return Err(ToolError::Execution(
                "peer_message_receipt_list_unsupported".into(),
            ));
        }
        let input = serde_json::to_value(&query).map_err(|_| unavailable())?;
        self.source
            .check_message_call(&call, &input)
            .map_err(|_| unavailable())?;
        let value = self
            .channel
            .request("agentPeer/listReceipts", input.clone())
            .await
            .map_err(|_| unavailable())?;
        self.source
            .check_message_call(&call, &input)
            .map_err(|_| unavailable())?;
        let page: kcoder_types::cross_session_messages::CrossSessionMessageReceiptListResult =
            serde_json::from_value(value).map_err(|_| unavailable())?;
        let address = self.source.address().map_err(|_| unavailable())?;
        page.validate(&query, &address.thread_id, Some(&address))
            .map_err(|_| unavailable())?;
        Ok(page)
    }
    async fn receipt(
        &self,
        call: SessionMessageCall,
        query: Value,
    ) -> std::result::Result<Value, ToolError> {
        self.source
            .check_message_call(&call, &query)
            .map_err(|_| unavailable())?;
        let params: kcoder_app_protocol::cross_session_messages::AgentMessageGetParams =
            serde_json::from_value(query.clone()).map_err(|_| unavailable())?;
        params.validate().map_err(|_| unavailable())?;
        let value = self
            .channel
            .request("agentPeer/get", query.clone())
            .await
            .map_err(|_| unavailable())?;
        self.source
            .check_message_call(&call, &query)
            .map_err(|_| unavailable())?;
        let result: kcoder_app_protocol::cross_session_messages::AgentMessageGetResult =
            serde_json::from_value(value.clone()).map_err(|_| unavailable())?;
        // The typed result rejects malformed/missing receipt; a transport error
        // above never becomes a confirmed absence or permission to resend.
        if let kcoder_app_protocol::cross_session_messages::AgentMessageGetResult::Found {
            receipt,
        } = result
        {
            let address = self.source.address().map_err(|_| unavailable())?;
            if receipt.source_address.as_ref() != Some(&address)
                || params
                    .client_message_id
                    .as_ref()
                    .is_some_and(|id| id != &receipt.client_message_id)
                || params
                    .message_id
                    .as_ref()
                    .is_some_and(|id| id != &receipt.message_id)
            {
                return Err(unavailable());
            }
        }
        Ok(value)
    }
}
fn ensure_receipt(
    receipt: &AgentMessageReceipt,
    source: &SessionAddressV1,
    intent: &AgentMessageIntent,
) -> Result<()> {
    ensure!(
        receipt.client_message_id == intent.client_message_id
            && receipt.source_address.as_ref() == Some(source)
            && receipt.target_address == intent.target_address
            && receipt.target_thread_id == intent.target_thread_id
            && receipt.reply_to_message_id == intent.reply_to_message_id,
        "peer_gateway_receipt_scope_changed"
    );
    Ok(())
}

struct DeviceOriginalVerifier {
    source: Arc<BoundPeerSource>,
    channel: Arc<GatewayPeerChannel>,
    address: SessionAddressV1,
    logical_identity: PeerRouterIdentityV1,
}
impl DeviceOriginalVerifier {
    fn verify(&self, call: &PeerMessageCall, params: &PeerRouterCheckOriginalParams) -> Result<()> {
        call.verify_current_owner()?;
        self.source.check_owner()?;
        ensure!(
            self.channel.available()
                && call.state().shares_state_with(self.source.state())
                && call.owner().same_lifecycle(self.source.owner())
                && self.source.address()? == self.address
                && params.attestation.claims.destination == self.address,
            "peer_gateway_target_owner_changed"
        );
        let wake = params.access == PeerRouterHistoryAccess::Wake;
        self.source.service().require_enabled(wake)?;
        if wake {
            ensure!(
                params.attestation.claims.mode == AgentMessageMode::WakeIfIdle
                    && params.attestation.claims.expected_turn_id.is_none(),
                "peer_gateway_target_not_idle"
            );
            if call.is_idle() {
                ensure!(!(self.source.activity)(), "peer_gateway_target_not_idle");
            } else {
                call.verify_claimed_start_selector(
                    &params.attestation.claims.source_address,
                    &params.attestation.claims.destination,
                    &params.attestation.claims.client_message_id,
                    &params.attestation.claims.body_sha256,
                )?;
            }
        }
        if params.access == PeerRouterHistoryAccess::Append
            && let Some(expected) = params.attestation.claims.expected_turn_id.as_deref()
        {
            ensure!(
                !call.is_idle()
                    && call
                        .attempt()
                        .is_some_and(|attempt| attempt.turn_id == expected),
                "peer_gateway_target_turn_changed"
            );
        }
        Ok(())
    }
}
#[async_trait]
impl OriginalSourceVerifier for DeviceOriginalVerifier {
    fn validate_destination_identity(&self, identity: &PeerRouterIdentityV1) -> Result<()> {
        self.source.check_owner()?;
        let raw = self.source.service().identity()?;
        ensure!(
            identity == &self.logical_identity
                && identity.target_id == raw.target_id
                && identity.workspace_id == raw.workspace_id
                && identity.identity_epoch == raw.identity_epoch
                && identity.public_key == raw.public_key,
            "peer_gateway_destination_identity_changed"
        );
        Ok(())
    }
    fn target_address(&self) -> &SessionAddressV1 {
        &self.address
    }
    async fn verify_original(
        &self,
        call: &PeerMessageCall,
        params: PeerRouterCheckOriginalParams,
    ) -> Result<PeerRouterOperationV1> {
        self.verify(call, &params)?;
        let value = self
            .channel
            .request("agentPeer/verifyOriginal", serde_json::to_value(&params)?)
            .await?;
        self.verify(call, &params)?;
        let operation: PeerRouterOperationV1 = serde_json::from_value(value)?;
        ensure!(
            operation.attestation == params.attestation
                && operation.stage != PeerRouterStageV1::Prepared
                && operation.destination == self.address
                && operation.source_address == params.attestation.claims.source_address
                && operation.operation_id == params.attestation.claims.operation_id
                && operation.body_sha256 == params.attestation.claims.body_sha256,
            "peer_gateway_original_operation_changed"
        );
        Ok(operation)
    }
}

pub(crate) async fn attach(
    engine: &mut QueryEngine,
    local: &host::LocalPeerRuntime,
    paths: &kcoder_config::ConfigPaths,
    server: &str,
    allow_insecure: bool,
) -> Result<GatewayPeerRuntime> {
    ensure!(
        !server.is_empty() && server.len() <= 256 && !server.chars().any(char::is_control),
        "peer_gateway_catalog_target_required"
    );
    let source = local.source()?;
    let mut client =
        super::gateway_auth::GatewayDeviceClient::load(&paths.config_dir, allow_insecure)?;
    // Refresh uses its durable original rotation ID if the last receipt was lost.
    client.refresh().await?;
    // A reconciled old rotation can already be expiring; after confirming that
    // receipt, make a new maintenance rotation only if it is actually due.
    client.refresh_if_due().await?;
    let address = source.address()?;
    let workspace = engine
        .state
        .cwd()
        .to_str()
        .context("peer_gateway_workspace_not_utf8")?
        .to_owned();
    let (native_sender, mut incoming) = mpsc::channel::<NativeGatewayRequest>(8);
    let weak = Arc::downgrade(&source);
    let native = tokio::spawn(async move {
        while let Some(request) = incoming.recv().await {
            let NativeGatewayRequest {
                grant,
                method,
                params,
                reply,
            } = request;
            let source = weak.upgrade();
            let result = tokio::task::spawn_blocking(move || -> Result<Value> {
                let source = source.context("peer_gateway_source_closed")?;
                super::gateway_native::handle(&grant, &source, &method, params)
            })
            .await;
            let response = match result {
                Ok(Ok(value)) => json!({"result":value}),
                _ => json!({"error":{"code":-32034,"message":"PEER_NATIVE_SOURCE_UNAVAILABLE"}}),
            };
            let _ = reply.send(response);
        }
    });
    // This owner aborts the request loop on every pre-enrollment error too.
    struct Pending(Option<tokio::task::JoinHandle<()>>);
    impl Drop for Pending {
        fn drop(&mut self) {
            if let Some(task) = &self.0 {
                task.abort();
            }
        }
    }
    let mut pending = Pending(Some(native));
    let channel_owner =
        GatewayPeerChannel::connect(&client, server, &workspace, native_sender, address.clone())
            .await?;
    let channel = channel_owner.channel();
    let logical_identity = channel.enroll(&address).await?;
    let raw_identity = source.service().identity()?;
    ensure!(
        logical_identity.target_id == raw_identity.target_id
            && logical_identity.workspace_id == raw_identity.workspace_id
            && logical_identity.identity_epoch == raw_identity.identity_epoch
            && logical_identity.public_key == raw_identity.public_key,
        "peer_gateway_native_profile_mismatch"
    );
    source.check_owner()?;
    let host = Arc::new(GatewayHost {
        source: source.clone(),
        channel: channel.clone(),
    });
    let verifier = Arc::new(DeviceOriginalVerifier {
        source: source.clone(),
        channel,
        address,
        logical_identity,
    });
    source.set_target_verifier(verifier.clone())?;
    let resolver = Arc::new(RoutedPeerDeliveryResolver::new(
        source.service().clone(),
        verifier,
        host::local_delivery_resolver(source.clone()),
    ));
    let driver = DestinationPeerMessageDriver::new(
        engine.state.clone(),
        engine.state.inspection_lifecycle_identity(),
        local.native_witness()?,
        source.service().mailbox()?,
        resolver,
    )?;
    *engine = engine
        .clone()
        .with_session_discovery_host(host.clone())?
        .with_session_messages_host(host)?
        .with_peer_message_host(Arc::new(driver));
    source.arm_tools(&engine.active_tool_registry())?;
    let renewal =
        super::gateway_renewal::start(client, Arc::downgrade(&source), channel_owner.channel());
    Ok(GatewayPeerRuntime {
        renewal,
        _channel: channel_owner,
        native: pending.0.take().expect("owned Native loop"),
    })
}
