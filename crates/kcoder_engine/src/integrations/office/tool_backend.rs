//! Native tool binding. Only the host can resolve a current AppState/turn/scope.
use super::*;
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_state::AppStateIdentity;
use kcoder_tools::{
    ToolContext, ToolError,
    integrations::office::{OfficeDataAction, OfficeExportSource, OfficeToolBackend},
};
use kcoder_types::integrations::{core::*, office::*};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct OfficeNativeToolOwner {
    pub scope: IntegrationScope,
    pub task: OfficeTaskRef,
    pub state_identity: AppStateIdentity,
    pub native_call_id: String,
    pub operation_id: String,
}
pub type OfficeToolOwnerResolver =
    Arc<dyn Fn(&ToolContext) -> Result<OfficeNativeToolOwner> + Send + Sync>;
pub struct OfficeNativeToolBackend {
    service: Arc<OfficeService>,
    revision: String,
    resolve: OfficeToolOwnerResolver,
}
impl OfficeNativeToolBackend {
    pub fn new(
        service: Arc<OfficeService>,
        revision: String,
        resolve: OfficeToolOwnerResolver,
    ) -> Result<Self> {
        ensure!(
            !revision.is_empty()
                && revision.chars().count() <= 128
                && !revision.chars().any(char::is_control),
            "OFFICE_NATIVE_SOURCE_REVISION_REQUIRED"
        );
        Ok(Self {
            service,
            revision,
            resolve,
        })
    }
    fn request(
        &self,
        ctx: &ToolContext,
        payload: Value,
        mutation: bool,
    ) -> Result<IntegrationRequest> {
        let owner = (self.resolve)(ctx)?;
        self.request_for_owner(ctx, payload, mutation, &owner)
    }
    fn request_for_owner(
        &self,
        ctx: &ToolContext,
        payload: Value,
        mutation: bool,
        owner: &OfficeNativeToolOwner,
    ) -> Result<IntegrationRequest> {
        ensure!(
            owner.state_identity.matches(&ctx.state)
                && owner.task.thread_id == ctx.state.session_id()
                && ctx.tool_call_id.as_deref() == Some(owner.native_call_id.as_str()),
            "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
        );
        self.service.host.validate_scope(&owner.scope)?;
        self.service.host.validate_task(&owner.scope, &owner.task)?;
        if let Some(task) = payload.get("task") {
            ensure!(
                task == &serde_json::to_value(&owner.task)?,
                "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
            );
        }
        let request = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: format!("office-call-{}", uuid::Uuid::new_v4()),
            scope: owner.scope.clone(),
            operation_id: mutation.then(|| owner.operation_id.clone()),
            expected_revision: None,
            timeout_ms: 60_000,
            cancellation_ref: None,
            payload: payload.as_object().context("OFFICE_INVALID_INPUT")?.clone(),
        };
        request.validate(mutation)?;
        Ok(request)
    }
    fn cancel(ctx: &ToolContext) -> CancellationToken {
        ctx.abort_token
            .as_ref()
            .map(CancellationToken::child_token)
            .unwrap_or_default()
    }
}
#[async_trait]
impl OfficeToolBackend for OfficeNativeToolBackend {
    fn source_revision(&self) -> &str {
        &self.revision
    }
    async fn create_document(
        &self,
        specification: OfficeGenerationSpec,
        sources: Vec<OfficeResourceRef>,
        original_input: Value,
        ctx: &ToolContext,
    ) -> std::result::Result<Value, ToolError> {
        let owner = (self.resolve)(ctx).map_err(public)?;
        let payload = json!({"task":owner.task,"specification":specification,"sourceRefs":sources});
        let mut request = self
            .request_for_owner(ctx, payload, true, &owner)
            .map_err(public)?;
        request.timeout_ms = self.service.settings.generation_timeout_ms;
        let cancel = Self::cancel(ctx);
        let receipt = kcoder_state::integrations::office::OfficeCanonicalToolReceipt {
            session_id: owner.task.thread_id,
            tool_call_id: owner.native_call_id,
            tool_name: "OfficeDocument".into(),
            feature: "office".into(),
            source_revision: self.revision.clone(),
            original_input_sha256: super::office_tool_input_sha256(&original_input)
                .map_err(public)?,
            operation_id: owner.operation_id,
        };
        let work = self
            .service
            .dispatch_native_document(&request, receipt, &cancel);
        tokio::pin!(work);
        let value = tokio::select! {result=&mut work=>result,_=tokio::time::sleep(std::time::Duration::from_millis(request.timeout_ms))=>{cancel.cancel();let _=tokio::time::timeout(std::time::Duration::from_secs(5),&mut work).await;Err(anyhow::anyhow!("OFFICE_TIMEOUT"))}};
        value.map_err(|error|{let code=safe_code(&error);ToolError::Execution(json!({"code":code,"operationId":request.operation_id,"recovery":"reconcile_original"}).to_string())})
    }
    async fn read_canonical_source(
        &self,
        parameters: OfficeCanonicalSourceReadParams,
        ctx: &ToolContext,
    ) -> std::result::Result<Value, ToolError> {
        let payload = serde_json::to_value(parameters)
            .map_err(|_| ToolError::Execution("OFFICE_INVALID_INPUT".into()))?;
        let request = self.request(ctx, payload, false).map_err(public)?;
        self.service
            .dispatch(
                "integrations/artifact/source",
                &request,
                "office.artifact.source.read",
                &Self::cancel(ctx),
            )
            .await
            .map_err(public)
    }
    async fn read_data(
        &self,
        action: OfficeDataAction,
        reference: OfficeArtifactRef,
        query: Option<OfficeDatasetQuery>,
        ctx: &ToolContext,
    ) -> std::result::Result<Value, ToolError> {
        if action == OfficeDataAction::CanonicalSource {
            if query.is_some() {
                return Err(ToolError::InvalidInput(
                    "canonical_source does not accept a dataset query".into(),
                ));
            }
            return self
                .read_canonical_source(
                    OfficeCanonicalSourceReadParams {
                        reference,
                        metadata_only: true,
                        expected_sha256: None,
                        offset: 0,
                        limit: OFFICE_CANONICAL_SOURCE_CHUNK_BYTES,
                    },
                    ctx,
                )
                .await;
        }
        let payload = json!({"reference":reference,"query":query});
        let mut request = self.request(ctx, payload, false).map_err(public)?;
        let cancel = Self::cancel(ctx);
        let result = match action {
            OfficeDataAction::CanonicalSource => Err(anyhow::anyhow!("OFFICE_INVALID_INPUT")),
            OfficeDataAction::ReadManifest => {
                request.payload.remove("query");
                self.service
                    .dispatch(
                        "integrations/artifact/read",
                        &request,
                        "office.artifact.read",
                        &cancel,
                    )
                    .await
            }
            OfficeDataAction::Schema => {
                request.payload.remove("query");
                self.service
                    .dispatch(
                        "integrations/dataset/schema",
                        &request,
                        "office.dataset.read",
                        &cancel,
                    )
                    .await
            }
            OfficeDataAction::Page | OfficeDataAction::Query => {
                self.service
                    .dispatch(
                        "integrations/dataset/page",
                        &request,
                        "office.dataset.read",
                        &cancel,
                    )
                    .await
            }
            OfficeDataAction::ReadVerification => {
                request.payload.remove("query");
                self.service
                    .dispatch(
                        "integrations/artifact/verification",
                        &request,
                        "office.artifact.read",
                        &cancel,
                    )
                    .await
            }
            OfficeDataAction::ReadOperation => {
                request.payload = json!({"operationId":reference.id})
                    .as_object()
                    .context("OFFICE_INVALID_INPUT")
                    .map_err(public)?
                    .clone();
                self.service
                    .dispatch(
                        "integrations/office/readOperation",
                        &request,
                        "office.operation.read",
                        &cancel,
                    )
                    .await
            }
            OfficeDataAction::Projection => {
                self.service
                    .read_projection_for_tool(&request, &reference, &cancel)
                    .await
            }
        };
        result.map_err(public)
    }
    async fn create_card(
        &self,
        title: String,
        presentation: OfficeArtifactPresentation,
        sources: Vec<OfficeResourceRef>,
        original_input: Value,
        ctx: &ToolContext,
    ) -> std::result::Result<Value, ToolError> {
        let owner = (self.resolve)(ctx).map_err(public)?;
        let payload = json!({"task":owner.task,"title":title,"presentation":presentation,"sourceRefs":sources});
        let request = self
            .request_for_owner(ctx, payload, true, &owner)
            .map_err(public)?;
        let receipt = kcoder_state::integrations::office::OfficeCanonicalToolReceipt {
            session_id: owner.task.thread_id,
            tool_call_id: owner.native_call_id,
            tool_name: "OfficeCard".into(),
            feature: "office".into(),
            source_revision: self.revision.clone(),
            original_input_sha256: super::office_tool_input_sha256(&original_input)
                .map_err(public)?,
            operation_id: owner.operation_id,
        };
        self.service
            .dispatch_native_card(&request, receipt, &Self::cancel(ctx))
            .await
            .map_err(public)
    }
    async fn export_artifact(
        &self,
        source: OfficeExportSource,
        reference: OfficeArtifactRef,
        format: OfficeFileFormat,
        ctx: &ToolContext,
    ) -> std::result::Result<Value, ToolError> {
        let owner = (self.resolve)(ctx).map_err(public)?;
        let request = self
            .request(
                ctx,
                json!({"reference":reference,"format":format,"task":owner.task}),
                true,
            )
            .map_err(public)?;
        let cancel = Self::cancel(ctx);
        let method = match source {
            OfficeExportSource::Artifact => "integrations/artifact/export",
            OfficeExportSource::Dataset => "integrations/dataset/export",
        };
        let value = self
            .service
            .dispatch(method, &request, "office.artifact.export", &cancel)
            .await
            .map_err(public)?;
        Ok(
            json!({"artifactRef":value.get("manifest").map(|manifest|json!({"id":manifest.get("id"),"revision":manifest.get("revision")})).unwrap_or_else(||json!(reference)),"export":value.get("export"),"delivered":false,"viewed":false}),
        )
    }
    async fn read_input(
        &self,
        reference: OfficeArtifactRef,
        cursor: Option<String>,
        limit: usize,
        ctx: &ToolContext,
    ) -> std::result::Result<Value, ToolError> {
        let request = self
            .request(
                ctx,
                json!({"reference":reference,"cursor":cursor,"limit":limit}),
                false,
            )
            .map_err(public)?;
        let cancel = Self::cancel(ctx);
        self.service
            .read_input_for_tool(&request, &reference, cursor.as_deref(), limit, ctx, &cancel)
            .await
            .map_err(public)
    }
}
fn safe_code(error: &anyhow::Error) -> &'static str {
    error
        .chain()
        .find_map(|error| office_public_error_code(&error.to_string()))
        .unwrap_or("OFFICE_OPERATION_FAILED")
}
fn public(error: anyhow::Error) -> ToolError {
    ToolError::Execution(safe_code(&error).into())
}
