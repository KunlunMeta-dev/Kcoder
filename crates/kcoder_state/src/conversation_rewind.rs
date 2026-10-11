//! Ordered prepare/commit for append-only conversation rewind.

use crate::history_flusher::{HistoryFlusher, HistoryFlusherQueue};
use crate::*;

#[derive(Debug)]
pub(super) struct PreparedRewind {
    state: AppState,
    owner: String,
    path: Option<PathBuf>,
    messages: kcoder_types::SharedMessages,
    ids: Vec<Option<String>>,
    cut: usize,
    turn: u64,
    boundary: Option<String>,
    parent: Option<String>,
    anchor: Option<String>,
}

#[derive(Debug)]
pub(super) struct RewindParent {
    pub owner: String,
    pub first_entry: String,
    pub boundary: String,
}

impl AppState {
    /// Prepare and enqueue under one state lock. The ordered writer commits the
    /// boundary and context even if the caller drops its reply future afterwards.
    pub async fn truncate_messages_for_rewind(
        &self,
        cut: usize,
        turn: u64,
    ) -> anyhow::Result<ConversationRewindOutcome> {
        enum Dispatch {
            Direct(PreparedRewind),
            Queued {
                reply: oneshot::Receiver<anyhow::Result<ConversationRewindOutcome>>,
                fallback: Option<(HistoryFlusher, PathBuf, HistoryFlusherCommand)>,
            },
        }
        let dispatch = {
            let _persist = self.lock_session_state_persistence();
            let inner = self.write_inner();
            if cut >= inner.messages.len() {
                return Ok(ConversationRewindOutcome {
                    removed: 0,
                    boundary_recorded: false,
                });
            }
            check_direct_history_fault(&inner)?;
            anyhow::ensure!(
                inner.message_history_ids.len() == inner.messages.len(),
                "rewind message identities are inconsistent; reload the conversation"
            );
            let anchor = inner.message_history_ids[..cut]
                .iter()
                .rev()
                .find_map(Clone::clone);
            let operation = PreparedRewind {
                state: self.clone(),
                owner: inner.session_id.clone(),
                path: inner.history_path.clone(),
                messages: inner.messages.clone(),
                ids: inner.message_history_ids.clone(),
                cut,
                turn,
                boundary: (cut == 0 || anchor.is_some()).then(generate_transcript_uuid),
                parent: inner.last_history_uuid.clone(),
                anchor,
            };
            if let (Some(flusher), Some(path)) = (&inner.history_flusher, &inner.history_path) {
                let (done, reply) = oneshot::channel();
                let command = HistoryFlusherCommand::RewindTransaction {
                    operation: Box::new(operation),
                    done,
                };
                // A later add_message can enqueue only after this command.
                let fallback = flusher
                    .send(command)
                    .err()
                    .map(|command| (flusher.clone(), path.clone(), *command));
                Dispatch::Queued { reply, fallback }
            } else {
                Dispatch::Direct(operation)
            }
        };
        match dispatch {
            Dispatch::Direct(operation) => operation.commit_direct(),
            Dispatch::Queued { reply, fallback } => {
                // Fallback reacquires state locks; never invoke it while preparing.
                if let Some((flusher, path, command)) = fallback {
                    flusher.process_direct(&path, command);
                }
                reply
                    .await
                    .context("history writer stopped before confirming rewind")?
            }
        }
    }
}

impl PreparedRewind {
    fn check_context(&self, inner: &AppStateInner) -> anyhow::Result<()> {
        anyhow::ensure!(
            inner.session_id == self.owner && inner.history_path == self.path,
            "session owner changed before rewind; prepare it again"
        );
        // Payload identities distinguish append-only growth from equal-content rewrites.
        anyhow::ensure!(
            inner.messages.len() >= self.messages.len()
                && inner.message_history_ids.len() == inner.messages.len()
                && inner.message_history_ids[..self.ids.len()] == self.ids
                && self
                    .messages
                    .iter()
                    .zip(inner.messages.iter())
                    .all(|(old, current)| std::ptr::eq(old, current)),
            "conversation changed beyond append while rewind was queued; prepare it again"
        );
        check_direct_history_fault(inner)
    }

