//! Durable requirement submission for the continuous work bound to this
//! workspace and session.
//!
//! This terminal is not a dispatch authority. `/work input <requirement>`
//! appends one requirement to the same store the app-server writes through
//! `accept_input`/`queue_input`, with the same busy rule, source identity and
//! delivery snapshot, and the store owns the revision fence, the input identity
//! and the receipt. Nothing here starts a turn: an accepted or queued input
//! still has to be taken by a later request, and only that request can report
//! the input applied. A receipt is therefore a stored requirement, never proof
//! of consumption or of business completion.

use crate::ReplApp;
use crate::text_formatting::truncate_text;
use crate::tool_format::sanitize_tui_text;
use crate::work_control::{REVISION_CONFLICT, bounded_code};
use crate::work_observation::{BoundWork, ReadyWorkTarget, WorkTarget, open_target};
use kcoder_engine::QueryEngine;
use kcoder_state::continuous_work::{InputAdmission, WorkInputSource};
use kcoder_types::MessageRole;
use kcoder_types::continuous_work::{WorkInputKind, WorkInputReceipt, WorkInputState, WorkScope};

#[cfg(test)]
#[path = "work_input.test.rs"]
mod tests;

/// Input-id prefix, so a requirement written by this terminal stays identifiable
/// in the store without implying who consumed it.
const INPUT_ID_PREFIX: &str = "tui-input-";

/// Request-id prefix, kept separate from the input id so a lost receipt can be
/// reconciled by request without reusing the original input identity.
const REQUEST_ID_PREFIX: &str = "tui-";

/// The host's own bound for one submitted requirement text (the app-server's
/// `MAX_TEXT_BYTES` for `work/input/submit`). A longer requirement could never
/// be submitted through the host path this command mirrors, so it is refused
/// here before any write.
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

/// Longest requirement preview copied into a notice.
const MAX_PREVIEW_CHARS: usize = 96;

/// Longest free-form store message copied into a notice.
const MAX_DETAIL_CHARS: usize = 200;

/// Parse one `/work input` subcommand. The text may be empty so the command can
/// report its usage instead of guessing a requirement.
pub(crate) fn requirement_text(args: &str) -> Option<&str> {
    if args == "input" {
        return Some("");
    }
    args.strip_prefix("input ").map(str::trim)
}

/// Run `/work input <requirement>` and print its honest report.
pub(crate) fn run(text: &str, app: &mut ReplApp, engine: &QueryEngine) {
    let requirement = match Requirement::parse(text) {
        Ok(requirement) => requirement,
        Err(refusal) => {
            app.push_message(MessageRole::System, refusal.notice());
            return;
        }
    };
    if let Some(unconfirmed) = app.work_input.unconfirmed() {
        let notice = refusal_report(unconfirmed);
        app.push_message(MessageRole::System, notice);
        return;
    }
    let submission = submit(engine, &requirement, live_turn(app));
    let report = submission.report();
    app.work_input.record(&submission);
    app.push_message(MessageRole::System, report);
}

/// This terminal's own in-flight turn signal. The host reads the live-turn fact
/// from the connection that owns the turn; here only this process can observe
/// it, and without it a target running this terminal's own turn would look idle.
fn live_turn(app: &ReplApp) -> bool {
    app.turn_state.is_active() || app.is_loading
}

/// Why a requirement text was refused before any store access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TextRefusal {
    /// Nothing to submit.
    Empty,
    /// Longer than the one input text the target accepts.
    Oversized { bytes: usize },
    /// Contains characters the durable journal could not store as written.
    NotJournalable,
}

impl TextRefusal {
    fn notice(&self) -> String {
        let reason = match self {
            Self::Empty => "No requirement text was given. Nothing was written and no input record was created.\nUsage: `/work input <requirement>`".to_string(),
            Self::Oversized { bytes } => format!(
                "The requirement is {bytes} bytes, above the {MAX_TEXT_BYTES} bytes the target accepts as one input text. Nothing was written."
            ),
            Self::NotJournalable => "The requirement contains control characters other than newlines and tabs, so the durable journal cannot store it as written. Nothing was written.".to_string(),
        };
        format!("Continuous work requirement not submitted\n{reason}")
    }
}

