use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
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

impl PlanStore {
    pub fn for_workspace(workspace: &Path) -> Self {
        // The workspace is a caller-selected trust boundary and may reside under a
        // system alias such as macOS `/var -> /private/var`. Resolve only this layer,
        // then append PlanStore-managed directories. Later no-follow checks still reject links inside `.kcoder`.
        let workspace = fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        Self {
            root: workspace.join(".kcoder").join("orchestrate"),
            #[cfg(unix)]
            root_handle: Arc::new(Mutex::new(None)),
            #[cfg(windows)]
            root_lease: Arc::new(Mutex::new(None)),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create_work(
        &self,
        display_slug: &str,
        plan: &str,
        session_id: &str,
        select_active: bool,
    ) -> anyhow::Result<WorkSnapshot> {
        validate_display_slug(display_slug)?;
        let parsed = parse_plan(plan)?;
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let mut index = self.read_index()?;
        self.cleanup_unindexed_works(&index)?;
        let work_id = format!("work_{}", Uuid::new_v4());
        let work_dir = self.work_dir(&work_id)?;
        #[cfg(windows)]
        let _parent_lease = windows_io::DirectoryLease::parent(&work_dir)?;
        create_new_directory(&work_dir).with_context(|| format!("failed to create {work_id}"))?;
        ensure_not_symlink(&work_dir)?;

        let now = Utc::now();
        let plan_sha256 = sha256(plan.as_bytes());
        let work = WorkState {
            schema_version: SCHEMA_VERSION,
            work_id: work_id.clone(),
            display_slug: display_slug.to_string(),
            status: WorkStatus::Active,
            revision: 1,
            plan_sha256: plan_sha256.clone(),
            created_at: now,
            updated_at: now,
            session_ids: vec![session_id.to_string()],
            worktree_path: None,
            goal_id: None,
            progress: parsed.progress(plan_sha256),
            acceptances: BTreeMap::new(),
        };
        self.commit_revision(&work_dir, plan, &work)?;
        maybe_fail_planstore_commit("before_index")?;

        index.works.insert(
            work_id.clone(),
            WorkIndexEntry {
                display_slug: display_slug.to_string(),
                created_at: now,
            },
        );
        if select_active {
            index.active_work_id = Some(work_id);
        }
        self.write_index(&index)?;
        Ok(WorkSnapshot {
            plan: plan.to_string(),
            work,
        })
    }

    pub fn active_work_id(&self) -> anyhow::Result<Option<String>> {
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let index = self.read_index()?;
        self.cleanup_unindexed_works(&index)?;
        if let Some(work_id) = index.active_work_id.as_deref() {
            self.validate_indexed_work(&index, work_id)?;
        }
        Ok(index.active_work_id)
    }

    pub fn select_active_work(&self, work_id: &str) -> anyhow::Result<()> {
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let mut index = match self.read_index() {
            Ok(index) => index,
            Err(_) => self.index_from_discovered_works()?,
        };
        self.validate_indexed_work(&index, work_id)?;
        self.read_work(work_id)?;
        index.active_work_id = Some(work_id.to_string());
        self.write_index(&index)
    }

    pub fn list_works(&self) -> anyhow::Result<Vec<WorkSnapshot>> {
        self.prepare_root()?;
        let _lock = self.lock_store()?;
        let index = match self.read_index() {
            Ok(index) => index,
            Err(_) => return self.discover_healthy_works(),
        };
        self.cleanup_unindexed_works(&index)?;
        index
            .works
            .keys()
            .map(|work_id| self.read_work(work_id))
            .collect()
    }

    fn discover_healthy_works(&self) -> anyhow::Result<Vec<WorkSnapshot>> {
        let works_dir = self.io_root()?.join("works");
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&works_dir, false)?;
        let mut snapshots = Vec::new();
        for entry in read_directory(&works_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if validate_work_id(&name).is_err() {
                continue;
            }
            ensure_not_symlink(&entry.path())?;
            if let Ok(snapshot) = self.read_work(&name) {
                snapshots.push(snapshot);
            }
        }
        snapshots.sort_by(|left, right| {
            left.work
                .created_at
                .cmp(&right.work.created_at)
                .then_with(|| left.work.work_id.cmp(&right.work.work_id))
        });
        Ok(snapshots)
    }

    fn index_from_discovered_works(&self) -> anyhow::Result<StoreIndex> {
        let works = self.discover_healthy_works()?;
        if works.is_empty() {
            bail!("PlanStore index is corrupt and no healthy work can be selected");
        }
        Ok(StoreIndex {
            schema_version: SCHEMA_VERSION,
            active_work_id: None,
            works: works
                .into_iter()
                .map(|snapshot| {
                    (
                        snapshot.work.work_id,
                        WorkIndexEntry {
                            display_slug: snapshot.work.display_slug,
                            created_at: snapshot.work.created_at,
                        },
                    )
                })
                .collect(),
        })
    }

    pub fn read_active_work(&self) -> anyhow::Result<WorkSnapshot> {
        let work_id = self.active_work_id()?.ok_or(PlanStoreError::NoActiveWork)?;
        self.read_work(&work_id)
    }

    pub fn read_work(&self, work_id: &str) -> anyhow::Result<WorkSnapshot> {
        let work_dir = self.work_dir(work_id)?;
        ensure_not_symlink(&work_dir)?;
        let manifest: CurrentManifest = read_json_no_follow(&work_dir.join("current.json"))?;
        let revision_dir = work_dir
            .join("revisions")
            .join(manifest.revision.to_string());
        ensure_not_symlink(&revision_dir)?;
        let plan = read_string_no_follow(&revision_dir.join("plan.md"))?;
        let work_bytes = read_bytes_no_follow(&revision_dir.join("work.json"))?;
        if sha256(plan.as_bytes()) != manifest.plan_sha256
            || sha256(&work_bytes) != manifest.work_sha256
        {
            bail!("PlanStore manifest digest mismatch for {work_id}");
        }
        let work: WorkState = serde_json::from_slice(&work_bytes)?;
        let parsed = parse_plan(&plan)?;
        if work.work_id != work_id
            || work.revision != manifest.revision
            || work.plan_sha256 != manifest.plan_sha256
            || work.progress != parsed.progress(manifest.plan_sha256)
        {
            bail!("PlanStore revision metadata mismatch for {work_id}");
        }
        Ok(WorkSnapshot { plan, work })
    }

    pub fn edit_plan(
        &self,
        work_id: &str,
        expected_revision: u64,
        old: &str,
        new: &str,
        replace_all: bool,
    ) -> anyhow::Result<WorkSnapshot> {
        self.mutate(work_id, expected_revision, |plan, work| {
            if old.is_empty() {
                bail!("old text must not be empty");
            }
            let occurrences = plan.matches(old).count();
            if occurrences == 0 {
                bail!("old text was not found in current plan");
            }
            if occurrences > 1 && !replace_all {
                bail!("old text occurs more than once; set replace_all explicitly");
            }
            let updated = if replace_all {
                plan.replace(old, new)
            } else {
                plan.replacen(old, new, 1)
            };
            let before = parse_plan(plan)?;
            let after = parse_plan(&updated)?;
            let before_states = before
                .tasks
                .iter()
                .map(|task| (&task.key, task.completed))
                .collect::<HashMap<_, _>>();
            let after_states = after
                .tasks
                .iter()
                .map(|task| (&task.key, task.completed))
                .collect::<HashMap<_, _>>();
            if before_states != after_states {
                bail!("EditWorkPlan cannot change task checkbox state or task identity");
            }
            for accepted in work.acceptances.keys() {
                let before_line = task_block(plan, accepted)?;
                let after_line = task_block(&updated, accepted)?;
                if before_line != after_line {
                    bail!("accepted task {accepted} must be reopened before editing its body");
                }
            }
            Ok(updated)
        })
    }

    pub fn record_acceptance(
        &self,
        work_id: &str,
        expected_revision: u64,
        acceptance: AcceptanceRecord,
    ) -> anyhow::Result<WorkSnapshot> {
        self.record_acceptances(work_id, expected_revision, vec![acceptance])
    }

    /// Atomically accept one or more tasks using evidence from the same revision.
    ///
    /// Accepting one item creates a new revision. If the caller gathered evidence for
    /// several tasks in one validation wave, submit them together so updating the first
    /// checkbox does not invalidate the rest unnecessarily.
    pub fn record_acceptances(
        &self,
        work_id: &str,
        expected_revision: u64,
        mut acceptances: Vec<AcceptanceRecord>,
    ) -> anyhow::Result<WorkSnapshot> {
        if acceptances.is_empty() {
            bail!("batch acceptance requires at least one task");
        }
        let mut task_keys = std::collections::HashSet::new();
        for acceptance in &acceptances {
            if !task_keys.insert(acceptance.task_key.clone()) {
                bail!(
                    "duplicate task key {} in batch acceptance",
                    acceptance.task_key
                );
            }
            if !(acceptance.works
                && acceptance.conforms
                && acceptance.matches_contract
                && acceptance.honored_boundaries)
            {
                bail!(
                    "all four acceptance checks must be true for task {}",
                    acceptance.task_key
                );
            }
            if acceptance.result_digest.trim().is_empty() || acceptance.evidence_ids.is_empty() {
                bail!(
                    "acceptance for task {} requires a result digest and at least one evidence id",
                    acceptance.task_key
                );
            }
        }

        let evidence_records = self.read_evidence(work_id)?.records;
        let evidence_by_id = evidence_records
            .iter()
            .map(|record| (record.evidence_id.as_str(), record))
            .collect::<HashMap<_, _>>();
        let mut accepted_evidence = HashMap::new();
        for acceptance in &acceptances {
            let mut records = Vec::with_capacity(acceptance.evidence_ids.len());
            for evidence_id in &acceptance.evidence_ids {
                let evidence = evidence_by_id
                    .get(evidence_id.as_str())
                    .with_context(|| format!("unknown evidence id {evidence_id}"))?;
                if evidence.revision != expected_revision {
                    bail!(
                        "evidence {evidence_id} belongs to revision {}, expected {expected_revision}",
                        evidence.revision
                    );
                }
                records.push(*evidence);
            }
            accepted_evidence.insert(acceptance.task_key.clone(), records);
        }
        let now = Utc::now();
        for acceptance in &mut acceptances {
            acceptance.accepted_at = now;
        }
        self.mutate(work_id, expected_revision, move |plan, work| {
            let parsed = parse_plan(plan)?;
            let mut line_indices = HashMap::new();
            for acceptance in &acceptances {
                let key = &acceptance.task_key;
                let task = parsed
                    .task(key)
                    .with_context(|| format!("unknown task key {key}"))?;
                if task.completed {
                    bail!("task {key} is already completed");
                }
                let evidence = &accepted_evidence[key];
                for requirement in &task.evidence_requirements {
                    if !evidence
                        .iter()
                        .any(|record| requirement.matches(&record.evidence))
                    {
                        bail!(
                            "task {key} requires {requirement:?} evidence from the current revision"
                        );
                    }
                }
                line_indices.insert(key.clone(), task.line_index);
            }
            let mut updated_plan = plan.to_string();
            for acceptance in &acceptances {
                let key = acceptance.task_key.clone();
                work.acceptances.insert(key.clone(), acceptance.clone());
                updated_plan = set_checkbox(&updated_plan, line_indices[&key], true)?;
            }
            Ok(updated_plan)
        })
    }

    pub fn reopen_task(
        &self,
        work_id: &str,
        expected_revision: u64,
        task_key: &str,
        reason: &str,
    ) -> anyhow::Result<WorkSnapshot> {
        if reason.trim().is_empty() {
            bail!("reopen reason must not be empty");
        }
        let key = task_key.to_string();
        self.mutate(work_id, expected_revision, move |plan, work| {
            let parsed = parse_plan(plan)?;
            let task = parsed
                .task(&key)
                .with_context(|| format!("unknown task key {key}"))?;
            if !task.completed || work.acceptances.remove(&key).is_none() {
                bail!("task {key} has no acceptance to reopen");
            }
            set_checkbox(plan, task.line_index, false)
        })
    }

    pub fn append_notepad(
        &self,
        work_id: &str,
        name: &str,
        content: &str,
    ) -> anyhow::Result<PathBuf> {
        if !matches!(name, "learnings" | "decisions" | "issues" | "verification") {
            bail!("notepad name must be learnings, decisions, issues, or verification");
        }
        if content.trim().is_empty() {
            bail!("notepad content must not be empty");
        }
        let work_dir = self.work_dir(work_id)?;
        self.read_work(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let notes = work_dir.join("notepads");
        create_directory_no_follow(&notes)?;
        let path = notes.join(format!("{name}.md"));
        let mut file = open_append_no_follow(&path)?;
        writeln!(file, "\n{}", content.trim())?;
        file.sync_all()?;
        sync_directory(&notes)?;
        Ok(path)
    }

    pub fn read_notepad_tail(
        &self,
        work_id: &str,
        name: &str,
        max_bytes: usize,
    ) -> anyhow::Result<String> {
        if !matches!(name, "learnings" | "decisions" | "issues" | "verification") {
            bail!("unknown Orchestrate notepad {name}");
        }
        self.read_work(work_id)?;
        let path = self
            .work_dir(work_id)?
            .join("notepads")
            .join(format!("{name}.md"));
        if !path.exists() || max_bytes == 0 {
            return Ok(String::new());
        }
        let content = read_string_no_follow(&path)?;
        Ok(utf8_tail(&content, max_bytes).to_string())
    }

    pub fn claim_auto_continuation(
        &self,
        work_id: &str,
        expected_revision: u64,
        max_auto_turns: u32,
    ) -> anyhow::Result<ContinuationClaim> {
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let mut continuation = self.read_continuation_state_unlocked(&work_dir)?;
        if continuation.in_flight {
            return Ok(ContinuationClaim {
                snapshot: current,
                claimed: false,
                manual_intervention_newly_required: false,
            });
        }
        if continuation.auto_turn_count >= max_auto_turns {
            if continuation.manual_intervention_required {
                return Ok(ContinuationClaim {
                    snapshot: current,
                    claimed: false,
                    manual_intervention_newly_required: false,
                });
            }
            continuation.manual_intervention_required = true;
            continuation.stop_reason = Some("manual_intervention_required".to_string());
            write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
            return Ok(ContinuationClaim {
                snapshot: current,
                claimed: false,
                manual_intervention_newly_required: true,
            });
        }
        if continuation.auto_turn_count > 0 {
            if continuation.last_completed_items == Some(current.work.progress.completed) {
                continuation.stalled_rounds = continuation.stalled_rounds.saturating_add(1);
            } else {
                continuation.stalled_rounds = 0;
            }
        }
        continuation.last_completed_items = Some(current.work.progress.completed);
        continuation.auto_turn_count = continuation.auto_turn_count.saturating_add(1);
        continuation.last_claimed_at = Some(Utc::now());
        continuation.in_flight = true;
        write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
        sync_directory(&work_dir)?;
        Ok(ContinuationClaim {
            snapshot: current,
            claimed: true,
            manual_intervention_newly_required: false,
        })
    }

    pub fn reset_auto_continuation_after_user_input(
        &self,
        work_id: &str,
        expected_revision: u64,
    ) -> anyhow::Result<WorkSnapshot> {
        let snapshot = self.read_work(work_id)?;
        if snapshot.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: snapshot.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        write_json_atomic(
            &work_dir.join("continuation-state.json"),
            &ContinuationState::default(),
        )?;
        sync_directory(&work_dir)?;
        Ok(snapshot)
    }

    pub fn read_continuation_state(&self, work_id: &str) -> anyhow::Result<ContinuationState> {
        self.read_work(work_id)?;
        self.read_continuation_state_unlocked(&self.work_dir(work_id)?)
    }

    pub fn record_continuation_outcome(
        &self,
        work_id: &str,
        failed: bool,
    ) -> anyhow::Result<ContinuationState> {
        let work_dir = self.work_dir(work_id)?;
        self.read_work(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let mut continuation = self.read_continuation_state_unlocked(&work_dir)?;
        if !continuation.in_flight {
            return Ok(continuation);
        }
        continuation.consecutive_failures = if failed {
            continuation.consecutive_failures.saturating_add(1)
        } else {
            0
        };
        continuation.in_flight = false;
        write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
        sync_directory(&work_dir)?;
        Ok(continuation)
    }

    /// Persist the automatic-continuation stop reason; true means the caller should emit the single visible notice.
    pub fn require_manual_intervention(&self, work_id: &str, reason: &str) -> anyhow::Result<bool> {
        let work_dir = self.work_dir(work_id)?;
        self.read_work(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let mut continuation = self.read_continuation_state_unlocked(&work_dir)?;
        if continuation.manual_intervention_required {
            return Ok(false);
        }
        continuation.manual_intervention_required = true;
        continuation.stop_reason = Some(reason.to_string());
        write_json_atomic(&work_dir.join("continuation-state.json"), &continuation)?;
        sync_directory(&work_dir)?;
        Ok(true)
    }

    fn read_continuation_state_unlocked(
        &self,
        work_dir: &Path,
    ) -> anyhow::Result<ContinuationState> {
        let path = work_dir.join("continuation-state.json");
        if path.exists() {
            read_json_no_follow(&path)
        } else {
            Ok(ContinuationState::default())
        }
    }

    pub fn append_evidence(
        &self,
        work_id: &str,
        mut evidence: AgentEvidence,
    ) -> anyhow::Result<AgentEvidence> {
        let snapshot = self.read_work(work_id)?;
        if evidence.work_id != work_id
            || evidence.revision != snapshot.work.revision
            || evidence.plan_sha256 != snapshot.work.plan_sha256
        {
            bail!("evidence identity does not match the current work revision");
        }
        if evidence.evidence_id.is_empty() {
            evidence.evidence_id = format!("evidence_{}", Uuid::new_v4());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        // Recheck after locking to prevent TOCTOU between revision switching and evidence append.
        let current = self.read_work(work_id)?;
        if current.work.revision != evidence.revision
            || current.work.plan_sha256 != evidence.plan_sha256
        {
            return Err(PlanStoreError::RevisionConflict {
                expected: evidence.revision,
                current: current.work.revision,
            }
            .into());
        }
        evidence.recorded_at = Utc::now();
        let mut line = serde_json::to_vec(&evidence)?;
        if line.len() > 64 * 1024 {
            bail!("evidence record exceeds 64 KiB");
        }
        line.push(b'\n');
        let path = work_dir.join("evidence.jsonl");
        let mut file = open_append_no_follow(&path)?;
        file.write_all(&line)?;
        file.sync_all()?;
        sync_directory(&work_dir)?;
        Ok(evidence)
    }

    pub fn append_task_session(
        &self,
        work_id: &str,
        mut record: TaskSessionRecord,
    ) -> anyhow::Result<TaskSessionRecord> {
        if record.agent_id.trim().is_empty()
            || record.parent_session_id.trim().is_empty()
            || record.profile_fingerprint.trim().is_empty()
        {
            bail!("task session audit requires agent, parent session, and profile fingerprint");
        }
        let snapshot = self.read_work(work_id)?;
        if snapshot.work.revision != record.plan_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: record.plan_revision,
                current: snapshot.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != record.plan_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: record.plan_revision,
                current: current.work.revision,
            }
            .into());
        }
        record.recorded_at = Utc::now();
        let mut line = serde_json::to_vec(&record)?;
        if line.len() > 16 * 1024 {
            bail!("task session audit record exceeds 16 KiB");
        }
        line.push(b'\n');
        let mut file = open_append_no_follow(&work_dir.join("task-sessions.jsonl"))?;
        file.write_all(&line)?;
        file.sync_all()?;
        sync_directory(&work_dir)?;
        Ok(record)
    }

    pub fn read_task_sessions(&self, work_id: &str) -> anyhow::Result<Vec<TaskSessionRecord>> {
        self.read_work(work_id)?;
        let path = self.work_dir(work_id)?.join("task-sessions.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = read_bytes_no_follow(&path)?;
        if !bytes.ends_with(b"\n") {
            bail!("task session audit has a damaged trailing record");
        }
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).map_err(Into::into))
            .collect()
    }

    /// Append a runtime-authenticated user decision. Identical decision ID/content is idempotent; conflicting content fails closed.
    pub fn append_human_decision(
        &self,
        work_id: &str,
        mut record: HumanDecisionRecord,
    ) -> anyhow::Result<HumanDecisionRecord> {
        if record.actor != DecisionActor::User
            || record.work_id != work_id
            || record.decision_id.trim().is_empty()
            || record.question_id.trim().is_empty()
            || record.answer_summary.trim().is_empty()
        {
            bail!("invalid runtime-authenticated human decision record");
        }
        record.answer_summary = record.answer_summary.chars().take(2_048).collect();
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        record.stale = current.work.revision != record.plan_revision;
        record.recorded_at = Utc::now();
        let existing = self.read_human_decisions_unlocked(&work_dir)?;
        if let Some(saved) = existing
            .iter()
            .find(|saved| saved.decision_id == record.decision_id)
        {
            let mut comparable = record.clone();
            comparable.recorded_at = saved.recorded_at;
            if saved == &comparable {
                return Ok(saved.clone());
            }
            bail!(
                "human decision id {} already has different content",
                record.decision_id
            );
        }
        if let Some(supersedes) = record.supersedes.as_deref()
            && !existing.iter().any(|saved| saved.decision_id == supersedes)
        {
            bail!("human decision supersedes unknown record {supersedes}");
        }
        let mut line = serde_json::to_vec(&record)?;
        if line.len() > 8 * 1024 {
            bail!("human decision record exceeds 8 KiB");
        }
        line.push(b'\n');
        let mut file = open_append_no_follow(&work_dir.join("human-decisions.jsonl"))?;
        file.write_all(&line)?;
        file.sync_all()?;
        sync_directory(&work_dir)?;
        Ok(record)
    }

    pub fn read_human_decisions(&self, work_id: &str) -> anyhow::Result<Vec<HumanDecisionRecord>> {
        self.read_work(work_id)?;
        self.read_human_decisions_unlocked(&self.work_dir(work_id)?)
    }

    fn read_human_decisions_unlocked(
        &self,
        work_dir: &Path,
    ) -> anyhow::Result<Vec<HumanDecisionRecord>> {
        let path = work_dir.join("human-decisions.jsonl");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let bytes = read_bytes_no_follow(&path)?;
        if !bytes.ends_with(b"\n") {
            bail!("human decision audit has a damaged trailing record");
        }
        bytes
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).map_err(Into::into))
            .collect()
    }

    pub fn read_evidence(&self, work_id: &str) -> anyhow::Result<EvidenceReadResult> {
        self.read_work(work_id)?;
        let path = self.work_dir(work_id)?.join("evidence.jsonl");
        if !path.exists() {
            return Ok(EvidenceReadResult {
                records: Vec::new(),
                degraded_trailing_record: false,
            });
        }
        let bytes = read_bytes_no_follow(&path)?;
        let trailing_complete = bytes.ends_with(b"\n");
        let lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        let mut records = Vec::new();
        let mut degraded = false;
        for (index, line) in lines.iter().enumerate() {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<AgentEvidence>(line) {
                Ok(record) => records.push(record),
                Err(_) if index == lines.len() - 1 && !trailing_complete => degraded = true,
                Err(error) => bail!("corrupt evidence record {}: {error}", index + 1),
            }
        }
        Ok(EvidenceReadResult {
            records,
            degraded_trailing_record: degraded,
        })
    }

    pub fn evidence_by_id(
        &self,
        work_id: &str,
        evidence_id: &str,
    ) -> anyhow::Result<Option<AgentEvidence>> {
        Ok(self
            .read_evidence(work_id)?
            .records
            .into_iter()
            .find(|record| record.evidence_id == evidence_id))
    }

    pub fn record_critic_review(
        &self,
        work_id: &str,
        expected_revision: u64,
        expected_plan_sha256: &str,
        outcome: CriticReviewOutcome,
        max_rejects: usize,
        max_infrastructure_retries: usize,
    ) -> anyhow::Result<CriticReviewState> {
        let snapshot = self.read_work(work_id)?;
        if snapshot.work.revision != expected_revision
            || snapshot.work.plan_sha256 != expected_plan_sha256
        {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: snapshot.work.revision,
            }
            .into());
        }
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision
            || current.work.plan_sha256 != expected_plan_sha256
        {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let path = work_dir.join("review-state.json");
        let mut state = if path.exists() {
            let saved: CriticReviewState = read_json_no_follow(&path)?;
            if saved.revision == expected_revision && saved.plan_sha256 == expected_plan_sha256 {
                saved
            } else {
                new_critic_review_state(work_id, expected_revision, expected_plan_sha256)
            }
        } else {
            new_critic_review_state(work_id, expected_revision, expected_plan_sha256)
        };
        if state.automatic_review_stopped {
            bail!("automatic critic review already reached its configured limit");
        }
        match outcome {
            CriticReviewOutcome::Okay => {
                state.approved = true;
                state.automatic_review_stopped = true;
            }
            CriticReviewOutcome::Reject => {
                state.reject_count = state.reject_count.saturating_add(1);
                state.rejected_exhausted = state.reject_count >= max_rejects.max(1);
                state.automatic_review_stopped = state.rejected_exhausted;
            }
            CriticReviewOutcome::InfrastructureError => {
                state.infrastructure_retry_count =
                    state.infrastructure_retry_count.saturating_add(1);
                state.review_unavailable =
                    state.infrastructure_retry_count >= max_infrastructure_retries;
                state.automatic_review_stopped = state.review_unavailable;
            }
        }
        state.updated_at = Utc::now();
        write_json_atomic(&path, &state)?;
        sync_directory(&work_dir)?;
        Ok(state)
    }

    pub fn read_critic_review_state(
        &self,
        work_id: &str,
    ) -> anyhow::Result<Option<CriticReviewState>> {
        self.read_work(work_id)?;
        let path = self.work_dir(work_id)?.join("review-state.json");
        path.exists()
            .then(|| read_json_no_follow(&path))
            .transpose()
    }

    fn mutate(
        &self,
        work_id: &str,
        expected_revision: u64,
        operation: impl FnOnce(&str, &mut WorkState) -> anyhow::Result<String>,
    ) -> anyhow::Result<WorkSnapshot> {
        let work_dir = self.work_dir(work_id)?;
        let _lock = self.lock_work(&work_dir)?;
        let current = self.read_work(work_id)?;
        if current.work.revision != expected_revision {
            return Err(PlanStoreError::RevisionConflict {
                expected: expected_revision,
                current: current.work.revision,
            }
            .into());
        }
        let mut work = current.work;
        self.cleanup_uncommitted_revisions(&work_dir, work.revision)?;
        let plan = operation(&current.plan, &mut work)?;
        let parsed = parse_plan(&plan)?;
        work.revision += 1;
        work.updated_at = Utc::now();
        work.plan_sha256 = sha256(plan.as_bytes());
        work.progress = parsed.progress(work.plan_sha256.clone());
        if parsed.tasks.iter().all(|task| task.completed) {
            work.status = WorkStatus::Completed;
        } else if work.status == WorkStatus::Completed {
            work.status = WorkStatus::Active;
        }
        self.commit_revision(&work_dir, &plan, &work)?;
        Ok(WorkSnapshot { plan, work })
    }

    fn commit_revision(&self, work_dir: &Path, plan: &str, work: &WorkState) -> anyhow::Result<()> {
        let revisions = work_dir.join("revisions");
        create_directory_no_follow(&revisions)?;
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&revisions, false)?;
        let revision_dir = revisions.join(work.revision.to_string());
        create_new_directory(&revision_dir)
            .with_context(|| format!("revision {} already exists", work.revision))?;
        write_new_file(&revision_dir.join("plan.md"), plan.as_bytes())?;
        maybe_fail_planstore_commit("after_plan")?;
        let work_bytes = serde_json::to_vec_pretty(work)?;
        write_new_file(&revision_dir.join("work.json"), &work_bytes)?;
        maybe_fail_planstore_commit("after_work")?;
        sync_directory(&revision_dir)?;
        let manifest = CurrentManifest {
            schema_version: SCHEMA_VERSION,
            revision: work.revision,
            plan_sha256: work.plan_sha256.clone(),
            work_sha256: sha256(&work_bytes),
        };
        maybe_fail_planstore_commit("before_current")?;
        write_json_atomic(&work_dir.join("current.json"), &manifest)?;
        sync_directory(work_dir)
    }

    fn prepare_root(&self) -> anyhow::Result<()> {
        #[cfg(windows)]
        {
            let mut lease = self
                .root_lease
                .lock()
                .map_err(|_| anyhow::anyhow!("PlanStore root lease poisoned"))?;
            if lease.is_none() {
                *lease = Some(windows_io::DirectoryLease::acquire(&self.root, true)?);
            }
            windows_io::DirectoryLease::acquire(&self.root.join("works"), true)?;
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            bail!(
                "PlanStore requires secure handle-relative directory I/O; this platform is not supported yet"
            );
        }
        #[cfg(unix)]
        {
            if self
                .root_handle
                .lock()
                .map_err(|_| anyhow::anyhow!("PlanStore root handle lock poisoned"))?
                .is_some()
            {
                // Verify that the pinned handle and public path still identify the same inode before touching the replacement directory.
                let root = self.io_root()?;
                let works = root.join("works");
                if works.exists() {
                    ensure_not_symlink(&works)?;
                } else {
                    fs::create_dir(&works)?;
                }
                return Ok(());
            }
            create_dir_all_safe(&self.root)?;
            create_dir_all_safe(&self.root.join("works"))?;
            self.io_root()?;
            Ok(())
        }
    }

    fn lock_store(&self) -> anyhow::Result<LockGuard> {
        LockGuard::acquire(&self.io_root()?.join("store.lock"))
    }

    fn lock_work(&self, work_dir: &Path) -> anyhow::Result<LockGuard> {
        LockGuard::acquire(&work_dir.join("work.lock"))
    }

    fn work_dir(&self, work_id: &str) -> anyhow::Result<PathBuf> {
        validate_work_id(work_id)?;
        self.prepare_root()?;
        Ok(self.io_root()?.join("works").join(work_id))
    }

    fn read_index(&self) -> anyhow::Result<StoreIndex> {
        let path = self.io_root()?.join("state.json");
        if !path.exists() {
            return Ok(StoreIndex::default());
        }
        let index: StoreIndex = read_json_no_follow(&path)?;
        if index.schema_version != SCHEMA_VERSION {
            bail!(
                "unsupported PlanStore schema version {}",
                index.schema_version
            );
        }
        Ok(index)
    }

    fn write_index(&self, index: &StoreIndex) -> anyhow::Result<()> {
        let root = self.io_root()?;
        write_json_atomic(&root.join("state.json"), index)?;
        sync_directory(&root)
    }

    fn validate_indexed_work(&self, index: &StoreIndex, work_id: &str) -> anyhow::Result<()> {
        validate_work_id(work_id)?;
        if !index.works.contains_key(work_id) {
            return Err(PlanStoreError::WorkNotFound(work_id.to_string()).into());
        }
        Ok(())
    }

    fn cleanup_unindexed_works(&self, index: &StoreIndex) -> anyhow::Result<()> {
        let works = self.io_root()?.join("works");
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&works, false)?;
        for entry in read_directory(&works)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if validate_work_id(&name).is_err() || index.works.contains_key(&name) {
                continue;
            }
            let path = entry.path();
            ensure_not_symlink(&path)?;
            remove_directory_tree(&path)
                .with_context(|| format!("failed to clean orphan work {name}"))?;
        }
        sync_directory(&works)
    }

    fn cleanup_uncommitted_revisions(
        &self,
        work_dir: &Path,
        current_revision: u64,
    ) -> anyhow::Result<()> {
        let revisions = work_dir.join("revisions");
        #[cfg(windows)]
        let _lease = windows_io::DirectoryLease::acquire(&revisions, false)?;
        for entry in read_directory(&revisions)? {
            let entry = entry?;
            let Some(revision) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u64>().ok())
            else {
                continue;
            };
            if revision <= current_revision {
                continue;
            }
            let path = entry.path();
            ensure_not_symlink(&path)?;
            remove_directory_tree(&path)
                .with_context(|| format!("failed to clean uncommitted revision {revision}"))?;
        }
        sync_directory(&revisions)
    }

    #[cfg(unix)]
    fn io_root(&self) -> anyhow::Result<PathBuf> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        use std::os::unix::io::AsRawFd;

        let mut guard = self
            .root_handle
            .lock()
            .map_err(|_| anyhow::anyhow!("PlanStore root handle lock poisoned"))?;
        if guard.is_none() {
            ensure_not_symlink(&self.root)?;
            let mut options = OpenOptions::new();
            options
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
            *guard = Some(options.open(&self.root).with_context(|| {
                format!("failed to open PlanStore root {}", self.root.display())
            })?);
        }
        let handle = guard
            .as_ref()
            .expect("PlanStore root handle initialized above");
        ensure_not_symlink(&self.root)?;
        let original = fs::metadata(&self.root)
            .with_context(|| format!("PlanStore root disappeared: {}", self.root.display()))?;
        let opened = handle.metadata()?;
        if original.dev() != opened.dev() || original.ino() != opened.ino() {
            return Err(PlanStoreError::UnsafePath(format!(
                "PlanStore root was replaced: {}",
                self.root.display()
            ))
            .into());
        }
        #[cfg(target_os = "linux")]
        let fd_root = format!("/proc/self/fd/{}", handle.as_raw_fd());
        #[cfg(target_os = "linux")]
        return Ok(PathBuf::from(fd_root));

        #[cfg(target_os = "macos")]
        {
            use std::ffi::CStr;
            use std::os::unix::ffi::OsStringExt;

            // On macOS, /dev/fd/<n> can duplicate a descriptor but cannot serve as a prefix
            // for descendant traversal. Darwin F_GETPATH resolves an open descriptor's path;
            // verify the inode again afterward so I/O cannot be redirected to another directory.
            let mut buffer = vec![0 as libc::c_char; libc::PATH_MAX as usize];
            let result =
                unsafe { libc::fcntl(handle.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
            if result == -1 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to resolve macOS PlanStore root handle");
            }
            let resolved = unsafe { CStr::from_ptr(buffer.as_ptr()) };
            let resolved =
                PathBuf::from(std::ffi::OsString::from_vec(resolved.to_bytes().to_vec()));
            let resolved_metadata = fs::metadata(&resolved).with_context(|| {
                format!(
                    "resolved macOS PlanStore root disappeared: {}",
                    resolved.display()
                )
            })?;
            if resolved_metadata.dev() != opened.dev() || resolved_metadata.ino() != opened.ino() {
                return Err(PlanStoreError::UnsafePath(format!(
                    "resolved macOS PlanStore root changed: {}",
                    resolved.display()
                ))
                .into());
            }
            Ok(resolved)
        }

        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        bail!("PlanStore secure directory I/O is only supported on Linux and macOS Unix targets")
    }

    #[cfg(windows)]
    fn io_root(&self) -> anyhow::Result<PathBuf> {
        self.prepare_root()?;
        Ok(self.root.clone())
    }

    #[cfg(not(any(unix, windows)))]
    fn io_root(&self) -> anyhow::Result<PathBuf> {
        bail!(
            "PlanStore requires secure handle-relative directory I/O; this platform is not supported yet"
        )
    }
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

