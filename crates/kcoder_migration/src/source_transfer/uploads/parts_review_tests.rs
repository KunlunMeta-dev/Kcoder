use super::*;
use kcoder_types::migration::MigrationSourceKind;

#[test]
fn a_zero_byte_append_with_a_lost_reply_keeps_its_original_part_intent() {
    let root = tempfile::tempdir().unwrap();
    let store = SourceUploads::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let bytes = b"original synthetic upload bytes";
    store
        .prepare(
            &id,
            SourceUploadManifest {
                version: 1,
                source: MigrationSourceKind::Codex,
                files: vec![SourceUploadFile {
                    relative_path: "AGENTS.md".into(),
                    bytes: bytes.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(bytes)),
                }],
            },
        )
        .unwrap();
    FAIL_PART_AFTER_BYTES.with(|value| value.set(Some(0)));
    assert!(store.part(&id, 0, 0, 0, bytes).is_err());
    let (directory, _) = store.selected(&id).unwrap();
    let intent_name = "upload-file-0000.pending.json";
    let original: PendingPart = load(&directory, intent_name).unwrap().unwrap();
    assert_eq!(
        directory
            .open_single_link_regular_file(OsStr::new(&payload(0)))
            .unwrap()
            .metadata()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(store.read(&id).unwrap().received_bytes, 0);

    drop(store);
    let reopened = SourceUploads::open_existing(root.path()).unwrap();
    assert!(
        reopened
            .part(&id, 0, 0, 0, &vec![b'!'; bytes.len()])
            .is_err(),
        "an unacknowledged durable part intent cannot be replaced just because zero bytes reached the file"
    );
    let observed: PendingPart = load(&directory, intent_name).unwrap().unwrap();
    assert!(observed == original);
    assert_eq!(reopened.read(&id).unwrap().received_bytes, 0);
    assert_eq!(
        reopened.part(&id, 0, 0, 0, bytes).unwrap().received_bytes,
        bytes.len() as u64
    );
    assert_eq!(
        reopened.finish(&id, 0, |_, _| true).unwrap().stage,
        SourceUploadStage::Ready
    );
}
