//! Real local filesystem + independently killed child processes. These tests
//! prove process-crash recovery, not power-loss durability or trusted RPC wiring.
use super::super::owner_init::{manifest_name, manifest_quarantine};
use super::*;
use std::collections::BTreeMap;

pub(super) fn request(id: &str) -> RetentionOwnerRequestV1 {
    RetentionOwnerRequestV1 {
        client_owner_request_id: id.into(),
        immutable_parameters: BTreeMap::from([("purpose".into(), "staged-attachments".into())]),
    }
}
fn terminal(
    service: &RetentionService,
    scope: &Scope,
    request: &RetentionOwnerRequestV1,
) -> Result<owner_init::OwnerCreation> {
    service
        .read_owner_request(scope, request)?
        .context("stable owner record missing")
}
fn assert_no_owner_manifest(service: &RetentionService, id: &str) {
    let parent = service.store.leases().unwrap();
    assert_missing_regular(&parent, &manifest_name(id));
    assert_missing_regular(&parent, &manifest_quarantine(id));
}

#[test]
fn retention_owner_v2_sigkill_before_publication_cancels_once_and_preserves_request() -> Result<()>
{
    for step in ["v2-reserved", "v2-anonymous-sealed", "v2-publishing"] {
        let (temp, scope, id) = start_and_kill_init_at(step)?;
        let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
        assert_no_owner_manifest(&service, &id);
        let read = terminal(&service, &scope, &request("crash-owner"))?;
        assert_eq!(read.id, id);
        assert_eq!(read.phase, OwnerPhase::Cancelled, "{step}");
        assert!(read.lease.is_none());
        let old = stored_owner(&service, &id)?;
        let charges = owner_charge_state(&service, old.epoch)?;
        assert_eq!(charges, (0, 0, 1));
        for _ in 0..2 {
            let replay = service.create_owner_with_request(&scope, &request("crash-owner"))?;
            assert_eq!(replay.id, id);
            assert_eq!(replay.phase, OwnerPhase::Cancelled);
        }
        assert_eq!(owner_charge_state(&service, old.epoch)?, charges);
        let next = service.create_owner_with_request(&scope, &request("explicit-new-owner"))?;
        assert_eq!(next.phase, OwnerPhase::Active);
        assert_ne!(next.id, id);
        assert!(next.lease.is_some());
        assert_eq!(
            service
                .store
                .leases()?
                .count_regular_files_bounded(|_| true, 3)?,
            1
        );
    }
    Ok(())
}

#[test]
fn retention_owner_v2_sigkill_linked_recovers_exact_owner_without_duplicate_charge() -> Result<()> {
    for step in [
        "v2-linked",
        "v2-parent-synced",
        "v2-active-journal",
        "v2-active",
    ] {
        let (temp, scope, id) = start_and_kill_init_at(step)?;
        let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
        let row = stored_owner(&service, &id)?;
        let native = row.lease_identity.clone();
        let restored = terminal(&service, &scope, &request("crash-owner"))?;
        assert_eq!(restored.phase, OwnerPhase::Active, "{step}");
        let lease = restored.lease.context("recovered lease required")?;
        assert_eq!(Some(lease.lease.identity().clone()), native);
        assert_eq!(owner_charge_state(&service, row.epoch)?, (1, 1, 0));
        let busy = terminal(&service, &scope, &request("crash-owner"))?;
        assert_eq!(busy.id, id);
        assert!(busy.lease.is_none(), "must not steal live owner's lock");
        assert!(
            service
                .create_owner_with_request(&scope, &request("other-owner"))
                .is_err()
        );
        drop(lease);
        assert!(
            terminal(&service, &scope, &request("crash-owner"))?
                .lease
                .is_some()
        );
        assert_eq!(
            service
                .store
                .leases()?
                .count_regular_files_bounded(|_| true, 2)?,
            1
        );
    }
    Ok(())
}

