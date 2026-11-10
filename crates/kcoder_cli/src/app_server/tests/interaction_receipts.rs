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

fn approval_status_selector(request_id: u64, epoch: &str) -> kcoder_app_protocol::InteractionStatusReadParamsV1 {
    kcoder_app_protocol::InteractionStatusReadParamsV1 {
        server_id: "server-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        request_id,
        app_server_epoch: epoch.into(),
        kind: kcoder_app_protocol::InteractionStatusKindV1::Approval,
        approval_id: Some(format!("approval-{request_id}")),
        question_id: None,
    }
}

fn approval_binding(request_id: u64) -> InteractionBinding {
    InteractionBinding {
        interaction_id: format!("approval-{request_id}"),
        server_id: "server-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        kind: kcoder_app_protocol::InteractionStatusKindV1::Approval,
    }
}

fn bound_approval_request(request_id: u64, epoch: &str) -> Value {
    let binding = approval_binding(request_id);
    json!({
        "jsonrpc":"2.0",
        "id":request_id,
        "method":"approval/request",
        "params":{
            "serverId":binding.server_id,
            "threadId":binding.thread_id,
            "turnId":binding.turn_id,
            "approvalId":binding.interaction_id,
            "appServerEpoch":epoch
        }
    })
}

fn bound_approval_resolution(request_id: u64, epoch: &str) -> Value {
    let binding = approval_binding(request_id);
    json!({
        "jsonrpc":"2.0",
        "method":"approval/resolved",
        "params":{
            "requestId":request_id,
            "approvalId":binding.interaction_id,
            "threadId":binding.thread_id,
            "turnId":binding.turn_id,
            "appServerEpoch":epoch,
            "decision":"cancel",
            "reason":"timeout"
        }
    })
}

#[test]
fn status_read_is_pure_and_only_reports_exact_live_or_terminal_receipts() {
    use kcoder_app_protocol::InteractionStatusV1 as Status;

    let mut receipts = InteractionReceipts::new("epoch-1".into());
    let request_id = 2_000_001;
    receipts.track_request(
        request_id,
        approval_binding(request_id),
        bound_approval_request(request_id, "epoch-1"),
    );
    let selector = approval_status_selector(request_id, "epoch-1");
    assert_eq!(receipts.read_status(&selector, Some(true)), Status::Pending);
    assert_eq!(receipts.read_status(&selector, Some(false)), Status::Unknown);
    assert_eq!(receipts.counters(), (0, 0));

    let wrong_epoch = approval_status_selector(request_id, "new-app-server");
    let mut wrong_turn = selector.clone();
    wrong_turn.turn_id = "other-turn".into();
    assert_eq!(receipts.read_status(&wrong_epoch, Some(true)), Status::Unknown);
    assert_eq!(receipts.read_status(&wrong_turn, Some(true)), Status::Unknown);
    assert_eq!(receipts.counters(), (0, 0));

    receipts.record_terminal(
        request_id,
        bound_approval_resolution(request_id, "epoch-1"),
    );
    assert_eq!(receipts.read_status(&selector, None), Status::Resolved);
    assert_eq!(receipts.counters(), (0, 0));
}

