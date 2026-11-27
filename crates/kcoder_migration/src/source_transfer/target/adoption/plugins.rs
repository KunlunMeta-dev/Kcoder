//! A preview owns its received plugin children before final batch/action claims exist.
use super::*;
use crate::{
    batch::{BatchSource, ReceivedBatchBinding},
    plugin_migration::{PluginMigrationStage, PluginMigrationStore},
};
use kcoder_plugins::{PluginCancellationToken, PluginProjectBinding};
use std::{sync::mpsc, time::Duration};
impl IncomingTransfers {
    pub(crate) fn verify_plugin_preview(
        &self,
        proof: &ReceivedBatchBinding,
        job_id: &str,
        entry_id: &str,
    ) -> Result<()> {
        let directory = self
            .adoption_directory(&proof.request_id, &proof.adoption_id)?
            .context("source_transfer_adoption_unknown")?;
        let journal = Self::adoption_journal(&directory)?;
        let group = journal
            .intent
            .groups
            .get(proof.group as usize)
            .context("source_transfer_adoption_changed")?;
        ensure!(
            journal.intent.proof(proof.group as usize)? == *proof
                && group.job_id == job_id
                && group.entries.iter().any(|id| id == entry_id),
            "source_transfer_adoption_changed"
        );
        Ok(())
    }
    pub(super) fn plugin_input(
        &self,
        directory: &PrivateDirectory,
        journal: &Journal,
        index: usize,
        entry_id: &str,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<BatchSource> {
        let group = &journal.intent.groups[index];
        let proof = journal.intent.proof(index)?;
        let candidate = self.received_plugin_candidate(
            &journal.intent.request,
            &journal.intent.receipt.manifest_sha256,
            entry_id,
            &group.job_id,
            &proof,
        )?;
        let mapping = if matches!(candidate.scope.as_str(), "project" | "local") {
            let target = proof
                .project
                .as_ref()
                .context("source_transfer_project_mapping_required")?;
            target.verify(&self.store.profile)?;
            Some(PluginProjectBinding::capture(
                &self.store.profile,
                target.root(),
            )?)
        } else {
            None
        };
        // This deterministic child is subordinate to the already durable original adoption intent.
        let identity = digest(&(
            "received-plugin-child/1",
            &proof,
            entry_id,
            &self.store.identity,
        ))?;
        let mut bytes = [0u8; 16];
        for (i, value) in bytes.iter_mut().enumerate() {
            *value = u8::from_str_radix(&identity[i * 2..i * 2 + 2], 16)
                .map_err(|_| anyhow::anyhow!("source_transfer_adoption_changed"))?;
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let child = uuid::Uuid::from_bytes(bytes).to_string();
        let store = PluginMigrationStore::open(&self.store.profile)?;
        let mut state = store.prepare_mapped(&child, &candidate, None, mapping.as_ref())?;
        if matches!(
            state.stage,
            PluginMigrationStage::Cancelled
                | PluginMigrationStage::OutcomeUnknown
                | PluginMigrationStage::Capturing
        ) {
            ensure!(
                active(directory).is_ok() && check(0),
                "source_transfer_cancelled"
            );
            state = store.resume_received_owned(&child, state.sequence, &group.job_id)?;
        }
        if state.stage != PluginMigrationStage::Ready {
            let token = PluginCancellationToken::default();
            let result = std::thread::scope(|scope| {
                let (tx, rx) = mpsc::sync_channel(1);
                let cancel = token.clone();
                let worker_store = PluginMigrationStore::open_existing(&self.store.profile)?
                    .context("plugin_migration_store_missing")?;
                let child = child.clone();
                let preview = group.job_id.clone();
                let sequence = state.sequence;
                let worker = scope.spawn(move || {
                    let _ = tx.send(
                        worker_store.capture_received_owned(&child, sequence, &preview, &cancel),
                    );
                });
                let result = loop {
                    match rx.recv_timeout(Duration::from_millis(25)) {
                        Ok(result) => break result,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            break Err(anyhow::anyhow!("source_transfer_adoption_unknown"));
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if active(directory).is_err() || !check(0) {
                                token.cancel();
                            }
                        }
                    }
                };
                worker
                    .join()
                    .map_err(|_| anyhow::anyhow!("source_transfer_adoption_unknown"))?;
                result
            })?;
            state = result;
        }
        ensure!(
            state.stage == PluginMigrationStage::Ready,
            "source_transfer_plugin_pending"
        );
        Ok(BatchSource::Plugin(Box::new(
            store.batch_source_for_received(&child, state.sequence, &group.job_id)?,
        )))
    }
}
