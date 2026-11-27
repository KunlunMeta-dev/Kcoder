use super::*;
use crate::{
    asset_sources::AssetBundleBinding,
    assets::AssetTarget,
    batch::{BatchSource, default_resolution, history::HistoryBatchSource},
    history_jobs::HistoryJobStore,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::{MigrationCategory, MigrationJobStatus};

#[test]
fn received_static_assets_use_normal_disabled_plans_without_a_live_source_or_native_reference() {
    let f = Fixture::new();
    let path = f.files.join("AGENTS.md");
    std::fs::write(&path, "A received static source, not a live project file").unwrap();
    let source = AssetBundleBinding::capture(
        &path,
        Kind::Codex,
        MigrationCategory::Instructions,
        ImportedContextScope::Project {
            root: f.files.clone(),
        },
        false,
    )
    .unwrap();
    assert!(source.read("AGENTS.md").unwrap().native_reference);
    let manifest = f.export(ExportSelection::Asset {
        binding: source,
        key: "AGENTS.md".into(),
    });
    let receipt = f.copy(&manifest);
    let workspace = f._root.path().join("target-workspace");
    PrivateDirectory::open_or_create(&workspace).unwrap();
    let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
    assert!(
        f.target
            .received_asset_binding(
                &f.request,
                &receipt.manifest_sha256,
                &manifest.entries[0].id,
                None
            )
            .is_err()
    );
    let asset = f
        .target
        .received_asset_binding(
            &f.request,
            &receipt.manifest_sha256,
            &manifest.entries[0].id,
            Some(project),
        )
        .unwrap();
    assert!(asset.source_path("AGENTS.md").is_err());
    let bytes = serde_json::to_vec(&asset).unwrap();
    std::fs::remove_dir_all(&f.files).unwrap();
    let asset: AssetBundleBinding = serde_json::from_slice(&bytes).unwrap();
    let delivered = asset.read("AGENTS.md").unwrap();
    assert!(!delivered.native_reference);
    assert!(delivered.files.iter().all(|file| !file.executable));
    let peer = MigrationStore::open_or_create(&f.source_profile).unwrap();
    assert!(
        peer.create_batch_scan(vec![BatchSource::Assets(asset.clone())])
            .is_err()
    );
    assert!(peer.create_asset_scan(asset.clone()).is_err());
    let store = MigrationStore::open_existing(&f.target_profile).unwrap();
    let scan = store
        .create_batch_scan(vec![BatchSource::Assets(asset)])
        .unwrap();
    assert!(!workspace.join("AGENTS.md").exists());
    let choices = scan
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scan, item))
        .collect::<Vec<_>>();
    assert_eq!(choices.len(), 1);
    let provider = ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = McpTarget::open(&f.target_profile).unwrap();
    let assets = AssetTarget::open(&f.target_profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: None,
        credentials: None,
    };
    let plan = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    assert!(!workspace.join("AGENTS.md").exists());
    let done = store
        .run_batch(
            &plan.job_id,
            plan.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "explicit-apply",
            plan.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::Completed);
    assert!(!workspace.join("AGENTS.md").exists());
    let contexts =
        kcoder_config::imported_context::ImportedContextStore::open(&f.target_profile).unwrap();
    assert!(contexts.list().unwrap().iter().all(|entry| !entry.enabled));
}

#[test]
fn received_history_retains_the_authenticated_origin_through_normal_archive_and_batch() {
    let f = Fixture::new();
    let original = f.history();
    let manifest = f.export(ExportSelection::CapturedHistory(original));
    let receipt = f.copy(&manifest);
    let selection = f
        .target
        .received_history_selection(
            &f.request,
            &receipt.manifest_sha256,
            &manifest.entries[0].id,
            |_| true,
        )
        .unwrap();
    let expected = selection
        .capture(&mut |_, _| true)
        .unwrap()
        .snapshot()
        .clone();
    assert_ne!(expected.origin.source_instance, "owned-source-machine");
    let bytes = serde_json::to_vec(&selection).unwrap();
    std::fs::remove_dir_all(&f.files).unwrap();
    let restored: crate::history_discovery::HistoryPendingSelection =
        serde_json::from_slice(&bytes).unwrap();
    let wrong_history_target = HistoryJobStore::open(&f.source_profile).unwrap();
    assert!(
        wrong_history_target
            .create_selected(&uuid::Uuid::new_v4().to_string(), restored.clone())
            .is_err()
    );
    let source = BatchSource::History(Box::new(HistoryBatchSource::new(restored).unwrap()));
    let peer = MigrationStore::open_or_create(&f.source_profile).unwrap();
    assert!(peer.create_batch_scan(vec![source.clone()]).is_err());
    let store = MigrationStore::open_existing(&f.target_profile).unwrap();
    let scan = store.create_batch_scan(vec![source]).unwrap();
    let choices = scan
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scan, item))
        .collect::<Vec<_>>();
    let provider = ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = McpTarget::open(&f.target_profile).unwrap();
    let assets = AssetTarget::open(&f.target_profile).unwrap();
    let history = HistoryJobStore::open(&f.target_profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let plan = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    let done = store
        .run_batch(
            &plan.job_id,
            plan.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "explicit-archive",
            plan.sequence,
            false,
            &targets,
        )
        .unwrap();
    // The intentionally oversized record retains its normalization warning.
    // The original archive remains byte-exact instead of claiming a clean projection.
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(done.inventory.items[0].preview.issues.len(), 1);
    let issue = &done.inventory.items[0].preview.issues[0];
    assert_eq!(
        issue.code,
        kcoder_types::migration::MigrationIssueCode::RequiresReview
    );
    assert_eq!(
        issue.severity,
        kcoder_types::migration::MigrationIssueSeverity::Warning
    );
    assert_eq!(
        issue.phase,
        kcoder_types::migration::MigrationIssuePhase::Activation
    );
    let crate::batch::BatchActionKind::History { plan } =
        &done.batch.as_ref().unwrap().actions[0].action
    else {
        panic!("expected history")
    };
    let child = history.read(&plan.history_job_id).unwrap();
    let archive = history.archive_reader(&plan.history_job_id).unwrap();
    assert!(archive.origin() == &expected.origin);
    let archive_receipt = archive.receipt().unwrap().unwrap();
    assert_eq!(archive_receipt.source_sha256, expected.source_sha256);
    assert_eq!(archive_receipt.source_bytes, expected.source_bytes);
    assert_eq!(child.stage, HistoryImportStage::Normalized);
}

