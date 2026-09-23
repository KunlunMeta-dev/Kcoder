use super::*;

#[test]
fn positional_file_open_preserves_bytes_and_requires_explicit_creation() {
    use std::io::{Read, Seek, SeekFrom};
    let root = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    let name = OsStr::new("index.db");
    assert!(directory.open_read_write_file(name, false).is_err());
    assert!(!root.path().join(name).exists());
    let mut created = directory.open_read_write_file(name, true).unwrap();
    created.write_all(b"abcdef").unwrap();
    created.sync_all().unwrap();
    drop(created);
    assert!(directory.open_read_write_file(name, true).is_err());
    let mut reopened = directory.open_read_write_file(name, false).unwrap();
    reopened.seek(SeekFrom::Start(2)).unwrap();
    reopened.write_all(b"XY").unwrap();
    reopened.rewind().unwrap();
    let mut bytes = Vec::new();
    reopened.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"abXYef");
    for invalid in ["", ".", "..", "child/file"] {
        assert!(
            directory
                .open_read_write_file(OsStr::new(invalid), true)
                .is_err()
        );
    }
}

#[cfg(unix)]
#[test]
fn positional_file_open_is_rooted_and_rejects_links() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let active = root.path().join("active");
    let parked = root.path().join("parked");
    let outside = root.path().join("outside");
    std::fs::create_dir(&active).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let directory = PrivateDirectory::open_existing(&active).unwrap();
    std::fs::rename(&active, &parked).unwrap();
    symlink(&outside, &active).unwrap();
    let mut file = directory
        .open_read_write_file(OsStr::new("data"), true)
        .unwrap();
    file.write_all(b"inside").unwrap();
    drop(file);
    assert_eq!(std::fs::read(parked.join("data")).unwrap(), b"inside");
    assert!(!outside.join("data").exists());
    assert_eq!(
        std::fs::metadata(parked.join("data"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    symlink(parked.join("data"), parked.join("link")).unwrap();
    std::fs::hard_link(parked.join("data"), parked.join("hard")).unwrap();
    for name in ["link", "hard"] {
        assert!(
            directory
                .open_read_write_file(OsStr::new(name), false)
                .is_err()
        );
    }
}

#[test]
fn open_child_creates_only_when_requested_and_reopens_existing_directory() {
    let root = tempfile::tempdir().unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();
    assert!(private.open_child(OsStr::new("child"), false).is_err());
    assert!(!root.path().join("child").exists());
    let child = private.open_child(OsStr::new("child"), true).unwrap();
    child.append(OsStr::new("content"), b"kept").unwrap();
    let reopened = private.open_child(OsStr::new("child"), false).unwrap();
    reopened.remove_regular_file(OsStr::new("content")).unwrap();
    assert!(!root.path().join("child/content").exists());
}

#[test]
fn open_child_rejects_links_files_and_non_leaf_names() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file"), b"unchanged").unwrap();
    create_directory_symlink(outside.path(), &root.path().join("link")).unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();
    for create_missing in [false, true] {
        for name in ["link", "file", "", ".", "..", "nested/child"] {
            assert!(
                private
                    .open_child(OsStr::new(name), create_missing)
                    .is_err(),
                "{name}"
            );
        }
    }
    assert_eq!(
        std::fs::read(root.path().join("file")).unwrap(),
        b"unchanged"
    );
    assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn open_child_uses_parent_handle_and_preserves_existing_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let active = root.path().join("active");
    let parked = root.path().join("parked");
    let outside = root.path().join("outside");
    std::fs::create_dir_all(active.join("existing")).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::set_permissions(
        active.join("existing"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let private = PrivateDirectory::open_existing(&active).unwrap();
    std::fs::rename(&active, &parked).unwrap();
    symlink(&outside, &active).unwrap();
    private.open_child(OsStr::new("existing"), true).unwrap();
    let child = private.open_child(OsStr::new("created"), true).unwrap();
    child.append(OsStr::new("content"), b"private").unwrap();
    assert_eq!(
        std::fs::read(parked.join("created/content")).unwrap(),
        b"private"
    );
    assert!(!outside.join("created").exists());
    assert_eq!(
        std::fs::metadata(parked.join("existing"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    assert_eq!(
        std::fs::metadata(parked.join("created"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn remove_regular_file_deletes_only_the_named_file() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("target.jsonl"), b"target").unwrap();
    std::fs::write(root.path().join("keep.jsonl"), b"keep").unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();

    private
        .remove_regular_file(OsStr::new("target.jsonl"))
        .unwrap();

    assert!(!root.path().join("target.jsonl").exists());
    assert_eq!(
        std::fs::read(root.path().join("keep.jsonl")).unwrap(),
        b"keep"
    );
    assert!(
        private
            .remove_regular_file(OsStr::new("missing.jsonl"))
            .is_err()
    );
}

#[test]
fn remove_regular_file_rejects_directories_and_non_leaf_names() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("directory")).unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();
    for name in ["directory", "", ".", "..", "directory/child"] {
        assert!(
            private.remove_regular_file(OsStr::new(name)).is_err(),
            "{name}"
        );
    }
    assert!(root.path().join("directory").is_dir());
}

#[cfg(unix)]
#[test]
fn remove_regular_file_rejects_symlinks_and_sockets() {
    use std::os::unix::{fs::symlink, net::UnixListener};
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("outside");
    std::fs::write(&target, b"untouched").unwrap();
    symlink(&target, root.path().join("link")).unwrap();
    let _socket = UnixListener::bind(root.path().join("socket")).unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();
    assert!(private.remove_regular_file(OsStr::new("link")).is_err());
    assert!(private.remove_regular_file(OsStr::new("socket")).is_err());
    assert!(
        root.path()
            .join("link")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(root.path().join("socket").exists());
    assert_eq!(std::fs::read(target).unwrap(), b"untouched");
}

#[cfg(unix)]
#[test]
fn remove_regular_file_keeps_parent_handle_and_permissions() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let active = root.path().join("active");
    let parked = root.path().join("parked");
    let outside = root.path().join("outside");
    std::fs::create_dir(&active).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::set_permissions(&active, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(active.join("target"), b"remove").unwrap();
    std::fs::write(outside.join("target"), b"keep").unwrap();
    let private = PrivateDirectory::open_existing(&active).unwrap();
    std::fs::rename(&active, &parked).unwrap();
    symlink(&outside, &active).unwrap();

    private.remove_regular_file(OsStr::new("target")).unwrap();

    assert!(!parked.join("target").exists());
    assert_eq!(std::fs::read(outside.join("target")).unwrap(), b"keep");
    assert_eq!(
        std::fs::metadata(parked).unwrap().permissions().mode() & 0o777,
        0o755
    );
}

#[cfg(unix)]
#[test]
fn remove_regular_file_reports_parent_sync_failure_after_unlink() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("target"), b"remove").unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();
    UNIX_TEST_FAILURE_POINT.with(|failure| failure.set(UnixFailurePoint::DirectorySynced as u8));
    let error = private
        .remove_regular_file(OsStr::new("target"))
        .unwrap_err();
    assert!(format!("{error:#}").contains("DirectorySynced"));
    assert!(!root.path().join("target").exists());
}

#[cfg(windows)]
#[test]
fn remove_regular_file_rejects_reparse_points_and_readonly_files() {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("target");
    std::fs::write(&target, b"untouched").unwrap();
    symlink_file(&target, root.path().join("link")).unwrap();
    symlink_dir(outside.path(), root.path().join("linked-dir")).unwrap();
    let readonly = root.path().join("readonly");
    std::fs::write(&readonly, b"readonly").unwrap();
    let mut permissions = std::fs::metadata(&readonly).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&readonly, permissions).unwrap();
    let private = PrivateDirectory::open_existing(root.path()).unwrap();
    for name in ["link", "linked-dir", "readonly"] {
        assert!(
            private.remove_regular_file(OsStr::new(name)).is_err(),
            "{name}"
        );
    }
    assert!(root.path().join("link").symlink_metadata().is_ok());
    assert!(root.path().join("linked-dir").symlink_metadata().is_ok());
    assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    assert_eq!(std::fs::read(&readonly).unwrap(), b"readonly");
    let mut permissions = std::fs::metadata(&readonly).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&readonly, permissions).unwrap();
}

fn ensure_private_artifact_directory(path: &Path) -> Result<()> {
    PrivateDirectory::open_or_create(path)?;
    Ok(())
}

fn write_private_artifact_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("artifact file has no parent")?;
    let name = path.file_name().context("artifact file has no name")?;
    PrivateDirectory::open_or_create(parent)?.atomic_replace(name, bytes)
}

#[test]
fn append_preserves_existing_bytes_and_private_mode() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = PrivateDirectory::open_or_create(&directory).unwrap();

    private.append(OsStr::new("audit.log"), b"first\n").unwrap();
    private
        .append(OsStr::new("audit.log"), b"second\n")
        .unwrap();

    assert_eq!(
        std::fs::read(directory.join("audit.log")).unwrap(),
        b"first\nsecond\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(directory.join("audit.log"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn unix_first_append_reaches_parent_directory_sync_after_file_sync() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = PrivateDirectory::open_or_create(&directory).unwrap();
    UNIX_TEST_FAILURE_POINT.with(|failure| failure.set(UnixFailurePoint::DirectorySynced as u8));

    let error = private
        .append(OsStr::new("audit.log"), b"first\n")
        .unwrap_err();

    assert!(format!("{error:#}").contains("DirectorySynced"));
    assert_eq!(
        std::fs::read(directory.join("audit.log")).unwrap(),
        b"first\n"
    );
}

#[cfg(unix)]
#[test]
fn append_rejects_a_symlink_without_writing_outside() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = PrivateDirectory::open_or_create(&directory).unwrap();
    let outside = root.path().join("outside.log");
    std::fs::write(&outside, b"outside\n").unwrap();
    symlink(&outside, directory.join("audit.log")).unwrap();

    private
        .append(OsStr::new("audit.log"), b"private\n")
        .unwrap_err();

    assert_eq!(std::fs::read(outside).unwrap(), b"outside\n");
}

#[cfg(unix)]
#[test]
fn open_regular_files_reopens_by_handle_and_skips_symlinks() {
    use std::io::Read;
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = PrivateDirectory::open_or_create(&directory).unwrap();
    private
        .atomic_replace(OsStr::new("safe.jsonl"), b"safe")
        .unwrap();
    let outside = root.path().join("outside.jsonl");
    std::fs::write(&outside, b"outside").unwrap();
    symlink(&outside, directory.join("linked.jsonl")).unwrap();

    let mut files = private
        .open_regular_files(|name| Path::new(name).extension() == Some(OsStr::new("jsonl")))
        .unwrap();

    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, OsStr::new("safe.jsonl"));
    let mut contents = String::new();
    files[0].1.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "safe");
}

