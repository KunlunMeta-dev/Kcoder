//! Explicit controls mutate only the original capture, never an ordinary job run.
use super::{
    BatchCreateIntent, BatchCreationObservation,
    files::CreationFiles,
    model::{ControlAction, ControlReceipt},
};
use crate::store::MigrationStore;
use anyhow::{Result, ensure};

impl MigrationStore {
    /// A request-only control may stop original capture; it never exposes an intent for a new resolver.
    pub fn cancel_batch_creation_request(
        &self,
        original_request_id: &str,
        control_request_id: &str,
        expected_revision: u64,
    ) -> Result<BatchCreationObservation> {
        let files = CreationFiles::lookup(&self.directory, &self.profile, original_request_id)?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unavailable"))?;
        let intent =
            BatchCreateIntent::from_original(&files.birth.request_id, &files.birth.intent_sha256)?;
        self.cancel_batch_creation(&intent, control_request_id, expected_revision)
    }
    pub fn cancel_batch_creation(
        &self,
        intent: &BatchCreateIntent,
        request_id: &str,
        expected_revision: u64,
    ) -> Result<BatchCreationObservation> {
        self.control_batch_creation(intent, request_id, expected_revision, ControlAction::Cancel)
    }
    /// Resume records consent to continue; this method never resolves or reads sources.
    pub fn resume_batch_creation(
        &self,
        intent: &BatchCreateIntent,
        request_id: &str,
        expected_revision: u64,
    ) -> Result<BatchCreationObservation> {
        self.control_batch_creation(intent, request_id, expected_revision, ControlAction::Resume)
    }
    fn control_batch_creation(
        &self,
        intent: &BatchCreateIntent,
        request_id: &str,
        expected_revision: u64,
        action: ControlAction,
    ) -> Result<BatchCreationObservation> {
        super::model::uuid(request_id)?;
        let files = CreationFiles::lookup(&self.directory, &self.profile, intent.request_id())?
            .ok_or_else(|| anyhow::anyhow!("migration_batch_creation_unavailable"))?;
        files.require_intent(intent)?;
        {
            let lease = files.control_lease()?;
            let mut control = files.control()?;
            if let Some(receipt) = control
                .receipts
                .iter()
                .find(|receipt| receipt.request_id == request_id)
            {
                ensure!(
                    receipt.action == action && receipt.expected_revision == expected_revision,
                    "migration_request_conflict"
                );
            } else {
                ensure!(
                    !files.publication_started()?,
                    "migration_invalid_transition"
                );
                if action == ControlAction::Resume {
                    ensure!(!files.running()?, "migration_batch_creation_busy");
                }
                ensure!(
                    control.revision == expected_revision,
                    "migration_revision_conflict"
                );
                ensure!(
                    control.receipts.len() < 128,
                    "migration_request_budget_exceeded"
                );
                control.revision += 1;
                control.cancel_requested = action != ControlAction::Resume;
                control.receipts.push(ControlReceipt {
                    request_id: request_id.into(),
                    action,
                    expected_revision,
                    revision: control.revision,
                });
                files.save_control(&control, &lease)?;
            }
        }
        self.creation_observation(&files)
    }
}

pub(super) fn acknowledge_cancel(files: &CreationFiles) -> Result<()> {
    let lease = files.control_lease()?;
    let mut control = files.control()?;
    if control.cancel_requested {
        return Ok(());
    }
    ensure!(
        control.receipts.len() < 128,
        "migration_request_budget_exceeded"
    );
    let expected_revision = control.revision;
    control.revision += 1;
    control.cancel_requested = true;
    control.receipts.push(ControlReceipt {
        request_id: uuid::Uuid::new_v4().to_string(),
        action: ControlAction::WorkerCancelled,
        expected_revision,
        revision: control.revision,
    });
    files.save_control(&control, &lease)
}
