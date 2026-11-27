//! Original idle admission survives observers, never manufacturing a fresh append.
use super::*;
use crate::history_store::PeerSourceHistoryReference;
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PeerIdleWakeAdmission {
    version: u32,
    pub(crate) message_id: String,
    pub(crate) thread_id: String,
    namespace: String,
    history_uuid: String,
    history: PeerSourceHistoryReference,
    pub(crate) sequence: u64,
    pub(crate) budget_generation: u64,
    pub(crate) deadline_ms: u64,
}

impl PeerIdleWakeAdmission {
    pub(crate) fn from_original(
        witness: &PeerHistoryCommitWitness,
        budget_generation: u64,
        deadline_ms: u64,
        sequence: u64,
    ) -> Result<Self> {
        ensure!(
            witness.new_context_insertion && budget_generation > 0 && deadline_ms > 0,
            "PEER_IDLE_WAKE_ORIGINAL_ADMISSION_REQUIRED"
        );
        witness.verify_current()?;
        let (metadata, _) = witness
            .message
            .peer_agent_data()
            .context("PEER_IDLE_WAKE_TRIGGER_INVALID")?;
        let history = witness
            .state
            .peer_source_admission_history(&witness.owner)?;
        let admission = Self {
            version: 1,
            message_id: metadata.message_id.clone(),
            thread_id: witness.state.session_id(),
            namespace: witness.namespace_id.clone(),
            history_uuid: witness.history_uuid.clone(),
            history: history.reference().clone(),
            sequence,
            budget_generation,
            deadline_ms,
        };
        admission.verify_presence(witness)?;
        Ok(admission)
    }

    pub(crate) fn validate(&self, namespace: &str) -> Result<()> {
        self.history.validate()?;
        ensure!(
            self.version == 1
                && self.namespace == namespace
                && self.history.thread_id() == self.thread_id
                && kcoder_types::cross_session_messages::valid_agent_message_id(&self.message_id)
                && kcoder_types::cross_session_messages::valid_agent_message_id(&self.thread_id)
                && uuid::Uuid::parse_str(&self.history_uuid).is_ok()
                && self.budget_generation > 0
                && self.sequence > 0
                && self.deadline_ms > 0,
            "PEER_IDLE_WAKE_ADMISSION_INVALID"
        );
        Ok(())
    }

    pub(crate) fn matches_record(&self, record: &CrossSessionMessageRecord) -> Result<()> {
        self.validate(&record.namespace_id)?;
        ensure!(
            self.message_id == record.receipt.message_id
                && self.thread_id == record.intent.target_thread_id
                && self.sequence == record.sequence
                && self.history_uuid == peer_history_uuid(record)?,
            "PEER_IDLE_WAKE_ORIGINAL_RECORD_CHANGED"
        );
        Ok(())
    }

    pub(crate) fn verify_presence(&self, witness: &PeerHistoryCommitWitness) -> Result<()> {
        self.validate(&witness.namespace_id)?;
        witness.verify_current()?;
        let (metadata, _) = witness
            .message
            .peer_agent_data()
            .context("PEER_IDLE_WAKE_TRIGGER_INVALID")?;
        ensure!(
            self.message_id == metadata.message_id
                && self.thread_id == witness.state.session_id()
                && self.history_uuid == witness.history_uuid,
            "PEER_IDLE_WAKE_ORIGINAL_HISTORY_CHANGED"
        );
        let path = witness
            .state
            .history_path()
            .context("PEER_IDLE_WAKE_ORIGINAL_HISTORY_CHANGED")?;
        crate::history_store::verify_peer_source_history_reference(&path, &self.history)?;
        let inner = witness
            .state
            .inner
            .try_read()
            .map_err(|error| match error {
                std::sync::TryLockError::WouldBlock => anyhow::anyhow!("PEER_IDLE_WAKE_STATE_BUSY"),
                std::sync::TryLockError::Poisoned(_) => {
                    anyhow::anyhow!("PEER_IDLE_WAKE_STATE_UNAVAILABLE")
                }
            })?;
        ensure!(
            witness.owner.matches_locked(&witness.state, &inner),
            "PEER_IDLE_WAKE_CONTEXT_CHANGED"
        );
        let index = inner
            .message_history_ids
            .iter()
            .zip(inner.messages.iter())
            .position(|(id, message)| {
                id.as_deref() == Some(self.history_uuid.as_str()) && message == &witness.message
            })
            .context("PEER_IDLE_WAKE_CONTEXT_CHANGED")?;
        ensure!(
            !inner
                .messages
                .iter()
                .skip(index + 1)
                .any(kcoder_types::is_real_user_message),
            "PEER_IDLE_WAKE_SUPERSEDED_BY_USER"
        );
        Ok(())
    }
}

