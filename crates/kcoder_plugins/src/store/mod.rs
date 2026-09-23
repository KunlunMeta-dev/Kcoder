mod copy;
mod state;

pub use copy::{CopyStats, InstallLimits};
pub use state::{InstalledPluginRecord, InstalledPluginSource};

use crate::{PluginCancellationToken, PluginId, load_plugin_manifest};
use anyhow::{Context, Result, anyhow, bail};
use fs2::FileExt;
use kcoder_config::PrivateDirectory;
use serde::{Deserialize, Serialize};
use state::StoreState;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};
use uuid::Uuid;

const LOCKS_DIRECTORY: &str = "locks";
const CACHE_DIRECTORY: &str = "cache";
const DATA_DIRECTORY: &str = "data";
const STAGING_DIRECTORY: &str = "staging";
const BACKUPS_DIRECTORY: &str = "backups";
const TRANSACTIONS_DIRECTORY: &str = "transactions";
const STATE_LOCK_FILE: &str = "state.lock";
const MAX_TRANSACTION_BYTES: u64 = 1024 * 1024;
const ORPHAN_TRANSACTION_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Debug)]
pub struct PluginStore {
    root: PathBuf,
    private_root: PrivateDirectory,
    private_locks: PrivateDirectory,
    private_transactions: PrivateDirectory,
    limits: InstallLimits,
    operation_timeout: Duration,
    #[cfg(test)]
    fault: std::sync::Mutex<Option<TransactionFault>>,
}

#[derive(Debug, Clone)]
pub struct PluginStoreSnapshot {
    pub generation: u64,
    pub installed: Vec<InstalledPluginRecord>,
}

#[derive(Debug, thiserror::Error)]
#[error(
    "plugin resources are busy; close dependent conversations or stop the runtime before purging data"
)]
pub struct PluginInUseError;

/// A read lease for one immutable installed version. Clones of runtime
/// snapshots share this handle; normal updates do not revoke execution rights.
#[derive(Debug)]
pub struct PluginVersionLease {
    _lock: FileLock,
}

struct StagedInstallRequest<'a> {
    canonical_source: &'a Path,
    plugin_id: PluginId,
    operation_id: String,
    staging_relative: PathBuf,
    installed_source: InstalledPluginSource,
    cancellation: &'a PluginCancellationToken,
    deadline: Instant,
}

impl PluginStore {
    pub fn open_default() -> Result<Self> {
        let root = kcoder_config::user_config_dir()?.join("plugin_store");
        Self::open(&root)
    }

