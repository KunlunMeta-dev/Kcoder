//! Legacy startup composes the original Native and client owners in one offline operation.
use super::{
    storage_gateway_domains::{
        prepare_gateway_domains, relocate_gateway_domains, verify_gateway_domains,
    },
    storage_profile::record_browser_owner,
    storage_profile_operation::LocalStorageOperation,
};
use anyhow::{Context, Result, ensure};
use kcoder_config::{
    PrivateDirectory,
    storage::{
        StorageCoordinator, browser_cache, current_storage_paths, default_storage_location,
        execute_storage_operation_with_owner, inspect_storage_target,
        observe_published_storage_component, prepare_storage_plan_from_paths_with_owner,
        read_storage_location_record, read_storage_migration, storage_location_file,
    },
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLayout,
    StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase,
    StorageMigrationReceipt, StoragePaths,
};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    path::{Path, PathBuf},
};

#[path = "storage_legacy_registered.rs"]
mod registered;
#[path = "storage_legacy_sources.rs"]
mod sources;

pub(super) fn registered_legacy_sources(home: &Path) -> Result<Vec<PathBuf>> {
    let Some(source) = registered::read(home, true)? else {
        return Ok(Vec::new());
    };
    let mut roots = vec![source.native];
    roots.extend(source.gateway);
    Ok(roots)
}

/// Preview and execution resolve the same existing legacy sources as startup,
/// without first moving them to the default destination or creating a profile.
pub(super) fn legacy_storage_paths_for_plan(
    home: &Path,
    mut paths: StoragePaths,
) -> Result<StoragePaths> {
    if paths.layout != StorageLayout::Legacy || paths.externally_configured {
        return Ok(paths);
    }
    paths.desktop_root = dirs::config_dir()
        .context("STORAGE_HOME_UNAVAILABLE")?
        .join("kcoder-studio");
    let registration = registered::read(home, true)?;
    if let Some(source) = &registration {
        let default_native = home.join(".config/kcoder");
        if source.native != default_native {
            controls_only(&default_native, "STORAGE_LEGACY_SOURCE_CONFLICT")?;
        }
    }
    legacy_paths_with_registration(home, paths, registration.as_ref())
}

fn legacy_paths_with_registration(
    home: &Path,
    mut paths: StoragePaths,
    registration: Option<&registered::RegisteredSources>,
) -> Result<StoragePaths> {
    let native = home.join(".config/kcoder");
    paths.data_root = native.clone();
    paths.cache_root = native.join("tmp");
    paths.temporary_root = paths.cache_root.clone();
    if let Some(registration) = registration {
        // A registration without a Gateway owner has always used the Desktop root.
        paths.gateway_root = paths.desktop_root.clone();
        registered::apply(&mut paths, registration);
    } else {
        let standalone = home.join(".config/kcoder-studio");
        if paths.gateway_root != standalone && paths.gateway_root != paths.desktop_root {
            paths.gateway_root = paths.desktop_root.clone();
        }
        sources::select_unregistered_gateway(home, &mut paths)?;
    }
    Ok(paths)
}

const EMPTY_CONTROLS: &[&str] = &[
    "kcoder-storage-writers.lock",
    "kcoder-storage-instances.lock",
];

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn read_business_startup<T>(read: impl Fn() -> Result<T>) -> Result<T> {
    match read() {
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::PermissionDenied)
            }) =>
        {
            // Pure queries remain read-only. At the business entry only, wait
            // for the existing storage coordinator before rereading these
            // records; no permission or ACL repair is attempted.
            let home = dirs::home_dir().context("STORAGE_HOME_UNAVAILABLE")?;
            drop(StorageCoordinator::acquire(&home)?);
            read()
        }
        result => result,
    }
}

fn assert_deferred_source_paths(
    paths: &StoragePaths,
    receipt: &StorageMigrationReceipt,
) -> Result<()> {
    ensure!(
        receipt.disposition != Disposition::Deferred
            || paths.data_root == receipt.plan.from.data_root
                && paths.cache_root == receipt.plan.from.cache_root
                && paths.gateway_root == receipt.plan.from.gateway_root
                && paths.desktop_root == receipt.plan.from.desktop_root,
        "STORAGE_SELECTION_CHANGED"
    );
    Ok(())
}

