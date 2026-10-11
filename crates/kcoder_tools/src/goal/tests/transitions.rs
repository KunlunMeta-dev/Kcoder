use super::*;

#[tokio::test]
async fn create_goal_reports_storage_failure_without_activating_memory_only_goal() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    state.with_history_path(root.path().join("goal.jsonl"));
    let sidecar = state.session_state_path().unwrap();
    std::fs::remove_file(&sidecar).unwrap();
    std::fs::create_dir(&sidecar).unwrap();
    let ctx = ToolContext::new(state);
    let error = CreateGoalTool
        .call(serde_json::json!({"objective":"must be durable"}), &ctx)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("persistence failed"));
    assert!(ctx.state.goal().is_none());
}

#[tokio::test]
async fn create_goal_refuses_unfinished_existing_goal() {
    let ctx = ToolContext::new(AppState::new("/"));
    let tool = CreateGoalTool;

    let first = tool
        .call(
            serde_json::json!({"objective": "ship it", "token_budget": 1000}),
            &ctx,
        )
        .await
        .unwrap();
    assert!(!first.is_error);

    let second = tool
        .call(serde_json::json!({"objective": "replace it"}), &ctx)
        .await
        .unwrap();
    let text = match &second.content[0] {
        kcoder_types::ContentBlock::Text { text } => text,
        _ => panic!("expected text response"),
    };
    assert!(text.contains("\"success\":false"));
}

#[tokio::test]
async fn update_goal_only_exposes_complete_or_blocked() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);

    let tool = UpdateGoalTool;
    tool.call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_rejects_paused_goal_without_overwriting_it() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.update_goal_status(GoalStatus::Paused);

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Paused);
}

#[tokio::test]
async fn update_goal_accepts_final_verdict_from_budget_limited_goal() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", Some(10));
    ctx.state.account_active_goal_usage(11, 0);
    ctx.state
        .update_active_goal_status(GoalStatus::BudgetLimited);

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_accepts_blocked_verdict_from_budget_limited_goal() {
    let ctx = ToolContext::new(AppState::new("/"));
    let goal = ctx.state.set_goal("finish", Some(10));

    let mut output = None;
    for attempt in 0..3 {
        ctx.state.record_goal_turn_start(&goal.goal_id).unwrap();
        if attempt == 2 {
            ctx.state.account_active_goal_usage(11, 0);
            ctx.state
                .update_active_goal_status(GoalStatus::BudgetLimited);
        }
        output = Some(
            UpdateGoalTool
                .call(
                    serde_json::json!({"status": "blocked", "reason": "external API unavailable"}),
                    &ctx,
                )
                .await
                .unwrap(),
        );
    }
    let output = output.unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Blocked);
}

#[tokio::test]
async fn blocked_verdict_requires_same_reason_across_three_goal_turns() {
    let ctx = ToolContext::new(AppState::new("/"));
    let goal = ctx.state.set_goal("finish", None);

    for expected in 1..=2 {
        ctx.state.record_goal_turn_start(&goal.goal_id).unwrap();
        let output = UpdateGoalTool
            .call(
                serde_json::json!({"status": "blocked", "reason": "api unavailable"}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(output.is_error);
        assert_eq!(ctx.state.goal().unwrap().blocked_candidate_count, expected);
    }

    ctx.state.record_goal_turn_start(&goal.goal_id).unwrap();
    let output = UpdateGoalTool
        .call(
            serde_json::json!({"status": "blocked", "reason": "api unavailable"}),
            &ctx,
        )
        .await
        .unwrap();
    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Blocked);
}

#[tokio::test]
async fn blocked_audit_stable_id_has_bounded_diagnostics_and_cannot_cancel() {
    let ctx = ToolContext::new(AppState::new("/"));
    let goal = ctx.state.set_goal("ship", None);
    for (index, reason) in [
        "waiting for account access",
        "account access still absent",
        "account access not restored",
    ]
    .iter()
    .enumerate()
    {
        ctx.state.record_goal_turn_start(&goal.goal_id).unwrap();
        let output = UpdateGoalTool.call(serde_json::json!({"status":"blocked", "blocker_id":"account-access", "reason":reason}), &ctx).await.unwrap();
        assert_eq!(output.is_error, index < 2);
        let goal = ctx.state.goal().unwrap();
        assert_eq!(goal.blocked_candidate_count, index as u32 + 1);
        assert_eq!(goal.blocked_candidate_id.as_deref(), Some("account-access"));
        assert_eq!(goal.blocked_candidate_reason.as_deref(), Some(*reason));
    }
    assert!(
        UpdateGoalTool
            .call(serde_json::json!({"status":"cancelled"}), &ctx)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn blocked_audit_without_id_does_not_guess_equivalent_reasons() {
    let ctx = ToolContext::new(AppState::new("/"));
    let goal = ctx.state.set_goal("ship", None);
    for reason in ["API unavailable", "api unavailable", "API unavailable!"] {
        ctx.state.record_goal_turn_start(&goal.goal_id).unwrap();
        assert!(
            UpdateGoalTool
                .call(
                    serde_json::json!({"status":"blocked", "reason":reason}),
                    &ctx
                )
                .await
                .unwrap()
                .is_error
        );
        assert_eq!(ctx.state.goal().unwrap().blocked_candidate_count, 1);
    }
}

#[tokio::test]
async fn blocked_verdict_requires_a_reason() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "blocked"}), &ctx)
        .await;
    assert!(matches!(output, Err(ToolError::InvalidInput(_))));
}

