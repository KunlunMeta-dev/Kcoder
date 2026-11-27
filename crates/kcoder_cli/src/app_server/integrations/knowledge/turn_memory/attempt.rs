use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::HistoryAppendScope;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use std::{ffi::OsStr, path::PathBuf};

/// Held original directories plus the real private record; names alone never establish acceptance.
pub(in crate::app_server::integrations::knowledge) struct AcceptedAttempt {
    path: PathBuf,
    session: PrivateDirectory,
    attempts: PrivateDirectory,
    record: TurnAttemptRecord,
    state_scope: HistoryAppendScope,
}
impl AcceptedAttempt {
    pub(in crate::app_server::integrations::knowledge) fn capture(
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
    ) -> Result<Self> {
        identity.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            engine.session_id() == identity.thread_id,
            "MEMORY_TURN_STATE_MISMATCH"
        );
        let state_scope = engine.state.history_attempt_scope(identity.clone())?;
        ensure!(
            state_scope.matches_current(&engine.state),
            "MEMORY_TURN_NOT_CURRENT_ACCEPTED_TASK"
        );
        let path = engine.session_storage_dir_for(&identity.thread_id);
        let session = PrivateDirectory::open_existing(&path)?;
        session.verify_private_directory()?;
        let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
        attempts.verify_private_directory()?;
        let record = Self::load(&path, identity)?;
        ensure!(
            record.status == TurnAttemptStatus::Accepted && record.completion.is_none(),
            "MEMORY_TURN_NOT_ACCEPTED"
        );
        ensure!(
            record.request_fingerprint.is_some(),
            "MEMORY_TURN_ACCEPTANCE_UNAVAILABLE"
        );
        let proof = Self {
            path,
            session,
            attempts,
            record,
            state_scope,
        };
        proof.verify(engine, identity)?;
        Ok(proof)
    }
    fn load(path: &std::path::Path, identity: &TurnAttemptIdentity) -> Result<TurnAttemptRecord> {
        TurnAttemptStore::open_existing(path, &identity.thread_id)?
            .context("MEMORY_TURN_ACCEPTANCE_UNAVAILABLE")?
            .load(identity)?
            .context("MEMORY_TURN_ACCEPTANCE_UNAVAILABLE")
    }
    pub(in crate::app_server::integrations::knowledge) fn verify(
        &self,
        engine: &QueryEngine,
        identity: &TurnAttemptIdentity,
    ) -> Result<()> {
        ensure!(
            engine.session_id() == identity.thread_id
                && engine.session_storage_dir_for(&identity.thread_id) == self.path,
            "MEMORY_TURN_STATE_MISMATCH"
        );
        ensure!(
            self.state_scope.matches_current(&engine.state),
            "MEMORY_TURN_NOT_CURRENT_ACCEPTED_TASK"
        );
        self.session.verify_private_directory()?;
        self.attempts.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&self.path)?;
        let current_attempts = current.open_child(OsStr::new("turn-attempts"), false)?;
        ensure!(
            current.directory_identity()? == self.session.directory_identity()?
                && current_attempts.directory_identity()? == self.attempts.directory_identity()?,
            "MEMORY_TURN_ACCEPTANCE_STORAGE_CHANGED"
        );
        ensure!(
            Self::load(&self.path, identity)? == self.record,
            "MEMORY_TURN_ACCEPTANCE_CHANGED"
        );
        Ok(())
    }
}
