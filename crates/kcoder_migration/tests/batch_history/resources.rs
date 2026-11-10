use super::*;
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::migration_resource::MigrationResourceLimits;

#[test]
fn normal_batch_children_share_the_original_payload_file_budget_and_reopen_receipts() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    fs::write(profile.path().join("settings.json"), "{}").unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: Some(&history),
    };
    let limits = MigrationResourceLimits {
        max_total_bytes: 8 * 1024 * 1024,
        max_payload_files: 6,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    };
    let scanned = store
        .create_batch_scan_with_resource_limits(
            vec![
                super::history(first.path(), false),
                super::history(second.path(), true),
            ],
            limits.clone(),
        )
        .unwrap();
    let choices = scanned
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scanned, item))
        .collect::<Vec<_>>();
    let planned = store
        .prepare_batch(&scanned.job_id, scanned.sequence, &choices, &targets)
        .unwrap();
    let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let done = store
        .run_batch(
            &planned.job_id,
            plan,
            "apply-budgeted-history",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(
        done.batch
            .as_ref()
            .unwrap()
            .actions
            .iter()
            .filter(|action| action.status == MigrationItemStatus::Failed
                && action.error.as_deref() == Some("migration_history_resource_admission_failed"))
            .count(),
        1
    );
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let original = archives
        .recorded_resource_budget(&done.job_id)
        .unwrap()
        .unwrap();
    let usage = archives.resource_budget_usage(&original).unwrap();
    assert_eq!(usage.limits, limits);
    assert_eq!((usage.committed_files, usage.reserved_files), (5, 0));
    let children = done
        .batch
        .as_ref()
        .unwrap()
        .actions
        .iter()
        .filter_map(|action| {
            if let BatchActionKind::History { plan } = &action.action {
                Some(history.read(&plan.history_job_id).unwrap())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 2);
    assert_eq!(
        children
            .iter()
            .filter(|child| child.stage == HistoryImportStage::Normalized)
            .count(),
        1
    );
    let failed = children
        .iter()
        .find(|child| child.stage == HistoryImportStage::Failed)
        .unwrap();
    assert_eq!(
        failed.failure_code.as_deref(),
        Some("history_resource_file_budget_exceeded")
    );
    assert!(!failed.archived);
    let failed_archive = failed.archive_id.as_ref().unwrap();
    assert!(
        !profile
            .path()
            .join("external-history")
            .join(failed_archive)
            .exists()
    );
    fs::remove_dir_all(first.path().join("projects")).unwrap();
    fs::remove_dir_all(second.path().join("projects")).unwrap();
    let reopened = MigrationStore::open_existing(profile.path()).unwrap();
    // Reconcile the original completed apply request; no source or new quota group is needed.
    let reread = reopened
        .run_batch(
            &done.job_id,
            plan,
            "apply-budgeted-history",
            0,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(reread.sequence, done.sequence);
    assert_eq!(
        archives
            .recorded_resource_budget(&done.job_id)
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(archives.resource_budget_usage(&original).unwrap(), usage);
}

#[test]
fn invalid_limits_do_not_publish_a_job_and_legacy_journals_do_not_invent_a_budget() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let input = super::history(source.path(), false);
    let invalid = MigrationResourceLimits {
        min_free_bytes: 0,
        ..Default::default()
    };
    assert_eq!(
        store
            .create_batch_scan_with_resource_limits(vec![input.clone()], invalid)
            .unwrap_err()
            .to_string(),
        "migration_invalid_resource_limits"
    );
    let job = store.create_batch_scan(vec![input]).unwrap();
    let mut encoded = serde_json::to_value(&job).unwrap();
    encoded["batch"]
        .as_object_mut()
        .unwrap()
        .remove("resourceLimits");
    let old: MigrationJob = serde_json::from_value(encoded).unwrap();
    assert!(old.batch.as_ref().unwrap().resource_limits.is_none());
    old.batch.as_ref().unwrap().validate().unwrap();
    assert!(
        !serde_json::to_value(old).unwrap()["batch"]
            .as_object()
            .unwrap()
            .contains_key("resourceLimits")
    );
}
