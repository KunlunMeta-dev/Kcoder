//! Explicit private-value choices and redacted results; no key or plaintext enters public DTOs.
mod bundle;
mod preparation;
pub use preparation::*;
mod source_read;
pub use source_read::*;
mod candidates;
pub use candidates::*;
mod errors;
pub use errors::*;
mod private;
use crate::{
    MigrationJobReadResult, MigrationSourceSessionParams, MigrationSourceTransferObservedControl,
};
pub use private::*;
use serde::{Deserialize, Deserializer, Serialize, de::Error};

pub const MIGRATION_SOURCE_PRIVATE_CREDENTIALS_CAPABILITY: &str =
    "migrationSourceTransferPrivateCredentialsV1";
pub const MIGRATION_SOURCE_PRIVATE_CREDENTIAL_SOURCE_OBSERVATION_CAPABILITY: &str =
    "migrationSourceTransferPrivateCredentialSourceObservationV1";
pub const MIGRATION_SOURCE_PRIVATE_CREDENTIAL_PREPARATIONS_CAPABILITY: &str =
    "migrationSourceTransferPrivateCredentialPreparationsV1";
pub const MIGRATION_SOURCE_PRIVATE_CREDENTIAL_BUNDLES_CAPABILITY: &str =
    "migrationSourceTransferPrivateCredentialBundlesV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialConsent {
    pub api_keys: bool,
    pub mcp_private_fields: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MigrationSourceCredentialSelector {
    ClaudeConfiguration,
    Environment { variable: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MigrationSourceCredentialSelection {
    #[serde(rename_all = "camelCase")]
    Provider {
        source_name: String,
        selector: MigrationSourceCredentialSelector,
        target_name: String,
        endpoint: String,
        api_format: String,
    },
    #[serde(rename_all = "camelCase")]
    Mcp {
        source_name: String,
        #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 32)))]
        fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
        target_name: String,
        definition_sha256: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialLocator {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub offer_id: String,
    pub target: MigrationSourceSessionParams,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialRunParams {
    pub locator: MigrationSourceCredentialLocator,
    pub source: MigrationSourceSessionParams,
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub manifest_sha256: String,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^e[0-9]{4}-[0-9]{4}$"))
    )]
    pub entry_id: String,
    #[serde(deserialize_with = "selected")]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 64)))]
    pub selections: Vec<MigrationSourceCredentialSelection>,
    pub consent: MigrationSourceCredentialConsent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceCredentialSide {
    Source,
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialWatermark {
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub cancel_watermark: u64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialExpectedControl {
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub cancel_watermark: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialCancelParams {
    pub locator: MigrationSourceCredentialLocator,
    pub side: MigrationSourceCredentialSide,
    /// Required only for source control; target-only recovery must omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MigrationSourceSessionParams>,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub command_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialResumeParams {
    pub locator: MigrationSourceCredentialLocator,
    pub side: MigrationSourceCredentialSide,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MigrationSourceSessionParams>,
    pub expected_control: MigrationSourceCredentialExpectedControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialPrepareParams {
    pub locator: MigrationSourceCredentialLocator,
    pub job_id: String,
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub expected_sequence: u64,
    pub consent: MigrationSourceCredentialConsent,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "bundle::additional"
    )]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "bundle::additional_schema")
    )]
    pub additional_offers: Option<Vec<String>>,
}

/// Required null distinguishes an unused offer from a selected publication job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceCredentialJob {
    Publication(String),
    Unused(()),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialReleaseParams {
    pub locator: MigrationSourceCredentialLocator,
    pub job_id: MigrationSourceCredentialJob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceCredentialObservedWorker {
    Observed(bool),
    Unobserved(()),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceCredentialPhase {
    Offered,
    Running,
    Sealed,
    Received,
    Released,
    Cancelling,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialResult {
    pub request_id: String,
    pub offer_id: String,
    pub phase: MigrationSourceCredentialPhase,
    pub source_control: MigrationSourceTransferObservedControl,
    pub target_control: MigrationSourceTransferObservedControl,
    pub source_observed: bool,
    pub target_observed: bool,
    pub source_worker_running: MigrationSourceCredentialObservedWorker,
    pub target_worker_running: MigrationSourceCredentialObservedWorker,
    pub received: bool,
    pub key_released: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialControlResult {
    pub request_id: String,
    pub offer_id: String,
    pub side: MigrationSourceCredentialSide,
    pub control: MigrationSourceCredentialWatermark,
    pub worker_running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialPrepareResult {
    pub request_id: String,
    pub offer_id: String,
    pub job: MigrationJobReadResult,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "bundle::complete"
    )]
    #[cfg_attr(
        feature = "json-schema",
        schemars(schema_with = "bundle::complete_schema")
    )]
    pub offer_ids: Option<Vec<String>>,
}

fn selected<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<MigrationSourceCredentialSelection>, D::Error> {
    let values = Vec::<MigrationSourceCredentialSelection>::deserialize(deserializer)?;
    if values.is_empty() || values.len() > 64 {
        return Err(D::Error::custom("invalid private selection"));
    }
    Ok(values)
}
fn safe_counter<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(D::Error::custom("invalid private control"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests;
