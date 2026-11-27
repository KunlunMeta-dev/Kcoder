//! Peer history commits use the original identified writer, never a caller's success flag.
use crate::cross_session_messages::{
    CrossSessionDeliveryLease, CrossSessionMessageRecord, PeerDeliveryCommitIdentity,
};
use crate::history_store::{HistorySource, TryHistoryGeneration};
use crate::{AppState, AppStateLifecycleIdentity};
use anyhow::{Context, Result, ensure};
use kcoder_types::{Message, peer_agent_message::PeerAgentMessageV1};
use sha2::{Digest, Sha256};

mod idle_wake;
mod reply;
pub(crate) use idle_wake::PeerIdleWakeAdmission;
pub use reply::PeerReplyReferenceWitness;
pub(crate) use reply::reply_metadata_matches;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PeerHistoryAccess {
    Observe,
    Append,
    Wake,
}

/// Host implementations must re-read current source/target scope and revocation
/// on each check. Persisted queue labels and model input never implement this policy.
#[async_trait::async_trait]
pub trait PeerMessageAuthorization: Send + Sync {
    async fn check_current(
        &self,
        access: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()>;
}

/// Private fields and no Deserialize prevent RPC/model input from fabricating a commit.
/// This proves native history presence only, never message comprehension or task success.
pub struct PeerHistoryCommitWitness {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    source: HistorySource,
    generation: Option<uuid::Uuid>,
    message: Message,
    history_uuid: String,
    namespace_id: String,
    new_context_insertion: bool,
    idle_wake_admission: Option<PeerIdleWakeAdmission>,
}

/// A one-shot failed attempt that provably did not reach the native writer.
/// It is not serializable and does not itself grant another delivery attempt.
pub struct PeerHistoryNoWriteWitness {
    state: AppState,
    owner: AppStateLifecycleIdentity,
    source: HistorySource,
    generation: Option<uuid::Uuid>,
    identity: PeerDeliveryCommitIdentity,
    history_uuid: String,
}
impl PeerHistoryNoWriteWitness {
    pub(crate) fn matches_delivery(&self, lease: &CrossSessionDeliveryLease) -> Result<()> {
        ensure!(
            lease.writer_never_attempted()
                && self.identity == lease.commit_identity()
                && self.history_uuid == peer_history_uuid(lease.record())?
                && self.owner.try_matches(&self.state) == Some(true),
            "PEER_HISTORY_NO_WRITE_PROOF_CHANGED"
        );
        let inner = self
            .state
            .inner
            .try_read()
            .map_err(|_| anyhow::anyhow!("PEER_HISTORY_STATE_BUSY"))?;
        ensure!(
            inner
                .history_source
                .as_ref()
                .is_some_and(|source| source.shares_binding(&self.source)),
            "PEER_HISTORY_SOURCE_CHANGED"
        );
        drop(inner);
        self.source.check_read_binding()?;
        ensure!(
            matches!(self.source.try_bound_generation()?,TryHistoryGeneration::Available(value) if value==self.generation),
            "PEER_HISTORY_GENERATION_CHANGED"
        );
        Ok(())
    }
}
pub struct PeerHistoryCommitError {
    error: anyhow::Error,
    no_write: Option<Box<PeerHistoryNoWriteWitness>>,
}
impl PeerHistoryCommitError {
    pub fn no_write_witness(&self) -> Option<&PeerHistoryNoWriteWitness> {
        self.no_write.as_deref()
    }
}
impl std::fmt::Display for PeerHistoryCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.error, f)
    }
}
impl std::fmt::Debug for PeerHistoryCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerHistoryCommitError")
            .field("error", &self.error)
            .field("native_writer_not_started", &self.no_write.is_some())
            .finish()
    }
}
impl std::error::Error for PeerHistoryCommitError {}
impl PeerHistoryCommitWitness {
    pub(crate) fn retained_presence(&self) -> Self {
        Self {
            state: self.state.clone(),
            owner: self.owner.clone(),
            source: self.source.clone(),
            generation: self.generation,
            message: self.message.clone(),
            history_uuid: self.history_uuid.clone(),
            namespace_id: self.namespace_id.clone(),
            new_context_insertion: false,
            idle_wake_admission: self.idle_wake_admission.clone(),
        }
    }
    pub fn message(&self) -> &Message {
        &self.message
    }
    pub fn history_uuid(&self) -> &str {
        &self.history_uuid
    }
    pub fn target_state(&self) -> &AppState {
        &self.state
    }
    /// Read-only delivery fact, never a wake permission. Recovery observations
    /// cannot prove a model has not already consumed the original contribution.
    pub fn newly_inserted_into_context(&self) -> bool {
        self.new_context_insertion
    }
    pub fn is_current(&self) -> bool {
        self.verify_current().is_ok()
    }
    pub(crate) fn verify_current(&self) -> Result<()> {
        match self.state.try_check_lifecycle_identity(&self.owner)? {
            Some(true) => {}
            Some(false) => anyhow::bail!("PEER_HISTORY_OWNER_CHANGED"),
            None => anyhow::bail!("PEER_HISTORY_STATE_BUSY"),
        }
        let inner = self.state.inner.try_read().map_err(|error| match error {
            std::sync::TryLockError::WouldBlock => anyhow::anyhow!("PEER_HISTORY_STATE_BUSY"),
            std::sync::TryLockError::Poisoned(_) => {
                anyhow::anyhow!("PEER_HISTORY_STATE_UNAVAILABLE")
            }
        })?;
        ensure!(
            inner
                .history_source
                .as_ref()
                .is_some_and(|source| source.shares_binding(&self.source)),
            "PEER_HISTORY_SOURCE_CHANGED"
        );
        drop(inner);
        self.source.check_read_binding()?;
        match self.source.try_bound_generation()? {
            TryHistoryGeneration::Available(value) => {
                ensure!(value == self.generation, "PEER_HISTORY_GENERATION_CHANGED");
            }
            TryHistoryGeneration::Busy => anyhow::bail!("PEER_HISTORY_SOURCE_BUSY"),
        }
        Ok(())
    }
    pub(crate) fn matches_record(&self, record: &CrossSessionMessageRecord) -> Result<()> {
        // Immutable corruption must not be reported as transient owner contention.
        ensure!(
            self.namespace_id == record.namespace_id
                && self.message == peer_message_for_record(record)?
                && self.history_uuid == peer_history_uuid(record)?,
            "PEER_HISTORY_RECORD_MISMATCH"
        );
        self.verify_current()
    }
}

