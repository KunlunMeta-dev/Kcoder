use crate::history_flusher::{
    HistoryFlusher, HistoryFlusherQueue, process_history_flusher_command,
};
use crate::*;

fn direct_fixture() -> (tempfile::TempDir, AppState, PathBuf, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("rewind-transaction.jsonl");
    let cached = root.path().join("read.rs");
    fs::write(&cached, "cached body").unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(&path);
    assert!(state.read_inner().history_flusher.is_none());
    state.add_message(Message::user_text("keep this prompt"));
    let mut tool_use = Message::assistant_text("");
    if let Message::Assistant { content, .. } = &mut tool_use {
        *content = vec![ContentBlock::ToolUse {
            id: "old-read".into(),
            name: "Read".into(),
            input: serde_json::json!({"path": cached}),
        }];
    }
    state.add_message(tool_use);
    state.add_message(Message::user_content(vec![ContentBlock::ToolResult {
        tool_use_id: "old-read".into(),
        content: vec![ContentBlock::Text {
            text: "cached body".into(),
        }],
        is_error: None,
    }]));
    state.record_read_tool_snapshot(
        &cached,
        Some("cached body".into()),
        Some(fs::metadata(&cached).unwrap().modified().unwrap()),
        None,
        None,
    );
    state.record_read_tool_call_key("old-read", &cached, None, None);
    state
        .set_model_selection(
            kcoder_types::ModelSelectionMode::Explicit,
            Some("fixture::model".into()),
        )
        .unwrap();
    state.save_history().unwrap();
    (root, state, path, cached)
}

struct Before {
    snapshot: serde_json::Value,
    ids: Vec<Option<String>>,
    head: Option<String>,
    revision: MessageRevision,
    timestamps: (u64, u64),
}

impl Before {
    fn capture(state: &AppState) -> Self {
        let snapshot = serde_json::to_value(state.snapshot()).unwrap();
        let inner = state.read_inner();
        Self {
            snapshot,
            ids: inner.message_history_ids.clone(),
            head: inner.last_history_uuid.clone(),
            revision: inner.message_revision.clone(),
            timestamps: (inner.session_created_at_ms, inner.session_updated_at_ms),
        }
    }

    fn assert_unchanged(&self, state: &AppState, cached: &Path) {
        assert_eq!(
            serde_json::to_value(state.snapshot()).unwrap(),
            self.snapshot
        );
        let inner = state.read_inner();
        assert_eq!(inner.message_history_ids, self.ids);
        assert_eq!(inner.last_history_uuid, self.head);
        assert_eq!(inner.message_revision, self.revision);
        assert_eq!(
            (inner.session_created_at_ms, inner.session_updated_at_ms),
            self.timestamps
        );
        assert_eq!(inner.read_tool_call_keys.len(), 1);
        drop(inner);
        assert_eq!(
            state.file_read_snapshot(cached).unwrap().content.as_deref(),
            Some("cached body")
        );
        assert!(state.full_file_read_snapshot(cached).is_some());
    }
}

fn block_history_leaf(path: &Path) {
    fs::rename(path, path.with_extension("preserved.jsonl")).unwrap();
    fs::create_dir(path).unwrap();
}

