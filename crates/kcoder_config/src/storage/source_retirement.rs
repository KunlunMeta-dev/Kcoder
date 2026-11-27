//! Source-local refusal facts. These do not revoke or recreate a Native identity.
use super::{StorageCoordinator, read_storage_location_record, read_storage_operation};
use crate::{PortableLeaseIdentity, PrivateDirectory};
use anyhow::{Context, Result, ensure};
use kcoder_types::{
    StorageMigrationDisposition as Disposition, StorageMigrationPhase as Phase,
    StorageMigrationPlan, StorageMigrationReceipt,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

pub const SOURCE_RETIREMENT_LIMIT: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageRootRole {
    Native,
    Gateway,
    Desktop,
}

impl StorageRootRole {
    pub const ALL: [Self; 3] = [Self::Native, Self::Gateway, Self::Desktop];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Gateway => "gateway",
            Self::Desktop => "desktop",
        }
    }
    pub fn leaf(self) -> &'static str {
        match self {
            Self::Native => "kcoder-storage-retired-native.json",
            Self::Gateway => "kcoder-storage-retired-gateway.json",
            Self::Desktop => "kcoder-storage-retired-desktop.json",
        }
    }
    fn owner_key(self) -> String {
        format!("source-retirement-{}", self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageSourceRetirementMarker {
    version: u8,
    operation_id: String,
    role: StorageRootRole,
    source_root: PathBuf,
    source_identity: String,
    target_root: PathBuf,
    selection_revision: u64,
    control_directory: PathBuf,
    control_identity: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u8,
    marker: StorageSourceRetirementMarker,
    marker_identity: String,
    marker_sha256: String,
    cleaned: bool,
}

/// Only this module constructs registered exclusions from actual private handles.
pub(super) struct StorageSourceRetirementLease {
    operation_id: String,
    root_path: PathBuf,
    root: PrivateDirectory,
    name: String,
    file: File,
    identity: String,
    sha256: String,
}

impl StorageSourceRetirementLease {
    pub(super) fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub(super) fn identity(&self) -> Result<String> {
        let named = self
            .root
            .open_single_link_regular_file(OsStr::new(&self.name))?;
        ensure!(
            PrivateDirectory::open_existing(&self.root_path)?.directory_identity()?
                == self.root.directory_identity()?
                && file_identity(&self.file)? == self.identity
                && digest(&bytes(&named)?) == self.sha256
                && file_identity(&named)? == self.identity,
            "STORAGE_SOURCE_RETIREMENT_CHANGED"
        );
        Ok(self.identity.clone())
    }
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

fn file_identity(file: &File) -> Result<String> {
    Ok(serde_json::to_string(
        &PortableLeaseIdentity::from_private_regular_handle(file)?,
    )?)
}

fn bytes(file: &File) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() <= SOURCE_RETIREMENT_LIMIT as u64,
        "STORAGE_SOURCE_RETIREMENT_INVALID"
    );
    let mut content = Vec::new();
    let mut reader = file;
    reader.seek(SeekFrom::Start(0))?;
    reader
        .take(SOURCE_RETIREMENT_LIMIT as u64 + 1)
        .read_to_end(&mut content)?;
    ensure!(
        content.len() <= SOURCE_RETIREMENT_LIMIT,
        "STORAGE_SOURCE_RETIREMENT_INVALID"
    );
    Ok(content)
}

fn digest(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn optional_file(root: &PrivateDirectory, name: &str) -> Result<Option<File>> {
    match root.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => {
            file_identity(&file)?;
            Ok(Some(file))
        }
        Err(error) if missing(&error) => Ok(None),
        Err(error) => Err(error.context("STORAGE_SOURCE_RETIREMENT_INVALID")),
    }
}

fn mapped_roots(
    plan: &StorageMigrationPlan,
    role: StorageRootRole,
) -> Result<Option<(PathBuf, PathBuf)>> {
    let (source, target) = match role {
        StorageRootRole::Native => (&plan.from.data_root, plan.target.data_root.clone()),
        StorageRootRole::Gateway => (
            &plan.from.gateway_root,
            plan.target.data_root.join("studio/gateway"),
        ),
        StorageRootRole::Desktop => (
            &plan.from.desktop_root,
            plan.target.data_root.join("studio/desktop"),
        ),
    };
    let source = super::resolve::absolute(source)?;
    let target = super::resolve::absolute(&target)?;
    if source == target {
        return Ok(None);
    }
    let mut moved = false;
    for component in &plan.components {
        let declared_source = super::resolve::absolute(&component.source)?;
        let declared_target = super::resolve::absolute(&component.destination)?;
        if let Ok(relative) = source.strip_prefix(&declared_source) {
            moved |= declared_target.join(relative) == target && declared_source != declared_target;
        }
    }
    Ok(moved.then_some((source, target)))
}

fn existing_source(plan: &StorageMigrationPlan, path: &Path) -> Result<Option<PrivateDirectory>> {
    match PrivateDirectory::open_existing(path) {
        Ok(root) => Ok(Some(root)),
        Err(error) if missing(&error) => {
            for component in &plan.components {
                ensure!(
                    super::resolve::absolute(&component.source)? != path,
                    "STORAGE_SOURCE_CHANGED"
                );
            }
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn target_is_source(path: &Path, source_identity: &str) -> Result<bool> {
    match PrivateDirectory::open_existing(path) {
        Ok(root) => Ok(root.directory_identity()? == source_identity),
        Err(error) if missing(&error) => Ok(false),
        Err(error) => Err(error),
    }
}

fn binding(receipt: &StorageMigrationReceipt, role: StorageRootRole) -> Result<Option<Binding>> {
    receipt
        .owner_receipts
        .get(&role.owner_key())
        .cloned()
        .map(|value| {
            serde_json::from_value(value)
                .map_err(|_| anyhow::anyhow!("STORAGE_SOURCE_RETIREMENT_INVALID"))
        })
        .transpose()
}

fn validate_binding(receipt: &StorageMigrationReceipt, expected: &Binding) -> Result<()> {
    let marker = &expected.marker;
    ensure!(
        expected.version == 1
            && marker.version == 1
            && !expected.marker_identity.is_empty()
            && expected.marker_identity.len() <= 2048
            && expected.marker_sha256.len() == 64
            && marker.operation_id == receipt.plan.operation_id
            && marker.selection_revision == receipt.plan.target.revision,
        "STORAGE_SOURCE_RETIREMENT_INVALID"
    );
    let (source, target) =
        mapped_roots(&receipt.plan, marker.role)?.context("STORAGE_SOURCE_RETIREMENT_CONFLICT")?;
    ensure!(
        marker.source_root == source
            && marker.target_root == target
            && marker.control_directory.is_absolute()
            && marker.control_directory.file_name() == Some(OsStr::new(".config"))
            && !marker.source_identity.is_empty()
            && marker.source_identity.len() <= 256
            && !marker.control_identity.is_empty()
            && marker.control_identity.len() <= 256,
        "STORAGE_SOURCE_RETIREMENT_CONFLICT"
    );
    for component in &receipt.plan.components {
        if super::resolve::absolute(&component.source)? == source {
            ensure!(
                component.source_identity == marker.source_identity,
                "STORAGE_SOURCE_CHANGED"
            );
        }
    }
    Ok(())
}

fn validate_marker(
    marker: &StorageSourceRetirementMarker,
    root: &PrivateDirectory,
    role: StorageRootRole,
) -> Result<()> {
    ensure!(
        marker.version == 1
            && marker.role == role
            && marker.source_identity == root.directory_identity()?
            && super::resolve::valid_operation_id(&marker.operation_id)
            && marker.control_directory.is_absolute()
            && marker.control_directory.file_name() == Some(OsStr::new(".config"))
            && marker.source_root.is_absolute()
            && marker.target_root.is_absolute(),
        "STORAGE_SOURCE_RETIREMENT_INVALID"
    );
    Ok(())
}

fn validate_file(
    root: &PrivateDirectory,
    name: &str,
    file: &File,
    expected: &Binding,
) -> Result<()> {
    let content = bytes(file)?;
    ensure!(
        file_identity(file)? == expected.marker_identity
            && digest(&content) == expected.marker_sha256
            && serde_json::from_slice::<StorageSourceRetirementMarker>(&content)
                .map_err(|_| anyhow::anyhow!("STORAGE_SOURCE_RETIREMENT_INVALID"))?
                == expected.marker
            && file_identity(&root.open_single_link_regular_file(OsStr::new(name))?)?
                == expected.marker_identity,
        "STORAGE_SOURCE_RETIREMENT_CHANGED"
    );
    Ok(())
}

fn original_receipt(
    marker: &StorageSourceRetirementMarker,
) -> Result<(PrivateDirectory, File, StorageMigrationReceipt)> {
    let directory = PrivateDirectory::open_existing(&marker.control_directory)
        .context("STORAGE_SOURCE_RETIREMENT_UNAVAILABLE")?;
    ensure!(
        directory.directory_identity()? == marker.control_identity,
        "STORAGE_SOURCE_RETIREMENT_CHANGED"
    );
    let gate = directory
        .try_existing_shared_lock(OsStr::new("kcoder-storage.lock"))?
        .context("STORAGE_MIGRATION_PENDING")?;
    ensure!(gate.metadata()?.len() == 0, "STORAGE_CONTROL_CHANGED");
    PortableLeaseIdentity::from_storage_lock_handle(&gate)?;
    let home = marker
        .control_directory
        .parent()
        .context("STORAGE_SOURCE_RETIREMENT_INVALID")?;
    let receipt = read_storage_operation(home, &marker.operation_id)?
        .context("STORAGE_SOURCE_RETIREMENT_UNAVAILABLE")?;
    Ok((directory, gate, receipt))
}

fn verify_control_backlink(
    control: &PrivateDirectory,
    gate: &File,
    marker: &StorageSourceRetirementMarker,
) -> Result<()> {
    ensure!(
        PrivateDirectory::open_existing(&marker.control_directory)?.directory_identity()?
            == marker.control_identity
            && control.directory_identity()? == marker.control_identity
            && gate.metadata()?.len() == 0
            && file_identity(gate)?
                == file_identity(
                    &control.open_single_link_regular_file(OsStr::new("kcoder-storage.lock"))?
                )?,
        "STORAGE_SOURCE_RETIREMENT_CHANGED"
    );
    Ok(())
}

/// Called only after this actual business root's shared writer lease is held.
/// A missing leaf does not read the personal locator or any migration archive.
pub fn assert_storage_root_admitted(root: &PrivateDirectory, role: StorageRootRole) -> Result<()> {
    let Some(file) = optional_file(root, role.leaf())? else {
        return super::component_publication::assert_target_admitted(root);
    };
    let marker: StorageSourceRetirementMarker = serde_json::from_slice(&bytes(&file)?)
        .map_err(|_| anyhow::anyhow!("STORAGE_SOURCE_RETIREMENT_INVALID"))?;
    validate_marker(&marker, root, role)?;
    let (control, gate, receipt) = original_receipt(&marker)?;
    let proof = binding(&receipt, role)?.context("STORAGE_SOURCE_RETIREMENT_UNCONFIRMED")?;
    validate_binding(&receipt, &proof)?;
    ensure!(
        !proof.cleaned && proof.marker == marker,
        "STORAGE_SOURCE_RETIREMENT_UNCONFIRMED"
    );
    validate_file(root, role.leaf(), &file, &proof)?;
    verify_control_backlink(&control, &gate, &marker)?;
    match receipt.disposition {
        Disposition::Complete => anyhow::bail!("STORAGE_SOURCE_RETIRED"),
        Disposition::Active => anyhow::bail!("STORAGE_MIGRATION_PENDING"),
        Disposition::Deferred => anyhow::bail!("STORAGE_SOURCE_RETIREMENT_UNCONFIRMED"),
    }
}

fn prepared_name(id: &str, role: StorageRootRole) -> String {
    format!(".kcoder-source-retirement-{id}-{}.prepared", role.as_str())
}

fn lease(
    path: &Path,
    root: &PrivateDirectory,
    name: &str,
    file: File,
    expected: &Binding,
) -> Result<StorageSourceRetirementLease> {
    validate_file(root, name, &file, expected)?;
    Ok(StorageSourceRetirementLease {
        operation_id: expected.marker.operation_id.clone(),
        root_path: path.into(),
        root: root.duplicate_handle()?,
        name: name.into(),
        file,
        identity: expected.marker_identity.clone(),
        sha256: expected.marker_sha256.clone(),
    })
}

fn unchanged_selection(control_path: &Path, receipt: &StorageMigrationReceipt) -> Result<()> {
    ensure!(
        read_storage_location_record(&control_path.join("kcoder-storage.json"))?
            == receipt.plan.original,
        "STORAGE_SELECTION_CHANGED"
    );
    Ok(())
}

impl StorageCoordinator {
    /// Prepare denial facts before inventory. Cache-only and in-place roles add nothing.
    pub fn prepare_source_retirements(&mut self, id: &str) -> Result<()> {
        self.prepare_source_retirements_with_checkpoint(id, &mut || Ok(()))
    }

    fn prepare_source_retirements_with_checkpoint(
        &mut self,
        id: &str,
        checkpoint: &mut impl FnMut() -> Result<()>,
    ) -> Result<()> {
        let (mut receipt, control, _) = self.source_retirement_context(id)?;
        ensure!(
            matches!(receipt.phase, Phase::Stopped | Phase::Copying),
            "STORAGE_PHASE_INVALID"
        );
        let control_path = self.source_retirement_control_path()?;
        unchanged_selection(&control_path, &receipt)?;
        for role in StorageRootRole::ALL {
            let Some((source, target)) = mapped_roots(&receipt.plan, role)? else {
                continue;
            };
            let Some(observed) = existing_source(&receipt.plan, &source)? else {
                continue;
            };
            let source_identity = observed.directory_identity()?;
            if target_is_source(&target, &source_identity)? {
                continue;
            }
            let root = self.verify_source_root(id, &source, &source_identity)?;
            let marker = StorageSourceRetirementMarker {
                version: 1,
                operation_id: id.into(),
                role,
                source_root: source.clone(),
                source_identity,
                target_root: target,
                selection_revision: receipt.plan.target.revision,
                control_directory: control_path.clone(),
                control_identity: control.directory_identity()?,
            };
            let key = role.owner_key();
            let previous = receipt.owner_receipts.get(&key).cloned();
            let previous_binding = binding(&receipt, role)?;
            let prepared = prepared_name(id, role);
            let expected = match previous_binding.filter(|proof| !proof.cleaned) {
                Some(proof) => {
                    validate_binding(&receipt, &proof)?;
                    ensure!(proof.marker == marker, "STORAGE_SOURCE_RETIREMENT_CONFLICT");
                    proof
                }
                None => {
                    ensure!(
                        optional_file(&root, role.leaf())?.is_none()
                            && optional_file(&root, &prepared)?.is_none(),
                        "STORAGE_SOURCE_RETIREMENT_CONFLICT"
                    );
                    let content = serde_json::to_vec(&marker)?;
                    ensure!(
                        content.len() <= SOURCE_RETIREMENT_LIMIT,
                        "STORAGE_SOURCE_RETIREMENT_INVALID"
                    );
                    let mut recorded = None;
                    // The fixed preparation leaf appears only after its original
                    // physical identity is durable in this operation's receipt.
                    root.atomic_publish_observed_from_reader(
                        OsStr::new(&prepared),
                        &mut content.as_slice(),
                        false,
                        || Ok(()),
                        |file| {
                            checkpoint()?;
                            let proof = Binding {
                                version: 1,
                                marker,
                                marker_identity: file_identity(file)?,
                                marker_sha256: digest(&content),
                                cleaned: false,
                            };
                            self.record_source_retirement_receipt(
                                id,
                                role.as_str(),
                                previous.as_ref(),
                                serde_json::to_value(&proof)?,
                            )?;
                            checkpoint()?;
                            recorded = Some(proof);
                            Ok(())
                        },
                    )?;
                    recorded.context("STORAGE_SOURCE_RETIREMENT_UNCONFIRMED")?
                }
            };
            match (
                optional_file(&root, role.leaf())?,
                optional_file(&root, &prepared)?,
            ) {
                (None, Some(file)) => {
                    validate_file(&root, &prepared, &file, &expected)?;
                    root.rename_no_replace(OsStr::new(&prepared), OsStr::new(role.leaf()))?;
                }
                (Some(file), None) => validate_file(&root, role.leaf(), &file, &expected)?,
                _ => anyhow::bail!("STORAGE_SOURCE_RETIREMENT_UNCONFIRMED"),
            }
            let file = root.open_single_link_regular_file(OsStr::new(role.leaf()))?;
            self.register_source_retirement_lease(
                id,
                lease(&source, &root, role.leaf(), file, &expected)?,
            )?;
            receipt = self.source_retirement_context(id)?.0;
        }
        self.hold_previous_source_retirements(id)?;
        self.assert_source_retirements_ready(id)
    }

    /// Also exclude valid older role facts on an otherwise still-active source root.
    fn hold_previous_source_retirements(&mut self, id: &str) -> Result<()> {
        let (receipt, control, _) = self.source_retirement_context(id)?;
        let control_path = self.source_retirement_control_path()?;
        let mut paths = BTreeSet::new();
        paths.extend(
            receipt
                .plan
                .components
                .iter()
                .filter(|component| component.source != component.destination)
                .map(|component| component.source.clone()),
        );
        for role in StorageRootRole::ALL {
            if let Some((source, _)) = mapped_roots(&receipt.plan, role)? {
                paths.insert(source);
            }
        }
        for path in paths {
            let root = match PrivateDirectory::open_existing(&path) {
                Ok(root) => root,
                Err(error) if missing(&error) => continue,
                Err(error) => return Err(error),
            };
            let root = self.verify_source_root(id, &path, &root.directory_identity()?)?;
            for role in StorageRootRole::ALL {
                let Some(file) = optional_file(&root, role.leaf())? else {
                    continue;
                };
                let marker: StorageSourceRetirementMarker = serde_json::from_slice(&bytes(&file)?)
                    .map_err(|_| anyhow::anyhow!("STORAGE_SOURCE_RETIREMENT_INVALID"))?;
                if marker.operation_id == id {
                    continue;
                }
                ensure!(
                    marker.role == role
                        && marker.source_identity == root.directory_identity()?
                        && marker.control_directory == control_path
                        && marker.control_identity == control.directory_identity()?,
                    "STORAGE_SOURCE_RETIREMENT_CHANGED"
                );
                let archived = self.prior_operation_receipt(&marker.operation_id)?;
                ensure!(
                    archived.disposition == Disposition::Complete,
                    "STORAGE_MIGRATION_PENDING"
                );
                let proof =
                    binding(&archived, role)?.context("STORAGE_SOURCE_RETIREMENT_UNCONFIRMED")?;
                validate_binding(&archived, &proof)?;
                ensure!(
                    !proof.cleaned && proof.marker == marker,
                    "STORAGE_SOURCE_RETIREMENT_UNCONFIRMED"
                );
                self.register_source_retirement_lease(
                    id,
                    lease(&path, &root, role.leaf(), file, &proof)?,
                )?;
            }
        }
        Ok(())
    }

    pub fn assert_source_retirements_ready(&mut self, id: &str) -> Result<()> {
        let receipt = self.source_retirement_verification_receipt(id)?;
        for role in StorageRootRole::ALL {
            let Some((source, target)) = mapped_roots(&receipt.plan, role)? else {
                continue;
            };
            let Some(root) = existing_source(&receipt.plan, &source)? else {
                continue;
            };
            if target_is_source(&target, &root.directory_identity()?)? {
                continue;
            }
            let root = self.verify_source_root(id, &source, &root.directory_identity()?)?;
            let proof =
                binding(&receipt, role)?.context("STORAGE_SOURCE_RETIREMENT_UNCONFIRMED")?;
            validate_binding(&receipt, &proof)?;
            ensure!(!proof.cleaned, "STORAGE_SOURCE_RETIREMENT_UNCONFIRMED");
            validate_file(
                &root,
                role.leaf(),
                &root.open_single_link_regular_file(OsStr::new(role.leaf()))?,
                &proof,
            )?;
        }
        Ok(())
    }

    /// Remove only this original operation's physical files, before marking deferred.
    pub fn cleanup_source_retirements(&mut self, id: &str) -> Result<()> {
        let (mut receipt, _, _) = self.source_retirement_context(id)?;
        unchanged_selection(&self.source_retirement_control_path()?, &receipt)?;
        self.unregister_source_retirement_leases(id)?;
        for role in StorageRootRole::ALL {
            let Some(mut proof) = binding(&receipt, role)? else {
                continue;
            };
            validate_binding(&receipt, &proof)?;
            if proof.cleaned {
                continue;
            }
            let root = self.verify_source_root(
                id,
                &proof.marker.source_root,
                &proof.marker.source_identity,
            )?;
            for name in [role.leaf().to_owned(), prepared_name(id, role)] {
                if let Some(file) = optional_file(&root, &name)? {
                    validate_file(&root, &name, &file, &proof)?;
                    root.remove_regular_file(OsStr::new(&name))?;
                }
            }
            let previous = receipt.owner_receipts.get(&role.owner_key()).cloned();
            proof.cleaned = true;
            receipt = self.record_source_retirement_receipt(
                id,
                role.as_str(),
                previous.as_ref(),
                serde_json::to_value(&proof)?,
            )?;
        }
        Ok(())
    }

    pub fn source_retirement_exclusion_identities(&mut self, id: &str) -> Result<BTreeSet<String>> {
        self.source_retirement_context(id)?;
        self.source_retirement_lease_identities(id)
    }
}

#[cfg(test)]
#[path = "source_retirement_tests.rs"]
mod tests;
