use super::*;
use anyhow::{Context, Result};
use kcoder_types::{
    TurnAttemptIdentity,
    continuous_work::{
        WorkConfirmationLevel, WorkControlAction, WorkControlState, WorkControlTarget,
        WorkControlTargetFact, WorkDeliveryRequirement, WorkIdentity, WorkInputKind,
        WorkInputState, WorkPhase, WorkRecord, WorkRevision, WorkScope, WorkUsage,
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};

fn scope(account: &str, target: &str, workspace: &str) -> WorkScope {
    WorkScope {
        account_id: account.into(),
        target_id: target.into(),
        workspace_id: workspace.into(),
    }
}

fn source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "studio-local".into(),
        conversation_id: "conversation-a".into(),
    }
}

fn attempt(thread_id: &str) -> TurnAttemptIdentity {
    TurnAttemptIdentity {
        thread_id: thread_id.into(),
        turn_id: format!("turn-{thread_id}"),
        attempt_id: format!("attempt-{thread_id}"),
    }
}

fn initial(scope: &WorkScope, work_id: &str, thread_id: &str) -> WorkRecord {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": work_id},
        "origin": {"kind": "foreground", "initialAttempt": attempt(thread_id)},
        "linkedThreadIds": [thread_id],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1, "controlEpoch": 0, "ownerEpoch": 0,
            "acceptedInputSequence": 1, "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap()
}

fn names(path: &Path) -> Result<Vec<String>> {
    let mut items = fs::read_dir(path)?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>>>()?;
    items.sort();
    Ok(items)
}

#[test]
fn observing_missing_store_and_old_threads_does_not_create_or_modify() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-observe")?;
    let missing_profile = temp.path().join("missing-profile");
    assert!(ContinuousWorkStore::open_existing(&missing_profile)?.is_none());
    fs::write(temp.path().join("other-data"), b"keep me")?;
    let before = names(temp.path())?;
    assert!(ContinuousWorkStore::open_existing(temp.path())?.is_none());
    assert_eq!(names(temp.path())?, before);
    assert_eq!(fs::read(temp.path().join("other-data"))?, b"keep me");

    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let state = temp.path().join("continuous-work.v1/state.json");
    let original = fs::read(&state)?;
    let namespace = temp.path().join("continuous-work.v1");
    let original_names = names(&namespace)?;
    assert!(
        store
            .list_for_thread(&scope("a", "t", "w"), "old-thread")?
            .is_empty()
    );
    assert!(store.read_work(&scope("a", "t", "w"), "missing")?.is_none());
    assert!(
        store
            .list_pending_inputs(&scope("a", "t", "w"), "missing", None)
            .is_err()
    );
    assert!(
        store
            .list_inputs(&scope("a", "t", "w"), "missing", None)
            .is_err()
    );
    assert_eq!(fs::read(&state)?, original);
    assert_eq!(names(&namespace)?, original_names);
    Ok(())
}

#[test]
fn exact_request_replay_scope_isolation_and_explicit_binding() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-admit")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let host = HostWorkScope::capture(temp.path(), temp.path(), None)?;
    let actual = host.scope().clone();
    let other_account = HostWorkScope::capture(
        temp.path(),
        temp.path(),
        Some("43da078c-d4b1-49d6-b41f-e2eaa8f8b312"),
    )?;
    assert_ne!(actual.account_id, other_account.scope().account_id);
    assert_eq!(actual.target_id, other_account.scope().target_id);
    let payload = json!({"text": "原始请求：修复测试", "attachments": ["original-artifact"]});
    let first = store.admit(
        &actual,
        initial(&actual, "work-a", "thread-a"),
        &source(),
        "message-a",
        payload.clone(),
        vec![],
    )?;
    assert!(matches!(first, InitialAdmission::Accepted(_)));
    assert_eq!(
        store.list_for_scope(&actual, None, None, None, None)?.items[0]
            .identity
            .work_id,
        "work-a"
    );
    let replay = store.admit(
        &actual,
        initial(&actual, "different-generated-id", "thread-a"),
        &source(),
        "message-a",
        payload.clone(),
        vec![],
    )?;
    let InitialAdmission::Existing(replayed) = replay else {
        panic!("same request must reuse its receipt")
    };
    assert_eq!(replayed.work.identity.work_id, "work-a");
    assert_eq!(replayed.payload, payload);
    assert!(
        store
            .admit(
                &actual,
                initial(&actual, "work-b", "thread-a"),
                &source(),
                "message-a",
                json!({"text":"different"}),
                vec![]
            )
            .is_err()
    );
    for other in [
        WorkScope {
            account_id: "other-account".into(),
            ..actual.clone()
        },
        WorkScope {
            target_id: "other-target".into(),
            ..actual.clone()
        },
        WorkScope {
            workspace_id: "other-workspace".into(),
            ..actual.clone()
        },
    ] {
        assert!(store.read_work(&other, "work-a")?.is_none());
        assert!(
            store
                .list_for_scope(&other, None, None, None, None)?
                .items
                .is_empty()
        );
        assert!(store.list_for_thread(&other, "thread-a")?.is_empty());
        assert!(
            store
                .bind_thread(&other, "work-a", 1, "bind-other", attempt("thread-b"))
                .is_err()
        );
    }
    assert!(store.list_for_thread(&actual, "thread-b")?.is_empty());
    let bound = store.bind_thread(&actual, "work-a", 1, "bind-b", attempt("thread-b"))?;
    assert_eq!(bound.revision.revision, 2);
    assert_eq!(
        store.list_for_thread(&actual, "thread-b")?[0].work_id,
        "work-a"
    );
    assert_eq!(
        store.bind_thread(&actual, "work-a", 1, "bind-b", attempt("thread-b"))?,
        bound
    );
    let mut conflict = attempt("thread-b");
    conflict.attempt_id = "another-attempt".into();
    assert!(
        store
            .bind_thread(&actual, "work-a", 2, "bind-b-again", conflict)
            .is_err()
    );
    assert_eq!(
        store
            .read_input(&actual, "work-a", &source(), "message-a")?
            .unwrap()
            .1,
        payload
    );
    for index in 0..11 {
        let work_id = format!("work-{index:02}");
        let thread_id = format!("thread-{index:02}");
        let mut work = initial(&actual, &work_id, &thread_id);
        if index == 0 {
            work.presentation = Some(kcoder_types::continuous_work::WorkPresentation {
                title: Some("Annual Report".into()),
                objective_summary: None,
                created_at_ms: Some(10),
                updated_at_ms: Some(20),
            });
        }
        store.admit(
            &actual,
            work,
            &source(),
            &format!("message-{index:02}"),
            json!({"text": "task"}),
            vec![],
        )?;
    }
    let first = store.list_for_scope(&actual, None, None, None, None)?;
    assert_eq!(first.items.len(), 10);
    let second = store.list_for_scope(
        &actual,
        first.next_after_work_id.as_deref(),
        None,
        None,
        None,
    )?;
    assert_eq!(second.items.len(), 2);
    assert!(second.next_after_work_id.is_none());
    host.verify()?;
    assert_eq!(
        store
            .list_for_scope(&actual, None, None, None, Some(""))?
            .items
            .len(),
        10
    );
    assert_eq!(
        store
            .list_for_scope(&actual, None, Some(10), None, Some("report"))?
            .items[0]
            .identity
            .work_id,
        "work-00"
    );
    assert!(
        store
            .list_for_scope(&actual, None, None, Some(&WorkPhase::Running), None)?
            .items
            .is_empty()
    );
    Ok(())
}

#[test]
fn identical_input_and_request_ids_are_scoped_to_target_and_source_instance() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-source-scope")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let first_scope = scope("account", "host-a", "workspace");
    let second_scope = scope("account", "host-b", "workspace");
    let first_source = WorkInputSource {
        kind: "weixin".into(),
        instance_id: "bot-a".into(),
        conversation_id: "chat".into(),
    };
    let second_source = WorkInputSource {
        kind: "weixin".into(),
        instance_id: "bot-b".into(),
        conversation_id: "chat".into(),
    };
    store.admit(
        &first_scope,
        initial(&first_scope, "first", "thread-a"),
        &first_source,
        "message-id",
        json!({"text":"first"}),
        vec![],
    )?;
    store.admit(
        &first_scope,
        initial(&first_scope, "second", "thread-b"),
        &second_source,
        "message-id",
        json!({"text":"second"}),
        vec![],
    )?;
    store.admit(
        &second_scope,
        initial(&second_scope, "first", "thread-c"),
        &first_source,
        "message-id",
        json!({"text":"third"}),
        vec![],
    )?;
    assert_eq!(
        store
            .read_input(&first_scope, "first", &first_source, "message-id")?
            .unwrap()
            .1,
        json!({"text":"first"})
    );
    assert_eq!(
        store
            .read_input(&first_scope, "second", &second_source, "message-id")?
            .unwrap()
            .1,
        json!({"text":"second"})
    );
    assert_eq!(
        store
            .read_input(&second_scope, "first", &first_source, "message-id")?
            .unwrap()
            .1,
        json!({"text":"third"})
    );
    assert!(
        store
            .admit(
                &first_scope,
                initial(&first_scope, "other", "thread-d"),
                &first_source,
                "message-id",
                json!({"text":"changed"}),
                vec![]
            )
            .is_err()
    );
    store.accept_input(
        &first_scope,
        "first",
        &first_source,
        1,
        "follow-up",
        "request-id",
        WorkInputKind::Requirement,
        json!({"text":"source one"}),
        Some(vec![]),
    )?;
    store.accept_input(
        &first_scope,
        "first",
        &second_source,
        2,
        "follow-up",
        "request-id",
        WorkInputKind::Requirement,
        json!({"text":"source two"}),
        Some(vec![]),
    )?;
    assert_eq!(
        store
            .read_input(&first_scope, "first", &first_source, "follow-up")?
            .unwrap()
            .1,
        json!({"text":"source one"})
    );
    assert_eq!(
        store
            .read_input(&first_scope, "first", &second_source, "follow-up")?
            .unwrap()
            .1,
        json!({"text":"source two"})
    );
    assert!(
        store
            .accept_input(
                &first_scope,
                "second",
                &first_source,
                1,
                "follow-up",
                "different-request",
                WorkInputKind::Requirement,
                json!({"text":"source one"}),
                Some(vec![])
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn presentation_and_original_references_survive_binding_without_fake_timestamps() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-original-refs")?;
    let actual = scope("a", "t", "w");
    let mut work = initial(&actual, "work", "thread-a");
    work.presentation = Some(serde_json::from_value(
        json!({"title":"原任务", "createdAtMs":1234}),
    )?);
    work.native_refs = serde_json::from_value(json!([
        {"kind":"goal", "threadId":"thread-a", "goalId":"original-goal", "revision":3},
        {"kind":"plan", "planWorkId":"original-plan", "revision":4, "planSha256":"a".repeat(64)}
    ]))?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        work.clone(),
        &source(),
        "request",
        json!({"text":"continue original work"}),
        vec![],
    )?;
    store.bind_thread(&actual, "work", 1, "bind", attempt("thread-b"))?;
    let observed = store.read_work(&actual, "work")?.unwrap();
    assert_eq!(observed.presentation, work.presentation);
    assert_eq!(observed.native_refs, work.native_refs);
    assert_eq!(observed.presentation.unwrap().updated_at_ms, None);
    assert!(!temp.path().join(".kcoder/orchestrate").exists());
    drop(store);
    assert_eq!(
        ContinuousWorkStore::open_existing(temp.path())?
            .unwrap()
            .read_work(&actual, "work")?
            .unwrap()
            .native_refs,
        work.native_refs
    );
    Ok(())
}

