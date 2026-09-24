use kcoder_config::PermissionMode;
use kcoder_engine::{QueryEngine, goal_continuation};
use kcoder_state::GoalStatus;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

pub(super) async fn publish(
    engine: &QueryEngine,
    outbound: &tokio::sync::mpsc::Sender<serde_json::Value>,
) {
    let thread_id = engine.session_id();
    let goal = engine
        .state
        .goal()
        .map(|goal| super::thread_goal(&thread_id, &goal));
    if let Ok(value) =
        serde_json::to_value(kcoder_app_protocol::ThreadGoalGetResult { thread_id, goal })
    {
        let _ = super::send(
            outbound,
            super::notification(kcoder_app_protocol::method::THREAD_GOAL_UPDATED, value),
        )
        .await;
    }
}

pub(super) async fn publish_continuation(
    engine: &QueryEngine,
    outbound: &tokio::sync::mpsc::Sender<serde_json::Value>,
    status: &str,
    turn_id: Option<&str>,
    reason: Option<String>,
) {
    let value = kcoder_app_protocol::ThreadGoalContinuationParams {
        thread_id: engine.session_id(),
        status: status.into(),
        turn_id: turn_id.map(str::to_owned),
        reason,
    };
    if let Ok(value) = serde_json::to_value(value) {
        let _ = super::send(
            outbound,
            super::notification(kcoder_app_protocol::method::THREAD_GOAL_CONTINUATION, value),
        )
        .await;
    }
}

pub(super) const COOLDOWN: Duration = Duration::from_millis(400);

pub(super) struct GoalLifecycle {
    generation: u64,
    ready: Option<(String, Instant, Option<PermissionMode>)>,
    automatic: Option<CancellationToken>,
    counted_goal: Option<String>,
    started: usize,
    limit_notified: bool,
    permissions: Option<(String, Option<PermissionMode>)>,
    suspended: bool,
}

impl Default for GoalLifecycle {
    fn default() -> Self {
        Self {
            generation: 0,
            ready: None,
            automatic: None,
            counted_goal: None,
            started: 0,
            limit_notified: false,
            permissions: None,
            suspended: true,
        }
    }
}

pub(super) struct GoalTurn {
    generation: u64,
    goal_id: Option<String>,
    started: Instant,
    pub(super) permission_mode: Option<PermissionMode>,
}

impl GoalTurn {
    pub(super) fn tracks_goal(&self) -> bool {
        self.goal_id.is_some()
    }
}

impl GoalLifecycle {
    pub(super) fn suspend(&mut self) {
        self.invalidate();
        self.suspended = true;
    }

    pub(super) fn is_suspended(&self) -> bool {
        self.suspended
    }
    pub(super) fn invalidate(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.ready = None;
        if let Some(cancel) = self.automatic.take() {
            cancel.cancel();
        }
    }

    pub(super) fn resume(&mut self, engine: &QueryEngine) {
        self.invalidate();
        self.suspended = false;
        if let Some(goal) = engine.state.goal().filter(|goal| {
            goal_continuation::plan_goal_continuation(
                engine.settings.read().unwrap().goal_enabled,
                goal,
                None,
            )
            .is_some()
        }) {
            let mode = self
                .permissions
                .as_ref()
                .filter(|(id, _)| *id == goal.goal_id)
                .and_then(|(_, mode)| *mode);
            self.ready = Some((goal.goal_id, Instant::now() + COOLDOWN, mode));
            self.limit_notified = false;
        }
    }

    pub(super) fn ready(&mut self, engine: &QueryEngine) -> bool {
        let valid = self.ready.as_ref().is_some_and(|(id, _, _)| {
            engine.state.goal().is_some_and(|goal| {
                goal.goal_id == *id
                    && goal_continuation::plan_goal_continuation(
                        engine.settings.read().unwrap().goal_enabled,
                        &goal,
                        None,
                    )
                    .is_some()
            })
        });
        if !valid {
            self.ready = None;
        }
        self.ready
            .as_ref()
            .is_some_and(|(_, at, _)| *at <= Instant::now())
    }

    pub(super) fn pending(&self) -> bool {
        self.ready.is_some()
    }

