//! Debit the actual source task's original Native ledger/TaskSlot; never invent a root operation or credit.
use super::super::{
    NativeIntegrationContext, NativeOperations, budget_host::NativeBudgetService,
    runtime_driver::NativeRuntimeDriver,
};
use super::authority::{validate_caller, validate_captured_caller};
use anyhow::{Context, Result, ensure};
use kcoder_engine::QueryEngine;
use kcoder_state::{
    AppStateLifecycleIdentity, integrations::core::budgets::*,
    turn_attempt_store::TurnAttemptRecord,
};
use kcoder_tools::ToolContext;
use kcoder_types::{TurnAttemptIdentity, integrations::core::*};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

pub struct NativeRemoteSourceBudget {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    state: AppStateLifecycleIdentity,
    caller: ToolContext,
    accepted: TurnAttemptRecord,
    root_operation: String,
    acceptance: Option<IntegrationRuntimeAcceptance>,
    ordinary_policy_sha256: Option<String>,
    principal: NativeBudgetPrincipal,
    service: NativeBudgetService,
    parent: NativeBudgetTaskParent,
    goal: OnceLock<Option<Arc<SourceGoalBudget>>>,
}
struct SourceGoalBudget {
    id: String,
    generation: u64,
    binding: kcoder_state::NativeGoalTaskBudgetBinding,
}
impl NativeRemoteSourceBudget {
    /// Retain original ownership for observations/cleanup without reserving
    /// capacity, reopening a task or reviving its execution permission.
    pub fn verify_retained_observation_owner(&self) -> Result<()> {
        self.native.verify()?;
        ensure!(
            self.state.matches(&self.engine.state) && self.state.matches(&self.caller.state),
            "REMOTE_BUDGET_SOURCE_STATE_CHANGED"
        );
        ensure!(
            kcoder_config::PrivateDirectory::open_existing(&self.caller.state.cwd())?
                .directory_identity()?
                == self.native.workspace_directory_identity()?,
            "REMOTE_NATIVE_WORKSPACE_MISMATCH"
        );
        let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &self
                .engine
                .session_storage_dir_for(&self.accepted.identity.thread_id),
            &self.accepted.identity.thread_id,
        )?
        .context("REMOTE_ORIGINAL_TASK_MISSING")?;
        let mut observed = store
            .load(&self.accepted.identity)?
            .context("REMOTE_ORIGINAL_TASK_MISSING")?;
        observed.status = kcoder_types::TurnAttemptStatus::Accepted;
        observed.completion = None;
        ensure!(
            digest(&observed)? == digest(&self.accepted)?,
            "REMOTE_ORIGINAL_ACCEPTANCE_CHANGED"
        );
        Ok(())
    }
    pub fn execution_deadline(&self) -> Result<Option<tokio::time::Instant>> {
        self.ordinary_policy_sha256
            .as_ref()
            .map(|sha| {
                let remaining = super::ordinary_source::deadline_ms(
                    &self.native,
                    sha,
                    self.accepted.accepted_at_ms,
                )?
                .checked_sub(now()?)
                .context("REMOTE_ACCEPTED_SOURCE_DEADLINE_EXPIRED")?;
                Ok(tokio::time::Instant::now() + std::time::Duration::from_millis(remaining))
            })
            .transpose()
    }
    pub fn terminal_owner(&self) -> Option<NativeRemoteSourceTaskOwner> {
        self.ordinary_policy_sha256
            .as_ref()
            .map(|_| NativeRemoteSourceTaskOwner {
                engine: self.engine.clone(),
                accepted: self.accepted.clone(),
                ledger: self.service.accounting_store(),
                slot_id: self.parent.receipt().reservation_id.clone(),
                goal: self.goal.get().and_then(Clone::clone),
            })
    }
    #[cfg(test)]
    pub fn settle_actual_source_terminal(&self) -> Result<()> {
        self.terminal_owner()
            .map(|owner| owner.settle())
            .transpose()
            .map(|_| ())
    }
    pub fn bind_goal_for_original_owner(
        &self,
        owners: &Mutex<Vec<NativeRemoteSourceTaskOwner>>,
    ) -> Result<()> {
        self.check_original_task()?;
        if self.acceptance.is_some() {
            require_runtime_policy(&self.native, &self.root_operation)?;
        }
        if let Some(owner) = self.terminal_owner() {
            let mut owners = owners
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_SOURCE_ACCOUNTING_UNAVAILABLE"))?;
            if !owners
                .iter()
                .any(|existing| existing.slot_id == owner.slot_id)
            {
                owners.push(owner);
            }
        }
        let bound = if let Some(goal) = self.engine.state.goal() {
            ensure!(
                self.ordinary_policy_sha256.is_some(),
                "REMOTE_GOAL_ORIGINAL_TASK_POLICY_REQUIRED"
            );
            let attempts = Arc::new(
                kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
                    &self
                        .engine
                        .session_storage_dir_for(&self.accepted.identity.thread_id),
                    &self.accepted.identity.thread_id,
                )?
                .context("REMOTE_ACCEPTED_SOURCE_TASK_REQUIRED")?,
            );
            let binding = kcoder_state::NativeGoalTaskBudgetBinding::capture(
                self.service.accounting_store(),
                &self.parent,
                attempts,
                &self.accepted,
            )?;
            self.engine
                .state
                .reserve_goal_native_task_budget(&goal.goal_id, &binding)?;
            Some(Arc::new(SourceGoalBudget {
                id: goal.goal_id,
                generation: goal.created_at_ms,
                binding,
            }))
        } else {
            None
        };
        self.goal
            .set(bound.clone())
            .map_err(|_| anyhow::anyhow!("REMOTE_GOAL_BUDGET_ALREADY_BOUND"))?;
        if let Some(bound) = bound {
            let mut owners = owners
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_SOURCE_ACCOUNTING_UNAVAILABLE"))?;
            let owner = owners
                .iter_mut()
                .find(|owner| owner.slot_id == self.parent.receipt().reservation_id)
                .context("REMOTE_SOURCE_ACCOUNTING_UNAVAILABLE")?;
            ensure!(
                owner
                    .goal
                    .as_ref()
                    .is_none_or(|existing| existing.id == bound.id
                        && existing.generation == bound.generation),
                "REMOTE_GOAL_GENERATION_CHANGED"
            );
            owner.goal = Some(bound);
        }
        self.check_current()
    }
    pub fn require_delegation_policy(&self) -> Result<()> {
        self.check_current()?;
        if self.acceptance.is_some() {
            require_runtime_policy(&self.native, &self.root_operation)?;
        }
        if let Some(sha) = &self.ordinary_policy_sha256 {
            super::ordinary_source::verify(&self.native, sha, self.accepted.accepted_at_ms)?;
        }
        Ok(())
    }
    pub fn frozen_native_facts(&self) -> Result<super::launch::NativeRemoteSourceFacts> {
        self.check_current()?;
        let root_path = self.engine.client_storage_root();
        let root = kcoder_config::PrivateDirectory::open_existing(&root_path)?;
        root.verify_private_directory()
            .context("REMOTE_NATIVE_SOURCE_HISTORY_ROOT_UNSAFE")?;
        let session = root.open_child(
            std::ffi::OsStr::new(&self.accepted.identity.thread_id),
            false,
        )?;
        let attempts = session.open_child(std::ffi::OsStr::new("turn-attempts"), false)?;
        let profile_snapshot = self.native.profile()?.read_source_document_snapshot(
            std::ffi::OsStr::new("settings.json"),
            8 * 1024 * 1024,
            || self.native.verify().is_ok(),
        )?;
        let result = super::launch::NativeRemoteSourceFacts {
            scope: self.native.scope().clone(),
            profile: self.native.profile_path()?.to_owned(),
            workspace: self.engine.state.cwd(),
            history_root: root_path,
            history_root_identity: root.directory_identity()?,
            session_identity: session.directory_identity()?,
            attempts_identity: attempts.directory_identity()?,
            attempt: self.accepted.identity.clone(),
            accepted_receipt_sha256: digest(&self.accepted)?,
            tool_call_id: self
                .caller
                .tool_call_id
                .clone()
                .context("REMOTE_NATIVE_CALL_REQUIRED")?,
            original_root_operation: self.root_operation.clone(),
            original_root_acceptance: self.acceptance.clone(),
            original_parent_reservation: self.parent.receipt().reservation_id.clone(),
            profile_settings_sha256: profile_snapshot.sha256,
            goal: self
                .goal
                .get()
                .and_then(|goal| goal.as_ref())
                .map(|goal| {
                    let path = self
                        .engine
                        .state
                        .session_state_path()
                        .context("REMOTE_GOAL_STATE_REQUIRED")?;
                    let parent = kcoder_config::PrivateDirectory::open_existing(
                        path.parent().context("REMOTE_GOAL_STATE_REQUIRED")?,
                    )?;
                    parent.verify_private_directory()?;
                    Ok::<_, anyhow::Error>(super::launch::NativeRemoteSourceGoalFacts {
                        id: goal.id.clone(),
                        generation: goal.generation,
                        state_path: path,
                        directory_identity: parent.directory_identity()?,
                    })
                })
                .transpose()?,
        };
        self.check_current()?;
        Ok(result)
    }
    /// Reuse a real P-RUNTIME TaskSlot, or bind the actual ordinary Accepted turn
    /// to its explicitly configured finite outbound ceiling in the same ledger.
    pub fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        attempt: &TurnAttemptIdentity,
        actual: &ToolContext,
    ) -> Result<Arc<Self>> {
        let accepted = validate_caller(
            native,
            engine,
            attempt,
            actual,
            "native remote source budget binding",
        )?;

        let reference = IntegrationRuntimeReadTaskParams {
            thread_id: Some(attempt.thread_id.clone()),
            turn_id: Some(attempt.turn_id.clone()),
            task_id: None,
        };
        let runtime = match NativeRuntimeDriver::load(native)? {
            Some(driver) => match driver.operation_for_reference(native, &reference) {
                Ok(root) => Some(root),
                Err(error) if error.to_string() == "RUNTIME_NATIVE_REFERENCE_NOT_OBSERVED" => None,
                Err(error) => return Err(error),
            },
            None => None,
        };
        let (root_operation, acceptance, ordinary_policy_sha256, principal, service, parent) =
            if let Some(root) = runtime {
                let acceptance = runtime_acceptance(native, &root, attempt)?;
                let binding = super::ordinary_source::task_binding(
                    native.scope(),
                    &root,
                    attempt,
                    Some(&acceptance),
                    &digest(&accepted)?,
                )?;
                let principal = NativeBudgetPrincipal::from_native_facts(
                    native.scope().account_id.clone(),
                    None,
                    native.scope().workspace_id.as_ref().cloned(),
                    None,
                )?;
                let existing = match NativeBudgetService::load(native)? {
                    Some(service) => service
                        .accounting_store()
                        .original_active_task_slot(&principal, &binding)?
                        .map(|parent| (service, parent)),
                    None => None,
                };
                if let Some((service, parent)) = existing {
                    let policy = super::ordinary_source::existing_source_policy(
                        native,
                        &root,
                        parent.receipt(),
                    )?;
                    (root, Some(acceptance), policy, principal, service, parent)
                } else {
                    require_runtime_policy(native, &root)?;
                    let original = super::ordinary_source::capture_for_runtime(
                        native,
                        &accepted,
                        &root,
                        &acceptance,
                    )?;
                    (
                        root,
                        Some(acceptance),
                        Some(original.settings_sha256),
                        original.principal,
                        original.service,
                        original.parent,
                    )
                }
            } else {
                let ordinary = super::ordinary_source::capture(native, &accepted)?;
                (
                    ordinary.root,
                    None,
                    Some(ordinary.settings_sha256),
                    ordinary.principal,
                    ordinary.service,
                    ordinary.parent,
                )
            };
        let result = Arc::new(Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            state: engine.state.inspection_lifecycle_identity(),
            caller: actual.clone(),
            accepted,
            root_operation,
            acceptance,
            ordinary_policy_sha256,
            principal,
            service,
            parent,
            goal: OnceLock::new(),
        });
        result.check_original_task()?;
        Ok(result)
    }
    pub fn check_current(&self) -> Result<()> {
        self.check_current_binding(true)
    }
    /// Owned frame pumps do not inherit Tokio task locals. They retain the
    /// original actual captured owner, with the same persistent Accepted/State
    /// epoch, ToolContext abort, roots, slot, Goal and current policy checks.
    pub fn require_owned_transport_policy(&self) -> Result<()> {
        self.check_current_binding(false)?;
        if self.acceptance.is_some() {
            require_runtime_policy(&self.native, &self.root_operation)?;
        }
        if let Some(sha) = &self.ordinary_policy_sha256 {
            super::ordinary_source::verify(&self.native, sha, self.accepted.accepted_at_ms)?;
        }
        Ok(())
    }
    fn check_current_binding(&self, require_current_task: bool) -> Result<()> {
        self.check_original_task_binding(require_current_task)?;
        match (
            self.goal.get().and_then(|goal| goal.as_ref()),
            self.engine.state.goal(),
        ) {
            (Some(bound), Some(current)) => {
                ensure!(
                    current.goal_id == bound.id && current.created_at_ms == bound.generation,
                    "REMOTE_GOAL_GENERATION_CHANGED"
                );
                self.engine
                    .state
                    .verify_goal_native_task_budget(&bound.id, &bound.binding)?;
            }
            (None, None) => {}
            _ => anyhow::bail!("REMOTE_GOAL_BUDGET_BINDING_REQUIRED"),
        }
        Ok(())
    }
    fn check_original_task(&self) -> Result<()> {
        self.check_original_task_binding(true)
    }
    fn check_original_task_binding(&self, require_current_task: bool) -> Result<()> {
        ensure!(
            self.state.matches(&self.engine.state) && self.state.matches(&self.caller.state),
            "REMOTE_BUDGET_SOURCE_STATE_CHANGED"
        );
        let validate = if require_current_task {
            validate_caller
        } else {
            validate_captured_caller
        };
        ensure!(
            validate(
                &self.native,
                &self.engine,
                &self.accepted.identity,
                &self.caller,
                "native remote source budget binding"
            )? == self.accepted,
            "REMOTE_BUDGET_SOURCE_ATTEMPT_CHANGED"
        );

        if let Some(acceptance) = &self.acceptance {
            ensure!(
                &runtime_acceptance(&self.native, &self.root_operation, &self.accepted.identity)?
                    == acceptance,
                "REMOTE_BUDGET_ORIGINAL_RUNTIME_CHANGED"
            );
        }
        if let Some(sha) = self.ordinary_policy_sha256.as_deref() {
            super::ordinary_source::verify(&self.native, sha, self.accepted.accepted_at_ms)?;
        } else {
            ensure!(
                self.acceptance.is_some(),
                "REMOTE_ACCEPTED_SOURCE_OUTBOUND_POLICY_REQUIRED"
            );
        }
        self.service.verify(&self.native)?;
        self.service
            .accounting_store()
            .verify_original_task_slot(&self.parent)?;
        Ok(())
    }
    /// The receiver's native Provider observer supplies the actual native call
    /// identity and a conservative bound. Caller JSON is never a reservation.
    #[cfg(test)]
    pub fn reserve_actual_call(
        self: &Arc<Self>,
        native_call_id: &str,
        estimate: BudgetCharge,
    ) -> Result<NativeRemoteSourceReservation> {
        self.check_current()?;
        self.reserve_captured_call(native_call_id, estimate)
    }
    /// The private callback retains the original opaque owner. It must not
    /// borrow a Tokio task-local acceptance from the unrelated I/O pump.
    pub fn reserve_owned_callback_call(
        self: &Arc<Self>,
        native_call_id: &str,
        estimate: BudgetCharge,
    ) -> Result<NativeRemoteSourceReservation> {
        self.require_owned_transport_policy()?;
        self.reserve_captured_call(native_call_id, estimate)
    }
    fn reserve_captured_call(
        self: &Arc<Self>,
        native_call_id: &str,
        estimate: BudgetCharge,
    ) -> Result<NativeRemoteSourceReservation> {
        ensure!(
            !native_call_id.is_empty()
                && native_call_id.len() <= 256
                && !native_call_id.chars().any(char::is_control)
                && estimate.tokens > 0
                && estimate.model_calls == 1
                && estimate.run_millis > 0,
            "REMOTE_NATIVE_MODEL_BOUND_REQUIRED"
        );
        let ledger = self.service.accounting_store();
        let policies =
            ledger.current_applicable_policies(&self.principal, &self.root_operation, now()?)?;
        ensure!(
            !policies.is_empty(),
            "REMOTE_ORIGINAL_BUDGET_POLICY_REQUIRED"
        );
        let id = format!(
            "remote-model-{}",
            digest(&(
                &self.root_operation,
                &self.accepted.identity,
                &self.caller.tool_call_id,
                native_call_id
            ))?
        );
        let request = NativeBudgetRequest {
            reservation_id: id.clone(),
            operation_id: format!("remote-call-{}", digest(&id)?),
            principal: self.principal.clone(),
            unit: BudgetUnit::ModelCall,
            task: BudgetTaskLink {
                root_operation_id: self.root_operation.clone(),
                root_task: self.parent.receipt().task.root_task.clone(),
                actor: BudgetActor::ChildAgent,
                actor_attempt_id: format!(
                    "remote-attempt-{}",
                    digest(&(
                        &self.accepted.identity,
                        &self.caller.tool_call_id,
                        native_call_id
                    ))?
                ),
                parent_reservation_id: Some(self.parent.receipt().reservation_id.clone()),
            },
            estimate,
        };
        let BudgetReservationResult::Created(receipt) =
            ledger.reserve_with_original_task_slot(&self.parent, &request, &policies, now()?)?
        else {
            anyhow::bail!("REMOTE_ORIGINAL_MODEL_CALL_ALREADY_OBSERVED")
        };
        Ok(NativeRemoteSourceReservation {
            source: self.clone(),
            ledger,
            receipt,
            policies,
            dispatched: false,
        })
    }
}

