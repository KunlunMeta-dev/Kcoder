use super::*;
use crate::source_transfer::storage::{Store, save};

#[test]
fn compressed_physical_bytes_and_logical_snapshot_survive_transport_and_original_removal() {
    let f = Fixture::new();
    let logical = b"{\"type\":\"user\",\"uuid\":\"compressed-user\",\"message\":{\"role\":\"user\",\"content\":\"Synthetic compressed history\"}}\n";
    let physical = zstd::stream::encode_all(&logical[..], 1).unwrap();
    let file = f.files.join("history.jsonl.zst");
    std::fs::write(&file, &physical).unwrap();
    let origin = f.history().snapshot().origin.clone();
    let binding = HistorySourceBinding::capture(
        &f.files,
        Path::new("history.jsonl.zst"),
        origin,
        &mut |_, _| true,
    )
    .unwrap();
    let expected = binding.snapshot().clone();
    assert_eq!(expected.source_bytes, logical.len() as u64);
    assert_eq!(
        expected.original.as_ref().unwrap().bytes,
        physical.len() as u64
    );
    let manifest = f.export(ExportSelection::CapturedHistory(binding));
    assert_eq!(manifest.entries[0].bytes, physical.len() as u64);
    let receipt = f.copy(&manifest);
    std::fs::remove_dir_all(&f.files).unwrap();
    let received = f
        .target
        .history_binding(
            &f.request,
            f.source.authority(),
            &manifest.entries[0].id,
            &receipt,
            |_| true,
        )
        .unwrap();
    assert!(received.snapshot().original == expected.original);
    assert_eq!(received.snapshot().source_sha256, expected.source_sha256);
    let archive =
        kcoder_state::external_history::ExternalHistoryStore::open(&f.target_profile).unwrap();
    let committed = received
        .archive(&archive, &uuid::Uuid::new_v4().to_string(), &mut |_| true)
        .unwrap();
    assert_eq!(committed.receipt.record_count, 1);
    assert_eq!(
        committed.receipt.source_sha256,
        format!("{:x}", sha2::Sha256::digest(logical))
    );
}

#[test]
fn unknown_conflicting_prefix_is_preserved_instead_of_overwritten() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let entry = &manifest.entries[0];
    let chunk = f
        .source
        .chunk(
            &f.request,
            &f.destination,
            &manifest.digest().unwrap(),
            &entry.id,
            0,
        )
        .unwrap();
    let path = f
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(&f.request);
    let directory = PrivateDirectory::open_existing(&path).unwrap();
    let mut file = directory
        .open_read_write_file(
            OsStr::new(&super::super::source::payload_name(entry)),
            false,
        )
        .unwrap();
    let unknown = vec![b'!'; 8192];
    file.write_all(&unknown).unwrap();
    file.sync_all().unwrap();
    drop(file);
    let before = std::fs::read(path.join(super::super::source::payload_name(entry))).unwrap();
    assert!(
        f.target
            .write_part(f.source.authority(), &chunk)
            .unwrap_err()
            .to_string()
            .contains("source_transfer_outcome_unknown")
    );
    assert_eq!(
        std::fs::read(path.join(super::super::source::payload_name(entry))).unwrap(),
        before
    );
    assert_eq!(
        f.target
            .part_receipt(&f.request, f.source.authority(), &entry.id)
            .unwrap()
            .accepted_parts,
        0
    );
}

