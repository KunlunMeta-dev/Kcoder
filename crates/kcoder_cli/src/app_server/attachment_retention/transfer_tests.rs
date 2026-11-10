//! Real owned filesystem contracts, without wire routes or a model Provider.
use super::*;
use kcoder_state::turn_attempt_store::{TurnAttemptRecord, TurnAttemptStore};
use kcoder_types::{PrivateFileIdentityV1, TurnAttemptStatus};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

#[path = "device_cleanup_tests.rs"]
mod device_cleanup_review;

struct Fixture {
    temp: TempDir,
    service: RetentionService,
    scope: Scope,
    lease: OwnerLease,
    parent: PrivateDirectory,
    request: TransferRequest,
}
fn fixture() -> Fixture {
    fixture_with_receipts(false)
}
fn fixture_with_receipts(split: bool) -> Fixture {
    let base = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../..")
        .canonicalize()
        .unwrap()
        .join("target/test/crates/kcoder_cli/retention-transfer");
    let base = std::env::var_os("KCODER_B5_TRANSFER_OWNED_ROOT")
        .map(PathBuf::from)
        .unwrap_or(base);
    PrivateDirectory::open_or_create(&base).unwrap();
    let temp = tempfile::Builder::new()
        .prefix("transfer-")
        .tempdir_in(base)
        .unwrap();
    let account = temp.path().join("account");
    PrivateDirectory::open_or_create(&account).unwrap();
    let service = RetentionService::open(&account, true, Limits::default()).unwrap();
    let context = TrustedRetentionContextV1 {
        gateway_namespace_id: "gateway".into(),
        device_id: "device".into(),
        authorization_generation: "1".into(),
        target_fingerprint: "target".into(),
        principal: RetentionPrincipalV1::LocalOs,
    };
    let scope = service
        .full_scope(&context, &digest(b"workspace"), None, "registered-target")
        .unwrap();
    let lease = service.create_owner(&scope).unwrap();
    let mut refs = Vec::new();
    for i in 0..2 {
        let bytes = format!("retained source {i}").into_bytes();
        let entry = service
            .allocate_upload(
                &scope,
                &lease,
                &format!("upload-{i}"),
                bytes.len() as u64,
                &digest(&bytes),
            )
            .unwrap();
        refs.push(
            service
                .seal_bytes(&scope, &lease, &entry.id, &bytes)
                .unwrap(),
        );
    }
    let groups = if split {
        refs.iter().map(|r| vec![r.clone()]).collect::<Vec<_>>()
    } else {
        vec![refs]
    };
    let references = groups
        .iter()
        .map(|refs| {
            let receipt = service
                .reserve(
                    &scope,
                    &wire_id(service.namespace(), refs[0].epoch),
                    "thread-a",
                    refs,
                )
                .unwrap();
            TurnRetentionReferenceV1 {
                retention_id: receipt.retention_id,
                expected_revision: receipt.revision,
                entry_ids: refs.iter().map(|r| r.entry_id.clone()).collect(),
            }
        })
        .collect();
    let request = TransferRequest {
        identity: TurnAttemptIdentity {
            thread_id: "thread-a".into(),
            turn_id: "turn-1".into(),
            attempt_id: "attempt-1".into(),
        },
        client_message_id: "message-1".into(),
        request_fingerprint: digest(b"canonical request"),
        references,
    };
    let parent = PrivateDirectory::open_or_create(&temp.path().join("artifacts")).unwrap();
    Fixture {
        temp,
        service,
        scope,
        lease,
        parent,
        request,
    }
}
fn accepted(f: &Fixture, input: TurnRetainedInputV1) -> PathBuf {
    let session = f.temp.path().join("thread-a");
    let store = TurnAttemptStore::open(&session, "thread-a").unwrap();
    store
        .begin(TurnAttemptRecord {
            version: 1,
            identity: f.request.identity.clone(),
            parent_attempt_id: None,
            retry_operation_id: None,
            accepted_at_ms: 1,
            input_context_hash: digest(b"context"),
            request_fingerprint: Some(f.request.request_fingerprint.clone()),
            retained_input: Some(input),
            client_presentation: None,
            status: TurnAttemptStatus::Accepted,
            completion: None,
        })
        .unwrap();
    map(&session, "turn-1", "message-1");
    session
}
fn map(session: &Path, turn: &str, client: &str) {
    let directory =
        PrivateDirectory::open_or_create(&session.join("turn-client-messages")).unwrap();
    directory.atomic_replace(OsStr::new(&format!("{}.json",digest(turn.as_bytes()))),
        &serde_json::to_vec(&serde_json::json!({"version":1,"thread_id":"thread-a","turn_id":turn,"client_message_id":client})).unwrap()).unwrap();
}

