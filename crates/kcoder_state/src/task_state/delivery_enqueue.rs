//! Native run constraints and FIFO receipts commit in the same original State transaction.
use super::*;
use sha2::Digest as _;

impl AppState {
    /// Preserve legacy delivery while allowing native hosts to narrow to a run.
    pub fn enqueue_subagent_delivery_with_client_id(
        &self,
        id: &str,
        message: impl Into<String>,
        client_message_id: Option<&str>,
    ) -> anyhow::Result<Option<AgentDeliveryEnqueueReceipt>> {
        self.enqueue_subagent_delivery_for_run(id, message, client_message_id, None)
    }

    /// The identity and FIFO message commit in the same atomic task transaction.
    /// Replayed identities do not reopen a closed queue or create another worker.
    pub fn enqueue_subagent_delivery_for_run(
        &self,
        id: &str,
        message: impl Into<String>,
        client_message_id: Option<&str>,
        expected_run: Option<&kcoder_types::BackgroundRunKey>,
    ) -> anyhow::Result<Option<AgentDeliveryEnqueueReceipt>> {
        self.enqueue_subagent_delivery_constrained(
            id,
            message,
            client_message_id,
            expected_run,
            false,
        )
    }

    /// Explicit user continuation reopens and queues against the original terminal run atomically.
    pub fn enqueue_subagent_continuation_for_run(
        &self,
        expected: &kcoder_types::BackgroundRunKey,
        message: impl Into<String>,
        client_message_id: &str,
    ) -> anyhow::Result<Option<AgentDeliveryEnqueueReceipt>> {
        self.enqueue_subagent_delivery_constrained(
            &expected.agent_id,
            message,
            Some(client_message_id),
            Some(expected),
            true,
        )
    }

