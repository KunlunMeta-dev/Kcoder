use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

fn draft(id: &str, citation: KnowledgeCitation, body: &str) -> KnowledgePageDraft {
    KnowledgePageDraft {
        page_id: id.into(),
        expected_revision: None,
        kind: KnowledgePageKind::Concept,
        title: "版本兼容性".into(),
        markdown: body.into(),
        citations: vec![citation],
        related_page_ids: vec![],
    }
}
fn import(
    store: &mut KnowledgeCatalog,
    scope: &KnowledgeScope,
    library: &str,
    key: &str,
    text: &str,
) -> Result<KnowledgeCitation> {
    let revision = store.import_text(scope, library, key, "产品资料", text)?;
    let chunks = store.source_chunks(
        scope,
        library,
        &revision.source_id,
        &revision.revision_id,
        0,
        1,
    )?;
    Ok(KnowledgeCitation {
        source_id: revision.source_id,
        revision_id: revision.revision_id,
        chunk_id: chunks[0].chunk_id.clone(),
        quote: text.into(),
    })
}

#[test]
fn wiki_evolves_without_overwriting_historical_evidence_and_rejects_stale_writers() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("state.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "ssh-server")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "研发 Wiki", "保留不同版本的适用范围")?;
    let citation = import(
        &mut store,
        &scope,
        &library.id,
        "source-1",
        "第一版支持协议 A。",
    )?;
    let page_id = uuid::Uuid::new_v4().to_string();
    let first = draft(&page_id, citation.clone(), "第一版支持协议 A。");
    let committed =
        store.commit_generated_pages(&scope, &library.id, "write-1", vec![first.clone()])?;
    assert_eq!(
        store.commit_generated_pages(&scope, &library.id, "write-1", vec![first])?,
        committed
    );
    let previous_revision = committed[0].revision_id.clone();
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    let second_citation = import(
        &mut store,
        &scope,
        &library.id,
        "source-2",
        "第二版增加协议 B。",
    )?;
    let mut second = draft(
        &page_id,
        second_citation,
        "第一版支持协议 A；第二版增加协议 B。",
    );
    second.expected_revision = Some(previous_revision.clone());
    second.citations.push(citation);
    let second_commit =
        store.commit_generated_pages(&scope, &library.id, "write-2", vec![second.clone()])?;
    let mut stale = KnowledgeCatalog::open(&path)?;
    assert!(
        stale
            .commit_generated_pages(&scope, &library.id, "stale", vec![second])
            .is_err()
    );
    assert_eq!(
        store
            .read_page(&scope, &library.id, &page_id, Some(&previous_revision))?
            .draft
            .markdown,
        "第一版支持协议 A。"
    );
    assert_eq!(
        store
            .read_page(&scope, &library.id, &page_id, None)?
            .revision_id,
        second_commit[0].revision_id
    );
    assert_eq!(
        store.search(&scope, &library.id, "协议 B", 20)?[0].revision_id,
        second_commit[0].revision_id
    );
    let bob = KnowledgeScope::from_authenticated_host("bob", "ssh-server")?;
    assert!(store.read_page(&bob, &library.id, &page_id, None).is_err());
    Ok(())
}

#[test]
fn invalid_batch_does_not_publish_any_page_or_index_entry() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let citation = import(&mut store, &scope, &library.id, "source", "原始证据。")?;
    let valid = draft(
        &uuid::Uuid::new_v4().to_string(),
        citation.clone(),
        "原始证据。",
    );
    let mut invalid = draft(&uuid::Uuid::new_v4().to_string(), citation, "不能发表。");
    invalid.citations[0].quote = "伪造的引文".into();
    assert!(
        store
            .commit_generated_pages(&scope, &library.id, "batch", vec![valid.clone(), invalid])
            .is_err()
    );
    assert!(
        store
            .read_page(&scope, &library.id, &valid.page_id, None)
            .is_err()
    );
    assert!(
        store
            .search(&scope, &library.id, "版本兼容性", 20)?
            .is_empty()
    );
    assert!(
        store
            .commit_generated_pages(&scope, &library.id, "batch", vec![valid])
            .is_ok()
    );
    Ok(())
}

#[test]
fn source_import_retries_and_long_single_line_chunks_preserve_bytes() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("state.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "ssh")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let text = "超长单行原文".repeat(5000) + "\n第二行\n";
    let source = store.import_text(&scope, &library.id, "source", "原件.md", &text)?;
    assert_eq!(
        source,
        store.import_text(&scope, &library.id, "source", "原件.md", &text)?
    );
    assert!(
        store
            .import_text(&scope, &library.id, "source", "原件.md", "changed")
            .is_err()
    );
    let mut recovered = String::new();
    let mut ordinal = 0;
    loop {
        let chunk = store.source_chunks(
            &scope,
            &library.id,
            &source.source_id,
            &source.revision_id,
            ordinal,
            1,
        )?;
        let Some(chunk) = chunk.first() else {
            break;
        };
        assert!(chunk.text.len() <= 16 * 1024);
        assert!(chunk.ordinal > ordinal);
        ordinal = chunk.ordinal;
        recovered.push_str(&chunk.text);
    }
    assert_eq!(recovered, text);
    drop(store);
    let store = KnowledgeCatalog::open(&path)?;
    assert_eq!(
        store.read_source(&scope, &library.id, &source.source_id, &source.revision_id)?,
        text
    );
    Ok(())
}

#[test]
fn pdf_original_and_physical_page_citations_survive_restart() -> Result<()> {
    use kcoder_knowledge::SourceChunk;
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("wiki.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "library", "PDF Wiki", "")?;
    let chunks = vec![SourceChunk {
        ordinal: 1,
        chunk_id: "chunk-1".into(),
        first_line: 1,
        last_line: 1,
        text: "第25页证据".into(),
        page: Some(25),
    }];
    let original = b"%PDF-1.4 synthetic original";
    let source = store.import_extracted(
        &scope,
        &library.id,
        "pdf",
        "manual.pdf",
        original,
        "pdf",
        chunks.clone(),
    )?;
    assert_eq!(
        store.import_extracted(
            &scope,
            &library.id,
            "pdf",
            "manual.pdf",
            original,
            "pdf",
            chunks.clone()
        )?,
        source
    );
    assert!(
        store
            .import_extracted(
                &scope,
                &library.id,
                "pdf",
                "manual.pdf",
                b"different bytes",
                "pdf",
                chunks
            )
            .is_err()
    );
    drop(store);
    let store = KnowledgeCatalog::open(&path)?;
    let (_, chunk) = store.resolve_citation(
        &scope,
        &library.id,
        &source.source_id,
        &source.revision_id,
        "chunk-1",
    )?;
    assert_eq!(chunk.page, Some(25));
    assert_eq!(chunk.text, "第25页证据");
    Ok(())
}