/// One requirement text that passed the pre-write checks. The stored text is
/// exactly the text this command displays back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Requirement {
    text: String,
}

impl Requirement {
    /// Reject a requirement the store could not journal before touching
    /// storage: nothing to submit, text beyond the host's bound, or text this
    /// terminal's own sanitizer would have to rewrite.
    pub(crate) fn parse(raw: &str) -> Result<Self, TextRefusal> {
        let text = raw.trim();
        if text.is_empty() {
            return Err(TextRefusal::Empty);
        }
        if text.len() > MAX_TEXT_BYTES {
            return Err(TextRefusal::Oversized { bytes: text.len() });
        }
        if text
            .chars()
            .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
        {
            return Err(TextRefusal::NotJournalable);
        }
        Ok(Self {
            text: text.to_string(),
        })
    }

    fn text(&self) -> &str {
        &self.text
    }

    /// One-line bounded preview, so a receipt can be matched to what was typed
    /// without repeating a whole requirement into the transcript.
    fn preview(&self) -> String {
        let mut compact = String::new();
        for word in self.text.split_whitespace() {
            if !compact.is_empty() {
                compact.push(' ');
            }
            compact.push_str(word);
        }
        truncate_text(&sanitize_tui_text(&compact), MAX_PREVIEW_CHARS)
    }
}

/// One submitted requirement and what the store reported for it.
#[derive(Debug)]
pub(crate) struct RequirementSubmission {
    /// Bounded one-line preview of the submitted requirement.
    pub(crate) text: String,
    pub(crate) outcome: RequirementOutcome,
}

impl RequirementSubmission {
    fn refused(requirement: &Requirement, outcome: RequirementOutcome) -> Self {
        Self {
            text: requirement.preview(),
            outcome,
        }
    }

