//! Live native invocation contracts; these values do not come from request JSON.
use super::{
    NativeChildAdmissionRequest, NativeEngineEventFrame, NativeToolEmitterWitness,
    NativeToolExecutionWitness, NativeWorkflowParentFacts, NativeWorkflowParentRequest,
};
use kcoder_tools::ToolSource;
use std::result::Result;

/// Native tool facts; Dispatch carries final input after Hooks and approval.
pub struct NativeToolAuthorizationRequest<'a> {
    pub execution: Option<&'a NativeToolExecutionWitness>,
    pub emitter: Option<&'a NativeToolEmitterWitness>,
    pub session_id: &'a str,
    pub tool_name: &'a str,
    pub source: ToolSource,
    pub input: &'a serde_json::Value,
    pub read_only: bool,
    pub without_sandbox: bool,
    pub phase: NativeToolAuthorizationPhase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeToolAuthorizationPhase {
    Admission,
    Dispatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeToolAuthorizationError {
    Denied,
    Unavailable,
}

impl std::fmt::Display for NativeToolAuthorizationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Denied => "NATIVE_TASK_AUTHORITY_DENIED",
            Self::Unavailable => "NATIVE_TASK_AUTHORITY_UNAVAILABLE",
        })
    }
}
impl std::error::Error for NativeToolAuthorizationError {}

/// A non-serializable host authority; every invocation rechecks current native facts.
#[async_trait::async_trait]
pub trait NativeToolAuthorization: Send + Sync + std::any::Any {
    async fn workflow_parent_origin(
        &self,
        _request: &NativeWorkflowParentRequest<'_>,
    ) -> Result<NativeWorkflowParentFacts, NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    async fn authorize_child(
        &self,
        _request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    async fn observe_child_accepted(
        &self,
        _request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    /// Explicit native producer checks are unavailable until the real guard implements them.
    async fn authorize_provider(
        &self,
        _execution: &NativeToolExecutionWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    async fn authorize_event(
        &self,
        _frame: &NativeEngineEventFrame,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    /// A default child may see reviewed original source objects. This is a
    /// catalog hint only; role/explicit ceilings and every effect guard remain.
    fn inherited_resource_tools(
        &self,
        _registered: &kcoder_tools::ToolRegistry,
    ) -> Result<Option<Vec<std::sync::Arc<dyn kcoder_tools::Tool>>>, NativeToolAuthorizationError>
    {
        Ok(None)
    }
    /// Unmapped App tool callbacks preserve legacy behavior but cannot consume
    /// an explicit task resource ceiling through a name/readOnly annotation.
    async fn authorize_app_callback(
        &self,
        _emitter: &super::NativeToolEmitterWitness,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    /// Direct App/resource reads retain the original registered native emitter.
    async fn authorize_resource(
        &self,
        _request: &super::NativeResourceAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Unavailable)
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> Result<(), NativeToolAuthorizationError>;
}
