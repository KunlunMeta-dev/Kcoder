use super::*;
use kcoder_config::OrchestrateBreakerSettings;

impl AppState {
    /// Record a hashed tool action; raw tool input never enters circuit-breaker state.
    pub fn record_agent_action_signal(&self, id: &str, fingerprint: &str) -> anyhow::Result<bool> {
        let fingerprint = fingerprint.to_string();
        let result = self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent {
                return Ok(false);
            }
            if task.breaker.last_action_fingerprint.as_deref() == Some(fingerprint.as_str()) {
                task.breaker.repeated_action_count =
                    task.breaker.repeated_action_count.saturating_add(1);
            } else {
                task.breaker.last_action_fingerprint = Some(fingerprint);
                task.breaker.repeated_action_count = 1;
            }
            task.breaker.signal_sequence = task.breaker.signal_sequence.saturating_add(1);
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }

    /// Record a hashed tool result and runtime error; only a new structured result resets the no-progress count.
    pub fn record_agent_result_signal(
        &self,
        id: &str,
        fingerprint: &str,
        is_error: bool,
    ) -> anyhow::Result<bool> {
        let fingerprint = fingerprint.to_string();
        let result = self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent {
                return Ok(false);
            }
            let changed =
                task.breaker.last_tool_result_fingerprint.as_deref() != Some(fingerprint.as_str());
            task.breaker.last_tool_result_fingerprint = Some(fingerprint.clone());
            if is_error {
                task.breaker.consecutive_runtime_errors =
                    task.breaker.consecutive_runtime_errors.saturating_add(1);
                task.breaker.no_progress_rounds = task.breaker.no_progress_rounds.saturating_add(1);
            } else if changed {
                task.breaker.consecutive_runtime_errors = 0;
                task.breaker.no_progress_rounds = 0;
                task.breaker.repeated_action_count = 0;
                task.breaker.last_progress_fingerprint = Some(fingerprint);
                if matches!(
                    task.breaker.stage,
                    BreakerStage::Steered | BreakerStage::Constrained
                ) {
                    task.breaker.stage = BreakerStage::Healthy;
                    task.breaker.reason_codes.clear();
                    task.breaker.tool_gate.clear();
                    task.control.pending_steer = None;
                    task.breaker.last_transition_at_ms = now_millis();
                }
            } else {
                task.breaker.consecutive_runtime_errors = 0;
                task.breaker.no_progress_rounds = task.breaker.no_progress_rounds.saturating_add(1);
            }
            task.breaker.signal_sequence = task.breaker.signal_sequence.saturating_add(1);
            task.updated_at_ms = now_millis();
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }

