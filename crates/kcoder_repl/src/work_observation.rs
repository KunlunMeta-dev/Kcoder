//! Read-only observation of target-side continuous work for the terminal UI.
//!
//! The REPL never owns this storage. It opens an existing namespace, reads the
//! record bound to this workspace and session, and never claims, controls,
//! admits, queues, dispatches or settles anything. Every value here is a
//! point-in-time observation; a stored phase is not proof that business work
//! finished or that its required deliveries happened.
//!
//! The target opening and work selection below are also used by
//! [`crate::work_control`], which submits a durable control request for the same
//! binding. Sharing them keeps one scope construction and one selection rule.

use crate::tool_format::sanitize_tui_text;
use kcoder_engine::QueryEngine;
use kcoder_state::continuous_work::{ContinuousWorkStore, HostWorkScope};
use kcoder_types::continuous_work::{WorkRecord, WorkScope, WorkUsage};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[cfg(test)]
#[path = "work_observation.test.rs"]
mod tests;

/// Minimum interval between status-line reads of the target store. Bounds the
/// cost of back-to-back tool-result metadata refreshes; `/work observation`
/// always reads the current store instead.
const REFRESH_INTERVAL: Duration = Duration::from_secs(2);

/// Upper bound on how many session-bound records one observation reads. A
/// session normally binds one work; the cap keeps an unexpected binding count
/// from multiplying whole-store reads.
const MAX_OBSERVED_WORKS: usize = 4;

/// Longest wait reference copied into a one-line observation.
const MAX_WAIT_REFERENCE_CHARS: usize = 96;

/// Longest session identity accepted as a work binding key.
const MAX_SESSION_ID_BYTES: usize = 256;

const OBSERVATION_HEADER: &str =
    "Continuous work observation (read-only; a stored record is not proof of completion)";

/// Plain owned projection of one stored work record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorkObservation {
    pub(crate) work_id: String,
    /// Stored phase label (`running`, `waiting_user`, ...); never inferred.
    pub(crate) phase: String,
    pub(crate) revision: u64,
    pub(crate) requirements_revision: u64,
    /// Waiting condition rendered as `kind (reference)`.
    pub(crate) wait: Option<String>,
    /// Accepted but not yet applied inputs at the observed revision.
    pub(crate) unconsumed_inputs: Option<u64>,
    /// Durable batch counters of the observed revision.
    pub(crate) usage: Option<WorkUsage>,
}

impl WorkObservation {
    fn from_record(record: &WorkRecord) -> Self {
        let revision = &record.revision;
        Self {
            work_id: record.identity.work_id.clone(),
            phase: record.phase.as_str().to_string(),
            revision: revision.revision,
            requirements_revision: revision.requirements_revision,
            wait: record.waiting.as_ref().map(|wait| {
                let reference = sanitize_tui_text(&wait.reference);
                format!(
                    "{} ({})",
                    wait.kind.as_str(),
                    capped(&reference, MAX_WAIT_REFERENCE_CHARS)
                )
            }),
            unconsumed_inputs: Some(
                revision
                    .accepted_input_sequence
                    .saturating_sub(revision.applied_input_sequence),
            ),
            usage: Some(revision.usage),
        }
    }

    /// One short ASCII status segment for the compact status line.
    ///
    /// The segment repeats the stored phase only; an observation never upgrades
    /// a phase into a completion or delivery claim.
    pub(crate) fn status_segment(&self) -> String {
        let mut segment = format!("work:{}", phase_segment_label(&self.phase));
        if let Some(pending) = self.unconsumed_inputs.filter(|count| *count > 0) {
            segment.push_str(&format!(" +{pending}"));
        }
        segment
    }

