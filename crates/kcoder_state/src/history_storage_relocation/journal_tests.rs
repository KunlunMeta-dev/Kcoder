use super::*;
use crate::history_index::{
    IndexedSession, TranscriptReadFence,
    journal::{JournalFence, changes_since, current_watermark},
};
use crate::{AppState, Message, historical_undo::*};
use kcoder_config::storage::{
    StorageCoordinator, StorageInstance, StorageResolveInput, resolve_storage_paths,
};
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase as Phase, StorageMigrationPlan,
    StorageTargetBinding,
};
use kcoder_types::{historical_context::*, historical_undo::HistoricalUndoSealReceipt};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
};

struct Fixture {
    _owned: tempfile::TempDir,
    source: PathBuf,
    target: PathBuf,
    workspace: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("source");
        let target = owned.path().join("target");
        let workspace = owned.path().join("workspace");
        PrivateDirectory::open_or_create(&source.join("projects/owned/client-sessions")).unwrap();
        PrivateDirectory::open_or_create(&workspace).unwrap();
        drop(
            StorageInstance::open(StorageResolveInput {
                home: Some(owned.path().into()),
                env: BTreeMap::from([
                    ("KCODER_HOME".into(), source.clone().into_os_string()),
                    (
                        "KCODER_CACHE_DIR".into(),
                        owned.path().join("source-cache").into_os_string(),
                    ),
                ]),
                ..Default::default()
            })
            .unwrap(),
        );
        Self {
            _owned: owned,
            source,
            target,
            workspace,
        }
    }
    fn history(&self, root: &Path) -> PathBuf {
        root.join("projects/owned")
    }
    fn client(&self, root: &Path) -> PathBuf {
        self.history(root).join("client-sessions")
    }
    fn transfer(
        &self,
        operation: &str,
    ) -> (
        HistoryStorageRelocationSnapshot,
        kcoder_config::storage::StoragePublishedComponent,
    ) {
        let source_fence = fence_identity(&self.source);
        let snapshot = HistoryStorageRelocation::snapshot(&self.source).unwrap();
        let control = self._owned.path().join("control");
        PrivateDirectory::open_or_create(&control).unwrap();
        let parent_identity = PrivateDirectory::open_existing(self._owned.path())
            .unwrap()
            .directory_identity()
            .unwrap();
        let mut coordinator = StorageCoordinator::acquire(&control).unwrap();
        coordinator
            .begin(StorageMigrationPlan {
                version: 1,
                operation_id: operation.into(),
                original: None,
                from: resolve_storage_paths(&StorageResolveInput {
                    home: Some(control),
                    ..Default::default()
                })
                .unwrap(),
                target: StorageLocationRecord {
                    version: 1,
                    revision: 1,
                    data_root: self.target.clone(),
                    cache_root: self._owned.path().join("cache"),
                    operation_id: Some(operation.into()),
                },
                components: vec![StorageMigrationComponent {
                    domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
                    source: self.source.clone(),
                    destination: self.target.clone(),
                    source_identity: snapshot.profile.clone(),
                    estimated_bytes: 0,
                }],
                target_bindings: vec![StorageTargetBinding {
                    path: self.target.clone(),
                    existing_ancestor: self._owned.path().into(),
                    ancestor_identity: parent_identity,
                }],
                launch_intent: StorageLaunchIntent::VerifyOnly,
            })
            .unwrap();
        coordinator
            .advance(operation, Phase::Planned, Phase::Stopping)
            .unwrap();
        coordinator
            .advance(operation, Phase::Stopping, Phase::Stopped)
            .unwrap();
        coordinator
            .advance(operation, Phase::Stopped, Phase::Copying)
            .unwrap();
        coordinator
            .publish_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN, &BTreeSet::new())
            .unwrap();
        let published = coordinator
            .open_published_component(operation, STORAGE_PERSISTENT_ROOT_DOMAIN)
            .unwrap();
        assert!(
            HistoryStorageRelocation::verify_relocation(
                &self.source,
                &self.target,
                operation,
                &snapshot,
                &published,
            )
            .is_err()
        );
        HistoryStorageRelocation::relocate(
            &self.source,
            &self.target,
            operation,
            &snapshot,
            &published,
        )
        .unwrap();
        HistoryStorageRelocation::verify_relocation(
            &self.source,
            &self.target,
            operation,
            &snapshot,
            &published,
        )
        .unwrap();
        HistoryStorageRelocation::relocate(
            &self.source,
            &self.target,
            operation,
            &snapshot,
            &published,
        )
        .unwrap();
        super::super::tests::complete_published_copy(&mut coordinator, operation).unwrap();
        assert_eq!(fence_identity(&self.source), source_fence);
        assert_ne!(fence_identity(&self.target), source_fence);
        (snapshot, published)
    }
}

