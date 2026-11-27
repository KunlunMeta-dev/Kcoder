use super::*;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

fn controlled(
    path: &Path,
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

#[test]
fn unstarted_supervisor_without_commands_does_not_claim_a_write_is_unknown() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("unstarted.jsonl");
    let (state, rx, queue) = controlled(&path);
    let future = history_flusher_task(path.clone(), rx, Arc::clone(&queue));
    drop(future);
    assert!(queue.worker_is_stopped());
    assert!(!queue.worker_is_unknown());
    assert!(!queue.ever_submitted.load(Ordering::Acquire));
    assert!(!path.exists());
    drop(state);
}

#[tokio::test(flavor = "current_thread")]
async fn legacy_append_after_startup_failure_stays_faulted_until_explicit_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("startup-failure.jsonl");
    let (state, rx, queue) = controlled(&path);
    drop(rx);
    queue.worker_stopped.store(true, Ordering::Release);
    queue.start_failure.store(2, Ordering::Release);
    state.add_message(Message::user_text("retain the original"));
    assert_eq!(
        state.messages(),
        vec![Message::user_text("retain the original")]
    );
    assert!(state.read_inner().history_write_fault.is_some());
    assert!(state.flush_history().await.is_err());
    assert!(!path.exists());
    state.save_history().unwrap();
    state.flush_history().await.unwrap();
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].message,
        Message::user_text("retain the original")
    );
}

