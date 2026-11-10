//! Execution identity is stable across progress and changes on each accepted runner.
use anyhow::{Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};

pub(crate) const BIRTH_MARKER: &str = "@execution-control/v2";
pub(crate) const MAX_CANCELLATIONS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchControlMode {
    Apply,
    Resume,
    Rollback,
}
impl BatchControlMode {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Apply => "apply",
            Self::Resume => "resume",
            Self::Rollback => "rollback",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchControlGeneration {
    pub plan_id: String,
    pub run_request_id: String,
    pub admission_sequence: u64,
    pub mode: BatchControlMode,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchCancellationReceipt {
    pub command_id: String,
    pub plan_id: String,
    pub run_request_id: String,
    pub admission_sequence: u64,
    pub accepted_sequence: u64,
}
#[derive(Clone, PartialEq, Eq)]
pub struct BatchCancellationIntent {
    pub job_id: String,
    pub command_id: String,
    pub plan_id: String,
    pub run_request_id: String,
    pub admission_sequence: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BatchControlPhase {
    Unadmitted,
    Tracked,
    LegacyUnknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchControlObservation {
    pub job_id: String,
    pub current_sequence: u64,
    pub plan_id: Option<String>,
    pub phase: BatchControlPhase,
    pub generation: Option<BatchControlGeneration>,
    pub cancel_requested: bool,
    pub last_cancellation: Option<BatchCancellationReceipt>,
    pub requested_receipt: Option<BatchCancellationReceipt>,
}

/// Private v2 birth and receipts stay in the original batch journal, never the old worker DTO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionControlRecord {
    pub version: u8,
    pub job_id: String,
    pub profile_identity: String,
    pub runner_identity: PortableLeaseIdentity,
    pub journal_identity: PortableLeaseIdentity,
    pub birth_sha256: String,
    pub current: BatchControlGeneration,
    pub cancellations: Vec<BatchCancellationReceipt>,
}
pub(crate) fn opaque(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
}
pub(crate) fn command(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
impl super::BatchState {
    pub(crate) fn validate_execution_control(&self) -> Result<()> {
        match (
            &self.execution_control,
            self.request_kinds.get(BIRTH_MARKER),
        ) {
            (None, None) => return Ok(()),
            (Some(record), Some(marker)) => {
                ensure!(
                    record.version == 2
                        && marker == &record.birth_sha256
                        && record.birth_sha256.len() == 64
                        && record
                            .birth_sha256
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                        && !record.profile_identity.is_empty()
                        && record.profile_identity.len() <= 4096
                        && opaque(&record.job_id, 128)
                        && opaque(&record.current.plan_id, 128)
                        && opaque(&record.current.run_request_id, 256)
                        && record.current.admission_sequence > 0
                        && self
                            .request_kinds
                            .get(&record.current.run_request_id)
                            .map(String::as_str)
                            == Some(record.current.mode.name())
                        && record.cancellations.len() <= MAX_CANCELLATIONS,
                    "migration_batch_control_unknown"
                );
                let mut ids = std::collections::BTreeSet::new();
                ensure!(
                    record
                        .cancellations
                        .iter()
                        .all(|receipt| command(&receipt.command_id)
                            && ids.insert(&receipt.command_id)
                            && opaque(&receipt.plan_id, 128)
                            && opaque(&receipt.run_request_id, 256)
                            && receipt.admission_sequence > 0
                            && receipt.accepted_sequence >= receipt.admission_sequence),
                    "migration_batch_control_unknown"
                );
            }
            _ => anyhow::bail!("migration_batch_control_unknown"),
        }
        Ok(())
    }
    pub(crate) fn execution_request_count(&self) -> usize {
        self.request_kinds
            .keys()
            .filter(|key| key.as_str() != BIRTH_MARKER)
            .count()
    }
}
