use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

#[test]
fn navigation_is_current_scoped_bounded_and_independent_of_body_files() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("wiki.sqlite");
    let mut catalog = KnowledgeCatalog::open(&path)?;
    let alice = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let bob = KnowledgeScope::from_authenticated_host("bob", "local")?;
    let library = catalog.create(&alice, "create", "Wiki", "")?;
    let other = catalog.create(&bob, "create", "Private", "")?;
    let source = catalog.import_text(&alice, &library.id, "source", "Source", "evidence")?;
    let ids = (1..=5)
        .map(|index| uuid::Uuid::from_u128(index).to_string())
        .collect::<Vec<_>>();
    let links = [
        vec![ids[1].clone(), ids[2].clone()],
        vec![ids[0].clone(), ids[3].clone()],
        vec![ids[0].clone()],
        vec![ids[1].clone()],
        vec![],
    ];
    let drafts = ids
        .iter()
        .enumerate()
        .map(|(index, id)| KnowledgePageDraft {
            page_id: id.clone(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: format!("Page {index}"),
            markdown: format!("body-{index}"),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id.clone(),
                revision_id: source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: "evidence".into(),
            }],
            related_page_ids: links[index].clone(),
        })
        .collect::<Vec<_>>();
    let revisions =
        catalog.commit_generated_pages(&alice, &library.id, "commit", drafts.clone())?;
    let limited = catalog.page_links(&alice, &library.id, &ids[0], 1)?;
    assert_eq!(limited.outgoing.len(), 1);
    assert_eq!(limited.incoming.len(), 1);
    assert!(limited.outgoing_truncated && limited.incoming_truncated);
    assert_eq!(limited.outgoing[0].page_id, ids[1]);
    let edited = catalog.edit_page(
        &alice,
        &library.id,
        &ids[1],
        &revisions[1].revision_id,
        "human",
        "Human title",
        "Human body",
    )?;
    let full = catalog.page_links(&alice, &library.id, &ids[0], 20)?;
    assert_eq!(full.outgoing.len(), 2);
    assert_eq!(full.incoming.len(), 2);
    assert!(!full.outgoing_truncated && !full.incoming_truncated);
    assert_eq!(full.outgoing[0].title, "Human title");
    assert_eq!(full.outgoing[0].revision_id, edited.revision_id);
    assert!(full.outgoing[0].human_edited);
    let mut no_longer_links = drafts[2].clone();
    no_longer_links.expected_revision = Some(revisions[2].revision_id.clone());
    no_longer_links.related_page_ids.clear();
    catalog.commit_generated_pages(&alice, &library.id, "remove-link", vec![no_longer_links])?;
    assert_eq!(
        catalog
            .page_links(&alice, &library.id, &ids[0], 20)?
            .incoming
            .len(),
        1
    );
    assert!(
        catalog
            .page_links(&alice, &library.id, &ids[4], 20)?
            .outgoing
            .is_empty()
    );
    assert!(
        catalog
            .page_links(&alice, &library.id, &ids[4], 20)?
            .incoming
            .is_empty()
    );
    assert!(
        catalog
            .page_links(&alice, &library.id, &uuid::Uuid::new_v4().to_string(), 20)
            .is_err()
    );
    assert!(catalog.page_links(&bob, &library.id, &ids[0], 20).is_err());
    assert!(catalog.page_links(&alice, &other.id, &ids[0], 20).is_err());
    for limit in [0, 21] {
        assert!(
            catalog
                .page_links(&alice, &library.id, &ids[0], limit)
                .is_err()
        );
    }
    // Removing isolated test objects proves navigation never loads Markdown bodies.
    for entry in std::fs::read_dir(path.with_extension("objects").join(&library.id))? {
        std::fs::remove_file(entry?.path())?;
    }
    assert_eq!(
        catalog
            .page_links(&alice, &library.id, &ids[0], 20)?
            .outgoing
            .len(),
        2
    );
    Ok(())
}
