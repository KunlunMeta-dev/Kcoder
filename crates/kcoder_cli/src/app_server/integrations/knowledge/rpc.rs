//! Connection-owned management adapter. Only native callers supply Engine, providers and consent.
use super::{
    ExistingProfileWikiResolver, KnowledgeDependencyPort, KnowledgePolicyEvaluator,
    NativeKnowledgeHost,
};
use crate::app_server::integrations::core::NativeIntegrationContext;
use anyhow::{Result, anyhow};
use kcoder_app_protocol::integrations::knowledge_host::{
    IntegrationAutomationMethod, IntegrationKnowledgeMethod,
};
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::QueryEngine;
use kcoder_types::integrations::core::*;
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub(super) mod configuration;
use configuration::EngineSnapshot;

#[derive(Debug, Clone, Copy)]
pub(crate) enum NativeKnowledgeRpcMethod {
    Knowledge(IntegrationKnowledgeMethod),
    Automation(IntegrationAutomationMethod),
}
impl NativeKnowledgeRpcMethod {
    pub(crate) fn parse(method: &str) -> Option<Self> {
        IntegrationKnowledgeMethod::parse(method)
            .map(Self::Knowledge)
            .or_else(|| IntegrationAutomationMethod::parse(method).map(Self::Automation))
    }
    pub(crate) fn port(self) -> IntegrationPort {
        match self {
            Self::Knowledge(_) => IntegrationPort::Knowledge,
            Self::Automation(_) => IntegrationPort::Automation,
        }
    }
    pub(crate) fn port_method(self) -> &'static str {
        match self {
            Self::Knowledge(method) => method.port_method(),
            Self::Automation(method) => method.port_method(),
        }
    }
    pub(crate) fn mutation(self) -> bool {
        match self {
            Self::Knowledge(method) => method.mutation(),
            Self::Automation(method) => method.mutation(),
        }
    }
}

struct CachedHost {
    fingerprint: String,
    host: Arc<NativeKnowledgeHost>,
}
#[cfg(test)]
fn same_provider<T: ?Sized>(left: &Option<Arc<T>>, right: &Option<Arc<T>>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => Arc::ptr_eq(left, right),
        _ => false,
    }
}

