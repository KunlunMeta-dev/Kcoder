use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    history_branches::HistoryBranchStore,
    history_continuation_jobs::{ContinuationJobs, ContinuationTarget},
    history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
    history_undo::HistoryUndoJobs,
};
use kcoder_state::{AppState, historical_undo::*};
use kcoder_types::{
    Message, external_history::*, historical_context::*, historical_continuation::*,
    historical_undo::*, migration::MigrationSourceKind,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
struct Fixture {
    _root: tempfile::TempDir,
    profile: PathBuf,
    workspace: PathBuf,
    archive_id: String,
    source_path: PathBuf,
    continuation: HistoricalContinuationJob,
    state: AppState,
}
fn make_fixture(sealed: bool) -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let workspace = root.path().join("workspace");
    let source = root.path().join("source");
    for dir in [&profile, &workspace, &source] {
        PrivateDirectory::open_or_create(dir).unwrap();
    }
    let session = "11111111-1111-4111-8111-111111111111";
    let name = format!("{session}.jsonl");
    let source_path = source.join(&name);
    let value = json!({"type":"user","uuid":"root","parentUuid":null,"sessionId":session,"version":"2.1.301","message":{"role":"user","content":"archived facts"}});
    fs::write(
        &source_path,
        format!("{}\n", serde_json::to_string(&value).unwrap()),
    )
    .unwrap();
    let source_binding = HistorySourceBinding::capture(
        &source,
        std::path::Path::new(&name),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "fixture".into(),
            source_session_id: session.into(),
            source_artifact_id: None,
            source_format: "jsonl".into(),
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
    .unwrap();
    let archives = HistoryJobStore::open(&profile).unwrap();
    let archive_id = uuid::Uuid::new_v4().to_string();
    let mut archived = archives.create(&archive_id, &source_binding).unwrap();
    while archived.stage != HistoryImportStage::Normalized {
        archived = archives
            .step(&archive_id, archived.sequence, 10, |_| true)
            .unwrap();
        assert!(!matches!(
            archived.stage,
            HistoryImportStage::Failed | HistoryImportStage::Cancelled
        ));
    }
    let branches = HistoryBranchStore::open(&profile).unwrap();
    let view = branches.prepare(&archive_id, &[]).unwrap().view_id;
    branches.build(&archive_id, &view, || true).unwrap();
    let continuations = ContinuationJobs::open(&profile, &workspace).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    continuations
        .create(
            &id,
            &archive_id,
            &view,
            Default::default(),
            HistoricalContinuationOptions {
                model: None,
                settings_template: None,
                studio_work_mode: kcoder_types::StudioWorkMode::Kworker,
                local_attachments: Vec::new(),
            },
        )
        .unwrap();
    let history = profile.join("history");
    let artifacts = profile.join("artifacts");
    PrivateDirectory::open_or_create(&history).unwrap();
    PrivateDirectory::open_or_create(&artifacts).unwrap();
    let state = AppState::new(&workspace);
    state.set_short_id_registry(&profile.join("ids"));
    state.start_new_session().unwrap();
    state.with_history_path(history.join(format!("{}.jsonl", state.session_id())));
    let owned = PrivateDirectory::open_or_create(&artifacts.join(state.session_id())).unwrap();
    owned
        .atomic_replace(std::ffi::OsStr::new("attachment.txt"), b"keep artifact")
        .unwrap();
    let message = Message::runtime_text("private imported facts");
    let binding = HistoricalSessionSeedBinding {
        operation_id: id.clone(),
        session_id: state.session_id(),
        source_job_id: archive_id.clone(),
        view_id: view,
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&message).unwrap())
        ),
        preparation: PreparedContextReceipt {
            preparation_id: id.clone(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    };
    let mut run = continuations.begin(&id, 0, false).unwrap();
    run.reserve_target(ContinuationTarget {
        settings_template: None,
        session_id: state.session_id(),
        history_directory: history.clone(),
        history_identity: PrivateDirectory::open_existing(&history)
            .unwrap()
            .directory_identity()
            .unwrap(),
        artifact_directory: artifacts.clone(),
        artifact_identity: PrivateDirectory::open_existing(&artifacts)
            .unwrap()
            .directory_identity()
            .unwrap(),
    })
    .unwrap();
    run.admission(
        HistoricalModelProjectionReport {
            projection_ready: true,
            estimated_input_tokens: Some(10),
            input_limit_tokens: Some(1000),
            images: 0,
            files: 0,
            issues: vec![],
        },
        Some(binding.clone()),
    )
    .unwrap();
    let lease = HistoricalUndoLease::try_acquire(
        &state.history_path().unwrap(),
        &artifacts,
        &state.session_id(),
    )
    .unwrap();
    let receipt = state
        .publish_historical_seed(binding.clone(), message)
        .unwrap();
    let seal = sealed.then(|| seal_historical_session(&lease, &binding, |_| true).unwrap());
    run.imported_with_undo(receipt, seal).unwrap();
    let continuation = run.view().clone();
    drop(run);
    drop(lease);
    Fixture {
        _root: root,
        profile,
        workspace,
        archive_id,
        source_path,
        continuation,
        state,
    }
}
fn created(fixture: &Fixture, store: &HistoryUndoJobs) -> HistoricalUndoJob {
    store
        .create(
            &uuid::Uuid::new_v4().to_string(),
            &fixture.continuation.job_id,
            fixture.continuation.sequence,
        )
        .unwrap()
}