#[test]
fn legacy_same_client_mapping_is_not_hidden_by_retained_lookup() {
    let f = fixture();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input);
    map(&session, "turn-legacy", "message-1");
    let proof = crate::acceptance::verified_retained_acceptance_in(
        &session,
        &f.scope,
        &f.request.identity,
        &f.request.client_message_id,
        &f.request.request_fingerprint,
        &f.parent,
    );
    assert!(
        proof.is_err(),
        "a retained record cannot hide another legacy turn with the same client ID"
    );
}

fn proof(f: &Fixture, session: &Path) -> crate::acceptance::VerifiedAcceptedTurnProof {
    crate::acceptance::verified_retained_acceptance_in(
        session,
        &f.scope,
        &f.request.identity,
        &f.request.client_message_id,
        &f.request.request_fingerprint,
        &f.parent,
    )
    .unwrap()
}
fn read(f: &Fixture) -> RetentionReceiptV1 {
    f.service
        .read(
            &f.scope,
            &RetentionReceiptSelectorV1::RetentionId {
                retention_id: f.request.references[0].retention_id.clone(),
            },
        )
        .unwrap()
        .receipt
        .unwrap()
}
fn source_exists(f: &Fixture, id: &str) -> bool {
    let tx = f.service.store.transaction().unwrap();
    let owner = f.service.leased_owner(&tx, &f.scope, &f.lease).unwrap();
    let entry: Entry = tx.read(Area::Entries, id).unwrap().unwrap();
    drop(tx);
    f.service
        .owner_data(&owner)
        .unwrap()
        .open_verified_child(OsStr::new(id), entry.directory_identity.as_ref().unwrap())
        .and_then(|d| {
            d.open_verified_regular(
                OsStr::new("payload"),
                entry.payload_identity.as_ref().unwrap(),
            )
        })
        .is_ok()
}

#[test]
fn preparation_rejects_missing_duplicate_extra_and_wrong_scope_before_copy() {
    let f = fixture();
    let before = serde_json::to_value(&f.service.store.transaction().unwrap().state).unwrap();
    for variant in 0..4 {
        let mut request = f.request.clone();
        match variant {
            0 => {
                request.references[0].entry_ids.pop();
            }
            1 => {
                let id = request.references[0].entry_ids[0].clone();
                request.references[0].entry_ids.push(id);
            }
            2 => request.references.push(request.references[0].clone()),
            _ => request.references[0].entry_ids[0] = "foreign-entry".into(),
        }
        assert!(
            f.service
                .prepare_retained_transfer(&f.scope, &[&f.lease], &request, &f.parent)
                .is_err()
        );
    }
    let mut scope = f.scope.clone();
    scope.hash = digest(b"another authorized scope");
    assert!(
        f.service
            .prepare_retained_transfer(&scope, &[&f.lease], &f.request, &f.parent)
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(&f.service.store.transaction().unwrap().state).unwrap(),
        before
    );
    assert_eq!(
        f.parent.count_regular_files_bounded(|_| true, 1).unwrap(),
        0
    );
    assert_eq!(read(&f).state, RetentionReceiptStateV1::Ready);
}

