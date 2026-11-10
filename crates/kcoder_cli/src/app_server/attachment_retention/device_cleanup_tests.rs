//! Real service/owned filesystem contracts. The parent MAC and stdio dispatch
//! are separate gates; these tests pass a trusted internal statement explicitly.
use super::*;
use crate::cleanup::{AdministrativeCleanupProof, CleanupQuery};

fn request(f: &Fixture) -> PrivateDeviceRevocationV1 {
    PrivateDeviceRevocationV1 {
        statement: DeviceRevocationStatementV1 {
            version: 1,
            gateway_namespace_id: f.scope.context.gateway_namespace_id.clone(),
            device_id: f.scope.context.device_id.clone(),
            authorization_generation: f.scope.context.authorization_generation.clone(),
            revocation_id: "owned-revocation".into(),
            revoked_at: 1,
        },
        statement_sha256: digest(b"owned durable revocation"),
        route: LocalRetentionRouteV1 {
            version: 1,
            route_id: digest(b"route"),
            target_id: "registered-target".into(),
            target_fingerprint: f.scope.context.target_fingerprint.clone(),
            workspace_path: f.temp.path().to_string_lossy().into(),
            workspace_selection: None,
        },
        authenticator: digest(b"tested separately at parent boundary"),
    }
}
struct Exact(CleanupQuery);
impl AdministrativeCleanupProof for Exact {
    fn is_exactly_durable(&self, query: &CleanupQuery) -> Result<bool> {
        Ok(self.0 == *query)
    }
}

#[test]
fn device_cleanup_cursor_passes_blocked_prefix_and_survives_store_reopen() {
    let f = fixture();
    let request = request(&f);
    f.service.fence_revoked_device(&request).unwrap();
    let items = (0..35)
        .map(|i| format!("candidate-{i:02}"))
        .collect::<Vec<_>>();
    let (first, more) = f
        .service
        .device_cleanup_window(&request, items.clone(), false, |id| id.as_str())
        .unwrap();
    assert!(more);
    assert_eq!(first, items[..32]);
    let reopened =
        RetentionService::open(&f.temp.path().join("account"), true, Limits::default()).unwrap();
    let (next, more) = reopened
        .device_cleanup_window(&request, items.clone(), false, |id| id.as_str())
        .unwrap();
    assert!(more);
    assert_eq!(&next[..3], &items[32..]);
    assert!(
        reopened
            .create_owner_with_request(
                &f.scope,
                &RetentionOwnerRequestV1 {
                    client_owner_request_id: format!(
                        "o1.{}.1.0123456789abcdef0123456789abcdef",
                        f.service.namespace()
                    ),
                    immutable_parameters: Default::default()
                }
            )
            .is_err(),
        "revoked admission remains fenced after scan/restart"
    );
}

