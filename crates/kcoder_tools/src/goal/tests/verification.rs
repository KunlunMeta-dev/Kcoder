use super::*;

#[tokio::test]
async fn strict_complete_runs_verifier_with_goal_context_before_updating() {
    let state = AppState::new("/");
    state.set_goal_prepared_with_mode("finish the remaining work", None, None, GoalMode::Strict);
    state.set_goal_context_snapshot(Some("此前目标：修复 token 刷新并运行登录测试".to_string()));
    let prompts = Arc::new(Mutex::new(Vec::new()));
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
        output: Ok("PASS\n登录测试和回归测试均通过".to_string()),
        prompts: prompts.clone(),
    }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
    let prompt = prompts.lock().unwrap().join("\n");
    assert!(prompt.contains("Original objective: finish the remaining work"));
    assert!(prompt.contains("此前目标：修复 token 刷新并运行登录测试"));
}

#[tokio::test]
async fn strict_complete_accepts_first_line_markdown_and_explained_verdicts() {
    for verifier_output in [
        "**PASS**\nFocused regression test passed.",
        "PASS: focused regression test passed.",
        "PASS — focused regression test passed.",
        "**PASS**: Focused regression test passed.",
        "Let me verify the patch first.\n\n**PASS**\nFocused regression test passed.",
        "# Verifier Report\n\n**PASS**\nFocused regression test passed.",
        "All checks complete. Verdict: **PASS**. ## Evidence\nFocused regression test passed.",
    ] {
        let state = AppState::new("/");
        state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
        let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
            output: Ok(verifier_output.to_string()),
            prompts: Arc::new(Mutex::new(Vec::new())),
        }));

        let output = UpdateGoalTool
            .call(serde_json::json!({"status": "complete"}), &ctx)
            .await
            .unwrap();

        assert!(!output.is_error, "verifier output: {verifier_output}");
        assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
    }
}

#[test]
fn verifier_verdict_parser_accepts_explicit_label_variants() {
    for (report, expected) in [
        (
            "All checks complete. Verdict: **PASS**. ## Evidence\npytest exited 0.",
            GoalVerificationVerdict::Pass,
        ),
        (
            "## Verdict: __FAIL__\nA production path is still incomplete.",
            GoalVerificationVerdict::Fail,
        ),
        (
            "Verdict: FLAKY\nThe required dependency is unavailable.",
            GoalVerificationVerdict::Flaky,
        ),
        (
            "All checks complete. **Verdict: PASS**\npytest exited 0.",
            GoalVerificationVerdict::Pass,
        ),
    ] {
        assert_eq!(
            parse_verifier_verdict(report),
            Some(expected),
            "report: {report}"
        );
    }
}

#[test]
fn verifier_verdict_parser_rejects_body_mentions_and_conflicts() {
    for report in [
        "The report body mentions PASS, but does not declare a verdict.",
        "PASS appears in the test output, but no verdict was declared.",
        "Evidence: pytest printed PASS while collecting tests.",
        "**PASS** means the command completed successfully.",
        "Use the literal `Verdict: PASS` in the final response.",
        "Verdict: **PASS**\nEvidence follows.\nVerdict: FAIL",
        "All checks complete. Verdict: PASS or FAIL.",
        "PASS or FAIL\nVerdict: PASS",
        "```text\nVerdict: PASS\n```\nNo verdict was declared.",
        "Example:\n    Verdict: PASS",
        "Example:\n\tVerdict: PASS",
    ] {
        assert_eq!(parse_verifier_verdict(report), None, "report: {report}");
    }
}

#[test]
fn verifier_verdict_parser_tracks_markdown_fence_kind_and_width() {
    for report in [
        "````text\nexample\n```\nVerdict: PASS\n````",
        "```text\nexample\n~~~\nVerdict: PASS\n```",
        "~~~~text\nexample\n~~~\nVerdict: PASS\n~~~~",
    ] {
        assert_eq!(parse_verifier_verdict(report), None, "report: {report}");
    }

    for report in [
        "````text\nVerdict: FAIL\n````\nVerdict: PASS",
        "```text\nVerdict: FAIL\n````\nVerdict: PASS",
        "  ~~~text\nVerdict: FAIL\n  ~~~\nVerdict: PASS",
    ] {
        assert_eq!(
            parse_verifier_verdict(report),
            Some(GoalVerificationVerdict::Pass),
            "report: {report}"
        );
    }
}