fn fence_identity(root: &Path) -> PortableLeaseIdentity {
    let directory = PrivateDirectory::open_existing(root).unwrap();
    let file = directory
        .open_single_link_regular_file(OsStr::new("kcoder-storage-writers.lock"))
        .unwrap();
    assert_eq!(file.metadata().unwrap().len(), 0);
    PortableLeaseIdentity::from_regular_handle(&file).unwrap()
}

fn bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut result = BTreeMap::new();
    fn visit(root: &Path, path: &Path, result: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                visit(root, &entry.path(), result);
            } else if entry.file_name() != OsStr::new(RECORD) {
                result.insert(
                    entry.path().strip_prefix(root).unwrap().to_path_buf(),
                    fs::read(entry.path()).unwrap(),
                );
            }
        }
    }
    visit(root, root, &mut result);
    result
}

#[test]
fn relocation_keeps_journal_epochs_catalog_rows_and_transcript_receipts() {
    let fixture = Fixture::new();
    let history = fixture.history(&fixture.source);
    let client = fixture.client(&fixture.source);
    let first = JournalFence::try_acquire(&history, JournalDomain::History)
        .unwrap()
        .activate()
        .unwrap();
    JournalFence::try_acquire(&client, JournalDomain::ClientMetadata)
        .unwrap()
        .activate()
        .unwrap();
    JournalFence::try_acquire(&history, JournalDomain::History)
        .unwrap()
        .begin("abcde")
        .unwrap()
        .finish()
        .unwrap();
    let watermark = current_watermark(&history, JournalDomain::History)
        .unwrap()
        .unwrap();
    let receipt = TranscriptReadFence::acquire(&history, &client, "thread")
        .unwrap()
        .unwrap()
        .proof()
        .to_vec();
    let mut catalog = HistoryCatalog::open(&client, "external workspace", true)
        .unwrap()
        .unwrap();
    let revision = catalog.revision().unwrap();
    let entry = IndexedSession {
        session_id: "abcde".into(),
        updated_at_ms: 7,
        archived: false,
        metadata: serde_json::json!({"cwd":fixture.workspace,"ssh":"/external/ssh/path","unknown":true}),
        source_proof: b"original-source".to_vec(),
        metadata_proof: b"original-metadata".to_vec(),
    };
    let revision = catalog.publish(&revision, &[entry.clone()], &[]).unwrap();
    drop(catalog);
    let tracked = TrackedHistoryCatalog::open(&client, &history, "external workspace", true)
        .unwrap()
        .unwrap();
    let tracked_revision = tracked.checkpoint().unwrap().revision;
    drop(tracked);
    let original = bytes(&fixture.source);
    let (expected, published) = fixture.transfer("journal-copy");
    assert_eq!(bytes(&fixture.source), original);
    assert_eq!(bytes(&fixture.target), original);
    let target_history = fixture.history(&fixture.target);
    let target_client = fixture.client(&fixture.target);
    HistoryStorageRelocation::verify_relocation(
        &fixture.source,
        &fixture.target,
        "journal-copy",
        &expected,
        &published,
    )
    .unwrap();
    assert_eq!(
        current_watermark(&target_history, JournalDomain::History).unwrap(),
        Some(watermark)
    );
    assert_eq!(
        changes_since(&target_history, JournalDomain::History, &first, 10)
            .unwrap()
            .unwrap()
            .session_ids,
        ["abcde"]
    );
    let actual = TranscriptReadFence::acquire(&target_history, &target_client, "thread")
        .unwrap()
        .unwrap();
    assert_eq!(actual.proof(), receipt);
    drop(actual);
    let catalog = HistoryCatalog::open(&target_client, "external workspace", false)
        .unwrap()
        .unwrap();
    assert_eq!(catalog.revision().unwrap(), revision);
    assert_eq!(
        catalog
            .lookup("abcde", &entry.source_proof, &entry.metadata_proof)
            .unwrap(),
        Some(entry)
    );
    assert_eq!(
        TrackedHistoryCatalog::open(&target_client, &target_history, "external workspace", false)
            .unwrap()
            .unwrap()
            .checkpoint()
            .unwrap()
            .revision,
        tracked_revision
    );
    JournalFence::try_acquire(&target_history, JournalDomain::History)
        .unwrap()
        .begin("fghij")
        .unwrap()
        .finish()
        .unwrap();
    assert_eq!(
        changes_since(
            &fixture.history(&fixture.source),
            JournalDomain::History,
            &first,
            10
        )
        .unwrap()
        .unwrap()
        .session_ids,
        ["abcde"]
    );
}

