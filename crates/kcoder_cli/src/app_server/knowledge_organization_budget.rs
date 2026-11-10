//! Wiki claims use the same root-owned budget ledger as ordinary Engine calls.
use super::{
    knowledge_model::ProviderWikiModel, knowledge_model_admission::WikiRequestAdmission,
    knowledge_worker_authority::WikiJobAuthority,
};
use anyhow::{Context, Result, ensure};
use kcoder_api::model_budget_input::{
    effective_output_limit, reservation_input, validate_model_input,
};
use kcoder_api::native_model_request::{
    NativeModelRequestEnd, NativeModelRequestError, NativeModelRequestLease,
    NativeModelRequestSettlement,
};
use kcoder_state::integrations::core::budgets::{
    BudgetCharge, BudgetPhase, BudgetReservationReceipt, BudgetUsageCoverage,
};
use kcoder_types::{MessagesRequest, ModelConfigurationSummary, Usage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

pub(super) struct WikiOrganizationBudget {
    operation: String,
    slot: String,
    receipt: Mutex<Option<BudgetReservationReceipt>>,
}
pub(super) struct WikiCallAdmission<'a> {
    budget: &'a WikiOrganizationBudget,
    authority: &'a WikiJobAuthority<'a>,
    reservation: String,
}
struct WikiCallLease<'a> {
    admission: &'a WikiCallAdmission<'a>,
    receipt: BudgetReservationReceipt,
    model: ModelConfigurationSummary,
    endpoint: String,
    usage: Option<Usage>,
    updates: u64,
    started: Instant,
    deadline: Instant,
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn receipt(value: Value) -> Result<BudgetReservationReceipt> {
    serde_json::from_value(value).context("WIKI_ORGANIZATION_BUDGET_RECEIPT_INVALID")
}
impl WikiOrganizationBudget {
    pub(super) fn new(authority: &WikiJobAuthority<'_>) -> Result<Self> {
        authority.check_current()?;
        let claim = authority.claim_fingerprint();
        Ok(Self {
            operation: format!("org-wiki-{claim}"),
            slot: format!("wiki-slot-{claim}"),
            receipt: Mutex::new(None),
        })
    }

    pub(super) fn admission<'a>(
        &'a self,
        authority: &'a WikiJobAuthority<'a>,
        local_reservation: &kcoder_knowledge::WikiBudgetReservation,
    ) -> Result<WikiCallAdmission<'a>> {
        authority.check_current()?;
        Ok(WikiCallAdmission {
            budget: self,
            authority,
            reservation: format!(
                "wiki-call-{}",
                digest(&(authority.claim_fingerprint(), local_reservation.id()))?
            ),
        })
    }

    fn ensure_slot(&self, authority: &WikiJobAuthority<'_>) -> Result<()> {
        authority.check_current()?;
        let mut current = self
            .receipt
            .lock()
            .map_err(|_| anyhow::anyhow!("WIKI_ORGANIZATION_TASK_UNAVAILABLE"))?;
        if current.is_none() {
            let reserved = receipt(authority.context().organization_budget_request(&self.operation, json!({
                "kind":"reserve", "reservation_id":self.slot, "operation_id":self.operation, "unit":"task_slot",
                "task":{"rootOperationId":self.operation, "rootTask":{"kind":"task", "id":authority.job().id, "revision":null},
                    "actor":"observer", "actorAttemptId":authority.claim_fingerprint(), "parentReservationId":null},
                "estimate":BudgetCharge::zero()
            }))?)?;
            let active = if reserved.phase == BudgetPhase::Reserved {
                receipt(authority.context().organization_budget_request(&self.operation, json!({
                    "kind":"dispatch", "reservation_id":self.slot, "expected_revision":reserved.revision
                }))?)?
            } else {
                reserved
            };
            ensure!(
                !active.execution_confirmed_terminal,
                "WIKI_ORGANIZATION_TASK_ALREADY_TERMINAL"
            );
            *current = Some(active);
        }
        let active = receipt(authority.context().organization_budget_request(
            &self.operation,
            json!({
                "kind":"check", "reservation_id":self.slot
            }),
        )?)?;
        ensure!(
            !active.execution_confirmed_terminal,
            "WIKI_ORGANIZATION_TASK_ALREADY_TERMINAL"
        );
        Ok(())
    }

    /// Reconcile only this actual held claim. Unknown model calls keep the
    /// original slot and estimates; worker exit alone cannot free capacity.
    pub(super) fn reconcile_terminal(&self, authority: &WikiJobAuthority<'_>) -> Result<()> {
        authority.check_original_claim()?;
        if self
            .receipt
            .lock()
            .map_err(|_| anyhow::anyhow!("WIKI_ORGANIZATION_TASK_UNAVAILABLE"))?
            .is_none()
        {
            return Ok(());
        }
        let Some(status) = authority.terminal_status()? else {
            return Ok(());
        };
        let closed = authority.context().organization_budget_request(
            &self.operation,
            json!({
                "kind":"calls_closed", "reservation_id":self.slot
            }),
        )?;
        if closed["closed"] != true {
            return Ok(());
        }
        let current = receipt(authority.context().organization_budget_request(
            &self.operation,
            json!({
                "kind":"read", "reservation_id":self.slot
            }),
        )?)?;
        if current.execution_confirmed_terminal {
            return Ok(());
        }
        authority.context().organization_budget_request(&self.operation, json!({
            "kind":"observe", "reservation_id":self.slot, "expected_revision":current.revision,
            "update_id":"original-wiki-claim-terminal", "coverage":"complete", "usage":BudgetCharge::zero(),
            "terminal":{"receiptId":authority.ticket_receipt_id(),
                "receiptSha256":digest(&(authority.ticket_sha256(), authority.claim_fingerprint(), status))?, "kind":"completed"}
        }))?;
        Ok(())
    }
}