#[test]
fn requirements_and_controls_fence_old_claims_without_losing_inputs() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-fence")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    store.admit(
        &actual,
        initial(&actual, "work", "thread-a"),
        &source(),
        "request-1",
        json!({"text":"initial"}),
        vec![],
    )?;
    let ClaimOutcome::Acquired(claim) = store.claim(
        &actual,
        "work",
        1,
        0,
        "claim-1",
        "thread-a",
        ClaimTrigger::Input,
    )?
    else {
        panic!("new claim must be acquired")
    };
    assert_eq!(claim.owner_epoch, 1);
    assert!(matches!(
        store.claim(
            &actual,
            "work",
            1,
            0,
            "claim-1",
            "thread-a",
            ClaimTrigger::Input
        )?,
        ClaimOutcome::ExistingActive(_)
    ));
    let first_apply = AppliedInputReference {
        attempt: attempt("thread-a"),
        history_uuid: "history-1".into(),
    };
    store.mark_input_applied(
        &actual,
        "work",
        &source(),
        "request-1",
        "claim-1",
        1,
        0,
        first_apply,
    )?;
    let bound = store.bind_thread(&actual, "work", 3, "bind-b", attempt("thread-b"))?;
    assert_eq!(bound.revision.revision, 4);
    let added = store.accept_input(
        &actual,
        "work",
        &source(),
        4,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"use Rust"}),
        Some(vec![]),
    )?;
    let InputAdmission::Accepted(ref receipt) = added else {
        panic!("expected accepted input")
    };
    assert_eq!(receipt.sequence, 2);
    let changed = store.read_work(&actual, "work")?.unwrap();
    assert_eq!(
        (
            changed.revision.requirements_revision,
            changed.revision.required_input_sequence,
            changed.revision.applied_input_sequence
        ),
        (2, 2, 1)
    );
    assert!(matches!(
        store.accept_input(
            &actual,
            "work",
            &source(),
            4,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            json!({"text":"use Rust"}),
            Some(vec![])
        )?,
        InputAdmission::Existing(_)
    ));
    assert!(matches!(
        store.accept_input(
            &actual,
            "work",
            &source(),
            4,
            "input-2",
            "reconnected-request",
            WorkInputKind::Requirement,
            json!({"text":"use Rust"}),
            Some(vec![])
        )?,
        InputAdmission::Existing(_)
    ));
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                4,
                "input-2",
                "conflicting-request",
                WorkInputKind::Requirement,
                json!({"text":"different"}),
                Some(vec![])
            )
            .is_err()
    );
    assert!(
        store
            .accept_input(
                &scope("other", "t", "w"),
                "other-work",
                &source(),
                1,
                "input-2",
                "cross-target",
                WorkInputKind::Requirement,
                json!({"text":"use Rust"}),
                Some(vec![])
            )
            .is_err()
    );
    assert!(
        store
            .claim(
                &actual,
                "work",
                5,
                0,
                "claim-2",
                "thread-b",
                ClaimTrigger::Input
            )
            .is_err()
    );
    let pause = store.control(
        &actual,
        "work",
        5,
        "pause",
        WorkControlAction::Pause,
        WorkControlTarget::Work {},
    )?;
    assert_eq!(pause.control_epoch, 1);
    assert_eq!(
        pause.target,
        WorkControlTargetFact::Known(WorkControlTarget::Work {})
    );
    assert_eq!(
        store.read_control(&actual, "work", "pause")?,
        Some(pause.clone())
    );
    assert_eq!(store.current_control(&actual, "work")?, Some(pause.clone()));
    assert!(
        store
            .control(
                &actual,
                "work",
                5,
                "pause",
                WorkControlAction::Pause,
                WorkControlTarget::Turn {
                    thread_id: "thread-a".into(),
                    turn_id: "turn-thread-a".into(),
                    attempt_id: "attempt-thread-a".into()
                }
            )
            .is_err()
    );
    assert!(
        store
            .settle_control(&actual, "work", "pause", 1, WorkControlState::Settled)
            .is_err()
    );
    let later = AppliedInputReference {
        attempt: attempt("thread-a"),
        history_uuid: "history-2".into(),
    };
    assert!(
        store
            .mark_input_applied(
                &actual,
                "work",
                &source(),
                "input-2",
                "claim-1",
                1,
                0,
                later.clone()
            )
            .is_err()
    );
    store.release_claim(&actual, "work", "claim-1", 1, ClaimSettlement::Abandoned)?;
    assert!(
        store
            .claim(
                &actual,
                "work",
                1,
                0,
                "claim-1",
                "thread-a",
                ClaimTrigger::Input
            )
            .is_err()
    );
    store.settle_control(&actual, "work", "pause", 1, WorkControlState::Settled)?;
    assert_eq!(
        store.read_control(&actual, "work", "pause")?.unwrap().state,
        WorkControlState::Settled
    );
    assert_eq!(
        store.read_work(&actual, "work")?.unwrap().phase,
        WorkPhase::Paused
    );
    assert!(
        store
            .claim(
                &actual,
                "work",
                8,
                1,
                "claim-2",
                "thread-b",
                ClaimTrigger::Input
            )
            .is_err()
    );
    store.control(
        &actual,
        "work",
        8,
        "resume",
        WorkControlAction::Resume,
        WorkControlTarget::Work {},
    )?;
    store.settle_control(&actual, "work", "resume", 2, WorkControlState::Settled)?;
    let ClaimOutcome::Acquired(new_claim) = store.claim(
        &actual,
        "work",
        10,
        2,
        "claim-2",
        "thread-b",
        ClaimTrigger::Input,
    )?
    else {
        panic!("new claim must be acquired")
    };
    assert_eq!(new_claim.owner_epoch, 2);
    let applied = AppliedInputReference {
        attempt: attempt("thread-b"),
        history_uuid: "history-2".into(),
    };
    store.mark_input_applied(
        &actual,
        "work",
        &source(),
        "input-2",
        "claim-2",
        2,
        2,
        applied.clone(),
    )?;
    assert_eq!(
        store
            .mark_input_applied(
                &actual,
                "work",
                &source(),
                "input-2",
                "claim-2",
                2,
                2,
                applied
            )?
            .sequence,
        2
    );
    assert_eq!(
        store
            .read_input(&actual, "work", &source(), "input-2")?
            .unwrap()
            .1,
        json!({"text":"use Rust"})
    );
    let stopped = store.control(
        &actual,
        "work",
        12,
        "stop",
        WorkControlAction::Stop,
        WorkControlTarget::Work {},
    )?;
    assert_eq!(stopped.control_epoch, 3);
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                13,
                "input-3",
                "request-3",
                WorkInputKind::Requirement,
                json!({"text":"continue"}),
                Some(vec![])
            )
            .is_err()
    );
    store.release_claim(&actual, "work", "claim-2", 2, ClaimSettlement::Abandoned)?;
    store.settle_control(&actual, "work", "stop", 3, WorkControlState::Settled)?;
    assert_eq!(
        store.read_work(&actual, "work")?.unwrap().phase,
        WorkPhase::Stopped
    );
    assert!(
        store
            .claim(
                &actual,
                "work",
                15,
                3,
                "claim-3",
                "thread-b",
                ClaimTrigger::Input
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn stop_supersedes_pending_pause_without_claiming_resources_are_settled() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-supersede")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"do work"}),
        vec![],
    )?;
    assert!(matches!(
        store.claim(
            &actual,
            "work",
            1,
            0,
            "claim",
            "thread",
            ClaimTrigger::Input
        )?,
        ClaimOutcome::Acquired(_)
    ));
    store.control(
        &actual,
        "work",
        2,
        "pause",
        WorkControlAction::Pause,
        WorkControlTarget::Work {},
    )?;
    let stop = store.control(
        &actual,
        "work",
        3,
        "stop",
        WorkControlAction::Stop,
        WorkControlTarget::Work {},
    )?;
    assert_eq!(stop.control_epoch, 2);
    assert_eq!(store.current_control(&actual, "work")?, Some(stop));
    assert_eq!(
        store.read_control(&actual, "work", "pause")?.unwrap().state,
        WorkControlState::Superseded
    );
    assert!(
        store
            .settle_control(&actual, "work", "pause", 1, WorkControlState::Settled)
            .is_err()
    );
    assert!(
        store
            .settle_control(&actual, "work", "stop", 2, WorkControlState::Settled)
            .is_err()
    );
    store.release_claim(&actual, "work", "claim", 1, ClaimSettlement::Abandoned)?;
    store.settle_control(&actual, "work", "stop", 2, WorkControlState::Settled)?;
    assert_eq!(
        store.read_work(&actual, "work")?.unwrap().phase,
        WorkPhase::Stopped
    );
    Ok(())
}

