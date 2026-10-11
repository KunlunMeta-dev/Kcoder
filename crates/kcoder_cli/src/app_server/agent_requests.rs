//! Agent requests: extracted from the app-server connection boundary.

use super::*;
use kcoder_app_protocol::{
    AgentLiveReadParams, AgentLiveReadResult, AgentMessageReadParams, AgentMessageReadResult,
    AgentMessageReceipt, AgentMessagesArchiveParams, AgentMessagesArchiveResult,
    AgentMessagesListParams, AgentMessagesListResult, AgentPresentation, AgentStopParams,
    AgentStopResult,
};

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
) -> Result<DispatchControl> {
    match method {
        method::AGENT_LIVE_READ => {
            let result = serde_json::from_value::<AgentLiveReadParams>(params)
                .context("invalid agent/live/read params")
                .and_then(|params| {
                    let (engine, _) =
                        owned_agent(thread_manager, &params.thread_id, &params.agent_id)?;
                    let active = engine.has_subagent_live_view(&params.agent_id);
                    let snapshot = engine
                        .subagent_public_live_tail(&params.agent_id, params.previous_revision)?;
                    let (revision, phase, content, truncated) = match snapshot {
                        Some((revision, phase, content, truncated)) => {
                            (Some(revision), Some(phase), content, truncated)
                        }
                        None => (params.previous_revision, None, String::new(), false),
                    };
                    Ok(AgentLiveReadResult {
                        thread_id: params.thread_id,
                        agent_id: params.agent_id,
                        active,
                        unchanged: active && phase.is_none() && params.previous_revision.is_some(),
                        revision,
                        phase,
                        content,
                        truncated,
                    })
                });
            send_agent_response(outbound_tx, id, result, -32025).await?;
        }
        "agent/stop" => {
            let result = async {
                let params: AgentStopParams =
                    serde_json::from_value(params).context("invalid agent/stop params")?;
                let (engine, task) =
                    owned_agent_scope(thread_manager, &params.thread_id, &params.agent_id)?;
                anyhow::ensure!(
                    params.expected_background_run.agent_id == params.agent_id
                        && params.expected_background_run.parent_session_id == engine.session_id()
                        && task.background_run.as_ref() == Some(&params.expected_background_run),
                    "agent_stop_identity_conflict"
                );
                let (stopped, status, reason_code) = if task.delivery != TaskDelivery::Background {
                    (false, "not_supported", Some("foreground_only"))
                } else if !engine.can_stop_subagent_run(&params.expected_background_run) {
                    if matches!(
                        task.status,
                        TaskStatus::Completed
                            | TaskStatus::Failed
                            | TaskStatus::Cancelled
                            | TaskStatus::Halted
                    ) {
                        (false, "already_terminal", None)
                    } else {
                        (false, "not_supported", Some("missing_live_handle"))
                    }
                } else {
                    let observed = engine
                        .stop_subagent_run(&params.expected_background_run)
                        .await?;
                    let confirmation = observed.then(|| engine.state.confirm_stopped_subagent_run(&params.expected_background_run));
                    let confirmed = matches!(confirmation, Some(Ok(())));
                    if !confirmed {
                        let task = engine.state.task(&params.agent_id);
                        tracing::warn!(agent_id = %params.agent_id, joined = observed,
                            status = task.as_ref().map(|task| task.status.as_str()),
                            accepting = task.as_ref().map(|task| task.accepting_subagent_messages),
                            queued = task.as_ref().map(|task| task.message_queue.len()),
                            legacy_pending = task.as_ref().map(|task| task.pending_messages.len()),
                            reason = confirmation.as_ref().and_then(|result| result.as_ref().err()).map(|error| error.to_string()),
                            "subagent stop cleanup was not durably confirmed");
                    }
                    if confirmed {
                        (true, "stopped", None)
                    } else {
                        (false, "cleanup_unknown", Some("terminal_state_unconfirmed"))
                    }
                };
                Ok(AgentStopResult {
                    thread_id: params.thread_id,
                    agent_id: params.agent_id,
                    expected_background_run: params.expected_background_run,
                    stopped,
                    status: status.into(),
                    reason_code: reason_code.map(str::to_string),
                })
            }
            .await;
            send_agent_response(outbound_tx, id, result, -32036).await?;
        }
        "agent/messages/list" => {
            let result = serde_json::from_value::<AgentMessagesListParams>(params)
                .context("invalid agent/messages/list params")
                .and_then(|params| {
                    let (_, task) =
                        owned_agent(thread_manager, &params.thread_id, &params.agent_id)?;
                    let offset = params.offset as usize;
                    if (offset > 0 && params.receipt_epoch.is_none())
                        || params
                            .receipt_epoch
                            .is_some_and(|epoch| epoch != task.command_receipt_epoch)
                    {
                        anyhow::bail!("command_receipt_epoch_conflict");
                    }
                    anyhow::ensure!(
                        offset <= task.command_receipts.len(),
                        "command_receipt_offset_out_of_range"
                    );
                    let limit = params.limit.unwrap_or(32).clamp(1, 64) as usize;
                    let receipts = task
                        .command_receipts
                        .iter()
                        .skip(offset)
                        .take(limit)
                        .filter_map(|receipt| {
                            command_receipt_wire(&task, &receipt.client_message_id)
                        })
                        .collect::<Vec<_>>();
                    let next = offset + receipts.len();
                    Ok(AgentMessagesListResult {
                        thread_id: params.thread_id,
                        agent_id: params.agent_id,
                        receipt_epoch: task.command_receipt_epoch,
                        retained_count: task.command_receipts.len(),
                        retained_limit: 256,
                        offset: params.offset,
                        next_offset: (next < task.command_receipts.len()).then_some(next as u32),
                        receipts,
                    })
                });
            send_agent_response(outbound_tx, id, result, -32025).await?;
        }
        "agent/messages/archive" => {
            let result = serde_json::from_value::<AgentMessagesArchiveParams>(params)
                .context("invalid agent/messages/archive params")
                .and_then(|params| {
                    anyhow::ensure!(
                        params.confirmed_message_ids.len() <= 256
                            && params
                                .confirmed_message_ids
                                .iter()
                                .all(|id| !id.is_empty() && id.len() <= 128),
                        "invalid_command_receipt_confirmation"
                    );
                    let (engine, _) =
                        owned_agent(thread_manager, &params.thread_id, &params.agent_id)?;
                    let receipt_epoch = engine.state.archive_subagent_command_receipts(
                        &params.agent_id,
                        params.expected_epoch,
                        &params.confirmed_message_ids,
                    )?;
                    Ok(AgentMessagesArchiveResult {
                        thread_id: params.thread_id,
                        agent_id: params.agent_id,
                        receipt_epoch,
                    })
                });
            send_agent_response(outbound_tx, id, result, -32036).await?;
        }
        "agent/message/read" => {
            let result = serde_json::from_value::<AgentMessageReadParams>(params)
                .context("invalid agent/message/read params")
                .and_then(|params| {
                    if params.client_message_id.trim().is_empty()
                        || params.client_message_id.len() > 128
                    {
                        anyhow::bail!("clientMessageId must contain 1..=128 bytes");
                    }
                    let (_, task) =
                        owned_agent(thread_manager, &params.thread_id, &params.agent_id)?;
                    let receipt = command_receipt_wire(&task, &params.client_message_id);
                    let receipt_epoch = task.command_receipt_epoch;
                    Ok(AgentMessageReadResult {
                        thread_id: params.thread_id,
                        agent_id: params.agent_id,
                        client_message_id: params.client_message_id,
                        receipt_epoch,
                        receipt,
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
                    send(outbound_tx, error_response(id, -32025, &error.to_string())).await?
                }
            }
        }
        method::AGENT_LIST => {
            let result = serde_json::from_value::<AgentListParams>(params)
                .context("invalid agent/list params")
                .and_then(|params| {
                    let target_engine = thread_manager
                        .engine(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&params.thread_id),
                        &params.thread_id,
                    )?;
                    let session_id = target_engine.session_id();
                    let mut agents = target_engine
                        .state
                        .tasks()
                        .into_values()
                        .filter(|task| {
                            task.kind == TaskKind::Subagent
                                && task.parent_session_id.as_deref() == Some(session_id.as_str())
                        })
                        .map(|task| {
                            let scope = format!(
                                "{}\0{}\0{}",
                                target_engine
                                    .settings_persistence_path()
                                    .map(|path| path.to_string_lossy().into_owned())
                                    .unwrap_or_default(),
                                session_id,
                                task.id
                            );
                            let presentation = AgentPresentation {
                                role: task.agent_kind.clone(),
                                goal: task.description.clone(),
                                directory: task
                                    .worktree_path
                                    .as_ref()
                                    .unwrap_or(&target_engine.state.cwd())
                                    .to_string_lossy()
                                    .into_owned(),
                                progress: target_engine
                                    .subagent_live_snapshot(&task.id, None)
                                    .map(|snapshot| snapshot.phase),
                                can_stop: task
                                    .background_run
                                    .as_ref()
                                    .is_some_and(|run| target_engine.can_stop_subagent_run(run)),
                                journal_scope: super::private_files::hex_sha256(scope.as_bytes()),
                            };
                            let mut summary = agent_summary(task);
                            summary.presentation = Some(presentation);
                            summary
                        })
                        .collect::<Vec<_>>();
                    agents.sort_by(|left, right| left.agent_id.cmp(&right.agent_id));
                    Ok(AgentListResult {
                        thread_id: params.thread_id,
                        agents,
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
                    send(outbound_tx, error_response(id, -32024, &error.to_string())).await?;
                }
            }
        }
        method::AGENT_ARTIFACT_READ => {
            let params = match serde_json::from_value::<AgentArtifactReadParams>(params) {
                Ok(params) => params,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            let thread_id = params.thread_id.clone();
            let result = thread_manager
                .engine(&thread_id)
                .context("thread/start or thread/resume is required")
                .and_then(|target_engine| {
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&thread_id),
                        &thread_id,
                    )?;
                    agent_artifacts::read(&target_engine, &params)
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
                    let unavailable = error.downcast_ref::<agent_artifacts::ArtifactUnavailable>();
                    let code = if unavailable.is_some() {
                        -32026
                    } else {
                        -32024
                    };
                    let message = unavailable
                        .map(|unavailable| unavailable.0.clone())
                        .unwrap_or_else(|| error.to_string());
                    send(outbound_tx, error_response(id, code, &message)).await?;
                }
            }
        }
        method::AGENT_STEER => {
            let params = match serde_json::from_value::<AgentSteerParams>(params.clone()) {
                Ok(params) => params,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                    return Ok(DispatchControl::Continue);
                }
            };
            if params.message.trim().is_empty() {
                send(
                    outbound_tx,
                    error_response(id, -32602, "agent steer message must not be empty"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if params
                .client_message_id
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 128)
            {
                send(
                    outbound_tx,
                    error_response(
                        id,
                        -32602,
                        "clientMessageId must contain 1..=128 bytes when provided",
                    ),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let Some(target_engine) = thread_manager.engine(&params.thread_id) else {
                send(
                    outbound_tx,
                    error_response(id, -32025, "agent_not_found_or_not_owned"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            if ensure_active_thread(
                &target_engine,
                thread_manager.lease(&params.thread_id),
                &params.thread_id,
            )
            .is_err()
                || !target_engine
                    .state
                    .task(&params.agent_id)
                    .is_some_and(|task| {
                        task.kind == TaskKind::Subagent
                            && task.parent_session_id.as_deref()
                                == Some(target_engine.session_id().as_str())
                    })
            {
                send(
                    outbound_tx,
                    error_response(id, -32025, "agent_not_found_or_not_owned"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let Some(background_projection) = thread_manager.projection(&params.thread_id) else {
                send(
                    outbound_tx,
                    error_response(id, -32025, "agent_not_found_or_not_owned"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            };
            if let Err(error) = begin_agent_steer_response_gate(
                &background_projection,
                &params.agent_id,
                params.client_message_id.clone(),
            )
            .await
            {
                send(outbound_tx, error_response(id, -32037, &error.to_string())).await?;
                return Ok(DispatchControl::Continue);
            }
            let receipt = match target_engine
                .steer_subagent_with_client_id(
                    &params.agent_id,
                    params.message.trim(),
                    params.client_message_id.as_deref(),
                )
                .await
            {
                Ok(receipt) => receipt,
                Err(error) => {
                    finish_agent_steer_response_gate(
                        &background_projection,
                        outbound_tx,
                        &params.agent_id,
                        None,
                    )
                    .await?;
                    let known_refusal = match &error {
                        kcoder_tools::ToolError::InvalidInput(reason)
                            if reason == "client_message_payload_conflict" =>
                        {
                            Some("client_message_payload_conflict")
                        }
                        kcoder_tools::ToolError::Execution(reason)
                            if reason.starts_with("command_receipt_capacity:") =>
                        {
                            Some("command_receipt_capacity")
                        }
                        kcoder_tools::ToolError::Execution(reason)
                            if reason == "stale_client_message_epoch"
                                || reason == "invalid_client_message_epoch" =>
                        {
                            Some("stale_client_message_epoch")
                        }
                        _ => None,
                    };
                    if let Some(reason) = known_refusal {
                        send(
                            outbound_tx,
                            success_response(
                                id,
                                serde_json::to_value(AgentSteerResult {
                                    agent_id: params.agent_id,
                                    message_id: None,
                                    status: AgentSteerStatus::Rejected,
                                    queued: false,
                                    queue_position: None,
                                    reason_code: Some(reason.into()),
                                    client_message_id: params.client_message_id,
                                })?,
                            ),
                        )
                        .await?;
                    } else {
                        // A persistence/transport failure may happen after commit;
                        // leave the command result unknown for identity lookup.
                        send(outbound_tx, error_response(id, -32036, &error.to_string())).await?;
                    }
                    return Ok(DispatchControl::Continue);
                }
            };
            let message_id = receipt.message_id.clone();
            let result = agent_steer_result_from_receipt(params.client_message_id, receipt);
            send(
                outbound_tx,
                success_response(id, serde_json::to_value(result)?),
            )
            .await?;
            finish_agent_steer_response_gate(
                &background_projection,
                outbound_tx,
                &params.agent_id,
                message_id.as_deref(),
            )
            .await?;
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}

fn owned_agent(
    manager: &ThreadManager,
    thread_id: &str,
    agent_id: &str,
) -> Result<(QueryEngine, Task)> {
    let (engine, task) = owned_agent_scope(manager, thread_id, agent_id)?;
    engine.state.ensure_subagent_command_receipts_readable()?;
    Ok((engine, task))
}

fn owned_agent_scope(
    manager: &ThreadManager,
    thread_id: &str,
    agent_id: &str,
) -> Result<(QueryEngine, Task)> {
    let engine = manager
        .engine(thread_id)
        .context("thread/start or thread/resume is required")?;
    ensure_active_thread(&engine, manager.lease(thread_id), thread_id)?;
    let task = engine
        .state
        .task(agent_id)
        .filter(|task| {
            task.kind == TaskKind::Subagent
                && task.parent_session_id.as_deref() == Some(engine.session_id().as_str())
        })
        .context("agent_not_found_or_not_owned")?;
    Ok((engine, task))
}

fn command_receipt_wire(task: &Task, client_message_id: &str) -> Option<AgentMessageReceipt> {
    let receipt = task
        .command_receipts
        .iter()
        .find(|receipt| receipt.client_message_id == client_message_id)?;
    let status = task
        .message_queue
        .iter()
        .chain(task.dead_letter_messages.iter())
        .find(|message| message.message_id == receipt.message_id)
        .map_or(receipt.status, |message| message.status);
    let status = match status {
        AgentMessageStatus::Acknowledged => "applied",
        AgentMessageStatus::DeadLetter => "dead_letter",
        AgentMessageStatus::Blocked => "blocked",
        _ if receipt.applied_at_ms.is_some() => "applied",
        AgentMessageStatus::Queued => "queued",
        AgentMessageStatus::Leased => "leased",
    };
    Some(AgentMessageReceipt {
        client_message_id: receipt.client_message_id.clone(),
        message_id: receipt.message_id.clone(),
        status: status.into(),
        body_summary: receipt.body_summary.clone(),
        accepted_at_ms: receipt.accepted_at_ms,
        applied_at_ms: receipt.applied_at_ms,
        background_run: receipt.background_run.clone(),
        applied_background_run: receipt.applied_background_run.clone(),
    })
}

async fn send_agent_response<T: serde::Serialize>(
    outbound: &mpsc::Sender<Value>,
    id: Value,
    result: Result<T>,
    code: i64,
) -> Result<()> {
    let response = match result {
        Ok(result) => success_response(id, serde_json::to_value(result)?),
        Err(error) => error_response(id, code, &error.to_string()),
    };
    send(outbound, response).await
}
