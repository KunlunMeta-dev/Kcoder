use super::{
    TEMPORARY_FILE_SEQUENCE, UnixFailurePoint, finish_private_append, unix_test_failure_point,
    validate_single_name, verify_reader_links,
};
use anyhow::{Context, Result};
use cap_primitives::ambient_authority;
use cap_primitives::fs::{
    DirOptions, OpenOptions as CapOpenOptions, create_dir, open, open_ambient_dir,
    open_dir_nofollow,
};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

#[cfg(unix)]
pub(super) fn open_private_artifact_directory(path: &Path, create_missing: bool) -> Result<File> {
    let (anchor, components) = absolute_path_components(path)?;
    anyhow::ensure!(
        !components.is_empty() || !create_missing,
        "a filesystem root cannot be created"
    );
    let mut current = open_ambient_dir(&anchor, ambient_authority()).with_context(|| {
        format!(
            "failed to open artifact filesystem root {}",
            anchor.display()
        )
    })?;
    #[cfg(target_os = "linux")]
    if !create_missing && !components.is_empty() {
        let relative = path.strip_prefix(&anchor)?;
        if let Some(directory) = open_existing_directory_linux(&current, relative)? {
            return Ok(directory);
        }
    }
    for component in &components {
        let relative = Path::new(component);
        let next = match open_dir_nofollow(&current, relative) {
            Ok(directory) => directory,
            Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
                let options = DirOptions::new();
                match create_dir(&current, relative, &options) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
                open_dir_nofollow(&current, relative).with_context(|| {
                    format!(
                        "artifact directory component must not be a symlink: {}",
                        component.to_string_lossy()
                    )
                })?
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "artifact directory component must not be a symlink: {}",
                        component.to_string_lossy()
                    )
                });
            }
        };
        current = next;
    }
    Ok(current)
}

#[cfg(target_os = "linux")]
fn open_existing_directory_linux(root: &File, relative: &Path) -> Result<Option<File>> {
    use std::ffi::CString;
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::ffi::OsStrExt,
    };

    let relative = CString::new(relative.as_os_str().as_bytes())?;
    // open_how is a C ABI structure containing only integers.
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64;
    how.resolve = libc::RESOLVE_BENEATH | libc::RESOLVE_NO_SYMLINKS;
    // The validated relative path cannot escape the held root or follow any link.
    let result = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            relative.as_ptr(),
            &how,
            std::mem::size_of_val(&how),
        )
    };
    if result >= 0 {
        // A successful openat2 returns a new owned descriptor.
        return Ok(Some(unsafe { File::from_raw_fd(result as libc::c_int) }));
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        // Keep the same no-follow component walk for older or restricted kernels,
        // path-length limits and lookup races.
        Some(libc::ENOSYS | libc::EPERM | libc::ENAMETOOLONG | libc::EAGAIN) => Ok(None),
        _ => Err(error).context(
            "artifact directory path must contain only ordinary directories, without symlinks",
        ),
    }
}

#[cfg(unix)]
fn absolute_path_components(path: &Path) -> Result<(PathBuf, Vec<OsString>)> {
    use std::path::Component;

    anyhow::ensure!(path.is_absolute(), "artifact directory must be absolute");
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(component) => components.push(component.to_os_string()),
            _ => anyhow::bail!("artifact directory contains an unsupported path component"),
        }
    }
    Ok((PathBuf::from("/"), components))
}

pub(super) fn open_child_directory(
    parent: &File,
    name: &OsStr,
    create_missing: bool,
) -> Result<File> {
    validate_single_name(name)?;
    let relative = Path::new(name);
    match open_dir_nofollow(parent, relative) {
        Ok(directory) => Ok(directory),
        Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
            let options = DirOptions::new();
            let created = match create_dir(parent, relative, &options) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
                Err(error) => return Err(error.into()),
            };
            let directory = open_dir_nofollow(parent, relative)?;
            if created {
                sync_private_directory(&directory)?;
                sync_private_directory(parent)?;
            }
            Ok(directory)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
pub(super) fn append_private_file(parent: &File, name: &OsStr, bytes: &[u8]) -> Result<File> {
    let flags =
        libc::O_WRONLY | libc::O_APPEND | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    // On macOS, simultaneous openat calls with O_CREAT can spuriously return
    // ENOENT. Open an existing leaf first; create exclusively only when absent,
    // then reopen without O_CREAT if another creator won the race.
    let file = match open_leaf(parent, name, flags, 0) {
        Ok(file) => Ok(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            open_leaf(parent, name, flags | libc::O_CREAT | libc::O_EXCL, 0o666).or_else(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    open_leaf(parent, name, flags, 0)
                } else {
                    Err(error)
                }
            })
        }
        Err(error) => Err(error),
    }
    .with_context(|| {
        format!(
            "private append target must be an ordinary file: {}",
            name.to_string_lossy()
        )
    })?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "private append target is not a regular file"
    );
    verify_reader_links(&file, false)?;
    finish_private_append(parent, file, bytes)
}

#[cfg(unix)]
pub(super) fn open_regular_file(parent: &File, name: &OsStr) -> Result<File> {
    // This is a single validated leaf below a held directory handle. Using
    // openat directly keeps O_NOFOLLOW effective on platforms where a generic
    // capability resolver may expand symlinks before reaching the final open.
    let file = open_leaf(
        parent,
        name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        0,
    )
    .with_context(|| "target must be an existing ordinary file")?;
    anyhow::ensure!(file.metadata()?.is_file(), "target is not a regular file");
    Ok(file)
}

