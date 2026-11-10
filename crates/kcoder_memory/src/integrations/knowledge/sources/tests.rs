use super::*;
use crate::{
    MemoryObservationInput, MemoryObserverSanitizationOptions, MemoryStore, StructuredMemoryStore,
};
use kcoder_config::PrivateDirectory;
use kcoder_types::integrations::core::IntegrationScope;
fn scope() -> IntegrationScope {
    serde_json::from_value(serde_json::json!({"accountId":"fixture","targetId":"local","workspaceId":null,"identityGeneration":"1","targetRevision":"1"})).unwrap()
}
#[test]
fn actual_structured_source_is_required_and_import_is_candidate_only() -> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let structured = StructuredMemoryStore::open(root.path().join("observations.sqlite"))?;
    let manager =
        MemoryManager::global_only(MemoryStore::with_path(root.path().join("memory.json")))
            .with_structured_store(structured, "project-a");
    let id = manager
        .save_structured_observation(MemoryObservationInput {
            session_id: "source-session".into(),
            project_key: "project-a".into(),
            prompt_number: None,
            observation_type: "preference".into(),
            title: Some("Report format".into()),
            subtitle: None,
            narrative: Some("Lead with findings, then cite sources.".into()),
            facts: vec![],
            concepts: vec![],
            files_read: vec![],
            files_modified: vec![],
            tool_name: None,
            tool_call_id: None,
            source: "fixture".into(),
            generated_by_model: None,
            created_at_epoch: 100,
            content_hash: None,
        })?
        .unwrap();
    let store = MemoryReviewStore::create(&root.path().join("review"), &scope())?;
    assert!(
        store
            .propose_existing_observation(&manager, "project-b", id, "wrong-project", 100)
            .is_err()
    );
    assert!(
        store
            .propose_existing_observation(&manager, "project-a", id + 999, "missing", 100)
            .is_err()
    );
    let candidate = store.propose_existing_observation(&manager, "project-a", id, "import", 100)?;
    assert!(!candidate.enabled && !candidate.source_verified);
    assert_eq!(candidate.proposal.provenance[0].source_id, id.to_string());
    manager.hide_structured_observation(id)?;
    assert!(
        store
            .propose_existing_observation(&manager, "project-a", id, "hidden", 101)
            .is_err()
    );
    Ok(())
}
#[test]
fn maintenance_is_off_by_default_and_validated_candidates_do_not_overwrite_edits() -> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let store = MemoryReviewStore::create(&root.path().join("review"), &scope())?;
    let mut bundle = MemoryObserverEventBundle::new(
        "session",
        "project-a",
        Some(1),
        None,
        MemoryObserverSanitizationOptions::default(),
    );
    bundle.add_verification_passed_event("test-1", "bash", "Unit tests passed", None);
    assert!(
        store
            .stage_deterministic_candidates(
                "project-a",
                &bundle,
                &MemoryMaintenanceLimits::default(),
                "batch",
                100
            )
            .is_err()
    );
    let limits = MemoryMaintenanceLimits {
        enabled: true,
        maximum_candidates: 8,
        maximum_input_bytes: 65536,
        ..Default::default()
    };
    let candidates =
        store.stage_deterministic_candidates("project-a", &bundle, &limits, "batch", 100)?;
    assert!(!candidates.is_empty());
    let edited = store.edit(
        "manual-edit",
        &candidates[0].id,
        1,
        "Human-maintained note".into(),
        101,
    )?;
    let replay =
        store.stage_deterministic_candidates("project-a", &bundle, &limits, "batch", 102)?;
    assert_eq!(replay, candidates);
    assert_eq!(store.read(&edited.id)?, edited);
    let mut invalid = deterministic_memory_observer_draft(&bundle);
    invalid.observation_candidates[0].source_event_ids = vec!["invented-event".into()];
    assert!(
        store
            .stage_observer_candidates("project-a", &bundle, &invalid, &limits, None, "bad", 103)
            .is_err()
    );
    Ok(())
}
#[test]
fn extraction_batch_validation_is_atomic_and_missing_model_receipt_is_rejected() -> Result<()> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let store = MemoryReviewStore::create(&root.path().join("review"), &scope())?;
    let mut bundle = MemoryObserverEventBundle::new(
        "session",
        "project-a",
        Some(1),
        None,
        MemoryObserverSanitizationOptions::default(),
    );
    bundle.add_verification_passed_event("check", "bash", "Synthetic checks passed", None);
    let limits = MemoryMaintenanceLimits {
        enabled: true,
        maximum_candidates: 8,
        maximum_input_bytes: 65536,
        ..Default::default()
    };
    let mut draft = deterministic_memory_observer_draft(&bundle);
    draft.audit.model = Some("fixture-model".into());
    assert!(
        store
            .stage_observer_candidates("project-a", &bundle, &draft, &limits, None, "model", 100)
            .is_err()
    );
    assert!(store.list(None, true)?.items.is_empty());
    let base = MemoryProposal {
        title: "Valid".into(),
        content: "Valid synthetic note".into(),
        category: "general".into(),
        origin: MemoryOrigin::Observer,
        provenance: vec![MemoryProvenance {
            kind: "fixture".into(),
            source_id: "source".into(),
            source_revision: "1".into(),
            description: "Synthetic".into(),
        }],
        valid_until_ms: None,
    };
    let mut invalid = base.clone();
    invalid.content = String::new();
    assert!(
        store
            .propose_candidates("batch", vec![base, invalid], 100)
            .is_err()
    );
    assert!(store.list(None, true)?.items.is_empty());
    Ok(())
}
