use super::*;
use kcoder_types::Message;
use serde_json::json;

fn text(output: &ToolOutput) -> String {
    output
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>()
}

#[tokio::test]
async fn resumed_or_imported_conversation_reads_unchanged_file_content_again() {
    for replacement in ["resume", "import", "clear", "rewind"] {
        let tmp = tempfile::tempdir().unwrap();
        let original = "REAL_FILE_BODY_REQUIRED_IN_NEW_CONTEXT\n";
        std::fs::write(tmp.path().join("example.txt"), original).unwrap();
        let state = kcoder_state::AppState::new(tmp.path());
        let ctx = ToolContext::new(state.clone());
        let input = json!({"file_path":"example.txt"});
        let first = FileReadTool.call(input.clone(), &ctx).await.unwrap();
        assert!(text(&first).contains(original.trim()));
        state.add_message(Message::user_text("old context with previous read"));
        state.add_message(Message::user_content(first.content));
        assert_eq!(
            text(&FileReadTool.call(input.clone(), &ctx).await.unwrap()),
            FILE_UNCHANGED_STUB
        );

        if replacement == "clear" {
            state.clear_messages();
        } else if replacement == "rewind" {
            state.truncate_messages_for_rewind(0, 1).await.unwrap();
        } else {
            let source = kcoder_state::AppState::new(tmp.path());
            source.with_history_path(tmp.path().join("different-session.jsonl"));
            source.add_message(Message::user_text("new conversation without previous read"));
            source.save_history().unwrap();
            if replacement == "resume" {
                state
                    .resume_from_history(&source.history_path().unwrap())
                    .unwrap();
            } else {
                let snapshot = tmp.path().join("snapshot.json");
                source.export_snapshot(&snapshot).unwrap();
                state.import_snapshot(&snapshot).unwrap();
            }
        }
        assert!(
            !serde_json::to_string(&state.messages())
                .unwrap()
                .contains(original.trim())
        );
        let again = FileReadTool.call(input.clone(), &ctx).await.unwrap();
        assert!(
            text(&again).contains(original.trim()),
            "{replacement} must not reuse another conversation's read placeholder: {}",
            text(&again)
        );
        assert_eq!(
            text(&FileReadTool.call(input, &ctx).await.unwrap()),
            FILE_UNCHANGED_STUB,
            "cache within the newly read conversation still works"
        );
    }
}