impl AppState {
    /// Positive original User-row evidence lets that User proceed despite an
    /// unavailable peer ledger. It never refills quota or grants a peer start.
    pub async fn peer_idle_wakes_superseded_by_native_user(
        &self,
        owner: &AppStateLifecycleIdentity,
        request: &kcoder_types::SharedMessages,
    ) -> Result<bool> {
        let Some(peer) = request.iter().rposition(Message::has_peer_agent_metadata) else {
            return Ok(true);
        };
        let Some(user) = request
            .iter()
            .rposition(kcoder_types::is_real_user_message)
            .filter(|user| *user > peer)
        else {
            return Ok(false);
        };
        let message = &request[user];
        let (uuid, source, queue, session_id) = {
            let inner = self
                .inner
                .try_read()
                .map_err(|_| anyhow::anyhow!("PEER_IDLE_WAKE_USER_STATE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner),
                "PEER_IDLE_WAKE_USER_OWNER_CHANGED"
            );
            let uuid = inner
                .messages
                .iter()
                .zip(inner.message_history_ids.iter())
                .rev()
                .find(|(original, _)| *original == message)
                .and_then(|(_, id)| id.clone());
            (
                uuid,
                inner
                    .history_source
                    .clone()
                    .context("PEER_IDLE_WAKE_USER_SOURCE_UNAVAILABLE")?,
                inner
                    .history_flusher
                    .as_ref()
                    .map(|flusher| std::sync::Arc::clone(&flusher.queue)),
                inner.session_id.clone(),
            )
        };
        let Some(uuid) = uuid else {
            return Ok(false);
        };
        let generation = match source.try_bound_generation()? {
            TryHistoryGeneration::Available(value) => value,
            TryHistoryGeneration::Busy => anyhow::bail!("PEER_IDLE_WAKE_USER_SOURCE_BUSY"),
        };
        let found = crate::history_flusher::inspect_identified_history(
            source.clone(),
            queue,
            uuid,
            session_id,
            message.clone(),
        )
        .await?;
        let inner = self
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("PEER_IDLE_WAKE_USER_STATE_BUSY"))?;
        ensure!(
            owner.matches_locked(self, &inner)
                && inner
                    .history_source
                    .as_ref()
                    .is_some_and(|current| current.shares_binding(&source)),
            "PEER_IDLE_WAKE_USER_SOURCE_CHANGED"
        );
        drop(inner);
        source.check_read_binding()?;
        ensure!(
            matches!(source.try_bound_generation()?, TryHistoryGeneration::Available(current) if current == generation),
            "PEER_IDLE_WAKE_USER_SOURCE_CHANGED"
        );
        Ok(found)
    }
}

impl PeerHistoryCommitWitness {
    /// A native original-idle admission fact only. It is separate from a fresh
    /// history insertion and never grants Source, target or model permission.
    pub fn has_pending_idle_wake_admission(&self) -> bool {
        self.idle_wake_admission.is_some()
    }

    pub(crate) fn attach_idle_wake_admission(
        &mut self,
        admission: PeerIdleWakeAdmission,
    ) -> Result<()> {
        admission.verify_presence(self)?;
        self.idle_wake_admission = Some(admission);
        Ok(())
    }

    pub(crate) fn idle_wake_admission(&self) -> Option<&PeerIdleWakeAdmission> {
        self.idle_wake_admission.as_ref()
    }
}
