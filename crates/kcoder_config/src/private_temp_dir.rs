use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

const CREATE_ATTEMPTS: usize = 128;

#[derive(Debug)]
pub struct PrivateTempDir {
    path: PathBuf,
    #[cfg(windows)]
    handle: std::fs::File,
}

struct TrustedTempParent {
    #[cfg(not(windows))]
    path: PathBuf,
    #[cfg(windows)]
    handle: std::fs::File,
}

impl PrivateTempDir {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PrivateTempDir {
    fn drop(&mut self) {
        // The leaf is atomically created with user-only access beneath a
        // validated sticky/user-owned parent, so another OS principal cannot
        // replace it before this cleanup.
        #[cfg(not(windows))]
        let _ = std::fs::remove_dir_all(&self.path);
        #[cfg(windows)]
        {
            if let Ok(entries) = std::fs::read_dir(&self.path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let _ = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                        std::fs::remove_dir_all(path)
                    } else {
                        std::fs::remove_file(path)
                    };
                }
            }
            let _ = windows::delete_directory_handle(&self.handle);
        }
    }
}

/// Atomically create a new unpredictable, user-only directory below the
/// operating system temporary directory, or the verified private application
/// configuration directory when the Windows temporary parent is untrusted.
///
/// Existing leaf entries are never accepted. The returned path has already
/// been checked for ownership, permissions/ACL, and link-like file types.
pub fn create_private_temp_dir(prefix: &str) -> Result<PrivateTempDir> {
    anyhow::ensure!(
        !prefix.is_empty()
            && prefix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')),
        "private temporary directory prefix is not a safe component"
    );
    let parent = trusted_temp_parent()?;
    create_private_temp_dir_with_parent(&parent, prefix, |bytes| {
        getrandom::fill(bytes).map_err(|error| {
            anyhow::anyhow!("failed to obtain operating-system randomness: {error}")
        })
    })
}

