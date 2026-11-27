use super::*;
use std::{cell::Cell, fs};

const OPERATION_ID: &str = "offline-copy-fixture";
const DOMAIN: &str = "native";

#[cfg(windows)]
#[test]
fn stopped_copy_preserves_empty_owner_locked_files_without_reading_locked_ranges() {
    let fixture = Fixture::new();
    let name = OsStr::new(".settings-templates.lock");
    let lock = fixture.source.try_exclusive_lock(name).unwrap().unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let copied = fixture.copy(&inventory, &binding).unwrap();
    assert_eq!(copied.files_copied, 1);
    assert_eq!(copied.bytes_copied, 0);
    assert_eq!(fs::read(fixture.stage_path(name)).unwrap(), b"");
    fixture.copy(&inventory, &binding).unwrap();
    assert!(fixture.source.try_exclusive_lock(name).unwrap().is_none());
    drop(lock);
    assert!(fixture.source.try_exclusive_lock(name).unwrap().is_some());

    let nonempty = Fixture::new();
    nonempty
        .source
        .atomic_replace(name, b"ordinary payload")
        .unwrap();
    let _lock = nonempty.source.try_exclusive_lock(name).unwrap().unwrap();
    assert!(inventory_tree(&nonempty.source, &BTreeSet::new()).is_err());
}

struct Fixture {
    root: tempfile::TempDir,
    source: PrivateDirectory,
    staging: PrivateDirectory,
    operation: PrivateDirectory,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = PrivateDirectory::open_existing(root.path()).unwrap();
        let source = base.create_child(OsStr::new("source")).unwrap();
        let staging = base.create_child(OsStr::new("staging")).unwrap();
        let operation = base.create_child(OsStr::new("operation")).unwrap();
        Self {
            root,
            source,
            staging,
            operation,
        }
    }

    fn source_path(&self, name: impl AsRef<Path>) -> PathBuf {
        self.root.path().join("source").join(name)
    }

    fn stage_path(&self, name: impl AsRef<Path>) -> PathBuf {
        self.root.path().join("staging").join(name)
    }

    fn manifest_path(&self) -> PathBuf {
        self.root
            .path()
            .join("operation")
            .join(format!("tree-copy-{DOMAIN}.json"))
    }

    fn manifest(&self) -> Manifest {
        let bytes = fs::read(self.manifest_path()).unwrap();
        let end = bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .unwrap_or(bytes.len());
        let mut manifest: Manifest = serde_json::from_slice(&bytes[..end]).unwrap();
        if manifest.version == 2 {
            let mut verified = false;
            for frame in bytes[end + 1..].split_inclusive(|byte| *byte == b'\n') {
                let delta = serde_json::from_slice(&frame[..frame.len() - 1]).unwrap();
                apply_delta(&mut manifest, delta, &mut verified).unwrap();
            }
        }
        manifest
    }

    fn inventory(&self) -> StorageTreeInventory {
        inventory_tree(&self.source, &BTreeSet::new()).unwrap()
    }

    fn copy(
        &self,
        inventory: &StorageTreeInventory,
        binding: &RefCell<Option<StorageTreeCopyBinding>>,
    ) -> Result<StorageTreeCopyReceipt> {
        let expected = binding.borrow().clone();
        copy_tree(
            &self.source,
            &self.staging,
            &self.operation,
            OPERATION_ID,
            DOMAIN,
            inventory,
            &BTreeSet::new(),
            expected.as_ref(),
            |next| {
                *binding.borrow_mut() = Some(next.clone());
                Ok(())
            },
        )
    }

    fn copy_with_hook(
        &self,
        inventory: &StorageTreeInventory,
        binding: &RefCell<Option<StorageTreeCopyBinding>>,
        hook: impl FnMut(CopyCheckpoint, &Path) -> Result<()>,
    ) -> Result<StorageTreeCopyReceipt> {
        let expected = binding.borrow().clone();
        copy_tree_with_hook(
            &self.source,
            &self.staging,
            &self.operation,
            OPERATION_ID,
            DOMAIN,
            inventory,
            &BTreeSet::new(),
            expected.as_ref(),
            &mut |next| {
                *binding.borrow_mut() = Some(next.clone());
                Ok(())
            },
            hook,
        )
    }
}

