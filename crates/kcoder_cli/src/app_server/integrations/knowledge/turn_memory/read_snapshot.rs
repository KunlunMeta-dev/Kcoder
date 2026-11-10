//! Canonical audit reads never capture, initialize, refresh or infer acceptance from an ID shape.
use super::{NativeReviewedMemorySource, snapshot_key};
use crate::app_server::integrations::core::NativeIntegrationContext;
use crate::app_server::integrations::knowledge::rpc::configuration::EngineSnapshot;
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_engine::QueryEngine;
use kcoder_state::{
    AppStateIdentity,
    turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore},
};
use kcoder_types::integrations::{
    core::{IntegrationRecovery, IntegrationStatus},
    knowledge::{KnowledgeOwner, MemoryReviewStatus, MemoryTaskSnapshot},
};
use sha2::{Digest, Sha256};
use std::{ffi::OsStr, path::PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeMemorySnapshotReadError {
    InvalidRequest,
    Denied,
    NotFound,
    Unavailable,
}
impl NativeMemorySnapshotReadError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "MEMORY_TASK_SNAPSHOT_INVALID_REQUEST",
            Self::Denied => "MEMORY_TASK_SNAPSHOT_DENIED",
            Self::NotFound => "MEMORY_TASK_SNAPSHOT_NOT_FOUND",
            Self::Unavailable => "MEMORY_TASK_SNAPSHOT_UNAVAILABLE",
        }
    }
    pub(crate) const fn status(self) -> IntegrationStatus {
        if matches!(self, Self::Unavailable) {
            IntegrationStatus::Unavailable
        } else {
            IntegrationStatus::Rejected
        }
    }
    pub(crate) const fn recovery(self) -> IntegrationRecovery {
        match self {
            Self::Denied => IntegrationRecovery::RequestAuthorization,
            Self::Unavailable => IntegrationRecovery::RepairConfiguration,
            _ => IntegrationRecovery::None,
        }
    }
}
impl std::fmt::Display for NativeMemorySnapshotReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for NativeMemorySnapshotReadError {}

struct AcceptanceWitness {
    identity: kcoder_types::TurnAttemptIdentity,
    facts: String,
}
struct HistoricalTurn {
    state: AppStateIdentity,
    thread: String,
    path: PathBuf,
    session: PrivateDirectory,
    attempts: PrivateDirectory,
    witnesses: Vec<AcceptanceWitness>,
    first_accepted_ms: u64,
}
fn accepted_facts(record: &TurnAttemptRecord) -> Result<String> {
    record.validate()?;
    ensure!(
        record.status.is_known() && record.request_fingerprint.is_some(),
        "MEMORY_TASK_ACCEPTANCE_UNAVAILABLE"
    );
    // Completion may legitimately settle during an audit read; the original acceptance stays fixed.
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&serde_json::json!({
            "version":record.version,"identity":record.identity,"parentAttemptId":record.parent_attempt_id,
            "retryOperationId":record.retry_operation_id,"acceptedAtMs":record.accepted_at_ms,
            "inputContextHash":record.input_context_hash,"requestFingerprint":record.request_fingerprint,
            "retainedInput":record.retained_input,"clientPresentation":record.client_presentation,
        }))?)
    ))
}
impl HistoricalTurn {
    fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        snapshot_id: &str,
    ) -> std::result::Result<Self, NativeMemorySnapshotReadError> {
        let perform = || -> Result<_> {
            let thread = engine.session_id();
            let path = engine.session_storage_dir_for(&thread);
            let session = PrivateDirectory::open_existing(&path)?;
            session.verify_private_directory()?;
            let attempts = session.open_child(OsStr::new("turn-attempts"), false)?;
            attempts.verify_private_directory()?;
            let store = TurnAttemptStore::open_existing(&path, &thread)?
                .context("MEMORY_TASK_ACCEPTANCE_UNAVAILABLE")?;
            let mut witnesses = Vec::new();
            let mut first_accepted_ms = u64::MAX;
            for record in store.list()? {
                if snapshot_key(native, &record.identity)? != snapshot_id {
                    continue;
                }
                let facts = accepted_facts(&record)?;
                first_accepted_ms = first_accepted_ms.min(record.accepted_at_ms);
                witnesses.push(AcceptanceWitness {
                    identity: record.identity,
                    facts,
                });
            }
            Ok((
                thread,
                path,
                session,
                attempts,
                witnesses,
                first_accepted_ms,
            ))
        };
        let (thread, path, session, attempts, witnesses, first_accepted_ms) =
            perform().map_err(|_| NativeMemorySnapshotReadError::Unavailable)?;
        if witnesses.is_empty() {
            return Err(NativeMemorySnapshotReadError::NotFound);
        }
        let proof = Self {
            state: engine.state.inspection_identity(),
            thread,
            path,
            session,
            attempts,
            witnesses,
            first_accepted_ms,
        };
        proof
            .verify(engine)
            .map_err(|_| NativeMemorySnapshotReadError::Unavailable)?;
        Ok(proof)
    }
    fn verify(&self, engine: &QueryEngine) -> Result<()> {
        ensure!(
            self.state.matches(&engine.state)
                && engine.session_id() == self.thread
                && engine.session_storage_dir_for(&self.thread) == self.path,
            "MEMORY_TASK_THREAD_CHANGED"
        );
        self.session.verify_private_directory()?;
        self.attempts.verify_private_directory()?;
        let current = PrivateDirectory::open_existing(&self.path)?;
        let attempts = current.open_child(OsStr::new("turn-attempts"), false)?;
        ensure!(
            current.directory_identity()? == self.session.directory_identity()?
                && attempts.directory_identity()? == self.attempts.directory_identity()?,
            "MEMORY_TASK_ACCEPTANCE_STORAGE_CHANGED"
        );
        let store = TurnAttemptStore::open_existing(&self.path, &self.thread)?
            .context("MEMORY_TASK_ACCEPTANCE_UNAVAILABLE")?;
        for witness in &self.witnesses {
            let record = store
                .load(&witness.identity)?
                .context("MEMORY_TASK_ACCEPTANCE_UNAVAILABLE")?;
            ensure!(
                accepted_facts(&record)? == witness.facts,
                "MEMORY_TASK_ACCEPTANCE_CHANGED"
            );
        }
        Ok(())
    }
}

