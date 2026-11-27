//! An original task view attaches to an existing Core without a Channel Main.
use super::*;

/// Correlation for one authenticated Native UI stream, never a task grant.
/// The receiver must check its actual OS peer, Native scope and task access.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskUiRegistration {
    pub nonce: String,
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    pub expires_at_ms: u64,
    pub initialize: ChannelPeerInitialize,
    #[serde(deserialize_with = "super::deserialize_original_task_resume")]
    pub resume: crate::ThreadResumeParams,
}

impl ChannelPeerTaskUiRegistration {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        self.initialize.validate()?;
        atom(&self.resume.thread_id)?;
        if self.nonce.len() != 32
            || !self.nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
            || self.source_authority_epoch == 0
            || self.expires_at_ms == 0
            || self
                .resume
                .history
                .as_ref()
                .is_some_and(|history| !history.is_valid())
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn original() -> serde_json::Value {
        serde_json::json!({
            "nonce":"0123456789abcdef0123456789abcdef",
            "scope":{"accountId":"owner","targetId":"target","workspaceId":"workspace",
                "identityGeneration":"1","targetRevision":"1"},
            "sourceAuthorityEpoch":1,"expiresAtMs":1,
            "initialize":{"protocolVersion":"2026-07-27","clientInfo":{"name":"original-task-ui","version":"1"},
                "capabilities":{"experimental":{"taskSourcesV1":true}}},
            "resume":{"threadId":"original-task"}
        })
    }

    #[test]
    fn task_registration_has_no_channel_or_actor_constructor() {
        let value = original();
        let registration: ChannelPeerTaskUiRegistration =
            serde_json::from_value(value.clone()).unwrap();
        registration.validate().unwrap();
        for name in [
            "actor",
            "trusted",
            "role",
            "connectionId",
            "bindingRef",
            "operationId",
        ] {
            let mut changed = value.clone();
            changed[name] = serde_json::json!("caller-claim");
            assert!(serde_json::from_value::<ChannelPeerTaskUiRegistration>(changed).is_err());
        }
        let mut changed = value;
        changed["resume"]["settingsTemplate"] = serde_json::json!("replacement");
        assert!(serde_json::from_value::<ChannelPeerTaskUiRegistration>(changed).is_err());
    }

    #[test]
    fn task_registration_keeps_finite_original_resume_identity() {
        for name in ["sourceAuthorityEpoch", "expiresAtMs"] {
            let mut value = original();
            value[name] = serde_json::json!(0);
            let input: ChannelPeerTaskUiRegistration = serde_json::from_value(value).unwrap();
            assert!(input.validate().is_err());
        }
        let mut value = original();
        value["resume"]["history"] = serde_json::json!({"limit":0});
        let input: ChannelPeerTaskUiRegistration = serde_json::from_value(value).unwrap();
        assert!(input.validate().is_err());
    }
}
