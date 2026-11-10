use super::*;
use kcoder_migration::local_attachment::upload::collection::UploadCollectionStage;
use std::{sync::mpsc, time::Duration};

#[test]
fn original_upload_parts_are_explicitly_collected_and_only_the_final_receipt_releases_reservations()
{
    let f = Fixture::new();
    let original = fs::read(f.root.path().join("source/fixture.jsonl")).unwrap();
    let id = key();
    let data = vec![7; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize + 19];
    let state = f.fill(&id, &data);
    let uploads = f.uploads();
    let prepared = uploads.prepare_collection(&id, state.sequence).unwrap();
    assert!(!prepared.storage_retired && prepared.deleted_bytes == 0);
    assert!(f.op(&id).join("parts/part-0000.bin").exists());
    let done = uploads
        .run_collection(&id, &prepared.collection_id, prepared.sequence, |_| true)
        .unwrap();
    assert!(done.stage == UploadCollectionStage::Collected && done.storage_retired);
    assert_eq!(done.deleted_bytes, data.len() as u64);
    assert_eq!(done.released_reservation_bytes, data.len() as u64 * 2);
    assert!(!f.op(&id).join("parts/part-0000.bin").exists());
    assert!(f.op(&id).join("parts/part-0000.receipt.json").exists());
    let Err(error) = uploads.read(&id) else {
        panic!("retired upload data remained live")
    };
    assert_eq!(error.to_string(), "local_upload_storage_retired");
    assert_eq!(
        uploads.read_collection(&id).unwrap().unwrap().deleted_bytes,
        done.deleted_bytes
    );
    assert_eq!(
        fs::read(f.root.path().join("source/fixture.jsonl")).unwrap(),
        original
    );
}

