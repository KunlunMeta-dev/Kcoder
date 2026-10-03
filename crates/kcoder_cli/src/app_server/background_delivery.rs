//! Background delivery: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn set_active_background_projection(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    thread_id: &str,
    turn_id: &str,
    projection: Arc<Mutex<StreamProjection>>,
) {
    state.lock().await.active = Some(BackgroundTurnProjection {
        thread_id: thread_id.to_string(),
        turn_id: turn_id.to_string(),
        projection,
    });
}

pub(super) async fn clear_active_background_projection(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    thread_id: &str,
    turn_id: &str,
) {
    let mut state = state.lock().await;
    if state
        .active
        .as_ref()
        .is_some_and(|active| active.thread_id == thread_id && active.turn_id == turn_id)
    {
        state.active = None;
    }
}

pub(super) async fn rotate_background_projection(state: &Arc<Mutex<BackgroundProjectionState>>) {
    let mut state = state.lock().await;
    state.active = None;
    state.jobs.clear();
    state.tool_calls.clear();
    state.job_tools.clear();
    state.pending.clear();
    state.associated_jobs.clear();
    state.terminal_jobs.clear();
    state.current_runs.clear();
    state.last_contexts.clear();
    state.forwarded_events.clear();
    state.forwarded_order.clear();
    state.steer_response_gates.clear();
    state.steer_correlations.clear();
}

pub(super) async fn begin_agent_steer_response_gate(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    agent_id: &str,
    client_message_id: Option<String>,
) -> Result<()> {
    let mut state = state.lock().await;
    if state.steer_response_gates.contains_key(agent_id) {
        anyhow::bail!("another agent/steer response is pending for this agent");
    }
    state.steer_response_gates.insert(
        agent_id.to_string(),
        AgentSteerResponseGate {
            client_message_id,
            deferred_applied: Vec::new(),
        },
    );
    Ok(())
}

pub(super) async fn finish_agent_steer_response_gate(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    agent_id: &str,
    message_id: Option<&str>,
) -> Result<()> {
    let deferred = {
        let mut state = state.lock().await;
        let Some(gate) = state.steer_response_gates.remove(agent_id) else {
            return Ok(());
        };
        if let Some(message_id) = message_id {
            const MAX_STEER_CORRELATIONS: usize = 256;
            if state.steer_correlations.len() >= MAX_STEER_CORRELATIONS
                && let Some(oldest) = state.steer_correlations.keys().next().cloned()
            {
                state.steer_correlations.remove(&oldest);
            }
            state.steer_correlations.insert(
                message_id.to_string(),
                AgentSteerCorrelation {
                    agent_id: agent_id.to_string(),
                    client_message_id: gate.client_message_id,
                },
            );
        }
        gate.deferred_applied
    };
    for (context, event) in deferred {
        let Some(context) = context else {
            project_engine_background_event(state, outbound_tx, event).await?;
            continue;
        };
        let client_message_id = if let EngineEvent::SubagentSteerApplied { message_id, .. } =
            event.background_payload()
        {
            state
                .lock()
                .await
                .steer_correlations
                .remove(message_id)
                .and_then(|correlation| correlation.client_message_id)
        } else {
            None
        };
        let messages = context
            .projection
            .lock()
            .await
            .project_with_client_message_id(event, client_message_id);
        for message in messages {
            send(outbound_tx, message).await?;
        }
    }
    Ok(())
}

pub(super) async fn clear_background_followups(state: &BackgroundFollowupState) {
    let mut queue = state.queue.lock().await;
    queue.pending.clear();
    queue.claimed_terminal_ids.clear();
    drop(queue);
    state.notify.notify_waiters();
}

pub(super) async fn queue_background_followup_once(
    state: &BackgroundFollowupState,
    id: String,
    run_started_at_ms: Option<u64>,
    summary: String,
    should_trigger: bool,
) -> bool {
    if !should_trigger {
        return false;
    }
    let mut queue = state.queue.lock().await;
    if !queue.claim_run(&id, run_started_at_ms) {
        return false;
    }
    queue.pending.insert(id, summary);
    drop(queue);
    state.notify.notify_waiters();
    true
}

pub(super) fn followup_run_key(value: &str) -> Option<kcoder_types::BackgroundRunKey> {
    serde_json::from_str(value).ok()
}

