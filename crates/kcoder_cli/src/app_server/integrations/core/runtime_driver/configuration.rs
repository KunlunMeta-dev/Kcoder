use super::*;
use crate::app_server::thread_runtime::ThreadManager;
use kcoder_engine::QueryEngine;

/// Owned source authority reused before native dispatch and workflow admission.
/// Neither a serialized scope nor a prepared graph constructs this capability.
pub(crate) trait NativeRuntimeAuthority: Send + Sync {
    /// Only a real UI-originated source supplies its original transport lifetime.
    fn client_cancellation(&self) -> Option<tokio_util::sync::CancellationToken> {
        None
    }
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()>;
    /// Verify source-specific admission facts before the synchronous driver commit.
    /// The driver must verify the current caller context before recording the intent.
    fn verify_before_admission_commit(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.verify()?;
        self.verify_admission(context, original, prepared)
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller;
    /// A native source may narrow the original Workflow lifetime to its fixed
    /// task budget. This is not caller JSON or a new execution authority.
    fn workflow_timeout_seconds(&self) -> Option<u64> {
        None
    }
    /// A native source may require an attenuated factory and policy before
    /// thread startup effects. Public thread parameters cannot supply this port.
    fn pre_start(&self) -> Option<NativeRuntimePreStart<'_>> {
        None
    }
    /// Existing native authorities retain their original synchronous evidence.
    /// A source whose current facts live on an owned async pipe supplies that
    /// additional required verifier instead of treating a snapshot as policy.
    fn current_source(&self) -> Option<&dyn NativeRuntimeCurrentSource> {
        None
    }
    /// Observe the actual canonical task, never a model-response completion.
    /// This notification cannot grant execution or manufacture a task state.
    fn observe_task(
        &self,
        _context: &NativeIntegrationContext,
        _original: &IntegrationRequest,
        _task: &IntegrationRuntimeTask,
    ) -> Result<()> {
        Ok(())
    }
    /// Observe only original canonical facts; this grants no asset read or send.
    fn canonical_artifacts(
        &self,
        _context: &NativeIntegrationContext,
        _original: &IntegrationRequest,
        _task: &IntegrationRuntimeTask,
        _engine: &QueryEngine,
    ) -> Result<Vec<IntegrationEntityRef>> {
        Ok(Vec::new())
    }
}
pub(crate) struct NativeRuntimePreStart<'a> {
    pub(crate) factory: &'a crate::app_server::engine_factory::AppServerEngineFactory,
    pub(crate) installer: &'a dyn NativeRuntimePolicyInstaller,
}

#[async_trait::async_trait]
pub(crate) trait NativeRuntimeCurrentSource: Send + Sync {
    async fn verify_current_source(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<()>;
}

/// Required host capability. Implementations must install the real current
/// resource/delegation/external-send policy and any budget reservation, using
/// the original operation/source. They must restrict both parent and child
/// capabilities. Neither a scope nor an allowed-tool list grants permission.
pub(crate) trait NativeRuntimePolicyInstaller {
    /// A source that already prepared the original resident may leave model
    /// and tool installation to the mandatory pre-dispatch configuration.
    fn configures_bound_resident_at_turn_dispatch(&self) -> bool {
        false
    }

    /// Existing tasks use their actual Core State/lease, independently of the
    /// previous input's actor. Other native task kinds keep their old installer.
    fn install_resident(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        engine: QueryEngine,
        _manager: &ThreadManager,
    ) -> Result<QueryEngine> {
        self.install(context, original, prepared, engine)
    }

    /// Only a held original-task configuration can survive a per-input policy.
    /// This object grants neither SDK nor first-party execution authority.
    fn original_task_configuration(&self) -> Option<Arc<NativeOriginalTaskConfiguration>> {
        None
    }