#[test]
fn materialization_revision_replay_and_exact_batch_proof_gate_source_cleanup() {
    let f = fixture();
    let first = f.request.references[0].clone();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    assert_eq!(read(&f).state, RetentionReceiptStateV1::Materializing);
    assert_eq!(read(&f).revision, first.expected_revision + 1);
    assert!(
        f.service
            .release_receipt(
                &f.scope,
                &first.retention_id,
                first.expected_revision,
                RetentionReleaseReasonV1::Discard
            )
            .is_err()
    );
    assert_eq!(
        f.service
            .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
            .unwrap(),
        input
    );
    assert!(
        f.service
            .finish_retained_transfer(
                &f.scope,
                &[&f.lease],
                &first.retention_id,
                &f.parent,
                &NoAcceptedTurnProof
            )
            .is_err()
    );
    for id in &first.entry_ids {
        assert!(source_exists(&f, id));
    }
    let session = accepted(&f, input.clone());
    let proof = proof(&f, &session);
    let query = {
        let tx = f.service.store.transaction().unwrap();
        let receipt: Receipt = tx
            .read(Area::Receipts, &first.retention_id)
            .unwrap()
            .unwrap();
        f.service.transfer_query(&tx, &f.scope, &receipt).unwrap()
    };
    assert!(proof.is_exactly_accepted(&query).unwrap());
    for variant in 0..5 {
        let mut bad = query.clone();
        match variant {
            0 => {
                bad.input.artifacts.pop();
            }
            1 => bad.input.artifacts.push(bad.input.artifacts[0].clone()),
            2 => bad.input.artifacts[0].entry_id = "different-entry".into(),
            3 => bad.scope.hash = digest(b"another scope"),
            _ => bad.input.artifacts[0].expected_receipt_revision += 1,
        }
        assert!(
            !matches!(proof.is_exactly_accepted(&bad), Ok(true)),
            "bad query variant {variant}"
        );
    }
    let receipt = f
        .service
        .finish_retained_transfer(
            &f.scope,
            &[&f.lease],
            &first.retention_id,
            &f.parent,
            &proof,
        )
        .unwrap();
    assert_eq!(receipt.state, RetentionReceiptStateV1::Transferred);
    assert_eq!(receipt.revision, first.expected_revision + 2);
    for id in &first.entry_ids {
        assert!(!source_exists(&f, id));
    }
    let state = f.service.store.transaction().unwrap().state.clone();
    assert_eq!(state.charges.staged_bytes, 0);
    assert_eq!(state.charges.transfer_bytes, 0);
    assert_eq!(
        f.service
            .finish_retained_transfer(
                &f.scope,
                &[&f.lease],
                &first.retention_id,
                &f.parent,
                &proof
            )
            .unwrap(),
        receipt
    );
    assert_eq!(
        f.service
            .consume(
                &f.scope,
                &RetentionConsumeAckV1 {
                    retention_id: first.retention_id,
                    terminal_revision: receipt.revision,
                    client_ack_id: "ack".into()
                },
                &proof
            )
            .unwrap(),
        RetentionConsumeStatusV1::Consumed
    );
    for artifact in &input.artifacts {
        verify_artifact(&f.parent, artifact).unwrap();
    }
}

#[test]
fn foreign_target_is_preserved_and_original_ids_resume_after_exact_target_restored() {
    let f = fixture();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input.clone());
    let proof = proof(&f, &session);
    let artifact = &input.artifacts[0];
    let path = f
        .temp
        .path()
        .join("artifacts")
        .join(&artifact.artifact_name);
    let saved = f.temp.path().join("owned-backup");
    std::fs::rename(&path, &saved).unwrap();
    f.parent
        .atomic_replace(
            OsStr::new(&artifact.artifact_name),
            b"foreign owned-fixture bytes",
        )
        .unwrap();
    assert!(
        f.service
            .finish_retained_transfer(
                &f.scope,
                &[&f.lease],
                &f.request.references[0].retention_id,
                &f.parent,
                &proof
            )
            .is_err()
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        b"foreign owned-fixture bytes"
    );
    for id in &f.request.references[0].entry_ids {
        assert!(source_exists(&f, id));
    }
    // Only the test owner removes its deliberate replacement and restores the
    // exact inode. Product recovery neither unlinks nor adopts that replacement.
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(saved, &path).unwrap();
    f.service
        .finish_retained_transfer(
            &f.scope,
            &[&f.lease],
            &f.request.references[0].retention_id,
            &f.parent,
            &proof,
        )
        .unwrap();
}

