//! Host-injected credentials and non-activating marketplace preflight.
use super::PluginManager;
use crate::{
    InstalledPluginRecord, MarketplaceEntry, MarketplaceListResult, PluginId, PluginRegistry,
    PluginStore,
};
use anyhow::{Context, Result};
use std::{collections::BTreeMap, path::Path};

impl PluginManager {
    /// Pre-install form allowlist from the actual local declaration or a matching
    /// runtime-owned connector audit, never arbitrary catalog metadata.
    pub fn required_catalog_mcp_environment_names(entry: &MarketplaceEntry) -> Result<Vec<String>> {
        match &entry.source {
            crate::PluginSource::Local { path } => {
                let loaded =
                    crate::load_plugin_manifest(path)?.context("plugin manifest is missing")?;
                match &loaded.manifest.contributions.mcp_servers {
                    Some(declaration) => {
                        crate::contributions::mcp::required_environment_names(path, declaration)
                            .map_err(anyhow::Error::msg)
                    }
                    None => Ok(Vec::new()),
                }
            }
            _ => Ok(crate::marketplace_availability::audited_credential_names(
                entry,
            )),
        }
    }

    /// Credential identifiers declared by this immutable installation only.
    /// No private values are read, persisted, or returned by this method.
    pub fn required_mcp_environment_names(&self, plugin_id: &PluginId) -> Result<Vec<String>> {
        let record = self
            .store
            .read(plugin_id)?
            .context("plugin is not installed")?;
        let root = record.root(self.store.root());
        let loaded = crate::load_plugin_manifest(&root)?.context("plugin manifest is missing")?;
        match &loaded.manifest.contributions.mcp_servers {
            Some(declaration) => {
                crate::contributions::mcp::required_environment_names(&root, declaration)
                    .map_err(anyhow::Error::msg)
            }
            None => Ok(Vec::new()),
        }
    }

    /// Build next-turn contributions from host-owned private credential values.
    /// Values are scoped to an immutable installed operation and only injected
    /// into its MCP configuration; no Hook or process environment is modified.
    pub fn effective_snapshot_with_credentials(
        &self,
        cwd: &Path,
        project_trusted: bool,
        credentials_by_operation: &BTreeMap<String, BTreeMap<String, String>>,
    ) -> Result<crate::EffectivePluginSnapshot> {
        let settings = self.settings(cwd)?;
        Ok(
            PluginRegistry::discover_with_store_settings_and_credentials(
                cwd,
                project_trusted,
                &self.store,
                &settings,
                credentials_by_operation,
            )?
            .effective_snapshot(),
        )
    }

    /// Host credential namespace identifier; it includes exact catalog source,
    /// version/SHA and target platform and never includes a credential value.
    pub fn marketplace_credential_scope(entry: &MarketplaceEntry) -> Result<String> {
        crate::marketplace_availability::fingerprint(entry)
    }

    pub fn marketplace_list_with_credentials(
        &self,
        cwd: &Path,
        project_trusted: bool,
        credentials_by_scope: &BTreeMap<String, BTreeMap<String, String>>,
    ) -> Result<MarketplaceListResult> {
        let mut list = self.marketplace_list(cwd, project_trusted)?;
        for market in &mut list.marketplaces {
            for entry in &mut market.plugins {
                let scope = Self::marketplace_credential_scope(entry)?;
                if let Some(values) = credentials_by_scope.get(&scope) {
                    crate::marketplace_availability::apply_private_credentials(entry, values)?;
                }
            }
        }
        Ok(list)
    }

    pub fn install_from_marketplace_with_credentials(
        &self,
        cwd: &Path,
        project_trusted: bool,
        marketplace_id: &str,
        plugin_name: &str,
        cancellation: &crate::PluginCancellationToken,
        credentials: &BTreeMap<String, String>,
    ) -> Result<InstalledPluginRecord> {
        let list = self.marketplace_list(cwd, project_trusted)?;
        let mut entry = list
            .marketplaces
            .into_iter()
            .find(|market| market.id == marketplace_id)
            .and_then(|market| {
                market
                    .plugins
                    .into_iter()
                    .find(|entry| entry.plugin_id.plugin_name() == plugin_name)
            })
            .context("plugin is not available in this marketplace")?;
        crate::marketplace_availability::apply_private_credentials(&mut entry, credentials)?;
        self.prepare_marketplace_plugin(
            cwd,
            project_trusted,
            marketplace_id,
            plugin_name,
            cancellation,
            &self.store,
            false,
            Some(entry),
        )
    }

    /// Download, parse and run the install preflight in an owned scratch store.
    /// This never activates components or changes the real installation generation.
    pub fn revalidate_from_marketplace(
        &self,
        cwd: &Path,
        project_trusted: bool,
        marketplace_id: &str,
        plugin_name: &str,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<MarketplaceEntry> {
        let temporary = kcoder_config::create_private_temp_dir("kcoder-plugin-preflight")?;
        let installation = self.settings(cwd)?.installation;
        let scratch =
            PluginStore::open(&temporary.path().join("store"))?.with_limits(crate::InstallLimits {
                max_files: installation.max_files,
                max_file_bytes: installation.max_file_bytes,
                max_total_bytes: installation.max_total_bytes,
                ..Default::default()
            });
        let before = self.marketplace_list(cwd, project_trusted)?;
        let entry = before
            .marketplaces
            .into_iter()
            .find(|m| m.id == marketplace_id)
            .and_then(|m| {
                m.plugins
                    .into_iter()
                    .find(|p| p.plugin_id.plugin_name() == plugin_name)
            })
            .context("plugin is not available in this marketplace")?;
        let observed = match self.prepare_marketplace_plugin(
            cwd,
            project_trusted,
            marketplace_id,
            plugin_name,
            cancellation,
            &scratch,
            true,
            Some(entry.clone()),
        ) {
            Ok(observed) => observed,
            Err(error) => {
                // Cancellation is not a new availability observation. A completed
                // failing preflight invalidates older positive network evidence.
                if !cancellation.is_cancelled() {
                    crate::marketplace_availability::invalidate_verified(
                        self.store.root(),
                        &entry,
                    )?;
                }
                return Err(error);
            }
        };
        cancellation.check()?;
        // Re-read identity after preflight: a concurrently refreshed catalog must
        // not gain evidence for a different source/version than the one tested.
        let after = self.marketplace_list(cwd, project_trusted)?;
        let current = after
            .marketplaces
            .into_iter()
            .find(|m| m.id == marketplace_id)
            .and_then(|m| {
                m.plugins
                    .into_iter()
                    .find(|p| p.plugin_id.plugin_name() == plugin_name)
            })
            .context("plugin catalog changed during preflight")?;
        anyhow::ensure!(
            entry == current,
            "plugin catalog changed during preflight; retry"
        );
        crate::marketplace_availability::record_verified(
            self.store.root(),
            &entry,
            Some(&observed.source),
        )?;
        let mut verified = current;
        crate::marketplace_availability::apply_verified(self.store.root(), &mut verified)?;
        Ok(verified)
    }
}
