//! API-key import requests carry consent and owned identities, never raw secrets or source paths.
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationApiKeySource {
    Configuration,
    Environment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMcpCredentialPlanParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub item_id: String,
    pub fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
    pub consent_private_values: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMcpCredentialPlanSummary {
    pub plan_id: String,
    pub item_id: String,
    pub target_name: String,
    pub transport: String,
    pub storage: MigrationCredentialStorage,
    pub fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
    pub remaining_fields: usize,
    pub phase: kcoder_types::migration::MigrationCredentialPhase,
    pub undo_requested: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationMcpCredentialsResult {
    pub job: crate::MigrationJobSummary,
    pub plans: Vec<MigrationMcpCredentialPlanSummary>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCredentialPlanParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub item_id: String,
    pub source: MigrationApiKeySource,
    pub consent_api_key: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCredentialOperationParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub plan_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationCredentialStorage {
    File,
    Keyring,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationCredentialPlanSummary {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub grouped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub undo_requested: bool,
    pub plan_id: String,
    pub item_id: String,
    pub target_name: String,
    pub endpoint: String,
    pub storage: MigrationCredentialStorage,
    pub source: MigrationApiKeySource,
    pub source_field: String,
    pub phase: kcoder_types::migration::MigrationCredentialPhase,
}
