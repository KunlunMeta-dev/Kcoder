//! KCoder plugin-package discovery, compatible manifest parsing, and runtime contribution entry points.

mod bundled;
mod cancellation;
mod contributions;
mod discovery;
mod identity;
mod manager;
mod manifest;
mod marketplace;
mod materialize;
mod model;
mod store;

pub use cancellation::PluginCancellationToken;
pub use discovery::{
    EffectiveMcpContribution, EffectiveMcpToolPolicy, EffectivePluginSnapshot, LoadedPlugin,
    PluginLoadDiagnostic, PluginMcpContribution, PluginRegistry,
};
pub use identity::{PluginId, PluginIdError};
pub use manager::{
    MarketplaceDiagnostic, MarketplaceListItem, MarketplaceListResult, PluginDoctorReport,
    PluginListItem, PluginListResult, PluginManager, PluginReadResult,
};
pub use manifest::{PluginManifestError, load_plugin_manifest};
pub use marketplace::{
    AuthPolicy, InstallPolicy, MarketplaceEntry, MarketplaceManifest, PluginSource,
    find_marketplace_manifest_path, load_marketplace_manifest,
};
pub use model::{
    CompatibilityIssue, CompatibilityLevel, CompatibilityReport, LoadedPluginManifest, PluginAsset,
    PluginContributionDeclarations, PluginHookDeclaration, PluginInterface, PluginManifest,
    PluginManifestFormat, PluginMcpDeclaration, PluginResource,
};
pub use store::{
    CopyStats, InstallLimits, InstalledPluginRecord, InstalledPluginSource, PluginStore,
    PluginStoreSnapshot,
};
