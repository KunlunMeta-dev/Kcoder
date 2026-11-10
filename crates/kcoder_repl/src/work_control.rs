//! Durable pause/resume/stop submission for the continuous work bound to this
//! workspace and session.
//!
//! This terminal is not a control authority. It records the same user intent a
//! host writes through `ContinuousWorkStore::control`, and the store owns the
//! cross-process locking, the revision fence and the receipt. The host paths
//! that read a pending control still have to consume it; until they do and
//! settle it, nothing is paused, resumed or stopped. A receipt is therefore a
//! stored control intent, never proof of settlement or of business completion.

use crate::ReplApp;
use crate::text_formatting::truncate_text;
use crate::tool_format::sanitize_tui_text;
use crate::work_observation::{BoundWork, ReadyWorkTarget, WorkTarget, open_target};
use kcoder_engine::QueryEngine;
use kcoder_types::MessageRole;
use kcoder_types::continuous_work::{
    WorkControlAction, WorkControlReceipt, WorkControlState, WorkControlTarget,
};

#[cfg(test)]
#[path = "work_control.test.rs"]
mod tests;

/// Request-id prefix, so a control written by this terminal stays identifiable
/// in the store without implying who settled it.
const REQUEST_ID_PREFIX: &str = "tui-";

/// Bounded durable error code. Matches the host's own limit for a code it lets
/// leave the target process.
const MAX_CODE_BYTES: usize = 96;

/// Longest free-form store message copied into a notice.
const MAX_DETAIL_CHARS: usize = 200;

/// The store's revision fence refused the request: another writer advanced the
/// work between this terminal's read and its write. The durable input path
/// classifies the same fence.
pub(crate) const REVISION_CONFLICT: &str = "CONTINUOUS_WORK_REVISION_CONFLICT";

/// Parse one control subcommand of `/work`.
pub(crate) fn action(args: &str) -> Option<WorkControlAction> {
    match args {
        "pause" => Some(WorkControlAction::Pause),
        "resume" => Some(WorkControlAction::Resume),
        "stop" => Some(WorkControlAction::Stop),
        _ => None,
    }
}

/// A control request whose durable outcome this terminal cannot vouch for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnconfirmedControl {
    pub(crate) action: WorkControlAction,
    /// Absent when the store or its scope could not be read at all.
    pub(crate) work_id: Option<String>,
    /// Absent when no request id could be issued.
    pub(crate) request_id: Option<String>,
}

/// Refuses another control submission while an earlier request's durable
/// outcome is unknown. A new submission under a fresh request id would replay a
/// control the host may already hold, so only an explicit store re-read clears
/// this.
#[derive(Debug, Default)]
pub(crate) struct WorkControlGate {
    unconfirmed: Option<UnconfirmedControl>,
}

impl WorkControlGate {
    pub(crate) fn unconfirmed(&self) -> Option<&UnconfirmedControl> {
        self.unconfirmed.as_ref()
    }

    /// `/work observation` re-reads the store, so a later submission starts
    /// from what that read reported instead of an unconfirmed intent.
    pub(crate) fn note_observation(&mut self) {
        self.unconfirmed = None;
    }

    fn record(&mut self, submission: &ControlSubmission) {
        self.unconfirmed = submission.unconfirmed();
    }
}

/// One submitted control request and what the store reported for it.
#[derive(Debug)]
pub(crate) struct ControlSubmission {
    pub(crate) action: WorkControlAction,
    pub(crate) outcome: ControlOutcome,
}

/// What one control submission established. Neither a receipt nor an error here
/// proves that the host applied the control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ControlOutcome {
    /// Nothing is bound to this workspace and session, or no store exists.
    NoWork,
    /// The store or its host-resolved scope could not be read.
    StoreUnavailable,
    /// The store returned an error instead of a receipt.
    Rejected {
        work_id: String,
        request_id: String,
        expected_revision: u64,
        /// Bounded store code, or a sanitized message when the store had none.
        code: String,
        /// Set only for a stale-revision conflict, re-read just to be reported.
        stale: bool,
        current_revision: Option<u64>,
    },
    /// A receipt was recorded and its durable copy was re-read.
    Recorded {
        work_id: String,
        receipt: Box<WorkControlReceipt>,
    },
    /// The request may or may not have reached the store.
    Unknown {
        work_id: String,
        request_id: String,
        detail: String,
    },
}