    pub(super) fn commit_queued(
        self,
        path: &Path,
        queue: &HistoryFlusherQueue,
        epoch: u64,
    ) -> anyhow::Result<ConversationRewindOutcome> {
        let _persist = self.state.lock_session_state_persistence();
        let mut inner = self.state.write_inner();
        self.check_context(&inner)?;
        anyhow::ensure!(
            self.path.as_deref() == Some(path),
            "rewind writer path changed"
        );
        queue.execute_rewind(epoch, |source| self.commit_locked(&mut inner, Some(source)))
    }

    fn commit_direct(self) -> anyhow::Result<ConversationRewindOutcome> {
        let _persist = self.state.lock_session_state_persistence();
        let mut inner = self.state.write_inner();
        self.check_context(&inner)?;
        let source = inner.history_source.clone();
        let result = self.commit_locked(&mut inner, source.as_ref());
        result.map(|(outcome, _)| outcome)
    }

    fn commit_locked(
        &self,
        inner: &mut AppStateInner,
        source: Option<&HistorySource>,
    ) -> anyhow::Result<(ConversationRewindOutcome, Option<RewindParent>)> {
        let recording = self.path.is_some() && self.boundary.is_some();
        let has_tail = inner.messages.len() > self.messages.len();
        let first_tail = if recording && has_tail {
            Some(
                inner.message_history_ids[self.messages.len()]
                    .clone()
                    .context("appended rewind tail has no history identity")?,
            )
        } else {
            None
        };
        let result = if recording {
            append_rewind_transcript_record(
                source.context("rewind history source is missing")?,
                &self.owner,
                self.boundary.as_deref().unwrap(),
                self.parent.as_deref(),
                self.anchor.as_deref(),
                self.turn,
            )
        } else {
            // No replay anchor: only metadata is durable. Its failure must not
            // truncate memory; stage the timestamp under the same exclusive lock.
            let previous = inner.session_updated_at_ms;
            inner.session_updated_at_ms = previous.max(now_millis());
            let result = if inner.session_state_path.is_some() {
                persist_snapshot_session_state(inner)
            } else {
                Ok(())
            };
            inner.session_updated_at_ms = previous;
            result
        };
        if let Err(error) = result {
            if history_store::is_uncertain_mutation(&error) {
                inner.history_write_fault = Some(format!("{error:#}"));
            }
            return Err(error);
        }

        let has_new_assistant = inner
            .messages
            .iter()
            .skip(self.messages.len())
            .any(|message| message.role() == MessageRole::Assistant);
        inner.messages.remove_range(self.cut..self.messages.len());
        inner.message_history_ids.drain(self.cut..self.ids.len());
        inner.message_revision = MessageRevision::default();
        inner.file_reads.clear();
        inner.full_file_reads.clear();
        inner.read_tool_call_keys.clear();
        inner.session_updated_at_ms = inner.session_updated_at_ms.max(now_millis());
        if !has_new_assistant {
            inner.last_assistant_message_timestamp_ms = None;
        }
        if !has_tail {
            inner.last_history_uuid = if recording {
                self.boundary.clone()
            } else {
                self.anchor.clone()
            };
        }
        if recording && let Err(error) = persist_snapshot_session_state(inner) {
            let error = history_store::incomplete_snapshot(error)
                .context("rewind boundary committed but session metadata failed; explicit recovery is required");
            inner.history_write_fault = Some(format!("{error:#}"));
            return Err(error);
        }
        Ok((
            ConversationRewindOutcome {
                removed: self.messages.len() - self.cut,
                boundary_recorded: recording,
            },
            first_tail.map(|first_entry| RewindParent {
                owner: self.owner.clone(),
                first_entry,
                boundary: self.boundary.clone().unwrap(),
            }),
        ))
    }
}

#[cfg(test)]
#[path = "conversation_rewind_tests.rs"]
mod tests;
