use anyhow::Result;
use kcoder_knowledge::*;
use kcoder_types::wiki_pipeline::*;
use sha2::{Digest, Sha256};

#[test]
fn failed_artifacts_and_stale_owners_cannot_be_replayed() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("wiki.db"))?;
    let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Source", "Evidence")?;
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
    let input = WikiStageInput {
        binding: WikiStageBinding {
            address: WikiPipelineStageAddress {
                batch: 0,
                source_revision: source.revision_id.clone(),
                stage_key: "analysis".into(),
                stage: WikiPipelineStageKind::Analyze,
                unit_key: "source".into(),
            },
            purpose_hash: format!("{:x}", Sha256::digest(library.purpose.as_bytes())),
            recipe_key: "recipe".into(),
            model_fingerprint: "1".repeat(64),
            dependency_hashes: vec![],
            input_page_revisions: vec![],
        },
        input_fingerprint: "2".repeat(64),
        unit_label: None,
        unit_index: None,
        total_units: None,
    };
    store.stage_begin(&scope, &library.id, &lease, &input)?;
    store.stage_remember_received(&scope, &library.id, &lease, &input, "broken JSON")?;
    assert_eq!(
        store
            .stage_received_response(&scope, &library.id, &lease, &input)?
            .as_deref(),
        Some("broken JSON")
    );
    assert!(
        store
            .pipeline_progress(&scope, &library.id, &job.id)?
            .unwrap()
            .records[0]
            .reused
    );
    store.stage_mark_failed(&scope, &library.id, &lease, &input, "invalid_json", "/")?;
    assert!(
        store
            .stage_received_response(&scope, &library.id, &lease, &input)?
            .is_none()
    );
    store.pause_job(&scope, &library.id, &job.id)?;
    assert!(
        store
            .stage_remember_received(&scope, &library.id, &lease, &input, "{}")
            .is_err()
    );
    assert!(
        store
            .stage_received_response(&scope, &library.id, &lease, &input)
            .is_err()
    );
    store.resume_job(&scope, &library.id, &job.id)?;
    let next = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
    store.stage_begin(&scope, &library.id, &next, &input)?;
    assert!(
        store
            .stage_received_response(&scope, &library.id, &next, &input)?
            .is_none()
    );
    store.stage_remember_received(&scope, &library.id, &next, &input, "{}")?;
    Ok(())
}

#[test]
fn merge_takeover_preserves_successor_against_old_cleanup() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let mut store = KnowledgeCatalog::open(&dir.path().join("wiki.db"))?;
    let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let mut leases = vec![];
    for key in ["a", "b"] {
        let source = store.import_text(&scope, &library.id, key, key, key)?;
        let job = store.enqueue_ingest(
            &scope,
            &library.id,
            key,
            &source.source_id,
            &source.revision_id,
            "recipe",
            "en",
        )?;
        leases.push(store.claim_job(&scope, &library.id, &job.id)?.unwrap());
    }
    let old = store
        .claim_automatic_merge(&scope, &library.id, &leases[0])?
        .unwrap();
    assert!(
        store
            .claim_automatic_merge(&scope, &library.id, &leases[1])?
            .is_none()
    );
    let foreign = KnowledgeScope::from_authenticated_host("foreign", "local")?;
    assert!(
        store
            .claim_automatic_merge(&foreign, &library.id, &leases[1])
            .is_err()
    );
    store.pause_job(&scope, &library.id, &leases[0].job.id)?;
    let successor = store
        .claim_automatic_merge(&scope, &library.id, &leases[1])?
        .unwrap();
    assert!(
        store
            .heartbeat_automatic_merge(&scope, &library.id, &old)
            .is_err()
    );
    store.release_automatic_merge(&scope, &library.id, &old)?;
    store.heartbeat_automatic_merge(&scope, &library.id, &successor)?;
    store.release_automatic_merge(&scope, &library.id, &successor)?;
    Ok(())
}

#[test]
fn migration_keeps_existing_jobs_legacy_and_enables_only_new_jobs() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("wiki.db");
    let scope = KnowledgeScope::from_authenticated_host("owner", "local")?;
    let mut store = KnowledgeCatalog::open(&path)?;
    let library = store.create(&scope, "create", "Wiki", "")?;
    let source = store.import_text(&scope, &library.id, "source", "Source", "Evidence")?;
    let old = store.enqueue_ingest(
        &scope,
        &library.id,
        "old",
        &source.source_id,
        &source.revision_id,
        "recipe",
        "en",
    )?;
    drop(store);
    let legacy = rusqlite::Connection::open(&path)?;
    legacy.execute_batch("DROP TABLE knowledge_image_import_calls; DROP TABLE knowledge_image_imports; DROP TABLE knowledge_pipeline_stages; DROP TABLE knowledge_automatic_merge_leases; ALTER TABLE knowledge_jobs DROP COLUMN pipeline_version; PRAGMA user_version=16;")?;
    drop(legacy);
    let mut store = KnowledgeCatalog::open(&path)?;
    assert!(!store.job_pipeline_enabled(&scope, &library.id, &old.id)?);
    assert!(
        store
            .read_job(&scope, &library.id, &old.id)?
            .pipeline
            .is_none()
    );
    let new = store.enqueue_ingest(
        &scope,
        &library.id,
        "new",
        &source.source_id,
        &source.revision_id,
        "new-recipe",
        "en",
    )?;
    assert!(store.job_pipeline_enabled(&scope, &library.id, &new.id)?);
    Ok(())
}
