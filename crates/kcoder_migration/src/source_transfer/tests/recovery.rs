use super::*;

fn parts(f: &Fixture, manifest: &TransferManifest) {
    for entry in &manifest.entries {
        for index in 0..entry.bytes.div_ceil(TRANSFER_CHUNK_BYTES as u64) as u32 {
            let chunk = f
                .source
                .chunk(
                    &f.request,
                    &f.destination,
                    &manifest.digest().unwrap(),
                    &entry.id,
                    index,
                )
                .unwrap();
            f.target.write_part(f.source.authority(), &chunk).unwrap();
        }
    }
}

#[test]
fn target_recovery_finishes_owned_parts_with_the_source_offline_and_reconciles_lost_receipts() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    parts(&f, &manifest);
    let source = f.source.authority().clone();
    f.source
        .cancel(
            &f.request,
            &f.destination,
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let source_control = f
        .source_profile
        .join("migrations/source-transfer/exports")
        .join(&f.request)
        .join("control.json");
    let original = std::fs::read(&source_control).unwrap();
    let offline = f._root.path().join("offline-source");
    std::fs::rename(&f.source_profile, &offline).unwrap();
    std::fs::remove_dir_all(&f.files).unwrap();

    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let recovered = target.recover_target(&f.request).unwrap();
    assert!(recovered.source_authority() == &source);
    assert!(recovered.destination() == &f.destination);
    let summary = target.target_summary(&f.request, &source).unwrap();
    assert!(!summary.state.unwrap().ready && summary.progress.unwrap().parts_complete);
    let receipt = target.finish(&f.request, &source, |_| true).unwrap();
    drop(target);
    // An unobserved finish response is reconciled by a read, without another finish.
    let reopened = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let saved = reopened.target_summary(&f.request, &source).unwrap();
    assert_eq!(saved.receipt, Some(receipt));
    assert!(saved.state.unwrap().ready);
    assert_eq!(
        std::fs::read(offline.join(source_control.strip_prefix(&f.source_profile).unwrap()))
            .unwrap(),
        original
    );
    assert!(!f.source_profile.exists());
    assert!(!f.target_profile.join("settings.json").exists());
}

#[test]
fn target_only_cancel_resume_preserves_newer_cancellations_and_the_source_control() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let source_control = f
        .source_profile
        .join("migrations/source-transfer/exports")
        .join(&f.request)
        .join("control.json");
    let original = std::fs::read(&source_control).unwrap();
    let one = target
        .cancel(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let two = target
        .cancel(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let admission = target.admission_state(&f.request).unwrap().unwrap();
    assert!(
        target
            .resume_target(&f.request, f.source.authority(), &admission, Some(&one))
            .is_err()
    );
    assert!(
        target
            .target_summary(&f.request, f.source.authority())
            .unwrap()
            .state
            .unwrap()
            .cancelled
    );
    target
        .resume_target(&f.request, f.source.authority(), &admission, Some(&two))
        .unwrap();
    assert_eq!(std::fs::read(source_control).unwrap(), original);
    assert!(
        target
            .finish(&f.request, f.source.authority(), |_| true)
            .unwrap_err()
            .to_string()
            .contains("source_transfer_incomplete")
    );
}

#[test]
fn recovery_does_not_create_missing_namespaces_roles_identities_or_operation_metadata() {
    let f = Fixture::new();
    let absent = f._root.path().join("absent");
    assert!(IncomingTransfers::open_existing(&absent).is_err());
    assert!(!absent.exists());
    let empty = f._root.path().join("empty-profile");
    PrivateDirectory::open_or_create(&empty).unwrap();
    assert!(IncomingTransfers::open_existing(&empty).is_err());
    assert!(!empty.join("migrations").exists());
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let incoming = f.target_profile.join("migrations/source-transfer/incoming");
    let moved = f._root.path().join("incoming-original");
    std::fs::rename(&incoming, &moved).unwrap();
    assert!(target.recover_target(&f.request).is_err());
    assert!(!incoming.exists());
    std::fs::rename(&moved, &incoming).unwrap();
    let native = f
        .target_profile
        .join("migrations/source-transfer/native.json");
    std::fs::remove_file(&native).unwrap();
    assert!(IncomingTransfers::open_existing(&f.target_profile).is_err());
    assert!(target.recover_target(&f.request).is_err());
    assert!(!native.exists());
}

#[test]
fn recovered_authority_rejects_another_profile_and_incomplete_or_replaced_owned_metadata() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let other = IncomingTransfers::open(&f._root.path().join("another-profile")).unwrap();
    assert!(other.recover_target(&f.request).is_err());
    let mut wrong = f.source.authority().clone();
    wrong.instance_id = uuid::Uuid::new_v4().to_string();
    assert!(target.target_summary(&f.request, &wrong).is_err());
    let operation = f
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(&f.request);
    let parts = operation.join(format!("{}.parts.json", manifest.entries[0].id));
    std::fs::remove_file(&parts).unwrap();
    assert!(
        target
            .target_summary(&f.request, f.source.authority())
            .is_err()
    );
    assert!(!parts.exists());
    let lock = operation.join("writer.lock");
    std::fs::remove_file(&lock).unwrap();
    assert!(target.recover_target(&f.request).is_err());
    assert!(!lock.exists());
}