#[tokio::test]
async fn verifier_infrastructure_reason_never_accumulates_blocked_candidates() {
    let state = AppState::new("/");
    let goal = state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
    let ctx = ToolContext::new(state);

    for _ in 0..3 {
        ctx.state.record_goal_turn_start(&goal.goal_id).unwrap();
        let output = UpdateGoalTool
            .call(
                serde_json::json!({
                    "status": "blocked",
                    "reason": "verifier infrastructure reached maximum turns"
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(output.is_error);
        let current = ctx.state.goal().unwrap();
        assert_eq!(current.status, GoalStatus::Active);
        assert_eq!(current.blocked_candidate_count, 0);
    }

    for reason in [
        "The blocker is purely on the verification side: maximum turns was reached.",
        "No progress is possible on the verification side without external infrastructure changes.",
        "验证基础设施反复超时，无法继续。",
    ] {
        let output = UpdateGoalTool
            .call(
                serde_json::json!({"status": "blocked", "reason": reason}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(output.is_error, "reason: {reason}");
        assert_eq!(ctx.state.goal().unwrap().blocked_candidate_count, 0);
    }
}

#[tokio::test]
async fn update_goal_rejects_verdict_from_terminal_goal() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.update_active_goal_status(GoalStatus::Complete);

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "blocked"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_rejects_masked_failure_completion_even_when_budget_limited() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", Some(10));
    ctx.state.account_active_goal_usage(11, 0);
    ctx.state
        .update_active_goal_status(GoalStatus::BudgetLimited);
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "tool-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "stdout:\nTraceback (most recent call last):\nAssertionError\n".to_string(),
            }],
            is_error: Some(false),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::BudgetLimited);
}

#[tokio::test]
async fn update_goal_rejects_completion_after_recent_masked_failure() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "tool-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "stdout:\nTraceback (most recent call last):\nAssertionError\n".to_string(),
            }],
            is_error: Some(false),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Active);
}

#[tokio::test]
async fn update_goal_allows_successful_shell_with_expected_failures() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-old".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "python bin/test assumptions"}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-old".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 0\nfailure_evidence: FAILED, AssertionError\n".to_string(),
            }],
            is_error: Some(true),
        }],
    });
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-1".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "python bin/test assumptions"}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown, content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 0\nstdout:\ntest_issue_6275 FAILED\nTraceback (most recent call last):\nAssertionError\n3 expected failures\n"
                    .to_string(),
            }],
            is_error: Some(false),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_allows_successful_python_module_test_through_env_wrapper() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-old".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 0\nfailure_evidence: FAILED\n".to_string(),
            }],
            is_error: Some(true),
        }],
    });
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-test".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({
                "command": "env -u PYTHONPATH python -m pytest tests/checkers -q"
            }),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-test".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 0\nstdout:\n20 passed\n".to_string(),
            }],
            is_error: Some(false),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_does_not_clear_failure_with_non_verification_shell_success() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-failed".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "cargo test"}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-failed".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 1\nAssertionError\n".to_string(),
            }],
            is_error: Some(true),
        }],
    });
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-status".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "git status --short"}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-status".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 0\nstdout:\n M src/lib.rs\n".to_string(),
            }],
            is_error: Some(false),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Active);
}

#[tokio::test]
async fn update_goal_ignores_nonzero_exit_from_non_verification_shell() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-grep".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({
                "command": "grep -rn 'py:class' sphinx/util/typing.py"
            }),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-grep".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 1\n(no output)\n".to_string(),
            }],
            is_error: Some(true),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_rejects_nonzero_exit_from_verification_shell_without_output() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-test".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "cargo test"}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-test".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 1\n(no output)\n".to_string(),
            }],
            is_error: Some(true),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Active);
}

