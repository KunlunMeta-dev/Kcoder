use super::*;
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    settings: PathBuf,
    native: NativeIntegrationContext,
}
fn fixture() -> Result<Fixture> {
    let root = tempfile::tempdir()?;
    let parent = PrivateDirectory::open_or_create(root.path())?;
    let profile = parent.create_private_child(OsStr::new("profile"))?;
    parent.create_private_child(OsStr::new("workspace"))?;
    profile.atomic_replace(OsStr::new("settings.json"), b"{}")?;
    let profile_path = root.path().join("profile");
    let settings = profile_path.join("settings.json");
    let native = NativeIntegrationContext::capture(
        &profile_path,
        &root.path().join("workspace"),
        "connection",
        "configuration",
    )?;
    Ok(Fixture {
        _root: root,
        profile: profile_path,
        settings,
        native,
    })
}
fn settings() -> KnowledgeIntegrationSettings {
    KnowledgeIntegrationSettings {
        publications_enabled: true,
        ..Default::default()
    }
}
fn request(
    host: &NativeKnowledgeHost,
    operation: Option<&str>,
    revision: Option<u64>,
    payload: Value,
) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: uuid::Uuid::new_v4().to_string(),
        scope: host.scope().clone(),
        operation_id: operation.map(str::to_owned),
        expected_revision: revision.map(|value| value.to_string()),
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    }
}
fn names(path: &Path) -> Result<Vec<std::ffi::OsString>> {
    let mut names = std::fs::read_dir(path)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()?;
    names.sort();
    Ok(names)
}
fn seed(
    f: &Fixture,
) -> Result<(
    KnowledgeCatalog,
    kcoder_knowledge::KnowledgeScope,
    PublicationDraft,
)> {
    let (profile, legacy) =
        crate::app_server::knowledge_requests::catalog_scope_for_profile(&f.settings)?;
    let root = f
        .native
        .profile()?
        .create_private_child(OsStr::new("knowledge"))?;
    root.verify_private_directory()?;
    let mut source = KnowledgeCatalog::open(&profile.join("knowledge/state.sqlite"))?;
    let wal = rusqlite::Connection::open(profile.join("knowledge/state.sqlite"))?;
    let mode: String = wal.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    assert_eq!(mode, "wal");
    wal.execute_batch("PRAGMA wal_autocheckpoint=0;")?;
    let library = source.create(&legacy, "original-library", "Real original Wiki", "")?;
    let text = "Revision one from the actual existing Wiki.";
    let input = source.import_text(&legacy, &library.id, "original-source", "source.md", text)?;
    let page = source.commit_generated_pages(
        &legacy,
        &library.id,
        "original-page",
        vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "Original fixed page".into(),
            markdown: text.into(),
            citations: vec![KnowledgeCitation {
                source_id: input.source_id,
                revision_id: input.revision_id,
                chunk_id: "chunk-1".into(),
                quote: text.into(),
            }],
            related_page_ids: vec![],
        }],
    )?;
    let draft = PublicationDraft {
        publication_id: "native-publication".into(),
        title: "Native publication".into(),
        purpose: Some("A fixed task source".into()),
        review_conclusion: None,
        visibility: KnowledgeVisibility::Personal,
        audience_id: None,
        sources: vec![PublicationSource {
            library_id: library.id,
            page_id: page[0].page_id.clone(),
            page_revision: page[0].revision_id.clone(),
        }],
        valid_from_ms: None,
        valid_until_ms: None,
        unresolved: vec![],
    };
    Ok((source, legacy, draft))
}

#[test]
fn original_profile_data_scope_reads_only_the_verified_profile_library() -> Result<()> {
    let f = fixture()?;
    let mut catalog = KnowledgeCatalog::open(&f.profile.join("original.sqlite"))?;
    let current = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
        "current-account-principal",
        "execution-host",
    )?;
    let original = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
        &format!("profile:{}", f.profile.display()),
        "execution-host",
    )?;
    let other = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
        &format!("profile:{}", f.profile.join("other-profile").display()),
        "execution-host",
    )?;
    let library = catalog.create(&original, "original", "Original profile Wiki", "")?;
    let other_library = catalog.create(&other, "other", "Other profile Wiki", "")?;
    let selected = original_owned_wiki_scope(&catalog, &current, &f.profile, &library.id)?;
    assert_eq!(catalog.read(&selected, &library.id)?.id, library.id);
    assert!(catalog.read(&current, &library.id).is_err());
    assert_eq!(
        original_owned_wiki_scope(&catalog, &current, &f.profile, &other_library.id)
            .unwrap_err()
            .to_string(),
        "knowledge library not found"
    );
    assert_eq!(catalog.list(&original, None, 10)?.len(), 1);
    assert_eq!(catalog.list(&other, None, 10)?.len(), 1);
    Ok(())
}

