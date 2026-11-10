//! Concrete personal automation over the original native runtime and State budget journal.
use super::{NativeKnowledgeHost, native_host::NativeAutomationSource};
use crate::app_server::integrations::core::{
    NativeBudgetService, NativeIntegrationContext,
    runtime_driver::{
        NativeRuntimeAuthority, NativeRuntimePolicyInstaller, PreparedRuntimeTask,
        RuntimeExecutionConfiguration, RuntimeExternalSend, RuntimeWorkflowSpec,
    },
};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::UserInput;
use kcoder_engine::{
    QueryEngine,
    integrations::core::{
        NativeChildAdmissionRequest, NativeEngineEventFrame, NativeToolAuthorization,
        NativeToolAuthorizationError, NativeToolAuthorizationRequest, NativeToolExecutionWitness,
        NativeWorkflowParentFacts, NativeWorkflowParentRequest,
    },
};
use kcoder_tools::{Tool, ToolRegistry};
use kcoder_types::{
    ClientPresentationV1, StudioWorkMode, integrations::core::*, workflow::WorkflowNodeKind,
};
use std::sync::{Arc, Mutex, RwLock};
use tokio_util::sync::CancellationToken;

pub(in crate::app_server::integrations::knowledge) mod budget;
mod office;
mod port;
pub(crate) use office::AutomationOfficeFactory;
mod source_tool;
mod state;
pub(crate) use port::NativeAutomationRuntimePort;
use source_tool::AutomationSourceRead;
use state::ExecutionSafety;

#[cfg(test)]
pub(super) fn revalidate_runtime_source_for_test(source: &NativeAutomationSource) -> Result<()> {
    state::revalidate_runtime_source(source, &mut None)
}

pub(crate) struct NativeAutomationPreparation {
    pub(crate) task: PreparedRuntimeTask,
    pub(crate) authority: Arc<PersonalAutomationRuntime>,
}
pub(crate) struct PersonalAutomationRuntime {
    shared: Arc<ExecutionSafety>,
    read_tool: Arc<AutomationSourceRead>,
    expected: PreparedRuntimeTask,
    factory_resolution: IntegrationModelResolutionResult,
    model_source: QueryEngine,
    settings: kcoder_config::Settings,
    observer: Arc<budget::AutomationBudgetObserver>,
    guard: Arc<PersonalToolGuard>,
    office: Option<Arc<office::AutomationOffice>>,
    office_tool: Option<Arc<kcoder_tools::integrations::office::OfficeDocumentTool>>,
    discovery_tools: Vec<Arc<dyn Tool>>,
}
impl PersonalAutomationRuntime {
    #[cfg(test)]
    pub(super) fn observed_native_budget_for_test(
        &self,
    ) -> Result<(
        kcoder_state::integrations::core::budgets::BudgetReservationReceipt,
        kcoder_state::integrations::core::budgets::BudgetWindowObservation,
    )> {
        self.observer.observed_for_test()
    }
    #[cfg(test)]
    pub(super) fn observed_native_model_calls_for_test(
        &self,
    ) -> Result<Vec<kcoder_state::integrations::core::budgets::BudgetReservationReceipt>> {
        self.observer.observed_calls_for_test()
    }
}

/// Native-only entry. A payload identifies existing facts; it cannot enable
/// features, create a source, select an unapproved model or mint budget credit.
#[cfg(test)]
pub(crate) fn prepare_native_automation_runtime(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    host: Arc<NativeKnowledgeHost>,
    request: &IntegrationRequest,
    presentation: Option<ClientPresentationV1>,
    cancel: &CancellationToken,
) -> Result<NativeAutomationPreparation> {
    prepare_for_target(
        native,
        engine,
        host,
        request,
        presentation,
        cancel,
        (None, None),
    )
}

/// A native caller may select an existing resident only through its actual
/// manager, which retains the original SessionLease and State. JSON cannot
/// manufacture the resident binding or amend the intent after it is frozen.
#[cfg(test)]
pub(super) fn prepare_native_automation_runtime_for_resident(
    native: &NativeIntegrationContext,
    manager: &crate::app_server::thread_runtime::ThreadManager,
    thread: &str,
    host: Arc<NativeKnowledgeHost>,
    request: &IntegrationRequest,
    presentation: Option<ClientPresentationV1>,
    cancel: &CancellationToken,
) -> Result<NativeAutomationPreparation> {
    let engine = manager
        .engine(thread)
        .context("AUTOMATION_RESIDENT_UNAVAILABLE")?;
    ensure!(engine.session_id() == thread, "AUTOMATION_RESIDENT_CHANGED");
    prepare_for_target(
        native,
        &engine,
        host,
        request,
        presentation,
        cancel,
        (Some(thread.to_owned()), None),
    )
}

