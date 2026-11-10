//! Native held-file selection plus an independently current read authority.
use super::*;
use crate::app_server::integrations::knowledge::ApprovedFileEventSource;
use kcoder_engine::QueryEngine;

/// No Deserialize/JSON/path constructor. The host must supply the actual
/// selection and its existing read policy; feature enable grants neither.
pub(crate) struct NativeFileEventBinding {
    native: NativeIntegrationContext,
    engine: QueryEngine,
    source: ApprovedFileEventSource,
    read_policy: Arc<dyn KnowledgePolicyEvaluator>,
}
impl NativeFileEventBinding {
    pub(crate) fn from_authorized_source(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        source: ApprovedFileEventSource,
        current_read_policy: Arc<dyn KnowledgePolicyEvaluator>,
    ) -> Result<Self> {
        let binding = Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
            source,
            read_policy: current_read_policy,
        };
        binding.verify(native)?;
        Ok(binding)
    }
    pub(crate) fn source_ref(&self) -> &str {
        self.source.source_ref()
    }
    pub(in crate::app_server::integrations::knowledge) fn contains_resource(
        &self,
        resource: &str,
    ) -> bool {
        self.source
            .resource_refs()
            .any(|reference| reference == resource)
    }
    pub(crate) fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        self.verify_owner(native)?;
        self.source
            .verify_selected_identity(native.scope())
            .map_err(|_| anyhow::anyhow!("AUTOMATION_FILE_SELECTION_AUTHORITY_UNAVAILABLE"))?;
        for reference in self.source.resource_refs() {
            let resource = KnowledgeResource {
                kind: "automation-file-source",
                id: reference.into(),
                owner: KnowledgeOwner::from(native.scope()),
            };
            let result = self
                .read_policy
                .evaluate_action(native.scope(), "automation.event_source.read", &resource)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_FILE_READ_AUTHORITY_UNAVAILABLE"))?;
            ensure!(
                result.decision == IntegrationPolicyDecision::Allow
                    && !result.policy_revision.is_empty(),
                "AUTOMATION_FILE_READ_AUTHORITY_UNAVAILABLE"
            );
        }
        self.source.verify_selected_identity(native.scope())?;
        native.verify()
    }
    fn verify_owner(&self, native: &NativeIntegrationContext) -> Result<()> {
        native.verify()?;
        self.native.verify()?;
        // A model/config revision is metadata, not a new file read grant or
        // an excuse to hide the same owner's metadata/cancellation controls.
        ensure!(
            KnowledgeOwner::from(self.native.scope()) == KnowledgeOwner::from(native.scope()),
            "AUTOMATION_FILE_EVENT_OWNER_CHANGED"
        );
        super::super::rpc::configuration::EngineSnapshot::capture(&self.engine)?
            .verify_binding(&self.engine, native)?;
        Ok(())
    }
}

struct FileReadPolicy<'a> {
    native: &'a NativeIntegrationContext,
    base: &'a dyn KnowledgePolicyEvaluator,
    file: &'a NativeFileEventBinding,
}
impl KnowledgePolicyEvaluator for FileReadPolicy<'_> {
    fn evaluate_action(
        &self,
        scope: &IntegrationScope,
        action: &str,
        resource: &KnowledgeResource,
    ) -> Result<IntegrationPolicyEvaluation> {
        self.native.validate_scope(scope)?;
        if action == "automation.event_source.read" {
            self.file.verify(self.native)?;
            ensure!(
                resource.kind == "automation-file-source"
                    && resource.owner == KnowledgeOwner::from(scope)
                    && self
                        .file
                        .source
                        .resource_refs()
                        .any(|reference| reference == resource.id),
                "AUTOMATION_FILE_READ_AUTHORITY_UNAVAILABLE"
            );
            return self
                .file
                .read_policy
                .evaluate_action(scope, action, resource);
        }
        self.base.evaluate_action(scope, action, resource)
    }
}
impl NativeKnowledgeHost {
    pub(crate) fn with_file_event_bindings(
        mut self,
        bindings: Vec<Arc<NativeFileEventBinding>>,
    ) -> Result<Self> {
        ensure!(bindings.len() <= 16, "AUTOMATION_EVENT_SOURCE_LIMIT");
        let mut references = std::collections::BTreeSet::new();
        for binding in &bindings {
            // Metadata and original-owner cancellation remain reachable after
            // read revocation. Save/tick/material paths separately call verify.
            binding.verify_owner(&self.native)?;
            ensure!(
                references.insert(binding.source_ref()),
                "AUTOMATION_EVENT_SOURCE_DUPLICATE"
            );
        }
        self.file_events = bindings;
        Ok(self)
    }
    pub(in crate::app_server::integrations::knowledge) fn verify_file_event_source(
        &self,
        reference: &str,
    ) -> Result<()> {
        self.file_events
            .iter()
            .find(|source| source.source_ref() == reference)
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_FILE_SELECTION_AUTHORITY_UNAVAILABLE"))?
            .verify(&self.native)
    }
    /// The existing owner tick consumes only installed held sources. Causal
    /// metadata is native host data, never parsed from an event/RPC payload.
    pub(crate) async fn file_event_tick(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        originating_subscription: Option<&str>,
        causation_depth: u8,
        cancel: &CancellationToken,
    ) -> Result<Vec<IntegrationReply>> {
        ensure!(
            self.settings.business_automation_enabled && self.runtime_sources_current(),
            "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
        );
        self.validate_native_request(request, false)?;
        let Some(automation) = self.observe_automation()? else {
            return Ok(vec![]);
        };
        // A persisted subscription is not a surviving file grant. Missing
        // native selection/read authority stays explicit after reconnect.
        for reference in automation
            .store
            .enabled_event_source_refs()?
            .into_iter()
            .filter(|reference| !reference.starts_with("application-events-"))
        {
            self.verify_event_source(&reference)?;
        }
        let provider = self
            .dependencies
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("AUTOMATION_RUNTIME_UNAVAILABLE"))?;
        let base = self.policy_for(Some(&automation));
        let workflows = self.workflows()?;
        let mut replies = Vec::new();
        for binding in &self.file_events {
            if cancel.is_cancelled() || replies.len() >= 32 {
                break;
            }
            // Disabled subscriptions cause no file bytes to be read.
            if automation
                .store
                .event_subscriptions(binding.source_ref())?
                .is_empty()
            {
                continue;
            }
            binding.verify(&self.native)?;
            let policy = FileReadPolicy {
                native: &self.native,
                base: &base,
                file: binding,
            };
            let context = KnowledgeHostContext {
                scope: self.scope(),
                now_ms,
                explicit_user_action: false,
                policy: &policy,
            };
            let remaining = 32 - replies.len();
            replies.extend(
                super::super::automation_executor::process_selected_file_events_bounded(
                    request,
                    &context,
                    &automation.store,
                    &workflows,
                    provider,
                    &binding.source,
                    originating_subscription,
                    causation_depth,
                    cancel,
                    remaining,
                )
                .await?,
            );
            binding.verify(&self.native)?;
        }
        automation.verify(&self.native)?;
        ensure!(
            self.runtime_sources_current() && !cancel.is_cancelled(),
            "AUTOMATION_FILE_EVENT_OWNER_CHANGED"
        );
        Ok(replies)
    }
}

#[cfg(test)]
mod tests;
