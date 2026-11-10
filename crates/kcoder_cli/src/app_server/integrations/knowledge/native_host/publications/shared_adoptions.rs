//! Adoption persists only a caller-owned reference; every use returns to the publisher's real store.
use super::*;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_knowledge::integrations::knowledge::{
    PublicationAccess, PublicationAction, PublicationReferenceResolver,
};

struct Source<'a> {
    host: &'a NativeKnowledgeHost,
    request: &'a IntegrationRequest,
    cancel: &'a CancellationToken,
}
impl PublicationReferenceResolver for Source<'_> {
    fn resolve_reference(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
    ) -> Result<KnowledgePublication> {
        self.host.native.validate_scope(caller)?;
        self.host
            .resolve_reference_for_use(self.request, owner, id, version, self.cancel)
    }
}
struct Access<'a> {
    host: &'a NativeKnowledgeHost,
    store: &'a NativePublications,
    publisher: &'a KnowledgeOwner,
    id: &'a str,
    adoption_id: Option<&'a str>,
}
impl PublicationAccess for Access<'_> {
    fn check(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        action: PublicationAction,
    ) -> Result<bool> {
        self.host.native.validate_scope(caller)?;
        self.store.verify(&self.host.native)?;
        if action == PublicationAction::ManageAdoption {
            ensure!(
                owner == &KnowledgeOwner::from(caller) && self.adoption_id == Some(id),
                "KNOWLEDGE_RESOURCE_DENIED"
            );
            let resource = KnowledgeResource {
                kind: "knowledge",
                id: "current-target".into(),
                owner: owner.clone(),
            };
            return Ok(self
                .host
                .publication_policy(Some(self.store))
                .evaluate_action(caller, "knowledge.adoption.manage", &resource)?
                .decision
                == IntegrationPolicyDecision::Allow);
        }
        ensure!(
            owner == self.publisher
                && id == self.id
                && matches!(action, PublicationAction::Read | PublicationAction::Adopt),
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        let action = if action == PublicationAction::Adopt {
            "knowledge.adopt"
        } else {
            "knowledge.read"
        };
        self.host.check_shared_permission(owner, id, action)?;
        Ok(true)
    }
}

