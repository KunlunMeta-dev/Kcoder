use super::*;
use serde_json::json;

#[test]
fn request_round_trips_as_one_jsonl_record() {
    let request = Request::new(
        7,
        method::INITIALIZE,
        InitializeParams {
            protocol_version: PROTOCOL_VERSION.into(),
            client_info: ImplementationInfo {
                name: "kcoder-studio".into(),
                version: "0.1.0".into(),
            },
            capabilities: ClientCapabilities::default(),
        },
    );

    let line = encode_line(&request).unwrap();
    assert!(line.ends_with('\n'));
    assert_eq!(line.matches('\n').count(), 1);
    assert!(line.contains("\"protocolVersion\""));
    assert_eq!(
        decode_line::<Request<InitializeParams>>(&line).unwrap(),
        request
    );
}

#[test]
fn success_and_error_responses_have_exclusive_payloads() {
    let success = Response::success("req-1", json!({ "ok": true }));
    assert_eq!(
        serde_json::to_value(success).unwrap(),
        json!({"jsonrpc":"2.0","id":"req-1","result":{"ok":true}})
    );

    let failure: Response<Value> = Response::error(
        2,
        RpcError {
            code: -32602,
            message: "invalid params".into(),
            data: None,
        },
    );
    assert_eq!(
        serde_json::to_value(failure).unwrap(),
        json!({"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"invalid params"}})
    );
}

#[test]
fn experimental_workspace_and_attachment_contracts_are_stable() {
    let workspace = Request::new(
        8,
        method::DEVICE_EXECUTE,
        DeviceExecuteParams {
            command_key: "workspace_read_text_file".into(),
            thread_id: None,
            path: Some("/workspace".into()),
            args: vec!["README.md".into()],
            max_output_bytes: Some(262_144),
            timeout_seconds: None,
            stdin: None,
            expected_revision: None,
        },
    );
    assert_eq!(
        serde_json::to_value(workspace).unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "device/execute",
            "params": {
                "command_key": "workspace_read_text_file",
                "path": "/workspace",
                "args": ["README.md"],
                "max_output_bytes": 262144
            }
        })
    );
    let thread_scoped: DeviceExecuteParams = serde_json::from_value(json!({
        "command_key": "turn_file_changes_review",
        "thread_id": "thread-a",
        "args": ["artifact-a"]
    }))
    .unwrap();
    assert_eq!(thread_scoped.thread_id.as_deref(), Some("thread-a"));
    assert_eq!(
        serde_json::to_value(thread_scoped).unwrap()["threadId"],
        "thread-a"
    );
    let attachment = AttachmentSaveParams {
        retention: None,
        filename: "notes.txt".into(),
        content_base64: "aGk=".into(),
    };
    assert_eq!(
        serde_json::to_value(attachment).unwrap(),
        json!({"filename":"notes.txt","content_base64":"aGk="})
    );
    assert_eq!(
        serde_json::to_value(Request::new(
            10,
            method::ATTACHMENT_DELETE,
            AttachmentDeleteParams {
                path: "/tmp/staged/notes.txt".into(),
            },
        ))
        .unwrap(),
        json!({"jsonrpc":"2.0","id":10,"method":"attachment/delete","params":{"path":"/tmp/staged/notes.txt"}})
    );
    let read = Request::new(
        9,
        method::ATTACHMENT_READ,
        AttachmentReadParams {
            thread_id: "thread-1".into(),
            path: "/tmp/evidence.png".into(),
        },
    );
    assert_eq!(
        serde_json::to_value(read).unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "attachment/read",
            "params": {"threadId":"thread-1","path":"/tmp/evidence.png"}
        })
    );
    assert_eq!(
        serde_json::to_value(AttachmentReadResult {
            content_base64: "aGk=".into(),
            size: 2,
        })
        .unwrap(),
        json!({"contentBase64":"aGk=","size":2})
    );
    let chunk = Request::new(
        11,
        method::ATTACHMENT_READ_CHUNK,
        AttachmentReadChunkParams {
            thread_id: "thread-1".into(),
            path: "/tmp/evidence.bin".into(),
            offset: 524_288,
            length: 524_288,
        },
    );
    assert_eq!(
        serde_json::to_value(chunk).unwrap(),
        json!({
            "jsonrpc":"2.0","id":11,"method":"attachment/read/chunk",
            "params":{"threadId":"thread-1","path":"/tmp/evidence.bin","offset":524288,"length":524288}
        })
    );
    assert_eq!(
        serde_json::to_value(AttachmentReadChunkResult {
            content_base64: "aGk=".into(),
            offset: 0,
            size: 2,
            total_size: 2,
            eof: true,
        })
        .unwrap(),
        json!({"contentBase64":"aGk=","offset":0,"size":2,"totalSize":2,"eof":true})
    );
}