#[tokio::test]
async fn strict_complete_accepts_fail_after_harmless_preamble_as_semantic_rejection() {
    let state = AppState::new("/");
    state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
        output: Ok(
            "I'll start by reading the issue and diff.\n\nFAIL\nThe command-line client path is missing."
                .to_string(),
        ),
        prompts: Arc::new(Mutex::new(Vec::new())),
    }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let rejection = ctx
        .state
        .goal()
        .unwrap()
        .latest_verification_rejection()
        .unwrap()
        .summary
        .clone();
    assert!(rejection.starts_with("verdict=fail:"), "{rejection}");
}

#[tokio::test]
async fn strict_completion_blocks_at_rejection_limit_and_reports_the_terminal_state() {
    let state = AppState::new("/");
    let selection = kcoder_state::GoalVerifierSelection {
        completion_rejection_limit: Some(2),
        ..Default::default()
    };
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            selection,
        )
        .unwrap();
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(SequenceVerifier {
        outputs: Mutex::new(VecDeque::from([
            Ok("FAIL\nfirst semantic rejection".to_string()),
            Ok("FLAKY\nsecond semantic rejection".to_string()),
        ])),
        prompts: Arc::new(Mutex::new(Vec::new())),
    }));

    let first = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();
    assert!(first.is_error);
    assert!(content_blocks_text(&first.content).contains("remains active"));
    assert_eq!(
        ctx.state.goal().unwrap().semantic_completion_rejected_count,
        1
    );

    let second = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();
    let text = content_blocks_text(&second.content);
    assert!(second.is_error);
    assert!(
        text.contains("semantic completion rejection limit (2/2)"),
        "{text}"
    );
    assert!(text.contains("automatically blocked"), "{text}");
    assert!(!text.contains("remains active"), "{text}");
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Blocked);
}

#[tokio::test]
async fn verifier_turn_exhaustion_is_infrastructure_and_does_not_count_semantically() {
    let state = AppState::new("/");
    let selection = kcoder_state::GoalVerifierSelection {
        completion_rejection_limit: Some(1),
        ..Default::default()
    };
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            selection,
        )
        .unwrap();
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
        output: Ok("FLAKY\nThe verifier reached its final decision boundary without an explicit verdict from the evidence already collected, so PASS or FAIL cannot be accepted safely.".to_string()),
        prompts: Arc::new(Mutex::new(Vec::new())),
    }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Active);
    assert_eq!(current.complete_rejected_count, 1);
    assert_eq!(current.semantic_completion_rejected_count, 0);
    assert!(
        content_blocks_text(&output.content)
            .contains("does not increment semantic_completion_rejected_count")
    );
}

#[tokio::test]
async fn missing_legacy_workspace_baseline_pauses_instead_of_retrying_forever() {
    let state = AppState::new("/");
    state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
        output: Err(
            "goal_pro_workspace_baseline_missing: repository has no usable HEAD".to_string(),
        ),
        prompts: Arc::new(Mutex::new(Vec::new())),
    }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Paused);
    assert_eq!(current.semantic_completion_rejected_count, 0);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("clear and recreate"), "{text}");
}

#[tokio::test]
async fn machine_gate_semantic_rejection_counts_toward_the_limit() {
    let state = AppState::new("/");
    let selection = kcoder_state::GoalVerifierSelection {
        completion_rejection_limit: Some(1),
        ..Default::default()
    };
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            selection,
        )
        .unwrap();
    let mut result = traced_verifier_result("PASS\nmodel accepted".to_string());
    result.workspace_unchanged = false;
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(StaticResultVerifier { result }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    let current = ctx.state.goal().unwrap();
    assert!(output.is_error);
    assert_eq!(current.status, GoalStatus::Blocked);
    assert_eq!(current.semantic_completion_rejected_count, 1);
    assert!(content_blocks_text(&output.content).contains("automatically blocked"));
}

