use kcoder_config::PrivateDirectory;
use kcoder_state::external_history::{
    ExternalHistoryReader, ExternalHistoryStore, local_attachment::SelectedLocalFile,
};
use kcoder_types::{
    external_history::*, historical_attachment::*, local_attachment::*,
    migration::MigrationSourceKind,
};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
struct Fixture {
    root: tempfile::TempDir,
    archive: String,
    source: PathBuf,
}
impl Fixture {
    fn new(bytes: &[u8]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("chosen");
        PrivateDirectory::open_or_create(&source).unwrap();
        fs::write(source.join("report.bin"), bytes).unwrap();
        let store = ExternalHistoryStore::open(root.path()).unwrap();
        let input = b"{\"historical\":true}\n";
        let snapshot = ExternalHistorySnapshot {
            original: None,
            source_bytes: input.len() as u64,
            source_sha256: format!("{:x}", Sha256::digest(input)),
            record_limit: EXTERNAL_HISTORY_MAX_RECORDS,
            origin: ExternalHistoryOrigin {
                source: MigrationSourceKind::Codex,
                source_instance: "fixture".into(),
                source_session_id: "s".into(),
                source_artifact_id: None,
                source_format: "fixture".into(),
                adapter_revision: "fixture".into(),
                title: None,
                created_at: None,
                updated_at: None,
                project: None,
                archived: false,
                parent_session_id: None,
            },
        };
        let mut import = store.begin("owned-local-fixture", &snapshot).unwrap();
        import
            .stage_source(&mut Cursor::new(input), &mut |_| true)
            .unwrap();
        let archive = import.finish(&mut |_| true).unwrap().receipt.archive_id;
        Self {
            root,
            archive,
            source,
        }
    }
    fn reader(&self) -> ExternalHistoryReader {
        ExternalHistoryStore::open(self.root.path())
            .unwrap()
            .reader(&self.archive)
            .unwrap()
    }
    fn selected(&self) -> SelectedLocalFile {
        SelectedLocalFile::select(&self.source, Path::new("report.bin"), true, |_| true).unwrap()
    }
    fn blob(&self, id: &str) -> PathBuf {
        self.root
            .path()
            .join("external-history")
            .join(&self.archive)
            .join("attachments-v1")
            .join(id)
    }
    fn operation(&self, id: &str) -> PathBuf {
        self.root
            .path()
            .join("external-history")
            .join(&self.archive)
            .join("local-attachments-v1")
            .join(id)
    }
}
fn key() -> String {
    uuid::Uuid::new_v4().to_string()
}
#[test]
fn explicit_selection_copies_exact_bytes_and_reopens_without_the_source() {
    let bytes: Vec<u8> = (0..700001).map(|i| (i % 251) as u8).collect();
    let fixture = Fixture::new(&bytes);
    let reader = fixture.reader();
    let id = key();
    let reference = "a".repeat(64);
    let import = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let selected = fixture.selected();
    let authorized = import.authorize(&reference, &selected).unwrap();
    assert!(authorized.stage == HistoricalLocalAttachmentStage::Authorized);
    let ready = import
        .run(&reference, authorized.sequence, |_| true)
        .unwrap();
    assert!(ready.stage == HistoricalLocalAttachmentStage::Ready);
    let receipt = ready.receipt.clone().unwrap();
    assert_eq!(receipt.bytes, bytes.len() as u64);
    drop(import);
    drop(reader);
    fs::remove_dir_all(&fixture.source).unwrap();
    let reader = fixture.reader();
    let reopened = reader.local_attachment_import(&id, false).unwrap().unwrap();
    assert!(reopened.view(&reference).unwrap().stage == HistoricalLocalAttachmentStage::Ready);
    let at = HISTORICAL_ATTACHMENT_CHUNK_BYTES - 11;
    assert_eq!(
        reopened
            .read_chunk(&reference, &receipt, at as u64, 50)
            .unwrap(),
        bytes[at..at + 50]
    );
    assert!(
        reopened
            .read_chunk(
                &reference,
                &receipt,
                0,
                HISTORICAL_ATTACHMENT_CHUNK_BYTES + 1
            )
            .is_err()
    );
    let value = serde_json::to_string(&ready).unwrap();
    assert!(!value.contains(fixture.source.to_str().unwrap()));
    assert!(!value.contains("report.bin"));
    assert!(reopened.view(&"b".repeat(64)).is_err());
}
#[test]
fn changed_or_replaced_sources_and_cancelled_copy_never_publish_an_attachment() {
    for change in 0..4 {
        let fixture = Fixture::new(&vec![5u8; 400000]);
        let reader = fixture.reader();
        let id = key();
        let reference = "b".repeat(64);
        let import = reader.local_attachment_import(&id, true).unwrap().unwrap();
        let selected = fixture.selected();
        let initial = import.authorize(&reference, &selected).unwrap();
        if change == 0 {
            let file = fixture.source.join("report.bin");
            let modified = fs::metadata(&file).unwrap().modified().unwrap();
            fs::write(&file, vec![6u8; 400000]).unwrap();
            fs::File::open(&file)
                .unwrap()
                .set_modified(modified)
                .unwrap();
        }
        if change == 1 {
            fs::rename(
                fixture.source.join("report.bin"),
                fixture.source.join("previous.bin"),
            )
            .unwrap();
            fs::write(fixture.source.join("report.bin"), vec![5u8; 400000]).unwrap();
        }
        if change == 2 {
            fs::rename(&fixture.source, fixture.root.path().join("old-root")).unwrap();
            PrivateDirectory::open_or_create(&fixture.source).unwrap();
            fs::write(fixture.source.join("report.bin"), vec![5u8; 400000]).unwrap();
        }
        let mut mutated = false;
        let result = import
            .run(&reference, initial.sequence, |at| {
                if change == 3 && at >= 65536 && !mutated {
                    fs::write(fixture.source.join("report.bin"), vec![9u8; 400000]).unwrap();
                    mutated = true;
                }
                true
            })
            .unwrap();
        assert!(
            result.stage == HistoricalLocalAttachmentStage::SourceChanged,
            "unexpected outcome"
        );
        assert!(result.receipt.is_none());
    }
    let fixture = Fixture::new(&vec![8u8; 700000]);
    let reader = fixture.reader();
    let id = key();
    let reference = "c".repeat(64);
    let import = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let authorized = import.authorize(&reference, &fixture.selected()).unwrap();
    let stopped = import
        .run(&reference, authorized.sequence, |at| at < 100000)
        .unwrap();
    assert!(stopped.stage == HistoricalLocalAttachmentStage::Cancelled);
    assert!(stopped.receipt.is_none());
    assert!(
        import
            .run(&reference, authorized.sequence, |_| true)
            .is_err()
    );
    assert!(
        import
            .run(&reference, stopped.sequence, |_| true)
            .unwrap()
            .stage
            == HistoricalLocalAttachmentStage::Ready
    );
}
#[test]
fn a_missing_native_receipt_recovers_only_owned_bytes_even_after_source_disappears() {
    let fixture = Fixture::new(b"owned selected snapshot");
    let reader = fixture.reader();
    let id = key();
    let reference = "d".repeat(64);
    let import = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let authorized = import.authorize(&reference, &fixture.selected()).unwrap();
    let ready = import
        .run(&reference, authorized.sequence, |_| true)
        .unwrap();
    let receipt = ready.receipt.unwrap();
    drop(import);
    fs::remove_file(fixture.blob(&receipt.attachment_id).join("receipt.json")).unwrap();
    fs::remove_file(fixture.operation(&id).join("state.json")).unwrap();
    fs::remove_dir_all(&fixture.source).unwrap();
    let observer = reader.local_attachment_import(&id, false).unwrap().unwrap();
    let unknown = observer.view(&reference).unwrap();
    assert!(unknown.stage == HistoricalLocalAttachmentStage::OutcomeUnknown);
    assert!(
        !fixture
            .blob(&receipt.attachment_id)
            .join("receipt.json")
            .exists()
    );
    assert!(observer.read_chunk(&reference, &receipt, 0, 5).is_err());
    let cancelled = observer.cancel(&reference).unwrap();
    assert!(cancelled.stage == HistoricalLocalAttachmentStage::OutcomeUnknown);
    drop(observer);
    let owner = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let done = owner.run(&reference, cancelled.sequence, |_| true).unwrap();
    assert!(done.stage == HistoricalLocalAttachmentStage::Ready);
    assert_eq!(done.receipt, Some(receipt.clone()));
    assert_eq!(
        owner.read_chunk(&reference, &receipt, 0, 256).unwrap(),
        b"owned selected snapshot"
    );
}
#[test]
fn orphan_or_modified_owned_payload_is_never_guessed_into_a_new_receipt() {
    let fixture = Fixture::new(b"original payload");
    let reader = fixture.reader();
    let id = key();
    let reference = "e".repeat(64);
    let import = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let first = import.authorize(&reference, &fixture.selected()).unwrap();
    let done = import.run(&reference, first.sequence, |_| true).unwrap();
    let receipt = done.receipt.unwrap();
    fs::remove_file(fixture.blob(&receipt.attachment_id).join("receipt.json")).unwrap();
    fs::write(
        fixture.blob(&receipt.attachment_id).join("payload.bin"),
        b"different bytes!",
    )
    .unwrap();
    let unknown = import.run(&reference, done.sequence, |_| true).unwrap();
    assert!(unknown.stage == HistoricalLocalAttachmentStage::OutcomeUnknown);
    assert!(unknown.receipt.is_none());
    assert!(
        !fixture
            .blob(&receipt.attachment_id)
            .join("receipt.json")
            .exists()
    );
    assert_eq!(
        fs::read(fixture.blob(&receipt.attachment_id).join("payload.bin")).unwrap(),
        b"different bytes!"
    );
}
#[test]
fn consent_path_boundaries_sensitive_files_limits_and_symlinks_are_rejected() {
    let fixture = Fixture::new(b"small");
    assert!(
        SelectedLocalFile::select(
            Path::new("/not-a-selected-root"),
            Path::new("x"),
            false,
            |_| panic!("no source access before selection")
        )
        .err()
        .unwrap()
        .to_string()
        .contains("explicit_selection_required")
    );
    for relative in ["../chosen/report.bin", "/absolute", ".env", "auth.json"] {
        assert!(
            SelectedLocalFile::select(&fixture.source, Path::new(relative), true, |_| true)
                .is_err()
        );
    }
    let huge = fs::File::create(fixture.source.join("huge.bin")).unwrap();
    huge.set_len(HISTORICAL_ATTACHMENT_MAX_BYTES + 1).unwrap();
    assert!(
        SelectedLocalFile::select(&fixture.source, Path::new("huge.bin"), true, |_| true).is_err()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink("report.bin", fixture.source.join("linked.bin")).unwrap();
        assert!(
            SelectedLocalFile::select(&fixture.source, Path::new("linked.bin"), true, |_| true)
                .is_err()
        );
        symlink(&fixture.source, fixture.root.path().join("linked-root")).unwrap();
        assert!(
            SelectedLocalFile::select(
                &fixture.root.path().join("linked-root"),
                Path::new("report.bin"),
                true,
                |_| true
            )
            .is_err()
        );
        fs::hard_link(
            fixture.source.join("report.bin"),
            fixture.source.join("hard.bin"),
        )
        .unwrap();
        assert!(fixture.selected_result().is_err());
    }
}
impl Fixture {
    fn selected_result(&self) -> anyhow::Result<SelectedLocalFile> {
        SelectedLocalFile::select(&self.source, Path::new("report.bin"), true, |_| true)
    }
}

