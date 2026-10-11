//! The required verification stage has a normal request budget, independent of
//! formatting retries. Test the durable quota directly, without model sampling.
use anyhow::Result;
use kcoder_knowledge::*;

#[test]
fn required_source_support_still_reserves_after_three_repairs_but_obeys_global_call_limit()
-> Result<()> {
    let temp = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&temp.path().join("wiki.sqlite"))?;
    let scope = KnowledgeScope::from_authenticated_host("owned-stage-budget", "local")?;
    let library = store.create(&scope, "create", "Wiki", "Preserve supported facts")?;
    let source = store.import_text(&scope, &library.id, "source", "Owned", "Owned evidence.")?;
    let job = store.enqueue_ingest(
        &scope,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "owned-recipe",
        "en",
    )?;
    let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    for _ in 0..3 {
        let reservation = store
            .budget_reserve_for_stage(&scope, &library.id, &lease, 4, "format_repair", None)?
            .unwrap();
        store.budget_record_usage(&scope, &library.id, &reservation, None)?;
    }
    assert_eq!(
        store.job_batch_repair_calls(&scope, &library.id, &lease)?,
        3
    );
    let verification = store
        .budget_reserve_for_stage(&scope, &library.id, &lease, 4, "source_support", None)?
        .unwrap();
    store.budget_record_usage(&scope, &library.id, &verification, None)?;
    assert_eq!(
        store.job_batch_repair_calls(&scope, &library.id, &lease)?,
        3
    );
    assert_eq!(
        store
            .budget_read(&scope, &library.id, &job.id)?
            .reserved_calls,
        4
    );
    assert!(
        store
            .budget_reserve_for_stage(&scope, &library.id, &lease, 4, "source_support", None)?
            .is_none()
    );
    assert_eq!(
        store.read_job(&scope, &library.id, &job.id)?.status,
        "paused"
    );
    assert_eq!(
        store
            .read_job(&scope, &library.id, &job.id)?
            .error_code
            .as_deref(),
        Some("budget_exceeded")
    );
    Ok(())
}