pub(crate) fn prepare_native_automation_with_office(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    host: Arc<NativeKnowledgeHost>,
    request: &IntegrationRequest,
    presentation: Option<ClientPresentationV1>,
    cancel: &CancellationToken,
    office: Option<&AutomationOfficeFactory>,
) -> Result<NativeAutomationPreparation> {
    prepare_for_target(
        native,
        engine,
        host,
        request,
        presentation,
        cancel,
        (None, office),
    )
}

fn prepare_for_target(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    host: Arc<NativeKnowledgeHost>,
    request: &IntegrationRequest,
    presentation: Option<ClientPresentationV1>,
    cancel: &CancellationToken,
    target: (Option<String>, Option<&AutomationOfficeFactory>),
) -> Result<NativeAutomationPreparation> {
    let source = Arc::new(NativeAutomationSource::capture(
        native, engine, host, request, cancel,
    )?);
    ensure!(
        source.is_native_personal_policy(),
        "AUTOMATION_NATIVE_POLICY_LEASE_UNAVAILABLE"
    );
    let mut code_allowance = 0u64;
    for node in &source.pin().definition().nodes {
        ensure!(
            matches!(
                node.kind,
                WorkflowNodeKind::Agent | WorkflowNodeKind::Code | WorkflowNodeKind::Human
            ),
            "AUTOMATION_WORKFLOW_EFFECT_UNAVAILABLE"
        );
        ensure!(
            node.allowed_write_paths.is_empty() && node.expected_artifacts.is_empty(),
            "AUTOMATION_WORKFLOW_WRITE_UNAVAILABLE"
        );
        ensure!(
            node.kind != WorkflowNodeKind::Agent
                || (node.agent_type == "general" && node.max_turns <= 16),
            "AUTOMATION_WORKFLOW_ROLE_UNAVAILABLE"
        );
        let attempts = u64::from(
            node.config
                .failure_policy
                .as_ref()
                .map_or(1, |policy| policy.max_attempts),
        );
        let retries = u64::from(node.config.validation_retries) + 1;
        let code = node
            .config
            .code
            .as_ref()
            .map_or(0, |code| code.timeout_ms)
            .checked_add(
                node.config
                    .result_check
                    .as_ref()
                    .map_or(0, |code| code.timeout_ms),
            )
            .context("AUTOMATION_RUNTIME_LIMIT_INVALID")?;
        code_allowance = code_allowance
            .checked_add(
                code.checked_mul(attempts)
                    .and_then(|value| value.checked_mul(retries))
                    .context("AUTOMATION_RUNTIME_LIMIT_INVALID")?,
            )
            .context("AUTOMATION_RUNTIME_LIMIT_INVALID")?;
    }
    ensure!(
        code_allowance
            < source
                .maximum_runtime_seconds()
                .checked_mul(1000)
                .context("AUTOMATION_RUNTIME_LIMIT_INVALID")?,
        "AUTOMATION_CODE_BUDGET_UNAVAILABLE"
    );
    let factory_resolution =
        kcoder_engine::integrations::core::resolve_integration_model_selection(
            engine,
            &IntegrationModelResolutionRequest {
                selection: source.effective_model_selection(),
                requirements: IntegrationModelRequirements {
                    tools: true,
                    structured_output: false,
                    ..Default::default()
                },
            },
        )?;
    let mut bounded = engine
        .clone()
        .with_owned_native_model_resolution(&factory_resolution)?;
    let mut settings = bounded
        .settings
        .read()
        .map_err(|_| anyhow::anyhow!("AUTOMATION_MODEL_UNAVAILABLE"))?
        .clone();
    // The task owns this narrowed snapshot. The profile and fixed system prefix are untouched.
    let output = u32::try_from((source.maximum_tokens() / 4).clamp(1, 4096))?;
    settings.max_tokens = Some(
        settings
            .max_tokens
            .map_or(output, |current| current.min(output)),
    );
    bounded.settings = Arc::new(RwLock::new(settings.clone()));
    let mut model = factory_resolution.clone();
    model.model = bounded.active_model_configuration_summary()?;
    ensure!(
        factory_resolution.selection_kind != IntegrationModelSelectionKind::VerifierLocked
            || model.model.revision == factory_resolution.model.revision,
        "AUTOMATION_VERIFIER_CONFIGURATION_CHANGED"
    );
    kcoder_engine::integrations::core::validate_integration_auto_model(&bounded, &model)?;
    ensure!(
        !cancel.is_cancelled(),
        "AUTOMATION_CANCELLED_BEFORE_SUBMISSION"
    );
    source.verify(native, request, cancel)?;
    let service = Arc::new(NativeBudgetService::initialize(
        native,
        request
            .operation_id
            .as_deref()
            .context("AUTOMATION_OPERATION_REQUIRED")?,
    )?);
    let shared = Arc::new(ExecutionSafety::new(
        source,
        service,
        model.model.clone(),
        code_allowance,
    )?);
    let read_tool = Arc::new(AutomationSourceRead::new(shared.clone()));
    let observer = Arc::new(budget::AutomationBudgetObserver::new(shared.clone())?);
    let office = target
        .1
        .map(|factory| factory.prepare(shared.clone()))
        .transpose()?;
    let office_tool = office
        .as_ref()
        .map(|office| office.document())
        .transpose()?;
    let discovery_tools: Vec<Arc<dyn Tool>> = if office_tool.is_some() {
        vec![
            Arc::new(kcoder_tools::tool_search::ToolSearchTool),
            Arc::new(kcoder_tools::tool_execute::ToolExecuteTool),
        ]
    } else {
        vec![]
    };
    if let Some(office) = &office
        && let Some(document) = &office_tool
    {
        let mut tools = ToolRegistry::new()
            .register_arc(read_tool.clone())
            .register_arc(document.clone());
        for tool in &discovery_tools {
            tools = tools.register_arc(tool.clone());
        }
        office.bind_child_tools(tools)?;
    }
    let mut allowed_tools = vec!["Workflow".into(), source_tool::NAME.into()];
    if office_tool.is_some() {
        allowed_tools.push("OfficeDocument".into());
        allowed_tools.extend(discovery_tools.iter().map(|tool| tool.name()));
    }
    if office_tool.is_some() {
        settings
            .tools
            .luna
            .allowed
            .retain(|name| allowed_tools.contains(name));
        for name in [source_tool::NAME, "tool_search", "tool_execute"] {
            if !settings
                .tools
                .luna
                .allowed
                .iter()
                .any(|allowed| allowed == name)
            {
                settings.tools.luna.allowed.push(name.into());
            }
        }
    }
    let pin = shared.source.pin();
    let workflow = RuntimeWorkflowSpec {
        definition_id: pin.definition().id.clone(),
        version: pin
            .definition()
            .saved_version
            .context("AUTOMATION_WORKFLOW_PIN_UNAVAILABLE")?,
        args: pin.args().clone(),
        definition_sha256: Some(pin.definition_sha256().into()),
    };
    let task = PreparedRuntimeTask {
        input: vec![UserInput::Text {
            text: serde_json::to_string(&request.payload)?,
        }],
        studio_work_mode: if office.is_some() {
            StudioWorkMode::Kworker
        } else {
            StudioWorkMode::Kcoder
        },
        existing_thread_id: target.0,
        client_presentation: presentation,
        configuration: RuntimeExecutionConfiguration {
            model,
            allowed_tools: Some(allowed_tools),
            external_send: RuntimeExternalSend::Deny,
            workflow: Some(workflow),
        },
    };
    task.validate()?;
    let guard = Arc::new(PersonalToolGuard {
        shared: shared.clone(),
        read_tool: read_tool.clone(),
        office_tool: office_tool.clone(),
        discovery_tools: discovery_tools.clone(),
        office: office.as_ref().map(Arc::downgrade),
    });
    let authority = Arc::new(PersonalAutomationRuntime {
        shared,
        read_tool,
        expected: task.clone(),
        factory_resolution,
        model_source: engine.clone(),
        settings,
        observer,
        guard,
        office,
        office_tool,
        discovery_tools,
    });
    Ok(NativeAutomationPreparation { task, authority })
}
impl NativeRuntimeAuthority for PersonalAutomationRuntime {
    fn verify_admission(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
    ) -> Result<()> {
        ensure!(
            prepared == &self.expected,
            "AUTOMATION_RUNTIME_INTENT_CHANGED"
        );
        self.shared
            .source
            .verify(native, original, &CancellationToken::new())
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
    fn workflow_timeout_seconds(&self) -> Option<u64> {
        Some(self.shared.source.maximum_runtime_seconds())
    }
    fn observe_task(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        task: &IntegrationRuntimeTask,
    ) -> Result<()> {
        ensure!(
            original.operation_id == self.shared.source.original_request().operation_id
                && original.payload == self.shared.source.original_request().payload,
            "AUTOMATION_RUNTIME_INTENT_CHANGED"
        );
        self.observer.observe_task(native, task)
    }
}
impl NativeRuntimePolicyInstaller for PersonalAutomationRuntime {
    fn install(
        &self,
        native: &NativeIntegrationContext,
        original: &IntegrationRequest,
        prepared: &PreparedRuntimeTask,
        mut engine: QueryEngine,
    ) -> Result<QueryEngine> {
        self.verify_admission(native, original, prepared)?;
        let actual = engine.active_model_configuration_summary()?;
        let expected = &self.expected.configuration.model.model;
        if !self.shared.is_bound_model_engine(&engine)?
            || actual.revision != expected.revision
            || actual.provider_id != expected.provider_id
            || actual.model_id != expected.model_id
        {
            engine = engine.with_owned_native_model_resolution_from(
                &self.model_source,
                &self.factory_resolution,
            )?;
        }
        self.shared.bind_root(&engine)?;
        let workflow = engine
            .active_tool_registry()
            .get("Workflow")
            .context("AUTOMATION_WORKFLOW_TOOL_UNAVAILABLE")?;
        let actual: &dyn std::any::Any = workflow.as_ref();
        ensure!(
            actual.is::<kcoder_tools::WorkflowTool>(),
            "AUTOMATION_WORKFLOW_TOOL_UNAVAILABLE"
        );
        let read: Arc<dyn Tool> = self.read_tool.clone();
        let mut tools = ToolRegistry::new()
            .register_arc(workflow)
            .register_arc(read);
        if let Some(office) = &self.office_tool {
            tools = tools.register_arc(office.clone());
        }
        for tool in &self.discovery_tools {
            tools = tools.register_arc(tool.clone());
        }
        let ceiling = tools.names();
        engine.settings = Arc::new(RwLock::new(self.settings.clone()));
        let engine = engine
            .with_turn_tools(tools.clone())
            .with_native_tool_authorization(self.guard.clone())
            .with_native_tool_ceiling(&ceiling)?
            // The ceiling above gives this task its own worker-registry Arc.
            // Seed the same actual objects there; a turn registry alone does
            // not expose a provider to the real Workflow child.
            .with_subagent_tools(tools)
            .with_native_model_request_observer(self.observer.clone())?
            .with_native_auto_model_health(&self.expected.configuration.model)?;
        #[cfg(test)]
        eprintln!("native D install Office owner: {}", self.office.is_some());
        let engine = if let Some(office) = &self.office {
            engine.with_native_office_projection_authority(office.projection())?
        } else {
            engine
        };
        let actual = engine.active_model_configuration_summary()?;
        ensure!(
            actual.revision == self.expected.configuration.model.model.revision,
            "AUTOMATION_MODEL_REVISION_CHANGED"
        );
        Ok(engine)
    }
}

struct PersonalToolGuard {
    shared: Arc<ExecutionSafety>,
    read_tool: Arc<AutomationSourceRead>,
    office_tool: Option<Arc<kcoder_tools::integrations::office::OfficeDocumentTool>>,
    discovery_tools: Vec<Arc<dyn Tool>>,
    office: Option<std::sync::Weak<office::AutomationOffice>>,
}
fn native_admission_error(stage: &str, error: anyhow::Error) -> NativeToolAuthorizationError {
    let code = native_admission_code(&error);
    #[cfg(test)]
    eprintln!("native automation authority {stage}: {code}");
    #[cfg(not(test))]
    tracing::warn!(
        stage,
        code,
        "native automation authority rejected its current proof"
    );
    NativeToolAuthorizationError::Unavailable
}
pub(crate) fn native_admission_code(error: &anyhow::Error) -> String {
    error
        .chain()
        .find_map(|cause| {
            let value = cause.to_string();
            ((value.starts_with("AUTOMATION_")
                || value.starts_with("RUNTIME_CHILD_")
                || value.starts_with("NATIVE_")
                || matches!(
                    value.as_str(),
                    "RUNTIME_BINDING_BUSY"
                        | "RUNTIME_BINDING_CONFLICT"
                        | "INTEGRATION_STORAGE_BUSY"
                        | "INTEGRATION_STORAGE_CONTROL_CHANGED"
                        | "INTEGRATION_STORAGE_DIRECTORY_CHANGED"
                        | "INTEGRATION_STORAGE_OWNER_MISMATCH"
                        | "INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED"
                        | "INTEGRATION_IDENTITY_REVOKED"
                        | "KNOWLEDGE_NATIVE_BINDING_CHANGED"
                        | "KNOWLEDGE_NATIVE_DATABASE_CHANGED"
                        | "KNOWLEDGE_NATIVE_NAMESPACE_CHANGED"
                        | "KNOWLEDGE_NATIVE_OBJECTS_CHANGED"
                        | "KNOWLEDGE_NATIVE_SOURCE_MISMATCH"
                        | "KNOWLEDGE_SOURCE_UNAVAILABLE"
                ))
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
            .then_some(value)
        })
        .unwrap_or_else(|| "UNAVAILABLE".into())
}
#[test]
fn native_authority_diagnostics_keep_only_bounded_codes() {
    assert_eq!(
        native_admission_code(&anyhow::anyhow!("AUTOMATION_RUNTIME_SOURCE_CHANGED")),
        "AUTOMATION_RUNTIME_SOURCE_CHANGED"
    );
    for code in [
        "RUNTIME_BINDING_BUSY",
        "RUNTIME_BINDING_CONFLICT",
        "INTEGRATION_STORAGE_BUSY",
        "KNOWLEDGE_NATIVE_DATABASE_CHANGED",
    ] {
        assert_eq!(native_admission_code(&anyhow::anyhow!("{code}")), code);
    }
    for secret in [
        "AUTOMATION_TOKEN=private-canary",
        "/private/owner/credentials.json",
        "NATIVE_秘密",
        "KNOWLEDGE_SECRET_CANARY",
        &format!("AUTOMATION_{}", "A".repeat(128)),
    ] {
        assert_eq!(
            native_admission_code(&anyhow::anyhow!("{secret}")),
            "UNAVAILABLE"
        );
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeToolAuthorization for PersonalToolGuard {
    async fn workflow_parent_origin(
        &self,
        request: &NativeWorkflowParentRequest<'_>,
    ) -> std::result::Result<NativeWorkflowParentFacts, NativeToolAuthorizationError> {
        self.shared
            .workflow_parent_facts(
                request.parent(),
                request.parent_execution(),
                request.run(),
                request.agent_id(),
            )
            .map_err(|error| native_admission_error("workflow_parent_origin", error))
    }
    async fn authorize_child(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let perform = async {
            let seal = request
                .workflow_parent()
                .context("AUTOMATION_WORKFLOW_PARENT_REQUIRED")?;
            let expected = self.shared.workflow_parent_facts(
                request.parent(),
                request.parent_execution(),
                request.run(),
                &request.run().agent_id,
            )?;
            ensure!(
                seal.matches_parent(request.parent())
                    && seal.matches_run(request.run())
                    && seal.facts() == &expected,
                "AUTOMATION_WORKFLOW_PARENT_CHANGED"
            );
            use crate::app_server::integrations::core::runtime_driver::child_intents::{
                NativeWorkflowChildPreparation, prepare_native_workflow_child,
            };
            #[cfg(test)]
            eprintln!(
                "native automation child configuration: parentMax={:?} childMax={:?} parentRevisionMatchesPrepared={} childRevisionMatchesParent={}",
                request
                    .parent()
                    .settings
                    .read()
                    .ok()
                    .and_then(|settings| settings.max_tokens),
                request
                    .child()
                    .settings
                    .read()
                    .ok()
                    .and_then(|settings| settings.max_tokens),
                request
                    .parent()
                    .active_model_configuration_summary()?
                    .revision
                    == self.shared.model.revision,
                request
                    .child()
                    .active_model_configuration_summary()?
                    .revision
                    == request
                        .parent()
                        .active_model_configuration_summary()?
                        .revision
            );
            let prepared = prepare_native_workflow_child(
                self.shared.source.native(),
                &expected.operation_id,
                request,
            )
            .await?;
            #[cfg(test)]
            eprintln!("native automation child prepare: {prepared:?}");
            ensure!(
                prepared == NativeWorkflowChildPreparation::Prepared,
                "AUTOMATION_CHILD_RECONCILIATION_REQUIRED"
            );
            Ok(())
        };
        perform
            .await
            .map_err(|error| native_admission_error("authorize_child", error))
    }
    async fn observe_child_accepted(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let perform = async {
            let seal = request
                .workflow_parent()
                .context("AUTOMATION_WORKFLOW_PARENT_REQUIRED")?;
            let expected = self.shared.workflow_parent_facts(
                request.parent(),
                request.parent_execution(),
                request.run(),
                &request.run().agent_id,
            )?;
            ensure!(
                seal.matches_parent(request.parent())
                    && seal.matches_run(request.run())
                    && seal.facts() == &expected,
                "AUTOMATION_WORKFLOW_PARENT_CHANGED"
            );
            crate::app_server::integrations::core::runtime_driver::child_intents::observe_native_workflow_child_accepted(
                self.shared.source.native(), &expected.operation_id, request,
            ).await?;
            if let Some(office) = self.office.as_ref().and_then(std::sync::Weak::upgrade) {
                office.accepted_child(request)?;
            }
            Ok(())
        };
        perform
            .await
            .map_err(|error| native_admission_error("observe_child_accepted", error))
    }
    async fn authorize_provider(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.shared
            .verify_witness(execution)
            .map_err(|error| native_admission_error("authorize_provider_witness", error))?;
        self.shared
            .check_source()
            .map_err(|error| native_admission_error("authorize_provider_source", error))
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        #[cfg(test)]
        if frame.has_tool_identity() {
            let kind = match frame.event() {
                kcoder_engine::EngineEvent::ToolUseStarted { .. } => "tool_use_started",
                kcoder_engine::EngineEvent::ToolExecutionStarted { .. } => "tool_execution_started",
                kcoder_engine::EngineEvent::ToolInputProgress { .. } => "tool_input_progress",
                kcoder_engine::EngineEvent::ToolResult { .. } => "tool_result",
                kcoder_engine::EngineEvent::ToolDenied { .. } => "tool_denied",
                _ => "non_tool",
            };
            let actual: Arc<dyn Tool> = self.read_tool.clone();
            eprintln!(
                "native automation event: kind={kind} hasTool=true nativeName={:?} actualArcMatch={} attemptPresent={}",
                frame
                    .tool()
                    .map(|tool| tool.tool_name().chars().take(80).collect::<String>()),
                frame.tool().is_some_and(|tool| tool.matches_tool(&actual)),
                frame.execution().attempt().is_some()
            );
        }
        self.shared
            .verify_witness(frame.execution())
            .map_err(|error| native_admission_error("authorize_event_witness", error))?;
        if frame.has_tool_identity() {
            let emitter = frame.tool().ok_or(NativeToolAuthorizationError::Denied)?;
            let actual: Arc<dyn Tool> = self.read_tool.clone();
            let office = self.office_tool.as_ref().is_some_and(|tool| {
                let tool: Arc<dyn Tool> = tool.clone();
                emitter.matches_tool(&tool)
            });
            let discovery = self
                .discovery_tools
                .iter()
                .any(|tool| emitter.matches_tool(tool));
            if !emitter.matches_tool(&actual) && !office && !discovery {
                return Err(NativeToolAuthorizationError::Denied);
            }
        }
        self.shared
            .check_source()
            .map_err(|error| native_admission_error("authorize_event_source", error))
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let emitter = request
            .emitter
            .ok_or(NativeToolAuthorizationError::Denied)?;
        let execution = request
            .execution
            .ok_or(NativeToolAuthorizationError::Denied)?;
        let actual: Arc<dyn Tool> = self.read_tool.clone();
        let office = self.office_tool.as_ref().is_some_and(|tool| {
            let tool: Arc<dyn Tool> = tool.clone();
            request.tool_name == "OfficeDocument" && emitter.matches_tool(&tool)
        });
        let read = request.tool_name == source_tool::NAME
            && request.read_only
            && emitter.matches_tool(&actual);
        let discovery = self
            .discovery_tools
            .iter()
            .any(|tool| request.tool_name == tool.name() && emitter.matches_tool(tool));
        if (!read && !office && !discovery)
            || request.without_sandbox
            || !std::ptr::eq(execution, emitter.execution())
        {
            return Err(NativeToolAuthorizationError::Denied);
        }
        self.shared
            .verify_witness(execution)
            .map_err(|error| native_admission_error("authorize_tool_witness", error))?;
        self.shared
            .check_source()
            .map_err(|error| native_admission_error("authorize_tool_source", error))
    }
}

#[cfg(test)]
pub(crate) mod connection_test_support;
