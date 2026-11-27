use super::*;
use crate::history_flusher::{
    HistoryFlusher, QueuedHistoryCommand, process_history_flusher_command,
};
use crate::{HistorySource, load_history};
use kcoder_types::{ContentBlock, ImageSource};
use std::sync::mpsc as std_mpsc;
use tokio::sync::mpsc;

fn identified_uuid() -> String {
    let mut bytes = uuid::Uuid::new_v4().into_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn controlled(
    path: &std::path::Path,
) -> (
    AppState,
    mpsc::UnboundedReceiver<QueuedHistoryCommand>,
    Arc<HistoryFlusherQueue>,
) {
    let state = AppState::new(path.parent().unwrap());
    let source = HistorySource::bind(path).unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let flusher = HistoryFlusher::new(tx, source.clone());
    let queue = Arc::clone(&flusher.queue);
    {
        let mut inner = state.write_inner();
        inner.history_path = Some(path.to_owned());
        inner.history_source = Some(source);
        inner.history_flusher = Some(flusher);
    }
    (state, rx, queue)
}

fn accepted(outcome: UserInputStart) -> PendingUserInput {
    match outcome {
        UserInputStart::Accepted(pending) => pending,
        UserInputStart::Busy(_) => panic!("unexpected busy input"),
        UserInputStart::Rejected { error, .. } => panic!("unexpected rejection: {error}"),
        UserInputStart::Unknown { error, .. } => panic!("unexpected unknown: {error}"),
    }
}

fn accepted_identified(
    state: &AppState,
    owner: &AppStateLifecycleIdentity,
    mut message: Message,
    uuid: &str,
) -> PendingUserInput {
    for _ in 0..128 {
        match state.try_begin_user_input_identified(owner, message.clone(), uuid) {
            UserInputStart::Accepted(pending) => return pending,
            UserInputStart::Busy(returned) => message = returned,
            UserInputStart::Rejected {
                message: returned,
                reason: UserInputRejection::OwnerUnavailable,
                error,
            } if error == "identified input owner unavailable: Unavailable" => {
                message = returned;
            }
            outcome => return accepted(outcome),
        }
        std::thread::yield_now();
    }
    panic!("identified input admission remained busy beyond the bounded retry")
}

#[tokio::test(flavor = "current_thread")]
async fn scoped_lifecycle_distinguishes_absent_matching_and_foreign() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let original = AppState::new(first.path());
    let other = AppState::new(second.path());
    assert!(matches!(
        original.current_scoped_lifecycle_identity(),
        crate::ScopedLifecycleIdentity::Absent
    ));
    let attempt = TurnAttemptIdentity {
        thread_id: original.session_id(),
        turn_id: "original-turn".into(),
        attempt_id: "original-attempt".into(),
    };
    original
        .history_attempt_scope(attempt)
        .unwrap()
        .run(async {
            assert!(matches!(
                original.current_scoped_lifecycle_identity(),
                crate::ScopedLifecycleIdentity::Matching(_)
            ));
            assert!(matches!(
                other.current_scoped_lifecycle_identity(),
                crate::ScopedLifecycleIdentity::Foreign
            ));
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn busy_state_returns_the_same_message_without_blocking_or_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("busy.jsonl");
    let (state, mut rx, _) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let holder_state = state.clone();
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _state = holder_state.write_inner();
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "preserve".into(),
        },
        ContentBlock::Image {
            source: ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);
    match state.try_begin_user_input(&owner, message.clone()) {
        UserInputStart::Busy(returned) => assert_eq!(returned, message),
        _ => panic!("busy State must not consume the message"),
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    assert!(state.messages().is_empty());
    assert!(!path.exists());
}

#[test]
fn switched_lifecycle_rejects_original_message_before_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owner.jsonl");
    let (state, mut rx, _) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    // A restored session can have the same public session id and a new epoch.
    state.write_inner().history_attempts = Default::default();
    let message = Message::user_text("original");
    match state.try_begin_user_input(&owner, message.clone()) {
        UserInputStart::Rejected {
            message: returned,
            reason,
            ..
        } => {
            assert_eq!(returned, message);
            assert_eq!(reason, UserInputRejection::LifecycleChanged);
        }
        _ => panic!("stale native lifecycle must be rejected"),
    }
    assert!(state.messages().is_empty());
    assert!(rx.try_recv().is_err());
    assert!(!path.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn original_ticket_commits_structured_message_and_actual_attempt() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("structured.jsonl");
    let state = AppState::new(temp.path());
    state.with_history_path(&path);
    let owner = state.inspection_lifecycle_identity();
    let attempt = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "after hook".into(),
        },
        ContentBlock::Image {
            source: ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);
    let expected = message.clone();
    let (uuid, result) = state
        .history_attempt_scope(attempt.clone())
        .unwrap()
        .run(async {
            let pending = accepted(state.try_begin_user_input(&owner, message));
            assert_eq!(pending.attempt(), Some(&attempt));
            let uuid = pending.uuid().to_owned();
            (uuid, pending.wait().await.unwrap())
        })
        .await;
    assert_eq!(result, UserInputCommit::Durable);
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
    assert_eq!(entries[0].history_attempt, Some(attempt));
    assert_eq!(entries[0].message, expected);
}

#[tokio::test(flavor = "current_thread")]
async fn original_ticket_exposes_only_its_exact_live_row_once() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("existing.jsonl");
    std::fs::write(&path, b"")?;
    let state = AppState::new(temp.path());
    state.with_history_path(&path);
    let owner = state.inspection_lifecycle_identity();
    let attempt = TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "original".into(),
        },
        ContentBlock::Image {
            source: ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);
    let witness = state
        .history_attempt_scope(attempt.clone())?
        .run(async {
            accepted(state.try_begin_user_input(&owner, message.clone()))
                .wait_with_witness()
                .await
        })
        .await?;
    assert_eq!(witness.outcome(), UserInputCommit::Durable);
    let mut row = witness
        .try_take_native_row_receipt()?
        .expect("existing source must return a live row");
    row.verify_entry(
        &state.session_id(),
        witness.uuid(),
        Some(&attempt),
        &message,
        4096,
    )?;
    assert!(
        row.verify_entry(
            &state.session_id(),
            witness.uuid(),
            Some(&attempt),
            &Message::user_text("changed"),
            4096,
        )
        .is_err()
    );
    assert!(witness.try_take_native_row_receipt()?.is_none());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn new_source_and_ephemeral_input_have_no_live_row_receipt() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("new.jsonl");
    let state = AppState::new(temp.path());
    state.with_history_path(&path);
    let owner = state.inspection_lifecycle_identity();
    let witness = accepted(state.try_begin_user_input(&owner, Message::user_text("first")))
        .wait_with_witness()
        .await?;
    assert_eq!(witness.outcome(), UserInputCommit::Durable);
    assert!(witness.try_take_native_row_receipt()?.is_none());
    let ephemeral = AppState::new(temp.path());
    let owner = ephemeral.inspection_lifecycle_identity();
    let witness = accepted(ephemeral.try_begin_user_input(&owner, Message::user_text("memory")))
        .wait_with_witness()
        .await?;
    assert_eq!(witness.outcome(), UserInputCommit::Ephemeral);
    assert!(witness.try_take_native_row_receipt()?.is_none());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn original_ticket_waits_on_native_lock_without_blocking_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("locked-input.jsonl");
    let state = AppState::new(temp.path());
    state.with_history_path(&path);
    let source = state.read_inner().history_source.clone().unwrap();
    source.materialize().unwrap();
    let owner = state.inspection_lifecycle_identity();
    let lock_path = temp.path().join(".kcoder-history.lock");
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let held = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let thread_held = Arc::clone(&held);
    let holder = std::thread::spawn(move || {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        fs2::FileExt::lock_exclusive(&file).unwrap();
        thread_held.store(true, std::sync::atomic::Ordering::Release);
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
        fs2::FileExt::unlock(&file).unwrap();
        thread_held.store(false, std::sync::atomic::Ordering::Release);
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let uuid = pending.uuid().to_owned();
    let wait = tokio::spawn(pending.wait());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        held.load(std::sync::atomic::Ordering::Acquire),
        "ticket wait blocked the runtime"
    );
    assert!(!wait.is_finished());
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    assert_eq!(wait.await.unwrap().unwrap(), UserInputCommit::Durable);
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_overtaking_original_entry_never_acknowledges_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("snapshot.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let uuid = pending.uuid().to_owned();
    let command = rx.try_recv().unwrap();
    state.save_history().unwrap();
    process_history_flusher_command(&path, &queue, command);
    assert!(
        pending
            .wait()
            .await
            .unwrap_err()
            .to_string()
            .contains("superseded")
    );
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn equal_content_without_original_provenance_cannot_confirm_ticket() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("rewritten.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    state.set_messages(state.messages());
    assert!(pending.wait().await.is_err());
    assert_eq!(load_history(&path).unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn committed_input_witness_rejects_rewrite_after_observer_acceptance() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("committed-witness.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let uuid = pending.uuid().to_owned();
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    let committed = pending.wait_with_witness().await.unwrap();
    assert_eq!(committed.outcome(), UserInputCommit::Durable);
    assert_eq!(committed.uuid(), uuid);
    assert!(committed.try_is_current().unwrap());
    state.set_messages(state.messages());
    assert!(committed.try_is_current().is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn legitimate_background_append_preserves_original_ticket() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("background.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    state.add_message(Message::assistant_text("background append"));
    assert_eq!(pending.wait().await.unwrap(), UserInputCommit::Durable);
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    queue.flush(&path).unwrap();
    assert_eq!(load_history(&path).unwrap().len(), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn history_truncation_retains_the_exact_new_input_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("truncate.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    state.set_history_max_messages(2);
    state.add_message(Message::user_text("old input"));
    state.add_message(Message::assistant_text("old reply"));
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("new input")));
    let uuid = pending.uuid().to_owned();
    let attempt = pending.attempt().cloned();
    while let Ok(command) = rx.try_recv() {
        process_history_flusher_command(&path, &queue, command);
    }
    assert_eq!(pending.wait().await.unwrap(), UserInputCommit::Durable);
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[2].uuid.as_deref(), Some(uuid.as_str()));
    assert_eq!(entries[2].history_attempt, attempt);
    let inner = state.read_inner();
    let position = inner
        .message_history_ids
        .iter()
        .position(|id| id.as_deref() == Some(uuid.as_str()))
        .unwrap();
    assert_eq!(inner.messages[position], Message::user_text("new input"));
    assert_eq!(inner.history_attempts.get(&uuid), attempt);
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_ticket_observer_does_not_replay_or_cancel_the_original_write() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("dropped.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let uuid = pending.uuid().to_owned();
    drop(pending);
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    assert!(rx.try_recv().is_err());
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn repeated_cancelled_observers_release_only_successfully_settled_tickets() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("repeated-cancellation.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let mut ids = Vec::new();
    for index in 0..160 {
        let pending = accepted(
            state.try_begin_user_input(&owner, Message::user_text(format!("original-{index}"))),
        );
        ids.push(pending.uuid().to_owned());
        let slot = Arc::clone(&pending.slot);
        drop(pending);
        process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
        tokio::time::timeout(Duration::from_secs(5), async {
            while !slot.released.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("successfully settled dropped observer retained capacity");
        assert!(slot.success_settled.load(Ordering::Acquire));
        assert!(!slot.retain_unknown.load(Ordering::Acquire));
    }
    assert!(rx.try_recv().is_err());
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), ids.len());
    for (entry, uuid) in entries.iter().zip(ids) {
        assert_eq!(entry.uuid.as_deref(), Some(uuid.as_str()));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_after_owner_success_before_observer_confirmation_remains_unknown() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("late-snapshot.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let slot = Arc::clone(&pending.slot);
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        while !slot.success_settled.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!slot.released.load(Ordering::Acquire));
    state.set_messages(Vec::new());
    state.save_history().unwrap();
    assert!(pending.wait().await.is_err());
    assert!(slot.retain_unknown.load(Ordering::Acquire));
    assert!(!slot.released.load(Ordering::Acquire));
}

#[tokio::test(flavor = "current_thread")]
async fn closed_writer_rejects_input_without_mutating_state() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("closed.jsonl");
    let (state, rx, _) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    drop(rx);
    let message = Message::user_text("original");
    match state.try_begin_user_input(&owner, message.clone()) {
        UserInputStart::Rejected {
            message: returned,
            reason,
            ..
        } => {
            assert_eq!(returned, message);
            assert_eq!(reason, UserInputRejection::WriterUnavailable);
        }
        _ => panic!("closed writer must reject before mutation"),
    }
    assert!(state.messages().is_empty());
    assert!(!path.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn writer_closing_after_state_mutation_is_unknown_and_preserves_original_input() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("closed-during-admission.jsonl");
    let (state, mut rx, _) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_text("original");
    let pending =
        match state.try_begin_user_input_inner(&owner, message.clone(), |_| {}, |_| rx.close()) {
            UserInputStart::Unknown {
                message: returned,
                pending: Some(pending),
                ..
            } => {
                assert_eq!(returned, message);
                pending
            }
            _ => panic!("post-mutation close must remain unknown"),
        };
    assert!(pending.ticket_is_retained());
    assert!(pending.wait().await.is_err());
    assert_eq!(state.messages(), vec![message]);
    assert!(rx.try_recv().is_err());
    assert!(!path.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn panic_after_state_mutation_retains_original_intent_without_writer_replay() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("panic-before-ticket.jsonl");
    let (state, mut rx, _) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "preserved input".into(),
        },
        ContentBlock::Image {
            source: ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);
    let saved = Arc::new(std::sync::Mutex::new(None::<Arc<InputOwnerSlot>>));
    let captured = Arc::clone(&saved);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = state.try_begin_user_input_inner(
            &owner,
            message.clone(),
            |slot| {
                *captured.lock().unwrap() = Some(Arc::clone(slot));
                panic!("controlled admission interruption");
            },
            |_| {},
        );
    }));
    assert!(result.is_err());
    let slot = saved.lock().unwrap().clone().unwrap();
    let intent = slot.intent.get().expect("original intent must be retained");
    assert_eq!(intent.message, message);
    assert!(!intent.uuid.is_empty());
    assert!(intent.attempt.is_none());
    assert!(slot.original.get().is_none());
    assert!(!slot.released.load(Ordering::Acquire));
    tokio::task::yield_now().await;
    assert!(slot.stopped.load(Ordering::Acquire));
    assert!(!slot.released.load(Ordering::Acquire));
    assert!(rx.try_recv().is_err());
    assert!(!path.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_owner_handoff_retains_original_ticket_without_reissuing() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("failed-owner-handoff.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_text("original");
    let pending = match state.try_begin_user_input_inner(
        &owner,
        message.clone(),
        |_| {},
        |slot| {
            let id = *slot.owner_id.get().unwrap();
            assert!(crate::history_flusher::abort_input_owner(id));
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while !slot.stopped.load(Ordering::Acquire) {
                assert!(std::time::Instant::now() < deadline, "owner did not stop");
                std::thread::yield_now();
            }
        },
    ) {
        UserInputStart::Unknown {
            message: returned,
            pending: Some(pending),
            ..
        } => {
            assert_eq!(returned, message);
            pending
        }
        _ => panic!("failed owner handoff must retain the original pending ticket"),
    };
    let uuid = pending.uuid().to_owned();
    let slot = Arc::clone(&pending.slot);
    assert!(pending.ticket_is_retained());
    assert!(pending.wait().await.is_err());
    let command = rx.try_recv().unwrap();
    assert!(
        rx.try_recv().is_err(),
        "handoff failure must not reissue input"
    );
    process_history_flusher_command(&path, &queue, command);
    let original = slot.original.get().unwrap();
    assert_eq!(original.wait().await.unwrap(), UserInputCommit::Durable);
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn stopped_owner_keeps_the_same_original_ticket_available_for_observation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("stopped-owner.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let uuid = pending.uuid().to_owned();
    let slot = Arc::clone(&pending.slot);
    let original = Arc::clone(slot.original.get().unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        while original.reply.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owner never began observing the original ticket");
    assert!(crate::history_flusher::abort_input_owner(
        *slot.owner_id.get().unwrap()
    ));
    assert!(pending.wait().await.is_err());
    assert!(slot.stopped.load(Ordering::Acquire));
    assert!(slot.original.get().is_some());
    let command = rx.try_recv().unwrap();
    assert!(rx.try_recv().is_err());
    process_history_flusher_command(&path, &queue, command);
    assert_eq!(
        slot.original.get().unwrap().wait().await.unwrap(),
        UserInputCommit::Durable
    );
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[test]
fn bounded_owner_slots_reject_saturation_and_reuse_only_released_slots() {
    let slots = [OwnedSlot::new()];
    let first = reserve_from(&slots).unwrap();
    assert!(matches!(reserve_from(&slots), Err(SlotError::Full)));
    assert!(!first.released.load(Ordering::Acquire));
    first.released.store(true, Ordering::Release);
    let second = reserve_from(&slots).unwrap();
    assert!(!Arc::ptr_eq(&first, &second));
}

#[test]
fn poisoned_owner_shard_is_never_recycled_or_adopted() {
    let slots = [OwnedSlot::new()];
    let original = reserve_from(&slots).unwrap();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::history_flusher::poison_for_test(&slots[0]);
    }));
    assert!(matches!(reserve_from(&slots), Err(SlotError::Unavailable)));
    assert_eq!(
        crate::history_flusher::inspect_poisoned_for_test(&slots[0], |retained| Arc::ptr_eq(
            retained, &original
        )),
        Some(true)
    );
    assert!(!original.released.load(Ordering::Acquire));
}

#[tokio::test(flavor = "current_thread")]
async fn owner_capacity_failure_rejects_before_message_or_writer_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owner-capacity.jsonl");
    let (state, mut rx, _) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_text("preserve original");
    FAIL_OWNER_RESERVATION.with(|flag| flag.set(true));
    let outcome = state.try_begin_user_input(&owner, message.clone());
    FAIL_OWNER_RESERVATION.with(|flag| flag.set(false));
    match outcome {
        UserInputStart::Rejected {
            message: returned,
            error,
            reason,
            ..
        } => {
            assert_eq!(returned, message);
            assert_eq!(reason, UserInputRejection::OwnerCapacity);
            assert!(error.contains("owner unavailable"));
        }
        _ => panic!("owner capacity must reject before mutation"),
    }
    assert!(state.messages().is_empty());
    assert!(rx.try_recv().is_err());
    assert!(!path.exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn sixty_four_sessions_start_and_commit_without_registry_contention_failures() {
    let root = tempfile::tempdir().unwrap();
    let barrier = Arc::new(tokio::sync::Barrier::new(65));
    let mut tasks = Vec::new();
    for index in 0..64 {
        let directory = root.path().join(format!("session-{index}"));
        std::fs::create_dir(&directory).unwrap();
        let barrier = Arc::clone(&barrier);
        tasks.push(tokio::spawn(async move {
            let state = AppState::new(&directory);
            let path = directory.join("history.jsonl");
            barrier.wait().await;
            state.with_history_path(&path);
            let owner = state.inspection_lifecycle_identity();
            let text = format!("original-{index}");
            let pending = match state.try_begin_user_input(&owner, Message::user_text(text.clone()))
            {
                UserInputStart::Accepted(pending) => pending,
                UserInputStart::Busy(_) => panic!("independent session reported transient busy"),
                UserInputStart::Rejected { reason, error, .. } => {
                    panic!("independent session rejected: {reason:?} {error}")
                }
                UserInputStart::Unknown { error, .. } => {
                    panic!("independent session became unknown: {error}")
                }
            };
            let uuid = pending.uuid().to_owned();
            assert_eq!(pending.wait().await.unwrap(), UserInputCommit::Durable);
            let entries = load_history(&path).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
            assert_eq!(entries[0].message, Message::user_text(text));
        }));
    }
    barrier.wait().await;
    for task in tasks {
        tokio::time::timeout(Duration::from_secs(20), task)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn failed_original_write_faults_batch_and_is_not_retried_by_timer() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("corrupt.jsonl");
    std::fs::write(&path, b"{").unwrap();
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("original")));
    let slot = Arc::clone(&pending.slot);
    process_history_flusher_command(&path, &queue, rx.try_recv().unwrap());
    assert!(pending.wait().await.is_err());
    assert!(slot.retain_unknown.load(Ordering::Acquire));
    assert!(!slot.released.load(Ordering::Acquire));
    assert!(queue.write_fault().is_some());
    assert!(queue.flush(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{");
}

fn seed_large_session(state: &AppState, count: usize) {
    let mut inner = state.write_inner();
    inner.history_max_messages = count.saturating_add(10);
    inner.messages = vec![Message::runtime_text("retained"); count].into();
    inner.message_history_ids = (0..count)
        .map(|index| Some(format!("old-{index}")))
        .collect::<Vec<_>>()
        .into();
}

#[tokio::test(flavor = "current_thread")]
async fn normal_long_session_keeps_one_exact_input_without_unbounded_scanning() {
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());
    seed_large_session(&state, 100_000);
    let owner = state.inspection_lifecycle_identity();
    let started = std::time::Instant::now();
    let pending = accepted(state.try_begin_user_input(&owner, Message::user_text("new input")));
    let admission_elapsed = started.elapsed();
    let uuid = pending.uuid().to_owned();
    assert_eq!(pending.wait().await.unwrap(), UserInputCommit::Ephemeral);
    assert_eq!(
        state
            .read_inner()
            .message_history_ids
            .last()
            .and_then(Option::as_deref),
        Some(uuid.as_str())
    );
    eprintln!("100000-message input admission: {admission_elapsed:?}");
}

#[tokio::test(flavor = "current_thread")]
async fn long_session_busy_preserves_structured_input_and_fifo_original_ticket() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("long-fifo.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    seed_large_session(&state, 100_000);
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_content(vec![
        ContentBlock::Text {
            text: "original text".into(),
        },
        ContentBlock::Image {
            source: ImageSource::base64("image/png", "aW1hZ2U="),
        },
    ]);
    let holder_state = state.clone();
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _inner = holder_state.write_inner();
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let returned = match state.try_begin_user_input(&owner, message.clone()) {
        UserInputStart::Busy(returned) => returned,
        _ => panic!("busy input must remain unmodified"),
    };
    assert_eq!(returned, message);
    assert!(rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    holder.join().unwrap();

    state.add_message(Message::assistant_text("queued first"));
    let pending = accepted(state.try_begin_user_input(&owner, returned));
    let uuid = pending.uuid().to_owned();
    let first = rx.try_recv().unwrap();
    let second = rx.try_recv().unwrap();
    assert!(matches!(&first.command, HistoryFlusherCommand::Entry(_)));
    assert!(matches!(
        &second.command,
        HistoryFlusherCommand::EntryWithCommit { .. }
    ));
    process_history_flusher_command(&path, &queue, first);
    process_history_flusher_command(&path, &queue, second);
    assert_eq!(pending.wait().await.unwrap(), UserInputCommit::Durable);
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].message, Message::assistant_text("queued first"));
    assert_eq!(entries[1].uuid.as_deref(), Some(uuid.as_str()));
    assert_eq!(entries[1].message, message);
}

#[test]
fn over_budget_input_returns_original_without_changing_state_or_creating_history() {
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());
    seed_large_session(&state, MAX_OBSERVED_MESSAGES);
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_text("must remain available");
    match state.try_begin_user_input(&owner, message.clone()) {
        UserInputStart::Rejected {
            message: returned,
            error,
            reason,
            ..
        } => {
            assert_eq!(returned, message);
            assert_eq!(reason, UserInputRejection::HistoryTooLarge);
            assert!(error.contains("observation exceeds its budget"));
        }
        _ => panic!("over-budget input must be rejected before mutation"),
    }
    assert_eq!(state.read_inner().messages.len(), MAX_OBSERVED_MESSAGES);
    assert!(std::fs::read_dir(temp.path()).unwrap().next().is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn identified_input_uses_claim_uuid_and_returns_owner_bound_durable_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("identified.jsonl");
    let state = AppState::new(temp.path());
    state.with_history_path(&path);
    let owner = state.inspection_lifecycle_identity();
    let uuid = identified_uuid();
    let message = Message::user_text("async answer");

    let pending = accepted_identified(&state, &owner, message.clone(), &uuid);
    assert_eq!(pending.uuid(), uuid);
    let committed = pending.wait_with_witness().await.unwrap();
    assert_eq!(committed.outcome(), UserInputCommit::Durable);
    assert_eq!(committed.uuid(), uuid);
    assert!(
        committed
            .try_is_current_for(&state, &owner, &uuid, &message)
            .unwrap()
    );

    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
    assert_eq!(entries[0].message, message);

    let found = state
        .find_committed_user_input_identified(&owner, &uuid, &message)
        .await
        .unwrap()
        .expect("the committed identified input must be recoverable");
    assert!(
        found
            .try_is_current_for(&state, &owner, &uuid, &message)
            .unwrap()
    );
    assert!(matches!(
        state.try_begin_user_input_identified(&owner, message.clone(), &uuid),
        UserInputStart::Rejected {
            reason: UserInputRejection::IdentityConflict,
            ..
        }
    ));
    assert_eq!(load_history(&path).unwrap().len(), 1);

    let foreign = AppState::new(temp.path().join("foreign"));
    let foreign_owner = foreign.inspection_lifecycle_identity();
    assert!(
        !found
            .try_is_current_for(&foreign, &foreign_owner, &uuid, &message)
            .unwrap()
    );
    assert!(matches!(
        foreign
            .find_committed_user_input_identified(&foreign_owner, &uuid, &message)
            .await,
        Ok(None) | Err(_)
    ));
}

#[test]
fn identified_input_rejects_unstable_uuid_without_mutating_state() {
    let temp = tempfile::tempdir().unwrap();
    let state = AppState::new(temp.path());
    let owner = state.inspection_lifecycle_identity();
    let message = Message::user_text("answer");
    let outcome = state.try_begin_user_input_identified(
        &owner,
        message.clone(),
        &uuid::Uuid::new_v4().to_string(),
    );
    assert!(matches!(
        outcome,
        UserInputStart::Rejected {
            reason: UserInputRejection::IdentityConflict,
            ..
        }
    ));
    assert!(state.messages().is_empty());
    assert!(std::fs::read_dir(temp.path()).unwrap().next().is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn identified_receipt_survives_state_reload_and_wrong_body_is_a_conflict() {
    let temp = tempfile::tempdir().unwrap();
    let first = AppState::new(temp.path());
    let path = temp.path().join(format!("{}.jsonl", first.session_id()));
    first.with_history_path(&path);
    let first_owner = first.inspection_lifecycle_identity();
    let uuid = identified_uuid();
    let message = Message::user_text("answer after restart");
    let pending = accepted_identified(&first, &first_owner, message.clone(), &uuid);
    assert_eq!(pending.wait().await.unwrap(), UserInputCommit::Durable);
    drop(first);

    let restored = AppState::new(temp.path());
    restored.resume_from_history(&path).unwrap();
    let owner = restored.inspection_lifecycle_identity();
    let receipt = restored
        .find_committed_user_input_identified(&owner, &uuid, &message)
        .await
        .unwrap()
        .expect("restored history must reconcile the stable UUID");
    assert!(
        receipt
            .try_is_current_for(&restored, &owner, &uuid, &message)
            .unwrap()
    );
    assert!(
        restored
            .find_committed_user_input_identified(
                &owner,
                &uuid,
                &Message::user_text("different answer"),
            )
            .await
            .is_err()
    );
    assert_eq!(load_history(&path).unwrap().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn identified_unknown_ticket_is_observed_without_a_second_writer_command() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("identified-unknown.jsonl");
    std::fs::write(&path, b"{").unwrap();
    let (state, mut rx, queue) = controlled(&path);
    let owner = state.inspection_lifecycle_identity();
    let uuid = identified_uuid();
    let message = Message::user_text("preserve this answer");
    let pending = accepted_identified(&state, &owner, message.clone(), &uuid);
    drop(pending);

    let finder_state = state.clone();
    let finder_owner = owner.clone();
    let finder_message = message.clone();
    let finder_uuid = uuid.clone();
    let finder = tokio::spawn(async move {
        finder_state
            .find_committed_user_input_identified(&finder_owner, &finder_uuid, &finder_message)
            .await
    });
    let command = rx.recv().await.expect("the original writer command");
    assert!(matches!(
        command.command,
        HistoryFlusherCommand::EntryWithIdentifiedCommit { .. }
    ));
    process_history_flusher_command(&path, &queue, command);
    assert!(finder.await.unwrap().is_err());
    assert!(
        rx.try_recv().is_err(),
        "reconciliation must not enqueue again"
    );
    assert_eq!(state.messages(), vec![message]);
    assert_eq!(std::fs::read(&path).unwrap(), b"{");
}

#[test]
fn identified_history_append_is_atomic_and_rejects_uuid_body_conflicts() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("atomic-identified.jsonl");
    let source = HistorySource::bind(&path).unwrap();
    let uuid = identified_uuid();
    let entry = crate::HistoryEntry {
        web_sources: Vec::new(),
        history_attempt: None,
        session_id: "session".into(),
        timestamp_ms: 1,
        uuid: Some(uuid),
        parent_uuid: None,
        message: Message::user_text("answer"),
    };
    assert_eq!(
        source.append_identified_or_verify(&entry).unwrap(),
        crate::history_store::IdentifiedAppendOutcome::Appended
    );
    assert_eq!(
        source.append_identified_or_verify(&entry).unwrap(),
        crate::history_store::IdentifiedAppendOutcome::AlreadyPresent
    );
    let independently_bound = HistorySource::bind(&path).unwrap();
    assert_eq!(
        independently_bound
            .append_identified_or_verify(&entry)
            .unwrap(),
        crate::history_store::IdentifiedAppendOutcome::AlreadyPresent
    );
    let mut conflicting = entry.clone();
    conflicting.message = Message::user_text("different answer");
    assert!(source.append_identified_or_verify(&conflicting).is_err());
    assert_eq!(load_history(&path).unwrap().len(), 1);
    assert_eq!(load_history(&path).unwrap()[0].message, entry.message);
}

/// A settled input must not keep its State alive through the process owner
/// ring: a disposed thread's State (and an ephemeral thread's private
/// storage) would otherwise live until that ring slot happened to be reused.
#[tokio::test(flavor = "current_thread")]
async fn settled_input_releases_its_state_once_every_holder_drops() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let state = AppState::new(temp.path());
    state.with_history_path(temp.path().join("released.jsonl"));
    let identity = state.inspection_identity();
    let owner = state.inspection_lifecycle_identity();
    let committed = accepted(state.try_begin_user_input(&owner, Message::user_text("once")))
        .wait_with_witness()
        .await?;
    assert_eq!(committed.outcome(), UserInputCommit::Durable);
    drop(committed);
    drop(owner);
    drop(state);
    assert!(!identity.is_alive(), "the owner ring kept a released State");
    Ok(())
}
