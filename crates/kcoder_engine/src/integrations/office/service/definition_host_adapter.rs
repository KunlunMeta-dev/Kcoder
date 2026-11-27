use super::*;
pub(super) struct DefinitionHostAdapter {
    pub host: Arc<dyn OfficeHost>,
    pub store: Arc<ResourceStore>,
    pub settings: OfficeSettings,
}
#[async_trait]
impl AgentDefinitionHost for DefinitionHostAdapter {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        self.host.validate_scope(scope)
    }
    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<IntegrationReply> {
        self.host.call_port(port, method, request, cancel).await
    }
    async fn validate_sources(
        &self,
        request: &IntegrationRequest,
        sources: &[AgentResourceRef],
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.host.validate_sources(request, sources, cancel).await
    }
    async fn organization_templates(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Vec<SharedAgentDefinition>> {
        self.host.organization_templates(request, cancel).await
    }
    async fn publish_organization_template(
        &self,
        request: &IntegrationRequest,
        version: &AgentDefinitionVersion,
        cancel: &CancellationToken,
    ) -> Result<AgentResourceRef> {
        self.host
            .publish_organization_template(request, version, cancel)
            .await
    }
    async fn archive_organization_template(
        &self,
        request: &IntegrationRequest,
        publication: &AgentResourceRef,
        cancel: &CancellationToken,
    ) -> Result<()> {
        self.host
            .archive_organization_template(request, publication, cancel)
            .await
    }
    async fn inspect_requirements(
        &self,
        request: &IntegrationRequest,
        definition: &AgentDefinition,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        if !self.settings.enabled {
            return Ok(
                json!({"definitionValid":true,"staticOnly":true,"adoptable":false,
                "requiredCapabilities":definition.capabilities,"requiredResources":definition.resources,
                "generator":{"status":"unavailable","reasonCode":"OFFICE_DISABLED"},
                "readiness":{"state":"unknown","capabilities":[]},"reasonCode":"AGENT_RECHECK_ON_EXECUTION"}),
            );
        }
        OfficeService::new(self.store.clone(), self.settings.clone(), self.host.clone())?
            .inspect_assistant_requirements(request, definition, cancel)
            .await
    }
}