fn create_private_temp_dir_with_parent(
    parent: &TrustedTempParent,
    prefix: &str,
    mut fill_random: impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<PrivateTempDir> {
    for _ in 0..CREATE_ATTEMPTS {
        let component = random_component(prefix, &mut fill_random)?;
        match create_private_dir_candidate(parent, &component) {
            Ok(created) => {
                return Ok(PrivateTempDir {
                    path: created.path,
                    #[cfg(windows)]
                    handle: created.handle,
                });
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists) => {}
            Err(error) => return Err(error),
        }
    }
    anyhow::bail!("failed to allocate a unique private temporary directory")
}

#[cfg(test)]
fn create_private_temp_dir_in_with(
    parent: &Path,
    prefix: &str,
    fill_random: impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<PrivateTempDir> {
    let parent = resolve_trusted_temp_parent(parent)?;
    create_private_temp_dir_with_parent(&parent, prefix, fill_random)
}

fn random_component(
    prefix: &str,
    fill_random: &mut impl FnMut(&mut [u8]) -> Result<()>,
) -> Result<String> {
    let mut random = [0u8; 16];
    fill_random(&mut random)?;
    let mut component = String::with_capacity(prefix.len() + 1 + random.len() * 2);
    component.push_str(prefix);
    component.push('-');
    for byte in random {
        use std::fmt::Write as _;
        write!(&mut component, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(component)
}

fn trusted_temp_parent() -> Result<TrustedTempParent> {
    #[cfg(windows)]
    {
        return trusted_temp_parent_with_fallback(
            &std::env::temp_dir(),
            crate::Settings::config_dir,
        );
    }
    #[cfg(not(windows))]
    resolve_trusted_temp_parent(&std::env::temp_dir())
}

#[cfg(any(windows, test))]
fn trusted_temp_parent_with_fallback(
    primary: &Path,
    fallback: impl FnOnce() -> Result<PathBuf>,
) -> Result<TrustedTempParent> {
    match resolve_trusted_temp_parent(primary) {
        Ok(parent) => Ok(parent),
        Err(primary_error) => {
            // Do not weaken ACL checks or rewrite an existing directory's ACL.
            // Both candidates must satisfy the same trusted-parent contract.
            resolve_trusted_temp_parent(&fallback()?).with_context(|| {
                format!("no trusted temporary parent; system temporary directory rejected: {primary_error}")
            })
        }
    }
}

#[cfg(not(windows))]
fn resolve_trusted_temp_parent(configured: &Path) -> Result<TrustedTempParent> {
    let original = std::fs::symlink_metadata(configured).with_context(|| {
        format!(
            "failed to inspect configured temporary directory {}",
            configured.display()
        )
    })?;
    anyhow::ensure!(
        original.is_dir() && !original.file_type().is_symlink(),
        "configured temporary directory is not an ordinary directory: {}",
        configured.display()
    );
    let parent = configured.canonicalize().with_context(|| {
        format!(
            "failed to resolve temporary directory {}",
            configured.display()
        )
    })?;
    validate_temp_parent(&parent)?;
    Ok(TrustedTempParent { path: parent })
}

#[cfg(unix)]
fn validate_temp_parent(parent: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;

    anyhow::ensure!(parent.is_absolute(), "temporary directory must be absolute");
    let effective_uid = unsafe { libc::geteuid() };
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).with_context(|| {
            format!(
                "failed to inspect temporary ancestor {}",
                ancestor.display()
            )
        })?;
        anyhow::ensure!(
            metadata.file_type().is_dir() && !metadata.file_type().is_symlink(),
            "temporary ancestor is not an ordinary directory: {}",
            ancestor.display()
        );
        anyhow::ensure!(
            metadata.uid() == 0 || metadata.uid() == effective_uid,
            "temporary ancestor has an untrusted owner: {}",
            ancestor.display()
        );
        let mode = metadata.mode();
        let shared_sticky_boundary = mode & 0o002 != 0 && mode & 0o1000 != 0;
        anyhow::ensure!(
            mode & 0o020 == 0 || shared_sticky_boundary,
            "temporary ancestor is group-writable without a sticky shared boundary: {}",
            ancestor.display()
        );
        anyhow::ensure!(
            mode & 0o002 == 0 || mode & 0o1000 != 0,
            "world-writable temporary ancestor lacks the sticky bit: {}",
            ancestor.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
fn create_private_dir_candidate(
    parent: &TrustedTempParent,
    component: &str,
) -> Result<CreatedPrivateDir> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};

    let path = parent.path.join(component);
    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    builder.create(&path).with_context(|| {
        format!(
            "failed to create private temporary directory {}",
            path.display()
        )
    })?;

    let cleanup_on_error = || {
        let _ = std::fs::remove_dir(&path);
    };
    let result = (|| -> Result<()> {
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&path)
            .with_context(|| {
                format!(
                    "failed to open private temporary directory {}",
                    path.display()
                )
            })?;
        let metadata = handle.metadata()?;
        let effective_uid = unsafe { libc::geteuid() };
        anyhow::ensure!(
            metadata.is_dir(),
            "private temporary leaf is not a directory"
        );
        anyhow::ensure!(
            metadata.uid() == effective_uid,
            "private temporary directory is not owned by the effective user"
        );
        anyhow::ensure!(
            metadata.permissions().mode() & 0o777 == 0o700,
            "private temporary directory permissions are not 0700"
        );
        Ok(())
    })();
    if let Err(error) = result {
        cleanup_on_error();
        return Err(error);
    }
    Ok(CreatedPrivateDir { path })
}

#[cfg(windows)]
fn resolve_trusted_temp_parent(configured: &Path) -> Result<TrustedTempParent> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ADD_SUBDIRECTORY, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL, SYNCHRONIZE,
    };

    anyhow::ensure!(
        configured.is_absolute(),
        "temporary directory must be absolute"
    );
    let mut options = std::fs::OpenOptions::new();
    options
        .access_mode(
            FILE_LIST_DIRECTORY
                | FILE_READ_ATTRIBUTES
                | FILE_ADD_SUBDIRECTORY
                | FILE_DELETE_CHILD
                | READ_CONTROL
                | SYNCHRONIZE,
        )
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let handle = options.open(configured).with_context(|| {
        format!(
            "failed to open configured temporary parent {}",
            configured.display()
        )
    })?;
    let metadata = handle.metadata()?;
    anyhow::ensure!(
        metadata.is_dir() && metadata.file_attributes() & 0x0400 == 0,
        "configured temporary parent handle is not an ordinary directory"
    );
    crate::file_permissions::verify_windows_trusted_parent_handle(&handle)?;

    let parent = windows::final_path_from_handle(&handle)?;
    for ancestor in parent.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).with_context(|| {
            format!(
                "failed to inspect temporary ancestor {}",
                ancestor.display()
            )
        })?;
        anyhow::ensure!(metadata.is_dir(), "temporary ancestor is not a directory");
        anyhow::ensure!(
            metadata.file_attributes() & 0x0400 == 0,
            "temporary ancestor is a reparse point: {}",
            ancestor.display()
        );
    }
    Ok(TrustedTempParent { handle })
}