#[test]
fn published_undo_is_stable_private_and_keeps_shared_archives_and_original_imported_fact() {
    let fixture = make_fixture(true);
    assert!(!fixture.profile.join("migrations/history-undo").exists());
    assert!(
        HistoryUndoJobs::existing_at(
            &fixture.profile,
            &fixture.workspace,
            &fixture.continuation.job_id
        )
        .unwrap()
        .is_none()
    );
    assert!(
        HistoryUndoJobs::preview_at(
            &fixture.profile,
            &fixture.workspace,
            &fixture.continuation.job_id,
            || true
        )
        .unwrap()
        .can_undo
    );
    assert!(!fixture.profile.join("migrations/history-undo").exists());
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    {
        let _active = HistoricalUndoLease::try_acquire_existing(
            &fixture.state.history_path().unwrap(),
            &fixture.profile.join("artifacts"),
            &fixture.state.session_id(),
        )
        .unwrap();
        assert!(
            HistoryUndoJobs::existing_at(
                &fixture.profile,
                &fixture.workspace,
                &fixture.continuation.job_id
            )
            .unwrap()
                == Some(job.clone())
        );
        assert!(
            !store
                .preview(&fixture.continuation.job_id)
                .unwrap()
                .can_undo
        );
    }
    assert!(
        store
            .preview(&fixture.continuation.job_id)
            .unwrap()
            .existing_job
            == Some(job.clone())
    );
    assert!(
        store
            .create(
                &job.job_id,
                &fixture.continuation.job_id,
                fixture.continuation.sequence
            )
            .unwrap()
            == job
    );
    assert!(
        store
            .create(
                &job.job_id,
                &fixture.continuation.job_id,
                fixture.continuation.sequence + 1
            )
            .is_err()
    );
    let encoded = serde_json::to_string(&job).unwrap();
    assert!(!encoded.contains(fixture.profile.to_str().unwrap()));
    assert!(!encoded.contains("sealSha256"));
    assert!(!encoded.contains("private imported facts"));
    fs::remove_file(&fixture.source_path).unwrap();
    let result = store.run(&job.job_id, job.sequence).unwrap();
    assert!(result.stage == HistoricalUndoStage::Undone);
    assert!(
        HistoryUndoJobs::existing_at(
            &fixture.profile,
            &fixture.workspace,
            &fixture.continuation.job_id
        )
        .unwrap()
            == Some(result.clone())
    );
    assert!(!fixture.state.history_path().unwrap().exists());
    assert!(
        fixture
            .profile
            .join("artifacts")
            .join(fixture.state.session_id())
            .join("attachment.txt")
            .exists()
    );
    let source = HistoryJobStore::open(&fixture.profile)
        .unwrap()
        .read(&fixture.archive_id)
        .unwrap();
    assert_eq!(source.stage, HistoryImportStage::Normalized);
    assert_eq!(
        ContinuationJobs::open(&fixture.profile, &fixture.workspace)
            .unwrap()
            .read(&fixture.continuation.job_id)
            .unwrap()
            .stage,
        HistoricalContinuationStage::Imported
    );
    let reopened = HistoryUndoJobs::open_existing(&fixture.profile, &fixture.workspace)
        .unwrap()
        .unwrap();
    assert!(reopened.read(&job.job_id).unwrap() == result);
    assert!(
        reopened.run(&job.job_id, result.sequence).unwrap().stage == HistoricalUndoStage::Undone
    );
    let peer = fixture._root.path().join("other-workspace");
    PrivateDirectory::open_or_create(&peer).unwrap();
    assert!(
        HistoryUndoJobs::open(&fixture.profile, &peer)
            .unwrap()
            .read(&job.job_id)
            .is_err()
    );
}

