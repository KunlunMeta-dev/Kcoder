use super::*;
use kcoder_types::{
    StorageLaunchIntent, StorageLocationRecord, StorageMigrationPhase as Phase,
    StorageMigrationPlan, StorageTargetBinding,
};
use std::fs;

const ID: &str = "publication-fixture";
const DOMAIN: &str = "native";
const BODY: &[u8] = b"original persistent bytes";

#[test]
fn changing_copy_receipt_invalidates_its_held_source_proof() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let key = format!("copy-{DOMAIN}");
    let original = coordinator.current().unwrap().unwrap().owner_receipts[&key].clone();
    let mut changed = original.clone();
    changed["authorizedVersions"] = serde_json::json!([]);
    let recorded = coordinator
        .record_owner_receipt(ID, &key, Some(&original), changed.clone())
        .unwrap();

    let error = coordinator
        .open_published_component(ID, DOMAIN)
        .unwrap_err();
    assert!(error.to_string().contains("STORAGE_TREE_MANIFEST_CONFLICT"));
    assert_eq!(coordinator.current().unwrap().unwrap(), recorded);
    assert_eq!(recorded.owner_receipts[&key], changed);
    for path in [&fixture.source, fixture.destination()] {
        assert_eq!(fs::read(path.join("settings.json")).unwrap(), BODY);
    }
}

#[test]
fn recovered_publication_rechecks_original_source_without_recopying_the_target() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let original = coordinator.current().unwrap().unwrap();
    let file_id = |directory: &PrivateDirectory| {
        crate::PortableLeaseIdentity::from_regular_handle(
            &directory
                .open_single_link_regular_file(OsStr::new("settings.json"))
                .unwrap(),
        )
        .unwrap()
    };
    let source = PrivateDirectory::open_existing(&fixture.source).unwrap();
    let source_file = file_id(&source);
    let target = PrivateDirectory::open_existing(fixture.destination()).unwrap();
    let target_file = file_id(&target);
    drop(coordinator);
    fs::write(
        fixture.source.join("settings.json"),
        b"new source business data",
    )
    .unwrap();
    assert_eq!(file_id(&source), source_file);

    let mut recovered = fixture.coordinator_when_unowned();
    let error = recovered
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap_err();
    assert!(error.to_string().contains("STORAGE_TREE_SOURCE_CHANGED"));
    assert_eq!(recovered.current().unwrap().unwrap(), original);
    assert_eq!(file_id(&target), target_file);
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    assert_eq!(
        fs::read(fixture.source.join("settings.json")).unwrap(),
        b"new source business data"
    );
}

#[test]
fn checked_publication_rejects_before_copy_and_never_recopies_converted_payload() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let exclusions = BTreeSet::new();
    let error = coordinator
        .publish_component_checked(ID, DOMAIN, &exclusions, |_| {
            anyhow::bail!("OWNER_INVENTORY_REJECTED")
        })
        .unwrap_err();
    assert!(error.to_string().contains("OWNER_INVENTORY_REJECTED"));
    assert!(!fixture.destination().join("settings.json").exists());
    assert!(
        !coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .contains_key("copy-native")
    );

    let mut validations = 0;
    let published = coordinator
        .publish_component_checked(ID, DOMAIN, &exclusions, |_| {
            validations += 1;
            Ok(())
        })
        .unwrap();
    assert!(matches!(published, StorageComponentDirectory::Published(_)));
    assert_eq!(validations, 1);
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    fs::write(
        fixture.destination().join("settings.json"),
        b"converted metadata",
    )
    .unwrap();
    coordinator
        .publish_component_checked(ID, DOMAIN, &exclusions, |_| {
            panic!("published metadata must not enter the raw copier again")
        })
        .unwrap();
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        b"converted metadata"
    );
    assert_eq!(
        fs::read(fixture.source.join("settings.json")).unwrap(),
        BODY
    );
}

struct Fixture {
    root: tempfile::TempDir,
    home: PathBuf,
    source: PathBuf,
    parent: PathBuf,
    plan: StorageMigrationPlan,
}

impl Fixture {
    fn coordinator_when_unowned(&self) -> StorageCoordinator {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match StorageCoordinator::acquire(&self.home) {
                Ok(coordinator) => return coordinator,
                Err(error)
                    if error.to_string() == "STORAGE_MIGRATION_BUSY"
                        && std::time::Instant::now() < deadline =>
                {
                    // Other parallel tests can spawn children while a dropped
                    // fixture lease is still briefly held. Never unlock it here.
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(error) => panic!("owned fixture coordinator was not released: {error:#}"),
            }
        }
    }

    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_existing(root.path()).unwrap();
        for name in ["home", "source", "target"] {
            base.create_child(OsStr::new(name)).unwrap();
        }
        let home = root.path().join("home");
        let source = root.path().join("source");
        let parent = root.path().join("target");
        let destination = parent.join("component");
        fs::write(source.join("settings.json"), BODY).unwrap();
        fs::create_dir(source.join("empty")).unwrap();
        let source_identity = PrivateDirectory::open_existing(&source)
            .unwrap()
            .directory_identity()
            .unwrap();
        let parent_identity = PrivateDirectory::open_existing(&parent)
            .unwrap()
            .directory_identity()
            .unwrap();
        let from = super::super::resolve_storage_paths(&super::super::StorageResolveInput {
            home: Some(home.clone()),
            ..Default::default()
        })
        .unwrap();
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: ID.into(),
            original: None,
            from,
            target: StorageLocationRecord {
                version: 1,
                revision: 1,
                data_root: destination.clone(),
                cache_root: root.path().join("cache"),
                operation_id: Some(ID.into()),
            },
            components: vec![StorageMigrationComponent {
                domain: DOMAIN.into(),
                source: source.clone(),
                destination: destination.clone(),
                source_identity,
                estimated_bytes: BODY.len() as u64,
            }],
            target_bindings: vec![StorageTargetBinding {
                path: destination,
                existing_ancestor: parent.clone(),
                ancestor_identity: parent_identity,
            }],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        };
        Self {
            root,
            home,
            source,
            parent,
            plan,
        }
    }

    fn destination(&self) -> &Path {
        &self.plan.components[0].destination
    }

    fn in_place() -> Self {
        let mut fixture = Self::new();
        fixture.source = fixture.plan.from.data_root.clone();
        fs::create_dir_all(&fixture.source).unwrap();
        fs::write(fixture.source.join("settings.json"), BODY).unwrap();
        fixture.plan.components[0].source = fixture.source.clone();
        fixture.plan.components[0].source_identity =
            PrivateDirectory::open_existing(&fixture.source)
                .unwrap()
                .directory_identity()
                .unwrap();
        fixture.plan.target.data_root = fixture.source.clone();
        fixture.plan.components[0].destination = fixture.source.clone();
        fixture.plan.target_bindings = vec![StorageTargetBinding {
            path: fixture.source.clone(),
            existing_ancestor: fixture.source.clone(),
            ancestor_identity: fixture.plan.components[0].source_identity.clone(),
        }];
        fixture
    }

    fn set_destination(&mut self, destination: PathBuf) {
        self.plan.components[0].destination = destination.clone();
        self.plan.target.data_root = destination.clone();
        self.plan.target_bindings[0].path = destination;
    }

    fn stage_path(&self) -> PathBuf {
        self.destination().parent().unwrap().join(staging_name(
            ID,
            DOMAIN,
            self.destination().file_name().unwrap(),
        ))
    }

    fn select_existing_empty_root(&mut self) -> String {
        fs::create_dir(self.destination()).unwrap();
        let identity = PrivateDirectory::open_existing(self.destination())
            .unwrap()
            .directory_identity()
            .unwrap();
        self.plan.target_bindings[0].existing_ancestor = self.destination().to_owned();
        self.plan.target_bindings[0].ancestor_identity = identity.clone();
        identity
    }

    fn stopped(&self) -> StorageCoordinator {
        let mut coordinator = self.coordinator_when_unowned();
        coordinator.begin(self.plan.clone()).unwrap();
        coordinator
            .advance(ID, Phase::Planned, Phase::Stopping)
            .unwrap();
        coordinator
            .advance(ID, Phase::Stopping, Phase::Stopped)
            .unwrap();
        coordinator
            .advance(ID, Phase::Stopped, Phase::Copying)
            .unwrap();
        coordinator
    }

    fn intent(&self, coordinator: &StorageCoordinator) -> PublicationIntent {
        let receipt = coordinator.current().unwrap().unwrap();
        serde_json::from_value(receipt.owner_receipts[&owner_key(DOMAIN).unwrap()].clone()).unwrap()
    }

    fn commit(&self, coordinator: &mut StorageCoordinator) {
        coordinator
            .advance(ID, Phase::Copying, Phase::Verifying)
            .unwrap();
        coordinator
            .advance(ID, Phase::Verifying, Phase::Prepared)
            .unwrap();
        coordinator.commit(ID).unwrap();
    }

    fn complete(&self, coordinator: &mut StorageCoordinator) {
        self.commit(coordinator);
        coordinator.complete(ID).unwrap();
    }

    fn complete_before_pending_cleanup(&self, coordinator: &mut StorageCoordinator) {
        self.commit(coordinator);
        // Reproduce exit after the authoritative Complete write, before unlink.
        let mut receipt = coordinator.current().unwrap().unwrap();
        receipt.phase = Phase::Verified;
        receipt.disposition = kcoder_types::StorageMigrationDisposition::Complete;
        receipt.error_code = None;
        super::super::control::check_receipt(&receipt).unwrap();
        PrivateDirectory::open_existing(
            &self.home.join(".config/kcoder-storage-migrations").join(ID),
        )
        .unwrap()
        .atomic_replace(
            OsStr::new("receipt.json"),
            &serde_json::to_vec_pretty(&receipt).unwrap(),
        )
        .unwrap();
    }

    fn assert_source_preserved(&self) {
        assert_eq!(fs::read(self.source.join("settings.json")).unwrap(), BODY);
        assert_eq!(
            PrivateDirectory::open_existing(&self.source)
                .unwrap()
                .directory_identity()
                .unwrap(),
            self.plan.components[0].source_identity
        );
    }
}

fn prepared(coordinator: &mut StorageCoordinator) -> PrivateDirectory {
    match coordinator.prepare_component_staging(ID, DOMAIN).unwrap() {
        StorageComponentDirectory::Staging(directory) => directory,
        other => panic!("expected staging, got {other:?}"),
    }
}

fn node_pending_probe(home: &Path, root: &Path, expected: &str) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/kcoder-studio/src/storage-source-retirement.test.mjs");
    let output = std::process::Command::new("node")
        .arg(script)
        .arg("--owned-pending-probe")
        .arg(home)
        .arg(root)
        .arg(expected)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("target-pending-rust-probe-ok"));
}

