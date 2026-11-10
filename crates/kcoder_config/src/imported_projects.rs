//! Profile-owned associations only. Native workspace files, registry and labels are never written.
use crate::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease};
use anyhow::{Result, ensure};
use kcoder_types::imported_projects::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
mod registry;
pub use registry::{
    ProjectRegisteredWorkspace, ProjectWorkspaceMembership, ProjectWorkspaceRegistry,
};
mod storage;
mod validation;

const DIRECTORY: &str = "imported-project-associations";
const LOCK: &str = "coordinator.lock";
const BIRTH: &str = "birth.json";
const STATE: &str = "associations.json";
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 1024;
const MAX_RECEIPTS: usize = 4096;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BirthStage {
    Initializing,
    Sealed,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Birth {
    version: u32,
    epoch: String,
    profile_identity: String,
    directory_identity: String,
    lock_identity: PortableLeaseIdentity,
    stage: BirthStage,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    version: u32,
    epoch: String,
    generation: u64,
    records: BTreeMap<String, ImportedProjectAssociation>,
    receipts: BTreeMap<String, ImportedProjectReceipt>,
}
impl State {
    fn new(epoch: &str) -> Self {
        Self {
            version: 1,
            epoch: epoch.to_owned(),
            generation: 0,
            records: BTreeMap::new(),
            receipts: BTreeMap::new(),
        }
    }
}
pub struct ImportedProjectAssociationsStore {
    profile: PathBuf,
    parent: PrivateDirectory,
    directory: PrivateDirectory,
    birth: Birth,
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn receipt_key(owner: &ImportedProjectOwner) -> String {
    format!("{}:{}", owner.operation_id, owner.action_id)
}
impl ImportedProjectAssociationsStore {
    /// The Native caller chooses this target profile. Existing unknown directories are not adopted.
    pub fn open(profile: &Path) -> Result<Self> {
        storage::open(profile)
    }
    pub fn list(&self) -> Result<Vec<ImportedProjectAssociation>> {
        let _lease = self.lock(PrivateLeaseMode::Shared)?;
        Ok(self.read()?.records.into_values().collect())
    }
    pub fn receipt(&self, owner: &ImportedProjectOwner) -> Result<Option<ImportedProjectReceipt>> {
        validation::owner(owner)?;
        let _lease = self.lock(PrivateLeaseMode::Shared)?;
        Ok(self.read()?.receipts.remove(&receipt_key(owner)))
    }
    pub fn check_association(&self, record: &ImportedProjectAssociation) -> Result<()> {
        validation::record(record)?;
        validation::target(&self.profile, &record.target)?;
        let _lease = self.lock(PrivateLeaseMode::Shared)?;
        let state = self.read()?;
        self.check_addition(&state, record)
    }
    fn check_addition(&self, state: &State, record: &ImportedProjectAssociation) -> Result<()> {
        ensure!(record.revision == 1, "imported_project_invalid_revision");
        let key = receipt_key(&record.owner);
        if let Some(receipt) = state.receipts.get(&key) {
            ensure!(
                receipt.association_id == record.id && receipt.record_sha256 == hash(record)?,
                "imported_project_owner_conflict"
            );
            ensure!(
                receipt.stage == ImportedProjectReceiptStage::Associated,
                "imported_project_already_removed"
            );
            ensure!(
                state.records.get(&record.id) == Some(record),
                "imported_project_publication_unknown"
            );
            return Ok(());
        }
        ensure!(
            !state.records.contains_key(&record.id)
                && !state
                    .receipts
                    .values()
                    .any(|receipt| receipt.association_id == record.id),
            "imported_project_owner_conflict"
        );
        ensure!(
            state.records.len() < MAX_RECORDS && state.receipts.len() < MAX_RECEIPTS,
            "imported_project_budget_exceeded"
        );
        ensure!(
            !state
                .records
                .values()
                .any(|current| current.source.source == record.source.source
                    && current.source.project_id == record.source.project_id
                    && current.target.project_key == record.target.project_key
                    && current.target.workspace_identity == record.target.workspace_identity),
            "imported_project_association_exists"
        );
        Ok(())
    }
    /// The caller separately holds the original Native workspace-registry authorization fence.
    /// Exact original receipt replay is read-only; new association publication fresh-checks trust.
    pub fn associate(&self, record: &ImportedProjectAssociation) -> Result<ImportedProjectReceipt> {
        validation::record(record)?;
        let _lease = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut state = self.read()?;
        self.check_addition(&state, record)?;
        let key = receipt_key(&record.owner);
        if let Some(receipt) = state.receipts.get(&key) {
            return Ok(receipt.clone());
        }
        validation::target(&self.profile, &record.target)?;
        let receipt = ImportedProjectReceipt {
            association_id: record.id.clone(),
            owner: record.owner.clone(),
            record_sha256: hash(record)?,
            record_revision: record.revision,
            stage: ImportedProjectReceiptStage::Associated,
        };
        state.records.insert(record.id.clone(), record.clone());
        state.receipts.insert(key, receipt.clone());
        self.save(&mut state)?;
        Ok(receipt)
    }
    /// Only this unchanged association is removed. No target directory, session, user registry or peer is touched.
    pub fn remove_owned(
        &self,
        expected: &ImportedProjectAssociation,
    ) -> Result<ImportedProjectReceipt> {
        validation::record(expected)?;
        let _lease = self.lock(PrivateLeaseMode::Exclusive)?;
        let mut state = self.read()?;
        let key = receipt_key(&expected.owner);
        let digest = hash(expected)?;
        let receipt = state
            .receipts
            .get(&key)
            .ok_or_else(|| anyhow::anyhow!("imported_project_publication_unknown"))?;
        ensure!(
            receipt.association_id == expected.id
                && receipt.owner == expected.owner
                && receipt.record_sha256 == digest
                && receipt.record_revision == expected.revision,
            "imported_project_owner_conflict"
        );
        if receipt.stage == ImportedProjectReceiptStage::Removed {
            ensure!(
                !state.records.contains_key(&expected.id),
                "imported_project_publication_unknown"
            );
            return Ok(receipt.clone());
        }
        ensure!(
            state.records.get(&expected.id) == Some(expected),
            "imported_project_rollback_conflict"
        );
        let mut receipt = receipt.clone();
        receipt.stage = ImportedProjectReceiptStage::Removed;
        state.records.remove(&expected.id);
        state.receipts.insert(key, receipt.clone());
        self.save(&mut state)?;
        Ok(receipt)
    }
}
#[cfg(test)]
mod tests;