#[test]
fn a_ready_local_copy_remains_readable_after_staging_collection_and_an_active_native_writer_blocks_it()
 {
    let f = Fixture::new();
    let id = key();
    let data = b"copied native bytes remain available";
    let uploads = f.uploads();
    let filled = f.fill(&id, data);
    let authorized = uploads.finish(&id, filled.sequence, |_| true).unwrap();
    let local = HistoryLocalAttachments::open(&f.profile).unwrap();
    let prepared = uploads
        .prepare_collection(&id, authorized.sequence)
        .unwrap();
    let blocked = uploads
        .run_collection(&id, &prepared.collection_id, prepared.sequence, |_| true)
        .unwrap();
    assert!(blocked.stage == UploadCollectionStage::Blocked && !blocked.storage_retired);
    let ready = local
        .run(&id, authorized.local_job.unwrap().state.sequence, |_| true)
        .unwrap();
    assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);
    let profile = f.profile.clone();
    let history = f.selection.job_id.clone();
    let native_id = id.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(0);
    let (go_tx, go_rx) = mpsc::sync_channel(0);
    let worker = std::thread::spawn(move || {
        let jobs = HistoryJobStore::open_existing(&profile).unwrap().unwrap();
        let archive = jobs.archive_reader(&history).unwrap();
        let _writer = archive
            .local_attachment_import(&native_id, true)
            .unwrap()
            .unwrap();
        ready_tx.send(()).unwrap();
        go_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let blocked = uploads
        .run_collection(&id, &blocked.collection_id, blocked.sequence, |_| true)
        .unwrap();
    assert!(blocked.stage == UploadCollectionStage::Blocked && !blocked.storage_retired);
    assert!(f.op(&id).join("payload.bin").exists());
    go_tx.send(()).unwrap();
    worker.join().unwrap();
    let done = uploads
        .run_collection(&id, &blocked.collection_id, blocked.sequence, |_| true)
        .unwrap();
    assert!(
        done.stage == UploadCollectionStage::Collected
            && done.deleted_bytes == data.len() as u64 * 2
    );
    assert!(!f.op(&id).join("payload.bin").exists());
    let still_ready = local.read(&id).unwrap();
    assert!(still_ready.state.stage == HistoricalLocalAttachmentStage::Ready);
    assert_eq!(
        local
            .chunk(
                &id,
                &f.selection,
                still_ready.state.receipt.as_ref().unwrap(),
                0,
                64 * 1024
            )
            .unwrap(),
        data
    );
}

#[test]
fn active_assembly_prevents_collection_preparation_without_cancelling_or_deleting_peer_bytes() {
    let f = Fixture::new();
    let id = key();
    let data = vec![9; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize + 7];
    let uploads = f.uploads();
    let state = f.fill(&id, &data);
    let mut checked = false;
    let finished = uploads
        .finish(&id, state.sequence, |bytes| {
            if bytes > 0 && !checked {
                checked = true;
                let Err(error) = uploads.prepare_collection(&id, state.sequence) else {
                    panic!("active upload writer was bypassed")
                };
                assert_eq!(error.to_string(), "local_upload_busy");
            }
            true
        })
        .unwrap();
    assert!(checked && finished.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    assert!(uploads.read_collection(&id).unwrap().is_none());
    assert!(f.op(&id).join("payload.bin").exists());
}

#[test]
fn lost_leaf_and_completion_checkpoints_reconcile_only_the_original_collection_and_keep_audit() {
    let f = Fixture::new();
    let id = key();
    let data = vec![4; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize + 37];
    let uploads = f.uploads();
    let state = f.fill(&id, &data);
    let prepared = uploads.prepare_collection(&id, state.sequence).unwrap();
    let mut cancelled = false;
    let stopped = uploads
        .run_collection(&id, &prepared.collection_id, prepared.sequence, |_| {
            if !cancelled && !f.op(&id).join("parts/part-0000.bin").exists() {
                cancelled = true;
                uploads
                    .cancel_collection(&id, &prepared.collection_id)
                    .unwrap();
            }
            true
        })
        .unwrap();
    assert!(stopped.storage_retired && stopped.deleted_bytes > 0);
    let record = f.op(&id).join("collection.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    value["removed"] = json!([]);
    value["deleted_bytes"] = json!(0);
    value["pending"] = json!("parts/part-0000.bin");
    fs::write(&record, serde_json::to_vec(&value).unwrap()).unwrap();
    drop(uploads);
    let uploads = HistoryLocalAttachmentUploads::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    let observed = uploads.read_collection(&id).unwrap().unwrap();
    let resumed = uploads
        .resume_collection(
            &id,
            &observed.collection_id,
            observed.sequence,
            observed.upload_sequence,
        )
        .unwrap();
    let done = uploads
        .run_collection(&id, &resumed.collection_id, resumed.sequence, |_| true)
        .unwrap();
    assert!(
        done.stage == UploadCollectionStage::Collected && done.deleted_bytes == data.len() as u64
    );
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&record).unwrap()).unwrap();
    value["stage"] = json!("collecting");
    value["sequence"] = json!(done.sequence - 1);
    fs::write(&record, serde_json::to_vec(&value).unwrap()).unwrap();
    let known = uploads.read_collection(&id).unwrap().unwrap();
    assert!(known.stage == UploadCollectionStage::Collected);
    let recovered = uploads
        .run_collection(&id, &known.collection_id, known.sequence, |_| true)
        .unwrap();
    assert_eq!(recovered.deleted_bytes, done.deleted_bytes);
    assert!(recovered.stage == UploadCollectionStage::Collected);
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(f.op(&id).join("collection.json")).unwrap()).unwrap();
    assert!(
        f.op(&id)
            .join(format!(
                "collection-plan-{}.json",
                record["plan"].as_str().unwrap()
            ))
            .exists()
    );
}

