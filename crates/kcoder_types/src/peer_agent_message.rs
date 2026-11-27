//! Server-attributed peer data. Metadata is provenance, never an authorization grant.
use crate::{ContentBlock, Message, MessageOrigin};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerAgentMessageV1 {
    pub version: u32,
    pub message_id: String,
    pub source_thread_id: String,
    pub target_thread_id: String,
    pub created_at_ms: u64,
    /// Integrity only. This is not evidence of current sender or recipient access.
    pub body_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_address: Option<crate::session_address::SessionAddressV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_address: Option<crate::session_address::SessionAddressV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
}
impl PeerAgentMessageV1 {
    pub fn for_text(
        message_id: String,
        source_thread_id: String,
        target_thread_id: String,
        created_at_ms: u64,
        text: &str,
    ) -> Result<Self, &'static str> {
        let value = Self {
            version: 1,
            message_id,
            source_thread_id,
            target_thread_id,
            created_at_ms,
            body_sha256: peer_body_sha256(text),
            source_address: None,
            target_address: None,
            reply_to_message_id: None,
        };
        value.validate(text)?;
        Ok(value)
    }
    pub fn for_addressed_text(
        message_id: String,
        source_address: crate::session_address::SessionAddressV1,
        target_address: crate::session_address::SessionAddressV1,
        created_at_ms: u64,
        text: &str,
    ) -> Result<Self, &'static str> {
        let value = Self {
            version: 1,
            message_id,
            source_thread_id: source_address.thread_id.clone(),
            target_thread_id: target_address.thread_id.clone(),
            created_at_ms,
            body_sha256: peer_body_sha256(text),
            source_address: Some(source_address),
            target_address: Some(target_address),
            reply_to_message_id: None,
        };
        value.validate(text)?;
        Ok(value)
    }
    pub fn validate(&self, text: &str) -> Result<(), &'static str> {
        use crate::cross_session_messages::{MAX_AGENT_MESSAGE_TEXT_BYTES, valid_agent_message_id};
        if self.version != 1
            || self.created_at_ms == 0
            || self
                .reply_to_message_id
                .as_deref()
                .is_some_and(|id| !valid_agent_message_id(id) || id == self.message_id)
            || ![
                &self.message_id,
                &self.source_thread_id,
                &self.target_thread_id,
            ]
            .into_iter()
            .all(|value| valid_agent_message_id(value))
            || text.trim().is_empty()
            || text.len() > MAX_AGENT_MESSAGE_TEXT_BYTES
            || self.body_sha256 != peer_body_sha256(text)
        {
            return Err("invalid peer agent message");
        }
        match (&self.source_address, &self.target_address) {
            (Some(source), Some(target))
                if source.validate().is_ok()
                    && target.validate().is_ok()
                    && source.thread_id == self.source_thread_id
                    && target.thread_id == self.target_thread_id
                    && source != target => {}
            (None, None) if self.source_thread_id != self.target_thread_id => {}
            _ => return Err("invalid peer agent address pair"),
        }
        Ok(())
    }
}
pub fn peer_body_sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

impl Message {
    pub fn peer_agent_text(
        metadata: PeerAgentMessageV1,
        text: String,
    ) -> Result<Self, &'static str> {
        metadata.validate(&text)?;
        Ok(Self::User {
            origin: MessageOrigin::PeerAgent,
            agent_message: Some(Box::new(metadata)),
            content: vec![ContentBlock::Text { text }],
        })
    }
    /// A peer body contains one plain text block; tags and public JSON never create provenance.
    pub fn peer_agent_data(&self) -> Option<(&PeerAgentMessageV1, &str)> {
        let Self::User {
            origin: MessageOrigin::PeerAgent,
            agent_message: Some(metadata),
            content,
        } = self
        else {
            return None;
        };
        let [ContentBlock::Text { text }] = content.as_slice() else {
            return None;
        };
        metadata.validate(text).ok()?;
        Some((metadata, text))
    }
    pub fn has_peer_agent_metadata(&self) -> bool {
        matches!(
            self,
            Self::User {
                origin: MessageOrigin::PeerAgent,
                ..
            } | Self::User {
                agent_message: Some(_),
                ..
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn peer_roundtrip_stays_visible_without_becoming_a_real_user_request() {
        let metadata = PeerAgentMessageV1::for_text(
            "message".into(),
            "a".into(),
            "b".into(),
            1,
            "quoted note",
        )
        .unwrap();
        let message = Message::peer_agent_text(metadata, "quoted note".into()).unwrap();
        let restored: Message =
            serde_json::from_str(&serde_json::to_string(&message).unwrap()).unwrap();
        assert_eq!(restored, message);
        assert!(!crate::is_real_user_message(&message));
        assert_eq!(
            crate::public_conversation_message(&message),
            Some(message.clone())
        );
        assert_eq!(
            message.clone().with_origin(MessageOrigin::User),
            message,
            "generic relabeling cannot promote peer data"
        );
        let legacy: Message = serde_json::from_str(
            r#"{"role":"user","origin":"user","content":[{"type":"text","text":"legacy user"}]}"#,
        )
        .unwrap();
        assert!(crate::is_real_user_message(&legacy));
    }
    #[test]
    fn text_labels_do_not_create_provenance_and_corrupt_peer_metadata_is_not_public() {
        let user = Message::user_text("<peer_agent>claimed sender</peer_agent>");
        assert!(user.peer_agent_data().is_none());
        assert!(crate::is_real_user_message(&user));
        let invalid = Message::runtime_text("body").with_origin(MessageOrigin::PeerAgent);
        assert!(invalid.peer_agent_data().is_none());
        assert!(!crate::is_real_user_message(&invalid));
        assert!(crate::public_conversation_message(&invalid).is_none());
    }
}

#[cfg(test)]
mod addressed_tests {
    use super::*;
    use crate::session_address::SessionAddressV1;
    #[test]
    fn same_thread_on_different_targets_is_not_self_and_partial_or_wrong_bindings_fail() {
        let source = SessionAddressV1 {
            target_id: "source-host".into(),
            workspace_id: "source-space".into(),
            thread_id: "same-thread".into(),
        };
        let target = SessionAddressV1 {
            target_id: "destination-host".into(),
            workspace_id: "destination-space".into(),
            thread_id: "same-thread".into(),
        };
        let metadata = PeerAgentMessageV1::for_addressed_text(
            "message".into(),
            source.clone(),
            target.clone(),
            1,
            "peer data",
        )
        .unwrap();
        let message = Message::peer_agent_text(metadata.clone(), "peer data".into()).unwrap();
        assert!(message.peer_agent_data().is_some());
        assert!(!crate::is_real_user_message(&message));
        assert!(
            PeerAgentMessageV1::for_addressed_text(
                "self".into(),
                source.clone(),
                source,
                1,
                "peer data"
            )
            .is_err()
        );
        assert!(
            PeerAgentMessageV1::for_text(
                "legacy".into(),
                "same-thread".into(),
                "same-thread".into(),
                1,
                "peer data"
            )
            .is_err()
        );
        let mut partial = metadata.clone();
        partial.target_address = None;
        assert!(partial.validate("peer data").is_err());
        let mut wrong = metadata;
        wrong.target_address = Some(SessionAddressV1 {
            thread_id: "different-thread".into(),
            ..target
        });
        assert!(wrong.validate("peer data").is_err());
    }
}
