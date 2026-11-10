use super::*;
use anyhow::Result;
#[cfg(any(target_os = "linux", windows))]
use kcoder_types::continuous_work::WorkInputKind;
use kcoder_types::{
    TurnAttemptIdentity,
    continuous_work::{
        WorkControlAction, WorkControlState, WorkControlTarget, WorkRecord, WorkScope,
    },
};
use serde_json::{Value, json};
use std::fs;

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

fn scope(account: &str) -> WorkScope {
    WorkScope {
        account_id: account.into(),
        target_id: "owned-target".into(),
        workspace_id: "owned-workspace".into(),
    }
}

fn work(scope: &WorkScope, id: &str, thread: &str) -> WorkRecord {
    let attempt = TurnAttemptIdentity {
        thread_id: thread.into(),
        turn_id: format!("turn-{thread}"),
        attempt_id: format!("attempt-{thread}"),
    };
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": id},
        "origin": {"kind": "foreground", "initialAttempt": attempt},
        "linkedThreadIds": [thread],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0,
            "ownerEpoch": 0, "acceptedInputSequence": 1, "requiredInputSequence": 1,
            "appliedInputSequence": 0}
    }))
    .unwrap()
}

fn corrupt_one_work(profile: &std::path::Path) -> Result<()> {
    let path = profile.join("continuous-work.v1/state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let records = state["works"].as_object_mut().unwrap();
    let broken = records
        .values_mut()
        .find(|entry| entry["record"]["identity"]["workId"] == "work-a")
        .unwrap();
    broken["record"]["revision"]["revision"] = json!(0);
    fs::write(path, serde_json::to_vec(&state)?)?;
    Ok(())
}

#[test]
fn unrelated_valid_binding_remains_readable_when_one_record_is_corrupt() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    for (id, thread) in [("work-a", "thread-a"), ("work-b", "thread-b")] {
        store.admit(
            &scope,
            work(&scope, id, thread),
            &source,
            id,
            json!({"text":id}),
            vec![],
        )?;
    }
    drop(store);
    corrupt_one_work(temp.path())?;
    let path = temp.path().join("continuous-work.v1/state.json");
    let before = fs::read(&path)?;
    assert!(ContinuousWorkStore::open_existing(temp.path()).is_err());
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &scope, "thread-b"),
        StoredBindingObservation::Partial(vec![work(&scope, "work-b", "thread-b").identity])
    );
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-b", "thread-b"),
        StoredBindingLookup::ObservedPartial
    );
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-a"),
        StoredBindingLookup::Unavailable
    );
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &scope, "thread-a"),
        StoredBindingObservation::Partial(vec![])
    );
    assert_eq!(fs::read(path)?, before);
    Ok(())
}

#[test]
fn healthy_bindings_are_scoped_and_missing_storage_is_not_created() -> Result<()> {
    let temp = private_temp();
    let missing = temp.path().join("missing");
    let first = scope("account-a");
    let second = scope("account-b");
    assert_eq!(
        observe_stored_work_bindings(&missing, &first, "shared-thread"),
        StoredBindingObservation::Unavailable
    );
    assert_eq!(
        observe_stored_work_binding(&missing, &first, &"x".repeat(129), "shared-thread"),
        StoredBindingLookup::Unavailable
    );
    assert!(!missing.exists());
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    for (scope, id) in [(&first, "work-a"), (&second, "work-b")] {
        store.admit(
            scope,
            work(scope, id, "shared-thread"),
            &source,
            id,
            json!({"text":id}),
            vec![],
        )?;
    }
    drop(store);
    let state_path = temp.path().join("continuous-work.v1/state.json");
    let before = fs::read(&state_path)?;
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &first, "shared-thread"),
        StoredBindingObservation::Complete(vec![work(&first, "work-a", "shared-thread").identity])
    );
    assert_eq!(
        observe_stored_work_binding(temp.path(), &first, "work-b", "shared-thread"),
        StoredBindingLookup::Absent
    );
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &second, "shared-thread"),
        StoredBindingObservation::Complete(vec![work(&second, "work-b", "shared-thread").identity])
    );
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &first, "old-thread"),
        StoredBindingObservation::Complete(vec![])
    );
    assert_eq!(fs::read(state_path)?, before);
    Ok(())
}

