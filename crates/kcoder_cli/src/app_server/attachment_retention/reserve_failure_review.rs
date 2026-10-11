//! Real store + production dispatcher ordering; no capability advertisement.
use super::*;
use crate::app_server::attachment_retention_dispatch;

#[test]
fn reserve_failure_legacy_sealed_slot_unavailable_is_entry_local_and_zero_commit() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "legacy-stage");
    {
        let mut tx = service.store.transaction().unwrap();
        let mut entry: Entry = tx
            .read(Area::Entries, &reference.entry_id)
            .unwrap()
            .unwrap();
        entry.cleanup_capacity = 0;
        // Same legacy serde path: absent field decodes to zero, not replenished.
        assert!(
            serde_json::to_value(&entry)
                .unwrap()
                .get("cleanup_capacity")
                .is_none()
        );
        tx.put(Area::Entries, &entry.id, entry.epoch, &entry)
            .unwrap();
        tx.commit().unwrap();
    }
    let request = wire_id(service.namespace(), reference.epoch);
    let before = serde_json::to_vec(&service.store.transaction().unwrap().state).unwrap();
    for _ in 0..2 {
        let error = service
            .reserve(&scope, &request, "thread-a", &[reference.clone()])
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<RetentionFailure>(),
            Some(&RetentionFailure::ReservePrepaidSlotUnavailable)
        );
        assert_eq!(
            attachment_retention_dispatch::error_code(&error),
            RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE
        );
        assert_eq!(
            serde_json::to_vec(&service.store.transaction().unwrap().state).unwrap(),
            before
        );
        assert!(
            service
                .read(
                    &scope,
                    &RetentionReceiptSelectorV1::ClientRequestId {
                        client_request_id: request.clone()
                    }
                )
                .unwrap()
                .receipt
                .is_none()
        );
    }
    let valid = upload(&service, &scope, &lease, "independent-stage");
    // Every ref is verified first, even when a legacy missing slot sorts first.
    let mut invalid = valid.clone();
    invalid.revision += 1;
    let error = service
        .reserve(&scope, &request, "thread-a", &[reference, invalid])
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<RetentionFailure>(),
        Some(&RetentionFailure::Conflict)
    );
    assert_eq!(
        reserve(&service, &scope, valid).state,
        RetentionReceiptStateV1::Ready
    );
}

#[test]
fn reserve_failure_consumed_entry_is_conflict_but_original_id_stays_idempotent() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "spent-stage");
    let receipt = reserve(&service, &scope, reference.clone());
    let released = service
        .release_original_owner(&scope, &lease, &receipt.retention_id, receipt.revision)
        .unwrap();
    service
        .consume(
            &scope,
            &RetentionConsumeAckV1 {
                retention_id: receipt.retention_id.clone(),
                terminal_revision: released.revision,
                client_ack_id: "consume-original".into(),
            },
            &NoAcceptedTurnProof,
        )
        .unwrap();
    let error = service
        .reserve(
            &scope,
            &wire_id(service.namespace(), reference.epoch),
            "thread-a",
            &[reference.clone()],
        )
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<RetentionFailure>(),
        Some(&RetentionFailure::Conflict)
    );
    let original = service
        .reserve(&scope, &receipt.client_request_id, "thread-a", &[reference])
        .unwrap();
    assert_eq!(original.retention_id, receipt.retention_id);
    assert_eq!(original.state, RetentionReceiptStateV1::Consumed);
}

