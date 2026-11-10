//! Metering against the original source and receiver budgets for one Provider call.

use anyhow::{Context, Result, ensure};
use kcoder_engine::{context::TokenCounter, native_model_requests::*};
use kcoder_native_receipts::digest;
use kcoder_state::integrations::core::budgets::*;
use kcoder_types::{MessagesRequest, ModelConfigurationSummary, Usage};
use std::{
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub struct ReceiverLedger {
    pub store: Arc<NativeBudgetStore>,
    pub receipt: BudgetReservationReceipt,
    pub policies: Vec<NativeBudgetPolicy>,
    pub principal: NativeBudgetPrincipal,
    pub root_operation: String,
}

impl ReceiverLedger {
    fn mark_dispatched(&mut self) -> Result<()> {
        let BudgetDispatchResult::Fresh(receipt) = self.store.mark_dispatched(
            &self.receipt.reservation_id,
            self.receipt.revision,
            &self.policies,
            now()?,
        )?
        else {
            anyhow::bail!("REMOTE_RECEIVER_ORIGINAL_MODEL_CALL_ALREADY_OBSERVED")
        };
        self.receipt = receipt;
        Ok(())
    }
}

pub struct ReceiverModelLease {
    source: ReceiverLedger,
    receiver: ReceiverLedger,
    deadline: Instant,
    verify_owner: Box<dyn Fn() -> Result<()> + Send + Sync>,
    started: Instant,
    usage: Option<Usage>,
    updates: u64,
}

impl ReceiverModelLease {
    pub fn dispatch(
        source: ReceiverLedger,
        receiver: ReceiverLedger,
        deadline: Instant,
        verify_owner: impl Fn() -> Result<()> + Send + Sync + 'static,
    ) -> Result<Self> {
        let mut lease = Self {
            source,
            receiver,
            deadline,
            verify_owner: Box::new(verify_owner),
            started: Instant::now(),
            usage: None,
            updates: 0,
        };
        let dispatched = (|| -> Result<()> {
            (lease.verify_owner)()?;
            lease.source.mark_dispatched()?;
            lease.receiver.mark_dispatched()?;
            (lease.verify_owner)()
        })();
        if let Err(error) = dispatched {
            // The lease has not been returned, so the actual Provider cannot have run.
            let a = settle_not_started(
                &lease.source.store,
                &lease.source.receipt,
                "native-admission-before-inner-provider",
            );
            let b = settle_not_started(
                &lease.receiver.store,
                &lease.receiver.receipt,
                "native-admission-before-inner-provider",
            );
            a?;
            b?;
            return Err(error);
        }
        Ok(lease)
    }

    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        known: BudgetCharge,
        terminal: Option<BudgetTerminalKind>,
        tag: &str,
    ) -> Result<()> {
        let update = format!("remote-native-{tag}-{}", self.updates);
        self.updates += 1;
        let mut outcomes = Vec::new();
        let operation = self.receiver.root_operation.clone();
        for side in [&mut self.source, &mut self.receiver] {
            let receipt = &mut side.receipt;
            let terminal = terminal
                .map(|kind| {
                    NativeBudgetTerminal::from_authoritative_receipt(
                        receipt.operation_id.clone(),
                        receipt.task.root_task.clone(),
                        receipt.task.actor_attempt_id.clone(),
                        format!("native-model-{}", receipt.reservation_id),
                        digest(&(&receipt.reservation_id, tag, &operation))?,
                        kind,
                    )
                })
                .transpose()?;
            let result = side.store.record_usage(
                &receipt.reservation_id,
                receipt.revision,
                &update,
                &NativeBudgetUsage {
                    coverage,
                    known: known.clone(),
                },
                terminal.as_ref(),
                now()?,
            );
            outcomes.push(match result {
                Ok(next) => {
                    *receipt = next;
                    Ok(())
                }
                Err(error) => Err(error),
            });
        }
        for result in outcomes {
            result?
        }
        Ok(())
    }
    fn charge(&self, dispatched: bool) -> Result<BudgetCharge> {
        Ok(BudgetCharge {
            tokens: self
                .usage
                .as_ref()
                .map(|usage| {
                    u64::from(usage.total_tokens.unwrap_or_else(|| {
                        usage
                            .input_tokens
                            .saturating_add(usage.output_tokens)
                            .saturating_add(usage.cache_creation_input_tokens.unwrap_or(0))
                            .saturating_add(usage.cache_read_input_tokens.unwrap_or(0))
                    }))
                })
                .unwrap_or(0),
            model_calls: u64::from(dispatched),
            run_millis: u64::try_from(self.started.elapsed().as_millis())?,
            cost_micros: None,
        })
    }
}
impl NativeModelRequestLease for ReceiverModelLease {
    fn record_usage(&mut self, usage: &Usage) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            ensure!(self.updates < 60, "REMOTE_RECEIVER_USAGE_UPDATE_CAPACITY");
            if let Some(actual) = &mut self.usage {
                actual.merge_stream_update(usage)
            } else {
                self.usage = Some(usage.clone())
            }
            self.write(
                BudgetUsageCoverage::Partial,
                self.charge(true)?,
                None,
                "usage",
            )?;
            Ok(())
        })()
        .map_err(classify)
    }
    fn check_current(&self) -> std::result::Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            (self.verify_owner)()?;
            for side in [&self.source, &self.receiver] {
                for policy in &side.policies {
                    let observed = side
                        .store
                        .observe_policy(policy)?
                        .context("REMOTE_BUDGET_POLICY_MISSING")?;
                    ensure!(
                        side.receipt.policy_refs.contains(&observed.policy),
                        "REMOTE_BUDGET_POLICY_CHANGED"
                    );
                    ensure!(
                        observed
                            .limits
                            .tokens
                            .is_none_or(|limit| observed.charged.tokens <= limit)
                            && observed
                                .limits
                                .model_calls
                                .is_none_or(|limit| observed.charged.model_calls <= limit),
                        "BUDGET_EXHAUSTED"
                    );
                }
            }
            for side in [&self.source, &self.receiver] {
                current_policy_set(
                    &side.store,
                    &side.principal,
                    &side.root_operation,
                    &side.receipt,
                )?;
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
                if let Some(actual) = &mut self.usage {
                    actual.merge_stream_update(&usage)
                } else {
                    self.usage = Some(usage)
                }
            }
            if !settlement.request_dispatched {
                return self.write(
                    BudgetUsageCoverage::Complete,
                    BudgetCharge::zero(),
                    Some(BudgetTerminalKind::VerifiedNotStarted),
                    "not-started",
                );
            }
            let stopped = settlement.end == NativeModelRequestEnd::MessageStop;
            let complete = stopped
                && settlement.usage_from_delta
                && self.usage.as_ref().is_some_and(|usage| {
                    usage.total_tokens.is_some()
                        || usage.input_tokens > 0
                        || usage.cache_read_input_tokens.unwrap_or(0) > 0
                        || usage.cache_creation_input_tokens.unwrap_or(0) > 0
                });
            let coverage = if complete {
                BudgetUsageCoverage::Complete
            } else if self.usage.is_some() {
                BudgetUsageCoverage::Partial
            } else {
                BudgetUsageCoverage::Unreported
            };
            self.write(
                coverage,
                self.charge(true)?,
                stopped.then_some(BudgetTerminalKind::Completed),
                "finish",
            )
        })()
        .map_err(classify)
    }
}
pub fn settle_not_started(
    ledger: &NativeBudgetStore,
    receipt: &BudgetReservationReceipt,
    proof: &str,
) -> Result<()> {
    let terminal = NativeBudgetTerminal::from_authoritative_receipt(
        receipt.operation_id.clone(),
        receipt.task.root_task.clone(),
        receipt.task.actor_attempt_id.clone(),
        format!("native-not-started-{}", receipt.reservation_id),
        digest(&(proof, &receipt.reservation_id))?,
        BudgetTerminalKind::VerifiedNotStarted,
    )?;
    ledger.record_usage(
        &receipt.reservation_id,
        receipt.revision,
        "native-inner-provider-not-called",
        &NativeBudgetUsage {
            coverage: BudgetUsageCoverage::Complete,
            known: BudgetCharge::zero(),
        },
        Some(&terminal),
        now()?,
    )?;
    Ok(())
}
pub fn current_policy_set(
    ledger: &NativeBudgetStore,
    principal: &NativeBudgetPrincipal,
    root: &str,
    receipt: &BudgetReservationReceipt,
) -> Result<()> {
    let mut current = ledger
        .current_applicable_policies(principal, root, now()?)?
        .iter()
        .map(|policy| -> Result<String> {
            Ok(serde_json::to_string(
                &ledger
                    .observe_policy(policy)?
                    .context("REMOTE_BUDGET_POLICY_MISSING")?
                    .policy,
            )?)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut original = receipt
        .policy_refs
        .iter()
        .map(serde_json::to_string)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    current.sort();
    original.sort();
    ensure!(current == original, "REMOTE_BUDGET_POLICY_CHANGED");
    Ok(())
}
pub fn bound(configuration: &ModelConfigurationSummary, request: &MessagesRequest) -> Result<u64> {
    ensure!(
        request.model == configuration.model_id && request.max_tokens > 0,
        "REMOTE_NATIVE_OUTPUT_BOUND_REQUIRED"
    );
    let mut output = request.max_tokens;
    for field in &configuration.request_override_fields {
        if ["max_tokens", "max_completion_tokens", "max_output_tokens"].contains(&field.as_str()) {
            output = output.max(
                configuration
                    .request_output_limits
                    .get(field)
                    .copied()
                    .flatten()
                    .filter(|value| *value > 0)
                    .context("REMOTE_NATIVE_OUTPUT_BOUND_REQUIRED")?,
            );
        }
    }
    ensure!(
        configuration
            .max_output_tokens
            .is_some_and(|maximum| output <= maximum),
        "REMOTE_NATIVE_OUTPUT_BOUND_REQUIRED"
    );
    let input = u64::try_from(TokenCounter::count_request(request, true).tokens)?;
    let mut total = input
        .checked_add(input / 2)
        .and_then(|input| input.checked_add(128))
        .and_then(|input| input.checked_add(u64::from(output)))
        .context("REMOTE_NATIVE_BUDGET_OVERFLOW")?;
    if let Some(schema) = &request.response_json_schema {
        total = total
            .checked_add(u64::try_from(
                serde_json::to_vec(&(
                    &schema.name,
                    &schema.description,
                    &schema.schema,
                    schema.strict,
                ))?
                .len(),
            )?)
            .and_then(|total| total.checked_add(128))
            .context("REMOTE_NATIVE_BUDGET_OVERFLOW")?;
    }
    if let Some(reasoning) = &request.reasoning_effort {
        total = total
            .checked_add(u64::try_from(serde_json::to_vec(reasoning)?.len())?)
            .and_then(|total| total.checked_add(64))
            .context("REMOTE_NATIVE_BUDGET_OVERFLOW")?;
    }
    if request.recovery_disable_reasoning {
        total = total
            .checked_add(64)
            .context("REMOTE_NATIVE_BUDGET_OVERFLOW")?;
    }
    Ok(total)
}
pub fn classify(error: anyhow::Error) -> NativeModelRequestError {
    match error.to_string().as_str() {
        "REMOTE_NATIVE_DEADLINE_EXPIRED" => NativeModelRequestError::Deadline,
        "BUDGET_EXHAUSTED" => NativeModelRequestError::Denied,
        _ => NativeModelRequestError::Unavailable,
    }
}

fn now() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
