//! Durable branch recipes compile only previously selected, immutable target-owned archives.
use crate::history_jobs::HistoryJobStore;
use anyhow::{Context, Result, ensure};
use kcoder_state::external_history::{ExternalHistoryStore, projection::HistoricalProjectionStore};
use kcoder_types::{
    historical_branch::*, imported_transcript::HistoricalCodexItemRef,
    migration::MigrationSourceKind,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    time::{Duration, Instant},
};
mod choices;
mod reader;
mod tools;

pub const HISTORY_BRANCH_REVISION: &str = "vendor-branches/1";
/// Distinct identity for a readable reconstruction; never interchangeable with an exact window.
pub const HISTORY_RECONSTRUCTION_BRANCH_REVISION: &str = "codex-readable-reconstruction-branches/1";
/// A separate recipe identity is used when old tool declarations must be omitted.
pub const HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION: &str =
    "codex-readable-reconstruction-branches/2";
pub struct HistoryBranchStore {
    jobs: HistoryJobStore,
    archives: ExternalHistoryStore,
    profile: kcoder_config::PrivateDirectory,
}

impl HistoryBranchStore {
    pub fn open(profile: &Path) -> Result<Self> {
        Ok(Self {
            profile: kcoder_config::PrivateDirectory::open_existing(profile)?,
            jobs: HistoryJobStore::open_existing(profile)?
                .context("history_branch_jobs_missing")?,
            archives: ExternalHistoryStore::open_existing(profile)?
                .context("history_branch_archives_missing")?,
        })
    }
    fn source(
        &self,
        job_id: &str,
    ) -> Result<(MigrationSourceKind, HistoricalBranchSource, String)> {
        self.source_with_reference(job_id, None)
    }
    fn source_with_reference(
        &self,
        job_id: &str,
        reference: Option<&kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>,
    ) -> Result<(MigrationSourceKind, HistoricalBranchSource, String)> {
        let job = self.jobs.read(job_id)?;
        ensure!(
            job.archived
                && job
                    .normalization
                    .as_ref()
                    .is_some_and(|progress| progress.normalization_complete),
            "history_branch_normalization_incomplete"
        );
        let archive = if let Some(reference) = reference {
            self.jobs.archive_reader_with_reference(job_id, reference)?
        } else {
            self.jobs.archive_reader(job_id)?
        };
        let revision = self.jobs.normalization_revision(job_id)?;
        let index = archive
            .projection(&revision, false)?
            .context("history_branch_normalization_incomplete")?;
        ensure!(
            index.progress()?.normalization_complete,
            "history_branch_normalization_incomplete"
        );
        Ok((
            job.source,
            HistoricalBranchSource {
                archive_id: job.archive_id.context("history_branch_archive_missing")?,
                projection_fingerprint: index.source_fingerprint(),
            },
            revision,
        ))
    }
    pub(crate) fn reference_view(
        &self,
        job: &str,
        view: &str,
    ) -> Result<kcoder_state::external_history::branch_views::HistoricalBranchView> {
        self.validate(job, view)?;
        self.archives.branch(view, false)
    }
    pub fn prepare(
        &self,
        root_job: &str,
        related_jobs: &[String],
    ) -> Result<HistoricalBranchProgress> {
        self.prepare_with_revision(root_job, related_jobs, HISTORY_BRANCH_REVISION)
    }