    pub(super) fn automatic_allowed(&mut self, engine: &QueryEngine) -> bool {
        let Some(goal) = engine.state.goal().filter(|goal| goal.status.is_active()) else {
            return true;
        };
        if self.counted_goal.as_deref() != Some(&goal.goal_id) {
            self.counted_goal = Some(goal.goal_id.clone());
            self.started = 0;
            self.limit_notified = false;
        }
        let settings = engine.settings.read().unwrap();
        !settings.goal_enabled
            || (!goal.budget_exhausted()
                && !goal_continuation::auto_continuation_limit_reached(
                    settings.goal_max_auto_continuations,
                    self.started,
                ))
    }

    pub(super) fn take_limit_notice(&mut self, engine: &QueryEngine) -> Option<String> {
        if self.automatic_allowed(engine) || self.limit_notified {
            return None;
        }
        self.ready = None;
        self.limit_notified = true;
        Some(format!(
            "[goal_auto_continuation_limit] Automatic goal continuation stopped (limit: {}). The goal is not marked complete. Review its state before sending another instruction or creating a new goal.",
            engine.settings.read().unwrap().goal_max_auto_continuations
        ))
    }

    pub(super) fn begin(
        &mut self,
        engine: &QueryEngine,
        permission_mode: Option<PermissionMode>,
        automatic: Option<CancellationToken>,
    ) -> GoalTurn {
        let goal_id = engine.state.goal().map(|goal| goal.goal_id);
        let inherited_mode = if automatic.is_some() {
            self.ready
                .as_ref()
                .and_then(|(_, _, mode)| *mode)
                .or_else(|| {
                    self.permissions
                        .as_ref()
                        .filter(|(id, _)| Some(id) == goal_id.as_ref())
                        .and_then(|(_, mode)| *mode)
                })
        } else {
            None
        };
        self.ready = None;
        self.generation = self.generation.wrapping_add(1);
        if automatic.is_some()
            && let Some(goal) = engine.state.goal().filter(|goal| goal.status.is_active())
        {
            engine.state.record_goal_continuation_start(&goal.goal_id);
            self.started += 1;
        }
        self.automatic = automatic;
        self.suspended = false;
        if let Some(id) = goal_id.as_ref() {
            self.permissions = Some((id.clone(), permission_mode.or(inherited_mode)));
        }
        GoalTurn {
            generation: self.generation,
            goal_id,
            started: Instant::now(),
            permission_mode: permission_mode.or(inherited_mode),
        }
    }

    pub(super) fn finish(
        &mut self,
        engine: &QueryEngine,
        turn: GoalTurn,
        status: &str,
        provider_failure: Option<&kcoder_types::ProviderFailureDetails>,
    ) {
        if self.generation != turn.generation {
            return;
        }
        self.automatic = None;
        let Some(goal) = engine.state.goal().filter(|goal| {
            goal.status.is_active() && turn.goal_id.as_ref().is_none_or(|id| goal.goal_id == *id)
        }) else {
            self.ready = None;
            return;
        };
        if status != "completed" {
            // Operational failures/cancellation must never become retry storms.
            let goal_status = if provider_failure.is_some_and(|details| {
                details.category == kcoder_types::ProviderFailureCategory::QuotaExceeded
            }) {
                GoalStatus::UsageLimited
            } else {
                GoalStatus::Paused
            };
            engine.state.update_goal_status(goal_status);
            self.ready = None;
            return;
        }
        let goal = engine
            .state
            .account_active_goal_usage(0, turn.started.elapsed().as_secs())
            .unwrap_or(goal);
        if goal.budget_exhausted() {
            engine.state.update_goal_status(GoalStatus::BudgetLimited);
            self.ready = None;
        } else if goal_continuation::plan_goal_continuation(
            engine.settings.read().unwrap().goal_enabled,
            &goal,
            None,
        )
        .is_some()
        {
            self.ready = Some((
                goal.goal_id,
                Instant::now() + COOLDOWN,
                turn.permission_mode,
            ));
        }
    }

    pub(super) fn prompt(engine: &QueryEngine) -> Option<String> {
        let goal = engine.state.goal()?;
        let final_text = goal_continuation::latest_assistant_text(&engine.state.messages());
        let decision = goal_continuation::plan_goal_continuation(
            engine.settings.read().unwrap().goal_enabled,
            &goal,
            final_text.as_deref(),
        )?;
        Some(goal_continuation::format_goal_continuation_prompt(
            &goal, &decision,
        ))
    }
}
