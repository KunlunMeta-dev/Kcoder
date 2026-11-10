//! Finite original UI input, separate from SDK/operator execution authority.
use super::*;
#[path = "original_turn.rs"]
mod original_turn;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskTurnStart {
    pub scope: IntegrationScope,
    pub source_authority_epoch: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding_ref: Option<IntegrationRevisionRef>,
    #[serde(deserialize_with = "original_turn::deserialize")]
    pub turn: crate::TurnStartParams,
}
impl ChannelPeerTaskTurnStart {
    pub fn validate(&self) -> Result<(), String> {
        self.scope.validate().map_err(|_| invalid())?;
        if let Some(binding) = &self.binding_ref {
            binding.validate().map_err(|_| invalid())?;
        }
        if self.source_authority_epoch == 0 {
            return Err(invalid());
        }
        original_turn::validate(&self.turn)
    }
    /// Preserve every public turn option for the ordinary Core dispatcher.
    /// Requested options do not replace its capability or authority checks.
    pub fn original(&self) -> Result<crate::TurnStartParams, String> {
        self.validate()?;
        Ok(self.turn.clone())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelPeerTaskRequestRejected {
    pub thread_id: String,
    pub code: i64,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> serde_json::Value {
        serde_json::json!({"scope":{"accountId":"owner","targetId":"target",
            "workspaceId":"workspace","identityGeneration":"1","targetRevision":"1"},
            "sourceAuthorityEpoch":1,"bindingRef":{"id":"binding","revision":"1"},
            "turn":{"threadId":"task","clientMessageId":"stable-message",
                "input":[{"type":"text","text":"hello"}]}})
    }
    #[test]
    fn original_turn_keeps_identity_and_rejects_undeclared_authority() {
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(request()).unwrap();
        let original = input.original().unwrap();
        assert_eq!(original.thread_id, "task");
        assert_eq!(
            original.client_message_id.as_deref(),
            Some("stable-message")
        );
        assert!(original.model.is_none() && original.permission_mode.is_none());
        assert!(original.computer_use.is_none() && original.retention.is_none());
        for key in [
            "role",
            "trusted",
            "model",
            "permissionMode",
            "input",
            "original",
        ] {
            let mut value = request();
            value[key] = serde_json::json!(true);
            assert!(serde_json::from_value::<ChannelPeerTaskTurnStart>(value).is_err());
        }
    }
    #[test]
    fn turn_requires_stable_message_identity_and_does_not_import_attachment_paths() {
        for value in [
            serde_json::json!({"threadId":"task","clientMessageId":"","input":[{"type":"text","text":"hello"}]}),
            serde_json::json!({"threadId":"task","clientMessageId":"stable-message","input":[{"type":"text","text":" "}]}),
            serde_json::json!({"threadId":"task","clientMessageId":"stable-message","input":[{"type":"text","text":"<kcoder_attachments file=private>"}]}),
        ] {
            let mut input = request();
            input["turn"] = value;
            let input: ChannelPeerTaskTurnStart = serde_json::from_value(input).unwrap();
            assert!(input.original().is_err());
        }
    }

    #[test]
    fn original_turn_preserves_model_permissions_presentation_and_retry_options() {
        let mut value = request();
        let turn = &mut value["turn"];
        turn["model"] = serde_json::json!("provider::model");
        turn["modelSelectionMode"] = serde_json::json!("explicit");
        turn["reasoningEffort"] = serde_json::json!("high");
        turn["proxyUrl"] = serde_json::json!("");
        turn["serviceTier"] = serde_json::json!("default");
        turn["permissionMode"] = serde_json::json!("default");
        turn["turnMode"] = serde_json::json!("standard");
        turn["clientPresentation"] = serde_json::json!({"version":1,"studioWorkMode":"kcoder"});
        turn["resubmit"] = serde_json::json!(true);
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(value.clone()).unwrap();
        let original: crate::TurnStartParams =
            serde_json::from_value(value["turn"].clone()).unwrap();
        assert_eq!(input.original().unwrap(), original);
        value["turn"]["input"] = serde_json::json!([]);
        value["turn"]
            .as_object_mut()
            .unwrap()
            .remove("clientMessageId");
        value["turn"]["retryFromTurnId"] = serde_json::json!("failed-turn");
        value["turn"]["retryFromAttemptId"] = serde_json::json!("failed-attempt");
        value["turn"]["retryOperationId"] = serde_json::json!("stable-recovery");
        value["turn"]["retryModelConfiguration"] = serde_json::json!("current");
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(value.clone()).unwrap();
        let original: crate::TurnStartParams =
            serde_json::from_value(value["turn"].clone()).unwrap();
        assert_eq!(input.original().unwrap(), original);
        value["turn"]["role"] = serde_json::json!("native");
        assert!(serde_json::from_value::<ChannelPeerTaskTurnStart>(value).is_err());
    }

    #[test]
    fn original_turn_rejects_untransferred_host_authority_and_invalid_recovery() {
        let mut value = request();
        value["turn"]["computerUse"] = serde_json::json!({"approved":true,
            "target":"local_windows_desktop"});
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(value).unwrap();
        assert_eq!(
            input.original().unwrap_err(),
            "TASK_UI_ORIGINAL_DESKTOP_AUTHORITY_REQUIRED"
        );
        let mut value = request();
        value["turn"]["input"] = serde_json::json!([{"type":"image","url":"private-image"}]);
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(value).unwrap();
        assert_eq!(
            input.original().unwrap_err(),
            "TASK_UI_ORIGINAL_ATTACHMENT_AUTHORITY_REQUIRED"
        );
        let mut value = request();
        value["turn"]["retryFromTurnId"] = serde_json::json!("failed-turn");
        value["turn"]["retryOperationId"] = serde_json::json!("stable-recovery");
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(value).unwrap();
        assert!(
            input.original().is_err(),
            "Recovery cannot append a new user input"
        );
        let mut value = request();
        value["turn"]["modelSelectionMode"] = serde_json::json!("follow_target_default");
        value["turn"]["model"] = serde_json::json!("provider::model");
        let input: ChannelPeerTaskTurnStart = serde_json::from_value(value).unwrap();
        assert!(
            input.original().is_err(),
            "Keep the public model-selection invariant"
        );
    }
}
