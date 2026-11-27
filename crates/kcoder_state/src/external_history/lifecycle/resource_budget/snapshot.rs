//! Existing legacy bytes are counted from the pinned original snapshot and native receipt.
use super::*;
use kcoder_types::external_history::{ExternalHistoryReceipt, ExternalHistorySnapshot};

impl crate::external_history::ExternalHistoryStore {
    /// Reserve before legacy archive IO. This receipt confers no filesystem or deletion rights.
    pub fn reserve_archive_snapshot_resource(
        &self,
        reference: &ResourceBudgetReference,
        member: &str,
        snapshot: &ExternalHistorySnapshot,
    ) -> Result<ResourceReservation> {
        crate::external_history::validate_snapshot(snapshot)?;
        let charge = archive::specification(member, snapshot)?;
        self.reserve_history_resource(reference, charge)
            .map(|(reservation, _)| reservation)
    }

    /// Only a native producer that verified the same immutable snapshot may settle this receipt.
    pub fn settle_archive_snapshot_resource(
        &self,
        reservation: &ResourceReservation,
        receipt: &ExternalHistoryReceipt,
    ) -> Result<()> {
        ensure!(
            reservation.charge.kind == ResourceKind::Archive,
            "history_resource_invalid_charge"
        );
        let bytes = archive::payload_bytes(
            receipt.source_bytes,
            receipt.index_bytes,
            receipt
                .original
                .as_ref()
                .map(|original| original.source.bytes),
        )?;
        self.settle_history_resource(
            reservation,
            bytes,
            reservation.charge.maximum_files,
            &hash(receipt)?,
        )
    }
}
