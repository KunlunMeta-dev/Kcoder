use super::*;
use crate::PrivateDirectory;
use std::process::Command;

fn acl(path: &Path, permission: &str) {
    let result = Command::new("icacls.exe")
        .arg(path)
        .args(["/grant", permission])
        .output()
        .unwrap();
    assert!(result.status.success(), "fixture ACL update failed");
}

fn descriptor(path: &Path) -> Vec<u8> {
    let result = Command::new("icacls.exe").arg(path).output().unwrap();
    assert!(result.status.success());
    result.stdout
}

#[test]
fn windows_config_read_only_sharing_does_not_grant_private_temp_authority() {
    let root = tempfile::tempdir().unwrap();
    set_user_only_dir_permissions(root.path()).unwrap();
    acl(root.path(), "*S-1-1-0:(OI)(CI)(RX)");
    let before = descriptor(root.path());
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    directory.verify_trusted_config_directory().unwrap();
    assert!(directory.verify_private_temp_directory().is_err());
    assert!(directory.verify_private_directory().is_err());
    assert_eq!(descriptor(root.path()), before);
}

#[test]
fn windows_config_rejects_every_untrusted_mutation_grant() {
    for permission in ["W", "M", "F", "WDAC", "WO", "DE", "DC", "AD", "WA", "WEA"] {
        let root = tempfile::tempdir().unwrap();
        set_user_only_dir_permissions(root.path()).unwrap();
        acl(root.path(), &format!("*S-1-1-0:({permission})"));
        let before = descriptor(root.path());
        let directory = PrivateDirectory::open_existing(root.path()).unwrap();
        assert!(
            directory.verify_trusted_config_directory().is_err(),
            "accepted {permission}"
        );
        assert_eq!(descriptor(root.path()), before);
    }
}

#[test]
fn windows_config_read_only_owner_needs_no_create_or_delete_child_access() {
    let root = tempfile::tempdir().unwrap();
    set_user_only_dir_permissions(root.path()).unwrap();
    let identity = Command::new("whoami.exe").arg("/user").output().unwrap();
    assert!(identity.status.success());
    let sid = windows_sid_from_whoami(&String::from_utf8_lossy(&identity.stdout)).unwrap();
    let result = Command::new("icacls.exe")
        .arg(root.path())
        .args(["/grant:r", &format!("*{sid}:(OI)(CI)(RX)")])
        .output()
        .unwrap();
    assert!(result.status.success());
    let directory = PrivateDirectory::open_existing(root.path()).unwrap();
    let verified = directory.verify_trusted_config_directory();
    let strict = directory.verify_private_temp_directory();
    // Restore only the owned fixture so TempDir can remove it.
    set_user_only_dir_permissions(root.path()).unwrap();
    verified.unwrap();
    assert!(strict.is_err());
}
