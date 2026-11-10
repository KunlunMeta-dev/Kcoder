//! Native remote-operation journals bound to the original session and transport.

#[path = "../../app_server/integrations/core/remote_delegations/journal.rs"]
mod journal;

#[path = "../../app_server/integrations/core/remote_delegations/launch.rs"]
pub mod launch;

#[path = "../../app_server/integrations/core/remote_delegations/office_sources.rs"]
mod office_sources;

#[path = "../../app_server/integrations/core/remote_delegations/ordinary_source.rs"]
pub mod ordinary_source;

#[path = "../../app_server/integrations/core/remote_delegations/receiver_history.rs"]
pub mod receiver_history;

pub use journal::{NativeRemoteAuthority, NativeRemoteJournal};
pub use office_sources::validate_office_source_refs;

pub use kcoder_native_receipts::{
    NativeOperations, NativePolicyService, budget_host, digest, digest_bytes, launch_record,
    original_read, remote_materials, remote_registry, service_host_launch, service_leases,
};

#[cfg(any(test, feature = "test-oracle"))]
pub use kcoder_native_receipts::prepare_native_delegation;