pub fn parse_plan(plan: &str) -> anyhow::Result<ParsedPlan> {
    let lines = plan.lines().collect::<Vec<_>>();
    if !lines.first().is_some_and(|line| line.starts_with("# ")) {
        bail!("plan must start with one level-one title");
    }
    let context = lines
        .iter()
        .position(|line| *line == "## Context")
        .context("missing ## Context")?;
    let todos = lines
        .iter()
        .position(|line| *line == "## TODOs")
        .context("missing ## TODOs")?;
    let final_wave = lines
        .iter()
        .position(|line| *line == "## Final Verification Wave")
        .context("missing ## Final Verification Wave")?;
    if !(context < todos && todos < final_wave) {
        bail!("plan sections must be ordered Context, TODOs, Final Verification Wave");
    }

    let mut tasks = Vec::new();
    let mut todo_number = 1usize;
    let mut final_number = 1usize;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("- [") && !line.starts_with("- [") {
            continue;
        }
        if !line.starts_with("- [") {
            continue;
        }
        let (completed, tail) = if let Some(tail) = line.strip_prefix("- [ ] ") {
            (false, tail)
        } else if let Some(tail) = line.strip_prefix("- [x] ") {
            (true, tail)
        } else {
            bail!("checkbox at line {} must use [ ] or [x]", index + 1);
        };
        if index > todos && index < final_wave {
            let prefix = format!("{todo_number}. ");
            if !tail.starts_with(&prefix) {
                bail!("TODO numbering must be contiguous at {todo_number}");
            }
            validate_todo_metadata(&lines, index, final_wave)?;
            tasks.push(PlanTask {
                key: todo_number.to_string(),
                completed,
                line_index: index,
                is_final_verification: false,
                evidence_requirements: Vec::new(),
            });
            todo_number += 1;
        } else if index > final_wave {
            let prefix = format!("F{final_number}. ");
            if !tail.starts_with(&prefix) {
                bail!("final verification numbering must be contiguous at F{final_number}");
            }
            let evidence_requirements = final_evidence_requirements(&lines, index)?;
            tasks.push(PlanTask {
                key: format!("F{final_number}"),
                completed,
                line_index: index,
                is_final_verification: true,
                evidence_requirements,
            });
            final_number += 1;
        } else {
            bail!(
                "checkbox at line {} is outside plan task sections",
                index + 1
            );
        }
    }
    if todo_number == 1 || final_number == 1 {
        bail!("TODOs and Final Verification Wave must each contain at least one item");
    }
    Ok(ParsedPlan { tasks })
}

