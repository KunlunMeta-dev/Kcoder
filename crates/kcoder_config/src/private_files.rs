#[cfg(any(windows, test))]
use anyhow::Context;
use anyhow::Result;
#[cfg(unix)]
use cap_primitives::fs::{remove_file, rename};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
#[cfg(windows)]
use std::sync::atomic::Ordering;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix::{
    append_private_file, create_unique_temporary_file, open_private_artifact_directory,
    open_regular_file, open_regular_files, secure_private_handle, sync_private_directory,
};

static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct PrivateDirectory {
    directory: File,
}

impl PrivateDirectory {
    pub fn open_or_create(path: &Path) -> Result<Self> {
        Ok(Self {
            directory: open_private_artifact_directory(path, true)?,
        })
    }

    /// Open an existing directory without creating it or modifying permissions or ACLs.
    pub fn open_existing(path: &Path) -> Result<Self> {
        Ok(Self {
            directory: open_private_artifact_directory(path, false)?,
        })
    }

    pub fn atomic_replace(&self, name: &OsStr, bytes: &[u8]) -> Result<()> {
        validate_single_name(name)?;
        #[cfg(unix)]
        {
            let cleanup_parent = self.directory.try_clone()?;
            let (temporary, mut file) = create_unique_temporary_file(&self.directory, name)?;
            let mut cleanup = TemporaryFileGuard {
                parent: cleanup_parent,
                name: Some(temporary.clone()),
            };
            unix_test_failure_point(UnixFailurePoint::AfterTemporaryCreate)?;
            secure_private_handle(&file, false)?;
            unix_test_failure_point(UnixFailurePoint::AfterTemporarySecurity)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            rename(
                &self.directory,
                &temporary,
                &self.directory,
                Path::new(name),
            )?;
            cleanup.name = None;
            sync_private_directory(&self.directory)?;
            Ok(())
        }
        #[cfg(windows)]
        {
            let mut temporary = create_unique_temporary_file(&self.directory, name)?;
            windows_test_failure_point(WindowsFailurePoint::AfterTemporaryCreate)?;
            secure_private_handle(temporary.file(), false)?;
            windows_test_failure_point(WindowsFailurePoint::AfterTemporarySecurity)?;
            temporary.file_mut().write_all(bytes)?;
            temporary.file_mut().sync_all()?;
            windows_test_before_rename();
            windows_test_failure_point(WindowsFailurePoint::BeforeRename)?;
            windows_native::rename_handle_relative(temporary.file(), &self.directory, name)?;
            temporary.disarm();
            sync_private_directory(&self.directory)?;
            Ok(())
        }
    }

    pub fn append(&self, name: &OsStr, bytes: &[u8]) -> Result<()> {
        validate_single_name(name)?;
        append_private_file(&self.directory, name, bytes)
    }

    pub fn open_regular_files(
        &self,
        predicate: impl FnMut(&OsStr) -> bool,
    ) -> Result<Vec<(OsString, File)>> {
        open_regular_files(&self.directory, predicate)
    }

    /// Safely open a regular file relative to an open directory.
    pub fn open_regular_file(&self, name: &OsStr) -> Result<File> {
        validate_single_name(name)?;
        open_regular_file(&self.directory, name)
    }

    /// Open a regular leaf for positional updates, optionally requiring exclusive creation.
    pub fn open_read_write_file(&self, name: &OsStr, create_new: bool) -> Result<File> {
        validate_single_name(name)?;
        #[cfg(unix)]
        let file = unix::open_read_write_file(&self.directory, name, create_new)?;
        #[cfg(windows)]
        let file = windows_native::open_read_write_file(&self.directory, name, create_new)?;
        if create_new {
            secure_private_handle(&file, false)?;
            sync_private_directory(&self.directory)?;
        }
        Ok(file)
    }

    /// Acquire an advisory shared lease without following a lock-file symlink.
    /// Keep this leaf in place while any participant may acquire the same lease.
    pub fn try_shared_lock(&self, name: &OsStr) -> Result<Option<File>> {
        self.try_file_lock(name, false)
    }

