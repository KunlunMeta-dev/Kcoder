//! Data-only routing to the authenticated profile's original namespace; authority stays current.
use super::*;

use kcoder_app_rpc_codec as rpc_codec;
pub(super) use kcoder_knowledge_rpc::publication_reader::same_account_other_workspace;

pub(super) fn same_profile_owner(owner: &KnowledgeOwner, scope: &IntegrationScope) -> bool {
    matches!(scope.organization_id, Some(IntegrationNullable::Value(_)))
        && owner.organization_id.is_none()
        && owner.account_id == scope.account_id
        && owner.target_id == scope.target_id
        && owner.workspace_id == scope.workspace_id
}
pub(super) fn held_legacy_owner(
    store: &NativePublications,
    scope: &IntegrationScope,
) -> Result<bool> {
    if !same_profile_owner(&store.binding.owner, scope) {
        return Ok(false);
    }
    let mut data_scope = scope.clone();
    data_scope.organization_id = None;
    Ok(store.guard.namespace_id()
        == NativeDomainGuard::expected_namespace_id(&data_scope, NativeDomain::Knowledge)?)
}
pub(super) fn observe_explicit_read(
    host: &NativeKnowledgeHost,
    method: &str,
    request: &IntegrationRequest,
) -> Result<Option<NativePublications>> {
    host.native.validate_scope(&request.scope)?;
    if matches!(method, "resolvePublication" | "readCitation")
        && host.scope().organization_id.is_some()
    {
        let owner: KnowledgeOwner = rpc_codec::decode(
            request
                .payload
                .get("owner")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?,
        )?;
        if same_profile_owner(&owner, host.scope()) {
            // This temporary value locates only an existing receipt. It is never
            // used as caller identity, policy authority or a new initialization scope.
            let mut data_scope = host.scope().clone();
            data_scope.organization_id = None;
            let Some(guard) = NativeDomainGuard::observe(
                host.native.profile()?,
                &data_scope,
                NativeDomain::Knowledge,
            )?
            else {
                return Ok(None);
            };
            let store = host.open_publications_guard(guard)?;
            ensure!(
                store.binding.owner == owner,
                "KNOWLEDGE_NATIVE_LEGACY_OWNER_MISMATCH"
            );
            host.native.validate_scope(&request.scope)?;
            return Ok(Some(store));
        }
    }
    host.observe_publications()
}

pub(super) fn observe_directory(host: &NativeKnowledgeHost) -> Result<Option<NativePublications>> {
    if !matches!(
        host.scope().organization_id,
        Some(IntegrationNullable::Value(_))
    ) {
        return Ok(None);
    }
    let mut data_scope = host.scope().clone();
    data_scope.organization_id = None;
    let Some(guard) =
        NativeDomainGuard::observe(host.native.profile()?, &data_scope, NativeDomain::Knowledge)?
    else {
        return Ok(None);
    };
    let store = host.open_publications_guard(guard)?;
    ensure!(
        held_legacy_owner(&store, host.scope())?,
        "KNOWLEDGE_NATIVE_LEGACY_OWNER_MISMATCH"
    );
    Ok(Some(store))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn other_workspace_route_requires_same_profile_target_current_org_and_two_distinct_workspaces()
    {
        let scope = IntegrationScope {
            account_id: "actual-profile".into(),
            target_id: "actual-target".into(),
            workspace_id: IntegrationNullable::Value("current-workspace".into()),
            organization_id: Some(IntegrationNullable::Value("current-org".into())),
            identity_generation: "current-epoch".into(),
            target_revision: "current-config".into(),
        };
        let mut owner = KnowledgeOwner::from(&scope);
        assert!(!same_account_other_workspace(&owner, &scope));
        owner.workspace_id = IntegrationNullable::Value("original-other-workspace".into());
        assert!(same_account_other_workspace(&owner, &scope));
        for field in ["target", "account", "organization", "workspace-null"] {
            let mut wrong = owner.clone();
            match field {
                "target" => wrong.target_id = "other-target".into(),
                "account" => wrong.account_id = "other-profile".into(),
                "organization" => wrong.organization_id = None,
                _ => wrong.workspace_id = IntegrationNullable::Null,
            }
            assert!(!same_account_other_workspace(&wrong, &scope), "{field}");
        }
    }

    #[test]
    fn namespace_hint_requires_current_organization_and_exact_original_profile_owner() {
        let scope = IntegrationScope {
            account_id: "actual-profile".into(),
            target_id: "actual-native-target".into(),
            workspace_id: IntegrationNullable::Value("actual-workspace".into()),
            organization_id: Some(IntegrationNullable::Value("current-org".into())),
            identity_generation: "current-native-generation".into(),
            target_revision: "current-config".into(),
        };
        let mut legacy = KnowledgeOwner::from(&scope);
        legacy.organization_id = None;
        assert!(same_profile_owner(&legacy, &scope));
        let mut wrong = legacy.clone();
        wrong.account_id = "another-profile".into();
        assert!(!same_profile_owner(&wrong, &scope));
        wrong = legacy.clone();
        wrong.target_id = "another-target".into();
        assert!(!same_profile_owner(&wrong, &scope));
        wrong = legacy.clone();
        wrong.workspace_id = IntegrationNullable::Null;
        assert!(!same_profile_owner(&wrong, &scope));
        let mut null_organization = scope.clone();
        null_organization.organization_id = Some(IntegrationNullable::Null);
        assert!(!same_profile_owner(&legacy, &null_organization));
        let mut personal = scope;
        personal.organization_id = None;
        assert!(!same_profile_owner(&legacy, &personal));
    }
}
