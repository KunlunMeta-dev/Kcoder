//! One observed directory over the current and original personal catalogs; no data migration.
use super::*;
use kcoder_config::PrivateLeaseMode;
use kcoder_knowledge::integrations::knowledge::{PublicationAccess, PublicationAction};
use sha2::{Digest, Sha256};

pub(super) struct DirectoryAccess<'a> {
    pub(super) host: &'a NativeKnowledgeHost,
    pub(super) store: &'a NativePublications,
}
impl PublicationAccess for DirectoryAccess<'_> {
    fn check(
        &self,
        scope: &IntegrationScope,
        owner: &KnowledgeOwner,
        id: &str,
        action: PublicationAction,
    ) -> Result<bool> {
        ensure!(
            matches!(action, PublicationAction::Read),
            "KNOWLEDGE_RESOURCE_DENIED"
        );
        let policy = self.host.publication_policy(Some(self.store));
        let resource = KnowledgeResource {
            kind: "publication",
            id: id.into(),
            owner: owner.clone(),
        };
        match policy.evaluate_action(scope, "knowledge.read", &resource) {
            Ok(result) => {
                ensure!(
                    result.decision != IntegrationPolicyDecision::Unknown,
                    "KNOWLEDGE_POLICY_UNAVAILABLE"
                );
                Ok(result.decision == IntegrationPolicyDecision::Allow)
            }
            // A current authoritative denial filters this row. Transport, identity,
            // storage and unknown-policy failures must never masquerade as an empty page.
            Err(error) if error.to_string() == "ORGANIZATION_RESOURCE_DENIED" => Ok(false),
            Err(_) => anyhow::bail!("KNOWLEDGE_POLICY_UNAVAILABLE"),
        }
    }
}

fn cursor_parts(after: Option<&str>) -> Result<Option<(&str, &str)>> {
    let Some(after) = after else { return Ok(None) };
    let parts: Vec<_> = after.split('.').collect();
    ensure!(
        parts.len() == 3
            && parts[0] == "kd1"
            && parts[1..].iter().all(|part| part.len() == 64
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())),
        "KNOWLEDGE_INVALID_CURSOR"
    );
    Ok(Some((parts[1], parts[2])))
}

