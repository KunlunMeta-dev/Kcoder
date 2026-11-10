#![cfg(all(target_os = "linux", feature = "private-file-test-hooks"))]

use anyhow::Result;
use std::ffi::OsStr;
use std::io::Read;

#[test]
fn legacy_config_handle_and_fs_handle_share_the_exact_directory_fault_scope() -> Result<()> {
    let fixture = tempfile::tempdir()?;
    kcoder_config::set_user_only_dir_permissions(fixture.path())?;
    let legacy = kcoder_config::PrivateDirectory::open_or_create(&fixture.path().join("legacy"))?;
    let peer = kcoder_fs::PrivateDirectory::open_or_create(&fixture.path().join("peer"))?;
    let shared: &kcoder_fs::PrivateDirectory = &legacy;

    legacy.inject_pre_sync_failure_once()?;
    peer.atomic_replace(OsStr::new("record.json"), b"peer")?;
    let error = shared
        .atomic_replace(OsStr::new("record.json"), b"unconfirmed")
        .expect_err("the original Config handle must arm the same Fs implementation");
    assert!(error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.raw_os_error() == Some(libc::EIO))
    }));

    // A failed directory sync does not mean the first rename did not execute.
    shared.atomic_replace(OsStr::new("record.json"), b"settled")?;
    let mut content = Vec::new();
    legacy
        .open_regular_file(OsStr::new("record.json"))?
        .read_to_end(&mut content)?;
    assert_eq!(content, b"settled");
    Ok(())
}
