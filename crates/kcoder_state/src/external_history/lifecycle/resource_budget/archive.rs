//! Actual managed archive writers inherit only their creator's already-persisted budget.
use super::*;
use kcoder_types::external_history::{
    EXTERNAL_HISTORY_CHUNK_BYTES, ExternalHistoryReceipt, ExternalHistorySnapshot,
};

fn chunk_bytes(bytes: u64) -> Result<u64> {
    bytes
        .div_ceil(EXTERNAL_HISTORY_CHUNK_BYTES as u64)
        .checked_mul(32)
        .context("history_resource_budget_exceeded")
}

pub(super) fn payload_bytes(source: u64, index: u64, original: Option<u64>) -> Result<u64> {
    let mut bytes = source
        .checked_add(index)
        .and_then(|bytes| bytes.checked_add(chunk_bytes(source).ok()?))
        .and_then(|bytes| bytes.checked_add(chunk_bytes(index).ok()?))
        .context("history_resource_budget_exceeded")?;
    if let Some(original) = original {
        bytes = bytes
            .checked_add(original)
            .and_then(|bytes| bytes.checked_add(chunk_bytes(original).ok()?))
            .context("history_resource_budget_exceeded")?;
    }
    Ok(bytes)
}

pub(super) fn specification(
    member: &str,
    snapshot: &ExternalHistorySnapshot,
) -> Result<ResourceCharge> {
    // Each indexed record consumes at least one source byte, including an unterminated tail.
    let index = snapshot
        .record_limit
        .min(snapshot.source_bytes)
        .checked_mul(crate::external_history::stream::ENTRY_BYTES)
        .context("history_resource_budget_exceeded")?;
    Ok(ResourceCharge {
        member: member.into(),
        kind: ResourceKind::Archive,
        identity: super::hash(&("archive-payload/v1", snapshot))?,
        maximum_bytes: payload_bytes(
            snapshot.source_bytes,
            index,
            snapshot.original.as_ref().map(|original| original.bytes),
        )?,
        maximum_files: if snapshot.original.is_some() { 6 } else { 4 },
    })
}

impl Catalog<'_> {
    fn resource_owner(&self, reservation: &Reservation) -> Result<Option<(String, String)>> {
        let archive = self
            .document
            .archives
            .get(&reservation.archive)
            .context("external_history_lifecycle_changed")?;
        ensure!(
            archive.generation == reservation.generation,
            "external_history_lifecycle_changed"
        );
        // A reuse alias keeps the original physical allocation and its original charging owner.
        Ok(self
            .resource_owner_for_archive(archive)?
            .map(|(id, member, _)| (id, member)))
    }

    pub(super) fn resource_owner_for_archive(
        &self,
        archive: &Archive,
    ) -> Result<Option<(String, String, bool)>> {
        if let Some(reference) = &archive.resource_budget {
            let group = self
                .document
                .resource_groups
                .get(&reference.group)
                .context("history_resource_ledger_missing")?;
            group.require(reference)?;
            ensure!(
                group.contains_member(&archive.creator),
                "history_resource_binding_changed"
            );
            return Ok(Some((
                reference.group.clone(),
                archive.creator.clone(),
                true,
            )));
        }
        // Only a pre-budget archive may retain the explicit legacy accounting mode.
        Ok(self
            .document
            .resource_groups
            .iter()
            .find(|(_, group)| group.contains_member(&archive.creator))
            .map(|(id, _)| (id.clone(), archive.creator.clone(), false)))
    }

    pub(in crate::external_history) fn reserve_archive_resource(
        &mut self,
        reservation: &Reservation,
        snapshot: &ExternalHistorySnapshot,
    ) -> Result<()> {
        self.ensure_writer()?;
        let Some((id, member)) = self.resource_owner(reservation)? else {
            return Ok(());
        };
        let charge = specification(&member, snapshot)?;
        let group = self.document.resource_groups.get_mut(&id).unwrap();
        if let Some((_, outcome)) = group.existing(&charge)? {
            ensure!(
                outcome != ResourceOutcome::Abandoned,
                "history_resource_reservation_abandoned"
            );
            return Ok(());
        }
        let space = self
            .base
            .available_storage()
            .map_err(|_| anyhow::anyhow!("history_resource_disk_space_unavailable"))?;
        group.reserve(charge, space)?;
        // The original allocation intent is durable before any payload directory or bytes exist.
        self.save()
    }

    pub(in crate::external_history) fn settle_archive_resource(
        &mut self,
        reservation: &Reservation,
        receipt: &ExternalHistoryReceipt,
    ) -> Result<()> {
        self.ensure_writer()?;
        let Some((id, member)) = self.resource_owner(reservation)? else {
            return Ok(());
        };
        let group = self.document.resource_groups.get_mut(&id).unwrap();
        // The full snapshot is held by the authenticated original archive binding.
        let archive = self
            .base
            .open_child(OsStr::new(&reservation.archive), false)?;
        let binding: crate::external_history::Binding = super::super::load(
            &archive,
            "binding.json",
            crate::external_history::METADATA_BYTES as usize,
        )?;
        ensure!(
            binding.snapshot_sha256 == reservation.snapshot
                && binding.archive_id == reservation.archive,
            "external_history_lifecycle_changed"
        );
        let charge = specification(&member, &binding.snapshot)?;
        let (allocation, _) = group
            .existing(&charge)?
            .context("history_resource_reservation_missing")?;
        let bytes = payload_bytes(
            receipt.source_bytes,
            receipt.index_bytes,
            receipt
                .original
                .as_ref()
                .map(|original| original.source.bytes),
        )?;
        if group.settle(
            &allocation,
            bytes,
            charge.maximum_files,
            &super::hash(receipt)?,
        )? {
            self.save()?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "archive_tests.rs"]
pub(super) mod tests;
