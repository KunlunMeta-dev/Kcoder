//! Ordinary batch actions own these immutable plans; this module has no parallel job authority.
use super::{ProjectReadCancellation, binding::ProjectBatchSource, target::ProjectTargetSelection};
use anyhow::{Result, ensure};
use kcoder_config::imported_projects::ImportedProjectAssociationsStore;
use kcoder_types::imported_projects::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAssociationPlan {
    version: u32,
    source_fingerprint: String,
    selection: ProjectTargetSelection,
    record: ImportedProjectAssociation,
}
impl std::fmt::Debug for ProjectAssociationPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectAssociationPlan")
            .field("association_id", &self.record.id)
            .finish_non_exhaustive()
    }
}
impl ProjectAssociationPlan {
    pub fn prepare(
        profile: &Path,
        operation_id: &str,
        action_id: &str,
        source: &ProjectBatchSource,
        selection: ProjectTargetSelection,
        cancel: &ProjectReadCancellation,
    ) -> Result<Self> {
        source.verify_profile(profile)?;
        selection.verify_source(source)?;
        source.validate(cancel)?;
        let owner = ImportedProjectOwner {
            operation_id: operation_id.to_owned(),
            action_id: action_id.to_owned(),
        };
        let id = format!("prj-{:x}", Sha256::digest(serde_json::to_vec(&owner)?));
        let record = ImportedProjectAssociation {
            id,
            owner,
            source: ImportedProjectSource {
                source: source.source(),
                format_revision: source.format_revision().to_owned(),
                project_id: source.logical_identity(),
                project_name: source.record().name.clone(),
                snapshot_sha256: format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(source.record())?)
                ),
            },
            target: selection.target().clone(),
            revision: 1,
        };
        let store = ImportedProjectAssociationsStore::open(profile)?;
        selection.check(profile, &store, &record)?;
        Ok(Self {
            version: 1,
            source_fingerprint: source.identity().to_owned(),
            selection,
            record,
        })
    }
    pub fn verify_host_context(
        &self,
        profile: &Path,
        workspace: &Path,
        registry: Option<&Path>,
    ) -> Result<()> {
        self.selection
            .verify_host_context(profile, workspace, registry)
    }
    pub fn record_fingerprint(&self) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.record)?)
        ))
    }
    pub fn target_name(&self) -> &str {
        &self.record.target.project_key
    }
    pub fn semantic_fingerprint(&self) -> Result<String> {
        Self::semantic(&self.record.source, &self.record.target)
    }
    pub fn requested_fingerprint(
        source: &ProjectBatchSource,
        selection: &ProjectTargetSelection,
    ) -> Result<String> {
        selection.verify_source(source)?;
        let origin = ImportedProjectSource {
            source: source.source(),
            format_revision: source.format_revision().to_owned(),
            project_id: source.logical_identity(),
            project_name: source.record().name.clone(),
            snapshot_sha256: String::new(),
        };
        Self::semantic(&origin, selection.target())
    }
    fn semantic(source: &ImportedProjectSource, target: &ImportedProjectTarget) -> Result<String> {
        // Source order/timestamps stay in the original snapshot. Native workspace labels/order
        // are user-owned and not replaced; reuse preserves the original association's receipt.
        let roots = target
            .roots
            .iter()
            .map(|root| (&root.source_path, &root.target_root, &root.target_identity))
            .collect::<Vec<_>>();
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                source.source,
                &source.format_revision,
                &source.project_id,
                &source.project_name,
                &target.project_key,
                &target.workspace_identity,
                roots
            ))?)
        ))
    }
    pub fn observe(&self, profile: &Path) -> Result<Option<bool>> {
        let receipt = self.read_receipt(profile)?;
        if !receipt.is_some_and(|receipt| receipt.stage == ImportedProjectReceiptStage::Associated)
        {
            return Ok(None);
        }
        let store = ImportedProjectAssociationsStore::open(profile)?;
        self.selection.check(profile, &store, &self.record)?;
        Ok(Some(false))
    }
    pub fn id(&self) -> &str {
        &self.record.id
    }
    pub fn record(&self) -> &ImportedProjectAssociation {
        &self.record
    }
    pub fn read_receipt(&self, profile: &Path) -> Result<Option<ImportedProjectReceipt>> {
        ensure!(self.version == 1, "migration_project_plan_unsupported");
        self.selection.verify_profile(profile)?;
        let receipt =
            ImportedProjectAssociationsStore::open(profile)?.receipt(&self.record.owner)?;
        if let Some(receipt) = &receipt {
            self.verify_receipt(receipt)?;
        }
        Ok(receipt)
    }
    fn verify_receipt(&self, receipt: &ImportedProjectReceipt) -> Result<()> {
        ensure!(
            receipt.association_id == self.record.id
                && receipt.owner == self.record.owner
                && receipt.record_revision == self.record.revision
                && receipt.record_sha256
                    == format!("{:x}", Sha256::digest(serde_json::to_vec(&self.record)?)),
            "migration_project_receipt_changed"
        );
        Ok(())
    }
    pub fn publish(
        &self,
        profile: &Path,
        source: &ProjectBatchSource,
        cancel: &ProjectReadCancellation,
    ) -> Result<ImportedProjectReceipt> {
        ensure!(self.version == 1, "migration_project_plan_unsupported");
        self.selection.verify_profile(profile)?;
        source.verify_profile(profile)?;
        ensure!(
            self.source_fingerprint == source.identity(),
            "migration_project_source_changed"
        );
        let store = ImportedProjectAssociationsStore::open(profile)?;
        // A determined original association remains determined after cancellation or source loss.
        if let Some(receipt) = store.receipt(&self.record.owner)? {
            self.verify_receipt(&receipt)?;
            ensure!(
                receipt.stage == ImportedProjectReceiptStage::Associated,
                "migration_project_already_removed"
            );
            return Ok(receipt);
        }
        ensure!(!cancel.is_cancelled(), "migration_project_source_cancelled");
        source.validate(cancel)?;
        ensure!(!cancel.is_cancelled(), "migration_project_source_cancelled");
        let receipt = self.selection.associate(profile, &store, &self.record)?;
        self.verify_receipt(&receipt)?;
        Ok(receipt)
    }
    pub fn undo(&self, profile: &Path) -> Result<ImportedProjectReceipt> {
        ensure!(self.version == 1, "migration_project_plan_unsupported");
        self.selection.verify_profile(profile)?;
        let receipt =
            ImportedProjectAssociationsStore::open(profile)?.remove_owned(&self.record)?;
        self.verify_receipt(&receipt)?;
        ensure!(
            receipt.stage == ImportedProjectReceiptStage::Removed,
            "migration_project_rollback_conflict"
        );
        Ok(receipt)
    }
}
