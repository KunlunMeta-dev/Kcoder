//! Project inventory is source data. Target association authority is always separate.
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
pub mod binding;
pub mod plan;
pub mod report;
pub mod target;
pub mod targets;
pub(crate) mod transfer;
pub use binding::{ProjectBatchSource, ProjectRegistryCapture};
pub use plan::ProjectAssociationPlan;
pub use target::ProjectTargetSelection;
pub use targets::ProjectTargetCatalog;
mod claude;
#[cfg(test)]
mod lifecycle_tests;
pub use claude::{ClaudeProjectDocument, parse_claude_registry};
mod sqlite;
pub use sqlite::read_codex_registry;

#[derive(Clone, Default)]
pub struct ProjectReadCancellation {
    cancelled: Arc<AtomicBool>,
    probe: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}
impl ProjectReadCancellation {
    /// The original Host/operation owns this observation; no timer or new worker is scheduled.
    pub fn with_probe(probe: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            probe: Some(Arc::new(probe)),
        }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire) || self.probe.as_ref().is_some_and(|probe| probe())
    }
}
#[derive(Clone, Copy)]
pub struct ProjectReadLimits {
    pub read_bytes: u64,
    pub elapsed: Duration,
    pub projects: usize,
    pub roots_per_project: usize,
    pub metadata_bytes: usize,
}
impl Default for ProjectReadLimits {
    fn default() -> Self {
        Self {
            read_bytes: 256 * 1024 * 1024,
            elapsed: Duration::from_secs(1),
            projects: 4096,
            roots_per_project: 16,
            metadata_bytes: 4 * 1024 * 1024,
        }
    }
}

// Source paths are preserved as strings. Nothing here opens or authorizes those directories.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub roots: Vec<String>,
    pub position: i64,
    pub created_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectReadProof {
    pub source_identity_sha256: String,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub actual_read_bytes: u64,
    pub actual_reads: u64,
    pub input_digest: String,
    pub elapsed_ms: u64,
    pub source_write_attempts: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRegistrySnapshot {
    pub format_revision: String,
    pub projects: Vec<ProjectRecord>,
    pub unobserved: Vec<String>,
    pub proof: ProjectReadProof,
}

fn is_absolute_source_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || path.starts_with("\\\\")
        || bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\')
}
