//! Explicit idle-view leases and managed historical archive retirement.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_MIGRATION_HISTORY_VIEW_V1: &str = "migrationHistoryViewV1";
pub const CAPABILITY_MIGRATION_ARCHIVE_RETIREMENT_V1: &str = "migrationArchiveRetirementV1";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryViewOpenParams {
    /// Stable nonce chosen before open. An expired/released nonce cannot acquire a new hold.
    pub request_id: String,
    pub job_id: String,
    pub expected_archive_id: String,
    #[serde(default)]
    pub view_id: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryViewReadParams {
    pub request_id: String,
    #[serde(default)]
    pub lease_id: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryViewRenewParams {
    pub request_id: String,
    pub lease_id: String,
    pub expected_sequence: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryViewReleaseParams {
    pub request_id: String,
    pub lease_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationHistoryViewState {
    Active,
    Released,
    Expired,
    Invalidated,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryViewLease {
    pub request_id: String,
    pub lease_id: String,
    pub job_id: String,
    pub archive_id: String,
    pub normalization_revision: String,
    pub view_id: Option<String>,
    pub sequence: u64,
    pub state: MigrationHistoryViewState,
    /// Remaining server monotonic lifetime, not an absolute wall-clock timestamp.
    /// Clients subtract full request duration and treat transport loss as unconfirmed.
    pub remaining_ms: u32,
    pub managed_archives: u32,
    /// Legacy archives stay retained; a successful open does not manufacture a managed birth.
    pub legacy_archives: u32,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationHistoryViewResult {
    pub lease: Option<MigrationHistoryViewLease>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementPreviewParams {
    pub job_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementPrepareParams {
    pub operation_id: String,
    pub job_id: String,
    pub expected_job_sequence: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementReadParams {
    pub operation_id: String,
    pub job_id: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementControlParams {
    pub operation_id: String,
    pub job_id: String,
    pub expected_sequence: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementListParams {
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationArchiveRetirementPhase {
    Prepared,
    Blocked,
    Retired,
    Collecting,
    Collected,
    Cancelled,
    OutcomeUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationArchiveRetirementWorkerState {
    Running,
    Stopped,
    Unknown,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirement {
    pub operation_id: String,
    pub job_id: String,
    pub archive_id: String,
    pub sequence: u64,
    pub phase: MigrationArchiveRetirementPhase,
    pub cancel_requested: bool,
    pub cancel_revision: u64,
    pub owns_archive: bool,
    pub logical_retired: bool,
    pub retained_references: u64,
    /// Verified removed logical lengths; this is not a filesystem free-block promise.
    pub collected_bytes: u64,
    pub failure_code: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementStateResult {
    pub retirement: MigrationArchiveRetirement,
    pub worker_state: MigrationArchiveRetirementWorkerState,
    pub worker_scheduled: bool,
    pub worker_error: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementPreviewResult {
    pub job_id: String,
    pub job_sequence: u64,
    pub archive_id: Option<String>,
    pub can_prepare: bool,
    pub owns_archive: bool,
    pub retained_references: u64,
    pub readers_idle: Option<bool>,
    pub reason_code: Option<String>,
    pub existing: Option<MigrationArchiveRetirementStateResult>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationArchiveRetirementListResult {
    /// At most ten operations. Audit records remain available after physical collection.
    pub items: Vec<MigrationArchiveRetirementStateResult>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leases_and_retirement_never_accept_filesystem_or_foreign_owner_authority() {
        let open = serde_json::json!({"requestId":"request","jobId":"job","expectedArchiveId":"archive","viewId":null});
        let retire = serde_json::json!({"operationId":"op","jobId":"job","expectedJobSequence":1});
        for field in [
            "path",
            "profile",
            "owner",
            "target",
            "force",
            "recursive",
            "autoRun",
        ] {
            let mut value = open.clone();
            value[field] = serde_json::json!("untrusted");
            assert!(serde_json::from_value::<MigrationHistoryViewOpenParams>(value).is_err());
            let mut value = retire.clone();
            value[field] = serde_json::json!("untrusted");
            assert!(
                serde_json::from_value::<MigrationArchiveRetirementPrepareParams>(value).is_err()
            );
        }
        assert!(
            serde_json::from_value::<MigrationHistoryViewRenewParams>(
                serde_json::json!({"leaseId":"known-peer-id"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<MigrationArchiveRetirementControlParams>(
                serde_json::json!({"operationId":"op","jobId":"job"})
            )
            .is_err()
        );
    }
}