#[test]
fn corrupted_foreign_work_never_leaks_its_identity_into_another_scope() -> Result<()> {
    let temp = private_temp();
    let first = scope("account-a");
    let second = scope("account-b");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    for (scope, id) in [(&first, "work-a"), (&second, "work-b")] {
        store.admit(
            scope,
            work(scope, id, "shared-thread"),
            &source,
            id,
            json!({"text":id}),
            vec![],
        )?;
    }
    drop(store);
    corrupt_one_work(temp.path())?;
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &first, "shared-thread"),
        StoredBindingObservation::Partial(vec![])
    );
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &second, "shared-thread"),
        StoredBindingObservation::Partial(vec![work(&second, "work-b", "shared-thread").identity])
    );
    assert_eq!(
        observe_stored_work_binding(temp.path(), &first, "work-a", "shared-thread"),
        StoredBindingLookup::Unavailable
    );
    Ok(())
}

#[test]
fn malformed_related_input_or_unknown_transaction_never_proves_a_binding() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    for (id, thread) in [("work-a", "thread-a"), ("work-b", "thread-b")] {
        store.admit(
            &scope,
            work(&scope, id, thread),
            &source,
            id,
            json!({"text":id}),
            vec![],
        )?;
    }
    drop(store);
    corrupt_one_work(temp.path())?;
    let path = temp.path().join("continuous-work.v1/state.json");
    let original: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let mut corrupt = original.clone();
    let target = corrupt["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|entry| entry["receipt"]["work"]["workId"] == "work-b")
        .unwrap();
    target["receipt"]["sequence"] = json!(0);
    fs::write(&path, serde_json::to_vec(&corrupt)?)?;
    let before = fs::read(&path)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-b", "thread-b"),
        StoredBindingLookup::Unavailable
    );
    assert_eq!(fs::read(&path)?, before);

    let mut unknown_input = original.clone();
    let broken_input = unknown_input["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|entry| entry["receipt"]["work"]["workId"] == "work-a")
        .unwrap();
    broken_input["receipt"]["kind"] = json!("future_input_kind");
    fs::write(&path, serde_json::to_vec(&unknown_input)?)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-b", "thread-b"),
        StoredBindingLookup::Unavailable
    );

    let mut unknown_work = original.clone();
    let broken_work = unknown_work["works"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|entry| entry["record"]["identity"]["workId"] == "work-a")
        .unwrap();
    broken_work["record"]["futureBindingRule"] = json!({"unknown":true});
    fs::write(&path, serde_json::to_vec(&unknown_work)?)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-b", "thread-b"),
        StoredBindingLookup::Unavailable
    );

    let mut bad_removed_operation = original.clone();
    let first_key = bad_removed_operation["inputs"]
        .as_object()
        .unwrap()
        .iter()
        .find(|(_, entry)| entry["receipt"]["work"]["workId"] == "work-a")
        .map(|(key, _)| key.clone())
        .unwrap();
    let operation = bad_removed_operation["operations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|entry| entry["kind"] == "input" && entry["inputKey"] == first_key)
        .unwrap();
    operation["digest"] = json!("0".repeat(64));
    fs::write(&path, serde_json::to_vec(&bad_removed_operation)?)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-b", "thread-b"),
        StoredBindingLookup::Unavailable
    );

    let mut unknown = original.clone();
    unknown["futureTransaction"] = json!({"newSemantics":true});
    fs::write(&path, serde_json::to_vec(&unknown)?)?;
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &scope, "thread-b"),
        StoredBindingObservation::Unavailable
    );
    let mut pending = original;
    pending["pendingPublications"] = json!({"unresolved":{"unknown":true}});
    fs::write(&path, serde_json::to_vec(&pending)?)?;
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &scope, "thread-b"),
        StoredBindingObservation::Unavailable
    );
    Ok(())
}