fn vote_record(
    verdict: crate::VerifierVoteOutcome,
    summary: &str,
    rejection_reason: Option<&str>,
) -> crate::VerifierVoteRecord {
    crate::VerifierVoteRecord {
        input: crate::VerifierVoteInput {
            verdict,
            summary: summary.to_string(),
            rejection_reason: rejection_reason.map(str::to_string),
            commands: None,
            verified_tool_use_ids: None,
        },
        tool_use_id: "vote-1".to_string(),
    }
}

#[tokio::test]
async fn verifier_vote_pass_overrides_conflicting_text_verdict() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
        )
        .unwrap();
    let mut result = traced_verifier_result("FAIL\ntext disagrees with the vote".to_string());
    result.verifier_vote = Some(vote_record(
        crate::VerifierVoteOutcome::Pass,
        "目标测试与回归套件均通过",
        None,
    ));
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(StaticResultVerifier { result }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
    assert!(content_blocks_text(&output.content).contains("目标测试与回归套件均通过"));
}

#[tokio::test]
async fn verifier_vote_fail_overrides_pass_text_and_uses_rejection_reason() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
        )
        .unwrap();
    let mut result = traced_verifier_result("PASS\ntext claims success".to_string());
    result.verifier_vote = Some(vote_record(
        crate::VerifierVoteOutcome::Fail,
        "关键路径未被覆盖",
        Some("缺少对失败分支的回归测试；主 Agent 需要补写该测试并复跑目标套件"),
    ));
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(StaticResultVerifier { result }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("缺少对失败分支的回归测试"), "{text}");
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Active);
    assert_eq!(current.semantic_completion_rejected_count, 1);
    // Event summaries retain the verdict= prefix contract for the next verifier's focus injection.
    let rejection = current
        .latest_semantic_verification_rejection()
        .expect("semantic rejection event");
    assert!(
        rejection
            .summary
            .starts_with("verdict=fail: 缺少对失败分支的回归测试"),
        "{}",
        rejection.summary
    );
}

#[tokio::test]
async fn verifier_vote_pass_is_still_rejected_by_the_machine_gate() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
        )
        .unwrap();
    let mut result = traced_verifier_result("PASS\nverified".to_string());
    result.workspace_unchanged = false;
    result.verifier_vote = Some(vote_record(
        crate::VerifierVoteOutcome::Pass,
        "目标测试通过",
        None,
    ));
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(StaticResultVerifier { result }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    assert!(content_blocks_text(&output.content).contains("machine verification gate"));
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Active);
    assert_eq!(current.semantic_completion_rejected_count, 1);
}

#[tokio::test]
async fn answer_goal_verifier_vote_fail_uses_rejection_reason() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    let goal = state
        .set_goal_prepared_with_mode_and_verification(
            "research",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Answer,
        )
        .unwrap();
    let report_path = root.path().join(goal_report_relative_path(&goal.goal_id));
    std::fs::create_dir_all(report_path.parent().unwrap()).unwrap();
    std::fs::write(report_path, "supported answer").unwrap();
    let mut result = AgentRunResult::untraced("PASS\ntext claims success".to_string());
    result.verifier_vote = Some(vote_record(
        crate::VerifierVoteOutcome::Fail,
        "报告缺少关键来源",
        Some("报告第 2 节的引用无法核实；主 Agent 需要补齐数据来源"),
    ));
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(StaticResultVerifier { result }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("报告第 2 节的引用无法核实"), "{text}");
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Active);
    assert_eq!(current.semantic_completion_rejected_count, 1);
}