    fn enqueue_subagent_delivery_constrained(
        &self,
        id: &str,
        message: impl Into<String>,
        client_message_id: Option<&str>,
        expected_run: Option<&kcoder_types::BackgroundRunKey>,
        continuation: bool,
    ) -> anyhow::Result<Option<AgentDeliveryEnqueueReceipt>> {
        let expected_run = expected_run.cloned();
        if let Some(expected) = &expected_run {
            anyhow::ensure!(
                expected.parent_session_id == self.session_id() && expected.agent_id == id,
                "subagent_run_changed"
            );
        }
        let message = message.into();
        let client_message_id = client_message_id.map(str::to_string);
        if client_message_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty() || id.len() > 128)
        {
            anyhow::bail!("clientMessageId must contain 1..=128 bytes");
        }
        if message.trim().is_empty() {
            anyhow::bail!("sub-agent delivery message must not be empty");
        }
        if message.len() > MAX_SUBAGENT_DELIVERY_BYTES {
            anyhow::bail!(
                "sub-agent delivery exceeds the {} byte limit",
                MAX_SUBAGENT_DELIVERY_BYTES
            );
        }
        let receipt = self.transact_task(id, move |task| {
            if let Some(expected) = &expected_run {
                anyhow::ensure!(task.kind == TaskKind::Subagent, "subagent_run_changed");
                if continuation {
                    if let Some(existing) = client_message_id.as_ref().and_then(|client| task.command_receipts.iter().find(|receipt| &receipt.client_message_id == client)) {
                        anyhow::ensure!(existing.background_run.as_ref() == Some(expected), "subagent_run_changed");
                    } else {
                        anyhow::ensure!(task.background_run.as_ref() == Some(expected)
                            && matches!(task.status, TaskStatus::Completed | TaskStatus::Failed)
                            && task.managed
                            && task.background_runs.iter().any(|record| &record.key == expected && record.terminal.is_some() && !record.imported_history), "subagent_run_changed");
                    }
                } else {
                    anyhow::ensure!(task.background_run.as_ref() == Some(expected), "subagent_run_changed");
                    anyhow::ensure!(matches!(task.status, TaskStatus::Pending | TaskStatus::Running | TaskStatus::Paused), "subagent_run_not_active");
                }
            }
            let body_sha256 = format!("{:x}", sha2::Sha256::digest(message.as_bytes()));
            if let Some(client_id) = client_message_id.as_ref() {
                validate_command_epoch(client_id, task.command_receipt_epoch)?;
                if let Some(existing) = task.command_receipts.iter().find(|receipt| &receipt.client_message_id == client_id) {
                    if existing.body_sha256 != body_sha256 {
                        anyhow::bail!("client_message_payload_conflict");
                    }
                    return Ok(Some(AgentDeliveryEnqueueReceipt {
                        message_id: existing.message_id.clone(),
                        queue_position: task.message_queue.iter().position(|message| message.message_id == existing.message_id).map_or(0, |index| index + 1),
                        replayed: true,
                    }));
                }
                if task.command_receipts.len() >= MAX_SUBAGENT_COMMAND_RECEIPTS {
                    anyhow::bail!("command_receipt_capacity: 256 retained identities; inspect and explicitly archive confirmed command history before sending more");
                }
            }
            task.migrate_legacy_pending_messages();
            if task.has_delivery_queue_migration_conflict() {
                anyhow::bail!(
                    "sub-agent {id} contains both legacy and reliable message queues; refusing to guess FIFO order"
                );
            }
            if continuation {
                task.accepting_subagent_messages = true;
            }
            if !task.accepting_subagent_messages {
                return Ok(None);
            }
            if task.message_queue.len() >= MAX_SUBAGENT_DELIVERY_QUEUE_MESSAGES {
                anyhow::bail!(
                    "sub-agent delivery queue is full ({} messages)",
                    MAX_SUBAGENT_DELIVERY_QUEUE_MESSAGES
                );
            }
            let queued_bytes = task
                .message_queue
                .iter()
                .try_fold(0usize, |total, queued| total.checked_add(queued.body.len()))
                .ok_or_else(|| anyhow::anyhow!("sub-agent delivery queue byte count overflow"))?;
            if queued_bytes.saturating_add(message.len()) > MAX_SUBAGENT_DELIVERY_QUEUE_BYTES {
                anyhow::bail!(
                    "sub-agent delivery queue exceeds the {} byte limit",
                    MAX_SUBAGENT_DELIVERY_QUEUE_BYTES
                );
            }
            let queued = QueuedAgentMessage::new(message);
            let receipt = AgentDeliveryEnqueueReceipt {
                message_id: queued.message_id.clone(),
                queue_position: task.message_queue.len().saturating_add(1),
                replayed: false,
            };
            if let Some(client_message_id) = client_message_id {
                task.command_receipts.push(crate::model::AgentCommandReceipt {
                    client_message_id,
                    message_id: queued.message_id.clone(),
                    body_sha256,
                    body_summary: queued.body.chars().take(256).collect(),
                    status: AgentMessageStatus::Queued,
                    accepted_at_ms: queued.created_at_ms,
                    applied_at_ms: None,
                    background_run: task.background_run.clone(),
                    applied_background_run: None,
                });
            }
            task.message_queue.push(queued);
            task.updated_at_ms = now_millis();
            Ok(Some(receipt))
        })?
        .flatten();
        if let Some(receipt) = receipt.as_ref().filter(|receipt| !receipt.replayed) {
            let task = self.task(id);
            self.record_orchestrate_runtime_event_after_commit(
                "message_queued",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                Some(&receipt.message_id),
                serde_json::json!({"queue_position": receipt.queue_position}),
            );
        }
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(state: &AppState) -> kcoder_types::BackgroundRunKey {
        let mut task = Task::new("exact-member", "Native member control");
        task.kind = TaskKind::Subagent;
        task.status = TaskStatus::Running;
        task.managed = true;
        task.parent_session_id = Some(state.session_id());
        state.start_background_task_run(task).unwrap()
    }