#[test]
fn terminal_contract_uses_the_upstream_socket_payload_shape() {
    let request = Request::new(
        9,
        method::TERMINAL_RESIZE,
        TerminalResizeParams {
            session_id: "terminal-1".into(),
            rows: 40,
            cols: 120,
        },
    );
    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "jsonrpc":"2.0",
            "id":9,
            "method":"terminal/resize",
            "params":{"session_id":"terminal-1","rows":40,"cols":120}
        })
    );
    assert_eq!(
        serde_json::to_value(Notification::new(
            method::TERMINAL_OUTPUT,
            TerminalOutputParams {
                session_id: "terminal-1".into(),
                data: "hello\r\n".into(),
                sequence: 1,
            }
        ))
        .unwrap()["params"]["session_id"],
        "terminal-1"
    );
    assert_eq!(
        serde_json::to_value(Request::new(
            10,
            method::TERMINAL_LIST,
            TerminalListParams::default(),
        ))
        .unwrap(),
        json!({"jsonrpc":"2.0","id":10,"method":"terminal/list","params":{}})
    );
    assert_eq!(
        serde_json::to_value(Request::new(
            11,
            method::TERMINAL_ATTACH,
            TerminalAttachParams {
                session_id: "terminal-1".into(),
                rows: 30,
                cols: 100,
            },
        ))
        .unwrap(),
        json!({
            "jsonrpc":"2.0",
            "id":11,
            "method":"terminal/attach",
            "params":{"session_id":"terminal-1","rows":30,"cols":100}
        })
    );
}

#[test]
fn browser_contract_has_typed_methods_actions_and_frames() {
    let start = Request::new(
        10,
        method::BROWSER_START,
        BrowserStartParams {
            url: "http://127.0.0.1:4173/".into(),
            width: 1280,
            height: 720,
        },
    );
    assert_eq!(
        serde_json::to_value(start).unwrap(),
        json!({
            "jsonrpc":"2.0",
            "id":10,
            "method":"browser/start",
            "params":{"url":"http://127.0.0.1:4173/","width":1280,"height":720}
        })
    );

    let pointer = BrowserActionParams {
        session_id: "browser-1".into(),
        action: BrowserAction::PointerDown { x: 12.5, y: 24.0 },
    };
    let value = serde_json::to_value(&pointer).unwrap();
    assert_eq!(
        value,
        json!({"session_id":"browser-1","action":"pointer_down","x":12.5,"y":24.0})
    );
    assert_eq!(
        serde_json::from_value::<BrowserActionParams>(value).unwrap(),
        pointer
    );
    assert_eq!(
        serde_json::to_value(BrowserActionParams {
            session_id: "browser-1".into(),
            action: BrowserAction::Shortcut {
                key: "a".into(),
                modifiers: vec!["Control".into()],
            },
        })
        .unwrap(),
        json!({"session_id":"browser-1","action":"shortcut","key":"a","modifiers":["Control"]})
    );

    let frame = BrowserScreenshotResult {
        session_id: "browser-1".into(),
        data_base64: "/9j/".into(),
        mime_type: "image/jpeg".into(),
        width: 800,
        height: 600,
        page: BrowserPageState {
            url: "https://example.com/".into(),
            title: Some("Example".into()),
            favicon_url: Some("https://example.com/favicon.ico".into()),
            can_go_back: Some(true),
            can_go_forward: Some(false),
        },
    };
    let value = serde_json::to_value(frame).unwrap();
    assert_eq!(
        value["page"]["faviconUrl"],
        "https://example.com/favicon.ico"
    );
    assert_eq!(value["page"]["canGoBack"], true);
    assert_eq!(value["page"]["canGoForward"], false);
    assert_eq!(value["data_base64"], "/9j/");
}

