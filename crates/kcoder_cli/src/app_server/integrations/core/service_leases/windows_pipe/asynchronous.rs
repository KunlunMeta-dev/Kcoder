//! Overlapped local pipes use the same pinned SID/image identity as readiness.
use super::{CurrentWindowsServiceAccount, Descriptor, identity::PipePeerIdentity, validate_name};
use anyhow::{Context, Result, ensure};
use std::{mem::size_of, os::windows::io::AsRawHandle, sync::Arc, time::Duration};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::{Foundation::ERROR_PIPE_BUSY, Security::SECURITY_ATTRIBUTES};

pub struct CurrentUserPipeListener {
    name: String,
    next: NamedPipeServer,
    account: CurrentWindowsServiceAccount,
}
pub struct AcceptedUserPipe {
    pub io: NamedPipeServer,
    pub peer: Arc<PipePeerIdentity>,
}
pub struct ConnectedUserPipe {
    pub io: NamedPipeClient,
    pub peer: Arc<PipePeerIdentity>,
}

impl CurrentUserPipeListener {
    /// The fixed name is derived by the Native scope owner. It locates an OS
    /// carrier; possession of a pipe handle never grants public/background use.
    pub fn bind(name: String) -> Result<Self> {
        validate_name(&name)?;
        let account = CurrentWindowsServiceAccount::capture()?;
        let next = create(&name, true, &account)?;
        account.verify()?;
        Ok(Self {
            name,
            next,
            account,
        })
    }
    pub async fn accept(
        &mut self,
        image_sha: &str,
        cancel: &CancellationToken,
    ) -> Result<AcceptedUserPipe> {
        self.account.verify()?;
        tokio::select! {biased;
            _=cancel.cancelled()=>anyhow::bail!("SERVICE_WINDOWS_LISTENER_ENDED"),
            result=self.next.connect()=>result.context("SERVICE_WINDOWS_PIPE_CONNECT_UNAVAILABLE")?,
        }
        self.account.verify()?;
        let identity = match PipePeerIdentity::capture(self.next.as_raw_handle(), true, image_sha) {
            Ok(identity) => identity,
            Err(error) => {
                self.next
                    .disconnect()
                    .context("SERVICE_WINDOWS_REJECTED_PEER_CLOSE_UNCONFIRMED")?;
                return Err(error);
            }
        };
        // Establish the next instance while the original first instance is
        // still held. A second scope owner cannot replace the live listener.
        let next = create(&self.name, false, &self.account)?;
        let io = std::mem::replace(&mut self.next, next);
        identity.verify()?;
        Ok(AcceptedUserPipe {
            io,
            peer: Arc::new(identity),
        })
    }
}
impl ConnectedUserPipe {
    /// Observe an existing endpoint once. Busy, identity failure and other
    /// unknown outcomes cannot be interpreted as permission to restore locally.
    pub fn connect_existing(
        name: &str,
        image_sha: &str,
        cancel: &CancellationToken,
    ) -> Result<Option<Self>> {
        validate_name(name)?;
        let account = CurrentWindowsServiceAccount::capture()?;
        account.verify()?;
        ensure!(
            !cancel.is_cancelled(),
            "SERVICE_WINDOWS_PIPE_CONNECT_UNCONFIRMED"
        );
        let io = match ClientOptions::new().open(name) {
            Ok(io) => io,
            Err(error) if error.raw_os_error() == Some(2) => return Ok(None),
            Err(error) => return Err(error).context("SERVICE_WINDOWS_PIPE_CONNECT_UNCONFIRMED"),
        };
        let peer = PipePeerIdentity::capture(io.as_raw_handle(), false, image_sha)?;
        account.verify()?;
        Ok(Some(Self {
            io,
            peer: Arc::new(peer),
        }))
    }

    pub async fn connect(
        name: &str,
        image_sha: &str,
        budget: Duration,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        validate_name(name)?;
        ensure!(
            !budget.is_zero() && budget <= Duration::from_secs(30),
            "SERVICE_WINDOWS_PIPE_BUDGET_INVALID"
        );
        let until = tokio::time::Instant::now() + budget;
        let account = CurrentWindowsServiceAccount::capture()?;
        loop {
            account.verify()?;
            ensure!(
                !cancel.is_cancelled() && tokio::time::Instant::now() < until,
                "SERVICE_WINDOWS_PIPE_CONNECT_UNCONFIRMED"
            );
            // Tokio requests overlapped I/O and identification-only SQOS by
            // default; the server cannot impersonate this user's token.
            match ClientOptions::new().open(name) {
                Ok(io) => {
                    let peer = PipePeerIdentity::capture(io.as_raw_handle(), false, image_sha)?;
                    return Ok(Self {
                        io,
                        peer: Arc::new(peer),
                    });
                }
                Err(error)
                    if matches!(error.raw_os_error(), Some(2))
                        || error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) =>
                {
                    tokio::select! {biased;
                        _=cancel.cancelled()=>anyhow::bail!("SERVICE_WINDOWS_PIPE_CONNECT_UNCONFIRMED"),
                        _=tokio::time::sleep_until(until)=>anyhow::bail!("SERVICE_WINDOWS_PIPE_CONNECT_UNCONFIRMED"),
                        _=tokio::time::sleep(Duration::from_millis(10))=>{},
                    }
                }
                Err(_) => anyhow::bail!("SERVICE_WINDOWS_PIPE_CONNECT_UNAVAILABLE"),
            }
        }
    }
}

fn create(
    name: &str,
    first: bool,
    account: &CurrentWindowsServiceAccount,
) -> Result<NamedPipeServer> {
    account.verify()?;
    let descriptor = Descriptor::current(account)?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .pipe_mode(PipeMode::Byte)
        .max_instances(
            kcoder_app_protocol::integrations::channel_peer::CHANNEL_PEER_STREAM_CAPACITY,
        )
        .in_buffer_size(65536)
        .out_buffer_size(65536);
    // SAFETY: the protected current-SID descriptor and non-inheritable security
    // attributes remain alive for CreateNamedPipe, which copies the descriptor.
    let pipe = unsafe {
        options.create_with_security_attributes_raw(
            name,
            (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
    .context("SERVICE_WINDOWS_PIPE_BIND_UNAVAILABLE")?;
    account.verify()?;
    Ok(pipe)
}