#[test]
fn a_permission_denial_from_the_owner_observer_is_never_replayed() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("persistent.txt"), b"original").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let observations = Cell::new(0);
    let result = fixture.copy_with_hook(&inventory, &binding, |phase, _| {
        if phase == CopyCheckpoint::FilePrepared {
            observations.set(observations.get() + 1);
            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into());
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(observations.get(), 1);
    assert!(!fixture.stage_path("persistent.txt").exists());
    assert_eq!(
        fs::read(fixture.source_path("persistent.txt")).unwrap(),
        b"original"
    );
    assert!(matches!(
        fixture.manifest().publications[0],
        Publication::FilePrepared { .. }
    ));
}

#[test]
fn copies_unknown_persistent_files_empty_directories_and_database_wal_as_exact_bytes() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.source_path("empty")).unwrap();
    fs::create_dir(fixture.source_path("nested")).unwrap();
    let large = (0..(2 * 1024 * 1024 + 17))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(fixture.source_path("nested/unknown.bin"), &large).unwrap();
    fs::write(
        fixture.source_path("store.sqlite3"),
        b"offline database bytes",
    )
    .unwrap();
    fs::write(
        fixture.source_path("store.sqlite3-wal"),
        b"valid WAL remains part of the group",
    )
    .unwrap();
    fs::write(
        fixture.source_path("other.lock"),
        b"unknown persistent leaf",
    )
    .unwrap();
    fs::write(
        fixture.source_path("kcoder-storage-writers.lock"),
        b"owner lease",
    )
    .unwrap();
    let inventory = inventory_tree(
        &fixture.source,
        &BTreeSet::from([PathBuf::from("kcoder-storage-writers.lock")]),
    )
    .unwrap();
    let binding = RefCell::new(None);

    let receipt = fixture.copy(&inventory, &binding).unwrap();

    assert_eq!(receipt.files_copied, 4);
    assert_eq!(receipt.directories_copied, 2);
    assert_eq!(receipt.bytes_copied, large.len() as u64 + 22 + 35 + 23);
    assert_eq!(
        fs::read(fixture.stage_path("nested/unknown.bin")).unwrap(),
        large
    );
    assert!(fixture.stage_path("empty").is_dir());
    assert_eq!(
        fs::read(fixture.stage_path("store.sqlite3-wal")).unwrap(),
        b"valid WAL remains part of the group"
    );
    assert_eq!(
        fs::read(fixture.stage_path("other.lock")).unwrap(),
        b"unknown persistent leaf"
    );
    assert!(!fixture.stage_path("kcoder-storage-writers.lock").exists());
    assert_eq!(
        fs::read(fixture.source_path("kcoder-storage-writers.lock")).unwrap(),
        b"owner lease"
    );
    assert_eq!(fixture.inventory().root_identity, inventory.root_identity);
    let binding = binding.borrow();
    assert!(serde_json::to_vec(binding.as_ref().unwrap()).unwrap().len() < 4096);
    assert!(binding.as_ref().unwrap().authorized_versions.len() <= 2);
}

#[test]
fn same_id_recovers_publication_before_its_completion_receipt_without_recopying() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"original record").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let interrupted = fixture.copy_with_hook(&inventory, &binding, |phase, _| {
        if phase == CopyCheckpoint::FilePublished {
            anyhow::bail!("injected exit after file publication");
        }
        Ok(())
    });
    assert!(interrupted.is_err());
    let before = fixture
        .staging
        .open_entry_handle(OsStr::new("record"))
        .unwrap()
        .identity()
        .unwrap();
    let manifest = fixture.manifest();
    assert!(matches!(
        manifest.publications[0],
        Publication::FilePrepared { .. }
    ));
    let before_manifest = fixture
        .operation
        .open_entry_handle(OsStr::new("tree-copy-native.json"))
        .unwrap()
        .identity()
        .unwrap();

    let receipt = fixture.copy(&inventory, &binding).unwrap();

    assert_eq!(receipt.files_copied, 1);
    assert_eq!(
        fixture
            .staging
            .open_entry_handle(OsStr::new("record"))
            .unwrap()
            .identity()
            .unwrap(),
        before
    );
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"original record"
    );
    assert_eq!(
        fixture
            .operation
            .open_entry_handle(OsStr::new("tree-copy-native.json"))
            .unwrap()
            .identity()
            .unwrap(),
        before_manifest
    );
}

#[test]
fn file_mtime_is_preserved_before_prepared_identity_is_recorded() {
    use std::time::{Duration, UNIX_EPOCH};
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"owner undo proof bytes").unwrap();
    let source_file = fs::OpenOptions::new()
        .write(true)
        .open(fixture.source_path("record"))
        .unwrap();
    let seed = UNIX_EPOCH + Duration::new(1_650_000_000, 123_456_700);
    source_file
        .set_times(FileTimes::new().set_modified(seed).set_accessed(seed))
        .unwrap();
    source_file.sync_all().unwrap();
    let modified = source_file.metadata().unwrap().modified().unwrap();
    assert_eq!(
        modified, seed,
        "fixture filesystem must retain the timestamp precision; missing support is not a passing copy"
    );
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let observed = Cell::new(false);

    copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &BTreeSet::new(),
        None,
        |next| {
            if let Some(pending) = &next.pending_append {
                let delta: ManifestDelta = serde_json::from_str(pending.frame.trim_end())?;
                if let ManifestDelta::Entry {
                    publication: Publication::FilePrepared { identity },
                    ..
                } = delta
                {
                    fixture.staging.visit_entry_names_bounded(16, |name| {
                        let entry = fixture.staging.open_entry_handle(name)?;
                        if entry.identity()? == identity {
                            assert_eq!(entry.metadata().modified()?, modified);
                            observed.set(true);
                        }
                        Ok(())
                    })?;
                }
                *binding.borrow_mut() = Some(next.clone());
                return Ok(());
            }
            let prepared_manifest = next.authorized_versions.last().unwrap();
            fixture.operation.visit_entry_names_bounded(16, |name| {
                let entry = fixture.operation.open_entry_handle(name)?;
                if entry.identity()? == prepared_manifest.identity {
                    let mut input = fixture.operation.open_single_link_regular_file(name)?;
                    let mut bytes = Vec::new();
                    input.read_to_end(&mut bytes)?;
                    let manifest: Manifest = serde_json::from_slice(&bytes)?;
                    if let Publication::FilePrepared { identity } = &manifest.publications[0] {
                        fixture.staging.visit_entry_names_bounded(16, |name| {
                            let entry = fixture.staging.open_entry_handle(name)?;
                            if entry.identity()? == *identity {
                                assert_eq!(entry.metadata().modified()?, modified);
                                observed.set(true);
                            }
                            Ok(())
                        })?;
                    }
                }
                Ok(())
            })?;
            // Timestamp verification precedes the durable-binding callback's
            // acceptance of the manifest version containing this prepared ID.
            *binding.borrow_mut() = Some(next.clone());
            Ok(())
        },
    )
    .unwrap();

    assert!(observed.get());
    let target_metadata = fs::metadata(fixture.stage_path("record")).unwrap();
    assert_eq!(target_metadata.modified().unwrap(), modified);
    assert_eq!(
        source_file.metadata().unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"owner undo proof bytes"
    );
}

