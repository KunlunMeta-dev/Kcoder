//! One original State journal, one bounded model call, canonical task settlement.
use super::*;
use kcoder_engine::{context::TokenCounter, native_model_requests::*};
use kcoder_state::integrations::core::budgets::*;
use kcoder_types::{MessagesRequest, Usage};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
mod configuration;
pub(super) use configuration::TaskBudgetConfiguration;

pub(super) struct ApplicationBudget {
    shared: Arc<Execution>,
    service: Arc<NativeBudgetService>,
    slot: String,
    policy: NativeBudgetPolicy,
    deadline: Instant,
    configuration: Arc<TaskBudgetConfiguration>,
    tool_task: bool,
}
impl ApplicationBudget {
    pub(super) fn new(shared: Arc<Execution>, service: Arc<NativeBudgetService>) -> Result<Self> {
        shared.native()?;
        let configuration = shared.budget_configuration.clone();
        let operation = operation(&shared)?;
        let tool_task = shared.source.business_tools().is_some();
        let policy = NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
            id: "native-application-text-task".to_owned(),
            version: 2,
            revision: configuration.revision(&shared)?,
            scope: BudgetScope::Task(operation.clone()),
            window: BudgetWindow {
                id: operation.clone(),
                starts_at_ms: 0,
                ends_at_ms: u64::MAX,
            },
            limits: configuration.limits(tool_task),
            currency: None,
        })?;
        let kind = "application";
        let duration = configuration.limits(tool_task).run_millis.unwrap();
        let result = Self {
            shared,
            service,
            slot: format!("{kind}-slot-{}", hash(&operation)?),
            policy,
            deadline: Instant::now() + Duration::from_millis(duration),
            configuration,
            tool_task,
        };
        let policies = result.policies()?;
        result.configuration.verify()?;
        let request = NativeBudgetRequest {
            reservation_id: result.slot.clone(),
            operation_id: format!("{kind}-slot-op-{}", hash(&operation)?),
            principal: result.principal()?,
            unit: BudgetUnit::TaskSlot,
            task: BudgetTaskLink {
                root_operation_id: operation,
                root_task: None,
                actor: BudgetActor::Main,
                actor_attempt_id: format!("native-{kind}-main"),
                parent_reservation_id: None,
            },
            estimate: BudgetCharge::zero(),
        };
        ensure!(
            matches!(
                result
                    .service
                    .accounting_store()
                    .reserve(&request, &policies, now()?)?,
                BudgetReservationResult::Created(_)
            ),
            "APPLICATION_ORIGINAL_BUDGET_UNCONFIRMED"
        );
        Ok(result)
    }
    fn principal(&self) -> Result<NativeBudgetPrincipal> {
        let s = &self.shared.request.scope;
        NativeBudgetPrincipal::from_native_facts(
            s.account_id.clone(),
            None,
            s.workspace_id.as_ref().cloned(),
            None,
        )
    }
    fn policies(&self) -> Result<Vec<NativeBudgetPolicy>> {
        let ledger = self.service.accounting_store();
        let mut policies = ledger.current_applicable_policies(
            &self.principal()?,
            &operation(&self.shared)?,
            now()?,
        )?;
        let mut found = false;
        for policy in &policies {
            let view = ledger
                .observe_policy(policy)?
                .context("APPLICATION_BUDGET_POLICY_MISSING")?;
            if view.policy.id == "native-application-text-task"
                && view.policy.scope == BudgetScope::Task(operation(&self.shared)?)
            {
                found = true;
            }
        }
        if !found {
            policies.push(self.policy.clone());
        }
        Ok(policies)
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.configuration.verify()?;
        self.service.verify(&self.shared.context)?;
        ensure!(
            Instant::now() < self.deadline,
            "APPLICATION_RUNTIME_DEADLINE"
        );
        let receipt = self
            .service
            .accounting_store()
            .read_reservation(&self.slot)?
            .context("APPLICATION_BUDGET_SLOT_MISSING")?;
        ensure!(
            !receipt.execution_confirmed_terminal
                && receipt.task.root_operation_id == operation(&self.shared)?,
            "APPLICATION_BUDGET_SLOT_TERMINAL"
        );
        Ok(())
    }
    fn facts(&self) -> Result<(IntegrationOperationReceipt, IntegrationEntityRef)> {
        let driver = NativeRuntimeDriver::load(&self.shared.context)?
            .context("APPLICATION_ORIGINAL_RUNTIME_UNCONFIRMED")?;
        let receipt = driver
            .read_operation(&self.shared.context, &operation(&self.shared)?)?
            .context("APPLICATION_ORIGINAL_RUNTIME_UNCONFIRMED")?;
        let accepted = receipt
            .runtime_acceptance
            .as_ref()
            .context("APPLICATION_ORIGINAL_RUNTIME_UNCONFIRMED")?;
        let state = self
            .shared
            .state
            .get()
            .context("APPLICATION_NATIVE_STATE_REQUIRED")?;
        ensure!(
            accepted.thread_id == state.session_id() && accepted.task_id.is_none(),
            "APPLICATION_NATIVE_TASK_CHANGED"
        );
        let task = IntegrationEntityRef {
            kind: IntegrationEntityKind::Turn,
            id: accepted
                .turn_id
                .clone()
                .context("APPLICATION_NATIVE_TASK_CHANGED")?,
            revision: None,
        };
        Ok((receipt, task))
    }
    pub(super) fn observe_task(&self, task: &IntegrationRuntimeTask) -> Result<()> {
        let kind = match task.state {
            IntegrationTaskState::Completed => BudgetTerminalKind::Completed,
            IntegrationTaskState::Failed => BudgetTerminalKind::Failed,
            IntegrationTaskState::Cancelled => BudgetTerminalKind::Cancelled,
            _ => return Ok(()),
        };
        let (original, reference) = self.facts()?;
        let accepted = original.runtime_acceptance.as_ref().unwrap();
        ensure!(
            task.thread_id == accepted.thread_id
                && task.turn_id == accepted.turn_id
                && task.task_id == accepted.task_id,
            "APPLICATION_NATIVE_TASK_CHANGED"
        );
        let ledger = self.service.accounting_store();
        let slot = ledger
            .read_reservation(&self.slot)?
            .context("APPLICATION_BUDGET_SLOT_MISSING")?;
        if slot.execution_confirmed_terminal {
            return Ok(());
        }
        let binding = NativeBudgetTaskBinding::from_authoritative_receipt(
            operation(&self.shared)?,
            reference.clone(),
            original.operation_id.clone(),
            hash(&accepted)?,
        )?;
        let slot = ledger.bind_task(&self.slot, slot.revision, &binding, now()?)?;
        let terminal = NativeBudgetTerminal::from_authoritative_receipt(
            slot.operation_id.clone(),
            Some(reference),
            slot.task.actor_attempt_id.clone(),
            format!("native-task-terminal-{}", original.operation_id),
            hash(&(accepted, task.state))?,
            kind,
        )?;
        ledger.record_usage(
            &self.slot,
            slot.revision,
            "native-application-task-terminal",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Complete,
                known: BudgetCharge::zero(),
            },
            Some(&terminal),
            now()?,
        )?;
        Ok(())
    }
    fn reserve_actual(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease>> {
        self.verify()?;
        self.shared.actor(context.execution())?;
        let configuration = context
            .configuration()
            .context("APPLICATION_MODEL_CONFIGURATION_REQUIRED")?;
        let expected = &self.shared.task.configuration.model.model;
        ensure!(
            configuration.provider_id == expected.provider_id
                && configuration.model_id == expected.model_id
                && configuration.revision == expected.revision
                && configuration.api_format == expected.api_format
                && configuration.chat_protocol == expected.chat_protocol
                && request.model == expected.model_id,
            "APPLICATION_NATIVE_MODEL_CHANGED"
        );
        let mut output = request.max_tokens;
        for field in &configuration.request_override_fields {
            if ["max_tokens", "max_output_tokens", "max_completion_tokens"]
                .contains(&field.as_str())
            {
                output = output.max(
                    configuration
                        .request_output_limits
                        .get(field)
                        .copied()
                        .flatten()
                        .context("APPLICATION_MODEL_OUTPUT_UNCONFIRMED")?,
                );
            }
        }
        ensure!(
            output > 0
                && output <= 1024
                && configuration
                    .max_output_tokens
                    .is_some_and(|limit| output <= limit),
            "APPLICATION_MODEL_OUTPUT_UNCONFIRMED"
        );
        // The original ledger below reserves the complete input/output estimate
        // against target-owned limits before any Provider call. Model capacity
        // does not raise that budget or authorize an extra attempt.
        let (original, task) = self.facts()?;
        ensure!(
            Some(task.id.as_str())
                == context
                    .execution()
                    .attempt()
                    .map(|attempt| attempt.turn_id.as_str()),
            "APPLICATION_NATIVE_ACTOR_CHANGED"
        );
        let ledger = self.service.accounting_store();
        let policies = self.policies()?;
        let slot = ledger
            .read_reservation(&self.slot)?
            .context("APPLICATION_BUDGET_SLOT_MISSING")?;
        let binding = NativeBudgetTaskBinding::from_authoritative_receipt(
            operation(&self.shared)?,
            task.clone(),
            original.operation_id.clone(),
            hash(&original.runtime_acceptance)?,
        )?;
        let slot = ledger.bind_task(&self.slot, slot.revision, &binding, now()?)?;
        ensure!(
            !matches!(
                ledger.mark_dispatched(&self.slot, slot.revision, &policies, now()?)?,
                BudgetDispatchResult::Terminal(_)
            ),
            "APPLICATION_BUDGET_SLOT_TERMINAL"
        );
        let estimate = u64::try_from(TokenCounter::count_request(request, true).tokens)?;
        let id = format!(
            "application-call-{}",
            hash(&(operation(&self.shared)?, context.call_id()))?
        );
        let call = NativeBudgetRequest {
            reservation_id: id.clone(),
            operation_id: id,
            principal: self.principal()?,
            unit: BudgetUnit::ModelCall,
            task: BudgetTaskLink {
                root_operation_id: operation(&self.shared)?,
                root_task: Some(task.clone()),
                actor: BudgetActor::Main,
                actor_attempt_id: context.execution().attempt().unwrap().attempt_id.clone(),
                parent_reservation_id: Some(self.slot.clone()),
            },
            estimate: BudgetCharge {
                tokens: estimate + estimate / 2 + 128 + u64::from(output),
                model_calls: 1,
                run_millis: 30_000,
                cost_micros: None,
            },
        };
        let BudgetReservationResult::Created(receipt) = ledger.reserve(&call, &policies, now()?)?
        else {
            anyhow::bail!("APPLICATION_MODEL_CALL_ALREADY_OBSERVED")
        };
        let BudgetDispatchResult::Fresh(receipt) =
            ledger.mark_dispatched(&receipt.reservation_id, receipt.revision, &policies, now()?)?
        else {
            anyhow::bail!("APPLICATION_MODEL_CALL_ALREADY_OBSERVED")
        };
        Ok(Box::new(ApplicationLease {
            shared: self.shared.clone(),
            ledger,
            receipt,
            task,
            deadline: model_call_deadline(self.deadline, self.tool_task, Instant::now()),
            started: Instant::now(),
            usage: None,
            updates: 0,
            output,
            configuration: self.configuration.clone(),
        }))
    }
}
impl NativeModelRequestObserver for ApplicationBudget {
    fn reserve(
        &self,
        context: &NativeModelRequestContext,
        request: &MessagesRequest,
    ) -> std::result::Result<Box<dyn NativeModelRequestLease>, NativeModelRequestError> {
        self.reserve_actual(context, request).map_err(classify)
    }
}
struct ApplicationLease {
    shared: Arc<Execution>,
    ledger: Arc<NativeBudgetStore>,
    receipt: BudgetReservationReceipt,
    task: IntegrationEntityRef,
    deadline: Instant,
    started: Instant,
    usage: Option<Usage>,
    updates: u64,
    output: u32,
    configuration: Arc<TaskBudgetConfiguration>,
}
impl ApplicationLease {
    fn charge(&self, dispatched: bool) -> BudgetCharge {
        let tokens = self
            .usage
            .as_ref()
            .map(|u| {
                u.total_tokens.unwrap_or_else(|| {
                    u.input_tokens
                        .saturating_add(u.output_tokens)
                        .saturating_add(u.cache_creation_input_tokens.unwrap_or(0))
                        .saturating_add(u.cache_read_input_tokens.unwrap_or(0))
                })
            })
            .unwrap_or(0);
        BudgetCharge {
            tokens: u64::from(tokens),
            model_calls: u64::from(dispatched),
            run_millis: self.started.elapsed().as_millis() as u64,
            cost_micros: None,
        }
    }
    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        charge: BudgetCharge,
        terminal: Option<BudgetTerminalKind>,
    ) -> Result<()> {
        let terminal = terminal
            .map(|kind| {
                NativeBudgetTerminal::from_authoritative_receipt(
                    self.receipt.operation_id.clone(),
                    Some(self.task.clone()),
                    self.receipt.task.actor_attempt_id.clone(),
                    format!("native-model-{}", self.receipt.reservation_id),
                    hash(&(&self.receipt.reservation_id, kind, coverage, &charge))?,
                    kind,
                )
            })
            .transpose()?;
        let update = hash(&(coverage, &charge, self.updates))?;
        self.receipt = self.ledger.record_usage(
            &self.receipt.reservation_id,
            self.receipt.revision,
            &update,
            &NativeBudgetUsage {
                coverage,
                known: charge,
            },
            terminal.as_ref(),
            now()?,
        )?;
        Ok(())
    }
}
impl NativeModelRequestLease for ApplicationLease {
    fn record_usage(&mut self, usage: &Usage) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            if let Some(total) = self.usage.as_mut() {
                total.merge_stream_update(usage)
            } else {
                self.usage = Some(usage.clone())
            }
            ensure!(
                self.updates < 62 && self.usage.as_ref().unwrap().output_tokens <= self.output,
                "APPLICATION_MODEL_USAGE_LIMIT"
            );
            self.write(BudgetUsageCoverage::Partial, self.charge(true), None)?;
            self.updates += 1;
            self.check_current()
                .map_err(|_| anyhow::anyhow!("APPLICATION_CURRENT_BUDGET_UNAVAILABLE"))
        })()
        .map_err(classify)
    }
    fn check_current(&self) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            self.configuration.verify()?;
            ensure!(
                Instant::now() < self.deadline,
                "APPLICATION_RUNTIME_DEADLINE"
            );
            self.shared.native()?;
            let principal = NativeBudgetPrincipal::from_native_facts(
                self.shared.request.scope.account_id.clone(),
                None,
                self.shared.request.scope.workspace_id.as_ref().cloned(),
                None,
            )?;
            let policies = self.ledger.current_applicable_policies(
                &principal,
                &operation(&self.shared)?,
                now()?,
            )?;
            ensure!(
                policies.len() == self.receipt.policy_refs.len(),
                "APPLICATION_CURRENT_BUDGET_CHANGED"
            );
            for policy in policies {
                let view = self
                    .ledger
                    .observe_policy(&policy)?
                    .context("APPLICATION_CURRENT_BUDGET_UNAVAILABLE")?;
                ensure!(
                    self.receipt.policy_refs.contains(&view.policy)
                        && view.limits.tokens.is_none_or(|n| view.charged.tokens <= n)
                        && view
                            .limits
                            .model_calls
                            .is_none_or(|n| view.charged.model_calls <= n)
                        && view
                            .limits
                            .run_millis
                            .is_none_or(|n| view.charged.run_millis <= n)
                        && view
                            .limits
                            .cost_micros
                            .is_none_or(|n| view.charged.cost_micros.is_some_and(|v| v <= n))
                        && view
                            .limits
                            .concurrent_calls
                            .is_none_or(|n| view.active_calls <= n)
                        && view
                            .limits
                            .concurrent_tasks
                            .is_none_or(|n| view.active_tasks <= n),
                    "APPLICATION_CURRENT_BUDGET_CHANGED"
                );
            }
            Ok(())
        })()
        .map_err(classify)
    }
    fn deadline(&self) -> Option<Instant> {
        Some(self.deadline)
    }
    fn finish(
        mut self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            if let Some(usage) = settlement.usage {
                if let Some(total) = self.usage.as_mut() {
                    total.merge_stream_update(&usage)
                } else {
                    self.usage = Some(usage)
                }
            }
            if !settlement.request_dispatched {
                return self.write(
                    BudgetUsageCoverage::Complete,
                    BudgetCharge::zero(),
                    Some(BudgetTerminalKind::VerifiedNotStarted),
                );
            }
            let stopped = settlement.end == NativeModelRequestEnd::MessageStop;
            let coverage = if stopped
                && settlement.usage_from_delta
                && self
                    .usage
                    .as_ref()
                    .is_some_and(|u| u.total_tokens.is_some() || u.input_tokens > 0)
            {
                BudgetUsageCoverage::Complete
            } else if self.usage.is_some() {
                BudgetUsageCoverage::Partial
            } else {
                BudgetUsageCoverage::Unreported
            };
            self.write(
                coverage,
                self.charge(true),
                stopped.then_some(BudgetTerminalKind::Completed),
            )
        })()
        .map_err(classify)
    }
}
fn operation(shared: &Execution) -> Result<String> {
    shared
        .request
        .operation_id
        .clone()
        .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")
}
fn model_call_deadline(task_deadline: Instant, tool_task: bool, started: Instant) -> Instant {
    if tool_task {
        task_deadline
    } else {
        task_deadline.min(started + Duration::from_secs(30))
    }
}

