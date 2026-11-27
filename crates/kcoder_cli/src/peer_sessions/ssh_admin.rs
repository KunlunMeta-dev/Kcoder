//! Explicit OS-owner management. This entry is not an app-server or model-tool method.
#[cfg(target_os = "linux")]
use crate::app_server::session_messages::router_authority::NativePeerRouterAuthority;
use crate::cli_args::PeerSshAction;
use anyhow::Result;
#[cfg(target_os = "linux")]
use anyhow::ensure;
#[cfg(target_os = "linux")]
use kcoder_app_protocol::{RetentionParentLaunchV1, cross_session_router::ssh_enrollment::*};
use kcoder_config::ConfigPaths;
#[cfg(target_os = "linux")]
use kcoder_host_transport::ssh_peer_pins::SshPeerPinStore;
#[cfg(target_os = "linux")]
use std::io::{IsTerminal, Read};
use std::path::Path;

#[cfg(target_os = "linux")]
const MAX_COMMAND: u64 = 16 * 1024;
#[cfg(target_os = "linux")]
fn observation(
    paths: &ConfigPaths,
    cwd: &Path,
    create: bool,
) -> Result<PeerSshProfileObservationV1> {
    let authority = NativePeerRouterAuthority::capture(
        &RetentionParentLaunchV1::LocalOs,
        &paths.config_dir,
        &paths.config_dir,
        cwd,
        create,
    )?
    .ok_or_else(|| anyhow::anyhow!("peer_ssh_profile_identity_missing_prepare_explicitly"))?;
    let native = authority.ssh_profile_observation()?;
    let pin_revision = SshPeerPinStore::observed_revision(&paths.config_dir)?;
    Ok(PeerSshProfileObservationV1 {
        version: 1,
        native,
        pin_revision,
    })
}
#[cfg(target_os = "linux")]
fn command(action: &PeerSshAction) -> Result<PeerSshPinCommandV1> {
    let PeerSshAction::Apply {
        confirm,
        input,
        command_stdin,
    } = action
    else {
        anyhow::bail!("peer_ssh_admin_action_invalid");
    };
    // Confirmation expresses an explicit OS-owner command. It does not authenticate
    // a model/public RPC caller and is never used as a private-parent proof.
    ensure!(*confirm, "peer_ssh_explicit_confirmation_required");
    ensure!(
        input.is_some() != *command_stdin,
        "peer_ssh_one_command_input_required"
    );
    let mut bytes = Vec::new();
    if let Some(path) = input {
        let file = std::fs::File::open(path)
            .map_err(|_| anyhow::anyhow!("peer_ssh_command_input_unavailable"))?;
        ensure!(
            file.metadata()
                .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MAX_COMMAND),
            "peer_ssh_command_input_invalid"
        );
        file.take(MAX_COMMAND + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow::anyhow!("peer_ssh_command_input_unavailable"))?;
    } else {
        ensure!(
            !std::io::stdin().is_terminal(),
            "peer_ssh_command_stdin_requires_pipe"
        );
        std::io::stdin()
            .take(MAX_COMMAND + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow::anyhow!("peer_ssh_command_input_unavailable"))?;
    }
    ensure!(
        bytes.len() as u64 <= MAX_COMMAND,
        "peer_ssh_command_input_too_large"
    );
    let command: PeerSshPinCommandV1 =
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("peer_ssh_command_invalid"))?;
    command.validate().map_err(anyhow::Error::msg)?;
    Ok(command)
}

pub(crate) fn run(action: PeerSshAction, paths: &ConfigPaths, cwd: &Path) -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (action, paths, cwd);
        anyhow::bail!("peer_ssh_enrollment_platform_unavailable");
    }
    #[cfg(target_os = "linux")]
    {
        let value = match &action {
            PeerSshAction::Prepare { confirm } => {
                ensure!(*confirm, "peer_ssh_explicit_confirmation_required");
                serde_json::to_value(observation(paths, cwd, true)?)?
            }
            PeerSshAction::Observe => serde_json::to_value(observation(paths, cwd, false)?)?,
            PeerSshAction::Apply { .. } => {
                let command = command(&action)?;
                let observed = observation(paths, cwd, false)?;
                serde_json::to_value(SshPeerPinStore::apply_explicit(
                    &paths.config_dir,
                    &observed.native,
                    &command,
                )?)?
            }
            PeerSshAction::ReadReceipt { operation_id } => {
                let id: PeerSshIdentityTextV1 = operation_id
                    .clone()
                    .try_into()
                    .map_err(anyhow::Error::msg)?;
                let receipt = SshPeerPinStore::read_original_receipt(&paths.config_dir, &id)?;
                serde_json::to_value(PeerSshPinReceiptReadV1 {
                    version: 1,
                    operation_id: id,
                    receipt,
                })?
            }
        };
        println!("{}", serde_json::to_string(&value)?);
        Ok(())
    }
}
