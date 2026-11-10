//! Held OS process, image and native service peer identities.

/// Root and ordinary accounts are supported; set-ID process identities are not.
#[cfg(unix)]
pub fn verify_current_unix_account() -> anyhow::Result<()> {
    verify_unix_account_ids(
        unsafe { libc::getuid() },
        unsafe { libc::geteuid() },
        unsafe { libc::getgid() },
        unsafe { libc::getegid() },
    )
}

#[cfg(unix)]
fn verify_unix_account_ids(
    uid: libc::uid_t,
    effective_uid: libc::uid_t,
    gid: libc::gid_t,
    effective_gid: libc::gid_t,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        uid == effective_uid && gid == effective_gid,
        "SERVICE_PROCESS_ACCOUNT_MISMATCH"
    );
    Ok(())
}

#[cfg(all(test, unix))]
mod unix_account_tests {
    use super::*;

    #[test]
    fn consistent_root_and_ordinary_accounts_are_supported() {
        for (uid, gid) in [(0, 0), (0, 100), (1000, 100)] {
            verify_unix_account_ids(uid, uid, gid, gid).unwrap();
        }
        verify_current_unix_account().unwrap();
    }

    #[test]
    fn mismatched_effective_user_or_group_is_rejected() {
        for (uid, effective_uid, gid, effective_gid) in [
            (1000, 0, 100, 100),
            (0, 1000, 0, 0),
            (1000, 1000, 100, 0),
            (0, 0, 0, 100),
        ] {
            assert_eq!(
                verify_unix_account_ids(uid, effective_uid, gid, effective_gid)
                    .unwrap_err()
                    .to_string(),
                "SERVICE_PROCESS_ACCOUNT_MISMATCH"
            );
        }
    }
}

#[path = "../../../app_server/integrations/core/service_leases/image.rs"]
pub mod image;
#[path = "remote_installation.rs"]
pub mod remote_installation;
#[cfg(target_os = "linux")]
#[path = "../../../app_server/integrations/core/service_leases/user_peer.rs"]
pub mod user_peer;
#[cfg(windows)]
#[path = "../../../app_server/integrations/core/service_leases/windows_account.rs"]
pub mod windows_account;
#[cfg(windows)]
#[path = "../../../app_server/integrations/core/service_leases/windows_image.rs"]
pub mod windows_image;
#[cfg(windows)]
#[path = "../../../app_server/integrations/core/service_leases/windows_pipe.rs"]
pub mod windows_pipe;

#[cfg(windows)]
#[path = "windows_sid.rs"]
mod windows_sid;
#[cfg(windows)]
pub use windows_sid::process_sid;
