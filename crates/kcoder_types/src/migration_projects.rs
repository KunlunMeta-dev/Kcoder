//! Public project inventory metadata. Source rows grant no target-directory permissions.
use crate::migration::MigrationSourceKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationProjectLabelOrigin {
    RegistryName,
    PathBasename,
    OriginalId,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationProjectUnobserved {
    VendorMetadata,
    SourceTrust,
    WorktreeContents,
    SessionRecency,
    LegacyDesktopRegistry,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationProjectDiscoveryProblem {
    RegistryUnavailable,
    RegistryUnsupported,
    RegistryBusy,
    RegistryBudgetExceeded,
    RegistryChanged,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectSourceSummary {
    pub source_handle: String,
    pub display_name: String,
    pub label_origin: MigrationProjectLabelOrigin,
    pub original_project_id: Option<String>,
    pub roots: u32,
    pub position: i64,
    pub source_created_at_ms: Option<u64>,
    pub source_updated_at_ms: Option<u64>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectSourcesResult {
    pub catalog_id: String,
    pub source: MigrationSourceKind,
    pub page_index: u32,
    #[serde(deserialize_with = "ten")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub items: Vec<MigrationProjectSourceSummary>,
    pub total_items: u32,
    pub next_page: Option<u32>,
    /// Completeness concerns rows in this declared registry layout, not every vendor feature/version.
    pub known_rows_complete: bool,
    pub format_revision: Option<String>,
    pub unobserved: Vec<MigrationProjectUnobserved>,
    pub problems: Vec<MigrationProjectDiscoveryProblem>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectSourceRoot {
    pub source_root_id: String,
    pub ordinal: u32,
    /// Preserved foreign path text. Neither source nor target directories are opened from this value.
    pub original_path: String,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectSourceRootsResult {
    pub catalog_id: String,
    pub source_handle: String,
    pub page_index: u32,
    #[serde(deserialize_with = "ten")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub roots: Vec<MigrationProjectSourceRoot>,
    pub total_roots: u32,
    pub next_page: Option<u32>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectTargetSummary {
    pub target_handle: String,
    pub display_name: String,
    pub roots: u32,
    pub current_workspace: bool,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectTargetsResult {
    pub registered_workspaces_observed: bool,
    pub target_catalog_id: String,
    pub page_index: u32,
    #[serde(deserialize_with = "ten")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub items: Vec<MigrationProjectTargetSummary>,
    pub total_items: u32,
    pub next_page: Option<u32>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectTargetRoot {
    pub target_root_handle: String,
    pub ordinal: u32,
    pub path: String,
    /// A display observation, never persistent trust or a replacement for the Native plan/run check.
    pub trusted: bool,
    pub available: bool,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectTargetRootsResult {
    pub target_catalog_id: String,
    pub target_handle: String,
    pub page_index: u32,
    #[serde(deserialize_with = "ten")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub roots: Vec<MigrationProjectTargetRoot>,
    pub total_roots: u32,
    pub next_page: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectRootMapping {
    pub source_root_id: String,
    pub target_root_handle: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectMappingChoice {
    pub target_catalog_id: String,
    pub target_handle: String,
    #[serde(deserialize_with = "sixteen")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 16)))]
    pub mappings: Vec<MigrationProjectRootMapping>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationProjectReportField {
    SourceFormat,
    OriginalProjectId,
    SourceName,
    SourceRoot,
    SourceOrder,
    SourceCreatedAt,
    SourceUpdatedAt,
    TargetWorkspace,
    TargetRoot,
    MappingStatus,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectReportRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_root_id: Option<String>,
    pub field: MigrationProjectReportField,
    pub ordinal: Option<u32>,
    pub value: Option<String>,
}
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectReportResult {
    pub job_id: String,
    pub item_id: String,
    pub page_index: u32,
    #[serde(deserialize_with = "ten")]
    #[cfg_attr(feature = "json-schema", schemars(length(max = 10)))]
    pub fields: Vec<MigrationProjectReportRow>,
    pub total_fields: u32,
    pub next_page: Option<u32>,
    pub unobserved: Vec<MigrationProjectUnobserved>,
}

fn ten<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    input: D,
) -> Result<Vec<T>, D::Error> {
    bounded(input, 10)
}
fn sixteen<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    input: D,
) -> Result<Vec<T>, D::Error> {
    bounded(input, 16)
}
fn bounded<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    input: D,
    maximum: usize,
) -> Result<Vec<T>, D::Error> {
    struct Page<T>(usize, std::marker::PhantomData<T>);
    impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Page<T> {
        type Value = Vec<T>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a bounded metadata page")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut entries: A,
        ) -> Result<Vec<T>, A::Error> {
            let mut rows = Vec::new();
            while let Some(row) = entries.next_element()? {
                if rows.len() == self.0 {
                    return Err(serde::de::Error::custom("project metadata page budget"));
                }
                rows.push(row);
            }
            Ok(rows)
        }
    }
    input.deserialize_seq(Page(maximum, std::marker::PhantomData))
}

/// A manifest-bound label for a received project, never a target filesystem grant.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationProjectReceivedMetadata {
    pub display_name: String,
    pub label_origin: MigrationProjectLabelOrigin,
    pub original_project_id: Option<String>,
    pub roots: u32,
    pub format_revision: String,
}
impl std::fmt::Debug for MigrationProjectReceivedMetadata {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MigrationProjectReceivedMetadata")
            .field("roots", &self.roots)
            .finish_non_exhaustive()
    }
}
