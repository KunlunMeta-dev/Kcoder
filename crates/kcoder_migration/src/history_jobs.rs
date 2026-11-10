//! Durable coordination of explicitly selected archives. No active session or model is created.
use crate::{
    history_discovery::HistoryPendingSelection,
    history_normalization::{HISTORY_NORMALIZATION_REVISION, HistoryNormalizer},
    history_sources::HistorySourceBinding,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{
    external_history::{ExternalHistoryProgress, HistoryImportJobView, HistoryImportStage},
    imported_transcript::HistoryNormalizationProgress,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, fs::File, io::Read, path::Path};

/// Default bound for independent history IO workers; per-job guards and budgets still apply.
pub const HISTORY_IMPORT_CONCURRENCY: usize = 64;

const MAX_JOB_BYTES: u64 = 128 * 1024;
const MAX_JOBS: usize = 4096;
const MAX_JOB_ENTRIES: usize = 7 * MAX_JOBS + 8;
mod execution;
pub use execution::{HistoryExecutionGuard, HistoryExecutionState};
mod managed;
mod retirement;
pub(crate) use managed::HistoryReferenceFences;
pub use retirement::HistoryRetirementPreview;
mod recovery;
mod reinterpret;
mod resources;
pub use resources::{
    ResourceAttachmentIntent, ResourceAttachmentObservation, ResourceAttachmentPhase,
};
mod selected;

/// The persisted checkpoint is available, but reading its projection requires writer recovery.
pub const HISTORY_PROJECTION_RECOVERY_REQUIRED: &str = "history_projection_recovery_required";
/// Older /3 jobs do not record whether their parser included the shipped capture fix.
pub const HISTORY_REINTERPRETATION_REQUIRED: &str = "history_reinterpretation_required";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Job {
    version: u32,
    owner: String,
    binding: Option<HistorySourceBinding>,
    binding_sha256: String,
    #[serde(default)]
    selection: Option<HistoryPendingSelection>,
    #[serde(default)]
    selection_sha256: Option<String>,
    normalization_revision: String,
    #[serde(default)]
    archive_stage_completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reinterpreted_from: Option<reinterpret::ReinterpretedSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_identity: Option<kcoder_config::PortableLeaseIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_birth_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_budget: Option<resources::HistoryResourceBinding>,
    view: HistoryImportJobView,
}

pub enum HistoryImportEvent {
    Capture {
        processed_bytes: u64,
        total_bytes: u64,
    },
    Archive(ExternalHistoryProgress),
    Normalize(HistoryNormalizationProgress),
}

pub struct HistoryJobStore {
    profile: std::path::PathBuf,
    migration_identity: String,
    directory: PrivateDirectory,
    archives: ExternalHistoryStore,
    owner: String,
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn valid_id(id: &str) -> Result<()> {
    ensure!(
        id.len() == 36
            && uuid::Uuid::parse_str(id).is_ok_and(|id_value| id_value.to_string() == id),
        "history_job_invalid_id"
    );
    Ok(())
}

impl HistoryJobStore {
    /// Resolve only a job owned by this target; no public caller supplies archive paths.
    pub fn archive_reader(
        &self,
        job_id: &str,
    ) -> Result<kcoder_state::external_history::ExternalHistoryReader> {
        let view = self.read(job_id)?;
        self.ensure_live(&self.load(job_id)?)?;
        ensure!(view.archived, "history_display_archive_not_ready");
        let archive = view
            .archive_id
            .as_deref()
            .context("history_job_binding_missing")?;
        let job = self.load(job_id)?;
        let reader = if job.managed() {
            self.archives.reader_for_operation(archive, job_id)?
        } else {
            self.archives.reader(archive)?
        };
        self.bind_reader_budget(&job, reader)
    }
    /// Only the authenticated target profile belongs here, never a renderer-supplied source root.
    pub fn open(profile: &Path) -> Result<Self> {
        Self::open_inner(profile, true)?.context("history_job_store_missing")
    }

    pub fn open_existing(profile: &Path) -> Result<Option<Self>> {
        Self::open_inner(profile, false)
    }

    fn open_inner(profile: &Path, create: bool) -> Result<Option<Self>> {
        let parent = match PrivateDirectory::open_existing(profile) {
            Ok(parent) => parent,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        parent.verify_trusted_config_directory()?;
        let migrations = match parent.open_child(OsStr::new("migrations"), create) {
            Ok(directory) => directory,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        migrations.verify_private_directory()?;
        let directory = match migrations.open_child(OsStr::new("history"), create) {
            Ok(directory) => directory,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let archives = if create {
            ExternalHistoryStore::open(profile)?
        } else {
            ExternalHistoryStore::open_existing(profile)?
                .context("history_job_archive_store_missing")?
        };
        let owner = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                directory.directory_identity()?,
                archives.scope_fingerprint()?,
            ))?)
        );
        Ok(Some(Self {
            profile: profile.canonicalize()?,
            migration_identity: migrations.directory_identity()?,
            directory,
            archives,
            owner,
        }))
    }

    fn lock(&self, name: &str) -> Result<File> {
        self.directory.verify_private_directory()?;
        let name = OsStr::new(name);
        let file = match self.directory.open_read_write_file(name, true) {
            Ok(file) => file,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|cause| cause.kind() == std::io::ErrorKind::AlreadyExists)
                }) =>
            {
                self.directory.open_read_write_file(name, false)?
            }
            Err(error) => return Err(error),
        };
        let identity = self.directory.portable_regular_handle_identity(&file)?;
        for attempt in 0..64 {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => {
                    ensure!(
                        self.directory.portable_regular_identity(name)? == identity,
                        "history_job_lock_changed"
                    );
                    return Ok(file);
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error().is_some_and(|code| {
                            Some(code) == fs2::lock_contended_error().raw_os_error()
                        }) => {}
                Err(error) => return Err(error.into()),
            }
            // Only acquisition waits. No control or mutation is replayed, and the
            // original open handle cannot be replaced by a newly created lock.
            if attempt < 63 {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        anyhow::bail!("history_job_busy")
    }

    /// Stable request identity makes a lost creation response observable without making a new job.
    pub fn create(
        &self,
        request_id: &str,
        binding: &HistorySourceBinding,
    ) -> Result<HistoryImportJobView> {
        self.create_with_resource_limits(request_id, binding, None)
    }

    pub fn create_with_resource_limits(
        &self,
        request_id: &str,
        binding: &HistorySourceBinding,
        resource_limits: Option<kcoder_types::migration_resource::MigrationResourceLimits>,
    ) -> Result<HistoryImportJobView> {
        valid_id(request_id)?;
        let _lock = self.lock("catalog.lock")?;
        let binding_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(binding)?));
        if let Some(job) = self.load_optional(request_id)? {
            ensure!(
                job.binding_sha256 == binding_sha256,
                "history_job_request_conflict"
            );
            if let Some(limits) = resource_limits {
                ensure!(
                    job.resource_budget
                        .as_ref()
                        .is_some_and(|budget| budget.initial_limits == limits),
                    "history_resource_initial_limits_changed"
                );
            }
            return self.observe(job);
        }
        let mut count = 0;
        self.directory
            .visit_entry_names_bounded(MAX_JOB_ENTRIES, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".cancel.json"))
                {
                    count += 1;
                }
                Ok(())
            })?;
        ensure!(count < MAX_JOBS, "history_job_count_budget_exceeded");
        let _run = self.lock(&format!("{request_id}.run.lock"))?;
        let resource_budget = self.birth_standalone_resource_budget(
            request_id,
            &binding_sha256,
            resource_limits,
            resources::HistoryBudgetStorage::Managed,
        )?;
        let view = HistoryImportJobView {
            job_id: request_id.into(),
            sequence: 0,
            source: binding.snapshot().origin.source,
            stage: HistoryImportStage::Planned,
            archive_id: Some(
                self.archives
                    .reserve_managed_archive(request_id, binding.snapshot())?,
            ),
            archived: false,
            normalization: None,
            failure_code: None,
            cancel_requested: false,
        };
        let mut job = Job {
            version: 4,
            owner: self.owner.clone(),
            binding: Some(binding.clone()),
            binding_sha256,
            selection: None,
            selection_sha256: None,
            normalization_revision: HISTORY_NORMALIZATION_REVISION.into(),
            archive_stage_completed: false,
            reinterpreted_from: None,
            execution_identity: None,
            execution_birth_sha256: None,
            resource_budget: Some(resource_budget),
            view: view.clone(),
        };
        let _execution = self.birth_execution(&mut job, &_run)?;
        self.save(&job)?;
        Ok(view)
    }

    /// Atomic reads remain available while the separate runner lease is held.
    pub fn read(&self, job_id: &str) -> Result<HistoryImportJobView> {
        self.observe(self.load(job_id)?)
    }

    pub fn records(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<HistoryImportJobView>, Option<String>)> {
        if let Some(id) = after {
            valid_id(id)?;
        }
        let mut ids = Vec::new();
        self.directory
            .visit_entry_names_bounded(MAX_JOB_ENTRIES, |name| {
                if let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json"))
                    && valid_id(id).is_ok()
                {
                    ids.push(id.to_owned());
                    ensure!(ids.len() <= MAX_JOBS, "history_job_count_budget_exceeded");
                }
                Ok(())
            })?;
        ids.sort();
        let selected = ids
            .iter()
            .filter(|id| after.is_none_or(|after| id.as_str() > after))
            .take(11)
            .collect::<Vec<_>>();
        let next = (selected.len() > 10).then(|| selected[9].to_string());
        let rows = selected
            .into_iter()
            .take(10)
            .map(|id| self.observe_execution(id).map(|(job, _)| job))
            .collect::<Result<Vec<_>>>()?;
        Ok((rows, next))
    }

    pub fn request_cancel(&self, job_id: &str) -> Result<HistoryImportJobView> {
        let _control = self.lock("control.lock")?;
        let job = self.load(job_id)?;
        if job.view.stage != HistoryImportStage::Normalized {
            self.directory
                .atomic_replace(OsStr::new(&format!("{job_id}.cancel.json")), b"true")?;
        }
        self.observe_execution(job_id).map(|(job, _)| job)
    }

    /// Resume is explicit and requires the previous runner to have released its lease.
    pub fn resume(&self, job_id: &str, expected_sequence: u64) -> Result<HistoryImportJobView> {
        let before = self.load(job_id)?;
        let metadata_only = Self::owner_check_only(&before);
        let (execution, sequence) = self.claim_resume_execution(job_id, expected_sequence)?;
        if metadata_only {
            self.validate_execution(&execution)?;
            let current = self.load(job_id)?;
            ensure!(
                current.view == before.view
                    && current.normalization_revision == before.normalization_revision,
                "history_job_revision_conflict"
            );
            // This explicit metadata-only reconciliation must not invoke an old parser.
            return Ok(current.view);
        }
        self.resume_owned(&execution, sequence)
    }

    pub fn resume_owned(
        &self,
        execution: &HistoryExecutionGuard,
        expected_sequence: u64,
    ) -> Result<HistoryImportJobView> {
        self.validate_execution(execution)?;
        let job_id = execution.job_id();
        valid_id(job_id)?;
        let _run = self.execution_run_lock(execution)?;
        let _control = self.lock("control.lock")?;
        let mut job = self.load(job_id)?;
        self.ensure_live(&job)?;
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        ensure!(
            crate::history_normalization::executable_revision(&job.normalization_revision),
            "history_job_adapter_changed"
        );
        ensure!(
            matches!(
                job.view.stage,
                HistoryImportStage::Cancelled | HistoryImportStage::Failed
            ),
            "history_job_not_resumable"
        );
        self.upgrade_job_resource_budget(&mut job)?;
        self.require_resource_budget_for_write(&job)?;
        self.refresh_for_run(&mut job)?;
        ensure!(
            !requires_reinterpretation(&job),
            HISTORY_REINTERPRETATION_REQUIRED
        );
        self.directory
            .atomic_replace(OsStr::new(&format!("{job_id}.cancel.json")), b"false")?;
        job.view.stage = if job.archive_stage_completed {
            HistoryImportStage::Normalizing
        } else if job.binding.is_some() {
            HistoryImportStage::Planned
        } else {
            HistoryImportStage::Capturing
        };
        job.view.failure_code = None;
        self.advance(&mut job)?;
        self.observe(job)
    }

    /// Archiving is one recoverable stage; normalization commits at most ten records per step.
    /// Callers own the worker task, transport and callback. Dropping a caller never replays tools.
    pub fn step(
        &self,
        job_id: &str,
        expected_sequence: u64,
        limit: u32,
        check: impl FnMut(HistoryImportEvent) -> bool,
    ) -> Result<HistoryImportJobView> {
        let execution = self.claim_execution(job_id, expected_sequence)?;
        self.step_owned(&execution, expected_sequence, limit, check)
    }

    pub fn step_owned(
        &self,
        execution: &HistoryExecutionGuard,
        expected_sequence: u64,
        limit: u32,
        mut check: impl FnMut(HistoryImportEvent) -> bool,
    ) -> Result<HistoryImportJobView> {
        self.validate_execution(execution)?;
        let job_id = execution.job_id();
        valid_id(job_id)?;
        ensure!(
            (1..=10).contains(&limit),
            "history_normalization_invalid_limit"
        );
        let _run = self.execution_run_lock(execution)?;
        let mut job = self.load(job_id)?;
        self.ensure_live(&job)?;
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        ensure!(
            crate::history_normalization::executable_revision(&job.normalization_revision),
            "history_job_adapter_changed"
        );
        if matches!(
            job.view.stage,
            HistoryImportStage::Cancelled | HistoryImportStage::Failed
        ) {
            return self.observe(job);
        }
        if job.view.stage != HistoryImportStage::Normalized
            && !self.cancel_requested(job_id)?
            && let Err(error) = self.require_resource_budget_for_write(&job)
        {
            if matches!(
                error.to_string().as_str(),
                "history_resource_budget_exceeded"
                    | "history_resource_file_budget_exceeded"
                    | "history_resource_disk_space_insufficient"
                    | "history_resource_disk_nodes_insufficient"
                    | "history_resource_disk_space_unavailable"
            ) {
                return self.persist_failure(job, &error);
            }
            return Err(error);
        }
        if let Err(error) = self.refresh_for_run(&mut job) {
            if job.view.stage == HistoryImportStage::Normalized {
                return Err(error);
            }
            return self.persist_failure(job, &error);
        }
        if job.view.stage == HistoryImportStage::Normalized {
            return self.observe(job);
        }
        if job.view.stage == HistoryImportStage::Normalizing
            && job
                .view
                .normalization
                .as_ref()
                .is_some_and(|progress| progress.normalization_complete)
        {
            let mut cancelled = false;
            let mut control_error = false;
            if let Err(error) =
                self.seal_normalization(&job, &mut cancelled, &mut control_error, &mut check)
            {
                job.view.stage = if cancelled && !control_error {
                    HistoryImportStage::Cancelled
                } else {
                    HistoryImportStage::Failed
                };
                job.view.failure_code = Some(failure_code(&error));
                return self.persist_observed(job);
            }
            job.view.stage = HistoryImportStage::Normalized;
            return self.persist_observed(job);
        }
        if self.cancel_requested(job_id)? {
            job.view.stage = HistoryImportStage::Cancelled;
            return self.persist_observed(job);
        }
        if job.binding.is_none() {
            return self.step_capture(job, check);
        }
        if !matches!(
            job.view.stage,
            HistoryImportStage::Planned | HistoryImportStage::Archiving
        ) {
            ensure!(
                !requires_reinterpretation(&job),
                HISTORY_REINTERPRETATION_REQUIRED
            );
        }
        let mut cancelled = false;
        let mut control_error = false;
        let mut result = if matches!(
            job.view.stage,
            HistoryImportStage::Planned | HistoryImportStage::Archiving
        ) {
            job.view.stage = HistoryImportStage::Archiving;
            self.advance(&mut job)?;
            let binding = job
                .binding
                .as_ref()
                .context("history_job_binding_missing")?;
            let mut archive_check = |progress| {
                self.allow_step(job_id, &mut cancelled, &mut control_error, || {
                    check(HistoryImportEvent::Archive(progress))
                })
            };
            let archived = if job.managed() {
                binding.archive_managed(&self.archives, job_id, &mut archive_check)
            } else {
                binding.archive(&self.archives, job_id, &mut archive_check)
            };
            archived.and_then(|commit| {
                ensure!(
                    job.view.archive_id.as_deref() == Some(&commit.receipt.archive_id),
                    "history_job_managed_binding_changed"
                );
                Ok(())
            })
        } else {
            job.view.stage = HistoryImportStage::Normalizing;
            self.advance(&mut job)?;
            self.reader_for_job(&job)
                .and_then(|archive| {
                    HistoryNormalizer::open_with_revision(archive, &job.normalization_revision)
                })
                .and_then(|mut normalizer| {
                    normalizer.step(limit, |progress| {
                        self.allow_step(job_id, &mut cancelled, &mut control_error, || {
                            check(HistoryImportEvent::Normalize(progress))
                        })
                    })
                })
                .map(|_| ())
        };
        if let Err(error) = self.refresh(&mut job) {
            return self.persist_failure(job, &error);
        }
        if result.is_ok()
            && job
                .view
                .normalization
                .as_ref()
                .is_some_and(|progress| progress.normalization_complete)
        {
            result = self.seal_normalization(&job, &mut cancelled, &mut control_error, &mut check);
        }
        match result {
            Ok(()) => {
                job.archive_stage_completed = true;
                job.view.stage = if job
                    .view
                    .normalization
                    .as_ref()
                    .is_some_and(|progress| progress.normalization_complete)
                {
                    HistoryImportStage::Normalized
                } else {
                    HistoryImportStage::Normalizing
                };
                job.view.failure_code = None;
            }
            Err(error) => {
                job.view.stage = if cancelled && !control_error {
                    HistoryImportStage::Cancelled
                } else {
                    HistoryImportStage::Failed
                };
                job.view.failure_code = if control_error {
                    Some("history_job_invalid_control".into())
                } else {
                    (!cancelled).then(|| failure_code(&error))
                };
            }
        }
        self.persist_observed(job)
    }

    fn allow_step(
        &self,
        id: &str,
        cancelled: &mut bool,
        control_error: &mut bool,
        check: impl FnOnce() -> bool,
    ) -> bool {
        match self.cancel_requested(id) {
            Ok(false) if check() => true,
            Ok(_) => {
                *cancelled = true;
                false
            }
            Err(_) => {
                *control_error = true;
                false
            }
        }
    }

    fn persist_observed(&self, mut job: Job) -> Result<HistoryImportJobView> {
        self.advance(&mut job)?;
        self.observe(job)
    }

    fn persist_failure(&self, mut job: Job, error: &anyhow::Error) -> Result<HistoryImportJobView> {
        job.view.stage = HistoryImportStage::Failed;
        job.view.failure_code = Some(failure_code(error));
        self.persist_observed(job)
    }

    fn advance(&self, job: &mut Job) -> Result<()> {
        job.view.sequence = job
            .view
            .sequence
            .checked_add(1)
            .context("history_job_sequence_exhausted")?;
        self.save(job)
    }

    fn refresh(&self, job: &mut Job) -> Result<()> {
        let Some(binding) = &job.binding else {
            ensure!(
                !job.view.archived && job.view.archive_id.is_none(),
                "history_job_binding_changed"
            );
            return Ok(());
        };
        let reader = match self.archives.reader(
            job.view
                .archive_id
                .as_deref()
                .context("history_job_binding_missing")?,
        ) {
            Ok(reader) => reader,
            Err(error) if missing(&error) && !job.view.archived => return Ok(()),
            Err(error) => return Err(error),
        };
        if let Some(receipt) = reader.receipt()? {
            Self::validate_reinterpretation_receipt(job, &receipt)?;
            ensure!(
                receipt.source_sha256 == binding.snapshot().source_sha256,
                "history_job_archive_changed"
            );
            job.view.archived = true;
            job.view.normalization = reader
                .projection(&job.normalization_revision, false)?
                .map(|projection| projection.progress())
                .transpose()?;
            ensure!(
                job.view.stage != HistoryImportStage::Normalized
                    || job
                        .view
                        .normalization
                        .as_ref()
                        .is_some_and(|progress| progress.normalization_complete),
                "history_job_projection_missing"
            );
        } else {
            ensure!(!job.view.archived, "history_job_archive_receipt_missing");
        }
        Ok(())
    }

    fn observe(&self, mut job: Job) -> Result<HistoryImportJobView> {
        if self.retired(&job)? || (job.managed() && self.archives
            .archive_retirement_for_source(&job.view.job_id)?.is_some_and(|view|
                view.phase==kcoder_state::external_history::lifecycle::ArchiveRetirementPhase::Collecting)) {
            return Ok(job.view);
        }
        if job.view.stage != HistoryImportStage::Failed {
            let checkpoint = job.view.clone();
            if let Err(error) = self.refresh(&mut job) {
                if kcoder_state::history_index::HistoryCatalogRecoveryRequired::from_error(&error)
                    .is_none()
                {
                    if let Some(contention) =
                        kcoder_state::history_index::HistoryCatalogBusy::from_error(&error)
                    {
                        return Err(error.context(contention));
                    }
                    return Err(error);
                }
                // Observation never repairs storage or replaces a durable watermark with zero.
                job.view = checkpoint;
                job.view.failure_code = Some(HISTORY_PROJECTION_RECOVERY_REQUIRED.into());
            }
        }
        job.view.cancel_requested = job.view.stage != HistoryImportStage::Normalized
            && self.cancel_requested(&job.view.job_id)?;
        if job.view.stage == HistoryImportStage::Normalizing
            && job.view.failure_code.is_none()
            && requires_reinterpretation(&job)
        {
            // Report the interpretation boundary without rewriting the old journal or rows.
            job.view.failure_code = Some(HISTORY_REINTERPRETATION_REQUIRED.into());
        }
        Ok(job.view)
    }

    fn cancel_requested(&self, id: &str) -> Result<bool> {
        let name = format!("{id}.cancel.json");
        let Some(bytes) = self.read_optional(&name, 8)? else {
            return Ok(false);
        };
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("history_job_invalid_control"))
    }

    fn read_optional(&self, name: &str, maximum: u64) -> Result<Option<Vec<u8>>> {
        self.directory.verify_private_directory()?;
        let file = match self.directory.open_regular_file_snapshot(OsStr::new(name)) {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(_) => anyhow::bail!("history_job_unavailable"),
        };
        ensure!(
            file.metadata()?.len() <= maximum,
            "history_job_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(maximum + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 <= maximum, "history_job_budget_exceeded");
        Ok(Some(bytes))
    }

    fn load_optional(&self, id: &str) -> Result<Option<Job>> {
        valid_id(id)?;
        let Some(bytes) = self.read_optional(&format!("{id}.json"), MAX_JOB_BYTES)? else {
            return Ok(None);
        };
        let job: Job = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_job_invalid_journal"))?;
        ensure!(
            matches!(job.version, 1..=4)
                && ((job.version < 4 && job.resource_budget.is_none())
                    || (job.version == 4 && job.resource_budget.is_some()))
                && job.owner == self.owner
                && job.view.job_id == id
                && (!matches!(
                    job.view.stage,
                    HistoryImportStage::Normalizing | HistoryImportStage::Normalized
                ) || job.archive_stage_completed)
                && Self::valid_source(&job)?,
            "history_job_binding_changed"
        );
        Self::validate_reinterpretation(&job)?;
        if let Some(selection) = &job.selection {
            selection.verify_history_directory(&self.directory)?;
        }
        self.validate_managed(&job)?;
        Ok(Some(job))
    }

    fn load(&self, id: &str) -> Result<Job> {
        self.load_optional(id)?.context("history_job_not_found")
    }

    fn save(&self, job: &Job) -> Result<()> {
        let bytes = serde_json::to_vec(job)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOB_BYTES,
            "history_job_budget_exceeded"
        );
        self.directory
            .atomic_replace(OsStr::new(&format!("{}.json", job.view.job_id)), &bytes)
    }
}