#[test]
fn message_distinguishes_requests_notifications_and_responses() {
    let request =
        decode_line::<Message>(r#"{"jsonrpc":"2.0","id":1,"method":"thread/list","params":{}}"#)
            .unwrap();
    assert!(matches!(request, Message::Request(_)));

    let notification =
        decode_line::<Message>(r#"{"jsonrpc":"2.0","method":"turn/started","params":{}}"#).unwrap();
    assert!(matches!(notification, Message::Notification(_)));

    let response =
        decode_line::<Message>(r#"{"jsonrpc":"2.0","id":1,"result":{"threads":[]}}"#).unwrap();
    assert!(matches!(response, Message::Response(_)));
}

#[test]
fn item_delta_carries_server_routing_and_sequence() {
    let notification = Notification::new(
        method::ITEM_DELTA,
        ItemDeltaParams {
            context: EventContext {
                server_id: "server-a".into(),
                thread_id: "thread-1".into(),
                turn_id: Some("turn-1".into()),
                sequence: 9,
            },
            item_id: "item-2".into(),
            delta: json!({"text":"hello"}),
        },
    );

    let value = serde_json::to_value(notification).unwrap();
    assert_eq!(value["params"]["serverId"], "server-a");
    assert_eq!(value["params"]["sequence"], 9);
    assert_eq!(value["params"]["itemId"], "item-2");
}

#[test]
fn approval_and_question_are_server_requests() {
    let approval = Request::new(
        "approval-rpc-1",
        method::APPROVAL_REQUEST,
        ApprovalRequestParams {
            server_id: "server-a".into(),
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            approval_id: "approval-1".into(),
            action: ApprovalAction::Command {
                command: "cargo test".into(),
            },
            reason: "run tests".into(),
        },
    );
    assert_eq!(
        serde_json::to_value(approval).unwrap()["params"]["action"]["type"],
        "command"
    );

    let question = QuestionRequestParams {
        source_agent: None,
        server_id: "server-a".into(),
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
        question_id: "question-1".into(),
        questions: vec![Question {
            id: "database".into(),
            header: "Database".into(),
            prompt: "Which database?".into(),
            options: vec![QuestionOption {
                label: "SQLite".into(),
                value: "sqlite".into(),
                description: "Keep state local.".into(),
                preview: None,
            }],
            allows_freeform: true,
            multi_select: false,
        }],
        annotations: None,
    };
    let line = encode_line(&Request::new(12, method::QUESTION_REQUEST, question)).unwrap();
    assert!(line.contains("\"allowsFreeform\":true"));

    assert_eq!(
        serde_json::to_value(Notification::new(
            method::QUESTION_RESOLVED,
            QuestionResolvedParams {
                request_id: 12,
                question_id: "question-12".into(),
                thread_id: "thread-1".into(),
                turn_id: "turn-1".into(),
                reason: "client_response".into(),
            },
        ))
        .unwrap()["method"],
        "question/resolved"
    );

    assert_eq!(
        serde_json::to_value(Notification::new(
            method::APPROVAL_RESOLVED,
            ApprovalResolvedParams {
                request_id: 11,
                approval_id: "approval-11".into(),
                thread_id: "thread-1".into(),
                turn_id: "turn-1".into(),
                decision: ApprovalDecision::Decline,
                reason: "timeout".into(),
            },
        ))
        .unwrap(),
        json!({
            "jsonrpc": "2.0",
            "method": "approval/resolved",
            "params": {
                "requestId": 11,
                "approvalId": "approval-11",
                "threadId": "thread-1",
                "turnId": "turn-1",
                "decision": "decline",
                "reason": "timeout"
            }
        })
    );
}

#[test]
fn codec_rejects_empty_and_multiple_records() {
    assert!(matches!(
        decode_line::<Value>("\r\n"),
        Err(CodecError::EmptyLine)
    ));
    assert!(matches!(
        decode_line::<Value>("{}\n{}\n"),
        Err(CodecError::EmbeddedNewline)
    ));
}

#[test]
fn all_mvp_method_types_serialize() {
    let thread = Thread {
        model_selection_mode: None,
        selected_model: None,
        session_mode: None,
        workflow_definition_id: None,
        id: "thread-1".into(),
        status: ThreadStatus::Idle,
        run_summary: None,
        title: None,
        cwd: Some("/workspace".into()),
        model: Some("model-a".into()),
        archived_at: None,
        parent: None,
        metadata: ThreadMetadata {
            workflow_definition_id: None,
            schema: "kcoder.thread-metadata".into(),
            version: 1,
            revision: 0,
            title: None,
            model: None,
            archived_at: None,
            parent: None,
        },
        settings_template: None,
        created_at: "2026-07-27T00:00:00Z".into(),
        updated_at: "2026-07-27T00:00:00Z".into(),
    };
    serde_json::to_value(ThreadStartResult {
        thread: thread.clone(),
    })
    .unwrap();
    serde_json::to_value(ThreadListParams {
        allow_partial: None,
        cursor: None,
        limit: Some(20),
        archived: Some(false),
        query: Some("workspace".into()),
    })
    .map(|value| {
        assert_eq!(value["archived"], false);
        assert_eq!(value["query"], "workspace");
    })
    .unwrap();
    serde_json::to_value(ThreadListResult {
        threads: vec![thread.clone()],
        next_cursor: None,
        completeness: None,
        issue_count: None,
    })
    .unwrap();
    let update: ThreadMetadataUpdateParams = serde_json::from_value(serde_json::json!({
        "threadId": "thread-1",
        "title": "新的标题",
        "archivedAt": null
    }))
    .unwrap();
    assert_eq!(update.title, MetadataUpdate::Set("新的标题".into()));
    assert_eq!(update.model, MetadataUpdate::Unchanged);
    assert_eq!(update.archived_at, MetadataUpdate::Clear);
    let wire = serde_json::to_value(update).unwrap();
    assert_eq!(wire["title"], "新的标题");
    assert!(wire["archivedAt"].is_null());
    assert!(wire.get("model").is_none());
    serde_json::to_value(ThreadResumeParams {
        history: None,
        thread_id: thread.id.clone(),
    })
    .unwrap();
    serde_json::to_value(ThreadResumeResult {
        thread,
        history: None,
    })
    .unwrap();
    let turn_start = serde_json::to_value(TurnStartParams {
        retention: None,
        computer_use: None,
        retry_model_configuration: None,
        model_selection_mode: None,
        retry_from_turn_id: None,
        retry_from_attempt_id: None,
        turn_mode: None,
        thread_id: "thread-1".into(),
        permission_mode: None,
        input: vec![UserInput::Text {
            text: "hello".into(),
        }],
        client_message_id: Some("client-message-1".into()),
        resubmit: Some(true),
        retry_operation_id: Some("retry:thread-1:turn-1".into()),
        model: None,
        reasoning_effort: Some("high".into()),
        proxy_url: Some("http://127.0.0.1:7890".into()),
        service_tier: Some("priority".into()),
    })
    .unwrap();
    // The recovery identity has to survive the wire as a named operation, not
    // as a bare transport id.
    assert_eq!(turn_start["retryOperationId"], "retry:thread-1:turn-1");
    serde_json::to_value(TurnInterruptParams {
        thread_id: "thread-1".into(),
        turn_id: "turn-1".into(),
    })
    .unwrap();
}

#[test]
fn thread_operation_contracts_use_stable_camel_case_shapes() {
    assert_eq!(
        serde_json::to_value(Request::new(
            19,
            method::THREAD_FORK,
            ThreadForkParams {
                thread_id: "thread-1".into(),
                last_turn_id: "turn-2".into(),
                ephemeral: false,
                cwd: Some("/workspace".into()),
                exclude_turns: true,
            },
        ))
        .unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 19,
            "method": "thread/fork",
            "params": {
                "threadId": "thread-1",
                "lastTurnId": "turn-2",
                "cwd": "/workspace",
                "excludeTurns": true
            }
        })
    );
    assert_eq!(
        serde_json::to_value(Request::new(
            20,
            method::THREAD_ROLLBACK,
            ThreadRollbackParams {
                thread_id: "thread-1".into(),
                turn: Some(2),
            },
        ))
        .unwrap(),
        json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "thread/rollback",
            "params": {"threadId": "thread-1", "turn": 2}
        })
    );
    assert_eq!(
        serde_json::to_value(ThreadCompactResult {
            thread_id: "thread-1".into(),
            compacted: true,
            pre_tokens: 120,
            post_tokens: 45,
        })
        .unwrap(),
        json!({
            "threadId": "thread-1",
            "compacted": true,
            "preTokens": 120,
            "postTokens": 45
        })
    );

    let set = ThreadGoalSetParams {
        thread_id: "thread-1".into(),
        objective: Some("finish parity".into()),
        edit: false,
        expected_goal_id: None,
        expected_revision: None,
        require_no_goal: false,
        mode: Some("strict".into()),
        verification_kind: Some("answer".into()),
        status: Some("paused".into()),
        token_budget: None,
        clear_token_budget: true,
    };
    let value = serde_json::to_value(&set).unwrap();
    assert_eq!(
        value,
        json!({
            "threadId": "thread-1",
            "objective": "finish parity",
            "mode": "strict",
            "verificationKind": "answer",
            "status": "paused",
            "clearTokenBudget": true
        })
    );
    assert_eq!(
        serde_json::from_value::<ThreadGoalSetParams>(value).unwrap(),
        set
    );
    let legacy_goal = serde_json::from_value::<ThreadGoal>(json!({
        "threadId": "thread-1",
        "objective": "legacy",
        "mode": "strict",
        "status": "active",
        "tokenBudget": null,
        "tokensUsed": 0,
        "timeUsedSeconds": 0,
        "createdAt": 1,
        "updatedAt": 1
    }))
    .unwrap();
    assert_eq!(legacy_goal.verification_kind, "artifact");
    assert_eq!(
        serde_json::to_value(Request::new(
            21,
            method::THREAD_DELETE,
            ThreadDeleteParams {
                thread_id: "thread-1".into(),
            },
        ))
        .unwrap()["params"],
        json!({"threadId": "thread-1"})
    );
}

