//! Actual Engine/Provider composition with a real private budget journal.
//! Native policy definitions below are explicit fixtures, not a production PDP.
use super::*;
use crate::test_support::{engine_builder::TestEngineBuilder, events::simple_text_events};
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_config::PrivateDirectory;
use kcoder_state::integrations::core::budgets::*;
use kcoder_types::{Message, StreamEvent, integrations::core::*};
use std::{
    ffi::OsStr,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

struct Inner(Arc<AtomicUsize>);
impl Provider for Inner {
    fn name(&self) -> &'static str {
        "actual-additive-observer-fixture"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let mut events = simple_text_events("Literal observed response");
        if let Some(StreamEvent::MessageDelta { delta }) = events
            .iter_mut()
            .find(|event| matches!(event, StreamEvent::MessageDelta { .. }))
        {
            delta.usage = Some(Usage {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: Some(5),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                iterations: None,
            });
        }
        Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
    }
}
#[derive(Default)]
struct Stats {
    reserves: AtomicUsize,
    checks: AtomicUsize,
    usage: AtomicUsize,
    finishes: Mutex<Vec<NativeModelRequestSettlement>>,
}
struct Observer {
    stats: Arc<Stats>,
    deny: bool,
    check_error: bool,
    usage_error: bool,
    finish_error: bool,
    deadline: Option<Instant>,
}
struct Lease {
    stats: Arc<Stats>,
    check_error: bool,
    usage_error: bool,
    finish_error: bool,
    deadline: Option<Instant>,
}
impl NativeModelRequestObserver for Observer {
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        assert!(context.execution().matches_state(context.state()));
        self.stats.reserves.fetch_add(1, Ordering::SeqCst);
        if self.deny {
            return Err(NativeModelRequestError::Denied);
        }
        Ok(Box::new(Lease {
            stats: self.stats.clone(),
            check_error: self.check_error,
            usage_error: self.usage_error,
            finish_error: self.finish_error,
            deadline: self.deadline,
        }))
    }
}
impl NativeModelRequestLease for Lease {
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        self.stats.checks.fetch_add(1, Ordering::SeqCst);
        if self.check_error {
            Err(NativeModelRequestError::Denied)
        } else {
            Ok(())
        }
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn record_usage(&mut self, _: &Usage) -> Result<(), NativeModelRequestError> {
        self.stats.usage.fetch_add(1, Ordering::SeqCst);
        if self.usage_error {
            Err(NativeModelRequestError::Unavailable)
        } else {
            Ok(())
        }
    }
    fn finish(
        self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        self.stats.finishes.lock().unwrap().push(settlement);
        if self.finish_error {
            Err(NativeModelRequestError::Unavailable)
        } else {
            Ok(())
        }
    }
}
fn observer(
    stats: &Arc<Stats>,
    deny: bool,
    check_error: bool,
    usage_error: bool,
    finish_error: bool,
    deadline: Option<Instant>,
) -> Arc<dyn NativeModelRequestObserver> {
    Arc::new(Observer {
        stats: stats.clone(),
        deny,
        check_error,
        usage_error,
        finish_error,
        deadline,
    })
}
fn engine(root: &std::path::Path, calls: Arc<AtomicUsize>) -> QueryEngine {
    let profile = PrivateDirectory::open_existing(root)
        .unwrap()
        .create_private_child(OsStr::new("test-config"))
        .unwrap();
    profile
        .atomic_replace(OsStr::new("settings.json"), b"{}")
        .unwrap();
    TestEngineBuilder::new(root)
        .provider(Arc::new(Inner(calls)))
        .build_with_profile_directory()
}
fn request() -> MessagesRequest {
    MessagesRequest::new(
        "fixture-model",
        vec![Message::user_text("Exact original input")],
    )
    .with_max_tokens(16)
}
#[tokio::test]
async fn mandatory_admission_cannot_be_removed_by_a_new_source_observer() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let required = Arc::new(Stats::default());
    let replaceable = Arc::new(Stats::default());
    let guard = observer(&required, true, false, false, false, None);
    let engine = engine(temp.path(), calls.clone())
        .with_mandatory_native_model_request_observer(guard.clone())
        .unwrap()
        .with_mandatory_native_model_request_observer(guard)
        .unwrap()
        .with_native_model_request_observer(observer(
            &replaceable,
            false,
            false,
            false,
            false,
            None,
        ))
        .unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(required.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(replaceable.reserves.load(Ordering::SeqCst), 1);
    assert!(!replaceable.finishes.lock().unwrap()[0].request_dispatched);
}