#[test]
fn reserve_failure_piggyback_capacity_after_commit_requires_original_id_readback() {
    let (_temp, service, scope) = fixture(Limits::default());
    let old_lease = service.create_owner(&scope).unwrap();
    let old_stage = upload(&service, &scope, &old_lease, "legacy-stage");
    let old_receipt = reserve(&service, &scope, old_stage);
    let terminal = service
        .release_original_owner(
            &scope,
            &old_lease,
            &old_receipt.retention_id,
            old_receipt.revision,
        )
        .unwrap();
    // A readable legacy terminal record has no prepaid consume slot. Its consume
    // rejection occurs after the independently valid new reserve has committed.
    {
        let mut tx = service.store.transaction().unwrap();
        let mut record: Receipt = tx
            .read(Area::Receipts, &old_receipt.retention_id)
            .unwrap()
            .unwrap();
        record.cleanup_capacity = 0;
        tx.put(
            Area::Receipts,
            &record.wire.retention_id,
            record.epoch,
            &record,
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let lease = service.create_owner(&scope).unwrap();
    let reference = upload(&service, &scope, &lease, "new-stage");
    let request_id = wire_id(service.namespace(), reference.epoch);
    let params = serde_json::to_value(AttachmentRetentionReserveParams {
        trusted_context: TrustedRetentionContextV1 {
            gateway_namespace_id: "gateway-instance".into(),
            device_id: "device-a".into(),
            authorization_generation: "stable-auth-epoch".into(),
            target_fingerprint: "target-a".into(),
            principal: RetentionPrincipalV1::VerifiedAccount {
                principal_id: "account-a".into(),
            },
        },
        client_request_id: request_id.clone(),
        thread_id: "thread-new".into(),
        stage_refs: vec![reference.clone()],
        consume_acks: vec![RetentionConsumeAckV1 {
            retention_id: old_receipt.retention_id,
            terminal_revision: terminal.revision,
            client_ack_id: "consume-legacy".into(),
        }],
    })
    .unwrap();
    let error = attachment_retention_dispatch::dispatch_in_scope(
        &service,
        &scope,
        METHOD_ATTACHMENT_RETENTION_RESERVE,
        &params,
    )
    .unwrap_err();
    assert_eq!(
        attachment_retention_dispatch::error_code(&error),
        RETENTION_ERROR_CAPACITY
    );
    assert_ne!(
        attachment_retention_dispatch::error_code(&error),
        RETENTION_ERROR_RESERVE_PREPAID_SLOT_UNAVAILABLE
    );
    let readback = service
        .read(
            &scope,
            &RetentionReceiptSelectorV1::ClientRequestId {
                client_request_id: request_id.clone(),
            },
        )
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(readback.client_request_id, request_id);
    assert_eq!(readback.thread_id, "thread-new");
    assert_eq!(readback.state, RetentionReceiptStateV1::Ready);
    let replay = service
        .reserve(&scope, &request_id, "thread-new", &[reference])
        .unwrap();
    assert_eq!(replay, readback);
}

#[test]
fn reserve_failure_later_missing_slot_rolls_back_earlier_staged_entry() {
    let (_temp, service, scope) = fixture(Limits::default());
    let lease = service.create_owner(&scope).unwrap();
    let mut references = vec![
        upload(&service, &scope, &lease, "first-stage"),
        upload(&service, &scope, &lease, "second-stage"),
    ];
    references.sort_by(|a, b| (&a.owner_id, &a.entry_id).cmp(&(&b.owner_id, &b.entry_id)));
    let last = references.last().unwrap();
    {
        let mut tx = service.store.transaction().unwrap();
        let mut entry: Entry = tx.read(Area::Entries, &last.entry_id).unwrap().unwrap();
        entry.cleanup_capacity = 0;
        tx.put(Area::Entries, &entry.id, entry.epoch, &entry)
            .unwrap();
        tx.commit().unwrap();
    }
    let before = serde_json::to_vec(&service.store.transaction().unwrap().state).unwrap();
    let request = wire_id(service.namespace(), references[0].epoch);
    let error = service
        .reserve(&scope, &request, "thread-a", &references)
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<RetentionFailure>(),
        Some(&RetentionFailure::ReservePrepaidSlotUnavailable)
    );
    assert_eq!(
        serde_json::to_vec(&service.store.transaction().unwrap().state).unwrap(),
        before
    );
    for reference in &references {
        let entry: Entry = service
            .store
            .transaction()
            .unwrap()
            .read(Area::Entries, &reference.entry_id)
            .unwrap()
            .unwrap();
        assert_eq!(entry.phase, EntryPhase::Sealed);
        assert!(entry.retention_id.is_none());
    }
    assert!(
        service
            .read(
                &scope,
                &RetentionReceiptSelectorV1::ClientRequestId {
                    client_request_id: request
                }
            )
            .unwrap()
            .receipt
            .is_none()
    );
    // The first ref was staged in the failed transaction, but remains reservable.
    assert_eq!(
        reserve(&service, &scope, references.remove(0)).state,
        RetentionReceiptStateV1::Ready
    );
}
