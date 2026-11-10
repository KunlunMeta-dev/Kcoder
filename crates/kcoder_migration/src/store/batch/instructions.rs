//! Unplanned and unsupported instruction originals remain readable from the owned capture.
use super::*;
pub type SavedInstructionSnapshot = (
    std::sync::Arc<crate::instruction_sources::InstructionSourceSnapshot>,
    String,
);
impl MigrationStore {
    /// Read at most one immutable recipe per selected source; no live source access is required.
    pub fn instruction_snapshots_for_items(
        &self,
        job_id: &str,
        item_ids: &[String],
    ) -> Result<Vec<Option<SavedInstructionSnapshot>>> {
        ensure!(item_ids.len() <= 10, "migration_invalid_page");
        let job = self.read(job_id)?;
        let Some(batch) = &job.batch else {
            return Ok(vec![None; item_ids.len()]);
        };
        let mut snapshots = std::collections::BTreeMap::new();
        let mut result = Vec::new();
        for id in item_ids {
            let item = job
                .inventory
                .items
                .iter()
                .find(|item| item.preview.id == *id)
                .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
            ensure!(
                item.preview.category == kcoder_types::migration::MigrationCategory::Instructions,
                "migration_not_instruction"
            );
            let index = batch
                .item_sources
                .iter()
                .find(|source| source.item_id == *id)
                .ok_or_else(|| anyhow::anyhow!("migration_invalid_journal"))?
                .source_index;
            if let std::collections::btree_map::Entry::Vacant(entry) = snapshots.entry(index) {
                let snapshot = match batch.sources.get(index) {
                    Some(BatchSource::Assets(binding)) => binding.scoped_instruction_snapshot()?,
                    _ => None,
                };
                entry.insert(snapshot);
            }
            result.push(if let Some(snapshot) = &snapshots[&index] {
                Some((
                    snapshot.clone(),
                    item.asset
                        .as_ref()
                        .ok_or_else(|| anyhow::anyhow!("migration_invalid_journal"))?
                        .entry
                        .clone(),
                ))
            } else {
                None
            });
        }
        Ok(result)
    }
    pub fn instruction_compiled_snapshot(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> Result<Option<String>> {
        let job = self.read(job_id)?;
        let Some(batch) = &job.batch else {
            return Ok(None);
        };
        let item = job
            .inventory
            .items
            .iter()
            .find(|item| item.preview.id == item_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let BatchSource::Assets(binding) = batch.source_for(item_id)? else {
            return Ok(None);
        };
        let Some(snapshot) = binding.scoped_instruction_snapshot()? else {
            return Ok(None);
        };
        let entry = &item
            .asset
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_asset"))?
            .entry;
        snapshot.compiled_text(entry).map(Some)
    }
    pub fn instruction_source_snapshot(
        &self,
        job_id: &str,
        item_id: &str,
    ) -> Result<Option<Vec<u8>>> {
        let job = self.read(job_id)?;
        let Some(batch) = &job.batch else {
            return Ok(None);
        };
        let item = job
            .inventory
            .items
            .iter()
            .find(|item| item.preview.id == item_id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        let BatchSource::Assets(binding) = batch.source_for(item_id)? else {
            return Ok(None);
        };
        let Some(snapshot) = binding.scoped_instruction_snapshot()? else {
            return Ok(None);
        };
        let entry = &item
            .asset
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("migration_not_an_asset"))?
            .entry;
        snapshot
            .original_bytes(entry)
            .map(|bytes| Some(bytes.to_vec()))
    }
}
