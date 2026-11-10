//! Hold a real original Native task ceiling in the original persisted Goal.
use crate::integrations::core::budgets::{
    BudgetPhase, BudgetPolicyReference, BudgetReservationReceipt, BudgetUnit,
    BudgetWindowObservation, NativeBudgetStore, NativeBudgetTaskParent,
};
use crate::session_persistence::{load_session_state, prepare_session_state_write};
use crate::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use crate::{AppState, Goal};
use anyhow::{Context, Result, ensure};
use kcoder_types::{TurnAttemptIdentity, TurnAttemptStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const MAX_HOLDS: usize = 1024;
const POLICY: &str = "native-remote-accepted-turn";
fn default_unknown() -> bool {
    true
}

/// Persistence facts only. A decoded record cannot become a Native binding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GoalNativeTaskHold {
    ledger_identity: String,
    slot_id: String,
    accepted: TurnAttemptIdentity,
    accepted_sha256: String,
    policy: BudgetPolicyReference,
    maximum_tokens: u64,
    charged_tokens: u64,
    settled: bool,
    #[serde(default = "default_unknown")]
    unknown_usage: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeHoldBudgetLimitCause {
    generation: u64,
    budget: Option<u64>,
    user_epoch: u64,
    slots: Vec<String>,
}
pub(crate) fn is_zero(value: &u64) -> bool {
    *value == 0
}

pub(crate) fn note_explicit_goal_change(goal: &mut Goal) -> Option<()> {
    if !goal.native_task_budget_holds.is_empty() || goal.native_hold_budget_limit_cause.is_some() {
        goal.native_budget_user_epoch = goal.native_budget_user_epoch.checked_add(1)?;
        goal.native_hold_budget_limit_cause = None;
    }
    Some(())
}

pub(crate) fn budget_limit_cause(goal: &Goal) -> Option<NativeHoldBudgetLimitCause> {
    let budget = goal.token_budget?;
    let held = goal
        .native_task_budget_holds
        .values()
        .filter(|hold| !hold.settled)
        .try_fold(0u64, |sum, hold| sum.checked_add(hold.charged_tokens))?;
    if held == 0 || goal.tokens_used < budget || goal.tokens_used.checked_sub(held)? >= budget {
        return None;
    }
    Some(NativeHoldBudgetLimitCause {
        generation: goal.created_at_ms,
        budget: goal.token_budget,
        user_epoch: goal.native_budget_user_epoch,
        slots: goal
            .native_task_budget_holds
            .iter()
            .filter(|(_, hold)| !hold.settled)
            .map(|(id, _)| id.clone())
            .collect(),
    })
}

/// Opaque actual stores, original Accepted receipt and original TaskSlot. No
/// Deserialize implementation, caller paths, PID or decoded boolean grant it.
pub struct NativeGoalTaskBudgetBinding {
    ledger: Arc<NativeBudgetStore>,
    attempts: Arc<TurnAttemptStore>,
    accepted: TurnAttemptRecord,
    slot: BudgetReservationReceipt,
    facts: GoalNativeTaskHold,
}
impl NativeGoalTaskBudgetBinding {
    pub fn capture(
        ledger: Arc<NativeBudgetStore>,
        parent: &NativeBudgetTaskParent,
        attempts: Arc<TurnAttemptStore>,
        accepted: &TurnAttemptRecord,
    ) -> Result<Self> {
        ensure!(
            accepted.status == TurnAttemptStatus::Accepted && accepted.completion.is_none(),
            "GOAL_NATIVE_ACCEPTED_REQUIRED"
        );
        let original = ledger.verify_original_task_slot(parent)?;
        let (slot, observed, _) = ledger
            .observe_task_slot_policy(&original.reservation_id, POLICY)?
            .context("GOAL_NATIVE_TASK_SLOT_REQUIRED")?;
        ensure!(
            slot == original
                && slot.unit == BudgetUnit::TaskSlot
                && slot.task.actor_attempt_id == accepted.identity.attempt_id
                && slot.task.root_task.as_ref().is_some_and(|task| {
                    task.kind == kcoder_types::integrations::core::IntegrationEntityKind::Turn
                        && task.id == accepted.identity.turn_id
                }),
            "GOAL_NATIVE_ACCEPTED_TASK_CHANGED"
        );
        let maximum = observed
            .limits
            .tokens
            .context("GOAL_NATIVE_TASK_TOKEN_CEILING_REQUIRED")?;
        ensure!(maximum > 0, "GOAL_NATIVE_TASK_TOKEN_CEILING_REQUIRED");
        let facts = GoalNativeTaskHold {
            ledger_identity: ledger.storage_directory_identity()?,
            slot_id: slot.reservation_id.clone(),
            accepted: accepted.identity.clone(),
            accepted_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(accepted)?)),
            policy: observed.policy,
            maximum_tokens: maximum,
            charged_tokens: maximum,
            settled: false,
            unknown_usage: true,
        };
        let result = Self {
            ledger,
            attempts,
            accepted: accepted.clone(),
            slot,
            facts,
        };
        result.observe(false)?;
        Ok(result)
    }
    fn observe(&self, terminal: bool) -> Result<(BudgetWindowObservation, bool)> {
        ensure!(
            self.ledger.storage_directory_identity()? == self.facts.ledger_identity,
            "GOAL_NATIVE_LEDGER_CHANGED"
        );
        let actual = self
            .attempts
            .load(&self.accepted.identity)?
            .context("GOAL_NATIVE_ACCEPTED_REQUIRED")?;
        let mut normalized = actual.clone();
        normalized.status = TurnAttemptStatus::Accepted;
        normalized.completion = None;
        ensure!(normalized == self.accepted, "GOAL_NATIVE_ACCEPTED_CHANGED");
        let (slot, observation, usage_complete) = self
            .ledger
            .observe_task_slot_policy(&self.facts.slot_id, POLICY)?
            .context("GOAL_NATIVE_TASK_SLOT_REQUIRED")?;
        ensure!(
            slot.task == self.slot.task
                && slot.operation_id == self.slot.operation_id
                && observation.policy == self.facts.policy
                && observation.limits.tokens == Some(self.facts.maximum_tokens),
            "GOAL_NATIVE_TASK_CHANGED"
        );
        if terminal {
            ensure!(
                matches!(
                    actual.status,
                    TurnAttemptStatus::Completed
                        | TurnAttemptStatus::Failed
                        | TurnAttemptStatus::Interrupted
                ) && actual.completion.is_some()
                    && slot.execution_confirmed_terminal
                    && slot.phase == BudgetPhase::Terminal,
                "GOAL_NATIVE_TASK_TERMINAL_REQUIRED"
            );
        } else {
            ensure!(
                actual == self.accepted
                    && !slot.execution_confirmed_terminal
                    && slot.phase != BudgetPhase::Terminal,
                "GOAL_NATIVE_TASK_NOT_ACTIVE"
            );
        }
        Ok((observation, usage_complete))
    }
}