#[test]
fn terminal_receipt_requires_the_exact_wire_tuple_but_keeps_replay() {
    use kcoder_app_protocol::InteractionStatusV1 as Status;

    let request_id = 2_000_003;
    let selector = approval_status_selector(request_id, "epoch-1");
    let valid = bound_approval_resolution(request_id, "epoch-1");
    let mut mismatches = Vec::new();
    let mut wrong_method = valid.clone();
    wrong_method["method"] = json!("question/resolved");
    mismatches.push(wrong_method);
    let mut wrong_request_id = valid.clone();
    wrong_request_id["params"]["requestId"] = json!(request_id + 1);
    mismatches.push(wrong_request_id);
    let mut wrong_epoch = valid.clone();
    wrong_epoch["params"]["appServerEpoch"] = json!("new-app-server");
    mismatches.push(wrong_epoch);
    let mut wrong_server = valid.clone();
    wrong_server["params"]["serverId"] = json!("other-server");
    mismatches.push(wrong_server);
    let mut wrong_thread = valid.clone();
    wrong_thread["params"]["threadId"] = json!("other-thread");
    mismatches.push(wrong_thread);
    let mut wrong_turn = valid.clone();
    wrong_turn["params"]["turnId"] = json!("other-turn");
    mismatches.push(wrong_turn);
    let mut wrong_interaction = valid.clone();
    wrong_interaction["params"]["approvalId"] = json!("different-approval");
    mismatches.push(wrong_interaction);

    for notification in mismatches {
        let mut receipts = InteractionReceipts::new("epoch-1".into());
        receipts.track_request(
            request_id,
            approval_binding(request_id),
            bound_approval_request(request_id, "epoch-1"),
        );
        receipts.record_terminal(request_id, notification.clone());

        assert_eq!(
            receipts.read_status(&selector, Some(true)),
            Status::Unknown,
            "a malformed terminal event cannot make the exact request resolved or pending"
        );
        assert_eq!(receipts.replay(request_id), Some(notification));
        assert_eq!(receipts.outstanding_len(), 0);
    }

    let mut mismatched_request = InteractionReceipts::new("epoch-1".into());
    let mut wrong_request_server = bound_approval_request(request_id, "epoch-1");
    wrong_request_server["params"]["serverId"] = json!("other-server");
    mismatched_request.track_request(
        request_id,
        approval_binding(request_id),
        wrong_request_server,
    );
    mismatched_request.record_terminal(request_id, valid.clone());
    assert_eq!(mismatched_request.read_status(&selector, Some(true)), Status::Unknown);
    assert_eq!(mismatched_request.replay(request_id), Some(valid));
}

#[test]
fn timeout_and_disconnect_terminal_receipts_resolve_while_eviction_stays_unknown() {
    use kcoder_app_protocol::InteractionStatusV1 as Status;

    let mut receipts = InteractionReceipts::new("epoch-1".into());
    let request_id = 2_000_007;
    receipts.track_request(
        request_id,
        approval_binding(request_id),
        bound_approval_request(request_id, "epoch-1"),
    );
    let selector = approval_status_selector(request_id, "epoch-1");
    receipts.record_terminal(
        request_id,
        bound_approval_resolution(request_id, "epoch-1"),
    );
    assert_eq!(receipts.read_status(&selector, None), Status::Resolved);
    assert_eq!(receipts.read_status(&approval_status_selector(99, "epoch-1"), None), Status::Unknown);

    let mut evicted = InteractionReceipts::new("epoch-1".into());
    evicted.track_request(
        request_id,
        approval_binding(request_id),
        bound_approval_request(request_id, "epoch-1"),
    );
    evicted.record_terminal(request_id, bound_approval_resolution(request_id, "epoch-1"));
    for next_id in 0..INTERACTION_RECEIPT_LIMIT as u64 {
        evicted.record(next_id, resolved_notification(next_id, "accept"));
    }
    assert_eq!(evicted.read_status(&selector, None), Status::Unknown);

    evicted.record_terminal(99, resolved_notification(99, "accept"));
    assert_eq!(evicted.read_status(&approval_status_selector(99, "epoch-1"), None), Status::Unknown);
}

#[test]
fn contended_runtime_snapshot_is_unknown_and_can_be_rechecked_read_only() {
    use kcoder_app_protocol::InteractionStatusV1 as Status;

    let (outbound_tx, _outbound_rx) = mpsc::channel(1);
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::new("epoch-1".into())));
    let allocator = Arc::new(AtomicU64::new(1_000_000));
    let state = ResidentTurnState::new(
        outbound_tx,
        kcoder_config::PermissionMode::Ask,
        allocator,
        Arc::clone(&receipts),
    );
    let mcp_app_pending = Arc::new(StdMutex::new(HashMap::new()));
    let selector = approval_status_selector(2_000_009, "epoch-1");
    let guard = state.pending_approvals.lock().unwrap();
    assert_eq!(
        state.pending_interaction_matches(&selector, &mcp_app_pending),
        None
    );
    assert_eq!(
        receipts.lock().unwrap().read_status(&selector, None),
        Status::Unknown,
    );
    drop(guard);

    assert_eq!(
        state.pending_interaction_matches(&selector, &mcp_app_pending),
        Some(false)
    );
    assert_eq!(
        receipts.lock().unwrap().read_status(
            &selector,
            state.pending_interaction_matches(&selector, &mcp_app_pending),
        ),
        Status::Unknown,
    );
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
    let request_epoch = request["params"]["appServerEpoch"].as_str().unwrap();
    assert!(!request_epoch.is_empty());

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
    assert_eq!(resolved["params"]["appServerEpoch"], request_epoch);

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
        server_id: "server-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        kind: kcoder_app_protocol::InteractionStatusKindV1::Approval,
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