struct NativeRuntimeDependencies {
    runtime: Arc<dyn KnowledgeDependencyPort>,
    other: Option<Arc<dyn KnowledgeDependencyPort>>,
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl KnowledgeDependencyPort for NativeRuntimeDependencies {
    fn registered(&self, port: IntegrationPort, method: &str) -> bool {
        if port == IntegrationPort::Runtime {
            self.runtime.registered(port, method)
        } else {
            self.other
                .as_ref()
                .is_some_and(|other| other.registered(port, method))
        }
    }
    async fn call_authorized_delivery(
        &self,
        proof: Arc<super::NativeAutomationDeliveryUse>,
    ) -> IntegrationReply {
        if let Some(other) = &self.other {
            return other.call_authorized_delivery(proof).await;
        }
        super::dependencies::unavailable_delivery(proof.request())
    }
    async fn call(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
    ) -> IntegrationReply {
        if port == IntegrationPort::Runtime {
            return self.runtime.call(port, method, request).await;
        }
        if let Some(other) = &self.other {
            return other.call(port, method, request).await;
        }
        IntegrationReply {
            contract_version: request.contract_version,
            request_id: request.request_id.clone(),
            status: IntegrationStatus::Unavailable,
            operation_id: request
                .operation_id
                .clone()
                .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
            entity_revision: IntegrationNullable::Null,
            observed_at: chrono::Utc::now().to_rfc3339(),
            result: IntegrationNullable::Null,
            error: IntegrationNullable::Value(IntegrationError {
                code: "KNOWLEDGE_DEPENDENCY_UNAVAILABLE".into(),
                recovery: IntegrationRecovery::RetryRead,
                message_key: "integrations.knowledge.dependencyUnavailable".into(),
            }),
        }
    }
}

/// One cache belongs to one original app-server connection. Drop it on owner teardown.
#[derive(Default)]
pub(crate) struct NativeKnowledgeRpc {
    cached: Option<CachedHost>,
    policy: Option<Arc<dyn KnowledgePolicyEvaluator>>,
    dependencies: Option<Arc<dyn KnowledgeDependencyPort>>,
    configured_dependencies: Option<Arc<dyn KnowledgeDependencyPort>>,
    file_events: Vec<Arc<super::native_host::NativeFileEventBinding>>,
    application_events: Arc<super::native_host::application_events::NativeApplicationEventSources>,
    native_runtime_bound: bool,
    is_request_fork: bool,
}
impl std::fmt::Debug for NativeKnowledgeRpc {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeKnowledgeRpc")
            .field("cached", &self.cached.is_some())
            .field("native_policy", &self.policy.is_some())
            .field("native_dependencies", &self.dependencies.is_some())
            .finish()
    }
}
impl NativeKnowledgeRpc {
    /// Root drops its connection mutex before awaiting a domain dependency.
    /// The fork shares the current host's revocation epoch, not a new authority.
    pub(crate) fn request_fork(
        &mut self,
        native: &mut NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<Self> {
        native.refresh_configuration_revision(
            engine.active_model_configuration_summary()?.revision,
        )?;
        let snapshot = EngineSnapshot::capture(engine)?;
        snapshot.verify_binding(engine, native)?;
        let host = self.host(native, &snapshot)?;
        Ok(Self {
            cached: Some(CachedHost {
                fingerprint: snapshot.fingerprint,
                host,
            }),
            policy: self.policy.clone(),
            dependencies: self.dependencies.clone(),
            configured_dependencies: self.configured_dependencies.clone(),
            file_events: self.file_events.clone(),
            application_events: self.application_events.clone(),
            native_runtime_bound: self.native_runtime_bound,
            is_request_fork: true,
        })
    }
    pub(crate) fn host_for_engine(
        &mut self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<Arc<NativeKnowledgeHost>> {
        let snapshot = EngineSnapshot::capture(engine)?;
        snapshot.verify_binding(engine, native)?;
        self.host(native, &snapshot)
    }
    #[cfg(test)]
    pub(crate) fn set_policy(&mut self, policy: Option<Arc<dyn KnowledgePolicyEvaluator>>) {
        if same_provider(&self.policy, &policy) {
            return;
        }
        self.clear();
        self.policy = policy;
    }
    #[cfg(test)]
    pub(crate) fn set_dependencies(
        &mut self,
        dependencies: Option<Arc<dyn KnowledgeDependencyPort>>,
    ) {
        // Compare the caller's actual provider, not the native Runtime wrapper.
        // Reinstalling that same Arc must retain the current Runtime and lease.
        if same_provider(&self.configured_dependencies, &dependencies) {
            return;
        }
        self.clear();
        self.configured_dependencies = dependencies.clone();
        self.dependencies = dependencies;
        self.native_runtime_bound = false;
    }
    pub(crate) fn install_application_event_source(
        &mut self,
        scope: &IntegrationScope,
        selected: Arc<super::native_application_selection::NativeApplicationReadAuthority>,
    ) -> Result<()> {
        // Cached hosts already share this exact source map. An independent new
        // selection must not revoke peer runs through a global host invalidation.
        self.application_events.install(scope, selected)?;
        Ok(())
    }
    pub(crate) fn has_native_runtime_binding(&self) -> bool {
        self.native_runtime_bound
    }
    /// Only the native selection/read-authority producer can construct these
    /// objects. This is not exposed as a path, permission bool or JSON source.
    pub(crate) fn bind_file_event_sources(
        &mut self,
        native: &NativeIntegrationContext,
        bindings: Vec<Arc<super::native_host::NativeFileEventBinding>>,
    ) -> Result<()> {
        anyhow::ensure!(bindings.len() <= 16, "AUTOMATION_EVENT_SOURCE_LIMIT");
        let mut references = std::collections::BTreeSet::new();
        for binding in &bindings {
            binding.verify(native)?;
            anyhow::ensure!(
                references.insert(binding.source_ref()),
                "AUTOMATION_EVENT_SOURCE_DUPLICATE"
            );
        }
        if self.file_events.len() == bindings.len()
            && self
                .file_events
                .iter()
                .zip(&bindings)
                .all(|(old, new)| Arc::ptr_eq(old, new))
        {
            return Ok(());
        }
        self.clear();
        self.file_events = bindings;
        Ok(())
    }
    pub(crate) fn file_event_source(
        &self,
        reference: &str,
    ) -> Option<Arc<super::native_host::NativeFileEventBinding>> {
        self.file_events
            .iter()
            .find(|binding| binding.source_ref() == reference)
            .cloned()
    }
    pub(crate) fn install_file_event_source(
        &mut self,
        native: &NativeIntegrationContext,
        binding: Arc<super::native_host::NativeFileEventBinding>,
    ) -> Result<()> {
        let mut sources = self.file_events.clone();
        if let Some(index) = sources
            .iter()
            .position(|old| old.source_ref() == binding.source_ref())
        {
            sources[index] = binding;
        } else {
            sources.push(binding);
        }
        self.bind_file_event_sources(native, sources)
    }
    pub(crate) fn bind_native_runtime(&mut self, runtime: Arc<dyn KnowledgeDependencyPort>) {
        if self.native_runtime_bound {
            return;
        }
        self.clear();
        let other = self.dependencies.take();
        self.dependencies = Some(Arc::new(NativeRuntimeDependencies { runtime, other }));
        self.native_runtime_bound = true;
    }
    pub(crate) fn clear(&mut self) {
        if let Some(cached) = self.cached.take()
            && !self.is_request_fork
        {
            cached.host.invalidate_runtime_sources();
        }
    }
    fn host(
        &mut self,
        native: &NativeIntegrationContext,
        snapshot: &EngineSnapshot,
    ) -> Result<Arc<NativeKnowledgeHost>> {
        if self.cached.as_ref().is_some_and(|cached| {
            cached.fingerprint != snapshot.fingerprint || cached.host.scope() != native.scope()
        }) {
            self.clear();
        }
        if self.cached.is_none() {
            let mut host = NativeKnowledgeHost::new(native, snapshot.settings.clone())?;
            if snapshot.settings.publications_enabled {
                host = host.with_wiki_resolver(Arc::new(ExistingProfileWikiResolver::new(
                    native,
                    snapshot.path()?,
                )?));
            }
            if let Some(policy) = &self.policy {
                host = host.with_policy(policy.clone());
            }
            if let Some(dependencies) = &self.dependencies {
                host = host.with_dependencies(dependencies.clone());
            }
            host = host.with_file_event_bindings(self.file_events.clone())?;
            host.application_events = self.application_events.clone();
            self.cached = Some(CachedHost {
                fingerprint: snapshot.fingerprint.clone(),
                host: Arc::new(host),
            });
        }
        Ok(self
            .cached
            .as_ref()
            .ok_or_else(|| anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))?
            .host
            .clone())
    }
}

/// Does not initialize domain storage or advertise unavailable execution providers as ready.
pub(crate) fn native_knowledge_capabilities(
    engine: &QueryEngine,
    context: &NativeIntegrationContext,
) -> Result<Vec<&'static str>> {
    use kcoder_app_protocol::integrations::knowledge_host::{
        CAPABILITY_AUTOMATION_PERIOD_BUDGETS_V1, CAPABILITY_AUTOMATION_TASK_MODELS_V1,
        CAPABILITY_AUTOMATION_TEMPLATES_V1, CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1,
    };
    let snapshot = EngineSnapshot::capture(engine)?;
    snapshot.verify_binding(engine, context)?;
    let mut capabilities = Vec::new();
    if snapshot.settings.publications_enabled {
        capabilities.push(CAPABILITY_KNOWLEDGE_PUBLICATIONS_V1);
    }
    if snapshot.settings.business_automation_enabled {
        capabilities.push(CAPABILITY_AUTOMATION_TEMPLATES_V1);
        capabilities.push(CAPABILITY_AUTOMATION_TASK_MODELS_V1);
        if context.scope().organization_id.is_none() {
            capabilities.push(CAPABILITY_AUTOMATION_PERIOD_BUDGETS_V1);
        }
    }
    Ok(capabilities)
}

