use super::*;

const NAME: &str = "kcoder-storage-writers.lock";

#[test]
fn held_scope_identity_reads_actual_ancestors_without_reading_or_creating_source_leaves()
-> Result<()> {
    let owned = tempfile::tempdir()?;
    let path = owned.path().join("Parent/Child");
    std::fs::create_dir_all(&path)?;
    let lease = held(StorageLease::acquire(&path, NAME, Mode::Shared, false)?);
    let root = PrivateDirectory::open_existing(&path)?;
    root.atomic_replace(OsStr::new("kcoder-storage-retired-native.json"), &[255])?;
    let observed: serde_json::Value = serde_json::from_str(&lease.source_retirement("identity")?)?;
    assert_eq!(observed["rootIdentity"], root.directory_identity()?);
    for path in path.ancestors() {
        assert!(
            observed["ancestorIdentities"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!(
                    PrivateDirectory::open_existing(path)?.directory_identity()?
                ))
        );
    }
    assert!(observed["marker"].is_null());
    assert_eq!(std::fs::read_dir(&path)?.count(), 2);
    assert_eq!(
        std::fs::read(path.join("kcoder-storage-retired-native.json"))?,
        [255]
    );
    let gate = held(StorageLease::acquire(
        owned.path(),
        "kcoder-storage.lock",
        Mode::Shared,
        false,
    )?);
    assert!(gate.source_retirement("identity").is_err());
    Ok(())
}

#[test]
fn source_retirement_reads_only_fixed_leaves_under_the_original_live_root() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let lease = held(StorageLease::acquire(
        owned.path(),
        NAME,
        Mode::Shared,
        false,
    )?);
    let empty: serde_json::Value = serde_json::from_str(&lease.source_retirement("native")?)?;
    assert!(empty["marker"].is_null());
    assert_eq!(std::fs::read_dir(owned.path())?.count(), 1);
    let root = PrivateDirectory::open_existing(owned.path())?;
    let name = OsStr::new("kcoder-storage-retired-native.json");
    root.atomic_replace(name, br#"{"originalOperation":"owned"}"#)?;
    let observed: serde_json::Value = serde_json::from_str(&lease.source_retirement("native")?)?;
    assert_eq!(observed["rootIdentity"], root.directory_identity()?);
    assert_eq!(
        observed["marker"]["text"],
        r#"{"originalOperation":"owned"}"#
    );
    let expected = PortableLeaseIdentity::from_private_regular_handle(
        &root.open_single_link_regular_file(name)?,
    )?;
    assert_eq!(
        observed["marker"]["identity"],
        serde_json::to_string(&expected)?
    );
    for role in [
        "../credentials.json",
        "credentials",
        "control",
        "",
        "native:stream",
    ] {
        assert!(lease.source_retirement(role).is_err());
    }
    let gate = held(StorageLease::acquire(
        owned.path(),
        "kcoder-storage.lock",
        Mode::Shared,
        false,
    )?);
    assert!(gate.source_retirement("native").is_err());
    let control: serde_json::Value = serde_json::from_str(&gate.source_retirement("control")?)?;
    assert_eq!(control["rootIdentity"], root.directory_identity()?);
    assert!(control["marker"].is_null());
    Ok(())
}

#[test]
fn source_retirement_reads_are_bounded_and_do_not_repair_invalid_leaves() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let lease = held(StorageLease::acquire(
        owned.path(),
        NAME,
        Mode::Shared,
        false,
    )?);
    let root = PrivateDirectory::open_existing(owned.path())?;
    let name = OsStr::new("kcoder-storage-retired-native.json");
    root.atomic_replace(name, &vec![b'x'; 32 * 1024 + 1])?;
    assert!(lease.source_retirement("native").is_err());
    assert_eq!(std::fs::read(owned.path().join(name))?.len(), 32 * 1024 + 1);
    root.atomic_replace(name, &[255])?;
    assert!(lease.source_retirement("native").is_err());
    assert_eq!(std::fs::read(owned.path().join(name))?, vec![255]);
    Ok(())
}

#[test]
fn reserved_storage_lock_names_do_not_adopt_nonempty_user_payloads() -> Result<()> {
    for name in [NAME, "kcoder-storage.lock", "kcoder-storage-instances.lock"] {
        let owned = tempfile::tempdir()?;
        let root = PrivateDirectory::open_existing(owned.path())?;
        root.atomic_replace(OsStr::new(name), b"preserve unknown private data")?;
        for mode in [Mode::Shared, Mode::Exclusive, Mode::SharedExisting] {
            assert!(StorageLease::acquire(owned.path(), name, mode, false).is_err());
            assert_eq!(
                std::fs::read(owned.path().join(name))?,
                b"preserve unknown private data"
            );
        }
    }
    Ok(())
}

