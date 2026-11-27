use kcoder_migration::{
    history_branches::HistoryBranchStore, history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
};
use kcoder_state::external_history::{
    ExternalHistoryStore,
    lifecycle::{ArchiveReferenceKind, ArchiveReferenceOwner, ArchiveRetirementPhase},
};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use std::{fs, path::Path};

fn binding(root: &Path) -> HistorySourceBinding {
    fs::write(
        root.join("source.jsonl"),
        serde_json::json!({"type":"user","uuid":"first",
        "sessionId":"synthetic","message":{"role":"user","content":"owned source fact"}})
        .to_string()
            + "\n",
    )
    .unwrap();
    HistorySourceBinding::capture(
        root,
        Path::new("source.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-source".into(),
            source_session_id: "synthetic".into(),
            source_artifact_id: None,
            source_format: "fixture/1".into(),
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
    .unwrap()
}
fn done(jobs: &HistoryJobStore, binding: &HistorySourceBinding) -> HistoryImportJobView {
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = jobs.create(&id, binding).unwrap();
    while job.stage != HistoryImportStage::Normalized {
        assert!(
            !matches!(
                job.stage,
                HistoryImportStage::Failed | HistoryImportStage::Cancelled
            ),
            "{:?}",
            job.failure_code
        );
        job = jobs.step(&id, job.sequence, 10, |_| true).unwrap();
    }
    job
}

#[test]
fn each_accepted_choice_pins_its_own_job_even_when_two_jobs_share_one_canonical_view() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let first = done(&jobs, &binding);
    let second = done(&jobs, &binding);
    assert_eq!(first.archive_id, second.archive_id);
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let created = branches.prepare(&first.job_id, &[]).unwrap();
    let view = created.view_id.clone();
    let ready = branches.build(&first.job_id, &view, || true).unwrap();
    assert_eq!(branches.prepare(&second.job_id, &[]).unwrap().view_id, view);
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let id = first.archive_id.as_deref().unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(id)
            .unwrap()
            .durable_references,
        5
    );
    let retirement = uuid::Uuid::new_v4().to_string();
    assert!(
        branches
            .retire_view(&first.job_id, &view, &retirement, ready.sequence)
            .is_err()
    );
    assert_eq!(branches.retire_choices(&first.job_id).unwrap(), 1);
    assert_eq!(branches.retire_choices(&first.job_id).unwrap(), 1);
    assert!(branches.last_choice(&first.job_id).unwrap().is_none());
    assert_eq!(
        branches
            .last_choice(&second.job_id)
            .unwrap()
            .unwrap()
            .view_id,
        view
    );
    assert!(
        branches
            .retire_view(&first.job_id, &view, &retirement, ready.sequence)
            .is_err()
    );
    assert_eq!(branches.retire_choices(&second.job_id).unwrap(), 1);
    let reader = archives.reader(id).unwrap();
    let dependent = archives
        .retain_archive_reference(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Preparation,
                "owned-preparation",
                &"a".repeat(64),
            )
            .unwrap(),
            &[reader.lifecycle_guard()],
        )
        .unwrap();
    drop(reader);
    assert!(
        branches
            .retire_view(&first.job_id, &view, &retirement, ready.sequence)
            .is_err()
    );
    archives.release_archive_reference(&dependent).unwrap();
    let idle = archives.branch(&view, false).unwrap();
    let links = idle.tool_links(true).unwrap().unwrap();
    drop(idle);
    assert!(
        branches
            .retire_view(&first.job_id, &view, &retirement, ready.sequence)
            .is_err()
    );
    drop(links);
    branches
        .retire_view(&first.job_id, &view, &retirement, ready.sequence)
        .unwrap();
    branches
        .retire_view(&first.job_id, &view, &retirement, ready.sequence)
        .unwrap();
    assert!(branches.progress(&first.job_id, &view).is_err());
    assert_eq!(
        archives
            .archive_lifecycle_observation(id)
            .unwrap()
            .durable_references,
        2
    );
    let alias = jobs
        .prepare_retirement(
            &uuid::Uuid::new_v4().to_string(),
            &second.job_id,
            second.sequence,
        )
        .unwrap();
    let alias = jobs
        .run_retirement(&alias.operation_id, alias.sequence, || true)
        .unwrap();
    assert!(matches!(alias.phase, ArchiveRetirementPhase::Retired));
    assert!(!alias.owns_archive);
    assert!(!profile.path().join("sessions").exists());
}

#[test]
fn source_pin_and_branch_lifecycle_files_are_not_recreated_by_readonly_probes() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let job = done(&jobs, &binding);
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let view = branches.prepare(&job.job_id, &[]).unwrap().view_id;
    let directory = profile.path().join("external-history/branches").join(&view);
    fs::rename(
        directory.join("lifecycle.lock"),
        directory.join("saved-life.lock"),
    )
    .unwrap();
    assert!(branches.progress(&job.job_id, &view).is_err());
    assert!(!directory.join("lifecycle.lock").exists());
    assert!(directory.join("saved-life.lock").is_file());
}

