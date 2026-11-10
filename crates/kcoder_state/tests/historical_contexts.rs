use kcoder_state::historical_contexts::*;
use kcoder_types::{
    historical_attachment::*, historical_context::*, imported_transcript::HistoricalRole,
    migration::MigrationSourceKind,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn fixture(data: &[Vec<u8>]) -> (HistoricalContextDocument, HistoricalContextBinding) {
    let attachments = data
        .iter()
        .enumerate()
        .map(|(index, data)| HistoricalContextAttachment {
            selection: HistoricalAttachmentSelection {
                job_id: "11111111-1111-4111-8111-111111111111".into(),
                view_id: Some("view".into()),
                position: index as u64,
                block_index: 0,
                tool_item_index: None,
            },
            source_array_index: None,
            receipt: HistoricalAttachmentReceipt {
                attachment_id: index.to_string(),
                bytes: data.len() as u64,
                sha256: digest(data),
                chunk_bytes: HISTORICAL_ATTACHMENT_CHUNK_BYTES as u32,
            },
            media_type: Some("application/octet-stream".into()),
            display_name: Some("../never-used-as-a-path.bin".into()),
            provenance: None,
        })
        .collect();
    let document = HistoricalContextDocument {
        revision: "inert-history-context/1".into(),
        source: MigrationSourceKind::ClaudeCode,
        source_job_id: "job".into(),
        view_id: "view".into(),
        attachments,
        entries: vec![HistoricalContextEntry {
            position: 0,
            block_index: 0,
            source_array_index: None,
            source_role: HistoricalRole::User,
            kind: HistoricalContextFactKind::Text,
            text: "历史正文😀".into(),
            call_id: None,
            name: None,
            namespace: None,
            outcome: None,
            execution_outcome: None,
        }],
    };
    let binding = HistoricalContextBinding {
        compiler_revision: document.revision.clone(),
        policy: Default::default(),
        branch_identity: "bound branch".into(),
        tool_links_sha256: None,
        attachments_sha256: digest(&serde_json::to_vec(&document.attachments).unwrap()),
        document_sha256: digest(&serde_json::to_vec(&document).unwrap()),
    };
    (document, binding)
}
fn identity() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn folder(profile: &Path, id: &str) -> PathBuf {
    profile.join("historical-contexts").join(id)
}
fn bytes(
    attachment: &HistoricalContextAttachment,
    offset: u64,
    limit: usize,
    data: &[Vec<u8>],
) -> anyhow::Result<Vec<u8>> {
    assert!(limit <= HISTORICAL_ATTACHMENT_CHUNK_BYTES);
    let source = &data[attachment.selection.position as usize];
    Ok(source[offset as usize..offset as usize + limit].to_vec())
}

#[test]
fn immutable_preparation_reopens_verifies_and_reads_arbitrary_authenticated_ranges_without_sources()
{
    let profile = tempfile::tempdir().unwrap();
    assert!(
        HistoricalContextStore::open_existing(profile.path())
            .unwrap()
            .is_none()
    );
    assert_eq!(fs::read_dir(profile.path()).unwrap().count(), 0);
    let data = vec![
        (0..(HISTORICAL_ATTACHMENT_CHUNK_BYTES + 31))
            .map(|index| (index % 251) as u8)
            .collect(),
        vec![],
    ];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let receipt = store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    assert_eq!(receipt.attachments, 2);
    assert_eq!(receipt.attachment_bytes, data[0].len() as u64);
    assert!(!profile.path().join("sessions").exists());
    assert!(!profile.path().join("never-used-as-a-path.bin").exists());
    assert!(
        !profile
            .path()
            .join("historical-contexts/never-used-as-a-path.bin")
            .exists()
    );
    let context = store.verify(&id, |_| true).unwrap();
    assert!(context.document == document && context.binding == binding);
    let reader = store.reader(&id, |_| true).unwrap();
    assert_eq!(reader.context().receipt, receipt);
    let start = HISTORICAL_ATTACHMENT_CHUNK_BYTES - 7;
    assert_eq!(
        reader.attachment_chunk(0, start as u64, 22).unwrap(),
        data[0][start..start + 22]
    );
    assert_eq!(reader.attachment_chunk(1, 0, 1).unwrap(), Vec::<u8>::new());
    assert!(
        reader
            .attachment_chunk(0, 0, HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1)
            .is_err()
    );
    assert!(reader.attachment_chunk(2, 0, 1).is_err());
    let reopened = HistoricalContextStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        reopened
            .prepare(
                &id,
                &document,
                &binding,
                |_, _, _| panic!("ready data must not be fetched again"),
                |_| true
            )
            .unwrap(),
        receipt
    );
}

