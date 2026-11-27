use super::*;
use serde::Deserialize;
mod preflight;
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
impl OfficeService {
    pub(super) async fn assistant(
        &self,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        ensure!(
            method == "integrations/assistant/adopt",
            "OFFICE_METHOD_UNSUPPORTED"
        );
        let language = request
            .payload
            .get("language")
            .and_then(Value::as_str)
            .unwrap_or("zh-CN");
        self.adopt(request, cancel, language).await
    }
    async fn check_dependencies(
        &self,
        request: &IntegrationRequest,
        definition: &AgentDefinition,
        materials: &[AgentResourceRef],
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
        definition: &AgentDefinition,
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
            AgentModelSelection::InheritCurrent => ensure!(
                matches!(
                    resolved.selection_kind,
                    IntegrationModelSelectionKind::InheritCurrent
                        | IntegrationModelSelectionKind::VerifierLocked
                ),
                "OFFICE_MODEL_SELECTION_MISMATCH"
            ),
            AgentModelSelection::Explicit {
                provider,
                model: requested,
            } => ensure!(
                resolved.selection_kind == IntegrationModelSelectionKind::Explicit
                    && model.provider_id.as_deref() == Some(provider.as_str())
                    && model.model_id == *requested,
                "OFFICE_MODEL_SELECTION_MISMATCH"
            ),
            AgentModelSelection::AutoPolicy { id, version } => ensure!(
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
            .definitions
            .resolve_assistant(request, &params.id, &params.version, language, cancel)
            .await?;
        ensure!(!saved.archived, "OFFICE_VERSION_ARCHIVED");
        self.definitions
            .organization_policy(request, &saved.definition, "adopt", cancel)
            .await?;
        let inputs = prepare_office_inputs(&saved.definition, &params.inputs)?;
        let materials = inputs
            .get("materialRefs")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(|value| {
                        Ok(AgentResourceRef {
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
                    &[AgentResourceRef {
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

fn readiness_resource(reference: &AgentResourceRef) -> Result<Value> {
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
