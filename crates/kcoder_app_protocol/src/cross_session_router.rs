//! Private authenticated routing contracts. Addresses and signatures alone grant no access.
use crate::RetentionPrincipalV1;
use kcoder_types::{
    cross_session_messages::{AgentMessageMode, AgentMessageReceipt, valid_agent_message_id},
    session_address::SessionAddressV1,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

mod receipts;
pub mod ssh_enrollment;
pub mod ssh_parent;
pub use receipts::*;

pub const CAPABILITY_AGENT_MESSAGE_ROUTER_PRIVATE_V1: &str = "agentMessageRouterPrivateV1";
pub const CAPABILITY_AGENT_MESSAGE_BACKGROUND_REPLY_V1: &str = "agentMessageBackgroundReplyV1";
pub const CAPABILITY_AGENT_MESSAGE_WAKE_READ_V1: &str = "agentMessageWakeReadV1";
pub const PRIVATE_AGENT_MESSAGE_ROUTE_FIELD: &str = "kcoderPrivateAgentMessageRoute";
pub const AGENT_MESSAGE_ROUTE_PURPOSE: &str = "kcoder.peer-message.route.v1";
pub const AGENT_MESSAGE_ATTESTATION_DOMAIN: &[u8] = b"kcoder.peer-message.attestation.v1\0";
pub const PEER_SOURCE_PRESENCE_PURPOSE: &str = "kcoder.peer-source.presence.v1";
pub const PEER_SOURCE_PRESENCE_DOMAIN: &[u8] = b"kcoder.peer-source.presence.v1\0";

#[cfg(test)]
mod reply_compatibility_tests {
    use super::*;
    #[test]
    fn reply_reference_none_keeps_legacy_signed_bytes_and_some_is_explicit() {
        let legacy = concat!(
            r#"{"version":1,"purpose":"kcoder.peer-message.route.v1","operationId":"operation","sourceAddress":{"targetId":"host-a","workspaceId":"space-a","threadId":"source"},"destination":{"targetId":"host-b","workspaceId":"space-b","threadId":"target"},"sourceIdentityEpoch":"epoch","clientMessageId":"client","mode":"enqueue_only","bodySha256":""#,
            "0000000000000000000000000000000000000000000000000000000000000000",
            r#""}"#
        );
        let mut claims: PeerMessageAttestationClaimsV1 = serde_json::from_str(legacy).unwrap();
        claims.validate().unwrap();
        assert!(claims.reply_to_message_id.is_none());
        assert_eq!(serde_json::to_string(&claims).unwrap(), legacy);
        claims.reply_to_message_id = Some("received-original".into());
        let expected = format!(
            "{},\"replyToMessageId\":\"received-original\"}}",
            &legacy[..legacy.len() - 1]
        );
        assert_eq!(serde_json::to_string(&claims).unwrap(), expected);
        assert_eq!(
            serde_json::from_str::<PeerMessageAttestationClaimsV1>(&expected).unwrap(),
            claims
        );
        claims.reply_to_message_id = Some("not/a/message-id".into());
        assert!(claims.validate().is_err());
    }
    #[test]
    fn reply_capability_probe_has_no_route_proof_and_never_accepts_a_claimed_proof() {
        let request =
            r#"{"jsonrpc":"2.0","id":1,"method":"agentMessage/router/capabilities","params":{}}"#;
        assert!(PrivatePeerRouterRequest::decode(request).is_ok());
        let with_proof = request.replace(
            "\"params\":{}",
            "\"params\":{},\"kcoderPrivateAgentMessageRoute\":{}",
        );
        assert!(PrivatePeerRouterRequest::decode(&with_proof).is_err());
    }
}

/// Facts signed by the original Native holder after an authenticated device
/// channel supplied its challenge. Presence grants no message/workspace access.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSourcePresenceClaimsV1 {
    pub version: u32,
    pub purpose: String,
    pub nonce: String,
    pub source: SessionAddressV1,
    pub identity_epoch: String,
    pub lease_id: String,
}
impl PeerSourcePresenceClaimsV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.source.validate()?;
        if self.version != 1
            || self.purpose != PEER_SOURCE_PRESENCE_PURPOSE
            || self.nonce.len() < 32
            || !valid_agent_message_id(&self.nonce)
            || !valid_agent_message_id(&self.identity_epoch)
            || !valid_agent_message_id(&self.lease_id)
        {
            return Err("peer_source_presence_invalid");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedPeerSourcePresenceV1 {
    pub claims: PeerSourcePresenceClaimsV1,
    pub signature: Vec<u8>,
}

pub mod method {
    pub const PREFIX: &str = "agentMessage/router/";
    pub const IDENTITY: &str = "agentMessage/router/identity";
    pub const CAPABILITIES: &str = "agentMessage/router/capabilities";
    pub const SOURCE_PREPARE: &str = "agentMessage/router/sourcePrepare";
    pub const SOURCE_READ: &str = "agentMessage/router/sourceRead";
    pub const SOURCE_FIND: &str = "agentMessage/router/sourceFind";
    pub const SOURCE_LIST: &str = "agentMessage/router/sourceList";
    pub const SOURCE_MARK_DISPATCH: &str = "agentMessage/router/sourceMarkDispatch";
    pub const SOURCE_RECORD_RECEIPT: &str = "agentMessage/router/sourceRecordReceipt";
    pub const SOURCE_CHECK_ORIGINAL: &str = "agentMessage/router/sourceCheckOriginal";
    pub const SOURCE_CHECK_REPLY_ATTEMPT: &str = "agentMessage/router/sourceCheckReplyAttempt";
    pub const SOURCE_CHECK_WAKE_READ: &str = "agentMessage/router/sourceCheckWakeRead";
    pub const SOURCE_WAKE_READ_TARGET: &str = "agentMessage/router/sourceWakeReadTarget";
    pub const TARGETS: &str = "agentMessage/router/targets";
    pub const ACCEPT_FORWARDED: &str = "agentMessage/router/acceptForwarded";
    pub const QUERY_ORIGINAL: &str = "agentMessage/router/queryOriginal";
    pub const QUERY_ORIGINAL_DETAILS: &str = "agentMessage/router/queryOriginalDetails";
    /// Destination-side ReadSession; see `CAPABILITY_SESSION_READ_V1`.
    pub const READ: &str = "agentMessage/router/read";
}

/// Captured from the actual Native profile and workspace, never the Gateway display label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterIdentityV1 {
    pub target_id: String,
    pub workspace_id: String,
    pub principal: RetentionPrincipalV1,
    pub public_key: Vec<u8>,
    pub identity_epoch: String,
}