#[test]
fn damaged_namespace_is_reported_and_never_reinitialized() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-damaged")?;
    let profile = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    profile.create_private_child(std::ffi::OsStr::new("continuous-work.v1"))?;
    let path = temp.path().join("continuous-work.v1");
    fs::write(path.join("unrelated"), b"preserve")?;
    let before = names(&path)?;
    assert!(ContinuousWorkStore::open_existing(temp.path()).is_err());
    assert!(ContinuousWorkStore::open_or_create(temp.path()).is_err());
    assert_eq!(names(&path)?, before);
    assert_eq!(fs::read(path.join("unrelated"))?, b"preserve");
    Ok(())
}

#[test]
fn future_input_state_is_readable_but_cannot_be_used_to_claim() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-future")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"test"}),
        vec![],
    )?;
    drop(store);
    let state = temp.path().join("continuous-work.v1/state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&state)?)?;
    let input = data["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    input["receipt"]["state"] = "future_input_state".into();
    fs::write(&state, serde_json::to_vec(&data)?)?;
    let original = fs::read(&state)?;
    let store = ContinuousWorkStore::open_existing(temp.path())?.unwrap();
    let observed = store
        .read_input(&actual, "work", &source(), "request")?
        .unwrap();
    assert!(!observed.0.state.is_known());
    let pending = store.list_pending_inputs(&actual, "work", None)?;
    assert_eq!(pending.inputs.len(), 1);
    assert_eq!(pending.inputs[0].source, source());
    assert_eq!(
        pending.inputs[0].receipt.state.as_str(),
        "future_input_state"
    );
    let all = store.list_inputs(&actual, "work", None)?;
    assert_eq!(all.inputs.len(), 1);
    assert_eq!(all.inputs[0].receipt.state.as_str(), "future_input_state");
    assert!(all.inputs[0].applied.is_none());
    assert!(
        store
            .claim(
                &actual,
                "work",
                1,
                0,
                "claim",
                "thread",
                ClaimTrigger::Input
            )
            .is_err()
    );
    assert_eq!(fs::read(&state)?, original);
    Ok(())
}

#[test]
fn unknown_control_target_is_preserved_and_never_authorizes_execution() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-future-control")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"test"}),
        vec![],
    )?;
    assert!(matches!(
        store.claim(
            &actual,
            "work",
            1,
            0,
            "original-claim",
            "thread",
            ClaimTrigger::Input
        )?,
        ClaimOutcome::Acquired(_)
    ));
    store.control(
        &actual,
        "work",
        2,
        "pause",
        WorkControlAction::Pause,
        WorkControlTarget::Work {},
    )?;
    drop(store);
    let path = temp.path().join("continuous-work.v1/state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    let future = json!({"kind":"future_control_target", "nativeId":"opaque-fact"});
    let work = data["works"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    work["pendingControl"]["target"] = future.clone();
    let operation = data["operations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|value| value["kind"] == "control")
        .unwrap();
    operation["receipt"]["target"] = future.clone();
    fs::write(&path, serde_json::to_vec(&data)?)?;
    let before = fs::read(&path)?;
    let store = ContinuousWorkStore::open_existing(temp.path())?.unwrap();
    let control = store.current_control(&actual, "work")?.unwrap();
    assert_eq!(
        control.target,
        WorkControlTargetFact::Unknown(future.clone())
    );
    assert!(
        store
            .control(
                &actual,
                "work",
                3,
                "stop",
                WorkControlAction::Stop,
                WorkControlTarget::Work {}
            )
            .is_err()
    );
    assert!(
        store
            .claim(
                &actual,
                "work",
                3,
                1,
                "claim",
                "thread",
                ClaimTrigger::Input
            )
            .is_err()
    );
    assert_eq!(fs::read(&path)?, before);
    store.release_claim(
        &actual,
        "work",
        "original-claim",
        1,
        ClaimSettlement::Abandoned,
    )?;
    assert!(store.active_claim(&actual, "work")?.is_none());
    assert_eq!(
        store.current_control(&actual, "work")?.unwrap().target,
        WorkControlTargetFact::Unknown(future)
    );
    Ok(())
}

#[test]
fn listing_does_not_read_payloads_and_missing_content_is_not_forged() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-payload-observe")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    let InitialAdmission::Accepted(accepted) = store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"private input marker"}),
        vec![],
    )?
    else {
        panic!("expected admission")
    };
    let directory = temp.path().join("continuous-work.v1");
    assert!(
        !String::from_utf8_lossy(&fs::read(directory.join("state.json"))?)
            .contains("private input marker")
    );
    fs::write(directory.join(&accepted.receipt.payload_ref), b"altered")?;
    drop(store);
    let store = ContinuousWorkStore::open_existing(temp.path())?.unwrap();
    assert_eq!(store.list_for_thread(&actual, "thread")?.len(), 1);
    assert!(
        store
            .read_input(&actual, "work", &source(), "request")
            .is_err()
    );
    assert!(
        store
            .admit(
                &actual,
                initial(&actual, "fresh-id", "thread"),
                &source(),
                "request",
                json!({"text":"private input marker"}),
                vec![]
            )
            .is_err()
    );
    Ok(())
}

#[test]
fn accepted_delivery_requirements_are_persisted_and_part_of_idempotency() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-deliveries")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    let requirement = WorkDeliveryRequirement {
        delivery_id: "send-original-recipient".into(),
        minimum_confirmation: WorkConfirmationLevel::Delivered,
    };
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"generate and send"}),
        vec![requirement.clone()],
    )?;
    assert_eq!(
        store.accepted_deliveries(&actual, "work")?,
        Some(vec![requirement.clone()])
    );
    assert!(
        store
            .admit(
                &actual,
                initial(&actual, "new-id", "thread"),
                &source(),
                "request",
                json!({"text":"generate and send"}),
                vec![]
            )
            .is_err()
    );
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                json!({"text":"keep sending"}),
                None
            )
            .is_err()
    );
    store.accept_input(
        &actual,
        "work",
        &source(),
        1,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"keep sending"}),
        Some(vec![requirement.clone()]),
    )?;
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                1,
                "input-2",
                "another-request",
                WorkInputKind::Requirement,
                json!({"text":"keep sending"}),
                Some(vec![])
            )
            .is_err()
    );
    assert_eq!(
        store.accepted_deliveries(&actual, "work")?,
        Some(vec![requirement])
    );
    Ok(())
}

#[test]
fn tampering_with_delivery_snapshot_never_erases_a_required_send() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-delivery-damage")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let requirement = WorkDeliveryRequirement {
        delivery_id: "send".into(),
        minimum_confirmation: WorkConfirmationLevel::Accepted,
    };
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"send it"}),
        vec![requirement],
    )?;
    drop(store);
    let path = temp.path().join("continuous-work.v1/state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    let work = data["works"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    work["acceptedDeliveries"] = json!([]);
    fs::write(&path, serde_json::to_vec(&data)?)?;
    let before = fs::read(&path)?;
    assert!(ContinuousWorkStore::open_existing(temp.path()).is_err());
    assert!(ContinuousWorkStore::open_or_create(temp.path()).is_err());
    assert_eq!(fs::read(&path)?, before);
    Ok(())
}

#[test]
fn unowned_immutable_payload_is_never_claimed_or_replaced() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-payload-retry")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    let work = initial(&actual, "work", "thread");
    store.admit(
        &actual,
        work.clone(),
        &source(),
        "request-1",
        json!({"text":"first"}),
        vec![],
    )?;
    let pending = json!({"text":"second"});
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&work.identity, &source(), "input-2"))?)
    );
    let object = temp
        .path()
        .join("continuous-work.v1")
        .join(format!("payload-{key}"));
    let expected = serde_json::to_vec(&pending)?;
    fs::write(&object, &expected)?;
    let before = fs::read(temp.path().join("continuous-work.v1/state.json"))?;
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                pending.clone(),
                Some(vec![])
            )
            .is_err()
    );
    assert_eq!(fs::read(&object)?, expected);
    assert!(
        store
            .read_input(&actual, "work", &source(), "input-2")?
            .is_none()
    );
    assert!(
        store
            .read_input_publication_status(&actual, &source(), "request-2")?
            .is_some()
    );
    let persisted = fs::read(temp.path().join("continuous-work.v1/state.json"))?;
    assert_ne!(persisted, before);
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                pending.clone(),
                Some(vec![])
            )
            .unwrap_err()
            .to_string()
            .contains("RECONCILIATION_REQUIRED")
    );
    assert_eq!(fs::read(&object)?, expected);
    assert_eq!(
        fs::read(temp.path().join("continuous-work.v1/state.json"))?,
        persisted
    );

    let other_key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&work.identity, &source(), "input-3"))?)
    );
    let other = temp
        .path()
        .join("continuous-work.v1")
        .join(format!("payload-{other_key}"));
    fs::write(&other, b"preserve an earlier unresolved object")?;
    let before = fs::read(temp.path().join("continuous-work.v1/state.json"))?;
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                2,
                "input-3",
                "request-3",
                WorkInputKind::Requirement,
                json!({"text":"third"}),
                Some(vec![])
            )
            .is_err()
    );
    assert_eq!(fs::read(&other)?, b"preserve an earlier unresolved object");
    assert_eq!(
        fs::read(temp.path().join("continuous-work.v1/state.json"))?,
        before
    );
    Ok(())
}

