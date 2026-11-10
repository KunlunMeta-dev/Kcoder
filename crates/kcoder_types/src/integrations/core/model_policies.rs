//! Credential-free configured AUTO pools. Catalog entries are not execution grants.
use super::IntegrationModelPolicyRef;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicyCandidate {
    pub provider: String,
    pub model: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration_revision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicyDescriptor {
    pub reference: IntegrationModelPolicyRef,
    pub title: String,
    pub enabled: bool,
    /// Exact configuration order. No latency, quality, price or current readiness is implied.
    pub candidates: Vec<IntegrationModelPolicyCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicyCatalog {
    pub policies: Vec<IntegrationModelPolicyDescriptor>,
}
