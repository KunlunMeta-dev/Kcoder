use super::*;
use kcoder_config::{
    PrivateDirectory,
    storage::{
        StorageCoordinator, StoragePublishedComponent, StorageResolveInput, resolve_storage_paths,
    },
};
use kcoder_migration::{
    history_jobs::relocation::HistoryJobStorageRelocation,
    local_attachment::LocalAttachmentStorageRelocation,
};
use kcoder_state::history_storage_relocation::HistoryStorageRelocation;
use kcoder_types::{
    STORAGE_PERSISTENT_ROOT_DOMAIN, StorageLaunchIntent, StorageLocationRecord,
    StorageMigrationComponent, StorageMigrationPhase, StorageMigrationPlan, StorageTargetBinding,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

struct PublishedMove {
    _control_home: tempfile::TempDir,
    coordinator: StorageCoordinator,
    source: PathBuf,
    operation_id: String,
}

#[test]
fn offline_moves_preserve_job_ownership_with_damaged_archive_catalogues() {
    for damage in ["missing", "json", "scope", "directory"] {
        let fixture = Fixture::new();
        let jobs = HistoryJobStore::open_existing(&fixture.profile)
            .unwrap()
            .unwrap();
        jobs.read(&fixture.selection.job_id).unwrap();
        drop(jobs);
        let job_path = format!("migrations/history/{}.json", fixture.selection.job_id);
        let original_job = fs::read(fixture.profile.join(&job_path)).unwrap();
        let relative = "external-history/managed-v2/lifecycle.json";
        let path = fixture.profile.join(relative);
        match damage {
            "missing" => fs::remove_file(&path).unwrap(),
            "json" => fs::write(&path, b"{incomplete").unwrap(),
            _ => {
                let mut document: serde_json::Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                document[damage] = "unconfirmed-original".into();
                fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
            }
        }
        let original = fs::read(&path).ok();
        assert!(
            HistoryJobStore::open_existing(&fixture.profile)
                .unwrap()
                .unwrap()
                .read(&fixture.selection.job_id)
                .is_err()
        );
        let mut source = fixture.profile.clone();
        let mut controls = Vec::new();
        for round in 1..=2 {
            let target = fixture.root.path().join(format!("opaque-archive-{round}"));
            controls.push(relocate_stopped_profile(
                &source,
                &target,
                &format!("opaque-archive-{round}"),
            ));
            assert_eq!(fs::read(target.join(relative)).ok(), original);
            let moved = HistoryJobStore::open_existing(&target).unwrap().unwrap();
            assert_eq!(fs::read(target.join(&job_path)).unwrap(), original_job);
            assert!(moved.read(&fixture.selection.job_id).is_err());
            source = target;
        }
    }
}

#[test]
fn offline_moves_keep_damaged_jobs_opaque_and_healthy_jobs_readable() {
    let fixture = Fixture::new();
    let original_id = &fixture.selection.job_id;
    let jobs = HistoryJobStore::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let healthy = serde_json::to_value(jobs.read(original_id).unwrap()).unwrap();
    drop(jobs);
    let directory = fixture.profile.join("migrations/history");
    let mut wrong_owner: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join(format!("{original_id}.json"))).unwrap())
            .unwrap();
    let owner_id = key();
    assert_eq!(wrong_owner["view"]["jobId"], original_id.as_str());
    wrong_owner["view"]["jobId"] = owner_id.clone().into();
    wrong_owner["owner"] = "unconfirmed-original-owner".into();
    let damaged = vec![
        (key(), b"{incomplete journal".to_vec()),
        (key(), vec![b'x'; 128 * 1024 + 1]),
        (owner_id, serde_json::to_vec(&wrong_owner).unwrap()),
    ];
    for (id, payload) in &damaged {
        fs::write(directory.join(format!("{id}.json")), payload).unwrap();
    }
    let mut source = fixture.profile.clone();
    let mut controls = Vec::new();
    for round in 1..=2 {
        let target = fixture.root.path().join(format!("opaque-jobs-{round}"));
        controls.push(relocate_stopped_profile(
            &source,
            &target,
            &format!("opaque-jobs-{round}"),
        ));
        let moved = HistoryJobStore::open_existing(&target).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(moved.read(original_id).unwrap()).unwrap(),
            healthy
        );
        for (id, payload) in &damaged {
            for root in [&source, &target] {
                assert_eq!(
                    fs::read(root.join("migrations/history").join(format!("{id}.json"))).unwrap(),
                    *payload
                );
            }
            assert!(moved.read(id).is_err());
        }
        source = target;
    }
}

