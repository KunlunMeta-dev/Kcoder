//! Real Goal sidecars and actual original NativeBudgetStore/Accepted receipts.
use super::*;
use crate::integrations::core::budgets::*;
use crate::turn_attempt_store::TurnAttemptCompletion;
use kcoder_config::PrivateDirectory;
use kcoder_types::{Message, integrations::core::*};
use std::ffi::OsStr;

struct Fixture {
    _temp: tempfile::TempDir,
    state: AppState,
    ledger: Arc<NativeBudgetStore>,
    attempts: Arc<TurnAttemptStore>,
    principal: NativeBudgetPrincipal,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::new(temp.path());
        state.with_history_path(temp.path().join(format!("{}.jsonl", state.session_id())));
        state.add_message(Message::user_text("actual owned Goal accounting"));
        state.save_history().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
        let private = parent
            .create_private_child(OsStr::new("owned-native-account"))
            .unwrap();
        let scope = IntegrationScope {
            account_id: "native-account".into(),
            target_id: "native-target".into(),
            workspace_id: IntegrationNullable::Null,
            identity_generation: "native-generation".into(),
            target_revision: "native-config".into(),
            organization_id: None,
        };
        let ledger =
            Arc::new(NativeBudgetStore::create_in(&private, OsStr::new("ledger"), &scope).unwrap());
        let sessions = parent.create_private_child(OsStr::new("sessions")).unwrap();
        sessions
            .create_private_child(OsStr::new(&state.session_id()))
            .unwrap();
        let attempts = Arc::new(
            TurnAttemptStore::open(
                &temp.path().join("sessions").join(state.session_id()),
                &state.session_id(),
            )
            .unwrap(),
        );
        let principal =
            NativeBudgetPrincipal::from_native_facts(scope.account_id, None, None, None).unwrap();
        Self {
            _temp: temp,
            state,
            ledger,
            attempts,
            principal,
        }
    }
    fn task(&self, suffix: &str, tokens: u64) -> NativeGoalTaskBudgetBinding {
        let identity = TurnAttemptIdentity {
            thread_id: self.state.session_id(),
            turn_id: format!("turn-{suffix}"),
            attempt_id: format!("attempt-{suffix}"),
        };
        let accepted = TurnAttemptRecord {
            client_presentation: None,
            version: 1,
            identity: identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: "c".repeat(64),
            request_fingerprint: None,
            retained_input: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        };
        self.attempts.begin(accepted.clone()).unwrap();
        let root = format!("ordinary-root-{suffix}");
        let task = IntegrationEntityRef {
            kind: IntegrationEntityKind::Turn,
            id: identity.turn_id,
            revision: None,
        };
        let policy = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: POLICY.into(),
            version: 1,
            revision: "actual-profile-r1".into(),
            scope: BudgetScope::Task(root.clone()),
            window: BudgetWindow {
                id: format!("window-{suffix}"),
                starts_at_ms: 0,
                ends_at_ms: 1000,
            },
            limits: BudgetLimits {
                tokens: Some(tokens),
                model_calls: Some(3),
                concurrent_calls: Some(3),
                concurrent_tasks: Some(1),
                ..Default::default()
            },
            currency: None,
        })
        .unwrap();
        self.ledger
            .reserve(
                &NativeBudgetRequest {
                    reservation_id: format!("slot-{suffix}"),
                    operation_id: root.clone(),
                    principal: self.principal.clone(),
                    unit: BudgetUnit::TaskSlot,
                    task: BudgetTaskLink {
                        root_operation_id: root.clone(),
                        root_task: Some(task.clone()),
                        actor: BudgetActor::Main,
                        actor_attempt_id: identity.attempt_id,
                        parent_reservation_id: None,
                    },
                    estimate: BudgetCharge::zero(),
                },
                &[policy],
                1,
            )
            .unwrap();
        let actual_binding = NativeBudgetTaskBinding::from_authoritative_receipt(
            root,
            task,
            format!("actual-accept-{suffix}"),
            "a".repeat(64),
        )
        .unwrap();
        let parent = self
            .ledger
            .original_active_task_slot(&self.principal, &actual_binding)
            .unwrap()
            .unwrap();
        NativeGoalTaskBudgetBinding::capture(
            self.ledger.clone(),
            &parent,
            self.attempts.clone(),
            &accepted,
        )
        .unwrap()
    }
    fn finish(&self, binding: &NativeGoalTaskBudgetBinding) {
        self.attempts
            .finish(
                &binding.accepted.identity,
                TurnAttemptCompletion {
                    status: TurnAttemptStatus::Completed,
                    finished_at_ms: 3,
                    error: None,
                    provider_failure: None,
                    partial_output: String::new(),
                    partial_output_truncated: false,
                    committed_history_uuid: None,
                },
            )
            .unwrap();
        let receipt = self
            .ledger
            .read_reservation(&binding.facts.slot_id)
            .unwrap()
            .unwrap();
        let terminal = NativeBudgetTerminal::from_authoritative_receipt(
            receipt.operation_id.clone(),
            receipt.task.root_task.clone(),
            receipt.task.actor_attempt_id.clone(),
            "actual-source-terminal".into(),
            "b".repeat(64),
            BudgetTerminalKind::Completed,
        )
        .unwrap();
        self.ledger
            .record_usage(
                &receipt.reservation_id,
                receipt.revision,
                "actual-source-terminal",
                &NativeBudgetUsage {
                    coverage: BudgetUsageCoverage::Complete,
                    known: BudgetCharge::zero(),
                },
                Some(&terminal),
                3,
            )
            .unwrap();
    }
}

