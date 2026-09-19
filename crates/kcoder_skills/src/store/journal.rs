use super::layout::StoreLayout;
use super::replace::{append_and_sync, atomic_write};
use super::{
    NamedSkillRevision, SkillCommitReceipt, SkillMutationActor, SkillOperationKind,
    SkillStoreCommitStatus, SkillStoreError,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub(crate) const JOURNAL_SCHEMA: &str = "kcoder.skill-transaction/1";
const COMMIT_SCHEMA: &str = "kcoder.skill-commit/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TransactionPhase {
    Prepared,
    Publishing,
    ContentPublished,
    MetadataPublished,
    Committed,
    Cleaned,
    Aborted,
}

impl TransactionPhase {
    fn rank(self) -> u8 {
        match self {
            Self::Prepared => 0,
            Self::Publishing => 1,
            Self::ContentPublished => 2,
            Self::MetadataPublished => 3,
            Self::Committed => 4,
            Self::Cleaned => 5,
            Self::Aborted => 6,
        }
    }

    pub(crate) fn may_transition_to(self, next: Self) -> bool {
        matches!((self, next), (Self::Prepared, Self::Aborted))
            || (self != Self::Aborted && next != Self::Aborted && next.rank() == self.rank() + 1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct JournalMove {
    pub(crate) name: String,
    pub(crate) live: PathBuf,
    pub(crate) staged: Option<PathBuf>,
    pub(crate) before_image: Option<PathBuf>,
    pub(crate) before_revision: Option<super::SkillRevision>,
    pub(crate) after_revision: Option<super::SkillRevision>,
    #[serde(default)]
    pub(crate) published: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct JournalMetadataFile {
    pub(crate) live: PathBuf,
    pub(crate) staged: PathBuf,
    pub(crate) before_image: Option<PathBuf>,
    pub(crate) before_sha256: Option<String>,
    pub(crate) after_sha256: String,
    #[serde(default)]
    pub(crate) published: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct TransactionJournal {
    pub(crate) schema: String,
    pub(crate) transaction_id: String,
    pub(crate) operation_id: String,
    pub(crate) phase: TransactionPhase,
    pub(crate) generation_before: u64,
    pub(crate) generation_after: u64,
    pub(crate) operation: SkillOperationKind,
    pub(crate) actor: SkillMutationActor,
    pub(crate) before: Vec<NamedSkillRevision>,
    pub(crate) after: Vec<NamedSkillRevision>,
    pub(crate) changed_paths: Vec<PathBuf>,
    pub(crate) moves: Vec<JournalMove>,
    pub(crate) metadata_files: Vec<JournalMetadataFile>,
}

impl TransactionJournal {
    pub(crate) fn transition(
        &mut self,
        expected: TransactionPhase,
        next: TransactionPhase,
    ) -> Result<(), SkillStoreError> {
        if self.phase != expected || !expected.may_transition_to(next) {
            return Err(SkillStoreError::JournalCorrupt(format!(
                "invalid phase transition {:?} -> {:?}; current phase is {:?}",
                expected, next, self.phase
            )));
        }
        self.phase = next;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckedRecord<T> {
    length: usize,
    checksum: String,
    payload: T,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct CommitRecord {
    pub(crate) schema: String,
    pub(crate) transaction_id: String,
    pub(crate) operation_id: String,
    pub(crate) generation: u64,
    pub(crate) operation: SkillOperationKind,
    pub(crate) actor: SkillMutationActor,
    pub(crate) before: Vec<NamedSkillRevision>,
    pub(crate) after: Vec<NamedSkillRevision>,
    pub(crate) changed_paths: Vec<PathBuf>,
    pub(crate) committed_at: DateTime<Utc>,
    pub(crate) status: SkillStoreCommitStatus,
    pub(crate) journal_schema: String,
}

impl CommitRecord {
    pub(crate) fn from_journal(
        journal: &TransactionJournal,
        status: SkillStoreCommitStatus,
    ) -> Self {
        Self {
            schema: COMMIT_SCHEMA.to_string(),
            transaction_id: journal.transaction_id.clone(),
            operation_id: journal.operation_id.clone(),
            generation: journal.generation_after,
            operation: journal.operation.clone(),
            actor: bounded_actor(&journal.actor),
            before: journal.before.clone(),
            after: journal.after.clone(),
            changed_paths: journal.changed_paths.clone(),
            committed_at: Utc::now(),
            status,
            journal_schema: journal.schema.clone(),
        }
    }

    pub(crate) fn receipt(&self) -> SkillCommitReceipt {
        SkillCommitReceipt {
            transaction_id: self.transaction_id.clone(),
            operation_id: self.operation_id.clone(),
            generation: self.generation,
            status: self.status,
            before: self.before.clone(),
            after: self.after.clone(),
            changed_paths: self.changed_paths.clone(),
        }
    }
}

pub(crate) fn write_journal(
    transaction_dir: &Path,
    journal: &TransactionJournal,
) -> Result<(), SkillStoreError> {
    validate_journal(journal)?;
    let checked = checked_record(journal)?;
    let bytes = serde_json::to_vec_pretty(&checked)
        .map_err(|error| SkillStoreError::serialization("serializing journal", error))?;
    atomic_write(
        &transaction_dir.join("journal.json"),
        &bytes,
        &journal.transaction_id,
    )
}

pub(crate) fn read_journal(path: &Path) -> Result<TransactionJournal, SkillStoreError> {
    let bytes = fs::read(path)
        .map_err(|error| SkillStoreError::io(format!("reading {}", path.display()), error))?;
    let checked: CheckedRecord<TransactionJournal> = serde_json::from_slice(&bytes)
        .map_err(|error| SkillStoreError::serialization("parsing journal", error))?;
    verify_checked(&checked)?;
    validate_journal(&checked.payload)?;
    Ok(checked.payload)
}

pub(crate) fn read_commits(
    layout: &StoreLayout,
    repair_truncated_tail: bool,
) -> Result<Vec<CommitRecord>, SkillStoreError> {
    let path = layout.commits();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes =
        fs::read(&path).map_err(|error| SkillStoreError::io("reading skill commit log", error))?;
    let mut records = Vec::new();
    let mut offset = 0usize;
    let mut seen_transactions = BTreeSet::new();
    let mut seen_operations = BTreeSet::new();
    for segment in bytes.split_inclusive(|byte| *byte == b'\n') {
        let complete = segment.ends_with(b"\n");
        let line = segment.strip_suffix(b"\n").unwrap_or(segment);
        if line.is_empty() {
            offset += segment.len();
            continue;
        }
        let parsed = serde_json::from_slice::<CheckedRecord<CommitRecord>>(line)
            .map_err(|error| error.to_string())
            .and_then(|record| {
                verify_checked(&record)
                    .map(|_| record.payload)
                    .map_err(|error| error.to_string())
            });
        match parsed {
            Ok(record) => {
                if record.schema != COMMIT_SCHEMA || record.journal_schema != JOURNAL_SCHEMA {
                    return Err(SkillStoreError::JournalCorrupt(
                        "commit record uses an unsupported schema".to_string(),
                    ));
                }
                if !seen_transactions.insert(record.transaction_id.clone())
                    || !seen_operations.insert(record.operation_id.clone())
                {
                    return Err(SkillStoreError::JournalCorrupt(
                        "commit log contains duplicate transaction or operation id".to_string(),
                    ));
                }
                records.push(record);
            }
            Err(_message) if !complete && repair_truncated_tail => {
                let mut file = OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .map_err(|error| SkillStoreError::io("opening commit log for repair", error))?;
                file.set_len(offset as u64)
                    .map_err(|error| SkillStoreError::io("truncating commit log tail", error))?;
                file.seek(SeekFrom::Start(offset as u64))
                    .map_err(|error| SkillStoreError::io("seeking repaired commit log", error))?;
                file.flush()
                    .map_err(|error| SkillStoreError::io("flushing repaired commit log", error))?;
                file.sync_all()
                    .map_err(|error| SkillStoreError::io("syncing repaired commit log", error))?;
                break;
            }
            Err(message) => {
                return Err(SkillStoreError::JournalCorrupt(format!(
                    "invalid commit record at byte {offset}: {message}"
                )));
            }
        }
        offset += segment.len();
    }
    Ok(records)
}

pub(crate) fn append_commit(
    layout: &StoreLayout,
    record: &CommitRecord,
) -> Result<(), SkillStoreError> {
    let records = read_commits(layout, false)?;
    if records
        .iter()
        .any(|existing| existing.transaction_id == record.transaction_id)
    {
        return Ok(());
    }
    if let Some(existing) = records
        .iter()
        .find(|existing| existing.operation_id == record.operation_id)
    {
        return Err(SkillStoreError::JournalCorrupt(format!(
            "operation '{}' was already committed by transaction '{}'",
            record.operation_id, existing.transaction_id
        )));
    }
    let checked = checked_record(record)?;
    let mut bytes = serde_json::to_vec(&checked)
        .map_err(|error| SkillStoreError::serialization("serializing commit record", error))?;
    bytes.push(b'\n');
    append_and_sync(&layout.commits(), &bytes)
}

pub(crate) fn find_operation(
    layout: &StoreLayout,
    operation_id: &str,
) -> Result<Option<SkillCommitReceipt>, SkillStoreError> {
    Ok(read_commits(layout, false)?
        .into_iter()
        .find(|record| record.operation_id == operation_id)
        .map(|record| record.receipt()))
}

fn checked_record<T>(payload: &T) -> Result<CheckedRecord<T>, SkillStoreError>
where
    T: Serialize + Clone,
{
    let bytes = serde_json::to_vec(payload)
        .map_err(|error| SkillStoreError::serialization("serializing checked payload", error))?;
    Ok(CheckedRecord {
        length: bytes.len(),
        checksum: sha256(&bytes),
        payload: payload.clone(),
    })
}

fn verify_checked<T: Serialize>(checked: &CheckedRecord<T>) -> Result<(), SkillStoreError> {
    let bytes = serde_json::to_vec(&checked.payload)
        .map_err(|error| SkillStoreError::serialization("verifying checked payload", error))?;
    if bytes.len() != checked.length || sha256(&bytes) != checked.checksum {
        return Err(SkillStoreError::JournalCorrupt(
            "record length or checksum mismatch".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn validate_journal(journal: &TransactionJournal) -> Result<(), SkillStoreError> {
    if journal.schema != JOURNAL_SCHEMA
        || !journal.transaction_id.starts_with("skill-txn-")
        || journal.transaction_id.len() > 128
        || !journal
            .transaction_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || journal.operation_id.is_empty()
        || journal.operation_id.len() > 256
        || journal.operation_id.chars().any(char::is_control)
        || journal.generation_after < journal.generation_before
        || journal.generation_after > journal.generation_before.saturating_add(1)
    {
        return Err(SkillStoreError::JournalCorrupt(
            "journal schema or transaction id is invalid".to_string(),
        ));
    }
    let transaction_prefix = PathBuf::from(".transactions").join(&journal.transaction_id);
    for item in &journal.moves {
        validate_live_content_path(&item.live)?;
        for path in item.staged.iter().chain(item.before_image.iter()) {
            let path = super::layout::validate_internal_relative_path(path)?;
            if !path.starts_with(&transaction_prefix) {
                return Err(SkillStoreError::JournalCorrupt(format!(
                    "transaction path '{}' is outside '{}'",
                    path.display(),
                    transaction_prefix.display()
                )));
            }
        }
    }
    for item in &journal.metadata_files {
        validate_live_metadata_path(&item.live)?;
        for path in std::iter::once(&item.staged).chain(item.before_image.iter()) {
            let path = super::layout::validate_internal_relative_path(path)?;
            if !path.starts_with(&transaction_prefix) {
                return Err(SkillStoreError::JournalCorrupt(format!(
                    "metadata transaction path '{}' is outside '{}'",
                    path.display(),
                    transaction_prefix.display()
                )));
            }
        }
    }
    Ok(())
}

fn validate_live_content_path(path: &Path) -> Result<(), SkillStoreError> {
    let canonical = super::layout::canonical_relative_path(path)?;
    let parts = canonical.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        [name] => super::layout::validate_skill_name(name),
        [".archive", name] => super::layout::validate_skill_name(name),
        _ => Err(SkillStoreError::JournalCorrupt(format!(
            "invalid live content path '{canonical}'"
        ))),
    }
}

fn validate_live_metadata_path(path: &Path) -> Result<(), SkillStoreError> {
    let canonical = super::layout::canonical_relative_path(path)?;
    if matches!(
        canonical.as_str(),
        super::layout::STATE_FILE
            | super::layout::PROVENANCE_FILE
            | super::layout::USAGE_FILE
            | super::layout::BUNDLED_MANIFEST_FILE
            | super::layout::BUILTIN_MANIFEST_FILE
            | super::layout::CURATOR_LOG_FILE
    ) {
        return Ok(());
    }
    let mut parts = canonical.split('/');
    let skill = parts.next().unwrap_or_default();
    super::layout::validate_skill_name(skill)?;
    let rest = parts.collect::<Vec<_>>().join("/");
    if rest.is_empty() || !rest.ends_with(".new") {
        return Err(SkillStoreError::JournalCorrupt(format!(
            "invalid live metadata path '{canonical}'"
        )));
    }
    Ok(())
}

fn bounded_actor(actor: &SkillMutationActor) -> SkillMutationActor {
    fn bounded(value: &str) -> String {
        value.chars().take(160).collect()
    }
    match actor {
        SkillMutationActor::ForegroundAgent {
            session_id,
            tool_call_id,
        } => SkillMutationActor::ForegroundAgent {
            session_id: bounded(session_id),
            tool_call_id: bounded(tool_call_id),
        },
        SkillMutationActor::BackgroundReview {
            session_id,
            job_id,
            agent_id,
            tool_call_id,
        } => SkillMutationActor::BackgroundReview {
            session_id: bounded(session_id),
            job_id: bounded(job_id),
            agent_id: bounded(agent_id),
            tool_call_id: bounded(tool_call_id),
        },
        SkillMutationActor::AutoCurator { session_id, job_id } => SkillMutationActor::AutoCurator {
            session_id: bounded(session_id),
            job_id: bounded(job_id),
        },
        SkillMutationActor::SkillHub {
            session_id,
            source_kind,
        } => SkillMutationActor::SkillHub {
            session_id: bounded(session_id),
            source_kind: bounded(source_kind),
        },
        SkillMutationActor::SpecInit {
            session_id,
            force_update,
        } => SkillMutationActor::SpecInit {
            session_id: session_id.as_deref().map(bounded),
            force_update: *force_update,
        },
        SkillMutationActor::BuiltinInstaller { build_id } => SkillMutationActor::BuiltinInstaller {
            build_id: bounded(build_id),
        },
        SkillMutationActor::System {
            component,
            session_id,
        } => SkillMutationActor::System {
            component: bounded(component),
            session_id: session_id.as_deref().map(bounded),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_phase_is_monotonic() {
        assert!(TransactionPhase::Prepared.may_transition_to(TransactionPhase::Publishing));
        assert!(TransactionPhase::Prepared.may_transition_to(TransactionPhase::Aborted));
        assert!(!TransactionPhase::Prepared.may_transition_to(TransactionPhase::Committed));
        assert!(!TransactionPhase::Committed.may_transition_to(TransactionPhase::Publishing));
    }

    #[test]
    fn checked_record_detects_tampering() {
        let payload = vec!["one".to_string()];
        let mut checked = checked_record(&payload).unwrap();
        checked.payload.push("two".to_string());
        assert!(verify_checked(&checked).is_err());
    }

    #[test]
    fn journal_live_paths_cannot_target_internal_or_nested_locations() {
        assert!(validate_live_content_path(Path::new("demo")).is_ok());
        assert!(validate_live_content_path(Path::new(".archive/demo")).is_ok());
        assert!(validate_live_content_path(Path::new(".transactions/other")).is_err());
        assert!(validate_live_content_path(Path::new("demo/references")).is_err());
        assert!(validate_live_metadata_path(Path::new(".provenance.json")).is_ok());
        assert!(validate_live_metadata_path(Path::new("demo/SKILL.md.new")).is_ok());
        assert!(validate_live_metadata_path(Path::new("demo/SKILL.md")).is_err());
    }
}