#[test]
fn copied_directories_retain_identity_and_mtime_after_retry() {
    use std::time::{Duration, UNIX_EPOCH};
    let fixture = Fixture::new();
    fs::create_dir_all(fixture.source_path("state/child")).unwrap();
    fs::write(
        fixture.source_path("state/child/record"),
        b"sealed tree bytes",
    )
    .unwrap();
    let modified = UNIX_EPOCH + Duration::new(1_650_000_000, 123_456_700);
    for path in ["state", "state/child"] {
        let source = fixture.source_path(path);
        fs::File::open(source)
            .unwrap()
            .set_times(FileTimes::new().set_modified(modified))
            .unwrap();
    }
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let error = fixture
        .copy_with_hook(&inventory, &binding, |phase, _| {
            if phase == CopyCheckpoint::BeforeSourceRecheck {
                anyhow::bail!("lost reply after directory metadata was applied");
            }
            Ok(())
        })
        .unwrap_err();
    assert!(error.to_string().contains("lost reply"));
    let identity = PrivateDirectory::open_existing(&fixture.stage_path("state/child"))
        .unwrap()
        .directory_identity()
        .unwrap();
    for path in ["state", "state/child"] {
        let target = fs::metadata(fixture.stage_path(path)).unwrap();
        assert_eq!(target.modified().unwrap(), modified);
    }
    fixture.copy(&inventory, &binding).unwrap();
    assert_eq!(
        PrivateDirectory::open_existing(&fixture.stage_path("state/child"))
            .unwrap()
            .directory_identity()
            .unwrap(),
        identity
    );
    assert_eq!(
        fs::read(fixture.stage_path("state/child/record")).unwrap(),
        b"sealed tree bytes"
    );
}

#[test]
fn source_mtime_change_after_preparation_rejects_publication_even_with_identical_bytes() {
    use std::time::Duration;
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"same owner proof bytes").unwrap();
    let original = fs::metadata(fixture.source_path("record"))
        .unwrap()
        .modified()
        .unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    let result = fixture.copy_with_hook(&inventory, &binding, |phase, _| {
        if phase == CopyCheckpoint::FilePrepared {
            fs::OpenOptions::new()
                .write(true)
                .open(fixture.source_path("record"))?
                .set_times(FileTimes::new().set_modified(original + Duration::from_secs(2)))?;
        }
        Ok(())
    });

    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("STORAGE_TREE_SOURCE_CHANGED")
    );
    assert!(!fixture.stage_path("record").exists());
    assert_eq!(fs::read_dir(fixture.stage_path("")).unwrap().count(), 0);
    assert_eq!(
        fs::read(fixture.source_path("record")).unwrap(),
        b"same owner proof bytes"
    );
}

#[test]
fn storage_full_before_file_publication_preserves_source_and_resumes_the_original_copy() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"original persistent bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let attempts = Cell::new(0);
    let error = fixture
        .copy_with_hook(&inventory, &binding, |phase, _| {
            if phase == CopyCheckpoint::FilePrepared {
                attempts.set(attempts.get() + 1);
                return Err(std::io::Error::from(std::io::ErrorKind::StorageFull).into());
            }
            Ok(())
        })
        .unwrap_err();
    assert!(error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::StorageFull)
    }));
    assert_eq!(attempts.get(), 1, "a full target is not retried in a loop");
    assert_eq!(fs::read_dir(fixture.stage_path("")).unwrap().count(), 0);
    assert_eq!(
        fs::read(fixture.source_path("record")).unwrap(),
        b"original persistent bytes"
    );
    let original_binding = binding.borrow().clone().unwrap();
    assert_eq!(fixture.copy(&inventory, &binding).unwrap().files_copied, 1);
    assert_eq!(
        binding.borrow().as_ref().unwrap().scope,
        original_binding.scope
    );
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"original persistent bytes"
    );
}

#[test]
fn binding_publication_can_be_lost_before_initial_manifest_publication() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let result = copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &BTreeSet::new(),
        None,
        |next| {
            *binding.borrow_mut() = Some(next.clone());
            anyhow::bail!("durable binding reply lost");
        },
    );
    assert!(result.is_err());
    assert!(binding.borrow().is_some());
    assert!(!fixture.manifest_path().exists());
    assert!(!fixture.stage_path("record").exists());

    fixture.copy(&inventory, &binding).unwrap();
    assert_eq!(fs::read(fixture.stage_path("record")).unwrap(), b"bytes");
}