fn now() -> Result<u64> {
    Ok(chrono::Utc::now().timestamp_millis().try_into()?)
}
fn hash(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn classify(error: anyhow::Error) -> NativeModelRequestError {
    eprintln!(
        "{}",
        serde_json::json!({"event":"native_application_model_observer_unconfirmed",
            "stage":"original_model_observer",
            "closedCodes":crate::app_server::integrations::connectivity::task_capability_scope_runtime::safe_source_error(&error),
            "reasonSha256":error.chain().take(5).map(|cause|format!("{:x}",Sha256::digest(cause.to_string()))).collect::<Vec<_>>()})
    );
    if error.to_string() == "APPLICATION_RUNTIME_DEADLINE" {
        NativeModelRequestError::Deadline
    } else {
        NativeModelRequestError::Unavailable
    }
}

#[cfg(test)]
mod deadline_tests {
    use super::*;

    #[test]
    fn initialization_does_not_consume_the_entire_text_model_call_window() {
        let admitted = Instant::now();
        let task_deadline = admitted + Duration::from_secs(240);
        let call_started = admitted + Duration::from_secs(45);
        assert_eq!(
            model_call_deadline(task_deadline, false, call_started),
            admitted + Duration::from_secs(75)
        );
        assert_eq!(
            model_call_deadline(task_deadline, false, task_deadline - Duration::from_secs(5)),
            task_deadline
        );
        assert_eq!(
            model_call_deadline(task_deadline, false, task_deadline + Duration::from_secs(1)),
            task_deadline
        );
        assert_eq!(
            model_call_deadline(task_deadline, true, call_started),
            task_deadline
        );
    }
}
