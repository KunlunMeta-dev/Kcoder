//! Scoped instruction recipes use real ordinary batch publication and original-owner Undo.
use kcoder_config::{
    PrivateDirectory,
    imported_context::{ImportedContextScope, ImportedContextStore},
};
use kcoder_migration::{
    asset_sources::AssetBundleBinding,
    assets::{AssetResolution, AssetTarget},
    batch::{BatchResolution, BatchSource},
    instruction_sources::{InstructionSourceGrant, InstructionSourcePolicy},
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchCaptureInput, BatchCreateIntent, BatchTargets, MigrationJob, MigrationStore},
};
use kcoder_types::migration::{MigrationJobStatus, MigrationSourceKind};
use std::{fs, path::PathBuf, sync::Arc};
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    source: PathBuf,
    target: PathBuf,
    store: MigrationStore,
    binding: AssetBundleBinding,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let source = root.path().join("source");
    let target = root.path().join("target");
    PrivateDirectory::open_or_create(&profile).unwrap();
    fs::write(profile.join("settings.json"), "{}").unwrap();
    fs::create_dir_all(source.join(".git")).unwrap();
    fs::create_dir_all(source.join("child")).unwrap();
    fs::create_dir_all(target.join("mapped")).unwrap();
    fs::write(
        source.join("AGENTS.md"),
        "ROOT_SCOPE_MARKER: keep root examples.\n",
    )
    .unwrap();
    fs::write(
        source.join("child/AGENTS.md"),
        "CHILD_SCOPE_MARKER: keep child checks.\n",
    )
    .unwrap();
    fs::write(
        profile.join("trusted-folders.json"),
        serde_json::to_vec(&serde_json::json!({"trusted":[source,target],"never":[]})).unwrap(),
    )
    .unwrap();
    let snapshot = Arc::new(
        InstructionSourceGrant::capture(&profile, &source, &source, MigrationSourceKind::Codex)
            .unwrap()
            .capture_sources(
                &InstructionSourcePolicy {
                    include_descendants: true,
                    ..Default::default()
                },
                |_| true,
            )
            .unwrap(),
    );
    let mapping = snapshot
        .summaries()
        .into_iter()
        .map(|row| {
            (
                row.id,
                if row.relative_scope.is_empty() {
                    String::new()
                } else {
                    "mapped".into()
                },
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(mapping.len(), 2);
    let binding = AssetBundleBinding::capture_scoped_instructions(
        &profile, &target, snapshot, &mapping, false,
    )
    .unwrap();
    let store = MigrationStore::open_or_create(&profile).unwrap();
    Fixture {
        _root: root,
        profile,
        source,
        target,
        store,
        binding,
    }
}
fn create(f: &Fixture) -> MigrationJob {
    let intent=BatchCreateIntent::new(&uuid::Uuid::new_v4().to_string(),&serde_json::json!({"source":"owned-scoped-fixture","mapping":"root-and-mapped","enable":true})).unwrap();
    f.store
        .create_batch_scan_idempotent(
            &intent,
            |_| {
                Ok(BatchCaptureInput {
                    sources: vec![BatchSource::Assets(f.binding.clone())],
                    resource_limits: Default::default(),
                    project: None,
                })
            },
            &mut |_, _| true,
        )
        .unwrap()
        .job
        .unwrap()
}
fn choices(job: &MigrationJob) -> Vec<BatchResolution> {
    job.inventory
        .items
        .iter()
        .map(|item| {
            BatchResolution::Asset(AssetResolution {
                agent_adaptation: None,
                item_id: item.preview.id.clone(),
                target_name: "Mapped guide".into(),
                enable_after_import: true,
                memory_scope: None,
            })
        })
        .collect()
}
#[test]
fn actual_batch_keeps_mapped_scopes_one_cohort_and_offline_preview_and_owned_undo() {
    let f = fixture();
    let scanned = create(&f);
    let encoded = serde_json::to_string(&scanned).unwrap();
    assert!(!encoded.contains("ROOT_SCOPE_MARKER") && !encoded.contains("CHILD_SCOPE_MARKER"));
    assert!(!encoded.contains(f.source.to_str().unwrap()));
    let provider = ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let planned = f
        .store
        .prepare_batch(
            &scanned.job_id,
            scanned.sequence,
            &choices(&scanned),
            &targets,
        )
        .unwrap();
    let plan_id = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
    let applied = f
        .store
        .run_batch(
            &planned.job_id,
            plan_id,
            "scope-apply",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert_eq!(applied.receipts.len(), 2);
    let records = ImportedContextStore::open(&f.profile)
        .unwrap()
        .list()
        .unwrap();
    assert_eq!(records.len(), 2);
    assert!(records.iter().any(|row| row.scope
        == ImportedContextScope::Project {
            root: f.target.clone()
        }));
    assert!(records.iter().any(|row| row.scope
        == ImportedContextScope::Project {
            root: f.target.join("mapped")
        }));
    assert!(
        records
            .iter()
            .all(|row| row.enabled && row.name == "Mapped guide")
    );
    assert_eq!(
        records[0]
            .instruction_provenance
            .as_ref()
            .unwrap()
            .cohort_id,
        records[1]
            .instruction_provenance
            .as_ref()
            .unwrap()
            .cohort_id
    );
    assert_ne!(
        records[0].instruction_provenance.as_ref().unwrap().rank,
        records[1].instruction_provenance.as_ref().unwrap().rank
    );
    fs::rename(&f.source, f.source.with_extension("withheld")).unwrap();
    let reopened = MigrationStore::open_existing(&f.profile).unwrap();
    let saved = reopened.read(&applied.job_id).unwrap();
    for item in &saved.inventory.items {
        let text = reopened
            .asset_snapshot(&saved.job_id, &item.preview.id)
            .unwrap()
            .unwrap();
        assert!(text.contains("SCOPE_MARKER"));
    }
    let undone = reopened
        .run_batch(
            &saved.job_id,
            plan_id,
            "scope-undo",
            saved.sequence,
            true,
            &targets,
        )
        .unwrap();
    assert_eq!(undone.status, MigrationJobStatus::RolledBack);
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        "{}"
    );
    assert!(!f.profile.join("skills").exists());
}
#[test]
fn replacing_only_the_selected_target_child_does_not_refresh_the_original_mapping() {
    let f = fixture();
    let scanned = create(&f);
    fs::rename(f.target.join("mapped"), f.target.join("retained-mapped")).unwrap();
    fs::create_dir(f.target.join("mapped")).unwrap();
    let provider = ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let error = f
        .store
        .prepare_batch(
            &scanned.job_id,
            scanned.sequence,
            &choices(&scanned),
            &targets,
        )
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("migration_instruction_target_changed")
    );
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        "{}"
    );
}