pub(super) fn followup_key_is_eligible(engine: &QueryEngine, value: &str) -> bool {
    if let Some(key) = followup_run_key(value) {
        return engine
            .state
            .task_for_background_run(&key)
            .is_some_and(|task| {
                task.kind == TaskKind::Subagent && task.notify_parent_on_completion
            })
            && engine
                .state
                .background_run_record(&key)
                .is_some_and(|record| {
                    record.terminal.is_some()
                        && record.delivered_message_id.is_some()
                        && record.pending_result_message_id.is_none()
                        && !record.suppressed
                        && !record.followup_handled
                        && !record.followup_started
                        && record.delivery == TaskDelivery::Background
                });
    }
    engine.background_job_triggers_followup(value)
}

pub(super) async fn queue_recovered_background_followups(
    engine: &QueryEngine,
    state: &BackgroundFollowupState,
    recovered: Vec<(String, String)>,
    should_trigger: impl Fn(&str) -> bool,
) {
    for (id, summary) in recovered {
        if !should_trigger(&id) {
            continue;
        }
        if let Some(key) = engine.state.task(&id).and_then(|task| task.background_run) {
            let value = serde_json::to_string(&key).expect("run identity serializes");
            if followup_key_is_eligible(engine, &value) {
                queue_background_followup_once(state, value, None, summary, true).await;
            }
        } else {
            let started = engine
                .state
                .task(&id)
                .and_then(|task| task.run_started_at_ms);
            queue_background_followup_once(state, id, started, summary, true).await;
        }
    }
}

pub(super) async fn register_background_tool_call(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    tool_call_id: &str,
    thread_id: &str,
    turn_id: &str,
    projection: Arc<Mutex<StreamProjection>>,
) {
    state.lock().await.tool_calls.insert(
        tool_call_id.to_string(),
        BackgroundTurnProjection {
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            projection,
        },
    );
}

pub(super) fn retire_background_projection(state: &mut BackgroundProjectionState, id: &str) {
    state.terminal_jobs.insert(id.to_owned());
    state.jobs.remove(id);
    state.associated_jobs.remove(id);
    if let Some(tool_call_id) = state.job_tools.remove(id) {
        state.tool_calls.remove(&tool_call_id);
    }
}

