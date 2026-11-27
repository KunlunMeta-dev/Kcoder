//! Resource policy intersects the existing domain policy at each actual access.
use super::*;

pub(super) fn resource_id(resource: &KnowledgeResource) -> Result<String> {
    kcoder_knowledge_rpc::publication_reader::resource_id(
        resource.kind,
        &resource.owner,
        &resource.id,
    )
}

pub(super) fn current_revision(
    native: &NativeIntegrationContext,
    action: &str,
    resource: &KnowledgeResource,
) -> Result<Option<u64>> {
    if native.scope().organization_id.is_none() {
        return Ok(None);
    }
    let action = match action {
        "knowledge.read" | "knowledge.citation" | "automation.read" | "memory.read" => "read",
        "knowledge.adopt" => "use",
        "knowledge.manage"
        | "knowledge.revoke"
        | "knowledge.adoption.manage"
        | "automation.configure"
        | "automation.cancel"
        | "memory.write" => "write",
        "knowledge.publish" | "knowledge.share" => "publish",
        "automation.trigger" => "execute",
        "automation.deliver" | "automation.external_delivery" => "deliver",
        _ => anyhow::bail!("KNOWLEDGE_ORGANIZATION_ACTION_UNAVAILABLE"),
    };
    native.authorize_organization_resource(
        action,
        &resource_id(resource)?,
        &uuid::Uuid::new_v4().to_string(),
    )?;
    native
        .organization_policy_revision()?
        .map(Some)
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_ORGANIZATION_POLICY_UNAVAILABLE"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_keys_preserve_owner_kind_and_exact_reference_without_exposing_body() -> Result<()> {
        let owner = IntegrationOwner {
            account_id: "actual-account".into(),
            target_id: "actual-target".into(),
            workspace_id: IntegrationNullable::Value("actual-workspace".into()),
            organization_id: Some(IntegrationNullable::Value("actual-organization".into())),
        };
        let mut resource = KnowledgeResource {
            kind: "publication",
            id: "private-source-reference".into(),
            owner,
        };
        let original = resource_id(&resource)?;
        assert_eq!(original.len(), "knowledge:".len() + 64);
        assert!(!original.contains("private-source-reference"));
        assert_eq!(original, resource_id(&resource)?);
        resource.id.push_str("-different");
        assert_ne!(original, resource_id(&resource)?);
        resource.id = "private-source-reference".into();
        resource.owner.account_id = "another-owner".into();
        assert_ne!(original, resource_id(&resource)?);
        resource.kind = "caller-invented-resource";
        assert!(resource_id(&resource).is_err());
        Ok(())
    }
}
