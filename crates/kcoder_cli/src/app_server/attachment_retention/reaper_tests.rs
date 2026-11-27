//! Real catalog/cursor recovery contracts. No Provider or epoch collection.
use super::*;

fn fixture() -> (tempfile::TempDir, RetentionService, Scope) {
    let base = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../..")
        .canonicalize()
        .unwrap()
        .join("target/test/crates/kcoder_cli/retention-reaper");
    PrivateDirectory::open_or_create(&base).unwrap();
    let temp = tempfile::Builder::new()
        .prefix("reaper-")
        .tempdir_in(base)
        .unwrap();
    let account = temp.path().join("account");
    PrivateDirectory::open_or_create(&account).unwrap();
    let service = RetentionService::open(&account, true, Limits::default()).unwrap();
    let scope = service
        .full_scope(
            &TrustedRetentionContextV1 {
                gateway_namespace_id: "gateway".into(),
                device_id: "device".into(),
                authorization_generation: "1".into(),
                target_fingerprint: "target".into(),
                principal: RetentionPrincipalV1::LocalOs,
            },
            &digest(b"workspace"),
            None,
            "registered-target",
        )
        .unwrap();
    (temp, service, scope)
}

#[test]
fn reaper_catalog_window_is_bounded_and_cursor_survives_reopen() {
    let (temp, service, scope) = fixture();
    let mut leases = Vec::new();
    for _ in 0..40 {
        leases.push(service.create_owner(&scope).unwrap());
    }
    let first = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(first.records_read, 32);
    assert_eq!(first.page_reads, 1);
    assert_eq!(
        first.candidates.len(),
        0,
        "active owners are not cleanup intents"
    );
    let before = service.store.transaction().unwrap().state.reaper_cursors;
    drop(service);
    let service =
        RetentionService::open(&temp.path().join("account"), true, Limits::default()).unwrap();
    assert_eq!(
        service.store.transaction().unwrap().state.reaper_cursors,
        before
    );
    let second = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(second.records_read, 8);
    assert_eq!(second.page_reads, 1);
    let third = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(
        third.records_read, 32,
        "scan wraps without a TTL or ID replacement"
    );
    assert_eq!(
        service.store.transaction().unwrap().state.retired_through,
        0
    );
}

#[test]
fn reaper_namespace_busy_does_not_advance_cursor() {
    let (_temp, service, scope) = fixture();
    let _lease = service.create_owner(&scope).unwrap();
    let tx = service.store.transaction().unwrap();
    let before = tx.state.reaper_cursors.clone();
    let error = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .err()
        .unwrap();
    assert!(format!("{error:#}").contains("metadata busy"));
    drop(tx);
    assert_eq!(
        service.store.transaction().unwrap().state.reaper_cursors,
        before
    );
}

fn enter_retirement(service: &RetentionService, scope: &Scope, lease: &OwnerLease) {
    storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
    let error = service.retire_owner(scope, lease).unwrap_err();
    assert!(format!("{error:#}").contains("after durable retention journal"));
    let owner: Owner = service
        .store
        .transaction()
        .unwrap()
        .read(Area::Owners, &lease.id)
        .unwrap()
        .unwrap();
    assert_eq!(owner.phase, OwnerPhase::Retiring);
}

#[test]
fn reaper_same_page_busy_owner_does_not_starve_next_retirement() {
    let (_temp, service, scope) = fixture();
    let first = service.create_owner(&scope).unwrap();
    let second = service.create_owner(&scope).unwrap();
    enter_retirement(&service, &scope, &first);
    enter_retirement(&service, &scope, &second);
    let second_id = second.id.clone();
    drop(second);
    storage::REAPER_FULL_SCANS.with(|count| count.set(0));
    storage::REAPER_RECORD_READS.with(|count| count.set(0));
    let window = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(window.records_read, 1);
    assert_eq!(
        service
            .reaper_resume_owner(
                &window.candidates[0],
                &scope.workspace_identity,
                &scope.context.principal
            )
            .unwrap(),
        Some(false)
    );
    let window = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(window.records_read, 1);
    assert_eq!(
        service
            .reaper_resume_owner(
                &window.candidates[0],
                &scope.workspace_identity,
                &scope.context.principal
            )
            .unwrap(),
        Some(true)
    );
    storage::REAPER_FULL_SCANS.with(|count| assert_eq!(count.get(), 0));
    storage::REAPER_RECORD_READS
        .with(|count| assert!(count.get() < 256, "bounded metadata IO: {}", count.get()));
    let tx = service.store.transaction().unwrap();
    assert_eq!(
        tx.read::<Owner>(Area::Owners, &first.id)
            .unwrap()
            .unwrap()
            .phase,
        OwnerPhase::Retiring
    );
    assert_eq!(
        tx.read::<Owner>(Area::Owners, &second_id)
            .unwrap()
            .unwrap()
            .phase,
        OwnerPhase::Retired
    );
    assert_eq!(tx.state.charges.owners, 1);
    assert_eq!(tx.state.retired_through, 0);
}

