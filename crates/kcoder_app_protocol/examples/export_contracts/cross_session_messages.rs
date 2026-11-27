//! Draft independent-session contracts. Exporting shapes never enables host operations.
use serde_json::Value;
use std::collections::BTreeMap;

/// Namespace only schema type names and references, preserving serde wire shapes.
/// Independent-session receipts must not replace existing subagent receipt types.
fn namespace_schema(value: &mut Value) -> Result<(), Box<dyn std::error::Error>> {
    match value {
        Value::Object(object) => {
            if let Some(Value::String(reference)) = object.get_mut("$ref")
                && let Some(suffix) = reference.strip_prefix("#/definitions/AgentMessage")
            {
                *reference = format!("#/definitions/CrossSessionMessage{suffix}");
            }
            if let Some(Value::String(title)) = object.get_mut("title")
                && let Some(suffix) = title.strip_prefix("AgentMessage")
            {
                *title = format!("CrossSessionMessage{suffix}");
            }
            if let Some(Value::Object(definitions)) = object.get_mut("definitions") {
                let original = std::mem::take(definitions);
                for (name, schema) in original {
                    let name = name.strip_prefix("AgentMessage").map_or_else(
                        || name.clone(),
                        |suffix| format!("CrossSessionMessage{suffix}"),
                    );
                    if definitions.insert(name, schema).is_some() {
                        return Err("duplicate cross-session schema definition".into());
                    }
                }
            }
            for child in object.values_mut() {
                namespace_schema(child)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                namespace_schema(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    use kcoder_app_protocol::cross_session_messages::*;
    macro_rules! contracts {
        ($($name:ident => $ty:ty),* $(,)?) => { $(
            super::register::<$ty>(stringify!($name), fixtures, schemas)?;
            let schema = schemas.get_mut(stringify!($name)).ok_or("missing cross-session schema")?;
            namespace_schema(schema)?;
            schema["title"] = stringify!($name).into();
        )* };
    }
    contracts! {
        PeerAgentMessageV1 => kcoder_types::peer_agent_message::PeerAgentMessageV1,
        CrossSessionMessageTargetsParams => AgentMessageTargetsParams,
        CrossSessionMessageTargetPresence => AgentMessageTargetPresence,
        CrossSessionMessageTargetRunSummary => AgentMessageTargetRunSummary,
        CrossSessionMessageLastTurn => AgentMessageLastTurn,
        CrossSessionMessageTarget => AgentMessageTarget,
        CrossSessionMessageTargetsResult => AgentMessageTargetsResult,
        CrossSessionMessageDiscoveryCoverage => AgentMessageDiscoveryCoverage,
        CrossSessionMessageGetParams => AgentMessageGetParams,
        CrossSessionMessageSendParams => AgentMessageSendParams,
        CrossSessionMessageMode => AgentMessageMode,
        CrossSessionMessageStatus => AgentMessageStatus,
        CrossSessionMessageReceipt => AgentMessageReceipt,
        CrossSessionMessageDiscoveryCompleteness => AgentMessageDiscoveryCompleteness,
        CrossSessionMessagePolicyResult => AgentMessagePolicyResult,
        CrossSessionMessagePolicyReadParams => AgentMessagePolicyReadParams,
        CrossSessionMessagePolicySaveParams => AgentMessagePolicySaveParams,
        CrossSessionMessageResolveParams => AgentMessageResolveParams,
        CrossSessionMessageResolveResult => AgentMessageResolveResult,
        CrossSessionMessageTargetsRpcParams => AgentMessageTargetsRpcParams,
        CrossSessionMessageSendRpcParams => AgentMessageSendRpcParams,
        CrossSessionMessageGetRpcParams => AgentMessageGetRpcParams,
        CrossSessionMessageGetResult => AgentMessageGetResult,
        CrossSessionMessageReceiptListParams => CrossSessionMessageReceiptListParams,
        CrossSessionMessageReceiptListRpcParams => CrossSessionMessageReceiptListRpcParams,
        CrossSessionMessageReceiptListEntry => CrossSessionMessageReceiptListEntry,
        CrossSessionMessageReceiptListResult => CrossSessionMessageReceiptListResult,
        CrossSessionMessageSessionReadRpcParams => SessionReadRpcParams,
        CrossSessionMessageSessionReadOutcome => SessionReadOutcome,
    }
    Ok(())
}
