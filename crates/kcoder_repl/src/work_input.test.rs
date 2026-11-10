//! Regressions for durable requirement submission from the terminal.
use super::{
    Requirement, RequirementOutcome, RequirementRequest, RequirementSubmission, TargetPath,
    TextRefusal, input_source, refusal_report, requirement_text, run, submit, submit_request,
};
use crate::test_support::test_engine;
use crate::work_observation::{WorkTarget, open_target};
use kcoder_engine::QueryEngine;
use kcoder_state::continuous_work::{
    ClaimOutcome, ClaimTrigger, ContinuousWorkStore, HostWorkScope, WorkInputSource,
};
use kcoder_types::MessageRole;
use kcoder_types::TurnAttemptIdentity;
use kcoder_types::continuous_work::{
    WorkIdentity, WorkInputKind, WorkInputReceipt, WorkInputState, WorkRecord, WorkScope,
};

fn private_temp() -> tempfile::TempDir {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap()
    }
    #[cfg(not(unix))]
    {
        let temp = tempfile::tempdir().unwrap();
        kcoder_config::PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .verify_private_directory()
            .unwrap();
        temp
    }
}

/// A private per-test profile and workspace, so the captured scope belongs to
/// this test only. The user's real profile is never opened.
struct Fixture {
    profile: tempfile::TempDir,
    workspace: tempfile::TempDir,
    engine: QueryEngine,
}

impl Fixture {
    fn new() -> Self {
        let profile = private_temp();
        let workspace = private_temp();
        let engine = test_engine(workspace.path())
            .with_settings_persistence_path(profile.path().join("settings.json"));
        Self {
            profile,
            workspace,
            engine,
        }
    }

    fn scope(&self) -> WorkScope {
        HostWorkScope::capture(self.profile.path(), self.workspace.path(), None)
            .expect("private test scope")
            .scope()
            .clone()
    }

    /// Admit one native work record bound to this engine's session.
    fn admit(&self, work_id: &str) {
        let scope = self.scope();
        let store =
            ContinuousWorkStore::open_or_create(self.profile.path()).expect("own test store");
        store
            .admit(
                &scope,
                work_record(&scope, work_id, &self.engine.session_id()),
                &host_source(),
                &format!("request-{work_id}"),
                serde_json::json!({"text": work_id}),
                Vec::new(),
            )
            .expect("own test admission");
    }

    /// A host-side claim, which is what makes the target busy for the lane this
    /// terminal writes into. Only a bound host may acquire it.
    fn claim(&self, work_id: &str, claim_id: &str) {
        let store = self.store();
        let scope = self.scope();
        let work = self.work(work_id);
        let outcome = store
            .claim(
                &scope,
                work_id,
                work.revision.revision,
                work.revision.control_epoch,
                claim_id,
                &self.engine.session_id(),
                ClaimTrigger::Input,
            )
            .expect("host claim");
        assert!(
            matches!(outcome, ClaimOutcome::Acquired(_)),
            "expected an acquired claim"
        );
    }

    fn store(&self) -> ContinuousWorkStore {
        ContinuousWorkStore::open_existing(self.profile.path())
            .expect("own test store")
            .expect("existing test store")
    }

    fn work(&self, work_id: &str) -> WorkRecord {
        self.store()
            .read_work(&self.scope(), work_id)
            .expect("own test read")
            .expect("stored work")
    }

    fn inputs(&self, work_id: &str) -> Vec<WorkInputReceipt> {
        self.store()
            .list_inputs(&self.scope(), work_id, None)
            .expect("own test input list")
            .inputs
            .into_iter()
            .map(|entry| entry.receipt)
            .collect()
    }

    /// The exact source this terminal attributes a requirement to.
    fn tui_source(&self) -> WorkInputSource {
        input_source(&self.scope(), &self.engine.session_id())
    }

    fn state_path(&self) -> std::path::PathBuf {
        self.profile.path().join("continuous-work.v1/state.json")
    }
}

fn host_source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "host-instance".into(),
        conversation_id: "host-conversation".into(),
    }
}

