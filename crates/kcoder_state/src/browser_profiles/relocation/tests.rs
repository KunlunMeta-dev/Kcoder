use super::*;
use kcoder_types::integrations::core::IntegrationNullable;
use std::{
    io::Write,
    path::{Path, PathBuf},
};

struct Fixture {
    root: tempfile::TempDir,
    parent_path: PathBuf,
    scope: IntegrationScope,
    store: BrowserProfileStore,
}

impl Fixture {
    fn new() -> Result<Self> {
        let root = tempfile::tempdir()?;
        let parent_path = root.path().join("source-domain");
        let parent = PrivateDirectory::open_or_create(&parent_path)?;
        let scope = IntegrationScope {
            account_id: "original-account".into(),
            target_id: "original-target".into(),
            workspace_id: IntegrationNullable::Null,
            identity_generation: "original-generation".into(),
            target_revision: "original-config".into(),
            organization_id: None,
        };
        let store = BrowserProfileStore::create_in(&parent, OsStr::new("catalog"), &scope)?;
        store.save("create-office", draft("office"), 0)?;
        Ok(Self {
            root,
            parent_path,
            scope,
            store,
        })
    }

    fn released_cookie_use(&self) -> Result<()> {
        let usage =
            self.store
                .begin_use_operation("office", 1, "original-launch", &"a".repeat(64))?;
        let directory = self.store.user_data_directory(&usage)?;
        directory.atomic_replace(OsStr::new("cookie-sentinel"), b"PRIVATE_SYNTHETIC_COOKIE")?;
        let mut receipt = self.store.prepare_cleanup_receipt(&usage)?;
        receipt.write_all(b"kcoder-owned-cleanup/v1\nconfirmed\n")?;
        receipt.sync_all()?;
        assert_eq!(self.store.reconcile_cleanup_receipts()?, 1);
        Ok(())
    }

    fn copy(&self, source_parent: &Path, name: &str) -> Result<(PathBuf, PrivateDirectory)> {
        let path = self.root.path().join(name);
        let parent = PrivateDirectory::open_or_create(&path)?;
        let catalog = parent.create_private_child(OsStr::new("catalog"))?;
        copy_directory(&source_parent.join("catalog"), &catalog)?;
        Ok((path, parent))
    }
}

fn draft(id: &str) -> BrowserAccountProfileDraft {
    BrowserAccountProfileDraft {
        id: id.into(),
        label: "User browser label".into(),
        account_label: None,
        purpose: BrowserProfilePurpose::Business,
    }
}

#[test]
fn prepared_catalog_retains_the_original_writer_lease_across_copy() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.released_cookie_use()?;
    let prepared = fixture.store.prepare_relocation()?;
    assert!(fixture.store.lease(true).is_err());
    let snapshot = prepared.snapshot().clone();
    let (_path, target) = fixture.copy(&fixture.parent_path, "prepared-target")?;
    prepared.verify()?;
    let relocated = prepared.relocate(&target, "prepared-move")?;
    assert_eq!(
        relocated.list(None, true)?.items,
        fixture.store.list(None, true)?.items
    );
    fixture
        .store
        .verify_relocation(&target, "prepared-move", &snapshot)?;
    Ok(())
}

fn copy_directory(source: &Path, destination: &PrivateDirectory) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            let child = destination.create_private_child(&entry.file_name())?;
            copy_directory(&entry.path(), &child)?;
        } else {
            ensure!(kind.is_file(), "unexpected_synthetic_fixture_entry");
            destination.atomic_replace(&entry.file_name(), &std::fs::read(entry.path())?)?;
        }
    }
    Ok(())
}

