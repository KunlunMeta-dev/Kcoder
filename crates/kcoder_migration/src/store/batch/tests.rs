use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    assets::AssetResolution,
    batch::BatchSource,
    discovery::{DiscoveryRoots, SourceRegistry},
    mcp::McpResolution,
};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::{MigrationCategory as Category, MigrationSourceKind as Kind};
mod atomic;
mod atomic_mcp;
thread_local! {static CANCELLED_ACTION_LOADS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};}
pub(super) fn record_cancelled_action_load(cancelled: bool) {
    if cancelled {
        CANCELLED_ACTION_LOADS.with(|count| count.set(count.get() + 1));
    }
}

fn targets_run(
    profile: &Path,
    store: &MigrationStore,
    job: &MigrationJob,
    request: &str,
    rollback: bool,
) -> Result<MigrationJob> {
    let provider = ProviderTarget::open(profile)?;
    let mcp = McpTarget::open(profile)?;
    let assets = AssetTarget::open(profile)?;
    store.run_batch(
        &job.job_id,
        job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
        request,
        job.sequence,
        rollback,
        &BatchTargets {
            history: None,
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
        },
    )
}
fn prepared(
    root: &Path,
    configuration: bool,
) -> (MigrationStore, MigrationJob, std::path::PathBuf) {
    prepared_with_asset_count(root, configuration, 2, Category::Instructions)
}
fn prepared_with_asset_count(
    root: &Path,
    configuration: bool,
    count: usize,
    category: Category,
) -> (MigrationStore, MigrationJob, std::path::PathBuf) {
    let profile = root.join("profile");
    let source = root.join("source");
    std::fs::create_dir(&profile).unwrap();
    std::fs::create_dir(&source).unwrap();
    let inputs = if configuration {
        std::fs::write(
            source.join("settings.json"),
            r#"{"mcpServers":{"documents":{"command":"never-run"}}}"#,
        )
        .unwrap();
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: root.into(),
            claude_config_dir: Some(source.clone()),
            codex_home: None,
            project: None,
        });
        let id = registry
            .discover(&[Kind::ClaudeCode], false)
            .0
            .into_iter()
            .find(|row| row.scope == "user")
            .unwrap()
            .source_id;
        vec![BatchSource::Configuration(registry.selected(&id).unwrap())]
    } else {
        if category == Category::Skill {
            for index in 0..count {
                let skill = source.join(format!("note-{index:04}"));
                std::fs::create_dir(&skill).unwrap();
                std::fs::write(skill.join("SKILL.md"), format!("---\nname: note-{index:04}\ndescription: Owned cancellation fixture\n---\nStatic content, never executed.\n")).unwrap();
            }
        } else {
            std::fs::write(source.join("one.md"), "First note").unwrap();
            std::fs::write(source.join("two.md"), "Second note").unwrap();
        }
        vec![BatchSource::Assets(
            AssetBundleBinding::capture(
                &source,
                Kind::ClaudeCode,
                category,
                ImportedContextScope::Global,
                true,
            )
            .unwrap(),
        )]
    };
    let store = MigrationStore::open_or_create(&profile).unwrap();
    let job = store.create_batch_scan(inputs).unwrap();
    let choices = job
        .inventory
        .items
        .iter()
        .map(|item| {
            if configuration {
                BatchResolution::Mcp(McpResolution {
                    item_id: item.preview.id.clone(),
                    target_name: "imported-documents".into(),
                    cwd: None,
                    enable_after_import: false,
                })
            } else {
                BatchResolution::Asset(AssetResolution {
                    agent_adaptation: None,
                    item_id: item.preview.id.clone(),
                    target_name: item.asset.as_ref().unwrap().name.clone(),
                    enable_after_import: false,
                    memory_scope: None,
                })
            }
        })
        .collect::<Vec<_>>();
    let provider = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    let job = store
        .prepare_batch(
            &job.job_id,
            job.sequence,
            &choices,
            &BatchTargets {
                history: None,
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                credentials: None,
            },
        )
        .unwrap();
    (store, job, profile)
}

fn cancel_current_execution(store: &MigrationStore, id: &str) {
    let observed = store.observe_batch_control(id, None).unwrap();
    let generation = observed.generation.unwrap();
    let accepted = store
        .cancel_batch_execution(&crate::batch::control::BatchCancellationIntent {
            job_id: id.into(),
            command_id: uuid::Uuid::new_v4().to_string(),
            plan_id: generation.plan_id,
            run_request_id: generation.run_request_id,
            admission_sequence: generation.admission_sequence,
        })
        .unwrap();
    assert!(accepted.cancel_requested);
    assert!(accepted.requested_receipt.is_some());
}

#[test]
fn cancel_tail_unstarted_actions_do_not_reload_the_whole_job_per_item() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = prepared_with_asset_count(root.path(), false, 256, Category::Skill);
    let provider = ProviderTarget::open(&profile).unwrap();
    let mcp = McpTarget::open(&profile).unwrap();
    let assets = AssetTarget::open(&profile).unwrap();
    CANCELLED_ACTION_LOADS.with(|count| count.set(0));
    let finished = store
        .run_batch_controlled(
            BatchExecution {
                job_id: &job.job_id,
                plan_id: job.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
                request_id: "apply",
                expected_sequence: job.sequence,
                mode: BatchRunMode::Apply,
            },
            &BatchTargets {
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                history: None,
                credentials: None,
            },
            &mut |event| {
                if let BatchRunEvent::Action { index, .. } = event {
                    assert_eq!(index, 0, "Cancellation must not start another item");
                    cancel_current_execution(&store, &job.job_id);
                }
                true
            },
        )
        .unwrap();
    assert_eq!(finished.status, JobStatus::Cancelled);
    assert_eq!(finished.receipts.len(), 1);
    assert_eq!(CANCELLED_ACTION_LOADS.with(|count| count.get()), 1);
}

