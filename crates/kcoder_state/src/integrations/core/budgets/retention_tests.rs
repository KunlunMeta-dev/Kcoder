use super::*;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};

const OLD_END: u64 = 1000;
const LATER: u64 = OLD_END + RETENTION_MS + 1;

fn owner() -> IntegrationOwner {
    IntegrationOwner::from(&IntegrationScope {
        account_id: "service-account".into(),
        target_id: "native-target".into(),
        workspace_id: IntegrationNullable::Value("native-workspace".into()),
        identity_generation: "identity-1".into(),
        target_revision: "config-1".into(),
        organization_id: Some(IntegrationNullable::Value("organization".into())),
    })
}

fn policy(window: &str, starts: u64, ends: u64) -> NativeBudgetPolicy {
    NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "organization-policy".into(),
        version: 1,
        revision: "policy-1".into(),
        scope: BudgetScope::Organization("organization".into()),
        window: BudgetWindow {
            id: window.into(),
            starts_at_ms: starts,
            ends_at_ms: ends,
        },
        limits: BudgetLimits {
            tokens: Some(u64::MAX / 4),
            ..Default::default()
        },
        currency: None,
    })
    .unwrap()
}

fn old_policy() -> NativeBudgetPolicy {
    policy("old", 0, OLD_END)
}

fn request(id: &str, root: &str, subscription: bool) -> NativeBudgetRequest {
    NativeBudgetRequest {
        reservation_id: id.into(),
        operation_id: format!("operation-{id}"),
        principal: NativeBudgetPrincipal::from_native_facts(
            "user".into(),
            Some("organization".into()),
            Some("workspace".into()),
            subscription.then(|| "subscription".into()),
        )
        .unwrap(),
        unit: BudgetUnit::ModelCall,
        task: BudgetTaskLink {
            root_operation_id: root.into(),
            root_task: Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Turn,
                id: format!("turn-{root}"),
                revision: None,
            }),
            actor: BudgetActor::Main,
            actor_attempt_id: format!("attempt-{id}"),
            parent_reservation_id: None,
        },
        estimate: BudgetCharge {
            tokens: 10,
            model_calls: 1,
            run_millis: 10,
            cost_micros: None,
        },
    }
}

fn terminal(request: &NativeBudgetRequest) -> NativeBudgetTerminal {
    NativeBudgetTerminal::from_authoritative_receipt(
        request.operation_id.clone(),
        request.task.root_task.clone(),
        request.task.actor_attempt_id.clone(),
        format!("receipt-{}", request.reservation_id),
        "a".repeat(64),
        BudgetTerminalKind::Completed,
    )
    .unwrap()
}

/// Reserve and dispatch; `settle` adds an authoritative terminal receipt.
fn admit(ledger: &mut Ledger, request: &NativeBudgetRequest, settle: bool) {
    let policies = [old_policy()];
    let receipt = ledger
        .reserve(request, &policies, 100)
        .unwrap()
        .receipt()
        .clone();
    let BudgetDispatchResult::Fresh(receipt) = ledger
        .dispatch(&request.reservation_id, receipt.revision, &policies, 110)
        .unwrap()
    else {
        panic!("first dispatch must be fresh");
    };
    let known = BudgetCharge {
        tokens: 7,
        model_calls: 1,
        run_millis: 5,
        cost_micros: None,
    };
    let proof = settle.then(|| terminal(request));
    ledger
        .usage(
            &request.reservation_id,
            receipt.revision,
            "usage-0",
            &NativeBudgetUsage {
                coverage: if settle {
                    BudgetUsageCoverage::Complete
                } else {
                    BudgetUsageCoverage::Partial
                },
                known,
            },
            proof.as_ref(),
            120,
        )
        .unwrap();
}