impl AppState {
    /// Observe the same current durable Goal/hold before another original
    /// effect. This allocates no namespace, model, task or new reservation.
    pub fn verify_goal_native_task_budget(
        &self,
        goal_id: &str,
        binding: &NativeGoalTaskBudgetBinding,
    ) -> Result<()> {
        let (path, source, generation) = {
            let inner = self.read_inner();
            let goal = inner.goal.as_ref().context("GOAL_NATIVE_GOAL_REQUIRED")?;
            ensure!(
                goal.goal_id == goal_id && inner.session_id == binding.accepted.identity.thread_id,
                "GOAL_NATIVE_OWNER_CHANGED"
            );
            (
                inner
                    .session_state_path
                    .clone()
                    .context("GOAL_NATIVE_PERSISTENCE_REQUIRED")?,
                inner
                    .history_source
                    .clone()
                    .context("GOAL_NATIVE_HISTORY_REQUIRED")?,
                goal.created_at_ms,
            )
        };
        source.check()?;
        let durable = load_session_state(&path)?;
        let goal = durable.goal.context("GOAL_NATIVE_GOAL_REQUIRED")?;
        ensure!(
            goal.goal_id == goal_id && goal.created_at_ms == generation && goal.status.is_active(),
            "GOAL_NATIVE_GENERATION_CHANGED"
        );
        let hold = goal
            .native_task_budget_holds
            .get(&binding.facts.slot_id)
            .context("GOAL_NATIVE_HOLD_REQUIRED")?;
        ensure!(
            same_binding(hold, &binding.facts)
                && !hold.settled
                && goal
                    .token_budget
                    .is_none_or(|maximum| goal.tokens_used <= maximum),
            "GOAL_NATIVE_HOLD_CHANGED"
        );
        binding.observe(false)?;
        source.check()?;
        Ok(())
    }

