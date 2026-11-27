// A committed submission identity must survive a retry (S2/R034, S5/R045).

#[test]
fn a_committed_client_message_is_found_across_its_turns() {
    let mut committed = std::collections::HashMap::new();
    committed.insert("turn-1".to_string(), "client-1".to_string());
    committed.insert("turn-2".to_string(), "client-2".to_string());

    assert_eq!(
        committed_turn_for_client_message(&committed, "client-1").as_deref(),
        Some("turn-1")
    );
    assert_eq!(
        committed_turn_for_client_message(&committed, "client-2").as_deref(),
        Some("turn-2")
    );

    // A fresh submission identity is never treated as a repeat.
    assert_eq!(
        committed_turn_for_client_message(&committed, "client-3"),
        None
    );
    // The empty identity is not a submission identity at all.
    assert_eq!(committed_turn_for_client_message(&committed, ""), None);
    assert_eq!(
        committed_turn_for_client_message(&std::collections::HashMap::new(), "client-1"),
        None
    );
}
