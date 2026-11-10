//! Shared target-local credential integration for CLI and Studio MCP connections.

use anyhow::Result;
use kcoder_config::{CredentialStoreMode, imported_credentials::ImportedCredentialStore};
use kcoder_mcp::{
    McpServerConfig, McpServerHandle, McpToolDefinition, server_policy::CredentialContext,
};
pub use kcoder_plugin_rpc::mcp_authorization::token_store_for;
use kcoder_plugin_rpc::mcp_authorization::token_store_for_in;
use std::{path::Path, sync::Arc};

pub async fn connect(
    config: &McpServerConfig,
    profile: &Path,
    mode: CredentialStoreMode,
) -> Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    connect_private(
        config,
        Arc::new(kcoder_mcp::tool::PrivateValues::default()),
        profile,
        mode,
    )
    .await
}

pub async fn connect_private(
    config: &McpServerConfig,
    values: Arc<kcoder_mcp::tool::PrivateValues>,
    profile: &Path,
    mode: CredentialStoreMode,
) -> Result<(McpServerHandle, Vec<McpToolDefinition>)> {
    let store = if config.transport == "http" && config.policy.credential_ref.is_none() {
        Some(token_store_for_in(
            profile,
            config.policy.oauth_account.as_deref(),
        )?)
    } else {
        None
    };
    let context = CredentialContext {
        config_dir: profile.to_owned(),
        mode,
    };
    kcoder_mcp::connect_server_with_private_values_in(config, store, values, Some(&context)).await
}

pub async fn authorization_revisions(
    configs: &[McpServerConfig],
    profile: &Path,
    mode: CredentialStoreMode,
) -> Result<Vec<String>> {
    let mut revisions = Vec::new();
    for config in configs {
        if config.policy.credential_ref.is_some() {
            // Recheck the receipt and actual backing value before reusing a live connection.
            revisions.push(
                ImportedCredentialStore::open(profile)?.mcp_connection_revision(
                    config,
                    mode,
                    &kcoder_config::OsCredentialBackend::new(),
                )?,
            );
            continue;
        }
        if config.transport != "http" {
            continue;
        }
        let endpoint = reqwest::Url::parse(&config.url)
            .map_err(|_| anyhow::anyhow!("Invalid MCP endpoint"))?;
        // Ordinary HTTP configurations may not be eligible for OAuth.
        if kcoder_mcp::authorization::validate_endpoint(&endpoint).is_err() {
            continue;
        }
        revisions.push(
            token_store_for_in(profile, config.policy.oauth_account.as_deref())?
                .connection_cache_revision(&endpoint)
                .await?,
        );
    }
    Ok(revisions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_config::imported_credentials::mcp::McpSecretValues;
    use serde_json::json;

    #[tokio::test]
    async fn private_stdio_cache_rechecks_receipts_and_effective_policy_without_oauth() {
        let root = tempfile::tempdir().unwrap();
        let original = json!({"credential_store":"file","mcp_servers":[]});
        std::fs::write(root.path().join("settings.json"), original.to_string()).unwrap();
        let mut config: McpServerConfig = serde_json::from_value(json!({"name":"cache-fixture","command":"must-not-run","policy":{"required_env":["TOKEN"]}})).unwrap();
        let store = ImportedCredentialStore::open(root.path()).unwrap();
        let backend = kcoder_config::OsCredentialBackend::new();
        let reference = store
            .prepare_mcp(
                &config,
                &["TOKEN".into()],
                &[],
                CredentialStoreMode::File,
                &backend,
            )
            .unwrap();
        let secret = "SYNTHETIC_CACHE_AUTHORITY_VALUE";
        let payload = McpSecretValues {
            env: std::collections::BTreeMap::from([("TOKEN".into(), secret.into())]),
            headers: Default::default(),
        };
        store
            .stage(&reference, &payload.encode().unwrap(), &backend)
            .unwrap();
        config.policy.credential_ref = Some(reference.mcp_reference().unwrap());
        let group = "group-ffffffffffffffffffffffffffffffff";
        store
            .publish_group(
                group,
                std::slice::from_ref(&reference),
                &backend,
                |document| {
                    document["mcp_servers"] = json!([config]);
                    Ok(())
                },
            )
            .unwrap();
        let configs = std::slice::from_ref(&config);
        let revisions = authorization_revisions(configs, root.path(), CredentialStoreMode::File)
            .await
            .unwrap();
        assert_eq!(revisions.len(), 1);
        assert!(!revisions[0].contains(secret));
        assert!(
            authorization_revisions(configs, root.path(), CredentialStoreMode::Keyring)
                .await
                .is_err()
        );
        assert!(!root.path().join("mcp-oauth").exists());
        store
            .undo_group(group, &backend, |document| {
                *document = original;
                Ok(())
            })
            .unwrap();
        assert!(
            authorization_revisions(configs, root.path(), CredentialStoreMode::File)
                .await
                .is_err()
        );
    }
}
