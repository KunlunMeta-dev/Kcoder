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
    assert!(
        store
            .job_checkpoint(&scope, &library.id, &job.id)?
            .is_none()
    );
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
            advisory_notes: vec![],
            organization_proof: None,
        },
    };
    store.save_job_checkpoint(&scope, &library.id, &lease, &checkpoint)?;
    assert!(store.finish_job_batch(&scope, &library.id, &lease).is_err());
    other.pause_job(&scope, &library.id, &job.id)?;
    assert!(store.heartbeat_job(&scope, &library.id, &lease).is_err());
    assert_eq!(store.pause_all_jobs(&scope)?, 0);
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
    assert!(
        recovered
            .job_checkpoint(&scope, &library.id, &job.id)?
            .is_none()
    );
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
fn source_formats_without_checkpoint_have_no_review_and_legacy_stages_can_resume() -> Result<()> {
    // Pre-extracted fixtures exercise the shared task database path; this test
    // does not invoke image interpretation or a document format decoder.
    for format in [
        "image", "text", "markdown", "html", "pdf", "docx", "xlsx", "pptx",
    ] {
        check_source_without_checkpoint(format)?;
    }
    Ok(())
}

fn check_source_without_checkpoint(format: &str) -> Result<()> {
    let dir = tempfile::tempdir()?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "server")?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_extracted(
        &scope,
        &library.id,
        "source",
        "Source",
        b"original-source",
        format,
        vec![SourceChunk {
            ordinal: 1,
            chunk_id: "chunk-1".into(),
            first_line: 1,
            last_line: 1,
            text: "Imported source evidence".into(),
            page: None,
        }],
    )?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    assert!(
        store
            .job_checkpoint(&scope, &library.id, &job.id)?
            .is_none()
    );
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    assert_eq!(
        store
            .finish_job_batch(&scope, &library.id, &lease)
            .unwrap_err()
            .to_string(),
        "Wiki checkpoint missing"
    );
    store.heartbeat_job(&scope, &library.id, &lease)?;
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "running"
    );
    // Reproduce the historical early-stage ReviewRequired transition, before
    // a complete proposal was available for a human to inspect or publish.
    store.stop_job_with_reason(
        &scope,
        &library.id,
        &lease,
        "awaiting_review",
        "review_required",
    )?;
    assert!(
        store
            .job_checkpoint(&scope, &library.id, &job.id)?
            .is_none()
    );
    assert_eq!(
        store
            .read_job(&scope, &library.id, &job.id)?
            .review_available,
        Some(false)
    );
    assert_eq!(
        store.list_jobs(&scope, &library.id, None, 16)?[0].review_available,
        Some(false)
    );
    assert_eq!(
        store
            .job_overview_page(&scope, &library.id, None, 16)?
            .items[0]
            .job
            .review_available,
        Some(false)
    );
    assert_eq!(
        store
            .pending_review(&scope, &library.id, &job.id)
            .unwrap_err()
            .to_string(),
        "Wiki job has no pending review"
    );
    for accept in [false, true] {
        assert_eq!(
            store
                .decide_review(&scope, &library.id, &job.id, "unissued-token", accept)
                .unwrap_err()
                .to_string(),
            "Wiki job has no pending review"
        );
    }
    assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
    let receipts: i64 = store.connection.query_row(
        "SELECT count(*) FROM knowledge_review_receipts WHERE library_id=?1 AND job_id=?2",
        rusqlite::params![library.id, job.id],
        |row| row.get(0),
    )?;
    assert_eq!(receipts, 0);
    let foreign = KnowledgeScope::from_authenticated_host("bob", "server")?;
    assert!(store.resume_job(&foreign, &library.id, &job.id).is_err());
    store.resume_job(&scope, &library.id, &job.id)?;
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "queued"
    );
    assert_eq!(
        store
            .read_job(&scope, &library.id, &job.id)?
            .review_available,
        None
    );
    let resumed = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    assert!(store.heartbeat_job(&scope, &library.id, &lease).is_err());
    store.heartbeat_job(&scope, &library.id, &resumed)?;
    assert_eq!(
        store
            .original_source(&scope, &library.id, &source.source_id, &source.revision_id)?
            .2,
        b"original-source"
    );
    Ok(())
}