#[test]
fn prior_manifest_remains_authorized_when_the_next_binding_was_saved_before_failure() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let writes = Cell::new(0);
    let result = copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &BTreeSet::new(),
        None,
        |next| {
            *binding.borrow_mut() = Some(next.clone());
            writes.set(writes.get() + 1);
            if writes.get() == 2 {
                anyhow::bail!("exit before replacement manifest publication");
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    assert_eq!(
        binding.borrow().as_ref().unwrap().authorized_versions.len(),
        2
    );
    assert!(!fixture.stage_path("record").exists());

    fixture.copy(&inventory, &binding).unwrap();
    assert_eq!(fs::read(fixture.stage_path("record")).unwrap(), b"bytes");
}

#[test]
fn unknown_existing_stage_objects_are_preserved_even_when_the_bytes_match() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"same bytes").unwrap();
    fs::write(fixture.stage_path("record"), b"same bytes").unwrap();
    let original = fixture
        .staging
        .open_entry_handle(OsStr::new("record"))
        .unwrap()
        .identity()
        .unwrap();
    let binding = RefCell::new(None);

    let error = fixture.copy(&fixture.inventory(), &binding).unwrap_err();

    assert!(error.to_string().contains("STORAGE_TREE_TARGET_UNKNOWN"));
    assert!(binding.borrow().is_none());
    assert!(!fixture.manifest_path().exists());
    assert_eq!(
        fixture
            .staging
            .open_entry_handle(OsStr::new("record"))
            .unwrap()
            .identity()
            .unwrap(),
        original
    );
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"same bytes"
    );
}

#[test]
fn target_fences_are_excluded_only_by_the_actual_held_identity() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"persistent bytes").unwrap();
    let lease = fixture
        .staging
        .try_exclusive_lock(OsStr::new("kcoder-storage-writers.lock"))
        .unwrap()
        .unwrap();
    let fences = BTreeSet::from([file_identity(&lease).unwrap()]);
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &fences,
        None,
        |next| {
            *binding.borrow_mut() = Some(next.clone());
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"persistent bytes"
    );
    assert_eq!(
        fixture
            .staging
            .open_entry_handle(OsStr::new("kcoder-storage-writers.lock"))
            .unwrap()
            .identity()
            .unwrap(),
        *fences.first().unwrap()
    );

    fs::remove_file(fixture.stage_path("kcoder-storage-writers.lock")).unwrap();
    fs::write(fixture.stage_path("kcoder-storage-writers.lock"), b"").unwrap();
    let expected = binding.borrow().clone().unwrap();
    assert!(
        copy_tree(
            &fixture.source,
            &fixture.staging,
            &fixture.operation,
            OPERATION_ID,
            DOMAIN,
            &inventory,
            &fences,
            Some(&expected),
            |_| Ok(())
        )
        .unwrap_err()
        .to_string()
        .contains("STORAGE_TREE_TARGET_UNKNOWN")
    );
    assert_eq!(
        fs::read(fixture.stage_path("kcoder-storage-writers.lock")).unwrap(),
        b""
    );
}

#[test]
fn a_preexisting_manifest_is_not_adopted_from_its_name_or_json() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    fs::write(fixture.manifest_path(), b"{\"version\":1}").unwrap();
    let binding = RefCell::new(None);

    let error = fixture.copy(&fixture.inventory(), &binding).unwrap_err();

    assert!(error.to_string().contains("STORAGE_TREE_MANIFEST_UNKNOWN"));
    assert_eq!(
        fs::read(fixture.manifest_path()).unwrap(),
        b"{\"version\":1}"
    );
    assert!(binding.borrow().is_none());
    assert!(!fixture.stage_path("record").exists());
}

#[test]
fn an_external_manifest_replacement_during_binding_cas_is_not_overwritten() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let writes = Cell::new(0);
    let result = copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &BTreeSet::new(),
        None,
        |next| {
            *binding.borrow_mut() = Some(next.clone());
            writes.set(writes.get() + 1);
            if writes.get() == 2 {
                fixture
                    .operation
                    .atomic_replace(OsStr::new("tree-copy-native.json"), b"unknown owner data")?;
            }
            Ok(())
        },
    );

    assert!(result.is_err());
    assert_eq!(
        fs::read(fixture.manifest_path()).unwrap(),
        b"unknown owner data"
    );
    assert!(!fixture.stage_path("record").exists());
}

#[test]
fn no_replace_publication_preserves_a_racing_unknown_destination() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"source bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    assert!(
        fixture
            .copy_with_hook(&inventory, &binding, |phase, _| {
                if phase == CopyCheckpoint::FilePrepared {
                    fs::write(fixture.stage_path("record"), b"unknown destination")?;
                }
                Ok(())
            })
            .is_err()
    );
    let error = fixture.copy(&inventory, &binding).unwrap_err();
    assert!(error.to_string().contains("STORAGE_TREE_TARGET_UNKNOWN"));
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"unknown destination"
    );
    assert_eq!(
        fs::read(fixture.source_path("record")).unwrap(),
        b"source bytes"
    );
}

#[test]
fn byte_identical_replacement_does_not_inherit_the_recorded_target_identity() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"same bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    fixture.copy(&inventory, &binding).unwrap();
    // Keep the original inode open so a newly allocated object cannot reuse it.
    let held = fixture
        .staging
        .open_regular_file(OsStr::new("record"))
        .unwrap();
    fs::remove_file(fixture.stage_path("record")).unwrap();
    fs::write(fixture.stage_path("record"), b"same bytes").unwrap();

    let error = fixture.copy(&inventory, &binding).unwrap_err();

    assert!(error.to_string().contains("STORAGE_TREE_TARGET_UNKNOWN"));
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"same bytes"
    );
    assert_eq!(held.metadata().unwrap().len(), 10);
}

#[test]
fn an_unrecorded_created_directory_remains_unknown_after_interruption() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.source_path("empty")).unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    assert!(
        fixture
            .copy_with_hook(&inventory, &binding, |phase, _| {
                if phase == CopyCheckpoint::DirectoryCreated {
                    anyhow::bail!("exit before directory identity receipt");
                }
                Ok(())
            })
            .is_err()
    );

    let error = fixture.copy(&inventory, &binding).unwrap_err();

    assert!(error.to_string().contains("STORAGE_TREE_TARGET_UNKNOWN"));
    assert!(fixture.stage_path("empty").is_dir());
}

