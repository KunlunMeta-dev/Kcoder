use kcoder_engine::context::ContextManager;
use kcoder_types::Message;

#[test]
fn context_selection_preserves_the_recent_conversation_tail() {
    let messages = (0..10)
        .map(|index| Message::user_text(format!("第 {index} 条消息")))
        .collect::<Vec<_>>();

    let (to_compact, retained) = ContextManager::select_messages_to_compact(&messages);
    assert_eq!(to_compact.len() + retained.len(), messages.len());
    assert_eq!(to_compact.len(), 2);
    assert_eq!(retained.len(), 8);
    assert_eq!(retained.last(), messages.last());
    assert!(ContextManager::estimate_tokens(&messages) > 0);
}

#[test]
fn context_budget_check_is_monotonic_for_the_same_messages() {
    let messages = vec![Message::user_text("需要估算上下文预算的消息")];
    let estimate = ContextManager::estimate_tokens(&messages);

    assert!(ContextManager::needs_compaction(
        &messages,
        estimate.saturating_sub(1)
    ));
    assert!(!ContextManager::needs_compaction(&messages, estimate));
    assert!(!ContextManager::needs_compaction(&messages, estimate + 1));
}
