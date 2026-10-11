use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, WikiTokenUsage};

#[test]
fn durable_call_budget_counts_failures_and_actual_usage_without_reset_on_resume() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("db.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let stranger = KnowledgeScope::from_authenticated_host("bob", "local")?;
    let mut catalog = KnowledgeCatalog::open(&path)?;
    let library = catalog.create(&scope, "create", "Wiki", "")?;
    let source = catalog.import_text(&scope, &library.id, "source", "Title", "evidence")?;
    let job = catalog.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    assert!(
        catalog
            .budget_read(&scope, &library.id, &job.id)?
            .call_limit
            .is_none()
    );
    let lease = catalog
        .claim_job(&scope, &library.id, &job.id)?
        .expect("lease");
    assert!(
        catalog
            .budget_reserve(&stranger, &library.id, &lease, 2)
            .is_err()
    );
    let first = catalog
        .budget_reserve(&scope, &library.id, &lease, 2)?
        .expect("reserved");
    catalog.budget_record_usage(&scope, &library.id, &first, None)?;
    catalog.budget_record_usage(&scope, &library.id, &first, None)?;
    assert!(
        catalog
            .budget_record_usage(
                &scope,
                &library.id,
                &first,
                Some(WikiTokenUsage {
                    input_tokens: 7,
                    output_tokens: 8
                })
            )
            .is_err()
    );
    let second = catalog
        .budget_reserve(&scope, &library.id, &lease, 4096)?
        .expect("second");
    drop(catalog);
    let mut catalog = KnowledgeCatalog::open(&path)?;
    assert!(
        catalog
            .budget_reserve(&scope, &library.id, &lease, 4096)?
            .is_none()
    );
    assert_eq!(
        catalog.read_job(&scope, &library.id, &job.id)?.status,
        "paused"
    );
    assert_eq!(
        catalog
            .read_job(&scope, &library.id, &job.id)?
            .error_code
            .as_deref(),
        Some("budget_exceeded")
    );
    // A real response arriving after cancellation/revocation remains countable.
    catalog.budget_record_usage(
        &scope,
        &library.id,
        &second,
        Some(WikiTokenUsage {
            input_tokens: 101,
            output_tokens: 19,
        }),
    )?;
    catalog.budget_record_usage(
        &scope,
        &library.id,
        &second,
        Some(WikiTokenUsage {
            input_tokens: 101,
            output_tokens: 19,
        }),
    )?;
    let summary = catalog.budget_read(&scope, &library.id, &job.id)?;
    assert_eq!(summary.call_limit, Some(2));
    assert_eq!(summary.reserved_calls, 2);
    assert_eq!(summary.completed_calls, 2);
    assert_eq!(summary.usage_reported_calls, 1);
    assert_eq!(summary.input_tokens, 101);
    assert_eq!(summary.output_tokens, 19);
    catalog.resume_job(&scope, &library.id, &job.id)?;
    let resumed = catalog
        .claim_job(&scope, &library.id, &job.id)?
        .expect("resumed");
    assert!(
        catalog
            .budget_reserve(&scope, &library.id, &resumed, 4096)?
            .is_none()
    );
    assert!(
        catalog
            .budget_extend(&stranger, &library.id, &job.id, 2, 3)
            .is_err()
    );
    assert!(
        catalog
            .budget_extend(&scope, &library.id, &job.id, 1, 3)
            .is_err()
    );
    catalog.budget_extend(&scope, &library.id, &job.id, 2, 3)?;
    assert_eq!(
        catalog.read_job(&scope, &library.id, &job.id)?.status,
        "paused"
    );
    assert!(
        catalog
            .budget_extend(&scope, &library.id, &job.id, 3, 4097)
            .is_err()
    );
    catalog.resume_job(&scope, &library.id, &job.id)?;
    let resumed = catalog
        .claim_job(&scope, &library.id, &job.id)?
        .expect("resumed");
    let third = catalog
        .budget_reserve(&scope, &library.id, &resumed, 2)?
        .expect("explicit extension retained");
    catalog.budget_record_usage(&scope, &library.id, &third, None)?;
    assert_eq!(
        catalog
            .budget_read(&scope, &library.id, &job.id)?
            .reserved_calls,
        3
    );
    assert!(
        catalog
            .budget_reserve(&scope, &library.id, &resumed, 4096)?
            .is_none()
    );
    Ok(())
}

#[test]
fn concurrent_reservations_cannot_exceed_one_call() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("db.sqlite");
    let scope = KnowledgeScope::from_authenticated_host("alice", "local")?;
    let mut catalog = KnowledgeCatalog::open(&path)?;
    let library = catalog.create(&scope, "create", "Wiki", "")?;
    let source = catalog.import_text(&scope, &library.id, "source", "Title", "evidence")?;
    let job = catalog.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let lease = std::sync::Arc::new(
        catalog
            .claim_job(&scope, &library.id, &job.id)?
            .expect("lease"),
    );
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles = (0..2)
        .map(|_| {
            let (path, scope, library, lease, barrier) = (
                path.clone(),
                scope.clone(),
                library.id.clone(),
                lease.clone(),
                barrier.clone(),
            );
            std::thread::spawn(move || -> Result<bool> {
                let mut catalog = KnowledgeCatalog::open(&path)?;
                barrier.wait();
                Ok(catalog
                    .budget_reserve(&scope, &library, &lease, 1)?
                    .is_some())
            })
        })
        .collect::<Vec<_>>();
    let reserved = handles
        .into_iter()
        .map(|handle| handle.join().expect("thread"))
        .collect::<Result<Vec<_>>>()?;
    assert_eq!(reserved.iter().filter(|value| **value).count(), 1);
    assert_eq!(
        catalog
            .budget_read(&scope, &library.id, &job.id)?
            .reserved_calls,
        1
    );
    Ok(())
}
