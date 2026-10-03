use super::*;

/// Race-resistant recheck and commit after Pass. If objective/report changes or
/// becomes unreadable during verification, commit Flaky and return an error;
/// otherwise commit Pass and return success. `summary_source` supplies the truncated
/// commit summary, while `message_detail` supplies the success message to the primary agent.
pub(super) async fn commit_strict_verifier_pass(
    ctx: &ToolContext,
    goal: &Goal,
    objective: &GoalObjectiveSnapshot,
    report: Option<&GoalReportSnapshot>,
    summary_source: &str,
    message_detail: String,
) -> Result<ToolOutput, ToolError> {
    if let Some(expected_sha256) = objective.sha256.as_deref() {
        match read_goal_objective(&ctx.state.cwd(), goal) {
            Ok(current) if current.sha256.as_deref() == Some(expected_sha256) => {}
            Ok(current) => {
                let summary = format!(
                    "objective changed during verification: expected sha256={}, current sha256={}",
                    expected_sha256,
                    current.sha256.as_deref().unwrap_or("inline")
                );
                let outcome = ctx.state.commit_goal_verification(
                    &goal.goal_id,
                    goal.revision,
                    GoalVerificationVerdict::Flaky,
                    &summary,
                );
                let status = verification_commit_status_message(&outcome);
                return respond_error(GoalToolResponse {
                    success: false,
                    message: format!(
                        "Strict goal objective changed during verification, so completion was rejected fail-closed. {status}"
                    ),
                    goal: outcome_goal(outcome),
                });
            }
            Err(error) => {
                let summary = format!("objective could not be re-read after PASS: {error}");
                let outcome = ctx.state.commit_goal_verification(
                    &goal.goal_id,
                    goal.revision,
                    GoalVerificationVerdict::Flaky,
                    &summary,
                );
                let status = verification_commit_status_message(&outcome);
                return respond_error(GoalToolResponse {
                    success: false,
                    message: format!(
                        "Strict goal objective could not be confirmed after verification: {error}. {status}"
                    ),
                    goal: outcome_goal(outcome),
                });
            }
        }
    }

    if let Some(expected) = report {
        match read_goal_report(&ctx.state.cwd(), &goal.goal_id) {
            Ok(current) if current.sha256 == expected.sha256 => {}
            Ok(current) => {
                let summary = format!(
                    "report changed during verification: expected sha256={}, current sha256={}",
                    expected.sha256, current.sha256
                );
                let outcome = ctx.state.commit_goal_verification(
                    &goal.goal_id,
                    goal.revision,
                    GoalVerificationVerdict::Flaky,
                    &summary,
                );
                let status = verification_commit_status_message(&outcome);
                return respond_error(GoalToolResponse {
                    success: false,
                    message: format!(
                        "Strict Answer goal report changed during verification, so completion was rejected fail-closed. {status}"
                    ),
                    goal: outcome_goal(outcome),
                });
            }
            Err(error) => {
                let summary = format!("report could not be re-read after PASS: {error}");
                let outcome = ctx.state.commit_goal_verification(
                    &goal.goal_id,
                    goal.revision,
                    GoalVerificationVerdict::Flaky,
                    &summary,
                );
                let status = verification_commit_status_message(&outcome);
                return respond_error(GoalToolResponse {
                    success: false,
                    message: format!(
                        "Strict Answer goal report could not be confirmed after verification: {error}. {status}"
                    ),
                    goal: outcome_goal(outcome),
                });
            }
        }
    }

    let summary = report.map_or_else(
        || preview(summary_source, 220),
        |report| {
            format!(
                "report_sha256={} verifier={}",
                report.sha256,
                preview(summary_source, 140)
            )
        },
    );
    let GoalVerificationCommitOutcome::Applied(goal) = ctx.state.commit_goal_verification(
        &goal.goal_id,
        goal.revision,
        GoalVerificationVerdict::Pass,
        &summary,
    ) else {
        return respond_error(GoalToolResponse {
            success: false,
            message: "Strict verifier passed, but the goal changed before completion could be committed. The stale verifier result was discarded."
                .to_string(),
            goal: ctx.state.goal(),
        });
    };
    respond(GoalToolResponse {
        success: true,
        message: format!(
            "Strict goal independently verified and marked complete. Final usage: {} tokens, {} seconds. Verifier: {}",
            goal.tokens_used, goal.time_used_seconds, message_detail
        ),
        goal: Some(goal),
    })
}

