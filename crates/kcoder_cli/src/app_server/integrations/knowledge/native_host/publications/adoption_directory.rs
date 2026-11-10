//! Caller-owned adoption metadata is discovered under current source read/use policy.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

impl NativeKnowledgeHost {
    pub(in crate::app_server::integrations::knowledge) fn has_recorded_publication_adoption(
        &self,
        current: &KnowledgeAdoption,
        version: u64,
        cancel: &CancellationToken,
    ) -> Result<bool> {
        let mut stores = Vec::new();
        if let Some(store) = self.observe_publications()? {
            stores.push(store);
        }
        if let Some(store) = legacy::observe_directory(self)? {
            stores.push(store);
        }
        let mut found = false;
        for store in stores {
            if store.binding.owner != current.owner {
                continue;
            }
            store.verify(&self.native)?;
            let (recorded, proof) = KnowledgeCatalog::open_existing_native_owned(
                &store.directory,
                &store.binding.database_identity,
                &store.binding.lock_identity,
                &store.objects_path(&self.native)?,
                cancel,
                CatalogReadLimits::default(),
            )?
            .with_catalog(|catalog| {
                catalog.has_recorded_publication_adoption(self.scope(), current, version)
            })?;
            store.verify(&self.native)?;
            let source = store
                .directory
                .try_sqlite_source_read_lease(
                    OsStr::new(DB),
                    CatalogReadLimits::default().source_bytes,
                )?
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))?;
            ensure!(
                source.identity_sha256()? == proof.source_identity_sha256,
                "KNOWLEDGE_ADOPTION_REVISION_CONFLICT"
            );
            found |= recorded;
        }
        ensure!(!cancel.is_cancelled(), "KNOWLEDGE_POLICY_UNAVAILABLE");
        Ok(found)
    }

    pub(super) fn adoption_directory(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> IntegrationReply {
        let policy = self.publication_policy(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &policy,
        };
        super::super::super::api::dispatch(
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
                let parameters: kcoder_app_protocol::integrations::knowledge::MemoryListParams =
                    super::super::super::api::parse(request)?;
                let cursor = match parameters.after.as_deref() {
                    None => None,
                    Some(raw) => {
                        let parts: Vec<_> = raw.split('.').collect();
                        ensure!(
                            parts.len() == 3
                                && parts[0] == "ka2"
                                && parts[1..].iter().all(|part| part.len() == 64
                                    && part.bytes().all(|byte| byte.is_ascii_hexdigit()
                                        && !byte.is_ascii_uppercase())),
                            "KNOWLEDGE_INVALID_CURSOR"
                        );
                        Some((parts[1], parts[2]))
                    }
                };
                let revision = self.native.organization_policy_revision()?;
                let mut stores = Vec::new();
                if let Some(store) = self.observe_publications()? {
                    stores.push(store);
                }
                if let Some(store) = legacy::observe_directory(self)? {
                    stores.push(store);
                }
                let mut records = Vec::new();
                let mut proofs = Vec::new();
                for store in &stores {
                    store.verify(&self.native)?;
                    let (rows, proof) = KnowledgeCatalog::open_existing_native_owned(
                        &store.directory,
                        &store.binding.database_identity,
                        &store.binding.lock_identity,
                        &store.objects_path(&self.native)?,
                        cancel,
                        CatalogReadLimits::default(),
                    )?
                    .with_catalog(|catalog| {
                        let mut rows = Vec::new();
                        let mut after = None;
                        for _ in 0..7 {
                            let page = catalog.list_owned_catalog_adoptions(
                                self.scope(),
                                &store.binding.owner,
                                after.as_deref(),
                            )?;
                            rows.extend(page.items);
                            ensure!(rows.len() <= 64, "KNOWLEDGE_ADOPTION_CAPACITY");
                            match page.next_cursor {
                                Some(next) if after.as_ref() != Some(&next) => after = Some(next),
                                None => return Ok(rows),
                                _ => anyhow::bail!("KNOWLEDGE_INVALID_CURSOR"),
                            }
                        }
                        anyhow::bail!("KNOWLEDGE_ADOPTION_CAPACITY")
                    })?;
                    records.extend(rows);
                    proofs.push(proof.source_identity_sha256);
                }
                let current_owner = KnowledgeOwner::from(self.scope());
                let current: BTreeSet<_> = records
                    .iter()
                    .filter(|record| record.owner == current_owner)
                    .map(|record| record.id.clone())
                    .collect();
                // A current explicit selection, including disabled state, supersedes
                // its old reference in this view. The original row is never rewritten.
                records.retain(|record| {
                    record.owner == current_owner || !current.contains(&record.id)
                });
                let fingerprint = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&(
                        "native-knowledge-adoptions/2",
                        self.scope(),
                        stores
                            .iter()
                            .map(|store| &store.binding)
                            .collect::<Vec<_>>(),
                        &proofs,
                        revision,
                        parameters.include_candidates,
                        "current-source-read-and-use",
                    ))?)
                );
                if let Some((expected, _)) = cursor {
                    ensure!(expected == fingerprint, "KNOWLEDGE_INVALID_CURSOR");
                }
                let mut allowed = Vec::new();
                for adoption in records {
                    ensure!(!cancel.is_cancelled(), "KNOWLEDGE_POLICY_UNAVAILABLE");
                    let owner = &adoption.publication_owner;
                    if owner.organization_id != self.scope().organization_id
                        && !legacy::same_profile_owner(owner, self.scope())
                    {
                        continue;
                    }
                    let resource = KnowledgeResource {
                        kind: "publication",
                        id: adoption.publication_id.clone(),
                        owner: owner.clone(),
                    };
                    let mut visible = true;
                    for action in ["knowledge.read", "knowledge.adopt"] {
                        match organization_policy::current_revision(&self.native, action, &resource)
                        {
                            Ok(Some(_)) => {}
                            Err(error) if error.to_string() == "ORGANIZATION_RESOURCE_DENIED" => {
                                visible = false;
                                break;
                            }
                            _ => anyhow::bail!("KNOWLEDGE_POLICY_UNAVAILABLE"),
                        }
                        if let Some(delegate) = &self.policy {
                            let result =
                                delegate.evaluate_action(self.scope(), action, &resource)?;
                            ensure!(
                                result.decision != IntegrationPolicyDecision::Unknown,
                                "KNOWLEDGE_POLICY_UNAVAILABLE"
                            );
                            if result.decision != IntegrationPolicyDecision::Allow {
                                visible = false;
                                break;
                            }
                        }
                    }
                    if visible {
                        allowed.push(adoption);
                    }
                }
                allowed.sort_by(|left, right| left.id.cmp(&right.id));
                let mut visible: Vec<_> = allowed
                    .into_iter()
                    .filter(|record| cursor.is_none_or(|(_, last)| record.id.as_str() > last))
                    .take(11)
                    .collect();
                let more = visible.len() > 10;
                visible.truncate(10);
                let next =
                    more.then(|| format!("ka2.{fingerprint}.{}", visible.last().unwrap().id));
                for (store, expected) in stores.iter().zip(&proofs) {
                    store.verify(&self.native)?;
                    let proof = store
                        .directory
                        .try_sqlite_source_read_lease(
                            OsStr::new(DB),
                            CatalogReadLimits::default().source_bytes,
                        )?
                        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))?;
                    ensure!(
                        proof.identity_sha256()? == *expected,
                        "KNOWLEDGE_INVALID_CURSOR"
                    );
                }
                let mut observed = Vec::new();
                if let Some(store) = self.observe_publications()? {
                    observed.push(store);
                }
                if let Some(store) = legacy::observe_directory(self)? {
                    observed.push(store);
                }
                ensure!(
                    observed
                        .iter()
                        .map(|store| &store.binding)
                        .eq(stores.iter().map(|store| &store.binding))
                        && self.native.organization_policy_revision()? == revision,
                    "KNOWLEDGE_INVALID_CURSOR"
                );
                Ok((json!({"page":{"items":visible,"nextCursor":next}}), None))
            },
        )
    }
}
