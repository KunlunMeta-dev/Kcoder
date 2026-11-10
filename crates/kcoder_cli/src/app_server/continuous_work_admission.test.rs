use super::*;
use kcoder_state::continuous_work::{ClaimOutcome, ClaimSettlement, ClaimTrigger, WorkInputSource};
use kcoder_types::continuous_work::{WorkRecord, WorkRevision};
use serde_json::json;

fn source() -> WorkInputSource {
    WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: "thread-1".into(),
    }
}

/// One admitted work item bound to `thread-1` plus a live automatic claim.
fn claimed(
    name: &str,
) -> (
    kcoder_config::PrivateTempDir,
    ContinuousWorkStore,
    WorkScope,
    AutomaticClaimLease,
) {
    let directory = kcoder_config::create_private_temp_dir(name).unwrap();
    let store = ContinuousWorkStore::open_or_create(directory.path()).unwrap();
    let scope = WorkScope {
        account_id: "owned-account".into(),
        target_id: "owned-target".into(),
        workspace_id: "owned-workspace".into(),
    };
    let work: WorkRecord = serde_json::from_value(json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": "work-1"},
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1,
            "controlEpoch": 0, "ownerEpoch": 0, "acceptedInputSequence": 1,
            "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap();
    store
        .admit(
            &scope,
            work,
            &source(),
            "initial-input",
            json!({"text": "original task"}),
            vec![],
        )
        .unwrap();
    let revision = store.read_work(&scope, "work-1").unwrap().unwrap().revision;
    let ClaimOutcome::Acquired(receipt) = store
        .claim(
            &scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-auto",
            "thread-1",
            ClaimTrigger::Automatic,
        )
        .unwrap()
    else {
        panic!("the automatic claim must be acquired");
    };
    let facts = DurableFacts::capture(&store.read_work(&scope, "work-1").unwrap().unwrap());
    let lease = AutomaticClaimLease {
        store: ContinuousWorkStore::open_existing(directory.path())
            .unwrap()
            .unwrap(),
        scope: scope.clone(),
        work_id: "work-1".into(),
        claim_id: receipt.claim_id.clone(),
        owner_epoch: receipt.owner_epoch,
        facts,
        settled: false,
    };
    (directory, store, scope, lease)
}

fn usage(store: &ContinuousWorkStore, scope: &WorkScope) -> WorkRevision {
    store.read_work(scope, "work-1").unwrap().unwrap().revision
}

#[test]
fn a_real_outcome_settles_the_claim_and_clears_the_failure_counter() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-completed");
    assert!(store.active_claim(&scope, "work-1").unwrap().is_some());
    lease.settle(ClaimSettlement::Completed);
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
    assert_eq!(usage(&store, &scope).usage.consecutive_failures, 0);
}

#[test]
fn a_failed_turn_counts_as_one_consecutive_failure() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-failed");
    lease.settle(ClaimSettlement::Failed);
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
    assert_eq!(usage(&store, &scope).usage.consecutive_failures, 1);
}

#[test]
fn an_aborted_turn_releases_the_claim_instead_of_stranding_it() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-abandoned");
    // The spawned task is aborted before it can report an outcome.
    drop(lease);
    assert!(
        store.active_claim(&scope, "work-1").unwrap().is_none(),
        "an aborted automatic turn must not leave the work item fenced forever"
    );
}

#[test]
fn settlement_is_idempotent_and_never_double_releases() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-idempotent");
    let mut lease = lease;
    lease.release(ClaimSettlement::Completed);
    let after_first = usage(&store, &scope);
    lease.release(ClaimSettlement::Failed);
    assert_eq!(
        usage(&store, &scope),
        after_first,
        "a second settlement must not change the durable revision"
    );
}

#[test]
fn a_wait_notice_fires_once_per_distinct_reason() {
    let mut notice = GateWaitNotice::default();
    assert!(notice.changed("wait:DispatchDisabled"));
    assert!(!notice.changed("wait:DispatchDisabled"));
    assert!(notice.changed("wait:Paused"));
    assert!(!notice.changed("wait:Paused"));
    notice.clear();
    assert!(
        notice.changed("wait:Paused"),
        "a later wait after a successful pass is new information"
    );
}

