//! Read an actual persisted automation source; serialized identifiers are never a grant.
use super::*;
use crate::app_server::integrations::knowledge::{
    FixedBusinessWorkflow, office_assets::NativeKnowledgeOfficeAssets,
    resolve_pinned_business_workflow, rpc::configuration::EngineSnapshot,
};
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::office::OfficeResourceRef;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    kind: String,
    workflow_id: String,
    workflow_version: u64,
    inputs: Value,
    maximum_tokens: u64,
    maximum_runtime_seconds: u64,
    #[serde(default)]
    model_selection: Option<IntegrationModelSelectionIntent>,
    source: Source,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    kind: String,
    subscription_id: String,
    subscription_revision: u64,
    run_id: String,
    consent_ref: String,
}

struct Snapshot {
    pin: FixedBusinessWorkflow,
    material: Vec<Value>,
    fingerprint: String,
    maximum_tokens: u64,
    maximum_runtime_seconds: u64,
    period_budget: Option<AutomationPeriodBudget>,
    created_at_ms: u64,
    expires_at_ms: Option<u64>,
    file_event: Option<Arc<super::NativeFileEventBinding>>,
    application_event:
        Option<Arc<super::super::native_application_selection::NativeApplicationReadAuthority>>,
    model_selection: Option<IntegrationModelSelectionIntent>,
}

