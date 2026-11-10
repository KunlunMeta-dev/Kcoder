use super::*;
use std::{
    ffi::CString,
    os::{fd::AsRawFd, unix::ffi::OsStrExt},
};

pub(super) fn quarantine(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
    destination: &OsStr,
) -> Result<VerifiedPortableEntry> {
    let file = match expected.kind() {
        PrivateFileKind::RegularFile => parent.portable_open_verified_regular(name, expected)?.file,
        PrivateFileKind::Directory => {
            parent
                .portable_open_verified_child(name, expected)?
                .directory
        }
    };
    #[cfg(test)]
    super::tests::before_mutation();
    verify_named(parent, name, expected)?;
    let source = CString::new(name.as_bytes())?;
    let target = CString::new(destination.as_bytes())?;
    // SAFETY: both validated names are relative to the held private parent. No-replace
    // forbids overwriting an unrelated destination; the lifecycle guard excludes peers.
    if unsafe {
        libc::renameat2(
            parent.directory.as_raw_fd(),
            source.as_ptr(),
            parent.directory.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    verify(&file, expected, expected.kind())?;
    verify_named(parent, destination, expected)?;
    parent.sync()?;
    Ok(VerifiedPortableEntry {
        file,
        identity: expected.clone(),
    })
}
pub(super) fn remove_leaf(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    let held = parent.portable_open_verified_regular(name, expected)?;
    #[cfg(test)]
    super::tests::before_mutation();
    verify_named(parent, name, expected)?;
    verify(held.file(), expected, PrivateFileKind::RegularFile)?;
    cap_primitives::fs::remove_file(&parent.directory, std::path::Path::new(name))?;
    Ok(())
}
pub(super) fn remove_empty_directory(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PortableLeaseIdentity,
) -> Result<()> {
    let child = parent.portable_open_verified_child(name, expected)?;
    child.visit_entry_names_bounded(1, |_| anyhow::bail!("private directory is not empty"))?;
    #[cfg(test)]
    super::tests::before_mutation();
    verify_named(parent, name, expected)?;
    cap_primitives::fs::remove_dir(&parent.directory, std::path::Path::new(name))?;
    Ok(())
}
pub(super) fn filesystem_supported(file: &File) -> Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: a live held fd and correctly sized output storage are supplied.
    if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful fstatfs initialized the output.
    let info = unsafe { info.assume_init() };
    Ok(matches!(
        info.f_type as u64,
        0xef53 | 0x58465342 | 0x9123683e
    ))
}
