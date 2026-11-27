use kcoder_migration::{
    history_jobs::{HistoryImportEvent, HistoryJobStore},
    history_sources::HistorySourceBinding,
};
use kcoder_types::{external_history::*, migration::MigrationSourceKind};
use serde_json::json;
use std::{fs, path::Path};

fn binding(root: &Path, count: usize, compressed: bool) -> HistorySourceBinding {
    let content = (0..count)
        .map(|index| {
            json!({
        "type":"user", "uuid":format!("row-{index}"), "sessionId":"fixture-session",
        "parentUuid":if index > 0 { Some(format!("row-{}",index-1)) } else { None },
        "message":{"role":"user", "content":[{"type":"text","text":"PRIVATE-CONTENT-CANARY"}]}
    }).to_string()+"\n"
        })
        .collect::<String>();
    let name = if compressed {
        "selected.jsonl.zst"
    } else {
        "selected.jsonl"
    };
    fs::write(
        root.join(name),
        if compressed {
            zstd::stream::encode_all(content.as_bytes(), 1).unwrap()
        } else {
            content.into_bytes()
        },
    )
    .unwrap();
    HistorySourceBinding::capture(
        root,
        Path::new(name),
        ExternalHistoryOrigin {
            source: MigrationSourceKind::ClaudeCode,
            source_instance: "explicit-fixture".into(),
            source_session_id: "fixture-session".into(),
            source_artifact_id: None,
            source_format: "synthetic-jsonl".into(),
            adapter_revision: "raw/1".into(),
            title: Some("PRIVATE-TITLE-CANARY".into()),
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
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn finish(store: &HistoryJobStore, mut job: HistoryImportJobView) -> HistoryImportJobView {
    for _ in 0..100 {
        if job.stage == HistoryImportStage::Normalized {
            return job;
        }
        assert!(!matches!(
            job.stage,
            HistoryImportStage::Failed | HistoryImportStage::Cancelled
        ));
        job = store.step(&job.job_id, job.sequence, 10, |_| true).unwrap();
    }
    panic!("job did not reach normalization boundary")
}

#[test]
fn stages_survive_restart_with_bounded_commits_and_no_source_content_in_views() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 25, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let request = id();
    let created = store.create(&request, &binding).unwrap();
    assert_eq!(created.stage, HistoryImportStage::Planned);
    assert!(!created.archived);
    // Earlier captured jobs did not store a selection or nullable archive identity.
    let journal_path = profile
        .path()
        .join("migrations/history")
        .join(format!("{request}.json"));
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(&journal_path).unwrap()).unwrap();
    legacy.as_object_mut().unwrap().remove("selection");
    legacy.as_object_mut().unwrap().remove("selectionSha256");
    assert!(legacy["view"]["archiveId"].is_string());
    fs::write(&journal_path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    assert_eq!(store.create(&request, &binding).unwrap(), created);
    assert!(store.read(&request).unwrap().normalization.is_none());
    let archived = store.step(&request, 0, 10, |_| true).unwrap();
    assert!(archived.archived);
    assert_eq!(archived.stage, HistoryImportStage::Normalizing);
    fs::remove_file(source.path().join("selected.jsonl")).unwrap();
    let partial = store
        .step(&request, archived.sequence, 10, |_| true)
        .unwrap();
    assert_eq!(
        partial.normalization.as_ref().unwrap().normalized_records,
        10
    );
    drop(store);
    let store = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(store.read(&request).unwrap(), partial);
    let done = finish(&store, partial);
    assert_eq!(done.normalization.as_ref().unwrap().normalized_records, 25);
    assert!(done.normalization.as_ref().unwrap().normalization_complete);
    assert_eq!(
        store
            .step(&request, done.sequence, 10, |_| panic!(
                "completed job must not run"
            ))
            .unwrap(),
        done
    );
    assert_eq!(store.request_cancel(&request).unwrap(), done);
    let encoded = serde_json::to_string(&done).unwrap();
    assert!(!encoded.contains("PRIVATE-"));
    assert!(!encoded.contains(&source.path().to_string_lossy().to_string()));
    assert!(!profile.path().join("sessions").exists());
}

#[test]
fn cancel_before_running_persists_and_requires_explicit_resume() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let request = id();
    let created = store.create(&request, &binding).unwrap();
    assert!(store.request_cancel(&request).unwrap().cancel_requested);
    let cancelled = store
        .step(&request, created.sequence, 10, |_| {
            panic!("must not open the source")
        })
        .unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert!(!cancelled.archived);
    assert_eq!(
        store
            .step(&request, cancelled.sequence, 10, |_| panic!(
                "resume is explicit"
            ))
            .unwrap(),
        cancelled
    );
    assert!(store.resume(&request, 0).is_err());
    let resumed = store.resume(&request, cancelled.sequence).unwrap();
    assert!(!resumed.cancel_requested);
    assert_eq!(resumed.stage, HistoryImportStage::Planned);
    finish(&store, resumed);
}

#[test]
fn cancelled_decode_recovers_from_original_after_source_is_removed() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 30, true);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let request = id();
    let created = store.create(&request, &binding).unwrap();
    let cancelled = store
        .step(&request, created.sequence, 10, |event| {
            if matches!(
                event,
                HistoryImportEvent::Archive(ExternalHistoryProgress {
                    phase: ExternalHistoryPhase::Decoding,
                    ..
                })
            ) {
                fs::remove_file(source.path().join("selected.jsonl.zst")).unwrap();
                false
            } else {
                true
            }
        })
        .unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert!(!cancelled.archived);
    drop(store);
    let store = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let resumed = store.resume(&request, cancelled.sequence).unwrap();
    assert_eq!(
        finish(&store, resumed)
            .normalization
            .unwrap()
            .normalized_records,
        30
    );
}

