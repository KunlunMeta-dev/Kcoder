//! Self-evolution integration of the Engine (plan phases 1 and 3).
//!
//! One [`EvolutionRuntime`] is owned per engine (one thread). It
//!
//! - records skill usages at activation and serves overlays into the
//!   activation result ([`recording`]);
//! - turns the settled transcript into procedure, artifact and task-terminal
//!   observations and tracks observation windows ([`turns`],
//!   [`artifacts`]);
//! - classifies the user's next message in batches with the classifier stage
//!   model ([`classify`]);
//! - distills evidence into proposals in a restricted fork ([`distill`]);
//! - implements the management service hooks for accepting proposals and
//!   cancelling jobs ([`hooks`]).
//! - evaluates proposals offline ([`eval`], [`eval_cases`]), runs canaries
//!   and promotes or rolls them back ([`canary`], including skill-file
//!   targets in [`skill_file`]) and maintains storage ([`maintenance`]);
//! - records `tool_usage` targets and serves their hints inside tool
//!   results ([`target_tool`]), and records `workflow_template` runs and
//!   applies their guidance to newly started runs ([`target_workflow`]).
//!
//! Model work runs only from the idle poll
//! ([`crate::QueryEngine::poll_idle_maintenance`]), under a per-(job,
//! target) lease, with `RequestClass::Evolution`. All storage lives under the
//! user data root, never inside the project.

mod artifacts;
mod canary;
mod classify;
mod consolidate;
mod distill;
mod engine;
mod eval;
mod eval_cases;
mod hooks;
mod maintenance;
mod model;
mod recording;
mod review;
mod skill_file;
mod target_tool;
mod target_workflow;
mod turns;

#[cfg(test)]
mod tests;

pub use canary::{EvolutionChangeEvent, EvolutionChangeSink};
pub use engine::{DistillRequestOutcome, record_overlay_user_edit};
pub use hooks::{EngineEvolutionHooks, cancel_evolution_jobs, running_evolution_jobs};
pub use maintenance::EvolutionTurnFileSink;
pub use model::EvolutionModelUnavailable;
pub use recording::latest_rating_turn_id;
pub(crate) use review::{review_registry, review_tool_names};

use kcoder_config::EvolutionSettings;
use kcoder_evolution::{EvolutionError, EvolutionScope, EvolutionStore, resolve_scope_root};
use kcoder_types::evolution::{EvolutionDisabledReason, EvolutionJobKind, TargetKey};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

