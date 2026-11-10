use super::*;
use kcoder_migration::history_attachment_jobs::HistoryAttachmentJobs;
fn selection(f: &Fixture) -> HistoricalAttachmentSelection {
    HistoricalAttachmentSelection {
        job_id: f.job.clone(),
        view_id: None,
        tool_item_index: None,
        position: 0,
        block_index: 0,
    }
}
fn attached() -> Fixture {
    Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAECAw=="}}]),
        )],
        false,
    )
}
#[test]
fn attachment_jobs_are_stable_private_reopenable_and_bounded_by_native_coordinates() {
    let f = attached();
    let sel = selection(&f);
    assert!(
        HistoryAttachmentJobs::open_existing(f.profile.path())
            .unwrap()
            .is_none()
    );
    let store = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    assert!(store.read(&sel).unwrap().is_none());
    let prepared = store.prepare(&sel).unwrap();
    assert_eq!(prepared.stage, HistoricalAttachmentJobStage::Planned);
    assert_eq!(store.prepare(&sel).unwrap(), prepared);
    let ready = store.run(&sel, None, || true).unwrap();
    assert_eq!(ready.stage, HistoricalAttachmentJobStage::Ready);
    assert_eq!(store.chunk(&sel, 1, 2).unwrap().1, [1, 2]);
    assert!(
        store
            .chunk(&sel, 0, HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1)
            .is_err()
    );
    drop(store);
    let reopened = HistoryAttachmentJobs::open_existing(f.profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(reopened.read(&sel).unwrap(), Some(ready.clone()));
    assert_eq!(
        reopened
            .run(&sel, None, || panic!("ready extraction must not run again"))
            .unwrap(),
        ready
    );
    assert!(
        reopened
            .read(&HistoricalAttachmentSelection {
                block_index: 1,
                ..sel
            })
            .is_err()
    );
    assert_eq!(f.original(), f.source);
}
#[test]
fn a_new_cancellation_is_not_erased_by_resuming_an_older_cancelled_run() {
    let f = attached();
    let sel = selection(&f);
    let store = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    store.cancel(&sel).unwrap();
    let first = store.run(&sel, None, || true).unwrap();
    assert_eq!(first.stage, HistoricalAttachmentJobStage::Cancelled);
    assert!(store.run(&sel, None, || true).is_err());
    store.cancel(&sel).unwrap();
    let second = store.run(&sel, Some(first.sequence), || true).unwrap();
    assert_eq!(second.stage, HistoricalAttachmentJobStage::Cancelled);
    assert!(second.sequence > first.sequence);
    assert!(store.run(&sel, Some(first.sequence), || true).is_err());
    let ready = store.run(&sel, Some(second.sequence), || true).unwrap();
    assert_eq!(ready.stage, HistoricalAttachmentJobStage::Ready);
    assert!(!ready.cancel_requested);
}
#[test]
fn a_peer_can_observe_and_cancel_the_owned_runner_without_waiting_for_the_payload() {
    let f = attached();
    let sel = selection(&f);
    let store = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    store.prepare(&sel).unwrap();
    let started = std::sync::Arc::new(std::sync::Barrier::new(2));
    let release = std::sync::Arc::new(std::sync::Barrier::new(2));
    let (started2, release2) = (started.clone(), release.clone());
    let root = f.profile.path().to_owned();
    let selected = sel.clone();
    let worker = std::thread::spawn(move || {
        let mut first = true;
        HistoryAttachmentJobs::open(&root)
            .unwrap()
            .run(&selected, None, || {
                if first {
                    first = false;
                    started2.wait();
                    release2.wait();
                }
                true
            })
            .unwrap()
    });
    started.wait();
    assert!(store.running(&sel).unwrap());
    assert_eq!(
        store.read(&sel).unwrap().unwrap().stage,
        HistoricalAttachmentJobStage::Inspecting
    );
    assert!(store.cancel(&sel).unwrap().cancel_requested);
    release.wait();
    let stopped = worker.join().unwrap();
    assert_eq!(stopped.stage, HistoricalAttachmentJobStage::Cancelled);
    assert!(!store.running(&sel).unwrap());
    assert_eq!(
        store
            .run(&sel, Some(stopped.sequence), || true)
            .unwrap()
            .stage,
        HistoricalAttachmentJobStage::Ready
    );
}
#[test]
fn unavailable_and_failed_sources_have_distinct_persisted_results() {
    let f = Fixture::new(
        MigrationSourceKind::Codex,
        vec![codex(
            json!([{"type":"input_image","file_id":"not-fetched"},{"type":"input_image","image_url":"data:image/png;base64,INVALID==="}]),
        )],
        false,
    );
    let store = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    let sel = selection(&f);
    let unavailable = store.run(&sel, None, || true).unwrap();
    assert_eq!(unavailable.stage, HistoricalAttachmentJobStage::Unavailable);
    assert_eq!(
        unavailable.info.unwrap().kind,
        HistoricalAttachmentKind::RemoteReference
    );
    assert!(store.chunk(&sel, 0, 1).is_err());
    let invalid = HistoricalAttachmentSelection {
        block_index: 1,
        ..sel
    };
    let failed = store.run(&invalid, None, || true).unwrap();
    assert_eq!(failed.stage, HistoricalAttachmentJobStage::Failed);
    assert!(failed.failure_code.is_some());
    assert!(store.run(&invalid, None, || true).is_err());
    assert_eq!(
        store.read(&invalid).unwrap().unwrap().stage,
        HistoricalAttachmentJobStage::Failed
    );
}

#[test]
fn tool_collections_and_individual_payloads_have_independent_durable_jobs() {
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            json!([{"type":"tool_result","tool_use_id":"old","content":(0..12).map(|i|json!({"type":"document","title":format!("item-{i}.txt"),"source":{"type":"text","media_type":"text/plain","data":format!("data-{i}")}})).collect::<Vec<_>>()}]),
        )],
        false,
    );
    let parent = selection(&f);
    let store = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    let child = HistoricalAttachmentSelection {
        tool_item_index: Some(0),
        ..parent.clone()
    };
    assert!(store.prepare(&child).is_err());
    let catalog = store.run(&parent, None, || true).unwrap();
    assert_eq!(catalog.stage, HistoricalAttachmentJobStage::Catalogued);
    assert!(catalog.info.is_none());
    assert_eq!(catalog.catalog.as_ref().unwrap().attachments, 12);
    assert_eq!(store.tool_items(&parent, 0).unwrap().items.len(), 10);
    assert_eq!(store.tool_items(&parent, 10).unwrap().items.len(), 2);
    assert!(store.chunk(&parent, 0, 1).is_err());
    let prepared = store.prepare(&child).unwrap();
    assert_ne!(catalog.id, prepared.id);
    store.cancel(&child).unwrap();
    let stopped = store.run(&child, None, || true).unwrap();
    assert_eq!(stopped.stage, HistoricalAttachmentJobStage::Cancelled);
    assert_eq!(
        store.read(&parent).unwrap().unwrap().stage,
        HistoricalAttachmentJobStage::Catalogued
    );
    let ready = store.run(&child, Some(stopped.sequence), || true).unwrap();
    assert_eq!(ready.stage, HistoricalAttachmentJobStage::Ready);
    assert_eq!(store.chunk(&child, 0, 100).unwrap().1, b"data-0");
    drop(store);
    let store = HistoryAttachmentJobs::open_existing(f.profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(store.read(&parent).unwrap().unwrap(), catalog);
    assert_eq!(store.read(&child).unwrap().unwrap(), ready);
    assert!(
        store
            .prepare(&HistoricalAttachmentSelection {
                tool_item_index: Some(12),
                ..parent
            })
            .is_err()
    );
}
#[test]
fn cancelled_collection_scans_require_their_own_sequence_and_plain_text_remains_unstructured() {
    let f = Fixture::new(
        MigrationSourceKind::ClaudeCode,
        vec![claude(
            json!([{"type":"tool_result","tool_use_id":"old","content":"not structured: [{\"type\":\"image\"}]"}]),
        )],
        false,
    );
    let sel = selection(&f);
    let store = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    store.cancel(&sel).unwrap();
    let stopped = store.run(&sel, None, || true).unwrap();
    assert_eq!(stopped.stage, HistoricalAttachmentJobStage::Cancelled);
    assert!(store.run(&sel, None, || true).is_err());
    let ready = store.run(&sel, Some(stopped.sequence), || true).unwrap();
    assert_eq!(ready.stage, HistoricalAttachmentJobStage::Catalogued);
    assert!(!ready.catalog.unwrap().structured);
    assert!(store.tool_items(&sel, 0).unwrap().items.is_empty());
}

