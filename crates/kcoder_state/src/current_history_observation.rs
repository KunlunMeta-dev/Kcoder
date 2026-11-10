//! Bounded, read-only matching against the actual current model message set.
//! This is not an observation of the durable transcript or an authorization.
use crate::{
    AppState, AppStateInner, AppStateLifecycleIdentity, MessageRevision, history_append_context,
    provenance_revision::Revision,
};
use anyhow::{Result, ensure};
use kcoder_types::{ContentBlock, Message, MessageOrigin, SharedMessages, TurnAttemptIdentity};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_LOCATORS: usize = 10;
const MAX_SCAN_MESSAGES: usize = 32_768;
const MAX_PROVENANCE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HistoryMessageLocator {
    pub history_uuid: String,
    pub attempt: TurnAttemptIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurrentHistoryUnknown {
    ScanLimit,
    IncompleteIdentity,
    DuplicateIdentity,
    AttemptMismatch,
    ScopeMismatch,
    NotUserInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurrentHistoryPresence {
    /// UUID and attempt match the current message identity. This alone does
    /// not prove the current payload equals the authoritative history entry.
    Present,
    /// Absent from this complete in-memory model-message snapshot only; this
    /// says nothing about durable transcript deletion or other sessions.
    NotRetained,
    Unknown(CurrentHistoryUnknown),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentHistoryEntry {
    pub locator: HistoryMessageLocator,
    pub presence: CurrentHistoryPresence,
    position: Option<usize>,
}

/// Message payloads remain shared with the immutable snapshot rather than
/// copied into a second context. Only the at-most-ten selected entries expose
/// a message; callers must recheck `is_current` before using the observation.
#[derive(Clone)]
pub struct CurrentHistoryObservation {
    session_id: String,
    lifecycle: AppStateLifecycleIdentity,
    revision: MessageRevision,
    provenance_digest: Option<[u8; 32]>,
    provenance_revision: Revision,
    messages: SharedMessages,
    entries: Vec<CurrentHistoryEntry>,
}
impl CurrentHistoryObservation {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn revision(&self) -> &MessageRevision {
        &self.revision
    }
    pub fn entries(&self) -> &[CurrentHistoryEntry] {
        &self.entries
    }
    pub fn message(&self, entry_index: usize) -> Option<&Message> {
        self.entries
            .get(entry_index)?
            .position
            .and_then(|position| self.messages.get(position))
    }
    /// Compare with an original native history message independently verified
    /// by the host. The caller must still recheck `is_current` at its gate.
    pub fn matches_original_message(&self, entry_index: usize, original: &Message) -> bool {
        self.message(entry_index)
            .is_some_and(|current| current == original)
    }
    /// Lifecycle and message revision are compared under the same State lock.
    /// A later mutation can still invalidate this after the method returns;
    /// execution needs the original host gate or a further atomic fence.
    pub fn is_current(&self, state: &AppState) -> bool {
        // A poisoned State cannot establish current provenance, even if its
        // recovered bytes happen to match the earlier observation.
        let Ok(inner) = state.inner.read() else {
            return false;
        };
        self.lifecycle.matches_locked(state, &inner)
            && inner.message_revision == self.revision
            && inner.provenance_revision() == self.provenance_revision
            && self
                .provenance_digest
                .is_some_and(|digest| provenance_digest(&inner) == Ok(digest))
    }

    /// Non-waiting O(1) gate check. A busy or poisoned lock and an initially
    /// incomplete observation return None; the host must treat it as unknown.
    pub fn try_is_current(&self, state: &AppState) -> Option<bool> {
        let inner = state.inner.try_read().ok()?;
        if !self.lifecycle.matches_locked(state, &inner) || inner.message_revision != self.revision
        {
            return Some(false);
        }
        self.provenance_digest?;
        Some(inner.provenance_revision() == self.provenance_revision)
    }
}

// MessageRevision alone tracks model content, while set_messages with equal
// content can still clear UUID/attempt associations. Hash those facts under
// the same lock so an old positive cannot survive a provenance-only change.
fn provenance_digest(
    inner: &AppStateInner,
) -> std::result::Result<[u8; 32], CurrentHistoryUnknown> {
    provenance_digest_with_budget(inner, MAX_SCAN_MESSAGES, MAX_PROVENANCE_BYTES)
}

fn provenance_digest_with_budget(
    inner: &AppStateInner,
    max_messages: usize,
    mut remaining_bytes: usize,
) -> std::result::Result<[u8; 32], CurrentHistoryUnknown> {
    if inner.messages.len() > max_messages || inner.message_history_ids.len() > max_messages {
        return Err(CurrentHistoryUnknown::ScanLimit);
    }
    fn text(
        hash: &mut Sha256,
        value: &str,
        remaining: &mut usize,
    ) -> std::result::Result<(), CurrentHistoryUnknown> {
        *remaining = remaining
            .checked_sub(value.len())
            .ok_or(CurrentHistoryUnknown::ScanLimit)?;
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
        Ok(())
    }
    let mut hash = Sha256::new();
    if !valid_history_id(&inner.session_id) {
        return Err(CurrentHistoryUnknown::IncompleteIdentity);
    }
    text(&mut hash, &inner.session_id, &mut remaining_bytes)?;
    hash.update((inner.messages.len() as u64).to_le_bytes());
    hash.update((inner.message_history_ids.len() as u64).to_le_bytes());
    for uuid in inner.message_history_ids.iter() {
        match uuid {
            None => hash.update([0]),
            Some(uuid) => {
                if !valid_history_id(uuid) {
                    return Err(CurrentHistoryUnknown::IncompleteIdentity);
                }
                hash.update([1]);
                text(&mut hash, uuid, &mut remaining_bytes)?;
                match inner.history_attempts.get_ref(uuid) {
                    None => hash.update([0]),
                    Some(attempt) => {
                        if !valid_attempt(attempt) || attempt.thread_id != inner.session_id {
                            return Err(CurrentHistoryUnknown::IncompleteIdentity);
                        }
                        hash.update([1]);
                        text(&mut hash, &attempt.thread_id, &mut remaining_bytes)?;
                        text(&mut hash, &attempt.turn_id, &mut remaining_bytes)?;
                        text(&mut hash, &attempt.attempt_id, &mut remaining_bytes)?;
                    }
                }
            }
        }
    }
    Ok(hash.finalize().into())
}

fn valid_history_id(value: &str) -> bool {
    value.len() <= 256 && !value.trim().is_empty() && !value.chars().any(char::is_control)
}

fn valid_attempt(attempt: &TurnAttemptIdentity) -> bool {
    [&attempt.thread_id, &attempt.turn_id, &attempt.attempt_id]
        .into_iter()
        .all(|value| valid_history_id(value))
}

fn could_be_user_input(message: &Message) -> bool {
    match message {
        Message::User { content, origin } => {
            !matches!(origin, MessageOrigin::Runtime | MessageOrigin::Compaction)
                && content
                    .iter()
                    .any(|block| !matches!(block, ContentBlock::ToolResult { .. }))
        }
        Message::Assistant { .. } => false,
    }
}

// Unknown provenance on a user-shaped message must stay ambiguous. Inspect
// only its origin here; traversing arbitrary content would hold the State
// lock for work unrelated to the bounded identity scan.
fn could_be_unidentified_user(message: &Message) -> bool {
    matches!(message, Message::User { origin, .. }
        if !matches!(origin, MessageOrigin::Runtime | MessageOrigin::Compaction))
}

impl AppState {
    /// Observe only the requested exact native UUID/attempt locators. No
    /// history is created, refreshed, rewritten or matched by message text.
    pub fn observe_current_history_messages(
        &self,
        expected_session: &str,
        locators: &[HistoryMessageLocator],
    ) -> Result<CurrentHistoryObservation> {
        self.observe_current_history(expected_session, locators, false)
    }

    /// Check exact original user-input identities. Typed runtime/compaction
    /// messages and assistants cannot be user input. A user-shaped message
    /// without its original identity remains unknown without scanning payloads.
    /// NotRetained never claims a summary lacks related content.
    pub fn observe_current_history_user_inputs(
        &self,
        expected_session: &str,
        locators: &[HistoryMessageLocator],
    ) -> Result<CurrentHistoryObservation> {
        self.observe_current_history(expected_session, locators, true)
    }

    fn observe_current_history(
        &self,
        expected_session: &str,
        locators: &[HistoryMessageLocator],
        user_inputs_only: bool,
    ) -> Result<CurrentHistoryObservation> {
        ensure!(
            expected_session.len() <= 256 && !expected_session.trim().is_empty(),
            "CURRENT_HISTORY_SESSION_INVALID"
        );
        ensure!(
            locators.len() <= MAX_LOCATORS,
            "CURRENT_HISTORY_LOCATOR_LIMIT"
        );
        let mut requested = HashSet::new();
        for locator in locators {
            ensure!(
                locator.history_uuid.len() <= 256
                    && !locator.history_uuid.trim().is_empty()
                    && !locator.history_uuid.chars().any(char::is_control),
                "CURRENT_HISTORY_UUID_INVALID"
            );
            ensure!(
                valid_attempt(&locator.attempt),
                "CURRENT_HISTORY_ATTEMPT_INVALID"
            );
            locator.attempt.validate().map_err(anyhow::Error::msg)?;
            ensure!(
                requested.insert(locator.history_uuid.as_str()),
                "CURRENT_HISTORY_DUPLICATE_REQUEST"
            );
        }
        let inner = self
            .inner
            .read()
            .map_err(|_| anyhow::anyhow!("CURRENT_HISTORY_STATE_UNAVAILABLE"))?;
        ensure!(
            inner.session_id == expected_session,
            "CURRENT_HISTORY_SESSION_MISMATCH"
        );
        let lifecycle = history_append_context::lifecycle_identity_locked(self, &inner);
        let revision = inner.message_revision.clone();
        let digest = provenance_digest(&inner);
        let scan_failure = digest
            .as_ref()
            .err()
            .copied()
            .unwrap_or(CurrentHistoryUnknown::ScanLimit);
        let provenance_digest = digest.ok();
        let provenance_revision = inner.provenance_revision();
        let messages = inner.messages.clone();
        let mut found: HashMap<&str, Option<usize>> = HashMap::new();
        let mut complete_identity = inner.message_history_ids.len() == messages.len();
        let mut complete_user_identity = complete_identity;
        let within_budget = messages.len() <= MAX_SCAN_MESSAGES && provenance_digest.is_some();
        if within_budget && complete_identity {
            let mut all_seen = HashSet::new();
            for (index, uuid) in inner.message_history_ids.iter().enumerate() {
                let Some(uuid) = uuid.as_deref() else {
                    complete_identity = false;
                    if messages.get(index).is_some_and(could_be_unidentified_user) {
                        complete_user_identity = false;
                    }
                    continue;
                };
                if !all_seen.insert(uuid) {
                    complete_identity = false;
                    complete_user_identity = false;
                }
                if inner.history_attempts.get_ref(uuid).is_none() {
                    complete_identity = false;
                    if messages.get(index).is_some_and(could_be_unidentified_user) {
                        complete_user_identity = false;
                    }
                }
                if requested.contains(uuid) {
                    found
                        .entry(uuid)
                        .and_modify(|position| *position = None)
                        .or_insert(Some(index));
                }
            }
        }
        let entries = locators
            .iter()
            .map(|locator| {
                let (presence, position) = if locator.attempt.thread_id != inner.session_id {
                    (
                        CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::ScopeMismatch),
                        None,
                    )
                } else if !within_budget {
                    (CurrentHistoryPresence::Unknown(scan_failure), None)
                } else if inner.message_history_ids.len() != messages.len() {
                    (
                        CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity),
                        None,
                    )
                } else {
                    match found.get(locator.history_uuid.as_str()) {
                        Some(Some(position))
                            if user_inputs_only
                                && !messages.get(*position).is_some_and(could_be_user_input) =>
                        {
                            (
                                CurrentHistoryPresence::Unknown(
                                    CurrentHistoryUnknown::NotUserInput,
                                ),
                                None,
                            )
                        }
                        Some(Some(position)) => {
                            match inner.history_attempts.get_ref(&locator.history_uuid) {
                                Some(actual) if actual == &locator.attempt => {
                                    (CurrentHistoryPresence::Present, Some(*position))
                                }
                                Some(_) => (
                                    CurrentHistoryPresence::Unknown(
                                        CurrentHistoryUnknown::AttemptMismatch,
                                    ),
                                    None,
                                ),
                                None => (
                                    CurrentHistoryPresence::Unknown(
                                        CurrentHistoryUnknown::IncompleteIdentity,
                                    ),
                                    None,
                                ),
                            }
                        }
                        Some(None) => (
                            CurrentHistoryPresence::Unknown(
                                CurrentHistoryUnknown::DuplicateIdentity,
                            ),
                            None,
                        ),
                        None if (!user_inputs_only && complete_identity)
                            || (user_inputs_only && complete_user_identity) =>
                        {
                            (CurrentHistoryPresence::NotRetained, None)
                        }
                        None => (
                            CurrentHistoryPresence::Unknown(
                                CurrentHistoryUnknown::IncompleteIdentity,
                            ),
                            None,
                        ),
                    }
                };
                CurrentHistoryEntry {
                    locator: locator.clone(),
                    presence,
                    position,
                }
            })
            .collect();
        Ok(CurrentHistoryObservation {
            session_id: inner.session_id.clone(),
            lifecycle,
            revision,
            provenance_digest,
            provenance_revision,
            messages,
            entries,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    fn identity(state: &AppState, attempt_id: &str) -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "turn".into(),
            attempt_id: attempt_id.into(),
        }
    }
    fn locator(uuid: &str, attempt: &TurnAttemptIdentity) -> HistoryMessageLocator {
        HistoryMessageLocator {
            history_uuid: uuid.into(),
            attempt: attempt.clone(),
        }
    }

    #[tokio::test]
    async fn matched_native_identity_uses_one_snapshot_and_invalidates_after_change() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let original = identity(&state, "attempt-1");
        state
            .history_attempt_scope(original.clone())?
            .run(async {
                state.add_message(Message::user_text("original user message"));
            })
            .await;
        let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
        let observed = state.observe_current_history_messages(
            &state.session_id(),
            &[locator(&uuid, &original), locator("other-uuid", &original)],
        )?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Present
        );
        assert_eq!(
            observed.message(0),
            Some(&Message::user_text("original user message"))
        );
        assert_eq!(
            observed.entries()[1].presence,
            CurrentHistoryPresence::NotRetained
        );
        assert!(observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), Some(true));
        let wrong = state.observe_current_history_messages(
            &state.session_id(),
            &[locator(&uuid, &identity(&state, "different"))],
        )?;
        assert_eq!(
            wrong.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::AttemptMismatch)
        );
        assert!(wrong.message(0).is_none());
        let other_state = AppState::new(temp.path());
        assert!(!observed.is_current(&other_state));
        let original_revision = state.message_revision();
        state.set_messages(state.messages());
        assert_eq!(state.message_revision(), original_revision);
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), Some(false));
        let cleared = state
            .observe_current_history_messages(&state.session_id(), &[locator(&uuid, &original)])?;
        assert_eq!(
            cleared.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        state.add_message(Message::user_text("later change"));
        assert!(!observed.is_current(&state));
        assert_eq!(
            observed.message(0),
            Some(&Message::user_text("original user message"))
        );
        Ok(())
    }

    #[test]
    fn nonblocking_gate_check_handles_contention_and_large_stable_provenance() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::with_messages(temp.path(), vec![Message::user_text("original")]);
        let observed = state.observe_current_history_messages(&state.session_id(), &[])?;
        assert_eq!(observed.try_is_current(&state), Some(true));
        let held = state.inner.write().unwrap();
        assert_eq!(observed.try_is_current(&state), None);
        drop(held);
        state.add_message(Message::user_text("changed"));
        assert_eq!(observed.try_is_current(&state), Some(false));

        let large =
            AppState::with_messages(temp.path(), vec![Message::user_text("message"); 5_000]);
        let large_observation = large.observe_current_history_messages(&large.session_id(), &[])?;
        assert!(large_observation.is_current(&large));
        assert_eq!(large_observation.try_is_current(&large), Some(true));
        Ok(())
    }

    #[tokio::test]
    async fn provenance_revision_rejects_direct_change_and_old_ids_reinserted_after_unlock()
    -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let attempt = identity(&state, "attempt");
        state
            .history_attempt_scope(attempt.clone())?
            .run(async {
                state.add_message(Message::user_text("original"));
            })
            .await;
        let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
        let observed = state
            .observe_current_history_messages(&state.session_id(), &[locator(&uuid, &attempt)])?;
        assert_eq!(observed.try_is_current(&state), Some(true));
        // A non-provenance write must not invalidate a stable observation.
        state.write_inner().session_updated_at_ms += 1;
        assert_eq!(observed.try_is_current(&state), Some(true));
        let original_ids = {
            let mut inner = state.inner.write().unwrap();
            let replacement = vec![None; inner.message_history_ids.len()].into();
            std::mem::replace(&mut inner.message_history_ids, replacement)
        };
        assert_eq!(observed.try_is_current(&state), Some(false));
        state.inner.write().unwrap().message_history_ids = original_ids;
        // The bytes match again, but a held old revision must never revive.
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), Some(false));
        Ok(())
    }

    #[test]
    fn poisoned_direct_writer_still_advances_provenance_and_never_authorizes_try_read() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let session_id = state.session_id();
        let observed = state.observe_current_history_messages(&session_id, &[])?;
        let before = state.read_inner().provenance_revision();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut inner = state.inner.write().unwrap();
            inner.message_history_ids.push(None);
            panic!("intentional provenance poison fixture");
        }));
        let after = state.read_inner().provenance_revision();
        assert_ne!(before, after);
        assert_eq!(observed.try_is_current(&state), None);
        Ok(())
    }

    #[test]
    fn poisoned_unchanged_state_cannot_authorize_either_observation_path() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let session_id = state.session_id();
        let observed = state.observe_current_history_messages(&session_id, &[])?;
        assert!(observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), Some(true));
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _inner = state.inner.write().unwrap();
            panic!("intentional unchanged State poison fixture");
        }));
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), None);
        assert!(
            state
                .observe_current_history_messages(&session_id, &[])
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn saving_unchanged_history_does_not_invalidate_provenance() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let path = temp.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(Message::user_text("original"));
        let observed = state.observe_current_history_messages(&state.session_id(), &[])?;
        assert_eq!(observed.try_is_current(&state), Some(true));
        state.save_history()?;
        assert_eq!(observed.try_is_current(&state), Some(true));
        Ok(())
    }

    #[test]
    fn concurrent_direct_provenance_write_is_unknown_then_invalidates() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let observed = state.observe_current_history_messages(&state.session_id(), &[])?;
        std::thread::scope(|threads| -> Result<()> {
            let (locked_tx, locked_rx) = std::sync::mpsc::channel();
            let (resume_tx, resume_rx) = std::sync::mpsc::channel();
            let state_ref = &state;
            let worker = threads.spawn(move || -> Result<()> {
                let mut inner = state_ref
                    .inner
                    .write()
                    .map_err(|_| anyhow::anyhow!("poisoned test state"))?;
                locked_tx.send(())?;
                resume_rx.recv_timeout(std::time::Duration::from_secs(5))?;
                inner.message_history_ids.push(None);
                Ok(())
            });
            let locked = locked_rx.recv_timeout(std::time::Duration::from_secs(5));
            let during = observed.try_is_current(&state);
            let _ = resume_tx.send(());
            let completed = worker.join().expect("owned provenance writer panicked");
            locked?;
            completed?;
            assert_eq!(during, None);
            assert_eq!(observed.try_is_current(&state), Some(false));
            Ok(())
        })?;
        Ok(())
    }

    #[tokio::test]
    async fn committed_long_history_keeps_exact_attempts_with_constant_gate_revision() -> Result<()>
    {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let path = temp.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        let attempt = identity(&state, "long-attempt");
        state
            .history_attempt_scope(attempt.clone())?
            .run(async {
                for number in 0..5_000 {
                    state.add_message(Message::user_text(format!("native message {number}")));
                }
            })
            .await;
        state.flush_history().await?;
        let durable = crate::load_history(&path)?;
        assert_eq!(durable.len(), 5_000);
        let first = durable[0]
            .uuid
            .as_ref()
            .context("first UUID missing")?
            .clone();
        let last = durable[4_999]
            .uuid
            .as_ref()
            .context("last UUID missing")?
            .clone();
        assert_eq!(durable[0].history_attempt.as_ref(), Some(&attempt));
        assert_eq!(durable[4_999].history_attempt.as_ref(), Some(&attempt));
        let observed = state.observe_current_history_user_inputs(
            &state.session_id(),
            &[locator(&first, &attempt), locator(&last, &attempt)],
        )?;
        assert!(
            observed
                .entries()
                .iter()
                .all(|entry| entry.presence == CurrentHistoryPresence::Present)
        );
        for _ in 0..1_000 {
            assert_eq!(observed.try_is_current(&state), Some(true));
        }
        state.set_messages(state.messages());
        assert_eq!(observed.try_is_current(&state), Some(false));
        Ok(())
    }

    #[tokio::test]
    async fn real_background_notification_invalidates_once_not_on_duplicate() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let path = temp.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        let mut task = crate::Task::new("agent", "test");
        task.kind = crate::TaskKind::Subagent;
        task.status = crate::TaskStatus::Running;
        state.upsert_task(task);
        let event =
            kcoder_types::BackgroundEventIdentity::terminal(state.begin_background_run("agent")?);
        state.commit_background_terminal(&event, crate::TaskStatus::Completed, None)?;
        let before = state.observe_current_history_messages(&state.session_id(), &[])?;
        assert_eq!(before.try_is_current(&state), Some(true));
        assert!(
            state
                .deliver_background_notification(&event, Message::user_text("done"))
                .await?
        );
        assert_eq!(before.try_is_current(&state), Some(false));
        let after = state.observe_current_history_messages(&state.session_id(), &[])?;
        assert!(
            !state
                .deliver_background_notification(&event, Message::user_text("done"))
                .await?
        );
        assert_eq!(after.try_is_current(&state), Some(true));
        Ok(())
    }

    #[test]
    fn importing_equal_message_content_still_invalidates_original_provenance() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        state.add_message(Message::user_text("original"));
        let snapshot_path = temp.path().join("owned-import.json");
        std::fs::write(&snapshot_path, serde_json::to_vec(&state.snapshot())?)?;
        let before = state.observe_current_history_messages(&state.session_id(), &[])?;
        assert_eq!(before.try_is_current(&state), Some(true));
        assert_eq!(state.import_snapshot(&snapshot_path)?, 1);
        assert_eq!(state.messages(), vec![Message::user_text("original")]);
        assert_eq!(before.try_is_current(&state), Some(false));
        Ok(())
    }

    #[test]
    fn missing_compacted_and_duplicate_identities_stay_unknown() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::with_messages(temp.path(), vec![Message::user_text("same text")]);
        let original = identity(&state, "attempt");
        let unknown = state.observe_current_history_messages(
            &state.session_id(),
            &[locator("unknown-uuid", &original)],
        )?;
        assert_eq!(
            unknown.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        let unknown_user = state.observe_current_history_user_inputs(
            &state.session_id(),
            &[locator("unknown-uuid", &original)],
        )?;
        assert_eq!(
            unknown_user.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        assert!(unknown.message(0).is_none());
        assert!(
            state
                .observe_current_history_messages(
                    &state.session_id(),
                    &[locator("same", &original), locator("same", &original)]
                )
                .is_err()
        );
        {
            let mut inner = state.write_inner();
            inner.message_history_ids.clear();
        }
        let malformed = state.observe_current_history_messages(
            &state.session_id(),
            &[locator("unknown-uuid", &original)],
        )?;
        assert_eq!(
            malformed.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        Ok(())
    }

    #[test]
    fn user_message_with_no_original_attempt_does_not_prove_absence() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::with_messages(temp.path(), vec![Message::user_text("legacy input")]);
        state.write_inner().message_history_ids[0] = Some("unverified-id".into());
        let requested = locator("original-id", &identity(&state, "attempt"));
        let unknown =
            state.observe_current_history_user_inputs(&state.session_id(), &[requested])?;
        assert_eq!(
            unknown.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );

        let state = AppState::with_messages(temp.path(), vec![Message::runtime_text("runtime")]);
        state.write_inner().message_history_ids[0] = Some("runtime-id".into());
        let requested = locator("original-id", &identity(&state, "attempt"));
        let absent =
            state.observe_current_history_user_inputs(&state.session_id(), &[requested])?;
        assert_eq!(
            absent.entries()[0].presence,
            CurrentHistoryPresence::NotRetained
        );

        let message = Message::User {
            origin: MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "legacy".into(),
                content: Vec::new(),
                is_error: None,
            }],
        };
        let state = AppState::with_messages(temp.path(), vec![message]);
        let requested = locator("original-id", &identity(&state, "attempt"));
        let unknown =
            state.observe_current_history_user_inputs(&state.session_id(), &[requested])?;
        assert_eq!(
            unknown.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        Ok(())
    }

    #[tokio::test]
    async fn duplicate_uuid_never_proves_a_current_message() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let original = identity(&state, "attempt");
        state
            .history_attempt_scope(original.clone())?
            .run(async {
                state.add_message(Message::user_text("first"));
            })
            .await;
        let uuid = {
            let mut inner = state.write_inner();
            let uuid = inner.message_history_ids[0].clone().unwrap();
            inner.messages.push(Message::user_text("second"));
            inner.message_history_ids.push(Some(uuid.clone()));
            inner.message_revision = MessageRevision::default();
            uuid
        };
        let observed = state
            .observe_current_history_messages(&state.session_id(), &[locator(&uuid, &original)])?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::DuplicateIdentity)
        );
        assert!(observed.message(0).is_none());
        Ok(())
    }

    #[tokio::test]
    async fn real_compaction_distinguishes_typed_summary_from_original_user_inputs() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let path = temp.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        let original_attempt = identity(&state, "attempt");
        state
            .history_attempt_scope(original_attempt.clone())?
            .run(async {
                state.add_message(Message::user_text("original unique requirement"));
                state.add_message(Message::assistant_text("earlier response"));
                state.add_message(Message::user_text("recent retained request"));
            })
            .await;
        state.flush_history().await?;
        let (original_uuid, recent_uuid) = {
            let inner = state.read_inner();
            (
                inner.message_history_ids[0].clone().unwrap(),
                inner.message_history_ids[2].clone().unwrap(),
            )
        };
        let observed_before_compaction =
            state.observe_current_history_messages(&state.session_id(), &[])?;
        let before = std::fs::read(&path)?;
        state
            .set_messages_after_compaction(
                vec![
                    Message::compaction_text("trusted summary"),
                    Message::user_text("recent retained request"),
                ],
                crate::CompactionTranscriptEvent {
                    trigger: crate::CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 40,
                    summary: "trusted summary".into(),
                },
            )
            .await?;
        assert_eq!(
            observed_before_compaction.try_is_current(&state),
            Some(false)
        );
        assert!(!observed_before_compaction.is_current(&state));
        state.flush_history().await?;
        assert!(std::fs::read(&path)?.starts_with(&before));
        let locators = [
            locator(&original_uuid, &original_attempt),
            locator(&recent_uuid, &original_attempt),
        ];
        let generic = state.observe_current_history_messages(&state.session_id(), &locators)?;
        assert_eq!(
            generic.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        let user_inputs =
            state.observe_current_history_user_inputs(&state.session_id(), &locators)?;
        assert_eq!(
            user_inputs.entries()[0].presence,
            CurrentHistoryPresence::NotRetained
        );
        assert_eq!(
            user_inputs.entries()[1].presence,
            CurrentHistoryPresence::Present
        );
        assert!(user_inputs.message(0).is_none());
        assert_eq!(
            user_inputs.message(1),
            Some(&Message::user_text("recent retained request"))
        );
        assert!(user_inputs.is_current(&state));
        Ok(())
    }

    #[tokio::test]
    async fn unchanged_uuid_and_attempt_do_not_hide_a_rewritten_message() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let original_attempt = identity(&state, "attempt");
        let original_message = Message::user_text("original requirement");
        state
            .history_attempt_scope(original_attempt.clone())?
            .run(async {
                state.add_message(original_message.clone());
            })
            .await;
        let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
        state
            .set_messages_preserving_history_ids(vec![Message::user_text("rewritten requirement")]);
        let observed = state.observe_current_history_user_inputs(
            &state.session_id(),
            &[locator(&uuid, &original_attempt)],
        )?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Present
        );
        assert!(!observed.matches_original_message(0, &original_message));
        assert!(observed.is_current(&state));
        Ok(())
    }

    #[test]
    fn scan_budget_exhaustion_never_proves_absence() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let messages = (0..=MAX_SCAN_MESSAGES)
            .map(|_| Message::user_text("x"))
            .collect();
        let state = AppState::with_messages(temp.path(), messages);
        let observed = state.observe_current_history_messages(
            &state.session_id(),
            &[locator("unknown", &identity(&state, "attempt"))],
        )?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::ScanLimit)
        );
        Ok(())
    }

    #[test]
    fn oversized_uuid_and_cumulative_identity_bytes_are_unknown() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let state = AppState::with_messages(temp.path(), vec![Message::assistant_text("record")]);
        state.write_inner().message_history_ids[0] = Some("x".repeat(MAX_PROVENANCE_BYTES + 1));
        let requested = locator("unknown", &identity(&state, "attempt"));
        let observed = state.observe_current_history_messages(&state.session_id(), &[requested])?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), None);

        let state = AppState::with_messages(temp.path(), vec![Message::user_text("unverified")]);
        state.write_inner().message_history_ids[0] = Some("   ".into());
        let requested = locator("unknown", &identity(&state, "attempt"));
        let observed =
            state.observe_current_history_user_inputs(&state.session_id(), &[requested])?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::IncompleteIdentity)
        );
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), None);

        let messages = vec![Message::assistant_text("record"); MAX_SCAN_MESSAGES];
        let state = AppState::with_messages(temp.path(), messages);
        let suffix = "x".repeat(248);
        state.write_inner().message_history_ids = (0..MAX_SCAN_MESSAGES)
            .map(|index| Some(format!("{index:08}{suffix}")))
            .collect::<Vec<_>>()
            .into();
        let requested = locator("unknown", &identity(&state, "attempt"));
        let observed = state.observe_current_history_messages(&state.session_id(), &[requested])?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Unknown(CurrentHistoryUnknown::ScanLimit)
        );
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), None);
        Ok(())
    }

    #[tokio::test]
    async fn large_text_and_image_are_not_charged_to_identity_budget() -> Result<()> {
        use kcoder_types::ImageSource;
        let temp = tempfile::tempdir()?;
        let state = AppState::new(temp.path());
        let attempt = identity(&state, "large-message-attempt");
        let message = Message::user_content(vec![
            ContentBlock::Text {
                text: "x".repeat(MAX_PROVENANCE_BYTES + 1),
            },
            ContentBlock::Image {
                source: ImageSource::base64("image/png", "a".repeat(MAX_PROVENANCE_BYTES + 4)),
            },
        ]);
        state
            .history_attempt_scope(attempt.clone())?
            .run(async {
                state.add_message(message.clone());
            })
            .await;
        let uuid = state.read_inner().message_history_ids[0]
            .clone()
            .context("UUID missing")?;
        let observed = state.observe_current_history_user_inputs(
            &state.session_id(),
            &[locator(&uuid, &attempt)],
        )?;
        assert_eq!(
            observed.entries()[0].presence,
            CurrentHistoryPresence::Present
        );
        assert!(observed.matches_original_message(0, &message));
        assert!(observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), Some(true));
        Ok(())
    }
}