impl NativeKnowledgeHost {
    pub(super) fn shared_adopt_dispatch(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> Option<IntegrationReply> {
        let owner: KnowledgeOwner =
            rpc_codec::decode(request.payload.get("owner")?.clone()).ok()?;
        if owner.account_id == self.scope().account_id
            && !legacy::same_profile_owner(&owner, self.scope())
            && !legacy::same_account_other_workspace(&owner, self.scope())
        {
            return None;
        }
        let policy = self.publication_policy(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: true,
            policy: &policy,
        };
        Some(super::super::super::api::dispatch(
            request,
            &context,
            true,
            "knowledge.manage",
            KnowledgeResource {
                kind: "knowledge",
                id: "current-target".into(),
                owner: self.scope().into(),
            },
            || {
                let parameters: kcoder_app_protocol::integrations::knowledge::KnowledgeAdoptParams =
                    super::super::super::api::parse(request)?;
                // Resolve real current read/use authority before the first owned namespace write.
                self.resolve_reference_for_use(
                    request,
                    &owner,
                    &parameters.publication_id,
                    parameters.version,
                    cancel,
                )?;
                let store = match self.observe_publications()? {
                    Some(store) => store,
                    None => {
                        ensure!(
                            super::super::super::api::revision(request, true)? == 0,
                            "KNOWLEDGE_ADOPTION_REVISION_CONFLICT"
                        );
                        self.initialize_publications(super::super::super::api::operation(request)?)?
                    }
                };
                store.verify(&self.native)?;
                let access = Access {
                    host: self,
                    store: &store,
                    publisher: &owner,
                    id: &parameters.publication_id,
                    adoption_id: None,
                };
                let source = Source {
                    host: self,
                    request,
                    cancel,
                };
                let adoption = KnowledgeCatalog::open_native_owned(
                    &store.directory,
                    &store.binding.database_identity,
                    &store.binding.lock_identity,
                    &store.objects_path(&self.native)?,
                    false,
                )?
                .with_catalog(|catalog| {
                    catalog.adopt_external_publication(
                        self.scope(),
                        &owner,
                        &parameters.publication_id,
                        parameters.version,
                        super::super::super::api::operation(request)?,
                        super::super::super::api::revision(request, true)?,
                        &access,
                        &source,
                        now_ms,
                    )
                })?;
                store.verify(&self.native)?;
                Ok((
                    json!({"adoption":adoption}),
                    Some(adoption.revision.to_string()),
                ))
            },
        ))
    }

    pub(super) fn shared_enable_dispatch(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> Option<IntegrationReply> {
        let id = request.payload.get("adoptionId")?.as_str()?;
        let store = match self.observe_publications() {
            Ok(Some(store)) => store,
            _ => return None,
        };
        let found = (|| -> Result<Option<KnowledgeAdoption>> {
            KnowledgeCatalog::open_existing_native_owned(
                &store.directory,
                &store.binding.database_identity,
                &store.binding.lock_identity,
                &store.objects_path(&self.native)?,
                cancel,
                CatalogReadLimits::default(),
            )?
            .with_catalog(|catalog| {
                let mut after = None;
                for _ in 0..7 {
                    let page = catalog.list_knowledge_adoptions(self.scope(), after.as_deref())?;
                    if let Some(record) = page.items.into_iter().find(|record| record.id == id) {
                        return Ok(Some(record));
                    }
                    match page.next_cursor {
                        Some(next) if after.as_ref() != Some(&next) => after = Some(next),
                        None => return Ok(None),
                        _ => anyhow::bail!("KNOWLEDGE_INVALID_CURSOR"),
                    }
                }
                anyhow::bail!("KNOWLEDGE_ADOPTION_CAPACITY")
            })
            .map(|(record, _)| record)
        })();
        let found = match found {
            Ok(Some(record)) => record,
            Ok(None) => return None,
            Err(_) => {
                return Some(self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Unavailable,
                    "KNOWLEDGE_NATIVE_STORE_UNAVAILABLE",
                    IntegrationRecovery::RetryRead,
                ));
            }
        };
        if found.publication_owner.account_id == self.scope().account_id
            && !legacy::same_profile_owner(&found.publication_owner, self.scope())
            && !legacy::same_account_other_workspace(&found.publication_owner, self.scope())
        {
            return None;
        }
        let policy = self.publication_policy(Some(&store));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: true,
            policy: &policy,
        };
        Some(super::super::super::api::dispatch(
            request,
            &context,
            true,
            "knowledge.manage",
            KnowledgeResource {
                kind: "knowledge",
                id: "current-target".into(),
                owner: self.scope().into(),
            },
            || {
                let parameters: kcoder_app_protocol::integrations::knowledge::KnowledgeAdoptionEnableParams = super::super::super::api::parse(request)?;
                let access = Access {
                    host: self,
                    store: &store,
                    publisher: &found.publication_owner,
                    id: &found.publication_id,
                    adoption_id: Some(&found.id),
                };
                let source = Source {
                    host: self,
                    request,
                    cancel,
                };
                let current = KnowledgeCatalog::open_native_owned(
                    &store.directory,
                    &store.binding.database_identity,
                    &store.binding.lock_identity,
                    &store.objects_path(&self.native)?,
                    false,
                )?
                .with_catalog(|catalog| {
                    catalog.set_external_adoption_enabled(
                        self.scope(),
                        &parameters.adoption_id,
                        super::super::super::api::operation(request)?,
                        super::super::super::api::revision(request, false)?,
                        parameters.enabled,
                        &access,
                        &source,
                        now_ms,
                    )
                })?;
                store.verify(&self.native)?;
                Ok((
                    json!({"adoption":current}),
                    Some(current.revision.to_string()),
                ))
            },
        ))
    }
}
