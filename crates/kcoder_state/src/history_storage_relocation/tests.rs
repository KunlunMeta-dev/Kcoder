use super::*;
use crate::{external_history::ExternalHistoryStore, historical_contexts::HistoricalContextStore};
use kcoder_config::storage::{
    StorageComponentDirectory, StorageCoordinator, StorageResolveInput, resolve_storage_paths,
};
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationComponent, StorageMigrationPhase,
    StorageMigrationPlan, StorageTargetBinding, external_history::*, historical_context::*,
    imported_transcript::HistoricalRole, migration::MigrationSourceKind,
};
use std::{collections::BTreeSet, fs};

std::thread_local! {
    static FINGERPRINT_READS: std::cell::RefCell<Option<Vec<(String, String, u64)>>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn record_fingerprint_read(
    directory: &PrivateDirectory,
    name: &str,
    bytes: u64,
) -> Result<()> {
    FINGERPRINT_READS.with_borrow_mut(|reads| {
        if let Some(reads) = reads {
            reads.push((directory.directory_identity()?, name.into(), bytes));
        }
        Ok(())
    })
}

struct FingerprintReads;
impl FingerprintReads {
    fn start() -> Self {
        FINGERPRINT_READS.with_borrow_mut(|reads| *reads = Some(Vec::new()));
        Self
    }

    fn for_file(&self, directory: &PrivateDirectory, name: &str) -> Result<(usize, u64)> {
        let identity = directory.directory_identity()?;
        Ok(FINGERPRINT_READS.with_borrow(|reads| {
            reads
                .as_ref()
                .unwrap()
                .iter()
                .filter(|(parent, leaf, _)| *parent == identity && leaf == name)
                .fold((0, 0), |(count, bytes), (_, _, size)| {
                    (count + 1, bytes + size)
                })
        }))
    }
}
impl Drop for FingerprintReads {
    fn drop(&mut self) {
        FINGERPRINT_READS.with_borrow_mut(|reads| *reads = None);
    }
}

#[test]
fn a_bare_history_lock_stays_exclusive_without_a_persistent_identity_mapping() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let source = owned.path().join("source");
    let target = owned.path().join("target");
    let history = PrivateDirectory::open_or_create(&source.join("history"))?;
    let lock = history.open_read_write_file(OsStr::new(".kcoder-history.lock"), true)?;
    fs2::FileExt::try_lock_exclusive(&lock)?;
    assert!(
        HistoryStorageRelocation::snapshot(&source)
            .unwrap_err()
            .to_string()
            .contains("HISTORY_RELOCATION_OWNER_BUSY")
    );
    drop(lock);

    let snapshot = HistoryStorageRelocation::snapshot(&source)?;
    let (_control, mut _coordinator, published) =
        published_copy(&source, &target, "bare-runtime-lock")?;
    HistoryStorageRelocation::relocate(
        &source,
        &target,
        "bare-runtime-lock",
        &snapshot,
        &published,
    )?;
    complete_published_copy(&mut _coordinator, "bare-runtime-lock")?;
    HistoryStorageRelocation::verify_relocation(
        &source,
        &target,
        "bare-runtime-lock",
        &snapshot,
        &published,
    )?;
    assert!(target.join("history/.kcoder-history.lock").is_file());
    assert!(!target.join("history").join(RECORD).exists());
    Ok(())
}

