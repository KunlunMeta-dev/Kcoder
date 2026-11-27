//! OS-held component roots. This capability does not enable retained receipt methods.
use anyhow::Result;
use kcoder_config::PrivateDirectory;

pub(super) use kcoder_host_transport::native_component_parent::NativeComponentParentAuthority;

struct RetentionComponentParent(
    std::sync::Arc<super::retention_context::VerifiedRetentionAuthority>,
);

pub(super) fn from_retention(
    authority: &std::sync::Arc<super::retention_context::VerifiedRetentionAuthority>,
) -> std::sync::Arc<dyn NativeComponentParentAuthority> {
    std::sync::Arc::new(RetentionComponentParent(authority.clone()))
}

impl NativeComponentParentAuthority for RetentionComponentParent {
    fn administrative_workspace_binding(
        &self,
    ) -> Result<(&str, kcoder_app_protocol::RetentionPrincipalV1)> {
        self.0.administrative_workspace_binding()
    }

    fn verify_native_component_roots(
        &self,
        profile: &PrivateDirectory,
        workspace: &PrivateDirectory,
    ) -> Result<()> {
        self.0.verify_native_component_roots(profile, workspace)
    }
}
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(super) use windows::{WindowsComponentParent, process_sid, windows_roots};

#[cfg(windows)]
pub(super) use windows::capture_current_service_parent;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(super) use macos::MacosComponentParent;
