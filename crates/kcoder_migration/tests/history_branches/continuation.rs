use super::*;
use kcoder_migration::history_continuation_jobs::{ContinuationJobs, ContinuationTarget};
use kcoder_types::historical_continuation::*;
fn source(profile: &Path, root: &Path) -> (String, String) {
    let (job, _, _) = archive(
        profile,
        root,
        MigrationSourceKind::ClaudeCode,
        A,
        A,
        vec![message("root", None)],
    );
    let branches = HistoryBranchStore::open(profile).unwrap();
    let view = branches.prepare(&job, &[]).unwrap().view_id;
    branches.build(&job, &view, || true).unwrap();
    (job, view)
}
fn options() -> HistoricalContinuationOptions {
    HistoricalContinuationOptions {
        model: None,
        settings_template: None,
        studio_work_mode: kcoder_types::StudioWorkMode::Kworker,
        local_attachments: Vec::new(),
    }
}
fn create(store: &ContinuationJobs, source: &str, view: &str) -> HistoricalContinuationJob {
    store
        .create(
            &uuid::Uuid::new_v4().to_string(),
            source,
            view,
            Default::default(),
            options(),
        )
        .unwrap()
}
#[test]
fn jobs_are_stable_workspace_owned_private_and_do_not_create_native_threads() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (source, view) = source(profile.path(), root.path());
    assert!(
        ContinuationJobs::open_existing(profile.path(), workspace.path())
            .unwrap()
            .is_none()
    );
    let store = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
    let created = create(&store, &source, &view);
    assert_eq!(
        store
            .create(
                &created.job_id,
                &source,
                &view,
                Default::default(),
                options()
            )
            .unwrap(),
        created
    );
    let encoded = serde_json::to_string(&created).unwrap();
    assert!(!encoded.contains(profile.path().to_str().unwrap()));
    assert!(!encoded.contains("branch_identity"));
    assert!(created.thread_id.is_none());
    let other = tempfile::tempdir().unwrap();
    let peer = ContinuationJobs::open(profile.path(), other.path()).unwrap();
    assert!(peer.read(&created.job_id).is_err());
    drop(store);
    let reopened = ContinuationJobs::open_existing(profile.path(), workspace.path())
        .unwrap()
        .unwrap();
    assert_eq!(reopened.read(&created.job_id).unwrap(), created);
    let mut changed = options();
    changed.model = Some("different".into());
    assert!(
        reopened
            .create(&created.job_id, &source, &view, Default::default(), changed)
            .is_err()
    );
}
#[test]
fn only_one_runner_can_own_a_job_while_independent_observers_can_cancel() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (source, view) = source(profile.path(), root.path());
    let store = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
    let created = create(&store, &source, &view);
    let mut run = store.begin(&created.job_id, 0, false).unwrap();
    run.stage(HistoricalContinuationStage::Preparing).unwrap();
    let observer = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
    assert!(observer.running(&created.job_id).unwrap());
    assert!(
        observer
            .begin(&created.job_id, run.view().sequence, true)
            .is_err()
    );
    observer.cancel(&created.job_id).unwrap();
    assert!(run.cancelled().unwrap());
    run.stop(HistoricalContinuationStage::Cancelled, None)
        .unwrap();
    let stopped = run.view().sequence;
    drop(run);
    let mut resumed = observer.begin(&created.job_id, stopped, true).unwrap();
    assert!(!resumed.cancelled().unwrap());
    store.cancel(&created.job_id).unwrap();
    assert!(resumed.cancelled().unwrap());
    resumed
        .stop(HistoricalContinuationStage::Cancelled, None)
        .unwrap();
    drop(resumed);
    assert!(observer.begin(&created.job_id, stopped, true).is_err());
    assert!(observer.read(&created.job_id).unwrap().cancel_requested);
}
#[test]
fn interrupted_active_jobs_require_explicit_resume_and_keep_the_reserved_target() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (source, view) = source(profile.path(), root.path());
    let store = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
    let created = create(&store, &source, &view);
    let target = ContinuationTarget {
        settings_template: None,
        session_id: "Ab123".into(),
        history_directory: profile.path().into(),
        history_identity: "history".into(),
        artifact_directory: profile.path().into(),
        artifact_identity: "artifacts".into(),
    };
    let mut run = store.begin(&created.job_id, 0, false).unwrap();
    run.reserve_target(target.clone()).unwrap();
    run.stage(HistoricalContinuationStage::Admitting).unwrap();
    let sequence = run.view().sequence;
    drop(run);
    assert!(store.begin(&created.job_id, sequence, false).is_err());
    let mut resumed = store.begin(&created.job_id, sequence, true).unwrap();
    assert!(resumed.target() == Some(&target));
    let mut other = target.clone();
    other.session_id = "Other".into();
    assert!(resumed.reserve_target(other).is_err());
}
#[test]
fn cancellation_does_not_turn_an_uncertain_publication_into_an_unexecuted_action() {
    let profile = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let (source, view) = source(profile.path(), root.path());
    let store = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
    let created = create(&store, &source, &view);
    let mut run = store.begin(&created.job_id, 0, false).unwrap();
    run.stage(HistoricalContinuationStage::Publishing).unwrap();
    run.stop(
        HistoricalContinuationStage::PublishUnknown,
        Some("continuation_publication_unconfirmed"),
    )
    .unwrap();
    drop(run);
    let cancelled = store.cancel(&created.job_id).unwrap();
    assert_eq!(cancelled.stage, HistoricalContinuationStage::PublishUnknown);
    assert!(cancelled.cancel_requested);
}

