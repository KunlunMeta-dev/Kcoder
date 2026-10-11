//! Owner retirement tests only. No epoch GC or legacy lifecycle wiring.
use super::*;

fn stored_owner(service: &RetentionService, id: &str) -> Owner {
    service
        .store
        .transaction()
        .unwrap()
        .read(Area::Owners, id)
        .unwrap()
        .unwrap()
}

fn durable_allocating_owner(service: &RetentionService, scope: &Scope) -> Owner {
    storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
    let error = service.create_owner(scope).err().unwrap();
    assert!(
        error
            .to_string()
            .contains("after durable retention journal")
    );
    let tx = service.store.transaction().unwrap();
    let page: IndexPage = tx.read(Area::Index, "1:0").unwrap().unwrap();
    let locator = page
        .records
        .iter()
        .find(|record| record.area == Area::Owners)
        .unwrap();
    let file = service
        .store
        .testing_area(Area::Owners)
        .unwrap()
        .open_regular_file(OsStr::new(&locator.leaf))
        .unwrap();
    let owner: Owner = serde_json::from_reader(file).unwrap();
    assert_eq!(owner.phase, OwnerPhase::Allocating);
    owner
}

fn live_charges(service: &RetentionService, epoch: u64) -> (u64, u64, u64, u64, u64, u64) {
    let tx = service.store.transaction().unwrap();
    let c = &tx.state.charges;
    (
        c.owners,
        c.entries,
        c.receipt_slots,
        c.staged_bytes,
        c.owner_proofs,
        tx.state.epochs[&epoch].nonterminal_allocations,
    )
}

fn assert_missing_child(parent: &PrivateDirectory, name: &str) {
    let error = parent
        .open_child(OsStr::new(name), false)
        .expect_err("exact locator must be absent");
    assert!(missing(&error), "unexpected absence error: {error:#}");
}

fn assert_retirement_phase(
    service: &RetentionService,
    id: &str,
    data: RemovalPhase,
    lease: RemovalPhase,
) {
    let owner = stored_owner(service, id);
    assert_eq!(owner.phase, OwnerPhase::Retiring);
    let phase = owner.retirement.unwrap();
    assert_eq!(phase.data, data);
    assert_eq!(phase.lease, lease);
}

#[test]
fn retention_owner_release_consume_retire_restores_capacity_without_gc() {
    let limits = Limits {
        owners: 1,
        entries: 1,
        receipt_slots: 1,
        entry_bytes: 32,
        owner_bytes: 32,
        staged_bytes: 32,
        ..Limits::default()
    };
    let (temp, service, scope) = fixture(limits.clone());
    let lease = service.create_owner(&scope).unwrap();
    let owner_id = lease.id.clone();
    let reference = upload(&service, &scope, &lease, "original-upload");
    let receipt = reserve(&service, &scope, reference.clone());
    assert!(service.create_owner(&scope).is_err());
    assert!(service.retire_owner(&scope, &lease).is_err());
    let released = service
        .release_original_owner(&scope, &lease, &receipt.retention_id, receipt.revision)
        .unwrap();
    assert_eq!(released.state, RetentionReceiptStateV1::Released);
    assert!(service.retire_owner(&scope, &lease).is_err());
    let ack = RetentionConsumeAckV1 {
        retention_id: released.retention_id.clone(),
        terminal_revision: released.revision,
        client_ack_id: "consume-owner".into(),
    };
    assert_eq!(
        service.consume(&scope, &ack, &NoAcceptedTurnProof).unwrap(),
        RetentionConsumeStatusV1::Consumed
    );
    service.retire_owner(&scope, &lease).unwrap();
    assert_eq!(stored_owner(&service, &owner_id).phase, OwnerPhase::Retired);
    assert_eq!(live_charges(&service, reference.epoch), (0, 0, 0, 0, 1, 0));
    for (area, quarantine) in [
        (service.store.data().unwrap(), format!("q-owner-{owner_id}")),
        (
            service.store.leases().unwrap(),
            format!("q-lease-{owner_id}"),
        ),
    ] {
        assert_missing_child(&area, &owner_id);
        assert_missing_child(&area, &quarantine);
    }
    service.retire_owner(&scope, &lease).unwrap();
    drop(lease);
    let reopened = RetentionService::open(&temp.path().join("account"), true, limits).unwrap();
    assert!(reopened.resume_owner_retirement(&scope, &owner_id).unwrap());
    assert_eq!(live_charges(&reopened, reference.epoch), (0, 0, 0, 0, 1, 0));
    let result = reopened
        .read(
            &scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: receipt.retention_id,
            },
        )
        .unwrap();
    assert_eq!(
        result.receipt.unwrap().state,
        RetentionReceiptStateV1::Consumed
    );
    let next = reopened.create_owner(&scope).unwrap();
    let next_ref = upload(&reopened, &scope, &next, "new-upload");
    assert_ne!(next_ref.entry_id, reference.entry_id);
    assert_eq!(next_ref.epoch, reference.epoch);
    assert_eq!(
        reopened.store.transaction().unwrap().state.retired_through,
        0
    );
}