impl PublishedMove {
    fn new(source: &Path, target: &Path, operation_id: &str) -> Self {
        let control_home = tempfile::tempdir().unwrap();
        let config =
            PrivateDirectory::open_or_create(&control_home.path().join(".config")).unwrap();
        let cache = control_home.path().join("cache");
        PrivateDirectory::open_or_create(&cache).unwrap();
        let original = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: source.to_owned(),
            cache_root: cache.clone(),
            operation_id: None,
        };
        config
            .atomic_replace(
                std::ffi::OsStr::new("kcoder-storage.json"),
                &serde_json::to_vec(&original).unwrap(),
            )
            .unwrap();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(control_home.path().to_owned()),
            record: Some(original.clone()),
            ..Default::default()
        })
        .unwrap();
        let target_parent = target.parent().unwrap();
        let parent = PrivateDirectory::open_existing(target_parent).unwrap();
        let target_record = StorageLocationRecord {
            version: 1,
            revision: 2,
            data_root: target.to_owned(),
            cache_root: cache,
            operation_id: Some(operation_id.into()),
        };
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: operation_id.into(),
            original: Some(original),
            from,
            target: target_record,
            components: vec![StorageMigrationComponent {
                domain: STORAGE_PERSISTENT_ROOT_DOMAIN.into(),
                source: source.to_owned(),
                destination: target.to_owned(),
                source_identity: PrivateDirectory::open_existing(source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            target_bindings: vec![StorageTargetBinding {
                path: target.to_owned(),
                existing_ancestor: target_parent.to_owned(),
                ancestor_identity: parent.directory_identity().unwrap(),
            }],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        };
        let mut coordinator = StorageCoordinator::acquire(control_home.path()).unwrap();
        coordinator.begin(plan).unwrap();
        coordinator
            .advance(
                operation_id,
                StorageMigrationPhase::Planned,
                StorageMigrationPhase::Stopping,
            )
            .unwrap();
        coordinator
            .advance(
                operation_id,
                StorageMigrationPhase::Stopping,
                StorageMigrationPhase::Stopped,
            )
            .unwrap();
        coordinator
            .prepare_source_retirements(operation_id)
            .unwrap();
        Self {
            _control_home: control_home,
            coordinator,
            source: source.to_owned(),
            operation_id: operation_id.into(),
        }
    }

    fn publish(&mut self) -> StoragePublishedComponent {
        self.coordinator
            .advance(
                &self.operation_id,
                StorageMigrationPhase::Stopped,
                StorageMigrationPhase::Copying,
            )
            .unwrap();
        let exclusions = storage_writer_exclusions(&self.source);
        self.coordinator
            .publish_component(
                &self.operation_id,
                STORAGE_PERSISTENT_ROOT_DOMAIN,
                &exclusions,
            )
            .unwrap();
        self.coordinator
            .open_published_component(&self.operation_id, STORAGE_PERSISTENT_ROOT_DOMAIN)
            .unwrap()
    }
}

fn storage_writer_exclusions(root: &Path) -> BTreeSet<PathBuf> {
    fn visit(root: &Path, directory: &Path, result: &mut BTreeSet<PathBuf>) {
        for entry in fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() && !metadata.file_type().is_symlink() {
                visit(root, &path, result);
            } else if metadata.is_file()
                && entry.file_name() == std::ffi::OsStr::new("kcoder-storage-writers.lock")
            {
                result.insert(path.strip_prefix(root).unwrap().to_owned());
            }
        }
    }

    let mut result = BTreeSet::new();
    visit(root, root, &mut result);
    result
}

