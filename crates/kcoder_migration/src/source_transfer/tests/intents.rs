use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

fn selected() -> Vec<TransferSelector> {
    vec![TransferSelector::Configuration {
        source_id: "owned-source-reference".into(),
    }]
}
fn prepared(f: &Fixture) -> (SourceTransferIntents, ConfigurationBinding) {
    let journal = SourceTransferIntents::open(&f.source_profile).unwrap();
    let binding = f.config(Kind::ClaudeCode);
    journal
        .prepare(&f.request, &f.destination, selected(), || {
            Ok(vec![ResolvedTransferSelection::Configuration {
                binding: binding.clone(),
            }])
        })
        .unwrap();
    journal
        .prepare_snapshot(&f.request, |bindings| {
            f.source.prepare(
                &f.request,
                &f.destination,
                bindings
                    .iter()
                    .map(ResolvedTransferSelection::export)
                    .collect(),
            )
        })
        .unwrap();
    (journal, binding)
}

#[test]
fn accepted_selector_intent_reopens_original_grants_without_registry_resolution() {
    let f = Fixture::new();
    let (journal, _) = prepared(&f);
    let digest = journal.selectors(&f.request).unwrap().1;
    std::fs::remove_dir_all(&f.files).unwrap();
    let reopened = SourceTransferIntents::open(&f.source_profile).unwrap();
    let bindings = reopened
        .prepare(&f.request, &f.destination, selected(), || {
            panic!("original Native grant must not be resolved again")
        })
        .unwrap();
    assert_eq!(bindings.len(), 1);
    assert_eq!(reopened.selectors(&f.request).unwrap().1, digest);
    let changed = vec![TransferSelector::Configuration {
        source_id: "different-reference".into(),
    }];
    assert!(
        reopened
            .prepare(&f.request, &f.destination, changed, || panic!(
                "changed intent must not resolve"
            ))
            .is_err()
    );
    // Native prepare itself reconciles the saved child without touching the removed source.
    reopened
        .prepare_snapshot(&f.request, |bindings| {
            f.source.prepare(
                &f.request,
                &f.destination,
                bindings
                    .iter()
                    .map(ResolvedTransferSelection::export)
                    .collect(),
            )
        })
        .unwrap();
}

#[test]
fn pending_failed_resolution_never_rebinds_the_same_request_to_a_new_registry() {
    let f = Fixture::new();
    let journal = SourceTransferIntents::open(&f.source_profile).unwrap();
    assert!(
        journal
            .prepare(&f.request, &f.destination, selected(), || anyhow::bail!(
                "PRIVATE_SOURCE_FAILURE_TEXT"
            ))
            .is_err()
    );
    let reopened = SourceTransferIntents::open(&f.source_profile).unwrap();
    assert!(reopened.exists(&f.request).unwrap());
    assert_eq!(
        reopened
            .observe(&f.request, false)
            .unwrap()
            .error_code
            .as_deref(),
        Some("source_transfer_selection_unavailable")
    );
    assert!(
        reopened
            .prepare(&f.request, &f.destination, selected(), || panic!(
                "pending outcome cannot re-resolve"
            ))
            .is_err()
    );
    assert!(
        reopened
            .cancel(&f.request, &uuid::Uuid::new_v4().to_string())
            .unwrap()
            .cancelled
    );
}

#[test]
fn capture_owner_is_running_before_child_io_and_dropped_owners_require_explicit_resume() {
    let f = Fixture::new();
    let (journal, _) = prepared(&f);
    let owner = journal.start_capture(&f.request).unwrap();
    assert_eq!(
        journal.observe(&f.request, false).unwrap().status,
        "running"
    );
    assert!(journal.start_capture(&f.request).is_err());
    drop(owner);
    assert_eq!(
        journal.observe(&f.request, false).unwrap().status,
        "interrupted"
    );
    assert!(journal.start_capture(&f.request).is_err());
    let state = journal.state(&f.request, false).unwrap();
    let frozen = f.source.state(&f.request, &f.destination).unwrap();
    journal
        .resume(&f.request, state.sequence, state.cancel_watermark, || {
            f.source
                .resume(
                    &f.request,
                    &f.destination,
                    frozen.sequence,
                    frozen.cancel_watermark,
                )
                .map(drop)
        })
        .unwrap();
    let owner = journal.start_capture(&f.request).unwrap();
    f.source
        .capture(&f.request, &f.destination, |_| true)
        .unwrap();
    owner.complete(Ok(())).unwrap();
    assert_eq!(journal.observe(&f.request, true).unwrap().status, "ready");
}