/// The root must pass its original owner token and a native user-action fact, never payload flags.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn request_knowledge_automation(
    method: &str,
    params: Value,
    engine: &QueryEngine,
    context: &mut NativeIntegrationContext,
    cached: &mut NativeKnowledgeRpc,
    explicit_user_action: bool,
    owner_cancel: &CancellationToken,
) -> Result<IntegrationReply> {
    let method = NativeKnowledgeRpcMethod::parse(method)
        .ok_or_else(|| anyhow!("KNOWLEDGE_RPC_METHOD_UNSUPPORTED"))?;
    let request: IntegrationRequest =
        rpc_codec::decode(params).map_err(|_| anyhow!("KNOWLEDGE_RPC_INVALID_REQUEST"))?;
    request
        .validate(method.mutation())
        .map_err(|_| anyhow!("KNOWLEDGE_RPC_INVALID_REQUEST"))?;
    if owner_cancel.is_cancelled() {
        return Ok(failure(
            &request,
            IntegrationStatus::Rejected,
            "KNOWLEDGE_RPC_CANCELLED_BEFORE_DISPATCH",
            IntegrationRecovery::None,
        ));
    }
    if method.mutation() && !explicit_user_action {
        return Ok(failure(
            &request,
            IntegrationStatus::Rejected,
            if matches!(method, NativeKnowledgeRpcMethod::Knowledge(_)) {
                "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED"
            } else {
                "AUTOMATION_EXPLICIT_CONSENT_REQUIRED"
            },
            IntegrationRecovery::ExplicitUserDecision,
        ));
    }
    let start = Instant::now();
    let snapshot = match EngineSnapshot::capture(engine) {
        Ok(snapshot) => snapshot,
        Err(_) => {
            cached.clear();
            return Ok(failure(
                &request,
                IntegrationStatus::Unavailable,
                "KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE",
                IntegrationRecovery::RepairConfiguration,
            ));
        }
    };
    if snapshot.path().is_err() {
        cached.clear();
        return Ok(failure(
            &request,
            IntegrationStatus::Unavailable,
            "KNOWLEDGE_RPC_CONFIGURATION_UNAVAILABLE",
            IntegrationRecovery::RepairConfiguration,
        ));
    }
    if context
        .refresh_configuration_revision(snapshot.revision.clone())
        .is_err()
        || context.validate_scope(&request.scope).is_err()
        || snapshot.verify_binding(engine, context).is_err()
    {
        cached.clear();
        return Ok(failure(
            &request,
            IntegrationStatus::Rejected,
            "KNOWLEDGE_CALLER_SCOPE_MISMATCH",
            IntegrationRecovery::RequestAuthorization,
        ));
    }
    if cached.cached.as_ref().is_some_and(|host| {
        host.fingerprint != snapshot.fingerprint || host.host.scope() != context.scope()
    }) {
        cached.clear();
    }
    let enabled = match method {
        NativeKnowledgeRpcMethod::Knowledge(_) => snapshot.settings.publications_enabled,
        NativeKnowledgeRpcMethod::Automation(_) => snapshot.settings.business_automation_enabled,
    };
    if !enabled {
        return Ok(failure(
            &request,
            IntegrationStatus::Unavailable,
            if matches!(method, NativeKnowledgeRpcMethod::Knowledge(_)) {
                "KNOWLEDGE_NATIVE_FEATURE_UNAVAILABLE"
            } else {
                "AUTOMATION_NATIVE_FEATURE_UNAVAILABLE"
            },
            IntegrationRecovery::RepairConfiguration,
        ));
    }
    let host = match cached.host(context, &snapshot) {
        Ok(host) => host,
        Err(_) => {
            cached.clear();
            return Ok(failure(
                &request,
                IntegrationStatus::Unavailable,
                "KNOWLEDGE_NATIVE_STORE_UNAVAILABLE",
                IntegrationRecovery::RepairConfiguration,
            ));
        }
    };
    let budget = Duration::from_millis(request.timeout_ms);
    if !host.runtime_sources_current() {
        return Ok(failure(
            &request,
            IntegrationStatus::Rejected,
            "KNOWLEDGE_RPC_CONFIGURATION_CHANGED",
            IntegrationRecovery::RetryRead,
        ));
    }
    let Some(remaining) = budget.checked_sub(start.elapsed()) else {
        return Ok(failure(
            &request,
            IntegrationStatus::Rejected,
            "KNOWLEDGE_RPC_EXPIRED_BEFORE_DISPATCH",
            IntegrationRecovery::None,
        ));
    };
    let cancellation = owner_cancel.child_token();
    let now_ms = u64::try_from(chrono::Utc::now().timestamp_millis())
        .map_err(|_| anyhow!("KNOWLEDGE_INVALID_CLOCK"))?;
    let reply = tokio::select! {
        biased;
        _ = owner_cancel.cancelled() => None,
        _ = tokio::time::sleep(remaining) => None,
        reply = host.dispatch(method.port(), method.port_method(), &request, explicit_user_action, now_ms, &cancellation) => Some(reply),
    };
    cancellation.cancel();
    if owner_cancel.is_cancelled() || start.elapsed() >= budget || reply.is_none() {
        return Ok(failure(
            &request,
            if method.mutation() {
                IntegrationStatus::Unknown
            } else {
                IntegrationStatus::Unavailable
            },
            "KNOWLEDGE_RPC_RESULT_UNCONFIRMED",
            if method.mutation() {
                IntegrationRecovery::ReconcileOriginal
            } else {
                IntegrationRecovery::RetryRead
            },
        ));
    }
    if context.validate_scope(&request.scope).is_err() {
        cached.clear();
        return Ok(failure(
            &request,
            if method.mutation() {
                IntegrationStatus::Unknown
            } else {
                IntegrationStatus::Rejected
            },
            "KNOWLEDGE_CALLER_SCOPE_MISMATCH",
            if method.mutation() {
                IntegrationRecovery::ReconcileOriginal
            } else {
                IntegrationRecovery::RequestAuthorization
            },
        ));
    }
    if !host.runtime_sources_current()
        || EngineSnapshot::capture(engine)
            .as_ref()
            .map_or(true, |current| {
                current.fingerprint != snapshot.fingerprint
                    || current.verify_binding(engine, context).is_err()
            })
    {
        cached.clear();
        return Ok(failure(
            &request,
            if method.mutation() {
                IntegrationStatus::Unknown
            } else {
                IntegrationStatus::Unavailable
            },
            "KNOWLEDGE_RPC_CONFIGURATION_CHANGED",
            if method.mutation() {
                IntegrationRecovery::ReconcileOriginal
            } else {
                IntegrationRecovery::RepairConfiguration
            },
        ));
    }
    let reply = reply.ok_or_else(|| anyhow!("KNOWLEDGE_RPC_RESULT_UNCONFIRMED"))?;
    if reply.validate().is_err()
        || super::dependencies::validate_dependency_reply(&request, &reply).is_err()
    {
        return Ok(failure(
            &request,
            if method.mutation() {
                IntegrationStatus::Unknown
            } else {
                IntegrationStatus::Unavailable
            },
            "KNOWLEDGE_RPC_INVALID_RECEIPT",
            if method.mutation() {
                IntegrationRecovery::ReconcileOriginal
            } else {
                IntegrationRecovery::RetryRead
            },
        ));
    }
    Ok(reply)
}

fn failure(
    request: &IntegrationRequest,
    status: IntegrationStatus,
    code: &str,
    recovery: IntegrationRecovery,
) -> IntegrationReply {
    IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        status,
        entity_revision: IntegrationNullable::Null,
        observed_at: chrono::Utc::now().to_rfc3339(),
        result: IntegrationNullable::Null,
        error: IntegrationNullable::Value(IntegrationError {
            code: code.into(),
            recovery,
            message_key: "knowledgeIntegration.operationFailed".into(),
        }),
    }
}

#[cfg(test)]
mod tests;