#[test]
fn open_existing_regular_file_is_read_only_and_does_not_create_missing_paths() {
    use std::io::Read;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("reports");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("goal.md"), b"report").unwrap();

    let private = PrivateDirectory::open_existing(&directory).unwrap();
    let mut file = private.open_regular_file(OsStr::new("goal.md")).unwrap();
    let mut contents = String::new();
    file.read_to_string(&mut contents).unwrap();

    assert_eq!(contents, "report");
    assert!(PrivateDirectory::open_existing(&root.path().join("missing")).is_err());
    assert!(!root.path().join("missing").exists());
}

#[cfg(unix)]
#[test]
fn open_regular_file_rejects_leaf_and_ancestor_symlinks() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("goal.md"), b"outside").unwrap();

    let directory = root.path().join("reports");
    std::fs::create_dir(&directory).unwrap();
    symlink(outside.path().join("goal.md"), directory.join("goal.md")).unwrap();
    let private = PrivateDirectory::open_existing(&directory).unwrap();
    assert!(private.open_regular_file(OsStr::new("goal.md")).is_err());

    let linked_directory = root.path().join("linked-reports");
    symlink(outside.path(), &linked_directory).unwrap();
    assert!(PrivateDirectory::open_existing(&linked_directory).is_err());
}

#[cfg(windows)]
#[test]
fn windows_open_regular_file_rejects_leaf_and_ancestor_reparse_points() {
    use std::io::Read;
    use std::os::windows::fs::{symlink_dir, symlink_file};

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("goal.md"), b"outside").unwrap();

    let directory = root.path().join("reports");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("safe.md"), b"safe").unwrap();
    std::fs::create_dir(directory.join("directory.md")).unwrap();
    symlink_file(outside.path().join("goal.md"), directory.join("linked.md")).unwrap();

    let private = PrivateDirectory::open_existing(&directory).unwrap();
    let mut safe = private.open_regular_file(OsStr::new("safe.md")).unwrap();
    let mut contents = String::new();
    safe.read_to_string(&mut contents).unwrap();
    assert_eq!(contents, "safe");
    assert!(private.open_regular_file(OsStr::new("linked.md")).is_err());
    assert!(
        private
            .open_regular_file(OsStr::new("directory.md"))
            .is_err()
    );
    assert!(private.open_regular_file(OsStr::new("missing.md")).is_err());
    assert!(!directory.join("missing.md").exists());

    let linked_directory = root.path().join("linked-reports");
    symlink_dir(outside.path(), &linked_directory).unwrap();
    assert!(PrivateDirectory::open_existing(&linked_directory).is_err());
}

