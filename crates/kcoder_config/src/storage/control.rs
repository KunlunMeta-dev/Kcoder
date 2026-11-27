//! Kernel coordination and bounded, handle-relative journals for one offline operation.
//! The caller owns stopping writers and domain verification; a phase is not a stop API.
use super::validate_storage_location_record;
use crate::PrivateDirectory;
use anyhow::{Context, Result, ensure};
use kcoder_types::{
    STORAGE_LOCATION_MAX_BYTES, STORAGE_LOCATION_MAX_REVISION, StorageLocationRecord,
    StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase,
    StorageMigrationPlan, StorageMigrationReceipt,
};
use serde::de::DeserializeOwned;
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

const LOCATION: &str = "kcoder-storage.json";
const LOCK: &str = "kcoder-storage.lock";
const INSTANCES: &str = "kcoder-storage-instances.lock";
const OPERATIONS: &str = "kcoder-storage-migrations";
const CURRENT: &str = "current.json";
const RECEIPT: &str = "receipt.json";
const RECEIPT_LIMIT: u64 = 1024 * 1024;

#[path = "cancel.rs"]
mod cancel;

#[path = "initial_selection.rs"]
mod initial_selection;

#[path = "offline_child.rs"]
mod offline_child;
pub use offline_child::{
    STORAGE_OFFLINE_CHILD_FRAME_LIMIT, StorageOfflineChildFence, StorageOfflineChildFences,
    read_storage_offline_child_frame, write_storage_offline_child_frame,
};

#[path = "source_cleanup.rs"]
mod source_cleanup;
pub use source_cleanup::{
    StorageSourceCleanupEntry, StorageSourceCleanupPreview, StorageSourceCleanupResult,
    StorageSourceCleanupStatus,
};

/// The held shared lease lives as long as this instance can write business data.
pub struct StorageStartupLease {
    _lease: File,
}

/// An offline helper owns this exclusive lease through publication and verification.
/// It must release it before starting a normal instance.
pub struct StorageCoordinator {
    directory: PrivateDirectory,
    lease: File,
    path: PathBuf,
    instances: File,
    stopped_operation: Option<String>,
    // Raw-source integrity only, scoped to this operation's continuously held
    // exclusive leases. Domain authorization and revocation are never cached.
    verified_copy_sources: BTreeSet<String>,
    roots: Vec<super::writers::RootLease>,
    source_retirements: Vec<super::source_retirement::StorageSourceRetirementLease>,
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn config_directory(home: &Path, create: bool) -> Result<Option<PrivateDirectory>> {
    ensure!(home.is_absolute(), "STORAGE_PATH_INVALID");
    let home = PrivateDirectory::open_existing(home).context("STORAGE_CONTROL_UNAVAILABLE")?;
    match home.open_child(OsStr::new(".config"), false) {
        Ok(directory) => Ok(Some(directory)),
        Err(error) if missing(&error) && !create => Ok(None),
        Err(error) if missing(&error) => match home.create_child(OsStr::new(".config")) {
            Ok(directory) => Ok(Some(directory)),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
            {
                Ok(Some(home.open_child(OsStr::new(".config"), false)?))
            }
            Err(error) => Err(error).context("STORAGE_CONTROL_UNAVAILABLE"),
        },
        Err(error) => Err(error).context("STORAGE_CONTROL_UNAVAILABLE"),
    }
}

fn optional_child(directory: &PrivateDirectory, name: &str) -> Result<Option<PrivateDirectory>> {
    match directory.open_child(OsStr::new(name), false) {
        Ok(child) => Ok(Some(child)),
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error).context("STORAGE_CONTROL_INVALID"),
    }
}

fn child(directory: &PrivateDirectory, name: &str) -> Result<PrivateDirectory> {
    if let Some(child) = optional_child(directory, name)? {
        return Ok(child);
    }
    directory
        .create_child(OsStr::new(name))
        .context("STORAGE_CONTROL_UNAVAILABLE")
}

fn read_json<T: DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    limit: u64,
) -> Result<Option<T>> {
    let mut file = match directory.open_regular_file_snapshot(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error).context("STORAGE_CONTROL_INVALID"),
    };
    ensure!(file.metadata()?.len() <= limit, "STORAGE_CONTROL_INVALID");
    let mut bytes = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "STORAGE_CONTROL_INVALID");
    Ok(Some(
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("STORAGE_CONTROL_INVALID"))?,
    ))
}

fn location(directory: &PrivateDirectory) -> Result<Option<StorageLocationRecord>> {
    let record: Option<StorageLocationRecord> =
        read_json(directory, LOCATION, STORAGE_LOCATION_MAX_BYTES)?;
    if let Some(record) = &record {
        validate_storage_location_record(record)?;
    }
    Ok(record)
}

fn verify_control(directory: &PrivateDirectory, lease: &File, path: &Path) -> Result<()> {
    let named = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
    ensure!(
        lease.metadata()?.len() == 0
            && named.metadata()?.len() == 0
            && PrivateDirectory::open_existing(path)?.directory_identity()?
                == directory.directory_identity()?
            && PrivateDirectory::identity_of_file(&named)?
                == PrivateDirectory::identity_of_file(lease)?,
        "STORAGE_CONTROL_CHANGED"
    );
    Ok(())
}

fn verify_instances(directory: &PrivateDirectory, instances: &File) -> Result<()> {
    let named = directory.open_single_link_regular_file(OsStr::new(INSTANCES))?;
    ensure!(
        instances.metadata()?.len() == 0
            && named.metadata()?.len() == 0
            && PrivateDirectory::identity_of_file(&named)?
                == PrivateDirectory::identity_of_file(instances)?,
        "STORAGE_CONTROL_CHANGED"
    );
    Ok(())
}