    /// The notice one submission prints. It never reports a state the store did
    /// not return, and never turns a stored input into a consumed one.
    pub(crate) fn report(&self) -> String {
        let preview = &self.text;
        match &self.outcome {
            RequirementOutcome::NoWork => "Continuous work requirement not submitted\nNo continuous work is bound to this workspace and session, or no continuous work storage exists. Nothing was created and no input was written.\nRe-read with `/work observation` to confirm the current binding.".to_string(),
            RequirementOutcome::StoreUnavailable => "Continuous work requirement not submitted\nWork storage exists but this terminal could not read it, or the profile/workspace scope could not be verified. This command wrote nothing.\noutcome unknown, re-read with `/work observation` before submitting again.".to_string(),
            RequirementOutcome::Rejected {
                work_id,
                input_id,
                request_id,
                expected_revision,
                code,
                stale,
                current_revision,
            } => {
                if *stale {
                    let current = current_revision
                        .map(|revision| revision.to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    format!(
                        "Continuous work requirement rejected: stale revision\nwork: {work_id}\nrequirement: {preview}\ninput id: {input_id}\nrequest id: {request_id}\nexpected revision: {expected_revision}\nerror: {code}\ncurrent revision: {current}\nNothing was written and this command does not retry. Run `/work input <requirement>` again to submit against the re-read revision."
                    )
                } else {
                    format!(
                        "Continuous work requirement rejected\nwork: {work_id}\nrequirement: {preview}\ninput id: {input_id}\nrequest id: {request_id}\nexpected revision: {expected_revision}\nerror: {code}\nThe store refused this requirement instead of recording it. This command neither retried nor resent the request.\nRe-read with `/work observation` before acting on it."
                    )
                }
            }
            RequirementOutcome::Recorded {
                work_id,
                input_id,
                request_id,
                expected_revision,
                path,
                existing,
                receipt,
            } => {
                let state = sanitize_tui_text(receipt.state.as_str());
                let requirements_revision = receipt
                    .requirements_revision
                    .map(|revision| revision.to_string())
                    .unwrap_or_else(|| "none".to_string());
                let existing_note = if *existing {
                    "The store reported an existing record for this input id; this submission wrote nothing new.\n"
                } else {
                    ""
                };
                format!(
                    "Continuous work requirement recorded ({})\nwork: {work_id}\nrequirement: {preview}\ninput id: {input_id}\nrequest id: {request_id}\nexpected revision: {expected_revision}\nsequence: {}\nrequirements revision: {requirements_revision}\ninput state: {state}\npath: {}\n{existing_note}{}\nA stored input is a requirement the target still has to take into a request; this terminal cannot start that request or prove that a turn consumed the requirement.",
                    path.label(),
                    receipt.sequence,
                    path.reason(),
                    state_line(&receipt.state),
                )
            }
            RequirementOutcome::Unknown {
                work_id,
                input_id,
                request_id,
                detail,
            } => format!(
                "Continuous work requirement outcome unknown\nwork: {work_id}\nrequirement: {preview}\ninput id: {input_id}\nrequest id: {request_id}\ndetail: {detail}\nThe request may or may not have reached the target store. This command does not retry and will not resend it under a new input id.\noutcome unknown, re-read with `/work observation` before submitting again."
            ),
        }
    }

    /// A submission whose durable state is not known blocks the next one until
    /// the store has been re-read.
    fn unconfirmed(&self) -> Option<UnconfirmedInput> {
        match &self.outcome {
            RequirementOutcome::StoreUnavailable => Some(UnconfirmedInput {
                work_id: None,
                input_id: None,
                request_id: None,
            }),
            RequirementOutcome::Unknown {
                work_id,
                input_id,
                request_id,
                ..
            } => Some(UnconfirmedInput {
                work_id: Some(work_id.clone()),
                input_id: Some(input_id.clone()),
                request_id: Some(request_id.clone()),
            }),
            RequirementOutcome::Recorded {
                work_id,
                input_id,
                request_id,
                receipt,
                ..
            } => {
                if !receipt.state.is_known() || receipt.state == WorkInputState::NeedsReconciliation
                {
                    Some(UnconfirmedInput {
                        work_id: Some(work_id.clone()),
                        input_id: Some(input_id.clone()),
                        request_id: Some(request_id.clone()),
                    })
                } else {
                    None
                }
            }
            RequirementOutcome::NoWork | RequirementOutcome::Rejected { .. } => None,
        }
    }
}

/// What one requirement submission established. Only a store-returned input
/// state is reported; nothing here implies a turn consumed the requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RequirementOutcome {
    /// Nothing is bound to this workspace and session, or no store exists.
    NoWork,
    /// The store, its host-resolved scope or its claim state could not be read.
    StoreUnavailable,
    /// The store returned an error instead of a receipt.
    Rejected {
        work_id: String,
        input_id: String,
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
        input_id: String,
        request_id: String,
        expected_revision: u64,
        path: TargetPath,
        /// The store reported the original record instead of writing a new one.
        existing: bool,
        receipt: Box<WorkInputReceipt>,
    },
    /// The request may or may not have reached the store.
    Unknown {
        work_id: String,
        input_id: String,
        request_id: String,
        detail: String,
    },
}

/// Why this submission took the accept path or the queue path. The host decides
/// the same question from its own live turn plus the store's active claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetPath {
    /// Nothing claims the work and this terminal has no turn in flight.
    Idle,
    /// The target is busy, so the input must stay durable and unconsumed.
    Busy { claim: bool, live_turn: bool },
}

impl TargetPath {
    fn decide(claim: bool, live_turn: bool) -> Self {
        if claim || live_turn {
            Self::Busy { claim, live_turn }
        } else {
            Self::Idle
        }
    }

    fn is_busy(self) -> bool {
        matches!(self, Self::Busy { .. })
    }

