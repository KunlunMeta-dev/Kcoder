//! Consume one approved code task through the original Native Runtime authority and queue.
use super::*;
use crate::app_server::{
    engine_factory::AppServerEngineFactory, integrations::core::runtime_driver::*,
};
use anyhow::ensure;
use kcoder_engine::{QueryEngine, integrations::core::*};
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

pub(super) struct NativeCodeRuntimeAuthority {
    owner: Arc<NativeCodeServiceOwner>,
    factory: AppServerEngineFactory,
    request: IntegrationRequest,
    task: PreparedRuntimeTask,
    guard: Arc<CodeGuard>,
    constraint: Arc<ServiceConstraint>,
    workflow: Arc<dyn kcoder_tools::Tool>,
}
struct CodeGuard {
    owner: Arc<NativeCodeServiceOwner>,
    state: OnceLock<kcoder_state::AppState>,
}
struct ServiceConstraint {
    owner: Arc<NativeCodeServiceOwner>,
}
impl NativeCodeRuntimeAuthority {
    pub(super) async fn prepare(
        owner: Arc<NativeCodeServiceOwner>,
        factory: AppServerEngineFactory,
        origin: &QueryEngine,
    ) -> Result<Arc<Self>> {
        owner.verify()?;
        let code = &owner.launch().task;
        super::super::code_task::verify(owner.native(), code)?;
        let workflow = RuntimeWorkflowSpec::from_native_source(
            owner.native(),
            &code.definition_id,
            code.version,
            code.args.clone(),
        )?;
        let model = kcoder_engine::integrations::core::resolve_integration_model_selection(
            origin,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::InheritCurrent,
                requirements: IntegrationModelRequirements::default(),
            },
        )?;
        let task = PreparedRuntimeTask {
            input: vec![kcoder_app_protocol::UserInput::Text {
                text: "Run the explicitly approved saved code workflow.".into(),
            }],
            studio_work_mode: kcoder_types::StudioWorkMode::Kcoder,
            existing_thread_id: None,
            client_presentation: None,
            configuration: RuntimeExecutionConfiguration {
                model,
                allowed_tools: Some(vec!["Workflow".into()]),
                external_send: RuntimeExternalSend::Deny,
                workflow: Some(workflow),
            },
        };
        task.validate()?;
        let request=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,
            request_id:format!("{}-submit",code.runtime_operation_id),scope:owner.native().scope().clone(),
            operation_id:Some(code.runtime_operation_id.clone()),expected_revision:None,timeout_ms:60000,cancellation_ref:None,
            payload:serde_json::json!({"source":{"kind":"native_service","leaseId":owner.intent().lease_id,
                "definitionId":code.definition_id,"version":code.version},"message":{"text":"Run the approved saved code workflow"}}).as_object().unwrap().clone()};
        request.validate_method(IntegrationPort::Runtime, "acceptTask")?;
        let guard = Arc::new(CodeGuard {
            owner: owner.clone(),
            state: OnceLock::new(),
        });
        let constraint = Arc::new(ServiceConstraint {
            owner: owner.clone(),
        });
        Ok(Arc::new(Self {
            owner,
            factory,
            request,
            task,
            guard,
            constraint,
            workflow: Arc::new(kcoder_tools::workflow::WorkflowTool),
        }))
    }
    pub(super) fn request(&self) -> IntegrationRequest {
        self.request.clone()
    }
    pub(super) fn task(&self) -> PreparedRuntimeTask {
        self.task.clone()
    }
}
impl NativeRuntimeAuthority for NativeCodeRuntimeAuthority {
    fn verify_admission(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
    ) -> Result<()> {
        native.validate_scope(self.owner.native().scope())?;
        self.owner.verify()?;
        ensure!(
            request == &self.request && task == &self.task,
            "SERVICE_ORIGINAL_RUNTIME_INTENT_CHANGED"
        );
        super::super::code_task::verify(native, &self.owner.launch().task)
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
    fn current_source(&self) -> Option<&dyn NativeRuntimeCurrentSource> {
        Some(self)
    }
    fn pre_start(&self) -> Option<NativeRuntimePreStart<'_>> {
        Some(NativeRuntimePreStart {
            factory: &self.factory,
            installer: self,
        })
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeRuntimeCurrentSource for NativeCodeRuntimeAuthority {
    async fn verify_current_source(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
        cancel: &CancellationToken,
    ) -> Result<()> {
        ensure!(!cancel.is_cancelled(), "SERVICE_RUNTIME_CANCELLED");
        self.verify_admission(native, request, task)?;
        self.owner.verify()
    }
}
impl NativeRuntimePolicyInstaller for NativeCodeRuntimeAuthority {
    fn install(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        self.verify_admission(native, request, task)?;
        if let Some(state) = self.guard.state.get() {
            ensure!(
                state.inspection_lifecycle_identity().matches(&engine.state),
                "SERVICE_ORIGINAL_ENGINE_CHANGED"
            );
        } else {
            self.guard
                .state
                .set(engine.state.clone())
                .map_err(|_| anyhow::anyhow!("SERVICE_ORIGINAL_ENGINE_CHANGED"))?;
        }
        let engine = engine.with_native_tool_authorization(self.guard.clone());
        engine.with_native_code_workflow_execution_constraint(
            self.workflow.clone(),
            self.constraint.clone(),
        )
    }
}
impl CodeGuard {
    fn actor(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let state = self
            .state
            .get()
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        if !execution.matches_state(state) {
            return Err(NativeToolAuthorizationError::Denied);
        }
        self.owner
            .verify()
            .map_err(|_| NativeToolAuthorizationError::Denied)
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeToolAuthorization for CodeGuard {
    async fn authorize_provider(
        &self,
        _: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.actor(frame.execution())
    }
    async fn authorize(
        &self,
        _: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        Err(NativeToolAuthorizationError::Denied)
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeInvocationConstraint for ServiceConstraint {
    async fn verify(
        &self,
        _: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.owner
            .verify()
            .map_err(|_| NativeToolAuthorizationError::Unavailable)
    }
}