#[test]
fn retention_owner_live_lease_busy_and_foreign_scope_never_claim() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    service
        .store
        .data()
        .unwrap()
        .inject_pre_sync_failure_once()
        .unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(
        &service,
        &lease.id,
        RemovalPhase::RenamePending,
        RemovalPhase::RenamePending,
    );
    let before = live_charges(&service, 1);
    assert!(!service.resume_owner_retirement(&scope, &lease.id).unwrap());
    let mut context = scope.context.clone();
    context.device_id = "another-device".into();
    let foreign = service.scope(&context, &scope.workspace_identity).unwrap();
    assert!(
        service
            .resume_owner_retirement(&foreign, &lease.id)
            .is_err()
    );
    assert_eq!(live_charges(&service, 1), before);
    let data = service.store.data().unwrap();
    let quarantine = data
        .open_child(OsStr::new(&format!("q-owner-{}", lease.id)), false)
        .unwrap();
    quarantine.open_regular_file(OsStr::new("marker")).unwrap();
    let id = lease.id.clone();
    drop(lease);
    assert!(service.resume_owner_retirement(&scope, &id).unwrap());
    assert_eq!(live_charges(&service, 1), (0, 0, 0, 0, 1, 0));
}

#[test]
fn retention_owner_allocating_upload_cancel_is_exact_and_old_id_not_reallocated() {
    let limits = Limits {
        entries: 1,
        receipt_slots: 1,
        entry_bytes: 32,
        owner_bytes: 32,
        staged_bytes: 32,
        ..Limits::default()
    };
    let (temp, service, scope) = fixture(limits.clone());
    let lease = service.create_owner(&scope).unwrap();
    let original = service
        .allocate_upload(&scope, &lease, "stable-cancel", 2, &digest(b"ab"))
        .unwrap();
    assert!(
        service
            .allocate_upload(&scope, &lease, "new-upload", 2, &digest(b"ab"))
            .is_err()
    );
    service
        .cancel_unstarted_upload(&scope, &lease, &original.id)
        .unwrap();
    service
        .cancel_unstarted_upload(&scope, &lease, &original.id)
        .unwrap();
    assert_eq!(live_charges(&service, original.epoch), (1, 0, 0, 0, 0, 1));
    let id = lease.id.clone();
    drop(lease);
    let reopened = RetentionService::open(&temp.path().join("account"), true, limits).unwrap();
    let lease = reopened.recover_owner(&scope, &id).unwrap().unwrap();
    let retry = reopened
        .allocate_upload(&scope, &lease, "stable-cancel", 2, &digest(b"ab"))
        .unwrap();
    assert_eq!(retry.id, original.id);
    assert_eq!(retry.phase, EntryPhase::Cancelled);
    assert!(
        reopened
            .seal_bytes(&scope, &lease, &retry.id, b"ab")
            .is_err()
    );
    assert!(
        reopened
            .allocate_upload(&scope, &lease, "stable-cancel", 2, &digest(b"cd"))
            .is_err()
    );
    let next = reopened
        .allocate_upload(&scope, &lease, "new-upload", 2, &digest(b"ab"))
        .unwrap();
    assert_ne!(next.id, original.id);
    assert_eq!(live_charges(&reopened, next.epoch), (1, 1, 1, 2, 0, 2));
}

