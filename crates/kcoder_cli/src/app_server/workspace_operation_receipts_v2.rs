//! App Server selection of workspace stores for durable V2 receipts.

use super::*;
use kcoder_app_protocol::PrivateRetentionRequestV1;

pub(super) use kcoder_workspace_rpc::receipts::error_code;

pub(super) async fn dispatch(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    request: &PrivateRetentionRequestV1,
) -> Result<Value> {
    kcoder_workspace_rpc::receipts::dispatch(
        authority,
        &engine.state,
        &client_workspace_store(engine),
        &client_worktree_store(engine),
        request,
    )
    .await
}

#[cfg(test)]
pub(super) async fn dispatch_with_receipt_limit(
    authority: &retention_context::VerifiedRetentionAuthority,
    engine: &QueryEngine,
    request: &PrivateRetentionRequestV1,
    limit: usize,
) -> Result<Value> {
    kcoder_workspace_rpc::receipts::dispatch_with_receipt_limit(
        authority,
        &engine.state,
        &client_workspace_store(engine),
        &client_worktree_store(engine),
        request,
        limit,
    )
    .await
}