#[test]
fn progress_is_readable_and_cancel_is_accepted_while_runner_is_leased() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 30, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let peer = HistoryJobStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    let request = id();
    store.create(&request, &binding).unwrap();
    let archived = store.step(&request, 0, 10, |_| true).unwrap();
    let mut requested = false;
    let cancelled = store
        .step(&request, archived.sequence, 10, |event| {
            let current = peer.read(&request).unwrap();
            assert!(peer.step(&request, current.sequence, 10, |_| true).is_err());
            if let HistoryImportEvent::Normalize(progress) = event
                && progress.committed.normalized_records >= 3
                && !requested
            {
                assert!(peer.request_cancel(&request).unwrap().cancel_requested);
                requested = true;
            }
            true
        })
        .unwrap();
    assert!(requested);
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    assert_eq!(
        cancelled.normalization.as_ref().unwrap().normalized_records,
        3
    );
    let resumed = peer.resume(&request, cancelled.sequence).unwrap();
    assert_eq!(
        finish(&peer, resumed)
            .normalization
            .unwrap()
            .normalized_records,
        30
    );
}

#[test]
fn lost_job_receipt_reconciles_the_committed_archive_without_source_replay() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 11, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let request = id();
    store.create(&request, &binding).unwrap();
    let path = profile
        .path()
        .join("migrations/history")
        .join(format!("{request}.json"));
    let before = fs::read(&path).unwrap();
    store.step(&request, 0, 10, |_| true).unwrap();
    fs::write(&path, before).unwrap();
    fs::remove_file(source.path().join("selected.jsonl")).unwrap();
    let observed = store.read(&request).unwrap();
    assert!(observed.archived);
    assert_eq!(observed.sequence, 0);
    let done = finish(&store, observed);
    assert_eq!(done.normalization.unwrap().normalized_records, 11);
}

