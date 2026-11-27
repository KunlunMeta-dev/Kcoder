use kcoder_repl::ReplApp;
use kcoder_types::MessageRole;

#[test]
fn repl_public_message_boundary_preserves_user_text_that_looks_internal() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::User, "用户可见消息");
    app.push_message(
        MessageRole::User,
        "[system] All tracked background sub-agents have finished. Aggregate their results.",
    );

    // This API receives visible text, not structured origin metadata. Runtime
    // messages are filtered when structured history enters the REPL; user text
    // must never disappear merely because it resembles an internal prefix.
    assert_eq!(app.messages.len(), 2);
    assert_eq!(app.messages[0].text, "用户可见消息");
    assert!(app.messages[1].text.starts_with("[system]"));
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