#[test]
fn active_publication_scopes_retain_paths_and_identity_after_a_directory_is_renamed() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    let identity = staging.directory_identity().unwrap();
    let receipt = coordinator.current().unwrap().unwrap();
    let expected = BTreeMap::from([
        (fixture.stage_path(), identity.clone()),
        (fixture.destination().to_owned(), identity.clone()),
    ]);
    assert_eq!(
        active_component_directory_scopes(&receipt).unwrap(),
        expected
    );

    drop(staging);
    let renamed = fixture.parent.join("renamed-owned-directory");
    fs::rename(fixture.stage_path(), &renamed).unwrap();
    assert_eq!(
        active_component_directory_scopes(&receipt).unwrap(),
        expected
    );
    assert_eq!(
        PrivateDirectory::open_existing(&renamed)
            .unwrap()
            .directory_identity()
            .unwrap(),
        identity
    );
    assert!(!fixture.stage_path().exists());
    assert!(!fixture.destination().exists());
    assert_eq!(
        super::super::read_storage_migration(&fixture.home)
            .unwrap()
            .unwrap(),
        receipt
    );
    assert_eq!(
        coordinator.current().unwrap_err().to_string(),
        "STORAGE_ROOT_CHANGED"
    );
}

#[test]
fn active_container_scope_exists_before_its_copy_checkpoint_and_after_owner_conversion() {
    let mut fixture = Fixture::new();
    let identity = fixture.select_existing_empty_root();
    let mut coordinator = fixture.stopped();
    prepared(&mut coordinator);
    let expected = BTreeMap::from([(fixture.destination().to_owned(), identity)]);
    let receipt = coordinator.current().unwrap().unwrap();
    assert!(
        fixture
            .intent(&coordinator)
            .container
            .unwrap()
            .published_copy
            .is_none()
    );
    assert_eq!(
        active_component_directory_scopes(&receipt).unwrap(),
        expected
    );

    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    fs::write(
        fixture.destination().join("settings.json"),
        b"owner conversion",
    )
    .unwrap();
    assert_eq!(
        active_component_directory_scopes(&coordinator.current().unwrap().unwrap()).unwrap(),
        expected
    );
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        b"owner conversion"
    );
}

#[test]
fn active_publication_scopes_fail_closed_on_unknown_or_conflicting_owner_metadata() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    prepared(&mut coordinator);
    let receipt = coordinator.current().unwrap().unwrap();
    let key = owner_key(DOMAIN).unwrap();
    for (field, value) in [
        ("version", serde_json::json!(3)),
        ("operationId", serde_json::json!("other-operation")),
        ("domain", serde_json::json!("unknown")),
        ("sourceIdentity", serde_json::json!("unix:1:1")),
        (
            "destination",
            serde_json::json!(fixture.parent.join("other")),
        ),
        ("stagingName", serde_json::json!("../other")),
        (
            "stagingIdentity",
            serde_json::json!("invented-directory-id"),
        ),
        ("unexpected", serde_json::json!(true)),
    ] {
        let mut damaged = receipt.clone();
        damaged.owner_receipts.get_mut(&key).unwrap()[field] = value;
        assert!(
            active_component_directory_scopes(&damaged).is_err(),
            "{field}"
        );
    }
    let mut unknown = receipt.clone();
    unknown.owner_receipts.insert(
        "publish-unknown".into(),
        receipt.owner_receipts[&key].clone(),
    );
    assert!(active_component_directory_scopes(&unknown).is_err());
    let mut duplicate = receipt.clone();
    duplicate
        .plan
        .components
        .push(duplicate.plan.components[0].clone());
    assert!(active_component_directory_scopes(&duplicate).is_err());
    assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
    assert!(!fixture.destination().exists());
}

#[test]
fn prepares_a_held_stage_and_records_native_ownership_before_copying() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();

    let staging = prepared(&mut coordinator);
    let intent = fixture.intent(&coordinator);

    assert_eq!(
        intent.staging_identity,
        staging.directory_identity().unwrap()
    );
    assert_eq!(intent.destination, fixture.destination());
    assert!(fixture.stage_path().is_dir());
    assert!(!fixture.destination().exists());
    let name = OsStr::new(super::super::writers::WRITERS);
    assert_eq!(
        staging
            .entry_names_bounded(2)
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([name.to_owned(), OsString::from(pending::LEAF)])
    );
    let fence = staging.open_entry_handle(name).unwrap();
    assert!(fence.metadata().is_file());
    assert_eq!(fence.metadata().len(), 0);
    assert!(
        coordinator
            .held_writer_fence_identities(ID)
            .unwrap()
            .contains(&fence.identity().unwrap())
    );
    assert!(
        pending::target_control(&mut coordinator, ID, &staging)
            .unwrap()
            .is_some()
    );
    assert_eq!(
        prepared(&mut coordinator).directory_identity().unwrap(),
        intent.staging_identity
    );
    fixture.assert_source_preserved();
}

#[test]
fn copies_and_publishes_the_same_owned_directory_without_touching_source_or_selection() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    let identity = staging.directory_identity().unwrap();
    let copied = coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    assert_eq!(copied.files_copied, 1);

    let published = coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();

    let StorageComponentDirectory::Published(directory) = published else {
        panic!("not published")
    };
    assert_eq!(directory.directory_identity().unwrap(), identity);
    assert!(!fixture.stage_path().exists());
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    assert!(fixture.destination().join("empty").is_dir());
    assert!(!super::super::storage_location_file(&fixture.home).exists());
    assert_eq!(
        coordinator.current().unwrap().unwrap().phase,
        Phase::Copying
    );
    fixture.assert_source_preserved();
}

