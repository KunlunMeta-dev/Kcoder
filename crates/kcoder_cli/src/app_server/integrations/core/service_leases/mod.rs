//! Native background ownership. Serialized records locate a service, never grant authority.
mod code_task;
pub(crate) mod scope_host;
use kcoder_native_scope::service_identity::image;
use kcoder_native_service_runtime::configuration;
pub(crate) mod native_code;
use kcoder_native_service_runtime::process;
mod user_manager;
use super::NativeIntegrationContext;
use anyhow::Result;
pub(crate) use kcoder_native_journal::service_leases::NativeServiceLeases;
use kcoder_native_journal::service_leases::now;
#[cfg(target_os = "linux")]
pub(crate) use kcoder_native_scope::service_identity::user_peer;
#[cfg(windows)]
use kcoder_native_scope::service_identity::windows_account;
#[cfg(windows)]
use kcoder_native_scope::service_identity::windows_image;
#[cfg(windows)]
pub(crate) use kcoder_native_scope::service_identity::windows_pipe;
use kcoder_types::integrations::core::*;

/// Capability negotiation observes the actual target account, never a SID/UID
/// supplied by the client. Unix root uses the same identity checks as other users.
pub(crate) fn channel_account_supported() -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        kcoder_native_scope::service_identity::verify_current_unix_account().is_ok()
    }
    #[cfg(windows)]
    {
        windows_account::CurrentWindowsServiceAccount::capture().is_ok()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        false
    }
}
