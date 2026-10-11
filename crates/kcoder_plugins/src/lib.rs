//! KCoder plugin-package discovery, compatible manifest parsing, and runtime contribution entry points.

mod bundled;
mod computer_use;
pub use computer_use::{
    COMPUTER_USE_PLUGIN_ID, computer_use_enabled_in_store, computer_use_guidance_needs_update,
    computer_use_is_enabled, computer_use_policy_allows, computer_use_requires_explicit_enable,
};
mod cancellation;
mod contributions;
mod discovery;
mod hosted;
mod icon;
mod identity;
mod manager;
mod manifest;
mod marketplace;
mod marketplace_availability;
mod materialize;
mod model;
mod prompts;
pub use prompts::PromptSummary;
mod store;

pub use cancellation::PluginCancellationToken;
pub use discovery::{
    EffectiveMcpContribution, EffectiveMcpToolPolicy, EffectivePluginSnapshot, LoadedPlugin,
    PluginLoadDiagnostic, PluginMcpContribution, PluginRegistry,
};
pub use identity::{PluginId, PluginIdError};
pub use manager::{
    MarketplaceDiagnostic, MarketplaceListItem, MarketplaceListResult, PluginDoctorReport,
    PluginListItem, PluginListResult, PluginManager, PluginProxySettings, PluginReadResult,
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
    CopyStats, InstallLimits, InstalledPluginRecord, InstalledPluginSource, PluginInUseError,
    PluginStore, PluginStoreSnapshot, PluginVersionLease,
};

mod network;
mod proxy_discovery;
pub use network::{plugin_network_error_kind, validate_plugin_proxy};
pub use proxy_discovery::ProxyDetection;
