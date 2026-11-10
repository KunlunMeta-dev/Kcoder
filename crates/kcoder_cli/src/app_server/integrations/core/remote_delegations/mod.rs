//! Native-only original-operation journal composition. Current authorization is injected by the real caller.
#[cfg(test)]
mod artifacts;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::artifacts;
#[cfg(test)]
mod control;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::control;
#[cfg(test)]
#[path = "materials_authority.rs"]
mod materials;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::materials;
#[cfg(test)]
mod materials_ssh;
pub(crate) use kcoder_native_journal::original_read;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::materials_ssh;
#[cfg(test)]
mod original_reconcile;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::original_reconcile;
pub(crate) mod rpc;
pub(crate) use control::NativeRemoteOperationControl;
#[cfg(test)]
mod output_reader;
pub(crate) use kcoder_native_journal::validate_office_source_refs;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::output_reader;
#[cfg(test)]
mod authority;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::authority;
#[cfg(test)]
mod authority_ssh;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::authority_ssh;
#[cfg(test)]
mod factory;
use kcoder_native_journal::launch;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::factory;
#[cfg(test)]
mod management;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::management;
mod receiver;
#[cfg(target_os = "linux")]
pub(in crate::app_server) mod receiver_acp_binding;
#[cfg(target_os = "linux")]
mod receiver_defaults;
use kcoder_native_journal::receiver_history;
#[cfg(test)]
mod receiver_materials;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::receiver_materials;
#[cfg(target_os = "linux")]
mod receiver_office;
#[cfg(target_os = "linux")]
mod receiver_office_parent;
#[cfg(test)]
mod receiver_results;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::receiver_results;
#[cfg(test)]
mod receiver_results_ssh;
pub(crate) use factory::install_outgoing_for_accepted_turn;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::receiver_results_ssh;
pub(crate) use receiver::install_incoming_for_accepted_turn;
#[cfg(target_os = "linux")]
pub(crate) use receiver_defaults::observe_current_receiver_defaults;
pub(crate) fn native_launch_environment_name() -> &'static str {
    launch::NATIVE_REMOTE_LAUNCH_ENV
}
use kcoder_native_journal::ordinary_source;
#[cfg(test)]
#[path = "registry_authority.rs"]
mod registry;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::registry;
#[cfg(test)]
mod source_budget;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::source_budget;
#[cfg(test)]
mod tests;
pub(in crate::app_server) mod transport;

use super::{NativeDomain, NativeDomainGuard, NativeIntegrationContext, NativeOperations};
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::{InstalledOutboundRunner, OutboundEffect, OutboundHost};
use kcoder_native_journal::{NativeRemoteAuthority, NativeRemoteJournal};
use kcoder_state::integrations::core::remote_delegations::{
    NativeRemoteDelegationStore, NativeRemoteObservation, NativeRemotePlan, NativeRemoteStage,
};
use kcoder_types::integrations::core::{IntegrationOperationPhase, IntegrationRequest};
use serde_json::Value;
#[cfg(test)]
use std::collections::BTreeMap;
use std::{
    ffi::OsStr,
    sync::{Arc, Mutex},
};
