use kcoder_config::OrchestrateContinuationSettings;
use kcoder_state::orchestrate_store::PlanStore;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleContext {
    pub turn_finished: bool,
    pub pending_question: bool,
    pub cancelled: bool,
    pub compaction_in_flight: bool,
    pub internal_prompt: bool,
    pub continuation_in_flight: bool,
    pub manual_intervention_required: bool,
    pub tracked_agents_running: usize,
    pub active_work_incomplete: bool,
    pub dedupe_already_queued: bool,
    pub cooldown_elapsed: bool,
    pub consecutive_failures: u32,
    pub stalled_rounds: u32,
    pub auto_turns: u32,
    pub goal_limit_reached: bool,
}

/// Input directly observable by the host at a true idle boundary.
///
/// Engine/PlanStore fills remaining counters and work state so TUI, headless, and
/// app-server paths do not independently construct inconsistent complete `IdleContext` values.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IdleRequest {
    pub pending_question: bool,
    pub cancelled: bool,
    pub compaction_in_flight: bool,
    pub internal_prompt: bool,
    pub dedupe_already_queued: bool,
    pub cooldown_elapsed: bool,
    pub goal_limit_reached: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContinuationDecision {
    Enqueue,
    StayIdle {
        reason: &'static str,
        notify_once: bool,
    },
}

