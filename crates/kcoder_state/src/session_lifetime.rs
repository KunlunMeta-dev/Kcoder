//! Persist session survival using the original metadata lock and history identity.
use super::*;
use kcoder_types::session_lifetime::{SessionLifetimeMode, SessionLifetimeSetting};

impl AppState {
    pub fn session_lifetime(&self) -> SessionLifetimeSetting {
        self.read_inner().session_lifetime
    }

    /// A successful preference write never grants execution or resource rights.
    pub fn set_session_lifetime(
        &self,
        expected_revision: u64,
        mode: SessionLifetimeMode,
    ) -> anyhow::Result<SessionLifetimeSetting> {
        let _persist = self.lock_session_state_persistence();
        let mut inner = self.write_inner();
        check_direct_history_fault(&inner)?;
        anyhow::ensure!(
            inner.session_lifetime.revision == expected_revision,
            "SESSION_LIFETIME_REVISION_CONFLICT"
        );
        require_history_source(&inner)?;
        let path = inner
            .session_state_path
            .clone()
            .ok_or_else(|| anyhow::anyhow!("SESSION_LIFETIME_PERSISTENCE_REQUIRED"))?;
        let previous = inner.session_lifetime;
        let setting = SessionLifetimeSetting {
            revision: expected_revision
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("SESSION_LIFETIME_REVISION_OVERFLOW"))?,
            mode,
        };
        inner.session_lifetime = setting;
        let persisted = session_persistence::PersistedSessionState::from_inner(&inner);
        let result = inner
            .history_source
            .as_ref()
            .unwrap()
            .write_metadata(&path, || {
                session_persistence::prepare_legacy_session_state_write(&path, persisted.clone())
            });
        if let Err(error) = result {
            if crate::history_store::is_uncertain_mutation(&error) {
                inner.history_write_fault = Some(format!("{error:#}"));
            } else {
                inner.session_lifetime = previous;
            }
            return Err(error);
        }
        Ok(setting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preference_is_revisioned_and_restored_without_replaying_history() -> anyhow::Result<()>
    {
        let root = tempfile::tempdir()?;
        let state = AppState::new(root.path());
        let history = root.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&history);
        state.add_message(kcoder_types::Message::user_text("original"));
        state.flush_history().await?;
        let before = std::fs::read(&history)?;
        assert_eq!(state.session_lifetime(), SessionLifetimeSetting::default());
        assert_eq!(
            state
                .set_session_lifetime(0, SessionLifetimeMode::Background)?
                .revision,
            1
        );
        assert!(
            state
                .set_session_lifetime(0, SessionLifetimeMode::Background)
                .is_err()
        );
        state.set_session_lifetime(1, SessionLifetimeMode::Background)?;
        let restored = AppState::new(root.path());
        restored.resume_from_history(&history)?;
        assert_eq!(
            restored.session_lifetime(),
            SessionLifetimeSetting {
                revision: 2,
                mode: SessionLifetimeMode::Background,
            }
        );
        assert_eq!(std::fs::read(history)?, before);
        assert_eq!(restored.messages().len(), 1);
        Ok(())
    }
}