    /// Acquire an advisory exclusive lease. None means another owner is active.
    pub fn try_exclusive_lock(&self, name: &OsStr) -> Result<Option<File>> {
        self.try_file_lock(name, true)
    }

    fn try_file_lock(&self, name: &OsStr, exclusive: bool) -> Result<Option<File>> {
        let file = match self.open_read_write_file(name, true) {
            Ok(file) => file,
            Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) => {
                self.open_read_write_file(name, false)?
            }
            Err(error) => return Err(error),
        };
        let result = if exclusive { fs2::FileExt::try_lock_exclusive(&file) }
            else { fs2::FileExt::try_lock_shared(&file) };
        match result {
            Ok(()) => Ok(Some(file)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error().is_some_and(|code| Some(code) == fs2::lock_contended_error().raw_os_error()) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Sync directory entry changes after a caller has flushed a file handle.
    pub fn sync(&self) -> Result<()> {
        sync_private_directory(&self.directory)
    }

    /// Remove an existing ordinary leaf file without changing permissions or following links.
    /// The caller must serialize concurrent mutations of the same name.
    /// A directory-sync error can be returned after the file has been removed.
    pub fn remove_regular_file(&self, name: &OsStr) -> Result<()> {
        validate_single_name(name)?;
        #[cfg(unix)]
        unix::remove_regular_file(&self.directory, name)?;
        #[cfg(windows)]
        windows_native::remove_regular_file(&self.directory, name)?;
        sync_private_directory(&self.directory)
    }

    /// Open an ordinary child directory relative to this handle, optionally creating it.
    /// Existing permissions are preserved; only newly created directories are made private.
    pub fn open_child(&self, name: &OsStr, create_missing: bool) -> Result<Self> {
        validate_single_name(name)?;
        #[cfg(unix)]
        let directory = unix::open_child_directory(&self.directory, name, create_missing)?;
        #[cfg(windows)]
        let directory = {
            let (directory, created) = windows_native::open_or_create_directory(
                &self.directory,
                name,
                create_missing,
                false,
            )?;
            if created {
                let mut cleanup = windows_native::HandleDeleteGuard::new(directory);
                secure_private_handle(cleanup.file(), true)?;
                sync_private_directory(&self.directory)?;
                cleanup.disarm();
                cleanup.into_file()
            } else {
                directory
            }
        };
        Ok(Self { directory })
    }
}

#[cfg(windows)]
fn open_private_artifact_directory(path: &Path, create_missing: bool) -> Result<File> {
    let (anchor, components) = absolute_path_components(path)?;
    anyhow::ensure!(
        !components.is_empty(),
        "artifact directory cannot be a filesystem root"
    );
    let mut current = windows_native::open_absolute_directory(&anchor)?;
    for (index, component) in components.iter().enumerate() {
        let is_final = index + 1 == components.len();
        let (next, created) = windows_native::open_or_create_directory(
            &current,
            component,
            create_missing,
            create_missing && is_final,
        )
        .with_context(|| {
            format!(
                "artifact directory component must be an ordinary directory: {}",
                component.to_string_lossy()
            )
        })?;
        if created {
            let mut cleanup = windows_native::HandleDeleteGuard::new(next);
            secure_private_handle(cleanup.file(), true)?;
            cleanup.disarm();
            current = cleanup.into_file();
        } else {
            if create_missing && is_final {
                secure_private_handle(&next, true)?;
            }
            current = next;
        }
    }
    Ok(current)
}

#[cfg(windows)]
fn absolute_path_components(path: &Path) -> Result<(PathBuf, Vec<OsString>)> {
    use std::path::{Component, Prefix};

    let mut iter = path.components();
    let prefix = match iter.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_)
            | Prefix::UNC(_, _)
            | Prefix::VerbatimDisk(_)
            | Prefix::VerbatimUNC(_, _) => prefix.as_os_str().to_os_string(),
            Prefix::DeviceNS(_) => {
                anyhow::bail!("artifact directory device namespace paths are unsupported")
            }
            Prefix::Verbatim(_) => {
                anyhow::bail!("artifact directory device namespace paths are unsupported")
            }
        },
        _ => anyhow::bail!("artifact directory must be an absolute drive path"),
    };
    anyhow::ensure!(
        matches!(iter.next(), Some(Component::RootDir)),
        "artifact directory must be an absolute drive path"
    );
    let mut anchor = PathBuf::from(prefix);
    anchor.push(Path::new(r"\"));
    let mut components = Vec::new();
    for component in iter {
        match component {
            Component::Normal(component) => components.push(component.to_os_string()),
            _ => anyhow::bail!("artifact directory contains an unsupported path component"),
        }
    }
    Ok((anchor, components))
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowsFailurePoint {
    AfterTemporaryCreate = 1,
    AfterTemporarySecurity = 2,
    BeforeRename = 3,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnixFailurePoint {
    AfterTemporaryCreate = 1,
    AfterTemporarySecurity = 2,
    DirectorySynced = 3,
}

#[cfg(all(unix, test))]
std::thread_local! {
    static UNIX_TEST_FAILURE_POINT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

#[cfg(unix)]
fn unix_test_failure_point(point: UnixFailurePoint) -> Result<()> {
    #[cfg(test)]
    if UNIX_TEST_FAILURE_POINT.with(|failure| {
        if failure.get() == point as u8 {
            failure.set(0);
            true
        } else {
            false
        }
    }) {
        anyhow::bail!("injected Unix private-file failure at {point:?}");
    }
    #[cfg(not(test))]
    let _ = point;
    Ok(())
}

#[cfg(all(windows, test))]
static WINDOWS_TEST_FAILURE_POINT: std::sync::atomic::AtomicU8 =
    std::sync::atomic::AtomicU8::new(0);
#[cfg(all(windows, test))]
static WINDOWS_TEST_PAUSE_BEFORE_RENAME: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
#[cfg(all(windows, test))]
static WINDOWS_TEST_RENAME_REACHED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
fn windows_test_failure_point(point: WindowsFailurePoint) -> Result<()> {
    #[cfg(test)]
    if WINDOWS_TEST_FAILURE_POINT.swap(0, Ordering::AcqRel) == point as u8 {
        anyhow::bail!("injected Windows private-file failure at {point:?}");
    }
    #[cfg(not(test))]
    let _ = point;
    Ok(())
}

#[cfg(windows)]
fn windows_test_before_rename() {
    #[cfg(test)]
    {
        WINDOWS_TEST_RENAME_REACHED.store(true, Ordering::Release);
        while WINDOWS_TEST_PAUSE_BEFORE_RENAME.load(Ordering::Acquire) {
            std::thread::yield_now();
        }
    }
}

fn validate_single_name(name: &OsStr) -> Result<()> {
    let path = Path::new(name);
    anyhow::ensure!(
        path.components().count() == 1
            && matches!(
                path.components().next(),
                Some(std::path::Component::Normal(_))
            ),
        "private file name must be one ordinary path component"
    );
    #[cfg(windows)]
    windows_native::validate_single_component(name)?;
    Ok(())
}

#[cfg(windows)]
fn append_private_file(parent: &File, name: &OsStr, bytes: &[u8]) -> Result<()> {
    let mut file = windows_native::open_or_create_append_file(parent, name)?;
    secure_private_handle(&file, false)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn open_regular_files(
    parent: &File,
    predicate: impl FnMut(&OsStr) -> bool,
) -> Result<Vec<(OsString, File)>> {
    windows_native::open_regular_files(parent, predicate)
}

#[cfg(windows)]
fn open_regular_file(parent: &File, name: &OsStr) -> Result<File> {
    windows_native::open_regular_file(parent, name).map_err(Into::into)
}

#[cfg(windows)]
fn create_unique_temporary_file(
    parent: &File,
    target_name: &OsStr,
) -> Result<windows_native::HandleDeleteGuard> {
    let target_name = target_name.to_string_lossy();
    for _ in 0..64 {
        let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = OsString::from(format!(
            ".{target_name}.{}.{}.tmp",
            std::process::id(),
            sequence
        ));
        match windows_native::create_new_file(parent, &temporary) {
            Ok(file) => return Ok(windows_native::HandleDeleteGuard::new(file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    anyhow::bail!("failed to allocate a unique artifact temporary file")
}

#[cfg(windows)]
fn sync_private_directory(_directory: &File) -> Result<()> {
    // Windows does not support fsync on directory handles; the replacement itself is issued
    // through the capability directory handle and the file content is flushed before rename.
    Ok(())
}

#[cfg(windows)]
fn secure_private_handle(file: &File, directory: bool) -> Result<()> {
    crate::set_and_verify_windows_user_only_handle(file, directory)
}

#[cfg(windows)]
mod windows_native {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_BOTH_DIR_INFORMATION, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE,
        FILE_OPEN, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION,
        FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS, FILE_SYNCHRONOUS_IO_NONALERT,
        FileBothDirectoryInformation, FileRenameInformation, FileRenameInformationEx, NtCreateFile,
        NtQueryDirectoryFile, NtSetInformationFile,
    };
    use windows_sys::Win32::Foundation::{
        ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED, GENERIC_READ,
        GENERIC_WRITE, HANDLE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
        STATUS_INVALID_INFO_CLASS, STATUS_INVALID_PARAMETER, STATUS_NO_MORE_FILES,
        STATUS_NOT_SUPPORTED, UNICODE_STRING,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_FLAG_DELETE,
        FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
        FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FileAttributeTagInfo, FileDispositionInfo,
        FileDispositionInfoEx, GetFileInformationByHandleEx, READ_CONTROL, SYNCHRONIZE,
        SetFileInformationByHandle, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    const TRAVERSE_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
    const DIRECTORY_ACCESS: u32 = FILE_LIST_DIRECTORY
        | FILE_READ_ATTRIBUTES
        | READ_CONTROL
        | WRITE_DAC
        | WRITE_OWNER
        | SYNCHRONIZE;
    const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;

    pub(super) fn validate_single_component(name: &OsStr) -> Result<()> {
        let encoded: Vec<u16> = name.encode_wide().collect();
        anyhow::ensure!(!encoded.is_empty(), "artifact path component is empty");
        anyhow::ensure!(
            encoded.len() <= (u16::MAX as usize / size_of::<u16>()),
            "artifact path component is too long"
        );
        anyhow::ensure!(
            !encoded.iter().any(|unit| {
                *unit < 32
                    || [
                        b'/' as u16,
                        b'\\' as u16,
                        b':' as u16,
                        b'<' as u16,
                        b'>' as u16,
                        b'"' as u16,
                        b'|' as u16,
                        b'?' as u16,
                        b'*' as u16,
                    ]
                    .contains(unit)
            }),
            "artifact path component contains a forbidden Windows character"
        );
        anyhow::ensure!(
            name != "." && name != "..",
            "artifact path component is relative"
        );
        let text = name.to_string_lossy();
        anyhow::ensure!(
            !text.ends_with('.') && !text.ends_with(' '),
            "artifact path component has a forbidden Windows suffix"
        );
        let stem = text
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || stem.strip_prefix("COM").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
            || stem.strip_prefix("LPT").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
        anyhow::ensure!(
            !reserved,
            "artifact path component is a reserved Windows name"
        );
        Ok(())
    }

    pub(super) fn open_absolute_directory(path: &Path) -> Result<File> {
        let mut options = std::fs::OpenOptions::new();
        options
            .access_mode(TRAVERSE_ACCESS)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        let file = options.open(path).with_context(|| {
            format!("failed to open artifact filesystem root {}", path.display())
        })?;
        ensure_not_reparse_point(&file)?;
        Ok(file)
    }

    pub(super) fn open_or_create_directory(
        parent: &File,
        name: &OsStr,
        create_missing: bool,
        secure_existing: bool,
    ) -> std::io::Result<(File, bool)> {
        validate_single_component(name).map_err(std::io::Error::other)?;
        let existing_access = if secure_existing {
            DIRECTORY_ACCESS
        } else {
            TRAVERSE_ACCESS
        };
        match nt_create_relative(
            parent,
            name,
            existing_access,
            FILE_OPEN,
            FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        ) {
            Ok(file) => {
                ensure_not_reparse_point(&file)?;
                Ok((file, false))
            }
            Err(error) if create_missing && error.kind() == std::io::ErrorKind::NotFound => {
                match nt_create_relative(
                    parent,
                    name,
                    DIRECTORY_ACCESS | DELETE,
                    FILE_CREATE,
                    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                ) {
                    Ok(file) => Ok((file, true)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        let file = nt_create_relative(
                            parent,
                            name,
                            existing_access,
                            FILE_OPEN,
                            FILE_DIRECTORY_FILE
                                | FILE_SYNCHRONOUS_IO_NONALERT
                                | FILE_OPEN_REPARSE_POINT,
                        )?;
                        ensure_not_reparse_point(&file)?;
                        Ok((file, false))
                    }
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    }

    pub(super) fn create_new_file(parent: &File, name: &OsStr) -> std::io::Result<File> {
        validate_single_component(name).map_err(std::io::Error::other)?;
        nt_create_relative(
            parent,
            name,
            GENERIC_READ
                | GENERIC_WRITE
                | READ_CONTROL
                | WRITE_DAC
                | WRITE_OWNER
                | DELETE
                | SYNCHRONIZE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        )
    }

    pub(super) fn open_or_create_append_file(parent: &File, name: &OsStr) -> std::io::Result<File> {
        validate_single_component(name).map_err(std::io::Error::other)?;
        let file = nt_create_relative(
            parent,
            name,
            FILE_APPEND_DATA
                | FILE_READ_ATTRIBUTES
                | READ_CONTROL
                | WRITE_DAC
                | WRITE_OWNER
                | SYNCHRONIZE,
            FILE_OPEN_IF,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        )?;
        ensure_not_reparse_point(&file)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other(
                "private append target is not a regular file",
            ));
        }
        Ok(file)
    }

    pub(super) fn open_regular_files(
        parent: &File,
        mut predicate: impl FnMut(&OsStr) -> bool,
    ) -> Result<Vec<(OsString, File)>> {
        let mut names = Vec::new();
        let mut restart = true;
        loop {
            let mut storage = vec![0usize; 8192];
            let byte_len = u32::try_from(storage.len() * size_of::<usize>())
                .expect("directory query buffer length fits u32");
            let mut io_status = IO_STATUS_BLOCK::default();
            let status = unsafe {
                NtQueryDirectoryFile(
                    parent.as_raw_handle() as HANDLE,
                    std::ptr::null_mut(),
                    None,
                    std::ptr::null(),
                    &mut io_status,
                    storage.as_mut_ptr().cast(),
                    byte_len,
                    FileBothDirectoryInformation,
                    false,
                    std::ptr::null(),
                    restart,
                )
            };
            restart = false;
            if status == STATUS_NO_MORE_FILES {
                break;
            }
            if status < 0 {
                return Err(std::io::Error::from_raw_os_error(unsafe {
                    RtlNtStatusToDosError(status)
                } as i32)
                .into());
            }
            let used = io_status.Information;
            if used == 0 {
                break;
            }
            let mut offset = 0usize;
            loop {
                anyhow::ensure!(
                    offset + size_of::<FILE_BOTH_DIR_INFORMATION>() <= used,
                    "Windows directory query returned a truncated entry"
                );
                let info = unsafe {
                    &*storage
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_BOTH_DIR_INFORMATION>()
                };
                let name_len = usize::try_from(info.FileNameLength)? / size_of::<u16>();
                let name = unsafe {
                    std::slice::from_raw_parts(
                        std::ptr::addr_of!(info.FileName).cast::<u16>(),
                        name_len,
                    )
                };
                names.push(OsString::from_wide(name));
                if info.NextEntryOffset == 0 {
                    break;
                }
                offset = offset
                    .checked_add(usize::try_from(info.NextEntryOffset)?)
                    .context("Windows directory entry offset overflow")?;
                anyhow::ensure!(offset < used, "Windows directory entry offset is invalid");
            }
        }

        let mut files = Vec::new();
        for name in names {
            if validate_single_component(&name).is_err() || !predicate(&name) {
                continue;
            }
            let file = match nt_create_relative(
                parent,
                &name,
                GENERIC_READ | READ_CONTROL | WRITE_DAC | WRITE_OWNER | SYNCHRONIZE,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            ) {
                Ok(file) => file,
                Err(_) => continue,
            };
            if ensure_not_reparse_point(&file).is_err()
                || !file.metadata().is_ok_and(|metadata| metadata.is_file())
                || super::secure_private_handle(&file, false).is_err()
            {
                continue;
            }
            files.push((name, file));
        }
        Ok(files)
    }

    pub(super) fn open_regular_file(parent: &File, name: &OsStr) -> std::io::Result<File> {
        validate_single_component(name).map_err(std::io::Error::other)?;
        let file = nt_create_relative(
            parent,
            name,
            GENERIC_READ | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        )?;
        ensure_not_reparse_point(&file)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other("target is not a regular file"));
        }
        Ok(file)
    }

    pub(super) fn open_read_write_file(
        parent: &File,
        name: &OsStr,
        create_new: bool,
    ) -> std::io::Result<File> {
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        validate_single_component(name).map_err(std::io::Error::other)?;
        let file = if create_new {
            self::create_new_file(parent, name)?
        } else {
            nt_create_relative(
                parent,
                name,
                GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            )?
        };
        ensure_not_reparse_point(&file)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other("update target is not a regular file"));
        }
        // SAFETY: the POD output is initialized and the owned file handle remains live.
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: the output points to a correctly sized live structure.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut information) }
            == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if information.nNumberOfLinks != 1 {
            return Err(std::io::Error::other(
                "update target must not have hard links",
            ));
        }
        Ok(file)
    }

    pub(super) fn remove_regular_file(parent: &File, name: &OsStr) -> std::io::Result<()> {
        validate_single_component(name).map_err(std::io::Error::other)?;
        let file = nt_create_relative(
            parent,
            name,
            DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            FILE_OPEN,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
        )?;
        ensure_not_reparse_point(&file)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::Error::other(
                "removal target is not a regular file",
            ));
        }
        let extended = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
        };
        // SAFETY: file owns the validated leaf handle and extended is a correctly sized buffer.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfoEx,
                (&extended as *const FILE_DISPOSITION_INFO_EX).cast(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } != 0
        {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.raw_os_error().map(|code| code as u32),
            Some(ERROR_INVALID_FUNCTION | ERROR_INVALID_PARAMETER | ERROR_NOT_SUPPORTED)
        ) {
            return Err(error);
        }
        // Only unsupported extended semantics fall back; access and readonly errors remain errors.
        let basic = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: file owns the validated leaf handle and basic is a correctly sized buffer.
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                (&basic as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn nt_create_relative(
        parent: &File,
        name: &OsStr,
        access: u32,
        disposition: u32,
        options: u32,
    ) -> std::io::Result<File> {
        let mut name: Vec<u16> = name.encode_wide().collect();
        let byte_len = name
            .len()
            .checked_mul(size_of::<u16>())
            .and_then(|length| u16::try_from(length).ok())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Windows component is too long",
                )
            })?;
        let unicode = UNICODE_STRING {
            Length: byte_len,
            MaximumLength: byte_len,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent.as_raw_handle() as HANDLE,
            ObjectName: &unicode,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: std::ptr::null(),
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut handle: HANDLE = std::ptr::null_mut();
        let mut io_status = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                access,
                &attributes,
                &mut io_status,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                SHARE_ALL,
                disposition,
                options,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            ));
        }
        if handle.is_null() {
            return Err(std::io::Error::other("NtCreateFile returned a null handle"));
        }
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    fn ensure_not_reparse_point(file: &File) -> std::io::Result<()> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as HANDLE,
                FileAttributeTagInfo,
                (&mut info as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "artifact directory component is a reparse point",
            ));
        }
        Ok(())
    }

    pub(super) fn rename_handle_relative(
        source: &File,
        target_parent: &File,
        target_name: &OsStr,
    ) -> std::io::Result<()> {
        validate_single_component(target_name).map_err(std::io::Error::other)?;
        let name: Vec<u16> = target_name.encode_wide().collect();
        let name_bytes = name
            .len()
            .checked_mul(size_of::<u16>())
            .ok_or_else(|| std::io::Error::other("rename buffer overflow"))?;
        let byte_len = size_of::<FILE_RENAME_INFORMATION>()
            .checked_add(name_bytes)
            .ok_or_else(|| std::io::Error::other("rename buffer overflow"))?;
        let byte_len = u32::try_from(byte_len)
            .map_err(|_| std::io::Error::other("rename buffer is too large"))?;
        let words = (byte_len as usize).div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; words];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
        unsafe {
            (*info).Anonymous.Flags = FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS;
            (*info).RootDirectory = target_parent.as_raw_handle() as HANDLE;
            (*info).FileNameLength = u32::try_from(name_bytes)
                .map_err(|_| std::io::Error::other("rename name is too long"))?;
            std::ptr::copy_nonoverlapping(
                name.as_ptr(),
                std::ptr::addr_of_mut!((*info).FileName).cast::<u16>(),
                name.len(),
            );
            std::ptr::addr_of_mut!((*info).FileName)
                .cast::<u16>()
                .add(name.len())
                .write(0);
        }
        let mut io_status = IO_STATUS_BLOCK::default();
        let mut status = unsafe {
            NtSetInformationFile(
                source.as_raw_handle() as HANDLE,
                &mut io_status,
                info.cast::<c_void>(),
                byte_len,
                FileRenameInformationEx,
            )
        };
        if matches!(
            status,
            STATUS_INVALID_INFO_CLASS | STATUS_INVALID_PARAMETER | STATUS_NOT_SUPPORTED
        ) {
            // Older filesystems retain legacy behavior; never bypass an access-denied result.
            unsafe {
                (*info).Anonymous.Flags = 0;
                (*info).Anonymous.ReplaceIfExists = true;
                status = NtSetInformationFile(
                    source.as_raw_handle() as HANDLE,
                    &mut io_status,
                    info.cast::<c_void>(),
                    byte_len,
                    FileRenameInformation,
                );
            }
        }
        if status < 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            ));
        }
        Ok(())
    }

    fn mark_handle_for_deletion(file: &File) -> std::io::Result<()> {
        let extended = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfoEx,
                (&extended as *const FILE_DISPOSITION_INFO_EX).cast(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        } != 0
        {
            return Ok(());
        }
        let basic = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                (&basic as *const FILE_DISPOSITION_INFO).cast(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) struct HandleDeleteGuard {
        file: Option<File>,
        armed: bool,
    }

    impl HandleDeleteGuard {
        pub(super) fn new(file: File) -> Self {
            Self {
                file: Some(file),
                armed: true,
            }
        }

        pub(super) fn file(&self) -> &File {
            self.file.as_ref().expect("guard always owns its file")
        }

        pub(super) fn file_mut(&mut self) -> &mut File {
            self.file.as_mut().expect("guard always owns its file")
        }

        pub(super) fn disarm(&mut self) {
            self.armed = false;
        }

        pub(super) fn into_file(mut self) -> File {
            self.armed = false;
            self.file.take().expect("guard always owns its file")
        }
    }

    impl Drop for HandleDeleteGuard {
        fn drop(&mut self) {
            if self.armed
                && let Some(file) = self.file.as_ref()
            {
                let _ = mark_handle_for_deletion(file);
            }
        }
    }
}

#[cfg(all(windows, test))]
#[path = "private_files/windows_acl_test_support.rs"]
mod windows_acl_test_support;

#[cfg(unix)]
struct TemporaryFileGuard {
    parent: File,
    name: Option<PathBuf>,
}

#[cfg(unix)]
impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        if let Some(name) = self.name.take() {
            let _ = remove_file(&self.parent, &name);
        }
    }
}

#[cfg(test)]
#[path = "private_files/tests.rs"]
mod tests;
