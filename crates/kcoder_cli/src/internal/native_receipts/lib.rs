//! Native operation, policy and lease storage and original receipt reads.

#[path = "../../app_server/integrations/core/budget_host.rs"]
pub mod budget_host;

#[path = "../../app_server/integrations/core/policy_host.rs"]
mod policy_host;

#[path = "../../app_server/integrations/core/remote_delegations/launch_record.rs"]
pub mod launch_record;

#[path = "../../app_server/integrations/core/operations_host.rs"]
mod operations_host;

#[path = "../../app_server/integrations/core/remote_delegations/original_read.rs"]
pub mod original_read;

#[path = "../../app_server/integrations/core/remote_delegations/materials.rs"]
pub mod remote_materials;

#[path = "../../app_server/integrations/core/remote_delegations/registry.rs"]
pub mod remote_registry;

#[path = "../../app_server/integrations/core/service_leases/storage.rs"]
pub mod service_leases;

#[path = "../../app_server/integrations/core/service_leases/scope_host/launch.rs"]
pub mod service_host_launch;

pub use operations_host::NativeOperations;
pub use policy_host::NativePolicyService;

use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub fn digest(value: &impl Serialize) -> Result<String> {
    Ok(digest_bytes(&serde_json::to_vec(value)?))
}
pub fn digest_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(any(test, feature = "test-oracle"))]
pub use policy_host::prepare_native_delegation;