#[test]
fn wrong_scope_unknown_and_legacy_attempts_do_not_mint_acceptance() {
    let f = fixture();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input);
    let mut scope = f.scope.clone();
    scope.hash = digest(b"wrong scope");
    assert!(
        crate::acceptance::verified_retained_acceptance_in(
            &session,
            &scope,
            &f.request.identity,
            &f.request.client_message_id,
            &f.request.request_fingerprint,
            &f.parent
        )
        .is_err()
    );
    let missing = f.temp.path().join("missing-thread");
    assert!(
        crate::acceptance::verified_retained_acceptance_in(
            &missing,
            &f.scope,
            &f.request.identity,
            &f.request.client_message_id,
            &f.request.request_fingerprint,
            &f.parent
        )
        .is_err()
    );
    assert!(!missing.exists());
    let store = TurnAttemptStore::open_existing(&session, "thread-a")
        .unwrap()
        .unwrap();
    let mut other = store.load(&f.request.identity).unwrap().unwrap();
    other.identity.attempt_id = "another-attempt".into();
    store.begin(other).unwrap();
    assert!(
        crate::acceptance::verified_retained_acceptance_in(
            &session,
            &f.scope,
            &f.request.identity,
            &f.request.client_message_id,
            &f.request.request_fingerprint,
            &f.parent
        )
        .is_err()
    );
}

