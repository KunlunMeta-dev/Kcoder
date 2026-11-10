//! Finite, read-only aggregation of existing native task references.
use serde::{Deserialize, Serialize};
pub const CAPABILITY_TASK_WORKSPACE_V1: &str = "taskWorkspaceV1";
/// Legacy negotiated name retained for clients that request task scope observations.
pub const CAPABILITY_TASK_WORKSPACE_CAPABILITY_SCOPE_V1: &str = "taskWorkspaceSourcesV1";
pub const TASK_WORKSPACE_READ: &str = "integrations/tasks/readWorkspace";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum TaskWorkspaceMethod {
    #[serde(rename = "integrations/tasks/readWorkspace")]
    Read,
}
