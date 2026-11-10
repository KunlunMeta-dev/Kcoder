//! A durable birth binds one job to one portable, process-owned execution lease.
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateLeaseMode, VerifiedPrivateLease};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryExecutionState {
    Running,
    Stopped,
    Unknown,
}

/// Not serializable or clonable. Only this descriptor owns the accepted execution.
pub struct HistoryExecutionGuard {
    owner: String,
    job: String,
    lease: VerifiedPrivateLease,
}
impl HistoryExecutionGuard {
    pub fn job_id(&self) -> &str {
        &self.job
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Birth {
    version: u32,
    owner: String,
    job_id: String,
    initial_sha256: String,
    identity: PortableLeaseIdentity,
    run_identity: PortableLeaseIdentity,
}
fn name(id: &str) -> String {
    format!("{id}.execution.lock")
}
fn marker(id: &str) -> String {
    format!("{id}.execution.birth")
}
fn terminal(job: &Job) -> bool {
    matches!(
        job.view.stage,
        HistoryImportStage::Cancelled | HistoryImportStage::Failed | HistoryImportStage::Normalized
    )
}

impl HistoryJobStore {
    fn save_execution_metadata(&self, job: &Job) -> Result<()> {
        let id = &job.view.job_id;
        let bytes = self
            .read_optional(&format!("{id}.json"), MAX_JOB_BYTES)?
            .context("history_job_not_found")?;
        let current: Job = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_job_invalid_journal"))?;
        let mut expected = job.clone();
        expected.execution_identity = None;
        expected.execution_birth_sha256 = None;
        ensure!(
            serde_json::to_value(&current)? == serde_json::to_value(&expected)?,
            "history_job_revision_conflict"
        );
        let mut raw: serde_json::Value = serde_json::from_slice(&bytes)?;
        let object = raw.as_object_mut().context("history_job_invalid_journal")?;
        object.insert(
            "executionIdentity".into(),
            serde_json::to_value(&job.execution_identity)?,
        );
        object.insert(
            "executionBirthSha256".into(),
            serde_json::to_value(&job.execution_birth_sha256)?,
        );
        let bytes = serde_json::to_vec(&raw)?;
        ensure!(
            bytes.len() as u64 <= MAX_JOB_BYTES,
            "history_job_budget_exceeded"
        );
        self.directory
            .atomic_replace(OsStr::new(&format!("{id}.json")), &bytes)
    }

    pub(super) fn owner_check_only(job: &Job) -> bool {
        job.execution_identity.is_none()
            && job.execution_birth_sha256.is_none()
            && (job.view.stage == HistoryImportStage::Normalized
                || (matches!(
                    job.view.stage,
                    HistoryImportStage::Failed | HistoryImportStage::Cancelled
                ) && (job.normalization_revision
                    == crate::history_normalization::LEGACY_HISTORY_NORMALIZATION_REVISION
                    || !crate::history_normalization::executable_revision(
                        &job.normalization_revision,
                    ))))
    }

    pub fn resume_only_checks_owner(&self, job_id: &str) -> Result<bool> {
        Ok(Self::owner_check_only(&self.load(job_id)?))
    }

    /// Read a committed job header while its writer may hold a projection transaction.
    /// Released owners still use the normal full receipt/projection validation.
    pub fn observe_execution(
        &self,
        job_id: &str,
    ) -> Result<(HistoryImportJobView, HistoryExecutionState)> {
        for _ in 0..4 {
            // One fully validated atomic header supplies both lease probes and the running view.
            // Re-reading it three times also repeated the shared lifecycle validation.
            let job = self.load(job_id)?;
            let before = self.execution_state_for_job(&job)?;
            let view = if before == HistoryExecutionState::Stopped {
                // The owner may have committed its terminal header after our first
                // read but before this lease probe. Preserve a fresh full terminal read.
                self.read(job_id)
            } else {
                let mut view = job.view.clone();
                view.cancel_requested = view.stage != HistoryImportStage::Normalized
                    && self.cancel_requested(job_id)?;
                Ok(view)
            };
            let after = self.execution_state_for_job(&job)?;
            if before != after {
                continue;
            }
            return view.map(|view| (view, after));
        }
        anyhow::bail!("history_job_execution_observation_busy")
    }

    fn execution_birth(&self, job: &Job) -> Result<Birth> {
        let bytes = self
            .read_optional(&marker(&job.view.job_id), 4096)?
            .context("history_job_execution_unknown")?;
        let birth: Birth = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_job_execution_unknown"))?;
        ensure!(
            birth.version == 1 && birth.owner == self.owner && birth.job_id == job.view.job_id,
            "history_job_execution_unknown"
        );
        if let Some(identity) = &job.execution_identity {
            ensure!(&birth.identity == identity, "history_job_execution_unknown");
            ensure!(
                job.execution_birth_sha256.as_deref()
                    == Some(format!("{:x}", Sha256::digest(serde_json::to_vec(&birth)?)).as_str()),
                "history_job_execution_unknown"
            );
        } else {
            ensure!(
                job.execution_birth_sha256.is_none(),
                "history_job_execution_unknown"
            );
        }
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new(&format!("{}.run.lock", job.view.job_id)))?
                == birth.run_identity,
            "history_job_execution_unknown"
        );
        Ok(birth)
    }