fn validate_snapshot(
    snapshot: &MemoryTaskSnapshot,
    native: &NativeIntegrationContext,
    id: &str,
    accepted_ms: u64,
) -> Result<()> {
    let owner = KnowledgeOwner::from(native.scope());
    ensure!(
        snapshot.task_id == id && snapshot.owner == owner && snapshot.captured_at_ms >= accepted_ms,
        "MEMORY_TASK_SNAPSHOT_BINDING_MISMATCH"
    );
    ensure!(
        snapshot.memories.len() <= 64 && serde_json::to_vec(snapshot)?.len() <= 96 * 1024,
        "MEMORY_TASK_SNAPSHOT_TOO_LARGE"
    );
    ensure!(
        snapshot.memories.iter().all(|memory| memory.owner == owner
            && memory.review_status == MemoryReviewStatus::Confirmed
            && memory.enabled
            && !memory.deleted),
        "MEMORY_TASK_SNAPSHOT_INVALID"
    );
    Ok(())
}

/// Root must select the authorized actual thread Engine; the opaque ID alone proves nothing.
pub(crate) fn read_thread_memory_snapshot(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    snapshot_id: &str,
    source: Option<&dyn NativeReviewedMemorySource>,
) -> std::result::Result<MemoryTaskSnapshot, NativeMemorySnapshotReadError> {
    use NativeMemorySnapshotReadError as Failure;
    if snapshot_id.trim().is_empty() || snapshot_id.len() > 256 {
        return Err(Failure::InvalidRequest);
    }
    native.verify().map_err(|_| Failure::Denied)?;
    let binding = EngineSnapshot::capture(engine).map_err(|_| Failure::Unavailable)?;
    binding
        .verify_binding(engine, native)
        .map_err(|_| Failure::Denied)?;
    let source = source.ok_or(Failure::Unavailable)?;
    let store = source
        .verified_store(native)
        .map_err(|_| Failure::Unavailable)?;
    if *store.owner() != KnowledgeOwner::from(native.scope()) {
        return Err(Failure::Denied);
    }
    let source_identity = store
        .storage_directory_identity()
        .map_err(|_| Failure::Unavailable)?;
    let proof = HistoricalTurn::capture(native, engine, snapshot_id)?;
    let snapshot = store
        .read_task_snapshot(snapshot_id)
        .map_err(|_| Failure::Unavailable)?
        .ok_or(Failure::NotFound)?;
    validate_snapshot(&snapshot, native, snapshot_id, proof.first_accepted_ms)
        .map_err(|_| Failure::Unavailable)?;
    proof.verify(engine).map_err(|_| Failure::Unavailable)?;
    native.verify().map_err(|_| Failure::Denied)?;
    EngineSnapshot::capture(engine)
        .and_then(|current| current.verify_binding(engine, native))
        .map_err(|_| Failure::Denied)?;
    let current = source
        .verified_store(native)
        .map_err(|_| Failure::Unavailable)?;
    if *current.owner() != KnowledgeOwner::from(native.scope()) {
        return Err(Failure::Denied);
    }
    if current
        .storage_directory_identity()
        .map_err(|_| Failure::Unavailable)?
        != source_identity
        || current
            .read_task_snapshot(snapshot_id)
            .map_err(|_| Failure::Unavailable)?
            .as_ref()
            != Some(&snapshot)
    {
        return Err(Failure::Unavailable);
    }
    proof.verify(engine).map_err(|_| Failure::Unavailable)?;
    native.verify().map_err(|_| Failure::Denied)?;
    Ok(snapshot)
}
