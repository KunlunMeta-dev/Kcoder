use crate::*;
use anyhow::Result;
use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};

#[test]
fn recovered_job_reuses_prepared_output_and_commit_receipt_without_duplicate_pages() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("state.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "server")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "资料", "原始证据")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe-v1",
        "zh-CN",
    )?;
    assert_eq!(
        job.id,
        store
            .enqueue_ingest(
                &scope,
                &library.id,
                "job",
                &source.source_id,
                &source.revision_id,
                "recipe-v1",
                "zh-CN"
            )?
            .id
    );
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    let mut other = KnowledgeCatalog::open(&path)?;
    assert!(other.claim_job(&scope, &library.id, &job.id)?.is_none());
    let page_id = uuid::Uuid::new_v4().to_string();
    let checkpoint = WikiCheckpoint {
        through_chunk: 1,
        has_more_chunks: false,
        proposal: WikiProposal {
            pages: vec![KnowledgePageDraft {
                page_id: page_id.clone(),
                expected_revision: None,
                kind: KnowledgePageKind::Concept,
                title: "主题".into(),
                markdown: "原始证据".into(),
                citations: vec![KnowledgeCitation {
                    source_id: source.source_id,
                    revision_id: source.revision_id,
                    chunk_id: "chunk-1".into(),
                    quote: "原始证据".into(),
                }],
                related_page_ids: vec![],
            }],
            review_notes: vec![],
        },
    };
    store.save_job_checkpoint(&scope, &library.id, &lease, &checkpoint)?;
    assert!(store.finish_job_batch(&scope, &library.id, &lease).is_err());
    other.pause_job(&scope, &library.id, &job.id)?;
    assert!(store.heartbeat_job(&scope, &library.id, &lease).is_err());
    assert!(
        store
            .commit_job_checkpoint(&scope, &library.id, &lease)
            .is_err()
    );
    other.resume_job(&scope, &library.id, &job.id)?;
    let lease = other.claim_job(&scope, &library.id, &job.id)?.unwrap();
    let committed = other.commit_job_checkpoint(&scope, &library.id, &lease)?;
    // Simulate crash after publication but before the task completion receipt.
    drop(other);
    drop(store);
    let mut recovered = KnowledgeCatalog::open(&path)?;
    recovered.connection.execute(
        "UPDATE knowledge_jobs SET lease_until_ms=0 WHERE job_id=?1",
        [&job.id],
    )?;
    let lease = recovered.claim_job(&scope, &library.id, &job.id)?.unwrap();
    assert!(
        recovered
            .job_checkpoint(&scope, &library.id, &job.id)?
            .is_some()
    );
    assert_eq!(
        recovered.commit_job_checkpoint(&scope, &library.id, &lease)?,
        committed
    );
    recovered.finish_job_batch(&scope, &library.id, &lease)?;
    assert_eq!(
        recovered.read_job(&scope, &library.id, &job.id)?.status,
        "completed"
    );
    assert!(recovered.claim_job(&scope, &library.id, &job.id)?.is_none());
    let count: i64 = recovered.connection.query_row(
        "SELECT COUNT(*) FROM knowledge_page_revisions WHERE page_id=?1",
        [page_id],
        |r| r.get(0),
    )?;
    assert_eq!(count, 1);
    let bob = KnowledgeScope::from_authenticated_host("bob", "server")?;
    assert!(recovered.read_job(&bob, &library.id, &job.id).is_err());
    Ok(())
}

#[test]
fn turning_off_pauses_pending_and_running_jobs_without_touching_other_users() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let alice = KnowledgeScope::from_authenticated_host("alice", "server")?;
    let bob = KnowledgeScope::from_authenticated_host("bob", "server")?;
    let mut jobs = Vec::new();
    for scope in [&alice, &bob] {
        let library = store.create(scope, "wiki", "Wiki", "")?;
        let source = store.import_text(scope, &library.id, "source", "资料", "原文")?;
        for key in ["pending", "running"] {
            let job = store.enqueue_ingest(
                scope,
                &library.id,
                key,
                &source.source_id,
                &source.revision_id,
                "v1",
                "zh",
            )?;
            let lease = if key == "running" {
                store.claim_job(scope, &library.id, &job.id)?
            } else {
                None
            };
            jobs.push((library.id.clone(), job.id, lease));
        }
    }
    assert_eq!(store.pause_all_jobs(&alice)?, 2);
    for (index, (library, id, lease)) in jobs.iter().enumerate() {
        if index < 2 {
            assert_eq!(store.read_job(&alice, library, id)?.status, "paused");
            assert!(store.claim_job(&alice, library, id)?.is_none());
            if let Some(lease) = lease {
                assert!(store.heartbeat_job(&alice, library, lease).is_err());
            }
        } else {
            assert_ne!(store.read_job(&bob, library, id)?.status, "paused");
        }
    }
    Ok(())
}

