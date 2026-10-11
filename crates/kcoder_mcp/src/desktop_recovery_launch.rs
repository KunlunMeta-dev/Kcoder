//! Compose the authenticated recovery process before the worker may inject input.
use anyhow::Result;
use kcoder_computer_use::{
    recovery_bootstrap::RecoveryBootstrap, windows_pipe::PipeEndpoint,
    windows_recovery_client::PreparedRecovery, windows_recovery_task,
};
use std::ffi::OsStr;
use tokio::net::windows::named_pipe::NamedPipeServer;

struct PendingTask {
    pipe: String,
    armed: bool,
}
impl Drop for PendingTask {
    fn drop(&mut self) {
        if self.armed
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let pipe = self.pipe.clone();
            // No worker has been authorized at this stage. Do not leave an
            // inert registration after ordinary preparation cancellation.
            runtime.spawn(async move {
                let _ = windows_recovery_task::unregister(&pipe).await;
            });
        }
    }
}

pub async fn prepare(input_tag: u32) -> Result<PreparedRecovery<NamedPipeServer>> {
    let endpoint = PipeEndpoint::create()?;
    let bootstrap = RecoveryBootstrap::new(endpoint.name().into(), std::process::id())?;
    let temporary = kcoder_config::create_private_temp_dir("kcoder-desktop-recovery")?;
    let directory = kcoder_config::PrivateDirectory::open_existing(temporary.path())?;
    directory.atomic_replace(
        OsStr::new("recovery-bootstrap.json"),
        &bootstrap.encode_private()?,
    )?;
    let mut pending = PendingTask {
        pipe: bootstrap.pipe().into(),
        armed: true,
    };
    windows_recovery_task::start(
        &std::env::current_exe()?,
        &temporary.path().join("recovery-bootstrap.json"),
        bootstrap.pipe(),
    )
    .await?;
    let (pipe, peer) = endpoint.accept_recovery(&bootstrap).await?;
    let prepared = PreparedRecovery::observe(pipe, peer, input_tag).await?;
    // Observing proves the child consumed the bootstrap and started its input
    // observer. The private directory is no longer needed; the child unregisters
    // its task after channel loss or acknowledged cleanup.
    pending.armed = false;
    Ok(prepared)
}
