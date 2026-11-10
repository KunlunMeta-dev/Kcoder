//! Source-fenced mutation and process-local append evidence.
use super::*;

impl HistorySource {
    /// Read-only preflight used only to select whether a strong append receipt
    /// is possible. Actual writing still rechecks under the native source lock.
    pub(crate) fn has_existing_body(&self) -> Result<bool> {
        let (directory, name) = match open_parent_with_create(&self.path, false) {
            Ok(value) => value,
            Err(error) if missing(&error) => return Ok(false),
            Err(error) => return Err(error),
        };
        match directory.open_single_link_regular_file(&name) {
            Ok(_) => Ok(true),
            Err(error) if missing(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Produce process-local evidence from the exact original write handle.
    /// This proves one successful append, not fresh-session coverage or any
    /// authority after the held handles or source lease are lost.
    pub(crate) fn append_with_live_receipt(
        &self,
        bytes: &[u8],
    ) -> Result<live_append_receipt::LiveAppendReceipt> {
        anyhow::ensure!(!bytes.is_empty(), "empty history append has no receipt");
        validate_append(bytes)?;
        let (directory, name) = open_parent_with_create(&self.path, false)?;
        drop(directory.open_single_link_regular_file(&name)?);
        self.mutate_when_optional_with_receipt(None, false, true, |_, _| {
            Ok(Some(Mutation::AppendWitnessed(bytes)))
        })?
        .context("history append did not produce a live receipt")
    }

    pub(super) fn mutate_when_optional_with_receipt<'a>(
        &self,
        expected: Option<&SourceStamp>,
        recover: bool,
        require_live_append: bool,
        prepare: impl FnOnce(&PrivateDirectory, &OsStr) -> Result<Option<Mutation<'a>>>,
    ) -> Result<Option<live_append_receipt::LiveAppendReceipt>> {
        let mut binding = self
            .binding
            .lock()
            .map_err(|_| anyhow::anyhow!("history source binding lock is poisoned"))?;
        #[cfg(target_os = "linux")]
        let mut lineage_advance = binding
            .lineage
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .map(live_lineage::Advance::new);
        let (directory, name) =
            open_parent_with_create(&self.path, !binding.initialized && expected.is_none())?;
        let lock = open_mutation_lock(&directory)?;
        FileExt::lock_exclusive(&lock).context("failed to lock history mutation")?;
        let mut journal_fence = JournalFence::from_locked_history(
            self.path.parent().context("history source has no parent")?,
            lock,
        )?;
        let mut observed = read_source_record(&directory, &name)?;
        binding.verify(observed.as_ref())?;
        if let Some(expected) = expected {
            anyhow::ensure!(
                observed.as_ref() == expected.0.as_ref(),
                "history source changed after resume preparation; prepare it again"
            );
            if let Some(record) = observed.as_mut() {
                if let Err(error) = commit::confirm_completed_pending(
                    &self.path,
                    &directory,
                    &name,
                    record,
                    &mut journal_fence,
                ) {
                    binding.refresh_after_failed_own_write(&directory, &name);
                    return Err(error);
                }
                binding.generation = Some(record.body_generation());
            }
        }
        if !recover
            && let Some(commit) = observed.as_ref().and_then(|record| record.commit.as_ref())
        {
            commit.check_ready()?;
        }
        // The receipt path must pin an existing source before any control
        // record is initialized. A missing historical body is not recreated.
        let live_preparation = if require_live_append {
            Some(live_append_receipt::PreparedLiveAppend::open(
                &directory, &name, &self.path,
            )?)
        } else {
            None
        };
        let journal = journal_fence.begin_history_source(&self.path)?;
        if !binding.initialized {
            // Reject unsafe history leaves before claiming the candidate source.
            drop(existing_file(&directory, &name)?);
            let record = SourceRecord {
                schema_version: 1,
                incarnation: binding.incarnation,
                deleted: false,
                commit: None,
                deletion: None,
            };
            let result = control_publication::publish_initial_record(&directory, &name, &record);
            // A failed directory sync may follow a successful rename. Adopt only our exact
            // published record; an unpublished staging directory grants no source authority.
            if result.is_ok() || read_source_record(&directory, &name)?.as_ref() == Some(&record) {
                binding.initialized = true;
                binding.generation = Some(record.body_generation());
            }
            result?;
            observed = Some(record);
        }
        let Some(mutation) = prepare(&directory, &name)? else {
            finish_source_journal(journal);
            return Ok(None);
        };
        let original = observed.context("history source is not initialized")?;
        let mut metadata_advance = binding
            .metadata_lineage
            .as_ref()
            .cloned()
            .map(metadata_lineage::Advance::new);
        let metadata_observation = metadata_advance
            .as_mut()
            .map(|advance| advance.prepare(&self.path, &directory, &name, &original, &mutation))
            .unwrap_or_default();
        #[cfg(target_os = "linux")]
        let (observe_ready, lineage_preparation) = lineage_advance
            .as_mut()
            .and_then(|advance| {
                advance.prepare(
                    self,
                    &directory,
                    &name,
                    &mutation,
                    live_preparation.as_ref(),
                )
            })
            .unwrap_or((false, None));
        let result = commit_mutation(
            &self.path,
            &directory,
            &name,
            original,
            mutation,
            commit::CommitObservations {
                live_preparation,
                metadata: metadata_observation,
                #[cfg(target_os = "linux")]
                lineage: commit::LineageCommitOptions {
                    preparation: lineage_preparation,
                    observe_ready_publisher: observe_ready,
                },
            },
        );
        match result {
            Ok(committed) => {
                binding.generation = Some(committed.generation);
                finish_source_journal(journal);
                #[cfg(target_os = "linux")]
                if let Some(advance) = lineage_advance {
                    advance.finish(committed.lineage_receipt);
                }
                if let Some(advance) = metadata_advance {
                    advance.finish(
                        &self.path,
                        &directory,
                        &name,
                        committed.metadata_publication,
                    );
                }
                Ok(committed.append_receipt)
            }
            Err(error) => {
                binding.refresh_after_failed_own_write(&directory, &name);
                Err(error)
            }
        }
    }
}
