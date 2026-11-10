//! Bind managed worktree operations to the app-server's selected workspace.

use super::*;

pub(super) async fn authorized_worktree_source(
    engine: &QueryEngine,
    configured_root: &Path,
    requested: &Path,
) -> Result<PathBuf> {
    kcoder_workspace_resources::managed_worktrees::authorized_worktree_source(
        &client_workspace_store(engine),
        configured_root,
        requested,
    )
    .await
}

pub(super) async fn worktree_request(
    engine: &QueryEngine,
    method: &str,
    params: &Value,
) -> Result<Value> {
    kcoder_workspace_resources::managed_worktrees::worktree_request(
        &client_worktree_store(engine),
        &client_workspace_store(engine),
        &engine.state.cwd(),
        method,
        params,
    )
    .await
}