fn requires_reinterpretation(job: &Job) -> bool {
    job.normalization_revision
        == crate::history_normalization::LEGACY_HISTORY_NORMALIZATION_REVISION
        && job.archive_stage_completed
        && !job
            .view
            .normalization
            .as_ref()
            .is_some_and(|progress| progress.normalization_complete)
}

fn failure_code(error: &anyhow::Error) -> String {
    if error
        .downcast_ref::<kcoder_state::history_index::HistoryCatalogCapacityReached>()
        .is_some()
    {
        return "history_job_catalog_capacity_reached".into();
    }
    // Preserve typed contention as a failed worker checkpoint, distinct from a
    // retryable read-only catalog observation at the RPC boundary.
    if kcoder_state::history_index::HistoryCatalogBusy::from_error(error).is_some() {
        return "history_job_catalog_busy".into();
    }
    if error
        .downcast_ref::<crate::contention::MigrationContention>()
        .is_some()
    {
        return "history_job_parent_busy".into();
    }
    let code = error.to_string();
    if matches!(
        code.as_str(),
        "history_resource_budget_exceeded"
            | "history_resource_file_budget_exceeded"
            | "history_resource_disk_space_insufficient"
            | "history_resource_disk_nodes_insufficient"
            | "history_resource_disk_space_unavailable"
            | "history_resource_reservation_abandoned"
            | "history_resource_reservation_missing"
            | "history_resource_reservation_changed"
            | "history_resource_binding_changed"
    ) {
        return code;
    }
    error
        .chain()
        .find_map(|cause| {
            let message = cause.to_string();
            (message.len() <= 160
                && message
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                && [
                    "migration_history_",
                    "external_history_",
                    "history_normalization_",
                    "history_projection_",
                    "history_job_",
                ]
                .iter()
                .any(|prefix| message.starts_with(prefix)))
            .then_some(message)
        })
        .unwrap_or_else(|| "history_job_stage_failed".into())
}
