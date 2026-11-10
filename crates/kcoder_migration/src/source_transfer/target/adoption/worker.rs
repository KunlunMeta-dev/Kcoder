//! Scanning is cancellable. Only an original preallocated preview file is published.
use super::*;
use crate::{
    batch::{BatchSource, history::HistoryBatchSource},
    store::MigrationStore,
};

impl IncomingTransfers {
    pub fn execute_adoption(
        &self,
        owner: ReceivedAdoptionLease,
        mut check: impl FnMut(u64) -> bool,
    ) -> Result<ReceivedAdoptionState> {
        ensure!(
            owner.intent.profile_identity == self.store.identity
                && owner.intent.target == self.store.authority,
            "source_transfer_wrong_consumer"
        );
        let directory = &owner.directory;
        let anchor: Anchor =
            load(directory, "binding.json")?.context("source_transfer_adoption_unknown")?;
        ensure!(
            anchor.binding == digest(&owner.intent)?
                && anchor.directory == directory.directory_identity()?,
            "source_transfer_adoption_unknown"
        );
        let mut journal = Self::adoption_journal(directory)?;
        ensure!(
            journal.intent == owner.intent,
            "source_transfer_adoption_changed"
        );
        journal.phase = ReceivedAdoptionPhase::Scanning;
        journal.error_code = None;
        save(directory, "adoption.json", &journal)?;
        let result = self.scan_adoption(directory, &mut journal, &mut |bytes| {
            owner.verify().is_ok() && check(bytes)
        });
        if let Err(error) = result {
            journal.phase = if error.to_string() == "source_transfer_cancelled" {
                if control(directory)?.state(false).cancelled {
                    ReceivedAdoptionPhase::Cancelled
                } else {
                    ReceivedAdoptionPhase::Interrupted
                }
            } else if error.to_string() == "source_transfer_adoption_unknown" {
                ReceivedAdoptionPhase::Unknown
            } else {
                ReceivedAdoptionPhase::Failed
            };
            journal.error_code = Some(
                match error.to_string().as_str() {
                    "source_transfer_cancelled" => "source_transfer_cancelled",
                    "source_transfer_project_mapping_changed" => {
                        "source_transfer_project_mapping_changed"
                    }
                    "source_transfer_adoption_unknown" => "source_transfer_adoption_unknown",
                    "migration_instruction_target_changed"
                    | "source_transfer_instruction_mapping_changed" => {
                        "source_transfer_instruction_mapping_changed"
                    }
                    "migration_instruction_target_untrusted" => {
                        "source_transfer_instruction_target_untrusted"
                    }
                    _ => "source_transfer_adoption_scan_failed",
                }
                .into(),
            );
            save(directory, "adoption.json", &journal)?;
        }
        drop(owner);
        self.read_adoption(&journal.intent.request, &journal.intent.adoption)?
            .context("source_transfer_adoption_unknown")
    }
    fn adoption_progress(journal: &mut Journal) -> Result<()> {
        let mut completed = 0u32;
        let mut blocked = 0u32;
        for (index, published) in journal.published.iter().enumerate() {
            if *published {
                completed = completed
                    .checked_add(journal.intent.groups[index].entries.len().try_into()?)
                    .context("source_transfer_adoption_unknown")?;
                blocked = blocked
                    .checked_add(
                        journal.publications[index]
                            .as_ref()
                            .context("source_transfer_adoption_unknown")?
                            .blocked,
                    )
                    .context("source_transfer_adoption_unknown")?;
            }
        }
        journal.completed_sources = completed;
        journal.blocked_items = blocked;
        Ok(())
    }
    fn scan_adoption(
        &self,
        directory: &PrivateDirectory,
        journal: &mut Journal,
        check: &mut impl FnMut(u64) -> bool,
    ) -> Result<()> {
        let store = MigrationStore::open_existing(&self.store.profile)?;
        let migrations = PrivateDirectory::open_existing(&self.store.profile)?
            .open_child(OsStr::new("migrations"), false)?;
        for index in 0..journal.intent.groups.len() {
            let group = journal.intent.groups[index].clone();
            let proof = journal.intent.proof(index)?;
            if journal.publications[index].is_some() {
                let saved = store
                    .verify_received_batch(&group.job_id, &proof)
                    .map_err(|_| anyhow::anyhow!("source_transfer_adoption_unknown"))?;
                if !journal.published[index] {
                    let publication = journal.publications[index].as_ref().unwrap();
                    ensure!(
                        saved.sequence == 1
                            && migrations.portable_regular_identity(OsStr::new(&format!(
                                "{}.json",
                                group.job_id
                            )))? == publication.identity
                            && digest(&saved)? == publication.sha256,
                        "source_transfer_adoption_unknown"
                    );
                }
                journal.published[index] = true;
                Self::adoption_progress(journal)?;
                save(directory, "adoption.json", journal)?;
                continue;
            }
            match migrations.entry_metadata(OsStr::new(&format!("{}.json", group.job_id))) {
                Err(error) if missing(&error) => {}
                _ => anyhow::bail!("source_transfer_adoption_unknown"),
            }
            let mut inputs = Vec::new();
            for entry_id in &group.entries {
                active(directory)?;
                ensure!(
                    check(journal.completed_sources as u64),
                    "source_transfer_cancelled"
                );
                let binding = self.received_binding(
                    &journal.intent.request,
                    &journal.intent.receipt.manifest_sha256,
                    entry_id,
                )?;
                let input = match &binding.entry().content {
                    TransferContent::ProjectInventory { .. } => {
                        BatchSource::Project(Box::new(self.received_project_source(
                            &journal.intent.request,
                            &journal.intent.receipt.manifest_sha256,
                            entry_id,
                        )?))
                    }
                    TransferContent::InstructionBundle { .. } => {
                        self.instruction_input(journal, entry_id, check)?
                    }
                    TransferContent::PluginPackage { .. } => {
                        self.plugin_input(directory, journal, index, entry_id, check)?
                    }
                    TransferContent::ConfigurationInventory { .. } => {
                        BatchSource::TransferredConfiguration(Box::new(
                            self.configuration_binding(
                                &journal.intent.request,
                                binding.source(),
                                entry_id,
                                &journal.intent.receipt,
                            )?,
                        ))
                    }
                    TransferContent::WorkAsset { scope, .. } => {
                        let project = matches!(
                            scope,
                            kcoder_config::imported_context::ImportedContextScope::Project { .. }
                        )
                        .then(|| {
                            journal
                                .intent
                                .project
                                .clone()
                                .context("source_transfer_project_mapping_required")
                        })
                        .transpose()?;
                        BatchSource::Assets(self.received_asset_binding(
                            &journal.intent.request,
                            &journal.intent.receipt.manifest_sha256,
                            entry_id,
                            project,
                        )?)
                    }
                    TransferContent::History { .. } => BatchSource::History(Box::new(
                        HistoryBatchSource::new(self.received_history_selection(
                            &journal.intent.request,
                            &journal.intent.receipt.manifest_sha256,
                            entry_id,
                            |bytes| active(directory).is_ok() && check(bytes),
                        )?)?,
                    )),
                };
                inputs.push(input);
            }
            if inputs
                .iter()
                .any(|input| matches!(input, BatchSource::History(_)))
            {
                // Match normal history scan: prepare the target service without creating a child.
                crate::history_jobs::HistoryJobStore::open(&self.store.profile)?;
            }
            let job = store.freeze_received_batch(&group.job_id, inputs, proof, &mut |bytes| {
                active(directory).is_ok() && check(bytes)
            })?;
            let blocked = job
                .inventory
                .items
                .iter()
                .filter(|item| {
                    item.preview
                        .issues
                        .iter()
                        .any(|issue| issue.blocks_import())
                })
                .count() as u32;
            let job_sha = digest(&job)?;
            let completed_sources = journal.completed_sources;
            store.publish_received_batch(
                &job,
                || {
                    active(directory)?;
                    ensure!(check(completed_sources as u64), "source_transfer_cancelled");
                    Ok(())
                },
                |file| {
                    journal.publications[index] = Some(Publication {
                        identity: migrations.portable_regular_handle_identity(file)?,
                        sha256: job_sha,
                        blocked,
                    });
                    save(directory, "adoption.json", journal)
                },
            )?;
            #[cfg(test)]
            if FAIL_AFTER_PREVIEW_PUBLICATION.with(|flag| flag.replace(false)) {
                anyhow::bail!("source_transfer_adoption_interrupted");
            }
            journal.published[index] = true;
            Self::adoption_progress(journal)?;
            save(directory, "adoption.json", journal)?;
        }
        journal.phase = ReceivedAdoptionPhase::PreviewReady;
        journal.error_code = None;
        save(directory, "adoption.json", journal)
    }
}
