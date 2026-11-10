use super::*;
use crate::app_server::integrations::connectivity::NativeMcpSourceSelector;
use kcoder_engine::integrations::core::{
    NativeEngineEventFrame, NativeToolEmitterWitness, NativeToolExecutionWitness,
};
use kcoder_engine::integrations::core::{NativeToolAuthorization, NativeToolAuthorizationError};
use kcoder_tools::ToolSource;
use std::sync::{Arc, Mutex};

fn source_boundary_unavailable(
    stage: &'static str,
    error: anyhow::Error,
) -> NativeToolAuthorizationError {
    let code = super::super::task_capability_scope_runtime::safe_source_error(&error);
    tracing::warn!(source_guard_stage=stage,source_guard_code=%code,"Native task source boundary unavailable");
    NativeToolAuthorizationError::Unavailable
}

fn native_desktop_authorized(emitter: &NativeToolEmitterWitness) -> Option<bool> {
    let desktop = emitter.downcast_tool::<kcoder_mcp::desktop_tool::DesktopTool>()?;
    Some(desktop.native_lease_active() && emitter.authorizes_desktop_owner(desktop.native_owner()))
}

/// Declare the real target before acceptance. An unbound guard always refuses.
pub(crate) enum NativeTaskCapabilityScopePendingTarget {
    RuntimeOperation(String),
    StudioTurn(TurnAttemptIdentity),
}

