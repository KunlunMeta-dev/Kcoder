//! Single-component handle-relative I/O never reparses a validated parent pathname.
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, bail};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE,
};

pub(super) const FILE_OPEN: u32 = 1;
pub(super) const FILE_CREATE: u32 = 2;
pub(super) const FILE_OPEN_IF: u32 = 3;
pub(super) const FILE_DIRECTORY_FILE: u32 = 1;
const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
const OBJ_CASE_INSENSITIVE: u32 = 0x40;
const FILE_RENAME_INFORMATION_EX: u32 = 65;
const FILE_RENAME_REPLACE_IF_EXISTS: u32 = 0x1;
const FILE_RENAME_POSIX_SEMANTICS: u32 = 0x2;

#[derive(Debug)]
pub(super) struct DirectoryLease {
    _handles: Vec<File>,
}

#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: *mut core::ffi::c_void,
    name: *const UnicodeString,
    attributes: u32,
    security: *mut core::ffi::c_void,
    qos: *mut core::ffi::c_void,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        handle: *mut *mut core::ffi::c_void,
        access: u32,
        attributes: *const ObjectAttributes,
        status: *mut usize,
        allocation: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *const core::ffi::c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

pub(super) fn open_relative(
    parent: &File,
    name: &OsStr,
    access: u32,
    disposition: u32,
    options: u32,
    share: u32,
) -> std::io::Result<File> {
    let wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty()
        || wide.len() > 32767
        || wide.iter().any(|c| matches!(*c, 0 | 47 | 92 | 58))
        || name == "."
        || name == ".."
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid PlanStore leaf",
        ));
    }
    let name = UnicodeString {
        length: (wide.len() * 2) as u16,
        maximum_length: (wide.len() * 2) as u16,
        buffer: wide.as_ptr(),
    };
    let attributes = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root: parent.as_raw_handle(),
        name: &name,
        attributes: OBJ_CASE_INSENSITIVE,
        security: std::ptr::null_mut(),
        qos: std::ptr::null_mut(),
    };
    let mut handle = std::ptr::null_mut();
    let mut status_block = [0usize; 2];
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE | FILE_READ_ATTRIBUTES,
            &attributes,
            status_block.as_mut_ptr(),
            std::ptr::null(),
            0,
            share,
            disposition,
            options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        return Err(std::io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    Ok(unsafe { File::from_raw_handle(handle) })
}

impl DirectoryLease {
    pub(super) fn acquire(path: &Path, create: bool) -> anyhow::Result<Self> {
        if !path.is_absolute() {
            bail!("PlanStore directory must be absolute");
        }
        let mut current = PathBuf::new();
        let mut handles: Vec<File> = Vec::new();
        for component in path.components() {
            match component {
                Component::Prefix(_) => {
                    current.push(component.as_os_str());
                    continue;
                }
                Component::RootDir | Component::Normal(_) => current.push(component.as_os_str()),
                _ => bail!("unsafe PlanStore directory component"),
            }
            let handle = if let Component::Normal(name) = component {
                open_relative(
                    handles.last().context("missing PlanStore ancestor")?,
                    name,
                    FILE_GENERIC_READ,
                    if create { FILE_OPEN_IF } else { FILE_OPEN },
                    FILE_DIRECTORY_FILE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                )?
            } else {
                OpenOptions::new()
                    .read(true)
                    // Descendants resolve against this handle, never through a reparsed path.
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&current)?
            };
            let metadata = handle.metadata()?;
            if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                bail!("unsafe PlanStore directory: {}", current.display());
            }
            handles.push(handle);
        }
        Ok(Self { _handles: handles })
    }

    pub(super) fn parent(path: &Path) -> anyhow::Result<Self> {
        Self::acquire(
            path.parent().context("PlanStore path has no parent")?,
            false,
        )
    }

    pub(super) fn handle(&self) -> &File {
        self._handles
            .last()
            .expect("absolute directory has root handle")
    }
}

pub(super) fn open_file(
    path: &Path,
    access: u32,
    disposition: u32,
    share: u32,
) -> anyhow::Result<File> {
    let lease = DirectoryLease::parent(path)?;
    let file = open_relative(
        lease.handle(),
        path.file_name().context("missing leaf")?,
        access,
        disposition,
        FILE_NON_DIRECTORY_FILE,
        share,
    )?;
    validate_file(&file)?;
    Ok(file)
}

pub(super) fn validate_file(file: &File) -> anyhow::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("unsafe PlanStore file handle");
    }
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if info.nNumberOfLinks != 1 {
        bail!("unsafe PlanStore hard-linked file");
    }
    Ok(())
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_WRITE, FILE_RENAME_INFO};
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSetInformationFile(
            file: *mut core::ffi::c_void,
            status: *mut usize,
            info: *const core::ffi::c_void,
            length: u32,
            class: u32,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }
    let lease = DirectoryLease::parent(path)?;
    let parent = path.parent().context("missing parent")?;
    let temporary = parent.join(format!(".planstore-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = open_relative(
        lease.handle(),
        temporary.file_name().context("missing temporary leaf")?,
        FILE_GENERIC_WRITE | DELETE,
        FILE_CREATE,
        FILE_NON_DIRECTORY_FILE,
        FILE_SHARE_READ,
    )?;
    let mut published = false;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        let name: Vec<u16> = path
            .file_name()
            .context("missing filename")?
            .encode_wide()
            .collect();
        let size = std::mem::offset_of!(FILE_RENAME_INFO, FileName) + name.len() * 2;
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // The aligned allocation includes the variable-length UTF-16 tail.
        unsafe {
            (*info).Anonymous.Flags = FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS;
            (*info).RootDirectory = lease
                ._handles
                .last()
                .context("missing directory handle")?
                .as_raw_handle();
            (*info).FileNameLength = (name.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(name.as_ptr(), (*info).FileName.as_mut_ptr(), name.len());
            let mut status_block = [0usize; 2];
            // FileRenameInformationEx allows atomic replacement while readers retain old handles.
            let status = NtSetInformationFile(
                file.as_raw_handle(),
                status_block.as_mut_ptr(),
                info.cast(),
                size as u32,
                FILE_RENAME_INFORMATION_EX,
            );
            if status < 0 {
                return Err(std::io::Error::from_raw_os_error(
                    RtlNtStatusToDosError(status) as i32,
                ))
                .context("failed to publish PlanStore file");
            }
        }
        published = true;
        super::maybe_fail_planstore_commit("after_windows_publish")?;
        file.sync_all()?;
        Ok(())
    })();
    if result.is_err() && !published {
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle,
        };
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            );
        }
    }
    drop(file);
    result
}
