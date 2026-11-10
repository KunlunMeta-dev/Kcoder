//! A creation receipt belongs to the original batch, not to a second job catalog.
use anyhow::{Result, ensure};
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};

/// Optional private field in the normal batch journal. Old None values stay omitted.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchCreationBinding {
    pub(super) request_id: String,
    pub(super) intent_sha256: String,
    pub(super) profile_identity: String,
    pub(super) birth_sha256: String,
}
impl std::fmt::Debug for BatchCreationBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BatchCreationBinding")
            .field("request_id", &self.request_id)
            .finish_non_exhaustive()
    }
}
impl BatchCreationBinding {
    pub(crate) fn validate_shape(&self) -> Result<()> {
        uuid(&self.request_id)?;
        for value in [
            &self.intent_sha256,
            &self.profile_identity,
            &self.birth_sha256,
        ] {
            digest(value)?;
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Birth {
    pub version: u32,
    pub request_id: String,
    pub intent_sha256: String,
    pub profile_identity: String,
    pub job_id: String,
    pub nonce: String,
    pub directory_identity: String,
    pub lease_identity: PortableLeaseIdentity,
    pub control_identity: PortableLeaseIdentity,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Control {
    pub version: u32,
    pub birth_sha256: String,
    pub revision: u64,
    pub cancel_requested: bool,
    pub receipts: Vec<ControlReceipt>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ControlAction {
    Cancel,
    Resume,
    WorkerCancelled,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ControlReceipt {
    pub request_id: String,
    pub action: ControlAction,
    pub expected_revision: u64,
    pub revision: u64,
}
impl Control {
    pub(super) fn validate(&self, birth_sha256: &str) -> Result<()> {
        ensure!(
            self.version == 1
                && self.birth_sha256 == birth_sha256
                && self.revision == 1 + self.receipts.len() as u64
                && self.receipts.len() <= 128,
            "migration_batch_creation_unknown"
        );
        let mut seen = std::collections::BTreeSet::new();
        let mut cancelled = false;
        for (index, receipt) in self.receipts.iter().enumerate() {
            uuid(&receipt.request_id)?;
            ensure!(
                seen.insert(&receipt.request_id)
                    && receipt.expected_revision == 1 + index as u64
                    && receipt.revision == 2 + index as u64,
                "migration_batch_creation_unknown"
            );
            cancelled = receipt.action != ControlAction::Resume;
        }
        ensure!(
            cancelled == self.cancel_requested,
            "migration_batch_creation_unknown"
        );
        Ok(())
    }
}

pub(super) fn uuid(value: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(value).is_ok_and(|uuid| uuid.to_string() == value),
        "migration_invalid_request_reference"
    );
    Ok(())
}
pub(super) fn digest(value: &str) -> Result<()> {
    ensure!(
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "migration_batch_creation_unknown"
    );
    Ok(())
}
