use super::*;
use crate::storage::{StorageResolveInput, resolve_storage_paths};
use kcoder_types::{
    StorageLaunchIntent, StorageMigrationComponent, StorageMigrationPlan, StorageTargetBinding,
};
use std::{cell::Cell, fs};

const ID: &str = "source-cleanup-fixture";
const DOMAIN: &str = "persistent-root";
const BODY: &[u8] = b"original bytes";

struct Fixture {
    owned: tempfile::TempDir,
    source: PathBuf,
    target: StorageLocationRecord,
}

impl Fixture {
    fn new(in_place: bool) -> Self {
        Self::with_extra_files(in_place, 0, BTreeSet::new())
    }

    fn with_extra_files(in_place: bool, files: usize, exclusions: BTreeSet<PathBuf>) -> Self {
        let owned = tempfile::tempdir().unwrap();
        let mut from = resolve_storage_paths(&StorageResolveInput {
            home: Some(owned.path().into()),
            ..Default::default()
        })
        .unwrap();
        if files != 0 {
            let padding = 152usize.saturating_sub(owned.path().to_string_lossy().len() + 1);
            from.data_root = owned.path().join("p".repeat(padding.max(1)));
        }
        from.gateway_root = from.data_root.join("studio/gateway");
        from.desktop_root = from.data_root.join("studio/desktop");
        from.cache_root = owned.path().join("old-cache");
        for path in [
            &from.data_root,
            &from.gateway_root,
            &from.desktop_root,
            &from.cache_root,
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir(from.data_root.join("nested")).unwrap();
        fs::create_dir(from.data_root.join("empty")).unwrap();
        for name in ["alpha", "modified", "replaced", "nested/original"] {
            fs::write(from.data_root.join(name), BODY).unwrap();
        }
        if files != 0 {
            let directory = from.data_root.join("electron-profile-cache-".repeat(3));
            fs::create_dir(&directory).unwrap();
            for index in 0..files {
                fs::write(directory.join(format!("entry-{index:04}.json")), BODY).unwrap();
            }
        }
        let source = from.data_root.clone();
        let target = StorageLocationRecord {
            version: 1,
            revision: 1,
            data_root: if in_place {
                source.clone()
            } else {
                owned.path().join("new-data")
            },
            cache_root: owned.path().join("new-cache"),
            operation_id: Some(ID.into()),
        };
        let ancestor_path = if in_place {
            source.as_path()
        } else {
            owned.path()
        };
        let ancestor = PrivateDirectory::open_existing(ancestor_path).unwrap();
        let plan = StorageMigrationPlan {
            version: 1,
            operation_id: ID.into(),
            original: None,
            components: vec![StorageMigrationComponent {
                domain: DOMAIN.into(),
                source: source.clone(),
                destination: target.data_root.clone(),
                source_identity: PrivateDirectory::open_existing(&source)
                    .unwrap()
                    .directory_identity()
                    .unwrap(),
                estimated_bytes: 0,
            }],
            from,
            target: target.clone(),
            target_bindings: vec![StorageTargetBinding {
                path: target.data_root.clone(),
                existing_ancestor: ancestor_path.into(),
                ancestor_identity: ancestor.directory_identity().unwrap(),
            }],
            launch_intent: StorageLaunchIntent::VerifyOnly,
        };
        let mut coordinator = StorageCoordinator::acquire(owned.path()).unwrap();
        coordinator.begin(plan).unwrap();
        for (before, after) in [
            (Phase::Planned, Phase::Stopping),
            (Phase::Stopping, Phase::Stopped),
        ] {
            coordinator.advance(ID, before, after).unwrap();
        }
        coordinator.prepare_source_retirements(ID).unwrap();
        coordinator
            .advance(ID, Phase::Stopped, Phase::Copying)
            .unwrap();
        if !in_place {
            coordinator
                .publish_component(ID, DOMAIN, &exclusions)
                .unwrap();
        }
        for (before, after) in [
            (Phase::Copying, Phase::Verifying),
            (Phase::Verifying, Phase::Prepared),
        ] {
            coordinator.advance(ID, before, after).unwrap();
        }
        coordinator.commit(ID).unwrap();
        coordinator.complete(ID).unwrap();
        drop(coordinator);
        Self {
            owned,
            source,
            target,
        }
    }

    fn coordinator(&self) -> StorageCoordinator {
        StorageCoordinator::acquire(self.owned.path()).unwrap()
    }

    fn manifest(&self) -> PathBuf {
        self.owned
            .path()
            .join(".config/kcoder-storage-migrations")
            .join(ID)
            .join(format!("tree-copy-{DOMAIN}.json"))
    }

    fn select_cache_under_source(&self, relative: &str) {
        let cache_root = self.source.join(relative);
        fs::create_dir_all(&cache_root).unwrap();
        let mut coordinator = self.coordinator();
        let from = resolve_storage_paths(&StorageResolveInput {
            home: Some(self.owned.path().into()),
            record: Some(self.target.clone()),
            ..Default::default()
        })
        .unwrap();
        let second = StorageLocationRecord {
            revision: 2,
            cache_root,
            operation_id: Some("second-selection".into()),
            ..self.target.clone()
        };
        coordinator
            .begin(StorageMigrationPlan {
                version: 1,
                operation_id: "second-selection".into(),
                original: Some(self.target.clone()),
                from,
                target: second,
                components: vec![],
                target_bindings: vec![],
                launch_intent: StorageLaunchIntent::VerifyOnly,
            })
            .unwrap();
        for (before, after) in [
            (Phase::Planned, Phase::Stopping),
            (Phase::Stopping, Phase::Stopped),
            (Phase::Stopped, Phase::Copying),
            (Phase::Copying, Phase::Verifying),
            (Phase::Verifying, Phase::Prepared),
        ] {
            coordinator
                .advance("second-selection", before, after)
                .unwrap();
            if after == Phase::Stopped {
                coordinator
                    .prepare_source_retirements("second-selection")
                    .unwrap();
            }
        }
        coordinator.commit("second-selection").unwrap();
        coordinator.complete("second-selection").unwrap();
    }
}

fn status(entries: &[StorageSourceCleanupEntry], path: &str) -> Status {
    entries
        .iter()
        .find(|entry| entry.domain == DOMAIN && entry.relative_path == Path::new(path))
        .unwrap()
        .status
}

#[test]
fn preview_preserves_source_and_confirmation_removes_only_unchanged_original_entries() {
    let fixture = Fixture::new(false);
    fs::write(fixture.source.join("modified"), b"new value").unwrap();
    let source = PrivateDirectory::open_existing(&fixture.source).unwrap();
    source.atomic_replace(OsStr::new("replaced"), BODY).unwrap();
    fs::write(fixture.source.join("nested/new"), b"new unknown data").unwrap();
    let coordinator = fixture.coordinator();
    let before = coordinator.current().unwrap().unwrap();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    assert_eq!(coordinator.current().unwrap().unwrap(), before);
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    assert_eq!(status(&preview.entries, "alpha"), Status::EligibleFile);
    assert_eq!(
        status(&preview.entries, "modified"),
        Status::RetainedChanged
    );
    assert_eq!(
        status(&preview.entries, "replaced"),
        Status::RetainedChanged
    );
    assert_eq!(
        status(&preview.entries, "nested/new"),
        Status::RetainedUnknown
    );
    assert!(
        coordinator
            .confirm_source_cleanup(ID, "unconfirmed")
            .is_err()
    );
    assert!(
        !coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .contains_key(OWNER)
    );
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(status(&result.entries, "alpha"), Status::Removed);
    assert_eq!(status(&result.entries, "empty"), Status::Removed);
    assert_eq!(status(&result.entries, "nested"), Status::RetainedNotEmpty);
    assert_eq!(
        fs::read(fixture.source.join("nested/new")).unwrap(),
        b"new unknown data"
    );
    assert_eq!(
        fs::read(fixture.source.join("modified")).unwrap(),
        b"new value"
    );
    assert_eq!(fs::read(fixture.source.join("replaced")).unwrap(), BODY);
    assert_eq!(
        fs::read(fixture.target.data_root.join("alpha")).unwrap(),
        BODY
    );
    assert!(fixture.source.is_dir());
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(receipt.disposition, Disposition::Complete);
    assert_eq!(receipt.phase, Phase::Verified);
    assert_eq!(receipt.error_code, None);
    assert_eq!(
        coordinator
            .confirm_source_cleanup(ID, &preview.confirmation)
            .unwrap(),
        result
    );
}

#[test]
fn changed_preview_and_replaced_object_at_removal_are_preserved() {
    let fixture = Fixture::new(false);
    let coordinator = fixture.coordinator();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    fs::write(fixture.source.join("modified"), b"changed after preview").unwrap();
    assert_eq!(
        coordinator
            .confirm_source_cleanup(ID, &preview.confirmation)
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_CLEANUP_PREVIEW_CHANGED"
    );
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    let result = coordinator
        .confirm_source_cleanup_with_hook(ID, &preview.confirmation, |path| {
            if path == fixture.source.join("replaced") {
                PrivateDirectory::open_existing(&fixture.source)?
                    .atomic_replace(OsStr::new("replaced"), BODY)?;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(status(&result.entries, "replaced"), Status::RetainedChanged);
    assert_eq!(fs::read(fixture.source.join("replaced")).unwrap(), BODY);
    assert_eq!(
        fs::read(fixture.source.join("modified")).unwrap(),
        b"changed after preview"
    );
}

#[test]
fn lost_cleanup_reply_reconciles_original_confirmation_and_never_adopts_replacement() {
    let fixture = Fixture::new(false);
    let coordinator = fixture.coordinator();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    let count = Cell::new(0usize);
    let failed = coordinator.confirm_source_cleanup_with_hook(ID, &preview.confirmation, |path| {
        if path.is_file() {
            count.set(count.get() + 1);
            ensure!(count.get() < 2, "injected cleanup interruption");
        }
        Ok(())
    });
    assert!(failed.is_err());
    assert!(
        ["alpha", "modified", "replaced", "nested/original"]
            .iter()
            .any(|path| !fixture.source.join(path).exists())
    );
    assert!(
        binding(&coordinator.current().unwrap().unwrap())
            .unwrap()
            .unwrap()
            .result
            .is_none()
    );
    drop(coordinator);
    fs::write(fixture.source.join("new-after-interruption"), b"keep").unwrap();
    PrivateDirectory::open_existing(&fixture.source)
        .unwrap()
        .atomic_replace(OsStr::new("alpha"), BODY)
        .unwrap();
    let coordinator = fixture.coordinator();
    let pending = coordinator.preview_source_cleanup(ID).unwrap();
    assert!(pending.pending);
    assert_eq!(pending.confirmation, preview.confirmation);
    assert!(
        coordinator
            .confirm_source_cleanup(ID, "new-attempt-id")
            .is_err()
    );
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(result.operation_id, ID);
    assert_eq!(status(&result.entries, "alpha"), Status::RetainedChanged);
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    assert_eq!(
        fs::read(fixture.source.join("new-after-interruption")).unwrap(),
        b"keep"
    );
    assert_eq!(
        coordinator.current().unwrap().unwrap().disposition,
        Disposition::Complete
    );
}

#[test]
fn active_old_writer_blocks_cleanup_without_mutating_original_receipt() {
    let fixture = Fixture::new(false);
    let writer = crate::storage::writers::RootLease::shared(&fixture.source, true).unwrap();
    let coordinator = fixture.coordinator();
    let receipt = coordinator.current().unwrap().unwrap();
    assert!(coordinator.preview_source_cleanup(ID).is_err());
    assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    drop(writer);
    assert!(coordinator.preview_source_cleanup(ID).is_ok());
}

#[test]
fn replaced_writer_name_cannot_hide_an_original_still_locked_writer() {
    let fixture = Fixture::new(false);
    let source = PrivateDirectory::open_existing(&fixture.source).unwrap();
    let name = OsStr::new(crate::storage::writers::WRITERS);
    let original_writer = source.try_existing_shared_lock(name).unwrap().unwrap();
    let original_identity = identity(&original_writer).unwrap();
    source.atomic_replace(name, b"").unwrap();
    let replacement = source.try_existing_exclusive_lock(name).unwrap().unwrap();
    assert_ne!(identity(&replacement).unwrap(), original_identity);
    drop(replacement);
    let coordinator = fixture.coordinator();
    let receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(
        coordinator
            .preview_source_cleanup(ID)
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_CLEANUP_WRITER_UNKNOWN"
    );
    assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    drop(original_writer);
}

#[test]
fn in_place_native_root_never_requires_copy_or_becomes_cleanup_authority() {
    let fixture = Fixture::new(true);
    let coordinator = fixture.coordinator();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    assert_eq!(preview.entries.len(), 1);
    assert_eq!(preview.entries[0].status, Status::RetainedInPlace);
    assert!(!fixture.manifest().exists());
    coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
}

#[test]
fn subsequent_selection_protects_cache_subtree_and_leaves_current_receipt_unchanged() {
    let fixture = Fixture::new(false);
    fixture.select_cache_under_source("nested");
    let coordinator = fixture.coordinator();
    let current = coordinator.current().unwrap().unwrap();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    assert_eq!(status(&preview.entries, "nested"), Status::RetainedCurrent);
    assert_eq!(
        status(&preview.entries, "nested/original"),
        Status::RetainedCurrent
    );
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(status(&result.entries, "alpha"), Status::Removed);
    assert_eq!(
        fs::read(fixture.source.join("nested/original")).unwrap(),
        BODY
    );
    assert_eq!(coordinator.current().unwrap().unwrap(), current);
}

#[test]
fn current_nested_cache_is_opaque_but_its_ancestor_still_locks_deletable_siblings() {
    let fixture = Fixture::new(false);
    fixture.select_cache_under_source("nested/current-cache");
    let cache = fixture.source.join("nested/current-cache");
    for index in 0..=ENTRY_LIMIT {
        fs::write(cache.join(index.to_string()), b"current cache").unwrap();
    }
    let writer =
        crate::storage::writers::RootLease::shared(&fixture.source.join("nested"), true).unwrap();
    let coordinator = fixture.coordinator();
    let current = coordinator.current().unwrap().unwrap();
    assert_eq!(
        coordinator
            .preview_source_cleanup(ID)
            .unwrap_err()
            .to_string(),
        "STORAGE_WRITERS_ACTIVE"
    );
    assert_eq!(
        fs::read(fixture.source.join("nested/original")).unwrap(),
        BODY
    );
    assert_eq!(coordinator.current().unwrap().unwrap(), current);
    drop(writer);
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    assert_eq!(status(&preview.entries, "alpha"), Status::EligibleFile);
    assert_eq!(
        status(&preview.entries, "nested/original"),
        Status::EligibleFile
    );
    assert!(!preview.entries.iter().any(|entry| {
        entry.relative_path.starts_with("nested/current-cache")
            && entry.relative_path != Path::new("nested/current-cache")
    }));
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(status(&result.entries, "nested/original"), Status::Removed);
    assert_eq!(fs::read(cache.join("0")).unwrap(), b"current cache");
    assert_eq!(
        fs::read(cache.join(ENTRY_LIMIT.to_string())).unwrap(),
        b"current cache"
    );
    assert_eq!(coordinator.current().unwrap().unwrap(), current);
}

#[test]
fn unknown_manifest_or_future_binding_never_authorizes_source_removal() {
    for damage in ["replace-manifest", "future-binding"] {
        let fixture = Fixture::new(false);
        let coordinator = fixture.coordinator();
        let mut receipt = coordinator.current().unwrap().unwrap();
        if damage == "replace-manifest" {
            let bytes = fs::read(fixture.manifest()).unwrap();
            let directory =
                PrivateDirectory::open_existing(fixture.manifest().parent().unwrap()).unwrap();
            directory
                .atomic_replace(fixture.manifest().file_name().unwrap(), &bytes)
                .unwrap();
        } else {
            receipt
                .owner_receipts
                .get_mut(&format!("copy-{DOMAIN}"))
                .unwrap()["version"] = serde_json::json!(3);
            coordinator.write_receipt(&receipt).unwrap();
        }
        assert!(coordinator.preview_source_cleanup(ID).is_err());
        assert!(
            !coordinator
                .current()
                .unwrap()
                .unwrap()
                .owner_receipts
                .contains_key(OWNER)
        );
        assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    }
}

#[test]
fn read_only_cleanup_refuses_an_unwritten_authorized_suffix_without_repair() {
    let fixture = Fixture::new(false);
    let coordinator = fixture.coordinator();
    let receipt = coordinator.current().unwrap().unwrap();
    let binding = &receipt.owner_receipts[&format!("copy-{DOMAIN}")];
    let offset = binding["pendingAppend"]["offset"].as_u64().unwrap();
    // Keep the original FileID and its authenticated prior prefix. The absent
    // final Verified frame is authorized for recovery, not for read-only repair.
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.manifest())
        .unwrap()
        .set_len(offset)
        .unwrap();
    let before = fs::read(fixture.manifest()).unwrap();
    assert_eq!(
        coordinator
            .preview_source_cleanup(ID)
            .unwrap_err()
            .to_string(),
        "STORAGE_TREE_MANIFEST_UNKNOWN"
    );
    assert_eq!(fs::read(fixture.manifest()).unwrap(), before);
    assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
}

#[test]
fn oversized_unknown_tree_is_opaque_and_does_not_block_known_copy_cleanup() {
    let fixture = Fixture::new(false);
    let unknown = fixture.source.join("new-tree");
    fs::create_dir(&unknown).unwrap();
    for index in 0..=ENTRY_LIMIT {
        fs::write(unknown.join(index.to_string()), b"keep").unwrap();
    }
    let coordinator = fixture.coordinator();
    let before = coordinator.current().unwrap().unwrap();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    assert_eq!(coordinator.current().unwrap().unwrap(), before);
    assert_eq!(status(&preview.entries, "alpha"), Status::EligibleFile);
    assert_eq!(
        status(&preview.entries, "new-tree"),
        Status::RetainedUnknown
    );
    assert!(!preview.entries.iter().any(|entry| {
        entry.relative_path.starts_with("new-tree") && entry.relative_path != Path::new("new-tree")
    }));
    assert!(
        !coordinator
            .current()
            .unwrap()
            .unwrap()
            .owner_receipts
            .contains_key(OWNER)
    );
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(status(&result.entries, "alpha"), Status::Removed);
    assert_eq!(fs::read(unknown.join("0")).unwrap(), b"keep");
    assert_eq!(
        fs::read(unknown.join(ENTRY_LIMIT.to_string())).unwrap(),
        b"keep"
    );
}

#[test]
fn oversized_excluded_tree_is_opaque_and_does_not_block_known_copy_cleanup() {
    let fixture = Fixture::with_extra_files(false, 0, BTreeSet::from([PathBuf::from("nested")]));
    let excluded = fixture.source.join("nested");
    for index in 0..=ENTRY_LIMIT {
        fs::write(excluded.join(index.to_string()), b"excluded cache").unwrap();
    }
    let coordinator = fixture.coordinator();
    let before = coordinator.current().unwrap().unwrap();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    assert_eq!(coordinator.current().unwrap().unwrap(), before);
    assert_eq!(status(&preview.entries, "alpha"), Status::EligibleFile);
    assert_eq!(status(&preview.entries, "nested"), Status::RetainedExcluded);
    assert!(!preview.entries.iter().any(|entry| {
        entry.relative_path.starts_with("nested") && entry.relative_path != Path::new("nested")
    }));
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert_eq!(status(&result.entries, "alpha"), Status::Removed);
    assert_eq!(fs::read(excluded.join("original")).unwrap(), BODY);
    assert_eq!(
        fs::read(excluded.join(ENTRY_LIMIT.to_string())).unwrap(),
        b"excluded cache"
    );
}

#[test]
fn two_thousand_long_path_files_fit_existing_receipt_and_reply_limits() {
    let fixture = Fixture::with_extra_files(false, 2000, BTreeSet::new());
    fs::write(fixture.source.join("unknown-after-copy"), b"keep").unwrap();
    let coordinator = fixture.coordinator();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    let preview_bytes = serde_json::to_vec(&preview).unwrap().len() + 1;
    assert!(preview_bytes > 256 * 1024);
    assert!(preview_bytes <= REPLY_LIMIT);
    assert!(preview.entries.len() < ENTRY_LIMIT);
    assert!(fixture.source.to_string_lossy().len() >= 152);
    // Exercise a persisted pending v2 and its original token before retrying.
    assert!(
        coordinator
            .confirm_source_cleanup_with_hook(ID, &preview.confirmation, |_| {
                anyhow::bail!("interrupted before first deletion")
            })
            .is_err()
    );
    let receipt = coordinator.current().unwrap().unwrap();
    let saved = &receipt.owner_receipts[OWNER];
    assert_eq!(saved["version"], 2);
    assert!(saved["resultStatuses"].is_null());
    assert_eq!(saved["preview"]["sources"].as_array().unwrap().len(), 1);
    assert!(saved["preview"].get("entries").is_none());
    let pending = coordinator.preview_source_cleanup(ID).unwrap();
    assert!(pending.pending);
    assert_eq!(pending.confirmation, preview.confirmation);
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    assert!(serde_json::to_vec(&result).unwrap().len() + 1 <= REPLY_LIMIT);
    assert_eq!(status(&result.entries, "alpha"), Status::Removed);
    assert_eq!(
        status(&result.entries, "unknown-after-copy"),
        Status::RetainedUnknown
    );
    assert_eq!(
        fs::read(fixture.source.join("unknown-after-copy")).unwrap(),
        b"keep"
    );
    let receipt = coordinator.current().unwrap().unwrap();
    assert!(serde_json::to_vec_pretty(&receipt).unwrap().len() as u64 <= RECEIPT_LIMIT);
    assert_eq!(
        receipt.owner_receipts[OWNER]["resultStatuses"]
            .as_array()
            .unwrap()
            .len(),
        result.entries.len()
    );
    fs::rename(
        &fixture.source,
        fixture.owned.path().join("retained-old-source"),
    )
    .unwrap();
    assert_eq!(
        coordinator
            .confirm_source_cleanup(ID, &preview.confirmation)
            .unwrap(),
        result
    );
}

#[test]
fn legacy_v1_pending_and_lost_final_reply_keep_original_token_and_format() {
    let fixture = Fixture::new(false);
    let coordinator = fixture.coordinator();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    let original = CleanupBinding {
        version: 1,
        preview: preview.clone(),
        result: None,
    };
    coordinator
        .record_source_cleanup(ID, None, &original)
        .unwrap();
    let path = fixture.manifest().parent().unwrap().join(RECEIPT);
    let before = fs::read(&path).unwrap();
    let pending = coordinator.preview_source_cleanup(ID).unwrap();
    assert!(pending.pending);
    assert_eq!(pending.confirmation, preview.confirmation);
    assert_eq!(fs::read(&path).unwrap(), before);
    let result = coordinator
        .confirm_source_cleanup(ID, &preview.confirmation)
        .unwrap();
    let final_receipt = coordinator.current().unwrap().unwrap();
    assert_eq!(final_receipt.owner_receipts[OWNER]["version"], 1);
    assert_eq!(
        final_receipt.owner_receipts[OWNER]["result"],
        serde_json::to_value(&result).unwrap()
    );
    fs::rename(
        &fixture.source,
        fixture.owned.path().join("retained-old-source"),
    )
    .unwrap();
    let before = fs::read(&path).unwrap();
    assert_eq!(
        coordinator
            .confirm_source_cleanup(ID, &preview.confirmation)
            .unwrap(),
        result
    );
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn final_receipt_capacity_is_reserved_before_any_removal() {
    for pending in [false, true] {
        let fixture = Fixture::new(false);
        let coordinator = fixture.coordinator();
        let preview = coordinator.preview_source_cleanup(ID).unwrap();
        if pending {
            assert!(
                coordinator
                    .confirm_source_cleanup_with_hook(ID, &preview.confirmation, |_| {
                        anyhow::bail!("interrupted before first deletion")
                    })
                    .is_err()
            );
        }
        let mut receipt = coordinator.current().unwrap().unwrap();
        receipt.owner_receipts.insert(
            "existing-owner".into(),
            serde_json::json!({ "padding": "" }),
        );
        let baseline = serde_json::to_vec_pretty(&receipt).unwrap().len();
        receipt.owner_receipts.get_mut("existing-owner").unwrap()["padding"] =
            serde_json::json!("x".repeat(RECEIPT_LIMIT as usize - baseline - 16));
        coordinator.write_receipt(&receipt).unwrap();
        assert_eq!(
            coordinator
                .confirm_source_cleanup(ID, &preview.confirmation)
                .unwrap_err()
                .to_string(),
            "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
        );
        assert_eq!(coordinator.current().unwrap().unwrap(), receipt);
        assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
    }
}

#[test]
fn longest_result_reply_is_reserved_before_persisting_an_intent() {
    let fixture = Fixture::new(false);
    let coordinator = fixture.coordinator();
    let before = coordinator.current().unwrap().unwrap();
    let mut preview = coordinator.preview_source_cleanup(ID).unwrap();
    let entry = preview
        .entries
        .iter()
        .find(|entry| entry.status == Status::EligibleFile)
        .unwrap()
        .clone();
    preview.entries = (0..200)
        .map(|index| StorageSourceCleanupEntry {
            relative_path: PathBuf::from(format!("row-{index}")),
            ..entry.clone()
        })
        .collect();
    let bytes = serde_json::to_vec(&preview).unwrap().len();
    preview.entries[0].relative_path =
        PathBuf::from(format!("row-0{}", "x".repeat(REPLY_LIMIT - bytes - 2)));
    preview.confirmation = fingerprint(&preview).unwrap();
    assert!(serde_json::to_vec(&preview).unwrap().len() + 1 <= REPLY_LIMIT);
    let mut reserved_entries = preview.entries.clone();
    for entry in &mut reserved_entries {
        entry.status = Status::RetainedUnconfirmed;
    }
    let reserved_reply = StorageSourceCleanupResult {
        operation_id: ID.into(),
        confirmation: preview.confirmation.clone(),
        entries: reserved_entries,
    };
    assert!(serde_json::to_vec(&reserved_reply).unwrap().len() + 1 > REPLY_LIMIT);
    assert_eq!(
        coordinator
            .record_source_cleanup(
                ID,
                None,
                &CleanupBinding {
                    version: 2,
                    preview,
                    result: None
                }
            )
            .unwrap_err()
            .to_string(),
        "STORAGE_SOURCE_CLEANUP_PREVIEW_LIMIT"
    );
    assert_eq!(coordinator.current().unwrap().unwrap(), before);
    assert_eq!(fs::read(fixture.source.join("alpha")).unwrap(), BODY);
}

#[test]
fn original_v1_confirmation_hash_is_unchanged_by_compact_storage() {
    let preview: StorageSourceCleanupPreview = serde_json::from_value(serde_json::json!({
        "operationId": ID,
        "selection": { "version": 1, "revision": 1, "dataRoot": "/new", "cacheRoot": "/cache", "operationId": ID },
        "confirmation": "", "pending": false,
        "entries": [{ "domain": DOMAIN, "sourceRoot": "/old", "relativePath": "alpha",
            "status": "eligibleFile", "sizeBytes": 14, "observedVersion": "a".repeat(64) }]
    })).unwrap();
    assert_eq!(
        fingerprint(&preview).unwrap(),
        "6a0b22842a733d9db70dd58489957bbbe70af3f5671338a52aa3e418a6363b01"
    );
    let encoded = compact::encode(&CleanupBinding {
        version: 2,
        preview: preview.clone(),
        result: None,
    })
    .unwrap();
    assert_eq!(compact::decode(&encoded).unwrap().preview, preview);
}

#[test]
fn compact_result_refuses_missing_or_unknown_statuses() {
    let fixture = Fixture::new(false);
    let coordinator = fixture.coordinator();
    let preview = coordinator.preview_source_cleanup(ID).unwrap();
    let mut value = compact::encode(&CleanupBinding {
        version: 2,
        preview,
        result: None,
    })
    .unwrap();
    value["resultStatuses"] = serde_json::json!([]);
    assert!(compact::decode(&value).is_err());
    value["resultStatuses"] = serde_json::json!(["unknown"]);
    assert!(compact::decode(&value).is_err());
}