    pub fn open(root: &Path) -> Result<Self> {
        let private_root = PrivateDirectory::open_or_create(root)
            .with_context(|| format!("failed to open plugin store {}", root.display()))?;
        let root = resolved_store_root(root)?;
        for directory in [
            LOCKS_DIRECTORY,
            CACHE_DIRECTORY,
            DATA_DIRECTORY,
            STAGING_DIRECTORY,
            BACKUPS_DIRECTORY,
            TRANSACTIONS_DIRECTORY,
        ] {
            PrivateDirectory::open_or_create(&root.join(directory))
                .with_context(|| format!("failed to prepare plugin store directory {directory}"))?;
        }
        let private_locks = PrivateDirectory::open_existing(&root.join(LOCKS_DIRECTORY))?;
        let private_transactions =
            PrivateDirectory::open_existing(&root.join(TRANSACTIONS_DIRECTORY))?;
        let store = Self {
            root,
            private_root,
            private_locks,
            private_transactions,
            limits: InstallLimits::default(),
            operation_timeout: Duration::from_secs(120),
            #[cfg(test)]
            fault: std::sync::Mutex::new(None),
        };
        store.read_state()?;
        store.recover_all()?;
        store.cleanup_unused_versions()?;
        store
            .cleanup_orphaned_transaction_directories(SystemTime::now(), ORPHAN_TRANSACTION_TTL)?;
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn with_marketplace_snapshot<T>(
        &self,
        source: &Path,
        limits: InstallLimits,
        deadline: Instant,
        cancellation: &PluginCancellationToken,
        publish: impl FnOnce(&Path) -> Result<T>,
    ) -> Result<T> {
        let parent = self.root.join("marketplaces");
        PrivateDirectory::open_or_create(&parent)?;
        let snapshot = parent.join(Uuid::new_v4().simple().to_string());
        PrivateDirectory::open_or_create(&snapshot)?;
        let result = (|| {
            copy::copy_local_tree(source, &snapshot, limits, deadline, cancellation)?;
            cancellation.check()?;
            publish(&snapshot)
        })();
        if result.is_err() {
            remove_owned_tree(&snapshot)
                .context("failed to clean unpublished marketplace snapshot")?;
        }
        result
    }

    pub fn with_limits(mut self, limits: InstallLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn with_operation_timeout(mut self, timeout: Duration) -> Self {
        self.operation_timeout = timeout;
        self
    }

    pub fn generation(&self) -> Result<u64> {
        Ok(self.snapshot()?.generation)
    }

    pub fn installed_plugins(&self) -> Result<Vec<InstalledPluginRecord>> {
        Ok(self.snapshot()?.installed)
    }

    pub fn snapshot(&self) -> Result<PluginStoreSnapshot> {
        let state = self.read_state()?;
        Ok(PluginStoreSnapshot {
            generation: state.generation,
            installed: state.installed.into_values().collect(),
        })
    }

    /// Capture installed records and pin their directories without holding the
    /// state lock while waiting for a writer's version lock (avoids inversion).
    pub fn snapshot_with_leases(
        &self,
    ) -> Result<(PluginStoreSnapshot, Vec<std::sync::Arc<PluginVersionLease>>)> {
        self.cleanup_unused_versions()?;
        let deadline = Instant::now() + self.operation_timeout;
        for _ in 0..3 {
            let snapshot = self.snapshot()?;
            let mut leases = Vec::new();
            for record in &snapshot.installed {
                let lock =
                    self.acquire_shared_lock(&version_lock_name(&record.operation_id)?, deadline)?;
                leases.push(std::sync::Arc::new(PluginVersionLease { _lock: lock }));
            }
            if self.generation()? == snapshot.generation {
                if snapshot
                    .installed
                    .iter()
                    .all(|record| record.root(&self.root).is_dir())
                {
                    return Ok((snapshot, leases));
                }
                drop(leases);
                self.recover_all()?;
            }
        }
        bail!("plugin versions changed while capturing runtime snapshot; retry the operation")
    }

    /// Reclaim only unreferenced, unlocked immutable versions. Operation locks
    /// prevent racing a staged publication; shared version leases protect readers.
    pub fn cleanup_unused_versions(&self) -> Result<usize> {
        let mut removed = 0;
        for market in fs::read_dir(self.root.join(CACHE_DIRECTORY))? {
            let market = market?;
            if !market.file_type()?.is_dir() {
                continue;
            }
            for plugin in fs::read_dir(market.path())? {
                let plugin = plugin?;
                if !plugin.file_type()?.is_dir() {
                    continue;
                }
                let Some(market_name) = market.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Some(plugin_name) = plugin.file_name().to_str().map(str::to_owned) else {
                    continue;
                };
                let Ok(id) = PluginId::new(&plugin_name, &market_name) else {
                    continue;
                };
                let Some(_operation) = self.try_exclusive_lock(&plugin_lock_name(&id))? else {
                    continue;
                };
                if self.load_marker(&id)?.is_some() {
                    continue;
                }
                let current = self.read(&id)?.map(|record| record.root(&self.root));
                for entry in fs::read_dir(plugin.path())? {
                    let entry = entry?;
                    if !entry.file_type()?.is_dir() || current.as_ref() == Some(&entry.path()) {
                        continue;
                    }
                    let name = entry.file_name();
                    let Some(operation) =
                        name.to_str().and_then(|name| name.strip_prefix("install-"))
                    else {
                        continue;
                    };
                    let Ok(lock_name) = version_lock_name(operation) else {
                        continue;
                    };
                    let Some(_version) = self.try_exclusive_lock(&lock_name)? else {
                        continue;
                    };
                    remove_owned_tree(&entry.path())?;
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    pub fn read(&self, plugin_id: &PluginId) -> Result<Option<InstalledPluginRecord>> {
        Ok(self
            .read_state()?
            .installed
            .get(&plugin_id.to_string())
            .cloned())
    }

    pub fn install_local(
        &self,
        source: &Path,
        marketplace_name: &str,
    ) -> Result<InstalledPluginRecord> {
        self.install_local_with_cancellation(
            source,
            marketplace_name,
            &PluginCancellationToken::default(),
        )
    }

    pub(crate) fn install_local_with_cancellation(
        &self,
        source: &Path,
        marketplace_name: &str,
        cancellation: &PluginCancellationToken,
    ) -> Result<InstalledPluginRecord> {
        let deadline = Instant::now() + self.operation_timeout;
        cancellation.check()?;
        let canonical_source = dunce::canonicalize(source).with_context(|| {
            format!("failed to resolve local plugin source {}", source.display())
        })?;
        let source_manifest = load_plugin_manifest(&canonical_source)
            .map_err(anyhow::Error::from)?
            .context("local plugin source does not contain a supported manifest")?;
        let source_name = manifest_identity_name(&source_manifest.manifest)?;
        let plugin_id = PluginId::new(source_name, marketplace_name)?;
        self.install_local_with_identity(
            &canonical_source,
            plugin_id,
            InstalledPluginSource::Local {
                canonical_path: canonical_source.clone(),
            },
            cancellation,
            deadline,
        )
    }

    pub(crate) fn install_marketplace_source(
        &self,
        source: &Path,
        plugin_id: PluginId,
        installed_source: InstalledPluginSource,
        cancellation: &PluginCancellationToken,
        deadline: Instant,
        fallback: Option<&serde_json::Value>,
    ) -> Result<InstalledPluginRecord> {
        let bundle = fallback
            .filter(|value| value.get("strict") == Some(&serde_json::Value::Bool(false)))
            .and_then(|value| value.get("skills"))
            .filter(|value| value.is_array());
        let loaded = load_plugin_manifest(source).map_err(anyhow::Error::from)?;
        if let Some(loaded) = &loaded {
            if loaded.compatibility.supported_capabilities.is_empty()
                && !loaded.compatibility.deferred_capabilities.is_empty()
            {
                bail!(
                    "plugin is not available for installation: its declared capabilities are not activated by this runtime"
                );
            }
        }
        if loaded.is_some() || bundle.is_none() {
            return self.install_local_with_identity(
                source,
                plugin_id,
                installed_source,
                cancellation,
                deadline,
            );
        }
        let temporary = kcoder_config::create_private_temp_dir("kcoder-plugin-skill-bundle")?;
        let root = temporary.path().join("plugin");
        PrivateDirectory::open_or_create(&root)?;
        copy::copy_local_tree(source, &root, self.limits, deadline, cancellation)?;
        let manifest_dir = PrivateDirectory::open_or_create(&root.join(".claude-plugin"))?;
        let manifest = serde_json::json!({ "name": plugin_id.plugin_name(), "skills": bundle.unwrap(),
            "description": fallback.and_then(|value| value.get("description")).and_then(serde_json::Value::as_str),
            "version": fallback.and_then(|value| value.get("version")).and_then(serde_json::Value::as_str),
            "hooks": {}, "mcpServers": {}, "commands": [] });
        manifest_dir.atomic_replace(
            std::ffi::OsStr::new("plugin.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
        self.install_local_with_identity(&root, plugin_id, installed_source, cancellation, deadline)
    }

    pub(crate) fn install_local_with_identity(
        &self,
        source: &Path,
        plugin_id: PluginId,
        installed_source: InstalledPluginSource,
        cancellation: &PluginCancellationToken,
        deadline: Instant,
    ) -> Result<InstalledPluginRecord> {
        cancellation.check()?;
        let canonical_source = dunce::canonicalize(source).with_context(|| {
            format!("failed to resolve local plugin source {}", source.display())
        })?;
        let source_manifest = load_plugin_manifest(&canonical_source)
            .map_err(anyhow::Error::from)?
            .context("local plugin source does not contain a supported manifest")?;
        let source_name = manifest_identity_name(&source_manifest.manifest)?;
        if source_name != plugin_id.plugin_name() {
            bail!(
                "marketplace plugin name {} does not match manifest identity {}",
                plugin_id.plugin_name(),
                source_name
            );
        }
        let _plugin_lock =
            self.acquire_cancellable_lock(&plugin_lock_name(&plugin_id), deadline, cancellation)?;
        cancellation.check()?;
        self.recover_locked(&plugin_id, deadline)?;

        let operation_id = Uuid::new_v4().simple().to_string();
        let staging_relative = PathBuf::from(STAGING_DIRECTORY).join(&operation_id);
        let staging = self.absolute(&staging_relative)?;
        PrivateDirectory::open_or_create(&staging)
            .context("failed to create private plugin staging directory")?;

        let install_result = self.install_local_staged(StagedInstallRequest {
            canonical_source: &canonical_source,
            plugin_id,
            operation_id,
            staging_relative: staging_relative.clone(),
            installed_source,
            cancellation,
            deadline,
        });
        if install_result.is_err()
            && self
                .transaction_marker_path_exists_for_staging(&staging_relative)
                .is_none()
        {
            let _ = remove_owned_tree(&staging);
        }
        install_result
    }

    fn install_local_staged(
        &self,
        request: StagedInstallRequest<'_>,
    ) -> Result<InstalledPluginRecord> {
        let StagedInstallRequest {
            canonical_source,
            plugin_id,
            operation_id,
            staging_relative,
            installed_source,
            cancellation,
            deadline,
        } = request;
        let staging = self.absolute(&staging_relative)?;
        let stats = copy::copy_local_tree(
            canonical_source,
            &staging,
            self.limits,
            deadline,
            cancellation,
        )?;
        cancellation.check()?;
        self.maybe_fail(TransactionFault::AfterStage)?;
        let loaded = load_plugin_manifest(&staging)
            .map_err(anyhow::Error::from)?
            .context("staged plugin does not contain a supported manifest")?;
        let staged_name = manifest_identity_name(&loaded.manifest)?;
        if staged_name != plugin_id.plugin_name() {
            bail!(
                "plugin identity changed while staging: expected {}, found {}",
                plugin_id.plugin_name(),
                staged_name
            );
        }

        let target_relative = PathBuf::from(CACHE_DIRECTORY)
            .join(plugin_id.marketplace_name())
            .join(plugin_id.plugin_name())
            .join(format!("install-{operation_id}"));
        let target = self.absolute(&target_relative)?;
        let target_parent = target
            .parent()
            .context("plugin cache target has no parent")?;
        PrivateDirectory::open_or_create(target_parent)
            .context("failed to prepare private plugin cache namespace")?;
        let backup_relative = PathBuf::from(BACKUPS_DIRECTORY).join(&operation_id);
        let backup = self.absolute(&backup_relative)?;
        let previous = self.read(&plugin_id)?;
        let previous_version_lock = previous
            .as_ref()
            .map(|record| self.try_exclusive_lock(&version_lock_name(&record.operation_id)?))
            .transpose()?
            .flatten();
        let marker = TransactionMarker {
            state_version: 1,
            operation_id,
            plugin_id: plugin_id.clone(),
            kind: TransactionKind::Install,
            staging_relative: Some(staging_relative),
            new_relative: Some(target_relative.clone()),
            previous_relative: previous
                .as_ref()
                .map(|record| record.cache_relative_path.clone()),
            backup_relative: previous
                .as_ref()
                .filter(|_| previous_version_lock.is_some())
                .map(|_| backup_relative),
        };
        self.persist_marker(&marker)?;

        let transaction_result = (|| {
            cancellation.check()?;
            self.maybe_fail(TransactionFault::AfterMarker)?;
            if let Some(previous) = &previous {
                let previous_root = previous.root(&self.root);
                if !previous_root.is_dir() {
                    bail!(
                        "installed plugin {} is missing from {}",
                        plugin_id,
                        previous_root.display()
                    );
                }
                if marker.backup_relative.is_some() {
                    rename_owned_path(&previous_root, &backup)
                        .context("failed to move previous plugin version to backup")?;
                }
            }
            self.maybe_cancel(TransactionFault::CancelAfterBackup, cancellation);
            cancellation.check()?;
            self.maybe_fail(TransactionFault::AfterBackup)?;
            rename_owned_path(&staging, &target)
                .context("failed to activate staged plugin version")?;
            self.maybe_fail(TransactionFault::AfterActivate)?;
            cancellation.check()?;

            let record = InstalledPluginRecord {
                plugin_id: plugin_id.clone(),
                display_name: loaded.manifest.name,
                version: loaded.manifest.version,
                enabled_by_default: loaded.manifest.enabled_by_default,
                operation_id: marker.operation_id.clone(),
                file_count: stats.files,
                total_bytes: stats.total_bytes,
                cache_relative_path: target_relative,
                source: installed_source,
            };
            self.maybe_fail(TransactionFault::BeforeStatePersist)?;
            cancellation.check()?;
            self.update_state(deadline, |state| {
                let current = state.installed.get(&plugin_id.to_string()).cloned();
                if current != previous {
                    bail!("plugin state changed during installation");
                }
                state
                    .installed
                    .insert(plugin_id.to_string(), record.clone());
                state.generation = state
                    .generation
                    .checked_add(1)
                    .context("plugin generation overflow")?;
                Ok(())
            })?;
            self.maybe_fail(TransactionFault::AfterStatePersist)?;
            Ok(record)
        })();

        match transaction_result {
            Ok(record) => {
                self.finish_transaction(&marker)?;
                tracing::info!(
                    plugin_id = %record.plugin_id,
                    operation_id = %record.operation_id,
                    file_count = record.file_count,
                    total_bytes = record.total_bytes,
                    "plugin installation committed"
                );
                Ok(record)
            }
            Err(error) => {
                let committed_record = self.read(&plugin_id).ok().flatten().filter(|record| {
                    marker.new_relative.as_ref() == Some(&record.cache_relative_path)
                });
                let recovery = self.recover_marker(&marker, deadline);
                match recovery {
                    Ok(()) if let Some(record) = committed_record => {
                        tracing::warn!(
                            plugin_id = %plugin_id,
                            error = %error,
                            "plugin install committed but post-commit cleanup reported an error"
                        );
                        Ok(record)
                    }
                    Ok(()) => {
                        tracing::warn!(
                            plugin_id = %plugin_id,
                            operation_id = %marker.operation_id,
                            "plugin installation rolled back"
                        );
                        Err(error.context("plugin installation rolled back"))
                    }
                    Err(recovery_error) => Err(error.context(format!(
                        "plugin installation failed and rollback also failed: {recovery_error:#}"
                    ))),
                }
            }
        }
    }

    pub fn uninstall(&self, plugin_id: &PluginId, purge_data: bool) -> Result<bool> {
        self.uninstall_with_cancellation(plugin_id, purge_data, &PluginCancellationToken::default())
    }

    pub(crate) fn uninstall_with_cancellation(
        &self,
        plugin_id: &PluginId,
        purge_data: bool,
        cancellation: &PluginCancellationToken,
    ) -> Result<bool> {
        cancellation.check()?;
        self.cleanup_unused_versions()?;
        let deadline = Instant::now() + self.operation_timeout;
        let _plugin_lock =
            self.acquire_cancellable_lock(&plugin_lock_name(plugin_id), deadline, cancellation)?;
        self.recover_locked(plugin_id, deadline)?;
        let Some(previous) = self.read(plugin_id)? else {
            return Ok(false);
        };
        let previous_version_lock =
            self.try_exclusive_lock(&version_lock_name(&previous.operation_id)?)?;
        if purge_data {
            // A retained older version can still use the plugin's data directory.
            let parent = previous
                .root(&self.root)
                .parent()
                .context("plugin version has no namespace")?
                .to_path_buf();
            if previous_version_lock.is_none()
                || fs::read_dir(parent)?.any(|entry| {
                    entry.is_ok_and(|entry| {
                        entry.path() != previous.root(&self.root)
                            && entry.file_type().is_ok_and(|kind| kind.is_dir())
                    })
                })
            {
                return Err(PluginInUseError.into());
            }
        }
        let operation_id = Uuid::new_v4().simple().to_string();
        let backup_relative = PathBuf::from(BACKUPS_DIRECTORY).join(&operation_id);
        let marker = TransactionMarker {
            state_version: 1,
            operation_id,
            plugin_id: plugin_id.clone(),
            kind: TransactionKind::Uninstall,
            staging_relative: None,
            new_relative: None,
            previous_relative: Some(previous.cache_relative_path.clone()),
            backup_relative: previous_version_lock
                .as_ref()
                .map(|_| backup_relative.clone()),
        };
        self.persist_marker(&marker)?;
        let previous_root = previous.root(&self.root);
        let backup = self.absolute(&backup_relative)?;
        let result: Result<()> = (|| {
            cancellation.check()?;
            self.maybe_fail(TransactionFault::AfterMarker)?;
            if marker.backup_relative.is_some() {
                rename_owned_path(&previous_root, &backup)
                    .context("failed to move plugin into uninstall backup")?;
            }
            self.maybe_fail(TransactionFault::AfterBackup)?;
            cancellation.check()?;
            self.maybe_fail(TransactionFault::BeforeStatePersist)?;
            self.update_state(deadline, |state| {
                let current = state.installed.get(&plugin_id.to_string());
                if current != Some(&previous) {
                    bail!("plugin state changed during uninstall");
                }
                state.installed.remove(&plugin_id.to_string());
                state.generation = state
                    .generation
                    .checked_add(1)
                    .context("plugin generation overflow")?;
                Ok(())
            })?;
            Ok(())
        })();
        if let Err(error) = result {
            self.recover_marker(&marker, deadline)?;
            return Err(error.context("plugin uninstall rolled back"));
        }
        self.finish_transaction(&marker)?;
        if purge_data {
            let data = self.data_root(plugin_id)?;
            if data.exists() {
                remove_owned_tree(&data).context("failed to purge plugin data")?;
            }
        }
        Ok(true)
    }

    pub fn bump_generation(&self) -> Result<u64> {
        let deadline = Instant::now() + self.operation_timeout;
        self.update_state(deadline, |state| {
            state.generation = state
                .generation
                .checked_add(1)
                .context("plugin generation overflow")?;
            Ok(())
        })?;
        self.generation()
    }

    pub fn data_root(&self, plugin_id: &PluginId) -> Result<PathBuf> {
        let relative = PathBuf::from(DATA_DIRECTORY)
            .join(plugin_id.marketplace_name())
            .join(plugin_id.plugin_name());
        self.absolute(&relative)
    }

    fn read_state(&self) -> Result<StoreState> {
        let deadline = Instant::now() + self.operation_timeout;
        let _lock = self.acquire_shared_lock(STATE_LOCK_FILE, deadline)?;
        StoreState::load(&self.root, &self.private_root)
    }

    fn update_state(
        &self,
        deadline: Instant,
        update: impl FnOnce(&mut StoreState) -> Result<()>,
    ) -> Result<()> {
        let _lock = self.acquire_lock(STATE_LOCK_FILE, deadline)?;
        let mut state = StoreState::load(&self.root, &self.private_root)?;
        update(&mut state)?;
        state.persist(&self.private_root)
    }

    fn acquire_lock(&self, name: &str, deadline: Instant) -> Result<FileLock> {
        self.acquire_lock_with_mode(name, deadline, false, None)
    }

    fn acquire_cancellable_lock(
        &self,
        name: &str,
        deadline: Instant,
        cancellation: &PluginCancellationToken,
    ) -> Result<FileLock> {
        self.acquire_lock_with_mode(name, deadline, false, Some(cancellation))
    }

    fn acquire_shared_lock(&self, name: &str, deadline: Instant) -> Result<FileLock> {
        self.acquire_lock_with_mode(name, deadline, true, None)
    }

    fn try_exclusive_lock(&self, name: &str) -> Result<Option<FileLock>> {
        self.private_locks.append(OsStr::new(name), b"")?;
        let file = self.private_locks.open_regular_file(OsStr::new(name))?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(FileLock { file })),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn acquire_lock_with_mode(
        &self,
        name: &str,
        deadline: Instant,
        shared: bool,
        cancellation: Option<&PluginCancellationToken>,
    ) -> Result<FileLock> {
        self.private_locks
            .append(OsStr::new(name), b"")
            .with_context(|| format!("failed to prepare plugin lock {name}"))?;
        let file = self
            .private_locks
            .open_regular_file(OsStr::new(name))
            .with_context(|| format!("failed to open plugin lock {name}"))?;
        loop {
            if let Some(cancellation) = cancellation {
                cancellation.check()?;
            }
            let result = if shared {
                FileExt::try_lock_shared(&file)
            } else {
                FileExt::try_lock_exclusive(&file)
            };
            match result {
                Ok(()) => return Ok(FileLock { file }),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    if Instant::now() >= deadline {
                        bail!("timed out waiting for plugin lock {name}");
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to acquire plugin lock {name}"));
                }
            }
        }
    }

    fn persist_marker(&self, marker: &TransactionMarker) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(marker)
            .context("failed to serialize plugin transaction marker")?;
        self.private_transactions
            .atomic_replace(OsStr::new(&marker.file_name()), &bytes)
            .context("failed to persist plugin transaction marker")
    }

    fn recover_locked(&self, plugin_id: &PluginId, deadline: Instant) -> Result<()> {
        if let Some(marker) = self.load_marker(plugin_id)? {
            self.recover_marker(&marker, deadline)?;
        }
        Ok(())
    }

    fn recover_all(&self) -> Result<()> {
        let mut entries = fs::read_dir(self.root.join(TRANSACTIONS_DIRECTORY))
            .context("failed to enumerate plugin transaction markers")?
            .collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let metadata = entry
                .metadata()
                .context("failed to inspect plugin transaction marker")?;
            if !metadata.is_file() {
                bail!(
                    "plugin transaction directory contains a non-file entry: {}",
                    entry.path().display()
                );
            }
            let file_name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow!("plugin transaction marker name is not UTF-8"))?;
            let encoded_id = file_name
                .strip_suffix(".json")
                .context("plugin transaction marker has an unexpected extension")?;
            let plugin_id: PluginId = encoded_id
                .parse()
                .context("plugin transaction marker has an invalid plugin id")?;
            let deadline = Instant::now() + self.operation_timeout;
            let _lock = self.acquire_lock(&plugin_lock_name(&plugin_id), deadline)?;
            self.recover_locked(&plugin_id, deadline)?;
        }
        Ok(())
    }

    fn cleanup_orphaned_transaction_directories(
        &self,
        now: SystemTime,
        ttl: Duration,
    ) -> Result<()> {
        for directory in [STAGING_DIRECTORY, BACKUPS_DIRECTORY] {
            let root = self.root.join(directory);
            let mut entries = fs::read_dir(&root)
                .with_context(|| format!("failed to enumerate plugin {directory} directory"))?
                .collect::<std::io::Result<Vec<_>>>()?;
            entries.sort_by_key(fs::DirEntry::file_name);
            for entry in entries {
                let name = match entry.file_name().into_string() {
                    Ok(name)
                        if name.len() == 32
                            && name.chars().all(|character| character.is_ascii_hexdigit()) =>
                    {
                        name
                    }
                    _ => continue,
                };
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path)?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    continue;
                }
                let stale = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age > ttl);
                if !stale {
                    continue;
                }
                let marker_is_active = fs::read_dir(self.root.join(TRANSACTIONS_DIRECTORY))?
                    .filter_map(|entry| entry.ok())
                    .filter_map(|marker| fs::read(marker.path()).ok())
                    .filter_map(|bytes| serde_json::from_slice::<TransactionMarker>(&bytes).ok())
                    .any(|marker| marker.operation_id == name);
                if !marker_is_active {
                    remove_owned_tree(&path).with_context(|| {
                        format!(
                            "failed to clean stale plugin transaction {}",
                            path.display()
                        )
                    })?;
                }
            }
        }
        Ok(())
    }

    fn load_marker(&self, plugin_id: &PluginId) -> Result<Option<TransactionMarker>> {
        let file_name = transaction_file_name(plugin_id);
        let path = self.root.join(TRANSACTIONS_DIRECTORY).join(&file_name);
        let mut file = match self
            .private_transactions
            .open_regular_file(OsStr::new(&file_name))
        {
            Ok(file) => file,
            Err(_error) if !path.exists() => return Ok(None),
            Err(error) => return Err(error).context("failed to open plugin transaction marker"),
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_TRANSACTION_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_TRANSACTION_BYTES {
            bail!("plugin transaction marker is too large");
        }
        let marker: TransactionMarker =
            serde_json::from_slice(&bytes).context("invalid plugin transaction marker")?;
        marker.validate(plugin_id)?;
        Ok(Some(marker))
    }

    fn recover_marker(&self, marker: &TransactionMarker, deadline: Instant) -> Result<()> {
        let state = self.read_state()?;
        let installed = state.installed.get(&marker.plugin_id.to_string());
        let committed = match marker.kind {
            TransactionKind::Install => installed.is_some_and(|record| {
                marker.new_relative.as_ref() == Some(&record.cache_relative_path)
            }),
            TransactionKind::Uninstall => installed.is_none(),
        };
        if committed {
            self.finish_transaction(marker)?;
            return Ok(());
        }

        if let Some(new_relative) = &marker.new_relative {
            let new_root = self.absolute(new_relative)?;
            if new_root.exists() {
                remove_owned_tree(&new_root)
                    .context("failed to remove uncommitted plugin activation")?;
            }
        }
        if let (Some(previous_relative), Some(backup_relative)) =
            (&marker.previous_relative, &marker.backup_relative)
        {
            let previous = self.absolute(previous_relative)?;
            let backup = self.absolute(backup_relative)?;
            if backup.exists() {
                if previous.exists() {
                    bail!(
                        "cannot restore plugin backup because previous target already exists: {}",
                        previous.display()
                    );
                }
                rename_owned_path(&backup, &previous)
                    .context("failed to restore previous plugin version")?;
            }
        }
        if let Some(staging_relative) = &marker.staging_relative {
            let staging = self.absolute(staging_relative)?;
            if staging.exists() {
                remove_owned_tree(&staging).context("failed to clean plugin staging directory")?;
            }
        }
        if Instant::now() >= deadline {
            bail!("plugin transaction recovery exceeded its deadline");
        }
        self.remove_marker(marker)
    }

    fn finish_transaction(&self, marker: &TransactionMarker) -> Result<()> {
        for relative in [&marker.backup_relative, &marker.staging_relative]
            .into_iter()
            .flatten()
        {
            let path = self.absolute(relative)?;
            if path.exists() {
                remove_owned_tree(&path).with_context(|| {
                    format!("failed to clean plugin transaction path {}", path.display())
                })?;
            }
        }
        self.remove_marker(marker)
    }

    fn remove_marker(&self, marker: &TransactionMarker) -> Result<()> {
        let path = self
            .root
            .join(TRANSACTIONS_DIRECTORY)
            .join(marker.file_name());
        match fs::remove_file(&path) {
            Ok(()) => sync_directory(path.parent().expect("marker has parent")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("failed to remove plugin transaction marker"),
        }
    }

    fn transaction_marker_path_exists_for_staging(&self, staging: &Path) -> Option<PathBuf> {
        let entries = fs::read_dir(self.root.join(TRANSACTIONS_DIRECTORY)).ok()?;
        for entry in entries.flatten() {
            let bytes = fs::read(entry.path()).ok()?;
            let marker: TransactionMarker = serde_json::from_slice(&bytes).ok()?;
            if marker.staging_relative.as_deref() == Some(staging) {
                return Some(entry.path());
            }
        }
        None
    }

    fn absolute(&self, relative: &Path) -> Result<PathBuf> {
        validate_owned_relative(relative)?;
        Ok(self.root.join(relative))
    }

    #[cfg(test)]
    fn set_fault(&self, fault: TransactionFault) {
        *self.fault.lock().unwrap() = Some(fault);
    }

    fn maybe_fail(&self, point: TransactionFault) -> Result<()> {
        #[cfg(test)]
        {
            let mut fault = self.fault.lock().unwrap();
            if fault.as_ref() == Some(&point) {
                *fault = None;
                bail!("injected plugin transaction failure at {point:?}");
            }
        }
        #[cfg(not(test))]
        let _ = point;
        Ok(())
    }

    fn maybe_cancel(&self, point: TransactionFault, cancellation: &PluginCancellationToken) {
        #[cfg(test)]
        {
            let mut fault = self.fault.lock().unwrap();
            if fault.as_ref() == Some(&point) {
                *fault = None;
                cancellation.cancel();
            }
        }
        #[cfg(not(test))]
        let _ = (point, cancellation);
    }
}

fn resolved_store_root(root: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        // PrivateDirectory validated each component and opened a regular absolute path.
        // Windows canonicalize rewrites that path into a verbatim namespace deliberately
        // rejected by the security layer, so do not feed it into later directory operations.
        Ok(root.to_path_buf())
    }
    #[cfg(not(windows))]
    {
        root.canonicalize()
            .with_context(|| format!("failed to resolve plugin store {}", root.display()))
    }
}

#[derive(Debug)]
struct FileLock {
    file: File,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransactionFault {
    AfterStage,
    AfterMarker,
    AfterBackup,
    CancelAfterBackup,
    AfterActivate,
    BeforeStatePersist,
    AfterStatePersist,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransactionKind {
    Install,
    Uninstall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionMarker {
    state_version: u32,
    operation_id: String,
    plugin_id: PluginId,
    kind: TransactionKind,
    staging_relative: Option<PathBuf>,
    new_relative: Option<PathBuf>,
    previous_relative: Option<PathBuf>,
    backup_relative: Option<PathBuf>,
}

impl TransactionMarker {
    fn file_name(&self) -> String {
        transaction_file_name(&self.plugin_id)
    }

    fn validate(&self, expected: &PluginId) -> Result<()> {
        if self.state_version != 1 || &self.plugin_id != expected {
            bail!("plugin transaction marker identity or version is invalid");
        }
        if self.operation_id.len() != 32
            || !self
                .operation_id
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            bail!("plugin transaction operation id is invalid");
        }
        for path in [
            &self.staging_relative,
            &self.new_relative,
            &self.previous_relative,
            &self.backup_relative,
        ]
        .into_iter()
        .flatten()
        {
            validate_owned_relative(path)?;
        }
        if let Some(path) = &self.staging_relative
            && path != &Path::new(STAGING_DIRECTORY).join(&self.operation_id)
        {
            bail!("plugin transaction staging path is outside its operation namespace");
        }
        if let Some(path) = &self.backup_relative
            && path != &Path::new(BACKUPS_DIRECTORY).join(&self.operation_id)
        {
            bail!("plugin transaction backup path is outside its operation namespace");
        }
        let cache_prefix = Path::new(CACHE_DIRECTORY)
            .join(self.plugin_id.marketplace_name())
            .join(self.plugin_id.plugin_name());
        for path in [&self.new_relative, &self.previous_relative]
            .into_iter()
            .flatten()
        {
            if !path.starts_with(&cache_prefix) {
                bail!("plugin transaction cache path is outside its plugin namespace");
            }
        }
        Ok(())
    }
}

fn manifest_identity_name(manifest: &crate::PluginManifest) -> Result<&str> {
    manifest
        .id
        .as_deref()
        .unwrap_or(&manifest.name)
        .split_once('@')
        .map(|_| ())
        .map_or(Ok(()), |_| {
            Err(anyhow!("plugin manifest identity may not contain '@'"))
        })?;
    let name = manifest.id.as_deref().unwrap_or(&manifest.name);
    PluginId::new(name, "validation")?;
    Ok(name)
}

fn version_lock_name(operation_id: &str) -> Result<String> {
    if operation_id.len() != 32
        || !operation_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        bail!("plugin version operation id is invalid");
    }
    Ok(format!("version-{operation_id}.lock"))
}

fn plugin_lock_name(plugin_id: &PluginId) -> String {
    format!("{plugin_id}.lock")
}

fn transaction_file_name(plugin_id: &PluginId) -> String {
    format!("{plugin_id}.json")
}

fn validate_owned_relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        bail!("plugin store transaction path must be non-empty and relative");
    }
    if !path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        bail!("plugin store transaction path contains an unsafe component");
    }
    Ok(())
}

fn remove_owned_tree(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect owned plugin path {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!(
            "owned plugin tree is not an ordinary directory: {}",
            path.display()
        );
    }
    fs::remove_dir_all(path)
        .with_context(|| format!("failed to remove owned plugin tree {}", path.display()))
}

#[cfg(target_os = "linux")]
fn rename_owned_path(source: &Path, destination: &Path) -> Result<()> {
    use nix::fcntl::{OFlag, OpenHow, ResolveFlag, openat2, renameat};
    use std::ffi::OsString;

    fn open_parent(path: &Path) -> Result<(std::os::fd::OwnedFd, OsString)> {
        let parent = path
            .parent()
            .context("plugin transaction path has no parent")?;
        let name = path
            .file_name()
            .context("plugin transaction path has no file name")?
            .to_os_string();
        let relative = parent
            .strip_prefix("/")
            .context("plugin transaction parent is not absolute")?;
        let root = File::open("/")?;
        let directory = openat2(
            &root,
            relative,
            OpenHow::new()
                .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
                .resolve(
                    ResolveFlag::RESOLVE_BENEATH
                        | ResolveFlag::RESOLVE_NO_SYMLINKS
                        | ResolveFlag::RESOLVE_NO_MAGICLINKS,
                ),
        )
        .map_err(std::io::Error::from)?;
        Ok((directory, name))
    }

    let (source_parent, source_name) = open_parent(source)?;
    let (destination_parent, destination_name) = open_parent(destination)?;
    renameat(
        &source_parent,
        source_name.as_os_str(),
        &destination_parent,
        destination_name.as_os_str(),
    )
    .map_err(std::io::Error::from)
    .with_context(|| {
        format!(
            "failed to rename {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    File::from(source_parent).sync_all()?;
    File::from(destination_parent).sync_all()?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn rename_owned_path(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination).with_context(|| {
        format!(
            "failed to rename {} to {}",
            source.display(),
            destination.display()
        )
    })
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_plugin(root: &Path, version: &str, payload: &str) {
        std::fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        std::fs::write(
            root.join(".codex-plugin/plugin.json"),
            serde_json::json!({
                "name": "demo",
                "version": version,
                "description": "managed fixture"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(root.join("payload.txt"), payload).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_store_keeps_the_validated_root_out_of_verbatim_namespace() {
        use std::path::{Component, Prefix};

        let temp = TempDir::new().unwrap();
        let requested = temp.path().join("plugin-store");
        let store = PluginStore::open(&requested).unwrap();

        assert_eq!(store.root(), requested);
        assert!(!matches!(
            store.root().components().next(),
            Some(Component::Prefix(prefix))
                if matches!(
                    prefix.kind(),
                    Prefix::Verbatim(_)
                        | Prefix::VerbatimDisk(_)
                        | Prefix::VerbatimUNC(_, _)
                )
        ));
        for directory in [
            LOCKS_DIRECTORY,
            CACHE_DIRECTORY,
            DATA_DIRECTORY,
            STAGING_DIRECTORY,
            BACKUPS_DIRECTORY,
            TRANSACTIONS_DIRECTORY,
        ] {
            assert!(store.root().join(directory).is_dir(), "{directory}");
        }
    }

    #[test]
    fn live_snapshots_keep_old_versions_through_update_and_uninstall_until_released() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let root = temp.path().join("store");
        let store = PluginStore::open(&root).unwrap();
        let first = store.install_local(&source, "local").unwrap();
        let (_, first_lease) = store.snapshot_with_leases().unwrap();
        write_plugin(&source, "2.0.0", "two");
        let second = store.install_local(&source, "local").unwrap();
        assert_eq!(
            fs::read_to_string(first.root(&root).join("payload.txt")).unwrap(),
            "one"
        );
        assert_eq!(
            fs::read_to_string(second.root(&root).join("payload.txt")).unwrap(),
            "two"
        );
        let (_, second_lease) = store.snapshot_with_leases().unwrap();
        assert!(
            store
                .uninstall(&second.plugin_id, true)
                .unwrap_err()
                .to_string()
                .contains("busy")
        );
        assert!(store.uninstall(&second.plugin_id, false).unwrap());
        assert_eq!(store.cleanup_unused_versions().unwrap(), 0);
        assert!(first.root(&root).exists());
        assert!(second.root(&root).exists());
        drop(first_lease);
        assert_eq!(store.cleanup_unused_versions().unwrap(), 1);
        assert!(!first.root(&root).exists());
        assert!(second.root(&root).exists());
        drop(second_lease);
        PluginStore::open(&root).unwrap();
        assert!(!second.root(&root).exists());
    }

    #[test]
    fn failed_update_with_live_snapshot_does_not_move_or_destroy_previous_version() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        let first = store.install_local(&source, "local").unwrap();
        let (_, _lease) = store.snapshot_with_leases().unwrap();
        write_plugin(&source, "2.0.0", "two");
        store.set_fault(TransactionFault::BeforeStatePersist);
        assert!(store.install_local(&source, "local").is_err());
        assert_eq!(store.read(&first.plugin_id).unwrap(), Some(first.clone()));
        assert_eq!(
            fs::read_to_string(first.root(store.root()).join("payload.txt")).unwrap(),
            "one"
        );
    }

    #[test]
    fn local_install_update_and_uninstall_preserve_data_by_default() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();

        let first = store.install_local(&source, "local").unwrap();
        assert_eq!(first.plugin_id.to_string(), "demo@local");
        assert_eq!(store.generation().unwrap(), 1);
        assert_eq!(
            std::fs::read_to_string(first.root(store.root()).join("payload.txt")).unwrap(),
            "one"
        );

        std::fs::write(source.join("payload.txt"), "two").unwrap();
        std::fs::write(
            source.join(".codex-plugin/plugin.json"),
            serde_json::json!({"name":"demo", "version":"2.0.0"}).to_string(),
        )
        .unwrap();
        let second = store.install_local(&source, "local").unwrap();
        assert_eq!(second.version.as_deref(), Some("2.0.0"));
        assert!(!first.root(store.root()).exists());
        assert_eq!(store.generation().unwrap(), 2);

        let data = store.data_root(&second.plugin_id).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("keep"), "yes").unwrap();
        assert!(store.uninstall(&second.plugin_id, false).unwrap());
        assert!(data.exists());
        assert!(store.read(&second.plugin_id).unwrap().is_none());
        assert_eq!(store.generation().unwrap(), 3);
    }

    #[test]
    fn failed_update_restores_the_previous_version() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        let first = store.install_local(&source, "local").unwrap();

        std::fs::write(source.join("payload.txt"), "two").unwrap();
        store.set_fault(TransactionFault::AfterActivate);
        assert!(store.install_local(&source, "local").is_err());

        let current = store.read(&first.plugin_id).unwrap().unwrap();
        assert_eq!(current.cache_relative_path, first.cache_relative_path);
        assert_eq!(
            std::fs::read_to_string(current.root(store.root()).join("payload.txt")).unwrap(),
            "one"
        );
        assert_eq!(store.generation().unwrap(), 1);
    }

    #[test]
    fn every_precommit_failure_boundary_keeps_previous_version_active() {
        for fault in [
            TransactionFault::AfterStage,
            TransactionFault::AfterMarker,
            TransactionFault::AfterBackup,
            TransactionFault::AfterActivate,
            TransactionFault::BeforeStatePersist,
        ] {
            let temp = TempDir::new().unwrap();
            let source = temp.path().join("source");
            write_plugin(&source, "1.0.0", "one");
            let store = PluginStore::open(&temp.path().join("store")).unwrap();
            let first = store.install_local(&source, "local").unwrap();
            std::fs::write(source.join("payload.txt"), "two").unwrap();

            store.set_fault(fault);
            assert!(
                store.install_local(&source, "local").is_err(),
                "fault {fault:?} did not fail"
            );

            let current = store.read(&first.plugin_id).unwrap().unwrap();
            assert_eq!(
                std::fs::read_to_string(current.root(store.root()).join("payload.txt")).unwrap(),
                "one",
                "fault {fault:?} did not preserve old content"
            );
            assert_eq!(store.generation().unwrap(), 1);
            assert!(
                std::fs::read_dir(store.root().join(TRANSACTIONS_DIRECTORY))
                    .unwrap()
                    .next()
                    .is_none()
            );
        }
    }

    #[test]
    fn startup_recovers_a_crash_after_previous_version_was_backed_up() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let root = temp.path().join("store");
        let store = PluginStore::open(&root).unwrap();
        let previous = store.install_local(&source, "local").unwrap();
        let operation_id = "a".repeat(32);
        let backup_relative = PathBuf::from(BACKUPS_DIRECTORY).join(&operation_id);
        let marker = TransactionMarker {
            state_version: 1,
            operation_id: operation_id.clone(),
            plugin_id: previous.plugin_id.clone(),
            kind: TransactionKind::Install,
            staging_relative: None,
            new_relative: Some(
                PathBuf::from(CACHE_DIRECTORY)
                    .join("local")
                    .join("demo")
                    .join(format!("install-{operation_id}")),
            ),
            previous_relative: Some(previous.cache_relative_path.clone()),
            backup_relative: Some(backup_relative.clone()),
        };
        store.persist_marker(&marker).unwrap();
        rename_owned_path(
            &previous.root(store.root()),
            &store.absolute(&backup_relative).unwrap(),
        )
        .unwrap();
        drop(store);

        let reopened = PluginStore::open(&root).unwrap();

        let current = reopened.read(&previous.plugin_id).unwrap().unwrap();
        assert_eq!(current.cache_relative_path, previous.cache_relative_path);
        assert!(current.root(reopened.root()).is_dir());
        assert!(
            std::fs::read_dir(reopened.root().join(TRANSACTIONS_DIRECTORY))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn postcommit_failure_reports_success_after_durable_state_is_visible() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        store.install_local(&source, "local").unwrap();
        std::fs::write(source.join("payload.txt"), "two").unwrap();
        store.set_fault(TransactionFault::AfterStatePersist);

        let updated = store.install_local(&source, "local").unwrap();

        assert_eq!(
            std::fs::read_to_string(updated.root(store.root()).join("payload.txt")).unwrap(),
            "two"
        );
        assert_eq!(store.generation().unwrap(), 2);
        assert!(
            std::fs::read_dir(store.root().join(TRANSACTIONS_DIRECTORY))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn concurrent_updates_of_one_plugin_are_serialized_without_lost_state() {
        use std::sync::{Arc, Barrier};

        let temp = TempDir::new().unwrap();
        let source_one = temp.path().join("source-one");
        let source_two = temp.path().join("source-two");
        write_plugin(&source_one, "1.0.0", "one");
        write_plugin(&source_two, "2.0.0", "two");
        let store = Arc::new(PluginStore::open(&temp.path().join("store")).unwrap());
        let barrier = Arc::new(Barrier::new(3));
        let workers = [source_one, source_two]
            .into_iter()
            .map(|source| {
                let store = Arc::clone(&store);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    store.install_local(&source, "local").unwrap()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }

        let current = store.read(&"demo@local".parse().unwrap()).unwrap().unwrap();
        assert!(matches!(
            current.version.as_deref(),
            Some("1.0.0" | "2.0.0")
        ));
        assert_eq!(store.generation().unwrap(), 2);
        assert!(
            std::fs::read_dir(store.root().join(TRANSACTIONS_DIRECTORY))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn failed_uninstall_restores_plugin_before_returning_error() {
        for fault in [
            TransactionFault::AfterMarker,
            TransactionFault::AfterBackup,
            TransactionFault::BeforeStatePersist,
        ] {
            let temp = TempDir::new().unwrap();
            let source = temp.path().join("source");
            write_plugin(&source, "1.0.0", "one");
            let store = PluginStore::open(&temp.path().join("store")).unwrap();
            let record = store.install_local(&source, "local").unwrap();

            store.set_fault(fault);
            assert!(store.uninstall(&record.plugin_id, false).is_err());

            let current = store.read(&record.plugin_id).unwrap().unwrap();
            assert!(current.root(store.root()).is_dir());
            assert_eq!(store.generation().unwrap(), 1);
        }
    }

    #[test]
    fn cancellation_after_backup_rolls_back_before_returning() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        let first = store.install_local(&source, "local").unwrap();
        std::fs::write(source.join("payload.txt"), "two").unwrap();
        let cancellation = PluginCancellationToken::default();
        store.set_fault(TransactionFault::CancelAfterBackup);

        let error = store
            .install_local_with_cancellation(&source, "local", &cancellation)
            .unwrap_err();

        assert!(format!("{error:#}").contains("cancelled"));
        let current = store.read(&first.plugin_id).unwrap().unwrap();
        assert_eq!(current.cache_relative_path, first.cache_relative_path);
        assert_eq!(
            std::fs::read_to_string(current.root(store.root()).join("payload.txt")).unwrap(),
            "one"
        );
        assert_eq!(store.generation().unwrap(), 1);
    }

    #[test]
    fn explicit_purge_removes_retained_plugin_data() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        let record = store.install_local(&source, "local").unwrap();
        let data = store.data_root(&record.plugin_id).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("state"), "private").unwrap();

        assert!(store.uninstall(&record.plugin_id, true).unwrap());

        assert!(!data.exists());
    }

    #[test]
    fn plugin_lock_wait_consumes_the_operation_deadline() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store"))
            .unwrap()
            .with_operation_timeout(Duration::from_millis(30));
        let plugin_id: PluginId = "demo@local".parse().unwrap();
        let held = store
            .acquire_lock(
                &plugin_lock_name(&plugin_id),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();

        let started = Instant::now();
        let error = store.install_local(&source, "local").unwrap_err();
        drop(held);

        assert!(error.to_string().contains("timed out waiting"));
        assert!(started.elapsed() >= Duration::from_millis(20));
    }

    #[test]
    fn orphan_cleanup_only_removes_stale_owned_transaction_names() {
        let temp = TempDir::new().unwrap();
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        let owned = store.root().join(STAGING_DIRECTORY).join("b".repeat(32));
        let unknown = store.root().join(STAGING_DIRECTORY).join("keep-me");
        std::fs::create_dir(&owned).unwrap();
        std::fs::create_dir(&unknown).unwrap();
        std::thread::sleep(Duration::from_millis(2));

        store
            .cleanup_orphaned_transaction_directories(SystemTime::now(), Duration::ZERO)
            .unwrap();

        assert!(!owned.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn generation_can_be_published_after_an_external_policy_change() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        write_plugin(&source, "1.0.0", "one");
        let store = PluginStore::open(&temp.path().join("store")).unwrap();
        let record = store.install_local(&source, "local").unwrap();

        assert_eq!(store.bump_generation().unwrap(), 2);
        assert_eq!(store.generation().unwrap(), 2);
        assert_eq!(
            store
                .read(&record.plugin_id)
                .unwrap()
                .unwrap()
                .enabled_by_default,
            record.enabled_by_default
        );
    }
}
