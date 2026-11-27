//! Runtime-free integration, task capability scope and continuous work contracts.
use kcoder_common_types::{
    BackgroundEventIdentity, BackgroundRunKey, CronSchedule, ModelConfigurationSummary,
    ProviderFailureDetails, TaskStatus, TurnAttemptIdentity,
};

pub mod agent_definition;
pub mod continuous_work;
pub mod integrations;
pub mod mcp_authorization;
