//! Finite Office generation on the actual admitted Workflow child; manifests come only from B's store.
use super::{state::ExecutionSafety, *};
use crate::app_server::{
    ConnectionState,
    integrations::{
        core::runtime_driver::NativeRuntimeDriver,
        office::{
            lazy_session::NativeOfficeLazySession,
            native_assets::{NativeOfficeFileAssets, NativeOfficeTransfers},
            native_host::{
                NativeOfficeInstalledPaths, NativeOfficeProviders, NativeOfficeTaskAuthority,
            },
            startup_binding::NativeOfficeStartupBinding,
        },
    },
};
use anyhow::{Context, Result, ensure};
use kcoder_engine::integrations::{
    core::{NativeChildAdmissionRequest, NativeWorkflowParentFacts},
    office::{
        NativeCoreWorkflowOfficeChildCapability, NativeOfficeToolProjection,
        NativeOfficeToolProjectionAuthority, NativeOfficeToolProjectionRequest,
        OfficeNativeToolOwner, OfficeToolOwnerResolver,
    },
};
use kcoder_tools::{
    ToolContext, ToolError,
    integrations::office::{OfficeDataAction, OfficeDocumentTool, OfficeToolBackend},
};
use kcoder_types::{BackgroundRunKey, integrations::office::*};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::sync::OnceCell;