#[test]
fn wait_copy_names_the_real_reason_and_keeps_the_machine_tag() {
    let disabled = gate_wait_message("wait:DispatchDisabled");
    assert!(disabled.starts_with("[continuous_work_dispatch_wait] "));
    assert!(disabled.contains("dispatch valve is off"));
    assert!(disabled.contains("No model turn was started"));

    assert!(gate_wait_message("wait:AutomaticTurnLimit").contains("automatic turns"));
    assert!(gate_wait_message("existing-active:claim-7").contains("reconciled"));
    assert!(gate_wait_message("multiple-bindings").contains("more than one work item"));
    // An unmapped reason must still reach the operator verbatim.
    assert!(gate_wait_message("some-new-reason").contains("some-new-reason"));
}

fn pinned_work(run_id: &str) -> WorkRecord {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {
            "scope": {"accountId": "account-1", "targetId": "target-1", "workspaceId": "workspace-1"},
            "workId": "work-1"
        },
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": "running",
        "revision": {"revision": 4, "requirementsRevision": 2,
            "controlEpoch": 1, "ownerEpoch": 5, "acceptedInputSequence": 3,
            "requiredInputSequence": 2, "appliedInputSequence": 2},
        "nativeRefs": [{
            "kind": "background",
            "parentAttempt": {"threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"},
            "run": {"parentSessionId": "thread-1", "agentId": "agent-1", "runId": run_id},
            "runKind": "subagent"
        }]
    }))
    .unwrap()
}

#[test]
fn only_the_pinned_run_supplies_the_parent_attempt() {
    let work = pinned_work("run-1");
    let matching = kcoder_types::BackgroundRunKey {
        parent_session_id: "thread-1".into(),
        agent_id: "agent-1".into(),
        run_id: "run-1".into(),
    };
    assert_eq!(
        pinned_background_attempt(&work, &matching).map(|attempt| attempt.attempt_id),
        Some("attempt-1".into())
    );

    let other_run = kcoder_types::BackgroundRunKey {
        run_id: "run-2".into(),
        ..matching.clone()
    };
    assert!(pinned_background_attempt(&work, &other_run).is_none());

    let unpinned: WorkRecord = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {
            "scope": {"accountId": "account-1", "targetId": "target-1", "workspaceId": "workspace-1"},
            "workId": "work-1"
        },
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": "running",
        "revision": {"revision": 1, "requirementsRevision": 1,
            "controlEpoch": 0, "ownerEpoch": 0, "acceptedInputSequence": 1,
            "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap();
    assert!(pinned_background_attempt(&unpinned, &matching).is_none());
}

#[test]
fn a_workflow_pin_is_recognised_but_never_becomes_a_result_locator() {
    let work: WorkRecord = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {
            "scope": {"accountId": "account-1", "targetId": "target-1", "workspaceId": "workspace-1"},
            "workId": "work-1"
        },
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": "thread-1", "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": ["thread-1"],
        "phase": "running",
        "revision": {"revision": 4, "requirementsRevision": 2,
            "controlEpoch": 1, "ownerEpoch": 5, "acceptedInputSequence": 3,
            "requiredInputSequence": 2, "appliedInputSequence": 2},
        "nativeRefs": [{
            "kind": "workflow",
            "threadId": "thread-1",
            "runId": "wf-run-1",
            "revision": 3,
            "resumeCount": 0
        }]
    }))
    .unwrap();
    let run = kcoder_types::BackgroundRunKey {
        parent_session_id: "thread-1".into(),
        agent_id: "agents".into(),
        run_id: "wf-run-1".into(),
    };
    assert!(pins_workflow_run(&work, &run));
    // A workflow pin never supplies a parent attempt, so no result is recorded.
    assert!(pinned_background_attempt(&work, &run).is_none());

    let other = kcoder_types::BackgroundRunKey {
        run_id: "wf-run-2".into(),
        ..run.clone()
    };
    assert!(!pins_workflow_run(&work, &other));
}