fn check_id(id: &str) -> Result<()> {
    ensure!(
        super::resolve::valid_operation_id(id),
        "STORAGE_OPERATION_INVALID"
    );
    Ok(())
}

pub(super) fn check_plan(plan: &StorageMigrationPlan) -> Result<()> {
    check_id(&plan.operation_id)?;
    ensure!(plan.version == 1, "STORAGE_RECORD_VERSION_UNSUPPORTED");
    if let Some(original) = &plan.original {
        validate_storage_location_record(original)?;
    }
    validate_storage_location_record(&plan.target)?;
    ensure!(
        !plan.from.externally_configured,
        "STORAGE_EXTERNAL_INSTANCE_READ_ONLY"
    );
    ensure!(
        plan.from.selection_revision == plan.original.as_ref().map(|record| record.revision),
        "STORAGE_OPERATION_INVALID"
    );
    if let Some(original) = &plan.original {
        ensure!(
            plan.from.data_root == super::resolve::absolute(&original.data_root)?
                && plan.from.cache_root == super::resolve::absolute(&original.cache_root)?,
            "STORAGE_OPERATION_INVALID"
        );
    }
    for component in &plan.components {
        super::resolve::absolute(&component.source)?;
        super::resolve::absolute(&component.destination)?;
        ensure!(
            !component.source_identity.is_empty()
                && component.source_identity.len() <= 256
                && !component.domain.is_empty()
                && component.domain.len() <= 64
                && component
                    .domain
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
            "STORAGE_OPERATION_INVALID"
        );
    }
    ensure!(plan.target_bindings.len() <= 2, "STORAGE_OPERATION_INVALID");
    for binding in &plan.target_bindings {
        let path = super::resolve::absolute(&binding.path)?;
        let ancestor = super::resolve::absolute(&binding.existing_ancestor)?;
        ensure!(
            (path == super::resolve::absolute(&plan.target.data_root)?
                || path == super::resolve::absolute(&plan.target.cache_root)?)
                && path.starts_with(&ancestor)
                && !binding.ancestor_identity.is_empty()
                && binding.ancestor_identity.len() <= 256,
            "STORAGE_OPERATION_INVALID"
        );
    }
    let revision = plan.original.as_ref().map_or(0, |record| record.revision);
    ensure!(
        revision < STORAGE_LOCATION_MAX_REVISION
            && plan.target.revision == revision + 1
            && plan.target.operation_id.as_deref() == Some(plan.operation_id.as_str()),
        "STORAGE_OPERATION_INVALID"
    );
    Ok(())
}

pub(super) fn check_receipt(receipt: &StorageMigrationReceipt) -> Result<()> {
    check_plan(&receipt.plan)?;
    ensure!(
        receipt
            .owner_receipts
            .iter()
            .all(|(domain, value)| !domain.is_empty()
                && domain.len() <= 64
                && domain.bytes().all(|byte| byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || byte == b'-')
                && value.is_object()),
        "STORAGE_CONTROL_INVALID"
    );
    ensure!(
        match receipt.disposition {
            Disposition::Active => receipt.phase != Phase::Verified,
            Disposition::Complete =>
                receipt.phase == Phase::Verified && receipt.error_code.is_none(),
            Disposition::Deferred =>
                !matches!(receipt.phase, Phase::Committed | Phase::Verified)
                    && receipt
                        .error_code
                        .as_ref()
                        .is_some_and(|code| !code.is_empty()),
        },
        "STORAGE_CONTROL_INVALID"
    );
    Ok(())
}

fn read_operation(
    directory: &PrivateDirectory,
    id: &str,
) -> Result<Option<StorageMigrationReceipt>> {
    check_id(id)?;
    let Some(operations) = optional_child(directory, OPERATIONS)? else {
        return Ok(None);
    };
    let Some(operation) = optional_child(&operations, id)? else {
        return Ok(None);
    };
    let receipt: Option<StorageMigrationReceipt> = read_json(&operation, RECEIPT, RECEIPT_LIMIT)?;
    if let Some(receipt) = &receipt {
        check_receipt(receipt)?;
        ensure!(receipt.plan.operation_id == id, "STORAGE_OPERATION_INVALID");
    }
    Ok(receipt)
}

fn current(directory: &PrivateDirectory) -> Result<Option<StorageMigrationReceipt>> {
    let Some(operations) = optional_child(directory, OPERATIONS)? else {
        return Ok(None);
    };
    let Some(id): Option<String> = read_json(&operations, CURRENT, 1024)? else {
        return Ok(None);
    };
    Ok(Some(
        read_operation(directory, &id)?.context("STORAGE_OPERATION_MISSING")?,
    ))
}

/// Query never creates the control directory, locks or operation files.
pub fn read_storage_migration(home: &Path) -> Result<Option<StorageMigrationReceipt>> {
    match config_directory(home, false)? {
        Some(directory) => current(&directory),
        None => Ok(None),
    }
}

/// Read one original operation without consulting the mutable current pointer.
/// Retained sources can still refer to it after subsequent successful moves.
pub fn read_storage_operation(home: &Path, id: &str) -> Result<Option<StorageMigrationReceipt>> {
    check_id(id)?;
    match config_directory(home, false)? {
        Some(directory) => read_operation(&directory, id),
        None => Ok(None),
    }
}

