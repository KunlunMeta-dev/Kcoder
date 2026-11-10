//! Batch-limit tests for the automatic dispatch gate.

use super::*;
use kcoder_state::continuous_work::{AppliedInputReference, ClaimTrigger};

fn owned_scope(profile: &std::path::Path) -> WorkScope {
    kcoder_state::continuous_work::HostWorkScope::capture(profile, profile, None)
        .expect("host scope")
        .scope()
        .clone()
}

fn engine_with_turn_budget(profile: &std::path::Path, max_turns: u32) -> QueryEngine {
    let mut settings = kcoder_config::Settings::default();
    settings.continuous_work.dispatch_enabled = true;
    // Business dispatch reads the goal turn budget, not the orchestrate one.
    settings.goal_max_auto_continuations = max_turns as usize;
    let engine = QueryEngine::new_with_folder_trust(
        Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
            crate::tui_dev_mock::TuiDevScenario::FullTurn,
        )),
        kcoder_state::AppState::new(profile),
        kcoder_tools::ToolRegistry::new(),
        kcoder_permissions::PermissionEngine::from_settings(&settings),
        settings,
        kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
        kcoder_skills::SkillRegistry::empty(),
        Arc::new(kcoder_tools::DenyAllUserQuestioner),
        profile.to_path_buf(),
        Some(true),
    );
    engine.with_settings_persistence_path(profile.join("settings.json"))
}

fn verified_facts() -> HostGateFacts {
    HostGateFacts {
        binding: Verification::Verified,
        authority: Verification::Verified,
        turn: TurnObservation::Idle,
        reconciliation: Condition::Clear,
        question: Condition::Clear,
        question_answer_matches: false,
        dependency: Condition::Clear,
        independent_dependency: true,
    }
}

fn prepared_work(directory: &std::path::Path) -> Result<(ContinuousWorkStore, WorkScope), String> {
    let store =
        ContinuousWorkStore::open_or_create(directory).map_err(|error| error.to_string())?;
    let scope = owned_scope(directory);
    let source = WorkInputSource {
        kind: "foreground".into(),
        instance_id: "native-target".into(),
        conversation_id: "thread-1".into(),
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
    .map_err(|error| error.to_string())?;
    store
        .admit(
            &scope,
            work,
            &source,
            "initial-input",
            json!({"text": "original task"}),
            vec![],
        )
        .map_err(|error| error.to_string())?;
    let revision = store
        .read_work(&scope, "work-1")
        .map_err(|error| error.to_string())?
        .ok_or("work missing")?
        .revision;
    let ClaimOutcome::Acquired(receipt) = store
        .claim(
            &scope,
            "work-1",
            revision.revision,
            revision.control_epoch,
            "claim-apply",
            "thread-1",
            ClaimTrigger::Input,
        )
        .map_err(|error| error.to_string())?
    else {
        return Err("initial claim refused".into());
    };
    store
        .mark_input_applied(
            &scope,
            "work-1",
            &source,
            "initial-input",
            "claim-apply",
            receipt.owner_epoch,
            receipt.control_epoch,
            AppliedInputReference {
                attempt: TurnAttemptIdentity {
                    thread_id: "thread-1".into(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                history_uuid: "history-1".into(),
            },
        )
        .map_err(|error| error.to_string())?;
    store
        .release_claim(
            &scope,
            "work-1",
            "claim-apply",
            receipt.owner_epoch,
            ClaimSettlement::Completed,
        )
        .map_err(|error| error.to_string())?;
    Ok((store, scope))
}

/// Business dispatch reads the goal turn budget: once the
/// batch spent it, the next trigger is deferred instead of starting a turn.
#[test]
fn a_spent_batch_turn_budget_defers_the_next_dispatch() {
    let profile = kcoder_config::create_private_temp_dir("work-limit-turns").expect("temp");
    std::fs::write(
        profile.path().join("settings.json"),
        br#"{"continuous_work":{"dispatch_enabled":true},"goal_max_auto_continuations":1}"#,
    )
    .expect("write settings");
    let engine = engine_with_turn_budget(profile.path(), 1);
    let (store, scope) = prepared_work(profile.path()).expect("prepared work");

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
        .expect("automatic claim")
    else {
        panic!("automatic claim must be acquired")
    };
    store
        .release_claim(
            &scope,
            "work-1",
            "claim-auto",
            receipt.owner_epoch,
            ClaimSettlement::Completed,
        )
        .expect("release");
    assert_eq!(
        store
            .read_work(&scope, "work-1")
            .unwrap()
            .unwrap()
            .revision
            .usage
            .automatic_turns,
        1
    );

    match automatic_dispatch_gate(
        &engine,
        "thread-1",
        "claim-next",
        ContinuationScope::Business,
        verified_facts(),
    ) {
        AutomaticDispatchGate::Deferred(reason) => {
            assert!(
                reason.contains("AutomaticTurnLimit"),
                "unexpected reason {reason}"
            );
        }
        AutomaticDispatchGate::Claimed(_) => panic!("the spent budget must not start another turn"),
        AutomaticDispatchGate::Unbound => panic!("the bound work must stay visible"),
    }
    drop(profile);
}