/// A real engine whose settings persistence path and work store share one
/// private profile, so the host gate resolves the same scope a server would.
fn gate_engine(
    profile: &std::path::Path,
    workspace: &std::path::Path,
    dispatch_enabled: bool,
) -> QueryEngine {
    let mut settings = kcoder_config::Settings::default();
    settings.continuous_work.dispatch_enabled = dispatch_enabled;
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(workspace),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.to_path_buf(),
        Some(true),
    );
    engine.with_settings_persistence_path(profile.join("settings.json"))
}

fn gate_fixture(
    name: &str,
    dispatch_enabled: bool,
) -> (
    kcoder_config::PrivateTempDir,
    QueryEngine,
    ContinuousWorkStore,
    WorkScope,
) {
    let profile = kcoder_config::create_private_temp_dir(name).unwrap();
    let workspace = profile.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let engine = gate_engine(profile.path(), &workspace, dispatch_enabled);
    let store = ContinuousWorkStore::open_or_create(profile.path()).unwrap();
    // The gate derives its scope from the captured host; the fixture must bind
    // the work item under exactly that scope or nothing is found.
    let host = HostWorkScope::capture(profile.path(), &workspace, None).unwrap();
    let scope = host.scope().clone();
    (profile, engine, store, scope)
}

#[test]
fn a_closed_valve_defers_the_host_gate_without_claiming_the_work() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-valve-off", false);
    let thread_id = engine.session_id();
    let work: WorkRecord = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": "work-1"},
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": thread_id, "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": [thread_id],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1,
            "controlEpoch": 0, "ownerEpoch": 0, "acceptedInputSequence": 1,
            "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap();
    store
        .admit(
            &scope,
            work,
            &WorkInputSource {
                kind: "foreground".into(),
                instance_id: "native-target".into(),
                conversation_id: thread_id.clone(),
            },
            "initial-input",
            json!({"text": "original task"}),
            vec![],
        )
        .unwrap();

    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-off",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => {
            assert_eq!(reason, "wait:DispatchDisabled");
        }
        _ => panic!("a closed valve must defer before any claim"),
    }
    assert!(
        store.active_claim(&scope, "work-1").unwrap().is_none(),
        "a deferred dispatch must not hold a claim"
    );

    // A deferred dispatch is read-only: repeating it must not consume the batch
    // budget, bump the revision or leave a claim behind.
    let before = store.read_work(&scope, "work-1").unwrap().unwrap().revision;
    for attempt in 0..3 {
        match automatic_dispatch_gate(
            &engine,
            &thread_id,
            &format!("claim-off-{attempt}"),
            ContinuationScope::Business,
            automatic_gate_facts(0, false),
        ) {
            AutomaticDispatchGate::Deferred(reason) => {
                assert_eq!(reason, "wait:DispatchDisabled")
            }
            _ => panic!("a closed valve must keep deferring"),
        }
    }
    let after = store.read_work(&scope, "work-1").unwrap().unwrap().revision;
    assert_eq!(
        after, before,
        "waiting must not advance the revision or the batch counters"
    );
    assert_eq!(after.usage.automatic_turns, 0);
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
    drop(profile);
}