/// Feature facts from the actual private Native owner; never a route or access grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterCapabilitiesV1 {
    pub capabilities: Vec<String>,
}
impl PeerRouterIdentityV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_agent_message_id(&self.target_id)
            || !valid_agent_message_id(&self.workspace_id)
            || !valid_agent_message_id(&self.identity_epoch)
            || self.public_key.len() != 32
        {
            return Err("peer_router_invalid_identity");
        }
        if let RetentionPrincipalV1::VerifiedAccount { principal_id } = &self.principal
            && (principal_id.is_empty()
                || principal_id.len() > 256
                || principal_id.chars().any(char::is_control))
        {
            return Err("peer_router_invalid_principal");
        }
        Ok(())
    }
    pub fn contains(&self, address: &SessionAddressV1) -> bool {
        address.validate().is_ok()
            && self.target_id == address.target_id
            && self.workspace_id == address.workspace_id
    }
}

/// This proof is accepted only on an OS-parent-authenticated private transport.
/// Gateway must derive both endpoints from live authenticated brokers, recheck
/// current account generations and allowed targets, and remove this field from
/// every public request. It is not an independently verifiable bearer grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivatePeerRouteProofV1 {
    pub version: u32,
    pub purpose: String,
    pub authorization_id: String,
    pub source: PeerRouterIdentityV1,
    pub destination: PeerRouterIdentityV1,
}
impl PrivatePeerRouteProofV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.purpose != AGENT_MESSAGE_ROUTE_PURPOSE
            || !valid_agent_message_id(&self.authorization_id)
        {
            return Err("peer_router_invalid_private_proof");
        }
        self.source.validate()?;
        self.destination.validate()
    }
}

