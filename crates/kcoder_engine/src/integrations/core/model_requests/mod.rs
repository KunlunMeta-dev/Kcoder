//! Per-inner-Provider Native reservation and cumulative usage accounting.
mod api;
mod auxiliary;
mod binding;
mod provider;
mod retry_observation;
mod workflow_root;
pub use api::*;
pub use auxiliary::NativeAuxiliaryModelRequest;
pub(crate) use auxiliary::NativeAuxiliaryWork;
pub(crate) use binding::ModelRequestBinding;
pub use provider::admission_identity;
pub(crate) use retry_observation::stream_with_retry_observation;
pub use workflow_root::NativeWorkflowRootRequest;

pub(crate) use provider::inherited_observer;
#[cfg(test)]
mod tests;

mod additive;
mod transition;
pub use transition::NativeModelTransitionRequest;

#[cfg(test)]
mod transition_tests;
