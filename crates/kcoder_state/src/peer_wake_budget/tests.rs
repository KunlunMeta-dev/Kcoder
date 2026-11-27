use super::*;
use crate::{
    CommittedUserInput, Message, UserInputStart, cross_session_messages::*, peer_agent_history::*,
};
use kcoder_types::cross_session_messages::*;
use std::{ffi::OsStr, sync::Arc};

#[path = "provider_start_tests.rs"]
mod provider_start_tests;
#[path = "start_contention_tests.rs"]
mod start_contention_tests;

struct OwnedAuthority;
#[async_trait::async_trait]
impl PeerMessageAuthorization for OwnedAuthority {
    async fn check_current(
        &self,
        _: PeerHistoryAccess,
        target: &AppState,
        owner: &AppStateLifecycleIdentity,
        record: &CrossSessionMessageRecord,
    ) -> Result<()> {
        ensure!(
            owner.try_matches(target) == Some(true)
                && target.session_id() == record.intent.target_thread_id
                && record.source.thread_id == "owned-source",
            "owned budget scope changed"
        );
        Ok(())
    }
}
async fn user(state: &AppState, text: &str) -> CommittedUserInput {
    let owner = state.inspection_lifecycle_identity();
    match state.try_begin_user_input(&owner, Message::user_text(text)) {
        UserInputStart::Accepted(pending) => pending.wait_with_witness().await.unwrap(),
        _ => panic!("owned User input was not accepted"),
    }
}
async fn peer(
    store: &CrossSessionMessageStore,
    state: &AppState,
    id: &str,
    mode: AgentMessageMode,
) -> PeerHistoryCommitWitness {
    store
        .enqueue(
            &CrossSessionMessageSource {
                thread_id: "owned-source".into(),
                principal_id: "owned-principal".into(),
                address: None,
            },
            AgentMessageIntent {
                reply_to_message_id: None,
                target_thread_id: state.session_id(),
                target_address: None,
                client_message_id: id.into(),
                mode,
                expected_turn_id: None,
                text: format!("Owned peer reference {id}"),
            },
            store.revision().unwrap(),
        )
        .unwrap();
    let lease = store
        .reserve_next(&state.session_id(), store.revision().unwrap(), 100, 200)
        .unwrap()
        .unwrap();
    let witness = state
        .commit_peer_message(
            &state.inspection_lifecycle_identity(),
            &lease,
            &OwnedAuthority,
        )
        .await
        .unwrap();
    store
        .finish_applied_at_idle(&lease, &witness, store.revision().unwrap())
        .unwrap();
    witness
}
fn queue(root: &kcoder_config::PrivateTempDir) -> Arc<CrossSessionMessageStore> {
    Arc::new(
        CrossSessionMessageStore::create_in(
            &kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap(),
            OsStr::new("wake-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap(),
    )
}

#[tokio::test]
async fn saved_four_wake_budget_can_continue_without_a_new_user_message() {
    let root = kcoder_config::create_private_temp_dir("peer-wake-continuation").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let store = queue(&root);
    let input = user(&state, "Original actual User task").await;
    let reset = input.peer_wake_reset_witness().unwrap().unwrap();
    store
        .record_fresh_peer_user_reset(&reset, store.revision().unwrap())
        .unwrap();
    for n in 0..4 {
        let witness = peer(
            &store,
            &state,
            &format!("legacy-wake-{n}"),
            AgentMessageMode::WakeIfIdle,
        )
        .await;
        assert!(matches!(
            store
                .claim_peer_auto_wake(&witness, store.revision().unwrap())
                .unwrap(),
            PeerAutoWakeClaim::Permit(_)
        ));
    }
    drop(store);
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
    let restored = Arc::new(
        CrossSessionMessageStore::open_in(
            &parent,
            OsStr::new("wake-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap()
        .unwrap(),
    );
    let next = peer(
        &restored,
        &state,
        "legacy-wake-4",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    assert!(matches!(
        restored
            .claim_peer_auto_wake(&next, restored.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::Permit(_)
    ));
    assert!(
        !restored
            .record_fresh_peer_user_reset(&reset, restored.revision().unwrap())
            .unwrap()
    );
}

#[tokio::test]
async fn bounded_attempts_are_durable_cancellation_has_no_refund_and_only_fresh_user_resets() {
    let root = kcoder_config::create_private_temp_dir("peer-wake-budget-owned").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let store = queue(&root);
    let input = user(&state, "Original actual User task").await;
    let reset = input.peer_wake_reset_witness().unwrap().unwrap();
    assert!(
        store
            .record_fresh_peer_user_reset(&reset, store.revision().unwrap())
            .unwrap()
    );
    assert!(
        input.peer_wake_reset_witness().unwrap().is_none(),
        "receipt clones cannot reissue User reset authority"
    );
    let enqueue = peer(&store, &state, "enqueue", AgentMessageMode::EnqueueOnly).await;
    assert!(matches!(
        store
            .claim_peer_auto_wake(&enqueue, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::NotEligible
    ));
    let mut triggers = Vec::new();
    for n in 0..32 {
        let witness = peer(
            &store,
            &state,
            &format!("wake-{n}"),
            AgentMessageMode::WakeIfIdle,
        )
        .await;
        let PeerAutoWakeClaim::Permit(permit) = store
            .claim_peer_auto_wake(&witness, store.revision().unwrap())
            .unwrap()
        else {
            panic!("expected one durable permit");
        };
        if n != 1 {
            assert!(permit.try_begin().unwrap());
            assert!(!permit.try_begin().unwrap());
        }
        // n=1 is cancelled before any provider start. Dropping cannot refund it.
        drop(permit);
        assert!(matches!(
            store
                .claim_peer_auto_wake(&witness, store.revision().unwrap())
                .unwrap(),
            PeerAutoWakeClaim::AlreadyClaimed
        ));
        triggers.push(witness);
    }
    let over_limit = peer(&store, &state, "wake-32", AgentMessageMode::WakeIfIdle).await;
    assert!(matches!(
        store
            .claim_peer_auto_wake(&over_limit, store.revision().unwrap())
            .unwrap(),
        PeerAutoWakeClaim::Exhausted {
            limit: 32,
            used: 32
        }
    ));
    assert!(
        !store
            .record_fresh_peer_user_reset(&reset, store.revision().unwrap())
            .unwrap(),
        "same User does not refill used attempts"
    );
    drop(store);
    let parent = kcoder_config::PrivateDirectory::open_existing(root.path()).unwrap();
    let store = Arc::new(
        CrossSessionMessageStore::open_in(
            &parent,
            OsStr::new("wake-queue"),
            &CrossSessionMessageScope {
                account_id: "owned-account".into(),
                target_id: "owned-target".into(),
                workspace_id: "owned-workspace".into(),
            },
        )
        .unwrap()
        .unwrap(),
    );
    state
        .set_messages_after_compaction(
            vec![Message::compaction_text("A real compact summary")],
            crate::CompactionTranscriptEvent {
                trigger: crate::CompactionTrigger::Manual,
                pre_tokens: 1000,
                post_tokens: 10,
                summary: "A real compact summary".into(),
            },
        )
        .await
        .unwrap();
    assert!(
        matches!(
            store
                .claim_peer_auto_wake(&over_limit, store.revision().unwrap())
                .unwrap(),
            PeerAutoWakeClaim::NotEligible
        ),
        "restart and compaction never reactivate an exhausted original trigger"
    );
    let fresh = user(&state, "A genuinely new User instruction").await;
    let fresh_reset = fresh.peer_wake_reset_witness().unwrap().unwrap();
    assert!(
        store
            .record_fresh_peer_user_reset(&fresh_reset, store.revision().unwrap())
            .unwrap()
    );
    assert!(
        store
            .record_fresh_peer_user_reset(&reset, store.revision().unwrap())
            .is_err(),
        "an older native User row cannot reset a newer epoch"
    );
    assert!(
        matches!(
            store
                .claim_peer_auto_wake(&triggers[0], store.revision().unwrap())
                .unwrap(),
            PeerAutoWakeClaim::AlreadyClaimed
        ),
        "User reset never reactivates a previously consumed trigger"
    );
    assert!(
        matches!(
            store
                .claim_peer_auto_wake(&over_limit, store.revision().unwrap())
                .unwrap(),
            PeerAutoWakeClaim::NotEligible
        ),
        "fresh User never revives a previously exhausted trigger"
    );
    let sixth = peer(
        &store,
        &state,
        "wake-after-user",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&sixth, store.revision().unwrap())
        .unwrap()
    else {
        panic!("fresh User refills quota");
    };
    assert!(permit.try_begin().unwrap());
}

#[tokio::test]
async fn old_observation_and_identified_replay_never_mint_reset_and_native_receipt_is_independent()
{
    let root = kcoder_config::create_private_temp_dir("peer-wake-user-evidence").unwrap();
    let state = AppState::new(root.path());
    state.with_deferred_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let first = user(&state, "First native User with no old body").await;
    assert!(
        first.peer_wake_reset_witness().unwrap().is_some(),
        "first-body new append has positive evidence"
    );
    let second = user(&state, "Second original User").await;
    let owner = state.inspection_lifecycle_identity();
    let observed = second.downgrade().upgrade().unwrap();
    assert!(
        observed.peer_wake_reset_witness().unwrap().is_none(),
        "old receipt observation is not a new User action"
    );
    assert!(second.peer_wake_reset_witness().unwrap().is_some());
    assert!(
        second.try_take_native_row_receipt().unwrap().is_some(),
        "budget does not steal the original held row receipt"
    );
    let mut id_bytes = uuid::Uuid::new_v4().into_bytes();
    id_bytes[6] = (id_bytes[6] & 0x0f) | 0x50;
    let id = uuid::Uuid::from_bytes(id_bytes).to_string();
    let message = Message::user_text("Identified actual User answer");
    let pending = match state.try_begin_user_input_identified(&owner, message.clone(), &id) {
        UserInputStart::Accepted(pending) => pending,
        _ => panic!("identified input not accepted"),
    };
    let committed = pending.wait_with_witness().await.unwrap();
    assert!(committed.peer_wake_reset_witness().unwrap().is_some());
    let observed = state
        .find_committed_user_input_identified(&owner, &id, &message)
        .await
        .unwrap()
        .unwrap();
    assert!(observed.peer_wake_reset_witness().unwrap().is_none());
    let entry = crate::load_transcript_history(&state.history_path().unwrap())
        .unwrap()
        .into_iter()
        .find(|entry| entry.uuid.as_deref() == Some(id.as_str()))
        .unwrap();
    let source = state.read_inner().history_source.clone().unwrap();
    let (outcome, fact) = source.append_identified_with_user_reset(&entry).unwrap();
    assert!(matches!(
        outcome,
        crate::history_store::IdentifiedAppendOutcome::AlreadyPresent
    ));
    assert!(fact.is_none());
    let ephemeral = AppState::new(root.path());
    let receipt = user(&ephemeral, "Ephemeral User").await;
    assert!(receipt.peer_wake_reset_witness().unwrap().is_none());
}

#[tokio::test]
async fn new_user_invalidates_an_unstarted_permit_and_history_replacement_does_not_restore_it() {
    let root = kcoder_config::create_private_temp_dir("peer-wake-permit-fence").unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join(format!("{}.jsonl", state.session_id())));
    let store = queue(&root);
    let _ = user(&state, "A real User").await;
    let witness = peer(
        &store,
        &state,
        "pending-start",
        AgentMessageMode::WakeIfIdle,
    )
    .await;
    let PeerAutoWakeClaim::Permit(permit) = store
        .claim_peer_auto_wake(&witness, store.revision().unwrap())
        .unwrap()
    else {
        panic!("expected permit");
    };
    let input = user(&state, "A later real User takes over").await;
    let reset = input.peer_wake_reset_witness().unwrap().unwrap();
    store
        .record_fresh_peer_user_reset(&reset, store.revision().unwrap())
        .unwrap();
    assert!(
        permit.try_begin().is_err(),
        "a pending old budget epoch cannot start after fresh User reset"
    );
    let source = state.read_inner().history_source.clone().unwrap();
    source.replace(b"a different native body\n").unwrap();
    assert!(permit.try_begin().is_err());
}
