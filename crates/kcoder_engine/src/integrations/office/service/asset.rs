//! The fixed six-method P-ASSET provider. Byte streams remain host-private.
use super::*;
impl OfficeService {
    pub async fn read_input_for_tool(
        &self,
        request: &IntegrationRequest,
        reference: &OfficeArtifactRef,
        cursor: Option<&str>,
        limit: usize,
        ctx: &kcoder_tools::ToolContext,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(request, cancel)?;
        ensure!(
            (1..=4).contains(&limit) && reference.revision == 1,
            "OFFICE_INVALID_INPUT"
        );
        let record = self
            .store
            .read_input(&reference.id)?
            .context("OFFICE_INPUT_NOT_FOUND")?;
        ensure!(
            record.receipt.status == "accepted",
            "OFFICE_INPUT_UNCONFIRMED"
        );
        self.policy(
            request,
            "office.input.read",
            json!({"inputId":reference.id,"revision":reference.revision}),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        let value = self
            .host
            .read_input(request, reference, cursor, limit, ctx)
            .await?;
        self.check(request, cancel)?;
        ensure!(
            value.get("reference") == Some(&serde_json::to_value(reference)?)
                && value.get("sha256").and_then(Value::as_str) == record.receipt.sha256.as_deref(),
            "OFFICE_INPUT_HASH_MISMATCH"
        );
        Ok(value)
    }
    pub async fn read_projection_for_tool(
        &self,
        request: &IntegrationRequest,
        reference: &OfficeArtifactRef,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        self.check(request, cancel)?;
        self.policy(
            request,
            "office.context.read",
            json!({"reference":reference}),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        Ok(
            json!({"projection":self.store.read_projection(reference)?.context("OFFICE_PROJECTION_NOT_FOUND")?}),
        )
    }

    pub async fn dispatch_asset(
        &self,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        request.validate_method(IntegrationPort::Asset, method)?;
        self.check(request, cancel)?;
        let action = match method {
            "prepareInput" => "office.input.prepare",
            "readInputReceipt" => "office.input.read",
            "publishManifest" => "office.artifact.publish",
            "readManifest" => "office.artifact.read",
            "readDatasetPage" => "office.dataset.read",
            "prepareExport" => "office.artifact.export",
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        };
        self.policy(
            request,
            action,
            Value::Object(request.payload.clone()),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        match method {
            "prepareInput" => {
                let receipt = self.host.prepare_input(request, cancel).await?;
                self.check(request, cancel)?;
                ensure!(
                    receipt.owner == *self.store.owner() && receipt.status == "accepted",
                    "OFFICE_INPUT_UNCONFIRMED"
                );
                let record = self
                    .store
                    .read_input(&receipt.input_id)?
                    .context("OFFICE_INPUT_UNCONFIRMED")?;
                ensure!(
                    record.receipt == receipt && record.native.is_some(),
                    "OFFICE_INPUT_UNCONFIRMED"
                );
                Ok(public_input(&receipt))
            }
            "readInputReceipt" => {
                let id = request
                    .payload
                    .get("inputId")
                    .and_then(Value::as_str)
                    .context("OFFICE_INVALID_INPUT")?;
                ensure!(
                    request
                        .payload
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(1)
                        == 1,
                    "OFFICE_INPUT_REVISION_MISMATCH"
                );
                let record = self
                    .store
                    .read_input(id)?
                    .context("OFFICE_INPUT_NOT_FOUND")?;
                Ok(public_input(&record.receipt))
            }
            "publishManifest" => {
                // An ordinary payload cannot claim arbitrary paths, existing files
                // or a model-invented hash as a successful native write receipt.
                let content = self.host.accept_written_artifact(request, cancel).await?;
                self.host
                    .validate_task(&request.scope, &content.manifest.task)?;
                self.host
                    .validate_sources(request, &content.manifest.source_refs, cancel)
                    .await?;
                self.check(request, cancel)?;
                ensure!(
                    self.settings
                        .allowed_formats
                        .contains(&content.manifest.format)
                        && content.bytes.len() as u64 <= self.settings.max_output_bytes,
                    "OFFICE_FORMAT_UNAVAILABLE"
                );
                self.policy(request,"office.artifact.publish",json!({"task":content.manifest.task,"sourceRefs":content.manifest.source_refs,"sha256":content.manifest.sha256}),cancel).await?;
                self.check(request, cancel)?;
                let manifest = self.store.publish_artifact(
                    operation(request)?,
                    content.manifest,
                    &content.bytes,
                )?;
                Ok(json!({"manifest":manifest}))
            }
            "readManifest" => {
                let reference: OfficeArtifactRef = serde_json::from_value(
                    request
                        .payload
                        .get("reference")
                        .cloned()
                        .context("OFFICE_INVALID_INPUT")?,
                )?;
                Ok(
                    json!({"manifest":self.store.read_artifact(&reference)?.context("OFFICE_ARTIFACT_NOT_FOUND")?}),
                )
            }
            "readDatasetPage" => {
                let reference: OfficeArtifactRef = serde_json::from_value(
                    request
                        .payload
                        .get("reference")
                        .cloned()
                        .context("OFFICE_INVALID_INPUT")?,
                )?;
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
                let data = self
                    .store
                    .read_dataset(&reference)?
                    .context("OFFICE_DATASET_NOT_FOUND")?;
                Ok(serde_json::to_value(dataset_page(
                    &data,
                    &query,
                    &request.scope,
                    cancel,
                )?)?)
            }
            "prepareExport" => {
                let reference: OfficeArtifactRef = serde_json::from_value(
                    request
                        .payload
                        .get("reference")
                        .cloned()
                        .context("OFFICE_INVALID_INPUT")?,
                )?;
                let manifest = self
                    .store
                    .read_artifact(&reference)?
                    .context("OFFICE_ARTIFACT_NOT_FOUND")?;
                let mut normalized = request.clone();
                normalized.payload = json!({"reference":reference,"format":manifest.format})
                    .as_object()
                    .context("OFFICE_INVALID_INPUT")?
                    .clone();
                self.artifact("integrations/artifact/export", &normalized, cancel)
                    .await
            }
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        }
    }
}
fn public_input(receipt: &kcoder_state::integrations::office::OfficeInputReceipt) -> Value {
    json!({"kind":"office_input","inputId":receipt.input_id,"revision":receipt.revision,"operationId":receipt.operation_id,"owner":receipt.owner,"filename":receipt.metadata.filename,"mediaType":receipt.metadata.media_type,"bytes":receipt.bytes,"sha256":receipt.sha256,"status":receipt.status})
}
