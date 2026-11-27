//! First-party credential management, outside Engine/model configuration.
use super::gateway_auth::GatewayDeviceClient;
use anyhow::{Context, Result, ensure};
use kcoder_config::{ConfigPaths, CredentialStoreMode};

pub(crate) async fn run(
    action: crate::cli_args::PeerGatewayAction,
    paths: &ConfigPaths,
    default_store: CredentialStoreMode,
) -> Result<()> {
    use crate::cli_args::PeerGatewayAction;
    match action {
        PeerGatewayAction::Pair {
            gateway,
            store,
            code_stdin,
            allow_insecure,
        } => {
            let code = if code_stdin {
                use std::io::{IsTerminal, Read};
                ensure!(
                    !std::io::stdin().is_terminal(),
                    "--code-stdin requires piped input; omit it for hidden terminal input"
                );
                let mut bytes = Vec::new();
                std::io::stdin().take(8193).read_to_end(&mut bytes)?;
                ensure!(bytes.len() <= 8192, "pairing credential too large");
                String::from_utf8(bytes).context("pairing credential is not UTF-8")?
            } else {
                rpassword::prompt_password("Gateway pairing code: ")?
            };
            let code = code.trim();
            ensure!(
                !code.is_empty() && code.len() <= 8192 && !code.chars().any(char::is_control),
                "invalid pairing credential"
            );
            let mode = store
                .as_deref()
                .map(CredentialStoreMode::parse)
                .transpose()?
                .unwrap_or(default_store);
            let client =
                GatewayDeviceClient::pair(&paths.config_dir, &gateway, code, mode, allow_insecure)
                    .await?;
            println!("{}", serde_json::to_string(&client.summary())?);
        }
        PeerGatewayAction::Status { allow_insecure } => {
            let client = GatewayDeviceClient::load(&paths.config_dir, allow_insecure)?;
            println!("{}", serde_json::to_string(&client.summary())?);
        }
        PeerGatewayAction::Refresh { allow_insecure } => {
            let mut client = GatewayDeviceClient::load(&paths.config_dir, allow_insecure)?;
            client.refresh().await?;
            println!("{}", serde_json::to_string(&client.summary())?);
        }
        PeerGatewayAction::Revoke { allow_insecure } => {
            let mut client = GatewayDeviceClient::load(&paths.config_dir, allow_insecure)?;
            client.refresh().await?;
            client.revoke().await?;
            GatewayDeviceClient::forget(&paths.config_dir)?;
            println!("Gateway device authorization revoked.");
        }
        PeerGatewayAction::Forget { confirm } => {
            ensure!(
                confirm,
                "--confirm is required; local forgetting does not revoke the remote device"
            );
            GatewayDeviceClient::forget(&paths.config_dir)?;
            println!(
                "Local Gateway enrollment removed. Revoke any unconfirmed device in Gateway settings."
            );
        }
    }
    Ok(())
}
