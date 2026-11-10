//! Receiving bytes and publishing settings are separate, explicitly selected operations.
use crate::{MigrationSourceNullable, MigrationSourceReceipt};
use kcoder_types::migration::{MigrationCategory, MigrationSourceKind};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceAdoptionSessionPurpose {
    Target,
    TargetRecovery,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionSession {
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub session_id: String,
    pub purpose: MigrationSourceAdoptionSessionPurpose,
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 128)))]
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceReceivedParams {
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_projects: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_instructions: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub include_plugins: bool,
    pub target: MigrationSourceAdoptionSession,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub request_id: String,
    #[serde(deserialize_with = "digest")]
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub manifest_sha256: String,
    #[cfg_attr(feature = "json-schema", schemars(range(max = 102)))]
    #[serde(deserialize_with = "page_index")]
    pub page_index: u32,
}
fn is_false(value: &bool) -> bool {
    !*value
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceReceivedClass {
    Project,
    Instructions,
    Plugin,
    Configuration,
    WorkAsset,
    History,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceReceivedItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<kcoder_types::migration_projects::MigrationProjectReceivedMetadata>,
    #[serde(deserialize_with = "entry_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^e[0-9]{4}-[0-9]{4}$"))
    )]
    pub entry_id: String,
    pub source: MigrationSourceKind,
    pub class: MigrationSourceReceivedClass,
    pub category: MigrationSourceNullable<MigrationCategory>,
    /// For history this is provenance, not a required destination mapping.
    pub project_scoped: bool,
    pub files: u32,
    pub bytes: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceReceivedResult {
    pub receipt: MigrationSourceReceipt,
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    #[serde(deserialize_with = "received_items")]
    pub items: Vec<MigrationSourceReceivedItem>,
    pub total_sources: u32,
    pub next_page: MigrationSourceNullable<u32>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceProjectMapping {
    /// The actual trusted Native workspace is captured by the host, never from a path here.
    CurrentWorkspace,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionSelection {
    #[serde(deserialize_with = "entry_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^e[0-9]{4}-[0-9]{4}$"))
    )]
    pub entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_mapping: Option<MigrationSourceProjectMapping>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionParams {
    pub target: MigrationSourceAdoptionSession,
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
    pub adoption_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionPrepareParams {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instruction_mappings: Vec<crate::MigrationSourceInstructionMapping>,
    pub locator: MigrationSourceAdoptionParams,
    #[serde(deserialize_with = "digest")]
    #[cfg_attr(feature = "json-schema", schemars(regex(pattern = "^[a-f0-9]{64}$")))]
    pub manifest_sha256: String,
    #[serde(deserialize_with = "selections")]
    #[cfg_attr(feature = "json-schema", schemars(length(min = 1, max = 64)))]
    pub selections: Vec<MigrationSourceAdoptionSelection>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionControl {
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
pub struct MigrationSourceAdoptionResumeParams {
    pub locator: MigrationSourceAdoptionParams,
    pub expected_control: MigrationSourceAdoptionControl,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionCancelParams {
    pub locator: MigrationSourceAdoptionParams,
    #[serde(deserialize_with = "super::migration_source_session::session_identity")]
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(
            pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        ))
    )]
    pub command_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceAdoptionPhase {
    Prepared,
    Scanning,
    PreviewReady,
    CancelRequested,
    Cancelled,
    Interrupted,
    Failed,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceAdoptionWorkerState {
    Running,
    Stopped,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceAdoptionTargetScope {
    User,
    CurrentWorkspace,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionJob {
    pub source: MigrationSourceKind,
    #[cfg_attr(
        feature = "json-schema",
        schemars(regex(pattern = "^mig-[0-9a-f]{32}$"))
    )]
    pub job_id: String,
    pub target_scope: MigrationSourceAdoptionTargetScope,
    /// Only this flag authorizes opening the existing batch preview, not publishing it.
    pub preview_ready: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionState {
    pub adoption_id: String,
    pub request_id: String,
    pub phase: MigrationSourceAdoptionPhase,
    pub worker_state: MigrationSourceAdoptionWorkerState,
    /// Null means the original control could not be verified. Never substitute zero.
    pub control: MigrationSourceNullable<MigrationSourceAdoptionControl>,
    pub cancel_requested: MigrationSourceNullable<bool>,
    #[cfg_attr(feature = "json-schema", schemars(length(max = 4)))]
    pub jobs: Vec<MigrationSourceAdoptionJob>,
    pub total_sources: u32,
    pub completed_sources: u32,
    pub blocked_items: u32,
    pub error_code: MigrationSourceNullable<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceAdoptionResult {
    /// Absence is untracked, never permission to replay another creation identity.
    pub state: MigrationSourceNullable<MigrationSourceAdoptionState>,
}

fn digest<'de, D: Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = String::deserialize(input)?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(serde::de::Error::custom(
            "invalid receiving manifest digest",
        ));
    }
    Ok(value)
}
fn entry_identity<'de, D: Deserializer<'de>>(input: D) -> Result<String, D::Error> {
    let value = String::deserialize(input)?;
    if value.len() != 10
        || !value.starts_with('e')
        || value.as_bytes()[5] != b'-'
        || !value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 0 | 5) || byte.is_ascii_digit())
    {
        return Err(serde::de::Error::custom("invalid receiving source anchor"));
    }
    Ok(value)
}
fn selections<'de, D: Deserializer<'de>>(
    input: D,
) -> Result<Vec<MigrationSourceAdoptionSelection>, D::Error> {
    let values = Vec::<MigrationSourceAdoptionSelection>::deserialize(input)?;
    if values.is_empty()
        || values.len() > 64
        || values
            .iter()
            .map(|value| &value.entry_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != values.len()
    {
        return Err(serde::de::Error::custom(
            "invalid receiving source selection",
        ));
    }
    Ok(values)
}
fn safe_counter<'de, D: Deserializer<'de>>(input: D) -> Result<u64, D::Error> {
    let value = u64::deserialize(input)?;
    if value > 9007199254740991 {
        return Err(serde::de::Error::custom(
            "invalid receiving control counter",
        ));
    }
    Ok(value)
}
fn page_index<'de, D: Deserializer<'de>>(input: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(input)?;
    if value > 102 {
        return Err(serde::de::Error::custom("invalid receiving page"));
    }
    Ok(value)
}
fn received_items<'de, D: Deserializer<'de>>(
    input: D,
) -> Result<Vec<MigrationSourceReceivedItem>, D::Error> {
    let value = Vec::<MigrationSourceReceivedItem>::deserialize(input)?;
    if value.len() > 10 {
        return Err(serde::de::Error::custom("invalid receiving page size"));
    }
    Ok(value)
}
