use super::*;

#[cfg(target_os = "linux")]
#[test]
fn profile_attachments_preserve_the_original_real_historical_undo_seal() {
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
    use kcoder_app_protocol::*;
    use kcoder_attachment_retention::{
        NoAcceptedTurnProof, RetentionService, dispatch::dispatch_in_scope_with_proof,
    };
    use kcoder_state::historical_undo::{
        HistoricalUndoLease, preview_historical_session_undo, seal_historical_session,
    };
    use kcoder_state::history_storage_relocation::HistoryStorageRelocation;
    use kcoder_types::historical_context::{HistoricalSessionSeedBinding, PreparedContextReceipt};
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    let workspace = temp.path().join("workspace");
    let evidence = temp.path().join("evidence");
    let project = source.join("projects/owned");
    let client = project.join("client-sessions");
    for path in [&project, &client, &workspace, &evidence] {
        PrivateDirectory::open_or_create(path).unwrap();
    }
    let state =
        kcoder_state::AppState::new_with_short_id(&workspace, &temp.path().join("ids")).unwrap();
    let thread = state.session_id();
    let history = project.join(format!("{thread}.jsonl"));
    state.with_history_path(&history);
    let session = client.join(&thread);
    let artifacts = session.join("attachments");
    let parent = PrivateDirectory::open_or_create(&artifacts).unwrap();
    let service = RetentionService::open_account_root(&source, true).unwrap();
    let context = TrustedRetentionContextV1 {
        gateway_namespace_id: "undo-gateway".into(),
        device_id: "undo-device".into(),
        authorization_generation: "1".into(),
        target_fingerprint: "undo-target".into(),
        principal: RetentionPrincipalV1::LocalOs,
    };
    let scope = service
        .full_scope(
            &context,
            &hex_sha256(b"owned undo workspace"),
            None,
            "undo-target",
        )
        .unwrap();
    let admission = service.upload_admission().unwrap();
    let id = |kind| {
        format!(
            "{kind}.{}.{}.0123456789abcdef0123456789abcdef",
            admission.root_namespace, admission.admission_epoch
        )
    };
    let payload = b"owned retained payload";
    let upload = RetentionUploadParamsV1 {
        owner_request: RetentionOwnerRequestV1 {
            client_owner_request_id: id("o1"),
            immutable_parameters: BTreeMap::from([("purpose".into(), "attachment-upload".into())]),
        },
        client_upload_id: id("u1"),
        trusted_context: context.clone(),
        filename: Some("input.txt".into()),
        size: Some(payload.len() as u64),
        content_sha256: Some(hex_sha256(payload)),
        offset: None,
        length: None,
        chunk_sha256: None,
        content_base64: None,
    };
    service.start_wire_upload(&scope, &upload).unwrap();
    let mut chunk = upload.clone();
    chunk.offset = Some(0);
    chunk.length = Some(payload.len() as u64);
    chunk.chunk_sha256 = Some(hex_sha256(payload));
    service.chunk_wire_upload(&scope, &chunk, payload).unwrap();
    let reference = match service.finish_wire_upload(&scope, &upload).unwrap().lookup {
        RetentionUploadLookupV1::Present { recovery, .. } => recovery.stage_ref.unwrap(),
        other => panic!("unexpected upload: {other:?}"),
    };
    let reserve = AttachmentRetentionReserveParams {
        trusted_context: context,
        client_request_id: id("r1"),
        thread_id: thread.clone(),
        stage_refs: vec![reference.clone()],
        consume_acks: Vec::new(),
    };
    let receipt = dispatch_in_scope_with_proof(
        &service,
        &scope,
        METHOD_ATTACHMENT_RETENTION_RESERVE,
        &serde_json::to_value(&reserve).unwrap(),
        &NoAcceptedTurnProof,
    )
    .unwrap()
    .receipt
    .unwrap();
    let owners = service
        .retained_owner_leases(&scope, &[reference.owner_id.clone()])
        .unwrap();
    service
        .prepare_retained_transfer(
            &scope,
            &owners.iter().collect::<Vec<_>>(),
            &kcoder_attachment_retention::transfer::TransferRequest {
                identity: kcoder_types::TurnAttemptIdentity {
                    thread_id: thread.clone(),
                    turn_id: "turn-1".into(),
                    attempt_id: "attempt-1".into(),
                },
                client_message_id: "original-client-message".into(),
                request_fingerprint: hex_sha256(b"original request"),
                references: vec![TurnRetentionReferenceV1 {
                    retention_id: receipt.retention_id,
                    expected_revision: receipt.revision,
                    entry_ids: vec![reference.entry_id],
                }],
            },
            &parent,
        )
        .unwrap();
    drop(owners);
    drop(service);
    let message = kcoder_types::Message::runtime_text("original historical facts");
    let binding = HistoricalSessionSeedBinding {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: thread.clone(),
        source_job_id: uuid::Uuid::new_v4().to_string(),
        view_id: "v".repeat(64),
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: hex_sha256(&serde_json::to_vec(&message).unwrap()),
        preparation: PreparedContextReceipt {
            preparation_id: uuid::Uuid::new_v4().to_string(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    };
    let lease = HistoricalUndoLease::try_acquire(&history, &client, &thread).unwrap();
    state
        .publish_historical_seed(binding.clone(), message)
        .unwrap();
    let seal = seal_historical_session(&lease, &binding, |_| true).unwrap();
    preview_historical_session_undo(&lease, &binding, &seal, |_| true).unwrap();
    drop(lease);
    drop(state);
    let history_snapshot = HistoryStorageRelocation::snapshot(&source).unwrap();
    let attachments =
        ProfileAttachmentsRelocation::snapshot(&source, "undo-attachments", &evidence).unwrap();
    let (mut coordinator, published) =
        crate::relocation::tests::publish(&source, &target, "undo-attachments");
    HistoryStorageRelocation::relocate(
        &source,
        &target,
        "undo-attachments",
        &history_snapshot,
        &published,
    )
    .unwrap();
    let target_client = target.join(client.strip_prefix(&source).unwrap());
    let target_history = target.join(history.strip_prefix(&source).unwrap());
    {
        let lease =
            HistoricalUndoLease::try_acquire_existing(&target_history, &target_client, &thread)
                .unwrap();
        preview_historical_session_undo(&lease, &binding, &seal, |_| true).unwrap();
    }
    attachments
        .relocate(&source, &target, &evidence, &published)
        .unwrap();
    let lease = HistoricalUndoLease::try_acquire_existing(&target_history, &target_client, &thread)
        .unwrap();
    let outcome = preview_historical_session_undo(&lease, &binding, &seal, |_| true);
    assert!(
        outcome.is_ok(),
        "attachment relocation invalidated the original Undo seal; legacy map={}, artifact map={}: {outcome:?}",
        target_client
            .join(&thread)
            .join(".attachments-relocation.json")
            .exists(),
        target_client
            .join(&thread)
            .join("attachments/.retention-relocation.json")
            .exists()
    );
    drop(lease);
    let target_session = target_client.join(&thread);
    assert!(!target_session.join(".attachments-relocation.json").exists());
    assert!(
        !target_session
            .join("attachments/.retention-relocation.json")
            .exists()
    );
    let (_, control) = receipt_location(&target_session).unwrap();
    assert!(target_client.join(control).exists());
    attachments
        .verify_relocation(&source, &target, &evidence, &published)
        .unwrap();
    complete(&mut coordinator, "undo-attachments");
    drop(published);
    drop(coordinator);
    let original_history = std::fs::read(&history).unwrap();
    let mut current = target;
    for round in 2..=3 {
        let operation = format!("undo-attachments-{round}");
        let next = temp.path().join(format!("round-{round}/profile"));
        PrivateDirectory::open_or_create(next.parent().unwrap()).unwrap();
        let history_snapshot = HistoryStorageRelocation::snapshot(&current).unwrap();
        let attachments =
            ProfileAttachmentsRelocation::snapshot(&current, &operation, &evidence).unwrap();
        let (mut coordinator, published) =
            crate::relocation::tests::publish(&current, &next, &operation);
        HistoryStorageRelocation::relocate(
            &current,
            &next,
            &operation,
            &history_snapshot,
            &published,
        )
        .unwrap();
        attachments
            .relocate(&current, &next, &evidence, &published)
            .unwrap();
        attachments
            .verify_relocation(&current, &next, &evidence, &published)
            .unwrap();
        complete(&mut coordinator, &operation);
        let next_history = next.join(history.strip_prefix(&source).unwrap());
        let next_client = next.join(client.strip_prefix(&source).unwrap());
        let lease = HistoricalUndoLease::try_acquire_existing(&next_history, &next_client, &thread)
            .unwrap();
        preview_historical_session_undo(&lease, &binding, &seal, |_| true).unwrap();
        assert_eq!(std::fs::read(&next_history).unwrap(), original_history);
        current = next;
    }
}

#[cfg(target_os = "linux")]
#[test]
fn profile_attachments_use_formal_registrations_and_reopen_one_bounded_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    let evidence = temp.path().join("attachment-evidence");
    let workspace = temp.path().join("workspace");
    let project = source.join("projects/owned");
    PrivateDirectory::open_or_create(&project).unwrap();
    PrivateDirectory::open_or_create(&workspace).unwrap();
    PrivateDirectory::open_or_create(&evidence).unwrap();
    let state = kcoder_state::AppState::new(&workspace);
    let thread = state.session_id();
    let history = project.join(format!("{thread}.jsonl"));
    state.with_history_path(&history);
    state.add_message(kcoder_types::Message::user_text(
        "Keep /user/project and accepted/unknown text",
    ));
    state.save_history().unwrap();
    state.commit_session_state();
    drop(state);
    let original_history = std::fs::read(&history).unwrap();
    let sessions = [
        kcoder_state::session_dir_path(&project, &thread),
        kcoder_state::session_dir_path(project.join("client-sessions"), &thread),
    ];
    let mut old_paths = Vec::new();
    for (index, session) in sessions.iter().enumerate() {
        let artifacts =
            PrivateDirectory::open_or_create(&session.join("attachments/turn-original")).unwrap();
        artifacts
            .atomic_replace(
                OsStr::new("note.txt"),
                format!("original-{index}").as_bytes(),
            )
            .unwrap();
        old_paths.push(session.join("attachments/turn-original/note.txt"));
    }
    let unregistered = project.join("unregistered-child");
    let other =
        PrivateDirectory::open_or_create(&unregistered.join("attachments/turn-original")).unwrap();
    other
        .atomic_replace(OsStr::new("unowned.txt"), b"preserve without adopting")
        .unwrap();
    drop(kcoder_attachment_retention::RetentionService::open_account_root(&source, true).unwrap());
    let original_header =
        std::fs::read(source.join("attachment-retention-v1/retention-root.json")).unwrap();
    let binding =
        ProfileAttachmentsRelocation::snapshot(&source, "profile-attachments", &evidence).unwrap();
    assert_eq!(
        ProfileAttachmentsRelocation::snapshot(&source, "profile-attachments", &evidence).unwrap(),
        binding
    );
    let small = serde_json::to_vec(&binding).unwrap();
    assert!(
        small.len() < 4096,
        "the global receipt stores the binding only"
    );
    let snapshot = binding.load(&evidence, &source, None).unwrap();
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .filter(|entry| entry.snapshot.is_some())
            .count(),
        2
    );
    assert!(snapshot.retention.is_some());
    let (_coordinator, published) =
        crate::relocation::tests::publish(&source, &target, "profile-attachments");
    binding
        .relocate(&source, &target, &evidence, &published)
        .unwrap();
    let reopened: ProfileAttachmentsRelocation = serde_json::from_slice(&small).unwrap();
    reopened
        .verify_relocation(&source, &target, &evidence, &published)
        .unwrap();
    reopened
        .relocate(&source, &target, &evidence, &published)
        .unwrap();
    for (index, old) in old_paths.iter().enumerate() {
        let current = target.join(sessions[index].strip_prefix(&source).unwrap());
        let result = attachment_read(
            &current.join("attachments"),
            &kcoder_app_protocol::AttachmentReadParams {
                thread_id: thread.clone(),
                path: old.to_string_lossy().into_owned(),
            },
            &AttachmentDirectories::default(),
        )
        .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result.content_base64)
                .unwrap(),
            format!("original-{index}").as_bytes()
        );
    }
    assert_eq!(std::fs::read(&history).unwrap(), original_history);
    assert_eq!(
        std::fs::read(target.join(history.strip_prefix(&source).unwrap())).unwrap(),
        original_history
    );
    assert_eq!(
        std::fs::read(source.join("attachment-retention-v1/retention-root.json")).unwrap(),
        original_header
    );
    let unregistered_target = target.join(unregistered.strip_prefix(&source).unwrap());
    let (_, unregistered_control) = receipt_location(&unregistered_target).unwrap();
    assert!(
        !unregistered_target
            .parent()
            .unwrap()
            .join(unregistered_control)
            .exists()
    );
    assert_eq!(
        std::fs::read(
            target
                .join(unregistered.strip_prefix(&source).unwrap())
                .join("attachments/turn-original/unowned.txt")
        )
        .unwrap(),
        b"preserve without adopting"
    );
}