#[tokio::test]
async fn required_meter_remains_exactly_once_across_idempotent_install_and_source_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let required = Arc::new(Stats::default());
    let source = Arc::new(Stats::default());
    let guard = observer(&required, false, false, false, false, None);
    let engine = engine(temp.path(), calls.clone())
        .with_mandatory_native_model_request_observer(guard.clone())
        .unwrap()
        .with_mandatory_native_model_request_observer(guard)
        .unwrap()
        .with_native_model_request_observer(observer(&source, false, false, false, false, None))
        .unwrap();
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    while stream.next().await.is_some() {}
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(required.reserves.load(Ordering::SeqCst), 1);
    assert_eq!(required.finishes.lock().unwrap().len(), 1);
    assert_eq!(source.finishes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn mandatory_guards_and_original_actor_fences_survive_inherited_provider_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let required = Arc::new(Stats::default());
    let original = engine(temp.path(), calls.clone())
        .with_mandatory_native_model_request_observer(observer(
            &required, false, false, false, false, None,
        ))
        .unwrap();
    let foreign_root = tempfile::tempdir().unwrap();
    let inherited = TestEngineBuilder::new(foreign_root.path())
        .provider(original.current_provider())
        .build_with_profile_directory()
        .with_native_model_request_observer(observer(
            &Arc::new(Stats::default()),
            false,
            false,
            false,
            false,
            None,
        ))
        .unwrap();
    assert!(
        inherited
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn same_observer_identity_is_idempotent_and_inherited_owner_fences_survive_addition() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = Arc::new(Stats::default());
    let shared = observer(&first, false, false, false, false, None);
    let original = engine(temp.path(), calls.clone())
        .with_native_model_request_observer(shared.clone())
        .unwrap();
    let same = original
        .clone()
        .with_additional_native_model_request_observer(shared)
        .unwrap();
    let mut stream = same.current_provider().stream_messages(request()).unwrap();
    while stream.next().await.is_some() {}
    assert_eq!(first.reserves.load(Ordering::SeqCst), 1);
    let foreign_root = tempfile::tempdir().unwrap();
    let foreign_calls = Arc::new(AtomicUsize::new(0));
    let extra = Arc::new(Stats::default());
    let foreign = engine(foreign_root.path(), foreign_calls.clone())
        .inherit_native_model_requests_from(&original)
        .unwrap()
        .with_additional_native_model_request_observer(observer(
            &extra, false, false, false, false, None,
        ))
        .unwrap();
    assert!(
        foreign
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(foreign_calls.load(Ordering::SeqCst), 0);
    assert_eq!(extra.reserves.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn all_stream_checks_execute_and_neither_meter_can_remove_an_earlier_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = Arc::new(Stats::default());
    let second = Arc::new(Stats::default());
    let engine = engine(temp.path(), calls.clone())
        .with_native_model_request_observer(observer(&first, false, true, false, false, None))
        .unwrap()
        .with_additional_native_model_request_observer(observer(
            &second, false, false, false, false, None,
        ))
        .unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(first.checks.load(Ordering::SeqCst) > 0);
    assert!(second.checks.load(Ordering::SeqCst) > 0);
    let a = Instant::now() + std::time::Duration::from_secs(1);
    let b = a + std::time::Duration::from_secs(60);
    let lease = AdditionalLease {
        original: Box::new(Lease {
            stats: first,
            check_error: false,
            usage_error: false,
            finish_error: false,
            deadline: Some(a),
        }),
        additional: Box::new(Lease {
            stats: second,
            check_error: false,
            usage_error: false,
            finish_error: false,
            deadline: Some(b),
        }),
    };
    assert_eq!(lease.deadline(), Some(a));
}
#[tokio::test]
async fn usage_and_finish_reach_both_original_leases_even_when_the_first_write_fails() {
    let temp = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let first = Arc::new(Stats::default());
    let second = Arc::new(Stats::default());
    let engine = engine(temp.path(), calls.clone())
        .with_native_model_request_observer(observer(&first, false, false, true, true, None))
        .unwrap()
        .with_additional_native_model_request_observer(observer(
            &second, false, false, false, false, None,
        ))
        .unwrap();
    let mut stream = engine
        .current_provider()
        .stream_messages(request())
        .unwrap();
    while stream.next().await.is_some() {}
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(first.usage.load(Ordering::SeqCst) > 0);
    assert!(second.usage.load(Ordering::SeqCst) > 0);
    assert_eq!(first.finishes.lock().unwrap().len(), 1);
    assert_eq!(second.finishes.lock().unwrap().len(), 1);
    assert!(first.finishes.lock().unwrap()[0].request_dispatched);
    assert!(second.finishes.lock().unwrap()[0].request_dispatched);
}
struct BudgetObserver {
    ledger: Arc<NativeBudgetStore>,
    policy: NativeBudgetPolicy,
    stats: Arc<Stats>,
}
struct BudgetLease {
    ledger: Arc<NativeBudgetStore>,
    receipt: BudgetReservationReceipt,
    stats: Arc<Stats>,
}
fn budget_request(id: &str, tokens: u64) -> NativeBudgetRequest {
    NativeBudgetRequest {
        reservation_id: id.into(),
        operation_id: format!("operation-{id}"),
        principal: NativeBudgetPrincipal::from_native_facts(
            "native-test-account".into(),
            None,
            None,
            None,
        )
        .unwrap(),
        unit: BudgetUnit::ModelCall,
        task: BudgetTaskLink {
            root_operation_id: "original-native-root".into(),
            root_task: Some(IntegrationEntityRef {
                kind: IntegrationEntityKind::Turn,
                id: "actual-combiner-source-turn".into(),
                revision: None,
            }),
            actor: BudgetActor::Main,
            actor_attempt_id: id.into(),
            parent_reservation_id: None,
        },
        estimate: BudgetCharge {
            tokens,
            model_calls: 1,
            run_millis: 1,
            cost_micros: None,
        },
    }
}
impl NativeModelRequestObserver for BudgetObserver {
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        _: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        assert!(context.execution().matches_state(context.state()));
        let id = format!("current-{}", context.call_id());
        let BudgetReservationResult::Created(receipt) = self
            .ledger
            .reserve(
                &budget_request(&id, 10),
                std::slice::from_ref(&self.policy),
                10,
            )
            .map_err(|_| NativeModelRequestError::Unavailable)?
        else {
            return Err(NativeModelRequestError::Denied);
        };
        let BudgetDispatchResult::Fresh(receipt) = self
            .ledger
            .mark_dispatched(
                &id,
                receipt.revision,
                std::slice::from_ref(&self.policy),
                10,
            )
            .map_err(|_| NativeModelRequestError::Unavailable)?
        else {
            return Err(NativeModelRequestError::Denied);
        };
        Ok(Box::new(BudgetLease {
            ledger: self.ledger.clone(),
            receipt,
            stats: self.stats.clone(),
        }))
    }
}
impl NativeModelRequestLease for BudgetLease {
    fn finish(
        self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        assert!(!settlement.request_dispatched);
        let terminal = NativeBudgetTerminal::from_authoritative_receipt(
            self.receipt.operation_id.clone(),
            self.receipt.task.root_task.clone(),
            self.receipt.task.actor_attempt_id.clone(),
            "native-combiner-inner-not-called".into(),
            "a".repeat(64),
            BudgetTerminalKind::VerifiedNotStarted,
        )
        .unwrap();
        self.ledger
            .record_usage(
                &self.receipt.reservation_id,
                self.receipt.revision,
                "native-combiner-known-not-started",
                &NativeBudgetUsage {
                    coverage: BudgetUsageCoverage::Complete,
                    known: BudgetCharge::zero(),
                },
                Some(&terminal),
                11,
            )
            .map_err(|_| NativeModelRequestError::Unavailable)?;
        self.stats.finishes.lock().unwrap().push(settlement);
        Ok(())
    }
}
#[tokio::test]
async fn later_reserve_rejection_settles_only_this_unstarted_call_and_preserves_older_dispatched_unknown_charge()
 {
    let temp = tempfile::tempdir().unwrap();
    let profile = PrivateDirectory::open_existing(temp.path())
        .unwrap()
        .create_private_child(OsStr::new("owned-budget"))
        .unwrap();
    let scope = IntegrationScope {
        account_id: "native-test-account".into(),
        target_id: "native-test-target".into(),
        workspace_id: IntegrationNullable::Null,
        identity_generation: "native-generation".into(),
        target_revision: "native-config".into(),
        organization_id: None,
    };
    let ledger =
        Arc::new(NativeBudgetStore::create_in(&profile, OsStr::new("ledger"), &scope).unwrap());
    let policy = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
        id: "actual-test-native-policy".into(),
        version: 1,
        revision: "actual-policy-r1".into(),
        scope: BudgetScope::Account(scope.account_id.clone()),
        window: BudgetWindow {
            id: "original-window".into(),
            starts_at_ms: 0,
            ends_at_ms: 1000,
        },
        limits: BudgetLimits {
            tokens: Some(100),
            concurrent_calls: Some(4),
            ..Default::default()
        },
        currency: None,
    })
    .unwrap();
    let old = ledger
        .reserve(
            &budget_request("older-unknown-call", 25),
            std::slice::from_ref(&policy),
            1,
        )
        .unwrap()
        .receipt()
        .clone();
    ledger
        .mark_dispatched(
            &old.reservation_id,
            old.revision,
            std::slice::from_ref(&policy),
            2,
        )
        .unwrap();
    let stats = Arc::new(Stats::default());
    let denied = Arc::new(Stats::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = engine(temp.path(), calls.clone())
        .with_native_model_request_observer(Arc::new(BudgetObserver {
            ledger: ledger.clone(),
            policy,
            stats: stats.clone(),
        }))
        .unwrap()
        .with_additional_native_model_request_observer(observer(
            &denied, true, false, false, false, None,
        ))
        .unwrap();
    assert!(
        engine
            .current_provider()
            .stream_messages(request())
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(stats.finishes.lock().unwrap().len(), 1);
    assert!(!stats.finishes.lock().unwrap()[0].request_dispatched);
    let preserved = ledger
        .read_reservation("older-unknown-call")
        .unwrap()
        .unwrap();
    assert_eq!(preserved.phase, BudgetPhase::Dispatched);
    assert_eq!(preserved.coverage, BudgetUsageCoverage::Unreported);
    assert_eq!(preserved.charged.tokens, 25);
    assert!(!preserved.execution_confirmed_terminal);
}
