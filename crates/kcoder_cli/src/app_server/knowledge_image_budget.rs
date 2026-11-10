//! Image imports retain their own original task and call identities in the shared Root budget ledger.
use super::{
    knowledge_model::ProviderWikiModel, knowledge_model_admission::WikiRequestAdmission,
    knowledge_requests,
};
use anyhow::{Context, Result, ensure};
use kcoder_api::model_budget_input::{
    effective_output_limit, reservation_input, validate_model_input,
};
use kcoder_api::native_model_request::{
    NativeModelRequestEnd, NativeModelRequestError, NativeModelRequestLease,
    NativeModelRequestSettlement,
};
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{
    ImageImportClaimFacts, ImageImportLease, KnowledgeCatalog, KnowledgeScope,
    integrations::knowledge::CatalogReadLimits,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_state::integrations::core::budgets::{
    BudgetCharge, BudgetPhase, BudgetReservationReceipt, BudgetUsageCoverage,
};
use kcoder_types::{MessagesRequest, ModelConfigurationSummary, Usage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) struct ImageImportBudget {
    native: NativeIntegrationContext,
    settings: PathBuf,
    library: String,
    lease: ImageImportLease,
    facts: ImageImportClaimFacts,
    directory: PrivateDirectory,
    operation: String,
    slot: String,
    reservation: String,
    parent_receipt: String,
    parent_sha: String,
    slot_receipt: Mutex<Option<BudgetReservationReceipt>>,
}
fn digest(value: &impl serde::Serialize) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn receipt(value: Value) -> Result<BudgetReservationReceipt> {
    serde_json::from_value(value).context("IMAGE_ORGANIZATION_BUDGET_RECEIPT_INVALID")
}
impl ImageImportBudget {
    pub(super) fn authorize_resource(native: &NativeIntegrationContext) -> Result<()> {
        let scope = native.scope();
        let resource = format!(
            "knowledge:{:x}",
            Sha256::digest(serde_json::to_vec(&(
                "native-knowledge-resource-v1",
                "knowledge",
                &scope.account_id,
                &scope.target_id,
                &scope.workspace_id,
                &scope.organization_id,
                "current-target"
            ))?)
        );
        for action in ["read", "write"] {
            native.authorize_organization_resource(
                action,
                &resource,
                &uuid::Uuid::new_v4().to_string(),
            )?;
        }
        Ok(())
    }
    pub(super) fn capture(
        native: &NativeIntegrationContext,
        settings: &Path,
        library: &str,
        lease: &ImageImportLease,
    ) -> Result<Self> {
        native.verify()?;
        ensure!(
            settings
                .parent()
                .context("image profile missing")?
                .canonicalize()?
                == native.profile_path()?.canonicalize()?,
            "IMAGE_ORGANIZATION_PROFILE_CHANGED"
        );
        let directory = native
            .profile()?
            .open_child(OsStr::new("knowledge"), false)?;
        let reader = KnowledgeCatalog::open_existing_native_directory(
            directory.duplicate_handle()?,
            OsStr::new("state.sqlite"),
            OsStr::new("state.objects"),
            &CancellationToken::new(),
            CatalogReadLimits::default(),
        )?;
        let (_, scope) = knowledge_requests::catalog_scope_for_profile(settings)?;
        let (facts, _) = reader.with_catalog(|catalog| {
            catalog.check_image_import_lease(&scope, library, lease)?;
            catalog.image_import_claim_facts(&scope, library, lease)
        })?;
        let original = digest(&(
            native.scope(),
            library,
            &facts.import_id,
            &facts.original_hash,
            &facts.fingerprint,
        ))?;
        // The import is the root task; each explicitly claimed real call is one
        // slot attempt. Unknown old calls keep their original slot/estimate.
        let operation = format!("org-image-{original}");
        let call = digest(&(&operation, &facts.call_id))?;
        let value = Self {
            native: native.recapture_for_owned_service()?,
            settings: settings.into(),
            library: library.into(),
            lease: lease.clone(),
            slot: format!("image-slot-{call}"),
            reservation: format!("image-call-{call}"),
            parent_receipt: format!("image-attempt-{}", facts.call_id),
            parent_sha: digest(&(&original, &facts.call_id, &facts.recipe, &lease.token))?,
            facts,
            directory,
            operation,
            slot_receipt: Mutex::new(None),
        };
        value.check_current()?;
        Ok(value)
    }
    fn read_original<T>(
        &self,
        read: impl FnOnce(&KnowledgeCatalog, &KnowledgeScope) -> Result<T>,
    ) -> Result<T> {
        self.native.verify()?;
        ensure!(
            self.native
                .profile()?
                .open_child(OsStr::new("knowledge"), false)?
                .directory_identity()?
                == self.directory.directory_identity()?,
            "IMAGE_ORGANIZATION_STORE_CHANGED"
        );
        let reader = KnowledgeCatalog::open_existing_native_directory(
            self.directory.duplicate_handle()?,
            OsStr::new("state.sqlite"),
            OsStr::new("state.objects"),
            &CancellationToken::new(),
            CatalogReadLimits::default(),
        )?;
        let (_, scope) = knowledge_requests::catalog_scope_for_profile(&self.settings)?;
        let (value, _) = reader.with_catalog(|catalog| {
            ensure!(
                catalog.image_import_claim_facts(&scope, &self.library, &self.lease)? == self.facts,
                "IMAGE_ORGANIZATION_ORIGINAL_CHANGED"
            );
            read(catalog, &scope)
        })?;
        Ok(value)
    }
    fn check_original(&self) -> Result<()> {
        self.read_original(|_, _| Ok(()))
    }
    fn check_current(&self) -> Result<()> {
        ensure!(
            knowledge_requests::organization_enabled(&self.settings)?,
            "Wiki organization is disabled"
        );
        Self::authorize_resource(&self.native)?;
        self.read_original(|catalog, scope| {
            catalog.check_image_import_lease(scope, &self.library, &self.lease)
        })
    }
    fn ensure_slot(&self) -> Result<()> {
        self.check_current()?;
        let mut current = self
            .slot_receipt
            .lock()
            .map_err(|_| anyhow::anyhow!("IMAGE_ORGANIZATION_TASK_UNAVAILABLE"))?;
        if current.is_none() {
            let reserved=receipt(self.native.organization_budget_request(&self.operation,json!({"kind":"reserve","reservation_id":self.slot,"operation_id":self.operation,"unit":"task_slot",
                "task":{"rootOperationId":self.operation,"rootTask":{"kind":"task","id":self.facts.import_id,"revision":null},"actor":"observer","actorAttemptId":self.facts.call_id,"parentReservationId":null},"estimate":BudgetCharge::zero()}))?)?;
            let active = if reserved.phase == BudgetPhase::Reserved {
                receipt(self.native.organization_budget_request(&self.operation,json!({"kind":"dispatch","reservation_id":self.slot,"expected_revision":reserved.revision}))?)?
            } else {
                reserved
            };
            ensure!(
                !active.execution_confirmed_terminal,
                "IMAGE_ORGANIZATION_TASK_ALREADY_TERMINAL"
            );
            *current = Some(active);
        }
        let active = receipt(self.native.organization_budget_request(
            &self.operation,
            json!({"kind":"check","reservation_id":self.slot}),
        )?)?;
        ensure!(
            !active.execution_confirmed_terminal,
            "IMAGE_ORGANIZATION_TASK_ALREADY_TERMINAL"
        );
        Ok(())
    }
    pub(super) fn reconcile_terminal(&self) -> Result<()> {
        if self
            .slot_receipt
            .lock()
            .map_err(|_| anyhow::anyhow!("IMAGE_ORGANIZATION_TASK_UNAVAILABLE"))?
            .is_none()
        {
            return Ok(());
        }
        let status = self.read_original(|catalog, scope| {
            catalog.image_import_original_status(scope, &self.library, &self.lease.id)
        })?;
        if !["completed", "failed", "cancelled"].contains(&status.as_str()) {
            return Ok(());
        }
        let closed = self.native.organization_budget_request(
            &self.operation,
            json!({"kind":"calls_closed","reservation_id":self.slot}),
        )?;
        if closed["closed"] != true {
            return Ok(());
        }
        let current = receipt(self.native.organization_budget_request(
            &self.operation,
            json!({"kind":"read","reservation_id":self.slot}),
        )?)?;
        if current.execution_confirmed_terminal {
            return Ok(());
        }
        self.native.organization_budget_request(&self.operation,json!({"kind":"observe","reservation_id":self.slot,"expected_revision":current.revision,"update_id":"original-image-attempt-terminal","coverage":"complete","usage":BudgetCharge::zero(),
            "terminal":{"receiptId":self.parent_receipt,"receiptSha256":digest(&(&self.parent_sha,&status))?,"kind":if status=="completed"{"completed"}else if status=="cancelled"{"cancelled"}else{"failed"}}}))?;
        Ok(())
    }
}
struct ImageCallLease<'a> {
    budget: &'a ImageImportBudget,
    receipt: BudgetReservationReceipt,
    model: ModelConfigurationSummary,
    endpoint: String,
    usage: Option<Usage>,
    updates: u64,
    started: Instant,
    deadline: Instant,
}
impl WikiRequestAdmission for ImageImportBudget {
    fn reserve(
        &self,
        provider: &ProviderWikiModel,
        request: &MessagesRequest,
    ) -> Result<Box<dyn NativeModelRequestLease + '_>> {
        self.check_current()?;
        let model = provider
            .configuration
            .clone()
            .context("IMAGE_ORGANIZATION_MODEL_CONFIGURATION_REQUIRED")?;
        validate_model_input(&model)?;
        let endpoint = provider
            .provider
            .endpoint()
            .context("IMAGE_ORGANIZATION_MODEL_ENDPOINT_REQUIRED")?
            .to_owned();
        self.native
            .authorize_organization_model(&model, &endpoint, &self.reservation)?;
        let input = reservation_input(request)?;
        let output = u64::from(effective_output_limit(&model, request)?);
        let maximum = provider
            .provider
            .request_timeout_secs()
            .filter(|n| *n > 0)
            .and_then(|n| n.checked_mul(1000))
            .unwrap_or(90_000)
            .min(90_000);
        self.ensure_slot()?;
        let started = Instant::now();
        let reserved=receipt(self.native.organization_budget_request(&self.operation,json!({"kind":"reserve","reservation_id":self.reservation,"operation_id":self.reservation,"unit":"model_call",
            "task":{"rootOperationId":self.operation,"rootTask":{"kind":"task","id":self.facts.import_id,"revision":null},"actor":"observer","actorAttemptId":self.facts.call_id,"parentReservationId":self.slot},
            "parent":{"receiptId":self.parent_receipt,"receiptSha256":self.parent_sha},"estimate":{"tokens":input.checked_add(output).context("IMAGE_ORGANIZATION_BUDGET_OVERFLOW")?,"modelCalls":1,"runMillis":maximum,"costMicros":null}}))?)?;
        ensure!(
            reserved.phase == BudgetPhase::Reserved,
            "IMAGE_ORGANIZATION_MODEL_ALREADY_DISPATCHED"
        );
        self.check_current()?;
        let dispatched=receipt(self.native.organization_budget_request(&self.operation,json!({"kind":"dispatch","reservation_id":self.reservation,"expected_revision":reserved.revision}))?)?;
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis(),
        )?;
        let remaining = dispatched
            .policy_refs
            .iter()
            .map(|p| p.window.ends_at_ms.saturating_sub(now))
            .min()
            .context("IMAGE_ORGANIZATION_BUDGET_WINDOW_REQUIRED")?;
        ensure!(remaining > 0, "IMAGE_ORGANIZATION_BUDGET_WINDOW_EXPIRED");
        let deadline = started
            .checked_add(Duration::from_millis(maximum.min(remaining)))
            .context("IMAGE_ORGANIZATION_RUNTIME_BOUND_INVALID")?;
        Ok(Box::new(ImageCallLease {
            budget: self,
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
impl ImageCallLease<'_> {
    fn charge(&self) -> BudgetCharge {
        BudgetCharge {
            tokens: self
                .usage
                .as_ref()
                .map(|u| {
                    u.total_tokens
                        .map(u64::from)
                        .unwrap_or_else(|| u64::from(u.input_tokens) + u64::from(u.output_tokens))
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
        usage: BudgetCharge,
        terminal: Option<Value>,
    ) -> Result<()> {
        self.budget.check_original()?;
        self.updates = self
            .updates
            .checked_add(1)
            .context("IMAGE_ORGANIZATION_USAGE_UPDATE_LIMIT")?;
        self.receipt=receipt(self.budget.native.organization_budget_request(&self.budget.operation,json!({"kind":"observe","reservation_id":self.budget.reservation,"expected_revision":self.receipt.revision,"update_id":format!("image-usage-{}",self.updates),"coverage":coverage,"usage":usage,"terminal":terminal}))?)?;
        Ok(())
    }
}
impl NativeModelRequestLease for ImageCallLease<'_> {
    fn check_current(&self) -> Result<(), NativeModelRequestError> {
        (|| -> Result<()> {
            self.budget.check_current()?;
            self.budget.native.authorize_organization_model(
                &self.model,
                &self.endpoint,
                &self.budget.reservation,
            )?;
            self.budget.native.organization_budget_request(
                &self.budget.operation,
                json!({"kind":"check","reservation_id":self.budget.reservation}),
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
            current.merge_stream_update(usage)
        } else {
            self.usage = Some(usage.clone())
        };
        self.write(BudgetUsageCoverage::Partial, self.charge(), None)
            .map_err(|_| NativeModelRequestError::Unavailable)
    }
    fn finish(
        mut self: Box<Self>,
        settlement: NativeModelRequestSettlement,
    ) -> Result<(), NativeModelRequestError> {
        (||->Result<()>{
        if let Some(usage)=settlement.usage{if let Some(current)=&mut self.usage{current.merge_stream_update(&usage)}else{self.usage=Some(usage)}}
        let complete=settlement.end==NativeModelRequestEnd::MessageStop&&settlement.usage_from_delta&&self.usage.as_ref().is_some_and(|u|u.total_tokens.is_some()||u.input_tokens>0||u.cache_read_input_tokens.unwrap_or(0)>0);
        let coverage=if !settlement.request_dispatched||complete{BudgetUsageCoverage::Complete}else if self.usage.is_some(){BudgetUsageCoverage::Partial}else{BudgetUsageCoverage::Unreported};
        let terminal=(!settlement.request_dispatched||settlement.end==NativeModelRequestEnd::MessageStop).then(||->Result<Value>{Ok(json!({"receiptId":format!("image-model-end-{}",self.budget.facts.call_id),"receiptSha256":digest(&(&self.budget.parent_sha,format!("{:?}",settlement.end),settlement.request_dispatched))?,"kind":if settlement.request_dispatched{"completed"}else{"verified_not_started"}}))}).transpose()?;
        let charge=if settlement.request_dispatched{self.charge()}else{BudgetCharge::zero()};self.write(coverage,charge,terminal)
    })().map_err(|_|NativeModelRequestError::Unavailable)
    }
}
