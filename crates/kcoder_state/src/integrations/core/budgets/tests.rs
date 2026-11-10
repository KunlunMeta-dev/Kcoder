use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_types::integrations::core::*;
use std::{ffi::OsStr, path::PathBuf};

fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "service-account".into(),
        target_id: "native-target".into(),
        workspace_id: IntegrationNullable::Value("native-workspace".into()),
        identity_generation: "identity-1".into(),
        target_revision: "config-1".into(),
        organization_id: Some(IntegrationNullable::Value("organization".into())),
    }
}
fn policy(version: u64, tokens: u64, calls: u32, window: &str) -> NativeBudgetPolicy {
    NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "organization-policy".into(),
        version,
        revision: format!("policy-{version}"),
        scope: BudgetScope::Organization("organization".into()),
        window: BudgetWindow {
            id: window.into(),
            starts_at_ms: if window == "first" { 0 } else { 1000 },
            ends_at_ms: if window == "first" { 1000 } else { 2000 },
        },
        limits: BudgetLimits {
            tokens: Some(tokens),
            concurrent_calls: Some(calls),
            concurrent_tasks: Some(2),
            cost_micros: Some(1000),
            ..Default::default()
        },
        currency: Some("USD".into()),
    })
    .unwrap()
}
fn request(id: &str, tokens: u64) -> NativeBudgetRequest {
    NativeBudgetRequest {
        reservation_id: id.into(),
        operation_id: format!("operation-{id}"),
        principal: NativeBudgetPrincipal::from_native_facts(
            "user".into(),
            Some("organization".into()),
            Some("workspace".into()),
            Some("subscription".into()),
        )
        .unwrap(),
        unit: BudgetUnit::ModelCall,
        task: BudgetTaskLink {
            root_operation_id: "root-operation".into(),
            root_task: Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Turn,
                id: "original-native-turn".into(),
                revision: None,
            }),
            actor: BudgetActor::Main,
            actor_attempt_id: format!("native-attempt-{id}"),
            parent_reservation_id: None,
        },
        estimate: BudgetCharge {
            tokens,
            model_calls: 1,
            run_millis: 100,
            cost_micros: Some(100),
        },
    }
}

#[test]
fn shared_journal_read_requires_the_original_member_and_workspace() {
    let fixture = Fixture::new();
    let original = request("member-read", 10);
    fixture
        .store
        .reserve(&original, &[policy(1, 100, 4, "first")], 100)
        .unwrap();
    assert!(
        fixture
            .store
            .read_reservation_for_principal("member-read", &original.principal)
            .unwrap()
            .is_some()
    );
    for principal in [
        NativeBudgetPrincipal::from_native_facts(
            "other".into(),
            Some("organization".into()),
            Some("workspace".into()),
            Some("subscription".into()),
        )
        .unwrap(),
        NativeBudgetPrincipal::from_native_facts(
            "user".into(),
            Some("organization".into()),
            Some("other-workspace".into()),
            Some("subscription".into()),
        )
        .unwrap(),
    ] {
        assert!(
            fixture
                .store
                .read_reservation_for_principal("member-read", &principal)
                .is_err()
        );
    }
    assert!(
        fixture
            .store
            .read_reservation_for_principal("never-created", &original.principal)
            .unwrap()
            .is_none()
    );
}
struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    store: NativeBudgetStore,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let parent = PrivateDirectory::open_existing(temp.path())
            .unwrap()
            .create_private_child(OsStr::new("native-profile"))
            .unwrap();
        let root = temp.path().join("native-profile");
        let store = NativeBudgetStore::create_in(&parent, OsStr::new("budgets"), &scope()).unwrap();
        Self {
            _temp: temp,
            root,
            store,
        }
    }
    fn reopen(&self) -> NativeBudgetStore {
        NativeBudgetStore::open_in(
            &PrivateDirectory::open_existing(&self.root).unwrap(),
            OsStr::new("budgets"),
            &scope(),
        )
        .unwrap()
        .unwrap()
    }
}
fn terminal(request: &NativeBudgetRequest, kind: BudgetTerminalKind) -> NativeBudgetTerminal {
    NativeBudgetTerminal::from_authoritative_receipt(
        request.operation_id.clone(),
        request.task.root_task.clone(),
        request.task.actor_attempt_id.clone(),
        format!("actual-receipt-{}", request.reservation_id),
        "a".repeat(64),
        kind,
    )
    .unwrap()
}

