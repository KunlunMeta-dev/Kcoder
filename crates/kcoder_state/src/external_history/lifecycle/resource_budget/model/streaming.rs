//! A stream has an immutable identity/ceiling and a durable, monotonic allocation watermark.
use super::*;

const GROWTH_QUANTUM: u64 = 1024 * 1024;

impl Group {
    pub(in crate::external_history::lifecycle::resource_budget) fn fixed_mode(
        &self,
        charge: &ResourceCharge,
    ) -> Result<()> {
        if let Some(entry) = self.entries.get(&charge.key()?) {
            ensure!(
                !entry.streaming,
                "history_resource_reservation_mode_changed"
            );
        }
        Ok(())
    }

    pub(in crate::external_history::lifecycle::resource_budget) fn stream_mode(
        &self,
        reservation: &ResourceReservation,
    ) -> Result<()> {
        self.require(&reservation.budget)?;
        let entry = self
            .entries
            .get(&reservation.key)
            .context("history_resource_reservation_missing")?;
        ensure!(
            entry.streaming && entry.charge == reservation.charge,
            "history_resource_reservation_mode_changed"
        );
        Ok(())
    }

    pub(in crate::external_history::lifecycle::resource_budget) fn start_stream(
        &mut self,
        charge: ResourceCharge,
        space: AvailableStorage,
    ) -> Result<(ResourceReservation, ResourceOutcome, bool)> {
        charge.validate()?;
        ensure!(
            charge.kind != ResourceKind::Archive,
            "history_resource_invalid_charge"
        );
        if let Some((reservation, outcome)) = self.existing(&charge)? {
            self.stream_mode(&reservation)?;
            ensure!(
                outcome != ResourceOutcome::Abandoned,
                "history_resource_reservation_abandoned"
            );
            return Ok((reservation, outcome, false));
        }
        let before = self.usage()?;
        ensure!(
            self.entries.len() < MAX_CHARGES,
            "history_resource_metadata_budget_exceeded"
        );
        ensure!(
            before
                .reserved_files
                .checked_add(before.committed_files)
                .and_then(|sum| sum.checked_add(charge.maximum_files))
                .is_some_and(|sum| sum <= self.effective_limits().max_payload_files),
            "history_resource_file_budget_exceeded"
        );
        ensure!(
            space.bytes >= self.effective_limits().min_free_bytes,
            "history_resource_disk_space_insufficient"
        );
        if let Some(nodes) = space.file_nodes {
            ensure!(
                nodes
                    >= u64::from(before.reserved_files)
                        + u64::from(charge.maximum_files)
                        + u64::from(self.effective_limits().min_free_file_nodes),
                "history_resource_disk_nodes_insufficient"
            );
        }
        let key = charge.key()?;
        let reservation = ResourceReservation {
            budget: self.reference.clone(),
            key: key.clone(),
            charge: charge.clone(),
        };
        let outcome = ResourceOutcome::Streaming { bytes: 0 };
        self.entries.insert(
            key,
            ChargeRecord {
                charge,
                outcome: outcome.clone(),
                streaming: true,
            },
        );
        Ok((reservation, outcome, true))
    }

    pub(in crate::external_history::lifecycle::resource_budget) fn grow_stream(
        &mut self,
        reservation: &ResourceReservation,
        required: u64,
        space: AvailableStorage,
    ) -> Result<u64> {
        self.stream_mode(reservation)?;
        ensure!(
            required <= reservation.charge.maximum_bytes,
            "history_resource_budget_exceeded"
        );
        let current = match self.outcome(reservation)? {
            ResourceOutcome::Streaming { bytes } => bytes,
            ResourceOutcome::Committed { bytes, .. } => {
                ensure!(required <= bytes, "history_resource_already_committed");
                return Ok(bytes);
            }
            _ => anyhow::bail!("history_resource_reservation_abandoned"),
        };
        if required <= current {
            return Ok(current);
        }
        let usage = self.usage()?;
        let charged = usage
            .reserved_bytes
            .checked_add(usage.committed_bytes)
            .context("history_resource_budget_exceeded")?;
        let remaining = self
            .effective_limits()
            .max_total_bytes
            .checked_sub(charged)
            .context("history_resource_budget_exceeded")?;
        let delta = required - current;
        ensure!(delta <= remaining, "history_resource_budget_exceeded");
        // This is a fresh advisory check for additional bytes, not an OS reservation.
        // Previously written bytes already reduce filesystem free space and are not added twice.
        let available = space
            .bytes
            .checked_sub(self.effective_limits().min_free_bytes)
            .context("history_resource_disk_space_insufficient")?;
        ensure!(
            delta <= available,
            "history_resource_disk_space_insufficient"
        );
        let allowed = current
            .checked_add(remaining.min(available))
            .context("history_resource_budget_exceeded")?
            .min(reservation.charge.maximum_bytes);
        let rounded = required
            .checked_add(GROWTH_QUANTUM - 1)
            .map(|value| value / GROWTH_QUANTUM * GROWTH_QUANTUM)
            .unwrap_or(required);
        let target = if rounded <= allowed {
            rounded
        } else {
            required
        };
        self.entry(reservation)?.outcome = ResourceOutcome::Streaming { bytes: target };
        Ok(target)
    }
}