pub(super) async fn project_engine_background_event(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: EngineEvent,
) -> Result<()> {
    if let EngineEvent::SubagentSteerApplied { agent_id, .. } = event.background_payload() {
        let mut state = state.lock().await;
        if state.steer_response_gates.contains_key(agent_id) {
            // Capture the projection context now: the run may retire before the
            // steer response is on the wire, and an accepted steer must still be
            // acknowledged afterwards.
            let context = state
                .jobs
                .get(agent_id)
                .cloned()
                .or_else(|| state.last_contexts.get(agent_id).cloned())
                .or_else(|| state.active.clone());
            if let Some(gate) = state.steer_response_gates.get_mut(agent_id) {
                gate.deferred_applied.push((context, event));
            }
            return Ok(());
        }
    }
    let Some(id) = background_event_id(&event).map(str::to_string) else {
        return Ok(());
    };
    let agent_id = id;
    let id = event
        .background_identity()
        .map(|identity| serde_json::to_string(&identity.run).expect("run key serializes"))
        .unwrap_or_else(|| agent_id.clone());
    let mut retired = false;
    let routed = {
        let mut state = state.lock().await;
        if event.background_identity().is_some() {
            if let Some(current) = state.current_runs.get(&agent_id)
                && current != &id
                && !matches!(
                    event.background_payload(),
                    EngineEvent::BackgroundJobStarted { .. }
                        | EngineEvent::BackgroundJobAssociated { .. }
                )
            {
                return Ok(());
            }
            if state.terminal_jobs.contains(&id) {
                return Ok(());
            }
            if let Some(previous) = state.current_runs.insert(agent_id.clone(), id.clone())
                && previous != id
            {
                state.terminal_jobs.insert(previous.clone());
                state.jobs.remove(&previous);
                state.pending.remove(&previous);
                state.associated_jobs.remove(&previous);
                state.job_tools.remove(&previous);
            }
        } else if state.current_runs.contains_key(&agent_id) {
            // An unscoped late event must not mutate a run-aware projection.
            return Ok(());
        }
        if state.terminal_jobs.contains(&id) {
            return Ok(());
        }
        if let EngineEvent::BackgroundJobAssociated { tool_call_id, .. } =
            event.background_payload()
        {
            if state.associated_jobs.contains(&id) {
                return Ok(());
            }
            let context = state
                .jobs
                .get(&id)
                .cloned()
                .or_else(|| state.tool_calls.get(tool_call_id).cloned())
                .or_else(|| {
                    event
                        .background_identity()
                        .and_then(|_| state.active.clone())
                })
                .or_else(|| {
                    event
                        .background_identity()
                        .and_then(|_| state.last_contexts.get(&agent_id).cloned())
                });
            let Some(context) = context else {
                let pending = state.pending.entry(id).or_default();
                if pending.len() < 64 {
                    pending.push(event);
                }
                return Ok(());
            };
            state
                .last_contexts
                .insert(agent_id.clone(), context.clone());
            state.jobs.insert(id.clone(), context.clone());
            state.job_tools.insert(id.clone(), tool_call_id.clone());
            state.associated_jobs.insert(id.clone());
            let pending = state.pending.remove(&id).unwrap_or_default();
            let mut ordered = pending
                .iter()
                .filter(|event| {
                    matches!(
                        event.background_payload(),
                        EngineEvent::BackgroundJobStarted { .. }
                    )
                })
                .cloned()
                .map(|event| (context.clone(), event))
                .collect::<Vec<_>>();
            ordered.push((context.clone(), event));
            ordered.extend(
                pending
                    .into_iter()
                    .filter(|event| {
                        !matches!(
                            event.background_payload(),
                            EngineEvent::BackgroundJobStarted { .. }
                        )
                    })
                    .map(|event| (context.clone(), event)),
            );
            ordered.retain(|(_, event)| {
                if retired
                    && !matches!(
                        event.background_payload(),
                        EngineEvent::SubagentSteerApplied { .. }
                    )
                {
                    return false;
                }
                if !is_background_terminal_event(event) {
                    return true;
                }
                if retired {
                    return false;
                }
                retired = true;
                true
            });
            if retired {
                retire_background_projection(&mut state, &id);
            }
            ordered
        } else {
            if is_background_terminal_event(&event) && state.terminal_jobs.contains(&id) {
                return Ok(());
            }
            let Some(context) = state.jobs.get(&id).cloned() else {
                let pending = state.pending.entry(id).or_default();
                let duplicate_start = matches!(
                    event.background_payload(),
                    EngineEvent::BackgroundJobStarted { .. }
                ) && pending.iter().any(|event| {
                    matches!(
                        event.background_payload(),
                        EngineEvent::BackgroundJobStarted { .. }
                    )
                });
                let must_deliver = matches!(
                    event.background_payload(),
                    EngineEvent::SubagentSteerApplied { .. }
                );
                if pending.len() < 64 && !duplicate_start {
                    pending.push(event);
                } else if must_deliver {
                    if let Some(index) = pending.iter().position(|event| {
                        matches!(
                            event.background_payload(),
                            EngineEvent::BackgroundJobProgress { .. }
                        )
                    }) {
                        pending.remove(index);
                    }
                    pending.push(event);
                }
                return Ok(());
            };
            if is_background_terminal_event(&event) {
                retire_background_projection(&mut state, &id);
                retired = true;
            }
            vec![(context, event)]
        }
    };
    let result = async {
        for (context, event) in routed {
            if let Some(identity) = event.background_identity() {
                let key = serde_json::to_string(&(&identity.run, &identity.event_id))
                    .expect("event key serializes");
                let mut projection_state = state.lock().await;
                if !projection_state.forwarded_events.insert(key.clone()) {
                    continue;
                }
                projection_state.forwarded_order.push_back(key);
                if projection_state.forwarded_order.len() > 65_536
                    && let Some(oldest) = projection_state.forwarded_order.pop_front()
                {
                    projection_state.forwarded_events.remove(&oldest);
                }
            }
            let client_message_id =
                if let EngineEvent::SubagentSteerApplied { message_id, .. } =
                    event.background_payload()
                {
                    state
                        .lock()
                        .await
                        .steer_correlations
                        .remove(message_id)
                        .and_then(|correlation| correlation.client_message_id)
                } else {
                    None
                };
            let messages = context
                .projection
                .lock()
                .await
                .project_with_client_message_id(event, client_message_id);
            for message in messages {
                send(outbound_tx, message).await?;
            }
        }
        Ok(())
    }
    .await;
    if retired {
        state
            .lock()
            .await
            .steer_correlations
            .retain(|_, correlation| correlation.agent_id != agent_id);
    }
    result
}

