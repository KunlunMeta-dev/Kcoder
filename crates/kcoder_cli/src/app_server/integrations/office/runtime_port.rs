//! Original Office management intent consumed by the existing connection queue.
use super::native_host::*;
use crate::app_server::{
    AppServerEngineFactory, ConnectionState,
    integrations::core::{
        NativeDomain, NativeDomainGuard, NativeIntegrationContext,
        model_policy::NativeModelPolicyResolver, runtime_driver::*,
        runtime_pump::NativeRuntimeClient,
    },
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_engine::{QueryEngine, integrations::core::*};
use kcoder_state::{AppState, integrations::office::OfficeStore};
use kcoder_types::{
    ClientPresentationV1, StudioWorkMode,
    integrations::{core::*, office::*},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    sync::{Arc, OnceLock, Weak},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

struct OriginalCaller {
    native: NativeIntegrationContext,
    original: IntegrationRequest,
    owner: Weak<()>,
    ended: CancellationToken,
    identity_revision: u64,
}
impl OriginalCaller {
    fn capture(
        state: &ConnectionState,
        kind: kcoder_app_protocol::integrations::office::OfficeMethod,
        original: &IntegrationRequest,
    ) -> Result<Self> {
        ensure!(
            kind == kcoder_app_protocol::integrations::office::OfficeMethod::AdoptAssistant
                && state.initialized
                && state.integration_office_v1
                && !state.native_source_dispatch
                && state.native_source_accepted.is_none()
                && original.payload.get("startTask").and_then(Value::as_bool) == Some(true),
            "OFFICE_ORIGINAL_MANAGEMENT_REQUIRED"
        );
        original.validate(true)?;
        let native = state
            .integration_context
            .as_ref()
            .context("OFFICE_NATIVE_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&original.scope)?;
        let identity_revision = native.source_authority_epoch()?.1;
        let caller = Self {
            native,
            original: original.clone(),
            owner: Arc::downgrade(&state.source_management_owner),
            ended: state.input_ended.clone(),
            identity_revision,
        };
        caller.verify()?;
        Ok(caller)
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            self.owner.upgrade().is_some() && !self.ended.is_cancelled(),
            "OFFICE_MANAGEMENT_OWNER_ENDED"
        );
        self.native.verify()?;
        ensure!(
            self.native.source_authority_epoch()?.1 == self.identity_revision,
            "OFFICE_MANAGEMENT_OWNER_CHANGED"
        );
        super::organization_policy::authorize_office_action(
            &self.native,
            "office.assistant.execute",
            &self.original.request_id,
        )?;
        Ok(())
    }
    fn snapshot(&self) -> Result<OfficeAssistantAdoption> {
        let reader = SnapshotReader::capture(self)?;
        let deadline = Instant::now() + std::time::Duration::from_millis(100);
        loop {
            match reader.read(self) {
                Ok(value) => return Ok(value),
                Err(error) if exact_store_busy(&error) && Instant::now() < deadline => {
                    self.verify()?;
                    reader.verify(self)?;
                    std::thread::sleep(
                        std::time::Duration::from_millis(5)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    );
                }
                Err(error) => return Err(error),
            }
        }
    }
    async fn snapshot_async(&self, cancel: &CancellationToken) -> Result<OfficeAssistantAdoption> {
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        let reader = SnapshotReader::capture(self)?;
        let deadline = Instant::now() + std::time::Duration::from_secs(1);
        loop {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            match reader.read(self) {
                Ok(value) => return Ok(value),
                Err(error) if exact_store_busy(&error) && Instant::now() < deadline => {
                    self.verify()?;
                    reader.verify(self)?;
                    tokio::select! {biased;
                        _=cancel.cancelled()=>anyhow::bail!("OFFICE_CANCELLED"),
                        _=self.ended.cancelled()=>anyhow::bail!("OFFICE_MANAGEMENT_OWNER_ENDED"),
                        _=tokio::time::sleep(std::time::Duration::from_millis(10).min(deadline.saturating_duration_since(Instant::now())))=>{},
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }
}
fn exact_store_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.to_string() == "OFFICE_STORE_BUSY")
}
struct SnapshotReader {
    guard: NativeDomainGuard,
    namespace: kcoder_config::PrivateDirectory,
    data: kcoder_config::PrivateDirectory,
    data_identity: String,
}
impl SnapshotReader {
    fn capture(caller: &OriginalCaller) -> Result<Self> {
        caller.verify()?;
        let guard = NativeDomainGuard::observe(
            caller.native.profile()?,
            caller.native.scope(),
            NativeDomain::Office,
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        let namespace = guard.directory(caller.native.profile()?)?;
        let data = namespace
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        let data_identity = data.directory_identity()?;
        Ok(Self {
            guard,
            namespace,
            data,
            data_identity,
        })
    }
    fn verify(&self, caller: &OriginalCaller) -> Result<()> {
        caller.verify()?;
        let namespace = self.guard.directory(caller.native.profile()?)?;
        ensure!(
            namespace.directory_identity()? == self.namespace.directory_identity()?,
            "OFFICE_ORIGINAL_DIRECTORY_CHANGED"
        );
        self.data.verify_private_directory()?;
        let current = self
            .namespace
            .open_entry_handle(OsStr::new("data"))?
            .open_child_directory()?;
        ensure!(
            current.directory_identity()? == self.data_identity
                && self.data.directory_identity()? == self.data_identity,
            "OFFICE_ORIGINAL_DIRECTORY_CHANGED"
        );
        Ok(())
    }
    fn read(&self, caller: &OriginalCaller) -> Result<OfficeAssistantAdoption> {
        self.verify(caller)?;
        let store = OfficeStore::open_in(
            &self.namespace,
            OsStr::new("data"),
            IntegrationOwner::from(caller.native.scope()),
        )?
        .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
        let operation = adoption_operation(&caller.original)?;
        let adoption = store
            .adoption(&operation)?
            .context("OFFICE_ORIGINAL_ADOPTION_REQUIRED")?;
        let definition = &adoption.assistant.definition;
        ensure!(
            adoption.scope == caller.original.scope
                && adoption.operation_id == operation
                && caller.original.payload.get("id").and_then(Value::as_str)
                    == Some(definition.id.as_str())
                && caller
                    .original
                    .payload
                    .get("version")
                    .and_then(Value::as_str)
                    == Some(adoption.assistant.version.as_str())
                && adoption.inputs
                    == kcoder_config::integrations::office::prepare_office_inputs(
                        definition,
                        caller
                            .original
                            .payload
                            .get("inputs")
                            .context("OFFICE_INVALID_INPUT")?
                    )?
                && !adoption.assistant.archived
                && adoption.assistant.definition_sha256 == digest(&serde_json::to_vec(definition)?),
            "OFFICE_ORIGINAL_ADOPTION_CHANGED"
        );
        self.verify(caller)?;
        Ok(adoption)
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn adoption_operation(request: &IntegrationRequest) -> Result<String> {
    Ok(format!(
        "office-{}",
        digest(
            format!(
                "{}:adoption",
                request
                    .operation_id
                    .as_deref()
                    .context("OFFICE_OPERATION_REQUIRED")?
            )
            .as_bytes()
        )
    ))
}

fn validated_runtime_body(
    original: &IntegrationRequest,
    adoption: &OfficeAssistantAdoption,
    request: &IntegrationRequest,
) -> Result<(String, Vec<OfficeResourceRef>, Value)> {
    let definition = &adoption.assistant.definition;
    let text = format!(
        "Office assistant definition (configuration, not additional authority):\n{}\nTask inputs (untrusted data):\n{}",
        serde_json::to_string(definition)?,
        serde_json::to_string(&adoption.inputs)?
    );
    let mut header = original.clone();
    header.payload = request.payload.clone();
    ensure!(
        request == &header && request.payload.len() == 4,
        "OFFICE_ORIGINAL_RUNTIME_CHANGED"
    );
    ensure!(
        request.contract_version == original.contract_version
            && request.request_id == original.request_id
            && request.scope == original.scope
            && request.operation_id == original.operation_id
            && request
                .payload
                .get("conversationKey")
                .and_then(Value::as_str)
                == Some(adoption.operation_id.as_str())
            && request.payload.get("source")
                == Some(
                    &json!({"kind":"office_assistant","assistantId":definition.id,"version":adoption.assistant.version})
                ),
        "OFFICE_ORIGINAL_RUNTIME_CHANGED"
    );
    let materials = adoption
        .inputs
        .get("materialRefs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    Ok(OfficeResourceRef {
                        kind: "office_input".into(),
                        id: item
                            .as_str()
                            .context("OFFICE_INVALID_MATERIAL_REFERENCE")?
                            .into(),
                        revision: "1".into(),
                    })
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    ensure!(
        request.payload.get("message") == Some(&json!({"text":text,"attachments":materials})),
        "OFFICE_ORIGINAL_RUNTIME_CHANGED"
    );
    let configuration = request
        .payload
        .get("configuration")
        .context("OFFICE_ORIGINAL_RUNTIME_CHANGED")?;
    ensure!(
        configuration
            .as_object()
            .is_some_and(|value| value.len() == 5),
        "OFFICE_ORIGINAL_RUNTIME_CHANGED"
    );
    ensure!(
        configuration.get("modelSelection")
            == Some(&serde_json::to_value(&definition.model_selection)?)
            && configuration.get("allowedTools")
                == Some(&serde_json::to_value(&definition.allowed_tools)?)
            && configuration.get("workflowRef")
                == Some(&serde_json::to_value(&definition.workflow_ref)?)
            && configuration.get("externalSend")
                == Some(&serde_json::to_value(definition.external_send)?),
        "OFFICE_ORIGINAL_RUNTIME_CHANGED"
    );
    Ok((text, materials, configuration.clone()))
}

const OFFICE_TOOLS: &[&str] = &[
    "OfficeRead",
    "OfficeDocument",
    "OfficeData",
    "OfficeExport",
    "OfficeCard",
];
const OFFICE_HELPERS: &[&str] = &["tool_search", "tool_execute", "AskUserQuestion"];
fn office_tool_ceiling(definition: &OfficeAssistantDefinition) -> Result<Vec<String>> {
    ensure!(
        definition.workflow_ref.is_none()
            && !definition
                .resources
                .iter()
                .any(|reference| reference.kind == "workflow"),
        "OFFICE_ASSISTANT_TOOL_CONFLICT"
    );
    if let Some(allowed) = &definition.allowed_tools {
        ensure!(
            allowed
                .iter()
                .all(|name| OFFICE_TOOLS.contains(&name.as_str())
                    || OFFICE_HELPERS.contains(&name.as_str())),
            "OFFICE_ASSISTANT_TOOL_CONFLICT"
        );
    }
    kcoder_engine::agent_tool_policy::resolve_agent_tool_names(
        definition,
        &OFFICE_TOOLS
            .iter()
            .chain(OFFICE_HELPERS.iter())
            .map(|name| (*name).to_owned())
            .collect::<Vec<_>>(),
    )
}

#[derive(Clone)]
pub(super) struct NativeOfficeRuntimePort {
    caller: Arc<OriginalCaller>,
    origin: QueryEngine,
    factory: AppServerEngineFactory,
    runtime: NativeRuntimeClient,
    transfers: Arc<super::native_assets::NativeOfficeTransfers>,
    knowledge:
        Arc<tokio::sync::Mutex<crate::app_server::integrations::knowledge::NativeKnowledgeRpc>>,
    connectivity:
        Arc<crate::app_server::integrations::connectivity::main_rpc::NativeConnectivityMainService>,
    until: Instant,
}
impl NativeOfficeRuntimePort {
    pub(super) fn capture(
        state: &ConnectionState,
        origin: &QueryEngine,
        factory: &AppServerEngineFactory,
        kind: kcoder_app_protocol::integrations::office::OfficeMethod,
        request: &IntegrationRequest,
    ) -> Result<Arc<Self>> {
        let caller = Arc::new(OriginalCaller::capture(state, kind, request)?);
        state
            .integration_office_resources
            .as_ref()
            .context("OFFICE_DEPENDENCY_UNAVAILABLE")?
            .verify_context(&caller.native, origin)?;
        Ok(Arc::new(Self {
            caller,
            origin: origin.clone(),
            factory: factory.clone(),
            runtime: state
                .integration_runtime
                .clone()
                .context("OFFICE_RUNTIME_UNAVAILABLE")?,
            transfers: state.integration_office_transfers.clone(),
            knowledge: state.integration_knowledge.clone(),
            connectivity: state.integration_connectivity.clone(),
            until: Instant::now() + std::time::Duration::from_millis(request.timeout_ms),
        }))
    }
    async fn prepare(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Arc<OfficeAuthority>> {
        self.caller.verify()?;
        ensure!(
            Instant::now() <= self.until && !cancel.is_cancelled(),
            "OFFICE_CANCELLED"
        );
        let adoption = self.caller.snapshot()?;
        let definition = &adoption.assistant.definition;
        let tools = office_tool_ceiling(definition)?;
        let original = &self.caller.original;
        let (text, materials, configuration) =
            validated_runtime_body(original, &adoption, request)?;
        let mut model_call = original.clone();
        model_call.payload = serde_json::to_value(IntegrationModelResolutionRequest {
            selection: serde_json::from_value(serde_json::to_value(&definition.model_selection)?)?,
            requirements: IntegrationModelRequirements {
                tools: definition
                    .allowed_tools
                    .as_ref()
                    .is_none_or(|tools| !tools.is_empty()),
                ..Default::default()
            },
        })?
        .as_object()
        .context("OFFICE_MODEL_UNCONFIRMED")?
        .clone();
        let resolver = Arc::new(NativeModelPolicyResolver::capture(
            &self.caller.native,
            &self.origin,
        )?);
        let model = resolver.resolve_owned(model_call, cancel).await?;
        let supplied: IntegrationModelResolutionResult = serde_json::from_value(
            configuration
                .get("modelResolution")
                .context("OFFICE_MODEL_UNCONFIRMED")?
                .clone(),
        )?;
        ensure!(
            supplied.model == model.model
                && supplied.selection_kind == model.selection_kind
                && supplied.policy_ref == model.policy_ref,
            "OFFICE_MODEL_SELECTION_MISMATCH"
        );
        let task = PreparedRuntimeTask {
            input: vec![kcoder_app_protocol::UserInput::Text { text }],
            studio_work_mode: StudioWorkMode::Kworker,
            existing_thread_id: None,
            client_presentation: Some(ClientPresentationV1 {
                version: 1,
                studio_work_mode: Some(StudioWorkMode::Kworker),
                inline_widgets: false,
                isolated_widgets: false,
            }),
            configuration: RuntimeExecutionConfiguration {
                model,
                allowed_tools: Some(tools),
                external_send: RuntimeExternalSend::Deny,
                workflow: None,
            },
        };
        task.validate()?;
        let mut references = definition.resources.clone();
        references.extend(materials);
        let shared = Arc::new(OfficeExecution {
            caller: self.caller.clone(),
            request: request.clone(),
            task,
            adoption,
            references,
            state: OnceLock::new(),
            assets: Arc::new(super::rpc::management_assets(
                &self.caller.native,
                &self.origin,
                self.transfers.clone(),
                self.knowledge.clone(),
                self.connectivity.clone(),
            )?),
        });
        let value = Arc::new(OfficeAuthority {
            port: Arc::new(self.clone()),
            guard: Arc::new(OfficeGuard(shared.clone())),
            shared,
        });
        value.shared.current(cancel).await?;
        Ok(value)
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeOfficePorts for NativeOfficeRuntimePort {
    async fn call(
        &self,
        native: &NativeIntegrationContext,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        native.validate_scope(self.caller.native.scope())?;
        ensure!(
            port == IntegrationPort::Runtime && method == "acceptTask",
            "OFFICE_RUNTIME_METHOD_DENIED"
        );
        self.caller.verify()?;
        let snapshot = self.caller.snapshot()?;
        validated_runtime_body(&self.caller.original, &snapshot, request)?;
        let operation = request
            .operation_id
            .as_deref()
            .context("OFFICE_OPERATION_REQUIRED")?;
        if let Some(driver) = NativeRuntimeDriver::load(native)?
            && let Some(intent) = driver.source_intent(native, operation)?
        {
            ensure!(
                intent.original(native)? == request.clone(),
                "OFFICE_ORIGINAL_RUNTIME_CHANGED"
            );
            let receipt = driver
                .read_operation(native, operation)?
                .context("OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
            let accepted = receipt
                .runtime_acceptance
                .context("OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
            return Ok(IntegrationReply {
                contract_version: request.contract_version,
                request_id: request.request_id.clone(),
                operation_id: request
                    .operation_id
                    .clone()
                    .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
                entity_revision: IntegrationNullable::Null,
                status: IntegrationStatus::Accepted,
                observed_at: chrono::Utc::now().to_rfc3339(),
                result: IntegrationNullable::Value(
                    serde_json::to_value(accepted)?.as_object().unwrap().clone(),
                ),
                error: IntegrationNullable::Null,
            });
        }
        let authority = self.prepare(request, cancel).await?;
        self.runtime
            .accept(
                Arc::new(native.recapture_for_owned_service()?),
                request.clone(),
                authority.shared.task.clone(),
                authority,
            )
            .await
    }
}
struct OfficeExecution {
    caller: Arc<OriginalCaller>,
    request: IntegrationRequest,
    task: PreparedRuntimeTask,
    adoption: OfficeAssistantAdoption,
    references: Vec<OfficeResourceRef>,
    state: OnceLock<AppState>,
    assets: Arc<dyn NativeOfficeAssets>,
}
impl OfficeExecution {
    fn verify(&self) -> Result<()> {
        self.caller.verify()?;
        self.verify_snapshot(self.caller.snapshot()?)
    }
    fn verify_snapshot(&self, current: OfficeAssistantAdoption) -> Result<()> {
        self.caller.verify()?;
        ensure!(
            current.operation_id == self.adoption.operation_id
                && current.scope == self.adoption.scope
                && current.assistant == self.adoption.assistant
                && current.inputs == self.adoption.inputs,
            "OFFICE_ORIGINAL_ADOPTION_CHANGED"
        );
        Ok(())
    }
    async fn current(&self, cancel: &CancellationToken) -> Result<()> {
        self.caller.verify()?;
        self.verify_snapshot(self.caller.snapshot_async(cancel).await?)?;
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        self.assets
            .validate_sources(&self.caller.native, &self.request, &self.references, cancel)
            .await?;
        self.verify_snapshot(self.caller.snapshot_async(cancel).await?)
    }
    fn actor(&self, witness: &NativeToolExecutionWitness) -> Result<()> {
        self.verify()?;
        let state = self
            .state
            .get()
            .context("OFFICE_ORIGINAL_ENGINE_REQUIRED")?;
        let operation = self
            .request
            .operation_id
            .as_deref()
            .context("OFFICE_OPERATION_REQUIRED")?;
        let driver = NativeRuntimeDriver::load(&self.caller.native)?
            .context("OFFICE_RUNTIME_UNAVAILABLE")?;
        let intent = driver
            .source_intent(&self.caller.native, operation)?
            .context("OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        ensure!(
            intent.original(&self.caller.native)? == self.request
                && intent.prepared(&self.caller.native)? == self.task,
            "OFFICE_ORIGINAL_RUNTIME_CHANGED"
        );
        let accepted = driver
            .read_operation(&self.caller.native, operation)?
            .and_then(|receipt| receipt.runtime_acceptance)
            .context("OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        let attempt = witness
            .attempt()
            .context("OFFICE_ORIGINAL_ACCEPTED_REQUIRED")?;
        ensure!(
            witness.matches_state(state)
                && witness.parent().is_none()
                && attempt.thread_id == accepted.thread_id
                && accepted.turn_id.as_deref() == Some(attempt.turn_id.as_str())
                && state.matches_current_history_attempt(witness.attempt()),
            "OFFICE_ORIGINAL_ENGINE_CHANGED"
        );
        Ok(())
    }
}
struct OfficeAuthority {
    port: Arc<NativeOfficeRuntimePort>,
    shared: Arc<OfficeExecution>,
    guard: Arc<OfficeGuard>,
}
impl NativeRuntimeAuthority for OfficeAuthority {
    fn client_cancellation(&self) -> Option<CancellationToken> {
        Some(self.shared.caller.ended.clone())
    }
    fn verify_admission(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
    ) -> Result<()> {
        native.validate_scope(self.shared.caller.native.scope())?;
        ensure!(
            request == &self.shared.request && task == &self.shared.task,
            "OFFICE_ORIGINAL_RUNTIME_CHANGED"
        );
        self.shared.verify()
    }
    fn installer(&self) -> &dyn NativeRuntimePolicyInstaller {
        self
    }
    fn pre_start(&self) -> Option<NativeRuntimePreStart<'_>> {
        Some(NativeRuntimePreStart {
            factory: &self.port.factory,
            installer: self,
        })
    }
    fn current_source(&self) -> Option<&dyn NativeRuntimeCurrentSource> {
        Some(self)
    }
}
#[async_trait]
#[kcoder_async_box::shared]
impl NativeRuntimeCurrentSource for OfficeAuthority {
    async fn verify_current_source(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.verify_admission(native, request, task)?;
        self.shared.current(cancel).await
    }
}
impl NativeRuntimePolicyInstaller for OfficeAuthority {
    fn install(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        task: &PreparedRuntimeTask,
        engine: QueryEngine,
    ) -> Result<QueryEngine> {
        self.verify_admission(native, request, task)?;
        if let Some(state) = self.shared.state.get() {
            ensure!(
                state.inspection_lifecycle_identity().matches(&engine.state),
                "OFFICE_ORIGINAL_ENGINE_CHANGED"
            );
        } else {
            self.shared
                .state
                .set(engine.state.clone())
                .map_err(|_| anyhow::anyhow!("OFFICE_ORIGINAL_ENGINE_CHANGED"))?;
        }
        Ok(engine.with_native_tool_authorization(self.guard.clone()))
    }
}
struct OfficeGuard(Arc<OfficeExecution>);
#[async_trait]
#[kcoder_async_box::shared]
impl NativeToolAuthorization for OfficeGuard {
    async fn authorize_provider(
        &self,
        witness: &NativeToolExecutionWitness,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.0
            .actor(witness)
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        self.0
            .current(&CancellationToken::new())
            .await
            .map_err(|_| NativeToolAuthorizationError::Unavailable)
    }
    async fn authorize_event(
        &self,
        frame: &NativeEngineEventFrame,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.0
            .actor(frame.execution())
            .map_err(|_| NativeToolAuthorizationError::Unavailable)
    }
    async fn authorize(
        &self,
        request: &NativeToolAuthorizationRequest<'_>,
    ) -> std::result::Result<(), NativeToolAuthorizationError> {
        self.0
            .actor(
                request
                    .execution
                    .ok_or(NativeToolAuthorizationError::Unavailable)?,
            )
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        self.0
            .current(&CancellationToken::new())
            .await
            .map_err(|_| NativeToolAuthorizationError::Unavailable)?;
        let emitter = request
            .emitter
            .ok_or(NativeToolAuthorizationError::Unavailable)?;
        let known = emitter
            .downcast_tool::<kcoder_tools::integrations::office::OfficeDocumentTool>()
            .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::integrations::office::OfficeReadTool>()
                .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::integrations::office::OfficeDataTool>()
                .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::integrations::office::OfficeExportTool>()
                .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::integrations::office::OfficeCardTool>()
                .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::tool_search::ToolSearchTool>()
                .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::tool_execute::ToolExecuteTool>()
                .is_some()
            || emitter
                .downcast_tool::<kcoder_tools::AskUserQuestionTool>()
                .is_some();
        if known {
            Ok(())
        } else {
            Err(NativeToolAuthorizationError::Denied)
        }
    }
}
#[cfg(test)]
#[path = "runtime_port_tests.rs"]
mod tests;