#[test]
fn consumed_first_receipt_does_not_block_second_receipt_same_batch_recovery() {
    let f = fixture_with_receipts(true);
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input);
    let first = proof(&f, &session);
    let a = &f.request.references[0].retention_id;
    let b = &f.request.references[1].retention_id;
    let terminal = f
        .service
        .finish_retained_transfer(&f.scope, &[&f.lease], a, &f.parent, &first)
        .unwrap();
    assert_eq!(
        f.service
            .consume(
                &f.scope,
                &RetentionConsumeAckV1 {
                    retention_id: a.clone(),
                    terminal_revision: terminal.revision,
                    client_ack_id: "ack-A".into()
                },
                &first
            )
            .unwrap(),
        RetentionConsumeStatusV1::Consumed
    );
    let base = f.temp.path().to_path_buf();
    let scope = f.scope.clone();
    let owner = f.lease.id.clone();
    drop(first);
    drop(f.lease);
    drop(f.service);
    let service = RetentionService::open(&base.join("account"), true, Limits::default()).unwrap();
    let lease = service.recover_owner(&scope, &owner).unwrap().unwrap();
    let proof = crate::acceptance::verified_retained_acceptance_in(
        &session,
        &scope,
        &f.request.identity,
        &f.request.client_message_id,
        &f.request.request_fingerprint,
        &f.parent,
    )
    .unwrap();
    let terminal = service
        .finish_retained_transfer(&scope, &[&lease], b, &f.parent, &proof)
        .unwrap();
    assert_eq!(terminal.state, RetentionReceiptStateV1::Transferred);
    assert_eq!(
        service
            .store
            .transaction()
            .unwrap()
            .state
            .charges
            .transfer_bytes,
        0
    );
    // No new acceptance or map is written during recovery.
    assert_eq!(
        TurnAttemptStore::open_existing(&session, "thread-a")
            .unwrap()
            .unwrap()
            .list()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn root_leaf_upload_transfer_consumption_restart_preserves_shared_sibling() -> Result<()> {
    let mut f = fixture();
    let baseline = f.service.store.transaction()?.state.charges.clone();
    let admission = f.service.upload_admission()?;
    let bytes = b"root leaf retained source";
    let sibling_bytes = b"unrelated shared-root source";
    let params = RetentionUploadParamsV1 {
        owner_request: RetentionOwnerRequestV1 {
            client_owner_request_id: format!(
                "o1.{}.{}.0123456789abcdef0123456789abcdef",
                admission.root_namespace, admission.admission_epoch
            ),
            immutable_parameters: std::collections::BTreeMap::new(),
        },
        client_upload_id: format!(
            "u1.{}.{}.0123456789abcdef0123456789abcdef",
            admission.root_namespace, admission.admission_epoch
        ),
        trusted_context: f.scope.context.clone(),
        filename: Some("root-leaf.txt".into()),
        size: Some(bytes.len() as u64),
        content_sha256: Some(digest(bytes)),
        offset: None,
        length: None,
        chunk_sha256: None,
        content_base64: None,
    };
    let seal = |params: &RetentionUploadParamsV1, content: &[u8]| -> Result<RetentionStageRefV1> {
        f.service.start_wire_upload(&f.scope, params)?;
        let mut chunk = params.clone();
        chunk.offset = Some(0);
        chunk.length = Some(content.len() as u64);
        chunk.chunk_sha256 = Some(digest(content));
        f.service.chunk_wire_upload(&f.scope, &chunk, content)?;
        match f.service.finish_wire_upload(&f.scope, params)?.lookup {
            RetentionUploadLookupV1::Present { recovery, .. } => {
                recovery.stage_ref.context("sealed upload lacks StageRef")
            }
            _ => anyhow::bail!("sealed upload absent"),
        }
    };
    let reference = seal(&params, bytes)?;
    let mut sibling_params = params.clone();
    sibling_params.client_upload_id = format!(
        "u1.{}.{}.fedcba9876543210fedcba9876543210",
        admission.root_namespace, admission.admission_epoch
    );
    sibling_params.size = Some(sibling_bytes.len() as u64);
    sibling_params.content_sha256 = Some(digest(sibling_bytes));
    let sibling_ref = seal(&sibling_params, sibling_bytes)?;
    f.lease = f
        .service
        .read_owner_request(&f.scope, &params.owner_request)?
        .context("upload owner absent")?
        .lease
        .context("upload lease unavailable")?;
    let tx = f.service.store.transaction()?;
    let entry: Entry = tx.read(Area::Entries, &reference.entry_id)?.unwrap();
    let sibling: Entry = tx.read(Area::Entries, &sibling_ref.entry_id)?.unwrap();
    drop(tx);
    assert_eq!(entry.storage_layout(), UploadStorageLayout::RootLeafV1);
    assert_eq!(sibling.storage_layout(), UploadStorageLayout::RootLeafV1);
    let data = f.service.store.data()?;
    let parent_identity = data.retention_identity()?;
    assert_eq!(entry.directory_identity.as_ref(), Some(&parent_identity));
    let receipt = f.service.reserve(
        &f.scope,
        &wire_id(f.service.namespace(), reference.epoch),
        "thread-a",
        &[reference],
    )?;
    f.request.references = vec![TurnRetentionReferenceV1 {
        retention_id: receipt.retention_id.clone(),
        expected_revision: receipt.revision,
        entry_ids: vec![entry.id.clone()],
    }];
    let input =
        f.service
            .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)?;
    assert_eq!(read(&f).revision, receipt.revision + 1);
    let artifact = input.artifacts[0].clone();
    let session = accepted(&f, input);
    let accepted_proof = proof(&f, &session);
    let terminal = f.service.finish_retained_transfer(
        &f.scope,
        &[&f.lease],
        &receipt.retention_id,
        &f.parent,
        &accepted_proof,
    )?;
    assert_eq!(terminal.state, RetentionReceiptStateV1::Transferred);
    assert_eq!(terminal.revision, receipt.revision + 2);
    for leaf in [entry.upload_leaf(), format!("q-transfer-{}", entry.id)] {
        assert!(
            matches!(data.open_regular_file(OsStr::new(&leaf)), Err(ref error) if missing(error))
        );
    }
    data.verify_retention_identity(&parent_identity)?;
    let read_exact = |parent: &PrivateDirectory,
                      name: &str,
                      identity: &PrivateFileIdentityV1|
     -> Result<Vec<u8>> {
        let file = parent.open_verified_regular(OsStr::new(name), identity)?;
        let mut output = Vec::new();
        file.file().read_to_end(&mut output)?;
        Ok(output)
    };
    assert_eq!(
        read_exact(
            &f.parent,
            &artifact.artifact_name,
            &artifact.artifact_identity
        )?,
        bytes
    );
    assert_eq!(
        read_exact(
            &data,
            &sibling.upload_leaf(),
            sibling.payload_identity.as_ref().unwrap()
        )?,
        sibling_bytes
    );
    let charges = f.service.store.transaction()?.state.charges.clone();
    assert_eq!(
        charges.staged_bytes,
        baseline.staged_bytes + sibling_bytes.len() as u64
    );
    assert_eq!(charges.transfer_bytes, baseline.transfer_bytes);
    let owner: Owner = f
        .service
        .store
        .transaction()?
        .read(Area::Owners, &f.lease.id)?
        .unwrap();
    assert_eq!(owner.bytes, sibling_bytes.len() as u64);
    let ack = RetentionConsumeAckV1 {
        retention_id: receipt.retention_id,
        terminal_revision: terminal.revision,
        client_ack_id: "root-leaf-transfer-ack".into(),
    };
    assert_eq!(
        f.service.consume(&f.scope, &ack, &accepted_proof)?,
        RetentionConsumeStatusV1::Consumed
    );
    let after_consume = f.service.store.transaction()?.state.charges.clone();
    assert_eq!(after_consume.entries, baseline.entries + 1);
    assert_eq!(after_consume.receipt_slots, baseline.receipt_slots + 1);
    drop(accepted_proof);
    drop(f.lease);
    drop(f.service);
    let service = RetentionService::open(&f.temp.path().join("account"), true, Limits::default())?;
    let accepted_proof = crate::acceptance::verified_retained_acceptance_in(
        &session,
        &f.scope,
        &f.request.identity,
        &f.request.client_message_id,
        &f.request.request_fingerprint,
        &f.parent,
    )?;
    assert_eq!(
        service.consume(&f.scope, &ack, &accepted_proof)?,
        RetentionConsumeStatusV1::Consumed
    );
    assert_eq!(
        serde_json::to_value(service.store.transaction()?.state.charges.clone())?,
        serde_json::to_value(after_consume)?
    );
    let data = service.store.data()?;
    data.verify_retention_identity(&parent_identity)?;
    assert_eq!(
        read_exact(
            &data,
            &sibling.upload_leaf(),
            sibling.payload_identity.as_ref().unwrap()
        )?,
        sibling_bytes
    );
    assert_eq!(
        read_exact(
            &f.parent,
            &artifact.artifact_name,
            &artifact.artifact_identity
        )?,
        bytes
    );
    assert_eq!(
        TurnAttemptStore::open_existing(&session, "thread-a")?
            .unwrap()
            .list()?
            .len(),
        1
    );
    Ok(())
}