#[test]
fn failed_turn_continuation_contract_is_opt_in_and_has_no_user_input() {
    let params: TurnStartParams = serde_json::from_value(serde_json::json!({
        "threadId": "thread-1", "retryFromTurnId": "turn-1", "input": []
    }))
    .unwrap();
    assert_eq!(params.retry_from_turn_id.as_deref(), Some("turn-1"));
    assert!(params.input.is_empty());
    let old: TurnStartParams = serde_json::from_value(serde_json::json!({
        "threadId": "thread-1", "input": [{"type":"text", "text":"hello"}]
    }))
    .unwrap();
    assert!(old.retry_from_turn_id.is_none());
    assert!(
        serde_json::to_value(old)
            .unwrap()
            .get("retryFromTurnId")
            .is_none()
    );
}

#[test]
fn thread_parent_is_structured_and_accepts_studio_legacy_json_string() {
    let structured: ThreadMetadataUpdateParams = serde_json::from_value(json!({
        "threadId": "thread-child",
        "parent": {
            "taskId": "kcoder:local:thread-parent",
            "threadId": "thread-parent",
            "lastTurnId": "turn-3"
        }
    }))
    .unwrap();
    let legacy: ThreadMetadataUpdateParams = serde_json::from_value(json!({
            "threadId": "thread-child",
            "parent": "{\"taskId\":\"kcoder:local:thread-parent\",\"threadId\":\"thread-parent\",\"lastTurnId\":\"turn-3\"}"
        }))
        .unwrap();
    let expected = MetadataUpdate::Set(ThreadParent {
        task_id: "kcoder:local:thread-parent".into(),
        thread_id: "thread-parent".into(),
        last_turn_id: "turn-3".into(),
    });
    assert_eq!(structured.parent, expected);
    assert_eq!(legacy.parent, expected);
    assert_eq!(
        serde_json::to_value(structured).unwrap()["parent"],
        json!({
            "taskId": "kcoder:local:thread-parent",
            "threadId": "thread-parent",
            "lastTurnId": "turn-3"
        })
    );
}