#[test]
fn current_account_data_scope_does_not_derive_an_original_profile_scope() -> Result<()> {
    let f = fixture()?;
    let mut catalog = KnowledgeCatalog::open(&f.profile.join("current.sqlite"))?;
    let current = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
        "current-account-principal",
        "execution-host",
    )?;
    let library = catalog.create(&current, "current", "Current account Wiki", "")?;
    let invalid_fallback = PathBuf::from("x".repeat(513));
    let selected = original_owned_wiki_scope(&catalog, &current, &invalid_fallback, &library.id)?;
    assert_eq!(catalog.read(&selected, &library.id)?.id, library.id);
    Ok(())
}

#[test]
fn original_profile_data_scope_preserves_catalog_failures() -> Result<()> {
    let f = fixture()?;
    let path = f.profile.join("invalid-schema.sqlite");
    let catalog = KnowledgeCatalog::open(&path)?;
    let current = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
        "current-account-principal",
        "execution-host",
    )?;
    rusqlite::Connection::open(path)?.execute_batch("DROP TABLE libraries;")?;
    let invalid_fallback = PathBuf::from("x".repeat(513));
    let error =
        original_owned_wiki_scope(&catalog, &current, &invalid_fallback, "library").unwrap_err();
    assert!(error.to_string().contains("no such table"), "{error}");
    Ok(())
}

#[test]
fn native_publication_lists_and_missing_real_source_never_initialize_namespace_or_wiki()
-> Result<()> {
    let f = fixture()?;
    let host = NativeKnowledgeHost::new(&f.native, settings())?;
    let before = names(&f.profile)?;
    let cancel = CancellationToken::new();
    for method in [
        "listPublications",
        "listAdoptions",
        "listPublicationHistory",
    ] {
        let result = host.knowledge(
            method,
            &request(&host, None, None, json!({})),
            false,
            1000,
            &cancel,
        );
        assert_eq!(result.status, IntegrationStatus::Completed);
    }
    assert_eq!(names(&f.profile)?, before);
    assert!(!f.profile.join("knowledge").exists());
    let resolver = ExistingProfileWikiResolver::new(&f.native, &f.settings)?;
    let host = host.with_wiki_resolver(Arc::new(resolver));
    let missing = PublicationDraft {
        publication_id: "missing-publication".into(),
        title: "Unavailable source".into(),
        purpose: Some("Actual source required".into()),
        review_conclusion: None,
        visibility: KnowledgeVisibility::Personal,
        audience_id: None,
        sources: vec![PublicationSource {
            library_id: "not-invented-by-host".into(),
            page_id: "missing-page".into(),
            page_revision: "missing-revision".into(),
        }],
        valid_from_ms: None,
        valid_until_ms: None,
        unresolved: vec![],
    };
    let result = host.knowledge(
        "publishKnowledge",
        &request(&host, Some("publish"), Some(0), json!({"draft":missing})),
        true,
        1000,
        &cancel,
    );
    assert_eq!(result.status, IntegrationStatus::Unavailable);
    assert!(host.observe_publications()?.is_none());
    assert_eq!(names(&f.profile)?, before);
    Ok(())
}

