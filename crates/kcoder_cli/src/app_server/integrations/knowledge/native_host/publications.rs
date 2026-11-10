use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{
    KnowledgeCatalog,
    integrations::knowledge::{CatalogReadLimits, PublicationSourceResolver},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[cfg(test)]
use kcoder_knowledge_rpc::publication_reader::original_owned_wiki_scope;
use kcoder_knowledge_rpc::publication_reader::{BINDING, Binding, DB, LOCK, OBJECTS, read_binding};
pub(crate) use kcoder_knowledge_rpc::publication_reader::{
    ExistingProfileWikiResolver, NativeWikiPublicationResolver, run_shared_publication_read_helper,
};

struct Resolver<'a> {
    native: &'a NativeIntegrationContext,
    resolver: &'a dyn NativeWikiPublicationResolver,
    cancel: &'a CancellationToken,
}
impl PublicationSourceResolver for Resolver<'_> {
    fn resolve_fixed_pages(
        &self,
        scope: &IntegrationScope,
        sources: &[PublicationSource],
    ) -> Result<Vec<PublishedKnowledgePage>> {
        self.native.validate_scope(scope)?;
        let pages = self
            .resolver
            .resolve_fixed_pages(self.native, sources, self.cancel)?;
        self.native.validate_scope(scope)?;
        Ok(pages)
    }
}

pub(super) struct NativePublications {
    guard: NativeDomainGuard,
    directory: PrivateDirectory,
    binding: Binding,
    binding_anchor: File,
    database_anchor: File,
    lock_anchor: File,
    objects_anchor: PrivateDirectory,
}
impl NativePublications {
    pub(super) fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        let directory = self.guard.directory(native.profile()?)?;
        ensure!(
            self.binding.version == 1
                && (self.binding.owner == KnowledgeOwner::from(native.scope())
                    || legacy::held_legacy_owner(self, native.scope())?)
                && directory.directory_identity()? == self.binding.namespace_identity
                && self.directory.directory_identity()? == self.binding.namespace_identity,
            "KNOWLEDGE_NATIVE_NAMESPACE_CHANGED"
        );
        for (name, anchor, expected) in [
            (
                BINDING,
                &self.binding_anchor,
                &self.binding.binding_identity,
            ),
            (DB, &self.database_anchor, &self.binding.database_identity),
            (LOCK, &self.lock_anchor, &self.binding.lock_identity),
        ] {
            ensure!(
                self.directory.portable_regular_handle_identity(anchor)? == *expected
                    && self.directory.portable_regular_identity(OsStr::new(name))? == *expected,
                "KNOWLEDGE_NATIVE_DATABASE_CHANGED"
            );
        }
        let current: Binding = read_binding(&self.directory)?;
        ensure!(current == self.binding, "KNOWLEDGE_NATIVE_BINDING_CHANGED");
        ensure!(
            self.objects_anchor.directory_identity()? == self.binding.objects_identity
                && directory
                    .open_child(OsStr::new(OBJECTS), false)?
                    .directory_identity()?
                    == self.binding.objects_identity,
            "KNOWLEDGE_NATIVE_OBJECTS_CHANGED"
        );
        self.objects_anchor.verify_private_directory()?;
        Ok(())
    }
    pub(super) fn allows_legacy_read(
        &self,
        native: &NativeIntegrationContext,
        owner: &KnowledgeOwner,
    ) -> Result<bool> {
        self.verify(native)?;
        Ok(&self.binding.owner == owner && legacy::held_legacy_owner(self, native.scope())?)
    }
    fn objects_path(&self, native: &NativeIntegrationContext) -> Result<PathBuf> {
        self.verify(native)?;
        Ok(native
            .profile_path()?
            .join(self.guard.namespace_id())
            .join(OBJECTS))
    }
}

