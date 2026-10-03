use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, WikiCheckpoint, WikiProposal};
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

#[test]
fn first_resume_refreshes_stale_drafts_but_keeps_committed_checkpoint_receipts() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("db.sqlite"))?;
    let owner = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let library = store.create(&owner, "create", "Wiki", "")?;
    let source = store.import_text(&owner, &library.id, "source", "Source", "evidence")?;
    let draft = |page: String, expected: Option<String>, body: &str| KnowledgePageDraft {
        page_id: page,
        expected_revision: expected,
        kind: KnowledgePageKind::Concept,
        title: "Page".into(),
        markdown: body.into(),
        citations: vec![KnowledgeCitation {
            source_id: source.source_id.clone(),
            revision_id: source.revision_id.clone(),
            chunk_id: "chunk-1".into(),
            quote: "evidence".into(),
        }],
        related_page_ids: vec![],
    };
    let checkpoint = |page| WikiCheckpoint {
        through_chunk: 1,
        has_more_chunks: false,
        proposal: WikiProposal {
            pages: vec![page],
            review_notes: vec![],
        },
    };
    let page = uuid::Uuid::new_v4().to_string();
    let initial = store.commit_generated_pages(
        &owner,
        &library.id,
        "initial",
        vec![draft(page.clone(), None, "Initial")],
    )?[0]
        .revision_id
        .clone();
    let job = store.enqueue_ingest(
        &owner,
        &library.id,
        "job1",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = store.claim_job(&owner, &library.id, &job.id)?.unwrap();
    store.save_job_checkpoint(
        &owner,
        &library.id,
        &lease,
        &checkpoint(draft(
            page.clone(),
            Some(initial.clone()),
            "Prepared candidate",
        )),
    )?;
    store.pause_job(&owner, &library.id, &job.id)?;
    store.edit_page(
        &owner,
        &library.id,
        &page,
        &initial,
        "human",
        "Page",
        "Concurrent human edit",
    )?;
    store.resume_job(&owner, &library.id, &job.id)?;
    assert!(
        store
            .job_checkpoint(&owner, &library.id, &job.id)?
            .is_none()
    );
    assert_eq!(
        store
            .read_page(&owner, &library.id, &page, None)?
            .draft
            .markdown,
        "Concurrent human edit"
    );

    let second_page = uuid::Uuid::new_v4().to_string();
    let second = store.enqueue_ingest(
        &owner,
        &library.id,
        "job2",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = store.claim_job(&owner, &library.id, &second.id)?.unwrap();
    let reservation = store
        .budget_reserve(&owner, &library.id, &lease, 64)?
        .unwrap();
    store.budget_record_usage(&owner, &library.id, &reservation, None)?;
    store.save_job_checkpoint(
        &owner,
        &library.id,
        &lease,
        &checkpoint(draft(second_page.clone(), None, "Published before crash")),
    )?;
    let published = store.commit_job_checkpoint(&owner, &library.id, &lease)?;
    // Simulate a pause/crash boundary after commit but before finishing the job.
    store.pause_job(&owner, &library.id, &second.id)?;
    let human = store.edit_page(
        &owner,
        &library.id,
        &second_page,
        &published[0].revision_id,
        "later-human",
        "Page",
        "Later human revision",
    )?;
    store.resume_job(&owner, &library.id, &second.id)?;
    assert!(
        store
            .job_checkpoint(&owner, &library.id, &second.id)?
            .is_some()
    );
    let resumed = store.claim_job(&owner, &library.id, &second.id)?.unwrap();
    assert_eq!(
        store.commit_job_checkpoint(&owner, &library.id, &resumed)?,
        published
    );
    store.finish_job_batch(&owner, &library.id, &resumed)?;
    assert_eq!(
        store.read_job(&owner, &library.id, &second.id)?.status,
        "completed"
    );
    assert_eq!(
        store
            .read_page(&owner, &library.id, &second_page, None)?
            .revision_id,
        human.revision_id
    );
    assert_eq!(
        store
            .budget_read(&owner, &library.id, &second.id)?
            .reserved_calls,
        1
    );
    Ok(())
}
