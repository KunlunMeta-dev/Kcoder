//! Optional next-turn configuration on the original task, never an execution grant.
use crate::{AgentDefinitionRef, AgentTaskBinding};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_AGENT_TURN_CONFIGURATION_V1: &str = "agentTurnConfigurationV1";
pub const METHOD_THREAD_EXPERT: &str = "thread/expert";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadExpertChange {
    pub expected_revision: u64,
    #[serde(deserialize_with = "required_expert")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_expert_schema")
    )]
    pub expert: Option<AgentDefinitionRef>,
}
#[cfg(feature = "json-schema")]
fn nullable_expert_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<AgentDefinitionRef> as schemars::JsonSchema>::json_schema(generator)
}
fn required_expert<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<AgentDefinitionRef>, D::Error> {
    Option::deserialize(d)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadExpertParams {
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<ThreadExpertChange>,
}
impl ThreadExpertParams {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.thread_id.is_empty()
            || self.thread_id.len() > 256
            || self.thread_id.chars().any(char::is_control)
            || self
                .change
                .as_ref()
                .and_then(|change| change.expert.as_ref())
                .is_some_and(|expert| !expert.is_valid())
        {
            return Err("AGENT_CONFIGURATION_INVALID");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadExpertTurn {
    pub identity: kcoder_types::TurnAttemptIdentity,
    pub selection_revision: u64,
    pub expert: Option<AgentTaskBinding>,
    pub personalization_revision: Option<u64>,
    pub effective_definition_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadExpertResult {
    pub thread_id: String,
    pub revision: u64,
    pub expert: Option<AgentTaskBinding>,
    pub turns: Vec<ThreadExpertTurn>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selecting_none_requires_explicit_null_and_cannot_import_permissions() {
        let read: ThreadExpertParams =
            serde_json::from_value(serde_json::json!({"threadId":"task"})).unwrap();
        assert!(read.change.is_none());
        let clear: ThreadExpertParams = serde_json::from_value(
            serde_json::json!({"threadId":"task","change":{"expectedRevision":1,"expert":null}}),
        )
        .unwrap();
        assert!(clear.change.unwrap().expert.is_none());
        for change in [
            serde_json::json!({"expectedRevision":1}),
            serde_json::json!({"expectedRevision":1,"expert":null,"permissionMode":"bypass"}),
        ] {
            assert!(
                serde_json::from_value::<ThreadExpertParams>(
                    serde_json::json!({"threadId":"task","change":change})
                )
                .is_err()
            );
        }
    }
}