#[test]
fn managed_attachment_jobs_pin_their_source_and_retire_only_after_dependents_and_readers_release() {
    use kcoder_state::external_history::{
        ExternalHistoryStore,
        lifecycle::{ArchiveReferenceKind, ArchiveReferenceOwner},
    };
    let f = attached();
    let selected = selection(&f);
    let jobs = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    let ready = jobs.run(&selected, None, || true).unwrap();
    let history = HistoryJobStore::open_existing(f.profile.path())
        .unwrap()
        .unwrap();
    let archived = history.read(&f.job).unwrap();
    let archive_id = archived.archive_id.as_deref().unwrap();
    let archives = ExternalHistoryStore::open_existing(f.profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive_id)
            .unwrap()
            .durable_references,
        2
    );
    let retirement = history
        .prepare_retirement(&uuid::Uuid::new_v4().to_string(), &f.job, archived.sequence)
        .unwrap();
    let blocked = history
        .run_retirement(&retirement.operation_id, retirement.sequence, || true)
        .unwrap();
    assert!(!blocked.logical_retired);
    assert_eq!(
        blocked.failure_code.as_deref(),
        Some("external_history_retirement_referenced")
    );
    let reader = history.archive_reader(&f.job).unwrap();
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
    assert!(jobs.retire(&ready.id, ready.sequence).is_err());
    assert_eq!(jobs.read(&selected).unwrap(), Some(ready.clone()));
    archives.release_archive_reference(&dependent).unwrap();
    let reader = history.archive_reader(&f.job).unwrap();
    assert!(jobs.retire(&ready.id, ready.sequence).is_err());
    drop(reader);
    assert!(jobs.retire(&ready.id, ready.sequence + 1).is_err());
    jobs.retire(&ready.id, ready.sequence).unwrap();
    jobs.retire(&ready.id, ready.sequence).unwrap();
    assert!(jobs.read(&selected).is_err());
    assert!(jobs.run(&selected, None, || true).is_err());
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive_id)
            .unwrap()
            .durable_references,
        1
    );
    assert_eq!(f.original(), f.source);
}

