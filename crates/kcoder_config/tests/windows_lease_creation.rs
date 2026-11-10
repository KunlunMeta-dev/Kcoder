#![cfg(windows)]

use kcoder_config::PrivateDirectory;
use std::{ffi::OsStr, fs::OpenOptions};

#[test]
fn inherited_lease_is_rejected_and_explicit_private_creation_is_verified() {
    let temp = tempfile::tempdir().unwrap();
    let directory = PrivateDirectory::open_or_create(&temp.path().join("private")).unwrap();
    let inherited_path = temp.path().join("private/inherited.lease");
    let inherited = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&inherited_path)
        .unwrap();
    let rejected = directory
        .portable_regular_handle_identity(&inherited)
        .unwrap_err();
    println!("inherited lease rejection: {rejected}");
    assert!(
        rejected.to_string().contains("DACL")
            || rejected.to_string() == "private object owner is not current user"
    );

    // Existing-only observation must never repair an inherited legacy ACL.
    let observed = directory
        .open_read_write_file(OsStr::new("inherited.lease"), false)
        .unwrap();
    assert!(
        directory
            .portable_regular_handle_identity(&observed)
            .is_err()
    );
    assert!(
        directory
            .portable_regular_handle_identity(&inherited)
            .is_err()
    );

    let private = directory
        .open_read_write_file(OsStr::new("protected.lease"), true)
        .unwrap();
    let identity = directory
        .portable_regular_handle_identity(&private)
        .unwrap();
    assert_eq!(
        directory
            .portable_regular_identity(OsStr::new("protected.lease"))
            .unwrap(),
        identity
    );
}
