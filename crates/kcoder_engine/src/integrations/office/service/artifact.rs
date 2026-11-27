use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Generate {
    task: OfficeTaskRef,
    specification: Value,
    #[serde(default)]
    source_refs: Vec<AgentResourceRef>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    reference: OfficeArtifactRef,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Export {
    #[serde(default)]
    task: Option<OfficeTaskRef>,
    reference: OfficeArtifactRef,
    format: AgentResourceFormat,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Action {
    reference: OfficeArtifactRef,
    action: String,
    #[serde(default)]
    destination: Option<AgentResourceRef>,
    #[serde(default)]
    inputs: Option<Value>,
}
impl OfficeService {
    pub(super) async fn artifact(
        &self,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        match method {
            "integrations/artifact/createCard" => self.create_card(request, cancel).await,
            "integrations/artifact/executeAction" => {
                self.execute_artifact_action(request, cancel).await
            }
            "integrations/artifact/list" => {
                let thread = request
                    .payload
                    .get("threadId")
                    .and_then(Value::as_str)
                    .context("OFFICE_INVALID_INPUT")?;
                let mut items = self.store.list_artifacts(thread)?;
                if let Some(turn) = request.payload.get("turnId").and_then(Value::as_str) {
                    items.retain(|manifest| manifest.task.turn_id == turn);
                }
                items.sort_by(|a, b| {
                    a.created_at_ms
                        .cmp(&b.created_at_ms)
                        .then_with(|| a.id.cmp(&b.id))
                });
                page_values(items, request)
            }
            "integrations/artifact/read" => {
                let params: Reference = payload(request)?;
                let manifest = self.manifest(&params.reference)?;
                Ok(json!({"manifest":manifest}))
            }
            "integrations/artifact/source" => {
                let params: OfficeCanonicalSourceReadParams = payload(request)?;
                let manifest = self.manifest(&params.reference)?;
                self.host.validate_task(&request.scope, &manifest.task)?;
                self.host
                    .validate_sources(request, &manifest.source_refs, cancel)
                    .await?;
                self.check(request, cancel)?;
                let metadata = self.store.read_canonical_source(
                    &params.reference,
                    None,
                    0,
                    params.limit,
                    true,
                )?;
                if let Some(source) = &metadata.source {
                    let actual = self
                        .host
                        .resolve_source_content_identities(request, &manifest.source_refs, cancel)
                        .await?;
                    ensure!(
                        actual == source.inputs,
                        "OFFICE_CANONICAL_INPUT_IDENTITY_MISMATCH"
                    );
                }
                self.check(request, cancel)?;
                if params.metadata_only {
                    return Ok(serde_json::to_value(metadata)?);
                }
                let result = self.store.read_canonical_source(
                    &params.reference,
                    params.expected_sha256.as_deref(),
                    params.offset,
                    params.limit,
                    false,
                )?;
                self.check(request, cancel)?;
                Ok(serde_json::to_value(result)?)
            }
            "integrations/artifact/verification" => {
                let params: Reference = payload(request)?;
                let manifest = self.manifest(&params.reference)?;
                Ok(
                    json!({"reference":params.reference,"verification":self.store.read_verification(&params.reference)?.map(|observation|observation.verification).unwrap_or_else(||manifest.verification.clone()),"manifestVerification":manifest.verification}),
                )
            }
            "integrations/artifact/export" => {
                let params: Export = payload(request)?;
                let manifest = self.manifest(&params.reference)?;
                ensure!(
                    params.format == manifest.format,
                    "OFFICE_CONVERSION_UNAVAILABLE"
                );
                if let Some(previous) = self.reserve(request, "artifact.export")? {
                    return Ok(previous);
                }
                let bytes = self.read_bytes(&params.reference, cancel)?;
                let manifest = if let Some(task) = params.task {
                    self.host.validate_task(&request.scope, &task)?;
                    if task != manifest.task {
                        let mut alias = manifest.clone();
                        alias.id = format!("exported-{}", hash(operation(request)?.as_bytes()));
                        alias.revision = 1;
                        alias.task = task;
                        alias.created_at_ms = now()?;
                        if alias.source_refs.len() < 128 {
                            alias.source_refs.push(AgentResourceRef {
                                kind: "artifact".into(),
                                id: manifest.id.clone(),
                                revision: manifest.revision.to_string(),
                            });
                        }
                        alias.verification = OfficeVerification {
                            status: OfficeVerificationStatus::Partial,
                            completed_checks: vec!["immutable_content_reused".into()],
                            pending_checks: vec![
                                "reader_current_host".into(),
                                "semantic_acceptance_current_task".into(),
                            ],
                            reader_status: OfficeVerificationStatus::Pending,
                            formula_calculation: manifest.verification.formula_calculation.clone(),
                        };
                        self.policy(
                            request,
                            "office.artifact.publish",
                            json!({"reference":params.reference,"task":alias.task}),
                            cancel,
                        )
                        .await?;
                        self.check(request, cancel)?;
                        self.store.publish_artifact(
                            &child_operation(request, "alias")?,
                            alias,
                            &bytes,
                        )?
                    } else {
                        manifest
                    }
                } else {
                    manifest
                };
                let receipt = self
                    .host
                    .prepare_export(request, &manifest, bytes, cancel)
                    .await?;
                let receipt: OfficeExportReceipt =
                    serde_json::from_value(receipt).context("OFFICE_EXPORT_RECEIPT_INVALID")?;
                receipt.validate_for(&manifest)?;
                self.check(request, cancel)?;
                self.complete(request,json!({"reference":{"id":manifest.id,"revision":manifest.revision},"manifest":manifest,"export":receipt,"deliveryState":"not_requested"}))
            }
            "integrations/artifact/verify" => {
                let params: Reference = payload(request)?;
                let manifest = self.manifest(&params.reference)?;
                if let Some(previous) = self.reserve(request, "artifact.verify")? {
                    return Ok(previous);
                }
                let bytes = self.read_bytes(&params.reference, cancel)?;
                let verification = self.host.verify(request, &manifest, bytes, cancel).await?;
                self.check(request, cancel)?;
                // This is a new independent observation. It never rewrites the
                // immutable generation manifest or upgrades an old result silently.
                let observation = self.store.save_verification(
                    &child_operation(request, "observation")?,
                    &params.reference,
                    &manifest.sha256,
                    verification.clone(),
                    now()?,
                )?;
                self.complete(request,json!({"reference":params.reference,"verification":verification,"observation":observation,"manifestVerification":manifest.verification}))
            }
            "integrations/artifact/prepareAction" => {
                let params: Action = payload(request)?;
                let manifest = self.manifest(&params.reference)?;
                ensure!(
                    matches!(
                        params.action.as_str(),
                        "read" | "export" | "verify" | "create_task" | "send"
                    ),
                    "OFFICE_ACTION_UNSUPPORTED"
                );
                if params.action == "send" {
                    ensure!(
                        self.settings.allow_external_delivery,
                        "OFFICE_DELIVERY_DISABLED"
                    );
                    ensure!(params.destination.is_some(), "OFFICE_DESTINATION_REQUIRED");
                }
                self.host.validate_task(&request.scope, &manifest.task)?;
                let prepared_inputs =
                    if let Some(OfficeArtifactPresentation::Form { schema, .. }) =
                        &manifest.presentation
                    {
                        ensure!(params.action == "create_task", "OFFICE_ACTION_UNSUPPORTED");
                        Some(
                            kcoder_config::integrations::office::prepare_office_schema_inputs(
                                schema,
                                params.inputs.as_ref().context("OFFICE_INPUT_REQUIRED")?,
                            )?,
                        )
                    } else {
                        ensure!(params.inputs.is_none(), "OFFICE_INVALID_INPUT");
                        None
                    };
                if let Some(previous) = self.reserve(request, "artifact.prepareAction")? {
                    return Ok(previous);
                }
                self.complete(request,json!({"intent":{"operationId":operation(request)?,"reference":params.reference,"action":params.action,"destination":params.destination,"contentSha256":manifest.sha256,"inputs":prepared_inputs},"executionOperationId":format!("action-{}",hash(operation(request)?.as_bytes())),"state":"prepared","requiresConfirmation":matches!(params.action.as_str(),"send"|"create_task"),"businessComplete":false,"delivered":false}))
            }
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        }
    }
    fn manifest(&self, reference: &OfficeArtifactRef) -> Result<OfficeArtifactManifest> {
        self.store
            .read_artifact(reference)?
            .context("OFFICE_ARTIFACT_NOT_FOUND")
    }
    fn read_bytes(
        &self,
        reference: &OfficeArtifactRef,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        let mut offset = 0u64;
        loop {
            ensure!(!cancel.is_cancelled(), "OFFICE_CANCELLED");
            let (chunk, total) = self
                .store
                .read_artifact_chunk(reference, offset, 512 * 1024)?;
            ensure!(
                total <= self.settings.max_output_bytes,
                "OFFICE_OUTPUT_TOO_LARGE"
            );
            offset += chunk.len() as u64;
            bytes.extend(chunk);
            if offset == total {
                break;
            }
            ensure!(offset < total, "OFFICE_CONTENT_CORRUPT");
        }
        Ok(bytes)
    }
    pub(super) async fn generate(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let mut params: Generate = payload(request)?;
        let typed_spec: OfficeGenerationSpec =
            serde_json::from_value(params.specification.clone()).context("OFFICE_INVALID_INPUT")?;
        typed_spec.validate()?;
        self.host.validate_task(&request.scope, &params.task)?;
        self.host
            .validate_sources(request, &params.source_refs, cancel)
            .await?;
        self.check(request, cancel)?;
        let format: AgentResourceFormat = serde_json::from_value(
            params
                .specification
                .get("kind")
                .cloned()
                .context("OFFICE_INVALID_FORMAT")?,
        )?;
        ensure!(
            self.settings.allowed_formats.contains(&format)
                && matches!(
                    format,
                    AgentResourceFormat::Docx
                        | AgentResourceFormat::Xlsx
                        | AgentResourceFormat::Pptx
                ),
            "OFFICE_FORMAT_UNAVAILABLE"
        );
        ensure!(
            serde_json::to_vec(&params.specification)?.len() <= 1024 * 1024,
            "OFFICE_INPUT_TOO_LARGE"
        );
        let title = params
            .specification
            .get("title")
            .and_then(Value::as_str)
            .context("OFFICE_TITLE_REQUIRED")?
            .to_string();
        params
            .specification
            .as_object_mut()
            .context("OFFICE_INVALID_INPUT")?
            .insert(
                "sourceRefs".into(),
                json!(
                    params
                        .source_refs
                        .iter()
                        .map(|reference| format!("{}@{}", reference.id, reference.revision))
                        .collect::<Vec<_>>()
                ),
            );
        let inputs = self
            .host
            .resolve_source_content_identities(request, &params.source_refs, cancel)
            .await?;
        ensure!(
            inputs
                .iter()
                .map(|input| &input.reference)
                .collect::<Vec<_>>()
                == params.source_refs.iter().collect::<Vec<_>>(),
            "OFFICE_CANONICAL_INPUT_IDENTITY_MISMATCH"
        );
        for input in &inputs {
            input.validate()?;
        }
        self.check(request, cancel)?;
        // Claim the stable original intent before deciding whether a new input
        // may run. Existing operations retain their receipt/reconciliation path.
        let (fresh, record) = self.store.begin_action(
            operation(request)?,
            "office.generate",
            &Value::Object(request.payload.clone()),
        )?;
        if !fresh {
            let prepared = self.store.read_canonical_preparation(operation(request)?)?;
            if record.phase == "completed" {
                if prepared.is_some() {
                    ensure!(
                        self.store
                            .generation_publication(operation(request)?)?
                            .is_some(),
                        "OFFICE_CANONICAL_SOURCE_MISSING"
                    );
                }
                return record.result.context("OFFICE_RECEIPT_CORRUPT");
            }
            if let Some(manifest) = self.store.generation_publication(operation(request)?)? {
                return self.complete(request,json!({"manifest":manifest,"businessComplete":false,"messageKey":"office.reviewRequired"}));
            }
            if record.phase == "rejected"
                && prepared.is_none()
                && record
                    .result
                    .as_ref()
                    .and_then(|value| value.get("errorCode"))
                    == Some(&json!("OFFICE_INVALID_INPUT"))
            {
                anyhow::bail!("OFFICE_INVALID_INPUT");
            }
            anyhow::bail!("OFFICE_RECONCILIATION_REQUIRED");
        }
        if let Err(error) = typed_spec.validate_formula_addresses() {
            // An orphaned historical source or uncertain rejection must not be
            // reported as proof that the original operation never ran.
            if self
                .store
                .read_canonical_preparation(operation(request)?)
                .context("OFFICE_RECONCILIATION_REQUIRED")?
                .is_some()
                || self
                    .store
                    .generation_publication(operation(request)?)
                    .context("OFFICE_RECONCILIATION_REQUIRED")?
                    .is_some()
            {
                anyhow::bail!("OFFICE_RECONCILIATION_REQUIRED");
            }
            self.store
                .reject_action(operation(request)?, "OFFICE_INVALID_INPUT")
                .context("OFFICE_RECONCILIATION_REQUIRED")?;
            let confirmed = self
                .store
                .read_action(operation(request)?)
                .context("OFFICE_RECONCILIATION_REQUIRED")?
                .filter(|current| {
                    current.intent_sha256 == record.intent_sha256
                        && current.phase == "rejected"
                        && current
                            .result
                            .as_ref()
                            .and_then(|value| value.get("errorCode"))
                            == Some(&json!("OFFICE_INVALID_INPUT"))
                });
            ensure!(confirmed.is_some(), "OFFICE_RECONCILIATION_REQUIRED");
            // Recheck after the rejection receipt: another authorized writer
            // may have prepared a source while this reservation was pending.
            ensure!(
                self.store
                    .read_canonical_preparation(operation(request)?)
                    .context("OFFICE_RECONCILIATION_REQUIRED")?
                    .is_none()
                    && self
                        .store
                        .generation_publication(operation(request)?)
                        .context("OFFICE_RECONCILIATION_REQUIRED")?
                        .is_none(),
                "OFFICE_RECONCILIATION_REQUIRED"
            );
            return Err(error.into());
        }
        let prepared = self.store.prepare_canonical_generation(
            operation(request)?,
            params.task.clone(),
            &params.specification,
            inputs.clone(),
            now()?,
        )?;
        let exact_specification = self
            .store
            .prepared_generation_specification(operation(request)?)?;
        self.store.dispatch_action_checkpoint(
            operation(request)?,
            json!({"canonicalSourcePrepared":prepared}),
        )?;
        self.check(request, cancel)?;
        let generated = self
            .host
            .generate(request, &exact_specification, cancel)
            .await?;
        generated.generator.validate()?;
        self.check(request, cancel)?;
        ensure!(
            generated.format == format
                && generated.bytes.len() as u64 <= self.settings.max_output_bytes,
            "OFFICE_GENERATOR_IDENTITY_MISMATCH"
        );
        ensure!(
            generated
                .verification
                .completed_checks
                .iter()
                .any(|check| check == "ooxml_structure"),
            "OFFICE_STRUCTURE_UNCONFIRMED"
        );
        let (dataset, presentation) = self
            .generation_preview(
                request,
                &typed_spec,
                &params.task,
                &params.source_refs,
                cancel,
            )
            .await?;
        let manifest = OfficeArtifactManifest {
            schema_version: 1,
            id: format!(
                "artifact-{}",
                hash(format!("{}:{}", operation(request)?, request.scope.target_id).as_bytes())
            ),
            revision: 1,
            owner: self.store.owner().clone(),
            task: params.task,
            kind: if format == AgentResourceFormat::Xlsx {
                AgentOutputKind::Table
            } else {
                AgentOutputKind::Document
            },
            title,
            format,
            bytes: generated.bytes.len() as u64,
            sha256: hash(&generated.bytes),
            source_refs: params.source_refs,
            verification: generated.verification,
            dataset,
            created_at_ms: prepared.created_at_ms,
            presentation,
        };
        self.policy(request,"office.artifact.publish",json!({"task":manifest.task,"sourceRefs":manifest.source_refs,"sha256":manifest.sha256}),cancel).await?;
        self.check(request, cancel)?;
        let current_inputs = self
            .host
            .resolve_source_content_identities(request, &manifest.source_refs, cancel)
            .await?;
        ensure!(
            current_inputs == inputs,
            "OFFICE_CANONICAL_INPUT_IDENTITY_MISMATCH"
        );
        self.check(request, cancel)?;
        let manifest = self.store.publish_generated_artifact(
            &child_operation(request, "publish")?,
            operation(request)?,
            manifest,
            &generated.bytes,
            generated.generator,
        )?;
        self.complete(request,json!({"manifest":manifest,"businessComplete":false,"messageKey":"office.reviewRequired"}))
    }
    pub(super) async fn export_dataset(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let params: Export = payload(request)?;
        let data = self
            .store
            .read_dataset(&params.reference)?
            .context("OFFICE_DATASET_NOT_FOUND")?;
        ensure!(
            self.settings.allowed_formats.contains(&params.format),
            "OFFICE_FORMAT_UNAVAILABLE"
        );
        if let Some(previous) = self.reserve(request, "dataset.export")? {
            return Ok(previous);
        }
        let bytes = export_dataset(&data, params.format, cancel)?;
        ensure!(
            bytes.len() as u64 <= self.settings.max_output_bytes,
            "OFFICE_OUTPUT_TOO_LARGE"
        );
        let (task, title) = if let Some(task) = params.task.or(data.task.clone()) {
            self.host.validate_task(&request.scope, &task)?;
            (task, "Dataset export".to_string())
        } else {
            let source = data
                .source_refs
                .iter()
                .find(|source| source.kind == "artifact")
                .context("OFFICE_EXPORT_TASK_REFERENCE_REQUIRED")?;
            let original = self.manifest(&OfficeArtifactRef {
                id: source.id.clone(),
                revision: source.revision.parse().context("OFFICE_INVALID_REVISION")?,
            })?;
            self.host.validate_task(&request.scope, &original.task)?;
            (original.task, original.title)
        };
        let manifest = OfficeArtifactManifest {
            schema_version: 1,
            id: format!("export-{}", hash(operation(request)?.as_bytes())),
            revision: 1,
            owner: self.store.owner().clone(),
            task,
            kind: AgentOutputKind::Table,
            title,
            format: params.format,
            bytes: bytes.len() as u64,
            sha256: hash(&bytes),
            source_refs: data.source_refs,
            verification: OfficeVerification {
                status: OfficeVerificationStatus::Partial,
                completed_checks: vec!["dataset_schema".into(), "deterministic_export".into()],
                pending_checks: vec!["reader".into()],
                reader_status: OfficeVerificationStatus::Pending,
                formula_calculation: "not_applicable".into(),
            },
            dataset: Some(params.reference.clone()),
            created_at_ms: now()?,
            presentation: None,
        };
        self.policy(request,"office.artifact.publish",json!({"task":manifest.task,"sourceRefs":manifest.source_refs,"sha256":manifest.sha256}),cancel).await?;
        self.check(request, cancel)?;
        let manifest =
            self.store
                .publish_artifact(&child_operation(request, "publish")?, manifest, &bytes)?;
        let export = self
            .host
            .prepare_export(request, &manifest, bytes, cancel)
            .await?;
        self.check(request, cancel)?;
        let export: OfficeExportReceipt =
            serde_json::from_value(export).context("OFFICE_EXPORT_RECEIPT_INVALID")?;
        export.validate_for(&manifest)?;
        self.complete(request, json!({"manifest":manifest,"export":export}))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Card {
    task: OfficeTaskRef,
    title: String,
    presentation: OfficeArtifactPresentation,
    #[serde(default)]
    source_refs: Vec<AgentResourceRef>,
}
impl OfficeService {
    async fn create_card(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let params: Card = payload(request)?;
        ensure!(
            !matches!(
                params.presentation,
                OfficeArtifactPresentation::OperationReceipt { .. }
            ),
            "OFFICE_NATIVE_RECEIPT_REQUIRED"
        );
        params.presentation.validate(&params.source_refs)?;
        self.host.validate_task(&request.scope, &params.task)?;
        self.host
            .validate_sources(request, &params.source_refs, cancel)
            .await?;
        match &params.presentation {
            OfficeArtifactPresentation::Table { dataset }
            | OfficeArtifactPresentation::Chart { dataset, .. } => {
                self.policy(
                    request,
                    "office.dataset.read",
                    json!({"reference":dataset}),
                    cancel,
                )
                .await?;
                let data = self
                    .store
                    .read_dataset(dataset)?
                    .context("OFFICE_DATASET_NOT_FOUND")?;
                if let OfficeArtifactPresentation::Chart {
                    chart_type,
                    label_column,
                    value_columns,
                    ..
                } = &params.presentation
                {
                    ensure!(
                        data.columns
                            .iter()
                            .any(|column| column.key == *label_column),
                        "OFFICE_UNKNOWN_COLUMN"
                    );
                    let columns = value_columns
                        .iter()
                        .map(|key| {
                            data.columns
                                .iter()
                                .find(|column| {
                                    column.key == *key && column.kind == OfficeColumnType::Number
                                })
                                .context("OFFICE_UNKNOWN_COLUMN")
                        })
                        .collect::<Result<Vec<_>>>()?;
                    ensure!(
                        columns.iter().all(|column| column.unit == columns[0].unit)
                            && (*chart_type != OfficeChartType::Pie || columns.len() == 1),
                        "OFFICE_CHART_UNIT_MISMATCH"
                    );
                }
            }
            OfficeArtifactPresentation::FileCollection { items } => {
                for reference in items {
                    self.policy(
                        request,
                        "office.artifact.read",
                        json!({"reference":reference}),
                        cancel,
                    )
                    .await?;
                    self.manifest(reference)?;
                }
            }
            OfficeArtifactPresentation::Form { schema, .. } => {
                kcoder_config::integrations::office::validate_office_schema(schema)?;
                ensure!(
                    schema.get("type").and_then(Value::as_str) == Some("object")
                        && schema
                            .get("properties")
                            .and_then(Value::as_object)
                            .is_some_and(|properties| !properties.is_empty()),
                    "OFFICE_INVALID_INPUT_SCHEMA"
                );
            }
            _ => {}
        }
        self.check(request, cancel)?;
        if let Some(previous) = self.reserve(request, "artifact.createCard")? {
            return Ok(previous);
        }
        let bytes = serde_json::to_vec(&params.presentation)?;
        let dataset = match &params.presentation {
            OfficeArtifactPresentation::Table { dataset }
            | OfficeArtifactPresentation::Chart { dataset, .. } => Some(dataset.clone()),
            _ => None,
        };
        let manifest = OfficeArtifactManifest {
            schema_version: 1,
            id: format!("card-{}", hash(operation(request)?.as_bytes())),
            revision: 1,
            owner: self.store.owner().clone(),
            task: params.task,
            kind: params.presentation.kind(),
            title: params.title,
            format: AgentResourceFormat::Json,
            bytes: bytes.len() as u64,
            sha256: hash(&bytes),
            source_refs: params.source_refs,
            verification: OfficeVerification {
                status: OfficeVerificationStatus::Partial,
                completed_checks: vec!["declarative_schema".into(), "content_identity".into()],
                pending_checks: vec!["semantic_acceptance".into()],
                reader_status: OfficeVerificationStatus::Unavailable,
                formula_calculation: "not_applicable".into(),
            },
            dataset,
            created_at_ms: now()?,
            presentation: Some(params.presentation),
        };
        self.policy(
            request,
            "office.artifact.publish",
            json!({"task":manifest.task,"sourceRefs":manifest.source_refs}),
            cancel,
        )
        .await?;
        self.check(request, cancel)?;
        let manifest =
            self.store
                .publish_artifact(&child_operation(request, "publish")?, manifest, &bytes)?;
        self.complete(
            request,
            json!({"manifest":manifest,"businessComplete":false}),
        )
    }
}

impl OfficeService {
    async fn generation_preview(
        &self,
        request: &IntegrationRequest,
        spec: &OfficeGenerationSpec,
        task: &OfficeTaskRef,
        sources: &[AgentResourceRef],
        cancel: &CancellationToken,
    ) -> Result<(
        Option<OfficeArtifactRef>,
        Option<OfficeArtifactPresentation>,
    )> {
        if let Some(sheet) = spec.sheets.as_ref().and_then(|sheets| sheets.first()) {
            let mut rows = sheet.rows.clone();
            for formula in &sheet.formulas {
                let (row, column) = formula.data_cell_indices(sheet.columns.len())?;
                if row >= rows.len() {
                    rows.resize(row + 1, vec![Value::Null; sheet.columns.len()]);
                }
                rows[row][column] = Value::Null;
            }
            let data = OfficeDataset {
                schema_version: 1,
                id: format!("dataset-{}", hash(operation(request)?.as_bytes())),
                revision: 1,
                owner: self.store.owner().clone(),
                task: Some(task.clone()),
                columns: sheet
                    .columns
                    .iter()
                    .map(|column| OfficeColumn {
                        key: column.key.clone(),
                        title: column.title.clone(),
                        kind: column.kind,
                        unit: column.unit.clone(),
                    })
                    .collect(),
                rows,
                source_refs: sources.to_vec(),
            };
            self.policy(
                request,
                "office.dataset.write",
                json!({"task":task,"sourceRefs":sources}),
                cancel,
            )
            .await?;
            self.check(request, cancel)?;
            let reference = self
                .store
                .create_dataset(&child_operation(request, "dataset")?, data)?;
            return Ok((
                Some(reference.clone()),
                Some(OfficeArtifactPresentation::Table { dataset: reference }),
            ));
        }
        let texts: Vec<String> = if let Some(paragraphs) = &spec.paragraphs {
            paragraphs
                .iter()
                .take(8)
                .map(|paragraph| preview_text(&paragraph.text))
                .collect()
        } else {
            spec.slides
                .as_ref()
                .map(|slides| {
                    slides
                        .iter()
                        .take(8)
                        .map(|slide| preview_text(&slide.title))
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok((
            None,
            Some(OfficeArtifactPresentation::Document { paragraphs: texts }),
        ))
    }
}
fn preview_text(value: &str) -> String {
    let mut chars = value.chars();
    let preview: String = chars.by_ref().take(1000).collect();
    if chars.next().is_some() {
        format!("{preview}…")
    } else {
        preview
    }
}

#[cfg(test)]
mod formula_preview_boundary_tests {
    use super::*;
    use futures::FutureExt;
    use std::panic::AssertUnwindSafe;

    #[tokio::test]
    async fn request_controlled_formula_addresses_do_not_panic_preview() {
        let (_root, service, host) = super::super::tests::setup();
        let request = super::super::tests::request(&host, "formula-boundary", json!({}));
        let task = OfficeTaskRef {
            thread_id: "thread-fixture".into(),
            turn_id: "turn-fixture".into(),
            run_id: None,
        };
        let cancel = CancellationToken::new();
        for cell in [
            "A.1".to_string(),
            " A1".to_string(),
            format!("{}1", "A".repeat(100)),
        ] {
            let spec: OfficeGenerationSpec = serde_json::from_value(json!({
                "schemaVersion": 1, "kind": "xlsx", "title": "Fixture", "sheets": [{
                    "name": "Sheet", "columns": [{"key":"x","title":"X","type":"number"}],
                    "rows": [[1]], "formulas": [{"cell": cell, "formula":"SUM(A2)"}]
                }]
            }))
            .unwrap();
            let accepted = spec.validate_formula_addresses().is_ok();
            let outcome =
                AssertUnwindSafe(service.generation_preview(&request, &spec, &task, &[], &cancel))
                    .catch_unwind()
                    .await;
            assert!(
                outcome.is_ok(),
                "preview panicked on a request-controlled address"
            );
            assert!(
                outcome.unwrap().is_err(),
                "invalid address must not become a dataset"
            );
            assert!(
                !accepted,
                "invalid address must be rejected before invoking a host"
            );
        }
    }
}