#[test]
fn same_original_task_is_held_once_and_stale_snapshots_cannot_erase_the_hold() {
    let f = Fixture::new();
    let goal = f.state.set_goal("original product Goal", Some(100));
    let stale = f.state.goal();
    let binding = f.task("original", 80);
    f.state
        .reserve_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    f.state
        .reserve_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    assert_eq!(f.state.goal().unwrap().tokens_used, 80);
    f.state.write_inner().goal = stale;
    f.state.persist_latest_session_state();
    let actual = load_session_state(&f.state.session_state_path().unwrap())
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(actual.tokens_used, 80);
    assert_eq!(actual.native_task_budget_holds.len(), 1);
    let restored: Goal = serde_json::from_value(serde_json::to_value(actual).unwrap()).unwrap();
    assert_eq!(restored.native_task_budget_holds.len(), 1);
}

#[test]
fn independent_stale_states_share_the_original_durable_goal_balance() {
    let f = Fixture::new();
    let goal = f.state.set_goal("one original durable balance", Some(100));
    let first = f.task("one", 60);
    let second = f.task("two", 60);
    let stale = AppState::new(f._temp.path());
    stale
        .resume_from_history(&f.state.read_inner().history_path.clone().unwrap())
        .unwrap();
    f.state
        .reserve_goal_native_task_budget(&goal.goal_id, &first)
        .unwrap();
    // An independently restored AppState recalculates from the actual sidecar.
    let error = stale
        .reserve_goal_native_task_budget(&goal.goal_id, &second)
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("GOAL_NATIVE_TOKEN_BUDGET_EXHAUSTED")
    );
    let actual = load_session_state(&f.state.session_state_path().unwrap())
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(actual.tokens_used, 60);
    assert_eq!(actual.native_task_budget_holds.len(), 1);
}

#[test]
fn only_real_source_terminal_and_closed_original_calls_can_release_unused_goal_tokens() {
    let f = Fixture::new();
    let goal = f.state.set_goal("actual source terminal", Some(100));
    let binding = f.task("terminal", 80);
    f.state
        .reserve_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    assert!(
        f.state
            .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
            .is_err()
    );
    assert_eq!(f.state.goal().unwrap().tokens_used, 80);
    f.finish(&binding);
    f.state
        .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    f.state
        .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    assert_eq!(f.state.goal().unwrap().tokens_used, 0);
    let other = f.state.set_goal("new product Goal generation", Some(500));
    assert!(
        f.state
            .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
            .is_err()
    );
    assert_eq!(f.state.goal().unwrap().goal_id, other.goal_id);
    assert_eq!(f.state.goal().unwrap().tokens_used, 0);
}

