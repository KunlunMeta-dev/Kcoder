use super::*;
use kcoder_types::{external_history::HistoryImportStage, migration_resource::*};

#[test]
fn explicit_legacy_attachment_is_metadata_only_and_new_derived_writes_share_its_limit() {
    let source = tempfile::tempdir().unwrap();
    let profile = tempfile::tempdir().unwrap();
    let selected = fixture(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut done = jobs.create(&id, &selected).unwrap();
    while done.stage != HistoryImportStage::Normalized {
        done = jobs.step(&id, done.sequence, 10, |_| true).unwrap();
    }
    let journal_path = profile
        .path()
        .join("migrations/history")
        .join(format!("{id}.json"));
    let mut journal: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    let group = journal["resourceBudget"]["reference"]["group"]
        .as_str()
        .unwrap()
        .to_owned();
    journal["version"] = json!(3);
    journal.as_object_mut().unwrap().remove("resourceBudget");
    fs::write(&journal_path, serde_json::to_vec(&journal).unwrap()).unwrap();
    fs::remove_file(
        profile
            .path()
            .join("migrations/history")
            .join(format!("{id}.resource.birth")),
    )
    .unwrap();
    let ledger_path = profile
        .path()
        .join("external-history/managed-v2/lifecycle.json");
    let mut ledger: serde_json::Value =
        serde_json::from_slice(&fs::read(&ledger_path).unwrap()).unwrap();
    ledger["resource_groups"]
        .as_object_mut()
        .unwrap()
        .remove(&group);
    for archive in ledger["archives"].as_object_mut().unwrap().values_mut() {
        archive.as_object_mut().unwrap().remove("resource_budget");
    }
    fs::write(&ledger_path, serde_json::to_vec(&ledger).unwrap()).unwrap();
    fs::remove_file(source.path().join("source.jsonl")).unwrap();
    let old_journal = fs::read(&journal_path).unwrap();
    let limits = MigrationResourceLimits {
        max_total_bytes: 2 * 1024 * 1024,
        max_payload_files: 4,
        ..Default::default()
    };
    assert!(
        jobs.attach_resource_budget(&id, done.sequence, limits.clone(), false)
            .is_err()
    );
    assert_eq!(fs::read(&journal_path).unwrap(), old_journal);
    let before_raw = jobs
        .archive_reader(&id)
        .unwrap()
        .receipt()
        .unwrap()
        .unwrap();
    let attached = jobs
        .attach_resource_budget(&id, done.sequence, limits.clone(), true)
        .unwrap();
    assert_eq!(jobs.read(&id).unwrap(), done);
    assert_eq!(
        jobs.archive_reader(&id)
            .unwrap()
            .receipt()
            .unwrap()
            .unwrap(),
        before_raw
    );
    drop(jobs);
    let reopened = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .attach_resource_budget(&id, done.sequence, limits.clone(), true)
            .unwrap(),
        attached
    );
    assert_eq!(
        reopened.resource_budget_owner(&id).unwrap().as_deref(),
        Some(id.as_str())
    );
    assert_eq!(reopened.read(&id).unwrap(), done);
    let reader = reopened.archive_reader(&id).unwrap();
    assert_eq!(
        reader
            .projection("owned-new-derived/v1", true)
            .err()
            .unwrap()
            .to_string(),
        "history_resource_file_budget_exceeded"
    );
    let request = uuid::Uuid::new_v4().to_string();
    let raised = MigrationResourceLimits {
        max_payload_files: 8,
        ..limits
    };
    reopened
        .raise_resource_budget(&id, &request, 0, raised, true)
        .unwrap();
    let projection = reader
        .projection("owned-new-derived/v1", true)
        .unwrap()
        .unwrap();
    drop(projection);
    let MigrationResourceBudgetView::Active { usage, .. } =
        reopened.resource_budget(&id, None).unwrap()
    else {
        panic!("budget not active")
    };
    assert_eq!(usage.committed_files, 4);
    assert!(usage.reserved_files >= 2);
    assert!(usage.reserved_bytes > 0);
    assert_eq!(reopened.read(&id).unwrap(), done);
}