#[cfg(windows)]
#[test]
#[ignore = "requires KCODER_E2E_STORAGE_CROSS_VOLUME=1 and an explicit second-volume owned root"]
fn windows_cross_volume_publication_recovers_original_operation_and_preserves_source() {
    cross_volume_publication_recovers_original_operation_and_preserves_source();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires KCODER_E2E_STORAGE_CROSS_VOLUME=1 and an explicit second-filesystem owned root"]
fn linux_cross_filesystem_publication_recovers_original_operation_and_preserves_source() {
    cross_volume_publication_recovers_original_operation_and_preserves_source();
}

#[cfg(any(windows, target_os = "linux"))]
fn cross_volume_publication_recovers_original_operation_and_preserves_source() {
    use std::io::Read;

    assert_eq!(
        std::env::var("KCODER_E2E_STORAGE_CROSS_VOLUME").as_deref(),
        Ok("1")
    );
    let root = PathBuf::from(
        std::env::var_os("KCODER_E2E_STORAGE_CROSS_VOLUME_ROOT")
            .expect("supply the existing root created by ownedCreationScript on the second volume"),
    );
    assert!(root.is_absolute());
    let parent = PrivateDirectory::open_existing(&root).unwrap();
    let marker = parent
        .open_single_link_regular_file(OsStr::new(".owner.json"))
        .unwrap();
    let owner: serde_json::Value = serde_json::from_reader(marker.take(4096)).unwrap();
    let owner = owner["owner"].as_str().unwrap();
    assert_eq!(
        root.file_name().unwrap(),
        OsStr::new(&format!("kcoder-package-{owner}"))
    );
    assert_eq!(owner.len(), 36);
    let target = tempfile::Builder::new()
        .prefix("storage-cross-volume-")
        .tempdir_in(&root)
        .unwrap();
    let target_directory = PrivateDirectory::open_existing(target.path()).unwrap();
    let target_identity = target_directory.directory_identity().unwrap();
    let mut fixture = Fixture::new();
    let source_identity = &fixture.plan.components[0].source_identity;
    assert_ne!(
        source_identity.split(':').nth(1),
        target_identity.split(':').nth(1),
        "the explicit target must have a different native volume or device identity"
    );
    fixture.parent = target.path().to_owned();
    fixture.set_destination(fixture.parent.join("迁移 数据"));
    fixture.plan.target_bindings[0].existing_ancestor = fixture.parent.clone();
    fixture.plan.target_bindings[0].ancestor_identity = target_identity.clone();
    fs::create_dir(fixture.source.join("attachments")).unwrap();
    fs::write(
        fixture.source.join("attachments/附件.txt"),
        b"original attachment",
    )
    .unwrap();
    let database = fixture.source.join("history.sqlite");
    {
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('original-session');").unwrap();
    }
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    assert_eq!(
        staging.directory_identity().unwrap().split(':').nth(1),
        target_identity.split(':').nth(1),
        "staging must be on the target volume"
    );
    let copied = coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    assert_eq!(copied.files_copied, 3);
    drop(staging);
    drop(coordinator);

    let mut coordinator = fixture.coordinator_when_unowned();
    assert_eq!(
        coordinator.current().unwrap().unwrap().plan.operation_id,
        ID
    );
    let published = coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    assert!(matches!(published, StorageComponentDirectory::Published(_)));
    assert!(!super::super::storage_location_file(&fixture.home).exists());
    let connection = rusqlite::Connection::open_with_flags(
        fixture.destination().join("history.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let session: String = connection
        .query_row("SELECT id FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(session, "original-session");
    drop(connection);
    assert_eq!(
        fs::read(fixture.destination().join("attachments/附件.txt")).unwrap(),
        b"original attachment"
    );
    drop(published);
    fixture.complete(&mut coordinator);
    let record = super::super::read_storage_location_record(&super::super::storage_location_file(
        &fixture.home,
    ))
    .unwrap()
    .unwrap();
    assert_eq!(record.operation_id.as_deref(), Some(ID));
    assert_eq!(record.data_root, fixture.destination());
    fixture.assert_source_preserved();
    assert!(database.is_file());
    assert_eq!(
        fs::read(fixture.source.join("attachments/附件.txt")).unwrap(),
        b"original attachment"
    );
    drop(coordinator);
    drop(target_directory);
}

#[test]
fn publication_follows_nested_fences_without_replacing_their_original_files() {
    let fixture = Fixture::new();
    drop(super::super::writers::RootLease::shared(&fixture.source.join("empty"), true).unwrap());
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    coordinator.prepare_offline_child_fences(ID).unwrap();
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    coordinator
        .fence_component_directory(
            &fixture.stage_path().join("empty"),
            &staging.open_child(OsStr::new("empty"), false).unwrap(),
        )
        .unwrap();
    let original = coordinator.prepare_offline_child_fences(ID).unwrap();
    assert!(
        original
            .roots
            .iter()
            .any(|root| root.root == fixture.stage_path().join("empty"))
    );
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let published = coordinator.prepare_offline_child_fences(ID).unwrap();
    assert_eq!(original.roots.len(), published.roots.len());
    for mut expected in original.roots {
        if let Ok(relative) = expected.root.strip_prefix(fixture.stage_path()) {
            expected.root = if relative.as_os_str().is_empty() {
                fixture.destination().to_owned()
            } else {
                fixture.destination().join(relative)
            };
        }
        let actual = published
            .roots
            .iter()
            .find(|root| **root == expected)
            .unwrap();
        assert_eq!(actual.root.as_os_str(), expected.root.as_os_str());
    }
    assert!(!fixture.stage_path().exists());
    fixture.assert_source_preserved();
}

#[test]
#[cfg(windows)]
fn windows_publication_pending_gate_covers_released_target_fences_and_preserves_source_exclusion() {
    let fixture = Fixture::new();
    drop(super::super::writers::RootLease::shared(&fixture.source.join("empty"), true).unwrap());
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    coordinator.prepare_offline_child_fences(ID).unwrap();
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    coordinator
        .fence_component_directory(
            &fixture.stage_path().join("empty"),
            &staging.open_child(OsStr::new("empty"), false).unwrap(),
        )
        .unwrap();
    let before = coordinator.prepare_offline_child_fences(ID).unwrap();
    assert!(
        before
            .roots
            .iter()
            .any(|root| root.root == fixture.stage_path().join("empty"))
    );
    let peer_home = tempfile::tempdir().unwrap();
    let mut visited = false;
    let published = publish_with_hook(
        &mut coordinator,
        ID,
        DOMAIN,
        &BTreeSet::new(),
        |_| Ok(()),
        |phase| {
            if phase != PublicationCheckpoint::TargetFencesReleasedBeforeRename {
                return Ok(());
            }
            visited = true;
            for root in [fixture.stage_path(), fixture.stage_path().join("empty")] {
                let error =
                    super::super::StorageInstance::open(super::super::StorageResolveInput {
                        home: Some(peer_home.path().to_owned()),
                        env: BTreeMap::from([("KCODER_HOME".into(), root.into_os_string())]),
                        ..Default::default()
                    })
                    .err()
                    .expect("released target fences admitted an explicit data writer");
                assert_eq!(error.to_string(), "STORAGE_MIGRATION_PENDING");
            }
            let error = super::super::StorageInstance::open(super::super::StorageResolveInput {
                home: Some(peer_home.path().to_owned()),
                env: BTreeMap::from([
                    (
                        "KCODER_HOME".into(),
                        peer_home.path().join("profile").into_os_string(),
                    ),
                    (
                        "KCODER_CACHE_DIR".into(),
                        fixture.stage_path().into_os_string(),
                    ),
                ]),
                ..Default::default()
            })
            .err()
            .expect("released target fences admitted an explicit cache writer");
            assert_eq!(error.to_string(), "STORAGE_MIGRATION_PENDING");
            let source = PrivateDirectory::open_existing(&fixture.source).unwrap();
            assert!(
                source
                    .try_existing_shared_lock(OsStr::new(super::super::writers::WRITERS))
                    .unwrap()
                    .is_none(),
                "the original source fence must remain exclusive throughout publication"
            );
            Ok(())
        },
    )
    .unwrap();
    assert!(visited);
    let StorageComponentDirectory::Published(published) = published else {
        panic!("expected a published component")
    };
    assert_eq!(
        published.directory_identity().unwrap(),
        staging.directory_identity().unwrap()
    );
    assert!(!fixture.stage_path().exists());
    let after = coordinator.prepare_offline_child_fences(ID).unwrap();
    assert_eq!(after.roots.len(), before.roots.len());
    for mut expected in before.roots {
        if let Ok(relative) = expected.root.strip_prefix(fixture.stage_path()) {
            expected.root = fixture.destination().join(relative);
        }
        assert!(after.roots.contains(&expected));
    }
    assert!(!peer_home.path().join(".config").exists());
    assert!(!super::super::storage_location_file(&fixture.home).exists());
    fixture.assert_source_preserved();
}

#[test]
#[cfg(windows)]
fn windows_publication_reacquires_original_fences_after_an_interrupted_rename_window() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    let fences = coordinator.prepare_offline_child_fences(ID).unwrap();
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    let original = coordinator.current().unwrap().unwrap();
    let error = publish_with_hook(
        &mut coordinator,
        ID,
        DOMAIN,
        &BTreeSet::new(),
        |_| Ok(()),
        |phase| {
            if phase == PublicationCheckpoint::TargetFencesReleasedBeforeRename {
                anyhow::bail!("injected interrupted rename window");
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("injected interrupted rename window"));
    assert_eq!(coordinator.current().unwrap().unwrap(), original);
    coordinator
        .validate_offline_child_fences(ID, &fences)
        .unwrap();
    assert!(fixture.stage_path().is_dir());
    assert!(!fixture.destination().exists());
    let peer_home = tempfile::tempdir().unwrap();
    let error = super::super::StorageInstance::open(super::super::StorageResolveInput {
        home: Some(peer_home.path().to_owned()),
        env: BTreeMap::from([("KCODER_HOME".into(), fixture.stage_path().into_os_string())]),
        ..Default::default()
    })
    .err()
    .expect("the original stage fence was not reacquired after checkpoint failure");
    assert_eq!(error.to_string(), "STORAGE_MIGRATION_BUSY");
    drop(staging);
    drop(coordinator);

    let mut recovered = fixture.coordinator_when_unowned();
    assert_eq!(recovered.current().unwrap().unwrap(), original);
    drop(prepared(&mut recovered));
    assert_eq!(recovered.prepare_offline_child_fences(ID).unwrap(), fences);
    let published = recovered
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let StorageComponentDirectory::Published(published) = published else {
        panic!("original operation did not recover its stage")
    };
    let after = recovered.prepare_offline_child_fences(ID).unwrap();
    for mut expected in fences.roots {
        if expected.root == fixture.stage_path() {
            expected.root = fixture.destination().to_owned();
            assert_eq!(
                published.directory_identity().unwrap(),
                expected.directory_identity
            );
        }
        assert!(after.roots.contains(&expected));
    }
    let receipt = recovered.current().unwrap().unwrap();
    assert_eq!(receipt.plan.operation_id, ID);
    assert_eq!(receipt.owner_receipts, original.owner_receipts);
    assert!(!super::super::storage_location_file(&fixture.home).exists());
    fixture.assert_source_preserved();
}

#[test]
#[cfg(windows)]
fn windows_publication_restore_rejects_a_replaced_fence_and_keeps_pending_admission_closed() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    coordinator.prepare_offline_child_fences(ID).unwrap();
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    let original = coordinator.current().unwrap().unwrap();
    let marker_identity = pending_control_identity(
        &staging
            .open_single_link_regular_file(OsStr::new(pending::LEAF))
            .unwrap(),
    )
    .unwrap();
    let error = publish_with_hook(
        &mut coordinator,
        ID,
        DOMAIN,
        &BTreeSet::new(),
        |_| Ok(()),
        |phase| {
            if phase == PublicationCheckpoint::TargetFencesReleasedBeforeRename {
                staging.atomic_replace(OsStr::new("kcoder-storage-instances.lock"), b"")?;
                anyhow::bail!("injected replacement during the rename window");
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(format!("{error:#}").contains("STORAGE_COMPONENT_FENCE_RESTORE_FAILED"));
    assert!(format!("{error:#}").contains("STORAGE_COMPONENT_FENCE_CHANGED"));
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(receipt, original);
    assert_eq!(receipt.plan.operation_id, ID);
    assert_eq!(receipt.phase, Phase::Copying);
    assert_eq!(
        receipt.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );
    assert!(fixture.stage_path().is_dir());
    assert!(!fixture.destination().exists());
    assert_eq!(
        pending_control_identity(
            &staging
                .open_single_link_regular_file(OsStr::new(pending::LEAF))
                .unwrap()
        )
        .unwrap(),
        marker_identity
    );
    assert!(
        PrivateDirectory::open_existing(&fixture.source)
            .unwrap()
            .try_existing_shared_lock(OsStr::new(super::super::writers::WRITERS))
            .unwrap()
            .is_none()
    );
    // A failed secondary restore releases its temporary primary. Admission
    // therefore depends on the authenticated pending gate in this state.
    assert!(
        staging
            .try_existing_shared_lock(OsStr::new(super::super::writers::WRITERS))
            .unwrap()
            .is_some()
    );
    let peer_home = tempfile::tempdir().unwrap();
    for cache in [false, true] {
        let mut env = BTreeMap::from([(
            "KCODER_HOME".into(),
            if cache {
                peer_home.path().join("profile")
            } else {
                fixture.stage_path()
            }
            .into_os_string(),
        )]);
        if cache {
            env.insert(
                "KCODER_CACHE_DIR".into(),
                fixture.stage_path().into_os_string(),
            );
        }
        let error = super::super::StorageInstance::open(super::super::StorageResolveInput {
            home: Some(peer_home.path().to_owned()),
            env,
            ..Default::default()
        })
        .err()
        .expect("failed fence restoration admitted an explicit business writer");
        assert_eq!(error.to_string(), "STORAGE_MIGRATION_PENDING");
    }
    assert!(!super::super::storage_location_file(&fixture.home).exists());
    fixture.assert_source_preserved();
}

#[test]
fn a_published_new_target_blocks_an_explicit_writer_from_an_independent_home() {
    let fixture = Fixture::new();
    assert!(!fixture.destination().exists());
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    assert!(matches!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
        StorageComponentDirectory::Published(_)
    ));
    assert_eq!(
        coordinator.current().unwrap().unwrap().phase,
        Phase::Copying
    );

    // This independent Home has no migration record or instance lease. Only
    // the published target's live root fence can reject its explicit writer.
    let peer_home = tempfile::tempdir().unwrap();
    let error = super::super::StorageInstance::open(super::super::StorageResolveInput {
        home: Some(peer_home.path().to_owned()),
        env: BTreeMap::from([(
            "KCODER_HOME".into(),
            fixture.destination().as_os_str().to_owned(),
        )]),
        ..Default::default()
    })
    .err()
    .expect("published target admitted an explicit writer during its original migration");
    assert_eq!(error.to_string(), "STORAGE_MIGRATION_BUSY");
    assert!(!peer_home.path().join(".config").exists());
    assert_eq!(
        coordinator.current().unwrap().unwrap().phase,
        Phase::Copying
    );
    fixture.assert_source_preserved();
}

#[test]
fn a_published_new_target_rejects_an_independent_home_after_executor_exit() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    assert!(matches!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
        StorageComponentDirectory::Published(_)
    ));
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(receipt.phase, Phase::Copying);
    assert_eq!(
        receipt.disposition,
        kcoder_types::StorageMigrationDisposition::Active
    );
    drop(staging);
    drop(coordinator);
    assert_eq!(
        super::super::read_storage_operation(&fixture.home, ID)
            .unwrap()
            .unwrap(),
        receipt
    );

    let peer_home = tempfile::tempdir().unwrap();
    let error = super::super::StorageInstance::open(super::super::StorageResolveInput {
        home: Some(peer_home.path().to_owned()),
        env: BTreeMap::from([(
            "KCODER_HOME".into(),
            fixture.destination().as_os_str().to_owned(),
        )]),
        ..Default::default()
    })
    .err()
    .expect("published target admitted an explicit writer after its active executor exited");
    assert_eq!(error.to_string(), "STORAGE_MIGRATION_PENDING");
    assert!(!peer_home.path().join(".config").exists());
    assert_eq!(
        super::super::read_storage_operation(&fixture.home, ID)
            .unwrap()
            .unwrap(),
        receipt
    );
    fixture.assert_source_preserved();
}

#[test]
fn target_pending_admission_requires_complete_original_receipt_and_current_selection() {
    for damage in [
        "none",
        "receipt-missing",
        "receipt-corrupt",
        "selector-missing",
        "selector-changed",
        "control-replaced",
        "operation-replaced",
        "marker-corrupt",
        "marker-hardlink",
        "copy-evidence-missing",
    ] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.stopped();
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap();
        fixture.complete_before_pending_cleanup(&mut coordinator);
        drop(coordinator);
        let control = fixture.home.join(".config");
        let archive = control
            .join("kcoder-storage-migrations")
            .join(ID)
            .join("receipt.json");
        match damage {
            "receipt-missing" => fs::remove_file(archive).unwrap(),
            "receipt-corrupt" => fs::write(archive, b"unknown receipt").unwrap(),
            "selector-missing" => fs::remove_file(control.join("kcoder-storage.json")).unwrap(),
            "selector-changed" => {
                let mut selected = fixture.plan.target.clone();
                selected.revision += 1;
                fs::write(
                    control.join("kcoder-storage.json"),
                    serde_json::to_vec(&selected).unwrap(),
                )
                .unwrap();
            }
            "control-replaced" => {
                fs::rename(&control, fixture.home.join("original-control")).unwrap();
                fs::create_dir(&control).unwrap();
            }
            "operation-replaced" => {
                let bytes = fs::read(&archive).unwrap();
                fs::rename(
                    archive.parent().unwrap(),
                    fixture.home.join("original-operation"),
                )
                .unwrap();
                fs::create_dir(archive.parent().unwrap()).unwrap();
                fs::write(&archive, bytes).unwrap();
            }
            "marker-corrupt" => {
                fs::write(fixture.destination().join(pending::LEAF), b"unknown marker").unwrap()
            }
            "marker-hardlink" => fs::hard_link(
                fixture.destination().join(pending::LEAF),
                fixture.home.join("marker-alias"),
            )
            .unwrap(),
            "copy-evidence-missing" => {
                let mut receipt = super::super::read_storage_operation(&fixture.home, ID)
                    .unwrap()
                    .unwrap();
                receipt.owner_receipts.remove(&format!("copy-{DOMAIN}"));
                fs::write(&archive, serde_json::to_vec(&receipt).unwrap()).unwrap();
            }
            _ => {}
        }
        let peer = tempfile::tempdir().unwrap();
        let attempt = super::super::StorageInstance::open(super::super::StorageResolveInput {
            home: Some(peer.path().to_owned()),
            env: BTreeMap::from([
                (
                    "KCODER_HOME".into(),
                    fixture.destination().as_os_str().to_owned(),
                ),
                (
                    "KCODER_CACHE_DIR".into(),
                    peer.path().join("cache").into_os_string(),
                ),
            ]),
            ..Default::default()
        });
        if damage == "none" {
            assert!(attempt.is_ok());
        } else {
            assert_eq!(
                attempt.err().unwrap().to_string(),
                "STORAGE_MIGRATION_PENDING",
                "{damage}"
            );
        }
        fixture.assert_source_preserved();
    }
}

#[test]
fn an_unknown_source_pending_basename_does_not_become_a_copy_exclusion() {
    let fixture = Fixture::new();
    fs::write(
        fixture.source.join(pending::LEAF),
        b"unknown persistent bytes",
    )
    .unwrap();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    assert_eq!(
        coordinator
            .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
            .unwrap_err()
            .to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    assert_eq!(
        fs::read(fixture.source.join(pending::LEAF)).unwrap(),
        b"unknown persistent bytes"
    );
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn node_and_rust_pending_admission_share_real_publication_and_nested_refusal() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    drop(coordinator);
    let peer = tempfile::tempdir().unwrap();
    node_pending_probe(
        peer.path(),
        fixture.destination(),
        "STORAGE_MIGRATION_PENDING",
    );
    let nested = fixture.destination().join("unopened/Profile");
    let attempt = super::super::StorageInstance::open(super::super::StorageResolveInput {
        home: Some(peer.path().to_owned()),
        env: BTreeMap::from([("KCODER_HOME".into(), nested.clone().into_os_string())]),
        ..Default::default()
    });
    assert_eq!(
        attempt.err().unwrap().to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    assert!(!fixture.destination().join("unopened").exists());
    node_pending_probe(peer.path(), &nested, "STORAGE_MIGRATION_PENDING");
    assert!(!fixture.destination().join("unopened").exists());
    let mut coordinator = fixture.coordinator_when_unowned();
    fixture.complete_before_pending_cleanup(&mut coordinator);
    drop(coordinator);
    node_pending_probe(peer.path(), fixture.destination(), "allowed");
    node_pending_probe(peer.path(), &nested, "allowed");
    let control = PrivateDirectory::open_existing(&fixture.home.join(".config")).unwrap();
    let mut changed = fixture.plan.target.clone();
    changed.revision += 1;
    control
        .atomic_replace(
            OsStr::new("kcoder-storage.json"),
            &serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
    node_pending_probe(
        peer.path(),
        fixture.destination(),
        "STORAGE_MIGRATION_PENDING",
    );
    control
        .atomic_replace(
            OsStr::new("kcoder-storage.json"),
            &serde_json::to_vec(&fixture.plan.target).unwrap(),
        )
        .unwrap();
    let operation = control
        .open_child(OsStr::new("kcoder-storage-migrations"), false)
        .unwrap()
        .open_child(OsStr::new(ID), false)
        .unwrap();
    operation
        .atomic_replace(OsStr::new("receipt.json"), b"unknown receipt")
        .unwrap();
    node_pending_probe(
        peer.path(),
        fixture.destination(),
        "STORAGE_MIGRATION_PENDING",
    );
    fixture.assert_source_preserved();
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
}

#[test]
fn a_first_cache_only_operation_keeps_its_in_place_root_closed_after_executor_exit() {
    let fixture = Fixture::in_place();
    assert!(!fixture.source.join(pending::LEAF).exists());
    let coordinator = fixture.stopped();
    assert_eq!(
        coordinator.current().unwrap().unwrap().phase,
        Phase::Copying
    );
    drop(coordinator);
    let peer = tempfile::tempdir().unwrap();
    let attempt = super::super::StorageInstance::open(super::super::StorageResolveInput {
        home: Some(peer.path().to_owned()),
        env: BTreeMap::from([
            (
                "KCODER_HOME".into(),
                fixture.source.clone().into_os_string(),
            ),
            (
                "KCODER_CACHE_DIR".into(),
                peer.path().join("cache").into_os_string(),
            ),
        ]),
        ..Default::default()
    });
    assert_eq!(
        attempt
            .err()
            .expect("first cache-only operation admitted its in-place root after executor exit")
            .to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    node_pending_probe(peer.path(), &fixture.source, "STORAGE_MIGRATION_PENDING");
    let mut coordinator = fixture.coordinator_when_unowned();
    fixture.complete(&mut coordinator);
    assert!(!fixture.source.join(pending::LEAF).exists());
    drop(coordinator);
    node_pending_probe(peer.path(), &fixture.source, "allowed");
    fixture.assert_source_preserved();
}

#[test]
fn a_later_cache_only_operation_uses_current_admission_without_growing_the_backlink() {
    let fixture = Fixture::new();
    let mut first = fixture.stopped();
    first
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    fixture.complete_before_pending_cleanup(&mut first);
    drop(first);
    let marker = fs::read(fixture.destination().join(pending::LEAF)).unwrap();
    let id = "cache-second";
    let mut plan = fixture.plan.clone();
    plan.operation_id = id.into();
    plan.original = Some(fixture.plan.target.clone());
    plan.from = super::super::resolve_storage_paths(&super::super::StorageResolveInput {
        home: Some(fixture.home.clone()),
        record: plan.original.clone(),
        ..Default::default()
    })
    .unwrap();
    plan.target.revision = 2;
    plan.target.operation_id = Some(id.into());
    plan.target.cache_root = fixture.root.path().join("second-cache");
    plan.components[0].source = fixture.destination().into();
    plan.components[0].source_identity = PrivateDirectory::open_existing(fixture.destination())
        .unwrap()
        .directory_identity()
        .unwrap();
    plan.target_bindings.clear();
    let mut coordinator = fixture.coordinator_when_unowned();
    coordinator.begin(plan).unwrap();
    coordinator
        .advance(id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator
        .advance(id, Phase::Stopped, Phase::Copying)
        .unwrap();
    assert_eq!(
        fs::read(fixture.destination().join(pending::LEAF)).unwrap(),
        marker
    );
    drop(coordinator);
    let peer = tempfile::tempdir().unwrap();
    let open = || {
        super::super::StorageInstance::open(super::super::StorageResolveInput {
            home: Some(peer.path().to_owned()),
            env: BTreeMap::from([
                (
                    "KCODER_HOME".into(),
                    fixture.destination().as_os_str().to_owned(),
                ),
                (
                    "KCODER_CACHE_DIR".into(),
                    peer.path().join("cache").into_os_string(),
                ),
            ]),
            ..Default::default()
        })
    };
    assert_eq!(
        open().err().unwrap().to_string(),
        "STORAGE_MIGRATION_PENDING"
    );
    node_pending_probe(
        peer.path(),
        fixture.destination(),
        "STORAGE_MIGRATION_PENDING",
    );
    let mut coordinator = fixture.coordinator_when_unowned();
    coordinator
        .advance(id, Phase::Copying, Phase::Verifying)
        .unwrap();
    coordinator
        .advance(id, Phase::Verifying, Phase::Prepared)
        .unwrap();
    coordinator.commit(id).unwrap();
    coordinator.complete(id).unwrap();
    drop(coordinator);
    assert!(open().is_ok());
    node_pending_probe(peer.path(), fixture.destination(), "allowed");
    assert!(!fixture.destination().join(pending::LEAF).exists());
    fs::remove_file(
        fixture
            .home
            .join(".config/kcoder-storage-migrations/current.json"),
    )
    .unwrap();
    assert!(open().is_ok());
    node_pending_probe(peer.path(), fixture.destination(), "allowed");
    fixture.assert_source_preserved();
}

#[test]
fn in_place_pending_cleanup_keeps_unknown_replacements_and_retries_only_the_original_id() {
    for replacement in [false, true] {
        let fixture = Fixture::in_place();
        let mut coordinator = fixture.stopped();
        let root = PrivateDirectory::open_existing(&fixture.source).unwrap();
        let held = root
            .open_single_link_regular_file(OsStr::new(pending::LEAF))
            .unwrap();
        let original_id = pending_control_identity(&held).unwrap();
        let bytes = fs::read(fixture.source.join(pending::LEAF)).unwrap();
        drop(coordinator);
        if replacement {
            root.atomic_replace(OsStr::new(pending::LEAF), &bytes)
                .unwrap();
        }
        coordinator = fixture.coordinator_when_unowned();
        coordinator.assert_offline_owner(ID).unwrap();
        if replacement {
            assert_eq!(
                coordinator
                    .defer_after_cleanup(ID, "OWNED_CANCELLED")
                    .unwrap_err()
                    .to_string(),
                "STORAGE_MIGRATION_PENDING"
            );
            assert_eq!(fs::read(fixture.source.join(pending::LEAF)).unwrap(), bytes);
            assert_eq!(
                coordinator.current().unwrap().unwrap().disposition,
                kcoder_types::StorageMigrationDisposition::Active
            );
        } else {
            coordinator
                .defer_after_cleanup(ID, "OWNED_CANCELLED")
                .unwrap();
            assert!(!fixture.source.join(pending::LEAF).exists());
            drop(coordinator);
            let peer = tempfile::tempdir().unwrap();
            node_pending_probe(peer.path(), &fixture.source, "allowed");
            coordinator = fixture.coordinator_when_unowned();
            coordinator.retry_deferred(ID).unwrap();
            coordinator
                .advance(ID, Phase::Planned, Phase::Stopping)
                .unwrap();
            coordinator
                .advance(ID, Phase::Stopping, Phase::Stopped)
                .unwrap();
            coordinator
                .advance(ID, Phase::Stopped, Phase::Copying)
                .unwrap();
            let current = root
                .open_single_link_regular_file(OsStr::new(pending::LEAF))
                .unwrap();
            assert_ne!(pending_control_identity(&current).unwrap(), original_id);
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(
                    &fs::read(fixture.source.join(pending::LEAF)).unwrap()
                )
                .unwrap()["operationId"],
                ID
            );
            drop(coordinator);
            node_pending_probe(peer.path(), &fixture.source, "STORAGE_MIGRATION_PENDING");
        }
        assert!(!super::super::storage_location_file(&fixture.home).exists());
        fixture.assert_source_preserved();
    }
}

#[test]
fn completed_pending_admission_never_reopens_an_unavailable_old_source_tree() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    fixture.complete(&mut coordinator);
    assert!(!fixture.destination().join(pending::LEAF).exists());
    drop(coordinator);
    let retained = fixture.root.path().join("retained-original-source");
    fs::rename(&fixture.source, &retained).unwrap();
    assert!(!fixture.source.exists());
    fs::rename(
        fixture.home.join(".config"),
        fixture.home.join("retained-original-control"),
    )
    .unwrap();
    let peer = tempfile::tempdir().unwrap();
    let instance = super::super::StorageInstance::open(super::super::StorageResolveInput {
        home: Some(peer.path().to_owned()),
        env: BTreeMap::from([
            (
                "KCODER_HOME".into(),
                fixture.destination().as_os_str().to_owned(),
            ),
            (
                "KCODER_CACHE_DIR".into(),
                peer.path().join("cache").into_os_string(),
            ),
        ]),
        ..Default::default()
    })
    .unwrap();
    drop(instance);
    node_pending_probe(peer.path(), fixture.destination(), "allowed");
    assert_eq!(fs::read(retained.join("settings.json")).unwrap(), BODY);
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
}

#[test]
fn complete_pending_cleanup_uses_original_file_identity_without_reopening_old_sources() {
    for replaced in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.stopped();
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap();
        fixture.complete_before_pending_cleanup(&mut coordinator);
        let receipt = coordinator.current().unwrap().unwrap();
        let archive = fixture
            .home
            .join(".config/kcoder-storage-migrations")
            .join(ID)
            .join("receipt.json");
        let archive_bytes = fs::read(&archive).unwrap();
        let root = PrivateDirectory::open_existing(fixture.destination()).unwrap();
        let original = root
            .open_single_link_regular_file(OsStr::new(pending::LEAF))
            .unwrap();
        let marker_bytes = fs::read(fixture.destination().join(pending::LEAF)).unwrap();
        drop(coordinator);
        let retained = fixture.root.path().join("retained-original-source");
        fs::rename(&fixture.source, &retained).unwrap();
        if replaced {
            root.atomic_replace(OsStr::new(pending::LEAF), &marker_bytes)
                .unwrap();
        }
        let mut recovered = fixture.coordinator_when_unowned();
        if replaced {
            assert_eq!(
                recovered.complete(ID).unwrap_err().to_string(),
                "STORAGE_MIGRATION_PENDING"
            );
            assert_eq!(
                fs::read(fixture.destination().join(pending::LEAF)).unwrap(),
                marker_bytes
            );
        } else {
            assert_eq!(recovered.complete(ID).unwrap(), receipt);
            assert_eq!(recovered.complete(ID).unwrap(), receipt);
            assert!(!fixture.destination().join(pending::LEAF).exists());
        }
        assert_eq!(fs::read(&archive).unwrap(), archive_bytes);
        assert_eq!(
            fs::read(fixture.destination().join("settings.json")).unwrap(),
            BODY
        );
        assert!(!fixture.source.exists());
        assert_eq!(fs::read(retained.join("settings.json")).unwrap(), BODY);
        assert!(original.metadata().unwrap().is_file());
    }
}

#[test]
fn a_second_publication_excludes_only_the_declared_sources_old_pending_backlink() {
    let fixture = Fixture::new();
    let mut first = fixture.stopped();
    first
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    fixture.complete_before_pending_cleanup(&mut first);
    drop(first);
    let old_marker = fs::read(fixture.destination().join(pending::LEAF)).unwrap();
    let second_id = "publication-second";
    let destination = fixture.parent.join("second");
    let source_id = PrivateDirectory::open_existing(fixture.destination())
        .unwrap()
        .directory_identity()
        .unwrap();
    let mut plan = fixture.plan.clone();
    plan.operation_id = second_id.into();
    plan.original = Some(fixture.plan.target.clone());
    plan.from = super::super::resolve_storage_paths(&super::super::StorageResolveInput {
        home: Some(fixture.home.clone()),
        record: plan.original.clone(),
        ..Default::default()
    })
    .unwrap();
    plan.target.data_root = destination.clone();
    plan.target.revision = 2;
    plan.target.operation_id = Some(second_id.into());
    plan.components[0].source = fixture.destination().into();
    plan.components[0].source_identity = source_id;
    plan.components[0].destination = destination.clone();
    plan.target_bindings[0].path = destination.clone();
    let mut coordinator = fixture.coordinator_when_unowned();
    coordinator.begin(plan).unwrap();
    coordinator
        .advance(second_id, Phase::Planned, Phase::Stopping)
        .unwrap();
    coordinator
        .advance(second_id, Phase::Stopping, Phase::Stopped)
        .unwrap();
    coordinator
        .advance(second_id, Phase::Stopped, Phase::Copying)
        .unwrap();
    coordinator.prepare_source_retirements(second_id).unwrap();
    coordinator
        .publish_component(second_id, DOMAIN, &BTreeSet::new())
        .unwrap();
    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(destination.join(pending::LEAF)).unwrap()).unwrap();
    assert_eq!(marker["operationId"], second_id);
    assert_eq!(marker.as_object().unwrap().len(), 6);
    assert_eq!(
        fs::read(fixture.destination().join(pending::LEAF)).unwrap(),
        old_marker
    );
    coordinator
        .advance(second_id, Phase::Copying, Phase::Verifying)
        .unwrap();
    coordinator
        .advance(second_id, Phase::Verifying, Phase::Prepared)
        .unwrap();
    coordinator.commit(second_id).unwrap();
    coordinator.complete(second_id).unwrap();
    assert!(!destination.join(pending::LEAF).exists());
    drop(coordinator);
    let peer = tempfile::tempdir().unwrap();
    for (root, expected) in [
        (fixture.destination(), Some("STORAGE_SOURCE_RETIRED")),
        (destination.as_path(), None),
    ] {
        let attempt = super::super::StorageInstance::open(super::super::StorageResolveInput {
            home: Some(peer.path().to_owned()),
            env: BTreeMap::from([
                ("KCODER_HOME".into(), root.as_os_str().to_owned()),
                (
                    "KCODER_CACHE_DIR".into(),
                    peer.path().join("cache").into_os_string(),
                ),
            ]),
            ..Default::default()
        });
        if let Some(code) = expected {
            assert_eq!(attempt.err().unwrap().to_string(), code);
        } else {
            assert!(attempt.is_ok());
        }
    }
    assert_eq!(fs::read(destination.join("settings.json")).unwrap(), BODY);
}

#[test]
fn publication_can_prepare_and_copy_a_declared_component_directly() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();

    assert!(matches!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
        StorageComponentDirectory::Published(_)
    ));

    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    assert!(!fixture.stage_path().exists());
    fixture.assert_source_preserved();
}

#[test]
fn opening_unpublished_components_never_creates_staging_or_owner_receipts() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let original = coordinator.current().unwrap().unwrap().owner_receipts;
    assert_eq!(
        coordinator
            .open_published_component(ID, DOMAIN)
            .unwrap_err()
            .to_string(),
        "STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"
    );
    assert!(!fixture.stage_path().exists());
    assert!(!fixture.destination().exists());
    assert_eq!(
        coordinator.current().unwrap().unwrap().owner_receipts,
        original
    );

    let staging = prepared(&mut coordinator);
    let original = coordinator.current().unwrap().unwrap().owner_receipts;
    assert_eq!(
        coordinator
            .open_published_component(ID, DOMAIN)
            .unwrap_err()
            .to_string(),
        "STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"
    );
    assert_eq!(
        coordinator.current().unwrap().unwrap().owner_receipts,
        original
    );
    assert_eq!(
        PrivateDirectory::open_existing(&fixture.stage_path())
            .unwrap()
            .directory_identity()
            .unwrap(),
        staging.directory_identity().unwrap()
    );
    let name = OsStr::new(super::super::writers::WRITERS);
    assert_eq!(
        staging
            .entry_names_bounded(2)
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([name.to_owned(), OsString::from(pending::LEAF)])
    );
    let fence = staging.open_entry_handle(name).unwrap();
    assert!(fence.metadata().is_file());
    assert_eq!(fence.metadata().len(), 0);
    assert!(
        coordinator
            .held_writer_fence_identities(ID)
            .unwrap()
            .contains(&fence.identity().unwrap())
    );
    assert!(
        pending::target_control(&mut coordinator, ID, &staging)
            .unwrap()
            .is_some()
    );
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn opening_published_components_preserves_adapter_content_and_refuses_a_same_bytes_replacement() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    fs::write(
        fixture.destination().join("settings.json"),
        b"owner-adapted final bytes",
    )
    .unwrap();
    fs::write(
        fixture.destination().join("owner-record.json"),
        b"owner metadata",
    )
    .unwrap();
    let original = coordinator.current().unwrap().unwrap().owner_receipts;

    let held = coordinator.open_published_component(ID, DOMAIN).unwrap();

    assert_eq!(
        held.directory_identity().unwrap(),
        fixture.intent(&coordinator).staging_identity
    );
    assert_eq!(
        coordinator.current().unwrap().unwrap().owner_receipts,
        original
    );
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        b"owner-adapted final bytes"
    );
    assert_eq!(
        fs::read(fixture.destination().join("owner-record.json")).unwrap(),
        b"owner metadata"
    );
    drop(coordinator);
    fs::rename(
        fixture.destination(),
        fixture.root.path().join("original-published-root"),
    )
    .unwrap();
    fs::create_dir(fixture.destination()).unwrap();
    fs::write(
        fixture.destination().join("settings.json"),
        b"owner-adapted final bytes",
    )
    .unwrap();
    fs::write(
        fixture.destination().join("owner-record.json"),
        b"owner metadata",
    )
    .unwrap();

    let mut reopened = fixture.coordinator_when_unowned();
    assert!(
        reopened
            .open_published_component(ID, DOMAIN)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_COMPONENT_TARGET_UNKNOWN")
    );
    assert_eq!(
        reopened.current().unwrap().unwrap().owner_receipts,
        original
    );
    assert_eq!(
        fs::read(fixture.destination().join("owner-record.json")).unwrap(),
        b"owner metadata"
    );
    assert_eq!(
        held.directory_identity().unwrap(),
        fixture.intent(&reopened).staging_identity
    );
    fixture.assert_source_preserved();
}

