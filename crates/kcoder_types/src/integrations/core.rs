//! Shared integration envelopes. Scope references never grant execution authority.
mod native_scope_host;
pub use native_scope_host::*;
mod app_server_hosts;
pub use app_server_hosts::*;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;
mod operations;
pub use operations::*;
mod models;
pub use models::*;
mod ports;
pub use ports::{IntegrationMethod, IntegrationPort};
mod delegation;
pub use delegation::*;
mod authorization_time;
pub use authorization_time::*;
mod task_capability_scope;
pub use task_capability_scope::*;
mod task_capability_source_choices;
pub use task_capability_source_choices::*;
mod task_capability_scope_control;
pub use task_capability_scope_control::*;
mod task_workspace;
pub use task_workspace::*;
mod task_state;
pub use task_state::*;
mod native_code_services;
pub use native_code_services::*;
mod native_office_scope;
pub use native_office_scope::*;

pub const INTEGRATION_CONTRACT_VERSION: &str = "parallel-v1";
pub const INTEGRATION_MAX_ID_CHARS: usize = 256;
pub const INTEGRATION_MAX_WAIT_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum IntegrationContractVersion {
    #[serde(rename = "parallel-v1")]
    ParallelV1,
}

/// Unlike Option, a missing field is not interchangeable with an explicit null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum IntegrationNullable<T> {
    Null,
    Value(T),
}

impl<T> IntegrationNullable<T> {
    pub fn as_ref(&self) -> Option<&T> {
        match self {
            Self::Null => None,
            Self::Value(value) => Some(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationScope {
    pub account_id: String,
    pub target_id: String,
    pub workspace_id: IntegrationNullable<String>,
    pub identity_generation: String,
    pub target_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<IntegrationNullable<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRequest {
    pub contract_version: IntegrationContractVersion,
    pub request_id: String,
    pub scope: IntegrationScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    pub timeout_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancellation_ref: Option<String>,
    pub payload: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationRecovery {
    None,
    RetryRead,
    ReconcileOriginal,
    RepairConfiguration,
    RequestAuthorization,
    ExplicitUserDecision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationError {
    pub code: String,
    pub recovery: IntegrationRecovery,
    pub message_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum IntegrationStatus {
    Accepted,
    Completed,
    Rejected,
    Unknown,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationReply {
    pub contract_version: IntegrationContractVersion,
    pub request_id: String,
    pub status: IntegrationStatus,
    pub operation_id: IntegrationNullable<String>,
    pub entity_revision: IntegrationNullable<String>,
    pub observed_at: String,
    pub result: IntegrationNullable<Map<String, Value>>,
    pub error: IntegrationNullable<IntegrationError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntegrationValidationError {
    pub field: &'static str,
    pub reason: &'static str,
}

impl fmt::Display for IntegrationValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.field, self.reason)
    }
}

impl std::error::Error for IntegrationValidationError {}

fn invalid(field: &'static str, reason: &'static str) -> IntegrationValidationError {
    IntegrationValidationError { field, reason }
}

fn id(value: &str, field: &'static str) -> Result<(), IntegrationValidationError> {
    let len = value.chars().count();
    if len == 0 || len > INTEGRATION_MAX_ID_CHARS {
        return Err(invalid(
            field,
            "identifier length is outside the contract bound",
        ));
    }
    Ok(())
}

impl IntegrationScope {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        for (value, field) in [
            (&self.account_id, "scope.accountId"),
            (&self.target_id, "scope.targetId"),
            (&self.identity_generation, "scope.identityGeneration"),
            (&self.target_revision, "scope.targetRevision"),
        ] {
            id(value, field)?;
        }
        if let Some(value) = self.workspace_id.as_ref() {
            id(value, "scope.workspaceId")?;
        }
        if let Some(IntegrationNullable::Value(value)) = &self.organization_id {
            id(value, "scope.organizationId")?;
        }
        Ok(())
    }
}

impl IntegrationRequest {
    pub fn validate_method(
        &self,
        port: IntegrationPort,
        method: &str,
    ) -> Result<(), IntegrationValidationError> {
        let method = port
            .method(method)
            .ok_or_else(|| invalid("method", "unknown integration method"))?;
        self.validate(method.operation_identity_required)
    }

    /// The authenticated host must separately authorize the method and resources.
    pub fn validate(&self, mutation: bool) -> Result<(), IntegrationValidationError> {
        id(&self.request_id, "requestId")?;
        self.scope.validate()?;
        if self.timeout_ms == 0 || self.timeout_ms > INTEGRATION_MAX_WAIT_MS {
            return Err(invalid(
                "timeoutMs",
                "wait budget is outside the contract bound",
            ));
        }
        if mutation && self.operation_id.is_none() {
            return Err(invalid(
                "operationId",
                "mutations require a stable operation identity",
            ));
        }
        for (value, field) in [
            (&self.operation_id, "operationId"),
            (&self.expected_revision, "expectedRevision"),
            (&self.cancellation_ref, "cancellationRef"),
        ] {
            if let Some(value) = value {
                id(value, field)?;
            }
        }
        Ok(())
    }
}

impl IntegrationError {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        if self.code.is_empty()
            || self.code.len() > 96
            || !self.code.as_bytes()[0].is_ascii_uppercase()
            || !self
                .code
                .bytes()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
        {
            return Err(invalid(
                "error.code",
                "expected a bounded public error code",
            ));
        }
        let len = self.message_key.chars().count();
        if len == 0 || len > 160 {
            return Err(invalid(
                "error.messageKey",
                "expected a bounded localization key",
            ));
        }
        Ok(())
    }
}

impl IntegrationReply {
    pub fn validate(&self) -> Result<(), IntegrationValidationError> {
        id(&self.request_id, "requestId")?;
        if let Some(value) = self.operation_id.as_ref() {
            id(value, "operationId")?;
        }
        if let Some(value) = self.entity_revision.as_ref() {
            id(value, "entityRevision")?;
        }
        match self.status {
            IntegrationStatus::Accepted | IntegrationStatus::Completed => {
                if self.error.as_ref().is_some() {
                    return Err(invalid(
                        "error",
                        "successful port operations cannot carry an error",
                    ));
                }
                if self.status == IntegrationStatus::Accepted
                    && self.operation_id.as_ref().is_none()
                {
                    return Err(invalid(
                        "operationId",
                        "accepted operations require their original identity",
                    ));
                }
            }
            IntegrationStatus::Rejected
            | IntegrationStatus::Unknown
            | IntegrationStatus::Unavailable => {
                if self.result.as_ref().is_some() {
                    return Err(invalid(
                        "result",
                        "failed or unknown port operations cannot carry a result",
                    ));
                }
                self.error
                    .as_ref()
                    .ok_or_else(|| invalid("error", "a public error is required"))?
                    .validate()?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;

mod task_capability_scope_directory;
pub use task_capability_scope_directory::*;

mod model_policies;
pub use model_policies::*;

mod model_health;
pub use model_health::*;

mod model_policy_settings;
pub use model_policy_settings::*;

mod model_usage;
pub use model_usage::*;

mod remote_capabilities;
pub use remote_capabilities::*;

mod remote_operations;
pub use remote_operations::*;

mod remote_transport;
pub use remote_transport::*;
