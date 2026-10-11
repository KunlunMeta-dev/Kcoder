//! Task-list annotations are independent from an execution's business result.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskMetadata {
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(
        rename = "activeForm",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub active_form: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks: Vec<String>,
    #[serde(rename = "blockedBy", default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Value>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_task_metadata_keeps_the_same_field_names_and_defaults() {
        let value = serde_json::json!({"subject":"legacy","description":"work","activeForm":"Working","blockedBy":["1"],"metadata":{"enabled":false,"count":2}});
        let metadata: TaskMetadata = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(metadata).unwrap(), value);
        let empty: TaskMetadata = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(empty.subject.is_empty() && empty.blocks.is_empty() && empty.owner.is_none());
    }
}