#[test]
fn real_legacy_wiki_scope_publishes_fixed_pages_and_native_store_reopens_without_a_new_library()
-> Result<()> {
    let f = fixture()?;
    let (mut source, legacy, draft) = seed(&f)?;
    let resolver = ExistingProfileWikiResolver::new(&f.native, &f.settings)?;
    let host =
        NativeKnowledgeHost::new(&f.native, settings())?.with_wiki_resolver(Arc::new(resolver));
    let cancel = CancellationToken::new();
    let publish = request(
        &host,
        Some("original-publish"),
        Some(0),
        json!({"draft":draft}),
    );
    assert_eq!(
        host.knowledge("publishKnowledge", &publish, false, 1000, &cancel)
            .status,
        IntegrationStatus::Rejected
    );
    assert!(host.observe_publications()?.is_none());
    let result = host.knowledge("publishKnowledge", &publish, true, 1000, &cancel);
    assert_eq!(
        result.status,
        IntegrationStatus::Completed,
        "{:?}",
        result.error
    );
    let first: KnowledgePublication =
        serde_json::from_value(result.result.as_ref().unwrap()["publication"].clone())?;
    assert_eq!(
        first.pages[0].markdown,
        "Revision one from the actual existing Wiki."
    );
    assert_eq!(first.owner, KnowledgeOwner::from(host.scope()));
    let changed = source.edit_page(
        &legacy,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        &draft.sources[0].page_revision,
        "source-update",
        "New source title",
        "Revision two from the actual existing Wiki.",
    )?;
    let current = source.read_page(
        &legacy,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        None,
    )?;
    assert_eq!(current.revision_id, changed.revision_id);
    let reopened = NativeKnowledgeHost::new(&f.native, settings())?;
    let read = request(
        &reopened,
        None,
        None,
        json!({"owner":first.owner,"publicationId":draft.publication_id,"version":1}),
    );
    let fixed = reopened.knowledge("resolvePublication", &read, false, 2000, &cancel);
    assert_eq!(fixed.status, IntegrationStatus::Completed);
    assert_eq!(
        fixed.result.as_ref().unwrap()["publication"]["pages"][0]["markdown"],
        first.pages[0].markdown
    );
    assert_eq!(source.list(&legacy, None, 10)?.len(), 1);
    let adopted = reopened.knowledge(
        "adoptPublication",
        &request(
            &reopened,
            Some("adopt"),
            Some(0),
            json!({"owner":first.owner,
        "publicationId":draft.publication_id,"version":1}),
        ),
        true,
        2000,
        &cancel,
    );
    assert_eq!(adopted.status, IntegrationStatus::Completed);
    let revoked = reopened.knowledge(
        "revokePublication",
        &request(
            &reopened,
            Some("revoke"),
            Some(1),
            json!({"owner":first.owner,
        "publicationId":draft.publication_id,"version":1}),
        ),
        true,
        3000,
        &cancel,
    );
    assert_eq!(revoked.status, IntegrationStatus::Completed);
    let denied = reopened.knowledge("resolvePublication", &read, false, 3001, &cancel);
    assert_eq!(denied.status, IntegrationStatus::Rejected);
    assert!(denied.result.as_ref().is_none());
    Ok(())
}

#[test]
fn replaced_publication_namespace_and_revoked_native_epoch_never_release_cached_body() -> Result<()>
{
    for replace in [true, false] {
        let f = fixture()?;
        let (_source, _legacy, draft) = seed(&f)?;
        let resolver = ExistingProfileWikiResolver::new(&f.native, &f.settings)?;
        let host =
            NativeKnowledgeHost::new(&f.native, settings())?.with_wiki_resolver(Arc::new(resolver));
        let cancel = CancellationToken::new();
        let reply = host.knowledge(
            "publishKnowledge",
            &request(&host, Some("publish"), Some(0), json!({"draft":draft})),
            true,
            1000,
            &cancel,
        );
        assert_eq!(reply.status, IntegrationStatus::Completed);
        let publication: KnowledgePublication =
            serde_json::from_value(reply.result.as_ref().unwrap()["publication"].clone())?;
        if replace {
            let owned = host.observe_publications()?.unwrap();
            let namespace = f.profile.join(owned.guard.namespace_id());
            std::fs::rename(&namespace, f.profile.join("original-publications"))?;
            host.native
                .profile()?
                .create_private_child(OsStr::new(owned.guard.namespace_id()))?;
        } else {
            let mut global = host.scope().clone();
            global.workspace_id = IntegrationNullable::Null;
            let identity = crate::app_server::integrations::core::NativeIdentity::observe(
                host.native.profile()?,
                &global,
            )?
            .unwrap();
            identity.disable(host.native.profile()?, "actual-native-revocation", 1, 2000)?;
        }
        let read = request(
            &host,
            None,
            None,
            json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1}),
        );
        let denied = host.knowledge("resolvePublication", &read, false, 2001, &cancel);
        assert!(matches!(
            denied.status,
            IntegrationStatus::Unavailable | IntegrationStatus::Rejected
        ));
        assert!(denied.result.as_ref().is_none());
    }
    Ok(())
}

