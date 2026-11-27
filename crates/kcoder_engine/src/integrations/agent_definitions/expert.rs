use super::*;
use kcoder_tools::expert_market::ExpertMarketClient;

impl AgentDefinitionService {
    pub fn builtin_expert_assets(request: &IntegrationRequest) -> Result<Value> {
        request.validate(false)?;
        let params: AgentDefinitionReadParams = payload(request)?;
        let (package, files) =
            builtin_octop_package(&params.id).context("OFFICE_PACKAGE_NOT_FOUND")?;
        let content = params
            .path
            .as_deref()
            .map(|path| {
                let (_, bytes) = files
                    .iter()
                    .find(|(name, _)| name == path)
                    .context("OFFICE_PACKAGE_NOT_FOUND")?;
                ensure!(bytes.len() <= 256 * 1024, "OFFICE_STORAGE_LIMIT");
                String::from_utf8(bytes.clone()).context("OFFICE_INVALID_INPUT")
            })
            .transpose()?;
        Ok(json!({"package": package, "content": content}))
    }

    pub async fn expert_market_catalog(
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        request.validate(false)?;
        let params: AgentMarketListParams = payload(request)?;
        ensure!(
            params.query.len() <= 200
                && params.scene.len() <= 128
                && matches!(params.language.as_str(), "zh-CN" | "en"),
            "OFFICE_INVALID_INPUT"
        );
        let items = ExpertMarketClient::new()?
            .list(&params.language, cancel)
            .await?;
        let scenes: std::collections::BTreeSet<_> = items
            .iter()
            .filter(|item| !item.scene.is_empty())
            .map(|item| item.scene.clone())
            .collect();
        let query = params.query.trim().to_lowercase();
        let items: Vec<_> = items
            .into_iter()
            .filter(|item| {
                (params.scene.is_empty() || item.scene == params.scene)
                    && (query.is_empty()
                        || format!("{} {} {}", item.slug, item.title, item.description)
                            .to_lowercase()
                            .contains(&query))
            })
            .collect();
        let mut result = page_values(items, request)?;
        result["scenes"] = serde_json::to_value(scenes)?;
        Ok(result)
    }

    pub async fn expert_market_detail(
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        request.validate(false)?;
        let params: AgentMarketDetailParams = payload(request)?;
        ensure!(
            matches!(params.language.as_str(), "zh-CN" | "en"),
            "OFFICE_INVALID_INPUT"
        );
        let detail = ExpertMarketClient::new()?
            .detail(&params.slug, &params.language, cancel)
            .await?;
        Ok(serde_json::to_value(detail)?)
    }

    pub(crate) async fn expert(
        &self,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        match method {
            "integrations/assistant/market/read" => {
                Self::expert_market_detail(request, cancel).await
            }
            "integrations/assistant/market/list" => {
                Self::expert_market_catalog(request, cancel).await
            }
            "integrations/assistant/market/install" => {
                let params: AgentMarketInstallParams = payload(request)?;
                ensure!(
                    params.id.starts_with("personal.")
                        && matches!(params.language.as_str(), "zh-CN" | "en"),
                    "OFFICE_INVALID_INPUT"
                );
                let market = ExpertMarketClient::new()?;
                let prepared = tokio::time::timeout(
                    std::time::Duration::from_secs(55),
                    market.download(&params.slug, &params.language, cancel),
                )
                .await
                .context("OFFICE_MARKET_DOWNLOAD_FAILED")?
                .context("OFFICE_MARKET_DOWNLOAD_FAILED")?;
                self.check(request, cancel)?;
                self.policy(
                    request,
                    "office.assistant.write",
                    Value::Object(request.payload.clone()),
                    cancel,
                )
                .await?;
                self.check(request, cancel)?;
                let definition = AgentDefinition {
                    schema_version: 1,
                    id: params.id,
                    scope: AgentDefinitionScope::Personal,
                    title: prepared.item.title,
                    description: prepared.item.description,
                    language: params.language,
                    input_schema: match prepared.presentation {
                        Some(presentation) => {
                            json!({"type":"object", "x-kcoder-expert": presentation})
                        }
                        None => json!({"type":"object"}),
                    },
                    instructions: prepared.instructions,
                    skills: Vec::new(),
                    capabilities: Vec::new(),
                    resources: Vec::new(),
                    workflow_ref: None,
                    model_selection: AgentModelSelection::InheritCurrent,
                    allowed_tools: prepared.allowed_tools,
                    output_kinds: vec![AgentOutputKind::Document],
                    acceptance_criteria: vec!["Review the downloaded expert before use".into()],
                    external_send: AgentExternalSend::Deny,
                };
                validate_agent_definition(&definition)?;
                let draft = self.store.install_expert(
                    operation(request)?,
                    definition,
                    prepared.package.clone(),
                    &prepared.files,
                    now()?,
                )?;
                Ok(
                    json!({"draft": draft, "package": prepared.package, "requiresReview": true, "executionEnabled": false}),
                )
            }
            "integrations/assistant/package/read" => {
                let params: AgentDefinitionReadParams = payload(request)?;
                if params.id.starts_with("builtin.octop.") {
                    return Self::builtin_expert_assets(request);
                }
                let package = self.store.read_expert_package(&params.id)?;
                let content = params
                    .path
                    .as_deref()
                    .map(|path| {
                        self.store
                            .read_expert_file(&params.id, path)
                            .and_then(|bytes| {
                                String::from_utf8(bytes).context("OFFICE_INVALID_INPUT")
                            })
                    })
                    .transpose()?;
                Ok(json!({"package":package,"content":content}))
            }
            "integrations/assistant/deleteDraft" => {
                let params: AgentDefinitionDeleteParams = payload(request)?;
                self.store.delete_assistant_draft(
                    operation(request)?,
                    &params.id,
                    Self::expected(request)?.context("OFFICE_REVISION_REQUIRED")?,
                )
            }
            _ => anyhow::bail!("OFFICE_METHOD_UNSUPPORTED"),
        }
    }
}
