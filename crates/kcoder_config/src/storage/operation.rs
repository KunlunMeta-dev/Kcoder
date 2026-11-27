//! Offline operation composition. Domain relocation stays in the data owners.
use super::*;
use anyhow::{Context, Result, ensure};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLayout, StorageMigrationComponent,
    StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase,
    StorageMigrationPlan, StorageMigrationReceipt, StorageTargetBinding,
};
use std::{
    ffi::OsStr,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const STORAGE_OPERATION_ENTRY: &str = "--internal-storage-operation-v1";

fn legacy_client_component(
    domain: &str,
    source: &Path,
    destination: std::path::PathBuf,
) -> Result<Option<StorageMigrationComponent>> {
    if source == destination {
        return Ok(None);
    }
    let root = match crate::PrivateDirectory::open_existing(source) {
        Ok(root) => root,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    // Empty ordinary fences do not constitute a client payload. The owner
    // still validates their contents and every actual client namespace.
    if root.entry_names_bounded(3)?.iter().all(|name| {
        name == OsStr::new("kcoder-storage-writers.lock")
            || name == OsStr::new("kcoder-storage-instances.lock")
    }) {
        return Ok(None);
    }
    Ok(Some(StorageMigrationComponent {
        domain: domain.into(),
        source: source.to_owned(),
        destination,
        source_identity: root.directory_identity()?,
        estimated_bytes: 0,
    }))
}

/// A pure preview freezes selection and real target ancestors. It creates no operation.
pub fn prepare_storage_plan(
    home: &Path,
    data: &Path,
    cache: &Path,
    id: &str,
    intent: StorageLaunchIntent,
) -> Result<Option<StorageMigrationPlan>> {
    ensure!(
        read_storage_location_record(&storage_location_file(home))?.is_some(),
        "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
    );
    prepare_storage_plan_with_owner(
        home,
        data,
        cache,
        id,
        intent,
        &BrowserCacheOperation { home },
    )
}

/// The host supplies read-only owner admission for the same plan and phase driver.
/// The default entry retains its cache-only admission until all product owners
/// are connected; a plan is not permission to stop or relocate those owners.
pub fn prepare_storage_plan_with_owner(
    home: &Path,
    data: &Path,
    cache: &Path,
    id: &str,
    intent: StorageLaunchIntent,
    owner: &impl StorageOperationOwner,
) -> Result<Option<StorageMigrationPlan>> {
    let original = read_storage_location_record(&storage_location_file(home))?;
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.to_owned()),
        record: original,
        ..Default::default()
    })?;
    prepare_storage_plan_from_paths_with_owner(home, from, data, cache, id, intent, owner)
}

/// Preserve the host's resolved platform and consumer paths in the same planner.
/// The owner decides which layouts and source components it can safely handle.
pub fn prepare_storage_plan_from_paths_with_owner(
    home: &Path,
    from: StoragePaths,
    data: &Path,
    cache: &Path,
    id: &str,
    intent: StorageLaunchIntent,
    owner: &impl StorageOperationOwner,
) -> Result<Option<StorageMigrationPlan>> {
    ensure!(
        super::resolve::valid_operation_id(id),
        "STORAGE_OPERATION_INVALID"
    );
    let original = read_storage_location_record(&storage_location_file(home))?;
    let preview = preview_storage_targets(&from, data, cache, &[], &[])?;
    if preview.no_operation {
        return Ok(None);
    }
    let source = crate::PrivateDirectory::open_existing(&from.data_root)?;
    let target = StorageLocationRecord {
        version: 1,
        revision: original
            .as_ref()
            .map_or(0, |record| record.revision)
            .checked_add(1)
            .context("STORAGE_RECORD_INVALID")?,
        data_root: preview.data.path.clone(),
        cache_root: preview.cache.path.clone(),
        operation_id: Some(id.into()),
    };
    let bindings = [&preview.data, &preview.cache].map(|entry| StorageTargetBinding {
        path: entry.path.clone(),
        existing_ancestor: entry.existing_ancestor.clone(),
        ancestor_identity: entry.ancestor_identity.clone(),
    });
    let component = StorageMigrationComponent {
        domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
        source: from.data_root.clone(),
        destination: target.data_root.clone(),
        source_identity: source.directory_identity()?,
        estimated_bytes: 0,
    };
    let mut components = vec![component];
    if from.layout == StorageLayout::Legacy {
        for (domain, source) in [
            ("gateway", &from.gateway_root),
            ("desktop", &from.desktop_root),
        ] {
            if let Some(component) = legacy_client_component(
                domain,
                source,
                target.data_root.join("studio").join(domain),
            )? {
                components.push(component);
            }
        }
    }
    super::capacity::fill_estimates(&mut components)?;
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: id.into(),
        original,
        from,
        components,
        target,
        target_bindings: bindings.into(),
        launch_intent: intent,
    };
    super::control::check_plan(&plan)?;
    owner.validate(&StorageMigrationReceipt {
        plan: plan.clone(),
        phase: Phase::Planned,
        disposition: Disposition::Active,
        owner_receipts: Default::default(),
        error_code: None,
    })?;
    Ok(Some(plan))
}