#[test]
fn actual_031_legacy_inputs_remain_readable_and_replayable() -> Result<()> {
    // These synthetic bytes were emitted by the unmodified 031 store logic,
    // with only an isolated test entry point added to the original crate.
    const STATE: &[u8] = include_bytes!("fixtures/legacy_031_state.json");
    const FIRST: &[u8] = include_bytes!("fixtures/legacy_031_first.json");
    const SECOND: &[u8] = include_bytes!("fixtures/legacy_031_second.json");
    let temp = kcoder_config::create_private_temp_dir("continuous-work-legacy-input")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    drop(store);
    let path = temp.path().join("continuous-work.v1");
    let directory = kcoder_config::PrivateDirectory::open_existing(&path)?;
    directory.atomic_replace(std::ffi::OsStr::new("state.json"), STATE)?;
    directory.atomic_replace(
        std::ffi::OsStr::new(
            "payload-803bb69f0e2bd9e567456563a25d19c02731ff90cc9633f29717d2f558b5916d",
        ),
        FIRST,
    )?;
    directory.atomic_replace(
        std::ffi::OsStr::new(
            "payload-fac2d126de5d4e0727e066c8f243cb12c01f34a5567a822d38bc1c9a71363edf",
        ),
        SECOND,
    )?;
    let before = fs::read(path.join("state.json"))?;
    let store = ContinuousWorkStore::open_existing(temp.path())?.context("legacy store missing")?;
    let actual = scope("a", "t", "w");
    let (first, first_payload) = store
        .read_input(&actual, "legacy-work", &source(), "request-1")?
        .context("legacy first input missing")?;
    let (second, second_payload) = store
        .read_input(&actual, "legacy-work", &source(), "input-2")?
        .context("legacy second input missing")?;
    assert_eq!(first_payload, json!({"text":"legacy first"}));
    assert_eq!(second_payload, json!({"text":"legacy second"}));
    assert_eq!(
        store
            .list_inputs(&actual, "legacy-work", None)?
            .inputs
            .len(),
        2
    );
    let candidate = initial(&actual, "regenerated-work", "thread");
    let InitialAdmission::Existing(replayed) = store.admit(
        &actual,
        candidate,
        &source(),
        "request-1",
        first_payload,
        vec![],
    )?
    else {
        panic!("legacy initial replay must reuse the original receipt");
    };
    assert_eq!(replayed.work.identity.work_id, "legacy-work");
    assert_eq!(replayed.receipt, first);
    assert!(
        matches!(store.accept_input(&actual, "legacy-work", &source(), 1, "input-2", "request-2", WorkInputKind::Requirement, second_payload, Some(vec![]))?, InputAdmission::Existing(receipt) if receipt == second)
    );
    assert_eq!(fs::read(path.join("state.json"))?, before);
    Ok(())
}

fn child_payload_crash_runner(profile: &std::ffi::OsStr) -> Result<()> {
    let store = ContinuousWorkStore::open_existing(Path::new(profile))?.unwrap();
    super::store::crash_after_next_payload_for_test();
    store.accept_input(
        &scope("a", "t", "w"),
        "work",
        &source(),
        1,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"durable exact payload"}),
        Some(vec![]),
    )?;
    panic!("the isolated child should have exited immediately after payload publication")
}

#[test]
fn killed_owner_after_payload_publication_requires_reconciliation() -> Result<()> {
    if let Some(profile) = std::env::var_os("KCODER_TEST_CONTINUOUS_PAYLOAD_CRASH_PROFILE") {
        return child_payload_crash_runner(&profile);
    }
    let temp = kcoder_config::create_private_temp_dir("continuous-work-payload-crash")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request-1",
        json!({"text":"initial"}),
        vec![],
    )?;
    let before = fs::read(temp.path().join("continuous-work.v1/state.json"))?;
    let output = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "continuous_work::tests::killed_owner_after_payload_publication_requires_reconciliation",
            "--nocapture",
        ])
        .env("KCODER_TEST_CONTINUOUS_PAYLOAD_CRASH_PROFILE", temp.path())
        .output()?;
    assert_eq!(
        output.status.code(),
        Some(93),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_ne!(
        fs::read(temp.path().join("continuous-work.v1/state.json"))?,
        before
    );
    assert!(
        store
            .read_input(&actual, "work", &source(), "input-2")?
            .is_none()
    );
    let intent = store
        .read_input_publication_status(&actual, &source(), "request-2")?
        .context("original publication intent missing")?;
    assert_eq!(intent.input_id, "input-2");
    let directory = temp.path().join("continuous-work.v1");
    let identity = WorkIdentity {
        scope: actual.clone(),
        work_id: "work".into(),
    };
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&identity, &source(), "input-2"))?)
    );
    let payload = directory.join(format!("payload-{key}"));
    let published = fs::read(&payload)?;
    let pending = fs::read(directory.join("state.json"))?;
    assert!(
        store
            .accept_input(
                &actual,
                "work",
                &source(),
                1,
                "input-2",
                "request-2",
                WorkInputKind::Requirement,
                json!({"text":"durable exact payload"}),
                Some(vec![])
            )
            .unwrap_err()
            .to_string()
            .contains("RECONCILIATION_REQUIRED")
    );
    assert_eq!(fs::read(&payload)?, published);
    assert_eq!(fs::read(directory.join("state.json"))?, pending);
    assert!(
        store
            .read_input(&actual, "work", &source(), "input-2")?
            .is_none()
    );
    Ok(())
}

fn child_receipt_crash_runner(profile: &std::ffi::OsStr) -> Result<()> {
    let store = ContinuousWorkStore::open_existing(Path::new(profile))?.unwrap();
    super::store::crash_after_next_receipt_for_test();
    store.accept_input(
        &scope("a", "t", "w"),
        "work",
        &source(),
        1,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"committed once"}),
        Some(vec![]),
    )?;
    panic!("the isolated child should have exited before returning the committed receipt")
}

#[test]
fn lost_receipt_after_commit_reuses_original_input() -> Result<()> {
    if let Some(profile) = std::env::var_os("KCODER_TEST_CONTINUOUS_RECEIPT_CRASH_PROFILE") {
        return child_receipt_crash_runner(&profile);
    }
    let temp = kcoder_config::create_private_temp_dir("continuous-work-receipt-crash")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request-1",
        json!({"text":"initial"}),
        vec![],
    )?;
    let output = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "continuous_work::tests::lost_receipt_after_commit_reuses_original_input",
            "--nocapture",
        ])
        .env("KCODER_TEST_CONTINUOUS_RECEIPT_CRASH_PROFILE", temp.path())
        .output()?;
    assert_eq!(
        output.status.code(),
        Some(94),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let (receipt, payload) = store
        .read_input(&actual, "work", &source(), "input-2")?
        .unwrap();
    assert_eq!(receipt.sequence, 2);
    assert_eq!(payload, json!({"text":"committed once"}));
    assert!(matches!(
        store.accept_input(
            &actual,
            "work",
            &source(),
            1,
            "input-2",
            "request-2",
            WorkInputKind::Requirement,
            json!({"text":"committed once"}),
            Some(vec![])
        )?,
        InputAdmission::Existing(_)
    ));
    assert_eq!(
        store
            .read_work(&actual, "work")?
            .unwrap()
            .revision
            .accepted_input_sequence,
        2
    );
    Ok(())
}

#[test]
fn replacement_of_lock_or_profile_invalidates_existing_handle() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-replace")?;
    let profile = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    profile.create_private_child(std::ffi::OsStr::new("profile"))?;
    let profile_path = temp.path().join("profile");
    let store = ContinuousWorkStore::open_or_create(&profile_path)?;
    let header: Value = serde_json::from_slice(&fs::read(
        profile_path.join("continuous-work.v1/owner.json"),
    )?)?;
    let lock_directory = match header.get("profileLock").and_then(Value::as_str) {
        Some(name) => profile_path.join(name),
        None => profile_path.join("continuous-work.v1"),
    };
    let lock = lock_directory.join("store.lock");
    fs::rename(&lock, lock_directory.join("old-lock"))?;
    fs::write(&lock, b"")?;
    assert!(
        store
            .list_for_thread(&scope("a", "t", "w"), "thread")
            .is_err()
    );

    profile.create_private_child(std::ffi::OsStr::new("profile-two"))?;
    let other_path = temp.path().join("profile-two");
    let other = ContinuousWorkStore::open_or_create(&other_path)?;
    let destination = temp.path().join("original-profile-two");
    let original_identity =
        kcoder_config::PrivateDirectory::open_existing(&other_path)?.directory_identity()?;
    let original_data = fs::read(other_path.join("continuous-work.v1/state.json"))?;
    match fs::rename(&other_path, &destination) {
        Ok(()) => {
            let replacement = profile.create_private_child(std::ffi::OsStr::new("profile-two"))?;
            assert_ne!(replacement.directory_identity()?, original_identity);
            assert!(
                other
                    .list_for_thread(&scope("a", "t", "w"), "thread")
                    .is_err()
            );
            assert_eq!(
                kcoder_config::PrivateDirectory::open_existing(&destination)?
                    .directory_identity()?,
                original_identity
            );
            assert_eq!(
                fs::read(destination.join("continuous-work.v1/state.json"))?,
                original_data
            );
        }
        Err(error) => {
            #[cfg(windows)]
            if error.raw_os_error() == Some(5) {
                // Windows may refuse to rename a directory with live open
                // descendants. In this branch no replacement occurred.
                assert!(!destination.exists());
                assert_eq!(
                    kcoder_config::PrivateDirectory::open_existing(&other_path)?
                        .directory_identity()?,
                    original_identity
                );
                assert_eq!(
                    fs::read(other_path.join("continuous-work.v1/state.json"))?,
                    original_data
                );
                assert!(
                    other
                        .list_for_thread(&scope("a", "t", "w"), "thread")?
                        .is_empty()
                );
                eprintln!("Windows denied profile rename while its original files were open");
                return Ok(());
            }
            return Err(error.into());
        }
    }
    Ok(())
}