/// The same production staging/copy/publication boundary used by the host. No
/// test constructor can manufacture the opaque published-component capability.
pub(super) fn published_copy(
    source: &Path,
    target: &Path,
    operation: &str,
) -> Result<(
    tempfile::TempDir,
    StorageCoordinator,
    StoragePublishedComponent,
)> {
    let control = tempfile::tempdir()?;
    let home = control.path().join("control-home");
    PrivateDirectory::open_or_create(&home)?;
    let parent = target.parent().context("fixture missing target parent")?;
    let parent_directory = PrivateDirectory::open_or_create(parent)?;
    let source_directory = PrivateDirectory::open_existing(source)?;
    let from = resolve_storage_paths(&StorageResolveInput {
        home: Some(home.clone()),
        ..Default::default()
    })?;
    let plan = StorageMigrationPlan {
        version: 1,
        operation_id: operation.into(),
        original: None,
        from,
        target: StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: target.into(),
            cache_root: control.path().join("cache"),
            operation_id: Some(operation.into()),
        },
        components: vec![StorageMigrationComponent {
            domain: kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
            source: source.into(),
            destination: target.into(),
            source_identity: source_directory.directory_identity()?,
            estimated_bytes: 0,
        }],
        target_bindings: vec![StorageTargetBinding {
            path: target.into(),
            existing_ancestor: parent.into(),
            ancestor_identity: parent_directory.directory_identity()?,
        }],
        launch_intent: StorageLaunchIntent::VerifyOnly,
    };
    let mut coordinator = StorageCoordinator::acquire(&home)?;
    coordinator.begin(plan)?;
    coordinator.advance(
        operation,
        StorageMigrationPhase::Planned,
        StorageMigrationPhase::Stopping,
    )?;
    coordinator.advance(
        operation,
        StorageMigrationPhase::Stopping,
        StorageMigrationPhase::Stopped,
    )?;
    coordinator.advance(
        operation,
        StorageMigrationPhase::Stopped,
        StorageMigrationPhase::Copying,
    )?;
    let staging = match coordinator
        .prepare_component_staging(operation, kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN)?
    {
        StorageComponentDirectory::Staging(directory) => directory,
        other => anyhow::bail!("unexpected test publication stage: {other:?}"),
    };
    coordinator.copy_component(
        operation,
        kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
        &staging,
        &BTreeSet::new(),
    )?;
    coordinator.publish_component(
        operation,
        kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
        &BTreeSet::new(),
    )?;
    let published = coordinator
        .open_published_component(operation, kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN)?;
    Ok((control, coordinator, published))
}

/// Close the original publication transaction before opening ordinary business
/// stores or using its target as the source of another migration.
pub(super) fn complete_published_copy(
    coordinator: &mut StorageCoordinator,
    operation: &str,
) -> Result<()> {
    coordinator.advance(
        operation,
        StorageMigrationPhase::Copying,
        StorageMigrationPhase::Verifying,
    )?;
    coordinator.advance(
        operation,
        StorageMigrationPhase::Verifying,
        StorageMigrationPhase::Prepared,
    )?;
    coordinator.commit(operation)?;
    coordinator.complete(operation)?;
    Ok(())
}

