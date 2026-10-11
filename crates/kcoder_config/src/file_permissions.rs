use anyhow::{Context, Result};
#[cfg(unix)]
use std::fs;
use std::path::Path;

/// Restrict a file to the current operating-system user.
///
/// On Windows this also verifies the effective ACL because network
/// filesystems can report a successful ACL update without enforcing it.
#[cfg(unix)]
pub fn set_user_only_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to set private file permissions on {:?}", path))
}

/// Restrict a directory to the current operating-system user.
#[cfg(unix)]
pub fn set_user_only_dir_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to set private directory permissions on {:?}", path))
}

#[cfg(test)]
fn windows_sid_from_whoami(text: &str) -> Option<String> {
    let start = text.find("S-1-")?;
    let sid = text[start..]
        .chars()
        .take_while(|ch| *ch == 'S' || ch.is_ascii_digit() || *ch == '-')
        .collect::<String>();
    let components = sid.strip_prefix("S-1-")?;
    (!components.is_empty()
        && components.split('-').all(|component| {
            !component.is_empty() && component.chars().all(|ch| ch.is_ascii_digit())
        }))
    .then_some(sid)
}

#[cfg(windows)]
pub fn set_user_only_file_permissions(path: &Path) -> Result<()> {
    set_windows_user_only_permissions(path, false)
}

#[cfg(windows)]
pub fn set_user_only_dir_permissions(path: &Path) -> Result<()> {
    set_windows_user_only_permissions(path, true)
}

#[cfg(windows)]
fn set_windows_user_only_permissions(path: &Path, inheritable: bool) -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, READ_CONTROL, WRITE_DAC,
        WRITE_OWNER,
    };

    let mut options = std::fs::OpenOptions::new();
    options
        .access_mode(READ_CONTROL | WRITE_DAC | WRITE_OWNER)
        .custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if inheritable {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
    let file = options
        .open(path)
        .with_context(|| format!("failed to open Windows private object {}", path.display()))?;
    set_and_verify_windows_user_only_handle(&file, inheritable)
}

#[cfg(windows)]
pub fn set_and_verify_windows_user_only_handle(
    file: &std::fs::File,
    directory: bool,
) -> Result<()> {
    windows_acl::set_and_verify(file, directory)
}

#[cfg(windows)]
pub(crate) fn verify_windows_trusted_parent_handle(file: &std::fs::File) -> Result<()> {
    windows_acl::verify_trusted_parent(file)
}

