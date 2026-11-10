//! Initial history limits are persisted at acceptance, before any archive or parser runs.
use super::*;
use kcoder_migration::history_jobs::HistoryJobStore;
use kcoder_types::migration_resource::MigrationResourceLimits;

#[test]
fn initial_resource_history_selection_persists_all_flags_and_same_request_cannot_change_them() {
    let f = Fixture::new();
    let source_id = uuid::Uuid::new_v4().to_string();
    f.source(&source_id);
    let request = uuid::Uuid::new_v4().to_string();
    let mut arguments = vec![
        "select",
        "--source",
        "claude-code",
        "--source-root",
        f.source.to_str().unwrap(),
        "--source-session-id",
        &source_id,
        "--request-id",
        &request,
        "--resource-max-total-bytes",
        "2097152",
        "--resource-max-payload-files",
        "13",
        "--resource-min-free-bytes",
        "1048576",
        "--resource-min-free-file-nodes",
        "0",
    ];
    let accepted = f.call(&arguments);
    assert_eq!(accepted["jobId"], request);
    assert_eq!(accepted["archived"], false);
    let jobs = HistoryJobStore::open_existing(&f.profile).unwrap().unwrap();
    let budget = jobs.resource_budget(&request, None).unwrap();
    let expected = MigrationResourceLimits {
        max_total_bytes: 2 * 1024 * 1024,
        max_payload_files: 13,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    };
    assert_eq!(
        serde_json::to_value(budget.limits().unwrap()).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let repeated = f.call(&arguments);
    assert_eq!(repeated["sequence"], accepted["sequence"]);
    let value_at = arguments
        .iter()
        .position(|value| *value == "--resource-max-total-bytes")
        .unwrap()
        + 1;
    arguments[value_at] = "4194304";
    let rejected = f.invoke(&arguments);
    assert!(!rejected.status.success());
    assert!(
        String::from_utf8_lossy(&rejected.stderr)
            .contains("history_resource_initial_limits_changed")
    );
    assert_eq!(jobs.resource_budget(&request, None).unwrap(), budget);
    std::fs::rename(&f.source, f.root.path().join("source-withheld")).unwrap();
    let read = f.call(&["read", "--job-id", &request]);
    assert_eq!(read["jobId"], request);
    assert_eq!(read["sequence"], accepted["sequence"]);
    assert_eq!(jobs.resource_budget(&request, None).unwrap(), budget);
    assert!(!f.workspace.join("NEVER_REPLAY").exists());
}

#[test]
fn initial_resource_history_omission_keeps_native_default_and_invalid_value_creates_no_job() {
    let f = Fixture::new();
    let source_id = uuid::Uuid::new_v4().to_string();
    f.source(&source_id);
    let original = uuid::Uuid::new_v4().to_string();
    f.selected(&source_id, &original);
    let jobs = HistoryJobStore::open_existing(&f.profile).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(
            jobs.resource_budget(&original, None)
                .unwrap()
                .limits()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(MigrationResourceLimits::default()).unwrap()
    );
    let invalid = uuid::Uuid::new_v4().to_string();
    let result = f.invoke(&[
        "select",
        "--source",
        "claude-code",
        "--source-root",
        f.source.to_str().unwrap(),
        "--source-session-id",
        &source_id,
        "--request-id",
        &invalid,
        "--resource-max-payload-files",
        "0",
    ]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("migration_invalid_resource_limits"));
    assert!(jobs.read(&invalid).is_err());
    assert_eq!(jobs.records(None).unwrap().0.len(), 1);
}