#[test]
fn retention_owner_v2_foreign_final_or_quarantine_never_deleted_or_refunded() -> Result<()> {
    for quarantine in [false, true] {
        let (temp, scope, id) = start_and_kill_init_at("v2-publishing")?;
        let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
        let parent = service.store.leases()?;
        let name = if quarantine {
            manifest_quarantine(&id)
        } else {
            manifest_name(&id)
        };
        parent.atomic_replace(OsStr::new(&name), b"foreign immutable sentinel")?;
        let native = parent.retention_regular_identity(OsStr::new(&name))?;
        assert!(
            service
                .read_owner_request(&scope, &request("crash-owner"))
                .is_err()
        );
        assert_eq!(
            parent.retention_regular_identity(OsStr::new(&name))?,
            native
        );
        let mut bytes = Vec::new();
        parent
            .open_regular_file(OsStr::new(&name))?
            .read_to_end(&mut bytes)?;
        assert_eq!(bytes, b"foreign immutable sentinel");
        let row = stored_owner(&service, &id)?;
        assert_eq!(owner_charge_state(&service, row.epoch)?, (1, 1, 0));
        assert!(service.cancel_owner_without_leaves(&scope, &id).is_err());
        assert!(
            service
                .create_owner_with_request(&scope, &request("other-owner"))
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn retention_owner_v2_parameters_scope_and_missing_registered_row_fail_closed() -> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let first = service.create_owner_with_request(&scope, &request("stable"))?;
    let original = first.id.clone();
    let mut conflict = request("stable");
    conflict
        .immutable_parameters
        .insert("purpose".into(), "different".into());
    assert!(
        service
            .create_owner_with_request(&scope, &conflict)
            .is_err()
    );
    let mut foreign = scope.clone();
    foreign.context.device_id = "foreign-device".into();
    foreign = service.scope(&foreign.context, &foreign.workspace_identity)?;
    assert!(
        service
            .read_owner_request(&foreign, &request("stable"))?
            .is_none()
    );
    assert!(service.recover_owner(&foreign, &original).is_err());
    drop(first);
    let mut tx = service.store.transaction()?;
    tx.delete_record_for_test(Area::Owners, &original)?;
    tx.commit()?;
    assert!(
        service
            .read_owner_request(&scope, &request("stable"))
            .is_err()
    );
    assert!(
        service
            .create_owner_with_request(&scope, &request("stable"))
            .is_err()
    );
    service
        .store
        .leases()?
        .open_regular_file(OsStr::new(&manifest_name(&original)))?;
    Ok(())
}

#[test]
fn retention_owner_v2_sigkill_retirement_each_phase_preserves_tombstone_and_refunds_once()
-> Result<()> {
    for step in [
        "v2-retire-reserved",
        "v2-retire-rename-visible",
        "v2-retire-renamed",
        "v2-retire-quarantined",
        "v2-retire-unlink-visible",
        "v2-retire-unlinked",
        "v2-retire-gone",
    ] {
        let (temp, scope, id) = start_and_kill_init_at(step)?;
        let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
        assert!(service.resume_owner_retirement(&scope, &id)?, "{step}");
        assert_no_owner_manifest(&service, &id);
        let row = stored_owner(&service, &id)?;
        assert_eq!(row.phase, OwnerPhase::Retired);
        let charges = owner_charge_state(&service, row.epoch)?;
        assert_eq!(charges, (0, 0, 1));
        assert!(service.resume_owner_retirement(&scope, &id)?);
        let replay = service.create_owner_with_request(&scope, &request("crash-owner"))?;
        assert_eq!(replay.id, id);
        assert_eq!(replay.phase, OwnerPhase::Retired);
        assert!(replay.lease.is_none());
        assert_eq!(owner_charge_state(&service, row.epoch)?, charges);
        assert!(
            service
                .create_owner_with_request(&scope, &request("next"))?
                .lease
                .is_some()
        );
    }
    Ok(())
}

#[test]
fn retention_owner_v2_retire_preserves_shared_roots_and_all_other_manifest_siblings() -> Result<()>
{
    let (_temp, service, scope) = fixture(Limits::default());
    let mut owners = Vec::new();
    for n in 0..64 {
        owners.push(service.create_owner_with_request(&scope, &request(&format!("owner-{n}")))?);
    }
    let parent = service.store.leases()?;
    parent.atomic_replace(OsStr::new("foreign-sibling"), b"do not remove")?;
    let foreign = parent.retention_regular_identity(OsStr::new("foreign-sibling"))?;
    let data_identity = service.store.data()?.retention_identity()?;
    let lease_identity = parent.retention_identity()?;
    let first = owners.remove(0);
    service.retire_owner(&scope, first.lease.as_ref().context("first lease")?)?;
    for other in &owners {
        let row = stored_owner(&service, &other.id)?;
        service.verified_owner_manifest(&row, &manifest_name(&other.id))?;
        assert_eq!(
            row.lease_identity.as_ref(),
            Some(other.lease.as_ref().unwrap().lease.identity())
        );
    }
    assert_eq!(
        parent.retention_regular_identity(OsStr::new("foreign-sibling"))?,
        foreign
    );
    assert_eq!(service.store.data()?.retention_identity()?, data_identity);
    assert_eq!(parent.retention_identity()?, lease_identity);
    assert_eq!(parent.count_regular_files_bounded(|_| true, 65)?, 64);
    Ok(())
}

#[test]
fn retention_owner_v2_manifest_content_or_permission_change_blocks_recovery_and_retirement()
-> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let created = service.create_owner_with_request(&scope, &request("owner"))?;
    let id = created.id.clone();
    drop(created);
    let parent = service.store.leases()?;
    let name = manifest_name(&id);
    let original = parent.retention_regular_identity(OsStr::new(&name))?;
    let mut file = parent.open_read_write_file(OsStr::new(&name), false)?;
    use std::io::Write;
    file.write_all(b"tamper")?;
    file.sync_all()?;
    assert_eq!(
        parent.retention_regular_identity(OsStr::new(&name))?,
        original
    );
    assert!(service.recover_owner(&scope, &id).is_err());
    assert!(service.cancel_owner_without_leaves(&scope, &id).is_err());
    assert_eq!(service.store.transaction()?.state.charges.owners, 1);
    Ok(())
}

#[test]
fn retention_owner_v2_release_consume_retire_restores_capacity_but_not_old_id() -> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let created = service.create_owner_with_request(&scope, &request("owner"))?;
    let lease = created.lease.as_ref().unwrap();
    let reference = upload(&service, &scope, lease, "upload-a");
    let receipt = reserve(&service, &scope, reference);
    let released =
        service.release_original_owner(&scope, lease, &receipt.retention_id, receipt.revision)?;
    let ack = RetentionConsumeAckV1 {
        retention_id: receipt.retention_id,
        terminal_revision: released.revision,
        client_ack_id: "consume-a".into(),
    };
    service.consume(&scope, &ack, &NoAcceptedTurnProof)?;
    service.retire_owner(&scope, lease)?;
    let replay = service.create_owner_with_request(&scope, &request("owner"))?;
    assert_eq!(replay.id, created.id);
    assert_eq!(replay.phase, OwnerPhase::Retired);
    assert!(
        service
            .create_owner_with_request(&scope, &request("owner-b"))?
            .lease
            .is_some()
    );
    Ok(())
}