#[test]
fn cancel_tail_still_reconciles_a_later_unknown_before_finishing() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = prepared_with_asset_count(root.path(), false, 4, Category::Skill);
    // A definite first failure precedes an actual publication with a lost receipt.
    let first = &job.inventory.items[0];
    std::fs::remove_file(
        root.path()
            .join("source")
            .join(&first.asset.as_ref().unwrap().entry)
            .join("SKILL.md"),
    )
    .unwrap();
    FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
    assert!(targets_run(&profile, &store, &job, "apply", false).is_err());
    let pending = store.read(&job.job_id).unwrap();
    let actions = &pending.batch.as_ref().unwrap().actions;
    assert_eq!(actions[0].status, ItemStatus::Failed);
    assert_eq!(actions[1].status, ItemStatus::Committing);
    assert!(pending.receipts.is_empty());
    cancel_current_execution(&store, &job.job_id);
    let cancelled = store.read(&job.job_id).unwrap();
    CANCELLED_ACTION_LOADS.with(|count| count.set(0));
    let finished = targets_run(&profile, &store, &cancelled, "apply", false).unwrap();
    assert_eq!(finished.status, JobStatus::Cancelled);
    assert_eq!(
        finished.batch.as_ref().unwrap().actions[0].status,
        ItemStatus::Failed
    );
    assert_eq!(
        finished.batch.as_ref().unwrap().actions[1].status,
        ItemStatus::Committed
    );
    assert_eq!(finished.receipts.len(), 1);
    assert!(finished.receipts[0].ownership_confirmed);
    assert_eq!(CANCELLED_ACTION_LOADS.with(|count| count.get()), 3);
    assert_eq!(
        targets_run(&profile, &store, &finished, "undo", true)
            .unwrap()
            .status,
        JobStatus::RolledBack
    );
}

#[test]
fn settings_receipt_loss_reconciles_without_claiming_deletion_authority() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = prepared(root.path(), true);
    FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
    assert!(targets_run(&profile, &store, &job, "apply", false).is_err());
    let pending = store.read(&job.job_id).unwrap();
    assert_eq!(pending.status, JobStatus::Applying);
    assert!(pending.receipts.is_empty());
    assert!(targets_run(&profile, &store, &pending, "undo-before-reconcile", true).is_err());
    let store = MigrationStore::open_existing(&profile).unwrap();
    let committed = targets_run(&profile, &store, &pending, "apply", false).unwrap();
    assert!(!committed.receipts[0].ownership_confirmed);
    let undone = targets_run(&profile, &store, &committed, "undo", true).unwrap();
    assert_eq!(undone.status, JobStatus::RollbackConflict);
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap()["mcp_servers"]
            [0]["name"],
        "imported-documents"
    );
}

#[test]
fn cancellation_reconciles_in_flight_owned_asset_and_does_not_start_later_assets() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = prepared(root.path(), false);
    FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
    assert!(targets_run(&profile, &store, &job, "apply", false).is_err());
    let pending = store.read(&job.job_id).unwrap();
    let cancelled = store.cancel(&job.job_id, pending.sequence).unwrap();
    assert_eq!(cancelled.status, JobStatus::CancelRequested);
    std::fs::remove_file(root.path().join("source/one.md")).unwrap();
    let final_job = targets_run(&profile, &store, &cancelled, "apply", false).unwrap();
    assert_eq!(final_job.status, JobStatus::Cancelled);
    assert_eq!(final_job.receipts.len(), 1);
    assert!(final_job.receipts[0].ownership_confirmed);
    assert_eq!(
        kcoder_config::imported_context::ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap()
            .len(),
        1
    );
    let undone = targets_run(&profile, &store, &final_job, "undo", true).unwrap();
    assert_eq!(undone.status, JobStatus::RolledBack);
    assert!(
        kcoder_config::imported_context::ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn rollback_receipt_loss_reconciles_the_same_undo_instead_of_reimporting() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = prepared(root.path(), false);
    let committed = targets_run(&profile, &store, &job, "apply", false).unwrap();
    FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
    assert!(targets_run(&profile, &store, &committed, "undo", true).is_err());
    let pending = store.read(&job.job_id).unwrap();
    assert_eq!(pending.status, JobStatus::RollingBack);
    let undone = targets_run(&profile, &store, &pending, "undo", true).unwrap();
    assert_eq!(undone.status, JobStatus::RolledBack);
    assert!(
        kcoder_config::imported_context::ImportedContextStore::open(&profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn an_unconfirmed_settings_write_cannot_recreate_content_removed_by_the_user() {
    let root = tempfile::tempdir().unwrap();
    let (store, job, profile) = prepared(root.path(), true);
    FAIL_AFTER_PUBLICATION.with(|fail| fail.set(true));
    assert!(targets_run(&profile, &store, &job, "apply", false).is_err());
    std::fs::write(profile.join("settings.json"), "{}").unwrap();
    let pending = store.read(&job.job_id).unwrap();
    let observed = targets_run(&profile, &store, &pending, "apply", false).unwrap();
    assert_eq!(observed.status, JobStatus::CompletedWithIssues);
    assert!(observed.receipts.is_empty());
    assert_eq!(
        kcoder_config::read_settings_file(&profile.join("settings.json")).unwrap(),
        serde_json::json!({})
    );
}
