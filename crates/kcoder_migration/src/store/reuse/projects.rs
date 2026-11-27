use super::*;
use crate::project_migration::ProjectAssociationPlan;
use std::path::{Path, PathBuf};

pub(in crate::store) struct ProjectOrigin {
    plan: ProjectAssociationPlan,
    profile: PathBuf,
    migration_identity: String,
}
impl ProjectOrigin {
    pub(super) fn new(
        profile: &Path,
        directory: &PrivateDirectory,
        plan: &ProjectAssociationPlan,
        receipt: &ItemCommitReceipt,
    ) -> Result<Self> {
        ensure!(
            receipt.target_id == plan.id()
                && receipt.target_revision == plan.record_fingerprint()?,
            "migration_project_receipt_changed"
        );
        Ok(Self {
            plan: plan.clone(),
            profile: profile.to_owned(),
            migration_identity: directory.directory_identity()?,
        })
    }
    pub(super) fn fingerprint(&self) -> Result<String> {
        self.plan.semantic_fingerprint()
    }
    pub(super) fn name(&self) -> &str {
        self.plan.target_name()
    }
    pub(super) fn observe(&self, directory: &PrivateDirectory) -> Result<Option<bool>> {
        ensure!(
            directory.directory_identity()? == self.migration_identity,
            "migration_wrong_target"
        );
        self.plan.observe(&self.profile)
    }
}