#[test]
fn unknown_dispatched_original_child_is_not_refunded_when_the_source_finishes() {
    let f = Fixture::new();
    let goal = f
        .state
        .set_goal("retain actual unknown remote model usage", Some(100));
    let binding = f.task("unknown", 80);
    f.state
        .reserve_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    let policies = f
        .ledger
        .current_applicable_policies(&f.principal, &binding.slot.operation_id, 2)
        .unwrap();
    let mut task = binding.slot.task.clone();
    task.actor = BudgetActor::ChildAgent;
    task.actor_attempt_id = "actual-receiver-attempt".into();
    task.parent_reservation_id = Some(binding.slot.reservation_id.clone());
    let child = f
        .ledger
        .reserve(
            &NativeBudgetRequest {
                reservation_id: "actual-unknown-child".into(),
                operation_id: "actual-child-operation".into(),
                principal: f.principal.clone(),
                unit: BudgetUnit::ModelCall,
                task,
                estimate: BudgetCharge {
                    tokens: 40,
                    model_calls: 1,
                    run_millis: 10,
                    cost_micros: None,
                },
            },
            &policies,
            2,
        )
        .unwrap();
    let dispatch = f
        .ledger
        .mark_dispatched(
            &child.receipt().reservation_id,
            child.receipt().revision,
            &policies,
            2,
        )
        .unwrap();
    let BudgetDispatchResult::Fresh(dispatched) = dispatch else {
        panic!("actual original dispatch required")
    };
    f.finish(&binding);
    f.state
        .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    assert_eq!(
        f.state.goal().unwrap().tokens_used,
        80,
        "a live unknown child retains the complete Goal hold"
    );
    let terminal = NativeBudgetTerminal::from_authoritative_receipt(
        dispatched.operation_id.clone(),
        dispatched.task.root_task.clone(),
        dispatched.task.actor_attempt_id.clone(),
        "actual-child-cancelled".into(),
        "d".repeat(64),
        BudgetTerminalKind::Cancelled,
    )
    .unwrap();
    f.ledger
        .record_usage(
            &dispatched.reservation_id,
            dispatched.revision,
            "actual-owned-child-terminal",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Unreported,
                known: BudgetCharge::zero(),
            },
            Some(&terminal),
            4,
        )
        .unwrap();
    f.state
        .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    assert_eq!(
        f.state.goal().unwrap().tokens_used,
        40,
        "closed unknown model usage retains its actual original ledger charge"
    );
    assert_eq!(
        f.ledger
            .read_reservation("actual-unknown-child")
            .unwrap()
            .unwrap()
            .coverage,
        BudgetUsageCoverage::Unreported
    );
    let public = f
        .state
        .goal()
        .unwrap()
        .public_native_budget_projection()
        .unwrap();
    assert_eq!(public["native_budget"]["unknown_tokens"], 40);
    assert_eq!(public["native_budget"]["held_tokens"], 0);
    let text = serde_json::to_string(&public).unwrap();
    for private in [
        &binding.facts.slot_id,
        &binding.facts.ledger_identity,
        &binding.accepted.identity.attempt_id,
    ] {
        assert!(
            !text.contains(private),
            "public Goal output must not leak a private Native binding"
        );
    }
}

#[test]
fn actual_lower_charge_corrects_only_derived_budget_limited_and_never_user_stop_states() {
    for status in [
        crate::GoalStatus::BudgetLimited,
        crate::GoalStatus::Paused,
        crate::GoalStatus::Cancelled,
        crate::GoalStatus::Blocked,
    ] {
        let f = Fixture::new();
        let goal = f
            .state
            .set_goal("original Goal state remains authoritative", Some(80));
        let binding = f.task("status", 80);
        f.state
            .reserve_goal_native_task_budget(&goal.goal_id, &binding)
            .unwrap();
        if status == crate::GoalStatus::BudgetLimited {
            f.state.update_active_goal_status(status).unwrap();
        } else {
            f.state.update_goal_status(status).unwrap();
        }
        f.finish(&binding);
        f.state
            .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
            .unwrap();
        let actual = f.state.goal().unwrap();
        assert_eq!(
            actual.status,
            if status == crate::GoalStatus::BudgetLimited {
                crate::GoalStatus::Active
            } else {
                status
            }
        );
        assert_eq!(actual.tokens_used, 0);
        assert!(
            actual
                .events
                .iter()
                .any(|event| event.kind == crate::GoalEventKind::NativeBudgetReconciled)
        );
    }
}

