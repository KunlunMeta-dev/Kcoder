//! Original task history and workspace checks under the lifecycle lock.
use super::try_acquire_thread_lifecycle_locks;
use crate::app_server::transcript_projection::{thread_history_path, validate_thread_id};
use anyhow::{Result, ensure};

pub(in crate::app_server) fn task_access(
    origin: &kcoder_engine::QueryEngine,
    thread: &str,
) -> Result<Vec<std::fs::File>> {
    task_access_for_resume(origin, thread).map(|(locks, _)| locks)
}

/// A caller that also needs the persisted configuration reuses the exact
/// history validated under the original task lifecycle lock.
pub(in crate::app_server) fn task_access_for_resume(
    origin: &kcoder_engine::QueryEngine,
    thread: &str,
) -> Result<(Vec<std::fs::File>, kcoder_state::PreparedSessionResume)> {
    validate_thread_id(thread)?;
    let locks = try_acquire_thread_lifecycle_locks(origin, &[thread])?;
    let path = thread_history_path(origin, thread)?;
    let prepared = prepare_task_history(origin, &path)?;
    Ok((locks, prepared))
}

fn prepare_task_history(
    origin: &kcoder_engine::QueryEngine,
    path: &std::path::Path,
) -> Result<kcoder_state::PreparedSessionResume> {
    let prepared = kcoder_state::prepare_session_resume(path)?;
    verify_task_workspace(
        origin,
        prepared.persisted_base_cwd(),
        prepared.has_legacy_channel_source(),
    )?;
    Ok(prepared)
}

fn verify_task_workspace(
    origin: &kcoder_engine::QueryEngine,
    base_cwd: Option<&std::path::Path>,
    legacy_channel_source: bool,
) -> Result<()> {
    let workspace = origin.state.cwd().canonicalize()?;
    ensure!(
        base_cwd.is_some_and(|cwd| cwd.canonicalize().is_ok_and(|actual| actual == workspace)),
        "CHAT_TASK_WORKSPACE_CHANGED"
    );
    ensure!(
        !legacy_channel_source,
        "CHAT_TASK_LEGACY_SOURCE_MIGRATION_REQUIRED"
    );
    Ok(())
}
