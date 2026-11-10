//! Original signed service owners and live OS process fences.
use anyhow::Result;
use kcoder_native_receipts::service_leases::{NativeServiceLeases, now};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_native_scope::service_identity::image;
#[cfg(windows)]
use kcoder_native_scope::service_identity::{windows_account, windows_image, windows_pipe};
use kcoder_types::integrations::core::*;

#[path = "../../app_server/integrations/core/service_leases/process.rs"]
pub mod process;

#[path = "../../app_server/integrations/core/service_leases/configuration.rs"]
pub mod configuration;

#[path = "connectivity/mod.rs"]
pub mod connectivity;
#[cfg(target_os = "linux")]
#[path = "manager_scope.rs"]
pub mod manager_scope;
#[path = "scope_host.rs"]
pub mod scope_host;
#[cfg(target_os = "linux")]
use kcoder_native_scope::service_identity::user_peer;
