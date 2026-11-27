//! Private requests on an authenticated device channel, bound to one real Native owner.
use super::*;
use crate::app_server::session_messages::{
    router_store::verify_peer_attestation, service::LivePeerSource,
};
use kcoder_app_protocol::cross_session_router::{self as router, *};
use serde_json::{Value, json};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

/// Constructed only while the owning WSS task is serving its original Bound.
/// This does not turn a JSON route proof into a transport grant.
pub(super) fn handle(
    grant: &super::gateway_channel::GatewayTransportGrant,
    source: &BoundPeerSource,
    method: &str,
    params: Value,
) -> Result<Value> {
    grant.verify(source)?;
    if method == "agentPeer/sourcePresence" {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Presence {
            nonce: String,
            source_thread_id: String,
        }
        let params: Presence = serde_json::from_value(params)?;
        ensure!(
            params.source_thread_id == source.address()?.thread_id,
            "peer_gateway_source_changed"
        );
        let presence = source.sign_presence(&params.nonce)?;
        grant.verify(source)?;
        return Ok(json!({"identity":source.service().identity()?,"presence":presence}));
    }
    ensure!(
        method == "agentPeer/nativeRequest",
        "peer_gateway_native_method_denied"
    );
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        request: Box<serde_json::value::RawValue>,
    }
    let outer: Request = serde_json::from_value(params)?;
    let request =
        PrivatePeerRouterRequest::decode(outer.request.get()).map_err(anyhow::Error::msg)?;
    let result = execute(grant, source, request)?;
    grant.verify(source)?;
    Ok(result)
}

