use super::*;
use crate::{asset_sources::AssetBundleBinding, batch::BatchSource, store::MigrationStore};
use kcoder_config::imported_context::ImportedContextScope;
use kcoder_types::migration::MigrationCategory;

fn received(
    f: &Fixture,
) -> (
    TransferManifest,
    TransferReceipt,
    Vec<ReceivedAdoptionSelection>,
) {
    let configuration = f.config(Kind::ClaudeCode);
    let history = f.history();
    let path = f.files.join("CLAUDE.md");
    std::fs::write(&path, "Owned received static instructions").unwrap();
    let asset = AssetBundleBinding::capture(
        &path,
        Kind::ClaudeCode,
        MigrationCategory::Instructions,
        ImportedContextScope::Global,
        false,
    )
    .unwrap();
    f.source
        .prepare(
            &f.request,
            &f.destination,
            vec![
                ExportSelection::Configuration(configuration),
                ExportSelection::Asset {
                    binding: asset,
                    key: "CLAUDE.md".into(),
                },
                ExportSelection::CapturedHistory(history),
            ],
        )
        .unwrap();
    let manifest = f
        .source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    let receipt = f.copy(&manifest);
    let selections = f
        .target
        .received_sources(&f.request, &receipt.manifest_sha256, 0)
        .unwrap()
        .items
        .into_iter()
        .map(|item| ReceivedAdoptionSelection {
            entry_id: item.entry_id,
            project_mapping: None,
        })
        .collect();
    (manifest, receipt, selections)
}

