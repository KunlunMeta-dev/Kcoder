//! Protect only pinned files of the original in-flight namespace creation.
use super::*;
use std::{
    mem::{size_of, zeroed},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::{
    Foundation::{ERROR_SUCCESS, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, LocalFree},
    Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, INHERITED_ACE, OWNER_SECURITY_INFORMATION, SE_DACL_PROTECTED,
    },
    Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL,
        ReOpenFile, WRITE_DAC, WRITE_OWNER,
    },
    System::{SystemServices::ACCESS_ALLOWED_ACE_TYPE, Threading::GetCurrentProcess},
};

pub fn seal_created_files(
    directory: &PrivateDirectory,
    data: &PrivateDirectory,
    files: &BTreeMap<String, (File, PortableLeaseIdentity)>,
) -> Result<()> {
    ensure!(
        [
            "binding",
            "connectivity.sqlite3",
            "connectivity.lock",
            "connectivity.ready.json"
        ]
        .iter()
        .all(|name| files.contains_key(*name)),
        "CONNECTIVITY_CREATED_FILE_WITNESS_REQUIRED"
    );
    for (name, (file, original)) in files {
        let (parent, name) = if name == "binding" {
            (directory, OsStr::new("data.binding.json"))
        } else {
            (data, OsStr::new(name))
        };
        ensure!(
            PortableLeaseIdentity::from_regular_handle(file)? == *original
                && PortableLeaseIdentity::from_regular_handle(
                    &parent.open_single_link_regular_file(name)?
                )? == *original,
            "CONNECTIVITY_CREATED_FILE_CHANGED"
        );
        if parent.portable_regular_handle_identity(file).is_err() {
            protect_inherited_creation(file)?;
        }
        ensure!(
            parent.portable_regular_handle_identity(file)? == *original
                && parent.portable_regular_identity(name)? == *original,
            "CONNECTIVITY_CREATED_FILE_CHANGED"
        );
    }
    Ok(())
}

fn protect_inherited_creation(file: &File) -> Result<()> {
    let original = PortableLeaseIdentity::from_regular_handle(file)?;
    // SAFETY: ReOpenFile addresses the held original regular file object. It
    // does not resolve a caller path or open a different named file.
    let raw = unsafe {
        ReOpenFile(
            file.as_raw_handle().cast(),
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            0,
        )
    };
    ensure!(
        raw != INVALID_HANDLE_VALUE && !raw.is_null(),
        "CONNECTIVITY_CREATED_FILE_SECURITY_HANDLE_UNAVAILABLE"
    );
    let handle = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
    let writable: File = handle.into();
    ensure!(
        PortableLeaseIdentity::from_regular_handle(&writable)? == original,
        "CONNECTIVITY_CREATED_FILE_CHANGED"
    );
    verify_inherited_current_user(&writable)?;
    kcoder_config::set_and_verify_windows_user_only_handle(&writable, false)?;
    writable.sync_all()?;
    ensure!(
        PortableLeaseIdentity::from_regular_handle(&writable)? == original,
        "CONNECTIVITY_CREATED_FILE_CHANGED"
    );
    Ok(())
}

