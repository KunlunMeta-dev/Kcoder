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
    user_baseline: Option<std::sync::RwLock<UserPluginState>>,
}

#[derive(Debug, Default)]
struct UserPluginState {
    marketplaces: BTreeMap<String, Value>,
    proxy: Option<String>,
}

impl UserPluginState {
    fn read(paths: &ConfigPaths) -> Result<Self> {
        let document = kcoder_config::read_scope(paths, ConfigScope::User)?;
        let marketplaces = document
            .pointer("/plugins/marketplaces")
            .and_then(Value::as_object)
            .map(|values| {
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let proxy = document
            .pointer("/plugins/installation/proxy_url")
            .map(|value| serde_json::from_value::<Option<String>>(value.clone()))
            .transpose()?
            .flatten();
        Ok(Self {
            marketplaces,
            proxy,
        })
    }
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
        let user_baseline = UserPluginState::read(&paths)?;
        Ok(Self {
            store,
            user_baseline: Some(std::sync::RwLock::new(user_baseline)),
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
            user_baseline: None,
        })
    }

    pub fn from_store(store: PluginStore) -> Self {
        Self {
            store,
            config_paths: None,
            settings_cwd: PathBuf::new(),
            effective_settings: None,
            user_baseline: None,
        }
    }

    pub fn store(&self) -> &PluginStore {
        &self.store
    }

    pub fn icon(
        &self,
        cwd: &Path,
        project_trusted: bool,
        id: &PluginId,
        dark: bool,
    ) -> Result<Option<String>> {
        if let Some(installed) = self.read(cwd, project_trusted, id)? {
            return crate::icon::read_icon(&installed.plugin.root, dark);
        }
        for market in self.marketplace_list(cwd, project_trusted)?.marketplaces {
            for entry in market.plugins {
                if entry.plugin_id == *id {
                    if let PluginSource::Local { path } = entry.source {
                        return crate::icon::read_icon(&path, dark);
                    }
                }
            }
        }
        Ok(None)
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
                    let managed_parent =
                        dunce::canonicalize(self.store.root().join("marketplaces")).ok();
                    let source_url = if managed_parent
                        .as_deref()
                        .is_some_and(|parent| marketplace.root.parent() == Some(parent))
                    {
                        (|| -> Result<Option<String>> {
                            let file =
                                kcoder_config::PrivateDirectory::open_existing(&marketplace.root)?
                                    .open_regular_file(std::ffi::OsStr::new(
                                        ".kcoder-marketplace-origin.json",
                                    ))?;
                            let mut bytes = Vec::new();
                            std::io::Read::read_to_end(
                                &mut std::io::Read::take(file, 8193),
                                &mut bytes,
                            )?;
                            if bytes.len() > 8192 {
                                bail!("marketplace origin metadata exceeds limit");
                            }
                            Ok(
                                match serde_json::from_slice::<InstalledPluginSource>(&bytes)? {
                                    InstalledPluginSource::Git { redacted_url, .. } => {
                                        Some(if redacted_url.starts_with("https://") {
                                            redacted_url
                                        } else {
                                            format!("file://{redacted_url}")
                                        })
                                    }
                                    _ => None,
                                },
                            )
                        })()
                        .unwrap_or_default()
                    } else {
                        None
                    };
                    let mut item = MarketplaceListItem::from_manifest(marketplace, true);
                    item.source_url = source_url;
                    marketplaces.push(item);
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
        for marketplace in &marketplaces {
            diagnostics.extend(marketplace.diagnostics.iter().map(|message| {
                MarketplaceDiagnostic {
                    marketplace_id: Some(marketplace.id.clone()),
                    path: Some(marketplace.path.clone()),
                    code: "marketplace_entry_unavailable".into(),
                    message: message.clone(),
                }
            }));
        }
        marketplaces.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(MarketplaceListResult {
            generation: self.store.generation()?,
            marketplaces,
            diagnostics,
        })
    }

    /// Persist only a validated, credential-free proxy in this account's user settings.
    pub fn set_download_proxy(&self, value: &str) -> Result<()> {
        let value = value.trim();
        crate::validate_plugin_proxy(value)?;
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin manager has no writable settings path")?;
        update_scope(paths, ConfigScope::User, |document| {
            let root = document
                .as_object_mut()
                .context("settings root must be an object")?;
            let installation = object_entry(object_entry(root, "plugins")?, "installation")?;
            if value.is_empty() {
                installation.remove("proxy_url");
            } else {
                installation.insert("proxy_url".into(), Value::String(value.into()));
            }
            Ok(())
        })?;
        self.update_cached_settings(|settings| {
            settings.installation.proxy_url = (!value.is_empty()).then(|| value.to_string());
        });
        Ok(())
    }

    pub fn marketplace_replace_source(
        &self,
        source: &str,
        id: &str,
        cwd: &Path,
        trusted: bool,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<String> {
        let settings = self.settings(cwd)?;
        let existing = settings
            .marketplaces
            .get(id)
            .context("marketplace is not configured")?;
        let setting: ConfiguredMarketplaceSetting = serde_json::from_value(existing.clone())?;
        let ConfiguredMarketplaceSource::Local { path } = setting.source else {
            bail!("marketplace source is not materialized");
        };
        if source.starts_with("https://") || source.starts_with("file://") {
            self.import_git_marketplace(source, Some(id), cwd, trusted, cancellation, Some(&path))
        } else {
            self.register_marketplace(id, Path::new(source), cwd, trusted, Some(&path))?;
            Ok(id.to_string())
        }
    }

    pub fn marketplace_add(&self, marketplace_id: &str, path: &Path) -> Result<()> {
        self.marketplace_add_with_trust(marketplace_id, path, &self.settings_cwd, true)
    }

    /// Import a validated immutable Git snapshot. Refresh publishes a new snapshot
    /// atomically and retains the previous one if download or validation fails.
    pub fn marketplace_add_git_with_cancellation(
        &self,
        source: &str,
        marketplace_id: Option<&str>,
        cwd: &Path,
        project_trusted: bool,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<String> {
        self.import_git_marketplace(
            source,
            marketplace_id,
            cwd,
            project_trusted,
            cancellation,
            None,
        )
    }

    fn import_git_marketplace(
        &self,
        source: &str,
        marketplace_id: Option<&str>,
        cwd: &Path,
        project_trusted: bool,
        cancellation: &crate::PluginCancellationToken,
        expected_path: Option<&Path>,
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
                limits: crate::InstallLimits {
                    max_files: installation.max_files,
                    max_total_bytes: installation.max_total_bytes,
                    max_file_bytes: installation.max_file_bytes,
                    ..Default::default()
                },
                proxy_url: installation.proxy_url.as_deref(),
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
        if let Some(expected) = expected_path {
            // Origin equality is only an optimization. A local source or damaged old
            // metadata must not prevent explicit replacement with a validated source.
            let previous_origin = (|| -> Result<InstalledPluginSource> {
                let previous = load_marketplace_manifest(expected)?;
                let file = kcoder_config::PrivateDirectory::open_existing(&previous.root)?
                    .open_regular_file(std::ffi::OsStr::new(".kcoder-marketplace-origin.json"))?;
                let mut bytes = Vec::new();
                std::io::Read::read_to_end(&mut std::io::Read::take(file, 8193), &mut bytes)?;
                if bytes.len() > 8192 {
                    bail!("marketplace origin metadata exceeds limit");
                }
                Ok(serde_json::from_slice(&bytes)?)
            })();
            if previous_origin.is_ok_and(|origin| origin == materialized.evidence) {
                return Ok(id);
            }
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
                self.register_marketplace(
                    &id,
                    &manifest.path,
                    cwd,
                    project_trusted,
                    expected_path,
                )?;
                Ok(id.clone())
            },
        )
    }

    /// Load the same target profile used for plugin installation decisions.
    pub fn folder_trust_store(&self) -> Result<FolderTrustStore> {
        let paths = self.config_paths.as_ref().context("plugin configuration is unavailable")?;
        Ok(FolderTrustStore::load(&paths.config_dir))
    }

    /// Record explicit UI consent for exactly the selected local marketplace root.
    pub fn trust_marketplace_source_directory(&self, source: &Path) -> Result<()> {
        if !source.is_absolute() || !source.is_dir() {
            bail!("select an absolute local marketplace root directory to trust");
        }
        let selected = dunce::canonicalize(source)?;
        let marketplace = load_marketplace_manifest(&selected)?;
        if selected != marketplace.root {
            bail!("select the marketplace root directory to trust, not a manifest subdirectory");
        }
        let paths = self
            .config_paths
            .as_ref()
            .context("plugin configuration is unavailable")?;
        FolderTrustStore::load(&paths.config_dir).trust(&selected)
    }

    pub fn marketplace_add_with_trust(
        &self,
        marketplace_id: &str,
        path: &Path,
        cwd: &Path,
        project_trusted: bool,
    ) -> Result<()> {
        self.register_marketplace(marketplace_id, path, cwd, project_trusted, None)
    }

    fn register_marketplace(
        &self,
        marketplace_id: &str,
        path: &Path,
        cwd: &Path,
        project_trusted: bool,
        expected_path: Option<&Path>,
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
            if let Some(expected_path) = expected_path {
                let previous = marketplaces
                    .get(marketplace_id)
                    .context("marketplace was removed during refresh")?;
                let parsed: ConfiguredMarketplaceSetting =
                    serde_json::from_value(previous.clone())?;
                if !parsed.enabled
                    || !matches!(parsed.source, ConfiguredMarketplaceSource::Local { path } if path == expected_path)
                {
                    bail!(
                        "marketplace source changed during refresh; retry with the latest configuration"
                    );
                }
            } else if marketplaces.contains_key(marketplace_id) {
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
        self.marketplace_refresh_with_cancellation(
            cwd,
            project_trusted,
            marketplace_id,
            &crate::PluginCancellationToken::default(),
        )
    }

    pub fn marketplace_refresh_with_cancellation(
        &self,
        cwd: &Path,
        project_trusted: bool,
        marketplace_id: Option<&str>,
        cancellation: &crate::PluginCancellationToken,
    ) -> Result<MarketplaceListResult> {
        let previous = self.marketplace_list(cwd, project_trusted)?;
        let mut failures = Vec::new();
        for market in previous
            .marketplaces
            .iter()
            .filter(|market| marketplace_id.is_none_or(|id| id == market.id))
        {
            cancellation.check()?;
            if !market.configured {
                continue;
            }
            let manifest = load_marketplace_manifest(&market.path)?;
            // Only managed immutable snapshots can trigger network refresh. User directories
            // cannot inject origin metadata into this path.
            let snapshots = dunce::canonicalize(self.store.root().join("marketplaces")).ok();
            if !snapshots
                .as_deref()
                .is_some_and(|parent| manifest.root.parent() == Some(parent))
            {
                continue;
            }
            let origin_file = kcoder_config::PrivateDirectory::open_existing(&manifest.root)?
                .open_regular_file(std::ffi::OsStr::new(".kcoder-marketplace-origin.json"));
            let Ok(file) = origin_file else {
                continue;
            };
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut std::io::Read::take(file, 8193), &mut bytes)?;
            if bytes.len() > 8192 {
                bail!("marketplace origin metadata exceeds limit");
            }
            let origin: InstalledPluginSource = serde_json::from_slice(&bytes)?;
            if let InstalledPluginSource::Git { redacted_url, .. } = origin {
                if let Err(error) = self.import_git_marketplace(
                    &redacted_url,
                    Some(&market.id),
                    cwd,
                    project_trusted,
                    cancellation,
                    Some(&market.path),
                ) {
                    cancellation.check()?;
                    failures.push(MarketplaceDiagnostic {
                        marketplace_id: Some(market.id.clone()),
                        path: Some(market.path.clone()),
                        code: "marketplace_refresh_failed".into(),
                        message: format!("Previous marketplace snapshot retained: {error:#}"),
                    });
                }
            }
        }
        let mut result = self.marketplace_list(cwd, project_trusted)?;
        result.diagnostics.extend(failures);
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
        let fallback = entry.manifest_fallback.as_ref();
        match entry.source {
            PluginSource::Local { path } => {
                if !installation.allow_local {
                    bail!("local plugin installation is disabled by settings");
                }
                self.store.install_marketplace_source(
                    &path,
                    entry.plugin_id.clone(),
                    InstalledPluginSource::Marketplace {
                        marketplace: marketplace_id.to_string(),
                        entry: plugin_name.to_string(),
                    },
                    cancellation,
                    deadline,
                    fallback,
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
                        limits: crate::InstallLimits {
                            max_files: installation.max_files,
                            max_total_bytes: installation.max_total_bytes,
                            max_file_bytes: installation.max_file_bytes,
                            ..Default::default()
                        },
                        proxy_url: installation.proxy_url.as_deref(),
                        url: &url,
                        path: path.as_deref(),
                        ref_name: ref_name.as_deref(),
                        sha: sha.as_deref(),
                        deadline,
                        cancellation,
                    },
                )?;
                self.store.install_marketplace_source(
                    &materialized.root,
                    entry.plugin_id,
                    materialized.evidence,
                    cancellation,
                    deadline,
                    fallback,
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
                        proxy_url: installation.proxy_url.as_deref(),
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
                self.store.install_marketplace_source(
                    &materialized.root,
                    entry.plugin_id,
                    materialized.evidence,
                    cancellation,
                    deadline,
                    fallback,
                )
            }
            PluginSource::Bundled { bundle, digest } => {
                let materialized = crate::bundled::materialize(&bundle, &digest)?;
                self.store.install_marketplace_source(
                    &materialized.root,
                    entry.plugin_id,
                    materialized.evidence,
                    cancellation,
                    deadline,
                    fallback,
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
            let mut settings = settings
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let (Some(paths), Some(baseline)) = (&self.config_paths, &self.user_baseline) {
                let current = UserPluginState::read(paths)?;
                let mut baseline = baseline
                    .write()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                // Apply only user-file changes to fields not shadowed by the effective
                // project/explicit overlay. Separate app-servers then observe the same
                // persisted network and marketplace changes without reintroducing
                // client-local state as the authority.
                if current.proxy != baseline.proxy
                    && settings.installation.proxy_url == baseline.proxy
                {
                    settings.installation.proxy_url = current.proxy.clone();
                }
                for key in baseline
                    .marketplaces
                    .keys()
                    .chain(current.marketplaces.keys())
                {
                    let before = baseline.marketplaces.get(key);
                    let after = current.marketplaces.get(key);
                    if before != after && settings.marketplaces.get(key) == before {
                        if let Some(value) = after {
                            settings.marketplaces.insert(key.clone(), value.clone());
                        } else {
                            settings.marketplaces.remove(key);
                        }
                    }
                }
                *baseline = current;
            }
            return Ok(settings.clone());
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
        // User-managed snapshots are not project extensions, even when the
        // workspace is the user's home (an ancestor of the configuration dir).
        // Compare canonical direct parents, not lexical prefixes: nested project
        // folders and symlinks escaping the managed cache must remain gated.
        let managed_parent = dunce::canonicalize(self.store.root().join("marketplaces")).ok();
        let canonical_root = dunce::canonicalize(marketplace_root).ok();
        let managed_snapshot = managed_parent
            .as_deref()
            .is_some_and(|parent| canonical_root.as_deref().and_then(Path::parent) == Some(parent));
        if managed_snapshot
            || project_trusted
            || !marketplace_is_project_scoped(marketplace_root, cwd)
        {
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
    pub source_url: Option<String>,
    pub diagnostics: Vec<String>,
    pub id: String,
    pub path: PathBuf,
    pub display_name: Option<String>,
    pub configured: bool,
    pub plugins: Vec<MarketplaceEntry>,
}

impl MarketplaceListItem {
    fn from_manifest(manifest: crate::MarketplaceManifest, configured: bool) -> Self {
        Self {
            source_url: None,
            diagnostics: manifest.diagnostics,
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
    fn separate_cached_managers_observe_target_proxy_and_marketplace_changes() {
        let temp = TempDir::new().unwrap();
        let paths = ConfigPaths::with_config_dir(temp.path(), temp.path().join("profile"));
        let first = PluginManager::open_default_for_cwd_with_settings(
            temp.path(),
            paths.clone(),
            PluginsSettings::default(),
        )
        .unwrap();
        let second = PluginManager::open_default_for_cwd_with_settings(
            temp.path(),
            paths,
            PluginsSettings::default(),
        )
        .unwrap();
        first.set_download_proxy("http://127.0.0.1:7890").unwrap();
        assert_eq!(
            second
                .settings(temp.path())
                .unwrap()
                .installation
                .proxy_url
                .as_deref(),
            Some("http://127.0.0.1:7890")
        );
        let market = temp.path().join("market");
        write_marketplace(&market, "shared-market", "demo", "fixture");
        first.marketplace_add("shared-market", &market).unwrap();
        assert!(
            second
                .marketplace_list(temp.path(), true)
                .unwrap()
                .marketplaces
                .iter()
                .any(|item| item.id == "shared-market")
        );
        first.marketplace_remove("shared-market").unwrap();
        first.set_download_proxy("").unwrap();
        assert!(
            second
                .settings(temp.path())
                .unwrap()
                .installation
                .proxy_url
                .is_none()
        );
        assert!(
            !second
                .marketplace_list(temp.path(), true)
                .unwrap()
                .marketplaces
                .iter()
                .any(|item| item.id == "shared-market")
        );
    }

    #[test]
    fn download_proxy_is_private_target_configuration_and_can_be_cleared() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("profile/plugin_store");
        let manager = PluginManager::open(&root).unwrap();
        manager.set_download_proxy("http://127.0.0.1:7890").unwrap();
        assert_eq!(
            PluginManager::open(&root)
                .unwrap()
                .settings(temp.path())
                .unwrap()
                .installation
                .proxy_url
                .as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert!(
            manager
                .set_download_proxy("http://user:secret@host:7890")
                .is_err()
        );
        manager.set_download_proxy("").unwrap();
        assert!(
            PluginManager::open(&root)
                .unwrap()
                .settings(temp.path())
                .unwrap()
                .installation
                .proxy_url
                .is_none()
        );
    }

    #[test]
    fn replacing_local_marketplace_with_git_is_atomic() {
        let temp = TempDir::new().unwrap();
        let first = temp.path().join("first");
        write_marketplace(&first, "replace-test", "first", "one");
        let upstream = temp.path().join("upstream");
        write_marketplace(&upstream, "replace-test", "second", "two");
        run_git(&upstream, &["init", "-q"]);
        run_git(&upstream, &["add", "."]);
        run_git(
            &upstream,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "second",
            ],
        );
        let manager = PluginManager::open(&temp.path().join("profile/plugin_store")).unwrap();
        manager.marketplace_add("replace-test", &first).unwrap();
        manager
            .marketplace_replace_source(
                &format!("file://{}", upstream.display()),
                "replace-test",
                temp.path(),
                true,
                &crate::PluginCancellationToken::default(),
            )
            .unwrap();
        let result = manager.marketplace_list(temp.path(), true).unwrap();
        let market = result
            .marketplaces
            .iter()
            .find(|market| market.id == "replace-test")
            .unwrap();
        assert_eq!(market.plugins[0].plugin_id.plugin_name(), "second");
        assert!(market.source_url.is_some());
        let snapshots = std::fs::read_dir(manager.store.root().join("marketplaces"))
            .unwrap()
            .count();
        manager
            .marketplace_refresh(temp.path(), true, Some("replace-test"))
            .unwrap();
        assert_eq!(
            std::fs::read_dir(manager.store.root().join("marketplaces"))
                .unwrap()
                .count(),
            snapshots
        );
        assert!(
            manager
                .marketplace_replace_source(
                    "/missing-source",
                    "replace-test",
                    temp.path(),
                    true,
                    &crate::PluginCancellationToken::default()
                )
                .is_err()
        );
        assert_eq!(
            manager
                .marketplace_list(temp.path(), true)
                .unwrap()
                .marketplaces
                .iter()
                .find(|m| m.id == "replace-test")
                .unwrap()
                .plugins[0]
                .plugin_id
                .plugin_name(),
            "second"
        );
    }

    #[test]
    fn refreshing_git_marketplace_updates_and_retains_previous_on_failure() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("upstream");
        let manifest = write_marketplace(&source, "refresh-test", "first", "one");
        run_git(&source, &["init", "-q"]);
        run_git(&source, &["add", "."]);
        run_git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "first",
            ],
        );
        let manager = PluginManager::open(&temp.path().join("profile/plugin_store")).unwrap();
        manager
            .marketplace_add_git_with_cancellation(
                &format!("file://{}", source.display()),
                None,
                temp.path(),
                true,
                &crate::PluginCancellationToken::default(),
            )
            .unwrap();
        write_marketplace(&source, "refresh-test", "second", "two");
        run_git(&source, &["add", "."]);
        run_git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "second",
            ],
        );
        let refreshed = manager
            .marketplace_refresh(temp.path(), true, Some("refresh-test"))
            .unwrap();
        assert!(refreshed.diagnostics.is_empty());
        assert_eq!(
            refreshed.marketplaces[0].plugins[0].plugin_id.plugin_name(),
            "second"
        );
        std::fs::write(manifest, "invalid JSON").unwrap();
        run_git(&source, &["add", "."]);
        run_git(
            &source,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "broken",
            ],
        );
        let failed = manager
            .marketplace_refresh(temp.path(), true, Some("refresh-test"))
            .unwrap();
        assert_eq!(
            failed.marketplaces[0].plugins[0].plugin_id.plugin_name(),
            "second"
        );
        assert_eq!(failed.diagnostics[0].code, "marketplace_refresh_failed");
    }

    #[test]
    fn explicit_skill_bundle_installs_without_mutating_its_source() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("market");
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::create_dir_all(root.join("bundle/one")).unwrap();
        std::fs::write(
            root.join("bundle/one/SKILL.md"),
            "---\nname: one\ndescription: Fixture\n---\nFixture",
        )
        .unwrap();
        std::fs::write(root.join(".claude-plugin/marketplace.json"), r#"{"name":"bundles","plugins":[{"name":"bundle","source":"./bundle","strict":false,"skills":["./one"]},{"name":"unsupported","source":{"source":"unknown"}}]}"#).unwrap();
        let manager = PluginManager::open(&temp.path().join("profile/plugin_store")).unwrap();
        manager.marketplace_add("bundles", &root).unwrap();
        let list = manager.marketplace_list(temp.path(), true).unwrap();
        assert!(!list.diagnostics.is_empty());
        manager
            .install_from_marketplace(temp.path(), true, "bundles", "bundle")
            .unwrap();
        assert!(!root.join("bundle/.claude-plugin/plugin.json").exists());
    }

    #[test]
    #[ignore = "requires explicit public repository network smoke URL"]
    fn public_marketplace_network_smoke() {
        let source =
            std::env::var("KCODER_PLUGIN_NETWORK_SMOKE_URL").expect("explicit smoke URL required");
        let temp = TempDir::new().unwrap();
        let manager = PluginManager::open(&temp.path().join("profile/plugin_store")).unwrap();
        let id = manager
            .marketplace_add_git_with_cancellation(
                &source,
                None,
                temp.path(),
                true,
                &crate::PluginCancellationToken::default(),
            )
            .unwrap();
        let list = manager.marketplace_list(temp.path(), true).unwrap();
        let market = list
            .marketplaces
            .iter()
            .find(|market| market.id == id)
            .unwrap();
        assert!(!market.plugins.is_empty());
        let api_manifest = market.path.with_file_name("api_marketplace.json");
        if api_manifest.is_file() {
            let api_market = load_marketplace_manifest(&api_manifest).unwrap();
            assert!(!api_market.plugins.is_empty());
            println!(
                "API marketplace {}: {} entries, {} diagnostics",
                api_market.name,
                api_market.plugins.len(),
                api_market.diagnostics.len()
            );
        }
        if let Ok(names) = std::env::var("KCODER_PLUGIN_NETWORK_SMOKE_INSTALL") {
            for name in names.split(',').filter(|name| !name.is_empty()) {
                manager
                    .install_from_marketplace(temp.path(), true, &id, name)
                    .unwrap_or_else(|error| panic!("install {name}: {error:#}"));
                let inventory = manager.list(temp.path(), true).unwrap();
                let plugin = inventory
                    .plugins
                    .iter()
                    .find(|plugin| plugin.id == format!("{name}@{id}"))
                    .expect("installed plugin must be discoverable");
                println!(
                    "Installed {name}: skills={}, MCP={}, hooks={}, compatibility={}",
                    plugin.skill_roots.len(),
                    plugin.mcp_server_names.len(),
                    plugin.hook_matcher_count,
                    serde_json::to_string(&plugin.compatibility).unwrap()
                );
                assert_eq!(plugin.diagnostic_count, 0);
                assert!(plugin.enabled && plugin.managed);
                assert!(
                    manager
                        .uninstall(&PluginId::new(name, &id).unwrap(), true)
                        .unwrap()
                );
                assert!(
                    !manager
                        .list(temp.path(), true)
                        .unwrap()
                        .plugins
                        .iter()
                        .any(|plugin| plugin.id == format!("{name}@{id}"))
                );
                println!("Uninstalled {name}");
            }
        }
        if market
            .plugins
            .iter()
            .any(|entry| entry.plugin_id.plugin_name() == "frontend-design")
        {
            manager
                .install_from_marketplace(temp.path(), true, &id, "frontend-design")
                .unwrap();
            let inventory = manager.list(temp.path(), true).unwrap();
            assert!(
                inventory
                    .plugins
                    .iter()
                    .any(|plugin| plugin.id == format!("frontend-design@{id}")
                        && !plugin.skill_roots.is_empty())
            );
        }
        println!(
            "Imported {} entries; {} diagnostics",
            market.plugins.len(),
            list.diagnostics.len()
        );
        let refreshed = manager
            .marketplace_refresh(temp.path(), true, Some(&id))
            .unwrap();
        assert!(
            refreshed.diagnostics.is_empty(),
            "refresh diagnostics: {:?}",
            refreshed.diagnostics
        );
        assert!(
            refreshed
                .marketplaces
                .iter()
                .any(|market| market.id == id && !market.plugins.is_empty())
        );
        println!("Refreshed {id}");
    }

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
    fn managed_marketplace_under_untrusted_home_can_register_list_and_install() {
        let home = TempDir::new().unwrap();
        let manager = PluginManager::open(&home.path().join("config/plugin_store")).unwrap();
        let source = home.path().join("download");
        write_marketplace(&source, "managed-market", "demo", "one");
        manager
            .store
            .with_marketplace_snapshot(
                &source,
                crate::InstallLimits::default(),
                std::time::Instant::now() + Duration::from_secs(30),
                &crate::PluginCancellationToken::default(),
                |snapshot| {
                    manager.marketplace_add_with_trust(
                        "managed-market",
                        snapshot,
                        home.path(),
                        false,
                    )
                },
            )
            .unwrap();
        // Reload too: registration must not be the only place exempting snapshots.
        let manager = PluginManager::open(manager.store.root()).unwrap();
        let listed = manager.marketplace_list(home.path(), false).unwrap();
        assert!(
            listed
                .marketplaces
                .iter()
                .any(|market| market.id == "managed-market")
        );
        assert!(listed.diagnostics.is_empty());
        let installed = manager
            .install_from_marketplace(home.path(), false, "managed-market", "demo")
            .unwrap();
        assert_eq!(installed.plugin_id.to_string(), "demo@managed-market");
        assert_eq!(
            FolderTrustStore::load(&home.path().join("config")).check(home.path()),
            FolderTrust::Unknown
        );
        // Ordinary local sources under that home are still project-scoped.
        assert!(
            manager
                .marketplace_add_with_trust("managed-market", &source, home.path(), false)
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn managed_marketplace_symlink_cannot_bypass_project_trust() {
        let home = TempDir::new().unwrap();
        let manager = PluginManager::open(&home.path().join("config/plugin_store")).unwrap();
        let source = home.path().join("project");
        write_marketplace(&source, "project-market", "demo", "one");
        let cache = manager.store.root().join("marketplaces");
        std::fs::create_dir_all(&cache).unwrap();
        let link = cache.join("redirect");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(!manager.marketplace_is_trusted(&link, home.path(), false));
        assert!(
            manager
                .marketplace_add_with_trust("project-market", &link, home.path(), false)
                .is_err()
        );
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
        drop(snapshot);
        assert!(manager.uninstall(&installed.plugin_id, false).unwrap());
        drop(manager);
        let reopened = PluginManager::open(&temp.path().join("plugin_store")).unwrap();
        reopened.marketplace_list(temp.path(), false).unwrap();
        assert!(
            reopened
                .store()
                .read(&installed.plugin_id)
                .unwrap()
                .is_none()
        );
        assert!(
            reopened
                .effective_snapshot(temp.path(), false)
                .unwrap()
                .skill_roots
                .is_empty()
        );
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