#[test]
fn malformed_checkpoint_is_rejected_instead_of_treated_as_absent() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "server")?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Text", "Evidence")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    store.connection.execute("UPDATE knowledge_jobs SET status='awaiting_review',checkpoint_json='{' WHERE library_id=?1 AND job_id=?2",rusqlite::params![library.id,job.id])?;
    assert!(
        store
            .job_checkpoint(&scope, &library.id, &job.id)
            .unwrap_err()
            .is::<serde_json::Error>()
    );
    assert!(
        store
            .pending_review(&scope, &library.id, &job.id)
            .unwrap_err()
            .is::<serde_json::Error>()
    );
    assert_eq!(
        store
            .read_job(&scope, &library.id, &job.id)?
            .review_available,
        Some(true)
    );
    store.resume_job(&scope, &library.id, &job.id)?;
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "awaiting_review"
    );
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
                advisory_notes: vec![],
                organization_proof: None,
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
    assert_eq!(
        store
            .read_job(&scope, &library.id, &job.id)?
            .review_available,
        Some(true)
    );
    assert_eq!(
        store.list_jobs(&scope, &library.id, None, 16)?[0].review_available,
        Some(true)
    );
    assert_eq!(
        store
            .job_overview_page(&scope, &library.id, None, 16)?
            .items[0]
            .job
            .review_available,
        Some(true)
    );
    // Resume cannot bypass the decision attached to a complete proposal.
    store.resume_job(&scope, &library.id, &job.id)?;
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "awaiting_review"
    );
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
                advisory_notes: vec![],
                organization_proof: None,
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

// Deterministic fixtures validate persistence, authorization and recovery
// boundaries only; they make no claims about model latency or semantic quality.
#[test]
fn staged_candidates_survive_reopen_without_publication_and_cleanup_only_terminal_jobs()
-> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("wiki.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Paper", "Evidence")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe-v4",
        "en",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    let proposal = WikiProposal {
        pages: vec![KnowledgePageDraft {
            page_id: uuid::Uuid::new_v4().to_string(),
            expected_revision: None,
            kind: KnowledgePageKind::Source,
            title: "Paper".into(),
            markdown: "Evidence".into(),
            citations: vec![KnowledgeCitation {
                source_id: source.source_id,
                revision_id: source.revision_id,
                chunk_id: "chunk-1".into(),
                quote: "Evidence".into(),
            }],
            related_page_ids: vec![],
        }],
        review_notes: vec![],
        advisory_notes: vec![],
        organization_proof: None,
    };
    let key = "a".repeat(64);
    store.remember_proposal(&scope, &library.id, &lease, &key, &proposal)?;
    let raw = serde_json::to_string(&proposal)?;
    store.remember_json_response(&scope, &library.id, &lease, &key, &raw)?;
    assert!(
        store
            .remember_json_response(&scope, &library.id, &lease, &key, "{\"pages\":[")
            .is_err()
    );
    assert!(store.list_pages(&scope, &library.id, None, 100)?.is_empty());
    assert_eq!(store.clear_terminal_stage_cache(&scope, &library.id)?, 0);
    store.pause_job(&scope, &library.id, &job.id)?;
    assert!(
        store
            .cached_proposal(&scope, &library.id, &lease, &key)
            .is_err()
    );
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    store.resume_job(&scope, &library.id, &job.id)?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    let restored = store
        .cached_proposal(&scope, &library.id, &lease, &key)?
        .unwrap();
    assert_eq!(
        store.cached_json_response(&scope, &library.id, &lease, &key)?,
        Some(raw)
    );
    assert_eq!(
        serde_json::to_value(&restored)?,
        serde_json::to_value(&proposal)?
    );
    assert!(
        store
            .cached_proposal(&scope, &library.id, &lease, &"b".repeat(64))?
            .is_none()
    );
    let bob = KnowledgeScope::from_authenticated_host("bob", "target")?;
    assert!(
        store
            .cached_json_response(&bob, &library.id, &lease, &key)
            .is_err()
    );
    assert!(
        store
            .cached_proposal(&bob, &library.id, &lease, &key)
            .is_err()
    );
    store.connection.execute(
        "UPDATE knowledge_stage_cache SET body_json='{}' WHERE job_id=?1",
        [&job.id],
    )?;
    assert!(
        store
            .cached_proposal(&scope, &library.id, &lease, &key)
            .is_err()
    );
    assert!(
        store
            .cached_json_response(&scope, &library.id, &lease, &key)
            .is_err()
    );
    store.cancel_job(&scope, &library.id, &job.id)?;
    assert_eq!(store.clear_terminal_stage_cache(&scope, &library.id)?, 0);
    assert_eq!(
        store
            .source_chunks(
                &scope,
                &library.id,
                &lease.job.source_id,
                &lease.job.source_revision,
                0,
                10
            )?
            .len(),
        1
    );
    Ok(())
}