pub(super) async fn project_managed_background_event(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: EngineEvent,
) -> Result<()> {
    let Some(id) = background_event_id(&event) else {
        return Ok(());
    };
    if let Some(identity) = event.background_identity()
        && engine
            .state
            .task(id)
            .is_some_and(|task| task.background_run.as_ref() != Some(&identity.run))
    {
        // Reconnection must not project an old completion onto the current run.
        // Its durable parent delivery is handled separately by the engine.
        return Ok(());
    }
    // Generic tool wrappers never produce a managed agent/tool association.
    // Their model notifications and hooks are still consumed by the engine.
    match engine.state.task_kind(id) {
        Some(TaskKind::Subagent | TaskKind::Workflow) => {}
        Some(TaskKind::Generic) => return Ok(()),
        None => {
            // Goal-stop can remove the durable task before broadcasting its terminal event.
            let projection = state.lock().await;
            if !projection.jobs.contains_key(id)
                && !projection.pending.contains_key(id)
                && !projection.terminal_jobs.contains(id)
                && !projection.current_runs.contains_key(id)
            {
                return Ok(());
            }
        }
    }
    let resumed_association = if matches!(
        event.background_payload(),
        EngineEvent::BackgroundJobStarted { .. }
    ) {
        event.background_identity().and_then(|identity| {
            engine.state.task(id).and_then(|task| {
                task.parent_tool_call_id
                    .map(|tool_call_id| EngineEvent::BackgroundScoped {
                        identity: kcoder_types::BackgroundEventIdentity {
                            run: identity.run.clone(),
                            event_id: format!("{}:association", identity.run.run_id),
                            run_sequence: 0,
                        },
                        event: Box::new(EngineEvent::BackgroundJobAssociated {
                            id: id.to_owned(),
                            tool_call_id,
                            run_in_background: matches!(task.delivery, TaskDelivery::Background),
                        }),
                    })
            })
        })
    } else {
        None
    };
    project_engine_background_event(state, outbound_tx, event).await?;
    if let Some(association) = resumed_association {
        project_engine_background_event(state, outbound_tx, association).await?;
    }
    Ok(())
}

#[cfg(test)]
pub(super) async fn project_background_broadcast_event(
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    event: BackgroundJobEvent,
) -> Result<()> {
    project_engine_background_event(state, outbound_tx, event.into()).await
}

pub(super) async fn project_flushed_background_events(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
    events: Vec<EngineEvent>,
) -> Result<()> {
    for event in events {
        if background_event_id(&event).is_some() {
            project_managed_background_event(engine, state, outbound_tx, event).await?;
        }
    }
    Ok(())
}