#[test]
fn retention_owner_cancel_refuses_unknown_leaf_and_published_stage() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let entry = service
        .allocate_upload(&scope, &lease, "allocating", 2, &digest(b"ab"))
        .unwrap();
    let data = service
        .owner_data(&stored_owner(&service, &lease.id))
        .unwrap();
    let unexpected = data.open_child(OsStr::new(&entry.id), true).unwrap();
    unexpected
        .atomic_replace(OsStr::new("unregistered"), b"do not delete")
        .unwrap();
    let before = live_charges(&service, entry.epoch);
    assert!(
        service
            .cancel_unstarted_upload(&scope, &lease, &entry.id)
            .is_err()
    );
    assert_eq!(live_charges(&service, entry.epoch), before);
    unexpected
        .open_regular_file(OsStr::new("unregistered"))
        .unwrap();
    let published = upload(&service, &scope, &lease, "published");
    let before = live_charges(&service, published.epoch);
    assert!(
        service
            .cancel_unstarted_upload(&scope, &lease, &published.entry_id)
            .is_err()
    );
    assert!(service.retire_owner(&scope, &lease).is_err());
    assert_eq!(live_charges(&service, published.epoch), before);
    assert_eq!(stored_owner(&service, &lease.id).phase, OwnerPhase::Active);
}

#[test]
fn retention_owner_allocating_owner_cancel_after_redo_refunds_once() {
    let limits = Limits {
        owners: 1,
        ..Limits::default()
    };
    let (temp, service, scope) = fixture(limits.clone());
    // Replay the actual initializer reservation journal. No fixture invents a
    // missing physical directory as evidence for an already-active owner.
    let owner = durable_allocating_owner(&service, &scope);
    assert_missing_child(&service.store.data().unwrap(), &owner.id);
    assert_missing_child(&service.store.leases().unwrap(), &owner.id);
    storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
    let error = service
        .cancel_owner_without_leaves(&scope, &owner.id)
        .err()
        .unwrap();
    assert!(
        error
            .to_string()
            .contains("after durable retention journal")
    );
    let reopened = RetentionService::open(&temp.path().join("account"), true, limits).unwrap();
    reopened
        .cancel_owner_without_leaves(&scope, &owner.id)
        .unwrap();
    assert_eq!(
        stored_owner(&reopened, &owner.id).phase,
        OwnerPhase::Cancelled
    );
    assert_eq!(live_charges(&reopened, owner.epoch), (0, 0, 0, 0, 1, 0));
    assert!(reopened.recover_owner(&scope, &owner.id).is_err());
    reopened.create_owner(&scope).unwrap();
    assert_missing_child(&reopened.store.data().unwrap(), &owner.id);
    assert_missing_child(&reopened.store.leases().unwrap(), &owner.id);
}