impl WikiRequestAdmission for WikiCallAdmission<'_> {
    fn reserve(
        &self,
        provider: &ProviderWikiModel,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease + '_>> {
        self.authority.check_current()?;
        let model = provider
            .configuration
            .as_ref()
            .context("WIKI_ORGANIZATION_MODEL_CONFIGURATION_REQUIRED")?
            .clone();
        validate_model_input(&model)?;
        let endpoint = provider
            .provider
            .endpoint()
            .context("WIKI_ORGANIZATION_MODEL_ENDPOINT_REQUIRED")?
            .to_owned();
        self.authority.context().authorize_organization_model(
            &model,
            &endpoint,
            &self.reservation,
        )?;
        let input = reservation_input(request)?;
        let output = u64::from(effective_output_limit(&model, request)?);
        let maximum = provider
            .provider
            .request_timeout_secs()
            .filter(|seconds| *seconds > 0)
            .and_then(|seconds| seconds.checked_mul(1000))
            .context("WIKI_ORGANIZATION_RUNTIME_BOUND_REQUIRED")?;
        self.budget.ensure_slot(self.authority)?;
        let started = Instant::now();
        let reserved = receipt(self.authority.context().organization_budget_request(&self.budget.operation, json!({
            "kind":"reserve", "reservation_id":self.reservation, "operation_id":self.reservation, "unit":"model_call",
            "task":{"rootOperationId":self.budget.operation, "rootTask":{"kind":"task", "id":self.authority.job().id, "revision":null},
                "actor":"observer", "actorAttemptId":self.reservation, "parentReservationId":self.budget.slot},
            "parent":{"receiptId":self.authority.ticket_receipt_id(), "receiptSha256":self.authority.ticket_sha256()},
            "estimate":{"tokens":input.checked_add(output).context("WIKI_ORGANIZATION_BUDGET_OVERFLOW")?, "modelCalls":1, "runMillis":maximum, "costMicros":null}
        }))?)?;
        // A reused local reservation cannot resend a previously dispatched
        // Provider call, even when its old receipt or usage was lost.
        ensure!(
            reserved.phase == BudgetPhase::Reserved,
            "WIKI_ORGANIZATION_MODEL_ALREADY_DISPATCHED"
        );
        self.authority.check_current()?;
        let dispatched = receipt(self.authority.context().organization_budget_request(&self.budget.operation, json!({
            "kind":"dispatch", "reservation_id":self.reservation, "expected_revision":reserved.revision
        }))?)?;
        let now: u64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
            .try_into()?;
        let remaining = dispatched
            .policy_refs
            .iter()
            .map(|policy| policy.window.ends_at_ms.saturating_sub(now))
            .min()
            .context("WIKI_ORGANIZATION_BUDGET_WINDOW_REQUIRED")?;
        ensure!(remaining > 0, "WIKI_ORGANIZATION_BUDGET_WINDOW_EXPIRED");
        let deadline = started
            .checked_add(Duration::from_millis(maximum.min(remaining)))
            .context("WIKI_ORGANIZATION_RUNTIME_BOUND_INVALID")?;
        Ok(Box::new(WikiCallLease {
            admission: self,
            receipt: dispatched,
            model,
            endpoint,
            usage: None,
            updates: 0,
            started,
            deadline,
        }))
    }
}

