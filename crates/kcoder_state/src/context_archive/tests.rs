use super::*;
use crate::{CompactionTranscriptEvent, CompactionTrigger};

async fn fixture() -> (tempfile::TempDir, AppState) {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join("session.jsonl"));
    state.add_message(Message::user_text("OLD_SECRET_FACT original evidence"));
    state.add_message(Message::Assistant {
        content: vec![
            ContentBlock::Text {
                text: "old answer".into(),
            },
            ContentBlock::Thinking {
                thinking: "PRIVATE_REASONING".into(),
                signature: "PRIVATE_SIGNATURE".into(),
            },
        ],
        usage: None,
    });
    state.add_message(Message::user_text("recent request"));
    state.add_message(Message::assistant_text("recent answer"));
    state.flush_history().await.unwrap();
    compact(&state, "first historical summary", 2).await;
    (root, state)
}

async fn compact(state: &AppState, summary: &str, keep: usize) {
    let source = state.messages();
    let mut messages = vec![Message::compaction_text(summary)];
    messages.extend_from_slice(&source[source.len() - keep..]);
    state
        .set_messages_after_compaction(
            messages,
            CompactionTranscriptEvent {
                trigger: CompactionTrigger::Auto,
                pre_tokens: 10_000,
                post_tokens: 100,
                summary: summary.into(),
            },
        )
        .await
        .unwrap();
}

fn query() -> ContextHistoryQuery {
    ContextHistoryQuery {
        limit: 10,
        ..Default::default()
    }
}

#[tokio::test]
async fn checkpoint_reference_keeps_exact_originals_after_run_end_and_rejects_replaced_history() {
    let (_parent_root, parent) = fixture().await;
    let root = tempfile::tempdir().unwrap();
    let checkpoint = root.path().join("task/transcript.json");
    let run = AppState::with_messages(root.path(), parent.messages());
    run.with_session_artifact_project_dir(root.path(), "artifact-owner");
    run.with_subagent_context_history(&checkpoint).unwrap();
    let anchor = parent
        .context_history_anchor(&parent.shared_messages_with_revision().0)
        .unwrap();
    assert!(
        run.inherit_compacted_history_from(&parent, &anchor, || false)
            .unwrap()
    );
    run.flush_history().await.unwrap();
    let messages = run.messages();
    let reference = run
        .context_history_checkpoint(&checkpoint, &run.shared_messages_with_revision().0)
        .unwrap()
        .unwrap();
    let source_path = run.history_path().unwrap();
    run.add_message(Message::user_text("FUTURE_CHECKPOINT_FACT"));
    run.flush_history().await.unwrap();
    compact(&run, "first historical summary", 1).await;
    drop(run);
    assert!(source_path.exists());

    let restored = AppState::with_messages(root.path(), messages.clone());
    restored.with_subagent_context_history(&checkpoint).unwrap();
    assert!(
        restored
            .inherit_checkpoint_context_history(&checkpoint, &reference, &messages, || false)
            .unwrap()
    );
    let block = restored.context_history(&query(), || false).unwrap().blocks[0]
        .block_id
        .clone();
    let page = restored
        .context_history(
            &ContextHistoryQuery {
                block_id: Some(block),
                full: true,
                ..query()
            },
            || false,
        )
        .unwrap();
    assert!(page.text.contains("OLD_SECRET_FACT"));
    assert!(!page.text.contains("FUTURE_CHECKPOINT_FACT"));
    let mut changed = messages.clone();
    changed.push(Message::user_text("changed receipt"));
    assert!(reference.validate_messages(&changed).is_err());
    let old = AppState::new(root.path());
    old.resume_from_history(&source_path).unwrap();
    old.save_history().unwrap();
    let failed = AppState::with_messages(root.path(), messages.clone());
    failed.with_subagent_context_history(&checkpoint).unwrap();
    assert!(
        failed
            .inherit_checkpoint_context_history(&checkpoint, &reference, &messages, || false)
            .is_err()
    );
}