#[test]
fn reads_do_not_initialize_and_duplicate_recovery_does_not_reserve_again() {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(temp.path())
        .unwrap()
        .create_private_child(OsStr::new("native-profile"))
        .unwrap();
    assert!(
        NativeBudgetStore::open_in(&parent, OsStr::new("absent"), &scope())
            .unwrap()
            .is_none()
    );
    assert_eq!(
        std::fs::read_dir(temp.path().join("native-profile"))
            .unwrap()
            .count(),
        0
    );
    let fixture = Fixture::new();
    let policies = [policy(1, 100, 2, "first")];
    let req = request("original", 70);
    let first = fixture
        .store
        .reserve(&req, &policies, 100)
        .unwrap()
        .receipt()
        .clone();
    let reopened = fixture.reopen();
    assert!(matches!(
        reopened.reserve(&req, &policies, 5000).unwrap(),
        BudgetReservationResult::Existing(_)
    ));
    assert_eq!(
        reopened.read_reservation("original").unwrap().unwrap(),
        first
    );
    assert_eq!(
        reopened
            .observe_policy(&policies[0])
            .unwrap()
            .unwrap()
            .charged
            .tokens,
        70
    );
    let mut changed = req;
    changed.estimate.tokens = 1;
    assert!(reopened.reserve(&changed, &policies, 100).is_err());
}
#[test]
fn admission_is_atomic_across_all_applicable_policies() {
    let fixture = Fixture::new();
    let organization = policy(1, 100, 2, "first");
    let mut user = policy(1, 100, 2, "first").record;
    user.id = "user-policy".into();
    user.scope = BudgetScope::Account("user".into());
    user.limits.tokens = Some(5);
    let user = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: user.id,
        version: user.version,
        revision: user.revision,
        scope: user.scope,
        window: user.window,
        limits: user.limits,
        currency: user.currency,
    })
    .unwrap();
    assert!(
        fixture
            .store
            .reserve(&request("denied", 10), &[organization.clone(), user], 100)
            .is_err()
    );
    assert!(fixture.store.read_reservation("denied").unwrap().is_none());
    assert_eq!(
        fixture
            .store
            .observe_policy(&organization)
            .unwrap()
            .unwrap()
            .charged
            .tokens,
        0
    );
}
#[test]
fn policy_versions_share_original_window_and_stricter_denial_remains_current() {
    let fixture = Fixture::new();
    fixture
        .store
        .reserve(&request("first", 70), &[policy(1, 100, 4, "first")], 100)
        .unwrap();
    assert!(
        fixture
            .store
            .reserve(&request("second", 40), &[policy(2, 80, 4, "first")], 100)
            .is_err()
    );
    assert!(
        fixture
            .store
            .reserve(&request("stale", 1), &[policy(1, 100, 4, "first")], 100)
            .is_err()
    );
    let observed = fixture
        .store
        .observe_policy(&policy(2, 80, 4, "first"))
        .unwrap()
        .unwrap();
    assert_eq!(observed.charged.tokens, 70);
    assert_eq!(observed.policy.version, 2);
    assert!(
        fixture
            .store
            .reserve(&request("second", 20), &[policy(3, 100, 4, "first")], 100)
            .is_ok()
    );
    assert_eq!(
        fixture
            .store
            .observe_policy(&policy(3, 100, 4, "first"))
            .unwrap()
            .unwrap()
            .charged
            .tokens,
        90
    );
}
#[test]
fn unknown_execution_survives_reopen_and_blocks_concurrency_across_window_rollover() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 1, "first");
    let req = request("unknown", 50);
    let receipt = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    assert!(matches!(
        fixture
            .store
            .mark_dispatched("unknown", receipt.revision, &[p], 100)
            .unwrap(),
        BudgetDispatchResult::Fresh(_)
    ));
    let reopened = fixture.reopen();
    assert!(
        reopened
            .reserve(
                &request("next-window", 1),
                &[policy(1, 100, 1, "next")],
                1100
            )
            .is_err()
    );
    let original = reopened.read_reservation("unknown").unwrap().unwrap();
    assert_eq!(original.charged.tokens, 50);
    assert!(!original.execution_confirmed_terminal);
    assert!(!original.cost_known);
}
#[test]
fn partial_or_unreported_usage_cannot_release_hold_or_concurrency() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 1, "first");
    let req = request("partial", 70);
    let receipt = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    let observed = fixture
        .store
        .record_usage(
            "partial",
            receipt.revision,
            "partial-report",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Partial,
                known: BudgetCharge {
                    tokens: 5,
                    model_calls: 1,
                    run_millis: 1,
                    cost_micros: None,
                },
            },
            None,
            110,
        )
        .unwrap();
    assert_eq!(observed.charged.tokens, 70);
    assert_eq!(observed.charged.cost_micros, Some(100));
    assert!(!observed.execution_confirmed_terminal);
    assert!(
        fixture
            .store
            .reserve(&request("blocked", 1), &[p], 120)
            .is_err()
    );
    let retry = fixture
        .store
        .record_usage(
            "partial",
            1,
            "partial-report",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Partial,
                known: BudgetCharge {
                    tokens: 5,
                    model_calls: 1,
                    run_millis: 1,
                    cost_micros: None,
                },
            },
            None,
            130,
        )
        .unwrap();
    assert_eq!(retry, observed);
}
#[test]
fn authoritative_terminal_releases_slot_but_unknown_money_stays_held() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 1, "first");
    let req = request("complete-no-price", 70);
    let receipt = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    let done = fixture
        .store
        .record_usage(
            &req.reservation_id,
            receipt.revision,
            "native-terminal",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Complete,
                known: BudgetCharge {
                    tokens: 10,
                    model_calls: 1,
                    run_millis: 5,
                    cost_micros: None,
                },
            },
            Some(&terminal(&req, BudgetTerminalKind::Completed)),
            150,
        )
        .unwrap();
    assert_eq!(done.charged.tokens, 10);
    assert_eq!(done.charged.cost_micros, Some(100));
    assert!(!done.cost_known);
    assert!(done.execution_confirmed_terminal);
    assert!(
        fixture
            .store
            .reserve(&request("another", 20), std::slice::from_ref(&p), 160)
            .is_ok()
    );
    assert_eq!(
        fixture
            .store
            .observe_policy(&p)
            .unwrap()
            .unwrap()
            .unknown_cost_reservations,
        2
    );
}
#[test]
fn actual_known_usage_settles_original_charge_and_wrong_receipt_cannot_release() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 1, "first");
    let req = request("actual", 70);
    let receipt = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    let wrong = terminal(
        &request("another-operation", 70),
        BudgetTerminalKind::Cancelled,
    );
    let report = NativeBudgetUsage {
        coverage: BudgetUsageCoverage::Complete,
        known: BudgetCharge {
            tokens: 20,
            model_calls: 1,
            run_millis: 4,
            cost_micros: Some(25),
        },
    };
    assert!(
        fixture
            .store
            .record_usage(
                "actual",
                receipt.revision,
                "wrong",
                &report,
                Some(&wrong),
                120
            )
            .is_err()
    );
    assert_eq!(
        fixture
            .store
            .read_reservation("actual")
            .unwrap()
            .unwrap()
            .charged
            .tokens,
        70
    );
    let done = fixture
        .store
        .record_usage(
            "actual",
            receipt.revision,
            "actual-receipt",
            &report,
            Some(&terminal(&req, BudgetTerminalKind::Completed)),
            120,
        )
        .unwrap();
    assert_eq!(done.charged, report.known);
    assert!(done.cost_known);
    assert_eq!(done.policy_refs[0].window.id, "first");
}
#[test]
fn native_binding_is_required_before_dispatch_and_repeat_is_never_fresh() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 2, "first");
    let mut req = request("slot", 0);
    req.unit = BudgetUnit::TaskSlot;
    req.estimate = BudgetCharge::zero();
    let native = req.task.root_task.take().unwrap();
    let receipt = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    assert!(
        fixture
            .store
            .mark_dispatched("slot", receipt.revision, std::slice::from_ref(&p), 100)
            .is_err()
    );
    let proof = NativeBudgetTaskBinding::from_authoritative_receipt(
        req.task.root_operation_id.clone(),
        native,
        "real-acceptance".into(),
        "b".repeat(64),
    )
    .unwrap();
    let bound = fixture
        .store
        .bind_task("slot", receipt.revision, &proof, 110)
        .unwrap();
    assert!(matches!(
        fixture
            .store
            .mark_dispatched("slot", bound.revision, std::slice::from_ref(&p), 120)
            .unwrap(),
        BudgetDispatchResult::Fresh(_)
    ));
    assert!(matches!(
        fixture.store.mark_dispatched("slot", 1, &[p], 130).unwrap(),
        BudgetDispatchResult::AlreadyDispatched(_)
    ));
}
#[test]
fn main_child_observer_and_subscription_share_authoritative_budget_without_double_task_fee() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 4, "first");
    let mut slot = request("main-slot", 0);
    slot.unit = BudgetUnit::TaskSlot;
    slot.estimate = BudgetCharge::zero();
    fixture
        .store
        .reserve(&slot, std::slice::from_ref(&p), 100)
        .unwrap();
    let main = request("main-call", 30);
    fixture
        .store
        .reserve(&main, std::slice::from_ref(&p), 100)
        .unwrap();
    let mut child = request("child-call", 30);
    child.task.actor = BudgetActor::ChildAgent;
    child.task.parent_reservation_id = Some("main-slot".into());
    fixture
        .store
        .reserve(&child, std::slice::from_ref(&p), 100)
        .unwrap();
    let mut observer = request("observer-call", 20);
    observer.task.actor = BudgetActor::Observer;
    fixture
        .store
        .reserve(&observer, std::slice::from_ref(&p), 100)
        .unwrap();
    let observed = fixture.store.observe_policy(&p).unwrap().unwrap();
    assert_eq!(observed.charged.tokens, 80);
    assert_eq!(observed.active_tasks, 1);
    assert_eq!(observed.active_calls, 3);
    let mut subscription = p.record;
    subscription.id = "cycle-budget".into();
    subscription.scope = BudgetScope::Subscription("subscription".into());
    subscription.limits.tokens = Some(10);
    let subscription = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: subscription.id,
        version: 1,
        revision: subscription.revision,
        scope: subscription.scope,
        window: subscription.window,
        limits: subscription.limits,
        currency: subscription.currency,
    })
    .unwrap();
    assert!(
        fixture
            .store
            .reserve(&request("cycle", 11), &[subscription], 100)
            .is_err()
    );
}
#[test]
fn missing_or_replaced_data_and_lock_fail_closed_without_empty_recreation() {
    for leaf in ["ledger.json", "budgets.lock", "owner.json"] {
        let fixture = Fixture::new();
        fixture
            .store
            .reserve(&request("kept", 20), &[policy(1, 100, 2, "first")], 100)
            .unwrap();
        std::fs::remove_file(fixture.root.join("budgets").join(leaf)).unwrap();
        assert!(fixture.store.read_reservation("kept").is_err());
        assert!(
            NativeBudgetStore::open_in(
                &PrivateDirectory::open_existing(&fixture.root).unwrap(),
                OsStr::new("budgets"),
                &scope()
            )
            .is_err()
        );
        assert!(!fixture.root.join("budgets").join(leaf).exists());
    }
}

