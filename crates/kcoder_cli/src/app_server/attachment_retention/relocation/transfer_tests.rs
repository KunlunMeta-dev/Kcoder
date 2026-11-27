use super::*;
use crate::relocation;
use std::collections::BTreeMap;

fn captured_authority(
    account: &Path,
    workspace: &Path,
) -> crate::retention_context::VerifiedRetentionAuthority {
    crate::retention_context::VerifiedRetentionAuthority::capture(
        crate::retention_context::RetentionLaunchConfiguration {
            parent: kcoder_app_protocol::RetentionParentLaunchV1::LocalOs,
            account_root: account.into(),
            optional: false,
            revocation_verifier: None,
        },
        workspace,
        true,
    )
    .unwrap()
}

fn captured_scope(authority: &crate::retention_context::VerifiedRetentionAuthority) -> Scope {
    let context = TrustedRetentionContextV1 {
        gateway_namespace_id: "gateway".into(),
        device_id: "device".into(),
        authorization_generation: "1".into(),
        target_fingerprint: "target".into(),
        principal: RetentionPrincipalV1::LocalOs,
    };
    let admission = authority.retention_service().upload_admission().unwrap();
    let selector = format!(
        "r1.{}.{}.{}",
        admission.root_namespace,
        admission.admission_epoch,
        "a".repeat(32)
    );
    let request = kcoder_app_protocol::decode_private_retention_request(&serde_json::json!({
        "jsonrpc":"2.0", "id":1, "method":METHOD_ATTACHMENT_RETENTION_READ,
        "params": {"trustedContext":context, "selector":{"by":"clientRequestId", "clientRequestId":selector}},
        "kcoderPrivateRetention": {"version":1,"context":context,"workspaceTargetId":"registered-target"}
    }).to_string()).unwrap();
    authority.retention_scope(&request).unwrap()
}

#[test]
fn real_capture_and_accepted_reopen_survive_three_relocations_with_actual_roots() {
    let workspace = tempfile::tempdir().unwrap();
    let f = fixture_with_scope(false, |_, account| {
        captured_scope(&captured_authority(account, workspace.path()))
    });
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input.clone());
    let original_input = serde_json::to_vec(&input).unwrap();
    let owner = f.lease.id.clone();
    let Fixture {
        temp,
        service: _,
        scope,
        lease,
        parent: _,
        request,
    } = f;
    drop(lease);
    let destinations = tempfile::tempdir().unwrap();
    let mut source_bundle = temp.path().to_path_buf();
    let mut previous_account = PrivateDirectory::open_existing(&source_bundle.join("account"))
        .unwrap()
        .retention_identity()
        .unwrap();
    let original_seed = previous_account.clone();
    let mut original_bindings: Option<Vec<String>> = None;
    for round in 1..=3 {
        let source = source_bundle.join("account");
        let original_artifacts = source_bundle.join("artifacts");
        let snapshot =
            relocation::relocation_snapshot(&source, &[original_artifacts.clone()]).unwrap();
        let destination = destinations.path().join(format!("round-{round}/published"));
        PrivateDirectory::open_or_create(destination.parent().unwrap()).unwrap();
        let operation = format!("cold-capture-{round}");
        let (mut coordinator, published) = publish(&source_bundle, &destination, &operation);
        let target = destination.join("account");
        let artifacts = destination.join("artifacts");
        let targets = BTreeMap::from([(original_artifacts, artifacts.clone())]);
        relocation::relocate(
            &source, &target, &operation, &snapshot, &targets, &published,
        )
        .unwrap();
        relocation::verify_relocation(
            &source, &target, &operation, &snapshot, &targets, &published,
        )
        .unwrap();
        complete(&mut coordinator, &operation);
        let map: serde_json::Value = serde_json::from_slice(
            &std::fs::read(target.join("attachment-retention-v1/.retention-relocation.json"))
                .unwrap(),
        )
        .unwrap();
        let recorded = map["bindings"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        if let Some(original) = &original_bindings {
            assert!(
                recorded.iter().all(|key| original.contains(key)),
                "moving unchanged receipts must not append intermediate FileIDs"
            );
        } else {
            original_bindings = Some(recorded);
        }
        let authority = captured_authority(&target, workspace.path());
        let cold_scope = captured_scope(&authority);
        assert_eq!(cold_scope, scope);
        let service = authority.retention_service();
        assert_eq!(service.scope_account_identity(), &original_seed);
        let account = PrivateDirectory::open_existing(&target).unwrap();
        let actual_account = account.retention_identity().unwrap();
        assert_ne!(actual_account, previous_account);
        assert_ne!(&actual_account, service.scope_account_identity());
        authority.administrative_workspace_binding().unwrap();
        let parent = PrivateDirectory::open_existing(&artifacts).unwrap();
        let proof = crate::acceptance::verified_retained_acceptance_in(
            service,
            &destination.join(session.file_name().unwrap()),
            &cold_scope,
            &request.identity,
            &request.client_message_id,
            &request.request_fingerprint,
            &parent,
        )
        .unwrap();
        let owner_lease = service.recover_owner(&cold_scope, &owner).unwrap().unwrap();
        let reopened = service
            .prepare_retained_transfer(&cold_scope, &[&owner_lease], &request, &parent)
            .unwrap();
        assert_eq!(serde_json::to_vec(&reopened).unwrap(), original_input);
        for artifact in &input.artifacts {
            service.verify_artifact(&parent, artifact).unwrap();
        }
        if round == 3 {
            let done = service
                .finish_retained_transfer(
                    &cold_scope,
                    &[&owner_lease],
                    &request.references[0].retention_id,
                    &parent,
                    &proof,
                )
                .unwrap();
            assert_eq!(done.state, RetentionReceiptStateV1::Transferred);
            let mut wrong = scope.clone();
            wrong.context.device_id = "other-device".into();
            wrong = canonical_scope(&wrong).unwrap();
            assert!(service.recover_owner(&wrong, &owner).is_err());
        }
        drop(owner_lease);
        previous_account = actual_account;
        source_bundle = destination;
        drop(published);
        drop(coordinator);
    }
    assert_eq!(serde_json::to_vec(&input).unwrap(), original_input);
}

