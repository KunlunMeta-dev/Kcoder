//! Frozen source exclusions and final-path binding for a moved Desktop profile.
use super::*;
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageBrowserCacheRetainedSource, StorageMigrationDisposition,
};

const RETAINED_LIMIT: usize = 64;

pub(super) fn validate_retained_sources(owner: &StorageBrowserCacheReceipt) -> Result<()> {
    ensure!(
        owner.retained_sources.len() <= RETAINED_LIMIT,
        "STORAGE_BROWSER_CACHE_RECEIPT_INVALID"
    );
    let mut ids = BTreeSet::new();
    for retained in &owner.retained_sources {
        ensure!(
            super::super::resolve::valid_operation_id(&retained.operation_id)
                && retained.operation_id != owner.operation_id
                && ids.insert(&retained.operation_id)
                && valid_identity(&retained.source.identity),
            "STORAGE_BROWSER_CACHE_RECEIPT_INVALID"
        );
        match (&retained.source.kind, &retained.source.target) {
            (Kind::Directory, None) => {}
            (Kind::DirectoryLink, Some(target)) => {
                path_key(target)?;
            }
            _ => anyhow::bail!("STORAGE_BROWSER_CACHE_RECEIPT_INVALID"),
        }
    }
    Ok(())
}

pub(super) fn retained_sources(
    coordinator: &StorageCoordinator,
    plan: &StorageMigrationPlan,
    partition: &PrivateDirectory,
) -> Result<Vec<StorageBrowserCacheRetainedSource>> {
    let Some(selected) = plan.original.as_ref() else {
        return Ok(Vec::new());
    };
    let Some(id) = selected.operation_id.as_ref() else {
        return Ok(Vec::new());
    };
    let previous = coordinator.prior_operation_receipt(id)?;
    ensure!(
        previous.plan.operation_id == *id
            && previous.disposition == StorageMigrationDisposition::Complete
            && previous.plan.target == *selected,
        "STORAGE_BROWSER_CACHE_HISTORY_UNCONFIRMED"
    );
    let Some(owner) = browser_cache_owner_receipt(&previous)? else {
        return Ok(Vec::new());
    };
    let prepared = owner
        .prepared_link_identity
        .as_ref()
        .context("STORAGE_BROWSER_CACHE_HISTORY_UNCONFIRMED")?;
    ensure!(
        owner.published_link_identity.as_ref() == Some(prepared),
        "STORAGE_BROWSER_CACHE_HISTORY_UNCONFIRMED"
    );
    let moved = relocated(&previous.plan)?;
    let previous_partition = if moved {
        owner
            .target_partition_identity
            .as_ref()
            .context("STORAGE_BROWSER_CACHE_HISTORY_UNCONFIRMED")?
    } else {
        &owner.partition_identity
    };
    // A moved owner's flat list describes leaves left at its old root. Even
    // same-named entries at the published root have no omission authority.
    if previous_partition != &partition.directory_identity()? || moved {
        return Ok(Vec::new());
    }
    let mut candidates = owner.retained_sources;
    if let Some(source) = owner.source {
        ensure!(
            owner.retained_entry_identity.as_ref() == Some(&source.identity),
            "STORAGE_BROWSER_CACHE_HISTORY_UNCONFIRMED"
        );
        candidates.push(StorageBrowserCacheRetainedSource {
            operation_id: id.clone(),
            source,
        });
    }
    let paths = paths(plan)?;
    let mut retained = Vec::new();
    for candidate in candidates {
        let name = format!("Cache.retained-{}", candidate.operation_id);
        if let Some(current) = entry(partition, &name)? {
            // Historical facts never authorize a replacement. Unproved ordinary
            // directories remain persistent data and links fail in the copier.
            if entry_fact(&current, &paths.source_partition).ok().as_ref()
                == Some(&candidate.source)
            {
                retained.push(candidate);
            }
        }
    }
    ensure!(
        retained.len() <= RETAINED_LIMIT,
        "STORAGE_BROWSER_CACHE_HISTORY_UNCONFIRMED"
    );
    Ok(retained)
}

