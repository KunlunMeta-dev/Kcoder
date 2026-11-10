use anyhow::{Context, Result};
use kcoder_cli_storage::tracked_history_list::candidate_thread_history_path;
use kcoder_engine::QueryEngine;
use kcoder_workspace_resources::managed_worktrees::validate_thread_id;
use std::path::PathBuf;

pub fn thread_history_path(engine: &QueryEngine, thread_id: &str) -> Result<PathBuf> {
    validate_thread_id(thread_id)?;
    if thread_id == engine.session_id() {
        return engine
            .state
            .history_path()
            .context("session history is disabled");
    }
    let history_path = engine
        .state
        .history_path()
        .context("session history is disabled")?;
    let history_dir = history_path
        .parent()
        .context("session history path has no parent")?;
    let path = candidate_thread_history_path(history_dir, thread_id)?;
    let metadata = std::fs::symlink_metadata(&path)
        .with_context(|| format!("persisted thread not found: {thread_id}"))?;
    if !metadata.file_type().is_file() {
        anyhow::bail!("persisted thread is not a regular file: {thread_id}")
    }
    let expected = std::fs::canonicalize(engine.state.cwd())?;
    let persisted = kcoder_state::history_persisted_base_cwd(&path)?
        .context("persisted thread has no base cwd")?;
    if std::fs::canonicalize(&persisted)? != expected {
        anyhow::bail!("persisted thread belongs to another workspace")
    }
    Ok(path)
}
