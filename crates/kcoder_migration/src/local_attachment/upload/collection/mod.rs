//! Explicit retirement of original upload data; audit and historical source pins stay separate.
use super::*;
use kcoder_config::{PrivateLeaseMode, VerifiedPrivateLease};
mod model;
mod plan;
mod publish;
mod run;
mod temporary;
#[cfg(test)]
mod tests;
pub(in crate::local_attachment::upload) use model::Birth;
use model::*;
pub use model::{UploadCollectionPage, UploadCollectionStage, UploadCollectionView};

impl Operation<'_> {
    fn collection_control(&self) -> Result<VerifiedPrivateLease> {
        let birth = self.collection_birth()?;
        self.directory
            .try_existing_portable_lock(
                OsStr::new("collection-control.lock"),
                &birth.collection_control,
                PrivateLeaseMode::Exclusive,
            )?
            .context("local_upload_collection_busy")
    }
    fn collection_execution(&self) -> Result<Option<VerifiedPrivateLease>> {
        let birth = self.collection_birth()?;
        self.directory.try_existing_portable_lock(
            OsStr::new("collection-writer.lock"),
            &birth.collection_writer,
            PrivateLeaseMode::Exclusive,
        )
    }
    fn edit_collection(&self, change: impl FnOnce(&mut Record) -> Result<()>) -> Result<Record> {
        let _control = self.collection_control()?;
        let mut record = self
            .collection_record()?
            .context("local_upload_collection_not_prepared")?;
        change(&mut record)?;
        record.sequence = record
            .sequence
            .checked_add(1)
            .context("local_upload_collection_sequence_exhausted")?;
        write_json(&self.directory, "collection.json", &record, BUDGET)?;
        Ok(record)
    }
    fn completion(&self, record: &Record) -> Result<Option<Completion>> {
        let Some(identity) = &record.completion else {
            return Ok(None);
        };
        let file = match self
            .directory
            .portable_open_verified_regular(OsStr::new("collection-complete.json"), identity)
        {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.file().metadata()?.len() <= BUDGET,
            "local_upload_collection_metadata_budget"
        );
        let value: Completion = read_json(&self.directory, "collection-complete.json", BUDGET)?
            .context("local_upload_collection_completion_missing")?;
        let plan = self.load_collection_plan(record)?;
        ensure!(
            record.tombstone
                && value.version == 1
                && value.binding == record.binding
                && value.collection_id == record.collection_id
                && record.plan.as_deref() == Some(value.plan.as_str())
                && value.deleted_bytes == record.deleted_bytes
                && value.released_reservation_bytes == plan.reserved_bytes
                && record.removed.len() == plan.leaves.len()
                && record.pending.is_none(),
            "local_upload_collection_completion_changed"
        );
        self.directory
            .portable_open_verified_regular(OsStr::new("collection-complete.json"), identity)?;
        Ok(Some(value))
    }
    pub(in crate::local_attachment::upload) fn collection_refund(&self) -> Result<u64> {
        if self.grant.version != 3 {
            return Ok(0);
        }
        let Some(record) = self.collection_record()? else {
            return Ok(0);
        };
        if !record.tombstone {
            return Ok(0);
        }
        Ok(self
            .completion(&record)?
            .map_or(0, |receipt| receipt.released_reservation_bytes))
    }
    fn collection_view(&self, record: &Record) -> Result<UploadCollectionView> {
        let birth = self.collection_birth()?;
        let execution = self.directory.try_existing_portable_lock(
            OsStr::new("collection-writer.lock"),
            &birth.collection_writer,
            PrivateLeaseMode::Shared,
        )?;
        let running = execution.is_none();
        // The supplied snapshot may predate a worker's final checkpoint. Once
        // idle is proven, retain that original lease and reload its outcome;
        // otherwise an old Collecting record becomes a spurious Unknown.
        let settled = if running {
            None
        } else {
            Some(
                self.collection_record()?
                    .context("local_upload_collection_not_prepared")?,
            )
        };
        let record = settled.as_ref().unwrap_or(record);
        let completion = self.completion(record)?;
        let stage = if completion.is_some() {
            UploadCollectionStage::Collected
        } else if record.stage == UploadCollectionStage::Collected
            || record.stage == UploadCollectionStage::Collecting && !running
        {
            UploadCollectionStage::OutcomeUnknown
        } else {
            record.stage
        };
        Ok(UploadCollectionView {
            operation_id: self.grant.operation_id.clone(),
            selection: self.grant.frozen.selection.clone(),
            collection_id: record.collection_id.clone(),
            sequence: record.sequence,
            upload_sequence: record.upload_sequence,
            stage,
            cancel_requested: record.cancel_revision > record.acknowledged,
            cancel_revision: record.cancel_revision,
            storage_retired: record.tombstone,
            deleted_bytes: record.deleted_bytes,
            released_reservation_bytes: completion
                .map_or(0, |receipt| receipt.released_reservation_bytes),
            worker_running: running,
            failure_code: record.failure.clone(),
        })
    }
}
impl HistoryLocalAttachmentUploads {
    /// Reserve a canonical collection control before long hashing. No data is deleted
    /// and no upload/source reference is retired by this preparation step.
    pub fn prepare_collection(
        &self,
        operation_id: &str,
        upload_sequence: u64,
    ) -> Result<UploadCollectionView> {
        let op = self.operation_inner(operation_id, true)?;
        op.collection_birth()?;
        op.check_sequence(upload_sequence)?;
        let _control = op.collection_control()?;
        if let Some(record) = op.collection_record()? {
            return op.collection_view(&record);
        }
        let record = Record {
            version: 1,
            binding: op.collection_binding()?,
            collection_id: op.collection_id()?,
            upload_sequence,
            sequence: 1,
            stage: UploadCollectionStage::Prepared,
            cancel_revision: 0,
            acknowledged: 0,
            tombstone: false,
            plan: None,
            prior_plans: Vec::new(),
            pending: None,
            removed: Vec::new(),
            deleted_bytes: 0,
            completion: None,
            failure: None,
        };
        write_json(&op.directory, "collection.json", &record, BUDGET)?;
        op.collection_view(&record)
    }
    /// Read-only: missing controls/receipts never create storage or become a refund.
    pub fn read_collection(&self, operation_id: &str) -> Result<Option<UploadCollectionView>> {
        let op = self.operation_inner(operation_id, false)?;
        op.collection_birth()?;
        op.collection_record()?
            .map(|record| op.collection_view(&record))
            .transpose()
    }
    pub fn list_collections(
        &self,
        selection: &HistoricalAttachmentSelection,
        cursor: Option<&str>,
    ) -> Result<UploadCollectionPage> {
        if let Some(cursor) = cursor {
            id(cursor)?;
        }
        let mut selected = Vec::new();
        let mut metadata = 0u64;
        for operation_id in self.ids()? {
            let operation = self.operation_inner(&operation_id, false)?;
            metadata = metadata
                .checked_add(serde_json::to_vec(&operation.grant)?.len() as u64)
                .context("local_upload_collection_metadata_budget")?;
            ensure!(
                metadata <= 16 * 1024 * 1024,
                "local_upload_collection_metadata_budget"
            );
            if operation.grant.version == 3
                && operation.grant.frozen.selection == *selection
                && cursor.is_none_or(|cursor| operation_id.as_str() > cursor)
                && operation.collection_record()?.is_some()
            {
                selected.push(operation_id);
            }
        }
        let next_cursor = (selected.len() > 10).then(|| selected[9].clone());
        let items = selected
            .into_iter()
            .take(10)
            .map(|operation_id| {
                self.read_collection(&operation_id)?
                    .context("local_upload_collection_not_prepared")
            })
            .collect::<Result<_>>()?;
        Ok(UploadCollectionPage { items, next_cursor })
    }
    pub fn cancel_collection(
        &self,
        operation_id: &str,
        collection_id: &str,
    ) -> Result<UploadCollectionView> {
        let op = self.operation_inner(operation_id, false)?;
        let record = op.edit_collection(|record| {
            ensure!(
                record.collection_id == collection_id,
                "local_upload_collection_control_changed"
            );
            if record.stage != UploadCollectionStage::Collected
                && record.cancel_revision == record.acknowledged
            {
                record.cancel_revision = record
                    .cancel_revision
                    .checked_add(1)
                    .context("local_upload_collection_sequence_exhausted")?;
                if !record.tombstone {
                    record.stage = UploadCollectionStage::Cancelled;
                }
            }
            Ok(())
        })?;
        op.collection_view(&record)
    }
    /// Rebase the observed upload sequence only before any tombstone or deletion.
    /// This is explicit confirmation, never implicit source selection or automatic resume.
    pub fn resume_collection(
        &self,
        operation_id: &str,
        collection_id: &str,
        sequence: u64,
        upload_sequence: u64,
    ) -> Result<UploadCollectionView> {
        let op = self.operation_inner(operation_id, true)?;
        let _execution = op
            .collection_execution()?
            .context("local_upload_collection_busy")?;
        op.check_sequence(upload_sequence)?;
        let record = op.edit_collection(|record| {
            ensure!(
                record.sequence == sequence && record.collection_id == collection_id,
                "local_upload_collection_stale_sequence"
            );
            if record.stage == UploadCollectionStage::Collected {
                return Ok(());
            }
            if record.upload_sequence != upload_sequence {
                ensure!(
                    !record.tombstone
                        && record.pending.is_none()
                        && record.removed.is_empty()
                        && record.deleted_bytes == 0
                        && record.completion.is_none(),
                    "local_upload_collection_upload_changed"
                );
                if let Some(plan) = record.plan.take() {
                    ensure!(
                        record.prior_plans.len() < 16,
                        "local_upload_collection_plan_budget"
                    );
                    record.prior_plans.push(plan);
                }
                record.upload_sequence = upload_sequence;
            }
            record.acknowledged = record.cancel_revision;
            record.stage = if record.tombstone {
                UploadCollectionStage::Collecting
            } else {
                UploadCollectionStage::Prepared
            };
            record.failure = None;
            Ok(())
        })?;
        drop(_execution);
        op.collection_view(&record)
    }
}