#[test]
fn lost_rename_receipt_recovers_by_original_identity_without_replaying_raw_copy() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let result = publish_with_hook(
        &mut coordinator,
        ID,
        DOMAIN,
        &BTreeSet::new(),
        |_| Ok(()),
        |phase| {
            if phase == PublicationCheckpoint::RenamedBeforeReturn {
                anyhow::bail!("injected lost rename reply");
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    let identity = fixture.intent(&coordinator).staging_identity;
    assert!(!fixture.stage_path().exists());
    let before = coordinator.current().unwrap().unwrap().owner_receipts;
    // A legitimate domain conversion at the final path may change records and
    // add owner metadata. Recovery must not compare them with the raw source.
    fs::write(
        fixture.destination().join("settings.json"),
        b"owner-adapted final bytes",
    )
    .unwrap();
    fs::write(
        fixture.destination().join("owner-record.json"),
        b"owner conversion receipt",
    )
    .unwrap();
    drop(coordinator);

    let mut recovered = fixture.coordinator_when_unowned();
    for directory in [
        recovered.prepare_component_staging(ID, DOMAIN).unwrap(),
        recovered
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
    ] {
        let StorageComponentDirectory::Published(directory) = directory else {
            panic!("not recovered as published")
        };
        assert_eq!(directory.directory_identity().unwrap(), identity);
    }
    assert_eq!(recovered.current().unwrap().unwrap().owner_receipts, before);
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        b"owner-adapted final bytes"
    );
    assert_eq!(
        fs::read(fixture.destination().join("owner-record.json")).unwrap(),
        b"owner conversion receipt"
    );
    fixture.assert_source_preserved();
}

#[test]
fn published_fact_binds_original_copy_provenance_and_rechecks_its_named_identity() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let fact = coordinator.open_published_component(ID, DOMAIN).unwrap();

    assert_eq!(fact.source_path(), fixture.source);
    assert_eq!(fact.destination_path(), fixture.destination());
    assert_eq!(
        fact.source_identity(),
        fixture.plan.components[0].source_identity
    );
    assert_eq!(fact.operation_id(), ID);
    assert_eq!(fact.domain(), DOMAIN);
    assert_eq!(
        fact.directory().directory_identity().unwrap(),
        fixture.intent(&coordinator).staging_identity
    );
    fact.verify().unwrap();
    fs::rename(
        fixture.destination(),
        fixture.root.path().join("original-published-fact-root"),
    )
    .unwrap();
    fs::create_dir(fixture.destination()).unwrap();
    fs::write(fixture.destination().join("settings.json"), BODY).unwrap();

    assert!(
        fact.verify()
            .unwrap_err()
            .to_string()
            .contains("STORAGE_COMPONENT_BINDING_CHANGED")
    );
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    fixture.assert_source_preserved();
}

