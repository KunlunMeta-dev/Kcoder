//! Private, immutable-identity attempt ledger. Semantic model snapshot bytes are
//! supplied by the model layer, which must serialize its credential-free typed snapshot.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use kcoder_types::{ProviderFailureDetails, TurnAttemptIdentity, TurnAttemptStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    path::Path,
};

const MAX_RECORD_BYTES: usize = 1024 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnAttemptRecord {
    pub version: u8,
    pub identity: TurnAttemptIdentity,
    pub parent_attempt_id: Option<String>,
    pub retry_operation_id: Option<String>,
    pub accepted_at_ms: u64,
    pub input_context_hash: String,
    /// Canonical request digest only; raw request options and secrets stay out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_fingerprint: Option<String>,
    pub status: TurnAttemptStatus,
    pub completion: Option<TurnAttemptCompletion>,
}
impl TurnAttemptRecord {
    pub fn validate(&self) -> Result<()> {
        validate_record(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnAttemptCompletion {
    pub status: TurnAttemptStatus,
    pub finished_at_ms: u64,
    pub error: Option<String>,
    pub provider_failure: Option<ProviderFailureDetails>,
    /// Uncommitted visible output only; it must never be restored as model context.
    pub partial_output: String,
    pub partial_output_truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed_history_uuid: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ModelSnapshotArtifact {
    version: u8,
    identity: TurnAttemptIdentity,
    snapshot: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnAttemptBeginOutcome {
    Created(TurnAttemptRecord),
    Existing(TurnAttemptRecord),
}
impl TurnAttemptBeginOutcome {
    pub fn record(&self) -> &TurnAttemptRecord {
        match self {
            Self::Created(record) | Self::Existing(record) => record,
        }
    }
}

pub struct TurnAttemptStore {
    directory: PrivateDirectory,
    thread_id: String,
}
impl TurnAttemptStore {
    /// The caller supplies the already-authorized per-session storage directory.
    pub fn open(session_directory: &Path, thread_id: &str) -> Result<Self> {
        ensure!(
            !thread_id.trim().is_empty() && thread_id.len() <= 256,
            "invalid attempt thread identity"
        );
        ensure!(
            session_directory.file_name() == Some(OsStr::new(thread_id)),
            "attempt storage thread mismatch"
        );
        Ok(Self {
            directory: PrivateDirectory::open_or_create(&session_directory.join("turn-attempts"))?,
            thread_id: thread_id.into(),
        })
    }
    /// Read-only opening never creates missing attempt directories.
    pub fn open_existing(session_directory: &Path, thread_id: &str) -> Result<Option<Self>> {
        ensure!(
            !thread_id.trim().is_empty() && thread_id.len() <= 256,
            "invalid attempt thread identity"
        );
        ensure!(
            session_directory.file_name() == Some(OsStr::new(thread_id)),
            "attempt storage thread mismatch"
        );
        match PrivateDirectory::open_existing(&session_directory.join("turn-attempts")) {
            Ok(directory) => Ok(Some(Self {
                directory,
                thread_id: thread_id.into(),
            })),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
    fn check_identity(&self, identity: &TurnAttemptIdentity) -> Result<()> {
        identity.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            identity.thread_id == self.thread_id,
            "attempt belongs to another thread"
        );
        Ok(())
    }
    fn lock(&self) -> Result<File> {
        self.directory.append(OsStr::new("attempts.lock"), b"")?;
        let lock = self
            .directory
            .open_regular_file(OsStr::new("attempts.lock"))?;
        lock.lock_exclusive()
            .context("cannot lock attempt ledger")?;
        Ok(lock)
    }
    fn read_bytes(&self, name: &OsStr, limit: usize) -> Result<Option<Vec<u8>>> {
        let file = match self.directory.open_regular_file(name) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= limit, "attempt artifact exceeds size limit");
        Ok(Some(bytes))
    }
    pub fn load(&self, identity: &TurnAttemptIdentity) -> Result<Option<TurnAttemptRecord>> {
        self.check_identity(identity)?;
        let Some(bytes) = self.read_bytes(&leaf(identity, "attempt"), MAX_RECORD_BYTES)? else {
            return Ok(None);
        };
        let record: TurnAttemptRecord =
            serde_json::from_slice(&bytes).context("invalid attempt record")?;
        validate_record(&record)?;
        ensure!(
            record.identity == *identity,
            "attempt record identity mismatch"
        );
        Ok(Some(record))
    }
    pub fn begin(&self, record: TurnAttemptRecord) -> Result<TurnAttemptBeginOutcome> {
        self.check_identity(&record.identity)?;
        validate_record(&record)?;
        ensure!(
            record.status == TurnAttemptStatus::Accepted && record.completion.is_none(),
            "new attempt is already terminal"
        );
        let _lock = self.lock()?;
        if let Some(existing) = self.load(&record.identity)? {
            ensure!(
                existing.parent_attempt_id == record.parent_attempt_id
                    && existing.retry_operation_id == record.retry_operation_id
                    && existing.input_context_hash == record.input_context_hash
                    && existing.request_fingerprint == record.request_fingerprint,
                "attempt identity was reused for another operation"
            );
            return Ok(TurnAttemptBeginOutcome::Existing(existing));
        }
        self.write_record(&record)?;
        Ok(TurnAttemptBeginOutcome::Created(record))
    }
    pub fn finish(
        &self,
        identity: &TurnAttemptIdentity,
        completion: TurnAttemptCompletion,
    ) -> Result<TurnAttemptRecord> {
        self.check_identity(identity)?;
        ensure!(
            completion.status != TurnAttemptStatus::Accepted,
            "completion must be terminal"
        );
        let _lock = self.lock()?;
        let mut record = self.load(identity)?.context("attempt was not accepted")?;
        if let Some(previous) = &record.completion {
            ensure!(
                previous.status == completion.status
                    && previous.error == completion.error
                    && previous.provider_failure == completion.provider_failure
                    && previous.partial_output == completion.partial_output
                    && previous.partial_output_truncated == completion.partial_output_truncated
                    && previous.committed_history_uuid == completion.committed_history_uuid,
                "terminal attempt cannot be rewritten"
            );
            return Ok(record);
        }
        record.status = completion.status;
        record.completion = Some(completion);
        self.write_record(&record)?;
        Ok(record)
    }
    fn write_record(&self, record: &TurnAttemptRecord) -> Result<()> {
        validate_record(record)?;
        let bytes = serde_json::to_vec(record)?;
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES,
            "attempt record exceeds size limit"
        );
        self.directory
            .atomic_replace(&leaf(&record.identity, "attempt"), &bytes)
    }
    /// Write once. Model semantics cannot be replaced by newer defaults during recovery.
    /// No Settings/Provider object belongs here: callers must remove all credential material.
    pub fn save_model_snapshot(&self, identity: &TurnAttemptIdentity, bytes: &[u8]) -> Result<()> {
        self.check_identity(identity)?;
        ensure!(
            bytes.len() <= MAX_SNAPSHOT_BYTES,
            "model snapshot exceeds size limit"
        );
        let snapshot: serde_json::Value = serde_json::from_slice(bytes)?;
        ensure!(
            snapshot.is_object(),
            "model snapshot must be a typed JSON object"
        );
        let _lock = self.lock()?;
        if let Some(existing) = self.load_model_snapshot(identity)? {
            ensure!(
                serde_json::from_slice::<serde_json::Value>(&existing)? == snapshot,
                "attempt model snapshot is immutable"
            );
            return Ok(());
        }
        let artifact = ModelSnapshotArtifact {
            version: 1,
            identity: identity.clone(),
            snapshot,
        };
        let bytes = serde_json::to_vec(&artifact)?;
        ensure!(
            bytes.len() <= MAX_SNAPSHOT_BYTES + 2048,
            "model snapshot artifact exceeds size limit"
        );
        self.directory
            .atomic_replace(&leaf(identity, "model"), &bytes)
    }
    pub fn load_model_snapshot(&self, identity: &TurnAttemptIdentity) -> Result<Option<Vec<u8>>> {
        self.check_identity(identity)?;
        let Some(bytes) = self.read_bytes(&leaf(identity, "model"), MAX_SNAPSHOT_BYTES + 2048)?
        else {
            return Ok(None);
        };
        let artifact: ModelSnapshotArtifact = serde_json::from_slice(&bytes)?;
        ensure!(
            artifact.version == 1
                && artifact.identity == *identity
                && artifact.snapshot.is_object(),
            "model snapshot identity mismatch"
        );
        Ok(Some(serde_json::to_vec(&artifact.snapshot)?))
    }
    pub fn list(&self) -> Result<Vec<TurnAttemptRecord>> {
        let files = self
            .directory
            .open_regular_files(|name| name.to_string_lossy().ends_with(".attempt.json"))?;
        ensure!(
            files.len() <= 10_000,
            "attempt ledger enumeration exceeds limit"
        );
        let mut records = Vec::new();
        let mut total = 0usize;
        for (name, file) in files {
            let mut bytes = Vec::new();
            file.take(MAX_RECORD_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            total = total.saturating_add(bytes.len());
            ensure!(
                bytes.len() <= MAX_RECORD_BYTES && total <= 64 * 1024 * 1024,
                "attempt ledger exceeds read budget"
            );
            let record: TurnAttemptRecord = serde_json::from_slice(&bytes)?;
            self.check_identity(&record.identity)?;
            validate_record(&record)?;
            ensure!(
                name == leaf(&record.identity, "attempt"),
                "attempt artifact filename mismatch"
            );
            records.push(record);
        }
        records.sort_by(|a, b| {
            (a.accepted_at_ms, &a.identity.attempt_id)
                .cmp(&(b.accepted_at_ms, &b.identity.attempt_id))
        });
        Ok(records)
    }
}
fn leaf(identity: &TurnAttemptIdentity, kind: &str) -> OsString {
    format!(
        "{:x}.{kind}.json",
        Sha256::digest(identity.attempt_id.as_bytes())
    )
    .into()
}
fn validate_record(record: &TurnAttemptRecord) -> Result<()> {
    record.identity.validate().map_err(anyhow::Error::msg)?;
    ensure!(record.version == 1, "unsupported attempt record version");
    ensure!(
        record.input_context_hash.len() == 64
            && record
                .input_context_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "invalid attempt input digest"
    );
    ensure!(
        record
            .retry_operation_id
            .as_ref()
            .is_none_or(|id| !id.trim().is_empty() && id.len() <= 1024),
        "invalid retry operation identity"
    );
    ensure!(
        record
            .parent_attempt_id
            .as_ref()
            .is_none_or(|id| !id.trim().is_empty()
                && id.len() <= 256
                && id != &record.identity.attempt_id),
        "invalid parent attempt identity"
    );
    ensure!(record.request_fingerprint.as_ref().is_none_or(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())), "invalid attempt request digest");
    match &record.completion {
        None => ensure!(
            record.status == TurnAttemptStatus::Accepted,
            "terminal attempt has no outcome"
        ),
        Some(completion) => ensure!(
            completion.status == record.status
                && record.status != TurnAttemptStatus::Accepted
                && completion.finished_at_ms >= record.accepted_at_ms,
            "invalid terminal attempt outcome"
        ),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity(attempt: &str) -> TurnAttemptIdentity {
        TurnAttemptIdentity {
            thread_id: "session".into(),
            turn_id: "turn-1".into(),
            attempt_id: attempt.into(),
        }
    }
    fn record(attempt: &str) -> TurnAttemptRecord {
        TurnAttemptRecord {
            version: 1,
            identity: identity(attempt),
            parent_attempt_id: None,
            retry_operation_id: Some(format!("retry-{attempt}")),
            accepted_at_ms: 1,
            input_context_hash: "a".repeat(64),
            request_fingerprint: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        }
    }
    fn completion() -> TurnAttemptCompletion {
        TurnAttemptCompletion {
            status: TurnAttemptStatus::Failed,
            finished_at_ms: 2,
            error: Some("response interrupted".into()),
            provider_failure: None,
            partial_output: "visible but uncommitted text".into(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        }
    }
    #[test]
    fn independent_attempts_preserve_failures_across_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session");
        let store = TurnAttemptStore::open(&path, "session").unwrap();
        store.begin(record("turn-1")).unwrap();
        store.finish(&identity("turn-1"), completion()).unwrap();
        let mut next = record("turn-1-retry-second");
        next.parent_attempt_id = Some("turn-1".into());
        next.accepted_at_ms = 3;
        store.begin(next).unwrap();
        drop(store);
        let restored = TurnAttemptStore::open(&path, "session").unwrap();
        let rows = restored.list().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].completion.as_ref().unwrap().partial_output,
            "visible but uncommitted text"
        );
        assert_eq!(rows[1].parent_attempt_id.as_deref(), Some("turn-1"));
        assert_eq!(rows[1].status, TurnAttemptStatus::Accepted);
    }
    #[test]
    fn repeated_acceptance_is_idempotent_but_identity_reuse_is_not() {
        let temp = tempfile::tempdir().unwrap();
        let store = TurnAttemptStore::open(&temp.path().join("session"), "session").unwrap();
        store.begin(record("turn-1")).unwrap();
        store.finish(&identity("turn-1"), completion()).unwrap();
        assert_eq!(
            store.begin(record("turn-1")).unwrap().record().status,
            TurnAttemptStatus::Failed
        );
        let mut conflicting = record("turn-1");
        conflicting.input_context_hash = "b".repeat(64);
        assert!(store.begin(conflicting).is_err());
        let mut conflict = completion();
        conflict.status = TurnAttemptStatus::Completed;
        assert!(store.finish(&identity("turn-1"), conflict).is_err());
        assert_eq!(
            store.load(&identity("turn-1")).unwrap().unwrap().status,
            TurnAttemptStatus::Failed
        );
    }
    #[test]
    fn snapshots_are_immutable_and_bound_to_the_full_identity() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session");
        let store = TurnAttemptStore::open(&path, "session").unwrap();
        let snapshot = br#"{"model":"fixed","temperature":0.2}"#;
        store
            .save_model_snapshot(&identity("turn-1"), snapshot)
            .unwrap();
        store
            .save_model_snapshot(&identity("turn-1"), snapshot)
            .unwrap();
        assert!(
            store
                .save_model_snapshot(&identity("turn-1"), br#"{"model":"different"}"#)
                .is_err()
        );
        let mut other = identity("turn-1");
        other.turn_id = "turn-2".into();
        assert!(store.load_model_snapshot(&other).is_err());
        other.thread_id = "other-session".into();
        assert!(store.load_model_snapshot(&other).is_err());
        drop(store);
        let restored = TurnAttemptStore::open(&path, "session").unwrap();
        let value: serde_json::Value = serde_json::from_slice(
            &restored
                .load_model_snapshot(&identity("turn-1"))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(value["model"], "fixed");
    }
    #[test]
    fn concurrent_writers_cannot_replace_one_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session");
        let mut handles = Vec::new();
        for _ in 0..4 {
            let path = path.clone();
            handles.push(std::thread::spawn(move || {
                TurnAttemptStore::open(&path, "session")
                    .unwrap()
                    .begin(record("turn-1"))
                    .unwrap()
            }));
        }
        let results = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, TurnAttemptBeginOutcome::Created(_)))
                .count(),
            1
        );
        for result in results {
            assert_eq!(result.record().identity, identity("turn-1"));
        }
        assert_eq!(
            TurnAttemptStore::open(&path, "session")
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn invalid_or_oversized_writes_preserve_accepted_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let store = TurnAttemptStore::open(&temp.path().join("session"), "session").unwrap();
        store.begin(record("turn-1")).unwrap();
        let mut large = completion();
        large.partial_output = "x".repeat(MAX_RECORD_BYTES);
        assert!(store.finish(&identity("turn-1"), large).is_err());
        assert_eq!(
            store.load(&identity("turn-1")).unwrap().unwrap().status,
            TurnAttemptStatus::Accepted
        );
        assert!(
            store
                .save_model_snapshot(&identity("turn-1"), &vec![b' '; MAX_SNAPSHOT_BYTES + 1])
                .is_err()
        );
    }
}
