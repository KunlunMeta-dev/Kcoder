use super::*;
use kcoder_types::integrations::core::IntegrationNullable;
use serde_json::json;
fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "account-1".into(),
        target_id: "target-1".into(),
        workspace_id: IntegrationNullable::Value("workspace-1".into()),
        identity_generation: "generation-1".into(),
        target_revision: "revision-1".into(),
        organization_id: None,
    }
}
fn plan() -> NativeRemotePlan {
    NativeRemotePlan {
        operation_id: "original-remote-operation".into(),
        scope: scope(),
        public_intent: json!({"recipient":{"id":"approved-runner","revision":"r1"},"prompt":"The exact original public intent","inputRefs":[]}),
        recipient_revision: "receiver-r1".into(),
        recipient_identity: json!({"nativeOwner":"receiver-original","protocol":"acp","version":1}),
    }
}
fn setup() -> (
    tempfile::TempDir,
    PrivateDirectory,
    NativeRemoteDelegationStore,
) {
    let owned = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_existing(owned.path())
        .unwrap()
        .create_private_child(OsStr::new("native-profile"))
        .unwrap();
    let store =
        NativeRemoteDelegationStore::create_in(&root, OsStr::new("remote"), &scope()).unwrap();
    (owned, root, store)
}
#[test]
fn native_launch_is_private_immutable_before_dispatch_and_cannot_be_repaired_from_metadata() {
    let (owned, _root, store) = setup();
    let plan = plan();
    assert!(
        store
            .read_native_launch(&plan.operation_id)
            .unwrap()
            .is_none()
    );
    store.begin(&plan).unwrap();
    let bytes =
        br#"{"kind":"native-private-launch-fixture","originalReceiptSha256":"not-a-grant"}"#;
    store
        .freeze_native_launch(&plan.operation_id, &plan.scope, bytes)
        .unwrap();
    let frozen = store
        .read_native_launch(&plan.operation_id)
        .unwrap()
        .unwrap();
    assert_eq!(frozen.bytes(), bytes);
    assert_eq!(frozen.sha256(), format!("{:x}", Sha256::digest(bytes)));
    assert!(
        !serde_json::to_string(
            &store
                .read(&plan.operation_id)
                .unwrap()
                .unwrap()
                .public_intent
        )
        .unwrap()
        .contains("native-private-launch-fixture")
    );
    assert!(
        store
            .freeze_native_launch(&plan.operation_id, &plan.scope, b"caller replacement")
            .is_err()
    );
    let dispatch = store
        .before_dispatch(
            &plan.operation_id,
            &plan.scope,
            NativeRemoteStage::Spawn,
            &json!({"fixed":true}),
        )
        .unwrap();
    store.unknown(&dispatch).unwrap();
    store
        .freeze_native_launch(&plan.operation_id, &plan.scope, bytes)
        .unwrap();
    let launch = owned.path().join("native-profile/remote").join(format!(
        "launch-{:x}.json",
        Sha256::digest(plan.operation_id.as_bytes())
    ));
    std::fs::write(&launch, b"corrupt same original native file").unwrap();
    assert!(store.read_native_launch(&plan.operation_id).is_err());
    assert!(
        store
            .freeze_native_launch(&plan.operation_id, &plan.scope, bytes)
            .is_err()
    );
}
#[test]
fn actual_receiver_accepted_ledger_links_once_and_lost_protocol_receipt_reads_original_native_task()
{
    use crate::turn_attempt_store::{TurnAttemptCompletion, TurnAttemptRecord, TurnAttemptStore};
    use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
    let (owned, _root, store) = setup();
    let plan = plan();
    store.begin(&plan).unwrap();
    let identity = TurnAttemptIdentity {
        thread_id: "actual-receiver-thread".into(),
        turn_id: "actual-receiver-turn".into(),
        attempt_id: "actual-receiver-attempt".into(),
    };
    let task = TurnAttemptStore::open(
        &owned
            .path()
            .join("receiver-sessions")
            .join(&identity.thread_id),
        &identity.thread_id,
    )
    .unwrap();
    task.begin(TurnAttemptRecord {
        version: 1,
        identity: identity.clone(),
        parent_attempt_id: None,
        retry_operation_id: None,
        accepted_at_ms: 1,
        input_context_hash: "a".repeat(64),
        request_fingerprint: Some("b".repeat(64)),
        retained_input: None,
        status: TurnAttemptStatus::Accepted,
        completion: None,
        client_presentation: None,
    })
    .unwrap();
    let accepted = NativeRemoteAcceptedReceiver::read_accepted(&task, &identity).unwrap();
    assert!(
        store
            .link_accepted_receiver(
                &plan.operation_id,
                &plan.recipient_identity,
                &task,
                &accepted
            )
            .is_err()
    );
    for stage in [
        NativeRemoteStage::Spawn,
        NativeRemoteStage::Initialize,
        NativeRemoteStage::Session,
    ] {
        let permit = store
            .before_dispatch(
                &plan.operation_id,
                &plan.scope,
                stage,
                &json!({"original":true}),
            )
            .unwrap();
        store.receive(&permit, &json!({"received":true})).unwrap();
    }
    let prompt = store
        .before_dispatch(
            &plan.operation_id,
            &plan.scope,
            NativeRemoteStage::Prompt,
            &json!({"originalPrompt":true}),
        )
        .unwrap();
    let first = store
        .link_accepted_receiver(
            &plan.operation_id,
            &plan.recipient_identity,
            &task,
            &accepted,
        )
        .unwrap();
    let same = store
        .link_accepted_receiver(
            &plan.operation_id,
            &plan.recipient_identity,
            &task,
            &accepted,
        )
        .unwrap();
    assert_eq!(first.revision, same.revision);
    assert!(
        store
            .read_receiver_private_witness(&plan.operation_id)
            .unwrap()
            .is_none()
    );
    let private =
        json!({"historyRoot":"owned-private-root","directoryIdentity":"actual-original-directory"});
    store
        .freeze_receiver_private_witness(&plan.operation_id, &task, &accepted, &private)
        .unwrap();
    store
        .freeze_receiver_private_witness(&plan.operation_id, &task, &accepted, &private)
        .unwrap();
    assert!(
        store
            .freeze_receiver_private_witness(
                &plan.operation_id,
                &task,
                &accepted,
                &json!({"historyRoot":"replacement"})
            )
            .is_err()
    );
    assert_eq!(
        store
            .read_receiver_private_witness(&plan.operation_id)
            .unwrap(),
        Some(private)
    );
    assert!(
        !format!("{:?}", store.read(&plan.operation_id).unwrap()).contains("owned-private-root")
    );

    assert_eq!(first.receiver.unwrap().identity, identity);
    store.unknown(&prompt).unwrap();
    task.finish(
        &identity,
        TurnAttemptCompletion {
            status: TurnAttemptStatus::Completed,
            finished_at_ms: 2,
            error: None,
            provider_failure: None,
            partial_output: String::new(),
            partial_output_truncated: false,
            committed_history_uuid: None,
        },
    )
    .unwrap();
    assert_eq!(
        store
            .read_receiver_task(&plan.operation_id, &plan.recipient_identity, &task)
            .unwrap()
            .status,
        TurnAttemptStatus::Completed
    );
    assert!(
        store
            .read_receiver_task(
                &plan.operation_id,
                &json!({"name":"same-label-impostor"}),
                &task
            )
            .is_err()
    );
    assert!(
        store
            .before_dispatch(
                &plan.operation_id,
                &plan.scope,
                NativeRemoteStage::Prompt,
                &json!({"retry":true})
            )
            .is_err()
    );
    assert!(NativeRemoteAcceptedReceiver::read_accepted(&task, &identity).is_err());
}
#[test]
fn remote_read_absence_never_initializes_and_existing_damage_never_resets() {
    let owned = tempfile::tempdir().unwrap();
    let root = PrivateDirectory::open_existing(owned.path())
        .unwrap()
        .create_private_child(OsStr::new("native-profile"))
        .unwrap();
    assert!(
        NativeRemoteDelegationStore::open_in(&root, OsStr::new("absent"), &scope())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        std::fs::read_dir(owned.path().join("native-profile"))
            .unwrap()
            .count(),
        0
    );
    let store =
        NativeRemoteDelegationStore::create_in(&root, OsStr::new("remote"), &scope()).unwrap();
    store.begin(&plan()).unwrap();
    std::fs::remove_file(
        owned
            .path()
            .join("native-profile")
            .join("remote")
            .join(DATA),
    )
    .unwrap();
    assert!(store.read("original-remote-operation").is_err());
    assert!(NativeRemoteDelegationStore::open_in(&root, OsStr::new("remote"), &scope()).is_err());
    assert!(
        !owned
            .path()
            .join("native-profile")
            .join("remote")
            .join(DATA)
            .exists()
    );
}
#[test]
fn remote_freezes_complete_original_intent_and_reopens_without_replay_or_new_authority() {
    let (_owned, root, store) = setup();
    let plan = plan();
    let (record, created) = store.begin(&plan).unwrap();
    assert!(created);
    assert_eq!(record.public_intent, plan.public_intent);
    let dispatched = store
        .before_dispatch(
            &plan.operation_id,
            &scope(),
            NativeRemoteStage::Spawn,
            &json!({"pin":"approved"}),
        )
        .unwrap();
    store.unknown(&dispatched).unwrap();
    drop(store);
    let reopened = NativeRemoteDelegationStore::open_in(&root, OsStr::new("remote"), &scope())
        .unwrap()
        .unwrap();
    assert!(!reopened.begin(&plan).unwrap().1);
    assert_eq!(
        reopened.read(&plan.operation_id).unwrap().unwrap().stages[&NativeRemoteStage::Spawn],
        NativeRemoteStageState::Unknown
    );
    assert!(
        reopened
            .before_dispatch(
                &plan.operation_id,
                &scope(),
                NativeRemoteStage::Spawn,
                &json!({"pin":"approved"})
            )
            .is_err()
    );
    let mut changed = plan;
    changed.public_intent["prompt"] = "different".into();
    assert!(reopened.begin(&changed).is_err());
}
#[test]
fn remote_exact_dispatch_receipts_are_monotonic_and_unknown_cannot_erase_received_facts() {
    let (_owned, _root, store) = setup();
    let plan = plan();
    store.begin(&plan).unwrap();
    let spawn = store
        .before_dispatch(
            &plan.operation_id,
            &scope(),
            NativeRemoteStage::Spawn,
            &json!({"pin":"approved"}),
        )
        .unwrap();
    assert!(
        store
            .before_dispatch(
                &plan.operation_id,
                &scope(),
                NativeRemoteStage::Initialize,
                &json!({})
            )
            .is_err()
    );
    let known = json!({"ownedPid":123});
    store.receive(&spawn, &known).unwrap();
    store.unknown(&spawn).unwrap();
    assert_eq!(
        store
            .read(&plan.operation_id)
            .unwrap()
            .unwrap()
            .safe_receipts[&NativeRemoteStage::Spawn],
        known
    );
    assert!(store.receive(&spawn, &json!({"ownedPid":456})).is_err());
    let initialize = store
        .before_dispatch(
            &plan.operation_id,
            &scope(),
            NativeRemoteStage::Initialize,
            &json!({"protocolVersion":1}),
        )
        .unwrap();
    assert_eq!(
        store
            .receive(&initialize, &json!({"protocolVersion":1}))
            .unwrap()
            .stages[&NativeRemoteStage::Initialize],
        NativeRemoteStageState::Received
    );
}
#[test]
fn remote_owner_and_active_generation_changes_do_not_reauthorize_stored_operations() {
    let (_owned, root, store) = setup();
    let plan = plan();
    store.begin(&plan).unwrap();
    let mut other = scope();
    other.account_id = "other-account".into();
    assert!(NativeRemoteDelegationStore::open_in(&root, OsStr::new("remote"), &other).is_err());
    let mut refreshed = scope();
    refreshed.identity_generation = "new-generation".into();
    let reopened = NativeRemoteDelegationStore::open_in(&root, OsStr::new("remote"), &refreshed)
        .unwrap()
        .unwrap();
    assert!(reopened.read(&plan.operation_id).unwrap().is_some());
    assert!(
        reopened
            .before_dispatch(
                &plan.operation_id,
                &refreshed,
                NativeRemoteStage::Spawn,
                &json!({})
            )
            .is_err()
    );
}
#[test]
fn remote_existing_lock_or_header_replacement_fails_closed() {
    for name in [LOCK, HEADER] {
        let (owned, _root, store) = setup();
        store.begin(&plan()).unwrap();
        let path = owned
            .path()
            .join("native-profile")
            .join("remote")
            .join(name);
        let original = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, original).unwrap();
        assert!(store.read("original-remote-operation").is_err());
    }
}
#[cfg(unix)]
#[test]
fn remote_hardlinked_data_is_not_accepted_or_recreated() {
    let (owned, _root, store) = setup();
    store.begin(&plan()).unwrap();
    std::fs::hard_link(
        owned
            .path()
            .join("native-profile")
            .join("remote")
            .join(DATA),
        owned.path().join("data-link"),
    )
    .unwrap();
    assert!(store.read("original-remote-operation").is_err());
}

