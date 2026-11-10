//! Attempt attribution belongs to the task that actually appends a new history UUID.

use crate::{AppState, AppStateIdentity, AppStateInner, HistoryEntry};
use kcoder_types::TurnAttemptIdentity;
use std::{collections::HashMap, future::Future, sync::Arc};

tokio::task_local! {
    static APPEND_SCOPE: HistoryAppendScope;
}

/// An exact State/session binding, not a process-wide current attempt. Child
/// tasks do not inherit this scope; a different State can never borrow it.
pub struct HistoryAppendScope {
    state: AppStateIdentity,
    session_epoch: Arc<()>,
    identity: TurnAttemptIdentity,
}

/// Opaque native lifecycle identity. It proves no authorization by itself.
#[derive(Clone)]
pub struct AppStateLifecycleIdentity {
    state: AppStateIdentity,
    session_id: String,
    epoch: Arc<()>,
}

impl std::fmt::Debug for AppStateLifecycleIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AppStateLifecycleIdentity(..)")
    }
}

/// A nonblocking observation under the same State lock as session replacement.
pub enum TryLifecycleAccess<T> {
    Busy,
    Changed,
    Unavailable,
    Current(T),
}

/// Distinguishes a missing task scope from a scope owned by another State.
pub enum ScopedLifecycleIdentity {
    Absent,
    Matching(AppStateLifecycleIdentity),
    Foreign,
}
impl AppStateLifecycleIdentity {
    pub(super) fn matches_identity_locked(
        &self,
        state: &AppStateIdentity,
        inner: &AppStateInner,
    ) -> bool {
        std::sync::Weak::ptr_eq(&self.state.0, &state.0)
            && self.session_id == inner.session_id
            && Arc::ptr_eq(&self.epoch, &inner.history_attempts.epoch)
    }
    /// Compare two captured identities without treating them as an authorization
    /// or a substitute for checking the live State and its current execution gate.
    /// Expired identities never match, even if they came from the same old State.
    pub fn same_lifecycle(&self, other: &Self) -> bool {
        self.state.is_alive()
            && other.state.is_alive()
            && std::sync::Weak::ptr_eq(&self.state.0, &other.state.0)
            && self.session_id == other.session_id
            && Arc::ptr_eq(&self.epoch, &other.epoch)
    }

    /// Return unknown when the original State is busy or poisoned.
    pub fn try_matches(&self, state: &AppState) -> Option<bool> {
        state.try_check_lifecycle_identity(self).ok().flatten()
    }

    pub fn matches(&self, state: &AppState) -> bool {
        let inner = state.read_inner();
        self.matches_locked(state, &inner)
    }

    /// Compare the original lifecycle and the effective session lease target
    /// under one nonblocking State read. This is an in-process observation,
    /// not proof that a filesystem path or an external authority is current.
    pub fn try_matches_session_lease_target(
        &self,
        state: &AppState,
        session_storage_root: &std::path::Path,
        expected_target: &std::path::Path,
    ) -> TryLifecycleAccess<()> {
        let inner = match state.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return TryLifecycleAccess::Busy,
            Err(std::sync::TryLockError::Poisoned(_)) => return TryLifecycleAccess::Unavailable,
        };
        if !self.matches_locked(state, &inner) {
            return TryLifecycleAccess::Changed;
        }
        let matches = match inner.history_path.as_deref() {
            Some(path) => path == expected_target,
            None => {
                let artifact_id = inner
                    .session_artifact_override
                    .as_ref()
                    .map(|location| location.session_id.as_str())
                    .unwrap_or(&inner.session_id);
                crate::session_dir_path(session_storage_root, artifact_id).join("session")
                    == expected_target
            }
        };
        if matches {
            TryLifecycleAccess::Current(())
        } else {
            TryLifecycleAccess::Changed
        }
    }

    pub(super) fn matches_locked(&self, state: &AppState, inner: &AppStateInner) -> bool {
        self.state.matches(state)
            && self.session_id == inner.session_id
            && Arc::ptr_eq(&self.epoch, &inner.history_attempts.epoch)
    }
}