    /// Short label for the receipt header.
    fn label(self) -> &'static str {
        match self {
            Self::Idle => "accepted",
            Self::Busy { .. } => "queued",
        }
    }

    /// Why this path was taken, so the report never hides the decision.
    fn reason(self) -> String {
        match self {
            Self::Idle => {
                "nothing claims this work and this terminal has no turn in flight".to_string()
            }
            Self::Busy { claim, live_turn } => match (claim, live_turn) {
                (true, true) => {
                    "an active durable claim and a turn in flight in this terminal".to_string()
                }
                (true, false) => "an active durable claim".to_string(),
                (false, true) => "a turn in flight in this terminal".to_string(),
                (false, false) => "no busy condition".to_string(),
            },
        }
    }
}

/// One requirement submission against an already observed revision. Split from
/// [`submit`] so a stale fence, a fixed input identity or a modified store can
/// be exercised without a retry loop.
pub(crate) struct RequirementRequest<'a> {
    pub(crate) work_id: &'a str,
    pub(crate) expected_revision: u64,
    pub(crate) source: &'a WorkInputSource,
    pub(crate) input_id: &'a str,
    pub(crate) request_id: &'a str,
    pub(crate) requirement: &'a Requirement,
    /// Set when this terminal itself has a turn in flight.
    pub(crate) live_turn: bool,
}

/// Resolve the bound work from a fresh store read, then submit one requirement.
/// The work id and the expected revision always come from that read; a cached
/// status segment is never used as the fence.
pub(crate) fn submit(
    engine: &QueryEngine,
    requirement: &Requirement,
    live_turn: bool,
) -> RequirementSubmission {
    let target = match open_target(engine) {
        WorkTarget::Absent => {
            return RequirementSubmission::refused(requirement, RequirementOutcome::NoWork);
        }
        WorkTarget::Unavailable => {
            return RequirementSubmission::refused(
                requirement,
                RequirementOutcome::StoreUnavailable,
            );
        }
        WorkTarget::Ready(target) => target,
    };
    let record = match target.bound_work(&engine.session_id()) {
        BoundWork::Absent => {
            return RequirementSubmission::refused(requirement, RequirementOutcome::NoWork);
        }
        BoundWork::Unavailable => {
            return RequirementSubmission::refused(
                requirement,
                RequirementOutcome::StoreUnavailable,
            );
        }
        BoundWork::Record(record) => record,
    };
    let work_id = record.identity.work_id.clone();
    let expected_revision = record.revision.revision;
    let source = input_source(target.scope(), &engine.session_id());
    let input_id = new_input_id();
    let request_id = new_request_id();
    let outcome = submit_request(
        &target,
        engine,
        RequirementRequest {
            work_id: &work_id,
            expected_revision,
            source: &source,
            input_id: &input_id,
            request_id: &request_id,
            requirement,
            live_turn,
        },
    );
    RequirementSubmission {
        text: requirement.preview(),
        outcome,
    }
}

/// Submit one requirement against an already observed revision. The store's own
/// claim is authoritative for the coordinated lane; this terminal's live turn is
/// the only additional busy fact it can observe.
pub(crate) fn submit_request(
    target: &ReadyWorkTarget,
    engine: &QueryEngine,
    request: RequirementRequest<'_>,
) -> RequirementOutcome {
    // A requirement must carry the same delivery snapshot the host passes, so
    // the target keeps one accepted-delivery set per work.
    let deliveries = match target
        .store
        .accepted_deliveries(target.scope(), request.work_id)
    {
        Ok(Some(deliveries)) => deliveries,
        Ok(None) => {
            return RequirementOutcome::Rejected {
                work_id: request.work_id.to_string(),
                input_id: request.input_id.to_string(),
                request_id: request.request_id.to_string(),
                expected_revision: request.expected_revision,
                code: "CONTINUOUS_WORK_NOT_FOUND".to_string(),
                stale: false,
                current_revision: None,
            };
        }
        Err(error) => return refused(target, &request, &error),
    };
    // An unreadable claim means this terminal cannot choose the accept or the
    // queue path, so it writes neither.
    let claim = match target.store.active_claim(target.scope(), request.work_id) {
        Ok(claim) => claim.is_some(),
        Err(_) => return RequirementOutcome::StoreUnavailable,
    };
    let path = TargetPath::decide(claim, request.live_turn);
    let payload = serde_json::json!({"text": request.requirement.text()});
    let admitted = if path.is_busy() {
        target.store.queue_input(
            target.scope(),
            request.work_id,
            request.source,
            request.expected_revision,
            request.input_id,
            request.request_id,
            WorkInputKind::Requirement,
            payload,
            Some(deliveries),
        )
    } else {
        target.store.accept_input(
            target.scope(),
            request.work_id,
            request.source,
            request.expected_revision,
            request.input_id,
            request.request_id,
            WorkInputKind::Requirement,
            payload,
            Some(deliveries),
        )
    };
    match admitted {
        Ok(InputAdmission::Accepted(receipt)) => {
            recorded(target, engine, &request, receipt, path, false)
        }
        Ok(InputAdmission::Existing(receipt)) => {
            recorded(target, engine, &request, receipt, path, true)
        }
        Err(error) => refused(target, &request, &error),
    }
}