#[test]
fn relocation_preserves_pending_journal_without_settling_or_reactivating() {
    let fixture = Fixture::new();
    let history = fixture.history(&fixture.source);
    let mut fence = JournalFence::try_acquire(&history, JournalDomain::History).unwrap();
    fence.activate().unwrap();
    drop(fence.begin("abcde").unwrap());
    drop(fence);
    let original = bytes(&fixture.source);
    assert!(current_watermark(&history, JournalDomain::History).is_err());
    fixture.transfer("pending-copy");
    assert_eq!(bytes(&fixture.target), original);
    assert!(current_watermark(&fixture.history(&fixture.target), JournalDomain::History).is_err());
}

#[test]
#[cfg(target_os = "linux")]
fn deleted_history_retains_tombstone_and_rejects_a_new_residual_source() {
    let fixture = Fixture::new();
    let history = fixture.history(&fixture.source).join("abcde.jsonl");
    let state = AppState::new(&fixture.workspace);
    state.with_history_path(&history);
    state.add_message(Message::user_text("owned"));
    state.save_history().unwrap();
    state.commit_session_state();
    let original = crate::mark_session_history_deleted(&history, &fixture.workspace).unwrap();
    drop(state);
    let (expected, published) = fixture.transfer("deleted-copy");
    let target_history = fixture.history(&fixture.target).join("abcde.jsonl");
    let relocated = crate::read_session_history_deletion(&target_history, &fixture.workspace)
        .unwrap()
        .unwrap();
    assert_eq!(original.sha256(), relocated.sha256());
    assert_eq!(original.thread_id(), relocated.thread_id());
    assert!(matches!(
        crate::observe_session_history_source_presence(&target_history, &fixture.workspace)
            .unwrap(),
        crate::HistorySourceObservation::BoundDeletedSourceAbsent(_)
    ));
    fs::write(&target_history, b"foreign residual\n").unwrap();
    assert!(crate::read_session_history_deletion(&target_history, &fixture.workspace).is_err());
    assert!(
        crate::observe_session_history_source_presence(&target_history, &fixture.workspace)
            .is_err()
    );
    assert!(
        HistoryStorageRelocation::verify_relocation(
            &fixture.source,
            &fixture.target,
            "deleted-copy",
            &expected,
            &published
        )
        .is_err()
    );
}

#[test]
#[cfg(target_os = "linux")]
fn missing_external_workspace_does_not_block_copy_or_mint_deletion_presence() {
    let fixture = Fixture::new();
    let history = fixture.history(&fixture.source).join("abcde.jsonl");
    let state = AppState::new(&fixture.workspace);
    state.with_history_path(&history);
    state.add_message(Message::user_text("owned deleted session"));
    state.save_history().unwrap();
    state.commit_session_state();
    let original = crate::mark_session_history_deleted(&history, &fixture.workspace).unwrap();
    drop(state);
    let _seed = seed(&fixture);
    let absent = fixture._owned.path().join("external-workspace-unavailable");
    fs::rename(&fixture.workspace, &absent).unwrap();
    assert!(crate::read_session_history_deletion(&history, &fixture.workspace).is_err());
    let source = bytes(&fixture.source);
    fixture.transfer("missing-workspace-copy");
    assert_eq!(bytes(&fixture.source), source);
    assert_eq!(bytes(&fixture.target), source);
    let target = fixture.history(&fixture.target).join("abcde.jsonl");
    assert!(crate::read_session_history_deletion(&target, &fixture.workspace).is_err());
    assert!(crate::observe_session_history_source_presence(&target, &fixture.workspace).is_err());
    fs::rename(&absent, &fixture.workspace).unwrap();
    assert_eq!(
        crate::read_session_history_deletion(&target, &fixture.workspace)
            .unwrap()
            .unwrap()
            .sha256(),
        original.sha256()
    );
}

