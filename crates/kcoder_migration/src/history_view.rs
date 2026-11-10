//! Idle UI views retain the same native reader claims as actual record requests.
//! This module stores no authority, source paths, or durable replacement catalogue.
use crate::{history_branches::HistoryBranchStore, history_jobs::HistoryJobStore};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::external_history::{
    ExternalHistoryReader, branch_views::HistoricalBranchView, lifecycle::ArchiveReadGuard,
};
use std::path::Path;
mod leases;
pub use leases::{
    HISTORY_VIEW_TTL_MS, HistoryViewLeaseObservation, HistoryViewLeaseState, HistoryViewLeases,
};
#[cfg(test)]
mod tests;

/// Public metadata intentionally excludes native scope, generation and content fingerprints.
#[derive(Clone, PartialEq, Eq)]
pub struct HistoryViewBinding {
    pub job_id: String,
    pub archive_id: String,
    pub normalization_revision: String,
    pub view_id: Option<String>,
    pub managed_archives: usize,
    pub legacy_archives: usize,
}

enum Reader {
    Archive { _reader: ExternalHistoryReader },
    Branch { _reader: HistoricalBranchView },
}

/// A process-owned hold. Neither a wire payload nor a lease ID can manufacture it.
/// The host must bound its lifetime and release only the connection's own value.
pub struct HistoryViewHold {
    profile_identity: String,
    binding: HistoryViewBinding,
    content_identity: String,
    guards: Vec<ArchiveReadGuard>,
    _reader: Reader,
}

impl HistoryViewHold {
    /// Open only the authenticated host profile and an already imported job/view.
    /// This performs bounded metadata reads, never a source/body hash or migration step.
    pub fn open(profile: &Path, job_id: &str, view_id: Option<&str>) -> Result<Self> {
        let directory = PrivateDirectory::open_existing(profile)?;
        directory.verify_trusted_config_directory()?;
        let profile_identity = directory.directory_identity()?;
        let jobs = HistoryJobStore::open_existing(profile)?.context("history_view_jobs_missing")?;
        let job = jobs.read(job_id)?;
        ensure!(job.archived, "history_view_archive_not_ready");
        let archive_id = job.archive_id.context("history_view_archive_not_ready")?;
        let revision = jobs.normalization_revision(job_id)?;
        let (reader, guards, content_identity) = if let Some(view_id) = view_id {
            let view = HistoryBranchStore::open(profile)?.reference_view(job_id, view_id)?;
            let identity = view.content_identity()?;
            let guards = view.source_guards();
            (Reader::Branch { _reader: view }, guards, identity)
        } else {
            let archive = jobs.archive_reader(job_id)?;
            let receipt = archive
                .receipt()?
                .context("history_view_archive_not_ready")?;
            // Keep the verified immutable receipt private; no raw source or body is read.
            let identity = serde_json::to_string(&receipt)?;
            let guard = archive.lifecycle_guard();
            (Reader::Archive { _reader: archive }, vec![guard], identity)
        };
        ensure!(
            !guards.is_empty() && guards.len() <= 256,
            "history_view_source_budget_exceeded"
        );
        let managed = guards.iter().filter(|guard| guard.is_managed()).count();
        Ok(Self {
            profile_identity,
            binding: HistoryViewBinding {
                job_id: job_id.into(),
                archive_id,
                normalization_revision: revision,
                view_id: view_id.map(str::to_owned),
                managed_archives: managed,
                legacy_archives: guards.len() - managed,
            },
            content_identity,
            guards,
            _reader: reader,
        })
    }

    pub fn binding(&self) -> &HistoryViewBinding {
        &self.binding
    }

    /// Renewal can only confirm the same still-held epoch. It never replaces this
    /// hold with a newly selected archive, branch, profile or normalization revision.
    pub fn validate(&self, profile: &Path) -> Result<()> {
        let current = Self::open(
            profile,
            &self.binding.job_id,
            self.binding.view_id.as_deref(),
        )?;
        ensure!(
            current.profile_identity == self.profile_identity
                && current.binding == self.binding
                && current.content_identity == self.content_identity
                && current.guards.len() == self.guards.len()
                && current
                    .guards
                    .iter()
                    .zip(&self.guards)
                    .all(|(new, original)| {
                        if original.is_managed() {
                            original.same_generation(new)
                        } else {
                            !new.is_managed()
                        }
                    }),
            "history_view_binding_changed"
        );
        Ok(())
    }
}
