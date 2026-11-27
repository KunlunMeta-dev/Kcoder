//! Explicit bounded migration of fixed local plugin installations, without source execution.
mod discovery;
mod errors;
mod export;
pub use export::{PluginExportSelection, PluginPackageOrigin};
mod jobs;
mod received;
pub(crate) use discovery::discover_uploaded;
pub use discovery::{
    PluginMigrationCandidate, PluginMigrationCatalog, PluginSourceProject, discover,
    discover_with_project,
};
pub use errors::error_code;
pub use jobs::{
    PLUGIN_ADAPTER_REVISION, PluginBatchConsumer, PluginBatchSource, PluginMigrationStage,
    PluginMigrationStore, PluginMigrationView, PluginPlanReference,
};