    /// Called only by the native original-task composition after ordinary final
    /// Tool permission/dispatch. The original HistorySource transaction rereads
    /// Goal generation, Accepted and TaskSlot before any balance is allocated.
    pub fn reserve_goal_native_task_budget(
        &self,
        goal_id: &str,
        binding: &NativeGoalTaskBudgetBinding,
    ) -> Result<()> {
        self.mutate_native_goal_budget(goal_id, binding, false)
    }

    /// A terminal Source task alone cannot refund an unknown running child.
    /// Only the same original ledger's closed calls and usage settle this hold.
    pub fn reconcile_goal_native_task_budget(
        &self,
        goal_id: &str,
        binding: &NativeGoalTaskBudgetBinding,
    ) -> Result<()> {
        self.mutate_native_goal_budget(goal_id, binding, true)
    }

    fn mutate_native_goal_budget(
        &self,
        goal_id: &str,
        binding: &NativeGoalTaskBudgetBinding,
        terminal: bool,
    ) -> Result<()> {
        let _persist = self.lock_session_state_persistence();
        let (path, source, expected) = {
            let inner = self.read_inner();
            ensure!(
                inner.history_write_fault.is_none(),
                "GOAL_NATIVE_HISTORY_UNAVAILABLE"
            );
            let goal = inner.goal.as_ref().context("GOAL_NATIVE_GOAL_REQUIRED")?;
            ensure!(
                goal.goal_id == goal_id && inner.session_id == binding.accepted.identity.thread_id,
                "GOAL_NATIVE_OWNER_CHANGED"
            );
            (
                inner
                    .session_state_path
                    .clone()
                    .context("GOAL_NATIVE_PERSISTENCE_REQUIRED")?,
                inner
                    .history_source
                    .clone()
                    .context("GOAL_NATIVE_HISTORY_REQUIRED")?,
                (goal.goal_id.clone(), goal.created_at_ms),
            )
        };
        let mut committed = None;
        source.write_metadata(&path, || {
            // This is under the original cross-process history mutation lock.
            // Never acquire an AppState lock inside this callback.
            let (observed, usage_complete) = binding.observe(terminal)?;
            let mut durable = load_session_state(&path)?;
            if !terminal {
                ensure!(!durable.goal_history.iter().any(|previous| previous.goal_id != expected.0
                    && previous.native_task_budget_holds.get(&binding.facts.slot_id)
                        .is_some_and(|hold| hold.ledger_identity == binding.facts.ledger_identity)),
                    "GOAL_NATIVE_GENERATION_CHANGED");
            }
            let goal = durable.goal.as_mut().context("GOAL_NATIVE_GOAL_REQUIRED")?;
            ensure!(
                (&goal.goal_id, goal.created_at_ms) == (&expected.0, expected.1),
                "GOAL_NATIVE_GENERATION_CHANGED"
            );
            let key = binding.facts.slot_id.clone();
            if terminal {
                let hold = goal
                    .native_task_budget_holds
                    .get_mut(&key)
                    .context("GOAL_NATIVE_HOLD_REQUIRED")?;
                ensure!(
                    same_binding(hold, &binding.facts),
                    "GOAL_NATIVE_HOLD_CHANGED"
                );
                // Unknown active calls keep the complete original hold. No
                // retry, replacement task or successful receipt is fabricated.
                if observed.active_calls == 0 {
                    let tokens = observed.charged.tokens;
                    goal.tokens_used = goal
                        .tokens_used
                        .checked_sub(hold.charged_tokens)
                        .and_then(|base| base.checked_add(tokens))
                        .context("GOAL_NATIVE_USAGE_OVERFLOW")?;
                    let original_bound = hold.charged_tokens;
                    hold.charged_tokens = tokens;
                    hold.settled = true;
                    hold.unknown_usage = !usage_complete;
                    if goal.status == crate::GoalStatus::BudgetLimited && !goal.budget_exhausted()
                        && goal.native_hold_budget_limit_cause.as_ref().is_some_and(|cause| {
                            cause.generation == goal.created_at_ms && cause.budget == goal.token_budget
                                && cause.user_epoch == goal.native_budget_user_epoch
                                && cause.slots.contains(&binding.facts.slot_id)
                        }) {
                        // BudgetLimited is derived from the conservative charge.
                        // Authoritative lower usage corrects that projection;
                        // user-owned pause/stop states are never reactivated.
                        goal.status = crate::GoalStatus::Active;
                        goal.native_hold_budget_limit_cause = None;
                    }
                    if original_bound != tokens {
                        goal.push_event(crate::GoalEventKind::NativeBudgetReconciled,
                            format!("Original Native task quota reconciled from {original_bound} held tokens to {tokens} charged tokens; unknown dispatched usage remains charged."));
                    }
                    goal.touch();
                }
            } else if let Some(existing) = goal.native_task_budget_holds.get(&key) {
                ensure!(
                    same_binding(existing, &binding.facts) && !existing.settled,
                    "GOAL_NATIVE_HOLD_CHANGED"
                );
                ensure!(goal.status.is_active(), "GOAL_NATIVE_GOAL_NOT_ACTIVE");
            } else {
                ensure!(
                    goal.status.is_active() && goal.native_task_budget_holds.len() < MAX_HOLDS,
                    "GOAL_NATIVE_GOAL_NOT_ACTIVE"
                );
                let next = goal
                    .tokens_used
                    .checked_add(binding.facts.maximum_tokens)
                    .context("GOAL_NATIVE_USAGE_OVERFLOW")?;
                ensure!(
                    goal.token_budget.is_none_or(|maximum| next <= maximum),
                    "GOAL_NATIVE_TOKEN_BUDGET_EXHAUSTED"
                );
                goal.tokens_used = next;
                goal.native_task_budget_holds
                    .insert(key, binding.facts.clone());
                goal.touch();
            }
            let projection = goal.clone();
            if let Some(previous) = durable.goal_history.iter_mut().find(|previous| previous.goal_id == projection.goal_id) {
                *previous = projection.clone();
            }
            let bytes = prepare_session_state_write(&path, &durable)?;
            committed = Some(projection);
            Ok(bytes)
        })?;
        let projection = committed.context("GOAL_NATIVE_COMMIT_MISSING")?;
        let mut inner = self.write_inner();
        let current = inner.goal.as_mut().context("GOAL_NATIVE_GOAL_REQUIRED")?;
        ensure!(
            (&current.goal_id, current.created_at_ms) == (&expected.0, expected.1),
            "GOAL_NATIVE_GENERATION_CHANGED"
        );
        *current = projection.clone();
        if let Some(previous) = inner
            .goal_history
            .iter_mut()
            .find(|previous| previous.goal_id == projection.goal_id)
        {
            *previous = projection;
        }
        Ok(())
    }
}