#[test]
fn reaper_old_state_defaults_but_bad_cursor_is_rejected_without_writes() {
    let (_temp, service, scope) = fixture();
    let _lease = service.create_owner(&scope).unwrap();
    let mut tx = service.store.transaction().unwrap();
    let original = serde_json::to_value(&tx.state).unwrap();
    assert!(original.get("reaper_cursors").is_none());
    let old: State = serde_json::from_value(original.clone()).unwrap();
    old.validate(&service.store.header).unwrap();
    assert!(old.reaper_cursors.is_empty());
    tx.state.reaper_cursors.insert(
        digest(b"partition"),
        ReaperCursor {
            epoch: 1,
            next_record: 2,
            last_used: 0,
        },
    );
    assert!(tx.commit().is_err());
    let tx = service.store.transaction().unwrap();
    assert_eq!(serde_json::to_value(&tx.state).unwrap(), original);
}

#[test]
fn reaper_missing_page_wraps_without_refund_and_other_page_still_progresses() {
    let (_temp, service, scope) = fixture();
    let mut leases = Vec::new();
    for _ in 0..40 {
        leases.push(service.create_owner(&scope).unwrap());
    }
    let last = leases.pop().unwrap();
    let id = last.id.clone();
    enter_retirement(&service, &scope, &last);
    drop(last);
    let before = service.store.transaction().unwrap().state.charges.clone();
    // Simulate loss without changing accounting or the authoritative record count.
    service
        .store
        .testing_area(Area::Index)
        .unwrap()
        .remove_regular_file(OsStr::new(&storage::leaf("1:0")))
        .unwrap();
    let window = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(window.unknown, 1);
    assert!(window.candidates.is_empty());
    let after = service.store.transaction().unwrap().state.charges.clone();
    assert_eq!(
        serde_json::to_value(&before).unwrap(),
        serde_json::to_value(&after).unwrap()
    );
    let window = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert_eq!(window.records_read, 8);
    assert_eq!(
        service
            .reaper_resume_owner(
                &window.candidates[0],
                &scope.workspace_identity,
                &scope.context.principal
            )
            .unwrap(),
        Some(true)
    );
    assert_eq!(
        service
            .store
            .transaction()
            .unwrap()
            .read::<Owner>(Area::Owners, &id)
            .unwrap()
            .unwrap()
            .phase,
        OwnerPhase::Retired
    );
    assert_eq!(
        service
            .reaper_window(&scope.workspace_identity, &scope.context.principal)
            .unwrap()
            .unknown,
        1
    );
}

#[test]
fn reaper_cursor_partitions_remain_bounded_and_foreign_workspace_cannot_resume() {
    let (_temp, service, scope) = fixture();
    let lease = service.create_owner(&scope).unwrap();
    enter_retirement(&service, &scope, &lease);
    let window = service
        .reaper_window(&scope.workspace_identity, &scope.context.principal)
        .unwrap();
    assert!(
        service
            .reaper_resume_owner(
                &window.candidates[0],
                &digest(b"foreign"),
                &scope.context.principal
            )
            .is_err()
    );
    for i in 0..40 {
        let window = service
            .reaper_window(
                &digest(format!("workspace-{i}").as_bytes()),
                &scope.context.principal,
            )
            .unwrap();
        assert!(window.candidates.is_empty());
    }
    let tx = service.store.transaction().unwrap();
    assert_eq!(tx.state.reaper_cursors.len(), 32);
    assert_eq!(
        tx.read::<Owner>(Area::Owners, &lease.id)
            .unwrap()
            .unwrap()
            .phase,
        OwnerPhase::Retiring
    );
}

#[test]
fn reaper_discovery_does_not_authorize_nonretirement_owner_phases() {
    let (_temp, service, scope) = fixture();
    let lease = service.create_owner(&scope).unwrap();
    for phase in [OwnerPhase::Quarantined, OwnerPhase::PayloadGone] {
        // Corrupt/unsupported top-level phases must not acquire retirement authority.
        let mut tx = service.store.transaction().unwrap();
        let mut owner = service.owner(&tx, &scope, &lease.id).unwrap();
        owner.phase = phase;
        tx.put(Area::Owners, &owner.id, owner.epoch, &owner)
            .unwrap();
        tx.commit().unwrap();
        let before = service.store.transaction().unwrap().state.charges.clone();
        let window = service
            .reaper_window(&scope.workspace_identity, &scope.context.principal)
            .unwrap();
        assert!(
            window.candidates.is_empty(),
            "unsupported phase selected: {phase:?}"
        );
        let tx = service.store.transaction().unwrap();
        assert_eq!(service.owner(&tx, &scope, &lease.id).unwrap().phase, phase);
        assert_eq!(
            serde_json::to_value(before).unwrap(),
            serde_json::to_value(&tx.state.charges).unwrap()
        );
    }
}