impl HistoryAppendScope {
    /// The State lifecycle captured when this scope was created. This is an
    /// observation only; it does not prove that an attempt was accepted or
    /// authorize a later operation.
    pub fn lifecycle_identity(&self) -> AppStateLifecycleIdentity {
        AppStateLifecycleIdentity {
            state: self.state.clone(),
            session_id: self.identity.thread_id.clone(),
            epoch: Arc::clone(&self.session_epoch),
        }
    }

    /// Verify the original native State epoch inside its actual task-local scope.
    pub fn matches_current(&self, state: &AppState) -> bool {
        let inner = state.read_inner();
        self.state.matches(state)
            && Arc::ptr_eq(&self.session_epoch, &inner.history_attempts.epoch)
            && current(state, &inner).as_ref() == Some(&self.identity)
    }
    pub async fn run<F: Future>(self, future: F) -> F::Output {
        APPEND_SCOPE.scope(self, future).await
    }
}

impl AppState {
    /// Run only a nonblocking in-memory action while the exact lifecycle is current.
    /// The callback must not access State, wait on another lock, or perform I/O.
    pub fn try_with_lifecycle<T>(
        &self,
        owner: &AppStateLifecycleIdentity,
        action: impl FnOnce() -> T,
    ) -> TryLifecycleAccess<T> {
        let inner = match self.inner.try_read() {
            Ok(inner) => inner,
            Err(std::sync::TryLockError::WouldBlock) => return TryLifecycleAccess::Busy,
            Err(std::sync::TryLockError::Poisoned(_)) => return TryLifecycleAccess::Unavailable,
        };
        if !owner.matches_locked(self, &inner) {
            return TryLifecycleAccess::Changed;
        }
        TryLifecycleAccess::Current(action())
    }

    /// Capture a shared message snapshot and its exact native owner together.
    pub fn shared_messages_with_lifecycle(
        &self,
    ) -> (
        kcoder_types::SharedMessages,
        crate::MessageRevision,
        AppStateLifecycleIdentity,
    ) {
        let inner = self.read_inner();
        (
            inner.messages.clone(),
            inner.message_revision.clone(),
            lifecycle_identity_locked(self, &inner),
        )
    }

    pub fn inspection_lifecycle_identity(&self) -> AppStateLifecycleIdentity {
        let inner = self.read_inner();
        lifecycle_identity_locked(self, &inner)
    }

    /// Observe the current lifecycle without blocking a runtime thread.
    /// A busy or poisoned state provides no witness.
    pub fn try_inspection_lifecycle_identity(&self) -> Option<AppStateLifecycleIdentity> {
        let inner = self.inner.try_read().ok()?;
        Some(lifecycle_identity_locked(self, &inner))
    }