#[test]
fn a_lost_attachment_pin_receipt_is_readonly_unknown_until_explicit_same_job_reconciliation() {
    let f = attached();
    let selected = selection(&f);
    let jobs = HistoryAttachmentJobs::open(f.profile.path()).unwrap();
    let prepared = jobs.prepare(&selected).unwrap();
    let path = f
        .profile
        .path()
        .join("migrations/history-attachments")
        .join(format!("{}.json", prepared.id));
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state.as_object_mut().unwrap().remove("source_reference");
    fs::write(&path, serde_json::to_vec(&state).unwrap()).unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        jobs.read(&selected).unwrap_err().to_string(),
        "history_attachment_reference_recovery_required"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(jobs);
    let jobs = HistoryAttachmentJobs::open_existing(f.profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(jobs.prepare(&selected).unwrap(), prepared);
    let ready = jobs.run(&selected, None, || true).unwrap();
    let archives =
        kcoder_state::external_history::ExternalHistoryStore::open_existing(f.profile.path())
            .unwrap()
            .unwrap();
    let history = HistoryJobStore::open_existing(f.profile.path())
        .unwrap()
        .unwrap();
    let id = history.read(&f.job).unwrap().archive_id.unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(&id)
            .unwrap()
            .durable_references,
        2
    );
    jobs.retire(&ready.id, ready.sequence).unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(&id)
            .unwrap()
            .durable_references,
        1
    );
}