/// Panel mode: run all verifier members concurrently, aggregate by majority, and
/// commit and return only merged content from the winning side.
pub(super) async fn verify_strict_completion_with_panel(
    ctx: &ToolContext,
    goal: &Goal,
    runner: &Arc<dyn AgentRunner>,
    prompt: &str,
    objective: &GoalObjectiveSnapshot,
    report: Option<&GoalReportSnapshot>,
) -> Result<ToolOutput, ToolError> {
    let panelists = run_verifier_panel(runner, goal, prompt, verifier_run_options_for(goal)).await;
    match aggregate_verifier_panel(&panelists) {
        PanelVerdict::InfrastructureError { note } => {
            let requires_recreation = verifier_workspace_requires_goal_recreation(&note);
            let outcome = ctx.state.commit_goal_verification(
                &goal.goal_id,
                goal.revision,
                GoalVerificationVerdict::InfrastructureError,
                &note,
            );
            let mut status = verification_commit_status_message(&outcome);
            let mut returned_goal = outcome_goal(outcome);
            if requires_recreation {
                returned_goal = ctx.state.update_goal_status(GoalStatus::Paused);
                status = "The legacy Goal Pro was paused because it has no usable workspace baseline; clear and recreate it to capture the baseline before work starts."
                    .to_string();
            }
            respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Strict goal completion was rejected by the verifier panel. {status} {note} This infrastructure failure does not increment semantic_completion_rejected_count, cannot be used toward the blocked audit, and does not increment blocked_candidate_count."
                ),
                goal: returned_goal,
            })
        }
        PanelVerdict::Rejected { verdict, merged } => {
            let outcome =
                ctx.state
                    .commit_goal_verification(&goal.goal_id, goal.revision, verdict, &merged);
            let status = verification_commit_status_message(&outcome);
            respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Strict goal completion was rejected by the verifier panel. {status} {merged}"
                ),
                goal: outcome_goal(outcome),
            })
        }
        PanelVerdict::Pass { merged } => {
            commit_strict_verifier_pass(ctx, goal, objective, report, &merged, merged.clone()).await
        }
    }
}