fn assert_deferred_legacy_source_paths(
    home: &Path,
    paths: &StoragePaths,
    receipt: &StorageMigrationReceipt,
    registration: Option<&registered::RegisteredSources>,
) -> Result<()> {
    if receipt.disposition != Disposition::Deferred
        || receipt.plan.from.layout != StorageLayout::Legacy
    {
        return assert_deferred_source_paths(paths, receipt);
    }
    ensure!(
        !receipt.plan.from.externally_configured
            && receipt.plan.original == read_storage_location_record(&storage_location_file(home))?,
        "STORAGE_SELECTION_CHANGED"
    );

    // Legacy source overrides were only needed to make the original plan. Rebuild
    // them read-only from today's registry or unique-source classification before
    // admitting the retained source; never write a replacement registration.
    let observed = legacy_paths_with_registration(home, paths.clone(), registration)?;
    assert_deferred_source_paths(&observed, receipt)?;
    for component in &receipt.plan.components {
        ensure!(
            PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                == component.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
    }
    Ok(())
}

fn verify_deferred_source_paths(
    home: &Path,
    paths: &StoragePaths,
    receipt: &StorageMigrationReceipt,
) -> Result<()> {
    if receipt.disposition != Disposition::Deferred
        || receipt.plan.from.layout != StorageLayout::Legacy
    {
        return assert_deferred_source_paths(paths, receipt);
    }
    let mut base = paths.clone();
    base.desktop_root = dirs::config_dir()
        .context("STORAGE_HOME_UNAVAILABLE")?
        .join("kcoder-studio");
    let registration = registered::read(home, false)?;
    assert_deferred_legacy_source_paths(home, &base, receipt, registration.as_ref())
}

/// An empty client root may retain only the existing, ordinary empty fences.
/// Unknown names, links and nonempty controls require the full role-splitting owner.
fn controls_only(path: &Path, code: &'static str) -> Result<()> {
    let directory = match PrivateDirectory::open_existing(path) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok(()),
        Err(error) => return Err(error).context(code),
    };
    for name in directory.entry_names_bounded(EMPTY_CONTROLS.len() + 1)? {
        ensure!(
            EMPTY_CONTROLS
                .iter()
                .any(|control| name == OsStr::new(control)),
            "{code}"
        );
        ensure!(
            directory
                .open_single_link_regular_file(&name)?
                .metadata()?
                .len()
                == 0,
            "{code}"
        );
    }
    ensure!(
        PrivateDirectory::open_existing(path)?.directory_identity()?
            == directory.directory_identity()?,
        "STORAGE_SOURCE_CHANGED"
    );
    Ok(())
}

fn validate_client_roots(home: &Path, paths: &StoragePaths) -> Result<()> {
    let roots = BTreeSet::from([
        home.join(".config/kcoder-studio"),
        paths.gateway_root.clone(),
        paths.desktop_root.clone(),
        paths.data_root.join("studio/gateway"),
        paths.data_root.join("studio/desktop"),
    ]);
    for root in roots {
        controls_only(&root, "STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED")?;
    }
    Ok(())
}

/// Default Native data stays in place; registered recovery roots use the same copy owner.
pub(super) fn validate_legacy_native_operation(
    home: &Path,
    receipt: &StorageMigrationReceipt,
) -> Result<()> {
    let registration = registered::read(home, receipt.phase == Phase::Planned)?;
    validate_legacy_with_registration(home, receipt, registration.as_ref())
}

#[cfg(test)]
#[path = "storage_legacy_registered_copy_tests.rs"]
mod registered_copy_tests;