#[test]
fn logical_source_removal_and_archive_preserve_authorized_r1_but_missing_r1_never_reads_latest()
-> Result<()> {
    use sha2::{Digest, Sha256};
    let f = fixture()?;
    let (mut source, legacy, draft) = seed(&f)?;
    let resolver = ExistingProfileWikiResolver::new(&f.native, &f.settings)?;
    let host =
        NativeKnowledgeHost::new(&f.native, settings())?.with_wiki_resolver(Arc::new(resolver));
    let cancel = CancellationToken::new();
    let published = host.knowledge(
        "publishKnowledge",
        &request(&host, Some("publish-r1"), Some(0), json!({"draft":draft})),
        true,
        1000,
        &cancel,
    );
    assert_eq!(published.status, IntegrationStatus::Completed);
    let publication: KnowledgePublication =
        serde_json::from_value(published.result.as_ref().unwrap()["publication"].clone())?;
    let page = source.read_page(
        &legacy,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        Some(&draft.sources[0].page_revision),
    )?;
    let citation = &page.draft.citations[0];
    source.set_source_removed(
        &legacy,
        &draft.sources[0].library_id,
        &citation.source_id,
        &citation.revision_id,
        true,
    )?;
    let library = source.read(&legacy, &draft.sources[0].library_id)?;
    source.set_archived(&legacy, &library.id, library.revision, true)?;
    assert!(
        source
            .source_status(&legacy, &library.id, &citation.source_id)?
            .removed
    );
    assert!(source.read(&legacy, &library.id)?.archived);
    let inspect = request(
        &host,
        None,
        None,
        json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1,"after":null}),
    );
    let removed = host.knowledge("readPublicationSources", &inspect, false, 1500, &cancel);
    assert_eq!(removed.status, IntegrationStatus::Completed);
    let observation = &removed.result.as_ref().unwrap()["page"]["items"][0];
    assert_eq!(
        observation["source"],
        serde_json::to_value(&draft.sources[0])?
    );
    assert_eq!(observation["available"], true);
    assert_eq!(observation["removed"], true);
    assert_eq!(observation["archived"], true);
    let historical =
        host.wiki
            .as_ref()
            .unwrap()
            .resolve_fixed_pages(&host.native, &draft.sources, &cancel)?;
    assert_eq!(historical[0].markdown, publication.pages[0].markdown);
    let library = source.read(&legacy, &library.id)?;
    source.set_archived(&legacy, &library.id, library.revision, false)?;
    let r2 = source.edit_page(
        &legacy,
        &library.id,
        &draft.sources[0].page_id,
        &draft.sources[0].page_revision,
        "r2",
        "Current revision",
        "This current r2 must never replace missing r1.",
    )?;
    let hash = format!("{:x}", Sha256::digest(page.draft.markdown.as_bytes()));
    let old_object = f
        .profile
        .join("knowledge/state.objects")
        .join(&library.id)
        .join(format!("{hash}.md"));
    std::fs::remove_file(old_object)?;
    assert!(
        host.wiki
            .as_ref()
            .unwrap()
            .resolve_fixed_pages(&host.native, &draft.sources, &cancel)
            .is_err()
    );
    let missing = host.knowledge("readPublicationSources", &inspect, false, 2000, &cancel);
    assert_eq!(missing.status, IntegrationStatus::Completed);
    let observation = &missing.result.as_ref().unwrap()["page"]["items"][0];
    assert_eq!(observation["available"], false);
    assert_eq!(observation["removed"], true);
    assert_eq!(observation["archived"], false);
    assert_eq!(
        source
            .read_page(&legacy, &library.id, &draft.sources[0].page_id, None)?
            .revision_id,
        r2.revision_id
    );
    let read = request(
        &host,
        None,
        None,
        json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1}),
    );
    let retained = host.knowledge("resolvePublication", &read, false, 2000, &cancel);
    assert_eq!(retained.status, IntegrationStatus::Completed);
    assert_eq!(
        retained.result.as_ref().unwrap()["publication"]["pages"][0]["markdown"],
        publication.pages[0].markdown
    );
    let revoke = host.knowledge(
        "revokePublication",
        &request(
            &host,
            Some("revoke-after-removal"),
            Some(1),
            json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1}),
        ),
        true,
        2100,
        &cancel,
    );
    assert_eq!(revoke.status, IntegrationStatus::Completed);
    let denied = host.knowledge("readPublicationSources", &inspect, false, 2101, &cancel);
    assert_eq!(denied.status, IntegrationStatus::Rejected);
    assert!(denied.result.as_ref().is_none());
    Ok(())
}