#[test]
fn partial_thread_list_wire_round_trip_retains_opt_in_and_snapshot_status() {
    let params: ThreadListParams =
        serde_json::from_value(serde_json::json!({"allowPartial":true})).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap()["allowPartial"], true);
    let result: ThreadListResult = serde_json::from_value(serde_json::json!({
        "threads":[], "completeness":"partial", "issueCount":2
    }))
    .unwrap();
    let encoded = serde_json::to_value(result).unwrap();
    assert_eq!(encoded["completeness"], "partial");
    assert_eq!(encoded["issueCount"], 2);
}

#[test]
fn partial_thread_list_old_wire_remains_unchanged() {
    let params: ThreadListParams = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), serde_json::json!({}));
    let result: ThreadListResult =
        serde_json::from_value(serde_json::json!({"threads":[]})).unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({"threads":[]})
    );
}

#[test]
fn settings_template_wire_fields_round_trip_on_thread_types() {
    let params: ThreadStartParams = serde_json::from_value(serde_json::json!({
        "settingsTemplate": "fast-local"
    }))
    .unwrap();
    assert_eq!(params.settings_template.as_deref(), Some("fast-local"));
    assert_eq!(
        serde_json::to_value(&params).unwrap()["settingsTemplate"],
        "fast-local"
    );
    let baseline: ThreadStartParams = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(baseline.settings_template.is_none());
    assert_eq!(
        serde_json::to_value(&baseline).unwrap(),
        serde_json::json!({ "metadata": {} })
    );

    let bound: Thread = serde_json::from_value(serde_json::json!({
        "id": "thread-1",
        "status": "idle",
        "createdAt": "1",
        "updatedAt": "1",
        "settingsTemplate": { "id": "fast-local", "revisionSha256": "abc" }
    }))
    .unwrap();
    let binding = bound.settings_template.clone().expect("binding");
    assert_eq!(binding.id, "fast-local");
    assert_eq!(binding.revision_sha256, "abc");
    assert_eq!(
        serde_json::to_value(&bound).unwrap()["settingsTemplate"]["revisionSha256"],
        "abc"
    );

    let unbound: Thread = serde_json::from_value(serde_json::json!({
        "id": "thread-1",
        "status": "idle",
        "createdAt": "1",
        "updatedAt": "1"
    }))
    .unwrap();
    assert!(unbound.settings_template.is_none());
    assert!(
        serde_json::to_value(&unbound)
            .unwrap()
            .get("settingsTemplate")
            .is_none()
    );
}

