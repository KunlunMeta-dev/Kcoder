//! Route initialized requests into domain handlers without owning connection resources.

use super::*;
use crate::app_server::task_spawn::JoinSetExt as _;
use futures::FutureExt;
use kcoder_app_rpc_codec as rpc_codec;

#[expect(
    clippy::too_many_arguments,
    reason = "Keep separately borrowed connection and resource owners explicit at the extracted dispatch boundary"
)]
pub(super) fn dispatch<'a>(
    method: &'a str,
    id: Value,
    params: Value,
    engine: &'a mut QueryEngine,
    workspace_engine: &'a QueryEngine,
    outbound_tx: &'a mpsc::Sender<Value>,
    thread_manager: &'a mut ThreadManager,
    terminals: &'a TerminalRegistry,
    history_refresh: &'a mut history_refresh_processor::HistoryRefreshProcessor,
    browsers: &'a mut BrowserRegistry,
    plugin_tasks: &'a tokio::task::JoinSet<()>,
    migration_activity: usize,
    provider_tasks: &'a mut tokio::task::JoinSet<()>,
    indexed_read_tasks: &'a tokio::task::JoinSet<()>,
    automations: &'a mut project_automations::ProjectAutomations,
    automation_requested: &'a mut bool,
    idle_shutdown_requested: &'a mut bool,
    engine_factory: &'a AppServerEngineFactory,
    storage_scans: &'a storage_scans::StorageScans,
    provider_settings_state: &'a Result<provider_settings::ProviderSettingsState>,
    attachment_directories: &'a mut AttachmentDirectories,
    next_terminal_id: &'a AtomicU64,
    permission_mode: kcoder_config::PermissionMode,
    next_interaction_id: &'a Arc<AtomicU64>,
    connection_receipts: &'a Arc<StdMutex<InteractionReceipts>>,
    server_id: &'a str,
    sequence: &'a Arc<AtomicU64>,
    automation_fire: &'a Option<kcoder_tools::cron::CronFire>,
    state: &'a mut ConnectionState,
    thread_list_snapshots: &'a mut thread_list_snapshots::ThreadListSnapshots,
    retained_authority: Option<retained_turn::Authority<'a>>,
    retention_parent: Option<&'a retention_context::VerifiedRetentionAuthority>,
) -> futures::future::LocalBoxFuture<'a, Result<DispatchControl>> {
    futures::FutureExt::boxed_local(dispatch_inner(
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
        migration_activity,
        provider_tasks,
        indexed_read_tasks,
        automations,
        automation_requested,
        idle_shutdown_requested,
        engine_factory,
        storage_scans,
        provider_settings_state,
        attachment_directories,
        next_terminal_id,
        permission_mode,
        next_interaction_id,
        connection_receipts,
        server_id,
        sequence,
        automation_fire,
        state,
        thread_list_snapshots,
        retained_authority,
        retention_parent,
    ))
}

