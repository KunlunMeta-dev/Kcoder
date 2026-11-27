//! Nonblocking same-lifecycle message snapshots for side questions.
use crate::{AppState, AppStateLifecycleIdentity, MessageRevision};
use kcoder_types::SharedMessages;

pub struct SideQuestionSnapshot {
    owner: AppStateLifecycleIdentity,
    messages: SharedMessages,
    revision: MessageRevision,
    session_id: String,
}

impl SideQuestionSnapshot {
    pub fn owner(&self) -> &AppStateLifecycleIdentity {
        &self.owner
    }
    pub fn messages(&self) -> SharedMessages {
        self.messages.clone()
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Busy returns None; changed identity/revision returns false.
    pub fn try_is_current(&self, state: &AppState) -> anyhow::Result<Option<bool>> {
        match state.inner.try_read() {
            Ok(inner) => Ok(Some(
                self.owner.matches_locked(state, &inner) && self.revision == inner.message_revision,
            )),
            Err(std::sync::TryLockError::WouldBlock) => Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("side-question state is unavailable")
            }
        }
    }
}

impl AppState {
    /// Capture messages and their original owner under one nonblocking lock.
    pub fn try_capture_side_question_snapshot(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> anyhow::Result<Option<SideQuestionSnapshot>> {
        let inner = match self.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("side-question state is unavailable")
            }
        };
        anyhow::ensure!(
            owner.matches_locked(self, &inner),
            "side-question lifecycle changed"
        );
        Ok(Some(SideQuestionSnapshot {
            owner: owner.clone(),
            messages: inner.messages.clone(),
            revision: inner.message_revision.clone(),
            session_id: inner.session_id.clone(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_types::Message;

    #[test]
    fn snapshot_is_bound_to_one_lifecycle_and_message_revision() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = AppState::new(first.path());
        let foreign = AppState::new(second.path());
        state.add_message(Message::user_text("original"));
        let owner = state.inspection_lifecycle_identity();
        let snapshot = state
            .try_capture_side_question_snapshot(&owner)
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.try_is_current(&state).unwrap(), Some(true));
        assert_eq!(snapshot.try_is_current(&foreign).unwrap(), Some(false));
        assert!(foreign.try_capture_side_question_snapshot(&owner).is_err());
        state.add_message(Message::user_text("new input"));
        assert_eq!(snapshot.try_is_current(&state).unwrap(), Some(false));
        assert_eq!(snapshot.messages().len(), 1);
    }
}