#[test]
fn an_open_valve_claims_the_bound_work_and_releases_it_again() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-valve-on", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    let work: WorkRecord = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": "work-1"},
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": thread_id, "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": [thread_id],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1,
            "controlEpoch": 0, "ownerEpoch": 0, "acceptedInputSequence": 1,
            "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap();
    store
        .admit(
            &scope,
            work,
            &source,
            "initial-input",
            json!({"text": "original task"}),
            vec![],
        )
        .unwrap();

    // An unapplied accepted input still fences the automatic dispatch.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-early",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => assert_eq!(reason, "wait:InputPending"),
        _ => panic!("unapplied input must not be overtaken"),
    }

    // Apply the accepted input under its own claim, as the foreground turn does.
    let revision = store.read_work(&scope, "work-1").unwrap().unwrap().revision;
    let kcoder_state::continuous_work::ClaimOutcome::Acquired(input) = store
        .claim(
            &scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-input",
            &thread_id,
            kcoder_state::continuous_work::ClaimTrigger::Input,
        )
        .unwrap()
    else {
        panic!("the input claim must be acquired");
    };
    store
        .mark_input_applied(
            &scope,
            "work-1",
            &source,
            "initial-input",
            "claim-input",
            input.owner_epoch,
            input.control_epoch,
            kcoder_state::continuous_work::AppliedInputReference {
                attempt: kcoder_types::TurnAttemptIdentity {
                    thread_id: thread_id.clone(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                history_uuid: "history-1".into(),
            },
        )
        .unwrap();
    store
        .release_claim(
            &scope,
            "work-1",
            "claim-input",
            input.owner_epoch,
            ClaimSettlement::Abandoned,
        )
        .unwrap();

    let lease = match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-auto",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Claimed(lease) => lease,
        other => panic!(
            "an applied input must let the host claim the work, got {}",
            match other {
                AutomaticDispatchGate::Unbound => "unbound".to_string(),
                AutomaticDispatchGate::Deferred(reason) => reason,
                AutomaticDispatchGate::Claimed(_) => "claimed".to_string(),
            }
        ),
    };
    assert!(store.active_claim(&scope, "work-1").unwrap().is_some());
    // A second trigger while the claim is live must not start another turn.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-auto-2",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => {
            // Any deferral means no second turn; the label depends on whether the
            // live claim is rediscovered or the acquire path refuses first.
            assert!(!reason.is_empty(), "a deferral must carry a reason");
        }
        AutomaticDispatchGate::Claimed(_) => {
            panic!("a live claim must not be granted a second time")
        }
        AutomaticDispatchGate::Unbound => panic!("the bound work must stay visible"),
    }
    lease.settle(ClaimSettlement::Completed);
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
    drop(profile);
}

