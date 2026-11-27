//! Private Native host lane; installation remains at the original connection root.
pub(in crate::app_server) mod host_client {
    #[cfg(test)]
    pub use kcoder_host_transport::native_remote_host::NativeHostMethod;
    pub use kcoder_host_transport::native_remote_host::NativeRemoteHostClient;
    #[cfg(test)]
    #[path = "tests.rs"]
    pub(super) mod tests;
}
#[cfg(windows)]
pub(in crate::app_server) use kcoder_host_transport::native_remote_windows_image as windows_image;
#[cfg(test)]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::transport::native_frames;
#[cfg(test)]
pub(super) use native_frames::NativeRemoteSourceFrames;
#[cfg(test)]
mod source_authority_tests;
// Attaches the original CLI-fixture tests to the code compiled by `kcoder_native_outbound`.
#[cfg(test)]
mod source_control {
    pub(crate) use kcoder_native_outbound::app_server::integrations::core::remote_delegations::transport::source_control::*;
    #[path = "tests.rs"]
    mod tests;
}
