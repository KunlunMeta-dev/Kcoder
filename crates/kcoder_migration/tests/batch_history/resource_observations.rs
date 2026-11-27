use super::*;
use kcoder_types::migration_resource::{
    MigrationResourceBudgetPhase as Phase, MigrationResourceLimits,
};

#[test]
fn planned_budget_observation_never_allocates_a_history_namespace_or_receipt() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let job = store
        .create_batch_scan(vec![history(source.path(), false)])
        .unwrap();
    let observed = store
        .batch_resource_budget(&job.job_id, Some("not-yet-accepted"))
        .unwrap();
    assert_eq!(observed.phase(), Phase::Planned);
    assert!(observed.limits().is_some());
    assert!(
        observed.usage().is_none()
            && observed.policy_revision().is_none()
            && observed.requested_receipt().cloned().is_none()
    );
    assert!(!profile.path().join("migrations/history").exists());
    assert!(!profile.path().join("external-history").exists());
    assert_eq!(store.read(&job.job_id).unwrap().sequence, job.sequence);
}

#[test]
fn explicit_native_increase_resumes_the_original_batch_and_survives_offline_undo() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    fs::write(profile.path().join("settings.json"), "{}").unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let provider = ProviderTarget::open(profile.path()).unwrap();
    let mcp = McpTarget::open(profile.path()).unwrap();
    let assets = AssetTarget::open(profile.path()).unwrap();
    let history_store = HistoryJobStore::open(profile.path()).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: Some(&history_store),
    };
    let baseline = MigrationResourceLimits {
        max_total_bytes: 8 * 1024 * 1024,
        max_payload_files: 6,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    };
    let scan = store
        .create_batch_scan_with_resource_limits(
            vec![history(first.path(), false), history(second.path(), false)],
            baseline.clone(),
        )
        .unwrap();
    let choices = scan
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scan, item))
        .collect::<Vec<_>>();
    let planned = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let stopped = store
        .run_batch(
            &planned.job_id,
            plan,
            "apply-original-budget",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(stopped.status, MigrationJobStatus::CompletedWithIssues);
    let before = store.batch_resource_budget(&stopped.job_id, None).unwrap();
    assert_eq!(before.phase(), Phase::Active);
    assert_eq!(before.policy_revision(), Some(0));
    assert_eq!(before.usage().unwrap().committed_files, 5);
    let mut increased = baseline.clone();
    increased.max_payload_files = 12;
    assert_eq!(
        store
            .raise_batch_resource_budget(
                &stopped.job_id,
                plan,
                "raise-original",
                0,
                increased.clone(),
                false
            )
            .unwrap_err()
            .to_string(),
        "migration_resource_consent_required"
    );
    assert_eq!(
        store.batch_resource_budget(&stopped.job_id, None).unwrap(),
        before
    );
    assert_eq!(
        store
            .raise_batch_resource_budget(
                &stopped.job_id,
                "wrong-plan",
                "raise-original",
                0,
                increased.clone(),
                true
            )
            .unwrap_err()
            .to_string(),
        "migration_plan_changed"
    );
    let receipt = store
        .raise_batch_resource_budget(
            &stopped.job_id,
            plan,
            "raise-original",
            0,
            increased.clone(),
            true,
        )
        .unwrap();
    assert_eq!(receipt.revision, 1);
    let raised = store
        .batch_resource_budget(&stopped.job_id, Some("raise-original"))
        .unwrap();
    assert_eq!(raised.requested_receipt().cloned(), Some(receipt.clone()));
    assert_eq!(raised.usage(), before.usage());
    assert_eq!(
        store.read(&stopped.job_id).unwrap().sequence,
        stopped.sequence
    );
    let no_replay = store
        .run_batch(
            &stopped.job_id,
            plan,
            "apply-original-budget",
            0,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(no_replay.sequence, stopped.sequence);
    assert_eq!(
        store
            .raise_batch_resource_budget(
                &stopped.job_id,
                plan,
                "stale-new-request",
                0,
                increased.clone(),
                true
            )
            .unwrap_err()
            .to_string(),
        "history_resource_policy_revision_changed"
    );
    let done = store
        .resume_batch(
            &stopped.job_id,
            plan,
            "explicit-resume-after-increase",
            stopped.sequence,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::Completed);
    let complete = store.batch_resource_budget(&done.job_id, None).unwrap();
    assert_eq!(complete.policy_revision(), Some(1));
    assert_eq!(complete.usage().unwrap().committed_files, 10);
    fs::remove_dir_all(first.path().join("projects")).unwrap();
    fs::remove_dir_all(second.path().join("projects")).unwrap();
    let reopened = MigrationStore::open_existing(profile.path()).unwrap();
    assert_eq!(
        reopened
            .raise_batch_resource_budget(
                &done.job_id,
                plan,
                "raise-original",
                0,
                increased.clone(),
                true
            )
            .unwrap(),
        receipt
    );
    let undone = reopened
        .run_batch(
            &done.job_id,
            plan,
            "undo-owned-history-budget",
            done.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert_eq!(
        reopened
            .batch_resource_budget(&undone.job_id, Some("raise-original"))
            .unwrap()
            .requested_receipt()
            .cloned(),
        Some(receipt.clone())
    );
    assert_eq!(
        reopened
            .raise_batch_resource_budget(
                &undone.job_id,
                plan,
                "raise-original",
                0,
                increased.clone(),
                true
            )
            .unwrap(),
        receipt
    );
    increased.max_payload_files = 14;
    assert_eq!(
        reopened
            .raise_batch_resource_budget(&undone.job_id, plan, "new-after-undo", 1, increased, true)
            .unwrap_err()
            .to_string(),
        "migration_resource_job_not_mutable"
    );
}

#[test]
fn legacy_and_non_history_jobs_never_claim_an_active_or_zero_usage_receipt() {
    let source = tempfile::tempdir().unwrap();
    let config_source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let store = MigrationStore::open_or_create(profile.path()).unwrap();
    let history_job = store
        .create_batch_scan(vec![history(source.path(), false)])
        .unwrap();
    let mut legacy = serde_json::to_value(&history_job).unwrap();
    legacy["batch"]
        .as_object_mut()
        .unwrap()
        .remove("resourceLimits");
    fs::write(
        profile
            .path()
            .join("migrations")
            .join(format!("{}.json", history_job.job_id)),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let observed = store
        .batch_resource_budget(&history_job.job_id, None)
        .unwrap();
    assert_eq!(observed.phase(), Phase::LegacyUntracked);
    assert!(
        observed.limits().is_none()
            && observed.usage().is_none()
            && observed.policy_revision().is_none()
    );
    let other = store
        .create_batch_scan(vec![configuration(config_source.path())])
        .unwrap();
    let observed = store.batch_resource_budget(&other.job_id, None).unwrap();
    assert_eq!(observed.phase(), Phase::NotApplicable);
    assert!(
        observed.limits().is_none()
            && observed.usage().is_none()
            && observed.policy_revision().is_none()
    );
    assert!(!profile.path().join("migrations/history").exists());
    assert!(!profile.path().join("external-history").exists());
}