#[test]
fn retention_owner_partial_initializer_windows_stay_unknown_and_charged() {
    // Diagnostic negative controls for the uncovered initializer recovery gap.
    // These reproduce process-stop windows with real durable private objects;
    // they do not claim that the initializer was killed or that recovery works.
    for window in [
        "lease-directory",
        "lock-leaf",
        "data-directory",
        "marker-leaf",
        "foreign-marker",
    ] {
        let limits = Limits {
            owners: 1,
            ..Limits::default()
        };
        let (temp, service, scope) = fixture(limits.clone());
        let owner = durable_allocating_owner(&service, &scope);
        let lease_dir = service
            .store
            .leases()
            .unwrap()
            .open_child(OsStr::new(&owner.id), true)
            .unwrap();
        let lease_identity = lease_dir.retention_identity().unwrap();
        if window != "lease-directory" {
            lease_dir
                .open_read_write_file(OsStr::new("lock"), true)
                .unwrap();
            lease_dir.sync().unwrap();
        }
        let data_identity = if matches!(window, "data-directory" | "marker-leaf" | "foreign-marker")
        {
            let data = service
                .store
                .data()
                .unwrap()
                .open_child(OsStr::new(&owner.id), true)
                .unwrap();
            if matches!(window, "marker-leaf" | "foreign-marker") {
                data.atomic_replace(
                    OsStr::new("marker"),
                    if window == "foreign-marker" {
                        b"another-owner".to_vec()
                    } else {
                        format!("{}:{}:{}", service.namespace(), owner.id, scope.hash).into_bytes()
                    }
                    .as_slice(),
                )
                .unwrap();
            }
            Some(data.retention_identity().unwrap())
        } else {
            None
        };
        let reopened = RetentionService::open(&temp.path().join("account"), true, limits).unwrap();
        assert!(
            reopened.recover_owner(&scope, &owner.id).is_err(),
            "{window}"
        );
        assert!(
            reopened
                .cancel_owner_without_leaves(&scope, &owner.id)
                .is_err(),
            "{window}"
        );
        assert_eq!(
            stored_owner(&reopened, &owner.id).phase,
            OwnerPhase::Allocating,
            "{window}"
        );
        assert_eq!(
            live_charges(&reopened, owner.epoch),
            (1, 0, 0, 0, 0, 1),
            "{window}"
        );
        assert!(reopened.create_owner(&scope).is_err(), "{window}");
        let unchanged_lease = reopened
            .store
            .leases()
            .unwrap()
            .open_verified_child(OsStr::new(&owner.id), &lease_identity)
            .unwrap();
        if window != "lease-directory" {
            unchanged_lease
                .open_regular_file(OsStr::new("lock"))
                .unwrap();
        }
        if let Some(identity) = data_identity {
            let unchanged_data = reopened
                .store
                .data()
                .unwrap()
                .open_verified_child(OsStr::new(&owner.id), &identity)
                .unwrap();
            if matches!(window, "marker-leaf" | "foreign-marker") {
                unchanged_data
                    .open_regular_file(OsStr::new("marker"))
                    .unwrap();
            }
        }
    }
}

#[test]
fn retention_owner_marker_identity_replacement_is_not_retirement_proof() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let owner = stored_owner(&service, &lease.id);
    let data = service.owner_data(&owner).unwrap();
    data.atomic_replace(
        OsStr::new("marker"),
        format!("{}:{}:{}", service.namespace(), owner.id, scope.hash).as_bytes(),
    )
    .unwrap();
    let replacement = data
        .retention_regular_identity(OsStr::new("marker"))
        .unwrap();
    assert_ne!(Some(&replacement), owner.marker_identity.as_ref());
    assert!(service.retire_owner(&scope, &lease).is_err());
    assert_retirement_phase(
        &service,
        &owner.id,
        RemovalPhase::RenamePending,
        RemovalPhase::RenamePending,
    );
    assert_eq!(live_charges(&service, owner.epoch), (1, 0, 0, 0, 1, 1));
    data.open_verified_regular(OsStr::new("marker"), &replacement)
        .unwrap();
    assert_missing_child(
        &service.store.data().unwrap(),
        &format!("q-owner-{}", owner.id),
    );
}

#[test]
fn retention_owner_unknown_child_and_proof_budget_block_before_refund() {
    let limits = Limits {
        owner_proofs: 1,
        ..Limits::default()
    };
    let (_temp, service, scope) = fixture(limits);
    let first = service.create_owner(&scope).unwrap();
    let data = service
        .owner_data(&stored_owner(&service, &first.id))
        .unwrap();
    data.atomic_replace(OsStr::new("unknown"), b"preserve")
        .unwrap();
    assert!(service.retire_owner(&scope, &first).is_err());
    let owner = stored_owner(&service, &first.id);
    assert_eq!(owner.phase, OwnerPhase::Retiring);
    assert_eq!(owner.retirement.unwrap().data, RemovalPhase::Quarantined);
    let quarantine = service
        .store
        .data()
        .unwrap()
        .open_child(OsStr::new(&format!("q-owner-{}", first.id)), false)
        .unwrap();
    // The exact manifest is validated before ANY unlink: both leaves survive.
    quarantine.open_regular_file(OsStr::new("marker")).unwrap();
    quarantine.open_regular_file(OsStr::new("unknown")).unwrap();
    assert_eq!(live_charges(&service, 1), (1, 0, 0, 0, 1, 1));
    let second = service.create_owner(&scope).unwrap();
    let before = live_charges(&service, 1);
    assert!(service.retire_owner(&scope, &second).is_err());
    assert_eq!(stored_owner(&service, &second.id).phase, OwnerPhase::Active);
    assert_eq!(live_charges(&service, 1), before);
    service
        .owner_data(&stored_owner(&service, &second.id))
        .unwrap();
    assert_missing_child(
        &service.store.data().unwrap(),
        &format!("q-owner-{}", second.id),
    );
}

