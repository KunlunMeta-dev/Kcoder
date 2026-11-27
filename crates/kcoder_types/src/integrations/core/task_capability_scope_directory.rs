//! Saved source-binding discovery is data observation, never live authority.
use super::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeDirectoryReadParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}
impl IntegrationTaskCapabilityScopeDirectoryReadParams {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        if let Some(thread) = &self.thread_id {
            id(thread, "threadId")?;
        }
        if let Some(cursor) = &self.cursor {
            id(cursor, "cursor")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationTaskCapabilityScopeDirectoryState {
    SavedOnly,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeDirectoryEntry {
    pub reference_id: String,
    pub target: Option<IntegrationTaskCapabilityScopeControlTarget>,
    pub saved_snapshot: Option<IntegrationTaskCapabilityScopeSnapshot>,
    pub observation_state: IntegrationTaskCapabilityScopeDirectoryState,
    pub reason_code: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationTaskCapabilityScopeDirectorySnapshot {
    pub entries: Vec<IntegrationTaskCapabilityScopeDirectoryEntry>,
    pub next_cursor: Option<String>,
    pub observation_state: IntegrationTaskCapabilityScopeDirectoryState,
    pub reason_code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn saved_directory_never_serializes_saved_data_as_live_ready_authority() {
        assert!(
            serde_json::from_value::<IntegrationTaskCapabilityScopeDirectoryState>(json!("ready"))
                .is_err()
        );
        assert!(
            serde_json::from_value::<IntegrationTaskCapabilityScopeDirectoryReadParams>(
                json!({"trusted":true})
            )
            .is_err()
        );
        let unknown: IntegrationTaskCapabilityScopeDirectorySnapshot = serde_json::from_value(json!({"entries":[],"nextCursor":null,"observationState":"unknown","reasonCode":"TASK_CAPABILITY_SCOPE_BINDINGS_NOT_OBSERVED"})).unwrap();
        assert_eq!(
            unknown.observation_state,
            IntegrationTaskCapabilityScopeDirectoryState::Unknown
        );
    }
}