fn work_record(scope: &WorkScope, work_id: &str, thread_id: &str) -> WorkRecord {
    let attempt = TurnAttemptIdentity {
        thread_id: thread_id.into(),
        turn_id: format!("turn-{work_id}"),
        attempt_id: format!("attempt-{work_id}"),
    };
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": work_id},
        "origin": {"kind": "foreground", "initialAttempt": attempt},
        "linkedThreadIds": [thread_id],
        "phase": "pending",
        "revision": {
            "revision": 1,
            "requirementsRevision": 1,
            "controlEpoch": 0,
            "ownerEpoch": 0,
            "acceptedInputSequence": 1,
            "requiredInputSequence": 1,
            "appliedInputSequence": 0,
        },
    }))
    .expect("valid work record")
}

fn requirement(text: &str) -> Requirement {
    Requirement::parse(text).expect("valid requirement text")
}

fn receipt(state: WorkInputState) -> WorkInputReceipt {
    WorkInputReceipt {
        work: WorkIdentity {
            scope: WorkScope {
                account_id: "account-1".into(),
                target_id: "target-1".into(),
                workspace_id: "workspace-1".into(),
            },
            work_id: "work-1".into(),
        },
        input_id: "tui-input-1".into(),
        request_id: "tui-request-1".into(),
        request_digest: "a".repeat(64),
        payload_ref: "payload-1".into(),
        sequence: 2,
        kind: WorkInputKind::Requirement,
        state,
        requirements_revision: Some(2),
    }
}

fn recorded_submission(state: WorkInputState) -> RequirementSubmission {
    RequirementSubmission {
        text: "durable requirement".into(),
        outcome: RequirementOutcome::Recorded {
            work_id: "work-1".into(),
            input_id: "tui-input-1".into(),
            request_id: "tui-request-1".into(),
            expected_revision: 1,
            path: TargetPath::Busy {
                claim: true,
                live_turn: false,
            },
            existing: false,
            receipt: Box::new(receipt(state)),
        },
    }
}

#[test]
fn work_input_idle_target_accepts_one_requirement_at_the_observed_revision() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    let observed = fixture.work("work-1").revision.revision;
    let before = fixture.inputs("work-1").len();

    let submission = submit(&fixture.engine, &requirement("ship the queue"), false);
    let RequirementOutcome::Recorded {
        receipt,
        path,
        expected_revision,
        existing,
        ..
    } = &submission.outcome
    else {
        panic!(
            "expected a recorded requirement, got {:?}",
            submission.outcome
        );
    };
    assert_eq!(*path, TargetPath::Idle);
    assert!(!existing);
    assert_eq!(receipt.state, WorkInputState::Accepted);
    assert_eq!(*expected_revision, observed);
    assert_eq!(receipt.kind, WorkInputKind::Requirement);
    assert_eq!(receipt.sequence, 2);
    assert!(receipt.input_id.starts_with("tui-input-"));
    assert!(receipt.request_id.starts_with("tui-"));

    // Exactly one write, against the freshly observed revision.
    let stored = fixture.work("work-1");
    assert_eq!(stored.revision.revision, observed + 1);
    assert_eq!(stored.revision.accepted_input_sequence, 2);
    assert_eq!(fixture.inputs("work-1").len(), before + 1);

    let source = fixture.tui_source();
    let (read, payload) = fixture
        .store()
        .read_input(&fixture.scope(), "work-1", &source, &receipt.input_id)
        .expect("own test input read")
        .expect("stored input");
    assert_eq!(read, **receipt);
    assert_eq!(payload["text"], "ship the queue");

    let report = submission.report();
    assert!(report.contains("recorded (accepted)"), "{report}");
    assert!(report.contains("input state: accepted"), "{report}");
    assert!(
        report.contains("accepted, not yet taken by a request"),
        "{report}"
    );
    assert!(
        report.contains("nothing claims this work and this terminal has no turn in flight"),
        "{report}"
    );
    // A stored requirement is not consumption.
    assert!(!report.contains("applied"), "{report}");
    assert!(!report.contains("consumed by"), "{report}");
}