#[cfg(windows)]
mod windows_acl {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, LocalFree};
    use windows_sys::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, GetSecurityInfo, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW,
        SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, GetTokenInformation, IsWellKnownSid, OBJECT_INHERIT_ACE,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        TOKEN_QUERY, TOKEN_USER, TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ADD_SUBDIRECTORY, FILE_ALL_ACCESS, FILE_DELETE_CHILD,
    };
    use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    pub(super) fn set_and_verify(file: &std::fs::File, directory: bool) -> Result<()> {
        let token = current_token()?;
        let user = token_user(token.0)?;
        let sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
        let inheritance = if directory {
            CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
        } else {
            0
        };
        let explicit = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: inheritance,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_USER,
                ptstrName: sid.cast(),
            },
        };
        let mut dacl = std::ptr::null_mut();
        let result = unsafe { SetEntriesInAclW(1, &explicit, std::ptr::null(), &mut dacl) };
        anyhow::ensure!(result == ERROR_SUCCESS, "SetEntriesInAclW failed: {result}");
        let handle = file.as_raw_handle() as HANDLE;
        let set = unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                sid,
                std::ptr::null_mut(),
                dacl,
                std::ptr::null_mut(),
            )
        };
        unsafe { LocalFree(dacl.cast()) };
        anyhow::ensure!(set == ERROR_SUCCESS, "SetSecurityInfo failed: {set}");
        verify(file, sid, inheritance as u8)
    }

    fn verify(file: &std::fs::File, sid: *mut c_void, flags: u8) -> Result<()> {
        let mut descriptor = std::ptr::null_mut();
        let mut owner = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let result = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        anyhow::ensure!(result == ERROR_SUCCESS, "GetSecurityInfo failed: {result}");
        let checked = (|| -> Result<()> {
            anyhow::ensure!(
                unsafe { EqualSid(owner, sid) } != 0,
                "private object owner is not current user"
            );
            anyhow::ensure!(!dacl.is_null(), "private object has null DACL");
            let mut control = 0u16;
            let mut revision = 0u32;
            anyhow::ensure!(
                unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
                    != 0
                    && control & SE_DACL_PROTECTED != 0,
                "private DACL is not protected"
            );
            let mut info = ACL_SIZE_INFORMATION::default();
            anyhow::ensure!(
                unsafe {
                    GetAclInformation(
                        dacl,
                        (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                        std::mem::size_of_val(&info) as u32,
                        AclSizeInformation,
                    )
                } != 0
                    && info.AceCount == 1,
                "private DACL is not exclusive"
            );
            let mut raw = std::ptr::null_mut();
            anyhow::ensure!(unsafe { GetAce(dacl, 0, &mut raw) } != 0, "GetAce failed");
            let ace = unsafe { &*(raw as *const ACCESS_ALLOWED_ACE) };
            let ace_sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast::<c_void>();
            anyhow::ensure!(
                ace.Header.AceType == ACCESS_ALLOWED_ACE_TYPE as u8
                    && ace.Header.AceFlags == flags
                    && ace.Mask & FILE_ALL_ACCESS == FILE_ALL_ACCESS
                    && unsafe { EqualSid(ace_sid, sid) } != 0,
                "private DACL ACE is not current-user-only"
            );
            Ok(())
        })();
        unsafe { LocalFree(descriptor) };
        checked
    }

    pub(super) fn verify_trusted_parent(file: &std::fs::File) -> Result<()> {
        let token = current_token()?;
        let user = token_user(token.0)?;
        let current_sid = unsafe { (*(user.as_ptr() as *const TOKEN_USER)).User.Sid };
        let mut descriptor = std::ptr::null_mut();
        let mut owner = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let result = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        anyhow::ensure!(
            result == ERROR_SUCCESS,
            "GetSecurityInfo(parent) failed: {result}"
        );
        let checked = (|| -> Result<()> {
            anyhow::ensure!(
                trusted_sid(owner, current_sid),
                "temporary parent owner is untrusted"
            );
            anyhow::ensure!(!dacl.is_null(), "temporary parent has null DACL");
            let mut info = ACL_SIZE_INFORMATION::default();
            anyhow::ensure!(
                unsafe {
                    GetAclInformation(
                        dacl,
                        (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                        std::mem::size_of_val(&info) as u32,
                        AclSizeInformation,
                    )
                } != 0,
                "GetAclInformation(parent) failed"
            );
            let mut current_access = 0u32;
            for index in 0..info.AceCount {
                let mut raw = std::ptr::null_mut();
                anyhow::ensure!(
                    unsafe { GetAce(dacl, index, &mut raw) } != 0,
                    "GetAce(parent) failed"
                );
                let ace = unsafe { &*(raw as *const ACCESS_ALLOWED_ACE) };
                if ace.Header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8 {
                    continue;
                }
                let ace_sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast::<c_void>();
                anyhow::ensure!(
                    trusted_sid(ace_sid, current_sid),
                    "temporary parent grants an untrusted principal"
                );
                if unsafe { EqualSid(ace_sid, current_sid) } != 0 {
                    current_access |= ace.Mask;
                }
            }
            anyhow::ensure!(
                current_access & (FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD)
                    == FILE_ADD_SUBDIRECTORY | FILE_DELETE_CHILD,
                "temporary parent lacks current-user create/delete-child access"
            );
            Ok(())
        })();
        unsafe { LocalFree(descriptor) };
        checked
    }

    fn trusted_sid(candidate: *mut c_void, current: *mut c_void) -> bool {
        unsafe {
            EqualSid(candidate, current) != 0
                || IsWellKnownSid(candidate, WinLocalSystemSid) != 0
                || IsWellKnownSid(candidate, WinBuiltinAdministratorsSid) != 0
        }
    }

    struct ProcessToken(HANDLE);

    impl Drop for ProcessToken {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn current_token() -> Result<ProcessToken> {
        let mut token = std::ptr::null_mut();
        anyhow::ensure!(
            unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0,
            "OpenProcessToken failed"
        );
        Ok(ProcessToken(token))
    }

    fn token_user(token: HANDLE) -> Result<Vec<u8>> {
        let mut needed = 0;
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        anyhow::ensure!(needed > 0, "GetTokenInformation size failed");
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
            "GetTokenInformation failed"
        );
        Ok(user)
    }
}

#[cfg(not(any(unix, windows)))]
pub fn set_user_only_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn set_user_only_dir_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn settings_permissions_are_user_only() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.json");
        fs::write(&path, "{}").unwrap();

        set_user_only_file_permissions(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn private_directory_permissions_are_user_only() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("private");
        fs::create_dir(&path).unwrap();

        set_user_only_dir_permissions(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
    }

    #[test]
    fn private_directory_allows_private_child_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("private");
        fs::create_dir(&dir).unwrap();
        set_user_only_dir_permissions(&dir).unwrap();

        let child = dir.join("child.json");
        fs::write(&child, "{}").unwrap();
        set_user_only_file_permissions(&child).unwrap();

        assert_eq!(fs::read_to_string(child).unwrap(), "{}");
    }

    #[cfg(windows)]
    #[test]
    fn private_permissions_support_long_windows_paths() {
        let tmp = TempDir::new().unwrap();
        let mut dir = tmp.path().to_path_buf();
        while dir.as_os_str().len() < 280 {
            dir.push("long-private-directory-segment");
        }
        fs::create_dir_all(&dir).unwrap();
        set_user_only_dir_permissions(&dir).unwrap();

        let child = dir.join("child.json");
        fs::write(&child, "{}").unwrap();
        set_user_only_file_permissions(&child).unwrap();

        assert_eq!(fs::read_to_string(child).unwrap(), "{}");
    }

    #[test]
    fn parses_windows_user_sid_from_whoami_csv() {
        assert_eq!(
            windows_sid_from_whoami(r#""WIN-HOST\User","S-1-5-21-123-456-789-1001""#).as_deref(),
            Some("S-1-5-21-123-456-789-1001")
        );
        assert_eq!(windows_sid_from_whoami("no SID here"), None);
        assert_eq!(windows_sid_from_whoami(r#""user","S-1-invalid""#), None);
    }
}

/// Whether `path` is readable only by its owner.
///
/// Returns `None` when the platform cannot answer cheaply (Windows ACLs), so
/// callers report "unknown" instead of claiming a file is safe.
pub fn is_user_only_file(path: &Path) -> Option<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(path).ok()?;
        Some(metadata.permissions().mode() & 0o077 == 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

#[cfg(all(test, unix))]
mod exposure_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn is_user_only_file_reports_owner_only_modes() {
        let dir = std::env::temp_dir().join(format!("kcoder-perm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let private = dir.join("private.json");
        std::fs::write(&private, "{}").unwrap();
        set_user_only_file_permissions(&private).unwrap();
        assert_eq!(is_user_only_file(&private), Some(true));

        let shared = dir.join("shared.json");
        std::fs::write(&shared, "{}").unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(is_user_only_file(&shared), Some(false));

        assert_eq!(is_user_only_file(&dir.join("missing.json")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
