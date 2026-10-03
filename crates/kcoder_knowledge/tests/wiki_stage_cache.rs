use anyhow::Result;
use kcoder_knowledge::{KnowledgeCatalog, KnowledgeScope, WikiAnalysis};

#[test]
fn validated_analysis_survives_generation_failure_but_not_lease_or_recipe_changes() -> Result<()> {
    let root = tempfile::tempdir()?;
    let path = root.path().join("state.sqlite");
    let owner = KnowledgeScope::from_authenticated_host("alice", "host")?;
    let other = KnowledgeScope::from_authenticated_host("bob", "host")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&owner, "wiki", "Wiki", "")?;
    let source = store.import_text(&owner, &library.id, "source", "Example", "Evidence")?;
    let job = store.enqueue_ingest(
        &owner,
        &library.id,
        "job",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    let first = store.claim_job(&owner, &library.id, &job.id)?.unwrap();
    let key = "a".repeat(64);
    store.remember_analysis(
        &owner,
        &library.id,
        &first,
        &key,
        &WikiAnalysis {
            summary: "Evidence".into(),
            queries: vec!["Example".into()],
            conflicts: vec![],
        },
    )?;
    store.stop_job_with_reason(&owner, &library.id, &first, "failed", "provider_error")?;
    drop(store);
    let mut store = KnowledgeCatalog::open(&path)?;
    store.resume_job(&owner, &library.id, &job.id)?;
    let second = store.claim_job(&owner, &library.id, &job.id)?.unwrap();
    assert!(
        store
            .cached_analysis(&owner, &library.id, &second, &key)?
            .unwrap()
            .contains("Evidence")
    );
    assert!(
        store
            .cached_analysis(&owner, &library.id, &second, &"b".repeat(64))?
            .is_none()
    );
    assert!(
        store
            .cached_analysis(&owner, &library.id, &first, &key)
            .is_err()
    );
    assert!(
        store
            .cached_analysis(&other, &library.id, &second, &key)
            .is_err()
    );
    Ok(())
}
