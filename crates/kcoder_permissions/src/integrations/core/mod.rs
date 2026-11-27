//! Signed, bounded service delegations. Public JSON locators confer no authority.
mod claims;
mod store;

pub use claims::{
    AuthenticatedDelegationPolicy, AuthenticatedDelegationSubject, DelegationPermit,
    SignedDelegation,
};
pub use store::NativeDelegationAuthority;
pub use store::NativeMemberSelfRevocation;

pub use store::{AuthenticatedNativeCodeServiceSource, NativeCodeServicePermit};
