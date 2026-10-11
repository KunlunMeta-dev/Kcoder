use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use rusqlite::{Connection, params};

#[test]
fn archive_restore_and_index_rebuild_preserve_history_and_scope() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("state.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let denied = KnowledgeScope::from_authenticated_host("bob", "local")?;
    let library = store.create(&scope, "one", "Wiki", "")?;
    let other = store.create(&scope, "two", "Other", "")?;
    let source = store.import_text(&scope, &library.id, "s", "原文", "协议证据 evidence")?;
    store.import_text(&scope, &other.id, "s", "Other", "other-only")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "中文",
    )?;
    let page_id = uuid::Uuid::new_v4().to_string();
    let page = KnowledgePageDraft {
        page_id: page_id.clone(),
        expected_revision: None,
        kind: KnowledgePageKind::Concept,
        title: "概念".into(),
        markdown: "协议证据 evidence".into(),
        citations: vec![KnowledgeCitation {
            source_id: source.source_id.clone(),
            revision_id: source.revision_id.clone(),
            chunk_id: "chunk-1".into(),
            quote: "协议证据".into(),
        }],
        related_page_ids: vec![],
    };
    let revision = store.commit_generated_pages(&scope, &library.id, "commit", vec![page])?[0]
        .revision_id
        .clone();
    store.set_default_library(&scope, &library.id)?;
    assert!(store.set_archived(&denied, &library.id, 1, true).is_err());
    let archived = store.set_archived(&scope, &library.id, 1, true)?;
    assert!(archived.archived);
    assert!(store.search(&scope, &library.id, "evidence", 10).is_err());
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "paused"
    );
    assert!(store.set_archived(&scope, &library.id, 1, false).is_err());
    let restored = store.set_archived(&scope, &library.id, archived.revision, false)?;
    assert!(!restored.archived);
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "paused"
    );
    let db = Connection::open(&path)?;
    db.execute(
        "DELETE FROM knowledge_fts WHERE library_id=?1",
        [&library.id],
    )?;
    assert!(
        store
            .search(&scope, &library.id, "evidence", 10)?
            .is_empty()
    );
    assert!(store.rebuild_index(&denied, &library.id).is_err());
    let report = store.rebuild_index(&scope, &library.id)?;
    assert_eq!(report.source_chunks, 1);
    assert_eq!(report.current_pages, 1);
    assert_eq!(store.search(&scope, &library.id, "evidence", 10)?.len(), 2);
    assert_eq!(store.search(&scope, &other.id, "other-only", 10)?.len(), 1);
    assert_eq!(
        store
            .read_page(&scope, &library.id, &page_id, Some(&revision))?
            .revision_id,
        revision
    );
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "paused"
    );
    let first = store.inspect_library(&scope, &library.id, None, 1)?;
    assert!(first.issues.is_empty());
    assert!(first.next_cursor.is_some());
    assert!(
        store
            .inspect_library(&denied, &library.id, None, 10)
            .is_err()
    );
    db.execute(
        "UPDATE knowledge_page_revisions SET related_json=?1 WHERE library_id=?2",
        params![
            serde_json::to_string(&vec![uuid::Uuid::new_v4().to_string()])?,
            library.id
        ],
    )?;
    let inspected = store.inspect_library(&scope, &library.id, None, 50)?;
    assert!(
        inspected
            .issues
            .iter()
            .any(|issue| issue.code == "broken_related_page")
    );
    // Rebuild failure must retain the previous searchable index.
    db.execute(
        "UPDATE knowledge_page_revisions SET body_hash=?1 WHERE library_id=?2",
        params!["0".repeat(64), library.id],
    )?;
    assert!(store.rebuild_index(&scope, &library.id).is_err());
    assert_eq!(store.search(&scope, &library.id, "evidence", 10)?.len(), 2);
    assert!(
        store
            .inspect_library(&scope, &library.id, None, 50)?
            .issues
            .iter()
            .any(|issue| issue.code == "page_object_unavailable")
    );
    Ok(())
}

#[test]
fn rebuilding_keeps_every_source_revision_and_pdf_page_locator() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("state.sqlite");
    let mut store = KnowledgeCatalog::open(&path)?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_extracted(
        &scope,
        &library.id,
        "source",
        "PDF",
        b"%PDF-evidence",
        "pdf",
        vec![kcoder_knowledge::SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 1,
            text: "历史证据 evidence".into(),
            page: Some(17),
        }],
    )?;
    let newer = uuid::Uuid::new_v4().to_string();
    let db = Connection::open(&path)?;
    db.execute("INSERT INTO knowledge_sources(library_id,source_id,revision_id,request_key,title,body_hash) SELECT library_id,source_id,?1,'source-v2',title,body_hash FROM knowledge_sources WHERE library_id=?2", params![newer,library.id])?;
    db.execute("INSERT INTO knowledge_chunks(library_id,source_id,revision_id,chunk_id,ordinal,first_line,last_line,text,page) SELECT library_id,source_id,?1,chunk_id,ordinal,first_line,last_line,text,page FROM knowledge_chunks WHERE library_id=?2", params![newer,library.id])?;
    let report = store.rebuild_index(&scope, &library.id)?;
    assert_eq!(report.source_chunks, 2);
    let hits = store.search(&scope, &library.id, "evidence", 10)?;
    assert_eq!(hits.len(), 1);
    let indexed: usize = db.query_row(
        "SELECT COUNT(*) FROM knowledge_fts WHERE library_id=?1",
        [&library.id],
        |row| row.get(0),
    )?;
    assert_eq!(indexed, 2);
    let revisions = hits
        .iter()
        .map(|hit| hit.revision_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        revisions,
        std::collections::BTreeSet::from([source.revision_id.as_str()])
    );
    for hit in hits {
        assert_eq!(
            store
                .resolve_citation(
                    &scope,
                    &library.id,
                    &source.source_id,
                    &hit.revision_id,
                    "chunk-1"
                )?
                .1
                .page,
            Some(17)
        );
    }
    Ok(())
}