fn validate_legacy_with_registration(
    home: &Path,
    receipt: &StorageMigrationReceipt,
    registration: Option<&registered::RegisteredSources>,
) -> Result<()> {
    let plan = &receipt.plan;
    let component = plan
        .components
        .first()
        .context("STORAGE_PROFILE_COMPONENT_INVALID")?;
    let clients = &plan.components[1..];
    let default_native = home.join(".config/kcoder");
    let expected_native = registration
        .as_ref()
        .map_or(default_native.as_path(), |source| source.native.as_path());
    ensure!(
        plan.from.layout == StorageLayout::Legacy
            && !plan.from.externally_configured
            && plan.original.is_none()
            && plan.from.data_root == expected_native
            && plan.from.cache_root == plan.from.data_root.join("tmp")
            && plan.from.location_file.as_deref() == Some(storage_location_file(home).as_path())
            && component.domain == STORAGE_PERSISTENT_ROOT_DOMAIN
            && component.source == plan.from.data_root
            && component.destination == plan.target.data_root
            && plan.target_bindings.len() == 2
            && clients.len() <= 2,
        "STORAGE_LEGACY_NATIVE_LAYOUT_UNSUPPORTED"
    );
    if let Some(source) = &registration {
        let gateway = source.gateway.clone().unwrap_or(
            dirs::config_dir()
                .context("STORAGE_HOME_UNAVAILABLE")?
                .join("kcoder-studio"),
        );
        ensure!(
            plan.from.gateway_root == gateway,
            "STORAGE_LEGACY_SOURCE_CHANGED"
        );
    }
    ensure!(
        PrivateDirectory::open_existing(&component.source)?.directory_identity()?
            == component.source_identity,
        "STORAGE_SOURCE_CHANGED"
    );
    for target in [&plan.target.data_root, &plan.target.cache_root] {
        let binding = plan
            .target_bindings
            .iter()
            .find(|binding| &binding.path == target)
            .context("STORAGE_OPERATION_INVALID")?;
        ensure!(
            PrivateDirectory::open_existing(&binding.existing_ancestor)?.directory_identity()?
                == binding.ancestor_identity,
            "STORAGE_TARGET_CHANGED"
        );
        // Reopen any existing final path, without creating a cache directory.
        inspect_storage_target(target)?;
    }
    let native_in_place = component.source == component.destination;
    if clients.is_empty() && native_in_place {
        ensure!(
            receipt
                .owner_receipts
                .keys()
                .all(|name| name == "pending-persistent-root"),
            "STORAGE_LEGACY_NATIVE_LAYOUT_UNSUPPORTED"
        );
        validate_client_roots(home, &plan.from)?;
        return controls_only(&plan.target.cache_root, "STORAGE_TARGET_NOT_EMPTY");
    }
    let mut roles = BTreeSet::new();
    for client in clients {
        let source = match client.domain.as_str() {
            "gateway" => &plan.from.gateway_root,
            "desktop" => &plan.from.desktop_root,
            _ => anyhow::bail!("STORAGE_LEGACY_NATIVE_LAYOUT_UNSUPPORTED"),
        };
        ensure!(
            roles.insert(client.domain.as_str())
                && client.source == *source
                && client.destination == plan.target.data_root.join("studio").join(&client.domain)
                && client.source != client.destination
                && PrivateDirectory::open_existing(source)?.directory_identity()?
                    == client.source_identity,
            "STORAGE_LEGACY_SOURCE_CHANGED"
        );
    }
    if native_in_place {
        ensure!(
            receipt.owner_receipts.keys().all(|name| {
                name == "pending-persistent-root"
                    || name == browser_cache::BROWSER_CACHE_OWNER
                    || clients.iter().any(|client| {
                        ["pending-", "publish-", "copy-", "source-retirement-"]
                            .iter()
                            .any(|prefix| name == &format!("{prefix}{}", client.domain))
                    })
            }),
            "STORAGE_LEGACY_NATIVE_LAYOUT_UNSUPPORTED"
        );
    }
    if receipt.phase == Phase::Planned {
        sources::observe(plan, &BTreeSet::new(), true, registration)?;
        for source in [
            home.join(".config/kcoder-studio"),
            plan.from.gateway_root.clone(),
            plan.from.desktop_root.clone(),
        ] {
            if !clients.iter().any(|component| component.source == source) {
                controls_only(&source, "STORAGE_LEGACY_CLIENT_DATA_UNSUPPORTED")?;
            }
        }
        // Unclaimed final directories remain unknown, even if their bytes look
        // like a retained legacy source. This preview never adopts them.
        for role in ["gateway", "desktop"] {
            if !native_in_place
                && !clients.iter().any(|client| {
                    client.domain == role
                        && client.source == plan.from.data_root.join("studio").join(role)
                })
            {
                controls_only(
                    &plan.from.data_root.join("studio").join(role),
                    "STORAGE_LEGACY_SOURCE_CONFLICT",
                )?;
            }
            controls_only(
                &plan.target.data_root.join("studio").join(role),
                "STORAGE_TARGET_NOT_EMPTY",
            )?;
        }
        controls_only(&plan.target.cache_root, "STORAGE_TARGET_NOT_EMPTY")?;
        browser_cache::preview_browser_cache(plan)?;
    }
    if matches!(
        receipt.phase,
        Phase::Verifying | Phase::Prepared | Phase::Committed
    ) {
        for client in clients {
            observe_published_storage_component(home, &plan.operation_id, &client.domain)?
                .verify()?;
        }
        match browser_cache::browser_cache_owner_receipt(receipt)? {
            Some(owner) => browser_cache::verify_browser_cache(plan, &owner)?,
            None => browser_cache::verify_no_browser_cache(plan)?,
        }
    }
    Ok(())
}