/// Existing control handles for metadata verification; no creation or stop authority.
pub(super) fn observe_operation_directory(home: &Path, id: &str) -> Result<PrivateDirectory> {
    check_id(id)?;
    let control = config_directory(home, false)?.context("STORAGE_OPERATION_MISSING")?;
    let operations = optional_child(&control, OPERATIONS)?.context("STORAGE_OPERATION_MISSING")?;
    optional_child(&operations, id)?.context("STORAGE_OPERATION_MISSING")
}

fn require_settled_selection(
    receipt: &StorageMigrationReceipt,
    selected: Option<&StorageLocationRecord>,
) -> Result<()> {
    match receipt.disposition {
        Disposition::Active => anyhow::bail!("STORAGE_MIGRATION_PENDING"),
        Disposition::Deferred => ensure!(
            selected == receipt.plan.original.as_ref(),
            "STORAGE_SELECTION_CHANGED"
        ),
        Disposition::Complete => ensure!(
            selected == Some(&receipt.plan.target),
            "STORAGE_SELECTION_CHANGED"
        ),
    }
    Ok(())
}

impl StorageStartupLease {
    pub fn acquire(home: &Path) -> Result<Self> {
        let directory = config_directory(home, true)?.context("STORAGE_CONTROL_UNAVAILABLE")?;
        let lease = directory
            .try_shared_lock(OsStr::new(LOCK))
            .map_err(|error| {
                super::writers::permission_context(
                    error,
                    format!(
                        "storage control lock access: {}",
                        home.join(".config").display()
                    ),
                )
            })?
            .context("STORAGE_MIGRATION_BUSY")?;
        verify_control(&directory, &lease, &home.join(".config"))?;
        let selected = location(&directory)?;
        if let Some(receipt) = current(&directory)? {
            require_settled_selection(&receipt, selected.as_ref())?;
        } else {
            ensure!(
                selected
                    .as_ref()
                    .is_none_or(|record| record.operation_id.is_none()),
                "STORAGE_OPERATION_MISSING"
            );
        }
        let instances = directory
            .try_shared_lock(OsStr::new(INSTANCES))?
            .context("STORAGE_MIGRATION_BUSY")?;
        verify_control(&directory, &lease, &home.join(".config"))?;
        verify_instances(&directory, &instances)?;
        // Admission is serialized only until the lifetime lease is held. A running
        // instance must not prevent its own coordinator from recording stopping.
        Ok(Self { _lease: instances })
    }
}