#[test]
fn rejects_changed_source_content_before_any_manifest_or_payload_write() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"before").unwrap();
    let inventory = fixture.inventory();
    fs::write(fixture.source_path("record"), b"after!").unwrap();
    let binding = RefCell::new(None);

    assert!(fixture.copy(&inventory, &binding).is_err());
    assert!(binding.borrow().is_none());
    assert!(!fixture.manifest_path().exists());
    assert!(!fixture.stage_path("record").exists());
}

#[test]
fn streamed_hash_rejects_a_same_length_source_change_after_inventory_recheck() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"before").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    let result = fixture.copy_with_hook(&inventory, &binding, |phase, _| {
        if phase == CopyCheckpoint::BeforeEntry {
            fs::write(fixture.source_path("record"), b"after!")?;
        }
        Ok(())
    });

    assert!(result.is_err());
    assert!(!fixture.stage_path("record").exists());
    assert_eq!(fs::read_dir(fixture.stage_path("")).unwrap().count(), 0);
}

#[test]
fn post_copy_source_recheck_detects_new_unknown_persistent_data() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"source bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    let result = fixture.copy_with_hook(&inventory, &binding, |phase, _| {
        if phase == CopyCheckpoint::BeforeSourceRecheck {
            fs::write(fixture.source_path("late-unknown"), b"preserve this source")?;
        }
        Ok(())
    });

    assert!(result.is_err());
    assert_eq!(
        fs::read(fixture.source_path("late-unknown")).unwrap(),
        b"preserve this source"
    );
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"source bytes"
    );
}

#[test]
fn final_verification_requires_the_prepared_payload_to_exist() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"frozen source bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let result = fixture.copy_with_hook(&inventory, &binding, |phase, _| {
        if phase == CopyCheckpoint::BeforeSourceRecheck {
            fs::remove_file(fixture.stage_path("record"))?;
        }
        Ok(())
    });

    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("STORAGE_TREE_TARGET_CHANGED")
    );
    assert!(!fixture.stage_path("record").exists());
    fixture.copy(&inventory, &binding).unwrap();
    assert_eq!(
        fs::read(fixture.stage_path("record")).unwrap(),
        b"frozen source bytes"
    );
}

#[test]
fn original_operation_and_staging_native_identities_are_required_on_resume() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    fixture.copy(&inventory, &binding).unwrap();
    let other = PrivateDirectory::open_existing(fixture.root.path())
        .unwrap()
        .create_child(OsStr::new("other"))
        .unwrap();
    let expected = binding.borrow().clone().unwrap();
    for (staging, operation) in [(&other, &fixture.operation), (&fixture.staging, &other)] {
        let result = copy_tree(
            &fixture.source,
            staging,
            operation,
            OPERATION_ID,
            DOMAIN,
            &inventory,
            &BTreeSet::new(),
            Some(&expected),
            |_| anyhow::bail!("must not write a new binding"),
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("STORAGE_TREE_MANIFEST_CONFLICT")
        );
    }
    assert_eq!(fs::read(fixture.stage_path("record")).unwrap(), b"bytes");
}

#[test]
fn modified_manifest_bytes_cannot_reuse_the_recorded_native_file_identity() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    fixture.copy(&inventory, &binding).unwrap();
    let mut bytes = fs::read(fixture.manifest_path()).unwrap();
    let last = bytes.len() - 1;
    bytes[last] = b' ';
    fs::write(fixture.manifest_path(), &bytes).unwrap();

    let error = fixture.copy(&inventory, &binding).unwrap_err();

    assert!(error.to_string().contains("STORAGE_TREE_MANIFEST_UNKNOWN"));
    assert_eq!(fs::read(fixture.manifest_path()).unwrap(), bytes);
}

#[test]
#[cfg(unix)]
fn native_non_utf8_names_round_trip_through_manifest_and_resume() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = Fixture::new();
    let directory = OsString::from_vec(b"dir-\xff".to_vec());
    let file = OsString::from_vec(b"record-\xfe".to_vec());
    let relative = PathBuf::from(&directory).join(&file);
    fs::create_dir(fixture.source_path(&directory)).unwrap();
    fs::write(fixture.source_path(&relative), b"native name bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    fixture.copy(&inventory, &binding).unwrap();
    fixture.copy(&inventory, &binding).unwrap();

    assert_eq!(
        fs::read(fixture.stage_path(&relative)).unwrap(),
        b"native name bytes"
    );
    let manifest = fixture.manifest();
    assert_eq!(
        manifest.inventory.entries[1].path.decode().unwrap(),
        relative
    );
    assert!(
        !fs::read_to_string(fixture.manifest_path())
            .unwrap()
            .contains('\u{fffd}')
    );
}

#[test]
#[cfg(any(unix, windows))]
#[cfg_attr(
    windows,
    ignore = "requires native Windows filesystem acceptance of a 255 UTF-16-unit leaf; not verified by Unix or cross-compilation"
)]
fn maximum_length_unicode_leaf_is_preserved_without_a_destination_sized_temporary_name() {
    let fixture = Fixture::new();
    #[cfg(unix)]
    let name = OsString::from("文".repeat(85));
    #[cfg(windows)]
    let name = OsString::from("文".repeat(255));
    // An unsupported source filesystem must fail this fixture explicitly; it
    // must not turn the missing filename prerequisite into a passing copy test.
    fs::write(fixture.source_path(&name), b"maximum Unicode leaf").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    fixture.copy(&inventory, &binding).unwrap();
    fixture.copy(&inventory, &binding).unwrap();

    assert_eq!(
        fs::read(fixture.stage_path(&name)).unwrap(),
        b"maximum Unicode leaf"
    );
    let manifest = fixture.manifest();
    assert_eq!(
        manifest.inventory.entries[0].path.decode().unwrap(),
        PathBuf::from(name)
    );
}