#[test]
fn changed_source_records_a_safe_failure_without_publishing_and_retry_is_explicit() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let request = id();
    store.create(&request, &binding).unwrap();
    fs::write(source.path().join("selected.jsonl"), b"PRIVATE-CANARY").unwrap();
    let failed = store.step(&request, 0, 10, |_| true).unwrap();
    assert_eq!(failed.stage, HistoryImportStage::Failed);
    assert!(!failed.archived);
    assert!(failed.failure_code.is_some());
    assert!(!serde_json::to_string(&failed).unwrap().contains("PRIVATE"));
    assert_eq!(store.read(&request).unwrap(), failed);
    assert_eq!(
        store
            .step(&request, failed.sequence, 10, |_| panic!(
                "must not silently retry"
            ))
            .unwrap(),
        failed
    );
}

#[test]
fn request_ids_and_owner_identity_do_not_authorize_replacement_bindings_or_profiles() {
    let profile = tempfile::tempdir().unwrap();
    let peer_profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let first = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let request = id();
    store.create(&request, &first).unwrap();
    let changed = binding(source.path(), 2, false);
    assert!(store.create(&request, &changed).is_err());
    for invalid in ["../escape", "", "ffffffff-ffff-ffff-ffff-FFFFFFFFFFFF"] {
        assert!(store.read(invalid).is_err());
        assert!(store.create(invalid, &first).is_err());
    }
    let peer = HistoryJobStore::open(peer_profile.path()).unwrap();
    fs::copy(
        profile
            .path()
            .join("migrations/history")
            .join(format!("{request}.json")),
        peer_profile
            .path()
            .join("migrations/history")
            .join(format!("{request}.json")),
    )
    .unwrap();
    assert!(peer.read(&request).is_err());
    assert!(store.step(&request, 1, 10, |_| true).is_err());
    assert!(store.step(&request, 0, 11, |_| true).is_err());
}

#[test]
fn job_records_have_ten_row_pages_and_open_existing_creates_nothing() {
    let absent = tempfile::tempdir().unwrap();
    assert!(
        HistoryJobStore::open_existing(absent.path())
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read_dir(absent.path()).unwrap().count(), 0);
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    for _ in 0..11 {
        store.create(&id(), &binding).unwrap();
    }
    let (first, next) = store.records(None).unwrap();
    assert_eq!(first.len(), 10);
    let (second, end) = store.records(next.as_deref()).unwrap();
    assert_eq!(second.len(), 1);
    assert!(end.is_none());
    assert!(!first.iter().any(|row| row.job_id == second[0].job_id));
    assert!(store.records(Some("../bad")).is_err());
}

#[test]
fn unknown_records_remain_visible_as_diagnostics_after_normalization() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut selected = binding(source.path(), 1, false);
    fs::write(
        source.path().join("selected.jsonl"),
        b"{\"type\":\"future_record\"}\n",
    )
    .unwrap();
    selected = HistorySourceBinding::capture(
        source.path(),
        Path::new("selected.jsonl"),
        selected.snapshot().origin.clone(),
        &mut |_, _| true,
    )
    .unwrap();
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let created = store.create(&id(), &selected).unwrap();
    let done = finish(&store, created);
    assert_eq!(done.normalization.unwrap().records_with_diagnostics, 1);
}

#[test]
fn a_new_job_verifies_a_reused_archive_and_rejects_corruption() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let first = finish(&store, store.create(&id(), &binding).unwrap());
    fs::remove_file(source.path().join("selected.jsonl")).unwrap();
    let reused = finish(&store, store.create(&id(), &binding).unwrap());
    assert_eq!(first.archive_id, reused.archive_id);
    let path = profile
        .path()
        .join("external-history")
        .join(first.archive_id.as_ref().unwrap())
        .join("source.bin");
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(&path, &bytes).unwrap();
    let created = store.create(&id(), &binding).unwrap();
    let failed = store
        .step(&created.job_id, created.sequence, 10, |_| true)
        .unwrap();
    assert_eq!(failed.stage, HistoryImportStage::Failed);
    assert!(failed.archived); // A past receipt is retained, without claiming the damaged archive is ready.
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn missing_projection_is_not_hidden_by_an_old_normalized_job_status() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let done = finish(&store, store.create(&id(), &binding).unwrap());
    let archive = profile
        .path()
        .join("external-history")
        .join(done.archive_id.as_ref().unwrap());
    for entry in fs::read_dir(archive).unwrap() {
        let entry = entry.unwrap();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("normalized-")
        {
            fs::remove_dir_all(entry.path()).unwrap();
        }
    }
    assert!(store.read(&done.job_id).is_err());
    assert!(
        store
            .step(&done.job_id, done.sequence, 10, |_| panic!(
                "must not silently rebuild a missing derived store"
            ))
            .is_err()
    );
}