#[test]
fn work_input_busy_claim_queues_one_requirement_without_consuming_it() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    fixture.claim("work-1", "claim-1");
    let observed = fixture.work("work-1").revision.revision;
    let before = fixture.inputs("work-1").len();

    let submission = submit(&fixture.engine, &requirement("queued while busy"), false);
    let RequirementOutcome::Recorded {
        receipt,
        path,
        expected_revision,
        ..
    } = &submission.outcome
    else {
        panic!(
            "expected a recorded requirement, got {:?}",
            submission.outcome
        );
    };
    assert_eq!(
        *path,
        TargetPath::Busy {
            claim: true,
            live_turn: false
        }
    );
    assert_eq!(receipt.state, WorkInputState::Queued);
    assert_eq!(*expected_revision, observed);

    // Exactly one write, and nothing was consumed.
    let stored = fixture.work("work-1");
    assert_eq!(stored.revision.revision, observed + 1);
    assert_eq!(stored.revision.applied_input_sequence, 0);
    assert_eq!(stored.revision.accepted_input_sequence, 2);
    assert_eq!(fixture.inputs("work-1").len(), before + 1);

    let report = submission.report();
    assert!(report.contains("recorded (queued)"), "{report}");
    assert!(report.contains("input state: queued"), "{report}");
    assert!(report.contains("path: an active durable claim"), "{report}");
    assert!(
        report.contains("accepted, not yet taken by a request"),
        "{report}"
    );
    assert!(!report.contains("applied"), "{report}");
}

#[test]
fn work_input_queues_when_this_terminal_itself_has_a_turn_in_flight() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    // A streaming turn is this terminal's own in-flight signal.
    let mut app = crate::ReplApp {
        is_loading: true,
        ..crate::ReplApp::default()
    };

    run("keep it durable", &mut app, &fixture.engine);
    let notice = &app.messages.last().expect("notice").text;
    assert_eq!(app.messages.last().unwrap().role, MessageRole::System);
    assert!(notice.contains("recorded (queued)"), "{notice}");
    assert!(
        notice.contains("path: a turn in flight in this terminal"),
        "{notice}"
    );
    assert!(notice.contains("input state: queued"), "{notice}");
    assert!(!notice.contains("applied"), "{notice}");
    assert_eq!(fixture.inputs("work-1")[1].state, WorkInputState::Queued);
    assert_eq!(fixture.work("work-1").revision.applied_input_sequence, 0);
}

#[test]
fn work_input_stale_revision_writes_nothing_and_reports_the_current_revision() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    let observed = fixture.work("work-1").revision.revision;

    // Another writer advances the work between this terminal's read and write.
    fixture
        .store()
        .accept_input(
            &fixture.scope(),
            "work-1",
            &host_source(),
            observed,
            "host-input-1",
            "host-request-1",
            WorkInputKind::Requirement,
            serde_json::json!({"text": "host requirement"}),
            Some(Vec::new()),
        )
        .expect("host input");
    let advanced = fixture.work("work-1").revision.revision;
    assert_eq!(advanced, observed + 1);
    let before = fixture.inputs("work-1").len();

    let WorkTarget::Ready(target) = open_target(&fixture.engine) else {
        panic!("expected an opened target store");
    };
    let text = requirement("stale requirement");
    let source = fixture.tui_source();
    let outcome = submit_request(
        &target,
        &fixture.engine,
        RequirementRequest {
            work_id: "work-1",
            expected_revision: observed,
            source: &source,
            input_id: "tui-input-stale",
            request_id: "tui-request-stale",
            requirement: &text,
            live_turn: false,
        },
    );
    let RequirementOutcome::Rejected {
        code,
        stale,
        current_revision,
        expected_revision,
        ..
    } = &outcome
    else {
        panic!("expected a stale revision rejection, got {outcome:?}");
    };
    assert!(stale);
    assert_eq!(code, "CONTINUOUS_WORK_REVISION_CONFLICT");
    assert_eq!(*expected_revision, observed);
    assert_eq!(*current_revision, Some(advanced));

    let report = RequirementSubmission {
        text: text.preview(),
        outcome: outcome.clone(),
    }
    .report();
    assert!(report.contains("stale revision"), "{report}");
    assert!(
        report.contains("CONTINUOUS_WORK_REVISION_CONFLICT"),
        "{report}"
    );
    assert!(
        report.contains(&format!("current revision: {advanced}")),
        "{report}"
    );
    assert!(report.contains("does not retry"), "{report}");
    assert!(!report.contains("recorded"), "{report}");
    assert!(!report.contains("applied"), "{report}");

    // Nothing was written by the rejected submission.
    assert_eq!(fixture.work("work-1").revision.revision, advanced);
    assert_eq!(fixture.inputs("work-1").len(), before);
}

