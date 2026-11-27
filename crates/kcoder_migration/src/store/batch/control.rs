//! Cancel only an authenticated original execution generation, not its changing progress CAS.
use super::*;
use crate::batch::control::*;
use kcoder_config::{PortableLeaseIdentity, PrivateLeaseMode, VerifiedPrivateLease};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    time::{Duration, Instant},
};

pub(super) enum ControlRunner {
    Legacy(File),
    Tracked(VerifiedPrivateLease),
}
impl ControlRunner {
    fn file(&self) -> &File {
        match self {
            Self::Legacy(file) => file,
            Self::Tracked(lease) => lease.file(),
        }
    }
}
fn birth_hash(
    job: &str,
    profile: &str,
    identity: &PortableLeaseIdentity,
    journal: &PortableLeaseIdentity,
) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "migration-batch-control/v2",
            job,
            profile,
            identity,
            journal
        ))?)
    ))
}
impl MigrationStore {
    fn control_journal_lease(&self, mode: PrivateLeaseMode) -> Result<VerifiedPrivateLease> {
        let name = OsStr::new(".lock");
        let identity = self
            .directory
            .portable_regular_identity(name)
            .map_err(|_| anyhow::anyhow!("migration_batch_control_unknown"))?;
        let deadline = Instant::now() + Duration::from_millis(500);
        loop {
            if let Some(lease) = self
                .directory
                .try_existing_portable_lock(name, &identity, mode)?
            {
                return Ok(lease);
            }
            #[cfg(test)]
            tests::on_journal_contention();
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            // Retry only acquisition of this original identity, never the operation.
            std::thread::sleep(remaining.min(Duration::from_millis(1)));
        }
        Err(crate::contention::busy(match mode {
            PrivateLeaseMode::Shared => crate::contention::LeaseKind::JournalRead,
            PrivateLeaseMode::Exclusive => crate::contention::LeaseKind::JournalWrite,
        }))
    }
    fn verified_execution_record<'a>(
        &self,
        job: &'a MigrationJob,
    ) -> Result<Option<&'a ExecutionControlRecord>> {
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        batch.validate_execution_control()?;
        let Some(record) = batch.execution_control.as_deref() else {
            return Ok(None);
        };
        let name = format!(".{}.runner.lock", job.job_id);
        ensure!(
            record.job_id == job.job_id
                && record.profile_identity == self.directory.directory_identity()?
                && record.current.admission_sequence <= job.sequence
                && record.birth_sha256
                    == birth_hash(
                        &job.job_id,
                        &record.profile_identity,
                        &record.runner_identity,
                        &record.journal_identity
                    )?
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(".lock"))
                    .map_err(|_| anyhow::anyhow!("migration_batch_control_unknown"))?
                    == record.journal_identity
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(&name))
                    .map_err(|_| anyhow::anyhow!("migration_batch_control_unknown"))?
                    == record.runner_identity,
            "migration_batch_control_unknown"
        );
        Ok(Some(record))
    }
    pub(super) fn batch_control_runner(&self, id: &str) -> Result<ControlRunner> {
        let job = {
            let _lease = self.control_journal_lease(PrivateLeaseMode::Shared)?;
            self.load(id)?
        };
        if let Some(record) = self.verified_execution_record(&job)? {
            let name = format!(".{id}.runner.lock");
            return self
                .directory
                .try_existing_portable_lock(
                    OsStr::new(&name),
                    &record.runner_identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .map(ControlRunner::Tracked)
                .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner));
        }
        // Old executions held this same runner for their whole run. A missing old
        // runner is not permission to fabricate a replacement between two checkpoints.
        if !job.batch.as_ref().unwrap().request_kinds.is_empty() {
            let name = format!(".{id}.runner.lock");
            let identity = self
                .directory
                .portable_regular_identity(OsStr::new(&name))
                .map_err(|_| anyhow::anyhow!("migration_batch_control_unknown"))?;
            return self
                .directory
                .try_existing_portable_lock(
                    OsStr::new(&name),
                    &identity,
                    PrivateLeaseMode::Exclusive,
                )?
                .map(ControlRunner::Tracked)
                .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner));
        }
        self.batch_runner_lock(id).map(ControlRunner::Legacy)
    }
    pub(super) fn admit_batch_control(
        &self,
        job: &mut MigrationJob,
        plan: &str,
        request: &str,
        mode: BatchRunMode,
        runner: &ControlRunner,
        journal: &File,
    ) -> Result<()> {
        let identity = PortableLeaseIdentity::from_regular_handle(runner.file())?;
        let journal_identity = PortableLeaseIdentity::from_regular_handle(journal)?;
        ensure!(
            self.directory
                .portable_regular_identity(OsStr::new(".lock"))?
                == journal_identity,
            "migration_batch_control_unknown"
        );
        let old = self.verified_execution_record(job)?.cloned();
        if let Some(old) = &old {
            ensure!(
                old.runner_identity == identity,
                "migration_batch_control_unknown"
            );
        }
        let profile = self.directory.directory_identity()?;
        let mode = match mode {
            BatchRunMode::Apply => BatchControlMode::Apply,
            BatchRunMode::Resume => BatchControlMode::Resume,
            BatchRunMode::Rollback => BatchControlMode::Rollback,
        };
        let record = ExecutionControlRecord {
            version: 2,
            job_id: job.job_id.clone(),
            profile_identity: profile.clone(),
            birth_sha256: birth_hash(&job.job_id, &profile, &identity, &journal_identity)?,
            runner_identity: identity,
            journal_identity,
            current: BatchControlGeneration {
                plan_id: plan.into(),
                run_request_id: request.into(),
                admission_sequence: job.sequence,
                mode,
            },
            cancellations: old.map(|record| record.cancellations).unwrap_or_default(),
        };
        let batch = job.batch.as_mut().unwrap();
        batch
            .request_kinds
            .insert(BIRTH_MARKER.into(), record.birth_sha256.clone());
        batch.execution_control = Some(Box::new(record));
        Ok(())
    }
    fn control_view(
        &self,
        job: &MigrationJob,
        command: Option<&str>,
    ) -> Result<BatchControlObservation> {
        let batch = job.batch.as_ref().context("migration_not_a_batch")?;
        let record = self.verified_execution_record(job)?;
        let generation = record
            .map(|record| &record.current)
            .filter(|value| Some(value.plan_id.as_str()) == batch.plan_id.as_deref())
            .cloned();
        let phase = if generation.is_some() {
            BatchControlPhase::Tracked
        } else if record.is_some() || batch.request_kinds.is_empty() {
            BatchControlPhase::Unadmitted
        } else {
            BatchControlPhase::LegacyUnknown
        };
        let last = generation.as_ref().and_then(|generation| {
            record?
                .cancellations
                .iter()
                .rev()
                .find(|receipt| {
                    receipt.admission_sequence == generation.admission_sequence
                        && receipt.plan_id == generation.plan_id
                })
                .cloned()
        });
        Ok(BatchControlObservation {
            job_id: job.job_id.clone(),
            current_sequence: job.sequence,
            plan_id: batch.plan_id.clone(),
            phase,
            generation,
            cancel_requested: matches!(
                job.status,
                JobStatus::CancelRequested | JobStatus::Cancelled
            ),
            last_cancellation: last,
            requested_receipt: command.and_then(|command| {
                record?
                    .cancellations
                    .iter()
                    .find(|receipt| receipt.command_id == command)
                    .cloned()
            }),
        })
    }
    pub fn observe_batch_control(
        &self,
        id: &str,
        command_id: Option<&str>,
    ) -> Result<BatchControlObservation> {
        if let Some(id) = command_id {
            ensure!(command(id), "migration_batch_control_invalid_command");
        }
        let _journal = self.control_journal_lease(PrivateLeaseMode::Shared)?;
        self.control_view(&self.load(id)?, command_id)
    }
    pub fn cancel_batch_execution(
        &self,
        intent: &BatchCancellationIntent,
    ) -> Result<BatchControlObservation> {
        ensure!(
            command(&intent.command_id)
                && opaque(&intent.run_request_id, 256)
                && opaque(&intent.plan_id, 128)
                && intent.admission_sequence > 0,
            "migration_batch_control_invalid_command"
        );
        let _journal = self.control_journal_lease(PrivateLeaseMode::Exclusive)?;
        let mut job = self.load(&intent.job_id)?;
        let record = self
            .verified_execution_record(&job)?
            .context("migration_batch_control_unknown")?;
        if let Some(receipt) = record
            .cancellations
            .iter()
            .find(|receipt| receipt.command_id == intent.command_id)
        {
            ensure!(
                receipt.plan_id == intent.plan_id
                    && receipt.run_request_id == intent.run_request_id
                    && receipt.admission_sequence == intent.admission_sequence,
                "migration_batch_cancel_command_changed"
            );
            return self.control_view(&job, Some(&intent.command_id));
        }
        ensure!(
            job.batch.as_ref().unwrap().plan_id.as_deref() == Some(intent.plan_id.as_str())
                && record.current.plan_id == intent.plan_id
                && record.current.run_request_id == intent.run_request_id
                && record.current.admission_sequence == intent.admission_sequence
                && record.current.mode != BatchControlMode::Rollback,
            "migration_batch_control_changed"
        );
        ensure!(
            record.cancellations.len() < MAX_CANCELLATIONS,
            "migration_batch_control_capacity_reached"
        );
        self.ensure_no_pending_received_preparation(&job)?;
        Self::request_cancel(&mut job)?;
        bump(&mut job)?;
        let receipt = BatchCancellationReceipt {
            command_id: intent.command_id.clone(),
            plan_id: intent.plan_id.clone(),
            run_request_id: intent.run_request_id.clone(),
            admission_sequence: intent.admission_sequence,
            accepted_sequence: job.sequence,
        };
        job.batch
            .as_mut()
            .unwrap()
            .execution_control
            .as_mut()
            .unwrap()
            .cancellations
            .push(receipt);
        self.save(&job)?;
        self.control_view(&job, Some(&intent.command_id))
    }
    pub(super) fn verify_batch_control_runner(&self, job: &MigrationJob) -> Result<()> {
        self.verified_execution_record(job).map(|_| ())
    }
}

#[cfg(test)]
mod tests;