#[cfg(windows)]
fn create_private_dir_candidate(
    parent: &TrustedTempParent,
    component: &str,
) -> Result<CreatedPrivateDir> {
    windows::create_private_dir_candidate(parent, component)
}

#[cfg(not(any(unix, windows)))]
fn validate_temp_parent(_parent: &Path) -> Result<()> {
    anyhow::bail!("private temporary directories are unsupported on this platform")
}

#[cfg(not(any(unix, windows)))]
fn create_private_dir_candidate(
    _parent: &TrustedTempParent,
    _component: &str,
) -> Result<CreatedPrivateDir> {
    anyhow::bail!("private temporary directories are unsupported on this platform")
}

struct CreatedPrivateDir {
    path: PathBuf,
    #[cfg(windows)]
    handle: std::fs::File,
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FILE_CREATE, FILE_DIRECTORY_FILE, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
        NtCreateFile,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, SET_ACCESS, SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        ACL, CONTAINER_INHERIT_ACE, GetTokenInformation, InitializeSecurityDescriptor,
        OBJECT_INHERIT_ACE, SECURITY_DESCRIPTOR, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFinalPathNameByHandleW,
        READ_CONTROL, SYNCHRONIZE, WRITE_DAC, WRITE_OWNER,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
    use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct SecurityOwner {
        token: HANDLE,
        dacl: *mut ACL,
        descriptor: SECURITY_DESCRIPTOR,
        _user: Vec<u8>,
    }

    impl Drop for SecurityOwner {
        fn drop(&mut self) {
            unsafe {
                let _ = windows_sys::Win32::Foundation::LocalFree(self.dacl.cast());
                CloseHandle(self.token);
            }
        }
    }