#[test]
fn retention_owner_v2_visible_rename_pre_fsync_error_keeps_charge_then_recovers_once() -> Result<()>
{
    let (temp, service, scope) = fixture(owner_limit());
    let created = service.create_owner_with_request(&scope, &request("owner"))?;
    let lease = created.lease.as_ref().unwrap();
    let parent = service.store.leases()?;
    parent.inject_pre_sync_failure_once()?;
    let error = service
        .retire_owner(&scope, lease)
        .err()
        .context("rename fsync must fail")?;
    assert!(
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(libc::EIO))
    );
    assert_missing_regular(&parent, &manifest_name(&created.id));
    parent.open_verified_regular(
        OsStr::new(&manifest_quarantine(&created.id)),
        lease.lease.identity(),
    )?;
    let owner = stored_owner(&service, &created.id)?;
    assert_eq!(owner.manifest_retirement, Some(RemovalPhase::RenamePending));
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (1, 1, 1));
    let id = created.id.clone();
    drop(created);
    drop(service);
    let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    assert!(reopened.resume_owner_retirement(&scope, &id)?);
    assert!(reopened.resume_owner_retirement(&scope, &id)?);
    assert_eq!(owner_charge_state(&reopened, owner.epoch)?, (0, 0, 1));
    Ok(())
}