#[test]
fn metadata_observer_checks_publication_without_waiting_for_the_executor_or_writing() {
    for container in [false, true] {
        let mut fixture = Fixture::new();
        if container {
            fixture.select_existing_empty_root();
        }
        let mut coordinator = fixture.stopped();
        assert!(observe_published_storage_component(&fixture.home, ID, DOMAIN).is_err());
        coordinator.prepare_component_staging(ID, DOMAIN).unwrap();
        assert!(observe_published_storage_component(&fixture.home, ID, DOMAIN).is_err());
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap();
        coordinator
            .advance(ID, Phase::Copying, Phase::Verifying)
            .unwrap();
        coordinator
            .advance(ID, Phase::Verifying, Phase::Prepared)
            .unwrap();
        coordinator.commit(ID).unwrap();
        let receipt = fs::read(
            fixture
                .home
                .join(".config/kcoder-storage-migrations")
                .join(ID)
                .join("receipt.json"),
        )
        .unwrap();
        // The original executor still holds its exclusive control and root
        // leases. A dedicated metadata verifier must neither wait on them nor
        // rehash legitimate domain conversions as raw-copy payloads.
        fs::write(
            fixture.destination().join("settings.json"),
            b"domain-adapted bytes",
        )
        .unwrap();
        let fact = observe_published_storage_component(&fixture.home, ID, DOMAIN).unwrap();
        fact.verify().unwrap();
        assert_eq!(
            fact.source_identity(),
            fixture.plan.components[0].source_identity
        );
        assert_eq!(
            fs::read(
                fixture
                    .home
                    .join(".config/kcoder-storage-migrations")
                    .join(ID)
                    .join("receipt.json")
            )
            .unwrap(),
            receipt
        );
        assert_eq!(
            fs::read(fixture.destination().join("settings.json")).unwrap(),
            b"domain-adapted bytes"
        );
        assert!(
            observe_published_storage_component(&fixture.home, "other-operation", DOMAIN).is_err()
        );
        fixture.assert_source_preserved();
    }
}