    #[test]
    fn original_terminal_continuation_queues_once_and_replays_only_its_original_receipt() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("history.jsonl"));
        let original = running(&state);
        state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(original.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
        state.update_task(&original.agent_id, |task| {
            task.accepting_subagent_messages = false
        });
        let first = state
            .enqueue_subagent_continuation_for_run(
                &original,
                "continue original work",
                "cmd:0:continue",
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            state.task(&original.agent_id).unwrap().message_queue.len(),
            1
        );
        assert_eq!(
            state
                .subagent_command_receipt(&original.agent_id, "cmd:0:continue")
                .unwrap()
                .unwrap()
                .background_run
                .as_ref(),
            Some(&original)
        );
        let replacement = state.begin_background_run(&original.agent_id).unwrap();
        let before = serde_json::to_value(state.task(&original.agent_id).unwrap()).unwrap();
        let replay = state
            .enqueue_subagent_continuation_for_run(
                &original,
                "continue original work",
                "cmd:0:continue",
            )
            .unwrap()
            .unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.message_id, first.message_id);
        assert_eq!(
            serde_json::to_value(state.task(&original.agent_id).unwrap()).unwrap(),
            before
        );
        assert!(
            state
                .enqueue_subagent_continuation_for_run(
                    &original,
                    "new late instruction",
                    "cmd:0:late-continuation"
                )
                .is_err()
        );
        assert!(
            state
                .enqueue_subagent_continuation_for_run(&original, "changed body", "cmd:0:continue")
                .is_err()
        );
        assert_eq!(
            state.task(&original.agent_id).unwrap().background_run,
            Some(replacement)
        );
    }

    #[test]
    fn constrained_delivery_commits_once_and_cannot_write_a_replacement_run() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("history.jsonl"));
        let original = running(&state);
        let first = state
            .enqueue_subagent_delivery_for_run(
                &original.agent_id,
                "original member instruction",
                Some("cmd:0:original"),
                Some(&original),
            )
            .unwrap()
            .unwrap();
        let replay = state
            .enqueue_subagent_delivery_for_run(
                &original.agent_id,
                "original member instruction",
                Some("cmd:0:original"),
                Some(&original),
            )
            .unwrap()
            .unwrap();
        assert!(replay.replayed);
        assert_eq!(first.message_id, replay.message_id);
        assert_eq!(
            state.task(&original.agent_id).unwrap().message_queue.len(),
            1
        );
        state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(original.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
        let replacement = state.begin_background_run(&original.agent_id).unwrap();
        assert_ne!(replacement, original);
        let before = serde_json::to_value(state.task(&original.agent_id).unwrap()).unwrap();
        assert!(
            state
                .enqueue_subagent_delivery_for_run(
                    &original.agent_id,
                    "must not reach the replacement",
                    Some("cmd:0:late"),
                    Some(&original),
                )
                .unwrap_err()
                .to_string()
                .contains("subagent_run_changed")
        );
        assert_eq!(
            serde_json::to_value(state.task(&original.agent_id).unwrap()).unwrap(),
            before
        );
    }

    #[test]
    fn terminal_and_foreign_run_constraints_never_reopen_or_enqueue() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::new(root.path());
        state.with_history_path(root.path().join("history.jsonl"));
        let original = running(&state);
        let mut foreign = original.clone();
        foreign.parent_session_id = "another-parent".into();
        assert!(
            state
                .enqueue_subagent_delivery_for_run(
                    &original.agent_id,
                    "foreign",
                    Some("cmd:0:foreign"),
                    Some(&foreign),
                )
                .is_err()
        );
        state
            .commit_background_terminal(
                &kcoder_types::BackgroundEventIdentity::terminal(original.clone()),
                TaskStatus::Completed,
                None,
            )
            .unwrap();
        let before = serde_json::to_value(state.task(&original.agent_id).unwrap()).unwrap();
        assert!(
            state
                .enqueue_subagent_delivery_for_run(
                    &original.agent_id,
                    "do not resume",
                    Some("cmd:0:terminal"),
                    Some(&original),
                )
                .unwrap_err()
                .to_string()
                .contains("subagent_run_not_active")
        );
        assert_eq!(
            serde_json::to_value(state.task(&original.agent_id).unwrap()).unwrap(),
            before
        );
    }
}