#[test]
fn work_input_unknown_outcome_blocks_a_resend_until_the_store_is_re_read() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    // A store another process left unparsable must stay untouched.
    std::fs::write(fixture.state_path(), b"{ not json").expect("corrupt own store");
    let mut app = crate::ReplApp::default();

    run("first requirement", &mut app, &fixture.engine);
    let first = &app.messages.last().expect("first notice").text;
    assert!(first.contains("not submitted"), "{first}");
    assert!(
        first.contains("outcome unknown, re-read with `/work observation`"),
        "{first}"
    );
    assert!(!first.contains("recorded"), "{first}");
    assert!(!first.contains("applied"), "{first}");
    assert_eq!(
        std::fs::read(fixture.state_path()).expect("read own store"),
        b"{ not json"
    );
    assert!(app.work_input.unconfirmed().is_some());

    run("second requirement", &mut app, &fixture.engine);
    let refused = &app.messages.last().expect("refusal notice").text;
    assert!(refused.contains("refused"), "{refused}");
    assert!(
        refused.contains("outcome unknown, re-read with `/work observation`"),
        "{refused}"
    );
    assert!(!refused.contains("not submitted"), "{refused}");
    assert_eq!(
        std::fs::read(fixture.state_path()).expect("read own store"),
        b"{ not json"
    );

    let unconfirmed = app.work_input.unconfirmed().expect("still blocked");
    assert!(refusal_report(unconfirmed).contains("refused"));

    // Only an explicit re-read of the store releases the gate.
    app.work_input.note_observation();
    assert!(app.work_input.unconfirmed().is_none());
    run("third requirement", &mut app, &fixture.engine);
    let attempted = &app.messages.last().expect("second attempt").text;
    assert!(!attempted.contains("refused"), "{attempted}");
    assert!(attempted.contains("not submitted"), "{attempted}");
}

#[test]
fn work_input_same_input_id_with_different_text_is_rejected_by_the_store() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    let WorkTarget::Ready(target) = open_target(&fixture.engine) else {
        panic!("expected an opened target store");
    };
    let source = fixture.tui_source();
    let first = requirement("first requirement");
    let accepted = submit_request(
        &target,
        &fixture.engine,
        RequirementRequest {
            work_id: "work-1",
            expected_revision: fixture.work("work-1").revision.revision,
            source: &source,
            input_id: "tui-input-1",
            request_id: "tui-request-1",
            requirement: &first,
            live_turn: false,
        },
    );
    assert!(
        matches!(accepted, RequirementOutcome::Recorded { .. }),
        "{accepted:?}"
    );
    let written = fixture.work("work-1").revision.revision;

    let other = requirement("different requirement");
    let outcome = submit_request(
        &target,
        &fixture.engine,
        RequirementRequest {
            work_id: "work-1",
            expected_revision: written,
            source: &source,
            input_id: "tui-input-1",
            request_id: "tui-request-2",
            requirement: &other,
            live_turn: false,
        },
    );
    let RequirementOutcome::Rejected { code, stale, .. } = &outcome else {
        panic!("expected a rejected duplicate input id, got {outcome:?}");
    };
    assert_eq!(code, "CONTINUOUS_WORK_INPUT_CONFLICT");
    assert!(!stale);
    let report = RequirementSubmission {
        text: other.preview(),
        outcome: outcome.clone(),
    }
    .report();
    assert!(report.contains("rejected"), "{report}");
    assert!(
        report.contains("CONTINUOUS_WORK_INPUT_CONFLICT"),
        "{report}"
    );
    assert!(report.contains("different requirement"), "{report}");
    assert!(!report.contains("recorded"), "{report}");

    // The original stored requirement was neither overwritten nor duplicated.
    assert_eq!(fixture.work("work-1").revision.revision, written);
    assert_eq!(fixture.inputs("work-1").len(), 2);
    let (stored, payload) = fixture
        .store()
        .read_input(&fixture.scope(), "work-1", &source, "tui-input-1")
        .expect("own test input read")
        .expect("stored input");
    assert_eq!(stored.request_id, "tui-request-1");
    assert_eq!(payload["text"], "first requirement");
}