pub(super) async fn copy_legacy_clients(
    home: &Path,
    coordinator: &mut StorageCoordinator,
    id: &str,
    mut command: Option<&mut tokio::process::Command>,
) -> Result<()> {
    let receipt = coordinator
        .current()?
        .context("STORAGE_OPERATION_MISSING")?;
    let plan = &receipt.plan;
    if plan.components.len() == 1 {
        return Ok(());
    }
    coordinator.prepare_source_retirements(id)?;
    let gateway = if plan
        .components
        .iter()
        .any(|component| component.domain == "gateway")
    {
        Some(prepare_gateway_domains(coordinator, id, command.as_deref_mut()).await?)
    } else {
        None
    };
    let mut browser = browser_cache::prepare_browser_cache(coordinator, id)?;
    if let Some(owner) = &browser {
        record_browser_owner(coordinator, id, owner)?;
    }
    let fences = coordinator.prepare_offline_child_fences(id)?;
    let mut controls = coordinator.source_retirement_exclusion_identities(id)?;
    for fence in &fences.roots {
        controls.insert(fence.primary_identity.clone());
        controls.insert(fence.secondary_identity.clone());
    }
    let registration = registered::read(home, false)?;
    let observed = sources::observe(plan, &controls, false, registration.as_ref())?;
    // The Native container is already the selected original object. Creating
    // its internal client parent is a stopped operation, never preview work.
    let native = if plan.from.data_root != plan.target.data_root {
        let published = coordinator.open_published_component(id, STORAGE_PERSISTENT_ROOT_DOMAIN)?;
        published.verify()?;
        published.directory().duplicate_handle()?
    } else {
        PrivateDirectory::open_existing(&plan.target.data_root)?
    };
    match native.open_child(OsStr::new("studio"), false) {
        Ok(_) => {}
        Err(error) if missing(&error) => {
            native.create_child(OsStr::new("studio"))?;
        }
        Err(error) => return Err(error),
    }
    for component in &plan.components[1..] {
        let mut selected = None;
        for source in &observed {
            if source.root.directory_identity()? == component.source_identity {
                selected = Some(source);
                break;
            }
        }
        let source = selected.context("STORAGE_LEGACY_SOURCE_CHANGED")?;
        let mut exclusions = source.exclusions(&component.domain);
        if component.domain == "gateway" {
            if let Some(gateway) = &gateway {
                exclusions.extend(gateway.copy_exclusions().iter().cloned());
            }
        } else {
            exclusions.extend(browser_cache::browser_cache_copy_exclusions(
                plan,
                browser.as_ref(),
                &component.domain,
            )?);
        }
        coordinator.publish_component_checked(id, &component.domain, &exclusions, |inventory| {
            source.verify_inventory(inventory, &component.domain, &controls)?;
            if component.domain == "gateway" {
                if let Some(gateway) = &gateway {
                    gateway.verify_source_inventory(inventory)?;
                }
            } else {
                browser_cache::validate_browser_cache_source_inventory(
                    plan,
                    browser.as_ref(),
                    &component.domain,
                    inventory,
                )?;
            }
            Ok(())
        })?;
        let published = coordinator.open_published_component(id, &component.domain)?;
        if component.domain == "gateway" {
            if let Some(gateway) = &gateway {
                relocate_gateway_domains(
                    coordinator,
                    id,
                    command.as_deref_mut(),
                    gateway,
                    &published,
                )
                .await?;
                verify_gateway_domains(
                    coordinator,
                    id,
                    command.as_deref_mut(),
                    gateway,
                    &published,
                )
                .await?;
            }
        }
    }
    if let Some(owner) = &mut browser {
        *owner = browser_cache::prepare_browser_cache_target(coordinator, id, owner)?;
        record_browser_owner(coordinator, id, owner)?;
        *owner = browser_cache::apply_browser_cache(coordinator, id, owner)?;
        record_browser_owner(coordinator, id, owner)?;
        browser_cache::verify_browser_cache(plan, owner)?;
    }
    coordinator.assert_source_retirements_ready(id)
}