impl ControlSubmission {
    /// The notice one submission prints. It never claims a terminal state the
    /// receipt does not report.
    pub(crate) fn report(&self) -> String {
        let action = self.action.as_str();
        match &self.outcome {
            ControlOutcome::NoWork => format!(
                "Continuous work control `{action}` not submitted\nNo continuous work is bound to this workspace and session, or no continuous work storage exists. Nothing was created and no control record was written.\nRe-read with `/work observation` to confirm the current binding."
            ),
            ControlOutcome::StoreUnavailable => format!(
                "Continuous work control `{action}` not submitted\nWork storage exists but this terminal could not read it, or the profile/workspace scope could not be verified. This command submitted nothing.\noutcome unknown, re-read with `/work observation` before submitting again."
            ),
            ControlOutcome::Rejected {
                work_id,
                request_id,
                expected_revision,
                code,
                stale,
                current_revision,
            } => {
                let current = current_revision
                    .map(|revision| revision.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                if *stale {
                    format!(
                        "Continuous work control `{action}` rejected: stale revision\nwork: {work_id}\nrequest id: {request_id}\nexpected revision: {expected_revision}\nerror: {code}\ncurrent revision: {current}\nNothing was written and this command does not retry. Run `/work {action}` again to submit against the re-read revision."
                    )
                } else {
                    format!(
                        "Continuous work control `{action}` rejected\nwork: {work_id}\nrequest id: {request_id}\nexpected revision: {expected_revision}\nerror: {code}\nThe store returned this error instead of a receipt. This command neither retried nor resent the request.\nRe-read with `/work observation` before acting on it."
                    )
                }
            }
            ControlOutcome::Recorded { work_id, receipt } => format!(
                "Continuous work control `{action}` recorded\nwork: {work_id}\nrequest id: {}\nexpected revision: {}\ncontrol epoch: {}\nreceipt state: {}\n{}\nA recorded receipt is a stored control intent: the host still has to consume it, and this terminal cannot make the work pause, resume or stop on its own.",
                receipt.request_id,
                receipt.expected_revision,
                receipt.control_epoch,
                receipt.state.as_str(),
                state_line(&receipt.state),
            ),
            ControlOutcome::Unknown {
                work_id,
                request_id,
                detail,
            } => format!(
                "Continuous work control `{action}` outcome unknown\nwork: {work_id}\nrequest id: {request_id}\ndetail: {detail}\nThe request may or may not have reached the target store. This command does not retry and will not resend it under a new request id.\noutcome unknown, re-read with `/work observation` before submitting again."
            ),
        }
    }

    /// A submission whose durable state is not known blocks the next one until
    /// the store has been re-read.
    fn unconfirmed(&self) -> Option<UnconfirmedControl> {
        let (work_id, request_id) = match &self.outcome {
            ControlOutcome::StoreUnavailable => (None, None),
            ControlOutcome::Unknown {
                work_id,
                request_id,
                ..
            } => (Some(work_id.clone()), Some(request_id.clone())),
            ControlOutcome::Recorded { work_id, receipt } => {
                if !receipt.state.is_known()
                    || receipt.state == WorkControlState::NeedsReconciliation
                {
                    (Some(work_id.clone()), Some(receipt.request_id.clone()))
                } else {
                    return None;
                }
            }
            ControlOutcome::NoWork | ControlOutcome::Rejected { .. } => return None,
        };
        Some(UnconfirmedControl {
            action: self.action.clone(),
            work_id,
            request_id,
        })
    }
}

/// Notice for a control withheld because an earlier request is unconfirmed.
pub(crate) fn refusal_report(
    action: WorkControlAction,
    unconfirmed: &UnconfirmedControl,
) -> String {
    let mut previous = format!("`{}`", unconfirmed.action.as_str());
    if let Some(work_id) = &unconfirmed.work_id {
        previous.push_str(&format!(" for `{work_id}`"));
    }
    if let Some(request_id) = &unconfirmed.request_id {
        previous.push_str(&format!(" (request `{request_id}`)"));
    }
    format!(
        "Continuous work control `{}` refused\nA previous control request {previous} has an unknown durable outcome, so this terminal does not send another request under a new request id.\noutcome unknown, re-read with `/work observation` before submitting again.",
        action.as_str()
    )
}

/// Run `/work pause|resume|stop` and print its honest report.
pub(crate) fn run(action: WorkControlAction, app: &mut ReplApp, engine: &QueryEngine) {
    if let Some(unconfirmed) = app.work_control.unconfirmed() {
        let notice = refusal_report(action, unconfirmed);
        app.push_message(MessageRole::System, notice);
        return;
    }
    let submission = submit(engine, action);
    let report = submission.report();
    app.work_control.record(&submission);
    app.push_message(MessageRole::System, report);
}

/// Resolve the bound work from a fresh store read, then submit one control
/// request. The work id and the expected revision always come from that read; a
/// cached status segment is never used as the fence.
pub(crate) fn submit(engine: &QueryEngine, action: WorkControlAction) -> ControlSubmission {
    let target = match open_target(engine) {
        WorkTarget::Absent => {
            return ControlSubmission {
                action,
                outcome: ControlOutcome::NoWork,
            };
        }
        WorkTarget::Unavailable => {
            return ControlSubmission {
                action,
                outcome: ControlOutcome::StoreUnavailable,
            };
        }
        WorkTarget::Ready(target) => target,
    };
    let record = match target.bound_work(&engine.session_id()) {
        BoundWork::Absent => {
            return ControlSubmission {
                action,
                outcome: ControlOutcome::NoWork,
            };
        }
        BoundWork::Unavailable => {
            return ControlSubmission {
                action,
                outcome: ControlOutcome::StoreUnavailable,
            };
        }
        BoundWork::Record(record) => record,
    };
    let work_id = record.identity.work_id.clone();
    let expected_revision = record.revision.revision;
    ControlSubmission {
        action: action.clone(),
        outcome: submit_resolved(&target, engine, &work_id, expected_revision, action),
    }
}

/// Submit one control request against an already observed revision. Split from
/// [`submit`] so a revision another writer advanced in between surfaces the
/// store's fence instead of being retried away.
pub(crate) fn submit_resolved(
    target: &ReadyWorkTarget,
    engine: &QueryEngine,
    work_id: &str,
    expected_revision: u64,
    action: WorkControlAction,
) -> ControlOutcome {
    let request_id = new_request_id();
    match target.store.control(
        target.scope(),
        work_id,
        expected_revision,
        &request_id,
        action,
        WorkControlTarget::Work {},
    ) {
        Ok(receipt) => recorded(target, engine, work_id, &request_id, receipt),
        Err(error) => refused(target, work_id, &request_id, expected_revision, &error),
    }
}

/// The store's own operation receipt is the only proof of the recorded intent.
/// When the durable copy disagrees, or the scope moved during the write, the
/// outcome is unknown rather than accepted.
fn recorded(
    target: &ReadyWorkTarget,
    engine: &QueryEngine,
    work_id: &str,
    request_id: &str,
    receipt: WorkControlReceipt,
) -> ControlOutcome {
    let observed = target
        .store
        .read_control(target.scope(), work_id, request_id)
        .ok()
        .flatten()
        .filter(|observed| {
            observed.request_id == receipt.request_id
                && observed.control_epoch == receipt.control_epoch
                && observed.action == receipt.action
                && observed.state == receipt.state
        });
    let Some(observed) = observed else {
        return ControlOutcome::Unknown {
            work_id: work_id.to_string(),
            request_id: request_id.to_string(),
            detail: "the stored receipt did not match the returned one".to_string(),
        };
    };
    if !target.verify(engine) {
        return ControlOutcome::Unknown {
            work_id: work_id.to_string(),
            request_id: request_id.to_string(),
            detail: "the profile or workspace scope changed during the write".to_string(),
        };
    }
    ControlOutcome::Recorded {
        work_id: work_id.to_string(),
        receipt: Box::new(observed),
    }
}

/// Classify one store error. A bounded code other than an unconfirmed one is
/// raised from pre-write validation, so nothing was published. An unconfirmed
/// code means the write may have landed, so the outcome stays unknown.
fn refused(
    target: &ReadyWorkTarget,
    work_id: &str,
    request_id: &str,
    expected_revision: u64,
    error: &anyhow::Error,
) -> ControlOutcome {
    let code = bounded_code(error);
    if let Some(code) = code
        .as_deref()
        .filter(|code| code.ends_with("_UNCONFIRMED"))
    {
        return ControlOutcome::Unknown {
            work_id: work_id.to_string(),
            request_id: request_id.to_string(),
            detail: code.to_string(),
        };
    }
    let stale = code.as_deref() == Some(REVISION_CONFLICT);
    // A stale fence wrote nothing, so the current revision is only re-read to be
    // reported. This is a read, not a retry of the control.
    let current_revision = if stale {
        target
            .store
            .read_work(target.scope(), work_id)
            .ok()
            .flatten()
            .map(|work| work.revision.revision)
    } else {
        None
    };
    ControlOutcome::Rejected {
        work_id: work_id.to_string(),
        request_id: request_id.to_string(),
        expected_revision,
        code: code.unwrap_or_else(|| {
            truncate_text(&sanitize_tui_text(&format!("{error:#}")), MAX_DETAIL_CHARS)
        }),
        stale,
        current_revision,
    }
}

/// The bounded durable code carried by a store error, if it has one. Unbounded
/// or private text never becomes a code. The durable input path classifies the
/// same codes.
pub(crate) fn bounded_code(error: &anyhow::Error) -> Option<String> {
    error.chain().map(ToString::to_string).find(|text| {
        text.len() <= MAX_CODE_BYTES
            && text.starts_with("CONTINUOUS_WORK_")
            && text
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

/// What one receipt state means for this terminal. Only `settled` is reported as
/// a terminal control state; every other state is pending or unknown.
fn state_line(state: &WorkControlState) -> &'static str {
    match state {
        WorkControlState::Accepted | WorkControlState::Settling => {
            "submitted, waiting for settlement"
        }
        WorkControlState::Settled => {
            "settled: the receipt reports settlement, which is still not proof that business work finished"
        }
        WorkControlState::Superseded => {
            "superseded: this request is no longer the pending control and the owned resources are not proven settled"
        }
        WorkControlState::Failed => {
            "failed: the receipt reports failure but not that the owned resources settled; re-read with `/work observation`"
        }
        WorkControlState::NeedsReconciliation | WorkControlState::Unknown(_) => {
            "outcome unknown, re-read with `/work observation`"
        }
    }
}

/// A fresh request id per submission. Re-sending the same control under a new id
/// is exactly what an unknown outcome forbids.
fn new_request_id() -> String {
    format!("{REQUEST_ID_PREFIX}{}", uuid::Uuid::new_v4())
}