#[expect(
    clippy::too_many_arguments,
    reason = "Preserve the original separately borrowed owners behind the erased request future"
)]
async fn dispatch_inner(
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
    migration_activity: usize,
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
    next_interaction_id: &Arc<AtomicU64>,
    connection_receipts: &Arc<StdMutex<InteractionReceipts>>,
    server_id: &str,
    sequence: &Arc<AtomicU64>,
    automation_fire: &Option<kcoder_tools::cron::CronFire>,
    state: &mut ConnectionState,
    thread_list_snapshots: &mut thread_list_snapshots::ThreadListSnapshots,
    retained_authority: Option<retained_turn::Authority<'_>>,
    retention_parent: Option<&retention_context::VerifiedRetentionAuthority>,
) -> Result<DispatchControl> {
    if matches!(
        method,
        kcoder_app_protocol::METHOD_THREAD_ATTACH
            | kcoder_app_protocol::METHOD_THREAD_DETACH
            | kcoder_app_protocol::METHOD_THREAD_LIFETIME_READ
            | kcoder_app_protocol::METHOD_THREAD_LIFETIME_SET
    ) {
        return session_lifetime::dispatch(
            method,
            id,
            params,
            state,
            workspace_engine,
            thread_manager,
            outbound_tx,
        )
        .await;
    }
    #[cfg(target_os = "linux")]
    if state.native_acp_receiver_binding.is_some()
        && !matches!(
            method,
            "kcoder/nativeRemote/controlV1"
                | "thread/start"
                | "thread/read"
                | "thread/unsubscribe"
                | "turn/start"
                | "turn/interrupt"
        )
    {
        send(
            outbound_tx,
            error_response(id, -32086, "REMOTE_RECEIVER_CONNECTION_METHOD_DENIED"),
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    #[cfg(target_os = "linux")]
    if integrations::core::remote_delegations::receiver_acp_binding::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        engine_factory.is_native_acp_backend(),
        thread_manager.resident_engines().is_empty(),
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if async_question_requests::supports(method) {
        return async_question_requests::dispatch(
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
            next_interaction_id,
            retained_authority,
        )
        .await;
    }
    if method == kcoder_app_protocol::METHOD_THREAD_EXPERT {
        task_expert_requests::dispatch(
            id,
            params,
            workspace_engine,
            thread_manager,
            state,
            outbound_tx,
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    // `work/*` (continuous work) and the original-host task commands
    // (`thread/*` goal, compact, rollback, ...) are disjoint method sets.
    if continuous_work_read::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        continuous_work_read::ReadAccess {
            enabled: state.continuous_work_read_v1,
            partial_list: state.continuous_work_partial_list_v1,
            tasks: &mut state.continuous_work_read_tasks,
        },
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if continuous_work_mutation::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        &|thread_id| thread_manager.is_turn_running(thread_id),
        outbound_tx,
        continuous_work_mutation::MutationAccess {
            input: state.continuous_work_input_v1,
            control: state.continuous_work_control_v1,
            tasks: &mut state.continuous_work_mutation_tasks,
        },
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if web_search::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        engine_factory,
        thread_manager,
        server_id,
        state,
        outbound_tx,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::core::browser_profiles::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::core::remote_delegations::rpc::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::core::model_policy::dispatch::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::connectivity::main_rpc::dispatch(
        method,
        &id,
        &params,
        engine_factory,
        workspace_engine.clone(),
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::connectivity::task_capability_source_choices_rpc::dispatch(
        method,
        &id,
        &params,
        thread_manager,
        engine_factory,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::connectivity::task_capability_scope_control_rpc::dispatch(
        method,
        &id,
        &params,
        thread_manager,
        engine_factory,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::connectivity::task_capability_scope_directory_rpc::dispatch(
        method,
        &id,
        &params,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::core::task_workspace::rpc::dispatch(
        method,
        &id,
        &params,
        (workspace_engine, engine_factory),
        thread_manager,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::connectivity_settings::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        engine_factory,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::knowledge_settings::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        engine_factory,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::office::rpc::dispatch_settings(
        method,
        &id,
        &params,
        workspace_engine,
        engine_factory,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::office::rpc::dispatch_upload_finish(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
        attachment_directories,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::office::rpc::dispatch_export_read(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::office::rpc::dispatch_public(
        method,
        &id,
        &params,
        integrations::office::rpc::OfficePublicEngines {
            workspace: workspace_engine,
            threads: thread_manager,
            factory: engine_factory,
        },
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integration_requests::dispatch_memory_snapshot(
        method,
        &id,
        &params,
        engine,
        thread_manager,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integration_requests::dispatch_task_state(method, &id, &params, outbound_tx, state).await? {
        return Ok(DispatchControl::Continue);
    }
    if integrations::core::service_leases::native_code::rpc::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integrations::knowledge::application_selection_rpc::dispatch(
        method,
        &id,
        &params,
        workspace_engine,
        engine_factory,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if integration_requests::dispatch_knowledge(
        method,
        &id,
        &params,
        workspace_engine,
        outbound_tx,
        state,
    )
    .await?
    {
        return Ok(DispatchControl::Continue);
    }
    if task_delivery_requests::supports(method) {
        let result = task_delivery_requests::request(method, params, thread_manager).await;
        let response = match result {
            Ok(value) => success_response(id, value),
            Err(error) => error_response(id, -32602, &error.to_string()),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if method == kcoder_app_protocol::integrations::host::INTEGRATION_OPERATION_READ {
        let result = (|| -> Result<Value> {
            anyhow::ensure!(
                state.integration_operations_v1,
                "INTEGRATION_OPERATIONS_UNAVAILABLE"
            );
            let context = state
                .integration_context
                .as_mut()
                .context("INTEGRATION_SCOPE_UNAVAILABLE")?;
            serde_json::to_value(integrations::core::read_operation(
                params,
                workspace_engine,
                context,
                &mut state.integration_operations,
                &mut state.integration_memory,
            )?)
            .map_err(Into::into)
        })();
        send(
            outbound_tx,
            match result {
                Ok(value) => success_response(id, value),
                Err(_) => error_response(id, -32072, "INTEGRATION_OPERATIONS_UNAVAILABLE"),
            },
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    if integrations::core::memory_method(method).is_some() {
        let result = (|| -> Result<Value> {
            anyhow::ensure!(
                state.integration_memory_v1,
                "INTEGRATION_MEMORY_UNAVAILABLE"
            );
            let context = state
                .integration_context
                .as_mut()
                .context("INTEGRATION_SCOPE_UNAVAILABLE")?;
            serde_json::to_value(integrations::core::request_memory(
                method,
                params,
                workspace_engine,
                context,
                &mut state.integration_memory,
                &mut state.integration_operations,
            )?)
            .map_err(Into::into)
        })();
        let response = match result {
            Ok(value) => success_response(id, value),
            Err(_) => error_response(id, -32071, "INTEGRATION_MEMORY_UNAVAILABLE"),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if method == kcoder_app_protocol::integrations::host::INTEGRATION_SCOPE_READ {
        let result = integrations::core::read_scope(
            workspace_engine,
            state.integration_context.as_mut(),
            params,
        );
        let response = match result {
            Ok(value) => success_response(id, value),
            Err(_) => error_response(id, -32070, "INTEGRATION_SCOPE_UNAVAILABLE"),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if mcp_apps_rpc::supports(method) {
        mcp_apps_rpc::dispatch(
            method,
            id,
            params,
            thread_manager,
            state,
            outbound_tx,
            server_id,
        )
        .await?;
        return Ok(DispatchControl::Continue);
    }
    if widgets_dispatch::supports(method) {
        let response = match widgets_dispatch::request(method, params, thread_manager, state) {
            Ok(value) => success_response(id, value),
            Err(error) => error_response(id, -32602, &error.to_string()),
        };
        send(outbound_tx, response).await?;
        return Ok(DispatchControl::Continue);
    }
    if matches!(
        method,
        kcoder_app_protocol::knowledge_method::DIRECTORY_STAGE
            | kcoder_app_protocol::knowledge_method::DIRECTORY_PREVIEW
    ) {
        let result = (|| -> Result<Value> {
            let input: kcoder_app_protocol::KnowledgeDirectoryParams = rpc_codec::decode(params)?;
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
            anyhow::ensure!(state.wiki_rpc_tasks.len() < 16, "knowledge service is busy");
            let input: kcoder_app_protocol::KnowledgeImageImportParams = rpc_codec::decode(params)?;
            let settings = workspace_engine
                .settings_persistence_path()
                .context("knowledge profile unavailable")?;
            let context = kcoder_tools::ToolContext::new(workspace_engine.state.clone());
            let native =
                if integrations::core::NativeIntegrationContext::organization_launch_required()? {
                    Some(integrations::core::capture_scope(workspace_engine)?)
                } else {
                    None
                };
            Ok((input, settings, context, native))
        })();
        match prepared {
            Ok((input, settings, context, native)) => {
                let outbound = outbound_tx.clone();
                state.wiki_rpc_tasks.spawn_shared(async move {
                    let response =
                        match knowledge_image_imports::resume(&settings, input, context, native)
                            .await
                        {
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
            anyhow::ensure!(state.wiki_rpc_tasks.len() < 16, "knowledge service is busy");
            let input: kcoder_app_protocol::KnowledgeImportAttachmentParams =
                rpc_codec::decode(params)?;
            let path = knowledge_documents::authorize(&input, attachment_directories)?;
            let settings = workspace_engine
                .settings_persistence_path()
                .context("knowledge profile unavailable")?;
            let context = kcoder_tools::ToolContext::new(workspace_engine.state.clone());
            let native =
                if integrations::core::NativeIntegrationContext::organization_launch_required()? {
                    Some(integrations::core::capture_scope(workspace_engine)?)
                } else {
                    None
                };
            Ok((input, path, settings, context, native))
        })();
        match prepared {
            Ok((input, path, settings, context, native)) => {
                let outbound = outbound_tx.clone();
                state.wiki_rpc_tasks.spawn_shared(async move {
                    let response =
                        match knowledge_documents::import(&settings, input, path, context, native)
                            .await
                        {
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
            knowledge_worker_authority::authorize_enqueue(|| {
                integrations::core::capture_scope(workspace_engine)
            })?;
            let (settings, model) = engine_factory.knowledge_model()?;
            let (mut store, scope) = knowledge_requests::open_catalog(&path)?;
            let input = if method == kcoder_app_protocol::knowledge_method::JOB_START {
                rpc_codec::decode::<kcoder_app_protocol::KnowledgeJobStartParams>(params)?
            } else {
                let request: kcoder_app_protocol::KnowledgeJobParams = rpc_codec::decode(params)?;
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
                knowledge_worker_authority::bind_enqueued(
                    || integrations::core::capture_scope(workspace_engine),
                    &request.library_id,
                    &job,
                )?;
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
            knowledge_worker_authority::bind_enqueued(
                || integrations::core::capture_scope(workspace_engine),
                &input.library_id,
                &job,
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
                state.knowledge_tasks.spawn_shared(async move {
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
        if state.wiki_rpc_tasks.len() >= 16 {
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
        let knowledge_cwd = workspace_engine.state.cwd();
        let outbound = outbound_tx.clone();
        state.wiki_rpc_tasks.spawn_shared(async move {
            let result = tokio::task::spawn_blocking(move || {
                knowledge_catalog_dispatch::request_owned(&path, &knowledge_cwd, &method, params)
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
                migration_activity,
                provider_tasks,
                background_tasks_active(state),
                (
                    state.mcp_app_tasks.len(),
                    state
                        .mcp_app_pending_approvals
                        .try_lock()
                        .ok()
                        .map(|pending| pending.len()),
                ),
                indexed_read_tasks,
                automations,
                automation_requested,
                idle_shutdown_requested,
                !state.client_transport_only && state.native_scope_host.is_none(),
            )
            .await
        }
        method::AGENT_LIST
        | method::AGENT_ARTIFACT_READ
        | method::AGENT_STEER
        | method::AGENT_CONTINUE
        | method::AGENT_MESSAGE_READ
        | method::AGENT_MESSAGES_LIST
        | method::AGENT_MESSAGES_ARCHIVE => {
            agent_requests::dispatch(
                method,
                id,
                params,
                outbound_tx,
                thread_manager,
                state.agent_exact_control_v1,
                state.agent_exact_continuation_v1,
            )
            .await
        }
        method::AGENT_STOP | method::AGENT_LIVE_READ => {
            agent_requests::dispatch(
                method,
                id,
                params,
                outbound_tx,
                thread_manager,
                state.agent_exact_control_v1,
                state.agent_exact_continuation_v1,
            )
            .await
        }
        method::COMPUTER_USE_STATUS
        | method::DIAGNOSTICS_STORAGE_READ
        | method::DIAGNOSTICS_STORAGE_CANCEL
        | method::DIAGNOSTICS_STORAGE_CLEAN
        | method::DIAGNOSTICS_DEBUG_LOG_DISABLE
        | method::WORKFLOW_UPDATE
        | kcoder_app_protocol::WORKFLOW_COLLABORATION_CATALOG
        | kcoder_app_protocol::WORKFLOW_COLLABORATION_APPLY
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
        | method::SETTINGS_TOOL_SELECTIONS_READ
        | method::SETTINGS_TOOL_SELECTIONS_SAVE
        | method::SETTINGS_TOOLS_READ
        | method::SETTINGS_TOOLS_SAVE
        | method::SETTINGS_TURN_FILE_CHANGES_READ
        | method::SETTINGS_TURN_FILE_CHANGES_SAVE
        | method::SETTINGS_TEMPLATES_LIST
        | method::SETTINGS_TEMPLATES_READ
        | method::SETTINGS_TEMPLATES_SAVE
        | method::SETTINGS_TEMPLATES_DELETE
        | method::SETTINGS_TEMPLATES_DEFAULT
        | method::SETTINGS_EXECUTION_DEFAULTS_READ
        | method::SETTINGS_EXECUTION_DEFAULTS_SAVE => {
            settings_requests::dispatch(
                method,
                id,
                params,
                workspace_engine,
                engine_factory,
                thread_manager,
                outbound_tx,
                provider_tasks,
                storage_scans,
            )
            .await
        }
        method::DEVICE_EXECUTE
        | kcoder_app_protocol::method::THREAD_MODEL_SELECT
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
        | kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_HANDOFF
        | kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_CONTROL_READ
        | kcoder_app_protocol::browser_profiles::BROWSER_PROFILE_HUMAN_ACTION
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
                state
                    .integration_context
                    .as_mut()
                    .filter(|_| state.browser_profile_sessions_v1),
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
                next_interaction_id,
                connection_receipts,
                thread_manager,
                server_id,
                sequence,
                automations,
                automation_fire,
                state,
            )
            .boxed_local()
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
                next_interaction_id,
                connection_receipts,
                thread_manager,
                server_id,
                sequence,
                state,
            )
            .boxed_local()
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
                Some(state),
            )
            .await
        }
        kcoder_app_protocol::METHOD_THREAD_RUNTIME_HANDOFF_READ
        | kcoder_app_protocol::METHOD_THREAD_RUNTIME_HANDOFF_RELEASE => {
            thread_runtime_handoff_requests::dispatch(
                method,
                id,
                params,
                (engine, workspace_engine),
                outbound_tx,
                thread_manager,
                server_id,
                state,
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
                (engine, workspace_engine),
                outbound_tx,
                thread_manager,
                retention_parent,
                state,
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
            let result =
                match rpc_codec::decode::<kcoder_app_protocol::ComputerUseRevokeParams>(params) {
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
        method::TURN_STEER => {
            turn_steer_requests::dispatch(
                id,
                params,
                outbound_tx,
                thread_manager,
                next_interaction_id,
            )
            .await
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
                retained_authority,
            )
            .boxed_local()
            .await
        }
        _ => {
            send(outbound_tx, error_response(id, -32601, "Method not found")).await?;
            Ok(DispatchControl::Continue)
        }
    }
}

/// Idle shutdown and resource reports must see every connection-owned task set,
/// including a bounded continuous-work mutation that is still writing.
fn background_tasks_active(state: &ConnectionState) -> bool {
    !state.knowledge_tasks.is_empty()
        || !state.knowledge_rpc_tasks.is_empty()
        || !state.continuous_work_read_tasks.is_empty()
        || !state.continuous_work_mutation_tasks.is_empty()
        || !state.wiki_rpc_tasks.is_empty()
}

#[cfg(test)]
#[path = "rpc_dispatch.test.rs"]
mod tests;
