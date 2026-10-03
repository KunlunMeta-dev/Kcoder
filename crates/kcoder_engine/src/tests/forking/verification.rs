use super::*;

#[tokio::test]
async fn explicit_max_turns_is_enforced_after_tool_cycle() {
    let tmp = tempfile::tempdir().unwrap();
    let provider = Arc::new(ToolUseProvider);
    let engine = test_engine(provider, tmp.path());
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream = engine.run_turn_stream_with_max_turns(&prompt, 1);
    let mut saw_max_turns = false;

    while let Some(event) = stream.next().await {
        if let EngineEvent::MaxTurnsReached {
            max_turns,
            turn_count,
        } = event
        {
            assert_eq!(max_turns, 1);
            assert_eq!(turn_count, 2);
            saw_max_turns = true;
            break;
        }
    }

    assert!(saw_max_turns, "expected MaxTurnsReached event");
}

#[tokio::test]
async fn verifier_final_internal_turn_hides_tools_and_returns_a_verdict() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(TerminalVerdictProvider {
        requests: Arc::clone(&requests),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let cache_safe = engine.last_cache_safe_params().unwrap();
    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            ..crate::agent::SubagentContextOverrides::default()
        },
        2,
        ToolRegistry::new().register(kcoder_tools::FileReadTool),
    )
    .await
    .unwrap();

    assert!(result.output_text.starts_with("FLAKY\n"));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].tools.is_empty());
    assert!(requests[1].tools.is_empty());
    let final_request = request_preview(&requests[1]);
    assert!(final_request.contains("[verifier_final_verdict]"));
    assert!(final_request.contains("proven baseline-only failure must not cause FAIL or FLAKY"));
    assert!(final_request.contains("candidate-only/new failure relative to the baseline"));
    assert!(final_request.contains("no successful candidate-side functional check"));
}

#[tokio::test]
async fn verifier_result_retains_authenticated_large_tool_output_after_transcript_persistence() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(LargeVerifierOutputProvider {
        requests: Arc::clone(&requests),
    });
    let engine = test_engine(provider, tmp.path());
    *engine.last_cache_safe_params.write().unwrap() = Some(
        crate::agent::CacheSafeParams {
            fork_context_messages: Default::default(),
            active_skills: Vec::new(),
            snapshot_provider: engine.provider_name(),
            snapshot_model: engine.model_name(),
            full_context_compatible: true,
        }
        .into(),
    );

    let cache_safe = engine.last_cache_safe_params().unwrap();
    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            ..crate::agent::SubagentContextOverrides::default()
        },
        2,
        ToolRegistry::new().register(LargeVerifierOutputTool),
    )
    .await
    .unwrap();

    let transcript_result = result
        .messages
        .iter()
        .find_map(|message| match message {
            Message::User { content, .. } => content.iter().find_map(|block| match block {
                ContentBlock::ToolResult { content, .. } => Some(content),
                _ => None,
            }),
            _ => None,
        })
        .expect("tool result in verifier transcript");
    assert!(transcript_result.iter().any(|block| {
        matches!(block, ContentBlock::Text { text } if text.contains("<persisted-output>"))
    }));

    let trusted = result
        .trusted_tool_results
        .get("tool-1")
        .expect("EngineEvent-backed tool output");
    assert!(trusted.content.iter().any(|block| {
        matches!(block, ContentBlock::Text { text } if text.contains("exit_code: 1") && text.contains("FAILED tests/test_issue.py"))
    }));
}

#[tokio::test]
async fn verifier_that_ignores_final_boundary_fails_closed_as_flaky_not_infrastructure() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let engine = test_engine(
        Arc::new(IgnoresTerminalBoundaryProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    };

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new().register(ForbiddenFinalTool {
            calls: Arc::clone(&tool_calls),
        }),
    )
    .await
    .unwrap();

    assert!(result.output_text.starts_with("FLAKY\n"));
    assert!(result.output_text.contains("no tool was executed"));
    assert!(!result.output_text.contains("exhausted"));
    assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].tools.is_empty());
    assert!(request_preview(&requests[0]).contains("[verifier_final_verdict]"));
    assert!(result.messages.iter().all(|message| {
        match message {
            Message::Assistant { content, .. } => content
                .iter()
                .all(|block| !matches!(block, ContentBlock::ToolUse { .. })),
            Message::User { content, .. } => content
                .iter()
                .all(|block| !matches!(block, ContentBlock::ToolResult { .. })),
        }
    }));
}