#[test]
fn opaque_descendant_is_owned_pending_data_and_can_be_read_without_source_or_a_plan() {
    let mut f = fixture();
    let opaque = b"\xff\xfe OPAQUE_PENDING_GUIDE";
    fs::write(f.source.join("child/AGENTS.md"), opaque).unwrap();
    let snapshot = Arc::new(
        InstructionSourceGrant::capture(
            &f.profile,
            &f.source,
            &f.source,
            MigrationSourceKind::Codex,
        )
        .unwrap()
        .capture_sources(
            &InstructionSourcePolicy {
                include_descendants: true,
                ..Default::default()
            },
            |_| true,
        )
        .unwrap(),
    );
    let mapping = snapshot
        .summaries()
        .into_iter()
        .map(|row| {
            (
                row.id,
                if row.relative_scope.is_empty() {
                    String::new()
                } else {
                    "mapped".into()
                },
            )
        })
        .collect::<Vec<_>>();
    f.binding = AssetBundleBinding::capture_scoped_instructions(
        &f.profile, &f.target, snapshot, &mapping, false,
    )
    .unwrap();
    let saved = create(&f);
    let pending = saved
        .inventory
        .items
        .iter()
        .find(|item| !item.preview.selected_by_default)
        .unwrap();
    assert_eq!(
        pending.preview.status,
        kcoder_types::migration::MigrationItemStatus::RequiresAction
    );
    assert!(!pending.preview.issues.is_empty());
    fs::rename(&f.source, f.source.with_extension("withheld")).unwrap();
    let store = MigrationStore::open_existing(&f.profile).unwrap();
    assert_eq!(
        store
            .instruction_source_snapshot(&saved.job_id, &pending.preview.id)
            .unwrap()
            .unwrap(),
        opaque
    );
    assert!(
        store
            .asset_snapshot(&saved.job_id, &pending.preview.id)
            .unwrap()
            .is_none()
    );
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(f.profile.join("settings.json")).unwrap(),
        "{}"
    );
}