pub(super) fn open_read_write_file(parent: &File, name: &OsStr, create_new: bool) -> Result<File> {
    use std::os::unix::fs::MetadataExt;
    let flags = libc::O_RDWR
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if create_new {
            libc::O_CREAT | libc::O_EXCL
        } else {
            0
        };
    let file = open_leaf(parent, name, flags, 0o666)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "update target is not a regular file");
    anyhow::ensure!(
        metadata.nlink() == 1,
        "update target must not have hard links"
    );
    Ok(file)
}

pub(super) fn open_entry(parent: &File, name: &OsStr) -> Result<File> {
    let flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NONBLOCK;
    #[cfg(not(target_vendor = "apple"))]
    let flags = flags | libc::O_NOFOLLOW;
    // Darwin's O_SYMLINK opens the link object itself; do not combine it with
    // O_NOFOLLOW, which conflicts with that behavior.
    #[cfg(target_vendor = "apple")]
    let flags = flags | libc::O_SYMLINK;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let flags = flags | libc::O_PATH;
    let file = open_leaf(parent, name, flags, 0)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file() || metadata.is_dir() || metadata.file_type().is_symlink(),
        "entry must be a file, directory, or link"
    );
    Ok(file)
}

fn open_leaf(
    parent: &File,
    name: &OsStr,
    flags: libc::c_int,
    mode: libc::mode_t,
) -> std::io::Result<File> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::ffi::OsStrExt,
    };

    validate_single_name(name).map_err(std::io::Error::other)?;
    let name = CString::new(name.as_bytes()).map_err(std::io::Error::other)?;
    // SAFETY: parent is a live directory handle and name is one validated
    // NUL-terminated component; mode is promoted for the C variadic argument,
    // and the returned descriptor is owned by this call.
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags,
            mode as libc::c_uint,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor, transferred exactly once.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

pub(super) fn rename_no_replace(parent: &File, source: &OsStr, destination: &OsStr) -> Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
    {
        use std::{ffi::CString, os::fd::AsRawFd, os::unix::ffi::OsStrExt};
        let source = CString::new(source.as_bytes())?;
        let destination = CString::new(destination.as_bytes())?;
        // SAFETY: both names are single NUL-terminated components and parent
        // owns the live directory descriptor for the complete atomic operation.
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let result = unsafe {
            libc::renameat2(
                parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(target_vendor = "apple")]
        let result = unsafe {
            libc::renameatx_np(
                parent.as_raw_fd(),
                source.as_ptr(),
                parent.as_raw_fd(),
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
    {
        let _ = (parent, source, destination);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "atomic no-replace rename is unavailable on this platform",
        )
        .into())
    }
}

pub(super) fn remove_regular_file(parent: &File, name: &OsStr) -> Result<()> {
    use cap_primitives::fs::{FollowSymlinks, remove_file, stat};

    validate_single_name(name)?;
    let path = Path::new(name);
    let metadata = stat(parent, path, FollowSymlinks::No)?;
    anyhow::ensure!(metadata.is_file(), "removal target is not a regular file");
    // Both operations are relative to the same directory; unlink never follows a replacement link.
    remove_file(parent, path)?;
    Ok(())
}
#[cfg(unix)]
pub(super) fn create_unique_temporary_file(
    parent: &File,
    target_name: &OsStr,
) -> Result<(PathBuf, File)> {
    for _ in 0..64 {
        let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = PathBuf::from(format!(".kcoder.{}.{}.tmp", std::process::id(), sequence));
        if temporary.as_os_str().eq_ignore_ascii_case(target_name) {
            continue;
        }
        match open_leaf(
            parent,
            temporary.as_os_str(),
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o666,
        ) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("failed to allocate a unique artifact temporary file")
}
#[cfg(unix)]
fn reopen_unix_directory(directory: &File) -> Result<File> {
    use cap_primitives::fs::OpenOptionsExt;

    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW);
    open(directory, Path::new("."), &options).map_err(Into::into)
}

#[cfg(unix)]
pub(super) fn sync_private_directory(directory: &File) -> Result<()> {
    let reopened = reopen_unix_directory(directory)?;
    #[cfg(all(target_os = "linux", feature = "private-file-test-hooks"))]
    super::unix_before_directory_sync(&reopened)?;
    reopened.sync_all()?;
    unix_test_failure_point(UnixFailurePoint::DirectorySynced)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{OpenOptionsExt, symlink};
    use std::time::Duration;

    #[test]
    fn open_regular_files_skips_fifo_without_waiting_for_a_writer() {
        let root = tempfile::tempdir().unwrap();
        let directory = crate::PrivateDirectory::open_existing(root.path()).unwrap();
        let fifo = root.path().join("block.json");
        let fifo_name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo_name is a valid NUL-terminated path in this test's private directory.
        assert_eq!(unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) }, 0);
        std::fs::write(root.path().join("safe.json"), b"{}").unwrap();
        symlink("safe.json", root.path().join("linked.json")).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            done_tx
                .send(directory.open_regular_files(|name| {
                    Path::new(name).extension() == Some(OsStr::new("json"))
                }))
                .unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let first = done_rx.recv_timeout(Duration::from_millis(500));
        let completed_without_writer = first.is_ok();
        // Unblock the old implementation before reporting failure; never strand the test worker.
        let rescue = (!completed_without_writer).then(|| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW)
                .open(&fifo)
                .unwrap()
        });
        let files = first
            .unwrap_or_else(|_| done_rx.recv_timeout(Duration::from_secs(2)).unwrap())
            .unwrap();
        worker.join().unwrap();
        drop(rescue);
        assert!(
            completed_without_writer,
            "directory enumeration waited for a FIFO writer"
        );
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, OsStr::new("safe.json"));
    }
}
