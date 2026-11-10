//! Owned native knowledge host. Authentication and external providers stay native capabilities.
use super::{
    KnowledgeDependencyPort, KnowledgeHostContext, KnowledgePolicyEvaluator, KnowledgeResource,
};
use crate::app_server::integrations::core::{
    NativeDomain, NativeDomainGuard, NativeIntegrationContext,
};
use anyhow::{Result, ensure};
use kcoder_config::integrations::knowledge::KnowledgeIntegrationSettings;
use kcoder_state::integrations::knowledge::AutomationStore;
use kcoder_types::integrations::{core::*, knowledge::*};
use kcoder_workflow::store::WorkflowStore;
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

pub(crate) fn authorize_observed_wiki_read(
    observed: &crate::app_server::integrations::core::ObservedReadScope,
) -> Result<()> {
    let resource = KnowledgeResource {
        kind: "knowledge",
        id: "current-target".into(),
        owner: observed.owner().clone(),
    };
    observed.authorize_read(&organization_policy::resource_id(&resource)?)
}
pub(crate) fn authorize_observed_wiki_write(
    observed: &crate::app_server::integrations::core::ObservedReadScope,
) -> Result<()> {
    let resource = KnowledgeResource {
        kind: "knowledge",
        id: "current-target".into(),
        owner: observed.owner().clone(),
    };
    observed.authorize_write(&organization_policy::resource_id(&resource)?)
}

struct NativeAutomation {
    guard: NativeDomainGuard,
    store: AutomationStore,
}
impl NativeAutomation {
    fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        self.guard.directory(native.profile()?)?;
        ensure!(
            *self.store.owner() == KnowledgeOwner::from(native.scope()),
            "AUTOMATION_SCOPE_MISMATCH"
        );
        Ok(())
    }
}

/// The composition root supplies resolved settings and actual native provider objects.
/// No caller JSON can construct this service or enable a feature/provider.
pub(crate) struct NativeKnowledgeHost {
    native: NativeIntegrationContext,
    settings: KnowledgeIntegrationSettings,
    policy: Option<Arc<dyn KnowledgePolicyEvaluator>>,
    dependencies: Option<Arc<dyn KnowledgeDependencyPort>>,
    wiki: Option<Arc<dyn NativeWikiPublicationResolver>>,
    runtime_source_current: Arc<AtomicBool>,
    file_events: Vec<Arc<NativeFileEventBinding>>,
    pub(super) application_events: Arc<application_events::NativeApplicationEventSources>,
    delivery_after: std::sync::Mutex<Option<String>>,
}
impl NativeKnowledgeHost {
    pub(crate) fn new(
        native: &NativeIntegrationContext,
        settings: KnowledgeIntegrationSettings,
    ) -> Result<Self> {
        settings
            .validate()
            .map_err(|_| anyhow::anyhow!("KNOWLEDGE_NATIVE_CONFIGURATION_UNAVAILABLE"))?;
        Ok(Self {
            native: native.recapture_for_owned_service()?,
            settings,
            policy: None,
            dependencies: None,
            wiki: None,
            runtime_source_current: Arc::new(AtomicBool::new(true)),
            file_events: Vec::new(),
            application_events: Arc::default(),
            delivery_after: std::sync::Mutex::new(None),
        })
    }
    pub(crate) fn with_policy(mut self, policy: Arc<dyn KnowledgePolicyEvaluator>) -> Self {
        self.policy = Some(policy);
        self
    }
    pub(crate) fn with_dependencies(
        mut self,
        dependencies: Arc<dyn KnowledgeDependencyPort>,
    ) -> Self {
        self.dependencies = Some(dependencies);
        self
    }
    pub(crate) fn scope(&self) -> &IntegrationScope {
        self.native.scope()
    }
    pub(in crate::app_server::integrations::knowledge) fn invalidate_runtime_sources(&self) {
        self.runtime_source_current.store(false, Ordering::Release);
    }
    pub(in crate::app_server::integrations::knowledge) fn runtime_sources_current(&self) -> bool {
        self.runtime_source_current.load(Ordering::Acquire)
    }
    pub(crate) async fn dispatch(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        explicit_user_action: bool,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> IntegrationReply {
        match port {
            IntegrationPort::Knowledge => {
                self.knowledge(method, request, explicit_user_action, now_ms, cancel)
            }
            IntegrationPort::Automation => {
                self.automation(method, request, explicit_user_action, now_ms, cancel)
                    .await
            }
            _ => self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Unavailable,
                "KNOWLEDGE_NATIVE_METHOD_UNAVAILABLE",
                IntegrationRecovery::None,
            ),
        }
    }
    pub(crate) fn with_wiki_resolver(
        mut self,
        resolver: Arc<dyn NativeWikiPublicationResolver>,
    ) -> Self {
        self.wiki = Some(resolver);
        self
    }