#[test]
fn retention_owner_v2_visible_unlink_pre_fsync_error_requires_durable_quarantine() -> Result<()> {
    let (temp, service, scope) = fixture(owner_limit());
    let created = service.create_owner_with_request(&scope, &request("owner"))?;
    let lease = created.lease.as_ref().unwrap();
    let mut tx = service.store.transaction()?;
    let mut owner: Owner = tx.read(Area::Owners, &created.id)?.unwrap();
    owner.phase = OwnerPhase::Retiring;
    owner.manifest_retirement = Some(RemovalPhase::RenamePending);
    tx.state.charges.owner_proofs += 1;
    tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
    tx.checkpoint_keep_lock()?;
    let parent = service.store.leases()?;
    parent.quarantine_verified_entry(
        OsStr::new(&manifest_name(&owner.id)),
        lease.lease.identity(),
        OsStr::new(&manifest_quarantine(&owner.id)),
    )?;
    owner.manifest_retirement = Some(RemovalPhase::Quarantined);
    tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
    tx.commit()?;
    parent.inject_pre_sync_failure_once()?;
    let error = service
        .retire_owner(&scope, lease)
        .err()
        .context("unlink fsync must fail")?;
    assert!(
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(libc::EIO))
    );
    assert_no_owner_manifest(&service, &owner.id);
    assert_eq!(
        stored_owner(&service, &owner.id)?.manifest_retirement,
        Some(RemovalPhase::Quarantined)
    );
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (1, 1, 1));
    drop(created);
    drop(service);
    let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    assert!(reopened.resume_owner_retirement(&scope, &owner.id)?);
    assert!(reopened.resume_owner_retirement(&scope, &owner.id)?);
    assert_eq!(owner_charge_state(&reopened, owner.epoch)?, (0, 0, 1));
    Ok(())
}

#[test]
fn retention_owner_v2_missing_manifest_before_quarantine_never_refunds() -> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let created = service.create_owner_with_request(&scope, &request("owner"))?;
    let lease = created.lease.as_ref().unwrap();
    let mut tx = service.store.transaction()?;
    let mut owner: Owner = tx.read(Area::Owners, &created.id)?.unwrap();
    owner.phase = OwnerPhase::Retiring;
    owner.manifest_retirement = Some(RemovalPhase::RenamePending);
    tx.state.charges.owner_proofs += 1;
    tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
    tx.commit()?;
    let parent = service.store.leases()?;
    parent.unlink_verified_regular_leaf_unflushed(
        OsStr::new(&manifest_name(&owner.id)),
        lease.lease.identity(),
    )?;
    parent.sync()?;
    drop(created);
    assert!(service.resume_owner_retirement(&scope, &owner.id).is_err());
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (1, 1, 1));
    assert!(
        service
            .create_owner_with_request(&scope, &request("other"))
            .is_err()
    );
    Ok(())
}

#[test]
fn retention_owner_v2_upgrade_keeps_v1_active_layout_and_retires_without_shared_root_deletion()
-> Result<()> {
    let (temp, service, scope) = fixture(Limits::default());
    let legacy = service.create_owner(&scope)?;
    let mut tx = service.store.transaction()?;
    let original: Owner = tx.read(Area::Owners, &legacy.id)?.unwrap();
    // Exactly the old on-disk shape, not merely layout_version set to 1.
    let mut old_json = serde_json::to_value(&original)?;
    for field in [
        "layout_version",
        "request",
        "manifest",
        "manifest_retirement",
    ] {
        old_json.as_object_mut().unwrap().remove(field);
    }
    let old: Owner = serde_json::from_value(old_json)?;
    assert_eq!(old.layout_version, 1);
    tx.put(Area::Owners, &old.id, old.epoch, &old)?;
    tx.commit()?;
    let current = service.create_owner_with_request(&scope, &request("v2"))?;
    let root = temp.path().join("account/attachment-retention-v1");
    let header: Header = serde_json::from_slice(&std::fs::read(root.join("retention-root.json"))?)?;
    assert_eq!(header.version, 2);
    drop(legacy);
    let recovered = service
        .recover_owner(&scope, &old.id)?
        .context("v1 lease recovery")?;
    service.owner_data(&old)?;
    service.retire_owner(&scope, &recovered)?;
    service.verified_owner_manifest(
        &stored_owner(&service, &current.id)?,
        &manifest_name(&current.id),
    )?;
    service.retire_owner(&scope, current.lease.as_ref().unwrap())?;
    assert_eq!(
        service.store.data()?.retention_identity()?,
        header.areas[&Area::Data]
    );
    Ok(())
}