fn same_binding(left: &GoalNativeTaskHold, right: &GoalNativeTaskHold) -> bool {
    let mut left = left.clone();
    left.charged_tokens = right.charged_tokens;
    left.settled = right.settled;
    left.unknown_usage = right.unknown_usage;
    left == *right
}

/// Normal metadata snapshots retain the authoritative Native holds even when
/// another process committed them after this in-memory Goal was read.
pub(crate) fn preserve_native_goal_holds(
    incoming: &mut Option<Goal>,
    authority: &Option<Goal>,
) -> Result<()> {
    let (Some(local), Some(authority)) = (incoming.as_mut(), authority.as_ref()) else {
        return Ok(());
    };
    if (local.goal_id.as_str(), local.created_at_ms)
        != (authority.goal_id.as_str(), authority.created_at_ms)
        || authority.native_task_budget_holds.is_empty()
    {
        return Ok(());
    }
    let local_charge = local
        .native_task_budget_holds
        .values()
        .try_fold(0u64, |sum, hold| sum.checked_add(hold.charged_tokens))
        .context("GOAL_NATIVE_USAGE_OVERFLOW")?;
    let authority_charge = authority
        .native_task_budget_holds
        .values()
        .try_fold(0u64, |sum, hold| sum.checked_add(hold.charged_tokens))
        .context("GOAL_NATIVE_USAGE_OVERFLOW")?;
    let base = local
        .tokens_used
        .checked_sub(local_charge)
        .context("GOAL_NATIVE_USAGE_CORRUPT")?;
    let authority_base = authority
        .tokens_used
        .checked_sub(authority_charge)
        .context("GOAL_NATIVE_USAGE_CORRUPT")?;
    if local.native_budget_user_epoch < authority.native_budget_user_epoch {
        *local = authority.clone();
    } else if local.native_budget_user_epoch == authority.native_budget_user_epoch
        && local.native_hold_budget_limit_cause.is_none()
        && authority.native_hold_budget_limit_cause.is_some()
    {
        local.native_hold_budget_limit_cause = authority.native_hold_budget_limit_cause.clone();
        if authority.status == crate::GoalStatus::BudgetLimited {
            local.status = authority.status;
        }
    }
    local.tokens_used = base
        .max(authority_base)
        .checked_add(authority_charge)
        .context("GOAL_NATIVE_USAGE_OVERFLOW")?;
    local.native_task_budget_holds = authority.native_task_budget_holds.clone();
    local.revision = local.revision.max(authority.revision);
    Ok(())
}