#[tokio::test]
async fn update_goal_rejects_nonzero_exit_from_other_shell_commands() {
    for command in ["git diff --check", "ls /missing", "find /missing -print"] {
        let ctx = ToolContext::new(AppState::new("/"));
        ctx.state.set_goal("finish", None);
        ctx.state.add_message(Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "bash-check".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": command}),
            }],
            usage: None,
        });
        ctx.state.add_message(Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "bash-check".to_string(),
                content: vec![ContentBlock::Text {
                    text: "exit_code: 1\nworkdir: /\nworkdir_scope: invocation_only\n(no output)"
                        .to_string(),
                }],
                is_error: Some(true),
            }],
        });

        let output = UpdateGoalTool
            .call(serde_json::json!({"status": "complete"}), &ctx)
            .await
            .unwrap();

        assert!(output.is_error, "command: {command}");
        assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Active);
    }
}

#[tokio::test]
async fn update_goal_rejects_grep_exit_one_when_it_has_stderr_or_shell_control() {
    for (command, result) in [
        (
            "grep needle missing.txt",
            "exit_code: 1\nworkdir: /\nworkdir_scope: invocation_only\nstderr:\ngrep: missing.txt: No such file",
        ),
        (
            "grep needle file.txt; echo $?",
            "exit_code: 1\nworkdir: /\nworkdir_scope: invocation_only\n(no output)",
        ),
    ] {
        let ctx = ToolContext::new(AppState::new("/"));
        ctx.state.set_goal("finish", None);
        ctx.state.add_message(Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "bash-grep".to_string(),
                name: "bash".to_string(),
                input: serde_json::json!({"command": command}),
            }],
            usage: None,
        });
        ctx.state.add_message(Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "bash-grep".to_string(),
                content: vec![ContentBlock::Text {
                    text: result.to_string(),
                }],
                is_error: Some(true),
            }],
        });

        let output = UpdateGoalTool
            .call(serde_json::json!({"status": "complete"}), &ctx)
            .await
            .unwrap();

        assert!(output.is_error, "command: {command}");
    }
}

#[tokio::test]
async fn update_goal_allows_successful_background_test_with_expected_failures() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-old".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 0\nfailure_evidence: FAILED, AssertionError\n".to_string(),
            }],
            is_error: Some(true),
        }],
    });
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "task-output-1".to_string(),
            name: "TaskOutput".to_string(),
            input: serde_json::json!({"task_id": "job-test", "block": true}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown, content: vec![ContentBlock::ToolResult {
            tool_use_id: "task-output-1".to_string(),
            content: vec![ContentBlock::Text {
                text: serde_json::json!({
                    "retrieval_status": "success",
                    "task": {
                        "task_type": "bash",
                        "status": "completed",
                        "description": "tool-background:bash: python bin/test assumptions",
                        "output": "exit_code: 0\nstdout:\ntest_issue_6275 FAILED\nTraceback (most recent call last):\nAssertionError\n3 expected failures\n"
                    }
                })
                .to_string(),
            }],
            is_error: Some(false),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[test]
fn background_shell_success_requires_completed_status_and_preserves_verification_kind() {
    let ordinary = serde_json::json!({
        "retrieval_status": "success",
        "task": {
            "task_type": "bash",
            "status": "completed",
            "description": "tool-background:bash: git status --short",
            "output": "exit_code: 0\nstdout:\n M src/lib.rs\n"
        }
    })
    .to_string();
    assert_eq!(
        successful_background_shell_result(Some("TaskOutput"), Some(false), &ordinary),
        Some(false)
    );

    let failed = ordinary.replace("\"completed\"", "\"failed\"");
    assert_eq!(
        successful_background_shell_result(Some("TaskOutput"), Some(false), &failed),
        None
    );
}

#[tokio::test]
async fn update_goal_ignores_prior_update_goal_rejection() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("finish", None);
    ctx.state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "goal-1".to_string(),
            name: "update_goal".to_string(),
            input: serde_json::json!({"status": "complete"}),
        }],
        usage: None,
    });
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown, content: vec![ContentBlock::ToolResult {
            tool_use_id: "goal-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "Goal completion rejected because recent tool output still contains failure evidence: tool_result.is_error=true; preview: old failure"
                    .to_string(),
            }],
            is_error: Some(true),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn update_goal_allows_expected_tool_error_without_failure_pattern() {
    let ctx = ToolContext::new(AppState::new("/"));
    ctx.state.set_goal("test read tool", None);
    ctx.state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "read-1".to_string(),
            content: vec![ContentBlock::Text {
                text: "/tmp/docs is a directory, not a file".to_string(),
            }],
            is_error: Some(true),
        }],
    });

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}
