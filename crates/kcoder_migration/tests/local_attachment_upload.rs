use kcoder_config::PrivateDirectory;
use kcoder_migration::{
    history_jobs::HistoryJobStore,
    history_sources::HistorySourceBinding,
    history_tool_attachments::HistoryToolAttachments,
    local_attachment::{HistoryLocalAttachments, upload::HistoryLocalAttachmentUploads},
};
use kcoder_types::{
    external_history::*, historical_attachment::*, local_attachment::*, local_attachment_upload::*,
    migration::MigrationSourceKind,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[path = "local_attachment_upload/fixture.rs"]
mod fixture;
use fixture::Fixture;
#[path = "local_attachment_upload/collection.rs"]
mod collection;
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn readonly_prepare_paged_discovery_and_owned_upload_survive_reopen_without_original_source() {
    let fixture = Fixture::new();
    assert!(
        HistoryLocalAttachmentUploads::open_existing(&fixture.profile)
            .unwrap()
            .is_none()
    );
    let uploads = fixture.uploads();
    let id = key();
    let bytes: Vec<u8> = (0..500123).map(|i| (i % 251) as u8).collect();
    let transferred = fixture.fill(&id, &bytes);
    assert_eq!(transferred.received_parts, 3);
    assert_eq!(transferred.received_bytes, bytes.len() as u64);
    assert!(
        !fixture
            .profile
            .join("migrations/history-local-attachments")
            .exists()
    );
    fs::remove_dir_all(fixture.root.path().join("source")).unwrap();
    drop(uploads);
    let uploads = HistoryLocalAttachmentUploads::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let observed = uploads.read(&id).unwrap();
    assert_eq!(observed.sequence, transferred.sequence);
    assert!(!uploads.running(&id).unwrap());
    let finished = uploads.finish(&id, observed.sequence, |_| true).unwrap();
    assert!(finished.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    let local = finished.local_job.unwrap();
    assert!(local.state.stage == HistoricalLocalAttachmentStage::Authorized);
    assert!(!local.historical_content_verified);
    let local_store = HistoryLocalAttachments::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let ready = local_store
        .run(&id, local.state.sequence, |_| true)
        .unwrap();
    assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
    let receipt = ready.state.receipt.unwrap();
    assert_eq!(receipt.sha256, sha(&bytes));
    assert_eq!(
        local_store
            .chunk(&id, &fixture.selection, &receipt, 0, 64)
            .unwrap(),
        bytes[..64]
    );
    let public = serde_json::to_string(&uploads.read(&id).unwrap()).unwrap();
    assert!(!public.contains("NEVER_AUTHORIZED"));
    assert!(!public.contains(fixture.profile.to_str().unwrap()));
    let mut ids = vec![id];
    for _ in 0..11 {
        let id = key();
        uploads.prepare(&id, &fixture.selection, |_| true).unwrap();
        ids.push(id);
    }
    let first = uploads.list(&fixture.selection, None).unwrap();
    assert_eq!(first.items.len(), 10);
    let next = uploads
        .list(&fixture.selection, first.next_cursor.as_deref())
        .unwrap();
    assert_eq!(next.items.len(), 2);
    assert!(next.next_cursor.is_none());
    let other = HistoricalAttachmentSelection {
        block_index: 1,
        ..fixture.selection.clone()
    };
    assert!(uploads.list(&other, None).unwrap().items.is_empty());
}

#[test]
fn immutable_parts_lost_receipts_and_stale_sequences_never_append_or_truncate() {
    let fixture = Fixture::new();
    let uploads = fixture.uploads();
    let id = key();
    let bytes = vec![7u8; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize + 9];
    let prepared = uploads.prepare(&id, &fixture.selection, |_| true).unwrap();
    let begun = uploads
        .begin(
            &id,
            prepared.sequence,
            "document.bin",
            bytes.len() as u64,
            &sha(&bytes),
        )
        .unwrap();
    assert!(
        uploads
            .part(
                &id,
                begun.sequence,
                1,
                &bytes[HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize..]
            )
            .is_err()
    );
    let first = uploads
        .part(
            &id,
            begun.sequence,
            0,
            &bytes[..HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize],
        )
        .unwrap();
    let repeated = uploads
        .part(
            &id,
            begun.sequence,
            0,
            &bytes[..HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize],
        )
        .unwrap();
    assert_eq!(repeated.sequence, first.sequence);
    assert!(
        uploads
            .part(
                &id,
                first.sequence,
                0,
                &vec![8u8; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize]
            )
            .is_err()
    );
    let parts = fixture.op(&id).join("parts");
    fs::remove_file(parts.join("part-0000.receipt.json")).unwrap();
    let before = fs::read(parts.join("part-0000.bin")).unwrap();
    let read = uploads.read(&id).unwrap();
    assert_eq!(read.received_parts, 0);
    assert!(!parts.join("part-0000.receipt.json").exists());
    assert!(uploads.part(&id, begun.sequence, 0, &before).is_err());
    let repaired = uploads.part(&id, read.sequence, 0, &before).unwrap();
    assert_eq!(repaired.received_parts, 1);
    assert_eq!(fs::read(parts.join("part-0000.bin")).unwrap(), before);
    assert!(
        uploads
            .part(
                &id,
                first.sequence,
                1,
                &bytes[HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize..]
            )
            .is_err()
    );
    let done = uploads
        .part(
            &id,
            repaired.sequence,
            1,
            &bytes[HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize..],
        )
        .unwrap();
    assert!(
        uploads
            .finish(&id, done.sequence, |_| true)
            .unwrap()
            .local_job
            .is_some()
    );
}

#[test]
fn upload_cancellation_revisions_and_whole_digest_failures_remain_explicit() {
    let fixture = Fixture::new();
    let uploads = fixture.uploads();
    let id = key();
    let bytes = vec![4u8; 700000];
    let filled = fixture.fill(&id, &bytes);
    let cancelled = uploads.cancel(&id).unwrap();
    assert!(cancelled.cancel_requested);
    assert!(uploads.finish(&id, filled.sequence, |_| true).is_err());
    let resumed = uploads.resume(&id, cancelled.sequence).unwrap();
    let newer = uploads.cancel(&id).unwrap();
    assert!(uploads.resume(&id, resumed.sequence).is_err());
    let resumed = uploads.resume(&id, newer.sequence).unwrap();
    let stopped = uploads
        .finish(&id, resumed.sequence, |at| at < 100000)
        .unwrap();
    assert!(stopped.stage == HistoricalLocalAttachmentUploadStage::Cancelled);
    assert!(stopped.local_job.is_none());
    let resumed = uploads.resume(&id, stopped.sequence).unwrap();
    assert!(
        uploads
            .finish(&id, resumed.sequence, |_| true)
            .unwrap()
            .local_job
            .is_some()
    );
    let cancelled_copy = uploads.cancel(&id).unwrap();
    let resumed_copy = uploads.resume(&id, cancelled_copy.sequence).unwrap();
    assert!(!resumed_copy.cancel_requested);
    assert!(
        resumed_copy
            .local_job
            .as_ref()
            .unwrap()
            .state
            .cancel_requested
    );
    let local = resumed_copy.local_job.unwrap();
    let ready = HistoryLocalAttachments::open_existing(&fixture.profile)
        .unwrap()
        .unwrap()
        .run(&id, local.state.sequence, |_| true)
        .unwrap();
    assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
    assert!(!uploads.read(&id).unwrap().cancel_requested);
    let bad = key();
    let prepared = uploads.prepare(&bad, &fixture.selection, |_| true).unwrap();
    let state = uploads
        .begin(&bad, prepared.sequence, "bad.bin", 4, &sha(b"else"))
        .unwrap();
    let state = uploads.part(&bad, state.sequence, 0, b"data").unwrap();
    let failed = uploads.finish(&bad, state.sequence, |_| true).unwrap();
    assert!(failed.stage == HistoricalLocalAttachmentUploadStage::Failed);
    assert!(failed.local_job.is_none());
    assert!(!fixture.op(&bad).join("payload.bin").exists());
}

#[test]
fn lost_authorize_checkpoint_reconciles_original_grant_without_reselecting_or_copying() {
    let fixture = Fixture::new();
    let uploads = fixture.uploads();
    let id = key();
    let filled = fixture.fill(&id, b"frozen uploaded bytes");
    let authorized = uploads.finish(&id, filled.sequence, |_| true).unwrap();
    let proof = fs::read(fixture.op(&id).join("authorization.json")).unwrap();
    let state_path = fixture.op(&id).join("state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    state["stage"] = json!("assembling");
    fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
    drop(uploads);
    let reopened = HistoryLocalAttachmentUploads::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let observed = reopened.read(&id).unwrap();
    assert!(observed.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    assert!(
        observed.local_job.as_ref().unwrap().state.stage
            == HistoricalLocalAttachmentStage::Authorized
    );
    let again = reopened
        .finish(&id, authorized.sequence, |_| {
            panic!("must observe original grant, not reselect source")
        })
        .unwrap();
    assert!(again.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    assert_eq!(
        fs::read(fixture.op(&id).join("authorization.json")).unwrap(),
        proof
    );
}

#[test]
fn budgets_invalid_names_changed_ownership_and_links_do_not_grant_paths() {
    let fixture = Fixture::new();
    let uploads = fixture.uploads();
    let id = key();
    let prepared = uploads.prepare(&id, &fixture.selection, |_| true).unwrap();
    assert!(
        uploads
            .begin(&id, prepared.sequence, "../escape", 0, &sha(b""))
            .is_err()
    );
    assert!(
        uploads
            .begin(&id, prepared.sequence, ".env", 0, &sha(b""))
            .is_err()
    );
    assert!(
        uploads
            .begin(
                &id,
                prepared.sequence,
                "file.bin",
                HISTORICAL_LOCAL_UPLOAD_MAX_BYTES + 1,
                &sha(b"")
            )
            .is_err()
    );
    for _ in 0..4 {
        let op = key();
        let prepared = uploads.prepare(&op, &fixture.selection, |_| true).unwrap();
        uploads
            .begin(
                &op,
                prepared.sequence,
                "large.bin",
                HISTORICAL_LOCAL_UPLOAD_MAX_BYTES,
                &"a".repeat(64),
            )
            .unwrap();
    }
    assert!(
        uploads
            .begin(&id, prepared.sequence, "large.bin", 1, &sha(b"a"))
            .is_err()
    );
    let lock = fixture.op(&id).join("writer.lock");
    fs::rename(&lock, fixture.op(&id).join("old-writer.lock")).unwrap();
    assert!(uploads.read(&id).is_err());
    assert!(uploads.running(&id).is_err());
    assert!(!lock.exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(fixture.root.path().join("never-open"), &lock).unwrap();
        assert!(uploads.read(&id).is_err());
    }
    let separate = Fixture::new();
    let peer = separate.uploads();
    assert!(peer.read(&id).is_err());
}

#[test]
fn independent_cancel_stops_an_active_assembly_and_a_different_native_grant_is_never_adopted() {
    let fixture = Fixture::new();
    let uploads = fixture.uploads();
    let peer = fixture.uploads();
    let id = key();
    let bytes = vec![11u8; 900000];
    let filled = fixture.fill(&id, &bytes);
    let mut cancelled = false;
    let stopped = uploads
        .finish(&id, filled.sequence, |at| {
            if at >= 65536 && !cancelled {
                assert!(peer.running(&id).unwrap());
                let requested = peer.cancel(&id).unwrap();
                assert!(requested.cancel_requested);
                cancelled = true;
            }
            true
        })
        .unwrap();
    assert!(cancelled);
    assert!(stopped.stage == HistoricalLocalAttachmentUploadStage::Cancelled);
    assert!(!uploads.running(&id).unwrap());
    let resumed = uploads.resume(&id, stopped.sequence).unwrap();
    assert!(
        uploads
            .finish(&id, resumed.sequence, |_| true)
            .unwrap()
            .local_job
            .is_some()
    );

    // Same bytes and historical coordinates do not authorize replacing another native selection.
    let conflict = key();
    let data = b"equal bytes, different native grant";
    let filled = fixture.fill(&conflict, data);
    let external = fixture.root.path().join("explicit-local-selection");
    PrivateDirectory::open_or_create(&external).unwrap();
    fs::write(external.join("file.bin"), data).unwrap();
    let request =
        HistoryLocalAttachments::prepare_selection(&fixture.profile, &fixture.selection, |_| true)
            .unwrap();
    let selected = kcoder_state::external_history::local_attachment::SelectedLocalFile::select(
        &external,
        Path::new("file.bin"),
        true,
        |_| true,
    )
    .unwrap();
    let native = HistoryLocalAttachments::open(&fixture.profile).unwrap();
    let original = native.authorize(&conflict, &request, &selected).unwrap();
    assert!(
        uploads
            .finish(&conflict, filled.sequence, |_| true)
            .is_err()
    );
    let retained = native.read(&conflict).unwrap();
    assert_eq!(
        serde_json::to_value(retained).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(fs::read(external.join("file.bin")).unwrap(), data);
}

#[test]
fn both_sources_messages_and_typed_tool_items_use_the_same_frozen_upload_authority() {
    for kind in [MigrationSourceKind::ClaudeCode, MigrationSourceKind::Codex] {
        for tool in [false, true] {
            let fixture = Fixture::source(kind, tool);
            let uploads = fixture.uploads();
            let id = key();
            let bytes = b"explicit browser-selected bytes";
            let transferred = fixture.fill(&id, bytes);
            let authorized = uploads.finish(&id, transferred.sequence, |_| true).unwrap();
            let native = HistoryLocalAttachments::open_existing(&fixture.profile)
                .unwrap()
                .unwrap();
            let ready = native
                .run(&id, authorized.local_job.unwrap().state.sequence, |_| true)
                .unwrap();
            assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
            assert_eq!(
                native
                    .chunk(
                        &id,
                        &fixture.selection,
                        &ready.state.receipt.unwrap(),
                        0,
                        128
                    )
                    .unwrap(),
                bytes
            );
            assert!(!fixture.root.path().join("NEVER_AUTHORIZED").exists());
        }
    }
}

#[test]
fn restart_after_the_authorization_intent_before_native_dispatch_restores_the_original_grant() {
    let fixture = Fixture::new();
    let uploads = fixture.uploads();
    let id = key();
    let filled = fixture.fill(&id, b"durable upload grant across interrupted dispatch");
    let authorization = fixture.op(&id).join("authorization.json");
    // A real cancellation checkpoint is immediately after the intent, before Native is invoked.
    let interrupted = uploads
        .finish(&id, filled.sequence, |_| !authorization.exists())
        .unwrap();
    assert!(interrupted.stage == HistoricalLocalAttachmentUploadStage::OutcomeUnknown);
    assert!(interrupted.local_job.is_none());
    assert!(
        HistoryLocalAttachments::open_existing(&fixture.profile)
            .unwrap()
            .is_none()
    );
    let original = fs::read(&authorization).unwrap();
    drop(uploads);
    let reopened = HistoryLocalAttachmentUploads::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let resumed = reopened
        .finish(&id, reopened.read(&id).unwrap().sequence, |_| true)
        .unwrap();
    assert!(resumed.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    assert!(resumed.local_job.is_some());
    assert_eq!(fs::read(&authorization).unwrap(), original);
}

#[test]
fn browser_prepare_pins_the_source_before_bytes_and_cancel_does_not_silently_release_it() {
    use kcoder_state::external_history::ExternalHistoryStore;
    let f = Fixture::new();
    let upload = f.uploads();
    let operation = key();
    let prepared = upload.prepare(&operation, &f.selection, |_| true).unwrap();
    let history = HistoryJobStore::open_existing(&f.profile).unwrap().unwrap();
    let job = history.read(&f.selection.job_id).unwrap();
    let archives = ExternalHistoryStore::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    let archive = job.archive_id.as_deref().unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        2
    );
    let cancelled = upload.cancel(&operation).unwrap();
    assert!(cancelled.cancel_requested);
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        2
    );
    assert!(upload.retire(&operation, prepared.sequence).is_err());
    upload.retire(&operation, cancelled.sequence).unwrap();
    upload.retire(&operation, cancelled.sequence).unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(archive)
            .unwrap()
            .durable_references,
        1
    );
    assert!(upload.read(&operation).is_err());
    assert!(upload.list(&f.selection, None).unwrap().items.is_empty());
    assert!(f.op(&operation).join("grant.json").exists());
}

#[test]
fn same_owned_upload_recovers_its_pin_receipt_and_the_local_copy_has_an_independent_lifetime() {
    use kcoder_state::external_history::ExternalHistoryStore;
    let f = Fixture::new();
    let operation = key();
    let upload = f.uploads();
    let prepared = upload.prepare(&operation, &f.selection, |_| true).unwrap();
    let reference = f.op(&operation).join("source-reference.json");
    fs::remove_file(&reference).unwrap();
    assert!(upload.read(&operation).is_err());
    assert!(!reference.exists());
    assert!(upload.prepare(&operation, &f.selection, |_| true).unwrap() == prepared);
    let data = b"explicit bytes";
    let state = upload
        .begin(
            &operation,
            prepared.sequence,
            "replacement.bin",
            data.len() as u64,
            &sha(data),
        )
        .unwrap();
    let state = upload.part(&operation, state.sequence, 0, data).unwrap();
    let authorized = upload.finish(&operation, state.sequence, |_| true).unwrap();
    let local = HistoryLocalAttachments::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    let ready = local
        .run(
            &operation,
            authorized.local_job.unwrap().state.sequence,
            |_| true,
        )
        .unwrap();
    assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
    let history = HistoryJobStore::open_existing(&f.profile).unwrap().unwrap();
    let archive = history
        .read(&f.selection.job_id)
        .unwrap()
        .archive_id
        .unwrap();
    let archives = ExternalHistoryStore::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(&archive)
            .unwrap()
            .durable_references,
        3
    );
    assert!(upload.retire(&operation, authorized.sequence).is_err());
    let retirement = key();
    local.retire(&operation, &retirement).unwrap();
    local.retire(&operation, &retirement).unwrap();
    assert!(local.retire(&operation, &key()).is_err());
    assert!(local.read(&operation).is_err());
    upload.retire(&operation, authorized.sequence).unwrap();
    assert_eq!(
        archives
            .archive_lifecycle_observation(&archive)
            .unwrap()
            .durable_references,
        1
    );
    assert!(f.op(&operation).join("payload.bin").exists());
}