#[test]
fn initial_attempt_or_binding_operation_mismatch_is_unavailable() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let admitted = store.admit(
        &scope,
        work(&scope, "work-a", "thread-a"),
        &source,
        "original",
        json!({"text":"owned"}),
        vec![],
    )?;
    let revision = match admitted {
        InitialAdmission::Accepted(value) | InitialAdmission::Existing(value) => {
            value.work.revision.revision
        }
    };
    let second = TurnAttemptIdentity {
        thread_id: "thread-b".into(),
        turn_id: "turn-b".into(),
        attempt_id: "attempt-b".into(),
    };
    store.bind_thread(&scope, "work-a", revision, "bind-second", second)?;
    drop(store);
    let path = temp.path().join("continuous-work.v1/state.json");
    let original: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let mut wrong_initial = original.clone();
    let entry = wrong_initial["works"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    entry["bindings"]["thread-a"]["attemptId"] = json!("different-attempt");
    fs::write(&path, serde_json::to_vec(&wrong_initial)?)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-a"),
        StoredBindingLookup::Unavailable
    );

    let mut missing_operation = original;
    missing_operation["operations"]
        .as_object_mut()
        .unwrap()
        .retain(|_, value| value["kind"] != "binding");
    fs::write(&path, serde_json::to_vec(&missing_operation)?)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-b"),
        StoredBindingLookup::Unavailable
    );
    Ok(())
}

#[test]
fn valid_second_binding_and_control_remain_readable_but_bad_digest_does_not() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let admitted = store.admit(
        &scope,
        work(&scope, "work-a", "thread-a"),
        &source,
        "original",
        json!({"text":"owned"}),
        vec![],
    )?;
    let revision = match admitted {
        InitialAdmission::Accepted(value) | InitialAdmission::Existing(value) => {
            value.work.revision.revision
        }
    };
    let second = TurnAttemptIdentity {
        thread_id: "thread-b".into(),
        turn_id: "turn-b".into(),
        attempt_id: "attempt-b".into(),
    };
    let bound = store.bind_thread(&scope, "work-a", revision, "bind-second", second)?;
    let pending = store.control(
        &scope,
        "work-a",
        bound.revision.revision,
        "pause-request",
        WorkControlAction::Pause,
        WorkControlTarget::Work {},
    )?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-b"),
        StoredBindingLookup::Unavailable
    );
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "missing", "thread-b"),
        StoredBindingLookup::Unavailable
    );
    store.settle_control(
        &scope,
        "work-a",
        "pause-request",
        pending.control_epoch,
        WorkControlState::Settled,
    )?;
    drop(store);
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-b"),
        StoredBindingLookup::Observed
    );
    let path = temp.path().join("continuous-work.v1/state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let control = state["operations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|entry| entry["kind"] == "control")
        .unwrap();
    control["digest"] = json!("0".repeat(64));
    fs::write(&path, serde_json::to_vec(&state)?)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-b"),
        StoredBindingLookup::Unavailable
    );
    Ok(())
}

