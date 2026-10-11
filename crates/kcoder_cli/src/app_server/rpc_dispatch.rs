//! Route initialized requests into domain handlers without owning connection resources.

use super::*;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection and resource owners explicit at the extracted dispatch boundary"
)]
pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    engine: &mut QueryEngine,
    workspace_engine: &QueryEngine,
    outbound_tx: &mpsc::Sender<Value>,
    thread_manager: &mut ThreadManager,
    terminals: &TerminalRegistry,
    history_refresh: &mut history_refresh_processor::HistoryRefreshProcessor,
    browsers: &mut BrowserRegistry,
    plugin_tasks: &tokio::task::JoinSet<()>,
    provider_tasks: &mut tokio::task::JoinSet<()>,
    indexed_read_tasks: &tokio::task::JoinSet<()>,
    automations: &mut project_automations::ProjectAutomations,
    automation_requested: &mut bool,
    idle_shutdown_requested: &mut bool,
    engine_factory: &AppServerEngineFactory,
    storage_scans: &storage_scans::StorageScans,
    provider_settings_state: &Result<provider_settings::ProviderSettingsState>,
    attachment_directories: &mut AttachmentDirectories,
    next_terminal_id: &AtomicU64,
    permission_mode: kcoder_config::PermissionMode,
    next_question_id: &Arc<AtomicU64>,
    next_approval_id: &Arc<AtomicU64>,
    connection_receipts: &Arc<StdMutex<InteractionReceipts>>,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    automation_fire: &Option<kcoder_tools::cron::CronFire>,
    state: &mut ConnectionState,
    thread_list_snapshots: &mut thread_list_snapshots::ThreadListSnapshots,
) -> Result<DispatchControl> {
    if matches!(
        method,
        kcoder_app_protocol::knowledge_method::DIRECTORY_STAGE
            | kcoder_app_protocol::knowledge_method::DIRECTORY_PREVIEW
    ) {
        let result = (|| -> Result<Value> {
            let input: kcoder_app_protocol::KnowledgeDirectoryParams =
                serde_json::from_value(params)?;
            let settings = workspace_engine
                .settings_persistence_path()
                .context("Wiki profile unavailable")?;
            if method == kcoder_app_protocol::knowledge_method::DIRECTORY_PREVIEW {
                return knowledge_directory::preview(
                    &settings,
                    std::path::Path::new(&input.directory),
                );
            }
            knowledge_directory::stage_selected(
                &settings,
                std::path::Path::new(&input.directory),
                &workspace_engine.session_id(),
                attachment_directories,
                input.selected_titles.as_deref(),
            )
        })();
        let response = match result {
            Ok(value) => success_response(id, value),
            Err(error) => error_response(id, -32602, &error.to_string()),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if knowledge_transfer::supports(method) {
        let result = workspace_engine
            .settings_persistence_path()
            .context("knowledge profile unavailable")
            .and_then(|path| {
                knowledge_transfer::request(
                    method,
                    params,
                    &path,
                    &workspace_engine.session_id(),
                    attachment_directories,
                )
            });
        let response = match result {
            Ok(value) => success_response(id, value),
            Err(error) => error_response(id, -32602, &error.to_string()),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if method == kcoder_app_protocol::knowledge_method::IMAGE_IMPORT_RESUME {
        let prepared = (|| -> Result<_> {
            anyhow::ensure!(
                state.knowledge_rpc_tasks.len() < 16,
                "knowledge service is busy"
            );
            let input: kcoder_app_protocol::KnowledgeImageImportParams =
                serde_json::from_value(params)?;
            let settings = workspace_engine
                .settings_persistence_path()
                .context("knowledge profile unavailable")?;
            let context = kcoder_tools::ToolContext::new(workspace_engine.state.clone());
            Ok((input, settings, context))
        })();
        match prepared {
            Ok((input, settings, context)) => {
                let outbound = outbound_tx.clone();
                state.knowledge_rpc_tasks.spawn(async move {
                    let response =
                        match knowledge_image_imports::resume(&settings, input, context).await {
                            Ok(value) => success_response(id, value),
                            Err(error) => error_response(id, -32602, &error.to_string()),
                        };
                    let _ = send(&outbound, response).await;
                });
            }
            Err(error) => send(outbound_tx, error_response(id, -32602, &error.to_string())).await?,
        }
        return Ok(DispatchControl::Continue);
    }
    if method == kcoder_app_protocol::knowledge_method::IMPORT_ATTACHMENT {
        let prepared = (|| -> Result<_> {
            anyhow::ensure!(
                state.knowledge_rpc_tasks.len() < 16,
                "knowledge service is busy"
            );
            let input: kcoder_app_protocol::KnowledgeImportAttachmentParams =
                serde_json::from_value(params)?;
            let path = knowledge_documents::authorize(&input, attachment_directories)?;
            let settings = workspace_engine
                .settings_persistence_path()
                .context("knowledge profile unavailable")?;
            let context = kcoder_tools::ToolContext::new(workspace_engine.state.clone());
            Ok((input, path, settings, context))
        })();
        match prepared {
            Ok((input, path, settings, context)) => {
                let outbound = outbound_tx.clone();
                state.knowledge_rpc_tasks.spawn(async move {
                    let response =
                        match knowledge_documents::import(&settings, input, path, context).await {
                            Ok(value) => success_response(id, value),
                            Err(error) => error_response(id, -32602, &error.to_string()),
                        };
                    let _ = send(&outbound, response).await;
                });
            }
            Err(error) => send(outbound_tx, error_response(id, -32602, &error.to_string())).await?,
        }
        return Ok(DispatchControl::Continue);
    }
    if matches!(
        method,
        kcoder_app_protocol::knowledge_method::JOB_START
            | kcoder_app_protocol::knowledge_method::JOB_RESUME
    ) {
        let result = (|| -> Result<_> {
            anyhow::ensure!(
                state.knowledge_tasks.len() < 64,
                "knowledge task queue is full"
            );
            let path = workspace_engine
                .settings_persistence_path()
                .context("knowledge profile unavailable")?;
            anyhow::ensure!(
                knowledge_requests::organization_enabled(&path)?,
                "Wiki organization is disabled"
            );
            let (settings, model) = engine_factory.knowledge_model()?;
            let (mut store, scope) = knowledge_requests::open_catalog(&path)?;
            let input = if method == kcoder_app_protocol::knowledge_method::JOB_START {
                serde_json::from_value::<kcoder_app_protocol::KnowledgeJobStartParams>(params)?
            } else {
                let request: kcoder_app_protocol::KnowledgeJobParams =
                    serde_json::from_value(params)?;
                let job = store.read_job(&scope, &request.library_id, &request.job_id)?;
                let purpose = store.read(&scope, &request.library_id)?.purpose;
                if knowledge_worker::is_remote()
                    && (job.recipe_key.starts_with("wiki-v2:")
                        || job.recipe_key.starts_with("wiki-v3:")
                        || job.recipe_key.starts_with("wiki-v4:"))
                {
                    knowledge_worker_model::load(&path, &job.recipe_key, &purpose)?;
                } else {
                    let recipe =
                        engine_factory.knowledge_recipe(&path, &settings, &model, &purpose)?;
                    anyhow::ensure!(
                        job.recipe_key == recipe,
                        "Wiki generation configuration changed; start a new job"
                    );
                }
                store.resume_job(&scope, &request.library_id, &request.job_id)?;
                let job = store.read_job(&scope, &request.library_id, &request.job_id)?;
                return Ok((
                    path,
                    request.library_id,
                    model,
                    job,
                    settings.context_window_tokens.unwrap_or(32_768),
                ));
            };
            let purpose = store.read(&scope, &input.library_id)?.purpose;
            let recipe = engine_factory.knowledge_recipe(&path, &settings, &model, &purpose)?;
            let job = store.enqueue_ingest(
                &scope,
                &input.library_id,
                &input.idempotency_key,
                &input.source_id,
                &input.revision_id,
                &recipe,
                &input.language,
            )?;
            Ok((
                path,
                input.library_id,
                model,
                job,
                settings.context_window_tokens.unwrap_or(32_768),
            ))
        })();
        match result {
            Ok((path, library_id, model, job, budget)) => {
                if knowledge_worker::is_remote() {
                    if let Err(error) = knowledge_worker::ensure_started(&path) {
                        if let Ok((mut store, scope)) = knowledge_requests::open_catalog(&path) {
                            let _ = store.pause_job(&scope, &library_id, &job.id);
                        }
                        send(outbound_tx, error_response(id, -32000, &error.to_string())).await?;
                    } else {
                        send(outbound_tx, success_response(id, json!(&job))).await?;
                    }
                    return Ok(DispatchControl::Continue);
                }
                send(outbound_tx, success_response(id, json!(&job))).await?;
                state.knowledge_tasks.spawn(async move {
                    let Ok(_slot) = knowledge_job_runner::slots().acquire_owned().await else {
                        return;
                    };
                    let cancel = tokio_util::sync::CancellationToken::new();
                    let _guard = cancel.clone().drop_guard();
                    if knowledge_job_runner::run(
                        &path,
                        &library_id,
                        &job.id,
                        &model,
                        budget,
                        &cancel,
                    )
                    .await
                    .is_err()
                    {
                        tracing::warn!("Wiki ingest stopped; inspect persisted job status");
                    }
                });
            }
            Err(error) => send(outbound_tx, error_response(id, -32602, &error.to_string())).await?,
        }
        return Ok(DispatchControl::Continue);
    }
    if knowledge_requests::supports(method) {
        if state.knowledge_rpc_tasks.len() >= 16 {
            send(
                outbound_tx,
                error_response(id, -32000, "knowledge service is busy"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        }
        let Some(path) = workspace_engine.settings_persistence_path() else {
            send(
                outbound_tx,
                error_response(id, -32000, "knowledge profile is unavailable"),
            )
            .await?;
            return Ok(DispatchControl::Continue);
        };
        let method = method.to_owned();
        let outbound = outbound_tx.clone();
        state.knowledge_rpc_tasks.spawn(async move {
            let result = tokio::task::spawn_blocking(move || {
                knowledge_requests::request(&path, &method, params)
            })
            .await;
            let response = match result {
                Ok(Ok(value)) => success_response(id, value),
                Ok(Err(error)) => error_response(id, -32602, &error.to_string()),
                Err(_) => error_response(id, -32603, "knowledge request failed"),
            };
            let _ = send(&outbound, response).await;
        });
        return Ok(DispatchControl::Continue);
    }
    match method {
        method::AGENT_STREAM_SUBSCRIBE | method::AGENT_STREAM_UNSUBSCRIBE => {
            state
                .agent_streams
                .dispatch(method, id, params, thread_manager, outbound_tx, server_id)
                .await
        }
        "initialized"
        | kcoder_app_protocol::method::USAGE_STATS
        | "cron/list"
        | "cron/create"
        | "cron/delete"
        | method::CRON_PREVIEW
        | "server/info"
        | method::SERVER_IDLE_SHUTDOWN
        | method::SERVER_RESOURCES_READ => {
            server_requests::dispatch(
                method,
                id,
                params,
                engine,
                workspace_engine,
                outbound_tx,
                thread_manager,
                terminals,
                history_refresh,
                browsers,
                plugin_tasks,
                provider_tasks,
                !state.knowledge_tasks.is_empty() || !state.knowledge_rpc_tasks.is_empty(),
                indexed_read_tasks,
                automations,
                automation_requested,
                idle_shutdown_requested,
            )
            .await
        }
        method::AGENT_LIST
        | method::AGENT_ARTIFACT_READ
        | method::AGENT_STEER
        | method::AGENT_MESSAGE_READ
        | method::AGENT_MESSAGES_LIST
        | method::AGENT_MESSAGES_ARCHIVE => {
            agent_requests::dispatch(method, id, params, outbound_tx, thread_manager).await
        }
        method::AGENT_STOP | method::AGENT_LIVE_READ => {
            agent_requests::dispatch(method, id, params, outbound_tx, thread_manager).await
        }
        method::COMPUTER_USE_STATUS
        | method::DIAGNOSTICS_STORAGE_READ
        | method::DIAGNOSTICS_STORAGE_CANCEL
        | method::DIAGNOSTICS_STORAGE_CLEAN
        | method::DIAGNOSTICS_DEBUG_LOG_DISABLE
        | method::WORKFLOW_UPDATE
        | method::WORKFLOW_VERSIONS
        | method::WORKFLOW_CLONE
        | method::WORKFLOW_EXPORT
        | method::WORKFLOW_IMPORT
        | method::WORKFLOW_CAPABILITIES_READ
        | method::WORKFLOW_VERIFICATION_READ
        | method::WORKFLOW_STORAGE_READ
        | method::WORKFLOW_STORAGE_MIGRATE
        | method::WORKFLOW_STORAGE_ROLLBACK
        | method::WORKFLOW_VERSION_REFERENCES
        | method::WORKFLOW_VERSION_ARCHIVE
        | method::WORKFLOW_HISTORY_READ
        | method::WORKFLOW_RUNS_ARCHIVE_PREVIEW
        | method::WORKFLOW_RUNS_ARCHIVE
        | method::WORKFLOW_RUNS_ARCHIVE_LIST
        | method::WORKFLOW_RUNS_ARCHIVE_READ
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
        | method::WORKFLOW_REMOVE_NODE
        | method::SETTINGS_TOOLS_READ
        | method::SETTINGS_TOOLS_SAVE
        | method::SETTINGS_TURN_FILE_CHANGES_READ
        | method::SETTINGS_TURN_FILE_CHANGES_SAVE
        | method::SETTINGS_TEMPLATES_LIST
        | method::SETTINGS_TEMPLATES_READ
        | method::SETTINGS_TEMPLATES_SAVE
        | method::SETTINGS_TEMPLATES_DELETE
        | method::SETTINGS_TEMPLATES_DEFAULT => {
            settings_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                engine_factory,
                outbound_tx,
                provider_tasks,
                storage_scans,
            )
            .await
        }
        method::DEVICE_EXECUTE
        | "runtime.models.list"
        | kcoder_app_protocol::method::PROVIDERS_TEMPLATES
        | "runtime.providers.list"
        | "runtime.providers.upsert"
        | "runtime.providers.delete"
        | "runtime.providers.validate"
        | method::PROVIDERS_CLEAR_USER_OVERRIDE
        | "runtime.context.get"
        | "runtime.context.update"
        | "runtime.workspace.search"
        | "runtime.worktrees.settings.get"
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
        | "runtime.worktrees.prune"
        | "runtime.workspaces.operation/read"
        | "runtime.workspaces.open"
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
            runtime_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                engine_factory,
                outbound_tx,
                thread_manager,
                provider_settings_state,
            )
            .await
        }
        method::WORKSPACE_IMPORT_ATTACHMENT
        | method::ATTACHMENT_SAVE
        | method::ATTACHMENT_UPLOAD_START
        | method::ATTACHMENT_UPLOAD_CHUNK
        | method::ATTACHMENT_UPLOAD_FINISH
        | method::ATTACHMENT_UPLOAD_CANCEL
        | method::ATTACHMENT_DELETE
        | method::ATTACHMENT_READ
        | method::ATTACHMENT_READ_CHUNK => {
            attachment_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                outbound_tx,
                thread_manager,
                attachment_directories,
            )
            .await
        }
        method::TERMINAL_START
        | method::TERMINAL_LIST
        | method::TERMINAL_ATTACH
        | method::TERMINAL_WRITE
        | method::TERMINAL_RESIZE
        | method::TERMINAL_CLOSE
        | method::BROWSER_PREFLIGHT
        | method::BROWSER_START
        | method::BROWSER_SCREENSHOT
        | method::BROWSER_ACTION
        | method::BROWSER_EVALUATE
        | method::BROWSER_CLOSE => {
            resource_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                outbound_tx,
                next_terminal_id,
                terminals,
                browsers,
            )
            .await
        }
        method::SESSION_MODES | method::THREAD_SESSION_MODE_SET => {
            session_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                outbound_tx,
                thread_manager,
            )
            .await
        }
        method::THREAD_START => {
            thread_creation_requests::dispatch(
                method,
                id,
                params,
                engine,
                workspace_engine,
                engine_factory,
                permission_mode,
                outbound_tx,
                next_question_id,
                next_approval_id,
                connection_receipts,
                thread_manager,
                server_id,
                sequence,
                automations,
                automation_fire,
            )
            .await
        }
        method::THREAD_LIST
        | method::THREAD_HISTORY_REFRESH
        | method::THREAD_METADATA_UPDATE
        | method::TOOLS_CATALOG
        | method::THREAD_CREATION_READ
        | method::TURN_RECEIPT_READ
        | method::THREAD_READ => {
            thread_read_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                outbound_tx,
                thread_manager,
                state,
                thread_list_snapshots,
                history_refresh,
            )
            .await
        }
        method::THREAD_RESUME | method::THREAD_FORK => {
            thread_restore_requests::dispatch(
                method,
                id,
                params,
                engine,
                workspace_engine,
                engine_factory,
                permission_mode,
                outbound_tx,
                next_question_id,
                next_approval_id,
                connection_receipts,
                thread_manager,
                server_id,
                sequence,
                state,
            )
            .await
        }
        method::THREAD_COMPACT | method::THREAD_ROLLBACK => {
            thread_rewind_requests::dispatch(method, id, params, outbound_tx, thread_manager).await
        }
        method::THREAD_GOAL_GET
        | method::THREAD_GOAL_HISTORY
        | method::THREAD_GOAL_SET
        | method::THREAD_GOAL_CLEAR => {
            goal_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                outbound_tx,
                thread_manager,
            )
            .await
        }
        method::THREAD_AUTOMATION_SUSPEND | method::THREAD_DISPOSE | method::THREAD_DELETE => {
            if matches!(method, method::THREAD_DISPOSE | method::THREAD_DELETE)
                && let Some(thread_id) = params.get("threadId").and_then(Value::as_str)
            {
                state.agent_streams.unsubscribe_thread(thread_id);
            }
            thread_delete_requests::dispatch(
                method,
                id,
                params,
                engine,
                workspace_engine,
                outbound_tx,
                thread_manager,
            )
            .await
        }
        method::COMPUTER_USE_REVOKE => {
            if !state.computer_use_recovery_v1 {
                send(
                    outbound_tx,
                    error_response(id, -32602, "computerUseRecoveryV1 negotiation is required"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let result = match serde_json::from_value::<kcoder_app_protocol::ComputerUseRevokeParams>(
                params,
            ) {
                Ok(params) => desktop_recovery::revoke(thread_manager, params, server_id).await,
                Err(error) => Err(error.into()),
            };
            let response = match result {
                Ok(result) => success_response(id, result),
                Err(error) => error_response(id, -32602, &error.to_string()),
            };
            send(outbound_tx, response).await?;
            Ok(DispatchControl::Continue)
        }
        "turn/start" | "turn/shorten_wait" | "turn/interrupt" | method::COMPUTER_USE_RECOVER => {
            turn_requests::dispatch(
                method,
                id,
                params,
                engine,
                engine_factory,
                outbound_tx,
                thread_manager,
                server_id,
                sequence,
                state,
                attachment_directories,
            )
            .await
        }
        _ => {
            send(outbound_tx, error_response(id, -32601, "Method not found")).await?;
            Ok(DispatchControl::Continue)
        }
    }
}
