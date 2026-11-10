use super::*;
use std::os::windows::{
    fs::{MetadataExt, OpenOptionsExt},
    process::CommandExt,
};

#[test]
fn complete_name_inventory_is_bounded_without_following_children() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("first"), b"a").unwrap();
    std::fs::write(root.path().join("second"), b"b").unwrap();
    let pin = ReadOnlyDirectoryPin::open_existing(root.path()).unwrap();
    assert!(pin.names_bounded(1).is_err());
    assert_eq!(pin.names_bounded(2).unwrap().len(), 2);
}

#[test]
fn pinned_leaf_blocks_write_rename_and_keeps_peer_pin() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("resource");
    std::fs::write(&path, b"sealed").unwrap();
    let directory = ReadOnlyDirectoryPin::open_existing(root.path()).unwrap();
    let first = directory.open_file(OsStr::new("resource")).unwrap();
    let peer = directory.open_file(OsStr::new("resource")).unwrap();
    assert!(std::fs::write(&path, b"changed").is_err());
    assert!(std::fs::rename(&path, root.path().join("renamed")).is_err());
    drop(first);
    assert!(std::fs::write(&path, b"changed").is_err());
    peer.verify_unchanged().unwrap();
    drop(peer);
    std::fs::write(&path, b"changed").unwrap();
}

#[test]
fn preexisting_writer_and_hardlink_alias_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("resource");
    std::fs::write(&path, b"sealed").unwrap();
    let directory = ReadOnlyDirectoryPin::open_existing(root.path()).unwrap();
    let writer = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(
            windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE
                | windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE,
        )
        .open(&path)
        .unwrap();
    assert!(directory.open_file(OsStr::new("resource")).is_err());
    drop(writer);
    let outside = tempfile::tempdir().unwrap();
    std::fs::hard_link(&path, outside.path().join("alias")).unwrap();
    assert!(directory.open_file(OsStr::new("resource")).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"sealed");
}

#[test]
fn original_parent_components_remain_pinned_after_dotdot_normalization() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    let runtime = root.path().join("runtime");
    std::fs::create_dir(&bin).unwrap();
    std::fs::create_dir(&runtime).unwrap();
    let pin = ReadOnlyDirectoryPin::open_existing(&bin.join("../runtime")).unwrap();
    assert_eq!(pin.path(), runtime.canonicalize().unwrap());
    assert!(std::fs::rename(&bin, root.path().join("moved-bin")).is_err());
    assert!(std::fs::rename(&runtime, root.path().join("moved-runtime")).is_err());
    drop(pin);
    std::fs::rename(&bin, root.path().join("moved-bin")).unwrap();
}

#[test]
fn ambiguous_leaf_names_and_device_namespace_are_rejected() {
    let root = tempfile::tempdir().unwrap();
    let pin = ReadOnlyDirectoryPin::open_existing(root.path()).unwrap();
    for name in [
        "../outside",
        "a/b",
        "a\\b",
        "a:b",
        "CON",
        "nul.txt",
        "trail.",
        "trail ",
    ] {
        assert!(pin.open_file(OsStr::new(name)).is_err(), "{name}");
        assert!(pin.open_child(OsStr::new(name)).is_err(), "{name}");
    }
    assert!(ReadOnlyDirectoryPin::open_existing(Path::new(r"\\.\C:\resource")).is_err());
}

#[test]
fn symlink_leaf_and_junction_ancestor_are_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("target");
    std::fs::write(&target, b"outside").unwrap();
    std::os::windows::fs::symlink_file(&target, root.path().join("linked"))
        .expect("UNMET_PREREQUISITE: this exact native test needs symlink creation privilege");
    let junction = root.path().join("junction");
    for path in [junction.as_path(), outside.path()] {
        assert!(
            path.to_str()
                .is_some_and(|text| { !text.contains(['\0', '\r', '\n', '"', '%']) }),
            "Owned junction path contains unsupported cmd characters"
        );
    }
    let command = format!(
        "mklink /J \"{}\" \"{}\"",
        junction.display(),
        outside.path().display()
    );
    // cmd consumes a shell command, not a CRT-escaped argument. Keep the
    // command's path quotes intact inside cmd's required outer quote pair.
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/S", "/V:OFF", "/C"])
        .raw_arg(format!("\"{command}\""))
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "Owned junction command could not start: kind={:?} os_code={:?}",
                error.kind(),
                error.raw_os_error()
            )
        });
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    let stderr_class = if stderr.is_empty() {
        "empty"
    } else if stderr.contains("the syntax of the command is incorrect")
        || stderr.contains("the filename, directory name, or volume label syntax is incorrect")
    {
        "command_syntax"
    } else if stderr.contains("access is denied")
        || stderr.contains("you do not have sufficient privilege")
    {
        "access_or_privilege"
    } else if stderr.contains("already exists") {
        "already_exists"
    } else {
        "nonempty_unclassified"
    };
    eprintln!(
        "owned_junction_fixture exit_code={:?} stderr_class={stderr_class}",
        output.status.code()
    );
    assert!(
        output.status.success(),
        "Owned junction fixture must be available: exit_code={:?} stderr_class={stderr_class}",
        output.status.code()
    );
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    let attributes = std::fs::symlink_metadata(&junction)
        .expect("Owned junction entry must exist")
        .file_attributes();
    let expected = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT;
    assert_eq!(
        attributes & expected,
        expected,
        "Owned junction must be an actual directory reparse point"
    );
    let canonical = |path: &Path| {
        path.canonicalize().unwrap_or_else(|error| {
            panic!(
                "Owned junction target inspection failed: kind={:?} os_code={:?}",
                error.kind(),
                error.raw_os_error()
            )
        })
    };
    assert!(
        canonical(&junction) == canonical(outside.path()),
        "Owned junction must resolve to the exact fixture target"
    );
    let pin = ReadOnlyDirectoryPin::open_existing(root.path()).unwrap();
    assert!(pin.open_file(OsStr::new("linked")).is_err());
    assert!(pin.open_child(OsStr::new("junction")).is_err());
    assert!(ReadOnlyDirectoryPin::open_existing(&junction.join("../target")).is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"outside");
}