#[test]
fn metadata_observer_never_creates_missing_controls_or_adopts_a_replaced_final_root() {
    let missing = tempfile::tempdir().unwrap();
    assert!(observe_published_storage_component(missing.path(), ID, DOMAIN).is_err());
    assert!(fs::read_dir(missing.path()).unwrap().next().is_none());
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let before = observe_published_storage_component(&fixture.home, ID, DOMAIN).unwrap();
    fs::rename(
        fixture.destination(),
        fixture.parent.join("retained-original"),
    )
    .unwrap();
    fs::create_dir(fixture.destination()).unwrap();
    fs::write(
        fixture.destination().join("unknown.txt"),
        b"preserve unknown data",
    )
    .unwrap();
    assert!(before.verify().is_err());
    assert!(observe_published_storage_component(&fixture.home, ID, DOMAIN).is_err());
    assert_eq!(
        fs::read(fixture.destination().join("unknown.txt")).unwrap(),
        b"preserve unknown data"
    );
}

#[test]
fn an_unknown_operation_shaped_staging_directory_is_preserved() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    fs::create_dir(fixture.stage_path()).unwrap();
    fs::write(fixture.stage_path().join("keep"), b"unknown stage bytes").unwrap();
    let original = PrivateDirectory::open_existing(&fixture.stage_path())
        .unwrap()
        .directory_identity()
        .unwrap();

    let error = coordinator
        .prepare_component_staging(ID, DOMAIN)
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("STORAGE_COMPONENT_TARGET_UNKNOWN")
    );
    assert_eq!(
        PrivateDirectory::open_existing(&fixture.stage_path())
            .unwrap()
            .directory_identity()
            .unwrap(),
        original
    );
    assert_eq!(
        fs::read(fixture.stage_path().join("keep")).unwrap(),
        b"unknown stage bytes"
    );
    assert!(
        !coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .contains_key(&owner_key(DOMAIN).unwrap())
    );
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn a_directory_created_before_its_owner_receipt_remains_unknown_on_resume() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    assert!(
        prepare_with_hook(&mut coordinator, ID, DOMAIN, &mut |phase| {
            if phase == PublicationCheckpoint::CreatedBeforeReceipt {
                anyhow::bail!("exit before owner receipt");
            }
            Ok(())
        })
        .is_err()
    );
    let original = PrivateDirectory::open_existing(&fixture.stage_path())
        .unwrap()
        .directory_identity()
        .unwrap();

    assert!(
        coordinator
            .prepare_component_staging(ID, DOMAIN)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_COMPONENT_TARGET_UNKNOWN")
    );

    assert_eq!(
        PrivateDirectory::open_existing(&fixture.stage_path())
            .unwrap()
            .directory_identity()
            .unwrap(),
        original
    );
    assert!(
        !coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .contains_key(&owner_key(DOMAIN).unwrap())
    );
    fixture.assert_source_preserved();
}