#[test]
fn a_cancelled_target_reports_the_actual_writer_until_its_lease_is_released() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let directory = PrivateDirectory::open_existing(
        &f.target_profile
            .join("migrations/source-transfer/incoming")
            .join(&f.request),
    )
    .unwrap();
    let guard = super::super::storage::operation_lease(&directory, "writer.lock").unwrap();
    f.target
        .cancel(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let summary = target
        .target_summary(&f.request, f.source.authority())
        .unwrap();
    assert!(summary.state.unwrap().cancelled && summary.worker_running);
    drop(guard);
    assert!(
        !target
            .target_summary(&f.request, f.source.authority())
            .unwrap()
            .worker_running
    );
}

#[test]
fn pre_begin_cancel_survives_lost_receipts_and_blocks_late_full_peer_begin() {
    let f = Fixture::new();
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let command = uuid::Uuid::new_v4().to_string();
    target
        .cancel_target(&f.request, f.source.authority(), &command)
        .unwrap();
    let first = target
        .target_summary(&f.request, f.source.authority())
        .unwrap();
    assert!(first.state.is_none() && first.progress.is_none());
    let expected = first.admission_control.unwrap();
    assert!(expected.cancelled);
    assert!(f.target.begin(&manifest, f.source.authority()).is_err());
    assert!(
        !f.target_profile
            .join("migrations/source-transfer/incoming")
            .join(&f.request)
            .exists()
    );
    // Reconcile the first cancel's lost response with a read or the same command ID.
    target
        .cancel_target(&f.request, f.source.authority(), &command)
        .unwrap();
    assert_eq!(
        target.admission_state(&f.request).unwrap(),
        Some(expected.clone())
    );
    let newer_command = uuid::Uuid::new_v4().to_string();
    target
        .cancel_target(&f.request, f.source.authority(), &newer_command)
        .unwrap();
    assert!(
        target
            .resume_target(&f.request, f.source.authority(), &expected, None)
            .is_err()
    );
    let newer = target.admission_state(&f.request).unwrap().unwrap();
    target
        .resume_target(&f.request, f.source.authority(), &newer, None)
        .unwrap();
    // A lost resume response cannot clear a later independent cancel.
    target
        .cancel_target(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(
        target
            .resume_target(&f.request, f.source.authority(), &newer, None)
            .is_err()
    );
    assert!(f.target.begin(&manifest, f.source.authority()).is_err());
    let current = target.admission_state(&f.request).unwrap().unwrap();
    target
        .resume_target(&f.request, f.source.authority(), &current, None)
        .unwrap();
    f.target.begin(&manifest, f.source.authority()).unwrap();
    let late = f
        .target
        .cancel(&f.request, f.source.authority(), &command)
        .unwrap();
    assert!(
        !late.cancelled,
        "an acknowledged pre-begin command cannot cancel a later operation"
    );
}

#[test]
fn born_admission_identity_missing_or_replaced_is_never_silently_repaired() {
    let f = Fixture::new();
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    let directory = f
        .target_profile
        .join("migrations/source-transfer/incoming")
        .join(format!("{}.admission", f.request));
    let old = f._root.path().join("moved-admission");
    std::fs::rename(&directory, &old).unwrap();
    assert!(target.recover_target(&f.request).is_err());
    assert!(
        target
            .cancel_target(
                &f.request,
                f.source.authority(),
                &uuid::Uuid::new_v4().to_string()
            )
            .is_err()
    );
    assert!(!directory.exists());
    PrivateDirectory::open_or_create(&directory).unwrap();
    assert!(target.recover_target(&f.request).is_err());
    assert!(!directory.join("control.json").exists());
}

#[test]
fn legacy_grants_are_not_upgraded_by_observation_and_explicit_cancel_publishes_revocation() {
    let f = Fixture::new();
    let incoming = f.target_profile.join("migrations/source-transfer/incoming");
    let directory = PrivateDirectory::open_existing(&incoming).unwrap();
    let name = format!("grant-{}.json", f.request);
    let mut grant: serde_json::Value =
        serde_json::from_slice(&std::fs::read(incoming.join(&name)).unwrap()).unwrap();
    grant.as_object_mut().unwrap().remove("admission");
    grant.as_object_mut().unwrap().remove("admission_required");
    directory
        .atomic_replace(OsStr::new(&name), &serde_json::to_vec(&grant).unwrap())
        .unwrap();
    std::fs::remove_dir_all(incoming.join(format!("{}.admission", f.request))).unwrap();
    let original = std::fs::read(incoming.join(&name)).unwrap();
    let target = IncomingTransfers::open_existing(&f.target_profile).unwrap();
    assert!(
        target
            .target_summary(&f.request, f.source.authority())
            .unwrap()
            .admission_control
            .is_none()
    );
    assert_eq!(std::fs::read(incoming.join(&name)).unwrap(), original);
    target
        .cancel_target(
            &f.request,
            f.source.authority(),
            &uuid::Uuid::new_v4().to_string(),
        )
        .unwrap();
    assert!(
        target
            .admission_state(&f.request)
            .unwrap()
            .unwrap()
            .cancelled
    );
    let manifest = f.export(ExportSelection::CapturedHistory(f.history()));
    assert!(f.target.begin(&manifest, f.source.authority()).is_err());
}
