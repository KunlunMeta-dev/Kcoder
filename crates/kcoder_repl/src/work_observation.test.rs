//! Read-only status projection regressions for target-side continuous work.
use super::{WorkObservation, WorkObservationStatus, WorkObservationTracker, observe};
use crate::test_support::test_engine;
use kcoder_engine::QueryEngine;
use kcoder_state::continuous_work::{ContinuousWorkStore, HostWorkScope, WorkInputSource};
use kcoder_types::TurnAttemptIdentity;
use kcoder_types::continuous_work::{WorkRecord, WorkScope, WorkUsage};
use std::time::{Duration, Instant};

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

    fn admit(&self, work_id: &str, thread_id: &str) {
        let scope = self.scope();
        let store =
            ContinuousWorkStore::open_or_create(self.profile.path()).expect("own test store");
        store
            .admit(
                &scope,
                work_record(&scope, work_id, thread_id),
                &input_source(),
                &format!("request-{work_id}"),
                serde_json::json!({"text": work_id}),
                Vec::new(),
            )
            .expect("own test admission");
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

#[test]
fn stored_record_projects_to_observation_and_status_segment() {
    let fixture = Fixture::new();
    fixture.admit("work-1", &fixture.engine.session_id());

    let status = observe(&fixture.engine);
    let WorkObservationStatus::Observed(observation) = &status else {
        panic!("expected an observed record, got {status:?}");
    };
    assert_eq!(observation.work_id, "work-1");
    assert_eq!(observation.phase, "pending");
    assert_eq!(observation.revision, 1);
    assert_eq!(observation.requirements_revision, 1);
    assert_eq!(observation.wait, None);
    // `admit` records one accepted input that was never applied.
    assert_eq!(observation.unconsumed_inputs, Some(1));
    assert_eq!(observation.usage, Some(WorkUsage::default()));
    assert_eq!(status.status_segment().as_deref(), Some("work:pending +1"));
    let detail = status.detail();
    assert!(detail.contains("not proof of completion"), "{detail}");
    assert!(detail.contains("phase: pending"), "{detail}");
}

#[test]
fn stored_record_reaches_the_compact_status_line() {
    let fixture = Fixture::new();
    fixture.admit("work-1", &fixture.engine.session_id());

    let mut app = crate::ReplApp::default();
    app.refresh_engine_metadata(&fixture.engine);
    assert!(
        app.compact_status_label().contains("work:pending +1"),
        "{}",
        app.compact_status_label()
    );
}

#[test]
fn absent_store_hides_the_segment_and_creates_nothing() {
    let fixture = Fixture::new();

    let status = observe(&fixture.engine);
    assert_eq!(status, WorkObservationStatus::Absent);
    assert_eq!(status.status_segment(), None);
    assert!(
        matches!(
            ContinuousWorkStore::open_existing(fixture.profile.path()),
            Ok(None)
        ),
        "observation must not create work storage"
    );

    let mut app = crate::ReplApp::default();
    app.refresh_engine_metadata(&fixture.engine);
    assert!(
        !app.compact_status_label().contains("work:"),
        "{}",
        app.compact_status_label()
    );
}

#[test]
fn unreadable_store_reports_unknown_instead_of_a_phase() {
    let fixture = Fixture::new();
    fixture.admit("work-1", &fixture.engine.session_id());
    // A store another process left unparsable must stay untouched.
    std::fs::write(fixture.state_path(), b"{ not json").expect("corrupt own store");

    let status = observe(&fixture.engine);
    assert_eq!(status, WorkObservationStatus::Unavailable);
    assert_eq!(status.status_segment().as_deref(), Some("work:unknown"));
    let detail = status.detail();
    assert!(detail.contains("phase is unknown"), "{detail}");
    assert!(detail.contains("not proof of completion"), "{detail}");
    assert_eq!(
        std::fs::read(fixture.state_path()).expect("read own store"),
        b"{ not json"
    );

    let mut app = crate::ReplApp::default();
    app.refresh_engine_metadata(&fixture.engine);
    assert!(
        app.compact_status_label().contains("work:unknown"),
        "{}",
        app.compact_status_label()
    );
}

#[test]
fn work_bound_to_another_session_or_workspace_is_not_shown() {
    let fixture = Fixture::new();
    // Same workspace, different thread.
    fixture.admit("work-other-session", "session-other");
    // Same session, different workspace.
    let other_workspace = private_temp();
    let other_scope = HostWorkScope::capture(fixture.profile.path(), other_workspace.path(), None)
        .expect("private test scope")
        .scope()
        .clone();
    let store =
        ContinuousWorkStore::open_or_create(fixture.profile.path()).expect("own test store");
    store
        .admit(
            &other_scope,
            work_record(
                &other_scope,
                "work-other-workspace",
                &fixture.engine.session_id(),
            ),
            &input_source(),
            "request-other-workspace",
            serde_json::json!({"text": "elsewhere"}),
            Vec::new(),
        )
        .expect("own test admission");
    drop(store);

    assert_eq!(observe(&fixture.engine), WorkObservationStatus::Absent);
}

#[test]
fn status_segment_hides_zero_pending_and_names_unknown_phases() {
    let base = WorkObservation {
        work_id: "work-1".into(),
        phase: "waiting_user".into(),
        revision: 3,
        requirements_revision: 2,
        wait: Some("user (message-1)".into()),
        unconsumed_inputs: Some(0),
        usage: None,
    };
    assert_eq!(base.status_segment(), "work:waiting-user");

    let paused = WorkObservation {
        phase: "paused".into(),
        unconsumed_inputs: Some(2),
        ..base.clone()
    };
    assert_eq!(paused.status_segment(), "work:paused +2");

    let future = WorkObservation {
        phase: "future_phase".into(),
        ..base.clone()
    };
    assert_eq!(future.status_segment(), "work:unknown");

    let running = WorkObservation {
        phase: "running".into(),
        unconsumed_inputs: None,
        ..base
    };
    assert_eq!(running.status_segment(), "work:running");
}

#[test]
fn tracker_throttles_metadata_refreshes_but_forces_explicit_reads() {
    let fixture = Fixture::new();
    let mut tracker = WorkObservationTracker::default();
    tracker.refresh(&fixture.engine);
    assert_eq!(tracker.status(), &WorkObservationStatus::Absent);
    let first_read = tracker.last_read.expect("first refresh reads");

    // A later metadata refresh inside the interval reuses the snapshot.
    tracker.refresh(&fixture.engine);
    assert_eq!(tracker.last_read, Some(first_read));

    // The explicit command always reads, so newly bound work appears at once.
    fixture.admit("work-1", &fixture.engine.session_id());
    tracker.observe_now(&fixture.engine);
    assert_eq!(tracker.status_segment().as_deref(), Some("work:pending +1"));
    assert!(
        tracker
            .last_read
            .is_some_and(|at| Instant::now().saturating_duration_since(at) < Duration::from_secs(5))
    );
}

#[test]
fn missing_profile_directory_stays_absent() {
    let workspace = private_temp();
    let settings_parent = workspace.path().join("no-profile");
    let engine = test_engine(workspace.path())
        .with_settings_persistence_path(settings_parent.join("settings.json"));

    assert_eq!(observe(&engine), WorkObservationStatus::Absent);
    assert!(!settings_parent.exists());
}
