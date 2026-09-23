use kcoder_repl::ReplApp;
use kcoder_types::MessageRole;

#[test]
fn repl_public_message_boundary_hides_internal_background_aggregation_context() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "用户可见消息");
    app.push_message(
        MessageRole::User,
        "[system] All tracked background sub-agents have finished. Aggregate their results.",
    );

    assert_eq!(app.messages.len(), 1);
    assert_eq!(app.messages[0].text, "用户可见消息");
}

#[test]
fn repl_public_message_boundary_sanitizes_terminal_control_sequences() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "safe\u{1b}[31m unsafe\u{7}");

    assert_eq!(app.messages.len(), 1);
    assert!(!app.messages[0].text.contains('\u{1b}'));
    assert!(!app.messages[0].text.contains('\u{7}'));
    assert!(app.messages[0].text.contains("safe"));
}