const CHILD_TEST: &str = "transfer::tests::owned_transfer_crash_child";

pub(super) fn pause(phase: &str, id: &str) {
    if std::env::var("KCODER_B5_TRANSFER_PHASE").ok().as_deref() != Some(phase) {
        return;
    }
    let root = PathBuf::from(
        std::env::var_os("KCODER_B5_TRANSFER_OWNED_ROOT").expect("owned helper root"),
    );
    let directory = PrivateDirectory::open_existing(&root).unwrap();
    directory
        .atomic_replace(
            OsStr::new("ready.json"),
            &serde_json::to_vec(&(phase, id)).unwrap(),
        )
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("owned parent failed to reap transfer crash helper");
}

#[test]
fn owned_transfer_crash_child() {
    if std::env::var_os("KCODER_B5_TRANSFER_OWNED_ROOT").is_none() {
        return;
    }
    let f = fixture();
    let root = PathBuf::from(std::env::var_os("KCODER_B5_TRANSFER_OWNED_ROOT").unwrap());
    PrivateDirectory::open_existing(&root)
        .unwrap()
        .atomic_replace(
            OsStr::new("fixture.json"),
            &serde_json::to_vec(&(f.temp.path(), &f.scope, &f.request, &f.lease.id)).unwrap(),
        )
        .unwrap();
    let input = f
        .service
        .prepare_retained_transfer(&f.scope, &[&f.lease], &f.request, &f.parent)
        .unwrap();
    let session = accepted(&f, input);
    let proof = proof(&f, &session);
    f.service
        .finish_retained_transfer(
            &f.scope,
            &[&f.lease],
            &f.request.references[0].retention_id,
            &f.parent,
            &proof,
        )
        .unwrap();
    panic!("armed crash helper missed its requested checkpoint");
}
struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