#[test]
fn device_unaccepted_full_batch_abort_then_admin_cleanup_reclaims_only_exact_sources() {
    let f = fixture_with_receipts(true);
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    std::fs::write(f.temp.path().join("artifacts/sibling"), b"foreign sibling").unwrap();
    let request = request(&f);
    f.service.fence_revoked_device(&request).unwrap();
    let id = &f.request.references[0].retention_id;
    let query = f.service.device_abort_query(&f.scope, id).unwrap().unwrap();
    f.service
        .abort_unaccepted_device_transfer(
            &query,
            id,
            &request.statement_sha256,
            &[&f.lease],
            &f.parent,
        )
        .unwrap();
    assert_eq!(
        f.service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .transfer_bytes,
        0
    );
    for artifact in &input.artifacts {
        assert!(
            !f.temp
                .path()
                .join("artifacts")
                .join(&artifact.artifact_name)
                .exists()
        );
        assert!(source_exists(&f, &artifact.entry_id));
    }
    for reference in &f.request.references {
        assert!(
            f.service
                .device_transfer_aborted(&f.scope, &reference.retention_id)
                .unwrap()
        );
        assert!(
            f.service
                .device_abort_query(&f.scope, &reference.retention_id)
                .unwrap()
                .is_none()
        );
    }
    assert!(
        f.service
            .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
            .is_err()
    );
    let scope = f.scope.clone();
    let owner = f.lease.id.clone();
    drop(f.lease);
    let candidates = f
        .service
        .device_cleanup_candidates(&request, &scope.workspace_identity)
        .unwrap();
    assert_eq!(candidates.len(), 2);
    for candidate in candidates {
        let query = f.service.cleanup_query(&scope, &candidate.request).unwrap();
        assert!(!matches!(
            f.service
                .resume_administrative_cleanup(
                    &scope,
                    &candidate.request,
                    &Exact(query),
                    &NoAcceptedTurnProof
                )
                .unwrap(),
            RetentionCleanupStatusV1::Pending
        ));
    }
    let owners = f
        .service
        .unreserved_device_owners(&request, &scope.workspace_identity)
        .unwrap();
    assert_eq!(owners.len(), 1);
    let lease = f.service.recover_owner(&scope, &owner).unwrap().unwrap();
    f.service
        .cancel_revoked_owner(&scope, &lease, &request.statement_sha256)
        .unwrap();
    assert_eq!(
        std::fs::read(f.temp.path().join("artifacts/sibling")).unwrap(),
        b"foreign sibling"
    );
    let state = f.service.store.transaction().unwrap().state.clone();
    assert_eq!(state.charges.staged_bytes, 0);
    assert_eq!(state.charges.transfer_bytes, 0);
    assert!(
        f.service
            .device_cleanup_candidates(&request, &scope.workspace_identity)
            .unwrap()
            .is_empty()
    );
    assert!(
        f.service
            .unreserved_device_owners(&request, &scope.workspace_identity)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn device_abort_foreign_same_bytes_inode_is_preserved_then_original_intent_resumes() {
    let f = fixture();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let request = request(&f);
    f.service.fence_revoked_device(&request).unwrap();
    let id = &f.request.references[0].retention_id;
    let query = f.service.device_abort_query(&f.scope, id).unwrap().unwrap();
    let artifact = &input.artifacts[0];
    let path = f
        .temp
        .path()
        .join("artifacts")
        .join(&artifact.artifact_name);
    let original = path.with_extension("original");
    std::fs::rename(&path, &original).unwrap();
    let bytes = std::fs::read(&original).unwrap();
    std::fs::write(&path, &bytes).unwrap();
    let charged = f
        .service
        .store
        .transaction()
        .unwrap()
        .state
        .charges
        .transfer_bytes;
    assert!(
        f.parent
            .open_verified_regular(
                OsStr::new(&artifact.artifact_name),
                &artifact.artifact_identity
            )
            .is_err()
    );
    assert!(
        f.service
            .abort_unaccepted_device_transfer(
                &query,
                id,
                &request.statement_sha256,
                &[&f.lease],
                &f.parent
            )
            .is_err()
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(
        f.service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .transfer_bytes,
        charged
    );
    std::fs::remove_file(&path).unwrap(); // Only the test's replacement.
    std::fs::rename(&original, &path).unwrap();
    let reopened =
        RetentionService::open(&f.temp.path().join("account"), true, Limits::default()).unwrap();
    let retry = reopened.device_abort_query(&f.scope, id).unwrap().unwrap();
    assert_eq!(retry, query);
    reopened
        .abort_unaccepted_device_transfer(
            &retry,
            id,
            &request.statement_sha256,
            &[&f.lease],
            &f.parent,
        )
        .unwrap();
    assert_eq!(
        reopened
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .transfer_bytes,
        0
    );
}

#[test]
fn device_unreserved_owner_cancel_retire_is_same_id_and_keeps_peer_scope() {
    let f = fixture();
    let lease = f.service.create_owner(&f.scope).unwrap();
    let bytes = b"unreserved bytes";
    let entry = f
        .service
        .allocate_upload(
            &f.scope,
            &lease,
            "unreserved",
            bytes.len() as u64,
            &digest(bytes),
        )
        .unwrap();
    f.service
        .seal_bytes(&f.scope, &lease, &entry.id, bytes)
        .unwrap();
    let request = request(&f);
    f.service.fence_revoked_device(&request).unwrap();
    let before = f
        .service
        .store
        .transaction()
        .unwrap()
        .state
        .charges
        .staged_bytes;
    f.service
        .cancel_revoked_owner(&f.scope, &lease, &request.statement_sha256)
        .unwrap();
    assert_eq!(
        f.service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .staged_bytes,
        before - bytes.len() as u64
    );
    assert!(
        f.service
            .resume_revoked_owner_retirement(&f.scope, &lease.id, &request.statement_sha256)
            .unwrap()
    );
    for reference in &f.request.references {
        for id in &reference.entry_ids {
            assert!(source_exists(&f, id));
        }
    }
}

#[test]
fn device_abort_rejects_cross_thread_receipt_before_any_artifact_mutation() {
    let f = fixture_with_receipts(true);
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let request = request(&f);
    f.service.fence_revoked_device(&request).unwrap();
    let id = &f.request.references[0].retention_id;
    let query = f.service.device_abort_query(&f.scope, id).unwrap().unwrap();
    let mut tx = f.service.store.transaction().unwrap();
    let other = &f.request.references[1].retention_id;
    let mut receipt: Receipt = tx.read(Area::Receipts, other).unwrap().unwrap();
    receipt.wire.thread_id = "foreign-thread".into();
    tx.put(Area::Receipts, other, receipt.epoch, &receipt)
        .unwrap();
    tx.commit().unwrap();
    let before = f.service.store.transaction().unwrap().state.clone();
    assert!(f.service.device_abort_query(&f.scope, id).is_err());
    assert!(
        f.service
            .abort_unaccepted_device_transfer(
                &query,
                id,
                &request.statement_sha256,
                &[&f.lease],
                &f.parent
            )
            .is_err()
    );
    assert_eq!(
        serde_json::to_vec(&before).unwrap(),
        serde_json::to_vec(&f.service.store.transaction().unwrap().state).unwrap()
    );
    for artifact in &input.artifacts {
        verify_artifact(&f.parent, artifact).unwrap();
        assert!(source_exists(&f, &artifact.entry_id));
    }
}

#[test]
fn device_mixed_consumed_owner_reclaims_unreserved_source_without_losing_accepted_artifacts() {
    let f = fixture();
    let bytes = b"unreserved mixed-owner source";
    let extra = f
        .service
        .allocate_upload(
            &f.scope,
            &f.lease,
            "mixed-extra",
            bytes.len() as u64,
            &digest(bytes),
        )
        .unwrap();
    f.service
        .seal_bytes(&f.scope, &f.lease, &extra.id, bytes)
        .unwrap();
    let extra_path = f
        .temp
        .path()
        .join("account/attachment-retention-v1/data")
        .join(&f.lease.id)
        .join(&extra.id)
        .join("payload");
    assert_eq!(std::fs::read(&extra_path).unwrap(), bytes);
    finish_mixed_owner_cleanup(&f, &extra, bytes, &extra_path, 0);
}

#[test]
fn device_root_leaf_mixed_consumed_owner_reclaims_only_unreserved_source() {
    let mut f = fixture();
    // The original DirectoryV1 owner and Ready receipt are unrelated peers.
    // The production wire uploads use a distinct device and one shared owner.
    let original_scope = f.scope.clone();
    let original_owner = f.lease.id.clone();
    let original_receipt = f.request.references[0].retention_id.clone();
    let original_entries = f.request.references[0].entry_ids.clone();
    let original_sources = original_entries
        .iter()
        .map(|id| {
            let path = f
                .temp
                .path()
                .join("account/attachment-retention-v1/data")
                .join(&original_owner)
                .join(id)
                .join("payload");
            let bytes = std::fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect::<Vec<_>>();
    let baseline = f
        .service
        .store
        .transaction()
        .unwrap()
        .state
        .charges
        .staged_bytes;
    let peer_receipt = serde_json::to_value(
        f.service
            .read(
                &original_scope,
                &RetentionReceiptSelectorV1::RetentionId {
                    retention_id: original_receipt.clone(),
                },
            )
            .unwrap(),
    )
    .unwrap();
    let mut context = f.scope.context.clone();
    context.device_id = "root-leaf-device".into();
    f.scope = f
        .service
        .full_scope(
            &context,
            &f.scope.workspace_identity,
            None,
            "registered-target",
        )
        .unwrap();
    let admission = f.service.upload_admission().unwrap();
    let source = b"root leaf accepted source";
    let bytes = b"root leaf unreserved source";
    let mut params = RetentionUploadParamsV1 {
        owner_request: RetentionOwnerRequestV1 {
            client_owner_request_id: format!(
                "o1.{}.{}.0123456789abcdef0123456789abcdef",
                admission.root_namespace, admission.admission_epoch
            ),
            immutable_parameters: Default::default(),
        },
        client_upload_id: format!(
            "u1.{}.{}.0123456789abcdef0123456789abcdef",
            admission.root_namespace, admission.admission_epoch
        ),
        trusted_context: f.scope.context.clone(),
        filename: Some("root-leaf.txt".into()),
        size: Some(source.len() as u64),
        content_sha256: Some(digest(source)),
        offset: None,
        length: None,
        chunk_sha256: None,
        content_base64: None,
    };
    let seal = |params: &RetentionUploadParamsV1, content: &[u8]| {
        f.service.start_wire_upload(&f.scope, params).unwrap();
        let mut chunk = params.clone();
        chunk.offset = Some(0);
        chunk.length = Some(content.len() as u64);
        chunk.chunk_sha256 = Some(digest(content));
        f.service
            .chunk_wire_upload(&f.scope, &chunk, content)
            .unwrap();
        match f
            .service
            .finish_wire_upload(&f.scope, params)
            .unwrap()
            .lookup
        {
            RetentionUploadLookupV1::Present { recovery, .. } => recovery.stage_ref.unwrap(),
            _ => panic!("sealed wire upload absent"),
        }
    };
    let reference = seal(&params, source);
    params.client_upload_id = format!(
        "u1.{}.{}.fedcba9876543210fedcba9876543210",
        admission.root_namespace, admission.admission_epoch
    );
    params.size = Some(bytes.len() as u64);
    params.content_sha256 = Some(digest(bytes));
    let extra_ref = seal(&params, bytes);
    assert_eq!(reference.owner_id, extra_ref.owner_id);
    assert_ne!(reference.entry_id, extra_ref.entry_id);
    f.lease = f
        .service
        .read_owner_request(&f.scope, &params.owner_request)
        .unwrap()
        .unwrap()
        .lease
        .unwrap();
    let (entry, extra) = {
        let tx = f.service.store.transaction().unwrap();
        (
            tx.read::<Entry>(Area::Entries, &reference.entry_id)
                .unwrap()
                .unwrap(),
            tx.read::<Entry>(Area::Entries, &extra_ref.entry_id)
                .unwrap()
                .unwrap(),
        )
    };
    assert_eq!(entry.storage_layout(), UploadStorageLayout::RootLeafV1);
    assert_eq!(extra.storage_layout(), UploadStorageLayout::RootLeafV1);
    let receipt = f
        .service
        .reserve(
            &f.scope,
            &wire_id(f.service.namespace(), reference.epoch),
            "thread-a",
            &[reference],
        )
        .unwrap();
    f.request.references = vec![TurnRetentionReferenceV1 {
        retention_id: receipt.retention_id,
        expected_revision: receipt.revision,
        entry_ids: vec![entry.id],
    }];
    let extra_path = f
        .temp
        .path()
        .join("account/attachment-retention-v1/data")
        .join(extra.upload_leaf());
    assert_eq!(std::fs::read(&extra_path).unwrap(), bytes);
    finish_mixed_owner_cleanup(&f, &extra, bytes, &extra_path, baseline);
    assert_eq!(
        serde_json::to_value(
            f.service
                .read(
                    &original_scope,
                    &RetentionReceiptSelectorV1::RetentionId {
                        retention_id: original_receipt.clone()
                    }
                )
                .unwrap()
        )
        .unwrap(),
        peer_receipt
    );
    for (path, bytes) in original_sources {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

fn finish_mixed_owner_cleanup(
    f: &Fixture,
    extra: &Entry,
    bytes: &[u8],
    extra_path: &Path,
    untouched_bytes: u64,
) {
    let mut peer_context = f.scope.context.clone();
    peer_context.device_id = "peer-device".into();
    let peer_scope = f
        .service
        .full_scope(
            &peer_context,
            &f.scope.workspace_identity,
            None,
            "registered-target",
        )
        .unwrap();
    let peer = f.service.create_owner(&peer_scope).unwrap();
    let peer_bytes = b"peer source stays owned";
    let peer_entry = f
        .service
        .allocate_upload(
            &peer_scope,
            &peer,
            "peer-extra",
            peer_bytes.len() as u64,
            &digest(peer_bytes),
        )
        .unwrap();
    f.service
        .seal_bytes(&peer_scope, &peer, &peer_entry.id, peer_bytes)
        .unwrap();
    let peer_path = f
        .temp
        .path()
        .join("account/attachment-retention-v1/data")
        .join(&peer.id)
        .join(&peer_entry.id)
        .join("payload");
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(f, input.clone());
    let accepted_proof = proof(f, &session);
    let id = &f.request.references[0].retention_id;
    let transferred = f
        .service
        .finish_retained_transfer(&f.scope, &[&f.lease], id, &f.parent, &accepted_proof)
        .unwrap();
    assert_eq!(transferred.state, RetentionReceiptStateV1::Transferred);
    let request = request(f);
    f.service.fence_revoked_device(&request).unwrap();
    let candidates = f
        .service
        .device_cleanup_candidates(&request, &f.scope.workspace_identity)
        .unwrap();
    assert_eq!(candidates.len(), 1);
    // Until the exact receipt is consumed, owner cleanup must not cancel
    // either its referenced entries or the unrelated unreserved source.
    assert!(
        f.service
            .cancel_revoked_owner(&f.scope, &f.lease, &request.statement_sha256)
            .is_err()
    );
    assert_eq!(std::fs::read(extra_path).unwrap(), bytes);
    {
        let tx = f.service.store.transaction().unwrap();
        let owner: Owner = tx.read(Area::Owners, &f.lease.id).unwrap().unwrap();
        assert!(owner.device_cleanup.is_none());
        let extra: Entry = tx.read(Area::Entries, &extra.id).unwrap().unwrap();
        assert_eq!(extra.phase, EntryPhase::Sealed);
    }
    let query = f
        .service
        .cleanup_query(&f.scope, &candidates[0].request)
        .unwrap();
    assert!(matches!(
        f.service
            .resume_administrative_cleanup(
                &f.scope,
                &candidates[0].request,
                &Exact(query),
                &accepted_proof
            )
            .unwrap(),
        RetentionCleanupStatusV1::Administrative { .. }
    ));
    assert!(
        f.service
            .device_cleanup_candidates(&request, &f.scope.workspace_identity)
            .unwrap()
            .is_empty()
    );
    let terminal = {
        let tx = f.service.store.transaction().unwrap();
        let receipt: Receipt = tx.read(Area::Receipts, id).unwrap().unwrap();
        assert_eq!(receipt.wire.state, RetentionReceiptStateV1::Consumed);
        let tombstone: Tombstone = tx.read(Area::Consumed, id).unwrap().unwrap();
        assert_eq!(
            tx.state.charges.staged_bytes,
            untouched_bytes + (bytes.len() + peer_bytes.len()) as u64
        );
        serde_json::to_value(tombstone).unwrap()
    };
    let owners = f
        .service
        .unreserved_device_owners(&request, &f.scope.workspace_identity)
        .unwrap();
    assert_eq!(
        owners.iter().map(|(_, id)| id).collect::<Vec<_>>(),
        vec![&f.lease.id],
        "Consumed receipt must not hide the owner's remaining Sealed source"
    );
    f.service
        .cancel_revoked_owner(&f.scope, &f.lease, &request.statement_sha256)
        .unwrap();
    assert!(!extra_path.exists());
    assert_eq!(std::fs::read(&peer_path).unwrap(), peer_bytes);
    for artifact in &input.artifacts {
        verify_artifact(&f.parent, artifact).unwrap();
    }
    let state = f.service.store.transaction().unwrap().state.clone();
    assert_eq!(
        state.charges.staged_bytes,
        untouched_bytes + peer_bytes.len() as u64
    );
    assert_eq!(state.charges.transfer_bytes, 0);
    assert!(
        f.service
            .unreserved_device_owners(&request, &f.scope.workspace_identity)
            .unwrap()
            .is_empty()
    );
    let reopened =
        RetentionService::open(&f.temp.path().join("account"), true, Limits::default()).unwrap();
    assert!(
        reopened
            .resume_revoked_owner_retirement(&f.scope, &f.lease.id, &request.statement_sha256)
            .unwrap()
    );
    assert!(
        reopened
            .unreserved_device_owners(&request, &f.scope.workspace_identity)
            .unwrap()
            .is_empty()
    );
    let tx = reopened.store.transaction().unwrap();
    let tombstone: Tombstone = tx.read(Area::Consumed, id).unwrap().unwrap();
    assert_eq!(serde_json::to_value(tombstone).unwrap(), terminal);
    for entry_id in &f.request.references[0].entry_ids {
        let entry: Entry = tx.read(Area::Entries, entry_id).unwrap().unwrap();
        assert_eq!(entry.retention_id.as_deref(), Some(id.as_str()));
        assert_eq!(entry.phase, EntryPhase::Transferred);
    }
    assert_eq!(tx.state.charges.staged_bytes, state.charges.staged_bytes);
    assert!(
        TurnAttemptStore::open(&session, "thread-a")
            .unwrap()
            .load(&f.request.identity)
            .unwrap()
            .is_some()
    );
}
