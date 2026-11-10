//! Standalone history quota controls retain the original job and never start its worker.
use crate::migration_resources::{MigrationResourceBudgetView, MigrationResourceLimits};
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MIGRATION_HISTORY_RESOURCE_BUDGET_V1: &str =
    "migrationHistoryResourceBudgetV1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceReadParams {
    pub job_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceResult {
    /// A parent-owned history child exposes the real parent. It cannot raise that parent's
    /// policy through the standalone endpoint or manufacture a batch plan authority.
    #[serde(deserialize_with = "required_owner")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_owner_schema")
    )]
    pub owner_job_id: Option<String>,
    /// Frozen initial policy, separate from the possibly raised current policy.
    #[serde(deserialize_with = "required_initial_limits")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(required, schema_with = "nullable_initial_limits_schema")
    )]
    pub initial_limits: Option<kcoder_types::migration_resource::MigrationResourceLimitFacts>,
    pub budget: MigrationResourceBudgetView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceIncreaseParams {
    pub job_id: String,
    pub request_id: String,
    pub expected_policy_revision: u64,
    pub limits: MigrationResourceLimits,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryResourceAttachParams {
    pub job_id: String,
    pub expected_sequence: u64,
    pub limits: MigrationResourceLimits,
    #[serde(default)]
    pub confirm: bool,
}

#[cfg(feature = "json-schema")]
fn nullable_owner_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<String> as schemars::JsonSchema>::json_schema(generator)
}

fn required_owner<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::deserialize(deserializer)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryParentResourceAttachParams {
    pub job_id: String,
    pub plan_id: String,
    pub expected_sequence: u64,
    pub limits: MigrationResourceLimits,
    #[serde(default)]
    pub confirm: bool,
}

#[cfg(feature = "json-schema")]
fn nullable_initial_limits_schema(
    generator: &mut schemars::r#gen::SchemaGenerator,
) -> schemars::schema::Schema {
    <Option<kcoder_types::migration_resource::MigrationResourceLimitFacts> as schemars::JsonSchema>::json_schema(generator)
}
fn required_initial_limits<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<kcoder_types::migration_resource::MigrationResourceLimitFacts>, D::Error> {
    Option::deserialize(deserializer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_budget_confirmation_cannot_inject_archive_or_group_authority() {
        let mut value = json!({"jobId":"original","expectedSequence":4,"limits":{}});
        let params: MigrationHistoryResourceAttachParams =
            serde_json::from_value(value.clone()).unwrap();
        assert!(!params.confirm);
        value["reference"] = json!({"group":"borrowed"});
        assert!(serde_json::from_value::<MigrationHistoryResourceAttachParams>(value).is_err());
        assert!(
            serde_json::from_value::<MigrationHistoryResourceReadParams>(json!({
                "jobId":"original", "path":"another-profile"
            }))
            .is_err()
        );
    }
}
