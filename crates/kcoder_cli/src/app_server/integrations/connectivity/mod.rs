//! Application-host storage, kernel lease and private parent boundaries.
pub(crate) mod application_discovery;
mod application_resources;
mod application_runtime;
mod cold_catalog;
mod connection_directory;
mod office_readiness;
pub(in crate::app_server) mod task_ui;
use kcoder_connectivity_storage::control;
pub(crate) use office_readiness::NativeOfficeReadinessPort;
#[cfg(test)]
mod facts;
#[cfg(not(test))]
use kcoder_application_host_runtime::connectivity::facts;
#[cfg(test)]
mod host_process;
#[cfg(not(test))]
use kcoder_application_host_runtime::connectivity::host_process;
use kcoder_host_transport::host_rpc;
pub(crate) mod installed_resources;
#[cfg(test)]
mod lease;
#[cfg(not(test))]
use kcoder_application_host_runtime::connectivity::lease;
pub(crate) mod main_applications;
mod main_host;
mod main_provider;
pub(crate) use application_resources::NativeApplicationResourceConnection;
mod main_public;
pub(crate) use main_public::NativeConnectivityPublicCall;
pub(crate) mod main_rpc;
mod native_sources;
mod native_task_capability_scope;
use kcoder_native_service_runtime::connectivity::parent;
#[cfg(test)]
mod private_handler;
pub(crate) use facts::NativeConnectivityFactPipe;
pub(crate) use host_process::{
    NativeConnectivityHost, NativeConnectivityHostPaths, NativeConnectivityMainExitReceipt,
    NativeConnectivityReverseHandler,
};
#[cfg(not(test))]
use kcoder_application_host_runtime::connectivity::private_handler;
pub(crate) use lease::{NativeConnectivityLeaseFacade, NativeConnectivityReadyInput};
pub(crate) use native_sources::{
    NativeConnectivityInventory, NativeConnectivitySourceCatalog, NativeMcpSourceFact,
    NativeMcpSourceSelector, native_mcp_source_facts,
};
#[cfg(test)]
pub(crate) use native_task_capability_scope::{
    NativeAcceptedTaskIdentity, NativeTaskCapabilityScopeBinding,
    NativeTaskCapabilityScopeBindingStore, NativeTaskCapabilityScopeCallback,
    NativeTaskCapabilityScopeFacts, NativeTaskCapabilityScopePendingTarget,
};
pub(crate) use native_task_capability_scope::{
    NativeTaskCapabilityScopeFactory, NativeTaskCapabilityScopeGuard,
};
pub(crate) use parent::{NativeConnectivityExitProof, NativeConnectivityParent};
pub(crate) use private_handler::NativeConnectivityPrivateContribution;

pub(crate) mod task_capability_scope_control;

pub(crate) mod task_capability_scope_directory;
pub(in crate::app_server) mod task_capability_scope_directory_rpc;

pub(crate) mod task_capability_scope_control_rpc;
pub(crate) mod task_capability_scope_runtime;
pub(crate) mod task_capability_source_choices_rpc;

pub(crate) mod application_inputs;
mod application_task;

#[cfg(test)]
use kcoder_native_service_runtime::scope_host::NativeScopeHostBootstrap;