    fn observe_automation(&self) -> Result<Option<NativeAutomation>> {
        let Some(guard) = NativeDomainGuard::observe(
            self.native.profile()?,
            self.scope(),
            NativeDomain::Automation,
        )?
        else {
            return Ok(None);
        };
        let directory = guard.directory(self.native.profile()?)?;
        let store = AutomationStore::open_in(&directory, OsStr::new("store"), self.scope())?;
        let owned = NativeAutomation { guard, store };
        owned.verify(&self.native)?;
        Ok(Some(owned))
    }
    fn initialize_automation(&self, operation: &str) -> Result<NativeAutomation> {
        let (guard, store) = NativeDomainGuard::initialize(
            self.native.profile()?,
            self.scope(),
            NativeDomain::Automation,
            operation,
            |directory| AutomationStore::create_in(directory, OsStr::new("store"), self.scope()),
        )?;
        let owned = NativeAutomation { guard, store };
        owned.verify(&self.native)?;
        Ok(owned)
    }
    fn workflows(&self) -> Result<WorkflowStore> {
        // This is the same profile library used by the native workflow canvas and tools.
        Ok(WorkflowStore::new(
            self.native.profile_path()?.join("workflow-library"),
        ))
    }
    fn preview_workflows(&self, draft: &AutomationSubscriptionDraft) -> Result<WorkflowStore> {
        if !draft.workflow_id.starts_with("builtin-office-") {
            let directory = self
                .native
                .profile()?
                .open_child(OsStr::new("workflow-library"), false)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_WORKFLOW_UNAVAILABLE"))?;
            directory
                .verify_private_directory()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_WORKFLOW_UNAVAILABLE"))?;
            let lock = directory
                .open_single_link_regular_file(OsStr::new("library.lock"))
                .map_err(|_| anyhow::anyhow!("AUTOMATION_WORKFLOW_UNAVAILABLE"))?;
            directory
                .portable_regular_handle_identity(&lock)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_WORKFLOW_UNAVAILABLE"))?;
        }
        self.workflows()
    }
    fn policy_for<'a>(&'a self, automation: Option<&'a NativeAutomation>) -> NativePolicy<'a> {
        NativePolicy {
            native: &self.native,
            automation,
            publications: None,
            delegate: self.policy.as_deref(),
        }
    }
    fn reply_failure(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        status: IntegrationStatus,
        code: &str,
        recovery: IntegrationRecovery,
    ) -> IntegrationReply {
        let policy = self.policy_for(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &policy,
        };
        super::api::reply(
            request,
            &context,
            status,
            None,
            None,
            Some(IntegrationError {
                code: code.into(),
                message_key: "integrations.knowledge.operationFailed".into(),
                recovery,
            }),
        )
    }
    fn validate_native_request(&self, request: &IntegrationRequest, mutation: bool) -> Result<()> {
        request.validate(mutation)?;
        self.native.validate_scope(&request.scope)
    }