pub(super) async fn reconcile_background_jobs(
    engine: &QueryEngine,
    state: &Arc<Mutex<BackgroundProjectionState>>,
    outbound_tx: &mpsc::Sender<Value>,
) -> Result<Vec<(String, String)>> {
    let mut followups = Vec::new();
    for task in engine.state.tasks().into_values() {
        let Some(tool_call_id) = task.parent_tool_call_id.clone() else {
            continue;
        };
        let routable = {
            let state = state.lock().await;
            background_task_is_routable(&state, &task.id, &tool_call_id)
        };
        let followup = reconciled_background_followup(&task, routable);
        if !routable {
            continue;
        }
        let run = task.background_run.clone();
        let stored_terminal = run
            .as_ref()
            .and_then(|run| engine.state.background_run_record(run))
            .and_then(|record| record.terminal);
        let association = EngineEvent::BackgroundJobAssociated {
            id: task.id.clone(),
            tool_call_id,
            run_in_background: matches!(task.delivery, TaskDelivery::Background),
        };
        let association = if let Some(run) = run.clone() {
            EngineEvent::BackgroundScoped {
                identity: kcoder_types::BackgroundEventIdentity {
                    event_id: format!("{}:association", run.run_id),
                    run,
                    run_sequence: 0,
                },
                event: Box::new(association),
            }
        } else {
            association
        };
        project_engine_background_event(state, outbound_tx, association).await?;
        let terminal = match task.status {
            TaskStatus::Completed => Some(EngineEvent::BackgroundJobCompleted {
                id: task.id.clone(),
                output: kcoder_tools::ToolOutput::text(task.output.unwrap_or_default()),
            }),
            TaskStatus::Failed => Some(EngineEvent::BackgroundJobFailed {
                id: task.id.clone(),
                error: task
                    .output
                    .unwrap_or_else(|| "background job failed".into()),
            }),
            TaskStatus::Cancelled => Some(EngineEvent::BackgroundJobCancelled {
                id: task.id.clone(),
                reason: task
                    .output
                    .unwrap_or_else(|| "background job cancelled".into()),
            }),
            TaskStatus::Halted => Some(EngineEvent::BackgroundJobHalted {
                id: task.id.clone(),
                reason: task
                    .output
                    .unwrap_or_else(|| "background job halted".into()),
            }),
            TaskStatus::Paused => Some(EngineEvent::BackgroundJobPaused {
                id: task.id.clone(),
                reason: task
                    .control
                    .reason
                    .map(|reason| reason.message)
                    .unwrap_or_else(|| "background job paused".into()),
            }),
            TaskStatus::Pending | TaskStatus::Running => None,
        };
        if let Some(terminal) = terminal {
            let terminal = if let Some(identity) = stored_terminal {
                Some(EngineEvent::BackgroundScoped {
                    identity,
                    event: Box::new(terminal),
                })
            } else if matches!(
                terminal.background_payload(),
                EngineEvent::BackgroundJobPaused { .. }
            ) {
                Some(if let Some(run) = run.clone() {
                    EngineEvent::BackgroundScoped {
                        identity: kcoder_types::BackgroundEventIdentity {
                            event_id: format!("{}:paused", run.run_id),
                            run,
                            run_sequence: 0,
                        },
                        event: Box::new(terminal),
                    }
                } else {
                    terminal
                })
            } else if run.is_none() {
                Some(terminal)
            } else {
                None
            };
            if let Some(terminal) = terminal {
                project_engine_background_event(state, outbound_tx, terminal).await?;
            }
        }
        if let Some(followup) = followup {
            followups.push(followup);
        }
    }
    Ok(followups)
}

pub(super) fn reconciled_background_followup(
    task: &Task,
    routable: bool,
) -> Option<(String, String)> {
    routable
        .then(|| background_task_terminal_summary(task))
        .flatten()
        .map(|summary| (task.id.clone(), summary))
}

pub(super) fn background_task_is_routable(
    state: &BackgroundProjectionState,
    task_id: &str,
    tool_call_id: &str,
) -> bool {
    state.jobs.contains_key(task_id)
        || state.current_runs.get(task_id).is_some_and(|key| state.jobs.contains_key(key) || state.terminal_jobs.contains(key))
        || state.tool_calls.contains_key(tool_call_id)
    // flush_background_jobs_with_hooks may already have delivered a terminal event
    // and cleared jobs/tool_calls. terminal_jobs belongs to the current session epoch,
    // remains a reliable reconciliation-scope marker, and cannot import jobs from an old session.
        || state.terminal_jobs.contains(task_id)
}

pub(super) fn background_task_terminal_summary(task: &Task) -> Option<String> {
    match task.status {
        TaskStatus::Completed => Some(format!("background sub-agent `{}` completed", task.id)),
        TaskStatus::Failed => Some(format!(
            "background sub-agent `{}` failed: {}",
            task.id,
            task.output.as_deref().unwrap_or("background job failed")
        )),
        TaskStatus::Cancelled => Some(format!(
            "background sub-agent `{}` was cancelled: {}",
            task.id,
            task.output.as_deref().unwrap_or("background job cancelled")
        )),
        TaskStatus::Halted => Some(format!(
            "background sub-agent `{}` was halted: {}",
            task.id,
            task.output.as_deref().unwrap_or("background job halted")
        )),
        TaskStatus::Paused | TaskStatus::Pending | TaskStatus::Running => None,
    }
}

