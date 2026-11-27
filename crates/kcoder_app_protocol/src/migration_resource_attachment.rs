//! Original accounting attachment intents are observed without claiming execution authority.
use kcoder_types::migration_resource::MigrationResourceLimitFacts;
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MIGRATION_HISTORY_RESOURCE_ATTACHMENT_V1: &str =
    "migrationHistoryResourceAttachmentV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceAttachmentReadParams {
    pub job_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationHistoryResourceAttachmentPhase {
    NotApplicable,
    Untracked,
    Pending,
    Attached,
    Tracked,
    ParentOwned,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceAttachmentIntent {
    pub expected_sequence: u64,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_string_schema")
    )]
    pub plan_id: Option<String>,
    pub initial_limits: MigrationResourceLimitFacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceAttachmentResult {
    pub job_id: String,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_string_schema")
    )]
    pub owner_job_id: Option<String>,
    pub current_sequence: u64,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_string_schema")
    )]
    pub current_plan_id: Option<String>,
    pub phase: MigrationHistoryResourceAttachmentPhase,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_intent_schema")
    )]
    pub original_intent: Option<MigrationHistoryResourceAttachmentIntent>,
    #[serde(deserialize_with = "required_nullable")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_string_schema")
    )]
    pub issue_code: Option<String>,
}

fn required_nullable<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
#[cfg(feature = "json-schema")]
fn nullable_string_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}
#[cfg(feature = "json-schema")]
fn nullable_intent_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<MigrationHistoryResourceAttachmentIntent> as schemars::JsonSchema>::json_schema(
        generator,
    )
}
