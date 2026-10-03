use crate::ReasoningEffort;
use serde::{Deserialize, Serialize};

/// User-declared controls, not a claim that an upstream model was verified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelReasoningPolicy {
    pub mode: ReasoningControlMode,
    #[serde(default)]
    pub efforts: Vec<ReasoningEffort>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningControlMode {
    Hidden,
    Optional,
    AlwaysOn,
    AlwaysOff,
}
