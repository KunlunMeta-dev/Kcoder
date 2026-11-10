use super::*;
use kcoder_migration::history_discovery::HistoryCatalog;
use kcoder_types::{migration::MigrationSourceKind, migration_resource::MigrationResourceLimits};
use serde_json::json;

#[test]
fn typed_budget_requests_keep_initial_limits_and_original_job_sequence() {
    let profile = tempfile::tempdir().unwrap();
    assert!(
        execute(
            profile.path(),
            method::MIGRATION_HISTORY_RESOURCES_READ,
            json!({"jobId":uuid::Uuid::new_v4().to_string()})
        )
        .is_err()
    );
    assert!(!profile.path().join("migrations").exists());
    let source = tempfile::tempdir().unwrap();
    let directory = source.path().join("projects/owned");
    std::fs::create_dir_all(&directory).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::write(directory.join(format!("{id}.jsonl")), format!("{}\n", json!({"type":"user", "sessionId":id, "uuid":"owned", "message":{"role":"user","content":"owned budget fixture"}}))).unwrap();
    let catalog =
        HistoryCatalog::discover(source.path(), MigrationSourceKind::ClaudeCode, |_| true).unwrap();
    let page = catalog.page(None, |_| true).unwrap();
    let selected = catalog.selection(&page.items[0].source_handle).unwrap();
    let limits = MigrationResourceLimits {
        max_total_bytes: 4 * 1024 * 1024,
        max_payload_files: 16,
        min_free_bytes: 1024 * 1024,
        min_free_file_nodes: 0,
    };
    let history = HistoryJobStore::open(profile.path()).unwrap();
    let job = history
        .create_selected_with_resource_limits(&id, selected.pin().unwrap(), Some(limits.clone()))
        .unwrap();
    let read = execute(
        profile.path(),
        method::MIGRATION_HISTORY_RESOURCES_READ,
        json!({"jobId":id}),
    )
    .unwrap();
    let result: MigrationHistoryResourceResult = serde_json::from_value(read).unwrap();
    assert_eq!(result.owner_job_id.as_deref(), Some(id.as_str()));
    assert_eq!(result.initial_limits, Some(limits.clone().into()));
    let request = uuid::Uuid::new_v4().to_string();
    let mut increased = limits.clone();
    increased.max_total_bytes *= 2;
    let params = json!({"jobId":id,"requestId":request,"expectedPolicyRevision":0,"limits":increased,"confirm":true});
    let receipt = execute(
        profile.path(),
        method::MIGRATION_HISTORY_RESOURCES_INCREASE,
        params.clone(),
    )
    .unwrap();
    assert_eq!(
        execute(
            profile.path(),
            method::MIGRATION_HISTORY_RESOURCES_INCREASE,
            params
        )
        .unwrap(),
        receipt
    );
    let observed: MigrationHistoryResourceResult = serde_json::from_value(
        execute(
            profile.path(),
            method::MIGRATION_HISTORY_RESOURCES_READ,
            json!({"jobId":id,"requestId":request}),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(observed.initial_limits, Some(limits.into()));
    assert_eq!(observed.budget.limits().unwrap(), &increased.into());
    assert_eq!(
        observed.budget.requested_receipt().unwrap().request_id,
        request
    );
    assert_eq!(history.read(&id).unwrap(), job);
}
