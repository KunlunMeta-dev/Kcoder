use super::*;

/// Normalized verdict for a verifier-panel member after vote handling, text fallback, and machine gates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PanelistOutcome {
    Pass {
        summary: String,
    },
    /// `verdict` is restricted to Fail or Flaky.
    Rejected {
        verdict: GoalVerificationVerdict,
        reason: String,
    },
    /// This member produced no valid verdict because of an infrastructure failure and is excluded from voting.
    InfrastructureError {
        reason: Option<String>,
    },
}

/// Valid verdict and model label for one verifier-panel member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PanelistVerdict {
    pub(super) label: String,
    pub(super) outcome: PanelistOutcome,
}

/// Final panel verdict and merged text; merged text contains only the winning side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PanelVerdict {
    Pass {
        merged: String,
    },
    Rejected {
        verdict: GoalVerificationVerdict,
        merged: String,
    },
    InfrastructureError {
        note: String,
    },
}

pub(super) fn verifier_panelist_label(slot: &kcoder_config::GoalProModelSlotConfig) -> String {
    if let Some(profile) = slot.profile.as_deref() {
        return profile.to_string();
    }
    format!(
        "{}:{}",
        slot.provider.as_deref().unwrap_or("current"),
        slot.model.as_deref().unwrap_or("current")
    )
}

/// Majority aggregation: InfrastructureError does not vote, Pass requires a strict
/// majority, ties do not pass, and the non-passing side resolves to Fail when Fail
/// has more votes than Flaky, otherwise to Flaky.
pub(super) fn aggregate_verifier_panel(panelists: &[PanelistVerdict]) -> PanelVerdict {
    let total = panelists.len();
    let mut passes = Vec::new();
    let mut rejections = Vec::new();
    let mut infrastructure_errors = 0usize;
    for panelist in panelists {
        match &panelist.outcome {
            PanelistOutcome::Pass { .. } => passes.push(panelist),
            PanelistOutcome::Rejected { .. } => rejections.push(panelist),
            PanelistOutcome::InfrastructureError { .. } => infrastructure_errors += 1,
        }
    }
    let valid = passes.len() + rejections.len();
    if valid == 0 {
        let reasons = panelists
            .iter()
            .filter_map(|panelist| match &panelist.outcome {
                PanelistOutcome::InfrastructureError {
                    reason: Some(reason),
                } => Some(format!("{}: {}", panelist.label, preview(reason, 180))),
                _ => None,
            })
            .collect::<Vec<_>>();
        return PanelVerdict::InfrastructureError {
            note: if reasons.is_empty() {
                format!(
                    "all {total} verifier panelists failed infrastructurally; no valid verdict was produced"
                )
            } else {
                format!(
                    "all {total} verifier panelists failed infrastructurally; no valid verdict was produced: {}",
                    reasons.join("; ")
                )
            },
        };
    }
    let infra_note = format!(
        "({infrastructure_errors}/{total} panelist(s) excluded from the tally: infrastructure errors)"
    );
    if passes.len() * 2 > valid {
        let mut merged = format!("Verifier panel PASS {}/{valid}:", passes.len());
        for panelist in passes {
            let PanelistOutcome::Pass { summary } = &panelist.outcome else {
                continue;
            };
            merged.push_str(&format!(
                "\n- ({}) {}",
                panelist.label,
                preview(summary, 180)
            ));
        }
        if infrastructure_errors > 0 {
            merged.push('\n');
            merged.push_str(&infra_note);
        }
        return PanelVerdict::Pass { merged };
    }
    let fail_count = rejections
        .iter()
        .filter(|panelist| {
            matches!(
                panelist.outcome,
                PanelistOutcome::Rejected {
                    verdict: GoalVerificationVerdict::Fail,
                    ..
                }
            )
        })
        .count();
    let verdict = if fail_count * 2 > rejections.len() {
        GoalVerificationVerdict::Fail
    } else {
        GoalVerificationVerdict::Flaky
    };
    let mut merged = format!("Verifier panel rejected (PASS {}/{valid}):", passes.len());
    for panelist in rejections {
        let PanelistOutcome::Rejected { verdict, reason } = &panelist.outcome else {
            continue;
        };
        merged.push_str(&format!(
            "\n- [{}] ({}) {}",
            verdict.as_str(),
            panelist.label,
            preview(reason, 180)
        ));
    }
    if infrastructure_errors > 0 {
        merged.push('\n');
        merged.push_str(&infra_note);
    }
    PanelVerdict::Rejected { verdict, merged }
}