#[test]
fn source_association_and_request_aliases_never_create_a_second_native_operation() {
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    let alias = uuid::Uuid::new_v4().to_string();
    let reused = store
        .create(
            &alias,
            &fixture.continuation.job_id,
            fixture.continuation.sequence,
        )
        .unwrap();
    assert!(reused == job);
    assert!(
        store
            .create(
                &alias,
                &uuid::Uuid::new_v4().to_string(),
                fixture.continuation.sequence
            )
            .is_err()
    );
    assert!(
        !fixture
            .profile
            .join("migrations/history-undo")
            .join(format!("{alias}.json"))
            .exists()
    );
    let result = store.run(&reused.job_id, reused.sequence).unwrap();
    assert!(result.stage == HistoricalUndoStage::Undone);
    assert!(
        store
            .preview(&fixture.continuation.job_id)
            .unwrap()
            .existing_job
            == Some(result)
    );
}

#[test]
fn link_before_job_crash_is_observed_without_writes_and_create_restores_only_original_id() {
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    let directory = fixture.profile.join("migrations/history-undo");
    let journal = directory.join(format!("{}.json", job.job_id));
    fs::remove_file(&journal).unwrap();
    let before = fs::read_dir(&directory).unwrap().count();
    let preview = store.preview(&fixture.continuation.job_id).unwrap();
    assert!(!preview.can_undo);
    assert!(preview.existing_job.is_none());
    assert_eq!(
        preview.reason_code.as_deref(),
        Some("historical_undo_job_recovery_required")
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), before);
    assert!(!journal.exists());
    assert!(
        HistoryUndoJobs::existing_at(
            &fixture.profile,
            &fixture.workspace,
            &fixture.continuation.job_id
        )
        .is_err()
    );
    assert!(fixture.state.history_path().unwrap().exists());
    let recovered = store
        .create(
            &uuid::Uuid::new_v4().to_string(),
            &fixture.continuation.job_id,
            fixture.continuation.sequence,
        )
        .unwrap();
    assert_eq!(recovered.job_id, job.job_id);
    assert!(recovered.stage == HistoricalUndoStage::OutcomeUnknown);
    assert!(recovered.sequence > job.sequence);
    assert!(
        store
            .run(&recovered.job_id, recovered.sequence)
            .unwrap()
            .stage
            == HistoricalUndoStage::Undone
    );
}