pub(super) async fn verify_strict_completion(
    ctx: &ToolContext,
    goal: &Goal,
) -> Result<ToolOutput, ToolError> {
    let report = if goal.verification_kind.is_answer() {
        match read_goal_report(&ctx.state.cwd(), &goal.goal_id) {
            Ok(report) => Some(report),
            Err(error) => {
                let summary = format!("answer report rejected: {error}");
                let outcome = ctx.state.record_goal_completion_rejected_if_matches(
                    &goal.goal_id,
                    goal.revision,
                    &summary,
                    true,
                );
                let status = verification_commit_status_message(&outcome);
                return respond_error(GoalToolResponse {
                    success: false,
                    message: format!(
                        "Strict Answer goal completion was rejected before verification: {error}. {status} Required report: {}",
                        goal_report_relative_path(&goal.goal_id).display(),
                    ),
                    goal: outcome_goal(outcome),
                });
            }
        }
    } else {
        None
    };
    let Some(runner) = ctx.agent_runner.as_ref() else {
        let outcome = ctx.state.commit_goal_verification(
            &goal.goal_id,
            goal.revision,
            GoalVerificationVerdict::InfrastructureError,
            "verifier unavailable; goal kept active",
        );
        let status = verification_commit_status_message(&outcome);
        return respond_error(GoalToolResponse {
            success: false,
            message: format!(
                "Strict goal completion was not accepted because no verifier runner is available. {status} This infrastructure failure does not increment semantic_completion_rejected_count."
            ),
            goal: outcome_goal(outcome),
        });
    };
    let objective = match read_goal_objective(&ctx.state.cwd(), goal) {
        Ok(objective) => objective,
        Err(error) => {
            let summary = format!("objective could not be captured before verification: {error}");
            let outcome = ctx.state.commit_goal_verification(
                &goal.goal_id,
                goal.revision,
                GoalVerificationVerdict::InfrastructureError,
                &summary,
            );
            let status = verification_commit_status_message(&outcome);
            return respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Strict goal objective could not be read safely before verification: {error}. {status} This infrastructure failure does not increment semantic_completion_rejected_count."
                ),
                goal: outcome_goal(outcome),
            });
        }
    };
    let context = goal
        .context_snapshot
        .as_deref()
        .unwrap_or("(No semantic context snapshot was available when the goal was created.)");
    let evidence = recent_goal_evidence(ctx);
    let prompt = strict_verifier_prompt(
        goal.verification_kind,
        &objective.text,
        context,
        &evidence,
        report.as_ref(),
        goal.latest_semantic_verification_rejection()
            .map(|event| event.summary.as_str()),
        &goal.verifier_selection.verification,
    );

    let panel = &goal.verifier_selection.verifier_panel;
    if panel.len() >= 2 {
        return verify_strict_completion_with_panel(
            ctx,
            goal,
            runner,
            &prompt,
            &objective,
            report.as_ref(),
        )
        .await;
    }

    let runtime_selection = (goal.verifier_selection.profile.is_some()
        || goal.verifier_selection.provider.is_some()
        || goal.verifier_selection.model.is_some())
    .then(|| AgentRuntimeSelection {
        profile: goal.verifier_selection.profile.clone(),
        provider: goal.verifier_selection.provider.clone(),
        model: goal.verifier_selection.model.clone(),
    });
    let verifier_run = match runner
        .run_verifier_with_runtime(
            prompt,
            goal.verifier_selection.verifier_max_turns.max(1),
            runtime_selection,
            verifier_run_options_for(goal),
        )
        .await
    {
        Ok(verdict) => verdict,
        Err(error) => {
            let summary = format!("verifier failed: {error}");
            let requires_recreation = verifier_workspace_requires_goal_recreation(&summary);
            let outcome = ctx.state.commit_goal_verification(
                &goal.goal_id,
                goal.revision,
                GoalVerificationVerdict::InfrastructureError,
                &summary,
            );
            let mut status = verification_commit_status_message(&outcome);
            let mut returned_goal = outcome_goal(outcome);
            if requires_recreation {
                returned_goal = ctx.state.update_goal_status(GoalStatus::Paused);
                status = "The legacy Goal Pro was paused because it has no usable workspace baseline; clear and recreate it to capture the baseline before work starts."
                    .to_string();
            }
            return respond_error(GoalToolResponse {
                success: false,
                message: format!(
                    "Strict goal verifier failed, so completion was rejected fail-closed: {error}. {status} This infrastructure failure does not increment semantic_completion_rejected_count, cannot be used toward the blocked audit, and does not increment blocked_candidate_count."
                ),
                goal: returned_goal,
            });
        }
    };
    let verdict = verifier_run.output.as_str();
    let turns_exhausted = verifier_turn_limit_exhausted(verdict);
    // Verdict precedence: runtime-validated structured vote, text fallback, then
    // InfrastructureError. When a vote exists, ignore assistant text entirely.
    let vote = verifier_run.verifier_vote.as_ref();
    let parsed_verdict = if let Some(vote) = vote {
        vote.input.verdict.into_goal_verdict()
    } else if turns_exhausted {
        GoalVerificationVerdict::InfrastructureError
    } else {
        parse_verifier_verdict(verdict).unwrap_or(GoalVerificationVerdict::InfrastructureError)
    };
    if !parsed_verdict.passed() {
        let summary = if let Some(vote) = vote {
            // Fail and Flaky votes require a nonempty rejection_reason at tool-call time;
            // it provides actionable content for both the primary agent and the next verifier.
            vote.input
                .rejection_reason
                .clone()
                .unwrap_or_else(|| vote.input.summary.clone())
        } else if matches!(parsed_verdict, GoalVerificationVerdict::InfrastructureError) {
            if turns_exhausted {
                format!("verifier turn limit exhausted: {}", preview(verdict, 180))
            } else {
                format!("invalid verifier verdict: {}", preview(verdict, 180))
            }
        } else {
            preview(verdict, 220)
        };
        let outcome = ctx.state.commit_goal_verification(
            &goal.goal_id,
            goal.revision,
            parsed_verdict,
            &summary,
        );
        let status = verification_commit_status_message(&outcome);
        return respond_error(GoalToolResponse {
            success: false,
            message: format!(
                "Strict goal completion was rejected by the verifier. {status} Verifier report: {summary}{}",
                if matches!(parsed_verdict, GoalVerificationVerdict::InfrastructureError) {
                    " This infrastructure failure does not increment semantic_completion_rejected_count, cannot be used toward the blocked audit, and does not increment blocked_candidate_count."
                } else {
                    ""
                }
            ),
            goal: outcome_goal(outcome),
        });
    }

    if goal.verification_kind.is_artifact()
        && let Some((evidence_verdict, evidence_summary)) =
            verifier_evidence_rejection(goal, &verifier_run)
    {
        let outcome = ctx.state.commit_goal_verification(
            &goal.goal_id,
            goal.revision,
            evidence_verdict,
            &evidence_summary,
        );
        let status = verification_commit_status_message(&outcome);
        return respond_error(GoalToolResponse {
            success: false,
            message: format!(
                "Strict goal completion was rejected by the machine verification gate. {status} Evidence: {evidence_summary}{}",
                if matches!(
                    evidence_verdict,
                    GoalVerificationVerdict::InfrastructureError
                ) {
                    " This infrastructure failure does not increment semantic_completion_rejected_count."
                } else {
                    ""
                }
            ),
            goal: outcome_goal(outcome),
        });
    }

    let verifier_line = vote
        .map(|vote| vote.input.summary.clone())
        .unwrap_or_else(|| verdict.to_string());
    let message_detail = vote
        .map(|vote| vote.input.summary.clone())
        .unwrap_or_else(|| preview(verdict, 220));
    commit_strict_verifier_pass(
        ctx,
        goal,
        &objective,
        report.as_ref(),
        &verifier_line,
        message_detail,
    )
    .await
}
