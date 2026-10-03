//! Agent requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
) -> Result<DispatchControl> {
    match method {
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
                        .map(agent_summary)
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
                .steer_subagent(&params.agent_id, params.message.trim())
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
                    send(outbound_tx, error_response(id, -32036, &error.to_string())).await?;
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