#[test]
fn explicit_state_or_budget_changes_invalidate_automatic_hold_limit_recovery() {
    for action in ["explicit-limit", "budget", "pause"] {
        let f = Fixture::new();
        let goal = f
            .state
            .set_goal("keep the user's actual later decision", Some(80));
        let binding = f.task("fence", 80);
        f.state
            .reserve_goal_native_task_budget(&goal.goal_id, &binding)
            .unwrap();
        f.state
            .update_active_goal_status(crate::GoalStatus::BudgetLimited)
            .unwrap();
        let stale = f.state.goal();
        match action {
            "explicit-limit" => {
                f.state
                    .update_goal_status(crate::GoalStatus::BudgetLimited)
                    .unwrap();
            }
            "budget" => {
                f.state.update_goal_token_budget(Some(80)).unwrap();
            }
            "pause" => {
                f.state
                    .update_goal_status(crate::GoalStatus::Paused)
                    .unwrap();
            }
            _ => unreachable!(),
        }
        // An older full snapshot cannot revive either the old automatic cause
        // or the state preceding the user's explicit later decision.
        f.state.write_inner().goal = stale;
        f.state.persist_latest_session_state();
        f.finish(&binding);
        f.state
            .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
            .unwrap();
        let actual = f.state.goal().unwrap();
        assert_eq!(
            actual.status,
            if action == "pause" {
                crate::GoalStatus::Paused
            } else {
                crate::GoalStatus::BudgetLimited
            }
        );
        assert!(actual.native_hold_budget_limit_cause.is_none());
    }
}

#[test]
fn another_actual_goal_charge_exhausting_the_budget_is_not_hidden_by_hold_refinement() {
    let f = Fixture::new();
    let goal = f
        .state
        .set_goal("all original Goal usage still counts", Some(100));
    let binding = f.task("other-real-usage", 80);
    f.state
        .reserve_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    f.state.account_goal_usage(100, 0).unwrap();
    f.state
        .update_active_goal_status(crate::GoalStatus::BudgetLimited)
        .unwrap();
    assert!(
        f.state
            .goal()
            .unwrap()
            .native_hold_budget_limit_cause
            .is_none()
    );
    f.finish(&binding);
    f.state
        .reconcile_goal_native_task_budget(&goal.goal_id, &binding)
        .unwrap();
    let actual = f.state.goal().unwrap();
    assert_eq!(actual.tokens_used, 100);
    assert_eq!(actual.status, crate::GoalStatus::BudgetLimited);
}

fn reopen_binding(
    root: &std::path::Path,
    state: &AppState,
    suffix: &str,
) -> NativeGoalTaskBudgetBinding {
    let directory = PrivateDirectory::open_existing(&root.join("owned-native-account")).unwrap();
    let scope = IntegrationScope {
        account_id: "native-account".into(),
        target_id: "native-target".into(),
        workspace_id: IntegrationNullable::Null,
        identity_generation: "native-generation".into(),
        target_revision: "native-config".into(),
        organization_id: None,
    };
    let ledger = Arc::new(
        NativeBudgetStore::open_in(&directory, OsStr::new("ledger"), &scope)
            .unwrap()
            .unwrap(),
    );
    let attempts = Arc::new(
        TurnAttemptStore::open_existing(
            &root.join("sessions").join(state.session_id()),
            &state.session_id(),
        )
        .unwrap()
        .unwrap(),
    );
    let identity = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: format!("turn-{suffix}"),
        attempt_id: format!("attempt-{suffix}"),
    };
    let accepted = attempts.load(&identity).unwrap().unwrap();
    let slot = ledger
        .read_reservation(&format!("slot-{suffix}"))
        .unwrap()
        .unwrap();
    let binding = NativeBudgetTaskBinding::from_authoritative_receipt(
        slot.operation_id,
        slot.task.root_task.unwrap(),
        format!("actual-accept-{suffix}"),
        "a".repeat(64),
    )
    .unwrap();
    let principal =
        NativeBudgetPrincipal::from_native_facts("native-account".into(), None, None, None)
            .unwrap();
    let parent = ledger
        .original_active_task_slot(&principal, &binding)
        .unwrap()
        .unwrap();
    NativeGoalTaskBudgetBinding::capture(ledger, &parent, attempts, &accepted).unwrap()
}