#[test]
fn unknown_price_is_explicit_and_never_zero_cost_admission() {
    let fixture = Fixture::new();
    let mut req = request("unpriced", 10);
    req.estimate.cost_micros = None;
    assert!(
        fixture
            .store
            .reserve(&req, &[policy(1, 100, 2, "first")], 100)
            .is_err()
    );
    assert!(
        fixture
            .store
            .read_reservation("unpriced")
            .unwrap()
            .is_none()
    );
    let p = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "token-only".into(),
        version: 1,
        revision: "one".into(),
        scope: BudgetScope::Account("user".into()),
        window: BudgetWindow {
            id: "first".into(),
            starts_at_ms: 0,
            ends_at_ms: 1000,
        },
        limits: BudgetLimits {
            tokens: Some(100),
            ..Default::default()
        },
        currency: Some("USD".into()),
    })
    .unwrap();
    fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap();
    let observation = fixture.store.observe_policy(&p).unwrap().unwrap();
    assert_eq!(observation.charged.cost_micros, None);
    assert_eq!(observation.unknown_cost_reservations, 1);
    assert!(
        !fixture
            .store
            .read_reservation("unpriced")
            .unwrap()
            .unwrap()
            .cost_known
    );
}

#[test]
fn verified_not_started_is_required_for_zero_call_release_and_usage_is_not_clamped() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 2, "first");
    let req = request("zero", 50);
    let initial = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    let zero = NativeBudgetUsage {
        coverage: BudgetUsageCoverage::Complete,
        known: BudgetCharge::zero(),
    };
    assert!(
        fixture
            .store
            .record_usage(
                "zero",
                initial.revision,
                "fake-completion-zero",
                &zero,
                Some(&terminal(&req, BudgetTerminalKind::Completed)),
                100
            )
            .is_err()
    );
    let cancelled = fixture
        .store
        .record_usage(
            "zero",
            initial.revision,
            "actually-not-started",
            &zero,
            Some(&terminal(&req, BudgetTerminalKind::VerifiedNotStarted)),
            100,
        )
        .unwrap();
    assert_eq!(cancelled.charged, BudgetCharge::zero());
    let req = request("overrun", 90);
    let held = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    let actual = NativeBudgetUsage {
        coverage: BudgetUsageCoverage::Complete,
        known: BudgetCharge {
            tokens: 110,
            model_calls: 1,
            run_millis: 5,
            cost_micros: Some(30),
        },
    };
    let done = fixture
        .store
        .record_usage(
            "overrun",
            held.revision,
            "actual-overrun",
            &actual,
            Some(&terminal(&req, BudgetTerminalKind::Completed)),
            100,
        )
        .unwrap();
    assert_eq!(done.charged.tokens, 110);
    assert!(
        fixture
            .store
            .reserve(&request("blocked-after-overrun", 1), &[p], 100)
            .is_err()
    );
}