#[test]
fn unknown_final_directories_are_never_adopted_even_if_empty_or_byte_identical() {
    for matching_bytes in [false, true] {
        let fixture = Fixture::new();
        let mut coordinator = fixture.stopped();
        fs::create_dir(fixture.destination()).unwrap();
        if matching_bytes {
            fs::write(fixture.destination().join("settings.json"), BODY).unwrap();
        }
        let identity = PrivateDirectory::open_existing(fixture.destination())
            .unwrap()
            .directory_identity()
            .unwrap();

        assert!(
            coordinator
                .publish_component(ID, DOMAIN, &BTreeSet::new())
                .is_err()
        );

        assert_eq!(
            PrivateDirectory::open_existing(fixture.destination())
                .unwrap()
                .directory_identity()
                .unwrap(),
            identity
        );
        if matching_bytes {
            assert_eq!(
                fs::read(fixture.destination().join("settings.json")).unwrap(),
                BODY
            );
        }
        assert!(!fixture.stage_path().exists());
        assert!(
            !coordinator
                .current()
                .unwrap()
                .unwrap()
                .owner_receipts
                .contains_key(&owner_key(DOMAIN).unwrap())
        );
        fixture.assert_source_preserved();
    }
}

#[test]
fn no_replace_rename_preserves_a_racing_final_directory_and_the_original_stage() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let result = publish_with_hook(
        &mut coordinator,
        ID,
        DOMAIN,
        &BTreeSet::new(),
        |_| Ok(()),
        |phase| {
            if phase == PublicationCheckpoint::BeforeRename {
                fs::create_dir(fixture.destination())?;
                fs::write(fixture.destination().join("keep"), b"unknown final bytes")?;
            }
            Ok(())
        },
    );

    assert!(result.is_err());
    assert_eq!(
        fs::read(fixture.destination().join("keep")).unwrap(),
        b"unknown final bytes"
    );
    assert_eq!(
        fs::read(fixture.stage_path().join("settings.json")).unwrap(),
        BODY
    );
    assert!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .is_err()
    );
    fixture.assert_source_preserved();
}

#[test]
fn same_bytes_at_a_replaced_staging_root_do_not_inherit_ownership() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let original = prepared(&mut coordinator);
    coordinator
        .copy_component(ID, DOMAIN, &original, &BTreeSet::new())
        .unwrap();
    let intent = fixture.intent(&coordinator);
    let receipt = coordinator.current().unwrap().unwrap();
    fs::rename(
        fixture.stage_path(),
        fixture.root.path().join("detached-original-stage"),
    )
    .unwrap();
    fs::create_dir(fixture.stage_path()).unwrap();
    fs::write(fixture.stage_path().join("settings.json"), BODY).unwrap();

    assert_eq!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap_err()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );

    assert_eq!(
        fs::read(fixture.stage_path().join("settings.json")).unwrap(),
        BODY
    );
    assert!(!fixture.destination().exists());
    assert_eq!(
        original.directory_identity().unwrap(),
        intent.staging_identity
    );
    drop(coordinator);
    let mut recovered = fixture.coordinator_when_unowned();
    assert_eq!(
        recovered
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap_err()
            .to_string(),
        "STORAGE_COMPONENT_TARGET_UNKNOWN"
    );
    assert_eq!(recovered.current().unwrap().unwrap(), receipt);
    assert_eq!(
        PrivateDirectory::open_existing(&fixture.stage_path())
            .unwrap()
            .entry_names_bounded(1)
            .unwrap(),
        [OsString::from("settings.json")]
    );
    assert_eq!(
        fs::read(fixture.stage_path().join("settings.json")).unwrap(),
        BODY
    );
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn a_staging_substitution_immediately_before_rename_is_not_moved_or_adopted() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let result = publish_with_hook(
        &mut coordinator,
        ID,
        DOMAIN,
        &BTreeSet::new(),
        |_| Ok(()),
        |phase| {
            if phase == PublicationCheckpoint::BeforeRename {
                fs::rename(
                    fixture.stage_path(),
                    fixture.root.path().join("original-stage-before-rename"),
                )?;
                fs::create_dir(fixture.stage_path())?;
                fs::write(fixture.stage_path().join("keep"), b"unknown racing stage")?;
            }
            Ok(())
        },
    );

    assert!(result.is_err());
    assert!(!fixture.destination().exists());
    assert_eq!(
        fs::read(fixture.stage_path().join("keep")).unwrap(),
        b"unknown racing stage"
    );
    assert_eq!(
        fs::read(
            fixture
                .root
                .path()
                .join("original-stage-before-rename/settings.json")
        )
        .unwrap(),
        BODY
    );
    fixture.assert_source_preserved();
}

#[test]
fn modified_raw_staging_is_not_published_or_repaired_over_unknown_contents() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    fs::write(
        fixture.stage_path().join("settings.json"),
        b"unexpected changed raw bytes",
    )
    .unwrap();

    assert!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .is_err()
    );

    assert!(!fixture.destination().exists());
    assert_eq!(
        fs::read(fixture.stage_path().join("settings.json")).unwrap(),
        b"unexpected changed raw bytes"
    );
    fixture.assert_source_preserved();
}

#[test]
fn a_missing_recorded_stage_is_not_silently_recreated() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(
        fixture.intent(&coordinator).staging_identity,
        staging.directory_identity().unwrap()
    );
    assert_eq!(
        staging
            .entry_names_bounded(2)
            .unwrap()
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            OsString::from(super::super::writers::WRITERS),
            OsString::from(pending::LEAF)
        ])
    );
    drop(coordinator);
    drop(staging);
    fs::remove_file(fixture.stage_path().join(super::super::writers::WRITERS)).unwrap();
    fs::remove_file(fixture.stage_path().join(pending::LEAF)).unwrap();
    fs::remove_dir(fixture.stage_path()).unwrap();

    let mut recovered = fixture.coordinator_when_unowned();
    assert_eq!(
        recovered
            .prepare_component_staging(ID, DOMAIN)
            .unwrap_err()
            .to_string(),
        "STORAGE_COMPONENT_TARGET_UNKNOWN"
    );

    assert!(!fixture.stage_path().exists());
    assert!(!fixture.destination().exists());
    assert_eq!(recovered.current().unwrap().unwrap(), receipt);
    fixture.assert_source_preserved();
}

#[test]
fn replacing_the_target_parent_cannot_redirect_an_original_publication() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let original = prepared(&mut coordinator);
    let intent = fixture.intent(&coordinator);
    let receipt = coordinator.current().unwrap().unwrap();
    fs::rename(
        &fixture.parent,
        fixture.root.path().join("old-target-parent"),
    )
    .unwrap();
    fs::create_dir(&fixture.parent).unwrap();

    assert_eq!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap_err()
            .to_string(),
        "STORAGE_ROOT_CHANGED"
    );
    assert_eq!(
        coordinator.current().unwrap_err().to_string(),
        "STORAGE_ROOT_CHANGED"
    );
    assert_eq!(
        super::super::read_storage_operation(&fixture.home, ID)
            .unwrap()
            .unwrap(),
        receipt
    );

    assert!(!fixture.stage_path().exists());
    assert!(!fixture.destination().exists());
    assert_eq!(
        original.directory_identity().unwrap(),
        intent.staging_identity
    );
    assert!(fs::read_dir(&fixture.parent).unwrap().next().is_none());
    fixture.assert_source_preserved();
}

#[test]
fn copying_the_operation_json_into_a_different_native_directory_does_not_authorize_it() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    prepared(&mut coordinator);
    let operation = fixture
        .home
        .join(".config/kcoder-storage-migrations")
        .join(ID);
    let receipt = fs::read(operation.join("receipt.json")).unwrap();
    fs::rename(&operation, fixture.root.path().join("detached-operation")).unwrap();
    fs::create_dir(&operation).unwrap();
    fs::write(operation.join("receipt.json"), receipt).unwrap();

    assert!(
        coordinator
            .prepare_component_staging(ID, DOMAIN)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_COMPONENT_RECEIPT_CONFLICT")
    );

    assert!(fixture.stage_path().is_dir());
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn in_place_components_skip_staging_and_publication_receipts() {
    let mut fixture = Fixture::new();
    fixture.set_destination(fixture.source.clone());
    fixture.plan.target_bindings.clear();
    let mut coordinator = fixture.stopped();

    for directory in [
        coordinator.prepare_component_staging(ID, DOMAIN).unwrap(),
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
    ] {
        let StorageComponentDirectory::InPlace(directory) = directory else {
            panic!("in-place component was moved")
        };
        assert_eq!(
            directory.directory_identity().unwrap(),
            fixture.plan.components[0].source_identity
        );
    }

    assert!(
        coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .is_empty()
    );
    fixture.assert_source_preserved();
}

#[test]
fn selected_empty_root_keeps_its_identity_and_real_fences_while_publishing_flat_entries() {
    let mut fixture = Fixture::new();
    let identity = fixture.select_existing_empty_root();
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    let before = fixture.intent(&coordinator);
    assert_eq!(before.version, 2);
    assert_eq!(staging.directory_identity().unwrap(), identity);
    assert!(before.staging_name.is_empty());
    assert!(before.container.as_ref().unwrap().published_copy.is_none());
    assert!(!fixture.stage_path().exists());
    assert_eq!(
        coordinator
            .open_published_component(ID, DOMAIN)
            .unwrap_err()
            .to_string(),
        "STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"
    );

    coordinator
        .copy_component(ID, DOMAIN, &staging, &BTreeSet::new())
        .unwrap();
    assert_eq!(
        coordinator
            .open_published_component(ID, DOMAIN)
            .unwrap_err()
            .to_string(),
        "STORAGE_COMPONENT_PUBLICATION_UNCONFIRMED"
    );
    assert!(matches!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
        StorageComponentDirectory::Published(_)
    ));

    let fact = coordinator.open_published_component(ID, DOMAIN).unwrap();
    assert_eq!(fact.directory_identity().unwrap(), identity);
    assert_eq!(fact.source_path(), fixture.source);
    assert_eq!(fact.operation_id(), ID);
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    assert!(fixture.destination().join("empty").is_dir());
    assert!(!fixture.destination().join("native").exists());
    assert_eq!(
        fixture
            .intent(&coordinator)
            .container
            .as_ref()
            .unwrap()
            .fences,
        before.container.as_ref().unwrap().fences
    );
    for fence in &before.container.as_ref().unwrap().fences {
        assert_ne!(fence.name, pending::LEAF);
        assert_eq!(
            fact.open_entry_handle(OsStr::new(&fence.name))
                .unwrap()
                .identity()
                .unwrap(),
            fence.identity
        );
    }
    let published = fixture.intent(&coordinator);
    let pending_fact = coordinator.current().unwrap().unwrap().owner_receipts
        [&format!("pending-{DOMAIN}")]
        .clone();
    fixture.complete(&mut coordinator);
    assert!(!fixture.destination().join(pending::LEAF).exists());
    assert_eq!(fixture.intent(&coordinator), published);
    assert_eq!(
        coordinator.current().unwrap().unwrap().owner_receipts[&format!("pending-{DOMAIN}")],
        pending_fact
    );
    for fence in &before.container.as_ref().unwrap().fences {
        assert_eq!(
            fact.open_entry_handle(OsStr::new(&fence.name))
                .unwrap()
                .identity()
                .unwrap(),
            fence.identity
        );
    }
    fixture.assert_source_preserved();
}