pub(crate) struct NativeTaskCapabilityScopeGuard {
    context: Arc<NativeIntegrationContext>,
    expected: NativeTaskCapabilityScopePendingTarget,
    catalog: Arc<NativeConnectivitySourceCatalog>,
    facts: Arc<dyn NativeTaskCapabilityScopeFacts>,
    binding: Mutex<Option<Arc<NativeTaskCapabilityScopeBinding>>>,
}
impl NativeTaskCapabilityScopeGuard {
    /// Only an already finished empty-source channel turn can move to another native turn.
    pub(crate) fn verify_empty_channel_continuation(
        &self,
        native: &NativeIntegrationContext,
        operation: &str,
        completed: &TurnAttemptIdentity,
    ) -> Result<()> {
        native.validate_scope(self.context.scope())?;
        ensure!(
            matches!(&self.expected,NativeTaskCapabilityScopePendingTarget::RuntimeOperation(original) if original==operation),
            "TASK_CAPABILITY_SCOPE_ORIGINAL_CHANNEL_REQUIRED"
        );
        let binding = self.bound()?;
        ensure!(
            binding.accepted.runtime_operation_id() == Some(operation)
                && binding.accepted.thread_id() == completed.thread_id
                && binding.accepted.initial_attempt().turn_id == completed.turn_id,
            "TASK_CAPABILITY_SCOPE_ORIGINAL_CHANNEL_REQUIRED"
        );
        let snapshot = binding.child_tool_snapshot(native)?;
        ensure!(
            snapshot.effective_from == IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot
                && snapshot.effective_sources.is_empty()
                && snapshot
                    .effective_resource_bindings
                    .as_ref()
                    .is_none_or(Vec::is_empty),
            "TASK_CAPABILITY_SCOPE_CHANNEL_INHERITANCE_UNSUPPORTED"
        );
        Ok(())
    }
    pub(crate) fn pending(
        context: Arc<NativeIntegrationContext>,
        expected: NativeTaskCapabilityScopePendingTarget,
        catalog: Arc<NativeConnectivitySourceCatalog>,
        facts: Arc<dyn NativeTaskCapabilityScopeFacts>,
    ) -> Result<Self> {
        context.verify()?;
        match &expected {
            NativeTaskCapabilityScopePendingTarget::RuntimeOperation(id) => atom(id)?,
            NativeTaskCapabilityScopePendingTarget::StudioTurn(id) => {
                id.validate().map_err(anyhow::Error::msg)?
            }
        }
        Ok(Self {
            context,
            expected,
            catalog,
            facts,
            binding: Mutex::new(None),
        })
    }
    /// Root calls this only after the real private Accepted commit. It is not an RPC.
    /// A child inherits this same slot and can never replace its root binding.
    pub(crate) async fn bind(&self, binding: Arc<NativeTaskCapabilityScopeBinding>) -> Result<()> {
        binding
            .accepted
            .verify(&self.context, self.facts.as_ref())
            .await?;
        ensure!(
            match &self.expected {
                NativeTaskCapabilityScopePendingTarget::RuntimeOperation(operation) =>
                    binding.accepted.runtime_operation_id() == Some(operation.as_str()),
                NativeTaskCapabilityScopePendingTarget::StudioTurn(attempt) =>
                    binding.accepted.runtime_operation_id().is_none()
                        && binding.accepted.initial_attempt() == attempt,
            },
            "TASK_CAPABILITY_SCOPE_GUARD_TARGET_MISMATCH"
        );
        binding.snapshot(&self.context, self.facts.as_ref()).await?;
        let mut slot = self
            .binding
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_GUARD_UNAVAILABLE"))?;
        if let Some(original) = slot.as_ref() {
            ensure!(
                original.task_key()? == binding.task_key()?,
                "TASK_CAPABILITY_SCOPE_GUARD_ALREADY_BOUND"
            );
            return Ok(());
        }
        *slot = Some(binding);
        Ok(())
    }
    fn bound(&self) -> Result<Arc<NativeTaskCapabilityScopeBinding>> {
        self.binding
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_GUARD_UNAVAILABLE"))?
            .clone()
            .context("TASK_CAPABILITY_SCOPE_GUARD_NOT_BOUND")
    }
    async fn check_tool(&self, request: &NativeToolAuthorizationRequest<'_>) -> Result<bool> {
        let binding = self.bound()?;
        if request.phase
            == kcoder_engine::integrations::core::NativeToolAuthorizationPhase::Admission
            && binding
                .snapshot(&self.context, self.facts.as_ref())
                .await?
                .effective_from
                == IntegrationTaskCapabilityScopeBoundary::NextToolBoundary
        {
            self.facts
                .reconcile_pending_selection(&self.context, &binding)
                .await?;
        }
        let witness = request
            .execution
            .context("TASK_CAPABILITY_SCOPE_NATIVE_EMITTER_REQUIRED")?;
        let emitter = request
            .emitter
            .context("TASK_CAPABILITY_SCOPE_REGISTERED_EMITTER_REQUIRED")?;
        ensure!(
            std::ptr::eq(witness, emitter.execution())
                && emitter.tool_name() == request.tool_name
                && emitter.source() == &request.source,
            "TASK_CAPABILITY_SCOPE_REGISTERED_EMITTER_MISMATCH"
        );
        let attempt = witness
            .attempt()
            .context("TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_REQUIRED")?;
        ensure!(
            witness.session_id() == request.session_id,
            "TASK_CAPABILITY_SCOPE_EMITTER_SESSION_MISMATCH"
        );
        binding
            .accepted
            .verify(&self.context, self.facts.as_ref())
            .await?;
        let execution = self
            .facts
            .execution_for_tool(&self.context, &binding.accepted, request)
            .await?;
        binding
            .accepted
            .check_execution(&self.context, request.session_id, &execution, true)?;
        ensure!(
            execution
                .current_attempt
                .as_ref()
                .map(|record| &record.identity)
                == Some(attempt),
            "TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_MISMATCH"
        );
        self.check_native_parent(&binding, witness, &execution)?;
        // Desktop tools are late-bound native capabilities, not MCP connections.
        // Keep Accepted/attempt/lineage checks above and require the concrete
        // registered object, its acquired lease and the still-live host grant.
        if let Some(authorized) = native_desktop_authorized(emitter) {
            return Ok(authorized);
        }
        let selector = match &request.source {
            ToolSource::Builtin | ToolSource::NativeFeature { .. } => return Ok(true),
            ToolSource::Mcp { server, .. } => NativeMcpSourceSelector {
                server: server.clone(),
                plugin: None,
            },
            ToolSource::Plugin { plugin, server, .. } => NativeMcpSourceSelector {
                server: server.clone(),
                plugin: Some(plugin.clone()),
            },
        };
        if !self
            .check_selector(
                &binding,
                &selector,
                execution.emitter_source.as_deref(),
                false,
            )
            .await?
        {
            return Ok(false);
        }
        let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        let Some(resources) = &snapshot.effective_resource_bindings else {
            return Ok(true);
        };
        let allowed = self
            .facts
            .authorize_resource_tool(&self.context, resources, request)
            .await?;
        let current = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        ensure!(current == snapshot, "TASK_RESOURCE_CHANGED_DURING_CHECK");
        Ok(allowed)
    }
    fn check_native_parent(
        &self,
        binding: &NativeTaskCapabilityScopeBinding,
        witness: &NativeToolExecutionWitness,
        execution: &NativeTaskCapabilityScopeExecution,
    ) -> Result<()> {
        match (witness.parent(), execution.lineage.last()) {
            (None, None) => ensure!(
                witness.session_id() == binding.accepted.thread_id(),
                "TASK_CAPABILITY_SCOPE_LINEAGE_REQUIRED"
            ),
            (Some(parent), Some(edge)) => {
                ensure!(
                    parent.session_id() == edge.run.parent_session_id
                        && parent.agent_id() == edge.run.agent_id,
                    "TASK_CAPABILITY_SCOPE_NATIVE_PARENT_MISMATCH"
                );
                if let Some(run) = parent.background_run() {
                    ensure!(
                        run == &edge.run,
                        "TASK_CAPABILITY_SCOPE_NATIVE_RUN_MISMATCH"
                    );
                }
            }
            _ => anyhow::bail!("TASK_CAPABILITY_SCOPE_NATIVE_PARENT_REQUIRED"),
        }
        Ok(())
    }
    /// Root may run this before Provider work. It does not manufacture a Tool
    /// request or accept callback JSON as native model-execution authority.
    pub(crate) async fn verify_provider_boundary(
        &self,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
    ) -> Result<()> {
        let binding = self.bound()?;
        if binding
            .snapshot(&self.context, self.facts.as_ref())
            .await?
            .effective_from
            == IntegrationTaskCapabilityScopeBoundary::NextToolBoundary
        {
            self.facts
                .reconcile_pending_selection(&self.context, &binding)
                .await?;
        }
        let witness = callback
            .native_witness
            .downcast_ref::<NativeToolExecutionWitness>()
            .context("TASK_CAPABILITY_SCOPE_NATIVE_EMITTER_REQUIRED")?;
        let attempt = witness
            .attempt()
            .context("TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_REQUIRED")?;
        ensure!(
            witness.session_id() == callback.session_id,
            "TASK_CAPABILITY_SCOPE_EMITTER_SESSION_MISMATCH"
        );
        binding
            .accepted
            .verify(&self.context, self.facts.as_ref())
            .await?;
        let execution = self
            .facts
            .execution_for_callback(
                &self.context,
                &binding.accepted,
                callback,
                NativeTaskCapabilityScopeCallbackPurpose::Provider,
            )
            .await?;
        binding
            .accepted
            .check_execution(&self.context, callback.session_id, &execution, true)?;
        ensure!(
            execution
                .current_attempt
                .as_ref()
                .map(|record| &record.identity)
                == Some(attempt),
            "TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_MISMATCH"
        );
        self.check_native_parent(&binding, witness, &execution)?;
        let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        ensure!(
            snapshot.effective_from == IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot,
            "TASK_CAPABILITY_SCOPE_PENDING_BOUNDARY"
        );
        self.verify_unattributed_sources(&binding, &snapshot).await
    }
    async fn verify_unattributed_sources(
        &self,
        binding: &NativeTaskCapabilityScopeBinding,
        snapshot: &IntegrationTaskCapabilityScopeSnapshot,
    ) -> Result<()> {
        if !snapshot.effective_sources.is_empty() {
            let facts = self.facts.sources(&self.context).await?;
            for choice in &snapshot.effective_sources {
                self.catalog.resolve_choice(&self.context, choice, &facts)?;
            }
        }
        let current = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        ensure!(
            current.revision == snapshot.revision
                && current.effective_from == snapshot.effective_from,
            "TASK_CAPABILITY_SCOPE_CHANGED_DURING_CHECK"
        );
        Ok(())
    }
    async fn verify_event_boundary(&self, frame: &NativeEngineEventFrame) -> Result<()> {
        let binding = self.bound()?;
        let witness = frame.execution();
        let attempt = witness
            .attempt()
            .context("TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_REQUIRED")?;
        // A nested background projection is not proof of that nested child's
        // original TI. Its separate native owner forwarding gate is retained.
        ensure!(
            !matches!(
                frame.event(),
                kcoder_engine::EngineEvent::BackgroundScoped { .. }
            ),
            "TASK_CAPABILITY_SCOPE_NESTED_EVENT_ORIGIN_REQUIRED"
        );
        let callback = NativeTaskCapabilityScopeCallback {
            session_id: witness.session_id(),
            native_witness: frame,
        };
        binding
            .accepted
            .verify(&self.context, self.facts.as_ref())
            .await?;
        let execution = self
            .facts
            .execution_for_callback(
                &self.context,
                &binding.accepted,
                &callback,
                NativeTaskCapabilityScopeCallbackPurpose::Event,
            )
            .await?;
        binding
            .accepted
            .check_execution(&self.context, callback.session_id, &execution, true)?;
        ensure!(
            execution
                .current_attempt
                .as_ref()
                .map(|record| &record.identity)
                == Some(attempt),
            "TASK_CAPABILITY_SCOPE_EMITTER_ATTEMPT_MISMATCH"
        );
        self.check_native_parent(&binding, witness, &execution)?;
        if frame.has_tool_identity() {
            let tool = frame
                .tool()
                .context("TASK_CAPABILITY_SCOPE_REGISTERED_EMITTER_REQUIRED")?;
            if let Some(authorized) = native_desktop_authorized(tool) {
                ensure!(authorized, "TASK_CAPABILITY_SCOPE_DESKTOP_AUTHORITY_DENIED");
                let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
                return self.verify_unattributed_sources(&binding, &snapshot).await;
            }
            let selector = match tool.source() {
                ToolSource::Mcp { server, .. } => Some(NativeMcpSourceSelector {
                    server: server.clone(),
                    plugin: None,
                }),
                ToolSource::Plugin { plugin, server, .. } => Some(NativeMcpSourceSelector {
                    server: server.clone(),
                    plugin: Some(plugin.clone()),
                }),
                _ => None,
            };
            if let Some(selector) = selector {
                ensure!(
                    self.check_selector(
                        &binding,
                        &selector,
                        execution.emitter_source.as_deref(),
                        true
                    )
                    .await?,
                    "TASK_CAPABILITY_SCOPE_EVENT_SOURCE_DENIED"
                );
                return Ok(());
            }
        }
        let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        self.verify_unattributed_sources(&binding, &snapshot).await
    }
    async fn check_selector(
        &self,
        binding: &NativeTaskCapabilityScopeBinding,
        selector: &NativeMcpSourceSelector,
        emitter_source: Option<&NativeMcpSourceFact>,
        allow_pending: bool,
    ) -> Result<bool> {
        let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        if !allow_pending
            && snapshot.effective_from != IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot
        {
            return Ok(false);
        }
        if snapshot.effective_sources.is_empty() {
            return Ok(false);
        }
        let emitter_source =
            emitter_source.context("TASK_CAPABILITY_SCOPE_EMITTER_SOURCE_REQUIRED")?;
        if !emitter_source.matches_selector(selector) {
            return Ok(false);
        }
        let facts = self.facts.sources(&self.context).await?;
        let mut allowed = false;
        for choice in &snapshot.effective_sources {
            // A revoked peer source must not grant anything, nor disable a
            // distinct still-valid selected source. Only an exact native match allows.
            if let Ok(current) = self.catalog.resolve_choice(&self.context, choice, &facts)
                && current == *selector
                && self
                    .catalog
                    .resolve_choice(&self.context, choice, std::slice::from_ref(emitter_source))
                    .is_ok_and(|actual| actual == *selector)
            {
                allowed = true;
                break;
            }
        }
        let current = binding.snapshot(&self.context, self.facts.as_ref()).await?;
        ensure!(
            current.revision == snapshot.revision
                && current.effective_from == snapshot.effective_from,
            "TASK_CAPABILITY_SCOPE_CHANGED_DURING_CHECK"
        );
        Ok(allowed)
    }
    async fn check_callback(
        &self,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
        selector: &NativeMcpSourceSelector,
        purpose: NativeTaskCapabilityScopeCallbackPurpose,
    ) -> Result<bool> {
        let binding = self.bound()?;
        if binding
            .snapshot(&self.context, self.facts.as_ref())
            .await?
            .effective_from
            == IntegrationTaskCapabilityScopeBoundary::NextToolBoundary
        {
            self.facts
                .reconcile_pending_selection(&self.context, &binding)
                .await?;
        }
        binding
            .accepted
            .verify(&self.context, self.facts.as_ref())
            .await?;
        let execution = self
            .facts
            .execution_for_callback(&self.context, &binding.accepted, callback, purpose)
            .await?;
        // An explicit native App/resource action may outlive its model turn.
        // The required callback adapter validates its real native owner/lease;
        // the immutable accepted origin and source restriction remain in force.
        binding
            .accepted
            .check_execution(&self.context, callback.session_id, &execution, false)?;
        self.check_selector(
            &binding,
            selector,
            execution.emitter_source.as_deref(),
            false,
        )
        .await
    }
    #[cfg(test)]
    pub(crate) async fn authorize_resource_source(
        &self,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
        selector: &NativeMcpSourceSelector,
    ) -> Result<()> {
        ensure!(
            self.check_callback(
                callback,
                selector,
                NativeTaskCapabilityScopeCallbackPurpose::Resource
            )
            .await?,
            "TASK_CAPABILITY_SCOPE_RESOURCE_DENIED"
        );
        Ok(())
    }
    #[cfg(test)]
    pub(crate) async fn authorize_app_source(
        &self,
        callback: &NativeTaskCapabilityScopeCallback<'_>,
        selector: &NativeMcpSourceSelector,
    ) -> Result<()> {
        ensure!(
            self.check_callback(
                callback,
                selector,
                NativeTaskCapabilityScopeCallbackPurpose::App
            )
            .await?,
            "TASK_CAPABILITY_SCOPE_APP_DENIED"
        );
        Ok(())
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeToolAuthorization for NativeTaskCapabilityScopeGuard {
    fn inherited_resource_tools(
        &self,
        registered: &kcoder_tools::ToolRegistry,
    ) -> std::result::Result<Option<Vec<Arc<dyn kcoder_tools::Tool>>>, NativeToolAuthorizationError>
    {
        let verify = || {
            let binding = self.bound()?;
            let snapshot = binding.child_tool_snapshot(&self.context)?;
            let Some(bindings) = snapshot.effective_resource_bindings else {
                return Ok(None);
            };
            ensure!(
                snapshot.effective_from == IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot,
                "TASK_RESOURCE_PENDING_BOUNDARY"
            );
            let bindings = bindings
                .into_iter()
                .filter(|binding| snapshot.effective_sources.contains(&binding.source))
                .collect::<Vec<_>>();
            if bindings.is_empty() {
                return Ok(Some(Vec::new()));
            }
            Ok(Some(self.facts.inherited_resource_tools(
                &self.context,
                &bindings,
                registered,
            )?))
        };
        verify().map_err(|error| source_boundary_unavailable("child_catalog", error))
    }

    async fn authorize_child(
        &self,
        request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let verify = async {
            let binding = self.bound()?;
            binding
                .accepted
                .verify(&self.context, self.facts.as_ref())
                .await?;
            let original = request.parent_execution();
            let callback = NativeTaskCapabilityScopeCallback {
                session_id: original.session_id(),
                native_witness: original,
            };
            let execution = self
                .facts
                .execution_for_callback(
                    &self.context,
                    &binding.accepted,
                    &callback,
                    NativeTaskCapabilityScopeCallbackPurpose::ChildAdmission,
                )
                .await?;
            binding.accepted.check_execution(
                &self.context,
                callback.session_id,
                &execution,
                false,
            )?;
            ensure!(
                execution
                    .current_attempt
                    .as_ref()
                    .map(|record| &record.identity)
                    == original.attempt(),
                "TASK_CAPABILITY_SCOPE_ORIGINAL_PARENT_ATTEMPT_CHANGED"
            );
            self.check_native_parent(&binding, original, &execution)?;
            let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
            ensure!(
                snapshot.effective_from == IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot,
                "TASK_CAPABILITY_SCOPE_PENDING_BOUNDARY"
            );
            self.verify_unattributed_sources(&binding, &snapshot)
                .await?;
            self.facts
                .prepare_child(&self.context, &binding, request)
                .await
        }
        .await;
        verify.map_err(|error| source_boundary_unavailable("child_admission", error))
    }
    async fn observe_child_accepted(
        &self,
        request: &kcoder_engine::integrations::core::NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let verify = async {
            let binding = self.bound()?;
            binding
                .accepted
                .verify(&self.context, self.facts.as_ref())
                .await?;
            self.facts
                .observe_child_accepted(&self.context, &binding, request)
                .await
        }
        .await;
        verify.map_err(|error| source_boundary_unavailable("child_accepted", error))
    }
    async fn authorize_provider(
        &self,
        witness: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.verify_provider_boundary(&NativeTaskCapabilityScopeCallback {
            session_id: witness.session_id(),
            native_witness: witness,
        })
        .await
        .map_err(|error| source_boundary_unavailable("provider", error))
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.verify_event_boundary(frame)
            .await
            .map_err(|error| source_boundary_unavailable("event", error))
    }
    async fn authorize_app_callback(
        &self,
        emitter: &kcoder_engine::integrations::core::NativeToolEmitterWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let verify = async {
            let binding = self.bound()?;
            let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
            ensure!(
                snapshot.effective_resource_bindings.is_none(),
                "TASK_RESOURCE_APP_TOOL_SEMANTICS_UNAVAILABLE"
            );
            let selector = match emitter.source() {
                ToolSource::Mcp { server, .. } => NativeMcpSourceSelector {
                    server: server.clone(),
                    plugin: None,
                },
                ToolSource::Plugin { server, plugin, .. } => NativeMcpSourceSelector {
                    server: server.clone(),
                    plugin: Some(plugin.clone()),
                },
                _ => anyhow::bail!("TASK_RESOURCE_NATIVE_SOURCE_REQUIRED"),
            };
            let callback = NativeTaskCapabilityScopeCallback {
                session_id: emitter.execution().session_id(),
                native_witness: emitter,
            };
            ensure!(
                self.check_callback(
                    &callback,
                    &selector,
                    NativeTaskCapabilityScopeCallbackPurpose::App
                )
                .await?,
                "TASK_RESOURCE_APP_SOURCE_DENIED"
            );
            ensure!(
                binding.snapshot(&self.context, self.facts.as_ref()).await? == snapshot,
                "TASK_RESOURCE_CHANGED_DURING_CHECK"
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        verify.map_err(|error| source_boundary_unavailable("app_callback", error))
    }
    async fn authorize_resource(
        &self,
        request: &kcoder_engine::integrations::core::NativeResourceAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let verify = async {
            let binding = self.bound()?;
            let snapshot = binding.snapshot(&self.context, self.facts.as_ref()).await?;
            // Preserve legacy source-only semantics. An explicit empty grant denies.
            let Some(bindings) = &snapshot.effective_resource_bindings else {
                return Ok(());
            };
            let selector = match request.emitter.source() {
                ToolSource::Mcp { server, .. } => NativeMcpSourceSelector {
                    server: server.clone(),
                    plugin: None,
                },
                ToolSource::Plugin { server, plugin, .. } => NativeMcpSourceSelector {
                    server: server.clone(),
                    plugin: Some(plugin.clone()),
                },
                _ => anyhow::bail!("TASK_RESOURCE_NATIVE_SOURCE_REQUIRED"),
            };
            let callback = NativeTaskCapabilityScopeCallback {
                session_id: request.emitter.execution().session_id(),
                native_witness: request.emitter,
            };
            ensure!(
                self.check_callback(
                    &callback,
                    &selector,
                    NativeTaskCapabilityScopeCallbackPurpose::Resource
                )
                .await?,
                "TASK_RESOURCE_SOURCE_DENIED"
            );
            ensure!(
                self.facts
                    .authorize_resource_uri(&self.context, bindings, &selector, request.uri)
                    .await?,
                "TASK_RESOURCE_URI_DENIED"
            );
            ensure!(
                binding.snapshot(&self.context, self.facts.as_ref()).await? == snapshot,
                "TASK_RESOURCE_CHANGED_DURING_CHECK"
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        verify.map_err(|error| source_boundary_unavailable("resource", error))
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        match self.check_tool(request).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(NativeToolAuthorizationError::Denied),
            Err(error) => Err(source_boundary_unavailable("tool", error)),
        }
    }
}
