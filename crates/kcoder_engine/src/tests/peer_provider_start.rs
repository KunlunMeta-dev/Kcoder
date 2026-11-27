//! The real Engine dispatch boundary must read current authority after claim.
use crate::{
    EngineEvent,
    peer_message_runtime::{PeerMessageCall, PeerMessageHost},
    test_support::engine_builder::TestEngineBuilder,
};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use futures::StreamExt;
use kcoder_api::{ApiErrorKind, Provider, ProviderStream};
use kcoder_state::{
    AppState, AppStateLifecycleIdentity, PeerAutoWakeClaim, PeerAutoWakePermit,
    cross_session_messages::*, peer_agent_history::*,
};
use kcoder_types::{
    ContentBlock, Message, MessagesRequest, StreamEvent, cross_session_messages::*,
};
use std::{
    ffi::OsStr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
#[path = "peer_provider_composition.rs"]
mod composition;
#[path = "peer_provider_continuation.rs"]
mod continuation;
#[path = "peer_provider_expiry.rs"]
mod expiry;

#[test]
fn peer_native_model_health_composition_dispatches_the_original_provider_once() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_provider_start::tests::owned_claimed_start_case",
        "claimed-model-health-composition",
    );
}

#[test]
fn long_prefill_continuation_requires_real_response_and_the_original_live_turn() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_provider_start::tests::owned_claimed_start_case",
        "claimed-expiry-matrix",
    );
}

#[test]
fn pre_first_provider_settlement_waits_for_original_queue_reader_without_reclaiming() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_provider_start::tests::owned_claimed_start_case",
        "claimed-first-settlement",
    );
}

#[test]
fn claimed_stream_tool_continuation_rechecks_source_and_keeps_the_same_permit_during_writer_contention()
 {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_provider_start::tests::owned_claimed_start_case",
        "claimed-tool-continuation",
    );
}

struct CountingProvider(Arc<AtomicUsize>);
impl Provider for CountingProvider {
    fn name(&self) -> &'static str {
        "owned-claimed-peer-provider"
    }
    fn stream_messages(&self, _: MessagesRequest) -> Result<ProviderStream, ApiErrorKind> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Box::pin(futures::stream::iter([
            Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: "Original claimed peer response".into(),
                },
            }),
            Ok(StreamEvent::ContentBlockStop { index: 0 }),
            Ok(StreamEvent::MessageStop),
        ])))
    }
}

struct CurrentAuthority;
#[async_trait]
impl PeerMessageAuthorization for CurrentAuthority {
    async fn check_current(
        &self,
        _: PeerHistoryAccess,
        state: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            owner.try_matches(state) == Some(true)
                && record.source.thread_id == "owned-original-source"
                && record.intent.target_thread_id == state.session_id(),
            "owned target changed"
        );
        Ok(())
    }
}

