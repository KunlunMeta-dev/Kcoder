use super::api::*;
use anyhow::{Result, ensure};
use kcoder_app_protocol::integrations::knowledge::*;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope,
    integrations::knowledge::{PublicationAccess, PublicationAction},
};
use kcoder_types::integrations::{core::*, knowledge::*};
use serde_json::json;
struct NativeAccess<'a, 'b> {
    ctx: &'a KnowledgeHostContext<'b>,
}
impl PublicationAccess for NativeAccess<'_, '_> {
    fn check_publish_target(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        draft: &PublicationDraft,
    ) -> Result<bool> {
        if draft.visibility == KnowledgeVisibility::Personal {
            return self.check(
                caller,
                owner,
                &draft.publication_id,
                PublicationAction::Publish,
            );
        }
        let audience = draft
            .audience_id
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_AUDIENCE_DENIED"))?;
        let resource = KnowledgeResource {
            kind: "knowledge-audience",
            id: serde_json::to_string(&(&draft.visibility, audience))?,
            owner: owner.clone(),
        };
        let result = self
            .ctx
            .policy
            .evaluate_action(caller, "knowledge.share", &resource)?;
        Ok(result.decision == IntegrationPolicyDecision::Allow)
    }
    fn check(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        action: PublicationAction,
    ) -> Result<bool> {
        ensure!(scope == self.ctx.scope, "KNOWLEDGE_CALLER_SCOPE_MISMATCH");
        let resource = KnowledgeResource {
            kind: "publication",
            id: id.into(),
            owner: owner.clone(),
        };
        let action = match action {
            PublicationAction::Publish => "knowledge.publish",
            PublicationAction::Read => "knowledge.read",
            PublicationAction::ReadCitation => "knowledge.citation",
            PublicationAction::Revoke => "knowledge.revoke",
            PublicationAction::Adopt => "knowledge.adopt",
            PublicationAction::ManageAdoption => "knowledge.adoption.manage",
        };
        let result = self.ctx.policy.evaluate_action(scope, action, &resource)?;
        ensure!(
            result.decision != IntegrationPolicyDecision::Unknown,
            "KNOWLEDGE_POLICY_UNAVAILABLE"
        );
        Ok(result.decision == IntegrationPolicyDecision::Allow)
    }
}
pub fn handle_publication(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    catalog: &mut KnowledgeCatalog,
) -> IntegrationReply {
    handle_publication_with_sources(method, request, ctx, catalog, None)
}
pub fn handle_publication_with_sources(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    catalog: &mut KnowledgeCatalog,
    resolved: Option<&kcoder_knowledge::integrations::knowledge::VerifiedPublicationSources>,
) -> IntegrationReply {
    let mutation = matches!(
        method,
        "publishKnowledge" | "revokePublication" | "adoptPublication" | "setAdoptionEnabled"
    );
    let action = if mutation {
        "knowledge.manage"
    } else {
        "knowledge.read"
    };
    let resource = KnowledgeResource {
        kind: "knowledge",
        id: "current-target".into(),
        owner: KnowledgeOwner::from(ctx.scope),
    };
    dispatch(request, ctx, mutation, action, resource, || {
        let access = NativeAccess { ctx };
        match method {
            "resolvePublication" => {
                let p: PublicationReadParams = parse(request)?;
                let r = catalog.resolve_publication(
                    ctx.scope,
                    &p.owner,
                    &p.publication_id,
                    p.version,
                    &access,
                    ctx.now_ms,
                )?;
                let rev = r.version.to_string();
                Ok((json!({"publication":r}), Some(rev)))
            }
            "retrieveKnowledge" => {
                let p: KnowledgeRetrieveParams = parse(request)?;
                Ok((
                    json!({"retrieval":catalog.retrieve_publication(ctx.scope,&p.owner,&p.publication_id,p.version,&p.query,p.limit,&access,ctx.now_ms)?}),
                    None,
                ))
            }
            "readCitation" => {
                let p: CitationReadParams = parse(request)?;
                Ok((
                    json!({"citation":catalog.read_publication_citation(ctx.scope,&p.owner,&p.publication_id,p.version,&p.source,&access,ctx.now_ms)?}),
                    Some(p.version.to_string()),
                ))
            }
            "publishKnowledge" => {
                ensure!(
                    ctx.explicit_user_action,
                    "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED"
                );
                let p: KnowledgePublishParams = parse(request)?;
                let r = if let Some(resolved) = resolved {
                    catalog.publish_resolved_knowledge(
                        ctx.scope,
                        operation(request)?,
                        revision(request, true)?,
                        p.draft,
                        resolved,
                        &access,
                        ctx.now_ms,
                    )?
                } else {
                    let native = KnowledgeScope::from_authenticated_host(
                        &ctx.scope.account_id,
                        &ctx.scope.target_id,
                    )?;
                    catalog.publish_knowledge(
                        &native,
                        ctx.scope,
                        operation(request)?,
                        revision(request, true)?,
                        p.draft,
                        &access,
                        ctx.now_ms,
                    )?
                };
                let rev = r.version.to_string();
                Ok((json!({"publication":r}), Some(rev)))
            }
            "revokePublication" => {
                ensure!(
                    ctx.explicit_user_action,
                    "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED"
                );
                let p: KnowledgeRevokeParams = parse(request)?;
                catalog.revoke_publication(
                    ctx.scope,
                    &p.owner,
                    &p.publication_id,
                    p.version,
                    operation(request)?,
                    &access,
                )?;
                Ok((
                    json!({"revoked":true,"publicationId":p.publication_id,"version":p.version}),
                    Some(p.version.to_string()),
                ))
            }
            "adoptPublication" => {
                ensure!(
                    ctx.explicit_user_action,
                    "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED"
                );
                let p: KnowledgeAdoptParams = parse(request)?;
                let adoption = catalog.adopt_publication(
                    ctx.scope,
                    &p.owner,
                    &p.publication_id,
                    p.version,
                    operation(request)?,
                    revision(request, true)?,
                    &access,
                    ctx.now_ms,
                )?;
                Ok((
                    json!({"adoption":adoption}),
                    Some(adoption.revision.to_string()),
                ))
            }
            "setAdoptionEnabled" => {
                ensure!(
                    ctx.explicit_user_action,
                    "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED"
                );
                let p: KnowledgeAdoptionEnableParams = parse(request)?;
                let adoption = catalog.set_knowledge_adoption_enabled(
                    ctx.scope,
                    &p.adoption_id,
                    operation(request)?,
                    revision(request, false)?,
                    p.enabled,
                    &access,
                    ctx.now_ms,
                )?;
                Ok((
                    json!({"adoption":adoption}),
                    Some(adoption.revision.to_string()),
                ))
            }
            "listAdoptions" => {
                let p: MemoryListParams = parse(request)?;
                Ok((
                    json!({"page":catalog.list_knowledge_adoptions(ctx.scope,p.after.as_deref())?}),
                    None,
                ))
            }
            "listPublications" => {
                let p: MemoryListParams = parse(request)?;
                Ok((
                    json!({"page":catalog.list_publications(ctx.scope,&access,p.after.as_deref(),ctx.now_ms)?}),
                    None,
                ))
            }
            "listPublicationHistory" => {
                let p: MemoryListParams = parse(request)?;
                Ok((
                    json!({"page":catalog.list_owned_publication_versions(ctx.scope,&access,p.after.as_deref())?}),
                    None,
                ))
            }
            _ => anyhow::bail!("KNOWLEDGE_METHOD_UNSUPPORTED"),
        }
    })
}