pub fn peer_message_for_record(record: &CrossSessionMessageRecord) -> Result<Message> {
    let mut metadata = match (&record.source.address, &record.intent.target_address) {
        (Some(source), Some(target)) => PeerAgentMessageV1::for_addressed_text(
            record.receipt.message_id.clone(),
            source.clone(),
            target.clone(),
            record.created_at_ms,
            &record.intent.text,
        ),
        (None, None) => PeerAgentMessageV1::for_text(
            record.receipt.message_id.clone(),
            record.source.thread_id.clone(),
            record.intent.target_thread_id.clone(),
            record.created_at_ms,
            &record.intent.text,
        ),
        _ => anyhow::bail!("PEER_HISTORY_ADDRESS_PAIR_UNKNOWN"),
    }
    .map_err(anyhow::Error::msg)?;
    metadata
        .reply_to_message_id
        .clone_from(&record.intent.reply_to_message_id);
    Message::peer_agent_text(metadata, record.intent.text.clone()).map_err(anyhow::Error::msg)
}

/// A stable internal UUID, scoped to the full immutable source/target/body identity.
pub fn peer_history_uuid(record: &CrossSessionMessageRecord) -> Result<String> {
    ensure!(
        !record.namespace_id.is_empty(),
        "PEER_HISTORY_NAMESPACE_UNKNOWN"
    );
    let message = peer_message_for_record(record)?;
    let mut hash = Sha256::new();
    hash.update(b"kcoder.peer-agent-history.v1\0");
    hash.update(serde_json::to_vec(&(
        &record.namespace_id,
        &record.source,
        &record.intent,
        &message,
    ))?);
    let digest = hash.finalize();
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

impl AppState {
    /// Observe the original exact row under its native writer/source lock. A
    /// compacted-away current-context message may still have a valid original row.
    pub async fn observe_peer_message_commit(
        &self,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
        authority: &dyn PeerMessageAuthorization,
    ) -> Result<Option<PeerHistoryCommitWitness>> {
        authority
            .check_current(PeerHistoryAccess::Observe, self, owner, record)
            .await?;
        let message = peer_message_for_record(record)?;
        let history_uuid = peer_history_uuid(record)?;
        let (source, queue, session_id) = {
            let inner = self
                .inner
                .try_read()
                .map_err(|_| anyhow::anyhow!("PEER_HISTORY_STATE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner)
                    && inner.session_id == record.intent.target_thread_id,
                "PEER_HISTORY_TARGET_CHANGED"
            );
            ensure!(
                inner.history_path.is_some() && inner.history_write_fault.is_none(),
                "PEER_HISTORY_UNAVAILABLE"
            );
            let source = inner
                .history_source
                .clone()
                .context("PEER_HISTORY_SOURCE_UNAVAILABLE")?;
            let queue = inner
                .history_flusher
                .as_ref()
                .map(|flusher| std::sync::Arc::clone(&flusher.queue));
            (source, queue, inner.session_id.clone())
        };
        let found = crate::history_flusher::inspect_identified_history(
            source.clone(),
            queue,
            history_uuid.clone(),
            session_id,
            message.clone(),
        )
        .await?;
        if !found {
            return Ok(None);
        }
        authority
            .check_current(PeerHistoryAccess::Observe, self, owner, record)
            .await?;
        let generation = match source.try_bound_generation()? {
            TryHistoryGeneration::Available(value) => value,
            TryHistoryGeneration::Busy => anyhow::bail!("PEER_HISTORY_SOURCE_BUSY"),
        };
        let witness = PeerHistoryCommitWitness {
            state: self.clone(),
            owner: owner.clone(),
            source,
            generation,
            message,
            history_uuid,
            namespace_id: record.namespace_id.clone(),
            new_context_insertion: false,
            idle_wake_admission: None,
        };
        witness.verify_current()?;
        Ok(Some(witness))
    }

    /// Append only after a fresh authority check. Once admission occurs, dropped
    /// observers leave the original writer ticket owned and cannot trigger replay.
    pub async fn commit_peer_message(
        &self,
        owner: &AppStateLifecycleIdentity,
        lease: &CrossSessionDeliveryLease,
        authority: &dyn PeerMessageAuthorization,
    ) -> std::result::Result<PeerHistoryCommitWitness, PeerHistoryCommitError> {
        lease
            .claim_history_attempt()
            .map_err(|error| PeerHistoryCommitError {
                error,
                no_write: None,
            })?;
        match self
            .commit_peer_message_inner(owner, lease, authority)
            .await
        {
            Ok(witness) => Ok(witness),
            Err(error) => {
                let no_write = if lease.writer_never_attempted() {
                    self.prove_peer_writer_unstarted(owner, lease)
                        .await
                        .ok()
                        .map(Box::new)
                } else {
                    None
                };
                Err(PeerHistoryCommitError { error, no_write })
            }
        }
    }
    async fn prove_peer_writer_unstarted(
        &self,
        owner: &AppStateLifecycleIdentity,
        lease: &CrossSessionDeliveryLease,
    ) -> Result<PeerHistoryNoWriteWitness> {
        ensure!(
            lease.writer_never_attempted(),
            "PEER_HISTORY_WRITER_MAY_HAVE_STARTED"
        );
        let record = lease.record();
        let message = peer_message_for_record(record)?;
        let history_uuid = peer_history_uuid(record)?;
        let (source, queue, session_id, barrier) = {
            let inner = self
                .inner
                .try_read()
                .map_err(|_| anyhow::anyhow!("PEER_HISTORY_STATE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner)
                    && inner.session_id == record.intent.target_thread_id
                    && inner.history_write_fault.is_none(),
                "PEER_HISTORY_OWNER_CHANGED"
            );
            let barrier = if let Some(flusher) = &inner.history_flusher {
                let (done, reply) = tokio::sync::oneshot::channel();
                flusher
                    .send_queued(crate::history_flusher::HistoryFlusherCommand::Flush(done))
                    .map_err(|_| anyhow::anyhow!("PEER_HISTORY_BARRIER_UNAVAILABLE"))?;
                Some(reply)
            } else {
                None
            };
            (
                inner
                    .history_source
                    .clone()
                    .context("PEER_HISTORY_SOURCE_UNAVAILABLE")?,
                inner
                    .history_flusher
                    .as_ref()
                    .map(|flusher| std::sync::Arc::clone(&flusher.queue)),
                inner.session_id.clone(),
                barrier,
            )
        };
        if let Some(barrier) = barrier {
            barrier.await.context("PEER_HISTORY_BARRIER_UNKNOWN")??;
        }
        // This owned inspection is a barrier behind all earlier native commands.
        // It is internal bookkeeping and publishes no body or permission verdict.
        ensure!(
            !crate::history_flusher::inspect_identified_history(
                source.clone(),
                queue,
                history_uuid.clone(),
                session_id,
                message
            )
            .await?,
            "PEER_HISTORY_ORIGINAL_ROW_ALREADY_PRESENT"
        );
        let generation = match source.try_bound_generation()? {
            TryHistoryGeneration::Available(value) => value,
            TryHistoryGeneration::Busy => anyhow::bail!("PEER_HISTORY_SOURCE_BUSY"),
        };
        let proof = PeerHistoryNoWriteWitness {
            state: self.clone(),
            owner: owner.clone(),
            source,
            generation,
            identity: lease.commit_identity(),
            history_uuid,
        };
        proof.matches_delivery(lease)?;
        Ok(proof)
    }
    async fn commit_peer_message_inner(
        &self,
        owner: &AppStateLifecycleIdentity,
        lease: &CrossSessionDeliveryLease,
        authority: &dyn PeerMessageAuthorization,
    ) -> Result<PeerHistoryCommitWitness> {
        let record = lease.record();
        ensure!(
            record.receipt.status
                == kcoder_types::cross_session_messages::AgentMessageStatus::Delivering,
            "PEER_HISTORY_DELIVERY_NOT_RESERVED"
        );
        if let Some(witness) = self
            .observe_peer_message_commit(owner, record, authority)
            .await?
        {
            return Ok(witness);
        }
        authority
            .check_current(PeerHistoryAccess::Append, self, owner, record)
            .await?;
        let message = peer_message_for_record(record)?;
        let uuid = peer_history_uuid(record)?;
        let attempt = self.current_history_attempt_identity();
        let (flusher, epoch, entry, revision) = {
            let mut inner = self
                .inner
                .try_write()
                .map_err(|_| anyhow::anyhow!("PEER_HISTORY_STATE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner)
                    && inner.session_id == record.intent.target_thread_id
                    && inner.history_write_fault.is_none(),
                "PEER_HISTORY_TARGET_CHANGED"
            );
            ensure!(
                inner.message_history_ids.len() == inner.messages.len(),
                "PEER_HISTORY_IDENTITIES_UNKNOWN"
            );
            let source = inner
                .history_source
                .clone()
                .context("PEER_HISTORY_SOURCE_UNAVAILABLE")?;
            if inner.history_flusher.is_none() {
                let handle = tokio::runtime::Handle::try_current()
                    .context("PEER_HISTORY_RUNTIME_UNAVAILABLE")?;
                let path = inner
                    .history_path
                    .clone()
                    .context("PEER_HISTORY_PATH_UNAVAILABLE")?;
                inner.history_flusher = Some(crate::history_flusher::start_history_flusher(
                    handle, path, source,
                ));
            }
            let flusher = inner
                .history_flusher
                .as_ref()
                .context("PEER_HISTORY_WRITER_UNAVAILABLE")?
                .clone();
            let epoch = flusher.queue.current_epoch();
            let entry = crate::HistoryEntry {
                web_sources: Vec::new(),
                history_attempt: attempt,
                session_id: inner.session_id.clone(),
                timestamp_ms: crate::now_millis(),
                uuid: Some(uuid.clone()),
                parent_uuid: inner.last_history_uuid.clone(),
                message: message.clone(),
            };
            (flusher, epoch, entry, inner.message_revision.clone())
        };
        // The model sees nothing until the exact identified native write is confirmed.
        authority
            .check_current(PeerHistoryAccess::Append, self, owner, record)
            .await?;
        // Mark conservatively before calling the original writer. No failure
        // beyond this point can mint a proof that permits requeueing.
        lease.mark_writer_attempted();
        crate::history_flusher::commit_identified_peer_entry(flusher, epoch, entry.clone()).await?;
        let mut witness = self
            .observe_peer_message_commit(owner, record, authority)
            .await?
            .context("PEER_HISTORY_COMMIT_UNKNOWN")?;
        {
            let mut inner = self
                .inner
                .try_write()
                .map_err(|_| anyhow::anyhow!("PEER_HISTORY_STATE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner)
                    && inner
                        .history_source
                        .as_ref()
                        .is_some_and(|source| source.shares_binding(&witness.source)),
                "PEER_HISTORY_TARGET_CHANGED"
            );
            if let Some(index) = inner
                .message_history_ids
                .iter()
                .position(|id| id.as_deref() == Some(uuid.as_str()))
            {
                ensure!(
                    inner.messages.get(index) == Some(&message),
                    "PEER_HISTORY_CONTEXT_CONFLICT"
                );
            } else if inner.message_revision == revision {
                inner.messages.push(message);
                inner.peer_input_unacknowledged = true;
                witness.new_context_insertion = true;
                inner.message_history_ids.push(Some(uuid.clone()));
                inner.message_revision = crate::MessageRevision::default();
                inner.last_history_uuid = Some(uuid.clone());
                inner.session_updated_at_ms = inner.session_updated_at_ms.max(entry.timestamp_ms);
                crate::history_append_context::remember(&mut inner, &uuid, entry.history_attempt);
                Self::truncate_messages(&mut inner);
            }
        }
        Ok(witness)
    }
}

impl AppState {
    /// Original input provenance retained across model-context compaction.
    /// Busy/unavailable State denies implicit user-intent interpretation.
    pub fn peer_input_requires_fresh_user(&self) -> bool {
        self.inner
            .try_read()
            .map_or(true, |inner| inner.peer_input_unacknowledged)
    }

    /// Derive the default logical send identity from the original durable tool
    /// call, never a fresh random value per transport retry or model-supplied actor.
    pub async fn stable_peer_tool_client_message_id(
        &self,
        owner: &AppStateLifecycleIdentity,
        tool_call_id: &str,
        expected_tool_name: &str,
    ) -> Result<String> {
        ensure!(
            !tool_call_id.is_empty() && tool_call_id.len() <= 256 && !expected_tool_name.is_empty(),
            "PEER_TOOL_IDENTITY_INVALID"
        );
        ensure!(
            owner.try_matches(self) == Some(true),
            "PEER_SOURCE_OWNER_CHANGED"
        );
        self.flush_history().await?;
        let (source, queue, session_id, row_uuid, message) = {
            let inner = self
                .inner
                .try_read()
                .map_err(|_| anyhow::anyhow!("PEER_SOURCE_STATE_BUSY"))?;
            ensure!(
                owner.matches_locked(self, &inner)
                    && inner.message_history_ids.len() == inner.messages.len()
                    && inner.messages.len() <= 131_072,
                "PEER_SOURCE_IDENTITY_UNKNOWN"
            );
            let mut found = None;
            for (message, id) in inner.messages.iter().zip(inner.message_history_ids.iter()) {
                if let Message::Assistant { content, .. } = message {
                    for block in content {
                        if matches!(block,kcoder_types::ContentBlock::ToolUse{id,name,..} if id==tool_call_id && name==expected_tool_name)
                        {
                            ensure!(found.is_none(), "PEER_TOOL_IDENTITY_AMBIGUOUS");
                            found = Some((
                                id.clone().context("PEER_TOOL_HISTORY_UUID_UNKNOWN")?,
                                message.clone(),
                            ));
                        }
                    }
                }
            }
            let (row_uuid, message) = found.context("PEER_TOOL_HISTORY_UNKNOWN")?;
            (
                inner
                    .history_source
                    .clone()
                    .context("PEER_SOURCE_HISTORY_UNKNOWN")?,
                inner
                    .history_flusher
                    .as_ref()
                    .map(|flusher| std::sync::Arc::clone(&flusher.queue)),
                inner.session_id.clone(),
                row_uuid,
                message,
            )
        };
        ensure!(
            crate::history_flusher::inspect_identified_history(
                source,
                queue,
                row_uuid.clone(),
                session_id.clone(),
                message
            )
            .await?,
            "PEER_TOOL_HISTORY_NOT_DURABLE"
        );
        ensure!(
            owner.try_matches(self) == Some(true),
            "PEER_SOURCE_OWNER_CHANGED"
        );
        let mut hash = Sha256::new();
        hash.update(b"kcoder.peer-tool-operation.v1\0");
        hash.update(serde_json::to_vec(&(
            session_id,
            row_uuid,
            tool_call_id,
            expected_tool_name,
        ))?);
        Ok(format!("peer-{:x}", hash.finalize()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cross_session_messages::*;
    use kcoder_types::cross_session_messages::*;
    use std::{
        ffi::OsStr,
        sync::atomic::{AtomicBool, Ordering},
    };
    struct Authority {
        allowed: AtomicBool,
        source: String,
        target: String,
    }
    #[async_trait::async_trait]
    impl PeerMessageAuthorization for Authority {
        async fn check_current(
            &self,
            access: PeerHistoryAccess,
            target: &AppState,
            owner: &AppStateLifecycleIdentity,
            record: &CrossSessionMessageRecord,
        ) -> Result<()> {
            ensure!(
                owner.try_matches(target) == Some(true)
                    && target.session_id() == self.target
                    && record.source.thread_id == self.source
                    && record.intent.target_thread_id == self.target,
                "fixture_owner_changed"
            );
            ensure!(
                access == PeerHistoryAccess::Observe || self.allowed.load(Ordering::SeqCst),
                "fixture_access_revoked"
            );
            Ok(())
        }
    }
    async fn setup() -> (
        kcoder_config::PrivateTempDir,
        CrossSessionMessageStore,
        AppState,
        AppState,
        Authority,
        CrossSessionDeliveryLease,
    ) {
        let root = kcoder_config::create_private_temp_dir("peer-native-history").unwrap();
        let a = AppState::new(root.path());
        let b = AppState::new(root.path());
        let parent = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
        parent
            .create_private_child(OsStr::new("interactive-artifacts"))
            .unwrap();
        parent
            .create_private_child(OsStr::new("client-artifacts"))
            .unwrap();
        a.with_history_path(
            root.path()
                .join("interactive-artifacts")
                .join(format!("{}.jsonl", a.session_id())),
        );
        b.with_history_path(
            root.path()
                .join("client-artifacts")
                .join(format!("{}.jsonl", b.session_id())),
        );
        a.add_message(Message::user_text("Original source user task"));
        b.add_message(Message::user_text("Original target user task"));
        a.flush_history().await.unwrap();
        b.flush_history().await.unwrap();
        let store = CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("queue"),
            &CrossSessionMessageScope {
                account_id: "account".into(),
                target_id: "target".into(),
                workspace_id: "workspace".into(),
            },
        )
        .unwrap();
        let authority = Authority {
            allowed: AtomicBool::new(true),
            source: a.session_id(),
            target: b.session_id(),
        };
        store
            .enqueue(
                &CrossSessionMessageSource {
                    thread_id: a.session_id(),
                    principal_id: "principal".into(),
                    address: None,
                },
                AgentMessageIntent {
                    reply_to_message_id: None,
                    target_thread_id: b.session_id(),
                    target_address: None,
                    client_message_id: "stable-request".into(),
                    mode: AgentMessageMode::EnqueueOnly,
                    expected_turn_id: None,
                    text: "Peer contribution; original user request remains authoritative".into(),
                },
                1,
            )
            .unwrap();
        let lease = store
            .reserve_next(&b.session_id(), 2, 100, 200)
            .unwrap()
            .unwrap();
        (root, store, a, b, authority, lease)
    }
    #[tokio::test]
    async fn immutable_record_mismatch_is_not_hidden_by_actual_state_lock_contention() {
        let (_root, _store, _source, target, authority, lease) = setup().await;
        let owner = target.inspection_lifecycle_identity();
        let witness = target
            .commit_peer_message(&owner, &lease, &authority)
            .await
            .unwrap();
        let record = lease.record().clone();
        let mut changed = record.clone();
        changed.intent.text.push_str(" changed");
        let held = target.inner.write().unwrap();
        let busy = witness.matches_record(&record).unwrap_err();
        assert!(crate::PeerAutoWakePermit::is_temporary_start_contention(
            &busy
        ));
        let mismatch = witness.matches_record(&changed).unwrap_err();
        assert_eq!(mismatch.to_string(), "PEER_HISTORY_RECORD_MISMATCH");
        assert!(!crate::PeerAutoWakePermit::is_temporary_start_contention(
            &mismatch
        ));
        drop(held);
        witness.matches_record(&record).unwrap();
    }

    #[tokio::test]
    async fn native_peer_witness_survives_canonical_tool_result_append_and_flush() {
        use kcoder_types::{ContentBlock, MessageOrigin, TurnAttemptIdentity};
        let (_root, _store, _source, target, authority, lease) = setup().await;
        let owner = target.inspection_lifecycle_identity();
        let witness = target
            .commit_peer_message(&owner, &lease, &authority)
            .await
            .unwrap();
        let original_generation = witness.generation;
        let scope = target
            .history_attempt_scope(TurnAttemptIdentity {
                thread_id: target.session_id(),
                turn_id: "actual-peer-turn".into(),
                attempt_id: "actual-peer-attempt".into(),
            })
            .unwrap();
        scope
            .run(async {
                target.add_message(Message::Assistant {
                    content: vec![ContentBlock::ToolUse {
                        id: "original-ack-tool".into(),
                        name: "SendSessionMessage".into(),
                        input: serde_json::json!({"mode":"enqueue_only","text":"Original ACK"}),
                    }],
                    usage: None,
                });
                target.add_message(
                    Message::user_content(vec![ContentBlock::ToolResult {
                        tool_use_id: "original-ack-tool".into(),
                        content: vec![ContentBlock::Text {
                            text: "Original ACK queued".into(),
                        }],
                        is_error: Some(false),
                    }])
                    .with_origin(MessageOrigin::Runtime),
                );
                target.flush_history().await.unwrap();
                witness.verify_current().unwrap();
                assert_eq!(witness.generation, original_generation);
                assert_eq!(
                    target
                        .messages()
                        .iter()
                        .filter(|message| kcoder_types::is_real_user_message(message))
                        .count(),
                    1
                );
                let rows = crate::load_transcript_history(&target.history_path().unwrap()).unwrap();
                assert_eq!(
                    rows.iter()
                        .filter(|row| row.uuid.as_deref() == Some(witness.history_uuid()))
                        .count(),
                    1
                );
            })
            .await;
    }

    #[tokio::test]
    async fn exact_peer_native_row_and_opaque_witness_apply_once_without_user_reclassification() {
        let (_root, store, a, b, authority, lease) = setup().await;
        assert_ne!(
            a.history_path().unwrap().parent(),
            b.history_path().unwrap().parent()
        );
        let owner = b.inspection_lifecycle_identity();
        let witness = b
            .commit_peer_message(&owner, &lease, &authority)
            .await
            .unwrap();
        assert!(witness.newly_inserted_into_context());
        let mut wrong = lease.record().clone();
        wrong.source.address = Some(kcoder_types::session_address::SessionAddressV1 {
            target_id: "different-source-target".into(),
            workspace_id: "different-source-space".into(),
            thread_id: wrong.source.thread_id.clone(),
        });
        wrong.intent.target_address = Some(kcoder_types::session_address::SessionAddressV1 {
            target_id: store.scope().target_id.clone(),
            workspace_id: store.scope().workspace_id.clone(),
            thread_id: wrong.intent.target_thread_id.clone(),
        });
        assert!(
            witness.matches_record(&wrong).is_err(),
            "a native commit cannot be rebound to different complete addresses"
        );
        let applied = store.finish_applied(&lease, &witness, 3).unwrap();
        assert_eq!(applied.status, AgentMessageStatus::Applied);
        let duplicate = b
            .observe_peer_message_commit(&owner, lease.record(), &authority)
            .await
            .unwrap()
            .unwrap();
        assert!(
            b.commit_peer_message(&owner, &lease, &authority)
                .await
                .err()
                .unwrap()
                .no_write_witness()
                .is_none(),
            "an already attempted lease never authorizes a second writer"
        );
        assert_eq!(
            store.finish_applied(&lease, &duplicate, 3).unwrap(),
            applied
        );
        let rows = crate::load_transcript_history(&b.history_path().unwrap()).unwrap();
        assert_eq!(
            rows.iter()
                .filter(|row| row.uuid.as_deref() == Some(witness.history_uuid()))
                .count(),
            1
        );
        assert_eq!(
            rows.iter()
                .filter(|row| row.message.origin() == kcoder_types::MessageOrigin::PeerAgent)
                .count(),
            1
        );
        assert_eq!(
            b.messages()
                .iter()
                .filter(|message| kcoder_types::is_real_user_message(message))
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn only_an_opaque_pre_writer_failure_can_defer_its_exact_lease_and_retry_once() {
        use std::sync::atomic::AtomicUsize;
        struct FailSecondAppend {
            base: Authority,
            appends: AtomicUsize,
        }
        #[async_trait::async_trait]
        impl PeerMessageAuthorization for FailSecondAppend {
            async fn check_current(
                &self,
                access: PeerHistoryAccess,
                target: &AppState,
                owner: &AppStateLifecycleIdentity,
                record: &CrossSessionMessageRecord,
            ) -> Result<()> {
                self.base
                    .check_current(access, target, owner, record)
                    .await?;
                if access == PeerHistoryAccess::Append
                    && self.appends.fetch_add(1, Ordering::SeqCst) == 1
                {
                    anyhow::bail!(
                        "owned original Source temporarily busy before identified writer"
                    );
                }
                Ok(())
            }
        }
        let (_root, store, _a, b, base, lease) = setup().await;
        let authority = FailSecondAppend {
            base,
            appends: AtomicUsize::new(0),
        };
        let owner = b.inspection_lifecycle_identity();
        let error = b
            .commit_peer_message(&owner, &lease, &authority)
            .await
            .err()
            .unwrap();
        let proof = error
            .no_write_witness()
            .expect("State proved no command for this unique lease reached the writer");
        assert!(
            crate::load_transcript_history(&b.history_path().unwrap())
                .unwrap()
                .iter()
                .all(|row| !row.message.has_peer_agent_metadata())
        );
        let queued = store.defer_unstarted(&lease, proof, 3).unwrap();
        assert_eq!(queued.status, AgentMessageStatus::Queued);
        assert!(store.defer_unstarted(&lease, proof, 4).is_err());
        assert!(
            b.commit_peer_message(&owner, &lease, &authority)
                .await
                .err()
                .unwrap()
                .no_write_witness()
                .is_none()
        );
        let next = store
            .reserve_next(&b.session_id(), 4, 300, 400)
            .unwrap()
            .unwrap();
        assert!(
            store.defer_unstarted(&next, proof, 5).is_err(),
            "a proof cannot cross delivery nonces or fences"
        );
        let witness = b
            .commit_peer_message(&owner, &next, &authority)
            .await
            .unwrap();
        assert_eq!(
            store.finish_applied(&next, &witness, 5).unwrap().message_id,
            queued.message_id
        );
        assert_eq!(
            crate::load_transcript_history(&b.history_path().unwrap())
                .unwrap()
                .iter()
                .filter(|row| row.message.has_peer_agent_metadata())
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn lost_queue_receipt_and_compacted_context_reconcile_original_history_without_reinsertion()
     {
        let (_root, store, _a, b, authority, lease) = setup().await;
        let owner = b.inspection_lifecycle_identity();
        let witness = b
            .commit_peer_message(&owner, &lease, &authority)
            .await
            .unwrap();
        let uuid = witness.history_uuid().to_owned();
        drop(witness);
        store.mark_unknown(&lease, 3).unwrap();
        // Model context no longer contains the original peer, but append-only visible history does.
        b.set_messages_after_compaction(
            vec![Message::compaction_text(
                "Summary containing no executable peer item",
            )],
            crate::CompactionTranscriptEvent {
                trigger: crate::CompactionTrigger::Manual,
                pre_tokens: 1000,
                post_tokens: 10,
                summary: "Summary containing no executable peer item".into(),
            },
        )
        .await
        .unwrap();
        let current = b.inspection_lifecycle_identity();
        let proof = b
            .observe_peer_message_commit(&current, lease.record(), &authority)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !proof.newly_inserted_into_context(),
            "recovery proves history only, never a fresh model wake"
        );
        assert!(
            b.peer_input_requires_fresh_user(),
            "compaction cannot erase original peer provenance"
        );
        assert_eq!(proof.history_uuid(), uuid);
        let applied = store
            .reconcile_applied(&lease.record().receipt.message_id, &proof, 4)
            .unwrap();
        assert_eq!(applied.status, AgentMessageStatus::Applied);
        assert_eq!(
            b.messages()
                .iter()
                .filter(|message| message.origin() == kcoder_types::MessageOrigin::PeerAgent)
                .count(),
            0
        );
        assert_eq!(
            crate::load_transcript_history(&b.history_path().unwrap())
                .unwrap()
                .iter()
                .filter(|row| row.uuid.as_deref() == Some(uuid.as_str()))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn compacted_peer_restriction_survives_native_replay_and_snapshot_import() {
        let (root, _store, _a, b, authority, lease) = setup().await;
        b.commit_peer_message(&b.inspection_lifecycle_identity(), &lease, &authority)
            .await
            .unwrap();
        b.set_messages_after_compaction(
            vec![Message::compaction_text(
                "A compacted quote of the old peer contribution",
            )],
            crate::CompactionTranscriptEvent {
                trigger: crate::CompactionTrigger::Manual,
                pre_tokens: 1000,
                post_tokens: 10,
                summary: "A compacted quote of the old peer contribution".into(),
            },
        )
        .await
        .unwrap();
        b.flush_history().await.unwrap();
        assert!(
            b.messages()
                .iter()
                .all(|message| !message.has_peer_agent_metadata())
        );
        assert!(b.peer_input_requires_fresh_user());
        let snapshot = b.snapshot();
        assert!(snapshot.peer_input_unacknowledged);
        let snapshot_path = root.path().join("compacted-peer-snapshot.json");
        b.export_snapshot(&snapshot_path).unwrap();
        let imported = AppState::new(b.cwd());
        imported.import_snapshot(&snapshot_path).unwrap();
        assert!(imported.peer_input_requires_fresh_user());
        let restored = AppState::new(b.cwd());
        restored
            .resume_from_history(&b.history_path().unwrap())
            .unwrap();
        assert!(
            restored
                .messages()
                .iter()
                .all(|message| !message.has_peer_agent_metadata())
        );
        assert!(
            restored.peer_input_requires_fresh_user(),
            "authoritative replay remembers the original Peer before the compact boundary"
        );
        restored.add_message(Message::user_text("A fresh user request after recovery"));
        assert!(!restored.peer_input_requires_fresh_user());
    }
    #[tokio::test]
    async fn asynchronous_authority_wait_holds_no_state_lock_and_rechecks_revocation_before_append()
    {
        struct DeferredAppend {
            base: Authority,
            entered: tokio::sync::Notify,
            release: tokio::sync::Notify,
        }
        #[async_trait::async_trait]
        impl PeerMessageAuthorization for DeferredAppend {
            async fn check_current(
                &self,
                access: PeerHistoryAccess,
                target: &AppState,
                owner: &AppStateLifecycleIdentity,
                record: &CrossSessionMessageRecord,
            ) -> Result<()> {
                if access == PeerHistoryAccess::Append {
                    self.entered.notify_one();
                    self.release.notified().await;
                }
                self.base.check_current(access, target, owner, record).await
            }
        }
        let (_root, _store, _a, b, base, lease) = setup().await;
        let authority = std::sync::Arc::new(DeferredAppend {
            base,
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
        });
        let state = b.clone();
        let owner = b.inspection_lifecycle_identity();
        let guard = authority.clone();
        let pending = tokio::spawn(async move {
            state
                .commit_peer_message(&owner, &lease, guard.as_ref())
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            authority.entered.notified(),
        )
        .await
        .unwrap();
        assert!(
            b.inner.try_write().is_ok(),
            "the current-thread source round trip never retains the target State lock"
        );
        authority.base.allowed.store(false, Ordering::SeqCst);
        authority.release.notify_one();
        assert!(pending.await.unwrap().is_err());
        assert!(
            crate::load_transcript_history(&b.history_path().unwrap())
                .unwrap()
                .iter()
                .all(|entry| !entry.message.has_peer_agent_metadata())
        );
        assert!(
            b.messages()
                .iter()
                .all(|message| !message.has_peer_agent_metadata())
        );
    }
    #[tokio::test]
    async fn revoked_append_and_foreign_target_do_not_write_and_unknown_is_not_replayed() {
        let (_root, store, a, b, authority, lease) = setup().await;
        authority.allowed.store(false, Ordering::SeqCst);
        let owner = b.inspection_lifecycle_identity();
        assert!(
            b.commit_peer_message(&owner, &lease, &authority)
                .await
                .is_err()
        );
        assert!(
            a.commit_peer_message(&a.inspection_lifecycle_identity(), &lease, &authority)
                .await
                .is_err()
        );
        assert!(
            b.observe_peer_message_commit(&owner, lease.record(), &authority)
                .await
                .unwrap()
                .is_none()
        );
        let unknown = store.mark_unknown(&lease, 3).unwrap();
        let record = store
            .get_record_by_message_id(&unknown.message_id)
            .unwrap()
            .unwrap();
        assert_eq!(record.receipt.status, AgentMessageStatus::Unknown);
        authority.allowed.store(true, Ordering::SeqCst);
        assert!(
            b.commit_peer_message(&owner, &lease, &authority)
                .await
                .is_err(),
            "an unknown outcome cannot start a new append"
        );
        assert_eq!(b.messages().len(), 1);
    }
    #[tokio::test]
    async fn unconfirmed_peer_native_write_never_enters_the_running_model_context() {
        use std::sync::atomic::AtomicUsize;
        struct LostObservation {
            base: Authority,
            checks: AtomicUsize,
            fail: AtomicBool,
        }
        #[async_trait::async_trait]
        impl PeerMessageAuthorization for LostObservation {
            async fn check_current(
                &self,
                access: PeerHistoryAccess,
                target: &AppState,
                owner: &AppStateLifecycleIdentity,
                record: &CrossSessionMessageRecord,
            ) -> Result<()> {
                self.base
                    .check_current(access, target, owner, record)
                    .await?;
                if access == PeerHistoryAccess::Observe
                    && self.checks.fetch_add(1, Ordering::SeqCst) > 0
                    && self.fail.load(Ordering::SeqCst)
                {
                    anyhow::bail!("fixture_commit_observation_lost");
                }
                Ok(())
            }
        }
        let (_root, store, _a, b, base, lease) = setup().await;
        let authority = LostObservation {
            base,
            checks: AtomicUsize::new(0),
            fail: AtomicBool::new(true),
        };
        let owner = b.inspection_lifecycle_identity();
        let failure = b
            .commit_peer_message(&owner, &lease, &authority)
            .await
            .err()
            .unwrap();
        assert!(
            failure.no_write_witness().is_none(),
            "a writer that committed but lost observation can never be requeued"
        );
        assert_eq!(
            b.messages().len(),
            1,
            "a failed peer observer must not contaminate an unrelated current user turn"
        );
        let raw = crate::load_transcript_history(&b.history_path().unwrap()).unwrap();
        assert_eq!(
            raw.iter()
                .filter(|entry| entry.message.origin() == kcoder_types::MessageOrigin::PeerAgent)
                .count(),
            1,
            "the lost result does not claim the native write never executed"
        );
        store.mark_unknown(&lease, 3).unwrap();
        authority.fail.store(false, Ordering::SeqCst);
        let witness = b
            .observe_peer_message_commit(&owner, lease.record(), &authority)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            store
                .reconcile_applied(&lease.record().receipt.message_id, &witness, 4)
                .unwrap()
                .status,
            AgentMessageStatus::Applied
        );
        assert_eq!(
            b.messages().len(),
            1,
            "read reconciliation does not replay the peer into model context"
        );
    }
}
