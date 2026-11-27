//! Read-only committed history facts. These never grant session or source authority.
use super::*;
use crate::turn_attempt_store::TurnAttemptStore;
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use sha2::{Digest, Sha256};

/// Captured from an actual prepared replay and its original terminal Accepted
/// record. Native consumers still need their new SessionLease, current source,
/// issuer, policy, immutable Assistant and exact native resource permissions.
pub struct PreparedCompletedAttemptHistory {
    path: PathBuf,
    source_stamp: crate::history_store::SourceStamp,
    identity: TurnAttemptIdentity,
    committed_uuid: String,
    history_ids: Vec<Option<String>>,
    messages_sha256: [u8; 32],
}

/// Compatibility name for a committed snapshot whose owning attempt has settled.
pub type PreparedCommittedAttemptHistory = PreparedCompletedAttemptHistory;

fn messages_hash<'a>(messages: impl IntoIterator<Item = &'a Message>) -> anyhow::Result<[u8; 32]> {
    let messages = messages.into_iter().collect::<Vec<_>>();
    Ok(Sha256::digest(serde_json::to_vec(&messages)?).into())
}

impl PreparedSessionResume {
    /// Read the real private attempt store; supplied identities only locate it.
    /// Unknown, interrupted, uncommitted or superseded history cannot be adopted.
    pub fn completed_attempt_history(
        &self,
        session_directory: &Path,
        identity: &TurnAttemptIdentity,
    ) -> anyhow::Result<PreparedCompletedAttemptHistory> {
        self.committed_attempt_history(session_directory, identity, false)
    }

    /// A new ordinary task input may retain the exact committed history after a
    /// known failed attempt. This never retries that attempt or restores partial
    /// output, and grants no execution, source, model or tool permissions.
    pub fn committed_terminal_attempt_history(
        &self,
        session_directory: &Path,
        identity: &TurnAttemptIdentity,
    ) -> anyhow::Result<PreparedCommittedAttemptHistory> {
        self.committed_attempt_history(session_directory, identity, true)
    }

    fn committed_attempt_history(
        &self,
        session_directory: &Path,
        identity: &TurnAttemptIdentity,
        include_failed: bool,
    ) -> anyhow::Result<PreparedCompletedAttemptHistory> {
        identity.validate().map_err(anyhow::Error::msg)?;
        anyhow::ensure!(
            identity.thread_id == self.session_id
                && self.source_stamp.known_committed_bytes().is_some()
                && crate::history_store::source_stamp(&self.path)? == self.source_stamp,
            "COMPLETED_HISTORY_SOURCE_CHANGED"
        );
        let store = TurnAttemptStore::open_existing(session_directory, &self.session_id)?
            .context("COMPLETED_HISTORY_ACCEPTED_REQUIRED")?;
        let record = store
            .load(identity)?
            .context("COMPLETED_HISTORY_ACCEPTED_REQUIRED")?;
        record.validate()?;
        let completion = record
            .completion
            .as_ref()
            .context("COMPLETED_HISTORY_COMMIT_REQUIRED")?;
        let uuid = completion
            .committed_history_uuid
            .as_ref()
            .context("COMPLETED_HISTORY_COMMIT_REQUIRED")?;
        anyhow::ensure!(
            record.identity == *identity
                && (record.status == TurnAttemptStatus::Completed
                    || include_failed && record.status == TurnAttemptStatus::Failed)
                && completion.status == record.status
                && self.last_transcript_uuid.as_ref() == Some(uuid)
                && self
                    .message_history_ids
                    .iter()
                    .any(|id| id.as_ref() == Some(uuid))
                && self.history_attempts.get(uuid).as_ref() == Some(identity)
                && store
                    .list()?
                    .iter()
                    .all(|entry| entry.status.is_terminal() && entry.completion.is_some()),
            "COMPLETED_HISTORY_ORIGINAL_COMMIT_REQUIRED"
        );
        let proof = PreparedCompletedAttemptHistory {
            path: self.path.clone(),
            source_stamp: self.source_stamp.clone(),
            identity: identity.clone(),
            committed_uuid: uuid.clone(),
            history_ids: self.message_history_ids.clone(),
            messages_sha256: messages_hash(self.messages.iter())?,
        };
        anyhow::ensure!(
            crate::history_store::source_stamp(&self.path)? == self.source_stamp,
            "COMPLETED_HISTORY_SOURCE_CHANGED"
        );
        Ok(proof)
    }
}