/// Observation window closes after this much session inactivity.
pub(crate) const WINDOW_IDLE: Duration = Duration::from_secs(30 * 60);
/// Artifacts are observed for at most this long after their usage.
pub(crate) const ARTIFACT_OBSERVATION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Minimum spacing of idle-time artifact scans.
pub(crate) const ARTIFACT_SCAN_INTERVAL: Duration = Duration::from_secs(10 * 60);

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn short_hash(parts: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hasher.finalize()[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Redact likely credentials and bound the text for an evidence snippet.
pub(crate) fn redacted_snippet(text: &str, max_bytes: usize) -> String {
    let (redacted, _) = kcoder_tools::session_read::redact_secrets(text);
    kcoder_evolution::truncate_snippet(
        &redacted,
        max_bytes.min(kcoder_evolution::EVIDENCE_SNIPPET_MAX_BYTES),
    )
    .to_string()
}

/// Which storage partition a target belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ScopeKind {
    User,
    Project,
}

/// One usage whose observation window is open in this thread.
#[derive(Debug, Clone)]
pub(crate) struct OpenUsage {
    pub(crate) usage_id: String,
    pub(crate) target_key: TargetKey,
    pub(crate) scope: ScopeKind,
    pub(crate) skill_name: String,
    /// Real user messages before and including the activating turn.
    pub(crate) turn_index: usize,
    /// Transcript length when the usage was recorded.
    pub(crate) message_index: usize,
    /// Served overlay text, kept for conflict attribution.
    pub(crate) overlay_text: Option<String>,
    pub(crate) settled: bool,
    pub(crate) classified: bool,
    pub(crate) regenerated: bool,
    pub(crate) last_activity: Instant,
}

/// A queued conversation classification (plan section 7.3).
#[derive(Debug, Clone)]
pub(crate) struct PendingClassification {
    pub(crate) usage_id: String,
    pub(crate) scope: ScopeKind,
    pub(crate) user_text: String,
    pub(crate) previous_answer: String,
    pub(crate) overlay_text: Option<String>,
    pub(crate) concurrent: usize,
}

/// The job this runtime currently runs.
#[derive(Debug, Clone)]
pub(crate) struct RunningJob {
    pub(crate) token: CancellationToken,
    pub(crate) target: Option<TargetKey>,
}

#[derive(Debug, Default)]
pub(crate) struct RuntimeState {
    pub(crate) job: Option<RunningJob>,
    pub(crate) open: Vec<OpenUsage>,
    pub(crate) pending: Vec<PendingClassification>,
    pub(crate) artifacts: artifacts::ArtifactTracker,
    pub(crate) last_artifact_scan: Option<Instant>,
    pub(crate) last_consolidation: Option<Instant>,
    pub(crate) paused: Option<EvolutionDisabledReason>,
    pub(crate) diagnostics: BTreeSet<String>,
    /// Per-turn `tool_usage` aggregation ([`target_tool`]).
    pub(crate) tools: target_tool::ToolUsageTracker,
    /// `workflow_template` runs awaiting a terminal state ([`target_workflow`]).
    pub(crate) runs: target_workflow::RunTracker,
}

/// Per-engine self-evolution state.
pub(crate) struct EvolutionRuntime {
    data_root: RwLock<Option<PathBuf>>,
    stores: Mutex<HashMap<PathBuf, Arc<EvolutionStore>>>,
    pub(crate) state: Mutex<RuntimeState>,
    pub(crate) manual_distill: Mutex<BTreeSet<TargetKey>>,
    pub(crate) job_running: Arc<AtomicBool>,
    pub(crate) review_store:
        RwLock<Option<Arc<kcoder_memory::integrations::knowledge::MemoryReviewStore>>>,
    /// Rollout automation, change sink and maintenance schedule (phase 4).
    pub(crate) automation: canary::AutomationState,
}

impl std::fmt::Debug for EvolutionRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EvolutionRuntime")
            .finish_non_exhaustive()
    }
}

impl Default for EvolutionRuntime {
    fn default() -> Self {
        Self {
            data_root: RwLock::new(None),
            stores: Mutex::new(HashMap::new()),
            state: Mutex::new(RuntimeState::default()),
            manual_distill: Mutex::new(BTreeSet::new()),
            job_running: Arc::new(AtomicBool::new(false)),
            review_store: RwLock::new(None),
            automation: canary::AutomationState::default(),
        }
    }
}

impl EvolutionRuntime {
    pub(crate) fn lock_state(&self) -> std::sync::MutexGuard<'_, RuntimeState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Consolidation proposals are checked at most once per scan interval.
    pub(crate) fn consolidation_due(&self) -> bool {
        let mut state = self.lock_state();
        let due = state
            .last_consolidation
            .is_none_or(|last| last.elapsed() >= ARTIFACT_SCAN_INTERVAL);
        if due {
            state.last_consolidation = Some(Instant::now());
        }
        due
    }

