use kcoder_migration::{history_jobs::HistoryJobStore, history_sources::HistorySourceBinding};
use kcoder_state::external_history::{ExternalHistoryStore, lifecycle::ArchiveRetirementPhase};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};
fn binding(root: &Path) -> HistorySourceBinding {
    let bytes=b"{\"type\":\"user\",\"uuid\":\"first\",\"sessionId\":\"synthetic\",\"message\":{\"role\":\"user\",\"content\":\"owned fact\"}}\n";
    fs::write(root.join("source.jsonl"), bytes).unwrap();
    HistorySourceBinding::capture(
        root,
        Path::new("source.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-grant".into(),
            source_session_id: "synthetic".into(),
            source_artifact_id: None,
            source_format: "jsonl/fixture".into(),
            adapter_revision: "fixture/1".into(),
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

#[cfg(target_os = "linux")]
#[test]
fn owned_job_retirement_keeps_import_facts_and_blocks_new_readers_runs_and_source_reinterpretation()
{
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path());
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let created = store.create(&id, &binding).unwrap();
    assert_ne!(
        created.archive_id,
        Some(ExternalHistoryStore::archive_id_for_snapshot(binding.snapshot()).unwrap())
    );
    let archived = store.step(&id, created.sequence, 10, |_| true).unwrap();
    assert!(archived.archived);
    let op = uuid::Uuid::new_v4().to_string();
    let prepared = store
        .prepare_retirement(&op, &id, archived.sequence)
        .unwrap();
    fs::remove_file(source.path().join("source.jsonl")).unwrap();
    let reader = store.archive_reader(&id).unwrap();
    let paused = store
        .run_retirement(&op, prepared.sequence, || true)
        .unwrap();
    assert_eq!(
        paused.failure_code.as_deref(),
        Some("external_history_retirement_readers_busy")
    );
    assert!(!paused.logical_retired);
    assert!(store.archive_reader(&id).is_ok());
    assert_eq!(store.read(&id).unwrap(), archived);
    drop(reader);
    let collected = store.run_retirement(&op, paused.sequence, || true).unwrap();
    assert!(matches!(collected.phase, ArchiveRetirementPhase::Collected));
    assert!(store.archive_reader(&id).is_err());
    assert!(
        store
            .step(&id, archived.sequence, 10, |_| panic!(
                "retired job cannot execute"
            ))
            .is_err()
    );
    let reinterpretation = store.reinterpretation_preview(&id).unwrap();
    assert!(!reinterpretation.can_create);
    assert_eq!(
        reinterpretation.reason_code.as_deref(),
        Some("history_job_retired")
    );
    drop(store);
    let store = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(store.read(&id).unwrap(), archived);
    assert!(matches!(
        store.retirement_for_job(&id).unwrap().unwrap().phase,
        ArchiveRetirementPhase::Collected
    ));
    assert!(store.create(&id, &binding).unwrap().archived);
    assert!(!profile.path().join("sessions").exists());
}

#[test]
fn actual_legacy_job_versions_keep_their_original_archive_identity_and_no_collection_authority() {
    for version in [1, 2] {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let binding = binding(source.path());
        let store = HistoryJobStore::open(profile.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let archives = ExternalHistoryStore::open_existing(profile.path())
            .unwrap()
            .unwrap();
        let legacy = binding.archive(&archives, &id, &mut |_| true).unwrap();
        let directory = kcoder_config::PrivateDirectory::open_existing(
            &profile.path().join("migrations/history"),
        )
        .unwrap();
        let owner = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(
                    directory.directory_identity().unwrap(),
                    archives.scope_fingerprint().unwrap()
                ))
                .unwrap()
            )
        );
        let view = HistoryImportJobView {
            job_id: id.clone(),
            sequence: 0,
            source: MigrationSourceKind::ClaudeCode,
            stage: HistoryImportStage::Planned,
            archive_id: Some(legacy.receipt.archive_id.clone()),
            archived: false,
            normalization: None,
            failure_code: None,
            cancel_requested: false,
        };
        // The synthetic unfinished v1/v2 writer had already created its short run
        // lock before publishing this journal. No execution birth is fabricated.
        drop(
            directory
                .try_exclusive_lock(std::ffi::OsStr::new(&format!("{id}.run.lock")))
                .unwrap()
                .unwrap(),
        );
        fs::write(profile.path().join("migrations/history").join(format!("{id}.json")),
            serde_json::to_vec(&serde_json::json!({"version":version,"owner":owner,
                "binding":binding,"bindingSha256":format!("{:x}",Sha256::digest(serde_json::to_vec(&binding).unwrap())),
                "normalizationRevision":kcoder_migration::history_normalization::HISTORY_NORMALIZATION_REVISION,
                "archiveStageCompleted":false,"view":view
            })).unwrap()).unwrap();
        fs::remove_file(source.path().join("source.jsonl")).unwrap();
        let observed = store.read(&id).unwrap();
        assert_eq!(observed.archive_id, view.archive_id);
        assert!(observed.archived);
        assert!(matches!(
            store.resource_budget(&id, None).unwrap(),
            kcoder_types::migration_resource::MigrationResourceBudgetView::LegacyUntracked { .. }
        ));
        assert!(archives.recorded_resource_budget(&id).unwrap().is_none());
        assert!(store.step(&id, 0, 10, |_| true).is_err());
        assert_eq!(
            store.execution_state(&id).unwrap(),
            kcoder_migration::history_jobs::HistoryExecutionState::Unknown
        );
        store.request_cancel(&id).unwrap();
        let mut current = store.resume(&id, 0).unwrap();
        while current.stage != HistoryImportStage::Normalized {
            current = store.step(&id, current.sequence, 10, |_| true).unwrap();
        }
        assert_eq!(current.archive_id, view.archive_id);
        let budget = archives.recorded_resource_budget(&id).unwrap().unwrap();
        let usage = archives.resource_budget_usage(&budget).unwrap();
        assert!(usage.committed_bytes > legacy.receipt.source_bytes);
        assert!(
            usage.committed_files >= 5,
            "raw and derived files share the upgraded budget"
        );
        assert!(
            !store
                .archive_reader(&id)
                .unwrap()
                .lifecycle_guard()
                .is_managed()
        );
        assert!(
            store
                .prepare_retirement(&uuid::Uuid::new_v4().to_string(), &id, current.sequence)
                .is_err()
        );
    }
}
