//! Orchestrate control runtime within the shared engine ownership boundary.

use super::*;

impl QueryEngine {
    pub fn claim_orchestrate_idle_continuation(
        &self,
        request: orchestrate::continuation::IdleRequest,
    ) -> anyhow::Result<orchestrate::continuation::ClaimedContinuation> {
        if !self.state.session_mode().is_orchestrate() {
            return Ok(orchestrate::continuation::ClaimedContinuation::NotApplicable);
        }
        let tasks = self.state.tasks();
        let tracked_agents_running = tasks
            .values()
            .filter(|task| {
                matches!(task.kind, kcoder_state::TaskKind::Subagent)
                    && task.notify_parent_on_completion
                    && matches!(
                        task.status,
                        kcoder_state::TaskStatus::Pending | kcoder_state::TaskStatus::Running
                    )
            })
            .count();
        let manual_intervention_required = tasks.values().any(|task| {
            task.kind == kcoder_state::TaskKind::Subagent
                && (matches!(
                    task.status,
                    kcoder_state::TaskStatus::Paused | kcoder_state::TaskStatus::Halted
                ) || task.message_queue.first().is_some_and(|message| {
                    message.status == kcoder_state::AgentMessageStatus::Blocked
                }) || matches!(
                    task.breaker.stage,
                    kcoder_state::BreakerStage::Paused | kcoder_state::BreakerStage::Halted
                ))
        });
        let continuation = recover_read_lock(&self.settings, "settings")
            .orchestrate
            .continuation
            .clone();
        let claimed = orchestrate::continuation::claim_for_workspace(
            &self.cwd,
            &continuation,
            orchestrate::continuation::IdleContext {
                turn_finished: true,
                pending_question: request.pending_question,
                cancelled: request.cancelled,
                compaction_in_flight: request.compaction_in_flight,
                internal_prompt: request.internal_prompt,
                continuation_in_flight: false,
                manual_intervention_required,
                tracked_agents_running,
                active_work_incomplete: false,
                dedupe_already_queued: request.dedupe_already_queued,
                cooldown_elapsed: request.cooldown_elapsed,
                consecutive_failures: 0,
                stalled_rounds: 0,
                auto_turns: 0,
                goal_limit_reached: request.goal_limit_reached,
            },
        )?;
        let active_work_id = kcoder_state::orchestrate_store::PlanStore::for_workspace(&self.cwd)
            .active_work_id()
            .ok()
            .flatten();
        match &claimed {
            orchestrate::continuation::ClaimedContinuation::Enqueued { .. } => {
                self.state.record_orchestrate_runtime_event_after_commit(
                    "continuation_claimed",
                    active_work_id.as_deref(),
                    None,
                    None,
                    None,
                    serde_json::json!({"source": "idle_runtime"}),
                );
            }
            orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason,
                notify_once,
            } if *notify_once => {
                self.state.record_orchestrate_runtime_event_after_commit(
                    "continuation_blocked",
                    active_work_id.as_deref(),
                    None,
                    None,
                    None,
                    serde_json::json!({"reason": reason}),
                );
            }
            _ => {}
        }
        Ok(claimed)
    }

    pub fn acknowledge_orchestrate_user_input(&self) -> anyhow::Result<()> {
        if !self.state.session_mode().is_orchestrate() {
            return Ok(());
        }
        let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&self.cwd);
        let Some(work_id) = store.active_work_id()? else {
            return Ok(());
        };
        let snapshot = store.read_work(&work_id)?;
        let continuation = store.read_continuation_state(&work_id)?;
        if continuation.manual_intervention_required {
            store.reset_auto_continuation_after_user_input(&work_id, snapshot.work.revision)?;
        }
        Ok(())
    }

    /// Finalize one automatic continuation claimed from the PlanStore. This method
    /// is safe during regular user turns: it does not change failure counts when
    /// the side state has no in-flight claim.
    pub fn record_orchestrate_continuation_outcome(&self, failed: bool) -> anyhow::Result<()> {
        if !self.state.session_mode().is_orchestrate() {
            return Ok(());
        }
        let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&self.cwd);
        let Some(work_id) = store.active_work_id()? else {
            return Ok(());
        };
        store.record_continuation_outcome(&work_id, failed)?;
        self.state.record_orchestrate_runtime_event_after_commit(
            "continuation_finished",
            Some(&work_id),
            None,
            None,
            None,
            serde_json::json!({"failed": failed}),
        );
        Ok(())
    }

    pub(super) fn orchestrate_provenance(&self) -> Option<OrchestrateProvenance> {
        self.orchestrate_runtime_context()
            .map(|context| context.provenance)
    }

    pub fn orchestrate_runtime_context(&self) -> Option<orchestrate::OrchestrateRuntimeContext> {
        if self.state.session_mode().is_orchestrate() {
            let work_id = kcoder_state::orchestrate_store::PlanStore::for_workspace(&self.cwd)
                .active_work_id()
                .ok()
                .flatten();
            Some(orchestrate::OrchestrateRuntimeContext {
                provenance: OrchestrateProvenance::Session,
                work_id,
                policy_profile: "orchestrate_session_v1",
            })
        } else if self.is_arrangement_mode_active() {
            Some(orchestrate::OrchestrateRuntimeContext {
                provenance: OrchestrateProvenance::Goal,
                work_id: None,
                policy_profile: "arrangement_legacy_v1",
            })
        } else {
            None
        }
    }
}
