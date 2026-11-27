use super::*;
use kcoder_types::{
    integrations::{core::IntegrationNullable, knowledge::PublicationSource},
    knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind},
};
use std::cell::Cell;
mod index_rows;
#[cfg(target_os = "linux")]
mod native_read_scale;
struct Policy {
    shared_read: Cell<bool>,
    failed: Cell<bool>,
}
impl PublicationAccess for Policy {
    fn check(
        &self,
        caller: &IntegrationScope,
        owner: &KnowledgeOwner,
        _id: &str,
        action: PublicationAction,
    ) -> Result<bool> {
        ensure!(!self.failed.get(), "FIXTURE_POLICY_UNAVAILABLE");
        Ok(caller.target_id == owner.target_id
            && (caller.account_id == owner.account_id
                || (matches!(
                    action,
                    PublicationAction::Read | PublicationAction::ReadCitation
                ) && self.shared_read.get())))
    }
}
fn policy() -> Policy {
    Policy {
        shared_read: Cell::new(false),
        failed: Cell::new(false),
    }
}
fn scope(account: &str) -> IntegrationScope {
    IntegrationScope {
        account_id: account.into(),
        target_id: "local".into(),
        workspace_id: IntegrationNullable::Value("project".into()),
        identity_generation: "identity-1".into(),
        target_revision: "target-1".into(),
        organization_id: None,
    }
}
fn seed(store: &mut KnowledgeCatalog, native: &KnowledgeScope) -> Result<PublicationDraft> {
    let library = store.create(native, "library", "Synthetic policies", "")?;
    let text = "报销材料在十个工作日内审核。";
    let source = store.import_text(native, &library.id, "source", "policy.md", text)?;
    let page = KnowledgePageDraft {
        page_id: uuid::Uuid::new_v4().to_string(),
        expected_revision: None,
        kind: KnowledgePageKind::Concept,
        title: "报销制度".into(),
        markdown: text.into(),
        citations: vec![KnowledgeCitation {
            source_id: source.source_id,
            revision_id: source.revision_id,
            chunk_id: "chunk-1".into(),
            quote: text.into(),
        }],
        related_page_ids: vec![],
    };
    let refs = store.commit_generated_pages(native, &library.id, "page", vec![page])?;
    Ok(PublicationDraft {
        publication_id: "approved-policy".into(),
        title: "已发布报销制度".into(),
        purpose: Some("供个人报销任务核对固定制度修订".into()),
        review_conclusion: Some("发布者已检查来源与适用时间；不代表独立审核".into()),
        visibility: KnowledgeVisibility::Personal,
        audience_id: None,
        sources: vec![PublicationSource {
            library_id: library.id,
            page_id: refs[0].page_id.clone(),
            page_revision: refs[0].revision_id.clone(),
        }],
        valid_from_ms: Some(10),
        valid_until_ms: Some(1000),
        unresolved: vec![],
    })
}
#[test]
fn actual_wiki_revisions_are_immutable_and_idempotent_after_reopen() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("wiki.sqlite");
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let policy = policy();
    let mut store = KnowledgeCatalog::open(&path)?;
    let draft = seed(&mut store, &native)?;
    let old =
        store.publish_knowledge(&native, &actor, "publish-1", 0, draft.clone(), &policy, 100)?;
    assert_eq!(old.publisher_role.as_deref(), Some("personal_owner"));
    assert_eq!(old.draft.purpose, draft.purpose);
    let new_page = store.edit_page(
        &native,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        &draft.sources[0].page_revision,
        "edit",
        "新制度",
        "报销材料在五个工作日内审核。",
    )?;
    let mut updated = draft.clone();
    updated.sources[0].page_revision = new_page.revision_id;
    let new = store.publish_knowledge(&native, &actor, "publish-2", 1, updated, &policy, 101)?;
    assert_eq!(old.version, 1);
    assert_eq!(new.version, 2);
    assert!(
        store
            .resolve_publication(
                &actor,
                &old.owner,
                &draft.publication_id,
                Some(1),
                &policy,
                102
            )?
            .pages[0]
            .markdown
            .contains("十个")
    );
    assert!(new.pages[0].markdown.contains("五个"));
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        store.publish_knowledge(&native, &actor, "publish-1", 0, draft.clone(), &policy, 200)?,
        old
    );
    assert!(
        store
            .publish_knowledge(&native, &actor, "publish-1", 2, draft.clone(), &policy, 200)
            .is_err()
    );
    assert!(
        store
            .publish_knowledge(&native, &actor, "stale", 0, draft.clone(), &policy, 200)
            .is_err()
    );
    store.revoke_publication(
        &actor,
        &old.owner,
        &draft.publication_id,
        1,
        "revoke",
        &policy,
    )?;
    assert!(
        store
            .resolve_publication(
                &actor,
                &old.owner,
                &draft.publication_id,
                Some(1),
                &policy,
                201
            )
            .is_err()
    );
    assert!(
        store
            .resolve_publication(
                &actor,
                &new.owner,
                &draft.publication_id,
                Some(2),
                &policy,
                201
            )
            .is_ok()
    );
    Ok(())
}