/// Admit one work item bound to `thread_id` and apply its accepted input under
/// the explicit-input claim, exactly as the foreground turn does.
fn admit_and_apply(
    store: &ContinuousWorkStore,
    scope: &WorkScope,
    thread_id: &str,
    source: &WorkInputSource,
) {
    let work: WorkRecord = serde_json::from_value(serde_json::json!({
        "schemaVersion": 1,
        "identity": {"scope": scope, "workId": "work-1"},
        "origin": {"kind": "foreground", "initialAttempt": {
            "threadId": thread_id, "turnId": "turn-1", "attemptId": "attempt-1"
        }},
        "linkedThreadIds": [thread_id],
        "phase": "pending",
        "revision": {"revision": 1, "requirementsRevision": 1,
            "controlEpoch": 0, "ownerEpoch": 0, "acceptedInputSequence": 1,
            "requiredInputSequence": 1, "appliedInputSequence": 0}
    }))
    .unwrap();
    store
        .admit(
            scope,
            work,
            source,
            "initial-input",
            json!({"text": "original task"}),
            vec![],
        )
        .unwrap();
    let revision = store.read_work(scope, "work-1").unwrap().unwrap().revision;
    let kcoder_state::continuous_work::ClaimOutcome::Acquired(input) = store
        .claim(
            scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-input",
            thread_id,
            kcoder_state::continuous_work::ClaimTrigger::Input,
        )
        .unwrap()
    else {
        panic!("the input claim must be acquired");
    };
    store
        .mark_input_applied(
            scope,
            "work-1",
            source,
            "initial-input",
            "claim-input",
            input.owner_epoch,
            input.control_epoch,
            kcoder_state::continuous_work::AppliedInputReference {
                attempt: kcoder_types::TurnAttemptIdentity {
                    thread_id: thread_id.to_string(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                history_uuid: "history-1".into(),
            },
        )
        .unwrap();
    store
        .release_claim(
            scope,
            "work-1",
            "claim-input",
            input.owner_epoch,
            ClaimSettlement::Abandoned,
        )
        .unwrap();
}

#[test]
fn two_concurrent_host_dispatches_acquire_exactly_one_claim() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-race", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);

    let profile_path = profile.path().to_path_buf();
    let workspace = profile_path.join("workspace");
    // Two independent hosts on the same profile race for the same work item.
    // Both attempt before the winner settles: a claim settled before the other
    // host even tried is legitimately claimable again (see the end of this test),
    // so without the barrier a slow second host would read as a double claim.
    let attempted = std::sync::Barrier::new(2);
    let outcomes: Vec<String> = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for index in 0..2 {
            let profile_path = profile_path.clone();
            let workspace = workspace.clone();
            let thread_id = thread_id.clone();
            let attempted = &attempted;
            handles.push(scope.spawn(move || {
                let engine = gate_engine(&profile_path, &workspace, true);
                let gate = automatic_dispatch_gate(
                    &engine,
                    &thread_id,
                    &format!("claim-race-{index}"),
                    ContinuationScope::Business,
                    automatic_gate_facts(0, false),
                );
                attempted.wait();
                match gate {
                    AutomaticDispatchGate::Claimed(lease) => {
                        lease.settle(ClaimSettlement::Completed);
                        "claimed".to_string()
                    }
                    AutomaticDispatchGate::Deferred(reason) => format!("deferred:{reason}"),
                    AutomaticDispatchGate::Unbound => "unbound".to_string(),
                }
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });

    let claimed = outcomes
        .iter()
        .filter(|outcome| *outcome == "claimed")
        .count();
    // The loser sees whichever contention the interleaving produces: an active
    // claim (ALREADY_CLAIMED/CLAIM_STALE) or a revision that moved first.
    let deferred = outcomes
        .iter()
        .filter(|outcome| {
            outcome.starts_with("deferred:existing-active") || *outcome == "deferred:claim-stale"
        })
        .count();
    assert_eq!(
        (claimed, deferred),
        (1, 1),
        "exactly one dispatch may hold the claim, got {outcomes:?}"
    );
    assert!(
        store.active_claim(&scope, "work-1").unwrap().is_none(),
        "the winner's settlement must release the claim"
    );

    // After settlement the same work item is claimable again.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-race-next",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Claimed(lease) => lease.settle(ClaimSettlement::Completed),
        other => panic!(
            "a settled claim must free the work item, got {}",
            match other {
                AutomaticDispatchGate::Unbound => "unbound".to_string(),
                AutomaticDispatchGate::Deferred(reason) => reason,
                AutomaticDispatchGate::Claimed(_) => "claimed".to_string(),
            }
        ),
    }
    drop(profile);
}

#[test]
fn a_completed_turn_without_a_durable_fact_counts_as_a_stalled_round() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-stalled");
    lease.settle_after_turn("completed");
    assert!(store.active_claim(&scope, "work-1").unwrap().is_none());
    let revision = usage(&store, &scope);
    assert_eq!(
        revision.usage.stalled_rounds, 1,
        "no new input, requirement, native pin or result means no progress"
    );
    assert_eq!(revision.usage.consecutive_failures, 0);
}

#[test]
fn a_completed_turn_that_records_a_result_keeps_the_batch_healthy() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-progress");
    let work = store.read_work(&scope, "work-1").unwrap().unwrap();
    let basis = kcoder_types::continuous_work::ResultBasis {
        requirements_revision: work.revision.requirements_revision,
        control_epoch: work.revision.control_epoch,
        owner_epoch: work.revision.owner_epoch,
        applied_input_sequence: work.revision.applied_input_sequence,
    };
    store
        .record_result(
            &scope,
            "work-1",
            work.revision.revision,
            kcoder_types::continuous_work::WorkResult {
                result_id: "turn-result-1".into(),
                basis,
                artifact_refs: vec!["artifact-1".into()],
                evidence_refs: vec!["evidence-1".into()],
                required_delivery_ids: vec![],
            },
        )
        .unwrap();
    lease.settle_after_turn("completed");
    let revision = usage(&store, &scope);
    assert_eq!(
        revision.usage.stalled_rounds, 0,
        "a recorded result is durable progress"
    );
    assert_eq!(revision.usage.consecutive_failures, 0);
}