struct CurrentHost {
    store: Arc<CrossSessionMessageStore>,
    source_allowed: AtomicBool,
    provider_checks: AtomicUsize,
    settlement_unavailable: AtomicBool,
}
#[async_trait]
impl PeerMessageHost for CurrentHost {
    async fn apply_at_boundary(
        &self,
        call: PeerMessageCall,
    ) -> Result<Vec<PeerHistoryCommitWitness>, String> {
        let Some(lease) = self
            .store
            .reserve_next(
                &call.state().session_id(),
                self.store.revision().map_err(|error| error.to_string())?,
                100,
                200,
            )
            .map_err(|error| error.to_string())?
        else {
            return Ok(Vec::new());
        };
        let mut witness = call
            .state()
            .commit_peer_message(call.owner(), &lease, &CurrentAuthority)
            .await
            .map_err(|error| error.to_string())?;
        let revision = self.store.revision().map_err(|error| error.to_string())?;
        if call.is_idle() {
            self.store
                .finish_applied_at_idle(&lease, &witness, revision)
        } else {
            self.store.finish_applied(&lease, &witness, revision)
        }
        .map_err(|error| error.to_string())?;
        self.store
            .attach_pending_peer_idle_wake(&mut witness)
            .map_err(|error| error.to_string())?;
        Ok(vec![witness])
    }
    async fn claim_idle_wake(
        &self,
        _: PeerMessageCall,
        witnesses: &[PeerHistoryCommitWitness],
    ) -> Result<PeerAutoWakeClaim, String> {
        if !self.source_allowed.load(Ordering::Acquire) {
            return Err("owned_source_unavailable".into());
        }
        self.store
            .claim_peer_auto_wake(
                &witnesses[0],
                self.store.revision().map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())
    }
    async fn authorize_claimed_provider_start(
        &self,
        call: PeerMessageCall,
        permit: &PeerAutoWakePermit,
    ) -> Result<(), String> {
        assert!(
            !call.is_idle(),
            "a registered turn is never relabeled as idle"
        );
        assert!(
            call.has_current_claimed_peer_start(),
            "original claimed call: {:?}",
            call.verify_current_provider_invocation(permit)
        );
        call.verify_current_provider_invocation(permit)
            .map_err(|error| error.to_string())?;
        self.provider_checks.fetch_add(1, Ordering::SeqCst);
        if !self.source_allowed.load(Ordering::Acquire) {
            return Err("owned_claimed_source_revoked".into());
        }
        Ok(())
    }
    async fn settle_idle_wakes_in_provider_context(
        &self,
        call: PeerMessageCall,
        messages: &kcoder_types::SharedMessages,
    ) -> Result<(), String> {
        if self.settlement_unavailable.load(Ordering::Acquire) {
            return Err("owned_peer_store_unavailable".into());
        }
        call.settle_idle_wakes_in_provider_context(&self.store, messages)
            .map_err(|error| error.to_string())
    }
}

#[test]
fn fresh_source_is_checked_after_claim_and_the_original_permit_cannot_start_a_second_stream() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_provider_start::tests::owned_claimed_start_case",
        "fresh-claimed-start",
    );
}

