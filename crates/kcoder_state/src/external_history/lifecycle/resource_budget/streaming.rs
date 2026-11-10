//! Native writers inherit their archive creator's quota; no source path grants authority.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// This is accounting authority only. The producer must still hold its actual resource writer.
pub(crate) struct ResourceStream {
    store: crate::external_history::ExternalHistoryStore,
    guard: ArchiveReadGuard,
    reservation: ResourceReservation,
    confirmed: AtomicU64,
    committed: AtomicBool,
}

impl Catalog<'_> {
    fn stream_owner(&self, guard: &ArchiveReadGuard) -> Result<Option<(String, String, bool)>> {
        if let Some(budget) = &guard.budget {
            if guard.is_managed() {
                let (id, generation, directory) = guard.binding(&self.document.scope)?;
                let archive = self
                    .document
                    .archives
                    .get(id)
                    .context("external_history_lifecycle_changed")?;
                ensure!(
                    archive.generation == generation
                        && archive.directory.as_deref() == Some(directory)
                        && archive.phase == ArchivePhase::Active,
                    "external_history_lifecycle_changed"
                );
            }
            budget.identity(&self.document.scope)?;
            let group = self
                .document
                .resource_groups
                .get(&budget.reference.group)
                .context("history_resource_ledger_missing")?;
            group.require(&budget.reference)?;
            ensure!(
                group.contains_member(&budget.member),
                "history_resource_wrong_member"
            );
            return Ok(Some((
                budget.reference.group.clone(),
                budget.member.clone(),
                true,
            )));
        }
        let (id, generation, directory) = guard.binding(&self.document.scope)?;
        let archive = self
            .document
            .archives
            .get(id)
            .context("external_history_lifecycle_changed")?;
        ensure!(
            archive.generation == generation
                && archive.directory.as_deref() == Some(directory)
                && archive.phase == ArchivePhase::Active,
            "external_history_lifecycle_changed"
        );
        self.resource_owner_for_archive(archive)
    }
}

impl ArchiveReadGuard {
    /// Existing unaccounted legacy payloads stay readable without inventing allocation receipts.
    pub(crate) fn resource_stream(
        &self,
        kind: ResourceKind,
        identity: &str,
        ceiling: u64,
        files: u32,
        existing: bool,
    ) -> Result<Option<ResourceStream>> {
        ensure!(
            !self.require_budget || self.budget.is_some(),
            "history_resource_upgrade_required"
        );
        if !self.is_managed() && self.budget.is_none() {
            return Ok(None);
        }
        digest(identity)?;
        let store = match &self.budget {
            Some(budget) => budget.store()?,
            None => self.store()?,
        };
        if let Some(budget) = &self.budget {
            budget.account_baseline(&store)?;
        }
        let mut catalog =
            Catalog::open(&store.directory, false)?.context("history_resource_ledger_missing")?;
        let Some((id, member, required)) = catalog.stream_owner(self)? else {
            return Ok(None);
        };
        let charge = ResourceCharge {
            member,
            kind,
            identity: if self.is_managed() {
                // Preserve the canonical identity of already-born managed allocations.
                hash(&(
                    "history-stream/v1",
                    self.binding(&catalog.scope())?,
                    kind,
                    identity,
                ))?
            } else {
                hash(&(
                    "history-accounted-stream/v1",
                    self.resource_binding(&catalog.scope())?,
                    kind,
                    identity,
                ))?
            },
            maximum_bytes: ceiling,
            maximum_files: files,
        };
        let group = catalog.document.resource_groups.get_mut(&id).unwrap();
        let found = group.existing(&charge)?;
        if existing && found.is_none() && !required {
            return Ok(None);
        }
        let (reservation, outcome, changed) = if let Some((reservation, outcome)) = found {
            group.stream_mode(&reservation)?;
            ensure!(
                outcome != ResourceOutcome::Abandoned,
                "history_resource_reservation_abandoned"
            );
            (reservation, outcome, false)
        } else {
            let space = store
                .directory
                .available_storage()
                .map_err(|_| anyhow::anyhow!("history_resource_disk_space_unavailable"))?;
            group.start_stream(charge, space)?
        };
        if changed {
            catalog.save()?;
        }
        let (confirmed, committed) = match outcome {
            ResourceOutcome::Streaming { bytes } => (bytes, false),
            ResourceOutcome::Committed { bytes, .. } => (bytes, true),
            _ => anyhow::bail!("history_resource_reservation_mode_changed"),
        };
        drop(catalog);
        Ok(Some(ResourceStream {
            store,
            guard: self.clone(),
            reservation,
            confirmed: AtomicU64::new(confirmed),
            committed: AtomicBool::new(committed),
        }))
    }
}

impl ResourceStream {
    /// Persist the additional range before the producer can write it. A lost reply keeps its range.
    pub(crate) fn ensure_extent(&self, bytes: u64) -> Result<()> {
        if bytes <= self.confirmed.load(Ordering::Acquire) {
            return Ok(());
        }
        ensure!(!self.is_committed(), "history_resource_already_committed");
        let mut catalog = Catalog::open(&self.store.directory, false)?
            .context("history_resource_ledger_missing")?;
        let (id, member, _) = catalog
            .stream_owner(&self.guard)?
            .context("history_resource_ledger_missing")?;
        ensure!(
            id == self.reservation.budget.group && member == self.reservation.charge.member,
            "history_resource_binding_changed"
        );
        let group = catalog.document.resource_groups.get_mut(&id).unwrap();
        group.stream_mode(&self.reservation)?;
        let observed = match group.outcome(&self.reservation)? {
            ResourceOutcome::Streaming { bytes } => bytes,
            ResourceOutcome::Committed { bytes, .. } => {
                ensure!(
                    bytes >= self.confirmed.load(Ordering::Acquire),
                    "history_resource_binding_changed"
                );
                self.committed.store(true, Ordering::Release);
                bytes
            }
            _ => anyhow::bail!("history_resource_reservation_abandoned"),
        };
        if bytes <= observed {
            self.confirmed.fetch_max(observed, Ordering::Release);
            return Ok(());
        }
        let space = self
            .store
            .directory
            .available_storage()
            .map_err(|_| anyhow::anyhow!("history_resource_disk_space_unavailable"))?;
        let grown = group.grow_stream(&self.reservation, bytes, space)?;
        catalog.save()?;
        self.confirmed.fetch_max(grown, Ordering::Release);
        Ok(())
    }
    pub(crate) fn settle(&self, bytes: u64, files: u32, receipt: &str) -> Result<()> {
        self.store
            .settle_history_resource(&self.reservation, bytes, files, receipt)?;
        self.confirmed.store(bytes, Ordering::Release);
        self.committed.store(true, Ordering::Release);
        Ok(())
    }
    pub(crate) fn is_committed(&self) -> bool {
        self.committed.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests;