pub fn evaluate_idle(
    context: &IdleContext,
    settings: &OrchestrateContinuationSettings,
) -> ContinuationDecision {
    let blocked = [
        (!context.turn_finished, "turn_in_flight"),
        (context.pending_question, "pending_question"),
        (context.cancelled, "cancelled"),
        (context.compaction_in_flight, "compaction_in_flight"),
        (context.internal_prompt, "internal_prompt"),
        (context.continuation_in_flight, "continuation_in_flight"),
        (
            context.manual_intervention_required,
            "manual_intervention_required",
        ),
        (context.tracked_agents_running > 0, "tracked_agents_running"),
        (!context.active_work_incomplete, "no_incomplete_active_work"),
        (context.dedupe_already_queued, "continuation_already_queued"),
        (!context.cooldown_elapsed, "cooldown"),
        (context.goal_limit_reached, "goal_limit_reached"),
    ];
    if let Some((_, reason)) = blocked.into_iter().find(|(blocked, _)| *blocked) {
        return ContinuationDecision::StayIdle {
            reason,
            notify_once: false,
        };
    }
    if context.auto_turns >= settings.max_auto_turns {
        return ContinuationDecision::StayIdle {
            reason: "manual_intervention_required",
            notify_once: true,
        };
    }
    if context.consecutive_failures >= settings.max_consecutive_failures {
        return ContinuationDecision::StayIdle {
            reason: "consecutive_failures",
            notify_once: true,
        };
    }
    if context.stalled_rounds >= settings.max_stalled_rounds {
        return ContinuationDecision::StayIdle {
            reason: "stalled",
            notify_once: true,
        };
    }
    ContinuationDecision::Enqueue
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimedContinuation {
    NotApplicable,
    Enqueued {
        prompt: String,
    },
    StayIdle {
        reason: &'static str,
        notify_once: bool,
    },
}

pub fn claim_for_workspace(
    workspace: &Path,
    settings: &OrchestrateContinuationSettings,
    mut context: IdleContext,
) -> anyhow::Result<ClaimedContinuation> {
    let store = PlanStore::for_workspace(workspace);
    let Some(work_id) = store.active_work_id()? else {
        return Ok(ClaimedContinuation::NotApplicable);
    };
    let snapshot = store.read_work(&work_id)?;
    let mut continuation = store.read_continuation_state(&work_id)?;
    // Hosts call this only at a true idle boundary. An in-flight claim here means the
    // previous run exited abnormally at a process or stream boundary; finalize one failure first to prevent permanent stalls or duplicate delivery after a crash.
    if continuation.in_flight && context.turn_finished && context.cooldown_elapsed {
        continuation = store.record_continuation_outcome(&work_id, true)?;
    }
    context.active_work_incomplete =
        snapshot.work.progress.completed < snapshot.work.progress.total;
    context.auto_turns = continuation.auto_turn_count;
    context.consecutive_failures = continuation.consecutive_failures;
    context.stalled_rounds = continuation.stalled_rounds;
    context.continuation_in_flight = continuation.in_flight;
    context.manual_intervention_required |= continuation.manual_intervention_required;
    let decision = evaluate_idle(&context, settings);
    match decision {
        ContinuationDecision::Enqueue => {
            let claim = store.claim_auto_continuation(
                &work_id,
                snapshot.work.revision,
                settings.max_auto_turns,
            )?;
            if !claim.claimed {
                return Ok(ClaimedContinuation::StayIdle {
                    reason: "manual_intervention_required",
                    notify_once: claim.manual_intervention_newly_required,
                });
            }
            Ok(ClaimedContinuation::Enqueued {
                prompt: format!(
                    "[system] Orchestrate durable plan continuation. Active work: {} revision {} ({} of {} items complete). Re-read PlanProgress, continue the next unaccepted task through delegation, and do not claim completion without trusted evidence.",
                    work_id,
                    claim.snapshot.work.revision,
                    claim.snapshot.work.progress.completed,
                    claim.snapshot.work.progress.total,
                ),
            })
        }
        ContinuationDecision::StayIdle {
            reason,
            notify_once,
        } => {
            let notify_once = if notify_once {
                store.require_manual_intervention(&work_id, reason)?
            } else {
                false
            };
            Ok(ClaimedContinuation::StayIdle {
                reason,
                notify_once,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> IdleContext {
        IdleContext {
            turn_finished: true,
            pending_question: false,
            cancelled: false,
            compaction_in_flight: false,
            internal_prompt: false,
            continuation_in_flight: false,
            manual_intervention_required: false,
            tracked_agents_running: 0,
            active_work_incomplete: true,
            dedupe_already_queued: false,
            cooldown_elapsed: true,
            consecutive_failures: 0,
            stalled_rounds: 0,
            auto_turns: 0,
            goal_limit_reached: false,
        }
    }

    #[test]
    fn only_a_true_idle_candidate_can_enqueue() {
        assert_eq!(
            evaluate_idle(&idle(), &Default::default()),
            ContinuationDecision::Enqueue
        );
        for mutate in [
            |ctx: &mut IdleContext| ctx.turn_finished = false,
            |ctx: &mut IdleContext| ctx.pending_question = true,
            |ctx: &mut IdleContext| ctx.cancelled = true,
            |ctx: &mut IdleContext| ctx.compaction_in_flight = true,
            |ctx: &mut IdleContext| ctx.internal_prompt = true,
            |ctx: &mut IdleContext| ctx.continuation_in_flight = true,
            |ctx: &mut IdleContext| ctx.manual_intervention_required = true,
            |ctx: &mut IdleContext| ctx.tracked_agents_running = 1,
            |ctx: &mut IdleContext| ctx.active_work_incomplete = false,
            |ctx: &mut IdleContext| ctx.dedupe_already_queued = true,
            |ctx: &mut IdleContext| ctx.cooldown_elapsed = false,
            |ctx: &mut IdleContext| ctx.goal_limit_reached = true,
        ] {
            let mut context = idle();
            mutate(&mut context);
            assert!(matches!(
                evaluate_idle(&context, &Default::default()),
                ContinuationDecision::StayIdle { .. }
            ));
        }
    }

    #[test]
    fn hard_limits_require_manual_intervention_without_faking_goal_blocked() {
        let mut context = idle();
        context.auto_turns = 8;
        assert_eq!(
            evaluate_idle(&context, &Default::default()),
            ContinuationDecision::StayIdle {
                reason: "manual_intervention_required",
                notify_once: true,
            }
        );
        let mut context = idle();
        context.consecutive_failures = 3;
        assert!(matches!(
            evaluate_idle(&context, &Default::default()),
            ContinuationDecision::StayIdle {
                reason: "consecutive_failures",
                notify_once: true
            }
        ));
        let mut context = idle();
        context.stalled_rounds = 5;
        assert!(matches!(
            evaluate_idle(&context, &Default::default()),
            ContinuationDecision::StayIdle {
                reason: "stalled",
                notify_once: true
            }
        ));
    }

    #[test]
    fn persisted_stop_notifies_once_and_explicit_user_reset_allows_a_new_claim() {
        let temp = tempfile::tempdir().unwrap();
        let store = PlanStore::for_workspace(temp.path());
        let plan = "# P\n\n## Context\nC\n\n## TODOs\n- [ ] 1. T\n  - artifacts: a\n  - write_scope: a\n  - acceptance: a\n  - verify: a\n\n## Final Verification Wave\n- [ ] F1. V\n  - evidence: manual\n";
        let work = store.create_work("stop", plan, "s", true).unwrap();
        let settings = OrchestrateContinuationSettings {
            max_auto_turns: 1,
            ..Default::default()
        };

        assert!(matches!(
            claim_for_workspace(temp.path(), &settings, idle()).unwrap(),
            ClaimedContinuation::Enqueued { .. }
        ));
        store
            .record_continuation_outcome(&work.work.work_id, false)
            .unwrap();
        assert!(matches!(
            claim_for_workspace(temp.path(), &settings, idle()).unwrap(),
            ClaimedContinuation::StayIdle {
                reason: "manual_intervention_required",
                notify_once: true
            }
        ));
        assert!(matches!(
            claim_for_workspace(temp.path(), &settings, idle()).unwrap(),
            ClaimedContinuation::StayIdle {
                notify_once: false,
                ..
            }
        ));

        store
            .reset_auto_continuation_after_user_input(&work.work.work_id, work.work.revision)
            .unwrap();
        assert!(matches!(
            claim_for_workspace(temp.path(), &settings, idle()).unwrap(),
            ClaimedContinuation::Enqueued { .. }
        ));
    }
}
