//! First admission decision runs after original-request reconciliation while
//! the destination transaction and the actual target owner's guard are held.
use super::*;

impl CrossSessionMessageStore {
    /// The destination supplies this live callback. It is evaluated only for
    /// a new immutable request; old CIDs always retain their original receipt.
    /// Returning a reason persists Rejected directly, without a Queued phase.
    pub fn enqueue_with_admission(
        &self,
        source: &CrossSessionMessageSource,
        intent: AgentMessageIntent,
        expected_revision: u64,
        ttl_seconds: u32,
        decide: impl FnOnce() -> Result<Option<&'static str>>,
    ) -> Result<AgentMessageReceipt> {
        ensure!(
            (1..=kcoder_config::CrossSessionMessagesSettings::MAX_MESSAGE_TTL_SECONDS)
                .contains(&ttl_seconds),
            "AGENT_MESSAGE_EXPIRY_INVALID"
        );
        source.validate().map_err(anyhow::Error::msg)?;
        intent.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            intent
                .target_address
                .as_ref()
                .is_none_or(|address| address.target_id == self.header.scope.target_id
                    && address.workspace_id == self.header.scope.workspace_id),
            "AGENT_MESSAGE_DESTINATION_SCOPE_MISMATCH"
        );
        ensure!(
            !same_peer_session(source, &intent).map_err(anyhow::Error::msg)?,
            "AGENT_MESSAGE_SELF_TARGET"
        );
        let key = request_key(source, &intent.client_message_id)?;
        self.access_with_archive(true, |data, archive| {
            if let Some(tx) = archive
                && let Some(terminal) = self.terminal_by_key(tx, &key)?
            {
                ensure!(
                    terminal.fingerprint == archive::fingerprint(source, &intent)?,
                    "AGENT_MESSAGE_REQUEST_CONFLICT"
                );
                return Ok((terminal.receipt(), false));
            }
            if let Some(existing) = data.messages.get(&key) {
                ensure!(
                    existing.source == *source && existing.intent == intent,
                    "AGENT_MESSAGE_REQUEST_CONFLICT"
                );
                return Ok((existing.receipt.clone(), false));
            }
            revision_is(data, expected_revision)?;
            ensure!(
                data.messages
                    .values()
                    .filter(|row| archive::is_pending(row.receipt.status))
                    .count()
                    < MAX_MESSAGES,
                "AGENT_MESSAGE_QUEUE_FULL"
            );
            let reason = decide()?;
            let revision = next_revision(data)?;
            let sequence = data
                .last_sequence
                .checked_add(1)
                .context("AGENT_MESSAGE_SEQUENCE_OVERFLOW")?;
            let receipt = AgentMessageReceipt {
                reply_to_message_id: intent.reply_to_message_id.clone(),
                message_id: uuid::Uuid::new_v4().to_string(),
                client_message_id: intent.client_message_id.clone(),
                target_thread_id: intent.target_thread_id.clone(),
                status: if reason.is_some() {
                    AgentMessageStatus::Rejected
                } else {
                    AgentMessageStatus::Queued
                },
                revision,
                reason_code: reason.map(str::to_owned),
                source_address: source.address.clone(),
                target_address: intent.target_address.clone(),
            };
            let created_at_ms = crate::now_millis();
            ensure!(created_at_ms > 0, "AGENT_MESSAGE_CLOCK_UNAVAILABLE");
            let expires_at_ms = created_at_ms
                .checked_add(u64::from(ttl_seconds) * 1000)
                .context("AGENT_MESSAGE_EXPIRY_INVALID")?;
            data.messages.insert(
                key,
                StoredMessage {
                    source: source.clone(),
                    intent,
                    receipt: receipt.clone(),
                    sequence,
                    created_at_ms,
                    expires_at_ms: Some(expires_at_ms),
                    terminal_at_ms: reason.map(|_| created_at_ms),
                    namespace_id: self.header.directory.clone(),
                    history_uuid: None,
                    peer_wake_claim: None,
                    reservation: None,
                },
            );
            data.revision = revision;
            data.last_sequence = sequence;
            Ok((receipt, true))
        })
    }
}
