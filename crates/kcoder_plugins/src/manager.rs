use crate::{
    CompatibilityReport, InstallPolicy, InstalledPluginRecord, InstalledPluginSource,
    MarketplaceEntry, PluginId, PluginLoadDiagnostic, PluginRegistry, PluginSource, PluginStore,
    find_marketplace_manifest_path, load_marketplace_manifest,
};
use anyhow::{Context, Result, bail};
use kcoder_config::{
    ConfigPaths, ConfigScope, FolderTrust, FolderTrustStore, PluginsSettings, SettingsLoader,
    update_scope,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Sole public entry point for plugin installation state, discovery snapshots, and management operations.
#[derive(Debug)]
pub struct PluginManager {
    store: PluginStore,
    config_paths: Option<ConfigPaths>,
    settings_cwd: PathBuf,
    effective_settings: Option<std::sync::RwLock<PluginsSettings>>,
}

impl PluginManager {
    pub fn open_default() -> Result<Self> {
        let cwd = std::env::current_dir().context("failed to determine current directory")?;
        Self::open_default_for_cwd(&cwd)
    }

    pub fn open_default_for_cwd(cwd: &Path) -> Result<Self> {
        let loaded = SettingsLoader::new(cwd).load()?;
        Self::open_default_for_cwd_with_settings(cwd, loaded.paths, loaded.settings.plugins)
    }

    pub fn open_default_for_cwd_with_effective_settings(
        cwd: &Path,
        settings: PluginsSettings,
    ) -> Result<Self> {
        let paths = SettingsLoader::new(cwd).paths()?;
        Self::open_default_for_cwd_with_settings(cwd, paths, settings)
    }

    fn open_default_for_cwd_with_settings(
        cwd: &Path,
        paths: ConfigPaths,
        settings: PluginsSettings,
    ) -> Result<Self> {
        let limits = &settings.installation;
        let store = PluginStore::open(&paths.config_dir.join("plugin_store"))?
            .with_limits(crate::InstallLimits {
                max_files: limits.max_files,
                max_total_bytes: limits.max_total_bytes,
                max_file_bytes: limits.max_file_bytes,
                ..crate::InstallLimits::default()
            })
            .with_operation_timeout(std::time::Duration::from_millis(limits.timeout_ms));
        Ok(Self {
            store,
            config_paths: Some(paths),
            settings_cwd: cwd.to_path_buf(),
            effective_settings: Some(std::sync::RwLock::new(settings)),
        })
    }

    pub fn open(store_root: &Path) -> Result<Self> {
        let config_dir = store_root
            .parent()
            .context("plugin store root has no configuration parent")?
            .to_path_buf();
        let settings_cwd =
            std::env::current_dir().context("failed to determine current directory")?;
        Ok(Self {
            store: PluginStore::open(store_root)?,
            config_paths: Some(ConfigPaths::with_config_dir(&settings_cwd, config_dir)),
            settings_cwd,
            effective_settings: None,
        })
    }

    pub fn from_store(store: PluginStore) -> Self {
        Self {
            store,
            config_paths: None,
            settings_cwd: PathBuf::new(),
            effective_settings: None,
        }
    }

    pub fn store(&self) -> &PluginStore {
        &self.store
    }

    pub fn list(&self, cwd: &Path, project_trusted: bool) -> Result<PluginListResult> {
        let settings = self.settings(cwd)?;
        let registry = PluginRegistry::discover_with_store_and_settings(
            cwd,
            project_trusted,
            &self.store,
            &settings,
        )?;
        let managed = self
            .store
            .installed_plugins()?
            .into_iter()
            .map(|record| (record.plugin_id.to_string(), record))
            .collect::<BTreeMap<_, _>>();
        let plugins = registry
            .plugins()
            .iter()
            .map(|plugin| {
                let record = managed.get(&plugin.id);
                PluginListItem {
                    id: plugin.id.clone(),
                    name: plugin.name.clone(),
                    version: plugin.version.clone(),
                    description: plugin.description.clone(),
                    root: plugin.root.clone(),
                    enabled: plugin.enabled,
                    managed: plugin.managed,
                    source: record.map(|record| record.source.clone()),
                    operation_id: record.map(|record| record.operation_id.clone()),
                    file_count: record.map(|record| record.file_count),
                    total_bytes: record.map(|record| record.total_bytes),
                    compatibility: plugin.compatibility.clone(),
                    skill_roots: plugin
                        .manifest
                        .contributions
                        .skills
                        .iter()
                        .map(|resource| resource.absolute_path.clone())
                        .collect(),
                    command_paths: plugin
                        .manifest
                        .contributions
                        .commands
                        .iter()
                        .map(|resource| resource.absolute_path.clone())
                        .collect(),
                    mcp_server_names: plugin
                        .mcp_configs
                        .iter()
                        .map(|server| server.name.clone())
                        .collect(),
                    hook_event_names: plugin
                        .hooks
                        .iter()
                        .map(|(event, _)| format!("{event:?}"))
                        .collect(),
                    hook_matcher_count: plugin.hooks.len(),
                    diagnostic_count: plugin.diagnostics.len(),
                }
            })
            .collect();
        Ok(PluginListResult {
            generation: registry.generation(),
            plugins,
            diagnostics: registry.diagnostics().to_vec(),
        })
    }

    pub fn effective_snapshot(
        &self,
        cwd: &Path,
        project_trusted: bool,
    ) -> Result<crate::EffectivePluginSnapshot> {
        let settings = self.settings(cwd)?;
        Ok(PluginRegistry::discover_with_store_and_settings(
            cwd,
            project_trusted,
            &self.store,
            &settings,
        )?
        .effective_snapshot())
    }

    pub fn read(
        &self,
        cwd: &Path,
        project_trusted: bool,
        plugin_id: &PluginId,
    ) -> Result<Option<PluginReadResult>> {
        let list = self.list(cwd, project_trusted)?;
        let managed_root = self
            .store
            .read(plugin_id)?
            .map(|record| record.root(self.store.root()));
        Ok(list
            .plugins
            .into_iter()
            .find(|plugin| plugin.id == plugin_id.to_string())
            .map(|plugin| PluginReadResult {
                generation: list.generation,
                plugin,
                diagnostics: list
                    .diagnostics
                    .into_iter()
                    .filter(|diagnostic| {
                        managed_root
                            .as_ref()
                            .is_some_and(|root| diagnostic.root.starts_with(root))
                    })
                    .collect(),
            }))
    }

    pub fn doctor(
        &self,
        cwd: &Path,
        project_trusted: bool,
        plugin_id: Option<&PluginId>,
    ) -> Result<PluginDoctorReport> {
        let list = self.list(cwd, project_trusted)?;
        let plugins = list
            .plugins
            .into_iter()
            .filter(|plugin| plugin_id.is_none_or(|id| plugin.id == id.to_string()))
            .collect::<Vec<_>>();
        if let Some(id) = plugin_id
            && plugins.is_empty()
        {
            bail!("plugin {id} was not found");
        }
        let diagnostics = if let Some(id) = plugin_id {
            if let Some(record) = self.store.read(id)? {
                let root = record.root(self.store.root());
                list.diagnostics
                    .into_iter()
                    .filter(|diagnostic| diagnostic.root.starts_with(&root))
                    .collect()
            } else {
                Vec::new()
            }
        } else {
            list.diagnostics
        };
        Ok(PluginDoctorReport {
            generation: list.generation,
            healthy: diagnostics.is_empty()
                && plugins.iter().all(|plugin| {
                    !matches!(
                        plugin.compatibility.level,
                        crate::CompatibilityLevel::Invalid
                            | crate::CompatibilityLevel::Incompatible
                    )
                }),
            plugins,
            diagnostics,
        })
    }

    pub fn install_local(&self, source: &Path) -> Result<InstalledPluginRecord> {
        self.install_local_with_cancellation(source, &crate::PluginCancellationToken::default())
    }

    pub fn install_local_with_cancellation(
        &self,
        source: &Path,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<InstalledPluginRecord> {
        if !self.settings(&self.settings_cwd)?.installation.allow_local {
            bail!("local plugin installation is disabled by settings");
        }
        self.store
            .install_local_with_cancellation(source, "local", cancellation)
    }

    pub fn marketplace_list(
        &self,
        cwd: &Path,
        project_trusted: bool,
    ) -> Result<MarketplaceListResult> {
        let configured = self.marketplace_values(cwd, project_trusted)?;
        let mut marketplaces = Vec::new();
        let mut diagnostics = Vec::new();
        let mut seen_paths = Vec::new();
        let canonical_cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
        for (configured_id, value) in configured {
            let parsed: ConfiguredMarketplaceSetting = match serde_json::from_value(value) {
                Ok(parsed) => parsed,
                Err(error) => {
                    diagnostics.push(MarketplaceDiagnostic {
                        marketplace_id: Some(configured_id),
                        path: None,
                        code: "invalid_marketplace_config".to_string(),
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            if !parsed.enabled {
                continue;
            }
            let path = match parsed.source {
                ConfiguredMarketplaceSource::Local { path } => path,
                ConfiguredMarketplaceSource::Git { .. }
                | ConfiguredMarketplaceSource::Npm { .. } => {
                    diagnostics.push(MarketplaceDiagnostic {
                        marketplace_id: Some(configured_id),
                        path: None,
                        code: "marketplace_source_not_materialized".to_string(),
                        message: "Git/npm marketplace refresh is not available in the local phase"
                            .to_string(),
                    });
                    continue;
                }
            };
            match load_marketplace_manifest(&path) {
                Ok(marketplace)
                    if !self.marketplace_is_trusted(
                        &marketplace.root,
                        &canonical_cwd,
                        project_trusted,
                    ) =>
                {
                    diagnostics.push(MarketplaceDiagnostic {
                        marketplace_id: Some(configured_id),
                        path: Some(marketplace.path),
                        code: "project_marketplace_untrusted".to_string(),
                        message: "project marketplace is disabled until the folder is trusted"
                            .to_string(),
                    });
                }
                Ok(marketplace) if marketplace.name == configured_id => {
                    seen_paths.push(marketplace.path.clone());
                    marketplaces.push(MarketplaceListItem::from_manifest(marketplace, true));
                }
                Ok(marketplace) => diagnostics.push(MarketplaceDiagnostic {
                    marketplace_id: Some(configured_id.clone()),
                    path: Some(marketplace.path),
                    code: "marketplace_name_mismatch".to_string(),
                    message: format!(
                        "configured marketplace {configured_id} declares name {}",
                        marketplace.name
                    ),
                }),
                Err(error) => diagnostics.push(MarketplaceDiagnostic {
                    marketplace_id: Some(configured_id),
                    path: Some(path),
                    code: "marketplace_load_failed".to_string(),
                    message: format!("{error:#}"),
                }),
            }
        }
        if project_trusted
            && let Some(path) = discover_project_marketplace(cwd)
            && !seen_paths.iter().any(|seen| seen == &path)
        {
            match load_marketplace_manifest(&path) {
                Ok(marketplace) => {
                    marketplaces.push(MarketplaceListItem::from_manifest(marketplace, false))
                }
                Err(error) => diagnostics.push(MarketplaceDiagnostic {
                    marketplace_id: None,
                    path: Some(path),
                    code: "marketplace_load_failed".to_string(),
                    message: format!("{error:#}"),
                }),
            }
        }
        if !marketplaces
            .iter()
            .any(|marketplace| marketplace.id == crate::bundled::BUNDLED_MARKETPLACE_ID)
        {
            marketplaces.push(MarketplaceListItem::from_manifest(
                crate::bundled::marketplace(),
                false,
            ));
        }
        marketplaces.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(MarketplaceListResult {
            generation: self.store.generation()?,
            marketplaces,
            diagnostics,
        })
    }

    pub fn marketplace_add(&self, marketplace_id: &str, path: &Path) -> Result<()> {
        self.marketplace_add_with_trust(marketplace_id, path, &self.settings_cwd, true)
    }

    /// Import an immutable Git snapshot. Refresh revalidates the imported snapshot;
    /// replacing it with a newer upstream revision requires an explicit new import.
    pub fn marketplace_add_git_with_cancellation(
        &self,
        source: &str,
        marketplace_id: Option<&str>,
        cwd: &Path,
        project_trusted: bool,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<String> {
        let installation = self.settings(cwd)?.installation;
        if !installation.allow_git {
            bail!("Git marketplace imports are disabled by settings");
        }
        if installation.require_git_sha {
            bail!(
                "Git marketplace imports require a pinned local checkout when require_git_sha is enabled"
            );
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(installation.timeout_ms);
        let materialized =
            crate::materialize::materialize_git(crate::materialize::GitMaterializeRequest {
                url: source,
                path: None,
                ref_name: None,
                sha: None,
                deadline,
                cancellation,
            })?;
        let manifest = load_marketplace_manifest(&materialized.root)?;
        let id = marketplace_id.unwrap_or(&manifest.name).to_string();
        if id != manifest.name {
            bail!("marketplace id does not match the Git manifest name");
        }
        let limits = crate::InstallLimits {
            max_files: installation.max_files,
            max_total_bytes: installation.max_total_bytes,
            max_file_bytes: installation.max_file_bytes,
            ..Default::default()
        };
        self.store.with_marketplace_snapshot(
            &materialized.root,
            limits,
            deadline,
            cancellation,
            |snapshot| {
                let manifest = load_marketplace_manifest(snapshot)?;
                kcoder_config::PrivateDirectory::open_existing(snapshot)?.atomic_replace(
                    std::ffi::OsStr::new(".kcoder-marketplace-origin.json"),
                    &serde_json::to_vec(&materialized.evidence)?,
                )?;
                self.marketplace_add_with_trust(&id, &manifest.path, cwd, project_trusted)?;
                Ok(id.clone())
            },
        )
    }

    pub fn marketplace_add_with_trust(
        &self,
        marketplace_id: &str,
        path: &Path,
        cwd: &Path,
        project_trusted: bool,
    ) -> Result<()> {
        PluginId::new("validation", marketplace_id).context("marketplace id is invalid")?;
        let marketplace = load_marketplace_manifest(path)?;
        let canonical_cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
        if !self.marketplace_is_trusted(&marketplace.root, &canonical_cwd, project_trusted) {
            bail!(
                "project marketplace {} requires folder trust",
                marketplace.path.display()
            );
        }
        if marketplace.name != marketplace_id {
            bail!(
                "marketplace id {marketplace_id} does not match manifest name {}",
                marketplace.name
            );
        }
        let marketplace_path = marketplace.path;
        let configured_value = serde_json::to_value(ConfiguredMarketplaceSetting {
            enabled: true,
            source: ConfiguredMarketplaceSource::Local {
                path: marketplace_path,
            },
        })?;
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no writable user settings path")?;
        update_scope(paths, ConfigScope::User, |document| {
            let root = document
                .as_object_mut()
                .context("settings root must be an object")?;
            let plugins = object_entry(root, "plugins")?;
            let marketplaces = object_entry(plugins, "marketplaces")?;
            if marketplaces.contains_key(marketplace_id) {
                bail!("marketplace {marketplace_id} is already configured");
            }
            marketplaces.insert(marketplace_id.to_string(), configured_value.clone());
            Ok(())
        })?;
        self.update_cached_settings(|settings| {
            settings
                .marketplaces
                .insert(marketplace_id.to_string(), configured_value);
        });
        Ok(())
    }

    pub fn marketplace_remove(&self, marketplace_id: &str) -> Result<bool> {
        PluginId::new("validation", marketplace_id).context("marketplace id is invalid")?;
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no writable user settings path")?;
        let mut removed = false;
        update_scope(paths, ConfigScope::User, |document| {
            if let Some(marketplaces) = document
                .get_mut("plugins")
                .and_then(|plugins| plugins.get_mut("marketplaces"))
                .and_then(Value::as_object_mut)
            {
                removed = marketplaces.remove(marketplace_id).is_some();
            }
            Ok(())
        })?;
        if removed {
            self.update_cached_settings(|settings| {
                settings.marketplaces.remove(marketplace_id);
            });
        }
        Ok(removed)
    }

    pub fn marketplace_refresh(
        &self,
        cwd: &Path,
        project_trusted: bool,
        marketplace_id: Option<&str>,
    ) -> Result<MarketplaceListResult> {
        let mut result = self.marketplace_list(cwd, project_trusted)?;
        if let Some(id) = marketplace_id {
            result
                .marketplaces
                .retain(|marketplace| marketplace.id == id);
            result
                .diagnostics
                .retain(|diagnostic| diagnostic.marketplace_id.as_deref() == Some(id));
            if result.marketplaces.is_empty() && result.diagnostics.is_empty() {
                bail!("marketplace {id} is not configured");
            }
        }
        Ok(result)
    }

    pub fn install_from_marketplace(
        &self,
        cwd: &Path,
        project_trusted: bool,
        marketplace_id: &str,
        plugin_name: &str,
    ) -> Result<InstalledPluginRecord> {
        self.install_from_marketplace_with_cancellation(
            cwd,
            project_trusted,
            marketplace_id,
            plugin_name,
            &crate::PluginCancellationToken::default(),
        )
    }

    pub fn install_from_marketplace_with_cancellation(
        &self,
        cwd: &Path,
        project_trusted: bool,
        marketplace_id: &str,
        plugin_name: &str,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<InstalledPluginRecord> {
        cancellation.check()?;
        let installation = self.settings(cwd)?.installation;
        let deadline = std::time::Instant::now() + Duration::from_millis(installation.timeout_ms);
        let list = self.marketplace_list(cwd, project_trusted)?;
        let marketplace = list
            .marketplaces
            .into_iter()
            .find(|marketplace| marketplace.id == marketplace_id)
            .with_context(|| format!("marketplace {marketplace_id} is not available"))?;
        let entry = marketplace
            .plugins
            .into_iter()
            .find(|entry| entry.plugin_id.plugin_name() == plugin_name)
            .with_context(|| {
                format!("plugin {plugin_name} was not found in marketplace {marketplace_id}")
            })?;
        match entry.install_policy {
            InstallPolicy::NotAvailable => {
                bail!(
                    "plugin {} is not available for installation",
                    entry.plugin_id
                )
            }
            InstallPolicy::InstalledByDefault
                if !matches!(&entry.source, PluginSource::Bundled { .. }) =>
            {
                bail!(
                    "third-party marketplace {} may not use installed_by_default",
                    marketplace_id
                )
            }
            InstallPolicy::InstalledByDefault => {}
            InstallPolicy::Available => {}
        }
        match entry.source {
            PluginSource::Local { path } => {
                if !installation.allow_local {
                    bail!("local plugin installation is disabled by settings");
                }
                self.store.install_local_with_identity(
                    &path,
                    entry.plugin_id.clone(),
                    InstalledPluginSource::Marketplace {
                        marketplace: marketplace_id.to_string(),
                        entry: plugin_name.to_string(),
                    },
                    cancellation,
                    deadline,
                )
            }
            PluginSource::Git {
                url,
                path,
                ref_name,
                sha,
            } => {
                if !installation.allow_git {
                    bail!("Git plugin installation is disabled by settings");
                }
                if installation.require_git_sha && sha.is_none() {
                    bail!("Git plugin installation requires an exact SHA");
                }
                let materialized = crate::materialize::materialize_git(
                    crate::materialize::GitMaterializeRequest {
                        url: &url,
                        path: path.as_deref(),
                        ref_name: ref_name.as_deref(),
                        sha: sha.as_deref(),
                        deadline,
                        cancellation,
                    },
                )?;
                self.store.install_local_with_identity(
                    &materialized.root,
                    entry.plugin_id,
                    materialized.evidence,
                    cancellation,
                    deadline,
                )
            }
            PluginSource::Npm {
                package,
                version,
                registry,
                integrity,
            } => {
                if !installation.allow_npm {
                    bail!("npm plugin installation is disabled by settings");
                }
                let materialized = crate::materialize::materialize_npm(
                    crate::materialize::NpmMaterializeRequest {
                        package: &package,
                        version: version.as_deref(),
                        registry: registry.as_deref(),
                        expected_integrity: integrity.as_deref(),
                        require_integrity: installation.require_npm_integrity,
                        limits: crate::InstallLimits {
                            max_files: installation.max_files,
                            max_total_bytes: installation.max_total_bytes,
                            max_file_bytes: installation.max_file_bytes,
                            ..crate::InstallLimits::default()
                        },
                        deadline,
                        cancellation,
                    },
                )?;
                self.store.install_local_with_identity(
                    &materialized.root,
                    entry.plugin_id,
                    materialized.evidence,
                    cancellation,
                    deadline,
                )
            }
            PluginSource::Bundled { bundle, digest } => {
                let materialized = crate::bundled::materialize(&bundle, &digest)?;
                self.store.install_local_with_identity(
                    &materialized.root,
                    entry.plugin_id,
                    materialized.evidence,
                    cancellation,
                    deadline,
                )
            }
        }
    }

    pub fn uninstall(&self, plugin_id: &PluginId, purge_data: bool) -> Result<bool> {
        self.uninstall_with_cancellation(
            plugin_id,
            purge_data,
            &crate::PluginCancellationToken::default(),
        )
    }

    pub fn uninstall_with_cancellation(
        &self,
        plugin_id: &PluginId,
        purge_data: bool,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<bool> {
        let removed =
            self.store
                .uninstall_with_cancellation(plugin_id, purge_data, cancellation)?;
        if removed && let Some(paths) = &self.config_paths {
            update_scope(paths, ConfigScope::User, |document| {
                if let Some(installed) = document
                    .get_mut("plugins")
                    .and_then(|plugins| plugins.get_mut("installed"))
                    .and_then(Value::as_object_mut)
                {
                    installed.remove(&plugin_id.to_string());
                }
                Ok(())
            })?;
            self.update_cached_settings(|settings| {
                settings.installed.remove(&plugin_id.to_string());
            });
        }
        Ok(removed)
    }

    pub fn set_enabled(&self, plugin_id: &PluginId, enabled: bool) -> Result<bool> {
        let record = self
            .store
            .read(plugin_id)?
            .with_context(|| format!("plugin {plugin_id} is not installed"))?;
        let current = self
            .settings(&self.settings_cwd)?
            .installed
            .get(&plugin_id.to_string())
            .and_then(|policy| policy.enabled)
            .unwrap_or(record.enabled_by_default);
        if current == enabled {
            return Ok(false);
        }
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no writable user settings path")?;
        update_scope(paths, ConfigScope::User, |document| {
            let root = document
                .as_object_mut()
                .context("settings root must be an object")?;
            let plugins = object_entry(root, "plugins")?;
            let installed = object_entry(plugins, "installed")?;
            let policy = object_entry(installed, &plugin_id.to_string())?;
            policy.insert("enabled".to_string(), Value::Bool(enabled));
            Ok(())
        })?;
        self.update_cached_settings(|settings| {
            settings
                .installed
                .entry(plugin_id.to_string())
                .or_default()
                .enabled = Some(enabled);
        });
        self.store.bump_generation()?;
        Ok(true)
    }

    fn settings(&self, cwd: &Path) -> Result<PluginsSettings> {
        if let Some(settings) = &self.effective_settings {
            return Ok(settings
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone());
        }
        let Some(paths) = &self.config_paths else {
            return Ok(PluginsSettings::default());
        };
        Ok(SettingsLoader::new(cwd)
            .with_config_dir(paths.config_dir.clone())
            .load()?
            .settings
            .plugins)
    }

    fn update_cached_settings(&self, update: impl FnOnce(&mut PluginsSettings)) {
        if let Some(settings) = &self.effective_settings {
            let mut settings = settings
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            update(&mut settings);
        }
    }

    fn marketplace_is_trusted(
        &self,
        marketplace_root: &Path,
        cwd: &Path,
        project_trusted: bool,
    ) -> bool {
        if project_trusted || !marketplace_is_project_scoped(marketplace_root, cwd) {
            return true;
        }
        self.config_paths.as_ref().is_some_and(|paths| {
            FolderTrustStore::load(&paths.config_dir).check(marketplace_root)
                == FolderTrust::Trusted
        })
    }

    fn marketplace_values(
        &self,
        cwd: &Path,
        project_trusted: bool,
    ) -> Result<BTreeMap<String, Value>> {
        if project_trusted {
            return Ok(self.settings(cwd)?.marketplaces);
        }
        let Some(paths) = &self.config_paths else {
            return Ok(BTreeMap::new());
        };
        let user = kcoder_config::read_scope(paths, ConfigScope::User)?;
        Ok(user
            .get("plugins")
            .and_then(|plugins| plugins.get("marketplaces"))
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default())
    }
}

fn object_entry<'a>(
    object: &'a mut Map<String, Value>,
    name: &str,
) -> Result<&'a mut Map<String, Value>> {
    let value = object
        .entry(name.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    value
        .as_object_mut()
        .with_context(|| format!("settings field {name} must be an object"))
}

fn discover_project_marketplace(cwd: &Path) -> Option<PathBuf> {
    cwd.ancestors().find_map(find_marketplace_manifest_path)
}

fn marketplace_is_project_scoped(root: &Path, cwd: &Path) -> bool {
    root.starts_with(cwd) || cwd.starts_with(root)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConfiguredMarketplaceSetting {
    #[serde(default = "default_enabled")]
    enabled: bool,
    source: ConfiguredMarketplaceSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
enum ConfiguredMarketplaceSource {
    Local {
        path: PathBuf,
    },
    Git {
        url: String,
        #[serde(default)]
        ref_name: Option<String>,
        #[serde(default)]
        sha: Option<String>,
    },
    Npm {
        package: String,
        #[serde(default)]
        version: Option<String>,
        #[serde(default)]
        registry: Option<String>,
        #[serde(default)]
        integrity: Option<String>,
    },
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginListItem {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub root: PathBuf,
    pub enabled: bool,
    pub managed: bool,
    pub source: Option<InstalledPluginSource>,
    pub operation_id: Option<String>,
    pub file_count: Option<usize>,
    pub total_bytes: Option<u64>,
    pub compatibility: CompatibilityReport,
    #[serde(default)]
    pub skill_roots: Vec<PathBuf>,
    #[serde(default)]
    pub command_paths: Vec<PathBuf>,
    #[serde(default)]
    pub mcp_server_names: Vec<String>,
    #[serde(default)]
    pub hook_event_names: Vec<String>,
    pub hook_matcher_count: usize,
    pub diagnostic_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginListResult {
    pub generation: u64,
    pub plugins: Vec<PluginListItem>,
    pub diagnostics: Vec<PluginLoadDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginReadResult {
    pub generation: u64,
    pub plugin: PluginListItem,
    pub diagnostics: Vec<PluginLoadDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDoctorReport {
    pub generation: u64,
    pub healthy: bool,
    pub plugins: Vec<PluginListItem>,
    pub diagnostics: Vec<PluginLoadDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceListItem {
    pub id: String,
    pub path: PathBuf,
    pub display_name: Option<String>,
    pub configured: bool,
    pub plugins: Vec<MarketplaceEntry>,
}

impl MarketplaceListItem {
    fn from_manifest(manifest: crate::MarketplaceManifest, configured: bool) -> Self {
        Self {
            id: manifest.name,
            path: manifest.path,
            display_name: manifest.display_name,
            configured,
            plugins: manifest.plugins,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceDiagnostic {
    pub marketplace_id: Option<String>,
    pub path: Option<PathBuf>,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceListResult {
    pub generation: u64,
    pub marketplaces: Vec<MarketplaceListItem>,
    pub diagnostics: Vec<MarketplaceDiagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn git_marketplace_import_is_persistent_and_failed_registration_cleans_snapshot() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let manifest = write_marketplace(&source, "git-catalog", "demo", "payload");
        for args in [
            vec!["init", "-q"],
            vec!["add", "."],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "fixture",
            ],
        ] {
            assert!(
                std::process::Command::new("git")
                    .args(args)
                    .current_dir(&source)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let store = temp.path().join("profile/plugin_store");
        let manager = PluginManager::open(&store).unwrap();
        let cancellation = crate::PluginCancellationToken::default();
        let url = format!("file://{}", source.display());
        let id = manager
            .marketplace_add_git_with_cancellation(&url, None, temp.path(), true, &cancellation)
            .unwrap();
        assert_eq!(id, "git-catalog");
        let list = manager.marketplace_list(temp.path(), true).unwrap();
        let imported = list.marketplaces.iter().find(|m| m.id == id).unwrap();
        assert_ne!(imported.path, manifest);
        assert!(imported.path.starts_with(&store));
        assert_eq!(imported.plugins.len(), 1);
        assert!(
            manager
                .marketplace_add_git_with_cancellation(&url, None, temp.path(), true, &cancellation)
                .is_err()
        );
        assert_eq!(
            std::fs::read_dir(store.join("marketplaces"))
                .unwrap()
                .count(),
            1
        );
        let reopened = PluginManager::open(&store).unwrap();
        assert!(
            reopened
                .marketplace_list(temp.path(), true)
                .unwrap()
                .marketplaces
                .iter()
                .any(|m| m.id == id)
        );
    }

    fn write_marketplace(root: &Path, marketplace: &str, plugin: &str, payload: &str) -> PathBuf {
        let plugin_root = root.join("plugins").join(plugin);
        std::fs::create_dir_all(plugin_root.join(".codex-plugin")).unwrap();
        std::fs::write(
            plugin_root.join(".codex-plugin/plugin.json"),
            serde_json::json!({"name": plugin, "version": "1.0.0"}).to_string(),
        )
        .unwrap();
        std::fs::write(plugin_root.join("payload"), payload).unwrap();
        let manifest = root.join(".agents/plugins/marketplace.json");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(
            &manifest,
            serde_json::json!({
                "name": marketplace,
                "plugins": [{
                    "name": plugin,
                    "source": {"source": "local", "path": format!("./plugins/{plugin}")}
                }]
            })
            .to_string(),
        )
        .unwrap();
        manifest
    }

    #[test]
    fn manager_lists_managed_plugin_with_store_generation() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            r#"{"name":"managed-demo","version":"1.0.0"}"#,
        )
        .unwrap();
        let manager = PluginManager::open(&temp.path().join("store")).unwrap();
        manager.install_local(&source).unwrap();

        let list = manager.list(temp.path(), true).unwrap();

        assert_eq!(list.generation, 1);
        assert_eq!(list.plugins.len(), 1);
        assert_eq!(list.plugins[0].id, "managed-demo@local");
        assert!(list.plugins[0].managed);
    }

    #[test]
    fn enable_policy_is_written_to_settings_and_removed_on_uninstall() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        std::fs::create_dir_all(source.join(".codex-plugin")).unwrap();
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            r#"{"name":"managed-demo","version":"1.0.0"}"#,
        )
        .unwrap();
        let manager = PluginManager::open(&temp.path().join("plugin_store")).unwrap();
        let record = manager.install_local(&source).unwrap();

        assert!(manager.set_enabled(&record.plugin_id, false).unwrap());
        let list = manager.list(temp.path(), true).unwrap();
        assert_eq!(list.generation, 2);
        assert!(!list.plugins[0].enabled);
        assert!(
            manager
                .effective_snapshot(temp.path(), true)
                .unwrap()
                .plugin_ids
                .is_empty()
        );
        let settings = std::fs::read_to_string(temp.path().join("settings.json")).unwrap();
        let document: Value = serde_json::from_str(&settings).unwrap();
        assert_eq!(
            document["plugins"]["installed"]["managed-demo@local"]["enabled"],
            false
        );

        assert!(manager.uninstall(&record.plugin_id, false).unwrap());
        let settings = std::fs::read_to_string(temp.path().join("settings.json")).unwrap();
        let document: Value = serde_json::from_str(&settings).unwrap();
        assert!(
            document["plugins"]["installed"]
                .get("managed-demo@local")
                .is_none()
        );
    }

    #[test]
    fn two_local_marketplaces_install_same_named_plugin_without_collision() {
        let temp = TempDir::new().unwrap();
        let first_manifest =
            write_marketplace(&temp.path().join("first"), "first-market", "demo", "one");
        let second_manifest =
            write_marketplace(&temp.path().join("second"), "second-market", "demo", "two");
        let manager = PluginManager::open(&temp.path().join("plugin_store")).unwrap();
        manager
            .marketplace_add("first-market", &first_manifest)
            .unwrap();
        manager
            .marketplace_add("second-market", &second_manifest)
            .unwrap();

        let first = manager
            .install_from_marketplace(temp.path(), true, "first-market", "demo")
            .unwrap();
        let second = manager
            .install_from_marketplace(temp.path(), true, "second-market", "demo")
            .unwrap();

        assert_eq!(first.plugin_id.to_string(), "demo@first-market");
        assert_eq!(second.plugin_id.to_string(), "demo@second-market");
        assert_ne!(first.cache_relative_path, second.cache_relative_path);
        assert_eq!(
            std::fs::read_to_string(first.root(manager.store().root()).join("payload")).unwrap(),
            "one"
        );
        assert_eq!(
            std::fs::read_to_string(second.root(manager.store().root()).join("payload")).unwrap(),
            "two"
        );
        assert!(manager.uninstall(&first.plugin_id, false).unwrap());
        assert!(manager.store().read(&second.plugin_id).unwrap().is_some());
    }

    #[test]
    fn automatic_project_marketplace_requires_folder_trust() {
        let temp = TempDir::new().unwrap();
        write_marketplace(temp.path(), "project-market", "demo", "one");
        let manager = PluginManager::open(&temp.path().join("config/plugin_store")).unwrap();

        let untrusted = manager.marketplace_list(temp.path(), false).unwrap();
        assert!(
            !untrusted
                .marketplaces
                .iter()
                .any(|marketplace| marketplace.id == "project-market")
        );
        let trusted = manager.marketplace_list(temp.path(), true).unwrap();
        let project = trusted
            .marketplaces
            .iter()
            .find(|marketplace| marketplace.id == "project-market")
            .unwrap();
        assert!(!project.configured);
        assert!(
            manager
                .marketplace_add_with_trust("project-market", temp.path(), temp.path(), false,)
                .is_err()
        );
        let mut trust_store = FolderTrustStore::load(&temp.path().join("config"));
        trust_store.trust(temp.path()).unwrap();
        manager
            .marketplace_add_with_trust("project-market", temp.path(), temp.path(), false)
            .unwrap();
        let trusted_source = manager.marketplace_list(temp.path(), false).unwrap();
        assert!(
            trusted_source
                .marketplaces
                .iter()
                .any(|marketplace| marketplace.id == "project-market")
        );
        trust_store.revoke(temp.path()).unwrap();
        let revoked = manager.marketplace_list(temp.path(), false).unwrap();
        assert!(
            !revoked
                .marketplaces
                .iter()
                .any(|marketplace| marketplace.id == "project-market")
        );
        assert!(
            revoked
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic.code == "project_marketplace_untrusted" })
        );
    }

    #[test]
    fn git_marketplace_plugin_installs_from_exact_local_fixture_revision() {
        if std::process::Command::new("git")
            .arg("--version")
            .status()
            .is_err()
        {
            return;
        }
        let temp = TempDir::new().unwrap();
        let repository = temp.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        run_git(&repository, &["init"]);
        std::fs::create_dir_all(repository.join(".codex-plugin")).unwrap();
        std::fs::write(
            repository.join(".codex-plugin/plugin.json"),
            r#"{"name":"git-demo","version":"1.0.0"}"#,
        )
        .unwrap();
        run_git(&repository, &["add", "."]);
        run_git(
            &repository,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "fixture",
            ],
        );
        let sha = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&repository)
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap();
        let marketplace_root = temp.path().join("marketplace");
        let manifest = marketplace_root.join(".agents/plugins/marketplace.json");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(
            &manifest,
            serde_json::json!({
                "name": "git-market",
                "plugins": [{
                    "name": "git-demo",
                    "source": {
                        "source": "url",
                        "url": repository,
                        "sha": sha.trim()
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();
        let manager = PluginManager::open(&temp.path().join("config/plugin_store")).unwrap();
        manager.marketplace_add("git-market", &manifest).unwrap();

        let installed = manager
            .install_from_marketplace(temp.path(), true, "git-market", "git-demo")
            .unwrap();

        assert_eq!(installed.plugin_id.to_string(), "git-demo@git-market");
        assert!(matches!(
            &installed.source,
            InstalledPluginSource::Git {
                resolved_sha,
                ..
            } if resolved_sha == sha.trim()
        ));
        assert!(!installed.root(manager.store().root()).join(".git").exists());
    }

    #[test]
    fn npm_marketplace_plugin_installs_from_local_registry_with_integrity() {
        if std::process::Command::new("npm")
            .arg("--version")
            .status()
            .is_err()
        {
            return;
        }
        let temp = TempDir::new().unwrap();
        let tarball = crate::materialize::tests::npm_fixture_tarball();
        let integrity = crate::materialize::tests::sha512_integrity(&tarball);
        let registry = crate::materialize::tests::TestRegistry::start(tarball, integrity.clone());
        let manifest = temp
            .path()
            .join("marketplace/.agents/plugins/marketplace.json");
        std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        std::fs::write(
            &manifest,
            serde_json::json!({
                "name": "npm-market",
                "plugins": [{
                    "name": "fixture-plugin",
                    "source": {
                        "source": "npm",
                        "package": "fixture-plugin",
                        "version": "1.0.0",
                        "registry": registry.registry_url,
                        "integrity": integrity
                    }
                }]
            })
            .to_string(),
        )
        .unwrap();
        let manager = PluginManager::open(&temp.path().join("config/plugin_store")).unwrap();
        manager.marketplace_add("npm-market", &manifest).unwrap();

        let installed = manager
            .install_from_marketplace(temp.path(), true, "npm-market", "fixture-plugin")
            .unwrap();

        assert_eq!(installed.plugin_id.to_string(), "fixture-plugin@npm-market");
        assert!(matches!(
            &installed.source,
            InstalledPluginSource::Npm {
                package,
                integrity: stored,
            } if package == "fixture-plugin" && stored == &integrity
        ));
    }

    #[test]
    fn bundled_marketplace_installs_offline_through_normal_store_transaction() {
        let temp = TempDir::new().unwrap();
        let manager = PluginManager::open(&temp.path().join("config/plugin_store")).unwrap();
        let list = manager.marketplace_list(temp.path(), false).unwrap();
        assert!(
            list.marketplaces
                .iter()
                .any(|marketplace| { marketplace.id == crate::bundled::BUNDLED_MARKETPLACE_ID })
        );

        let installed = manager
            .install_from_marketplace(
                temp.path(),
                false,
                crate::bundled::BUNDLED_MARKETPLACE_ID,
                "kcoder-workflow-basics",
            )
            .unwrap();

        assert_eq!(
            installed.plugin_id.to_string(),
            "kcoder-workflow-basics@kcoder-bundled"
        );
        assert!(matches!(
            installed.source,
            InstalledPluginSource::Bundled { .. }
        ));
        let snapshot = manager.effective_snapshot(temp.path(), false).unwrap();
        assert_eq!(snapshot.generation, 1);
        assert_eq!(snapshot.skill_roots.len(), 1);
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .status()
            .unwrap();
        assert!(status.success());
    }
}
