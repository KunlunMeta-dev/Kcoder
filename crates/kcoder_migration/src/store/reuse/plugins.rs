//! Reuse observes the original installation and retains its original parent ownership.
use super::*;
use crate::{
    batch::plugins::PluginBatchAction,
    plugin_migration::{PluginBatchSource, PluginPlanReference},
};
use anyhow::Context;

pub(in crate::store) struct PluginOrigin {
    source: PluginBatchSource,
    reference: PluginPlanReference,
    target_name: String,
}
impl PluginOrigin {
    pub(super) fn new(
        batch: &crate::batch::BatchState,
        job_id: &str,
        action_id: &str,
        item_id: &str,
        plan: &PluginBatchAction,
        receipt: &ItemCommitReceipt,
    ) -> Result<Self> {
        let BatchSource::Plugin(source) = batch.source_for(item_id)? else {
            anyhow::bail!("migration_invalid_journal")
        };
        let reference = plan
            .reference
            .as_ref()
            .context("migration_plugin_reference_changed")?;
        ensure!(
            reference.belongs_to(job_id, action_id)
                && reference.operation_id() == source.operation_id()
                && reference.target_id() == source.target_id(&plan.target_name)?
                && receipt.target_id == reference.target_id()
                && receipt.target_revision == reference.receipt_fingerprint()?,
            "migration_plugin_reference_changed"
        );
        Ok(Self {
            source: (**source).clone(),
            reference: reference.clone(),
            target_name: plan.target_name.clone(),
        })
    }
    pub(super) fn fingerprint(&self) -> Result<String> {
        self.source.semantic_fingerprint(&self.target_name)
    }
    pub(super) fn name(&self) -> &str {
        &self.target_name
    }
    pub(super) fn observe(&self, directory: &PrivateDirectory) -> Result<Option<bool>> {
        let store = self.source.open_batch_store(directory)?;
        store.observe_reference_for_batch(&self.reference)
    }
}