#[test]
fn status_rpc_keeps_same_thread_approval_and_question_requests_independently_addressable() {
    use kcoder_app_protocol::{InteractionStatusKindV1, InteractionStatusV1};
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::new("epoch-1".into())));
    let (outbound_tx, _outbound_rx) = mpsc::channel(4);
    let state = ResidentTurnState::new(
        outbound_tx,
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(300)),
        Arc::clone(&receipts),
    );
    let mcp_app_pending = Arc::new(StdMutex::new(HashMap::new()));
    let approval_id = 301;
    let question_id = 302;
    let context = ApprovalContext {
        server_id: "server-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
    };
    *state.approval_context.lock().unwrap() = Some(context.clone());
    *state.question_context.lock().unwrap() = Some(QuestionContext {
        server_id: context.server_id.clone(),
        thread_id: context.thread_id.clone(),
        turn_id: context.turn_id.clone(),
    });
    let (approval_tx, _approval_rx) = oneshot::channel();
    state
        .pending_approvals
        .lock()
        .unwrap()
        .insert(approval_id, approval_tx);
    let (question_tx, _question_rx) = oneshot::channel();
    state
        .pending_questions
        .lock()
        .unwrap()
        .insert(question_id, question_tx);
    let approval = kcoder_app_protocol::InteractionStatusReadParamsV1 {
        server_id: context.server_id.clone(),
        thread_id: context.thread_id.clone(),
        turn_id: context.turn_id.clone(),
        request_id: approval_id,
        app_server_epoch: "epoch-1".into(),
        kind: InteractionStatusKindV1::Approval,
        approval_id: Some("approval-301".into()),
        question_id: None,
    };
    let question = kcoder_app_protocol::InteractionStatusReadParamsV1 {
        server_id: context.server_id.clone(),
        thread_id: context.thread_id.clone(),
        turn_id: context.turn_id.clone(),
        request_id: question_id,
        app_server_epoch: "epoch-1".into(),
        kind: InteractionStatusKindV1::Question,
        approval_id: None,
        question_id: Some("question-302".into()),
    };
    {
        let mut ledger = receipts.lock().unwrap();
        ledger.track_request(
            approval_id,
            InteractionBinding {
                interaction_id: approval.approval_id.clone().unwrap(),
                server_id: context.server_id.clone(),
                thread_id: context.thread_id.clone(),
                turn_id: context.turn_id.clone(),
                kind: InteractionStatusKindV1::Approval,
            },
            json!({
                "jsonrpc":"2.0", "id":approval_id, "method":"approval/request",
                "params":{"serverId":"server-1", "threadId":"thread-1", "turnId":"turn-1",
                    "approvalId":"approval-301", "appServerEpoch":"epoch-1"}
            }),
        );
        ledger.track_request(
            question_id,
            InteractionBinding {
                interaction_id: question.question_id.clone().unwrap(),
                server_id: context.server_id,
                thread_id: context.thread_id,
                turn_id: context.turn_id,
                kind: InteractionStatusKindV1::Question,
            },
            json!({
                "jsonrpc":"2.0", "id":question_id, "method":"question/request",
                "params":{"serverId":"server-1", "threadId":"thread-1", "turnId":"turn-1",
                    "questionId":"question-302", "appServerEpoch":"epoch-1"}
            }),
        );
    }

    let read = |selector: &kcoder_app_protocol::InteractionStatusReadParamsV1| {
        read_interaction_status(
            true,
            serde_json::to_value(selector).unwrap(),
            &receipts.lock().unwrap(),
            |params| state.pending_interaction_matches(params, &mcp_app_pending),
        )
        .unwrap()
        .status
    };
    assert_eq!(read(&approval), InteractionStatusV1::Pending);
    assert_eq!(read(&question), InteractionStatusV1::Pending);

    let mut swapped_id = approval.clone();
    swapped_id.request_id = question_id;
    let mut swapped_interaction = approval.clone();
    swapped_interaction.approval_id = Some("question-302".into());
    assert_eq!(read(&swapped_id), InteractionStatusV1::Unknown);
    assert_eq!(read(&swapped_interaction), InteractionStatusV1::Unknown);
}