#[test]
fn profile_namespaces_are_isolated_and_copied_identity_is_not_authority() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-profiles")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    for name in ["first", "second", "copied"] {
        parent.create_private_child(std::ffi::OsStr::new(name))?;
    }
    let first_path = temp.path().join("first");
    let second_path = temp.path().join("second");
    let copied_path = temp.path().join("copied");
    let first = ContinuousWorkStore::open_or_create(&first_path)?;
    let second = ContinuousWorkStore::open_or_create(&second_path)?;
    let same = scope("a", "t", "w");
    first.admit(
        &same,
        initial(&same, "same-id", "thread"),
        &source(),
        "same-request",
        json!({"text":"first profile"}),
        vec![],
    )?;
    second.admit(
        &same,
        initial(&same, "same-id", "thread"),
        &source(),
        "same-request",
        json!({"text":"second profile"}),
        vec![],
    )?;
    assert_eq!(
        first
            .read_input(&same, "same-id", &source(), "same-request")?
            .unwrap()
            .1,
        json!({"text":"first profile"})
    );
    assert_eq!(
        second
            .read_input(&same, "same-id", &source(), "same-request")?
            .unwrap()
            .1,
        json!({"text":"second profile"})
    );
    let copied_profile = kcoder_config::PrivateDirectory::open_existing(&copied_path)?;
    copied_profile.create_private_child(std::ffi::OsStr::new("continuous-work.v1"))?;
    for entry in fs::read_dir(first_path.join("continuous-work.v1"))? {
        let entry = entry?;
        assert!(entry.file_type()?.is_file());
        fs::copy(
            entry.path(),
            copied_path
                .join("continuous-work.v1")
                .join(entry.file_name()),
        )?;
    }
    assert!(ContinuousWorkStore::open_existing(&copied_path).is_err());
    Ok(())
}

#[cfg(unix)]
#[test]
fn trusted_profile_modes_remain_unchanged_and_unsafe_permissions_are_rejected() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let temp = kcoder_config::create_private_temp_dir("continuous-work-profile-mode")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    for (name, mode) in [("owner-public-read", 0o755), ("owner-group-read", 0o750)] {
        parent.create_private_child(std::ffi::OsStr::new(name))?;
        let profile = temp.path().join(name);
        fs::set_permissions(&profile, fs::Permissions::from_mode(mode))?;
        let store = ContinuousWorkStore::open_or_create(&profile)?;
        store.admit(
            &scope("a", "t", "w"),
            initial(&scope("a", "t", "w"), "work", "thread"),
            &source(),
            "request",
            json!({"text":"private"}),
            vec![],
        )?;
        assert_eq!(fs::metadata(&profile)?.permissions().mode() & 0o777, mode);
        let namespace = profile.join("continuous-work.v1");
        assert_eq!(
            fs::metadata(&namespace)?.permissions().mode() & 0o777,
            0o700
        );
        drop(store);
        assert!(ContinuousWorkStore::open_existing(&profile)?.is_some());
        fs::set_permissions(&namespace, fs::Permissions::from_mode(0o755))?;
        assert!(ContinuousWorkStore::open_existing(&profile).is_err());
        assert_eq!(
            fs::metadata(&namespace)?.permissions().mode() & 0o777,
            0o755
        );
    }
    for (name, mode) in [("group-writable", 0o770), ("world-writable", 0o777)] {
        parent.create_private_child(std::ffi::OsStr::new(name))?;
        let profile = temp.path().join(name);
        fs::set_permissions(&profile, fs::Permissions::from_mode(mode))?;
        assert!(ContinuousWorkStore::open_existing(&profile).is_err());
        assert!(ContinuousWorkStore::open_or_create(&profile).is_err());
        assert!(!profile.join("continuous-work.v1").exists());
        assert_eq!(fs::metadata(&profile)?.permissions().mode() & 0o777, mode);
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn profile_owned_by_another_uid_is_rejected_by_the_explicit_identity_check() -> Result<()> {
    // A non-root run cannot create a foreign-owned fixture. This separately
    // exercises a real UID mismatch when CAP_CHOWN is available as root.
    if unsafe { libc::geteuid() } != 0 {
        return Ok(());
    }
    use std::os::unix::ffi::OsStrExt;
    let temp = kcoder_config::create_private_temp_dir("continuous-work-profile-owner")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    parent.create_private_child(std::ffi::OsStr::new("foreign-owner"))?;
    let profile = temp.path().join("foreign-owner");
    let path = std::ffi::CString::new(profile.as_os_str().as_bytes())?;
    let result = unsafe { libc::chown(path.as_ptr(), 65534, u32::MAX) };
    assert_eq!(
        result,
        0,
        "fixture chown failed: {}",
        std::io::Error::last_os_error()
    );
    assert!(ContinuousWorkStore::open_existing(&profile).is_err());
    assert!(ContinuousWorkStore::open_or_create(&profile).is_err());
    assert!(!profile.join("continuous-work.v1").exists());
    assert_eq!(unsafe { libc::chown(path.as_ptr(), 0, u32::MAX) }, 0);
    Ok(())
}

#[cfg(unix)]
#[test]
fn profile_symlinks_and_hardlinked_state_are_rejected_without_changes() -> Result<()> {
    use std::os::unix::fs::symlink;
    let temp = kcoder_config::create_private_temp_dir("continuous-work-links")?;
    let parent = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    parent.create_private_child(std::ffi::OsStr::new("profile"))?;
    let profile = temp.path().join("profile");
    let store = ContinuousWorkStore::open_or_create(&profile)?;
    symlink(&profile, temp.path().join("profile-link"))?;
    assert!(ContinuousWorkStore::open_existing(&temp.path().join("profile-link")).is_err());
    let state = profile.join("continuous-work.v1/state.json");
    let original = fs::read(&state)?;
    fs::hard_link(&state, temp.path().join("state-alias"))?;
    assert!(
        store
            .list_for_thread(&scope("a", "t", "w"), "thread")
            .is_err()
    );
    assert!(ContinuousWorkStore::open_existing(&profile).is_err());
    assert_eq!(fs::read(&state)?, original);
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn non_root_process_can_use_trusted_profile_but_not_other_owners_profile() -> Result<()> {
    use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt, process::CommandExt};
    if let Some(profile) = std::env::var_os("KCODER_TEST_CONTINUOUS_UNPRIV_PROFILE") {
        assert_eq!(unsafe { libc::geteuid() }, 65534);
        let profile = Path::new(&profile);
        let foreign = std::env::var_os("KCODER_TEST_CONTINUOUS_FOREIGN_PROFILE").unwrap();
        assert!(ContinuousWorkStore::open_existing(profile)?.is_none());
        let store = ContinuousWorkStore::open_or_create(profile)?;
        let actual = scope("a", "t", "w");
        store.admit(
            &actual,
            initial(&actual, "work", "thread"),
            &source(),
            "request",
            json!({"text":"non-root"}),
            vec![],
        )?;
        assert_eq!(store.list_for_thread(&actual, "thread")?.len(), 1);
        assert_eq!(fs::metadata(profile)?.permissions().mode() & 0o777, 0o755);
        assert_eq!(
            fs::metadata(profile.join("continuous-work.v1"))?
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(ContinuousWorkStore::open_existing(Path::new(&foreign)).is_err());
        assert!(ContinuousWorkStore::open_or_create(Path::new(&foreign)).is_err());
        fs::set_permissions(profile, fs::Permissions::from_mode(0o777))?;
        assert!(ContinuousWorkStore::open_existing(profile).is_err());
        assert!(store.list_for_thread(&actual, "thread").is_err());
        fs::set_permissions(profile, fs::Permissions::from_mode(0o755))?;
        println!("CONTINUOUS_WORK_NON_ROOT_VERIFIED");
        return Ok(());
    }
    if unsafe { libc::geteuid() } != 0 {
        // The normal Unix mode test also runs directly as this unprivileged
        // user. The foreign-UID subprocess needs a privileged fixture owner.
        eprintln!("foreign-UID subprocess not run: test runner is not root");
        return Ok(());
    }
    let temp = tempfile::Builder::new()
        .prefix("kcoder-continuous-nonroot-")
        .tempdir_in("/tmp")?;
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755))?;
    let profile = temp.path().join("owner-profile");
    let foreign = temp.path().join("foreign-profile");
    fs::create_dir(&profile)?;
    fs::create_dir(&foreign)?;
    fs::set_permissions(&profile, fs::Permissions::from_mode(0o755))?;
    fs::set_permissions(&foreign, fs::Permissions::from_mode(0o755))?;
    let path = std::ffi::CString::new(profile.as_os_str().as_bytes())?;
    assert_eq!(
        unsafe { libc::chown(path.as_ptr(), 65534, 65534) },
        0,
        "fixture chown failed: {}",
        std::io::Error::last_os_error()
    );
    // The build directory may sit under a private home (for example /root at
    // 0700) that the unprivileged user cannot traverse, so run a copy of this
    // test binary from the world-readable fixture directory instead.
    let runner = temp.path().join("unprivileged-test-runner");
    fs::copy(std::env::current_exe()?, &runner)?;
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o755))?;
    let output = Command::new(&runner)
        .args(["--exact", "continuous_work::tests::non_root_process_can_use_trusted_profile_but_not_other_owners_profile", "--nocapture"])
        .current_dir("/tmp")
        .env("KCODER_TEST_CONTINUOUS_UNPRIV_PROFILE", &profile)
        .env("KCODER_TEST_CONTINUOUS_FOREIGN_PROFILE", &foreign)
        .gid(65534).uid(65534).output()?;
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("CONTINUOUS_WORK_NON_ROOT_VERIFIED"));
    Ok(())
}