    fn preview(&self, request: &IntegrationRequest, now_ms: u64) -> IntegrationReply {
        let policy = self.policy_for(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &policy,
        };
        let resource = KnowledgeResource {
            kind: "automation",
            id: "subscriptions".into(),
            owner: self.scope().into(),
        };
        super::api::dispatch(
            request,
            &context,
            false,
            "automation.read",
            resource,
            || {
                let params: kcoder_app_protocol::integrations::knowledge::SubscriptionSaveParams =
                    super::api::parse(request)?;
                AutomationStore::validate_subscription_draft(&params.draft)?;
                if let Some(existing) = self.observe_automation()? {
                    existing
                        .store
                        .validate_period_configuration(&params.draft)?;
                }
                self.validate_sources_and_destination(&params.draft, &context)?;
                let next = super::automation_api::preview_draft(
                    &params.draft,
                    &self.preview_workflows(&params.draft)?,
                    now_ms,
                )?;
                ensure!(
                    params.draft.schedule.is_none() || next.is_some(),
                    "AUTOMATION_SCHEDULE_IN_PAST"
                );
                let mut preview = json!({"nextFireAtMs":next,"workflowId":params.draft.workflow_id,
                "workflowVersion":params.draft.workflow_version,"maximumTokens":params.draft.maximum_tokens,
                "maximumRuntimeSeconds":params.draft.maximum_runtime_seconds,"createsSubscription":false});
                if let Some(selection) = &params.draft.model_selection {
                    preview["modelSelection"] = serde_json::to_value(selection)?;
                }
                if let Some(period) = &params.draft.period_budget {
                    preview["periodBudget"] =
                        super::automation_runtime::budget::period_budget::preview(
                            &self.native,
                            &params.draft,
                            period,
                            now_ms,
                        )?;
                }
                Ok((preview, None))
            },
        )
    }
    fn verify_event_source(&self, reference: &str) -> Result<()> {
        ensure!(
            !reference.starts_with("connection-event-"),
            "AUTOMATION_CONNECTION_SOURCE_UNAVAILABLE"
        );
        if reference.starts_with("application-events-") {
            self.application_events
                .resolve(&self.native, reference)
                .map(|_| ())
        } else {
            self.verify_file_event_source(reference)
        }
    }
    fn validate_sources_and_destination(
        &self,
        draft: &AutomationSubscriptionDraft,
        context: &KnowledgeHostContext<'_>,
    ) -> Result<()> {
        if let Some(reference) = &draft.event_source {
            self.verify_event_source(reference)?;
        }
        if matches!(draft.delivery, AutomationDestination::Channel { .. }) {
            let provider = self
                .dependencies
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("AUTOMATION_DELIVERY_UNAVAILABLE"))?;
            ensure!(
                provider.registered(IntegrationPort::Delivery, "submitDelivery")
                    && provider.registered(IntegrationPort::Delivery, "readDelivery"),
                "AUTOMATION_DELIVERY_UNAVAILABLE"
            );
        }
        super::automation_api::check_destination(draft, context)
    }

    /// Finite UI/Port dispatch. Trigger proofs and scheduler ownership are native-only APIs.
    pub(crate) async fn automation(
        &self,
        method: &str,
        request: &IntegrationRequest,
        explicit_user_action: bool,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> IntegrationReply {
        const READS: &[&str] = &[
            "listTemplates",
            "previewSubscription",
            "listSubscriptions",
            "listAutomationRuns",
            "listQuarantinedEvents",
            "listConnectionEventSources",
            "readAutomationRun",
            "readAutomationArtifacts",
            "readAutomationClaims",
        ];
        const WRITES: &[&str] = &[
            "saveSubscription",
            "setSubscriptionEnabled",
            "removeSubscription",
            "hideAutomationRun",
            "cancelAutomationRun",
            "cancelAutomationDelivery",
            "reconcileAutomationDelivery",
        ];
        let mutation = WRITES.contains(&method);
        if !mutation && !READS.contains(&method) {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Unavailable,
                "KNOWLEDGE_NATIVE_METHOD_UNAVAILABLE",
                IntegrationRecovery::None,
            );
        }
        if !self.settings.business_automation_enabled {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Unavailable,
                "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE",
                IntegrationRecovery::RepairConfiguration,
            );
        }
        if self.validate_native_request(request, mutation).is_err() {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Rejected,
                "KNOWLEDGE_CALLER_SCOPE_MISMATCH",
                IntegrationRecovery::RequestAuthorization,
            );
        }
        if mutation && !explicit_user_action {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Rejected,
                "AUTOMATION_EXPLICIT_CONSENT_REQUIRED",
                IntegrationRecovery::ExplicitUserDecision,
            );
        }
        if method == "listTemplates" {
            let policy = self.policy_for(None);
            return super::handle_automation_templates(
                request,
                &KnowledgeHostContext {
                    scope: self.scope(),
                    now_ms,
                    explicit_user_action: false,
                    policy: &policy,
                },
            );
        }
        if method == "previewSubscription" {
            return self.preview(request, now_ms);
        }
        let mut automation = match self.observe_automation() {
            Ok(owned) => owned,
            Err(error) => {
                let busy = error
                    .chain()
                    .any(|cause| cause.to_string() == "AUTOMATION_BUSY");
                return self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Unavailable,
                    if busy {
                        "AUTOMATION_BUSY"
                    } else {
                        "AUTOMATION_STORE_UNAVAILABLE"
                    },
                    if busy {
                        IntegrationRecovery::RetryRead
                    } else {
                        IntegrationRecovery::RepairConfiguration
                    },
                );
            }
        };
        if method == "saveSubscription" {
            let preflight = self.preview(request, now_ms);
            if preflight.status != IntegrationStatus::Completed {
                return preflight;
            }
            if automation.is_none() {
                if !matches!(super::api::revision(request, true), Ok(0)) {
                    return self.reply_failure(
                        request,
                        now_ms,
                        IntegrationStatus::Rejected,
                        "AUTOMATION_REVISION_CONFLICT",
                        IntegrationRecovery::RetryRead,
                    );
                }
                automation = match self
                    .initialize_automation(request.operation_id.as_deref().unwrap_or_default())
                {
                    Ok(owned) => Some(owned),
                    Err(_) => {
                        return self.reply_failure(
                            request,
                            now_ms,
                            IntegrationStatus::Unknown,
                            "AUTOMATION_INITIALIZATION_UNCONFIRMED",
                            IntegrationRecovery::ReconcileOriginal,
                        );
                    }
                };
            }
        }
        let Some(automation) = automation else {
            if matches!(
                method,
                "listSubscriptions" | "listAutomationRuns" | "listQuarantinedEvents"
            ) {
                let policy = self.policy_for(None);
                let context = KnowledgeHostContext {
                    scope: self.scope(),
                    now_ms,
                    explicit_user_action: false,
                    policy: &policy,
                };
                return super::api::dispatch(
                    request,
                    &context,
                    false,
                    "automation.read",
                    KnowledgeResource {
                        kind: "automation",
                        id: "subscriptions".into(),
                        owner: self.scope().into(),
                    },
                    || Ok((json!({"page":{"items":[],"nextCursor":null}}), None)),
                );
            }
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Unavailable,
                "AUTOMATION_STORE_UNAVAILABLE",
                IntegrationRecovery::RepairConfiguration,
            );
        };
        let policy = self.policy_for(Some(&automation));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action,
            policy: &policy,
        };
        if matches!(
            method,
            "saveSubscription" | "setSubscriptionEnabled" | "readAutomationRun"
        ) {
            let workflows = match self.workflows() {
                Ok(value) => value,
                Err(_) => {
                    return self.reply_failure(
                        request,
                        now_ms,
                        IntegrationStatus::Unavailable,
                        "AUTOMATION_WORKFLOW_UNAVAILABLE",
                        IntegrationRecovery::RepairConfiguration,
                    );
                }
            };
            return super::automation_api::handle_automation_with_source_start(
                method,
                request,
                &context,
                &automation.store,
                &workflows,
                None,
            );
        }
        if matches!(
            method,
            "cancelAutomationRun" | "cancelAutomationDelivery" | "reconcileAutomationDelivery"
        ) {
            let Some(provider) = self.dependencies.as_deref() else {
                return self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Unavailable,
                    "AUTOMATION_RUNTIME_UNAVAILABLE",
                    IntegrationRecovery::RepairConfiguration,
                );
            };
            let Some(run_id) = request.payload.get("runId").and_then(Value::as_str) else {
                return self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Rejected,
                    "KNOWLEDGE_INVALID_PAYLOAD",
                    IntegrationRecovery::None,
                );
            };
            return if method == "cancelAutomationRun" {
                super::cancel_automation_run(
                    request,
                    &context,
                    &automation.store,
                    provider,
                    run_id,
                    cancel,
                )
                .await
            } else {
                super::control_automation_delivery(
                    if method == "cancelAutomationDelivery" {
                        "cancelDelivery"
                    } else {
                        "reconcileDelivery"
                    },
                    request,
                    &context,
                    &automation.store,
                    &delivery::NativeDeliveryDependencies {
                        host: self,
                        provider,
                        explicit_user_action,
                        cancel,
                    },
                    run_id,
                    cancel,
                )
                .await
            };
        }
        super::handle_automation_management(method, request, &context, &automation.store)
    }

    /// One bounded pass owned by the existing scheduler, using original accepted operations.
    pub(crate) async fn automation_tick(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<Vec<IntegrationReply>> {
        ensure!(
            self.settings.business_automation_enabled,
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        self.validate_native_request(request, false)?;
        let Some(automation) = self.observe_automation()? else {
            return Ok(Vec::new());
        };
        let provider = self
            .dependencies
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUNTIME_UNAVAILABLE"))?;
        let policy = self.policy_for(Some(&automation));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &policy,
        };
        let workflows = self.workflows()?;
        let mut results = super::resume_prepared_automations(
            request,
            &context,
            &automation.store,
            &workflows,
            provider,
            cancel,
        )
        .await?;
        automation.verify(&self.native)?;
        if !cancel.is_cancelled() {
            results.extend(
                super::process_due_subscriptions(
                    request,
                    &context,
                    &automation.store,
                    &workflows,
                    provider,
                    cancel,
                )
                .await?,
            );
        }
        automation.verify(&self.native)?;
        if !cancel.is_cancelled() {
            results.extend(
                self.file_event_tick(request, now_ms, None, 0, cancel)
                    .await?,
            );
        }
        if !cancel.is_cancelled() {}
        if !cancel.is_cancelled() {
            results.extend(self.application_event_tick(request, now_ms, cancel).await?);
        }
        if !cancel.is_cancelled()
            && provider.registered(IntegrationPort::Delivery, "submitDelivery")
            && provider.registered(IntegrationPort::Delivery, "readDelivery")
        {
            let after = self
                .delivery_after
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_DELIVERY_BUSY"))?
                .clone();
            let (deliveries, next) = super::automation_delivery::process_pending_deliveries(
                request,
                &context,
                &automation.store,
                &delivery::NativeDeliveryDependencies {
                    host: self,
                    provider,
                    explicit_user_action: false,
                    cancel,
                },
                after.as_deref(),
                cancel,
            )
            .await?;
            results.extend(deliveries);
            *self
                .delivery_after
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_DELIVERY_BUSY"))? = next;
        }
        Ok(results)
    }
}

