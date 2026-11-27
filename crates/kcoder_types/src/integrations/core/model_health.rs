//! Observed provider health, separate from model grants, budget reservations and task outcomes.
use super::IntegrationModelPolicyRef;
use crate::ProviderFailureDetails;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationModelHealthState {
    Unknown,
    Healthy,
    CoolingDown,
    NeedsConfiguration,
    Probing,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelHealthObservation {
    pub provider: String,
    pub model: String,
    pub configuration_revision: String,
    pub state: IntegrationModelHealthState,
    pub consecutive_failures: u32,
    pub last_observed_at: Option<String>,
    pub cooldown_until: Option<String>,
    pub failure: Option<ProviderFailureDetails>,
    pub response_started: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelHealthReadParams {
    pub id: String,
    pub version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelHealthReport {
    pub policy_ref: IntegrationModelPolicyRef,
    pub observations: Vec<IntegrationModelHealthObservation>,
}