#[test]
fn private_undo_proofs_remain_optional_and_never_change_known_publication_facts() {
    use kcoder_types::{historical_context::*, historical_undo::HistoricalUndoSealReceipt};
    for with_proof in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let (source, view) = source(profile.path(), root.path());
        let store = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
        let created = create(&store, &source, &view);
        let mut run = store.begin(&created.job_id, 0, false).unwrap();
        run.reserve_target(ContinuationTarget {
            settings_template: None,
            session_id: "Ab123".into(),
            history_directory: profile.path().into(),
            history_identity: "history".into(),
            artifact_directory: profile.path().into(),
            artifact_identity: "artifacts".into(),
        })
        .unwrap();
        let binding = HistoricalSessionSeedBinding {
            operation_id: created.job_id.clone(),
            session_id: "Ab123".into(),
            source_job_id: source,
            view_id: view,
            preparation: PreparedContextReceipt {
                preparation_id: created.job_id.clone(),
                document_sha256: "a".repeat(64),
                binding_sha256: "b".repeat(64),
                attachments: 0,
                attachment_bytes: 0,
            },
            model_snapshot_sha256: "c".repeat(64),
            projection_sha256: "d".repeat(64),
        };
        run.admission(
            HistoricalModelProjectionReport {
                projection_ready: true,
                estimated_input_tokens: Some(10),
                input_limit_tokens: Some(64000),
                images: 0,
                files: 0,
                issues: vec![],
            },
            Some(binding.clone()),
        )
        .unwrap();
        let receipt = HistoricalSessionSeedReceipt {
            binding: binding.clone(),
            history_uuid: uuid::Uuid::new_v4().to_string(),
            history_bytes: 100,
            history_sha256: "e".repeat(64),
        };
        let proof = HistoricalUndoSealReceipt {
            operation_id: created.job_id.clone(),
            session_id: "Ab123".into(),
            seal_sha256: "f".repeat(64),
        };
        let mut wrong = proof.clone();
        wrong.operation_id = uuid::Uuid::new_v4().to_string();
        assert!(
            run.imported_with_undo(receipt.clone(), Some(wrong))
                .is_err()
        );
        run.imported_with_undo(receipt, with_proof.then_some(proof.clone()))
            .unwrap();
        drop(run);
        drop(store);
        let reopened = ContinuationJobs::open_existing(profile.path(), workspace.path())
            .unwrap()
            .unwrap();
        let imported = reopened.read(&created.job_id).unwrap();
        assert_eq!(imported.stage, HistoricalContinuationStage::Imported);
        assert!(
            reopened.published_undo_seal(&created.job_id).unwrap() == with_proof.then_some(proof)
        );
        let public = serde_json::to_string(&imported).unwrap();
        assert!(!public.contains("seal") && !public.contains(&"f".repeat(64)));
        let journal = std::fs::read_to_string(
            profile
                .path()
                .join("migrations/history-continuations")
                .join(format!("{}.json", created.job_id)),
        )
        .unwrap();
        assert_eq!(journal.contains("undo_seal"), with_proof);
    }
}
