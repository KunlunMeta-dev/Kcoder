use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchActionKind, BatchSource, default_resolution, history::HistoryBatchSource},
    discovery::{DiscoveryRoots, SourceRegistry},
    history_discovery::{HistoryCatalog, HistoryPendingSelection},
    history_jobs::HistoryJobStore,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_types::{external_history::HistoryImportStage, migration::*};
use serde_json::json;
use std::{fs, path::Path};

const SESSION: &str = "11111111-1111-4111-8111-111111111111";

fn selection(root: &Path, diagnostics: bool) -> HistoryPendingSelection {
    let directory = root.join("projects/fixture");
    fs::create_dir_all(&directory).unwrap();
    let mut data = json!({"type":"user", "uuid":"message-1", "sessionId":SESSION,
        "message":{"role":"user","content":"Bound historical request"}})
    .to_string();
    data.push('\n');
    if diagnostics {
        data.push_str("{\"type\":\"unknown-future-record\",\"private\":\"never-execute\"}\n");
    }
    fs::write(directory.join(format!("{SESSION}.jsonl")), data).unwrap();
    let catalog =
        HistoryCatalog::discover(root, MigrationSourceKind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    catalog
        .selection(&page.items[0].source_handle)
        .unwrap()
        .pin()
        .unwrap()
}

fn history(root: &Path, diagnostics: bool) -> BatchSource {
    BatchSource::History(Box::new(
        HistoryBatchSource::new(selection(root, diagnostics)).unwrap(),
    ))
}

fn configuration(root: &Path) -> BatchSource {
    fs::write(
        root.join("settings.json"),
        r#"{"mcpServers":{"documents":{"command":"never-execute-migration-history-fixture"}}}"#,
    )
    .unwrap();
    let mut registry = SourceRegistry::new(DiscoveryRoots {
        home: root.into(),
        claude_config_dir: Some(root.into()),
        codex_home: None,
        project: None,
    });
    let id = registry
        .discover(&[MigrationSourceKind::ClaudeCode], false)
        .0
        .into_iter()
        .find(|item| item.scope == "user")
        .unwrap()
        .source_id;
    BatchSource::Configuration(registry.selected(&id).unwrap())
}

fn prepare(
    store: &MigrationStore,
    inputs: Vec<BatchSource>,
    targets: &BatchTargets<'_>,
) -> MigrationJob {
    let job = store.create_batch_scan(inputs).unwrap();
    let choices = job
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&job, item))
        .collect::<Vec<_>>();
    assert_eq!(choices.len(), job.inventory.items.len());
    store
        .prepare_batch(&job.job_id, job.sequence, &choices, targets)
        .unwrap()
}

fn child(job: &MigrationJob) -> &str {
    job.batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .find_map(|action| match &action.action {
            BatchActionKind::History { plan } => Some(plan.history_job_id.as_str()),
            _ => None,
        })
        .unwrap()
}

#[test]
fn configuration_and_selected_history_share_one_plan_and_survive_source_removal() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    fs::write(profile.path().join("settings.json"), "{}").unwrap();
    let history_source = history(source.path(), false);
    let duplicate = history_source.clone();
    let configuration = configuration(source.path());
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let job = prepare(
        &store,
        vec![configuration, history_source, duplicate],
        &targets,
    );
    assert_eq!(job.inventory.items.len(), 2);
    assert!(history.read(child(&job)).is_err());
    assert_eq!(
        fs::read_to_string(profile.path().join("settings.json")).unwrap(),
        "{}"
    );
    let plan = job.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let done = store
        .run_batch(
            &job.job_id,
            plan,
            "apply-history",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    // Imported MCP stays disabled pending explicit activation review.
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    assert!(
        done.inventory
            .items
            .iter()
            .find(|item| item.preview.category == MigrationCategory::History)
            .unwrap()
            .preview
            .issues
            .is_empty()
    );
    assert_eq!(done.receipts.len(), 2);
    assert_eq!(
        history.read(child(&done)).unwrap().stage,
        HistoryImportStage::Normalized
    );
    assert!(
        done.receipts
            .iter()
            .any(|receipt| !receipt.ownership_confirmed)
    );
    let settings: serde_json::Value =
        serde_json::from_slice(&fs::read(profile.path().join("settings.json")).unwrap()).unwrap();
    assert!(
        settings["mcp_disabled_servers"]
            .as_array()
            .unwrap()
            .contains(&settings["mcp_servers"][0]["name"])
    );
    fs::remove_dir_all(source.path().join("projects")).unwrap();
    let reopened = MigrationStore::open_or_create(profile.path()).unwrap();
    let observed = reopened
        .run_batch(&done.job_id, plan, "apply-history", 0, false, &targets)
        .unwrap();
    assert_eq!(observed, done);
    assert_eq!(
        history
            .read(child(&observed))
            .unwrap()
            .normalization
            .unwrap()
            .normalized_records,
        1
    );
    assert!(!profile.path().join("sessions").exists());
}

