//! Same private directory identities and current-UID abstract manager address.
use anyhow::{Context, Result};
use std::{
    os::{
        linux::net::SocketAddrExt,
        unix::net::{SocketAddr, UnixStream},
    },
    path::Path,
};

#[cfg(target_os = "linux")]
pub fn address(profile: &Path, workspace: &Path) -> Result<SocketAddr> {
    use sha2::{Digest, Sha256};
    let profile = kcoder_config::PrivateDirectory::open_existing(profile)?;
    profile.verify_private_directory()?;
    let workspace = kcoder_config::PrivateDirectory::open_existing(workspace)?;
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "native-code-manager-v1",
            profile.directory_identity()?,
            workspace.directory_identity()?
        ))?)
    );
    SocketAddr::from_abstract_name(
        format!("kcoder-code-{}-{hash}", unsafe { libc::geteuid() }).as_bytes(),
    )
    .map_err(Into::into)
}

#[cfg(target_os = "linux")]
pub fn capture_current_manager(
    profile: &Path,
    workspace: &Path,
    image: &str,
) -> Result<kcoder_native_scope::service_identity::user_peer::NativeUserServicePeer> {
    let stream = UnixStream::connect_addr(&address(profile, workspace)?)
        .context("CHANNEL_HOST_ORIGINAL_MANAGER_REQUIRED")?;
    kcoder_native_scope::service_identity::user_peer::NativeUserServicePeer::capture(&stream, image)
}