/// Immutable source facts signed before dispatch. Receiving hosts additionally
/// require a current private route proof and their own current destination policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerMessageAttestationClaimsV1 {
    pub version: u32,
    pub purpose: String,
    pub operation_id: String,
    pub source_address: SessionAddressV1,
    pub destination: SessionAddressV1,
    pub source_identity_epoch: String,
    pub client_message_id: String,
    pub mode: AgentMessageMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<String>,
    pub body_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
}
impl PeerMessageAttestationClaimsV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.source_address.validate()?;
        self.destination.validate()?;
        if self.version != 1
            || self.purpose != AGENT_MESSAGE_ROUTE_PURPOSE
            || self.source_address == self.destination
            || !valid_agent_message_id(&self.operation_id)
            || !valid_agent_message_id(&self.client_message_id)
            || !valid_agent_message_id(&self.source_identity_epoch)
            || self
                .reply_to_message_id
                .as_deref()
                .is_some_and(|id| !valid_agent_message_id(id))
            || self.body_sha256.len() != 64
            || !self
                .body_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || self
                .expected_turn_id
                .as_deref()
                .is_some_and(|id| !kcoder_types::valid_turn_attempt_component(id))
            || (self.expected_turn_id.is_some() && self.mode == AgentMessageMode::WakeIfIdle)
        {
            return Err("peer_router_invalid_attestation");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedPeerMessageAttestationV1 {
    pub claims: PeerMessageAttestationClaimsV1,
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerRouterStageV1 {
    Prepared,
    Dispatching,
    Receipted,
}

/// No plaintext body or credential is returned by source ledger reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterOperationV1 {
    pub operation_id: String,
    pub source_address: SessionAddressV1,
    pub destination: SessionAddressV1,
    pub body_sha256: String,
    pub stage: PeerRouterStageV1,
    pub attestation: SignedPeerMessageAttestationV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<AgentMessageReceipt>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterMessageV1 {
    pub client_message_id: String,
    pub mode: AgentMessageMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
}
impl PeerRouterMessageV1 {
    pub fn into_intent(
        self,
        destination: SessionAddressV1,
    ) -> kcoder_types::cross_session_messages::AgentMessageIntent {
        kcoder_types::cross_session_messages::AgentMessageIntent {
            target_thread_id: destination.thread_id.clone(),
            target_address: Some(destination),
            client_message_id: self.client_message_id,
            mode: self.mode,
            expected_turn_id: self.expected_turn_id,
            text: self.text,
            reply_to_message_id: self.reply_to_message_id,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterSourcePrepareParams {
    pub operation_id: String,
    pub source_thread_id: String,
    pub destination: SessionAddressV1,
    pub message: PeerRouterMessageV1,
}
/// The private Gateway asks the original Native holder to recheck a pending reply.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterSourceCheckReplyAttemptParams {
    pub attempt: kcoder_types::TurnAttemptIdentity,
    pub message: kcoder_types::cross_session_messages::AgentMessageIntent,
}
/// Private, read-only challenge to an outstanding request from this Native holder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PeerRouterWakeReadKind {
    Targets,
    Read,
    Get,
    ListReceipts,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterWakeReadCheck {
    pub request_id: String,
    pub attempt: kcoder_types::TurnAttemptIdentity,
    pub kind: PeerRouterWakeReadKind,
    pub payload: serde_json::Value,
}
/// Immutable locators. The Gateway still has to verify the original operation and both owners.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterWakeReadOrigin {
    pub sender: SessionAddressV1,
    pub recipient: SessionAddressV1,
    pub message_id: String,
    pub client_message_id: String,
    pub body_sha256: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterWakeReadTarget {
    pub attestation: SignedPeerMessageAttestationV1,
    pub query: kcoder_types::cross_session_messages::AgentMessageTargetsParams,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterOperationParams {
    pub operation_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterSourceFindParams {
    pub source_thread_id: String,
    pub query: crate::cross_session_messages::AgentMessageGetParams,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterRecordReceiptParams {
    pub operation_id: String,
    pub receipt: AgentMessageReceipt,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterForwardParams {
    pub attestation: SignedPeerMessageAttestationV1,
    pub message: PeerRouterMessageV1,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterQueryParams {
    pub attestation: SignedPeerMessageAttestationV1,
    pub query: crate::cross_session_messages::AgentMessageGetParams,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerRouterHistoryAccess {
    Observe,
    Append,
    Wake,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerRouterCheckOriginalParams {
    pub attestation: SignedPeerMessageAttestationV1,
    pub access: PeerRouterHistoryAccess,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<PeerRouterMessageV1>,
}

/// Decode the original bytes rather than a lossy Value projection. Derived
/// visitors reject duplicate fields in both the envelope and typed proof.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivatePeerRouterRequest {
    jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    params: Box<serde_json::value::RawValue>,
    #[serde(rename = "kcoderPrivateAgentMessageRoute")]
    pub proof: Option<PrivatePeerRouteProofV1>,
}
impl PrivatePeerRouterRequest {
    pub fn decode(raw: &str) -> Result<Self, &'static str> {
        let request: Self =
            serde_json::from_str(raw).map_err(|_| "peer_router_invalid_private_envelope")?;
        if request.jsonrpc != "2.0"
            || request.id.is_null()
            || !(request.id.is_string() || request.id.is_number())
            || !matches!(
                request.method.as_str(),
                method::IDENTITY
                    | method::CAPABILITIES
                    | ssh_parent::PEER_SSH_PARENT_BIND
                    | method::SOURCE_PREPARE
                    | method::SOURCE_READ
                    | method::SOURCE_FIND
                    | method::SOURCE_LIST
                    | method::SOURCE_MARK_DISPATCH
                    | method::SOURCE_RECORD_RECEIPT
                    | method::SOURCE_CHECK_ORIGINAL
                    | method::SOURCE_CHECK_REPLY_ATTEMPT
                    | method::SOURCE_CHECK_WAKE_READ
                    | method::SOURCE_WAKE_READ_TARGET
                    | method::TARGETS
                    | method::ACCEPT_FORWARDED
                    | method::QUERY_ORIGINAL
                    | method::QUERY_ORIGINAL_DETAILS
                    | method::READ
            )
        {
            return Err("peer_router_invalid_private_envelope");
        }
        if matches!(
            request.method.as_str(),
            method::IDENTITY | method::CAPABILITIES | ssh_parent::PEER_SSH_PARENT_BIND
        ) {
            if request.proof.is_some() {
                return Err("peer_router_unexpected_private_proof");
            }
        } else {
            request
                .proof
                .as_ref()
                .ok_or("peer_router_private_proof_required")?
                .validate()?;
        }
        Ok(request)
    }
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, &'static str> {
        serde_json::from_str(self.params.get()).map_err(|_| "peer_router_invalid_params")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_route_proof_has_a_distinct_purpose_and_validated_native_identities() {
        let identity = PeerRouterIdentityV1 {
            target_id: "native-a".into(),
            workspace_id: "workspace-a".into(),
            principal: RetentionPrincipalV1::LocalOs,
            public_key: vec![1; 32],
            identity_epoch: "epoch-a".into(),
        };
        let mut proof = PrivatePeerRouteProofV1 {
            version: 1,
            purpose: AGENT_MESSAGE_ROUTE_PURPOSE.into(),
            authorization_id: "route-a".into(),
            source: identity.clone(),
            destination: identity,
        };
        assert!(proof.validate().is_ok());
        proof.purpose = "migration".into();
        assert!(proof.validate().is_err());
        proof.purpose = AGENT_MESSAGE_ROUTE_PURPOSE.into();
        proof.destination.public_key.clear();
        assert!(proof.validate().is_err());
    }
    #[test]
    fn private_decoder_rejects_duplicate_envelopes_notifications_and_public_method_proofs() {
        let good =
            r#"{"jsonrpc":"2.0","id":1,"method":"agentMessage/router/identity","params":{}}"#;
        assert!(PrivatePeerRouterRequest::decode(good).is_ok());
        for raw in [
            r#"{"jsonrpc":"2.0","id":1,"id":2,"method":"agentMessage/router/identity","params":{}}"#,
            r#"{"jsonrpc":"2.0","method":"agentMessage/router/identity","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":null,"method":"agentMessage/router/identity","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"thread/agentMessage/send","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"agentMessage/router/sourceRead","params":{}}"#,
        ] {
            assert!(PrivatePeerRouterRequest::decode(raw).is_err());
        }
    }
}