#[test]
fn selected_roots_with_unknown_files_or_empty_subdirectories_are_never_claimed() {
    for directory in [false, true] {
        let mut fixture = Fixture::new();
        let identity = fixture.select_existing_empty_root();
        let mut coordinator = fixture.stopped();
        let unknown = fixture.destination().join("unknown-entry");
        if directory {
            fs::create_dir(&unknown).unwrap();
        } else {
            fs::write(&unknown, b"unknown bytes").unwrap();
        }

        assert!(
            coordinator
                .prepare_component_staging(ID, DOMAIN)
                .unwrap_err()
                .to_string()
                .contains("STORAGE_COMPONENT_TARGET_UNKNOWN")
        );

        assert_eq!(
            PrivateDirectory::open_existing(fixture.destination())
                .unwrap()
                .directory_identity()
                .unwrap(),
            identity
        );
        assert!(unknown.exists());
        if !directory {
            assert_eq!(fs::read(&unknown).unwrap(), b"unknown bytes");
        }
        assert!(
            !coordinator
                .current()
                .unwrap()
                .unwrap()
                .owner_receipts
                .contains_key(&owner_key(DOMAIN).unwrap())
        );
        fixture.assert_source_preserved();
    }
}

#[test]
fn interrupted_container_copy_is_resumed_under_the_same_root_before_publication_confirmation() {
    let mut fixture = Fixture::new();
    let identity = fixture.select_existing_empty_root();
    let mut coordinator = fixture.stopped();
    assert!(
        publish_with_hook(
            &mut coordinator,
            ID,
            DOMAIN,
            &BTreeSet::new(),
            |_| Ok(()),
            |phase| {
                if phase == PublicationCheckpoint::ContainerCopiedBeforePublication {
                    anyhow::bail!("exit before container publication checkpoint");
                }
                Ok(())
            }
        )
        .is_err()
    );
    assert!(
        fixture
            .intent(&coordinator)
            .container
            .unwrap()
            .published_copy
            .is_none()
    );
    assert!(coordinator.open_published_component(ID, DOMAIN).is_err());
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    drop(coordinator);

    let mut recovered = fixture.coordinator_when_unowned();
    assert!(matches!(
        recovered.prepare_component_staging(ID, DOMAIN).unwrap(),
        StorageComponentDirectory::Staging(_)
    ));
    recovered
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();
    let fact = recovered.open_published_component(ID, DOMAIN).unwrap();
    assert_eq!(fact.directory_identity().unwrap(), identity);
    assert_eq!(
        fact.source_identity(),
        fixture.plan.components[0].source_identity
    );
    fixture.assert_source_preserved();
}

#[test]
fn lost_container_publication_reply_recovers_without_recopying_domain_adaptations() {
    let mut fixture = Fixture::new();
    let identity = fixture.select_existing_empty_root();
    let mut coordinator = fixture.stopped();
    assert!(
        publish_with_hook(
            &mut coordinator,
            ID,
            DOMAIN,
            &BTreeSet::new(),
            |_| Ok(()),
            |phase| {
                if phase == PublicationCheckpoint::ContainerPublishedBeforeReturn {
                    anyhow::bail!("container publication reply lost");
                }
                Ok(())
            }
        )
        .is_err()
    );
    let original = coordinator.current().unwrap().unwrap().owner_receipts;
    fs::write(
        fixture.destination().join("settings.json"),
        b"adapted container payload",
    )
    .unwrap();
    fs::write(fixture.destination().join("owner.json"), b"owner metadata").unwrap();
    drop(coordinator);

    let mut recovered = fixture.coordinator_when_unowned();
    assert!(matches!(
        recovered
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap(),
        StorageComponentDirectory::Published(_)
    ));
    let fact = recovered.open_published_component(ID, DOMAIN).unwrap();
    assert_eq!(fact.directory_identity().unwrap(), identity);
    assert_eq!(
        recovered.current().unwrap().unwrap().owner_receipts,
        original
    );
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        b"adapted container payload"
    );
    assert_eq!(
        fs::read(fixture.destination().join("owner.json")).unwrap(),
        b"owner metadata"
    );
    fixture.assert_source_preserved();
}

#[test]
fn selected_container_directory_replacement_is_rejected_without_adopting_equal_bytes() {
    let mut fixture = Fixture::new();
    let identity = fixture.select_existing_empty_root();
    let mut coordinator = fixture.stopped();
    let original = prepared(&mut coordinator);
    drop(coordinator);
    fs::rename(
        fixture.destination(),
        fixture.root.path().join("original-selected-root"),
    )
    .unwrap();
    fs::create_dir(fixture.destination()).unwrap();
    fs::write(fixture.destination().join("settings.json"), BODY).unwrap();

    let mut recovered = fixture.coordinator_when_unowned();
    assert!(
        recovered
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .is_err()
    );
    assert!(recovered.open_published_component(ID, DOMAIN).is_err());
    assert_eq!(original.directory_identity().unwrap(), identity);
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    fixture.assert_source_preserved();
}

#[test]
fn selected_container_fences_cannot_be_replaced_or_inferred_from_their_names() {
    let mut fixture = Fixture::new();
    fixture.select_existing_empty_root();
    let mut coordinator = fixture.stopped();
    prepared(&mut coordinator);
    let fence = fixture.intent(&coordinator).container.unwrap().fences[0].clone();
    let parent = PrivateDirectory::open_existing(fixture.destination()).unwrap();
    let original = parent
        .open_single_link_regular_file(OsStr::new(&fence.name))
        .unwrap();
    drop(coordinator);
    parent.remove_regular_file(OsStr::new(&fence.name)).unwrap();
    parent
        .open_read_write_file(OsStr::new(&fence.name), true)
        .unwrap();

    let mut recovered = fixture.coordinator_when_unowned();
    assert!(
        recovered
            .prepare_component_staging(ID, DOMAIN)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_COMPONENT_FENCE_CHANGED")
    );
    assert!(original.metadata().unwrap().is_file());
    assert!(!fixture.destination().join("settings.json").exists());
    fixture.assert_source_preserved();
}

#[test]
fn ordinary_missing_target_parents_are_not_created_implicitly() {
    let mut fixture = Fixture::new();
    fixture.set_destination(fixture.parent.join("missing/component"));
    let mut coordinator = fixture.stopped();

    let error = coordinator
        .prepare_component_staging(ID, DOMAIN)
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("STORAGE_TARGET_PARENT_UNAVAILABLE")
    );
    assert!(!fixture.parent.join("missing").exists());
    assert!(
        coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .is_empty()
    );
    fixture.assert_source_preserved();
}

#[test]
fn a_destination_inside_source_is_rejected_before_creating_staging() {
    let mut fixture = Fixture::new();
    fixture.set_destination(fixture.source.join("nested-destination"));
    fixture.plan.target_bindings.clear();
    let mut coordinator = fixture.stopped();

    assert!(
        coordinator
            .prepare_component_staging(ID, DOMAIN)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_COMPONENT_ROOTS_OVERLAP")
    );

    assert!(!fixture.stage_path().exists());
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn staging_and_publication_only_accept_stopped_or_copying_phases() {
    let fixture = Fixture::new();
    let mut coordinator = fixture.coordinator_when_unowned();
    coordinator.begin(fixture.plan.clone()).unwrap();
    for phase in [Phase::Planned, Phase::Stopping] {
        if phase == Phase::Stopping {
            coordinator
                .advance(ID, Phase::Planned, Phase::Stopping)
                .unwrap();
        }
        assert_eq!(
            coordinator
                .prepare_component_staging(ID, DOMAIN)
                .unwrap_err()
                .to_string(),
            "STORAGE_PHASE_INVALID"
        );
        assert!(!fixture.stage_path().exists());
    }
    coordinator
        .advance(ID, Phase::Stopping, Phase::Stopped)
        .unwrap();
    prepared(&mut coordinator);
    coordinator
        .advance(ID, Phase::Stopped, Phase::Copying)
        .unwrap();
    coordinator
        .advance(ID, Phase::Copying, Phase::Verifying)
        .unwrap();
    assert_eq!(
        coordinator
            .publish_component(ID, DOMAIN, &BTreeSet::new())
            .unwrap_err()
            .to_string(),
        "STORAGE_PHASE_INVALID"
    );
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}

#[test]
fn a_destination_matching_the_default_staging_name_still_publishes_atomically() {
    let mut fixture = Fixture::new();
    fixture.set_destination(
        fixture
            .parent
            .join(format!(".KCODER-STORAGE-{ID}-{DOMAIN}").to_ascii_uppercase()),
    );
    let mut coordinator = fixture.stopped();
    let staging = prepared(&mut coordinator);
    assert!(!fixture.destination().exists());
    assert!(
        !OsStr::new(&fixture.intent(&coordinator).staging_name)
            .eq_ignore_ascii_case(fixture.destination().file_name().unwrap())
    );

    let published = coordinator
        .publish_component(ID, DOMAIN, &BTreeSet::new())
        .unwrap();

    let StorageComponentDirectory::Published(directory) = published else {
        panic!("not published")
    };
    assert_eq!(
        directory.directory_identity().unwrap(),
        staging.directory_identity().unwrap()
    );
    assert_eq!(
        fs::read(fixture.destination().join("settings.json")).unwrap(),
        BODY
    );
    fixture.assert_source_preserved();
}

#[test]
#[cfg(unix)]
fn symlink_staging_never_follows_or_changes_an_external_directory() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let mut coordinator = fixture.stopped();
    let external = fixture.root.path().join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("keep"), b"external bytes").unwrap();
    symlink(&external, fixture.stage_path()).unwrap();

    assert!(coordinator.prepare_component_staging(ID, DOMAIN).is_err());

    assert_eq!(fs::read(external.join("keep")).unwrap(), b"external bytes");
    assert!(
        fs::symlink_metadata(fixture.stage_path())
            .unwrap()
            .is_symlink()
    );
    assert!(!fixture.destination().exists());
    fixture.assert_source_preserved();
}
