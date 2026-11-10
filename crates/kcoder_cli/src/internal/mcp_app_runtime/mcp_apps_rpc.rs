//! Bound host RPCs. Network and approval waits run in connection-owned tasks.
use super::mcp_apps_runtime::AppConnection;
use crate::ResidentThreads;
use anyhow::{Context, Result, ensure};
use kcoder_app_interactions::PendingApprovalResponses;
use kcoder_app_protocol::*;
use kcoder_engine::QueryEngine;
use kcoder_host_transport::{
    protocol_io::{error_response, send, success_response},
    task_spawn::JoinSetExt as _,
};
use kcoder_mcp_app_storage::{ledger as mcp_apps_ledger, resources as mcp_apps_resources};
use kcoder_tools::Tool;
use kcoder_types::{StudioWorkMode, mcp_apps::McpAppView, widgets::WidgetRef};
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::sync::mpsc;

/// Borrow the original connection's negotiated capabilities and owned resources.
pub struct AppRpcContext<'a> {
    pub mcp_apps_v1: bool,
    pub inline_widgets_v1: bool,
    pub studio_work_modes_v1: bool,
    pub isolated_widgets_v1: bool,
    pub mcp_app_registry: &'a Arc<crate::mcp_apps_registry::AppRegistry>,
    pub mcp_app_tasks: &'a mut tokio::task::JoinSet<()>,
    pub mcp_app_operations: &'a Arc<StdMutex<HashMap<String, usize>>>,
    pub mcp_app_pending_approvals: &'a PendingApprovalResponses,
}

// Keep the concrete dispatch future instantiated in this crate.
pub fn dispatch<'a, 'context: 'a>(
    method: &'a str,
    id: Value,
    params: Value,
    manager: &'a dyn ResidentThreads,
    state: &'a mut AppRpcContext<'context>,
    outbound: &'a mpsc::Sender<Value>,
    server_id: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(dispatch_inner(
        method, id, params, manager, state, outbound, server_id,
    ))
}