    pub(crate) fn set_data_root(&self, root: PathBuf) {
        *self
            .data_root
            .write()
            .unwrap_or_else(|error| error.into_inner()) = Some(root);
        self.stores
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    /// The root a host set with `set_data_root`, if any.
    pub(crate) fn explicit_data_root(&self) -> Option<PathBuf> {
        self.data_root
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub(crate) fn data_root(&self) -> Option<PathBuf> {
        if let Some(root) = self
            .data_root
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return Some(root);
        }
        kcoder_evolution::default_data_root().ok()
    }

    pub(crate) fn note_diagnostic(&self, message: impl Into<String>) {
        let message = message.into();
        let mut state = self.lock_state();
        if state.diagnostics.len() < 32 && state.diagnostics.insert(message.clone()) {
            tracing::warn!(diagnostic = %message, "self-evolution diagnostic");
        }
    }

    /// Scope root of a partition; project scope is skipped (with a
    /// diagnostic) when the data root lies inside the project.
    pub(crate) fn scope_root(&self, scope: ScopeKind, cwd: &Path) -> Option<PathBuf> {
        let data_root = self.data_root()?;
        let scope = match scope {
            ScopeKind::User => EvolutionScope::User,
            ScopeKind::Project => EvolutionScope::Project {
                cwd: cwd.to_path_buf(),
            },
        };
        match resolve_scope_root(&data_root, &scope) {
            Ok(root) => Some(root),
            Err(EvolutionError::ScopeInsideProject(_)) => {
                self.note_diagnostic(
                    "project scope skipped: the data root is inside the project (data_root_inside_project)",
                );
                None
            }
            Err(error) => {
                self.note_diagnostic(format!("scope unavailable: {error}"));
                None
            }
        }
    }

    /// Open (lazily, once) the store of a partition.
    pub(crate) fn store(&self, scope: ScopeKind, cwd: &Path) -> Option<Arc<EvolutionStore>> {
        let root = self.scope_root(scope, cwd)?;
        let mut stores = self
            .stores
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(store) = stores.get(&root) {
            return Some(Arc::clone(store));
        }
        match EvolutionStore::open(&root) {
            Ok(store) => {
                let store = Arc::new(store.with_lock_wait(Duration::from_secs(2)));
                stores.insert(root, Arc::clone(&store));
                Some(store)
            }
            Err(error) => {
                drop(stores);
                self.note_diagnostic(format!("evolution store unavailable: {error}"));
                None
            }
        }
    }

    /// Scope of a target key: project skills and project knowledge use the
    /// project partition, everything else the user partition.
    pub(crate) fn scope_of(key: &TargetKey, project_skill: bool) -> ScopeKind {
        use kcoder_types::evolution::TargetType;
        match key.target_type() {
            TargetType::ProjectKnowledge => ScopeKind::Project,
            TargetType::Skill if project_skill => ScopeKind::Project,
            _ => ScopeKind::User,
        }
    }
}

/// Whether evolution collects for this engine at all (master switch,
/// training mode, workflow drafts and internal forks).
pub(crate) fn collection_allowed(
    settings: &kcoder_config::Settings,
    workflow_draft: bool,
    foreground: bool,
) -> bool {
    settings.evolution.enabled && !settings.training_mode && !workflow_draft && foreground
}

pub(crate) fn target_active(settings: &EvolutionSettings, key: &TargetKey) -> bool {
    settings.target_enabled(key)
}

// ---- process-wide job registry --------------------------------------------

pub(crate) struct JobEntry {
    pub(crate) kind: EvolutionJobKind,
    pub(crate) target: Option<TargetKey>,
    pub(crate) scope_root: PathBuf,
    pub(crate) token: CancellationToken,
}

pub(crate) static JOBS: LazyLock<Mutex<HashMap<u64, JobEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

/// Registration of one running job; unregisters on drop, including abort.
pub(crate) struct JobRegistration {
    id: u64,
}

impl JobRegistration {
    pub(crate) fn register(
        kind: EvolutionJobKind,
        target: Option<TargetKey>,
        scope_root: PathBuf,
    ) -> (Self, CancellationToken) {
        let id = NEXT_JOB.fetch_add(1, Ordering::SeqCst);
        let token = CancellationToken::new();
        JOBS.lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                id,
                JobEntry {
                    kind,
                    target,
                    scope_root,
                    token: token.clone(),
                },
            );
        (Self { id }, token)
    }
}

impl Drop for JobRegistration {
    fn drop(&mut self) {
        JOBS.lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.id);
    }
}

/// Cancel registered jobs matching `predicate`; returns their ids.
pub(crate) fn cancel_matching(predicate: impl Fn(&JobEntry) -> bool) -> Vec<u64> {
    let jobs = JOBS.lock().unwrap_or_else(|error| error.into_inner());
    jobs.iter()
        .filter(|(_, entry)| predicate(entry))
        .map(|(id, entry)| {
            entry.token.cancel();
            *id
        })
        .collect()
}

/// Wait (bounded) until none of `ids` is registered anymore.
pub(crate) fn wait_for_jobs(ids: &[u64], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = {
            let jobs = JOBS.lock().unwrap_or_else(|error| error.into_inner());
            ids.iter().any(|id| jobs.contains_key(id))
        };
        if !remaining {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
