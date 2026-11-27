use std::collections::{BTreeMap, HashMap};
#[cfg(any(not(windows), test))]
use std::fs::OpenOptions;
use std::fs::{self, File};
use std::io::{Read, Write};
#[cfg(not(windows))]
use std::path::Component;
use std::path::{Path, PathBuf};
#[cfg(any(unix, windows))]
use std::sync::{Arc, Mutex};

#[cfg(windows)]
mod windows_directory;
#[cfg(windows)]
mod windows_io;

use anyhow::{Context, bail};
use chrono::{DateTime, Utc};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[cfg(not(windows))]
use crate::session_persistence::write_bytes_atomic;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PlanStoreError {
    #[error("revision conflict: expected {expected}, current {current}")]
    RevisionConflict { expected: u64, current: u64 },
    #[error("work not found: {0}")]
    WorkNotFound(String),
    #[error("no active Orchestrate work is selected")]
    NoActiveWork,
    #[error("unsafe PlanStore path: {0}")]
    UnsafePath(String),
    #[error("invalid work id: {0}")]
    InvalidWorkId(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkStatus {
    Active,
    Completed,
    Blocked,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcceptanceRecord {
    pub task_key: String,
    pub result_digest: String,
    pub evidence_ids: Vec<String>,
    pub works: bool,
    pub conforms: bool,
    pub matches_contract: bool,
    pub honored_boundaries: bool,
    pub accepted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskSessionRecord {
    pub agent_id: String,
    pub parent_session_id: String,
    pub plan_revision: u64,
    pub status: String,
    pub profile_fingerprint: String,
    pub recorded_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecisionActor {
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HumanDecisionRecord {
    pub decision_id: String,
    pub work_id: String,
    pub plan_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub question_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    pub answer_summary: String,
    pub actor: DecisionActor,
    pub recorded_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkProgress {
    pub completed: usize,
    pub total: usize,
    pub plan_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkState {
    pub schema_version: u32,
    pub work_id: String,
    pub display_slug: String,
    pub status: WorkStatus,
    pub revision: u64,
    pub plan_sha256: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub session_ids: Vec<String>,
    pub worktree_path: Option<PathBuf>,
    pub goal_id: Option<String>,
    pub progress: WorkProgress,
    pub acceptances: BTreeMap<String, AcceptanceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CurrentManifest {
    schema_version: u32,
    revision: u64,
    plan_sha256: String,
    work_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct WorkIndexEntry {
    display_slug: String,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct StoreIndex {
    schema_version: u32,
    active_work_id: Option<String>,
    works: BTreeMap<String, WorkIndexEntry>,
}

impl Default for StoreIndex {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            active_work_id: None,
            works: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanTask {
    pub key: String,
    pub completed: bool,
    pub line_index: usize,
    pub is_final_verification: bool,
    pub evidence_requirements: Vec<EvidenceRequirement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceRequirement {
    ProcessExit,
    Artifact,
    Citation,
    Manual,
    Schema,
    Visual,
    NotApplicable,
}

impl EvidenceRequirement {
    fn parse(value: &str) -> anyhow::Result<Self> {
        match value.trim() {
            "process_exit" => Ok(Self::ProcessExit),
            "artifact" => Ok(Self::Artifact),
            "citation" => Ok(Self::Citation),
            "manual" => Ok(Self::Manual),
            "schema" => Ok(Self::Schema),
            "visual" => Ok(Self::Visual),
            "not_applicable" => Ok(Self::NotApplicable),
            other => bail!("unknown evidence requirement {other:?}"),
        }
    }

    fn matches(self, evidence: &AgentEvidenceKind) -> bool {
        matches!(
            (self, evidence),
            (Self::ProcessExit, AgentEvidenceKind::ProcessExit { .. })
                | (Self::Artifact, AgentEvidenceKind::Artifact { .. })
                | (Self::Citation, AgentEvidenceKind::Citation { .. })
                | (Self::Manual, AgentEvidenceKind::Manual { .. })
                | (Self::Schema, AgentEvidenceKind::Schema { .. })
                | (Self::Visual, AgentEvidenceKind::Visual { .. })
                | (Self::NotApplicable, AgentEvidenceKind::NotApplicable { .. })
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPlan {
    pub tasks: Vec<PlanTask>,
}

impl ParsedPlan {
    pub fn progress(&self, plan_sha256: String) -> WorkProgress {
        WorkProgress {
            completed: self.tasks.iter().filter(|task| task.completed).count(),
            total: self.tasks.len(),
            plan_sha256,
        }
    }

    fn task(&self, key: &str) -> Option<&PlanTask> {
        self.tasks.iter().find(|task| task.key == key)
    }
}

#[derive(Debug, Clone)]
pub struct WorkSnapshot {
    pub plan: String,
    pub work: WorkState,
}

#[derive(Debug, Clone)]
pub struct ContinuationClaim {
    pub snapshot: WorkSnapshot,
    pub claimed: bool,
    pub manual_intervention_newly_required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContinuationState {
    pub auto_turn_count: u32,
    pub consecutive_failures: u32,
    pub stalled_rounds: u32,
    pub last_completed_items: Option<usize>,
    pub manual_intervention_required: bool,
    pub stop_reason: Option<String>,
    pub last_claimed_at: Option<DateTime<Utc>>,
    /// Automatic continuation already claimed but not yet reported by its host. Persisted to prevent duplicate delivery by multiple hosts.
    pub in_flight: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvidenceKind {
    ProcessExit {
        tool: String,
        command: String,
        exit_code: Option<i32>,
        signal: Option<i32>,
        cwd: PathBuf,
        raw_exit_code: bool,
    },
    Artifact {
        tool: String,
        path: PathBuf,
        sha256: String,
    },
    Citation {
        url: String,
        source_date: Option<String>,
    },
    Manual {
        statement: String,
        recorded_by: String,
    },
    Schema {
        subject: String,
        schema_sha256: String,
    },
    Visual {
        artifact_path: PathBuf,
        sha256: String,
    },
    NotApplicable {
        requirement: String,
        rationale: String,
        approved_by: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentEvidence {
    pub evidence_id: String,
    pub work_id: String,
    pub revision: u64,
    pub plan_sha256: String,
    pub agent_id: String,
    pub workspace_digest: String,
    pub recorded_at: DateTime<Utc>,
    pub evidence: AgentEvidenceKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceReadResult {
    pub records: Vec<AgentEvidence>,
    pub degraded_trailing_record: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CriticReviewOutcome {
    Okay,
    Reject,
    InfrastructureError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CriticReviewState {
    pub work_id: String,
    pub revision: u64,
    pub plan_sha256: String,
    pub reject_count: usize,
    pub infrastructure_retry_count: usize,
    pub approved: bool,
    #[serde(default)]
    pub rejected_exhausted: bool,
    pub review_unavailable: bool,
    pub automatic_review_stopped: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct PlanStore {
    root: PathBuf,
    /// Pinned trusted-root directory handle on Unix. All descendants resolve through
    /// the file descriptor, so replacing the original path after validation cannot redirect I/O outside the root.
    #[cfg(unix)]
    root_handle: Arc<Mutex<Option<File>>>,
    #[cfg(windows)]
    root_lease: Arc<Mutex<Option<windows_io::DirectoryLease>>>,
}

#[cfg(not(test))]
fn maybe_fail_planstore_commit(_stage: &str) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
thread_local! {
    static PLANSTORE_FAIL_STAGE: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn maybe_fail_planstore_commit(stage: &str) -> std::io::Result<()> {
    PLANSTORE_FAIL_STAGE.with(|value| {
        if value
            .borrow()
            .as_ref()
            .is_some_and(|configured| *configured == stage)
        {
            Err(std::io::Error::other(format!(
                "PlanStore failpoint: {stage}"
            )))
        } else {
            Ok(())
        }
    })
}

#[cfg(test)]
struct PlanStoreFailpointGuard;

#[cfg(test)]
impl PlanStoreFailpointGuard {
    fn set(stage: &'static str) -> Self {
        PLANSTORE_FAIL_STAGE.with(|value| *value.borrow_mut() = Some(stage));
        Self
    }
}

#[cfg(test)]
impl Drop for PlanStoreFailpointGuard {
    fn drop(&mut self) {
        PLANSTORE_FAIL_STAGE.with(|value| *value.borrow_mut() = None);
    }
}

fn new_critic_review_state(work_id: &str, revision: u64, plan_sha256: &str) -> CriticReviewState {
    CriticReviewState {
        work_id: work_id.to_string(),
        revision,
        plan_sha256: plan_sha256.to_string(),
        reject_count: 0,
        infrastructure_retry_count: 0,
        approved: false,
        review_unavailable: false,
        rejected_exhausted: false,
        automatic_review_stopped: false,
        updated_at: Utc::now(),
    }
}

struct LockGuard(File);

impl LockGuard {
    fn acquire(path: &Path) -> anyhow::Result<Self> {
        let file = open_rw_no_follow(path)?;
        file.lock_exclusive()?;
        Ok(Self(file))
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

mod workspace;

mod progress;

mod claims;

mod evidence;

mod transactions;

mod filesystem;
mod plan_parser;
use filesystem::*;
pub use plan_parser::parse_plan;
use plan_parser::*;

#[cfg(test)]
mod tests;