pub fn supports(method: &str) -> bool {
    matches!(
        method,
        mcp_apps_method::READ
            | mcp_apps_method::REVOKE
            | mcp_apps_method::TOOL_CALL
            | mcp_apps_method::OPERATION_READ
            | mcp_apps_method::RESOURCE_READ
            | mcp_apps_method::RESOURCE_CONTENT_READ
    )
}
fn binding(params: &Value) -> Result<McpAppReadParams> {
    Ok(McpAppReadParams {
        thread_id: params["threadId"]
            .as_str()
            .context("threadId required")?
            .into(),
        widget_id: params["widgetId"]
            .as_str()
            .context("widgetId required")?
            .into(),
        revision: params["revision"].as_u64().context("revision required")?,
        connection_id: params["connectionId"]
            .as_str()
            .context("connectionId required")?
            .into(),
    })
}
fn bound_view(
    params: &McpAppReadParams,
    manager: &dyn ResidentThreads,
    state: &AppRpcContext<'_>,
) -> Result<(QueryEngine, PathBuf, WidgetRef, McpAppView)> {
    ensure!(
        state.mcp_apps_v1 && state.inline_widgets_v1 && state.studio_work_modes_v1,
        "mcpAppsV1 and Studio presentation negotiation are required"
    );
    validate_thread_id(&params.thread_id)?;
    let engine = manager
        .engine(&params.thread_id)
        .context("MCP Apps requires a conversation owned by this connection")?;
    ensure!(
        engine.state.studio_work_mode() == StudioWorkMode::Kworker,
        "MCP Apps requires a kworker conversation"
    );
    let session = super::widgets_dispatch::store_directory(&engine, &params.thread_id)?;
    let store = kcoder_state::widgets::WidgetStore::open_existing(&session, &params.thread_id)?
        .context("MCP App artifact is unavailable")?;
    let (widget, view) = store.read_mcp_app(&params.widget_id, params.revision)?;
    ensure!(
        view.connection_id == params.connection_id,
        "MCP App connection does not match the retained artifact"
    );
    Ok((engine, session, widget, view))
}
fn live_entry(
    params: &McpAppReadParams,
    view: &McpAppView,
    state: &AppRpcContext<'_>,
) -> Result<Arc<AppConnection>> {
    ensure!(
        state.isolated_widgets_v1,
        "Native isolatedWidgetsV1 negotiation is required"
    );
    let entry = state
        .mcp_app_registry
        .get(&params.connection_id)
        .context("MCP App original live connection is unavailable")?;
    ensure!(
        entry.thread_id == params.thread_id
            && entry.connection_id == params.connection_id
            && entry.live(),
        "MCP App connection authority expired"
    );
    let source = entry
        .tools
        .get(&view.tool_name)
        .context("MCP App source tool is no longer allowed")?
        .source();
    let matches = match source {
        kcoder_tools::ToolSource::Mcp { server, tool } => {
            server == view.server_name && tool == view.tool_name && view.plugin_id.is_none()
        }
        kcoder_tools::ToolSource::Plugin {
            server,
            tool,
            plugin,
        } => {
            server == view.server_name
                && tool == view.tool_name
                && view.plugin_id.as_deref() == Some(plugin.as_str())
        }
        _ => false,
    };
    ensure!(
        matches,
        "MCP App source does not match the original connection"
    );
    Ok(entry)
}
async fn dispatch_inner(
    method: &str,
    id: Value,
    params: Value,
    manager: &dyn ResidentThreads,
    state: &mut AppRpcContext<'_>,
    outbound: &mpsc::Sender<Value>,
    server_id: &str,
) -> Result<()> {
    if method == mcp_apps_method::REVOKE {
        let result: Result<Value> = async {
            ensure!(
                state.mcp_apps_v1
                    && state.inline_widgets_v1
                    && state.studio_work_modes_v1
                    && state.isolated_widgets_v1,
                "MCP Apps lifecycle negotiation is required"
            );
            let params: McpAppRevokeParams = serde_json::from_value(params)?;
            validate_thread_id(&params.thread_id)?;
            let engine = manager
                .engine(&params.thread_id)
                .context("MCP Apps revocation requires an owned resident thread")?;
            ensure!(
                engine.state.studio_work_mode() == StudioWorkMode::Kworker,
                "MCP Apps revocation requires a kworker thread"
            );
            revoke_thread(state, Some(&params.thread_id)).await?;
            Ok(serde_json::to_value(McpAppRevokeResult { revoked: true })?)
        }
        .await;
        reply(outbound, id, result).await;
        return Ok(());
    }
    while state.mcp_app_tasks.try_join_next().is_some() {}
    let result: Result<Option<Value>> = (|| {
        let binding = binding(&params)?;
        let (engine, session, widget, view) = bound_view(&binding, manager, state)?;
        match method {
            mcp_apps_method::READ => {
                let _: McpAppReadParams = serde_json::from_value(params)?;
                let entry = live_entry(&binding, &view, state).ok();
                let mut allowed_tools = entry
                    .as_ref()
                    .map(|entry| {
                        entry
                            .tools
                            .iter()
                            .filter(|(_, tool)| tool.is_app_visible())
                            .map(|(name, _)| name.clone())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                allowed_tools.sort();
                let tool_info = entry
                    .as_ref()
                    .and_then(|entry| entry.tools.get(&view.tool_name))
                    .map(|tool| serde_json::to_value(tool.app_definition()))
                    .transpose()?;
                let value = serde_json::to_value(McpAppReadResult {
                    widget,
                    live: entry.is_some(),
                    protocol_version: kcoder_types::mcp_apps::MCP_APPS_PROTOCOL_VERSION.into(),
                    allowed_tools,
                    resources_enabled: entry.as_ref().is_some_and(|entry| entry.resources_enabled),
                    tool_info,
                    csp: view.csp,
                    requested_permissions: view.requested_permissions,
                    tool_input: view.tool_input,
                    tool_content: view.tool_content,
                    structured_content: view.structured_content,
                    result_meta: view.result_meta,
                })?;
                ensure!(
                    serde_json::to_vec(&value)?.len()
                        <= kcoder_types::mcp_apps::MCP_APP_VIEW_MAX_BYTES,
                    "MCP App read exceeds the encoded budget"
                );
                Ok(Some(value))
            }
            mcp_apps_method::RESOURCE_READ => {
                ensure!(state.mcp_app_tasks.len() < 16, "MCP App service is busy");
                let params: McpAppResourceReadParams = serde_json::from_value(params)?;
                let entry = live_entry(&binding, &view, state)?;
                ensure!(
                    entry.resources_enabled,
                    "MCP source does not support resources"
                );
                let tool = entry
                    .tools
                    .get(&view.tool_name)
                    .context("MCP App source is unavailable")?
                    .clone();
                let resource_reader = entry.resource_reader(&widget, &view.tool_name)?;
                let outbound = outbound.clone();
                let request_id = id.clone();
                state.mcp_app_tasks.spawn_shared(async move {
                    let result:Result<Value>=async {
                        let _lease=entry.lease.read().await;
                        ensure!(entry.live(),"MCP App connection was revoked");
                        resource_reader.authorize(&params.uri).await?;
                        let context=resource_reader.with_read_context(kcoder_tools::ToolContext::new(engine.state.clone()).with_inline_widgets_authorized(true).with_abort_token(entry.cancel.child_token()),&params.uri);
                        let result=tokio::select!{biased;_=entry.cancel.cancelled()=>anyhow::bail!("MCP App connection was revoked"),result=tool.read_app_resource_result(&params.uri,&context)=>result?};
                        ensure!(entry.live(),"MCP App connection was revoked");
                        resource_reader.authorize(&params.uri).await?;
                        let resource=mcp_apps_resources::ResourceStore::open(&session)?.commit(binding,params.uri,result)?;
                        Ok(serde_json::to_value(McpAppResourceReadResult{resource})?)
                    }.await;
                    reply(&outbound,request_id,result).await;
                });
                Ok(None)
            }
            mcp_apps_method::RESOURCE_CONTENT_READ => {
                ensure!(state.mcp_app_tasks.len() < 16, "MCP App service is busy");
                let params: McpAppResourceContentReadParams = serde_json::from_value(params)?;
                let entry = live_entry(&binding, &view, state)?;
                let reader = entry.resource_reader(&widget, &view.tool_name)?;
                let outbound = outbound.clone();
                let request_id = id.clone();
                state.mcp_app_tasks.spawn_shared(async move {
                    let result: Result<Value> = async {
                        let _lease = entry.lease.read().await;
                        ensure!(entry.live(), "MCP App connection was revoked");
                        let store = mcp_apps_resources::ResourceStore::open_existing(&session)?;
                        let reference =
                            store.reference(&binding, &params.resource_id, &params.sha256)?;
                        reader.authorize(&reference.uri).await?;
                        let value = store.chunk(
                            &binding,
                            &params.resource_id,
                            &params.sha256,
                            params.offset,
                        )?;
                        reader.authorize(&reference.uri).await?;
                        ensure!(entry.live(), "MCP App connection was revoked");
                        Ok(serde_json::to_value(value)?)
                    }
                    .await;
                    reply(&outbound, request_id, result).await;
                });
                Ok(None)
            }
            mcp_apps_method::TOOL_CALL => {
                ensure!(state.mcp_app_tasks.len() < 16, "MCP App service is busy");
                let params: McpAppToolCallParams = serde_json::from_value(params)?;
                mcp_apps_ledger::check_operation(&params.operation_id)?;
                let entry = live_entry(&binding, &view, state)?;
                let source_reader = entry.resource_reader(&widget, &view.tool_name)?;
                let approval_prompt = manager
                    .approval_prompt(&binding.thread_id)
                    .context("MCP App owning conversation is unavailable")?;
                let outbound = outbound.clone();
                let request_id = id.clone();
                let server_id = server_id.to_owned();
                let pending = Arc::clone(state.mcp_app_pending_approvals);
                let active = Arc::clone(state.mcp_app_operations);
                let key = format!("{}\0{}", binding.thread_id, params.operation_id);
                *active
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .entry(key.clone())
                    .or_insert(0) += 1;
                state.mcp_app_tasks.spawn_shared(async move {
                    let _active = ActiveOperation { active, key };
                    let result = super::mcp_apps_actions::execute(
                        engine,
                        approval_prompt,
                        super::mcp_apps_actions::AppCallConnection {
                            entry,
                            source_reader,
                        },
                        session,
                        params,
                        server_id,
                        pending,
                    )
                    .await
                    .and_then(|result| Ok(serde_json::to_value(result)?));
                    reply(&outbound, request_id, result).await;
                });
                Ok(None)
            }
            mcp_apps_method::OPERATION_READ => {
                let params: McpAppOperationReadParams = serde_json::from_value(params)?;
                let mut result = mcp_apps_ledger::OperationStore::open(&session)?
                    .read(&binding, &params.operation_id)?;
                let key = format!("{}\0{}", binding.thread_id, params.operation_id);
                if matches!(
                    result.status,
                    McpAppOperationStatus::Prepared | McpAppOperationStatus::Executing
                ) && !state
                    .mcp_app_operations
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .contains_key(&key)
                {
                    result.status = McpAppOperationStatus::OutcomeUnknown;
                    result.error_code = Some("mcp_app_receipt_unavailable".into());
                }
                Ok(Some(serde_json::to_value(result)?))
            }
            _ => anyhow::bail!("unsupported MCP Apps method"),
        }
    })();
    match result {
        Ok(Some(value)) => send(outbound, success_response(id, value)).await?,
        Ok(None) => {}
        Err(error) => send(outbound, error_response(id, -32602, &error.to_string())).await?,
    };
    Ok(())
}
async fn reply(outbound: &mpsc::Sender<Value>, id: Value, result: Result<Value>) {
    let response = match result {
        Ok(result) => success_response(id, result),
        Err(error) => error_response(id, -32602, &error.to_string()),
    };
    let _ = send(outbound, response).await;
}
struct ActiveOperation {
    active: Arc<StdMutex<HashMap<String, usize>>>,
    key: String,
}
impl Drop for ActiveOperation {
    fn drop(&mut self) {
        let mut active = self.active.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(count) = active.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.key);
            }
        }
    }
}
async fn revoke_thread(state: &mut AppRpcContext<'_>, thread: Option<&str>) -> Result<()> {
    revoke_original_registry(state.mcp_app_registry, thread).await
}
/// A retained original runtime cleanup owner may outlive its UI response pipe.
pub async fn revoke_original_registry(
    registry: &Arc<super::mcp_apps_registry::AppRegistry>,
    thread: Option<&str>,
) -> Result<()> {
    let entries = registry.revoke(thread);
    for entry in entries {
        // Revoke dispatch before waiting for storage owners. An uncooperative
        // operation must retain its artifacts instead of racing a deletion.
        let _exclusive = tokio::time::timeout(Duration::from_secs(5), entry.lease.write())
            .await
            .context("MCP App owned operation did not stop; session data was retained")?;
        match mcp_apps_resources::ResourceStore::open_existing(&entry.session_directory) {
            Ok(store) => store.release_connection(&entry.connection_id)?,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct NoResidentReads;
    impl ResidentThreads for NoResidentReads {
        fn engine(&self, _: &str) -> Option<QueryEngine> {
            panic!("negotiation rejection must precede resident access")
        }
        fn approval_prompt(
            &self,
            _: &str,
        ) -> Option<kcoder_app_interactions::AppServerPermissionPrompt> {
            panic!("negotiation rejection must precede approval-route access")
        }
    }

    #[test]
    fn widget_negotiation_rejects_before_resident_lookup() {
        let error = crate::widgets_dispatch::request(
            widget_method::LIST,
            json!({"threadId":"thread-1"}),
            &NoResidentReads,
            false,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "inlineWidgetsV1 negotiation is required");
    }

    #[tokio::test]
    async fn revoke_negotiation_rejects_before_resident_lookup_or_spawn() {
        let registry = Arc::new(crate::mcp_apps_registry::AppRegistry::default());
        let operations = Arc::new(StdMutex::new(HashMap::new()));
        let pending = Arc::new(StdMutex::new(HashMap::new()));
        let mut tasks = tokio::task::JoinSet::new();
        let mut context = AppRpcContext {
            mcp_apps_v1: false,
            inline_widgets_v1: true,
            studio_work_modes_v1: true,
            isolated_widgets_v1: true,
            mcp_app_registry: &registry,
            mcp_app_tasks: &mut tasks,
            mcp_app_operations: &operations,
            mcp_app_pending_approvals: &pending,
        };
        let (outbound, mut frames) = mpsc::channel(1);
        dispatch(
            mcp_apps_method::REVOKE,
            json!(7),
            json!({"threadId":"thread-1"}),
            &NoResidentReads,
            &mut context,
            &outbound,
            "server-1",
        )
        .await
        .unwrap();
        let response = frames.try_recv().unwrap();
        assert_eq!(response["id"], 7);
        assert_eq!(response["error"]["code"], -32602);
        assert_eq!(
            response["error"]["message"],
            "MCP Apps lifecycle negotiation is required"
        );
        assert!(context.mcp_app_tasks.is_empty());
    }
}
