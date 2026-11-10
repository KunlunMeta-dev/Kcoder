use super::*;
use std::{mem::size_of, os::windows::io::AsRawHandle};
use windows_sys::{
    Wdk::Storage::FileSystem::{
        FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, FileFsDeviceInformation,
        NtQueryVolumeInformationFile,
    },
    Win32::{
        Foundation::{HANDLE, RtlNtStatusToDosError},
        Storage::FileSystem::{
            DELETE, FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
            FILE_DISPOSITION_INFO_EX, FILE_READ_ATTRIBUTES, FileDispositionInfoEx,
            GetVolumeInformationByHandleW, READ_CONTROL, SYNCHRONIZE, SetFileInformationByHandle,
        },
        System::{IO::IO_STATUS_BLOCK, SystemServices::FILE_PERSISTENT_ACLS},
    },
};

fn open_mutation(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<File> {
    let file = super::super::windows_native::nt_create_relative(
        &parent.directory,
        name,
        DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
        FILE_OPEN,
        FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
    )?;
    verify(&file, expected, expected.kind())?;
    Ok(file)
}

pub(super) fn quarantine(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
    destination: &OsStr,
) -> Result<VerifiedPortableEntry> {
    let file = open_mutation(parent, name, expected)?;
    #[cfg(test)]
    super::tests::before_mutation();
    verify_named(parent, name, expected)?;
    // Rename the verified handle rather than reopening a pathname for the mutation.
    super::super::windows_native::rename_handle_relative_with_replace(
        &file,
        &parent.directory,
        destination,
        false,
    )?;
    verify(&file, expected, expected.kind())?;
    verify_named(parent, destination, expected)?;
    parent.sync()?;
    Ok(VerifiedPortableEntry {
        file,
        identity: expected.clone(),
    })
}

fn remove_held(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    let file = open_mutation(parent, name, expected)?;
    #[cfg(test)]
    super::tests::before_mutation();
    verify_named(parent, name, expected)?;
    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
    };
    // SAFETY: the held original handle grants DELETE and the immutable input buffer
    // is correctly sized. Readonly attributes are deliberately never ignored.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfoEx,
            (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
pub(super) fn remove_leaf(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    parent.portable_open_verified_regular(name, expected)?;
    remove_held(parent, name, expected)
}
pub(super) fn remove_empty_directory(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    let child = parent.portable_open_verified_child(name, expected)?;
    child.visit_entry_names_bounded(1, |_| anyhow::bail!("private directory is not empty"))?;
    remove_held(parent, name, expected)
}

#[repr(C)]
struct DeviceInformation {
    device_type: u32,
    characteristics: u32,
}
pub(super) fn filesystem_supported(file: &File) -> Result<bool> {
    let mut device = DeviceInformation {
        device_type: 0,
        characteristics: 0,
    };
    let mut io = IO_STATUS_BLOCK::default();
    // SAFETY: the NT FILE_FS_DEVICE_INFORMATION layout is two u32 values; the
    // owned handle and correctly sized output remain alive throughout the call.
    let status = unsafe {
        NtQueryVolumeInformationFile(
            file.as_raw_handle() as HANDLE,
            &mut io,
            (&mut device as *mut DeviceInformation).cast(),
            size_of::<DeviceInformation>() as u32,
            FileFsDeviceInformation,
        )
    };
    if status < 0 {
        return Err(std::io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32
        )
        .into());
    }
    // MS-FSCC 2.5.10 defines FILE_DEVICE_DISK=7; FILE_REMOTE_DEVICE=0x10. Network and unknown
    // devices cannot inherit the local NTFS retention contract from their name.
    if device.device_type != 7 || device.characteristics & 0x10 != 0 {
        return Ok(false);
    }
    let mut flags = 0;
    let mut filesystem = [0u16; 32];
    // SAFETY: optional outputs are null, and filesystem is a bounded writable buffer.
    if unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle() as HANDLE,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    let end = filesystem
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| anyhow::anyhow!("filesystem name not terminated"))?;
    Ok(flags & FILE_PERSISTENT_ACLS != 0 && String::from_utf16(&filesystem[..end])? == "NTFS")
}