pub(super) fn verify_retained_sources(
    partition: &PrivateDirectory,
    partition_path: &Path,
    sources: &[StorageBrowserCacheRetainedSource],
) -> Result<()> {
    for retained in sources {
        let source = entry(
            partition,
            &format!("Cache.retained-{}", retained.operation_id),
        )?
        .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
        ensure!(
            entry_fact(&source, partition_path)? == retained.source,
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    }
    Ok(())
}

pub(super) fn verify_source(
    plan: &StorageMigrationPlan,
    owner: &StorageBrowserCacheReceipt,
) -> Result<()> {
    let paths = validate_owner(plan, owner)?;
    let partition = open_source_partition(plan)?.context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    ensure!(
        partition.directory_identity()? == owner.partition_identity
            && entry(&partition, CACHE)?
                .map(|source| source_fact(&source, &paths))
                .transpose()?
                == owner.source
            && entry(&partition, &paths.prepared)?.is_none()
            && entry(&partition, &paths.retained)?.is_none(),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    verify_retained_sources(&partition, &paths.source_partition, &owner.retained_sources)
}

fn desktop_component(
    plan: &StorageMigrationPlan,
) -> Result<(&kcoder_types::StorageMigrationComponent, PathBuf)> {
    ensure!(relocated(plan)?, "STORAGE_BROWSER_CACHE_LAYOUT_UNSUPPORTED");
    let paths = paths(plan)?;
    let source = path_key(&paths.source_partition)?;
    let destination = path_key(&paths.partition)?;
    let mut matched = None;
    for component in &plan.components {
        let (expected_source, expected_destination, relative) = match component.domain.as_str() {
            STORAGE_PERSISTENT_ROOT_DOMAIN => (
                plan.from.data_root.clone(),
                plan.target.data_root.clone(),
                PathBuf::from("studio").join("desktop"),
            ),
            "desktop" => (
                plan.from.desktop_root.clone(),
                plan.target.data_root.join("studio").join("desktop"),
                PathBuf::new(),
            ),
            _ => continue,
        };
        if path_key(&component.source)? != path_key(&expected_source)?
            || path_key(&component.destination)? != path_key(&expected_destination)?
        {
            continue;
        }
        let relative = relative.join("Partitions").join(PARTITION_NAME);
        if path_key(&component.source.join(&relative))? == source
            && path_key(&component.destination.join(&relative))? == destination
        {
            ensure!(
                matched.is_none(),
                "STORAGE_BROWSER_CACHE_LAYOUT_UNSUPPORTED"
            );
            matched = Some((component, relative));
        }
    }
    let (component, relative) = matched.context("STORAGE_DOMAIN_UNAVAILABLE")?;
    ensure!(
        plan.components
            .iter()
            .filter(|other| other.domain == component.domain)
            .count()
            == 1,
        "STORAGE_BROWSER_CACHE_LAYOUT_UNSUPPORTED"
    );
    Ok((component, relative))
}

fn relative_partition(plan: &StorageMigrationPlan, domain: &str) -> Result<PathBuf> {
    let (component, relative) = desktop_component(plan)?;
    ensure!(
        component.domain == domain,
        "STORAGE_BROWSER_CACHE_LAYOUT_UNSUPPORTED"
    );
    Ok(relative)
}

/// Exact owner-verified cache leaves only. Unknown names remain persistent data.
pub fn browser_cache_copy_exclusions(
    plan: &StorageMigrationPlan,
    owner: Option<&StorageBrowserCacheReceipt>,
    domain: &str,
) -> Result<BTreeSet<PathBuf>> {
    let partition = relative_partition(plan, domain)?;
    let mut exclusions = BTreeSet::new();
    if let Some(owner) = owner {
        verify_source(plan, owner)?;
        if owner.source.is_some() {
            exclusions.insert(partition.join(CACHE));
        }
        for retained in &owner.retained_sources {
            exclusions.insert(partition.join(format!("Cache.retained-{}", retained.operation_id)));
        }
    } else {
        ensure!(
            open_source_partition(plan)?.is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    }
    Ok(exclusions)
}

/// Check the copier's actual inventory, including native identities of excluded
/// leaves. A second inventory would leave a replacement gap before omission.
pub fn validate_browser_cache_source_inventory(
    plan: &StorageMigrationPlan,
    owner: Option<&StorageBrowserCacheReceipt>,
    domain: &str,
    inventory: &super::super::StorageTreeInventory,
) -> Result<()> {
    let partition = relative_partition(plan, domain)?;
    let exclusions = browser_cache_copy_exclusions(plan, owner, domain)?;
    let component = plan
        .components
        .iter()
        .find(|component| component.domain == domain)
        .context("STORAGE_DOMAIN_UNAVAILABLE")?;
    ensure!(
        inventory.root_identity == component.source_identity,
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    let find = |path: &Path| {
        inventory
            .entries
            .iter()
            .find(|entry| entry.relative_path == path)
    };
    let Some(owner) = owner else {
        ensure!(
            find(&partition).is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
        return Ok(());
    };
    let actual = find(&partition).context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    ensure!(
        actual.kind == super::super::StorageTreeEntryKind::Directory
            && actual.identity == owner.partition_identity
            && !actual.excluded,
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    let validate = |path: PathBuf, source: &StorageBrowserCacheSource| -> Result<()> {
        let actual = find(&path).context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
        let kind = match source.kind {
            Kind::Directory => super::super::StorageTreeEntryKind::Directory,
            Kind::DirectoryLink => super::super::StorageTreeEntryKind::Symlink,
        };
        ensure!(
            actual.excluded && actual.kind == kind && actual.identity == source.identity,
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
        Ok(())
    };
    if let Some(source) = &owner.source {
        validate(partition.join(CACHE), source)?;
    } else {
        ensure!(
            find(&partition.join(CACHE)).is_none(),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
    }
    for retained in &owner.retained_sources {
        validate(
            partition.join(format!("Cache.retained-{}", retained.operation_id)),
            &retained.source,
        )?;
    }
    // The coordinator owns excluded regular writer fences. No other owner may
    // silently turn an unknown partition directory/link into a cache omission.
    ensure!(
        inventory.entries.iter().all(|entry| !entry.excluded
            || !entry.relative_path.starts_with(&partition)
            || entry.kind == super::super::StorageTreeEntryKind::RegularFile
            || exclusions.contains(&entry.relative_path)),
        "STORAGE_BROWSER_CACHE_UNCONFIRMED"
    );
    Ok(())
}

/// Bind a frozen source receipt only after Native has published this operation's
/// original component. Missing receipts and unknown target entries are not adopted.
pub fn prepare_browser_cache_target(
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
    ensure!(
        relocated(&receipt.plan)?,
        "STORAGE_BROWSER_CACHE_LAYOUT_UNSUPPORTED"
    );
    verify_source(&receipt.plan, owner)?;
    let (component, relative) = desktop_component(&receipt.plan)?;
    let root = coordinator.open_published_component(id, &component.domain)?;
    let partition = open_partition_in(root.directory(), &relative)?
        .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    if owner.target_partition_identity.is_some() {
        verify_handles(&receipt.plan, owner)?;
        let identity = owner
            .prepared_link_identity
            .as_deref()
            .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
        let published = entry(&partition, CACHE)?.is_some();
        let prepared = entry(&partition, &paths.prepared)?.is_some();
        ensure!(
            published != prepared && (owner.published_link_identity.is_none() || published),
            "STORAGE_BROWSER_CACHE_UNCONFIRMED"
        );
        let name = if published { CACHE } else { &paths.prepared };
        require_link(&partition, name, identity, &paths)?;
        root.verify()?;
        return Ok(owner.clone());
    }
    ensure!(
        entry(&partition, CACHE)?.is_none()
            && entry(&partition, &paths.prepared)?.is_none()
            && entry(&partition, &paths.retained)?.is_none(),
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
    let http = if same_cache(&receipt.plan)? {
        create_http(&receipt.plan)?
    } else {
        match PrivateDirectory::open_existing(&receipt.plan.target.cache_root) {
            Ok(root) => ensure!(
                super::super::writers::empty_except_fences(&root)?,
                "STORAGE_BROWSER_CACHE_UNCONFIRMED"
            ),
            Err(error) if missing(&error) => {}
            Err(error) => return Err(error),
        }
        create_http(&receipt.plan)?
    };
    coordinator.assert_offline_owner(id)?;
    let prepared = partition
        .create_directory_link(OsStr::new(&paths.prepared), &paths.http)
        .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?;
    let mut bound = owner.clone();
    bound.target_partition_identity = Some(partition.directory_identity()?);
    bound.http_target_identity = Some(http.directory_identity()?);
    bound.prepared_link_identity = Some(prepared.identity()?);
    verify_source(&receipt.plan, &bound)?;
    verify_handles(&receipt.plan, &bound)?;
    root.verify()?;
    require_link(
        &partition,
        &paths.prepared,
        bound
            .prepared_link_identity
            .as_deref()
            .context("STORAGE_BROWSER_CACHE_UNCONFIRMED")?,
        &paths,
    )?;
    coordinator.assert_offline_owner(id)?;
    Ok(bound)
}