    /// Compare a previously captured native owner without blocking. Busy is
    /// distinct from a changed lifecycle and from a poisoned State lock.
    pub fn try_check_lifecycle_identity(
        &self,
        owner: &AppStateLifecycleIdentity,
    ) -> anyhow::Result<Option<bool>> {
        match self.inner.try_read() {
            Ok(inner) => Ok(Some(owner.matches_locked(self, &inner))),
            Err(std::sync::TryLockError::WouldBlock) => Ok(None),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                anyhow::bail!("lifecycle state is unavailable")
            }
        }
    }

    /// Reuse the native lifecycle captured when the current task's original
    /// attempt was accepted. The State must still check it under its lock.
    pub fn current_scoped_lifecycle_identity(&self) -> ScopedLifecycleIdentity {
        APPEND_SCOPE
            .try_with(|scope| {
                if scope.state.matches(self) {
                    ScopedLifecycleIdentity::Matching(AppStateLifecycleIdentity {
                        state: scope.state.clone(),
                        session_id: scope.identity.thread_id.clone(),
                        epoch: scope.session_epoch.clone(),
                    })
                } else {
                    ScopedLifecycleIdentity::Foreign
                }
            })
            .unwrap_or(ScopedLifecycleIdentity::Absent)
    }
    /// Presentation copies paired with UUID-bound native web observations.
    pub fn messages_with_web_sources(
        &self,
    ) -> Vec<(
        kcoder_types::Message,
        Vec<kcoder_types::web_sources::WebSourcesV1>,
    )> {
        let inner = self.read_inner();
        inner
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| {
                (
                    message.clone(),
                    inner
                        .message_history_ids
                        .get(index)
                        .and_then(Option::as_deref)
                        .map(|uuid| inner.history_attempts.sources(uuid))
                        .unwrap_or_default(),
                )
            })
            .collect()
    }
    /// Return only the active task-local identity for this State and its current epoch.
    pub fn current_history_attempt_identity(&self) -> Option<TurnAttemptIdentity> {
        let inner = self.read_inner();
        current(self, &inner)
    }
    /// Compare the real task-local identity without allocating a cloned TI.
    /// None remains unknown; this predicate grants no execution authority.
    pub fn matches_current_history_attempt(&self, identity: Option<&TurnAttemptIdentity>) -> bool {
        let inner = self.read_inner();
        APPEND_SCOPE
            .try_with(|scope| {
                let current = scope.state.matches(self)
                    && scope.identity.thread_id == inner.session_id
                    && Arc::ptr_eq(&scope.session_epoch, &inner.history_attempts.epoch);
                match identity {
                    Some(identity) => current && &scope.identity == identity,
                    None => !current,
                }
            })
            .unwrap_or(identity.is_none())
    }
    pub fn history_attempt_scope(
        &self,
        identity: TurnAttemptIdentity,
    ) -> anyhow::Result<HistoryAppendScope> {
        identity.validate().map_err(anyhow::Error::msg)?;
        let inner = self.read_inner();
        anyhow::ensure!(
            identity.thread_id == inner.session_id,
            "history attempt session differs"
        );
        Ok(HistoryAppendScope {
            state: self.inspection_identity(),
            session_epoch: inner.history_attempts.epoch.clone(),
            identity,
        })
    }
}

pub(super) fn lifecycle_identity_locked(
    state: &AppState,
    inner: &AppStateInner,
) -> AppStateLifecycleIdentity {
    lifecycle_identity_from_identity_locked(state.inspection_identity(), inner)
}

pub(super) fn lifecycle_identity_from_identity_locked(
    state: AppStateIdentity,
    inner: &AppStateInner,
) -> AppStateLifecycleIdentity {
    AppStateLifecycleIdentity {
        state,
        session_id: inner.session_id.clone(),
        epoch: inner.history_attempts.epoch.clone(),
    }
}

pub(super) fn current(state: &AppState, inner: &AppStateInner) -> Option<TurnAttemptIdentity> {
    APPEND_SCOPE
        .try_with(|scope| {
            (scope.state.matches(state)
                && scope.identity.thread_id == inner.session_id
                && Arc::ptr_eq(&scope.session_epoch, &inner.history_attempts.epoch))
            .then(|| scope.identity.clone())
        })
        .ok()
        .flatten()
}

