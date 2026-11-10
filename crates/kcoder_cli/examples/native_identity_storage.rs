//! Run the production storage modules' own tests without compiling the app-server test root.
#[cfg(test)]
#[allow(dead_code)]
#[path = "../src/app_server/integrations/core/domain_storage.rs"]
mod domain_storage;
#[cfg(test)]
use domain_storage::{NativeDomain, NativeDomainGuard};

#[cfg(test)]
#[allow(dead_code)]
#[path = "../src/app_server/integrations/core/native_identity.rs"]
mod native_identity;

#[cfg(not(test))]
fn main() {
    eprintln!("Run: cargo test -p kcoder_cli --example native_identity_storage");
}