#[test]
fn work_input_rejects_unusable_text_before_any_write() {
    for (raw, expected) in [
        ("", TextRefusal::Empty),
        ("   \n\t ", TextRefusal::Empty),
        ("\u{0}requirement", TextRefusal::NotJournalable),
        ("\u{1b}[31mrequirement", TextRefusal::NotJournalable),
    ] {
        assert_eq!(Requirement::parse(raw).unwrap_err(), expected, "{raw:?}");
    }
    let oversized = "x".repeat(super::MAX_TEXT_BYTES + 1);
    assert_eq!(
        Requirement::parse(&oversized).unwrap_err(),
        TextRefusal::Oversized {
            bytes: super::MAX_TEXT_BYTES + 1
        }
    );
    // Newlines and tabs stay journalable, and the stored text is trimmed.
    assert_eq!(
        requirement("  first line\n\tsecond line  ").text(),
        "first line\n\tsecond line"
    );

    // None of the refusals touched or created the target store.
    let fixture = Fixture::new();
    let mut app = crate::ReplApp::default();
    run("", &mut app, &fixture.engine);
    let empty = &app.messages.last().expect("notice").text;
    assert!(empty.contains("No requirement text was given"), "{empty}");
    assert!(empty.contains("/work input <requirement>"), "{empty}");
    run(&oversized, &mut app, &fixture.engine);
    let too_long = &app.messages.last().expect("notice").text;
    assert!(too_long.contains("Nothing was written"), "{too_long}");
    run("bad\u{0}text", &mut app, &fixture.engine);
    let unjournalable = &app.messages.last().expect("notice").text;
    assert!(
        unjournalable.contains("cannot store it as written"),
        "{unjournalable}"
    );
    assert!(
        matches!(
            ContinuousWorkStore::open_existing(fixture.profile.path()),
            Ok(None)
        ),
        "a rejected requirement must not create work storage"
    );
    assert!(app.work_input.unconfirmed().is_none());
}

#[test]
fn work_input_receipt_never_claims_consumption_unless_the_store_reports_it() {
    for state in [
        WorkInputState::Accepted,
        WorkInputState::Queued,
        WorkInputState::Dispatched,
    ] {
        let submission = recorded_submission(state.clone());
        let report = submission.report();
        assert!(
            report.contains(&format!("input state: {}", state.as_str())),
            "{report}"
        );
        assert!(
            report.contains("accepted, not yet taken by a request"),
            "{report}"
        );
        assert!(!report.contains("applied"), "{report}");
        // A stored input waits for a request; it does not block a later one the
        // way an unknown outcome does.
        assert!(submission.unconfirmed().is_none(), "{report}");
    }

    let applied = recorded_submission(WorkInputState::Applied);
    let report = applied.report();
    assert!(report.contains("input state: applied"), "{report}");
    assert!(
        report.contains("applied: the store reports this input applied to a turn"),
        "{report}"
    );
    assert!(applied.unconfirmed().is_none(), "{report}");

    let rejected = recorded_submission(WorkInputState::Rejected);
    let report = rejected.report();
    assert!(report.contains("rejected: the store reports"), "{report}");
    assert!(!report.contains("applied"), "{report}");

    let unknown = recorded_submission(WorkInputState::NeedsReconciliation);
    let report = unknown.report();
    assert!(
        report.contains("outcome unknown, re-read with `/work observation`"),
        "{report}"
    );
    assert!(!report.contains("applied"), "{report}");
    assert!(unknown.unconfirmed().is_some());
}

#[test]
fn work_input_parses_only_the_input_verb() {
    assert_eq!(requirement_text("input"), Some(""));
    assert_eq!(
        requirement_text("input add the check"),
        Some("add the check")
    );
    assert_eq!(requirement_text("input   spaced"), Some("spaced"));
    for other in [
        "",
        "observation",
        "pause",
        "resume",
        "stop",
        "status",
        "inputs add",
        "input-add",
        "INPUT add",
    ] {
        assert_eq!(requirement_text(other), None, "{other}");
    }
}

#[test]
fn work_input_without_bound_work_creates_nothing() {
    let fixture = Fixture::new();
    let mut app = crate::ReplApp::default();

    run("orphan requirement", &mut app, &fixture.engine);
    let notice = &app.messages.last().expect("notice").text;
    assert!(notice.contains("not submitted"), "{notice}");
    assert!(notice.contains("No continuous work is bound"), "{notice}");
    assert!(!notice.contains("recorded"), "{notice}");
    // A refusal is not an unknown outcome, so nothing is blocked.
    assert!(app.work_input.unconfirmed().is_none());
    assert!(
        matches!(
            ContinuousWorkStore::open_existing(fixture.profile.path()),
            Ok(None)
        ),
        "a requirement must not create work storage"
    );
}
