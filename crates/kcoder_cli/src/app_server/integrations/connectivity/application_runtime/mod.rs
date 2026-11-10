//! Original application tasks and their resource/model guards, without a channel runtime.
use super::super::core::{NativeBudgetService, NativeIntegrationContext, runtime_driver::*};
use super::application_inputs::NativeApplicationTaskSource;
use crate::app_server::engine_factory::AppServerEngineFactory;
use anyhow::{Context, Result, ensure};
use kcoder_engine::{QueryEngine, integrations::core::*};
use kcoder_types::integrations::core::*;
use std::sync::{Arc, OnceLock};
use tokio_util::sync::CancellationToken;

mod budget;

pub(super) struct NativeApplicationRuntime {
    shared: Arc<Execution>,
    factory: AppServerEngineFactory,
    origin: QueryEngine,
    guard: Arc<ApplicationGuard>,
    budget: Arc<budget::ApplicationBudget>,
}
struct Execution {
    context: NativeIntegrationContext,
    source: Arc<NativeApplicationTaskSource>,
    request: IntegrationRequest,
    task: PreparedRuntimeTask,
    text: String,
    state: OnceLock<kcoder_state::AppState>,
    installed_input: NativeInputInstallation,
    budget_configuration: Arc<budget::TaskBudgetConfiguration>,
}
impl Execution {
    fn native(&self) -> Result<()> {
        self.context.verify()?;
        self.budget_configuration.verify()?;
        self.source.verify_native()
    }
    fn actor(&self, witness: &NativeToolExecutionWitness) -> Result<()> {
        self.native()?;
        let state = self
            .state
            .get()
            .context("APPLICATION_NATIVE_STATE_REQUIRED")?;
        ensure!(
            witness.matches_state(state)
                && witness.parent().is_none()
                && witness.attempt().is_some()
                && state.matches_current_history_attempt(witness.attempt()),
            "APPLICATION_NATIVE_ACTOR_CHANGED"
        );
        Ok(())
    }
}
impl NativeApplicationRuntime {
    pub(super) async fn prepare(
        context: &NativeIntegrationContext,
        origin: &QueryEngine,
        factory: &AppServerEngineFactory,
        request: IntegrationRequest,
        source: Arc<NativeApplicationTaskSource>,
        text: String,
        cancel: &CancellationToken,
    ) -> Result<Arc<Self>> {
        context.validate_scope(&request.scope)?;
        ensure!(!cancel.is_cancelled(), "APPLICATION_TASK_CANCELLED");
        let mut settings = origin
            .settings
            .read()
            .map_err(|_| anyhow::anyhow!("APPLICATION_NATIVE_MODEL_UNAVAILABLE"))?
            .clone();
        settings.max_tokens = Some(settings.max_tokens.map_or(1024, |value| value.min(1024)));
        settings.max_retries = 0;
        let mut bounded = origin.clone();
        bounded.settings = Arc::new(std::sync::RwLock::new(settings.clone()));
        let model = kcoder_engine::integrations::core::resolve_integration_model_selection(
            &bounded,
            &IntegrationModelResolutionRequest {
                selection: IntegrationModelSelectionIntent::InheritCurrent,
                requirements: IntegrationModelRequirements {
                    output_tokens: settings.max_tokens.map(u64::from),
                    ..Default::default()
                },
            },
        )?;
        ensure!(
            model.model.request_override_fields.iter().all(|field| [
                "max_tokens",
                "max_completion_tokens",
                "max_output_tokens",
                "temperature",
                "top_p",
                "top_k",
                "seed",
                "stop",
                "thinking",
                "reasoning",
                "reasoning_effort"
            ]
            .contains(&field.as_str())),
            "APPLICATION_NATIVE_MODEL_OVERRIDE_UNAVAILABLE"
        );
        let tools = source.business_tools();
        let task = PreparedRuntimeTask {
            input: vec![kcoder_app_protocol::UserInput::Text { text: text.clone() }],
            studio_work_mode: kcoder_types::StudioWorkMode::Kcoder,
            existing_thread_id: None,
            client_presentation: None,
            configuration: RuntimeExecutionConfiguration {
                model,
                allowed_tools: Some(tools.as_ref().map_or_else(Vec::new, |tools| tools.names())),
                external_send: if tools.as_ref().is_some_and(|tools| {
                    tools
                        .all()
                        .iter()
                        .any(|tool| tool.requires_explicit_approval())
                }) {
                    RuntimeExternalSend::Ask
                } else {
                    RuntimeExternalSend::Deny
                },
                workflow: None,
            },
        };
        task.validate()?;
        source.bind_prepared(task.clone())?;
        source.verify_native()?;
        let shared = Arc::new(Execution {
            context: context.recapture_for_owned_service()?,
            source,
            request,
            task,
            text,
            state: OnceLock::new(),
            installed_input: NativeInputInstallation::default(),
            budget_configuration: budget::TaskBudgetConfiguration::capture(factory)?,
        });
        let ledger = Arc::new(NativeBudgetService::initialize(
            context,
            shared
                .request
                .operation_id
                .as_deref()
                .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?,
        )?);
        let budget = Arc::new(budget::ApplicationBudget::new(shared.clone(), ledger)?);
        let guard = Arc::new(ApplicationGuard {
            shared: shared.clone(),
        });
        let restricted = if let Some(tools) = tools {
            factory.for_native_application(&bounded, settings, tools)?
        } else {
            factory.for_native_input_only(&bounded, settings)?
        };
        Ok(Arc::new(Self {
            shared,
            factory: restricted,
            origin: bounded,
            guard,
            budget,
        }))
    }
    pub(super) fn task(&self) -> PreparedRuntimeTask {
        self.shared.task.clone()
    }
}
impl NativeRuntimeAuthority for NativeApplicationRuntime {
    fn client_cancellation(&self) -> Option<CancellationToken> {
        Some(self.shared.source.client_cancellation())
    }
    fn verify_admission(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.verify()?;
        self.verify_before_admission_commit(context, request, task)
    }
    fn verify_before_admission_commit(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
    ) -> Result<()> {
        context.check_captured_scope(self.shared.context.scope())?;
        ensure!(
            request == &self.shared.request && task == &self.shared.task,
            "APPLICATION_ORIGINAL_RUNTIME_INTENT_CHANGED"
        );
        self.shared.native()?;
        self.budget.verify()
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
    fn current_source(&self) -> Option<&dyn NativeRuntimeCurrentSource> {
        Some(self.shared.source.as_ref())
    }
    fn pre_start(&self) -> Option<NativeRuntimePreStart<'_>> {
        Some(NativeRuntimePreStart {
            factory: &self.factory,
            installer: self,
        })
    }
    fn observe_task(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &IntegrationRuntimeTask,
    ) -> Result<()> {
        context.validate_scope(self.shared.context.scope())?;
        ensure!(
            request == &self.shared.request,
            "APPLICATION_ORIGINAL_RUNTIME_INTENT_CHANGED"
        );
        self.budget.observe_task(task)
    }
    fn canonical_artifacts(
        &self,
        context: &NativeIntegrationContext,
        original: &IntegrationRequest,
        task: &IntegrationRuntimeTask,
        engine: &QueryEngine,
    ) -> Result<Vec<IntegrationEntityRef>> {
        use kcoder_state::turn_attempt_store::TurnAttemptStore;
        context.validate_scope(self.shared.context.scope())?;
        ensure!(
            original == &self.shared.request,
            "APPLICATION_ORIGINAL_RUNTIME_INTENT_CHANGED"
        );
        self.shared.native()?;
        let state = self
            .shared
            .state
            .get()
            .context("APPLICATION_NATIVE_STATE_REQUIRED")?;
        ensure!(
            state.inspection_lifecycle_identity().matches(&engine.state)
                && task.state == IntegrationTaskState::Completed
                && task.thread_id == engine.session_id()
                && task.task_id.is_none(),
            "APPLICATION_CANONICAL_ARTIFACT_OWNER_CHANGED"
        );
        let operation = original
            .operation_id
            .as_deref()
            .context("APPLICATION_ORIGINAL_OPERATION_REQUIRED")?;
        let driver = NativeRuntimeDriver::load(context)?
            .context("APPLICATION_ORIGINAL_RUNTIME_UNAVAILABLE")?;
        let recorded = driver
            .source_intent(context, operation)?
            .context("APPLICATION_ORIGINAL_RUNTIME_UNAVAILABLE")?;
        let accepted = driver
            .read_operation(context, operation)?
            .and_then(|record| record.runtime_acceptance)
            .context("APPLICATION_ORIGINAL_RUNTIME_UNAVAILABLE")?;
        ensure!(
            recorded.original(context)? == *original
                && accepted.thread_id == task.thread_id
                && accepted.turn_id == task.turn_id
                && accepted.task_id == task.task_id,
            "APPLICATION_CANONICAL_ARTIFACT_OWNER_CHANGED"
        );
        let turn = task
            .turn_id
            .as_deref()
            .context("APPLICATION_ORIGINAL_TURN_REQUIRED")?;
        let attempts = TurnAttemptStore::open_existing(
            &engine.session_storage_dir_for(&task.thread_id),
            &task.thread_id,
        )?
        .context("APPLICATION_ORIGINAL_TURN_REQUIRED")?
        .list()?;
        ensure!(
            attempts.iter().any(|record| record.identity.turn_id == turn
                && record.status == kcoder_types::TurnAttemptStatus::Completed
                && record.completion.is_some()),
            "APPLICATION_ORIGINAL_TURN_NOT_FINISHED"
        );
        // Application business receipts have their own exact source/owner verification.
        Ok(Vec::new())
    }
}
impl NativeRuntimePolicyInstaller for NativeApplicationRuntime {
    fn install(
        &self,
        context: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        self.verify_admission(context, request, task)?;
        if let Some(state) = self.shared.state.get() {
            ensure!(
                state.inspection_lifecycle_identity().matches(&engine.state),
                "APPLICATION_NATIVE_STATE_CHANGED"
            );
        } else {
            self.shared
                .state
                .set(engine.state.clone())
                .map_err(|_| anyhow::anyhow!("APPLICATION_NATIVE_STATE_CHANGED"))?;
        }
        if self.shared.installed_input.permits_reuse(&engine)? {
            return engine
                .with_native_readonly_settings_source_from(&self.origin)?
                .with_native_tool_authorization(self.guard.clone())
                .with_native_model_request_observer(self.budget.clone());
        }
        let engine = engine.with_client_model_configuration_from(&self.origin);
        let engine = if let Some(tools) = self.shared.source.business_tools() {
            self.shared.source.bind_business_state(&engine.state)?;
            engine.with_native_application_context(
                &self.origin,
                self.shared.text.clone(),
                1024,
                tools,
            )?
        } else {
            engine.with_native_input_only_context(
                self.shared.text.clone(),
                self.shared
                    .task
                    .configuration
                    .model
                    .model
                    .max_output_tokens
                    .unwrap_or(kcoder_types::DEFAULT_MODEL_OUTPUT_TOKENS),
            )?
        };
        let installed = engine
            .with_native_readonly_settings_source_from(&self.origin)?
            .with_native_tool_authorization(self.guard.clone())
            .with_native_model_request_observer(self.budget.clone())?;
        self.shared.installed_input.record_installed(&installed)?;
        Ok(installed)
    }
}
struct ApplicationGuard {
    shared: Arc<Execution>,
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeToolAuthorization for ApplicationGuard {
    async fn authorize_provider(
        &self,
        witness: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        self.shared
            .actor(witness)
            .map_err(|error| provider_unavailable("actor_before", error))?;
        self.shared
            .source
            .verify_current_source(
                &self.shared.context,
                &self.shared.request,
                &self.shared.task,
                &cancel,
            )
            .await
            .map_err(|error| provider_unavailable("current_source", error))?;
        self.shared
            .actor(witness)
            .map_err(|error| provider_unavailable("actor_after", error))
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.shared
            .actor(
                request
                    .execution
                    .ok_or(NativeToolAuthorizationError::Unavailable)?,
            )
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        let cancel = CancellationToken::new();
        self.shared
            .source
            .verify_current_source(
                &self.shared.context,
                &self.shared.request,
                &self.shared.task,
                &cancel,
            )
            .await
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        self.shared
            .source
            .authorize_business(request)
            .map_err(|_| NativeToolAuthorizationError::Denied)
    }
}
fn provider_unavailable(stage: &'static str, error: anyhow::Error) -> NativeToolAuthorizationError {
    use sha2::{Digest, Sha256};
    tracing::warn!(
        stage,
        error_sha = format!("{:x}", Sha256::digest(error.to_string().as_bytes())),
        "APPLICATION_PROVIDER_AUTHORITY_UNAVAILABLE"
    );
    NativeToolAuthorizationError::Unavailable
}