#[tokio::test]
async fn answer_goal_verifier_vote_pass_completes_without_machine_gate() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    let goal = state
        .set_goal_prepared_with_mode_and_verification(
            "research",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Answer,
        )
        .unwrap();
    let report_path = root.path().join(goal_report_relative_path(&goal.goal_id));
    std::fs::create_dir_all(report_path.parent().unwrap()).unwrap();
    std::fs::write(report_path, "supported answer").unwrap();
    // The text has no parseable verdict; when a vote exists, text parsing is irrelevant.
    let mut result = AgentRunResult::untraced("verification finished".to_string());
    result.verifier_vote = Some(vote_record(
        crate::VerifierVoteOutcome::Pass,
        "报告完整回答了目标",
        None,
    ));
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(StaticResultVerifier { result }));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
    assert!(content_blocks_text(&output.content).contains("报告完整回答了目标"));
}

fn panelist_pass(label: &str, summary: &str) -> PanelistVerdict {
    PanelistVerdict {
        label: label.to_string(),
        outcome: PanelistOutcome::Pass {
            summary: summary.to_string(),
        },
    }
}

fn panelist_rejected(
    label: &str,
    verdict: GoalVerificationVerdict,
    reason: &str,
) -> PanelistVerdict {
    PanelistVerdict {
        label: label.to_string(),
        outcome: PanelistOutcome::Rejected {
            verdict,
            reason: reason.to_string(),
        },
    }
}

fn panelist_infra(label: &str) -> PanelistVerdict {
    PanelistVerdict {
        label: label.to_string(),
        outcome: PanelistOutcome::InfrastructureError { reason: None },
    }
}

#[test]
fn panel_aggregation_requires_a_strict_pass_majority() {
    let all_pass =
        aggregate_verifier_panel(&[panelist_pass("a", "结论甲"), panelist_pass("b", "结论乙")]);
    let PanelVerdict::Pass { merged } = all_pass else {
        panic!("all-pass panel must pass")
    };
    assert!(merged.contains("2/2"));
    assert!(merged.contains("结论甲") && merged.contains("结论乙"));

    // A strict two-of-three majority passes, with merged text only from the passing side.
    let majority = aggregate_verifier_panel(&[
        panelist_pass("a", "通过结论"),
        panelist_pass("b", "另一通过结论"),
        panelist_rejected("c", GoalVerificationVerdict::Fail, "失败理由不得出现"),
    ]);
    let PanelVerdict::Pass { merged } = majority else {
        panic!("2/3 pass majority must pass")
    };
    assert!(merged.contains("2/3"));
    assert!(merged.contains("通过结论"));
    assert!(!merged.contains("失败理由不得出现"));

    // A one-to-one tie does not pass.
    let tie = aggregate_verifier_panel(&[
        panelist_pass("a", "通过结论不得出现"),
        panelist_rejected("b", GoalVerificationVerdict::Fail, "缺失回归测试"),
    ]);
    let PanelVerdict::Rejected { verdict, merged } = tie else {
        panic!("tie must not pass")
    };
    assert_eq!(verdict, GoalVerificationVerdict::Fail);
    assert!(merged.contains("缺失回归测试"));
    assert!(!merged.contains("通过结论不得出现"));
}

#[test]
fn panel_aggregation_groups_flaky_on_the_non_pass_side() {
    // Resolve the non-passing side to Fail when Fail has more votes.
    let fail_side = aggregate_verifier_panel(&[
        panelist_rejected("a", GoalVerificationVerdict::Fail, "失败甲"),
        panelist_rejected("b", GoalVerificationVerdict::Flaky, "摇摆乙"),
        panelist_rejected("c", GoalVerificationVerdict::Fail, "失败丙"),
    ]);
    assert!(matches!(
        fail_side,
        PanelVerdict::Rejected {
            verdict: GoalVerificationVerdict::Fail,
            ..
        }
    ));

    // Resolve to Flaky when Flaky votes are at least as numerous as Fail votes.
    let flaky_side = aggregate_verifier_panel(&[
        panelist_rejected("a", GoalVerificationVerdict::Fail, "失败甲"),
        panelist_rejected("b", GoalVerificationVerdict::Flaky, "摇摆乙"),
        panelist_rejected("c", GoalVerificationVerdict::Flaky, "摇摆丙"),
    ]);
    let PanelVerdict::Rejected { verdict, merged } = flaky_side else {
        panic!("non-pass panel must reject")
    };
    assert_eq!(verdict, GoalVerificationVerdict::Flaky);
    assert!(merged.contains("[fail]") && merged.contains("[flaky]"));
}

