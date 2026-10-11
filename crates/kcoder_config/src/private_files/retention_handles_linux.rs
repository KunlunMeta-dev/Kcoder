use super::*;
use kcoder_types::PrivateNativeFileIdentity;
use std::collections::HashSet;
use std::ffi::CString;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;

pub(super) fn identity(file: &File, kind: PrivateFileKind) -> Result<PrivateFileIdentityV1> {
    identity_with_links(file, kind, 1)
}

fn identity_with_links(
    file: &File,
    kind: PrivateFileKind,
    links: u64,
) -> Result<PrivateFileIdentityV1> {
    let metadata = file.metadata()?;
    // SAFETY: geteuid has no pointer arguments or memory side effects.
    let uid = unsafe { libc::geteuid() };
    anyhow::ensure!(
        metadata.uid() == uid,
        "private object belongs to another uid"
    );
    anyhow::ensure!(
        metadata.mode() & 0o077 == 0,
        "private object exposes group/other permissions"
    );
    anyhow::ensure!(
        metadata.mode() & 0o7000 == 0,
        "private object has special permission bits"
    );
    match kind {
        PrivateFileKind::RegularFile => {
            anyhow::ensure!(metadata.is_file(), "private object must be regular");
            anyhow::ensure!(
                metadata.nlink() == links,
                "private object must not have hard links"
            );
        }
        PrivateFileKind::Directory => {
            anyhow::ensure!(metadata.is_dir(), "private object must be a directory")
        }
    }
    Ok(PrivateFileIdentityV1 {
        version: PrivateFileIdentityV1::VERSION,
        kind,
        native: PrivateNativeFileIdentity::Linux {
            device: metadata.dev(),
            inode: metadata.ino(),
        },
    })
}