#[test]
fn retention_owner_v2_request_parameter_order_is_stable_and_tombstone_budget_precedes_effects()
-> Result<()> {
    let (_temp, service, scope) = fixture(Limits {
        tombstones: 1,
        ..owner_limit()
    });
    let a: RetentionOwnerRequestV1 = serde_json::from_str(
        r#"{"clientOwnerRequestId":"same","immutableParameters":{"b":"two","a":"one"}}"#,
    )?;
    let b: RetentionOwnerRequestV1 = serde_json::from_str(
        r#"{"immutableParameters":{"a":"one","b":"two"},"clientOwnerRequestId":"same"}"#,
    )?;
    let first = service.create_owner_with_request(&scope, &a)?;
    let replay = service.create_owner_with_request(&scope, &b)?;
    assert_eq!(first.id, replay.id);
    assert!(replay.lease.is_none());
    let lease = first.lease.as_ref().unwrap();
    service.retire_owner(&scope, lease)?;
    assert_eq!(service.store.transaction()?.state.charges.tombstones, 1);
    assert!(
        service
            .create_owner_with_request(&scope, &request("different"))
            .is_err()
    );
    assert_eq!(
        service
            .store
            .leases()?
            .count_regular_files_bounded(|_| true, 1)?,
        0
    );
    assert_eq!(terminal(&service, &scope, &b)?.phase, OwnerPhase::Retired);
    Ok(())
}

#[test]
fn retention_owner_v2_live_retirement_lease_and_foreign_scope_cannot_be_claimed() -> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let created = service.create_owner_with_request(&scope, &request("owner"))?;
    let mut tx = service.store.transaction()?;
    let mut owner: Owner = tx.read(Area::Owners, &created.id)?.unwrap();
    owner.phase = OwnerPhase::Retiring;
    owner.manifest_retirement = Some(RemovalPhase::RenamePending);
    tx.state.charges.owner_proofs += 1;
    tx.put(Area::Owners, &owner.id, owner.epoch, &owner)?;
    tx.commit()?;
    assert!(!service.resume_owner_retirement(&scope, &owner.id)?);
    service.store.leases()?.open_verified_regular(
        OsStr::new(&manifest_name(&owner.id)),
        created.lease.as_ref().unwrap().lease.identity(),
    )?;
    let mut context = scope.context.clone();
    context.device_id = "other-device".into();
    let foreign = service.scope(&context, &scope.workspace_identity)?;
    assert!(
        service
            .resume_owner_retirement(&foreign, &owner.id)
            .is_err()
    );
    assert_eq!(owner_charge_state(&service, owner.epoch)?, (1, 1, 1));
    service.retire_owner(&scope, created.lease.as_ref().unwrap())?;
    Ok(())
}

#[test]
fn retention_owner_v2_foreign_quarantine_after_rename_preserved_and_not_refunded() -> Result<()> {
    let (temp, scope, id) = start_and_kill_init_at("v2-retire-rename-visible")?;
    let service = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    let parent = service.store.leases()?;
    let name = manifest_quarantine(&id);
    parent.atomic_replace(OsStr::new(&name), b"foreign replacement")?;
    let foreign = parent.retention_regular_identity(OsStr::new(&name))?;
    assert!(service.resume_owner_retirement(&scope, &id).is_err());
    assert_eq!(
        parent.retention_regular_identity(OsStr::new(&name))?,
        foreign
    );
    let row = stored_owner(&service, &id)?;
    assert_eq!(owner_charge_state(&service, row.epoch)?, (1, 1, 1));
    assert!(
        service
            .create_owner_with_request(&scope, &request("other"))
            .is_err()
    );
    Ok(())
}

