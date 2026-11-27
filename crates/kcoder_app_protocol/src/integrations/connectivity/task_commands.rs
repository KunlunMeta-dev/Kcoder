//! Private SDK commands contain no caller-selected task or execution policy.
use kcoder_types::integrations::connectivity::MessagingPlatform;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelTaskCommand {
    pub source: ChannelTaskCommandSource,
    pub command: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelTaskCommandSource {
    pub kind: String,
    pub platform: MessagingPlatform,
    pub channel_id: String,
    pub ingress_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_command_cannot_supply_a_task_or_execution_overrides() {
        let input = serde_json::json!({"source":{"kind":"channel","platform":"feishu","channelId":"connection-2","ingressId":"trusted-inbox"},"command":"new"});
        assert!(serde_json::from_value::<ChannelTaskCommand>(input.clone()).is_ok());
        for field in [
            "threadId",
            "model",
            "permissionMode",
            "history",
            "agentDefinition",
            "approval",
        ] {
            let mut changed = input.clone();
            changed[field] = serde_json::json!("caller-override");
            assert!(
                serde_json::from_value::<ChannelTaskCommand>(changed).is_err(),
                "{field}"
            );
        }
    }
}
