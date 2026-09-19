use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SkillRevision(pub String);

impl SkillRevision {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "revision")]
pub enum ExpectedSkillRevision {
    Absent,
    Exact(SkillRevision),
    Unconditional,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillPackageFile {
    pub relative_path: PathBuf,
    pub content: Vec<u8>,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillPackage {
    pub name: String,
    pub files: Vec<SkillPackageFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SkillMutation {
    PutPackage {
        package: SkillPackage,
        expected: ExpectedSkillRevision,
    },
    PatchFile {
        name: String,
        expected: SkillRevision,
        relative_path: PathBuf,
        expected_file_sha256: String,
        replacement: Vec<u8>,
        #[serde(default)]
        executable: bool,
    },
    PatchText {
        name: String,
        expected: ExpectedSkillRevision,
        relative_path: PathBuf,
        old_string: String,
        new_string: String,
        #[serde(default)]
        replace_all: bool,
    },
    RemoveFile {
        name: String,
        expected: SkillRevision,
        relative_path: PathBuf,
    },
    Archive {
        name: String,
        expected: SkillRevision,
        archive_name: String,
    },
    Restore {
        name: String,
        archive_name: String,
        expected_archive_revision: SkillRevision,
        expected_live: ExpectedSkillRevision,
    },
    Consolidate {
        sources: Vec<(String, SkillRevision)>,
        destination: SkillPackage,
        expected_destination: ExpectedSkillRevision,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOperationKind {
    Create,
    Edit,
    Patch,
    WriteFile,
    RemoveFile,
    Install,
    Uninstall,
    Archive,
    Restore,
    Consolidate,
    CuratorRun,
    BundledSync,
    SpecSync,
    LessonsLearned,
    BuiltinMaterialize,
    MetadataOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SkillMutationActor {
    ForegroundAgent {
        session_id: String,
        tool_call_id: String,
    },
    BackgroundReview {
        session_id: String,
        job_id: String,
        agent_id: String,
        tool_call_id: String,
    },
    AutoCurator {
        session_id: String,
        job_id: String,
    },
    SkillHub {
        session_id: String,
        source_kind: String,
    },
    SpecInit {
        session_id: Option<String>,
        force_update: bool,
    },
    BuiltinInstaller {
        build_id: String,
    },
    System {
        component: String,
        session_id: Option<String>,
    },
}

impl SkillMutationActor {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ForegroundAgent { .. } => "foreground_agent",
            Self::BackgroundReview { .. } => "background_review",
            Self::AutoCurator { .. } => "auto_curator",
            Self::SkillHub { .. } => "skill_hub",
            Self::SpecInit { .. } => "spec_init",
            Self::BuiltinInstaller { .. } => "builtin_installer",
            Self::System { .. } => "system",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SkillMetadataPatch {
    #[serde(default)]
    pub create: BTreeMap<String, Value>,
    #[serde(default)]
    pub update: BTreeMap<String, Value>,
    #[serde(default)]
    pub increment: BTreeMap<String, u64>,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SkillMetadataDelta {
    #[serde(default)]
    pub provenance: BTreeMap<String, SkillMetadataPatch>,
    #[serde(default)]
    pub usage: BTreeMap<String, SkillMetadataPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_manifest: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin_manifest: Option<Vec<u8>>,
    #[serde(default)]
    pub curator_log_entries: Vec<Value>,
    /// Conflicting candidate file coordinated by a transaction but excluded from the
    /// active skill revision. It may be written only to a relative path ending in `.new` under one skill directory.
    #[serde(default)]
    pub auxiliary_files: BTreeMap<PathBuf, Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillMetadataStore {
    Provenance,
    Usage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillMetadataPredicate {
    Equals,
    NotEquals,
    MissingOrEquals,
    In,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillMetadataPrecondition {
    pub store: SkillMetadataStore,
    pub skill: String,
    pub field: String,
    pub predicate: SkillMetadataPredicate,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillCommitRequest {
    pub operation_id: String,
    pub actor: SkillMutationActor,
    pub operation: SkillOperationKind,
    #[serde(default)]
    pub preconditions: Vec<SkillMetadataPrecondition>,
    #[serde(default)]
    pub mutations: Vec<SkillMutation>,
    #[serde(default)]
    pub metadata: SkillMetadataDelta,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedSkillRevision {
    pub name: String,
    pub revision: Option<SkillRevision>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillStoreCommitStatus {
    Committed,
    NoChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillCommitReceipt {
    pub transaction_id: String,
    pub operation_id: String,
    pub generation: u64,
    pub status: SkillStoreCommitStatus,
    pub before: Vec<NamedSkillRevision>,
    pub after: Vec<NamedSkillRevision>,
    pub changed_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillMutationRuntimeStatus {
    RegistryReloaded,
    CommittedReloadPending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillMutationOutcome {
    pub receipt: SkillCommitReceipt,
    pub runtime_status: SkillMutationRuntimeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SkillStoreDiagnostic {
    Recovered {
        transaction_id: String,
    },
    ExternalDrift {
        skill: String,
    },
    OrphanTransaction {
        transaction_id: String,
    },
    ReloadPending {
        transaction_id: String,
    },
    CorruptTransaction {
        transaction_id: String,
        reason: String,
    },
    CommitLogCorrupt {
        reason: String,
    },
    ProvenanceRevisionMismatch {
        skill: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingSkillTransaction {
    pub transaction_id: String,
    pub operation_id: Option<String>,
    pub phase: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillStoreInspection {
    pub root: PathBuf,
    pub lock_path: PathBuf,
    pub lock_available: bool,
    pub pending_transactions: Vec<PendingSkillTransaction>,
    pub orphan_paths: Vec<PathBuf>,
    pub last_commit_generation: Option<u64>,
    pub state_generation: Option<u64>,
    pub diagnostics: Vec<SkillStoreDiagnostic>,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillStoreError {
    #[error("skill revision conflict for {name}: expected {expected}, actual {actual}")]
    Conflict {
        name: String,
        expected: String,
        actual: String,
    },
    #[error("timed out waiting for skill store lock at {root} after {timeout_ms} ms")]
    Busy { root: PathBuf, timeout_ms: u64 },
    #[error("invalid skill package: {0}")]
    InvalidPackage(String),
    #[error("skill path escapes the managed root: {0}")]
    PathEscapesRoot(PathBuf),
    #[error("unsupported file type in skill package: {0}")]
    UnsupportedFileType(PathBuf),
    #[error("skill transaction staging is on another filesystem")]
    CrossDeviceStaging,
    #[error("skill transaction journal is corrupt: {0}")]
    JournalCorrupt(String),
    #[error("skill transaction requires manual recovery: {transaction_id}: {reason}")]
    RecoveryRequired {
        transaction_id: String,
        reason: String,
    },
    #[error("skill mutation was rejected by policy: {0}")]
    PolicyRejected(String),
    #[error("skill operation id is invalid: {0}")]
    InvalidOperationId(String),
    #[error("skill store I/O failed while {context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("skill store serialization failed while {context}: {source}")]
    Serialization {
        context: String,
        #[source]
        source: serde_json::Error,
    },
}

impl SkillStoreError {
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    pub(crate) fn serialization(context: impl Into<String>, source: serde_json::Error) -> Self {
        Self::Serialization {
            context: context.into(),
            source,
        }
    }
}