#[tokio::test]
#[ignore = "owned subprocess fixture executed by its parent"]
async fn owned_claimed_start_case() {
    if crate::test_support::owned_case::owned_case() == "claimed-validation-facts" {
        crate::peer_message_runtime::run_claimed_validation_test().await;
        return;
    }
    if crate::test_support::owned_case::owned_case() == "claimed-model-health-composition" {
        composition::run().await;
        return;
    }
    if crate::test_support::owned_case::owned_case() == "claimed-expiry-matrix" {
        expiry::run().await;
        return;
    }
    if crate::test_support::owned_case::owned_case() == "claimed-first-settlement" {
        continuation::run_settlement().await;
        return;
    }
    if crate::test_support::owned_case::owned_case() == "claimed-tool-continuation" {
        continuation::run().await;
        return;
    }
    assert_eq!(
        crate::test_support::owned_case::owned_case(),
        "fresh-claimed-start"
    );
    let root = crate::test_support::owned_case::owned_tempdir();
    let calls = Arc::new(AtomicUsize::new(0));
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .provider(Arc::new(CountingProvider(calls.clone())))
        .build_with_profile_directory();
    engine
        .state
        .with_history_path(root.path().join(format!("{}.jsonl", engine.session_id())));
    engine
        .state
        .add_message(Message::user_text("Original actual User task"));
    engine.state.flush_history().await.unwrap();
    let store = Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("claimed-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap(),
    );
    let host = Arc::new(CurrentHost {
        store: store.clone(),
        source_allowed: AtomicBool::new(true),
        provider_checks: AtomicUsize::new(0),
        settlement_unavailable: AtomicBool::new(false),
    });
    let engine = engine.with_peer_message_host(host.clone());
    let enqueue = |id: &str| {
        store
            .enqueue(
                &CrossSessionMessageSource {
                    thread_id: "owned-original-source".into(),
                    principal_id: "owned-principal".into(),
                    address: None,
                },
                AgentMessageIntent {
                    reply_to_message_id: None,
                    target_thread_id: engine.session_id(),
                    target_address: None,
                    client_message_id: id.into(),
                    mode: AgentMessageMode::WakeIfIdle,
                    expected_turn_id: None,
                    text: format!("Original claimed contribution {id}"),
                },
                store.revision().unwrap(),
            )
            .unwrap();
    };
    enqueue("first");
    let first = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&first).await.unwrap()
    else {
        panic!("first original permit missing")
    };
    let peer = engine
        .clone()
        .prepare_peer_auto_wake_start(permit)
        .await
        .unwrap();
    host.source_allowed.store(false, Ordering::Release);
    let events = peer
        .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert_eq!(
        host.provider_checks.load(Ordering::SeqCst),
        1,
        "the original current Source checker must observe the revocation"
    );
    assert!(
        events.iter().any(|event| matches!(event, EngineEvent::Error(message)
            if message == "KCoder peer turn authorization failed [peer_provider_start_unconfirmed]")),
        "{events:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "revocation after claim must precede Provider startup"
    );
    drop(peer);
    host.source_allowed.store(true, Ordering::Release);
    assert!(matches!(
        engine.claim_peer_auto_wake(&first).await.unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));

    enqueue("second");
    let second = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&second).await.unwrap()
    else {
        panic!("second original permit missing")
    };
    assert!(permit.try_begin().unwrap());
    let peer = engine
        .clone()
        .with_peer_auto_wake_start_permit(permit)
        .unwrap();
    let events = peer
        .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{events:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let replay = peer
        .run_peer_message_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        replay.iter().any(|event| matches!(event,
            EngineEvent::Error(code) if code == "peer_provider_start_actual_stream_changed")),
        "{replay:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(host.provider_checks.load(Ordering::SeqCst), 2);

    enqueue("auxiliary");
    let auxiliary = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&auxiliary).await.unwrap()
    else {
        panic!("original auxiliary permit missing")
    };
    assert!(permit.try_begin().unwrap());
    let auxiliary = engine
        .clone()
        .with_peer_auto_wake_start_permit(permit)
        .unwrap()
        .peer_turn_engine();
    // An activity flag alone supplies neither the canonical history scope nor
    // an actual OwnedTurn, including for auxiliary Provider requests.
    let active = crate::turn_driver::TurnDriverActiveGuard::new(&auxiliary);
    let (_, model, _, provider) = auxiliary.summary_runtime().unwrap();
    host.source_allowed.store(false, Ordering::Release);
    let events = provider
        .stream_messages(MessagesRequest::new(
            model,
            vec![Message::user_text("Actual auxiliary summary request")],
        ))
        .unwrap()
        .collect::<Vec<_>>()
        .await;
    assert!(events.iter().any(|event|matches!(event, Err(ApiErrorKind::PeerTurnAuthorization { summary, .. }) if summary.as_str() == "KCoder peer turn authorization failed [target_turn_history_scope_required]")), "{events:?}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "an activity flag cannot create a real auxiliary turn or dispatch a Provider"
    );
    assert_eq!(host.provider_checks.load(Ordering::SeqCst), 2);
    drop((active, provider, auxiliary));

    host.source_allowed.store(true, Ordering::Release);
    enqueue("cancelled-before-begin");
    let cancelled = engine.apply_peer_messages_at_idle().await.unwrap();
    let PeerAutoWakeClaim::Permit(permit) = engine.claim_peer_auto_wake(&cancelled).await.unwrap()
    else {
        panic!("original cancelled permit missing")
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    cancel.cancel();
    assert!(
        engine
            .clone()
            .with_cancel_token(cancel)
            .prepare_peer_auto_wake_start(permit)
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(matches!(
        engine.claim_peer_auto_wake(&cancelled).await.unwrap(),
        PeerAutoWakeClaim::AlreadyClaimed
    ));

    host.settlement_unavailable.store(true, Ordering::Release);
    let kcoder_state::UserInputStart::Accepted(user) = engine.state.try_begin_user_input(
        &engine.state.inspection_lifecycle_identity(),
        Message::user_text("A new actual User is independent of peer failures"),
    ) else {
        panic!("actual User was not admitted")
    };
    user.wait_with_witness().await.unwrap();
    let events = engine
        .run_turn_stream(&kcoder_permissions::AutoAllowPrompt)
        .collect::<Vec<_>>()
        .await;
    assert!(
        !events.iter().any(|event| matches!(
            event,
            EngineEvent::Error(_) | EngineEvent::ProviderFailed { .. }
        )),
        "{events:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        host.provider_checks.load(Ordering::SeqCst),
        2,
        "ordinary User turns never inherit a peer wrapper or its failure dependency"
    );
}