    fn install(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine>;

    /// Only an original native source may select its terminal committed attempt.
    /// A public resume or historical JSON cannot construct this proof.
    fn prepare_restored_history(
        &self,
        _context: &NativeIntegrationContext,
        _original: &IntegrationRequest,
        _task: &PreparedRuntimeTask,
        _prepared: &kcoder_state::PreparedSessionResume,
        _session_directory: &std::path::Path,
    ) -> Result<kcoder_state::PreparedCompletedAttemptHistory> {
        anyhow::bail!("RUNTIME_RESTORED_HISTORY_POLICY_REQUIRED")
    }

    /// Bind only the freshly leased restored State under current native policy.
    fn install_restored(
        &self,
        _context: &NativeIntegrationContext,
        _original: &IntegrationRequest,
        _task: &PreparedRuntimeTask,
        _engine: QueryEngine,
        _history: &kcoder_state::PreparedCompletedAttemptHistory,
    ) -> Result<QueryEngine> {
        anyhow::bail!("RUNTIME_RESTORED_HISTORY_POLICY_REQUIRED")
    }
}

impl NativeRuntimeDriver {
    /// Root must call immediately before routing a generated turn/start. This
    /// closes the queue gap where a normal client request changed the resident
    /// model or current native authorization after Configure completed.
    pub(crate) fn prepare_turn_dispatch(
        &self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        manager: &mut ThreadManager,
        installer: Option<&dyn NativeRuntimePolicyInstaller>,
    ) -> Result<serde_json::Value> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::TurnDispatched,
            "RUNTIME_TICKET_MISMATCH"
        );
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        context.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.phase == RuntimePhase::TurnDispatched,
            "RUNTIME_ADMISSION_EXPIRED"
        );
        let thread = super::submission::required_thread(&binding)?;
        ensure!(!manager.is_turn_running(&thread), "RUNTIME_THREAD_BUSY");
        let resident = manager
            .engine(&thread)
            .context("RUNTIME_THREAD_NOT_RESIDENT")?;
        let candidate = prepare_candidate(context, &binding, resident, installer, Some(manager))?;
        if let Some(original) = installer.and_then(|source| source.original_task_configuration()) {
            manager.retain_original_task_configuration(context, &thread, original)?;
        }
        manager.replace_host_turn_engine(&thread, candidate)?;
        Ok(
            serde_json::json!({"threadId":thread,"clientMessageId":binding.client_message_id,
            "input":binding.spec.input,"clientPresentation":binding.spec.client_presentation}),
        )
    }
    /// This does no RPC and may run directly in Root's select branch. A missing
    /// installer fails; no permissive default or model-selection fallback exists.
    pub(crate) fn configure_command(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        manager: &mut ThreadManager,
        installer: Option<&dyn NativeRuntimePolicyInstaller>,
    ) -> Result<()> {
        self.check(context)?;
        let binding = self.take_pending(ticket)?;
        ensure!(
            ticket.phase() == RuntimePhase::ConfigureDispatched,
            "RUNTIME_RESPONSE_KIND_MISMATCH"
        );
        let configured = (|| {
            context.validate_scope(&binding.source_scope)?;
            let thread = super::submission::required_thread(&binding)?;
            ensure!(!manager.is_turn_running(&thread), "RUNTIME_THREAD_BUSY");
            let resident = manager
                .engine(&thread)
                .context("RUNTIME_THREAD_NOT_RESIDENT")?;
            if installer.is_some_and(|source| source.configures_bound_resident_at_turn_dispatch())
                && binding.spec.existing_thread_id.as_deref() == Some(thread.as_str())
                && binding.spec.configuration.workflow.is_none()
            {
                // Persist the original queue transition without installing a
                // provisional model or changing the idle resident's actor.
                return verify_candidate_resident(&binding, &resident);
            }
            let candidate =
                prepare_candidate(context, &binding, resident, installer, Some(manager))?;
            if let Some(original) =
                installer.and_then(|source| source.original_task_configuration())
            {
                manager.retain_original_task_configuration(context, &thread, original)?;
            }
            manager.replace_host_turn_engine(&thread, candidate)?;
            Ok(())
        })();
        if let Err(error) = &configured {
            let code = kcoder_runtime_driver::configuration_rejection_code(error);
            #[cfg(test)]
            eprintln!("native runtime configuration rejected: {code}");
            #[cfg(not(test))]
            tracing::warn!(
                stage = "configure",
                code,
                "native runtime configuration rejected"
            );
            // No turn or workflow has been dispatched by this phase.
            self.reject_before_dispatch(binding, "RUNTIME_CONFIGURATION_REJECTED")?;
            return configured;
        }
        let mut binding = binding;
        binding.phase = if binding.spec.configuration.workflow.is_some() {
            RuntimePhase::WorkflowQueued
        } else {
            RuntimePhase::TurnQueued
        };
        self.save_and_enqueue(binding)
    }
}