#[test]
fn retention_owner_fsync_failures_then_redo_retirement_never_double_refund() {
    let (temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let id = lease.id.clone();
    let original = stored_owner(&service, &id);
    let data = service.store.data().unwrap();
    data.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(
        &service,
        &id,
        RemovalPhase::RenamePending,
        RemovalPhase::RenamePending,
    );
    let qdata = data
        .open_verified_child(
            OsStr::new(&format!("q-owner-{id}")),
            original.data_identity.as_ref().unwrap(),
        )
        .unwrap();
    qdata
        .open_verified_regular(
            OsStr::new("marker"),
            original.marker_identity.as_ref().unwrap(),
        )
        .unwrap();
    data.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(
        &service,
        &id,
        RemovalPhase::RenamePending,
        RemovalPhase::RenamePending,
    );
    qdata.open_regular_file(OsStr::new("marker")).unwrap();
    qdata.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(
        &service,
        &id,
        RemovalPhase::Quarantined,
        RemovalPhase::RenamePending,
    );
    assert!(missing(
        &qdata.open_regular_file(OsStr::new("marker")).err().unwrap()
    ));
    qdata.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(
        &service,
        &id,
        RemovalPhase::Quarantined,
        RemovalPhase::RenamePending,
    );
    let leases = service.store.leases().unwrap();
    leases.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(
        &service,
        &id,
        RemovalPhase::Gone,
        RemovalPhase::RenamePending,
    );
    let qlease = leases
        .open_verified_child(
            OsStr::new(&format!("q-lease-{id}")),
            original.lease_directory_identity.as_ref().unwrap(),
        )
        .unwrap();
    qlease
        .open_verified_regular(
            OsStr::new("lock"),
            original.lease_identity.as_ref().unwrap(),
        )
        .unwrap();
    qlease.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(&service, &id, RemovalPhase::Gone, RemovalPhase::Quarantined);
    assert!(missing(
        &qlease.open_regular_file(OsStr::new("lock")).err().unwrap()
    ));
    qlease.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(&service, &id, RemovalPhase::Gone, RemovalPhase::Quarantined);
    leases.inject_pre_sync_failure_once().unwrap();
    expect_sync_eio(service.retire_owner(&scope, &lease));
    assert_retirement_phase(&service, &id, RemovalPhase::Gone, RemovalPhase::LeavesGone);
    assert_missing_child(&leases, &format!("q-lease-{id}"));
    assert_eq!(live_charges(&service, 1), (1, 0, 0, 0, 1, 1));
    // At this exact physical terminal phase the next journal is the final
    // Retired+quota refund transaction, rather than the first Retiring journal.
    storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
    let error = service.retire_owner(&scope, &lease).err().unwrap();
    assert!(
        error
            .to_string()
            .contains("after durable retention journal")
    );
    drop(lease);
    let reopened =
        RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    assert_eq!(stored_owner(&reopened, &id).phase, OwnerPhase::Retired);
    assert_eq!(live_charges(&reopened, 1), (0, 0, 0, 0, 1, 0));
    for _ in 0..2 {
        assert!(reopened.resume_owner_retirement(&scope, &id).unwrap());
        assert_eq!(live_charges(&reopened, 1), (0, 0, 0, 0, 1, 0));
    }
}
