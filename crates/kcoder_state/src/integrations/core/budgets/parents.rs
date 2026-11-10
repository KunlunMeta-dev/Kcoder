//! Read the unique original TaskSlot in this real ledger. Task labels never manufacture credit.
use super::*;

/// Opaque observation retained from the original native journal. This is not a
/// policy grant: admission rechecks the original parent under the ledger lock.
pub struct NativeBudgetTaskParent {
    directory_identity: String,
    principal: NativeBudgetPrincipal,
    binding: NativeBudgetTaskBinding,
    receipt: BudgetReservationReceipt,
}
impl NativeBudgetTaskParent {
    pub fn receipt(&self) -> &BudgetReservationReceipt {
        &self.receipt
    }
}
impl NativeBudgetStore {
    /// Observe this original task's live calls; absence of a callback is never terminal proof.
    pub fn original_task_calls_closed(
        &self,
        slot_id: &str,
        principal: &NativeBudgetPrincipal,
    ) -> Result<bool> {
        let ledger = self.load()?;
        let slot = ledger
            .reservations
            .get(slot_id)
            .context("BUDGET_ORIGINAL_TASK_SLOT_REQUIRED")?;
        ensure!(
            slot.request.matches_native_principal(principal)
                && slot.receipt.unit == BudgetUnit::TaskSlot,
            "BUDGET_ORIGINAL_TASK_SLOT_REQUIRED"
        );
        let closed = ledger
            .reservations
            .values()
            .filter(|row| {
                row.receipt.unit == BudgetUnit::ModelCall
                    && row.receipt.task.root_operation_id == slot.receipt.task.root_operation_id
                    && row.request.matches_native_principal(principal)
            })
            .all(|row| row.receipt.execution_confirmed_terminal);
        self.verify()?;
        Ok(closed)
    }
    /// Observe one real TaskSlot and its exact task policy in a single original
    /// ledger snapshot, including after terminal/expiry. This grants no admission.
    pub fn observe_task_slot_policy(
        &self,
        slot_id: &str,
        policy_id: &str,
    ) -> Result<Option<(BudgetReservationReceipt, BudgetWindowObservation, bool)>> {
        let ledger = self.load()?;
        let Some(slot) = ledger.reservations.get(slot_id) else {
            return Ok(None);
        };
        ensure!(
            slot.receipt.unit == BudgetUnit::TaskSlot,
            "BUDGET_ORIGINAL_TASK_SLOT_REQUIRED"
        );
        let reference = slot
            .receipt
            .policy_refs
            .iter()
            .find(|reference| {
                reference.id == policy_id
                    && reference.scope
                        == BudgetScope::Task(slot.receipt.task.root_operation_id.clone())
            })
            .context("BUDGET_ORIGINAL_TASK_POLICY_REQUIRED")?;
        let policy = ledger
            .windows
            .values()
            .find(|policy| BudgetPolicyReference::from(*policy) == *reference)
            .context("BUDGET_ORIGINAL_TASK_POLICY_CHANGED")?;
        let observation = ledger.observation(policy)?;
        let usage_complete = ledger
            .reservations
            .values()
            .filter(|row| {
                row.receipt.unit == BudgetUnit::ModelCall
                    && row.receipt.task.root_operation_id == slot.receipt.task.root_operation_id
                    && row.receipt.policy_refs.contains(reference)
            })
            .all(|row| {
                row.receipt.coverage == BudgetUsageCoverage::Complete
                    && row.receipt.execution_confirmed_terminal
            });
        self.verify()?;
        Ok(Some((slot.receipt.clone(), observation, usage_complete)))
    }
    /// Host must first verify the actual current Native task and its original
    /// acceptance before constructing binding. Missing or ambiguous slots deny.
    /// This lookup creates no namespace, policy, reservation or execution.
    pub fn original_active_task_slot(
        &self,
        principal: &NativeBudgetPrincipal,
        binding: &NativeBudgetTaskBinding,
    ) -> Result<Option<NativeBudgetTaskParent>> {
        let ledger = self.load()?;
        let Some(receipt) = unique(&ledger, principal, binding)? else {
            return Ok(None);
        };
        self.verify()?;
        Ok(Some(NativeBudgetTaskParent {
            directory_identity: self.storage_directory_identity()?,
            principal: principal.clone(),
            binding: binding.clone(),
            receipt,
        }))
    }
    pub fn verify_original_task_slot(
        &self,
        parent: &NativeBudgetTaskParent,
    ) -> Result<BudgetReservationReceipt> {
        ensure!(
            parent.directory_identity == self.storage_directory_identity()?,
            "BUDGET_PARENT_STORE_CHANGED"
        );
        let ledger = self.load()?;
        current(&ledger, parent)
    }
    /// Reserve a child's actual model request against that same current parent,
    /// principal, root operation, task and policy set. No caller JSON can decode parent.
    pub fn reserve_with_original_task_slot(
        &self,
        parent: &NativeBudgetTaskParent,
        request: &NativeBudgetRequest,
        policies: &[NativeBudgetPolicy],
        now_ms: u64,
    ) -> Result<BudgetReservationResult> {
        self.verify_original_task_slot(parent)?;
        ensure!(
            request.unit == BudgetUnit::ModelCall
                && request.task.actor == BudgetActor::ChildAgent
                && request.task.parent_reservation_id.as_deref()
                    == Some(parent.receipt.reservation_id.as_str())
                && request.task.root_operation_id == parent.receipt.task.root_operation_id
                && request.task.root_task == parent.receipt.task.root_task,
            "BUDGET_ORIGINAL_PARENT_MISMATCH"
        );
        // Publish only the already resolved native policies, as normal reserve does.
        if self.read_reservation(&request.reservation_id)?.is_none() {
            self.install_policies(policies)?;
        }
        self.mutate(|ledger| {
            current(ledger, parent)?;
            let native_request = RequestRecord::from(request);
            ensure!(
                native_request.matches_native_principal(&parent.principal),
                "BUDGET_ORIGINAL_PRINCIPAL_MISMATCH"
            );
            ledger.reserve(request, policies, now_ms)
        })
    }
}
fn unique(
    ledger: &Ledger,
    principal: &NativeBudgetPrincipal,
    binding: &NativeBudgetTaskBinding,
) -> Result<Option<BudgetReservationReceipt>> {
    let mut matching = ledger.reservations.values().filter(|record| {
        record.request.matches_native_principal(principal)
            && binding.matches_task_slot(&record.receipt)
    });
    let first = matching.next().map(|record| record.receipt.clone());
    ensure!(
        matching.next().is_none(),
        "BUDGET_ORIGINAL_PARENT_AMBIGUOUS"
    );
    Ok(first)
}
fn current(ledger: &Ledger, parent: &NativeBudgetTaskParent) -> Result<BudgetReservationReceipt> {
    let current = unique(ledger, &parent.principal, &parent.binding)?
        .context("BUDGET_ORIGINAL_PARENT_NOT_ACTIVE")?;
    ensure!(
        current.reservation_id == parent.receipt.reservation_id
            && current.operation_id == parent.receipt.operation_id,
        "BUDGET_ORIGINAL_PARENT_CHANGED"
    );
    Ok(current)
}
#[cfg(test)]
#[path = "parents/tests.rs"]
mod tests;
