//! Shared tool failure contract for execution and service adapters.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("input validation failed: {0}")]
    InvalidInput(String),
    #[error("tool execution failed: {0}")]
    Execution(String),
    #[error("sandbox denied: {reason}")]
    SandboxDenied {
        reason: String,
        output: Option<String>,
    },
    #[error("tool was aborted")]
    Aborted,
}