#[test]
fn sigkill_publishing_and_accepted_source_rename_recover_original_ids() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let base = kcoder_test_harness::workspace_root()
        .expect("resolve current workspace")
        .join("crates/kcoder_cli")
        .join("../..")
        .canonicalize()
        .unwrap()
        .join("target/test/crates/kcoder_cli/retention-transfer");
    PrivateDirectory::open_or_create(&base).unwrap();
    for phase in ["publishing", "published", "source-renamed", "source-gone"] {
        let temp = tempfile::Builder::new()
            .prefix("owned-crash-")
            .tempdir_in(&base)
            .unwrap();
        let root = temp.path().canonicalize().unwrap();
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", CHILD_TEST, "--nocapture"])
                .env("KCODER_B5_TRANSFER_OWNED_ROOT", &root)
                .env("KCODER_B5_TRANSFER_PHASE", phase)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let directory = PrivateDirectory::open_existing(&root).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if directory
                .open_regular_file(OsStr::new("ready.json"))
                .is_ok()
            {
                break;
            }
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "helper exited before {phase}"
            );
            assert!(
                Instant::now() < deadline,
                "owned helper deadline at {phase}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert_eq!(status.signal(), Some(9));
        let mut raw = Vec::new();
        directory
            .open_regular_file(OsStr::new("fixture.json"))
            .unwrap()
            .take(65_537)
            .read_to_end(&mut raw)
            .unwrap();
        assert!(raw.len() <= 65_536);
        let (path, scope, request, owner): (PathBuf, Scope, TransferRequest, String) =
            serde_json::from_slice(&raw).unwrap();
        assert_eq!(path.parent(), Some(root.as_path()));
        let service =
            RetentionService::open(&path.join("account"), true, Limits::default()).unwrap();
        let lease = service.recover_owner(&scope, &owner).unwrap().unwrap();
        let parent = PrivateDirectory::open_existing(&path.join("artifacts")).unwrap();
        let session = path.join("thread-a");
        if phase == "publishing" || phase == "published" {
            let input = service
                .prepare_retained_transfer(&scope, &[&lease], &request, &parent)
                .unwrap();
            let store = TurnAttemptStore::open(&session, "thread-a").unwrap();
            store
                .begin(TurnAttemptRecord {
                    version: 1,
                    identity: request.identity.clone(),
                    parent_attempt_id: None,
                    retry_operation_id: None,
                    accepted_at_ms: 1,
                    input_context_hash: digest(b"context"),
                    request_fingerprint: Some(request.request_fingerprint.clone()),
                    retained_input: Some(input),
                    client_presentation: None,
                    status: TurnAttemptStatus::Accepted,
                    completion: None,
                })
                .unwrap();
            map(&session, "turn-1", "message-1");
        }
        let proof = crate::acceptance::verified_retained_acceptance_in(
            &session,
            &scope,
            &request.identity,
            &request.client_message_id,
            &request.request_fingerprint,
            &parent,
        )
        .unwrap();
        let terminal = service
            .finish_retained_transfer(
                &scope,
                &[&lease],
                &request.references[0].retention_id,
                &parent,
                &proof,
            )
            .unwrap();
        assert_eq!(
            terminal.state,
            RetentionReceiptStateV1::Transferred,
            "phase {phase}"
        );
        assert_eq!(
            terminal.revision,
            request.references[0].expected_revision + 2
        );
        assert_eq!(
            service
                .store
                .transaction()
                .unwrap()
                .state
                .charges
                .transfer_bytes,
            0
        );
        assert_eq!(
            TurnAttemptStore::open_existing(&session, "thread-a")
                .unwrap()
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
    }
}
