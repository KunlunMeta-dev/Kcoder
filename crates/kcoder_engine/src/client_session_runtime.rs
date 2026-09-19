use super::*;

impl QueryEngine {
    /// Directory where session-specific data (history, tool results) is stored.
    pub(super) fn session_dir(&self) -> PathBuf {
        kcoder_state::session_dir_path(
            &self.session_storage_root,
            &self.state.artifact_session_id(),
        )
    }

    /// Stable filesystem identity used by an app-server process to exclude a
    /// second owner of the same live thread. History-backed sessions use the
    /// transcript itself; history-less client sessions use their external
    /// session artifact tree and never write into the workspace.
    pub fn session_lease_target(&self) -> PathBuf {
        self.state
            .history_path()
            .unwrap_or_else(|| self.session_dir().join("session"))
    }

    /// External transient artifact directory for an arbitrary client session.
    pub fn session_storage_dir_for(&self, session_id: &str) -> PathBuf {
        kcoder_state::session_dir_path(&self.session_storage_root, session_id)
    }

    /// Stable external storage root used by GUI/app-server features. Client mode keeps this
    /// outside the project so worktree metadata and other desktop state never recreate `.kcoder`.
    pub fn client_storage_root(&self) -> PathBuf {
        self.session_storage_root.clone()
    }

    /// Current prompt-boundary index used to key checkpoints: the number of
    /// genuine user requests so far (tool-result containers do not count).
    pub(super) fn checkpoint_turn_index(&self) -> u64 {
        self.state
            .messages()
            .iter()
            .filter(|message| crate::context::compact::is_user_request_message(message))
            .count() as u64
    }

    /// List per-prompt checkpoint turns for `/rewind`.
    pub fn checkpoints_list(&self) -> Vec<checkpoint::CheckpointSummary> {
        self.checkpoints.list()
    }

    /// Genuine user-request turns in order, as (1-based turn index, preview)
    /// pairs, for the `/rewind` picker. Turn indices match
    /// `checkpoint_turn_index`, so selecting an entry rewinds to before that
    /// prompt. Engine-generated user-role scaffolding (skills, memories,
    /// reminders, notifications) keeps its turn number but is not listed.
    pub fn user_request_turn_previews(&self) -> Vec<(u64, String)> {
        let mut count = 0u64;
        let mut turns = Vec::new();
        for message in self.state.messages().iter() {
            if !crate::context::compact::is_user_request_message(message) {
                continue;
            }
            count += 1;
            if !crate::agent::is_real_user_message(message) {
                continue;
            }
            let preview = message.preview(160);
            let preview = preview
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(120)
                .collect::<String>();
            if preview.is_empty() {
                continue;
            }
            turns.push((count, preview));
        }
        turns
    }

    /// Number of genuine user turns currently available to app-server clients.
    /// Synthetic continuation/context messages and tool-result containers are
    /// deliberately excluded so `turn-N` remains stable across a resume.
    pub fn client_turn_count(&self) -> usize {
        client_turn_ids_for_messages(&self.state.messages())
            .into_iter()
            .flatten()
            .last()
            .and_then(|turn_id| turn_id.strip_prefix("turn-")?.parse::<usize>().ok())
            .unwrap_or(0)
    }

    /// Snapshot the conversation through the requested app-server `turn-N`
    /// boundary. A later in-flight turn may already have appended messages;
    /// cutting at the next genuine user request keeps the source untouched and
    /// gives the fork exactly the selected completed history.
    pub fn client_fork_messages_through_turn(&self, turn_id: &str) -> Result<Vec<Message>> {
        let turn = turn_id
            .strip_prefix("turn-")
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .with_context(|| format!("invalid app-server turn id: {turn_id}"))?;
        let messages = self.state.messages();
        let real_user_indices = messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| {
                crate::agent::is_real_user_message(message).then_some(index)
            })
            .collect::<Vec<_>>();
        if turn > real_user_indices.len() {
            anyhow::bail!("fork turn was not found: {turn_id}")
        }
        let end = real_user_indices
            .get(turn)
            .copied()
            .unwrap_or(messages.len());
        Ok(messages[..end].to_vec())
    }

    /// Restore every file to its state before prompt `turn` (cascading all
    /// turns at or after it), truncate the conversation at the same prompt
    /// boundary so the model no longer sees anything from that prompt onward,
    /// and record the outcome in the transcript.
    ///
    /// Returns the file rewind report plus the conversation rewind outcome
    /// (`None` when the prompt boundary no longer exists in the conversation,
    /// for example after compaction).
    pub async fn checkpoints_rewind(
        &self,
        turn: u64,
    ) -> Result<(
        checkpoint::RewindReport,
        Option<kcoder_state::ConversationRewindOutcome>,
    )> {
        // The conversation cut point is the start of the `turn`-th user
        // request, mirroring the numbering used by checkpoint_turn_index.
        let cut = {
            let mut count = 0u64;
            let mut cut = None;
            for (index, message) in self.state.messages().iter().enumerate() {
                if crate::context::compact::is_user_request_message(message) {
                    count += 1;
                    if count == turn {
                        cut = Some(index);
                        break;
                    }
                }
            }
            cut
        };
        // A rewind is meaningful when there are file checkpoints at/after the
        // turn, or when the prompt boundary still exists in the conversation.
        // Turns with file mutations but no surviving conversation boundary
        // (for example after compaction) rewind files only.
        let has_file_work = self.checkpoints_list().iter().any(|s| s.turn >= turn);
        let report = if has_file_work {
            self.checkpoints.rewind(turn)?
        } else if cut.is_some() {
            checkpoint::RewindReport::default()
        } else {
            anyhow::bail!("no checkpoint found for turn {turn}");
        };
        let outcome = match cut {
            Some(cut) => Some(self.state.truncate_messages_for_rewind(cut, turn).await?),
            None => None,
        };
        let summary = checkpoint::rewind_summary(&report);
        let conversation_note = match outcome {
            Some(outcome) if outcome.removed > 0 => {
                let mut note = format!(
                    " Conversation rewound to the same boundary ({} message(s) removed).",
                    outcome.removed
                );
                if !outcome.boundary_recorded {
                    note.push_str(
                        " No durable transcript anchor was available, so the full conversation may reappear if this session is resumed.",
                    );
                }
                note
            }
            _ => " Conversation boundary was not found (it may already be compacted); only files were restored.".to_string(),
        };
        self.state.add_message(Message::user_text(format!(
            "<system-reminder>Rewind to checkpoint turn {turn} completed: {summary}.{conversation_note}</system-reminder>"
        )));
        Ok((report, outcome))
    }

    /// Current session identifier.
    pub fn session_id(&self) -> String {
        self.state.session_id()
    }
}

/// Assign the stable app-server `turn-N` identity to every message that belongs
/// to a genuine user turn. This is also used while reading durable transcripts,
/// so message actions continue to work after a renderer reload.
pub fn client_turn_ids_for_messages(messages: &[Message]) -> Vec<Option<String>> {
    let mut turn = 0usize;
    messages
        .iter()
        .map(|message| {
            if crate::agent::is_real_user_message(message) {
                turn = turn.saturating_add(1);
            }
            (turn > 0).then(|| format!("turn-{turn}"))
        })
        .collect()
}