fn controlled_flusher(
    state: &AppState,
) -> (
    Arc<HistoryFlusherQueue>,
    mpsc::UnboundedReceiver<crate::history_flusher::QueuedHistoryCommand>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let source = state.read_inner().history_source.clone().unwrap();
    let flusher = HistoryFlusher::new(tx, source);
    let queue = Arc::clone(&flusher.queue);
    state.write_inner().history_flusher = Some(flusher);
    (queue, rx)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn rewind_transaction_direct_failure_preserves_context_ids_cache_and_owner() {
    let (_root, state, path, cached) = direct_fixture();
    let before = Before::capture(&state);
    let bytes = fs::read(&path).unwrap();
    block_history_leaf(&path);
    assert!(
        runtime()
            .block_on(state.truncate_messages_for_rewind(1, 1))
            .is_err()
    );
    before.assert_unchanged(&state, &cached);
    assert_eq!(
        fs::read(path.with_extension("preserved.jsonl")).unwrap(),
        bytes
    );
}

#[test]
fn rewind_transaction_flusher_failure_preserves_context_ids_cache_and_owner() {
    let (_root, state, path, cached) = direct_fixture();
    let before = Before::capture(&state);
    let (queue, mut receiver) = controlled_flusher(&state);
    runtime().block_on(async {
        let task_state = state.clone();
        let task = tokio::spawn(async move { task_state.truncate_messages_for_rewind(1, 1).await });
        let command = receiver.recv().await.unwrap();
        block_history_leaf(&path);
        process_history_flusher_command(&path, &queue, command);
        assert!(task.await.unwrap().is_err());
    });
    before.assert_unchanged(&state, &cached);
}

fn assert_replayed(path: &Path, state: &AppState) {
    let restored = AppState::new(path.parent().unwrap());
    restored.resume_from_history(path).unwrap();
    assert_eq!(restored.messages(), state.messages());
    assert_eq!(restored.selected_model(), state.selected_model());
}

#[test]
fn rewind_transaction_keeps_concurrent_append_and_replay_tail_parent() {
    let (_root, state, path, cached) = direct_fixture();
    let before = Before::capture(&state);
    let (queue, mut receiver) = controlled_flusher(&state);
    runtime().block_on(async {
        let task_state = state.clone();
        let task = tokio::spawn(async move { task_state.truncate_messages_for_rewind(1, 1).await });
        let rewind = receiver.recv().await.unwrap();
        before.assert_unchanged(&state, &cached);
        state.add_message(Message::user_text("added while waiting"));
        state.add_message(Message::assistant_text("new assistant tail"));
        let ids = state.read_inner().message_history_ids.clone();
        let assistant_time = state.snapshot().last_assistant_message_timestamp_ms;
        process_history_flusher_command(&path, &queue, rewind);
        assert_eq!(task.await.unwrap().unwrap().removed, 2);
        while let Ok(command) = receiver.try_recv() {
            process_history_flusher_command(&path, &queue, command);
        }
        queue.flush(&path).unwrap();
        assert_eq!(
            state.messages(),
            vec![
                Message::user_text("keep this prompt"),
                Message::user_text("added while waiting"),
                Message::assistant_text("new assistant tail")
            ]
        );
        assert_eq!(
            state.read_inner().message_history_ids,
            vec![ids[0].clone(), ids[3].clone(), ids[4].clone()]
        );
        assert_eq!(
            state.snapshot().last_assistant_message_timestamp_ms,
            assistant_time
        );
        let records: Vec<serde_json::Value> = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let boundary = records
            .iter()
            .find(|record| record["subtype"] == "rewind_boundary")
            .unwrap();
        let tail = records
            .iter()
            .find(|record| record["uuid"].as_str() == ids[3].as_deref())
            .unwrap();
        assert_eq!(tail["parentUuid"], boundary["uuid"]);
        assert_replayed(&path, &state);
    });
}

#[test]
fn rewind_transaction_reply_cancellation_still_finalizes_accepted_command() {
    let (_root, state, path, cached) = direct_fixture();
    let before = Before::capture(&state);
    let (queue, mut receiver) = controlled_flusher(&state);
    runtime().block_on(async {
        let task_state = state.clone();
        let task = tokio::spawn(async move { task_state.truncate_messages_for_rewind(1, 1).await });
        let command = receiver.recv().await.unwrap();
        before.assert_unchanged(&state, &cached);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        process_history_flusher_command(&path, &queue, command);
        assert_eq!(
            state.messages(),
            vec![Message::user_text("keep this prompt")]
        );
        assert!(state.file_read_snapshot(&cached).is_none());
        assert_replayed(&path, &state);
    });
}

#[test]
fn rewind_transaction_snapshot_epoch_rejects_stale_command_without_loss() {
    let (_root, state, path, cached) = direct_fixture();
    let (queue, mut receiver) = controlled_flusher(&state);
    runtime().block_on(async {
        let task_state = state.clone();
        let task = tokio::spawn(async move { task_state.truncate_messages_for_rewind(1, 1).await });
        let command = receiver.recv().await.unwrap();
        state.add_message(Message::user_text("snapshot owns this append"));
        state.save_history().unwrap();
        let before = Before::capture(&state);
        process_history_flusher_command(&path, &queue, command);
        assert!(
            task.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("snapshot replaced")
        );
        while let Ok(command) = receiver.try_recv() {
            process_history_flusher_command(&path, &queue, command);
        }
        queue.flush(&path).unwrap();
        before.assert_unchanged(&state, &cached);
        assert_replayed(&path, &state);
    });
}

#[test]
fn rewind_transaction_concurrent_rewind_conflicts_without_dropping_new_append() {
    let (_root, state, path, _cached) = direct_fixture();
    let (queue, mut receiver) = controlled_flusher(&state);
    runtime().block_on(async {
        let first_state = state.clone();
        let first =
            tokio::spawn(async move { first_state.truncate_messages_for_rewind(1, 1).await });
        let first_command = receiver.recv().await.unwrap();
        let second_state = state.clone();
        let second =
            tokio::spawn(async move { second_state.truncate_messages_for_rewind(0, 2).await });
        let second_command = receiver.recv().await.unwrap();
        state.add_message(Message::user_text("must survive both replies"));
        process_history_flusher_command(&path, &queue, first_command);
        process_history_flusher_command(&path, &queue, second_command);
        assert!(first.await.unwrap().is_ok());
        assert!(
            second
                .await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("beyond append")
        );
        while let Ok(command) = receiver.try_recv() {
            process_history_flusher_command(&path, &queue, command);
        }
        queue.flush(&path).unwrap();
        assert_eq!(
            state.messages(),
            vec![
                Message::user_text("keep this prompt"),
                Message::user_text("must survive both replies")
            ]
        );
        assert_replayed(&path, &state);
    });
}

#[test]
fn rewind_transaction_sidecar_failure_after_boundary_is_explicitly_faulted() {
    let (_root, state, path, cached) = direct_fixture();
    let blocked = state.session_state_path().unwrap();
    let guard = crate::session_persistence::install_atomic_replace_failpoint(blocked);
    let error = runtime()
        .block_on(state.truncate_messages_for_rewind(1, 1))
        .unwrap_err();
    assert!(crate::history_store::is_uncertain_mutation(&error));
    assert!(error.to_string().contains("boundary committed"));
    assert!(state.read_inner().history_write_fault.is_some());
    assert_eq!(
        state.messages(),
        vec![Message::user_text("keep this prompt")]
    );
    assert!(state.file_read_snapshot(&cached).is_none());
    assert!(
        state
            .add_message_with_uuid(Message::user_text("must be refused"), "new-after-fault")
            .is_err()
    );
    drop(guard);
    assert_replayed(&path, &state);
}

#[test]
fn rewind_transaction_noop_and_owner_replacement_keep_their_context() {
    let (_root, state, path, cached) = direct_fixture();
    let before = Before::capture(&state);
    runtime().block_on(async {
        let outcome = state
            .truncate_messages_for_rewind(state.message_count(), 1)
            .await
            .unwrap();
        assert_eq!(outcome.removed, 0);
        before.assert_unchanged(&state, &cached);
    });
    let original_bytes = fs::read(&path).unwrap();
    let (queue, mut receiver) = controlled_flusher(&state);
    runtime().block_on(async {
        let task_state = state.clone();
        let task = tokio::spawn(async move { task_state.truncate_messages_for_rewind(1, 1).await });
        let command = receiver.recv().await.unwrap();
        state.start_new_session().unwrap();
        state.add_message(Message::user_text("belongs to the new owner"));
        let new_owner = state.session_id();
        process_history_flusher_command(&path, &queue, command);
        assert!(
            task.await
                .unwrap()
                .unwrap_err()
                .to_string()
                .contains("owner changed")
        );
        assert_eq!(state.session_id(), new_owner);
        assert_eq!(
            state.messages(),
            vec![Message::user_text("belongs to the new owner")]
        );
        state.flush_history().await.unwrap();
        assert_eq!(fs::read(&path).unwrap(), original_bytes);
    });
}
