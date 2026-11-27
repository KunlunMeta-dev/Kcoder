//! Original scope bootstrap and its actual native owner.
pub use kcoder_native_receipts::service_host_launch as launch;
#[path = "../../app_server/integrations/core/service_leases/scope_host/bootstrap.rs"]
pub mod bootstrap;
pub use bootstrap::NativeScopeHostBootstrap;
