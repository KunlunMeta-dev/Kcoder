use super::*;
use serde_json::{Value, json};

impl NativeRuntimeDriver {
    pub fn next_operation_id(&self) -> Option<&str> {
        self.queue.front().map(String::as_str)
    }

    /// Return busy-refused turns whose backoff elapsed to the dispatch queue in
    /// their original refusal order. Each keeps its persisted binding and stable
    /// `clientMessageId`; source admission is checked again before dispatch.
    pub fn release_due_busy_turns(&mut self, now: std::time::Instant) {
        let mut due = self
            .busy
            .iter()
            .filter(|(operation, retry)| {
                retry.due.is_some_and(|due| due <= now)
                    && !self.queue.iter().any(|queued| queued == *operation)
            })
            .map(|(operation, retry)| (retry.first_refused, operation.clone()))
            .collect::<Vec<_>>();
        due.sort();
        for (_, operation) in due {
            if self.queue.len() >= MAX_QUEUED {
                break;
            }
            if let Some(retry) = self.busy.get_mut(&operation) {
                retry.due = None;
            }
            self.queue.push_back(operation);
        }
    }

    pub fn reject_queued_admission(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<()> {
        self.reject_queued_with_reason(context, operation, "RUNTIME_ADMISSION_EXPIRED")
    }

    pub fn reject_queued_with_reason(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        code: &'static str,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            self.queue.front().is_some_and(|value| value == operation),
            "RUNTIME_QUEUE_IDENTITY_MISMATCH"
        );
        let binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            matches!(
                binding.phase,
                RuntimePhase::ThreadQueued
                    | RuntimePhase::ConfigureQueued
                    | RuntimePhase::TurnQueued
                    | RuntimePhase::WorkflowQueued
            ),
            "RUNTIME_DISPATCH_STATE_UNCONFIRMED"
        );
        self.queue.pop_front();
        self.reject_before_dispatch(binding, code)
    }

    /// Persist dispatched before exposing a command. Root routes RPC variants
    /// through its ordinary dispatch and returns only that command's response.
    pub fn next_command(
        &mut self,
        context: &NativeIntegrationContext,
    ) -> Result<Option<NativeRuntimeCommand>> {
        self.check(context)?;
        while let Some(operation) = self.queue.pop_front() {
            let mut binding = self
                .storage
                .bindings
                .get(&operation)?
                .context("RUNTIME_BINDING_MISSING")?;
            let recovery = matches!(
                binding.phase,
                RuntimePhase::RecoverThreadQueued | RuntimePhase::RecoverTurnQueued
            );
            if !recovery
                && binding.phase != RuntimePhase::CancelQueued
                && context.validate_scope(&binding.source_scope).is_err()
            {
                self.reject_before_dispatch(binding, "RUNTIME_ADMISSION_EXPIRED")?;
                continue;
            }
            if binding.phase == RuntimePhase::CancelQueued {
                let cancel = binding
                    .cancel_request
                    .as_ref()
                    .context("RUNTIME_CANCEL_UNCONFIRMED")?;
                context.validate_scope(&cancel.scope)?;
            }
            let dispatched = match binding.phase {
                RuntimePhase::ThreadQueued => RuntimePhase::ThreadDispatched,
                RuntimePhase::ConfigureQueued => RuntimePhase::ConfigureDispatched,
                RuntimePhase::TurnQueued => RuntimePhase::TurnDispatched,
                RuntimePhase::WorkflowQueued => RuntimePhase::WorkflowDispatched,
                RuntimePhase::RecoverThreadQueued => RuntimePhase::RecoverThreadDispatched,
                RuntimePhase::RecoverTurnQueued => RuntimePhase::RecoverTurnDispatched,
                RuntimePhase::CancelQueued => RuntimePhase::CancelDispatched,
                _ => continue,
            };
            binding.phase = dispatched;
            let revision = binding.revision;
            let binding = self.storage.bindings.save(binding, Some(revision))?;
            let ticket = NativeRuntimeTicket {
                id: format!("native-runtime-{}", uuid::Uuid::new_v4()),
                operation: operation.clone(),
                phase: dispatched,
            };
            let command = match dispatched {
                RuntimePhase::ThreadDispatched => {
                    let model = &binding.spec.configuration.model.model;
                    let selected = model.provider_id.as_ref().map_or_else(
                        || model.model_id.clone(),
                        |provider| format!("{provider}::{}", model.model_id),
                    );
                    NativeRuntimeCommand::Rpc {
                        ticket: ticket.clone(),
                        method: "thread/start",
                        params: json!({
                            "clientRequestId": binding.thread_request_id,
                            "studioWorkMode": binding.spec.studio_work_mode,
                            "model": selected,
                        }),
                    }
                }
                RuntimePhase::ConfigureDispatched => NativeRuntimeCommand::Configure {
                    ticket: ticket.clone(),
                    thread_id: required_thread(&binding)?,
                    configuration: Box::new(binding.spec.configuration.clone()),
                },
                RuntimePhase::TurnDispatched => NativeRuntimeCommand::Rpc {
                    ticket: ticket.clone(),
                    method: "turn/start",
                    params: json!({
                        "threadId": required_thread(&binding)?, "clientMessageId": binding.client_message_id,
                        "input": binding.spec.input, "clientPresentation": binding.spec.client_presentation,
                    }),
                },
                RuntimePhase::WorkflowDispatched => NativeRuntimeCommand::StartWorkflow {
                    ticket: ticket.clone(),
                    thread_id: required_thread(&binding)?,
                    workflow: binding
                        .spec
                        .configuration
                        .workflow
                        .clone()
                        .context("RUNTIME_WORKFLOW_MISSING")?,
                },
                RuntimePhase::RecoverThreadDispatched => NativeRuntimeCommand::Rpc {
                    ticket: ticket.clone(),
                    method: "thread/creation/read",
                    params: json!({"clientRequestId":binding.thread_request_id}),
                },
                RuntimePhase::RecoverTurnDispatched => NativeRuntimeCommand::Rpc {
                    ticket: ticket.clone(),
                    method: "turn/receipt/read",
                    params: json!({"threadId":required_thread(&binding)?,"clientMessageId":binding.client_message_id}),
                },
                RuntimePhase::CancelDispatched => {
                    let accepted = binding
                        .acceptance
                        .as_ref()
                        .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
                    if let Some(run) = &accepted.task_id {
                        NativeRuntimeCommand::StopWorkflow {
                            ticket: ticket.clone(),
                            thread_id: accepted.thread_id.clone(),
                            run_id: run.clone(),
                        }
                    } else {
                        NativeRuntimeCommand::Rpc {
                            ticket: ticket.clone(),
                            method: "turn/interrupt",
                            params: json!({"threadId":accepted.thread_id,"turnId":accepted.turn_id}),
                        }
                    }
                }
                _ => anyhow::bail!("RUNTIME_COMMAND_PHASE_INVALID"),
            };
            self.pending.insert(ticket.id.clone(), ticket);
            return Ok(Some(command));
        }
        Ok(None)
    }

    pub fn observe_response(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        response: &Value,
    ) -> Result<()> {
        self.check(context)?;
        if ticket.phase == RuntimePhase::CancelDispatched {
            ensure!(
                self.pending.get(&ticket.id) == Some(ticket),
                "RUNTIME_TICKET_MISMATCH"
            );
            let binding = self
                .storage
                .bindings
                .get(&ticket.operation)?
                .context("RUNTIME_BINDING_MISSING")?;
            if binding.phase == RuntimePhase::Terminal {
                self.pending.remove(&ticket.id);
                return Ok(());
            }
        }
        let binding = self.take_pending(ticket)?;
        let busy_retry = self.busy.remove(&ticket.operation);
        if ticket.phase == RuntimePhase::TurnDispatched && binding.acceptance.is_some() {
            self.track(&binding)?;
        }
        if ticket.phase == RuntimePhase::TurnDispatched
            && binding.acceptance.is_none()
            && is_busy_before_registration(response)
        {
            return self.defer_busy_turn(binding, busy_retry, std::time::Instant::now());
        }
        if response.get("error").is_some() || response.get("result").is_none() {
            if ticket.phase == RuntimePhase::TurnDispatched && binding.acceptance.is_some() {
                // The owned Accepted observer already committed the original receipt.
                // A lost response cannot erase that durable execution fact.
                return self.track(&binding);
            }
            // Startup hooks, writes, or admission may precede an error response.
            return self
                .storage
                .unknown(binding, "RUNTIME_NATIVE_RESPONSE_UNCONFIRMED");
        }
        let result = &response["result"];
        match ticket.phase {
            RuntimePhase::ConfigureDispatched => {
                let resumed = serde_json::from_value::<kcoder_app_protocol::ThreadResumeResult>(
                    result.clone(),
                );
                let expected = required_thread(&binding)?;
                if !resumed.is_ok_and(|value| value.thread.id == expected)
                    || binding.spec.existing_thread_id.as_deref() != Some(expected.as_str())
                    || binding.acceptance.is_some()
                {
                    return self
                        .storage
                        .unknown(binding, "RUNTIME_NATIVE_IDENTITY_MISMATCH");
                }
                let mut binding = binding;
                binding.phase = RuntimePhase::ConfigureQueued;
                self.save_and_enqueue(binding)
            }
            RuntimePhase::ThreadDispatched => {
                let result: kcoder_app_protocol::ThreadStartResult =
                    serde_json::from_value(result.clone())?;
                ensure!(
                    !result.thread.id.is_empty(),
                    "RUNTIME_NATIVE_IDENTITY_MISMATCH"
                );
                let mut binding = binding;
                ensure!(
                    binding
                        .thread_id
                        .as_ref()
                        .is_none_or(|id| id == &result.thread.id),
                    "RUNTIME_NATIVE_IDENTITY_MISMATCH"
                );
                binding.thread_id = Some(result.thread.id);
                binding.phase = RuntimePhase::ConfigureQueued;
                self.save_and_enqueue(binding)
            }
            RuntimePhase::TurnDispatched => {
                let result: kcoder_app_protocol::TurnStartResult =
                    serde_json::from_value(result.clone())?;
                ensure!(
                    result.turn.thread_id == required_thread(&binding)?,
                    "RUNTIME_NATIVE_IDENTITY_MISMATCH"
                );
                let accepted = IntegrationRuntimeAcceptance {
                    thread_id: result.turn.thread_id.clone(),
                    turn_id: Some(result.turn.id.clone()),
                    task_id: None,
                    state: IntegrationTaskState::Running,
                };
                let mut binding = self.storage.accept(binding, accepted)?;
                self.track(&binding)?;
                if result.turn.status != kcoder_app_protocol::TurnStatus::Running {
                    binding.task_state = super::observations::turn_state(&result.turn.status);
                    self.settle(binding)?;
                }
                Ok(())
            }
            RuntimePhase::RecoverThreadDispatched => self.observe_thread_receipt(binding, result),
            RuntimePhase::RecoverTurnDispatched => self.observe_turn_receipt(binding, result),
            RuntimePhase::CancelDispatched => {
                let _: kcoder_app_protocol::TurnInterruptResult =
                    serde_json::from_value(result.clone())?;
                // An interrupt acknowledgement is not a terminal outcome.
                let mut binding = binding;
                binding.recovery_from = Some(RuntimePhase::CancelDispatched);
                binding.phase = RuntimePhase::RecoverTurnQueued;
                self.save_and_enqueue(binding)
            }
            _ => anyhow::bail!("RUNTIME_RESPONSE_KIND_MISMATCH"),
        }
    }
    /// Called for a lost transport response. It records uncertainty and never
    /// retries the generated write. Explicit reconciliation uses native receipts.
    pub fn abandon_command(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
    ) -> Result<()> {
        self.check(context)?;
        let binding = self.take_pending(ticket)?;
        self.busy.remove(&ticket.operation);
        if ticket.phase == RuntimePhase::TurnDispatched && binding.acceptance.is_some() {
            return self.track(&binding);
        }
        self.storage
            .unknown(binding, "RUNTIME_NATIVE_RESPONSE_LOST")
    }
    /// Root refused a generated turn/start before routing it, so no turn ran.
    /// The operation is rejected visibly instead of being left unknown.
    pub fn reject_generated_turn(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        code: &'static str,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            ticket.phase == RuntimePhase::TurnDispatched,
            "RUNTIME_RESPONSE_KIND_MISMATCH"
        );
        let binding = self.take_pending(ticket)?;
        ensure!(
            binding.acceptance.is_none(),
            "RUNTIME_DISPATCH_STATE_UNCONFIRMED"
        );
        self.reject_before_dispatch(binding, code)
    }
    /// Root found the resident turn running while preparing a generated
    /// `turn/start`, before routing it or changing the resident. Nothing ran,
    /// so the same operation waits under the bounded busy retry.
    pub fn defer_generated_busy_turn(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            ticket.phase == RuntimePhase::TurnDispatched,
            "RUNTIME_RESPONSE_KIND_MISMATCH"
        );
        let binding = self.take_pending(ticket)?;
        ensure!(
            binding.acceptance.is_none(),
            "RUNTIME_DISPATCH_STATE_UNCONFIRMED"
        );
        let previous = self.busy.remove(&ticket.operation);
        self.defer_busy_turn(binding, previous, std::time::Instant::now())
    }
    pub fn take_pending(&mut self, ticket: &NativeRuntimeTicket) -> Result<RuntimeBinding> {
        ensure!(
            self.pending.get(&ticket.id) == Some(ticket),
            "RUNTIME_TICKET_MISMATCH"
        );
        let binding = self
            .storage
            .bindings
            .get(&ticket.operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.phase == ticket.phase
                || ticket.phase == RuntimePhase::TurnDispatched && binding.acceptance.is_some(),
            "RUNTIME_PHASE_CONFLICT"
        );
        self.pending.remove(&ticket.id);
        Ok(binding)
    }
    pub fn save_and_enqueue(&mut self, binding: RuntimeBinding) -> Result<()> {
        ensure!(self.queue.len() < MAX_QUEUED, "RUNTIME_QUEUE_CAPACITY");
        let operation = binding.operation_id.clone();
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        self.queue.push_back(operation);
        Ok(())
    }
    /// Persist a rejection after the caller has verified that the task did not start.
    pub fn reject_before_dispatch(
        &mut self,
        binding: RuntimeBinding,
        code: &'static str,
    ) -> Result<()> {
        self.reject_before_dispatch_with(binding, code, IntegrationRecovery::RequestAuthorization)
    }

    fn reject_before_dispatch_with(
        &mut self,
        mut binding: RuntimeBinding,
        code: &'static str,
        recovery: IntegrationRecovery,
    ) -> Result<()> {
        self.busy.remove(&binding.operation_id);
        binding.phase = RuntimePhase::Rejected;
        binding.task_state = IntegrationTaskState::Failed;
        binding.error = Some(safe_error(code, recovery));
        let operation = binding.operation_id.clone();
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        self.storage.transition(
            &operation,
            IntegrationOperationPhase::Rejected,
            None,
            Some(safe_error(code, recovery)),
        )?;
        Ok(())
    }

    /// The app server refused this generated `turn/start` before registering a
    /// turn, so nothing executed. Requeue the same persisted binding after a
    /// bounded backoff; once the bound is exhausted the operation is durably
    /// rejected as busy instead of being reported as an unknown outcome.
    fn defer_busy_turn(
        &mut self,
        mut binding: RuntimeBinding,
        previous: Option<BusyRetry>,
        now: std::time::Instant,
    ) -> Result<()> {
        let mut retry = previous.unwrap_or(BusyRetry {
            first_refused: now,
            attempts: 0,
            due: None,
        });
        retry.attempts = retry.attempts.saturating_add(1);
        if retry.attempts > TURN_BUSY_RETRY_ATTEMPTS
            || now.saturating_duration_since(retry.first_refused) >= TURN_BUSY_RETRY_WINDOW
        {
            return self.reject_before_dispatch_with(
                binding,
                "RUNTIME_THREAD_BUSY",
                IntegrationRecovery::None,
            );
        }
        let exponent = retry.attempts.saturating_sub(1).min(5);
        let backoff = std::time::Duration::from_millis(50u64 << exponent)
            .min(std::time::Duration::from_secs(1));
        retry.due = Some(now + backoff);
        binding.phase = RuntimePhase::TurnQueued;
        let operation = binding.operation_id.clone();
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        self.busy.insert(operation, retry);
        Ok(())
    }

    #[cfg(any(test, feature = "test-oracle"))]
    pub fn test_expire_busy_window(&mut self, operation: &str) {
        if let Some(retry) = self.busy.get_mut(operation)
            && let Some(first) = retry.first_refused.checked_sub(TURN_BUSY_RETRY_WINDOW)
        {
            retry.first_refused = first;
        }
    }
}
/// Only the exact pre-registration refusal qualifies. Every other error keeps
/// the conservative unknown outcome because admission may have had effects.
fn is_busy_before_registration(response: &Value) -> bool {
    response.get("result").is_none()
        && response.get("error").is_some_and(|error| {
            error.get("code").and_then(Value::as_i64) == Some(TURN_BUSY_BEFORE_REGISTRATION_CODE)
                && error.get("message").and_then(Value::as_str)
                    == Some(TURN_BUSY_BEFORE_REGISTRATION_MESSAGE)
        })
}
pub fn required_thread(binding: &RuntimeBinding) -> Result<String> {
    binding
        .thread_id
        .clone()
        .filter(|id| !id.is_empty())
        .context("RUNTIME_NATIVE_THREAD_UNCONFIRMED")
}
