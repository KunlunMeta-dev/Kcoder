use std::sync::Arc;

/// Process-local identity of a model-message snapshot; never persisted as history identity.
#[derive(Clone, Default, Debug)]
pub struct MessageRevision(Arc<()>);

impl PartialEq for MessageRevision {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for MessageRevision {}
impl std::hash::Hash for MessageRevision {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        std::ptr::hash(Arc::as_ptr(&self.0), state);
    }
}

#[cfg(test)]
mod tests {
    use crate::{AppState, Task};
    use kcoder_types::Message;

    #[test]
    fn message_revision_changes_on_history_resume_and_automatic_truncation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.jsonl");
        let state = AppState::with_messages(
            root.path(),
            vec![
                Message::user_text("one"),
                Message::user_text("two"),
                Message::user_text("three"),
            ],
        );
        let before = state.message_revision();
        state.set_history_max_messages(2);
        assert_ne!(before, state.message_revision());
        assert_eq!(state.message_count(), 2);
        let saved = state.message_revision();
        state.with_history_path(&path);
        state.save_history().unwrap();
        assert_eq!(saved, state.message_revision());
        let restored = AppState::new(root.path());
        let empty = restored.message_revision();
        restored.resume_from_history(&path).unwrap();
        assert_ne!(empty, restored.message_revision());
        assert_ne!(saved, restored.message_revision());
        assert_eq!(restored.messages(), state.messages());
    }

    #[tokio::test]
    async fn message_revision_tracks_compaction_rewind_and_snapshot_import() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::with_messages(root.path(), vec![Message::user_text("first")]);
        let mut revision = state.message_revision();
        macro_rules! changed {
            () => {{
                let next = state.message_revision();
                assert_ne!(revision, next);
                revision = next;
            }};
        }
        state.add_message(Message::assistant_text("answer"));
        changed!();
        assert_eq!(state.pop_last_assistant_turn(), 1);
        changed!();
        assert_eq!(state.pop_last_assistant_turn(), 0);
        assert_eq!(revision, state.message_revision());
        state
            .set_messages_and_save_history(vec![Message::user_text("replaced")])
            .await
            .unwrap();
        changed!();
        state
            .set_messages_after_compaction(
                vec![Message::user_text("summary")],
                crate::CompactionTranscriptEvent {
                    trigger: crate::CompactionTrigger::Manual,
                    pre_tokens: 100,
                    post_tokens: 10,
                    summary: "summary".into(),
                },
            )
            .await
            .unwrap();
        changed!();
        state.add_message(Message::assistant_text("tail"));
        changed!();
        state.truncate_messages_for_rewind(1, 1).await.unwrap();
        changed!();
        let path = root.path().join("snapshot.json");
        state.export_snapshot(&path).unwrap();
        state.start_new_session().unwrap();
        changed!();
        state.import_snapshot(&path).unwrap();
        changed!();
        assert_eq!(state.messages(), vec![Message::user_text("summary")]);
        assert_eq!(revision, state.messages_with_revision().1);
    }

    #[test]
    fn message_revision_invalidates_equal_length_edits_but_not_task_metadata() {
        let root = tempfile::tempdir().unwrap();
        let state = AppState::with_messages(root.path(), vec![Message::user_text("before")]);
        let before = state.message_revision();
        let (messages, captured) = state.messages_with_revision();
        assert_eq!(before, captured);
        assert_eq!(messages, state.messages());
        state.set_messages_preserving_history_ids(vec![Message::user_text("after!")]);
        assert_ne!(before, state.message_revision());
        let current = state.message_revision();
        state.upsert_task(Task::new("metadata", "only"));
        assert_eq!(current, state.message_revision());
        assert_eq!(current, state.clone().message_revision());
        assert_ne!(
            current,
            AppState::with_messages(root.path(), state.messages()).message_revision()
        );
        state.clear_messages();
        assert_ne!(current, state.message_revision());
    }
}
