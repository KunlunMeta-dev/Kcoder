#[tokio::test]
async fn app_server_permission_prompt_round_trips_allow_once() {
    let (mut prompt, mut outbound_rx, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Ask);
    let artifact_root = tempfile::tempdir().unwrap();
    let artifact_dir = artifact_root.path().join("thread-1").join("approval-decisions");
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

    resolve_server_response(
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
    let mut messages = vec![ThreadMessage {
        id: "assistant-1".into(),
        client_message_id: None,
        turn_id: Some("turn-1".into()),
        role: "assistant".into(),
        content: "权限被拒绝".into(),
        status: Some("completed".into()),
        error: None,
        error_type: None,
        provider_failure: None,
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
            .send(Ok(ApprovalResponse { decision }))
            .unwrap();
        assert_eq!(handle.await.unwrap(), expected);
    }
}

#[tokio::test]
async fn app_server_permission_prompt_denies_errors_and_connection_close() {
    let (prompt, mut outbound_rx, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Ask);
    let context = permission_request_context("custom", json!({"value": 1}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
    let wire = outbound_rx.recv().await.unwrap();
    assert_eq!(wire["params"]["action"]["type"], "tool");
    resolve_server_response(
        &json!({
            "jsonrpc": "2.0",
            "id": wire["id"],
            "error": {"code": -32001, "message": "客户端审批失败"}
        }),
        &pending,
        &Arc::new(StdMutex::new(HashMap::new())),
    );
    assert_eq!(handle.await.unwrap(), PermissionResponse::DenyOnce);

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
    let (mut prompt, mut outbound_rx, pending) =
        test_permission_prompt(kcoder_config::PermissionMode::Ask);
    prompt.response_timeout = Duration::from_millis(20);
    let context = permission_request_context("custom", json!({"value": 4}));
    let handle = tokio::spawn(async move { prompt.ask_context(&context).await });
    let wire = outbound_rx.recv().await.unwrap();
    let request_id = wire["id"].as_u64().unwrap();
    assert!(pending.lock().unwrap().contains_key(&request_id));
    assert_eq!(handle.await.unwrap(), PermissionResponse::DenyOnce);
    assert!(!pending.lock().unwrap().contains_key(&request_id));
    let resolved = outbound_rx.recv().await.unwrap();
    assert_eq!(resolved["method"], method::APPROVAL_RESOLVED);
    assert_eq!(resolved["params"]["requestId"], request_id);
    assert_eq!(resolved["params"]["approvalId"], "approval-2000000");
    assert_eq!(resolved["params"]["decision"], "decline");
    assert_eq!(resolved["params"]["reason"], "timeout");
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
async fn app_server_questioner_round_trips_answers_without_ending_the_turn() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(4);
    let pending: PendingQuestionResponses = Arc::new(StdMutex::new(HashMap::new()));
    let questioner = AppServerQuestioner {
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
    assert_eq!(wire["params"]["questions"][0]["header"], "Database");
    let response_tx = pending.lock().unwrap().remove(&1_000_000).unwrap();
    response_tx
        .send(Ok(QuestionResponse {
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
    assert_eq!(resolved["params"]["reason"], "client_response");
}

#[tokio::test]
async fn app_server_questioner_reports_explicit_client_cancel_as_cancelled() {
    let (outbound_tx, mut outbound_rx) = mpsc::channel(4);
    let pending = Arc::new(StdMutex::new(HashMap::new()));
    let questioner = AppServerQuestioner {
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
    assert_eq!(resolved["params"]["reason"], "cancelled");
}