#[tokio::test]
async fn inherited_archive_survives_parent_changes_child_compaction_restart_and_rewind() {
    let (parent_root, parent) = fixture().await;
    let child_root = tempfile::tempdir().unwrap();
    let snapshot = parent.shared_messages_with_revision().0;
    let anchor = parent.context_history_anchor(&snapshot).unwrap();
    let child = AppState::with_messages(child_root.path(), snapshot.to_vec());
    parent.add_message(Message::user_text("FUTURE_ONLY_FACT"));
    parent.flush_history().await.unwrap();
    compact(&parent, "first historical summary", 1).await;
    assert!(parent.context_history_anchor(&snapshot).is_none());
    let path = child_root.path().join("child.jsonl");
    child.with_history_path(&path);
    assert!(
        child
            .inherit_compacted_history_from(&parent, &anchor, || false)
            .unwrap()
    );
    let page = child.context_history(&query(), || false).unwrap();
    assert_eq!(page.blocks.len(), 1);
    assert!(page.blocks[0].complete);
    let mut projected = child.messages();
    projected[0] = Message::compaction_text("summary with child-owned attachment paths");
    child.set_messages_preserving_history_ids(projected);
    child.save_history().unwrap();
    assert!(child.context_history(&query(), || false).unwrap().blocks[0].complete);
    let read_all = |state: &AppState| {
        state
            .context_history(
                &ContextHistoryQuery {
                    block_id: Some(
                        state.context_history(&query(), || false).unwrap().blocks[0]
                            .block_id
                            .clone(),
                    ),
                    full: true,
                    ..query()
                },
                || false,
            )
            .unwrap()
    };
    let original = read_all(&child);
    assert!(original.text.contains("OLD_SECRET_FACT"));
    assert!(!original.text.contains("FUTURE_ONLY_FACT"));
    assert!(!original.text.contains("PRIVATE_REASONING"));
    assert!(
        crate::load_transcript_history(&path)
            .unwrap()
            .iter()
            .all(|entry| entry.message.origin() != MessageOrigin::Compaction)
    );
    parent.save_history().unwrap();
    drop(parent);
    drop(parent_root);
    assert_eq!(read_all(&child).text, original.text);
    assert_eq!(
        child
            .context_history(&query(), || false)
            .unwrap()
            .scanned_bytes,
        0
    );
    child.add_message(Message::user_text("CHILD_NEW_FACT"));
    child.add_message(Message::assistant_text("child result"));
    child.flush_history().await.unwrap();
    compact(&child, "child historical summary", 1).await;
    assert!(read_all(&child).text.contains("CHILD_NEW_FACT"));
    assert!(read_all(&child).text.contains("OLD_SECRET_FACT"));
    let restored = AppState::new(child_root.path());
    restored.resume_from_history(&path).unwrap();
    assert_eq!(read_all(&restored).text, read_all(&child).text);
    let latest_block = restored.context_history(&query(), || false).unwrap().blocks[0]
        .block_id
        .clone();
    restored.truncate_messages_for_rewind(0, 0).await.unwrap();
    assert!(
        restored
            .context_history(
                &ContextHistoryQuery {
                    block_id: Some(latest_block),
                    ..query()
                },
                || false
            )
            .is_err()
    );
    assert!(
        restored
            .context_history(&query(), || false)
            .unwrap()
            .blocks
            .is_empty()
    );
}