#[test]
fn native_goal_hold_child_process() {
    let Some(root) = std::env::var_os("KCODER_GOAL_NATIVE_CHILD_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let suffix = std::env::var("KCODER_GOAL_NATIVE_CHILD_SUFFIX").unwrap();
    assert!(matches!(suffix.as_str(), "one" | "two"));
    let history = std::fs::read_to_string(root.join("child-history-path")).unwrap();
    let state = AppState::new(&root);
    state
        .resume_from_history(std::path::Path::new(&history))
        .unwrap();
    let goal = state.goal().unwrap();
    let binding = reopen_binding(&root, &state, &suffix);
    std::fs::write(root.join(format!("ready-{suffix}")), b"ready").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !root.join("release-owned-children").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "owned Goal child barrier timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let result = state.reserve_goal_native_task_budget(&goal.goal_id, &binding);
    let text = match result {
        Ok(()) => "admitted".to_owned(),
        Err(error) => {
            assert!(
                error
                    .to_string()
                    .contains("GOAL_NATIVE_TOKEN_BUDGET_EXHAUSTED"),
                "{error:#}"
            );
            "denied".to_owned()
        }
    };
    std::fs::write(root.join(format!("result-{suffix}")), text).unwrap();
}

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn two_real_processes_compete_for_one_original_goal_balance_without_overbooking() {
    let f = Fixture::new();
    f.state
        .set_goal("one original cross-process Goal balance", Some(100));
    f.task("one", 60);
    f.task("two", 60);
    let root = f._temp.path();
    std::fs::write(
        root.join("child-history-path"),
        f.state
            .read_inner()
            .history_path
            .as_ref()
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    let mut children = Vec::new();
    for suffix in ["one", "two"] {
        let output = std::fs::File::create(root.join(format!("child-{suffix}.log"))).unwrap();
        children.push(OwnedChild(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "goal_remote_budget::tests::native_goal_hold_child_process",
                    "--nocapture",
                ])
                .env("KCODER_GOAL_NATIVE_CHILD_ROOT", root)
                .env("KCODER_GOAL_NATIVE_CHILD_SUFFIX", suffix)
                .stdout(output.try_clone().unwrap())
                .stderr(output)
                .spawn()
                .unwrap(),
        ));
        // Resume is itself fenced by HistorySource. Complete each independent
        // startup before releasing both writers to compete for the Goal hold.
        let startup_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join(format!("ready-{suffix}")).exists() {
            let child = children.last_mut().unwrap();
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "owned Goal child failed before barrier: {}",
                std::fs::read_to_string(root.join(format!("child-{suffix}.log")))
                    .unwrap_or_default()
            );
            assert!(
                std::time::Instant::now() < startup_deadline,
                "owned Goal child startup timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(12);
    while !root.join("ready-one").exists() || !root.join("ready-two").exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "owned Goal child startup timed out"
        );
        for (index, child) in children.iter_mut().enumerate() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "owned Goal child failed before its barrier: {}",
                std::fs::read_to_string(root.join(format!("child-{}.log", ["one", "two"][index])))
                    .unwrap_or_default()
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    std::fs::write(root.join("release-owned-children"), b"release").unwrap();
    for child in &mut children {
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "owned Goal child reservation timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let outcomes: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|suffix| std::fs::read_to_string(root.join(format!("result-{suffix}"))).unwrap())
        .collect();
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| result.as_str() == "admitted")
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| result.as_str() == "denied")
            .count(),
        1
    );
    let actual = load_session_state(&f.state.session_state_path().unwrap())
        .unwrap()
        .goal
        .unwrap();
    assert_eq!(actual.tokens_used, 60);
    assert_eq!(actual.native_task_budget_holds.len(), 1);
}