fn complete(coordinator: &mut kcoder_config::storage::StorageCoordinator, operation: &str) {
    use kcoder_types::StorageMigrationPhase as Phase;
    coordinator
        .advance(operation, Phase::Copying, Phase::Verifying)
        .unwrap();
    coordinator
        .advance(operation, Phase::Verifying, Phase::Prepared)
        .unwrap();
    coordinator.commit(operation).unwrap();
    coordinator.complete(operation).unwrap();
}

#[test]
fn an_owner_created_after_a_move_keeps_its_original_manifest_on_later_moves() {
    let f = fixture();
    let scope = f.scope.clone();
    let request = RetentionOwnerRequestV1 {
        client_owner_request_id: "owner-created-after-first-move".into(),
        immutable_parameters: BTreeMap::new(),
    };
    let source = f.temp.path().to_path_buf();
    drop(f.lease);
    drop(f.service);
    let destinations = tempfile::tempdir().unwrap();
    let mut current = source;
    let mut original_owner = None;
    let mut original_manifest = None;
    for round in 1..=3 {
        let account = current.join("account");
        let snapshot = relocation::relocation_snapshot(&account, &[]).unwrap();
        let next = destinations.path().join(format!("round-{round}/published"));
        PrivateDirectory::open_or_create(next.parent().unwrap()).unwrap();
        let operation = format!("late-owner-{round}");
        let (mut coordinator, published) = publish(&current, &next, &operation);
        let target = next.join("account");
        relocation::relocate(
            &account,
            &target,
            &operation,
            &snapshot,
            &BTreeMap::new(),
            &published,
        )
        .unwrap();
        complete(&mut coordinator, &operation);
        let service = RetentionService::open_account_root(&target, true).unwrap();
        let lease = service.create_owner_with_request(&scope, &request).unwrap();
        let manifest = std::fs::read(
            target
                .join("attachment-retention-v1/leases")
                .join(crate::owner_init::manifest_name(&lease.id)),
        )
        .unwrap();
        if let Some(owner) = &original_owner {
            assert_eq!(&lease.id, owner);
            assert_eq!(Some(&manifest), original_manifest.as_ref());
        } else {
            original_owner = Some(lease.id.clone());
            original_manifest = Some(manifest);
        }
        drop(lease);
        current = next;
    }
}

