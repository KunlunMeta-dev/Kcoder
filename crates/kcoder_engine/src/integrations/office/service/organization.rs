//! Organization consumers. Local scope labels never create a shared publication.
use super::*;
impl OfficeService {
    pub(super) async fn shared_assistants(
        &self,
        request: &IntegrationRequest,
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeSharedAssistant>> {
        ensure!(
            self.settings.allow_organization_templates,
            "OFFICE_ORGANIZATION_DISABLED"
        );
        let organization = IntegrationOwner::from(&request.scope)
            .organization_id
            .and_then(|id| id.as_ref().cloned())
            .context("OFFICE_ORGANIZATION_REQUIRED")?;
        self.policy(
            request,
            "office.organization.read",
            json!({"organizationId":organization}),
            cancel,
        )
        .await?;
        let templates = self.host.organization_templates(request, cancel).await?;
        self.check(request, cancel)?;
        ensure!(templates.len() <= 128, "OFFICE_ORGANIZATION_LIMIT");
        for template in &templates {
            template.version.definition.validate()?;
            template.publication.validate()?;
            ensure!(
                template.publication.kind == "publication"
                    && template.version.definition.scope == OfficeAssistantScope::Organization
                    && template
                        .version
                        .owner
                        .organization_id
                        .as_ref()
                        .and_then(|id| id.as_ref())
                        == Some(&organization)
                    && template.version.definition_sha256
                        == hash(&serde_json::to_vec(&template.version.definition)?),
                "OFFICE_ORGANIZATION_IDENTITY_MISMATCH"
            );
            ensure!(
                template.version.definition.resources.is_empty()
                    && template.version.definition.workflow_ref.is_none()
                    && template.version.definition.model_selection
                        == OfficeModelSelection::InheritCurrent,
                "OFFICE_ORGANIZATION_BINDINGS_MUST_BE_DETACHED"
            );
        }
        Ok(templates)
    }
    pub(super) async fn resolve_assistant(
        &self,
        request: &IntegrationRequest,
        id: &str,
        version: &str,
        language: &str,
        cancel: &CancellationToken,
    ) -> Result<(OfficeAssistantVersion, Option<OfficeResourceRef>)> {
        let local = self.read_assistant_version(id, version, language);
        if let Ok(saved) = &local
            && saved.definition.scope != OfficeAssistantScope::Organization
        {
            return Ok((saved.clone(), None));
        }
        if !self.settings.allow_organization_templates {
            return local.map(|version| (version, None));
        }
        let shared = self
            .shared_assistants(request, cancel)
            .await?
            .into_iter()
            .find(|template| {
                template.version.definition.id == id && template.version.version == version
            })
            .context("OFFICE_ORGANIZATION_PUBLICATION_NOT_FOUND")?;
        ensure!(!shared.version.archived, "OFFICE_VERSION_ARCHIVED");
        self.policy(request,"office.organization.adopt",json!({"publication":shared.publication,"definitionSha256":shared.version.definition_sha256}),cancel).await?;
        self.host
            .validate_sources(request, std::slice::from_ref(&shared.publication), cancel)
            .await?;
        self.check(request, cancel)?;
        Ok((shared.version, Some(shared.publication)))
    }
    pub(super) fn detach_shared_version(
        version: &OfficeAssistantVersion,
    ) -> Result<OfficeAssistantVersion> {
        let mut version = version.clone();
        version.definition.resources.clear();
        version.definition.workflow_ref = None;
        version.definition.model_selection = OfficeModelSelection::InheritCurrent;
        version.definition_sha256 = hash(&serde_json::to_vec(&version.definition)?);
        Ok(version)
    }
}