#[test]
fn remote_effect_worker() {
    let Ok(root) = std::env::var("KCODER_REMOTE_OWNED_TEST_ROOT") else {
        return;
    };
    let id = std::env::var("KCODER_REMOTE_OWNED_TEST_ID").unwrap();
    let path = std::path::PathBuf::from(root);
    let store = NativeRemoteDelegationStore::open_in(
        &PrivateDirectory::open_existing(&path).unwrap(),
        OsStr::new("remote"),
        &scope(),
    )
    .unwrap()
    .unwrap();
    for _ in 0..500 {
        if path.join("go").exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(path.join("go").exists());
    let mut result = "busy";
    for _ in 0..200 {
        match store.before_dispatch(
            "original-remote-operation",
            &scope(),
            NativeRemoteStage::Spawn,
            &json!({"pin":"same-original-runner"}),
        ) {
            Ok(_) => {
                result = "dispatched";
                break;
            }
            Err(error) if error.to_string() == "REMOTE_JOURNAL_BUSY" => {
                std::thread::sleep(std::time::Duration::from_millis(5))
            }
            Err(error) if error.to_string() == "REMOTE_ALREADY_DISPATCHED_DO_NOT_REPLAY" => {
                result = "rejected";
                break;
            }
            Err(error) => panic!("unexpected native journal error: {error}"),
        }
    }
    assert_ne!(result, "busy");
    std::fs::write(path.join(format!("result-{id}")), result).unwrap();
}

#[test]
fn remote_independent_processes_cannot_dispatch_the_same_original_operation_twice() {
    struct Child(std::process::Child);
    impl Drop for Child {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }
    let (owned, _root, store) = setup();
    store.begin(&plan()).unwrap();
    let root = owned.path().join("native-profile");
    let mut children = Vec::new();
    for id in ["a", "b"] {
        children.push(Child(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "integrations::core::remote_delegations::tests::remote_effect_worker",
                    "--nocapture",
                ])
                .env("KCODER_REMOTE_OWNED_TEST_ROOT", &root)
                .env("KCODER_REMOTE_OWNED_TEST_ID", id)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        ));
    }
    std::fs::write(root.join("go"), b"start").unwrap();
    for child in &mut children {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    let mut outcomes = [
        std::fs::read_to_string(root.join("result-a")).unwrap(),
        std::fs::read_to_string(root.join("result-b")).unwrap(),
    ];
    outcomes.sort();
    assert_eq!(outcomes, ["dispatched", "rejected"]);
    assert_eq!(
        store
            .read("original-remote-operation")
            .unwrap()
            .unwrap()
            .stages[&NativeRemoteStage::Spawn],
        NativeRemoteStageState::Dispatched
    );
}

