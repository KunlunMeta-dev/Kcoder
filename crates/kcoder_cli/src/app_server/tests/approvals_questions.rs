#[tokio::test]
async fn negotiated_approval_tool_identity_is_bound_per_call_without_mutating_the_shared_prompt() {
    for enabled in [false, true] {
        let (mut prompt, mut outbound, pending) =
            test_permission_prompt(kcoder_config::PermissionMode::Ask);
        prompt.tool_call_identity_enabled = enabled;
        let bound = prompt.bind_tool_call("actual-call").unwrap();
        assert!(prompt.tool_call_id.is_none());
        let worker = tokio::spawn(async move {
            bound
                .ask_context(&permission_request_context(
                    "write",
                    json!({"file_path":"fixture.txt"}),
                ))
                .await
        });
        let frame = outbound.recv().await.unwrap();
        if enabled {
            assert_eq!(frame["params"]["toolCallId"], "actual-call");
        } else {
            assert!(frame["params"].get("toolCallId").is_none());
        }
        resolve_legacy_reply(
            &json!({"jsonrpc":"2.0","id":frame["id"],"result":{"decision":"accept"}}),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
        );
        assert_eq!(worker.await.unwrap(), PermissionResponse::AllowOnce);
    }
}

#[tokio::test]
async fn app_server_permission_prompt_round_trips_allow_once() {
    let (mut prompt, mut outbound_rx, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Ask);
    let artifact_root = tempfile::tempdir().unwrap();
    let artifact_dir = artifact_root
        .path()
        .join("thread-1")
        .join("approval-decisions");
    prompt.artifact_dir = Arc::new(StdMutex::new(Some(artifact_dir.clone())));
    let context = permission_request_context("bash", json!({"command": "cargo test"}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });

    let wire = outbound_rx.recv().await.unwrap();
    assert_eq!(wire["method"], method::APPROVAL_REQUEST);
    assert_eq!(wire["id"], 2_000_000);
    assert_eq!(wire["params"]["approvalId"], "approval-2000000");
    assert_eq!(wire["params"]["threadId"], "thread-1");
    assert_eq!(wire["params"]["action"]["type"], "command");
    assert_eq!(wire["params"]["action"]["command"], "cargo test");
    assert_eq!(wire["params"]["reason"], "执行测试操作");

    resolve_legacy_reply(
        &json!({"jsonrpc": "2.0", "id": 2_000_000, "result": {"decision": "accept"}}),
        &pending,
        &Arc::new(StdMutex::new(HashMap::new())),
    );
    assert_eq!(handle.await.unwrap(), PermissionResponse::AllowOnce);
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["method"], method::APPROVAL_RESOLVED);
    assert_eq!(resolved["params"]["decision"], "accept");
    assert_eq!(resolved["params"]["reason"], "client_response");
    assert!(pending.lock().unwrap().is_empty());
    let persisted = std::fs::read_dir(&artifact_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let artifact: ApprovalDecisionArtifact =
        serde_json::from_slice(&std::fs::read(persisted).unwrap()).unwrap();
    assert_eq!(artifact.thread_id, "thread-1");
    assert_eq!(artifact.turn_id, "turn-1");
    assert_eq!(artifact.decision, ApprovalDecision::Accept);
    assert_eq!(
        artifact.action,
        ApprovalAction::Command {
            command: "cargo test".into()
        }
    );
}

#[test]
fn persisted_approval_decision_projects_as_completed_question_summary() {
    let artifact = ApprovalDecisionArtifact {
        tool_call_id: None,
        version: 1,
        artifact_id: "a".repeat(64),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        approval_id: "approval-1".into(),
        action: ApprovalAction::Command {
            command: "touch marker.txt".into(),
        },
        reason: "需要执行写入命令".into(),
        decision: ApprovalDecision::Decline,
        resolution_reason: "client_response".into(),
        requested_at_ms: 100,
        resolved_at_ms: 200,
    };
    let legacy = serde_json::to_value(&artifact).unwrap();
    assert!(legacy.get("tool_call_id").is_none());
    assert!(
        serde_json::from_value::<ApprovalDecisionArtifact>(legacy)
            .unwrap()
            .tool_call_id
            .is_none()
    );
    let mut messages = vec![ThreadMessage {
        file_changes_capture: None,
        review_evidence: None,
        id: "assistant-1".into(),
        client_message_id: None,
        turn_id: Some("turn-1".into()),
        role: "assistant".into(),
        content: "权限被拒绝".into(),
        status: Some("completed".into()),
        error: None,
        error_type: None,
        provider_failure: None,
        attempt_id: None,
        continued_by_attempt_id: None,
        blocks: Vec::new(),
        timestamp_ms: 100,
        content_truncated: false,
        content_original_chars: None,
    }];

    attach_approval_decision_blocks(&mut messages, vec![artifact]);

    let payload = &messages[0].blocks[0]["render_payload"];
    assert_eq!(payload["kind"], "request_user_input");
    assert_eq!(payload["questions"][0]["header"], "Permission request");
    assert_eq!(
        payload["response"]["answers"]["approval-1"]["answers"][0],
        "Decline"
    );
    assert_eq!(messages[0].blocks[0]["status"], "done");
}

