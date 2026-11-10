use super::*;
use kcoder_types::integrations::core::{
    IntegrationEntityKind, IntegrationEntityRef, IntegrationNullable,
};
fn scope() -> IntegrationScope {
    IntegrationScope {
        account_id: "actual-native-account".into(),
        target_id: "actual-native-target".into(),
        workspace_id: IntegrationNullable::Null,
        identity_generation: "native-generation".into(),
        target_revision: "native-config".into(),
        organization_id: None,
    }
}
fn principal() -> NativeBudgetPrincipal {
    NativeBudgetPrincipal::from_native_facts("actual-native-account".into(), None, None, None)
        .unwrap()
}
fn task() -> IntegrationEntityRef {
    IntegrationEntityRef {
        kind: IntegrationEntityKind::Turn,
        id: "actual-accepted-turn".into(),
        revision: None,
    }
}
fn binding() -> NativeBudgetTaskBinding {
    NativeBudgetTaskBinding::from_authoritative_receipt(
        "original-runtime-operation".into(),
        task(),
        "actual-accepted-receipt".into(),
        "a".repeat(64),
    )
    .unwrap()
}
fn policy() -> NativeBudgetPolicy {
    NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "native-account-policy".into(),
        version: 1,
        revision: "persisted-native-policy-r1".into(),
        scope: BudgetScope::Account("actual-native-account".into()),
        window: BudgetWindow {
            id: "actual-current-window".into(),
            starts_at_ms: 0,
            ends_at_ms: 1000,
        },
        limits: BudgetLimits {
            tokens: Some(100),
            model_calls: Some(3),
            concurrent_tasks: Some(4),
            concurrent_calls: Some(4),
            ..Default::default()
        },
        currency: None,
    })
    .unwrap()
}
fn request(id: &str, unit: BudgetUnit) -> NativeBudgetRequest {
    NativeBudgetRequest {
        reservation_id: id.into(),
        operation_id: if unit == BudgetUnit::TaskSlot {
            "original-runtime-operation".into()
        } else {
            format!("actual-native-child-{id}")
        },
        principal: principal(),
        unit,
        task: BudgetTaskLink {
            root_operation_id: "original-runtime-operation".into(),
            root_task: Some(task()),
            actor: if unit == BudgetUnit::TaskSlot {
                BudgetActor::Main
            } else {
                BudgetActor::ChildAgent
            },
            actor_attempt_id: if unit == BudgetUnit::TaskSlot {
                "actual-source-attempt".into()
            } else {
                "actual-receiver-attempt".into()
            },
            parent_reservation_id: if unit == BudgetUnit::TaskSlot {
                None
            } else {
                Some("actual-original-slot".into())
            },
        },
        estimate: if unit == BudgetUnit::TaskSlot {
            BudgetCharge::zero()
        } else {
            BudgetCharge {
                tokens: 10,
                model_calls: 1,
                run_millis: 10,
                cost_micros: None,
            }
        },
    }
}
fn fixture() -> (tempfile::TempDir, PrivateDirectory, NativeBudgetStore) {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(temp.path())
        .unwrap()
        .create_private_child(OsStr::new("native-account"))
        .unwrap();
    let store = NativeBudgetStore::create_in(&parent, OsStr::new("budget"), &scope()).unwrap();
    (temp, parent, store)
}
#[test]
fn original_task_close_observation_requires_every_actual_call_terminal_without_refunding_unknowns()
{
    let (_temp, _parent, store) = fixture();
    store
        .reserve(
            &request("actual-original-slot", BudgetUnit::TaskSlot),
            &[policy()],
            1,
        )
        .unwrap();
    assert!(
        store
            .original_task_calls_closed("actual-original-slot", &principal())
            .unwrap()
    );
    let parent = store
        .original_active_task_slot(&principal(), &binding())
        .unwrap()
        .unwrap();
    let call = store
        .reserve_with_original_task_slot(
            &parent,
            &request("live-child", BudgetUnit::ModelCall),
            &[policy()],
            2,
        )
        .unwrap()
        .receipt()
        .clone();
    assert!(
        !store
            .original_task_calls_closed("actual-original-slot", &principal())
            .unwrap()
    );
    let call = match store
        .mark_dispatched("live-child", call.revision, &[policy()], 3)
        .unwrap()
    {
        BudgetDispatchResult::Fresh(r) => r,
        _ => panic!("actual dispatch required"),
    };
    let terminal = NativeBudgetTerminal::from_authoritative_receipt(
        call.operation_id.clone(),
        Some(task()),
        call.task.actor_attempt_id.clone(),
        "actual-closed-child".into(),
        "c".repeat(64),
        BudgetTerminalKind::Cancelled,
    )
    .unwrap();
    let settled = store
        .record_usage(
            "live-child",
            call.revision,
            "unknown-but-closed",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Unreported,
                known: BudgetCharge {
                    cost_micros: None,
                    ..Default::default()
                },
            },
            Some(&terminal),
            4,
        )
        .unwrap();
    assert_eq!(settled.charged.tokens, 10);
    assert!(
        store
            .original_task_calls_closed("actual-original-slot", &principal())
            .unwrap()
    );
    let foreign =
        NativeBudgetPrincipal::from_native_facts("foreign".into(), None, None, None).unwrap();
    assert!(
        store
            .original_task_calls_closed("actual-original-slot", &foreign)
            .is_err()
    );
}
#[test]
fn original_native_slot_lookup_never_creates_credit_and_child_keeps_same_store_principal_root_and_task()
 {
    let (_temp, parent, store) = fixture();
    assert!(
        store
            .original_active_task_slot(&principal(), &binding())
            .unwrap()
            .is_none()
    );
    store
        .reserve(
            &request("actual-original-slot", BudgetUnit::TaskSlot),
            &[policy()],
            1,
        )
        .unwrap();
    let original = store
        .original_active_task_slot(&principal(), &binding())
        .unwrap()
        .unwrap();
    let child = request("actual-model-call", BudgetUnit::ModelCall);
    let reserved = store
        .reserve_with_original_task_slot(&original, &child, &[policy()], 2)
        .unwrap();
    assert_eq!(
        reserved.receipt().task.parent_reservation_id.as_deref(),
        Some("actual-original-slot")
    );
    assert_eq!(
        reserved.receipt().task.root_operation_id,
        "original-runtime-operation"
    );
    assert_eq!(reserved.receipt().task.root_task, Some(task()));
    assert_eq!(reserved.receipt().coverage, BudgetUsageCoverage::Unreported);
    let mut forged = request("forged-root-call", BudgetUnit::ModelCall);
    forged.task.root_operation_id = "another-operation".into();
    assert!(
        store
            .reserve_with_original_task_slot(&original, &forged, &[policy()], 3)
            .is_err()
    );
    assert!(
        store
            .read_reservation("forged-root-call")
            .unwrap()
            .is_none()
    );
    let second =
        NativeBudgetStore::create_in(&parent, OsStr::new("another-real-ledger"), &scope()).unwrap();
    assert!(second.verify_original_task_slot(&original).is_err());
    let other =
        NativeBudgetPrincipal::from_native_facts("different-account".into(), None, None, None)
            .unwrap();
    assert!(
        store
            .original_active_task_slot(&other, &binding())
            .unwrap()
            .is_none()
    );
}
#[test]
fn additional_matching_slot_is_ambiguous_and_a_retained_parent_cannot_bypass_current_recheck() {
    let (_temp, _parent, store) = fixture();
    store
        .reserve(
            &request("actual-original-slot", BudgetUnit::TaskSlot),
            &[policy()],
            1,
        )
        .unwrap();
    let original = store
        .original_active_task_slot(&principal(), &binding())
        .unwrap()
        .unwrap();
    store
        .reserve(
            &request("another-actual-slot", BudgetUnit::TaskSlot),
            &[policy()],
            2,
        )
        .unwrap();
    assert!(
        store
            .original_active_task_slot(&principal(), &binding())
            .is_err()
    );
    assert!(store.verify_original_task_slot(&original).is_err());
    assert!(
        store
            .reserve_with_original_task_slot(
                &original,
                &request("no-ambiguous-child", BudgetUnit::ModelCall),
                &[policy()],
                3
            )
            .is_err()
    );
    assert!(
        store
            .read_reservation("no-ambiguous-child")
            .unwrap()
            .is_none()
    );
}
#[test]
fn completed_parent_and_a_different_child_principal_never_allocate_new_work() {
    let (_temp, _parent, store) = fixture();
    store
        .reserve(
            &request("actual-original-slot", BudgetUnit::TaskSlot),
            &[policy()],
            1,
        )
        .unwrap();
    let original = store
        .original_active_task_slot(&principal(), &binding())
        .unwrap()
        .unwrap();
    let mut forged = request("wrong-principal", BudgetUnit::ModelCall);
    forged.principal =
        NativeBudgetPrincipal::from_native_facts("different-account".into(), None, None, None)
            .unwrap();
    assert!(
        store
            .reserve_with_original_task_slot(&original, &forged, &[policy()], 2)
            .is_err()
    );
    assert!(store.read_reservation("wrong-principal").unwrap().is_none());
    let receipt = store
        .read_reservation("actual-original-slot")
        .unwrap()
        .unwrap();
    let terminal = NativeBudgetTerminal::from_authoritative_receipt(
        receipt.operation_id.clone(),
        Some(task()),
        receipt.task.actor_attempt_id.clone(),
        "original-task-terminal".into(),
        "b".repeat(64),
        BudgetTerminalKind::Completed,
    )
    .unwrap();
    store
        .record_usage(
            &receipt.reservation_id,
            receipt.revision,
            "actual-terminal",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Complete,
                known: BudgetCharge::zero(),
            },
            Some(&terminal),
            3,
        )
        .unwrap();
    assert!(store.verify_original_task_slot(&original).is_err());
    assert!(
        store
            .reserve_with_original_task_slot(
                &original,
                &request("after-terminal", BudgetUnit::ModelCall),
                &[policy()],
                4
            )
            .is_err()
    );
}