fn relocate_stopped_profile(source: &Path, target: &Path, operation_id: &str) -> tempfile::TempDir {
    let mut migration = PublishedMove::new(source, target, operation_id);
    let history_snapshot = HistoryStorageRelocation::snapshot(source).unwrap();
    let jobs_snapshot = HistoryJobStorageRelocation::snapshot(source).unwrap();
    let attachment_snapshot = LocalAttachmentStorageRelocation::snapshot(source).unwrap();

    let published = migration.publish();
    HistoryStorageRelocation::relocate(source, target, operation_id, &history_snapshot, &published)
        .unwrap();
    HistoryJobStorageRelocation::relocate(source, target, operation_id, &jobs_snapshot, &published)
        .unwrap();
    LocalAttachmentStorageRelocation::relocate(
        source,
        target,
        operation_id,
        &attachment_snapshot,
        &published,
    )
    .unwrap();

    HistoryStorageRelocation::verify_relocation(
        source,
        target,
        operation_id,
        &history_snapshot,
        &published,
    )
    .unwrap();
    HistoryJobStorageRelocation::verify_relocation(
        source,
        target,
        operation_id,
        &jobs_snapshot,
        &published,
    )
    .unwrap();
    LocalAttachmentStorageRelocation::verify_relocation(
        source,
        target,
        operation_id,
        &attachment_snapshot,
        &published,
    )
    .unwrap();
    for (from, to) in [
        (
            StorageMigrationPhase::Copying,
            StorageMigrationPhase::Verifying,
        ),
        (
            StorageMigrationPhase::Verifying,
            StorageMigrationPhase::Prepared,
        ),
    ] {
        migration
            .coordinator
            .advance(operation_id, from, to)
            .unwrap();
    }
    migration.coordinator.commit(operation_id).unwrap();
    migration.coordinator.complete(operation_id).unwrap();
    drop(migration.coordinator);
    migration._control_home
}

fn assert_upload_records(
    profile: &Path,
    id: &str,
    expected_grant: &[u8],
    expected_selection: Option<&[u8]>,
) {
    let directory = profile.join("migrations/local-attachment-uploads").join(id);
    assert_eq!(
        fs::read(directory.join("grant.json")).unwrap(),
        expected_grant
    );
    let selection = directory.join("selection.json");
    match expected_selection {
        Some(expected) => assert_eq!(fs::read(selection).unwrap(), expected),
        None => assert!(
            !selection.exists(),
            "Receiving upload gained a selection ticket"
        ),
    }
}

