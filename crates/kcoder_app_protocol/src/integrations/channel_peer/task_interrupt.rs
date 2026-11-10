//! An explicit original UI stop names one exact task and turn.
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskInterrupt {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<IntegrationRevisionRef>,
    pub thread_id: String,
    pub turn_id: String,
}
impl ChannelPeerTaskInterrupt {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if let Some(binding) = &self.binding_ref {
            binding.validate().map_err(|_| invalid())?;
        }
        atom(&self.thread_id)?;
        atom(&self.turn_id)?;
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn original(&self) -> Result<crate::TurnInterruptParams, String> {
        self.validate()?;
        Ok(crate::TurnInterruptParams {
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskInterrupted {
    pub thread_id: String,
    pub turn_id: String,
    pub interrupted: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> serde_json::Value {
        serde_json::json!({"scope":{"accountId":"owner","targetId":"target",
            "workspaceId":"workspace","identityGeneration":"1","targetRevision":"1"},
            "sourceAuthorityEpoch":1,"bindingRef":{"id":"binding","revision":"1"},
            "threadId":"original-task","turnId":"original-turn"})
    }
    #[test]
    fn stop_preserves_exact_original_identity_and_cannot_widen_to_any_turn() {
        let input: ChannelPeerTaskInterrupt = serde_json::from_value(request()).unwrap();
        let original = input.original().unwrap();
        assert_eq!(original.thread_id, "original-task");
        assert_eq!(original.turn_id, "original-turn");
        for key in ["threadId", "turnId"] {
            let mut value = request();
            value[key] = serde_json::json!("");
            let input: ChannelPeerTaskInterrupt = serde_json::from_value(value).unwrap();
            assert!(input.original().is_err());
            let mut value = request();
            value.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<ChannelPeerTaskInterrupt>(value).is_err());
        }
    }
    #[test]
    fn stop_cannot_import_an_actor_or_execution_override() {
        for key in [
            "actor",
            "trusted",
            "model",
            "permissionMode",
            "input",
            "interruptAll",
        ] {
            let mut value = request();
            value[key] = serde_json::json!(true);
            assert!(serde_json::from_value::<ChannelPeerTaskInterrupt>(value).is_err());
        }
        let mut value = request();
        value["sourceAuthorityEpoch"] = serde_json::json!(0);
        let input: ChannelPeerTaskInterrupt = serde_json::from_value(value).unwrap();
        assert!(input.original().is_err());
    }
}