/// UUID-keyed metadata for retained model rows. Never associate rewritten rows
/// by their position or by the currently running attempt.
#[derive(Debug, Default)]
pub(super) struct HistoryAppendMetadata {
    epoch: Arc<()>,
    records: crate::provenance_revision::Tracked<HashMap<String, Option<TurnAttemptIdentity>>>,
    web_sources: HashMap<String, Vec<kcoder_types::web_sources::WebSourcesV1>>,
}
impl HistoryAppendMetadata {
    pub(super) fn from_entries(entries: &[HistoryEntry], session_id: &str) -> Self {
        let mut metadata = Self::default();
        // Build an unshared map once; no observation can exist until the
        // completed metadata is installed under the State write guard.
        let mut records: HashMap<String, Option<TurnAttemptIdentity>> = HashMap::new();
        for entry in entries {
            let Some(uuid) = &entry.uuid else { continue };
            let identity = entry.history_attempt.clone().filter(|identity| {
                identity.validate().is_ok()
                    && identity.thread_id == entry.session_id
                    && entry.session_id == session_id
            });
            if entry.session_id == session_id
                && identity.is_some()
                && (!entry.web_sources.is_empty() || metadata.web_sources.contains_key(uuid))
            {
                metadata
                    .web_sources
                    .entry(uuid.clone())
                    .and_modify(|old| {
                        if *old != entry.web_sources {
                            old.clear();
                        }
                    })
                    .or_insert_with(|| entry.web_sources.clone());
            }
            records
                .entry(uuid.clone())
                .and_modify(|old| {
                    if *old != identity {
                        *old = None;
                    }
                })
                .or_insert(identity);
        }
        metadata.web_sources.retain(|uuid, sources| {
            records
                .get(uuid)
                .and_then(Option::as_ref)
                .is_some_and(|identity| sources.iter().all(|source| &source.identity == identity))
        });
        metadata.records = records.into();
        metadata
    }
    pub(super) fn provenance_revision(&self) -> crate::provenance_revision::Revision {
        self.records.revision()
    }
    pub(super) fn get(&self, uuid: &str) -> Option<TurnAttemptIdentity> {
        self.get_ref(uuid).cloned()
    }
    pub(super) fn get_ref(&self, uuid: &str) -> Option<&TurnAttemptIdentity> {
        self.records.get(uuid).and_then(Option::as_ref)
    }
    pub(super) fn sources(&self, uuid: &str) -> Vec<kcoder_types::web_sources::WebSourcesV1> {
        self.web_sources.get(uuid).cloned().unwrap_or_default()
    }
    pub(super) fn record_sources(
        &mut self,
        uuid: &str,
        sources: &[kcoder_types::web_sources::WebSourcesV1],
    ) {
        if !sources.is_empty() {
            self.web_sources.insert(uuid.to_owned(), sources.to_vec());
        }
    }
    pub(super) fn clear_records(&mut self) {
        if !self.records.is_empty() {
            self.records.clear();
        }
        self.web_sources.clear();
    }
    pub(super) fn retain(&mut self, ids: &[Option<String>]) {
        let retained: std::collections::HashSet<_> =
            ids.iter().flatten().map(String::as_str).collect();
        if self
            .records
            .keys()
            .any(|uuid| !retained.contains(uuid.as_str()))
        {
            self.records
                .retain(|uuid, _| retained.contains(uuid.as_str()));
        }
        self.web_sources
            .retain(|uuid, _| retained.contains(uuid.as_str()));
    }
}

pub(super) fn remember(
    inner: &mut AppStateInner,
    uuid: &str,
    identity: Option<TurnAttemptIdentity>,
) {
    if inner.history_attempts.records.get(uuid) != Some(&identity) {
        inner
            .history_attempts
            .records
            .insert(uuid.to_owned(), identity);
    }
    // Normal appends are O(1). Rewind/truncation can leave a bounded old tail;
    // prune it on the next append, without scanning the durable history.
    if inner.history_attempts.records.len() > inner.message_history_ids.len() {
        inner.history_attempts.retain(&inner.message_history_ids);
    }
}

/// Native source writers can retain a local CLI/TUI turn identity without creating an Accepted ledger record.
pub(super) fn web_source_history_identity(
    sources: &[kcoder_types::web_sources::WebSourcesV1],
    session: &str,
    message: &kcoder_types::Message,
) -> Option<TurnAttemptIdentity> {
    let first = sources.first()?;
    sources.iter().all(|receipt| receipt.identity == first.identity
        && receipt.matches(session, &receipt.tool_call_id)
        && matches!(message, kcoder_types::Message::User { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == &receipt.tool_call_id))))
        .then(|| first.identity.clone())
}