#[test]
fn shared_repair_budget_persists_across_pause_without_fabricating_usage() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("wiki.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "target")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Paper", "Evidence")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    for stage in ["format_repair", "citation_repair", "organization_repair"] {
        let reservation = store
            .budget_reserve_for_stage(&scope, &library.id, &lease, 64, stage, Some(100))?
            .unwrap();
        store.budget_record_usage(&scope, &library.id, &reservation, None)?;
    }
    store.pause_job(&scope, &library.id, &job.id)?;
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    store.resume_job(&scope, &library.id, &job.id)?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    let error = store
        .budget_reserve_for_stage(
            &scope,
            &library.id,
            &lease,
            64,
            "citation_repair",
            Some(100),
        )
        .unwrap_err();
    assert!(error.to_string().contains("shared repair budget"));
    let budget = store.budget_read(&scope, &library.id, &job.id)?;
    assert_eq!(budget.reserved_calls, 3);
    assert_eq!(budget.usage_reported_calls, 0);
    assert_eq!(store.job_repair_calls(&scope, &library.id, &job.id)?, 3);
    assert_eq!(
        store.job_batch_repair_calls(&scope, &library.id, &lease)?,
        3
    );
    let foreign = KnowledgeScope::from_authenticated_host("other", "target")?;
    assert!(
        store
            .job_batch_repair_calls(&foreign, &library.id, &lease)
            .is_err()
    );
    let mut stale_batch = crate::WikiJobLease {
        job: lease.job.clone(),
        token: lease.token.clone(),
    };
    stale_batch.job.after_chunk += 1;
    assert!(
        store
            .job_batch_repair_calls(&scope, &library.id, &stale_batch)
            .is_err()
    );
    let reservation = store
        .budget_reserve_for_stage(&scope, &library.id, &lease, 64, "generation", Some(100))?
        .unwrap();
    store.budget_record_usage(
        &scope,
        &library.id,
        &reservation,
        Some(WikiTokenUsage {
            input_tokens: 200,
            output_tokens: 50,
        }),
    )?;
    assert_eq!(
        store.calibrated_input_estimate(&scope, &library.id, &job.id, 200)?,
        400
    );
    let budget = store.budget_read(&scope, &library.id, &job.id)?;
    assert_eq!(budget.usage_reported_calls, 1);
    assert_eq!(budget.input_tokens, 200);
    Ok(())
}

#[test]
fn future_job_status_and_phase_preserve_history_and_reject_operator_mutations() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let scope = KnowledgeScope::from_authenticated_host("alice", "server")?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("state.sqlite"))?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Evidence", "Source text")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe-v1",
        "zh-CN",
    )?;
    store.connection.execute(
        "UPDATE knowledge_jobs SET status='awaiting_future_policy' WHERE job_id=?1",
        [&job.id],
    )?;
    for _ in 0..2 {
        assert_eq!(
            store.read_job(&scope, &library.id, &job.id)?.status,
            "awaiting_future_policy"
        );
        assert!(store.pause_job(&scope, &library.id, &job.id).is_err());
        assert!(store.resume_job(&scope, &library.id, &job.id).is_err());
        assert!(store.cancel_job(&scope, &library.id, &job.id).is_err());
        assert!(store.claim_job(&scope, &library.id, &job.id).is_err());
    }
    assert_eq!(
        store.list_jobs(&scope, &library.id, None, 10)?[0].status,
        "awaiting_future_policy"
    );
    store.connection.execute(
        "UPDATE knowledge_jobs SET status='queued' WHERE job_id=?1",
        [&job.id],
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    let progress = serde_json::json!({
        "phase":"future_analysis", "startedAtMs":1,"phaseStartedAtMs":1,"heartbeatAtMs":1,
        "model":"model", "textBytes":0,"reasoningBytes":0,
        "reservedCalls":0,"repairCalls":0,"usageReportedCalls":0
    })
    .to_string();
    store.connection.execute(
        "UPDATE knowledge_jobs SET progress_json=?2 WHERE job_id=?1",
        rusqlite::params![job.id, progress],
    )?;
    assert_eq!(
        store
            .read_job(&scope, &library.id, &job.id)?
            .progress
            .unwrap()
            .phase,
        "future_analysis"
    );
    assert!(store.heartbeat_job(&scope, &library.id, &lease).is_err());
    assert_eq!(store.pause_all_jobs(&scope)?, 0);
    assert!(store.pause_job(&scope, &library.id, &job.id).is_err());
    assert!(store.cancel_job(&scope, &library.id, &job.id).is_err());
    assert!(store.resume_job(&scope, &library.id, &job.id).is_err());
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "running"
    );
    Ok(())
}
