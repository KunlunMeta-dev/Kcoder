//! Thread delete requests: extracted from the app-server connection boundary.

use super::*;

#[allow(clippy::too_many_arguments)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    engines: (&mut QueryEngine, &QueryEngine),
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    retention_parent: Option<&retention_context::VerifiedRetentionAuthority>,
    state: &mut ConnectionState,
) -> Result<DispatchControl> {
    let (engine, workspace_engine) = engines;
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
                // This is a client-resource cleanup request, not an explicit
                // user Goal pause. A late detach cannot suspend newer input
                // from another client or an authorized channel source.
                let suspended = followups.suspend_client_continuations(state);
                if suspended {
                    followups.notify.notify_one();
                }
                Ok::<_, anyhow::Error>(json!({"suspended":suspended}))
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
                mcp_apps_rpc::revoke_thread(state, Some(&params.thread_id)).await?;
                if engine.session_id() == params.thread_id {
                    *engine = workspace_engine.clone();
                }
                if let Some(runtime) = runtime {
                    runtime.shutdown().await;
                }
                state.mcp_app_registry.forget(&params.thread_id);
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
            let parsed = kcoder_app_rpc_codec::decode::<ThreadDeleteParams>(params)
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
                        mcp_apps_rpc::revoke_thread(state, Some(&params.thread_id)).await?;
                        if let Some(runtime) = resident {
                            resident_paths = Some(runtime.persistence_paths());
                            runtime.shutdown().await;
                        }
                        state.mcp_app_registry.forget(&params.thread_id);
                        (|| {
                            // Repeat every mutable path and ownership check under the stable lifecycle lock.
                            let cleanup_required = thread_retention_cleanup::requires_cleanup(
                                retention_parent,
                                workspace_engine,
                                &params.thread_id,
                            )?;
                            let history_path = resident_paths
                                .as_ref()
                                .and_then(|(history_path, _)| history_path.clone())
                                .map(Ok)
                                .unwrap_or_else(|| {
                                    if !cleanup_required {
                                        #[cfg(target_os = "linux")]
                                        {
                                            // Ordinary deletion retries use only the canonical
                                            // source locator; a missing source still needs a
                                            // matching durable deletion witness below.
                                            let root = workspace_engine
                                                .state
                                                .history_path()
                                                .context("session history is disabled")?;
                                            let history_dir =
                                                root.parent().context("history parent missing")?;
                                            let canonical_dir = dunce::canonicalize(history_dir)?;
                                            return candidate_thread_history_path(
                                                &canonical_dir,
                                                &params.thread_id,
                                            );
                                        }
                                        #[cfg(not(target_os = "linux"))]
                                        {
                                            // Preserve the original non-Linux ordinary-delete
                                            // path and its existence check.
                                            return thread_history_path(
                                                workspace_engine,
                                                &params.thread_id,
                                            );
                                        }
                                    }
                                    // A durable deleted source remains the retry
                                    // locator even after the transcript vanished.
                                    let root = workspace_engine
                                        .state
                                        .history_path()
                                        .context("session history is disabled")?;
                                    candidate_thread_history_path(
                                        root.parent().context("history parent missing")?,
                                        &params.thread_id,
                                    )
                                })?;
                            let resident_history = resident_paths
                                .as_ref()
                                .is_some_and(|(history, _)| history.is_some());
                            let primary_present = match std::fs::symlink_metadata(&history_path) {
                                Ok(_) => true,
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                                Err(error) => return Err(error.into()),
                            };
                            // A bound durable tombstone, not a missing file or
                            // caller thread ID, permits recreating a lost lease.
                            // Validate before creating any lease, then recheck
                            // while holding it before cleanup can mutate state.
                            let pending_witness = if !primary_present && cleanup_required {
                                Some(
                                    kcoder_state::read_session_history_deletion(
                                        &history_path,
                                        &workspace_engine.cwd,
                                    )?
                                    .context("retained thread deletion witness unavailable")?,
                                )
                            } else {
                                #[cfg(target_os = "linux")]
                                if !cleanup_required && !primary_present && !resident_history {
                                    Some(
                                        kcoder_state::read_session_history_deletion(
                                            &history_path,
                                            &workspace_engine.cwd,
                                        )?
                                        .context("ordinary thread deletion witness unavailable")?,
                                    )
                                } else {
                                    None
                                }
                                #[cfg(not(target_os = "linux"))]
                                {
                                    None
                                }
                            };
                            let has_pending_witness = pending_witness.is_some();
                            if let Some(witness) = pending_witness.as_ref() {
                                ensure!(
                                    witness.thread_id() == params.thread_id,
                                    "thread deletion witness differs"
                                );
                                witness.verify(&history_path, &workspace_engine.cwd)?;
                            }
                            let lease = if pending_witness.is_some() {
                                Some(SessionLease::acquire(&history_path)?)
                            } else if primary_present {
                                Some(SessionLease::acquire_existing_history(&history_path)?)
                            } else if resident_history {
                                Some(SessionLease::acquire(&history_path)?)
                            } else {
                                None
                            };
                            if let Some(witness) = pending_witness.as_ref() {
                                witness.verify(&history_path, &workspace_engine.cwd)?;
                            }
                            let mut primary_existed_before_mark = false;
                            let mut marked_this_request = false;
                            if cleanup_required {
                                let witness = if let Some(witness) = pending_witness {
                                    witness.verify(&history_path, &workspace_engine.cwd)?;
                                    witness
                                } else {
                                    primary_existed_before_mark = primary_present;
                                    let witness = kcoder_state::mark_session_history_deleted(
                                        &history_path,
                                        &workspace_engine.cwd,
                                    )?;
                                    marked_this_request = true;
                                    witness
                                };
                                ensure!(
                                    witness.thread_id() == params.thread_id,
                                    "thread deletion witness differs"
                                );
                                thread_retention_cleanup::complete(
                                    retention_parent.context("retention parent unavailable")?,
                                    workspace_engine,
                                    &history_path,
                                    &witness,
                                )?;
                            } else {
                                #[cfg(target_os = "linux")]
                                if primary_present || resident_history {
                                    if primary_present {
                                        let metadata = std::fs::symlink_metadata(&history_path)?;
                                        ensure!(
                                            metadata.file_type().is_file(),
                                            "persisted thread is not a regular file: {}",
                                            history_path.display()
                                        );
                                    }
                                    let persisted =
                                        kcoder_state::history_persisted_base_cwd(&history_path)?
                                            .context("persisted thread has no base cwd")?;
                                    ensure!(
                                        dunce::canonicalize(persisted)?
                                            == dunce::canonicalize(&workspace_engine.cwd)?,
                                        "persisted thread belongs to another workspace"
                                    );
                                    // The removed idle resident owns a deferred source and its
                                    // persisted workspace even before the first JSONL append.
                                    primary_existed_before_mark = primary_present;
                                    let witness = kcoder_state::mark_session_history_deleted(
                                        &history_path,
                                        &workspace_engine.cwd,
                                    )?;
                                    ensure!(
                                        witness.thread_id() == params.thread_id,
                                        "thread deletion witness differs"
                                    );
                                    witness.verify(&history_path, &workspace_engine.cwd)?;
                                    marked_this_request = true;
                                } else if let Some(witness) = pending_witness {
                                    // A cold retry may clear sidecars only under the exact
                                    // already-bound proof; it must never upgrade an unbound
                                    // legacy tombstone from the caller-supplied thread ID.
                                    witness.verify(&history_path, &workspace_engine.cwd)?;
                                } else {
                                    anyhow::bail!("ordinary thread deletion witness unavailable");
                                }
                                #[cfg(not(target_os = "linux"))]
                                if primary_present {
                                    let persisted =
                                        kcoder_state::history_persisted_base_cwd(&history_path)?
                                            .context("persisted thread has no base cwd")?;
                                    ensure!(
                                        dunce::canonicalize(persisted)?
                                            == dunce::canonicalize(&workspace_engine.cwd)?,
                                        "persisted thread belongs to another workspace"
                                    );
                                }
                            }
                            let mut deleted_files = if history_path.exists()
                                || resident_history
                                || cleanup_required
                                || marked_this_request
                                || has_pending_witness
                            {
                                kcoder_state::delete_session_history_files(&history_path)?
                            } else {
                                Vec::new()
                            };
                            if primary_existed_before_mark {
                                let primary_exists_after_mark =
                                    match std::fs::symlink_metadata(&history_path) {
                                        Ok(_) => true,
                                        Err(error)
                                            if error.kind() == std::io::ErrorKind::NotFound =>
                                        {
                                            false
                                        }
                                        Err(error) => return Err(error.into()),
                                    };
                                if !primary_exists_after_mark
                                    && !deleted_files.contains(&history_path)
                                {
                                    // mark_session_history_deleted removes the primary itself, so
                                    // count it once even though sidecar cleanup sees it as missing.
                                    deleted_files.push(history_path.clone());
                                }
                            }
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
