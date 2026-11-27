//! Bounded retention for settled reservations.
//!
//! Pruning only removes reservations whose execution is confirmed terminal,
//! whose every frozen policy window ended before the retention cutoff, and
//! whose whole root operation is equally settled. Each pruned id keeps a
//! tombstone with its original intent, so a replay can never be admitted as a
//! fresh reservation. Active, dispatched, unknown-outcome and subscription
//! reservations are never pruned.
use super::*;

/// Settled reservations stay readable for this long after their last update
/// and after every window they were charged to has ended.
pub(crate) const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Pruning runs inside the admission transaction once the ledger reaches this
/// many reservations; below it the ledger is left untouched.
pub(crate) const PRUNE_HIGH_WATER: usize = MAX_RESERVATIONS * 3 / 4;
/// Tombstones are small but still bounded. When full, pruning stops and the
/// original capacity error returns; identities are never forgotten.
pub(crate) const MAX_RETIRED: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetiredReservation {
    pub intent: String,
    pub root_operation_id: String,
    pub retired_at_ms: u64,
}

impl Ledger {
    pub(super) fn validate_retired(&self) -> Result<()> {
        ensure!(
            self.retired.len() <= MAX_RETIRED && (self.version == 2 || self.retired.is_empty()),
            "BUDGET_LEDGER_CORRUPT"
        );
        for (id, retired) in &self.retired {
            label(id)?;
            label(&retired.root_operation_id)?;
            ensure!(
                !self.reservations.contains_key(id)
                    && retired.intent.len() == 64
                    && retired.intent.bytes().all(|c| c.is_ascii_hexdigit()),
                "BUDGET_LEDGER_CORRUPT"
            );
        }
        Ok(())
    }

    /// Retire settled reservations older than the retention cutoff. Returns the
    /// number pruned. The caller's transaction persists the result atomically.
    pub(crate) fn prune_settled(&mut self, now: u64) -> Result<usize> {
        let Some(cutoff) = now.checked_sub(RETENTION_MS) else {
            return Ok(0);
        };
        let mut groups: BTreeMap<String, bool> = BTreeMap::new();
        for record in self.reservations.values() {
            let settled = self.settled_before(record, cutoff)?;
            *groups
                .entry(record.request.task.root_operation_id.clone())
                .or_insert(true) &= settled;
        }
        // A retained reservation keeps its parent's whole operation group.
        loop {
            let mut changed = false;
            for record in self.reservations.values() {
                if groups[&record.request.task.root_operation_id] {
                    continue;
                }
                if let Some(parent) = record
                    .request
                    .task
                    .parent_reservation_id
                    .as_ref()
                    .and_then(|id| self.reservations.get(id))
                {
                    let root = &parent.request.task.root_operation_id;
                    if groups[root] {
                        groups.insert(root.clone(), false);
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        let ids = self
            .reservations
            .iter()
            .filter(|(_, record)| groups[&record.request.task.root_operation_id])
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() || self.retired.len() + ids.len() > MAX_RETIRED {
            return Ok(0);
        }
        for id in &ids {
            let record = self
                .reservations
                .remove(id)
                .context("BUDGET_LEDGER_CORRUPT")?;
            self.retired.insert(
                id.clone(),
                RetiredReservation {
                    intent: record.intent,
                    root_operation_id: record.request.task.root_operation_id,
                    retired_at_ms: now,
                },
            );
        }
        self.version = 2;
        self.bump()?;
        Ok(ids.len())
    }

    fn settled_before(&self, record: &ReservationRecord, cutoff: u64) -> Result<bool> {
        if record.terminal.is_none()
            || !record.receipt.execution_confirmed_terminal
            || record.receipt.phase != BudgetPhase::Terminal
            || record.receipt.updated_at_ms >= cutoff
            // A later subscription window may still account calls by creation time.
            || record.request.principal.subscription_id.is_some()
        {
            return Ok(false);
        }
        if record
            .policies
            .iter()
            .any(|policy| policy.window.ends_at_ms > cutoff)
        {
            return Ok(false);
        }
        for window in self.windows.values() {
            if window.subscription_window_accounting
                && window.window.ends_at_ms > cutoff
                && record.receipt.created_at_ms >= window.window.starts_at_ms
                && record.receipt.created_at_ms < window.window.ends_at_ms
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
