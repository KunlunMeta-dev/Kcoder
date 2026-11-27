use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveDraft {
    definition: AgentDefinition,
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
struct Import {
    definition: AgentDefinition,
    id: String,
}
impl AgentDefinitionService {
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
        let mut items = builtin_agent_definitions(language)
            .into_iter()
            .chain(builtin_octop_definitions(language))
            .filter(|_| !personal_only)
            .map(|definition| json!({"definition":definition,"builtin":true,"version":BUILTIN_AGENT_DEFINITION_VERSION}))
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

    pub(crate) async fn assistant(
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
                let builtins = builtin_agent_definitions(language).into_iter().chain(builtin_octop_definitions(language)).filter(|_| !personal_only).map(
                    |definition| json!({"definition":definition,"builtin":true,"version":BUILTIN_AGENT_DEFINITION_VERSION}),
                );
                let saved=self.store.list_drafts()?.into_iter().map(|draft|json!({"definition":draft.definition,"builtin":false,"draftRevision":draft.revision}));
                let mut items: Vec<Value> = builtins.chain(saved).collect();
                let mut organization_state = "disabled";
                if self.allow_organization_templates && !personal_only {
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
                if builtin_agent_definition(id, language).is_some() {
                    let version = version.unwrap_or(BUILTIN_AGENT_DEFINITION_VERSION);
                    let definition = builtin_agent_definition_version(id, language, version)
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
                validate_agent_definition(&params.definition)?;
                self.host
                    .inspect_requirements(request, &params.definition, cancel)
                    .await
            }
            "integrations/assistant/saveDraft" => {
                let params: SaveDraft = payload(request)?;
                validate_agent_definition(&params.definition)?;
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
                            source.revision == BUILTIN_AGENT_DEFINITION_VERSION
                                && request.expected_revision.is_none()
                                && params.definition.scope == AgentDefinitionScope::Personal,
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
                if draft.definition.scope == AgentDefinitionScope::Organization {
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
                    saved.definition.scope == AgentDefinitionScope::Organization
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
                definition.scope = AgentDefinitionScope::Personal;
                definition.resources.clear();
                definition.workflow_ref = None;
                definition.model_selection = AgentModelSelection::InheritCurrent;
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
                definition.scope = AgentDefinitionScope::Personal;
                definition.resources.clear();
                definition.workflow_ref = None;
                definition.model_selection = AgentModelSelection::InheritCurrent;
                validate_agent_definition(&definition)?;
                self.check(request, cancel)?;
                Ok(
                    json!({"draft":self.store.save_draft(operation(request)?,definition,Self::expected(request)?,now()?)?,"requiresReview":true,"detached":["resources","workflowRef","modelSelection"]}),
                )
            }
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        }
    }
    pub(crate) fn read_assistant_version(
        &self,
        id: &str,
        version: &str,
        language: &str,
    ) -> Result<AgentDefinitionVersion> {
        if builtin_agent_definition(id, language).is_some() {
            let definition = builtin_agent_definition_version(id, language, version)
                .context("OFFICE_VERSION_NOT_FOUND")?;
            let definition_sha256 = hash(&serde_json::to_vec(&definition)?);
            return Ok(AgentDefinitionVersion {
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
    pub(crate) async fn organization_policy(
        &self,
        request: &IntegrationRequest,
        definition: &AgentDefinition,
        action: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if definition.scope == AgentDefinitionScope::Organization {
            ensure!(
                self.allow_organization_templates,
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
}
