//! Thread rewind requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_COMPACT => {
            let result = match serde_json::from_value::<ThreadCompactParams>(params) {
                Ok(params) => {
                    if thread_manager.is_turn_running(&params.thread_id) {
                        Err(anyhow::anyhow!("cannot compact while a turn is running"))
                    } else {
                        thread_manager
                            .select(&params.thread_id)
                            .context("thread/start or thread/resume is required")
                            .and_then(|target_engine| {
                                ensure_active_thread(
                                    &target_engine,
                                    thread_manager.lease(&params.thread_id),
                                    &params.thread_id,
                                )?;
                                Ok((params, target_engine))
                            })
                    }
                }
                Err(error) => Err(error).context("invalid thread/compact params"),
            };
            match result {
                Ok((params, target_engine)) => match target_engine.compact_conversation().await {
                    Ok(result) => {
                        let response = ThreadCompactResult {
                            thread_id: params.thread_id,
                            compacted: result.did_compact,
                            pre_tokens: result.pre_compact_tokens,
                            post_tokens: result.post_compact_tokens,
                        };
                        send(
                            outbound_tx,
                            success_response(id, serde_json::to_value(response)?),
                        )
                        .await?;
                    }
                    Err(error) => {
                        send(outbound_tx, error_response(id, -32030, &error.to_string())).await?;
                    }
                },
                Err(error) => {
                    send(outbound_tx, error_response(id, -32030, &error.to_string())).await?;
                }
            }
        }
        method::THREAD_ROLLBACK => {
            let result = serde_json::from_value::<ThreadRollbackParams>(params)
                .context("invalid thread/rollback params")
                .and_then(|params| {
                    if thread_manager.is_turn_running(&params.thread_id) {
                        anyhow::bail!("cannot rollback while a turn is running")
                    }
                    let target_engine = thread_manager
                        .select(&params.thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(
                        &target_engine,
                        thread_manager.lease(&params.thread_id),
                        &params.thread_id,
                    )?;
                    let turn = params
                        .turn
                        .or_else(|| {
                            target_engine
                                .user_request_turn_previews()
                                .last()
                                .map(|(turn, _)| *turn)
                        })
                        .context("thread has no user turn to rollback")?;
                    Ok((params.thread_id, turn, target_engine))
                });
            match result {
                Ok((thread_id, turn, target_engine)) => {
                    let turn_state = thread_manager
                        .turn_state(&thread_id)
                        .expect("resident runtime disappeared");
                    let _activity = turn_state.activity_gate.lock().await;
                    if turn_state.running.load(Ordering::SeqCst) {
                        send(
                            outbound_tx,
                            error_response(id, -32031, "cannot rollback while a turn is running"),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                    match target_engine.checkpoints_rewind(turn).await {
                        Ok((report, conversation)) => {
                            let followups = thread_manager
                                .followups(&thread_id)
                                .expect("resident runtime disappeared");
                            if let Err(error) = update_client_turn_count_after_rewind(
                                &target_engine,
                                &followups,
                                conversation,
                            ) {
                                send(outbound_tx, error_response(id, -32031, &error.to_string()))
                                    .await?;
                                return Ok(DispatchControl::Continue);
                            }
                            let response = ThreadRollbackResult {
                                thread_id,
                                turn,
                                removed_messages: conversation
                                    .map(|value| value.removed)
                                    .unwrap_or(0),
                                restored_files: report.restored.len(),
                                deleted_files: report.deleted.len(),
                                failed_files: report.failed.len(),
                            };
                            send(
                                outbound_tx,
                                success_response(id, serde_json::to_value(response)?),
                            )
                            .await?;
                        }
                        Err(error) => {
                            // Rewind may already have changed memory before a durable write fails.
                            thread_manager
                                .followups(&thread_id)
                                .expect("resident runtime disappeared")
                                .client_turn_count
                                .invalidate();
                            send(outbound_tx, error_response(id, -32031, &error.to_string()))
                                .await?;
                        }
                    }
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32031, &error.to_string())).await?;
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
