//! Native-owned ACP frames over an already authenticated selected-target lane.
use super::*;
use anyhow::Context;

pub type NativeFrameFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

/// Implement only over an actual captured endpoint/account/installation owner.
/// Data, ACP agentInfo, process IDs and public source-management permits cannot
/// implement this capability. The implementation must not execute a model loop.
pub trait OwnedNativeFrameTransport: Send + Sync {
    /// Optional workspace observed from the actual selected-target owner, not
    /// a Source host path or a model-supplied filesystem location.
    fn receiver_workspace(&self) -> Result<Option<PathBuf>> {
        Ok(None)
    }
    /// Stable identity of this one actual endpoint lifetime, never a remote PID.
    fn endpoint_instance_id(&self) -> &str;
    /// Revalidate held Source/target/account/image and connection generation.
    fn verify_owner(&self) -> Result<()>;
    /// Start exactly one owned SSH stdio lane after the original Spawn journal.
    /// Unknown/lost receipts must reconcile this original open, never respawn.
    fn open(&self) -> NativeFrameFuture<'_, ()>;
    /// Write exactly once; an uncertain write must never be automatically replayed.
    fn send(&self, frame: Value) -> NativeFrameFuture<'_, ()>;
    /// Read the next original frame. Wire sequences must be acknowledged only
    /// after local delivery; duplicate read receipts must not duplicate frames.
    fn receive(&self) -> NativeFrameFuture<'_, Option<Value>>;
    /// Request cleanup immediately, including when a pending future is dropped.
    /// This retains only authority over the originally owned resources.
    fn begin_close(&self);
    /// Wait for actual owned-tree cleanup. A JSON boolean or transport EOF alone
    /// is insufficient; false preserves unknown/unconfirmed cleanup.
    fn close(&self) -> NativeFrameFuture<'_, bool>;
}

struct OpeningGuard {
    host: Arc<dyn OutboundHost>,
    transport: Arc<dyn OwnedNativeFrameTransport>,
    finished: bool,
}
impl Drop for OpeningGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.transport.begin_close();
            let _ = self.host.record_unknown(OutboundEffect::Spawn);
        }
    }
}
impl OutboundAcp {
    /// Native-only composition after the original accepted Tool permission and
    /// Host verification. Ordinary ACP peers retain the process-backed path.
    pub async fn connect_owned_transport(
        transport: Arc<dyn OwnedNativeFrameTransport>,
        workspace: Option<PathBuf>,
        implementation: (&str, &str),
        host: Arc<dyn OutboundHost>,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        let (name, version) = implementation;
        ensure!(
            !name.is_empty()
                && name.len() <= 128
                && !version.is_empty()
                && version.len() <= 128
                && workspace
                    .as_ref()
                    .is_none_or(|path| !path.as_os_str().is_empty()),
            "Owned Native ACP configuration is invalid"
        );
        host.check_current()
            .context("REMOTE_OWNED_OPEN_SOURCE_ADMISSION")?;
        transport
            .verify_owner()
            .context("REMOTE_OWNED_OPEN_TRANSPORT_OWNER")?;
        host.verify_owned_frame_transport(transport.as_ref())
            .context("REMOTE_OWNED_OPEN_TRANSPORT_BINDING")?;
        let endpoint = transport.endpoint_instance_id().to_owned();
        ensure!(
            !endpoint.is_empty()
                && endpoint.len() <= 256
                && !endpoint.chars().any(char::is_control),
            "Owned Native endpoint identity is invalid"
        );
        host.before_effect(
            OutboundEffect::Spawn,
            &json!({"expectedName":name,"expectedVersion":version}),
        )
        .context("REMOTE_OWNED_OPEN_SPAWN_JOURNAL")?;
        let mut guard = OpeningGuard {
            host: host.clone(),
            transport: transport.clone(),
            finished: false,
        };
        let deadline = host
            .deadline()
            .min(tokio::time::Instant::now() + Duration::from_secs(10));
        tokio::select! {
            biased;
            _ = cancel.cancelled() => bail!("REMOTE_OWNED_OPEN_CANCELLED"),
            _ = tokio::time::sleep_until(deadline) => bail!("REMOTE_OWNED_OPEN_TIMED_OUT"),
            result = transport.open() => result.context("REMOTE_OWNED_OPEN_TRANSPORT")?,
        }
        let workspace = transport
            .receiver_workspace()?
            .or(workspace)
            .context("REMOTE_OWNED_OPEN_RECEIVER_WORKSPACE")?;
        host.check_current()
            .context("REMOTE_OWNED_OPEN_POST_SOURCE_ADMISSION")?;
        transport
            .verify_owner()
            .context("REMOTE_OWNED_OPEN_POST_TRANSPORT_OWNER")?;
        ensure!(
            transport.endpoint_instance_id() == endpoint,
            "Owned Native endpoint changed"
        );
        host.record_receipt(
            OutboundEffect::Spawn,
            &json!({"ownedEndpointInstanceId":endpoint}),
        )
        .context("REMOTE_OWNED_OPEN_SPAWN_RECEIPT")?;
        let mut peer = Upstream::from_owned_native_frames(transport)?;
        let events = peer.take_events();
        guard.finished = true;
        Ok(Self {
            peer,
            events,
            expected_name: name.into(),
            expected_version: version.into(),
            poisoned: false,
            initialized: false,
            workspace,
            host,
        })
    }
}

#[cfg(test)]
mod tests;