#[tokio::test]
async fn historyless_inheritance_is_owned_and_corrupt_frozen_sources_fail_closed() {
    let (_root, parent) = fixture().await;
    let child_root = tempfile::tempdir().unwrap();
    let child = AppState::with_messages(child_root.path(), parent.messages());
    assert!(
        child
            .inherit_compacted_history_from(
                &parent,
                &parent
                    .context_history_anchor(&parent.shared_messages_with_revision().0)
                    .unwrap(),
                || false
            )
            .unwrap()
    );
    let path = child.history_path().unwrap();
    assert!(path.exists());
    child.with_session_artifact_project_dir(child_root.path(), "original-artifact-owner");
    assert_eq!(
        child.session_artifact_project_dir().as_deref(),
        Some(child_root.path())
    );
    assert_eq!(child.artifact_session_id(), "original-artifact-owner");
    let record: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(&path)
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap();
    let reference: ArchiveReference = serde_json::from_value(record["archive"].clone()).unwrap();
    let directory = inheritance::archive_directory(&path, false).unwrap();
    let name = format!("{}.jsonl", reference.file);
    let bytes = std::fs::read(
        crate::session_dir_path(
            path.parent().unwrap(),
            path.file_stem().unwrap().to_str().unwrap(),
        )
        .join("context-history")
        .join(&name),
    )
    .unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(!text.contains("PRIVATE_REASONING"));
    directory
        .atomic_replace(
            std::ffi::OsStr::new(&name),
            text.replace("OLD_SECRET_FACT", "BAD_SECRET_FACT")
                .as_bytes(),
        )
        .unwrap();
    assert!(child.context_history(&query(), || false).is_err());
    assert!(child.context_history(&query(), || false).is_err());
    let lifecycle = child.inspection_lifecycle_identity();
    child.start_new_session().unwrap();
    assert!(
        child
            .context_history_for_lifecycle(&query(), &lifecycle, || false)
            .is_err()
    );
    drop(child);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while path.exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned temporary history must drain and release with its last writer");
}

#[tokio::test]
async fn current_archive_search_and_restore_keep_exact_sources_and_hide_reasoning() {
    let (_root, state) = fixture().await;
    let page = state.context_history(&query(), || false).unwrap();
    assert!(!page.indexing);
    assert_eq!(page.blocks.len(), 1);
    assert!(page.blocks[0].complete);
    assert_eq!(page.blocks[0].source_message_count, 2);
    let read = state
        .context_history(
            &ContextHistoryQuery {
                block_id: Some(page.blocks[0].block_id.clone()),
                full: true,
                snapshot: Some(page.snapshot),
                ..query()
            },
            || false,
        )
        .unwrap();
    assert!(read.text.contains("OLD_SECRET_FACT"));
    assert!(read.text.contains("old answer"));
    assert!(!read.text.contains("PRIVATE_REASONING"));
    assert!(!read.text.contains("PRIVATE_SIGNATURE"));
    let hit = state
        .context_history(
            &ContextHistoryQuery {
                query: Some("old_secret_fact".into()),
                ..query()
            },
            || false,
        )
        .unwrap();
    assert!(hit.text.contains("OLD_SECRET_FACT"));
    let path = state.history_path().unwrap();
    let before_control = committed_source_stamp(&path).unwrap();
    let warm = state.context_history(&query(), || false).unwrap();
    assert_eq!(
        warm.scanned_bytes, 0,
        "unchanged list must perform no body reads"
    );
    assert_eq!(
        committed_source_stamp(&path).unwrap(),
        before_control,
        "a warm read must not write the native history/control revision"
    );
    let before = std::fs::metadata(&path).unwrap().len();
    state.add_message(Message::user_text("new input after compression"));
    state.flush_history().await.unwrap();
    let appended = std::fs::metadata(&path).unwrap().len() - before;
    let updated = state.context_history(&query(), || false).unwrap();
    assert_eq!(
        updated.scanned_bytes, appended,
        "a native append must only index its suffix"
    );
}