/// Retain only the original accounting/task facts, never the ToolContext with
/// its runtime executors. Retaining that context would retain the turn tools
/// through their executor and create a registry/backend ownership cycle.
pub struct NativeRemoteSourceTaskOwner {
    engine: QueryEngine,
    accepted: TurnAttemptRecord,
    ledger: Arc<NativeBudgetStore>,
    pub(super) slot_id: String,
    goal: Option<Arc<SourceGoalBudget>>,
}
impl NativeRemoteSourceTaskOwner {
    pub fn settle(&self) -> Result<()> {
        let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &self
                .engine
                .session_storage_dir_for(&self.accepted.identity.thread_id),
            &self.accepted.identity.thread_id,
        )?
        .context("REMOTE_ACCEPTED_SOURCE_TASK_REQUIRED")?;
        let actual = store
            .load(&self.accepted.identity)?
            .context("REMOTE_ACCEPTED_SOURCE_TASK_REQUIRED")?;
        let mut accepted = actual.clone();
        accepted.status = kcoder_types::TurnAttemptStatus::Accepted;
        accepted.completion = None;
        ensure!(
            accepted == self.accepted,
            "REMOTE_BUDGET_SOURCE_ATTEMPT_CHANGED"
        );
        let kind = match actual.status {
            kcoder_types::TurnAttemptStatus::Completed => BudgetTerminalKind::Completed,
            kcoder_types::TurnAttemptStatus::Failed => BudgetTerminalKind::Failed,
            kcoder_types::TurnAttemptStatus::Interrupted => BudgetTerminalKind::Cancelled,
            _ => return Ok(()),
        };
        let ledger = &self.ledger;
        let slot = ledger
            .read_reservation(&self.slot_id)?
            .context("REMOTE_ORIGINAL_TASK_SLOT_REQUIRED")?;
        if slot.execution_confirmed_terminal {
            return self.settle_goal();
        }
        let terminal = NativeBudgetTerminal::from_authoritative_receipt(
            slot.operation_id.clone(),
            slot.task.root_task.clone(),
            slot.task.actor_attempt_id.clone(),
            format!("source-terminal-{}", digest(&actual.identity)?),
            digest(&actual)?,
            kind,
        )?;
        ledger.record_usage(
            &slot.reservation_id,
            slot.revision,
            "actual-accepted-source-terminal",
            &NativeBudgetUsage {
                coverage: BudgetUsageCoverage::Complete,
                known: BudgetCharge::zero(),
            },
            Some(&terminal),
            now()?,
        )?;
        self.settle_goal()
    }
    fn settle_goal(&self) -> Result<()> {
        if let Some(goal) = &self.goal {
            self.engine
                .state
                .reconcile_goal_native_task_budget(&goal.id, &goal.binding)?;
        }
        Ok(())
    }
}