    fn current_user_security() -> Result<SecurityOwner> {
        let mut token = std::ptr::null_mut();
        anyhow::ensure!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0,
            "OpenProcessToken failed: {}",
            std::io::Error::last_os_error()
        );
        let result = (|| -> Result<SecurityOwner> {
            let mut needed = 0;
            unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
            anyhow::ensure!(needed != 0, "GetTokenInformation(TokenUser size) failed");
            let mut user = vec![0u8; needed as usize];
            anyhow::ensure!(
                unsafe {
                    GetTokenInformation(
                        token,
                        TokenUser,
                        user.as_mut_ptr().cast(),
                        needed,
                        &mut needed,
                    )
                } != 0,
                "GetTokenInformation(TokenUser) failed: {}",
                std::io::Error::last_os_error()
            );
            let sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
            let explicit = EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_ALL_ACCESS,
                grfAccessMode: SET_ACCESS,
                grfInheritance: CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: 0,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_USER,
                    ptstrName: sid.cast(),
                },
            };
            let mut dacl = std::ptr::null_mut();
            let acl_result = unsafe { SetEntriesInAclW(1, &explicit, std::ptr::null(), &mut dacl) };
            anyhow::ensure!(acl_result == 0, "SetEntriesInAclW failed: {acl_result}");
            let mut descriptor = SECURITY_DESCRIPTOR::default();
            if unsafe {
                InitializeSecurityDescriptor(
                    (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                    SECURITY_DESCRIPTOR_REVISION,
                )
            } == 0
                || unsafe {
                    SetSecurityDescriptorDacl(
                        (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                        1,
                        dacl,
                        0,
                    )
                } == 0
                || unsafe {
                    SetSecurityDescriptorControl(
                        (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                        windows_sys::Win32::Security::SE_DACL_PROTECTED,
                        windows_sys::Win32::Security::SE_DACL_PROTECTED,
                    )
                } == 0
            {
                let _ = unsafe { windows_sys::Win32::Foundation::LocalFree(dacl.cast()) };
                anyhow::bail!(
                    "failed to construct protected current-user security descriptor: {}",
                    std::io::Error::last_os_error()
                );
            }
            Ok(SecurityOwner {
                token,
                dacl,
                descriptor,
                _user: user,
            })
        })();
        if result.is_err() {
            unsafe { CloseHandle(token) };
        }
        result
    }

    pub(super) fn create_private_dir_candidate(
        parent: &TrustedTempParent,
        component: &str,
    ) -> Result<CreatedPrivateDir> {
        let security = current_user_security()?;
        let handle = nt_create_private_directory(&parent.handle, component, &security.descriptor)?;

        let result = (|| -> Result<()> {
            crate::set_and_verify_windows_user_only_handle(&handle, true)?;
            let verified = handle.metadata()?;
            anyhow::ensure!(
                verified.is_dir() && verified.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
                "private temporary directory handle is not an ordinary directory"
            );
            Ok(())
        })();
        if let Err(error) = result {
            let _ = delete_directory_handle(&handle);
            return Err(error);
        }
        let path = match final_path_from_handle(&handle) {
            Ok(path) => path,
            Err(error) => {
                let _ = delete_directory_handle(&handle);
                return Err(error.into());
            }
        };
        // Preserve the exact NtCreateFile handle: no pathname reopen is
        // permitted between relative creation, ACL verification, and RAII.
        Ok(CreatedPrivateDir { path, handle })
    }

    pub(super) fn final_path_from_handle(handle: &std::fs::File) -> std::io::Result<PathBuf> {
        let raw = handle.as_raw_handle() as HANDLE;
        let needed = unsafe { GetFinalPathNameByHandleW(raw, std::ptr::null_mut(), 0, 0) };
        if needed == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut path = vec![0u16; needed as usize + 1];
        let written =
            unsafe { GetFinalPathNameByHandleW(raw, path.as_mut_ptr(), path.len() as u32, 0) };
        if written == 0 || written as usize >= path.len() {
            return Err(std::io::Error::last_os_error());
        }
        path.truncate(written as usize);
        Ok(PathBuf::from(String::from_utf16_lossy(&path)))
    }