/// The store's own operation receipt is the only proof of the recorded
/// requirement. The durable copy is re-read and its original payload compared,
/// because an input id alone does not prove that this terminal's text was
/// stored. The re-read state is reported as stored, even when it advanced.
fn recorded(
    target: &ReadyWorkTarget,
    engine: &QueryEngine,
    request: &RequirementRequest<'_>,
    receipt: WorkInputReceipt,
    path: TargetPath,
    existing: bool,
) -> RequirementOutcome {
    let observed = target
        .store
        .read_input(
            target.scope(),
            request.work_id,
            request.source,
            request.input_id,
        )
        .ok()
        .flatten()
        .filter(|(observed, payload)| {
            observed.work.work_id == request.work_id
                && observed.input_id == request.input_id
                && observed.request_id == request.request_id
                && observed.sequence == receipt.sequence
                && observed.kind == receipt.kind
                && payload.get("text").and_then(serde_json::Value::as_str)
                    == Some(request.requirement.text())
        });
    let Some((observed, _payload)) = observed else {
        return RequirementOutcome::Unknown {
            work_id: request.work_id.to_string(),
            input_id: request.input_id.to_string(),
            request_id: request.request_id.to_string(),
            detail: "the stored input did not match the returned receipt".to_string(),
        };
    };
    if !target.verify(engine) {
        return RequirementOutcome::Unknown {
            work_id: request.work_id.to_string(),
            input_id: request.input_id.to_string(),
            request_id: request.request_id.to_string(),
            detail: "the profile or workspace scope changed during the write".to_string(),
        };
    }
    RequirementOutcome::Recorded {
        work_id: request.work_id.to_string(),
        input_id: request.input_id.to_string(),
        request_id: request.request_id.to_string(),
        expected_revision: request.expected_revision,
        path,
        existing,
        receipt: Box::new(observed),
    }
}

/// Classify one store error. A bounded code other than an unconfirmed one is
/// raised from pre-write validation, so nothing was published. An unconfirmed
/// code means the write may have landed, so the outcome stays unknown.
fn refused(
    target: &ReadyWorkTarget,
    request: &RequirementRequest<'_>,
    error: &anyhow::Error,
) -> RequirementOutcome {
    let code = bounded_code(error);
    if let Some(code) = code
        .as_deref()
        .filter(|code| code.ends_with("_UNCONFIRMED"))
    {
        return RequirementOutcome::Unknown {
            work_id: request.work_id.to_string(),
            input_id: request.input_id.to_string(),
            request_id: request.request_id.to_string(),
            detail: code.to_string(),
        };
    }
    let stale = code.as_deref() == Some(REVISION_CONFLICT);
    // A stale fence wrote nothing, so the current revision is only re-read to be
    // reported. This is a read, not a retry of the submission.
    let current_revision = if stale {
        target
            .store
            .read_work(target.scope(), request.work_id)
            .ok()
            .flatten()
            .map(|work| work.revision.revision)
    } else {
        None
    };
    RequirementOutcome::Rejected {
        work_id: request.work_id.to_string(),
        input_id: request.input_id.to_string(),
        request_id: request.request_id.to_string(),
        expected_revision: request.expected_revision,
        code: code.unwrap_or_else(|| {
            truncate_text(&sanitize_tui_text(&format!("{error:#}")), MAX_DETAIL_CHARS)
        }),
        stale,
        current_revision,
    }
}