#[tokio::test]
async fn nested_archive_can_restore_one_level_or_all_originals() {
    let (_root, state) = fixture().await;
    state.add_message(Message::user_text("second request"));
    state.add_message(Message::assistant_text("second response"));
    state.add_message(Message::user_text("latest request"));
    state.add_message(Message::assistant_text("latest response"));
    state.flush_history().await.unwrap();
    compact(&state, "second historical summary", 2).await;
    let page = state.context_history(&query(), || false).unwrap();
    assert_eq!(
        page.blocks.len(),
        2,
        "{}",
        std::fs::read_to_string(state.history_path().unwrap()).unwrap()
    );
    assert_eq!(
        page.blocks[0].parent_block_ids,
        [page.blocks[1].block_id.clone()]
    );
    let read = ContextHistoryQuery {
        block_id: Some(page.blocks[0].block_id.clone()),
        ..query()
    };
    let one = state.context_history(&read, || false).unwrap();
    assert!(one.text.contains("first historical summary"));
    assert!(!one.text.contains("OLD_SECRET_FACT"));
    let full = state
        .context_history(&ContextHistoryQuery { full: true, ..read }, || false)
        .unwrap();
    assert!(full.text.contains("OLD_SECRET_FACT"));
    assert!(full.text.contains("second request"));
    let restored = AppState::new(state.cwd());
    restored
        .resume_from_history(&state.history_path().unwrap())
        .unwrap();
    let restored_page = restored.context_history(&query(), || false).unwrap();
    assert_eq!(
        restored_page.blocks, page.blocks,
        "restart must recover the same ancestor references"
    );
    restored.save_history().unwrap();
    restored.add_message(Message::user_text(
        "new work after explicit snapshot replacement",
    ));
    restored.add_message(Message::assistant_text("new result"));
    restored.flush_history().await.unwrap();
    compact(
        &restored,
        "summary after the old originals were explicitly replaced",
        2,
    )
    .await;
    let replaced = restored.context_history(&query(), || false).unwrap();
    assert!(
        !replaced.blocks[0].complete,
        "an old summary cannot masquerade as available originals"
    );
    assert!(
        restored
            .context_history(
                &ContextHistoryQuery {
                    block_id: Some(replaced.blocks[0].block_id.clone()),
                    full: true,
                    ..query()
                },
                || false
            )
            .is_err()
    );
}

#[tokio::test]
async fn paged_restore_reuses_verified_message_bytes_and_keeps_the_final_characters() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join("history.jsonl"));
    state.add_message(Message::user_text(format!(
        "LONG_BEGIN {} LONG_END",
        "字".repeat(40_000)
    )));
    state.add_message(Message::assistant_text("old result"));
    state.add_message(Message::user_text("current request"));
    state.add_message(Message::assistant_text("current result"));
    state.flush_history().await.unwrap();
    compact(&state, "long source summary", 2).await;
    let list = state.context_history(&query(), || false).unwrap();
    let first_query = ContextHistoryQuery {
        block_id: Some(list.blocks[0].block_id.clone()),
        limit: 1,
        ..query()
    };
    let first = state.context_history(&first_query, || false).unwrap();
    assert!(first.text.contains("LONG_BEGIN"));
    assert_eq!(first.next_offset, Some(0));
    state.add_message(Message::user_text("follow-up request"));
    state.add_message(Message::assistant_text("follow-up result"));
    state.add_message(Message::user_text("latest request"));
    state.add_message(Message::assistant_text("latest result"));
    state.flush_history().await.unwrap();
    compact(&state, "newer summary retains the earlier block", 2).await;
    let second = state
        .context_history(
            &ContextHistoryQuery {
                offset: first.next_offset.unwrap(),
                text_offset: first.next_text_offset.unwrap(),
                snapshot: Some(first.snapshot),
                ..first_query
            },
            || false,
        )
        .unwrap();
    assert!(second.text.contains("LONG_END"));
    assert!(
        second.scanned_bytes < 5_000,
        "continuation must only index the new suffix and reuse the verified large message"
    );
}

#[tokio::test]
async fn archive_rejects_other_sessions_cancellation_and_changed_source_bytes() {
    let (root, state) = fixture().await;
    let list = state.context_history(&query(), || false).unwrap();
    let read = ContextHistoryQuery {
        block_id: Some(list.blocks[0].block_id.clone()),
        ..query()
    };
    let peer = AppState::new(root.path());
    assert!(peer.context_history(&read, || false).is_err());
    assert!(state.context_history(&read, || true).is_err());
    let path = state.history_path().unwrap();
    let bytes = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, bytes.replace("OLD_SECRET_FACT", "BAD_SECRET_FACT")).unwrap();
    assert!(state.context_history(&read, || false).is_err());
    assert!(
        state.context_history(&read, || false).is_err(),
        "retries cannot bless modified bytes"
    );
    state.clear_messages();
    assert!(state.context_history(&read, || false).is_err());
}

#[tokio::test]
async fn invalid_cold_history_is_rejected_without_mutating_the_source() {
    let (_root, state) = fixture().await;
    let path = state.history_path().unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] = b'!';
    std::fs::write(&path, &bytes).unwrap();
    assert!(state.context_history(&query(), || false).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}
