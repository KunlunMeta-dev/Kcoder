//! A durable parent action claims exactly one Native plugin operation before installation.
use super::*;
use crate::{
    batch::plugins::PluginBatchAction,
    plugin_migration::{
        PluginBatchSource, PluginMigrationStage, PluginMigrationView, PluginPlanReference,
    },
};
use kcoder_plugins::PluginCancellationToken;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

fn native_error(error: anyhow::Error) -> anyhow::Error {
    let code = match error.to_string().as_str() {
        "plugin_migration_claimed_by_another_owner" => "migration_plugin_owned_by_another_batch",
        "plugin_migration_reference_changed"
        | "plugin_migration_consumer_changed"
        | "plugin_migration_profile_changed" => "migration_wrong_target",
        "plugin_migration_plan_not_ready" => "migration_plugin_plan_not_ready",
        "plugin_migration_busy" => "migration_plugin_busy",
        _ => match crate::plugin_migration::error_code(&error) {
            "plugin_migration_user_policy_changed" => "migration_plugin_user_policy_changed",
            "plugin_migration_target_changed" => "migration_plugin_target_changed",
            "plugin_migration_in_use" => "migration_plugin_in_use",
            "plugin_migration_output_missing" => "migration_plugin_output_missing",
            "plugin_migration_source_changed" => "migration_source_changed",
            "plugin_migration_source_unavailable" => "migration_source_unavailable",
            "plugin_migration_cancelled" => "migration_plugin_cancelled",
            _ => "migration_plugin_outcome_unknown",
        },
    };
    anyhow::anyhow!(code)
}

impl MigrationStore {
    fn plugin_source<'a>(
        &self,
        job: &'a MigrationJob,
        action: &BatchAction,
    ) -> Result<&'a PluginBatchSource> {
        ensure!(action.item_ids.len() == 1, "migration_invalid_journal");
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        let BatchSource::Plugin(source) = batch.source_for(&action.item_ids[0])? else {
            anyhow::bail!("migration_invalid_batch_resolution")
        };
        source
            .verify_batch_parent(&self.directory)
            .map_err(native_error)?;
        Ok(source)
    }

    fn pinned_plugin(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &PluginBatchAction,
    ) -> Result<PluginPlanReference> {
        let source = self.plugin_source(job, action)?;
        let store = source
            .open_batch_store(&self.directory)
            .map_err(native_error)?;
        let consumer = store
            .batch_consumer(&job.job_id, &action.action_id)
            .map_err(native_error)?;
        let reference = store
            .pin_for_batch(source, &consumer, &plan.target_name)
            .map_err(native_error)?;
        ensure!(
            plan.reference
                .as_ref()
                .is_none_or(|saved| saved == &reference),
            "migration_plugin_reference_changed"
        );
        if plan.reference.is_none() {
            let _lease = self.batch_write_lock()?;
            let mut current = self.load(&job.job_id)?;
            let target = current
                .batch
                .as_mut()
                .context("migration_not_a_batch")?
                .actions
                .iter_mut()
                .find(|current| {
                    current.action_id == action.action_id && current.item_ids == action.item_ids
                })
                .context("migration_plugin_reference_changed")?;
            let BatchActionKind::Plugin { plan: saved } = &mut target.action else {
                anyhow::bail!("migration_plugin_reference_changed")
            };
            ensure!(
                saved.target_name == plan.target_name
                    && saved
                        .reference
                        .as_ref()
                        .is_none_or(|saved| saved == &reference),
                "migration_plugin_reference_changed"
            );
            if saved.reference.is_none() {
                saved.reference = Some(reference.clone());
                bump(&mut current)?;
                self.save(&current)?;
            }
        }
        Ok(reference)
    }

    // The borrowed caller check cannot become a 'static Native token probe. This owned,
    // scoped worker lets it stop only this action and keeps the runner until it settles.
    fn controlled_plugin<T: Send>(
        &self,
        job_id: &str,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
        work: impl FnOnce(&PluginCancellationToken) -> Result<T> + Send,
    ) -> Result<T> {
        ensure!(
            check(BatchRunEvent::Checkpoint),
            "migration_batch_worker_stopped"
        );
        let token = PluginCancellationToken::default();
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::sync_channel(1);
            let worker_token = token.clone();
            let worker = scope.spawn(move || {
                let _ = tx.send(work(&worker_token));
            });
            let mut observed_at = Instant::now();
            let result = loop {
                match rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(result) => break result,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        break Err(anyhow::anyhow!("migration_plugin_outcome_unknown"));
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !check(BatchRunEvent::Checkpoint) {
                            token.cancel();
                        }
                        if observed_at.elapsed() >= Duration::from_millis(100) {
                            // Native journal replacement is atomic; this bounded snapshot read
                            // does not contend with unrelated jobs' short global write leases.
                            if !self.load(job_id).is_ok_and(|current| {
                                !matches!(
                                    current.status,
                                    JobStatus::CancelRequested | JobStatus::Cancelled
                                )
                            }) {
                                token.cancel();
                            }
                            observed_at = Instant::now();
                        }
                    }
                }
            };
            if worker.join().is_err() {
                return Err(anyhow::anyhow!("migration_plugin_outcome_unknown"));
            }
            result.map_err(native_error)
        })
    }

    pub(super) fn publish_plugin_batch_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &PluginBatchAction,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<crate::providers::ProviderPublication> {
        let source = self.plugin_source(job, action)?;
        let store = source
            .open_batch_store(&self.directory)
            .map_err(native_error)?;
        let reference = self.pinned_plugin(job, action, plan)?;
        let before = store.read_reference(&reference).map_err(native_error)?;
        let cancelled = self.load(&job.job_id)?.status == JobStatus::CancelRequested;
        ensure!(!cancelled || before.imported, "migration_plugin_cancelled");
        let view = if before.imported {
            before
        } else {
            self.controlled_plugin(&job.job_id, check, |cancel| {
                store.apply_reference(&reference, cancel)
            })?
        };
        ensure!(
            view.stage == PluginMigrationStage::Imported && view.imported,
            "migration_plugin_outcome_unknown"
        );
        Ok(crate::providers::ProviderPublication {
            target_id: reference.target_id().into(),
            target_revision: reference.receipt_fingerprint().map_err(native_error)?,
            ownership_confirmed: true,
        })
    }

    pub(super) fn undo_plugin_batch_action(
        &self,
        job: &MigrationJob,
        action: &BatchAction,
        plan: &PluginBatchAction,
        check: &mut dyn FnMut(BatchRunEvent<'_>) -> bool,
    ) -> Result<()> {
        let source = self.plugin_source(job, action)?;
        let store = source
            .open_batch_store(&self.directory)
            .map_err(native_error)?;
        let reference = self.pinned_plugin(job, action, plan)?;
        let receipt = job
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == action.action_id)
            .context("migration_commit_receipt_required")?;
        ensure!(
            receipt.target_id == reference.target_id()
                && receipt.target_revision
                    == reference.receipt_fingerprint().map_err(native_error)?
                && receipt.ownership_confirmed,
            "migration_plugin_reference_changed"
        );
        let view: PluginMigrationView = self.controlled_plugin(&job.job_id, check, |cancel| {
            store.undo_reference(&reference, cancel)
        })?;
        ensure!(
            view.stage == PluginMigrationStage::Undone && view.imported,
            "migration_plugin_outcome_unknown"
        );
        Ok(())
    }
}