#[test]
#[cfg(target_os = "linux")]
fn registered_sessions_keep_deleted_history_and_client_artifacts_without_guessing_directories() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let fixture = Fixture::new();
    let state = AppState::new(&fixture.workspace);
    let thread = state.session_id();
    let history = fixture
        .history(&fixture.source)
        .join(format!("{thread}.jsonl"));
    state.with_history_path(&history);
    state.add_message(Message::user_text("registered session"));
    state.save_history().unwrap();
    state.commit_session_state();
    let sibling = fixture
        .history(&fixture.source)
        .join(crate::artifact_id_path_component(&thread));
    let client = fixture
        .client(&fixture.source)
        .join(crate::artifact_id_path_component(&thread));
    PrivateDirectory::open_or_create(&client.join("attachments")).unwrap();
    PrivateDirectory::open_or_create(
        &fixture
            .history(&fixture.source)
            .join("unregistered/attachments"),
    )
    .unwrap();
    let owned_snapshot = HistoryStorageRelocation::snapshot(&fixture.source).unwrap();
    let unknown_file = fixture.source.join("projects/.DS_Store");
    fs::write(&unknown_file, b"unregistered project metadata").unwrap();
    let unknown_directory = fixture
        .source
        .join("projects")
        .join(OsString::from_vec(vec![0xff]));
    fs::create_dir(&unknown_directory).unwrap();
    fs::write(
        unknown_directory.join("unknown"),
        b"native filename payload",
    )
    .unwrap();
    assert_eq!(
        HistoryStorageRelocation::snapshot(&fixture.source).unwrap(),
        owned_snapshot
    );
    let before = bytes(&fixture.source);
    let registered = registered_profile_sessions(&fixture.source).unwrap();
    assert_eq!(registered.len(), 2);
    assert!(registered.iter().all(|entry| entry.thread_id == thread
        && entry.source_state == RegisteredProfileSessionState::Live));
    assert_eq!(
        registered
            .iter()
            .map(|entry| entry.session_directory.clone())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([sibling, client])
    );
    assert_eq!(bytes(&fixture.source), before);
    crate::mark_session_history_deleted(&history, &fixture.workspace).unwrap();
    assert!(
        registered_profile_sessions(&fixture.source)
            .unwrap()
            .iter()
            .all(|entry| entry.source_state == RegisteredProfileSessionState::Deleted)
    );
    drop(state);
    let original = bytes(&fixture.source);
    fixture.transfer("registered-roots-with-unknown-copy");
    assert_eq!(bytes(&fixture.source), original);
    assert_eq!(bytes(&fixture.target), original);
}

#[test]
fn registered_legacy_session_keeps_valid_owners_and_preserves_invalid_sources() {
    let fixture = Fixture::new();
    let state = AppState::new(&fixture.workspace);
    let thread = state.session_id();
    let history = fixture
        .history(&fixture.source)
        .join(format!("{thread}.jsonl"));
    state.with_history_path(&history);
    state.add_message(Message::user_text("legacy session"));
    state.save_history().unwrap();
    state.commit_session_state();
    drop(state);
    fs::remove_dir_all(history.with_extension("hctl")).unwrap();
    let before = bytes(&fixture.source);
    let registered = registered_profile_sessions(&fixture.source).unwrap();
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0].thread_id, thread);
    assert_eq!(
        registered[0].source_state,
        RegisteredProfileSessionState::Unknown
    );
    assert_eq!(bytes(&fixture.source), before);
    let bad = fixture.history(&fixture.source).join("unconfirmed.jsonl");
    fs::write(&bad, b"{invalid legacy source\n").unwrap();
    PrivateDirectory::open_or_create(
        &fixture
            .history(&fixture.source)
            .join("unconfirmed/attachments"),
    )
    .unwrap();
    let registered = registered_profile_sessions(&fixture.source).unwrap();
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0].thread_id, thread);
    assert_eq!(fs::read(&bad).unwrap(), b"{invalid legacy source\n");
}

#[test]
fn empty_controls_without_session_evidence_are_copied_as_opaque_data() {
    let fixture = Fixture::new();
    let control = fixture.history(&fixture.source).join("unborn.hctl");
    PrivateDirectory::open_or_create(&control).unwrap();
    assert!(
        registered_profile_sessions(&fixture.source)
            .unwrap()
            .is_empty()
    );
    assert!(crate::history_store::HistorySource::bind(&control.with_extension("jsonl")).is_err());
    assert!(control.read_dir().unwrap().next().is_none());
    JournalFence::try_acquire(&fixture.history(&fixture.source), JournalDomain::History)
        .unwrap()
        .activate()
        .unwrap();
    fixture.transfer("empty-unmaterialized-control");
    let target = fixture.history(&fixture.target).join("unborn.hctl");
    assert!(target.is_dir());
    assert!(target.read_dir().unwrap().next().is_none());
    assert!(control.read_dir().unwrap().next().is_none());
    assert!(crate::history_store::HistorySource::bind(&target.with_extension("jsonl")).is_err());
}