#[test]
fn cancellation_before_start_requires_explicit_resume_and_does_not_create_a_child() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let input = history(source.path(), false);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let job = prepare(&store, vec![input], &targets);
    let cancelled = store.cancel(&job.job_id, job.sequence).unwrap();
    assert_eq!(cancelled.status, MigrationJobStatus::Cancelled);
    assert!(history.read(child(&job)).is_err());
    let plan = job.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    assert!(
        store
            .run_batch(
                &job.job_id,
                plan,
                "ordinary-apply",
                cancelled.sequence,
                false,
                &targets
            )
            .is_err()
    );
    assert!(history.read(child(&job)).is_err());
    assert!(
        store
            .resume_batch(&job.job_id, plan, "stale-resume", job.sequence, &targets)
            .is_err()
    );
    let done = store
        .resume_batch(
            &job.job_id,
            plan,
            "explicit-resume",
            cancelled.sequence,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::Completed);
    assert_eq!(
        history.read(child(&done)).unwrap().stage,
        HistoryImportStage::Normalized
    );
}

#[test]
fn history_diagnostics_are_preserved_as_a_batch_review_outcome() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let input = history(source.path(), true);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let job = prepare(&store, vec![input], &targets);
    let done = store
        .run_batch(
            &job.job_id,
            job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "apply-with-diagnostics",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    assert!(
        done.inventory.items[0]
            .preview
            .issues
            .iter()
            .any(|issue| issue.code == MigrationIssueCode::RequiresReview)
    );
    assert!(
        history
            .read(child(&done))
            .unwrap()
            .normalization
            .unwrap()
            .records_with_diagnostics
            > 0
    );
}

#[test]
fn a_history_target_from_a_different_profile_cannot_be_planned() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let input = history(source.path(), false);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    // The current parent exists, so failure must distinguish identity from absence.
    let _own_history = HistoryJobStore::open(profile.path()).unwrap();
    let peer_history = HistoryJobStore::open(peer.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&peer_history),
        credentials: None,
    };
    let scanned = store.create_batch_scan(vec![input]).unwrap();
    let choice = default_resolution(&scanned, &scanned.inventory.items[0]).unwrap();
    let error = store
        .prepare_batch(&scanned.job_id, scanned.sequence, &[choice], &targets)
        .unwrap_err();
    assert_eq!(error.to_string(), "migration_wrong_target");
    let unchanged = store.read(&scanned.job_id).unwrap();
    assert_eq!(unchanged.sequence, scanned.sequence);
    assert!(unchanged.batch.unwrap().plan_id.is_none());
}