fn verify_inherited_current_user(file: &File) -> Result<()> {
    let sid = kcoder_native_scope::service_identity::process_sid(unsafe { GetCurrentProcess() })?;
    let mut descriptor = std::ptr::null_mut();
    let mut owner = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    // SAFETY: the live held file has READ_CONTROL and outputs have the exact API types.
    let result = unsafe {
        GetSecurityInfo(
            file.as_raw_handle().cast(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    ensure!(
        result == ERROR_SUCCESS,
        "CONNECTIVITY_CREATED_FILE_SECURITY_UNAVAILABLE"
    );
    let checked = (|| -> Result<()> {
        ensure!(
            !owner.is_null()
                && !dacl.is_null()
                && unsafe { EqualSid(owner, sid.as_ptr().cast_mut().cast()) } != 0,
            "CONNECTIVITY_CREATED_FILE_OWNER_CHANGED"
        );
        let mut flags = 0u16;
        let mut revision = 0u32;
        ensure!(
            unsafe { GetSecurityDescriptorControl(descriptor, &mut flags, &mut revision) } != 0
                && flags & SE_DACL_PROTECTED == 0,
            "CONNECTIVITY_CREATED_FILE_NOT_INHERITED"
        );
        let mut info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
        ensure!(
            unsafe {
                GetAclInformation(
                    dacl,
                    (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            } != 0
                && info.AceCount == 1,
            "CONNECTIVITY_CREATED_FILE_NOT_EXCLUSIVE"
        );
        let mut raw = std::ptr::null_mut();
        ensure!(
            unsafe { GetAce(dacl, 0, &mut raw) } != 0 && !raw.is_null(),
            "CONNECTIVITY_CREATED_FILE_SECURITY_UNAVAILABLE"
        );
        // SAFETY: GetAce supplies a valid ACE header from the OS-owned ACL.
        let header = unsafe { &*raw.cast::<ACE_HEADER>() };
        ensure!(
            header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
                && header.AceSize as usize >= size_of::<ACCESS_ALLOWED_ACE>() + 4,
            "CONNECTIVITY_CREATED_FILE_NOT_PRIVATE_INHERITANCE"
        );
        // SAFETY: the allowed-ACE type and minimum SID storage were checked above.
        let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
        ensure!(
            ace.Header.AceSize as usize >= size_of::<ACCESS_ALLOWED_ACE>()
                && ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
                && ace.Header.AceFlags == INHERITED_ACE as u8
                && ace.Mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS
                && unsafe {
                    EqualSid(
                        std::ptr::addr_of!(ace.SidStart).cast_mut().cast(),
                        sid.as_ptr().cast_mut().cast(),
                    )
                } != 0,
            "CONNECTIVITY_CREATED_FILE_NOT_PRIVATE_INHERITANCE"
        );
        Ok(())
    })();
    unsafe { LocalFree(descriptor) };
    checked
}

/// Owned Main startup may prepare volatile SQLite coordination files after the
/// original database/namespace receipt and exclusive kernel lease were verified.
/// Existing files must already be private; this never repairs an existing ACL.
pub fn prepare_sidecars(
    data: &PrivateDirectory,
) -> Result<BTreeMap<String, (File, PortableLeaseIdentity)>> {
    let mut files = BTreeMap::new();
    for name in ["connectivity.sqlite3-wal", "connectivity.sqlite3-shm"] {
        let leaf = OsStr::new(name);
        let file = match data.open_single_link_regular_file(leaf) {
            Ok(file) => file,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                let created = data.open_read_write_file(leaf, true)?;
                created.sync_all()?;
                let original = PortableLeaseIdentity::from_regular_handle(&created)?;
                // The generic creator also owns DELETE. SQLite's Windows VFS
                // does not share delete access, so retain only this same file's
                // read/query rights after its original creation has been synced.
                // SAFETY: ReOpenFile uses the held original object, not a path.
                let raw = unsafe {
                    ReOpenFile(
                        created.as_raw_handle().cast(),
                        GENERIC_READ | READ_CONTROL,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                        0,
                    )
                };
                ensure!(
                    raw != INVALID_HANDLE_VALUE && !raw.is_null(),
                    "CONNECTIVITY_SQLITE_SIDECAR_REOPEN_UNAVAILABLE"
                );
                // SAFETY: ReOpenFile returned a new non-inherited owned handle.
                let file: File = unsafe { OwnedHandle::from_raw_handle(raw.cast()) }.into();
                ensure!(
                    PortableLeaseIdentity::from_regular_handle(&file)? == original,
                    "CONNECTIVITY_PRIVATE_FILE_CHANGED"
                );
                drop(created);
                file
            }
            Err(error) => return Err(error),
        };
        let identity = data.portable_regular_handle_identity(&file)?;
        ensure!(
            data.portable_regular_identity(leaf)? == identity,
            "CONNECTIVITY_PRIVATE_FILE_CHANGED"
        );
        files.insert(name.to_owned(), (file, identity));
    }
    Ok(files)
}