fn verify_plan_paths(home: &Path, receipt: &StorageMigrationReceipt) -> Result<()> {
    let plan = &receipt.plan;
    super::control::check_plan(plan)?;
    ensure!(
        receipt.owner_receipts.keys().all(|name| {
            name == browser_cache::BROWSER_CACHE_OWNER || name == "pending-persistent-root"
        }),
        "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
    );
    if let Some(owner) = browser_cache::browser_cache_owner_receipt(receipt)? {
        browser_cache::verify_browser_cache_target(plan, &owner)?;
    }
    ensure!(
        plan.from.layout == kcoder_types::StorageLayout::Unified
            && plan.from.data_root == plan.target.data_root
            && plan.target_bindings.len() == 2
            && plan.components.len() == 1,
        "STORAGE_DOMAIN_MIGRATION_UNSUPPORTED"
    );
    let source = &plan.components[0];
    ensure!(
        source.domain == STORAGE_PERSISTENT_ROOT_DOMAIN
            && source.source == plan.from.data_root
            && source.destination == plan.target.data_root
            && crate::PrivateDirectory::open_existing(&source.source)?.directory_identity()?
                == source.source_identity,
        "STORAGE_SOURCE_CHANGED"
    );
    super::component_publication::verify_pending_in_place_control(home, receipt)
        .context("STORAGE_MIGRATION_PENDING")?;
    for path in [&plan.target.data_root, &plan.target.cache_root] {
        let binding = plan
            .target_bindings
            .iter()
            .find(|binding| super::resolve::absolute(&binding.path).ok().as_ref() == Some(path))
            .context("STORAGE_OPERATION_INVALID")?;
        ensure!(
            crate::PrivateDirectory::open_existing(&binding.existing_ancestor)?
                .directory_identity()?
                == binding.ancestor_identity,
            "STORAGE_TARGET_CHANGED"
        );
        let observed = inspect_storage_target(path)?;
        if path == &plan.target.cache_root
            && observed.remaining.as_os_str().is_empty()
            && browser_cache::browser_cache_owner_receipt(receipt)?.is_none()
        {
            let directory = crate::PrivateDirectory::open_existing(path)?;
            ensure!(
                super::writers::empty_except_fences(&directory)?,
                "STORAGE_TARGET_NOT_EMPTY"
            );
        }
    }
    if matches!(
        receipt.phase,
        Phase::Verifying | Phase::Prepared | Phase::Committed | Phase::Verified
    ) {
        match browser_cache::browser_cache_owner_receipt(receipt)? {
            Some(owner) => browser_cache::verify_browser_cache(plan, &owner)?,
            None => browser_cache::verify_no_browser_cache(plan)?,
        }
    }
    Ok(())
}

