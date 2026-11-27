//! Bounded static package inspection and migration-owned native installation transactions.
mod estimate;
mod inspection;
pub use estimate::{PluginTransferEstimate, estimate_transfer_package};
mod package_hash;
mod transfer;
mod tree;
pub use crate::store::migration::{
    PluginMigrationNativeState, observe_installation, observe_installation_receipt,
};
pub use inspection::{PluginMigrationInspection, inspect_package};
pub use transfer::{PLUGIN_TRANSFER_FORMAT, materialize_transfer_package, write_transfer_package};
pub use tree::{PluginPackageRevision, package_revision, snapshot_package};