#[test]
fn three_received_classes_publish_one_fixed_native_preview_and_never_install_on_ready() {
    let f = Fixture::new();
    let (_, receipt, selections) = received(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let (initial, owner) = f
        .target
        .prepare_adoption(
            &f.request,
            &id,
            &receipt.manifest_sha256,
            selections.clone(),
            None,
        )
        .unwrap();
    assert_eq!(initial.phase, ReceivedAdoptionPhase::Prepared);
    assert_eq!(initial.worker_state, ReceivedAdoptionWorkerState::Running);
    let (same, no_owner) = f
        .target
        .prepare_adoption(
            &f.request,
            &id,
            &receipt.manifest_sha256,
            selections.clone(),
            None,
        )
        .unwrap();
    assert!(no_owner.is_none());
    assert_eq!(same.jobs, initial.jobs);
    assert_eq!(same.worker_state, ReceivedAdoptionWorkerState::Running);
    std::fs::remove_dir_all(&f.files).unwrap();
    let ready = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(
        ready.phase,
        ReceivedAdoptionPhase::PreviewReady,
        "{ready:?}"
    );
    assert_eq!(ready.worker_state, ReceivedAdoptionWorkerState::Stopped);
    assert_eq!(ready.total_sources, 3);
    assert_eq!(ready.completed_sources, 3);
    assert_eq!(ready.jobs.len(), 1);
    assert!(ready.jobs[0].preview_ready);
    let store = MigrationStore::open_existing(&f.target_profile).unwrap();
    let job = store.read(&ready.jobs[0].job_id).unwrap();
    assert_eq!(job.batch.as_ref().unwrap().sources.len(), 3);
    assert!(
        job.batch
            .as_ref()
            .unwrap()
            .sources
            .iter()
            .any(|source| matches!(source, BatchSource::History(_)))
    );
    assert!(!f.target_profile.join("settings.json").exists());
    assert!(!f.target_profile.join("skills").exists());
    let choices = job
        .inventory
        .items
        .iter()
        .filter(|item| item.asset.is_some())
        .filter_map(|item| crate::batch::default_resolution(&job, item))
        .collect::<Vec<_>>();
    let provider = crate::providers::ProviderTarget::open(&f.target_profile).unwrap();
    let mcp = crate::mcp::McpTarget::open(&f.target_profile).unwrap();
    let assets = crate::assets::AssetTarget::open(&f.target_profile).unwrap();
    let selected = store
        .prepare_batch(
            &job.job_id,
            job.sequence,
            &choices,
            &crate::store::BatchTargets {
                provider: &provider,
                mcp: &mcp,
                assets: &assets,
                history: None,
                credentials: None,
            },
        )
        .unwrap();
    let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    assert_eq!(
        reopened
            .read_adoption(&f.request, &id)
            .unwrap()
            .unwrap()
            .jobs,
        ready.jobs
    );
    assert_eq!(store.read(&job.job_id).unwrap().sequence, selected.sequence);
    assert!(
        reopened
            .prepare_adoption(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selections[..1].to_vec(),
                None
            )
            .is_err()
    );
}

#[test]
fn cancellation_during_received_hash_keeps_running_fact_then_resumes_the_same_fixed_preview() {
    let f = Fixture::new();
    let (_, receipt, selections) = received(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let (initial, owner) = f
        .target
        .prepare_adoption(&f.request, &id, &receipt.manifest_sha256, selections, None)
        .unwrap();
    let original_control = initial.control.unwrap();
    let command = uuid::Uuid::new_v4().to_string();
    let mut cancelled = None;
    let stopped = f
        .target
        .execute_adoption(owner.unwrap(), |bytes| {
            if bytes >= 64 * 1024 && cancelled.is_none() {
                let state = f.target.cancel_adoption(&f.request, &id, &command).unwrap();
                assert_eq!(state.phase, ReceivedAdoptionPhase::CancelRequested);
                assert_eq!(state.worker_state, ReceivedAdoptionWorkerState::Running);
                cancelled = state.control;
            }
            true
        })
        .unwrap();
    let watermark = cancelled.expect("the fixture must cancel while hashing the history");
    assert_eq!(stopped.phase, ReceivedAdoptionPhase::Cancelled);
    assert_eq!(stopped.worker_state, ReceivedAdoptionWorkerState::Stopped);
    assert!(
        f.target
            .resume_adoption(&f.request, &id, original_control)
            .is_err()
    );
    let (_, owner) = f
        .target
        .resume_adoption(&f.request, &id, watermark)
        .unwrap();
    let before = f.target.read_adoption(&f.request, &id).unwrap().unwrap();
    let delayed_old = f.target.cancel_adoption(&f.request, &id, &command).unwrap();
    assert_eq!(delayed_old.control, before.control);
    assert_eq!(delayed_old.cancel_requested, Some(false));
    let ready = f.target.execute_adoption(owner, |_| true).unwrap();
    assert_eq!(
        ready.phase,
        ReceivedAdoptionPhase::PreviewReady,
        "{ready:?}"
    );
    assert_eq!(ready.jobs[0].job_id, initial.jobs[0].job_id);
    assert_eq!(ready.completed_sources, 3);
    assert!(
        !f.target
            .state(&f.request, f.source.authority())
            .unwrap()
            .cancelled
    );
}

#[test]
fn a_missing_born_adoption_or_lock_is_unknown_and_is_not_recreated_by_prepare_or_resume() {
    for missing_lock in [false, true] {
        let f = Fixture::new();
        let (_, receipt, selections) = received(&f);
        let id = uuid::Uuid::new_v4().to_string();
        let (initial, owner) = f
            .target
            .prepare_adoption(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                selections.clone(),
                None,
            )
            .unwrap();
        drop(owner);
        let original = f
            .target_profile
            .join("migrations/source-transfer/incoming")
            .join(format!("adoption-{}-{id}", f.request));
        let removed = if missing_lock {
            original.join("writer.lock")
        } else {
            original.clone()
        };
        std::fs::rename(&removed, f._root.path().join("withheld-owned-state")).unwrap();
        let unknown = f.target.read_adoption(&f.request, &id).unwrap().unwrap();
        assert_eq!(unknown.phase, ReceivedAdoptionPhase::Unknown);
        assert_eq!(unknown.worker_state, ReceivedAdoptionWorkerState::Unknown);
        assert!(unknown.control.is_none());
        assert!(
            f.target
                .prepare_adoption(&f.request, &id, &receipt.manifest_sha256, selections, None)
                .is_err()
        );
        assert!(
            f.target
                .resume_adoption(&f.request, &id, initial.control.unwrap())
                .is_err()
        );
        assert!(!removed.exists());
    }
}

#[test]
fn a_lost_preview_publication_acknowledgement_reconciles_the_original_inode_without_another_scan() {
    let f = Fixture::new();
    let (_, receipt, selections) = received(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let (initial, owner) = f
        .target
        .prepare_adoption(&f.request, &id, &receipt.manifest_sha256, selections, None)
        .unwrap();
    crate::source_transfer::target::FAIL_AFTER_PREVIEW_PUBLICATION.with(|flag| flag.set(true));
    let interrupted = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    assert_eq!(interrupted.phase, ReceivedAdoptionPhase::Failed);
    assert!(interrupted.jobs[0].preview_ready);
    let migrations = PrivateDirectory::open_existing(&f.target_profile)
        .unwrap()
        .open_child(OsStr::new("migrations"), false)
        .unwrap();
    let leaf = format!("{}.json", initial.jobs[0].job_id);
    let physical = migrations
        .portable_regular_identity(OsStr::new(&leaf))
        .unwrap();
    let before = std::fs::read(f.target_profile.join("migrations").join(&leaf)).unwrap();
    let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let (_, lease) = reopened
        .resume_adoption(&f.request, &id, interrupted.control.unwrap())
        .unwrap();
    let complete = reopened.execute_adoption(lease, |_| true).unwrap();
    assert_eq!(complete.phase, ReceivedAdoptionPhase::PreviewReady);
    assert_eq!(complete.completed_sources, 3);
    assert_eq!(complete.jobs[0].job_id, initial.jobs[0].job_id);
    assert_eq!(
        migrations
            .portable_regular_identity(OsStr::new(&leaf))
            .unwrap(),
        physical
    );
    assert_eq!(
        std::fs::read(f.target_profile.join("migrations").join(&leaf)).unwrap(),
        before
    );
}

#[test]
fn an_unconfirmed_preview_replaced_with_equal_bytes_is_unknown_and_never_regenerated() {
    let f = Fixture::new();
    let (_, receipt, selections) = received(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let (initial, owner) = f
        .target
        .prepare_adoption(
            &f.request,
            &id,
            &receipt.manifest_sha256,
            selections.clone(),
            None,
        )
        .unwrap();
    crate::source_transfer::target::FAIL_AFTER_PREVIEW_PUBLICATION.with(|flag| flag.set(true));
    let interrupted = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
    let path = f
        .target_profile
        .join("migrations")
        .join(format!("{}.json", initial.jobs[0].job_id));
    let before = std::fs::read(&path).unwrap();
    std::fs::rename(&path, f._root.path().join("withheld-original-preview")).unwrap();
    PrivateDirectory::open_existing(&f.target_profile.join("migrations"))
        .unwrap()
        .atomic_replace(path.file_name().unwrap(), &before)
        .unwrap();
    let unknown = f.target.read_adoption(&f.request, &id).unwrap().unwrap();
    assert_eq!(unknown.phase, ReceivedAdoptionPhase::Unknown);
    assert_eq!(unknown.worker_state, ReceivedAdoptionWorkerState::Unknown);
    assert!(unknown.control.is_none());
    assert!(
        f.target
            .resume_adoption(&f.request, &id, interrupted.control.unwrap())
            .is_err()
    );
    assert!(
        f.target
            .prepare_adoption(&f.request, &id, &receipt.manifest_sha256, selections, None)
            .is_err()
    );
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn a_short_worker_finishing_between_checkpoint_and_lease_observation_returns_the_final_preview() {
    let f = Fixture::new();
    let (_, receipt, selections) = received(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let (_, owner) = f
        .target
        .prepare_adoption(&f.request, &id, &receipt.manifest_sha256, selections, None)
        .unwrap();
    let profile = f.target_profile.clone();
    crate::source_transfer::target::AFTER_ADOPTION_CHECKPOINT_READ.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            let worker = IncomingTransfers::open_existing(&profile).unwrap();
            assert_eq!(
                worker
                    .execute_adoption(owner.unwrap(), |_| true)
                    .unwrap()
                    .phase,
                ReceivedAdoptionPhase::PreviewReady
            );
        }))
    });
    let actual = f.target.read_adoption(&f.request, &id).unwrap().unwrap();
    assert_eq!(actual.phase, ReceivedAdoptionPhase::PreviewReady);
    assert_eq!(actual.worker_state, ReceivedAdoptionWorkerState::Stopped);
    assert_eq!(actual.completed_sources, 3);
}

#[test]
fn received_effective_project_configuration_requires_an_actual_destination_mapping_and_blocks_project_templates()
 {
    for source_kind in [Kind::ClaudeCode, Kind::Codex] {
        let f = Fixture::new();
        let user = f.files.join("user");
        let project = f.files.join("project");
        PrivateDirectory::open_or_create(&user).unwrap();
        let source = match source_kind {
            Kind::ClaudeCode => {
                PrivateDirectory::open_or_create(&project.join(".claude")).unwrap();
                std::fs::write(user.join("settings.json"), r#"{"model":"user-model","env":{"ANTHROPIC_BASE_URL":"https://fixture.invalid/v1"}}"#).unwrap();
                std::fs::write(
                    project.join(".claude/settings.json"),
                    r#"{"model":"project-model"}"#,
                )
                .unwrap();
                ConfigurationBinding::capture_claude_layers(&user, &project)
                    .unwrap()
                    .unwrap()
            }
            Kind::Codex => {
                PrivateDirectory::open_or_create(&project.join(".git")).unwrap();
                PrivateDirectory::open_or_create(&project.join(".codex")).unwrap();
                std::fs::write(
                    user.join("config.toml"),
                    include_str!("../../../fixtures/codex-layers/user/config.toml"),
                )
                .unwrap();
                std::fs::write(
                    project.join(".codex/config.toml"),
                    "model='project-model'\n",
                )
                .unwrap();
                ConfigurationBinding::capture_codex_layers(&user, &project, &project, None).unwrap()
            }
        };
        let original_template_count = source
            .inventory()
            .unwrap()
            .items
            .iter()
            .filter(|item| item.template.is_some())
            .count();
        if source_kind == Kind::Codex {
            assert!(original_template_count > 0);
        }
        let manifest = f.export(ExportSelection::Configuration(source));
        let receipt = f.copy(&manifest);
        let expected_scope = if source_kind == Kind::Codex {
            "codex-project-layers"
        } else {
            "project-effective"
        };
        assert!(
            matches!(&manifest.entries[0].content, TransferContent::ConfigurationInventory { source_scope, .. } if source_scope == expected_scope)
        );
        assert!(
            f.target
                .received_sources(&f.request, &receipt.manifest_sha256, 0)
                .unwrap()
                .items[0]
                .project_scoped
        );
        let id = uuid::Uuid::new_v4().to_string();
        let selection = ReceivedAdoptionSelection {
            entry_id: manifest.entries[0].id.clone(),
            project_mapping: Some(ReceivedProjectMapping::CurrentWorkspace),
        };
        assert!(
            f.target
                .prepare_adoption(
                    &f.request,
                    &id,
                    &receipt.manifest_sha256,
                    vec![selection.clone()],
                    None
                )
                .is_err()
        );
        let workspace = f._root.path().join("explicit-destination");
        PrivateDirectory::open_or_create(&workspace).unwrap();
        let target = ReceivedProjectTarget::capture(&f.target_profile, &workspace).unwrap();
        let (_, owner) = f
            .target
            .prepare_adoption(
                &f.request,
                &id,
                &receipt.manifest_sha256,
                vec![selection],
                Some(target.clone()),
            )
            .unwrap();
        std::fs::remove_dir_all(&f.files).unwrap();
        let state = f.target.execute_adoption(owner.unwrap(), |_| true).unwrap();
        assert_eq!(
            state.phase,
            ReceivedAdoptionPhase::PreviewReady,
            "{state:?}"
        );
        assert_eq!(
            state.jobs[0].target_scope,
            ReceivedAdoptionScope::CurrentWorkspace
        );
        let job = MigrationStore::open_existing(&f.target_profile)
            .unwrap()
            .read(&state.jobs[0].job_id)
            .unwrap();
        assert_eq!(
            job.batch
                .as_ref()
                .unwrap()
                .received
                .as_ref()
                .unwrap()
                .project
                .as_ref(),
            Some(&target)
        );
        let templates = job
            .inventory
            .items
            .iter()
            .filter(|item| item.template.is_some())
            .collect::<Vec<_>>();
        assert_eq!(templates.len(), original_template_count);
        assert!(templates.iter().all(|item| {
            item.preview.issues.iter().any(|issue| {
                issue.blocks_import()
                    && issue.field.as_deref() == Some("project_template_unsupported")
            })
        }));
        assert_eq!(
            state.blocked_items,
            job.inventory
                .items
                .iter()
                .filter(|item| item
                    .preview
                    .issues
                    .iter()
                    .any(|issue| issue.blocks_import()))
                .count() as u32
        );
        assert!(!f.target_profile.join("settings.json").exists());
        assert!(!workspace.join(".kcoder/settings.json").exists());
    }
}
