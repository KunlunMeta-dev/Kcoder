//! Cancellation addresses an original execution generation, independently of progress revisions.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MIGRATION_BATCH_CONTROL_V1: &str = "migrationBatchControlV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchControlReadParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchControlCancelParams {
    pub job_id: String,
    pub plan_id: String,
    pub run_request_id: String,
    pub admission_sequence: u64,
    pub command_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationBatchControlPhase {
    Unadmitted,
    Tracked,
    LegacyUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationBatchControlMode {
    Apply,
    Resume,
    Rollback,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchControlGeneration {
    pub plan_id: String,
    pub run_request_id: String,
    pub admission_sequence: u64,
    pub mode: MigrationBatchControlMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchCancellationReceipt {
    pub command_id: String,
    pub plan_id: String,
    pub run_request_id: String,
    pub admission_sequence: u64,
    pub accepted_sequence: u64,
}

/// A receipt proves requested cancellation only, never that a worker has stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationBatchControlResult {
    pub job_id: String,
    pub current_sequence: u64,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_string")
    )]
    pub plan_id: Option<String>,
    pub phase: MigrationBatchControlPhase,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_generation")
    )]
    pub generation: Option<MigrationBatchControlGeneration>,
    pub cancel_requested: bool,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_receipt")
    )]
    pub last_cancellation: Option<MigrationBatchCancellationReceipt>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_receipt")
    )]
    pub requested_receipt: Option<MigrationBatchCancellationReceipt>,
}

fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

#[cfg(feature = "json-schema")]
fn nullable_string(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}

#[cfg(feature = "json-schema")]
fn nullable_generation(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<MigrationBatchControlGeneration> as schemars::JsonSchema>::json_schema(generator)
}

#[cfg(feature = "json-schema")]
fn nullable_receipt(generator: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
    <Option<MigrationBatchCancellationReceipt> as schemars::JsonSchema>::json_schema(generator)
}