    /// Verbatim observation report for `/work observation`.
    fn detail(&self) -> String {
        let wait = self.wait.as_deref().unwrap_or("none");
        let unconsumed = self
            .unconsumed_inputs
            .map(|count| count.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let counters = match self.usage {
            Some(usage) => format!(
                "automatic turns {} · consecutive failures {} · stalled rounds {}",
                usage.automatic_turns, usage.consecutive_failures, usage.stalled_rounds
            ),
            None => "unknown".to_string(),
        };
        format!(
            "{OBSERVATION_HEADER}\nwork: {}\nphase: {}\nrevision: {}\nrequirements revision: {}\nwait: {wait}\nunconsumed inputs: {unconsumed}\ncounters: {counters}",
            self.work_id, self.phase, self.revision, self.requirements_revision,
        )
    }
}

/// Outcome of one bounded read. Absence and unreadability are different facts
/// and must not collapse into a fabricated phase.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) enum WorkObservationStatus {
    /// No existing store, or nothing bound to this workspace and session. The
    /// status line shows no segment at all.
    #[default]
    Absent,
    /// Storage exists but this REPL could not observe it (unreadable state,
    /// unavailable or changed scope). The status line shows `work:unknown`.
    Unavailable,
    Observed(WorkObservation),
}

impl WorkObservationStatus {
    /// Status-line segment, or `None` when no work exists for this workspace
    /// and session.
    pub(crate) fn status_segment(&self) -> Option<String> {
        match self {
            Self::Absent => None,
            Self::Unavailable => Some("work:unknown".to_string()),
            Self::Observed(observation) => Some(observation.status_segment()),
        }
    }

    /// Verbatim observation report for `/work observation`.
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::Absent => format!(
                "{OBSERVATION_HEADER}\nNo continuous work storage exists for this profile, or no work is bound to this workspace and session.\nNothing was created, repaired or changed."
            ),
            Self::Unavailable => format!(
                "{OBSERVATION_HEADER}\nWork storage exists but could not be observed: the stored state is unreadable, or the profile/workspace scope could not be verified. The phase is unknown."
            ),
            Self::Observed(observation) => observation.detail(),
        }
    }
}

/// Cached status-line observation. Store reads happen only from engine metadata
/// refreshes or an explicit `/work observation`; drawing never touches storage.
#[derive(Debug, Default)]
pub(crate) struct WorkObservationTracker {
    status: WorkObservationStatus,
    last_read: Option<Instant>,
}

impl WorkObservationTracker {
    /// Refresh from a metadata boundary, at most once per [`REFRESH_INTERVAL`].
    pub(crate) fn refresh(&mut self, engine: &QueryEngine) {
        let now = Instant::now();
        if self
            .last_read
            .is_some_and(|last| now.saturating_duration_since(last) < REFRESH_INTERVAL)
        {
            return;
        }
        self.last_read = Some(now);
        self.status = observe(engine);
    }

    /// Read the current store immediately; used by `/work observation` so the
    /// command never reports a throttled status-line snapshot.
    pub(crate) fn observe_now(&mut self, engine: &QueryEngine) {
        self.last_read = Some(Instant::now());
        self.status = observe(engine);
    }

    pub(crate) fn status(&self) -> &WorkObservationStatus {
        &self.status
    }

    pub(crate) fn status_segment(&self) -> Option<String> {
        self.status.status_segment()
    }
}

/// Outcome of opening the target store belonging to this engine's profile and
/// workspace. Absence and unreadability are different facts.
pub(crate) enum WorkTarget {
    /// No persistent profile or no existing work namespace. Nothing is created.
    Absent,
    /// A namespace exists but this REPL could not resolve or verify it.
    Unavailable,
    Ready(Box<ReadyWorkTarget>),
}

/// The record of this store that is bound to this workspace and session.
pub(crate) enum BoundWork {
    /// No record is bound to this workspace and session.
    Absent,
    /// At least one bound record could not be read and none was usable.
    Unavailable,
    Record(Box<WorkRecord>),
}

/// One opened store plus the host-resolved identities it was opened under.
/// Holding this is not authority: the store's own checks still decide whether a
/// read or write is attributed to this workspace and session.
pub(crate) struct ReadyWorkTarget {
    pub(crate) store: ContinuousWorkStore,
    host: HostWorkScope,
    settings: PathBuf,
    workspace: PathBuf,
}

impl ReadyWorkTarget {
    pub(crate) fn scope(&self) -> &WorkScope {
        self.host.scope()
    }