fn final_evidence_requirements(
    lines: &[&str],
    task_line: usize,
) -> anyhow::Result<Vec<EvidenceRequirement>> {
    let end = ((task_line + 1)..lines.len())
        .find(|index| lines[*index].starts_with("- ["))
        .unwrap_or(lines.len());
    let values = (task_line + 1..end)
        .filter_map(|index| lines[index].strip_prefix("  - evidence: "))
        .collect::<Vec<_>>();
    if values.len() != 1 {
        bail!(
            "final verification at line {} must declare exactly one `  - evidence:` metadata line",
            task_line + 1
        );
    }
    let requirements = values[0]
        .split(',')
        .map(EvidenceRequirement::parse)
        .collect::<anyhow::Result<Vec<_>>>()?;
    if requirements.is_empty() {
        bail!("final verification evidence requirement must not be empty");
    }
    Ok(requirements)
}

fn validate_todo_metadata(
    lines: &[&str],
    task_line: usize,
    final_wave: usize,
) -> anyhow::Result<()> {
    let end = ((task_line + 1)..final_wave)
        .find(|index| lines[*index].starts_with("- ["))
        .unwrap_or(final_wave);
    for field in ["artifacts", "write_scope", "acceptance", "verify"] {
        let prefix = format!("  - {field}: ");
        if !(task_line + 1..end).any(|index| lines[index].starts_with(&prefix)) {
            bail!("TODO at line {} is missing {field} metadata", task_line + 1);
        }
    }
    Ok(())
}