#[test]
fn review_is_exact_idempotent_and_cannot_publish_a_stale_update() -> Result<()> {
    use kcoder_types::knowledge::{KnowledgeCitation, KnowledgePageDraft, KnowledgePageKind};
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "server")?;
    let library = store.create(&scope, "wiki", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "证据", "事实 A，事实 B。")?;
    let page = KnowledgePageDraft {
        page_id: uuid::Uuid::new_v4().to_string(),
        expected_revision: None,
        kind: KnowledgePageKind::Concept,
        title: "主题".into(),
        markdown: "事实 A".into(),
        citations: vec![KnowledgeCitation {
            source_id: source.source_id.clone(),
            revision_id: source.revision_id.clone(),
            chunk_id: "chunk-1".into(),
            quote: "事实 A".into(),
        }],
        related_page_ids: vec![],
    };
    let initial =
        store.commit_generated_pages(&scope, &library.id, "initial", vec![page.clone()])?;
    store.connection.execute(
        "UPDATE knowledge_pages SET human_edited=1 WHERE page_id=?1",
        [&page.page_id],
    )?;
    let mut update = page.clone();
    update.expected_revision = Some(initial[0].revision_id.clone());
    update.markdown = "事实 A，事实 B。".into();
    assert!(
        store
            .commit_generated_pages(&scope, &library.id, "unapproved", vec![update.clone()])
            .unwrap_err()
            .is::<ReviewRequired>()
    );
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "review",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "zh",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    store.save_job_checkpoint(
        &scope,
        &library.id,
        &lease,
        &WikiCheckpoint {
            through_chunk: 1,
            has_more_chunks: false,
            proposal: WikiProposal {
                pages: vec![update],
                review_notes: vec!["请核对修改".into()],
            },
        },
    )?;
    store.stop_job_with_reason(
        &scope,
        &library.id,
        &lease,
        "awaiting_review",
        "review_required",
    )?;
    let review = store.pending_review(&scope, &library.id, &job.id)?;
    assert!(
        store
            .decide_review(&scope, &library.id, &job.id, "old-token", true)
            .is_err()
    );
    let excerpt = store.review_excerpt(
        &scope,
        &library.id,
        &job.id,
        &review.token,
        &page.page_id,
        0,
    )?;
    assert_eq!(excerpt.current.as_deref(), Some("事实 A"));
    assert_eq!(excerpt.proposed, "事实 A，事实 B。");
    let result = store.decide_review(&scope, &library.id, &job.id, &review.token, true)?;
    assert_eq!(result.status, "completed");
    assert_eq!(
        store
            .decide_review(&scope, &library.id, &job.id, &review.token, true)?
            .status,
        "completed"
    );
    assert!(
        store
            .decide_review(&scope, &library.id, &job.id, &review.token, false)
            .is_err()
    );
    assert_eq!(
        store
            .read_page(&scope, &library.id, &page.page_id, None)?
            .draft
            .markdown,
        "事实 A，事实 B。"
    );

    let mut stale = page.clone();
    stale.expected_revision = Some(initial[0].revision_id.clone());
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "stale-review",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "zh",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    store.save_job_checkpoint(
        &scope,
        &library.id,
        &lease,
        &WikiCheckpoint {
            through_chunk: 1,
            has_more_chunks: false,
            proposal: WikiProposal {
                pages: vec![stale],
                review_notes: vec![],
            },
        },
    )?;
    store.stop_job_with_reason(
        &scope,
        &library.id,
        &lease,
        "awaiting_review",
        "review_required",
    )?;
    let review = store.pending_review(&scope, &library.id, &job.id)?;
    assert!(
        store
            .decide_review(&scope, &library.id, &job.id, &review.token, true)
            .is_err()
    );
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "awaiting_review"
    );
    assert_eq!(
        store
            .decide_review(&scope, &library.id, &job.id, &review.token, false)?
            .status,
        "cancelled"
    );
    assert_eq!(
        store
            .read_page(&scope, &library.id, &page.page_id, None)?
            .draft
            .markdown,
        "事实 A，事实 B。"
    );
    Ok(())
}