fn held(acquired: Acquisition) -> StorageLease {
    match acquired {
        Acquisition::Held(lease) => lease,
        _ => panic!("expected an actual held kernel lease"),
    }
}

#[test]
fn shared_holders_and_existing_rust_fs_calls_use_the_same_kernel_lock() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let first = held(StorageLease::acquire(
        owned.path(),
        NAME,
        Mode::Shared,
        false,
    )?);
    let second = held(StorageLease::acquire(
        owned.path(),
        NAME,
        Mode::SharedExisting,
        false,
    )?);
    let rust = PrivateDirectory::open_existing(owned.path())?;
    assert!(rust.try_exclusive_lock(OsStr::new(NAME))?.is_none());
    drop(first);
    assert!(rust.try_exclusive_lock(OsStr::new(NAME))?.is_none());
    second.verify()?;
    drop(second);
    let exclusive = rust.try_exclusive_lock(OsStr::new(NAME))?.unwrap();
    assert!(matches!(
        StorageLease::acquire(owned.path(), NAME, Mode::SharedExisting, false)?,
        Acquisition::Busy
    ));
    drop(exclusive);
    held(StorageLease::acquire(
        owned.path(),
        NAME,
        Mode::Exclusive,
        false,
    )?)
    .verify()?;
    Ok(())
}

#[test]
fn existing_observation_distinguishes_missing_from_busy_without_creating_files() -> Result<()> {
    let owned = tempfile::tempdir()?;
    let missing_root = owned.path().join("absent");
    assert!(matches!(
        StorageLease::acquire(&missing_root, NAME, Mode::SharedExisting, false)?,
        Acquisition::Missing
    ));
    assert!(!missing_root.exists());
    assert!(matches!(
        StorageLease::acquire(owned.path(), NAME, Mode::SharedExisting, false)?,
        Acquisition::Missing
    ));
    assert_eq!(std::fs::read_dir(owned.path())?.count(), 0);
    assert!(StorageLease::acquire(&missing_root, NAME, Mode::Shared, false).is_err());
    assert!(!missing_root.exists());
    let lease = held(StorageLease::acquire(
        &missing_root,
        NAME,
        Mode::Exclusive,
        true,
    )?);
    lease.verify()?;
    assert!(matches!(
        StorageLease::acquire(&missing_root, NAME, Mode::SharedExisting, false)?,
        Acquisition::Busy
    ));
    Ok(())
}

#[test]
fn only_the_fixed_single_component_storage_lock_names_are_accepted() -> Result<()> {
    let owned = tempfile::tempdir()?;
    for name in [
        "credentials.json.lock",
        "../kcoder-storage.lock",
        "a/kcoder-storage.lock",
        "",
        "kcoder-storage.lock:stream",
    ] {
        assert!(StorageLease::acquire(owned.path(), name, Mode::Shared, false).is_err());
    }
    assert!(StorageLease::acquire(Path::new("relative"), NAME, Mode::Shared, true).is_err());
    assert_eq!(std::fs::read_dir(owned.path())?.count(), 0);
    Ok(())
}

#[cfg(unix)]
#[test]
fn replaced_root_or_identical_replacement_file_invalidates_the_held_lease() -> Result<()> {
    for replace_root in [false, true] {
        let owned = tempfile::tempdir()?;
        let parent = PrivateDirectory::open_existing(owned.path())?;
        parent.create_private_child(OsStr::new("root"))?;
        let root = owned.path().join("root");
        let lease = held(StorageLease::acquire(&root, NAME, Mode::Shared, false)?);
        if replace_root {
            std::fs::rename(&root, owned.path().join("original"))?;
            parent.create_private_child(OsStr::new("root"))?;
        } else {
            lease.directory.atomic_replace(OsStr::new(NAME), b"")?;
        }
        assert!(lease.verify().is_err());
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlink_or_hardlink_alias_is_never_accepted_as_a_storage_lock() -> Result<()> {
    use std::os::unix::fs::symlink;
    for link in ["symlink", "hardlink"] {
        let owned = tempfile::tempdir()?;
        let root = PrivateDirectory::open_existing(owned.path())?;
        let original = root.open_read_write_file(OsStr::new("original"), true)?;
        drop(original);
        if link == "symlink" {
            symlink("original", owned.path().join(NAME))?;
        } else {
            std::fs::hard_link(owned.path().join("original"), owned.path().join(NAME))?;
        }
        assert!(StorageLease::acquire(owned.path(), NAME, Mode::SharedExisting, false).is_err());
        assert_eq!(std::fs::read(owned.path().join("original"))?, b"");
    }
    Ok(())
}