fn assert_cold_upload_state(
    profile: &Path,
    selection: &HistoricalAttachmentSelection,
    ready_id: &str,
    ready_bytes: &[u8],
    ready_sequence: u64,
    pending_id: &str,
    pending_bytes: &[u8],
    pending_sequence: u64,
) {
    let uploads = HistoryLocalAttachmentUploads::open_existing(profile)
        .unwrap()
        .unwrap();
    let ready_upload = uploads.read(ready_id).unwrap();
    assert!(ready_upload.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    assert_eq!(ready_upload.operation_id, ready_id);
    assert_eq!(ready_upload.sequence, ready_sequence);
    assert_eq!(ready_upload.received_bytes, ready_bytes.len() as u64);

    let pending_upload = uploads.read(pending_id).unwrap();
    assert!(pending_upload.stage == HistoricalLocalAttachmentUploadStage::Receiving);
    assert_eq!(pending_upload.operation_id, pending_id);
    assert_eq!(pending_upload.sequence, pending_sequence);
    assert_eq!(pending_upload.received_bytes, pending_bytes.len() as u64);
    assert_eq!(
        pending_upload.received_parts,
        pending_bytes
            .len()
            .div_ceil(HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize) as u32
    );

    let local = HistoryLocalAttachments::open_existing(profile)
        .unwrap()
        .unwrap();
    let job = local.read(ready_id).unwrap();
    assert_eq!(job.state.operation_id, ready_id);
    assert_eq!(job.selection, *selection);
    assert!(job.state.stage == HistoricalLocalAttachmentStage::Ready);
    assert_eq!(job.state.receipt.as_ref().unwrap().sha256, sha(ready_bytes));
    assert_eq!(
        local
            .chunk(
                ready_id,
                selection,
                job.state.receipt.as_ref().unwrap(),
                0,
                ready_bytes.len(),
            )
            .unwrap(),
        ready_bytes
    );
}

#[test]
fn offline_root_moves_preserve_upload_and_local_attachment_records_for_cold_reads() {
    let fixture = Fixture::new();
    let ready_id = key();
    let ready_bytes = b"upload completed before the offline root move";
    let ready_transfer = fixture.fill(&ready_id, ready_bytes);

    let pending_id = key();
    let pending_bytes = vec![11; HISTORICAL_LOCAL_UPLOAD_PART_BYTES as usize * 2 + 17];
    let pending_transfer = fixture.fill(&pending_id, &pending_bytes);

    let uploads = fixture.uploads();
    let finished = uploads
        .finish(&ready_id, ready_transfer.sequence, |_| true)
        .unwrap();
    assert!(finished.stage == HistoricalLocalAttachmentUploadStage::Authorized);
    let local = HistoryLocalAttachments::open_existing(&fixture.profile)
        .unwrap()
        .unwrap();
    let ready = local
        .run(
            &ready_id,
            finished.local_job.as_ref().unwrap().state.sequence,
            |_| true,
        )
        .unwrap();
    assert!(ready.state.stage == HistoricalLocalAttachmentStage::Ready);

    let ready_upload = uploads.read(&ready_id).unwrap();
    let pending_upload = uploads.read(&pending_id).unwrap();
    assert_eq!(pending_upload.sequence, pending_transfer.sequence);
    let ready_grant = fs::read(fixture.op(&ready_id).join("grant.json")).unwrap();
    let ready_selection = fs::read(fixture.op(&ready_id).join("selection.json")).unwrap();
    let pending_grant = fs::read(fixture.op(&pending_id).join("grant.json")).unwrap();
    assert_upload_records(&fixture.profile, &pending_id, &pending_grant, None);
    let local_job_record = fs::read(
        fixture
            .profile
            .join("migrations/history-local-attachments")
            .join(format!("{ready_id}.json")),
    )
    .unwrap();
    let history_job_record = fs::read(
        fixture
            .profile
            .join("migrations/history")
            .join(format!("{}.json", fixture.selection.job_id)),
    )
    .unwrap();

    // All owner handles have been dropped before Stopped is recorded and inventoried.
    drop(local);
    drop(uploads);

    let source = fixture.profile.clone();
    let first_target = fixture.root.path().join("profile-b");
    let _first_control = relocate_stopped_profile(&source, &first_target, "upload-relocation-1");
    assert_cold_upload_state(
        &first_target,
        &fixture.selection,
        &ready_id,
        ready_bytes,
        ready_upload.sequence,
        &pending_id,
        &pending_bytes,
        pending_upload.sequence,
    );
    assert_upload_records(
        &first_target,
        &ready_id,
        &ready_grant,
        Some(ready_selection.as_slice()),
    );
    assert_upload_records(&first_target, &pending_id, &pending_grant, None);
    assert_eq!(
        fs::read(
            first_target
                .join("migrations/history-local-attachments")
                .join(format!("{ready_id}.json"))
        )
        .unwrap(),
        local_job_record
    );
    assert_eq!(
        fs::read(
            first_target
                .join("migrations/history")
                .join(format!("{}.json", fixture.selection.job_id))
        )
        .unwrap(),
        history_job_record
    );

    let second_target = fixture.root.path().join("profile-c");
    let _second_control =
        relocate_stopped_profile(&first_target, &second_target, "upload-relocation-2");
    assert_cold_upload_state(
        &second_target,
        &fixture.selection,
        &ready_id,
        ready_bytes,
        ready_upload.sequence,
        &pending_id,
        &pending_bytes,
        pending_upload.sequence,
    );
    assert_upload_records(
        &second_target,
        &ready_id,
        &ready_grant,
        Some(ready_selection.as_slice()),
    );
    assert_upload_records(&second_target, &pending_id, &pending_grant, None);
    assert_eq!(
        fs::read(
            second_target
                .join("migrations/history-local-attachments")
                .join(format!("{ready_id}.json"))
        )
        .unwrap(),
        local_job_record
    );
    assert_eq!(
        fs::read(
            second_target
                .join("migrations/history")
                .join(format!("{}.json", fixture.selection.job_id))
        )
        .unwrap(),
        history_job_record
    );
}