#[test]
fn normalization_failure_remains_readable_without_silent_retry() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 20, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let created = store.create(&id(), &binding).unwrap();
    let archived = store.step(&created.job_id, 0, 10, |_| true).unwrap();
    fs::remove_file(
        profile
            .path()
            .join("external-history")
            .join(archived.archive_id.as_ref().unwrap())
            .join("records.bin"),
    )
    .unwrap();
    let failed = store
        .step(&archived.job_id, archived.sequence, 10, |_| true)
        .unwrap();
    assert_eq!(failed.stage, HistoryImportStage::Failed);
    assert!(failed.failure_code.is_some());
    assert_eq!(store.read(&failed.job_id).unwrap(), failed);
    assert_eq!(
        store
            .step(&failed.job_id, failed.sequence, 10, |_| panic!(
                "failure requires explicit recovery"
            ))
            .unwrap(),
        failed
    );
}

#[test]
fn codex_rollouts_use_the_same_durable_stages_without_becoming_active_sessions() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let claude = binding(source.path(), 1, false);
    let mut origin = claude.snapshot().origin.clone();
    origin.source = MigrationSourceKind::Codex;
    let content=[
        json!({"type":"session_meta","payload":{"id":"fixture-session","cli_version":kcoder_migration::history_records::CODEX_ROLLOUT_BASELINE}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"historical-call","name":"write","arguments":"{\"file_path\":\"MUST-NOT-EXIST\",\"content\":\"forbidden replay\"}"}}),
    ].into_iter().map(|record|record.to_string()+"\n").collect::<String>();
    fs::write(source.path().join("selected.jsonl"), content).unwrap();
    let selected = HistorySourceBinding::capture(
        source.path(),
        Path::new("selected.jsonl"),
        origin,
        &mut |_, _| true,
    )
    .unwrap();
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let done = finish(&store, store.create(&id(), &selected).unwrap());
    assert_eq!(done.source, MigrationSourceKind::Codex);
    assert_eq!(done.normalization.unwrap().normalized_records, 3);
    assert!(!profile.path().join("sessions").exists());
    assert!(!profile.path().join("MUST-NOT-EXIST").exists());
    assert!(!source.path().join("MUST-NOT-EXIST").exists());
}

#[test]
fn cancel_and_resume_cannot_skip_verification_of_a_reused_archive() {
    let profile = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let binding = binding(source.path(), 1, false);
    let store = HistoryJobStore::open(profile.path()).unwrap();
    let first = finish(&store, store.create(&id(), &binding).unwrap());
    let path = profile
        .path()
        .join("external-history")
        .join(first.archive_id.as_ref().unwrap())
        .join("source.bin");
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(path, bytes).unwrap();
    let created = store.create(&id(), &binding).unwrap();
    let cancelled = store.step(&created.job_id, 0, 10, |_| false).unwrap();
    assert_eq!(cancelled.stage, HistoryImportStage::Cancelled);
    let resumed = store.resume(&created.job_id, cancelled.sequence).unwrap();
    assert_eq!(resumed.stage, HistoryImportStage::Planned);
    let failed = store
        .step(&resumed.job_id, resumed.sequence, 10, |_| true)
        .unwrap();
    assert_eq!(failed.stage, HistoryImportStage::Failed);
}