#[test]
fn missing_or_corrupt_history_controls_are_preserved_without_business_repair() {
    for kind in [
        "body",
        "sibling",
        "client",
        "control",
        "corrupt",
        "oversized",
    ] {
        let fixture = Fixture::new();
        let history = fixture.history(&fixture.source);
        let control = history.join("unconfirmed.hctl");
        PrivateDirectory::open_or_create(&control).unwrap();
        match kind {
            "body" => fs::write(history.join("unconfirmed.jsonl"), b"retained history").unwrap(),
            "sibling" => {
                PrivateDirectory::open_or_create(&history.join("unconfirmed")).unwrap();
            }
            "client" => {
                PrivateDirectory::open_or_create(
                    &fixture.client(&fixture.source).join("unconfirmed"),
                )
                .unwrap();
            }
            "control" => fs::write(control.join("unknown"), b"unconfirmed pending data").unwrap(),
            "corrupt" => fs::write(control.join("source.json"), b"{invalid control").unwrap(),
            "oversized" => fs::write(control.join("source.json"), vec![b'x'; 4097]).unwrap(),
            _ => unreachable!(),
        }
        JournalFence::try_acquire(&history, JournalDomain::History)
            .unwrap()
            .activate()
            .unwrap();
        let before = bytes(&fixture.source);
        HistoryStorageRelocation::snapshot(&fixture.source).unwrap();
        assert!(
            registered_profile_sessions(&fixture.source)
                .unwrap()
                .is_empty(),
            "{kind}"
        );
        assert_eq!(bytes(&fixture.source), before);
        fixture.transfer(&format!("opaque-control-{kind}"));
        assert_eq!(bytes(&fixture.source), before);
        assert_eq!(bytes(&fixture.target), before);
        assert!(
            crate::history_store::HistorySource::bind(
                &fixture.history(&fixture.target).join("unconfirmed.jsonl")
            )
            .is_err()
        );
    }
}

struct Seed {
    session: String,
    binding: HistoricalSessionSeedBinding,
    seal: HistoricalUndoSealReceipt,
}

#[test]
fn damaged_control_does_not_discard_a_healthy_sibling_owner() {
    let fixture = Fixture::new();
    let valid = legacy_seed(&fixture);
    let broken = fixture.history(&fixture.source).join("damaged.hctl");
    PrivateDirectory::open_or_create(&broken).unwrap();
    fs::write(broken.join("source.json"), b"{damaged").unwrap();
    let before = bytes(&fixture.source);
    fixture.transfer("healthy-owner-with-damaged-sibling");
    assert_eq!(bytes(&fixture.source), before);
    assert_eq!(bytes(&fixture.target), before);
    let history = fixture
        .history(&fixture.target)
        .join(format!("{}.jsonl", valid.session));
    assert!(
        AppState::historical_source_for_path(&history, &valid.session)
            .unwrap()
            .is_some()
    );
    let lease = HistoricalUndoLease::try_acquire_existing(
        &history,
        &fixture.client(&fixture.target),
        &valid.session,
    )
    .unwrap();
    preview_historical_session_undo(&lease, &valid.binding, &valid.seal, |_| true).unwrap();
}
fn seed(fixture: &Fixture) -> Seed {
    seed_at(fixture, &fixture.source)
}

fn seed_at(fixture: &Fixture, root: &Path) -> Seed {
    let state = AppState::new(&fixture.workspace);
    state.set_short_id_registry(&fixture._owned.path().join("ids"));
    state.start_new_session().unwrap();
    let session = state.session_id();
    let history = fixture.history(root).join(format!("{session}.jsonl"));
    state.with_history_path(&history);
    let artifact = fixture.client(root).join(&session).join("attachments");
    PrivateDirectory::open_or_create(&artifact).unwrap();
    fs::write(artifact.join("owned.txt"), b"owned attachment").unwrap();
    let message = Message::runtime_text("historical facts");
    let binding = HistoricalSessionSeedBinding {
        operation_id: uuid::Uuid::new_v4().to_string(),
        session_id: session.clone(),
        source_job_id: uuid::Uuid::new_v4().to_string(),
        view_id: "v".repeat(64),
        model_snapshot_sha256: "a".repeat(64),
        projection_sha256: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&message).unwrap())
        ),
        preparation: PreparedContextReceipt {
            preparation_id: uuid::Uuid::new_v4().to_string(),
            document_sha256: "b".repeat(64),
            binding_sha256: "c".repeat(64),
            attachments: 0,
            attachment_bytes: 0,
        },
    };
    let lease =
        HistoricalUndoLease::try_acquire(&history, &fixture.client(root), &session).unwrap();
    state
        .publish_historical_seed(binding.clone(), message)
        .unwrap();
    let seal = seal_historical_session(&lease, &binding, |_| true).unwrap();
    Seed {
        session,
        binding,
        seal,
    }
}