fn task_block<'a>(plan: &'a str, task_key: &str) -> anyhow::Result<&'a str> {
    let parsed = parse_plan(plan)?;
    let task = parsed.task(task_key).context("unknown task")?;
    let starts = plan
        .match_indices('\n')
        .map(|(index, _)| index + 1)
        .collect::<Vec<_>>();
    let start = if task.line_index == 0 {
        0
    } else {
        starts[task.line_index - 1]
    };
    let next_line = parsed
        .tasks
        .iter()
        .filter(|candidate| candidate.line_index > task.line_index)
        .map(|candidate| candidate.line_index)
        .min();
    let end = next_line
        .and_then(|line| {
            if line == 0 {
                Some(0)
            } else {
                starts.get(line - 1).copied()
            }
        })
        .unwrap_or(plan.len());
    Ok(&plan[start..end])
}

fn set_checkbox(plan: &str, line_index: usize, completed: bool) -> anyhow::Result<String> {
    let mut lines = plan.lines().map(str::to_string).collect::<Vec<_>>();
    let line = lines.get_mut(line_index).context("task line disappeared")?;
    let from = if completed { "- [ ] " } else { "- [x] " };
    let to = if completed { "- [x] " } else { "- [ ] " };
    if !line.starts_with(from) {
        bail!("task checkbox is not in the expected state");
    }
    *line = line.replacen(from, to, 1);
    let mut result = lines.join("\n");
    if plan.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

fn validate_display_slug(slug: &str) -> anyhow::Result<()> {
    if slug.is_empty()
        || slug.len() > 80
        || !slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("display_slug must contain only ASCII letters, digits, '-' or '_'");
    }
    Ok(())
}