#[test]
fn an_existing_cancelled_history_child_only_advances_on_an_explicit_parent_resume() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selection = selection(source.path(), false);
    let input = BatchSource::History(Box::new(
        HistoryBatchSource::new(selection.clone()).unwrap(),
    ));
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let job = prepare(&store, vec![input], &targets);
    let selected = history.create_selected(child(&job), selection).unwrap();
    history.request_cancel(&selected.job_id).unwrap();
    let cancelled = history
        .step(&selected.job_id, selected.sequence, 10, |_| true)
        .unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    // Reproduce the actual pre-budget child format. Public standalone acceptance now owns
    // its own separate group and cannot masquerade as an old batch-owned child.
    let journal = profile
        .path()
        .join("migrations/history")
        .join(format!("{}.json", selected.job_id));
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal).unwrap()).unwrap();
    let group = legacy["resourceBudget"]["reference"]["group"]
        .as_str()
        .unwrap()
        .to_string();
    legacy["version"] = json!(3);
    legacy.as_object_mut().unwrap().remove("resourceBudget");
    fs::write(journal, serde_json::to_vec(&legacy).unwrap()).unwrap();
    fs::remove_file(
        profile
            .path()
            .join("migrations/history")
            .join(format!("{}.resource.birth", selected.job_id)),
    )
    .unwrap();
    let ledger_path = profile
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut ledger: serde_json::Value =
        serde_json::from_slice(&fs::read(&ledger_path).unwrap()).unwrap();
    assert!(
        ledger["resource_groups"][&group]["entries"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    ledger["resource_groups"]
        .as_object_mut()
        .unwrap()
        .remove(&group);
    fs::write(ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    let plan = job.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let observed = store
        .run_batch(
            &job.job_id,
            plan,
            "ordinary-observe",
            job.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(observed.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(
        history.read(child(&job)).unwrap().stage,
        HistoryImportStage::Cancelled
    );
    let resumed = store
        .resume_batch(
            &job.job_id,
            plan,
            "explicit-resume",
            observed.sequence,
            &targets,
        )
        .unwrap();
    assert_eq!(resumed.status, MigrationJobStatus::Completed);
    assert_eq!(
        history.read(child(&job)).unwrap().stage,
        HistoryImportStage::Normalized
    );
    assert_eq!(resumed.receipts.len(), 1);
}

#[test]
fn repeated_history_import_reuses_the_original_child_and_undo_releases_only_its_reference() {
    use kcoder_migration::batch::BatchPlanPolicy;
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let input = history(source.path(), true);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let histories = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&histories),
        credentials: None,
    };
    let first = prepare(&store, vec![input.clone()], &targets);
    let first = store
        .run_batch(
            &first.job_id,
            first.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "first-history",
            first.sequence,
            false,
            &targets,
        )
        .unwrap();
    let original_child = child(&first).to_owned();
    let original = histories.read(&original_child).unwrap();
    let scanned = store.create_batch_scan(vec![input]).unwrap();
    let choices = scanned
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scanned, item))
        .collect::<Vec<_>>();
    let second = store
        .prepare_batch_with_policy(
            &scanned.job_id,
            scanned.sequence,
            &choices,
            &targets,
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
        .unwrap();
    let BatchActionKind::Reuse { proof } = &second.batch.as_ref().unwrap().actions[0].action else {
        panic!("a repeated history selection must reuse the existing archive child")
    };
    assert_eq!(
        proof.history_job_id.as_deref(),
        Some(original_child.as_str())
    );
    assert!(proof.native_reference);
    let archives =
        kcoder_state::external_history::ExternalHistoryStore::open_existing(profile.path())
            .unwrap()
            .unwrap();
    let archive_id = original.archive_id.as_deref().unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive_id)
            .unwrap()
            .durable_references,
        2
    );
    let retirement = histories
        .prepare_retirement(
            &uuid::Uuid::new_v4().to_string(),
            &original_child,
            original.sequence,
        )
        .unwrap();
    let blocked_retirement = histories
        .run_retirement(&retirement.operation_id, retirement.sequence, || true)
        .unwrap();
    assert!(!blocked_retirement.logical_retired);
    assert_eq!(
        blocked_retirement.failure_code.as_deref(),
        Some("external_history_retirement_referenced")
    );
    fs::remove_dir_all(source.path().join("projects")).unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let plan = second.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let second = store
        .run_batch(
            &second.job_id,
            plan,
            "reuse-history",
            second.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(second.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(
        second.inventory.items[0].preview.status,
        MigrationItemStatus::Skipped
    );
    assert!(
        second.inventory.items[0]
            .preview
            .issues
            .iter()
            .any(|issue| issue.code == MigrationIssueCode::RequiresReview)
    );
    assert!(!second.receipts[0].ownership_confirmed);
    assert_eq!(histories.read(&original_child).unwrap(), original);
    let blocked = store
        .run_batch(
            &first.job_id,
            first.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "undo-first-history",
            first.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(blocked.status, MigrationJobStatus::RollbackConflict);
    assert_eq!(
        blocked.batch.as_ref().unwrap().actions[0].error.as_deref(),
        Some("migration_result_referenced")
    );
    let undone = store
        .run_batch(
            &second.job_id,
            plan,
            "undo-reference",
            second.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive_id)
            .unwrap()
            .durable_references,
        1
    );
    assert_eq!(histories.read(&original_child).unwrap(), original);
    assert!(
        histories
            .archive_reader(&original_child)
            .unwrap()
            .receipt()
            .unwrap()
            .is_some()
    );
}

#[test]
fn an_existing_history_reuse_candidate_cannot_cross_target_profiles() {
    use kcoder_migration::batch::BatchPlanPolicy;
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let input = history(source.path(), false);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let histories = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&histories),
        credentials: None,
    };
    let first = prepare(&store, vec![input.clone()], &targets);
    store
        .run_batch(
            &first.job_id,
            first.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "first-history",
            first.sequence,
            false,
            &targets,
        )
        .unwrap();
    let peer_history = HistoryJobStore::open(peer.path()).unwrap();
    let targets = BatchTargets {
        history: Some(&peer_history),
        ..targets
    };
    let scan = store.create_batch_scan(vec![input]).unwrap();
    let choice = default_resolution(&scan, &scan.inventory.items[0]).unwrap();
    // A candidate from the correct parent may be skipped, but a peer target can never publish.
    let error = store
        .prepare_batch_with_policy(
            &scan.job_id,
            scan.sequence,
            &[choice],
            &targets,
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "migration_wrong_target");
    assert!(
        store
            .read(&scan.job_id)
            .unwrap()
            .batch
            .unwrap()
            .plan_id
            .is_none()
    );
}