#[test]
fn relocation_keeps_exact_business_data_and_original_receipts_and_reconciles_lost_ack() -> Result<()>
{
    let f = Fixture::new()?;
    f.released_cookie_use()?;
    f.store.save("create-archived", draft("archived"), 0)?;
    f.store
        .set_archived("archive-original", "archived", 1, true)?;
    let expected = f.store.relocation_snapshot()?;
    let data_before = read(&f.store.directory, DATA, MAX_BYTES)?;
    let profiles = f.store.list(None, true)?;
    let (target_path, target_parent) = f.copy(&f.parent_path, "final-domain")?;
    assert!(BrowserProfileStore::open_in(&target_parent, OsStr::new("catalog"), &f.scope).is_err());
    assert!(
        f.store
            .verify_relocation(&target_parent, "move-original", &expected)
            .is_err()
    );
    let catalog = target_parent.open_child(OsStr::new("catalog"), false)?;
    let unknown = OsStr::new(".profile-owner.json.unknown.prepared");
    catalog.atomic_replace(unknown, b"UNKNOWN_PREPARATION")?;
    // Discarding the result models a lost acknowledgement after atomic publication.
    drop(
        f.store
            .relocate(&target_parent, "move-original", &expected)?,
    );
    let header_before = read(&catalog, HEADER, MAX_BYTES)?;
    let header_identity = catalog.portable_regular_identity(OsStr::new(HEADER))?;
    let target = f
        .store
        .relocate(&target_parent, "move-original", &expected)?;
    f.store
        .verify_relocation(&target_parent, "move-original", &expected)?;
    assert_eq!(read(&target.directory, DATA, MAX_BYTES)?, data_before);
    assert_eq!(read(&f.store.directory, DATA, MAX_BYTES)?, data_before);
    assert_eq!(read(&target.directory, HEADER, MAX_BYTES)?, header_before);
    let mut historical_header = target.header.clone();
    historical_header.lock = f.store.header.lock.clone();
    assert!(historical_header == f.store.header);
    assert!(
        target
            .directory
            .portable_regular_identity(OsStr::new(HEADER))?
            == header_identity
    );
    assert_eq!(target.list(None, true)?.items, profiles.items);
    assert_eq!(
        std::fs::read(target_path.join("catalog").join(unknown))?,
        b"UNKNOWN_PREPARATION"
    );
    // The existing coordinator owns operation admission; the catalog does not
    // append its own relocation receipt or directory-identity mapping.
    f.store
        .verify_relocation(&target_parent, "different-operation", &expected)?;
    assert!(
        target
            .begin_use_operation("office", 1, "original-launch", &"a".repeat(64))
            .is_err()
    );
    let usage = target.begin_use_operation("office", 1, "new-user-action", &"b".repeat(64))?;
    let cookies = target.user_data_directory(&usage)?;
    target.verify_user_data_directory(&usage, &cookies)?;
    assert_eq!(
        std::fs::read(target_path.join("catalog/browser-data-office/cookie-sentinel"))?,
        b"PRIVATE_SYNTHETIC_COOKIE"
    );
    target.finish_use_after_owned_cleanup(&usage)?;
    assert_eq!(
        BrowserProfileStore::open_in(&target_parent, OsStr::new("catalog"), &f.scope)?
            .unwrap()
            .list(None, true)?
            .items,
        target.list(None, true)?.items
    );
    Ok(())
}

#[test]
fn unknown_and_partial_cleanup_receipts_block_until_the_original_owner_settles_them() -> Result<()>
{
    let f = Fixture::new()?;
    let usage = f
        .store
        .begin_use_operation("office", 1, "original-launch", &"a".repeat(64))?;
    assert!(f.store.relocation_snapshot().is_err());
    let mut receipt = f.store.prepare_cleanup_receipt(&usage)?;
    receipt.write_all(b"kcoder-owned-cleanup/v1\n")?;
    receipt.sync_all()?;
    let before = read(&f.store.directory, DATA, MAX_BYTES)?;
    assert!(f.store.relocation_snapshot().is_err());
    assert_eq!(read(&f.store.directory, DATA, MAX_BYTES)?, before);
    assert_eq!(f.store.reconcile_cleanup_receipts()?, 0);
    receipt.write_all(b"confirmed\n")?;
    receipt.sync_all()?;
    // Read-only relocation preflight never performs the host's release transition.
    assert!(f.store.relocation_snapshot().is_err());
    assert_eq!(f.store.reconcile_cleanup_receipts()?, 1);
    let expected = f.store.relocation_snapshot()?;
    let (_, target_parent) = f.copy(&f.parent_path, "target")?;
    let target = f
        .store
        .relocate(&target_parent, "original-move", &expected)?;
    assert!(
        target
            .begin_use_operation("office", 1, "original-launch", &"a".repeat(64))
            .is_err()
    );
    Ok(())
}

