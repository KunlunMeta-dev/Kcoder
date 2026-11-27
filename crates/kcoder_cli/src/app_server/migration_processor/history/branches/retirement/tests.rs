use super::*;
use kcoder_migration::history_sources::HistorySourceBinding;
use kcoder_types::{external_history::*, migration::MigrationSourceKind};

#[test]
fn a_finished_worker_between_native_and_queue_reads_cannot_publish_an_old_prepared_snapshot() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let path = source.path().join("source.jsonl");
    std::fs::write(&path,b"{\"type\":\"user\",\"uuid\":\"owned\",\"sessionId\":\"owned\",\"message\":{\"role\":\"user\",\"content\":\"synthetic\"}}\n").unwrap();
    let binding = HistorySourceBinding::capture(
        source.path(),
        std::path::Path::new("source.jsonl"),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "owned-observation-fixture".into(),
            source_session_id: "owned".into(),
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
    .unwrap();
    let jobs = HistoryJobStore::open(profile.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let mut job = jobs.create(&id, &binding).unwrap();
    for _ in 0..16 {
        if job.stage == HistoryImportStage::Normalized {
            break;
        }
        job = jobs.step(&id, job.sequence, 10, |_| true).unwrap();
    }
    assert_eq!(job.stage, HistoryImportStage::Normalized);
    let operation = uuid::Uuid::new_v4().to_string();
    let prepared = jobs
        .prepare_retirement(&operation, &id, job.sequence)
        .unwrap();
    let workers = BranchWorkers::new(CancellationToken::new());
    let mut inserted = false;
    let result = workers
        .retirement_observe_interleaved(&jobs, &operation, || {
            if !inserted {
                inserted = true;
                let collected = jobs.run_retirement(&operation, prepared.sequence, || true)?;
                ensure!(
                    collected.phase == ArchiveRetirementPhase::Collected,
                    "owned_fixture_did_not_collect"
                );
                workers.tasks.lock().unwrap().workers.insert(
                    format!("archive-retirement:{operation}"),
                    Arc::new(Worker::default()),
                );
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        result.retirement.phase,
        MigrationArchiveRetirementPhase::Collected
    );
    assert_eq!(
        result.worker_state,
        MigrationArchiveRetirementWorkerState::Stopped
    );
    assert!(!result.worker_scheduled);
    assert!(result.retirement.logical_retired);
}