#[test]
fn read_only_observation_never_recreates_a_missing_or_replaced_owner_lock() {
    let fixture = Fixture::new(b"owned reference");
    let reader = fixture.reader();
    let id = key();
    let reference = "f".repeat(64);
    let owner = reader.local_attachment_import(&id, true).unwrap().unwrap();
    owner.authorize(&reference, &fixture.selected()).unwrap();
    drop(owner);
    // Reproduce a crashed Copying projection without any native payload or live owner.
    let progress = fixture.operation(&id).join("state.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&progress).unwrap()).unwrap();
    value["stage"] = serde_json::json!("copying");
    fs::write(progress, serde_json::to_vec(&value).unwrap()).unwrap();
    let lock = fixture.operation(&id).join("writer.lock");
    fs::rename(&lock, fixture.operation(&id).join("previous-writer.lock")).unwrap();
    let observer = reader.local_attachment_import(&id, false).unwrap().unwrap();
    assert!(observer.view(&reference).is_err());
    assert!(!lock.exists());
    assert!(observer.cancel(&reference).is_err());
    assert!(!lock.exists());
    assert!(reader.local_attachment_import(&id, true).is_err());
    assert!(!lock.exists());
    fs::write(&lock, b"replacement owner is not authorized").unwrap();
    assert!(observer.view(&reference).is_err());
    assert!(reader.local_attachment_import(&id, true).is_err());
    assert_eq!(
        fs::read(lock).unwrap(),
        b"replacement owner is not authorized"
    );
}

#[test]
fn lost_payload_and_receipt_cannot_keep_a_cached_ready_state() {
    let fixture = Fixture::new(b"selected bytes");
    let reader = fixture.reader();
    let id = key();
    let reference = "1".repeat(64);
    let owner = reader.local_attachment_import(&id, true).unwrap().unwrap();
    let authorized = owner.authorize(&reference, &fixture.selected()).unwrap();
    let ready = owner
        .run(&reference, authorized.sequence, |_| true)
        .unwrap();
    let blob = fixture.blob(&ready.receipt.unwrap().attachment_id);
    fs::remove_file(blob.join("receipt.json")).unwrap();
    fs::remove_file(blob.join("payload.bin")).unwrap();
    fs::remove_dir_all(&fixture.source).unwrap();
    let observed = owner.view(&reference).unwrap();
    assert!(observed.stage == HistoricalLocalAttachmentStage::OutcomeUnknown);
    assert!(observed.receipt.is_none());
    let recovered = owner.run(&reference, observed.sequence, |_| true).unwrap();
    assert!(recovered.stage == HistoricalLocalAttachmentStage::SelectionRequired);
    assert!(recovered.receipt.is_none());
}