#[test]
fn fresh_history_adoption_initializes_only_the_target_service_before_normal_plan_run_and_undo() {
    let f = Fixture::new();
    assert!(
        HistoryJobStore::open_existing(&f.target_profile)
            .unwrap()
            .is_none()
    );
    let original = f.history();
    let expected = original.snapshot().clone();
    let manifest = f.export(ExportSelection::CapturedHistory(original));
    let receipt = f.copy(&manifest);
    let adoption = uuid::Uuid::new_v4().to_string();
    let (_, owner) = f
        .target
        .prepare_adoption(
            &f.request,
            &adoption,
            &receipt.manifest_sha256,
            vec![ReceivedAdoptionSelection {
                entry_id: manifest.entries[0].id.clone(),
                project_mapping: None,
            }],
            None,
        )
        .unwrap();
    assert!(
        HistoryJobStore::open_existing(&f.target_profile)
            .unwrap()
            .is_none()
    );
    std::fs::remove_dir_all(&f.files).unwrap();
    let ready = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(ready.phase, ReceivedAdoptionPhase::PreviewReady);
    let history = HistoryJobStore::open_existing(&f.target_profile)
        .unwrap()
        .expect("the explicit history adoption must prepare the normal target service");
    assert_eq!(
        std::fs::read_dir(f.target_profile.join("migrations/history"))
            .unwrap()
            .count(),
        0,
        "preview does not create or run a history child"
    );
    assert!(
        std::fs::read_dir(f.target_profile.join("external-history"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("archive-")),
        "preview does not reserve or import an archive"
    );
    assert!(!f.target_profile.join("sessions").exists());
    let store = MigrationStore::open_existing(&f.target_profile).unwrap();
    let scan = store.read(&ready.jobs[0].job_id).unwrap();
    let choices = scan
        .inventory
        .items
        .iter()
        .filter_map(|item| default_resolution(&scan, item))
        .collect::<Vec<_>>();
    assert_eq!(choices.len(), 1);
    let provider = ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = McpTarget::open(&f.target_profile).unwrap();
    let assets = AssetTarget::open(&f.target_profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: Some(&history),
        credentials: None,
    };
    let plan = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    let crate::batch::BatchActionKind::History { plan: child_plan } =
        &plan.batch.as_ref().unwrap().actions[0].action
    else {
        panic!("expected history action")
    };
    assert!(history.read(&child_plan.history_job_id).is_err());
    let plan_id = plan.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let done = store
        .run_batch(
            &plan.job_id,
            plan_id,
            "explicit-archive",
            plan.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(done.status, MigrationJobStatus::CompletedWithIssues);
    assert_eq!(
        history.read(&child_plan.history_job_id).unwrap().stage,
        HistoryImportStage::Normalized
    );
    let archive = history.archive_reader(&child_plan.history_job_id).unwrap();
    let archived = archive.receipt().unwrap().unwrap();
    assert_eq!(archived.source_sha256, expected.source_sha256);
    assert_eq!(archived.source_bytes, expected.source_bytes);
    drop(archive);
    let undone = store
        .run_batch(
            &done.job_id,
            plan_id,
            "explicit-undo",
            done.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert!(history.archive_reader(&child_plan.history_job_id).is_err());
    assert!(
        history
            .retirement_for_job(&child_plan.history_job_id)
            .unwrap()
            .unwrap()
            .logical_retired
    );
    assert!(!f.target_profile.join("sessions").exists());
}