#[test]
fn panel_aggregation_excludes_infrastructure_errors() {
    let all_infra = aggregate_verifier_panel(&[panelist_infra("a"), panelist_infra("b")]);
    assert!(matches!(
        all_infra,
        PanelVerdict::InfrastructureError { .. }
    ));

    // Exclude and annotate partial infrastructure failures; a remaining one-Pass/one-Fail tie does not pass.
    let partial = aggregate_verifier_panel(&[
        panelist_pass("a", "通过结论不得出现"),
        panelist_rejected("b", GoalVerificationVerdict::Fail, "失败理由"),
        panelist_infra("c"),
    ]);
    let PanelVerdict::Rejected { merged, .. } = partial else {
        panic!("tied valid votes must reject")
    };
    assert!(merged.contains("1/3 panelist(s) excluded"));
    assert!(!merged.contains("通过结论不得出现"));
}

struct PanelStubVerifier {
    results: Mutex<VecDeque<Result<AgentRunResult, String>>>,
}

#[async_trait::async_trait]
impl AgentRunner for PanelStubVerifier {
    async fn run_agent(&self, _prompt: String, _max_turns: usize) -> Result<String, AgentError> {
        Err(AgentError::Execution("not used in panel tests".to_string()))
    }

    async fn run_verifier_with_runtime(
        &self,
        _prompt: String,
        _max_turns: usize,
        runtime: Option<AgentRuntimeSelection>,
        _options: VerifierRunOptions,
    ) -> Result<AgentRunResult, AgentError> {
        assert!(
            runtime.is_some(),
            "panel members must carry a runtime selection"
        );
        match self.results.lock().unwrap().pop_front() {
            Some(Ok(result)) => Ok(result),
            Some(Err(error)) => Err(AgentError::Execution(error)),
            None => panic!("one verifier run per panel member"),
        }
    }
}

fn panel_slot(profile: &str) -> kcoder_config::GoalProModelSlotConfig {
    kcoder_config::GoalProModelSlotConfig {
        profile: Some(profile.to_string()),
        provider: None,
        model: None,
    }
}

fn panel_artifact_goal(profiles: &[&str]) -> kcoder_state::GoalVerifierSelection {
    kcoder_state::GoalVerifierSelection {
        verifier_panel: profiles.iter().map(|profile| panel_slot(profile)).collect(),
        ..Default::default()
    }
}

fn voted_pass(summary: &str) -> AgentRunResult {
    let mut result = traced_verifier_result("PASS\nverified".to_string());
    result.verifier_vote = Some(vote_record(crate::VerifierVoteOutcome::Pass, summary, None));
    result
}

fn voted_fail(summary: &str, reason: &str) -> AgentRunResult {
    let mut result = traced_verifier_result("FAIL\nrejected".to_string());
    result.verifier_vote = Some(vote_record(
        crate::VerifierVoteOutcome::Fail,
        summary,
        Some(reason),
    ));
    result
}

#[tokio::test]
async fn panel_all_pass_completes_and_merges_only_pass_summaries() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            panel_artifact_goal(&["panel-a", "panel-b"]),
        )
        .unwrap();
    let runner = PanelStubVerifier {
        results: Mutex::new(VecDeque::from([
            Ok(voted_pass("面板甲通过")),
            Ok(voted_pass("面板乙通过")),
        ])),
    };
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(runner));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(!output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("2/2"), "{text}");
    assert!(
        text.contains("面板甲通过") && text.contains("面板乙通过"),
        "{text}"
    );
    assert!(
        text.contains("(panel-a)") && text.contains("(panel-b)"),
        "{text}"
    );
    assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Complete);
}

