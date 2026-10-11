use crate::BackgroundRunKey;
use serde::{Deserialize, Serialize};

/// Runtime-bound origin of a user interaction. Never accepted from model tool arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAgent {
    pub parent_session_id: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_run: Option<BackgroundRunKey>,
}
