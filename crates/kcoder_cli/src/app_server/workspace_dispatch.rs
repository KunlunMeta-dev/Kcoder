//! App Server authority and durable receipt ordering for workspace requests.

use super::*;
use kcoder_workspace_rpc::validate_workspace_mutation;

pub(super) async fn workspace_request(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    if method == kcoder_app_protocol::METHOD_WORKSPACE_OPERATION_READ {
        let input: kcoder_app_protocol::WorkspaceOperationReadParams =
            serde_json::from_value(params.clone())?;
        return workspace_operation_receipts::query(engine, &input.client_request_id);
    }
    if matches!(
        method,
        "runtime.workspaces.open" | "runtime.workspaces.prepare"
    ) {
        let input: kcoder_app_protocol::WorkspaceOperationMutationParams =
            serde_json::from_value(params.clone())?;
        if let Some(id) = input.client_request_id.as_deref() {
            validate_workspace_mutation(method, params).await?;
            if let Some(result) = workspace_operation_receipts::reserve(engine, id, method, params)?
            {
                return Ok(result);
            }
            let result = workspace_request_without_receipt(engine, method, params).await?;
            workspace_operation_receipts::complete(engine, id, &result)?;
            return Ok(result);
        }
    }
    workspace_request_without_receipt(engine, method, params).await
}

pub(super) async fn workspace_request_without_receipt(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    kcoder_workspace_rpc::workspace_request_without_receipt(
        &client_workspace_store(engine),
        &engine.state,
        method,
        params,
    )
    .await
}

pub(super) async fn workspace_search_request(
    engine: &QueryEngine,
    params: &Value,
) -> Result<Value> {
    kcoder_workspace_rpc::workspace_search_request(
        &client_worktree_store(engine),
        &engine.state,
        params,
    )
    .await
}