#[test]
fn a_failed_turn_counts_as_a_failure_and_never_as_a_stall() {
    let (_directory, store, scope, lease) = claimed("continuous-lease-failed-settle");
    lease.settle_after_turn("failed");
    let revision = usage(&store, &scope);
    assert_eq!(revision.usage.consecutive_failures, 1);
    assert_eq!(revision.usage.stalled_rounds, 0);
}

#[test]
fn five_unproductive_turns_reach_the_no_progress_limit() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-stall-limit", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);

    // Every turn completes but adds no durable fact: the batch must move from
    // "admitted" to "stopped by the no-progress limit" instead of looping.
    for round in 0..5 {
        match automatic_dispatch_gate(
            &engine,
            &thread_id,
            &format!("claim-stall-{round}"),
            ContinuationScope::Business,
            automatic_gate_facts(0, false),
        ) {
            AutomaticDispatchGate::Claimed(lease) => lease.settle_after_turn("completed"),
            other => panic!(
                "round {round} must still be admitted, got {}",
                match other {
                    AutomaticDispatchGate::Unbound => "unbound".to_string(),
                    AutomaticDispatchGate::Deferred(reason) => reason,
                    AutomaticDispatchGate::Claimed(_) => "claimed".to_string(),
                }
            ),
        }
    }
    assert_eq!(usage(&store, &scope).usage.stalled_rounds, 5);

    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-stall-next",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => assert!(
            reason.contains("StallLimit"),
            "the no-progress limit must fence the batch, got {reason}"
        ),
        _ => panic!("a stalled batch must not be dispatched again"),
    }

    // Hitting a limit is not completion, and waiting is not a failure.
    let work = store.read_work(&scope, "work-1").unwrap().unwrap();
    assert_ne!(
        work.phase,
        kcoder_types::continuous_work::WorkPhase::Completed,
        "a fenced batch must not be reported as completed"
    );
    assert!(
        work.result.is_none(),
        "no result may be recorded just because the batch stopped"
    );
    assert_eq!(
        work.revision.usage.consecutive_failures, 0,
        "waiting must not be counted as a failure"
    );
    drop(profile);
}

/// Find the durable work file under a private profile.
fn corrupt_work_store(profile: &std::path::Path) {
    let mut stack = vec![profile.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|name| name == "state.json") {
                std::fs::write(&path, b"{ not json").unwrap();
                return;
            }
        }
    }
    panic!("the work store file was not found under the profile");
}

#[test]
fn an_unreadable_store_defers_instead_of_panicking() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-corrupt", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);
    drop(store);
    corrupt_work_store(profile.path());

    // A store the host cannot parse must stop automatic dispatch with a reason,
    // never dispatch optimistically and never crash the scheduler.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-corrupt",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => {
            assert_eq!(
                reason, "store-unavailable",
                "an unreadable store is not an empty one"
            );
            assert!(gate_wait_message(&reason).contains("cannot verify the work state"));
        }
        _ => panic!("an unreadable store must defer"),
    }
    drop(profile);
}

/// The host gate must never reach the provider: waiting is not a model turn.
fn gate_engine_with_counter(
    profile: &std::path::Path,
    workspace: &std::path::Path,
    dispatch_enabled: bool,
) -> (QueryEngine, Arc<crate::tui_dev_mock::MockScenarioProvider>) {
    let mut settings = kcoder_config::Settings::default();
    settings.continuous_work.dispatch_enabled = dispatch_enabled;
    let provider = Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
        crate::tui_dev_mock::TuiDevScenario::FullTurn,
    ));
    let engine = QueryEngine::new_with_folder_trust(
        Arc::clone(&provider) as Arc<dyn kcoder_api::Provider>,
        kcoder_state::AppState::new(workspace),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        workspace.to_path_buf(),
        Some(true),
    );
    (
        engine.with_settings_persistence_path(profile.join("settings.json")),
        provider,
    )
}

