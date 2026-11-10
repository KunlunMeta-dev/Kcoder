//! Regressions for durable pause/resume/stop submission from the terminal.
use super::{
    ControlOutcome, ControlSubmission, action, refusal_report, run, submit, submit_resolved,
};
use crate::test_support::test_engine;
use crate::work_observation::{WorkTarget, open_target};
use kcoder_engine::QueryEngine;
use kcoder_state::continuous_work::{ContinuousWorkStore, HostWorkScope, WorkInputSource};
use kcoder_types::MessageRole;
use kcoder_types::TurnAttemptIdentity;
use kcoder_types::continuous_work::{
    WorkControlAction, WorkControlReceipt, WorkControlState, WorkControlTarget, WorkIdentity,
    WorkRecord, WorkScope,
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

    /// Admit one native work record. Only `pending` is a valid initial phase,
    /// so a later `paused` phase has to come from a settled pause.
    fn admit(&self, work_id: &str) {
        let scope = self.scope();
        let store =
            ContinuousWorkStore::open_or_create(self.profile.path()).expect("own test store");
        store
            .admit(
                &scope,
                work_record(&scope, work_id, &self.engine.session_id()),
                &input_source(),
                &format!("request-{work_id}"),
                serde_json::json!({"text": work_id}),
                Vec::new(),
            )
            .expect("own test admission");
    }

    /// A host-side pause that actually settles, so the stored phase becomes
    /// `paused`. Only a bound host may do this; the terminal never settles.
    fn host_pause(&self, work_id: &str) {
        let store = self.store();
        let scope = self.scope();
        let receipt = store
            .control(
                &scope,
                work_id,
                self.work(work_id).revision.revision,
                "host-pause-1",
                WorkControlAction::Pause,
                WorkControlTarget::Work {},
            )
            .expect("host pause control");
        store
            .settle_control(
                &scope,
                work_id,
                &receipt.request_id,
                receipt.control_epoch,
                WorkControlState::Settled,
            )
            .expect("host pause settlement");
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

    fn control(&self, work_id: &str) -> Option<WorkControlReceipt> {
        self.store()
            .current_control(&self.scope(), work_id)
            .expect("own test control read")
    }

    fn state_path(&self) -> std::path::PathBuf {
        self.profile.path().join("continuous-work.v1/state.json")
    }
}

fn input_source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "test-instance".into(),
        conversation_id: "test-conversation".into(),
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

fn receipt(state: WorkControlState) -> WorkControlReceipt {
    WorkControlReceipt {
        work: WorkIdentity {
            scope: WorkScope {
                account_id: "account-1".into(),
                target_id: "target-1".into(),
                workspace_id: "workspace-1".into(),
            },
            work_id: "work-1".into(),
        },
        request_id: "tui-request-1".into(),
        action: WorkControlAction::Pause,
        target: WorkControlTarget::Work {}.into(),
        expected_revision: 1,
        control_epoch: 2,
        state,
    }
}

fn submitted(action: WorkControlAction, receipt: WorkControlReceipt) -> ControlSubmission {
    ControlSubmission {
        action,
        outcome: ControlOutcome::Recorded {
            work_id: "work-1".into(),
            receipt: Box::new(receipt),
        },
    }
}

#[test]
fn work_control_pause_resume_and_stop_each_record_one_request() {
    for (host_paused, action, label) in [
        (false, WorkControlAction::Pause, "pause"),
        (true, WorkControlAction::Resume, "resume"),
        (false, WorkControlAction::Stop, "stop"),
    ] {
        let fixture = Fixture::new();
        fixture.admit("work-1");
        if host_paused {
            fixture.host_pause("work-1");
            assert_eq!(fixture.work("work-1").phase.as_str(), "paused", "{label}");
        }
        let observed = fixture.work("work-1").revision.revision;
        let before = fixture.control("work-1");

        let submission = submit(&fixture.engine, action.clone());
        let ControlOutcome::Recorded { work_id, receipt } = &submission.outcome else {
            panic!(
                "expected a recorded {label} control, got {:?}",
                submission.outcome
            );
        };
        assert_eq!(work_id, "work-1", "{label}");
        assert_eq!(receipt.action, action, "{label}");
        assert_eq!(receipt.state, WorkControlState::Accepted, "{label}");
        // The fence is the freshly observed revision, not a cached segment.
        assert_eq!(receipt.expected_revision, observed, "{label}");
        assert!(
            receipt.request_id.starts_with("tui-") && !receipt.request_id.contains(' '),
            "{}",
            receipt.request_id
        );

        // Exactly one record: the revision advanced once and the pending control
        // is the request the receipt reports.
        assert_eq!(
            fixture.work("work-1").revision.revision,
            observed + 1,
            "{label}"
        );
        let pending = fixture.control("work-1").expect("one pending control");
        assert_eq!(pending.request_id, receipt.request_id, "{label}");
        assert_eq!(pending.expected_revision, observed, "{label}");
        assert_ne!(before.as_ref(), Some(&pending), "{label}");
        assert_eq!(
            fixture
                .store()
                .read_control(&fixture.scope(), "work-1", &receipt.request_id)
                .expect("own test operation read"),
            Some(pending),
            "{label}"
        );

        let report = submission.report();
        assert!(report.contains("recorded"), "{report}");
        assert!(report.contains("receipt state: accepted"), "{report}");
        assert!(
            report.contains("submitted, waiting for settlement"),
            "{report}"
        );
        // A stored acceptance is not settlement.
        assert!(!report.contains("settled"), "{report}");
    }
}

#[test]
fn work_control_second_pause_is_refused_by_the_pending_fence_and_writes_nothing() {
    let fixture = Fixture::new();
    fixture.admit("work-1");

    let first = submit(&fixture.engine, WorkControlAction::Pause);
    assert!(matches!(first.outcome, ControlOutcome::Recorded { .. }));
    let recorded = fixture.work("work-1").revision.revision;
    let pending = fixture.control("work-1").expect("one pending control");

    // The observed revision is current, so the store's pending fence refuses the
    // duplicate instead of recording a second request.
    let second = submit(&fixture.engine, WorkControlAction::Pause);
    let ControlOutcome::Rejected { code, stale, .. } = &second.outcome else {
        panic!("expected a rejected duplicate, got {:?}", second.outcome);
    };
    assert_eq!(code, "CONTINUOUS_WORK_CONTROL_PENDING");
    assert!(!stale);
    assert!(second.report().contains("rejected"), "{}", second.report());
    assert_eq!(fixture.work("work-1").revision.revision, recorded);
    assert_eq!(fixture.control("work-1"), Some(pending));
}

#[test]
fn work_control_stale_revision_reports_the_conflict_and_writes_nothing() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    let observed = fixture.work("work-1").revision.revision;

    // Another writer advances the work between this terminal's read and write.
    fixture
        .store()
        .control(
            &fixture.scope(),
            "work-1",
            observed,
            "host-request-1",
            WorkControlAction::Pause,
            WorkControlTarget::Work {},
        )
        .expect("host control");
    let advanced = fixture.work("work-1").revision.revision;
    assert_eq!(advanced, observed + 1);
    let host_control = fixture.control("work-1").expect("host pending control");

    let WorkTarget::Ready(target) = open_target(&fixture.engine) else {
        panic!("expected an opened target store");
    };
    let outcome = submit_resolved(
        &target,
        &fixture.engine,
        "work-1",
        observed,
        WorkControlAction::Pause,
    );
    let ControlOutcome::Rejected {
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

    let report = ControlSubmission {
        action: WorkControlAction::Pause,
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

    // Nothing was written and the earlier control still holds the fence.
    assert_eq!(fixture.work("work-1").revision.revision, advanced);
    assert_eq!(fixture.control("work-1"), Some(host_control));
}

#[test]
fn work_control_unknown_outcome_blocks_another_submission_until_a_fresh_read() {
    let fixture = Fixture::new();
    fixture.admit("work-1");
    // A store another process left unparsable must stay untouched.
    std::fs::write(fixture.state_path(), b"{ not json").expect("corrupt own store");
    let mut app = crate::ReplApp::default();

    run(WorkControlAction::Pause, &mut app, &fixture.engine);
    let first = &app.messages.last().expect("first notice").text;
    assert_eq!(app.messages.last().unwrap().role, MessageRole::System);
    assert!(first.contains("not submitted"), "{first}");
    assert!(
        first.contains("outcome unknown, re-read with `/work observation`"),
        "{first}"
    );
    assert!(!first.contains("settled"), "{first}");
    assert!(!first.contains("recorded"), "{first}");
    assert_eq!(
        std::fs::read(fixture.state_path()).expect("read own store"),
        b"{ not json"
    );
    assert!(app.work_control.unconfirmed().is_some());

    run(WorkControlAction::Pause, &mut app, &fixture.engine);
    let refused = &app.messages.last().expect("refusal notice").text;
    assert!(refused.contains("refused"), "{refused}");
    assert!(
        refused.contains("outcome unknown, re-read with `/work observation`"),
        "{refused}"
    );
    assert!(!refused.contains("not submitted"), "{refused}");

    let unconfirmed = app.work_control.unconfirmed().expect("still blocked");
    assert_eq!(unconfirmed.action, WorkControlAction::Pause);
    assert!(refusal_report(WorkControlAction::Stop, unconfirmed).contains("refused"));

    // Only an explicit re-read of the store releases the gate.
    app.work_control.note_observation();
    assert!(app.work_control.unconfirmed().is_none());
    run(WorkControlAction::Stop, &mut app, &fixture.engine);
    let attempted = &app.messages.last().expect("second attempt").text;
    assert!(!attempted.contains("refused"), "{attempted}");
    assert!(attempted.contains("not submitted"), "{attempted}");
}

#[test]
fn work_control_without_bound_work_creates_nothing() {
    let fixture = Fixture::new();
    let mut app = crate::ReplApp::default();

    run(WorkControlAction::Resume, &mut app, &fixture.engine);
    let notice = &app.messages.last().expect("notice").text;
    assert!(notice.contains("not submitted"), "{notice}");
    assert!(notice.contains("No continuous work is bound"), "{notice}");
    assert!(!notice.contains("settled"), "{notice}");
    // A refusal is not an unknown outcome, so nothing is blocked.
    assert!(app.work_control.unconfirmed().is_none());
    assert!(
        matches!(
            ContinuousWorkStore::open_existing(fixture.profile.path()),
            Ok(None)
        ),
        "a control must not create work storage"
    );
}

#[test]
fn work_control_report_never_claims_settlement_for_a_pending_receipt() {
    for state in [WorkControlState::Accepted, WorkControlState::Settling] {
        let submission = submitted(WorkControlAction::Pause, receipt(state.clone()));
        let report = submission.report();
        assert!(
            report.contains(&format!("receipt state: {}", state.as_str())),
            "{report}"
        );
        assert!(
            report.contains("submitted, waiting for settlement"),
            "{report}"
        );
        assert!(!report.contains("settled"), "{report}");
        // A pending receipt waits for the host; it does not block a later
        // submission the way an unknown outcome does.
        assert!(submission.unconfirmed().is_none(), "{report}");
    }

    let unknown = submitted(
        WorkControlAction::Pause,
        receipt(WorkControlState::NeedsReconciliation),
    );
    let report = unknown.report();
    assert!(
        report.contains("receipt state: needs_reconciliation"),
        "{report}"
    );
    assert!(
        report.contains("outcome unknown, re-read with `/work observation`"),
        "{report}"
    );
    assert!(unknown.unconfirmed().is_some());

    let settled = submitted(WorkControlAction::Pause, receipt(WorkControlState::Settled));
    let report = settled.report();
    assert!(report.contains("receipt state: settled"), "{report}");
    assert!(report.contains("settled:"), "{report}");
}

#[test]
fn work_control_parses_only_the_three_control_verbs() {
    assert_eq!(action("pause"), Some(WorkControlAction::Pause));
    assert_eq!(action("resume"), Some(WorkControlAction::Resume));
    assert_eq!(action("stop"), Some(WorkControlAction::Stop));
    for other in ["", "observation", "status", "pause now", "PAUSE"] {
        assert_eq!(action(other), None, "{other}");
    }
}