fn publish(
    source: &Path,
    target: &Path,
    operation: &str,
) -> (
    kcoder_config::storage::StorageCoordinator,
    kcoder_config::storage::StoragePublishedComponent,
) {
    use kcoder_config::storage::{StorageCoordinator, StorageResolveInput, resolve_storage_paths};
    use kcoder_types::{
        StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent,
        StorageMigrationPhase as Phase, StorageMigrationPlan, StorageTargetBinding,
    };
    let home = target.parent().unwrap().join("migration-control");
    PrivateDirectory::open_or_create(&home).unwrap();
    let parent = target.parent().unwrap();
    let mut coordinator = StorageCoordinator::acquire(&home).unwrap();
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from: resolve_storage_paths(&StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        })
        .unwrap(),
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: home.join("cache"),
            operation_id: Some(operation.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: PrivateDirectory::open_existing(source)
                .unwrap()
                .directory_identity()
                .unwrap(),
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: parent.into(),
            ancestor_identity: PrivateDirectory::open_existing(parent)
                .unwrap()
                .directory_identity()
                .unwrap(),
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    coordinator.begin(plan).unwrap();
    for (from, to) in [
        (Phase::Planned, Phase::Stopping),
        (Phase::Stopping, Phase::Stopped),
        (Phase::Stopped, Phase::Copying),
    ] {
        coordinator.advance(operation, from, to).unwrap();
    }
    coordinator
        .publish_component(
            operation,
            kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
            &std::collections::BTreeSet::new(),
        )
        .unwrap();
    let proof = coordinator
        .open_published_component(operation, kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN)
        .unwrap();
    (coordinator, proof)
}

fn copy_tree(source: &Path, target: &Path) {
    let source = PrivateDirectory::open_existing(source).unwrap();
    let target = PrivateDirectory::open_or_create(target).unwrap();
    fn copy(source: &PrivateDirectory, target: &PrivateDirectory) {
        for name in source.entry_names_bounded(32_768).unwrap() {
            match source.open_regular_file(&name) {
                Ok(mut file) => {
                    let mut bytes = Vec::new();
                    file.read_to_end(&mut bytes).unwrap();
                    target.atomic_replace(&name, &bytes).unwrap();
                }
                Err(_) => copy(
                    &source.open_child(&name, false).unwrap(),
                    &target.open_child(&name, true).unwrap(),
                ),
            }
        }
    }
    copy(&source, &target);
}

#[test]
fn accepted_tuple_survives_copy_reopen_and_original_transfer_completion() {
    let f = fixture();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input.clone());
    let owner_id = f.lease.id.clone();
    let original = serde_json::to_vec(&input).unwrap();
    let Fixture {
        temp,
        service,
        scope,
        lease,
        parent: _,
        request,
    } = f;
    let source = temp.path().join("account");
    let artifacts = temp.path().join("artifacts");
    assert!(
        relocation::relocation_snapshot(&source, &[artifacts.clone()]).is_err(),
        "live owner blocks relocation"
    );
    drop(lease);
    assert!(
        relocation::relocation_snapshot(&source, &[]).is_err(),
        "an omitted materialization parent cannot be silently dropped"
    );
    let snapshot = relocation::relocation_snapshot(&source, &[artifacts.clone()]).unwrap();
    let destination_owner = tempfile::tempdir().unwrap();
    let destination = destination_owner.path().join("published");
    let (_coordinator, published) = publish(temp.path(), &destination, "accepted-operation");
    let target = destination.join("account");
    let new_artifacts = destination.join("artifacts");
    let new_session = destination.join(session.file_name().unwrap());
    let targets = BTreeMap::from([(artifacts.clone(), new_artifacts.clone())]);
    relocation::relocate(
        &source,
        &target,
        "accepted-operation",
        &snapshot,
        &targets,
        &published,
    )
    .unwrap();
    relocation::verify_relocation(
        &source,
        &target,
        "accepted-operation",
        &snapshot,
        &targets,
        &published,
    )
    .unwrap();
    relocation::relocate(
        &source,
        &target,
        "accepted-operation",
        &snapshot,
        &targets,
        &published,
    )
    .unwrap();
    assert!(
        relocation::relocate(
            &source,
            &target,
            "another-operation",
            &snapshot,
            &targets,
            &published
        )
        .is_err()
    );
    let relocated = RetentionService::open_account_root(&target, true).unwrap();
    let parent = PrivateDirectory::open_existing(&new_artifacts).unwrap();
    assert_ne!(
        parent.retention_identity().unwrap(),
        input.artifacts[0].artifact_parent_identity
    );
    let accepted = crate::acceptance::verified_retained_acceptance_in(
        &relocated,
        &new_session,
        &scope,
        &request.identity,
        &request.client_message_id,
        &request.request_fingerprint,
        &parent,
    )
    .unwrap();
    let replay = relocated.recover_owner(&scope, &owner_id).unwrap().unwrap();
    let resumed = relocated
        .prepare_retained_transfer(&scope, &[&replay], &request, &parent)
        .unwrap();
    assert_eq!(serde_json::to_vec(&resumed).unwrap(), original);
    let transferred = relocated
        .finish_retained_transfer(
            &scope,
            &[&replay],
            &request.references[0].retention_id,
            &parent,
            &accepted,
        )
        .unwrap();
    assert_eq!(transferred.state, RetentionReceiptStateV1::Transferred);
    for artifact in &input.artifacts {
        relocated.verify_artifact(&parent, artifact).unwrap();
    }
    assert_eq!(serde_json::to_vec(&input).unwrap(), original);
    // The physical source remains intact; only the copied owner's lifecycle advanced.
    let old_parent = PrivateDirectory::open_existing(&artifacts).unwrap();
    for artifact in &input.artifacts {
        service.verify_artifact(&old_parent, artifact).unwrap();
    }
    assert_eq!(service.namespace(), relocated.namespace());
}

