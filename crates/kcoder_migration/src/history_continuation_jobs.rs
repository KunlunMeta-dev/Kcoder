//! Persistent continuation ownership and checkpoints. Engine creation remains in the host.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_types::{
    historical_context::*, historical_continuation::*, historical_undo::HistoricalUndoSealReceipt,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
mod references;
const META: u64 = 256 * 1024;
pub const MAX_CONTINUATION_JOBS: usize = 4096;
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContinuationTarget {
    pub settings_template: Option<kcoder_types::settings_templates::SettingsTemplateBinding>,
    pub session_id: String,
    pub history_directory: PathBuf,
    pub history_identity: String,
    pub artifact_directory: PathBuf,
    pub artifact_identity: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    version: u8,
    owner: String,
    branch_identity: String,
    cancel_revision: u64,
    target: Option<ContinuationTarget>,
    binding: Option<HistoricalSessionSeedBinding>,
    receipt: Option<HistoricalSessionSeedReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    undo_seal: Option<HistoricalUndoSealReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_reference: Option<kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_reference: Option<kcoder_state::external_history::lifecycle::ArchiveReferenceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retired: Option<references::Retired>,
    view: HistoricalContinuationJob,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    revision: u64,
    acknowledged: u64,
}
pub struct ContinuationJobs {
    directory: PrivateDirectory,
    profile: PathBuf,
    owner: String,
}
pub struct ContinuationRun<'a> {
    store: &'a ContinuationJobs,
    job: Job,
    _lease: File,
}
fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|value| value.kind() == std::io::ErrorKind::NotFound)
}
fn id(id: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id),
        "continuation_invalid_job_id"
    );
    Ok(())
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn terminal(stage: HistoricalContinuationStage) -> bool {
    matches!(
        stage,
        HistoricalContinuationStage::Imported
            | HistoricalContinuationStage::Blocked
            | HistoricalContinuationStage::Cancelled
            | HistoricalContinuationStage::Failed
            | HistoricalContinuationStage::PublishUnknown
    )
}
impl ContinuationJobs {
    pub fn open(profile: &Path, workspace: &Path) -> Result<Self> {
        Self::open_at(profile, workspace, true)?.context("continuation_store_missing")
    }
    pub fn open_existing(profile: &Path, workspace: &Path) -> Result<Option<Self>> {
        Self::open_at(profile, workspace, false)
    }
    fn open_at(profile: &Path, workspace: &Path, create: bool) -> Result<Option<Self>> {
        let root = PrivateDirectory::open_existing(profile)?;
        root.verify_trusted_config_directory()?;
        let migration = match root.open_child(OsStr::new("migrations"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        migration.verify_private_directory()?;
        let directory = match migration.open_child(OsStr::new("history-continuations"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let workspace = PrivateDirectory::open_existing(workspace)?;
        let owner = hash(&(
            root.directory_identity()?,
            directory.directory_identity()?,
            workspace.directory_identity()?,
        ))?;
        Ok(Some(Self {
            directory,
            profile: profile.into(),
            owner,
        }))
    }
    fn load<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let file = match self.directory.open_regular_file_snapshot(OsStr::new(name)) {
            Ok(value) => value,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() <= META,
            "continuation_metadata_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(META + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= META,
            "continuation_metadata_budget_exceeded"
        );
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("continuation_invalid_metadata"))
    }
    fn save(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() as u64 <= META,
            "continuation_metadata_budget_exceeded"
        );
        self.directory.atomic_replace(OsStr::new(name), &bytes)
    }
    fn lock(&self, name: &str) -> Result<File> {
        self.directory
            .try_exclusive_lock(OsStr::new(name))?
            .context("continuation_busy")
    }
    fn job(&self, key: &str) -> Result<Job> {
        id(key)?;
        let job: Job = self
            .load(&format!("{key}.json"))?
            .context("continuation_job_not_found")?;
        ensure!(
            matches!(job.version, 1 | 2)
                && job.owner == self.owner
                && job.view.job_id == key
                && (job.version == 2
                    || job.source_reference.is_none()
                        && job.native_reference.is_none()
                        && job.retired.is_none()),
            "continuation_job_owner_changed"
        );
        self.verify_references(&job)?;
        Ok(job)
    }
    fn control(&self, key: &str) -> Result<Control> {
        let value: Control = self
            .load(&format!("{key}.cancel.json"))?
            .unwrap_or_default();
        ensure!(
            value.acknowledged <= value.revision,
            "continuation_invalid_control"
        );
        Ok(value)
    }
    fn checkpoint(&self, job: &mut Job) -> Result<()> {
        job.view.sequence = job
            .view
            .sequence
            .checked_add(1)
            .context("continuation_sequence_exhausted")?;
        self.save(&format!("{}.json", job.view.job_id), job)
    }
    pub fn create(
        &self,
        key: &str,
        source: &str,
        view: &str,
        policy: HistoricalContextPolicy,
        options: HistoricalContinuationOptions,
    ) -> Result<HistoricalContinuationJob> {
        id(key)?;
        id(source)?;
        ensure!(
            !view.is_empty() && view.len() <= 128,
            "continuation_invalid_selection"
        );
        ensure!(
            [&options.model, &options.settings_template]
                .into_iter()
                .flatten()
                .all(|value| !value.trim().is_empty() && value.len() <= 1024),
            "continuation_invalid_options"
        );
        ensure!(
            (1..=HISTORICAL_CONTEXT_MAX_BYTES).contains(&policy.max_context_bytes)
                && (1..=HISTORICAL_CONTEXT_MAX_ENTRIES).contains(&policy.max_entries)
                && policy.max_attachments <= 1024
                && policy.max_attachment_bytes <= 2 * 1024 * 1024 * 1024,
            "continuation_invalid_policy"
        );
        crate::history_context::validate_local_attachments(
            source,
            view,
            &policy,
            &options.local_attachments,
        )?;
        let branch = crate::history_branches::HistoryBranchStore::open(&self.profile)?
            .reference_view(source, view)?;
        let _catalog = self.lock("catalog.lock")?;
        if let Some(mut previous) = self.load::<Job>(&format!("{key}.json"))? {
            ensure!(
                previous.owner == self.owner
                    && previous.view.source_job_id == source
                    && previous.view.view_id == view
                    && previous.view.policy == policy
                    && previous.view.options == options,
                "continuation_request_changed"
            );
            if previous.retired.is_none() {
                self.pin_source_reference(&mut previous, &branch.source_guards())?;
            }
            return self.read(key);
        }
        let mut count = 0;
        self.directory
            .visit_entry_names_bounded(MAX_CONTINUATION_JOBS * 5 + 2, |name| {
                if name
                    .to_str()
                    .is_some_and(|name| name.ends_with(".json") && !name.ends_with(".cancel.json"))
                {
                    count += 1;
                }
                Ok(())
            })?;
        ensure!(
            count < MAX_CONTINUATION_JOBS,
            "continuation_job_count_budget_exceeded"
        );
        let (_, identity) = crate::history_branches::HistoryBranchStore::open(&self.profile)?
            .snapshot(source, view, 0)?;
        let mut job = Job {
            version: if branch
                .source_guards()
                .iter()
                .any(|guard| guard.is_managed())
            {
                2
            } else {
                1
            },
            owner: self.owner.clone(),
            branch_identity: identity,
            cancel_revision: 0,
            target: None,
            binding: None,
            receipt: None,
            undo_seal: None,
            source_reference: None,
            native_reference: None,
            retired: None,
            view: HistoricalContinuationJob {
                job_id: key.into(),
                source_job_id: source.into(),
                view_id: view.into(),
                policy,
                options,
                sequence: 0,
                stage: HistoricalContinuationStage::Planned,
                thread_id: None,
                compilation: None,
                projection: None,
                processed_bytes: 0,
                failure_code: None,
                cancel_requested: false,
                cancel_revision: 0,
            },
        };
        self.save(&format!("{key}.json"), &job)?;
        self.pin_source_reference(&mut job, &branch.source_guards())?;
        Ok(job.view)
    }
    pub fn read(&self, key: &str) -> Result<HistoricalContinuationJob> {
        let mut job = self.job(key)?;
        let control = self.control(key)?;
        job.view.cancel_revision = control.revision;
        job.view.cancel_requested = job.view.stage != HistoricalContinuationStage::Imported
            && control.revision > control.acknowledged;
        Ok(job.view)
    }
    pub fn running(&self, key: &str) -> Result<bool> {
        self.job(key)?;
        Ok(self
            .directory
            .try_exclusive_lock(OsStr::new(&format!("{key}.run.lock")))?
            .is_none())
    }
    pub fn target(&self, key: &str) -> Result<Option<ContinuationTarget>> {
        Ok(self.job(key)?.target)
    }
    pub fn published_binding(&self, key: &str) -> Result<Option<HistoricalSessionSeedBinding>> {
        Ok(self.job(key)?.binding)
    }
    /// Private proof is readable only with the complete imported publication receipt.
    pub fn published_undo_seal(&self, key: &str) -> Result<Option<HistoricalUndoSealReceipt>> {
        let job = self.job(key)?;
        ensure!(
            job.view.stage == HistoricalContinuationStage::Imported,
            "continuation_not_imported"
        );
        let receipt = job
            .receipt
            .context("continuation_publication_receipt_missing")?;
        ensure!(
            job.binding.as_ref() == Some(&receipt.binding)
                && job
                    .target
                    .as_ref()
                    .is_some_and(|target| target.session_id == receipt.binding.session_id),
            "continuation_publication_changed"
        );
        if let Some(seal) = &job.undo_seal {
            validate_undo_seal(seal, &receipt.binding)?;
        }
        Ok(job.undo_seal)
    }
    pub fn cancel(&self, key: &str) -> Result<HistoricalContinuationJob> {
        let job = self.job(key)?;
        if job.retired.is_some() {
            return self.read(key);
        }
        if job.view.stage == HistoricalContinuationStage::Imported {
            return self.read(key);
        }
        {
            let _guard = self.lock(&format!("{key}.control.lock"))?;
            let mut control = self.control(key)?;
            control.revision = control
                .revision
                .checked_add(1)
                .context("continuation_sequence_exhausted")?;
            self.save(&format!("{key}.cancel.json"), &control)?;
        }
        if let Some(_lease) = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!("{key}.run.lock")))?
        {
            let mut job = self.job(key)?;
            if job.view.stage != HistoricalContinuationStage::Imported
                && !matches!(
                    job.view.stage,
                    HistoricalContinuationStage::Publishing
                        | HistoricalContinuationStage::PublishUnknown
                )
            {
                job.cancel_revision = self.control(key)?.revision;
                job.view.stage = HistoricalContinuationStage::Cancelled;
                self.checkpoint(&mut job)?;
            }
        }
        self.read(key)
    }
    pub fn begin(&self, key: &str, sequence: u64, resume: bool) -> Result<ContinuationRun<'_>> {
        let lease = self.lock(&format!("{key}.run.lock"))?;
        let mut job = self.job(key)?;
        ensure!(job.retired.is_none(), "continuation_retired");
        ensure!(
            job.view.sequence == sequence,
            "continuation_revision_conflict"
        );
        ensure!(
            job.view.stage != HistoricalContinuationStage::Imported,
            "continuation_already_imported"
        );
        ensure!(
            if resume {
                job.view.stage != HistoricalContinuationStage::Planned
            } else {
                job.view.stage == HistoricalContinuationStage::Planned
            },
            "continuation_resume_required"
        );
        if job.binding.is_none()
            || !matches!(
                job.view.stage,
                HistoricalContinuationStage::Publishing
                    | HistoricalContinuationStage::PublishUnknown
            )
        {
            let (_, identity) = crate::history_branches::HistoryBranchStore::open(&self.profile)?
                .snapshot(&job.view.source_job_id, &job.view.view_id, 0)?;
            ensure!(
                identity == job.branch_identity,
                "continuation_source_changed"
            );
        }
        if resume {
            let _guard = self.lock(&format!("{key}.control.lock"))?;
            let mut control = self.control(key)?;
            control.acknowledged = control.acknowledged.max(job.cancel_revision);
            self.save(&format!("{key}.cancel.json"), &control)?;
        }
        if job.target.is_some() {
            self.pin_native_reference(&mut job)?;
        }
        job.view.failure_code = None;
        self.checkpoint(&mut job)?;
        Ok(ContinuationRun {
            store: self,
            job,
            _lease: lease,
        })
    }
}
impl ContinuationRun<'_> {
    pub fn view(&self) -> &HistoricalContinuationJob {
        &self.job.view
    }
    pub fn target(&self) -> Option<&ContinuationTarget> {
        self.job.target.as_ref()
    }
    pub fn binding(&self) -> Option<&HistoricalSessionSeedBinding> {
        self.job.binding.as_ref()
    }
    pub fn cancelled(&mut self) -> Result<bool> {
        let control = self.store.control(&self.job.view.job_id)?;
        if control.revision > control.acknowledged {
            self.job.cancel_revision = control.revision;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn reserve_target(&mut self, target: ContinuationTarget) -> Result<()> {
        ensure!(
            target.history_directory.is_absolute()
                && target.artifact_directory.is_absolute()
                && !target.history_identity.is_empty()
                && !target.artifact_identity.is_empty(),
            "continuation_invalid_target"
        );
        ensure!(
            target.session_id.len() == 5
                && target
                    .session_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric()),
            "continuation_invalid_target"
        );
        if let Some(previous) = &self.job.target {
            ensure!(*previous == target, "continuation_target_changed");
            return self.store.pin_native_reference(&mut self.job);
        }
        self.job.view.thread_id = Some(target.session_id.clone());
        self.job.target = Some(target);
        self.store.checkpoint(&mut self.job)?;
        self.store.pin_native_reference(&mut self.job)
    }
    pub fn stage(&mut self, stage: HistoricalContinuationStage) -> Result<()> {
        ensure!(!terminal(stage), "continuation_invalid_stage");
        self.job.view.stage = stage;
        self.job.view.processed_bytes = 0;
        self.store.checkpoint(&mut self.job)
    }
    pub fn progress(&mut self, bytes: u64) -> Result<()> {
        if bytes < self.job.view.processed_bytes
            || bytes.saturating_sub(self.job.view.processed_bytes) >= 1024 * 1024
        {
            self.job.view.processed_bytes = bytes;
            self.store.checkpoint(&mut self.job)?
        }
        Ok(())
    }
    pub fn compilation(&mut self, report: HistoricalContextReport) -> Result<()> {
        self.job.view.compilation = Some(report);
        self.store.checkpoint(&mut self.job)
    }
    pub fn admission(
        &mut self,
        report: HistoricalModelProjectionReport,
        binding: Option<HistoricalSessionSeedBinding>,
    ) -> Result<()> {
        if let Some(binding) = binding {
            ensure!(
                binding.operation_id == self.job.view.job_id
                    && binding.source_job_id == self.job.view.source_job_id
                    && binding.view_id == self.job.view.view_id
                    && binding.preparation.preparation_id == self.job.view.job_id
                    && report.projection_ready,
                "continuation_admission_changed"
            );
            if let Some(previous) = &self.job.binding {
                ensure!(*previous == binding, "continuation_model_changed")
            }
            ensure!(
                self.job
                    .target
                    .as_ref()
                    .is_some_and(|target| target.session_id == binding.session_id),
                "continuation_target_changed"
            );
            self.job.binding = Some(binding);
        }
        self.job.view.projection = Some(report);
        self.store.checkpoint(&mut self.job)
    }
    pub fn stop(&mut self, stage: HistoricalContinuationStage, code: Option<&str>) -> Result<()> {
        ensure!(
            terminal(stage) && stage != HistoricalContinuationStage::Imported,
            "continuation_invalid_stage"
        );
        self.job.view.stage = stage;
        self.job.view.failure_code = code.map(str::to_owned);
        self.store.checkpoint(&mut self.job)
    }
    pub fn imported(&mut self, receipt: HistoricalSessionSeedReceipt) -> Result<()> {
        self.imported_with_undo(receipt, None)
    }
    pub fn imported_with_undo(
        &mut self,
        receipt: HistoricalSessionSeedReceipt,
        undo_seal: Option<HistoricalUndoSealReceipt>,
    ) -> Result<()> {
        if let Some(seal) = &undo_seal {
            validate_undo_seal(seal, &receipt.binding)?;
        }
        ensure!(
            self.job.binding.as_ref() == Some(&receipt.binding),
            "continuation_publication_changed"
        );
        self.job.receipt = Some(receipt);
        self.job.undo_seal = undo_seal;
        self.job.view.stage = HistoricalContinuationStage::Imported;
        self.job.view.failure_code = None;
        self.job.view.cancel_requested = false;
        self.store.checkpoint(&mut self.job)
    }
}

fn validate_undo_seal(
    seal: &HistoricalUndoSealReceipt,
    binding: &HistoricalSessionSeedBinding,
) -> Result<()> {
    ensure!(
        seal.operation_id == binding.operation_id
            && seal.session_id == binding.session_id
            && seal.seal_sha256.len() == 64
            && seal
                .seal_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "continuation_undo_seal_changed"
    );
    Ok(())
}
