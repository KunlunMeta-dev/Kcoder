//! Conservative retirement of unchanged continuation output. Source archives remain owned elsewhere.
use crate::history_continuation_jobs::{ContinuationJobs, ContinuationTarget};
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::historical_undo::{
    self as native, HistoricalSessionUndoReceipt, HistoricalUndoLease,
};
use kcoder_types::{
    historical_context::HistoricalSessionSeedBinding,
    historical_continuation::HistoricalContinuationStage, historical_undo::*,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
const META: u64 = 256 * 1024;
const MAX_JOBS: usize = 4096;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    target: ContinuationTarget,
    binding: HistoricalSessionSeedBinding,
    seal: HistoricalUndoSealReceipt,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    version: u8,
    owner: String,
    source_sequence: u64,
    source: Source,
    cancel_watermark: u64,
    receipt: Option<HistoricalSessionUndoReceipt>,
    view: HistoricalUndoJob,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Link {
    version: u8,
    owner: String,
    continuation: String,
    job: Job,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u8,
    owner: String,
    continuation: String,
    job_id: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    revision: u64,
    acknowledged: u64,
    #[serde(default)]
    sequence: u64,
}

pub struct HistoryUndoJobs {
    directory: PrivateDirectory,
    profile: PathBuf,
    workspace: PathBuf,
    owner: String,
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|error| {
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
fn id(key: &str) -> Result<()> {
    ensure!(
        uuid::Uuid::parse_str(key).is_ok_and(|id| id.to_string() == key),
        "historical_undo_invalid_job_id"
    );
    Ok(())
}
fn uncertain(stage: HistoricalUndoStage) -> bool {
    matches!(
        stage,
        HistoricalUndoStage::Retiring | HistoricalUndoStage::OutcomeUnknown
    )
}
fn code(error: &anyhow::Error) -> &'static str {
    for error in error.chain() {
        let text = error.to_string();
        for (pattern, code) in [
            ("cancelled", "historical_undo_cancelled"),
            ("busy", "historical_undo_busy"),
            ("budget_exceeded", "historical_undo_budget_exceeded"),
            ("unsealed", "historical_undo_unsupported_unsealed"),
            ("missing_seal", "historical_undo_unsupported_unsealed"),
            (
                "job_recovery_required",
                "historical_undo_job_recovery_required",
            ),
            ("not_imported", "historical_undo_not_imported"),
            ("generation_changed", "historical_undo_session_modified"),
            ("source_deleted", "historical_undo_session_modified"),
            ("history_changed", "historical_undo_session_modified"),
            ("session_modified", "historical_undo_session_modified"),
            ("source_changed", "historical_undo_source_changed"),
            ("target_changed", "historical_undo_target_changed"),
        ] {
            if text.contains(pattern) {
                return code;
            }
        }
    }
    "historical_undo_check_failed"
}
impl HistoryUndoJobs {
    pub fn open(profile: &Path, workspace: &Path) -> Result<Self> {
        Self::open_at(profile, workspace, true)?.context("historical_undo_store_missing")
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
        let directory = match migration.open_child(OsStr::new("history-undo"), create) {
            Ok(value) => value,
            Err(error) if !create && missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let work = PrivateDirectory::open_existing(workspace)?;
        let owner = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                root.directory_identity()?,
                directory.directory_identity()?,
                work.directory_identity()?
            ))?)
        );
        Ok(Some(Self {
            directory,
            profile: profile.into(),
            workspace: workspace.into(),
            owner,
        }))
    }
    fn load<T: serde::de::DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let file = match self.directory.open_regular_file_snapshot(OsStr::new(name)) {
            Ok(file) => file,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        ensure!(
            file.metadata()?.len() <= META,
            "historical_undo_metadata_budget_exceeded"
        );
        let mut bytes = Vec::new();
        file.take(META + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= META,
            "historical_undo_metadata_budget_exceeded"
        );
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("historical_undo_invalid_metadata"))
    }
    fn save(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() as u64 <= META,
            "historical_undo_metadata_budget_exceeded"
        );
        self.directory.atomic_replace(OsStr::new(name), &bytes)
    }
    fn lock(&self, name: &str) -> Result<File> {
        self.directory
            .try_exclusive_lock(OsStr::new(name))?
            .context("historical_undo_busy")
    }
    fn job(&self, key: &str) -> Result<Job> {
        id(key)?;
        let job: Job = self
            .load(&format!("{key}.json"))?
            .context("historical_undo_job_not_found")?;
        self.verify_job(&job, key)?;
        Ok(job)
    }
    fn verify_job(&self, job: &Job, key: &str) -> Result<()> {
        ensure!(
            job.version == 1
                && job.owner == self.owner
                && job.view.job_id == key
                && job.source.binding.operation_id == job.view.continuation_job_id
                && job.source.target.session_id == job.view.session_id
                && job.source.binding.session_id == job.view.session_id
                && job.source.seal.session_id == job.view.session_id,
            "historical_undo_owner_changed"
        );
        Ok(())
    }
    fn link(&self, source: &str) -> Result<Option<Link>> {
        id(source)?;
        let Some(link) = self.load::<Link>(&format!("{source}.source.json"))? else {
            return Ok(None);
        };
        ensure!(
            link.version == 1
                && link.owner == self.owner
                && link.continuation == source
                && link.job.view.continuation_job_id == source,
            "historical_undo_owner_changed"
        );
        self.verify_job(&link.job, &link.job.view.job_id)?;
        Ok(Some(link))
    }
    fn request(&self, key: &str) -> Result<Option<Request>> {
        let Some(request) = self.load::<Request>(&format!("{key}.request.json"))? else {
            return Ok(None);
        };
        ensure!(
            request.version == 1 && request.owner == self.owner,
            "historical_undo_owner_changed"
        );
        id(&request.continuation)?;
        id(&request.job_id)?;
        Ok(Some(request))
    }
    fn orphan(&self, source: &str, check: &mut impl FnMut() -> bool) -> Result<Option<Job>> {
        let mut found = None;
        let mut bytes = 0u64;
        self.directory
            .visit_entry_names_bounded(MAX_JOBS * 8 + 2, |name| {
                ensure!(check(), "historical_undo_cancelled");
                let Some(key) = name
                    .to_str()
                    .and_then(|name| name.strip_suffix(".json"))
                    .filter(|key| uuid::Uuid::parse_str(key).is_ok())
                else {
                    return Ok(());
                };
                bytes = bytes
                    .checked_add(self.directory.entry_metadata(name)?.len())
                    .context("historical_undo_metadata_budget_exceeded")?;
                ensure!(
                    bytes <= 16 * 1024 * 1024,
                    "historical_undo_metadata_budget_exceeded"
                );
                let job: Job = self
                    .load(&format!("{key}.json"))?
                    .context("historical_undo_job_not_found")?;
                if job.owner != self.owner {
                    return Ok(());
                }
                self.verify_job(&job, key)?;
                if job.view.continuation_job_id == source {
                    ensure!(found.is_none(), "historical_undo_ambiguous_jobs");
                    found = Some(job);
                }
                Ok(())
            })?;
        Ok(found)
    }
    fn existing(
        &self,
        source: &str,
        check: &mut impl FnMut() -> bool,
    ) -> Result<Option<HistoricalUndoJob>> {
        if let Some(link) = self.link(source)? {
            ensure!(
                self.load::<Job>(&format!("{}.json", link.job.view.job_id))?
                    .is_some(),
                "historical_undo_job_recovery_required"
            );
            let actual = self.job(&link.job.view.job_id)?;
            ensure!(
                actual.source == link.job.source
                    && actual.source_sequence == link.job.source_sequence,
                "historical_undo_source_changed"
            );
            return self.read(&link.job.view.job_id).map(Some);
        }
        self.orphan(source, check)?
            .map(|job| self.read(&job.view.job_id))
            .transpose()
    }
    fn control(&self, key: &str) -> Result<Control> {
        let control: Control = self
            .load(&format!("{key}.cancel.json"))?
            .unwrap_or_default();
        ensure!(
            control.acknowledged <= control.revision,
            "historical_undo_invalid_control"
        );
        Ok(control)
    }
    fn checkpoint(&self, job: &mut Job) -> Result<()> {
        let _control = self.lock(&format!("{}.control.lock", job.view.job_id))?;
        let mut control = self.control(&job.view.job_id)?;
        job.view.sequence = job
            .view
            .sequence
            .max(control.sequence)
            .checked_add(1)
            .context("historical_undo_sequence_exhausted")?;
        control.sequence = job.view.sequence;
        self.save(&format!("{}.cancel.json", job.view.job_id), &control)?;
        self.save(&format!("{}.json", job.view.job_id), job)
    }
    fn source(&self, key: &str) -> Result<(u64, Source)> {
        Self::source_at(&self.profile, &self.workspace, key)
    }
    fn source_at(profile: &Path, workspace: &Path, key: &str) -> Result<(u64, Source)> {
        id(key)?;
        let continuation = ContinuationJobs::open_existing(profile, workspace)?
            .context("historical_undo_continuation_missing")?;
        let view = continuation.read(key)?;
        ensure!(
            view.stage == HistoricalContinuationStage::Imported,
            "historical_undo_not_imported"
        );
        let target = continuation
            .target(key)?
            .context("historical_undo_target_missing")?;
        let binding = continuation
            .published_binding(key)?
            .context("historical_undo_binding_missing")?;
        let seal = continuation
            .published_undo_seal(key)?
            .context("historical_undo_unsupported_unsealed")?;
        ensure!(
            binding.operation_id == key
                && binding.session_id == target.session_id
                && seal.operation_id == key
                && seal.session_id == target.session_id,
            "historical_undo_source_changed"
        );
        Ok((
            view.sequence,
            Source {
                target,
                binding,
                seal,
            },
        ))
    }
    fn lease(source: &Source) -> Result<HistoricalUndoLease> {
        let history = PrivateDirectory::open_existing(&source.target.history_directory)?;
        let artifacts = PrivateDirectory::open_existing(&source.target.artifact_directory)?;
        ensure!(
            history.directory_identity()? == source.target.history_identity
                && artifacts.directory_identity()? == source.target.artifact_identity,
            "historical_undo_target_changed"
        );
        HistoricalUndoLease::try_acquire_existing(
            &source
                .target
                .history_directory
                .join(format!("{}.jsonl", source.target.session_id)),
            &source.target.artifact_directory,
            &source.target.session_id,
        )
    }
    pub fn preview(&self, key: &str) -> Result<HistoricalUndoPreview> {
        self.preview_with_cancel(key, || true)
    }
    /// Lightweight saved-state lookup: no native lease, snapshot hashing, repair, or catalog scan.
    pub fn existing_at(
        profile: &Path,
        workspace: &Path,
        key: &str,
    ) -> Result<Option<HistoricalUndoJob>> {
        id(key)?;
        ContinuationJobs::open_existing(profile, workspace)?
            .context("historical_undo_continuation_missing")?
            .read(key)?;
        let Some(store) = Self::open_existing(profile, workspace)? else {
            return Ok(None);
        };
        let Some(link) = store.link(key)? else {
            return Ok(None);
        };
        ensure!(
            store
                .load::<Job>(&format!("{}.json", link.job.view.job_id))?
                .is_some(),
            "historical_undo_job_recovery_required"
        );
        let actual = store.job(&link.job.view.job_id)?;
        ensure!(
            actual.source == link.job.source && actual.source_sequence == link.job.source_sequence,
            "historical_undo_source_changed"
        );
        store.read(&link.job.view.job_id).map(Some)
    }
    pub fn preview_with_cancel(
        &self,
        key: &str,
        check: impl FnMut() -> bool,
    ) -> Result<HistoricalUndoPreview> {
        Self::preview_at(&self.profile, &self.workspace, key, check)
    }
    /// Observe publication and seal without creating the independent undo journal directory.
    pub fn preview_at(
        profile: &Path,
        workspace: &Path,
        key: &str,
        mut check: impl FnMut() -> bool,
    ) -> Result<HistoricalUndoPreview> {
        id(key)?;
        let continuation = ContinuationJobs::open_existing(profile, workspace)?
            .context("historical_undo_continuation_missing")?;
        let view = continuation.read(key)?;
        let existing = match Self::open_existing(profile, workspace)? {
            Some(store) => store.existing(key, &mut check),
            None => Ok(None),
        };
        let existing_reason = existing.as_ref().err().map(code);
        let checked = (|| {
            if let Some(reason) = existing_reason {
                anyhow::bail!(reason);
            }
            let (_, source) = Self::source_at(profile, workspace, key)?;
            let lease = Self::lease(&source)?;
            ensure!(check(), "historical_undo_cancelled");
            native::preview_historical_session_undo(&lease, &source.binding, &source.seal, |_| {
                check()
            })
        })();
        let reason_code = checked.as_ref().err().map(|error| code(error).to_owned());
        Ok(HistoricalUndoPreview {
            continuation_job_id: key.into(),
            session_id: view.thread_id,
            can_undo: checked.is_ok(),
            reason_code,
            existing_job: existing.ok().flatten(),
            archives_retained: true,
            attachments_retained: true,
        })
    }
    pub fn create(
        &self,
        key: &str,
        continuation: &str,
        expected_sequence: u64,
    ) -> Result<HistoricalUndoJob> {
        id(key)?;
        id(continuation)?;
        let _catalog = self.lock("catalog.lock")?;
        let request = self.request(key)?;
        if let Some(request) = &request {
            ensure!(
                request.continuation == continuation,
                "historical_undo_request_changed"
            );
        }
        if let Some(previous) = self.load::<Job>(&format!("{key}.json"))? {
            self.verify_job(&previous, key)?;
            ensure!(
                previous.view.continuation_job_id == continuation
                    && previous.source_sequence == expected_sequence,
                "historical_undo_request_changed"
            );
        }
        let mut jobs = 0;
        let mut requests = 0;
        let mut scanned = 0u64;
        let mut requested_operation: Option<String> = None;
        self.directory
            .visit_entry_names_bounded(MAX_JOBS * 8 + 2, |name| {
                let text = name.to_str().context("historical_undo_invalid_metadata")?;
                if text.ends_with(".request.json") {
                    requests += 1;
                    scanned = scanned
                        .checked_add(self.directory.entry_metadata(name)?.len())
                        .context("historical_undo_metadata_budget_exceeded")?;
                    ensure!(
                        scanned <= 16 * 1024 * 1024,
                        "historical_undo_metadata_budget_exceeded"
                    );
                    let prior: Request = self
                        .load(text)?
                        .context("historical_undo_invalid_metadata")?;
                    if prior.owner == self.owner && prior.continuation == continuation {
                        id(&prior.job_id)?;
                        ensure!(
                            requested_operation
                                .as_ref()
                                .is_none_or(|id| id == &prior.job_id),
                            "historical_undo_ambiguous_jobs"
                        );
                        requested_operation = Some(prior.job_id);
                    }
                }
                if text
                    .strip_suffix(".json")
                    .is_some_and(|stem| uuid::Uuid::parse_str(stem).is_ok())
                {
                    jobs += 1;
                }
                if let Some(source) = text.strip_suffix(".source.json") {
                    scanned = scanned
                        .checked_add(self.directory.entry_metadata(name)?.len())
                        .context("historical_undo_metadata_budget_exceeded")?;
                    ensure!(
                        scanned <= 16 * 1024 * 1024,
                        "historical_undo_metadata_budget_exceeded"
                    );
                    let link: Link = self
                        .load(text)?
                        .context("historical_undo_invalid_metadata")?;
                    if link.job.view.job_id == key {
                        ensure!(
                            link.owner == self.owner && source == continuation,
                            "historical_undo_request_changed"
                        );
                    }
                }
                Ok(())
            })?;
        ensure!(
            request.is_some() || requests < MAX_JOBS,
            "historical_undo_request_budget_exceeded"
        );
        let mut fresh = false;
        let link = if let Some(link) = self.link(continuation)? {
            link
        } else {
            let job = if let Some(job) = self.orphan(continuation, &mut || true)? {
                job
            } else {
                ensure!(jobs < MAX_JOBS, "historical_undo_job_budget_exceeded");
                let (sequence, source) = self.source(continuation)?;
                ensure!(
                    sequence == expected_sequence,
                    "historical_undo_revision_conflict"
                );
                fresh = requested_operation.is_none();
                let operation = requested_operation.as_deref().unwrap_or(key);
                Job {
                    version: 1,
                    owner: self.owner.clone(),
                    source_sequence: sequence,
                    source: source.clone(),
                    cancel_watermark: 0,
                    receipt: None,
                    view: HistoricalUndoJob {
                        job_id: operation.into(),
                        continuation_job_id: continuation.into(),
                        session_id: source.target.session_id,
                        sequence: 0,
                        stage: HistoricalUndoStage::Planned,
                        checked_bytes: 0,
                        cancel_requested: false,
                        cancel_revision: 0,
                        failure_code: None,
                        archives_retained: true,
                        attachments_retained: true,
                    },
                }
            };
            let link = Link {
                version: 1,
                owner: self.owner.clone(),
                continuation: continuation.into(),
                job,
            };
            // Persist the original operation identity before its mutable journal can become visible.
            self.save(&format!("{continuation}.source.json"), &link)?;
            link
        };
        ensure!(
            link.job.source_sequence == expected_sequence,
            "historical_undo_revision_conflict"
        );
        if let Some(request) = &request {
            ensure!(
                request.job_id == link.job.view.job_id,
                "historical_undo_request_changed"
            );
        }
        let canonical = &link.job.view.job_id;
        if request.is_none() {
            self.save(
                &format!("{key}.request.json"),
                &Request {
                    version: 1,
                    owner: self.owner.clone(),
                    continuation: continuation.into(),
                    job_id: canonical.clone(),
                },
            )?;
        }
        if self.load::<Job>(&format!("{canonical}.json"))?.is_none() {
            let _runner = self.lock(&format!("{canonical}.run.lock"))?;
            let mut restored = link.job.clone();
            if !fresh {
                restored.view.stage = HistoricalUndoStage::OutcomeUnknown;
                restored.view.failure_code = Some("historical_undo_job_recovery_required".into());
                restored.receipt = None;
                self.checkpoint(&mut restored)?;
            } else {
                self.save(&format!("{canonical}.json"), &restored)?;
            }
        }
        let actual = self.job(canonical)?;
        ensure!(
            actual.source == link.job.source && actual.source_sequence == link.job.source_sequence,
            "historical_undo_source_changed"
        );
        self.read(canonical)
    }
    pub fn read(&self, key: &str) -> Result<HistoricalUndoJob> {
        let mut job = self.job(key)?;
        let control = self.control(key)?;
        job.view.cancel_revision = control.revision;
        job.view.cancel_requested = job.view.stage != HistoricalUndoStage::Undone
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
    pub fn cancel(&self, key: &str) -> Result<HistoricalUndoJob> {
        let job = self.job(key)?;
        if job.view.stage == HistoricalUndoStage::Undone {
            return self.read(key);
        }
        {
            let _control = self.lock(&format!("{key}.control.lock"))?;
            let mut control = self.control(key)?;
            control.revision = control
                .revision
                .checked_add(1)
                .context("historical_undo_sequence_exhausted")?;
            self.save(&format!("{key}.cancel.json"), &control)?;
        }
        if let Some(_runner) = self
            .directory
            .try_exclusive_lock(OsStr::new(&format!("{key}.run.lock")))?
        {
            let mut job = self.job(key)?;
            if job.view.stage != HistoricalUndoStage::Undone && !uncertain(job.view.stage) {
                job.cancel_watermark = self.control(key)?.revision;
                job.view.stage = HistoricalUndoStage::Cancelled;
                self.checkpoint(&mut job)?;
            }
        }
        self.read(key)
    }
    /// Called only by an explicitly owned host worker. Reconcile uncertain retirement before retry.
    pub fn run(&self, key: &str, sequence: u64) -> Result<HistoricalUndoJob> {
        self.run_with_cancel(key, sequence, || true)
    }
    pub fn run_with_cancel(
        &self,
        key: &str,
        sequence: u64,
        mut check: impl FnMut() -> bool,
    ) -> Result<HistoricalUndoJob> {
        id(key)?;
        self.job(key)?;
        let _runner = self.lock(&format!("{key}.run.lock"))?;
        let mut job = self.job(key)?;
        ensure!(
            job.view.sequence == sequence,
            "historical_undo_revision_conflict"
        );
        if job.view.stage == HistoricalUndoStage::Undone {
            return self.read(key);
        }
        let was_uncertain = uncertain(job.view.stage);
        {
            let _control = self.lock(&format!("{key}.control.lock"))?;
            let mut control = self.control(key)?;
            control.acknowledged = control.acknowledged.max(job.cancel_watermark);
            self.save(&format!("{key}.cancel.json"), &control)?;
        }
        let source: Result<(Source, HistoricalUndoLease)> = (|| {
            let (_, source) = self.source(&job.view.continuation_job_id)?;
            ensure!(source == job.source, "historical_undo_source_changed");
            let lease = Self::lease(&source)?;
            Ok((source, lease))
        })();
        let (source, lease) = match source {
            Ok(value) => value,
            Err(error) => {
                job.view.stage = if was_uncertain {
                    HistoricalUndoStage::OutcomeUnknown
                } else {
                    HistoricalUndoStage::Conflict
                };
                job.view.failure_code = Some(code(&error).into());
                self.checkpoint(&mut job)?;
                return self.read(key);
            }
        };
        if !was_uncertain {
            job.view.stage = HistoricalUndoStage::Checking;
            job.view.checked_bytes = 0;
            job.view.failure_code = None;
            self.checkpoint(&mut job)?;
        }
        let job = RefCell::new(job);
        let callback_error = RefCell::new(None);
        let result = native::undo_historical_session_with_commit(
            &lease,
            &source.binding,
            &source.seal,
            key,
            |bytes| {
                let checked: Result<bool> = (|| {
                    let mut job = job.borrow_mut();
                    let control = self.control(key)?;
                    if control.revision > control.acknowledged {
                        job.cancel_watermark = control.revision;
                        return Ok(false);
                    }
                    if !check() {
                        return Ok(false);
                    }
                    if bytes.saturating_sub(job.view.checked_bytes) >= 1024 * 1024 {
                        job.view.checked_bytes = bytes;
                        self.checkpoint(&mut job)?;
                    }
                    Ok(true)
                })();
                match checked {
                    Ok(value) => value,
                    Err(error) => {
                        *callback_error.borrow_mut() = Some(error);
                        false
                    }
                }
            },
            || {
                let mut job = job.borrow_mut();
                job.view.stage = HistoricalUndoStage::Retiring;
                self.checkpoint(&mut job)
            },
        );
        let mut job = job.into_inner();
        match result {
            Ok(receipt) => {
                job.receipt = Some(receipt);
                job.view.stage = HistoricalUndoStage::Undone;
                job.view.failure_code = None;
            }
            Err(error) => {
                let code = callback_error
                    .into_inner()
                    .as_ref()
                    .map_or_else(|| code(&error), code);
                job.view.failure_code = Some(code.into());
                job.view.stage = if uncertain(job.view.stage) {
                    HistoricalUndoStage::OutcomeUnknown
                } else if code == "historical_undo_cancelled" {
                    HistoricalUndoStage::Cancelled
                } else if code == "historical_undo_session_modified"
                    || code == "historical_undo_target_changed"
                {
                    HistoricalUndoStage::Conflict
                } else {
                    HistoricalUndoStage::Failed
                };
            }
        }
        self.checkpoint(&mut job)?;
        self.read(key)
    }
}