/// Resolve a panel member using the single-verifier precedence: vote, text fallback,
/// then InfrastructureError. A Pass for an artifact goal additionally goes through
/// machine gates against that member's own trace.
pub(super) fn resolve_panelist_verdict(
    goal: &Goal,
    label: String,
    run: &AgentRunResult,
) -> PanelistVerdict {
    let text = run.output.as_str();
    let vote = run.verifier_vote.as_ref();
    let parsed = if let Some(vote) = vote {
        vote.input.verdict.into_goal_verdict()
    } else if verifier_turn_limit_exhausted(text) {
        GoalVerificationVerdict::InfrastructureError
    } else {
        parse_verifier_verdict(text).unwrap_or(GoalVerificationVerdict::InfrastructureError)
    };
    let outcome = match parsed {
        GoalVerificationVerdict::InfrastructureError => {
            PanelistOutcome::InfrastructureError { reason: None }
        }
        GoalVerificationVerdict::Pass => {
            let gate = if goal.verification_kind.is_artifact() {
                verifier_evidence_rejection(goal, run)
            } else {
                None
            };
            match gate {
                Some((GoalVerificationVerdict::InfrastructureError, _)) => {
                    PanelistOutcome::InfrastructureError { reason: None }
                }
                Some((gate_verdict, gate_summary)) => PanelistOutcome::Rejected {
                    verdict: gate_verdict,
                    reason: gate_summary,
                },
                None => PanelistOutcome::Pass {
                    summary: vote
                        .map(|vote| vote.input.summary.clone())
                        .unwrap_or_else(|| preview(text, 220)),
                },
            }
        }
        verdict @ (GoalVerificationVerdict::Fail | GoalVerificationVerdict::Flaky) => {
            PanelistOutcome::Rejected {
                verdict,
                reason: vote
                    .and_then(|vote| vote.input.rejection_reason.clone())
                    .unwrap_or_else(|| preview(text, 220)),
            }
        }
    };
    PanelistVerdict { label, outcome }
}

/// Fan out the complete verifier panel concurrently. Each member runs an independent
/// full verifier session with an isolated workspace, engine-authenticated trace, and
/// VerifierVote channel, without observing other members.
pub(super) async fn run_verifier_panel(
    runner: &Arc<dyn AgentRunner>,
    goal: &Goal,
    prompt: &str,
    options: VerifierRunOptions,
) -> Vec<PanelistVerdict> {
    let futures = goal
        .verifier_selection
        .verifier_panel
        .iter()
        .map(|slot| {
            let label = verifier_panelist_label(slot);
            let options = options.clone();
            let selection = AgentRuntimeSelection {
                profile: slot.profile.clone(),
                provider: slot.provider.clone(),
                model: slot.model.clone(),
            };
            let max_turns = goal.verifier_selection.verifier_max_turns.max(1);
            async move {
                match runner
                    .run_verifier_with_runtime(
                        prompt.to_string(),
                        max_turns,
                        Some(selection),
                        options,
                    )
                    .await
                {
                    Ok(run) => resolve_panelist_verdict(goal, label.clone(), &run),
                    Err(error) => {
                        tracing::warn!(
                            panelist = %label,
                            "verifier panelist failed infrastructurally: {error:#}"
                        );
                        PanelistVerdict {
                            label,
                            outcome: PanelistOutcome::InfrastructureError {
                                reason: Some(error.to_string()),
                            },
                        }
                    }
                }
            }
        })
        .collect::<Vec<_>>();
    futures::future::join_all(futures).await
}

/// Build verifier runtime options from the acceptance policy frozen into the goal; shared by single verifiers and panel members.
pub(super) fn verifier_run_options_for(goal: &Goal) -> VerifierRunOptions {
    VerifierRunOptions {
        isolate_environment: goal.verification_kind.is_artifact()
            && goal.verifier_selection.verification.isolate_environment,
        block_dependency_mutation: goal.verification_kind.is_artifact()
            && (!goal
                .verifier_selection
                .verification
                .allow_dependency_changes
                || goal.verifier_selection.verification.require_behavior_delta),
        verify_workspace_unchanged: goal.verification_kind.is_artifact()
            && (!goal.verifier_selection.verification.allow_workspace_changes
                || goal.verifier_selection.verification.require_behavior_delta),
        minimum_test_scope: (goal.verification_kind.is_artifact()
            && (goal.verifier_selection.verification.require_tests
                || goal.verifier_selection.verification.require_behavior_delta))
            .then_some(
                if goal.verifier_selection.verification.require_behavior_delta {
                    GoalProTestScope::TargetSuite
                } else {
                    goal.verifier_selection.verification.minimum_test_scope
                },
            ),
        require_raw_exit_code: goal.verification_kind.is_artifact()
            && goal.verifier_selection.verification.require_raw_exit_code,
        require_behavior_delta: goal.verification_kind.is_artifact()
            && goal.verifier_selection.verification.require_behavior_delta,
        workspace_baseline: goal.workspace_baseline.as_ref().map(|baseline| {
            crate::VerifierWorkspaceBaseline {
                bundle_path: baseline.bundle_path.clone(),
                bundle_sha256: baseline.bundle_sha256.clone(),
                commit: baseline.commit.clone(),
                source_root: baseline.source_root.clone(),
            }
        }),
    }
}
