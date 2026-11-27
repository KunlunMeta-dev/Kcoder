//! Global session selectors. Addresses locate resources; they never grant access.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAddressV1 {
    pub target_id: String,
    pub workspace_id: String,
    pub thread_id: String,
}
impl SessionAddressV1 {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [&self.target_id, &self.workspace_id] {
            if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err("invalid session address scope selector");
            }
        }
        if !crate::cross_session_messages::valid_agent_message_id(&self.thread_id) {
            return Err("invalid session address thread selector");
        }
        Ok(())
    }
}