impl PreparedCompletedAttemptHistory {
    pub fn identity(&self) -> &TurnAttemptIdentity {
        &self.identity
    }

    /// Compare the freshly restored State to the exact prepared committed
    /// replay. This does not bind any old State epoch or former SessionLease.
    pub fn verify_restored(&self, state: &AppState) -> anyhow::Result<()> {
        anyhow::ensure!(
            crate::history_store::source_stamp(&self.path)?.same_committed_body(&self.source_stamp),
            "COMPLETED_HISTORY_SOURCE_CHANGED"
        );
        {
            let inner = state.read_inner();
            anyhow::ensure!(
                inner.session_id == self.identity.thread_id
                    && inner.history_path.as_ref() == Some(&self.path)
                    && inner.last_history_uuid.as_ref() == Some(&self.committed_uuid)
                    && inner.message_history_ids == self.history_ids
                    && inner.history_attempts.get(&self.committed_uuid).as_ref()
                        == Some(&self.identity)
                    && messages_hash(inner.messages.iter())? == self.messages_sha256,
                "COMPLETED_HISTORY_RESTORED_STATE_CHANGED"
            );
        }
        anyhow::ensure!(
            crate::history_store::source_stamp(&self.path)?.same_committed_body(&self.source_stamp),
            "COMPLETED_HISTORY_SOURCE_CHANGED"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptRecord};

    type CommittedFixture = (
        tempfile::TempDir,
        AppState,
        PathBuf,
        PathBuf,
        TurnAttemptIdentity,
    );
    async fn committed() -> anyhow::Result<CommittedFixture> {
        committed_outcome(TurnAttemptStatus::Completed).await
    }
    async fn committed_outcome(status: TurnAttemptStatus) -> anyhow::Result<CommittedFixture> {
        let root = tempfile::tempdir()?;
        let state = AppState::new(root.path());
        let id = state.session_id();
        let path = root.path().join(format!("{id}.jsonl"));
        state.with_history_path(&path);
        crate::history_index::journal::JournalFence::try_acquire(
            root.path(),
            crate::history_index::journal::JournalDomain::History,
        )?
        .activate()?;
        let identity = TurnAttemptIdentity {
            thread_id: id.clone(),
            turn_id: "original-turn".into(),
            attempt_id: "original-attempt".into(),
        };
        let directory = root.path().join(&id);
        let store = TurnAttemptStore::open(&directory, &id)?;
        store.begin(TurnAttemptRecord {
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })?;
        state
            .history_attempt_scope(identity.clone())?
            .run(async {
                state.add_message(Message::user_text("Original channel input"));
                if status == TurnAttemptStatus::Completed {
                    state.add_message(Message::assistant_text("Actual committed answer"));
                }
            })
            .await;
        state.flush_history().await?;
        let uuid = load_history(&path)?
            .last()
            .and_then(|entry| entry.uuid.clone())
            .unwrap();
        if status != TurnAttemptStatus::Accepted {
            store.finish(
                &identity,
                TurnAttemptCompletion {
                    status: status.clone(),
                    finished_at_ms: 2,
                    error: (status == TurnAttemptStatus::Failed)
                        .then(|| "controlled failure".into()),
                    provider_failure: None,
                    partial_output: if status == TurnAttemptStatus::Failed {
                        "UNCOMMITTED_PARTIAL_OUTPUT".into()
                    } else {
                        String::new()
                    },
                    partial_output_truncated: false,
                    committed_history_uuid: Some(uuid),
                },
            )?;
        }
        Ok((root, state, path, directory, identity))
    }

    #[tokio::test]
    async fn completed_checkpoint_compares_actual_new_state_and_preserves_original_records()
    -> anyhow::Result<()> {
        let (root, original, path, directory, identity) = committed().await?;
        let prepared = prepare_session_resume(&path)?;
        let proof = prepared
            .completed_attempt_history(&directory, &identity)
            .context("prepared original commit capture")?;
        let before = fs::read(&path)?;
        let restored = AppState::new(root.path());
        restored.apply_prepared_session_resume(prepared)?;
        assert!(!original.inspection_lifecycle_identity().matches(&restored));
        proof
            .verify_restored(&restored)
            .context("new State comparison")?;
        assert_eq!(proof.identity(), &identity);
        assert_eq!(fs::read(&path)?, before);
        let foreign = AppState::new(root.path());
        foreign.set_messages(restored.messages());
        assert!(proof.verify_restored(&foreign).is_err());
        restored.save_history()?;
        assert!(
            proof.verify_restored(&restored).is_err(),
            "A replacement rotates the original body generation even with identical visible text"
        );
        restored.add_message(Message::user_text("Later unrelated append"));
        assert!(proof.verify_restored(&restored).is_err());
        Ok(())
    }

    #[tokio::test]
    async fn completed_checkpoint_rejects_wrong_attempt_and_stale_prepared_source()
    -> anyhow::Result<()> {
        let (_root, original, path, directory, identity) = committed().await?;
        let prepared = prepare_session_resume(&path)?;
        let mut wrong = identity.clone();
        wrong.attempt_id = "foreign-attempt".into();
        assert!(
            prepared
                .completed_attempt_history(&directory, &wrong)
                .is_err()
        );
        original.add_message(Message::user_text("New committed user message"));
        original.flush_history().await?;
        assert!(
            prepared
                .completed_attempt_history(&directory, &identity)
                .is_err()
        );
        let current = prepare_session_resume(&path)?;
        assert!(
            current
                .completed_attempt_history(&directory, &identity)
                .is_err(),
            "A later ordinary row cannot be adopted as the old final commit"
        );
        Ok(())
    }

    #[tokio::test]
    async fn failed_committed_history_keeps_its_failure_without_replaying_or_starting_an_attempt()
    -> anyhow::Result<()> {
        let (root, _, path, directory, identity) =
            committed_outcome(TurnAttemptStatus::Failed).await?;
        let original_bytes = fs::read(&path)?;
        let prepared = prepare_session_resume(&path)?;
        assert!(
            prepared
                .completed_attempt_history(&directory, &identity)
                .is_err()
        );
        let proof = prepared.committed_terminal_attempt_history(&directory, &identity)?;
        let restored = AppState::new(root.path());
        restored.apply_prepared_session_resume(prepared)?;
        proof.verify_restored(&restored)?;
        let store = TurnAttemptStore::open_existing(&directory, &identity.thread_id)?.unwrap();
        assert_eq!(store.list()?.len(), 1);
        assert_eq!(
            store.load(&identity)?.unwrap().status,
            TurnAttemptStatus::Failed
        );
        assert_eq!(restored.messages().len(), 1);
        assert_eq!(fs::read(&path)?, original_bytes);
        Ok(())
    }

    #[tokio::test]
    async fn failed_committed_history_does_not_adopt_a_pending_or_interrupted_attempt()
    -> anyhow::Result<()> {
        for status in [TurnAttemptStatus::Accepted, TurnAttemptStatus::Interrupted] {
            let (_root, _, path, directory, identity) = committed_outcome(status).await?;
            let prepared = prepare_session_resume(&path)?;
            assert!(
                prepared
                    .committed_terminal_attempt_history(&directory, &identity)
                    .is_err()
            );
        }
        Ok(())
    }
}
