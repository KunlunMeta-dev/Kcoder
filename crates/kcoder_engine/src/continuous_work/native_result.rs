//! Read-only native background and workflow observations.
//!
//! A run reference is a locator, not a grant or proof that the run belongs to
//! a business work item. Existing background records do not pin the parent
//! turn attempt or a per-run task kind. In particular, an observation from
//! this module cannot authorize dispatch, consume input, or complete work.
//!
//! A history receipt is only the message identity recorded by State. It can
//! refer to a small completion notification or a tool result; it does not
//! establish that the message is still present, that its body is complete, or
//! that a model consumed it. The native history owner must inspect the actual
//! committed message before acknowledging result consumption.
//!
//! Generic output paths are task-scoped and may be overwritten by a later run.
//! The saved output snapshot is bounded without a completeness receipt, and
//! the outbox does not retain structured process exit metadata. This module
//! therefore never treats either as a verified result body. Missing or changed
//! original output remains unknown; it does not permit replay of the action.
//!
//! Workflow worker termination is separate from graph-run status. `observe_workflow`
//! reads the original run observation without repairing it, pins its saved
//! definition/version, resume count, revision and actual workspace identity,
//! and returns no output. Some pinned-definition runs also publish a separate
//! per-attempt verification body and digest; only a native owner that reads and
//! checks that original receipt can use it. Script/legacy runs and missing or
//! mismatched receipts remain unknown, not an implied successful delivery.
//! No background-result continuation has been wired by this observation layer.

pub mod extraction;

use kcoder_state::{AppState, TaskKind, TaskStatus};
use kcoder_types::continuous_work::{
    ResultBasis, WorkBackgroundKind, WorkKnownReference, WorkNativeReference, WorkPhase, WorkRecord,
};
use kcoder_types::{
    BackgroundEventIdentity, BackgroundRunKey, TurnAttemptIdentity,
    domain_status::WorkflowRunStatus,
};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeObservationError {
    InvalidReference,
    WrongParent,
    SessionChanged,
    /// No matching run was visible in this State, not proof it never executed.
    RunNotObserved,
    /// The expected outbox receipt was absent, not proof the effect did not run.
    TerminalNotObserved,
    TerminalMismatch,
    WorkflowUnavailable,
    WorkflowReferenceMismatch,
    WorkspaceUnavailable,
    WorkspaceMismatch,
}

