//! Native intent seals each actual directory while retaining the existing adoption/Undo journal.
use super::instructions::{capture, target, transfer, trust};
use super::*;
use crate::{
    assets::{AssetResolution, AssetTarget},
    batch::BatchResolution,
    mcp::McpTarget,
    providers::ProviderTarget,
    store::{BatchTargets, MigrationStore},
};
use kcoder_config::imported_context::ImportedContextStore;

fn selected(entry: &str) -> Vec<ReceivedAdoptionSelection> {
    vec![ReceivedAdoptionSelection {
        entry_id: entry.into(),
        project_mapping: Some(ReceivedProjectMapping::CurrentWorkspace),
    }]
}
fn mapping(
    f: &Fixture,
    root: &ReceivedProjectTarget,
    entry: &str,
    snapshot: &crate::instruction_sources::InstructionSourceSnapshot,
    archive: bool,
) -> ReceivedInstructionAdoptionMapping {
    let rows = snapshot
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
    ReceivedInstructionAdoptionMapping::capture(&f.target_profile, root, entry, &rows, archive)
        .unwrap()
}
#[test]
fn two_vendors_keep_original_adoption_ids_mapped_scope_and_normal_publication_undo_after_source_gone()
 {
    for kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new();
        let workspace = target(&f);
        let local = capture(&f, kind);
        let (manifest, receipt, snapshot) = transfer(&f, local);
        let entry = &manifest.entries[0].id;
        let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
        let map = mapping(&f, &project, entry, &snapshot, false);
        let selections = selected(entry);
        let adoption = uuid::Uuid::new_v4().to_string();
        let (initial, owner) = f
            .target
            .prepare_adoption_with_instructions(
                &f.request,
                &adoption,
                &receipt.manifest_sha256,
                selections.clone(),
                Some(project.clone()),
                vec![map.clone()],
            )
            .unwrap();
        assert_eq!(initial.phase, ReceivedAdoptionPhase::Prepared);
        std::fs::rename(&f.files, f._root.path().join("source-offline")).unwrap();
        std::fs::rename(
            &f.source_profile,
            f._root.path().join("source-profile-offline"),
        )
        .unwrap();
        let (same, duplicate) = f
            .target
            .prepare_adoption_with_instructions(
                &f.request,
                &adoption,
                &receipt.manifest_sha256,
                selections,
                Some(project.clone()),
                vec![map],
            )
            .unwrap();
        assert!(duplicate.is_none());
        assert_eq!(same.jobs, initial.jobs);
        let ready = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
        assert_eq!(
            ready.phase,
            ReceivedAdoptionPhase::PreviewReady,
            "{ready:?}"
        );
        assert_eq!(
            ready.jobs,
            initial
                .jobs
                .iter()
                .map(|job| ReceivedAdoptionJob {
                    preview_ready: true,
                    ..job.clone()
                })
                .collect::<Vec<_>>()
        );
        let store = MigrationStore::open_existing(&f.target_profile).unwrap();
        let job = store.read(&ready.jobs[0].job_id).unwrap();
        assert_eq!(job.inventory.items.len(), 2);
        let provider = ProviderTarget::open(&f.target_profile).unwrap();
        let mcp = McpTarget::open(&f.target_profile).unwrap();
        let assets = AssetTarget::open(&f.target_profile).unwrap();
        let targets = BatchTargets {
            provider: &provider,
            mcp: &mcp,
            assets: &assets,
            credentials: None,
            history: None,
        };
        let choices = job
            .inventory
            .items
            .iter()
            .map(|item| {
                BatchResolution::Asset(AssetResolution {
                    agent_adaptation: None,
                    item_id: item.preview.id.clone(),
                    target_name: "Adopted scoped guide".into(),
                    enable_after_import: false,
                    memory_scope: None,
                })
            })
            .collect::<Vec<_>>();
        let planned = store
            .prepare_batch(&job.job_id, job.sequence, &choices, &targets)
            .unwrap();
        let plan = planned.batch.as_ref().unwrap().plan_id.as_deref().unwrap();
        let imported = store
            .run_batch(
                &job.job_id,
                plan,
                "instruction-adoption-import",
                planned.sequence,
                false,
                &targets,
            )
            .unwrap();
        let records = ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|row| !row.enabled));
        for item in &imported.inventory.items {
            store
                .instruction_source_snapshot(&job.job_id, &item.preview.id)
                .unwrap()
                .unwrap();
            store
                .instruction_compiled_snapshot(&job.job_id, &item.preview.id)
                .unwrap()
                .unwrap();
        }
        let undone = store
            .run_batch(
                &job.job_id,
                plan,
                "instruction-adoption-undo",
                imported.sequence,
                true,
                &targets,
            )
            .unwrap();
        assert_eq!(
            undone.status,
            kcoder_types::migration::MigrationJobStatus::RolledBack
        );
        assert!(
            ImportedContextStore::open(&f.target_profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read_to_string(f.target_profile.join("settings.json")).unwrap(),
            "{}"
        );
    }
}
#[test]
fn cancelled_adoption_reopens_the_same_mapping_and_stale_or_changed_intents_never_rebind() {
    let f = Fixture::new();
    let workspace = target(&f);
    let local = capture(&f, Kind::Codex);
    let (manifest, receipt, snapshot) = transfer(&f, local);
    let entry = &manifest.entries[0].id;
    let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
    let map = mapping(&f, &project, entry, &snapshot, false);
    let id = uuid::Uuid::new_v4().to_string();
    let (initial, owner) = f
        .target
        .prepare_adoption_with_instructions(
            &f.request,
            &id,
            &receipt.manifest_sha256,
            selected(entry),
            Some(project.clone()),
            vec![map.clone()],
        )
        .unwrap();
    f.target
        .cancel_adoption(&f.request, &id, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let stopped = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(stopped.phase, ReceivedAdoptionPhase::Cancelled);
    assert_eq!(stopped.jobs, initial.jobs);
    let other = ReceivedInstructionAdoptionMapping::capture(
        &f.target_profile,
        &project,
        entry,
        &[(snapshot.summaries()[0].id.clone(), "mapped".into())],
        false,
    )
    .unwrap();
    assert!(
        f.target
            .prepare_adoption_with_instructions(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selected(entry),
                Some(project),
                vec![other]
            )
            .is_err()
    );
    std::fs::rename(&f.files, f._root.path().join("source-offline")).unwrap();
    let receiver = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let (resumed, owner) = receiver
        .resume_adoption(&f.request, &id, stopped.control.unwrap())
        .unwrap();
    assert_eq!(resumed.jobs, initial.jobs);
    let ready = receiver.execute_adoption(owner, |_| true).unwrap();
    assert_eq!(
        ready.phase,
        ReceivedAdoptionPhase::PreviewReady,
        "{ready:?}"
    );
    assert_eq!(ready.jobs[0].job_id, initial.jobs[0].job_id);
    assert!(
        ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn source_product_proof_and_replaced_or_untrusted_children_cannot_authorize_a_target() {
    let f = Fixture::new();
    let workspace = target(&f);
    let local = capture(&f, Kind::ClaudeCode);
    let (manifest, receipt, snapshot) = transfer(&f, local);
    let entry = &manifest.entries[0].id;
    let fake_project = ReceivedProjectTarget::capture(&f.target_profile, &f.files).unwrap();
    assert!(
        ReceivedInstructionAdoptionMapping::capture(
            &f.target_profile,
            &fake_project,
            entry,
            &[(snapshot.summaries()[0].id.clone(), String::new())],
            false
        )
        .is_err()
    );
    let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
    let map = mapping(&f, &project, entry, &snapshot, false);
    std::fs::rename(workspace.join("mapped"), workspace.join("old-mapped")).unwrap();
    std::fs::create_dir(workspace.join("mapped")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    assert!(
        f.target
            .prepare_adoption_with_instructions(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selected(entry),
                Some(project.clone()),
                vec![map.clone()]
            )
            .is_err()
    );
    assert!(f.target.read_adoption(&f.request, &id).unwrap().is_none());
    std::fs::remove_dir(workspace.join("mapped")).unwrap();
    std::fs::rename(workspace.join("old-mapped"), workspace.join("mapped")).unwrap();
    trust(&f.target_profile, &workspace, false);
    assert!(
        f.target
            .prepare_adoption_with_instructions(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selected(entry),
                Some(project),
                vec![map]
            )
            .is_err()
    );
    assert!(f.target.read_adoption(&f.request, &id).unwrap().is_none());
}

#[test]
fn sealed_mapping_is_rechecked_after_restart_and_cannot_follow_a_replaced_child() {
    let f = Fixture::new();
    let workspace = target(&f);
    let local = capture(&f, Kind::Codex);
    let (manifest, receipt, snapshot) = transfer(&f, local);
    let entry = &manifest.entries[0].id;
    let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
    let map = mapping(&f, &project, entry, &snapshot, false);
    let id = uuid::Uuid::new_v4().to_string();
    let (_, owner) = f
        .target
        .prepare_adoption_with_instructions(
            &f.request,
            &id,
            &receipt.manifest_sha256,
            selected(entry),
            Some(project),
            vec![map],
        )
        .unwrap();
    drop(owner);
    std::fs::rename(workspace.join("mapped"), workspace.join("original-mapped")).unwrap();
    std::fs::create_dir(workspace.join("mapped")).unwrap();
    let receiver = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let previous = receiver.read_adoption(&f.request, &id).unwrap().unwrap();
    let (_, owner) = receiver
        .resume_adoption(&f.request, &id, previous.control.unwrap())
        .unwrap();
    let failed = receiver.execute_adoption(owner, |_| true).unwrap();
    assert_eq!(failed.phase, ReceivedAdoptionPhase::Failed);
    assert_eq!(
        failed.error_code.as_deref(),
        Some("source_transfer_instruction_mapping_changed")
    );
    assert!(failed.jobs.iter().all(|job| !job.preview_ready));
    assert!(
        ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn incomplete_chain_is_explicit_pending_archival_and_cannot_be_enabled_by_batch_choices() {
    let f = Fixture::new();
    let workspace = target(&f);
    drop(capture(&f, Kind::Codex));
    std::fs::write(f.files.join("AGENTS.md"), [0xff, 0xfe, 0x00]).unwrap();
    let snapshot = std::sync::Arc::new(
        crate::instruction_sources::InstructionSourceGrant::capture(
            &f.source_profile,
            &f.files,
            &f.files,
            Kind::Codex,
        )
        .unwrap()
        .capture_static_sources(
            &crate::instruction_sources::InstructionSourcePolicy {
                include_descendants: true,
                ..Default::default()
            },
            true,
            |_| true,
        )
        .unwrap(),
    );
    assert!(!snapshot.complete_launch_chain());
    let (manifest, receipt, snapshot) = transfer(&f, snapshot);
    let entry = &manifest.entries[0].id;
    let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let old = f.target.prepare_adoption(
        &f.request,
        &id,
        &receipt.manifest_sha256,
        selected(entry),
        Some(project.clone()),
    );
    let Err(error) = old else {
        panic!("old adoption must not guess scoped mappings");
    };
    assert_eq!(
        error.to_string(),
        "source_transfer_scoped_instructions_update_required"
    );
    let unconfirmed = mapping(&f, &project, entry, &snapshot, false);
    assert!(
        f.target
            .prepare_adoption_with_instructions(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selected(entry),
                Some(project.clone()),
                vec![unconfirmed]
            )
            .is_err()
    );
    assert!(f.target.read_adoption(&f.request, &id).unwrap().is_none());
    let archive = mapping(&f, &project, entry, &snapshot, true);
    let (_, owner) = f
        .target
        .prepare_adoption_with_instructions(
            &f.request,
            &id,
            &receipt.manifest_sha256,
            selected(entry),
            Some(project),
            vec![archive],
        )
        .unwrap();
    std::fs::rename(&f.files, f._root.path().join("source-offline")).unwrap();
    let ready = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(ready.phase, ReceivedAdoptionPhase::PreviewReady);
    assert_eq!(ready.blocked_items, 2);
    let store = MigrationStore::open_existing(&f.target_profile).unwrap();
    let job = store.read(&ready.jobs[0].job_id).unwrap();
    let provider = ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = McpTarget::open(&f.target_profile).unwrap();
    let assets = AssetTarget::open(&f.target_profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        credentials: None,
        history: None,
    };
    let choices = job
        .inventory
        .items
        .iter()
        .map(|item| {
            BatchResolution::Asset(AssetResolution {
                agent_adaptation: None,
                item_id: item.preview.id.clone(),
                target_name: "Must stay pending".into(),
                enable_after_import: true,
                memory_scope: None,
            })
        })
        .collect::<Vec<_>>();
    assert!(
        store
            .prepare_batch(&job.job_id, job.sequence, &choices, &targets)
            .is_err()
    );
    for item in &job.inventory.items {
        assert!(
            !store
                .instruction_source_snapshot(&job.job_id, &item.preview.id)
                .unwrap()
                .unwrap()
                .is_empty()
        );
    }
    assert!(
        ImportedContextStore::open(&f.target_profile)
            .unwrap()
            .list()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn duplicate_unused_unknown_and_globally_oversized_mapping_sets_create_no_adoption() {
    let f = Fixture::new();
    let workspace = target(&f);
    let local = capture(&f, Kind::Codex);
    let (manifest, receipt, snapshot) = transfer(&f, local);
    let entry = &manifest.entries[0].id;
    let project = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
    let map = mapping(&f, &project, entry, &snapshot, false);
    let id = uuid::Uuid::new_v4().to_string();
    assert!(
        f.target
            .prepare_adoption_with_instructions(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selected(entry),
                Some(project.clone()),
                vec![map.clone(), map]
            )
            .is_err()
    );
    assert!(f.target.read_adoption(&f.request, &id).unwrap().is_none());
    for (mapped_entry, item) in [
        ("e0099-0000", snapshot.summaries()[0].id.clone()),
        (entry.as_str(), "instruction-unknown".into()),
    ] {
        let map = ReceivedInstructionAdoptionMapping::capture(
            &f.target_profile,
            &project,
            mapped_entry,
            &[(item, String::new())],
            false,
        )
        .unwrap();
        assert!(
            f.target
                .prepare_adoption_with_instructions(
                    &f.request,
                    &id,
                    &receipt.manifest_sha256,
                    selected(entry),
                    Some(project.clone()),
                    vec![map]
                )
                .is_err()
        );
        assert!(f.target.read_adoption(&f.request, &id).unwrap().is_none());
    }
    let rows = (0..65)
        .map(|n| (format!("instruction-{n:032x}"), String::new()))
        .collect::<Vec<_>>();
    let first = ReceivedInstructionAdoptionMapping::capture(
        &f.target_profile,
        &project,
        entry,
        &rows,
        false,
    )
    .unwrap();
    let second = ReceivedInstructionAdoptionMapping::capture(
        &f.target_profile,
        &project,
        "e0001-0000",
        &rows,
        false,
    )
    .unwrap();
    let result = f.target.prepare_adoption_with_instructions(
        &f.request,
        &id,
        &receipt.manifest_sha256,
        selected(entry),
        Some(project),
        vec![first, second],
    );
    let Err(error) = result else {
        panic!("the total mapping limit applies across source graphs");
    };
    assert_eq!(
        error.to_string(),
        "source_transfer_instruction_mapping_limit"
    );
    assert!(f.target.read_adoption(&f.request, &id).unwrap().is_none());
}
