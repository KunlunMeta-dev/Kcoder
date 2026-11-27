//! The registered Electron HTTP-cache leaf, owned by the offline coordinator.
use super::StorageCoordinator;
use crate::{PrivateDirectory, PrivateEntryHandle};
use anyhow::{Context, Result, ensure};
use kcoder_types::{
    STORAGE_BROWSER_CACHE_RECEIPT_VERSION, StorageBrowserCacheReceipt, StorageBrowserCacheSource,
    StorageBrowserCacheSourceKind as Kind, StorageMigrationPlan, StorageMigrationReceipt,
};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    path::{Path, PathBuf},
};

pub const BROWSER_CACHE_OWNER: &str = "electron-browser-cache";
pub const DESKTOP_BROWSER_PARTITION: &str = "persist:kcoder-studio-desktop";
/// Chromium's partition/LevelDB suffix must still fit the Windows path budget.
pub const WINDOWS_DESKTOP_ROOT_MAX_UTF16: usize = 180;
const PARTITION_NAME: &str = "kcoder-studio-desktop";
const CACHE: &str = "Cache";

pub fn validate_desktop_profile_path(path: &Path) -> Result<()> {
    if cfg!(windows) {
        let text = path
            .to_str()
            .context("STORAGE_BROWSER_CACHE_PATH_INVALID")?;
        let text = text
            .strip_prefix(r"\\?\")
            .or_else(|| text.strip_prefix(r"\??\"))
            .unwrap_or(text);
        ensure!(
            text.encode_utf16().count() <= WINDOWS_DESKTOP_ROOT_MAX_UTF16,
            "STORAGE_BROWSER_PROFILE_PATH_TOO_LONG"
        );
    }
    Ok(())
}

#[path = "browser_cache_relocation.rs"]
mod relocation;
pub use relocation::{
    browser_cache_copy_exclusions, prepare_browser_cache_target,
    validate_browser_cache_source_inventory,
};

#[derive(Debug)]
struct Paths {
    source_partition: PathBuf,
    partition: PathBuf,
    http: PathBuf,
    previous_http: PathBuf,
    prepared: String,
    retained: String,
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn path_key(path: &Path) -> Result<PathBuf> {
    #[cfg(windows)]
    let normalized = {
        let text = path
            .to_str()
            .context("STORAGE_BROWSER_CACHE_PATH_INVALID")?;
        let text = text
            .strip_prefix(r"\\?\")
            .or_else(|| text.strip_prefix(r"\??\"))
            .unwrap_or(text);
        PathBuf::from(text.to_lowercase())
    };
    #[cfg(not(windows))]
    let normalized = path.to_owned();
    super::resolve::absolute(&normalized)
}

fn http_target(cache: &Path) -> PathBuf {
    cache
        .join("browser-cache")
        .join("desktop")
        .join(PARTITION_NAME)
        .join("http")
}

fn paths(plan: &StorageMigrationPlan) -> Result<Paths> {
    ensure!(
        super::resolve::valid_operation_id(&plan.operation_id),
        "STORAGE_OPERATION_INVALID"
    );
    let desktop = plan.target.data_root.join("studio").join("desktop");
    if cfg!(windows)
        && (matches!(
            plan.launch_intent,
            kcoder_types::StorageLaunchIntent::Desktop
        ) || plan
            .components
            .iter()
            .any(|component| component.domain == "desktop")
            || plan
                .from
                .desktop_root
                .join("Partitions")
                .join(PARTITION_NAME)
                .try_exists()?)
    {
        validate_desktop_profile_path(&desktop)?;
    }
    let source_partition = plan
        .from
        .desktop_root
        .join("Partitions")
        .join(PARTITION_NAME);
    let partition = desktop.join("Partitions").join(PARTITION_NAME);
    let http = http_target(&plan.target.cache_root);
    let target = path_key(&http)?;
    for partition in [&source_partition, &partition] {
        let slot = path_key(&partition.join(CACHE))?;
        ensure!(
            !slot.starts_with(&target) && !target.starts_with(&slot),
            "STORAGE_BROWSER_CACHE_PATH_OVERLAP"
        );
    }
    Ok(Paths {
        source_partition,
        partition,
        http,
        previous_http: http_target(&plan.from.cache_root),
        prepared: format!("Cache.prepared-{}", plan.operation_id),
        retained: format!("Cache.retained-{}", plan.operation_id),
    })
}

fn open_partition(plan: &StorageMigrationPlan) -> Result<Option<PrivateDirectory>> {
    open_partition_in(
        &PrivateDirectory::open_existing(&plan.target.data_root)?,
        &PathBuf::from("studio")
            .join("desktop")
            .join("Partitions")
            .join(PARTITION_NAME),
    )
}

fn open_source_partition(plan: &StorageMigrationPlan) -> Result<Option<PrivateDirectory>> {
    let root = match PrivateDirectory::open_existing(&plan.from.desktop_root) {
        Ok(root) => root,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    open_partition_in(&root, &PathBuf::from("Partitions").join(PARTITION_NAME))
}

fn open_partition_in(root: &PrivateDirectory, relative: &Path) -> Result<Option<PrivateDirectory>> {
    let mut current: Option<PrivateDirectory> = None;
    for component in relative.components() {
        let std::path::Component::Normal(name) = component else {
            anyhow::bail!("STORAGE_BROWSER_CACHE_LAYOUT_UNSUPPORTED");
        };
        let parent = current.as_ref().unwrap_or(root);
        let child = match parent.open_entry_handle(name) {
            Ok(entry) => entry.open_child_directory()?,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        current = Some(child);
    }
    Ok(current)
}

fn relocated(plan: &StorageMigrationPlan) -> Result<bool> {
    Ok(path_key(&plan.from.desktop_root)?
        != path_key(&plan.target.data_root.join("studio").join("desktop"))?)
}

fn same_cache(plan: &StorageMigrationPlan) -> Result<bool> {
    Ok(path_key(&plan.from.cache_root)? == path_key(&plan.target.cache_root)?)
}

fn entry<'a>(parent: &'a PrivateDirectory, name: &str) -> Result<Option<PrivateEntryHandle<'a>>> {
    match parent.open_entry_handle(OsStr::new(name)) {
        Ok(entry) => Ok(Some(entry)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn resolved_target(entry: &PrivateEntryHandle<'_>, paths: &Paths) -> Result<PathBuf> {
    resolved_target_at(entry, &paths.partition)
}

fn resolved_target_at(entry: &PrivateEntryHandle<'_>, partition: &Path) -> Result<PathBuf> {
    let target = entry.directory_link_target()?;
    #[cfg(windows)]
    {
        let _ = partition;
        path_key(&target)
    }
    #[cfg(not(windows))]
    {
        path_key(&if target.is_absolute() {
            target
        } else {
            partition.join(target)
        })
    }
}

fn source_fact(
    source: &PrivateEntryHandle<'_>,
    paths: &Paths,
) -> Result<StorageBrowserCacheSource> {
    let fact = entry_fact(source, &paths.source_partition)?;
    if let Some(target) = &fact.target {
        ensure!(
            target == &path_key(&paths.previous_http)?,
            "STORAGE_BROWSER_CACHE_LINK_MISMATCH"
        );
    }
    Ok(fact)
}

fn entry_fact(
    source: &PrivateEntryHandle<'_>,
    partition: &Path,
) -> Result<StorageBrowserCacheSource> {
    let (kind, target) = if source.metadata().file_type().is_symlink() {
        (
            Kind::DirectoryLink,
            Some(resolved_target_at(source, partition)?),
        )
    } else {
        ensure!(
            source.metadata().is_dir(),
            "STORAGE_BROWSER_CACHE_ENTRY_UNSUPPORTED"
        );
        (Kind::Directory, None)
    };
    Ok(StorageBrowserCacheSource {
        kind,
        identity: source.identity()?,
        target,
    })
}

fn create_http(plan: &StorageMigrationPlan) -> Result<PrivateDirectory> {
    let mut target = PrivateDirectory::open_config_root(&plan.target.cache_root)?;
    for name in ["browser-cache", "desktop", PARTITION_NAME, "http"] {
        target = target.open_child(OsStr::new(name), true)?;
    }
    Ok(target)
}

fn valid_identity(identity: &str) -> bool {
    !identity.is_empty() && identity.len() <= 512
}

fn validate_owner(
    plan: &StorageMigrationPlan,
    owner: &StorageBrowserCacheReceipt,
) -> Result<Paths> {
    let paths = paths(plan)?;
    let relocated = relocated(plan)?;
    ensure!(
        owner.version == STORAGE_BROWSER_CACHE_RECEIPT_VERSION
            && owner.operation_id == plan.operation_id
            && valid_identity(&owner.partition_identity)
            && [
                &owner.target_partition_identity,
                &owner.http_target_identity,
                &owner.prepared_link_identity,
                &owner.retained_entry_identity,
                &owner.published_link_identity,
            ]
            .into_iter()
            .flatten()
            .all(|identity| valid_identity(identity)),
        "STORAGE_BROWSER_CACHE_RECEIPT_INVALID"
    );
    if let Some(source) = &owner.source {
        ensure!(
            valid_identity(&source.identity)
                && Some(&source.identity) != owner.prepared_link_identity.as_ref(),
            "STORAGE_BROWSER_CACHE_RECEIPT_INVALID"
        );
        match (source.kind, &source.target) {
            (Kind::Directory, None) => {}
            (Kind::DirectoryLink, Some(target)) => ensure!(
                path_key(target)? == path_key(&paths.previous_http)?,
                "STORAGE_BROWSER_CACHE_RECEIPT_INVALID"
            ),
            _ => anyhow::bail!("STORAGE_BROWSER_CACHE_RECEIPT_INVALID"),
        }
    }
    ensure!(
        owner
            .retained_entry_identity
            .as_ref()
            .is_none_or(|identity| owner
                .source
                .as_ref()
                .is_some_and(|source| &source.identity == identity))
            && owner
                .published_link_identity
                .as_ref()
                .is_none_or(|identity| Some(identity) == owner.prepared_link_identity.as_ref())
            && (!relocated || owner.retained_entry_identity.is_none())
            && (relocated || owner.target_partition_identity.is_none())
            && (owner.http_target_identity.is_some() == owner.prepared_link_identity.is_some())
            && (if relocated {
                owner.target_partition_identity.is_some() == owner.prepared_link_identity.is_some()
            } else {
                owner.prepared_link_identity.is_some()
            }),
        "STORAGE_BROWSER_CACHE_RECEIPT_INVALID"
    );
    relocation::validate_retained_sources(owner)?;
    Ok(paths)
}

/// Decode only this fixed domain; the enclosing coordinator owns receipt integrity.
pub fn browser_cache_owner_receipt(
    receipt: &StorageMigrationReceipt,
) -> Result<Option<StorageBrowserCacheReceipt>> {
    receipt
        .owner_receipts
        .get(BROWSER_CACHE_OWNER)
        .map(|value| {
            let owner = serde_json::from_value(value.clone())
                .context("STORAGE_BROWSER_CACHE_RECEIPT_INVALID")?;
            validate_owner(&receipt.plan, &owner)?;
            Ok(owner)
        })
        .transpose()
}

fn verify_handles(
    plan: &StorageMigrationPlan,
    owner: &StorageBrowserCacheReceipt,
) -> Result<(PrivateDirectory, PrivateDirectory)> {
    validate_owner(plan, owner)?;
    let partition = open_partition(plan)?.context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    let target = verify_target_namespace(plan).context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    ensure!(
        partition.directory_identity()?
            == owner
                .target_partition_identity
                .as_ref()
                .unwrap_or(&owner.partition_identity)
                .as_str()
            && Some(target.directory_identity()?.as_str()) == owner.http_target_identity.as_deref(),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    if !relocated(plan)? {
        let paths = paths(plan)?;
        relocation::verify_retained_sources(
            &partition,
            &paths.source_partition,
            &owner.retained_sources,
        )?;
    }
    Ok((partition, target))
}

fn only_children(directory: &PrivateDirectory, allowed: &[&str]) -> Result<()> {
    ensure!(
        directory
            .entry_names_bounded(allowed.len() + 1)?
            .iter()
            .all(|name| allowed.iter().any(|allowed| name == OsStr::new(allowed))),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    Ok(())
}

// This check belongs to stopped preparation/verification, before Chromium can
// generate payload. No recursive walk or hashing is needed for the empty target.
// Code cache is prepared by the normal Electron startup after operation closure.
fn verify_target_namespace(plan: &StorageMigrationPlan) -> Result<PrivateDirectory> {
    let root = PrivateDirectory::open_existing(&plan.target.cache_root)?;
    if same_cache(plan)? {
        let mut parent = root;
        for name in ["browser-cache", "desktop", PARTITION_NAME, "http"] {
            parent = parent.open_child(OsStr::new(name), false)?;
        }
        return Ok(parent);
    }
    only_children(
        &root,
        &[
            super::writers::WRITERS,
            super::writers::SECONDARY,
            "browser-cache",
        ],
    )?;
    for name in [super::writers::WRITERS, super::writers::SECONDARY] {
        if entry(&root, name)?.is_some() {
            ensure!(
                root.open_single_link_regular_file(OsStr::new(name))?
                    .metadata()?
                    .len()
                    == 0,
                "STORAGE_BROWSER_CACHE_UNCONFIRMED"
            );
        }
    }
    let browser = root.open_child(OsStr::new("browser-cache"), false)?;
    only_children(&browser, &["desktop"])?;
    let desktop = browser.open_child(OsStr::new("desktop"), false)?;
    only_children(&desktop, &[PARTITION_NAME])?;
    let partition = desktop.open_child(OsStr::new(PARTITION_NAME), false)?;
    only_children(&partition, &["http"])?;
    let http = partition.open_child(OsStr::new("http"), false)?;
    ensure!(
        http.entry_names_bounded(1)?.is_empty(),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    Ok(http)
}

/// Validate the exact journaled target before commit or during phase recovery.
/// It does not claim that a prepared link was already published.
pub fn verify_browser_cache_target(
    plan: &StorageMigrationPlan,
    owner: &StorageBrowserCacheReceipt,
) -> Result<()> {
    validate_owner(plan, owner)?;
    if relocated(plan)? {
        relocation::verify_source(plan, owner)?;
        if owner.target_partition_identity.is_none() {
            return Ok(());
        }
    }
    verify_handles(plan, owner)?;
    Ok(())
}

fn preview_source(
    plan: &StorageMigrationPlan,
    paths: &Paths,
) -> Result<Option<(PrivateDirectory, Option<StorageBrowserCacheSource>)>> {
    let Some(partition) = open_source_partition(plan)? else {
        return Ok(None);
    };
    let source = entry(&partition, CACHE)?
        .map(|source| source_fact(&source, paths))
        .transpose()?;
    ensure!(
        entry(&partition, &paths.prepared)?.is_none()
            && entry(&partition, &paths.retained)?.is_none(),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    Ok(Some((partition, source)))
}

/// Builder preview: no creation, permission repair, locks, migration or writes.
pub fn preview_browser_cache(plan: &StorageMigrationPlan) -> Result<()> {
    let paths = paths(plan)?;
    preview_source(plan, &paths)?;
    Ok(())
}

fn require_link(
    parent: &PrivateDirectory,
    name: &str,
    identity: &str,
    paths: &Paths,
) -> Result<()> {
    let link = entry(parent, name)?.context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    ensure!(
        link.identity()? == identity && resolved_target(&link, paths)? == path_key(&paths.http)?,
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    Ok(())
}

/// Prepare only an existing registered partition. Persist this returned fact in
/// the original operation receipt before apply; orphan names are never adopted.
pub fn prepare_browser_cache(
    coordinator: &mut StorageCoordinator,
    id: &str,
) -> Result<Option<StorageBrowserCacheReceipt>> {
    let receipt = coordinator.assert_offline_owner(id)?;
    if let Some(owner) = browser_cache_owner_receipt(&receipt)? {
        return Ok(Some(owner));
    }
    let paths = paths(&receipt.plan)?;
    let Some((partition, source)) = preview_source(&receipt.plan, &paths)? else {
        return Ok(None);
    };
    let retained_sources = relocation::retained_sources(coordinator, &receipt.plan, &partition)?;
    if relocated(&receipt.plan)? {
        let owner = StorageBrowserCacheReceipt {
            version: STORAGE_BROWSER_CACHE_RECEIPT_VERSION,
            operation_id: id.to_owned(),
            partition_identity: partition.directory_identity()?,
            target_partition_identity: None,
            http_target_identity: None,
            source,
            prepared_link_identity: None,
            retained_entry_identity: None,
            published_link_identity: None,
            retained_sources,
        };
        relocation::verify_source(&receipt.plan, &owner)?;
        coordinator.assert_offline_owner(id)?;
        return Ok(Some(owner));
    }
    // Without a journaled target identity, even a familiar cache subtree is not
    // proof that it belongs to this operation. Do not adopt an interrupted tree.
    match PrivateDirectory::open_existing(&receipt.plan.target.cache_root) {
        Ok(root) => ensure!(
            super::writers::empty_except_fences(&root)?,
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        ),
        Err(error) if missing(&error) => {}
        Err(error) => return Err(error),
    }
    coordinator.assert_offline_owner(id)?;
    let target = create_http(&receipt.plan).context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    coordinator.assert_offline_owner(id)?;
    ensure!(
        open_partition(&receipt.plan)?
            .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?
            .directory_identity()?
            == partition.directory_identity()?,
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    ensure!(
        entry(&partition, CACHE)?
            .map(|source| source_fact(&source, &paths))
            .transpose()?
            == source,
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    let prepared = partition
        .create_directory_link(OsStr::new(&paths.prepared), &paths.http)
        .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    let owner = StorageBrowserCacheReceipt {
        version: STORAGE_BROWSER_CACHE_RECEIPT_VERSION,
        operation_id: id.to_owned(),
        partition_identity: partition.directory_identity()?,
        target_partition_identity: None,
        http_target_identity: Some(target.directory_identity()?),
        source,
        prepared_link_identity: Some(prepared.identity()?),
        retained_entry_identity: None,
        published_link_identity: None,
        retained_sources,
    };
    require_link(
        &partition,
        &paths.prepared,
        owner
            .prepared_link_identity
            .as_deref()
            .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?,
        &paths,
    )?;
    verify_handles(&receipt.plan, &owner)?;
    Ok(Some(owner))
}

/// Apply/reconcile only facts already persisted by the original coordinator.
/// Every old ordinary directory or known link is retained, never unlinked.
pub fn apply_browser_cache(
    coordinator: &mut StorageCoordinator,
    id: &str,
    owner: &StorageBrowserCacheReceipt,
) -> Result<StorageBrowserCacheReceipt> {
    let receipt = coordinator.assert_offline_owner(id)?;
    ensure!(
        browser_cache_owner_receipt(&receipt)?.as_ref() == Some(owner),
        "STORAGE_BROWSER_CACHE_RECEIPT_UNRECORDED"
    );
    let paths = validate_owner(&receipt.plan, owner)?;
    let (partition, _target) = verify_handles(&receipt.plan, owner)?;
    let prepared_identity = owner
        .prepared_link_identity
        .as_deref()
        .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    let mut completed = owner.clone();
    if relocated(&receipt.plan)? {
        relocation::verify_source(&receipt.plan, owner)?;
        ensure!(
            entry(&partition, &paths.retained)?.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    } else if let Some(source) = &owner.source {
        match entry(&partition, &paths.retained)? {
            Some(retained) => ensure!(
                source_fact(&retained, &paths)? == *source,
                "STORAGE_BROWSER_CACHE_UNCONFIRMED"
            ),
            None => {
                ensure!(
                    owner.retained_entry_identity.is_none(),
                    "STORAGE_BROWSER_CACHE_UNCONFIRMED"
                );
                require_link(&partition, &paths.prepared, prepared_identity, &paths)?;
                let original =
                    entry(&partition, CACHE)?.context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
                ensure!(
                    source_fact(&original, &paths)? == *source,
                    "STORAGE_BROWSER_CACHE_UNCONFIRMED"
                );
                coordinator.assert_offline_owner(id)?;
                verify_handles(&receipt.plan, owner)?;
                original
                    .rename_directory_entry_no_replace(OsStr::new(&paths.retained))
                    .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
                let retained = entry(&partition, &paths.retained)?
                    .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
                ensure!(
                    source_fact(&retained, &paths)? == *source,
                    "STORAGE_BROWSER_CACHE_UNCONFIRMED"
                );
            }
        }
        completed.retained_entry_identity = Some(source.identity.clone());
    } else {
        ensure!(
            entry(&partition, &paths.retained)?.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    }
    if let Some(published) = entry(&partition, CACHE)? {
        ensure!(
            published.identity()? == prepared_identity
                && resolved_target(&published, &paths)? == path_key(&paths.http)?
                && entry(&partition, &paths.prepared)?.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    } else {
        ensure!(
            owner.published_link_identity.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
        require_link(&partition, &paths.prepared, prepared_identity, &paths)?;
        let prepared =
            entry(&partition, &paths.prepared)?.context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
        coordinator.assert_offline_owner(id)?;
        verify_handles(&receipt.plan, owner)?;
        prepared
            .rename_directory_entry_no_replace(OsStr::new(CACHE))
            .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    }
    require_link(&partition, CACHE, prepared_identity, &paths)?;
    verify_handles(&receipt.plan, owner)?;
    completed.published_link_identity = Some(prepared_identity.to_owned());
    Ok(completed)
}

/// Dedicated target verification is read-only and never waits for its own lease.
pub fn verify_browser_cache(
    plan: &StorageMigrationPlan,
    owner: &StorageBrowserCacheReceipt,
) -> Result<()> {
    let paths = validate_owner(plan, owner)?;
    let prepared_identity = owner
        .prepared_link_identity
        .as_deref()
        .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    ensure!(
        owner.published_link_identity.as_deref() == Some(prepared_identity)
            && owner.retained_entry_identity.as_ref()
                == if relocated(plan)? {
                    None
                } else {
                    owner.source.as_ref().map(|source| &source.identity)
                },
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    let (partition, _target) = verify_handles(plan, owner)?;
    require_link(&partition, CACHE, prepared_identity, &paths)?;
    ensure!(
        entry(&partition, &paths.prepared)?.is_none(),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    if relocated(plan)? {
        relocation::verify_source(plan, owner)?;
        ensure!(
            entry(&partition, &paths.retained)?.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
        for retained in &owner.retained_sources {
            ensure!(
                entry(
                    &partition,
                    &format!("Cache.retained-{}", retained.operation_id)
                )?
                .is_none(),
                "STORAGE_BROWSER_CACHE_UNCONFIRMED"
            );
        }
    } else if let Some(source) = &owner.source {
        let retained =
            entry(&partition, &paths.retained)?.context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
        ensure!(
            source_fact(&retained, &paths)? == *source,
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    } else {
        ensure!(
            entry(&partition, &paths.retained)?.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    }
    Ok(())
}

/// Used when the operation recorded no desktop owner: an existing partition
/// cannot appear during migration and silently bypass cache relocation.
pub fn verify_no_browser_cache(plan: &StorageMigrationPlan) -> Result<()> {
    paths(plan)?;
    ensure!(
        open_source_partition(plan)?.is_none() && open_partition(plan)?.is_none(),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    Ok(())
}

#[cfg(test)]
#[path = "browser_cache_tests.rs"]
mod tests;
