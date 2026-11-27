//! Native-only original-operation journal composition. Current authorization is injected by the real caller.
// The outgoing modules are compiled once, by `kcoder_native_outbound`. Tests that
// need CLI runtime fixtures attach to thin facades and use the same compiled code.
#[cfg(test)]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::{
    artifacts, authority, authority_ssh, management, materials_ssh,
};
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::{
    receiver_materials, registry,
};
// `#[path = "."]` keeps nested test paths relative to this directory.
#[path = "."]
mod control {
    pub(crate) use kcoder_native_outbound::app_server::integrations::core::remote_delegations::control::*;
    #[cfg(test)]
    #[path = "control_tests.rs"]
    mod tests;
}
pub(crate) use kcoder_native_journal::original_read;
pub(crate) mod rpc;
pub(crate) use control::NativeRemoteOperationControl;
pub(crate) use kcoder_native_journal::validate_office_source_refs;
mod factory {
    pub(crate) use kcoder_native_outbound::app_server::integrations::core::remote_delegations::factory::*;
    #[cfg(test)]
    mod tests;
}
use kcoder_native_journal::launch;
mod receiver;
#[cfg(target_os = "linux")]
pub(in crate::app_server) mod receiver_acp_binding;
#[cfg(target_os = "linux")]
mod receiver_defaults;
use kcoder_native_journal::receiver_history;
#[cfg(target_os = "linux")]
mod receiver_office;
#[cfg(target_os = "linux")]
mod receiver_office_parent;
pub(crate) use factory::install_outgoing_for_accepted_turn;
pub(crate) use receiver::install_incoming_for_accepted_turn;
#[cfg(target_os = "linux")]
pub(crate) use receiver_defaults::observe_current_receiver_defaults;
pub(crate) fn native_launch_environment_name() -> &'static str {
    launch::NATIVE_REMOTE_LAUNCH_ENV
}
pub(in crate::app_server) mod transport;

use super::NativeIntegrationContext;
use anyhow::{Context, Result, ensure};
#[cfg(test)]
use kcoder_native_journal::ordinary_source;
use serde_json::Value;
use std::{ffi::OsStr, sync::Arc};
#[cfg(test)]
use {super::NativeDomain, super::NativeDomainGuard};
#[cfg(test)]
use {
    kcoder_acp::outbound::InstalledOutboundRunner, kcoder_acp::outbound::OutboundEffect,
    kcoder_acp::outbound::OutboundHost,
};
#[cfg(test)]
use {kcoder_native_journal::NativeRemoteAuthority, kcoder_native_journal::NativeRemoteJournal};

// Test-only facades attach the original CLI-fixture tests to the compiled outbound code.
#[cfg(test)]
#[path = "."]
mod materials {
    pub(crate) use kcoder_native_outbound::app_server::integrations::core::remote_delegations::materials::*;
    #[path = "materials_tests.rs"]
    mod tests;
}
#[cfg(test)]
#[path = "."]
mod source_budget {
    pub(crate) use kcoder_native_outbound::app_server::integrations::core::remote_delegations::source_budget::*;
    #[path = "source_budget_tests.rs"]
    pub(crate) mod tests;
}
#[cfg(test)]
mod tests;