fn verify_candidate_resident(binding: &RuntimeBinding, resident: &QueryEngine) -> Result<()> {
    ensure!(
        resident.session_id() == super::submission::required_thread(binding)?,
        "RUNTIME_NATIVE_IDENTITY_MISMATCH"
    );
    ensure!(
        resident.state.session_mode() == kcoder_state::SessionMode::Default,
        "RUNTIME_SESSION_MODE_UNSUPPORTED"
    );
    Ok(())
}

pub(super) fn prepare_candidate(
    context: &NativeIntegrationContext,
    binding: &RuntimeBinding,
    resident: QueryEngine,
    installer: Option<&dyn NativeRuntimePolicyInstaller>,
    manager: Option<&ThreadManager>,
) -> Result<QueryEngine> {
    verify_candidate_resident(binding, &resident)?;
    let installer = installer.context("RUNTIME_NATIVE_POLICY_UNAVAILABLE")?;
    if let Some(workflow) = &binding.spec.configuration.workflow {
        workflow.resolve_pinned(context)?;
    }
    let session = resident.session_id();
    let cwd = resident.state.cwd();
    let original_state = resident.state.clone();
    let original_lifecycle = original_state
        .try_inspection_lifecycle_identity()
        .context("RUNTIME_ORIGINAL_STATE_UNAVAILABLE")?;
    let candidate = match manager {
        Some(manager) => installer.install_resident(
            context,
            &binding.original_request,
            &binding.spec,
            resident,
            manager,
        )?,
        None => installer.install(context, &binding.original_request, &binding.spec, resident)?,
    };
    ensure!(
        candidate.session_id() == session
            && candidate.state.cwd() == cwd
            && candidate.state.shares_state_with(&original_state)
            && original_lifecycle.try_matches(&candidate.state) == Some(true),
        "RUNTIME_CANDIDATE_OWNER_MISMATCH"
    );
    let actual = candidate.active_model_configuration_summary()?;
    let expected = &binding.spec.configuration.model.model;
    ensure!(
        actual.model_id == expected.model_id
            && actual.provider_id == expected.provider_id
            && actual.revision == expected.revision
            && actual.api_format == expected.api_format
            && actual.chat_protocol == expected.chat_protocol,
        "RUNTIME_MODEL_REVISION_MISMATCH"
    );
    let candidate = super::super::model_policy::install_runtime_model_policy(
        context,
        candidate,
        &binding.spec.configuration.model,
    )?;
    let candidate = if let Some(allowed) = &binding.spec.configuration.allowed_tools {
        let filtered = candidate.tools.filtered_to_names(allowed);
        candidate
            .with_turn_tools(filtered)
            .with_native_tool_ceiling(allowed)?
    } else {
        candidate
    };
    if let Some(allowed) = &binding.spec.configuration.allowed_tools {
        ensure!(
            candidate
                .active_tool_registry()
                .names()
                .iter()
                .all(|name| allowed.contains(name)),
            "RUNTIME_TOOL_CEILING_UNCONFIRMED"
        );
    }
    if binding.spec.configuration.workflow.is_some() {
        ensure!(
            candidate.active_tool_registry().get("Workflow").is_some(),
            "RUNTIME_WORKFLOW_TOOL_UNAVAILABLE"
        );
    }
    candidate.with_required_native_host_source_admission()
}