#[test]
fn cancellation_leaves_completed_files_reusable_and_never_seals_a_partial_copy() {
    let profile = tempfile::tempdir().unwrap();
    let data = vec![vec![1; 17], vec![2; HISTORICAL_ATTACHMENT_CHUNK_BYTES + 77]];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let result = store.prepare(
        &id,
        &document,
        &binding,
        |a, o, l| bytes(a, o, l, &data),
        |p| {
            p.attachment_index != Some(1)
                || p.processed_bytes < HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64
        },
    );
    assert!(result.is_err());
    assert!(!folder(profile.path(), &id).join("receipt.json").exists());
    assert!(
        folder(profile.path(), &id)
            .join("attachment-0000.bin")
            .exists()
    );
    assert!(
        !folder(profile.path(), &id)
            .join("attachment-0001.bin")
            .exists()
    );
    assert!(store.verify(&id, |_| true).is_err());
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| {
                assert_eq!(a.selection.position, 1);
                bytes(a, o, l, &data)
            },
            |_| true,
        )
        .unwrap();
    assert!(store.verify(&id, |_| false).is_err());
    assert!(store.verify(&id, |_| true).is_ok());
}

#[test]
fn lost_receipts_are_reconciled_from_exact_owned_files_without_overwriting_or_refetching() {
    let profile = tempfile::tempdir().unwrap();
    let data = vec![vec![3; 101]];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let receipt = store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let path = folder(profile.path(), &id);
    let modified = fs::metadata(path.join("attachment-0000.bin"))
        .unwrap()
        .modified()
        .unwrap();
    fs::remove_file(path.join("attachment-0000.json")).unwrap();
    fs::remove_file(path.join("receipt.json")).unwrap();
    assert_eq!(
        store
            .prepare(
                &id,
                &document,
                &binding,
                |_, _, _| panic!("a lost receipt is not permission to fetch again"),
                |_| true
            )
            .unwrap(),
        receipt
    );
    assert_eq!(
        fs::metadata(path.join("attachment-0000.bin"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
}

#[test]
fn wrong_or_truncated_streams_never_publish_and_saved_corruption_is_not_repaired() {
    let profile = tempfile::tempdir().unwrap();
    let data = vec![vec![9; HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1]];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    for truncated in [false, true] {
        let result = store.prepare(
            &id,
            &document,
            &binding,
            |_, _, limit| Ok(vec![0; if truncated { limit - 1 } else { limit }]),
            |_| true,
        );
        assert!(result.is_err());
        assert!(
            !folder(profile.path(), &id)
                .join("attachment-0000.bin")
                .exists()
        );
    }
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let cached = store.reader(&id, |_| true).unwrap();
    let path = folder(profile.path(), &id).join("attachment-0000.bin");
    let mut changed = data[0].clone();
    changed[0] = 8;
    fs::write(&path, &changed).unwrap();
    assert!(
        store
            .prepare(
                &id,
                &document,
                &binding,
                |_, _, _| panic!("corrupt published data must not be replaced"),
                |_| true
            )
            .is_err()
    );
    assert!(cached.attachment_chunk(0, 0, 1).is_err());
    assert!(store.reader(&id, |_| true).is_err());
    assert_eq!(fs::read(path).unwrap(), changed);
}

#[test]
fn changed_selection_documents_or_seals_are_not_adopted_and_metadata_errors_do_not_echo_content() {
    let profile = tempfile::tempdir().unwrap();
    let (document, binding) = fixture(&[]);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    store
        .prepare(&id, &document, &binding, |_, _, _| unreachable!(), |_| true)
        .unwrap();
    let mut changed = binding.clone();
    changed.branch_identity = "another selection".into();
    assert!(
        store
            .prepare(&id, &document, &changed, |_, _, _| unreachable!(), |_| true)
            .is_err()
    );
    let path = folder(profile.path(), &id);
    let previous = fs::read(path.join("document.json")).unwrap();
    fs::write(path.join("document.json"), b"secret raw invalid text").unwrap();
    let error = store.verify(&id, |_| true).err().unwrap().to_string();
    assert!(!error.contains("secret raw"));
    fs::write(path.join("document.json"), previous).unwrap();
    let mut seal: serde_json::Value =
        serde_json::from_slice(&fs::read(path.join("receipt.json")).unwrap()).unwrap();
    seal["value"]["attachments"] = json!(1);
    fs::write(
        path.join("receipt.json"),
        serde_json::to_vec(&seal).unwrap(),
    )
    .unwrap();
    assert!(store.verify(&id, |_| true).is_err());
}

#[test]
fn committed_asset_receipts_do_not_authorize_recreating_missing_payloads() {
    let profile = tempfile::tempdir().unwrap();
    let data = vec![vec![7; 3]];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let path = folder(profile.path(), &id);
    fs::remove_file(path.join("receipt.json")).unwrap();
    fs::remove_file(path.join("attachment-0000.bin")).unwrap();
    assert!(
        store
            .prepare(
                &id,
                &document,
                &binding,
                |_, _, _| panic!("published payload loss is corruption"),
                |_| true
            )
            .is_err()
    );
}

#[test]
#[cfg(target_os = "linux")]
fn preparation_budget_accounts_for_unreceipted_and_abandoned_files_before_copying() {
    let profile = tempfile::tempdir().unwrap();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let orphan = folder(profile.path(), &identity());
    fs::create_dir(&orphan).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&orphan, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let file = fs::File::create(orphan.join("unreceipted.bin")).unwrap();
    file.set_len(MAX_CONTEXT_PREPARATION_BYTES).unwrap();
    let (document, binding) = fixture(&[]);
    let id = identity();
    let error = store
        .prepare(&id, &document, &binding, |_, _, _| unreachable!(), |_| true)
        .err()
        .unwrap()
        .to_string();
    assert_eq!(error, "history_context_store_budget_exceeded");
    assert!(!folder(profile.path(), &id).exists());
    assert!(orphan.join("unreceipted.bin").exists());
}

#[cfg(unix)]
#[test]
fn copied_profiles_unknown_directories_and_linked_payloads_never_gain_preparation_authority() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let profile = tempfile::tempdir().unwrap();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let (document, binding) = fixture(&[vec![6; 3]]);
    let id = identity();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |_, _, limit| Ok(vec![6; limit]),
            |_| true,
        )
        .unwrap();
    let root = profile.path().join("historical-contexts");
    let unknown = identity();
    fs::create_dir(root.join(&unknown)).unwrap();
    fs::set_permissions(root.join(&unknown), fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        store
            .prepare(
                &unknown,
                &document,
                &binding,
                |_, _, _| unreachable!(),
                |_| true
            )
            .is_err()
    );
    assert_eq!(fs::read_dir(root.join(&unknown)).unwrap().count(), 0);
    let peer = tempfile::tempdir().unwrap();
    let target = peer.path().join("historical-contexts");
    fs::create_dir(&target).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
    fs::copy(root.join("owner.json"), target.join("owner.json")).unwrap();
    assert!(HistoricalContextStore::open_existing(peer.path()).is_err());
    let payload = folder(profile.path(), &id).join("attachment-0000.bin");
    let original = profile.path().join("original.bin");
    fs::rename(&payload, &original).unwrap();
    symlink(&original, &payload).unwrap();
    assert!(store.verify(&id, |_| true).is_err());
    fs::remove_file(&payload).unwrap();
    fs::hard_link(&original, &payload).unwrap();
    assert!(store.verify(&id, |_| true).is_err());
    assert_eq!(fs::read(original).unwrap(), [6, 6, 6]);
}

#[test]
fn chunk_tables_are_bound_to_the_opened_receipt_and_consistent_corruption_still_fails_full_verification()
 {
    let profile = tempfile::tempdir().unwrap();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let data = vec![vec![5; 31]];
    let (document, binding) = fixture(&data);
    let id = identity();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let reader = store.reader(&id, |_| true).unwrap();
    let path = folder(profile.path(), &id);
    let changed = vec![4; 31];
    fs::write(path.join("attachment-0000.bin"), &changed).unwrap();
    let mut asset: serde_json::Value =
        serde_json::from_slice(&fs::read(path.join("attachment-0000.json")).unwrap()).unwrap();
    asset["chunks"][0] = json!(digest(&changed));
    let encoded = serde_json::to_vec(&asset).unwrap();
    fs::write(path.join("attachment-0000.json"), &encoded).unwrap();
    assert!(reader.attachment_chunk(0, 0, 1).is_err());
    assert!(store.reader(&id, |_| true).is_err());
    let mut seal: serde_json::Value =
        serde_json::from_slice(&fs::read(path.join("receipt.json")).unwrap()).unwrap();
    seal["asset_receipts_sha256"][0] = json!(digest(&encoded));
    fs::write(
        path.join("receipt.json"),
        serde_json::to_vec(&seal).unwrap(),
    )
    .unwrap();
    assert!(reader.attachment_chunk(0, 0, 1).is_err());
    assert!(store.reader(&id, |_| true).is_err());
}

#[test]
fn a_copy_owns_only_its_preparation_and_does_not_block_ready_readers_or_replace_peer_work() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;
    let profile = tempfile::tempdir().unwrap();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    let (document, binding) = fixture(&[vec![8; 17]]);
    let first = identity();
    store
        .prepare(
            &first,
            &document,
            &binding,
            |_, _, limit| Ok(vec![8; limit]),
            |_| true,
        )
        .unwrap();
    let owned = identity();
    let worker_profile = profile.path().to_owned();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancelled = cancel.clone();
    let (started, waiting) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let doc = document.clone();
    let proof = binding.clone();
    let copy_id = owned.clone();
    let worker = std::thread::spawn(move || {
        HistoricalContextStore::open_existing(&worker_profile)
            .unwrap()
            .unwrap()
            .prepare(
                &copy_id,
                &doc,
                &proof,
                |_, _, limit| {
                    started.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(vec![8; limit])
                },
                |_| !cancelled.load(Ordering::Acquire),
            )
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    let observer = HistoricalContextStore::open_existing(profile.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        observer
            .reader(&first, |_| true)
            .unwrap()
            .attachment_chunk(0, 0, 17)
            .unwrap(),
        vec![8; 17]
    );
    let peer = identity();
    let error = observer
        .prepare(
            &peer,
            &document,
            &binding,
            |_, _, _| unreachable!(),
            |_| true,
        )
        .err()
        .unwrap()
        .to_string();
    assert_eq!(error, "history_context_preparation_busy");
    assert!(!folder(profile.path(), &peer).exists());
    cancel.store(true, Ordering::Release);
    release.send(()).unwrap();
    assert!(worker.join().unwrap().is_err());
    assert!(!folder(profile.path(), &owned).join("receipt.json").exists());
    assert!(observer.verify(&first, |_| true).is_ok());
}

#[test]
fn delivery_copies_keep_legacy_receipts_and_use_safe_extensions_in_the_new_owner() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let data = vec![b"document bytes".to_vec()];
    let (mut document, mut binding) = fixture(&data);
    document.attachments[0].media_type = Some("APPLICATION/PDF".into());
    binding.attachments_sha256 = digest(&serde_json::to_vec(&document.attachments).unwrap());
    binding.document_sha256 = digest(&serde_json::to_vec(&document).unwrap());
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let original = fs::read(folder(profile.path(), &id).join("intent.json")).unwrap();
    assert!(
        serde_json::from_slice::<serde_json::Value>(&original)
            .unwrap()
            .get("delivery_names")
            .is_none()
    );
    let reader = store.reader(&id, |_| true).unwrap();
    let copied = reader.copy_to(target.path(), |_| true).unwrap();
    assert_eq!(copied.context().receipt, reader.context().receipt);
    assert_eq!(
        reader.attachment_path(0).unwrap().extension().unwrap(),
        "bin"
    );
    let path = copied.attachment_path(0).unwrap();
    assert!(path.starts_with(target.path()));
    assert_eq!(path.extension().unwrap(), "pdf");
    assert_eq!(fs::read(&path).unwrap(), data[0]);
    assert_eq!(
        fs::read(folder(profile.path(), &id).join("intent.json")).unwrap(),
        original
    );
    fs::remove_dir_all(profile.path()).unwrap();
    assert!(copied.verify_current(|_| true).is_ok());
    assert_eq!(copied.attachment_chunk(0, 0, 2).unwrap(), b"do");
}

#[test]
fn exported_paths_reject_a_replaced_directory_and_copies_can_be_cancelled() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let data = vec![vec![9; HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1]];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let reader = store.reader(&id, |_| true).unwrap();
    assert!(
        reader
            .copy_to(target.path(), |progress| progress.processed_bytes
                < HISTORICAL_ATTACHMENT_CHUNK_BYTES as u64)
            .is_err()
    );
    let copied = reader.copy_to(target.path(), |_| true).unwrap();
    let path = copied.attachment_path(0).unwrap();
    let directory = path.parent().unwrap();
    fs::rename(directory, directory.with_file_name(identity())).unwrap();
    let parent =
        kcoder_config::PrivateDirectory::open_existing(directory.parent().unwrap()).unwrap();
    parent
        .create_private_child(directory.file_name().unwrap())
        .unwrap();
    assert!(copied.attachment_path(0).is_err());
    assert!(copied.verify_current(|_| true).is_err());
    assert!(reader.verify_current(|_| true).is_ok());
}

#[test]
fn a_bound_copy_rejects_the_wrong_owner_before_creating_target_storage() {
    let profile = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let data = vec![b"data".to_vec()];
    let (document, binding) = fixture(&data);
    let id = identity();
    let store = HistoricalContextStore::open(profile.path()).unwrap();
    store
        .prepare(
            &id,
            &document,
            &binding,
            |a, o, l| bytes(a, o, l, &data),
            |_| true,
        )
        .unwrap();
    let source = store.reader(&id, |_| true).unwrap();
    let owner = kcoder_config::PrivateDirectory::open_existing(target.path()).unwrap();
    assert!(source.copy_to_bound(peer.path(), &owner, |_| true).is_err());
    assert!(!peer.path().join("historical-contexts").exists());
    assert!(
        source
            .copy_to_bound(target.path(), &owner, |_| true)
            .is_ok()
    );
}
