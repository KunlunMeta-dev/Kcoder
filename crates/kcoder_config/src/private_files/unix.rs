use super::{
    TEMPORARY_FILE_SEQUENCE, UnixFailurePoint, unix_test_failure_point, validate_single_name,
};
use anyhow::{Context, Result};
use cap_primitives::ambient_authority;
use cap_primitives::fs::{
    DirOptions, OpenOptions as CapOpenOptions, create_dir, open, open_ambient_dir,
    open_dir_nofollow,
};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

#[cfg(unix)]
pub(super) fn open_private_artifact_directory(path: &Path, create_missing: bool) -> Result<File> {
    let (anchor, components) = absolute_path_components(path)?;
    anyhow::ensure!(
        !components.is_empty(),
        "artifact directory cannot be a filesystem root"
    );
    let mut current = open_ambient_dir(&anchor, ambient_authority()).with_context(|| {
        format!(
            "failed to open artifact filesystem root {}",
            anchor.display()
        )
    })?;
    for (index, component) in components.iter().enumerate() {
        let relative = Path::new(component);
        let mut created = false;
        let next = match open_dir_nofollow(&current, relative) {
            Ok(directory) => directory,
            Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
                #[allow(unused_mut)]
                let mut options = DirOptions::new();
                #[cfg(unix)]
                {
                    use cap_primitives::fs::DirBuilderExt;
                    options.mode(0o700);
                }
                match create_dir(&current, relative, &options) {
                    Ok(()) => created = true,
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
        if create_missing && (created || index + 1 == components.len()) {
            secure_private_handle(&next, true)?;
        }
        current = next;
    }
    Ok(current)
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
    use cap_primitives::fs::DirBuilderExt;

    validate_single_name(name)?;
    let relative = Path::new(name);
    match open_dir_nofollow(parent, relative) {
        Ok(directory) => Ok(directory),
        Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
            let mut options = DirOptions::new();
            options.mode(0o700);
            let created = match create_dir(parent, relative, &options) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
                Err(error) => return Err(error.into()),
            };
            let directory = open_dir_nofollow(parent, relative)?;
            if created {
                secure_private_handle(&directory, true)?;
                sync_private_directory(&directory)?;
                sync_private_directory(parent)?;
            }
            Ok(directory)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
pub(super) fn append_private_file(parent: &File, name: &OsStr, bytes: &[u8]) -> Result<()> {
    use cap_primitives::fs::OpenOptionsExt;

    let mut options = CapOpenOptions::new();
    options.write(true).append(true).create(true);
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = open(parent, Path::new(name), &options).with_context(|| {
        format!(
            "private append target must be an ordinary file: {}",
            name.to_string_lossy()
        )
    })?;
    anyhow::ensure!(
        file.metadata()?.is_file(),
        "private append target is not a regular file"
    );
    secure_private_handle(&file, false)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    sync_private_directory(parent)?;
    Ok(())
}

#[cfg(unix)]
pub(super) fn open_regular_files(
    parent: &File,
    mut predicate: impl FnMut(&OsStr) -> bool,
) -> Result<Vec<(OsString, File)>> {
    use cap_primitives::fs::{OpenOptionsExt, read_base_dir};

    let mut files = Vec::new();
    for entry in read_base_dir(parent)? {
        let entry = entry?;
        let name = entry.file_name();
        if !predicate(&name) || validate_single_name(&name).is_err() {
            continue;
        }
        let mut options = CapOpenOptions::new();
        options
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
        let file = match open(parent, Path::new(&name), &options) {
            Ok(file) => file,
            Err(_) => continue,
        };
        if file.metadata().is_ok_and(|metadata| metadata.is_file()) {
            files.push((name, file));
        }
    }
    Ok(files)
}

#[cfg(unix)]
pub(super) fn open_regular_file(parent: &File, name: &OsStr) -> Result<File> {
    use cap_primitives::fs::OpenOptionsExt;

    validate_single_name(name)?;
    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    let file = open(parent, Path::new(name), &options).with_context(|| {
        format!(
            "target must be an existing regular file: {}",
            name.to_string_lossy()
        )
    })?;
    anyhow::ensure!(file.metadata()?.is_file(), "target is not a regular file");
    Ok(file)
}

pub(super) fn open_read_write_file(parent: &File, name: &OsStr, create_new: bool) -> Result<File> {
    use cap_primitives::fs::OpenOptionsExt;
    use std::os::unix::fs::MetadataExt;
    validate_single_name(name)?;
    let mut options = CapOpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(create_new)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK);
    let file = open(parent, Path::new(name), &options)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "update target is not a regular file");
    anyhow::ensure!(
        metadata.nlink() == 1,
        "update target must not have hard links"
    );
    Ok(file)
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
    let target_name = target_name.to_string_lossy();
    for _ in 0..64 {
        let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = PathBuf::from(format!(
            ".{target_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        let mut options = CapOpenOptions::new();
        options.write(true).create_new(true);
        use cap_primitives::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        match open(parent, &temporary, &options) {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("failed to allocate a unique artifact temporary file")
}
#[cfg(unix)]
pub(super) fn secure_private_handle(file: &File, directory: bool) -> Result<()> {
    use std::os::fd::AsRawFd;

    let mode = if directory { 0o700 } else { 0o600 };
    let reopened;
    let file = if directory {
        reopened = reopen_unix_directory(file)?;
        &reopened
    } else {
        file
    };
    // SAFETY: file owns a live descriptor; fchmod only changes that opened object.
    if unsafe { libc::fchmod(file.as_raw_fd(), mode) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
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
    reopen_unix_directory(directory)?.sync_all()?;
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
