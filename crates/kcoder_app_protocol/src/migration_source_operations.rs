//! Public transfer requests contain selectors and observations, never parent authority.
use crate::{MigrationSourceSelectionV1, MigrationSourceSessionParams};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferReadParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub source: MigrationSourceSessionParams,
    pub target: MigrationSourceSessionParams,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferRunParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    /// One explicit execution attempt; transport retries retain this identity.
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub attempt_id: String,
    pub source: MigrationSourceSessionParams,
    pub target: MigrationSourceSessionParams,
    /// Omission permits reconciliation of the original Native intent, not a new selection.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "selected_sources"
    )]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 64)))]
    pub selections: Option<Vec<MigrationSourceSelectionV1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<MigrationSourceTransferResume>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferCancelParams {
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
    pub command_id: String,
    pub source: MigrationSourceSessionParams,
    pub target: MigrationSourceSessionParams,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferControl {
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub cancel_watermark: u64,
    pub cancelled: bool,
    pub ready: bool,
}

/// Null is an explicit observation, distinct from an omitted confirmation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceTransferObservedControl {
    Present(MigrationSourceTransferControl),
    Absent(()),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferSourceResume {
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: u64,
    #[serde(deserialize_with = "safe_counter")]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub cancel_watermark: u64,
    pub snapshot_control: MigrationSourceTransferObservedControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferTargetResume {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_safe_counter"
    )]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub sequence: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "optional_safe_counter"
    )]
    #[cfg_attr(feature = "json-schema", schemars(range(max = 9007199254740991_u64)))]
    pub cancel_watermark: Option<u64>,
    pub admission_control: MigrationSourceTransferControl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferResume {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MigrationSourceTransferSourceResume>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<MigrationSourceTransferTargetResume>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferTargetReadParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub target: MigrationSourceSessionParams,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferTargetCancelParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub target: MigrationSourceSessionParams,
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
pub struct MigrationSourceTransferTargetFinishParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub target: MigrationSourceSessionParams,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub attempt_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferTargetResumeParams {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    pub target: MigrationSourceSessionParams,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub attempt_id: String,
    pub expected_admission_control: MigrationSourceTransferControl,
    pub expected_operation_control: MigrationSourceTransferObservedControl,
}

fn selected_sources<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<MigrationSourceSelectionV1>>, D::Error> {
    let value = Option::<Vec<MigrationSourceSelectionV1>>::deserialize(deserializer)?;
    if value
        .as_ref()
        .is_some_and(|items| items.is_empty() || items.len() > 64)
    {
        return Err(serde::de::Error::custom(
            "expected 1 to 64 selected sources",
        ));
    }
    Ok(value)
}

fn safe_counter<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(deserializer)?;
    if value > 9_007_199_254_740_991 {
        return Err(serde::de::Error::custom("unsafe transfer counter"));
    }
    Ok(value)
}

fn optional_safe_counter<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    let value = Option::<u64>::deserialize(deserializer)?;
    if value.is_some_and(|number| number > 9_007_199_254_740_991) {
        return Err(serde::de::Error::custom("unsafe transfer counter"));
    }
    Ok(value)
}