#[test]
fn cleanup_uses_the_original_spawn_and_confirmation_never_regresses() {
    let (_owned, _root, store) = setup();
    let plan = plan();
    store.begin(&plan).unwrap();
    assert!(
        store
            .record_owner_cleanup(&plan.operation_id, 123, true)
            .is_err()
    );
    let spawn = store
        .before_dispatch(
            &plan.operation_id,
            &plan.scope,
            NativeRemoteStage::Spawn,
            &json!({"fixed":true}),
        )
        .unwrap();
    store.receive(&spawn, &json!({"ownedPid":123})).unwrap();
    assert!(
        store
            .record_owner_cleanup(&plan.operation_id, 456, true)
            .is_err()
    );
    store
        .record_owner_cleanup(&plan.operation_id, 123, false)
        .unwrap();
    assert!(
        !store
            .read(&plan.operation_id)
            .unwrap()
            .unwrap()
            .owner_cleanup
            .unwrap()
            .confirmed
    );
    store
        .record_owner_cleanup(&plan.operation_id, 123, true)
        .unwrap();
    let revision = store.read(&plan.operation_id).unwrap().unwrap().revision;
    store
        .record_owner_cleanup(&plan.operation_id, 123, true)
        .unwrap();
    assert_eq!(
        store.read(&plan.operation_id).unwrap().unwrap().revision,
        revision
    );
    assert!(
        store
            .record_owner_cleanup(&plan.operation_id, 123, false)
            .is_err()
    );
    assert!(
        store
            .read(&plan.operation_id)
            .unwrap()
            .unwrap()
            .owner_cleanup
            .unwrap()
            .confirmed
    );
}