/// A native source lease, not a model policy or a budget reservation.
/// Every release of material re-reads the same existing run, policy and fixed revisions.
pub(crate) struct NativeAutomationSource {
    host: Arc<NativeKnowledgeHost>,
    engine: QueryEngine,
    request: IntegrationRequest,
    fingerprint: String,
    pin: FixedBusinessWorkflow,
    maximum_tokens: u64,
    maximum_runtime_seconds: u64,
    period_budget: Option<AutomationPeriodBudget>,
    created_at_ms: u64,
    expires_at_ms: Option<u64>,
    file_event: Option<Arc<super::NativeFileEventBinding>>,
    application_event:
        Option<Arc<super::super::native_application_selection::NativeApplicationReadAuthority>>,
    model_selection: Option<IntegrationModelSelectionIntent>,
}
impl NativeAutomationSource {
    pub(crate) fn capture(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        host: Arc<NativeKnowledgeHost>,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let snapshot = host.automation_runtime_snapshot(native, engine, request, cancel)?;
        Ok(Self {
            host,
            engine: engine.clone(),
            request: request.clone(),
            fingerprint: snapshot.fingerprint,
            pin: snapshot.pin,
            maximum_tokens: snapshot.maximum_tokens,
            maximum_runtime_seconds: snapshot.maximum_runtime_seconds,
            period_budget: snapshot.period_budget,
            created_at_ms: snapshot.created_at_ms,
            expires_at_ms: snapshot.expires_at_ms,
            file_event: snapshot.file_event,
            application_event: snapshot.application_event,
            model_selection: snapshot.model_selection,
        })
    }
    pub(crate) fn pin(&self) -> &FixedBusinessWorkflow {
        &self.pin
    }
    pub(crate) fn effective_model_selection(&self) -> IntegrationModelSelectionIntent {
        self.model_selection
            .clone()
            .unwrap_or(IntegrationModelSelectionIntent::InheritCurrent)
    }
    pub(crate) fn maximum_tokens(&self) -> u64 {
        self.maximum_tokens
    }
    pub(crate) fn maximum_runtime_seconds(&self) -> u64 {
        self.maximum_runtime_seconds
    }
    pub(crate) fn period_budget(&self) -> Option<&AutomationPeriodBudget> {
        self.period_budget.as_ref()
    }
    pub(crate) fn created_at_ms(&self) -> u64 {
        self.created_at_ms
    }
    pub(crate) fn expires_at_ms(&self) -> Option<u64> {
        self.expires_at_ms
    }
    pub(crate) fn original_request(&self) -> &IntegrationRequest {
        &self.request
    }
    pub(crate) fn source_revision(&self) -> &str {
        &self.fingerprint
    }
    /// Persist only the native budget observer's failed reservation. Reading
    /// the real Core acceptance prevents a caller-shaped task locator from
    /// annotating another run; this does not complete or cancel the task.
    pub(in crate::app_server::integrations::knowledge) fn record_model_budget_exhausted(
        &self,
    ) -> Result<()> {
        let native = &self.host.native;
        native.validate_scope(&self.request.scope)?;
        let operation = self
            .request
            .operation_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_OPERATION_REQUIRED"))?;
        let operations = crate::app_server::integrations::core::NativeOperations::load(native)?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE"))?;
        let receipt = operations
            .read(native, operation)?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE"))?;
        anyhow::ensure!(
            receipt.port == "P-RUNTIME"
                && receipt.method == "acceptTask"
                && receipt.phase == IntegrationOperationPhase::Accepted
                && receipt.operation_id == operation
                && IntegrationOwner::from(&receipt.scope) == IntegrationOwner::from(native.scope()),
            "AUTOMATION_NATIVE_RECEIPT_MISMATCH"
        );
        let accepted = receipt
            .runtime_acceptance
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_NATIVE_RECEIPT_UNAVAILABLE"))?;
        accepted.validate()?;
        anyhow::ensure!(
            accepted.task_id.is_some() && accepted.turn_id.is_none(),
            "AUTOMATION_NATIVE_WORKFLOW_REQUIRED"
        );
        let run_id = self.request.payload["source"]["runId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUNTIME_SOURCE_UNAVAILABLE"))?;
        let automation = self
            .host
            .observe_automation()?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_STORE_UNAVAILABLE"))?;
        let run = automation.store.read_run(run_id)?;
        anyhow::ensure!(
            run.native_operation_id == operation
                && run.owner == KnowledgeOwner::from(native.scope())
                && run
                    .native_thread_id
                    .as_ref()
                    .is_none_or(|thread| thread == &accepted.thread_id),
            "AUTOMATION_NATIVE_RECEIPT_MISMATCH"
        );
        let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
        // Core can accept before the original domain acknowledgement arrives.
        // Reconcile that exact receipt instead of waiting for a UI projection.
        automation
            .store
            .record_native_acceptance_receipt(run_id, &accepted, now)?;
        automation
            .store
            .record_observed_budget_exhaustion(run_id, now)?;
        automation.verify(native)
    }
    pub(crate) fn native(&self) -> &NativeIntegrationContext {
        &self.host.native
    }
    pub(crate) fn is_native_personal_policy(&self) -> bool {
        self.host.policy.is_none() && self.host.scope().organization_id.is_none()
    }
    /// A physical invalidation hint only. Changed hints require full `verify`;
    /// no epoch or elapsed allow cache replaces native source authorization.
    pub(crate) fn change_epoch(&self) -> Result<String> {
        if let Some(file) = &self.file_event {
            file.verify(&self.host.native)?;
        }
        if let Some(application) = &self.application_event {
            application.verify_current(&self.host.native)?;
        }
        self.host.native.validate_scope(&self.request.scope)?;
        anyhow::ensure!(
            self.host.runtime_source_current.load(Ordering::Acquire),
            "AUTOMATION_RUNTIME_SOURCE_CHANGED"
        );
        let profile = self.host.native.profile()?;
        let automation =
            NativeDomainGuard::observe(profile, self.host.scope(), NativeDomain::Automation)?
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_STORE_UNAVAILABLE"))?;
        let namespace = automation.directory(profile)?;
        let store = kcoder_state::integrations::knowledge::AutomationStore::open_in(
            &namespace,
            OsStr::new("store"),
            self.host.scope(),
        )?;
        let mut parts = vec![json!(store.observation_epoch()?)];
        if self
            .pin
            .args()
            .get("sourceRefs")
            .is_some_and(|refs| refs.as_array().is_some_and(|refs| !refs.is_empty()))
        {
            let publications =
                NativeDomainGuard::observe(profile, self.host.scope(), NativeDomain::Knowledge)?
                    .ok_or_else(|| anyhow::anyhow!("AUTOMATION_SOURCE_UNAVAILABLE"))?;
            let directory = publications.directory(profile)?;
            for name in ["catalog.sqlite", "catalog-binding.json", "catalog.lock"] {
                parts.push(file_stamp(&directory, name)?);
            }
            let objects = directory.open_child(OsStr::new("catalog.objects"), false)?;
            let metadata = objects.directory_metadata()?;
            let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)?;
            parts.push(json!([
                objects.directory_identity()?,
                modified.as_secs(),
                modified.subsec_nanos()
            ]));
        }
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&parts)?)))
    }
    pub(crate) fn verify(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.current(native, original, cancel).map(|_| ())
    }
    pub(crate) fn read_materials(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Vec<Value>> {
        Ok(self.current(native, original, cancel)?.material)
    }
    fn current(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Snapshot> {
        anyhow::ensure!(
            original.scope == self.request.scope
                && original.operation_id == self.request.operation_id
                && original.payload == self.request.payload,
            "AUTOMATION_RUNTIME_INTENT_CHANGED"
        );
        let snapshot =
            self.host
                .automation_runtime_snapshot(native, &self.engine, original, cancel)?;
        anyhow::ensure!(
            snapshot.fingerprint == self.fingerprint,
            "AUTOMATION_RUNTIME_SOURCE_CHANGED"
        );
        Ok(snapshot)
    }
}

fn file_stamp(directory: &kcoder_config::PrivateDirectory, name: &str) -> Result<Value> {
    directory.verify_private_directory()?;
    let file = directory.open_single_link_regular_file(OsStr::new(name))?;
    let metadata = file.metadata()?;
    let modified = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)?;
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (metadata.ctime(), metadata.ctime_nsec())
    };
    #[cfg(not(unix))]
    let changed = ();
    Ok(json!([
        directory.directory_identity()?,
        directory.portable_regular_handle_identity(&file)?,
        metadata.len(),
        modified.as_secs(),
        modified.subsec_nanos(),
        changed
    ]))
}

