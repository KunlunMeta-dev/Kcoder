use crate::{AppState, CompactionTranscriptEvent, CompactionTrigger};
use kcoder_types::Message;

fn event() -> CompactionTranscriptEvent {
    CompactionTranscriptEvent {
        trigger: CompactionTrigger::Manual,
        pre_tokens: 100,
        post_tokens: 10,
        summary: "summary".into(),
    }
}

#[tokio::test]
async fn stale_compaction_commits_leave_messages_revision_and_transcript_unchanged() {
    for full in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let history = tmp.path().join("history.jsonl");
        let state = AppState::new(tmp.path());
        state.with_history_path(&history);
        state.add_message(Message::user_text("original"));
        let (_, expected) = state.messages_with_revision();
        state.add_message(Message::assistant_text("late background output"));
        state.flush_history().await.unwrap();
        let messages = state.messages();
        let revision = state.message_revision();
        let transcript = std::fs::read(&history).unwrap();
        let result = if full {
            state
                .set_messages_after_compaction_if_revision(
                    vec![Message::user_text("stale summary")],
                    event(),
                    &expected,
                )
                .await
        } else {
            state
                .set_messages_and_save_history_if_revision(
                    vec![Message::user_text("stale cleanup")],
                    &expected,
                )
                .await
        };
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("conversation changed")
        );
        assert_eq!(state.messages(), messages);
        assert_eq!(state.message_revision(), revision);
        assert_eq!(std::fs::read(&history).unwrap(), transcript);
        let restored = AppState::new(tmp.path());
        restored.resume_from_history(&history).unwrap();
        assert_eq!(restored.messages(), messages);
    }
}

#[tokio::test]
async fn compaction_revision_rejects_same_length_edits_and_accepts_current_snapshot() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::with_messages(tmp.path(), vec![Message::user_text("old")]);
    let (_, stale) = state.messages_with_revision();
    state.set_messages_preserving_history_ids(vec![Message::user_text("new")]);
    assert!(
        state
            .set_messages_after_compaction_if_revision(
                vec![Message::user_text("stale summary")],
                event(),
                &stale
            )
            .await
            .is_err()
    );
    let (_, current) = state.messages_with_revision();
    let compacted = vec![Message::user_text("fresh summary")];
    state
        .set_messages_after_compaction_if_revision(compacted.clone(), event(), &current)
        .await
        .unwrap();
    assert_eq!(state.messages(), compacted);
    assert_ne!(state.message_revision(), current);
    let (_, current) = state.messages_with_revision();
    state
        .set_messages_and_save_history_if_revision(compacted.clone(), &current)
        .await
        .unwrap();
    assert_eq!(state.messages(), compacted);
}
