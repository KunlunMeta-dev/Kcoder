//! Runtime requests: extracted from the app-server connection boundary.

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
    thread_manager: &mut ThreadManager,
    provider_settings_state: &Result<provider_settings::ProviderSettingsState>,
) -> Result<DispatchControl> {
    match method {
        method::DEVICE_EXECUTE => {
            match match serde_json::from_value::<DeviceExecuteParams>(params) {
                Ok(params) if params.command_key == "ls_skills" => {
                    let registry = match params.thread_id.as_deref() {
                        Some(thread_id) => thread_manager
                            .engine(thread_id)
                            .context("Skill catalog conversation is not resident")
                            .and_then(|thread| {
                                thread
                                    .skill_registry
                                    .read()
                                    .map(|registry| registry.clone())
                                    .map_err(|_| anyhow::anyhow!("Skill registry is unavailable"))
                            }),
                        None => engine_factory.current_skills(),
                    };
                    registry.map(|registry| {
                            let cwd = workspace_engine.state.cwd();
                            let skills = registry.list().into_iter().map(|skill| {
                                let project = skill.source.starts_with(&cwd);
                                json!({
                                    "name": skill.name, "description": skill.description,
                                    "short_description": Value::Null, "path": skill.source,
                                    "can_remove": skill_processor::user_managed(skill),
                                    "source": "kcoder", "scope": if project { "repo" } else { "user" },
                                    "source_label": "KCoder", "source_priority": if project { 10 } else { 20 }, "origin": "local",
                                })
                            }).collect::<Vec<_>>();
                            DeviceExecuteResult { success: true, exit_code: 0, stdout: skills.into(), stderr: String::new() }
                        })
                }
                Ok(params)
                    if matches!(
                        params.command_key.as_str(),
                        "turn_file_changes_review" | "turn_file_changes_revert"
                    ) =>
                {
                    let requested_thread_id = params
                        .thread_id
                        .clone()
                        .or_else(|| thread_manager.sole_thread_id());
                    let target_engine = requested_thread_id
                            .as_deref()
                            .context(
                                "turn file changes command requires threadId when multiple resident threads exist",
                            )
                            .and_then(|thread_id| {
                                let target_engine = thread_manager
                                    .engine(thread_id)
                                    .context("thread/start or thread/resume is required")?;
                                ensure_active_thread(
                                    &target_engine,
                                    thread_manager.lease(thread_id),
                                    thread_id,
                                )?;
                                Ok(target_engine)
                            });
                    match target_engine {
                        Ok(target_engine) => {
                            turn_file_changes_command(&target_engine, &params).await
                        }
                        Err(error) => Err(error),
                    }
                }
                Ok(params)
                    if matches!(
                        params.command_key.as_str(),
                        "git_add_all"
                            | "git_commit"
                            | "git_commit_all"
                            | "git_push"
                            | "git_pull_ff"
                            | "git_merge"
                            | "git_apply_reverse"
                            | "git_checkout"
                            | "git_checkout_new"
                    ) && thread_manager
                        .resident_engines()
                        .iter()
                        .any(|engine| thread_manager.is_turn_running(&engine.session_id())) =>
                {
                    Err(anyhow::anyhow!(
                        "git mutations are unavailable while an agent turn is running"
                    ))
                }
                Ok(params) => device_execute(&workspace_engine.state.cwd(), &params).await,
                Err(error) => Err(error).context("invalid device/execute params"),
            } {
                Ok(result) => {
                    send(
                        outbound_tx,
                        success_response(id, serde_json::to_value(result)?),
                    )
                    .await?
                }
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        "runtime.models.list" => {
            if let Some(model) = engine_factory.scenario_model_name() {
                if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                    if thread_manager.engine(thread_id).is_none() {
                        send(
                            outbound_tx,
                            error_response(
                                id,
                                -32602,
                                "Model catalog conversation is not resident",
                            ),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                }
                send(
                    outbound_tx,
                    success_response(id, scenario_model_catalog_response(model)),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                match thread_manager.engine(thread_id) {
                    Some(thread) => {
                        send(
                            outbound_tx,
                            match thread.current_configured_model_profiles() {
                                Ok(profiles) => match thread.active_model_configuration_summary() {
                                    Ok(active) => {
                                        let mut result =
                                            configured_model_catalog_response(profiles);
                                        result["activeConfiguration"] =
                                            serde_json::to_value(active)?;
                                        success_response(id, result)
                                    }
                                    Err(error) => error_response(id, -32602, &error.to_string()),
                                },
                                Err(error) => error_response(id, -32602, &error.to_string()),
                            },
                        )
                        .await?
                    }
                    None => {
                        send(
                            outbound_tx,
                            error_response(
                                id,
                                -32602,
                                "Model catalog conversation is not resident",
                            ),
                        )
                        .await?
                    }
                }
            } else {
                match engine_factory.current_model_profiles() {
                    Ok(profiles) => {
                        send(
                            outbound_tx,
                            success_response(id, configured_model_catalog_response(profiles)),
                        )
                        .await?
                    }
                    Err(error) => {
                        send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                    }
                }
            }
        }
        kcoder_app_protocol::method::PROVIDERS_TEMPLATES => {
            match provider_settings::templates(params.clone()) {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        "runtime.providers.list"
        | "runtime.providers.upsert"
        | "runtime.providers.delete"
        | "runtime.providers.validate" => {
            match provider_settings::request(
                workspace_engine,
                provider_settings_state,
                method,
                params.clone(),
            ) {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        "runtime.context.get" | "runtime.context.update" => {
            match runtime_context_request(workspace_engine, method, &params) {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        "runtime.workspace.search" => {
            match workspace_search_request(workspace_engine, &params).await {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        "runtime.worktrees.settings.get"
        | "runtime.worktrees.settings.update"
        | "runtime.worktrees.prepare"
        | "runtime.worktrees.list"
        | "runtime.worktrees.archive.preview"
        | "runtime.worktrees.archive"
        | "runtime.worktrees.delete"
        | "runtime.worktrees.restore"
        | "runtime.worktrees.forget"
        | "runtime.worktrees.conversations.link"
        | "runtime.worktrees.conversations.remove"
        | "runtime.worktrees.prune" => {
            match worktree_request(workspace_engine, method, &params).await {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(
                        outbound_tx,
                        error_response(id, -32602, &format!("{method}: {error:#}")),
                    )
                    .await?
                }
            }
        }
        "runtime.workspaces.open"
        | "runtime.workspaces.prepare"
        | "runtime.workspaces.delete"
        | "runtime.projects.upsert_local"
        | "runtime.workspaces.rename"
        | "runtime.workspaces.remove"
        | "runtime.workspaces.list"
        | "runtime.sidebar.projects.reorder"
        | "runtime.sidebar.projects.pin"
        | "runtime.sidebar.projects.appearance"
        | "runtime.sidebar.projects.sync_remote"
        | "runtime.sidebar.projects.activate"
        | "runtime.sidebar.tasks.reorder"
        | "runtime.sidebar.tasks.pin" => {
            match workspace_request(workspace_engine, method, &params).await {
                Ok(result) => send(outbound_tx, success_response(id, result)).await?,
                Err(error) => {
                    send(outbound_tx, error_response(id, -32602, &error.to_string())).await?
                }
            }
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