#[test]
fn reservation_capacity_is_returned_only_after_all_registered_data_has_confirmed_delete_receipts() {
    let f = Fixture::new();
    let uploads = f.uploads();
    let mut operations = Vec::new();
    for _ in 0..4 {
        let id = key();
        let prepared = uploads.prepare(&id, &f.selection, |_| true).unwrap();
        let state = uploads
            .begin(
                &id,
                prepared.sequence,
                "large.bin",
                HISTORICAL_LOCAL_UPLOAD_MAX_BYTES,
                &"f".repeat(64),
            )
            .unwrap();
        operations.push((id, state.sequence));
    }
    let data = vec![1; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize];
    let first = uploads
        .part(&operations[0].0, operations[0].1, 0, &data)
        .unwrap();
    let fifth = key();
    let prepared = uploads.prepare(&fifth, &f.selection, |_| true).unwrap();
    assert!(
        uploads
            .begin(
                &fifth,
                prepared.sequence,
                "large.bin",
                HISTORICAL_LOCAL_UPLOAD_MAX_BYTES,
                &"f".repeat(64)
            )
            .is_err()
    );
    let collection = uploads
        .prepare_collection(&operations[0].0, first.sequence)
        .unwrap();
    assert_eq!(collection.released_reservation_bytes, 0);
    assert!(
        uploads
            .begin(
                &fifth,
                prepared.sequence,
                "large.bin",
                HISTORICAL_LOCAL_UPLOAD_MAX_BYTES,
                &"f".repeat(64)
            )
            .is_err()
    );
    let done = uploads
        .run_collection(
            &operations[0].0,
            &collection.collection_id,
            collection.sequence,
            |_| true,
        )
        .unwrap();
    assert!(done.stage == UploadCollectionStage::Collected);
    assert_eq!(done.deleted_bytes, data.len() as u64);
    assert_eq!(
        done.released_reservation_bytes,
        HISTORICAL_LOCAL_UPLOAD_MAX_BYTES * 2
    );
    uploads
        .begin(
            &fifth,
            prepared.sequence,
            "large.bin",
            HISTORICAL_LOCAL_UPLOAD_MAX_BYTES,
            &"f".repeat(64),
        )
        .unwrap();
}

