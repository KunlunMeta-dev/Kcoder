//! Reviewed observer contracts preserve legacy requests without granting control.
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn register(
    fixtures: &mut Value,
    schemas: &mut BTreeMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error>> {
    macro_rules! contract {
        ($($name:ident),* $(,)?) => { $(
            super::register::<kcoder_app_protocol::$name>(stringify!($name), fixtures, schemas)?;
        )* };
    }
    contract! {
        AgentDefinitionRef,
        AgentTaskBinding,
        ThreadExpertChange,
        ThreadExpertParams,
        ThreadExpertResult,
        ThreadExpertTurn,
        ChannelTaskSource,
        AgentTaskSource,
        AgentStreamCloseReason,
        AgentStreamClosedParams,
        AgentStreamSubscribeParams,
        AgentLiveReadParams,
        AgentLiveReadResult,
        AgentArtifactKind,
        AgentArtifactReadParams,
        AgentArtifactReadResult,
        AgentSteerParams,
        AgentSteerResult,
        AgentMessageReadParams,
        AgentMessageReadResult,
    }
    Ok(())
}