    fn nt_create_private_directory(
        parent: &std::fs::File,
        component: &str,
        descriptor: *const SECURITY_DESCRIPTOR,
    ) -> std::io::Result<std::fs::File> {
        use windows_sys::Win32::Foundation::{
            GENERIC_READ, GENERIC_WRITE, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
            UNICODE_STRING,
        };

        let mut name = std::ffi::OsStr::new(component)
            .encode_wide()
            .collect::<Vec<_>>();
        let byte_len = u16::try_from(name.len().saturating_mul(size_of::<u16>()))
            .map_err(|_| std::io::Error::other("private temp component is too long"))?;
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
            SecurityDescriptor: descriptor,
            SecurityQualityOfService: std::ptr::null(),
        };
        let mut handle: HANDLE = std::ptr::null_mut();
        let mut io_status = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtCreateFile(
                &mut handle,
                GENERIC_READ
                    | GENERIC_WRITE
                    | READ_CONTROL
                    | WRITE_DAC
                    | WRITE_OWNER
                    | DELETE
                    | SYNCHRONIZE,
                &attributes,
                &mut io_status,
                std::ptr::null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_CREATE,
                FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                std::ptr::null(),
                0,
            )
        };
        if status < 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(status) } as i32,
            ));
        }
        Ok(unsafe { std::fs::File::from_raw_handle(handle) })
    }

    pub(super) fn delete_directory_handle(handle: &std::fs::File) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO_EX, FileDispositionInfoEx,
            SetFileInformationByHandle,
        };

        let info = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        };
        if unsafe {
            SetFileInformationByHandle(
                handle.as_raw_handle() as _,
                FileDispositionInfoEx,
                (&info as *const FILE_DISPOSITION_INFO_EX).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_temp_directory_supports_ephemeral_session_artifacts() {
        let owner = create_private_temp_dir("kcoder-ephemeral-test").unwrap();
        let path = std::fs::canonicalize(owner.path()).unwrap();
        {
            // Windows canonicalization preserves the extended-length prefix used by ephemeral chat.
            let directory = crate::PrivateDirectory::open_existing(&path).unwrap();
            directory
                .atomic_replace(std::ffi::OsStr::new("history.jsonl"), b"{}\n")
                .unwrap();
            let artifacts = directory
                .open_child(std::ffi::OsStr::new("session"), true)
                .unwrap();
            artifacts
                .atomic_replace(std::ffi::OsStr::new("state.json"), b"{}")
                .unwrap();
            assert_eq!(std::fs::read(path.join("history.jsonl")).unwrap(), b"{}\n");
            assert_eq!(
                std::fs::read(path.join("session").join("state.json")).unwrap(),
                b"{}"
            );
        }
        drop(owner);
        assert!(!path.exists());
    }

    #[test]
    fn private_temp_fallback_is_validated_without_repairing_the_rejected_parent() {
        let root = tempfile::tempdir().unwrap();
        let rejected = root.path().join("not-a-directory");
        std::fs::write(&rejected, b"unchanged").unwrap();
        let fallback = root.path().join("private-parent");
        std::fs::create_dir(&fallback).unwrap();
        crate::set_user_only_dir_permissions(&fallback).unwrap();
        let parent = trusted_temp_parent_with_fallback(&rejected, || Ok(fallback.clone())).unwrap();
        let created = create_private_temp_dir_with_parent(&parent, "fallback", |bytes| {
            bytes.fill(7);
            Ok(())
        })
        .unwrap();
        assert!(created.path().starts_with(fallback.canonicalize().unwrap()));
        assert_eq!(std::fs::read(&rejected).unwrap(), b"unchanged");
        assert!(trusted_temp_parent_with_fallback(&rejected, || Ok(rejected.clone())).is_err());
        assert!(
            trusted_temp_parent_with_fallback(&fallback, || anyhow::bail!(
                "must not resolve an unused fallback"
            ))
            .is_ok()
        );
    }

    #[test]
    fn private_temp_directory_is_new_and_private() {
        let owner = create_private_temp_dir("kcoder-test").unwrap();
        let path = owner.path().to_path_buf();
        #[cfg(unix)]
        assert!(path.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        assert!(path.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let metadata = std::fs::metadata(&path).unwrap();
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
            assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
        }
        drop(owner);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn candidate_rejects_preexisting_symlink_without_touching_outside() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let marker = outside.path().join("marker");
        std::fs::write(&marker, b"unchanged").unwrap();
        symlink(outside.path(), parent.path().join("occupied")).unwrap();

        let parent = resolve_trusted_temp_parent(parent.path()).unwrap();
        assert!(create_private_dir_candidate(&parent, "occupied").is_err());
        assert_eq!(std::fs::read(marker).unwrap(), b"unchanged");
    }

    #[test]
    fn candidate_rejects_a_parent_file_and_returns_no_path() {
        let parent = tempfile::tempdir().unwrap();
        let file = parent.path().join("not-a-directory");
        std::fs::write(&file, b"unchanged").unwrap();

        assert!(resolve_trusted_temp_parent(&file).is_err());
        assert_eq!(std::fs::read(file).unwrap(), b"unchanged");
    }

    #[test]
    fn injected_entropy_retries_collisions_and_reports_exhaustion_and_rng_failure() {
        let parent = tempfile::tempdir().unwrap();
        let collision = random_component("retry", &mut |bytes: &mut [u8]| {
            bytes.fill(7);
            Ok(())
        })
        .unwrap();
        std::fs::create_dir(parent.path().join(&collision)).unwrap();
        let mut calls = 0usize;
        let owner = create_private_temp_dir_in_with(parent.path(), "retry", |bytes| {
            calls += 1;
            bytes.fill(if calls == 1 { 7 } else { 8 });
            Ok(())
        })
        .unwrap();
        assert_eq!(calls, 2);
        drop(owner);

        let exhausted = create_private_temp_dir_in_with(parent.path(), "retry", |bytes| {
            bytes.fill(7);
            Ok(())
        });
        assert!(exhausted.unwrap_err().to_string().contains("unique"));

        let rng_error = create_private_temp_dir_in_with(parent.path(), "retry", |_| {
            anyhow::bail!("injected RNG failure")
        });
        assert!(
            rng_error
                .unwrap_err()
                .to_string()
                .contains("injected RNG failure")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_untrusted_or_symlinked_configured_temp_parent() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = tempfile::tempdir().unwrap();
        let untrusted = root.path().join("untrusted");
        std::fs::create_dir(&untrusted).unwrap();
        std::fs::set_permissions(&untrusted, std::fs::Permissions::from_mode(0o770)).unwrap();
        assert!(resolve_trusted_temp_parent(&untrusted).is_err());

        let link = root.path().join("temp-link");
        symlink(&untrusted, &link).unwrap();
        assert!(resolve_trusted_temp_parent(&link).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_private_temp_directory_is_not_reparse_and_acl_is_enforced() {
        use std::os::windows::fs::MetadataExt;

        let owner = create_private_temp_dir("kcoder-test").unwrap();
        let path = owner.path().to_path_buf();
        assert_eq!(
            std::fs::symlink_metadata(&path).unwrap().file_attributes() & 0x0400,
            0
        );
        crate::set_user_only_dir_permissions(&path).unwrap();
        drop(owner);
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_original_reparse_parent_and_preexisting_reparse_leaf() {
        use std::os::windows::fs::symlink_dir;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let parent_link = root.path().join("temp-link");
        symlink_dir(outside.path(), &parent_link).unwrap();
        assert!(resolve_trusted_temp_parent(&parent_link).is_err());

        let occupied = root.path().join("occupied");
        symlink_dir(outside.path(), &occupied).unwrap();
        let trusted_root = resolve_trusted_temp_parent(root.path()).unwrap();
        assert!(create_private_dir_candidate(&trusted_root, "occupied").is_err());
        assert!(outside.path().exists());

        // The validated parent capability is the creation root even if its
        // pathname is replaced by a reparse point after validation.
        let parent_path = root.path().join("held-parent");
        let moved_path = root.path().join("held-parent-moved");
        std::fs::create_dir(&parent_path).unwrap();
        let trusted_parent = resolve_trusted_temp_parent(&parent_path).unwrap();
        std::fs::rename(&parent_path, &moved_path).unwrap();
        symlink_dir(outside.path(), &parent_path).unwrap();
        let created = create_private_dir_candidate(&trusted_parent, "same-handle").unwrap();
        assert!(moved_path.join("same-handle").is_dir());
        assert!(!outside.path().join("same-handle").exists());
        windows::delete_directory_handle(&created.handle).unwrap();
        drop(created);
        std::fs::remove_dir(&parent_path).unwrap();
    }
}