pub(super) fn agent_summary(task: Task) -> AgentSummary {
    let queue_depth = task.message_queue.len();
    let status = match task.status {
        TaskStatus::Pending => "pending",
        TaskStatus::Running => "running",
        TaskStatus::Paused => "paused",
        TaskStatus::Halted => "halted",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
    };
    let (head_message_id, head_status) = task
        .message_queue
        .first()
        .map(|message| {
            let status = match message.status {
                AgentMessageStatus::Queued => "queued",
                AgentMessageStatus::Leased => "leased",
                AgentMessageStatus::Blocked => "blocked",
                AgentMessageStatus::Acknowledged => "acknowledged",
                AgentMessageStatus::DeadLetter => "dead_letter",
            };
            (Some(message.message_id.clone()), Some(status.to_string()))
        })
        .unwrap_or((None, None));
    let output_path = task
        .output_path
        .as_deref()
        .map(|path| dunce::simplified(path).to_string_lossy().into_owned());
    let transcript_path = task
        .transcript_path
        .as_deref()
        .map(|path| dunce::simplified(path).to_string_lossy().into_owned());
    AgentSummary {
        retained_runs: task.background_runs.len(),
        retained_run_limit: kcoder_state::MAX_BACKGROUND_RUNS_PER_TASK,
        capacity_warning: task.background_runs.len()
            >= kcoder_state::MAX_BACKGROUND_RUNS_PER_TASK * 4 / 5,
        background_run: task.background_run,
        parent_tool_call_id: task.parent_tool_call_id,
        agent_id: task.id,
        agent_name: task.roster_name,
        status: status.to_string(),
        accepting_messages: task.accepting_subagent_messages,
        queue_depth,
        head_message_id,
        head_status,
        output_path,
        transcript_path,
    }
}

pub(super) fn background_terminal_summary(event: &BackgroundJobEvent) -> Option<(&str, String)> {
    match event.payload() {
        BackgroundJobEvent::Completed { id, .. } => {
            Some((id, format!("background sub-agent `{id}` completed")))
        }
        BackgroundJobEvent::Failed { id, error } => {
            Some((id, format!("background sub-agent `{id}` failed: {error}")))
        }
        BackgroundJobEvent::Halted { id, reason } => Some((
            id,
            format!("background sub-agent `{id}` was halted: {reason}"),
        )),
        BackgroundJobEvent::Cancelled { id, reason } => Some((
            id,
            format!("background sub-agent `{id}` was cancelled: {reason}"),
        )),
        _ => None,
    }
}

pub(super) fn has_running_background_followups(engine: &QueryEngine) -> bool {
    engine.state.tasks().into_values().any(|task| {
        matches!(task.kind, TaskKind::Subagent)
            && task.notify_parent_on_completion
            && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
    })
}

pub(super) async fn take_ready_background_followup_batch(
    state: &BackgroundFollowupState,
    has_running: bool,
    engine: Option<&QueryEngine>,
    should_trigger: impl Fn(&str) -> bool,
) -> Option<(String, Vec<kcoder_types::BackgroundRunKey>)> {
    if has_running {
        return None;
    }
    let mut queue = state.queue.lock().await;
    // `close_agent` removes the task record; drop queued summaries that no
    // longer correspond to a follow-up-triggering agent so an aggregate turn
    // never mentions a closed agent.
    queue.pending.retain(|id, _| should_trigger(id));
    if queue.pending.is_empty() {
        return None;
    }
    // Recover an already frozen batch before admitting later arrivals into a new batch.
    let existing_batch = engine.and_then(|engine| {
        queue.pending.keys().find_map(|value| {
            followup_run_key(value)
                .and_then(|key| engine.state.background_run_record(&key))
                .and_then(|record| record.followup_turn_id)
        })
    });
    let selected: Vec<_> = queue
        .pending
        .keys()
        .filter(|value| match (&existing_batch, engine) {
            (Some(batch), Some(engine)) => followup_run_key(value)
                .and_then(|key| engine.state.background_run_record(&key))
                .is_some_and(|record| record.followup_turn_id.as_ref() == Some(batch)),
            _ => true,
        })
        .cloned()
        .collect();
    if selected.is_empty() {
        return None;
    }
    let summary = selected
        .iter()
        .filter_map(|key| queue.pending.remove(key))
        .collect::<Vec<_>>()
        .join(" ");
    let keys = selected
        .iter()
        .filter_map(|key| followup_run_key(key))
        .collect();
    Some((summary, keys))
}

#[cfg(test)]
pub(super) async fn take_ready_background_followup(
    state: &BackgroundFollowupState,
    has_running: bool,
    should_trigger: impl Fn(&str) -> bool,
) -> Option<String> {
    take_ready_background_followup_batch(state, has_running, None, should_trigger)
        .await
        .map(|(summary, _)| summary)
}

pub(super) fn background_followup_nudge(summary: &str) -> String {
    format!(
        "[system] All tracked background sub-agents have finished. Aggregate their results now \
         using the available `<subagent_notification .../>` entries and output files. Events: \
         {summary}. Continue the original task, do not repeat work already delegated to a \
         sub-agent, and do not give a final conclusion until the relevant results have been \
         inspected."
    )
}

