//! Retirement of settled runtime bindings.
//!
//! A binding is the private execution record for one accepted runtime
//! operation. The native receipt ledger remains the execution authority and is
//! never retired here. Once both the binding and its receipt(s) are terminal and
//! the reconciliation window has elapsed, the binding is renamed in place from
//! `binding-<sha256>.json` to `retired-<sha256>.json`:
//!
//! - the rename is a single atomic, directory-synced, no-replace operation made
//!   under the exclusive `bindings.lock`, so it is durable and idempotent;
//! - retired records keep the exact original bytes and stay readable through
//!   `RuntimeBindings::get`, so receipt replays still check the original intent;
//! - capacity checks and full scans only count `binding-*` (live) records.
//!
//! Unknown, non-terminal or unsettled operations are never retired: a lost
//! receipt does not prove an action did not execute.
use super::*;
use crate::{
    NativeRuntimeDriver, RuntimeStorage,
    child_records::ChildIntentPhase,
    types::{RuntimeOutputObservationState, RuntimePhase},
};
use kcoder_integration_storage::integrations::core::{
    IntegrationOperationStore,
    budgets::NativeBudgetStore,
    operation_store::{IntegrationOperationRetirement, MAX_INTEGRATION_OPERATION_RECORDS},
};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::IntegrationNullable;
use kcoder_types::integrations::core::{
    IntegrationOperationPhase, IntegrationOperationReceipt, IntegrationRecovery,
    IntegrationTaskState,
};
use std::collections::BTreeSet;
use std::sync::Arc;

/// A settled binding is kept live for this long after its terminal receipt was
/// recorded. Inside the window, late observers (output observation, repeated
/// settle, cancellation receipts, child workflow facts) may still update the
/// live record. The window is deliberately longer than the longest bounded
/// native runtime (workflow tasks are limited to one day) and the 24 hour
/// attachment/receipt reconnect horizons, matching the 7 day event horizon
/// used by native automation reconciliation.
pub const RUNTIME_BINDING_RETIREMENT_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// New admissions only sweep once the live set is at least this large, so
/// small installations never pay for a retirement scan.
pub const RUNTIME_BINDING_RETIREMENT_SWEEP_THRESHOLD: usize = 256;
const LIVE_PREFIX: &str = "binding-";
const RETIRED_PREFIX: &str = "retired-";
const SCAN_RACE_RETRIES: usize = 4;

/// Outcome of one retirement sweep. Busy means another owner held the binding
/// lock; nothing was skipped silently as "retired".
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeBindingRetirement {
    pub retired: usize,
    pub eligible_pending_window: usize,
    pub busy: bool,
}

/// Result of retiring one operation under the exclusive binding lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetireOne {
    Retired,
    AlreadyRetired,
    NotEligible,
    Missing,
}

impl RuntimeBindings {
    /// Names of live bindings. Another owner may retire a record between the
    /// directory read and the leaf open; such a scan is repeated (it has no
    /// side effects) instead of being reported as corruption.
    pub(super) fn live_names(&self) -> Result<Vec<String>> {
        let mut attempt = 0;
        loop {
            let mut names = Vec::new();
            let scanned = self.directory.visit_regular_files(
                |name| name.to_string_lossy().starts_with(LIVE_PREFIX),
                |name, _| {
                    ensure!(names.len() < MAX_BINDINGS, "RUNTIME_BINDING_CAPACITY");
                    names.push(name.to_str().context("RUNTIME_BINDING_CORRUPT")?.to_owned());
                    Ok(())
                },
            );
            match scanned {
                Ok(()) => return Ok(names),
                Err(error) if missing(&error) && attempt + 1 < SCAN_RACE_RETRIES => attempt += 1,
                Err(error) => return Err(error),
            }
        }
    }

    /// A live name that disappeared during a scan is acceptable only when its
    /// retired twin now exists; any other disappearance fails closed.
    pub(super) fn vanished_was_retired(&self, live_name: &str) -> Result<bool> {
        let suffix = live_name
            .strip_prefix(LIVE_PREFIX)
            .context("RUNTIME_BINDING_CORRUPT")?;
        Ok(read(&self.directory, &format!("{RETIRED_PREFIX}{suffix}"))?.is_some())
    }