#[test]
fn failed_reconciliation_and_superseded_controls_do_not_prove_absence() -> Result<()> {
    for state in [
        WorkControlState::Failed,
        WorkControlState::NeedsReconciliation,
    ] {
        let temp = private_temp();
        let scope = scope("owned-account");
        let source = WorkInputSource {
            kind: "foreground".into(),
            instance_id: "owned-instance".into(),
            conversation_id: "owned-conversation".into(),
        };
        let store = ContinuousWorkStore::open_or_create(temp.path())?;
        store.admit(
            &scope,
            work(&scope, "work-a", "thread-a"),
            &source,
            "initial",
            json!({"text":"owned"}),
            vec![],
        )?;
        let pending = store.control(
            &scope,
            "work-a",
            1,
            "pause",
            WorkControlAction::Pause,
            WorkControlTarget::Work {},
        )?;
        store.settle_control(&scope, "work-a", "pause", pending.control_epoch, state)?;
        assert_eq!(
            observe_stored_work_binding(temp.path(), &scope, "missing", "thread-a"),
            StoredBindingLookup::Unavailable
        );
    }

    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &scope,
        work(&scope, "work-a", "thread-a"),
        &source,
        "initial",
        json!({"text":"owned"}),
        vec![],
    )?;
    store.control(
        &scope,
        "work-a",
        1,
        "pause",
        WorkControlAction::Pause,
        WorkControlTarget::Work {},
    )?;
    let stop = store.control(
        &scope,
        "work-a",
        2,
        "stop",
        WorkControlAction::Stop,
        WorkControlTarget::Work {},
    )?;
    store.settle_control(
        &scope,
        "work-a",
        "stop",
        stop.control_epoch,
        WorkControlState::Settled,
    )?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "missing", "thread-a"),
        StoredBindingLookup::Unavailable
    );
    Ok(())
}

#[test]
fn actual_legacy_031_binding_is_readable_without_migration_or_payload_reads() -> Result<()> {
    const STATE: &[u8] = include_bytes!("fixtures/legacy_031_state.json");
    let temp = private_temp();
    drop(ContinuousWorkStore::open_or_create(temp.path())?);
    let namespace = temp.path().join("continuous-work.v1");
    let directory = kcoder_config::PrivateDirectory::open_existing(&namespace)?;
    directory.atomic_replace(std::ffi::OsStr::new("state.json"), STATE)?;
    let actual = WorkScope {
        account_id: "a".into(),
        target_id: "t".into(),
        workspace_id: "w".into(),
    };
    let before = fs::read(namespace.join("state.json"))?;
    let mut names_before = fs::read_dir(&namespace)?
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    names_before.sort();
    assert_eq!(
        observe_stored_work_binding(temp.path(), &actual, "legacy-work", "thread"),
        StoredBindingLookup::Observed
    );
    assert_eq!(fs::read(namespace.join("state.json"))?, before);
    let mut names_after = fs::read_dir(&namespace)?
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    names_after.sort();
    assert_eq!(names_before, names_after);
    Ok(())
}

#[test]
fn duplicate_truncated_and_oversized_json_are_unavailable_without_repair() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    drop(ContinuousWorkStore::open_or_create(temp.path())?);
    let path = temp.path().join("continuous-work.v1/state.json");
    for bytes in [
        br#"{"version":1,"version":1,"works":{},"inputs":{},"inputIds":{},"operations":{}}"#
            .to_vec(),
        br#"{"version":1,"works":{"x":{"record":{"id":"a","id":"b"}}},"inputs":{},"inputIds":{},"operations":{}}"#.to_vec(),
        br#"{"version":1,"works":{"#.to_vec(),
        vec![b' '; 8 * 1024 * 1024 + 1],
    ] {
        fs::write(&path, &bytes)?;
        assert_eq!(
            observe_stored_work_bindings(temp.path(), &scope, "thread"),
            StoredBindingObservation::Unavailable
        );
        assert_eq!(fs::read(&path)?, bytes);
    }
    Ok(())
}

#[test]
fn held_namespace_lock_returns_unavailable_without_writes() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    drop(ContinuousWorkStore::open_or_create(temp.path())?);
    let namespace = temp.path().join("continuous-work.v1");
    let header: Value = serde_json::from_slice(&fs::read(namespace.join("owner.json"))?)?;
    let lock = match header.get("profileLock").and_then(Value::as_str) {
        Some(name) => temp.path().join(name).join("store.lock"),
        None => namespace.join("store.lock"),
    };
    let lock = fs::OpenOptions::new().read(true).write(true).open(lock)?;
    fs2::FileExt::lock_exclusive(&lock)?;
    let before = fs::read(namespace.join("state.json"))?;
    let profile = temp.path().to_owned();
    let worker_scope = scope.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = send.send(observe_stored_work_bindings(
            &profile,
            &worker_scope,
            "thread",
        ));
    });
    assert_eq!(
        receive.recv_timeout(std::time::Duration::from_secs(3))?,
        StoredBindingObservation::Unavailable
    );
    worker.join().unwrap();
    fs2::FileExt::unlock(&lock)?;
    assert_eq!(fs::read(namespace.join("state.json"))?, before);
    Ok(())
}

