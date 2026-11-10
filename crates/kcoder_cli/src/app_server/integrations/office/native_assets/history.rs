//! Read-only original task witnesses; never activate a historical runtime.
use super::*;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
#[cfg(all(test, target_os = "linux"))]
#[path = "history_modes_tests.rs"]
mod tests;

pub(super) struct HistoryRoot {
    path: PathBuf,
    directory: PrivateDirectory,
    profile: PrivateDirectory,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct HistoryWitness {
    root_identity: String,
    session_identity: String,
    attempts_identity: String,
    records: Vec<TurnAttemptRecord>,
}
impl HistoryRoot {
    pub(super) fn observe(engine: &QueryEngine) -> Result<Option<Self>> {
        // A workspace with no sessions has no historical task witness. Missing
        // history must not block unrelated material/metadata operations or
        // initialize a ghost session; corrupt existing history still fails.
        match std::fs::symlink_metadata(engine.client_storage_root()) {
            Ok(_) => Self::capture(engine).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    pub(super) fn capture(engine: &QueryEngine) -> Result<Self> {
        // The Engine factory owns this root. No client path selects it.
        let path = engine.client_storage_root();
        ensure!(path.is_absolute(), "OFFICE_NATIVE_TASK_NOT_FOUND");
        let profile_path = engine
            .native_settings_source_path()
            .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
        let profile = PrivateDirectory::open_existing(
            profile_path
                .parent()
                .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?,
        )?;
        profile.verify_private_directory()?;
        let directory = PrivateDirectory::open_existing(&path)?;
        // The normal producer creates 0755 client/session directories below
        // the private profile. Never repair modes or adopt another profile.
        directory.verify_trusted_config_directory()?;
        Ok(Self {
            path,
            directory,
            profile,
        })
    }
    fn verify_owner(&self, engine: &QueryEngine) -> Result<()> {
        self.profile.verify_private_directory()?;
        let path = engine
            .native_settings_source_path()
            .context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?;
        let profile = PrivateDirectory::open_existing(
            path.parent().context("OFFICE_NATIVE_PROFILE_UNAVAILABLE")?,
        )?;
        profile.verify_private_directory()?;
        self.directory.verify_trusted_config_directory()?;
        let current = PrivateDirectory::open_existing(&self.path)?;
        current.verify_trusted_config_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile.directory_identity()?
                && engine.client_storage_root() == self.path
                && current.directory_identity()? == self.directory.directory_identity()?,
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        Ok(())
    }
    pub(super) fn task_witness(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &OfficeTaskRef,
    ) -> Result<HistoryWitness> {
        ensure!(
            !task.thread_id.is_empty()
                && task.thread_id.len() <= 256
                && !task.thread_id.chars().any(char::is_control),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        self.verify_owner(engine)?;
        let current = PrivateDirectory::open_existing(&self.path)?;
        current.verify_trusted_config_directory()?;
        ensure!(
            engine.client_storage_root() == self.path
                && current.directory_identity()? == self.directory.directory_identity()?,
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        let path = engine.session_storage_dir_for(&task.thread_id);
        ensure!(
            path.parent() == Some(self.path.as_path())
                && path.file_name() == Some(OsStr::new(&task.thread_id)),
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        let session = current.open_child(OsStr::new(&task.thread_id), false)?;
        session.verify_trusted_config_directory()?;
        let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
        attempts.verify_private_directory()?;
        let ledger = TurnAttemptStore::open_existing(&path, &task.thread_id)?
            .context("OFFICE_NATIVE_TASK_NOT_FOUND")?;
        let records: Vec<_> = ledger
            .list()?
            .into_iter()
            .filter(|record| {
                record.identity.thread_id == task.thread_id
                    && record.identity.turn_id == task.turn_id
                    && record.status.is_known()
                    && record.request_fingerprint.is_some()
            })
            .collect();
        ensure!(!records.is_empty(), "OFFICE_NATIVE_TASK_NOT_FOUND");
        if task.run_id.is_some() {
            crate::app_server::integrations::core::runtime_driver::child_intents::verify_workflow_office_history(native, engine, task, &records)?;
        }

        // Reopen after reading: an FD into replaced history is not authority.
        let reopened_root = PrivateDirectory::open_existing(&self.path)?;
        self.verify_owner(engine)?;
        reopened_root.verify_trusted_config_directory()?;
        ensure!(
            reopened_root.directory_identity()? == self.directory.directory_identity()?,
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        let current_session = reopened_root.open_child(OsStr::new(&task.thread_id), false)?;
        current_session.verify_trusted_config_directory()?;
        let current_attempts = current_session.open_child(OsStr::new("turn-attempts"), false)?;
        current_attempts.verify_private_directory()?;
        ensure!(
            session.directory_identity()? == current_session.directory_identity()?
                && attempts.directory_identity()? == current_attempts.directory_identity()?,
            "OFFICE_NATIVE_TASK_NOT_FOUND"
        );
        Ok(HistoryWitness {
            root_identity: current.directory_identity()?,
            session_identity: session.directory_identity()?,
            attempts_identity: attempts.directory_identity()?,
            records,
        })
    }
}