#[test]
fn deferring_never_reaches_the_model() {
    let profile = kcoder_config::create_private_temp_dir("continuous-gate-no-model").unwrap();
    let workspace = profile.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let (engine, provider) = gate_engine_with_counter(profile.path(), &workspace, false);
    let store = ContinuousWorkStore::open_or_create(profile.path()).unwrap();
    let host =
        kcoder_state::continuous_work::HostWorkScope::capture(profile.path(), &workspace, None)
            .unwrap();
    let scope = host.scope().clone();
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);

    for round in 0..3 {
        match automatic_dispatch_gate(
            &engine,
            &thread_id,
            &format!("claim-no-model-{round}"),
            ContinuationScope::Business,
            automatic_gate_facts(0, false),
        ) {
            AutomaticDispatchGate::Deferred(reason) => {
                assert_eq!(reason, "wait:DispatchDisabled")
            }
            _ => panic!("a closed valve must defer"),
        }
    }
    assert_eq!(
        provider.requests(),
        0,
        "waiting for the gate must not issue a model request"
    );
    drop(profile);
}

#[test]
fn a_stop_is_accepted_while_the_claim_is_held_and_fences_the_next_dispatch() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-stop-during-claim", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);

    let lease = match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-stop-1",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Claimed(lease) => lease,
        _ => panic!("the first dispatch must be admitted"),
    };

    // A claim occupies the execution slot, but it must not hold a store
    // transaction: an operator stop has to be accepted right away.
    let revision = usage(&store, &scope).revision;
    let receipt = store
        .control(
            &scope,
            "work-1",
            revision,
            "stop-request-1",
            kcoder_types::continuous_work::WorkControlAction::Stop,
            kcoder_types::continuous_work::WorkControlTarget::Work {},
        )
        .expect("a stop must be accepted while a claim is held");
    assert!(receipt.control_epoch > 0);
    lease.settle(ClaimSettlement::Completed);

    // The stop must fence the next dispatch instead of stalling it forever.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-stop-2",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => assert!(
            reason.contains("Control") || reason.contains("Stop"),
            "the stop must be reported, got {reason}"
        ),
        _ => panic!("a stopped work item must not be dispatched"),
    }
    drop(profile);
}

#[test]
fn a_result_arriving_while_paused_is_kept_and_starts_no_new_work() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-pause-result", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);

    // One admitted turn, then the operator pauses the work item.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-before-pause",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Claimed(lease) => lease.settle(ClaimSettlement::Completed),
        _ => panic!("the first dispatch must be admitted"),
    }
    let revision = usage(&store, &scope).revision;
    store
        .control(
            &scope,
            "work-1",
            revision,
            "pause-request-1",
            kcoder_types::continuous_work::WorkControlAction::Pause,
            kcoder_types::continuous_work::WorkControlTarget::Work {},
        )
        .expect("a pause must be accepted");

    // A result that arrives meanwhile must still be recorded.
    let work = store.read_work(&scope, "work-1").unwrap().unwrap();
    let basis = kcoder_types::continuous_work::ResultBasis {
        requirements_revision: work.revision.requirements_revision,
        control_epoch: work.revision.control_epoch,
        owner_epoch: work.revision.owner_epoch,
        applied_input_sequence: work.revision.applied_input_sequence,
    };
    store
        .record_result(
            &scope,
            "work-1",
            work.revision.revision,
            kcoder_types::continuous_work::WorkResult {
                result_id: "paused-result-1".into(),
                basis,
                artifact_refs: vec!["artifact-paused".into()],
                evidence_refs: vec!["evidence-paused".into()],
                required_delivery_ids: vec![],
            },
        )
        .expect("a paused work item must still accept a result");

    // Pausing must not start anything, and the recorded result must survive.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-while-paused",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => assert!(
            reason.contains("Pause") || reason.contains("Control"),
            "a paused item must not be dispatched, got {reason}"
        ),
        _ => panic!("a paused work item must not start a turn"),
    }
    let after = store.read_work(&scope, "work-1").unwrap().unwrap();
    assert_eq!(
        after
            .result
            .as_ref()
            .map(|result| result.result_id.as_str()),
        Some("paused-result-1"),
        "the result recorded while paused must be kept"
    );
    drop(profile);
}