#[test]
fn real_source_pages_use_version_bound_cursors_and_recheck_revocation_on_every_page() -> Result<()>
{
    let f = fixture()?;
    let (mut source, legacy, mut draft) = seed(&f)?;
    let first = source.read_page(
        &legacy,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        Some(&draft.sources[0].page_revision),
    )?;
    let additional = source.commit_generated_pages(
        &legacy,
        &draft.sources[0].library_id,
        "additional-real-pages",
        (0..10)
            .map(|index| KnowledgePageDraft {
                page_id: uuid::Uuid::new_v4().to_string(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: format!("Fixed source {index}"),
                markdown: first.draft.markdown.clone(),
                citations: first.draft.citations.clone(),
                related_page_ids: vec![],
            })
            .collect(),
    )?;
    let library_id = draft.sources[0].library_id.clone();
    draft
        .sources
        .extend(additional.iter().map(|page| PublicationSource {
            library_id: library_id.clone(),
            page_id: page.page_id.clone(),
            page_revision: page.revision_id.clone(),
        }));
    let resolver = ExistingProfileWikiResolver::new(&f.native, &f.settings)?;
    let host =
        NativeKnowledgeHost::new(&f.native, settings())?.with_wiki_resolver(Arc::new(resolver));
    let cancel = CancellationToken::new();
    let publish = host.knowledge(
        "publishKnowledge",
        &request(
            &host,
            Some("publish-multiple"),
            Some(0),
            json!({"draft":draft}),
        ),
        true,
        1000,
        &cancel,
    );
    assert_eq!(
        publish.status,
        IntegrationStatus::Completed,
        "{:?}",
        publish.error
    );
    let publication: KnowledgePublication =
        serde_json::from_value(publish.result.as_ref().unwrap()["publication"].clone())?;
    let inspect = |version: u64, after: Option<&str>| {
        request(
            &host,
            None,
            None,
            json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":version,"after":after}),
        )
    };
    let first = host.knowledge(
        "readPublicationSources",
        &inspect(1, None),
        false,
        1100,
        &cancel,
    );
    assert_eq!(first.status, IntegrationStatus::Completed);
    let first_page: kcoder_app_protocol::integrations::knowledge::PublicationSourcesReadResult =
        serde_json::from_value(Value::Object(first.result.as_ref().unwrap().clone()))?;
    assert_eq!(first_page.page.items.len(), 10);
    assert!(first_page.page.items.iter().all(|item| item.available));
    assert_eq!(first_page.page.items[0].source, draft.sources[0]);
    let cursor = first_page.page.next_cursor.as_deref().unwrap();
    let second = host.knowledge(
        "readPublicationSources",
        &inspect(1, Some(cursor)),
        false,
        1200,
        &cancel,
    );
    assert_eq!(second.status, IntegrationStatus::Completed);
    let second_page: kcoder_app_protocol::integrations::knowledge::PublicationSourcesReadResult =
        serde_json::from_value(Value::Object(second.result.as_ref().unwrap().clone()))?;
    assert_eq!(second_page.page.items.len(), 1);
    assert_eq!(second_page.page.items[0].source, draft.sources[10]);
    assert!(second_page.page.next_cursor.is_none());
    let updated = host.knowledge(
        "publishKnowledge",
        &request(&host, Some("publish-v2"), Some(1), json!({"draft":draft})),
        true,
        1300,
        &cancel,
    );
    assert_eq!(updated.status, IntegrationStatus::Completed);
    let wrong_version = host.knowledge(
        "readPublicationSources",
        &inspect(2, Some(cursor)),
        false,
        1400,
        &cancel,
    );
    assert_eq!(wrong_version.status, IntegrationStatus::Rejected);
    assert_eq!(
        wrong_version.error.as_ref().unwrap().code,
        "KNOWLEDGE_INVALID_CURSOR"
    );
    let revoke = host.knowledge(
        "revokePublication",
        &request(
            &host,
            Some("revoke-v1-mid-page"),
            Some(1),
            json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1}),
        ),
        true,
        1500,
        &cancel,
    );
    assert_eq!(revoke.status, IntegrationStatus::Completed);
    let denied = host.knowledge(
        "readPublicationSources",
        &inspect(1, Some(cursor)),
        false,
        1600,
        &cancel,
    );
    assert_eq!(denied.status, IntegrationStatus::Rejected);
    assert!(denied.result.as_ref().is_none());
    assert_eq!(
        denied.error.as_ref().unwrap().code,
        "KNOWLEDGE_PUBLICATION_REVOKED"
    );
    let current = host.knowledge(
        "readPublicationSources",
        &inspect(2, None),
        false,
        1600,
        &cancel,
    );
    assert_eq!(current.status, IntegrationStatus::Completed);
    assert_eq!(source.list(&legacy, None, 10)?.len(), 1);
    Ok(())
}