impl NativeKnowledgeHost {
    pub(super) fn publication_directory(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> IntegrationReply {
        if matches!(
            self.scope().organization_id,
            Some(IntegrationNullable::Value(_))
        ) {
            return self.organization_publication_directory(request, now_ms, cancel);
        }
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
                let cursor = cursor_parts(parameters.after.as_deref())?;
                let revision = self.native.organization_policy_revision()?;
                let mut stores = Vec::new();
                let unavailable = |_| {
                    anyhow::anyhow!(if cursor.is_some() {
                        "KNOWLEDGE_INVALID_CURSOR"
                    } else {
                        "KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"
                    })
                };
                if let Some(store) = self.observe_publications().map_err(unavailable)? {
                    stores.push(store);
                }
                if let Some(store) = legacy::observe_directory(self).map_err(unavailable)? {
                    stores.push(store);
                }
                // Retain both original namespace locks through merge and final verification.
                let _leases = stores
                    .iter()
                    .map(|store| {
                        store
                            .directory
                            .try_existing_portable_lock(
                                OsStr::new(LOCK),
                                &store.binding.lock_identity,
                                PrivateLeaseMode::Shared,
                            )?
                            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let mut pages = Vec::new();
                let mut revisions = Vec::new();
                let mut epochs = Vec::new();
                for store in &stores {
                    store.verify(&self.native).map_err(unavailable)?;
                    let access = DirectoryAccess { host: self, store };
                    let ((page, epoch), proof) = KnowledgeCatalog::open_existing_native_owned(
                        &store.directory,
                        &store.binding.database_identity,
                        &store.binding.lock_identity,
                        &store.objects_path(&self.native)?,
                        cancel,
                        CatalogReadLimits::default(),
                    )
                    .map_err(unavailable)?
                    .with_catalog(|catalog| {
                        Ok((
                            catalog.list_publications(
                                self.scope(),
                                &access,
                                cursor.map(|(_, key)| key),
                                now_ms,
                            )?,
                            catalog.publication_listing_time_epoch(now_ms)?,
                        ))
                    })
                    .map_err(|error| {
                        if error.to_string() == "KNOWLEDGE_POLICY_UNAVAILABLE" {
                            error
                        } else {
                            unavailable(error)
                        }
                    })?;
                    pages.push(page);
                    revisions.push(proof.source_identity_sha256);
                    epochs.push(epoch);
                }
                let fingerprint = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&(
                        "native-knowledge-directory/1",
                        self.scope(),
                        stores
                            .iter()
                            .map(|store| &store.binding)
                            .collect::<Vec<_>>(),
                        &revisions,
                        &epochs,
                        revision,
                        parameters.include_candidates,
                        "current-readable-latest-effective",
                    ))?)
                );
                if let Some((expected, _)) = cursor {
                    ensure!(expected == fingerprint, "KNOWLEDGE_INVALID_CURSOR");
                }
                let frontier = pages
                    .iter()
                    .filter_map(|page| page.next_cursor.as_deref())
                    .min();
                let mut candidates = Vec::new();
                for (index, page) in pages.iter().enumerate() {
                    for item in &page.items {
                        candidates.push((
                            KnowledgeCatalog::publication_listing_cursor(
                                &item.owner,
                                &item.draft.publication_id,
                            )?,
                            index,
                            item,
                        ));
                    }
                }
                candidates.sort_by(|left, right| left.0.cmp(&right.0));
                ensure!(
                    candidates.windows(2).all(|pair| pair[0].0 != pair[1].0),
                    "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
                );
                let mut items = Vec::new();
                let mut bytes = 0usize;
                let mut last = None;
                for (key, index, item) in &candidates {
                    let encoded = serde_json::to_vec(item)?.len();
                    if frontier.is_some_and(|bound| key.as_str() > bound)
                        || items.len() == 10
                        || bytes.saturating_add(encoded) > 768 * 1024 - 4096
                    {
                        break;
                    }
                    ensure!(
                        DirectoryAccess {
                            host: self,
                            store: &stores[*index]
                        }
                        .check(
                            self.scope(),
                            &item.owner,
                            &item.draft.publication_id,
                            PublicationAction::Read
                        )?,
                        "KNOWLEDGE_RESOURCE_DENIED"
                    );
                    items.push(*item);
                    bytes += encoded;
                    last = Some(key.as_str());
                }
                let more = frontier.is_some() || items.len() < candidates.len();
                let next = if more {
                    Some(format!(
                        "kd1.{fingerprint}.{}",
                        last.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_TOO_LARGE"))?
                    ))
                } else {
                    None
                };
                for (store, expected) in stores.iter().zip(&revisions) {
                    store.verify(&self.native).map_err(unavailable)?;
                    let source = store
                        .directory
                        .try_sqlite_source_read_lease(
                            OsStr::new(DB),
                            CatalogReadLimits::default().source_bytes,
                        )
                        .map_err(unavailable)?
                        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"))?;
                    ensure!(
                        &source.identity_sha256().map_err(unavailable)? == expected,
                        "KNOWLEDGE_INVALID_CURSOR"
                    );
                }
                // Observe absent members again as well: an initialization in the other
                // namespace must invalidate this page rather than silently join its next page.
                let mut observed = Vec::new();
                if let Some(store) = self.observe_publications().map_err(unavailable)? {
                    observed.push(store);
                }
                if let Some(store) = legacy::observe_directory(self).map_err(unavailable)? {
                    observed.push(store);
                }
                ensure!(
                    observed
                        .iter()
                        .map(|store| &store.binding)
                        .eq(stores.iter().map(|store| &store.binding)),
                    "KNOWLEDGE_INVALID_CURSOR"
                );
                ensure!(
                    self.native.organization_policy_revision()? == revision,
                    "KNOWLEDGE_INVALID_CURSOR"
                );
                Ok((json!({"page":{"items":items,"nextCursor":next}}), None))
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merged_cursor_requires_version_and_two_exact_bounded_lowercase_digests() -> Result<()> {
        let valid = format!("kd1.{}.{}", "a".repeat(64), "b".repeat(64));
        assert_eq!(
            cursor_parts(Some(&valid))?,
            Some(("a".repeat(64).as_str(), "b".repeat(64).as_str()))
        );
        for invalid in [
            "old-library-key".into(),
            format!("kd1.{}.{}", "A".repeat(64), "b".repeat(64)),
            format!("kd1.{}.{}", "a".repeat(65), "b".repeat(64)),
            format!("kd1.{}.{}.extra", "a".repeat(64), "b".repeat(64)),
        ] {
            assert!(cursor_parts(Some(&invalid)).is_err());
        }
        Ok(())
    }
}
