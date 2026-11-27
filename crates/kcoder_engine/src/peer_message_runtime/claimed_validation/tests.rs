use super::*;
use crate::test_support::engine_builder::TestEngineBuilder;
use kcoder_state::{PeerAutoWakeClaim, cross_session_messages::*, peer_agent_history::*};
use kcoder_types::{Message, TurnAttemptIdentity, cross_session_messages::*};
use std::{
    ffi::OsStr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

struct ActualAuthority;
#[async_trait::async_trait]
impl PeerMessageAuthorization for ActualAuthority {
    async fn check_current(
        &self,
        _: PeerHistoryAccess,
        state: &kcoder_state::AppState,
        owner: &kcoder_state::AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            owner.try_matches(state) == Some(true)
                && record.intent.target_thread_id == state.session_id(),
            "owned original target changed"
        );
        Ok(())
    }
}

#[test]
fn claimed_validation_distinguishes_busy_changes_expiry_and_actual_turn_retirement() {
    crate::test_support::owned_case::run_owned_case(
        "kcoder_engine::peer_provider_start::tests::owned_claimed_start_case",
        "claimed-validation-facts",
    );
}

pub(crate) async fn run() {
    assert_eq!(
        crate::test_support::owned_case::owned_case(),
        "claimed-validation-facts"
    );
    let root = crate::test_support::owned_case::owned_tempdir();
    let engine = TestEngineBuilder::new(root.path())
        .owned_test_fixture()
        .build_with_profile_directory();
    engine
        .state
        .with_history_path(root.path().join(format!("{}.jsonl", engine.session_id())));
    engine
        .state
        .add_message(Message::user_text("Owned original user input"));
    engine.state.flush_history().await.unwrap();
    let state = engine.state.clone();
    let owner = state.inspection_lifecycle_identity();
    let store = Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("validation-queue"),
            &CrossSessionMessageScope {
                account_id: "owned".into(),
                target_id: "target".into(),
                workspace_id: "workspace".into(),
            },
        )
        .unwrap(),
    );
    let receipt = store
        .enqueue(
            &CrossSessionMessageSource {
                thread_id: "original-source".into(),
                principal_id: "owned".into(),
                address: None,
            },
            AgentMessageIntent {
                target_thread_id: state.session_id(),
                target_address: None,
                client_message_id: "original-validation-cid".into(),
                mode: AgentMessageMode::WakeIfIdle,
                expected_turn_id: None,
                reply_to_message_id: None,
                text: "Original immutable contribution".into(),
            },
            store.revision().unwrap(),
        )
        .unwrap();
    let lease = store
        .reserve_next(&state.session_id(), store.revision().unwrap(), 100, 200)
        .unwrap()
        .unwrap();
    let mut presence = state
        .commit_peer_message(&owner, &lease, &ActualAuthority)
        .await
        .unwrap();
    store
        .finish_applied_at_idle(&lease, &presence, store.revision().unwrap())
        .unwrap();
    store.attach_pending_peer_idle_wake(&mut presence).unwrap();
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&presence, store.revision().unwrap())
        .unwrap()
    else {
        panic!("original permit")
    };
    let clock = Arc::new(AtomicU64::new(0));
    let deadline = permit.install_provider_test_clock(clock.clone()).unwrap();
    clock.store(deadline - 1, Ordering::Release);
    assert!(permit.try_begin().unwrap());
    let permit: Arc<kcoder_state::PeerAutoWakePermit> = Arc::from(permit);
    let identity = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "original-owned-turn".into(),
        attempt_id: "original-owned-attempt".into(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    state
        .history_attempt_scope(identity.clone())
        .unwrap()
        .run(async {
            let registration = engine
                .owned_turns
                .register(&state, identity, cancel.clone())
                .await
                .unwrap();
            let scope = Arc::new(crate::peer_provider_start::PeerProviderScope::new());
            scope.bind_current_task(&engine).unwrap();
            permit.bind_provider_stream(scope.id).unwrap();
            let call = PeerMessageCall::claimed_provider_start(
                state.clone(),
                owner.clone(),
                permit.clone(),
                scope.clone(),
                cancel.clone(),
            );
            let record = store
                .get_record_by_message_id(&receipt.message_id)
                .unwrap()
                .unwrap();
            call.verify_claimed_start_record(&record).unwrap();
            let mut changed = record.clone();
            changed.intent.text.push_str(" changed");
            engine.owned_turns.with_entries_locked_for_owned_test(|| {
                permit.verify_original_record(&record).unwrap();
                let busy = call.verify_claimed_start_record(&record).unwrap_err();
                assert!(
                    PeerMessageCall::is_temporary_claim_validation(&busy),
                    "{busy:#}"
                );
                assert_eq!(
                    PeerMessageCall::claim_validation_reason(&busy),
                    "target_turn_owner_busy"
                );
                let invalid = call.verify_claimed_start_record(&changed).unwrap_err();
                assert!(!PeerMessageCall::is_temporary_claim_validation(&invalid));
                assert_eq!(
                    PeerMessageCall::claim_validation_reason(&invalid),
                    "PEER_HISTORY_RECORD_MISMATCH"
                );
            });
            call.verify_claimed_start_record(&record).unwrap();
            assert!(permit.try_mark_provider_dispatched(&state, &owner).unwrap());
            clock.store(deadline + 1, Ordering::Release);
            let no_response = call.verify_claimed_start_record(&record).unwrap_err();
            assert_eq!(
                PeerMessageCall::claim_validation_reason(&no_response),
                "PEER_WAKE_PROVIDER_RESPONSE_REQUIRED"
            );
            assert!(!PeerMessageCall::is_temporary_claim_validation(
                &no_response
            ));
            clock.store(deadline - 1, Ordering::Release);
            registration.finish().await;
            let retired = call.verify_claimed_start_record(&record).unwrap_err();
            assert!(!PeerMessageCall::is_temporary_claim_validation(&retired));
            cancel.cancel();
            assert!(!PeerMessageCall::is_temporary_claim_validation(
                &call.verify_claimed_start_record(&record).unwrap_err()
            ));
            assert_eq!(
                permit.observed_budget_usage().unwrap().1,
                1,
                "no new claim or refund"
            );
        })
        .await;
}