pub(super) fn anonymous(
    parent: &PrivateDirectory,
    parent_identity: PrivateFileIdentityV1,
) -> Result<AnonymousPrivateEntry> {
    // O_EXCL must not be combined with O_TMPFILE: it would prohibit linking.
    // SAFETY: owned directory FD, constant NUL-terminated relative name/mode.
    let fd = unsafe {
        libc::openat(
            parent.directory.as_raw_fd(),
            c".".as_ptr(),
            libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: openat returned a new owned FD, transferred exactly once.
    let file = unsafe { File::from_raw_fd(fd) };
    let identity = identity_with_links(&file, PrivateFileKind::RegularFile, 0)?;
    anyhow::ensure!(
        file.metadata()?.mode() & 0o777 == 0o600,
        "anonymous manifest mode mismatch"
    );
    Ok(AnonymousPrivateEntry {
        file,
        identity,
        parent: parent_identity,
    })
}

pub(super) fn publish_anonymous(
    parent: &PrivateDirectory,
    entry: &AnonymousPrivateEntry,
    name: &OsStr,
) -> Result<VerifiedPrivateEntry> {
    anyhow::ensure!(
        identity_with_links(&entry.file, PrivateFileKind::RegularFile, 0)? == entry.identity,
        "anonymous manifest identity changed"
    );
    let proc_name = CString::new(format!("/proc/self/fd/{}", entry.file.as_raw_fd()))?;
    let target = CString::new(name.as_bytes())?;
    // SAFETY: valid descriptors and NUL-terminated names. linkat never replaces
    // an existing name; procfd resolution avoids AT_EMPTY_PATH privileges.
    if unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            proc_name.as_ptr(),
            parent.directory.as_raw_fd(),
            target.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    verify(&entry.file, &entry.identity, PrivateFileKind::RegularFile)?;
    parent.open_verified_regular(name, &entry.identity)?;
    Ok(VerifiedPrivateEntry {
        file: entry.file.try_clone()?,
        identity: entry.identity.clone(),
    })
}

pub(super) fn remove_leaf(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PrivateFileIdentityV1,
) -> Result<PrivateManifestRemoval> {
    unlink_leaf(parent, name, expected)?;
    Ok(PrivateManifestRemoval {
        removed: vec![name.to_owned()],
        failure: parent.sync().err(),
    })
}

pub(super) fn unlink_leaf(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PrivateFileIdentityV1,
) -> Result<()> {
    let opened = parent.open_verified_regular(name, expected)?;
    verify(opened.file(), expected, PrivateFileKind::RegularFile)?;
    cap_primitives::fs::remove_file(&parent.directory, std::path::Path::new(name))?;
    Ok(())
}

fn open_entry(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PrivateFileIdentityV1,
) -> Result<File> {
    let file = match expected.kind {
        PrivateFileKind::RegularFile => parent.open_regular_file(name)?,
        PrivateFileKind::Directory => parent.open_child(name, false)?.directory,
    };
    verify(&file, expected, expected.kind)?;
    Ok(file)
}

pub(super) fn quarantine(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PrivateFileIdentityV1,
    destination: &OsStr,
) -> Result<VerifiedPrivateEntry> {
    quarantine_inner(parent, name, expected, destination, true)
}

pub(super) fn quarantine_inner(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PrivateFileIdentityV1,
    destination: &OsStr,
    sync: bool,
) -> Result<VerifiedPrivateEntry> {
    let original = open_entry(parent, name, expected)?;
    #[cfg(test)]
    super::tests::before_quarantine();
    let source = CString::new(name.as_bytes())?;
    let target = CString::new(destination.as_bytes())?;
    // SAFETY: both descriptors remain owned here; validated single-component
    // names are NUL-terminated and the kernel never replaces target.
    let result = unsafe {
        libc::renameat2(
            parent.directory.as_raw_fd(),
            source.as_ptr(),
            parent.directory.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let moved = open_entry(parent, destination, expected)?;
    verify(&original, expected, expected.kind)?;
    if sync {
        parent.sync()?;
    }
    Ok(VerifiedPrivateEntry {
        file: moved,
        identity: expected.clone(),
    })
}

fn names_bounded(directory: &PrivateDirectory, limit: usize) -> Result<Vec<OsString>> {
    let mut names = Vec::new();
    for item in cap_primitives::fs::read_base_dir(&directory.directory)? {
        let name = item?.file_name();
        if name == OsStr::new(".") || name == OsStr::new("..") {
            continue;
        }
        validate_single_name(&name)?;
        anyhow::ensure!(
            names.len() < limit,
            "private directory exceeds manifest bound"
        );
        names.push(name);
    }
    Ok(names)
}

pub(super) fn remove_manifest(
    parent: &PrivateDirectory,
    manifest: &[PrivateRemovalEntry],
) -> Result<PrivateManifestRemoval> {
    let mut allowed = HashSet::new();
    for entry in manifest {
        validate_single_name(&entry.name)?;
        anyhow::ensure!(
            allowed.insert(entry.name.clone()),
            "duplicate manifest leaf"
        );
        parent.open_verified_regular(&entry.name, &entry.identity)?;
    }
    for name in names_bounded(parent, 32)? {
        anyhow::ensure!(
            allowed.contains(&name),
            "private directory contains an unregistered child"
        );
    }
    let mut outcome = PrivateManifestRemoval {
        removed: Vec::new(),
        failure: None,
    };
    for entry in manifest {
        let operation = (|| -> Result<()> {
            let quarantined = parent.open_verified_regular(&entry.name, &entry.identity)?;
            verify(
                quarantined.file(),
                &entry.identity,
                PrivateFileKind::RegularFile,
            )?;
            cap_primitives::fs::remove_file(&parent.directory, std::path::Path::new(&entry.name))?;
            outcome.removed.push(entry.name.clone());
            parent.sync()?;
            Ok(())
        })();
        if let Err(error) = operation {
            outcome.failure = Some(error);
            break;
        }
    }
    Ok(outcome)
}

pub(super) fn remove_empty_directory(
    parent: &PrivateDirectory,
    name: &OsStr,
    expected: &PrivateFileIdentityV1,
) -> Result<()> {
    let child = parent.open_verified_child(name, expected)?;
    anyhow::ensure!(
        names_bounded(&child, 1)?.is_empty(),
        "private directory is not empty"
    );
    parent.open_verified_child(name, expected)?;
    cap_primitives::fs::remove_dir(&parent.directory, std::path::Path::new(name))?;
    parent.sync()
}

pub(super) fn filesystem_supported(file: &File) -> Result<bool> {
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: a valid owned FD and correctly sized output pointer are supplied.
    if unsafe { libc::fstatfs(file.as_raw_fd(), info.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: successful fstatfs initialized the output.
    let info = unsafe { info.assume_init() };
    // Deliberately exclude tmpfs, overlay and all unknown/network filesystems.
    // The actual journal must also prove its durable root and native operations.
    Ok(matches!(
        info.f_type as u64,
        0xef53 | 0x58465342 | 0x9123683e
    ))
}
