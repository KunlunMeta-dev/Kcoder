//! One private original bound to the same unthreaded owned Upstream.
use crate::{
    permissions::Permissions,
    sessions::initialize_native_upstream,
    upstream::{AppServerConfig, Upstream},
};
use agent_client_protocol::schema::v1::{ContentBlock, NewSessionRequest, PromptRequest};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::InitializeResult;
use kcoder_types::integrations::core::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;
mod bridge;
pub(crate) mod close;
#[cfg(all(test, unix))]
mod tests;

pub(crate) struct PreparedNative {
    pub(crate) upstream: Upstream,
    pub(crate) initialized: InitializeResult,
    pub(crate) binding: NativeBinding,
}

pub(crate) struct NativeBinding {
    pub(crate) original: NativeRemoteControlFrameV1,
    cwd: OriginalCwd,
    receipt: Option<NativeRemoteControlReplyV1>,
    _bridge: bridge::NativeBridge,
    prompted: bool,
    owner: std::sync::Arc<close::OwnerState>,
}

struct OriginalCwd {
    path: PathBuf,
    #[cfg(unix)]
    directory: std::fs::File,
}

#[derive(Clone)]
pub(crate) struct NativeConnectionControl {
    original: NativeRemoteControlFrameV1,
    link: crate::upstream::NativeUpstreamControl,
    owner: std::sync::Arc<close::OwnerState>,
}
/// Opaque ownership transfer to this already requested original close.
pub(crate) struct NativeCloseHandoff(std::sync::Arc<close::OwnerState>);
impl NativeCloseHandoff {
    pub(crate) fn is_held(&self) -> bool {
        self.0.has_requested_close()
    }
}
impl NativeConnectionControl {
    pub(crate) fn request_original_close(&self, frame: &NativeRemoteControlFrameV1) -> Result<()> {
        ensure!(
            self.matches_close(frame),
            "REMOTE_ORIGINAL_ACCEPTED_REQUIRED"
        );
        self.owner.request_close(frame)
    }

    pub(crate) fn matches(&self, frame: &NativeRemoteControlFrameV1) -> bool {
        frame.validate_shape().is_ok()
            && frame.version == self.original.version
            && frame.operation_id == self.original.operation_id
            && frame.endpoint_revision == self.original.endpoint_revision
            && frame.endpoint_instance_id == self.original.endpoint_instance_id
            && frame.source_accepted_sha256 == self.original.source_accepted_sha256
            && (!matches!(frame.message, NativeRemoteControlDataV1::BindOriginal(_))
                || frame == &self.original)
    }
    pub(crate) async fn request(
        &self,
        frame: NativeRemoteControlFrameV1,
        cancelled: &CancellationToken,
    ) -> Result<Value> {
        ensure!(self.matches(&frame), "REMOTE_CONTROL_BINDING_MISMATCH");
        if matches!(frame.message, NativeRemoteControlDataV1::CloseOriginal(_)) {
            return self
                .owner
                .receipt(&frame)?
                .context("REMOTE_OWNER_CLOSE_ORIGINAL_REQUIRED");
        }
        let value = self.link.request(&frame, cancelled).await?;
        let reply: NativeRemoteControlReplyV1 = serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_RECEIVER_REPLY_INVALID"))?;
        validate_reply_header(&frame, &reply)?;
        Ok(serde_json::to_value(reply)?)
    }
    pub(crate) fn matches_close(&self, frame: &NativeRemoteControlFrameV1) -> bool {
        self.matches(frame) && self.owner.matches_close(frame)
    }
    pub(crate) fn close_receipt(
        &self,
        frame: &NativeRemoteControlFrameV1,
    ) -> Result<Option<Value>> {
        ensure!(
            self.matches_close(frame),
            "REMOTE_ORIGINAL_ACCEPTED_REQUIRED"
        );
        self.owner.receipt(frame)
    }
}
impl NativeBinding {
    pub(crate) fn close_handoff(&self) -> NativeCloseHandoff {
        NativeCloseHandoff(self.owner.clone())
    }
    pub(crate) fn retains_actual_original_owner(&self) -> bool {
        self.prompted && self.owner.has_actual_accepted()
    }
}
impl OriginalCwd {
    fn capture() -> Result<Self> {
        let path = std::env::current_dir()?.canonicalize()?;
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
                .open(".")?
        };
        let value = Self {
            path,
            #[cfg(unix)]
            directory,
        };
        value.verify()?;
        Ok(value)
    }
    fn verify(&self) -> Result<()> {
        ensure!(
            std::env::current_dir()?.canonicalize()? == self.path,
            "REMOTE_ORIGINAL_CWD_CHANGED"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = self.directory.metadata()?;
            let current = std::fs::metadata(".")?;
            let named = std::fs::metadata(&self.path)?;
            ensure!(
                held.is_dir()
                    && (held.dev(), held.ino()) == (current.dev(), current.ino())
                    && (held.dev(), held.ino()) == (named.dev(), named.ino()),
                "REMOTE_ORIGINAL_CWD_CHANGED"
            );
        }
        Ok(())
    }
}