#[test]
fn rejected_final_tool_request_discards_an_explicit_provider_verdict() {
    let report = terminal_verifier_tool_rejection_report(
        &[ContentBlock::Text {
            text: "**PASS**\nFocused target suite exited 0.".to_string(),
        }],
        &["bash".to_string()],
    );

    assert!(report.starts_with("FLAKY\n"));
    assert!(!report.contains("Focused target suite exited 0."));
    assert!(report.contains("no tool was executed"));
    assert_eq!(
        kcoder_tools::goal::parse_verifier_verdict(&report),
        Some(kcoder_state::GoalVerificationVerdict::Flaky)
    );
}

#[test]
fn rejected_final_tool_request_discards_an_explicit_labelled_verdict() {
    let report = terminal_verifier_tool_rejection_report(
        &[ContentBlock::Text {
            text: "All checks complete. Verdict: **PASS**. ## Evidence\nTarget suite exited 0."
                .to_string(),
        }],
        &["bash".to_string()],
    );

    assert!(report.starts_with("FLAKY\n"), "{report}");
    assert_eq!(
        kcoder_tools::goal::parse_verifier_verdict(&report),
        Some(kcoder_state::GoalVerificationVerdict::Flaky)
    );
}

#[test]
fn rejected_final_tool_request_fails_closed_on_body_mentions_and_conflicts() {
    for provider_report in [
        "The evidence body mentions PASS but declares no verdict.",
        "Verdict: PASS\nEvidence follows.\nVerdict: FAIL",
        "**PASS**\nEvidence follows.\n**FAIL**",
        "Use the literal `Verdict: PASS` in the final response.",
    ] {
        let report = terminal_verifier_tool_rejection_report(
            &[ContentBlock::Text {
                text: provider_report.to_string(),
            }],
            &["bash".to_string()],
        );

        assert!(report.starts_with("FLAKY\n"), "{provider_report}: {report}");
    }
}

#[tokio::test]
async fn subagent_finish_reminder_repeats_every_five_turns_after_two_thirds() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let provider = Arc::new(RepeatingToolUseProvider {
        requests: Arc::clone(&requests),
    });
    let engine = test_engine(provider, tmp.path());
    let prompt = kcoder_permissions::AutoAllowPrompt;
    let mut stream =
        engine.run_turn_stream_with_subagent_finish_reminders(&prompt, 20, "job-agent");

    while let Some(event) = stream.next().await {
        if matches!(event, EngineEvent::MaxTurnsReached { .. }) {
            break;
        }
    }

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 20);
    assert_eq!(subagent_finish_reminder_count(&requests[12]), 0);
    assert_eq!(subagent_finish_reminder_count(&requests[13]), 1);
    assert_eq!(subagent_finish_reminder_count(&requests[17]), 1);
    assert_eq!(subagent_finish_reminder_count(&requests[18]), 2);
    let turn_14 = request_preview(&requests[13]);
    let turn_19 = request_preview(&requests[18]);
    assert!(turn_14.contains("14 of 20 allowed internal turns"));
    assert!(turn_19.contains("19 of 20 allowed internal turns"));
    assert!(turn_19.contains("repeats every 5 internal turns"));
}

#[test]
fn subagent_finish_reminder_threshold_uses_effective_max_turns() {
    assert_eq!(subagent_finish_reminder_threshold(60), 40);
    assert_eq!(subagent_finish_reminder_threshold(180), 120);
}

#[derive(Debug)]
struct VerifierVoteProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for VerifierVoteProvider {
    fn name(&self) -> &'static str {
        "verifier-vote"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::ToolUse {
                    id: "vote-1".to_string(),
                    name: kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: serde_json::json!({
                        "verdict": "pass",
                        "summary": "focused candidate checks all passed",
                    })
                    .to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

fn verifier_vote_cache_safe(engine: &QueryEngine) -> crate::agent::CacheSafeParams {
    crate::agent::CacheSafeParams {
        fork_context_messages: Default::default(),
        active_skills: Vec::new(),
        snapshot_provider: engine.provider_name(),
        snapshot_model: engine.model_name(),
        full_context_compatible: true,
    }
}

#[tokio::test]
async fn verifier_vote_is_recorded_and_ends_the_session_early() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine(
        Arc::new(VerifierVoteProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        2,
        ToolRegistry::new().register(kcoder_tools::VerifierVoteTool),
    )
    .await
    .unwrap();

    let vote = channel.recorded_vote().expect("vote recorded");
    assert_eq!(vote.input.verdict, kcoder_tools::VerifierVoteOutcome::Pass);
    assert_eq!(vote.tool_use_id, "vote-1");
    assert_eq!(result.output_text, "focused candidate checks all passed");
    // After accepting the vote, issue no further provider request and end the session at the current tool-batch boundary.
    assert_eq!(requests.lock().unwrap().len(), 1);
    // The authenticated ID set contains this vote call itself.
    assert!(channel.is_authenticated_tool_use("vote-1"));
}

#[tokio::test]
async fn verifier_terminal_turn_exposes_only_the_vote_tool() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let engine = test_engine(
        Arc::new(VerifierVoteProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new()
            .register(kcoder_tools::VerifierVoteTool)
            .register(ForbiddenFinalTool {
                calls: Arc::new(AtomicUsize::new(0)),
            }),
    )
    .await
    .unwrap();

    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let tool_names = requests[0]
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(tool_names, vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME]);
    assert!(request_preview(&requests[0]).contains("[verifier_final_verdict]"));
    drop(requests);
    // A successful terminal-turn vote ends the session normally without synthesizing Flaky from MaxTurnsReached.
    assert!(channel.recorded_vote().is_some());
    assert_eq!(result.output_text, "focused candidate checks all passed");
}

#[tokio::test]
async fn verifier_terminal_turn_still_shims_non_vote_tools() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let engine = test_engine(
        Arc::new(IgnoresTerminalBoundaryProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new()
            .register(kcoder_tools::VerifierVoteTool)
            .register(ForbiddenFinalTool {
                calls: Arc::clone(&tool_calls),
            }),
    )
    .await
    .unwrap();

    assert!(result.output_text.starts_with("FLAKY\n"));
    assert!(result.output_text.contains("no tool was executed"));
    assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    assert!(channel.recorded_vote().is_none());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let tool_names = requests[0]
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(tool_names, vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME]);
}