struct StoreDirectoryEntry(PathBuf);
impl StoreDirectoryEntry {
    fn path(&self) -> PathBuf {
        self.0.clone()
    }
    fn file_name(&self) -> std::ffi::OsString {
        self.0.file_name().unwrap_or_default().to_owned()
    }
}

fn read_directory(
    path: &Path,
) -> anyhow::Result<impl Iterator<Item = std::io::Result<StoreDirectoryEntry>> + '_> {
    #[cfg(windows)]
    {
        let lease = windows_io::DirectoryLease::acquire(path, false)?;
        Ok(windows_directory::enumerate(lease.handle())?
            .into_iter()
            .map(|name| Ok(StoreDirectoryEntry(path.join(name)))))
    }
    #[cfg(not(windows))]
    Ok(fs::read_dir(path)?.map(|entry| entry.map(|entry| StoreDirectoryEntry(entry.path()))))
}

fn remove_directory_tree(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let lease = windows_io::DirectoryLease::parent(path)?;
        windows_directory::delete_tree(lease.handle(), path.file_name().context("missing leaf")?)
    }
    #[cfg(not(windows))]
    Ok(fs::remove_dir_all(path)?)
}

fn create_new_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let lease = windows_io::DirectoryLease::parent(path)?;
        windows_io::open_relative(
            lease.handle(),
            path.file_name().context("missing leaf")?,
            FILE_GENERIC_READ,
            2,
            1,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
        )?;
        Ok(())
    }
    #[cfg(not(windows))]
    Ok(fs::create_dir(path)?)
}

fn validate_work_id(work_id: &str) -> anyhow::Result<()> {
    let Some(uuid) = work_id.strip_prefix("work_") else {
        return Err(PlanStoreError::InvalidWorkId(work_id.to_string()).into());
    };
    let parsed =
        Uuid::parse_str(uuid).map_err(|_| PlanStoreError::InvalidWorkId(work_id.to_string()))?;
    if parsed.get_version_num() != 4 {
        return Err(PlanStoreError::InvalidWorkId(work_id.to_string()).into());
    }
    Ok(())
}

#[cfg(windows)]
fn create_dir_all_safe(path: &Path) -> anyhow::Result<()> {
    windows_io::DirectoryLease::acquire(path, true)?;
    Ok(())
}