fn child_claim_runner(profile: &std::ffi::OsStr) -> Result<()> {
    let thread = std::env::var("KCODER_TEST_CONTINUOUS_CLAIM_THREAD")?;
    let store = ContinuousWorkStore::open_existing(Path::new(profile))?.unwrap();
    let result = store.claim(
        &scope("a", "t", "w"),
        "work",
        2,
        0,
        &format!("claim-{thread}"),
        &thread,
        ClaimTrigger::Input,
    );
    match result {
        Ok(_) => println!("CONTINUOUS_CHILD_CLAIMED"),
        Err(error) => {
            let error = format!("{error:#}");
            assert!(
                error.contains("ALREADY_CLAIMED") || error.contains("REVISION_CONFLICT"),
                "{error}"
            );
            println!("CONTINUOUS_CHILD_REJECTED");
        }
    }
    Ok(())
}

#[test]
fn independent_processes_cannot_both_claim_the_same_work() -> Result<()> {
    if let Some(profile) = std::env::var_os("KCODER_TEST_CONTINUOUS_CLAIM_PROFILE") {
        return child_claim_runner(&profile);
    }
    let temp = kcoder_config::create_private_temp_dir("continuous-work-processes")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread-a"),
        &source(),
        "request-1",
        json!({"text":"work"}),
        vec![],
    )?;
    store.bind_thread(&actual, "work", 1, "bind-b", attempt("thread-b"))?;
    let spawn = |thread: &str| {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "continuous_work::tests::independent_processes_cannot_both_claim_the_same_work",
                "--nocapture",
            ])
            .env("KCODER_TEST_CONTINUOUS_CLAIM_PROFILE", temp.path())
            .env("KCODER_TEST_CONTINUOUS_CLAIM_THREAD", thread)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
    };
    let first = spawn("thread-a")?;
    let second = spawn("thread-b")?;
    let outcomes = [first.wait_with_output()?, second.wait_with_output()?];
    for output in &outcomes {
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let text = outcomes
        .iter()
        .map(|o| String::from_utf8_lossy(&o.stdout))
        .collect::<String>();
    assert_eq!(text.matches("CONTINUOUS_CHILD_CLAIMED").count(), 1);
    assert_eq!(text.matches("CONTINUOUS_CHILD_REJECTED").count(), 1);
    assert_eq!(store.active_claim(&actual, "work")?.unwrap().owner_epoch, 1);
    Ok(())
}

#[test]
fn pending_input_pages_survive_reopen_without_loading_original_bodies() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-pending-pages")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "initial",
        json!({"text":"initial"}),
        vec![],
    )?;
    store.claim(
        &actual,
        "work",
        1,
        0,
        "claim",
        "thread",
        ClaimTrigger::Input,
    )?;
    store.mark_input_applied(
        &actual,
        "work",
        &source(),
        "initial",
        "claim",
        1,
        0,
        AppliedInputReference {
            attempt: attempt("thread"),
            history_uuid: "initial-history".into(),
        },
    )?;
    let other_source = WorkInputSource {
        kind: "channel".into(),
        instance_id: "bot".into(),
        conversation_id: "chat".into(),
    };
    let foreground_source = source();
    for sequence in 2..=13 {
        let revision = store.read_work(&actual, "work")?.unwrap().revision.revision;
        let current_source = if sequence % 2 == 0 {
            &other_source
        } else {
            &foreground_source
        };
        store.accept_input(
            &actual,
            "work",
            current_source,
            revision,
            &format!("input-{sequence}"),
            &format!("request-{sequence}"),
            WorkInputKind::Requirement,
            json!({"text":format!("body-{sequence}")}),
            Some(vec![]),
        )?;
    }
    drop(store);
    let store = ContinuousWorkStore::open_existing(temp.path())?.unwrap();
    let state_path = temp.path().join("continuous-work.v1/state.json");
    let before = fs::read(&state_path)?;
    let first = store.list_pending_inputs(&actual, "work", None)?;
    assert_eq!(
        first
            .inputs
            .iter()
            .map(|entry| entry.receipt.sequence)
            .collect::<Vec<_>>(),
        (2..=11).collect::<Vec<_>>()
    );
    assert_eq!(first.next_after_sequence, Some(11));
    assert_eq!(first.inputs[0].source, other_source);
    let payload = temp
        .path()
        .join("continuous-work.v1")
        .join(&first.inputs[0].receipt.payload_ref);
    fs::remove_file(&payload)?;
    let again = store.list_pending_inputs(&actual, "work", None)?;
    assert_eq!(again, first);
    let all = store.list_inputs(&actual, "work", None)?;
    assert_eq!(
        all.inputs
            .iter()
            .map(|entry| entry.receipt.sequence)
            .collect::<Vec<_>>(),
        (1..=10).collect::<Vec<_>>()
    );
    assert_eq!(all.next_after_sequence, Some(10));
    assert_eq!(
        all.inputs[0].applied.as_ref().unwrap().history_uuid,
        "initial-history"
    );
    assert_eq!(
        all.inputs[0].applied.as_ref().unwrap().attempt,
        attempt("thread")
    );
    assert!(all.inputs[1].applied.is_none());
    let all_last = store.list_inputs(&actual, "work", all.next_after_sequence)?;
    assert_eq!(
        all_last
            .inputs
            .iter()
            .map(|entry| entry.receipt.sequence)
            .collect::<Vec<_>>(),
        vec![11, 12, 13]
    );
    assert_eq!(all_last.next_after_sequence, None);
    assert!(
        store
            .read_input(&actual, "work", &other_source, "input-2")
            .is_err()
    );
    let last = store.list_pending_inputs(&actual, "work", first.next_after_sequence)?;
    assert_eq!(
        last.inputs
            .iter()
            .map(|entry| entry.receipt.sequence)
            .collect::<Vec<_>>(),
        vec![12, 13]
    );
    assert_eq!(last.next_after_sequence, None);
    assert!(
        store
            .list_pending_inputs(&actual, "work", Some(13))?
            .inputs
            .is_empty()
    );
    assert_eq!(fs::read(&state_path)?, before);
    Ok(())
}

#[test]
fn input_pages_are_scoped_even_when_work_and_input_ids_match() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-page-scope")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let scopes = [
        scope("account-a", "target-a", "workspace-a"),
        scope("account-b", "target-a", "workspace-a"),
        scope("account-a", "target-b", "workspace-a"),
        scope("account-a", "target-a", "workspace-b"),
    ];
    let mut sources = Vec::new();
    for (index, actual) in scopes.iter().enumerate() {
        let current = WorkInputSource {
            kind: "foreground".into(),
            instance_id: format!("instance-{index}"),
            conversation_id: format!("conversation-{index}"),
        };
        store.admit(
            actual,
            initial(actual, "same-work", &format!("thread-{index}")),
            &current,
            "same-input",
            json!({"index":index}),
            vec![],
        )?;
        sources.push(current);
    }
    let state = temp.path().join("continuous-work.v1/state.json");
    let before = fs::read(&state)?;
    for (index, actual) in scopes.iter().enumerate() {
        let pending = store.list_pending_inputs(actual, "same-work", None)?;
        assert_eq!(pending.inputs.len(), 1);
        assert_eq!(pending.inputs[0].source, sources[index]);
        assert_eq!(pending.inputs[0].receipt.work.scope, *actual);
        assert_eq!(pending.inputs[0].receipt.input_id, "same-input");
        assert_eq!(pending.next_after_sequence, None);
        let all = store.list_inputs(actual, "same-work", None)?;
        assert_eq!(all.inputs.len(), 1);
        assert_eq!(all.inputs[0].source, sources[index]);
        assert_eq!(all.inputs[0].receipt.work.scope, *actual);
        assert!(all.inputs[0].applied.is_none());
        assert!(
            store
                .list_inputs(actual, "same-work", Some(u64::MAX))?
                .inputs
                .is_empty()
        );
    }
    let absent = scope("account-a", "target-b", "workspace-b");
    assert!(
        store
            .list_pending_inputs(&absent, "same-work", None)
            .is_err()
    );
    assert!(store.list_inputs(&absent, "same-work", None).is_err());
    assert_eq!(fs::read(&state)?, before);
    Ok(())
}

#[test]
fn future_input_kind_and_orphan_payload_remain_unchanged_by_listing() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-future-page")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"original"}),
        vec![],
    )?;
    let namespace = temp.path().join("continuous-work.v1");
    let orphan = namespace.join("payload-uncommitted-fixture");
    fs::write(&orphan, b"retain uncommitted fixture")?;
    let state = namespace.join("state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&state)?)?;
    let input = data["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    input["receipt"]["kind"] = "future_kind".into();
    fs::write(&state, serde_json::to_vec(&data)?)?;
    let before = fs::read(&state)?;
    let before_names = names(&namespace)?;
    let pending = store.list_pending_inputs(&actual, "work", None)?;
    assert_eq!(pending.inputs.len(), 1);
    assert_eq!(pending.inputs[0].receipt.kind.as_str(), "future_kind");
    assert!(!pending.inputs[0].receipt.kind.is_known());
    let all = store.list_inputs(&actual, "work", None)?;
    assert_eq!(all.inputs.len(), 1);
    assert_eq!(all.inputs[0].receipt.kind.as_str(), "future_kind");
    assert_eq!(fs::read(&state)?, before);
    assert_eq!(names(&namespace)?, before_names);
    assert_eq!(fs::read(&orphan)?, b"retain uncommitted fixture");
    Ok(())
}

#[test]
fn future_input_state_keeps_its_original_applied_reference_for_review() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-future-applied")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"original"}),
        vec![],
    )?;
    let state = temp.path().join("continuous-work.v1/state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&state)?)?;
    let input = data["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    input["receipt"]["state"] = "future_review_state".into();
    input["applied"] = json!({
        "attempt": attempt("thread"),
        "historyUuid": "original-history"
    });
    fs::write(&state, serde_json::to_vec(&data)?)?;
    let before = fs::read(&state)?;
    let pending = store.list_pending_inputs(&actual, "work", None)?;
    assert_eq!(pending.inputs.len(), 1);
    assert_eq!(
        pending.inputs[0].receipt.state.as_str(),
        "future_review_state"
    );
    let all = store.list_inputs(&actual, "work", None)?;
    assert_eq!(all.inputs.len(), 1);
    assert_eq!(all.inputs[0].receipt.state.as_str(), "future_review_state");
    assert_eq!(
        all.inputs[0].applied,
        Some(AppliedInputReference {
            attempt: attempt("thread"),
            history_uuid: "original-history".into(),
        })
    );
    assert!(
        store
            .claim(
                &actual,
                "work",
                1,
                0,
                "claim",
                "thread",
                ClaimTrigger::Input
            )
            .is_err()
    );
    assert_eq!(fs::read(&state)?, before);
    Ok(())
}

#[test]
fn unrecognized_pending_publication_is_not_claimed_or_rewritten() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-future-publication")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "request",
        json!({"text":"original"}),
        vec![],
    )?;
    let namespace = temp.path().join("continuous-work.v1");
    let orphan = namespace.join("payload-uncommitted-fixture");
    fs::write(&orphan, b"retain pending publication")?;
    let state = namespace.join("state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&state)?)?;
    data["pendingPublications"] = json!({"future-operation":{"opaque":"preserve"}});
    fs::write(&state, serde_json::to_vec(&data)?)?;
    let before = fs::read(&state)?;
    let before_names = names(&namespace)?;
    let pending_error = store
        .list_pending_inputs(&actual, "work", None)
        .unwrap_err();
    assert!(
        pending_error
            .to_string()
            .contains("CONTINUOUS_WORK_DATA_INVALID")
    );
    let all_error = store.list_inputs(&actual, "work", None).unwrap_err();
    assert!(
        all_error
            .to_string()
            .contains("CONTINUOUS_WORK_DATA_INVALID")
    );
    assert_eq!(fs::read(&state)?, before);
    assert_eq!(names(&namespace)?, before_names);
    assert_eq!(fs::read(&orphan)?, b"retain pending publication");
    Ok(())
}

