use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, WikiMarkdownBundle};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

#[test]
fn external_markdown_edits_are_atomic_human_revisions_with_cas_and_evidence() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut catalog = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let stranger = KnowledgeScope::from_authenticated_host("bob", "local")?;
    let library = catalog.create(&scope, "create", "Wiki", "")?;
    let source = catalog.import_text(&scope, &library.id, "source", "Source", "evidence")?;
    let pages = (1..=3)
        .map(|number| KnowledgePageDraft {
            page_id: uuid::Uuid::from_u128(number).to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: format!("Page {number}"),
            markdown: format!("Initial {number}"),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id.clone(),
                revision_id: source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: "evidence".into(),
            }],
            related_page_ids: vec![],
        })
        .collect();
    catalog.commit_generated_pages(&scope, &library.id, "commit", pages)?;
    assert!(
        catalog
            .export_markdown_bundle(&stranger, &library.id)
            .is_err()
    );
    let original = catalog.export_markdown_bundle(&scope, &library.id)?;
    assert!(
        catalog
            .import_markdown_bundle(&scope, &library.id, "unchanged", &original)?
            .is_empty()
    );
    let mut stale: WikiMarkdownBundle = serde_json::from_slice(&original)?;
    for page in &stale.pages {
        assert_eq!(page.name, format!("{}.md", page.page_id));
    }
    let last = &stale.pages[2];
    catalog.edit_page(
        &scope,
        &library.id,
        &last.page_id,
        &last.base_revision,
        "concurrent",
        "Concurrent title",
        "Concurrent content",
    )?;
    stale.pages[0].body = "External first edit".into();
    stale.pages[1].body = "External second edit".into();
    assert!(
        catalog
            .import_markdown_bundle(&scope, &library.id, "batch", &serde_json::to_vec(&stale)?)
            .is_err()
    );
    for page in &stale.pages[..2] {
        let current = catalog.read_page(&scope, &library.id, &page.page_id, None)?;
        assert_eq!(current.revision_id, page.base_revision);
        assert!(!current.human_edited);
    }
    let mut bundle: WikiMarkdownBundle =
        serde_json::from_slice(&catalog.export_markdown_bundle(&scope, &library.id)?)?;
    bundle.pages[0].body = "External first edit".into();
    bundle.pages[1].body = "External second edit".into();
    bundle.pages[1].title = "Edited title".into();
    let bytes = serde_json::to_vec(&bundle)?;
    assert!(
        catalog
            .import_markdown_bundle(&stranger, &library.id, "batch", &bytes)
            .is_err()
    );
    let applied = catalog.import_markdown_bundle(&scope, &library.id, "batch", &bytes)?;
    assert_eq!(applied.len(), 2);
    assert_eq!(
        catalog.import_markdown_bundle(&scope, &library.id, "batch", &bytes)?,
        applied
    );
    for page in &bundle.pages[..2] {
        let current = catalog.read_page(&scope, &library.id, &page.page_id, None)?;
        assert!(current.human_edited);
        assert_eq!(current.draft.markdown, page.body);
        assert_eq!(current.draft.citations[0].source_id, source.source_id);
        assert_eq!(
            catalog.page_history(&scope, &library.id, &page.page_id, None, 10)?[0].author,
            "human"
        );
        assert!(
            catalog
                .read_page(
                    &scope,
                    &library.id,
                    &page.page_id,
                    Some(&page.base_revision)
                )?
                .draft
                .markdown
                .starts_with("Initial")
        );
    }
    assert_eq!(
        catalog
            .read_page(&scope, &library.id, &bundle.pages[2].page_id, None)?
            .draft
            .markdown,
        "Concurrent content"
    );
    bundle.pages[0].body = "Different replay payload".into();
    assert!(
        catalog
            .import_markdown_bundle(&scope, &library.id, "batch", &serde_json::to_vec(&bundle)?)
            .is_err()
    );
    let mut invalid: WikiMarkdownBundle =
        serde_json::from_slice(&catalog.export_markdown_bundle(&scope, &library.id)?)?;
    invalid.pages[0].name = "../outside.md".into();
    assert!(
        catalog
            .import_markdown_bundle(&scope, &library.id, "path", &serde_json::to_vec(&invalid)?)
            .is_err()
    );
    invalid.pages[0].name = format!("{}.md", invalid.pages[0].page_id);
    let second_library = catalog.create(&scope, "other", "Other", "")?;
    assert!(
        catalog
            .import_markdown_bundle(
                &scope,
                &second_library.id,
                "foreign",
                &serde_json::to_vec(&invalid)?
            )
            .is_err()
    );
    invalid.pages.truncate(1);
    invalid.pages[0].body = "A single explicit page update".into();
    assert_eq!(
        catalog
            .import_markdown_bundle(
                &scope,
                &library.id,
                "partial",
                &serde_json::to_vec(&invalid)?
            )?
            .len(),
        1
    );
    assert_eq!(catalog.list_pages(&scope, &library.id, None, 100)?.len(), 3);
    let latest = catalog.export_markdown_bundle(&scope, &library.id)?;
    catalog.set_archived(&scope, &library.id, 1, true)?;
    assert!(
        catalog
            .import_markdown_bundle(&scope, &library.id, "archived", &latest)
            .is_err()
    );
    Ok(())
}
