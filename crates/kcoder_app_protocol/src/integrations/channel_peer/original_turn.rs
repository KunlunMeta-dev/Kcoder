//! Preserve the public turn request without importing host-local authorities.
use super::*;

pub(super) fn deserialize<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<crate::TurnStartParams, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let object = value
        .as_object()
        .ok_or_else(|| serde::de::Error::custom(invalid()))?;
    // Keep this private transport finite even though the compatibility public
    // DTO tolerates unknown fields. These are requests, never Native permits.
    const FIELDS: &[&str] = &[
        "clientPresentation",
        "asyncUserQuestions",
        "retention",
        "computerUse",
        "retryModelConfiguration",
        "retryFromTurnId",
        "retryFromAttemptId",
        "turnMode",
        "threadId",
        "input",
        "permissionMode",
        "clientMessageId",
        "resubmit",
        "retryOperationId",
        "model",
        "modelSelectionMode",
        "reasoningEffort",
        "proxyUrl",
        "serviceTier",
    ];
    if object.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err(serde::de::Error::custom(invalid()));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

pub(super) fn validate(turn: &crate::TurnStartParams) -> Result<(), String> {
    atom(&turn.thread_id)?;
    turn.validate_model_selection().map_err(str::to_owned)?;
    // The text transport cannot transfer retained-turn or desktop leases.
    // Reject explicitly instead of silently dropping the requested operation.
    if turn.retention.is_some() {
        return Err("TASK_UI_ORIGINAL_RETENTION_AUTHORITY_REQUIRED".into());
    }
    if turn.computer_use.is_some() {
        return Err("TASK_UI_ORIGINAL_DESKTOP_AUTHORITY_REQUIRED".into());
    }
    if let Some(retry) = &turn.retry_from_turn_id {
        atom(retry)?;
        atom(turn.retry_operation_id.as_deref().ok_or_else(invalid)?)?;
        if !turn.input.is_empty() {
            return Err(invalid());
        }
        return Ok(());
    }
    atom(turn.client_message_id.as_deref().ok_or_else(invalid)?)?;
    if turn.input.is_empty() || turn.input.len() > 16 {
        return Err(invalid());
    }
    let mut total = 0usize;
    let mut nonempty = false;
    for input in &turn.input {
        let crate::UserInput::Text { text } = input else {
            return Err("TASK_UI_ORIGINAL_ATTACHMENT_AUTHORITY_REQUIRED".into());
        };
        if text.contains("<kcoder_attachments ") {
            return Err("TASK_UI_ORIGINAL_ATTACHMENT_AUTHORITY_REQUIRED".into());
        }
        total = total.checked_add(text.len()).ok_or_else(invalid)?;
        nonempty |= !text.trim().is_empty();
    }
    if !nonempty || total > 256 * 1024 {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(declaration: Option<bool>) -> serde_json::Value {
        let scope = json!({"accountId":"owner","targetId":"target","workspaceId":"workspace",
            "identityGeneration":"epoch-1","targetRevision":"config-1"});
        let mut turn = json!({"threadId":"original-task","clientMessageId":"original-message",
            "input":[{"type":"text","text":"original user input"}]});
        if let Some(value) = declaration {
            turn["asyncUserQuestions"] = value.into();
        }
        json!({"kind":"ui_call","stream":{"id":"original-stream","hostEpoch":"original-host",
            "appServerEpoch":"original-app-server","scope":scope},"sequence":1,"requestId":42,
            "call":{"method":"task.turnStart","params":{"scope":scope,
                "sourceAuthorityEpoch":1,"turn":turn}}})
    }

    #[test]
    fn original_turn_roundtrips_gateway_async_question_declaration() {
        for declaration in [None, Some(false), Some(true)] {
            let value = frame(declaration);
            let decoded = decode_channel_peer_frame(&serde_json::to_vec(&value).unwrap())
                .expect("the Gateway's original client declaration must reach the task owner");
            assert!(ChannelPeerLane::Ui.accepts(&decoded));
            assert!(!ChannelPeerLane::Background.accepts(&decoded));
            assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        }
    }

    #[test]
    fn async_question_declaration_does_not_admit_authority_fields_or_invalid_types() {
        for field in [
            "trusted",
            "backgroundAuthorized",
            "nativePermit",
            "operator",
        ] {
            let mut value = frame(Some(true));
            value["call"]["params"]["turn"][field] = true.into();
            assert!(decode_channel_peer_frame(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        for invalid in [json!("true"), json!(1), json!({"approved":true})] {
            let mut value = frame(Some(true));
            value["call"]["params"]["turn"]["asyncUserQuestions"] = invalid;
            assert!(decode_channel_peer_frame(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }
}
