//! Managed archive epochs and durable references. Legacy evidence remains separate and readable.
use anyhow::{Context, Result, ensure};
use kcoder_config::{PrivateDirectory, PrivateLeaseMode, VerifiedPrivateLease};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::{Read, Write},
};
mod coordinator;
mod derived;
mod derived_recovery;
mod metadata_snapshot;
pub(crate) use derived_recovery::SealedCacheRecovery;
mod payload;
mod references;
pub mod resource_budget;
pub(crate) use payload::{PayloadLease, PayloadNode};
pub use references::ArchiveReferenceReleaseGuard;
mod gc;
mod retire;
pub(crate) use retire::Run;
mod lease;
mod model;
#[cfg(test)]
mod tests;
use lease::ArchiveHeader;
pub use lease::ArchiveReadGuard;
use model::*;
pub use model::{ArchiveReferenceKind, ArchiveReferenceOwner, ArchiveReferenceReceipt};
pub use model::{ArchiveRetirementPhase, ArchiveRetirementView};
pub use retire::{ArchiveRetirementExecutionState, ArchiveRetirementPreview};

const DIRECTORY: &str = "managed-v2";
const DOCUMENT: &str = "lifecycle.json";

/// A point-in-time native observation; it grants no future deletion authority.
pub struct ArchiveLifecycleObservation {
    pub durable_references: u64,
    pub read_leases_idle: bool,
}

struct Bounded {
    bytes: Vec<u8>,
    maximum: usize,
}
impl Write for Bounded {
    fn write(&mut self, input: &[u8]) -> std::io::Result<usize> {
        if input.len() > self.maximum.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "external_history_lifecycle_budget_exceeded",
            ));
        }
        self.bytes.extend_from_slice(input);
        Ok(input.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode(value: &impl Serialize, maximum: usize) -> Result<Vec<u8>> {
    let mut output = Bounded {
        bytes: Vec::new(),
        maximum,
    };
    serde_json::to_writer(&mut output, value)
        .map_err(|_| anyhow::anyhow!("external_history_lifecycle_budget_exceeded"))?;
    Ok(output.bytes)
}
fn hash(value: &impl Serialize) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(encode(value, MAX_DOCUMENT)?)
    ))
}
fn load<T: DeserializeOwned>(
    directory: &PrivateDirectory,
    name: &str,
    maximum: usize,
) -> Result<T> {
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    ensure!(
        file.metadata()?.len() <= maximum as u64,
        "external_history_lifecycle_budget_exceeded"
    );
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= maximum,
        "external_history_lifecycle_budget_exceeded"
    );
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("external_history_lifecycle_invalid_metadata"))
}
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

/// Native-only reservation. Retrying an operation never selects a newer archive generation.
#[derive(Clone)]
pub(super) struct Reservation {
    pub archive: String,
    pub operation: String,
    pub owns_archive: bool,
    pub snapshot: String,
    pub generation: String,
}