#[test]
fn a_modified_reuse_child_reference_is_not_published_or_used_as_archive_authority() {
    use kcoder_migration::batch::BatchPlanPolicy;
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let input = history(source.path(), false);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let histories = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&histories),
        credentials: None,
    };
    let first = prepare(&store, vec![input.clone()], &targets);
    let first = store
        .run_batch(
            &first.job_id,
            first.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "first-history",
            first.sequence,
            false,
            &targets,
        )
        .unwrap();
    let original = histories.read(child(&first)).unwrap();
    let scan = store.create_batch_scan(vec![input]).unwrap();
    let choice = default_resolution(&scan, &scan.inventory.items[0]).unwrap();
    let second = store
        .prepare_batch_with_policy(
            &scan.job_id,
            scan.sequence,
            &[choice],
            &targets,
            &BatchPlanPolicy {
                reuse_existing: true,
                ..Default::default()
            },
        )
        .unwrap();
    let mut changed = serde_json::to_value(&second).unwrap();
    changed["batch"]["actions"][0]["action"]["proof"]["historyJobId"] =
        json!("22222222-2222-4222-8222-222222222222");
    fs::write(
        profile
            .path()
            .join("migrations")
            .join(format!("{}.json", second.job_id)),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    let observed = store
        .run_batch(
            &second.job_id,
            second.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "tampered-reference",
            second.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert!(observed.receipts.is_empty());
    assert_eq!(
        observed.batch.as_ref().unwrap().actions[0].error.as_deref(),
        Some("migration_reuse_target_changed")
    );
    assert_eq!(histories.read(child(&first)).unwrap(), original);
    assert!(
        histories
            .read("22222222-2222-4222-8222-222222222222")
            .is_err()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn undo_of_an_owned_idle_normalized_history_collects_its_sealed_generation_and_preserves_import_audit()
 {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let input = history(source.path(), false);
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let histories = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&histories),
        credentials: None,
    };
    let plan = prepare(&store, vec![input], &targets);
    let done = store
        .run_batch(
            &plan.job_id,
            plan.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "owned-import",
            plan.sequence,
            false,
            &targets,
        )
        .unwrap();
    let child_id = child(&done).to_owned();
    let fact = histories.read(&child_id).unwrap();
    let archive = fact.archive_id.as_deref().unwrap();
    let idle = histories.archive_reader(&child_id).unwrap();
    let blocked = store
        .run_batch(
            &done.job_id,
            done.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "owned-undo-busy",
            done.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(blocked.status, MigrationJobStatus::RollbackConflict);
    assert!(
        profile
            .path()
            .join("external-history")
            .join(archive)
            .exists()
    );
    drop(idle);
    let undone = store
        .run_batch(
            &done.job_id,
            done.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "owned-undo",
            blocked.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(histories.read(&child_id).unwrap(), fact);
    assert!(histories.archive_reader(&child_id).is_err());
    assert!(
        !profile
            .path()
            .join("external-history")
            .join(archive)
            .exists()
    );
    let retirement = histories.retirement_for_job(&child_id).unwrap().unwrap();
    assert!(retirement.logical_retired && retirement.collected_bytes > 0);
    let reopened = MigrationStore::open_or_create(profile.path()).unwrap();
    assert_eq!(
        reopened
            .run_batch(
                &done.job_id,
                done.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                "owned-undo",
                0,
                true,
                &targets
            )
            .unwrap(),
        undone
    );
    assert!(
        source
            .path()
            .join(format!("projects/fixture/{SESSION}.jsonl"))
            .is_file()
    );
}

#[path = "batch_history/resources.rs"]
mod resources;

#[path = "batch_history/resource_observations.rs"]
mod resource_observations;

#[path = "batch_history/parallel.rs"]
mod parallel;
