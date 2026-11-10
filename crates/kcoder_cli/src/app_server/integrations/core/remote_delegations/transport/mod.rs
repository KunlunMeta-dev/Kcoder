//! Private Native host lane; installation remains at the original connection root.
pub(in crate::app_server) mod host_client {
    pub use kcoder_host_transport::native_remote_host::{
        NATIVE_HOST_REPLY_ID_PREFIX, NativeHostMethod, NativeRemoteHostClient,
    };
    #[cfg(test)]
    #[path = "tests.rs"]
    pub(super) mod tests;
}
#[cfg(test)]
mod native_frames;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::transport::native_frames;
pub(super) use native_frames::NativeRemoteSourceFrames;
#[cfg(test)]
mod source_control;
#[cfg(not(test))]
use kcoder_native_outbound::app_server::integrations::core::remote_delegations::transport::source_control;
pub(super) use source_control::NativeRemoteSourceControl;
#[cfg(test)]
mod source_authority_tests;
#[cfg(windows)]
pub(in crate::app_server) use kcoder_host_transport::native_remote_windows_image as windows_image;