fn legacy_seed(fixture: &Fixture) -> Seed {
    legacy_seed_at(fixture, &fixture.source)
}

fn legacy_seed_at(fixture: &Fixture, root: &Path) -> Seed {
    let mut seeded = seed_at(fixture, root);
    let history = fixture
        .history(root)
        .join(format!("{}.jsonl", seeded.session));
    let artifacts = fixture.client(root);
    let lease =
        HistoricalUndoLease::try_acquire_existing(&history, &artifacts, &seeded.session).unwrap();
    let path = history.with_extension("hctl").join(SEAL);
    let mut seal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    seal["version"] = serde_json::json!(1);
    seal["history_identity"] = serde_json::json!(
        PrivateDirectory::open_existing(history.parent().unwrap())
            .unwrap()
            .directory_identity()
            .unwrap()
    );
    seal["artifact_identity"] = serde_json::json!(
        PrivateDirectory::open_existing(&artifacts)
            .unwrap()
            .directory_identity()
            .unwrap()
    );
    seal["manifest"] =
        serde_json::to_value(manifest::capture(&lease, &mut |_| true).unwrap()).unwrap();
    for (field, lock) in [
        (
            "lifecycle_identity",
            artifacts
                .join(LIFECYCLE_LOCK_DIRECTORY)
                .join(format!("{}.lock", seeded.session)),
        ),
        ("session_lease_identity", history.with_extension("lease")),
    ] {
        seal[field] =
            serde_json::json!(manifest::identity(&fs::File::open(lock).unwrap()).unwrap());
    }
    let bytes = serde_json::to_vec(&seal).unwrap();
    fs::write(path, &bytes).unwrap();
    seeded.seal.seal_sha256 = digest(&bytes);
    seeded
}

#[test]
fn relocated_undo_uses_original_seal_and_reconciles_the_original_retirement() {
    let fixture = Fixture::new();
    let seed = legacy_seed(&fixture);
    let original = bytes(&fixture.source);
    let (expected, published) = fixture.transfer("undo-copy");
    assert_eq!(bytes(&fixture.target), original);
    let target_history = fixture
        .history(&fixture.target)
        .join(format!("{}.jsonl", seed.session));
    let legacy = crate::session_persistence::session_state_path_for_history(&target_history);
    assert!(!legacy.exists());
    fs::write(&legacy, b"unexpected legacy state").unwrap();
    assert!(
        HistoryStorageRelocation::verify_relocation(
            &fixture.source,
            &fixture.target,
            "undo-copy",
            &expected,
            &published
        )
        .is_err()
    );
    fs::remove_file(&legacy).unwrap();
    HistoryStorageRelocation::verify_relocation(
        &fixture.source,
        &fixture.target,
        "undo-copy",
        &expected,
        &published,
    )
    .unwrap();
    let original_modified = fs::metadata(&target_history).unwrap().modified().unwrap();
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&target_history)
        .unwrap();
    file.set_times(
        fs::FileTimes::new().set_modified(original_modified + std::time::Duration::from_secs(1)),
    )
    .unwrap();
    assert!(
        HistoryStorageRelocation::verify_relocation(
            &fixture.source,
            &fixture.target,
            "undo-copy",
            &expected,
            &published
        )
        .is_err()
    );
    file.set_times(fs::FileTimes::new().set_modified(original_modified))
        .unwrap();
    HistoryStorageRelocation::verify_relocation(
        &fixture.source,
        &fixture.target,
        "undo-copy",
        &expected,
        &published,
    )
    .unwrap();
    drop(file);
    let lease = HistoricalUndoLease::try_acquire_existing(
        &target_history,
        &fixture.client(&fixture.target),
        &seed.session,
    )
    .unwrap();
    preview_historical_session_undo(&lease, &seed.binding, &seed.seal, |_| true).unwrap();
    let undo_id = uuid::Uuid::new_v4().to_string();
    let receipt =
        undo_historical_session(&lease, &seed.binding, &seed.seal, &undo_id, |_| true).unwrap();
    assert!(
        receipt
            == undo_historical_session(&lease, &seed.binding, &seed.seal, &undo_id, |_| true)
                .unwrap()
    );
    assert_eq!(bytes(&fixture.source), original);
}