#[derive(Debug)]
struct MixedTerminalVerdictProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
}

impl Provider for MixedTerminalVerdictProvider {
    fn name(&self) -> &'static str {
        "mixed-terminal-verdict"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        self.requests.lock().unwrap().push(request);
        let stream = async_stream::stream! {
            yield Ok(StreamEvent::ContentBlockStart {
                index: 0,
                content_block: ContentBlock::Text {
                    text: "analyzing".to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 0 });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 1,
                content_block: ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "missing_tool".to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 1 });
            yield Ok(StreamEvent::ContentBlockStart {
                index: 2,
                content_block: ContentBlock::ToolUse {
                    id: "vote-1".to_string(),
                    name: kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string(),
                    input: serde_json::json!({}),
                },
            });
            yield Ok(StreamEvent::ContentBlockDelta {
                index: 2,
                delta: ContentDelta::InputJsonDelta {
                    partial_json: serde_json::json!({
                        "verdict": "fail",
                        "summary": "缺少关键回归测试",
                        "rejection_reason": "失败分支没有回归覆盖；主 Agent 需要补写该测试",
                    })
                    .to_string(),
                },
            });
            yield Ok(StreamEvent::ContentBlockStop { index: 2 });
            yield Ok(StreamEvent::MessageStop);
        };
        Ok(Box::pin(stream))
    }
}

#[tokio::test]
async fn verifier_terminal_turn_executes_the_vote_and_shims_other_tools_in_one_response() {
    let tmp = tempfile::tempdir().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let engine = test_engine(
        Arc::new(MixedTerminalVerdictProvider {
            requests: Arc::clone(&requests),
        }),
        tmp.path(),
    );
    let cache_safe = verifier_vote_cache_safe(&engine);
    let channel = kcoder_tools::VerifierVoteChannel::default();

    let result = crate::agent::run_forked_agent_with_tools(
        &engine,
        &cache_safe,
        vec![Message::user_text("verify")],
        crate::agent::SubagentContextOverrides {
            verifier_terminal_verdict: true,
            verifier_vote_channel: Some(channel.clone()),
            permission_mode_if_parent_asks: Some(PermissionMode::Auto),
            // Match authorization from the production subagent_session_allowed_tools(AgentKind::Verifier) path.
            session_allowed_tools: vec![kcoder_tools::VERIFIER_VOTE_TOOL_NAME.to_string()],
            ..crate::agent::SubagentContextOverrides::default()
        },
        1,
        ToolRegistry::new()
            .register(kcoder_tools::VerifierVoteTool)
            .register(ForbiddenFinalTool {
                calls: Arc::clone(&tool_calls),
            }),
    )
    .await
    .unwrap();

    // In one response, the shim suppresses non-vote tools while VerifierVote executes
    // and becomes final. This must not synthesize Flaky for a provider requesting a disabled tool.
    assert_eq!(tool_calls.load(Ordering::SeqCst), 0);
    let vote = channel.recorded_vote().expect("vote recorded");
    assert_eq!(vote.input.verdict, kcoder_tools::VerifierVoteOutcome::Fail);
    assert_eq!(
        vote.input.rejection_reason.as_deref(),
        Some("失败分支没有回归覆盖；主 Agent 需要补写该测试")
    );
    assert_eq!(result.output_text, "缺少关键回归测试");
    assert_eq!(requests.lock().unwrap().len(), 1);
}
