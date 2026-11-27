//! Original task history and workspace checks under the lifecycle lock.
use super::try_acquire_thread_lifecycle_locks;
use crate::app_server::transcript_projection::{thread_history_path, validate_thread_id};
use anyhow::{Context, Result, ensure};

/// Resolve only formally recorded storage relocation, using this Engine's
/// existing Native configuration source rather than the process default Home.
pub(in crate::app_server) fn persisted_workspace(
    engine: &kcoder_engine::QueryEngine,
    recorded: &std::path::Path,
) -> Result<std::path::PathBuf> {
    match engine.native_settings_source_path() {
        Some(source) => kcoder_state::resolve_session_workspace(
            source
                .parent()
                .context("NATIVE_SETTINGS_SOURCE_UNAVAILABLE")?,
            recorded,
        ),
        None => Ok(recorded.to_owned()),
    }
}

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

/// A resident task's live Engine and session lease are the authority for its
/// history, so per-request access revalidates only deletion, workspace and
/// channel facts from that Engine. Replaying the append-only body would fail
/// whenever the live turn commits (streaming or compaction), and a brand-new
/// task may not have persisted a history file or sidecar yet.
pub(in crate::app_server) fn resident_task_access(
    origin: &kcoder_engine::QueryEngine,
    engine: &kcoder_engine::QueryEngine,
    thread: &str,
) -> Result<Vec<std::fs::File>> {
    validate_thread_id(thread)?;
    ensure!(engine.session_id() == thread, "AGENT_ORIGINAL_TASK_CHANGED");
    let locks = try_acquire_thread_lifecycle_locks(origin, &[thread])?;
    if let Some(path) = engine.state.history_path() {
        kcoder_state::ensure_live_history_source(&path)?;
    }
    let base_cwd = engine.state.base_cwd();
    let legacy_channel_source = engine.state.channel_task_source().is_some()
        || engine.state.agent_definition().is_some_and(|binding| {
            binding.source == kcoder_types::agent_definition::AgentTaskSource::Channel
        });
    verify_task_workspace(origin, Some(&base_cwd), legacy_channel_source)?;
    Ok(locks)
}

/// A task that is not resident (evicted, never resumed by this app-server, or
/// owned elsewhere) is observed from its persisted sidecar only. The body is
/// never replayed and no Engine or model session is started.
pub(in crate::app_server) fn persisted_task_access(
    origin: &kcoder_engine::QueryEngine,
    thread: &str,
) -> Result<(Vec<std::fs::File>, kcoder_state::PreparedSessionMetadata)> {
    validate_thread_id(thread)?;
    let locks = try_acquire_thread_lifecycle_locks(origin, &[thread])?;
    let path = thread_history_path(origin, thread)?;
    let metadata = kcoder_state::prepare_live_task_metadata(&path)?;
    verify_task_workspace(
        origin,
        metadata.base_cwd(),
        metadata.has_legacy_channel_source(),
    )?;
    Ok((locks, metadata))
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
    let recorded = base_cwd.context("CHAT_TASK_WORKSPACE_UNKNOWN")?;
    ensure!(
        persisted_workspace(origin, recorded)?.canonicalize()? == workspace,
        "CHAT_TASK_WORKSPACE_CHANGED"
    );
    ensure!(
        !legacy_channel_source,
        "CHAT_TASK_LEGACY_SOURCE_MIGRATION_REQUIRED"
    );
    Ok(())
}