fn run_facts() -> ThreadRunFacts {
    ThreadRunFacts {
        main_turn_running: Some(false),
        pending_approvals: Some(0),
        pending_questions: Some(0),
        active_jobs: Some(0),
        tasks_pending: Some(0),
        tasks_running: Some(0),
        pending_followups: Some(0),
        pending_goals: Some(0),
    }
}

#[test]
fn thread_run_state_prefers_pending_interaction_over_running_turn() {
    let facts = ThreadRunFacts {
        main_turn_running: Some(true),
        pending_approvals: Some(1),
        ..run_facts()
    };
    assert_eq!(facts.state(), ThreadStatus::WaitingForApproval);

    let facts = ThreadRunFacts {
        main_turn_running: Some(true),
        pending_questions: Some(2),
        ..run_facts()
    };
    assert_eq!(facts.state(), ThreadStatus::WaitingForAnswer);
}

#[test]
fn thread_run_state_runs_only_while_the_main_turn_is_working() {
    let facts = ThreadRunFacts {
        main_turn_running: Some(true),
        ..run_facts()
    };
    assert_eq!(facts.state(), ThreadStatus::Running);
}

#[test]
fn thread_run_state_marks_background_work_after_the_main_turn_ends() {
    for facts in [
        ThreadRunFacts {
            active_jobs: Some(1),
            ..run_facts()
        },
        ThreadRunFacts {
            tasks_running: Some(2),
            ..run_facts()
        },
        ThreadRunFacts {
            tasks_pending: Some(1),
            ..run_facts()
        },
        ThreadRunFacts {
            pending_goals: Some(1),
            ..run_facts()
        },
    ] {
        assert_eq!(facts.state(), ThreadStatus::Background);
    }
}

#[test]
fn thread_run_state_marks_aggregation_when_only_delivery_is_pending() {
    let facts = ThreadRunFacts {
        pending_followups: Some(3),
        ..run_facts()
    };
    assert_eq!(facts.state(), ThreadStatus::Aggregating);
}