#[test]
fn endpoint_cleanup_is_bound_to_its_original_endpoint_and_never_invents_a_pid() {
    let (_owned, _root, store) = setup();
    let plan = plan();
    store.begin(&plan).unwrap();
    assert!(
        store
            .record_endpoint_cleanup(&plan.operation_id, "owned-endpoint", true)
            .is_err()
    );
    let dispatch = store
        .before_dispatch(
            &plan.operation_id,
            &plan.scope,
            NativeRemoteStage::Spawn,
            &json!({"expectedName":"kcoder"}),
        )
        .unwrap();
    store
        .receive(
            &dispatch,
            &json!({"ownedEndpointInstanceId":"owned-endpoint"}),
        )
        .unwrap();
    assert!(
        store
            .record_endpoint_cleanup(&plan.operation_id, "other-endpoint", true)
            .is_err()
    );
    assert!(
        store
            .record_owner_cleanup(&plan.operation_id, 123, true)
            .is_err()
    );
    store
        .record_endpoint_cleanup(&plan.operation_id, "owned-endpoint", false)
        .unwrap();
    let before = store.read(&plan.operation_id).unwrap().unwrap();
    assert!(before.owner_cleanup.is_none());
    assert!(!before.endpoint_cleanup.unwrap().confirmed);
    store
        .record_endpoint_cleanup(&plan.operation_id, "owned-endpoint", true)
        .unwrap();
    let after = store.read(&plan.operation_id).unwrap().unwrap();
    assert!(after.endpoint_cleanup.unwrap().confirmed);
    assert!(
        store
            .record_endpoint_cleanup(&plan.operation_id, "owned-endpoint", false)
            .is_err()
    );
    assert!(
        store
            .record_endpoint_cleanup(&plan.operation_id, "other-endpoint", true)
            .is_err()
    );
}

