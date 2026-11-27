//! Inline tool observations are bounded before projection into 2 MiB JSONL.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolOutputImage {
    pub mime_type: String,
    pub data: String,
}