#[test]
fn publication_metadata_is_bounded_and_legacy_missing_facts_stay_unknown() -> Result<()> {
    let root = tempfile::tempdir()?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let access = policy();
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let draft = seed(&mut store, &native)?;
    let mut invalid = draft.clone();
    invalid.purpose = Some("x".repeat(4097));
    assert!(
        store
            .publish_knowledge(&native, &actor, "invalid", 0, invalid, &access, 100)
            .unwrap_err()
            .to_string()
            .contains("INVALID_PUBLICATION_METADATA")
    );
    let published =
        store.publish_knowledge(&native, &actor, "published", 0, draft, &access, 100)?;
    let mut legacy = serde_json::to_value(&published)?;
    legacy.as_object_mut().unwrap().remove("publisherRole");
    legacy["draft"].as_object_mut().unwrap().remove("purpose");
    legacy["draft"]
        .as_object_mut()
        .unwrap()
        .remove("reviewConclusion");
    let body = serde_json::to_string(&legacy)?;
    store.connection.execute(
        "UPDATE integration_publications SET body_json=?1,body_hash=?2",
        params![body, crate::objects::digest(body.as_bytes())],
    )?;
    let restored = store.resolve_publication(
        &actor,
        &published.owner,
        &published.draft.publication_id,
        Some(1),
        &access,
        100,
    )?;
    assert_eq!(restored.publisher_role, None);
    assert_eq!(restored.draft.purpose, None);
    assert_eq!(restored.draft.review_conclusion, None);
    Ok(())
}