#[test]
fn rejected_input_is_visible_in_all_inputs_but_not_pending() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-page-rejected")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "initial",
        json!({"text":"original"}),
        vec![],
    )?;
    store.accept_input(
        &actual,
        "work",
        &source(),
        1,
        "rejected-input",
        "rejected-request",
        WorkInputKind::Requirement,
        json!({"text":"rejected"}),
        Some(vec![]),
    )?;
    let state = temp.path().join("continuous-work.v1/state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&state)?)?;
    let second = data["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|item| item["receipt"]["sequence"] == 2)
        .unwrap();
    second["receipt"]["state"] = "rejected".into();
    fs::write(&state, serde_json::to_vec(&data)?)?;
    let before = fs::read(&state)?;
    let pending = store.list_pending_inputs(&actual, "work", None)?;
    assert_eq!(pending.inputs.len(), 1);
    assert_eq!(pending.inputs[0].receipt.sequence, 1);
    let all = store.list_inputs(&actual, "work", None)?;
    assert_eq!(all.inputs.len(), 2);
    assert_eq!(all.inputs[1].receipt.sequence, 2);
    assert_eq!(all.inputs[1].receipt.state.as_str(), "rejected");
    assert_eq!(all.inputs[1].source, source());
    assert!(all.inputs[1].applied.is_none());
    assert_eq!(fs::read(&state)?, before);
    Ok(())
}

#[test]
fn duplicate_input_sequences_fail_closed_instead_of_dropping_an_entry() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-page-duplicate")?;
    let actual = scope("a", "t", "w");
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    store.admit(
        &actual,
        initial(&actual, "work", "thread"),
        &source(),
        "initial",
        json!({"text":"original"}),
        vec![],
    )?;
    store.accept_input(
        &actual,
        "work",
        &source(),
        1,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"second"}),
        Some(vec![]),
    )?;
    let state = temp.path().join("continuous-work.v1/state.json");
    let mut data: serde_json::Value = serde_json::from_slice(&fs::read(&state)?)?;
    let second = data["inputs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .find(|item| item["receipt"]["sequence"] == 2)
        .unwrap();
    second["receipt"]["sequence"] = 1.into();
    fs::write(&state, serde_json::to_vec(&data)?)?;
    let before = fs::read(&state)?;
    assert!(store.list_pending_inputs(&actual, "work", None).is_err());
    assert!(store.list_inputs(&actual, "work", None).is_err());
    assert_eq!(fs::read(&state)?, before);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[derive(Debug, PartialEq, Eq)]
enum FixtureEntry {
    Directory(String),
    File(kcoder_config::PortableLeaseIdentity, Vec<u8>),
}

#[cfg(any(target_os = "linux", windows))]
fn snapshot_fixture(
    root: &Path,
) -> Result<std::collections::BTreeMap<std::path::PathBuf, FixtureEntry>> {
    fn visit(
        root: &Path,
        path: &Path,
        entries: &mut std::collections::BTreeMap<std::path::PathBuf, FixtureEntry>,
    ) -> Result<()> {
        let relative = path.strip_prefix(root)?.to_path_buf();
        let metadata = fs::symlink_metadata(path)?;
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "unexpected fixture symlink"
        );
        if metadata.is_dir() {
            let directory = kcoder_config::PrivateDirectory::open_existing(path)?;
            entries.insert(
                relative,
                FixtureEntry::Directory(directory.directory_identity()?),
            );
            for child in fs::read_dir(path)? {
                visit(root, &child?.path(), entries)?;
            }
        } else {
            anyhow::ensure!(metadata.is_file(), "unexpected fixture entry");
            let file = fs::File::open(path)?;
            let identity = kcoder_config::PortableLeaseIdentity::from_regular_handle(&file)?;
            let bytes = fs::read(path)?;
            entries.insert(
                relative,
                FixtureEntry::File(identity, Sha256::digest(bytes).to_vec()),
            );
        }
        Ok(())
    }
    let mut entries = std::collections::BTreeMap::new();
    visit(root, root, &mut entries)?;
    Ok(entries)
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn ct03_read_only_queries_preserve_complete_owned_tree_and_orphans() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-ct03")?;
    let root = kcoder_config::PrivateDirectory::open_existing(temp.path())?;
    root.create_private_child(std::ffi::OsStr::new("profile"))?;
    root.create_private_child(std::ffi::OsStr::new("workspace"))?;
    let profile = temp.path().join("profile");
    let orphan = temp
        .path()
        .join("workspace/.kcoder/orchestrate/works/orphan");
    fs::create_dir_all(&orphan)?;
    fs::write(orphan.join("plan.md"), b"owned orphan: leave unchanged")?;
    fs::write(orphan.join("unknown.json"), br#"{"future":true}"#)?;
    let actual = scope("account", "target", "workspace");

    let before_missing = snapshot_fixture(temp.path())?;
    for _ in 0..3 {
        assert!(ContinuousWorkStore::open_existing(&profile)?.is_none());
        assert_eq!(
            observe_stored_work_bindings(&profile, &actual, "old-thread"),
            StoredBindingObservation::Unavailable
        );
        assert!(ContinuousWorkStore::open_existing(&profile.join("missing"))?.is_none());
    }
    assert_eq!(snapshot_fixture(temp.path())?, before_missing);

    let store = ContinuousWorkStore::open_or_create(&profile)?;
    let payload = json!({"text":"original request", "attachments":["owned-image"]});
    store.admit(
        &actual,
        initial(&actual, "work-a", "thread-a"),
        &source(),
        "request-a",
        payload.clone(),
        vec![],
    )?;
    let before_present = snapshot_fixture(temp.path())?;
    for _ in 0..3 {
        let reopened = ContinuousWorkStore::open_existing(&profile)?.unwrap();
        assert_eq!(reopened.list_for_thread(&actual, "thread-a")?.len(), 1);
        assert!(reopened.list_for_thread(&actual, "old-thread")?.is_empty());
        assert!(reopened.read_work(&actual, "missing")?.is_none());
        assert_eq!(
            reopened
                .read_input(&actual, "work-a", &source(), "request-a")?
                .unwrap()
                .1,
            payload
        );
        assert_eq!(
            observe_stored_work_binding(&profile, &actual, "work-a", "thread-a"),
            StoredBindingLookup::Observed
        );
        assert_eq!(
            observe_stored_work_binding(&profile, &actual, "missing", "old-thread"),
            StoredBindingLookup::Absent
        );
    }
    assert_eq!(snapshot_fixture(temp.path())?, before_present);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn ct02_other_scope_and_unbound_thread_cannot_read_control_or_claim() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-ct02")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("account-a", "target-a", "workspace-a");
    store.admit(
        &actual,
        initial(&actual, "work-a", "thread-a"),
        &source(),
        "request-a",
        json!({"text":"original"}),
        vec![],
    )?;
    let before = snapshot_fixture(temp.path())?;
    for foreign in [
        scope("account-b", "target-a", "workspace-a"),
        scope("account-a", "target-b", "workspace-a"),
        scope("account-a", "target-a", "workspace-b"),
    ] {
        assert!(store.read_work(&foreign, "work-a")?.is_none());
        assert!(store.list_for_thread(&foreign, "thread-a")?.is_empty());
        assert!(
            store
                .read_input(&foreign, "work-a", &source(), "request-a")?
                .is_none()
        );
        assert!(
            store
                .claim(
                    &foreign,
                    "work-a",
                    1,
                    0,
                    "claim",
                    "thread-a",
                    ClaimTrigger::Input
                )
                .is_err()
        );
        assert!(
            store
                .control(
                    &foreign,
                    "work-a",
                    1,
                    "pause",
                    WorkControlAction::Pause,
                    WorkControlTarget::Work {},
                )
                .is_err()
        );
        assert!(
            store
                .bind_thread(&foreign, "work-a", 1, "bind", attempt("thread-b"))
                .is_err()
        );
    }
    assert!(store.list_for_thread(&actual, "thread-b")?.is_empty());
    assert!(
        store
            .claim(
                &actual,
                "work-a",
                1,
                0,
                "claim",
                "thread-b",
                ClaimTrigger::Input
            )
            .is_err()
    );
    assert_eq!(snapshot_fixture(temp.path())?, before);
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn ct01_old_unverified_plan_reference_is_readable_but_cannot_mutate() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-plan-revision")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("account", "target", "workspace");
    store.admit(
        &actual,
        initial(&actual, "work-a", "thread-a"),
        &source(),
        "request-a",
        json!({"text":"original"}),
        vec![],
    )?;
    drop(store);
    let path = temp.path().join("continuous-work.v1/state.json");
    let mut data: Value = serde_json::from_slice(&fs::read(&path)?)?;
    let stored = data["works"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    stored["record"]["nativeRefs"] = json!([{
        "kind":"plan", "planWorkId":"original-plan", "revision":0,
        "planSha256":"a".repeat(64)
    }]);
    fs::write(&path, serde_json::to_vec(&data)?)?;
    let before = snapshot_fixture(temp.path())?;
    let reopened = ContinuousWorkStore::open_existing(temp.path())?.unwrap();
    let observed = reopened.read_work(&actual, "work-a")?.unwrap();
    assert!(observed.validate_shape().is_ok());
    assert!(observed.validate_for_mutation(&actual).is_err());
    assert!(
        reopened
            .claim(
                &actual,
                "work-a",
                1,
                0,
                "claim",
                "thread-a",
                ClaimTrigger::Input
            )
            .is_err()
    );
    assert!(
        reopened
            .bind_thread(&actual, "work-a", 1, "bind", attempt("thread-b"))
            .is_err()
    );
    assert_eq!(snapshot_fixture(temp.path())?, before);
    Ok(())
}

#[test]
fn automatic_claims_and_settlements_keep_durable_batch_counters() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-usage")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    store.admit(
        &actual,
        initial(&actual, "work", "thread-a"),
        &source(),
        "request-1",
        json!({"text":"initial"}),
        vec![],
    )?;

    // A claim for an accepted user input never consumes the automatic budget.
    let ClaimOutcome::Acquired(input) = store.claim(
        &actual,
        "work",
        1,
        0,
        "claim-input",
        "thread-a",
        ClaimTrigger::Input,
    )?
    else {
        panic!("input claim must be acquired")
    };
    let usage = store.read_work(&actual, "work")?.unwrap().revision.usage;
    assert_eq!(usage, WorkUsage::default());
    store.release_claim(
        &actual,
        "work",
        "claim-input",
        input.owner_epoch,
        ClaimSettlement::Failed,
    )?;
    let usage = store.read_work(&actual, "work")?.unwrap().revision.usage;
    assert_eq!(usage.consecutive_failures, 1);
    assert_eq!(usage.automatic_turns, 0);

    // An automatic claim counts toward the batch, and a stalled round keeps the
    // earlier failure while accumulating its own counter.
    let ClaimOutcome::Acquired(automatic) = store.claim(
        &actual,
        "work",
        3,
        0,
        "claim-automatic",
        "thread-a",
        ClaimTrigger::Automatic,
    )?
    else {
        panic!("automatic claim must be acquired")
    };
    let usage = store.read_work(&actual, "work")?.unwrap().revision.usage;
    assert_eq!(usage.automatic_turns, 1);
    assert_eq!(usage.consecutive_failures, 1);
    store.release_claim(
        &actual,
        "work",
        "claim-automatic",
        automatic.owner_epoch,
        ClaimSettlement::Stalled,
    )?;
    let usage = store.read_work(&actual, "work")?.unwrap().revision.usage;
    assert_eq!(usage.stalled_rounds, 1);
    assert_eq!(usage.consecutive_failures, 1);

    // A completed turn resets both failure counters but keeps the batch usage.
    let ClaimOutcome::Acquired(completed) = store.claim(
        &actual,
        "work",
        5,
        0,
        "claim-completed",
        "thread-a",
        ClaimTrigger::Automatic,
    )?
    else {
        panic!("completed claim must be acquired")
    };
    store.release_claim(
        &actual,
        "work",
        "claim-completed",
        completed.owner_epoch,
        ClaimSettlement::Completed,
    )?;
    let usage = store.read_work(&actual, "work")?.unwrap().revision.usage;
    assert_eq!(
        usage,
        WorkUsage {
            automatic_turns: 2,
            consecutive_failures: 0,
            stalled_rounds: 0,
        }
    );
    Ok(())
}