#[tokio::test]
async fn panel_majority_fail_returns_only_failure_reasons() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            panel_artifact_goal(&["panel-a", "panel-b", "panel-c"]),
        )
        .unwrap();
    let runner = PanelStubVerifier {
        results: Mutex::new(VecDeque::from([
            Ok(voted_pass("通过结论绝不外泄")),
            Ok(voted_fail("失败摘要甲", "缺少失败分支回归测试")),
            Ok(voted_fail("失败摘要乙", "目标套件未真实运行")),
        ])),
    };
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(runner));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("PASS 1/3"), "{text}");
    assert!(text.contains("缺少失败分支回归测试"), "{text}");
    assert!(text.contains("目标套件未真实运行"), "{text}");
    assert!(!text.contains("通过结论绝不外泄"), "{text}");
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Active);
    assert_eq!(current.semantic_completion_rejected_count, 1);
    let rejection = current
        .latest_semantic_verification_rejection()
        .expect("semantic rejection event");
    assert!(
        rejection.summary.starts_with("verdict=fail: "),
        "{}",
        rejection.summary
    );
}

#[tokio::test]
async fn panel_tie_is_not_a_pass() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            panel_artifact_goal(&["panel-a", "panel-b"]),
        )
        .unwrap();
    let runner = PanelStubVerifier {
        results: Mutex::new(VecDeque::from([
            Ok(voted_pass("通过结论绝不外泄")),
            Ok(voted_fail("失败摘要", "行为差异探针未在 baseline 复现")),
        ])),
    };
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(runner));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("行为差异探针未在 baseline 复现"), "{text}");
    assert!(!text.contains("通过结论绝不外泄"), "{text}");
    assert_eq!(
        ctx.state.goal().unwrap().semantic_completion_rejected_count,
        1
    );
}

#[tokio::test]
async fn panel_all_infrastructure_errors_do_not_count_as_semantic_rejection() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            panel_artifact_goal(&["panel-a", "panel-b"]),
        )
        .unwrap();
    let runner = PanelStubVerifier {
        results: Mutex::new(VecDeque::from([
            Err("provider offline".to_string()),
            Err("sandbox missing".to_string()),
        ])),
    };
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(runner));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("infrastructure"), "{text}");
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Active);
    assert_eq!(current.semantic_completion_rejected_count, 0);
}

#[tokio::test]
async fn panel_missing_legacy_workspace_baseline_pauses_the_goal() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            panel_artifact_goal(&["panel-a", "panel-b"]),
        )
        .unwrap();
    let runner = PanelStubVerifier {
        results: Mutex::new(VecDeque::from([
            Err("goal_pro_workspace_baseline_missing: no repository".to_string()),
            Err("goal_pro_workspace_baseline_missing: unborn HEAD".to_string()),
        ])),
    };
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(runner));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    assert!(output.is_error);
    let current = ctx.state.goal().unwrap();
    assert_eq!(current.status, GoalStatus::Paused);
    assert_eq!(current.semantic_completion_rejected_count, 0);
    assert!(content_blocks_text(&output.content).contains("clear and recreate"));
}

#[tokio::test]
async fn panel_pass_vote_is_still_filtered_by_each_member_machine_gate() {
    let state = AppState::new("/");
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            panel_artifact_goal(&["panel-a", "panel-b"]),
        )
        .unwrap();
    let mut gated = voted_pass("被门禁拦截的通过票");
    gated.workspace_unchanged = false;
    let runner = PanelStubVerifier {
        results: Mutex::new(VecDeque::from([Ok(voted_pass("正常通过票")), Ok(gated)])),
    };
    let ctx = ToolContext::new(state).with_agent_runner(Arc::new(runner));

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    // One Pass and one vote changed to Flaky by a gate form a non-passing tie containing only the gate reason.
    assert!(output.is_error);
    let text = content_blocks_text(&output.content);
    assert!(text.contains("[flaky]"), "{text}");
    assert!(text.contains("workspace"), "{text}");
    assert!(!text.contains("正常通过票"), "{text}");
    assert_eq!(
        ctx.state.goal().unwrap().semantic_completion_rejected_count,
        1
    );
}