#[test]
fn thread_run_state_is_idle_only_when_every_fact_is_readable_and_clear() {
    assert_eq!(run_facts().state(), ThreadStatus::Idle);

    // A known pending fact still wins when other facts are unreadable.
    let facts = ThreadRunFacts {
        pending_questions: None,
        pending_approvals: None,
        tasks_running: Some(1),
        ..run_facts()
    };
    assert_eq!(facts.state(), ThreadStatus::Background);

    // Unknowns never collapse into a confident idle.
    let facts = ThreadRunFacts {
        main_turn_running: None,
        ..run_facts()
    };
    assert_eq!(facts.state(), ThreadStatus::Unknown);

    assert_eq!(ThreadRunFacts::default().state(), ThreadStatus::Unknown);
}

#[test]
fn thread_run_summary_serializes_unknown_facts_as_explicit_nulls() {
    let facts = ThreadRunFacts {
        main_turn_running: None,
        pending_approvals: Some(0),
        pending_questions: None,
        active_jobs: Some(2),
        tasks_pending: None,
        tasks_running: Some(0),
        pending_followups: None,
        pending_goals: Some(0),
    };
    assert_eq!(
        serde_json::to_value(facts.summary()).unwrap(),
        json!({
            "mainTurn": "unknown",
            "pendingApprovals": 0,
            "pendingQuestions": null,
            "activeJobs": 2,
            "tasksPending": null,
            "tasksRunning": 0,
            "pendingFollowups": null,
            "pendingGoals": 0
        })
    );
    assert_eq!(facts.summary().main_turn, ThreadMainTurn::Unknown);
}

#[test]
fn turn_submission_declares_a_deliberate_resubmission() {
    let declared: TurnStartParams = serde_json::from_value(json!({
        "threadId": "thread-1",
        "input": [{"type": "text", "text": "hello"}],
        "clientMessageId": "client-1",
        "resubmit": true
    }))
    .unwrap();
    assert_eq!(declared.resubmit, Some(true));
    assert_eq!(
        serde_json::to_value(&declared).unwrap()["resubmit"],
        json!(true)
    );

    // A first submission omits the field entirely instead of sending false.
    let first: TurnStartParams = serde_json::from_value(json!({
        "threadId": "thread-1",
        "input": [{"type": "text", "text": "hello"}],
        "clientMessageId": "client-1"
    }))
    .unwrap();
    assert_eq!(first.resubmit, None);
    assert!(
        serde_json::to_value(&first)
            .unwrap()
            .get("resubmit")
            .is_none()
    );
}

#[test]
fn thread_status_wire_values_keep_snake_case_for_every_projection() {
    for (status, wire) in [
        (ThreadStatus::Idle, "idle"),
        (ThreadStatus::Running, "running"),
        (ThreadStatus::WaitingForApproval, "waiting_for_approval"),
        (ThreadStatus::WaitingForAnswer, "waiting_for_answer"),
        (ThreadStatus::Background, "background"),
        (ThreadStatus::Aggregating, "aggregating"),
        (ThreadStatus::Unknown, "unknown"),
        (ThreadStatus::Failed, "failed"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), json!(wire));
    }
}

#[test]
fn thread_omits_run_summary_unless_the_consumer_negotiated_it() {
    let legacy: Thread = serde_json::from_value(json!({
        "id": "thread-1",
        "status": "idle",
        "createdAt": "1",
        "updatedAt": "1"
    }))
    .unwrap();
    assert!(legacy.run_summary.is_none());
    assert!(
        serde_json::to_value(&legacy)
            .unwrap()
            .get("runSummary")
            .is_none()
    );

    let negotiated = Thread {
        run_summary: Some(run_facts().summary()),
        ..legacy
    };
    assert_eq!(
        serde_json::to_value(negotiated)
            .unwrap()
            .get("runSummary")
            .unwrap()
            .get("mainTurn")
            .unwrap(),
        &json!("idle")
    );
}

#[test]
fn thread_metadata_serializes_cleared_fields_as_explicit_nulls() {
    let metadata = ThreadMetadata {
        workflow_definition_id: None,
        schema: "kcoder.thread-metadata".into(),
        version: 1,
        revision: 7,
        title: None,
        model: None,
        archived_at: None,
        parent: None,
    };
    assert_eq!(
        serde_json::to_value(metadata).unwrap(),
        json!({
            "schema": "kcoder.thread-metadata",
            "version": 1,
            "revision": 7,
            "title": null,
            "model": null,
            "archivedAt": null,
            "parent": null
        })
    );
}