#[test]
fn original_window_bounds_owner_and_task_association_cannot_be_rebound() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 3, "first");
    fixture
        .store
        .reserve(&request("root", 20), std::slice::from_ref(&p), 100)
        .unwrap();
    let mut altered = p.record.clone();
    altered.window.ends_at_ms = 3000;
    let altered = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: altered.id,
        version: 2,
        revision: "two".into(),
        scope: altered.scope,
        window: altered.window,
        limits: altered.limits,
        currency: altered.currency,
    })
    .unwrap();
    assert!(
        fixture
            .store
            .reserve(&request("window-reset", 10), &[altered], 100)
            .is_err()
    );
    let mut wrong = scope();
    wrong.account_id = "another-native-owner".into();
    assert!(
        NativeBudgetStore::open_in(
            &PrivateDirectory::open_existing(&fixture.root).unwrap(),
            OsStr::new("budgets"),
            &wrong
        )
        .is_err()
    );
    let mut child = request("wrong-child", 10);
    child.task.actor = BudgetActor::ChildAgent;
    child.task.parent_reservation_id = Some("root".into());
    child.task.root_task.as_mut().unwrap().id = "another-root-task".into();
    assert!(fixture.store.reserve(&child, &[p], 100).is_err());
}

#[cfg(unix)]
#[test]
fn hardlinked_lock_and_replaced_namespace_are_rejected() {
    let fixture = Fixture::new();
    std::fs::hard_link(
        fixture.root.join("budgets/budgets.lock"),
        fixture.root.join("lock-alias"),
    )
    .unwrap();
    assert!(fixture.store.read_reservation("absent").is_err());
    let fixture = Fixture::new();
    std::fs::rename(
        fixture.root.join("budgets"),
        fixture.root.join("original-budget-store"),
    )
    .unwrap();
    PrivateDirectory::open_existing(&fixture.root)
        .unwrap()
        .create_private_child(OsStr::new("budgets"))
        .unwrap();
    assert!(fixture.store.read_reservation("absent").is_err());
    assert!(
        NativeBudgetStore::open_in(
            &PrivateDirectory::open_existing(&fixture.root).unwrap(),
            OsStr::new("budgets"),
            &scope()
        )
        .is_err()
    );
}