impl PreparedNative {
    pub(crate) async fn start(
        config: &AppServerConfig,
        original: NativeRemoteControlFrameV1,
        permissions: Permissions,
        cancelled: &CancellationToken,
        lifecycle: crate::diagnostics::Lifecycle,
    ) -> Result<Self> {
        validate_original(&original)?;
        ensure!(
            config
                .args
                .iter()
                .any(|arg| arg == "--internal-acp-backend"),
            "REMOTE_RECEIVER_NATIVE_ACP_PARENT_REQUIRED"
        );
        let cwd = OriginalCwd::capture()?;
        let mut upstream = Upstream::spawn_native_original(config, lifecycle)?;
        let setup = tokio::select! { biased;
            _ = cancelled.cancelled() => Err(anyhow::anyhow!("REMOTE_ORIGINAL_BINDING_CANCELLED")),
            result = initialize_native_upstream(&upstream) => result,
        };
        let initialized = match setup {
            Ok(value) => value,
            Err(error) => {
                upstream.shutdown().await;
                return Err(error);
            }
        };
        if let Err(error) = cwd.verify() {
            upstream.shutdown().await;
            return Err(error);
        }
        let owner = close::new_owner();
        let bridge = bridge::NativeBridge::install(
            &mut upstream,
            original.clone(),
            permissions,
            owner.clone(),
        );
        Ok(Self {
            upstream,
            initialized,
            binding: NativeBinding {
                original,
                cwd,
                receipt: None,
                _bridge: bridge,
                prompted: false,
                owner,
            },
        })
    }
    pub(crate) fn matches(&self, frame: &NativeRemoteControlFrameV1) -> bool {
        self.binding.original == *frame
    }
    pub(crate) fn ready(&self) -> bool {
        self.binding.receipt.is_some() && !self.upstream.is_closed()
    }
    pub(crate) fn control(&self) -> NativeConnectionControl {
        NativeConnectionControl {
            original: self.binding.original.clone(),
            link: self.upstream.native_control_link(),
            owner: self.binding.owner.clone(),
        }
    }
    pub(crate) fn validate_session(&self, request: &NewSessionRequest) -> Result<()> {
        self.binding.cwd.verify()?;
        ensure!(
            self.ready()
                && request.mcp_servers.is_empty()
                && request.additional_directories.is_empty()
                && request.cwd == self.binding.cwd.path,
            "REMOTE_ORIGINAL_SESSION_DISPATCH_REQUIRED"
        );
        Ok(())
    }
    pub(crate) async fn reconcile(&mut self, cancelled: &CancellationToken) -> Result<Value> {
        self.binding.cwd.verify()?;
        let result = tokio::select! { biased;
            _ = cancelled.cancelled() => Err(anyhow::anyhow!("REMOTE_ORIGINAL_BINDING_CANCELLED")),
            result = self.upstream.call(NATIVE_REMOTE_CONTROL_METHOD, serde_json::to_value(&self.binding.original)?) => result,
        }?;
        let reply: NativeRemoteControlReplyV1 = serde_json::from_value(result)
            .map_err(|_| anyhow::anyhow!("REMOTE_ORIGINAL_BINDING_REPLY_INVALID"))?;
        validate_reply_header(&self.binding.original, &reply)?;
        let NativeRemoteControlDataV1::BindOriginal(input) = &self.binding.original.message else {
            unreachable!()
        };
        ensure!(
            reply.state == NativeRemoteReceiptStateV1::Received
                && matches!(&reply.data, NativeRemoteReceiptDataV1::OriginalBound { frozen_input_sha256, receiver_settings_sha256 }
                if frozen_input_sha256 == &input.frozen_input_sha256 && receiver_settings_sha256.len() == 64
                    && receiver_settings_sha256.bytes().all(|b|b.is_ascii_hexdigit())),
            "REMOTE_ORIGINAL_BINDING_REPLY_INVALID"
        );
        self.binding.cwd.verify()?;
        self.binding.receipt = Some(reply.clone());
        Ok(serde_json::to_value(reply)?)
    }
    pub(crate) async fn shutdown(&mut self) {
        self.upstream.shutdown().await;
    }
}

impl NativeBinding {
    pub(crate) fn validate_prompt(
        &mut self,
        request: &PromptRequest,
        cancelled: &CancellationToken,
    ) -> Result<()> {
        self.cwd.verify()?;
        let NativeRemoteControlDataV1::BindOriginal(original) = &self.original.message else {
            unreachable!()
        };
        ensure!(
            !self.prompted && !cancelled.is_cancelled() && request.prompt.len() == 1,
            "REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED"
        );
        let ContentBlock::Text(text) = &request.prompt[0] else {
            anyhow::bail!("REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED")
        };
        ensure!(
            text.text == original.prompt
                && format!("{:x}", Sha256::digest(text.text.as_bytes()))
                    == original.frozen_input_sha256,
            "REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED"
        );
        self.prompted = true;
        Ok(())
    }
}

pub(crate) fn validate_original(frame: &NativeRemoteControlFrameV1) -> Result<()> {
    frame.validate_shape().map_err(anyhow::Error::msg)?;
    let NativeRemoteControlDataV1::BindOriginal(original) = &frame.message else {
        anyhow::bail!("REMOTE_ORIGINAL_BINDING_REQUIRED")
    };
    ensure!(
        format!("{:x}", Sha256::digest(original.prompt.as_bytes())) == original.frozen_input_sha256,
        "REMOTE_ORIGINAL_FROZEN_INPUT_MISMATCH"
    );
    Ok(())
}
pub(crate) fn validate_reply_header(
    frame: &NativeRemoteControlFrameV1,
    reply: &NativeRemoteControlReplyV1,
) -> Result<()> {
    ensure!(
        reply.version == frame.version
            && reply.operation_id == frame.operation_id
            && reply.request_id == frame.request_id
            && reply.endpoint_revision == frame.endpoint_revision
            && reply.endpoint_instance_id == frame.endpoint_instance_id,
        "REMOTE_CONTROL_SOURCE_REPLY_MISMATCH"
    );
    Ok(())
}