    /// Evaluate each new signal at most once per provider/tool boundary.
    pub fn evaluate_agent_breaker(
        &self,
        id: &str,
        settings: &OrchestrateBreakerSettings,
    ) -> anyhow::Result<Option<BreakerDecision>> {
        if !settings.enabled {
            return Ok(None);
        }
        let result = self.transact_task(id, |task| {
            if task.kind != TaskKind::Subagent
                || task.breaker.signal_sequence <= task.breaker.last_evaluated_signal_sequence
            {
                return Ok(None);
            }
            task.breaker.last_evaluated_signal_sequence = task.breaker.signal_sequence;
            let mut reasons = Vec::new();
            if task.breaker.repeated_action_count >= settings.repeated_action_threshold {
                reasons.push("repeated_action_threshold".to_string());
            }
            if task.breaker.consecutive_runtime_errors >= settings.consecutive_error_threshold {
                reasons.push("consecutive_runtime_error_threshold".to_string());
            }
            if task.breaker.no_progress_rounds >= settings.no_progress_rounds {
                reasons.push("no_progress_threshold".to_string());
            }
            if reasons.is_empty() {
                return Ok(None);
            }
            let previous_stage = task.breaker.stage;
            let mut stage = match previous_stage {
                BreakerStage::Healthy => BreakerStage::Steered,
                BreakerStage::Steered => BreakerStage::Constrained,
                BreakerStage::Constrained => BreakerStage::Paused,
                BreakerStage::Paused if settings.hard_stop => BreakerStage::Halted,
                BreakerStage::Paused => BreakerStage::Paused,
                BreakerStage::Halted => BreakerStage::Halted,
            };
            let safe_gate = if stage == BreakerStage::Constrained {
                breaker_safe_tool_gate(task)
            } else {
                Vec::new()
            };
    // An empty gate means no extra restriction in the engine, so pause when a safe subset cannot be formed.
            if stage == BreakerStage::Constrained && safe_gate.is_empty() {
                stage = BreakerStage::Paused;
                reasons.push("no_safe_tool_subset".to_string());
            }
            if stage == previous_stage {
                return Ok(None);
            }
            let now = now_millis();
            task.breaker.stage = stage;
            task.breaker.reason_codes = reasons.clone();
            task.breaker.last_transition_at_ms = now;
            match stage {
                BreakerStage::Steered | BreakerStage::Constrained => {
                    if stage == BreakerStage::Constrained {
                        task.breaker.tool_gate = safe_gate;
                    }
                    let steer_id = format!("steer-{}", uuid::Uuid::new_v4());
                    task.control.pending_steer = Some(PendingSteer {
                        steer_id,
                        source: "breaker".to_string(),
                        message: format!(
                            "Runtime detected {}; change strategy and produce a new structured progress signal before repeating the same action.",
                            reasons.join(", ")
                        ),
                        created_at_ms: now,
                    });
                }
                BreakerStage::Paused => {
                    if task.control.run_mode == AgentRunMode::Running {
                        task.control.run_mode = AgentRunMode::PauseRequested;
                        task.control.revision = task.control.revision.saturating_add(1);
                        task.control.updated_at_ms = now;
                    }
                }
                BreakerStage::Halted => {
                    if matches!(
                        task.control.run_mode,
                        AgentRunMode::Running
                            | AgentRunMode::PauseRequested
                            | AgentRunMode::Paused
                    ) {
                        task.control.run_mode = AgentRunMode::HaltRequested;
                        task.control.revision = task.control.revision.saturating_add(1);
                        task.control.updated_at_ms = now;
                    }
                }
                BreakerStage::Healthy => {}
            }
            task.updated_at_ms = now;
            Ok(Some(BreakerDecision {
                agent_id: id.to_string(),
                previous_stage,
                stage,
                reason_codes: reasons,
                signal_sequence: task.breaker.signal_sequence,
            }))
        })?;
        let decision = result.flatten();
        if let Some(decision) = decision.as_ref() {
            let task = self.task(id);
            self.record_orchestrate_runtime_event_after_commit(
                "breaker_transition",
                task.as_ref()
                    .and_then(|task| task.orchestrate_work_id.as_deref()),
                None,
                Some(id),
                None,
                serde_json::json!({
                    "from": format!("{:?}", decision.previous_stage).to_ascii_lowercase(),
                    "to": format!("{:?}", decision.stage).to_ascii_lowercase(),
                    "reason_codes": decision.reason_codes,
                    "signal_sequence": decision.signal_sequence,
                }),
            );
        }
        Ok(decision)
    }

    pub fn pending_agent_steer(&self, id: &str) -> Option<PendingSteer> {
        self.task(id)?.control.pending_steer
    }

    pub fn acknowledge_agent_steer(&self, id: &str, steer_id: &str) -> anyhow::Result<bool> {
        let result = self.transact_task(id, |task| {
            if task
                .control
                .pending_steer
                .as_ref()
                .map(|steer| steer.steer_id.as_str())
                != Some(steer_id)
            {
                return Ok(false);
            }
            task.control.pending_steer = None;
            task.control.updated_at_ms = now_millis();
            task.updated_at_ms = task.control.updated_at_ms;
            Ok(true)
        })?;
        Ok(result.unwrap_or(false))
    }
}