/// The observable session surface a continuation must never rewrite.
fn session_surface(engine: &QueryEngine) -> (serde_json::Value, Vec<String>) {
    let settings = serde_json::to_value(&*engine.settings.read().unwrap()).unwrap();
    let mut tools = engine.tools.names();
    tools.sort();
    (settings, tools)
}

#[test]
fn automatic_dispatch_keeps_the_orchestrate_contract_and_the_session_surface() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-surface", true);
    // The old orchestrate limits must still be the ones in force.
    {
        let mut settings = engine.settings.write().unwrap();
        settings.orchestrate.continuation.max_auto_turns = 3;
    }
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);
    let before = session_surface(&engine);

    // The orchestrate continuation contract still admits one claim, and the
    // whole session surface must be identical afterwards.
    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-surface-1",
        ContinuationScope::Orchestrate,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Claimed(lease) => lease.settle(ClaimSettlement::Completed),
        _ => panic!("the orchestrate contract must still admit the dispatch"),
    }
    let _ = automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-surface-2",
        ContinuationScope::Orchestrate,
        automatic_gate_facts(1, false),
    );

    let after = session_surface(&engine);
    assert_eq!(
        before.0["orchestrate"], after.0["orchestrate"],
        "the orchestrate mode configuration must not change"
    );
    assert_eq!(
        before.0["tools"], after.0["tools"],
        "tool configuration changed"
    );
    assert_eq!(before.1, after.1, "the available tool set must not change");
    assert_eq!(
        before.0, after.0,
        "no setting may change on the dispatch path"
    );
    drop(profile);
}

#[test]
fn three_failed_turns_reach_the_consecutive_failure_limit() {
    let (profile, engine, store, scope) = gate_fixture("continuous-gate-failure-limit", true);
    let thread_id = engine.session_id();
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: thread_id.clone(),
    };
    admit_and_apply(&store, &scope, &thread_id, &source);

    // Failed turns accumulate on their own counter, independently of stalls.
    for round in 0..3 {
        match automatic_dispatch_gate(
            &engine,
            &thread_id,
            &format!("claim-fail-{round}"),
            ContinuationScope::Business,
            automatic_gate_facts(0, false),
        ) {
            AutomaticDispatchGate::Claimed(lease) => lease.settle_after_turn("failed"),
            other => panic!(
                "round {round} must still be admitted, got {}",
                match other {
                    AutomaticDispatchGate::Unbound => "unbound".to_string(),
                    AutomaticDispatchGate::Deferred(reason) => reason,
                    AutomaticDispatchGate::Claimed(_) => "claimed".to_string(),
                }
            ),
        }
    }
    let usage = usage(&store, &scope).usage;
    assert_eq!(usage.consecutive_failures, 3);
    assert_eq!(usage.stalled_rounds, 0, "failures are not stalls");

    match automatic_dispatch_gate(
        &engine,
        &thread_id,
        "claim-fail-next",
        ContinuationScope::Business,
        automatic_gate_facts(0, false),
    ) {
        AutomaticDispatchGate::Deferred(reason) => assert!(
            reason.contains("FailureLimit"),
            "the failure limit must fence the batch, got {reason}"
        ),
        _ => panic!("a batch at its failure limit must not be dispatched"),
    }

    // Hitting the failure limit still is not completion.
    let work = store.read_work(&scope, "work-1").unwrap().unwrap();
    assert_ne!(
        work.phase,
        kcoder_types::continuous_work::WorkPhase::Completed,
        "a fenced batch must not be reported as completed"
    );
    assert!(work.result.is_none());
    drop(profile);
}