impl StorageCoordinator {
    pub fn assert_offline_owner(&mut self, id: &str) -> Result<StorageMigrationReceipt> {
        let receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(receipt.phase, Phase::Stopped | Phase::Copying),
            "STORAGE_PHASE_INVALID"
        );
        self.require_stopped(&receipt.plan)?;
        Ok(receipt)
    }

    /// The copy manifest lives outside both business roots in the original job.
    /// Held control directory for this stopped operation's owner journals.
    /// It is outside movable business roots; owners must still bind each exact
    /// entry to their original operation and reconcile uncertain publications.
    pub fn offline_operation_directory(&mut self, id: &str) -> Result<PrivateDirectory> {
        self.assert_offline_owner(id)?;
        let operations =
            optional_child(&self.directory, OPERATIONS)?.context("STORAGE_OPERATION_MISSING")?;
        optional_child(&operations, id)?.context("STORAGE_OPERATION_MISSING")
    }

    /// The original control and job handles, only while actual stop leases are held.
    pub(super) fn source_retirement_context(
        &mut self,
        id: &str,
    ) -> Result<(StorageMigrationReceipt, PrivateDirectory, PrivateDirectory)> {
        let receipt = self.source_retirement_verification_receipt(id)?;
        ensure!(
            matches!(
                receipt.phase,
                Phase::Stopped | Phase::Copying | Phase::Verifying | Phase::Prepared
            ),
            "STORAGE_PHASE_INVALID"
        );
        self.require_stopped(&receipt.plan)?;
        let operations =
            optional_child(&self.directory, OPERATIONS)?.context("STORAGE_OPERATION_MISSING")?;
        let operation = optional_child(&operations, id)?.context("STORAGE_OPERATION_MISSING")?;
        Ok((receipt, self.directory.try_clone()?, operation))
    }

    pub(super) fn source_retirement_verification_receipt(
        &mut self,
        id: &str,
    ) -> Result<StorageMigrationReceipt> {
        let receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(
                    receipt.phase,
                    Phase::Stopped
                        | Phase::Copying
                        | Phase::Verifying
                        | Phase::Prepared
                        | Phase::Committed
                ),
            "STORAGE_PHASE_INVALID"
        );
        self.require_stopped(&receipt.plan)?;
        Ok(receipt)
    }

    pub(super) fn source_retirement_control_path(&self) -> Result<PathBuf> {
        self.verify_control()?;
        Ok(self.path.clone())
    }

    /// Only source retirement cleanup may reconcile these fixed owner entries
    /// after Copying. Other domain receipt APIs retain their original phases.
    pub(super) fn record_source_retirement_receipt(
        &mut self,
        id: &str,
        role: &str,
        expected: Option<&serde_json::Value>,
        value: serde_json::Value,
    ) -> Result<StorageMigrationReceipt> {
        ensure!(
            matches!(role, "native" | "gateway" | "desktop"),
            "STORAGE_DOMAIN_UNAVAILABLE"
        );
        let (mut receipt, _, _) = self.source_retirement_context(id)?;
        let key = format!("source-retirement-{role}");
        ensure!(
            receipt.owner_receipts.get(&key) == expected,
            "STORAGE_OWNER_REVISION_CONFLICT"
        );
        receipt.owner_receipts.insert(key, value);
        self.write_receipt(&receipt)?;
        Ok(receipt)
    }

    /// Return an existing directory only when its actual fence is already ours.
    /// Opening an ordinary path alone never establishes stopped authority.
    pub(super) fn verify_source_root(
        &mut self,
        id: &str,
        path: &Path,
        expected_identity: &str,
    ) -> Result<PrivateDirectory> {
        self.source_retirement_verification_receipt(id)?;
        let directory = PrivateDirectory::open_existing(path)?;
        ensure!(
            directory.directory_identity()? == expected_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        for root in &self.roots {
            if root.matches_directory(expected_identity)? {
                self.verify_control()?;
                return Ok(directory);
            }
        }
        anyhow::bail!("STORAGE_SOURCE_NOT_FENCED")
    }

    /// Exact primary and secondary objects, never filename-based exclusions.
    pub(super) fn held_writer_fence_identities(
        &mut self,
        id: &str,
    ) -> Result<std::collections::BTreeSet<String>> {
        self.source_retirement_context(id)?;
        let mut identities = std::collections::BTreeSet::new();
        for root in &self.roots {
            identities.extend(root.fence_identities()?);
        }
        self.verify_control()?;
        Ok(identities)
    }

    /// Newly prepared component roots need their own real fence before copying
    /// or publication; another Home does not share this controller's admission lock.
    pub(super) fn fence_component_directory(
        &mut self,
        path: &Path,
        directory: &PrivateDirectory,
    ) -> Result<()> {
        self.verify_control()?;
        let identity = directory.directory_identity()?;
        ensure!(
            PrivateDirectory::open_existing(path)?.directory_identity()? == identity,
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        super::writers::RootLease::exclusive_tree_existing(path, &mut self.roots)?;
        ensure!(
            self.roots.iter().try_fold(false, |found, root| {
                Ok::<_, anyhow::Error>(found || root.matches_directory(&identity)?)
            })?,
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        self.verify_control()
    }

    #[cfg(not(windows))]
    pub(super) fn follow_component_rename(
        &mut self,
        directory: &PrivateDirectory,
        previous: &Path,
        path: &Path,
    ) -> Result<()> {
        let identity = directory.directory_identity()?;
        let mut found = false;
        for root in &mut self.roots {
            found |= root.follow_owned_rename(&identity, previous, path)?;
        }
        ensure!(found, "STORAGE_COMPONENT_BINDING_CHANGED");
        self.verify_control()
    }

    /// Windows forbids directory rename while files beneath it are open. Only
    /// unpublished target fences transfer here; source/control/instance leases
    /// stay held and the authenticated pending backlink denies business admission.
    #[cfg(windows)]
    pub(super) fn rename_component_directory(
        &mut self,
        id: &str,
        domain: &str,
        directory: &PrivateDirectory,
        previous: &Path,
        destination: &Path,
        rename: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let receipt = self.assert_offline_owner(id)?;
        let identity = directory.directory_identity()?;
        ensure!(
            receipt.phase == Phase::Copying
                && previous.parent() == destination.parent()
                && receipt.plan.components.iter().any(|component| {
                    component.domain == domain
                        && component.destination == destination
                        && component.source_identity != identity
                })
                && receipt
                    .plan
                    .components
                    .iter()
                    .all(|component| { !component.source.starts_with(previous) }),
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        let pending_identity = {
            let file = super::component_publication::pending_target_control(self, id, directory)?
                .context("STORAGE_MIGRATION_PENDING")?;
            super::component_publication::pending_control_identity(&file)?
        };
        let facts = self
            .roots
            .iter()
            .filter(|root| root.is_within(previous))
            .map(|root| root.rename_facts())
            .collect::<Result<Vec<_>>>()?;
        let mut owns_stage = false;
        for fact in &facts {
            owns_stage |= fact.identity == identity;
            ensure!(
                receipt
                    .plan
                    .components
                    .iter()
                    .all(|part| part.source_identity != fact.identity),
                "STORAGE_SOURCE_NOT_FENCED"
            );
        }
        ensure!(owns_stage, "STORAGE_COMPONENT_BINDING_CHANGED");
        // Facts contain identities only: even a held nested directory blocks
        // Windows from renaming its parent. The caller retains the stage itself.
        // No business callback or asynchronous owner runs in this namespace window.
        self.roots.retain(|root| !root.is_within(previous));
        let renamed = rename();
        let restored = (|| -> Result<()> {
            let matches = |path: &Path| -> Result<bool> {
                match PrivateDirectory::open_existing(path) {
                    Ok(current) => Ok(current.directory_identity()? == identity),
                    Err(error) if missing(&error) => Ok(false),
                    Err(error) => Err(error),
                }
            };
            let actual = match (matches(previous)?, matches(destination)?) {
                (true, false) => previous,
                (false, true) => destination,
                _ => anyhow::bail!("STORAGE_COMPONENT_BINDING_CHANGED"),
            };
            for fact in &facts {
                let relative = fact
                    .path
                    .strip_prefix(previous)
                    .context("STORAGE_COMPONENT_BINDING_CHANGED")?;
                let path = if relative.as_os_str().is_empty() {
                    actual.to_owned()
                } else {
                    actual.join(relative)
                };
                self.roots.push(fact.restore(path)?);
            }
            let file = super::component_publication::pending_target_control(self, id, directory)?
                .context("STORAGE_MIGRATION_PENDING")?;
            ensure!(
                super::component_publication::pending_control_identity(&file)? == pending_identity,
                "STORAGE_COMPONENT_BINDING_CHANGED"
            );
            self.verify_control()
        })();
        restored.context("STORAGE_COMPONENT_FENCE_RESTORE_FAILED")?;
        renamed
    }

    pub(super) fn register_source_retirement_lease(
        &mut self,
        id: &str,
        lease: super::source_retirement::StorageSourceRetirementLease,
    ) -> Result<()> {
        self.source_retirement_context(id)?;
        let identity = lease.identity()?;
        for existing in &self.source_retirements {
            if existing.identity()? == identity {
                return Ok(());
            }
        }
        self.source_retirements.push(lease);
        Ok(())
    }

    pub(super) fn unregister_source_retirement_leases(&mut self, id: &str) -> Result<()> {
        self.source_retirement_context(id)?;
        self.source_retirements
            .retain(|lease| lease.operation_id() != id);
        Ok(())
    }

    pub(super) fn source_retirement_lease_identities(
        &mut self,
        id: &str,
    ) -> Result<std::collections::BTreeSet<String>> {
        self.source_retirement_context(id)?;
        self.source_retirements
            .iter()
            .map(|lease| lease.identity())
            .collect()
    }

    /// Compare-and-set the original operation's domain facts before publishing owned entries.
    pub fn record_owner_receipt(
        &mut self,
        id: &str,
        domain: &str,
        expected: Option<&serde_json::Value>,
        value: serde_json::Value,
    ) -> Result<StorageMigrationReceipt> {
        ensure!(
            !domain.is_empty()
                && domain.len() <= 64
                && domain
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && value.is_object(),
            "STORAGE_OPERATION_INVALID"
        );
        let mut receipt = self.assert_offline_owner(id)?;
        ensure!(
            receipt.owner_receipts.get(domain) == expected,
            "STORAGE_OWNER_RECEIPT_CONFLICT"
        );
        if expected != Some(&value)
            && let Some(component) = domain.strip_prefix("copy-")
        {
            self.verified_copy_sources.remove(component);
        }
        receipt.owner_receipts.insert(domain.into(), value);
        self.write_receipt(&receipt)?;
        Ok(receipt)
    }

    /// Full-tree I/O is restricted to the stopped copy boundary, never startup/query paths.
    pub fn inventory_source(
        &mut self,
        id: &str,
        domain: &str,
        exclusions: &std::collections::BTreeSet<PathBuf>,
    ) -> Result<super::StorageTreeInventory> {
        let receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(receipt.phase, Phase::Stopped | Phase::Copying),
            "STORAGE_PHASE_INVALID"
        );
        self.require_stopped(&receipt.plan)?;
        let mut matches = receipt
            .plan
            .components
            .iter()
            .filter(|part| part.domain == domain);
        let component = matches.next().context("STORAGE_DOMAIN_UNAVAILABLE")?;
        ensure!(matches.next().is_none(), "STORAGE_OPERATION_INVALID");
        let source = PrivateDirectory::open_existing(&component.source)?;
        ensure!(
            source.directory_identity()? == component.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        let mut held_fences = std::collections::BTreeSet::new();
        for lease in &self.roots {
            held_fences.extend(lease.fence_identities()?);
        }
        held_fences.extend(self.source_retirement_lease_identities(id)?);
        let pending_controls = super::component_publication::pending_source_controls(self, id)?;
        for file in &pending_controls {
            held_fences.insert(super::component_publication::pending_control_identity(
                file,
            )?);
        }
        let inventory =
            super::inventory::inventory_tree_with_fences(&source, exclusions, &held_fences)
                .map_err(|error| {
                    super::writers::permission_context(
                        error,
                        format!(
                            "storage stopped source inventory: {}",
                            component.source.display()
                        ),
                    )
                })?;
        self.verify_control()?;
        ensure!(
            PrivateDirectory::open_existing(&component.source)?.directory_identity()?
                == inventory.root_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        Ok(inventory)
    }

    /// A recovered executor has lost its predecessor's exclusive interval.
    /// Recheck the original source, never raw-hash or overwrite converted target
    /// data. Within this held interval the successful copy already proved it.
    pub(super) fn verify_copied_component_source(&mut self, id: &str, domain: &str) -> Result<()> {
        let receipt = self.source_retirement_verification_receipt(id)?;
        if self.verified_copy_sources.contains(domain) {
            return Ok(());
        }
        let component = receipt
            .plan
            .components
            .iter()
            .find(|part| part.domain == domain)
            .context("STORAGE_DOMAIN_UNAVAILABLE")?;
        let binding = receipt
            .owner_receipts
            .get(&format!("copy-{domain}"))
            .context("STORAGE_TREE_MANIFEST_UNKNOWN")?;
        let binding: super::StorageTreeCopyBinding =
            serde_json::from_value(binding.clone()).context("STORAGE_TREE_MANIFEST_INVALID")?;
        let operations =
            optional_child(&self.directory, OPERATIONS)?.context("STORAGE_OPERATION_MISSING")?;
        let operation = optional_child(&operations, id)?.context("STORAGE_OPERATION_MISSING")?;
        let original = super::tree_copy::copied_source_inventory(
            &operation,
            id,
            domain,
            &component.source_identity,
            &binding,
        )?;
        let exclusions = original
            .entries
            .iter()
            .filter(|entry| entry.excluded)
            .map(|entry| entry.relative_path.clone())
            .collect();
        let source = self.verify_source_root(id, &component.source, &component.source_identity)?;
        let mut fences = BTreeSet::new();
        for lease in &self.roots {
            fences.extend(lease.fence_identities()?);
        }
        let actual = super::inventory::inventory_tree_with_fences(&source, &exclusions, &fences)?;
        self.verify_control()?;
        ensure!(actual == original, "STORAGE_TREE_SOURCE_CHANGED");
        self.verified_copy_sources.insert(domain.to_owned());
        Ok(())
    }

    pub(super) fn verify_copied_sources(&mut self, id: &str) -> Result<()> {
        let receipt = self.source_retirement_verification_receipt(id)?;
        self.assert_source_retirements_ready(id)?;
        for component in &receipt.plan.components {
            if component.source != component.destination
                && (receipt
                    .owner_receipts
                    .contains_key(&format!("copy-{}", component.domain))
                    || receipt
                        .owner_receipts
                        .contains_key(&format!("publish-{}", component.domain)))
            {
                self.verify_copied_component_source(id, &component.domain)?;
            }
        }
        Ok(())
    }

    /// Copy a declared component only under this original operation's exclusive
    /// stop leases. The bounded receipt binds the independently stored manifest.
    pub fn copy_component(
        &mut self,
        id: &str,
        domain: &str,
        staging: &PrivateDirectory,
        exclusions: &std::collections::BTreeSet<PathBuf>,
    ) -> Result<super::StorageTreeCopyReceipt> {
        self.copy_component_checked(id, domain, staging, exclusions, |_| Ok(()))
    }

    /// An owner can bind its frozen exclusions to the exact stable inventory
    /// used by the copier. Re-inventorying separately would leave a gap where a
    /// changed excluded leaf was silently omitted under its old path.
    pub fn copy_component_checked(
        &mut self,
        id: &str,
        domain: &str,
        staging: &PrivateDirectory,
        exclusions: &std::collections::BTreeSet<PathBuf>,
        validate_inventory: impl FnOnce(&super::StorageTreeInventory) -> Result<()>,
    ) -> Result<super::StorageTreeCopyReceipt> {
        let receipt = self.assert_offline_owner(id)?;
        self.verified_copy_sources.remove(domain);
        let component = receipt
            .plan
            .components
            .iter()
            .find(|entry| entry.domain == domain)
            .context("STORAGE_DOMAIN_UNAVAILABLE")?;
        let source = PrivateDirectory::open_existing(&component.source)?;
        ensure!(
            source.directory_identity()? == component.source_identity,
            "STORAGE_SOURCE_CHANGED"
        );
        let inventory = self.inventory_source(id, domain, exclusions)?;
        validate_inventory(&inventory)?;
        let mut target_fences = self.held_writer_fence_identities(id)?;
        let pending_control =
            super::component_publication::pending_target_control(self, id, staging)?;
        if let Some(file) = &pending_control {
            target_fences.insert(super::component_publication::pending_control_identity(
                file,
            )?);
        }
        let operation = self.offline_operation_directory(id)?;
        let key = format!("copy-{domain}");
        ensure!(key.len() <= 64, "STORAGE_OPERATION_INVALID");
        let mut previous = receipt.owner_receipts.get(&key).cloned();
        let expected = previous
            .clone()
            .map(serde_json::from_value::<super::StorageTreeCopyBinding>)
            .transpose()
            .context("STORAGE_TREE_MANIFEST_INVALID")?;
        let copied = super::tree_copy::copy_tree(
            &source,
            staging,
            &operation,
            id,
            domain,
            &inventory,
            &target_fences,
            expected.as_ref(),
            |binding| {
                let value = serde_json::to_value(binding)?;
                self.record_owner_receipt(id, &key, previous.as_ref(), value.clone())?;
                previous = Some(value);
                Ok(())
            },
        )
        .map_err(|error| {
            super::writers::permission_context(
                error,
                format!(
                    "storage stopped copy: {} -> {}",
                    component.source.display(),
                    component.destination.display()
                ),
            )
        })?;
        self.assert_offline_owner(id)?;
        self.verified_copy_sources.insert(domain.to_owned());
        Ok(copied)
    }

    pub fn acquire(home: &Path) -> Result<Self> {
        let directory = config_directory(home, true)?.context("STORAGE_CONTROL_UNAVAILABLE")?;
        let lease = directory
            .try_exclusive_lock(OsStr::new(LOCK))
            .map_err(|error| {
                super::writers::permission_context(
                    error,
                    format!(
                        "storage control lock access: {}",
                        home.join(".config").display()
                    ),
                )
            })?
            .context("STORAGE_MIGRATION_BUSY")?;
        let instances = directory
            .try_shared_lock(OsStr::new(INSTANCES))?
            .context("STORAGE_MIGRATION_BUSY")?;
        fs2::FileExt::unlock(&instances)?;
        let control = Self {
            directory,
            lease,
            path: home.join(".config"),
            instances,
            stopped_operation: None,
            verified_copy_sources: BTreeSet::new(),
            roots: Vec::new(),
            source_retirements: Vec::new(),
        };
        control.verify_control()?;
        Ok(control)
    }

    fn verify_control(&self) -> Result<()> {
        verify_control(&self.directory, &self.lease, &self.path)?;
        verify_instances(&self.directory, &self.instances)?;
        for root in &self.roots {
            if self.stopped_operation.is_some() {
                root.verify_stopped_access()?;
            } else {
                root.verify()?;
            }
        }
        for lease in &self.source_retirements {
            lease.identity()?;
        }
        Ok(())
    }

    fn require_stopped(&mut self, plan: &StorageMigrationPlan) -> Result<()> {
        self.verify_control()?;
        if self.stopped_operation.as_deref() == Some(&plan.operation_id) {
            return Ok(());
        }
        self.verified_copy_sources.clear();
        fs2::FileExt::try_lock_exclusive(&self.instances).map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
            {
                anyhow::anyhow!("STORAGE_WRITERS_ACTIVE")
            } else {
                error.into()
            }
        })?;
        let mut paths = vec![
            plan.from.data_root.clone(),
            plan.from.cache_root.clone(),
            plan.from.gateway_root.clone(),
            plan.from.desktop_root.clone(),
            plan.target.data_root.clone(),
            plan.target.cache_root.clone(),
            plan.target.data_root.join("studio/gateway"),
            plan.target.data_root.join("studio/desktop"),
        ];
        paths.extend(plan.components.iter().map(|part| part.source.clone()));
        let scanned = (|| -> Result<()> {
            for path in paths {
                super::writers::RootLease::exclusive_tree_existing(&path, &mut self.roots)?;
            }
            self.verify_control()
        })();
        if let Err(error) = scanned {
            // LockFileEx cannot acquire the same range twice on the same handle.
            // A blocked nested writer leaves this attempt incomplete; release
            // its instance lock so the original operation can retry after exit.
            fs2::FileExt::unlock(&self.instances).context("STORAGE_STOP_LOCK_RELEASE_FAILED")?;
            return Err(error);
        }
        // The complete scan is valid only for this operation's held exclusive
        // leases. Later callbacks verify those handles, without creating fences
        // in directories introduced by the copier after its inventory froze.
        self.stopped_operation = Some(plan.operation_id.clone());
        Ok(())
    }

    pub fn current(&self) -> Result<Option<StorageMigrationReceipt>> {
        self.verify_control()?;
        current(&self.directory)
    }

    /// Read an explicitly linked original operation. Owners must still verify
    /// its completed selection and exact entries before using historical facts.
    pub(super) fn prior_operation_receipt(&self, id: &str) -> Result<StorageMigrationReceipt> {
        self.verify_control()?;
        read_operation(&self.directory, id)?.context("STORAGE_OPERATION_MISSING")
    }

    /// Keep admission closed while the original host exits. Only real kernel
    /// exclusivity can advance stopping; a readiness message proves no shutdown.
    pub fn wait_for_stopped(
        &mut self,
        id: &str,
        wait: std::time::Duration,
    ) -> Result<StorageMigrationReceipt> {
        ensure!(
            wait <= std::time::Duration::from_secs(300),
            "STORAGE_OPERATION_INVALID"
        );
        let deadline = std::time::Instant::now() + wait;
        loop {
            let receipt = self.require(id)?;
            ensure!(
                receipt.disposition == Disposition::Active,
                "STORAGE_PHASE_INVALID"
            );
            match receipt.phase {
                Phase::Planned => {
                    self.advance(id, Phase::Planned, Phase::Stopping)?;
                }
                Phase::Stopping => match self.advance(id, Phase::Stopping, Phase::Stopped) {
                    Ok(receipt) => return Ok(receipt),
                    Err(error) if error.to_string() == "STORAGE_WRITERS_ACTIVE" => {}
                    Err(error) => return Err(error),
                },
                Phase::Stopped => {
                    self.require_stopped(&receipt.plan)?;
                    return Ok(receipt);
                }
                _ => anyhow::bail!("STORAGE_PHASE_INVALID"),
            }
            let now = std::time::Instant::now();
            ensure!(now < deadline, "STORAGE_STOP_TIMEOUT");
            std::thread::sleep(std::time::Duration::from_millis(25).min(deadline - now));
        }
    }

    fn write_receipt(&self, receipt: &StorageMigrationReceipt) -> Result<()> {
        self.verify_control()?;
        check_receipt(receipt)?;
        let bytes = serde_json::to_vec_pretty(receipt)?;
        ensure!(
            bytes.len() as u64 <= RECEIPT_LIMIT,
            "STORAGE_CONTROL_INVALID"
        );
        let operations = child(&self.directory, OPERATIONS)?;
        child(&operations, &receipt.plan.operation_id)?.atomic_replace(OsStr::new(RECEIPT), &bytes)
    }

    /// Reusing an ID reconciles the exact plan; it never accepts changed input.
    pub fn begin(&self, plan: StorageMigrationPlan) -> Result<StorageMigrationReceipt> {
        check_plan(&plan)?;
        let previous = self.current()?;
        if let Some(receipt) = &previous
            && receipt.plan.operation_id == plan.operation_id
        {
            ensure!(receipt.plan == plan, "STORAGE_OPERATION_CONFLICT");
            return Ok(receipt.clone());
        }
        let selected = location(&self.directory)?;
        if let Some(receipt) = &previous {
            require_settled_selection(receipt, selected.as_ref())?;
        }
        ensure!(selected == plan.original, "STORAGE_SELECTION_CHANGED");
        // A crash before current.json publication may have left this exact planned receipt.
        let receipt = match read_operation(&self.directory, &plan.operation_id)? {
            Some(receipt) => {
                ensure!(
                    receipt.plan == plan
                        && receipt.phase == Phase::Planned
                        && receipt.disposition == Disposition::Active,
                    "STORAGE_OPERATION_CONFLICT"
                );
                receipt
            }
            None => StorageMigrationReceipt {
                plan,
                phase: Phase::Planned,
                disposition: Disposition::Active,
                owner_receipts: Default::default(),
                error_code: None,
            },
        };
        self.write_receipt(&receipt)?;
        let operations = child(&self.directory, OPERATIONS)?;
        operations.atomic_replace(
            OsStr::new(CURRENT),
            &serde_json::to_vec(&receipt.plan.operation_id)?,
        )?;
        Ok(receipt)
    }

    pub fn advance(
        &mut self,
        id: &str,
        expected: Phase,
        next: Phase,
    ) -> Result<StorageMigrationReceipt> {
        ensure!(
            !matches!(next, Phase::Committed | Phase::Verified),
            "STORAGE_PHASE_INVALID"
        );
        let mut receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active
                && receipt.phase == expected
                && expected.next_phase() == Some(next),
            "STORAGE_PHASE_INVALID"
        );
        ensure!(
            location(&self.directory)? == receipt.plan.original,
            "STORAGE_SELECTION_CHANGED"
        );
        if next != Phase::Stopping {
            self.require_stopped(&receipt.plan)?;
        }
        if next == Phase::Stopped {
            super::component_publication::prepare_pending_in_place(
                &mut receipt,
                &self.directory,
                &self.path,
                &self.roots,
                |updated| self.write_receipt(updated),
            )?;
        }
        receipt.phase = next;
        receipt.error_code = None;
        self.write_receipt(&receipt)?;
        Ok(receipt)
    }

    fn require(&self, id: &str) -> Result<StorageMigrationReceipt> {
        check_id(id)?;
        let receipt = self.current()?.context("STORAGE_OPERATION_MISSING")?;
        ensure!(
            receipt.plan.operation_id == id,
            "STORAGE_OPERATION_CONFLICT"
        );
        Ok(receipt)
    }

    /// Publish only after final-path adapters have completed. A lost write receipt
    /// is reconciled against the same target/revision instead of repeating copy.
    pub fn commit(&mut self, id: &str) -> Result<StorageMigrationReceipt> {
        let mut receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active
                && matches!(receipt.phase, Phase::Prepared | Phase::Committed),
            "STORAGE_PHASE_INVALID"
        );
        self.verify_copied_sources(id)?;
        let selected = location(&self.directory)?;
        if selected.as_ref() != Some(&receipt.plan.target) {
            ensure!(
                receipt.phase == Phase::Prepared && selected == receipt.plan.original,
                "STORAGE_SELECTION_CHANGED"
            );
            self.directory.atomic_replace(
                OsStr::new(LOCATION),
                &serde_json::to_vec_pretty(&receipt.plan.target)?,
            )?;
        }
        receipt.phase = Phase::Committed;
        receipt.error_code = None;
        self.write_receipt(&receipt)?;
        Ok(receipt)
    }

    /// The one-shot verifier must have exited and released data handles first.
    pub fn complete(&mut self, id: &str) -> Result<StorageMigrationReceipt> {
        let mut receipt = self.require(id)?;
        ensure!(
            matches!(receipt.phase, Phase::Committed | Phase::Verified)
                && location(&self.directory)?.as_ref() == Some(&receipt.plan.target),
            "STORAGE_PHASE_INVALID"
        );
        if receipt.disposition != Disposition::Complete {
            self.verify_copied_sources(id)?;
            receipt.phase = Phase::Verified;
            receipt.disposition = Disposition::Complete;
            receipt.error_code = None;
            self.write_receipt(&receipt)?;
        }
        super::component_publication::cleanup_pending_complete(
            &receipt,
            &self.directory,
            &self.path,
            &mut self.roots,
        )?;
        self.verify_control()?;
        Ok(receipt)
    }

    /// Record a known step error without settling unknown effects or changing
    /// phase, selection or operation identity. A successful transition clears it.
    pub fn record_step_error(&self, id: &str, error_code: &str) -> Result<StorageMigrationReceipt> {
        let mut receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Active,
            "STORAGE_PHASE_INVALID"
        );
        ensure!(
            !error_code.is_empty()
                && error_code.len() <= 128
                && error_code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
            "STORAGE_OPERATION_INVALID"
        );
        if receipt.error_code.as_deref() != Some(error_code) {
            receipt.error_code = Some(error_code.to_owned());
            self.write_receipt(&receipt)?;
        }
        Ok(receipt)
    }

    /// Caller has removed only owned publications/staging and revalidated sources.
    pub fn defer_after_cleanup(
        &self,
        id: &str,
        error_code: &str,
    ) -> Result<StorageMigrationReceipt> {
        let mut receipt = self.require(id)?;
        ensure!(
            !matches!(receipt.phase, Phase::Committed | Phase::Verified)
                && location(&self.directory)? == receipt.plan.original,
            "STORAGE_PHASE_INVALID"
        );
        ensure!(
            !error_code.is_empty()
                && error_code.len() <= 128
                && error_code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'),
            "STORAGE_OPERATION_INVALID"
        );
        super::component_publication::cleanup_pending_in_place(
            &mut receipt,
            &self.directory,
            &self.path,
            &self.roots,
        )?;
        receipt.disposition = Disposition::Deferred;
        receipt.error_code = Some(error_code.to_owned());
        self.write_receipt(&receipt)?;
        Ok(receipt)
    }

    pub fn retry_deferred(&self, id: &str) -> Result<StorageMigrationReceipt> {
        let mut receipt = self.require(id)?;
        ensure!(
            receipt.disposition == Disposition::Deferred
                && location(&self.directory)? == receipt.plan.original,
            "STORAGE_PHASE_INVALID"
        );
        receipt.disposition = Disposition::Active;
        receipt.phase = Phase::Planned;
        receipt.error_code = None;
        self.write_receipt(&receipt)?;
        Ok(receipt)
    }
}
