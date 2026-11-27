//! Private profile and workspace used by the resource tests.

use kcoder_config::PrivateDirectory;
use kcoder_native_scope::NativeIntegrationContext;
use std::{ffi::OsStr, path::PathBuf};

pub(super) fn native_context() -> (
    tempfile::TempDir,
    NativeIntegrationContext,
    PathBuf,
    PathBuf,
) {
    let temp = tempfile::tempdir().unwrap();
    let parent = PrivateDirectory::open_existing(temp.path()).unwrap();
    parent.create_private_child(OsStr::new("profile")).unwrap();
    parent
        .create_private_child(OsStr::new("workspace"))
        .unwrap();
    let profile = temp.path().join("profile");
    let workspace = temp.path().join("workspace");
    let context =
        NativeIntegrationContext::capture(&profile, &workspace, "resource-acceptance", "config-r1")
            .unwrap();
    (temp, context, profile, workspace)
}