/// This guard owns the verified archive mutation coordinator for its complete lifetime.
/// Its authority is never constructed from an RPC field or a historical source path.
pub(super) struct Catalog<'a> {
    _mutation: VerifiedPrivateLease,
    _admission: coordinator::CatalogAdmission,
    base: &'a PrivateDirectory,
    directory: PrivateDirectory,
    document: Document,
    writable: bool,
}
impl<'a> Catalog<'a> {
    pub fn scope(&self) -> String {
        self.document.scope.clone()
    }
    pub fn observation(&self, archive_id: &str) -> Result<ArchiveLifecycleObservation> {
        let archive = self
            .document
            .archives
            .get(archive_id)
            .context("external_history_lifecycle_legacy_retained")?;
        let control = self.directory.open_child(OsStr::new(archive_id), false)?;
        let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
        ensure!(
            header.scope == self.document.scope
                && header.archive == archive.id
                && header.generation == archive.generation
                && header.directory == archive.directory
                && header.lease == archive.lease,
            "external_history_lifecycle_changed"
        );
        let read_leases_idle = match lease::exclusive(&control, &header) {
            Ok(_claim) => true,
            Err(error) if error.to_string() == "external_history_lifecycle_busy" => false,
            Err(error) => return Err(error),
        };
        Ok(ArchiveLifecycleObservation {
            durable_references: self
                .document
                .references
                .values()
                .filter(|reference| {
                    !reference.released
                        && reference.receipt.archives.iter().any(|id| id == archive_id)
                })
                .count() as u64,
            read_leases_idle,
        })
    }
    pub fn open(base: &'a PrivateDirectory, create: bool) -> Result<Option<Self>> {
        Self::open_inner(base, create, true)
    }
    pub fn open_readonly(base: &'a PrivateDirectory) -> Result<Option<Self>> {
        Self::open_inner(base, false, false)
    }
    fn open_inner(
        base: &'a PrivateDirectory,
        create: bool,
        writable: bool,
    ) -> Result<Option<Self>> {
        base.verify_private_directory()?;
        // Queue only the shared metadata transaction, not capture/parsing/payload IO.
        // The queue key is the actual held directory identity; it grants no kernel authority.
        let admission =
            coordinator::CatalogAdmission::acquire(base.directory_identity()?, writable)?;
        base.verify_private_directory()?;
        let exists = match base.open_child(OsStr::new(DIRECTORY), false) {
            Ok(directory) => {
                directory.verify_private_directory()?;
                true
            }
            Err(error) if missing(&error) && !create => return Ok(None),
            Err(error) if missing(&error) => false,
            Err(error) => return Err(error),
        };
        let expected_mutation = if exists {
            // Actual native identity supplies the existing lock probe; the complete
            // recorded identity is checked against it under the acquired lease below.
            base.portable_regular_identity(OsStr::new("mutation.lock"))?
        } else {
            // Bootstrap creates only the normal coordinator, before any managed content exists.
            drop(
                base.try_exclusive_lock(OsStr::new("mutation.lock"))?
                    .context("external_history_lifecycle_busy")?,
            );
            base.portable_regular_identity(OsStr::new("mutation.lock"))?
        };
        let mode = if writable {
            PrivateLeaseMode::Exclusive
        } else {
            PrivateLeaseMode::Shared
        };
        let mut acquired = None;
        for attempt in 0..64 {
            acquired = base.try_existing_portable_lock(
                OsStr::new("mutation.lock"),
                &expected_mutation,
                mode,
            )?;
            if acquired.is_some() {
                break;
            }
            if attempt < 63 {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        // Waiting is limited to acquiring coordination authority; no publication or callback
        // below this point is retried by this loop.
        let mutation = acquired.context("external_history_lifecycle_busy")?;
        let directory = match base.open_child(OsStr::new(DIRECTORY), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) && !create => return Ok(None),
            Err(error) if missing(&error) => {
                let name = format!(".managed-v2-{}", uuid::Uuid::new_v4().simple());
                let staging = base.create_private_child(OsStr::new(&name))?;
                let identity = staging.directory_identity()?;
                let document = Document {
                    version: VERSION,
                    scope: hash(&(
                        "external-history-lifecycle/v2",
                        base.directory_identity()?,
                        &identity,
                    ))?,
                    directory: identity,
                    mutation: base.portable_regular_identity(OsStr::new("mutation.lock"))?,
                    sequence: 0,
                    archives: Default::default(),
                    requests: Default::default(),
                    references: Default::default(),
                    retirements: Default::default(),
                    resource_groups: Default::default(),
                };
                document.validate()?;
                staging.atomic_replace(OsStr::new(DOCUMENT), &encode(&document, MAX_DOCUMENT)?)?;
                drop(staging);
                base.rename_no_replace(OsStr::new(&name), OsStr::new(DIRECTORY))?;
                base.open_child(OsStr::new(DIRECTORY), false)?
            }
            Err(error) => return Err(error),
        };
        directory.verify_private_directory()?;
        let document = admission.document(&directory)?;
        ensure!(
            document.directory == directory.directory_identity()?
                && document.scope
                    == hash(&(
                        "external-history-lifecycle/v2",
                        base.directory_identity()?,
                        &document.directory
                    ))?
                && document.mutation == expected_mutation
                && document.mutation
                    == base.portable_regular_identity(OsStr::new("mutation.lock"))?,
            "external_history_lifecycle_wrong_scope"
        );
        Ok(Some(Self {
            _mutation: mutation,
            _admission: admission,
            base,
            directory,
            document,
            writable,
        }))
    }
    fn save(&mut self) -> Result<()> {
        self.ensure_writer()?;
        ensure!(
            self.document.directory == self.directory.directory_identity()?
                && self.document.scope
                    == hash(&(
                        "external-history-lifecycle/v2",
                        self.base.directory_identity()?,
                        &self.document.directory
                    ))?,
            "external_history_lifecycle_wrong_scope"
        );
        self.document.sequence = self
            .document
            .sequence
            .checked_add(1)
            .context("external_history_lifecycle_sequence_exhausted")?;
        self.document.validate()?;
        let bytes = encode(&self.document, MAX_DOCUMENT)?;
        self.directory
            .atomic_replace(OsStr::new(DOCUMENT), &bytes)?;
        self._admission
            .remember_document(&self.directory, &bytes, &self.document)
    }
    fn ensure_writer(&self) -> Result<()> {
        ensure!(self.writable, "external_history_lifecycle_read_only");
        Ok(())
    }
    pub fn reservation(&self, operation: &str, snapshot: &str) -> Result<Option<Reservation>> {
        operation_id(operation)?;
        digest(snapshot)?;
        let Some(request) = self.document.requests.get(&hash(&operation)?) else {
            return Ok(None);
        };
        ensure!(
            request.operation == operation && request.snapshot == snapshot,
            "external_history_lifecycle_operation_conflict"
        );
        ensure!(
            !request.retired,
            "external_history_lifecycle_operation_retired"
        );
        let archive = self
            .document
            .archives
            .get(&request.archive)
            .context("external_history_lifecycle_changed")?;
        Ok(Some(Reservation {
            archive: archive.id.clone(),
            operation: operation.into(),
            owns_archive: archive.creator == operation,
            snapshot: snapshot.into(),
            generation: archive.generation.clone(),
        }))
    }
    pub fn recorded_archive(&self, operation: &str, snapshot: &str) -> Result<Option<String>> {
        operation_id(operation)?;
        digest(snapshot)?;
        let Some(request) = self.document.requests.get(&hash(&operation)?) else {
            return Ok(None);
        };
        ensure!(
            request.operation == operation && request.snapshot == snapshot,
            "external_history_lifecycle_operation_conflict"
        );
        Ok(Some(request.archive.clone()))
    }
    pub fn admit_operation(&self, operation: &str, archive: &str) -> Result<()> {
        operation_id(operation)?;
        let request = self
            .document
            .requests
            .get(&hash(&operation)?)
            .context("external_history_lifecycle_operation_conflict")?;
        ensure!(
            request.operation == operation && request.archive == archive,
            "external_history_lifecycle_operation_conflict"
        );
        ensure!(
            !request.retired,
            "external_history_lifecycle_operation_retired"
        );
        Ok(())
    }
    pub fn operation_retired(&self, operation: &str) -> Result<bool> {
        operation_id(operation)?;
        Ok(self
            .document
            .requests
            .get(&hash(&operation)?)
            .is_some_and(|request| request.retired))
    }
    pub fn retirement_for_source(&self, operation: &str) -> Result<Option<ArchiveRetirementView>> {
        operation_id(operation)?;
        self.document
            .requests
            .get(&hash(&operation)?)
            .and_then(|request| request.retirement.as_deref())
            .map(|retirement| self.retirement_view(retirement))
            .transpose()
    }
    pub fn reserve(&mut self, operation: &str, snapshot: &str) -> Result<Reservation> {
        self.ensure_writer()?;
        if let Some(existing) = self.reservation(operation, snapshot)? {
            return Ok(existing);
        }
        ensure!(
            self.document.requests.len() < MAX_REFERENCES,
            "external_history_lifecycle_budget_exceeded"
        );
        let archive = if let Some(active) =
            self.document.archives.values().find(|archive| {
                archive.snapshot == snapshot && archive.phase == ArchivePhase::Active
            }) {
            active.id.clone()
        } else {
            ensure!(
                self.document.archives.len() < MAX_ARCHIVES,
                "external_history_lifecycle_budget_exceeded"
            );
            let generation = uuid::Uuid::new_v4().to_string();
            let id = format!(
                "archive-{}",
                hash(&("managed-archive/v2", snapshot, &generation))?
            );
            let control = self.directory.create_private_child(OsStr::new(&id))?;
            drop(
                control
                    .try_exclusive_lock(OsStr::new("lease.lock"))?
                    .context("external_history_lifecycle_busy")?,
            );
            let lease = control.portable_regular_identity(OsStr::new("lease.lock"))?;
            self.document.archives.insert(
                id.clone(),
                Archive {
                    id: id.clone(),
                    snapshot: snapshot.into(),
                    generation,
                    creator: operation.into(),
                    resource_budget: self
                        .document
                        .resource_groups
                        .values()
                        .find(|group| group.contains_member(operation))
                        .map(|group| group.reference().clone()),
                    phase: ArchivePhase::Reserved,
                    directory: None,
                    lease,
                    receipt: None,
                    retirement: None,
                    baseline: None,
                    derived: Default::default(),
                    payload_tree: None,
                },
            );
            id
        };
        let owner =
            ArchiveReferenceOwner::new(ArchiveReferenceKind::ImportJob, operation, snapshot)?;
        let reference = self.pin_ids(owner, vec![archive.clone()])?;
        self.document.requests.insert(
            hash(&operation)?,
            Request {
                operation: operation.into(),
                snapshot: snapshot.into(),
                archive: archive.clone(),
                reference_id: reference.reference_id,
                retired: false,
                retirement: None,
            },
        );
        self.save()?;
        self.reservation(operation, snapshot)?
            .context("external_history_lifecycle_changed")
    }
    pub fn attach(
        &mut self,
        reservation: &Reservation,
        directory: &PrivateDirectory,
    ) -> Result<()> {
        self.ensure_writer()?;
        let expected = self
            .reservation(&reservation.operation, &reservation.snapshot)?
            .context("external_history_lifecycle_changed")?;
        ensure!(
            expected.archive == reservation.archive
                && expected.generation == reservation.generation
                && expected.owns_archive,
            "external_history_lifecycle_not_owner"
        );
        let archive = self
            .document
            .archives
            .get_mut(&reservation.archive)
            .unwrap();
        let identity = directory.directory_identity()?;
        ensure!(
            archive
                .directory
                .as_ref()
                .is_none_or(|current| current == &identity),
            "external_history_lifecycle_changed"
        );
        archive.directory = Some(identity);
        let header = ArchiveHeader {
            version: VERSION,
            scope: self.document.scope.clone(),
            archive: archive.id.clone(),
            generation: archive.generation.clone(),
            directory: archive.directory.clone(),
            lease: archive.lease.clone(),
        };
        self.directory
            .open_child(OsStr::new(&archive.id), false)?
            .atomic_replace(OsStr::new("identity.json"), &encode(&header, 4096)?)?;
        self.save()
    }
    pub fn activate(&mut self, reservation: &Reservation, receipt: &str) -> Result<()> {
        self.ensure_writer()?;
        digest(receipt)?;
        let expected = self
            .reservation(&reservation.operation, &reservation.snapshot)?
            .context("external_history_lifecycle_changed")?;
        ensure!(
            expected.archive == reservation.archive
                && expected.generation == reservation.generation,
            "external_history_lifecycle_changed"
        );
        let archive = self
            .document
            .archives
            .get_mut(&reservation.archive)
            .unwrap();
        ensure!(
            archive.directory.is_some()
                && matches!(archive.phase, ArchivePhase::Reserved | ArchivePhase::Active)
                && archive
                    .receipt
                    .as_ref()
                    .is_none_or(|saved| saved == receipt),
            "external_history_lifecycle_changed"
        );
        archive.receipt = Some(receipt.into());
        archive.phase = ArchivePhase::Active;
        self.save()
    }
    pub fn activate_owned(
        &mut self,
        reservation: &Reservation,
        receipt: &kcoder_types::external_history::ExternalHistoryReceipt,
    ) -> Result<()> {
        self.ensure_writer()?;
        let archive = self
            .document
            .archives
            .get(&reservation.archive)
            .context("external_history_lifecycle_changed")?;
        ensure!(
            archive.generation == reservation.generation,
            "external_history_lifecycle_changed"
        );
        #[cfg(any(target_os = "linux", windows))]
        if archive.phase == ArchivePhase::Reserved && archive.baseline.is_none() {
            let directory = self.base.open_child(OsStr::new(&archive.id), false)?;
            ensure!(
                archive.directory.as_deref() == Some(&directory.directory_identity()?),
                "external_history_lifecycle_changed"
            );
            let baseline = gc::Manifest::capture(&directory, receipt)?;
            self.document
                .archives
                .get_mut(&reservation.archive)
                .unwrap()
                .baseline = Some(baseline);
        }
        self.activate(reservation, &hash(receipt)?)?;
        self.settle_archive_resource(reservation, receipt)
    }
    pub fn birth(&self, archive_id: &str) -> Result<gc::BirthProof> {
        let archive = self
            .document
            .archives
            .get(archive_id)
            .context("external_history_lifecycle_legacy_retained")?;
        let baseline = archive
            .baseline
            .as_ref()
            .context("external_history_lifecycle_unsealed_retained")?;
        Ok(gc::BirthProof {
            manifest: baseline.clone(),
            directory: self.base.open_child(OsStr::new(archive_id), false)?,
            _guard: self.guard(archive_id)?,
        })
    }
    fn pin_ids(
        &mut self,
        owner: ArchiveReferenceOwner,
        mut archives: Vec<String>,
    ) -> Result<ArchiveReferenceReceipt> {
        self.ensure_writer()?;
        archives.sort();
        archives.dedup();
        ensure!(
            !archives.is_empty() && archives.len() <= MAX_RESOURCES,
            "external_history_lifecycle_budget_exceeded"
        );
        ensure!(
            archives
                .iter()
                .all(|id| self
                    .document
                    .archives
                    .get(id)
                    .is_some_and(|archive| matches!(
                        archive.phase,
                        ArchivePhase::Reserved | ArchivePhase::Active
                    ))),
            "external_history_lifecycle_retiring"
        );
        let reference_id = hash(&(owner.kind, &owner.operation))?;
        let receipt = ArchiveReferenceReceipt {
            scope: self.document.scope.clone(),
            reference_id: reference_id.clone(),
            fingerprint: hash(&(&self.document.scope, &owner, &archives))?,
            owner,
            archives,
        };
        if let Some(previous) = self.document.references.get(&reference_id) {
            ensure!(
                previous.receipt == receipt && !previous.released,
                "external_history_lifecycle_reference_conflict"
            );
            return Ok(previous.receipt.clone());
        }
        ensure!(
            self.document.references.len() < MAX_REFERENCES,
            "external_history_lifecycle_budget_exceeded"
        );
        self.document.references.insert(
            reference_id,
            Reference {
                receipt: receipt.clone(),
                released: false,
            },
        );
        Ok(receipt)
    }
    pub fn pin(
        &mut self,
        owner: ArchiveReferenceOwner,
        guards: &[ArchiveReadGuard],
    ) -> Result<ArchiveReferenceReceipt> {
        self.ensure_writer()?;
        ensure!(
            guards.len() <= MAX_RESOURCES,
            "external_history_lifecycle_budget_exceeded"
        );
        let mut archives = Vec::new();
        for guard in guards {
            let (id, generation, directory) = guard.binding(&self.document.scope)?;
            ensure!(
                self.document
                    .archives
                    .get(id)
                    .is_some_and(|archive| archive.phase == ArchivePhase::Active
                        && archive.generation == generation
                        && archive.directory.as_deref() == Some(directory)),
                "external_history_lifecycle_changed"
            );
            archives.push(id.into());
        }
        let receipt = self.pin_ids(owner, archives)?;
        self.save()?;
        Ok(receipt)
    }
    pub fn release(&mut self, receipt: &ArchiveReferenceReceipt) -> Result<()> {
        self.ensure_writer()?;
        ensure!(
            receipt.scope == self.document.scope,
            "external_history_lifecycle_wrong_scope"
        );
        let reference = self
            .document
            .references
            .get_mut(&receipt.reference_id)
            .context("external_history_lifecycle_reference_missing")?;
        ensure!(
            reference.receipt == *receipt,
            "external_history_lifecycle_reference_conflict"
        );
        if reference.released {
            return Ok(());
        }
        reference.released = true;
        self.save()
    }
    pub fn verify_reference(&self, receipt: &ArchiveReferenceReceipt) -> Result<()> {
        ensure!(
            receipt.scope == self.document.scope
                && self
                    .document
                    .references
                    .get(&receipt.reference_id)
                    .is_some_and(|reference| reference.receipt == *receipt && !reference.released),
            "external_history_lifecycle_reference_conflict"
        );
        Ok(())
    }
    pub fn reference_for_owner(
        &self,
        owner: &ArchiveReferenceOwner,
    ) -> Result<Option<ArchiveReferenceReceipt>> {
        let id = hash(&(owner.kind, &owner.operation))?;
        let Some(reference) = self.document.references.get(&id) else {
            return Ok(None);
        };
        ensure!(
            !reference.released && reference.receipt.owner == *owner,
            "external_history_lifecycle_reference_conflict"
        );
        Ok(Some(reference.receipt.clone()))
    }
    pub fn branch_dependents(&self, receipt: &ArchiveReferenceReceipt) -> Result<u64> {
        self.verify_reference(receipt)?;
        Ok(self
            .document
            .references
            .values()
            .filter(|reference| {
                !reference.released
                    && reference.receipt.reference_id != receipt.reference_id
                    && !matches!(
                        reference.receipt.owner.kind,
                        ArchiveReferenceKind::ImportJob
                            | ArchiveReferenceKind::Reinterpretation
                            | ArchiveReferenceKind::BranchView
                    )
                    && reference
                        .receipt
                        .archives
                        .iter()
                        .any(|id| receipt.archives.contains(id))
            })
            .count() as u64)
    }
    pub fn guard(&self, archive_id: &str) -> Result<ArchiveReadGuard> {
        // A pending reader can observe absence of a receipt, never consume uncommitted records.
        self.open_guard(archive_id, true)
    }
    pub fn import_guard(&self, reservation: &Reservation) -> Result<ArchiveReadGuard> {
        let current = self
            .reservation(&reservation.operation, &reservation.snapshot)?
            .context("external_history_lifecycle_changed")?;
        ensure!(
            current.archive == reservation.archive && current.generation == reservation.generation,
            "external_history_lifecycle_changed"
        );
        self.open_guard(&reservation.archive, reservation.owns_archive)
    }
    fn open_guard(&self, archive_id: &str, allow_reserved: bool) -> Result<ArchiveReadGuard> {
        let archive = self
            .document
            .archives
            .get(archive_id)
            .context("external_history_lifecycle_legacy_retained")?;
        ensure!(
            archive.phase == ArchivePhase::Active
                || (allow_reserved && archive.phase == ArchivePhase::Reserved),
            "external_history_lifecycle_retiring"
        );
        let control = self.directory.open_child(OsStr::new(archive_id), false)?;
        let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
        ensure!(
            header.scope == self.document.scope
                && header.archive == archive.id
                && header.generation == archive.generation
                && header.directory == archive.directory
                && header.lease == archive.lease,
            "external_history_lifecycle_changed"
        );
        ArchiveReadGuard::open(&control, &header)?.with_store(self.base.duplicate_handle()?)
    }
}
