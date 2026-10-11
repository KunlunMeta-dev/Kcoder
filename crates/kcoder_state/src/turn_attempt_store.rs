//! Private, immutable-identity attempt ledger. Semantic model snapshot bytes are
//! supplied by the model layer, which must serialize its credential-free typed snapshot.
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use kcoder_types::{
    ProviderFailureDetails, TurnAttemptIdentity, TurnAttemptStatus, TurnRetainedInputV1,
};
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
    /// Server-verified artifacts persisted in the same atomic Accepted record.
    /// Missing on legacy records; missing never proves retained acceptance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_input: Option<TurnRetainedInputV1>,
    pub status: TurnAttemptStatus,
    pub completion: Option<TurnAttemptCompletion>,
}
impl TurnAttemptRecord {
    pub fn validate(&self) -> Result<()> {
        validate_record(self)
    }
    /// Exact durable evidence only. Filesystem and current owner checks remain
    /// the responsibility of the trusted retention adapter.
    pub fn matches_retained_acceptance(
        &self,
        identity: &TurnAttemptIdentity,
        canonical_request_digest: &str,
        expected: &TurnRetainedInputV1,
    ) -> bool {
        self.validate().is_ok()
            && self.status.is_known()
            && &self.identity == identity
            && self.request_fingerprint.as_deref() == Some(canonical_request_digest)
            && self.retained_input.as_ref() == Some(expected)
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
                existing.status.is_known(),
                "unrecognized attempt history is read-only"
            );
            ensure!(
                existing.parent_attempt_id == record.parent_attempt_id
                    && existing.retry_operation_id == record.retry_operation_id
                    && existing.input_context_hash == record.input_context_hash
                    && existing.request_fingerprint == record.request_fingerprint
                    && existing.retained_input == record.retained_input,
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
            completion.status.is_terminal(),
            "completion must be terminal"
        );
        let _lock = self.lock()?;
        let mut record = self.load(identity)?.context("attempt was not accepted")?;
        ensure!(
            record.status.is_known(),
            "unrecognized attempt history is read-only"
        );
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
        record.status = completion.status.clone();
        record.completion = Some(completion);
        self.write_record(&record)?;
        Ok(record)
    }
    fn write_record(&self, record: &TurnAttemptRecord) -> Result<()> {
        validate_record(record)?;
        ensure!(
            record.status.is_known(),
            "unrecognized attempt history is read-only"
        );
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
        if let Some(record) = self.load(identity)? {
            ensure!(
                record.status.is_known(),
                "unrecognized attempt history is read-only"
            );
        }
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
    /// Bounded, read-only lookup of one server-recorded retained client message.
    /// A duplicate client message, even across scopes or future statuses, is
    /// ambiguous and cannot be resolved by choosing a convenient record.
    pub fn find_retained_acceptance(
        &self,
        scope_id: &str,
        client_message_id: &str,
    ) -> Result<Option<TurnAttemptRecord>> {
        let mut records = self.list()?.into_iter().filter(|record| {
            record
                .retained_input
                .as_ref()
                .is_some_and(|binding| binding.client_message_id == client_message_id)
        });
        let Some(record) = records.next() else {
            return Ok(None);
        };
        ensure!(
            records.next().is_none(),
            "retained client message has ambiguous attempts"
        );
        if !record.status.is_known()
            || record
                .retained_input
                .as_ref()
                .is_none_or(|binding| binding.scope_id != scope_id)
        {
            return Ok(None);
        }
        Ok(Some(record))
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
        record.status.as_str().len() <= 256,
        "attempt status exceeds byte limit"
    );
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
    ensure!(
        record.request_fingerprint.as_ref().is_none_or(
            |hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        ),
        "invalid attempt request digest"
    );
    if let Some(binding) = &record.retained_input {
        binding.validate().map_err(anyhow::Error::msg)?;
        ensure!(
            record.request_fingerprint.is_some(),
            "retained acceptance has no request digest"
        );
    }
    match &record.completion {
        None => ensure!(
            record.status == TurnAttemptStatus::Accepted || !record.status.is_known(),
            "terminal attempt has no outcome"
        ),
        Some(completion) => ensure!(
            completion.status == record.status
                && (record.status.is_terminal() || !record.status.is_known())
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
            retained_input: None,
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
    fn retained_record(attempt: &str) -> TurnAttemptRecord {
        use kcoder_types::{
            PrivateFileIdentityV1, PrivateFileKind, PrivateNativeFileIdentity,
            TurnRetainedArtifactV1,
        };
        let file_identity = |kind, inode| PrivateFileIdentityV1 {
            version: 1,
            kind,
            native: PrivateNativeFileIdentity::Linux { device: 7, inode },
        };
        let mut row = record(attempt);
        row.request_fingerprint = Some("b".repeat(64));
        row.retained_input = Some(TurnRetainedInputV1 {
            version: 1,
            scope_id: "c".repeat(64),
            client_message_id: "message".into(),
            artifacts: vec![TurnRetainedArtifactV1 {
                retention_id: "r1.root.1.0123456789abcdef0123456789abcdef".into(),
                expected_receipt_revision: 1,
                root_namespace: "root".into(),
                epoch: 1,
                owner_id: "owner".into(),
                entry_id: "entry".into(),
                entry_revision: 1,
                artifact_name: "retained-entry.bytes".into(),
                artifact_parent_identity: file_identity(PrivateFileKind::Directory, 1),
                artifact_identity: file_identity(PrivateFileKind::RegularFile, 2),
                artifact_sha256: "d".repeat(64),
                artifact_size: 5,
            }],
        });
        row
    }
    #[test]
    fn retained_acceptance_survives_reopen_and_keeps_request_and_context_digests_distinct() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session");
        let store = TurnAttemptStore::open(&path, "session").unwrap();
        let original = retained_record("turn-retained");
        let binding = original.retained_input.clone().unwrap();
        store.begin(original.clone()).unwrap();
        assert!(original.matches_retained_acceptance(
            &original.identity,
            &"b".repeat(64),
            &binding
        ));
        assert!(!original.matches_retained_acceptance(
            &original.identity,
            &original.input_context_hash,
            &binding
        ));
        let finished = store.finish(&original.identity, completion()).unwrap();
        assert_eq!(finished.retained_input, original.retained_input);
        drop(store);
        let reopened = TurnAttemptStore::open_existing(&path, "session")
            .unwrap()
            .unwrap();
        let loaded = reopened
            .find_retained_acceptance(&binding.scope_id, &binding.client_message_id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded, finished);
        assert!(loaded.matches_retained_acceptance(&original.identity, &"b".repeat(64), &binding));
        let mut wrong = binding.clone();
        wrong.artifacts[0].artifact_sha256 = "e".repeat(64);
        assert!(!loaded.matches_retained_acceptance(&original.identity, &"b".repeat(64), &wrong));
        assert!(
            reopened
                .find_retained_acceptance(&"e".repeat(64), &binding.client_message_id)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn retained_acceptance_rebinds_are_rejected_without_replacing_original_record() {
        let temp = tempfile::tempdir().unwrap();
        let store = TurnAttemptStore::open(&temp.path().join("session"), "session").unwrap();
        let original = retained_record("turn-retained");
        store.begin(original.clone()).unwrap();
        let before = store
            .read_bytes(&leaf(&original.identity, "attempt"), MAX_RECORD_BYTES)
            .unwrap()
            .unwrap();
        for change in 0..4 {
            let mut changed = original.clone();
            match change {
                0 => {
                    changed.retained_input.as_mut().unwrap().artifacts[0].artifact_sha256 =
                        "e".repeat(64)
                }
                1 => changed.retained_input.as_mut().unwrap().scope_id = "e".repeat(64),
                2 => {
                    changed.retained_input.as_mut().unwrap().artifacts[0]
                        .expected_receipt_revision += 1
                }
                _ => changed.retained_input = None,
            }
            assert!(store.begin(changed).is_err());
            assert_eq!(
                store
                    .read_bytes(&leaf(&original.identity, "attempt"), MAX_RECORD_BYTES)
                    .unwrap()
                    .unwrap(),
                before
            );
        }
    }
    #[test]
    fn retained_acceptance_old_unknown_and_duplicate_records_cannot_be_selected_as_proof() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("session");
        let store = TurnAttemptStore::open(&path, "session").unwrap();
        let legacy = record("legacy");
        let json = serde_json::to_value(&legacy).unwrap();
        assert!(json.get("retained_input").is_none());
        let decoded: TurnAttemptRecord = serde_json::from_value(json).unwrap();
        assert!(decoded.retained_input.is_none());
        store.begin(decoded).unwrap();
        let original = retained_record("turn-retained");
        let binding = original.retained_input.clone().unwrap();
        assert!(
            store
                .find_retained_acceptance(&binding.scope_id, &binding.client_message_id)
                .unwrap()
                .is_none()
        );
        let mut future = original.clone();
        future.status = TurnAttemptStatus::Unknown("future".into());
        store
            .directory
            .atomic_replace(
                &leaf(&future.identity, "attempt"),
                &serde_json::to_vec(&future).unwrap(),
            )
            .unwrap();
        assert!(
            store
                .find_retained_acceptance(&binding.scope_id, &binding.client_message_id)
                .unwrap()
                .is_none()
        );
        assert!(!future.matches_retained_acceptance(&original.identity, &"b".repeat(64), &binding));
        let mut second = retained_record("second");
        second.retained_input.as_mut().unwrap().scope_id = "e".repeat(64);
        store.begin(second).unwrap();
        assert!(
            store
                .find_retained_acceptance(&binding.scope_id, &binding.client_message_id)
                .is_err()
        );
    }
    #[test]
    fn malformed_retained_acceptance_is_rejected_before_creating_attempt_file() {
        let temp = tempfile::tempdir().unwrap();
        let store = TurnAttemptStore::open(&temp.path().join("session"), "session").unwrap();
        let original = retained_record("turn-retained");
        for change in 0..3 {
            let mut invalid = original.clone();
            match change {
                0 => invalid.request_fingerprint = None,
                1 => {
                    invalid.retained_input.as_mut().unwrap().artifacts[0].artifact_name =
                        "../foreign".into()
                }
                _ => invalid.retained_input.as_mut().unwrap().artifacts[0].entry_revision = 0,
            }
            assert!(store.begin(invalid).is_err());
            assert!(store.load(&original.identity).unwrap().is_none());
        }
    }
    #[test]
    fn unknown_attempt_evidence_remains_readable_but_all_writes_are_refused() {
        for has_completion in [false, true] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("session");
            let store = TurnAttemptStore::open(&path, "session").unwrap();
            let mut future = record("turn-future");
            future.status = TurnAttemptStatus::Unknown("awaiting_future_policy".into());
            if has_completion {
                let mut outcome = completion();
                outcome.status = future.status.clone();
                future.completion = Some(outcome);
            }
            let leaf = leaf(&future.identity, "attempt");
            let bytes = serde_json::to_vec(&future).unwrap();
            store.directory.atomic_replace(&leaf, &bytes).unwrap();
            let current = record("turn-current");
            store.begin(current.clone()).unwrap();
            assert_eq!(store.load(&future.identity).unwrap().unwrap(), future);
            assert_eq!(store.list().unwrap().len(), 2);
            assert!(!future.status.is_terminal());
            assert!(store.begin(record("turn-future")).is_err());
            assert!(store.finish(&future.identity, completion()).is_err());
            assert!(
                store
                    .save_model_snapshot(&future.identity, br#"{"model":"future"}"#)
                    .is_err()
            );
            assert!(store.write_record(&future).is_err());
            let mut unknown_outcome = completion();
            unknown_outcome.status = future.status.clone();
            assert!(store.finish(&current.identity, unknown_outcome).is_err());
            assert_eq!(
                store.read_bytes(&leaf, MAX_RECORD_BYTES).unwrap().unwrap(),
                bytes
            );
            drop(store);
            let reopened = TurnAttemptStore::open_existing(&path, "session")
                .unwrap()
                .unwrap();
            assert_eq!(reopened.load(&future.identity).unwrap().unwrap(), future);
        }
    }
    #[test]
    fn future_status_does_not_relax_record_schema_or_outcome_validation() {
        let mut future = record("turn-future");
        future.status = TurnAttemptStatus::Unknown("future_status".into());
        assert!(validate_record(&future).is_ok());
        future.version = 2;
        assert!(validate_record(&future).is_err());
        future.version = 1;
        let mut outcome = completion();
        outcome.status = future.status.clone();
        outcome.finished_at_ms = 0;
        future.completion = Some(outcome);
        assert!(validate_record(&future).is_err());
        future.completion.as_mut().unwrap().finished_at_ms = 2;
        future.completion.as_mut().unwrap().status = TurnAttemptStatus::Completed;
        assert!(validate_record(&future).is_err());
        future.completion = None;
        future.status = TurnAttemptStatus::Unknown("x".repeat(257));
        assert!(validate_record(&future).is_err());
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