/// A supplied original attempt is still only a locator until the host verifies
/// the immutable admission binding. Old runs without one remain unbound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParentAttemptObservation {
    Missing,
    Unverified(TurnAttemptIdentity),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeTerminalOutcome {
    Completed,
    Failed,
    Cancelled,
    Halted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeRunState {
    /// Persisted labels do not prove that the original worker remains alive.
    RecordedPending,
    RecordedRunning,
    RecordedPaused,
    RecordedTerminal {
        event: BackgroundEventIdentity,
        outcome: NativeTerminalOutcome,
    },
    /// A legacy, imported, incomplete or contradictory record is not a
    /// terminal result that may be automatically consumed.
    Unknown(NativeUnknownReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeUnknownReason {
    ImportedHistory,
    LegacyUncertain,
    UnmanagedTask,
    TerminalReceiptMissing,
    InconsistentTerminal,
    InconsistentCurrentStatus,
    FutureStatus(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeDeliveryObservation {
    /// A missing receipt does not establish that delivery never occurred.
    NoReceiptObserved,
    /// A pending result receipt must be reconciled against original history.
    PendingReconciliation,
    /// A history receipt was committed at delivery time. Current history may
    /// later be changed and must be checked before reading the result.
    HistoryReceipt {
        message_id: String,
    },
    Suppressed,
    Unknown,
}

/// This observer deliberately does not open the output path or consume the
/// bounded snapshot; the native result owner must verify the content separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeOutputObservation {
    NotRead,
}

/// Facts from one copied State task snapshot. `current_run` means the saved
/// current run key matches, not that its worker has been proven alive.
/// `recorded_current_task_kind` is a mutable task observation rather than a
/// per-run receipt; old records do not freeze their category.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeRunObservation {
    pub run: BackgroundRunKey,
    pub parent_attempt: ParentAttemptObservation,
    pub current_run: bool,
    pub recorded_current_task_kind: Option<TaskKind>,
    pub state: NativeRunState,
    pub delivery: NativeDeliveryObservation,
    pub output: NativeOutputObservation,
}

fn atom(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

/// Observe one exact native run without reading output files, changing its
/// delivery, or using the current task as a substitute for an old run.
///
/// `attempt` must come from a separately persisted host binding. Even when its
/// shape and thread match, this API deliberately returns it as unverified:
/// State's background outbox does not itself persist that association. The host
/// must verify its actual profile, work binding and authority separately.
pub fn observe_run(
    state: &AppState,
    run: &BackgroundRunKey,
    attempt: Option<&TurnAttemptIdentity>,
    expected_terminal: Option<&BackgroundEventIdentity>,
) -> Result<NativeRunObservation, NativeObservationError> {
    if !atom(&run.parent_session_id) || !atom(&run.agent_id) || !atom(&run.run_id) {
        return Err(NativeObservationError::InvalidReference);
    }
    let parent_attempt = match attempt {
        None => ParentAttemptObservation::Missing,
        Some(attempt) => {
            attempt
                .validate()
                .map_err(|_| NativeObservationError::InvalidReference)?;
            if attempt.thread_id != run.parent_session_id {
                return Err(NativeObservationError::WrongParent);
            }
            ParentAttemptObservation::Unverified(attempt.clone())
        }
    };
    if expected_terminal.is_some_and(|event| event.run != *run) {
        return Err(NativeObservationError::TerminalMismatch);
    }
    let owner = state.inspection_lifecycle_identity();
    if state.session_id() != run.parent_session_id {
        return Err(NativeObservationError::WrongParent);
    }
    // Task and all its per-run outbox entries are cloned in one State read.
    let task = state
        .task(&run.agent_id)
        .ok_or(NativeObservationError::RunNotObserved)?;
    let mut matching = task
        .background_runs
        .iter()
        .filter(|record| record.key == *run);
    let record = matching
        .next()
        .ok_or(NativeObservationError::RunNotObserved)?;
    if matching.next().is_some() {
        return Err(NativeObservationError::InvalidReference);
    }
    if task.id != run.agent_id
        || task
            .parent_session_id
            .as_deref()
            .is_some_and(|parent| parent != run.parent_session_id)
    {
        return Err(NativeObservationError::WrongParent);
    }
    if let Some(expected) = expected_terminal {
        match record.terminal.as_ref() {
            None => return Err(NativeObservationError::TerminalNotObserved),
            Some(actual) if actual != expected => {
                return Err(NativeObservationError::TerminalMismatch);
            }
            Some(_) => {}
        }
    }
    let current_run = task.background_run.as_ref() == Some(run);
    let recorded_current_task_kind = (current_run && task.managed).then_some(task.kind);
    let run_state = if !task.managed {
        NativeRunState::Unknown(NativeUnknownReason::UnmanagedTask)
    } else if record.imported_history {
        NativeRunState::Unknown(NativeUnknownReason::ImportedHistory)
    } else if record.legacy_uncertain {
        NativeRunState::Unknown(NativeUnknownReason::LegacyUncertain)
    } else if let Some(event) = &record.terminal {
        if event.run != *run || !atom(&event.event_id) {
            NativeRunState::Unknown(NativeUnknownReason::InconsistentTerminal)
        } else if let TaskStatus::Unknown(raw) = &record.status {
            NativeRunState::Unknown(NativeUnknownReason::FutureStatus(raw.clone()))
        } else {
            let outcome = match &record.status {
                TaskStatus::Completed => Some(NativeTerminalOutcome::Completed),
                TaskStatus::Failed => Some(NativeTerminalOutcome::Failed),
                TaskStatus::Cancelled => Some(NativeTerminalOutcome::Cancelled),
                TaskStatus::Halted => Some(NativeTerminalOutcome::Halted),
                _ => None,
            };
            match outcome {
                Some(outcome) => NativeRunState::RecordedTerminal {
                    event: event.clone(),
                    outcome,
                },
                None => NativeRunState::Unknown(NativeUnknownReason::InconsistentTerminal),
            }
        }
    } else if !current_run {
        NativeRunState::Unknown(NativeUnknownReason::TerminalReceiptMissing)
    } else {
        match (&record.status, &task.status) {
            (TaskStatus::Pending, TaskStatus::Pending) => NativeRunState::RecordedPending,
            (TaskStatus::Running, TaskStatus::Running) => NativeRunState::RecordedRunning,
            (TaskStatus::Running | TaskStatus::Paused, TaskStatus::Paused) => {
                NativeRunState::RecordedPaused
            }
            (TaskStatus::Unknown(raw), _) | (_, TaskStatus::Unknown(raw)) => {
                NativeRunState::Unknown(NativeUnknownReason::FutureStatus(raw.clone()))
            }
            (
                _,
                TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Halted,
            ) => NativeRunState::Unknown(NativeUnknownReason::TerminalReceiptMissing),
            _ => NativeRunState::Unknown(NativeUnknownReason::InconsistentCurrentStatus),
        }
    };
    let delivery = if !task.managed
        || record.imported_history
        || record.legacy_uncertain
        || (record.delivered_message_id.is_some() || record.pending_result_message_id.is_some())
            && !matches!(&run_state, NativeRunState::RecordedTerminal { .. })
    {
        NativeDeliveryObservation::Unknown
    } else if record.suppressed {
        NativeDeliveryObservation::Suppressed
    } else if record.pending_result_message_id.is_some() {
        NativeDeliveryObservation::PendingReconciliation
    } else if let Some(message_id) = &record.delivered_message_id {
        if atom(message_id) {
            NativeDeliveryObservation::HistoryReceipt {
                message_id: message_id.clone(),
            }
        } else {
            NativeDeliveryObservation::Unknown
        }
    } else {
        NativeDeliveryObservation::NoReceiptObserved
    };
    if !owner.matches(state) {
        return Err(NativeObservationError::SessionChanged);
    }
    Ok(NativeRunObservation {
        run: run.clone(),
        parent_attempt,
        current_run,
        recorded_current_task_kind,
        state: run_state,
        delivery,
        output: NativeOutputObservation::NotRead,
    })
}

/// A fixed workflow observation selected from an original host-owned binding.
/// The same workflow run ID can have multiple resumes; all fields must match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedWorkflowReference {
    pub thread_id: String,
    pub run_id: String,
    pub definition_id: Option<String>,
    pub version: Option<u64>,
    pub resume_count: u32,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeWorkflowObservation {
    pub reference: PinnedWorkflowReference,
    pub status: WorkflowRunStatus,
}

/// Read the existing workflow observation without reconciling or restarting it.
/// The caller must supply the actual profile-owned root and separately verify
/// the saved workflow-to-business-work association and any source authority.
pub fn observe_workflow(
    root: &Path,
    workspace: &Path,
    reference: &PinnedWorkflowReference,
) -> Result<NativeWorkflowObservation, NativeObservationError> {
    if !root.is_absolute()
        || !workspace.is_absolute()
        || !atom(&reference.thread_id)
        || !atom(&reference.run_id)
        || reference.revision == 0
        || reference.definition_id.as_ref().is_some_and(|id| !atom(id))
        || reference.definition_id.is_some() != reference.version.is_some()
        || reference.version == Some(0)
    {
        return Err(NativeObservationError::InvalidReference);
    }
    let expected_workspace = kcoder_config::PrivateDirectory::open_existing(workspace)
        .map_err(|_| NativeObservationError::WorkspaceUnavailable)?;
    let expected_identity = expected_workspace
        .directory_identity()
        .map_err(|_| NativeObservationError::WorkspaceUnavailable)?;
    let snapshot = kcoder_tools::workflow_runs::observe_read(root.to_path_buf(), &reference.run_id)
        .map_err(|_| NativeObservationError::WorkflowUnavailable)?;
    if snapshot.thread_id != reference.thread_id
        || snapshot.run_id != reference.run_id
        || snapshot.definition_id != reference.definition_id
        || snapshot.version != reference.version
        || snapshot.resume_count != reference.resume_count
        || snapshot.revision != reference.revision
    {
        return Err(NativeObservationError::WorkflowReferenceMismatch);
    }
    if !Path::new(&snapshot.workspace).is_absolute() {
        return Err(NativeObservationError::WorkspaceUnavailable);
    }
    let observed_workspace =
        kcoder_config::PrivateDirectory::open_existing(Path::new(&snapshot.workspace))
            .map_err(|_| NativeObservationError::WorkspaceUnavailable)?;
    if observed_workspace
        .directory_identity()
        .map_err(|_| NativeObservationError::WorkspaceUnavailable)?
        != expected_identity
    {
        return Err(NativeObservationError::WorkspaceMismatch);
    }
    // Reopen the caller's path to detect replacement during observation.
    if kcoder_config::PrivateDirectory::open_existing(workspace)
        .and_then(|directory| directory.directory_identity())
        .map_err(|_| NativeObservationError::WorkspaceUnavailable)?
        != expected_identity
    {
        return Err(NativeObservationError::WorkspaceMismatch);
    }
    let status = WorkflowRunStatus::from_raw(&snapshot.status)
        .map_err(|_| NativeObservationError::WorkflowUnavailable)?;
    Ok(NativeWorkflowObservation {
        reference: reference.clone(),
        status,
    })
}

/// Why a terminal observation may not be recorded yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultHandoffWait {
    /// The run has no recorded terminal receipt.
    NotTerminal,
    /// The bound work item already holds a result; keep the newer one staged.
    AlreadyRecorded,
    /// The work item's phase cannot accept a result.
    NotAcceptable,
}

/// A record that must be reconciled instead of consumed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultHandoffUnknown {
    /// The saved run state is legacy, imported, unmanaged or contradictory.
    RunState(NativeUnknownReason),
    /// A pending delivery receipt must be checked against the original history.
    DeliveryPendingReconciliation,
    /// The delivery receipt cannot be read, so the result body stays unproven.
    DeliveryUnobserved,
    /// The parent attempt is only a locator until the admission binding is proven.
    ParentAttemptUnverified,
}

/// The exact basis a host may record for one observed terminal run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultHandoffDraft {
    pub basis: ResultBasis,
    /// Deterministic identity so a replayed observation cannot create a second
    /// result for the same terminal event.
    pub result_id: String,
    pub event_id: String,
    pub outcome: NativeTerminalOutcome,
}

/// What the host may do with one observed run for a bound work item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultHandoff {
    Record(ResultHandoffDraft),
    Reconcile(ResultHandoffUnknown),
    Wait(ResultHandoffWait),
}