pub struct NativeRemoteSourceReservation {
    source: Arc<NativeRemoteSourceBudget>,
    ledger: Arc<NativeBudgetStore>,
    receipt: BudgetReservationReceipt,
    policies: Vec<NativeBudgetPolicy>,
    dispatched: bool,
}
impl NativeRemoteSourceReservation {
    #[cfg(test)]
    pub fn before_dispatch(&mut self) -> Result<()> {
        self.source.check_current()?;
        self.dispatch_captured_call()
    }
    pub fn dispatch_owned_callback_call(&mut self) -> Result<()> {
        self.source.require_owned_transport_policy()?;
        self.dispatch_captured_call()
    }
    fn dispatch_captured_call(&mut self) -> Result<()> {
        ensure!(
            !self.dispatched,
            "REMOTE_ORIGINAL_MODEL_CALL_ALREADY_DISPATCHED"
        );
        let BudgetDispatchResult::Fresh(receipt) = self.ledger.mark_dispatched(
            &self.receipt.reservation_id,
            self.receipt.revision,
            &self.policies,
            now()?,
        )?
        else {
            anyhow::bail!("REMOTE_ORIGINAL_MODEL_CALL_ALREADY_OBSERVED")
        };
        self.receipt = receipt;
        self.dispatched = true;
        Ok(())
    }
    #[cfg(test)]
    pub fn check_current(&self) -> Result<()> {
        self.source.check_current()?;
        let current = self.ledger.current_applicable_policies(
            &self.source.principal,
            &self.source.root_operation,
            now()?,
        )?;
        let mut refs = current
            .iter()
            .map(|policy| -> Result<String> {
                Ok(serde_json::to_string(
                    &self
                        .ledger
                        .observe_policy(policy)?
                        .context("REMOTE_ORIGINAL_BUDGET_POLICY_MISSING")?
                        .policy,
                )?)
            })
            .collect::<Result<Vec<_>>>()?;
        let mut original = self
            .receipt
            .policy_refs
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        refs.sort();
        original.sort();
        ensure!(refs == original, "REMOTE_ORIGINAL_BUDGET_POLICY_CHANGED");
        Ok(())
    }
    pub fn receipt(&self) -> &BudgetReservationReceipt {
        &self.receipt
    }
    /// Only the original authenticated Native frame owner calls this after
    /// checking its held endpoint and actual Receiver Accepted/call witness.
    /// The data types themselves never create a terminal or a refund.
    pub fn finish_authenticated_receiver_call(
        &mut self,
        native_call_id: &str,
        receiver: &NativeRemoteAcceptedFactsV1,
        outcome: NativeRemoteCallOutcomeV1,
        usage: Option<BudgetCharge>,
    ) -> Result<()> {
        ensure!(self.dispatched, "REMOTE_ORIGINAL_MODEL_CALL_NOT_DISPATCHED");
        // Settlement retains only this original accounting authority. A
        // revoked Source cannot execute again, but actual usage must still be
        // charged rather than silently lost during cancellation/termination.
        let current = self
            .ledger
            .read_reservation(&self.receipt.reservation_id)?
            .context("REMOTE_ORIGINAL_MODEL_CALL_MISSING")?;
        ensure!(
            current.revision == self.receipt.revision && !current.execution_confirmed_terminal,
            "REMOTE_ORIGINAL_MODEL_CALL_ALREADY_OBSERVED"
        );
        let complete = outcome == NativeRemoteCallOutcomeV1::Completed && usage.is_some();
        let mut known = usage.unwrap_or_else(|| BudgetCharge {
            cost_micros: None,
            ..BudgetCharge::zero()
        });
        ensure!(
            known.cost_micros.is_none(),
            "REMOTE_CONTROL_MONEY_PROVENANCE_UNAVAILABLE"
        );
        known.model_calls = 1;
        let terminal = match outcome {
            NativeRemoteCallOutcomeV1::Completed => Some(BudgetTerminalKind::Completed),
            NativeRemoteCallOutcomeV1::Failed => Some(BudgetTerminalKind::Failed),
            NativeRemoteCallOutcomeV1::Interrupted => Some(BudgetTerminalKind::Cancelled),
            NativeRemoteCallOutcomeV1::OutcomeUnknown => None,
        }
        .map(|kind| {
            NativeBudgetTerminal::from_authoritative_receipt(
                current.operation_id.clone(),
                current.task.root_task.clone(),
                current.task.actor_attempt_id.clone(),
                format!(
                    "remote-native-terminal-{}",
                    digest(&(receiver, native_call_id))?
                ),
                digest(&(receiver, native_call_id, outcome, &known))?,
                kind,
            )
        })
        .transpose()?;
        self.receipt = self.ledger.record_usage(
            &current.reservation_id,
            current.revision,
            &format!(
                "remote-native-result-{}",
                digest(&(receiver, native_call_id, outcome))?
            ),
            &NativeBudgetUsage {
                coverage: if complete {
                    BudgetUsageCoverage::Complete
                } else {
                    BudgetUsageCoverage::Partial
                },
                known,
            },
            terminal.as_ref(),
            now()?,
        )?;
        Ok(())
    }
}
fn require_runtime_policy(native: &NativeIntegrationContext, root: &str) -> Result<()> {
    let driver =
        NativeRuntimeDriver::load(native)?.context("REMOTE_ORIGINAL_RUNTIME_BINDING_REQUIRED")?;
    let configuration = driver.read_execution_configuration(native, root)?;
    ensure!(
        configuration.external_send == super::super::runtime_driver::RuntimeExternalSend::Ask
            && configuration
                .allowed_tools
                .as_ref()
                .is_none_or(|tools| tools.iter().any(|name| name == "RemoteDelegate")),
        "REMOTE_ORIGINAL_DELEGATION_POLICY_DENIED"
    );
    Ok(())
}