#[derive(Clone)]
pub(crate) struct AutomationOfficeFactory {
    startup: Arc<NativeOfficeStartupBinding>,
    transfers: Arc<NativeOfficeTransfers>,
    active: Arc<Mutex<BTreeMap<String, Weak<AutomationOffice>>>>,
}
impl AutomationOfficeFactory {
    pub(crate) fn capture(state: &ConnectionState) -> Option<Self> {
        if !state.integration_office_v1 {
            return None;
        }
        Some(Self {
            startup: state.integration_office_resources.clone()?,
            transfers: state.integration_office_transfers.clone(),
            active: Arc::default(),
        })
    }
    pub(super) fn prepare(&self, shared: Arc<ExecutionSafety>) -> Result<Arc<AutomationOffice>> {
        let value = Arc::new(AutomationOffice {
            shared,
            startup: self.startup.clone(),
            transfers: self.transfers.clone(),
            installed: OnceCell::new(),
            children: Mutex::new(Vec::new()),
            projection: OnceLock::new(),
            child_tools: OnceLock::new(),
        });
        let operation = value.operation()?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
        active.retain(|_, value| value.strong_count() > 0);
        ensure!(
            active.contains_key(&operation) || active.len() < 64,
            "AUTOMATION_OFFICE_CAPACITY"
        );
        if let Some(original) = active.get(&operation).and_then(Weak::upgrade) {
            return Ok(original);
        }
        active.insert(operation, Arc::downgrade(&value));
        Ok(value)
    }
    pub(super) fn collect(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
    ) -> Result<bool> {
        let Some(task) = request.payload.get("taskId").and_then(Value::as_str) else {
            return Ok(false);
        };
        let candidates = self
            .active
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?
            .values()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for value in candidates {
            if value
                .shared
                .runtime_facts()
                .is_ok_and(|facts| facts.task.id == task)
            {
                return value.collect(native, request);
            }
        }
        Ok(false)
    }
}
struct Child {
    engine: QueryEngine,
    identity: kcoder_state::AppStateLifecycleIdentity,
    parent: NativeWorkflowParentFacts,
    run: BackgroundRunKey,
    session: Option<NativeOfficeLazySession>,
    tasks: Vec<OfficeTaskRef>,
}
pub(super) struct AutomationOffice {
    shared: Arc<ExecutionSafety>,
    startup: Arc<NativeOfficeStartupBinding>,
    transfers: Arc<NativeOfficeTransfers>,
    installed: OnceCell<NativeOfficeInstalledPaths>,
    children: Mutex<Vec<Child>>,
    projection: OnceLock<Arc<dyn NativeOfficeToolProjectionAuthority>>,
    child_tools: OnceLock<ToolRegistry>,
}
fn observe_backend_rejection(stage: &'static str, error: &anyhow::Error) {
    // Retain fixed stages and irreversible chain digests only. Native error
    // text can contain private paths, endpoint parameters or account details.
    let chain_sha256 = error
        .chain()
        .take(6)
        .map(|cause| format!("{:x}", Sha256::digest(cause.to_string().as_bytes())))
        .collect::<Vec<_>>();
    tracing::warn!(
        stage,
        ?chain_sha256,
        "Native automation Office current owner rejected"
    );
}
impl AutomationOffice {
    fn operation(&self) -> Result<String> {
        self.shared
            .source
            .original_request()
            .operation_id
            .clone()
            .context("AUTOMATION_OPERATION_REQUIRED")
    }
    pub(super) fn projection(self: &Arc<Self>) -> Arc<dyn NativeOfficeToolProjectionAuthority> {
        self.projection
            .get_or_init(|| Arc::new(Projection(Arc::downgrade(self))))
            .clone()
    }
    pub(super) fn bind_child_tools(&self, tools: ToolRegistry) -> Result<()> {
        self.child_tools
            .set(tools)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_TOOLS_ALREADY_BOUND"))
    }
    pub(super) fn document(self: &Arc<Self>) -> Result<Arc<OfficeDocumentTool>> {
        Ok(Arc::new(
            OfficeDocumentTool::new(Arc::new(Backend {
                runtime: Arc::downgrade(self),
                revision: self.shared.source.source_revision().into(),
            }))
            .map_err(anyhow::Error::msg)?,
        ))
    }
    pub(super) fn accepted_child(&self, request: &NativeChildAdmissionRequest<'_>) -> Result<()> {
        let parent = request
            .workflow_parent()
            .context("AUTOMATION_WORKFLOW_PARENT_REQUIRED")?;
        let facts = self.shared.runtime_facts()?;
        ensure!(
            parent.matches_parent(request.parent())
                && parent.matches_run(request.run())
                && parent.facts().workflow_task_id == facts.task.id
                && parent.facts().operation_id == self.operation()?,
            "AUTOMATION_OFFICE_PARENT_CHANGED"
        );
        let mut children = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
        if children
            .iter()
            .any(|child| child.identity.matches(&request.child().state))
        {
            return Ok(());
        }
        ensure!(children.len() < 64, "AUTOMATION_OFFICE_CAPACITY");
        children.push(Child {
            engine: request
                .child()
                .clone()
                .with_native_readonly_settings_source_from(request.parent())?,
            identity: request.child().state.inspection_lifecycle_identity(),
            parent: parent.facts().clone(),
            run: request.run().clone(),
            session: None,
            tasks: Vec::new(),
        });
        Ok(())
    }
    fn task(&self, state: &kcoder_state::AppState) -> Result<(QueryEngine, OfficeTaskRef)> {
        let children = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
        let child = children
            .iter()
            .find(|child| child.identity.matches(state))
            .context("AUTOMATION_OFFICE_CHILD_NOT_ADMITTED")?;
        ensure!(
            child.identity.matches(&child.engine.state)
                && self.shared.runtime_facts()?.task.id == child.parent.workflow_task_id,
            "AUTOMATION_OFFICE_CHILD_CHANGED"
        );
        self.shared.verify_office_child_run(state, &child.run)?;
        let attempt = state
            .current_history_attempt_identity()
            .context("AUTOMATION_OFFICE_ACTUAL_TURN_REQUIRED")?;
        ensure!(
            attempt.thread_id == child.engine.session_id(),
            "AUTOMATION_OFFICE_CHILD_CHANGED"
        );
        let store = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing(
            &child.engine.session_storage_dir_for(&attempt.thread_id),
            &attempt.thread_id,
        )?
        .context("AUTOMATION_OFFICE_ACTUAL_TURN_REQUIRED")?;
        let accepted = store
            .load(&attempt)?
            .context("AUTOMATION_OFFICE_ACTUAL_TURN_REQUIRED")?;
        ensure!(
            accepted.status == kcoder_types::TurnAttemptStatus::Accepted
                && accepted.completion.is_none()
                && accepted.request_fingerprint.is_some(),
            "AUTOMATION_OFFICE_ACTUAL_TURN_REQUIRED"
        );
        let task = OfficeTaskRef {
            thread_id: attempt.thread_id,
            turn_id: attempt.turn_id,
            run_id: Some(child.parent.workflow_task_id.clone()),
        };
        self.shared.full_check_source()?;
        crate::app_server::integrations::core::runtime_driver::child_intents::verify_workflow_office_history(self.shared.source.native(), &child.engine, &task, &[accepted])?;
        Ok((child.engine.clone(), task))
    }
    async fn backend(self: &Arc<Self>, ctx: &ToolContext) -> Result<Arc<dyn OfficeToolBackend>> {
        let (engine, task) = self
            .task(&ctx.state)
            .inspect_err(|error| observe_backend_rejection("actual_child_owner", error))?;
        let engine = engine
            .with_native_office_projection_authority(self.projection())
            .inspect_err(|error| observe_backend_rejection("projection_owner", error))?;
        let cancel = ctx.abort_token.clone().unwrap_or_default();
        let installed = self
            .installed
            .get_or_try_init(|| {
                self.startup
                    .resolve(self.shared.source.native(), &engine, &cancel)
            })
            .await
            .inspect_err(|error| observe_backend_rejection("startup_binding", error))?
            .clone();
        let existing = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?
            .iter()
            .find(|child| child.identity.matches(&ctx.state))
            .and_then(|child| child.session.clone());
        let session = if let Some(session) = existing {
            session
        } else {
            let runtime = Arc::downgrade(self);
            let resolver: OfficeToolOwnerResolver = Arc::new(move |actual| {
                let runtime = runtime.upgrade().context("AUTOMATION_OFFICE_OWNER_ENDED")?;
                let (_, task) = runtime.task(&actual.state)?;
                let call = actual
                    .tool_call_id
                    .as_ref()
                    .filter(|call| !call.is_empty() && call.len() <= 256)
                    .context("AUTOMATION_OFFICE_CALL_REQUIRED")?;
                Ok(OfficeNativeToolOwner {
                    scope: runtime.shared.source.native().scope().clone(),
                    task,
                    state_identity: actual.state.inspection_identity(),
                    native_call_id: call.clone(),
                    operation_id: "resolved-by-native-office-lazy-session".into(),
                })
            });
            let assets = NativeOfficeFileAssets::capture_management(
                self.shared.source.native(),
                &engine,
                self.transfers.clone(),
                None,
            )
            .inspect_err(|error| observe_backend_rejection("managed_asset_owner", error))?;
            let providers = NativeOfficeProviders {
                tasks: Some(Arc::new(TaskAuthority(Arc::downgrade(self)))),
                assets: Some(Arc::new(assets)),
                ..Default::default()
            };
            let session = NativeOfficeLazySession::for_current_turn(
                self.shared.source.native(),
                &engine,
                installed,
                providers,
                self.shared.source.source_revision().into(),
                resolver,
            )
            .inspect_err(|error| observe_backend_rejection("lazy_session", error))?;
            let mut children = self
                .children
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
            let child = children
                .iter_mut()
                .find(|child| child.identity.matches(&ctx.state))
                .context("AUTOMATION_OFFICE_CHILD_NOT_ADMITTED")?;
            child.session.get_or_insert(session).clone()
        };
        {
            let mut children = self
                .children
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
            let child = children
                .iter_mut()
                .find(|child| child.identity.matches(&ctx.state))
                .context("AUTOMATION_OFFICE_CHILD_NOT_ADMITTED")?;
            if !child.tasks.contains(&task) {
                child.tasks.push(task);
            }
        }
        session
            .tool_backend()
            .inspect_err(|error| observe_backend_rejection("lazy_backend_current", error))
    }
    fn collect(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
    ) -> Result<bool> {
        native.validate_scope(self.shared.source.native().scope())?;
        let operation = self.operation()?;
        let facts = self.shared.runtime_facts()?;
        ensure!(
            request.payload.get("taskId").and_then(Value::as_str) == Some(facts.task.id.as_str()),
            "AUTOMATION_OFFICE_PARENT_CHANGED"
        );
        let mut driver = NativeRuntimeDriver::load(native)?
            .context("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED")?;
        let original = driver
            .read_operation(native, &operation)?
            .context("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED")?;
        ensure!(
            original
                .runtime_acceptance
                .as_ref()
                .and_then(|accepted| accepted.task_id.as_ref())
                == Some(&facts.task.id),
            "AUTOMATION_OFFICE_PARENT_CHANGED"
        );
        let accepted = original
            .runtime_acceptance
            .as_ref()
            .context("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED")?;
        ensure!(
            request.payload.get("threadId").and_then(Value::as_str)
                == Some(accepted.thread_id.as_str()),
            "AUTOMATION_OFFICE_PARENT_CHANGED"
        );
        let Some(guard) = crate::app_server::integrations::core::NativeDomainGuard::observe(
            native.profile()?,
            native.scope(),
            crate::app_server::integrations::core::NativeDomain::Office,
        )?
        else {
            return Ok(false);
        };
        let store = kcoder_state::integrations::office::OfficeStore::open_in(
            &guard.directory(native.profile()?)?,
            std::ffi::OsStr::new("data"),
            IntegrationOwner::from(native.scope()),
        )?
        .context("AUTOMATION_OFFICE_STORE_REQUIRED")?;
        let children = self
            .children
            .lock()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
        let mut refs = Vec::new();
        for child in children.iter() {
            ensure!(
                child.parent.workflow_task_id == facts.task.id
                    && child.parent.operation_id == operation,
                "AUTOMATION_OFFICE_PARENT_CHANGED"
            );
            for task in &child.tasks {
                for manifest in store.list_artifacts(&task.thread_id)? {
                    if manifest.task == *task {
                        refs.push(IntegrationEntityRef {
                            kind: IntegrationEntityKind::Artifact,
                            id: manifest.id,
                            revision: Some(manifest.revision.to_string()),
                        });
                    }
                }
            }
        }
        refs.sort_by(|a, b| (&a.id, &a.revision).cmp(&(&b.id, &b.revision)));
        refs.dedup();
        ensure!(refs.len() <= 64, "AUTOMATION_OFFICE_ARTIFACT_LIMIT");
        if refs.is_empty() {
            return Ok(false);
        }
        if driver.read_task(native, &operation)?.artifact_refs != refs {
            driver.observe_artifact_refs(native, &operation, refs)?;
        }
        Ok(true)
    }
}
impl NativeOfficeTaskAuthority for AutomationOffice {
    fn validate(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &OfficeTaskRef,
    ) -> Result<()> {
        native.validate_scope(self.shared.source.native().scope())?;
        let (actual, expected) = self.task(&engine.state)?;
        ensure!(
            actual.session_id() == engine.session_id() && expected == *task,
            "AUTOMATION_OFFICE_CHILD_CHANGED"
        );
        Ok(())
    }
}
struct Backend {
    runtime: Weak<AutomationOffice>,
    revision: String,
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl OfficeToolBackend for Backend {
    fn source_revision(&self) -> &str {
        &self.revision
    }
    async fn create_document(
        &self,
        specification: OfficeGenerationSpec,
        sources: Vec<OfficeResourceRef>,
        original_input: Value,
        ctx: &ToolContext,
    ) -> Result<Value, ToolError> {
        if !sources.is_empty() {
            return Err(ToolError::Execution(
                "AUTOMATION_OFFICE_FIXED_INPUT_PROVIDER_REQUIRED".into(),
            ));
        }
        let runtime = self
            .runtime
            .upgrade()
            .ok_or_else(|| ToolError::Execution("AUTOMATION_OFFICE_OWNER_ENDED".into()))?;
        let backend = runtime
            .backend(ctx)
            .await
            .map_err(|_| ToolError::Execution("AUTOMATION_OFFICE_OWNER_UNAVAILABLE".into()))?;
        let value = backend
            .create_document(specification, sources, original_input, ctx)
            .await?;
        // This observation uses only B's native stored manifests for the actual
        // owner tasks recorded above. Tool/model JSON never supplies the refs.
        let facts = runtime
            .shared
            .runtime_facts()
            .map_err(|_| ToolError::Execution("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED".into()))?;
        let operation = runtime
            .operation()
            .map_err(|_| ToolError::Execution("AUTOMATION_OPERATION_REQUIRED".into()))?;
        let driver = NativeRuntimeDriver::load(runtime.shared.source.native())
            .map_err(|_| ToolError::Execution("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED".into()))?
            .ok_or_else(|| {
                ToolError::Execution("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED".into())
            })?;
        let accepted = driver
            .read_operation(runtime.shared.source.native(), &operation)
            .map_err(|_| ToolError::Execution("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED".into()))?
            .and_then(|receipt| receipt.runtime_acceptance)
            .ok_or_else(|| {
                ToolError::Execution("AUTOMATION_OFFICE_CORE_RECEIPT_REQUIRED".into())
            })?;
        let observed=IntegrationRequest{contract_version:IntegrationContractVersion::ParallelV1,request_id:uuid::Uuid::new_v4().to_string(),scope:runtime.shared.source.native().scope().clone(),operation_id:None,expected_revision:None,timeout_ms:30_000,cancellation_ref:None,payload:serde_json::json!({"threadId":accepted.thread_id,"taskId":facts.task.id,"turnId":accepted.turn_id}).as_object().unwrap().clone()};
        runtime
            .collect(runtime.shared.source.native(), &observed)
            .map_err(|_| {
                ToolError::Execution("AUTOMATION_OFFICE_ARTIFACT_OBSERVATION_UNCONFIRMED".into())
            })?;
        Ok(value)
    }
    async fn read_data(
        &self,
        _: OfficeDataAction,
        _: OfficeArtifactRef,
        _: Option<OfficeDatasetQuery>,
        _: &ToolContext,
    ) -> Result<Value, ToolError> {
        Err(ToolError::Execution(
            "AUTOMATION_OFFICE_DOCUMENT_ONLY".into(),
        ))
    }
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeOfficeToolProjectionAuthority for AutomationOffice {
    async fn resolve(
        &self,
        request: &NativeOfficeToolProjectionRequest<'_>,
    ) -> Result<Option<NativeOfficeToolProjection>> {
        let projection = {
            let children = self
                .children
                .lock()
                .map_err(|_| anyhow::anyhow!("AUTOMATION_OFFICE_BUSY"))?;
            children
                .iter()
                .find(|child| child.engine.session_id() == request.session_id)
                .and_then(|child| child.session.as_ref())
                .map(|session| session.projection_authority())
        };
        match projection {
            Some(projection) => projection.resolve(request).await.inspect_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "owned Office projection rejected: {}",
                    _error
                        .chain()
                        .find_map(|cause| {
                            kcoder_types::integrations::office::office_public_error_code(
                                &cause.to_string(),
                            )
                        })
                        .unwrap_or("UNAVAILABLE")
                );
                #[cfg(test)]
                {
                    use sha2::{Digest, Sha256};
                    eprintln!(
                        "owned Office projection private-code digests: {:?}",
                        _error
                            .chain()
                            .map(|cause| format!(
                                "{:x}",
                                Sha256::digest(cause.to_string().as_bytes())
                            ))
                            .collect::<Vec<_>>()
                    );
                }
            }),
            None => Ok(None),
        }
    }
}

