//! Target-owned integration scope, identity, and domain storage.
#[path = "service_identity/mod.rs"]
pub mod service_identity;

#[path = "../../app_server/integrations/core/domain_storage.rs"]
mod domain_storage;
#[path = "../../app_server/integrations/core/native_context.rs"]
mod native_context;
#[path = "../../app_server/integrations/core/native_identity.rs"]
mod native_identity;

pub use domain_storage::{NativeDomain, NativeDomainGuard};
pub use native_context::{NativeIntegrationContext, ObservedReadScope};
pub use native_identity::{NativeIdentity, NativeIdentitySnapshot};