pub(super) fn record_append(
    state: &AppState,
    inner: &mut AppStateInner,
    uuid: &str,
    generated_uuid: bool,
) -> Option<TurnAttemptIdentity> {
    // The public explicit UUID API has no source-level uniqueness proof after
    // rewind. It remains unknown; ordinary generated UUIDs need no full scan.
    let identity = generated_uuid.then(|| current(state, inner)).flatten();
    remember(inner, uuid, identity.clone());
    identity
}

// Metadata is optional evidence. Invalid new metadata must never discard an
// otherwise valid legacy message body.
impl<'de> serde::Deserialize<'de> for HistoryEntry {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        struct Raw {
            session_id: String,
            timestamp_ms: u64,
            #[serde(default)]
            uuid: Option<String>,
            #[serde(default, rename = "parentUuid")]
            parent_uuid: Option<String>,
            #[serde(default, rename = "historyAttempt")]
            history_attempt: Option<serde_json::Value>,
            #[serde(default, rename = "webSources")]
            web_sources: serde_json::Value,
            #[serde(flatten)]
            message: kcoder_types::Message,
        }
        let raw = <Raw as serde::Deserialize>::deserialize(deserializer)?;
        let history_attempt = raw
            .history_attempt
            .and_then(|value| serde_json::from_value::<TurnAttemptIdentity>(value).ok())
            .filter(|identity| identity.validate().is_ok() && identity.thread_id == raw.session_id);
        let web_sources = raw.web_sources.as_array().into_iter().flatten().cloned()
            .filter_map(|value| serde_json::from_value::<kcoder_types::web_sources::WebSourcesV1>(value).ok())
            .filter(|receipt| history_attempt.as_ref() == Some(&receipt.identity)
                && receipt.matches(&raw.session_id, &receipt.tool_call_id)
                && matches!(&raw.message, kcoder_types::Message::User { content, .. } if content.iter().any(|block| matches!(block, kcoder_types::ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == &receipt.tool_call_id))))
            .collect();
        Ok(Self {
            web_sources,
            session_id: raw.session_id,
            timestamp_ms: raw.timestamp_ms,
            uuid: raw.uuid,
            parent_uuid: raw.parent_uuid,
            history_attempt,
            message: raw.message,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Message, load_history};

    fn attempt(state: &AppState, id: &str) -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: state.session_id(),
            turn_id: "turn-7".into(),
            attempt_id: id.into(),
        }
    }

    #[test]
    fn lifecycle_equality_rejects_foreign_replaced_and_expired_states() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let original = state.inspection_lifecycle_identity();
        let same = state.inspection_lifecycle_identity();
        assert!(original.same_lifecycle(&same));
        let peer = AppState::new(root.path());
        assert!(!original.same_lifecycle(&peer.inspection_lifecycle_identity()));
        state.start_new_session().unwrap();
        let replacement = state.inspection_lifecycle_identity();
        assert!(!original.same_lifecycle(&replacement));
        assert!(replacement.same_lifecycle(&replacement));
        drop(state);
        assert!(!original.same_lifecycle(&same));
        assert!(!replacement.same_lifecycle(&replacement));
    }

    #[test]
    fn lifecycle_try_match_never_waits_for_the_original_state_lock() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let original = state.inspection_lifecycle_identity();
        assert_eq!(original.try_matches(&state), Some(true));
        let held = state.inner.write().unwrap();
        assert_eq!(original.try_matches(&state), None);
        drop(held);
        assert_eq!(original.try_matches(&state), Some(true));
        let peer = AppState::new(root.path());
        assert_eq!(original.try_matches(&peer), Some(false));
        state.start_new_session().unwrap();
        assert_eq!(original.try_matches(&state), Some(false));
    }

    #[tokio::test]
    async fn direct_attempt_map_replacement_and_old_map_reinsertion_never_revive_provenance() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let original = attempt(&state, "original");
        state
            .history_attempt_scope(original.clone())
            .unwrap()
            .run(async {
                state.add_message(Message::user_text("original input"));
            })
            .await;
        let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
        let observed = state
            .observe_current_history_messages(
                &state.session_id(),
                &[crate::HistoryMessageLocator {
                    history_uuid: uuid,
                    attempt: original,
                }],
            )
            .unwrap();
        assert_eq!(observed.try_is_current(&state), Some(true));
        let old_records = {
            let mut inner = state.inner.write().unwrap();
            std::mem::take(&mut inner.history_attempts.records)
        };
        assert_eq!(observed.try_is_current(&state), Some(false));
        state.inner.write().unwrap().history_attempts.records = old_records;
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), Some(false));
    }

    #[tokio::test]
    async fn oversized_stored_attempt_is_unknown() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let original = attempt(&state, "original");
        state
            .history_attempt_scope(original.clone())
            .unwrap()
            .run(async {
                state.add_message(Message::user_text("original input"));
            })
            .await;
        let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
        let mut invalid = original.clone();
        invalid.attempt_id = "x".repeat(8 * 1024 * 1024 + 1);
        state
            .write_inner()
            .history_attempts
            .records
            .insert(uuid.clone(), Some(invalid));
        let observed = state
            .observe_current_history_messages(
                &state.session_id(),
                &[crate::HistoryMessageLocator {
                    history_uuid: uuid,
                    attempt: original,
                }],
            )
            .unwrap();
        assert_eq!(
            observed.entries()[0].presence,
            crate::CurrentHistoryPresence::Unknown(
                crate::CurrentHistoryUnknown::IncompleteIdentity
            )
        );
        assert!(!observed.is_current(&state));
        assert_eq!(observed.try_is_current(&state), None);
    }

    #[tokio::test]
    async fn current_attempt_witness_is_task_local_and_cannot_be_borrowed_by_a_peer_state() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        let peer = AppState::new(root.path());
        let identity = attempt(&state, "native-attempt");
        let witness = state.history_attempt_scope(identity.clone()).unwrap();
        assert!(state.current_history_attempt_identity().is_none());
        assert!(!witness.matches_current(&state));
        state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(async {
                assert_eq!(state.current_history_attempt_identity(), Some(identity));
                assert!(witness.matches_current(&state));
                assert!(!witness.matches_current(&peer));
                assert!(peer.current_history_attempt_identity().is_none());
                let child = state.clone();
                assert!(
                    tokio::spawn(async move { child.current_history_attempt_identity() })
                        .await
                        .unwrap()
                        .is_none()
                );
            })
            .await;
        assert!(!witness.matches_current(&state));
    }

    #[tokio::test]
    async fn history_attempt_scope_stamps_generated_appends_before_flush() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(Message::user_text("legacy"));
        let identity = attempt(&state, "attempt-A");
        state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(async {
                state.add_message(Message::user_text("new"));
                state.add_message(Message::assistant_text("partial"));
                state.add_message(Message::assistant_text("finished"));
            })
            .await;
        state.flush_history().await.unwrap();
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].history_attempt, None);
        assert!(
            entries[1..]
                .iter()
                .all(|entry| entry.history_attempt.as_ref() == Some(&identity))
        );
    }

    #[tokio::test]
    async fn history_attempt_scope_generated_owner_isolated_and_explicit_uuid_unknown() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let peer = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        let peer_path = dir.path().join(format!("{}.jsonl", peer.session_id()));
        state.with_history_path(&path);
        peer.with_history_path(&peer_path);
        let first = attempt(&state, "attempt-A");
        state
            .history_attempt_scope(first.clone())
            .unwrap()
            .run(async {
                state.add_message(Message::user_text("first"));
                peer.add_message(Message::assistant_text("peer"));
                let child = state.clone();
                tokio::spawn(async move {
                    child.add_message(Message::assistant_text("child"));
                })
                .await
                .unwrap();
                state
                    .add_message_with_uuid(Message::user_text("explicit"), "explicit-id")
                    .unwrap();
            })
            .await;
        state
            .history_attempt_scope(attempt(&state, "attempt-B"))
            .unwrap()
            .run(async {
                state
                    .add_message_with_uuid(Message::assistant_text("different"), "explicit-id")
                    .unwrap();
            })
            .await;
        state.add_message(Message::assistant_text("outside"));
        state.flush_history().await.unwrap();
        peer.flush_history().await.unwrap();
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].history_attempt.as_ref(), Some(&first));
        assert!(
            entries[1..]
                .iter()
                .all(|entry| entry.history_attempt.is_none())
        );
        assert!(
            load_history(&peer_path)
                .unwrap()
                .iter()
                .all(|entry| entry.history_attempt.is_none())
        );
    }

    #[tokio::test]
    async fn history_attempt_scope_rewind_cannot_upgrade_reused_explicit_uuid() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state
            .add_message_with_uuid(Message::user_text("old"), "reused")
            .unwrap();
        state.flush_history().await.unwrap();
        state.truncate_messages_for_rewind(0, 1).await.unwrap();
        state
            .history_attempt_scope(attempt(&state, "new-attempt"))
            .unwrap()
            .run(async {
                state
                    .add_message_with_uuid(Message::user_text("new"), "reused")
                    .unwrap();
            })
            .await;
        state.flush_history().await.unwrap();
        assert!(
            load_history(&path)
                .unwrap()
                .iter()
                .all(|entry| entry.history_attempt.is_none())
        );
    }

    #[test]
    fn history_attempt_scope_malformed_metadata_keeps_message_body() {
        for metadata in [
            serde_json::json!(false),
            serde_json::json!({"threadId":1}),
            serde_json::json!({"threadId":"session", "turnId":" ", "attemptId":"A"}),
            serde_json::json!({"threadId":"foreign", "turnId":"turn-1", "attemptId":"A"}),
        ] {
            let mut value = serde_json::to_value(HistoryEntry {
                web_sources: Vec::new(),
                session_id: "session".into(),
                timestamp_ms: 1,
                uuid: Some("row".into()),
                parent_uuid: None,
                history_attempt: None,
                message: Message::assistant_text("body retained"),
            })
            .unwrap();
            value["historyAttempt"] = metadata;
            let row: HistoryEntry = serde_json::from_value(value).unwrap();
            assert!(row.history_attempt.is_none());
            assert_eq!(row.message, Message::assistant_text("body retained"));
        }
    }

    #[tokio::test]
    async fn history_attempt_scope_resume_checkpoint_and_rewrite_preserve_uuid_metadata() {
        use crate::history_index::journal::{JournalDomain, JournalFence};
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(Message::user_text("legacy"));
        let identity = attempt(&state, "attempt-A");
        state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(async {
                state.add_message(Message::assistant_text("confirmed"));
            })
            .await;
        state.flush_history().await.unwrap();
        let original = load_history(&path).unwrap();
        JournalFence::try_acquire(dir.path(), JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        for _ in 0..2 {
            let _ = crate::prepare_session_resume_real_user_counting(&path).unwrap();
            let (prepared, _) = crate::prepare_session_resume_real_user_counting(&path).unwrap();
            let restored = AppState::new(dir.path());
            restored.apply_prepared_session_resume(prepared).unwrap();
            restored.save_history().unwrap();
            let rewritten = load_history(&path).unwrap();
            assert_eq!(
                rewritten
                    .iter()
                    .map(|r| (&r.uuid, &r.history_attempt))
                    .collect::<Vec<_>>(),
                original
                    .iter()
                    .map(|r| (&r.uuid, &r.history_attempt))
                    .collect::<Vec<_>>()
            );
        }
        let restored = AppState::new(dir.path());
        restored.resume_from_history(&path).unwrap();
        restored.truncate_messages_for_rewind(1, 2).await.unwrap();
        restored.save_history().unwrap();
        let retained = load_history(&path).unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].uuid, original[0].uuid);
        assert!(retained[0].history_attempt.is_none());
    }

    #[tokio::test]
    async fn history_attempt_scope_unique_commit_does_not_recolor_after_rewind() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        let first = attempt(&state, "attempt-A");
        state
            .history_attempt_scope(first.clone())
            .unwrap()
            .run(async {
                state
                    .commit_message_with_uuid(Message::assistant_text("first"), "stable")
                    .await
                    .unwrap();
            })
            .await;
        state.truncate_messages_for_rewind(0, 1).await.unwrap();
        state
            .history_attempt_scope(attempt(&state, "attempt-B"))
            .unwrap()
            .run(async {
                state
                    .commit_message_with_uuid(Message::assistant_text("replacement"), "stable")
                    .await
                    .unwrap();
            })
            .await;
        assert_eq!(state.message_count(), 0);
        let raw = std::fs::read_to_string(&path).unwrap();
        let rows = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<HistoryEntry>(line).ok())
            .collect::<Vec<_>>();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].history_attempt.as_ref(), Some(&first));
        assert_eq!(rows[0].message, Message::assistant_text("first"));
    }

    #[tokio::test]
    async fn history_attempt_scope_compaction_keeps_only_retained_uuid_provenance() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        let identity = attempt(&state, "attempt-A");
        let tail = Message::assistant_text("retained answer");
        state
            .history_attempt_scope(identity.clone())
            .unwrap()
            .run(async {
                state.add_message(Message::user_text("old request"));
                state.add_message(tail.clone());
            })
            .await;
        state.flush_history().await.unwrap();
        let original = load_history(&path).unwrap();
        state
            .set_messages_after_compaction(
                vec![
                    Message::user_text("Earlier conversation summary: summary"),
                    tail,
                ],
                crate::CompactionTranscriptEvent {
                    trigger: crate::CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 20,
                    summary: "summary".into(),
                },
            )
            .await
            .unwrap();
        state.save_history().unwrap();
        let entries = load_history(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].history_attempt.is_none());
        assert_eq!(entries[1].uuid, original[1].uuid);
        assert_eq!(entries[1].history_attempt.as_ref(), Some(&identity));
    }

    #[tokio::test]
    async fn history_attempt_scope_session_replacement_invalidates_same_session_owner() {
        let dir = tempfile::TempDir::new().unwrap();
        let state = AppState::new(dir.path());
        let path = dir.path().join(format!("{}.jsonl", state.session_id()));
        state.with_history_path(&path);
        state.add_message(Message::user_text("existing"));
        state.flush_history().await.unwrap();
        let old = state.history_attempt_scope(attempt(&state, "old")).unwrap();
        let witness = state.history_attempt_scope(attempt(&state, "old")).unwrap();
        let before = state.inspection_lifecycle_identity();
        let scope_owner = witness.lifecycle_identity();
        assert!(scope_owner.same_lifecycle(&before));
        let session_id = state.session_id();
        let observed_before_resume = state
            .observe_current_history_messages(&session_id, &[])
            .unwrap();
        assert_eq!(observed_before_resume.try_is_current(&state), Some(true));
        old.run(async {
            assert!(witness.matches_current(&state));
            state.resume_from_history(&path).unwrap();
            assert_eq!(state.session_id(), session_id);
            assert_eq!(observed_before_resume.try_is_current(&state), Some(false));
            assert!(!before.same_lifecycle(&state.inspection_lifecycle_identity()));
            assert!(!scope_owner.same_lifecycle(&state.inspection_lifecycle_identity()));
            assert!(!witness.matches_current(&state));
            assert!(state.current_history_attempt_identity().is_none());
            let fresh = state.history_attempt_scope(attempt(&state, "old")).unwrap();
            let fresh_witness = state.history_attempt_scope(attempt(&state, "old")).unwrap();
            fresh
                .run(async {
                    assert!(fresh_witness.matches_current(&state));
                    assert!(!witness.matches_current(&state));
                })
                .await;
            state.add_message(Message::assistant_text("new lifecycle"));
        })
        .await;
        state.flush_history().await.unwrap();
        assert!(
            load_history(&path)
                .unwrap()
                .iter()
                .all(|row| row.history_attempt.is_none())
        );
    }
}
