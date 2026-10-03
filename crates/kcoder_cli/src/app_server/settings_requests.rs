//! Settings requests: extracted from the app-server connection boundary.

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
    engine_factory: &AppServerEngineFactory,
    outbound_tx: &mpsc::Sender<Value>,
    provider_tasks: &mut tokio::task::JoinSet<()>,
    storage_scans: &storage_scans::StorageScans,
) -> Result<DispatchControl> {
    match method {
        method::COMPUTER_USE_STATUS => {
            if serde_json::from_value::<kcoder_app_protocol::ComputerUseStatusParams>(params)
                .is_err()
            {
                send(
                    outbound_tx,
                    error_response(id, -32602, "invalid computer use status parameters"),
                )
                .await?;
            } else if provider_tasks.len() >= 4 {
                send(
                    outbound_tx,
                    error_response(id, -32000, "desktop diagnostics are busy"),
                )
                .await?;
            } else {
                let outbound = outbound_tx.clone();
                let factory = engine_factory.clone();
                provider_tasks.spawn(async move {
                    // Settings and filesystem metadata reads must not block turn/interrupt dispatch.
                    let result = tokio::task::spawn_blocking(move || {
                        factory.current_settings().map(computer_use_status::inspect)
                    })
                    .await;
                    let response = match result {
                        Ok(Ok(status)) => success_response(id, json!(status)),
                        _ => error_response(id, -32603, "desktop diagnostics failed"),
                    };
                    let _ = send(&outbound, response).await;
                });
            }
        }
        method::DIAGNOSTICS_STORAGE_READ => {
            let scan = (|| -> Result<_> {
                anyhow::ensure!(provider_tasks.len() < 4, "diagnostics are busy");
                let input: kcoder_app_protocol::StorageScanParams =
                    serde_json::from_value(params.clone())?;
                storage_scans.start(
                    input
                        .scan_id
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                )
            })();
            match scan {
                Ok(scan) => {
                    let outbound = outbound_tx.clone();
                    provider_tasks.spawn(async move {
                        let result = tokio::task::spawn_blocking(move || {
                            let scan_guard = scan;
                            storage_diagnostics::read_report(&scan_guard.token)
                        })
                        .await;
                        let response = match result {
                            Ok(Ok(report)) => success_response(id, json!(report)),
                            Ok(Err(error)) => error_response(
                                id,
                                if error.is::<storage_diagnostics::StorageScanCancelled>() {
                                    -32800
                                } else {
                                    -32602
                                },
                                &error.to_string(),
                            ),
                            Err(error) => error_response(id, -32603, &error.to_string()),
                        };
                        let _ = send(&outbound, response).await;
                    });
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::DIAGNOSTICS_STORAGE_CANCEL => {
            let result = serde_json::from_value::<kcoder_app_protocol::StorageScanCancelParams>(
                params.clone(),
            )
            .map_err(anyhow::Error::from)
            .and_then(|params| storage_scans.cancel(&params.scan_id));
            let response = match result {
                Ok(cancelled) => success_response(
                    id,
                    json!(kcoder_app_protocol::StorageScanCancelResult { cancelled }),
                ),
                Err(error) => error_response(id, -32602, &error.to_string()),
            };
            send(outbound_tx, response).await?;
        }
        method::DIAGNOSTICS_STORAGE_CLEAN => {
            let input = serde_json::from_value::<StorageCleanParams>(params.clone())
                .map_err(anyhow::Error::from)
                .and_then(|input| {
                    anyhow::ensure!(provider_tasks.len() < 4, "diagnostics are busy");
                    Ok(input)
                });
            match input {
                Ok(input) => {
                    let outbound = outbound_tx.clone();
                    provider_tasks.spawn(async move {
                        let result = tokio::task::spawn_blocking(move || {
                            storage_diagnostics::clean(&input.target, input.confirm)
                        })
                        .await;
                        let response = match result {
                            Ok(Ok(result)) => success_response(id, json!(result)),
                            Ok(Err(error)) => error_response(
                                id,
                                if error.is::<storage_diagnostics::StorageBusyError>() {
                                    -32034
                                } else {
                                    -32602
                                },
                                &error.to_string(),
                            ),
                            Err(error) => error_response(id, -32603, &error.to_string()),
                        };
                        let _ = send(&outbound, response).await;
                    });
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::DIAGNOSTICS_DEBUG_LOG_DISABLE => match storage_diagnostics::disable_debug_log() {
            Ok(result) => {
                send(
                    outbound_tx,
                    success_response(id, serde_json::to_value(result)?),
                )
                .await?;
            }
            Err(error) => {
                send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
            }
        },
        method::WORKFLOW_UPDATE
        | method::WORKFLOW_VERSIONS
        | method::WORKFLOW_CLONE
        | method::WORKFLOW_EXPORT
        | method::WORKFLOW_IMPORT
        | method::WORKFLOW_RUNS_LIST
        | method::WORKFLOW_RUNS_READ
        | method::WORKFLOW_RUNS_OUTPUT
        | method::WORKFLOW_LIST
        | method::WORKFLOW_READ
        | method::WORKFLOW_CREATE
        | method::WORKFLOW_DELETE
        | method::WORKFLOW_SAVE
        | method::WORKFLOW_MOVE_NODE
        | method::WORKFLOW_REQUESTS
        | method::WORKFLOW_RESPOND
        | method::WORKFLOW_UPSERT_NODE
        | method::WORKFLOW_REMOVE_NODE => {
            let result = workflow_canvas::request(workspace_engine, method, params.clone());
            match result {
                Ok(value) => send(outbound_tx, success_response(id, value)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::SETTINGS_TOOLS_READ | method::SETTINGS_TOOLS_SAVE => {
            let result = if method == method::SETTINGS_TOOLS_READ {
                serde_json::from_value::<kcoder_app_protocol::ToolsSettingsReadParams>(
                    params.clone(),
                )
                .map_err(anyhow::Error::from)
                .and_then(|_| engine_factory.tool_profile_settings(None))
            } else {
                serde_json::from_value::<kcoder_app_protocol::ToolsSettingsSaveParams>(
                    params.clone(),
                )
                .map_err(anyhow::Error::from)
                .and_then(|value| engine_factory.tool_profile_settings(Some(value.profile)))
            };
            match result {
                Ok(value) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(value)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        method::SETTINGS_TURN_FILE_CHANGES_READ => {
            match turn_file_changes_settings::read(workspace_engine) {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::SETTINGS_TURN_FILE_CHANGES_SAVE => {
            let result = serde_json::from_value::<TurnFileChangesPolicy>(params.clone())
                .map_err(anyhow::Error::from)
                .and_then(|policy| turn_file_changes_settings::save(workspace_engine, &policy));
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::SETTINGS_TEMPLATES_LIST => {
            let result = user_template_store().and_then(|store| store.list());
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::SETTINGS_TEMPLATES_READ => {
            let result = serde_json::from_value::<SettingsTemplateReadParams>(params.clone())
                .map_err(anyhow::Error::from)
                .and_then(|params| user_template_store()?.read(&params.id));
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::SETTINGS_TEMPLATES_SAVE => {
            let result = serde_json::from_value::<SettingsTemplateSaveParams>(params.clone())
                .map_err(anyhow::Error::from)
                .and_then(|params| user_template_store()?.save(&params));
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::SETTINGS_TEMPLATES_DELETE => {
            let result = serde_json::from_value::<SettingsTemplateDeleteParams>(params.clone())
                .map_err(anyhow::Error::from)
                .and_then(|params| user_template_store()?.delete(&params.id));
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        method::SETTINGS_TEMPLATES_DEFAULT => {
            let result = serde_json::from_value::<SettingsTemplateDefaultParams>(params.clone())
                .map_err(anyhow::Error::from)
                .and_then(|params| user_template_store()?.set_default(params.id.as_deref()));
            match result {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?;
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?;
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
