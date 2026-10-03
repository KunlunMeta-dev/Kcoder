use super::layout::validate_managed_file;
use super::{SkillPackage, SkillStoreError};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub(crate) fn create_private_dir(path: &Path) -> Result<(), SkillStoreError> {
    #[cfg(unix)]
    let existed = path.exists();
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(SkillStoreError::UnsupportedFileType(path.to_path_buf()));
    }
    fs::create_dir_all(path)
        .map_err(|error| SkillStoreError::io(format!("creating {}", path.display()), error))?;
    #[cfg(unix)]
    if !existed {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            SkillStoreError::io(format!("setting permissions on {}", path.display()), error)
        })?;
    }
    Ok(())
}

pub(crate) fn write_package(path: &Path, package: &SkillPackage) -> Result<(), SkillStoreError> {
    create_private_dir(path)?;
    for package_file in &package.files {
        let relative = validate_managed_file(&package_file.relative_path)?;
        let destination = path.join(relative);
        if let Some(parent) = destination.parent() {
            create_private_dir(parent)?;
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&destination)
            .map_err(|error| {
                SkillStoreError::io(format!("staging {}", destination.display()), error)
            })?;
        file.write_all(&package_file.content).map_err(|error| {
            SkillStoreError::io(format!("writing {}", destination.display()), error)
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if package_file.executable {
                0o700
            } else {
                0o600
            };
            file.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|error| {
                    SkillStoreError::io(
                        format!("setting permissions on {}", destination.display()),
                        error,
                    )
                })?;
        }
        file.sync_all().map_err(|error| {
            SkillStoreError::io(format!("syncing {}", destination.display()), error)
        })?;
    }
    sync_tree_directories(path)
}

pub(crate) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    transaction_id: &str,
) -> Result<(), SkillStoreError> {
    let parent = path.parent().ok_or_else(|| {
        SkillStoreError::InvalidPackage(format!("path has no parent: {}", path.display()))
    })?;
    create_private_dir(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            SkillStoreError::InvalidPackage(format!("non-UTF-8 path: {}", path.display()))
        })?;
    let temporary = parent.join(format!(".{file_name}.{transaction_id}.tmp"));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| SkillStoreError::io("creating unique temporary file", error))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| SkillStoreError::io("writing unique temporary file", error))?;
        file.sync_all()
            .map_err(|error| SkillStoreError::io("syncing unique temporary file", error))?;
        drop(file);
        atomic_replace(&temporary, path)
            .map_err(|error| SkillStoreError::io("publishing unique temporary file", error))?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    // Raw Win32 APIs require extended-length paths. Resolve parents only: neither
    // source nor destination leaf symlinks may redirect the entry being renamed.
    let canonical_file_path = |path: &Path| -> std::io::Result<std::path::PathBuf> {
        let parent = path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let name = path.file_name().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "file path has no file name",
            )
        })?;
        if name.encode_wide().any(|unit| unit == 0) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "file name contains NUL",
            ));
        }
        Ok(fs::canonicalize(parent)?.join(name))
    };
    let source = canonical_file_path(source)?;
    let destination = canonical_file_path(destination)?;

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 paths are NUL-terminated and remain valid during the call.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(crate) fn append_and_sync(path: &Path, bytes: &[u8]) -> Result<(), SkillStoreError> {
    let parent = path.parent().ok_or_else(|| {
        SkillStoreError::InvalidPackage(format!("path has no parent: {}", path.display()))
    })?;
    create_private_dir(parent)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| SkillStoreError::io("opening append-only skill log", error))?;
    file.write_all(bytes)
        .map_err(|error| SkillStoreError::io("appending skill log", error))?;
    file.sync_all()
        .map_err(|error| SkillStoreError::io("syncing skill log", error))?;
    sync_directory(parent)
}

pub(crate) fn rename_and_sync(source: &Path, destination: &Path) -> Result<(), SkillStoreError> {
    let source_parent = source.parent().ok_or_else(|| {
        SkillStoreError::InvalidPackage(format!("path has no parent: {}", source.display()))
    })?;
    let destination_parent = destination.parent().ok_or_else(|| {
        SkillStoreError::InvalidPackage(format!("path has no parent: {}", destination.display()))
    })?;
    create_private_dir(destination_parent)?;
    fs::rename(source, destination).map_err(|error| {
        if error.raw_os_error() == Some(18) {
            SkillStoreError::CrossDeviceStaging
        } else {
            SkillStoreError::io(
                format!("renaming {} to {}", source.display(), destination.display()),
                error,
            )
        }
    })?;
    sync_directory(source_parent)?;
    if source_parent != destination_parent {
        sync_directory(destination_parent)?;
    }
    Ok(())
}

pub(crate) fn remove_tree(path: &Path) -> Result<(), SkillStoreError> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path)
        .map_err(|error| SkillStoreError::io(format!("removing {}", path.display()), error))?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

pub(crate) fn sync_directory(path: &Path) -> Result<(), SkillStoreError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                SkillStoreError::io(format!("syncing directory {}", path.display()), error)
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn sync_tree_directories(root: &Path) -> Result<(), SkillStoreError> {
    let mut directories = walkdir::WalkDir::new(root)
        .contents_first(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir())
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    if !directories.iter().any(|directory| directory == root) {
        directories.push(root.to_path_buf());
    }
    for directory in directories {
        sync_directory(&directory)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn atomic_write_publishes_and_replaces_beyond_legacy_windows_path_limit() {
        let root = tempfile::tempdir().unwrap();
        let mut parent = root.path().to_path_buf();
        while parent.as_os_str().len() < 280 {
            parent.push("workspace-with-a-long-directory-name");
        }
        create_private_dir(&parent).unwrap();
        let path = parent.join("manifest.json");
        atomic_write(&path, b"first", "transaction-one").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");
        atomic_write(&path, b"second", "transaction-two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn failed_publication_cleans_owned_temporary_file_and_allows_retry() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("target");
        fs::create_dir(&destination).unwrap();
        assert!(atomic_write(&destination, b"value", "same-transaction").is_err());
        assert!(!root.path().join(".target.same-transaction.tmp").exists());
        assert!(destination.is_dir());
        fs::remove_dir(&destination).unwrap();
        atomic_write(&destination, b"value", "same-transaction").unwrap();
        assert_eq!(fs::read(destination).unwrap(), b"value");
    }
}
