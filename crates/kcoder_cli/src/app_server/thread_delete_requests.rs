//! Thread delete requests: extracted from the app-server connection boundary.

use super::*;

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    engine: &mut QueryEngine,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_AUTOMATION_SUSPEND => {
            let result = async {
                let params: ThreadGoalParams = serde_json::from_value(params)?;
                let turn = thread_manager
                    .turn_state(&params.thread_id)
                    .context("thread is not resident")?;
                let _gate = turn.activity_gate.lock().await;
                let followups = thread_manager
                    .followups(&params.thread_id)
                    .context("thread has no scheduler")?;
                followups.goals.lock().unwrap().suspend();
                followups.notify.notify_one();
                Ok::<_, anyhow::Error>(json!({"suspended":true}))
            }
            .await;
            match result {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::THREAD_DISPOSE => {
            let result: Result<Value> = async {
                let params: ThreadDeleteParams = serde_json::from_value(params)?;
                validate_thread_id(&params.thread_id)?;
                let runtime = thread_manager.remove_ephemeral(&params.thread_id)?;
                let disposed = runtime.is_some();
                if engine.session_id() == params.thread_id {
                    *engine = workspace_engine.clone();
                }
                if let Some(runtime) = runtime {
                    runtime.shutdown().await;
                }
                Ok(json!({"threadId":params.thread_id,"disposed":disposed}))
            }
            .await;
            let response = match result {
                Ok(result) => success_response(id, result),
                Err(error) => error_response(id, -32036, &error.to_string()),
            };
            send(outbound_tx, response).await?;
        }
        method::THREAD_DELETE => {
            let parsed = serde_json::from_value::<ThreadDeleteParams>(params)
                .context("invalid thread/delete params");
            let result = match parsed {
                Err(error) => Err(error),
                Ok(params) => {
                    async {
                        // Lock the cross-process lifecycle before removing the resident runtime,
                        // eliminating the window between closing its lease and deleting persisted
                        // files in which another app-server could recover the same thread.
                        let _lifecycle_lock = acquire_thread_lifecycle_locks(
                            workspace_engine,
                            &[params.thread_id.as_str()],
                        )?;
                        let mut resident_paths = None;
                        let resident =
                            thread_manager
                                .remove_if_idle(&params.thread_id)
                                .map_err(|()| {
                                    anyhow::anyhow!(
                                        "cannot delete while the resident runtime is active"
                                    )
                                })?;
                        if engine.session_id() == params.thread_id {
                            *engine = workspace_engine.clone();
                        }
                        if let Some(runtime) = resident {
                            resident_paths = Some(runtime.persistence_paths());
                            runtime.shutdown().await;
                        }
                        (|| {
                            // Repeat every mutable path and ownership check under the stable lifecycle lock.
                            let history_path = resident_paths
                                .as_ref()
                                .and_then(|(history_path, _)| history_path.clone())
                                .map(Ok)
                                .unwrap_or_else(|| {
                                    thread_history_path(workspace_engine, &params.thread_id)
                                })?;
                            let resident_history = resident_paths
                                .as_ref()
                                .is_some_and(|(history, _)| history.is_some());
                            let lease = if history_path.exists() {
                                Some(SessionLease::acquire_existing_history(&history_path)?)
                            } else if resident_history {
                                Some(SessionLease::acquire(&history_path)?)
                            } else {
                                None
                            };
                            let mut deleted_files = if history_path.exists() || resident_history {
                                kcoder_state::delete_session_history_files(&history_path)?
                            } else {
                                Vec::new()
                            };
                            if let Some(state_path) = resident_paths
                                .as_ref()
                                .and_then(|(_, state_path)| state_path.as_ref())
                                && state_path.exists()
                            {
                                std::fs::remove_file(state_path).with_context(|| {
                                    format!(
                                        "failed to delete session state {}",
                                        state_path.display()
                                    )
                                })?;
                                deleted_files.push(state_path.clone());
                            }
                            let client_artifacts =
                                workspace_engine.session_storage_dir_for(&params.thread_id);
                            match std::fs::symlink_metadata(&client_artifacts) {
                                Ok(metadata) if metadata.file_type().is_dir() => {
                                    std::fs::remove_dir_all(&client_artifacts).with_context(
                                        || {
                                            format!(
                                                "failed to delete client session artifacts {}",
                                                client_artifacts.display()
                                            )
                                        },
                                    )?;
                                    deleted_files.push(client_artifacts);
                                }
                                Ok(_) => anyhow::bail!(
                                    "client session artifact path is not a directory: {}",
                                    client_artifacts.display()
                                ),
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                                Err(error) => return Err(error.into()),
                            }
                            drop(lease);
                            // Retain the stable lease file for handles already opened by peers.
                            Ok(ThreadDeleteResult {
                                thread_id: params.thread_id,
                                deleted: true,
                                deleted_files: deleted_files.len(),
                            })
                        })()
                    }
                    .await
                }
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32035, &error.to_string())).await?;
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