#[test]
fn unknown_receipt_and_v2_owner_request_keep_their_original_ids() {
    let f = fixture();
    let request = RetentionOwnerRequestV1 {
        client_owner_request_id: "owner-request-a".into(),
        immutable_parameters: BTreeMap::new(),
    };
    let created = f
        .service
        .create_owner_with_request(&f.scope, &request)
        .unwrap();
    let v2_id = created.id.clone();
    drop(created);
    {
        let mut tx = f.service.store.transaction().unwrap();
        let id = &f.request.references[0].retention_id;
        let mut receipt: Receipt = tx.read(Area::Receipts, id).unwrap().unwrap();
        receipt.wire.state = RetentionReceiptStateV1::Unknown;
        tx.put(Area::Receipts, id, receipt.epoch, &receipt).unwrap();
        tx.commit().unwrap();
    }
    let before = read(&f);
    let Fixture {
        temp,
        service: _,
        scope,
        lease,
        parent: _,
        request: transfer,
    } = f;
    drop(lease);
    let source = temp.path().join("account");
    let snapshot = relocation::relocation_snapshot(&source, &[]).unwrap();
    let destination_owner = tempfile::tempdir().unwrap();
    let destination = destination_owner.path().join("published");
    let (_coordinator, published) = publish(temp.path(), &destination, "unknown-operation");
    let target = destination.join("account");
    relocation::relocate(
        &source,
        &target,
        "unknown-operation",
        &snapshot,
        &BTreeMap::new(),
        &published,
    )
    .unwrap();
    let service = RetentionService::open_account_root(&target, true).unwrap();
    let after = service
        .read(
            &scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: transfer.references[0].retention_id.clone(),
            },
        )
        .unwrap()
        .receipt
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(after.state, RetentionReceiptStateV1::Unknown);
    let replay = service.create_owner_with_request(&scope, &request).unwrap();
    assert_eq!(replay.id, v2_id);
    assert!(replay.lease.is_some());
    let mut wrong = scope.clone();
    wrong.context.device_id = "other-device".into();
    wrong = canonical_scope(&wrong).unwrap();
    assert!(service.recover_owner(&wrong, &v2_id).is_err());
}

#[test]
fn target_inode_replacement_cannot_be_adopted_by_same_byte_replay() {
    let f = fixture();
    let Fixture {
        temp,
        service: _,
        scope: _,
        lease,
        parent: _,
        request: _,
    } = f;
    drop(lease);
    let source = temp.path().join("account");
    let snapshot = relocation::relocation_snapshot(&source, &[]).unwrap();
    let destination_owner = tempfile::tempdir().unwrap();
    let destination = destination_owner.path().join("published");
    let (_coordinator, published) = publish(temp.path(), &destination, "operation-a");
    let target = destination.join("account");
    relocation::relocate(
        &source,
        &target,
        "operation-a",
        &snapshot,
        &BTreeMap::new(),
        &published,
    )
    .unwrap();
    let replaced = destination.join("replaced-account");
    copy_tree(&target, &replaced);
    assert!(RetentionService::open_account_root(&replaced, true).is_err());
    assert!(
        relocation::relocate(
            &source,
            &replaced,
            "operation-a",
            &snapshot,
            &BTreeMap::new(),
            &published
        )
        .is_err()
    );
}
