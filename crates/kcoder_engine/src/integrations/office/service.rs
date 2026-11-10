//! Office orchestration over injected, authenticated native providers.
use super::{dataset_page, export_dataset};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_config::integrations::office::{
    BUILTIN_OFFICE_ASSISTANT_VERSION, OfficeSettings, builtin_octop_assistants,
    builtin_octop_package, builtin_office_assistant, builtin_office_assistant_version,
    builtin_office_assistants, prepare_office_inputs, validate_office_definition,
};
use kcoder_state::integrations::office::OfficeStore;
use kcoder_types::integrations::{core::*, office::*};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

mod artifact;
mod artifact_actions;
mod asset;
mod assistant;
mod expert;
mod organization;
mod skills;
#[derive(Clone)]
pub struct OfficeSharedAssistant {
    pub version: OfficeAssistantVersion,
    pub publication: OfficeResourceRef,
}

pub struct OfficePublishedContent {
    pub manifest: OfficeArtifactManifest,
    pub bytes: Vec<u8>,
}

pub struct OfficeGeneratedFile {
    pub format: OfficeFileFormat,
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
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<()>;
    /// Return exact content identities from current native source records, not
    /// hashes of IDs or model-supplied assertions. Old revisions stay pinned.
    async fn resolve_source_content_identities(
        &self,
        _request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
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
    ) -> Result<Vec<OfficeSharedAssistant>> {
        anyhow::bail!("OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    async fn publish_organization_template(
        &self,
        _request: &IntegrationRequest,
        _version: &OfficeAssistantVersion,
        _cancel: &CancellationToken,
    ) -> Result<OfficeResourceRef> {
        anyhow::bail!("OFFICE_ORGANIZATION_PROVIDER_UNAVAILABLE")
    }
    async fn archive_organization_template(
        &self,
        _request: &IntegrationRequest,
        _publication: &OfficeResourceRef,
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
    pub store: Arc<OfficeStore>,
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
        store: Arc<OfficeStore>,
        settings: OfficeSettings,
        host: Arc<dyn OfficeHost>,
    ) -> Result<Self> {
        settings.validate()?;
        Ok(Self {
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
            "integrations/office/readOperation" => {
                let operation = request
                    .payload
                    .get("operationId")
                    .and_then(Value::as_str)
                    .context("OFFICE_INVALID_INPUT")?;
                let Some(record) = self.store.read_action(operation)? else {
                    let result = self
                        .store
                        .read_operation(operation)?
                        .context("OFFICE_ACTION_NOT_FOUND")?;
                    // Native owns current task/source/PDP verification for durable byte ACKs.
                    ensure!(
                        result.get("kind").and_then(Value::as_str)
                            != Some("office_export_acknowledgement"),
                        "OFFICE_EXPORT_PROVIDER_UNAVAILABLE"
                    );
                    return Ok(
                        json!({"operationId":operation,"method":"state.transaction","phase":"completed","result":result,"recovery":"none"}),
                    );
                };
                Ok(
                    json!({"operationId":record.operation_id,"method":record.method,"phase":record.phase,"result":record.result,"recovery":if record.phase=="completed"{"none"}else{"reconcile_original"}}),
                )
            }
            "integrations/office/generate" => self.generate(request, cancel).await,
            "integrations/office/readiness" => self.generator_readiness(request, cancel).await,
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
        for format in [OfficeFileFormat::Csv, OfficeFileFormat::Json] {
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
        ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
        request.scope.validate()?;
        self.host.validate_scope(&request.scope)?;
        ensure!(
            IntegrationOwner::from(&request.scope) == *self.store.owner(),
            "OFFICE_OWNER_MISMATCH"
        );
        Ok(())
    }
    async fn policy(
        &self,
        request: &IntegrationRequest,
        action: &str,
        resources: Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut call = request.clone();
        call.payload = json!({"action":action,"resources":resources})
            .as_object()
            .context("OFFICE_INVALID_INPUT")?
            .clone();
        let value = self
            .port(
                IntegrationPort::Policy,
                "evaluateAction",
                &call,
                cancel,
                false,
            )
            .await?;
        let evaluation: IntegrationPolicyEvaluation =
            serde_json::from_value(value).context("OFFICE_POLICY_UNCONFIRMED")?;
        ensure!(
            !evaluation.policy_revision.is_empty(),
            "OFFICE_POLICY_UNCONFIRMED"
        );
        ensure!(
            evaluation.decision == IntegrationPolicyDecision::Allow,
            if evaluation.decision == IntegrationPolicyDecision::Deny {
                "OFFICE_POLICY_DENIED"
            } else {
                "OFFICE_POLICY_UNCONFIRMED"
            }
        );
        Ok(())
    }
    async fn port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
        accept: bool,
    ) -> Result<Value> {
        request.validate_method(port, method)?;
        self.check(request, cancel)?;
        let reply = self.host.call_port(port, method, request, cancel).await?;
        reply.validate()?;
        ensure!(
            reply.request_id == request.request_id
                && reply.operation_id.as_ref() == request.operation_id.as_ref(),
            "OFFICE_PORT_IDENTITY_MISMATCH"
        );
        match reply.status {
            IntegrationStatus::Rejected => anyhow::bail!("OFFICE_PORT_REJECTED"),
            IntegrationStatus::Unavailable => anyhow::bail!("OFFICE_PORT_UNAVAILABLE"),
            IntegrationStatus::Unknown => anyhow::bail!("OFFICE_PORT_UNCONFIRMED"),
            _ => {}
        }
        ensure!(
            reply.status == IntegrationStatus::Completed
                || (accept && reply.status == IntegrationStatus::Accepted),
            "OFFICE_PORT_UNCONFIRMED"
        );
        self.check(request, cancel)?;
        Ok(Value::Object(
            reply
                .result
                .as_ref()
                .context("OFFICE_PORT_RESULT_MISSING")?
                .clone(),
        ))
    }
    fn expected(request: &IntegrationRequest) -> Result<Option<u64>> {
        request
            .expected_revision
            .as_ref()
            .map(|revision| revision.parse::<u64>().context("OFFICE_INVALID_REVISION"))
            .transpose()
    }
    fn reserve(&self, request: &IntegrationRequest, method: &str) -> Result<Option<Value>> {
        let (fresh, record) = self.store.begin_action(
            operation(request)?,
            method,
            &Value::Object(request.payload.clone()),
        )?;
        if fresh {
            Ok(None)
        } else if record.phase == "completed" {
            Ok(Some(record.result.context("OFFICE_RECEIPT_CORRUPT")?))
        } else {
            anyhow::bail!("OFFICE_RECONCILIATION_REQUIRED")
        }
    }
    fn complete(&self, request: &IntegrationRequest, value: Value) -> Result<Value> {
        self.store.complete_action(operation(request)?, &value)?;
        Ok(value)
    }
}
fn operation(request: &IntegrationRequest) -> Result<&str> {
    request
        .operation_id
        .as_deref()
        .context("OFFICE_OPERATION_REQUIRED")
}
fn payload<T: DeserializeOwned>(request: &IntegrationRequest) -> Result<T> {
    serde_json::from_value(Value::Object(request.payload.clone())).context("OFFICE_INVALID_INPUT")
}
fn now() -> Result<u64> {
    u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )
    .context("OFFICE_CLOCK_UNAVAILABLE")
}
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
fn child_operation(request: &IntegrationRequest, suffix: &str) -> Result<String> {
    Ok(format!(
        "office-{}",
        hash(format!("{}:{suffix}", operation(request)?).as_bytes())
    ))
}
fn page_values<T: serde::Serialize>(values: Vec<T>, request: &IntegrationRequest) -> Result<Value> {
    let limit = request
        .payload
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10);
    ensure!((1..=10).contains(&limit), "OFFICE_INVALID_PAGE_LIMIT");
    let identity = hash(&serde_json::to_vec(&(
        values
            .iter()
            .map(serde_json::to_value)
            .collect::<std::result::Result<Vec<_>, _>>()?,
        &request.scope,
    ))?);
    let cursor = request.payload.get("cursor").and_then(Value::as_str);
    let offset = match cursor {
        None => 0,
        Some(cursor) => {
            let (fingerprint, offset) = cursor.split_once(':').context("OFFICE_INVALID_CURSOR")?;
            ensure!(fingerprint == identity, "OFFICE_STALE_CURSOR");
            offset.parse::<usize>().context("OFFICE_INVALID_CURSOR")?
        }
    };
    ensure!(offset <= values.len(), "OFFICE_INVALID_CURSOR");
    let total = values.len();
    let end = (offset + limit as usize).min(total);
    let items = values
        .into_iter()
        .skip(offset)
        .take(limit as usize)
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(
        json!({"items":items,"total":total,"nextCursor":if end<total {Some(format!("{identity}:{end}"))}else{None}}),
    )
}

#[cfg(test)]
mod tests;