fn runtime_acceptance(
    native: &NativeIntegrationContext,
    operation: &str,
    attempt: &TurnAttemptIdentity,
) -> Result<IntegrationRuntimeAcceptance> {
    let receipt = NativeOperations::load(native)?
        .context("REMOTE_ORIGINAL_RUNTIME_MISSING")?
        .read(native, operation)?
        .context("REMOTE_ORIGINAL_RUNTIME_MISSING")?;
    native.validate_scope(&receipt.scope)?;
    ensure!(
        receipt.operation_id == operation
            && receipt.port == "P-RUNTIME"
            && receipt.method == "acceptTask"
            && receipt.phase == IntegrationOperationPhase::Accepted,
        "REMOTE_ORIGINAL_RUNTIME_NOT_ACTIVE"
    );
    let accepted = receipt
        .runtime_acceptance
        .context("REMOTE_ORIGINAL_RUNTIME_ACCEPTANCE_REQUIRED")?;
    accepted.validate()?;
    ensure!(
        accepted.thread_id == attempt.thread_id
            && accepted.turn_id.as_ref() == Some(&attempt.turn_id)
            && accepted.task_id.is_none()
            && accepted.state == IntegrationTaskState::Running,
        "REMOTE_ORIGINAL_RUNTIME_OWNER_MISMATCH"
    );
    Ok(accepted)
}
fn now() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    )?)
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
#[cfg(test)]
#[path = "source_budget_tests.rs"]
pub mod tests;