    /// This never creates a leaf, repairs metadata, or takes the mutation/run lease.
    pub fn execution_state(&self, job_id: &str) -> Result<HistoryExecutionState> {
        self.execution_state_for_job(&self.load(job_id)?)
    }

    fn execution_state_for_job(&self, job: &Job) -> Result<HistoryExecutionState> {
        let job_id = &job.view.job_id;
        let Some(identity) = &job.execution_identity else {
            return Ok(HistoryExecutionState::Unknown);
        };
        let observed = (|| -> Result<HistoryExecutionState> {
            self.execution_birth(job)?;
            let probe = self.directory.try_existing_portable_lock(
                OsStr::new(&name(job_id)),
                identity,
                PrivateLeaseMode::Shared,
            )?;
            Ok(if probe.is_none() {
                HistoryExecutionState::Running
            } else {
                HistoryExecutionState::Stopped
            })
        })();
        // Missing/replaced/unsafe identities are explicitly unknown, never globally idle.
        Ok(observed.unwrap_or(HistoryExecutionState::Unknown))
    }

    /// Classify only an already unknown observation. Valid pending legacy births
    /// remain explicitly recoverable; a damaged recorded identity never is.
    pub fn execution_unknown_code(&self, job_id: &str) -> Result<&'static str> {
        let job = self.load(job_id)?;
        if job.execution_identity.is_some() || job.execution_birth_sha256.is_some() {
            return Ok("history_job_execution_unknown");
        }
        let untracked = (|| -> Result<bool> {
            self.directory
                .portable_regular_identity(OsStr::new(&format!("{job_id}.run.lock")))?;
            if self.read_optional(&marker(job_id), 4096)?.is_some() {
                let birth = self.execution_birth(&job)?;
                ensure!(
                    birth.initial_sha256
                        == format!("{:x}", Sha256::digest(serde_json::to_vec(&job)?)),
                    "history_job_execution_unknown"
                );
                ensure!(
                    self.directory
                        .portable_regular_identity(OsStr::new(&name(job_id)))?
                        == birth.identity,
                    "history_job_execution_unknown"
                );
                return Ok(true);
            }
            match self
                .directory
                .open_single_link_regular_file(OsStr::new(&name(job_id)))
            {
                Err(error) if missing(&error) => Ok(true),
                _ => Ok(false),
            }
        })()
        .unwrap_or(false);
        Ok(if untracked {
            "history_job_execution_untracked"
        } else {
            "history_job_execution_unknown"
        })
    }

    /// Called only under the pre-existing job run lease, including first publication.
    pub(super) fn birth_execution(
        &self,
        job: &mut Job,
        run: &File,
    ) -> Result<HistoryExecutionGuard> {
        ensure!(
            job.execution_identity.is_none() && job.execution_birth_sha256.is_none(),
            "history_job_execution_unknown"
        );
        let initial_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(job)?));
        let birth = match self.read_optional(&marker(&job.view.job_id), 4096)? {
            Some(_) => {
                let birth = self.execution_birth(job)?;
                ensure!(
                    birth.initial_sha256 == initial_sha256,
                    "history_job_execution_recovery_required"
                );
                birth
            }
            None => {
                // An orphaned pre-marker file is not adopted or replaced.
                let file = self
                    .directory
                    .open_read_write_file(OsStr::new(&name(&job.view.job_id)), true)
                    .map_err(|_| anyhow::anyhow!("history_job_execution_recovery_required"))?;
                let identity = self.directory.portable_regular_handle_identity(&file)?;
                ensure!(
                    self.directory
                        .portable_regular_identity(OsStr::new(&name(&job.view.job_id)))?
                        == identity,
                    "history_job_execution_unknown"
                );
                let run_identity = self.directory.portable_regular_handle_identity(run)?;
                ensure!(
                    self.directory
                        .portable_regular_identity(OsStr::new(&format!(
                            "{}.run.lock",
                            job.view.job_id
                        )))?
                        == run_identity,
                    "history_job_execution_unknown"
                );
                let birth = Birth {
                    version: 1,
                    owner: self.owner.clone(),
                    job_id: job.view.job_id.clone(),
                    initial_sha256,
                    identity,
                    run_identity,
                };
                self.directory.atomic_replace(
                    OsStr::new(&marker(&job.view.job_id)),
                    &serde_json::to_vec(&birth)?,
                )?;
                birth
            }
        };
        job.execution_birth_sha256 =
            Some(format!("{:x}", Sha256::digest(serde_json::to_vec(&birth)?)));
        job.execution_identity = Some(birth.identity);
        self.acquire_execution(job)
    }

    fn acquire_execution(&self, job: &Job) -> Result<HistoryExecutionGuard> {
        self.execution_birth(job)?;
        let identity = job
            .execution_identity
            .as_ref()
            .context("history_job_execution_unknown")?;
        let lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(&name(&job.view.job_id)),
                identity,
                PrivateLeaseMode::Exclusive,
            )
            .map_err(|_| anyhow::anyhow!("history_job_execution_unknown"))?
            .context("history_job_execution_busy")?;
        Ok(HistoryExecutionGuard {
            owner: self.owner.clone(),
            job: job.view.job_id.clone(),
            lease,
        })
    }

    /// Acceptance precedes every background spawn and is retained across all its steps.
    pub fn claim_execution(
        &self,
        job_id: &str,
        expected_sequence: u64,
    ) -> Result<HistoryExecutionGuard> {
        valid_id(job_id)?;
        let mut job = self.load(job_id)?;
        self.ensure_live(&job)?;
        ensure!(
            job.execution_identity.is_some() || job.execution_birth_sha256.is_none(),
            "history_job_execution_unknown"
        );
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        if job.execution_identity.is_some() {
            let execution = self.acquire_execution(&job)?;
            let _run = self.execution_run_lock(&execution)?;
            ensure!(
                self.load(job_id)?.view.sequence == expected_sequence,
                "history_job_revision_conflict"
            );
            return Ok(execution);
        }
        // A legacy nonterminal runner may be between two old steps; a free short
        // run lease is not evidence that its execution has stopped.
        ensure!(terminal(&job), "history_job_execution_recovery_required");
        let run = self.legacy_run_lock(job_id)?;
        job = self.load(job_id)?;
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        if job.execution_identity.is_some() {
            return self.acquire_execution(&job);
        }
        ensure!(terminal(&job), "history_job_execution_recovery_required");
        let execution = self.birth_execution(&mut job, run.file())?;
        self.save_execution_metadata(&job)?;
        Ok(execution)
    }

    /// Explicit cancel-then-resume is the only takeover of an untracked legacy job.
    pub fn claim_resume_execution(
        &self,
        job_id: &str,
        expected_sequence: u64,
    ) -> Result<(HistoryExecutionGuard, u64)> {
        valid_id(job_id)?;
        let initial = self.load(job_id)?;
        ensure!(
            initial.execution_identity.is_some() || initial.execution_birth_sha256.is_none(),
            "history_job_execution_unknown"
        );
        if initial.execution_identity.is_some() {
            return self
                .claim_execution(job_id, expected_sequence)
                .map(|guard| (guard, expected_sequence));
        }
        let run = self.legacy_run_lock(job_id)?;
        let _control = self.lock("control.lock")?;
        let mut job = self.load(job_id)?;
        self.ensure_live(&job)?;
        ensure!(
            job.view.sequence == expected_sequence,
            "history_job_revision_conflict"
        );
        let execution = if job.execution_identity.is_some() {
            self.acquire_execution(&job)?
        } else {
            ensure!(
                terminal(&job) || self.cancel_requested(job_id)?,
                "history_job_execution_recovery_required"
            );
            let execution = self.birth_execution(&mut job, run.file())?;
            if !terminal(&job) {
                job.view.stage = HistoryImportStage::Cancelled;
                job.view.failure_code = None;
                self.advance(&mut job)?;
            } else {
                self.save_execution_metadata(&job)?;
            }
            execution
        };
        // The additional private header field fences old deny_unknown_fields
        // writers before releasing their run lease. A held old step was never preempted.
        Ok((execution, job.view.sequence))
    }

    fn legacy_run_lock(&self, job_id: &str) -> Result<VerifiedPrivateLease> {
        let name = format!("{job_id}.run.lock");
        let identity = self
            .directory
            .portable_regular_identity(OsStr::new(&name))
            .map_err(|_| anyhow::anyhow!("history_job_execution_unknown"))?;
        self.directory
            .try_existing_portable_lock(OsStr::new(&name), &identity, PrivateLeaseMode::Exclusive)?
            .context("history_job_busy")
    }

    pub(super) fn execution_run_lock(
        &self,
        execution: &HistoryExecutionGuard,
    ) -> Result<VerifiedPrivateLease> {
        self.validate_execution(execution)?;
        let job = self.load(execution.job_id())?;
        let birth = self.execution_birth(&job)?;
        let name = format!("{}.run.lock", execution.job_id());
        for attempt in 0..64 {
            if let Some(lease) = self.directory.try_existing_portable_lock(
                OsStr::new(&name),
                &birth.run_identity,
                PrivateLeaseMode::Exclusive,
            )? {
                return Ok(lease);
            }
            if attempt < 63 {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        anyhow::bail!("history_job_busy")
    }

    pub(super) fn validate_execution(&self, execution: &HistoryExecutionGuard) -> Result<()> {
        ensure!(
            execution.owner == self.owner,
            "history_job_execution_wrong_owner"
        );
        let job = self.load(execution.job_id())?;
        self.execution_birth(&job)?;
        ensure!(
            job.execution_identity.as_ref() == Some(execution.lease.identity())
                && self
                    .directory
                    .portable_regular_handle_identity(execution.lease.file())?
                    == *execution.lease.identity()
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(&name(execution.job_id())))?
                    == *execution.lease.identity(),
            "history_job_execution_unknown"
        );
        Ok(())
    }
}
