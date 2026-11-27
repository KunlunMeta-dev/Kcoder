//! Skill package input and local metadata services.

#[path = "curator.rs"]
pub mod curator;
#[path = "package.rs"]
pub mod package;
#[path = "../../skill_provenance.rs"]
pub mod skill_provenance;
#[path = "../../skill_telemetry.rs"]
pub mod skill_telemetry;

#[derive(Debug, thiserror::Error)]
pub enum SkillSupportError {
    #[error("input validation failed: {0}")]
    InvalidInput(String),
    #[error("tool execution failed: {0}")]
    Execution(String),
}

impl From<SkillSupportError> for kcoder_tool_error::ToolError {
    fn from(error: SkillSupportError) -> Self {
        match error {
            SkillSupportError::InvalidInput(message) => Self::InvalidInput(message),
            SkillSupportError::Execution(message) => Self::Execution(message),
        }
    }
}
