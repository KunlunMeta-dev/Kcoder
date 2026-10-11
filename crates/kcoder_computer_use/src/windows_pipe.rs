//! One registered-client pipe endpoint. Host gives its random name and one-use
//! bootstrap grant to the intended child only; no discoverable public listener.
use crate::{
    admission::{Admissions, GrantSecret},
    broker::DesktopBroker,
    connection::serve_authenticated_until,
    windows_peer::{PipePeer, current_user_sid, verify_pipe_peer},
};
use anyhow::{Result, ensure};
use std::{os::windows::io::AsHandle, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
        SECURITY_ATTRIBUTES,
    },
};
use zeroize::Zeroizing;

const MAGIC: &[u8; 4] = b"KCU1";
const HANDSHAKE_BYTES: usize = 4 + 36 + 32;

pub struct PipeEndpoint {
    name: String,
    pipe: NamedPipeServer,
}
impl PipeEndpoint {
    pub fn create() -> Result<Self> {
        let sid = current_user_sid()
            .map_err(|error| anyhow::anyhow!("token SID unavailable: {error:?}"))?;
        let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let mut descriptor = std::ptr::null_mut();
        ensure!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    std::ptr::null_mut(),
                )
            } != 0,
            "pipe DACL creation failed"
        );
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name = format!(r"\\.\pipe\kcoder-desktop-{}", uuid::Uuid::new_v4());
        let result = unsafe {
            ServerOptions::new()
                .first_pipe_instance(true)
                .reject_remote_clients(true)
                .max_instances(1)
                .create_with_security_attributes_raw(
                    &name,
                    (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
                )
        };
        unsafe {
            LocalFree(descriptor);
        }
        Ok(Self {
            name,
            pipe: result?,
        })
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    /// Consume a private endpoint once. The task launcher passes the bootstrap
    /// through a user-only file, never through argv or the model's tool context.
    pub async fn accept_recovery(
        mut self,
        bootstrap: &crate::recovery_bootstrap::RecoveryBootstrap,
    ) -> Result<(NamedPipeServer, crate::windows_peer::VerifiedPeer)> {
        ensure!(
            bootstrap.pipe() == self.name && bootstrap.parent_pid() == std::process::id(),
            "recovery bootstrap does not belong to this host"
        );
        let expected = std::env::current_exe()?;
        let peer = tokio::time::timeout(Duration::from_secs(30), async {
            self.pipe.connect().await?;
            let peer =
                crate::windows_peer::verify_recovery_peer(self.pipe.as_handle(), PipePeer::Client)
                    .map_err(|_| anyhow::anyhow!("recovery peer identity rejected"))?;
            ensure!(
                peer.executable_matches(&expected).unwrap_or(false),
                "unexpected recovery executable"
            );
            let mut frame = Zeroizing::new([0u8; 36]);
            self.pipe.read_exact(frame.as_mut()).await?;
            ensure!(
                &frame[..4] == b"KCR1" && bootstrap.accepts(frame[4..].try_into()?),
                "recovery admission rejected"
            );
            self.pipe.write_all(b"KCR1").await?;
            self.pipe.flush().await?;
            Ok::<_, anyhow::Error>(peer)
        })
        .await??;
        Ok((self.pipe, peer))
    }
    pub async fn serve_once(
        mut self,
        admissions: Arc<Mutex<Admissions>>,
        broker: Arc<DesktopBroker>,
    ) -> Result<()> {
        // Includes OS connect and bootstrap read: idle unauthenticated clients
        // cannot hold the endpoint indefinitely.
        let identity = tokio::time::timeout(Duration::from_secs(30), async {
            self.pipe.connect().await?;
            let peer = verify_pipe_peer(self.pipe.as_handle(), PipePeer::Client)
                .map_err(|_| anyhow::anyhow!("desktop pipe peer rejected"))?;
            let mut frame = Zeroizing::new([0u8; HANDSHAKE_BYTES]);
            self.pipe.read_exact(frame.as_mut()).await?;
            ensure!(&frame[..4] == MAGIC, "unsupported desktop handshake");
            let id = std::str::from_utf8(&frame[4..40])?;
            ensure!(
                uuid::Uuid::parse_str(id).is_ok(),
                "invalid desktop grant identifier"
            );
            let token: &[u8; 32] = frame[40..].try_into()?;
            let identity = admissions
                .lock()
                .await
                .consume(id, token, peer.process_id, peer.session_id)
                .map_err(|_| anyhow::anyhow!("desktop grant rejected"))?;
            self.pipe.write_all(MAGIC).await?;
            Ok::<_, anyhow::Error>((identity, peer))
        })
        .await??;
        // Hold verified OS process handle for the lifetime of the stream.
        let (identity, peer) = identity;
        serve_authenticated_until(self.pipe, identity, broker, async {
            // Both process exit and loss of verifiable lifetime revoke control.
            let _ = peer.wait_for_exit().await;
        })
        .await
    }
}