impl NativeKnowledgeHost {
    fn automation_runtime_snapshot(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Snapshot> {
        request.validate_method(IntegrationPort::Runtime, "acceptTask")?;
        native.validate_scope(&request.scope)?;
        self.native.validate_scope(&request.scope)?;
        anyhow::ensure!(
            self.runtime_source_current.load(Ordering::Acquire),
            "AUTOMATION_RUNTIME_SOURCE_CHANGED"
        );
        anyhow::ensure!(
            self.settings.business_automation_enabled,
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        anyhow::ensure!(
            native.scope().organization_id.is_none(),
            "AUTOMATION_ORGANIZATION_UNAVAILABLE"
        );
        let configuration = EngineSnapshot::capture(engine)?;
        configuration.verify_binding(engine, native)?;
        anyhow::ensure!(
            configuration.settings.business_automation_enabled,
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        anyhow::ensure!(
            !cancel.is_cancelled(),
            "AUTOMATION_CANCELLED_BEFORE_SUBMISSION"
        );
        let payload: Payload = serde_json::from_value(Value::Object(request.payload.clone()))?;
        anyhow::ensure!(
            payload.kind == "workflow" && payload.source.kind == "automation",
            "AUTOMATION_RUNTIME_SOURCE_UNAVAILABLE"
        );
        let automation = self
            .observe_automation()?
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_STORE_UNAVAILABLE"))?;
        let run = automation.store.read_run(&payload.source.run_id)?;
        anyhow::ensure!(
            run.owner == KnowledgeOwner::from(self.scope())
                && run.native_operation_id == request.operation_id.as_deref().unwrap_or_default()
                && run.subscription_id == payload.source.subscription_id
                && run.subscription_revision == payload.source.subscription_revision,
            "AUTOMATION_RUNTIME_SOURCE_MISMATCH"
        );
        anyhow::ensure!(
            !matches!(
                run.status,
                AutomationRunStatus::Completed
                    | AutomationRunStatus::Cancelled
                    | AutomationRunStatus::Failed
            ),
            "AUTOMATION_RUNTIME_SOURCE_TERMINAL"
        );
        let original = automation
            .store
            .read_subscription_version(&run.subscription_id, run.subscription_revision)?;
        let current = automation.store.read_subscription(&run.subscription_id)?;
        anyhow::ensure!(
            current.enabled
                && current.revision == run.subscription_revision
                && current.owner == run.owner
                && !original.consent_ref.is_empty()
                && original.consent_ref == payload.source.consent_ref
                && current.consent_ref == original.consent_ref,
            "AUTOMATION_CONSENT_MISMATCH"
        );
        anyhow::ensure!(
            payload.workflow_id == original.draft.workflow_id
                && payload.workflow_version == original.draft.workflow_version
                && payload.inputs == original.draft.inputs
                && payload.maximum_tokens == original.draft.maximum_tokens
                && payload.maximum_runtime_seconds == original.draft.maximum_runtime_seconds,
            "AUTOMATION_RUNTIME_INTENT_CHANGED"
        );
        anyhow::ensure!(
            payload.model_selection == original.draft.model_selection,
            "AUTOMATION_RUNTIME_MODEL_INTENT_CHANGED"
        );
        let policy = self.policy_for(Some(&automation));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms: u64::try_from(chrono::Utc::now().timestamp_millis())?,
            explicit_user_action: false,
            policy: &policy,
        };
        let resource = KnowledgeResource {
            kind: "automation",
            id: run.subscription_id.clone(),
            owner: run.owner.clone(),
        };
        context.check(request, true, "automation.trigger", &resource)?;
        let pin = resolve_pinned_business_workflow(
            &self.workflows()?,
            &payload.workflow_id,
            payload.workflow_version,
            &payload.inputs,
            None,
        )?;
        let references: Vec<OfficeResourceRef> = match pin.args().get("sourceRefs") {
            Some(value) => serde_json::from_value(value.clone())?,
            None => vec![],
        };
        anyhow::ensure!(references.len() <= 16, "AUTOMATION_SOURCE_UNAVAILABLE");
        let mut material = Vec::new();
        for reference in &references {
            reference.validate()?;
            anyhow::ensure!(
                reference.kind == "publication",
                "AUTOMATION_SOURCE_PROVIDER_UNAVAILABLE"
            );
            material.push(
                NativeKnowledgeOfficeAssets::publication(self, request, reference, cancel)
                    .map_err(|_| anyhow::anyhow!("AUTOMATION_SOURCE_UNAVAILABLE"))?,
            );
        }
        anyhow::ensure!(
            serde_json::to_vec(&material)?.len() <= 512 * 1024,
            "AUTOMATION_SOURCE_BUDGET_EXCEEDED"
        );
        let facts = automation.store.read_run_trigger_facts(&run.id)?;
        anyhow::ensure!(
            !original
                .draft
                .event_source
                .as_deref()
                .is_some_and(|r| r.starts_with("connection-event-")),
            "AUTOMATION_CONNECTION_SOURCE_UNAVAILABLE"
        );
        let file_event = if let Some(reference) = original.draft.event_source.as_ref().filter(|r| {
            !r.starts_with("connection-event-") && !r.starts_with("application-events-")
        }) {
            let binding = self
                .file_events
                .iter()
                .find(|binding| binding.source_ref() == reference)
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_FILE_SELECTION_AUTHORITY_UNAVAILABLE"))?
                .clone();
            binding.verify(native)?;
            anyhow::ensure!(
                facts["kind"] == "selected_file_revision"
                    && facts["sourceRef"].as_str() == Some(reference.as_str())
                    && facts["resourceRef"]
                        .as_str()
                        .is_some_and(|resource| binding.contains_resource(resource)),
                "AUTOMATION_FILE_EVENT_SOURCE_MISMATCH"
            );
            Some(binding)
        } else {
            None
        };
        let application_event = if let Some(reference) = original
            .draft
            .event_source
            .as_deref()
            .filter(|r| r.starts_with("application-events-"))
        {
            let selected = self.application_events.resolve(native, reference)?;
            material.push(
                self.application_events
                    .material(native, reference, &facts)?,
            );
            Some(selected)
        } else {
            None
        };
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!({
                "runId":run.id,"operationId":run.native_operation_id,"triggerId":run.trigger_id,"createdAtMs":run.created_at_ms,
                "subscription":original,"triggerFacts":facts,"definitionSha256":pin.definition_sha256(),
                "normalizedInputsSha256":pin.inputs_sha256(),"material":material,
            }))?)
        );
        for (reference, before) in references.iter().zip(&material) {
            let after = NativeKnowledgeOfficeAssets::publication(self, request, reference, cancel)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_SOURCE_UNAVAILABLE"))?;
            anyhow::ensure!(&after == before, "AUTOMATION_RUNTIME_SOURCE_CHANGED");
        }
        let current = automation.store.read_subscription(&run.subscription_id)?;
        let current_run = automation.store.read_run(&run.id)?;
        anyhow::ensure!(
            current.enabled
                && current.revision == run.subscription_revision
                && current.consent_ref == payload.source.consent_ref
                && !matches!(
                    current_run.status,
                    AutomationRunStatus::Completed
                        | AutomationRunStatus::Cancelled
                        | AutomationRunStatus::Failed
                ),
            "AUTOMATION_RUNTIME_SOURCE_CHANGED"
        );
        context.check(request, true, "automation.trigger", &resource)?;
        automation.verify(&self.native)?;
        native.validate_scope(&request.scope)?;
        anyhow::ensure!(
            self.runtime_source_current.load(Ordering::Acquire) && !cancel.is_cancelled(),
            "AUTOMATION_RUNTIME_SOURCE_CHANGED"
        );
        let expires_at_ms = material
            .iter()
            .filter_map(|value| value["publication"]["draft"]["validUntilMs"].as_u64())
            .min();
        Ok(Snapshot {
            pin,
            material,
            fingerprint,
            maximum_tokens: payload.maximum_tokens,
            maximum_runtime_seconds: payload.maximum_runtime_seconds,
            period_budget: original.draft.period_budget.clone(),
            created_at_ms: run.created_at_ms,
            expires_at_ms,
            file_event,
            application_event,
            model_selection: original.draft.model_selection.clone(),
        })
    }
}

#[cfg(test)]
#[path = "runtime_source/tests.rs"]
mod tests;
