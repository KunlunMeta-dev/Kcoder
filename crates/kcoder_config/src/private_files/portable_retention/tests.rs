use super::*;
use std::cell::RefCell;
thread_local! {
    static BEFORE_MUTATION: RefCell<Option<Box<dyn FnOnce()>>> = const {RefCell::new(None)};
}
pub(super) fn before_mutation() {
    BEFORE_MUTATION.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook()
        }
    });
}
fn fixture() -> Result<(tempfile::TempDir, PrivateDirectory)> {
    let temp = tempfile::tempdir()?;
    let dir = PrivateDirectory::open_or_create(temp.path())?;
    Ok((temp, dir))
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn portable_retention_removes_only_original_quarantined_leaves_and_verified_empty_directories()
-> Result<()> {
    let (temp, parent) = fixture()?;
    let child = parent.create_private_child(OsStr::new("original"))?;
    child.atomic_replace(OsStr::new("payload"), b"owned")?;
    let directory = child.portable_retention_identity()?;
    let leaf = child.portable_retention_regular_identity(OsStr::new("payload"))?;
    #[cfg(target_os = "linux")]
    assert_eq!(
        parent.portable_retention_filesystem_supported()?,
        parent.retention_filesystem_supported()?
    );
    parent.portable_quarantine_verified_entry(
        OsStr::new("original"),
        &directory,
        OsStr::new("quarantine"),
    )?;
    assert!(!temp.path().join("original").exists());
    assert!(
        parent
            .portable_remove_verified_empty_directory(OsStr::new("quarantine"), &directory)
            .is_err()
    );
    let moved = parent.portable_open_verified_child(OsStr::new("quarantine"), &directory)?;
    let removed = moved.portable_remove_verified_regular_leaf(OsStr::new("payload"), &leaf)?;
    assert_eq!(removed.removed, [std::ffi::OsString::from("payload")]);
    assert!(removed.failure.is_none());
    parent.portable_remove_verified_empty_directory(OsStr::new("quarantine"), &directory)?;
    assert!(!temp.path().join("quarantine").exists());
    Ok(())
}

#[cfg(any(target_os = "linux", windows))]
#[test]
fn portable_retention_preserves_replacements_and_occupied_destinations() -> Result<()> {
    let (temp, parent) = fixture()?;
    parent.atomic_replace(OsStr::new("leaf"), b"original")?;
    let leaf = parent.portable_retention_regular_identity(OsStr::new("leaf"))?;
    parent.atomic_replace(OsStr::new("occupied"), b"foreign")?;
    assert!(
        parent
            .portable_quarantine_verified_entry(OsStr::new("leaf"), &leaf, OsStr::new("occupied"))
            .is_err()
    );
    assert_eq!(std::fs::read(temp.path().join("occupied"))?, b"foreign");
    let replace = parent.duplicate_handle()?;
    BEFORE_MUTATION.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            replace
                .rename_no_replace(OsStr::new("leaf"), OsStr::new("retained"))
                .unwrap();
            replace
                .atomic_replace(OsStr::new("leaf"), b"replacement")
                .unwrap();
        }))
    });
    assert!(
        parent
            .portable_remove_verified_regular_leaf(OsStr::new("leaf"), &leaf)
            .is_err()
    );
    assert_eq!(std::fs::read(temp.path().join("leaf"))?, b"replacement");
    assert_eq!(std::fs::read(temp.path().join("retained"))?, b"original");
    Ok(())
}

#[cfg(target_os = "linux")]
#[test]
fn portable_linux_identity_preserves_old_native_json_and_rejects_links_or_permissions() -> Result<()>
{
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (temp, parent) = fixture()?;
    parent.atomic_replace(OsStr::new("leaf"), b"owned")?;
    let identity = parent.portable_retention_regular_identity(OsStr::new("leaf"))?;
    assert_eq!(
        serde_json::to_value(&identity)?,
        serde_json::to_value(parent.retention_regular_identity(OsStr::new("leaf"))?)?
    );
    let directory = parent.portable_retention_identity()?;
    assert_eq!(
        serde_json::to_value(directory)?,
        serde_json::to_value(parent.retention_identity()?)?
    );
    std::fs::hard_link(temp.path().join("leaf"), temp.path().join("hard"))?;
    assert!(
        parent
            .portable_remove_verified_regular_leaf(OsStr::new("leaf"), &identity)
            .is_err()
    );
    std::fs::remove_file(temp.path().join("hard"))?;
    symlink("leaf", temp.path().join("link"))?;
    assert!(
        parent
            .portable_retention_regular_identity(OsStr::new("link"))
            .is_err()
    );
    std::fs::set_permissions(
        temp.path().join("leaf"),
        std::fs::Permissions::from_mode(0o644),
    )?;
    assert!(
        parent
            .portable_remove_verified_regular_leaf(OsStr::new("leaf"), &identity)
            .is_err()
    );
    assert_eq!(
        std::fs::metadata(temp.path().join("leaf"))?
            .permissions()
            .mode()
            & 0o777,
        0o644
    );
    Ok(())
}

#[cfg(windows)]
#[test]
fn portable_windows_readonly_is_not_overridden_by_retention() -> Result<()> {
    let (temp, parent) = fixture()?;
    parent.atomic_replace(OsStr::new("leaf"), b"owned")?;
    let identity = parent.portable_retention_regular_identity(OsStr::new("leaf"))?;
    let path = temp.path().join("leaf");
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions)?;
    assert!(
        parent
            .portable_remove_verified_regular_leaf(OsStr::new("leaf"), &identity)
            .is_err()
    );
    assert!(path.exists());
    let mut permissions = std::fs::metadata(&path)?.permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&path, permissions)?;
    Ok(())
}