/// Decide the result handoff for one bound work item.
///
/// This writes nothing, replays no delivery and never completes the work item;
/// it only states whether the durable record may accept this terminal result.
/// `parent_verified` is the host's own proof that this run belongs to the work
/// item's admitted attempt; the observation alone cannot establish that.
pub fn plan_result_handoff(
    work: &WorkRecord,
    observation: &NativeRunObservation,
    parent_verified: bool,
) -> ResultHandoff {
    let (event, outcome) = match &observation.state {
        NativeRunState::RecordedTerminal { event, outcome } => (event, *outcome),
        NativeRunState::Unknown(reason) => {
            return ResultHandoff::Reconcile(ResultHandoffUnknown::RunState(reason.clone()));
        }
        NativeRunState::RecordedPending
        | NativeRunState::RecordedRunning
        | NativeRunState::RecordedPaused => {
            return ResultHandoff::Wait(ResultHandoffWait::NotTerminal);
        }
    };
    match &observation.delivery {
        NativeDeliveryObservation::PendingReconciliation => {
            return ResultHandoff::Reconcile(ResultHandoffUnknown::DeliveryPendingReconciliation);
        }
        NativeDeliveryObservation::Unknown => {
            return ResultHandoff::Reconcile(ResultHandoffUnknown::DeliveryUnobserved);
        }
        NativeDeliveryObservation::NoReceiptObserved
        | NativeDeliveryObservation::Suppressed
        | NativeDeliveryObservation::HistoryReceipt { .. } => {}
    }
    if !parent_verified {
        return ResultHandoff::Reconcile(ResultHandoffUnknown::ParentAttemptUnverified);
    }
    if !matches!(
        work.phase,
        WorkPhase::Pending | WorkPhase::Running | WorkPhase::WaitingUser | WorkPhase::WaitingEvent
    ) {
        return ResultHandoff::Wait(ResultHandoffWait::NotAcceptable);
    }
    if work.result.is_some() {
        return ResultHandoff::Wait(ResultHandoffWait::AlreadyRecorded);
    }
    ResultHandoff::Record(ResultHandoffDraft {
        basis: ResultBasis {
            requirements_revision: work.revision.requirements_revision,
            control_epoch: work.revision.control_epoch,
            owner_epoch: work.revision.owner_epoch,
            applied_input_sequence: work.revision.applied_input_sequence,
        },
        result_id: format!("run:{}:{}", event.run.run_id, event.event_id),
        event_id: event.event_id.clone(),
        outcome,
    })
}

/// True only when the work record itself pins this exact run and its parent
/// attempt. The observation supplies a locator; the admitted binding supplies
/// the proof, and a mutable current-task field can never stand in for it.
pub fn work_pins_run(work: &WorkRecord, observation: &NativeRunObservation) -> bool {
    let ParentAttemptObservation::Unverified(observed_attempt) = &observation.parent_attempt else {
        return false;
    };
    work.native_refs.iter().any(|reference| match reference {
        WorkNativeReference::Known(WorkKnownReference::Background {
            parent_attempt,
            run,
            run_kind,
            ..
        }) => {
            run == &observation.run
                && parent_attempt == observed_attempt
                && matches!(
                    run_kind,
                    WorkBackgroundKind::Generic
                        | WorkBackgroundKind::Subagent
                        | WorkBackgroundKind::Workflow
                )
        }
        _ => false,
    })
}

/// Decide the handoff using only the durable binding as the parent proof.
pub fn plan_bound_result_handoff(
    work: &WorkRecord,
    observation: &NativeRunObservation,
) -> ResultHandoff {
    plan_result_handoff(work, observation, work_pins_run(work, observation))
}

#[cfg(test)]
#[path = "native_result/tests.rs"]
mod tests;
