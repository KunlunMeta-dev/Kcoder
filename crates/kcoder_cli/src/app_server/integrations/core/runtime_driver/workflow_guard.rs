//! Preserve the original Core source authority across direct Workflow children.
use super::workflow_origin::NativeCoreWorkflowOrigin;
use super::*;
use kcoder_engine::{QueryEngine, integrations::core::*};
use kcoder_state::{AppState, AppStateLifecycleIdentity, turn_attempt_store::TurnAttemptStore};
use kcoder_types::{BackgroundRunKey, TurnAttemptIdentity, TurnAttemptStatus};
use std::collections::BTreeMap;
use std::sync::Mutex;

struct Child {
    state: AppState,
    lifecycle: AppStateLifecycleIdentity,
    identity: TurnAttemptIdentity,
    run: BackgroundRunKey,
    store: Arc<TurnAttemptStore>,
}
struct WorkflowGuard {
    native: NativeIntegrationContext,
    storage: Arc<RuntimeStorage>,
    operation: String,
    state: AppState,
    lifecycle: AppStateLifecycleIdentity,
    authority: Arc<dyn NativeRuntimeAuthority>,
    children: Mutex<BTreeMap<String, Child>>,
}
pub(super) fn install(
    native: &NativeIntegrationContext,
    storage: Arc<RuntimeStorage>,
    operation: &str,
    engine: QueryEngine,
    authority: Arc<dyn NativeRuntimeAuthority>,
) -> Result<QueryEngine> {
    let guard = Arc::new(WorkflowGuard {
        native: native.recapture_for_owned_service()?,
        storage,
        operation: operation.into(),
        state: engine.state.clone(),
        lifecycle: engine.state.inspection_lifecycle_identity(),
        authority,
        children: Mutex::new(BTreeMap::new()),
    });
    guard.source()?;
    Ok(engine.with_native_tool_authorization(guard))
}
fn unavailable(_: anyhow::Error) -> NativeToolAuthorizationError {
    NativeToolAuthorizationError::Unavailable
}
impl WorkflowGuard {
    fn source(&self) -> Result<RuntimeBinding> {
        self.native.verify()?;
        self.storage.verify()?;
        ensure!(
            self.lifecycle.matches(&self.state),
            "ORGANIZATION_WORKFLOW_OWNER_CHANGED"
        );
        let binding = self
            .storage
            .bindings()
            .get(&self.operation)?
            .context("ORGANIZATION_WORKFLOW_CORE_REQUIRED")?;
        self.native.validate_scope(&binding.source_scope)?;
        ensure!(
            binding.thread_id.as_deref() == Some(self.state.session_id().as_str())
                && matches!(
                    binding.phase,
                    RuntimePhase::WorkflowDispatched | RuntimePhase::Accepted
                )
                && binding.spec.configuration.workflow.is_some(),
            "ORGANIZATION_WORKFLOW_CORE_CHANGED"
        );
        self.authority
            .verify_admission(&self.native, &binding.original_request, &binding.spec)?;
        binding
            .spec
            .configuration
            .workflow
            .as_ref()
            .unwrap()
            .resolve_pinned(&self.native)?;
        Ok(binding)
    }
    fn actor(&self, execution: &NativeToolExecutionWitness, active: bool) -> Result<bool> {
        self.source()?;
        if execution.matches_state(&self.state)
            && execution.session_id() == self.state.session_id()
            && execution.attempt().is_none()
            && execution.parent().is_none()
        {
            return Ok(false);
        }
        let children = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("ORGANIZATION_WORKFLOW_CHILD_UNAVAILABLE"))?;
        let child = children
            .get(execution.session_id())
            .context("ORGANIZATION_WORKFLOW_CHILD_REQUIRED")?;
        ensure!(
            child.lifecycle.matches(&child.state)
                && execution.matches_state(&child.state)
                && execution.attempt() == Some(&child.identity)
                && execution
                    .parent()
                    .is_some_and(|parent| parent.matches_state(&self.state)
                        && parent.session_id() == self.state.session_id()
                        && parent.background_run() == Some(&child.run)),
            "ORGANIZATION_WORKFLOW_CHILD_CHANGED"
        );
        let record = child
            .store
            .load(&child.identity)?
            .context("ORGANIZATION_ACCEPTED_REQUIRED")?;
        ensure!(
            record.status == TurnAttemptStatus::Accepted && record.completion.is_none()
                || !active && record.status.is_terminal() && record.completion.is_some(),
            "ORGANIZATION_ACCEPTED_NOT_ACTIVE"
        );
        if active {
            ensure!(
                self.state
                    .background_run_record(&child.run)
                    .is_some_and(|r| r.terminal.is_none() && !r.imported_history),
                "ORGANIZATION_WORKFLOW_RUN_CHANGED"
            );
        }
        Ok(true)
    }
    fn child_origin(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> Result<NativeCoreWorkflowOrigin> {
        self.source()?;
        let origin = NativeCoreWorkflowOrigin::capture(
            &self.native,
            request.parent(),
            request.parent_execution(),
            request.run(),
            Some(&self.operation),
        )?;
        let seal = request
            .workflow_parent()
            .context("ORGANIZATION_WORKFLOW_SEAL_REQUIRED")?;
        ensure!(
            seal.matches_parent(request.parent())
                && seal.matches_run(request.run())
                && seal.facts() == &origin.facts,
            "ORGANIZATION_WORKFLOW_SEAL_CHANGED"
        );
        Ok(origin)
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeToolAuthorization for WorkflowGuard {
    async fn workflow_parent_origin(
        &self,
        request: &NativeWorkflowParentRequest<'_>,
    ) -> std::result::Result<NativeWorkflowParentFacts, NativeToolAuthorizationError> {
        self.source()
            .and_then(|_| {
                NativeCoreWorkflowOrigin::capture(
                    &self.native,
                    request.parent(),
                    request.parent_execution(),
                    request.run(),
                    Some(&self.operation),
                )
            })
            .map(|origin| origin.facts)
            .map_err(unavailable)
    }
    async fn authorize_child(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let work = async {
            self.child_origin(request)?;
            ensure!(
                child_intents::prepare_native_workflow_child(
                    &self.native,
                    &self.operation,
                    request
                )
                .await?
                    == child_intents::NativeWorkflowChildPreparation::Prepared,
                "ORGANIZATION_WORKFLOW_CHILD_RECONCILIATION_REQUIRED"
            );
            Ok(())
        };
        work.await.map_err(unavailable)
    }
    async fn observe_child_accepted(
        &self,
        request: &NativeChildAdmissionRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let work = async {
            self.child_origin(request)?;
            child_intents::observe_native_workflow_child_accepted(
                &self.native,
                &self.operation,
                request,
            )
            .await?;
            let store = Arc::new(
                TurnAttemptStore::open_existing(
                    &request
                        .child()
                        .session_storage_dir_for(&request.identity().thread_id),
                    &request.identity().thread_id,
                )?
                .context("ORGANIZATION_ACCEPTED_STORE_REQUIRED")?,
            );
            let record = store
                .load(request.identity())?
                .context("ORGANIZATION_ACCEPTED_REQUIRED")?;
            ensure!(
                record.status == TurnAttemptStatus::Accepted && record.completion.is_none(),
                "ORGANIZATION_ACCEPTED_NOT_ACTIVE"
            );
            let mut children = self
                .children
                .lock()
                .map_err(|_| anyhow::anyhow!("ORGANIZATION_WORKFLOW_CHILD_UNAVAILABLE"))?;
            ensure!(
                children.len() < 64 && !children.contains_key(&request.child().session_id()),
                "ORGANIZATION_WORKFLOW_CHILD_CONFLICT"
            );
            children.insert(
                request.child().session_id(),
                Child {
                    state: request.child().state.clone(),
                    lifecycle: request.child().state.inspection_lifecycle_identity(),
                    identity: request.identity().clone(),
                    run: request.run().clone(),
                    store,
                },
            );
            Ok(())
        };
        work.await.map_err(unavailable)
    }
    async fn authorize_provider(
        &self,
        execution: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.actor(execution, true)
            .and_then(|child| {
                ensure!(child, "ORGANIZATION_WORKFLOW_MAIN_MODEL_DENIED");
                Ok(())
            })
            .map_err(unavailable)
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.actor(frame.execution(), false)
            .map(|_| ())
            .map_err(unavailable)
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        let work = || {
            let execution = request
                .execution
                .context("ORGANIZATION_WORKFLOW_EXECUTION_REQUIRED")?;
            let child = self.actor(execution, true)?;
            let binding = self.source()?;
            ensure!(
                !child && request.tool_name == "Workflow"
                    || child
                        && binding
                            .spec
                            .configuration
                            .allowed_tools
                            .as_ref()
                            .is_some_and(|tools| tools
                                .iter()
                                .any(|name| name == request.tool_name)),
                "ORGANIZATION_WORKFLOW_TOOL_DENIED"
            );
            Ok(())
        };
        work().map_err(unavailable)
    }
}