    pub(super) fn read_retired(&self, operation: &str) -> Result<Option<RuntimeBinding>> {
        let Some(bytes) = read(&self.directory, &retired_leaf(operation)?)? else {
            return Ok(None);
        };
        let value: RuntimeBinding = serde_json::from_slice(&bytes)?;
        self.validate(&value)?;
        ensure!(value.operation_id == operation, "RUNTIME_BINDING_CORRUPT");
        Ok(Some(value))
    }

    pub(super) fn is_retired(&self, operation: &str) -> Result<bool> {
        Ok(read(&self.directory, &retired_leaf(operation)?)?.is_some())
    }

    /// Number of live bindings; retired records never consume capacity.
    pub fn live_count(&self) -> Result<usize> {
        self.verify()?;
        Ok(self.live_names()?.len())
    }

    /// Retire one binding when `eligible` accepts the record re-read under the
    /// exclusive lock. Repeating a completed retirement is a no-op.
    pub(crate) fn retire(
        &self,
        operation: &str,
        eligible: impl FnOnce(&RuntimeBinding) -> Result<bool>,
    ) -> Result<RetireOne> {
        let _lease = self
            .directory
            .try_existing_portable_lock(
                OsStr::new("bindings.lock"),
                &self.lock_identity,
                PrivateLeaseMode::Exclusive,
            )?
            .ok_or(RuntimeBindingPrewriteConflict::Busy)?;
        self.verify()?;
        let live = leaf(operation)?;
        let retired = retired_leaf(operation)?;
        let Some(binding) = self.read_binding(operation)? else {
            return Ok(if self.read_retired(operation)?.is_some() {
                RetireOne::AlreadyRetired
            } else {
                RetireOne::Missing
            });
        };
        // A live record and a retired twin cannot both exist: retirement is a
        // single no-replace rename and new bindings refuse retired operations.
        ensure!(
            read(&self.directory, &retired)?.is_none(),
            "RUNTIME_BINDING_CORRUPT"
        );
        if !eligible(&binding)? {
            return Ok(RetireOne::NotEligible);
        }
        // rename_no_replace syncs the directory, so the retirement is durable
        // before the lock is released.
        self.directory
            .rename_no_replace(OsStr::new(&live), OsStr::new(&retired))?;
        self.verify()?;
        Ok(RetireOne::Retired)
    }
}

fn retired_leaf(operation: &str) -> Result<String> {
    let live = leaf(operation)?;
    let suffix = live
        .strip_prefix(LIVE_PREFIX)
        .context("RUNTIME_BINDING_CORRUPT")?;
    Ok(format!("{RETIRED_PREFIX}{suffix}"))
}

/// Binding-local settlement: terminal, no pending interaction, no prepared
/// child launch and no pending output observation.
fn binding_settled(binding: &RuntimeBinding) -> bool {
    let terminal = match binding.phase {
        RuntimePhase::Terminal => matches!(
            binding.task_state,
            IntegrationTaskState::Completed
                | IntegrationTaskState::Failed
                | IntegrationTaskState::Cancelled
        ),
        RuntimePhase::Rejected => binding.task_state != IntegrationTaskState::OutcomeUnknown,
        _ => false,
    };
    terminal
        && binding.pending_interactions.is_empty()
        && binding
            .child_intents
            .iter()
            .all(|child| child.phase == ChildIntentPhase::Accepted)
        && binding
            .output_observation
            .as_ref()
            .is_none_or(|observation| observation.state != RuntimeOutputObservationState::Pending)
}