#[test]
fn owner_history_covers_inactive_and_revoked_metadata_without_body_or_foreign_names() -> Result<()>
{
    let root = tempfile::tempdir()?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let access = policy();
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let draft = seed(&mut store, &native)?;
    for index in 0..12 {
        let mut current = draft.clone();
        current.publication_id = format!("publication-{index:02}");
        current.valid_from_ms = Some(5000);
        current.valid_until_ms = Some(6000);
        store.publish_knowledge(
            &native,
            &actor,
            &format!("publish-{index}"),
            0,
            current,
            &access,
            100,
        )?;
    }
    store.revoke_publication(
        &actor,
        &KnowledgeOwner::from(&actor),
        "publication-00",
        1,
        "revoke",
        &access,
    )?;
    assert!(
        store
            .list_publications(&actor, &access, None, 100)?
            .items
            .is_empty()
    );
    let first = store.list_owned_publication_versions(&actor, &access, None)?;
    assert_eq!(first.items.len(), 10);
    assert!(first.items[0].revoked);
    let encoded = serde_json::to_value(&first)?;
    assert!(encoded["items"][0].get("pages").is_none());
    assert!(encoded["items"][0].get("sources").is_none());
    let cursor = first.next_cursor.unwrap();
    assert_eq!(
        store
            .list_owned_publication_versions(&actor, &access, Some(&cursor))?
            .items
            .len(),
        2
    );
    assert!(
        store
            .list_owned_publication_versions(&scope("bob"), &access, None)?
            .items
            .is_empty()
    );
    assert!(
        store
            .list_owned_publication_versions(&scope("bob"), &access, Some(&cursor))
            .is_err()
    );
    let mut refreshed = actor.clone();
    refreshed.identity_generation = "new-generation".into();
    assert!(
        store
            .list_owned_publication_versions(&refreshed, &access, Some(&cursor))
            .is_err()
    );
    assert!(
        store
            .resolve_publication(
                &actor,
                &KnowledgeOwner::from(&actor),
                "publication-00",
                Some(1),
                &access,
                5500
            )
            .is_err()
    );
    Ok(())
}
#[test]
fn acl_applies_to_body_counts_search_citation_and_revocation() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let reader = scope("bob");
    let policy = policy();
    let draft = seed(&mut store, &native)?;
    let publication =
        store.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &policy, 100)?;
    assert!(
        store
            .list_publications(&reader, &policy, None, 100)?
            .items
            .is_empty()
    );
    assert!(
        store
            .retrieve_publication(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                "报销",
                5,
                &policy,
                100
            )
            .is_err()
    );
    policy.shared_read.set(true);
    let results = store.retrieve_publication(
        &reader,
        &publication.owner,
        &draft.publication_id,
        1,
        "报销",
        5,
        &policy,
        100,
    )?;
    assert_eq!(results.outcome, KnowledgeRetrievalOutcome::Matched);
    assert_eq!(results.hits[0].source, draft.sources[0]);
    assert!(
        store
            .read_publication_citation(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                &draft.sources[0],
                &policy,
                100
            )?
            .markdown
            .contains("十个")
    );
    assert!(
        store
            .revoke_publication(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                "reader-revoke",
                &policy
            )
            .is_err()
    );
    policy.shared_read.set(false);
    assert!(
        store
            .read_publication_citation(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                &draft.sources[0],
                &policy,
                100
            )
            .is_err()
    );
    assert!(
        store
            .list_publications(&reader, &policy, None, 100)?
            .items
            .is_empty()
    );
    policy.failed.set(true);
    assert!(
        store
            .list_publications(&reader, &policy, None, 100)
            .is_err()
    );
    Ok(())
}
#[test]
fn backend_index_and_policy_failures_are_never_no_match() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let policy = policy();
    let draft = seed(&mut store, &native)?;
    let publication =
        store.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &policy, 100)?;
    assert_eq!(
        store
            .retrieve_publication(
                &actor,
                &publication.owner,
                &draft.publication_id,
                1,
                "量子宇宙",
                5,
                &policy,
                100
            )?
            .outcome,
        KnowledgeRetrievalOutcome::NoMatch
    );
    store
        .connection
        .execute("DELETE FROM integration_publication_fts", [])?;
    assert!(
        store
            .retrieve_publication(
                &actor,
                &publication.owner,
                &draft.publication_id,
                1,
                "报销",
                5,
                &policy,
                100
            )
            .unwrap_err()
            .to_string()
            .contains("INDEX_STALE")
    );
    store
        .connection
        .execute("DROP TABLE integration_publication_fts", [])?;
    assert!(
        store
            .retrieve_publication(
                &actor,
                &publication.owner,
                &draft.publication_id,
                1,
                "报销",
                5,
                &policy,
                100
            )
            .unwrap_err()
            .to_string()
            .contains("STORAGE_CORRUPT")
    );
    Ok(())
}
#[test]
fn future_expired_corrupt_and_mismatched_sources_are_distinct_failures() -> Result<()> {
    let root = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let policy = policy();
    let mut draft = seed(&mut store, &native)?;
    let publication =
        store.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &policy, 100)?;
    assert!(
        store
            .resolve_publication(
                &actor,
                &publication.owner,
                &draft.publication_id,
                Some(1),
                &policy,
                1
            )
            .unwrap_err()
            .to_string()
            .contains("NOT_EFFECTIVE")
    );
    assert!(
        store
            .resolve_publication(
                &actor,
                &publication.owner,
                &draft.publication_id,
                Some(1),
                &policy,
                1001
            )
            .unwrap_err()
            .to_string()
            .contains("EXPIRED")
    );
    draft.sources[0].page_revision = "invented-revision".into();
    assert!(
        store
            .publish_knowledge(&native, &actor, "bad-source", 1, draft, &policy, 100)
            .is_err()
    );
    store.connection.execute(
        "UPDATE integration_publications SET body_hash='corrupt'",
        [],
    )?;
    assert!(store.list_publications(&actor, &policy, None, 100).is_err());
    Ok(())
}

fn database_observation(store: &KnowledgeCatalog) -> Result<(u64, u64, u64)> {
    Ok((
        store
            .connection
            .query_row("PRAGMA schema_version", [], |r| r.get(0))?,
        store
            .connection
            .query_row("PRAGMA data_version", [], |r| r.get(0))?,
        store.connection.total_changes(),
    ))
}
#[test]
fn display_reads_never_initialize_or_repair_publication_schema() -> Result<()> {
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let owner = KnowledgeOwner::from(&actor);
    let policy = policy();
    let store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let before = database_observation(&store)?;
    assert!(
        store
            .list_publications(&actor, &policy, None, 100)
            .unwrap_err()
            .to_string()
            .contains("NOT_INITIALIZED")
    );
    assert!(
        store
            .resolve_publication(&actor, &owner, "missing", None, &policy, 100)
            .is_err()
    );
    assert_eq!(database_observation(&store)?, before);
    Ok(())
}
#[test]
fn damaged_publication_tables_are_not_recreated_by_reads_or_publish() -> Result<()> {
    for table in [
        "integration_publication_meta",
        "integration_publication_fts",
    ] {
        let root = tempfile::tempdir()?;
        let actor = scope("alice");
        let owner = KnowledgeOwner::from(&actor);
        let policy = policy();
        let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
        let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
        let draft = seed(&mut store, &native)?;
        store.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &policy, 100)?;
        store
            .connection
            .execute_batch(&format!("DROP TABLE {table}"))?;
        let before = database_observation(&store)?;
        assert!(
            store
                .list_publications(&actor, &policy, None, 101)
                .unwrap_err()
                .to_string()
                .contains("CORRUPT")
        );
        assert!(
            store
                .resolve_publication(&actor, &owner, &draft.publication_id, None, &policy, 101)
                .is_err()
        );
        assert!(
            store
                .publish_knowledge(&native, &actor, "publish-again", 1, draft, &policy, 101)
                .unwrap_err()
                .to_string()
                .contains("CORRUPT")
        );
        assert_eq!(database_observation(&store)?, before);
    }
    Ok(())
}

