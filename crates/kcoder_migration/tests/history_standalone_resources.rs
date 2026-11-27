//! Standalone history acceptance must bind accounting before an archive can allocate bytes.
use kcoder_migration::{history_jobs::HistoryJobStore, history_sources::HistorySourceBinding};
use kcoder_state::external_history::ExternalHistoryStore;
use kcoder_types::{external_history::ExternalHistoryOrigin, migration::MigrationSourceKind};
use serde_json::json;
use std::{fs, path::Path};
#[path = "history_standalone_resources/attach.rs"]
mod attach;

fn fixture(root: &Path) -> HistorySourceBinding {
    let row = json!({"type":"user","uuid":"first-row","sessionId":"budget-fixture",
        "message":{"role":"user","content":[{"type":"text","text":"owned synthetic history"}]}});
    fs::write(root.join("source.jsonl"), format!("{row}\n")).unwrap();
    HistorySourceBinding::capture(
        root,
        Path::new("source.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "explicit-owned-budget-fixture".into(),
            source_session_id: "budget-fixture".into(),
            source_artifact_id: None,
            source_format: "synthetic-jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: None,
            archived: false,
            parent_session_id: None,
        },
        &mut |_, _| true,
    )
    .unwrap()
}

#[test]
fn standalone_acceptance_records_its_budget_before_archiving() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = fixture(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let job = jobs.create(&request, &selected).unwrap();
    assert!(!job.archived);
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert!(
        archives
            .recorded_resource_budget(&request)
            .unwrap()
            .is_some(),
        "a newly accepted standalone job has no accounting owner before archive IO"
    );
}

#[test]
fn a_known_creation_keeps_its_initial_limits_and_never_resets_an_increased_policy() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = fixture(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let initial = kcoder_types::migration_resource::MigrationResourceLimits {
        max_total_bytes: 2 * 1024 * 1024,
        ..Default::default()
    };
    let created = jobs
        .create_with_resource_limits(&request, &selected, Some(initial.clone()))
        .unwrap();
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let original = archives
        .recorded_resource_budget(&request)
        .unwrap()
        .unwrap();
    let raised = kcoder_types::migration_resource::MigrationResourceLimits {
        max_total_bytes: 4 * 1024 * 1024,
        ..initial.clone()
    };
    let change = uuid::Uuid::new_v4().to_string();
    archives
        .raise_history_resource_budget(&original, &change, 0, raised.clone())
        .unwrap();
    assert_eq!(
        jobs.create_with_resource_limits(&request, &selected, Some(initial))
            .unwrap(),
        created
    );
    assert_eq!(jobs.create(&request, &selected).unwrap(), created);
    let current = archives.history_resource_policy(&original).unwrap();
    assert_eq!(current.revision, 1);
    assert_eq!(current.limits, raised);
    assert!(
        jobs.create_with_resource_limits(&request, &selected, Some(Default::default()))
            .is_err()
    );
}

#[test]
fn deleting_a_born_group_never_turns_a_new_job_into_an_unaccounted_writer() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = fixture(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let created = jobs.create(&request, &selected).unwrap();
    let path = profile
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut ledger: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(ledger["resource_groups"].as_object().unwrap().len(), 1);
    ledger["resource_groups"] = json!({});
    fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    let mut callbacks = 0;
    let error = jobs
        .step(&request, created.sequence, 10, |_| {
            callbacks += 1;
            true
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "history_resource_ledger_missing");
    assert_eq!(callbacks, 0);
    assert!(
        ExternalHistoryStore::open_existing(profile.path())
            .unwrap()
            .unwrap()
            .recorded_resource_budget(&request)
            .unwrap()
            .is_none()
    );
    assert!(jobs.request_cancel(&request).unwrap().cancel_requested);
}

#[test]
fn explicit_policy_increase_and_resume_keep_the_original_archive_intent() {
    use kcoder_types::external_history::HistoryImportStage;
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = fixture(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let initial = kcoder_types::migration_resource::MigrationResourceLimits {
        max_total_bytes: 32,
        ..Default::default()
    };
    let created = jobs
        .create_with_resource_limits(&request, &selected, Some(initial.clone()))
        .unwrap();
    let failed = jobs.step(&request, created.sequence, 10, |_| true).unwrap();
    assert_eq!(failed.stage, HistoryImportStage::Failed);
    assert_eq!(
        failed.failure_code.as_deref(),
        Some("history_resource_budget_exceeded")
    );
    assert!(!failed.archived);
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let original = archives
        .recorded_resource_budget(&request)
        .unwrap()
        .unwrap();
    let raised = kcoder_types::migration_resource::MigrationResourceLimits {
        max_total_bytes: 2 * 1024 * 1024,
        ..initial
    };
    archives
        .raise_history_resource_budget(&original, &uuid::Uuid::new_v4().to_string(), 0, raised)
        .unwrap();
    let mut current = jobs.resume(&request, failed.sequence).unwrap();
    for _ in 0..10 {
        if current.stage == HistoryImportStage::Normalized {
            break;
        }
        current = jobs.step(&request, current.sequence, 10, |_| true).unwrap();
        assert_ne!(current.stage, HistoryImportStage::Failed);
    }
    assert_eq!(current.stage, HistoryImportStage::Normalized);
    assert_eq!(current.archive_id, failed.archive_id);
    let usage = archives.resource_budget_usage(&original).unwrap();
    assert!(usage.committed_bytes > 0);
    assert!(usage.committed_files >= 4);
}

#[test]
fn native_budget_observation_and_lost_increase_reply_preserve_job_control() {
    use kcoder_types::migration_resource::{MigrationResourceBudgetView, MigrationResourceLimits};
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = fixture(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let initial = MigrationResourceLimits {
        max_total_bytes: 2 * 1024 * 1024,
        ..Default::default()
    };
    let created = jobs
        .create_with_resource_limits(&request, &selected, Some(initial.clone()))
        .unwrap();
    let cancelled = jobs.request_cancel(&request).unwrap();
    let change = uuid::Uuid::new_v4().to_string();
    let raised = MigrationResourceLimits {
        max_total_bytes: 4 * 1024 * 1024,
        ..initial
    };
    assert!(
        jobs.raise_resource_budget(&request, &change, 0, raised.clone(), false)
            .is_err()
    );
    let accepted = jobs
        .raise_resource_budget(&request, &change, 0, raised.clone(), true)
        .unwrap();
    assert_eq!(accepted.job_id, request);
    assert_eq!(jobs.read(&request).unwrap(), cancelled);
    assert_eq!(cancelled.sequence, created.sequence);
    drop(jobs);
    let reopened = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .raise_resource_budget(&request, &change, 0, raised, true)
            .unwrap(),
        accepted
    );
    let MigrationResourceBudgetView::Active {
        policy_revision,
        requested_receipt,
        usage,
        ..
    } = reopened.resource_budget(&request, Some(&change)).unwrap()
    else {
        panic!("expected an original active budget")
    };
    assert_eq!(policy_revision, 1);
    assert_eq!(requested_receipt, Some(accepted));
    assert_eq!(usage.committed_bytes, 0);
    assert_eq!(reopened.read(&request).unwrap(), cancelled);
}