#[test]
fn older_revisions_without_usage_stay_readable_and_default_to_zero() -> Result<()> {
    let revision: WorkRevision = serde_json::from_value(json!({
        "revision": 4, "requirementsRevision": 2, "controlEpoch": 3, "ownerEpoch": 1,
        "acceptedInputSequence": 2, "requiredInputSequence": 2, "appliedInputSequence": 2
    }))?;
    assert_eq!(revision.usage, WorkUsage::default());
    assert!(revision.validate_shape().is_ok());
    let round_trip: WorkRevision = serde_json::from_value(serde_json::to_value(&revision)?)?;
    assert_eq!(round_trip, revision);
    Ok(())
}

#[test]
fn queued_inputs_dispatch_and_settle_in_order() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-queue")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    store.admit(
        &actual,
        initial(&actual, "work", "thread-a"),
        &source(),
        "request-1",
        json!({"text":"initial"}),
        vec![],
    )?;
    let ClaimOutcome::Acquired(claim) = store.claim(
        &actual,
        "work",
        1,
        0,
        "claim-1",
        "thread-a",
        ClaimTrigger::Input,
    )?
    else {
        panic!("claim must be acquired")
    };
    // The initial input is applied first so later inputs stay in sequence.
    store.mark_input_applied(
        &actual,
        "work",
        &source(),
        "request-1",
        "claim-1",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt("thread-a"),
            history_uuid: "history-1".into(),
        },
    )?;
    let revision = store.read_work(&actual, "work")?.unwrap().revision.revision;
    let queued = store.queue_input(
        &actual,
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"second"}),
        Some(vec![]),
    )?;
    let InputAdmission::Accepted(queued) = queued else {
        panic!("queued input must be accepted")
    };
    assert_eq!(queued.state, WorkInputState::Queued);
    assert_eq!(queued.sequence, 2);
    assert_eq!(queued.requirements_revision, Some(2));
    let work = store.read_work(&actual, "work")?.unwrap();
    assert_eq!(work.revision.accepted_input_sequence, 2);
    assert_eq!(work.revision.applied_input_sequence, 1);
    assert_eq!(work.revision.requirements_revision, 2);

    let dispatched = store.dispatch_input(
        &actual,
        "work",
        &source(),
        "input-2",
        "claim-1",
        claim.owner_epoch,
        0,
    )?;
    assert_eq!(dispatched.state, WorkInputState::Dispatched);
    let applied = store.settle_input(
        &actual,
        "work",
        &source(),
        "input-2",
        "claim-1",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt("thread-a"),
            history_uuid: "history-2".into(),
        },
    )?;
    assert_eq!(applied.state, WorkInputState::Applied);
    let work = store.read_work(&actual, "work")?.unwrap();
    assert_eq!(work.revision.applied_input_sequence, 2);
    Ok(())
}

#[test]
fn queued_status_query_keeps_requirements_and_later_inputs_wait() -> Result<()> {
    let temp = kcoder_config::create_private_temp_dir("continuous-work-status-query")?;
    let store = ContinuousWorkStore::open_or_create(temp.path())?;
    let actual = scope("a", "t", "w");
    store.admit(
        &actual,
        initial(&actual, "work", "thread-a"),
        &source(),
        "request-1",
        json!({"text":"initial"}),
        vec![],
    )?;
    let ClaimOutcome::Acquired(claim) = store.claim(
        &actual,
        "work",
        1,
        0,
        "claim-1",
        "thread-a",
        ClaimTrigger::Input,
    )?
    else {
        panic!("claim must be acquired")
    };
    store.mark_input_applied(
        &actual,
        "work",
        &source(),
        "request-1",
        "claim-1",
        claim.owner_epoch,
        0,
        AppliedInputReference {
            attempt: attempt("thread-a"),
            history_uuid: "history-1".into(),
        },
    )?;
    let revision = store.read_work(&actual, "work")?.unwrap().revision.revision;
    let _ = store.queue_input(
        &actual,
        "work",
        &source(),
        revision,
        "input-2",
        "request-2",
        WorkInputKind::Requirement,
        json!({"text":"second"}),
        Some(vec![]),
    )?;
    let revision = store.read_work(&actual, "work")?.unwrap().revision.revision;
    let query = store.queue_input(
        &actual,
        "work",
        &source(),
        revision,
        "input-3",
        "request-3",
        WorkInputKind::StatusQuery,
        json!({"text":"how is it going"}),
        None,
    )?;
    let InputAdmission::Accepted(query) = query else {
        panic!("status query must be accepted")
    };
    assert_eq!(query.state, WorkInputState::Queued);
    assert_eq!(query.requirements_revision, None);
    assert_eq!(
        store
            .read_work(&actual, "work")?
            .unwrap()
            .revision
            .requirements_revision,
        2
    );

    // The later status query must not overtake the earlier queued requirement.
    assert!(
        store
            .dispatch_input(
                &actual,
                "work",
                &source(),
                "input-3",
                "claim-1",
                claim.owner_epoch,
                0
            )
            .is_err()
    );
    store.dispatch_input(
        &actual,
        "work",
        &source(),
        "input-2",
        "claim-1",
        claim.owner_epoch,
        0,
    )?;
    let query = store.dispatch_input(
        &actual,
        "work",
        &source(),
        "input-3",
        "claim-1",
        claim.owner_epoch,
        0,
    )?;
    assert_eq!(query.state, WorkInputState::Dispatched);

    // The same input identity with different content stays a conflict.
    let revision = store.read_work(&actual, "work")?.unwrap().revision.revision;
    assert!(
        store
            .queue_input(
                &actual,
                "work",
                &source(),
                revision,
                "input-2",
                "request-2b",
                WorkInputKind::Requirement,
                json!({"text":"changed"}),
                Some(vec![]),
            )
            .is_err()
    );
    Ok(())
}
