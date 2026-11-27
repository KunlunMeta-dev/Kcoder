//! Target-owned integration scope, identity, and domain storage.
#[path = "service_identity/mod.rs"]
pub mod service_identity;

#[path = "../../app_server/integrations/core/native_context.rs"]
mod native_context;
#[path = "../../app_server/integrations/core/native_identity.rs"]
mod native_identity;

pub use kcoder_integration_storage::domain_storage::{
    DomainStorageGuard as NativeDomainGuard, DomainStorageRelocation as NativeDomainRelocation,
    RegisteredDomain as NativeRegisteredDomain, StorageDomain as NativeDomain,
};
pub use native_context::{NativeIntegrationContext, ObservedReadScope, ResourceOrganizationPolicy};
pub use native_identity::{
    NativeIdentity, NativeIdentitySnapshot, NativeObservedDomain, NativeObservedDomainRelocation,
    NativeProfileDomains,
};