impl NativeKnowledgeHost {
    fn observe_publications(&self) -> Result<Option<NativePublications>> {
        let Some(guard) = NativeDomainGuard::observe(
            self.native.profile()?,
            self.scope(),
            NativeDomain::Knowledge,
        )?
        else {
            return Ok(None);
        };
        self.open_publications_guard(guard).map(Some)
    }
    fn open_publications_guard(&self, guard: NativeDomainGuard) -> Result<NativePublications> {
        let directory = guard.directory(self.native.profile()?)?;
        let binding = read_binding(&directory)?;
        let binding_anchor = directory.open_single_link_regular_file(OsStr::new(BINDING))?;
        let database_anchor = directory.open_single_link_regular_file(OsStr::new(DB))?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let objects_anchor = directory.open_child(OsStr::new(OBJECTS), false)?;
        let store = NativePublications {
            guard,
            directory,
            binding,
            binding_anchor,
            database_anchor,
            lock_anchor,
            objects_anchor,
        };
        store.verify(&self.native)?;
        Ok(store)
    }
    fn initialize_publications(&self, operation: &str) -> Result<NativePublications> {
        let namespace =
            NativeDomainGuard::expected_namespace_id(self.scope(), NativeDomain::Knowledge)?;
        let objects_path = self.native.profile_path()?.join(&namespace).join(OBJECTS);
        let (
            guard,
            (directory, binding, binding_anchor, database_anchor, lock_anchor, objects_anchor),
        ) = NativeDomainGuard::initialize(
            self.native.profile()?,
            self.scope(),
            NativeDomain::Knowledge,
            operation,
            |directory| {
                let database_anchor = directory.open_read_write_file(OsStr::new(DB), true)?;
                database_anchor.sync_all()?;
                let lock_anchor = directory.open_read_write_file(OsStr::new(LOCK), true)?;
                lock_anchor.sync_all()?;
                let objects_anchor = directory.create_private_child(OsStr::new(OBJECTS))?;
                let mut binding_anchor =
                    directory.open_read_write_file(OsStr::new(BINDING), true)?;
                let binding = Binding {
                    version: 1,
                    owner: self.scope().into(),
                    namespace_identity: directory.directory_identity()?,
                    binding_identity: directory
                        .portable_regular_handle_identity(&binding_anchor)?,
                    database_identity: directory
                        .portable_regular_handle_identity(&database_anchor)?,
                    lock_identity: directory.portable_regular_handle_identity(&lock_anchor)?,
                    objects_identity: objects_anchor.directory_identity()?,
                };
                let owned = KnowledgeCatalog::open_native_owned(
                    directory,
                    &binding.database_identity,
                    &binding.lock_identity,
                    &objects_path,
                    true,
                )?;
                owned.with_catalog(|catalog| catalog.initialize_native_publication_schema())?;
                binding_anchor.write_all(&serde_json::to_vec(&binding)?)?;
                binding_anchor.sync_all()?;
                directory.sync()?;
                Ok((
                    directory.duplicate_handle()?,
                    binding,
                    binding_anchor,
                    database_anchor,
                    lock_anchor,
                    objects_anchor,
                ))
            },
        )?;
        let store = NativePublications {
            guard,
            directory,
            binding,
            binding_anchor,
            database_anchor,
            lock_anchor,
            objects_anchor,
        };
        store.verify(&self.native)?;
        Ok(store)
    }
    fn publication_policy<'a>(&'a self, store: Option<&'a NativePublications>) -> NativePolicy<'a> {
        NativePolicy {
            native: &self.native,
            automation: None,
            publications: store,
            delegate: self.policy.as_deref(),
        }
    }