#[test]
#[cfg(any(unix, windows))]
#[cfg_attr(
    windows,
    ignore = "requires native Windows filesystem acceptance of a 255-unit non-Unicode UTF-16 leaf; not verified by Unix or cross-compilation"
)]
fn maximum_length_non_unicode_native_leaf_round_trips_exactly() {
    let fixture = Fixture::new();
    #[cfg(unix)]
    let name = {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(vec![0xff; 255])
    };
    #[cfg(windows)]
    let name = {
        use std::os::windows::ffi::OsStringExt;
        OsString::from_wide(&[0xdcff; 255])
    };
    fs::write(fixture.source_path(&name), b"maximum native leaf").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    fixture.copy(&inventory, &binding).unwrap();
    fixture.copy(&inventory, &binding).unwrap();

    assert_eq!(
        fs::read(fixture.stage_path(&name)).unwrap(),
        b"maximum native leaf"
    );
    let manifest = fixture.manifest();
    assert_eq!(
        manifest.inventory.entries[0].path.decode().unwrap(),
        PathBuf::from(name)
    );
}

#[test]
#[cfg(unix)]
fn an_unexcluded_symlink_is_rejected_without_following_its_target() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let external = fixture.root.path().join("external");
    fs::write(&external, b"external data").unwrap();
    symlink(&external, fixture.source_path("external-link")).unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);

    let error = fixture.copy(&inventory, &binding).unwrap_err();

    assert!(error.to_string().contains("STORAGE_TREE_LINK_UNSUPPORTED"));
    assert!(binding.borrow().is_none());
    assert!(!fixture.manifest_path().exists());
    assert_eq!(fs::read(&external).unwrap(), b"external data");
    assert!(!fixture.stage_path("external-link").exists());
}

#[test]
#[cfg(unix)]
fn exact_owner_exclusions_record_cache_directories_and_links_without_copying_them() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    fs::create_dir(fixture.source_path("Cache")).unwrap();
    fs::write(
        fixture.source_path("Cache/owner-cache"),
        b"cache owner keeps this",
    )
    .unwrap();
    let external = fixture.root.path().join("external-cache");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("keep"), b"external cache bytes").unwrap();
    symlink(&external, fixture.source_path("CacheLink")).unwrap();
    fs::write(fixture.source_path("persistent"), b"persistent bytes").unwrap();
    let exclusions = BTreeSet::from([PathBuf::from("Cache"), PathBuf::from("CacheLink")]);
    let inventory = inventory_tree(&fixture.source, &exclusions).unwrap();
    let binding = RefCell::new(None);

    assert_eq!(fixture.copy(&inventory, &binding).unwrap().files_copied, 1);
    fixture.copy(&inventory, &binding).unwrap();

    assert!(!fixture.stage_path("Cache").exists());
    assert!(!fixture.stage_path("CacheLink").exists());
    assert_eq!(
        fs::read(fixture.stage_path("persistent")).unwrap(),
        b"persistent bytes"
    );
    assert_eq!(
        fs::read(external.join("keep")).unwrap(),
        b"external cache bytes"
    );
}

#[test]
fn exact_owner_linked_projection_is_recorded_without_copying_and_recovers_under_the_same_id() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.source_path("epoch")).unwrap();
    fs::create_dir(fixture.source_path("projection.state")).unwrap();
    fs::write(
        fixture.source_path("epoch/marker.json"),
        b"owner linked identity",
    )
    .unwrap();
    fs::hard_link(
        fixture.source_path("epoch/marker.json"),
        fixture.source_path("projection"),
    )
    .unwrap();
    fs::write(
        fixture.source_path("persistent"),
        b"unknown persistent bytes",
    )
    .unwrap();
    let exclusions = BTreeSet::from([
        PathBuf::from("projection"),
        PathBuf::from("projection.state"),
        PathBuf::from("epoch"),
    ]);
    let inventory = inventory_tree(&fixture.source, &exclusions).unwrap();
    let binding = RefCell::new(None);
    assert_eq!(fixture.copy(&inventory, &binding).unwrap().files_copied, 1);
    let original = fixture
        .staging
        .open_entry_handle(OsStr::new("persistent"))
        .unwrap()
        .identity()
        .unwrap();
    fixture.copy(&inventory, &binding).unwrap();
    assert_eq!(
        fixture
            .staging
            .open_entry_handle(OsStr::new("persistent"))
            .unwrap()
            .identity()
            .unwrap(),
        original
    );
    assert!(
        exclusions
            .iter()
            .all(|path| !fixture.stage_path(path).exists())
    );
    assert_eq!(
        fs::read(fixture.stage_path("persistent")).unwrap(),
        b"unknown persistent bytes"
    );
    let manifest = fixture.manifest();
    for path in &exclusions {
        let index = manifest
            .inventory
            .entries
            .iter()
            .position(|entry| entry.path.decode().unwrap() == *path)
            .unwrap();
        assert!(manifest.inventory.entries[index].excluded);
        assert!(matches!(
            manifest.publications[index],
            Publication::Excluded
        ));
        assert!(manifest.inventory.entries[index].sha256.is_none());
    }
    let before = binding.borrow().clone();
    fs::hard_link(
        fixture.source_path("projection"),
        fixture.source_path("unowned-same-bytes"),
    )
    .unwrap();
    assert!(fixture.copy(&inventory, &binding).is_err());
    assert_eq!(*binding.borrow(), before);
    assert_eq!(
        fs::read(fixture.stage_path("persistent")).unwrap(),
        b"unknown persistent bytes"
    );
}