#[test]
fn endpoint_receiver_observation_cannot_become_a_local_accepted_token_or_change_scope() {
    use kcoder_types::integrations::core::{
        NativeRemoteAcceptedFactsV1, NativeRemoteCallOutcomeV1, NativeRemoteTurnIdentityV1,
    };
    let (_owned, _root, store) = setup();
    let plan = plan();
    store.begin(&plan).unwrap();
    let mut scope = plan.scope.clone();
    scope.account_id = "receiver-account".into();
    let actual = NativeRemoteAcceptedFactsV1 {
        identity: NativeRemoteTurnIdentityV1 {
            thread_id: "receiver-thread".into(),
            turn_id: "receiver-turn".into(),
            attempt_id: "receiver-attempt".into(),
        },
        accepted_input_sha256: "a".repeat(64),
        accepted_receipt_sha256: "b".repeat(64),
        receiver_settings_sha256: "c".repeat(64),
        receiver_scope: Some(scope),
    };
    let receiver = NativeRemoteEndpointReceiverObservation {
        endpoint_instance_id: "original-endpoint".into(),
        accepted: actual,
        outcome: None,
        cleanup_confirmed: false,
    };
    assert!(
        store
            .record_endpoint_receiver(&plan.operation_id, &receiver)
            .is_err()
    );
    for (stage, receipt) in [
        (
            NativeRemoteStage::Spawn,
            json!({"ownedEndpointInstanceId":"original-endpoint"}),
        ),
        (NativeRemoteStage::Initialize, json!({"protocolVersion":1})),
        (
            NativeRemoteStage::BindOriginal,
            json!({"data":{"kind":"original_bound","receiverSettingsSha256":"c".repeat(64)}}),
        ),
        (
            NativeRemoteStage::Session,
            json!({"sessionId":"receiver-session"}),
        ),
    ] {
        let permit = store
            .before_dispatch(
                &plan.operation_id,
                &plan.scope,
                stage,
                &json!({"original":true}),
            )
            .unwrap();
        store.receive(&permit, &receipt).unwrap();
    }
    let _prompt = store
        .before_dispatch(
            &plan.operation_id,
            &plan.scope,
            NativeRemoteStage::Prompt,
            &json!({"original":true}),
        )
        .unwrap();
    store
        .record_endpoint_receiver(&plan.operation_id, &receiver)
        .unwrap();
    let observed = store.read(&plan.operation_id).unwrap().unwrap();
    assert!(
        observed.receiver.is_none(),
        "Endpoint data cannot construct a local TurnAttemptStore token"
    );
    assert_eq!(observed.endpoint_receiver.as_ref(), Some(&receiver));
    let mut changed = receiver.clone();
    changed.accepted.receiver_scope.as_mut().unwrap().account_id = "another-account".into();
    assert!(
        store
            .record_endpoint_receiver(&plan.operation_id, &changed)
            .is_err()
    );
    store.unknown(&_prompt).unwrap();
    let close = store
        .before_dispatch(
            &plan.operation_id,
            &plan.scope,
            NativeRemoteStage::OwnerClose,
            &json!({"closeOriginalAccepted":receiver.accepted}),
        )
        .unwrap();
    store.unknown(&close).unwrap();
    assert!(
        store
            .before_dispatch(
                &plan.operation_id,
                &plan.scope,
                NativeRemoteStage::OwnerClose,
                &json!({"closeOriginalAccepted":receiver.accepted})
            )
            .is_err()
    );
    let mut closed = receiver.clone();
    closed.cleanup_confirmed = true;
    store
        .record_endpoint_receiver(&plan.operation_id, &closed)
        .unwrap();
    let observed = store
        .read(&plan.operation_id)
        .unwrap()
        .unwrap()
        .endpoint_receiver
        .unwrap();
    assert!(observed.cleanup_confirmed);
    assert_eq!(
        observed.outcome, None,
        "Cleanup never fabricates a task outcome"
    );
    closed.outcome = Some(NativeRemoteCallOutcomeV1::OutcomeUnknown);
    store
        .record_endpoint_receiver(&plan.operation_id, &closed)
        .unwrap();
    let observed = store
        .read(&plan.operation_id)
        .unwrap()
        .unwrap()
        .endpoint_receiver
        .unwrap();
    assert!(observed.cleanup_confirmed);
    assert_eq!(
        observed.outcome,
        Some(NativeRemoteCallOutcomeV1::OutcomeUnknown)
    );
    closed.outcome = Some(NativeRemoteCallOutcomeV1::Completed);
    store
        .record_endpoint_receiver(&plan.operation_id, &closed)
        .unwrap();
    assert!(
        store
            .record_endpoint_receiver(&plan.operation_id, &receiver)
            .is_err()
    );
}

#[test]
fn recent_observes_only_ten_original_rows_without_dispatching_or_creating_a_task() {
    let (_owned, _root, store) = setup();
    let (empty, total) = store.recent().unwrap();
    assert!(empty.is_empty());
    assert_eq!(total, 0);
    for index in 0..12 {
        let mut value = plan();
        value.operation_id = format!("original-{index}");
        store.begin(&value).unwrap();
    }
    let (rows, total) = store.recent().unwrap();
    assert_eq!(total, 12);
    assert_eq!(rows.len(), 10);
    assert!(
        rows.iter()
            .all(|row| row.stages.is_empty() && row.receiver.is_none())
    );
    let (same, count) = store.recent().unwrap();
    assert_eq!(count, total);
    assert_eq!(
        rows.iter().map(|row| &row.operation_id).collect::<Vec<_>>(),
        same.iter().map(|row| &row.operation_id).collect::<Vec<_>>()
    );
}
