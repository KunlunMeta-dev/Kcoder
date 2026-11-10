//! Native user-profile policy configuration. These references never grant execution.
use super::{IntegrationModelPolicyCandidate, IntegrationOperationReceipt};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicyDefinition {
    pub id: String,
    pub title: String,
    pub enabled: bool,
    pub candidates: Vec<IntegrationModelPolicyCandidate>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicySettingsSnapshot {
    pub revision: String,
    pub policies: Vec<IntegrationModelPolicyDefinition>,
    pub models: Vec<IntegrationModelPolicyAvailableModel>,
    pub models_truncated: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicyAvailableModel {
    pub provider: String,
    pub model: String,
    pub configuration_revision: Option<String>,
    /// Actual configuration/credential metadata; execution still needs its native policy and budget.
    pub available: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicySettingsSaveParams {
    pub policies: Vec<IntegrationModelPolicyDefinition>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicySettingsSaveResult {
    pub operation: IntegrationOperationReceipt,
    /// A fresh observation, which may differ from the original written revision.
    pub current: IntegrationModelPolicySettingsSnapshot,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationModelPolicySettingsOperationParams {
    pub operation_id: String,
}
