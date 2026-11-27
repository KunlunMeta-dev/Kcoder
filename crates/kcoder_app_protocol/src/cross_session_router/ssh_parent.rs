//! Peer-only SSH parent negotiation. Offers and endpoint facts are not grants.
use super::PeerRouterIdentityV1;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_PEER_SSH_PARENT_OFFER_V1: &str = "peerSshParentOfferV1";
pub const PEER_SSH_PARENT_PURPOSE: &str = "kcoder.peer-message.ssh-parent.v1";
pub const PEER_SSH_PARENT_BIND: &str = "agentMessage/router/sshParentBind";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshParentBindParamsV1 {
    pub version: u32,
    pub purpose: String,
    pub nonce: String,
}
impl PeerSshParentBindParamsV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 || self.purpose != PEER_SSH_PARENT_PURPOSE || !valid_nonce(&self.nonce)
        {
            return Err("peer_ssh_parent_invalid_binding");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSshParentBindingV1 {
    pub version: u32,
    pub purpose: String,
    pub nonce: String,
    pub process_instance: String,
    pub account_uid: u32,
    pub identity: PeerRouterIdentityV1,
}
impl PeerSshParentBindingV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.purpose != PEER_SSH_PARENT_PURPOSE
            || !valid_nonce(&self.nonce)
            || !valid_nonce(&self.process_instance)
        {
            return Err("peer_ssh_parent_invalid_binding");
        }
        self.identity.validate()
    }
}

pub fn valid_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_has_a_distinct_purpose_and_bounded_nonce() {
        let mut params = PeerSshParentBindParamsV1 {
            version: 1,
            purpose: PEER_SSH_PARENT_PURPOSE.into(),
            nonce: "a".repeat(64),
        };
        assert!(params.validate().is_ok());
        params.purpose = super::super::AGENT_MESSAGE_ROUTE_PURPOSE.into();
        assert!(params.validate().is_err());
        params.purpose = PEER_SSH_PARENT_PURPOSE.into();
        params.nonce = "A".repeat(64);
        assert!(params.validate().is_err());
        assert!(serde_json::from_str::<PeerSshParentBindParamsV1>(
            r#"{"version":1,"purpose":"kcoder.peer-message.ssh-parent.v1","nonce":"a","nonce":"b"}"#
        ).is_err());
    }

    #[test]
    fn bind_stays_inside_the_strict_private_decoder() {
        use super::super::PrivatePeerRouterRequest;
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"agentMessage/router/sshParentBind","params":{"version":1,"purpose":"kcoder.peer-message.ssh-parent.v1","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}"#;
        let decoded = PrivatePeerRouterRequest::decode(request).unwrap();
        decoded
            .params::<PeerSshParentBindParamsV1>()
            .unwrap()
            .validate()
            .unwrap();
        assert!(
            PrivatePeerRouterRequest::decode(&request.replace("\"id\":1,", "\"id\":1,\"id\":2,"))
                .is_err()
        );
        let duplicate = request.replace("\"version\":1,", "\"version\":1,\"version\":1,");
        assert!(
            PrivatePeerRouterRequest::decode(&duplicate)
                .unwrap()
                .params::<PeerSshParentBindParamsV1>()
                .is_err()
        );
    }
}