#[test]
fn old_unsealed_markers_and_missing_collection_controls_cannot_gain_new_deletion_rights() {
    let f = Fixture::new();
    let id = key();
    let state = f.fill(&id, b"retained original");
    let uploads = f.uploads();
    let grant = f.op(&id).join("grant.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&grant).unwrap()).unwrap();
    value["version"] = json!(2);
    value.as_object_mut().unwrap().remove("collection_birth");
    fs::write(&grant, serde_json::to_vec(&value).unwrap()).unwrap();
    let Err(error) = uploads.prepare_collection(&id, state.sequence) else {
        panic!("unsealed old version acquired collection rights")
    };
    assert_eq!(error.to_string(), "local_upload_collection_legacy_retained");
    assert!(f.op(&id).join("parts/part-0000.bin").exists());
    let id = key();
    let state = f.fill(&id, b"another owned upload");
    uploads.prepare_collection(&id, state.sequence).unwrap();
    let lock = f.op(&id).join("collection-writer.lock");
    fs::remove_file(&lock).unwrap();
    assert!(uploads.read_collection(&id).is_err());
    assert!(!lock.exists());
}

#[test]
fn only_the_registered_single_link_prepublication_temporary_can_be_collected_after_a_lost_publish_ack()
 {
    for mode in ["registered", "unknown-name", "multiple-links"] {
        let f = Fixture::new();
        let id = key();
        let data = b"original flushed temporary bytes";
        let state = f.fill(&id, data);
        let uploads = f.uploads();
        let parts = f.op(&id).join("parts");
        let proof: serde_json::Value =
            serde_json::from_slice(&fs::read(parts.join("part-0000.bin.proof.json")).unwrap())
                .unwrap();
        let registered = proof["values"][0]["temporary_name"].as_str().unwrap();
        fs::remove_file(parts.join("part-0000.receipt.json")).unwrap();
        let name = if mode == "unknown-name" {
            ".part-0000.bin.1.999999.tmp"
        } else {
            registered
        };
        if mode == "multiple-links" {
            fs::hard_link(parts.join("part-0000.bin"), parts.join(name)).unwrap();
        } else {
            fs::rename(parts.join("part-0000.bin"), parts.join(name)).unwrap();
        }
        let prepared = uploads.prepare_collection(&id, state.sequence).unwrap();
        let result = uploads
            .run_collection(&id, &prepared.collection_id, prepared.sequence, |_| true)
            .unwrap();
        if mode == "registered" {
            assert!(result.stage == UploadCollectionStage::Collected);
            assert_eq!(result.deleted_bytes, data.len() as u64);
            assert!(!parts.join(name).exists());
        } else {
            assert!(result.stage == UploadCollectionStage::Blocked && !result.storage_retired);
            assert!(parts.join(name).exists());
        }
    }
}

#[test]
fn collection_history_is_scoped_paged_ten_and_cancel_before_retirement_preserves_upload_bytes() {
    let f = Fixture::new();
    let uploads = f.uploads();
    let mut ids = Vec::new();
    for _ in 0..11 {
        let id = key();
        let state = f.fill(&id, b"do not delete on cancellation");
        let prepared = uploads.prepare_collection(&id, state.sequence).unwrap();
        let cancelled = uploads
            .cancel_collection(&id, &prepared.collection_id)
            .unwrap();
        assert!(
            !cancelled.storage_retired
                && cancelled.deleted_bytes == 0
                && cancelled.released_reservation_bytes == 0
        );
        assert!(f.op(&id).join("parts/part-0000.bin").exists());
        assert!(uploads.read(&id).is_ok());
        ids.push(id);
    }
    let first = uploads.list_collections(&f.selection, None).unwrap();
    assert_eq!(first.items.len(), 10);
    let second = uploads
        .list_collections(&f.selection, first.next_cursor.as_deref())
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert!(second.next_cursor.is_none());
    let mut actual = first
        .items
        .into_iter()
        .chain(second.items)
        .map(|item| item.operation_id)
        .collect::<Vec<_>>();
    actual.sort();
    ids.sort();
    assert_eq!(actual, ids);
    let mut other = f.selection.clone();
    other.position += 1;
    assert!(
        uploads
            .list_collections(&other, None)
            .unwrap()
            .items
            .is_empty()
    );
}

#[test]
fn explicit_resume_before_a_tombstone_can_rebase_a_changed_upload_and_retains_its_original_plan() {
    let f = Fixture::new();
    let uploads = f.uploads();
    let id = key();
    let data = vec![2; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize + 11];
    let prepared = uploads.prepare(&id, &f.selection, |_| true).unwrap();
    let begun = uploads
        .begin(
            &id,
            prepared.sequence,
            "input.bin",
            data.len() as u64,
            &sha(&data),
        )
        .unwrap();
    let first = uploads
        .part(
            &id,
            begun.sequence,
            0,
            &data[..HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize],
        )
        .unwrap();
    let collection = uploads.prepare_collection(&id, first.sequence).unwrap();
    let mut cancelled = false;
    let stopped = uploads
        .run_collection(&id, &collection.collection_id, collection.sequence, |_| {
            let record: serde_json::Value =
                serde_json::from_slice(&fs::read(f.op(&id).join("collection.json")).unwrap())
                    .unwrap();
            if !cancelled && record["plan"].is_string() && record["tombstone"] == json!(false) {
                cancelled = true;
                uploads
                    .cancel_collection(&id, &collection.collection_id)
                    .unwrap();
            }
            true
        })
        .unwrap();
    assert!(cancelled && !stopped.storage_retired && stopped.deleted_bytes == 0);
    let old: serde_json::Value =
        serde_json::from_slice(&fs::read(f.op(&id).join("collection.json")).unwrap()).unwrap();
    let completed = uploads
        .part(
            &id,
            first.sequence,
            1,
            &data[HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize..],
        )
        .unwrap();
    assert!(
        uploads
            .run_collection(&id, &stopped.collection_id, stopped.sequence, |_| true)
            .unwrap()
            .cancel_requested
    );
    let current = uploads.read_collection(&id).unwrap().unwrap();
    let resumed = uploads
        .resume_collection(
            &id,
            &current.collection_id,
            current.sequence,
            completed.sequence,
        )
        .unwrap();
    let done = uploads
        .run_collection(&id, &resumed.collection_id, resumed.sequence, |_| true)
        .unwrap();
    assert!(
        done.stage == UploadCollectionStage::Collected && done.deleted_bytes == data.len() as u64
    );
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(f.op(&id).join("collection.json")).unwrap()).unwrap();
    assert_eq!(record["prior_plans"][0], old["plan"]);
    assert!(
        f.op(&id)
            .join(format!(
                "collection-plan-{}.json",
                old["plan"].as_str().unwrap()
            ))
            .exists()
    );
}

