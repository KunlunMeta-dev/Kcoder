//! One source-bound directory over original local, legacy and publisher-owned namespaces.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
enum Origin {
    Local(usize),
    Remote(usize),
}
struct Group {
    key: String,
    origin: Origin,
    has_items: bool,
}

fn cursor(raw: Option<&str>) -> Result<Option<(&str, &str, &str)>> {
    let Some(raw) = raw else { return Ok(None) };
    let fields: Vec<_> = raw.split('.').collect();
    ensure!(
        fields.len() == 4
            && fields[0] == "kd2"
            && fields[1..].iter().all(|field| field.len() == 64
                && field
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())),
        "KNOWLEDGE_INVALID_CURSOR"
    );
    Ok(Some((fields[1], fields[2], fields[3])))
}

impl NativeKnowledgeHost {
    pub(super) fn organization_publication_directory(
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
                let cursor = cursor(parameters.after.as_deref())?;
                let revision = self.native.organization_policy_revision()?;
                let remote = remote_directory::Snapshot::capture(self, request, cancel).map_err(
                    |error| {
                        if cursor.is_some() {
                            anyhow::anyhow!("KNOWLEDGE_INVALID_CURSOR")
                        } else {
                            error
                        }
                    },
                )?;
                let mut stores = Vec::new();
                if let Some(store) = self.observe_publications()? {
                    stores.push(store);
                }
                if let Some(store) = legacy::observe_directory(self)? {
                    stores.push(store);
                }
                let mut pages = Vec::new();
                let mut proofs = Vec::new();
                let mut epochs = Vec::new();
                let mut deadline = remote.next_transition_ms;
                let mut groups = Vec::new();
                for (index, store) in stores.iter().enumerate() {
                    store.verify(&self.native)?;
                    let key = remote_directory::group_key(&store.binding.owner)?;
                    let access = super::directory::DirectoryAccess { host: self, store };
                    let now = u64::try_from(chrono::Utc::now().timestamp_millis())?;
                    let after = cursor
                        .filter(|(_, group, _)| *group == key)
                        .map(|(_, _, after)| after);
                    let ((page, epoch, next), proof) =
                        KnowledgeCatalog::open_existing_native_owned(
                            &store.directory,
                            &store.binding.database_identity,
                            &store.binding.lock_identity,
                            &store.objects_path(&self.native)?,
                            cancel,
                            CatalogReadLimits::default(),
                        )?
                        .with_catalog(|catalog| {
                            let page =
                                catalog.list_publications(self.scope(), &access, after, now)?;
                            let (epoch, next) = catalog.publication_listing_time_snapshot(now)?;
                            Ok((page, epoch, next))
                        })?;
                    if let Some(next) = next {
                        deadline = Some(deadline.map_or(next, |old| old.min(next)));
                    }
                    groups.push(Group {
                        key,
                        origin: Origin::Local(index),
                        has_items: !page.items.is_empty(),
                    });
                    pages.push(page);
                    proofs.push(proof.source_identity_sha256);
                    epochs.push(epoch);
                }
                for (index, source) in remote.groups.iter().enumerate() {
                    groups.push(Group {
                        key: remote_directory::group_key(&source.owner)?,
                        origin: Origin::Remote(index),
                        has_items: source.source["hasItems"] == true,
                    });
                }
                groups.sort_by(|left, right| left.key.cmp(&right.key));
                ensure!(
                    groups.windows(2).all(|pair| pair[0].key != pair[1].key),
                    "KNOWLEDGE_PUBLICATION_IDENTITY_MISMATCH"
                );
                let fingerprint = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&(
                        "native-organization-knowledge-directory/2",
                        self.scope(),
                        revision,
                        &remote.fingerprint,
                        stores
                            .iter()
                            .map(|store| &store.binding)
                            .collect::<Vec<_>>(),
                        &proofs,
                        &epochs,
                        parameters.include_candidates,
                        "shared-finalized-current-read",
                    ))?)
                );
                if let Some((expected, _, _)) = cursor {
                    ensure!(expected == fingerprint, "KNOWLEDGE_INVALID_CURSOR");
                }
                let mut items = Vec::new();
                let mut bytes = 0usize;
                let mut last = None;
                let mut more = false;
                for (position, group) in groups.iter().enumerate() {
                    if cursor.is_some_and(|(_, after, _)| group.key.as_str() < after)
                        || !group.has_items
                    {
                        continue;
                    }
                    let remote_page;
                    let page = match group.origin {
                        Origin::Local(index) => &pages[index],
                        Origin::Remote(index) => {
                            let after = cursor
                                .filter(|(_, key, _)| *key == group.key)
                                .map(|(_, _, after)| after);
                            remote_page =
                                remote.page(self, request, &remote.groups[index], after, cancel)?;
                            &remote_page
                        }
                    };
                    for item in &page.items {
                        let encoded = serde_json::to_vec(item)?.len();
                        if items.len() == 10 || bytes.saturating_add(encoded) > 768 * 1024 - 4096 {
                            more = true;
                            break;
                        }
                        last = Some((
                            group.key.clone(),
                            KnowledgeCatalog::publication_listing_cursor(
                                &item.owner,
                                &item.draft.publication_id,
                            )?,
                        ));
                        bytes += encoded;
                        items.push(item.clone());
                    }
                    if more || page.next_cursor.is_some() {
                        more = true;
                        break;
                    }
                    if items.len() == 10 {
                        more = groups[position + 1..].iter().any(|next| next.has_items);
                        break;
                    }
                }
                let next = if more {
                    let (group, last) =
                        last.ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_PUBLICATION_TOO_LARGE"))?;
                    Some(format!("kd2.{fingerprint}.{group}.{last}"))
                } else {
                    None
                };
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
                let mut current = Vec::new();
                if let Some(store) = self.observe_publications()? {
                    current.push(store);
                }
                if let Some(store) = legacy::observe_directory(self)? {
                    current.push(store);
                }
                ensure!(
                    current
                        .iter()
                        .map(|store| &store.binding)
                        .eq(stores.iter().map(|store| &store.binding)),
                    "KNOWLEDGE_INVALID_CURSOR"
                );
                remote.verify(self, request)?;
                ensure!(
                    self.native.organization_policy_revision()? == revision
                        && deadline.is_none_or(|time| u64::try_from(
                            chrono::Utc::now().timestamp_millis()
                        )
                        .is_ok_and(|now| now < time)),
                    "KNOWLEDGE_INVALID_CURSOR"
                );
                Ok((json!({"page":{"items":items,"nextCursor":next}}), None))
            },
        )
    }
}