struct NativePolicy<'a> {
    native: &'a NativeIntegrationContext,
    automation: Option<&'a NativeAutomation>,
    publications: Option<&'a publications::NativePublications>,
    delegate: Option<&'a dyn KnowledgePolicyEvaluator>,
}
impl KnowledgePolicyEvaluator for NativePolicy<'_> {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        self.native.validate_scope(scope)?;
        if let Some(automation) = self.automation {
            automation.verify(self.native)?;
        }
        if let Some(publications) = self.publications {
            publications.verify(self.native)?;
        }
        if let Some(delegate) = self.delegate {
            let mut evaluation = delegate.evaluate_action(scope, action, resource)?;
            if evaluation.decision == IntegrationPolicyDecision::Allow
                && let Some(revision) =
                    organization_policy::current_revision(self.native, action, resource)?
            {
                evaluation.policy_revision = format!("organization-{revision}");
                evaluation.reason_code = "native_organization_current_policy".into();
            }
            return Ok(evaluation);
        }
        if action == "automation.external_delivery"
            || (action == "knowledge.share"
                && !matches!(
                    self.native.scope().organization_id,
                    Some(IntegrationNullable::Value(_))
                ))
        {
            anyhow::bail!("KNOWLEDGE_POLICY_UNAVAILABLE");
        }
        let own = resource.owner == KnowledgeOwner::from(self.native.scope())
            || (resource.kind == "publication"
                && matches!(action, "knowledge.read" | "knowledge.citation")
                && self
                    .publications
                    .map(|store| store.allows_legacy_read(self.native, &resource.owner))
                    .transpose()?
                    .unwrap_or(false));
        let known = matches!(
            action,
            "knowledge.read"
                | "knowledge.manage"
                | "knowledge.publish"
                | "knowledge.share"
                | "knowledge.revoke"
                | "knowledge.citation"
                | "knowledge.adopt"
                | "knowledge.adoption.manage"
                | "automation.read"
                | "automation.configure"
                | "automation.trigger"
                | "automation.cancel"
                | "automation.deliver"
        );
        let organization_revision = if own && known {
            organization_policy::current_revision(self.native, action, resource)?
        } else {
            None
        };
        Ok(IntegrationPolicyEvaluation {
            decision: if own && known {
                IntegrationPolicyDecision::Allow
            } else {
                IntegrationPolicyDecision::Deny
            },
            policy_revision: organization_revision.map_or_else(
                || self.native.scope().identity_generation.clone(),
                |revision| format!("organization-{revision}"),
            ),
            reason_code: if self.native.scope().organization_id.is_some() {
                "native_organization_current_policy"
            } else {
                "native_personal_owner"
            }
            .into(),
        })
    }
}

mod organization_policy;
#[cfg(test)]
mod tests;

mod publications;
pub(crate) use publications::run_shared_publication_read_helper;
pub(crate) use publications::{ExistingProfileWikiResolver, NativeWikiPublicationResolver};
mod office_sources;
mod runtime_source;
pub(crate) use runtime_source::NativeAutomationSource;
mod file_events;
pub(crate) use file_events::NativeFileEventBinding;

mod artifact_claims;
mod delivery;
pub use delivery::NativeAutomationDeliveryUse;

#[cfg(test)]
pub(crate) use delivery::test_support::native_delivery_test_fixture;

pub(super) mod application_events;
pub(crate) use application_events::NativeApplicationResourceReadUse;
