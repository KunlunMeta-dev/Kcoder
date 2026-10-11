//! Goal requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_GOAL_GET => {
            let result = serde_json::from_value::<ThreadGoalParams>(params)
                .context("invalid thread/goal/get params")
                .and_then(|params| {
                    let goal = if let Some(target_engine) = thread_manager.select(&params.thread_id)
                    {
                        ensure_active_thread(
                            &target_engine,
                            thread_manager.lease(&params.thread_id),
                            &params.thread_id,
                        )?;
                        target_engine.state.goal()
                    } else {
                        let history_path =
                            thread_history_path(workspace_engine, &params.thread_id)?;
                        kcoder_state::history_persisted_goal(&history_path)?
                    };
                    Ok(ThreadGoalGetResult {
                        thread_id: params.thread_id.clone(),
                        goal: goal.map(|goal| thread_goal(&params.thread_id, &goal)),
                    })
                });
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32032, &error.to_string())).await?;
                }
            }
        }
        method::THREAD_GOAL_HISTORY => {
            let result = serde_json::from_value::<ThreadGoalParams>(params)
                .context("invalid thread/goal/history params")
                .and_then(|params| {
                    let (mut goals, current) =
                        if let Some(target_engine) = thread_manager.select(&params.thread_id) {
                            ensure_active_thread(
                                &target_engine,
                                thread_manager.lease(&params.thread_id),
                                &params.thread_id,
                            )?;
                            (
                                target_engine.state.goal_history(),
                                target_engine.state.goal(),
                            )
                        } else {
                            let history_path =
                                thread_history_path(workspace_engine, &params.thread_id)?;
                            (
                                kcoder_state::history_persisted_goal_history(&history_path)?,
                                kcoder_state::history_persisted_goal(&history_path)?,
                            )
                        };
                    if let Some(goal) = current
                        && goal.status.is_history_worthy()
                        && !goals.iter().any(|entry| entry.goal_id == goal.goal_id)
                    {
                        goals.push(goal);
                    }
                    Ok(ThreadGoalHistoryResult {
                        goals: goals
                            .iter()
                            .map(|goal| thread_goal(&params.thread_id, goal))
                            .collect(),
                        thread_id: params.thread_id,
                    })
                });
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32040, &error.to_string())).await?
                }
            }
        }
        method::THREAD_GOAL_SET => {
            let goal_turn_state = params
                .get("threadId")
                .and_then(Value::as_str)
                .and_then(|id| thread_manager.turn_state(id));
            let _goal_gate = match goal_turn_state.as_ref() {
                Some(state) => Some(state.activity_gate.lock().await),
                None => None,
            };
            let goal_turn_cancel = match goal_turn_state.as_ref() {
                Some(state) => state
                    .active_turn
                    .lock()
                    .await
                    .as_ref()
                    .map(|turn| turn.cancel.clone()),
                None => None,
            };
            let result = serde_json::from_value::<ThreadGoalSetParams>(params)
                .context("invalid thread/goal/set params")
                .and_then(|params| {
                    let target_engine = thread_manager
                        .select(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&params.thread_id),
                        &params.thread_id,
                    )?;
                    let status = params
                        .status
                        .as_deref()
                        .map(parse_goal_status)
                        .transpose()?;
                    let mode = params.mode.as_deref().map(parse_goal_mode).transpose()?;
                    let verification_kind = params
                        .verification_kind
                        .as_deref()
                        .map(parse_goal_verification_kind)
                        .transpose()?;
                    let current_goal = target_engine.state.goal();
                    if params.edit
                        && (params.expected_goal_id.is_none() || params.expected_revision.is_none())
                    {
                        anyhow::bail!("goal edit requires expectedGoalId and expectedRevision")
                    }
                    ensure_goal_precondition(
                        current_goal.as_ref(),
                        params.expected_goal_id.as_deref(),
                        params.expected_revision,
                        params.require_no_goal,
                    )?;
                    if params.objective.is_some()
                        && mode == Some(GoalMode::Strict)
                        && status == Some(GoalStatus::Complete)
                    {
                        anyhow::bail!(
                            "strict goal completion must pass the update_goal verifier gate"
                        )
                    }
                    let resume_requested = params.objective.is_none()
                        && status == Some(GoalStatus::Active)
                        && !params.edit;
                    let followups = thread_manager
                        .followups(&params.thread_id)
                        .context("thread has no scheduler")?;
                    let mut lifecycle = followups.goals.lock().unwrap();
                    let mut goal = if let Some(objective) = params.objective {
                        let objective = objective.trim();
                        if objective.is_empty() {
                            anyhow::bail!("goal objective must not be empty")
                        }
                        if params.edit {
                            if mode.is_some() || verification_kind.is_some() || status.is_some() {
                                anyhow::bail!(
                                    "goal edit cannot change mode, verification kind, or status"
                                )
                            }
                            let existing = target_engine
                                .state
                                .goal()
                                .context("thread has no active goal")?;
                            if !existing.status.is_unfinished() {
                                anyhow::bail!("terminal goal cannot be edited")
                            }
                            target_engine
                                .state
                                .edit_goal(objective, None, params.token_budget)
                                .context("goal disappeared while editing")?
                        } else {
                            let mode = mode.unwrap_or(GoalMode::Standard);
                            let verification_kind =
                                verification_kind.unwrap_or(GoalVerificationKind::Artifact);
                            let context_snapshot = kcoder_state::goal_context_snapshot(
                                &target_engine.state.messages(),
                            );
                            let verifier_selection = if mode.is_strict() {
                                goal_pro_verifier_selection(&target_engine)
                            } else {
                                GoalVerifierSelection::default()
                            };
                            let goal = target_engine
                                .state
                                .set_goal_prepared_with_mode_and_verification_and_verifier(
                                    objective,
                                    None,
                                    params.token_budget,
                                    mode,
                                    verification_kind,
                                    verifier_selection,
                                )?;
                            let goal = if mode.is_strict() {
                                target_engine
                                    .state
                                    .set_goal_context_snapshot(context_snapshot)
                                    .unwrap_or(goal)
                            } else {
                                goal
                            };
                            match status {
                                Some(GoalStatus::Active) | None => goal,
                                Some(GoalStatus::Cancelled) => {
                                    lifecycle.invalidate();
                                    target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                                    target_engine
                                        .state
                                        .cancel_goal_by_user()?
                                        .context("goal cannot be cancelled")?
                                }
                                Some(status) => target_engine
                                    .state
                                    .update_goal_status(status)
                                    .context("goal disappeared while updating status")?,
                            }
                        }
                    } else {
                        if params.edit {
                            anyhow::bail!("goal edit requires an objective")
                        }
                        if mode.is_some() {
                            anyhow::bail!("goal mode can only be supplied when creating a goal")
                        }
                        if verification_kind.is_some() {
                            anyhow::bail!(
                                "goal verification kind can only be supplied when creating a goal"
                            )
                        }
                        let existing = target_engine
                            .state
                            .goal()
                            .context("thread has no active goal")?;
                        ensure_goal_status_transition(existing.status, status)?;
                        if existing.mode.is_strict() && status == Some(GoalStatus::Complete) {
                            anyhow::bail!(
                                "strict goal completion must pass the update_goal verifier gate"
                            )
                        }
                        match status {
                            Some(GoalStatus::Cancelled) => {
                                lifecycle.invalidate();
                                target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                                target_engine
                                    .state
                                    .cancel_goal_by_user()?
                                    .context("goal cannot be cancelled")?
                            }
                            Some(status) if status != existing.status => target_engine
                                .state
                                .update_goal_status(status)
                                .context("goal disappeared while updating status")?,
                            _ => existing,
                        }
                    };
                    if params.clear_token_budget || params.token_budget.is_some() {
                        goal = target_engine
                            .state
                            .update_goal_token_budget(params.token_budget)
                            .context("goal disappeared while updating token budget")?;
                    }
                    if goal.status == GoalStatus::Cancelled {
                        target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                    }
                    if resume_requested {
                        lifecycle.resume(&target_engine);
                    } else {
                        lifecycle.invalidate();
                    }
                    followups.notify.notify_one();
                    Ok(ThreadGoalSetResult {
                        thread_id: params.thread_id.clone(),
                        goal: thread_goal(&params.thread_id, &goal),
                    })
                });
            match result {
                Ok(mut result) => {
                    if let Some(target_engine) = thread_manager.select(&result.thread_id)
                        && let Some(goal) = target_engine.state.goal()
                        && goal.mode.is_strict()
                    {
                        match kcoder_engine::agent::ensure_goal_pro_workspace_baseline(
                            &target_engine.state,
                            &goal,
                        )
                        .await
                        {
                            Ok(goal) => {
                                result.goal = thread_goal(&result.thread_id, &goal);
                            }
                            Err(error) => {
                                target_engine.state.clear_goal();
                                send(
                                        outbound_tx,
                                        error_response(
                                            id,
                                            -32033,
                                            &format!(
                                                "failed to capture Goal Pro verifier baseline; the goal was cleared: {error}"
                                            ),
                                        ),
                                    )
                                    .await?;
                                return Ok(DispatchControl::Continue);
                            }
                        }
                    }
                    if let Some(engine) = thread_manager.engine(&result.thread_id) {
                        goal_lifecycle::publish(&engine, outbound_tx).await;
                    }
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32033, &error.to_string())).await?;
                }
            }
        }
        method::THREAD_GOAL_CLEAR => {
            let goal_turn_state = params
                .get("threadId")
                .and_then(Value::as_str)
                .and_then(|id| thread_manager.turn_state(id));
            let _goal_gate = match goal_turn_state.as_ref() {
                Some(state) => Some(state.activity_gate.lock().await),
                None => None,
            };
            let goal_turn_cancel = match goal_turn_state.as_ref() {
                Some(state) => state
                    .active_turn
                    .lock()
                    .await
                    .as_ref()
                    .map(|turn| turn.cancel.clone()),
                None => None,
            };
            let result = serde_json::from_value::<ThreadGoalParams>(params)
                .context("invalid thread/goal/clear params")
                .and_then(|params| {
                    let target_engine = thread_manager
                        .select(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&params.thread_id),
                        &params.thread_id,
                    )?;
                    let current_goal = target_engine.state.goal();
                    ensure_goal_precondition(
                        current_goal.as_ref(),
                        params.expected_goal_id.as_deref(),
                        params.expected_revision,
                        false,
                    )?;
                    let followups = thread_manager
                        .followups(&params.thread_id)
                        .context("thread has no scheduler")?;
                    let mut lifecycle = followups.goals.lock().unwrap();
                    lifecycle.invalidate();
                    followups.notify.notify_one();
                    if current_goal.as_ref().is_some_and(|goal| {
                        goal.status.is_unfinished() || goal.status.is_user_resumable()
                    }) {
                        target_engine.cancel_goal_execution(goal_turn_cancel.as_ref());
                    }
                    let removed = target_engine.state.clear_goal_by_user()?;
                    Ok(ThreadGoalClearResult {
                        thread_id: params.thread_id,
                        cleared: removed.is_some(),
                    })
                });
            match result {
                Ok(result) => {
                    if let Some(engine) = thread_manager.engine(&result.thread_id) {
                        goal_lifecycle::publish(&engine, outbound_tx).await;
                    }
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32034, &error.to_string())).await?;
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