#[test]
fn profile_attachments_preserve_missing_namespace_and_reject_replaced_evidence() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let target = temp.path().join("target");
    let evidence = temp.path().join("attachment-evidence");
    PrivateDirectory::open_or_create(&source).unwrap();
    let directory = PrivateDirectory::open_or_create(&evidence).unwrap();
    let binding =
        ProfileAttachmentsRelocation::snapshot(&source, "empty-attachments", &evidence).unwrap();
    assert!(!source.join("attachment-retention-v1").exists());
    let (_coordinator, published) =
        crate::relocation::tests::publish(&source, &target, "empty-attachments");
    binding
        .relocate(&source, &target, &evidence, &published)
        .unwrap();
    binding
        .verify_relocation(&source, &target, &evidence, &published)
        .unwrap();
    assert!(!target.join("attachment-retention-v1").exists());
    let target_directory = PrivateDirectory::open_existing(&target).unwrap();
    let unexpected = target_directory
        .create_private_child(OsStr::new("attachment-retention-v1"))
        .unwrap();
    assert!(
        binding
            .verify_relocation(&source, &target, &evidence, &published)
            .is_err()
    );
    assert_eq!(
        target_directory
            .open_child(OsStr::new("attachment-retention-v1"), false)
            .unwrap()
            .directory_identity()
            .unwrap(),
        unexpected.directory_identity().unwrap()
    );
    drop(unexpected);
    assert!(
        target_directory
            .remove_empty_child_directory(OsStr::new("attachment-retention-v1"))
            .unwrap()
    );
    let name = snapshot_name("empty-attachments");
    let original = directory
        .open_single_link_regular_file(OsStr::new(&name))
        .unwrap();
    let bytes = std::fs::read(evidence.join(&name)).unwrap();
    directory.atomic_replace(OsStr::new(&name), &bytes).unwrap();
    assert_ne!(
        directory
            .portable_regular_identity(OsStr::new(&name))
            .unwrap(),
        binding.file_identity
    );
    assert!(
        binding
            .verify_relocation(&source, &target, &evidence, &published)
            .is_err()
    );
    drop(original);
    assert!(!source.join("attachment-retention-v1").exists());
    assert!(!target.join("attachment-retention-v1").exists());
}
