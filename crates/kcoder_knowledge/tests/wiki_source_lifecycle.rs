use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, SourceChunk};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
fn chunks(text: &str) -> Vec<SourceChunk> {
    vec![SourceChunk {
        page: Some(7),
        ordinal: 1,
        chunk_id: "chunk-1".into(),
        first_line: 1,
        last_line: 1,
        text: text.into(),
    }]
}
#[test]
fn original_bytes_are_revision_scoped_and_not_readable_by_another_account() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut db = KnowledgeCatalog::open(&temp.path().join("db.sqlite"))?;
    let owner = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let other = KnowledgeScope::from_authenticated_host("bob", "local")?;
    let lib = db.create(&owner, "original", "Wiki", "")?;
    let source = db.import_extracted(
        &owner,
        &lib.id,
        "source",
        "原图.png",
        b"original-image",
        "image",
        chunks("Vision description"),
    )?;
    assert_eq!(
        db.original_source(&owner, &lib.id, &source.source_id, &source.revision_id)?,
        (
            "原图.png".into(),
            "image".into(),
            b"original-image".to_vec()
        )
    );
    assert!(
        db.original_source(&other, &lib.id, &source.source_id, &source.revision_id)
            .is_err()
    );
    assert!(
        db.original_source(&owner, &lib.id, &source.source_id, "unknown")
            .is_err()
    );
    Ok(())
}

#[test]
fn html_original_and_extracted_evidence_survive_portable_archive() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&scope, "html", "Wiki", "")?;
    let raw = b"<p>Evidence</p><script>inactive</script>";
    let source = store.import_extracted(
        &scope,
        &library.id,
        "html-source",
        "source.html",
        raw,
        "html",
        chunks("Evidence"),
    )?;
    let bytes = store.export_archive(&scope, &library.id)?;
    let other = KnowledgeScope::from_authenticated_host("bob", "remote")?;
    let restored = store.import_archive(&other, "restore-html", &bytes)?;
    assert_eq!(
        store.original_source(&other, &restored.id, &source.source_id, &source.revision_id)?,
        ("source.html".into(), "html".into(), raw.to_vec())
    );
    assert_eq!(
        store.read_source(&other, &restored.id, &source.source_id, &source.revision_id)?,
        "Evidence"
    );
    Ok(())
}
#[test]
fn update_remove_restore_preserve_evidence_and_human_pages() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut db = KnowledgeCatalog::open(&temp.path().join("db.sqlite"))?;
    let owner = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let stranger = KnowledgeScope::from_authenticated_host("bob", "local")?;
    let lib = db.create(&owner, "create", "Wiki", "")?;
    let old = db.import_extracted(
        &owner,
        &lib.id,
        "source",
        "资料",
        b"original1",
        "pdf",
        chunks("old_evidence"),
    )?;
    let page = uuid::Uuid::new_v4().to_string();
    let initial = db.commit_generated_pages(
        &owner,
        &lib.id,
        "commit",
        vec![KnowledgePageDraft {
            page_id: page.clone(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "知识".into(),
            markdown: "old_evidence".into(),
            citations: vec![KnowledgeCitation {
                source_id: old.source_id.clone(),
                revision_id: old.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: "old_evidence".into(),
            }],
            related_page_ids: vec![],
        }],
    )?[0]
        .revision_id
        .clone();
    db.edit_page(
        &owner,
        &lib.id,
        &page,
        &initial,
        "human",
        "知识",
        "human content",
    )?;
    let job = db.enqueue_ingest(
        &owner,
        &lib.id,
        "job",
        &old.source_id,
        &old.revision_id,
        "recipe",
        "中文",
    )?;
    let lease = db.claim_job(&owner, &lib.id, &job.id)?.expect("claimed");
    let newer = db.update_source(
        &owner,
        &lib.id,
        &old.source_id,
        &old.revision_id,
        "update",
        "资料",
        b"original2",
        "pdf",
        chunks("new_evidence"),
    )?;
    assert_eq!(newer.source_id, old.source_id);
    assert!(db.heartbeat_job(&owner, &lib.id, &lease).is_err());
    assert_ne!(newer.revision_id, old.revision_id);
    assert_eq!(
        db.update_source(
            &owner,
            &lib.id,
            &old.source_id,
            &old.revision_id,
            "update",
            "资料",
            b"original2",
            "pdf",
            chunks("new_evidence")
        )?,
        newer
    );
    assert!(
        db.update_source(
            &owner,
            &lib.id,
            &old.source_id,
            &old.revision_id,
            "stale",
            "资料",
            b"3",
            "pdf",
            chunks("other")
        )
        .is_err()
    );
    assert_eq!(
        db.list_sources(&owner, &lib.id, None, 10)?,
        vec![newer.clone()]
    );
    assert_eq!(db.read_job(&owner, &lib.id, &job.id)?.status, "paused");
    assert!(db.resume_job(&owner, &lib.id, &job.id).is_err());
    assert!(
        db.search(&owner, &lib.id, "old_evidence", 10)?
            .iter()
            .all(|hit| !hit.document_id.starts_with("source:"))
    );
    let cite = db.resolve_citation(&owner, &lib.id, &old.source_id, &old.revision_id, "chunk-1")?;
    assert!(!cite.0.removed);
    assert_eq!(cite.1.page, Some(7));
    assert_eq!(
        db.affected_pages(&owner, &lib.id, &old.source_id, None, 10)?[0].page_id,
        page
    );
    assert!(db.affected_pages(&owner, &lib.id, &old.source_id, None, 10)?[0].human_edited);
    assert!(
        db.set_source_removed(&stranger, &lib.id, &old.source_id, &newer.revision_id, true)
            .is_err()
    );
    db.set_source_removed(&owner, &lib.id, &old.source_id, &newer.revision_id, true)?;
    assert!(db.list_sources(&owner, &lib.id, None, 10)?.is_empty());
    assert_eq!(db.list_removed_sources(&owner, &lib.id, None, 10)?.len(), 1);
    assert!(db.search(&owner, &lib.id, "new_evidence", 10)?.is_empty());
    assert!(
        db.resolve_citation(&owner, &lib.id, &old.source_id, &old.revision_id, "chunk-1")?
            .0
            .removed
    );
    assert!(
        db.enqueue_ingest(
            &owner,
            &lib.id,
            "removed-job",
            &old.source_id,
            &newer.revision_id,
            "r",
            "中文"
        )
        .is_err()
    );
    let bytes = db.export_archive(&owner, &lib.id)?;
    let imported = db.import_archive(&stranger, "import", &bytes)?;
    assert!(
        db.source_status(&stranger, &imported.id, &old.source_id)?
            .removed
    );
    db.set_source_removed(&owner, &lib.id, &old.source_id, &newer.revision_id, false)?;
    assert_eq!(db.list_sources(&owner, &lib.id, None, 10)?.len(), 1);
    assert!(!db.search(&owner, &lib.id, "new_evidence", 10)?.is_empty());
    assert_eq!(
        db.read_page(&owner, &lib.id, &page, None)?.draft.markdown,
        "human content"
    );
    let mut legacy: serde_json::Value = serde_json::from_slice(&bytes)?;
    legacy["version"] = 1.into();
    legacy["records"]
        .as_object_mut()
        .unwrap()
        .remove("knowledge_source_lifecycle");
    let legacy_import = db.import_archive(&stranger, "legacy", &serde_json::to_vec(&legacy)?)?;
    assert!(
        !db.source_status(&stranger, &legacy_import.id, &old.source_id)?
            .removed
    );
    assert_eq!(
        db.source_status(&stranger, &legacy_import.id, &old.source_id)?
            .current_revision,
        newer.revision_id
    );
    Ok(())
}

