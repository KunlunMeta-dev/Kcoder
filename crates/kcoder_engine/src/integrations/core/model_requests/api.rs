//! Native model budget observation. None of these objects is a wire authority.
use crate::integrations::core::NativeToolExecutionWitness;
use kcoder_types::{MessagesRequest, ModelConfigurationSummary};
use std::sync::Arc;

pub use kcoder_api::native_model_request::{
    NativeModelRequestEnd, NativeModelRequestError, NativeModelRequestLease,
    NativeModelRequestSettlement,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeModelRequestPurpose {
    Main,
    Summary,
    MemoryObserver,
    Verifier,
    MoaReference,
    MoaAggregator,
}
/// Constructed only at the actual Engine/Provider boundary. Request data does
/// not supply a session/turn, native parent or registered Provider identity.
pub struct NativeModelRequestContext {
    pub(super) call_id: String,
    pub(super) execution: NativeToolExecutionWitness,
    pub(super) state: kcoder_state::AppState,
    pub(super) parent_state: Option<kcoder_state::AppState>,
    pub(super) purpose: NativeModelRequestPurpose,
    pub(super) retry_attempt: usize,
    pub(super) provider: Arc<dyn kcoder_api::Provider>,
    pub(super) configuration: Option<ModelConfigurationSummary>,
    pub(super) session_directory: std::path::PathBuf,
}
impl NativeModelRequestContext {
    pub fn session_directory(&self) -> &std::path::Path {
        &self.session_directory
    }
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    pub fn execution(&self) -> &NativeToolExecutionWitness {
        &self.execution
    }
    /// Actual opaque State object, never reconstructed from a session string.
    pub fn state(&self) -> &kcoder_state::AppState {
        &self.state
    }
    pub fn parent_state(&self) -> Option<&kcoder_state::AppState> {
        self.parent_state.as_ref()
    }
    pub fn purpose(&self) -> NativeModelRequestPurpose {
        self.purpose
    }
    /// Original Engine retry-loop ordinal, never inferred from call counts or input JSON.
    pub fn retry_attempt(&self) -> usize {
        self.retry_attempt
    }
    pub fn provider(&self) -> &Arc<dyn kcoder_api::Provider> {
        &self.provider
    }
    pub fn configuration(&self) -> Option<&ModelConfigurationSummary> {
        self.configuration.as_ref()
    }
}

pub trait NativeModelRequestObserver: Send + Sync {
    /// The owning Core has committed its original Workflow acceptance, while
    /// the native launch callback still prevents all node dispatch.
    fn observe_workflow_accepted(
        &self,
        _request: &super::NativeWorkflowRootRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    /// Retain only the already accepted task while an actual Engine-owned
    /// auxiliary job is queued. This grants no Provider invocation or budget.
    fn retain_auxiliary(
        &self,
        _request: &super::NativeAuxiliaryModelRequest<'_>,
    ) -> Result<Option<Arc<dyn Send + Sync>>, NativeModelRequestError> {
        Ok(None)
    }
    fn observe_child_scheduled(
        &self,
        _request: &crate::integrations::core::NativeScheduledChildRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    /// A durable turn or owned background-run terminal was committed. This is
    /// only a wake-up: implementations must read their original receipts before
    /// releasing capacity, and must preserve unknown usage reservations.
    fn observe_execution_terminal(&self) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    /// Called only by the original native child launcher with its frozen parent frame.
    /// The default retains legacy observers; it grants no tools or execution authority.
    fn prepare_child(
        &self,
        _request: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    fn observe_child_accepted(
        &self,
        _request: &crate::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> Result<(), NativeModelRequestError> {
        Ok(())
    }
    /// Default-deny a same-run model transition. Implementations must recheck
    /// the original persisted AUTO intent, actual acceptance/source/actor,
    /// current exact policy/configuration and original budget authority.
    /// A returned observer must retain that same Native store and task/run;
    /// it does not forgive the previous unknown or partial reservation.
    fn authorize_transition(
        &self,
        _request: &super::NativeModelTransitionRequest<'_>,
    ) -> Result<Arc<dyn NativeModelRequestObserver>, NativeModelRequestError> {
        Err(NativeModelRequestError::Denied)
    }
    /// Must perform an actual Native reservation before returning a lease.
    /// The borrowed final MessagesRequest is unchanged; token estimates derived
    /// from it are reservation bounds, not measured provider usage.
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError>;
}