pub(super) async fn run_background_event_pump(
    engine: QueryEngine,
    mut receiver: tokio::sync::broadcast::Receiver<BackgroundJobEvent>,
    state: Arc<Mutex<BackgroundProjectionState>>,
    followups: Arc<BackgroundFollowupState>,
    outbound_tx: mpsc::Sender<Value>,
    cancel: CancellationToken,
) {
    let mut idle_tick = tokio::time::interval(std::time::Duration::from_millis(500));
    idle_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = idle_tick.tick() => {
                // Emergency drain for the boundary window: a terminal event can
                // arrive while a turn is active but after the turn loop's last
                // drain. While a turn is active the turn loop owns the claim;
                // when idle, flush and reconcile so the event cannot wait for
                // an unrelated broadcast to appear.
                if engine.turn_driver_active() {
                    continue;
                }
                let events = engine.flush_background_jobs_with_hooks().await;
                if project_flushed_background_events(&engine, &state, &outbound_tx, events)
                    .await
                    .is_err()
                {
                    break;
                }
                match reconcile_background_jobs(&engine, &state, &outbound_tx).await {
                    Ok(recovered_followups) => {
                        queue_recovered_background_followups(
                            &engine,
                            &followups,
                            recovered_followups,
                            |id| engine.background_job_triggers_followup(id),
                        )
                        .await;
                    }
                    Err(_) => break,
                }
            }
            received = receiver.recv() => {
                match received {
                    Ok(event) => {
                        let terminal_summary = background_terminal_summary(&event)
                            .map(|(id, summary)| (event.identity().map(|identity| serde_json::to_string(&identity.run).expect("run identity serializes")).unwrap_or_else(|| id.to_string()), summary));
                        // Flush first on terminal delivery so hook events retain their engine order;
                        // terminal deduplication makes the following broadcast projection harmless.
                        if matches!(event.payload(), BackgroundJobEvent::Completed { .. }
                            | BackgroundJobEvent::Failed { .. }
                            | BackgroundJobEvent::Halted { .. }
                            | BackgroundJobEvent::Cancelled { .. })
                            && !engine.turn_driver_active()
                        {
                            let events = engine.flush_background_jobs_with_hooks().await;
                            if project_flushed_background_events(&engine, &state, &outbound_tx, events).await.is_err() {
                                break;
                            }
                        }
                        if project_managed_background_event(&engine, &state, &outbound_tx, event.into()).await.is_err() {
                            break;
                        }
                        if let Some((id, summary)) = terminal_summary
                            && followup_key_is_eligible(&engine, &id)
                            && !engine.turn_driver_active()
                        {
                            let run_started_at_ms = engine
                                .state
                                .task(&id)
                                .and_then(|task| task.run_started_at_ms);
                            queue_background_followup_once(
                                &followups,
                                id,
                                run_started_at_ms,
                                summary,
                                true,
                            )
                            .await;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "app-server background event pump lagged");
                        let events = engine.flush_background_jobs_with_hooks().await;
                        if project_flushed_background_events(&engine, &state, &outbound_tx, events).await.is_err() {
                            break;
                        }
                        match reconcile_background_jobs(&engine, &state, &outbound_tx).await {
                            Ok(recovered_followups) => {
                                queue_recovered_background_followups(
                                    &engine,
                                    &followups,
                                    recovered_followups,
                                    |id| engine.background_job_triggers_followup(id),
                                )
                                .await;
                            }
                            Err(_) => break,
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

impl BackgroundEventPump {
    pub(super) fn spawn(
        engine: &QueryEngine,
        state: Arc<Mutex<BackgroundProjectionState>>,
        followups: Arc<BackgroundFollowupState>,
        outbound_tx: mpsc::Sender<Value>,
    ) -> Self {
        let cancel = CancellationToken::new();
        let receiver = engine.subscribe_background_jobs();
        let handle = tokio::spawn(run_background_event_pump(
            engine.clone(),
            receiver,
            state,
            followups,
            outbound_tx,
            cancel.clone(),
        ));
        Self { cancel, handle }
    }

    pub(super) async fn stop(mut self) {
        self.cancel.cancel();
        if tokio::time::timeout(BACKGROUND_PUMP_SHUTDOWN_TIMEOUT, &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = self.handle.await;
        }
    }
}