#[test]
fn future_binding_versions_fail_before_mutating_existing_manifest_or_staging() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    fixture.copy(&inventory, &binding).unwrap();
    let before = fs::read(fixture.manifest_path()).unwrap();
    binding.borrow_mut().as_mut().unwrap().version = 3;

    let error = fixture.copy(&inventory, &binding).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("STORAGE_TREE_MANIFEST_VERSION_UNSUPPORTED")
    );
    assert_eq!(fs::read(fixture.manifest_path()).unwrap(), before);
    assert_eq!(fs::read(fixture.stage_path("record")).unwrap(), b"bytes");
}

#[test]
fn oversized_manifest_metadata_is_rejected_before_allocating_or_parsing_its_body() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"bytes").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    fixture.copy(&inventory, &binding).unwrap();
    let sparse = fs::OpenOptions::new()
        .write(true)
        .open(fixture.manifest_path())
        .unwrap();
    sparse.set_len(APPEND_MANIFEST_LIMIT as u64 + 1).unwrap();

    let error = fixture.copy(&inventory, &binding).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("STORAGE_TREE_MANIFEST_BUDGET_EXCEEDED")
    );
    assert_eq!(
        fs::metadata(fixture.manifest_path()).unwrap().len(),
        APPEND_MANIFEST_LIMIT as u64 + 1
    );
    assert_eq!(fs::read(fixture.stage_path("record")).unwrap(), b"bytes");
}

#[test]
fn metadata_manifest_can_exceed_the_operation_receipt_budget() {
    let name = "unknown-persistent-record-".repeat(6);
    let entries = (0..2048)
        .map(|index| SourceEntry {
            path: NativeRelativePath::encode(Path::new(&format!("{index:08}-{name}"))).unwrap(),
            kind: EntryKind::RegularFile,
            identity: "x".repeat(200),
            size_bytes: Some(u64::MAX),
            sha256: Some("0".repeat(64)),
            excluded: false,
        })
        .collect();
    let original = SourceInventory {
        root_identity: "original-root".into(),
        entries,
    };

    let bytes = metadata_bytes(&original).unwrap();

    assert!(bytes.len() > 1024 * 1024);
    assert!(bytes.len() < MANIFEST_LIMIT);
    assert_eq!(
        serde_json::from_slice::<SourceInventory>(&bytes).unwrap(),
        original
    );
}

#[test]
fn a_recorded_partial_append_is_completed_before_adopting_its_directory_fact() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.source_path("empty")).unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    let result = copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &BTreeSet::new(),
        None,
        |next| {
            *binding.borrow_mut() = Some(next.clone());
            if let Some(pending) = &next.pending_append {
                let mut file = fixture
                    .operation
                    .open_read_write_file(OsStr::new("tree-copy-native.json"), false)?;
                file.seek(SeekFrom::End(0))?;
                file.write_all(&pending.frame.as_bytes()[..pending.frame.len() / 2])?;
                file.sync_all()?;
                anyhow::bail!("append interrupted after its recorded prefix");
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    let original = PrivateDirectory::open_existing(&fixture.stage_path("empty"))
        .unwrap()
        .directory_identity()
        .unwrap();

    assert_eq!(
        fixture
            .copy(&inventory, &binding)
            .unwrap()
            .directories_copied,
        1
    );

    assert_eq!(
        PrivateDirectory::open_existing(&fixture.stage_path("empty"))
            .unwrap()
            .directory_identity()
            .unwrap(),
        original
    );
    assert_eq!(binding.borrow().as_ref().unwrap().version, 2);
    assert!(fs::read(fixture.manifest_path()).unwrap().ends_with(b"\n"));
}

#[test]
fn unknown_append_tails_are_preserved_without_truncating_or_replaying_payloads() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"payload").unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    fixture.copy(&inventory, &binding).unwrap();
    let original = fixture
        .staging
        .open_entry_handle(OsStr::new("record"))
        .unwrap()
        .identity()
        .unwrap();
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(fixture.manifest_path())
        .unwrap();
    file.write_all(b"unknown journal tail\n").unwrap();
    file.sync_all().unwrap();
    let bytes = fs::read(fixture.manifest_path()).unwrap();

    assert!(
        fixture
            .copy(&inventory, &binding)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_TREE_MANIFEST_UNKNOWN")
    );

    assert_eq!(fs::read(fixture.manifest_path()).unwrap(), bytes);
    assert_eq!(
        fixture
            .staging
            .open_entry_handle(OsStr::new("record"))
            .unwrap()
            .identity()
            .unwrap(),
        original
    );
}