/// What one receipt state means for this terminal. Only `applied` is reported as
/// consumption, and only because the store said so.
fn state_line(state: &WorkInputState) -> &'static str {
    match state {
        WorkInputState::Accepted | WorkInputState::Queued | WorkInputState::Dispatched => {
            "accepted, not yet taken by a request"
        }
        WorkInputState::Applied => "applied: the store reports this input applied to a turn",
        WorkInputState::Rejected => "rejected: the store reports this input rejected",
        WorkInputState::NeedsReconciliation | WorkInputState::Unknown(_) => {
            "outcome unknown, re-read with `/work observation`"
        }
    }
}

/// A requirement submission whose durable outcome this terminal cannot vouch for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnconfirmedInput {
    /// Absent when the store or its scope could not be read at all.
    pub(crate) work_id: Option<String>,
    /// Absent when no input id could be issued.
    pub(crate) input_id: Option<String>,
    /// Absent when no request id could be issued.
    pub(crate) request_id: Option<String>,
}

/// Refuses another requirement while an earlier submission's durable outcome is
/// unknown. A new submission under a fresh input id would replay a requirement
/// the store may already hold, so only an explicit store re-read clears this.
#[derive(Debug, Default)]
pub(crate) struct WorkInputGate {
    unconfirmed: Option<UnconfirmedInput>,
}

impl WorkInputGate {
    pub(crate) fn unconfirmed(&self) -> Option<&UnconfirmedInput> {
        self.unconfirmed.as_ref()
    }

    /// `/work observation` re-reads the store, so a later submission starts from
    /// what that read reported instead of an unconfirmed requirement.
    pub(crate) fn note_observation(&mut self) {
        self.unconfirmed = None;
    }

    fn record(&mut self, submission: &RequirementSubmission) {
        self.unconfirmed = submission.unconfirmed();
    }
}

/// Notice for a requirement withheld because an earlier submission is
/// unconfirmed.
pub(crate) fn refusal_report(unconfirmed: &UnconfirmedInput) -> String {
    let mut identity = String::new();
    if let Some(input_id) = &unconfirmed.input_id {
        identity.push_str(&format!("input `{input_id}`"));
    }
    if let Some(request_id) = &unconfirmed.request_id {
        if !identity.is_empty() {
            identity.push_str(", ");
        }
        identity.push_str(&format!("request `{request_id}`"));
    }
    if let Some(work_id) = &unconfirmed.work_id {
        if !identity.is_empty() {
            identity.push_str(" on ");
        }
        identity.push_str(&format!("work `{work_id}`"));
    }
    let previous = if identity.is_empty() {
        "A previous requirement submission".to_string()
    } else {
        format!("A previous requirement submission ({identity})")
    };
    format!(
        "Continuous work requirement refused\n{previous} has an unknown durable outcome, so this terminal does not send another requirement under a new input id.\noutcome unknown, re-read with `/work observation` before submitting again."
    )
}

/// The original-source identity a host attributes a requirement to. It matches
/// the app-server's own `foreground`/target/thread triple, so this terminal and
/// the host append to one input lane instead of two.
fn input_source(scope: &WorkScope, session_id: &str) -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: scope.target_id.clone(),
        conversation_id: session_id.to_owned(),
    }
}

/// A fresh input id per submission. Resending the same requirement under a new
/// input id is exactly what an unknown outcome forbids.
fn new_input_id() -> String {
    format!("{INPUT_ID_PREFIX}{}", uuid::Uuid::new_v4())
}

/// A fresh request id per submission, kept distinct from the input id so the
/// store can reconcile a request that never returned a receipt.
fn new_request_id() -> String {
    format!("{REQUEST_ID_PREFIX}{}", uuid::Uuid::new_v4())
}
