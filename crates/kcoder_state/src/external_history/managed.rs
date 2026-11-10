//! New archive births are isolated from legacy IDs and retain native lifecycle leases.
use super::*;
use lifecycle::{ArchiveReadGuard, Catalog, Reservation};

pub(super) struct ManagedImport {
    directory: PrivateDirectory,
    reservation: Reservation,
}
impl ManagedImport {
    pub(super) fn activate(&self, receipt: &ExternalHistoryReceipt) -> Result<()> {
        let mut catalog =
            Catalog::open(&self.directory, false)?.context("external_history_lifecycle_missing")?;
        catalog.activate_owned(&self.reservation, receipt)
    }
}

impl ExternalHistoryStore {
    /// Reserve a new import's native generation before publishing the owning job.
    pub fn reserve_managed_archive(
        &self,
        operation: &str,
        snapshot: &ExternalHistorySnapshot,
    ) -> Result<String> {
        validate_snapshot(snapshot)?;
        let mut catalog =
            Catalog::open(&self.directory, true)?.context("external_history_lifecycle_missing")?;
        if let Some(request) = read_optional(
            &self.directory,
            &format!("request-{}.json", hash(operation.as_bytes())),
            METADATA_BYTES,
        )? {
            let request: Request = decode(&request)?;
            ensure!(request.version == 2, "external_history_operation_conflict");
        }
        Ok(catalog
            .reserve(operation, &hash(&serde_json::to_vec(snapshot)?))?
            .archive)
    }
    /// Read the recorded generation, including retired audit facts; this never revives it.
    pub fn recorded_managed_archive(
        &self,
        operation: &str,
        snapshot: &ExternalHistorySnapshot,
    ) -> Result<Option<String>> {
        validate_snapshot(snapshot)?;
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        catalog.recorded_archive(operation, &hash(&serde_json::to_vec(snapshot)?))
    }
    pub fn managed_archive_operation_retired(&self, operation: &str) -> Result<bool> {
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(false);
        };
        catalog.operation_retired(operation)
    }
    pub fn archive_retirement_for_source(
        &self,
        operation: &str,
    ) -> Result<Option<lifecycle::ArchiveRetirementView>> {
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        catalog.retirement_for_source(operation)
    }
    /// Read only bounded lifecycle metadata; no body hashing, directories or writer repair.
    pub fn preview_archive_retirement(
        &self,
        source: &str,
    ) -> Result<lifecycle::ArchiveRetirementPreview> {
        Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_legacy_retained")?
            .retirement_preview(source)
    }
    pub fn archive_retirements(
        &self,
        after: Option<&str>,
    ) -> Result<(Vec<lifecycle::ArchiveRetirementView>, Option<String>)> {
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok((Vec::new(), None));
        };
        catalog.retirement_page(after)
    }
    /// Observe the original journal and independent execution lock under one shared coordinator.
    pub fn observe_archive_retirement(
        &self,
        operation: &str,
    ) -> Result<(
        lifecycle::ArchiveRetirementView,
        lifecycle::ArchiveRetirementExecutionState,
    )> {
        let catalog = Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_legacy_retained")?;
        Ok((
            catalog.retirement_view(operation)?,
            catalog.retirement_execution_state(operation)?,
        ))
    }
    pub fn prepare_archive_retirement(
        &self,
        operation: &str,
        source: &str,
    ) -> Result<lifecycle::ArchiveRetirementView> {
        Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_legacy_retained")?
            .prepare_retirement(operation, source)
    }
    pub fn read_archive_retirement(
        &self,
        operation: &str,
    ) -> Result<lifecycle::ArchiveRetirementView> {
        Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_legacy_retained")?
            .retirement_view(operation)
    }
    pub fn cancel_archive_retirement(
        &self,
        operation: &str,
        sequence: u64,
    ) -> Result<lifecycle::ArchiveRetirementView> {
        Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_legacy_retained")?
            .cancel_retirement(operation, sequence)
    }
    /// A fixed operation's independent cancellation watermark never acknowledges
    /// or rewinds a concurrent worker's sequence or known deletion receipts.
    pub fn request_archive_retirement_cancel(
        &self,
        operation: &str,
    ) -> Result<lifecycle::ArchiveRetirementView> {
        let mut catalog = Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_legacy_retained")?;
        let sequence = catalog.retirement_view(operation)?.sequence;
        catalog.cancel_retirement(operation, sequence)
    }
    pub fn resume_archive_retirement(
        &self,
        operation: &str,
        sequence: u64,
    ) -> Result<lifecycle::ArchiveRetirementView> {
        Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_legacy_retained")?
            .resume_retirement(operation, sequence)
    }
    /// Retire only an operation pinned by the native managed-birth journal. Domain
    /// callers must first retire the corresponding source job under its own lease.
    pub fn run_archive_retirement(
        &self,
        operation: &str,
        sequence: u64,
        mut check: impl FnMut() -> bool,
    ) -> Result<lifecycle::ArchiveRetirementView> {
        ensure!(check(), "external_history_lifecycle_cancelled");
        let step = Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_legacy_retained")?
            .start_retirement(operation, sequence)?;
        match step {
            lifecycle::Run::Settled(view) => Ok(view),
            lifecycle::Run::Collect(claim) => claim.run(check),
        }
    }
    /// Check the immutable birth manifest. This is an observation, not a collection claim.
    pub fn verify_archive_birth(
        &self,
        archive_id: &str,
        mut check: impl FnMut() -> bool,
    ) -> Result<()> {
        let proof = Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_legacy_retained")?
            .birth(archive_id)?;
        proof.verify(&mut check)
    }
    /// Native producers call this before publishing a dependent output. The receipt is
    /// private authority and must not be accepted from an untrusted request payload.
    pub fn retain_archive_reference(
        &self,
        owner: lifecycle::ArchiveReferenceOwner,
        readers: &[ArchiveReadGuard],
    ) -> Result<lifecycle::ArchiveReferenceReceipt> {
        Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_missing")?
            .pin(owner, readers)
    }
    /// Observe an exact still-live native producer receipt without creating or repairing it.
    pub fn verify_archive_reference(
        &self,
        receipt: &lifecycle::ArchiveReferenceReceipt,
    ) -> Result<()> {
        Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_missing")?
            .verify_reference(receipt)
    }
    /// Reconcile only a previously pinned native producer; absence does not claim ownership.
    pub fn archive_reference_for_owner(
        &self,
        owner: &lifecycle::ArchiveReferenceOwner,
    ) -> Result<Option<lifecycle::ArchiveReferenceReceipt>> {
        let Some(catalog) = Catalog::open_readonly(&self.directory)? else {
            return Ok(None);
        };
        catalog.reference_for_owner(owner)
    }
    pub(crate) fn branch_reference_dependents(
        &self,
        receipt: &lifecycle::ArchiveReferenceReceipt,
    ) -> Result<u64> {
        Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_missing")?
            .branch_dependents(receipt)
    }
    /// Admit a source job and its physical read lease under one coordinator. A
    /// surviving shared generation never revives a retired logical import alias.
    pub fn reader_for_operation(
        &self,
        archive_id: &str,
        operation: &str,
    ) -> Result<ExternalHistoryReader> {
        let catalog = Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_missing")?;
        catalog.admit_operation(operation, archive_id)?;
        self.reader(archive_id)
    }
    /// A derived native owner can keep reading its own pinned source after the
    /// original import job retires. Verification and read-lease acquisition share
    /// the coordinator, so releasing a receipt cannot race in between them.
    pub fn reader_with_reference(
        &self,
        archive_id: &str,
        receipt: &lifecycle::ArchiveReferenceReceipt,
    ) -> Result<ExternalHistoryReader> {
        let catalog = Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_missing")?;
        catalog.verify_reference(receipt)?;
        ensure!(
            receipt.contains_archive(archive_id),
            "external_history_lifecycle_reference_conflict"
        );
        self.reader(archive_id)
    }
    /// The owning native domain must first durably retire its exact output under
    /// its own mutation lease. This does not delete bytes or release another owner.
    pub fn release_archive_reference(
        &self,
        receipt: &lifecycle::ArchiveReferenceReceipt,
    ) -> Result<()> {
        Catalog::open(&self.directory, false)?
            .context("external_history_lifecycle_missing")?
            .release(receipt)
    }
    pub fn archive_reference_release_guard(
        &self,
        receipt: &lifecycle::ArchiveReferenceReceipt,
    ) -> Result<lifecycle::ArchiveReferenceReleaseGuard> {
        Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_missing")?
            .reference_release_guard(receipt)
    }
    /// A bounded observation, never a promise that a future collection can run.
    pub fn archive_lifecycle_observation(
        &self,
        archive_id: &str,
    ) -> Result<lifecycle::ArchiveLifecycleObservation> {
        Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_legacy_retained")?
            .observation(archive_id)
    }
    /// New imports use a managed birth epoch. Existing legacy operations must keep `begin`.
    /// The stable operation binds its exact generation across every publication receipt window.
    pub fn begin_managed(
        &self,
        operation_id: &str,
        snapshot: &ExternalHistorySnapshot,
    ) -> Result<ExternalHistoryImport> {
        validate_snapshot(snapshot)?;
        let snapshot_sha256 = hash(&serde_json::to_vec(snapshot)?);
        let mut catalog =
            Catalog::open(&self.directory, true)?.context("external_history_lifecycle_missing")?;
        let request_name = format!("request-{}.json", hash(operation_id.as_bytes()));
        let mut request: Option<Request> =
            read_optional(&self.directory, &request_name, METADATA_BYTES)?
                .map(|bytes| decode(&bytes))
                .transpose()?;
        if let Some(saved) = &request {
            ensure!(saved.version == 2, "external_history_operation_conflict");
        }
        let reservation = catalog.reserve(operation_id, &snapshot_sha256)?;
        catalog.reserve_archive_resource(&reservation, snapshot)?;
        let archive_id = &reservation.archive;
        if let Some(saved) = &request {
            ensure!(
                saved.version == 2
                    && saved.snapshot_sha256 == snapshot_sha256
                    && saved.archive_id == *archive_id
                    && saved.owns_archive == reservation.owns_archive,
                "external_history_operation_conflict"
            );
        }
        let existing = match self.directory.open_child(OsStr::new(archive_id), false) {
            Ok(directory) => Some(directory),
            Err(error) if missing(&error) => None,
            Err(_) => anyhow::bail!("external_history_unsafe_directory"),
        };
        let directory = if let Some(directory) = existing {
            directory
        } else if let Some(saved) = &request {
            ensure!(
                saved.owns_archive,
                "external_history_stored_content_changed"
            );
            let staging = format!("staging-managed-{}", reservation.generation);
            ensure!(
                saved.staging_name.as_deref() == Some(&staging),
                "external_history_staging_changed"
            );
            let directory = self.directory.open_child(OsStr::new(&staging), false)?;
            directory.verify_private_directory()?;
            ensure!(
                directory.directory_identity()? == saved.directory_identity,
                "external_history_staging_changed"
            );
            catalog.attach(&reservation, &directory)?;
            self.directory
                .rename_no_replace(OsStr::new(&staging), OsStr::new(archive_id))?;
            directory
        } else {
            ensure!(
                reservation.owns_archive,
                "external_history_pending_other_operation"
            );
            // The staging name is deterministic, but an unreceipted existing directory is
            // never adopted: its birth identity cannot be recovered from matching bytes.
            let staging = format!("staging-managed-{}", reservation.generation);
            let directory = self.directory.create_private_child(OsStr::new(&staging))?;
            let binding = Binding {
                version: 2,
                generation: Some(reservation.generation.clone()),
                snapshot_sha256: snapshot_sha256.clone(),
                archive_id: archive_id.clone(),
                session_id: crate::generate_session_id(),
                owner_operation_id: operation_id.into(),
                snapshot: snapshot.clone(),
            };
            directory.atomic_replace(OsStr::new("binding.json"), &serde_json::to_vec(&binding)?)?;
            let owned = Request {
                version: 2,
                snapshot_sha256: snapshot_sha256.clone(),
                archive_id: archive_id.clone(),
                session_id: binding.session_id,
                directory_identity: directory.directory_identity()?,
                owns_archive: true,
                staging_name: Some(staging.clone()),
            };
            publish_exact(
                &self.directory,
                &request_name,
                &serde_json::to_vec(&owned)?,
                METADATA_BYTES,
            )?;
            request = Some(owned);
            catalog.attach(&reservation, &directory)?;
            self.directory
                .rename_no_replace(OsStr::new(&staging), OsStr::new(archive_id))?;
            directory
        };
        directory.verify_private_directory()?;
        let binding: Binding = decode(
            &read_optional(&directory, "binding.json", METADATA_BYTES)?
                .context("external_history_binding_missing")?,
        )?;
        validate_binding(&binding, archive_id)?;
        ensure!(
            binding.version == 2
                && binding.generation.as_deref() == Some(&reservation.generation)
                && binding.snapshot == *snapshot,
            "external_history_binding_changed"
        );
        if let Some(saved) = &request {
            ensure!(
                saved.directory_identity == directory.directory_identity()?
                    && saved.session_id == binding.session_id
                    && (!saved.owns_archive || binding.owner_operation_id == operation_id),
                "external_history_stored_content_changed"
            );
        }
        let guard = catalog.import_guard(&reservation)?;
        guard.assert_directory(&catalog.scope(), archive_id, &directory)?;
        let reader = ExternalHistoryReader {
            directory,
            binding,
            lifecycle: guard,
        };
        ensure!(
            reservation.owns_archive || reader.receipt()?.is_some(),
            "external_history_pending_other_operation"
        );
        let lease = reader
            .directory
            .try_exclusive_lock(OsStr::new("import.lock"))?
            .context("external_history_busy")?;
        let request = request.unwrap_or(Request {
            version: 2,
            snapshot_sha256,
            archive_id: archive_id.clone(),
            session_id: reader.binding.session_id.clone(),
            directory_identity: reader.directory.directory_identity()?,
            owns_archive: false,
            staging_name: None,
        });
        publish_exact(
            &self.directory,
            &request_name,
            &serde_json::to_vec(&request)?,
            METADATA_BYTES,
        )?;
        Ok(ExternalHistoryImport {
            reader,
            owns_archive: reservation.owns_archive,
            _lease: lease,
            managed: Some(ManagedImport {
                directory: self.directory.duplicate_handle()?,
                reservation,
            }),
        })
    }
    /// Only new bindings can authorize collection; a legacy reader remains readable.
    pub(super) fn reader_guard(
        &self,
        directory: &PrivateDirectory,
        binding: &Binding,
    ) -> Result<ArchiveReadGuard> {
        if binding.version == 1 {
            return Ok(ArchiveReadGuard::legacy());
        }
        let catalog = Catalog::open_readonly(&self.directory)?
            .context("external_history_lifecycle_missing")?;
        let guard = catalog.guard(&binding.archive_id)?;
        guard.assert_directory(&catalog.scope(), &binding.archive_id, directory)?;
        Ok(guard)
    }
}
impl ExternalHistoryReader {
    /// The caller may retain this guard across paged requests. Cloning retains the SAME lease.
    pub fn lifecycle_guard(&self) -> ArchiveReadGuard {
        self.lifecycle.clone()
    }
}
