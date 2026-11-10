//! Transfer observations distinguish Gateway activity from authoritative Native receipts.
use crate::MigrationSourceTransferObservedControl;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceNullable<T> {
    Value(T),
    Null(()),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceCoordinatorState {
    Running,
    Idle,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceObservationState {
    Observed,
    Unobserved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceTransferPhase {
    Pending,
    Ready,
    Cancelling,
    Cancelled,
    Failed,
    Interrupted,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceCaptureStatus {
    Idle,
    Running,
    Failed,
    Interrupted,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceCaptureObservation {
    pub status: MigrationSourceCaptureStatus,
    pub error_code: MigrationSourceNullable<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceReceipt {
    pub request_id: String,
    pub manifest_sha256: String,
    pub entries: u32,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTargetProgress {
    pub manifest_sha256: String,
    pub entries: u32,
    pub total_bytes: u64,
    pub accepted_bytes: u64,
    pub parts_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourcePairedObservation {
    pub request_id: String,
    pub phase: MigrationSourceTransferPhase,
    pub source_state: MigrationSourceTransferObservedControl,
    pub target_state: MigrationSourceTransferObservedControl,
    pub receipt: MigrationSourceNullable<MigrationSourceReceipt>,
    pub source_capture: MigrationSourceCaptureObservation,
    pub source_snapshot_control: MigrationSourceTransferObservedControl,
    pub target_worker_running: bool,
    pub target_admission_control: MigrationSourceTransferObservedControl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceTargetScope {
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTargetObservation {
    pub request_id: String,
    pub scope: MigrationSourceTargetScope,
    pub source_observed: bool,
    pub phase: MigrationSourceTransferPhase,
    pub source_state: (),
    pub source_capture: (),
    pub source_snapshot_control: (),
    pub target_state: MigrationSourceTransferObservedControl,
    pub target_admission_control: MigrationSourceTransferObservedControl,
    pub target_worker_running: bool,
    pub receipt: MigrationSourceNullable<MigrationSourceReceipt>,
    pub progress: MigrationSourceNullable<MigrationSourceTargetProgress>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MigrationSourceTransferObservation {
    Paired(MigrationSourcePairedObservation),
    Target(MigrationSourceTargetObservation),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "phase", rename_all = "snake_case", deny_unknown_fields)]
pub enum MigrationSourceCopyProgress {
    Capturing {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    Transferring {
        #[serde(rename = "requestId")]
        request_id: String,
        entries: u32,
        #[serde(rename = "totalBytes")]
        total_bytes: u64,
        #[serde(rename = "acceptedBytes")]
        accepted_bytes: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationSourceTransferResult {
    pub request_id: String,
    pub coordinator_state: MigrationSourceCoordinatorState,
    pub observation: MigrationSourceObservationState,
    pub result: MigrationSourceNullable<MigrationSourceTransferObservation>,
    pub progress: MigrationSourceNullable<MigrationSourceCopyProgress>,
    pub error_code: MigrationSourceNullable<String>,
}
