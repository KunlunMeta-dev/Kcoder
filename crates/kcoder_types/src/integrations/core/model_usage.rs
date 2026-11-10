//! Last actual provider-reported usage, never a budget or billing ledger.
use super::IntegrationModelPolicyRef;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelUsageObservation {
    pub provider: String,
    pub model: String,
    pub configuration_revision: String,
    pub last_observed_at: Option<String>,
    pub reported_input_tokens: Option<u32>,
    pub reported_output_tokens: Option<u32>,
    pub reported_total_tokens: Option<u32>,
    pub reported_cache_read_input_tokens: Option<u32>,
    pub reported_cache_creation_input_tokens: Option<u32>,
    /// Completeness requires field-presence-aware evidence; normalized counters alone remain partial.
    pub complete: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelUsageReport {
    pub policy_ref: IntegrationModelPolicyRef,
    pub observations: Vec<IntegrationModelUsageObservation>,
}