#[tokio::test]
async fn app_server_permission_prompt_maps_session_and_negative_decisions() {
    for (decision, expected) in [
        (
            ApprovalDecision::AcceptForSession,
            PermissionResponse::AllowForSession,
        ),
        (ApprovalDecision::Decline, PermissionResponse::DenyOnce),
        (ApprovalDecision::Cancel, PermissionResponse::DenyOnce),
    ] {
        let (prompt, mut outbound_rx, pending) =
            test_permission_prompt(kcoder_config::PermissionMode::Ask);
        let context = permission_request_context("write", json!({"file_path": "README.md"}));
        let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
        let wire = outbound_rx.recv().await.unwrap();
        assert_eq!(wire["params"]["action"]["type"], "file_change");
        let request_id = wire["id"].as_u64().unwrap();
        pending
            .lock()
            .unwrap()
            .remove(&request_id)
            .unwrap()
            .send(Ok(ApprovalResponse {
                decision,
                approval_id: None,
                thread_id: None,
                turn_id: None,
            }))
            .unwrap();
        assert_eq!(handle.await.unwrap(), expected);
    }
}

#[tokio::test]
async fn app_server_permission_prompt_denies_errors_and_connection_close() {
    let (prompt, mut outbound_rx, pending, receipts) =
        test_permission_prompt_with_receipts(kcoder_config::PermissionMode::Ask);
    let context = permission_request_context("custom", json!({"value": 1}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
    let wire = outbound_rx.recv().await.unwrap();
    assert_eq!(wire["params"]["action"]["type"], "tool");
    resolve_legacy_reply(
        &json!({
            "jsonrpc": "2.0",
            "id": wire["id"],
            "error": {"code": -32001, "message": "客户端审批失败"}
        }),
        &pending,
        &Arc::new(StdMutex::new(HashMap::new())),
    );
    assert_eq!(handle.await.unwrap(), PermissionResponse::DenyOnce);
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["params"]["reason"], "response_error");
    let selector = kcoder_app_protocol::InteractionStatusReadParamsV1 {
        server_id: "server-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        request_id: wire["id"].as_u64().unwrap(),
        app_server_epoch: wire["params"]["appServerEpoch"].as_str().unwrap().into(),
        kind: kcoder_app_protocol::InteractionStatusKindV1::Approval,
        approval_id: Some(wire["params"]["approvalId"].as_str().unwrap().into()),
        question_id: None,
    };
    assert_eq!(
        receipts.lock().unwrap().read_status(&selector, None),
        kcoder_app_protocol::InteractionStatusV1::Resolved,
    );

    let (prompt, mut outbound_rx, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Ask);
    let context = permission_request_context("custom", json!({"value": 2}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
    outbound_rx.recv().await.unwrap();
    pending.lock().unwrap().clear();
    assert_eq!(handle.await.unwrap(), PermissionResponse::DenyOnce);

    let (prompt, outbound_rx, pending) = test_permission_prompt(kcoder_config::PermissionMode::Ask);
    drop(outbound_rx);
    assert_eq!(
        prompt
            .ask_context(&permission_request_context("custom", json!({"value": 3})))
            .await,
        PermissionResponse::DenyOnce
    );
    assert!(pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn app_server_permission_prompt_times_out_fail_closed_and_removes_pending() {
    let (mut prompt, mut outbound_rx, pending, receipts) =
        test_permission_prompt_with_receipts(kcoder_config::PermissionMode::Ask);
    prompt.response_timeout = Duration::from_millis(20);
    let context = permission_request_context("custom", json!({"value": 4}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
    let wire = outbound_rx.recv().await.unwrap();
    let request_id = wire["id"].as_u64().unwrap();
    let app_server_epoch = wire["params"]["appServerEpoch"].as_str().unwrap();
    assert!(pending.lock().unwrap().contains_key(&request_id));
    assert_eq!(handle.await.unwrap(), PermissionResponse::DenyOnce);
    assert!(!pending.lock().unwrap().contains_key(&request_id));
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["method"], method::APPROVAL_RESOLVED);
    assert_eq!(resolved["params"]["requestId"], request_id);
    assert_eq!(resolved["params"]["approvalId"], "approval-2000000");
    assert_eq!(resolved["params"]["threadId"], wire["params"]["threadId"]);
    assert_eq!(resolved["params"]["turnId"], wire["params"]["turnId"]);
    assert_eq!(resolved["params"]["appServerEpoch"], app_server_epoch);
    assert!(resolved["params"].get("serverId").is_none());
    assert_eq!(resolved["params"]["decision"], "decline");
    assert_eq!(resolved["params"]["reason"], "timeout");
    let selector = kcoder_app_protocol::InteractionStatusReadParamsV1 {
        server_id: "server-1".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        request_id,
        app_server_epoch: app_server_epoch.into(),
        kind: kcoder_app_protocol::InteractionStatusKindV1::Approval,
        approval_id: Some("approval-2000000".into()),
        question_id: None,
    };
    assert_eq!(
        receipts.lock().unwrap().read_status(&selector, None),
        kcoder_app_protocol::InteractionStatusV1::Resolved,
    );
}

#[tokio::test]
async fn explicit_effect_prompt_requires_original_ui_response_even_in_bypass_mode() {
    for accept in [false, true] {
        let (prompt, mut outbound, pending) =
            test_permission_prompt(kcoder_config::PermissionMode::Bypass);
        let bound = prompt.bind_tool_call("original-effect-call").unwrap();
        let context = permission_request_context(
            "original-reviewed-effect",
            json!({"body":"Exact approved body"}),
        );
        let task =
            tokio::spawn(async move { bound.ask_explicit_context_with_edit(&context).await });
        let frame = outbound.recv().await.unwrap();
        assert_eq!(frame["method"], method::APPROVAL_REQUEST);
        assert_eq!(frame["params"]["threadId"], "thread-1");
        assert_eq!(frame["params"]["turnId"], "turn-1");
        assert!(!task.is_finished());
        resolve_legacy_reply(
            &json!({"jsonrpc":"2.0","id":frame["id"],"result":{
            "decision":if accept {"accept"} else {"decline"}}}),
            &pending,
            &Arc::new(StdMutex::new(HashMap::new())),
        );
        assert_eq!(
            task.await.unwrap().response,
            if accept {
                PermissionResponse::AllowOnce
            } else {
                PermissionResponse::DenyOnce
            }
        );
        assert!(pending.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn explicit_effect_prompt_timeout_and_missing_turn_fail_closed_in_bypass_mode() {
    let (mut prompt, mut outbound, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Bypass);
    prompt.response_timeout = Duration::from_millis(20);
    let task = tokio::spawn(async move {
        prompt
            .ask_explicit_context_with_edit(&permission_request_context(
                "original-effect",
                json!({}),
            ))
            .await
    });
    let frame = outbound.recv().await.unwrap();
    assert_eq!(frame["method"], method::APPROVAL_REQUEST);
    assert_eq!(task.await.unwrap().response, PermissionResponse::DenyOnce);
    assert!(pending.lock().unwrap().is_empty());
    let (prompt, mut outbound, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Bypass);
    *prompt.context.lock().unwrap() = None;
    assert_eq!(
        prompt
            .ask_explicit_context_with_edit(&permission_request_context(
                "original-effect",
                json!({})
            ))
            .await
            .response,
        PermissionResponse::DenyOnce
    );
    assert!(outbound.try_recv().is_err());
    assert!(pending.lock().unwrap().is_empty());
}

#[tokio::test]
async fn app_server_permission_prompt_preserves_noninteractive_modes() {
    for (mode, expected) in [
        (
            kcoder_config::PermissionMode::Yolo,
            PermissionResponse::AllowOnce,
        ),
        (
            kcoder_config::PermissionMode::DontAsk,
            PermissionResponse::DenyOnce,
        ),
    ] {
        let (prompt, mut outbound_rx, _pending) = test_permission_prompt(mode);
        let response = prompt
            .ask_context(&permission_request_context("custom", json!({})))
            .await;
        assert_eq!(response, expected);
        assert!(outbound_rx.try_recv().is_err());
    }
}

#[test]
fn app_server_advertises_approval_support() {
    let capabilities = server_capabilities(false);
    assert!(capabilities.approvals);
    assert!(capabilities.questions);
    assert!(!capabilities.thread_resume);
}

#[tokio::test]
async fn resident_interactions_follow_the_input_client_and_keep_original_reply_binding() {
    let (creator, mut old_output) = mpsc::channel(8);
    let resident = ResidentTurnState::new(
        creator,
        kcoder_config::PermissionMode::Ask,
        Arc::new(AtomicU64::new(30_000)),
        Arc::new(StdMutex::new(InteractionReceipts::new("same-resident-epoch".into()))),
    );
    *resident.question_context.lock().unwrap() = Some(QuestionContext {
        server_id: "same-host".into(),
        thread_id: "same-task".into(),
        turn_id: "web-turn".into(),
    });
    *resident.approval_context.lock().unwrap() = Some(ApprovalContext {
        server_id: "same-host".into(),
        thread_id: "same-task".into(),
        turn_id: "web-turn".into(),
    });
    let (client, mut output) = mpsc::channel(8);
    let (permission, questioner) = resident.interactions_for_input(client);
    // Closing the creator must not remove the resident's current client route.
    old_output.close();
    let asking = tokio::spawn(async move {
        questioner
            .ask(UserQuestionRequest {
                questions: vec![kcoder_tools::Question {
                    question: "Choose?".into(),
                    header: "Choice".into(),
                    options: Vec::new(),
                    multi_select: false,
                }],
                answers: HashMap::new(),
                annotations: None,
            })
            .await
    });
    let wire = tokio::time::timeout(Duration::from_secs(2), output.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(wire["method"], "question/request");
    assert_eq!(wire["params"]["appServerEpoch"], "same-resident-epoch");
    let mut response = json!({"jsonrpc":"2.0", "id":wire["id"], "result":{
        "questionId":wire["params"]["questionId"], "threadId":"same-task", "turnId":"other-turn",
        "answers":{"question-1":{"answers":["selected"]}}
    }});
    assert!(matches!(
        resident.resolve_response(&response, true),
        InteractionReply::Misattributed
    ));
    response["result"]["turnId"] = json!("web-turn");
    response["result"]["answers"] = json!({"question-99":{"answers":["wrong card"]}});
    assert!(matches!(
        resident.resolve_response(&response, true),
        InteractionReply::Misattributed
    ));
    assert!(!asking.is_finished());
    response["result"]["answers"] = json!({"question-1":{"answers":["selected"]}});
    assert!(matches!(
        resident.resolve_response(&response, true),
        InteractionReply::Delivered
    ));
    assert_eq!(
        asking.await.unwrap().unwrap().answers["Choose?"],
        "selected"
    );
    assert_eq!(output.recv().await.unwrap()["method"], "question/resolved");
    let approving = tokio::spawn(async move {
        permission
            .ask_context(&permission_request_context(
                "write",
                json!({"file_path":"fixture"}),
            ))
            .await
    });
    let wire = tokio::time::timeout(Duration::from_secs(2), output.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(wire["method"], "approval/request");
    assert!(matches!(resident.resolve_response(&json!({"jsonrpc":"2.0", "id":wire["id"], "result":{
        "approvalId":wire["params"]["approvalId"], "threadId":"same-task", "turnId":"web-turn", "decision":"decline"
    }}), true), InteractionReply::Delivered));
    assert_eq!(approving.await.unwrap(), PermissionResponse::DenyOnce);
    assert!(old_output.try_recv().is_err());
}

#[tokio::test]
async fn app_server_questioner_round_trips_answers_without_ending_the_turn() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(4);
    let pending: PendingQuestionResponses = Arc::new(StdMutex::new(HashMap::new()));
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::new("question-test-epoch".into())));
    let questioner = AppServerQuestioner {
        receipts,
        outbound_tx,
        pending: Arc::clone(&pending),
        next_id: Arc::new(AtomicU64::new(1_000_000)),
        context: Arc::new(StdMutex::new(Some(QuestionContext {
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
        }))),
    };
    let request = UserQuestionRequest {
        questions: vec![kcoder_tools::Question {
            question: "Which database?".into(),
            header: "Database".into(),
            options: vec![
                kcoder_tools::QuestionOption {
                    label: "SQLite".into(),
                    description: "Keep state local.".into(),
                    preview: None,
                },
                kcoder_tools::QuestionOption {
                    label: "Postgres".into(),
                    description: "Use a shared service.".into(),
                    preview: None,
                },
            ],
            multi_select: false,
        }],
        answers: HashMap::new(),
        annotations: None,
    };
    let handle = tokio::spawn(async move { questioner.ask(request).await });
    let wire = outbound_rx.recv().await.unwrap();
    assert_eq!(wire["method"], "question/request");
    assert_eq!(wire["params"]["threadId"], "thread-1");
    let request_epoch = wire["params"]["appServerEpoch"].as_str().unwrap();
    assert_eq!(request_epoch, "question-test-epoch");
    assert_eq!(wire["params"]["questions"][0]["header"], "Database");
    let response_tx = pending.lock().unwrap().remove(&1_000_000).unwrap();
    response_tx
        .send(Ok(QuestionResponse {
            question_id: None,
            thread_id: None,
            turn_id: None,
            answers: BTreeMap::from([(
                "question-1".into(),
                kcoder_app_protocol::QuestionAnswer {
                    answers: vec!["SQLite".into()],
                },
            )]),
            annotations: None,
        }))
        .unwrap();
    let response = handle.await.unwrap().unwrap();
    assert_eq!(response.answers["Which database?"], "SQLite");
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["method"], "question/resolved");
    assert_eq!(resolved["params"]["requestId"], 1_000_000);
    assert_eq!(
        resolved["params"]["questionId"],
        wire["params"]["questionId"]
    );
    assert_eq!(resolved["params"]["threadId"], wire["params"]["threadId"]);
    assert_eq!(resolved["params"]["turnId"], wire["params"]["turnId"]);
    assert_eq!(resolved["params"]["appServerEpoch"], request_epoch);
    assert_eq!(resolved["params"]["reason"], "client_response");
    assert!(resolved["params"].get("serverId").is_none());
}

#[tokio::test]
async fn app_server_questioner_reports_explicit_client_cancel_as_cancelled() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(4);
    let pending = Arc::new(StdMutex::new(HashMap::new()));
    let receipts = Arc::new(StdMutex::new(InteractionReceipts::new("question-cancel-test-epoch".into())));
    let questioner = AppServerQuestioner {
        receipts: Arc::clone(&receipts),
        outbound_tx,
        pending: Arc::clone(&pending),
        next_id: Arc::new(AtomicU64::new(1_100_000)),
        context: Arc::new(StdMutex::new(Some(QuestionContext {
            server_id: "server-1".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
        }))),
    };
    let request = UserQuestionRequest {
        questions: vec![kcoder_tools::Question {
            question: "Choose?".into(),
            header: "Choice".into(),
            options: Vec::new(),
            multi_select: false,
        }],
        answers: HashMap::new(),
        annotations: None,
    };
    let handle = tokio::spawn(async move { questioner.ask(request).await });
    let wire = outbound_rx.recv().await.unwrap();
    let request_id = wire["id"].as_u64().unwrap();
    let request_epoch = wire["params"]["appServerEpoch"].as_str().unwrap();
    assert_eq!(request_epoch, "question-cancel-test-epoch");
    pending
        .lock()
        .unwrap()
        .remove(&request_id)
        .unwrap()
        .send(Err("the user cancelled the question request".into()))
        .unwrap();
    assert!(handle.await.unwrap().is_err());
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["method"], "question/resolved");
    assert_eq!(resolved["params"]["requestId"], request_id);
    assert_eq!(resolved["params"]["appServerEpoch"], request_epoch);
    assert_eq!(resolved["params"]["reason"], "client_cancelled");
    assert_eq!(
        receipts.lock().unwrap().read_status(
            &kcoder_app_protocol::InteractionStatusReadParamsV1 {
                server_id: "server-1".into(),
                thread_id: wire["params"]["threadId"].as_str().unwrap().into(),
                turn_id: wire["params"]["turnId"].as_str().unwrap().into(),
                request_id,
                app_server_epoch: request_epoch.into(),
                kind: kcoder_app_protocol::InteractionStatusKindV1::Question,
                approval_id: None,
                question_id: Some(wire["params"]["questionId"].as_str().unwrap().into()),
            },
            None
        ),
        kcoder_app_protocol::InteractionStatusV1::Resolved
    );
}

#[test]
fn native_question_rejects_foreign_items_without_consuming_original_waiter() {
    for require_binding in [false, true] {
        for foreign in [
            json!({"question-99":{"answers":["foreign answer"]}}),
            json!({"question-1":{"answers":["original"]},"question-99":{"answers":["foreign"]}}),
            json!({"constructor":{"answers":["foreign answer"]}}),
        ] {
            let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
            let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
            let (answer_tx, mut answer_rx) = oneshot::channel();
            pending_questions.lock().unwrap().insert(501, answer_tx);
            let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
            receipts.lock().unwrap().track_request(
                501,
                InteractionBinding {
                    interaction_id: "original-question".into(),
                    server_id: "server".into(),
                    thread_id: "thread".into(),
                    turn_id: "turn".into(),
                    kind: kcoder_app_protocol::InteractionStatusKindV1::Question,
                },
                json!({"method":"question/request","params":{"questions":[
                    {"id":"question-1"},{"id":"question-2"}
                ]}}),
            );
            let response = |answers| {
                json!({"id":501,"result":{
                    "questionId":"original-question","threadId":"thread","turnId":"turn","answers":answers
                }})
            };
            assert!(matches!(
                resolve_server_response(
                    &response(foreign),
                    &pending_approvals,
                    &pending_questions,
                    &receipts,
                    require_binding
                ),
                InteractionReply::Misattributed
            ));
            assert!(pending_questions.lock().unwrap().contains_key(&501));
            assert!(matches!(
                answer_rx.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            assert!(matches!(
                resolve_server_response(
                    &response(json!({"question-2":{"answers":["original freeform"]}})),
                    &pending_approvals,
                    &pending_questions,
                    &receipts,
                    require_binding
                ),
                InteractionReply::Delivered
            ));
            assert_eq!(
                answer_rx.try_recv().unwrap().unwrap().answers["question-2"].answers,
                ["original freeform"]
            );
        }
    }
}

#[test]
fn native_question_item_binding_preserves_empty_partial_and_cancel_replies() {
    for require_binding in [false, true] {
        for frame in [
            json!({"result":{"answers":{}}}),
            json!({"result":{"answers":{"question-2":{"answers":["original freeform"]}}}}),
            json!({"error":{"code":-32800,"message":"the user cancelled the question request"}}),
        ] {
            let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
            let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
            let (answer_tx, mut answer_rx) = oneshot::channel();
            pending_questions.lock().unwrap().insert(502, answer_tx);
            let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
            receipts.lock().unwrap().track_request(
                502,
                InteractionBinding {
                    interaction_id: "original-question".into(),
                    server_id: "server".into(),
                    thread_id: "thread".into(),
                    turn_id: "turn".into(),
                    kind: kcoder_app_protocol::InteractionStatusKindV1::Question,
                },
                json!({"method":"question/request","params":{"questions":[
                    {"id":"question-1"},{"id":"question-2"}
                ]}}),
            );
            let mut response = frame;
            response["id"] = json!(502);
            if let Some(result) = response.get_mut("result") {
                result["questionId"] = json!("original-question");
                result["threadId"] = json!("thread");
                result["turnId"] = json!("turn");
            }
            assert!(matches!(
                resolve_server_response(
                    &response,
                    &pending_approvals,
                    &pending_questions,
                    &receipts,
                    require_binding
                ),
                InteractionReply::Delivered
            ));
            let answer = answer_rx.try_recv().unwrap();
            assert_eq!(answer.is_err(), response.get("error").is_some());
            assert!(!pending_questions.lock().unwrap().contains_key(&502));
        }
    }
}

#[test]
fn native_interaction_rejects_stale_reply_epoch_without_consuming_waiter() {
    for kind in ["question", "approval"] {
        for require_binding in [false, true] {
            for original_epoch in [None, Some("current-epoch")] {
                for epoch in [
                    json!("previous-epoch"),
                    json!(""),
                    json!(" "),
                    json!(7),
                    json!(false),
                    json!({}),
                    json!([]),
                    json!("current-epoch"),
                ] {
                    if original_epoch.is_some() && epoch == json!("current-epoch") {
                        continue;
                    }
                    let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
                    let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
                    let (approval_tx, mut approval_rx) = oneshot::channel();
                    let (question_tx, mut question_rx) = oneshot::channel();
                    let is_question = kind == "question";
                    if is_question {
                        pending_questions.lock().unwrap().insert(503, question_tx);
                    } else {
                        pending_approvals.lock().unwrap().insert(503, approval_tx);
                    }
                    let field = if is_question {
                        "questionId"
                    } else {
                        "approvalId"
                    };
                    let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
                    receipts.lock().unwrap().track_request(
                        503,
                        InteractionBinding {
                            interaction_id: "original".into(),
                            server_id: "server".into(),
                            thread_id: "thread".into(),
                            turn_id: "turn".into(),
                            kind: if is_question {
                                kcoder_app_protocol::InteractionStatusKindV1::Question
                            } else {
                                kcoder_app_protocol::InteractionStatusKindV1::Approval
                            },
                        },
                        json!({"method":format!("{kind}/request"), "params":{
                            "appServerEpoch":original_epoch, "questions":[{"id":"question-1"}]
                        }}),
                    );
                    let mut result = if is_question {
                        json!({"answers":{"question-1":{"answers":["original answer"]}}})
                    } else {
                        json!({"decision":"accept"})
                    };
                    result[field] = json!("original");
                    result["threadId"] = json!("thread");
                    result["turnId"] = json!("turn");
                    result["appServerEpoch"] = epoch;
                    let mut response = json!({"id":503,"result":result});
                    assert!(
                        matches!(
                            resolve_server_response(
                                &response,
                                &pending_approvals,
                                &pending_questions,
                                &receipts,
                                require_binding,
                            ),
                            InteractionReply::Misattributed
                        ),
                        "a foreign or invalid epoch must preserve the original waiter: {response}"
                    );
                    if is_question {
                        assert!(pending_questions.lock().unwrap().contains_key(&503));
                        assert!(matches!(
                            question_rx.try_recv(),
                            Err(oneshot::error::TryRecvError::Empty)
                        ));
                    } else {
                        assert!(pending_approvals.lock().unwrap().contains_key(&503));
                        assert!(matches!(
                            approval_rx.try_recv(),
                            Err(oneshot::error::TryRecvError::Empty)
                        ));
                    }
                    response["result"]["appServerEpoch"] = json!(original_epoch);
                    assert!(matches!(
                        resolve_server_response(
                            &response,
                            &pending_approvals,
                            &pending_questions,
                            &receipts,
                            require_binding,
                        ),
                        InteractionReply::Delivered
                    ));
                    if is_question {
                        assert_eq!(
                            question_rx.try_recv().unwrap().unwrap().answers["question-1"].answers,
                            ["original answer"]
                        );
                    } else {
                        assert_eq!(
                            approval_rx.try_recv().unwrap().unwrap().decision,
                            kcoder_app_protocol::ApprovalDecision::Accept
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn native_interaction_rejects_invalid_response_envelopes_without_consuming_waiter() {
    for kind in ["question", "approval"] {
        for require_binding in [false, true] {
            for invalid in [
                json!({"error":null}),
                json!({"error":false}),
                json!({"error":"cancelled"}),
                json!({"error":[]}),
                json!({"error":{}}),
                json!({"error":{"message":"cancelled"}}),
                json!({"error":{"code":-32800}}),
                json!({"error":{"code":"-32800","message":"cancelled"}}),
                json!({"error":{"code":1.5,"message":"cancelled"}}),
                json!({"error":{"code":-32800,"message":null}}),
                json!({"error":{"code":-32800,"message":"cancelled"},"result":null}),
                json!({"jsonrpc":"1.0","error":{"code":-32800,"message":"cancelled"}}),
                json!({"jsonrpc":null,"error":{"code":-32800,"message":"cancelled"}}),
                json!({"method":null,"error":{"code":-32800,"message":"cancelled"}}),
            ] {
                let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
                let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
                let (approval_tx, mut approval_rx) = oneshot::channel();
                let (question_tx, mut question_rx) = oneshot::channel();
                let is_question = kind == "question";
                if is_question {
                    pending_questions.lock().unwrap().insert(504, question_tx);
                } else {
                    pending_approvals.lock().unwrap().insert(504, approval_tx);
                }
                let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
                receipts.lock().unwrap().track_request(
                    504,
                    InteractionBinding {
                        interaction_id: "original".into(),
                        server_id: "server".into(),
                        thread_id: "thread".into(),
                        turn_id: "turn".into(),
                        kind: if is_question {
                            kcoder_app_protocol::InteractionStatusKindV1::Question
                        } else {
                            kcoder_app_protocol::InteractionStatusKindV1::Approval
                        },
                    },
                    json!({"params":{"questions":[{"id":"question-1"}]}}),
                );
                let mut response = invalid;
                response["id"] = json!(504);
                assert!(
                    matches!(
                        resolve_server_response(
                            &response,
                            &pending_approvals,
                            &pending_questions,
                            &receipts,
                            require_binding,
                        ),
                        InteractionReply::Misattributed
                    ),
                    "invalid {kind} response must preserve the original waiter: {response}"
                );
                if is_question {
                    assert!(pending_questions.lock().unwrap().contains_key(&504));
                    assert!(matches!(
                        question_rx.try_recv(),
                        Err(oneshot::error::TryRecvError::Empty)
                    ));
                } else {
                    assert!(pending_approvals.lock().unwrap().contains_key(&504));
                    assert!(matches!(
                        approval_rx.try_recv(),
                        Err(oneshot::error::TryRecvError::Empty)
                    ));
                }
                let result = if is_question {
                    json!({"questionId":"original","threadId":"thread","turnId":"turn",
                        "answers":{"question-1":{"answers":["original answer"]}}})
                } else {
                    json!({"approvalId":"original","threadId":"thread","turnId":"turn","decision":"accept"})
                };
                assert!(matches!(
                    resolve_server_response(
                        &json!({"jsonrpc":"2.0","id":504,"result":result}),
                        &pending_approvals,
                        &pending_questions,
                        &receipts,
                        require_binding,
                    ),
                    InteractionReply::Delivered
                ));
                if is_question {
                    assert_eq!(
                        question_rx.try_recv().unwrap().unwrap().answers["question-1"].answers,
                        ["original answer"]
                    );
                } else {
                    assert_eq!(
                        approval_rx.try_recv().unwrap().unwrap().decision,
                        kcoder_app_protocol::ApprovalDecision::Accept
                    );
                }
            }
        }
    }
}

#[test]
fn native_interaction_preserves_valid_error_responses() {
    for require_binding in [false, true] {
        for jsonrpc in [None, Some("2.0")] {
            let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
            let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
            let (approval_tx, mut approval_rx) = oneshot::channel();
            let (question_tx, mut question_rx) = oneshot::channel();
            pending_approvals.lock().unwrap().insert(505, approval_tx);
            pending_questions.lock().unwrap().insert(506, question_tx);
            let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
            for id in [505, 506] {
                let mut response = json!({"id":id,"error":{
                    "code":-32800,"message":"user cancelled","data":{"reason":"cancel"}
                }});
                if let Some(jsonrpc) = jsonrpc {
                    response["jsonrpc"] = json!(jsonrpc);
                }
                assert!(matches!(
                    resolve_server_response(
                        &response,
                        &pending_approvals,
                        &pending_questions,
                        &receipts,
                        require_binding,
                    ),
                    InteractionReply::Delivered
                ));
            }
            assert_eq!(
                approval_rx.try_recv().unwrap().unwrap_err(),
                "user cancelled"
            );
            assert_eq!(
                question_rx.try_recv().unwrap().unwrap_err(),
                "user cancelled"
            );
        }
    }
}

#[test]
fn native_interaction_rejects_explicit_binding_mismatch_without_negotiation() {
    for question in [false, true] {
        let identity = if question { "questionId" } else { "approvalId" };
        for require_binding in [false, true] {
            for field in [identity, "threadId", "turnId"] {
                for mismatch in ["foreign", "", " "] {
                    let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
                    let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
                    let (approval_tx, mut approval_rx) = oneshot::channel();
                    let (question_tx, mut question_rx) = oneshot::channel();
                    if question {
                        pending_questions.lock().unwrap().insert(507, question_tx);
                    } else {
                        pending_approvals.lock().unwrap().insert(507, approval_tx);
                    }
                    let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
                    receipts.lock().unwrap().track_request(
                        507,
                        InteractionBinding {
                            interaction_id: "original".into(),
                            server_id: "server".into(),
                            thread_id: "thread".into(),
                            turn_id: "turn".into(),
                            kind: if question {
                                kcoder_app_protocol::InteractionStatusKindV1::Question
                            } else {
                                kcoder_app_protocol::InteractionStatusKindV1::Approval
                            },
                        },
                        json!({"params":{"questions":[{"id":"item"}]}}),
                    );
                    let mut result = if question {
                        json!({"answers":{"item":{"answers":["original answer"]}}})
                    } else {
                        json!({"decision":"accept"})
                    };
                    result[identity] = json!("original");
                    result["threadId"] = json!("thread");
                    result["turnId"] = json!("turn");
                    let mut response = json!({"id":507,"result":result});
                    response["result"][field] = json!(mismatch);
                    assert!(
                        matches!(
                            resolve_server_response(
                                &response,
                                &pending_approvals,
                                &pending_questions,
                                &receipts,
                                require_binding,
                            ),
                            InteractionReply::Misattributed
                        ),
                        "explicit mismatch consumed original input: {response}"
                    );
                    if question {
                        assert!(pending_questions.lock().unwrap().contains_key(&507));
                        assert!(matches!(
                            question_rx.try_recv(),
                            Err(oneshot::error::TryRecvError::Empty)
                        ));
                    } else {
                        assert!(pending_approvals.lock().unwrap().contains_key(&507));
                        assert!(matches!(
                            approval_rx.try_recv(),
                            Err(oneshot::error::TryRecvError::Empty)
                        ));
                    }
                    response["result"] = result.clone();
                    // Legacy omission/null remains compatible; explicit matching
                    // fields still bind to the original input without negotiation.
                    if !require_binding {
                        if mismatch == "foreign" {
                            response["result"].as_object_mut().unwrap().remove(field);
                        } else if mismatch.is_empty() {
                            response["result"][field] = Value::Null;
                        }
                    }
                    assert!(matches!(
                        resolve_server_response(
                            &response,
                            &pending_approvals,
                            &pending_questions,
                            &receipts,
                            require_binding,
                        ),
                        InteractionReply::Delivered
                    ));
                    if question {
                        assert_eq!(
                            question_rx.try_recv().unwrap().unwrap().answers["item"].answers,
                            ["original answer"]
                        );
                    } else {
                        assert_eq!(
                            approval_rx.try_recv().unwrap().unwrap().decision,
                            kcoder_app_protocol::ApprovalDecision::Accept
                        );
                    }
                }
            }
        }
    }
}