#[test]
fn real_native_identity_revoked_during_source_observation_discards_the_entire_page() -> Result<()> {
    struct RevokeDuringObservation(ExistingProfileWikiResolver);
    impl NativeWikiPublicationResolver for RevokeDuringObservation {
        fn resolve_fixed_pages(
            &self,
            native: &NativeIntegrationContext,
            sources: &[PublicationSource],
            cancel: &CancellationToken,
        ) -> Result<Vec<PublishedKnowledgePage>> {
            self.0.resolve_fixed_pages(native, sources, cancel)
        }
        fn observe_fixed_sources(
            &self,
            native: &NativeIntegrationContext,
            sources: &[PublicationSource],
            cancel: &CancellationToken,
            now_ms: u64,
        ) -> Result<Vec<KnowledgeSourceObservation>> {
            let observed = self
                .0
                .observe_fixed_sources(native, sources, cancel, now_ms)?;
            let mut global = native.scope().clone();
            global.workspace_id = IntegrationNullable::Null;
            let identity = crate::app_server::integrations::core::NativeIdentity::observe(
                native.profile()?,
                &global,
            )?
            .unwrap();
            identity.disable(native.profile()?, "source-read-revocation", 1, now_ms)?;
            Ok(observed)
        }
    }
    let f = fixture()?;
    let (_source, _legacy, draft) = seed(&f)?;
    let resolver =
        RevokeDuringObservation(ExistingProfileWikiResolver::new(&f.native, &f.settings)?);
    let host =
        NativeKnowledgeHost::new(&f.native, settings())?.with_wiki_resolver(Arc::new(resolver));
    let cancel = CancellationToken::new();
    let published = host.knowledge(
        "publishKnowledge",
        &request(
            &host,
            Some("publish-before-revocation"),
            Some(0),
            json!({"draft":draft}),
        ),
        true,
        1000,
        &cancel,
    );
    assert_eq!(published.status, IntegrationStatus::Completed);
    let publication: KnowledgePublication =
        serde_json::from_value(published.result.as_ref().unwrap()["publication"].clone())?;
    let inspected = host.knowledge(
        "readPublicationSources",
        &request(&host, None, None, json!({"owner":publication.owner,"publicationId":draft.publication_id,"version":1,"after":null})),
        false,
        2000,
        &cancel,
    );
    assert!(matches!(
        inspected.status,
        IntegrationStatus::Rejected | IntegrationStatus::Unavailable
    ));
    assert!(inspected.result.as_ref().is_none());
    assert!(host.native.verify().is_err());
    Ok(())
}
