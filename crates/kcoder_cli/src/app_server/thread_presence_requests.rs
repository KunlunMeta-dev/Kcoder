//! Capture thread presence inputs from the owning connection.
use super::*;
pub(super) use kcoder_thread_metadata::presence::{
    CancellationGuard, ObservationInput, parse_params, spawn_observation_task, unknown,
};

/// Copies only immutable identity and path facts on the connection thread.
/// Filesystem observation is performed by the bounded blocking worker.
pub(super) fn capture_input(
    thread_id: &str,
    workspace_engine: &QueryEngine,
    thread_manager: &ThreadManager,
) -> ObservationInput {
    let workspace_cwd = workspace_engine.state.cwd();
    if let Some(resident) = thread_manager.engine(thread_id) {
        ObservationInput::Resident {
            thread_id: thread_id.to_string(),
            resident_session_id: resident.session_id(),
            resident_cwd: resident.state.cwd(),
            workspace_cwd,
        }
    } else {
        ObservationInput::Cold {
            thread_id: thread_id.to_string(),
            workspace_history_path: workspace_engine.state.history_path(),
            workspace_cwd,
        }
    }
}