    pub(crate) fn knowledge(
        &self,
        method: &str,
        request: &IntegrationRequest,
        explicit_user_action: bool,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> IntegrationReply {
        const READS: &[&str] = &[
            "listPublications",
            "listPublicationHistory",
            "listAdoptions",
            "resolvePublication",
            "retrieveKnowledge",
            "readCitation",
            "readPublicationSources",
        ];
        const WRITES: &[&str] = &[
            "publishKnowledge",
            "revokePublication",
            "adoptPublication",
            "setAdoptionEnabled",
        ];
        let mutation = WRITES.contains(&method);
        if !self.settings.publications_enabled || (!mutation && !READS.contains(&method)) {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Unavailable,
                "KNOWLEDGE_NATIVE_FEATURE_UNAVAILABLE",
                IntegrationRecovery::RepairConfiguration,
            );
        }
        if self.validate_native_request(request, mutation).is_err() {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Rejected,
                "KNOWLEDGE_CALLER_SCOPE_MISMATCH",
                IntegrationRecovery::RequestAuthorization,
            );
        }
        if mutation && !explicit_user_action {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Rejected,
                "KNOWLEDGE_EXPLICIT_REQUEST_REQUIRED",
                IntegrationRecovery::ExplicitUserDecision,
            );
        }
        if method == "readPublicationSources" {
            return self.publication_source_states(request, now_ms, cancel);
        }
        if method == "listPublications" {
            return self.publication_directory(request, now_ms, cancel);
        }
        if method == "listAdoptions" && self.scope().organization_id.is_some() {
            return self.adoption_directory(request, now_ms, cancel);
        }
        if matches!(method, "resolvePublication" | "readCitation")
            && let Some(reply) = self.shared_read_dispatch(method, request, now_ms, cancel)
        {
            return reply;
        }
        if method == "adoptPublication"
            && let Some(reply) = self.shared_adopt_dispatch(request, now_ms, cancel)
        {
            return reply;
        }
        if method == "retrieveKnowledge"
            && let Some(reply) = self.shared_query_dispatch(request, now_ms, cancel)
        {
            return reply;
        }
        if method == "setAdoptionEnabled"
            && let Some(reply) = self.shared_enable_dispatch(request, now_ms, cancel)
        {
            return reply;
        }
        let mut store = match legacy::observe_explicit_read(self, method, request) {
            Ok(store) => store,
            Err(_) => {
                return self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Unavailable,
                    "KNOWLEDGE_NATIVE_STORE_UNAVAILABLE",
                    IntegrationRecovery::RepairConfiguration,
                );
            }
        };
        let mut resolved = None;
        if method == "publishKnowledge" {
            let Some(resolver) = self.wiki.as_deref() else {
                return self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Unavailable,
                    "KNOWLEDGE_SOURCE_UNAVAILABLE",
                    IntegrationRecovery::RepairConfiguration,
                );
            };
            let preflight = (|| -> Result<_> {
                let parameters:kcoder_app_protocol::integrations::knowledge::KnowledgePublishParams=super::super::api::parse(request)?;
                let policy = self.publication_policy(store.as_ref());
                let own = KnowledgeResource {
                    kind: "publication",
                    id: parameters.draft.publication_id.clone(),
                    owner: self.scope().into(),
                };
                let context = KnowledgeHostContext {
                    scope: self.scope(),
                    now_ms,
                    explicit_user_action,
                    policy: &policy,
                };
                context.check(request, true, "knowledge.publish", &own)?;
                if parameters.draft.visibility != KnowledgeVisibility::Personal {
                    let audience = KnowledgeResource {
                        kind: "knowledge-audience",
                        id: serde_json::to_string(&(
                            &parameters.draft.visibility,
                            &parameters.draft.audience_id,
                        ))?,
                        owner: self.scope().into(),
                    };
                    context.check(request, true, "knowledge.share", &audience)?;
                }
                KnowledgeCatalog::resolve_publication_sources(
                    self.scope(),
                    &parameters.draft,
                    &Resolver {
                        native: &self.native,
                        resolver,
                        cancel,
                    },
                )
            })();
            resolved = match preflight {
                Ok(proof) => Some(proof),
                Err(_) => {
                    return self.reply_failure(
                        request,
                        now_ms,
                        IntegrationStatus::Unavailable,
                        "KNOWLEDGE_SOURCE_UNAVAILABLE",
                        IntegrationRecovery::RequestAuthorization,
                    );
                }
            };
            if store.is_none() {
                if !matches!(super::super::api::revision(request, true), Ok(0)) {
                    return self.reply_failure(
                        request,
                        now_ms,
                        IntegrationStatus::Rejected,
                        "KNOWLEDGE_PUBLICATION_REVISION_CONFLICT",
                        IntegrationRecovery::RetryRead,
                    );
                }
                store = match self
                    .initialize_publications(request.operation_id.as_deref().unwrap_or_default())
                {
                    Ok(store) => Some(store),
                    Err(_) => {
                        return self.reply_failure(
                            request,
                            now_ms,
                            IntegrationStatus::Unknown,
                            "KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED",
                            IntegrationRecovery::ReconcileOriginal,
                        );
                    }
                };
            }
        }
        let Some(store) = store else {
            if matches!(
                method,
                "listPublications" | "listPublicationHistory" | "listAdoptions"
            ) {
                let policy = self.publication_policy(None);
                let context = KnowledgeHostContext {
                    scope: self.scope(),
                    now_ms,
                    explicit_user_action: false,
                    policy: &policy,
                };
                return super::super::api::dispatch(
                    request,
                    &context,
                    false,
                    "knowledge.read",
                    KnowledgeResource {
                        kind: "knowledge",
                        id: "publications".into(),
                        owner: self.scope().into(),
                    },
                    || Ok((json!({"page":{"items":[],"nextCursor":null}}), None)),
                );
            }
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Unavailable,
                "KNOWLEDGE_PUBLICATION_NOT_INITIALIZED",
                IntegrationRecovery::RepairConfiguration,
            );
        };
        let result = (|| -> Result<IntegrationReply> {
            store.verify(&self.native)?;
            let policy = self.publication_policy(Some(&store));
            let context = KnowledgeHostContext {
                scope: self.scope(),
                now_ms,
                explicit_user_action,
                policy: &policy,
            };
            let execute = |catalog: &mut KnowledgeCatalog| {
                Ok(
                    super::super::publication_api::handle_publication_with_sources(
                        method,
                        request,
                        &context,
                        catalog,
                        resolved.as_ref(),
                    ),
                )
            };
            let reply = if mutation {
                KnowledgeCatalog::open_native_owned(
                    &store.directory,
                    &store.binding.database_identity,
                    &store.binding.lock_identity,
                    &store.objects_path(&self.native)?,
                    false,
                )?
                .with_catalog(execute)?
            } else {
                KnowledgeCatalog::open_existing_native_owned(
                    &store.directory,
                    &store.binding.database_identity,
                    &store.binding.lock_identity,
                    &store.objects_path(&self.native)?,
                    cancel,
                    CatalogReadLimits::default(),
                )?
                .with_catalog(execute)?
                .0
            };
            store.verify(&self.native)?;
            Ok(reply)
        })();
        match result {
            Ok(reply) => reply,
            Err(_) => self.reply_failure(
                request,
                now_ms,
                if mutation {
                    IntegrationStatus::Unknown
                } else {
                    IntegrationStatus::Unavailable
                },
                if mutation {
                    "KNOWLEDGE_PUBLICATION_WRITE_UNCONFIRMED"
                } else {
                    "KNOWLEDGE_NATIVE_STORE_UNAVAILABLE"
                },
                if mutation {
                    IntegrationRecovery::ReconcileOriginal
                } else {
                    IntegrationRecovery::RepairConfiguration
                },
            ),
        }
    }

    fn publication_source_states(
        &self,
        request: &IntegrationRequest,
        now_ms: u64,
        cancel: &CancellationToken,
    ) -> IntegrationReply {
        use sha2::{Digest, Sha256};
        let parameters: kcoder_app_protocol::integrations::knowledge::PublicationSourcesReadParams =
            match super::super::api::parse(request) {
                Ok(value) => value,
                Err(_) => {
                    return self.reply_failure(
                        request,
                        now_ms,
                        IntegrationStatus::Rejected,
                        "KNOWLEDGE_INVALID_PAYLOAD",
                        IntegrationRecovery::None,
                    );
                }
            };
        if parameters.version == 0 {
            return self.reply_failure(
                request,
                now_ms,
                IntegrationStatus::Rejected,
                "KNOWLEDGE_INVALID_PAYLOAD",
                IntegrationRecovery::None,
            );
        }
        let mut read = request.clone();
        read.payload=json!({"owner":parameters.owner,"publicationId":parameters.publication_id,"version":parameters.version}).as_object().unwrap().clone();
        let before = self.knowledge("resolvePublication", &read, false, now_ms, cancel);
        if before.status != IntegrationStatus::Completed {
            return before;
        }
        let publication: KnowledgePublication = match before
            .result
            .as_ref()
            .and_then(|result| result.get("publication"))
            .cloned()
            .map(serde_json::from_value)
            .transpose()
        {
            Ok(Some(value)) => value,
            _ => {
                return self.reply_failure(
                    request,
                    now_ms,
                    IntegrationStatus::Unavailable,
                    "KNOWLEDGE_NATIVE_STORE_UNAVAILABLE",
                    IntegrationRecovery::RetryRead,
                );
            }
        };
        let key = |source: &PublicationSource| -> Result<String> {
            Ok(format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    self.scope(),
                    &publication.owner,
                    &publication.draft.publication_id,
                    publication.version,
                    source
                ))?)
            ))
        };
        let result = (|| -> Result<_> {
            let start = if let Some(after) = parameters.after.as_deref() {
                publication
                    .draft
                    .sources
                    .iter()
                    .map(&key)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .position(|cursor| cursor == after)
                    .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_CURSOR"))?
                    + 1
            } else {
                0
            };
            let end = publication
                .draft
                .sources
                .len()
                .min(start.saturating_add(10));
            let selected = &publication.draft.sources[start..end];
            let provider = self
                .wiki
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SOURCE_UNAVAILABLE"))?;
            let items = provider.observe_fixed_sources(&self.native, selected, cancel, now_ms)?;
            ensure!(
                items.len() == selected.len()
                    && items
                        .iter()
                        .zip(selected)
                        .all(|(item, source)| &item.source == source),
                "KNOWLEDGE_NATIVE_SOURCE_MISMATCH"
            );
            let next_cursor = if end < publication.draft.sources.len() {
                Some(key(&publication.draft.sources[end - 1])?)
            } else {
                None
            };
            Ok(json!({"page":{"items":items,"nextCursor":next_cursor}}))
        })();
        let result = match result {
            Ok(value) => value,
            Err(error) => {
                return self.reply_failure(
                    request,
                    now_ms,
                    if error.to_string() == "KNOWLEDGE_INVALID_CURSOR" {
                        IntegrationStatus::Rejected
                    } else {
                        IntegrationStatus::Unavailable
                    },
                    if error.to_string() == "KNOWLEDGE_INVALID_CURSOR" {
                        "KNOWLEDGE_INVALID_CURSOR"
                    } else {
                        "KNOWLEDGE_SOURCE_UNAVAILABLE"
                    },
                    IntegrationRecovery::RetryRead,
                );
            }
        };
        let after = self.knowledge("resolvePublication", &read, false, now_ms, cancel);
        if after.status != IntegrationStatus::Completed {
            return after;
        }
        let policy = self.publication_policy(None);
        let context = KnowledgeHostContext {
            scope: self.scope(),
            now_ms,
            explicit_user_action: false,
            policy: &policy,
        };
        super::super::api::reply(
            request,
            &context,
            IntegrationStatus::Completed,
            result.as_object().cloned(),
            None,
            None,
        )
    }
}

mod adoption_directory;
mod directory;
mod legacy;
mod organization_directory;
mod remote_directory;
mod shared_adoptions;
mod shared_bridge;
mod shared_query;
#[cfg(test)]
mod tests;