impl Goal {
    /// The native receiver supplies bytes from the Source's held private
    /// sidecar directory. JSON alone is never a store or execution authority.
    pub fn verify_native_budget_snapshot(
        bytes: &[u8],
        goal_id: &str,
        generation: u64,
        slot_id: &str,
        ledger_identity: &str,
        accepted: &TurnAttemptRecord,
    ) -> Result<()> {
        let state: crate::session_persistence::PersistedSessionState =
            serde_json::from_slice(bytes)?;
        let goal = state.goal.context("GOAL_NATIVE_GOAL_REQUIRED")?;
        ensure!(
            goal.goal_id == goal_id && goal.created_at_ms == generation && goal.status.is_active(),
            "GOAL_NATIVE_GENERATION_CHANGED"
        );
        let hold = goal
            .native_task_budget_holds
            .get(slot_id)
            .context("GOAL_NATIVE_HOLD_REQUIRED")?;
        ensure!(
            hold.ledger_identity == ledger_identity
                && hold.accepted == accepted.identity
                && !hold.settled
                && hold.accepted_sha256
                    == format!("{:x}", Sha256::digest(serde_json::to_vec(accepted)?))
                && goal
                    .token_budget
                    .is_none_or(|maximum| goal.tokens_used <= maximum),
            "GOAL_NATIVE_HOLD_CHANGED"
        );
        Ok(())
    }

    /// Public/model output omits the private original ledger, slot and Accepted
    /// bindings. Numeric conservative/unknown usage remains understandable.
    pub fn public_native_budget_projection(&self) -> Result<serde_json::Value> {
        let mut value = serde_json::to_value(self)?;
        let fields = value
            .as_object_mut()
            .context("GOAL_NATIVE_PROJECTION_INVALID")?;
        for key in [
            "native_task_budget_holds",
            "native_budget_user_epoch",
            "native_hold_budget_limit_cause",
        ] {
            fields.remove(key);
        }
        if !self.native_task_budget_holds.is_empty() {
            let sum = |select: fn(&GoalNativeTaskHold) -> bool| -> Result<u64> {
                self.native_task_budget_holds
                    .values()
                    .filter(|hold| select(hold))
                    .try_fold(0u64, |total, hold| total.checked_add(hold.charged_tokens))
                    .context("GOAL_NATIVE_USAGE_OVERFLOW")
            };
            fields.insert("native_budget".into(), serde_json::json!({
                "charged_tokens":sum(|_| true)?, "held_tokens":sum(|hold| !hold.settled)?,
                "unknown_tokens":sum(|hold| hold.unknown_usage)?,
                "active_task_holds":self.native_task_budget_holds.values().filter(|hold| !hold.settled).count()
            }));
        }
        Ok(value)
    }
}

pub(crate) fn validate_persisted_holds(
    holds: &std::collections::BTreeMap<String, GoalNativeTaskHold>,
) -> Result<()> {
    ensure!(holds.len() <= MAX_HOLDS, "GOAL_NATIVE_HOLD_CAPACITY");
    for (key, hold) in holds {
        ensure!(
            key == &hold.slot_id
                && !key.is_empty()
                && key.len() <= 256
                && !key.chars().any(char::is_control)
                && hold.maximum_tokens > 0
                && hold.accepted_sha256.len() == 64
                && hold
                    .accepted_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "GOAL_NATIVE_HOLD_INVALID"
        );
        hold.accepted.validate().map_err(anyhow::Error::msg)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "goal_remote_budget_tests.rs"]
mod tests;
