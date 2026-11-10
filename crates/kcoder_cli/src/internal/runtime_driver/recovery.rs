use super::*;
use serde_json::Value;

impl NativeRuntimeDriver {
    /// A failed restore cannot have dispatched the later turn ticket. Preserve
    /// its unknown setup outcome while allowing separately authorized new input.
    /// This does not reconcile effects, retry setup, or authorize any operation.
    pub fn unsubmitted_input(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<IntegrationRuntimeUnsubmittedInput>> {
        self.check(context)?;
        let Some(binding) = self.storage.bindings.get(operation)? else {
            return Ok(None);
        };
        let Some(receipt) = self.storage.ledger.read(operation)? else {
            return Ok(None);
        };
        if binding.phase != RuntimePhase::Unknown
            || binding.recovery_from != Some(RuntimePhase::ConfigureDispatched)
            || binding.acceptance.is_some()
            || receipt.phase != IntegrationOperationPhase::Unknown
            || receipt.runtime_acceptance.is_some()
            || binding.spec.configuration.workflow.is_some()
            || binding.thread_id.is_none()
            || binding.thread_id != binding.spec.existing_thread_id
            || !binding
                .original_request
                .payload
                .contains_key("taskBindingRef")
            || binding
                .original_request
                .payload
                .get("source")
                .and_then(|source| source.get("kind"))
                .and_then(Value::as_str)
                != Some("channel")
            || self
                .pending
                .values()
                .any(|ticket| ticket.operation == operation)
            || self.queue.iter().any(|queued| queued == operation)
        {
            return Ok(None);
        }
        Ok(Some(IntegrationRuntimeUnsubmittedInput {
            operation_id: operation.to_owned(),
            operation_revision: receipt.revision,
            thread_id: binding.thread_id.context("RUNTIME_THREAD_REQUIRED")?,
        }))
    }

    /// Cleanup is derived from the original private cancellation intent, never
    /// from a caller flag or an otherwise revoked execution permission.
    pub fn queued_cleanup(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<bool> {
        let binding = self.checked_binding(context, operation)?;
        Ok(binding.phase == RuntimePhase::CancelQueued
            && binding.cancel_request.is_some()
            && binding.acceptance.is_some())
    }
    pub(super) fn observe_thread_receipt(
        &mut self,
        binding: RuntimeBinding,
        result: &Value,
    ) -> Result<()> {
        let receipt: kcoder_app_protocol::ThreadCreationReadResult =
            serde_json::from_value(result.clone())?;
        let Some(receipt) = receipt.receipt else {
            return self
                .storage
                .unknown(binding, "RUNTIME_THREAD_RECEIPT_NOT_OBSERVED");
        };
        ensure!(
            !receipt.thread_id.is_empty()
                && receipt
                    .thread
                    .as_ref()
                    .is_none_or(|thread| thread.id == receipt.thread_id),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        let mut binding = binding;
        ensure!(
            binding
                .thread_id
                .as_ref()
                .is_none_or(|id| id == &receipt.thread_id),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        binding.thread_id = Some(receipt.thread_id);
        if receipt.status != kcoder_app_protocol::ThreadCreationStatus::Ready {
            return self
                .storage
                .unknown(binding, "RUNTIME_THREAD_STARTUP_UNCONFIRMED");
        }
        // Even a ready thread does not prove the original turn was submitted.
        binding.phase = RuntimePhase::RecoverTurnQueued;
        self.save_and_enqueue(binding)
    }
    pub(super) fn observe_turn_receipt(
        &mut self,
        binding: RuntimeBinding,
        result: &Value,
    ) -> Result<()> {
        use kcoder_app_protocol::TurnReceiptStatus;
        let result: kcoder_app_protocol::TurnReceiptReadResult =
            serde_json::from_value(result.clone())?;
        let Some(receipt) = result.receipt else {
            return self
                .storage
                .unknown(binding, "RUNTIME_TURN_RECEIPT_NOT_OBSERVED");
        };
        ensure!(
            receipt.thread_id == super::submission::required_thread(&binding)?
                && !receipt.turn_id.is_empty(),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        if let Some(accepted) = &binding.acceptance {
            ensure!(
                accepted.turn_id.as_deref() == Some(receipt.turn_id.as_str())
                    && accepted.task_id.is_none(),
                "RUNTIME_NATIVE_IDENTITY_MISMATCH"
            );
        }
        let accepted = binding
            .acceptance
            .clone()
            .unwrap_or(IntegrationRuntimeAcceptance {
                thread_id: receipt.thread_id,
                turn_id: Some(receipt.turn_id),
                task_id: None,
                state: IntegrationTaskState::Running,
            });
        let mut binding = self.storage.accept(binding, accepted)?;
        self.track(&binding)?;
        binding.task_state = match receipt.status {
            TurnReceiptStatus::Running => IntegrationTaskState::Running,
            TurnReceiptStatus::Completed => IntegrationTaskState::Completed,
            TurnReceiptStatus::Failed => IntegrationTaskState::Failed,
            TurnReceiptStatus::Interrupted => IntegrationTaskState::Cancelled,
            TurnReceiptStatus::Unknown => IntegrationTaskState::OutcomeUnknown,
        };
        self.settle(binding)
    }

    /// Root must authorize this new mutation. The exact accepted reference is
    /// checked against the original operation; a caller cannot cancel "latest".
    pub fn cancel_task(
        &mut self,
        context: &NativeIntegrationContext,
        original_operation: &str,
        request: &IntegrationRequest,
    ) -> Result<RuntimeSubmission> {
        self.check(context)?;
        request.validate_method(IntegrationPort::Runtime, "cancelTask")?;
        context.validate_scope(&request.scope)?;
        let reference: IntegrationRuntimeReadTaskParams =
            serde_json::from_value(Value::Object(request.payload.clone()))?;
        reference.validate()?;
        let mut binding = self
            .storage
            .bindings
            .get(original_operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        let accepted = binding
            .acceptance
            .clone()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        ensure!(
            reference
                .thread_id
                .as_ref()
                .is_none_or(|id| id == &accepted.thread_id)
                && reference.turn_id == accepted.turn_id
                && reference.task_id == accepted.task_id,
            "RUNTIME_CANCEL_IDENTITY_MISMATCH"
        );
        binding = self.storage.accept(binding, accepted.clone())?;
        let operation = request
            .operation_id
            .clone()
            .context("RUNTIME_OPERATION_INVALID")?;
        if let Some(previous) = &binding.cancel_operation {
            ensure!(previous == &operation, "RUNTIME_CANCEL_CONFLICT");
            self.storage
                .ledger
                .begin(request, "P-RUNTIME", "cancelTask", now()?)?;
            return Ok(RuntimeSubmission::Unconfirmed);
        }
        ensure!(self.queue.len() < MAX_QUEUED, "RUNTIME_QUEUE_CAPACITY");
        if let IntegrationOperationBegin::Existing(_) =
            self.storage
                .ledger
                .begin(request, "P-RUNTIME", "cancelTask", now()?)?
        {
            return Ok(RuntimeSubmission::Unconfirmed);
        }
        self.storage
            .transition(&operation, IntegrationOperationPhase::Executing, None, None)?;
        binding.cancel_operation = Some(operation.clone());
        binding.cancel_request = Some(request.clone());
        if matches!(
            binding.task_state,
            IntegrationTaskState::Completed
                | IntegrationTaskState::Failed
                | IntegrationTaskState::Cancelled
        ) {
            self.storage.transition(
                &operation,
                IntegrationOperationPhase::Completed,
                None,
                None,
            )?;
            let revision = binding.revision;
            self.storage.bindings.save(binding, Some(revision))?;
            return Ok(RuntimeSubmission::Known(accepted));
        }
        self.storage.transition(
            original_operation,
            IntegrationOperationPhase::CancelRequested,
            None,
            None,
        )?;
        binding.phase = RuntimePhase::CancelQueued;
        self.save_and_enqueue(binding)?;
        Ok(RuntimeSubmission::Queued)
    }
}