impl WikiCallLease<'_> {
    fn charge(&self) -> BudgetCharge {
        BudgetCharge {
            tokens: self
                .usage
                .as_ref()
                .map(|usage| {
                    usage.total_tokens.map(u64::from).unwrap_or_else(|| {
                        u64::from(usage.input_tokens) + u64::from(usage.output_tokens)
                    })
                })
                .unwrap_or(0),
            model_calls: 1,
            run_millis: self
                .started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            cost_micros: None,
        }
    }
    fn write(
        &mut self,
        coverage: BudgetUsageCoverage,
        charge: BudgetCharge,
        terminal: Option<Value>,
    ) -> Result<()> {
        self.admission.authority.check_original_claim()?;
        self.updates = self
            .updates
            .checked_add(1)
            .context("WIKI_ORGANIZATION_USAGE_UPDATE_LIMIT")?;
        self.receipt = receipt(self.admission.authority.context().organization_budget_request(&self.admission.budget.operation, json!({
            "kind":"observe", "reservation_id":self.admission.reservation, "expected_revision":self.receipt.revision,
            "update_id":format!("wiki-usage-{}",self.updates), "coverage":coverage, "usage":charge, "terminal":terminal
        }))?)?;
        Ok(())
    }
}
impl NativeModelRequestLease for WikiCallLease<'_> {
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            self.admission.authority.check_current()?;
            self.admission
                .authority
                .context()
                .authorize_organization_model(
                    &self.model,
                    &self.endpoint,
                    &self.admission.reservation,
                )?;
            self.admission
                .authority
                .context()
                .organization_budget_request(
                    &self.admission.budget.operation,
                    json!({
                        "kind":"check", "reservation_id":self.admission.reservation
                    }),
                )?;
            Ok(())
        })()
        .map_err(|_| NativeModelRequestError::Unavailable)
    }
    fn deadline(&self) -> Option<Instant> {
        Some(self.deadline)
    }
    fn record_usage(&mut self, usage: &Usage) -> Result<(), NativeModelRequestError> {
        if let Some(current) = &mut self.usage {
            current.merge_stream_update(usage);
        } else {
            self.usage = Some(usage.clone());
        }
        self.write(BudgetUsageCoverage::Partial, self.charge(), None)
            .map_err(|_| NativeModelRequestError::Unavailable)
    }
    fn finish(
        mut self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            if let Some(usage) = settlement.usage {
                if let Some(current) = &mut self.usage { current.merge_stream_update(&usage); } else { self.usage=Some(usage); }
            }
            let complete = settlement.end == NativeModelRequestEnd::MessageStop && settlement.usage_from_delta
                && self.usage.as_ref().is_some_and(|usage| usage.total_tokens.is_some() || usage.input_tokens > 0 || usage.cache_read_input_tokens.unwrap_or(0)>0);
            let coverage = if !settlement.request_dispatched || complete { BudgetUsageCoverage::Complete }
                else if self.usage.is_some() { BudgetUsageCoverage::Partial } else { BudgetUsageCoverage::Unreported };
            let terminal = (!settlement.request_dispatched || settlement.end == NativeModelRequestEnd::MessageStop).then(|| -> Result<Value> {
                Ok(json!({"receiptId":format!("wiki-model-end-{}",self.admission.reservation),
                    "receiptSha256":digest(&(&self.admission.reservation, format!("{:?}",settlement.end),settlement.request_dispatched))?,
                    "kind":if settlement.request_dispatched {"completed"} else {"verified_not_started"}}))
            }).transpose()?;
            let charge = if settlement.request_dispatched { self.charge() } else { BudgetCharge::zero() };
            self.write(coverage, charge, terminal)
        })().map_err(|_| NativeModelRequestError::Unavailable)
    }
}