#[test]
fn snapshot_rejects_a_missing_undo_mutation_lock_without_recreating_it() {
    let fixture = Fixture::new();
    seed(&fixture);
    let lock = fixture
        .history(&fixture.source)
        .join(".kcoder-history.lock");
    fs::remove_file(&lock).unwrap();
    let original = bytes(&fixture.source);
    assert!(HistoryStorageRelocation::snapshot(&fixture.source).is_err());
    assert!(!lock.exists());
    assert_eq!(bytes(&fixture.source), original);
}

#[test]
fn relocation_keeps_retired_undo_receipt_and_an_unknown_outcome_remains_unknown() {
    let fixture = Fixture::new();
    let seed = seed(&fixture);
    let history = fixture
        .history(&fixture.source)
        .join(format!("{}.jsonl", seed.session));
    let undo_id = uuid::Uuid::new_v4().to_string();
    let lease = HistoricalUndoLease::try_acquire_existing(
        &history,
        &fixture.client(&fixture.source),
        &seed.session,
    )
    .unwrap();
    undo_historical_session(&lease, &seed.binding, &seed.seal, &undo_id, |_| true).unwrap();
    drop(lease);
    let receipt_path = history
        .with_extension("hctl")
        .join(format!("historical-undo-{undo_id}.receipt.json"));
    fs::remove_file(receipt_path).unwrap();
    let original = bytes(&fixture.source);
    fixture.transfer("retired-unknown-copy");
    assert_eq!(bytes(&fixture.target), original);
    let history = fixture
        .history(&fixture.target)
        .join(format!("{}.jsonl", seed.session));
    let lease = HistoricalUndoLease::try_acquire_existing(
        &history,
        &fixture.client(&fixture.target),
        &seed.session,
    )
    .unwrap();
    assert!(
        read_historical_session_undo(&lease, &seed.seal, &undo_id)
            .unwrap()
            .is_none()
    );
    assert!(
        undo_historical_session(&lease, &seed.binding, &seed.seal, &undo_id, |_| true).is_err()
    );
    assert!(
        read_historical_session_undo(&lease, &seed.seal, &undo_id)
            .unwrap()
            .is_none()
    );
    assert_eq!(bytes(&fixture.source), original);
}

