use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, SourceChunk};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
use serde_json::Value;

#[test]
fn portable_snapshot_preserves_original_history_and_human_edits_without_identity_or_jobs()
-> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut origin = KnowledgeCatalog::open(&temp.path().join("origin.sqlite"))?;
    let alice = KnowledgeScope::from_authenticated_host("secret-alice", "ssh-secret")?;
    let bob = KnowledgeScope::from_authenticated_host("bob", "new-host")?;
    let library = origin.create(&alice, "create", "资料", "保留历史")?;
    let source = origin.import_extracted(
        &alice,
        &library.id,
        "source",
        "测试PDF",
        b"%PDF-original-bytes",
        "pdf",
        vec![SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 1,
            text: "证据 evidence".into(),
            page: Some(3),
        }],
    )?;
    let page = uuid::Uuid::new_v4().to_string();
    let first = origin.commit_generated_pages(
        &alice,
        &library.id,
        "commit",
        vec![KnowledgePageDraft {
            page_id: page.clone(),
            expected_revision: None,
            kind: KnowledgePageKind::Concept,
            title: "主题".into(),
            markdown: "证据 evidence".into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id.clone(),
                revision_id: source.revision_id.clone(),
                chunk_id: "chunk-1".into(),
                quote: "证据".into(),
            }],
            related_page_ids: vec![],
        }],
    )?[0]
        .revision_id
        .clone();
    let second = origin
        .edit_page(
            &alice,
            &library.id,
            &page,
            &first,
            "edit",
            "主题",
            "人工补充 evidence",
        )?
        .revision_id;
    origin.enqueue_ingest(
        &alice,
        &library.id,
        "job-secret",
        &source.source_id,
        &source.revision_id,
        "recipe-secret",
        "中文",
    )?;
    let bytes = origin.export_archive(&alice, &library.id)?;
    let encoded = std::str::from_utf8(&bytes)?;
    for secret in ["secret-alice", "ssh-secret", "job-secret", "recipe-secret"] {
        assert!(!encoded.contains(secret));
    }
    let mut destination = KnowledgeCatalog::open(&temp.path().join("destination.sqlite"))?;
    let imported = destination.import_archive(&bob, "transfer", &bytes)?;
    assert_ne!(imported.id, library.id);
    assert_eq!(
        destination.import_archive(&bob, "transfer", &bytes)?.id,
        imported.id
    );
    assert!(destination.read(&alice, &imported.id).is_err());
    assert_eq!(
        destination
            .read_page(&bob, &imported.id, &page, Some(&first))?
            .draft
            .markdown,
        "证据 evidence"
    );
    let current = destination.read_page(&bob, &imported.id, &page, None)?;
    assert_eq!(current.revision_id, second);
    assert!(current.human_edited);
    assert_eq!(
        destination.source_chunks(
            &bob,
            &imported.id,
            &source.source_id,
            &source.revision_id,
            0,
            1
        )?[0]
            .page,
        Some(3)
    );
    assert!(
        !destination
            .search(&bob, &imported.id, "evidence", 10)?
            .is_empty()
    );
    assert!(
        destination
            .inspect_library(&bob, &imported.id, None, 50)?
            .issues
            .is_empty()
    );
    let again = destination.export_archive(&bob, &imported.id)?;
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes)?,
        serde_json::from_slice::<Value>(&again)?
    );
    let mut invalid: Value = serde_json::from_slice(&bytes)?;
    invalid["version"] = 99.into();
    assert!(
        destination
            .import_archive(&bob, "bad-version", &serde_json::to_vec(&invalid)?)
            .is_err()
    );
    assert!(
        destination
            .import_archive(&bob, "transfer", &serde_json::to_vec(&invalid)?)
            .is_err()
    );
    invalid = serde_json::from_slice(&bytes)?;
    let objects = invalid["objects"].as_object_mut().unwrap();
    let first_key = objects.keys().next().unwrap().clone();
    objects.insert(first_key, "0000".into());
    assert!(
        destination
            .import_archive(&bob, "bad-hash", &serde_json::to_vec(&invalid)?)
            .is_err()
    );
    invalid = serde_json::from_slice(&bytes)?;
    invalid["records"]["knowledge_chunks"][0][6] = "伪造 source text".into();
    assert!(
        destination
            .import_archive(&bob, "forged-chunk", &serde_json::to_vec(&invalid)?)
            .is_err()
    );
    assert_eq!(destination.list(&bob, None, 100)?.len(), 1);
    assert_eq!(
        std::fs::read_dir(temp.path().join("destination.objects"))?.count(),
        1
    );
    Ok(())
}

#[test]
fn docx_sources_survive_portable_transfer() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let owner = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let library = store.create(&owner, "create-docx", "Word", "")?;
    let source = store.import_extracted(
        &owner,
        &library.id,
        "word",
        "report.docx",
        b"original-docx-bytes",
        "docx",
        vec![SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 1,
            text: "中文表格".into(),
            page: None,
        }],
    )?;
    let bytes = store.export_archive(&owner, &library.id)?;
    let imported = store.import_archive(&owner, "copy-docx", &bytes)?;
    let chunks = store.source_chunks(
        &owner,
        &imported.id,
        &source.source_id,
        &source.revision_id,
        0,
        10,
    )?;
    assert_eq!(chunks[0].text, "中文表格");
    assert_eq!(chunks[0].page, None);
    Ok(())
}

#[test]
fn image_replay_requires_same_original_and_owner() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let owner = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let other = KnowledgeScope::from_authenticated_host("other", "local")?;
    let library = store.create(&owner, "images", "Images", "")?;
    let source = store.import_extracted(
        &owner,
        &library.id,
        "img",
        "image.png",
        b"image-bytes",
        "image",
        vec![SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 1,
            text: "Visual interpretation".into(),
            page: None,
        }],
    )?;
    assert_eq!(
        store
            .replay_image_import(
                &owner,
                &library.id,
                "img",
                "image.png",
                b"image-bytes",
                None
            )?
            .unwrap()
            .revision_id,
        source.revision_id
    );
    assert!(
        store
            .replay_image_import(&owner, &library.id, "img", "image.png", b"changed", None)
            .is_err()
    );
    assert!(
        store
            .replay_image_import(
                &other,
                &library.id,
                "img",
                "image.png",
                b"image-bytes",
                None
            )
            .is_err()
    );
    let archive = store.export_archive(&owner, &library.id)?;
    assert!(
        store
            .import_archive(&owner, "images-copy", &archive)
            .is_ok()
    );
    Ok(())
}
