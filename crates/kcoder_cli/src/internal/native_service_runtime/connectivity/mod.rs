//! Kernel-owned application process resources; business bridges remain in CLI.
#[path = "main_exit.rs"]
pub mod main_exit;
#[path = "../../../app_server/integrations/connectivity/parent.rs"]
pub mod parent;
#[path = "process_spawn.rs"]
pub mod process_spawn;
pub use parent::{NativeConnectivityExitProof, NativeConnectivityParent};

use kcoder_connectivity_storage::control;
#[path = "../../../app_server/integrations/connectivity/lease.rs"]
pub mod lease;
#[path = "../../../app_server/integrations/connectivity/private_handler.rs"]
pub mod private_handler;
#[cfg(test)]
use crate::scope_host::NativeScopeHostBootstrap;
pub use lease::{NativeConnectivityLeaseFacade, NativeConnectivityReadyInput};
