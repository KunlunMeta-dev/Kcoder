//! Model intent and public preflight facts. Resolution does not reserve a budget.
use super::IntegrationNullable;
use crate::ModelConfigurationSummary;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum IntegrationModelSelectionIntent {
    InheritCurrent,
    Explicit {
        provider: String,
        model: String,
    },
    AutoPolicy {
        id: String,
        version: String,
    },
    VerifierLocked {
        provider: String,
        model: String,
        #[serde(rename = "configurationRevision")]
        configuration_revision: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationModelSelectionKind {
    InheritCurrent,
    Explicit,
    AutoPolicy,
    VerifierLocked,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelRequirements {
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub structured_output: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelResolutionRequest {
    pub selection: IntegrationModelSelectionIntent,
    #[serde(default)]
    pub requirements: IntegrationModelRequirements,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicyRef {
    pub id: String,
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationBudgetReservationState {
    NotReserved,
    Reserved,
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelBudget {
    pub reservation_state: IntegrationBudgetReservationState,
    pub cost_known: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelResolutionResult {
    pub selection_kind: IntegrationModelSelectionKind,
    pub model: ModelConfigurationSummary,
    pub policy_ref: IntegrationNullable<IntegrationModelPolicyRef>,
    pub budget: IntegrationModelBudget,
}