#[test]
fn source_revision_or_cookie_directory_change_refuses_conversion_without_repair() -> Result<()> {
    let f = Fixture::new()?;
    let expected = f.store.relocation_snapshot()?;
    let (_, target_parent) = f.copy(&f.parent_path, "target")?;
    let target = target_parent.open_child(OsStr::new("catalog"), false)?;
    let before = read(&target, HEADER, MAX_BYTES)?;
    f.store.set_archived("new-revision", "office", 1, true)?;
    assert!(
        f.store
            .relocate(&target_parent, "migration", &expected)
            .is_err()
    );
    assert_eq!(read(&target, HEADER, MAX_BYTES)?, before);

    let f = Fixture::new()?;
    f.released_cookie_use()?;
    let expected = f.store.relocation_snapshot()?;
    let (_, target_parent) = f.copy(&f.parent_path, "target")?;
    let target = target_parent.open_child(OsStr::new("catalog"), false)?;
    let before = read(&target, HEADER, MAX_BYTES)?;
    std::fs::rename(
        f.parent_path.join("catalog/browser-data-office"),
        f.root.path().join("held-cookies"),
    )?;
    f.store
        .directory
        .create_private_child(OsStr::new("browser-data-office"))?;
    assert!(
        f.store
            .relocate(&target_parent, "migration", &expected)
            .is_err()
    );
    assert_eq!(read(&target, HEADER, MAX_BYTES)?, before);
    Ok(())
}

#[test]
fn source_and_target_owner_leases_block_conversion_and_changed_target_data_is_preserved()
-> Result<()> {
    let f = Fixture::new()?;
    let expected = f.store.relocation_snapshot()?;
    let (_, target_parent) = f.copy(&f.parent_path, "target")?;
    let target = target_parent.open_child(OsStr::new("catalog"), false)?;
    let before = read(&target, HEADER, MAX_BYTES)?;
    let lease = f.store.lease(false)?;
    assert!(
        f.store
            .relocate(&target_parent, "migration", &expected)
            .is_err()
    );
    drop(lease);
    let lock_identity = target.portable_regular_identity(OsStr::new(LOCK))?;
    let lease = target.try_existing_portable_lock(
        OsStr::new(LOCK),
        &lock_identity,
        PrivateLeaseMode::Exclusive,
    )?;
    assert!(lease.is_some());
    assert!(
        f.store
            .relocate(&target_parent, "migration", &expected)
            .is_err()
    );
    drop(lease);
    target.atomic_replace(OsStr::new(DATA), b"{\"unknown\":true}")?;
    assert!(
        f.store
            .relocate(&target_parent, "migration", &expected)
            .is_err()
    );
    assert_eq!(read(&target, HEADER, MAX_BYTES)?, before);
    assert_eq!(read(&target, DATA, MAX_BYTES)?, b"{\"unknown\":true}");
    Ok(())
}

#[test]
fn active_cookie_replacement_is_rejected_without_a_permanent_directory_map() -> Result<()> {
    let f = Fixture::new()?;
    f.released_cookie_use()?;
    let expected = f.store.relocation_snapshot()?;
    let (path, target_parent) = f.copy(&f.parent_path, "target")?;
    let target = f
        .store
        .relocate(&target_parent, "original-move", &expected)?;
    let usage = target.begin_use("office", 1)?;
    let original = target.user_data_directory(&usage)?;
    std::fs::rename(
        path.join("catalog/browser-data-office"),
        f.root.path().join("held-target-cookies"),
    )?;
    target
        .directory
        .create_private_child(OsStr::new("browser-data-office"))?;
    assert!(
        f.store
            .verify_relocation(&target_parent, "original-move", &expected)
            .is_err()
    );
    assert!(
        f.store
            .relocate(&target_parent, "original-move", &expected)
            .is_err()
    );
    assert!(target.user_data_directory(&usage).is_err());
    assert!(
        target
            .verify_user_data_directory(&usage, &original)
            .is_err()
    );
    Ok(())
}

#[test]
fn second_relocation_preserves_records_without_creating_cookie_identity_maps() -> Result<()> {
    let f = Fixture::new()?;
    f.released_cookie_use()?;
    let expected = f.store.relocation_snapshot()?;
    let (first_path, first_parent) = f.copy(&f.parent_path, "first-target")?;
    let first = f.store.relocate(&first_parent, "first-move", &expected)?;
    let expected = first.relocation_snapshot()?;
    let (second_path, second_parent) = f.copy(&first_path, "second-target")?;
    let second = first.relocate(&second_parent, "second-move", &expected)?;
    assert_eq!(
        read(&second.directory, DATA, MAX_BYTES)?,
        read(&f.store.directory, DATA, MAX_BYTES)?
    );
    assert!(second.header.owner == f.store.header.owner);
    let mut historical_header = second.header.clone();
    historical_header.lock = f.store.header.lock.clone();
    assert!(historical_header == f.store.header);
    let cold =
        BrowserProfileStore::open_in(&second_parent, OsStr::new("catalog"), &f.scope)?.unwrap();
    assert!(cold.header.relocation.is_none());
    let usage = second.begin_use("office", 1)?;
    second.user_data_directory(&usage)?;
    assert_eq!(
        std::fs::read(second_path.join("catalog/browser-data-office/cookie-sentinel"))?,
        b"PRIVATE_SYNTHETIC_COOKIE"
    );
    assert_eq!(
        first.list(None, true)?.items,
        f.store.list(None, true)?.items
    );
    Ok(())
}