    /// Prepare an independently bound candidate. It remains blocked for continuation
    /// until explicit reconstructed-context admission and its provenance are supported.
    pub fn prepare_readable_reconstruction(
        &self,
        root_job: &str,
    ) -> Result<HistoricalBranchProgress> {
        let (kind, root, revision) = self.source(root_job)?;
        ensure!(
            kind == MigrationSourceKind::Codex,
            "history_reconstruction_source_mismatch"
        );
        let legacy_recipe = HistoricalBranchRecipe {
            revision: HISTORY_RECONSTRUCTION_BRANCH_REVISION.into(),
            normalization_revision: revision,
            source: kind,
            sources: vec![root],
        };
        let legacy_id = self.archives.branch_id(&legacy_recipe)?;
        let legacy_needs_new_recipe = match self.archives.branch(&legacy_id, false) {
            Ok(view) => {
                let progress = view.progress()?;
                progress.stage == HistoricalBranchStage::Failed
                    && matches!(
                        progress.failure_code.as_deref(),
                        Some(
                            "history_reconstruction_checkpoint_unsupported"
                                | "history_reconstruction_checkpoint_not_found"
                                | "history_reconstruction_source_requires_review"
                        )
                    )
            }
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                false
            }
            Err(error) => return Err(error),
        };
        let reconstruction_revision = if legacy_needs_new_recipe {
            HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
        } else {
            HISTORY_RECONSTRUCTION_BRANCH_REVISION
        };
        self.prepare_with_revision(root_job, &[], reconstruction_revision)
    }

    fn prepare_with_revision(
        &self,
        root_job: &str,
        related_jobs: &[String],
        branch_revision: &str,
    ) -> Result<HistoricalBranchProgress> {
        let source_jobs = std::iter::once(root_job)
            .chain(related_jobs.iter().map(String::as_str))
            .collect::<Vec<_>>();
        let _fences: crate::history_jobs::HistoryReferenceFences =
            self.jobs.reference_fences(&source_jobs)?;
        ensure!(
            related_jobs.len() < 256
                && related_jobs.iter().all(|id| id != root_job)
                && related_jobs.iter().collect::<BTreeSet<_>>().len() == related_jobs.len(),
            "history_branch_invalid_sources"
        );
        let (kind, root, revision) = self.source(root_job)?;
        ensure!(
            !matches!(
                branch_revision,
                HISTORY_RECONSTRUCTION_BRANCH_REVISION
                    | HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
            ) || (kind == MigrationSourceKind::Codex && related_jobs.is_empty()),
            "history_reconstruction_source_mismatch"
        );
        let root_reader = self.archives.reader(&root.archive_id)?;
        let scope = root_reader.origin().source_instance.clone();
        let root_receipt = root_reader
            .receipt()?
            .context("history_branch_archive_missing")?;
        let mut bytes = root_receipt.source_bytes
            + root_receipt
                .original
                .as_ref()
                .map_or(0, |source| source.source.bytes);
        drop(root_reader);
        let mut related = BTreeMap::new();
        for id in related_jobs {
            let (source, selected, related_revision) = self.source(id)?;
            ensure!(
                related_revision == revision,
                "history_branch_normalization_revision_mismatch"
            );
            ensure!(source == kind, "history_branch_source_mismatch");
            if selected.archive_id != root.archive_id {
                let reader = self.archives.reader(&selected.archive_id)?;
                ensure!(
                    reader.origin().source_instance == scope,
                    "history_branch_source_scope_mismatch"
                );
                if !related.contains_key(&selected.archive_id) {
                    let receipt = reader
                        .receipt()?
                        .context("history_branch_archive_missing")?;
                    bytes = bytes
                        .checked_add(receipt.source_bytes)
                        .and_then(|bytes| {
                            bytes.checked_add(
                                receipt
                                    .original
                                    .as_ref()
                                    .map_or(0, |source| source.source.bytes),
                            )
                        })
                        .context("history_branch_byte_budget_exceeded")?;
                    ensure!(
                        bytes <= 20 * 1024 * 1024 * 1024,
                        "history_branch_byte_budget_exceeded"
                    );
                }
                related.insert(selected.archive_id.clone(), selected);
            }
        }
        ensure!(
            kind == MigrationSourceKind::Codex || related.is_empty(),
            "history_branch_related_sources_unsupported"
        );
        let recipe = HistoricalBranchRecipe {
            revision: branch_revision.into(),
            normalization_revision: revision,
            source: kind,
            sources: std::iter::once(root).chain(related.into_values()).collect(),
        };
        let id = self.archives.branch_id(&recipe)?;
        let progress = match self.archives.prepare_branch(&recipe) {
            Ok(view) => view.progress(),
            Err(error) if error.to_string() == "history_branch_busy" => {
                self.archives.branch(&id, false)?.progress()
            }
            Err(error) => Err(error),
        }?;
        self.remember(
            root_job,
            &recipe.sources[0].archive_id,
            &HistoricalBranchChoice {
                view_id: progress.view_id.clone(),
                related_job_ids: related_jobs.to_vec(),
            },
        )?;
        Ok(progress)
    }
    fn validate(&self, root_job: &str, view_id: &str) -> Result<HistoricalBranchRecipe> {
        let reference = self.archives.branch_source_reference(view_id)?;
        let (_, root, revision) = self.source_with_reference(root_job, reference.as_ref())?;
        let recipe = self.archives.branch_recipe(view_id)?;
        ensure!(
            matches!(
                recipe.revision.as_str(),
                HISTORY_BRANCH_REVISION
                    | HISTORY_RECONSTRUCTION_BRANCH_REVISION
                    | HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
            ) && recipe.normalization_revision == revision
                && (!matches!(
                    recipe.revision.as_str(),
                    HISTORY_RECONSTRUCTION_BRANCH_REVISION
                        | HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
                ) || (recipe.source == MigrationSourceKind::Codex
                    && recipe.sources.len() == 1)),
            "history_branch_adapter_changed"
        );
        ensure!(
            recipe.sources.first() == Some(&root),
            "history_branch_root_mismatch"
        );
        Ok(recipe)
    }
    pub fn retire_view(
        &self,
        root_job: &str,
        view_id: &str,
        operation: &str,
        expected_sequence: u64,
    ) -> Result<()> {
        let _fences = self.jobs.reference_cleanup_fence(root_job)?;
        let job = self.jobs.read(root_job)?;
        let recipe = self.archives.branch_recipe(view_id)?;
        ensure!(
            job.source == recipe.source
                && job.archive_id.as_deref()
                    == recipe
                        .sources
                        .first()
                        .map(|source| source.archive_id.as_str())
                && self.jobs.normalization_revision(root_job)? == recipe.normalization_revision,
            "history_branch_root_mismatch"
        );
        self.archives
            .retire_branch(view_id, operation, expected_sequence)
    }
    pub fn progress(&self, root_job: &str, view_id: &str) -> Result<HistoricalBranchProgress> {
        self.validate(root_job, view_id)?;
        self.archives.branch(view_id, false)?.progress()
    }
    pub fn running(&self, root_job: &str, view_id: &str) -> Result<bool> {
        self.validate(root_job, view_id)?;
        self.archives.branch_running(view_id)
    }
    pub fn cancel(&self, root_job: &str, view_id: &str) -> Result<()> {
        self.validate(root_job, view_id)?;
        self.archives.cancel_branch(view_id)
    }
    pub fn resume(
        &self,
        root_job: &str,
        view_id: &str,
        sequence: u64,
    ) -> Result<HistoricalBranchProgress> {
        self.validate(root_job, view_id)?;
        self.archives.branch(view_id, true)?.resume(sequence)
    }
    fn projection(
        &self,
        source: &HistoricalBranchSource,
        revision: &str,
    ) -> Result<HistoricalProjectionStore> {
        let reader = self.archives.reader(&source.archive_id)?;
        let index = reader
            .projection(revision, false)?
            .context("history_branch_normalization_incomplete")?;
        ensure!(
            index.source_fingerprint() == source.projection_fingerprint
                && index.progress()?.normalization_complete,
            "history_branch_source_changed"
        );
        Ok(index)
    }
    /// Recomputing a cancelled pure recipe is safe; published reference batches remain authoritative.
    pub fn build(
        &self,
        root_job: &str,
        view_id: &str,
        mut check: impl FnMut() -> bool,
    ) -> Result<HistoricalBranchProgress> {
        let recipe = self.validate(root_job, view_id)?;
        let control = self.archives.branch_control(view_id)?;
        let mut view = self.archives.branch(view_id, true)?;
        let begun = view.begin()?;
        if matches!(
            begun.stage,
            HistoricalBranchStage::Ready | HistoricalBranchStage::Cancelled
        ) {
            return Ok(begun);
        }
        let mut cancelled = false;
        let mut control_error = false;
        let mut checks = 0u64;
        let mut previous = Instant::now();
        let mut poll = |_: u64| {
            checks = checks.saturating_add(1);
            if !check() {
                cancelled = true;
                return false;
            }
            match control.cancelled() {
                Ok(true) => {
                    cancelled = true;
                    return false;
                }
                Err(_) => {
                    control_error = true;
                    return false;
                }
                Ok(false) => {}
            }
            if checks.is_multiple_of(256) || previous.elapsed() >= Duration::from_millis(100) {
                if view.checked(checks).is_err() {
                    control_error = true;
                    return false;
                }
                previous = Instant::now();
            }
            true
        };
        let compiled = (|| -> Result<(HistoricalBranchPlan, Vec<HistoricalCodexItemRef>)> {
            let index = self.projection(&recipe.sources[0], &recipe.normalization_revision)?;
            if matches!(
                recipe.revision.as_str(),
                HISTORY_RECONSTRUCTION_BRANCH_REVISION
                    | HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION
            ) {
                let selected = if recipe.revision == HISTORY_RECONSTRUCTION_TOOLS_BRANCH_REVISION {
                    let archive = self.archives.reader(&recipe.sources[0].archive_id)?;
                    crate::history_codex::reconstruct_readable_history_with_tool_declarations(
                        &index, &archive, &mut poll,
                    )?
                } else {
                    crate::history_codex::reconstruct_readable_history(&index, &mut poll)?
                };
                let mut items = selected
                    .items()
                    .iter()
                    .chain(selected.tool_records())
                    .cloned()
                    .collect::<Vec<_>>();
                items.sort_unstable_by_key(|item| item.record);
                ensure!(
                    items
                        .windows(2)
                        .all(|pair| pair[0].record != pair[1].record),
                    "history_reconstruction_duplicate_record"
                );
                return Ok((
                    HistoricalBranchPlan {
                        selection_sha256: selected.selection_sha256().into(),
                        total_items: items.len() as u64,
                        // The readable candidate does not reproduce the opaque provider checkpoint.
                        structural_complete: false,
                        source_records_with_diagnostics: index.progress()?.records_with_diagnostics,
                        issues: vec!["codex_readable_reconstruction_requires_admission".into()],
                    },
                    items,
                ));
            }
            if recipe.source == MigrationSourceKind::ClaudeCode {
                let selected = crate::history_selection::select_claude_history(&index, &mut poll)?;
                let mut issues = Vec::new();
                if !selected.complete_path() {
                    issues.push("claude_parent_chain_incomplete".into());
                }
                if selected.selected_records_with_diagnostics() > 0 {
                    issues.push("selected_records_require_review".into());
                }
                if selected.incomplete_source_nodes() > 0 {
                    issues.push("source_branches_require_review".into());
                }
                return Ok((
                    HistoricalBranchPlan {
                        selection_sha256: selected.selection_sha256().into(),
                        total_items: selected.records().len() as u64,
                        structural_complete: selected.complete_path(),
                        source_records_with_diagnostics: selected.source_records_with_diagnostics(),
                        issues,
                    },
                    selected
                        .records()
                        .iter()
                        .map(|record| HistoricalCodexItemRef {
                            source_index: 0,
                            record: *record,
                            replacement_index: None,
                            omitted_blocks: vec![],
                        })
                        .collect(),
                ));
            }
            let selected = if recipe.sources.len() == 1 {
                crate::history_codex::select_codex_history(&index, &mut poll)?
            } else {
                drop(index);
                let related = recipe
                    .sources
                    .iter()
                    .skip(1)
                    .map(|source| source.archive_id.clone())
                    .collect::<Vec<_>>();
                let lineage = crate::history_codex::resolve_codex_history_lineage_with_revision(
                    &self.archives,
                    &recipe.sources[0].archive_id,
                    &related,
                    &recipe.normalization_revision,
                    &mut poll,
                )?;
                crate::history_codex::select_codex_history_from_lineage(
                    &self.archives,
                    lineage,
                    &mut poll,
                )?
            };
            let mut items = selected.items().to_vec();
            if let Some(ids) = selected.source_archive_ids() {
                let mapping = ids
                    .iter()
                    .map(|id| {
                        recipe
                            .sources
                            .iter()
                            .position(|source| source.archive_id == *id)
                            .map(|index| index as u32)
                            .context("history_branch_source_changed")
                    })
                    .collect::<Result<Vec<_>>>()?;
                for item in &mut items {
                    item.source_index = *mapping
                        .get(item.source_index as usize)
                        .context("history_branch_source_changed")?;
                }
            }
            Ok((
                HistoricalBranchPlan {
                    selection_sha256: selected.selection_sha256().into(),
                    total_items: items.len() as u64,
                    structural_complete: selected.complete_window(),
                    source_records_with_diagnostics: selected.source_records_with_diagnostics(),
                    issues: selected.issues().iter().cloned().collect(),
                },
                items,
            ))
        })();
        let result = (|| -> Result<HistoricalBranchProgress> {
            let (plan, items) = compiled?;
            view.set_plan(&plan)?;
            for (batch, rows) in items.chunks(1000).enumerate() {
                view.append((batch * 1000) as u64, rows, |_| {
                    if !check() {
                        cancelled = true;
                        return false;
                    }
                    match control.cancelled() {
                        Ok(false) => true,
                        Ok(true) => {
                            cancelled = true;
                            false
                        }
                        Err(_) => {
                            control_error = true;
                            false
                        }
                    }
                })?;
            }
            if !check() || control.cancelled()? {
                cancelled = true;
                anyhow::bail!("history_branch_cancelled");
            }
            view.finish()
        })();
        let error_code = result.as_ref().err().map(ToString::to_string);
        match result {
            Ok(progress) => Ok(progress),
            Err(_) => view.stop(
                cancelled && !control_error,
                Some(if control_error {
                    "history_branch_control_failed"
                } else {
                    error_code
                        .as_deref()
                        .unwrap_or("history_branch_build_failed")
                }),
            ),
        }
    }
}