    /// Select the record bound to this workspace and session through
    /// host-resolved identities only, never through a stored scope string.
    pub(crate) fn bound_work(&self, session_id: &str) -> BoundWork {
        if !usable_session_id(session_id) {
            // Without a usable session identity no record is bound to this UI.
            return BoundWork::Absent;
        }
        let identities = match self.store.list_for_thread(self.scope(), session_id) {
            Ok(identities) => identities,
            Err(_) => return BoundWork::Unavailable,
        };
        let mut best: Option<(u64, WorkRecord)> = None;
        let mut failures = 0usize;
        for identity in identities.iter().take(MAX_OBSERVED_WORKS) {
            match self.store.read_work(self.scope(), &identity.work_id) {
                Ok(Some(record)) => {
                    // Only an explicit binding is considered; a missing timestamp
                    // is unknown, not the Unix epoch.
                    let updated_at = record
                        .presentation
                        .as_ref()
                        .and_then(|presentation| presentation.updated_at_ms)
                        .unwrap_or(0);
                    if best
                        .as_ref()
                        .is_none_or(|(current, _)| updated_at > *current)
                    {
                        best = Some((updated_at, record));
                    }
                }
                Ok(None) => {}
                Err(_) => failures += 1,
            }
        }
        match best {
            Some((_, record)) => BoundWork::Record(Box::new(record)),
            None if failures > 0 => BoundWork::Unavailable,
            None => BoundWork::Absent,
        }
    }

    /// Recheck the held scope objects and their current names after filesystem
    /// I/O, as the app-server read and write paths do; a changed scope cannot be
    /// reported as current.
    pub(crate) fn verify(&self, engine: &QueryEngine) -> bool {
        self.host.verify().is_ok()
            && engine.state.cwd() == self.workspace
            && engine.settings_persistence_path().as_deref() == Some(self.settings.as_path())
    }
}

/// Open the target store for this engine without creating anything: the store
/// is only ever opened with `open_existing`, so a namespace that does not exist
/// stays that way.
pub(crate) fn open_target(engine: &QueryEngine) -> WorkTarget {
    let workspace = engine.state.cwd();
    let Some(settings) = engine.settings_persistence_path() else {
        // Persistence is disabled for this engine, so there is no target store.
        return WorkTarget::Absent;
    };
    let Some(profile) = settings.parent() else {
        return WorkTarget::Absent;
    };
    if !profile.is_dir() {
        // Durable work lives inside an existing profile; never create one here.
        return WorkTarget::Absent;
    }
    let store = match ContinuousWorkStore::open_existing(profile) {
        Ok(Some(store)) => store,
        // The ordinary state for a profile that never ran durable work.
        Ok(None) => return WorkTarget::Absent,
        Err(_) => return WorkTarget::Unavailable,
    };
    // Records may only be attributed through host-resolved account, target and
    // workspace identities, never through a stored scope string.
    let Ok(host) = HostWorkScope::capture(profile, &workspace, None) else {
        return WorkTarget::Unavailable;
    };
    WorkTarget::Ready(Box::new(ReadyWorkTarget {
        store,
        host,
        settings,
        workspace,
    }))
}

/// One bounded, read-only observation of the bound work.
pub(crate) fn observe(engine: &QueryEngine) -> WorkObservationStatus {
    let target = match open_target(engine) {
        WorkTarget::Absent => return WorkObservationStatus::Absent,
        WorkTarget::Unavailable => return WorkObservationStatus::Unavailable,
        WorkTarget::Ready(target) => target,
    };
    let observed = match target.bound_work(&engine.session_id()) {
        BoundWork::Absent => WorkObservationStatus::Absent,
        BoundWork::Unavailable => WorkObservationStatus::Unavailable,
        BoundWork::Record(record) => {
            WorkObservationStatus::Observed(WorkObservation::from_record(record.as_ref()))
        }
    };
    if !target.verify(engine) {
        return WorkObservationStatus::Unavailable;
    }
    observed
}

fn usable_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id.len() <= MAX_SESSION_ID_BYTES
        && session_id.trim() == session_id
        && !session_id.chars().any(char::is_control)
}

/// Short ASCII label for a stored phase. Unknown future phases stay unknown
/// instead of being guessed from the surrounding record.
fn phase_segment_label(phase: &str) -> &'static str {
    match phase {
        "pending" => "pending",
        "running" => "running",
        "waiting_user" => "waiting-user",
        "waiting_event" => "waiting-event",
        "paused" => "paused",
        "completed" => "completed",
        "failed" => "failed",
        "stopped" => "stopped",
        "needs_reconciliation" => "needs-reconciliation",
        _ => "unknown",
    }
}

fn capped(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut capped = text
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    capped.push('…');
    capped
}