/// Domain composition stays in the host that already owns those stores. The
/// coordinator remains the single phase/revision/stop authority across all owners.
pub trait StorageOperationOwner {
    /// Read-only, phase-aware validation of every supported owner in this plan.
    fn validate(&self, receipt: &StorageMigrationReceipt) -> Result<()>;
    /// Freeze, copy, publish and convert using the original stopped coordinator.
    fn copy_and_relocate(&mut self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()>;
    /// Reconcile a failed operation. Leaving it active is required whenever
    /// cleanup or any side effect is unconfirmed; never infer non-execution.
    fn reconcile_failure(&mut self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()>;
}

pub struct BrowserCacheOperation<'a> {
    home: &'a Path,
}
impl<'a> BrowserCacheOperation<'a> {
    pub fn new(home: &'a Path) -> Self {
        Self { home }
    }
}
impl StorageOperationOwner for BrowserCacheOperation<'_> {
    fn validate(&self, receipt: &StorageMigrationReceipt) -> Result<()> {
        verify_plan_paths(self.home, receipt)?;
        if receipt.phase == Phase::Planned {
            browser_cache::preview_browser_cache(&receipt.plan)?;
        }
        Ok(())
    }
    fn copy_and_relocate(&mut self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()> {
        let receipt = coordinator
            .current()?
            .context("STORAGE_OPERATION_MISSING")?;
        // Rebuildable cache contents are intentionally not copied.
        if let Some(owner) = browser_cache::prepare_browser_cache(coordinator, id)? {
            let before = serde_json::to_value(&owner)?;
            if !receipt
                .owner_receipts
                .contains_key(browser_cache::BROWSER_CACHE_OWNER)
            {
                coordinator.record_owner_receipt(
                    id,
                    browser_cache::BROWSER_CACHE_OWNER,
                    None,
                    before.clone(),
                )?;
            }
            let completed = browser_cache::apply_browser_cache(coordinator, id, &owner)?;
            let after = serde_json::to_value(&completed)?;
            if before != after {
                coordinator.record_owner_receipt(
                    id,
                    browser_cache::BROWSER_CACHE_OWNER,
                    Some(&before),
                    after,
                )?;
            }
        }
        Ok(())
    }
    fn reconcile_failure(&mut self, coordinator: &mut StorageCoordinator, id: &str) -> Result<()> {
        let receipt = coordinator
            .current()?
            .context("STORAGE_OPERATION_MISSING")?;
        if read_storage_location_record(&storage_location_file(self.home))? == receipt.plan.original
            && verify_source(&receipt.plan).is_ok()
            && receipt.owner_receipts.is_empty()
            && browser_cache::verify_no_browser_cache(&receipt.plan).is_ok()
        {
            coordinator.defer_after_cleanup(id, "STORAGE_OFFLINE_STEP_FAILED")?;
        }
        Ok(())
    }
}

/// The only startup-wait exception: metadata verification, never ordinary business initialization.
pub fn verify_committed_storage_target(home: &Path, id: &str) -> Result<StoragePaths> {
    verify_committed_storage_target_with_owner(home, id, &BrowserCacheOperation { home })
}

pub fn verify_committed_storage_target_with_owner(
    home: &Path,
    id: &str,
    owner: &impl StorageOperationOwner,
) -> Result<StoragePaths> {
    let receipt = read_storage_migration(home)?.context("STORAGE_OPERATION_MISSING")?;
    ensure!(
        receipt.plan.operation_id == id
            && receipt.phase == Phase::Committed
            && receipt.disposition == Disposition::Active,
        "STORAGE_PHASE_INVALID"
    );
    ensure!(
        read_storage_location_record(&storage_location_file(home))?.as_ref()
            == Some(&receipt.plan.target),
        "STORAGE_SELECTION_CHANGED"
    );
    owner.validate(&receipt)?;
    resolve_storage_paths(&StorageResolveInput {
        home: Some(home.to_owned()),
        record: Some(receipt.plan.target),
        ..Default::default()
    })
}

fn run_verifier(program: &Path, id: &str) -> Result<()> {
    ensure!(program.is_absolute(), "STORAGE_VERIFIER_INVALID");
    let mut command = Command::new(program);
    command
        .args([STORAGE_OPERATION_ENTRY, "verify", id])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().context("STORAGE_VERIFIER_START_FAILED")?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                ensure!(status.success(), "STORAGE_TARGET_VERIFY_FAILED");
                return Ok(());
            }
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                child.wait().context("STORAGE_VERIFIER_STOP_UNCONFIRMED")?;
                return Err(error).context("STORAGE_VERIFIER_WAIT_FAILED");
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            child.wait().context("STORAGE_VERIFIER_STOP_UNCONFIRMED")?;
            anyhow::bail!("STORAGE_TARGET_VERIFY_TIMEOUT");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Resume the original ID. A committed operation only re-verifies, never replays copying.
pub fn execute_storage_operation(
    home: &Path,
    id: &str,
    verifier_program: &Path,
) -> Result<StorageMigrationReceipt> {
    execute_storage_operation_with_owner(
        home,
        id,
        verifier_program,
        &mut BrowserCacheOperation { home },
    )
}

/// The same phase machine serves persistent-root and cache-only host owners.
/// A host must supply every owner; this does not broaden the public plan builder.
pub fn execute_storage_operation_with_owner(
    home: &Path,
    id: &str,
    verifier_program: &Path,
    owner: &mut impl StorageOperationOwner,
) -> Result<StorageMigrationReceipt> {
    let mut coordinator = StorageCoordinator::acquire(home)?;
    let mut receipt = coordinator
        .current()?
        .context("STORAGE_OPERATION_MISSING")?;
    ensure!(
        receipt.plan.operation_id == id,
        "STORAGE_OPERATION_CONFLICT"
    );
    if receipt.disposition == Disposition::Complete {
        return coordinator.complete(id);
    }
    ensure!(
        receipt.disposition == Disposition::Active,
        "STORAGE_MIGRATION_DEFERRED"
    );
    if receipt.error_code.as_deref() == Some("STORAGE_OPERATION_CANCEL_PENDING") {
        return coordinator.cancel_operation(id);
    }
    let result = (|| -> Result<StorageMigrationReceipt> {
        owner.validate(&receipt)?;
        loop {
            match receipt.phase {
                Phase::Planned => {
                    receipt = coordinator.advance(id, Phase::Planned, Phase::Stopping)?
                }
                Phase::Stopping => {
                    receipt = coordinator.advance(id, Phase::Stopping, Phase::Stopped)?
                }
                Phase::Stopped => {
                    receipt = coordinator.advance(id, Phase::Stopped, Phase::Copying)?
                }
                Phase::Copying => {
                    owner.copy_and_relocate(&mut coordinator, id)?;
                    receipt = coordinator.advance(id, Phase::Copying, Phase::Verifying)?;
                }
                Phase::Verifying => {
                    receipt = coordinator.advance(id, Phase::Verifying, Phase::Prepared)?
                }
                Phase::Prepared => {
                    owner.validate(&receipt)?;
                    receipt = coordinator.commit(id)?;
                }
                Phase::Committed => {
                    coordinator.verify_copied_sources(id)?;
                    run_verifier(verifier_program, id)?;
                    return coordinator.complete(id);
                }
                Phase::Verified => anyhow::bail!("STORAGE_PHASE_INVALID"),
            }
        }
    })();
    if let Err(error) = &result {
        coordinator
            .record_step_error(id, &step_error_code(error))
            .context("STORAGE_ERROR_RECEIPT_UNCONFIRMED")?;
        owner.reconcile_failure(&mut coordinator, id)?;
    }
    result
}

// Persist only known public error identifiers, never paths, secrets or a backtrace.
fn step_error_code(error: &anyhow::Error) -> String {
    const PREFIXES: &[&str] = &[
        "STORAGE_",
        "CREDENTIAL_",
        "SETTINGS_TEMPLATE_",
        "INTEGRATION_",
        "NATIVE_",
        "PROFILE_",
        "WORKSPACE_",
    ];
    for cause in error.chain() {
        let message = cause.to_string();
        let code = message
            .split(|ch: char| ch == ':' || ch.is_whitespace())
            .next()
            .unwrap_or("");
        if code.len() <= 128
            && PREFIXES.iter().any(|prefix| code.starts_with(prefix))
            && code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return code.to_owned();
        }
    }
    "STORAGE_OFFLINE_STEP_FAILED".into()
}

fn verify_source(plan: &StorageMigrationPlan) -> Result<()> {
    for source in &plan.components {
        ensure!(
            crate::PrivateDirectory::open_existing(&source.source)?.directory_identity()?
                == source.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
    }
    Ok(())
}
