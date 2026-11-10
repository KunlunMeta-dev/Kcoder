use super::*;
use kcoder_engine::QueryEngine;
use kcoder_tools::{
    ToolError,
    workflow::{WorkflowNativeDefinition, WorkflowNativeLaunch, WorkflowNativeLaunchObserver},
};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};

const REJECTED_BEFORE_START: &str = "RUNTIME_WORKFLOW_NATIVE_REJECTED";

/// Owned job; Root spawns this without blocking the loop which services native
/// questions, approvals and events. Completion goes back to the same ticket.
pub(crate) struct NativeWorkflowLaunch {
    engine: QueryEngine,
    workflow: RuntimeWorkflowSpec,
    native_definition: Arc<WorkflowNativeDefinition>,
    observer: Arc<LaunchObserver>,
}
impl NativeWorkflowLaunch {
    pub(crate) async fn run(self) -> Result<()> {
        self.observer
            .current_binding()
            .map_err(|_| anyhow::anyhow!(REJECTED_BEFORE_START))?;
        let mut input = json!({
            "definition_id": self.workflow.definition_id, "version": self.workflow.version,
            "args_json": serde_json::to_string(&self.workflow.args)?,
        });
        if let Some(seconds) = self.observer.authority.workflow_timeout_seconds() {
            ensure!(
                (1..=86_400).contains(&seconds),
                "RUNTIME_WORKFLOW_LIMIT_INVALID"
            );
            input["timeout_seconds"] = json!(seconds);
        }
        let output = self
            .engine
            .start_workflow_with_native_definition(
                input,
                self.native_definition,
                self.observer.clone(),
            )
            .await
            .inspect_err(|_| {
                // A native callback can fail after Core Accepted but before a
                // background owner exists. Tools has already persisted the
                // original failed Workflow; wake the same meter to reread it.
                if self.engine.observe_native_execution_terminal().is_err() {
                    tracing::warn!("Native failed Workflow budget reconciliation remains pending");
                }
            })
            .map_err(|_| {
                anyhow::anyhow!(
                    if self.observer.admission_rejected.load(Ordering::Acquire) {
                        REJECTED_BEFORE_START
                    } else {
                        "RUNTIME_WORKFLOW_NATIVE_START_FAILED"
                    }
                )
            })?;
        let run = output
            .content
            .iter()
            .find_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => {
                    serde_json::from_str::<Value>(text).ok().and_then(|value| {
                        value
                            .get("run_id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                }
                _ => None,
            })
            .context("RUNTIME_WORKFLOW_START_RECEIPT_INVALID")?;
        let binding = self
            .observer
            .storage
            .bindings()
            .get(&self.observer.operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding
                .acceptance
                .as_ref()
                .and_then(|value| value.task_id.as_deref())
                == Some(run.as_str()),
            "RUNTIME_WORKFLOW_START_RECEIPT_MISMATCH"
        );
        Ok(())
    }
}
struct LaunchObserver {
    engine: QueryEngine,
    storage: Arc<RuntimeStorage>,
    native_context: NativeIntegrationContext,
    operation: String,
    workflow: RuntimeWorkflowSpec,
    authority: Arc<dyn NativeRuntimeAuthority>,
    admission_rejected: AtomicBool,
}
impl WorkflowNativeLaunchObserver for LaunchObserver {
    fn before_dispatch(&self, launch: &WorkflowNativeLaunch) -> std::result::Result<(), ToolError> {
        self.register(launch)
            .map_err(|_| ToolError::Execution("RUNTIME_WORKFLOW_BINDING_NOT_COMMITTED".into()))
    }
}
impl LaunchObserver {
    fn current_binding(&self) -> Result<RuntimeBinding> {
        self.storage.verify()?;
        let binding = self
            .storage
            .bindings()
            .get(&self.operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        self.native_context.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.phase == RuntimePhase::WorkflowDispatched
                && binding.acceptance.is_none()
                && binding.spec.configuration.workflow.as_ref() == Some(&self.workflow),
            "RUNTIME_WORKFLOW_PHASE_MISMATCH"
        );
        self.workflow.resolve_pinned(&self.native_context)?;
        self.authority.verify_admission(
            &self.native_context,
            &binding.original_request,
            &binding.spec,
        )?;
        Ok(binding)
    }

    fn register(&self, launch: &WorkflowNativeLaunch) -> Result<()> {
        let binding = self.current_binding().inspect_err(|_| {
            self.admission_rejected.store(true, Ordering::Release);
        })?;
        if launch.definition_id != self.workflow.definition_id
            || launch.version != self.workflow.version
            || self.workflow.definition_sha256.as_deref() != Some(launch.definition_sha256.as_str())
            || launch.inputs_sha256 != hash(&serde_json::to_vec(&self.workflow.args)?)
        {
            self.admission_rejected.store(true, Ordering::Release);
            anyhow::bail!("RUNTIME_WORKFLOW_FIXED_INPUT_MISMATCH");
        }
        let accepted = IntegrationRuntimeAcceptance {
            thread_id: super::submission::required_thread(&binding)?,
            turn_id: None,
            task_id: Some(launch.run_id.clone()),
            state: IntegrationTaskState::Queued,
        };
        self.storage.accept(binding, accepted)?;
        if self.native_context.scope().organization_id.is_some() {
            self.engine
                .observe_native_workflow_acceptance(&launch.run_id)?;
        }
        Ok(())
    }
}

pub(crate) struct NativeWorkflowStop {
    engine: QueryEngine,
    run_id: String,
}
impl NativeWorkflowStop {
    pub(crate) async fn run(self) -> bool {
        self.engine.stop_background_task(&self.run_id).await
    }
}

impl NativeRuntimeDriver {
    pub(crate) fn prepare_workflow_launch(
        &self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        engine: QueryEngine,
        authority: Option<Arc<dyn NativeRuntimeAuthority>>,
    ) -> Result<NativeWorkflowLaunch> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::WorkflowDispatched,
            "RUNTIME_TICKET_MISMATCH"
        );
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        context.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.phase == RuntimePhase::WorkflowDispatched
                && binding.thread_id.as_deref() == Some(engine.session_id().as_str()),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        let authority = authority.context("RUNTIME_NATIVE_POLICY_UNAVAILABLE")?;
        authority.verify_admission(context, &binding.original_request, &binding.spec)?;
        let engine = super::configuration::prepare_candidate(
            context,
            &binding,
            engine,
            Some(authority.installer()),
            None,
        )?;
        let settings_path = engine
            .settings_persistence_path()
            .context("RUNTIME_WORKFLOW_PROFILE_UNAVAILABLE")?;
        let engine_profile = kcoder_config::PrivateDirectory::open_existing(
            settings_path
                .parent()
                .context("RUNTIME_WORKFLOW_PROFILE_UNAVAILABLE")?,
        )?;
        ensure!(
            engine_profile.directory_identity()? == context.profile()?.directory_identity()?,
            "RUNTIME_WORKFLOW_PROFILE_MISMATCH"
        );
        let native_context = NativeIntegrationContext::capture(
            context.profile_path()?,
            &engine.state.cwd(),
            &context.scope().identity_generation,
            &context.scope().target_revision,
        )?;
        native_context.validate_scope(&binding.source_scope)?;
        let workflow = binding
            .spec
            .configuration
            .workflow
            .context("RUNTIME_WORKFLOW_MISSING")?;
        let pin = workflow.resolve_pinned(&native_context)?;
        let native_definition = Arc::new(WorkflowNativeDefinition::from_pinned_definition(
            pin.definition().clone(),
            pin.definition_sha256(),
            pin.args().clone(),
            pin.inputs_sha256(),
        )?);
        let observer = Arc::new(LaunchObserver {
            engine: engine.clone(),
            storage: self.storage().clone(),
            native_context,
            operation: ticket.operation_id().to_owned(),
            workflow: workflow.clone(),
            authority: authority.clone(),
            admission_rejected: AtomicBool::new(false),
        });
        let engine = if context.scope().organization_id.is_some() {
            super::workflow_guard::install(
                context,
                self.storage().clone(),
                ticket.operation_id(),
                engine,
                authority,
            )?
        } else {
            engine
        };
        Ok(NativeWorkflowLaunch {
            engine,
            workflow,
            native_definition,
            observer,
        })
    }
    pub(crate) fn observe_workflow_launch(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        result: Result<()>,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::WorkflowDispatched,
            "RUNTIME_TICKET_MISMATCH"
        );
        self.clear_pending(ticket);
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        if binding.acceptance.is_none() {
            if result
                .as_ref()
                .is_err_and(|error| error.to_string() == REJECTED_BEFORE_START)
            {
                return self.reject_before_dispatch(binding, REJECTED_BEFORE_START);
            }
            return self
                .storage()
                .unknown(binding, "RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED");
        }
        self.track(&binding)?;
        if result.is_err() {
            // Registration may precede a failed start or a lost response. The
            // actual persisted run, never a second start, decides its outcome.
            return self.refresh_workflow(context, ticket.operation_id());
        }
        self.refresh_workflow(context, ticket.operation_id())
    }
    pub(crate) fn refresh_workflow(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<()> {
        self.check(context)?;
        let mut binding = self
            .storage()
            .bindings()
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        let accepted = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        let run = accepted
            .task_id
            .as_ref()
            .context("RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED")?;
        let workflow = binding
            .spec
            .configuration
            .workflow
            .as_ref()
            .context("RUNTIME_WORKFLOW_MISSING")?;
        let snapshot = match kcoder_tools::workflow_runs::read(
            context.profile_path()?.join("workflow-runs"),
            run,
        ) {
            Ok(value) => value,
            Err(_) => {
                return self
                    .storage()
                    .unknown(binding, "RUNTIME_WORKFLOW_OBSERVATION_UNAVAILABLE");
            }
        };
        ensure!(
            snapshot.run_id == *run
                && snapshot.thread_id == accepted.thread_id
                && snapshot.definition_id.as_deref() == Some(workflow.definition_id.as_str())
                && snapshot.version == Some(workflow.version),
            "RUNTIME_WORKFLOW_OBSERVATION_MISMATCH"
        );
        binding.task_state = match snapshot.status.as_str() {
            "running" => {
                // Only this accepted run's durable Human request and current
                // active node establish a user decision. Timers are not consent.
                let requests = kcoder_tools::workflow_interactions::list(
                    &context.profile_path()?.join("workflow-runs"),
                    run,
                )?;
                if requests.iter().any(|request| {
                    matches!(
                        request.request,
                        kcoder_types::workflow::WorkflowAwaitRequest::Human { .. }
                    ) && snapshot.node_states.iter().any(|node| {
                        node.node_id == request.node_id
                            && matches!(node.status.as_str(), "running" | "waiting")
                    })
                }) {
                    IntegrationTaskState::WaitingForUser
                } else {
                    IntegrationTaskState::Running
                }
            }
            "completed" => IntegrationTaskState::Completed,
            "failed" => IntegrationTaskState::Failed,
            "cancelled" => IntegrationTaskState::Cancelled,
            // A dead runtime is not proof that all its effects were cancelled.
            _ => IntegrationTaskState::OutcomeUnknown,
        };
        if binding.task_state == IntegrationTaskState::Failed {
            binding.error = Some(safe_error(
                "RUNTIME_WORKFLOW_FAILED",
                IntegrationRecovery::ReconcileOriginal,
            ));
        }
        self.settle(binding)
    }
    /// Read the original run's actual committed output through the native
    /// resident session. No path from a tool result or caller is opened.
    pub(crate) fn observe_workflow_output(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        engine: &QueryEngine,
    ) -> Result<()> {
        self.check(context)?;
        let mut binding = self
            .storage()
            .bindings()
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        let accepted = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        ensure!(
            accepted.thread_id == engine.session_id(),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        let run = accepted
            .task_id
            .as_ref()
            .context("RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED")?;
        let session = engine
            .state
            .session_state_path()
            .context("RUNTIME_WORKFLOW_SESSION_UNAVAILABLE")?;
        let directory = kcoder_config::PrivateDirectory::open_existing(
            session
                .parent()
                .context("RUNTIME_WORKFLOW_SESSION_UNAVAILABLE")?,
        )?;
        let workflows = directory
            .open_entry_handle(OsStr::new("workflows"))?
            .open_child_directory()?;
        let owned = workflows
            .open_entry_handle(OsStr::new(&kcoder_state::artifact_id_path_component(run)))?
            .open_child_directory()?;
        let mut bytes = Vec::new();
        owned
            .open_single_link_regular_file(OsStr::new("output.json"))?
            .take(256 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 256 * 1024, "RUNTIME_OUTPUT_TOO_LARGE");
        let value: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            value.get("run_id").and_then(Value::as_str) == Some(run.as_str()),
            "RUNTIME_WORKFLOW_OUTPUT_MISMATCH"
        );
        if value.get("status").and_then(Value::as_str) != Some("completed") {
            return Ok(());
        }
        let result = value
            .get("result")
            .context("RUNTIME_WORKFLOW_OUTPUT_UNAVAILABLE")?;
        let output = match result {
            Value::String(text) => text.clone(),
            _ => serde_json::to_string(result)?,
        };
        ensure!(output.len() <= 128 * 1024, "RUNTIME_OUTPUT_TOO_LARGE");
        if output.is_empty() {
            return Ok(());
        }
        binding.output = Some(output);
        let revision = binding.revision;
        self.storage().bindings().save(binding, Some(revision))?;
        Ok(())
    }
    pub(crate) fn prepare_workflow_stop(
        &self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        engine: QueryEngine,
    ) -> Result<NativeWorkflowStop> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::CancelDispatched,
            "RUNTIME_TICKET_MISMATCH"
        );
        let binding = self
            .storage()
            .bindings()
            .get(ticket.operation_id())?
            .context("RUNTIME_BINDING_MISSING")?;
        let cancel = binding
            .cancel_request
            .as_ref()
            .context("RUNTIME_CANCEL_UNCONFIRMED")?;
        context.validate_scope(&cancel.scope)?;
        let accepted = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        ensure!(
            binding.phase == RuntimePhase::CancelDispatched
                && accepted.thread_id == engine.session_id(),
            "RUNTIME_NATIVE_IDENTITY_MISMATCH"
        );
        Ok(NativeWorkflowStop {
            engine,
            run_id: accepted
                .task_id
                .clone()
                .context("RUNTIME_WORKFLOW_ACCEPTANCE_UNCONFIRMED")?,
        })
    }
    pub(crate) fn observe_workflow_stop(
        &mut self,
        context: &NativeIntegrationContext,
        ticket: &NativeRuntimeTicket,
        _handle_found: bool,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            self.is_pending(ticket) && ticket.phase() == RuntimePhase::CancelDispatched,
            "RUNTIME_TICKET_MISMATCH"
        );
        self.clear_pending(ticket);
        self.refresh_workflow(context, ticket.operation_id())
    }
}
