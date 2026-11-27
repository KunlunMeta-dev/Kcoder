//! Observe an existing execution lease without creating locks or accepting a runner.
use super::*;
use fs2::FileExt;
use std::{fs::File, time::Duration};

impl MigrationStore {
    pub(super) fn batch_write_lock(&self) -> Result<File> {
        acquire_short_lease(|| self.write_lock())
    }

    pub(super) fn batch_runner_lock(&self, job_id: &str) -> Result<File> {
        acquire_short_lease(|| {
            self.directory
                .try_exclusive_lock(OsStr::new(&format!(".{job_id}.runner.lock")))?
                .ok_or_else(|| crate::contention::busy(crate::contention::LeaseKind::BatchRunner))
        })
    }
    pub fn batch_execution_active(&self, job_id: &str) -> Result<bool> {
        let job = self.read(job_id)?;
        ensure!(job.batch.is_some(), "migration_not_a_batch");
        self.verify_batch_control_runner(&job)?;
        let name = format!(".{job_id}.runner.lock");
        let file = match self
            .directory
            .open_read_write_file(OsStr::new(&name), false)
        {
            Ok(file) => file,
            Err(error)
                if error.chain().any(|cause| {
                    cause
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                }) =>
            {
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        match FileExt::try_lock_shared(&file) {
            Ok(()) => Ok(false),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error().is_some_and(|code| {
                        fs2::lock_contended_error().raw_os_error() == Some(code)
                    }) =>
            {
                Ok(true)
            }
            Err(error) => Err(error.into()),
        }
    }
}

fn acquire_short_lease(mut acquire: impl FnMut() -> Result<File>) -> Result<File> {
    for attempt in 0..64 {
        match acquire() {
            Err(error)
                if attempt < 63
                    && error
                        .downcast_ref::<crate::contention::MigrationContention>()
                        .is_some_and(|contention| {
                            matches!(
                                contention.lease,
                                crate::contention::LeaseKind::JournalWrite
                                    | crate::contention::LeaseKind::BatchRunner
                            )
                        }) =>
            {
                // Waiting for a lease precedes every side effect; no action is replayed.
                std::thread::sleep(Duration::from_millis(1));
            }
            result => return result,
        }
    }
    unreachable!("the final lease attempt returns its result")
}
