use super::turn_admissions::user_item;

#[tokio::test]
async fn user_item_observes_the_committed_input_without_runtime_messages() {
    let root = kcoder_config::create_private_temp_dir("kcoder-live-input").unwrap();
    let runtime = super::thread_runtime::test_support::test_runtime(
        "live-input",
        &root.path().join("history.jsonl"),
    );
    let engine = runtime.engine();
    assert!(user_item(&engine, "turn-1", Some("original-input")).is_none());
    engine
        .state
        .add_message(kcoder_types::Message::user_text("Original user text"));
    engine
        .state
        .add_message(kcoder_types::Message::runtime_text(
            "Private runtime context",
        ));
    let item = user_item(&engine, "turn-1", Some("original-input")).unwrap();
    assert_eq!(item.kind, kcoder_app_protocol::ItemKind::UserMessage);
    let visible: kcoder_app_protocol::ThreadMessage = serde_json::from_value(item.content).unwrap();
    assert_eq!(visible.id, item.id);
    assert_eq!(visible.client_message_id.as_deref(), Some("original-input"));
    assert_eq!(visible.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(visible.role, "user");
    assert_eq!(visible.content, "Original user text");
    assert_eq!(engine.state.message_count(), 2);
    runtime.shutdown().await;
}
