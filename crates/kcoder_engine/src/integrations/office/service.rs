//! Office orchestration over injected, authenticated native providers.
use super::{dataset_page, export_dataset};
use crate::integrations::agent_definitions::{
    AgentDefinitionHost, AgentDefinitionService, child_operation, hash, now, operation,
    page_values, payload,
};
mod definition_host_adapter;
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use definition_host_adapter::DefinitionHostAdapter;
use kcoder_config::integrations::office::{OfficeSettings, prepare_office_inputs};
use kcoder_state::integrations::office::ResourceStore;
use kcoder_types::integrations::{core::*, office::*};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

mod artifact;
mod artifact_actions;
mod asset;
mod assistant;
use crate::integrations::agent_definitions::SharedAgentDefinition;

pub struct OfficePublishedContent {
    pub manifest: OfficeArtifactManifest,
    pub bytes: Vec<u8>,
}

pub struct OfficeGeneratedFile {
    pub format: AgentResourceFormat,
    pub bytes: Vec<u8>,
    pub verification: OfficeVerification,
    pub generator: OfficeGeneratorIdentity,
}

#[async_trait]
pub trait OfficeHost: Send + Sync {
    /// Validate the active authenticated host, including identity and target generations.
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()>;
    fn validate_task(&self, scope: &IntegrationScope, task: &OfficeTaskRef) -> Result<()>;
    /// Resolve actual source records under current native authority, never caller paths.
    async fn validate_sources(
        &self,
        request: &IntegrationRequest,
        sources: &[AgentResourceRef],
        cancel: &CancellationToken,
    ) -> Result<()>;
    /// Return exact content identities from current native source records, not
    /// hashes of IDs or model-supplied assertions. Old revisions stay pinned.
    async fn resolve_source_content_identities(
        &self,
        _request: &IntegrationRequest,
        sources: &[AgentResourceRef],
        _cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        ensure!(sources.is_empty(), "OFFICE_SOURCE_IDENTITIES_UNAVAILABLE");
        Ok(Vec::new())
    }
    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply>;
    async fn generate(
        &self,
        request: &IntegrationRequest,
        specification: &Value,
        cancel: &CancellationToken,
    ) -> Result<OfficeGeneratedFile>;
    async fn generator_readiness(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value>;
    /// Export bytes through a current controlled native lease. Return an opaque
    /// receipt; a local path is never an external-platform delivery URL.
    async fn prepare_export(
        &self,
        request: &IntegrationRequest,
        manifest: &OfficeArtifactManifest,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<Value>;
    async fn organization_templates(
        &self,
        _request: &IntegrationRequest,
        _cancel: &CancellationToken,
    ) -> Result<Vec<SharedAgentDefinition>> {
        anyhow::bail!("OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    async fn publish_organization_template(
        &self,
        _request: &IntegrationRequest,
        _version: &AgentDefinitionVersion,
        _cancel: &CancellationToken,
    ) -> Result<AgentResourceRef> {
        anyhow::bail!("OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    async fn archive_organization_template(
        &self,
        _request: &IntegrationRequest,
        _publication: &AgentResourceRef,
        _cancel: &CancellationToken,
    ) -> Result<()> {
        anyhow::bail!("OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    /// Validate a real current native user approval bound to the persisted
    /// artifact/destination/purpose. JSON approved flags are never authority.
    async fn authorize_artifact_action(
        &self,
        _request: &IntegrationRequest,
        _intent: &Value,
        _cancel: &CancellationToken,
    ) -> Result<()> {
        anyhow::bail!("OFFICE_ACTION_AUTHORIZATION_UNAVAILABLE")
    }
    async fn read_input(
        &self,
        _request: &IntegrationRequest,
        _reference: &OfficeArtifactRef,
        _cursor: Option<&str>,
        _limit: usize,
        _ctx: &kcoder_tools::ToolContext,
    ) -> Result<Value> {
        anyhow::bail!("OFFICE_INPUT_PROVIDER_UNAVAILABLE")
    }
    async fn prepare_input(
        &self,
        _request: &IntegrationRequest,
        _cancel: &CancellationToken,
    ) -> Result<kcoder_state::integrations::office::OfficeInputReceipt> {
        anyhow::bail!("OFFICE_INPUT_PROVIDER_UNAVAILABLE")
    }
    async fn accept_written_artifact(
        &self,
        _request: &IntegrationRequest,
        _cancel: &CancellationToken,
    ) -> Result<OfficePublishedContent> {
        anyhow::bail!("OFFICE_NATIVE_ARTIFACT_UNAVAILABLE")
    }
    async fn verify(
        &self,
        request: &IntegrationRequest,
        manifest: &OfficeArtifactManifest,
        bytes: Vec<u8>,
        cancel: &CancellationToken,
    ) -> Result<OfficeVerification>;
}

pub struct OfficeService {
    pub definitions: AgentDefinitionService,
    pub store: Arc<ResourceStore>,
    pub settings: OfficeSettings,
    pub host: Arc<dyn OfficeHost>,
}
impl OfficeService {
    /// Native tool entry only; public RPC dispatch never accepts this receipt.
    pub async fn dispatch_native_document(
        &self,
        request: &IntegrationRequest,
        receipt: kcoder_state::integrations::office::OfficeCanonicalToolReceipt,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(request, cancel)?;
        self.policy(
            request,
            "office.document.generate",
            Value::Object(request.payload.clone()),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        ensure!(
            receipt.tool_name == "OfficeDocument"
                && request.operation_id.as_deref() == Some(receipt.operation_id.as_str()),
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        let task: OfficeTaskRef = serde_json::from_value(
            request
                .payload
                .get("task")
                .cloned()
                .context("OFFICE_INVALID_INPUT")?,
        )?;
        self.host.validate_task(&request.scope, &task)?;
        ensure!(
            task.thread_id == receipt.session_id,
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        self.store.prepare_canonical_tool_receipt(receipt)?;
        self.generate(request, cancel).await
    }
    /// Only the original Native backend supplies this call receipt. Public card
    /// RPC data cannot mint a Native producer observation for channel resources.
    pub async fn dispatch_native_card(
        &self,
        request: &IntegrationRequest,
        receipt: kcoder_state::integrations::office::OfficeCanonicalToolReceipt,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(request, cancel)?;
        ensure!(
            receipt.tool_name == "OfficeCard"
                && request.operation_id.as_deref() == Some(receipt.operation_id.as_str()),
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        let task: OfficeTaskRef = serde_json::from_value(
            request
                .payload
                .get("task")
                .cloned()
                .context("OFFICE_INVALID_INPUT")?,
        )?;
        self.host.validate_task(&request.scope, &task)?;
        ensure!(
            task.thread_id == receipt.session_id,
            "OFFICE_NATIVE_PROJECTION_BINDING_MISMATCH"
        );
        self.policy(
            request,
            "office.artifact.publish",
            Value::Object(request.payload.clone()),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        let value = self
            .dispatch(
                "integrations/artifact/createCard",
                request,
                "office.artifact.publish",
                cancel,
            )
            .await?;
        self.check(request, cancel)?;
        self.host.validate_task(&request.scope, &task)?;
        // Unlike generation source preparation, a card has no canonical source
        // descriptor. Publish its Native producer observation only after the
        // actual original card action completed successfully.
        self.store.prepare_canonical_tool_receipt(receipt)?;
        Ok(value)
    }
    pub fn new(
        store: Arc<ResourceStore>,
        settings: OfficeSettings,
        host: Arc<dyn OfficeHost>,
    ) -> Result<Self> {
        settings.validate()?;
        let definitions = AgentDefinitionService {
            store: store.clone(),
            allow_organization_templates: settings.allow_organization_templates,
            host: Arc::new(DefinitionHostAdapter {
                host: host.clone(),
                store: store.clone(),
                settings: settings.clone(),
            }),
        };
        Ok(Self {
            definitions,
            store,
            settings,
            host,
        })
    }
    pub async fn dispatch(
        &self,
        method: &str,
        request: &IntegrationRequest,
        action: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        if AgentDefinitionService::handles(method) {
            return self
                .definitions
                .dispatch(method, request, action, cancel)
                .await;
        }
        self.check(request, cancel)?;
        self.policy(
            request,
            action,
            Value::Object(request.payload.clone()),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        match method {
            method if method.starts_with("integrations/assistant/") => {
                self.assistant(method, request, cancel).await
            }
            method if method.starts_with("integrations/artifact/") => {
                self.artifact(method, request, cancel).await
            }
            "integrations/dataset/create" => {
                let data: OfficeDataset = payload(request)?;
                data.validate()?;
                self.host.validate_task(
                    &request.scope,
                    data.task.as_ref().context("OFFICE_DATASET_TASK_REQUIRED")?,
                )?;
                ensure!(
                    data.rows.len() <= self.settings.max_dataset_rows,
                    "OFFICE_DATASET_LIMIT"
                );
                self.host
                    .validate_sources(request, &data.source_refs, cancel)
                    .await?;
                self.check(request, cancel)?;
                Ok(json!({"reference":self.store.create_dataset(operation(request)?,data)?}))
            }
            "integrations/dataset/schema"
            | "integrations/dataset/page"
            | "integrations/dataset/query" => {
                let reference: OfficeArtifactRef = serde_json::from_value(
                    request
                        .payload
                        .get("reference")
                        .cloned()
                        .context("OFFICE_INVALID_INPUT")?,
                )?;
                let data = self
                    .store
                    .read_dataset(&reference)?
                    .context("OFFICE_DATASET_NOT_FOUND")?;
                if method.ends_with("/schema") {
                    return Ok(
                        json!({"reference":reference,"columns":data.columns,"totalRows":data.rows.len(),"sourceRefs":data.source_refs}),
                    );
                }
                let query: OfficeDatasetQuery = serde_json::from_value(
                    request
                        .payload
                        .get("query")
                        .cloned()
                        .context("OFFICE_INVALID_INPUT")?,
                )?;
                ensure!(
                    query.limit <= self.settings.dataset_page_rows,
                    "OFFICE_PAGE_LIMIT"
                );
                Ok(serde_json::to_value(dataset_page(
                    &data,
                    &query,
                    &request.scope,
                    cancel,
                )?)?)
            }
            "integrations/dataset/export" => self.export_dataset(request, cancel).await,
            "integrations/office/generate" => self.generate(request, cancel).await,
            "integrations/office/readiness" => self.generator_readiness(request, cancel).await,
            "integrations/office/readOperation" => self.read_operation(request),
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        }
    }
    async fn generator_readiness(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(request, cancel)?;
        let mut report=self.host.generator_readiness(request,cancel).await.unwrap_or_else(|_|json!({"status":"unavailable","supportedFormats":[],"reasonCode":"OFFICE_COMPONENT_UNAVAILABLE"}));
        self.check(request, cancel)?;
        let mut formats = report
            .get("supportedFormats")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for format in [AgentResourceFormat::Csv, AgentResourceFormat::Json] {
            if self.settings.allowed_formats.contains(&format)
                && !formats
                    .iter()
                    .any(|value| value.as_str() == Some(format.extension()))
            {
                formats.push(json!(format.extension()));
            }
        }
        let status = if report.get("status").and_then(Value::as_str) == Some("available") {
            "available"
        } else if formats.is_empty() {
            "unavailable"
        } else {
            "partial"
        };
        if let Some(object) = report.as_object_mut() {
            object.insert("status".into(), json!(status));
            object.insert("supportedFormats".into(), json!(formats));
            object.insert("nativeDatasetExports".into(), json!(["csv", "json"]));
        } else {
            anyhow::bail!("OFFICE_DEPENDENCY_UNKNOWN");
        }
        Ok(report)
    }
    fn check(&self, request: &IntegrationRequest, cancel: &CancellationToken) -> Result<()> {
        ensure!(self.settings.enabled, "OFFICE_DISABLED");
        self.definitions.check(request, cancel)
    }
    async fn policy(
        &self,
        request: &IntegrationRequest,
        action: &str,
        resources: Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.definitions
            .policy(request, action, resources, cancel)
            .await
    }
    async fn port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
        accept: bool,
    ) -> Result<Value> {
        self.definitions
            .port(port, method, request, cancel, accept)
            .await
    }
    fn reserve(&self, request: &IntegrationRequest, method: &str) -> Result<Option<Value>> {
        self.definitions.reserve(request, method)
    }
    fn complete(&self, request: &IntegrationRequest, value: Value) -> Result<Value> {
        self.definitions.complete(request, value)
    }
    fn read_operation(&self, request: &IntegrationRequest) -> Result<Value> {
        let operation = request
            .payload
            .get("operationId")
            .and_then(Value::as_str)
            .context("OFFICE_INVALID_INPUT")?;
        if let Some(record) = self.store.read_action(operation)? {
            return Ok(json!({
                "operationId":record.operation_id,
                "method":record.method,
                "phase":record.phase,
                "result":record.result,
                "recovery":if record.phase=="completed"{"none"}else{"reconcile_original"}
            }));
        }
        let result = self
            .store
            .read_operation(operation)?
            .context("OFFICE_ACTION_NOT_FOUND")?;
        // Native owns current task/source/PDP verification for durable byte ACKs.
        ensure!(
            result.get("kind").and_then(Value::as_str) != Some("office_export_acknowledgement"),
            "OFFICE_EXPORT_PROVIDER_UNAVAILABLE"
        );
        Ok(json!({
            "operationId":operation,
            "method":"state.transaction",
            "phase":"completed",
            "result":result,
            "recovery":"none"
        }))
    }
}
#[cfg(test)]
mod tests;