/// Hosts invoke this one-shot mode before freezing the context of business children.
/// Standalone CLI invokes it before opening its own runtime or user configuration.
pub(in super::super) fn migrate_legacy_storage_before_startup(
    inherited_context: bool,
) -> Result<Option<StorageMigrationReceipt>> {
    let paths = read_business_startup(current_storage_paths)?;
    if paths.externally_configured {
        return Ok(None);
    }
    let home = dirs::home_dir().context("STORAGE_HOME_UNAVAILABLE")?;
    let current = read_business_startup(|| read_storage_migration(&home))?;
    if let Some(receipt) = current
        .as_ref()
        .filter(|receipt| receipt.disposition == Disposition::Deferred)
    {
        verify_deferred_source_paths(&home, &paths, receipt)?;
        return Ok(Some(receipt.clone()));
    }
    if paths.layout != StorageLayout::Legacy
        && current
            .as_ref()
            .is_none_or(|receipt| receipt.disposition != Disposition::Active)
    {
        return Ok(None);
    }
    let id;
    {
        // This is the existing fixed control lock. No business root is initialized
        // until both its current operation and its actual selection are reconciled.
        let coordinator = StorageCoordinator::acquire(&home)?;
        let current = coordinator.current()?;
        if let Some(receipt) = current
            .as_ref()
            .filter(|receipt| receipt.disposition == Disposition::Deferred)
        {
            verify_deferred_source_paths(&home, &current_storage_paths()?, receipt)?;
            return Ok(Some(receipt.clone()));
        }
        if let Some(receipt) = current.filter(|receipt| receipt.disposition == Disposition::Active)
        {
            ensure!(!inherited_context, "STORAGE_HOST_STARTUP_REQUIRED");
            id = receipt.plan.operation_id;
        } else {
            let mut paths = current_storage_paths()?;
            if paths.layout != StorageLayout::Legacy {
                return Ok(None);
            }
            ensure!(!inherited_context, "STORAGE_LEGACY_HOST_STARTUP_REQUIRED");
            let defaults = default_storage_location(
                &home,
                &dirs::cache_dir().context("STORAGE_CACHE_UNAVAILABLE")?,
            )?;
            ensure!(
                paths.data_root == defaults.data_root,
                "STORAGE_SOURCE_CHANGED"
            );
            if let Some(source) = registered::read(&home, true)? {
                if source.native != defaults.data_root {
                    controls_only(&defaults.data_root, "STORAGE_LEGACY_SOURCE_CONFLICT")?;
                }
                registered::apply(&mut paths, &source);
                PrivateDirectory::open_existing(&paths.data_root)?;
            } else {
                sources::select_unregistered_gateway(&home, &mut paths)?;
                // Only a true first installation initializes an empty Native root.
                PrivateDirectory::open_config_root(&paths.data_root)?;
            }
            // The initial layout step has one identity in this account's control
            // namespace, including a crash before current.json was published.
            id = "legacy-locations-v1".to_owned();
            let owner = LocalStorageOperation::new(&home)?;
            let plan = prepare_storage_plan_from_paths_with_owner(
                &home,
                paths,
                &defaults.data_root,
                &defaults.cache_root,
                &id,
                StorageLaunchIntent::Cli,
                &owner,
            )?
            .context("STORAGE_NO_OPERATION")?;
            coordinator.begin(plan)?;
        }
    }
    let mut owner = LocalStorageOperation::new(&home)?;
    let completed =
        execute_storage_operation_with_owner(&home, &id, &std::env::current_exe()?, &mut owner)?;
    if completed.disposition == Disposition::Deferred {
        verify_deferred_source_paths(&home, &current_storage_paths()?, &completed)?;
    }
    Ok(Some(completed))
}
