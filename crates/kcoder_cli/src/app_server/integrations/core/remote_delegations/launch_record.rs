//! Serialized original launch facts shared by the journal and real launcher.
use kcoder_types::{
    TurnAttemptIdentity,
    integrations::{
        core::{IntegrationRuntimeAcceptance, IntegrationScope},
        office::OfficeArtifactRef,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteSourceFacts {
    pub scope: IntegrationScope,
    pub profile: PathBuf,
    pub workspace: PathBuf,
    pub history_root: PathBuf,
    pub history_root_identity: String,
    pub session_identity: String,
    pub attempts_identity: String,
    pub attempt: TurnAttemptIdentity,
    pub accepted_receipt_sha256: String,
    pub tool_call_id: String,
    pub original_root_operation: String,
    pub original_root_acceptance: Option<IntegrationRuntimeAcceptance>,
    pub original_parent_reservation: String,
    pub profile_settings_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<NativeRemoteSourceGoalFacts>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteSourceGoalFacts {
    pub id: String,
    pub generation: u64,
    pub state_path: PathBuf,
    pub directory_identity: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRemoteLaunchRecord {
    pub version: u32,
    pub operation: String,
    pub source: NativeRemoteSourceFacts,
    pub receiver_scope: IntegrationScope,
    pub receiver_settings_sha256: String,
    pub receiver_identity: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_program_identity: Option<String>,
    pub prompt_sha256: String,
    pub deadline_utc_ms: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<RemoteMaterialDescriptor>,
}
/// Frozen data selectors only. Neither these fields nor decoded material JSON
/// supply an account, a file handle, a transfer permission or execution rights.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteMaterialDescriptor {
    pub source: OfficeArtifactRef,
    pub filename: String,
    pub media_type: String,
    pub bytes: u64,
    pub sha256: String,
}