#[test]
fn fresh_undo_after_three_moves_uses_the_original_content_seal_and_a_current_guard() {
    let fixture = Fixture::new();
    let seed = seed(&fixture);
    let seal_path = fixture
        .history(&fixture.source)
        .join(format!("{}.hctl", seed.session))
        .join(SEAL);
    let original_seal = fs::read(&seal_path).unwrap();
    let seal: serde_json::Value = serde_json::from_slice(&original_seal).unwrap();
    assert_eq!(seal["version"], 2);
    assert!(seal.get("lifecycle_identity").is_none());
    assert!(seal["manifest"]["history"].get("identity").is_none());
    let mut source = fixture.source.clone();
    for (name, operation) in [
        ("second", "undo-first"),
        ("third", "undo-second"),
        ("fourth", "undo-third"),
    ] {
        let target = fixture._owned.path().join(name);
        let snapshot = HistoryStorageRelocation::snapshot(&source).unwrap();
        let (_control, mut _coordinator, published) =
            super::super::tests::published_copy(&source, &target, operation).unwrap();
        HistoryStorageRelocation::relocate(&source, &target, operation, &snapshot, &published)
            .unwrap();
        super::super::tests::complete_published_copy(&mut _coordinator, operation).unwrap();
        assert_eq!(
            fs::read(
                fixture
                    .history(&target)
                    .join(format!("{}.hctl", seed.session))
                    .join(SEAL)
            )
            .unwrap(),
            original_seal
        );
        source = target;
    }
    let history = fixture
        .history(&source)
        .join(format!("{}.jsonl", seed.session));
    let lease = HistoricalUndoLease::try_acquire_existing(
        &history,
        &fixture.client(&source),
        &seed.session,
    )
    .unwrap();
    preview_historical_session_undo(&lease, &seed.binding, &seed.seal, |_| true).unwrap();
    let undo = uuid::Uuid::new_v4().to_string();
    undo_historical_session(&lease, &seed.binding, &seed.seal, &undo, |_| true).unwrap();
    let intent: serde_json::Value = serde_json::from_slice(
        &fs::read(
            history
                .with_extension("hctl")
                .join(format!("historical-undo-{undo}.intent.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let quarantine = history
        .parent()
        .unwrap()
        .join(intent["quarantine"].as_str().unwrap());
    assert_eq!(
        intent["history"]["identity"],
        manifest::identity(&fs::File::open(quarantine).unwrap()).unwrap()
    );
}

#[test]
fn an_issued_undo_intent_rejects_an_equal_byte_replacement() {
    let fixture = Fixture::new();
    let seed = seed(&fixture);
    let history = fixture
        .history(&fixture.source)
        .join(format!("{}.jsonl", seed.session));
    let lease = HistoricalUndoLease::try_acquire_existing(
        &history,
        &fixture.client(&fixture.source),
        &seed.session,
    )
    .unwrap();
    let undo = uuid::Uuid::new_v4().to_string();
    undo_historical_session(&lease, &seed.binding, &seed.seal, &undo, |_| true).unwrap();
    let control = history.with_extension("hctl");
    fs::remove_file(control.join(format!("historical-undo-{undo}.receipt.json"))).unwrap();
    let intent: serde_json::Value = serde_json::from_slice(
        &fs::read(control.join(format!("historical-undo-{undo}.intent.json"))).unwrap(),
    )
    .unwrap();
    let name = intent["quarantine"].as_str().unwrap();
    let parent = PrivateDirectory::open_existing(history.parent().unwrap()).unwrap();
    let original = parent
        .open_single_link_regular_file(OsStr::new(name))
        .unwrap();
    let body = fs::read(history.parent().unwrap().join(name)).unwrap();
    let modified = original.metadata().unwrap().modified().unwrap();
    let original_identity = manifest::identity(&original).unwrap();
    parent.atomic_replace(OsStr::new(name), &body).unwrap();
    let replacement = parent
        .open_read_write_file(OsStr::new(name), false)
        .unwrap();
    replacement
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    assert_ne!(original_identity, manifest::identity(&replacement).unwrap());
    assert!(undo_historical_session(&lease, &seed.binding, &seed.seal, &undo, |_| true).is_err());
    assert!(
        read_historical_session_undo(&lease, &seed.seal, &undo)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fs::read(history.parent().unwrap().join(name)).unwrap(),
        body
    );
}

#[test]
fn a_legacy_seal_issued_after_one_move_keeps_only_its_referenced_facts_on_later_moves() {
    let fixture = Fixture::new();
    seed(&fixture);
    fixture.transfer("before-legacy-seal");
    let legacy = legacy_seed_at(&fixture, &fixture.target);
    let relative_seal = PathBuf::from(format!("{}.hctl", legacy.session)).join(SEAL);
    let original = fs::read(fixture.history(&fixture.target).join(&relative_seal)).unwrap();
    let first = HistoryStorageRelocation::snapshot(&fixture.target).unwrap();
    let mut source = fixture.target.clone();
    for (name, operation) in [
        ("legacy-third", "legacy-second-move"),
        ("legacy-fourth", "legacy-third-move"),
    ] {
        let target = fixture._owned.path().join(name);
        let snapshot = HistoryStorageRelocation::snapshot(&source).unwrap();
        let (_control, mut _coordinator, published) =
            super::super::tests::published_copy(&source, &target, operation).unwrap();
        HistoryStorageRelocation::relocate(&source, &target, operation, &snapshot, &published)
            .unwrap();
        super::super::tests::complete_published_copy(&mut _coordinator, operation).unwrap();
        assert_eq!(
            fs::read(fixture.history(&target).join(&relative_seal)).unwrap(),
            original
        );
        let history = fixture
            .history(&target)
            .join(format!("{}.jsonl", legacy.session));
        let lease = HistoricalUndoLease::try_acquire_existing(
            &history,
            &fixture.client(&target),
            &legacy.session,
        )
        .unwrap();
        preview_historical_session_undo(&lease, &legacy.binding, &legacy.seal, |_| true).unwrap();
        drop(lease);
        source = target;
    }
    let last = HistoryStorageRelocation::snapshot(&source).unwrap();
    assert_eq!(first.directories.len(), last.directories.len());
    for (first, last) in first.directories.iter().zip(&last.directories) {
        assert_eq!(first.path, last.path);
        assert_eq!(first.directory_aliases, last.directory_aliases);
        assert_eq!(first.retention_aliases, last.retention_aliases);
        assert_eq!(first.files.len(), last.files.len());
        for (first, last) in first.files.iter().zip(&last.files) {
            assert_eq!(first.name, last.name);
            assert_eq!(first.aliases, last.aliases);
            assert_eq!(first.string_aliases, last.string_aliases);
        }
    }
}