#[test]
fn owner_management_permission_alone_never_authorizes_a_shared_audience() -> Result<()> {
    struct OwnerOnly;
    impl PublicationAccess for OwnerOnly {
        fn check(
            &self,
            _: &IntegrationScope,
            _: &KnowledgeOwner,
            _: &str,
            _: PublicationAction,
        ) -> Result<bool> {
            Ok(true)
        }
    }
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let mut draft = seed(&mut store, &native)?;
    draft.visibility = KnowledgeVisibility::Project;
    draft.audience_id = Some("project".into());
    assert!(
        store
            .publish_knowledge(&native, &actor, "share", 0, draft, &OwnerOnly, 100)
            .unwrap_err()
            .to_string()
            .contains("AUDIENCE_DENIED")
    );
    assert!(!store.publications_initialized()?);
    Ok(())
}
#[test]
fn wrong_lexical_terms_with_same_row_count_are_stale_and_only_explicit_rebuild_repairs()
-> Result<()> {
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let policy = policy();
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let draft = seed(&mut store, &native)?;
    let publication =
        store.publish_knowledge(&native, &actor, "publish", 0, draft, &policy, 100)?;
    store.connection.execute(
        "UPDATE integration_publication_fts SET title_terms='wrong',body_terms='wrong'",
        [],
    )?;
    let before = database_observation(&store)?;
    assert!(
        store
            .retrieve_publication(
                &actor,
                &publication.owner,
                &publication.draft.publication_id,
                1,
                "报销",
                10,
                &policy,
                101
            )
            .unwrap_err()
            .to_string()
            .contains("INDEX_STALE")
    );
    assert_eq!(database_observation(&store)?, before);
    assert!(
        !store
            .inspect_publication_index(
                &actor,
                &publication.owner,
                &publication.draft.publication_id,
                1,
                &policy,
                101
            )?
            .ready
    );
    assert!(
        store
            .rebuild_publication_index(
                &actor,
                &publication.owner,
                &publication.draft.publication_id,
                1,
                "rebuild",
                &policy,
                102
            )?
            .ready
    );
    assert!(
        !store
            .retrieve_publication(
                &actor,
                &publication.owner,
                &publication.draft.publication_id,
                1,
                "报销",
                10,
                &policy,
                103
            )?
            .hits
            .is_empty()
    );
    assert!(
        store
            .rebuild_publication_index(
                &actor,
                &publication.owner,
                &publication.draft.publication_id,
                1,
                "rebuild",
                &policy,
                104
            )?
            .ready
    );
    Ok(())
}
#[test]
fn optional_index_identity_does_not_reuse_different_sources_models_dimensions_or_backends() {
    let original = OptionalIndexIdentity {
        publication_digest: "source-v1".into(),
        backend_revision: "backend-v1".into(),
        model_fingerprint: Some("model-v1".into()),
        dimensions: Some(4),
    };
    assert!(original.may_reuse_for(&original));
    let mut changed = original.clone();
    changed.publication_digest = "source-v2".into();
    assert!(!original.may_reuse_for(&changed));
    let mut changed = original.clone();
    changed.model_fingerprint = Some("model-v2".into());
    assert!(!original.may_reuse_for(&changed));
    let mut changed = original.clone();
    changed.dimensions = Some(8);
    assert!(!original.may_reuse_for(&changed));
    let mut changed = original.clone();
    changed.backend_revision = "backend-v2".into();
    assert!(!original.may_reuse_for(&changed));
}
#[test]
fn many_real_publications_page_without_embedding_and_keep_fixed_revision_search() -> Result<()> {
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let policy = policy();
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let started = std::time::Instant::now();
    let mut original = seed(&mut store, &native)?;
    let base = store.read_page(
        &native,
        &original.sources[0].library_id,
        &original.sources[0].page_id,
        Some(&original.sources[0].page_revision),
    )?;
    let pages = (0..31)
        .map(|index| {
            let mut page = base.draft.clone();
            page.page_id = uuid::Uuid::new_v4().to_string();
            page.expected_revision = None;
            page.title = format!("Synthetic policy page {index}");
            page.markdown = base.draft.markdown.repeat(96);
            page
        })
        .collect();
    let references = store.commit_generated_pages(
        &native,
        &original.sources[0].library_id,
        "scale-pages",
        pages,
    )?;
    let scale_library = original.sources[0].library_id.clone();
    original
        .sources
        .extend(references.into_iter().map(|reference| PublicationSource {
            library_id: scale_library.clone(),
            page_id: reference.page_id,
            page_revision: reference.revision_id,
        }));
    for index in 0..120 {
        let mut draft = original.clone();
        draft.publication_id = format!("publication-{index:04}");
        store.publish_knowledge(
            &native,
            &actor,
            &format!("publish-{index}"),
            0,
            draft,
            &policy,
            100,
        )?;
    }
    let preparation_ms = started.elapsed().as_millis();
    let paging_started = std::time::Instant::now();
    let mut cursor = None;
    let mut total = 0;
    loop {
        let page = store.list_publications(&actor, &policy, cursor.as_deref(), 101)?;
        assert!(page.items.len() <= 10);
        total += page.items.len();
        for item in &page.items {
            assert_eq!(item.pages[0].source, original.sources[0]);
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(total, 120);
    let paging_ms = paging_started.elapsed().as_millis();
    let search_started = std::time::Instant::now();
    assert_eq!(
        store
            .retrieve_publication(
                &actor,
                &KnowledgeOwner::from(&actor),
                "publication-0119",
                1,
                "报销",
                10,
                &policy,
                101
            )?
            .outcome,
        KnowledgeRetrievalOutcome::Matched
    );
    let search_us = search_started.elapsed().as_micros();
    let peak_rss_kib = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("VmHWM:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse::<u64>().ok())
        });
    eprintln!(
        "{}",
        serde_json::json!({"knowledgeScaleEvidence":{"publications":120,"fixedPageReferences":120*32,"preparationMs":preparation_ms,"pagingMs":paging_ms,"searchUs":search_us,"peakRssKiB":peak_rss_kib,"embeddingCalls":0,"fixtureOnly":true}})
    );
    Ok(())
}
#[test]
fn fresh_export_obeys_current_acl_and_keeps_published_source_revision() -> Result<()> {
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let reader = scope("bob");
    let policy = policy();
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let draft = seed(&mut store, &native)?;
    let publication =
        store.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &policy, 100)?;
    assert!(
        store
            .export_publication_markdown(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                &policy,
                101
            )
            .is_err()
    );
    policy.shared_read.set(true);
    assert!(
        store
            .export_publication_markdown(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                &policy,
                101
            )?
            .contains(&draft.sources[0].page_revision)
    );
    policy.shared_read.set(false);
    assert!(
        store
            .export_publication_markdown(
                &reader,
                &publication.owner,
                &draft.publication_id,
                1,
                &policy,
                102
            )
            .is_err()
    );
    Ok(())
}
#[test]
fn encoded_publication_and_page_budgets_do_not_overflow_native_frames() -> Result<()> {
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let policy = policy();
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let draft = seed(&mut store, &native)?;
    let page = store.edit_page(
        &native,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        &draft.sources[0].page_revision,
        "edit-large",
        "Synthetic large page",
        &"\u{0001}".repeat(40000),
    )?;
    let mut large = draft.clone();
    large.sources[0].page_revision = page.revision_id.clone();
    for index in 0..4 {
        let mut input = large.clone();
        input.publication_id = format!("large-{index}");
        store.publish_knowledge(
            &native,
            &actor,
            &format!("publish-{index}"),
            0,
            input,
            &policy,
            100,
        )?;
    }
    let first = store.list_publications(&actor, &policy, None, 101)?;
    assert!(first.items.len() < 4);
    assert!(serde_json::to_vec(&first)?.len() <= 768 * 1024);
    assert!(first.next_cursor.is_some());
    let second = store.list_publications(&actor, &policy, first.next_cursor.as_deref(), 101)?;
    assert_eq!(first.items.len() + second.items.len(), 4);
    let oversized = store.edit_page(
        &native,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        &page.revision_id,
        "edit-too-large",
        "Synthetic oversized page",
        &"\u{0001}".repeat(100000),
    )?;
    let mut denied = draft;
    denied.publication_id = "oversized".into();
    denied.sources[0].page_revision = oversized.revision_id;
    assert!(
        store
            .publish_knowledge(&native, &actor, "publish-denied", 0, denied, &policy, 102)
            .unwrap_err()
            .to_string()
            .contains("TOO_LARGE")
    );
    Ok(())
}
#[test]
fn adoption_is_explicit_fixed_version_durable_and_rechecks_revoked_source() -> Result<()> {
    let root = tempfile::tempdir()?;
    let actor = scope("alice");
    let policy = policy();
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let path = root.path().join("wiki.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let draft = seed(&mut store, &native)?;
    let before = database_observation(&store)?;
    assert!(
        store
            .list_knowledge_adoptions(&actor, None)?
            .items
            .is_empty()
    );
    assert_eq!(before, database_observation(&store)?);
    let first =
        store.publish_knowledge(&native, &actor, "publish", 0, draft.clone(), &policy, 100)?;
    let adoption = store.adopt_publication(
        &actor,
        &first.owner,
        &draft.publication_id,
        1,
        "adopt",
        0,
        &policy,
        101,
    )?;
    let new_page = store.edit_page(
        &native,
        &draft.sources[0].library_id,
        &draft.sources[0].page_id,
        &draft.sources[0].page_revision,
        "edit",
        "New policy",
        "Use five working days.",
    )?;
    let mut revised = draft.clone();
    revised.sources[0].page_revision = new_page.revision_id;
    store.publish_knowledge(&native, &actor, "publish-v2", 1, revised, &policy, 102)?;
    assert_eq!(
        store
            .resolve_knowledge_adoption(&actor, &adoption.id, &policy, 103)?
            .version,
        1
    );
    assert_eq!(
        store.adopt_publication(
            &actor,
            &first.owner,
            &draft.publication_id,
            1,
            "adopt",
            0,
            &policy,
            104
        )?,
        adoption
    );
    assert!(
        store
            .list_knowledge_adoptions(&scope("bob"), None)?
            .items
            .is_empty()
    );
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        store.list_knowledge_adoptions(&actor, None)?.items[0],
        adoption
    );
    store.revoke_publication(
        &actor,
        &first.owner,
        &draft.publication_id,
        1,
        "revoke",
        &policy,
    )?;
    assert!(
        store
            .resolve_knowledge_adoption(&actor, &adoption.id, &policy, 105)
            .is_err()
    );
    let disabled = store.set_knowledge_adoption_enabled(
        &actor,
        &adoption.id,
        "disable",
        1,
        false,
        &policy,
        106,
    )?;
    assert!(!disabled.enabled);
    assert!(
        store
            .set_knowledge_adoption_enabled(&actor, &adoption.id, "reenable", 2, true, &policy, 107)
            .is_err()
    );
    Ok(())
}

