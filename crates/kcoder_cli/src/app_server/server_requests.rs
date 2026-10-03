//! Server requests: extracted from the app-server connection boundary.

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
    provider_tasks: &tokio::task::JoinSet<()>,
    knowledge_busy: bool,
    indexed_read_tasks: &tokio::task::JoinSet<()>,
    automations: &mut project_automations::ProjectAutomations,
    automation_requested: &mut bool,
    idle_shutdown_requested: &mut bool,
) -> Result<DispatchControl> {
    match method {
        "initialized" => {}
        kcoder_app_protocol::method::USAGE_STATS => {
            let response = usage_processor::process(id, params, workspace_engine).await;
            send(outbound_tx, response).await?;
        }
        "cron/list" | "cron/create" | "cron/delete" | method::CRON_PREVIEW => {
            let result = (|| -> Result<_> {
                let target = if let Some(thread_id) = params.get("threadId").and_then(Value::as_str)
                {
                    let target = thread_manager
                        .engine(thread_id)
                        .context("thread/start or thread/resume is required")?;
                    ensure_active_thread(&target, thread_manager.lease(thread_id), thread_id)?;
                    target
                } else {
                    workspace_engine.clone()
                };
                cron_processor::process(&target, method, params.clone())
            })();
            if result.is_ok() && method != kcoder_app_protocol::method::CRON_PREVIEW {
                *automation_requested = true;
            }
            let response = match result {
                Ok(value) => success_response(id, value),
                Err(error) => error_response(id, -32602, &error.to_string()),
            };
            send(outbound_tx, response).await?;
        }
        "server/info" => {
            // `engine` caches the most recently selected turn runtime. Once that
            // resident runtime is deleted, connection-level state APIs must not expose the removed thread.
            let info_engine = thread_manager
                .engine(&engine.session_id())
                .filter(|resident| !thread_manager.is_ephemeral(&resident.session_id()))
                .or_else(|| {
                    thread_manager
                        .resident_engines()
                        .into_iter()
                        .find(|resident| !thread_manager.is_ephemeral(&resident.session_id()))
                });
            let response = match info_engine {
                Some(info_engine) => success_response(
                    id,
                    thread_snapshot(
                        &info_engine,
                        thread_manager.is_turn_running(&info_engine.session_id()),
                    ),
                ),
                None => error_response(id, -32022, "thread/start or thread/resume is required"),
            };
            send(outbound_tx, response).await?;
        }
        method::SERVER_IDLE_SHUTDOWN => {
            let parsed = serde_json::from_value::<kcoder_app_protocol::ServerIdleShutdownParams>(
                params.clone(),
            );
            let valid = params.is_object()
                && parsed
                    .as_ref()
                    .is_ok_and(|params| params.instance_id == resources_processor::instance_id());
            if !valid {
                send(
                    outbound_tx,
                    error_response(id, -32602, "idle shutdown requires the current instanceId"),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            if terminals.resource_count() != Some(0)
                || browsers.resource_count() != 0
                || !plugin_tasks.is_empty()
                || !provider_tasks.is_empty()
                || knowledge_busy
                || !indexed_read_tasks.is_empty()
                || history_refresh.is_active()
            {
                send(
                    outbound_tx,
                    success_response(id, json!({"accepted":false,"reason":"resources"})),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            let reservation =
                match thread_manager.try_reserve_workspace_idle_with_reason(workspace_engine) {
                    Ok(reservation) => reservation,
                    Err(reason) => {
                        send(
                            outbound_tx,
                            success_response(id, json!({"accepted":false,"reason":reason})),
                        )
                        .await?;
                        return Ok(DispatchControl::Continue);
                    }
                };
            if !automations.stop_if_idle() {
                drop(reservation);
                send(
                    outbound_tx,
                    success_response(id, json!({"accepted":false,"reason":"automations"})),
                )
                .await?;
                return Ok(DispatchControl::Continue);
            }
            // No await between the final checks and closing all engine admissions.
            reservation.commit();
            *idle_shutdown_requested = true;
            let _ = send(outbound_tx, success_response(id, json!({"accepted":true}))).await;
            return Ok(DispatchControl::Shutdown);
        }
        method::SERVER_RESOURCES_READ => {
            let (resident_threads, running_turns) = thread_manager.resource_counts();
            let task_activity = thread_manager.task_activity_counts(workspace_engine);
            let interactions = thread_manager.interaction_activity_counts();
            let automation_activity = automations.resource_activity();
            let background = thread_manager.background_activity_counts(workspace_engine);
            let activity = kcoder_app_protocol::ServerResourceActivity {
                resident_threads: Some(resident_threads),
                running_turns: Some(running_turns),
                terminal_sessions: terminals.resource_count(),
                browser_sessions: Some(browsers.resource_count()),
                pending_service_requests: Some(
                    plugin_tasks.len() + provider_tasks.len() + indexed_read_tasks.len(),
                ),
                history_refresh_active: Some(history_refresh.is_active()),
                pending_tasks: task_activity.map(|counts| counts.0),
                running_tasks: task_activity.map(|counts| counts.1),
                pending_approvals: interactions.map(|counts| counts.0),
                pending_questions: interactions.map(|counts| counts.1),
                queued_followups: interactions.map(|counts| counts.2),
                pending_goal_continuations: interactions.map(|counts| counts.3),
                cached_scheduled_jobs: automation_activity.0,
                pending_automation_requests: Some(automation_activity.1),
                automation_subscribed: Some(automation_activity.2),
                registered_background_jobs: background.map(|counts| counts.0),
                background_cancellation_markers: background.map(|counts| counts.1),
                registered_prefires: background.map(|counts| counts.2),
            };
            send(
                outbound_tx,
                resources_processor::process(id, params, activity),
            )
            .await?;
        }
        _ => unreachable!("RPC family was routed incorrectly"),
    }
    Ok(DispatchControl::Continue)
}
