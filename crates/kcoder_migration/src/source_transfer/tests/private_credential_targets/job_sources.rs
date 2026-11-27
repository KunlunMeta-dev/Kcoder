//! Original job provenance remains read-only even when its source is offline or control is cancelled.
use super::*;

#[test]
fn original_job_recovers_exact_source_locators_offline_without_writes_or_private_values() {
    let p = planned();
    let before = original_files(&p.f.target_profile);
    std::fs::rename(&p.f.files, p.f.files.with_extension("source-gone")).unwrap();
    let result = p.store.credential_sources(&p.job.job_id, 0).unwrap();
    assert_eq!(result.job_id, p.job.job_id);
    assert_eq!(result.plan_id, p.job.batch.as_ref().unwrap().plan_id);
    assert_eq!(result.sequence, p.job.sequence);
    assert_eq!(result.items.len(), 2);
    assert_eq!(result.total_items, 2);
    assert_eq!(result.next_page, None);
    for (row, entry) in result.items.iter().zip(&p.manifest.entries) {
        assert_eq!(row.request_id, p.receipt.request_id);
        assert_eq!(row.manifest_sha256, p.receipt.manifest_sha256);
        assert_eq!(row.entry_id, entry.id);
        assert_eq!(
            serde_json::to_value(row)
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            6
        );
    }
    let text = serde_json::to_string(&result).unwrap();
    for forbidden in [
        "SYNTHETIC_TARGET_MAP_PROVIDER",
        "SYNTHETIC_TARGET_MAP_MCP",
        "authority",
        "profile",
        "ciphertext",
        "value",
    ] {
        assert!(!text.contains(forbidden));
    }
    assert_eq!(original_files(&p.f.target_profile), before);
    assert!(
        !p.f.target_profile
            .join("migrations/source-transfer/private-credentials")
            .exists()
    );
}

#[test]
fn source_locator_reads_never_clear_transfer_cancellation_or_change_the_journal() {
    let p = planned();
    let cancelled =
        p.f.target
            .cancel(
                &p.f.request,
                p.f.source.authority(),
                &uuid::Uuid::new_v4().to_string(),
            )
            .unwrap();
    let before = original_files(&p.f.target_profile);
    assert_eq!(
        p.store
            .credential_sources(&p.job.job_id, 0)
            .unwrap()
            .items
            .len(),
        2
    );
    assert_eq!(
        serde_json::to_value(
            p.f.target
                .state(&p.f.request, p.f.source.authority())
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(cancelled).unwrap()
    );
    assert_eq!(original_files(&p.f.target_profile), before);
}

#[test]
fn changed_received_payload_cannot_lend_its_old_job_a_credential_locator() {
    let p = planned();
    let name = crate::source_transfer::source::payload_name(&p.manifest.entries[0]);
    let files = original_files(&p.f.target_profile);
    let path = files
        .keys()
        .find(|path| path.file_name() == Some(OsStr::new(&name)))
        .unwrap();
    let mut bytes = files[path].clone();
    bytes[0] ^= 1;
    std::fs::write(path, bytes).unwrap();
    let before = original_files(&p.f.target_profile);
    assert_eq!(
        p.store
            .credential_sources(&p.job.job_id, 0)
            .unwrap_err()
            .to_string(),
        "source_transfer_payload_changed"
    );
    assert_eq!(original_files(&p.f.target_profile), before);
}

#[test]
fn original_sources_are_paged_ten_at_a_time_and_local_bindings_are_not_received_sources() {
    let p = planned_count(12);
    let first = p.store.credential_sources(&p.job.job_id, 0).unwrap();
    let second = p.store.credential_sources(&p.job.job_id, 1).unwrap();
    assert_eq!(first.items.len(), 10);
    assert_eq!(first.next_page, Some(1));
    assert_eq!(second.items.len(), 2);
    assert_eq!(second.next_page, None);
    assert_eq!(first.total_items, 12);
    assert!(p.store.credential_sources(&p.job.job_id, 2).is_err());
    assert!(p.store.credential_sources("unknown-job", 0).is_err());
    let local = p
        .store
        .create_batch_scan(vec![BatchSource::Configuration(
            ConfigurationBinding::capture_selected(
                &p.f.files.join("root-0/settings.json"),
                Kind::ClaudeCode,
            )
            .unwrap(),
        )])
        .unwrap();
    let empty = p.store.credential_sources(&local.job_id, 0).unwrap();
    assert!(empty.items.is_empty());
    assert_eq!(empty.total_items, 0);
    assert_eq!(empty.plan_id, None);
}
