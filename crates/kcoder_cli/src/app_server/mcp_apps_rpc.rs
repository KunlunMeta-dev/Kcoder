//! Bind MCP Apps RPCs to the original connection and its resident threads.
use super::*;
use kcoder_mcp_app_runtime::mcp_apps_rpc::{self as runtime, AppRpcContext};
pub(super) use kcoder_mcp_app_runtime::mcp_apps_rpc::{revoke_original_registry, supports};

pub(super) async fn dispatch(
    method: &str,
    id: Value,
    params: Value,
    manager: &ThreadManager,
    state: &mut ConnectionState,
    outbound: &mpsc::Sender<Value>,
    server_id: &str,
) -> Result<()> {
    let mut context = AppRpcContext {
        mcp_apps_v1: state.mcp_apps_v1,
        inline_widgets_v1: state.inline_widgets_v1,
        studio_work_modes_v1: state.studio_work_modes_v1,
        isolated_widgets_v1: state.isolated_widgets_v1,
        mcp_app_registry: &state.mcp_app_registry,
        mcp_app_tasks: &mut state.mcp_app_tasks,
        mcp_app_operations: &state.mcp_app_operations,
        mcp_app_pending_approvals: &state.mcp_app_pending_approvals,
    };
    runtime::dispatch(
        method,
        id,
        params,
        manager,
        &mut context,
        outbound,
        server_id,
    )
    .await
}

pub(super) async fn revoke_thread(state: &mut ConnectionState, thread: Option<&str>) -> Result<()> {
    runtime::revoke_original_registry(&state.mcp_app_registry, thread).await
}