#[test]
fn any_unknown_execution_observation_prevents_fresh_replay() {
    let fixture = Fixture::new();
    let p = policy(1, 100, 2, "first");
    let req = request("unreported", 50);
    let held = fixture
        .store
        .reserve(&req, std::slice::from_ref(&p), 100)
        .unwrap()
        .receipt()
        .clone();
    let unknown = fixture
        .store
        .record_usage(
            "unreported",
            held.revision,
            "lost-provider-receipt",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Unreported,
                known: BudgetCharge::default(),
            },
            None,
            110,
        )
        .unwrap();
    assert_eq!(unknown.phase, BudgetPhase::Dispatched);
    assert_eq!(unknown.charged.tokens, 50);
    assert_eq!(unknown.charged.cost_micros, Some(100));
    assert!(!unknown.cost_known);
    assert!(matches!(
        fixture
            .store
            .mark_dispatched("unreported", unknown.revision, &[p], 120)
            .unwrap(),
        BudgetDispatchResult::AlreadyDispatched(_)
    ));
}

#[test]
fn stale_policy_cannot_return_in_a_new_window_or_double_charge_two_windows() {
    let fixture = Fixture::new();
    fixture
        .store
        .reserve(
            &request("old-window", 10),
            &[policy(2, 100, 4, "first")],
            100,
        )
        .unwrap();
    assert!(
        fixture
            .store
            .reserve(
                &request("stale-in-new-window", 10),
                &[policy(1, 100, 4, "next")],
                1100
            )
            .is_err()
    );
    assert!(
        fixture
            .store
            .reserve(
                &request("double-window", 10),
                &[policy(2, 100, 4, "first"), policy(2, 100, 4, "next")],
                100
            )
            .is_err()
    );
    assert!(
        fixture
            .store
            .read_reservation("double-window")
            .unwrap()
            .is_none()
    );
    assert!(
        fixture
            .store
            .reserve(
                &request("current-new-window", 10),
                &[policy(2, 100, 4, "next")],
                1100
            )
            .is_ok()
    );
}
#[path = "process_tests.rs"]
mod process_tests;
