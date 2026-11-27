//! Original received metadata for explicit choices; candidate data is not a verified secret.
use super::MigrationSourceCredentialSelector;
use crate::MigrationSourceSessionParams;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialCandidatesParams {
    #[serde(deserialize_with = "crate::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub target: MigrationSourceSessionParams,
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub manifest_sha256: String,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^e[0-9]{4}-[0-9]{4}$"))
    )]
    pub entry_id: String,
    #[cfg_attr(feature = "json-schema", schemars(range(max = 1024_u32)))]
    pub page_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_plan_id: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MigrationSourceCredentialCandidate {
    #[serde(rename_all = "camelCase")]
    Provider {
        item_id: String,
        source_name: Option<String>,
        endpoint: Option<String>,
        api_format: String,
        #[cfg_attr(feature = "json-schema", schemars(length(max = 2)))]
        selectors: Vec<MigrationSourceCredentialSelector>,
        issue_code: Option<String>,
        source_verification_required: bool,
        #[serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            deserialize_with = "single_target"
        )]
        #[cfg_attr(feature = "json-schema", schemars(length(max = 1)))]
        targets: Vec<MigrationSourceCredentialCandidateTarget>,
    },
    #[serde(rename_all = "camelCase")]
    Mcp {
        item_id: String,
        source_name: Option<String>,
        definition_sha256: Option<String>,
        #[cfg_attr(feature = "json-schema", schemars(length(max = 32)))]
        fields: Vec<kcoder_types::migration::MigrationMcpPrivateField>,
        declared_fields: u32,
        issue_code: Option<String>,
        source_verification_required: bool,
        #[serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            deserialize_with = "single_target"
        )]
        #[cfg_attr(feature = "json-schema", schemars(length(max = 1)))]
        targets: Vec<MigrationSourceCredentialCandidateTarget>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialCandidatesResult {
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub manifest_sha256: String,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^e[0-9]{4}-[0-9]{4}$"))
    )]
    pub entry_id: String,
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[0-9a-f]{64}$")))]
    pub source_binding_revision: String,
    pub source: kcoder_types::migration::MigrationSourceKind,
    pub project_scoped: bool,
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub items: Vec<MigrationSourceCredentialCandidate>,
    #[cfg_attr(feature = "json-schema", schemars(range(max = 1024_u32)))]
    pub total_items: u32,
    pub next_page: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<MigrationSourceCredentialCandidatePlan>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialCandidatesParamsV1 {
    pub manifest_sha256: String,
    pub entry_id: String,
    pub page_index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_plan_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCredentialCandidatePlan {
    pub job_id: String,
    pub plan_id: String,
    #[serde(deserialize_with = "super::safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MigrationSourceCredentialCandidateTarget {
    #[serde(rename_all = "camelCase")]
    Provider {
        batch_item_id: String,
        target_name: String,
        endpoint: String,
        api_format: String,
    },
    #[serde(rename_all = "camelCase")]
    Mcp {
        batch_item_id: String,
        target_name: String,
        target_definition_sha256: String,
    },
}

fn single_target<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<MigrationSourceCredentialCandidateTarget>, D::Error> {
    let values = Vec::<MigrationSourceCredentialCandidateTarget>::deserialize(deserializer)?;
    if values.len() > 1 {
        return Err(serde::de::Error::custom(
            "at most one saved target per original item",
        ));
    }
    Ok(values)
}