#[test]
fn inactive_cookie_placement_is_observed_once_per_new_use_and_live_handles_remain_pinned()
-> Result<()> {
    let f = Fixture::new()?;
    f.released_cookie_use()?;
    let cookies = f.parent_path.join("catalog/browser-data-office");
    std::fs::rename(&cookies, f.root.path().join("old-cookies"))?;
    f.store
        .directory
        .create_private_child(OsStr::new("browser-data-office"))?;
    let before = read(&f.store.directory, DATA, MAX_BYTES)?;
    let parent = PrivateDirectory::open_existing(&f.parent_path)?;
    let cold = BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &f.scope)?.unwrap();
    assert_eq!(read(&cold.directory, DATA, MAX_BYTES)?, before);
    let usage = cold.begin_use("office", 1)?;
    let handle = cold.user_data_directory(&usage)?;
    cold.verify_user_data_directory(&usage, &handle)?;
    std::fs::rename(&cookies, f.root.path().join("active-cookies"))?;
    cold.directory
        .create_private_child(OsStr::new("browser-data-office"))?;
    assert!(cold.verify_user_data_directory(&usage, &handle).is_err());
    assert!(cold.user_data_directory(&usage).is_err());
    Ok(())
}

#[test]
fn catalog_directory_move_preserves_header_but_not_a_stale_observers_path() -> Result<()> {
    let f = Fixture::new()?;
    let parent = PrivateDirectory::open_or_create(&f.root.path().join("moved-domain"))?;
    std::fs::rename(
        f.parent_path.join("catalog"),
        f.root.path().join("moved-domain/catalog"),
    )?;
    assert!(f.store.list(None, true).is_err());
    let cold = BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &f.scope)?.unwrap();
    assert!(cold.header == f.store.header);
    assert_eq!(cold.list(None, true)?.items.len(), 1);
    cold.directory.atomic_replace(OsStr::new(LOCK), b"")?;
    assert!(cold.list(None, true).is_err());
    assert!(BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &f.scope).is_err());
    Ok(())
}

#[test]
fn legacy_v2_cookie_maps_are_readable_history_and_are_not_extended_on_later_moves() -> Result<()> {
    let f = Fixture::new()?;
    f.released_cookie_use()?;
    let mut source = f.store.relocation_snapshot()?;
    source.directory_identity = "legacy-source-directory".into();
    let data = f.store.read_data()?;
    let mut header = f.store.header.clone();
    header.version = 2;
    header.relocation = Some(RelocationReceipt {
        operation_id: "legacy-move".into(),
        source,
        data_directories: data
            .data_directories
            .iter()
            .map(|(id, recorded)| {
                (
                    id.clone(),
                    RelocatedDirectory {
                        recorded_identity: recorded.clone(),
                        target_identity: "legacy-cookie-placement".into(),
                    },
                )
            })
            .collect(),
    });
    f.store
        .directory
        .atomic_replace(OsStr::new(HEADER), &serde_json::to_vec(&header)?)?;
    let parent = PrivateDirectory::open_existing(&f.parent_path)?;
    let legacy = BrowserProfileStore::open_in(&parent, OsStr::new("catalog"), &f.scope)?.unwrap();
    let expected = legacy.relocation_snapshot()?;
    let (first_path, first_parent) = f.copy(&f.parent_path, "first-target")?;
    let first = legacy.relocate(&first_parent, "first-move", &expected)?;
    let expected = first.relocation_snapshot()?;
    let (_, second_parent) = f.copy(&first_path, "second-target")?;
    let second = first.relocate(&second_parent, "second-move", &expected)?;
    let mut observed = second.header.clone();
    observed.lock = header.lock.clone();
    assert!(observed == header);
    let usage = second.begin_use("office", 1)?;
    let directory = second.user_data_directory(&usage)?;
    second.verify_user_data_directory(&usage, &directory)?;
    Ok(())
}