#[test]
fn prepared_contexts_keep_branch_sources_live_and_retire_only_their_own_independent_reference() {
    use kcoder_migration::history_context_preparations::{HistoryPreparationOutcome, prepare};
    use kcoder_state::historical_contexts::HistoricalContextStore;
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let job = done(&jobs, &binding);
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let view = branches.prepare(&job.job_id, &[]).unwrap().view_id;
    let ready = branches.build(&job.job_id, &view, || true).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let receipt = match prepare(
        profile.path(),
        &id,
        &job.job_id,
        &view,
        Default::default(),
        |_| true,
    )
    .unwrap()
    {
        HistoryPreparationOutcome::Prepared { receipt, .. } => receipt,
        _ => panic!("owned plain text context should prepare"),
    };
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let archive = job.archive_id.as_deref().unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        4
    );
    branches.retire_choices(&job.job_id).unwrap();
    assert!(
        branches
            .retire_view(
                &job.job_id,
                &view,
                &uuid::Uuid::new_v4().to_string(),
                ready.sequence
            )
            .is_err()
    );
    let contexts = HistoricalContextStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let reader = contexts.reader(&id, |_| true).unwrap();
    assert!(
        contexts
            .retire(&id, &uuid::Uuid::new_v4().to_string())
            .is_err()
    );
    drop(reader);
    let retirement = uuid::Uuid::new_v4().to_string();
    let source_reader = jobs.archive_reader(&job.job_id).unwrap();
    let dependent = archives
        .retain_archive_reference(
            ArchiveReferenceOwner::new(
                ArchiveReferenceKind::Continuation,
                "owned-continuation",
                &"b".repeat(64),
            )
            .unwrap(),
            &[source_reader.lifecycle_guard()],
        )
        .unwrap();
    drop(source_reader);
    assert!(contexts.retire(&id, &retirement).is_err());
    archives.release_archive_reference(&dependent).unwrap();
    contexts.retire(&id, &retirement).unwrap();
    contexts.retire(&id, &retirement).unwrap();
    assert!(
        contexts
            .retire(&id, &uuid::Uuid::new_v4().to_string())
            .is_err()
    );
    assert!(contexts.reader(&id, |_| true).is_err());
    assert!(
        profile
            .path()
            .join("historical-contexts")
            .join(&id)
            .join("document.json")
            .is_file()
    );
    assert_eq!(receipt.preparation_id, id);
    branches
        .retire_view(
            &job.job_id,
            &view,
            &uuid::Uuid::new_v4().to_string(),
            ready.sequence,
        )
        .unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        1
    );
}

#[test]
fn a_preparation_pin_lost_ack_is_readonly_unknown_and_recovers_the_same_native_owner() {
    use kcoder_migration::history_context_preparations::prepare;
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let job = done(&jobs, &binding);
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let view = branches.prepare(&job.job_id, &[]).unwrap().view_id;
    branches.build(&job.job_id, &view, || true).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    prepare(
        profile.path(),
        &id,
        &job.job_id,
        &view,
        Default::default(),
        |_| true,
    )
    .unwrap();
    let directory = profile.path().join("historical-contexts").join(&id);
    let before = fs::read(directory.join("document.json")).unwrap();
    fs::remove_file(directory.join("source-reference.json")).unwrap();
    let contexts =
        kcoder_state::historical_contexts::HistoricalContextStore::open_existing(profile.path())
            .unwrap()
            .unwrap();
    assert!(contexts.reader(&id, |_| true).is_err());
    assert!(!directory.join("source-reference.json").exists());
    prepare(
        profile.path(),
        &id,
        &job.job_id,
        &view,
        Default::default(),
        |_| true,
    )
    .unwrap();
    assert_eq!(fs::read(directory.join("document.json")).unwrap(), before);
    assert!(contexts.reader(&id, |_| true).is_ok());
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(job.archive_id.as_deref().unwrap())
            .unwrap()
            .durable_references,
        4
    );
}

#[test]
fn a_never_published_continuation_has_an_independent_pin_and_explicit_idempotent_retirement() {
    use kcoder_migration::history_continuation_jobs::ContinuationJobs;
    use kcoder_types::historical_continuation::HistoricalContinuationOptions;
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let binding = binding(source.path());
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let job = done(&jobs, &binding);
    let branches = HistoryBranchStore::open(profile.path()).unwrap();
    let view = branches.prepare(&job.job_id, &[]).unwrap().view_id;
    branches.build(&job.job_id, &view, || true).unwrap();
    let continuations = ContinuationJobs::open(profile.path(), workspace.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let created = continuations
        .create(
            &id,
            &job.job_id,
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
    let archives = ExternalHistoryStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let archive = job.archive_id.as_deref().unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        4
    );
    let runner = continuations.begin(&id, created.sequence, false).unwrap();
    let operation = uuid::Uuid::new_v4().to_string();
    assert!(continuations.retire(&id, &operation, None).is_err());
    drop(runner);
    let reader = jobs.archive_reader(&job.job_id).unwrap();
    assert!(continuations.retire(&id, &operation, None).is_err());
    assert!(
        continuations
            .begin(&id, continuations.read(&id).unwrap().sequence, true)
            .is_err()
    );
    drop(reader);
    continuations.retire(&id, &operation, None).unwrap();
    continuations.retire(&id, &operation, None).unwrap();
    assert!(
        continuations
            .retire(&id, &uuid::Uuid::new_v4().to_string(), None)
            .is_err()
    );
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        3
    );
    assert!(!profile.path().join("sessions").exists());
}