fn breaker_safe_tool_gate(task: &Task) -> Vec<String> {
    const SAFE_TOOLS: &[&str] = &[
        "read",
        "grep",
        "glob",
        "agentfleet",
        "planprogress",
        "taskoutput",
        "wait",
    ];
    let base = if task.control.tool_gate.is_empty() {
        &task.resolved_tool_allowlist
    } else {
        &task.control.tool_gate
    };
    let mut tools = base
        .iter()
        .filter(|tool| {
            SAFE_TOOLS
                .iter()
                .any(|safe| tool.to_ascii_lowercase() == *safe)
        })
        .cloned()
        .collect::<Vec<_>>();
    tools.sort();
    tools.dedup();
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(state: &AppState) -> Task {
        let mut task = Task::new("agent-breaker", "breaker test");
        task.kind = TaskKind::Subagent;
        task.managed = true;
        task.status = TaskStatus::Running;
        task.parent_session_id = Some(state.session_id());
        task.resolved_tool_allowlist = vec!["read".to_string(), "bash".to_string()];
        task
    }

    #[test]
    fn breaker_escalates_once_per_new_signal_and_progress_recovers() {
        let state = AppState::new("/tmp/kcoder-breaker");
        state.upsert_task(task(&state));
        let settings = OrchestrateBreakerSettings {
            enabled: true,
            hard_stop: false,
            repeated_action_threshold: 2,
            consecutive_error_threshold: 2,
            no_progress_rounds: 2,
        };
        state
            .record_agent_action_signal("agent-breaker", "same")
            .unwrap();
        state
            .record_agent_action_signal("agent-breaker", "same")
            .unwrap();
        let first = state
            .evaluate_agent_breaker("agent-breaker", &settings)
            .unwrap()
            .unwrap();
        assert_eq!(first.stage, BreakerStage::Steered);
        assert!(
            state
                .evaluate_agent_breaker("agent-breaker", &settings)
                .unwrap()
                .is_none()
        );
        state
            .record_agent_result_signal("agent-breaker", "new-result", false)
            .unwrap();
        let task = state.task("agent-breaker").unwrap();
        assert_eq!(task.breaker.stage, BreakerStage::Healthy);
        assert_eq!(task.breaker.no_progress_rounds, 0);
    }

    #[test]
    fn breaker_constrains_to_safe_spawn_subset_then_pauses_without_hard_stop() {
        let state = AppState::new("/tmp/kcoder-breaker-escalation");
        state.upsert_task(task(&state));
        let settings = OrchestrateBreakerSettings {
            enabled: true,
            hard_stop: false,
            repeated_action_threshold: 2,
            consecutive_error_threshold: 99,
            no_progress_rounds: 99,
        };
        for expected in [BreakerStage::Steered, BreakerStage::Constrained] {
            state
                .record_agent_action_signal("agent-breaker", "same")
                .unwrap();
            state
                .record_agent_action_signal("agent-breaker", "same")
                .unwrap();
            let decision = state
                .evaluate_agent_breaker("agent-breaker", &settings)
                .unwrap()
                .unwrap();
            assert_eq!(decision.stage, expected);
        }
        let constrained = state.task("agent-breaker").unwrap();
        assert_eq!(constrained.breaker.tool_gate, ["read"]);

        state
            .record_agent_action_signal("agent-breaker", "same")
            .unwrap();
        let paused = state
            .evaluate_agent_breaker("agent-breaker", &settings)
            .unwrap()
            .unwrap();
        assert_eq!(paused.stage, BreakerStage::Paused);
        assert_eq!(
            state.task("agent-breaker").unwrap().control.run_mode,
            AgentRunMode::PauseRequested
        );
        state
            .record_agent_action_signal("agent-breaker", "same")
            .unwrap();
        assert!(
            state
                .evaluate_agent_breaker("agent-breaker", &settings)
                .unwrap()
                .is_none()
        );
        assert_ne!(
            state.task("agent-breaker").unwrap().breaker.stage,
            BreakerStage::Halted
        );
    }

    #[test]
    fn changed_actions_do_not_accumulate_and_repeated_results_count_no_progress() {
        let state = AppState::new("/tmp/kcoder-breaker-progress");
        state.upsert_task(task(&state));
        state
            .record_agent_action_signal("agent-breaker", "action-a")
            .unwrap();
        state
            .record_agent_action_signal("agent-breaker", "action-b")
            .unwrap();
        assert_eq!(
            state
                .task("agent-breaker")
                .unwrap()
                .breaker
                .repeated_action_count,
            1
        );
        for _ in 0..3 {
            state
                .record_agent_result_signal("agent-breaker", "same-result", false)
                .unwrap();
        }
        let settings = OrchestrateBreakerSettings {
            enabled: true,
            hard_stop: false,
            repeated_action_threshold: 99,
            consecutive_error_threshold: 99,
            no_progress_rounds: 2,
        };
        let decision = state
            .evaluate_agent_breaker("agent-breaker", &settings)
            .unwrap()
            .unwrap();
        assert_eq!(decision.stage, BreakerStage::Steered);
        assert_eq!(decision.reason_codes, ["no_progress_threshold"]);
    }

    #[test]
    fn explicit_resume_resets_a_breaker_pause_without_clearing_manual_gate() {
        let state = AppState::new("/tmp/kcoder-breaker-resume");
        let mut task = task(&state);
        task.status = TaskStatus::Paused;
        task.control.run_mode = AgentRunMode::Paused;
        task.control.tool_gate = vec!["read".to_string()];
        task.breaker.stage = BreakerStage::Paused;
        task.breaker.tool_gate = vec!["read".to_string()];
        task.breaker.repeated_action_count = 9;
        task.breaker.no_progress_rounds = 9;
        state.upsert_task(task);

        state
            .request_agent_control(
                "agent-breaker",
                &state.session_id(),
                AgentControlAction::Resume,
                0,
                "operator reviewed the pause",
                &[],
                None,
            )
            .unwrap();

        let task = state.task("agent-breaker").unwrap();
        assert_eq!(task.breaker.stage, BreakerStage::Healthy);
        assert_eq!(task.breaker.repeated_action_count, 0);
        assert_eq!(task.breaker.no_progress_rounds, 0);
        assert!(task.breaker.tool_gate.is_empty());
        assert_eq!(task.control.tool_gate, ["read"]);
    }
}
