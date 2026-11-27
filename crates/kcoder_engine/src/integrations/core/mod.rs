//! core integration domain. Its provider is registered by the host.
pub(crate) mod input_context;
pub use input_context::NativeInputContextIdentity;
pub mod policy;
pub use policy::{IntegrationAuthority, IntegrationPermit, IntegrationResourceRule};
mod model_selection;
pub use model_selection::resolve_integration_model_selection;
mod execution_witness;
mod resource_authority;
mod tool_authority;
pub use resource_authority::{NativeResourceAuthorizationRequest, NativeResourceReadAuthority};
mod tool_constraints;
pub use execution_witness::{
    NativeToolEmitterWitness, NativeToolExecutionWitness, NativeToolParentWitness,
};
pub use tool_constraints::NativeInvocationConstraint;
mod turn_admission;
pub(crate) use turn_admission::NativeTurnAdmission;
pub use turn_admission::NativeTurnAdmissionObserver;
mod tool_authorization_contract;
pub use tool_authorization_contract::{
    NativeToolAuthorization, NativeToolAuthorizationError, NativeToolAuthorizationPhase,
    NativeToolAuthorizationRequest,
};

mod event_emitter;
pub use event_emitter::NativeEngineEventFrame;

pub use execution_witness::{NativeToolBoundaryWitness, NativeToolGateHandle};
mod child_admission;
pub use child_admission::NativeChildAdmissionRequest;
mod scheduled_child;
pub use scheduled_child::NativeScheduledChildRequest;

mod workflow_parent;
pub use workflow_parent::{
    NativeWorkflowParentFacts, NativeWorkflowParentRequest, NativeWorkflowParentWitness,
};

mod model_policies;
pub use model_policies::{configured_integration_model_policies, validate_integration_auto_model};

pub(crate) mod model_health;
pub use model_policies::read_configured_integration_model_health;

pub use model_policies::read_configured_integration_model_usage;
pub use model_selection::{
    NativeModelCandidateAuthorizer, resolve_integration_model_selection_with_authorizer,
};