#[test]
fn job_before_link_crash_and_lost_journal_after_retirement_recover_the_same_operation_and_sequence()
{
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    let directory = fixture.profile.join("migrations/history-undo");
    let link = directory.join(format!("{}.source.json", fixture.continuation.job_id));
    fs::remove_file(&link).unwrap();
    let preview = store.preview(&fixture.continuation.job_id).unwrap();
    assert!(preview.existing_job == Some(job.clone()));
    assert!(!link.exists());
    let recovered = store
        .create(
            &uuid::Uuid::new_v4().to_string(),
            &fixture.continuation.job_id,
            fixture.continuation.sequence,
        )
        .unwrap();
    assert_eq!(recovered.job_id, job.job_id);
    assert!(link.exists());
    let done = store.run(&recovered.job_id, recovered.sequence).unwrap();
    assert!(done.stage == HistoricalUndoStage::Undone);
    fs::remove_file(directory.join(format!("{}.json", job.job_id))).unwrap();
    fs::remove_file(&link).unwrap();
    let restored = store
        .create(
            &uuid::Uuid::new_v4().to_string(),
            &fixture.continuation.job_id,
            fixture.continuation.sequence,
        )
        .unwrap();
    assert_eq!(restored.job_id, job.job_id);
    assert!(restored.stage == HistoricalUndoStage::OutcomeUnknown);
    assert!(restored.sequence > done.sequence);
    assert!(
        store
            .run_with_cancel(&restored.job_id, restored.sequence, || false)
            .unwrap()
            .stage
            == HistoricalUndoStage::Undone
    );
}

#[test]
fn legacy_unsealed_and_later_user_edits_never_become_owned_baselines() {
    let old = make_fixture(false);
    let old_store = HistoryUndoJobs::open(&old.profile, &old.workspace).unwrap();
    let preview = old_store.preview(&old.continuation.job_id).unwrap();
    assert!(!preview.can_undo);
    assert_eq!(
        preview.reason_code.as_deref(),
        Some("historical_undo_unsupported_unsealed")
    );
    assert!(
        old_store
            .create(
                &uuid::Uuid::new_v4().to_string(),
                &old.continuation.job_id,
                old.continuation.sequence
            )
            .is_err()
    );
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    fixture.state.set_goal("later user goal", None);
    let result = store.run(&job.job_id, job.sequence).unwrap();
    assert!(result.stage == HistoricalUndoStage::Conflict);
    assert!(fixture.state.history_path().unwrap().exists());
    assert!(
        !store
            .preview(&fixture.continuation.job_id)
            .unwrap()
            .can_undo
    );
}

#[test]
fn owner_cancellation_is_observable_and_explicit_rerun_uses_revision_fences() {
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    let cancelled = store.cancel(&job.job_id).unwrap();
    assert!(cancelled.stage == HistoricalUndoStage::Cancelled);
    assert!(cancelled.cancel_requested);
    assert_eq!(cancelled.cancel_revision, 1);
    assert!(store.run(&job.job_id, job.sequence).is_err());
    let result = store
        .run_with_cancel(&job.job_id, cancelled.sequence, || false)
        .unwrap();
    assert!(result.stage == HistoricalUndoStage::Cancelled);
    assert!(fixture.state.history_path().unwrap().exists());
    let complete = store.run(&job.job_id, result.sequence).unwrap();
    assert!(complete.stage == HistoricalUndoStage::Undone);
    assert!(!store.cancel(&job.job_id).unwrap().cancel_requested);
}

#[test]
fn cancellation_of_a_live_runner_does_not_touch_peer_or_publish_cancelled_early() {
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let observer = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    let mut cancelled = false;
    let result = store
        .run_with_cancel(&job.job_id, job.sequence, || {
            assert!(observer.running(&job.job_id).unwrap());
            assert!(observer.run(&job.job_id, 0).is_err());
            if !cancelled {
                let requested = observer.cancel(&job.job_id).unwrap();
                assert!(requested.stage == HistoricalUndoStage::Checking);
                assert!(requested.cancel_requested);
                cancelled = true;
            }
            true
        })
        .unwrap();
    assert!(result.stage == HistoricalUndoStage::Cancelled);
    assert!(result.cancel_requested);
    assert!(fixture.state.history_path().unwrap().exists());
    assert!(store.run(&job.job_id, result.sequence).unwrap().stage == HistoricalUndoStage::Undone);
}