#[test]
fn settled_reservations_are_retired_but_unknown_outcomes_never_are() {
    let mut ledger = Ledger::empty(owner());
    let settled = request("settled", "root-settled", false);
    let unknown = request("unknown", "root-unknown", false);
    let mixed_done = request("mixed-done", "root-mixed", false);
    let mixed_open = request("mixed-open", "root-mixed", false);
    let subscription = request("subscription", "root-subscription", true);
    admit(&mut ledger, &settled, true);
    admit(&mut ledger, &unknown, false);
    admit(&mut ledger, &mixed_done, true);
    admit(&mut ledger, &mixed_open, false);
    admit(&mut ledger, &subscription, true);

    // Inside the retention window nothing is retired.
    assert_eq!(ledger.prune_settled(OLD_END + 10).unwrap(), 0);
    assert_eq!(ledger.version, 1);

    assert_eq!(ledger.prune_settled(LATER).unwrap(), 1);
    assert!(!ledger.reservations.contains_key("settled"));
    for kept in ["unknown", "mixed-done", "mixed-open", "subscription"] {
        assert!(ledger.reservations.contains_key(kept), "{kept} was retired");
    }
    assert_eq!(ledger.version, 2);
    ledger.validate().unwrap();

    // Replays keep their original identity and are never fresh.
    let current = [policy("current", LATER - 10, LATER + 1000)];
    assert_eq!(
        ledger
            .reserve(&settled, &current, LATER)
            .unwrap_err()
            .to_string(),
        "BUDGET_RESERVATION_CONFLICT",
        "a replay under a different policy set is a conflicting intent"
    );
    let replay = ledger.reserve(&settled, &[old_policy()], 100).unwrap_err();
    assert_eq!(replay.to_string(), "BUDGET_RESERVATION_RETIRED");

    // The tombstone survives a serialized round trip.
    let bytes = serde_json::to_vec(&ledger).unwrap();
    let reloaded: Ledger = serde_json::from_slice(&bytes).unwrap();
    reloaded.validate().unwrap();
    assert!(reloaded.retired.contains_key("settled"));
}

#[test]
fn version_one_ledgers_load_and_tombstones_require_version_two() {
    let mut ledger = Ledger::empty(owner());
    admit(&mut ledger, &request("old-format", "root-old", false), true);
    let mut value = serde_json::to_value(&ledger).unwrap();
    assert!(
        value.get("retired").is_none(),
        "version 1 ledgers keep their original layout"
    );
    let loaded: Ledger = serde_json::from_value(value.clone()).unwrap();
    loaded.validate().unwrap();
    assert_eq!(loaded.version, 1);

    value["retired"] = serde_json::json!({
        "ghost": {"intent": "b".repeat(64), "rootOperationId": "root", "retiredAtMs": 1}
    });
    let forged: Ledger = serde_json::from_value(value).unwrap();
    assert_eq!(
        forged.validate().unwrap_err().to_string(),
        "BUDGET_LEDGER_CORRUPT"
    );
}

#[test]
fn capacity_is_not_permanent_once_settled_reservations_retire() {
    let mut full = Ledger::empty(owner());
    let template = request("template", "root-template", false);
    admit(&mut full, &template, true);
    let record = full.reservations["template"].clone();
    while full.reservations.len() < MAX_RESERVATIONS {
        let index = full.reservations.len();
        let mut copy = record.clone();
        let id = format!("filled-{index}");
        copy.request.reservation_id = id.clone();
        copy.request.operation_id = format!("operation-{id}");
        copy.request.task.root_operation_id = format!("root-{index}");
        copy.request.task.actor_attempt_id = format!("attempt-{id}");
        copy.receipt.reservation_id = id.clone();
        copy.receipt.operation_id = copy.request.operation_id.clone();
        copy.receipt.task = copy.request.task.clone();
        let mut proof = copy.terminal.clone().unwrap();
        proof.operation_id = copy.request.operation_id.clone();
        proof.actor_attempt_id = copy.request.task.actor_attempt_id.clone();
        copy.terminal = Some(proof);
        copy.intent = digest(&(&copy.request, &copy.policies)).unwrap();
        full.reservations.insert(id, copy);
    }
    full.validate().unwrap();

    // Unknown outcomes keep the original hard limit.
    let mut unknown = full.clone();
    for record in unknown.reservations.values_mut() {
        record.terminal = None;
        record.receipt.execution_confirmed_terminal = false;
        record.receipt.phase = BudgetPhase::Dispatched;
        record.receipt.charged = record
            .receipt
            .charged
            .conservative(&record.request.estimate);
    }
    unknown.validate().unwrap();
    let fresh = request("fresh", "root-fresh", false);
    let current = [policy("current", LATER - 10, LATER + 1000)];
    assert_eq!(
        unknown
            .reserve(&fresh, &current, LATER)
            .unwrap_err()
            .to_string(),
        "BUDGET_RESERVATION_CAPACITY"
    );
    assert!(unknown.retired.is_empty());

    // Settled history is retired in the same admission transaction.
    let result = full.reserve(&fresh, &current, LATER).unwrap();
    assert!(matches!(result, BudgetReservationResult::Created(_)));
    assert_eq!(full.reservations.len(), 1);
    assert_eq!(full.retired.len(), MAX_RESERVATIONS);
    full.validate().unwrap();
    assert!(
        serde_json::to_vec(&full).unwrap().len() < 16 * 1024 * 1024,
        "tombstones stay well inside the ledger byte limit"
    );
}
