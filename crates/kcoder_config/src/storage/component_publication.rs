//! Native ownership of one declared component's staging and final directory.
//!
//! This is a stopped-only publication primitive, not permission to migrate a
//! complete profile. Domain owners still adapt and verify their final paths.

use super::{StorageCoordinator, StorageTreeCopyBinding, StorageTreeInventory};
use crate::PrivateDirectory;
use anyhow::{Context, Result, ensure};
use kcoder_types::{StorageMigrationComponent, StorageMigrationReceipt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

const INTENT_LIMIT: usize = 256 * 1024;

#[path = "component_publication/cancel_cleanup.rs"]
mod cancel_cleanup;
pub(super) use cancel_cleanup::prepare_cancellation_components;

#[path = "component_pending.rs"]
mod pending;
pub(super) use pending::{
    admitted as assert_target_admitted, cleanup_complete as cleanup_pending_complete,
    cleanup_in_place as cleanup_pending_in_place, control_identity as pending_control_identity,
    prepare_in_place as prepare_pending_in_place, source_controls as pending_source_controls,
    target_control as pending_target_control,
    verify_in_place_control as verify_pending_in_place_control,
};

fn check_publication_version(intent: &PublicationIntent) -> Result<()> {
    ensure!(
        (1..=2).contains(&intent.version),
        "STORAGE_COMPONENT_VERSION_UNSUPPORTED"
    );
    Ok(())
}

/// Every variant retains the exact ordinary directory verified by the original
/// operation. Published directories are never passed back through raw copying:
/// a domain adapter may already have legitimately transformed their records.
#[derive(Debug)]
pub enum StorageComponentDirectory {
    InPlace(PrivateDirectory),
    Staging(PrivateDirectory),
    Published(PrivateDirectory),
}

/// The physical provenance of a component copied by one original operation.
/// The stopped writer and read-only metadata observer construct this fact after checking its
/// immutable publication intent and actual directory identities. It is neither
/// a cached authorization decision nor a replacement for the live coordinator's
/// stopped leases, source validation, or a domain owner's revocation checks.
#[derive(Debug)]
pub struct StoragePublishedComponent {
    directory: PrivateDirectory,
    source_path: PathBuf,
    destination_path: PathBuf,
    source_identity: String,
    domain: String,
    operation_id: String,
    final_identity: String,
}

impl StoragePublishedComponent {
    pub fn source_path(&self) -> &Path {
        &self.source_path
    }
    pub fn destination_path(&self) -> &Path {
        &self.destination_path
    }
    pub fn source_identity(&self) -> &str {
        &self.source_identity
    }
    pub fn domain(&self) -> &str {
        &self.domain
    }
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn directory(&self) -> &PrivateDirectory {
        &self.directory
    }

    /// Recheck the held directory and its current final name. This observes
    /// identity only and never caches permission or revocation as an allow verdict.
    pub fn verify(&self) -> Result<()> {
        let current = PrivateDirectory::open_existing(&self.destination_path)
            .context("STORAGE_COMPONENT_BINDING_CHANGED")?;
        ensure!(
            self.directory.directory_identity()? == self.final_identity
                && current.directory_identity()? == self.final_identity,
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        Ok(())
    }
}

impl std::ops::Deref for StoragePublishedComponent {
    type Target = PrivateDirectory;

    fn deref(&self) -> &Self::Target {
        self.directory()
    }
}

/// Rename publications retain the original staging identity. An existing selected
/// container keeps its own identity and needs an explicit verified-copy checkpoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PublicationIntent {
    version: u8,
    operation_id: String,
    domain: String,
    source_identity: String,
    destination: PathBuf,
    operation_directory_identity: String,
    target_parent_identity: String,
    staging_name: String,
    staging_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    container: Option<ContainerPublication>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContainerFence {
    name: String,
    identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ContainerPublication {
    fences: Vec<ContainerFence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    published_copy: Option<StorageTreeCopyBinding>,
}

struct PublicationContext {
    component: StorageMigrationComponent,
    source: PrivateDirectory,
    operation_directory: PrivateDirectory,
    parent: PrivateDirectory,
    parent_path: PathBuf,
    destination_name: OsString,
    staging_name: String,
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn owner_key(domain: &str) -> Result<String> {
    let key = format!("publish-{domain}");
    ensure!(
        !domain.is_empty()
            && key.len() <= 64
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "STORAGE_OPERATION_INVALID"
    );
    Ok(key)
}

fn staging_name(id: &str, domain: &str, destination_name: &OsStr) -> String {
    let mut name = format!(".kcoder-storage-{id}-{domain}");
    // The temporary directory must not be the final directory, including on a
    // filesystem where ASCII case variants name the same ordinary entry.
    if OsStr::new(&name).eq_ignore_ascii_case(destination_name) {
        name.push_str(".staging");
    }
    name
}

fn declared_component(
    coordinator: &mut StorageCoordinator,
    id: &str,
    domain: &str,
) -> Result<(
    StorageMigrationReceipt,
    StorageMigrationComponent,
    PrivateDirectory,
)> {
    let receipt = coordinator.assert_offline_owner(id)?;
    let (component, source) = observe_declared_component(&receipt, domain)?;
    Ok((receipt, component, source))
}

fn observe_declared_component(
    receipt: &StorageMigrationReceipt,
    domain: &str,
) -> Result<(StorageMigrationComponent, PrivateDirectory)> {
    owner_key(domain)?;
    let mut components = receipt
        .plan
        .components
        .iter()
        .filter(|part| part.domain == domain);
    let mut component = components
        .next()
        .context("STORAGE_DOMAIN_UNAVAILABLE")?
        .clone();
    ensure!(components.next().is_none(), "STORAGE_OPERATION_INVALID");
    component.source = super::resolve::absolute(&component.source)?;
    component.destination = super::resolve::absolute(&component.destination)?;
    let source = PrivateDirectory::open_existing(&component.source)?;
    ensure!(
        source.directory_identity()? == component.source_identity,
        "STORAGE_SOURCE_CHANGED"
    );
    Ok((component, source))
}

fn verify_target_bindings(receipt: &StorageMigrationReceipt, destination: &Path) -> Result<()> {
    for binding in &receipt.plan.target_bindings {
        let root = super::resolve::absolute(&binding.path)?;
        if destination.starts_with(&root) {
            let ancestor = PrivateDirectory::open_existing(&binding.existing_ancestor)
                .context("STORAGE_TARGET_CHANGED")?;
            ensure!(
                ancestor.directory_identity()? == binding.ancestor_identity,
                "STORAGE_TARGET_CHANGED"
            );
        }
    }
    Ok(())
}

fn publication_context(
    coordinator: &mut StorageCoordinator,
    receipt: &StorageMigrationReceipt,
    component: StorageMigrationComponent,
    source: PrivateDirectory,
) -> Result<PublicationContext> {
    let operation = coordinator.offline_operation_directory(&receipt.plan.operation_id)?;
    observed_publication_context(operation, receipt, component, source)
}

fn observed_publication_context(
    operation_directory: PrivateDirectory,
    receipt: &StorageMigrationReceipt,
    component: StorageMigrationComponent,
    source: PrivateDirectory,
) -> Result<PublicationContext> {
    ensure!(
        !component.destination.starts_with(&component.source)
            && !component.source.starts_with(&component.destination),
        "STORAGE_COMPONENT_ROOTS_OVERLAP"
    );
    verify_target_bindings(receipt, &component.destination)?;
    let parent_path = component
        .destination
        .parent()
        .context("STORAGE_PATH_INVALID")?
        .to_owned();
    let destination_name = component
        .destination
        .file_name()
        .context("STORAGE_PATH_INVALID")?
        .to_owned();
    let parent = PrivateDirectory::open_existing(&parent_path)
        .context("STORAGE_TARGET_PARENT_UNAVAILABLE")?;
    // Detect a source alias introduced by an ordinary mount as well as a direct
    // lexical descendant. No source directory is used to hold migration staging.
    let mut ancestor = Some(parent_path.as_path());
    let mut depth = 0;
    while let Some(path) = ancestor {
        ensure!(depth < 256, "STORAGE_PATH_INVALID");
        ensure!(
            PrivateDirectory::open_existing(path)?.directory_identity()?
                != component.source_identity,
            "STORAGE_COMPONENT_ROOTS_OVERLAP"
        );
        ancestor = path.parent();
        depth += 1;
    }
    let staging_name = staging_name(
        &receipt.plan.operation_id,
        &component.domain,
        &destination_name,
    );
    ensure!(
        parent.directory_identity()? != operation_directory.directory_identity()?,
        "STORAGE_COMPONENT_CONTROL_OVERLAP"
    );
    Ok(PublicationContext {
        component,
        source,
        operation_directory,
        parent,
        parent_path,
        destination_name,
        staging_name,
    })
}

impl PublicationContext {
    fn verify_attachment(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.parent_path)?.directory_identity()?
                == self.parent.directory_identity()?
                && PrivateDirectory::open_existing(&self.component.source)?.directory_identity()?
                    == self.source.directory_identity()?
                && self.source.directory_identity()? == self.component.source_identity,
            "STORAGE_COMPONENT_BINDING_CHANGED"
        );
        Ok(())
    }

    fn intent(&self, id: &str, staging_identity: String) -> Result<PublicationIntent> {
        Ok(PublicationIntent {
            version: 1,
            operation_id: id.to_owned(),
            domain: self.component.domain.clone(),
            source_identity: self.component.source_identity.clone(),
            destination: self.component.destination.clone(),
            operation_directory_identity: self.operation_directory.directory_identity()?,
            target_parent_identity: self.parent.directory_identity()?,
            staging_name: self.staging_name.clone(),
            staging_identity,
            container: None,
        })
    }

    fn validate_intent(&self, id: &str, intent: &PublicationIntent) -> Result<()> {
        check_publication_version(intent)?;
        let mut expected = self.intent(id, intent.staging_identity.clone())?;
        if let Some(container) = &intent.container {
            ensure!(intent.version == 2, "STORAGE_COMPONENT_RECEIPT_CONFLICT");
            expected.version = 2;
            expected.staging_name.clear();
            expected.container = Some(container.clone());
        } else {
            ensure!(intent.version == 1, "STORAGE_COMPONENT_RECEIPT_CONFLICT");
        }
        ensure!(
            !intent.staging_identity.is_empty()
                && intent.staging_identity.len() <= 256
                && *intent == expected
                && intent.staging_identity != intent.source_identity
                && intent.staging_identity != intent.target_parent_identity
                && intent.staging_identity != intent.operation_directory_identity,
            "STORAGE_COMPONENT_RECEIPT_CONFLICT"
        );
        self.verify_attachment()
    }
}

fn optional_directory(parent: &PrivateDirectory, name: &OsStr) -> Result<Option<PrivateDirectory>> {
    let entry = match parent.open_entry_handle(name) {
        Ok(entry) => entry,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error.context("STORAGE_COMPONENT_TARGET_UNKNOWN")),
    };
    ensure!(
        entry.metadata().is_dir() && !entry.metadata().is_symlink(),
        "STORAGE_COMPONENT_TARGET_UNKNOWN"
    );
    Ok(Some(
        entry
            .open_child_directory()
            .context("STORAGE_COMPONENT_TARGET_UNKNOWN")?,
    ))
}

fn reconcile(
    context: &PublicationContext,
    intent: Option<&PublicationIntent>,
) -> Result<Option<StorageComponentDirectory>> {
    context.verify_attachment()?;
    if let Some(intent) = intent.filter(|intent| intent.container.is_some()) {
        let directory = optional_directory(&context.parent, &context.destination_name)?
            .context("STORAGE_COMPONENT_TARGET_UNKNOWN")?;
        ensure!(
            directory.directory_identity()? == intent.staging_identity,
            "STORAGE_COMPONENT_TARGET_UNKNOWN"
        );
        return Ok(Some(
            if intent.container.as_ref().unwrap().published_copy.is_some() {
                StorageComponentDirectory::Published(directory)
            } else {
                StorageComponentDirectory::Staging(directory)
            },
        ));
    }
    let staging = optional_directory(&context.parent, OsStr::new(&context.staging_name))?;
    let final_directory = optional_directory(&context.parent, &context.destination_name)?;
    match (intent, staging, final_directory) {
        (None, None, None) => Ok(None),
        (Some(intent), Some(staging), None)
            if staging.directory_identity()? == intent.staging_identity =>
        {
            Ok(Some(StorageComponentDirectory::Staging(staging)))
        }
        (Some(intent), None, Some(final_directory))
            if final_directory.directory_identity()? == intent.staging_identity =>
        {
            Ok(Some(StorageComponentDirectory::Published(final_directory)))
        }
        _ => anyhow::bail!("STORAGE_COMPONENT_TARGET_UNKNOWN"),
    }
}

fn read_intent(receipt: &StorageMigrationReceipt, key: &str) -> Result<Option<PublicationIntent>> {
    receipt
        .owner_receipts
        .get(key)
        .cloned()
        .map(|value| {
            ensure!(
                serde_json::to_vec(&value)?.len() <= INTENT_LIMIT,
                "STORAGE_COMPONENT_RECEIPT_BUDGET_EXCEEDED"
            );
            serde_json::from_value(value).context("STORAGE_COMPONENT_RECEIPT_INVALID")
        })
        .transpose()
}

fn directory_identity_metadata(identity: &str) -> bool {
    let parts: Vec<_> = identity.split(':').collect();
    match parts.as_slice() {
        ["unix", device, inode] => [device, inode].iter().all(|value| {
            value
                .parse::<u64>()
                .is_ok_and(|number| number.to_string() == **value)
        }),
        ["windows", volume, high, low] => [volume, high, low].iter().all(|value| {
            value
                .parse::<u32>()
                .is_ok_and(|number| number.to_string() == **value)
        }),
        _ => false,
    }
}

/// Read-only refusal scopes, never publication or writer authority. The startup
/// gate checks both bound path containment and actual held ancestor identities:
/// the latter still refuses a published directory renamed away from its plan.
/// Only small original owner receipts are inspected; no tree or manifest is read.
pub(super) fn active_component_directory_scopes(
    receipt: &StorageMigrationReceipt,
) -> Result<BTreeMap<PathBuf, String>> {
    super::control::check_plan(&receipt.plan)?;
    let mut scopes = BTreeMap::new();
    for key in receipt
        .owner_receipts
        .keys()
        .filter(|key| key.starts_with("publish-"))
    {
        let domain = key.strip_prefix("publish-").unwrap();
        ensure!(
            owner_key(domain)? == *key,
            "STORAGE_COMPONENT_RECEIPT_CONFLICT"
        );
        let mut declared = receipt
            .plan
            .components
            .iter()
            .filter(|part| part.domain == domain);
        let component = declared
            .next()
            .context("STORAGE_COMPONENT_RECEIPT_CONFLICT")?;
        ensure!(
            declared.next().is_none(),
            "STORAGE_COMPONENT_RECEIPT_CONFLICT"
        );
        let intent = read_intent(receipt, key)?.context("STORAGE_COMPONENT_RECEIPT_INVALID")?;
        check_publication_version(&intent)?;
        let source = super::resolve::absolute(&component.source)?;
        let destination = super::resolve::absolute(&component.destination)?;
        let parent = destination.parent().context("STORAGE_PATH_INVALID")?;
        let name = destination.file_name().context("STORAGE_PATH_INVALID")?;
        ensure!(
            intent.operation_id == receipt.plan.operation_id
                && intent.domain == domain
                && intent.source_identity == component.source_identity
                && intent.destination == destination
                && !destination.starts_with(&source)
                && !source.starts_with(&destination)
                && [
                    &intent.source_identity,
                    &intent.operation_directory_identity,
                    &intent.target_parent_identity,
                    &intent.staging_identity
                ]
                .iter()
                .all(|identity| directory_identity_metadata(identity))
                && intent.staging_identity != intent.source_identity
                && intent.staging_identity != intent.target_parent_identity
                && intent.staging_identity != intent.operation_directory_identity
                && intent.target_parent_identity != intent.operation_directory_identity,
            "STORAGE_COMPONENT_RECEIPT_CONFLICT"
        );
        let mut paths = vec![destination.clone()];
        if let Some(container) = &intent.container {
            ensure!(
                intent.version == 2
                    && intent.staging_name.is_empty()
                    && !container.fences.is_empty()
                    && destination == super::resolve::absolute(&receipt.plan.target.data_root)?
                    && receipt.plan.target_bindings.iter().any(|binding| {
                        super::resolve::absolute(&binding.path).ok().as_ref() == Some(&destination)
                            && super::resolve::absolute(&binding.existing_ancestor)
                                .ok()
                                .as_ref()
                                == Some(&destination)
                            && binding.ancestor_identity == intent.staging_identity
                    }),
                "STORAGE_COMPONENT_RECEIPT_CONFLICT"
            );
            let mut fence_names = BTreeSet::new();
            for fence in &container.fences {
                ensure!(
                    !fence.name.is_empty()
                        && fence.name.len() <= 255
                        && fence.name.is_ascii()
                        && !matches!(fence.name.as_str(), "." | "..")
                        && !fence.name.bytes().any(|byte| b"/\\\0".contains(&byte))
                        && fence_names.insert(&fence.name)
                        && serde_json::from_str::<crate::PortableLeaseIdentity>(&fence.identity)
                            .is_ok(),
                    "STORAGE_COMPONENT_RECEIPT_CONFLICT"
                );
            }
            if let Some(binding) = &container.published_copy {
                ensure!(
                    binding.matches_component_scope(
                        &intent.operation_id,
                        domain,
                        &intent.operation_directory_identity,
                        &intent.source_identity,
                        &intent.staging_identity
                    ),
                    "STORAGE_COMPONENT_RECEIPT_CONFLICT"
                );
            }
        } else {
            ensure!(
                intent.version == 1
                    && intent.staging_name == staging_name(&intent.operation_id, domain, name),
                "STORAGE_COMPONENT_RECEIPT_CONFLICT"
            );
            paths.push(parent.join(&intent.staging_name));
        }
        for path in paths {
            if let Some(previous) = scopes.insert(path, intent.staging_identity.clone()) {
                ensure!(
                    previous == intent.staging_identity,
                    "STORAGE_COMPONENT_RECEIPT_CONFLICT"
                );
            }
        }
    }
    Ok(scopes)
}

fn selected_container_binding(
    receipt: &StorageMigrationReceipt,
    context: &PublicationContext,
    directory: &PrivateDirectory,
) -> Result<()> {
    let identity = directory.directory_identity()?;
    let destination = &context.component.destination;
    ensure!(
        *destination == super::resolve::absolute(&receipt.plan.target.data_root)?
            && receipt.plan.target_bindings.iter().any(|binding| {
                super::resolve::absolute(&binding.path).ok().as_ref() == Some(destination)
                    && super::resolve::absolute(&binding.existing_ancestor)
                        .ok()
                        .as_ref()
                        == Some(destination)
                    && binding.ancestor_identity == identity
            }),
        "STORAGE_COMPONENT_TARGET_UNKNOWN"
    );
    Ok(())
}

fn empty_container_fences(
    directory: &PrivateDirectory,
    held: &BTreeSet<String>,
) -> Result<Vec<ContainerFence>> {
    let mut fences = Vec::new();
    directory.visit_entry_names_bounded(65_536, |name| {
        let entry = directory.open_entry_handle(name)?;
        ensure!(
            entry.metadata().is_file() && entry.metadata().len() == 0,
            "STORAGE_COMPONENT_TARGET_UNKNOWN"
        );
        let identity = entry.identity()?;
        ensure!(held.contains(&identity), "STORAGE_COMPONENT_TARGET_UNKNOWN");
        // Runtime fence basenames are ASCII. Do not convert an arbitrary native
        // data filename lossily into a supposedly owned control locator.
        let name = name
            .to_str()
            .context("STORAGE_COMPONENT_TARGET_UNKNOWN")?
            .to_owned();
        fences.push(ContainerFence { name, identity });
        Ok(())
    })?;
    ensure!(!fences.is_empty(), "STORAGE_COMPONENT_TARGET_UNKNOWN");
    fences.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(fences)
}

fn validate_record(
    coordinator: &mut StorageCoordinator,
    id: &str,
    context: &PublicationContext,
    intent: &PublicationIntent,
) -> Result<()> {
    let receipt = coordinator.assert_offline_owner(id)?;
    validate_record_metadata(&receipt, id, context, intent)?;
    if let Some(container) = &intent.container {
        let held = coordinator.held_writer_fence_identities(id)?;
        ensure!(
            container
                .fences
                .iter()
                .all(|fence| held.contains(&fence.identity)),
            "STORAGE_COMPONENT_FENCE_CHANGED"
        );
    }
    Ok(())
}

fn validate_record_metadata(
    receipt: &StorageMigrationReceipt,
    id: &str,
    context: &PublicationContext,
    intent: &PublicationIntent,
) -> Result<()> {
    context.validate_intent(id, intent)?;
    let Some(container) = &intent.container else {
        return Ok(());
    };
    let directory = optional_directory(&context.parent, &context.destination_name)?
        .context("STORAGE_COMPONENT_TARGET_UNKNOWN")?;
    ensure!(
        directory.directory_identity()? == intent.staging_identity && !container.fences.is_empty(),
        "STORAGE_COMPONENT_TARGET_UNKNOWN"
    );
    selected_container_binding(receipt, context, &directory)?;
    for fence in &container.fences {
        let entry = directory.open_entry_handle(OsStr::new(&fence.name))?;
        ensure!(
            entry.metadata().is_file()
                && entry.metadata().len() == 0
                && entry.identity()? == fence.identity,
            "STORAGE_COMPONENT_FENCE_CHANGED"
        );
    }
    if let Some(binding) = &container.published_copy {
        ensure!(
            binding.matches_component_scope(
                id,
                &context.component.domain,
                &context.operation_directory.directory_identity()?,
                &context.component.source_identity,
                &intent.staging_identity
            ),
            "STORAGE_COMPONENT_RECEIPT_CONFLICT"
        );
    }
    Ok(())
}

/// Observe original publication metadata while the offline executor retains its
/// exclusive leases. This creates no directory, takes no writer lease and grants
/// no stop, mutation, domain or execution authority. Domain owners still verify
/// their own original source and final bindings.
pub fn observe_published_storage_component(
    home: &Path,
    id: &str,
    domain: &str,
) -> Result<StoragePublishedComponent> {
    use kcoder_types::{
        StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase,
    };
    let receipt = super::read_storage_migration(home)?.context("STORAGE_OPERATION_MISSING")?;
    ensure!(
        receipt.plan.operation_id == id
            && receipt.disposition == Disposition::Active
            && matches!(
                receipt.phase,
                Phase::Copying | Phase::Verifying | Phase::Prepared | Phase::Committed
            ),
        "STORAGE_PHASE_INVALID"
    );
    let (component, source) = observe_declared_component(&receipt, domain)?;
    ensure!(
        component.source != component.destination,
        "STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"
    );
    let intent = read_intent(&receipt, &owner_key(domain)?)?
        .context("STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED")?;
    let operation = super::control::observe_operation_directory(home, id)?;
    let context = observed_publication_context(operation, &receipt, component, source)?;
    validate_record_metadata(&receipt, id, &context, &intent)?;
    let directory = match reconcile(&context, Some(&intent))? {
        Some(StorageComponentDirectory::Published(directory)) => directory,
        _ => anyhow::bail!("STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"),
    };
    ensure!(
        super::control::observe_operation_directory(home, id)?.directory_identity()?
            == context.operation_directory.directory_identity()?
            && super::read_storage_migration(home)?.as_ref() == Some(&receipt),
        "STORAGE_COMPONENT_BINDING_CHANGED"
    );
    let published = StoragePublishedComponent {
        directory,
        source_path: context.component.source,
        destination_path: context.component.destination,
        source_identity: context.component.source_identity,
        domain: context.component.domain,
        operation_id: id.to_owned(),
        final_identity: intent.staging_identity,
    };
    published.verify()?;
    Ok(published)
}

fn prepare_selected_container(
    coordinator: &mut StorageCoordinator,
    id: &str,
    receipt: &StorageMigrationReceipt,
    context: &PublicationContext,
) -> Result<Option<StorageComponentDirectory>> {
    let Some(directory) = optional_directory(&context.parent, &context.destination_name)? else {
        return Ok(None);
    };
    selected_container_binding(receipt, context, &directory)?;
    let held = coordinator.held_writer_fence_identities(id)?;
    let fences = empty_container_fences(&directory, &held)?;
    let mut intent = context.intent(id, directory.directory_identity()?)?;
    intent.version = 2;
    intent.staging_name.clear();
    intent.container = Some(ContainerPublication {
        fences,
        published_copy: None,
    });
    validate_record(coordinator, id, context, &intent)?;
    let value = serde_json::to_value(&intent)?;
    ensure!(
        serde_json::to_vec(&value)?.len() <= INTENT_LIMIT,
        "STORAGE_COMPONENT_RECEIPT_BUDGET_EXCEEDED"
    );
    verify_operation_attachment(coordinator, id, context)?;
    coordinator.record_owner_receipt(id, &owner_key(&context.component.domain)?, None, value)?;
    validate_record(coordinator, id, context, &intent)?;
    Ok(Some(StorageComponentDirectory::Staging(directory)))
}

fn verify_operation_attachment(
    coordinator: &mut StorageCoordinator,
    id: &str,
    context: &PublicationContext,
) -> Result<()> {
    context.verify_attachment()?;
    ensure!(
        coordinator
            .offline_operation_directory(id)?
            .directory_identity()?
            == context.operation_directory.directory_identity()?,
        "STORAGE_COMPONENT_BINDING_CHANGED"
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PublicationCheckpoint {
    CreatedBeforeReceipt,
    BeforeRename,
    #[cfg(windows)]
    TargetFencesReleasedBeforeRename,
    RenamedBeforeReturn,
    ContainerCopiedBeforePublication,
    ContainerPublishedBeforeReturn,
}

fn prepare_with_hook(
    coordinator: &mut StorageCoordinator,
    id: &str,
    domain: &str,
    checkpoint: &mut impl FnMut(PublicationCheckpoint) -> Result<()>,
) -> Result<StorageComponentDirectory> {
    let (receipt, component, source) = declared_component(coordinator, id, domain)?;
    if component.source == component.destination {
        return Ok(StorageComponentDirectory::InPlace(source));
    }
    let key = owner_key(domain)?;
    let context = publication_context(coordinator, &receipt, component, source)?;
    let intent = read_intent(&receipt, &key)?;
    if let Some(intent) = &intent {
        validate_record(coordinator, id, &context, intent)?;
    } else if let Some(directory) = prepare_selected_container(coordinator, id, &receipt, &context)?
    {
        let held = match &directory {
            StorageComponentDirectory::InPlace(held)
            | StorageComponentDirectory::Staging(held)
            | StorageComponentDirectory::Published(held) => held,
        };
        coordinator.fence_component_directory(&context.component.destination, held)?;
        pending::prepare(coordinator, id, domain, held)?;
        return Ok(directory);
    }
    if let Some(directory) = reconcile(&context, intent.as_ref())? {
        let path = if intent
            .as_ref()
            .is_some_and(|intent| intent.container.is_some())
            || matches!(&directory, StorageComponentDirectory::Published(_))
        {
            context.component.destination.clone()
        } else {
            context.parent_path.join(&context.staging_name)
        };
        let held = match &directory {
            StorageComponentDirectory::InPlace(held)
            | StorageComponentDirectory::Staging(held)
            | StorageComponentDirectory::Published(held) => held,
        };
        coordinator.fence_component_directory(&path, held)?;
        pending::prepare(coordinator, id, domain, held)?;
        verify_operation_attachment(coordinator, id, &context)?;
        return Ok(directory);
    }
    verify_operation_attachment(coordinator, id, &context)?;
    let staging = context
        .parent
        .create_child(OsStr::new(&context.staging_name))?;
    coordinator
        .fence_component_directory(&context.parent_path.join(&context.staging_name), &staging)?;
    pending::prepare(coordinator, id, domain, &staging)?;
    checkpoint(PublicationCheckpoint::CreatedBeforeReceipt)?;
    let intent = context.intent(id, staging.directory_identity()?)?;
    let value = serde_json::to_value(&intent)?;
    ensure!(
        serde_json::to_vec(&value)?.len() <= INTENT_LIMIT,
        "STORAGE_COMPONENT_RECEIPT_BUDGET_EXCEEDED"
    );
    // A crash before this CAS leaves an unknown directory. It is deliberately
    // not adopted, removed, or regenerated from its operation-shaped filename.
    verify_operation_attachment(coordinator, id, &context)?;
    coordinator.record_owner_receipt(id, &key, None, value)?;
    verify_operation_attachment(coordinator, id, &context)?;
    validate_record(coordinator, id, &context, &intent)?;
    match reconcile(&context, Some(&intent))? {
        Some(StorageComponentDirectory::Staging(current)) => {
            ensure!(
                current.directory_identity()? == staging.directory_identity()?,
                "STORAGE_COMPONENT_BINDING_CHANGED"
            );
            Ok(StorageComponentDirectory::Staging(staging))
        }
        _ => anyhow::bail!("STORAGE_COMPONENT_TARGET_UNKNOWN"),
    }
}

fn publish_with_hook(
    coordinator: &mut StorageCoordinator,
    id: &str,
    domain: &str,
    exclusions: &BTreeSet<PathBuf>,
    validate_inventory: impl FnOnce(&StorageTreeInventory) -> Result<()>,
    mut checkpoint: impl FnMut(PublicationCheckpoint) -> Result<()>,
) -> Result<StorageComponentDirectory> {
    let staging = match prepare_with_hook(coordinator, id, domain, &mut checkpoint)? {
        StorageComponentDirectory::Staging(staging) => staging,
        StorageComponentDirectory::Published(directory) => {
            coordinator.verify_copied_component_source(id, domain)?;
            return Ok(StorageComponentDirectory::Published(directory));
        }
        settled => return Ok(settled),
    };
    // Before rename the raw payload must still agree with the original copy
    // manifest. Missing prepared payloads may be rebuilt only inside this stage.
    coordinator.copy_component_checked(id, domain, &staging, exclusions, validate_inventory)?;
    let (receipt, component, source) = declared_component(coordinator, id, domain)?;
    let context = publication_context(coordinator, &receipt, component, source)?;
    let intent =
        read_intent(&receipt, &owner_key(domain)?)?.context("STORAGE_COMPONENT_RECEIPT_MISSING")?;
    validate_record(coordinator, id, &context, &intent)?;
    ensure!(
        staging.directory_identity()? == intent.staging_identity,
        "STORAGE_COMPONENT_BINDING_CHANGED"
    );
    match reconcile(&context, Some(&intent))? {
        Some(StorageComponentDirectory::Staging(_)) => {}
        _ => anyhow::bail!("STORAGE_COMPONENT_TARGET_UNKNOWN"),
    }
    if intent.container.is_some() {
        checkpoint(PublicationCheckpoint::ContainerCopiedBeforePublication)?;
        let current = coordinator.assert_offline_owner(id)?;
        let copy_key = format!("copy-{domain}");
        let binding: StorageTreeCopyBinding = serde_json::from_value(
            current
                .owner_receipts
                .get(&copy_key)
                .context("STORAGE_TREE_MANIFEST_UNKNOWN")?
                .clone(),
        )?;
        let mut published = intent.clone();
        published.container.as_mut().unwrap().published_copy = Some(binding);
        validate_record(coordinator, id, &context, &published)?;
        let key = owner_key(domain)?;
        let expected = current
            .owner_receipts
            .get(&key)
            .context("STORAGE_COMPONENT_RECEIPT_MISSING")?;
        let value = serde_json::to_value(&published)?;
        ensure!(
            serde_json::to_vec(&value)?.len() <= INTENT_LIMIT,
            "STORAGE_COMPONENT_RECEIPT_BUDGET_EXCEEDED"
        );
        verify_operation_attachment(coordinator, id, &context)?;
        coordinator.record_owner_receipt(id, &key, Some(expected), value)?;
        checkpoint(PublicationCheckpoint::ContainerPublishedBeforeReturn)?;
        verify_operation_attachment(coordinator, id, &context)?;
        validate_record(coordinator, id, &context, &published)?;
        return match reconcile(&context, Some(&published))? {
            Some(StorageComponentDirectory::Published(directory)) => {
                Ok(StorageComponentDirectory::Published(directory))
            }
            _ => anyhow::bail!("STORAGE_COMPONENT_TARGET_UNKNOWN"),
        };
    }
    let original_entry = context
        .parent
        .open_entry_handle(OsStr::new(&intent.staging_name))?;
    ensure!(
        original_entry.metadata().is_dir()
            && !original_entry.metadata().is_symlink()
            && original_entry.identity()? == intent.staging_identity,
        "STORAGE_COMPONENT_TARGET_UNKNOWN"
    );
    checkpoint(PublicationCheckpoint::BeforeRename)?;
    verify_operation_attachment(coordinator, id, &context)?;
    validate_record(coordinator, id, &context, &intent)?;
    // Both names belong to this one held parent. Source data is never renamed,
    // and the filesystem primitive cannot overwrite a racing final directory.
    #[cfg(windows)]
    coordinator.rename_component_directory(
        id,
        domain,
        &staging,
        &context.parent_path.join(&context.staging_name),
        &context.component.destination,
        || {
            checkpoint(PublicationCheckpoint::TargetFencesReleasedBeforeRename)?;
            original_entry
                .rename_directory_entry_no_replace(&context.destination_name)
                .context("STORAGE_COMPONENT_DIRECTORY_PUBLICATION_FAILED")
        },
    )?;
    #[cfg(not(windows))]
    original_entry
        .rename_directory_entry_no_replace(&context.destination_name)
        .context("STORAGE_COMPONENT_DIRECTORY_PUBLICATION_FAILED")?;
    #[cfg(not(windows))]
    coordinator.follow_component_rename(
        &staging,
        &context.parent_path.join(&context.staging_name),
        &context.component.destination,
    )?;
    checkpoint(PublicationCheckpoint::RenamedBeforeReturn)?;
    verify_operation_attachment(coordinator, id, &context)?;
    validate_record(coordinator, id, &context, &intent)?;
    match reconcile(&context, Some(&intent))? {
        Some(StorageComponentDirectory::Published(directory)) => {
            Ok(StorageComponentDirectory::Published(directory))
        }
        _ => anyhow::bail!("STORAGE_COMPONENT_TARGET_UNKNOWN"),
    }
}

impl StorageCoordinator {
    /// Open only an already-published directory authenticated by this original
    /// operation. This never prepares a stage, copies payloads, or writes a receipt.
    pub fn open_published_component(
        &mut self,
        id: &str,
        domain: &str,
    ) -> Result<StoragePublishedComponent> {
        let (receipt, component, source) = declared_component(self, id, domain)?;
        let intent = read_intent(&receipt, &owner_key(domain)?)?
            .context("STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED")?;
        ensure!(
            component.source != component.destination,
            "STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"
        );
        let context = publication_context(self, &receipt, component, source)?;
        validate_record(self, id, &context, &intent)?;
        let directory = match reconcile(&context, Some(&intent))? {
            Some(StorageComponentDirectory::Published(directory)) => directory,
            _ => anyhow::bail!("STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"),
        };
        verify_operation_attachment(self, id, &context)?;
        let published = StoragePublishedComponent {
            directory,
            source_path: context.component.source.clone(),
            destination_path: context.component.destination.clone(),
            source_identity: context.component.source_identity.clone(),
            domain: context.component.domain.clone(),
            operation_id: id.to_owned(),
            final_identity: intent.staging_identity,
        };
        published.verify()?;
        self.verify_copied_component_source(id, domain)?;
        Ok(published)
    }

    /// Create or recover an original operation's exact component directory.
    /// The final parent must already exist. A frozen, user-selected empty data
    /// root remains its own container; every other unknown staging/final entry
    /// fails closed, including unrecorded directories left by interrupted creation.
    pub fn prepare_component_staging(
        &mut self,
        id: &str,
        domain: &str,
    ) -> Result<StorageComponentDirectory> {
        prepare_with_hook(self, id, domain, &mut |_| Ok(()))
    }

    /// Copy/verify the original stage and publish its same-volume final name.
    /// Already published directories only reconcile physical ownership: domain
    /// adapters may have converted their contents and are verified by their owner.
    pub fn publish_component(
        &mut self,
        id: &str,
        domain: &str,
        exclusions: &BTreeSet<PathBuf>,
    ) -> Result<StorageComponentDirectory> {
        self.publish_component_checked(id, domain, exclusions, |_| Ok(()))
    }

    /// Validate owner exclusions against the one inventory used for copying.
    /// Recovered published contents may already be converted, so neither the
    /// callback nor raw copying runs again after publication is confirmed.
    pub fn publish_component_checked(
        &mut self,
        id: &str,
        domain: &str,
        exclusions: &BTreeSet<PathBuf>,
        validate_inventory: impl FnOnce(&StorageTreeInventory) -> Result<()>,
    ) -> Result<StorageComponentDirectory> {
        publish_with_hook(self, id, domain, exclusions, validate_inventory, |_| Ok(()))
    }
}

#[cfg(test)]
#[path = "component_publication_tests.rs"]
mod tests;