#[test]
fn independent_snapshot_cancellation_survives_stale_resume_and_late_host_cancel_mirrors() {
    let f = Fixture::new();
    let (journal, _) = prepared(&f);
    let command = uuid::Uuid::new_v4().to_string();
    let host = journal.cancel(&f.request, &command).unwrap();
    journal
        .mirror_cancellation(&f.request, &command, || {
            f.source.cancel(&f.request, &f.destination, &command)?;
            f.source
                .cancellation_watermark(&f.request, &f.destination, &command)
        })
        .unwrap();
    let frozen = f.source.state(&f.request, &f.destination).unwrap();
    let newer = f
        .source
        .cancel(
            &f.request,
            &f.destination,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(newer.cancel_watermark > frozen.cancel_watermark);
    assert!(
        journal
            .resume(&f.request, host.sequence, host.cancel_watermark, || f
                .source
                .resume(
                    &f.request,
                    &f.destination,
                    frozen.sequence,
                    frozen.cancel_watermark
                )
                .map(drop))
            .is_err()
    );
    assert!(journal.state(&f.request, false).unwrap().cancelled);
    assert!(
        f.source
            .state(&f.request, &f.destination)
            .unwrap()
            .cancelled
    );
    journal
        .resume(&f.request, host.sequence, host.cancel_watermark, || {
            f.source
                .resume(
                    &f.request,
                    &f.destination,
                    newer.sequence,
                    newer.cancel_watermark,
                )
                .map(drop)
        })
        .unwrap();
    let replayed = AtomicBool::new(false);
    journal
        .mirror_cancellation(&f.request, &command, || {
            replayed.store(true, Ordering::SeqCst);
            Ok(Some(999))
        })
        .unwrap();
    assert!(!replayed.load(Ordering::SeqCst));
    assert!(!journal.state(&f.request, false).unwrap().cancelled);
    assert!(
        !f.source
            .state(&f.request, &f.destination)
            .unwrap()
            .cancelled
    );
}

#[test]
fn pure_authority_checks_do_not_recreate_missing_identity_and_orphans_are_not_absence() {
    let f = Fixture::new();
    f.source.verify_authority().unwrap();
    assert!(
        f.source
            .prepared_destination(&f.request, f.target.authority())
            .unwrap()
            .is_none()
    );
    assert!(
        f.target
            .state_if_exists(&f.request, f.source.authority())
            .unwrap()
            .is_none()
    );
    let incoming = PrivateDirectory::open_existing(
        &f.target_profile.join("migrations/source-transfer/incoming"),
    )
    .unwrap();
    incoming
        .create_private_child(OsStr::new(&f.request))
        .unwrap();
    assert!(
        f.target
            .state_if_exists(&f.request, f.source.authority())
            .is_err()
    );
    let native = f
        .source_profile
        .join("migrations/source-transfer/native.json");
    std::fs::remove_file(&native).unwrap();
    assert!(f.source.verify_authority().is_err());
    assert!(!native.exists());
}

#[test]
fn configuration_source_identity_is_content_stable_but_distinguishes_native_roots() {
    let f = Fixture::new();
    let first = f.export(ExportSelection::Configuration(f.config(Kind::ClaudeCode)));
    std::fs::write(f.files.join("settings.json"), "{\"model\":\"new-content\"}").unwrap();
    let binding =
        ConfigurationBinding::capture_selected(&f.files.join("settings.json"), Kind::ClaudeCode)
            .unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let destination = f
        .target
        .issue_destination(&request, f.source.authority())
        .unwrap();
    f.source
        .prepare(
            &request,
            &destination,
            vec![ExportSelection::Configuration(binding)],
        )
        .unwrap();
    let second = f.source.capture(&request, &destination, |_| true).unwrap();
    let other = Fixture::new();
    let third = other.export(ExportSelection::Configuration(
        other.config(Kind::ClaudeCode),
    ));
    let identity = |manifest: &TransferManifest| match &manifest.entries[0].content {
        TransferContent::ConfigurationInventory {
            source_identity,
            source_binding_revision,
            ..
        } => (source_identity.clone(), source_binding_revision.clone()),
        _ => panic!("configuration required"),
    };
    assert_eq!(identity(&first).0, identity(&second).0);
    assert_ne!(identity(&first).1, identity(&second).1);
    assert_ne!(identity(&first).0, identity(&third).0);
    assert!(
        serde_json::to_value(&first).unwrap()["entries"][0]["content"]["sourceIdentity"]
            .as_str()
            .is_some_and(|value| value.len() == 64)
    );
}

#[test]
fn established_operation_observers_do_not_compete_for_the_catalog_creation_mutex() {
    let f = Fixture::new();
    f.export(ExportSelection::Configuration(f.config(Kind::ClaudeCode)));
    let root = PrivateDirectory::open_existing(
        &f.source_profile.join("migrations/source-transfer/exports"),
    )
    .unwrap();
    let _creating_another_job = root
        .try_exclusive_lock(OsStr::new("operations.lock"))
        .unwrap()
        .unwrap();
    assert!(
        f.source.state(&f.request, &f.destination).is_ok(),
        "immutable bound job observation must not fail just because another request is publishing its catalog entry"
    );
}

#[test]
fn capture_completed_between_observation_read_and_free_writer_is_not_overwritten_as_interrupted() {
    let f = Fixture::new();
    let (journal, _) = prepared(&f);
    let owner = journal.start_capture(&f.request).unwrap();
    let observed = journal
        .observe_after_read(&f.request, false, || {
            f.source
                .capture(&f.request, &f.destination, |_| true)
                .unwrap();
            owner.complete(Ok(())).unwrap();
        })
        .unwrap();
    assert_eq!(observed.status, "ready");
    assert!(observed.error_code.is_none());
    assert_eq!(journal.observe(&f.request, false).unwrap().status, "ready");
    assert!(f.source.state(&f.request, &f.destination).unwrap().ready);
}
