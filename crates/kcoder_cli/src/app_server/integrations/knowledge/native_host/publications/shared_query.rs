//! Execute an adopted fixed publication query on the publisher's original native FTS store.
use super::*;
use kcoder_app_rpc_codec as rpc_codec;

impl NativeKnowledgeHost {
    fn current_shared_adoption(
        &self,
        owner: &KnowledgeOwner,
        id: &str,
        version: u64,
        cancel: &CancellationToken,
    ) -> Result<KnowledgeAdoption> {
        let store = self
            .observe_publications()?
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_ADOPTION_NOT_FOUND"))?;
        store.verify(&self.native)?;
        let (selected, _) = KnowledgeCatalog::open_existing_native_owned(
            &store.directory,
            &store.binding.database_identity,
            &store.binding.lock_identity,
            &store.objects_path(&self.native)?,
            cancel,
            CatalogReadLimits::default(),
        )?
        .with_catalog(|catalog| {
            let mut after = None;
            let mut selected = None;
            for _ in 0..7 {
                let page = catalog.list_knowledge_adoptions(self.scope(), after.as_deref())?;
                for record in page.items {
                    if record.publication_owner == *owner
                        && record.publication_id == id
                        && record.publication_version == version
                        && record.enabled
                    {
                        ensure!(
                            selected.is_none(),
                            "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
                        );
                        selected = Some(record);
                    }
                }
                match page.next_cursor {
                    Some(next) if after.as_ref() != Some(&next) => after = Some(next),
                    None => {
                        return selected
                            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_ADOPTION_NOT_FOUND"));
                    }
                    _ => anyhow::bail!("KNOWLEDGE_INVALID_CURSOR"),
                }
            }
            anyhow::bail!("KNOWLEDGE_ADOPTION_CAPACITY")
        })?;
        store.verify(&self.native)?;
        Ok(selected)
    }

    pub(super) fn shared_query_dispatch(
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
            explicit_user_action: false,
            policy: &policy,
        };
        Some(super::super::super::api::dispatch(
            request,
            &context,
            false,
            "knowledge.read",
            KnowledgeResource {
                kind: "knowledge",
                id: "current-target".into(),
                owner: self.scope().into(),
            },
            || {
                let parameters: kcoder_app_protocol::integrations::knowledge::KnowledgeRetrieveParams = super::super::super::api::parse(request)?;
                ensure!(
                    !parameters.query.trim().is_empty()
                        && parameters.query.len() <= 4096
                        && (1..=20).contains(&parameters.limit),
                    "KNOWLEDGE_INVALID_QUERY"
                );
                let adoption = self.current_shared_adoption(
                    &owner,
                    &parameters.publication_id,
                    parameters.version,
                    cancel,
                )?;
                if legacy::same_profile_owner(&owner, self.scope()) {
                    let retrieval = self.legacy_reference_query(
                        request,
                        &owner,
                        &parameters.publication_id,
                        cancel,
                    )?;
                    ensure!(
                        self.current_shared_adoption(
                            &owner,
                            &parameters.publication_id,
                            parameters.version,
                            cancel
                        )? == adoption,
                        "KNOWLEDGE_SHARED_SOURCE_CHANGED"
                    );
                    return Ok((json!({"retrieval":retrieval}), None));
                }
                for action in ["knowledge.read", "knowledge.adopt"] {
                    self.check_shared_permission(&owner, &parameters.publication_id, action)?;
                }
                ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SHARED_READ_CANCELLED");
                let query = Some((parameters.query.as_str(), parameters.limit, now_ms));
                let (before, body) = self.native.shared_publication_request(
                    &owner,
                    &parameters.publication_id,
                    parameters.version,
                    "use",
                    &request.request_id,
                    None,
                    query,
                )?;
                ensure!(
                    before["payloadKind"] == "retrieval",
                    "KNOWLEDGE_SHARED_SOURCE_CHANGED"
                );
                let raw = super::shared_bridge::read_sealed_body(
                    body.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?,
                    &before,
                    self.scope(),
                    cancel,
                )?;
                let retrieval: KnowledgeRetrieval = serde_json::from_slice(&raw)?;
                ensure!(
                    retrieval.hits.len() <= parameters.limit
                        && retrieval
                            .hits
                            .iter()
                            .all(|hit| hit.publication_id == parameters.publication_id
                                && hit.version == parameters.version),
                    "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
                );
                let sha256 = before["bodySha256"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_SOURCE_CHANGED"))?;
                let (after, extra) = self.native.shared_publication_request(
                    &owner,
                    &parameters.publication_id,
                    parameters.version,
                    "use",
                    &request.request_id,
                    Some(sha256),
                    query,
                )?;
                ensure!(
                    extra.is_none()
                        && before == after
                        && self.current_shared_adoption(
                            &owner,
                            &parameters.publication_id,
                            parameters.version,
                            cancel
                        )? == adoption,
                    "KNOWLEDGE_SHARED_SOURCE_CHANGED"
                );
                self.native.validate_scope(&request.scope)?;
                ensure!(!cancel.is_cancelled(), "KNOWLEDGE_SHARED_READ_CANCELLED");
                Ok((json!({"retrieval":retrieval}), None))
            },
        ))
    }

    fn legacy_reference_query(
        &self,
        request: &IntegrationRequest,
        owner: &KnowledgeOwner,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<KnowledgeRetrieval> {
        for action in ["knowledge.read", "knowledge.adopt"] {
            self.check_shared_permission(owner, id, action)?;
        }
        let store = legacy::observe_directory(self)?
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))?;
        ensure!(
            store.allows_legacy_read(&self.native, owner)?,
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        let policy = self.publication_policy(Some(&store));
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms: u64::try_from(chrono::Utc::now().timestamp_millis())?,
            explicit_user_action: false,
            policy: &policy,
        };
        let (retrieval, _) = KnowledgeCatalog::open_existing_native_owned(
            &store.directory,
            &store.binding.database_identity,
            &store.binding.lock_identity,
            &store.objects_path(&self.native)?,
            cancel,
            CatalogReadLimits::default(),
        )?
        .with_catalog(|catalog| {
            let reply = super::super::super::publication_api::handle_publication(
                "retrieveKnowledge",
                request,
                &context,
                catalog,
            );
            ensure!(
                reply.status == IntegrationStatus::Completed,
                "KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"
            );
            serde_json::from_value(
                reply
                    .result
                    .as_ref()
                    .and_then(|result| result.get("retrieval"))
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_PROVIDER_UNAVAILABLE"))?,
            )
            .map_err(Into::into)
        })?;
        store.verify(&self.native)?;
        for action in ["knowledge.read", "knowledge.adopt"] {
            self.check_shared_permission(owner, id, action)?;
        }
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_POLICY_UNAVAILABLE");
        Ok(retrieval)
    }
}