fn external_snapshot(body: &[u8]) -> ExternalHistorySnapshot {
    ExternalHistorySnapshot {
        origin: ExternalHistoryOrigin {
            source: MigrationSourceKind::Codex,
            source_instance: "owned-history-source".into(),
            source_session_id: "foreign-session-id".into(),
            source_artifact_id: None,
            source_format: "jsonl/fixture".into(),
            adapter_revision: "relocation/1".into(),
            title: None,
            created_at: None,
            updated_at: None,
            project: Some("/user/project/source".into()),
            archived: false,
            parent_session_id: None,
        },
        source_bytes: body.len() as u64,
        source_sha256: hash(body),
        record_limit: 100,
        original: None,
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    archive: ExternalHistoryReceipt,
    pending: String,
    preparation: String,
    context_receipt: PreparedContextReceipt,
    attachment: String,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let source = root.path().join("source");
        let target = root.path().join("target");
        PrivateDirectory::open_or_create(&source)?;
        let store = ExternalHistoryStore::open(&source)?;
        let body = b"{\"turnId\":\"turn-original\",\"requestId\":\"request-original\",\"cwd\":\"/user/project/source\",\"result\":\"unknown\"}\n";
        let archive = {
            let mut import = store.begin_managed("original-import", &external_snapshot(body))?;
            import.stage_source(&mut &body[..], &mut |_| true)?;
            import.finish(&mut |_| true)?.receipt
        };
        let pending = {
            let pending_body = b"{\"request\":\"accepted-without-completion\"}\n";
            let mut import =
                store.begin_managed("pending-import", &external_snapshot(pending_body))?;
            import.stage_source(&mut &pending_body[..], &mut |_| true)?;
            import.archive_id().to_owned()
        };
        let reader = store.reader(&archive.archive_id)?;
        let attachment = hash(b"synthetic attachment id");
        reader
            .attachment_blob(&attachment, true)?
            .context("missing blob")?
            .publish(&mut &b"owned-attachment-bytes"[..], 1024, |_| true)?;
        let document = HistoricalContextDocument {
            revision: "history-context/relocation/1".into(),
            source: MigrationSourceKind::Codex,
            source_job_id: "original-context-job".into(),
            view_id: "original-view".into(),
            attachments: Vec::new(),
            entries: vec![HistoricalContextEntry {
                position: 0,
                block_index: 0,
                source_array_index: None,
                source_role: HistoricalRole::User,
                kind: HistoricalContextFactKind::Text,
                text: "原始历史 /user/project/source unknown".into(),
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
            branch_identity: "original-branch".into(),
            tool_links_sha256: None,
            attachments_sha256: hash(&serde_json::to_vec(&document.attachments)?),
            document_sha256: hash(&serde_json::to_vec(&document)?),
        };
        let preparation = uuid::Uuid::new_v4().to_string();
        let context = HistoricalContextStore::open(&source)?;
        let context_receipt = context.prepare_referenced(
            &preparation,
            &document,
            &binding,
            &[reader.lifecycle_guard()],
            |_, _, _| unreachable!(),
            |_| true,
        )?;
        drop(reader);
        Ok(Self {
            _root: root,
            source,
            target,
            archive,
            pending,
            preparation,
            context_receipt,
            attachment,
        })
    }

    fn verify_target(&self, target: &Path) -> Result<()> {
        let store =
            ExternalHistoryStore::open_existing(target)?.context("missing archive owner")?;
        let reader = store.reader(&self.archive.archive_id)?;
        assert_eq!(reader.receipt()?.as_ref(), Some(&self.archive));
        assert_eq!(reader.origin().source_instance, "owned-history-source");
        let body = reader.read_record_chunk(0, 0, 1024)?;
        assert!(String::from_utf8(body)?.contains("\"result\":\"unknown\""));
        assert!(store.reader(&self.pending)?.receipt()?.is_none());
        assert_eq!(
            reader
                .attachment_blob(&self.attachment, false)?
                .context("missing blob")?
                .read_chunk(0, 1024)?,
            b"owned-attachment-bytes"
        );
        let context =
            HistoricalContextStore::open_existing(target)?.context("missing context owner")?;
        assert_eq!(
            context.verify(&self.preparation, |_| true)?.receipt,
            self.context_receipt
        );
        Ok(())
    }
}

#[test]
fn one_adaptation_hashes_the_target_once_and_cold_verification_rejects_later_corruption()
-> Result<()> {
    let fixture = Fixture::new()?;
    let snapshot = HistoryStorageRelocation::snapshot(&fixture.source)?;
    let (_control, mut coordinator, published) =
        published_copy(&fixture.source, &fixture.target, "bounded-history-io")?;
    let relative = PathBuf::from("external-history").join(&fixture.archive.archive_id);
    let source = PrivateDirectory::open_existing(&fixture.source.join(&relative))?;
    let target = PrivateDirectory::open_existing(&fixture.target.join(&relative))?;
    let bytes = fs::metadata(fixture.source.join(&relative).join("source.bin"))?.len();
    let reads = FingerprintReads::start();
    HistoryStorageRelocation::relocate(
        &fixture.source,
        &fixture.target,
        "bounded-history-io",
        &snapshot,
        &published,
    )?;
    assert_eq!(reads.for_file(&source, "source.bin")?, (2, bytes * 2));
    assert_eq!(reads.for_file(&target, "source.bin")?, (1, bytes));
    drop(reads);
    complete_published_copy(&mut coordinator, "bounded-history-io")?;
    HistoryStorageRelocation::verify_relocation(
        &fixture.source,
        &fixture.target,
        "bounded-history-io",
        &snapshot,
        &published,
    )?;

    // Keep the same file identity and length. A later cold check must read the
    // contents instead of treating the published directory as payload evidence.
    let identity = observed_regular_identity(&target, OsStr::new("source.bin"))?;
    let original = fs::read(fixture.target.join(&relative).join("source.bin"))?;
    let mut changed = original.clone();
    changed[0] ^= 1;
    fs::write(fixture.target.join(&relative).join("source.bin"), changed)?;
    assert_eq!(
        observed_regular_identity(&target, OsStr::new("source.bin"))?,
        identity
    );
    assert!(
        HistoryStorageRelocation::verify_relocation(
            &fixture.source,
            &fixture.target,
            "bounded-history-io",
            &snapshot,
            &published,
        )
        .is_err()
    );
    fs::write(fixture.target.join(&relative).join("source.bin"), &original)?;
    HistoryStorageRelocation::verify_relocation(
        &fixture.source,
        &fixture.target,
        "bounded-history-io",
        &snapshot,
        &published,
    )?;
    assert_eq!(
        fs::read(fixture.source.join(relative).join("source.bin"))?,
        original
    );
    Ok(())
}

#[test]
fn published_copy_preserves_epochs_receipts_sources_pending_and_payloads() -> Result<()> {
    let fixture = Fixture::new()?;
    let original_lifecycle = fs::read(
        fixture
            .source
            .join("external-history/managed-v2/lifecycle.json"),
    )?;
    let original_intent = fs::read(
        fixture
            .source
            .join("historical-contexts")
            .join(&fixture.preparation)
            .join("intent.json"),
    )?;
    let source_directory =
        PrivateDirectory::open_existing(&fixture.source.join("historical-contexts"))?;
    let source_metadata = observe_relocation_metadata(&source_directory)?;
    let snapshot = HistoryStorageRelocation::snapshot(&fixture.source)?;
    let (_control, mut _coordinator, proof) =
        published_copy(&fixture.source, &fixture.target, "move-history")?;
    assert!(HistoricalContextStore::open_existing(&fixture.target).is_err());
    assert!(
        HistoryStorageRelocation::verify_relocation(
            &fixture.source,
            &fixture.target,
            "move-history",
            &snapshot,
            &proof
        )
        .is_err()
    );
    HistoryStorageRelocation::relocate(
        &fixture.source,
        &fixture.target,
        "move-history",
        &snapshot,
        &proof,
    )?;
    complete_published_copy(&mut _coordinator, "move-history")?;
    let target_directory =
        PrivateDirectory::open_existing(&fixture.target.join("historical-contexts"))?;
    let target_metadata = verify_relocation_metadata(&proof, &target_directory, &source_metadata)?;
    assert!(target_metadata.is_metadata_entry(&target_directory, OsStr::new(RECORD))?);
    assert!(!target_metadata.is_metadata_entry(&target_directory, OsStr::new("owner.json"))?);
    let foreign = tempfile::tempdir()?;
    let foreign = PrivateDirectory::open_existing(foreign.path())?;
    assert!(
        verify_relocation_metadata(
            &proof,
            &target_directory,
            &observe_relocation_metadata(&foreign)?
        )
        .is_err()
    );
    fixture.verify_target(&fixture.target)?;
    assert_eq!(
        fs::read(
            fixture
                .target
                .join("external-history/managed-v2/lifecycle.json")
        )?,
        original_lifecycle
    );
    assert_eq!(
        fs::read(
            fixture
                .target
                .join("historical-contexts")
                .join(&fixture.preparation)
                .join("intent.json")
        )?,
        original_intent
    );
    HistoryStorageRelocation::verify_relocation(
        &fixture.source,
        &fixture.target,
        "move-history",
        &snapshot,
        &proof,
    )?;
    HistoryStorageRelocation::relocate(
        &fixture.source,
        &fixture.target,
        "move-history",
        &snapshot,
        &proof,
    )?;
    assert!(
        HistoryStorageRelocation::relocate(
            &fixture.source,
            &fixture.target,
            "another-operation",
            &snapshot,
            &proof
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn repeated_relocations_keep_the_original_logical_owners_and_native_target_ids() -> Result<()> {
    let fixture = Fixture::new()?;
    let snapshot = HistoryStorageRelocation::snapshot(&fixture.source)?;
    let (_control, mut _coordinator, first) =
        published_copy(&fixture.source, &fixture.target, "first-history-move")?;
    HistoryStorageRelocation::relocate(
        &fixture.source,
        &fixture.target,
        "first-history-move",
        &snapshot,
        &first,
    )?;
    complete_published_copy(&mut _coordinator, "first-history-move")?;
    let first_facts = HistoryStorageRelocation::snapshot(&fixture.target)?;
    let intermediate_identity =
        PrivateDirectory::open_existing(&fixture.target.join("external-history/managed-v2"))?
            .directory_identity()?;
    let final_target = fixture._root.path().join("third");
    drop(_coordinator);
    let second_snapshot = HistoryStorageRelocation::snapshot(&fixture.target)?;
    let (_control2, mut _coordinator2, second) =
        published_copy(&fixture.target, &final_target, "second-history-move")?;
    assert!(fixture.verify_target(&final_target).is_err());
    HistoryStorageRelocation::relocate(
        &fixture.target,
        &final_target,
        "second-history-move",
        &second_snapshot,
        &second,
    )?;
    complete_published_copy(&mut _coordinator2, "second-history-move")?;
    fixture.verify_target(&final_target)?;
    drop(_coordinator2);
    let third_target = fixture._root.path().join("fourth");
    let third_snapshot = HistoryStorageRelocation::snapshot(&final_target)?;
    let (_control3, mut _coordinator3, third) =
        published_copy(&final_target, &third_target, "third-history-move")?;
    HistoryStorageRelocation::relocate(
        &final_target,
        &third_target,
        "third-history-move",
        &third_snapshot,
        &third,
    )?;
    complete_published_copy(&mut _coordinator3, "third-history-move")?;
    fixture.verify_target(&third_target)?;
    let current =
        PrivateDirectory::open_existing(&third_target.join("external-history/managed-v2"))?;
    assert!(!current.history_matches_directory(&intermediate_identity)?);
    let final_facts = HistoryStorageRelocation::snapshot(&third_target)?;
    assert_eq!(first_facts.directories.len(), final_facts.directories.len());
    for (first, final_) in first_facts.directories.iter().zip(&final_facts.directories) {
        assert_eq!(first.path, final_.path);
        assert_eq!(first.directory_aliases, final_.directory_aliases);
        assert_eq!(first.retention_aliases, final_.retention_aliases);
        assert_eq!(first.files.len(), final_.files.len());
        for (first, final_) in first.files.iter().zip(&final_.files) {
            assert_eq!(first.name, final_.name);
            assert_eq!(first.aliases, final_.aliases);
            assert_eq!(first.string_aliases, final_.string_aliases);
        }
        assert_eq!(first.children.len(), final_.children.len());
        for (first, final_) in first.children.iter().zip(&final_.children) {
            assert_eq!(first.name, final_.name);
            assert_eq!(first.aliases, final_.aliases);
            assert_eq!(first.directory_aliases, final_.directory_aliases);
        }
    }
    assert_ne!(current.directory_identity()?, intermediate_identity);
    assert_ne!(
        PrivateDirectory::open_existing(&fixture.source)?.directory_identity()?,
        PrivateDirectory::open_existing(&final_target)?.directory_identity()?
    );
    Ok(())
}

#[test]
fn replacing_a_relocation_record_with_equal_bytes_revokes_the_mapping() -> Result<()> {
    let fixture = Fixture::new()?;
    let snapshot = HistoryStorageRelocation::snapshot(&fixture.source)?;
    let (_control, mut _coordinator, proof) =
        published_copy(&fixture.source, &fixture.target, "replace-record")?;
    HistoryStorageRelocation::relocate(
        &fixture.source,
        &fixture.target,
        "replace-record",
        &snapshot,
        &proof,
    )?;
    complete_published_copy(&mut _coordinator, "replace-record")?;
    let directory = PrivateDirectory::open_existing(&fixture.target.join("historical-contexts"))?;
    let metadata = observe_relocation_metadata(&directory)?;
    let original = directory.open_single_link_regular_file(OsStr::new(RECORD))?;
    let bytes = fs::read(fixture.target.join("historical-contexts").join(RECORD))?;
    directory.atomic_replace(OsStr::new(RECORD), &bytes)?;
    assert!(
        metadata
            .is_metadata_entry(&directory, OsStr::new(RECORD))
            .is_err()
    );
    assert!(HistoricalContextStore::open_existing(&fixture.target).is_err());
    assert!(
        HistoryStorageRelocation::relocate(
            &fixture.source,
            &fixture.target,
            "replace-record",
            &snapshot,
            &proof
        )
        .is_err()
    );
    drop(original);
    Ok(())
}

#[test]
fn a_live_native_archive_reader_blocks_the_owner_snapshot() -> Result<()> {
    let fixture = Fixture::new()?;
    let store = ExternalHistoryStore::open_existing(&fixture.source)?.unwrap();
    let reader = store.reader(&fixture.archive.archive_id)?;
    assert_eq!(
        HistoryStorageRelocation::snapshot(&fixture.source)
            .unwrap_err()
            .to_string(),
        "HISTORY_RELOCATION_OWNER_BUSY"
    );
    drop(reader);
    HistoryStorageRelocation::snapshot(&fixture.source)?;
    Ok(())
}

#[test]
fn damaged_external_catalogues_move_opaque_without_repair_or_losing_exclusion() -> Result<()> {
    fn bytes(root: &Path) -> Result<std::collections::BTreeMap<PathBuf, Vec<u8>>> {
        fn visit(
            root: &Path,
            path: &Path,
            result: &mut std::collections::BTreeMap<PathBuf, Vec<u8>>,
        ) -> Result<()> {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    visit(root, &entry.path(), result)?;
                } else if entry.file_name() != OsStr::new(RECORD) {
                    result.insert(
                        entry.path().strip_prefix(root)?.into(),
                        fs::read(entry.path())?,
                    );
                }
            }
            Ok(())
        }
        let mut result = Default::default();
        visit(root, root, &mut result)?;
        Ok(result)
    }
    for damage in ["missing", "json", "scope", "directory"] {
        let owned = tempfile::tempdir()?;
        let source = owned.path().join("source");
        PrivateDirectory::open_or_create(&source)?;
        let store = ExternalHistoryStore::open(&source)?;
        let body = b"{\"result\":\"unknown\"}\n";
        let receipt = {
            let mut import = store.begin_managed("original", &external_snapshot(body))?;
            import.stage_source(&mut &body[..], &mut |_| true)?;
            import.finish(&mut |_| true)?.receipt
        };
        drop(store);
        let document = source.join("external-history/managed-v2/lifecycle.json");
        match damage {
            "missing" => fs::remove_file(&document)?,
            "json" => fs::write(&document, b"{incomplete")?,
            "scope" | "directory" => {
                let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&document)?)?;
                value[damage] = if damage == "scope" {
                    "0".repeat(64)
                } else {
                    PrivateDirectory::open_existing(&source)?.directory_identity()?
                }
                .into();
                fs::write(&document, serde_json::to_vec(&value)?)?;
            }
            _ => unreachable!(),
        }
        let expected = bytes(&source.join("external-history"))?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(source.join("external-history/mutation.lock"))?;
        fs2::FileExt::try_lock_exclusive(&lock)?;
        assert!(HistoryStorageRelocation::snapshot(&source).is_err());
        drop(lock);
        let mut current = source;
        let mut controls = Vec::new();
        for ordinal in 0..2 {
            let target = owned.path().join(format!("target-{ordinal}"));
            let operation = format!("opaque-{damage}-{ordinal}");
            let snapshot = HistoryStorageRelocation::snapshot(&current)?;
            let (control, mut coordinator, published) =
                published_copy(&current, &target, &operation)?;
            HistoryStorageRelocation::relocate(
                &current, &target, &operation, &snapshot, &published,
            )?;
            complete_published_copy(&mut coordinator, &operation)?;
            HistoryStorageRelocation::verify_relocation(
                &current, &target, &operation, &snapshot, &published,
            )?;
            drop(coordinator);
            controls.push(control);
            assert_eq!(bytes(&current.join("external-history"))?, expected);
            assert_eq!(bytes(&target.join("external-history"))?, expected);
            let moved = ExternalHistoryStore::open_existing(&target)?.unwrap();
            assert_eq!(
                moved.scope_fingerprint()?,
                ExternalHistoryStore::open_existing(&current)?
                    .unwrap()
                    .scope_fingerprint()?
            );
            assert!(moved.reader(&receipt.archive_id).is_err());
            drop(moved);
            current = target;
        }
    }
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn migrated_payload_retirement_keeps_original_receipts_and_source_copy() -> Result<()> {
    use crate::external_history::lifecycle::ArchiveRetirementPhase;
    let fixture = Fixture::new()?;
    let snapshot = HistoryStorageRelocation::snapshot(&fixture.source)?;
    let (_control, mut _coordinator, proof) =
        published_copy(&fixture.source, &fixture.target, "history-gc-move")?;
    HistoryStorageRelocation::relocate(
        &fixture.source,
        &fixture.target,
        "history-gc-move",
        &snapshot,
        &proof,
    )?;
    complete_published_copy(&mut _coordinator, "history-gc-move")?;
    fixture.verify_target(&fixture.target)?;
    let context = HistoricalContextStore::open_existing(&fixture.target)?.unwrap();
    drop(_coordinator);
    context.retire(&fixture.preparation, &uuid::Uuid::new_v4().to_string())?;
    let store = ExternalHistoryStore::open_existing(&fixture.target)?.unwrap();
    let prepared = store.prepare_archive_retirement("retire-after-move", "original-import")?;
    let interrupted = binding::interrupt_next_directory_removal();
    let pending =
        store.run_archive_retirement(&prepared.operation_id, prepared.sequence, || true)?;
    assert!(interrupted.reached());
    assert!(pending.phase == ArchiveRetirementPhase::OutcomeUnknown);
    let retried = binding::interrupt_next_directory_removal();
    let pending = store.run_archive_retirement(&pending.operation_id, pending.sequence, || true)?;
    assert!(retried.reached());
    assert!(pending.phase == ArchiveRetirementPhase::OutcomeUnknown);

    // Neither the adapter nor verification replays this unknown removal. The
    // original checkpoint survives with the child sidecar already absent.
    let pending_target = fixture._root.path().join("pending-retirement");
    let pending_snapshot = HistoryStorageRelocation::snapshot(&fixture.target)?;
    let (_pending_control, mut pending_coordinator, pending_proof) = published_copy(
        &fixture.target,
        &pending_target,
        "pending-retirement-history-move",
    )?;
    HistoryStorageRelocation::relocate(
        &fixture.target,
        &pending_target,
        "pending-retirement-history-move",
        &pending_snapshot,
        &pending_proof,
    )?;
    complete_published_copy(&mut pending_coordinator, "pending-retirement-history-move")?;
    HistoryStorageRelocation::verify_relocation(
        &fixture.target,
        &pending_target,
        "pending-retirement-history-move",
        &pending_snapshot,
        &pending_proof,
    )?;
    let moved = ExternalHistoryStore::open_existing(&pending_target)?.unwrap();
    let observed = moved.read_archive_retirement(&pending.operation_id)?;
    assert!(observed.phase == ArchiveRetirementPhase::OutcomeUnknown);
    assert_eq!(observed.sequence, pending.sequence);
    assert_eq!(
        store
            .read_archive_retirement(&pending.operation_id)?
            .sequence,
        pending.sequence
    );
    drop(pending_coordinator);
    assert!(
        moved
            .run_archive_retirement(&pending.operation_id, pending.sequence, || true)
            .is_err()
    );
    assert_eq!(
        moved
            .read_archive_retirement(&pending.operation_id)?
            .sequence,
        pending.sequence
    );
    assert!(
        fixture
            .source
            .join("external-history")
            .join(&fixture.archive.archive_id)
            .join("source.bin")
            .is_file()
    );
    assert!(moved.reader(&fixture.pending)?.receipt()?.is_none());
    Ok(())
}

#[test]
fn a_sqlite_stream_committed_after_one_move_keeps_its_receipt_after_the_next() -> Result<()> {
    use kcoder_types::{imported_transcript::*, migration_resource::MigrationResourceLimits};
    let owned = tempfile::tempdir()?;
    let source = owned.path().join("source");
    let target = owned.path().join("target");
    let final_target = owned.path().join("final");
    PrivateDirectory::open_or_create(&source)?;
    let store = ExternalHistoryStore::open(&source)?;
    let budget = store.prepare_resource_budget(
        "moving-budget",
        vec!["budget-history".into()],
        MigrationResourceLimits {
            max_total_bytes: 4 * 1024 * 1024,
            max_payload_files: 16,
            min_free_bytes: 1024 * 1024,
            min_free_file_nodes: 0,
        },
    )?;
    let body = b"{\"synthetic\":true}\n";
    let receipt = {
        let mut import = store.begin_managed("budget-history", &external_snapshot(body))?;
        import.stage_source(&mut &body[..], &mut |_| true)?;
        import.finish(&mut |_| true)?.receipt
    };
    {
        let reader = store.reader(&receipt.archive_id)?;
        let mut projection = reader.projection("budget-move/1", true)?.unwrap();
        projection.append(
            0,
            &[HistoricalRecord {
                source: MigrationSourceKind::Codex,
                record: 0,
                source_id: None,
                parent_id: None,
                logical_parent_id: None,
                source_session_id: Some("foreign-session-id".into()),
                timestamp: None,
                source_version: None,
                turn_id: None,
                persisted_ordinal: Some(0),
                sidechain: false,
                hidden: false,
                compact_summary: false,
                codex: None,
                data: HistoricalRecordData::Unknown {
                    source_type: Some("synthetic".into()),
                    payload: None,
                },
                diagnostics: Vec::new(),
            }],
        )?;
    }
    assert!(store.resource_budget_usage(&budget)?.reserved_bytes > 0);
    let snapshot = HistoryStorageRelocation::snapshot(&source)?;
    let (_control, mut coordinator, proof) = published_copy(&source, &target, "budget-first-move")?;
    HistoryStorageRelocation::relocate(&source, &target, "budget-first-move", &snapshot, &proof)?;
    complete_published_copy(&mut coordinator, "budget-first-move")?;
    drop(coordinator);
    let target_store = ExternalHistoryStore::open_existing(&target)?.unwrap();
    {
        let reader = target_store.reader(&receipt.archive_id)?;
        let mut projection = reader.projection("budget-move/1", true)?.unwrap();
        assert!(projection.finish()?.normalization_complete);
    }
    let committed = target_store.resource_budget_usage(&budget)?;
    assert_eq!(committed.reserved_bytes, 0);
    let next = HistoryStorageRelocation::snapshot(&target)?;
    let (_control2, mut _coordinator2, proof2) =
        published_copy(&target, &final_target, "budget-second-move")?;
    HistoryStorageRelocation::relocate(
        &target,
        &final_target,
        "budget-second-move",
        &next,
        &proof2,
    )?;
    complete_published_copy(&mut _coordinator2, "budget-second-move")?;
    let final_store = ExternalHistoryStore::open_existing(&final_target)?.unwrap();
    let reader = final_store.reader(&receipt.archive_id)?;
    let mut projection = reader.projection("budget-move/1", true)?.unwrap();
    assert!(projection.finish()?.normalization_complete);
    assert_eq!(final_store.resource_budget_usage(&budget)?, committed);
    Ok(())
}
