use super::*;
use crate::{history_jobs::HistoryJobStore, local_attachment::test_fixture::Fixture};
use kcoder_types::local_attachment::HistoricalLocalAttachmentStage;
use std::{sync::mpsc, time::Duration};
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[test]
fn a_cached_local_run_cannot_start_after_its_actual_retirement_commits() {
    let fixture = Fixture::new();
    assert!(fixture.root.path().is_dir());
    let operation = key();
    let uploads = fixture.uploads();
    let filled = fixture.fill(&operation, b"owned upload input");
    assert!(fixture.op(&operation).is_dir());
    let authorized = uploads
        .finish(&operation, filled.sequence, |_| true)
        .unwrap();
    let sequence = authorized.local_job.unwrap().state.sequence;
    let local = HistoryLocalAttachments::open(&fixture.profile).unwrap();
    let cached = local.job(&operation).unwrap();
    let reference = cached.reference.clone();
    let profile = fixture.profile.clone();
    let worker_operation = operation.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let worker = std::thread::spawn(move || {
        let local = HistoryLocalAttachments::open_existing(&profile)
            .unwrap()
            .unwrap();
        ready_tx.send(()).unwrap();
        go_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        local
            .run_cached(&worker_operation, cached, sequence, |_| true)
            .map(|value| value.state.stage == HistoricalLocalAttachmentStage::Ready)
            .map_err(|error| error.to_string())
    });
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    local.retire(&operation, &key()).unwrap();
    go_tx.send(()).unwrap();
    assert_eq!(
        worker.join().unwrap().unwrap_err(),
        "local_attachment_job_retired"
    );
    let jobs = HistoryJobStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let reader = jobs.archive_reader(&fixture.selection.job_id).unwrap();
    let state = reader
        .local_attachment_import(&operation, false)
        .unwrap()
        .unwrap()
        .view(&reference)
        .unwrap();
    assert!(state.stage == HistoricalLocalAttachmentStage::Authorized);
    assert!(state.receipt.is_none());
}