#[test]
fn atomic_replace_keeps_distinct_names_independent() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = PrivateDirectory::open_or_create(&directory).unwrap();

    private
        .atomic_replace(OsStr::new("one.jsonl"), b"one")
        .unwrap();
    private
        .atomic_replace(OsStr::new("two.jsonl"), b"two")
        .unwrap();
    private
        .atomic_replace(OsStr::new("one.jsonl"), b"new-one")
        .unwrap();

    assert_eq!(
        std::fs::read(directory.join("one.jsonl")).unwrap(),
        b"new-one"
    );
    assert_eq!(std::fs::read(directory.join("two.jsonl")).unwrap(), b"two");
}

#[test]
fn concurrent_readers_never_observe_a_partial_atomic_replacement() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = Arc::new(PrivateDirectory::open_or_create(&directory).unwrap());
    let first = vec![b'a'; 64 * 1024];
    let second = vec![b'b'; 64 * 1024];
    private
        .atomic_replace(OsStr::new("state.bin"), &first)
        .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let reader_stop = Arc::clone(&stop);
    let reader_path = directory.join("state.bin");
    let first_for_reader = first.clone();
    let second_for_reader = second.clone();
    let reader = std::thread::spawn(move || {
        while !reader_stop.load(Ordering::Acquire) {
            let bytes = std::fs::read(&reader_path).unwrap();
            assert!(bytes == first_for_reader || bytes == second_for_reader);
        }
    });

    for index in 0..100 {
        let bytes = if index % 2 == 0 { &second } else { &first };
        private
            .atomic_replace(OsStr::new("state.bin"), bytes)
            .unwrap();
    }
    stop.store(true, Ordering::Release);
    reader.join().unwrap();
}

