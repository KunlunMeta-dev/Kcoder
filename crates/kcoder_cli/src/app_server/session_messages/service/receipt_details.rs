//! Exact, body-free destination observations shared by local and private routes.
use super::*;
use kcoder_app_protocol::cross_session_router::{
    PeerRouterQueryOriginalDetailsResultV1, SignedPeerMessageAttestationV1,
};
use kcoder_state::cross_session_messages::OriginalReceiptQuery;

impl PeerMessageService {
    pub(in crate::app_server::session_messages) fn query_original_receipt_details(
        &self,
        source_identity: &PeerRouterIdentityV1,
        attestation: &SignedPeerMessageAttestationV1,
        query: &AgentMessageGetParams,
        verify: impl Fn() -> Result<()>,
    ) -> Result<PeerRouterQueryOriginalDetailsResultV1> {
        verify()?;
        self.authority()?.verify()?;
        super::super::router_store::verify_peer_attestation(attestation, source_identity)?;
        let claims = &attestation.claims;
        ensure!(
            self.identity()?.contains(&claims.destination),
            "peer_router_destination_scope_changed"
        );
        query.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            query
                .client_message_id
                .as_ref()
                .is_none_or(|id| id == &claims.client_message_id),
            "peer_router_query_identity_changed"
        );
        let source = CrossSessionMessageSource {
            thread_id: claims.source_address.thread_id.clone(),
            principal_id: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    "kcoder.peer-message.source.v1",
                    &source_identity.target_id,
                    &source_identity.identity_epoch,
                ))?)
            ),
            address: Some(claims.source_address.clone()),
        };
        let queue = self.mailbox()?;
        let store_authority = self.authority()?;
        let store = store_authority.store()?;
        let binding = super::super::receipt_read::read_current(|| {
            verify()?;
            self.authority()?.verify()?;
            queue.original_receipt_summary(&OriginalReceiptQuery {
                source: &source,
                client_message_id: &claims.client_message_id,
                message_id: query.message_id.as_deref(),
                destination: &claims.destination,
                mode: claims.mode,
                expected_turn_id: claims.expected_turn_id.as_deref(),
                reply_to_message_id: claims.reply_to_message_id.as_deref(),
                body_sha256: &claims.body_sha256,
            })
        })?;
        let Some(binding) = binding else {
            verify()?;
            self.authority()?.verify()?;
            return Ok(PeerRouterQueryOriginalDetailsResultV1::default());
        };
        if let Some(incoming) =
            store.read_incoming(&claims.source_address, &claims.client_message_id)?
        {
            ensure!(
                incoming.attestation == *attestation
                    && incoming.source_identity == *source_identity,
                "peer_router_original_provenance_changed"
            );
        } else {
            // Existing same-profile direct deliveries carry their original source
            // operation, not an imported route. Remote sources cannot take this lane.
            ensure!(
                self.identity()?.contains(&claims.source_address),
                "peer_router_original_provenance_unknown"
            );
            let operation = self.verify_local_receipt_binding(&binding)?;
            ensure!(
                operation.attestation == *attestation,
                "peer_router_original_provenance_changed"
            );
        }
        ensure!(
            [binding.created_at_ms, binding.expires_at_ms]
                .into_iter()
                .flatten()
                .all(|time| time < (1 << 53)),
            "peer_router_original_time_invalid"
        );
        verify()?;
        self.authority()?.verify()?;
        Ok(PeerRouterQueryOriginalDetailsResultV1 {
            receipt: Some(binding.receipt),
            created_at_ms: binding.created_at_ms,
            expires_at_ms: binding.expires_at_ms,
        })
    }

    /// The local caller must own this Source and its current tool authorization.
    /// This method only observes an original same-namespace destination.
    pub(crate) fn local_outgoing_receipt_details(
        &self,
        operation: &PeerRouterOperationV1,
    ) -> Result<PeerRouterQueryOriginalDetailsResultV1> {
        let identity = self.identity()?;
        ensure!(
            identity.contains(&operation.source_address)
                && identity.contains(&operation.destination),
            "peer_message_remote_destination_requires_route"
        );
        super::super::router_store::verify_peer_attestation(&operation.attestation, &identity)?;
        let authority = self.authority()?;
        let original = authority
            .store()?
            .read_operation(&operation.operation_id)?
            .context("peer_message_original_operation_missing")?;
        ensure!(
            original.attestation == operation.attestation
                && original.source_address == operation.source_address
                && original.destination == operation.destination
                && original.body_sha256 == operation.body_sha256,
            "peer_message_original_intent_changed"
        );
        self.query_original_receipt_details(
            &identity,
            &original.attestation,
            &AgentMessageGetParams {
                message_id: None,
                client_message_id: Some(original.attestation.claims.client_message_id.clone()),
            },
            || self.authority()?.verify(),
        )
    }

    /// Read an outgoing receipt from this host's own durable facts when the
    /// original operation's destination is also this host. Same-host sends are
    /// admitted locally (never through the parent router), so their receipts are
    /// read locally too: this keeps reads independent of whether the parent
    /// router can currently attribute the caller's turn to a client owner, e.g.
    /// while a Native peer-driven turn processes an inbound message.
    ///
    /// The caller must already own this Source and its current tool
    /// authorization; this grants nothing and never writes either store.
    /// A remote destination or an unknown operation still requires the route.
    pub(crate) fn local_outgoing_receipt(
        &self,
        source: &SessionAddressV1,
        query: &AgentMessageGetParams,
    ) -> Result<OutgoingReceiptRead> {
        query.validate().map_err(anyhow::Error::msg)?;
        let identity = self.identity()?;
        ensure!(
            identity.contains(source) && self.address(&source.thread_id)? == *source,
            "peer_message_source_scope_changed"
        );
        let operation = self
            .authority()?
            .store()?
            .find_source_operation(source, query)?;
        let Some(operation) = operation else {
            return Ok(OutgoingReceiptRead::RequiresRoute);
        };
        if !identity.contains(&operation.destination) {
            return Ok(OutgoingReceiptRead::RequiresRoute);
        }
        if operation.stage == kcoder_app_protocol::cross_session_router::PeerRouterStageV1::Prepared
        {
            // Same answer as the routed reader: nothing was dispatched yet.
            return Ok(OutgoingReceiptRead::Local(None));
        }
        let details = self.local_outgoing_receipt_details(&operation)?;
        // Absence after dispatch is not evidence that admission never happened.
        let receipt = details
            .receipt
            .context("peer_message_original_receipt_unconfirmed")?;
        if let Some(id) = query.message_id.as_deref() {
            ensure!(
                receipt.message_id == id,
                "peer_message_original_receipt_unconfirmed"
            );
        }
        Ok(OutgoingReceiptRead::Local(Some(receipt)))
    }
}

/// Where an outgoing receipt can be confirmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OutgoingReceiptRead {
    /// Observed in this host's destination mailbox (or never dispatched).
    Local(Option<AgentMessageReceipt>),
    /// Only the authenticated parent route can confirm it.
    RequiresRoute,
}
