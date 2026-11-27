use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_memory::{MemoryObserverSanitizationOptions, deterministic_memory_observer_draft};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
struct Authority {
    scope: IntegrationScope,
    allowed: AtomicBool,
    receipts: Mutex<Vec<ObserverExtractionReceipt>>,
}
impl CuratedMemoryObserverAuthority for Authority {
    fn authorize(
        &self,
        bundle: &MemoryObserverEventBundle,
        request: &ObserverExtractionRequest,
    ) -> Result<ObserverExtractionPermit> {
        ensure!(self.allowed.load(Ordering::SeqCst), "FIXTURE_DENIED");
        Ok(ObserverExtractionPermit {
            origin: ObserverNativeOrigin {
                scope: self.scope.clone(),
                thread_id: bundle.session_id.clone(),
                turn_id: Some("fixture-turn".into()),
                task_id: None,
                operation_id: if request.kind == ObserverExtractionKind::Model {
                    "fixture-model-op"
                } else {
                    "fixture-deterministic-op"
                }
                .into(),
                project_key: bundle.project_key.clone(),
                policy_revision: "fixture-policy".into(),
                configuration_revision: "fixture-config".into(),
            },
            kind: request.kind,
            selected_model_id: request.requested_model_id.clone(),
            maximum_total_tokens: 1000,
            maximum_output_tokens: 128,
            maximum_input_bytes: 65536,
            maximum_candidates: 8,
            maximum_runtime_ms: 1000,
        })
    }
    fn revalidate(
        &self,
        _: &ObserverExtractionPermit,
        _: &MemoryObserverEventBundle,
    ) -> Result<()> {
        ensure!(self.allowed.load(Ordering::SeqCst), "FIXTURE_REVOKED");
        Ok(())
    }
    fn record_attempt(
        &self,
        _: &ObserverExtractionPermit,
        receipt: &ObserverExtractionReceipt,
    ) -> Result<()> {
        self.receipts.lock().unwrap().push(receipt.clone());
        Ok(())
    }
}
fn fixture() -> Result<(
    tempfile::TempDir,
    Arc<MemoryReviewStore>,
    Arc<Authority>,
    MemoryObserverEventBundle,
)> {
    let root = tempfile::tempdir()?;
    PrivateDirectory::open_or_create(root.path())?;
    let scope = serde_json::from_value(
        serde_json::json!({"accountId":"fixture","targetId":"local","workspaceId":null,"identityGeneration":"1","targetRevision":"1"}),
    )?;
    let store = Arc::new(MemoryReviewStore::create(
        &root.path().join("review"),
        &scope,
    )?);
    let authority = Arc::new(Authority {
        scope,
        allowed: AtomicBool::new(true),
        receipts: Mutex::new(vec![]),
    });
    let mut bundle = MemoryObserverEventBundle::new(
        "fixture-thread",
        "fixture-project",
        Some(1),
        None,
        MemoryObserverSanitizationOptions::default(),
    );
    bundle.add_verification_passed_event(
        "fixture-verification",
        "bash",
        "Synthetic checks passed",
        None,
    );
    Ok((root, store, authority, bundle))
}
fn receipt(permit: &ObserverExtractionPermit, model: bool) -> ObserverExtractionReceipt {
    ObserverExtractionReceipt {
        operation_id: permit.origin.operation_id.clone(),
        provider_started: model,
        requested_model_id: permit.selected_model_id.clone(),
        actual_model_id: permit.selected_model_id.clone(),
        usage: if model {
            Some(Usage {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: Some(15),
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                iterations: None,
            })
        } else {
            None
        },
        usage_evidence: if model {
            ObserverUsageEvidence::Reported
        } else {
            ObserverUsageEvidence::NotStarted
        },
        started_at_ms: 100,
        finished_at_ms: 101,
        outcome: ObserverExtractionOutcome::Validated,
    }
}
#[test]
fn reviewed_observer_writes_real_disabled_candidates_with_exact_source() -> Result<()> {
    let (_root, store, authority, bundle) = fixture()?;
    let bridge = CuratedMemoryReviewBridge::new(store.clone(), authority.clone());
    let request = ObserverExtractionRequest {
        kind: ObserverExtractionKind::Deterministic,
        requested_model_id: None,
        requested_maximum_output_tokens: 0,
        input_bytes: serde_json::to_vec(&bundle)?.len(),
    };
    let permit = bridge.authorize(&bundle, &request)?;
    let completed = receipt(&permit, false);
    bridge.record_attempt(&permit, &completed)?;
    let draft = deterministic_memory_observer_draft(&bundle);
    assert!(bridge.stage_candidates(&permit, &bundle, &draft, &completed)? > 0);
    let page = store.list(None, true)?;
    assert!(
        page.items
            .iter()
            .all(|memory| !memory.enabled && !memory.source_verified)
    );
    assert_eq!(authority.receipts.lock().unwrap().len(), 1);
    Ok(())
}
#[test]
fn revoked_source_still_accounts_spent_usage_and_never_stages_model_output() -> Result<()> {
    let (_root, store, authority, bundle) = fixture()?;
    let bridge = CuratedMemoryReviewBridge::new(store.clone(), authority.clone());
    let request = ObserverExtractionRequest {
        kind: ObserverExtractionKind::Model,
        requested_model_id: Some("fixture-model".into()),
        requested_maximum_output_tokens: 256,
        input_bytes: serde_json::to_vec(&bundle)?.len(),
    };
    let permit = bridge.authorize(&bundle, &request)?;
    let completed = receipt(&permit, true);
    let mut draft = deterministic_memory_observer_draft(&bundle);
    draft.audit.model = Some("fixture-model".into());
    authority.allowed.store(false, Ordering::SeqCst);
    bridge.record_attempt(&permit, &completed)?;
    assert!(
        bridge
            .stage_candidates(&permit, &bundle, &draft, &completed)
            .is_err()
    );
    assert!(store.list(None, true)?.items.is_empty());
    assert_eq!(
        authority.receipts.lock().unwrap()[0]
            .usage
            .as_ref()
            .unwrap()
            .total_tokens,
        Some(15)
    );
    Ok(())
}
#[test]
fn absent_usage_cannot_be_fabricated_as_zero_for_model_candidate_admission() -> Result<()> {
    let (_root, store, authority, bundle) = fixture()?;
    let bridge = CuratedMemoryReviewBridge::new(store.clone(), authority);
    let request = ObserverExtractionRequest {
        kind: ObserverExtractionKind::Model,
        requested_model_id: Some("fixture-model".into()),
        requested_maximum_output_tokens: 256,
        input_bytes: serde_json::to_vec(&bundle)?.len(),
    };
    let permit = bridge.authorize(&bundle, &request)?;
    let mut completed = receipt(&permit, true);
    completed.usage = None;
    completed.usage_evidence = ObserverUsageEvidence::Unreported;
    let mut draft = deterministic_memory_observer_draft(&bundle);
    draft.audit.model = Some("fixture-model".into());
    bridge.record_attempt(&permit, &completed)?;
    assert!(
        bridge
            .stage_candidates(&permit, &bundle, &draft, &completed)
            .unwrap_err()
            .to_string()
            .contains("USAGE_UNCONFIRMED")
    );
    assert!(store.list(None, true)?.items.is_empty());
    Ok(())
}