#[test]
fn lost_job_checkpoint_and_native_receipt_reconcile_without_replaying_or_erasing_audit() {
    let fixture = make_fixture(true);
    let store = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let job = created(&fixture, &store);
    let job_path = fixture
        .profile
        .join("migrations/history-undo")
        .join(format!("{}.json", job.job_id));
    let result = store.run(&job.job_id, job.sequence).unwrap();
    assert!(result.stage == HistoricalUndoStage::Undone);
    let mut pending: serde_json::Value =
        serde_json::from_slice(&fs::read(&job_path).unwrap()).unwrap();
    pending["receipt"] = serde_json::Value::Null;
    pending["view"]["stage"] = json!("outcome_unknown");
    pending["view"]["failureCode"] = json!("historical_undo_unconfirmed");
    fs::write(&job_path, serde_json::to_vec(&pending).unwrap()).unwrap();
    let history = fixture.state.history_path().unwrap();
    let control = history.with_extension("hctl");
    fs::remove_file(control.join(format!("historical-undo-{}.receipt.json", job.job_id))).unwrap();
    let held = history.parent().unwrap().join(format!(
        ".{}.history-undo-{}.bin",
        fixture.state.session_id(),
        job.job_id
    ));
    fs::rename(&held, &history).unwrap();
    let cancelled = store.cancel(&job.job_id).unwrap();
    assert!(cancelled.stage == HistoricalUndoStage::OutcomeUnknown);
    assert!(cancelled.cancel_requested);
    assert!(store.read(&job.job_id).unwrap().stage == HistoricalUndoStage::OutcomeUnknown);
    assert!(history.exists());
    let recovered = store
        .run_with_cancel(&job.job_id, cancelled.sequence, || false)
        .unwrap();
    assert!(recovered.stage == HistoricalUndoStage::Undone);
    assert!(!history.exists());
    assert!(held.exists());
}

#[test]
fn continuation_and_native_source_pins_release_only_after_the_exact_actual_native_undo() {
    let fixture = make_fixture(true);
    let continuations = ContinuationJobs::open_existing(&fixture.profile, &fixture.workspace)
        .unwrap()
        .unwrap();
    let archives =
        kcoder_state::external_history::ExternalHistoryStore::open_existing(&fixture.profile)
            .unwrap()
            .unwrap();
    let history = HistoryJobStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let source = history
        .read(&fixture.archive_id)
        .unwrap()
        .archive_id
        .unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(&source)
            .unwrap()
            .durable_references,
        5
    );
    let operation = uuid::Uuid::new_v4().to_string();
    assert!(
        continuations
            .retire(&fixture.continuation.job_id, &operation, None)
            .is_err()
    );
    assert!(
        continuations
            .retire(
                &fixture.continuation.job_id,
                &operation,
                Some(&uuid::Uuid::new_v4().to_string())
            )
            .is_err()
    );
    assert_eq!(
        continuations.read(&fixture.continuation.job_id).unwrap(),
        fixture.continuation
    );
    let undo = HistoryUndoJobs::open(&fixture.profile, &fixture.workspace).unwrap();
    let planned = created(&fixture, &undo);
    let undone = undo.run(&planned.job_id, planned.sequence).unwrap();
    assert!(undone.stage == HistoricalUndoStage::Undone);
    let peer = HistoricalUndoLease::try_acquire_existing(
        &fixture.state.history_path().unwrap(),
        &fixture.profile.join("artifacts"),
        &fixture.state.session_id(),
    )
    .unwrap();
    assert!(
        continuations
            .retire(
                &fixture.continuation.job_id,
                &operation,
                Some(&undone.job_id)
            )
            .is_err()
    );
    drop(peer);
    continuations
        .retire(
            &fixture.continuation.job_id,
            &operation,
            Some(&undone.job_id),
        )
        .unwrap();
    continuations
        .retire(
            &fixture.continuation.job_id,
            &operation,
            Some(&undone.job_id),
        )
        .unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(&source)
            .unwrap()
            .durable_references,
        3
    );
    assert_eq!(
        continuations.read(&fixture.continuation.job_id).unwrap(),
        fixture.continuation
    );
    assert!(
        continuations
            .begin(
                &fixture.continuation.job_id,
                fixture.continuation.sequence,
                true
            )
            .is_err()
    );
    assert!(fixture.source_path.is_file());
}
