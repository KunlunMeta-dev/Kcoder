use anyhow::{Context, Result, ensure};
use kcoder_types::integrations::core::{
    IntegrationEntityKind, IntegrationEntityRef, IntegrationOwner,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) const MAX_RESERVATIONS: usize = 4096;
pub(super) const MAX_WINDOWS: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "id",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BudgetScope {
    Organization(String),
    Account(String),
    Workspace(String),
    Task(String),
    Subscription(String),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetWindow {
    pub id: String,
    pub starts_at_ms: u64,
    pub ends_at_ms: u64,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetLimits {
    pub tokens: Option<u64>,
    pub model_calls: Option<u64>,
    pub run_millis: Option<u64>,
    pub cost_micros: Option<u64>,
    pub concurrent_tasks: Option<u32>,
    pub concurrent_calls: Option<u32>,
}
/// Native resolved configuration only. No Deserialize implementation exists.
#[derive(Debug, Clone)]
pub struct NativeBudgetPolicyDefinition {
    pub id: String,
    pub version: u64,
    pub revision: String,
    pub scope: BudgetScope,
    pub window: BudgetWindow,
    pub limits: BudgetLimits,
    pub currency: Option<String>,
}
/// Construct only after the host resolves and authorizes its actual policy.
/// Neither JSON limits nor a scope label can be converted to this via serde.
#[derive(Debug, Clone)]
pub struct NativeBudgetPolicy {
    pub(super) record: PolicyRecord,
}
impl NativeBudgetPolicy {
    pub fn from_native_config(definition: NativeBudgetPolicyDefinition) -> Result<Self> {
        let record = PolicyRecord {
            id: definition.id,
            version: definition.version,
            revision: definition.revision,
            scope: definition.scope,
            window: definition.window,
            limits: definition.limits,
            currency: definition.currency,
            subscription_window_accounting: false,
        };
        record.validate()?;
        Ok(Self { record })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PolicyRecord {
    pub id: String,
    pub version: u64,
    pub revision: String,
    pub scope: BudgetScope,
    pub window: BudgetWindow,
    pub limits: BudgetLimits,
    pub currency: Option<String>,
    /// Only the native subscription installer enables accounting over pre-existing calls.
    #[serde(default, skip_serializing_if = "is_false")]
    pub subscription_window_accounting: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
impl PolicyRecord {
    pub fn validate(&self) -> Result<()> {
        label(&self.id)?;
        label(&self.revision)?;
        label(&self.window.id)?;
        ensure!(
            self.version > 0 && self.window.starts_at_ms < self.window.ends_at_ms,
            "BUDGET_POLICY_INVALID"
        );
        ensure!(
            !self.subscription_window_accounting
                || matches!(self.scope, BudgetScope::Subscription(_)),
            "BUDGET_POLICY_INVALID"
        );
        match &self.scope {
            BudgetScope::Organization(id)
            | BudgetScope::Account(id)
            | BudgetScope::Workspace(id)
            | BudgetScope::Task(id)
            | BudgetScope::Subscription(id) => label(id)?,
        }
        ensure!(
            self.limits.cost_micros.is_none() || self.currency.is_some(),
            "BUDGET_CURRENCY_REQUIRED"
        );
        if let Some(currency) = &self.currency {
            ensure!(
                !currency.is_empty()
                    && currency.len() <= 16
                    && currency.bytes().all(|c| c.is_ascii_uppercase()),
                "BUDGET_CURRENCY_INVALID"
            )
        }
        Ok(())
    }
    pub fn key(&self) -> Result<String> {
        digest(&("budget-window-v1", &self.id, &self.scope, &self.window.id))
    }
    pub fn family(&self) -> Result<String> {
        digest(&("budget-family-v1", &self.id, &self.scope))
    }
}
#[derive(Debug, Clone)]
pub struct NativeBudgetPrincipal {
    pub(super) record: PrincipalRecord,
}
impl NativeBudgetPrincipal {
    pub fn from_native_facts(
        account_id: String,
        organization_id: Option<String>,
        workspace_id: Option<String>,
        subscription_id: Option<String>,
    ) -> Result<Self> {
        let record = PrincipalRecord {
            account_id,
            organization_id,
            workspace_id,
            subscription_id,
        };
        record.validate()?;
        Ok(Self { record })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PrincipalRecord {
    account_id: String,
    organization_id: Option<String>,
    workspace_id: Option<String>,
    subscription_id: Option<String>,
}
impl PrincipalRecord {
    fn validate(&self) -> Result<()> {
        label(&self.account_id)?;
        for value in [
            &self.organization_id,
            &self.workspace_id,
            &self.subscription_id,
        ]
        .into_iter()
        .flatten()
        {
            label(value)?
        }
        Ok(())
    }
    pub(super) fn applies(&self, scope: &BudgetScope, root_operation: &str) -> bool {
        match scope {
            BudgetScope::Organization(id) => self.organization_id.as_ref() == Some(id),
            BudgetScope::Account(id) => &self.account_id == id,
            BudgetScope::Workspace(id) => self.workspace_id.as_ref() == Some(id),
            BudgetScope::Task(id) => id == root_operation,
            BudgetScope::Subscription(id) => self.subscription_id.as_ref() == Some(id),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetActor {
    Main,
    ChildAgent,
    Observer,
    Verifier,
    Automation,
    Retry,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetUnit {
    TaskSlot,
    ModelCall,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetTaskLink {
    pub root_operation_id: String,
    pub root_task: Option<IntegrationEntityRef>,
    pub actor: BudgetActor,
    pub actor_attempt_id: String,
    pub parent_reservation_id: Option<String>,
}
/// A bound, conservative estimate. None monetary value is unknown, never zero.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetCharge {
    pub tokens: u64,
    pub model_calls: u64,
    pub run_millis: u64,
    pub cost_micros: Option<u64>,
}
impl BudgetCharge {
    pub fn zero() -> Self {
        Self {
            cost_micros: Some(0),
            ..Default::default()
        }
    }
    pub(super) fn covers(&self, other: &Self) -> bool {
        self.tokens >= other.tokens
            && self.model_calls >= other.model_calls
            && self.run_millis >= other.run_millis
            && match (self.cost_micros, other.cost_micros) {
                (Some(a), Some(b)) => a >= b,
                _ => true,
            }
    }
    pub(super) fn conservative(&self, other: &Self) -> Self {
        Self {
            tokens: self.tokens.max(other.tokens),
            model_calls: self.model_calls.max(other.model_calls),
            run_millis: self.run_millis.max(other.run_millis),
            cost_micros: self
                .cost_micros
                .map(|bound| bound.max(other.cost_micros.unwrap_or(0))),
        }
    }
}
#[derive(Debug, Clone)]
pub struct NativeBudgetRequest {
    pub reservation_id: String,
    pub operation_id: String,
    pub principal: NativeBudgetPrincipal,
    pub unit: BudgetUnit,
    pub task: BudgetTaskLink,
    pub estimate: BudgetCharge,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RequestRecord {
    pub reservation_id: String,
    pub operation_id: String,
    principal: PrincipalRecord,
    pub unit: BudgetUnit,
    pub task: BudgetTaskLink,
    pub estimate: BudgetCharge,
}
impl From<&NativeBudgetRequest> for RequestRecord {
    fn from(value: &NativeBudgetRequest) -> Self {
        Self {
            reservation_id: value.reservation_id.clone(),
            operation_id: value.operation_id.clone(),
            principal: value.principal.record.clone(),
            unit: value.unit,
            task: value.task.clone(),
            estimate: value.estimate.clone(),
        }
    }
}
impl RequestRecord {
    pub(super) fn matches_native_principal(&self, principal: &NativeBudgetPrincipal) -> bool {
        self.principal == principal.record
    }
    pub fn validate(&self) -> Result<()> {
        label(&self.reservation_id)?;
        label(&self.operation_id)?;
        label(&self.task.root_operation_id)?;
        label(&self.task.actor_attempt_id)?;
        self.principal.validate()?;
        if let Some(parent) = &self.task.parent_reservation_id {
            label(parent)?;
            ensure!(parent != &self.reservation_id, "BUDGET_PARENT_INVALID")
        }
        if let Some(task) = &self.task.root_task {
            native_task(task)?
        }
        if self.unit == BudgetUnit::ModelCall {
            ensure!(
                self.task.root_task.is_some() && self.estimate.model_calls >= 1,
                "BUDGET_CALL_BINDING_REQUIRED"
            )
        } else {
            ensure!(
                self.estimate == BudgetCharge::zero(),
                "BUDGET_TASK_SLOT_MUST_NOT_DOUBLE_CHARGE"
            )
        }
        if self.task.actor == BudgetActor::ChildAgent {
            ensure!(
                self.task.parent_reservation_id.is_some() && self.task.root_task.is_some(),
                "BUDGET_PARENT_REQUIRED"
            )
        }
        Ok(())
    }
    fn applies(&self, policy: &PolicyRecord) -> bool {
        self.principal
            .applies(&policy.scope, &self.task.root_operation_id)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetPhase {
    Reserved,
    Dispatched,
    Terminal,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetUsageCoverage {
    Complete,
    Partial,
    Unreported,
}
/// Constructed by the actual usage adapter, not decoded as an authority token.
#[derive(Debug, Clone)]
pub struct NativeBudgetUsage {
    pub coverage: BudgetUsageCoverage,
    pub known: BudgetCharge,
}
#[derive(Debug, Clone)]
pub struct NativeBudgetTaskBinding {
    root_operation_id: String,
    task: IntegrationEntityRef,
    receipt_id: String,
    receipt_sha256: String,
}
impl NativeBudgetTaskBinding {
    pub(super) fn matches_task_slot(&self, receipt: &BudgetReservationReceipt) -> bool {
        receipt.unit == BudgetUnit::TaskSlot
            && receipt.task.root_operation_id == self.root_operation_id
            && receipt.task.root_task.as_ref() == Some(&self.task)
            && receipt.phase != BudgetPhase::Terminal
            && !receipt.execution_confirmed_terminal
    }
    pub fn from_authoritative_receipt(
        root_operation_id: String,
        task: IntegrationEntityRef,
        receipt_id: String,
        receipt_sha256: String,
    ) -> Result<Self> {
        label(&root_operation_id)?;
        native_task(&task)?;
        label(&receipt_id)?;
        ensure!(
            receipt_sha256.len() == 64 && receipt_sha256.bytes().all(|c| c.is_ascii_hexdigit()),
            "BUDGET_TASK_BINDING_INVALID"
        );
        Ok(Self {
            root_operation_id,
            task,
            receipt_id,
            receipt_sha256,
        })
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetTerminalKind {
    Completed,
    Failed,
    Cancelled,
    VerifiedNotStarted,
}
#[derive(Debug, Clone)]
pub struct NativeBudgetTerminal {
    pub(super) record: TerminalRecord,
}
impl NativeBudgetTerminal {
    /// Host must validate the exact original native receipt before construction.
    pub fn from_authoritative_receipt(
        operation_id: String,
        task: Option<IntegrationEntityRef>,
        actor_attempt_id: String,
        receipt_id: String,
        receipt_sha256: String,
        kind: BudgetTerminalKind,
    ) -> Result<Self> {
        let record = TerminalRecord {
            operation_id,
            task,
            actor_attempt_id,
            receipt_id,
            receipt_sha256,
            kind,
        };
        record.validate()?;
        Ok(Self { record })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TerminalRecord {
    operation_id: String,
    task: Option<IntegrationEntityRef>,
    actor_attempt_id: String,
    receipt_id: String,
    receipt_sha256: String,
    kind: BudgetTerminalKind,
}
impl TerminalRecord {
    fn validate(&self) -> Result<()> {
        label(&self.operation_id)?;
        label(&self.actor_attempt_id)?;
        label(&self.receipt_id)?;
        ensure!(
            self.receipt_sha256.len() == 64
                && self.receipt_sha256.bytes().all(|c| c.is_ascii_hexdigit()),
            "BUDGET_TERMINAL_INVALID"
        );
        if let Some(task) = &self.task {
            native_task(task)?
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetPolicyReference {
    pub id: String,
    pub version: u64,
    pub revision: String,
    pub window: BudgetWindow,
    pub scope: BudgetScope,
}
impl From<&PolicyRecord> for BudgetPolicyReference {
    fn from(value: &PolicyRecord) -> Self {
        Self {
            id: value.id.clone(),
            version: value.version,
            revision: value.revision.clone(),
            window: value.window.clone(),
            scope: value.scope.clone(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetReservationReceipt {
    pub reservation_id: String,
    pub operation_id: String,
    pub revision: u64,
    pub unit: BudgetUnit,
    pub task: BudgetTaskLink,
    pub phase: BudgetPhase,
    pub estimate: BudgetCharge,
    pub known_usage: BudgetCharge,
    pub charged: BudgetCharge,
    pub coverage: BudgetUsageCoverage,
    pub execution_confirmed_terminal: bool,
    pub cost_known: bool,
    pub policy_refs: Vec<BudgetPolicyReference>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetReservationResult {
    Created(BudgetReservationReceipt),
    Existing(BudgetReservationReceipt),
}
impl BudgetReservationResult {
    pub fn receipt(&self) -> &BudgetReservationReceipt {
        match self {
            Self::Created(value) | Self::Existing(value) => value,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BudgetDispatchResult {
    Fresh(BudgetReservationReceipt),
    AlreadyDispatched(BudgetReservationReceipt),
    Terminal(BudgetReservationReceipt),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetWindowObservation {
    pub policy: BudgetPolicyReference,
    pub limits: BudgetLimits,
    pub currency: Option<String>,
    pub charged: BudgetCharge,
    pub unknown_cost_reservations: u32,
    pub active_tasks: u32,
    pub active_calls: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReservationRecord {
    pub request: RequestRecord,
    pub intent: String,
    pub policies: Vec<PolicyRecord>,
    pub receipt: BudgetReservationReceipt,
    terminal: Option<TerminalRecord>,
    updates: BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ledger {
    pub version: u32,
    pub owner: IntegrationOwner,
    pub revision: u64,
    pub windows: BTreeMap<String, PolicyRecord>,
    pub reservations: BTreeMap<String, ReservationRecord>,
}
impl Ledger {
    pub fn empty(owner: IntegrationOwner) -> Self {
        Self {
            version: 1,
            owner,
            revision: 1,
            windows: BTreeMap::new(),
            reservations: BTreeMap::new(),
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && self.revision > 0
                && self.windows.len() <= MAX_WINDOWS
                && self.reservations.len() <= MAX_RESERVATIONS,
            "BUDGET_LEDGER_CORRUPT"
        );
        for (key, policy) in &self.windows {
            policy.validate()?;
            ensure!(policy.key()? == *key, "BUDGET_LEDGER_CORRUPT");
        }
        for (id, value) in &self.reservations {
            value.request.validate()?;
            ensure!(
                id == &value.request.reservation_id
                    && id == &value.receipt.reservation_id
                    && value.receipt.operation_id == value.request.operation_id
                    && value.receipt.unit == value.request.unit
                    && value.receipt.estimate == value.request.estimate
                    && value.receipt.task.root_operation_id == value.request.task.root_operation_id
                    && value.receipt.task.actor == value.request.task.actor
                    && value.receipt.task.actor_attempt_id == value.request.task.actor_attempt_id
                    && value.receipt.task.parent_reservation_id
                        == value.request.task.parent_reservation_id
                    && value
                        .request
                        .task
                        .root_task
                        .as_ref()
                        .is_none_or(|task| value.receipt.task.root_task.as_ref() == Some(task))
                    && value.receipt.policy_refs
                        == value
                            .policies
                            .iter()
                            .map(BudgetPolicyReference::from)
                            .collect::<Vec<_>>()
                    && value.receipt.execution_confirmed_terminal == value.terminal.is_some()
                    && (value.receipt.phase == BudgetPhase::Terminal) == value.terminal.is_some()
                    && value.receipt.updated_at_ms >= value.receipt.created_at_ms
                    && value.receipt.revision > 0
                    && value.policies.len() <= 16
                    && !value.policies.is_empty()
                    && value.updates.len() <= 64,
                "BUDGET_LEDGER_CORRUPT"
            );
            ensure!(
                value.intent == digest(&(&value.request, &value.policies))?,
                "BUDGET_INTENT_CHANGED"
            );
            if !value.receipt.execution_confirmed_terminal {
                ensure!(
                    value.receipt.charged.covers(&value.request.estimate)
                        && value.receipt.charged.covers(&value.receipt.known_usage),
                    "BUDGET_UNCONFIRMED_HOLD_LOST"
                );
            }
            for policy in &value.policies {
                policy.validate()?;
                let recorded = self
                    .windows
                    .get(&policy.key()?)
                    .context("BUDGET_LEDGER_CORRUPT")?;
                ensure!(
                    recorded.window == policy.window && recorded.currency == policy.currency,
                    "BUDGET_LEDGER_CORRUPT"
                );
            }
            if let Some(task) = &value.receipt.task.root_task {
                native_task(task)?;
            }
            if let Some(terminal) = &value.terminal {
                terminal.validate()?;
                ensure!(
                    terminal.operation_id == value.request.operation_id
                        && terminal.task == value.receipt.task.root_task
                        && terminal.actor_attempt_id == value.request.task.actor_attempt_id,
                    "BUDGET_TERMINAL_MISMATCH"
                );
            }
        }
        Ok(())
    }
    pub fn reserve(
        &mut self,
        request: &NativeBudgetRequest,
        policies: &[NativeBudgetPolicy],
        now: u64,
    ) -> Result<BudgetReservationResult> {
        let request = RequestRecord::from(request);
        request.validate()?;
        ensure!(
            !policies.is_empty() && policies.len() <= 16,
            "BUDGET_NATIVE_POLICIES_REQUIRED"
        );
        let mut keyed = policies
            .iter()
            .map(|policy| Ok((policy.record.key()?, policy.record.clone())))
            .collect::<Result<Vec<_>>>()?;
        keyed.sort_by(|a, b| a.0.cmp(&b.0));
        let policies = keyed
            .into_iter()
            .map(|(_, policy)| policy)
            .collect::<Vec<_>>();
        let intent = digest(&(&request, &policies))?;
        if let Some(previous) = self.reservations.get(&request.reservation_id) {
            ensure!(previous.intent == intent, "BUDGET_RESERVATION_CONFLICT");
            return Ok(BudgetReservationResult::Existing(previous.receipt.clone()));
        }
        ensure!(
            self.reservations.len() < MAX_RESERVATIONS,
            "BUDGET_RESERVATION_CAPACITY"
        );
        if let Some(parent) = &request.task.parent_reservation_id {
            let parent = self
                .reservations
                .get(parent)
                .context("BUDGET_PARENT_MISSING")?;
            ensure!(
                parent.receipt.task.root_operation_id == request.task.root_operation_id
                    && parent.receipt.task.root_task == request.task.root_task,
                "BUDGET_PARENT_MISMATCH"
            );
        }
        let currencies = policies
            .iter()
            .filter_map(|policy| policy.currency.as_ref())
            .collect::<std::collections::BTreeSet<_>>();
        ensure!(
            request.unit == BudgetUnit::TaskSlot || currencies.len() <= 1,
            "BUDGET_CURRENCY_MISMATCH"
        );
        ensure!(
            request.unit == BudgetUnit::TaskSlot
                || request.estimate.cost_micros.is_none_or(|cost| cost == 0)
                || !currencies.is_empty(),
            "BUDGET_CURRENCY_REQUIRED"
        );
        let mut keys = std::collections::BTreeSet::new();
        let mut families = std::collections::BTreeSet::new();
        for policy in &policies {
            policy.validate()?;
            ensure!(
                families.insert(policy.family()?),
                "BUDGET_POLICY_FAMILY_DUPLICATE"
            );
            ensure!(
                policy.version >= self.family_version(policy)?,
                "BUDGET_POLICY_STALE"
            );
            ensure!(request.applies(policy), "BUDGET_POLICY_SCOPE_MISMATCH");
            ensure!(
                now >= policy.window.starts_at_ms && now < policy.window.ends_at_ms,
                "BUDGET_WINDOW_NOT_CURRENT"
            );
            let key = policy.key()?;
            ensure!(keys.insert(key.clone()), "BUDGET_POLICY_DUPLICATE");
            if let Some(old) = self.windows.get(&key) {
                ensure!(
                    old.window == policy.window
                        && old.currency == policy.currency
                        && old.subscription_window_accounting
                            == policy.subscription_window_accounting,
                    "BUDGET_WINDOW_IMMUTABLE"
                );
                ensure!(policy.version >= old.version, "BUDGET_POLICY_STALE");
                if policy.version == old.version {
                    ensure!(old == policy, "BUDGET_POLICY_REVISION_CONFLICT")
                }
            }
            let used = self.observation(policy)?;
            check_limit(
                used.charged.tokens,
                request.estimate.tokens,
                policy.limits.tokens,
            )?;
            check_limit(
                used.charged.model_calls,
                request.estimate.model_calls,
                policy.limits.model_calls,
            )?;
            check_limit(
                used.charged.run_millis,
                request.estimate.run_millis,
                policy.limits.run_millis,
            )?;
            if let Some(limit) = policy.limits.cost_micros {
                check_limit(
                    used.charged.cost_micros.context("BUDGET_COST_UNKNOWN")?,
                    request
                        .estimate
                        .cost_micros
                        .context("BUDGET_COST_UNKNOWN")?,
                    Some(limit),
                )?;
            }
            if request.unit == BudgetUnit::TaskSlot {
                check_limit(
                    u64::from(used.active_tasks),
                    1,
                    policy.limits.concurrent_tasks.map(u64::from),
                )?
            } else {
                check_limit(
                    u64::from(used.active_calls),
                    1,
                    policy.limits.concurrent_calls.map(u64::from),
                )?
            }
        }
        ensure!(
            self.windows.len()
                + keys
                    .iter()
                    .filter(|key| !self.windows.contains_key(*key))
                    .count()
                <= MAX_WINDOWS,
            "BUDGET_WINDOW_CAPACITY"
        );
        for policy in &policies {
            self.windows.insert(policy.key()?, policy.clone());
        }
        let receipt = BudgetReservationReceipt {
            reservation_id: request.reservation_id.clone(),
            operation_id: request.operation_id.clone(),
            revision: 1,
            unit: request.unit,
            task: request.task.clone(),
            phase: BudgetPhase::Reserved,
            estimate: request.estimate.clone(),
            known_usage: if request.unit == BudgetUnit::TaskSlot {
                BudgetCharge::zero()
            } else {
                BudgetCharge::default()
            },
            charged: request.estimate.clone(),
            coverage: BudgetUsageCoverage::Unreported,
            execution_confirmed_terminal: false,
            cost_known: request.unit == BudgetUnit::TaskSlot,
            policy_refs: policies.iter().map(BudgetPolicyReference::from).collect(),
            created_at_ms: now,
            updated_at_ms: now,
        };
        self.reservations.insert(
            request.reservation_id.clone(),
            ReservationRecord {
                request,
                intent,
                policies,
                receipt: receipt.clone(),
                terminal: None,
                updates: BTreeMap::new(),
            },
        );
        self.bump()?;
        Ok(BudgetReservationResult::Created(receipt))
    }
    pub fn observation(&self, policy: &PolicyRecord) -> Result<BudgetWindowObservation> {
        let key = policy.key()?;
        let family = policy.family()?;
        let mut out = BudgetWindowObservation {
            policy: BudgetPolicyReference::from(policy),
            limits: policy.limits.clone(),
            currency: policy.currency.clone(),
            charged: BudgetCharge::zero(),
            unknown_cost_reservations: 0,
            active_tasks: 0,
            active_calls: 0,
        };
        for reservation in self.reservations.values() {
            let mut same_family = false;
            let mut same_window = false;
            for item in &reservation.policies {
                same_family |= item.family()? == family;
                same_window |= item.key()? == key;
            }
            if policy.subscription_window_accounting
                && reservation
                    .request
                    .principal
                    .applies(&policy.scope, &reservation.request.task.root_operation_id)
            {
                same_family = true;
                same_window |= reservation.receipt.created_at_ms >= policy.window.starts_at_ms
                    && reservation.receipt.created_at_ms < policy.window.ends_at_ms;
            }
            if same_family && !reservation.receipt.execution_confirmed_terminal {
                match reservation.request.unit {
                    BudgetUnit::TaskSlot => {
                        out.active_tasks =
                            out.active_tasks.checked_add(1).context("BUDGET_OVERFLOW")?
                    }
                    BudgetUnit::ModelCall => {
                        out.active_calls =
                            out.active_calls.checked_add(1).context("BUDGET_OVERFLOW")?
                    }
                }
            }
            if same_window {
                let charge = &reservation.receipt.charged;
                out.charged.tokens = add(out.charged.tokens, charge.tokens)?;
                out.charged.model_calls = add(out.charged.model_calls, charge.model_calls)?;
                out.charged.run_millis = add(out.charged.run_millis, charge.run_millis)?;
                match (out.charged.cost_micros, charge.cost_micros) {
                    (Some(total), Some(value)) => {
                        out.charged.cost_micros = Some(add(total, value)?)
                    }
                    _ => out.charged.cost_micros = None,
                }
                if reservation.request.unit == BudgetUnit::ModelCall
                    && !reservation.receipt.cost_known
                {
                    out.unknown_cost_reservations = out
                        .unknown_cost_reservations
                        .checked_add(1)
                        .context("BUDGET_OVERFLOW")?;
                }
            }
        }
        Ok(out)
    }
    pub fn install_policies(&mut self, policies: &[NativeBudgetPolicy]) -> Result<()> {
        ensure!(
            !policies.is_empty() && policies.len() <= 16,
            "BUDGET_NATIVE_POLICIES_REQUIRED"
        );
        let mut changed = false;
        let mut keys = std::collections::BTreeSet::new();
        let mut families = std::collections::BTreeSet::new();
        for policy in policies {
            let policy = &policy.record;
            policy.validate()?;
            ensure!(
                families.insert(policy.family()?),
                "BUDGET_POLICY_FAMILY_DUPLICATE"
            );
            ensure!(
                policy.version >= self.family_version(policy)?,
                "BUDGET_POLICY_STALE"
            );
            let key = policy.key()?;
            ensure!(keys.insert(key.clone()), "BUDGET_POLICY_DUPLICATE");
            if let Some(old) = self.windows.get(&key) {
                ensure!(
                    old.window == policy.window
                        && old.currency == policy.currency
                        && old.subscription_window_accounting
                            == policy.subscription_window_accounting,
                    "BUDGET_WINDOW_IMMUTABLE"
                );
                ensure!(policy.version >= old.version, "BUDGET_POLICY_STALE");
                if old.version == policy.version {
                    ensure!(old == policy, "BUDGET_POLICY_REVISION_CONFLICT");
                    continue;
                }
            }
            self.windows.insert(key, policy.clone());
            changed = true;
        }
        ensure!(self.windows.len() <= MAX_WINDOWS, "BUDGET_WINDOW_CAPACITY");
        if changed {
            self.bump()?;
        }
        Ok(())
    }
    pub fn bind_task(
        &mut self,
        id: &str,
        expected: u64,
        binding: &NativeBudgetTaskBinding,
        now: u64,
    ) -> Result<BudgetReservationReceipt> {
        let value = self
            .reservations
            .get_mut(id)
            .context("BUDGET_RESERVATION_MISSING")?;
        ensure!(
            binding.root_operation_id == value.request.task.root_operation_id,
            "BUDGET_TASK_BINDING_MISMATCH"
        );
        if let Some(task) = &value.receipt.task.root_task {
            ensure!(task == &binding.task, "BUDGET_TASK_BINDING_IMMUTABLE");
            return Ok(value.receipt.clone());
        }
        ensure!(
            value.receipt.revision == expected && value.receipt.phase != BudgetPhase::Terminal,
            "BUDGET_REVISION_CONFLICT"
        );
        value.receipt.task.root_task = Some(binding.task.clone());
        let proof = digest(&(
            &binding.root_operation_id,
            &binding.task,
            &binding.receipt_id,
            &binding.receipt_sha256,
        ))?;
        value.updates.insert("native-task-binding".into(), proof);
        bump_receipt(&mut value.receipt, now)?;
        let result = value.receipt.clone();
        self.bump()?;
        Ok(result)
    }
    pub fn dispatch(
        &mut self,
        id: &str,
        expected: u64,
        policies: &[NativeBudgetPolicy],
        now: u64,
    ) -> Result<BudgetDispatchResult> {
        let frozen = self
            .reservations
            .get(id)
            .context("BUDGET_RESERVATION_MISSING")?;
        if frozen.receipt.phase == BudgetPhase::Reserved {
            for policy in &frozen.policies {
                ensure!(
                    policy.version >= self.family_version(policy)?,
                    "BUDGET_POLICY_STALE"
                );
            }
        }
        let value = self
            .reservations
            .get_mut(id)
            .context("BUDGET_RESERVATION_MISSING")?;
        if value.receipt.phase == BudgetPhase::Terminal {
            return Ok(BudgetDispatchResult::Terminal(value.receipt.clone()));
        }
        if value.receipt.phase == BudgetPhase::Dispatched {
            return Ok(BudgetDispatchResult::AlreadyDispatched(
                value.receipt.clone(),
            ));
        }
        ensure!(
            value.receipt.revision == expected,
            "BUDGET_REVISION_CONFLICT"
        );
        ensure!(
            value.receipt.task.root_task.is_some(),
            "BUDGET_NATIVE_TASK_REQUIRED"
        );
        ensure!(
            policies.len() == value.policies.len(),
            "BUDGET_POLICY_SET_CHANGED"
        );
        for frozen in &value.policies {
            ensure!(
                policies.iter().any(|current| &current.record == frozen),
                "BUDGET_POLICY_SET_CHANGED"
            );
            let current = self
                .windows
                .get(&frozen.key()?)
                .context("BUDGET_WINDOW_MISSING")?;
            ensure!(
                current == frozen
                    && now >= frozen.window.starts_at_ms
                    && now < frozen.window.ends_at_ms,
                "BUDGET_POLICY_STALE"
            );
        }
        value.receipt.phase = BudgetPhase::Dispatched;
        bump_receipt(&mut value.receipt, now)?;
        let result = value.receipt.clone();
        self.bump()?;
        Ok(BudgetDispatchResult::Fresh(result))
    }
    pub fn usage(
        &mut self,
        id: &str,
        expected: u64,
        update_id: &str,
        report: &NativeBudgetUsage,
        terminal: Option<&NativeBudgetTerminal>,
        now: u64,
    ) -> Result<BudgetReservationReceipt> {
        label(update_id)?;
        let update_digest = digest(&(
            report.coverage,
            &report.known,
            terminal.map(|value| &value.record),
        ))?;
        let value = self
            .reservations
            .get_mut(id)
            .context("BUDGET_RESERVATION_MISSING")?;
        if let Some(previous) = value.updates.get(update_id) {
            ensure!(previous == &update_digest, "BUDGET_USAGE_UPDATE_CONFLICT");
            return Ok(value.receipt.clone());
        }
        ensure!(
            value.receipt.revision == expected,
            "BUDGET_REVISION_CONFLICT"
        );
        ensure!(value.updates.len() < 64, "BUDGET_UPDATE_CAPACITY");
        if let Some(terminal) = terminal {
            terminal.record.validate()?;
            ensure!(
                terminal.record.operation_id == value.request.operation_id
                    && terminal.record.task == value.receipt.task.root_task
                    && terminal.record.actor_attempt_id == value.request.task.actor_attempt_id,
                "BUDGET_TERMINAL_MISMATCH"
            );
            if let Some(original) = &value.terminal {
                ensure!(original == &terminal.record, "BUDGET_TERMINAL_IMMUTABLE");
            }
            if terminal.record.kind == BudgetTerminalKind::VerifiedNotStarted {
                ensure!(
                    report.coverage == BudgetUsageCoverage::Complete
                        && report.known == BudgetCharge::zero(),
                    "BUDGET_NOT_STARTED_PROOF_CONTRADICTED"
                );
            }
            value.terminal = Some(terminal.record.clone());
        }
        if value.request.unit == BudgetUnit::TaskSlot {
            ensure!(
                report.known == BudgetCharge::zero(),
                "BUDGET_TASK_SLOT_MUST_NOT_DOUBLE_CHARGE"
            );
        }
        if value.request.unit == BudgetUnit::ModelCall
            && report.coverage == BudgetUsageCoverage::Complete
            && terminal
                .is_none_or(|proof| proof.record.kind != BudgetTerminalKind::VerifiedNotStarted)
        {
            ensure!(
                report.known.model_calls >= 1,
                "BUDGET_COMPLETE_CALL_COUNT_REQUIRED"
            );
        }
        if report.coverage == BudgetUsageCoverage::Complete {
            ensure!(
                report.known.covers(&value.receipt.known_usage),
                "BUDGET_USAGE_CONTRADICTION"
            );
        }
        let old_known = &value.receipt.known_usage;
        value.receipt.known_usage = BudgetCharge {
            tokens: old_known.tokens.max(report.known.tokens),
            model_calls: old_known.model_calls.max(report.known.model_calls),
            run_millis: old_known.run_millis.max(report.known.run_millis),
            cost_micros: match (old_known.cost_micros, report.known.cost_micros) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, None) => a,
                (None, b) => b,
            },
        };
        let confirmed = value.terminal.is_some();
        value.receipt.execution_confirmed_terminal = confirmed;
        if confirmed && report.coverage == BudgetUsageCoverage::Complete {
            let cost = report
                .known
                .cost_micros
                .or(value.receipt.charged.cost_micros);
            value.receipt.charged = BudgetCharge {
                cost_micros: cost,
                ..report.known.clone()
            };
        } else {
            value.receipt.charged = value.receipt.charged.conservative(&report.known);
        }
        value.receipt.coverage = match (value.receipt.coverage, report.coverage) {
            (BudgetUsageCoverage::Complete, _) | (_, BudgetUsageCoverage::Complete) => {
                BudgetUsageCoverage::Complete
            }
            (BudgetUsageCoverage::Partial, _) | (_, BudgetUsageCoverage::Partial) => {
                BudgetUsageCoverage::Partial
            }
            _ => BudgetUsageCoverage::Unreported,
        };
        value.receipt.cost_known |= value.request.unit == BudgetUnit::TaskSlot
            || (report.coverage == BudgetUsageCoverage::Complete
                && report.known.cost_micros.is_some());
        if confirmed {
            value.receipt.phase = BudgetPhase::Terminal;
        } else {
            // Any execution observation defeats "fresh admission". A missing
            // usage report is never permission to start the original call again.
            value.receipt.phase = BudgetPhase::Dispatched;
        }
        value.updates.insert(update_id.into(), update_digest);
        bump_receipt(&mut value.receipt, now)?;
        let result = value.receipt.clone();
        self.bump()?;
        Ok(result)
    }
    fn bump(&mut self) -> Result<()> {
        self.revision = self.revision.checked_add(1).context("BUDGET_OVERFLOW")?;
        Ok(())
    }
    fn family_version(&self, policy: &PolicyRecord) -> Result<u64> {
        let family = policy.family()?;
        let mut version = 0;
        for recorded in self.windows.values() {
            if recorded.family()? == family {
                version = version.max(recorded.version);
            }
        }
        Ok(version)
    }
}
fn bump_receipt(receipt: &mut BudgetReservationReceipt, now: u64) -> Result<()> {
    receipt.revision = receipt.revision.checked_add(1).context("BUDGET_OVERFLOW")?;
    receipt.updated_at_ms = receipt.updated_at_ms.max(now);
    Ok(())
}
fn check_limit(used: u64, additional: u64, limit: Option<u64>) -> Result<()> {
    let total = add(used, additional)?;
    ensure!(limit.is_none_or(|limit| total <= limit), "BUDGET_EXHAUSTED");
    Ok(())
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).context("BUDGET_OVERFLOW")
}
pub(super) fn label(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        "BUDGET_ID_INVALID"
    );
    Ok(())
}
pub(super) fn digest(value: &impl Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
pub(super) fn native_task(task: &IntegrationEntityRef) -> Result<()> {
    label(&task.id)?;
    ensure!(
        matches!(
            task.kind,
            IntegrationEntityKind::Task | IntegrationEntityKind::Turn
        ),
        "BUDGET_NATIVE_TASK_INVALID"
    );
    Ok(())
}
