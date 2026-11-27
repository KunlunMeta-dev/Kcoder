//! Retirement of settled operation receipts.
//!
//! A receipt is the execution authority for its operation id, so retirement
//! never deletes it. A settled receipt is renamed in place from
//! `op-<sha256>.json` to `retired-op-<sha256>.json` under the writer lock:
//!
//! - reads and `begin` replays fall back to the retired twin, so an existing id
//!   still returns its original receipt and still rejects a different intent;
//! - `compare_and_swap` never rewrites a retired receipt;
//! - capacity counts only live `op-*` receipts.
//!
//! Before the first rename the store binding is upgraded from version 1 to 2
//! with an atomic replace. Binaries that only understand version 1 then fail
//! closed on open instead of treating a retired id as never seen. Every step is
//! a single atomic, directory-synced operation, so a crash between steps leaves
//! either a valid version 2 store with fewer retired receipts or the original.
use super::*;
use kcoder_types::integrations::core::IntegrationRecovery;

/// Same reconciliation window as runtime bindings and budget reservations.
pub const INTEGRATION_OPERATION_RETIREMENT_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const LIVE_PREFIX: &str = "op-";
const RETIRED_PREFIX: &str = "retired-";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct IntegrationOperationRetirement {
    pub retired: usize,
    /// Terminal receipts kept because they are inside the window or still
    /// referenced by an active owner.
    pub kept: usize,
    /// Another writer held the store; nothing was retired by this call.
    pub busy: bool,
}

fn retired_name(operation_id: &str) -> Result<String> {
    Ok(format!("{RETIRED_PREFIX}{}", record_name(operation_id)?))
}

/// Terminal and settled: no unknown outcome and no retry or reconciliation
/// hint that asks a client to come back to this receipt.
fn settled(receipt: &IntegrationOperationReceipt) -> bool {
    receipt.phase.is_terminal()
        && receipt.error.as_ref().is_none_or(|error| {
            !matches!(
                error.recovery,
                IntegrationRecovery::ReconcileOriginal | IntegrationRecovery::RetryRead
            )
        })
}

impl IntegrationOperationStore {
    pub(super) fn read_retired_record(&self, operation_id: &str) -> Result<Option<Record>> {
        self.read_named_record(operation_id, &retired_name(operation_id)?)
    }

    pub(super) fn live_count_locked(&self) -> Result<usize> {
        self.directory.count_regular_files_bounded(
            |name| {
                name.to_str()
                    .is_some_and(|s| s.starts_with(LIVE_PREFIX) && s.ends_with(".json"))
            },
            MAX_INTEGRATION_OPERATION_RECORDS,
        )
    }

    /// Number of live receipts (saturating at the capacity).
    pub fn live_count(&self) -> Result<usize> {
        self.verify_binding()?;
        self.live_count_locked()
    }

    /// Retire terminal, settled receipts last updated before the window.
    /// `referenced` is the caller's snapshot of active owners (runtime
    /// bindings, budget reservations, delegations); a referenced receipt is
    /// kept. Unknown and non-terminal receipts are never retired.
    pub fn retire_settled(
        &self,
        now_ms: u64,
        mut referenced: impl FnMut(&IntegrationOperationReceipt) -> bool,
    ) -> Result<IntegrationOperationRetirement> {
        let mut result = IntegrationOperationRetirement::default();
        let Some(_lock) = self.directory.try_existing_portable_lock(
            OsStr::new("operations.lock"),
            &self.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?
        else {
            result.busy = true;
            return Ok(result);
        };
        self.verify_binding()?;
        // Under the writer lock no other owner can create or retire a receipt.
        let mut names = Vec::new();
        self.directory.visit_regular_files(
            |name| {
                name.to_str()
                    .is_some_and(|s| s.starts_with(LIVE_PREFIX) && s.ends_with(".json"))
            },
            |name, _| {
                ensure!(
                    names.len() < MAX_INTEGRATION_OPERATION_RECORDS,
                    "integration operation capacity reached"
                );
                names.push(name.to_str().context("invalid receipt name")?.to_owned());
                Ok(())
            },
        )?;
        let mut eligible = Vec::new();
        for name in names {
            let bytes = self
                .read_bytes(OsStr::new(&name))?
                .context("integration operation record disappeared")?;
            let record: Record =
                serde_json::from_slice(&bytes).context("invalid integration operation record")?;
            validate_record(&record)?;
            let receipt = &record.receipt;
            ensure!(
                record_name(&receipt.operation_id)? == name
                    && IntegrationOwner::from(&receipt.scope) == self.owner,
                "integration operation record owner mismatch"
            );
            if !settled(receipt) {
                continue;
            }
            // A clock that moved backwards never shortens the window.
            let old_enough = now_ms
                .checked_sub(receipt.updated_at_ms)
                .is_some_and(|age| age >= INTEGRATION_OPERATION_RETIREMENT_WINDOW_MS);
            if !old_enough || referenced(receipt) {
                result.kept += 1;
                continue;
            }
            eligible.push(receipt.operation_id.clone());
        }
        if eligible.is_empty() {
            return Ok(result);
        }
        self.mark_retirement_capable()?;
        for operation in eligible {
            let live = record_name(&operation)?;
            let retired = retired_name(&operation)?;
            // A live receipt and its retired twin never coexist.
            ensure!(
                self.read_bytes(OsStr::new(&retired))?.is_none(),
                "integration operation retired twin conflict"
            );
            self.directory
                .rename_no_replace(OsStr::new(&live), OsStr::new(&retired))?;
            result.retired += 1;
        }
        self.verify_binding()?;
        Ok(result)
    }

    /// Upgrade the binding to version 2 before any receipt is retired.
    fn mark_retirement_capable(&self) -> Result<()> {
        let mut binding = read_binding(&self.directory)?;
        if binding.version == 2 {
            return Ok(());
        }
        ensure!(
            binding.version == 1,
            "unsupported integration operation store"
        );
        binding.version = 2;
        self.directory
            .atomic_replace(OsStr::new("owner.json"), &serde_json::to_vec(&binding)?)?;
        self.verify_binding()
    }
}

#[cfg(test)]
#[path = "retention_tests.rs"]
mod tests;