#[test]
fn mismatched_work_key_cannot_be_pruned_as_an_unrelated_corrupt_work() -> Result<()> {
    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    for (id, thread) in [("work-a", "thread-a"), ("work-b", "thread-b")] {
        store.admit(
            &scope,
            work(&scope, id, thread),
            &source,
            id,
            json!({"text":id}),
            vec![],
        )?;
    }
    drop(store);
    let path = temp.path().join("continuous-work.v1/state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let records = state["works"].as_object_mut().unwrap();
    let identity_b = records
        .values()
        .find(|entry| entry["record"]["identity"]["workId"] == "work-b")
        .unwrap()["record"]["identity"]
        .clone();
    let a = records
        .values_mut()
        .find(|entry| entry["record"]["identity"]["workId"] == "work-a")
        .unwrap();
    a["record"]["identity"] = identity_b;
    fs::write(&path, serde_json::to_vec(&state)?)?;
    let before = fs::read(&path)?;
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-b", "thread-b"),
        StoredBindingLookup::Unavailable
    );
    assert_eq!(fs::read(path)?, before);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn valid_pending_publication_cannot_prove_binding_presence_or_absence() -> Result<()> {
    const CHILD: &str = "KCODER_TEST_OWNED_BINDING_PENDING_PROFILE";
    if let Some(profile) = std::env::var_os(CHILD) {
        let scope = scope("owned-account");
        let source = WorkInputSource {
            kind: "foreground".into(),
            instance_id: "owned-instance".into(),
            conversation_id: "owned-conversation".into(),
        };
        let store = ContinuousWorkStore::open_existing(std::path::Path::new(&profile))?.unwrap();
        super::store::crash_after_next_payload_for_test();
        store.accept_input(
            &scope,
            "work-a",
            &source,
            1,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            json!({"text":"owned pending"}),
            Some(vec![]),
        )?;
        panic!("the owned child must terminate after publication");
    }
    let temp = private_temp();
    let scope = scope("owned-account");
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "owned-instance".into(),
        conversation_id: "owned-conversation".into(),
    };
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &scope,
        work(&scope, "work-a", "thread-a"),
        &source,
        "initial",
        json!({"text":"initial"}),
        vec![],
    )?;
    drop(store);
    let child = std::process::Command::new(std::env::current_exe()?)
        .args(["--exact", "continuous_work::isolated_observation_tests::valid_pending_publication_cannot_prove_binding_presence_or_absence", "--nocapture"])
        .env(CHILD, temp.path())
        .output()?;
    assert_eq!(
        child.status.code(),
        Some(93),
        "owned child did not hit the publication failpoint"
    );
    let store = ContinuousWorkStore::open_existing(temp.path())?.expect("valid pending store");
    assert!(
        store
            .read_input_publication_status(&scope, &source, "request-2")?
            .is_some()
    );
    drop(store);
    let path = temp.path().join("continuous-work.v1/state.json");
    let before = fs::read(&path)?;
    let state: Value = serde_json::from_slice(&before)?;
    assert!(!state["pendingPublications"].as_object().unwrap().is_empty());
    assert!(!state["pendingInputIds"].as_object().unwrap().is_empty());
    assert_eq!(
        observe_stored_work_bindings(temp.path(), &scope, "other-thread"),
        StoredBindingObservation::Unavailable
    );
    assert_eq!(
        observe_stored_work_binding(temp.path(), &scope, "work-a", "thread-a"),
        StoredBindingLookup::Unavailable
    );
    assert_eq!(fs::read(path)?, before);
    Ok(())
}
