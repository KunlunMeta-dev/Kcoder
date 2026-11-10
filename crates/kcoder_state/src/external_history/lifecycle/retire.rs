//! Logical retirement and physical collection have separate durable checkpoints.
use super::*;
use std::time::{Duration, Instant};
mod execution;
mod payload;
mod preview;
mod tree;
pub use execution::ArchiveRetirementExecutionState;
pub(super) use execution::ExecutionAnchor;
pub use preview::ArchiveRetirementPreview;

pub(crate) enum Run {
    Settled(ArchiveRetirementView),
    Collect(Box<Collection>),
}
pub(crate) struct Collection {
    base: PrivateDirectory,
    directory: PrivateDirectory,
    scope: String,
    operation: String,
    fingerprint: String,
    archive: Archive,
    manifest: gc::Manifest,
    _lease: VerifiedPrivateLease,
    _execution: VerifiedPrivateLease,
    last_control: Instant,
    acknowledged: u64,
    payload: Option<super::payload::PayloadCollection>,
}
impl Catalog<'_> {
    fn retirement(&self, operation: &str) -> Result<&Retirement> {
        operation_id(operation)?;
        self.document
            .retirements
            .get(operation)
            .context("external_history_retirement_not_found")
    }
    pub fn retirement_view(&self, operation: &str) -> Result<ArchiveRetirementView> {
        let record = self.retirement(operation)?;
        let request = self
            .document
            .requests
            .get(&hash(&record.request)?)
            .context("external_history_lifecycle_changed")?;
        let archive = self
            .document
            .archives
            .get(&record.archive)
            .context("external_history_lifecycle_changed")?;
        Ok(ArchiveRetirementView {
            operation_id: record.operation.clone(),
            source_operation_id: record.request.clone(),
            archive_id: record.archive.clone(),
            sequence: record.sequence,
            phase: record.phase,
            cancel_requested: record.cancel_revision > record.acknowledged,
            cancel_revision: record.cancel_revision,
            owns_archive: archive.creator == record.request,
            logical_retired: request.retired,
            retained_references: self
                .document
                .references
                .values()
                .filter(|reference| {
                    !reference.released
                        && reference.receipt.reference_id != request.reference_id
                        && reference.receipt.archives.contains(&record.archive)
                })
                .count() as u64,
            collected_bytes: record.removed_bytes + record.payload_removed_bytes,
            failure_code: record.failure.clone(),
        })
    }
    pub fn prepare_retirement(
        &mut self,
        operation: &str,
        source: &str,
    ) -> Result<ArchiveRetirementView> {
        self.ensure_writer()?;
        operation_id(operation)?;
        operation_id(source)?;
        if let Some(existing) = self.document.retirements.get(operation) {
            ensure!(
                existing.request == source,
                "external_history_retirement_operation_conflict"
            );
            return self.retirement_view(operation);
        }
        let key = hash(&source)?;
        let request = self
            .document
            .requests
            .get(&key)
            .context("external_history_lifecycle_legacy_retained")?;
        if let Some(canonical) = &request.retirement {
            return self.retirement_view(canonical);
        }
        ensure!(
            !request.retired && self.document.retirements.len() < MAX_REFERENCES,
            "external_history_retirement_operation_conflict"
        );
        let archive = self
            .document
            .archives
            .get(&request.archive)
            .context("external_history_lifecycle_changed")?;
        ensure!(
            archive.phase == ArchivePhase::Active && archive.receipt.is_some(),
            "external_history_lifecycle_not_committed"
        );
        let mut record = Retirement {
            operation: operation.into(),
            request: source.into(),
            archive: request.archive.clone(),
            fingerprint: hash(&(
                &self.document.scope,
                source,
                &archive.id,
                &archive.generation,
                &archive.receipt,
                &archive.baseline,
            ))?,
            sequence: 1,
            phase: ArchiveRetirementPhase::Prepared,
            cancel_revision: 0,
            acknowledged: 0,
            quarantine: None,
            removed_bytes: 0,
            tombstone: None,
            quarantined: false,
            removed: Vec::new(),
            pending: None,
            payload_plan: None,
            payload_previous: Vec::new(),
            payload_removed_bytes: 0,
            payload_removed_nodes: 0,
            failure: None,
            execution: None,
        };
        record.execution = Some(self.birth_retirement_execution(&record)?);
        self.document.retirements.insert(operation.into(), record);
        self.document.requests.get_mut(&key).unwrap().retirement = Some(operation.into());
        self.save()?;
        self.retirement_view(operation)
    }
    pub fn cancel_retirement(
        &mut self,
        operation: &str,
        sequence: u64,
    ) -> Result<ArchiveRetirementView> {
        self.ensure_writer()?;
        let view = self.retirement_view(operation)?;
        ensure!(
            view.sequence == sequence,
            "external_history_retirement_stale_sequence"
        );
        if matches!(view.phase, ArchiveRetirementPhase::Collected)
            || view.logical_retired && !view.owns_archive
        {
            return Ok(view);
        }
        let record = self.document.retirements.get_mut(operation).unwrap();
        if record.cancel_revision == record.acknowledged {
            record.cancel_revision = record
                .cancel_revision
                .checked_add(1)
                .context("external_history_lifecycle_sequence_exhausted")?;
        }
        if !view.logical_retired {
            record.phase = ArchiveRetirementPhase::Cancelled;
        }
        bump(record)?;
        self.save()?;
        self.retirement_view(operation)
    }
    pub fn resume_retirement(
        &mut self,
        operation: &str,
        sequence: u64,
    ) -> Result<ArchiveRetirementView> {
        self.ensure_writer()?;
        let view = self.retirement_view(operation)?;
        ensure!(
            view.sequence == sequence,
            "external_history_retirement_stale_sequence"
        );
        let tracked = self.retirement(operation)?.execution.is_some();
        let settled = matches!(view.phase, ArchiveRetirementPhase::Collected)
            || view.logical_retired && !view.owns_archive;
        if settled && tracked {
            return Ok(view);
        }
        let _execution = if tracked {
            Some(self.claim_retirement_execution(operation)?)
        } else {
            None
        };
        let archive = self.document.archives.get(&view.archive_id).unwrap();
        let control = self.directory.open_child(OsStr::new(&archive.id), false)?;
        let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
        let _claim = lease::exclusive(&control, &header)?;
        if !tracked {
            let anchor = self.birth_retirement_execution(self.retirement(operation)?)?;
            self.document
                .retirements
                .get_mut(operation)
                .unwrap()
                .execution = Some(anchor);
        }
        let record = self.document.retirements.get_mut(operation).unwrap();
        if settled {
            bump(record)?;
            self.save()?;
            return self.retirement_view(operation);
        }
        record.acknowledged = record.cancel_revision;
        record.phase = if view.logical_retired {
            ArchiveRetirementPhase::Retired
        } else {
            ArchiveRetirementPhase::Prepared
        };
        record.failure = None;
        bump(record)?;
        self.save()?;
        self.retirement_view(operation)
    }
    pub fn start_retirement(&mut self, operation: &str, sequence: u64) -> Result<Run> {
        self.ensure_writer()?;
        let view = self.retirement_view(operation)?;
        ensure!(
            view.sequence == sequence,
            "external_history_retirement_stale_sequence"
        );
        let execution = self.claim_retirement_execution(operation)?;
        if view.cancel_requested
            || matches!(view.phase, ArchiveRetirementPhase::Collected)
            || view.logical_retired && !view.owns_archive
        {
            return Ok(Run::Settled(view));
        }
        if !view.owns_archive {
            let dependent = self.document.references.values().any(|reference| {
                !reference.released
                    && !matches!(
                        reference.receipt.owner.kind,
                        ArchiveReferenceKind::ImportJob | ArchiveReferenceKind::Reinterpretation
                    )
                    && reference.receipt.archives.contains(&view.archive_id)
            });
            if dependent {
                self.block_retirement(operation, "external_history_retirement_referenced")?;
                return Ok(Run::Settled(self.retirement_view(operation)?));
            }
            let control = self
                .directory
                .open_child(OsStr::new(&view.archive_id), false)?;
            let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
            let _claim = match lease::exclusive(&control, &header) {
                Ok(claim) => claim,
                Err(error) if error.to_string() == "external_history_lifecycle_busy" => {
                    self.block_retirement(operation, "external_history_retirement_readers_busy")?;
                    return Ok(Run::Settled(self.retirement_view(operation)?));
                }
                Err(error) => return Err(error),
            };
            self.retire_request(operation)?;
            return Ok(Run::Settled(self.retirement_view(operation)?));
        }
        if view.retained_references > 0 {
            self.block_retirement(operation, "external_history_retirement_referenced")?;
            return Ok(Run::Settled(self.retirement_view(operation)?));
        }
        let archive = self
            .document
            .archives
            .get(&view.archive_id)
            .unwrap()
            .clone();
        if archive
            .derived
            .values()
            .any(|derived| !derived.published || derived.seal.is_none())
        {
            // An unfinished cache has no immutable leaf ownership proof and is retained.
            self.block_retirement(operation, "external_history_retirement_derived_retained")?;
            return Ok(Run::Settled(self.retirement_view(operation)?));
        }
        ensure!(
            archive
                .retirement
                .as_deref()
                .is_none_or(|id| id == operation),
            "external_history_retirement_operation_conflict"
        );
        let Some(manifest) = archive.baseline.clone() else {
            self.block_retirement(operation, "external_history_lifecycle_unsealed_retained")?;
            return Ok(Run::Settled(self.retirement_view(operation)?));
        };
        if !self.base.portable_retention_filesystem_supported()? {
            self.block_retirement(operation, "external_history_retirement_gc_unsupported")?;
            return Ok(Run::Settled(self.retirement_view(operation)?));
        }
        let control = self.directory.open_child(OsStr::new(&archive.id), false)?;
        let header: ArchiveHeader = load(&control, "identity.json", 4096)?;
        let claim = match lease::exclusive(&control, &header) {
            Ok(claim) => claim,
            Err(error) if error.to_string() == "external_history_lifecycle_busy" => {
                self.block_retirement(operation, "external_history_retirement_readers_busy")?;
                return Ok(Run::Settled(self.retirement_view(operation)?));
            }
            Err(error) => return Err(error),
        };
        let current = self.document.archives.get_mut(&archive.id).unwrap();
        current.phase = ArchivePhase::Retiring;
        current.retirement = Some(operation.into());
        let record = self.document.retirements.get_mut(operation).unwrap();
        record.phase = ArchiveRetirementPhase::Collecting;
        record
            .quarantine
            .get_or_insert_with(|| format!("retired-{}", hash(&operation).unwrap()));
        record.failure = None;
        bump(record)?;
        self.save()?;
        Ok(Run::Collect(Box::new(Collection {
            base: self.base.duplicate_handle()?,
            directory: self.directory.duplicate_handle()?,
            scope: self.document.scope.clone(),
            operation: operation.into(),
            fingerprint: record_fingerprint(&self.document, operation)?,
            archive,
            manifest,
            _lease: claim,
            _execution: execution,
            last_control: Instant::now() - Duration::from_secs(1),
            acknowledged: self.retirement(operation)?.acknowledged,
            payload: None,
        })))
    }
    fn retire_request(&mut self, operation: &str) -> Result<()> {
        self.ensure_writer()?;
        let record = self.retirement(operation)?.clone();
        let key = hash(&record.request)?;
        let request = self.document.requests.get(&key).unwrap().clone();
        if request.retired {
            return Ok(());
        }
        let tombstone = hash(&(
            &self.document.scope,
            &record.operation,
            &request,
            &record.fingerprint,
        ))?;
        let collecting = self
            .document
            .archives
            .get(&request.archive)
            .is_some_and(|archive| {
                archive.creator == record.request && archive.phase == ArchivePhase::Retiring
            });
        self.document.requests.get_mut(&key).unwrap().retired = true;
        self.document
            .references
            .get_mut(&request.reference_id)
            .unwrap()
            .released = true;
        let current = self.document.retirements.get_mut(operation).unwrap();
        current.tombstone = Some(tombstone);
        current.phase = if collecting {
            ArchiveRetirementPhase::Collecting
        } else {
            ArchiveRetirementPhase::Retired
        };
        bump(current)?;
        self.save()
    }
    fn block_retirement(&mut self, operation: &str, failure: &str) -> Result<()> {
        let record = self.document.retirements.get_mut(operation).unwrap();
        record.phase = ArchiveRetirementPhase::Blocked;
        record.failure = Some(failure.into());
        bump(record)?;
        self.save()
    }
}
fn record_fingerprint(document: &Document, operation: &str) -> Result<String> {
    Ok(document
        .retirements
        .get(operation)
        .context("external_history_retirement_not_found")?
        .fingerprint
        .clone())
}
impl Collection {
    fn verify_remaining(
        &mut self,
        directory: &PrivateDirectory,
        removed: &[String],
        external: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        self.verify_tree(directory, removed, external)
    }
    fn catalogue(&self) -> Result<Catalog<'_>> {
        let catalog =
            Catalog::open(&self.base, false)?.context("external_history_lifecycle_missing")?;
        ensure!(
            catalog.document.scope == self.scope
                && catalog.document.directory == self.directory.directory_identity()?
                && record_fingerprint(&catalog.document, &self.operation)? == self.fingerprint
                && catalog
                    .document
                    .archives
                    .get(&self.archive.id)
                    .is_some_and(
                        |archive| archive.retirement.as_deref() == Some(&self.operation)
                            && archive.generation == self.archive.generation
                    ),
            "external_history_lifecycle_changed"
        );
        Ok(catalog)
    }
    fn check(&mut self, external: &mut impl FnMut() -> bool, force: bool) -> Result<()> {
        ensure!(external(), "external_history_lifecycle_cancelled");
        if force || self.last_control.elapsed() >= Duration::from_millis(250) {
            let document: Document = load(&self.directory, DOCUMENT, MAX_DOCUMENT)?;
            document.validate()?;
            let record = document
                .retirements
                .get(&self.operation)
                .context("external_history_lifecycle_changed")?;
            ensure!(
                document.scope == self.scope && record.fingerprint == self.fingerprint,
                "external_history_lifecycle_changed"
            );
            ensure!(
                record.cancel_revision <= self.acknowledged,
                "external_history_lifecycle_cancelled"
            );
            self.last_control = Instant::now();
        }
        Ok(())
    }
    fn step(&mut self, external: &mut impl FnMut() -> bool) -> Result<()> {
        self.check(external, true)?;
        let mut catalog = self.catalogue()?;
        let record = catalog.retirement(&self.operation)?.clone();
        let quarantine = record
            .quarantine
            .as_ref()
            .context("external_history_lifecycle_changed")?;
        let opened = self
            .base
            .portable_open_verified_child(OsStr::new(quarantine), &self.manifest.directory);
        let directory = match opened {
            Ok(directory) => {
                ensure!(
                    record.tombstone.is_some(),
                    "external_history_lifecycle_changed"
                );
                directory
            }
            Err(error) if missing(&error) && !record.quarantined => {
                let directory = self.base.portable_open_verified_child(
                    OsStr::new(&self.archive.id),
                    &self.manifest.directory,
                )?;
                drop(catalog);
                let manifest = self.manifest.clone();
                self.prepare_payload(&directory, external)?;
                self.verify_remaining(&directory, &[], external)?;
                self.check(external, true)?;
                self.catalogue()?.retire_request(&self.operation)?;
                self.check(external, true)?;
                self.base.portable_quarantine_verified_entry(
                    OsStr::new(&self.archive.id),
                    &manifest.directory,
                    OsStr::new(quarantine),
                )?;
                catalog = self.catalogue()?;
                self.base
                    .portable_open_verified_child(OsStr::new(quarantine), &manifest.directory)?
            }
            Err(error)
                if missing(&error)
                    && record.quarantined
                    && record.removed.len() == self.archive.collection_entries()?.len() =>
            {
                // The exact original quarantine was empty and its removal intent is durable.
                drop(catalog);
                self.reopen_payload()?;
                self.payload_complete()?;
                let mut catalog = self.catalogue()?;
                self.complete(&mut catalog)?;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        self.base.sync()?;
        {
            let current = catalog
                .document
                .retirements
                .get_mut(&self.operation)
                .unwrap();
            current.quarantined = true;
            bump(current)?;
            catalog.save()?;
        }
        let record = catalog.retirement(&self.operation)?.clone();
        drop(catalog);
        self.reopen_payload()?;
        // Only this original, durable pending file/directory may be reconciled absent.
        self.reconcile_pending(&directory, &record)?;
        let record = self.catalogue()?.retirement(&self.operation)?.clone();
        self.verify_remaining(&directory, &record.removed, external)?;
        self.collect_payload(&directory, external)?;
        self.collect_tree(&directory, external)?;
        let manifest = self.manifest.clone();
        self.check(external, true)?;
        self.base.portable_remove_verified_empty_directory(
            OsStr::new(quarantine),
            &manifest.directory,
        )?;
        self.payload_complete()?;
        let mut catalog = self.catalogue()?;
        self.complete(&mut catalog)
    }
    fn removed(&self, name: &str) -> Result<()> {
        let mut catalog = self.catalogue()?;
        let record = catalog
            .document
            .retirements
            .get_mut(&self.operation)
            .unwrap();
        ensure!(
            record.pending.as_deref() == Some(name),
            "external_history_lifecycle_changed"
        );
        if !record.removed.iter().any(|removed| removed == name) {
            record.removed.push(name.into());
            record.removed.sort();
            let entries = self.archive.collection_entries()?;
            record.removed_bytes = record.removed.iter().map(|name| entries[name]).sum();
        }
        record.pending = None;
        bump(record)?;
        catalog.save()
    }
    fn complete(&self, catalog: &mut Catalog<'_>) -> Result<()> {
        ensure!(
            catalog.retirement(&self.operation)?.removed.len()
                == self.archive.collection_entries()?.len(),
            "external_history_lifecycle_changed"
        );
        ensure!(
            match self.base.open_child(OsStr::new(&self.archive.id), false) {
                Err(error) => missing(&error),
                Ok(_) => false,
            },
            "external_history_lifecycle_changed"
        );
        catalog
            .document
            .archives
            .get_mut(&self.archive.id)
            .unwrap()
            .phase = ArchivePhase::Collected;
        let record = catalog
            .document
            .retirements
            .get_mut(&self.operation)
            .unwrap();
        record.phase = ArchiveRetirementPhase::Collected;
        record.failure = None;
        bump(record)?;
        catalog.save()
    }
    pub fn run(mut self, mut external: impl FnMut() -> bool) -> Result<ArchiveRetirementView> {
        if let Err(error) = self.step(&mut external) {
            let mut catalog = self.catalogue()?;
            let logical_retired = catalog.retirement_view(&self.operation)?.logical_retired;
            if !logical_retired {
                let archive = catalog.document.archives.get_mut(&self.archive.id).unwrap();
                archive.phase = ArchivePhase::Active;
                archive.retirement = None;
            }
            let record = catalog
                .document
                .retirements
                .get_mut(&self.operation)
                .unwrap();
            record.phase = match (logical_retired, error.to_string().as_str()) {
                (false, "external_history_lifecycle_cancelled") => {
                    ArchiveRetirementPhase::Cancelled
                }
                (false, _) => ArchiveRetirementPhase::Blocked,
                (true, "external_history_lifecycle_cancelled") => ArchiveRetirementPhase::Retired,
                (true, _) => ArchiveRetirementPhase::OutcomeUnknown,
            };
            record.failure = Some(
                match error.to_string().as_str() {
                    "external_history_lifecycle_cancelled" => {
                        "external_history_lifecycle_cancelled"
                    }
                    "external_history_lifecycle_changed" => "external_history_lifecycle_changed",
                    "external_history_lifecycle_unknown_entry" => {
                        "external_history_lifecycle_unknown_entry"
                    }
                    _ => "external_history_retirement_outcome_unknown",
                }
                .into(),
            );
            bump(record)?;
            catalog.save()?;
        }
        let catalog =
            Catalog::open_readonly(&self.base)?.context("external_history_lifecycle_missing")?;
        ensure!(
            catalog.document.scope == self.scope
                && record_fingerprint(&catalog.document, &self.operation)? == self.fingerprint,
            "external_history_lifecycle_changed"
        );
        catalog.retirement_view(&self.operation)
    }
}

fn bump(record: &mut Retirement) -> Result<()> {
    record.sequence = record
        .sequence
        .checked_add(1)
        .context("external_history_lifecycle_sequence_exhausted")?;
    Ok(())
}
#[cfg(all(test, any(target_os = "linux", windows)))]
mod tests;