#[test]
fn missing_operation_control_is_never_recreated_by_prepare_read_or_cancel() {
    for role in ["exports", "incoming"] {
        let f = Fixture::new();
        let binding = f.config(Kind::ClaudeCode);
        let manifest = f.export(ExportSelection::Configuration(binding.clone()));
        f.target.begin(&manifest, f.source.authority()).unwrap();
        let profile = if role == "exports" {
            &f.source_profile
        } else {
            &f.target_profile
        };
        let path = profile
            .join("migrations/source-transfer")
            .join(role)
            .join(&f.request)
            .join("control.json");
        std::fs::remove_file(&path).unwrap();
        if role == "exports" {
            let source = SourceTransfers::open(&f.source_profile).unwrap();
            assert!(
                source
                    .prepare(
                        &f.request,
                        &f.destination,
                        vec![ExportSelection::Configuration(binding)]
                    )
                    .is_err()
            );
            assert!(source.state(&f.request, &f.destination).is_err());
            assert!(
                source
                    .cancel(
                        &f.request,
                        &f.destination,
                        &uuid::Uuid::new_v4().to_string()
                    )
                    .is_err()
            );
        } else {
            let target = IncomingTransfers::open(&f.target_profile).unwrap();
            assert!(target.begin(&manifest, f.source.authority()).is_err());
            assert!(target.state(&f.request, f.source.authority()).is_err());
            assert!(
                target
                    .cancel(
                        &f.request,
                        f.source.authority(),
                        &uuid::Uuid::new_v4().to_string()
                    )
                    .is_err()
            );
        }
        assert!(!path.exists());
    }
}

#[test]
fn changed_payload_or_forged_final_receipt_blocks_configuration_use_without_repair() {
    for change_receipt in [false, true] {
        let f = Fixture::new();
        let manifest = f.export(ExportSelection::Configuration(f.config(Kind::Codex)));
        let receipt = f.copy(&manifest);
        let path = f
            .target_profile
            .join("migrations/source-transfer/incoming")
            .join(&f.request);
        let directory = PrivateDirectory::open_existing(&path).unwrap();
        if change_receipt {
            let mut forged = receipt.clone();
            forged.bytes += 1;
            save(&directory, "receipt.json", &forged).unwrap();
        } else {
            let name = super::super::source::payload_name(&manifest.entries[0]);
            let mut file = directory
                .open_read_write_file(OsStr::new(&name), false)
                .unwrap();
            file.write_all(b"!").unwrap();
            file.sync_all().unwrap();
        }
        let before = std::fs::read(path.join(if change_receipt {
            "receipt.json".into()
        } else {
            super::super::source::payload_name(&manifest.entries[0])
        }))
        .unwrap();
        assert!(
            f.target
                .configuration_inventory(
                    &f.request,
                    f.source.authority(),
                    &manifest.entries[0].id,
                    &receipt
                )
                .is_err()
        );
        let after = std::fs::read(path.join(if change_receipt {
            "receipt.json".into()
        } else {
            super::super::source::payload_name(&manifest.entries[0])
        }))
        .unwrap();
        assert_eq!(before, after);
    }
}

#[test]
fn fixed_request_grant_and_aggregate_reservations_fail_before_large_file_creation() {
    let f = Fixture::new();
    let request = uuid::Uuid::new_v4().to_string();
    assert!(
        f.source
            .prepare(
                &request,
                &f.destination,
                vec![ExportSelection::Configuration(f.config(Kind::ClaudeCode))]
            )
            .is_err()
    );
    assert!(
        !f.source_profile
            .join("migrations/source-transfer/exports")
            .join(&request)
            .exists()
    );
    let store = Store::open(&f.target_profile, "incoming").unwrap();
    for _ in 0..10 {
        store
            .reserve(
                &uuid::Uuid::new_v4().to_string(),
                &"b".repeat(64),
                TRANSFER_MAX_BYTES,
            )
            .unwrap();
    }
    let overflow = uuid::Uuid::new_v4().to_string();
    assert!(
        store
            .reserve(&overflow, &"c".repeat(64), 1)
            .unwrap_err()
            .to_string()
            .contains("source_transfer_storage_budget_exceeded")
    );
    let directory = f.target_profile.join("migrations/source-transfer/incoming");
    assert!(!directory.join(format!("reserve-{overflow}.json")).exists());
    assert!(!directory.join(&overflow).exists());
    for entry in std::fs::read_dir(directory).unwrap() {
        assert!(entry.unwrap().metadata().unwrap().len() < 8192);
    }
}
