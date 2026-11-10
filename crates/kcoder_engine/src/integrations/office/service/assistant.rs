use super::*;
use serde::Deserialize;
mod preflight;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveDraft {
    definition: OfficeAssistantDefinition,
    #[serde(default)]
    copy_from: Option<IntegrationRevisionRef>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveVersion {
    #[serde(default)]
    language: Option<String>,
    id: String,
    version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adopt {
    #[serde(default)]
    language: Option<String>,
    id: String,
    version: String,
    inputs: Value,
    #[serde(default)]
    start_task: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    definition: OfficeAssistantDefinition,
    id: String,
}
impl OfficeService {
    /// Public builtin metadata is available before this namespace has a first write.
    /// The native caller must first prove that no committed namespace is missing.
    pub fn builtin_assistant_catalog(request: &IntegrationRequest) -> Result<Value> {
        request.validate(false)?;
        let language = request
            .payload
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN");
        let personal_only =
            request.payload.get("personalOnly").and_then(Value::as_bool) == Some(true);
        let mut items = builtin_office_assistants(language)
            .into_iter()
            .chain(builtin_octop_assistants(language))
            .filter(|_| !personal_only)
            .map(|definition| json!({"definition":definition,"builtin":true,"version":BUILTIN_OFFICE_ASSISTANT_VERSION}))
            .collect::<Vec<_>>();
        items.sort_by_key(|item| {
            (
                item["definition"]["id"] != "builtin.office-task",
                item["definition"]["title"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            )
        });
        let mut page = page_values(items, request)?;
        page["organizationState"] = json!("disabled");
        page["storageState"] = json!("not_initialized");
        Ok(page)
    }

    pub(super) async fn assistant(
        &self,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let language = request
            .payload
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN");
        match method {
            "integrations/assistant/skills/catalog" => {
                Self::skill_market_catalog(request, cancel).await
            }
            "integrations/assistant/skills/install" => {
                self.install_expert_skill(request, cancel).await
            }
            "integrations/assistant/market/list"
            | "integrations/assistant/market/read"
            | "integrations/assistant/market/install"
            | "integrations/assistant/package/read"
            | "integrations/assistant/deleteDraft" => self.expert(method, request, cancel).await,
            "integrations/assistant/list" => {
                let personal_only =
                    request.payload.get("personalOnly").and_then(Value::as_bool) == Some(true);
                let builtins = builtin_office_assistants(language).into_iter().chain(builtin_octop_assistants(language)).filter(|_| !personal_only).map(
                    |definition| json!({"definition":definition,"builtin":true,"version":BUILTIN_OFFICE_ASSISTANT_VERSION}),
                );
                let saved=self.store.list_drafts()?.into_iter().map(|draft|json!({"definition":draft.definition,"builtin":false,"draftRevision":draft.revision}));
                let mut items: Vec<Value> = builtins.chain(saved).collect();
                let mut organization_state = "disabled";
                if self.settings.allow_organization_templates && !personal_only {
                    match self.shared_assistants(request, cancel).await {
                        Ok(shared) => {
                            organization_state = "available";
                            items.extend(shared.into_iter().filter(|item|!item.version.archived).map(|item|json!({"definition":item.version.definition,"builtin":false,"version":item.version.version,"organizationPublication":item.publication})));
                        }
                        Err(_) => organization_state = "unavailable",
                    }
                }
                let mut page = page_values(items, request)?;
                page["organizationState"] = json!(organization_state);
                Ok(page)
            }
            "integrations/assistant/read" => {
                let id = request
                    .payload
                    .get("id")
                    .and_then(Value::as_str)
                    .context("OFFICE_INVALID_INPUT")?;
                let version = request.payload.get("version").and_then(Value::as_str);
                if builtin_office_assistant(id, language).is_some() {
                    let version = version.unwrap_or(BUILTIN_OFFICE_ASSISTANT_VERSION);
                    let definition = builtin_office_assistant_version(id, language, version)
                        .context("OFFICE_VERSION_NOT_FOUND")?;
                    return Ok(json!({"definition":definition,"builtin":true,"version":version}));
                }
                match version {
                    Some(version) => Ok(
                        json!({"saved":self.store.read_version(id,version)?.context("OFFICE_VERSION_NOT_FOUND")?}),
                    ),
                    None => Ok(
                        json!({"draft":self.store.read_draft(id)?.context("OFFICE_DRAFT_NOT_FOUND")?}),
                    ),
                }
            }
            "integrations/assistant/versions" => {
                let id = request
                    .payload
                    .get("id")
                    .and_then(Value::as_str)
                    .context("OFFICE_INVALID_INPUT")?;
                page_values(self.store.list_versions(id)?, request)
            }
            "integrations/assistant/validate" => {
                let params: SaveDraft = payload(request)?;
                validate_office_definition(&params.definition)?;
                self.inspect_assistant_requirements(request, &params.definition, cancel)
                    .await
            }
            "integrations/assistant/saveDraft" => {
                let params: SaveDraft = payload(request)?;
                validate_office_definition(&params.definition)?;
                ensure!(
                    !params.definition.id.starts_with("builtin."),
                    "OFFICE_BUILTIN_IMMUTABLE"
                );
                self.organization_policy(request, &params.definition, "publish", cancel)
                    .await?;
                self.check(request, cancel)?;
                if let Some(source) = params.copy_from {
                    source.validate()?;
                    if let Some((package, files)) = builtin_octop_package(&source.id) {
                        ensure!(
                            source.revision == BUILTIN_OFFICE_ASSISTANT_VERSION
                                && request.expected_revision.is_none()
                                && params.definition.scope == OfficeAssistantScope::Personal,
                            "OFFICE_REVISION_CONFLICT"
                        );
                        return Ok(
                            json!({"draft":self.store.install_expert(operation(request)?, params.definition, package, &files, now()?)?}),
                        );
                    }
                    return Ok(
                        json!({"draft":self.store.copy_expert(operation(request)?, &source, params.definition, now()?)?}),
                    );
                }
                Ok(
                    json!({"draft":self.store.save_draft(operation(request)?,params.definition,Self::expected(request)?,now()?)?}),
                )
            }
            "integrations/assistant/saveVersion" => {
                let params: SaveVersion = payload(request)?;
                let draft = self
                    .store
                    .read_draft(&params.id)?
                    .context("OFFICE_DRAFT_NOT_FOUND")?;
                self.organization_policy(request, &draft.definition, "publish", cancel)
                    .await?;
                self.check(request, cancel)?;
                if draft.definition.scope == OfficeAssistantScope::Organization {
                    if let Some(previous) =
                        self.reserve(request, "assistant.publishOrganization")?
                    {
                        return Ok(previous);
                    }
                    let saved = self.store.save_version(
                        &child_operation(request, "version")?,
                        &params.id,
                        &params.version,
                        Self::expected(request)?.context("OFFICE_REVISION_REQUIRED")?,
                        now()?,
                    )?;
                    let detached = Self::detach_shared_version(&saved)?;
                    let publication = self
                        .host
                        .publish_organization_template(request, &detached, cancel)
                        .await?;
                    publication.validate()?;
                    ensure!(
                        publication.kind == "publication",
                        "OFFICE_ORGANIZATION_IDENTITY_MISMATCH"
                    );
                    self.check(request, cancel)?;
                    return self.complete(request,json!({"saved":saved,"publication":publication,"publishedDefinitionSha256":detached.definition_sha256}));
                }
                Ok(
                    json!({"saved":self.store.save_version(operation(request)?,&params.id,&params.version,Self::expected(request)?.context("OFFICE_REVISION_REQUIRED")?,now()?)?}),
                )
            }
            "integrations/assistant/archive" => {
                let params: SaveVersion = payload(request)?;
                let local = self.store.read_version(&params.id, &params.version)?;
                if local.as_ref().is_none_or(|saved| {
                    saved.definition.scope == OfficeAssistantScope::Organization
                }) {
                    let (saved, publication) = self
                        .resolve_assistant(request, &params.id, &params.version, language, cancel)
                        .await?;
                    self.organization_policy(request, &saved.definition, "archive", cancel)
                        .await?;
                    let publication =
                        publication.context("OFFICE_ORGANIZATION_PUBLICATION_NOT_FOUND")?;
                    if let Some(previous) =
                        self.reserve(request, "assistant.archiveOrganization")?
                    {
                        return Ok(previous);
                    }
                    self.host
                        .archive_organization_template(request, &publication, cancel)
                        .await?;
                    self.check(request, cancel)?;
                    if local.is_some() {
                        self.store.archive_version(
                            &child_operation(request, "archive")?,
                            &params.id,
                            &params.version,
                        )?;
                    }
                    return self.complete(request,json!({"publication":publication,"state":"archived","adoptedPersonalCopiesDeleted":false}));
                }
                Ok(
                    json!({"saved":self.store.archive_version(operation(request)?,&params.id,&params.version)?}),
                )
            }
            "integrations/assistant/export" => {
                let params: SaveVersion = payload(request)?;
                let language = params.language.as_deref().unwrap_or(language);
                ensure!(matches!(language, "zh-CN" | "en"), "OFFICE_INVALID_INPUT");
                let (saved, _publication) = self
                    .resolve_assistant(request, &params.id, &params.version, language, cancel)
                    .await?;
                let mut definition = saved.definition;
                definition.scope = OfficeAssistantScope::Personal;
                definition.resources.clear();
                definition.workflow_ref = None;
                definition.model_selection = OfficeModelSelection::InheritCurrent;
                Ok(
                    json!({"schemaVersion":1,"definition":definition,"detached":["resources","workflowRef","modelSelection"],"originalSha256":saved.definition_sha256}),
                )
            }
            "integrations/assistant/import" => {
                let params: Import = payload(request)?;
                let mut definition = params.definition;
                ensure!(
                    !params.id.starts_with("builtin."),
                    "OFFICE_BUILTIN_IMMUTABLE"
                );
                definition.id = params.id;
                definition.scope = OfficeAssistantScope::Personal;
                definition.resources.clear();
                definition.workflow_ref = None;
                definition.model_selection = OfficeModelSelection::InheritCurrent;
                validate_office_definition(&definition)?;
                self.check(request, cancel)?;
                Ok(
                    json!({"draft":self.store.save_draft(operation(request)?,definition,Self::expected(request)?,now()?)?,"requiresReview":true,"detached":["resources","workflowRef","modelSelection"]}),
                )
            }
            "integrations/assistant/adopt" => self.adopt(request, cancel, language).await,
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        }
    }
    pub(super) fn read_assistant_version(
        &self,
        id: &str,
        version: &str,
        language: &str,
    ) -> Result<OfficeAssistantVersion> {
        if builtin_office_assistant(id, language).is_some() {
            let definition = builtin_office_assistant_version(id, language, version)
                .context("OFFICE_VERSION_NOT_FOUND")?;
            let definition_sha256 = hash(&serde_json::to_vec(&definition)?);
            return Ok(OfficeAssistantVersion {
                owner: self.store.owner().clone(),
                version: version.into(),
                definition,
                definition_sha256,
                created_at_ms: 0,
                archived: false,
            });
        }
        self.store
            .read_version(id, version)?
            .context("OFFICE_VERSION_NOT_FOUND")
    }
    async fn organization_policy(
        &self,
        request: &IntegrationRequest,
        definition: &OfficeAssistantDefinition,
        action: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if definition.scope == OfficeAssistantScope::Organization {
            ensure!(
                self.settings.allow_organization_templates,
                "OFFICE_ORGANIZATION_DISABLED"
            );
            self.policy(
                request,
                &format!("office.organization.{action}"),
                json!({"assistantId":definition.id,"scope":definition.scope}),
                cancel,
            )
            .await?;
        }
        Ok(())
    }
    async fn check_dependencies(
        &self,
        request: &IntegrationRequest,
        definition: &OfficeAssistantDefinition,
        materials: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let required: Vec<_> = definition
            .capabilities
            .iter()
            .filter(|capability| !capability.optional)
            .collect();
        if required.is_empty() {
            return Ok(());
        }
        let mut call = request.clone();
        call.payload=json!({"capabilityIds":required.iter().map(|capability|&capability.capability_id).collect::<Vec<_>>(),"resourceRefs":definition.resources.iter().chain(materials).map(readiness_resource).collect::<Result<Vec<_>>>()?}).as_object().context("OFFICE_INVALID_INPUT")?.clone();
        let readiness = self
            .port(
                IntegrationPort::Readiness,
                "inspectReadiness",
                &call,
                cancel,
                false,
            )
            .await?;
        ensure!(
            readiness.get("identityGeneration").and_then(Value::as_str)
                == Some(request.scope.identity_generation.as_str())
                && readiness.get("targetRevision").and_then(Value::as_str)
                    == Some(request.scope.target_revision.as_str())
                && readiness
                    .get("requestRevision")
                    .and_then(Value::as_str)
                    .is_some_and(|revision| !revision.is_empty()),
            "OFFICE_DEPENDENCY_UNKNOWN"
        );
        let observations = readiness
            .get("capabilities")
            .and_then(Value::as_array)
            .context("OFFICE_DEPENDENCY_UNKNOWN")?;
        for requirement in required {
            let observation = observations
                .iter()
                .find(|observation| {
                    observation.get("capabilityId").and_then(Value::as_str)
                        == Some(requirement.capability_id.as_str())
                })
                .context("OFFICE_DEPENDENCY_UNKNOWN")?;
            ensure!(
                observation.get("state").and_then(Value::as_str) == Some("ready"),
                "OFFICE_DEPENDENCY_UNAVAILABLE"
            );
            let actual_tools = observation
                .get("toolRefs")
                .and_then(Value::as_array)
                .context("OFFICE_DEPENDENCY_UNKNOWN")?;
            ensure!(
                !actual_tools.is_empty()
                    && actual_tools
                        .iter()
                        .all(
                            |tool| ["name", "schemaRevision", "sourceRevision"]
                                .iter()
                                .all(|key| tool
                                    .get(*key)
                                    .and_then(Value::as_str)
                                    .is_some_and(|value| !value.is_empty()))
                        ),
                "OFFICE_DEPENDENCY_UNKNOWN"
            );
            if let Some(allowed) = &definition.allowed_tools {
                let tools = observation
                    .get("toolRefs")
                    .and_then(Value::as_array)
                    .context("OFFICE_DEPENDENCY_UNKNOWN")?;
                ensure!(
                    tools.iter().any(|tool| tool
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| allowed.iter().any(|allowed| allowed == name))),
                    "OFFICE_ASSISTANT_TOOL_CONFLICT"
                );
            }
            if !requirement.formats.is_empty() {
                let probe = self.generator_readiness(request, cancel).await?;
                ensure!(
                    matches!(
                        probe.get("status").and_then(Value::as_str),
                        Some("available" | "partial")
                    ),
                    "OFFICE_DEPENDENCY_UNAVAILABLE"
                );
                let formats = probe
                    .get("supportedFormats")
                    .and_then(Value::as_array)
                    .context("OFFICE_DEPENDENCY_UNKNOWN")?;
                for format in &requirement.formats {
                    ensure!(
                        formats
                            .iter()
                            .any(|value| value.as_str() == Some(format.extension())),
                        "OFFICE_FORMAT_UNAVAILABLE"
                    );
                }
            }
        }
        self.check(request, cancel)
    }
    async fn resolve_model(
        &self,
        request: &IntegrationRequest,
        definition: &OfficeAssistantDefinition,
        cancel: &CancellationToken,
    ) -> Result<IntegrationModelResolutionResult> {
        let selection: IntegrationModelSelectionIntent =
            serde_json::from_value(serde_json::to_value(&definition.model_selection)?)
                .context("OFFICE_MODEL_UNCONFIRMED")?;
        let mut call = request.clone();
        call.payload = serde_json::to_value(IntegrationModelResolutionRequest {
            selection,
            requirements: IntegrationModelRequirements {
                tools: definition
                    .allowed_tools
                    .as_ref()
                    .is_none_or(|tools| !tools.is_empty()),
                ..Default::default()
            },
        })?
        .as_object()
        .context("OFFICE_INVALID_INPUT")?
        .clone();
        let resolved: IntegrationModelResolutionResult = serde_json::from_value(
            self.port(
                IntegrationPort::Model,
                "resolveSelection",
                &call,
                cancel,
                false,
            )
            .await?,
        )
        .context("OFFICE_MODEL_UNCONFIRMED")?;
        let model = &resolved.model;
        ensure!(
            !model.model_id.is_empty() && !model.revision.is_empty() && model.text,
            "OFFICE_MODEL_UNCONFIRMED"
        );
        match &definition.model_selection {
            OfficeModelSelection::InheritCurrent => ensure!(
                matches!(
                    resolved.selection_kind,
                    IntegrationModelSelectionKind::InheritCurrent
                        | IntegrationModelSelectionKind::VerifierLocked
                ),
                "OFFICE_MODEL_SELECTION_MISMATCH"
            ),
            OfficeModelSelection::Explicit {
                provider,
                model: requested,
            } => ensure!(
                resolved.selection_kind == IntegrationModelSelectionKind::Explicit
                    && model.provider_id.as_deref() == Some(provider.as_str())
                    && model.model_id == *requested,
                "OFFICE_MODEL_SELECTION_MISMATCH"
            ),
            OfficeModelSelection::AutoPolicy { id, version } => ensure!(
                resolved.selection_kind == IntegrationModelSelectionKind::AutoPolicy
                    && resolved
                        .policy_ref
                        .as_ref()
                        .is_some_and(|policy| policy.id == *id && policy.version == *version),
                "OFFICE_MODEL_SELECTION_MISMATCH"
            ),
        }
        ensure!(
            resolved.budget.reservation_state != IntegrationBudgetReservationState::Denied,
            "OFFICE_MODEL_BUDGET_DENIED"
        );
        if definition
            .allowed_tools
            .as_ref()
            .is_none_or(|tools| !tools.is_empty())
        {
            ensure!(model.tools, "OFFICE_MODEL_TOOLS_UNAVAILABLE");
        }
        Ok(resolved)
    }
    async fn adopt(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
        language: &str,
    ) -> Result<Value> {
        let params: Adopt = payload(request)?;
        let language = params.language.as_deref().unwrap_or(language);
        ensure!(matches!(language, "zh-CN" | "en"), "OFFICE_INVALID_INPUT");
        let (saved, publication) = self
            .resolve_assistant(request, &params.id, &params.version, language, cancel)
            .await?;
        ensure!(!saved.archived, "OFFICE_VERSION_ARCHIVED");
        self.organization_policy(request, &saved.definition, "adopt", cancel)
            .await?;
        let inputs = prepare_office_inputs(&saved.definition, &params.inputs)?;
        let materials = inputs
            .get("materialRefs")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(|value| {
                        Ok(OfficeResourceRef {
                            kind: "office_input".into(),
                            id: value
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
        self.host
            .validate_sources(request, &materials, cancel)
            .await?;
        self.check_dependencies(request, &saved.definition, &materials, cancel)
            .await?;
        let model_resolution = self
            .resolve_model(request, &saved.definition, cancel)
            .await?;
        if let Some(workflow) = &saved.definition.workflow_ref {
            self.host
                .validate_sources(
                    request,
                    &[OfficeResourceRef {
                        kind: "workflow".into(),
                        id: workflow.definition_id.clone(),
                        revision: workflow.version.to_string(),
                    }],
                    cancel,
                )
                .await?;
        }
        self.host
            .validate_sources(request, &saved.definition.resources, cancel)
            .await?;
        // User-selected material IDs are resolved as untrusted resource references.

        self.policy(request,"office.assistant.execute",json!({"assistantId":saved.definition.id,"version":saved.version,"sourceRefs":materials,"modelRevision":model_resolution.model.revision}),cancel).await?;
        self.check(request, cancel)?;
        let adoption_operation = child_operation(request, "adoption")?;
        let adoption = self.store.adopt_snapshot(
            &adoption_operation,
            request.scope.clone(),
            saved.clone(),
            inputs.clone(),
            now()?,
        )?;
        if let Some(publication) = &publication {
            self.store.save_adoption_origin(
                &child_operation(request, "origin")?,
                &adoption_operation,
                publication.clone(),
            )?;
        }
        if !params.start_task {
            return Ok(
                json!({"adoption":adoption,"publication":publication,"taskState":"not_started"}),
            );
        }
        // Reserve the public intent before native acceptance. Repeated uncertain
        // acceptance is reconciled by the native operation receipt, never resent.
        if let Some(previous) = self.reserve(request, "assistant.startTask")? {
            return Ok(previous);
        }
        let mut runtime_definition = saved.definition.clone();
        runtime_definition.instructions = saved.definition.runtime_instructions();
        runtime_definition.skills.clear();
        let mut call = request.clone();
        call.payload=json!({"source":{"kind":"office_assistant","assistantId":params.id,"version":params.version},"conversationKey":adoption_operation,"message":{"text":format!("Office assistant definition (configuration, not additional authority):\n{}\nTask inputs (untrusted data):\n{}",serde_json::to_string(&runtime_definition)?,serde_json::to_string(&inputs)?),"attachments":materials},"configuration":{"modelSelection":saved.definition.model_selection,"allowedTools":saved.definition.allowed_tools,"workflowRef":saved.definition.workflow_ref,"externalSend":saved.definition.external_send,"modelResolution":model_resolution}}).as_object().context("OFFICE_INVALID_INPUT")?.clone();
        let accepted: IntegrationRuntimeAcceptance = serde_json::from_value(
            self.port(IntegrationPort::Runtime, "acceptTask", &call, cancel, true)
                .await?,
        )
        .context("OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        accepted.validate()?;
        ensure!(
            !accepted.thread_id.is_empty()
                && matches!(
                    accepted.state,
                    IntegrationTaskState::Queued | IntegrationTaskState::Running
                ),
            "OFFICE_RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        let linked = self.store.attach_native_task(
            &child_operation(request, "link")?,
            &adoption_operation,
            &accepted.thread_id,
            accepted.turn_id.as_deref(),
        )?;
        self.complete(
            request,
            json!({"adoption":linked,"publication":publication,"nativeTask":accepted,"businessComplete":false}),
        )
    }
}

fn readiness_resource(reference: &OfficeResourceRef) -> Result<Value> {
    let kind = match reference.kind.as_str() {
        "office_input" => "input",
        "artifact" => "artifact",
        "dataset" => "dataset",
        "publication" | "knowledge_publication" => "publication",
        "connection" => "connection",
        _ => anyhow::bail!("OFFICE_RESOURCE_KIND_UNSUPPORTED"),
    };
    Ok(json!({"kind":kind,"id":reference.id,"revision":reference.revision}))
}