#[test]
fn collection_cancellation_after_a_real_delete_preserves_progress_and_reopens_the_same_control() {
    let f = Fixture::new();
    let id = key();
    let data = vec![8; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize + 31];
    let state = f.fill(&id, &data);
    let uploads = f.uploads();
    let prepared = uploads.prepare_collection(&id, state.sequence).unwrap();
    let mut requested = false;
    let stopped = uploads
        .run_collection(&id, &prepared.collection_id, prepared.sequence, |_| {
            if !requested && !f.op(&id).join("parts/part-0000.bin").exists() {
                requested = true;
                uploads
                    .cancel_collection(&id, &prepared.collection_id)
                    .unwrap();
            }
            true
        })
        .unwrap();
    assert!(requested && stopped.storage_retired && stopped.cancel_requested);
    assert!(
        stopped.stage == UploadCollectionStage::Cancelled
            && stopped.deleted_bytes > 0
            && stopped.released_reservation_bytes == 0
    );
    drop(uploads);
    let uploads = HistoryLocalAttachmentUploads::open_existing(&f.profile)
        .unwrap()
        .unwrap();
    let current = uploads.read_collection(&id).unwrap().unwrap();
    let resumed = uploads
        .resume_collection(
            &id,
            &current.collection_id,
            current.sequence,
            current.upload_sequence,
        )
        .unwrap();
    let done = uploads
        .run_collection(&id, &resumed.collection_id, resumed.sequence, |_| true)
        .unwrap();
    assert!(done.stage == UploadCollectionStage::Collected);
    assert_eq!(done.deleted_bytes, data.len() as u64);
    assert_eq!(done.collection_id, prepared.collection_id);
}

#[test]
fn changed_or_replaced_original_upload_data_and_unknown_entries_never_become_collection_authority()
{
    for mode in ["bytes", "replacement", "unknown"] {
        let f = Fixture::new();
        let id = key();
        let data = b"original upload bytes";
        let state = f.fill(&id, data);
        let uploads = f.uploads();
        let parts = f.op(&id).join("parts");
        match mode {
            "bytes" => fs::write(parts.join("part-0000.bin"), b"changed upload bytes!").unwrap(),
            "replacement" => PrivateDirectory::open_existing(&parts)
                .unwrap()
                .atomic_replace(std::ffi::OsStr::new("part-0000.bin"), data)
                .unwrap(),
            _ => fs::write(parts.join("keep-user-notes.txt"), b"keep me").unwrap(),
        }
        let prepared = uploads.prepare_collection(&id, state.sequence).unwrap();
        let blocked = uploads
            .run_collection(&id, &prepared.collection_id, prepared.sequence, |_| true)
            .unwrap();
        assert!(
            blocked.stage == UploadCollectionStage::Blocked
                && !blocked.storage_retired
                && blocked.deleted_bytes == 0
        );
        assert!(parts.join("part-0000.bin").exists());
    }
}