fn receipt_settled(
    receipt: &IntegrationOperationReceipt,
    expected: &[IntegrationOperationPhase],
    now_ms: u64,
) -> Settlement {
    if !receipt.phase.is_terminal()
        || !expected.contains(&receipt.phase)
        || receipt
            .error
            .as_ref()
            .is_some_and(|error| error.recovery == IntegrationRecovery::ReconcileOriginal)
    {
        return Settlement::Unsettled;
    }
    // A clock that moved backwards never shortens the window.
    match now_ms.checked_sub(receipt.updated_at_ms) {
        Some(age) if age >= RUNTIME_BINDING_RETIREMENT_WINDOW_MS => Settlement::Settled,
        _ => Settlement::InsideWindow,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Settlement {
    Settled,
    InsideWindow,
    Unsettled,
}

impl RuntimeStorage {
    fn settlement(&self, binding: &RuntimeBinding, now_ms: u64) -> Result<Settlement> {
        if !binding_settled(binding) {
            return Ok(Settlement::Unsettled);
        }
        let expected: &[IntegrationOperationPhase] = if binding.phase == RuntimePhase::Rejected {
            &[IntegrationOperationPhase::Rejected]
        } else {
            &[
                IntegrationOperationPhase::Completed,
                IntegrationOperationPhase::Cancelled,
            ]
        };
        // A missing receipt is an unknown outcome, never a settled one.
        let Some(receipt) = self.ledger.read(&binding.operation_id)? else {
            return Ok(Settlement::Unsettled);
        };
        let mut settlement = receipt_settled(&receipt, expected, now_ms);
        if let Some(cancel) = &binding.cancel_operation {
            let Some(receipt) = self.ledger.read(cancel)? else {
                return Ok(Settlement::Unsettled);
            };
            let cancel = receipt_settled(
                &receipt,
                &[
                    IntegrationOperationPhase::Completed,
                    IntegrationOperationPhase::Cancelled,
                    IntegrationOperationPhase::Rejected,
                ],
                now_ms,
            );
            settlement = match (settlement, cancel) {
                (Settlement::Unsettled, _) | (_, Settlement::Unsettled) => Settlement::Unsettled,
                (Settlement::Settled, Settlement::Settled) => Settlement::Settled,
                _ => Settlement::InsideWindow,
            };
        }
        Ok(settlement)
    }

    /// Retire every binding whose terminal receipt settled before the
    /// reconciliation window. Each record is re-read and re-checked under the
    /// exclusive binding lock, so a concurrent writer cannot be overtaken.
    pub fn retire_settled_bindings(&self, now_ms: u64) -> Result<RuntimeBindingRetirement> {
        self.verify()?;
        let mut candidates = Vec::new();
        self.bindings.visit(|binding| {
            if binding_settled(binding) {
                candidates.push(binding.operation_id.clone());
            }
            Ok(())
        })?;
        let mut result = RuntimeBindingRetirement::default();
        for operation in candidates {
            let mut inside_window = false;
            let outcome = self.bindings.retire(&operation, |binding| {
                Ok(match self.settlement(binding, now_ms)? {
                    Settlement::Settled => true,
                    Settlement::InsideWindow => {
                        inside_window = true;
                        false
                    }
                    Settlement::Unsettled => false,
                })
            });
            match outcome {
                Ok(RetireOne::Retired) => result.retired += 1,
                Ok(_) => result.eligible_pending_window += usize::from(inside_window),
                Err(error)
                    if error.downcast_ref::<RuntimeBindingPrewriteConflict>()
                        == Some(&RuntimeBindingPrewriteConflict::Busy) =>
                {
                    result.busy = true;
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(result)
    }

    /// Sweep only when the live set is large, then require free live capacity.
    /// Called before a new admission begins its receipt, so neither a sweep
    /// error nor a full store strands a begun operation without its binding.
    pub(crate) fn retire_before_admission(
        &self,
        context: &NativeIntegrationContext,
        now_ms: u64,
    ) -> Result<()> {
        let mut live = self.bindings.live_count()?;
        if live >= RUNTIME_BINDING_RETIREMENT_SWEEP_THRESHOLD.min(MAX_BINDINGS)
            && self.retire_settled_bindings(now_ms)?.retired > 0
        {
            live = self.bindings.live_count()?;
        }
        ensure!(live < MAX_BINDINGS, "RUNTIME_BINDING_CAPACITY");
        // Bindings are swept first, so only still-live bindings keep receipts.
        retire_receipts_if_needed(context, &self.ledger, now_ms)?;
        Ok(())
    }
}

/// Receipt sweeps start once the shared operation ledger is three quarters full.
pub const OPERATION_RECEIPT_SWEEP_THRESHOLD: usize =
    MAX_INTEGRATION_OPERATION_RECORDS - MAX_INTEGRATION_OPERATION_RECORDS / 4;

/// Operation ids an active owner still depends on, captured before the
/// receipt writer lock is taken: every live runtime binding (its operation and
/// cancellation) and every budget reservation not confirmed terminal. Retired
/// bindings are settled history and keep no receipt live. Native delegation
/// journal operations are a separate namespace; remote delegations reach this
/// ledger only through their runtime root, which a binding or reservation holds.
pub fn active_operation_references(context: &NativeIntegrationContext) -> Result<BTreeSet<String>> {
    let mut references = BTreeSet::new();
    if let Some(storage) = NativeRuntimeDriver::observe_storage(context)? {
        storage.bindings.visit(|binding| {
            references.insert(binding.operation_id.clone());
            if let Some(cancel) = &binding.cancel_operation {
                references.insert(cancel.clone());
            }
            Ok(())
        })?;
    }
    // Budgets are account-scoped; organization scopes cannot hold a ledger.
    if context.scope().organization_id.is_none() {
        let mut account = context.scope().clone();
        account.workspace_id = IntegrationNullable::Null;
        let profile = context.profile()?;
        if let Some(guard) = NativeDomainGuard::observe(profile, &account, NativeDomain::Budgets)?
            && let Some(budgets) = NativeBudgetStore::open_in(
                &guard.directory(profile)?,
                OsStr::new("ledger"),
                &account,
            )?
        {
            references.extend(budgets.active_root_operations()?);
        }
    }
    Ok(references)
}

/// Retire settled operation receipts that no active owner references.
pub fn retire_settled_operation_receipts(
    context: &NativeIntegrationContext,
    ledger: &IntegrationOperationStore,
    now_ms: u64,
) -> Result<IntegrationOperationRetirement> {
    let references = active_operation_references(context)?;
    ledger.retire_settled(now_ms, |receipt| references.contains(&receipt.operation_id))
}

/// Sweep only a nearly full ledger; a busy writer simply skips this round and
/// the ledger's own capacity check still refuses before creating a receipt.
pub fn retire_receipts_if_needed(
    context: &NativeIntegrationContext,
    ledger: &IntegrationOperationStore,
    now_ms: u64,
) -> Result<()> {
    if ledger.live_count()? >= OPERATION_RECEIPT_SWEEP_THRESHOLD {
        retire_settled_operation_receipts(context, ledger, now_ms)?;
    }
    Ok(())
}

impl NativeRuntimeDriver {
    /// Open only the verified runtime storage, without rebuilding the
    /// reference index from every live binding. For callers that already know
    /// the exact operation id.
    pub fn observe_runtime_storage(
        context: &NativeIntegrationContext,
    ) -> Result<Option<Arc<RuntimeStorage>>> {
        Self::observe_storage(context)
    }

    /// Read the original host-prepared policy of one known accepted operation
    /// by a direct binding lookup (live or retired), never a full scan.
    pub fn read_original_execution_configuration(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<crate::RuntimeExecutionConfiguration>> {
        context.verify()?;
        let Some(storage) = Self::observe_storage(context)? else {
            return Ok(None);
        };
        storage.verify_ledger()?;
        let Some(binding) = storage.bindings.get(operation)? else {
            return Ok(None);
        };
        context.validate_scope(&binding.source_scope)?;
        binding.spec.validate()?;
        ensure!(
            binding.acceptance.is_some(),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        Ok(Some(binding.spec.configuration))
    }
}

#[cfg(test)]
#[path = "binding_retention_tests.rs"]
mod tests;