#[test]
fn first_publication_rechecks_source_and_never_replays_a_changed_guide() {
    let f = fixture();
    let scanned = create(&f);
    let provider = ProviderTarget::open(&f.profile).unwrap();
    let mcp = McpTarget::open(&f.profile).unwrap();
    let assets = AssetTarget::open(&f.profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let planned = f
        .store
        .prepare_batch(
            &scanned.job_id,
            scanned.sequence,
            &choices(&scanned),
            &targets,
        )
        .unwrap();
    fs::write(
        f.source.join("AGENTS.md"),
        "Changed after preview, never a new captured instruction.",
    )
    .unwrap();
    let result = f
        .store
        .run_batch(
            &planned.job_id,
            planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap(),
            "changed-source",
            planned.sequence,
            false,
            &targets,
        )
        .unwrap();
    assert!(result.receipts.is_empty());
    assert_ne!(result.status, MigrationJobStatus::Completed);
    assert!(
        ImportedContextStore::open(&f.profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
    for item in &planned.inventory.items {
        assert!(
            f.store
                .asset_snapshot(&planned.job_id, &item.preview.id)
                .unwrap()
                .unwrap()
                .contains("SCOPE_MARKER")
        );
    }
}

#[test]
fn ordinary_asset_binding_keeps_the_legacy_absent_field_and_capture_behavior() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("CLAUDE.md");
    fs::write(&path, "An ordinary legacy guide.").unwrap();
    let binding = AssetBundleBinding::capture(
        &path,
        MigrationSourceKind::ClaudeCode,
        kcoder_types::migration::MigrationCategory::Instructions,
        ImportedContextScope::Global,
        false,
    )
    .unwrap();
    let value = serde_json::to_value(&binding).unwrap();
    assert!(value.get("instructions").is_none());
    let restored: AssetBundleBinding = serde_json::from_value(value).unwrap();
    assert_eq!(
        restored.read("CLAUDE.md").unwrap().files[0].content,
        b"An ordinary legacy guide."
    );
}

#[test]
fn old_transfer_ir_rejects_scoped_semantics_before_creating_a_transfer_request() {
    use kcoder_migration::source_transfer::{ExportSelection, IncomingTransfers, SourceTransfers};
    let f = fixture();
    let saved = create(&f);
    let source = SourceTransfers::open(&f.profile).unwrap();
    let target_profile = f._root.path().join("transfer-target");
    let target = IncomingTransfers::open(&target_profile).unwrap();
    let captured = match &saved.batch.as_ref().unwrap().sources[0] {
        BatchSource::Assets(binding) => binding.clone(),
        _ => panic!("owned asset source"),
    };
    for binding in [f.binding.clone(), captured] {
        let request = uuid::Uuid::new_v4().to_string();
        let destination = target
            .issue_destination(&request, source.authority())
            .unwrap();
        let key = binding.entries().unwrap().remove(0);
        let error = source
            .prepare(
                &request,
                &destination,
                vec![ExportSelection::Asset { binding, key }],
            )
            .err()
            .unwrap();
        assert_eq!(
            error.to_string(),
            "source_transfer_scoped_instructions_update_required"
        );
        assert!(
            source
                .prepared_destination(&request, &destination.authority)
                .unwrap()
                .is_none()
        );
    }
}