#[test]
fn retention_owner_v2_checkpoint_keeps_same_lock_and_redo_reservation_is_not_reallocated()
-> Result<()> {
    let (temp, service, scope) = fixture(owner_limit());
    let mut tx = service.store.transaction()?;
    tx.checkpoint_keep_lock()?;
    assert!(
        service.store.transaction().is_err(),
        "checkpoint must not release OS lock"
    );
    tx.checkpoint_keep_lock()?;
    assert!(service.store.transaction().is_err());
    drop(tx);
    service.store.transaction()?;
    storage::FAIL_AFTER_JOURNAL.with(|fail| fail.set(true));
    let error = service
        .create_owner_with_request(&scope, &request("redo"))
        .err()
        .context("journal fault expected")?;
    assert!(
        error
            .to_string()
            .contains("after durable retention journal")
    );
    drop(service);
    let reopened = RetentionService::open(&temp.path().join("account"), true, owner_limit())?;
    let recovered = terminal(&reopened, &scope, &request("redo"))?;
    assert_eq!(recovered.phase, OwnerPhase::Cancelled);
    let replay = reopened.create_owner_with_request(&scope, &request("redo"))?;
    assert_eq!(replay.id, recovered.id);
    assert_eq!(replay.phase, OwnerPhase::Cancelled);
    assert_eq!(reopened.store.transaction()?.state.charges.tombstones, 1);
    assert!(
        reopened
            .create_owner_with_request(&scope, &request("new"))
            .is_ok()
    );
    Ok(())
}

#[test]
fn retention_owner_v2_service_foreign_eexist_preserves_identity_and_unknown_charge() -> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let original_request = request("owner");
    let (id, _) = service.owner_request_locator(&scope, &original_request)?;
    let parent = service.store.leases()?;
    let name = manifest_name(&id);
    parent.atomic_replace(OsStr::new(&name), b"foreign before allocation")?;
    let foreign = parent.retention_regular_identity(OsStr::new(&name))?;
    let error = service
        .create_owner_with_request(&scope, &original_request)
        .err()
        .context("foreign link must fail")?;
    assert!(
        error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.raw_os_error() == Some(libc::EEXIST))
    );
    let stored = stored_owner(&service, &id)?;
    assert_eq!(stored.phase, OwnerPhase::Unknown);
    assert_ne!(stored.lease_identity.as_ref(), Some(&foreign));
    assert_eq!(
        parent.retention_regular_identity(OsStr::new(&name))?,
        foreign
    );
    assert_eq!(owner_charge_state(&service, stored.epoch)?, (1, 1, 0));
    for _ in 0..2 {
        let replay = service.create_owner_with_request(&scope, &original_request)?;
        assert_eq!(replay.id, id);
        assert_eq!(replay.phase, OwnerPhase::Unknown);
        assert!(replay.lease.is_none());
    }
    assert!(
        service
            .create_owner_with_request(&scope, &request("new"))
            .is_err()
    );
    assert_eq!(
        parent.retention_regular_identity(OsStr::new(&name))?,
        foreign
    );
    Ok(())
}

#[test]
fn retention_owner_v2_foreign_quarantine_before_link_is_unknown_without_final_publication()
-> Result<()> {
    let (_temp, service, scope) = fixture(owner_limit());
    let original_request = request("owner");
    let (id, _) = service.owner_request_locator(&scope, &original_request)?;
    let parent = service.store.leases()?;
    let quarantine = manifest_quarantine(&id);
    parent.atomic_replace(
        OsStr::new(&quarantine),
        b"foreign quarantine before publication",
    )?;
    let foreign = parent.retention_regular_identity(OsStr::new(&quarantine))?;
    assert!(
        service
            .create_owner_with_request(&scope, &original_request)
            .is_err()
    );
    assert_missing_regular(&parent, &manifest_name(&id));
    assert_eq!(
        parent.retention_regular_identity(OsStr::new(&quarantine))?,
        foreign
    );
    let mut bytes = Vec::new();
    parent
        .open_regular_file(OsStr::new(&quarantine))?
        .read_to_end(&mut bytes)?;
    assert_eq!(bytes, b"foreign quarantine before publication");
    let stored = stored_owner(&service, &id)?;
    assert_eq!(stored.phase, OwnerPhase::Unknown);
    assert_eq!(owner_charge_state(&service, stored.epoch)?, (1, 1, 0));
    for _ in 0..2 {
        let replay = terminal(&service, &scope, &original_request)?;
        assert_eq!(replay.id, id);
        assert_eq!(replay.phase, OwnerPhase::Unknown);
        assert!(replay.lease.is_none());
        assert_missing_regular(&parent, &manifest_name(&id));
    }
    assert!(
        service
            .create_owner_with_request(&scope, &request("new"))
            .is_err()
    );
    assert_eq!(
        parent.retention_regular_identity(OsStr::new(&quarantine))?,
        foreign
    );
    Ok(())
}
