//! Continuation and native-session pins are separate from publication and undo facts.
use super::*;
use kcoder_state::external_history::{
    ExternalHistoryStore,
    lifecycle::{ArchiveReadGuard, ArchiveReferenceKind, ArchiveReferenceOwner},
};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Retired {
    operation: String,
    undo: Option<String>,
    binding: String,
    source_claimed: bool,
}
impl ContinuationJobs {
    fn archives(&self) -> Result<ExternalHistoryStore> {
        ExternalHistoryStore::open_existing(&self.profile)?.context("continuation_source_missing")
    }
    fn source_binding(&self, job: &Job) -> Result<String> {
        hash(&(
            "continuation-source-reference/1",
            &self.owner,
            &job.view.job_id,
            &job.view.source_job_id,
            &job.view.view_id,
            &job.branch_identity,
            &job.view.policy,
            &job.view.options,
        ))
    }
    fn native_binding(&self, job: &Job) -> Result<String> {
        let target = job.target.as_ref().context("continuation_target_changed")?;
        hash(&(
            "native-session-source-reference/1",
            self.source_binding(job)?,
            target,
        ))
    }
    fn source_owner(&self, job: &Job) -> Result<ArchiveReferenceOwner> {
        ArchiveReferenceOwner::new(
            ArchiveReferenceKind::Continuation,
            &job.view.job_id,
            &self.source_binding(job)?,
        )
    }
    fn native_owner(&self, job: &Job) -> Result<ArchiveReferenceOwner> {
        ArchiveReferenceOwner::new(
            ArchiveReferenceKind::NativeSession,
            &format!("native-{}", job.view.job_id),
            &self.native_binding(job)?,
        )
    }
    pub(super) fn pin_source_reference(
        &self,
        job: &mut Job,
        guards: &[ArchiveReadGuard],
    ) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        ensure!(job.retired.is_none(), "continuation_retired");
        let archives = self.archives()?;
        if job.source_reference.is_some() {
            return self.verify_references(job);
        }
        let owner = self.source_owner(job)?;
        let managed = guards
            .iter()
            .filter(|guard| guard.is_managed())
            .cloned()
            .collect::<Vec<_>>();
        ensure!(!managed.is_empty(), "continuation_source_changed");
        job.source_reference = Some(match archives.archive_reference_for_owner(&owner)? {
            Some(receipt) => receipt,
            None => archives.retain_archive_reference(owner, &managed)?,
        });
        self.save(&format!("{}.json", job.view.job_id), job)
    }
    pub(super) fn pin_native_reference(&self, job: &mut Job) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        ensure!(job.retired.is_none(), "continuation_retired");
        let archives = self.archives()?;
        let owner = self.native_owner(job)?;
        if let Some(receipt) = &job.native_reference {
            let expected = archives
                .archive_reference_for_owner(&owner)?
                .context("continuation_source_changed")?;
            ensure!(*receipt == expected, "continuation_source_changed");
            return Ok(());
        }
        let source = job
            .source_reference
            .as_ref()
            .context("continuation_source_recovery_required")?;
        let guards = source
            .archive_ids()
            .iter()
            .map(|id| {
                archives
                    .reader_with_reference(id, source)
                    .map(|reader| reader.lifecycle_guard())
            })
            .collect::<Result<Vec<_>>>()?;
        job.native_reference = Some(match archives.archive_reference_for_owner(&owner)? {
            Some(receipt) => receipt,
            None => archives.retain_archive_reference(owner, &guards)?,
        });
        self.save(&format!("{}.json", job.view.job_id), job)
    }
    pub(super) fn verify_references(&self, job: &Job) -> Result<()> {
        if job.version == 1 {
            return Ok(());
        }
        let source = job
            .source_reference
            .as_ref()
            .context("continuation_source_recovery_required")?;
        ensure!(
            source.matches_owner(
                ArchiveReferenceKind::Continuation,
                &job.view.job_id,
                &self.source_binding(job)?
            ),
            "continuation_source_changed"
        );
        if let Some(native) = &job.native_reference {
            ensure!(
                native.matches_owner(
                    ArchiveReferenceKind::NativeSession,
                    &format!("native-{}", job.view.job_id),
                    &self.native_binding(job)?
                ),
                "continuation_source_changed"
            );
        }
        if let Some(retired) = &job.retired {
            ensure!(
                retired.binding == self.retirement_binding(job)?,
                "continuation_retirement_changed"
            );
            return Ok(());
        }
        let archives = self.archives()?;
        archives.verify_archive_reference(source)?;
        if let Some(native) = &job.native_reference {
            archives.verify_archive_reference(native)?;
        }
        Ok(())
    }
    fn retirement_binding(&self, job: &Job) -> Result<String> {
        hash(&(
            "continuation-retirement/1",
            self.source_binding(job)?,
            &job.target,
            &job.binding,
            &job.receipt,
            &job.undo_seal,
            &job.source_reference,
            &job.native_reference,
        ))
    }
    /// Release a never-published operation, or one whose exact original native
    /// session has a verified retirement receipt. This never closes another runtime.
    pub fn retire(&self, key: &str, operation: &str, native_undo: Option<&str>) -> Result<()> {
        id(key)?;
        id(operation)?;
        if let Some(undo) = native_undo {
            id(undo)?;
        }
        let _runner = self.lock(&format!("{key}.run.lock"))?;
        let _catalog = self.lock("catalog.lock")?;
        let mut job = self.job(key)?;
        ensure!(job.version == 2, "continuation_retirement_legacy_retained");
        let archives = self.archives()?;
        let source = job
            .source_reference
            .clone()
            .context("continuation_source_recovery_required")?;
        if let Some(retired) = &job.retired {
            ensure!(
                retired.operation == operation && retired.undo.as_deref() == native_undo,
                "continuation_retirement_conflict"
            );
            if retired.source_claimed {
                return archives.release_archive_reference(&source);
            }
        } else {
            let _native_lease = if let Some(target) = &job.target {
                let binding = job
                    .binding
                    .as_ref()
                    .context("continuation_retirement_publication_unknown")?;
                let seal = job
                    .undo_seal
                    .as_ref()
                    .context("continuation_retirement_unsealed_retained")?;
                let undo = native_undo.context("continuation_retirement_native_undo_required")?;
                ensure!(
                    binding.session_id == target.session_id && binding.operation_id == key,
                    "continuation_publication_changed"
                );
                let lease =
                    kcoder_state::historical_undo::HistoricalUndoLease::try_acquire_existing(
                        &target
                            .history_directory
                            .join(format!("{}.jsonl", target.session_id)),
                        &target.artifact_directory,
                        &target.session_id,
                    )?;
                let receipt = kcoder_state::historical_undo::read_historical_session_undo(
                    &lease, seal, undo,
                )?
                .context("continuation_retirement_native_undo_required")?;
                ensure!(
                    receipt.source_operation_id == key
                        && receipt.session_id == target.session_id
                        && receipt.seal_sha256 == seal.seal_sha256,
                    "continuation_publication_changed"
                );
                Some(lease)
            } else {
                ensure!(
                    job.binding.is_none()
                        && job.receipt.is_none()
                        && job.undo_seal.is_none()
                        && job.native_reference.is_none()
                        && native_undo.is_none(),
                    "continuation_publication_changed"
                );
                None
            };
            job.retired = Some(Retired {
                operation: operation.into(),
                undo: native_undo.map(str::to_owned),
                binding: self.retirement_binding(&job)?,
                source_claimed: false,
            });
            self.save(&format!("{key}.json"), &job)?;
            // The actual native session lease remains held until the original native
            // source pin is released. Unknown publication never reaches this branch.
            if let Some(native) = &job.native_reference {
                archives.release_archive_reference(native)?;
            }
        }
        if let Some(native) = &job.native_reference {
            archives.release_archive_reference(native)?;
        }
        archives
            .archive_reference_release_guard(&source)?
            .commit(|| {
                job.retired
                    .as_mut()
                    .context("continuation_retirement_changed")?
                    .source_claimed = true;
                self.save(&format!("{key}.json"), &job)
            })
    }
}
