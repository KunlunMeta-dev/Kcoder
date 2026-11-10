//! core integration domain. Its provider is registered by the host.
pub(crate) mod browser_profiles;
mod memory_host;
pub(crate) mod runtime_driver;
pub(crate) mod runtime_pump;
pub(crate) mod task_workspace;
pub(crate) use kcoder_native_journal::{NativeOperations, NativePolicyService};
pub(crate) use memory_host::{
    MEMORY_REVIEW_CAPABILITY, NativeMemoryService, memory_method, read_operation, request_memory,
};

mod scope_requests;
pub(crate) mod task_capability_scope_control;
pub(in crate::app_server) use scope_requests::{capture_scope, read_scope};
mod memory_setup;
pub(in crate::app_server) use memory_setup::prepare_enabled_memory_for_connection;
pub(crate) use memory_setup::warn_memory_failure;

pub(crate) use budget_host::NativeBudgetService;
pub(crate) use kcoder_native_journal::budget_host;

pub(crate) mod model_policy;

pub(crate) mod remote_delegations;

pub(crate) use kcoder_api::model_budget_input;
pub(crate) mod organization_model {
    pub(crate) use kcoder_native_model_admission::{install, validate_model_input};
}

pub(crate) mod service_leases;

pub(crate) use kcoder_native_scope::{
    NativeDomain, NativeDomainGuard, NativeIdentity, NativeIntegrationContext, ObservedReadScope,
};

#[cfg(test)]
pub use kcoder_native_journal::prepare_native_delegation;