#[cfg(not(windows))]
fn create_dir_all_safe(path: &Path) -> anyhow::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => current.push(component.as_os_str()),
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err(PlanStoreError::UnsafePath(path.display().to_string()).into());
            }
            Component::Normal(part) => current.push(part),
        }
        if current.exists() {
            ensure_not_symlink(&current)?;
        } else {
            fs::create_dir(&current)?;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn create_directory_no_follow(path: &Path) -> anyhow::Result<()> {
    create_dir_all_safe(path)
}

#[cfg(not(windows))]
fn create_directory_no_follow(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        ensure_not_symlink(path)?;
    } else {
        fs::create_dir(path)?;
        ensure_not_symlink(path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn ensure_not_symlink(path: &Path) -> anyhow::Result<()> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    let lease = windows_io::DirectoryLease::parent(path)?;
    let file = windows_io::open_relative(
        lease.handle(),
        path.file_name().context("missing leaf")?,
        FILE_READ_ATTRIBUTES,
        1,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    )?;
    if file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(PlanStoreError::UnsafePath(path.display().to_string()).into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn ensure_not_symlink(path: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect PlanStore path {}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(PlanStoreError::UnsafePath(path.display().to_string()).into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_options_no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(not(any(unix, windows)))]
    let _ = options;
}

#[cfg(windows)]
fn open_rw_no_follow(path: &Path) -> anyhow::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    windows_io::open_file(
        path,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        3,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
}

#[cfg(not(windows))]
fn open_rw_no_follow(path: &Path) -> anyhow::Result<File> {
    if let Some(parent) = path.parent() {
        if parent.exists() {
            if !is_unix_fd_root(parent) {
                ensure_not_symlink(parent)?;
            }
        } else {
            create_dir_all_safe(parent)?;
        }
    }
    if path.exists() {
        ensure_not_symlink(path)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    open_options_no_follow(&mut options);
    let file = options.open(path)?;
    Ok(file)
}

#[cfg(not(windows))]
fn is_unix_fd_root(path: &Path) -> bool {
    #[cfg(unix)]
    {
        let components = path.components().collect::<Vec<_>>();
        let proc_fd = components.len() == 5
            && components[0] == Component::RootDir
            && components[1].as_os_str() == "proc"
            && components[2].as_os_str() == "self"
            && components[3].as_os_str() == "fd"
            && components[4]
                .as_os_str()
                .to_string_lossy()
                .parse::<i32>()
                .is_ok();
        let dev_fd = components.len() == 4
            && components[0] == Component::RootDir
            && components[1].as_os_str() == "dev"
            && components[2].as_os_str() == "fd"
            && components[3]
                .as_os_str()
                .to_string_lossy()
                .parse::<i32>()
                .is_ok();
        proc_fd || dev_fd
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        false
    }
}

#[cfg(windows)]
fn open_append_no_follow(path: &Path) -> anyhow::Result<File> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_APPEND_DATA, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    windows_io::open_file(
        path,
        FILE_APPEND_DATA | FILE_READ_ATTRIBUTES,
        3,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
}

#[cfg(not(windows))]
fn open_append_no_follow(path: &Path) -> anyhow::Result<File> {
    if path.exists() {
        ensure_not_symlink(path)?;
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    open_options_no_follow(&mut options);
    let file = options.open(path)?;
    Ok(file)
}

fn read_bytes_no_follow(path: &Path) -> anyhow::Result<Vec<u8>> {
    #[cfg(windows)]
    let mut file = {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        windows_io::open_file(
            path,
            FILE_GENERIC_READ,
            1,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )?
    };
    #[cfg(not(windows))]
    let mut file = {
        ensure_not_symlink(path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        open_options_no_follow(&mut options);
        options.open(path)?
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn read_string_no_follow(path: &Path) -> anyhow::Result<String> {
    String::from_utf8(read_bytes_no_follow(path)?).context("PlanStore file is not UTF-8")
}

fn read_json_no_follow<T: for<'de> Deserialize<'de>>(path: &Path) -> anyhow::Result<T> {
    Ok(serde_json::from_slice(&read_bytes_no_follow(path)?)?)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    #[cfg(windows)]
    let mut file = {
        use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_WRITE, FILE_SHARE_READ};
        windows_io::open_file(path, FILE_GENERIC_WRITE, 2, FILE_SHARE_READ)?
    };
    #[cfg(not(windows))]
    let mut file = {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        open_options_no_follow(&mut options);
        options.open(path)?
    };
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    #[cfg(windows)]
    return windows_io::write_atomic(path, &serde_json::to_vec_pretty(value)?);
    #[cfg(not(windows))]
    write_bytes_atomic(path, &serde_json::to_vec_pretty(value)?)
}

fn sync_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        // File contents are flushed before and after handle-relative publication.
        // Windows does not support FlushFileBuffers on a read-only directory handle.
        let _lease = windows_io::DirectoryLease::acquire(path, false)?;
    }
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn utf8_tail(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(title: &str) -> String {
        format!(
            "# {title}\n\n## Context\n目标。\n\n## TODOs\n- [ ] 1. 实现一个动作\n  - artifacts: src/lib.rs\n  - write_scope: src/\n  - acceptance: focused test passes\n  - verify: cargo test\n\n## Final Verification Wave\n- [ ] F1. 工作区测试通过\n  - evidence: manual\n"
        )
    }

    #[cfg(windows)]
    #[test]
    fn windows_plan_store_pins_root_and_supports_revision_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("windows", &plan("Windows"), "session", true)
            .unwrap();
        assert_eq!(
            store.active_work_id().unwrap(),
            Some(created.work.work_id.clone())
        );
        assert!(fs::rename(store.root(), temp.path().join("replaced")).is_err());
        assert_eq!(
            store.read_work(&created.work.work_id).unwrap().plan,
            created.plan
        );
        drop(store);
        fs::rename(
            temp.path().join(".kcoder/orchestrate"),
            temp.path().join("replaced"),
        )
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_plan_store_rejects_junction_directory() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".kcoder")).unwrap();
        let link = temp.path().join(".kcoder").join("orchestrate");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(status.success());
        let store = PlanStore::for_workspace(temp.path());
        assert!(store.active_work_id().is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_dir(link).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_atomic_publish_retains_target_on_post_publish_failure() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("current.json");
        let _failure = PlanStoreFailpointGuard::set("after_windows_publish");
        assert!(windows_io::write_atomic(&path, b"new").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_write_rejects_existing_hardlinks() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("events.jsonl");
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, b"unchanged").unwrap();
        fs::hard_link(&outside, &file).unwrap();
        assert!(open_append_no_follow(&file).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"unchanged");
    }

    #[cfg(windows)]
    #[test]
    fn windows_atomic_replace_coexists_with_read_handle() {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_GENERIC_READ, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("current.json");
        windows_io::write_atomic(&path, b"old").unwrap();
        let mut reader = windows_io::open_file(
            &path,
            FILE_GENERIC_READ,
            windows_io::FILE_OPEN,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        )
        .unwrap();
        windows_io::write_atomic(&path, b"new").unwrap();
        let mut old = String::new();
        reader.read_to_string(&mut old).unwrap();
        assert_eq!(old, "old");
        assert_eq!(read_bytes_no_follow(&path).unwrap(), b"new");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_plan_store_can_traverse_opened_root_handle() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());

        assert_eq!(store.active_work_id().unwrap(), None);
        assert!(store.root().join("works").is_dir());
        assert!(store.root().join("store.lock").is_file());
    }

    #[test]
    fn parser_requires_strict_sections_metadata_and_contiguous_numbers() {
        let parsed = parse_plan(&plan("严格计划")).unwrap();
        assert_eq!(parsed.tasks.len(), 2);
        assert_eq!(parsed.tasks[0].key, "1");
        assert_eq!(parsed.tasks[1].key, "F1");
        assert!(parse_plan(&plan("坏计划").replace("1. 实现", "2. 实现")).is_err());
        assert!(parse_plan(&plan("坏计划").replace("  - verify: cargo test\n", "")).is_err());
        assert!(parse_plan(&plan("坏计划").replace("  - evidence: manual\n", "")).is_err());
    }

    #[test]
    fn same_slug_creates_distinct_uuid_v4_work_ids_and_explicit_active_pointer() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let first = store
            .create_work("same", &plan("一"), "session-a", true)
            .unwrap();
        let second = store
            .create_work("same", &plan("二"), "session-a", false)
            .unwrap();

        assert_ne!(first.work.work_id, second.work.work_id);
        assert_eq!(
            store.active_work_id().unwrap().as_deref(),
            Some(first.work.work_id.as_str())
        );
        store.select_active_work(&second.work.work_id).unwrap();
        assert_eq!(
            store.read_active_work().unwrap().work.work_id,
            second.work.work_id
        );
    }

    #[test]
    fn edit_is_cas_guarded_and_cannot_change_checkbox_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("edit", &plan("原计划"), "session-a", true)
            .unwrap();
        let edited = store
            .edit_plan(
                &created.work.work_id,
                1,
                "实现一个动作",
                "实现单一动作",
                false,
            )
            .unwrap();
        assert_eq!(edited.work.revision, 2);
        let error = store
            .edit_plan(&created.work.work_id, 1, "单一", "原子", false)
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<PlanStoreError>()
                .is_some_and(|error| matches!(error, PlanStoreError::RevisionConflict { .. }))
        );
        assert!(
            store
                .edit_plan(&created.work.work_id, 2, "- [ ] 1.", "- [x] 1.", false)
                .is_err()
        );
    }

    #[test]
    fn acceptance_and_reopen_are_the_only_checkbox_mutations() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("accept", &plan("验收"), "session-a", true)
            .unwrap();
        store
            .append_evidence(
                &created.work.work_id,
                AgentEvidence {
                    evidence_id: "evidence-1".to_string(),
                    work_id: created.work.work_id.clone(),
                    revision: 1,
                    plan_sha256: created.work.plan_sha256.clone(),
                    agent_id: "agent-1".to_string(),
                    workspace_digest: "sha256:workspace".to_string(),
                    recorded_at: Utc::now(),
                    evidence: AgentEvidenceKind::Manual {
                        statement: "manual check".to_string(),
                        recorded_by: "user".to_string(),
                    },
                },
            )
            .unwrap();
        let accepted = store
            .record_acceptance(
                &created.work.work_id,
                1,
                AcceptanceRecord {
                    task_key: "1".to_string(),
                    result_digest: "sha256:result".to_string(),
                    evidence_ids: vec!["evidence-1".to_string()],
                    works: true,
                    conforms: true,
                    matches_contract: true,
                    honored_boundaries: true,
                    accepted_at: Utc::now(),
                },
            )
            .unwrap();
        assert!(accepted.plan.contains("- [x] 1."));
        let reopened = store
            .reopen_task(&created.work.work_id, 2, "1", "regression")
            .unwrap();
        assert!(reopened.plan.contains("- [ ] 1."));
        assert!(reopened.work.acceptances.is_empty());
    }

    #[test]
    fn batch_acceptance_uses_one_revision_for_a_shared_verification_wave() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("batch", &plan("批量验收"), "session-a", true)
            .unwrap();
        for evidence in [
            AgentEvidence {
                evidence_id: "process-current".to_string(),
                work_id: created.work.work_id.clone(),
                revision: 1,
                plan_sha256: created.work.plan_sha256.clone(),
                agent_id: "verifier-a".to_string(),
                workspace_digest: "digest".to_string(),
                recorded_at: Utc::now(),
                evidence: AgentEvidenceKind::ProcessExit {
                    tool: "bash".to_string(),
                    command: "cargo test".to_string(),
                    exit_code: Some(0),
                    signal: None,
                    cwd: temp.path().to_path_buf(),
                    raw_exit_code: true,
                },
            },
            AgentEvidence {
                evidence_id: "manual-current".to_string(),
                work_id: created.work.work_id.clone(),
                revision: 1,
                plan_sha256: created.work.plan_sha256.clone(),
                agent_id: "verifier-a".to_string(),
                workspace_digest: "digest".to_string(),
                recorded_at: Utc::now(),
                evidence: AgentEvidenceKind::Manual {
                    statement: "final review complete".to_string(),
                    recorded_by: "verifier-a".to_string(),
                },
            },
        ] {
            store
                .append_evidence(&created.work.work_id, evidence)
                .unwrap();
        }

        let completed = store
            .record_acceptances(
                &created.work.work_id,
                1,
                vec![
                    acceptance("1", "process-current"),
                    acceptance("F1", "manual-current"),
                ],
            )
            .unwrap();

        assert_eq!(completed.work.revision, 2);
        assert_eq!(completed.work.status, WorkStatus::Completed);
        assert_eq!(completed.work.acceptances.len(), 2);
        assert!(completed.plan.contains("- [x] 1."));
        assert!(completed.plan.contains("- [x] F1."));
    }

    #[test]
    fn final_acceptance_requires_declared_evidence_type_and_completes_work() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("typed", &plan("类型"), "session-a", true)
            .unwrap();
        let manual = |revision: u64, sha: &str, id: &str| AgentEvidence {
            evidence_id: id.to_string(),
            work_id: created.work.work_id.clone(),
            revision,
            plan_sha256: sha.to_string(),
            agent_id: "agent-a".to_string(),
            workspace_digest: "digest".to_string(),
            recorded_at: Utc::now(),
            evidence: AgentEvidenceKind::Manual {
                statement: "人工复核".to_string(),
                recorded_by: "user".to_string(),
            },
        };
        store
            .append_evidence(
                &created.work.work_id,
                manual(1, &created.work.plan_sha256, "todo"),
            )
            .unwrap();
        let task = store
            .record_acceptance(&created.work.work_id, 1, acceptance("1", "todo"))
            .unwrap();
        store
            .append_evidence(
                &created.work.work_id,
                manual(2, &task.work.plan_sha256, "final"),
            )
            .unwrap();
        let completed = store
            .record_acceptance(&created.work.work_id, 2, acceptance("F1", "final"))
            .unwrap();
        assert_eq!(completed.work.status, WorkStatus::Completed);
        assert_eq!(
            completed.work.progress.completed,
            completed.work.progress.total
        );
        let reopened = store
            .reopen_task(&created.work.work_id, 3, "F1", "发现新风险")
            .unwrap();
        assert_eq!(reopened.work.status, WorkStatus::Active);
    }

    fn acceptance(task_key: &str, evidence_id: &str) -> AcceptanceRecord {
        AcceptanceRecord {
            task_key: task_key.to_string(),
            result_digest: "sha256:result".to_string(),
            evidence_ids: vec![evidence_id.to_string()],
            works: true,
            conforms: true,
            matches_contract: true,
            honored_boundaries: true,
            accepted_at: Utc::now(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_workspace_prefix_is_accepted_without_weakening_store_checks() {
        use std::os::unix::fs::symlink;

        let real_parent = tempfile::tempdir().unwrap();
        let real_workspace = real_parent.path().join("workspace");
        fs::create_dir(&real_workspace).unwrap();
        let alias_parent = tempfile::tempdir().unwrap();
        let alias = alias_parent.path().join("workspace-parent-alias");
        symlink(real_parent.path(), &alias).unwrap();
        let aliased_workspace = alias.join("workspace");

        let store = PlanStore::for_workspace(&aliased_workspace);

        assert_eq!(store.active_work_id().unwrap(), None);
        assert_eq!(
            store.root(),
            real_workspace.join(".kcoder/orchestrate").as_path()
        );
        assert!(real_workspace.join(".kcoder/orchestrate/works").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_store_component_fails_closed() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".kcoder")).unwrap();
        symlink(outside.path(), temp.path().join(".kcoder/orchestrate")).unwrap();
        let store = PlanStore::for_workspace(temp.path());

        let error = store
            .create_work("unsafe", &plan("不安全"), "session-a", true)
            .unwrap_err();

        assert!(
            error
                .downcast_ref::<PlanStoreError>()
                .is_some_and(|error| matches!(error, PlanStoreError::UnsafePath(_)))
        );
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn replaced_store_parent_is_detected_and_never_writes_to_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("parent-race", &plan("父目录替换"), "session-a", true)
            .unwrap();
        let original = temp.path().join("original-orchestrate");
        fs::rename(store.root(), &original).unwrap();
        fs::create_dir_all(store.root().join("works")).unwrap();

        let error = store
            .append_notepad(&created.work.work_id, "issues", "不得写入替换目录")
            .unwrap_err();

        assert!(
            error
                .downcast_ref::<PlanStoreError>()
                .is_some_and(|error| matches!(error, PlanStoreError::UnsafePath(_)))
        );
        assert_eq!(fs::read_dir(store.root().join("works")).unwrap().count(), 0);
        assert!(!store.root().join("state.json").exists());
    }

    #[test]
    fn current_manifest_digest_mismatch_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("digest", &plan("摘要"), "session-a", true)
            .unwrap();
        let path = store
            .root()
            .join("works")
            .join(&created.work.work_id)
            .join("revisions/1/plan.md");
        fs::write(path, "tampered").unwrap();
        assert!(store.read_work(&created.work.work_id).is_err());
    }

    #[test]
    fn corrupt_index_lists_candidates_but_requires_explicit_selection_to_repair() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let first = store
            .create_work("first", &plan("第一项"), "session-a", true)
            .unwrap();
        let second = store
            .create_work("second", &plan("第二项"), "session-a", false)
            .unwrap();
        fs::write(store.root().join("state.json"), b"{damaged").unwrap();

        assert!(store.active_work_id().is_err());
        let candidates = store.list_works().unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(store.active_work_id().is_err());

        store.select_active_work(&second.work.work_id).unwrap();
        assert_eq!(
            store.active_work_id().unwrap().as_deref(),
            Some(second.work.work_id.as_str())
        );
        assert_ne!(first.work.work_id, second.work.work_id);
    }

    #[test]
    fn notepad_tail_is_utf8_bounded_and_continuation_claim_is_persistent() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("continue", &plan("续跑"), "session-a", true)
            .unwrap();
        store
            .append_notepad(&created.work.work_id, "learnings", "开头-甲乙丙-结尾")
            .unwrap();
        let tail = store
            .read_notepad_tail(&created.work.work_id, "learnings", 10)
            .unwrap();
        assert!(tail.len() <= 10);
        assert!(tail.trim_end().ends_with("结尾"));

        let first = store
            .claim_auto_continuation(&created.work.work_id, 1, 1)
            .unwrap();
        assert!(first.claimed);
        assert_eq!(
            store
                .read_continuation_state(&created.work.work_id)
                .unwrap()
                .auto_turn_count,
            1
        );
        store
            .record_continuation_outcome(&created.work.work_id, false)
            .unwrap();
        let capped = store
            .claim_auto_continuation(&created.work.work_id, first.snapshot.work.revision, 1)
            .unwrap();
        assert!(!capped.claimed);
        assert!(
            store
                .read_continuation_state(&created.work.work_id)
                .unwrap()
                .manual_intervention_required
        );
    }

    #[test]
    fn concurrent_revision_cas_has_one_winner_without_lost_update() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("race", &plan("并发"), "session-a", true)
            .unwrap();
        let work_id = created.work.work_id.clone();
        let first = store.clone();
        let first_id = work_id.clone();
        let second = store.clone();
        let second_id = work_id.clone();
        let a = std::thread::spawn(move || {
            first.edit_plan(&first_id, 1, "实现一个动作", "实现动作 A", false)
        });
        let b = std::thread::spawn(move || {
            second.edit_plan(&second_id, 1, "实现一个动作", "实现动作 B", false)
        });
        let results = [a.join().unwrap(), b.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(store.read_work(&work_id).unwrap().work.revision, 2);
    }

    #[test]
    fn commit_failpoints_never_switch_current_and_orphans_are_recoverable() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("fault", &plan("故障"), "session-a", true)
            .unwrap();
        {
            let _guard = PlanStoreFailpointGuard::set("before_current");
            assert!(
                store
                    .edit_plan(
                        &created.work.work_id,
                        1,
                        "实现一个动作",
                        "实现新动作",
                        false
                    )
                    .is_err()
            );
        }
        assert_eq!(
            store
                .read_work(&created.work.work_id)
                .unwrap()
                .work
                .revision,
            1
        );
        let retried = store
            .edit_plan(
                &created.work.work_id,
                1,
                "实现一个动作",
                "实现新动作",
                false,
            )
            .unwrap();
        assert_eq!(retried.work.revision, 2);

        let orphan_temp = tempfile::tempdir().unwrap();
        let orphan_store = PlanStore::for_workspace(orphan_temp.path());
        {
            let _guard = PlanStoreFailpointGuard::set("before_index");
            assert!(
                orphan_store
                    .create_work("orphan", &plan("孤儿"), "session-a", true)
                    .is_err()
            );
        }
        assert_eq!(orphan_store.active_work_id().unwrap(), None);
        assert_eq!(
            fs::read_dir(orphan_store.root().join("works"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn concurrent_evidence_appends_are_complete_jsonl_records() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("append", &plan("追加"), "session-a", true)
            .unwrap();
        let mut threads = Vec::new();
        for index in 0..8 {
            let store = store.clone();
            let work = created.work.clone();
            threads.push(std::thread::spawn(move || {
                store.append_evidence(
                    &work.work_id,
                    AgentEvidence {
                        evidence_id: format!("e-{index}"),
                        work_id: work.work_id.clone(),
                        revision: work.revision,
                        plan_sha256: work.plan_sha256.clone(),
                        agent_id: format!("agent-{index}"),
                        workspace_digest: "digest".to_string(),
                        recorded_at: Utc::now(),
                        evidence: AgentEvidenceKind::Citation {
                            url: format!("https://example.test/{index}"),
                            source_date: None,
                        },
                    },
                )
            }));
        }
        for thread in threads {
            thread.join().unwrap().unwrap();
        }
        let result = store.read_evidence(&created.work.work_id).unwrap();
        assert_eq!(result.records.len(), 8);
        assert!(!result.degraded_trailing_record);
    }

    #[test]
    fn task_session_audit_binds_parent_fingerprint_and_plan_revision() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let work = store
            .create_work("sessions", &plan("会话审计"), "parent-a", true)
            .unwrap();
        let record = TaskSessionRecord {
            agent_id: "agent-a".to_string(),
            parent_session_id: "parent-a".to_string(),
            plan_revision: work.work.revision,
            status: "spawned".to_string(),
            profile_fingerprint: "sha256:profile".to_string(),
            recorded_at: Utc::now(),
        };

        store
            .append_task_session(&work.work.work_id, record.clone())
            .unwrap();
        let records = store.read_task_sessions(&work.work.work_id).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].parent_session_id, "parent-a");
        assert_eq!(records[0].profile_fingerprint, "sha256:profile");

        let mut stale = record;
        stale.agent_id = "agent-b".to_string();
        stale.plan_revision += 1;
        assert!(
            store
                .append_task_session(&work.work.work_id, stale)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn evidence_leaf_symlink_is_rejected_without_touching_outside_target() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("leaf", &plan("叶子"), "session-a", true)
            .unwrap();
        let outside = temp.path().join("outside.jsonl");
        fs::write(&outside, "unchanged").unwrap();
        let evidence_path = store
            .work_dir(&created.work.work_id)
            .unwrap()
            .join("evidence.jsonl");
        symlink(&outside, &evidence_path).unwrap();
        let error = store
            .append_evidence(
                &created.work.work_id,
                AgentEvidence {
                    evidence_id: "e".to_string(),
                    work_id: created.work.work_id.clone(),
                    revision: 1,
                    plan_sha256: created.work.plan_sha256,
                    agent_id: "agent".to_string(),
                    workspace_digest: "digest".to_string(),
                    recorded_at: Utc::now(),
                    evidence: AgentEvidenceKind::Manual {
                        statement: "x".to_string(),
                        recorded_by: "user".to_string(),
                    },
                },
            )
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<PlanStoreError>()
                .is_some_and(|error| { matches!(error, PlanStoreError::UnsafePath(_)) })
        );
        assert_eq!(fs::read_to_string(outside).unwrap(), "unchanged");
    }

    #[test]
    fn evidence_trailing_damage_degrades_but_middle_damage_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("evidence", &plan("证据"), "session-a", true)
            .unwrap();
        let record = AgentEvidence {
            evidence_id: "e-1".to_string(),
            work_id: created.work.work_id.clone(),
            revision: 1,
            plan_sha256: created.work.plan_sha256.clone(),
            agent_id: "agent-a".to_string(),
            workspace_digest: "digest".to_string(),
            recorded_at: Utc::now(),
            evidence: AgentEvidenceKind::Citation {
                url: "https://example.test".to_string(),
                source_date: None,
            },
        };
        store
            .append_evidence(&created.work.work_id, record.clone())
            .unwrap();
        let path = store
            .work_dir(&created.work.work_id)
            .unwrap()
            .join("evidence.jsonl");
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{broken")
            .unwrap();
        let read = store.read_evidence(&created.work.work_id).unwrap();
        assert_eq!(read.records.len(), 1);
        assert!(read.degraded_trailing_record);

        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.extend_from_slice(b"\n{broken}\n");
        bytes.extend_from_slice(&serde_json::to_vec(&record).unwrap());
        bytes.push(b'\n');
        fs::write(&path, bytes).unwrap();
        assert!(store.read_evidence(&created.work.work_id).is_err());
    }

    #[test]
    fn continuation_runtime_state_does_not_create_plan_revisions() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("counter", &plan("计数"), "session-a", true)
            .unwrap();
        let claim = store
            .claim_auto_continuation(&created.work.work_id, 1, 8)
            .unwrap();
        assert!(claim.claimed);
        assert!(
            store
                .read_continuation_state(&created.work.work_id)
                .unwrap()
                .in_flight
        );
        assert_eq!(
            store
                .read_work(&created.work.work_id)
                .unwrap()
                .work
                .revision,
            1
        );
        store
            .record_continuation_outcome(&created.work.work_id, true)
            .unwrap();
        let continuation = store
            .read_continuation_state(&created.work.work_id)
            .unwrap();
        assert_eq!(continuation.consecutive_failures, 1);
        assert!(!continuation.in_flight);
        assert!(
            store
                .require_manual_intervention(&created.work.work_id, "consecutive_failures")
                .unwrap()
        );
        assert!(
            !store
                .require_manual_intervention(&created.work.work_id, "consecutive_failures")
                .unwrap()
        );
        store
            .reset_auto_continuation_after_user_input(&created.work.work_id, 1)
            .unwrap();
        assert_eq!(
            store
                .read_continuation_state(&created.work.work_id)
                .unwrap(),
            ContinuationState::default()
        );
    }

    #[test]
    fn critic_reject_and_infrastructure_limits_are_independent() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("review", &plan("评审"), "session-a", true)
            .unwrap();
        let rejected = store
            .record_critic_review(
                &created.work.work_id,
                1,
                &created.work.plan_sha256,
                CriticReviewOutcome::Reject,
                3,
                2,
            )
            .unwrap();
        assert_eq!(rejected.reject_count, 1);
        assert_eq!(rejected.infrastructure_retry_count, 0);
        let unavailable = store
            .record_critic_review(
                &created.work.work_id,
                1,
                &created.work.plan_sha256,
                CriticReviewOutcome::InfrastructureError,
                3,
                1,
            )
            .unwrap();
        assert_eq!(unavailable.reject_count, 1);
        assert!(unavailable.review_unavailable);
        assert!(unavailable.automatic_review_stopped);
    }

    #[test]
    fn critic_reject_limit_persists_explicit_exhausted_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("review-limit", &plan("拒绝上限"), "session-a", true)
            .unwrap();

        for expected in 1..=3 {
            let review = store
                .record_critic_review(
                    &created.work.work_id,
                    1,
                    &created.work.plan_sha256,
                    CriticReviewOutcome::Reject,
                    3,
                    2,
                )
                .unwrap();
            assert_eq!(review.reject_count, expected);
            assert_eq!(review.rejected_exhausted, expected == 3);
            assert_eq!(review.automatic_review_stopped, expected == 3);
            assert!(!review.review_unavailable);
        }

        let persisted = store
            .read_critic_review_state(&created.work.work_id)
            .unwrap()
            .unwrap();
        assert!(persisted.rejected_exhausted);
        assert!(persisted.automatic_review_stopped);
        assert!(!persisted.review_unavailable);
    }

    #[test]
    fn human_decision_is_idempotent_and_old_revision_is_stale() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let created = store
            .create_work("decision", &plan("人工决策"), "session-a", true)
            .unwrap();
        let record = HumanDecisionRecord {
            decision_id: "decision-1".to_string(),
            work_id: created.work.work_id.clone(),
            plan_revision: created.work.revision,
            task_id: Some("1".to_string()),
            question_id: "question-1".to_string(),
            option_id: Some("approve".to_string()),
            answer_summary: "approved".to_string(),
            actor: DecisionActor::User,
            recorded_at: Utc::now(),
            supersedes: None,
            stale: false,
        };
        let saved = store
            .append_human_decision(&created.work.work_id, record.clone())
            .unwrap();
        let duplicate = store
            .append_human_decision(&created.work.work_id, record)
            .unwrap();
        assert_eq!(saved.decision_id, duplicate.decision_id);
        assert_eq!(
            store
                .read_human_decisions(&created.work.work_id)
                .unwrap()
                .len(),
            1
        );

        store
            .edit_plan(
                &created.work.work_id,
                created.work.revision,
                "人工决策",
                "人工决策更新",
                false,
            )
            .unwrap();
        let stale = store
            .append_human_decision(
                &created.work.work_id,
                HumanDecisionRecord {
                    decision_id: "decision-stale".to_string(),
                    plan_revision: created.work.revision,
                    question_id: "question-stale".to_string(),
                    ..saved
                },
            )
            .unwrap();
        assert!(stale.stale);
    }

    #[test]
    fn human_decision_rejects_non_user_actor_is_guaranteed_by_closed_enum() {
        assert!(
            serde_json::from_value::<HumanDecisionRecord>(serde_json::json!({
                "decision_id": "forged",
                "work_id": "work",
                "plan_revision": 1,
                "question_id": "question",
                "answer_summary": "answer",
                "actor": "model",
                "recorded_at": Utc::now(),
                "stale": false
            }))
            .is_err()
        );
    }
}