#[test]
fn a_mismatching_partial_append_remains_unknown_instead_of_being_overwritten() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.source_path("empty")).unwrap();
    let inventory = fixture.inventory();
    let binding = RefCell::new(None);
    assert!(
        copy_tree(
            &fixture.source,
            &fixture.staging,
            &fixture.operation,
            OPERATION_ID,
            DOMAIN,
            &inventory,
            &BTreeSet::new(),
            None,
            |next| {
                *binding.borrow_mut() = Some(next.clone());
                if next.pending_append.is_some() {
                    let mut file = fixture
                        .operation
                        .open_read_write_file(OsStr::new("tree-copy-native.json"), false)?;
                    file.seek(SeekFrom::End(0))?;
                    file.write_all(b"!")?;
                    file.sync_all()?;
                    anyhow::bail!("unrecognized partial append");
                }
                Ok(())
            }
        )
        .is_err()
    );
    let bytes = fs::read(fixture.manifest_path()).unwrap();

    assert!(
        fixture
            .copy(&inventory, &binding)
            .unwrap_err()
            .to_string()
            .contains("STORAGE_TREE_MANIFEST_UNKNOWN")
    );

    assert_eq!(fs::read(fixture.manifest_path()).unwrap(), bytes);
    assert!(fixture.stage_path("empty").is_dir());
}

#[test]
fn existing_v1_manifests_keep_their_original_same_id_recovery_path() {
    let fixture = Fixture::new();
    fs::write(fixture.source_path("record"), b"legacy payload").unwrap();
    let inventory = fixture.inventory();
    let original = encode_inventory(&inventory).unwrap();
    let fences = BTreeSet::new();
    let context = CopyContext {
        source: &fixture.source,
        staging: &fixture.staging,
        operation: &fixture.operation,
        target_fences: &fences,
        append: RefCell::new(None),
        name: OsString::from("tree-copy-native.json"),
        scope: CopyScope {
            operation_id: OPERATION_ID.into(),
            domain: DOMAIN.into(),
            operation_directory_identity: fixture.operation.directory_identity().unwrap(),
            source_root_identity: inventory.root_identity.clone(),
            staging_root_identity: fixture.staging.directory_identity().unwrap(),
            inventory_sha256: digest(&metadata_bytes(&original).unwrap()),
        },
    };
    let manifest = Manifest {
        version: 1,
        scope: context.scope.clone(),
        inventory: original,
        publications: vec![Publication::Pending],
    };
    let binding = RefCell::new(None);
    persist_manifest(&context, &manifest, &mut None, None, &mut |next| {
        *binding.borrow_mut() = Some(next.clone());
        Ok(())
    })
    .unwrap();
    assert!(
        fixture
            .copy_with_hook(&inventory, &binding, |phase, _| {
                if phase == CopyCheckpoint::FilePublished {
                    anyhow::bail!("legacy publication reply lost");
                }
                Ok(())
            })
            .is_err()
    );
    let original = fixture
        .staging
        .open_entry_handle(OsStr::new("record"))
        .unwrap()
        .identity()
        .unwrap();

    fixture.copy(&inventory, &binding).unwrap();

    assert_eq!(binding.borrow().as_ref().unwrap().version, 1);
    assert_eq!(fixture.manifest().version, 1);
    assert_eq!(
        fixture
            .staging
            .open_entry_handle(OsStr::new("record"))
            .unwrap()
            .identity()
            .unwrap(),
        original
    );
}

#[test]
#[cfg(target_os = "linux")]
fn append_manifest_metadata_writes_scale_linearly() {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    const CHILD: &str = "KCODER_TREE_COPY_LINEAR_WRITE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        struct OwnedChild(Option<std::process::Child>);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                if let Some(child) = &mut self.0 {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let mut child = OwnedChild(Some(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::tree_copy::tests::append_manifest_metadata_writes_scale_linearly",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        let deadline = Instant::now() + Duration::from_secs(30);
        while child.0.as_mut().unwrap().try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "owned copy write-budget child timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.0.take().unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    fn write_bytes() -> u64 {
        fs::read_to_string("/proc/self/io")
            .unwrap()
            .lines()
            .find_map(|line| {
                line.strip_prefix("wchar:")
                    .map(|count| count.trim().parse().unwrap())
            })
            .unwrap()
    }
    let fixture = Fixture::new();
    for index in 0..128 {
        fs::write(fixture.source_path(format!("entry-{index:04}")), b"x").unwrap();
    }
    let inventory = fixture.inventory();
    let initial_size = Cell::new(0u64);
    let appended = Cell::new(0u64);
    let manifest_identity = RefCell::new(None::<String>);
    let before = write_bytes();
    copy_tree(
        &fixture.source,
        &fixture.staging,
        &fixture.operation,
        OPERATION_ID,
        DOMAIN,
        &inventory,
        &BTreeSet::new(),
        None,
        |next| {
            let version = next.authorized_versions.last().unwrap();
            let previous_identity = manifest_identity.borrow().clone();
            if let Some(identity) = previous_identity {
                assert_eq!(identity, version.identity);
            } else {
                *manifest_identity.borrow_mut() = Some(version.identity.clone());
            }
            if let Some(pending) = &next.pending_append {
                appended.set(appended.get() + pending.frame.len() as u64);
            } else {
                initial_size.set(version.size_bytes);
            }
            Ok(())
        },
    )
    .unwrap();
    let written = write_bytes() - before;
    let expected = initial_size.get() + appended.get();
    assert_eq!(
        fs::metadata(fixture.manifest_path()).unwrap().len(),
        expected
    );
    // Actual process write syscalls include payload bytes. A per-entry rewrite
    // of the original inventory exceeds this bound by several megabytes.
    assert!(
        written <= expected + 128 + 64 * 1024,
        "metadata writes are not linear: actual={written}, manifest={expected}"
    );
    assert_eq!(fixture.manifest().inventory.entries.len(), 128);
}