fn hold_batch(
    queue: Arc<HistoryFlusherQueue>,
) -> (
    std_mpsc::Sender<()>,
    std::thread::JoinHandle<()>,
    Arc<AtomicBool>,
) {
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let held = Arc::new(AtomicBool::new(false));
    let thread_held = Arc::clone(&held);
    let thread = std::thread::spawn(move || {
        let _batch = queue.lock_batch();
        thread_held.store(true, Ordering::Release);
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
        thread_held.store(false, Ordering::Release);
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    (release_tx, thread, held)
}

async fn wait_for_writer(queue: &HistoryFlusherQueue) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while queue.jobs_started.load(Ordering::Acquire) == 0 {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("history worker never started");
}

#[tokio::test(flavor = "current_thread")]
async fn command_wait_does_not_block_runtime_or_worker_abort() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("abort.jsonl");
    let (state, rx, queue) = controlled(&path);
    state.add_message(Message::user_text("one original input"));
    let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
    let (release, holder, held) = hold_batch(Arc::clone(&queue));
    let task = tokio::spawn(history_flusher_task(path.clone(), rx, Arc::clone(&queue)));
    wait_for_writer(&queue).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(held.load(Ordering::Acquire), "command blocked the runtime");
    task.abort();
    assert!(
        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(250), state.flush_history())
            .await
            .unwrap()
            .is_err()
    );
    release.send(()).unwrap();
    holder.join().unwrap();
    state.save_history().unwrap();
    state.flush_history().await.unwrap();
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn cancelled_flush_wait_preserves_one_owned_write() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let path = first.path().join("first.jsonl");
    let other_path = second.path().join("other.jsonl");
    let (state, rx, queue) = controlled(&path);
    state.add_message(Message::user_text("first input"));
    let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
    let (release, holder, held) = hold_batch(Arc::clone(&queue));
    let task = tokio::spawn(history_flusher_task(path.clone(), rx, Arc::clone(&queue)));
    wait_for_writer(&queue).await;
    let waiting_state = state.clone();
    let waiting = tokio::spawn(async move { waiting_state.flush_history().await });
    tokio::task::yield_now().await;
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());

    let other = AppState::new(second.path());
    other.with_history_path(&other_path);
    other.add_message(Message::user_text("other input"));
    tokio::time::timeout(Duration::from_secs(2), other.flush_history())
        .await
        .unwrap()
        .unwrap();
    assert!(
        held.load(Ordering::Acquire),
        "other session waited for the stalled writer"
    );
    release.send(()).unwrap();
    holder.join().unwrap();
    state.flush_history().await.unwrap();
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
    drop(state);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn native_history_lock_does_not_stop_timer_flush_or_other_session() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let path = first.path().join("locked.jsonl");
    let other_path = second.path().join("other.jsonl");
    let (state, rx, queue) = controlled(&path);
    queue.source.materialize().unwrap();
    let lock_path = first.path().join(".kcoder-history.lock");
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let held = Arc::new(AtomicBool::new(false));
    let thread_held = Arc::clone(&held);
    let holder = std::thread::spawn(move || {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        FileExt::lock_exclusive(&file).unwrap();
        thread_held.store(true, Ordering::Release);
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
        FileExt::unlock(&file).unwrap();
        thread_held.store(false, Ordering::Release);
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    state.add_message(Message::user_text("locked input"));
    let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
    let task = tokio::spawn(history_flusher_task(path.clone(), rx, Arc::clone(&queue)));
    let flush_state = state.clone();
    let flush = tokio::spawn(async move { flush_state.flush_history().await });
    wait_for_writer(&queue).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match queue.batch.try_lock() {
                Err(std::sync::TryLockError::WouldBlock) => break,
                Ok(batch) => drop(batch),
                Err(error) => panic!("unexpected poisoned batch: {error}"),
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("writer did not reach the native lock");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        held.load(Ordering::Acquire),
        "flush blocked the current-thread runtime"
    );
    assert!(!flush.is_finished());

    let other = AppState::new(second.path());
    other.with_history_path(&other_path);
    other.add_message(Message::user_text("unblocked"));
    tokio::time::timeout(Duration::from_secs(2), other.flush_history())
        .await
        .unwrap()
        .unwrap();
    assert!(
        held.load(Ordering::Acquire),
        "other session waited for the native lock"
    );
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    flush.await.unwrap().unwrap();
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
    drop(state);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn direct_source_check_does_not_block_the_runtime_on_a_native_lock() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("direct.jsonl");
    let state = AppState::new(temp.path());
    let source = HistorySource::bind(&path).unwrap();
    source.materialize().unwrap();
    {
        let mut inner = state.write_inner();
        inner.history_path = Some(path);
        inner.history_source = Some(source);
    }
    let lock_path = temp.path().join(".kcoder-history.lock");
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let held = Arc::new(AtomicBool::new(false));
    let thread_held = Arc::clone(&held);
    let holder = std::thread::spawn(move || {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        FileExt::lock_exclusive(&file).unwrap();
        thread_held.store(true, Ordering::Release);
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
        FileExt::unlock(&file).unwrap();
        thread_held.store(false, Ordering::Release);
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let flush_state = state.clone();
    let flush = tokio::spawn(async move { flush_state.flush_history().await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        held.load(Ordering::Acquire),
        "source check blocked the runtime"
    );
    assert!(!flush.is_finished());
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    flush.await.unwrap().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn queued_commands_keep_fifo_and_original_parent_chain() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("fifo.jsonl");
    let (state, rx, queue) = controlled(&path);
    state.add_message(Message::runtime_text("startup"));
    state.add_message(Message::user_text("first"));
    state.add_message(Message::assistant_text("response"));
    state.add_message(Message::user_text("second"));
    let task = tokio::spawn(history_flusher_task(path.clone(), rx, queue));
    state.flush_history().await.unwrap();
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 4);
    for pair in entries.windows(2) {
        assert_eq!(pair[1].parent_uuid, pair[0].uuid);
    }
    drop(state);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_snapshot_fences_stopped_writer_in_flight() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("snapshot-race.jsonl");
    let (state, rx, queue) = controlled(&path);
    state.add_message(Message::user_text("original"));
    let uuid = state.read_inner().message_history_ids[0].clone().unwrap();
    let (release, holder, _) = hold_batch(Arc::clone(&queue));
    let task = tokio::spawn(history_flusher_task(path.clone(), rx, Arc::clone(&queue)));
    wait_for_writer(&queue).await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());

    let snapshot_state = state.clone();
    let runtime = tokio::runtime::Handle::current();
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (done_tx, done_rx) = oneshot::channel();
    let snapshot = std::thread::spawn(move || {
        let _runtime = runtime.enter();
        ready_tx.send(()).unwrap();
        let _ = done_tx.send(snapshot_state.save_history());
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    release.send(()).unwrap();
    holder.join().unwrap();
    tokio::time::timeout(Duration::from_secs(2), done_rx)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    snapshot.join().unwrap();
    state.flush_history().await.unwrap();
    let entries = load_history(&path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(uuid.as_str()));
}

#[tokio::test(flavor = "current_thread")]
async fn flush_without_original_lifecycle_returns_busy_without_blocking() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("flush-busy.jsonl");
    let (state, _rx, _queue) = controlled(&path);
    let holder_state = state.clone();
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _inner = holder_state.write_inner();
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let error = tokio::time::timeout(Duration::from_millis(250), state.flush_history())
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("original session is unknown"));
    release_tx.send(()).unwrap();
    holder.join().unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn flush_rechecks_original_receipt_after_transient_contention() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("flush-recheck.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let flushing_state = state.clone();
    let flush = tokio::spawn(async move { flushing_state.flush_history().await });
    tokio::task::yield_now().await;
    let command = rx.try_recv().unwrap();
    process_history_flusher_command(&path, &queue, command);
    let holder_state = state.clone();
    let (ready_tx, ready_rx) = std_mpsc::sync_channel(1);
    let (release_tx, release_rx) = std_mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _inner = holder_state.write_inner();
        ready_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(4));
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!flush.is_finished());
    assert!(rx.try_recv().is_err());
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    flush.await.unwrap().unwrap();
    assert!(rx.try_recv().is_err());
}

#[tokio::test(flavor = "current_thread")]
async fn flush_rejects_old_epoch_after_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("flush-snapshot.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let flushing_state = state.clone();
    let flush = tokio::spawn(async move { flushing_state.flush_history().await });
    tokio::task::yield_now().await;
    let command = rx.try_recv().expect("flush must be queued");
    state.save_history().unwrap();
    process_history_flusher_command(&path, &queue, command);
    assert!(
        flush
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("superseded")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn superseded_compaction_is_not_acknowledged_or_replayed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("old-compaction.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let compacting_state = state.clone();
    let compaction = tokio::spawn(async move {
        compacting_state
            .set_messages_after_compaction(
                vec![Message::user_text("summary")],
                CompactionTranscriptEvent {
                    trigger: CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 10,
                    summary: "summary".into(),
                },
            )
            .await
    });
    tokio::task::yield_now().await;
    let command = rx.try_recv().expect("compaction must be queued");
    assert!(matches!(
        &command.command,
        HistoryFlusherCommand::AppendCompaction { .. }
    ));
    state.save_history().unwrap();
    let original = std::fs::read(&path).unwrap();
    process_history_flusher_command(&path, &queue, command);
    assert!(
        compaction
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("superseded")
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
}

#[tokio::test(flavor = "current_thread")]
async fn flush_rejects_replaced_lifecycle_after_its_original_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("flush-owner.jsonl");
    let (state, mut rx, queue) = controlled(&path);
    let flushing_state = state.clone();
    let flush = tokio::spawn(async move { flushing_state.flush_history().await });
    tokio::task::yield_now().await;
    let command = rx.try_recv().unwrap();
    process_history_flusher_command(&path, &queue, command);
    state.write_inner().session_id = "different-session".into();
    assert!(
        flush
            .await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("lifecycle changed")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn panicking_owned_job_marks_unknown_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("panic.jsonl");
    let queue = Arc::new(HistoryFlusherQueue::new(
        HistorySource::bind(&path).unwrap(),
    ));
    assert!(
        worker_pool::run(Arc::clone(&queue), || panic!("controlled writer panic"))
            .await
            .is_err()
    );
    assert!(queue.write_fault().is_some());
    assert!(queue.flush(&path).is_err());
    assert!(!path.exists());
}