fn execute(
    grant: &super::gateway_channel::GatewayTransportGrant,
    source: &BoundPeerSource,
    request: PrivatePeerRouterRequest,
) -> Result<Value> {
    let local = source.address()?;
    let service = source.service();
    if request.method == router::method::IDENTITY {
        let _: EmptyParams = request.params().map_err(anyhow::Error::msg)?;
        return Ok(serde_json::to_value(service.identity()?)?);
    }
    if request.method == router::method::CAPABILITIES {
        let _: EmptyParams = request.params().map_err(anyhow::Error::msg)?;
        grant.verify(source)?;
        return Ok(serde_json::to_value(service.message_capabilities()?)?);
    }
    // Only this channel's actual Source is exposed. Destination queue admission
    // remains on the catalog Native host, which owns that destination service.
    ensure!(
        matches!(
            request.method.as_str(),
            router::method::SOURCE_PREPARE
                | router::method::SOURCE_READ
                | router::method::SOURCE_FIND
                | router::method::SOURCE_LIST
                | router::method::SOURCE_MARK_DISPATCH
                | router::method::SOURCE_RECORD_RECEIPT
                | router::method::SOURCE_CHECK_ORIGINAL
        ),
        "peer_gateway_native_method_denied"
    );
    let authority = service.authority()?;
    let proof = request
        .proof
        .as_ref()
        .context("peer_gateway_route_required")?;
    let verify_route = || -> Result<()> {
        grant.verify(source)?;
        proof.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            proof.source == service.identity()? && proof.source.contains(&local),
            "peer_gateway_source_identity_changed"
        );
        Ok(())
    };
    verify_route()?;
    let store = authority.store()?;
    let verify = |operation: &PeerRouterOperationV1, destination: bool| -> Result<()> {
        source.check_owner()?;
        verify_route()?;
        ensure!(
            operation.source_address == local && proof.source.contains(&local),
            "peer_gateway_source_changed"
        );
        verify_peer_attestation(&operation.attestation, &proof.source)?;
        ensure!(
            !destination || proof.destination.contains(&operation.destination),
            "peer_gateway_destination_changed"
        );
        Ok(())
    };
    let result = match request.method.as_str() {
        router::method::SOURCE_PREPARE => {
            let params: PeerRouterSourcePrepareParams =
                request.params().map_err(anyhow::Error::msg)?;
            ensure!(
                params.source_thread_id == local.thread_id
                    && proof.destination.contains(&params.destination),
                "peer_gateway_source_or_destination_changed"
            );
            let intent = params.message.into_intent(params.destination);
            ensure!(
                params.operation_id
                    == PeerMessageService::operation_id(&local, &intent.client_message_id)?,
                "peer_gateway_operation_changed"
            );
            source.remember_authorized_intent(&intent)?;
            let operation =
                service.prepare_original(source.state(), source.owner(), source, &intent)?;
            verify(&operation, true)?;
            serde_json::to_value(operation)?
        }
        router::method::SOURCE_FIND => {
            let params: PeerRouterSourceFindParams =
                request.params().map_err(anyhow::Error::msg)?;
            ensure!(
                params.source_thread_id == local.thread_id,
                "peer_gateway_source_changed"
            );
            params.query.validate().map_err(anyhow::Error::msg)?;
            source.check_tool(
                "GetSessionMessageReceipt",
                &serde_json::to_value(&params.query)?,
            )?;
            let operation = store.find_source_operation(&local, &params.query)?;
            if let Some(operation) = &operation {
                verify(operation, false)?;
            }
            serde_json::to_value(operation)?
        }
        router::method::SOURCE_LIST => {
            let params: PeerRouterSourceListParamsV1 =
                request.params().map_err(anyhow::Error::msg)?;
            ensure!(
                params.source_thread_id == local.thread_id,
                "peer_gateway_source_changed"
            );
            params.query.validate().map_err(anyhow::Error::msg)?;
            source.check_tool(
                "ListSessionMessageReceipts",
                &serde_json::to_value(&params.query)?,
            )?;
            let page = store.source_operations_page(&local, &params.query)?;
            for item in &page.items {
                verify(&item.operation, false)?;
            }
            serde_json::to_value(page)?
        }
        router::method::SOURCE_READ | router::method::SOURCE_MARK_DISPATCH => {
            let params: PeerRouterOperationParams = request.params().map_err(anyhow::Error::msg)?;
            let operation = store.read_operation(&params.operation_id)?;
            if let Some(operation) = operation {
                let dispatch = request.method == router::method::SOURCE_MARK_DISPATCH;
                verify(&operation, dispatch)?;
                if dispatch {
                    source.verify_original(&operation.attestation.claims)?;
                    serde_json::to_value(store.mark_dispatching(&params.operation_id)?)?
                } else {
                    serde_json::to_value(operation)?
                }
            } else {
                ensure!(
                    request.method == router::method::SOURCE_READ,
                    "peer_gateway_operation_missing"
                );
                Value::Null
            }
        }
        router::method::SOURCE_RECORD_RECEIPT => {
            let params: PeerRouterRecordReceiptParams =
                request.params().map_err(anyhow::Error::msg)?;
            let operation = store
                .read_operation(&params.operation_id)?
                .context("peer_gateway_operation_missing")?;
            verify(&operation, true)?;
            serde_json::to_value(store.record_receipt(&params.operation_id, params.receipt)?)?
        }
        router::method::SOURCE_CHECK_ORIGINAL => {
            let params: PeerRouterCheckOriginalParams =
                request.params().map_err(anyhow::Error::msg)?;
            verify_peer_attestation(&params.attestation, &proof.source)?;
            let operation = store
                .read_operation(&params.attestation.claims.operation_id)?
                .context("peer_gateway_operation_missing")?;
            verify(&operation, true)?;
            ensure!(
                operation.attestation == params.attestation
                    && operation.stage != PeerRouterStageV1::Prepared,
                "peer_gateway_dispatch_unknown"
            );
            if let Some(message) = params.message {
                let intent = message.into_intent(operation.destination.clone());
                ensure!(
                    OriginalSourceCheck::for_intent(&intent)?
                        == OriginalSourceCheck {
                            client_message_id: operation
                                .attestation
                                .claims
                                .client_message_id
                                .clone(),
                            destination: operation.destination.clone(),
                            mode: operation.attestation.claims.mode,
                            expected_turn_id: operation.attestation.claims.expected_turn_id.clone(),
                            reply_to_message_id: operation
                                .attestation
                                .claims
                                .reply_to_message_id
                                .clone(),
                            body_sha256: operation.body_sha256.clone(),
                        },
                    "peer_gateway_original_message_changed"
                );
            }
            let current = source.verify_original(&operation.attestation.claims)?;
            ensure!(
                current.attestation == operation.attestation,
                "peer_gateway_original_changed"
            );
            serde_json::to_value(current)?
        }
        _ => unreachable!("private method whitelist checked above"),
    };
    verify_route()?;
    source.check_owner()?;
    Ok(result)
}