#[test]
fn public_operations_reject_non_basename_names() {
    let root = tempfile::tempdir().unwrap();
    let private = PrivateDirectory::open_or_create(&root.path().join("private")).unwrap();

    for name in ["", ".", "..", "nested/file", "../outside"] {
        assert!(
            private.atomic_replace(OsStr::new(name), b"no").is_err(),
            "{name}"
        );
        assert!(private.append(OsStr::new(name), b"no").is_err(), "{name}");
    }
}

#[cfg(windows)]
#[test]
fn windows_rejects_reserved_and_ambiguous_names() {
    let root = tempfile::tempdir().unwrap();
    let private = PrivateDirectory::open_or_create(&root.path().join("private")).unwrap();

    for name in [
        "CON",
        "nul.txt",
        "COM1.jsonl",
        "LPT9",
        "trail.",
        "trail ",
        "a:b",
    ] {
        assert!(
            private.atomic_replace(OsStr::new(name), b"no").is_err(),
            "{name}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_append_and_loader_reject_file_reparse_points() {
    use std::os::windows::fs::symlink_file;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("private");
    let private = PrivateDirectory::open_or_create(&directory).unwrap();
    let outside = root.path().join("outside.jsonl");
    std::fs::write(&outside, b"outside\n").unwrap();
    symlink_file(&outside, directory.join("linked.jsonl")).unwrap();

    private
        .append(OsStr::new("linked.jsonl"), b"private\n")
        .unwrap_err();
    let files = private
        .open_regular_files(|name| name == OsStr::new("linked.jsonl"))
        .unwrap();

    assert!(files.is_empty());
    assert_eq!(std::fs::read(outside).unwrap(), b"outside\n");
}

#[test]
fn private_write_replaces_atomically_without_leaving_temporary_files() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("nested").join("artifacts");
    let target = directory.join("state.json");

    write_private_artifact_file(&target, b"first").unwrap();
    write_private_artifact_file(&target, b"second").unwrap();

    assert_eq!(std::fs::read(&target).unwrap(), b"second");
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn failed_replace_removes_its_unique_temporary_file() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("artifacts");
    let target = directory.join("occupied");
    ensure_private_artifact_directory(&target).unwrap();

    write_private_artifact_file(&target, b"cannot replace a directory").unwrap_err();

    assert!(target.is_dir());
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn unix_temporary_guard_removes_security_stage_failures_without_replacing_target() {
    use std::os::unix::fs::symlink;

    for point in [
        UnixFailurePoint::AfterTemporaryCreate,
        UnixFailurePoint::AfterTemporarySecurity,
    ] {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("artifacts");
        ensure_private_artifact_directory(&directory).unwrap();
        let outside = root.path().join("outside.json");
        std::fs::write(&outside, b"outside").unwrap();
        let target = directory.join("state.json");
        symlink(&outside, &target).unwrap();
        UNIX_TEST_FAILURE_POINT.with(|failure| failure.set(point as u8));

        let error = write_private_artifact_file(&target, b"private").unwrap_err();

        assert!(format!("{error:#}").contains(&format!("{point:?}")));
        assert!(
            std::fs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{point:?}"
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"outside", "{point:?}");
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside", "{point:?}");
        let names = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, [OsString::from("state.json")], "{point:?}");
    }
}

#[cfg(windows)]
#[test]
fn windows_verbatim_paths_preserve_drive_and_unc_anchors() {
    for (path, expected_anchor) in [
        (r"\\?\C:\private\artifacts", r"\\?\C:\"),
        (
            r"\\?\UNC\server\share\private\artifacts",
            r"\\?\UNC\server\share\",
        ),
    ] {
        let (anchor, components) = absolute_path_components(Path::new(path)).unwrap();
        assert_eq!(anchor, PathBuf::from(expected_anchor));
        assert_eq!(
            components,
            vec![OsString::from("private"), OsString::from("artifacts")]
        );
    }
    let mut long = PathBuf::from(r"\\?\C:\");
    for _ in 0..6 {
        long.push("long-directory-component".repeat(3));
    }
    let (anchor, components) = absolute_path_components(&long).unwrap();
    assert_eq!(anchor, PathBuf::from(r"\\?\C:\"));
    assert_eq!(components.len(), 6);
}

#[cfg(windows)]
#[test]
fn windows_prefix_policy_accepts_drive_and_unc_but_rejects_namespaces() {
    let (drive, drive_components) =
        absolute_path_components(Path::new(r"C:\private\artifacts")).unwrap();
    assert_eq!(drive, Path::new(r"C:\"));
    assert_eq!(
        drive_components,
        [OsString::from("private"), OsString::from("artifacts")]
    );

    let (unc, unc_components) =
        absolute_path_components(Path::new(r"\\server\share\private\artifacts")).unwrap();
    assert_eq!(unc, Path::new(r"\\server\share\"));
    assert_eq!(
        unc_components,
        [OsString::from("private"), OsString::from("artifacts")]
    );

    for unsupported in [
        r"\\.\PhysicalDrive0\artifacts",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\artifacts",
    ] {
        assert!(
            absolute_path_components(Path::new(unsupported)).is_err(),
            "namespace path must be rejected: {unsupported}"
        );
    }
    assert!(absolute_path_components(Path::new(r"C:relative\artifacts")).is_err());
}

#[cfg(windows)]
#[test]
fn windows_verbatim_directory_writes_support_long_paths() {
    use std::io::Read;
    let temp = tempfile::tempdir().unwrap();
    let mut canonical = std::fs::canonicalize(temp.path()).unwrap();
    for _ in 0..6 {
        canonical.push("long-directory-component".repeat(3));
    }
    std::fs::create_dir_all(&canonical).unwrap();
    let private = PrivateDirectory::open_existing(&canonical).unwrap();
    let name = OsStr::new("history.jsonl");
    private.append(name, b"first\n").unwrap();
    let mut old = private.open_regular_file(name).unwrap();
    private.atomic_replace(name, b"replacement\n").unwrap();
    assert_eq!(
        std::fs::read(canonical.join(name)).unwrap(),
        b"replacement\n"
    );
    let mut old_bytes = Vec::new();
    old.read_to_end(&mut old_bytes).unwrap();
    assert_eq!(old_bytes, b"first\n");
    drop(old);
}

#[cfg(windows)]
#[test]
fn windows_temporary_handle_guard_removes_every_injected_failure() {
    for point in [
        WindowsFailurePoint::AfterTemporaryCreate,
        WindowsFailurePoint::AfterTemporarySecurity,
        WindowsFailurePoint::BeforeRename,
    ] {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("artifacts");
        ensure_private_artifact_directory(&directory).unwrap();
        WINDOWS_TEST_FAILURE_POINT.store(point as u8, Ordering::Release);

        write_private_artifact_file(&directory.join("state.json"), b"private").unwrap_err();

        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            0,
            "{point:?}"
        );
    }
}

#[cfg(windows)]
#[test]
fn windows_private_directory_ace_is_inherited_by_a_runtime_child() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("artifacts");
    ensure_private_artifact_directory(&directory).unwrap();
    let child = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("inherited.txt"))
        .unwrap();

    windows_acl_test_support::verify_child_inherits_private_acl(&child).unwrap();
}

#[cfg(windows)]
fn assert_windows_handle_relative_rename_supports_basename(target_name: &str) {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("artifacts");
    ensure_private_artifact_directory(&directory).unwrap();
    let parent = open_private_artifact_directory(&directory, true).unwrap();
    let source_name = OsStr::new("source.tmp");
    let mut source = windows_native::create_new_file(&parent, source_name).unwrap();
    source.write_all(b"private").unwrap();
    source.sync_all().unwrap();

    windows_native::rename_handle_relative(&source, &parent, OsStr::new(target_name)).unwrap();
    drop(source);

    assert!(!directory.join(source_name).exists());
    assert_eq!(
        std::fs::read(directory.join(target_name)).unwrap(),
        b"private"
    );
}

#[cfg(windows)]
#[test]
fn windows_handle_relative_rename_supports_single_bmp_basename() {
    assert_windows_handle_relative_rename_supports_basename("文");
}

#[cfg(windows)]
#[test]
fn windows_handle_relative_rename_supports_non_bmp_basename() {
    assert_windows_handle_relative_rename_supports_basename("🦀");
}

#[cfg(windows)]
#[test]
fn windows_final_rename_remains_bound_to_the_open_parent_handle() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let active = root.path().join("active");
    let artifacts = active.join("artifacts");
    ensure_private_artifact_directory(&artifacts).unwrap();
    let outside_artifacts = outside.path().join("artifacts");
    std::fs::create_dir(&outside_artifacts).unwrap();

    let sequence = 4_000_000_000u64;
    TEMPORARY_FILE_SEQUENCE.store(sequence, Ordering::Release);
    let temporary_name = format!(".state.json.{}.{}.tmp", std::process::id(), sequence);
    let outside_target = outside_artifacts.join("state.json");
    let outside_temporary = outside_artifacts.join(&temporary_name);
    std::fs::write(&outside_target, b"outside-target").unwrap();
    std::fs::write(&outside_temporary, b"outside-temporary").unwrap();

    WINDOWS_TEST_RENAME_REACHED.store(false, Ordering::Release);
    WINDOWS_TEST_PAUSE_BEFORE_RENAME.store(true, Ordering::Release);
    let target = artifacts.join("state.json");
    let writer = std::thread::spawn(move || write_private_artifact_file(&target, b"private"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !WINDOWS_TEST_RENAME_REACHED.load(Ordering::Acquire) {
        assert!(
            std::time::Instant::now() < deadline,
            "writer did not reach the final rename window"
        );
        std::thread::yield_now();
    }

    let parked = root.path().join("parked");
    if let Err(error) = std::fs::rename(&active, &parked) {
        WINDOWS_TEST_PAUSE_BEFORE_RENAME.store(false, Ordering::Release);
        let _ = writer.join();
        panic!("failed to move the directory during the rename window: {error}");
    }
    if let Err(error) = create_directory_symlink(outside.path(), &active) {
        WINDOWS_TEST_PAUSE_BEFORE_RENAME.store(false, Ordering::Release);
        let _ = writer.join();
        let _ = std::fs::rename(&parked, &active);
        panic!("failed to install the directory symlink during the rename window: {error}");
    }
    WINDOWS_TEST_PAUSE_BEFORE_RENAME.store(false, Ordering::Release);
    writer.join().unwrap().unwrap();

    assert_eq!(std::fs::read(&outside_target).unwrap(), b"outside-target");
    assert_eq!(
        std::fs::read(&outside_temporary).unwrap(),
        b"outside-temporary"
    );
    assert_eq!(
        std::fs::read(parked.join("artifacts").join("state.json")).unwrap(),
        b"private"
    );
    std::fs::remove_dir(&active).unwrap();
    std::fs::rename(&parked, &active).unwrap();
}

#[cfg(unix)]
#[test]
fn private_write_replaces_a_target_symlink_without_following_it() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("artifacts");
    ensure_private_artifact_directory(&directory).unwrap();
    let outside = root.path().join("outside.txt");
    std::fs::write(&outside, b"outside").unwrap();
    let target = directory.join("state.json");
    symlink(&outside, &target).unwrap();

    write_private_artifact_file(&target, b"private").unwrap();

    assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    assert_eq!(std::fs::read(&target).unwrap(), b"private");
    assert!(
        !std::fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn private_directory_rejects_a_symlinked_ancestor() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let link = root.path().join("linked");
    symlink(outside.path(), &link).unwrap();

    let error = ensure_private_artifact_directory(&link.join("artifacts")).unwrap_err();

    assert!(format!("{error:#}").contains("symlink"));
    assert!(!outside.path().join("artifacts").exists());
}

#[cfg(any(unix, windows))]
#[test]
fn concurrent_parent_symlink_replacement_never_writes_outside() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let active = root.path().join("volatile");
    std::fs::create_dir(&active).unwrap();
    std::fs::write(outside.path().join("marker"), b"outside").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let swaps = Arc::new(AtomicUsize::new(0));
    let attacker_stop = Arc::clone(&stop);
    let attacker_swaps = Arc::clone(&swaps);
    let active_for_attacker = active.clone();
    let outside_for_attacker = outside.path().to_path_buf();
    let attacker = std::thread::spawn(move || {
        let mut sequence = 0u64;
        while !attacker_stop.load(Ordering::Acquire) {
            sequence += 1;
            let parked = active_for_attacker.with_extension(format!("parked-{sequence}"));
            if std::fs::rename(&active_for_attacker, &parked).is_err() {
                std::thread::yield_now();
                continue;
            }
            if create_directory_symlink(&outside_for_attacker, &active_for_attacker).is_ok() {
                attacker_swaps.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_micros(50));
                let _ = std::fs::remove_file(&active_for_attacker);
            }
            let _ = std::fs::rename(&parked, &active_for_attacker);
        }
    });

    for index in 0..1_000 {
        let _ = write_private_artifact_file(
            &active.join("artifacts").join("state.json"),
            format!("private-{index}").as_bytes(),
        );
    }
    stop.store(true, Ordering::Release);
    attacker.join().unwrap();

    assert!(swaps.load(Ordering::Relaxed) > 0);
    assert_eq!(
        std::fs::read(outside.path().join("marker")).unwrap(),
        b"outside"
    );
    assert!(!outside.path().join("artifacts").exists());
    assert!(!outside.path().join("state.json").exists());
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}
