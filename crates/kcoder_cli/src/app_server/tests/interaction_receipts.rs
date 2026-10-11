// Interaction receipts (S5/R046): a reply must have one terminal answer.
//
// The transport id is the only correlation a client echoes today, so a repeated
// reply must replay the answer the client may have missed, and a reply that
// matches nothing must stay observable instead of being counted as accepted.

fn resolved_notification(request_id: u64, decision: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "approval/resolved",
        "params": {"requestId": request_id, "decision": decision}
    })
}

#[test]
fn interaction_receipts_replay_the_terminal_answer_for_a_repeated_reply() {
    let mut receipts = InteractionReceipts::default();
    let notification = resolved_notification(2_000_001, "accept");
    receipts.record(2_000_001, notification.clone());

    assert_eq!(receipts.replay(2_000_001), Some(notification));
    // Replaying twice stays idempotent and keeps counting duplicates.
    assert_eq!(
        receipts.replay(2_000_001),
        Some(resolved_notification(2_000_001, "accept"))
    );
    assert_eq!(receipts.counters(), (2, 0));

    // A request id this connection never resolved is not a duplicate.
    assert_eq!(receipts.replay(2_000_002), None);
    assert_eq!(receipts.counters(), (2, 0));
}

#[test]
fn interaction_receipts_stay_bounded_and_drop_the_oldest_resolution() {
    let mut receipts = InteractionReceipts::default();
    for request_id in 0..(INTERACTION_RECEIPT_LIMIT as u64 + 5) {
        receipts.record(request_id, resolved_notification(request_id, "accept"));
    }
    assert_eq!(receipts.len(), INTERACTION_RECEIPT_LIMIT);
    // The five oldest answers were evicted; the newest ones are still replayable.
    assert_eq!(receipts.replay(0), None);
    assert_eq!(
        receipts.replay(INTERACTION_RECEIPT_LIMIT as u64 + 4),
        Some(resolved_notification(
            INTERACTION_RECEIPT_LIMIT as u64 + 4,
            "accept"
        ))
    );
}

#[test]
fn unmatched_replies_are_observable_instead_of_silently_dropped() {
    let mut receipts = InteractionReceipts::default();
    assert_eq!(receipts.counters(), (0, 0));
    receipts.note_unmatched();
    receipts.note_unmatched();
    assert_eq!(receipts.counters(), (0, 2));
    assert!(receipts.replay(2_000_009).is_none());
}

#[tokio::test]
async fn a_resolved_approval_records_one_receipt_and_ignores_a_second_reply() {
    let (prompt, mut outbound_rx, pending, receipts) =
        test_permission_prompt_with_receipts(kcoder_config::PermissionMode::Ask);
    let context = permission_request_context("bash", json!({"command": "echo once"}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });

    let request = outbound_rx.recv().await.unwrap();
    assert_eq!(request["method"], method::APPROVAL_REQUEST);
    let request_id = request["id"].as_u64().unwrap();

    assert!(matches!(
        resolve_legacy_reply(
            &json!({"jsonrpc": "2.0", "id": request_id, "result": {"decision": "accept"}}),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
        ),
        InteractionReply::Delivered
    ));
    assert_eq!(handle.await.unwrap(), PermissionResponse::AllowOnce);
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["method"], method::APPROVAL_RESOLVED);

    let recorded = receipts.lock().unwrap().replay(request_id);
    assert_eq!(recorded, Some(resolved.clone()));

    // The same reply cannot be delivered a second time to the waiting tool.
    assert!(matches!(
        resolve_legacy_reply(
            &json!({"jsonrpc": "2.0", "id": request_id, "result": {"decision": "accept"}}),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
        ),
        InteractionReply::Unmatched
    ));
}

#[test]
fn interaction_bindings_must_echo_the_whole_identity() {
    let binding = InteractionBinding {
        interaction_id: "approval-2000000".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
    };
    assert!(ReplyBinding {
        interaction_id: Some("approval-2000000"),
        thread_id: Some("thread-1"),
        turn_id: Some("turn-1"),
    }
    .matches(&binding));
    // A missed field is not "close enough".
    assert!(!ReplyBinding {
        interaction_id: Some("approval-2000000"),
        thread_id: None,
        turn_id: Some("turn-1"),
    }
    .matches(&binding));
    // The approval id alone cannot authorize a different turn.
    assert!(!ReplyBinding {
        interaction_id: Some("approval-2000000"),
        thread_id: Some("thread-1"),
        turn_id: Some("turn-2"),
    }
    .matches(&binding));
    assert!(!ReplyBinding {
        interaction_id: Some("approval-1999999"),
        thread_id: Some("thread-1"),
        turn_id: Some("turn-1"),
    }
    .matches(&binding));
}

#[tokio::test]
async fn a_reply_that_does_not_name_its_interaction_is_rejected_and_leaves_it_pending() {
    let (prompt, mut outbound_rx, pending, receipts) =
        test_permission_prompt_with_receipts(kcoder_config::PermissionMode::Ask);
    let context = permission_request_context("bash", json!({"command": "echo once"}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });

    let request = outbound_rx.recv().await.unwrap();
    let request_id = request["id"].as_u64().unwrap();
    assert_eq!(request["params"]["approvalId"], "approval-2000000");
    assert!(
        receipts.lock().unwrap().outstanding_len() == 1,
        "the request must be registered before it is answered"
    );

    // Wrong turn: the reply names a different interaction identity.
    assert!(matches!(
        resolve_server_response(
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "decision": "accept",
                    "approvalId": "approval-2000000",
                    "threadId": "thread-1",
                    "turnId": "turn-2"
                }
            }),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
            &receipts,
            true,
        ),
        InteractionReply::Misattributed
    ));
    // Nothing was delivered and the interaction is still waiting.
    assert!(!handle.is_finished());
    assert_eq!(pending.lock().unwrap().len(), 1);
    assert!(receipts.lock().unwrap().outstanding_request(request_id).is_some());

    // The bound reply is delivered exactly once.
    assert!(matches!(
        resolve_server_response(
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "decision": "accept",
                    "approvalId": "approval-2000000",
                    "threadId": "thread-1",
                    "turnId": "turn-1"
                }
            }),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
            &receipts,
            true,
        ),
        InteractionReply::Delivered
    ));
    assert_eq!(handle.await.unwrap(), PermissionResponse::AllowOnce);
    assert_eq!(receipts.lock().unwrap().outstanding_len(), 0);
}

#[tokio::test]
async fn a_bound_connection_still_accepts_an_error_frame_without_identity() {
    let (prompt, mut outbound_rx, pending, receipts) =
        test_permission_prompt_with_receipts(kcoder_config::PermissionMode::Ask);
    let context = permission_request_context("bash", json!({"command": "echo once"}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
    let request = outbound_rx.recv().await.unwrap();
    let request_id = request["id"].as_u64().unwrap();

    // An error carries no decision: it can only fail the interaction, so it is
    // accepted without a binding instead of leaving the tool waiting forever.
    assert!(matches!(
        resolve_server_response(
            &json!({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32001, "message": "客户端审批失败"}
            }),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
            &receipts,
            true,
        ),
        InteractionReply::Delivered
    ));
    assert_eq!(handle.await.unwrap(), PermissionResponse::DenyOnce);
}
