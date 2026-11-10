//! Shared model settings and identities used by session and integration contracts.
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

mod background_identity;
mod cron_schedule;
mod model_configuration;
mod private_file_identity;
mod provider_failure;
mod reasoning_policy;
mod task_status;
mod turn_attempt;

pub use background_identity::{BackgroundEventIdentity, BackgroundRunKey};
pub use cron_schedule::CronSchedule;
pub use model_configuration::{
    AgentModelSelectionSource, DEFAULT_MODEL_OUTPUT_TOKENS, ModelConfigurationBoundary,
    ModelConfigurationSummary, ModelToolRegistryScope, ModelToolSetSummary,
    WorkflowAgentConfigurationSummary,
};
pub use private_file_identity::{
    PrivateFileIdentityV1, PrivateFileKind, PrivateNativeFileIdentity,
};
pub use provider_failure::{
    ProviderFailureCategory, ProviderFailureDetails, ProviderFailureRecoveryAction,
};
pub use reasoning_policy::{ModelReasoningPolicy, ReasoningControlMode};
pub use task_status::TaskStatus;
pub use turn_attempt::{
    TurnAttemptIdentity, TurnAttemptStatus, TurnRetainedArtifactV1, TurnRetainedInputV1,
};

/// Model reasoning effort used by OpenAI-compatible reasoning models.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Custom(String),
}

impl ReasoningEffort {
    pub fn as_str(&self) -> &str {
        match self {
            Self::None => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Custom(value) => value.as_str(),
        }
    }
}

impl fmt::Display for ReasoningEffort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReasoningEffortParseError;

impl fmt::Display for ReasoningEffortParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("reasoning effort cannot be empty")
    }
}

impl std::error::Error for ReasoningEffortParseError {}

impl FromStr for ReasoningEffort {
    type Err = ReasoningEffortParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(ReasoningEffortParseError);
        }
        Ok(match trimmed.to_ascii_lowercase().as_str() {
            "none" => Self::None,
            "minimal" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" => Self::XHigh,
            _ => Self::Custom(trimmed.to_string()),
        })
    }
}

impl Serialize for ReasoningEffort {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ReasoningEffort {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}
