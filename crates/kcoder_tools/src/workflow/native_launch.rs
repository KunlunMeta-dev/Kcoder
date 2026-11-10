use crate::ToolError;

/// Exact persisted workflow identity, available only to the owning native caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowNativeLaunch {
    pub run_id: String,
    pub definition_id: String,
    pub version: u64,
    pub definition_sha256: String,
    pub inputs_sha256: String,
}

/// Persist the original operation-to-run binding before any workflow effect.
/// Returning an error prevents dispatch. Tool JSON cannot install this callback.
pub trait WorkflowNativeLaunchObserver: Send + Sync {
    fn before_dispatch(&self, launch: &WorkflowNativeLaunch) -> Result<(), ToolError>;
}