#[test]
fn directory_time_epoch_changes_only_at_actual_effective_date_transitions() -> Result<()> {
    let root = tempfile::tempdir()?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let actor = scope("alice");
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let draft = seed(&mut store, &native)?;
    store.publish_knowledge(
        &native,
        &actor,
        "publish-directory-clock",
        0,
        draft,
        &policy(),
        100,
    )?;
    assert_ne!(
        store.publication_listing_time_epoch(9)?,
        store.publication_listing_time_epoch(10)?
    );
    assert_eq!(
        store.publication_listing_time_epoch(10)?,
        store.publication_listing_time_epoch(999)?
    );
    assert_ne!(
        store.publication_listing_time_epoch(999)?,
        store.publication_listing_time_epoch(1000)?
    );
    Ok(())
}

#[test]
fn external_adoption_keeps_only_reference_and_rolls_back_if_real_source_is_revoked_before_commit()
-> Result<()> {
    use std::cell::RefCell;
    struct SharedPolicy;
    impl PublicationAccess for SharedPolicy {
        fn check(
            &self,
            caller: &IntegrationScope,
            owner: &KnowledgeOwner,
            _id: &str,
            _action: PublicationAction,
        ) -> Result<bool> {
            Ok(caller.organization_id == owner.organization_id)
        }
        fn check_publish_target(
            &self,
            caller: &IntegrationScope,
            owner: &KnowledgeOwner,
            _draft: &PublicationDraft,
        ) -> Result<bool> {
            Ok(caller.account_id == owner.account_id)
        }
    }
    struct ActualSource {
        store: RefCell<KnowledgeCatalog>,
        publisher: IntegrationScope,
        calls: Cell<usize>,
        revoke: bool,
    }
    impl super::PublicationReferenceResolver for ActualSource {
        fn resolve_reference(
            &self,
            caller: &IntegrationScope,
            owner: &KnowledgeOwner,
            id: &str,
            version: u64,
        ) -> Result<KnowledgePublication> {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            if self.revoke && call == 2 {
                self.store.borrow_mut().revoke_publication(
                    &self.publisher,
                    owner,
                    id,
                    version,
                    "actual-source-revoke",
                    &SharedPolicy,
                )?;
            }
            self.store.borrow().resolve_publication(
                caller,
                owner,
                id,
                Some(version),
                &SharedPolicy,
                100,
            )
        }
    }
    for revoke in [false, true] {
        let root = tempfile::tempdir()?;
        let mut publisher = scope("publisher");
        publisher.organization_id = Some(IntegrationNullable::Value("actual-org".into()));
        let mut reader = scope("reader");
        reader.organization_id = publisher.organization_id.clone();
        let owner = KnowledgeOwner::from(&publisher);
        let native = KnowledgeScope::from_authenticated_host("publisher", "local")?;
        let mut original = KnowledgeCatalog::open(&root.path().join("publisher.sqlite"))?;
        let mut draft = seed(&mut original, &native)?;
        draft.visibility = KnowledgeVisibility::Organization;
        draft.audience_id = Some("actual-org".into());
        let published = original.publish_knowledge(
            &native,
            &publisher,
            "source-publish",
            0,
            draft,
            &SharedPolicy,
            100,
        )?;
        let source = ActualSource {
            store: RefCell::new(original),
            publisher,
            calls: Cell::new(0),
            revoke,
        };
        let mut destination = KnowledgeCatalog::open(&root.path().join("reader.sqlite"))?;
        destination.initialize_native_publication_schema()?;
        let result = destination.adopt_external_publication(
            &reader,
            &owner,
            &published.draft.publication_id,
            1,
            "actual-external-adoption",
            0,
            &SharedPolicy,
            &source,
            100,
        );
        assert_eq!(source.calls.get(), 2);
        let adoptions = destination.list_knowledge_adoptions(&reader, None)?.items;
        if revoke {
            assert!(result.is_err());
            assert!(adoptions.is_empty());
            let receipts: u64 = destination.connection.query_row(
                "SELECT COUNT(*) FROM integration_publication_receipts",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(receipts, 0);
        } else {
            let adopted = result?;
            assert_eq!(adoptions, vec![adopted.clone()]);
            assert_eq!(adopted.owner, KnowledgeOwner::from(&reader));
            assert_eq!(adopted.publication_owner, owner);
        }
        let bodies: u64 = destination.connection.query_row(
            "SELECT COUNT(*) FROM integration_publications",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(bodies, 0);
    }
    Ok(())
}

#[test]
fn old_owned_adoption_metadata_uses_current_caller_without_rewriting_old_owner() -> Result<()> {
    let root = tempfile::tempdir()?;
    let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let personal = scope("alice");
    let mut catalog = KnowledgeCatalog::open(&root.path().join("personal.sqlite"))?;
    let draft = seed(&mut catalog, &native)?;
    let published = catalog.publish_knowledge(
        &native,
        &personal,
        "old-reference-publish",
        0,
        draft,
        &policy(),
        100,
    )?;
    let owner = KnowledgeOwner::from(&personal);
    let old = catalog.adopt_publication(
        &personal,
        &owner,
        &published.draft.publication_id,
        1,
        "old-reference-adopt",
        0,
        &policy(),
        100,
    )?;
    let mut governed = personal.clone();
    governed.organization_id = Some(IntegrationNullable::Value("current-org".into()));
    assert!(
        catalog
            .list_knowledge_adoptions(&governed, None)?
            .items
            .is_empty()
    );
    assert_eq!(
        catalog
            .list_owned_catalog_adoptions(&governed, &owner, None)?
            .items,
        vec![old.clone()]
    );
    let mut forged = owner.clone();
    forged.account_id = "another-profile".into();
    assert!(
        catalog
            .list_owned_catalog_adoptions(&governed, &forged, None)
            .is_err()
    );
    assert_eq!(
        catalog.list_knowledge_adoptions(&personal, None)?.items,
        vec![old]
    );
    Ok(())
}

#[test]
fn historical_adoption_requires_exact_original_receipt_and_current_enabled_selection() -> Result<()>
{
    for adopt_first in [false, true] {
        let root = tempfile::tempdir()?;
        let actor = scope("alice");
        let native = KnowledgeScope::from_authenticated_host("alice", "local")?;
        let policy = policy();
        let path = root.path().join("wiki.sqlite");
        let mut store = KnowledgeCatalog::open(&path)?;
        let draft = seed(&mut store, &native)?;
        let first = store.publish_knowledge(
            &native,
            &actor,
            "publish-r1",
            0,
            draft.clone(),
            &policy,
            100,
        )?;
        if adopt_first {
            store.adopt_publication(
                &actor,
                &first.owner,
                &draft.publication_id,
                1,
                "adopt-original-r1",
                0,
                &policy,
                101,
            )?;
        }
        let edited = store.edit_page(
            &native,
            &draft.sources[0].library_id,
            &draft.sources[0].page_id,
            &draft.sources[0].page_revision,
            "edit-r2",
            "R2",
            "Second fixed source revision.",
        )?;
        let mut revised = draft.clone();
        revised.sources[0].page_revision = edited.revision_id;
        store.publish_knowledge(&native, &actor, "publish-r2", 1, revised, &policy, 102)?;
        let current = store.adopt_publication(
            &actor,
            &first.owner,
            &draft.publication_id,
            2,
            "explicit-adopt-r2",
            u64::from(adopt_first),
            &policy,
            103,
        )?;
        drop(store);
        let mut store = KnowledgeCatalog::open(&path)?;
        let before = database_observation(&store)?;
        assert_eq!(
            store.has_recorded_publication_adoption(&actor, &current, 1)?,
            adopt_first
        );
        assert!(store.has_recorded_publication_adoption(&actor, &current, 2)?);
        assert!(!store.has_recorded_publication_adoption(&actor, &current, 3)?);
        assert!(
            store
                .has_recorded_publication_adoption(&scope("bob"), &current, 1)
                .is_err()
        );
        assert_eq!(database_observation(&store)?, before);
        let disabled = store.set_knowledge_adoption_enabled(
            &actor,
            &current.id,
            "disable-all-fixed-versions",
            current.revision,
            false,
            &policy,
            104,
        )?;
        assert!(!store.has_recorded_publication_adoption(&actor, &disabled, 1)?);
        assert!(!store.has_recorded_publication_adoption(&actor, &disabled, 2)?);
        assert!(
            store
                .has_recorded_publication_adoption(&actor, &current, 1)
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn historical_adoption_same_publication_id_only_counts_eligible_publishers() -> Result<()> {
    struct Shared;
    impl PublicationAccess for Shared {
        fn check(
            &self,
            _caller: &IntegrationScope,
            _owner: &KnowledgeOwner,
            _id: &str,
            _action: PublicationAction,
        ) -> Result<bool> {
            Ok(true)
        }
        fn check_publish_target(
            &self,
            caller: &IntegrationScope,
            owner: &KnowledgeOwner,
            _draft: &PublicationDraft,
        ) -> Result<bool> {
            Ok(caller.account_id == owner.account_id)
        }
    }
    let root = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
    let mut consumer = scope("reader");
    let mut a = scope("publisher-a");
    let mut b = scope("publisher-b");
    for actor in [&mut consumer, &mut a, &mut b] {
        actor.organization_id = Some(IntegrationNullable::Value("owned-test-org".into()));
    }
    let native_a = KnowledgeScope::from_authenticated_host("publisher-a", "local")?;
    let native_b = KnowledgeScope::from_authenticated_host("publisher-b", "local")?;
    let mut draft_a = seed(&mut store, &native_a)?;
    let mut draft_b = seed(&mut store, &native_b)?;
    draft_b.publication_id = draft_a.publication_id.clone();
    for draft in [&mut draft_a, &mut draft_b] {
        draft.visibility = KnowledgeVisibility::Organization;
        draft.audience_id = Some("owned-test-audience".into());
    }
    let first = store.publish_knowledge(
        &native_a,
        &a,
        "a-publish-1",
        0,
        draft_a.clone(),
        &Shared,
        100,
    )?;
    let other = store.publish_knowledge(
        &native_b,
        &b,
        "b-publish-1",
        0,
        draft_b.clone(),
        &Shared,
        100,
    )?;
    store.publish_knowledge(&native_b, &b, "b-publish-2", 1, draft_b, &Shared, 101)?;
    store.adopt_publication(
        &consumer,
        &first.owner,
        &draft_a.publication_id,
        1,
        "a-adopt-1",
        0,
        &Shared,
        102,
    )?;
    store.adopt_publication(
        &consumer,
        &other.owner,
        &draft_a.publication_id,
        2,
        "b-adopt-2",
        0,
        &Shared,
        102,
    )?;
    let candidates = store.list_knowledge_adoptions(&consumer, None)?.items;
    assert_eq!(candidates.len(), 2);
    let eligible = candidates
        .iter()
        .map(|record| {
            store
                .has_recorded_publication_adoption(&consumer, record, 1)
                .map(|allowed| (record, allowed))
        })
        .collect::<Result<Vec<_>>>()?;
    let eligible = eligible
        .into_iter()
        .filter(|(_, allowed)| *allowed)
        .map(|(record, _)| record)
        .collect::<Vec<_>>();
    assert_eq!(eligible.len(), 1);
    assert_eq!(eligible[0].publication_owner, first.owner);
    let b_current = candidates
        .iter()
        .find(|row| row.publication_owner == other.owner)
        .unwrap();
    store.adopt_publication(
        &consumer,
        &other.owner,
        &draft_a.publication_id,
        1,
        "b-explicitly-adopt-1",
        b_current.revision,
        &Shared,
        103,
    )?;
    let candidates = store.list_knowledge_adoptions(&consumer, None)?.items;
    assert!(candidates.iter().all(|record| {
        store
            .has_recorded_publication_adoption(&consumer, record, 1)
            .unwrap()
    }));
    assert_eq!(candidates.len(), 2); // Both are eligible: the caller must reject ambiguity.
    Ok(())
}