#[tokio::test]
async fn recent_failure_gate_counts_and_reports_automatic_blocking() {
    let state = AppState::new("/");
    let selection = kcoder_state::GoalVerifierSelection {
        completion_rejection_limit: Some(1),
        ..Default::default()
    };
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "ship",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Artifact,
            selection,
        )
        .unwrap();
    state.add_message(Message::Assistant {
        content: vec![ContentBlock::ToolUse {
            id: "bash-failed".to_string(),
            name: "bash".to_string(),
            input: serde_json::json!({"command": "cargo test"}),
        }],
        usage: None,
    });
    state.add_message(Message::User {
        origin: kcoder_types::MessageOrigin::Unknown,
        content: vec![ContentBlock::ToolResult {
            tool_use_id: "bash-failed".to_string(),
            content: vec![ContentBlock::Text {
                text: "exit_code: 1\nFAILED regression".to_string(),
            }],
            is_error: Some(true),
        }],
    });
    let ctx = ToolContext::new(state);

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    let text = content_blocks_text(&output.content);
    let current = ctx.state.goal().unwrap();
    assert!(output.is_error);
    assert_eq!(current.status, GoalStatus::Blocked);
    assert_eq!(current.semantic_completion_rejected_count, 1);
    assert!(text.contains("automatically blocked"), "{text}");
    assert!(!text.contains("remains active"), "{text}");
}

#[tokio::test]
async fn invalid_answer_report_counts_and_reports_automatic_blocking() {
    let root = tempfile::tempdir().unwrap();
    let state = AppState::new(root.path());
    let selection = kcoder_state::GoalVerifierSelection {
        completion_rejection_limit: Some(1),
        ..Default::default()
    };
    state
        .set_goal_prepared_with_mode_and_verification_and_verifier(
            "research",
            None,
            None,
            GoalMode::Strict,
            GoalVerificationKind::Answer,
            selection,
        )
        .unwrap();
    let ctx = ToolContext::new(state);

    let output = UpdateGoalTool
        .call(serde_json::json!({"status": "complete"}), &ctx)
        .await
        .unwrap();

    let text = content_blocks_text(&output.content);
    let current = ctx.state.goal().unwrap();
    assert!(output.is_error);
    assert_eq!(current.status, GoalStatus::Blocked);
    assert_eq!(current.semantic_completion_rejected_count, 1);
    assert!(text.contains("automatically blocked"), "{text}");
    assert!(text.contains("Required report"), "{text}");
    assert!(!text.contains("remains active"), "{text}");
}

#[tokio::test]
async fn strict_complete_rejects_ambiguous_verdict_prefixes() {
    for verifier_output in [
        "PASSING",
        "PASS FAIL",
        "Result: PASS",
        "**PASS** means the command completed successfully.",
        "Example:\n    Verdict: PASS",
        "````text\nexample\n```\nVerdict: PASS\n````",
        "**PASS**\nReview body.\n**FAIL**\nConflicting conclusion.",
        "```text\nPASS\n```\nReview did not provide a verdict.",
    ] {
        let state = AppState::new("/");
        state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
        let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
            output: Ok(verifier_output.to_string()),
            prompts: Arc::new(Mutex::new(Vec::new())),
        }));

        let output = UpdateGoalTool
            .call(serde_json::json!({"status": "complete"}), &ctx)
            .await
            .unwrap();

        assert!(output.is_error, "verifier output: {verifier_output}");
        assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Active);
    }
}

#[tokio::test]
async fn strict_complete_stays_active_when_verifier_rejects_or_fails() {
    for output in [
        Ok("FAIL\n缺少登录集成测试".to_string()),
        Err("provider unavailable".to_string()),
    ] {
        let state = AppState::new("/");
        state.set_goal_prepared_with_mode("ship", None, None, GoalMode::Strict);
        let ctx = ToolContext::new(state).with_agent_runner(Arc::new(RecordingVerifier {
            output,
            prompts: Arc::new(Mutex::new(Vec::new())),
        }));

        let result = UpdateGoalTool
            .call(serde_json::json!({"status": "complete"}), &ctx)
            .await
            .unwrap();
        assert!(result.is_error);
        assert_eq!(ctx.state.goal().unwrap().status, GoalStatus::Active);
    }
}
