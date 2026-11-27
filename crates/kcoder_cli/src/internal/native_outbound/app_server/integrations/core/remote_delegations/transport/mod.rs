//! Original source frame and debit accounting over the held native host client.
pub mod host_client {
    pub use kcoder_host_transport::native_remote_host::{
        NATIVE_HOST_REPLY_ID_PREFIX, NativeHostMethod, NativeRemoteHostClient,
    };
}
#[path = "../../../../../../../app_server/integrations/core/remote_delegations/transport/native_frames.rs"]
pub mod native_frames;
#[path = "../../../../../../../app_server/integrations/core/remote_delegations/transport/source_control.rs"]
pub mod source_control;
pub use native_frames::NativeRemoteSourceFrames;
pub use source_control::NativeRemoteSourceControl;