/// Recovery process authenticates the spawning host before sending its secret.
pub async fn connect_recovery(
    bootstrap: &crate::recovery_bootstrap::RecoveryBootstrap,
) -> Result<(NamedPipeClient, crate::windows_peer::VerifiedPeer)> {
    let mut pipe = ClientOptions::new().open(bootstrap.pipe())?;
    let peer = verify_pipe_peer(pipe.as_handle(), PipePeer::Server)
        .map_err(|_| anyhow::anyhow!("recovery parent identity rejected"))?;
    ensure!(
        peer.process_id == bootstrap.parent_pid(),
        "unexpected recovery parent process"
    );
    ensure!(
        peer.executable_matches(&std::env::current_exe()?)
            .unwrap_or(false),
        "unexpected recovery parent executable"
    );
    let mut frame = Zeroizing::new([0u8; 36]);
    frame[..4].copy_from_slice(b"KCR1");
    frame[4..].copy_from_slice(bootstrap.secret());
    tokio::time::timeout(Duration::from_secs(10), async {
        pipe.write_all(frame.as_ref()).await?;
        pipe.flush().await?;
        let mut ack = [0; 4];
        pipe.read_exact(&mut ack).await?;
        ensure!(
            &ack == b"KCR1",
            "invalid recovery admission acknowledgement"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    Ok((pipe, peer))
}

/// Validate server OS identity *before* sending a bootstrap secret. The expected
/// PID is supplied by the spawning host, not by the server being authenticated.
pub async fn connect_registered(
    name: &str,
    expected_server_pid: u32,
    grant_id: &str,
    secret: &GrantSecret,
) -> Result<NamedPipeClient> {
    ensure!(
        name.starts_with(r"\\.\pipe\kcoder-desktop-")
            && uuid::Uuid::parse_str(&name[r"\\.\pipe\kcoder-desktop-".len()..]).is_ok(),
        "invalid desktop pipe name"
    );
    ensure!(
        grant_id.len() == 36 && uuid::Uuid::parse_str(grant_id).is_ok(),
        "invalid grant ID"
    );
    let mut pipe = ClientOptions::new().open(name)?;
    let peer = verify_pipe_peer(pipe.as_handle(), PipePeer::Server)
        .map_err(|_| anyhow::anyhow!("desktop host identity rejected"))?;
    ensure!(
        peer.process_id == expected_server_pid,
        "unexpected desktop host process"
    );
    let mut frame = Zeroizing::new([0u8; HANDSHAKE_BYTES]);
    frame[..4].copy_from_slice(MAGIC);
    frame[4..40].copy_from_slice(grant_id.as_bytes());
    frame[40..].copy_from_slice(secret.expose_for_bootstrap());
    tokio::time::timeout(Duration::from_secs(10), async {
        pipe.write_all(frame.as_ref()).await?;
        pipe.flush().await?;
        let mut ack = [0; 4];
        pipe.read_exact(&mut ack).await?;
        ensure!(&ack == MAGIC, "invalid desktop handshake acknowledgement");
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    Ok(pipe)
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::recovery_bootstrap::RecoveryBootstrap;

    #[tokio::test]
    #[ignore = "run explicitly in an interactive Windows logon session; no desktop input"]
    async fn native_recovery_pipe_accepts_only_the_private_bootstrap() {
        for wrong_secret in [false, true] {
            let endpoint = PipeEndpoint::create().unwrap();
            let bootstrap = Arc::new(
                RecoveryBootstrap::new(endpoint.name().into(), std::process::id()).unwrap(),
            );
            let supplied = if wrong_secret {
                Arc::new(
                    RecoveryBootstrap::new(endpoint.name().into(), std::process::id()).unwrap(),
                )
            } else {
                bootstrap.clone()
            };
            let server = tokio::spawn(async move { endpoint.accept_recovery(&bootstrap).await });
            let client = connect_recovery(&supplied).await;
            let accepted = server.await.unwrap();
            if wrong_secret {
                assert!(client.is_err());
                assert!(accepted.is_err());
            } else {
                let (_stream, peer) = client.unwrap();
                let (_server, client_peer) = accepted.unwrap();
                assert_eq!(peer.process_id, std::process::id());
                assert_eq!(client_peer.process_id, std::process::id());
                assert_ne!(peer.session_id, 0);
                assert_eq!(peer.session_id, client_peer.session_id);
            }
        }
    }
}