#[test]
fn version_eleven_migration_selects_last_source_revision_without_erasing_history() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("migration.sqlite");
    let owner = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&owner, "create", "Wiki", "")?;
    let first = store.import_text(&owner, &library.id, "original", "Source", "first")?;
    let newer = store.update_source(
        &owner,
        &library.id,
        &first.source_id,
        &first.revision_id,
        "update",
        "Source",
        b"second",
        "text",
        chunks("second"),
    )?;
    drop(store);
    let legacy = rusqlite::Connection::open(&path)?;
    // Reconstruct the actual v11 schema, not only its version marker.
    legacy.execute_batch("DROP TABLE knowledge_image_import_calls; DROP TABLE knowledge_image_imports; DROP TABLE knowledge_pipeline_stages; DROP TABLE knowledge_automatic_merge_leases; ALTER TABLE knowledge_jobs DROP COLUMN pipeline_version; DROP TABLE knowledge_job_calls; DROP TABLE knowledge_job_budgets; DROP TABLE knowledge_stage_cache; DROP TABLE knowledge_source_lifecycle; DROP TABLE knowledge_source_extractions; ALTER TABLE knowledge_jobs DROP COLUMN progress_json; PRAGMA user_version=11;")?;
    drop(legacy);
    let store = KnowledgeCatalog::open(&path)?;
    let status = store.source_status(&owner, &library.id, &first.source_id)?;
    assert_eq!(status.current_revision, newer.revision_id);
    assert!(!status.removed);
    assert_eq!(store.list_sources(&owner, &library.id, None, 10)?.len(), 1);
    assert_eq!(
        store.read_source(&owner, &library.id, &first.source_id, &first.revision_id)?,
        "first"
    );
    Ok(())
}
