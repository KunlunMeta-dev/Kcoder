//! Finite model-policy management; selection summaries do not authorize execution.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MODEL_POLICIES_V1: &str = "modelPoliciesV1";
pub const CAPABILITY_MODEL_HEALTH_V1: &str = "modelHealthV1";
pub const CAPABILITY_MODEL_USAGE_V1: &str = "modelUsageV1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum ModelPoliciesMethod {
    #[serde(rename = "integrations/models/readUsage")]
    ReadUsage,
    #[serde(rename = "integrations/models/readHealth")]
    ReadHealth,
    #[serde(rename = "integrations/models/readPolicies")]
    ReadPolicies,
    #[serde(rename = "integrations/models/resolveSelection")]
    ResolveSelection,
}
