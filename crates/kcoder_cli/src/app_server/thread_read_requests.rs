//! Thread read requests: extracted from the app-server connection boundary.

use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection and resource owners explicit at the extracted dispatch boundary"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    state: &mut ConnectionState,
    thread_list_snapshots: &mut thread_list_snapshots::ThreadListSnapshots,
    history_refresh: &mut history_refresh_processor::HistoryRefreshProcessor,
) -> Result<DispatchControl> {
    match method {
        method::THREAD_LIST => {
            let running_thread_ids = thread_manager.running_thread_ids();
            let result = serde_json::from_value::<ThreadListParams>(params)
                    .context("invalid thread/list params")
                    .and_then(|params| {
                        let limit = params.limit.unwrap_or(100).clamp(1, 100) as usize;
                        let archived = params.archived;
                        let allow_partial = params.allow_partial.unwrap_or(false);
                        if let Some(cursor) = params.cursor {
                            return thread_list_snapshots.page_report(
                                &cursor,
                                limit,
                                archived,
                                params.query.as_deref(),
                                allow_partial,
                            );
                        }
                        let query = params
                            .query
                            .map(|value| value.trim().to_lowercase())
                            .filter(|value| !value.is_empty());
                        let mut seen = HashSet::new();
                        let mut resident_issues = 0_u64;
                        let mut thread_values = thread_manager
                            .resident_engines()
                            .into_iter()
                            .filter(|resident| !thread_manager.is_ephemeral(&resident.session_id()))
                            .filter_map(|resident| {
                                let thread_id = resident.session_id();
                                seen.insert(thread_id.clone());
                                match thread_snapshot_with_metadata_policy(&resident, running_thread_ids.contains(&thread_id), true) {
                                    Ok(mut snapshot) => {
                                        ThreadRunProjection::for_thread(
                                            thread_manager,
                                            state.run_summary_v1,
                                            &thread_id,
                                        )
                                        .apply(&mut snapshot);
                                        Some(snapshot)
                                    }
                                    Err(error) => {
                                        resident_issues = resident_issues.saturating_add(1);
                                        tracing::warn!(%error, "skipping unreadable resident thread metadata");
                                        None
                                    }
                                }
                            })
                            .collect::<Vec<_>>();
                        let persisted = persisted_thread_snapshot_report(
                            workspace_engine,
                            &running_thread_ids,
                            &seen,
                        )?;
                        thread_values.extend(persisted.threads.into_iter().filter(|value| {
                            value["id"]
                                .as_str()
                                .is_some_and(|thread_id| seen.insert(thread_id.to_string()))
                        }));
                        let threads = thread_values
                            .into_iter()
                            .map(serde_json::from_value)
                            .collect::<std::result::Result<Vec<Thread>, _>>()?
                            .into_iter()
                            .filter(|thread| {
                                archived
                                    .is_none_or(|expected| thread.archived_at.is_some() == expected)
                            })
                            .filter(|thread| {
                                query.as_ref().is_none_or(|needle| {
                                    [&thread.title, &thread.cwd, &thread.model]
                                        .into_iter()
                                        .flatten()
                                        .any(|value| value.to_lowercase().contains(needle))
                                })
                            })
                            .collect::<Vec<_>>();
                        thread_list_snapshots.start_report(
                            threads,
                            limit,
                            archived,
                            query,
                            persisted.issue_count.saturating_add(resident_issues),
                            allow_partial,
                        )
                    });
            match result {
                Ok(mut result) => {
                    for thread in &mut result.threads {
                        recent_error::decorate(workspace_engine, thread, state.run_summary_v1);
                    }
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32020, &error.to_string())).await?
                }
            }
        }
        method::THREAD_HISTORY_REFRESH => {
            let result =
                serde_json::from_value::<kcoder_app_protocol::ThreadHistoryRefreshParams>(params)
                    .context("invalid thread/history/refresh params")
                    .and_then(|params| history_refresh.process(workspace_engine, params));
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32020, &error.to_string())).await?
                }
            }
        }
        method::THREAD_METADATA_UPDATE => {
            let running_thread_ids = thread_manager.running_thread_ids();
            let result = serde_json::from_value::<ThreadMetadataUpdateParams>(params)
                .context("invalid thread/metadata/update params")
                .and_then(|params| {
                    let target_engine = thread_manager
                        .engine(&params.thread_id)
                        .unwrap_or_else(|| workspace_engine.clone());
                    let active_thread_owned = thread_manager
                        .lease(&params.thread_id)
                        .is_some_and(|lease| lease.matches_engine(&target_engine));
                    update_thread_metadata(
                        &target_engine,
                        params,
                        &running_thread_ids,
                        active_thread_owned,
                    )
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
                    send(outbound_tx, error_response(id, -32037, &error.to_string())).await?
                }
            }
        }
        method::TOOLS_CATALOG => {
            match tools_catalog::query(params, thread_manager, workspace_engine).await {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32038, &error.to_string())).await?
                }
            }
        }
        method::THREAD_CREATION_READ => {
            let result =
                serde_json::from_value::<kcoder_app_protocol::ThreadCreationReadParams>(params)
                    .context("invalid thread creation query")
                    .and_then(|params| {
                        thread_creations::query(workspace_engine, &params.client_request_id)
                    });
            match result {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32059, &error.to_string())).await?
                }
            }
        }
        method::TURN_RECEIPT_READ => {
            match turn_receipts::query(params, thread_manager, workspace_engine).await {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32046, &error.to_string())).await?
                }
            }
        }
        method::THREAD_READ => {
            let running_thread_ids = thread_manager.running_thread_ids();
            let result = match serde_json::from_value::<ThreadReadParams>(params)
                .context("invalid thread/read params")
            {
                Ok(params) => {
                    let target_engine = thread_manager
                        .engine(&params.thread_id)
                        .unwrap_or_else(|| workspace_engine.clone());
                    let run_projection = ThreadRunProjection::for_thread(
                        thread_manager,
                        state.run_summary_v1,
                        &params.thread_id,
                    );
                    thread_transcript(&target_engine, params, &running_thread_ids, run_projection)
                        .await
                }
                Err(error) => Err(error),
            };
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    let message = error.to_string();
                    send(outbound_tx, error_response(id, -32021, &message)).await?
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