pub(super) struct Projection(pub(super) Weak<AutomationOffice>);
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeOfficeToolProjectionAuthority for Projection {
    fn native_core_workflow_child(
        &self,
        state: &kcoder_state::AppState,
    ) -> Option<NativeCoreWorkflowOfficeChildCapability> {
        let runtime = self.0.upgrade()?;
        if let Err(_error) = runtime.task(state) {
            #[cfg(test)]
            if super::native_admission_code(&_error) != "AUTOMATION_OFFICE_CHILD_NOT_ADMITTED" {
                eprintln!(
                    "native D Office capability rejected: {}",
                    super::native_admission_code(&_error)
                );
            }
            return None;
        }
        let capability = NativeCoreWorkflowOfficeChildCapability::capture_native_owner(
            state,
            runtime.child_tools.get()?.clone(),
        );
        capability.ok()
    }
    async fn resolve(
        &self,
        request: &NativeOfficeToolProjectionRequest<'_>,
    ) -> Result<Option<NativeOfficeToolProjection>> {
        self.0
            .upgrade()
            .context("AUTOMATION_OFFICE_OWNER_ENDED")?
            .resolve(request)
            .await
    }
}

struct TaskAuthority(Weak<AutomationOffice>);
impl NativeOfficeTaskAuthority for TaskAuthority {
    fn validate(
        &self,
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        task: &OfficeTaskRef,
    ) -> Result<()> {
        self.0
            .upgrade()
            .context("AUTOMATION_OFFICE_OWNER_ENDED")?
            .validate(native, engine, task)
    }
}
