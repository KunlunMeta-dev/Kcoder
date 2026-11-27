//! Explicit native OAuth provider operation; public params never carry secrets or URLs.
use super::*;
use anyhow::{Context, ensure};
use kcoder_app_protocol::{
    McpProviderRevocationParams as Params, McpProviderRevocationPhase as Phase,
    McpProviderRevocationReason as Reason, McpProviderRevocationReceipt as Receipt,
    McpProviderRevocationSourceState as SourceState,
};
use kcoder_config::{PrivateDirectory, Settings};
use kcoder_mcp::{
    authorization_index::observe::ExistingOAuthObservationStore,
    authorization_store::OAuthTokenStore,
};
use sha2::{Digest, Sha256};

fn unavailable(request_id: &str) -> Receipt {
    Receipt {
        request_id: request_id.into(),
        intent_ref: None,
        phase: Phase::Unknown,
        reason: Reason::OriginalReceiptUnavailable,
        local_credentials_removed: false,
        current_source_matches: false,
        source_state: SourceState::Unavailable,
    }
}
fn oauth_configuration(config: &McpServerConfig) -> bool {
    config.transport == "http"
        && config.policy.credential_ref.is_none()
        && !config
            .headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
        && config.policy.bearer_token_env_var.is_none()
        && !config
            .policy
            .required_headers
            .iter()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
        && !config
            .policy
            .env_http_headers
            .keys()
            .any(|name| name.eq_ignore_ascii_case("authorization"))
}
fn resolve_snapshot(
    factory: &AppServerEngineFactory,
    selector: &kcoder_app_protocol::McpServerParams,
) -> Result<(Settings, McpServerConfig)> {
    let (settings, configured) = factory.current_mcp_servers_with_settings()?;
    let mut matching = configured.into_iter().filter(|source| {
        source.config.name == selector.name && source.plugin_id == selector.plugin_id
    });
    let selected = matching
        .next()
        .context("MCP_REVOCATION_SOURCE_UNAVAILABLE")?;
    ensure!(matching.next().is_none(), "MCP_REVOCATION_SOURCE_AMBIGUOUS");
    Ok((settings, selected.config))
}
fn configuration_fingerprint(
    settings: &Settings,
    profile: &PrivateDirectory,
    config: &McpServerConfig,
) -> Result<String> {
    profile.verify_private_directory()?;
    let private = serde_json::to_vec(&serde_json::json!([
        "native-provider-revocation-configuration-v1",
        profile.directory_identity()?,
        config,
        settings.credential_store,
        settings.mcp_server_enabled(&config.name)
    ]))?;
    Ok(format!("{:x}", Sha256::digest(private)))
}
fn source_fingerprint(
    settings: &Settings,
    profile: &PrivateDirectory,
    config: &McpServerConfig,
) -> Result<(String, String)> {
    profile.verify_private_directory()?;
    let authorization = if oauth_configuration(config) {
        let endpoint = reqwest::Url::parse(&config.url)
            .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_ENDPOINT_INVALID"))?;
        ExistingOAuthObservationStore::open_existing_for_account(
            profile,
            config.policy.oauth_account.as_deref(),
        )?
        .map(|store| store.observe_connection(&endpoint))
        .transpose()?
        .flatten()
        .map(|metadata| (metadata.binding_id, metadata.authorization_revision))
    } else {
        None
    };
    // Keep the original v1 receipt comparison unchanged. The separate current
    // configuration stamp uses this same settings observation without OAuth locks.
    let private = serde_json::to_vec(&serde_json::json!([
        "native-provider-revocation-source-v1",
        profile.directory_identity()?,
        config,
        authorization,
        settings.credential_store,
        settings.mcp_server_enabled(&config.name)
    ]))?;
    Ok((
        format!("{:x}", Sha256::digest(private)),
        configuration_fingerprint(settings, profile, config)?,
    ))
}
/// Native-only live factory proof. No JSON/caller fingerprint can construct it.
struct CurrentSourceRevalidator {
    factory: AppServerEngineFactory,
    selector: kcoder_app_protocol::McpServerParams,
    profile_path: std::path::PathBuf,
    profile_identity: String,
    expected_configuration: String,
}
impl CurrentSourceRevalidator {
    fn verify(&self) -> Result<()> {
        let profile = PrivateDirectory::open_existing(&self.profile_path)?;
        profile.verify_private_directory()?;
        ensure!(
            profile.directory_identity()? == self.profile_identity,
            "MCP_REVOCATION_PROFILE_CHANGED"
        );
        let (settings, config) = resolve_snapshot(&self.factory, &self.selector)?;
        ensure!(
            oauth_configuration(&config),
            "MCP_REVOCATION_SOURCE_CHANGED"
        );
        ensure!(
            configuration_fingerprint(&settings, &profile, &config)? == self.expected_configuration,
            "MCP_REVOCATION_SOURCE_CHANGED"
        );
        Ok(())
    }
}
pub(crate) async fn process(factory: AppServerEngineFactory, params: Params) -> Result<Receipt> {
    params.validate().map_err(anyhow::Error::msg)?;
    let request_id = params.request_id().to_owned();
    let selector = params.server().clone();
    let profile_path = factory
        .mcp_user_settings_path()?
        .parent()
        .context("MCP_REVOCATION_PROFILE_REQUIRED")?
        .to_path_buf();
    let profile = PrivateDirectory::open_existing(&profile_path)?;
    profile.verify_private_directory()?;
    let initial_factory = factory.clone();
    let initial_selector = selector.clone();
    let config =
        tokio::task::spawn_blocking(move || resolve_snapshot(&initial_factory, &initial_selector))
            .await?;
    let fingerprint = config
        .as_ref()
        .ok()
        .and_then(|(settings, config)| source_fingerprint(settings, &profile, config).ok());
    if matches!(params, Params::Read { .. } | Params::Cancel { .. }) {
        let account = config
            .as_ref()
            .ok()
            .and_then(|(_, config)| config.policy.oauth_account.as_deref());
        return match OAuthTokenStore::open_existing_for_account(
            &profile_path.join("mcp-oauth"),
            account,
        )? {
            Some(store) => {
                if let Params::Cancel { intent_ref, .. } = &params {
                    store
                        .cancel_provider_revocation(
                            &request_id,
                            intent_ref,
                            fingerprint.as_ref().map(|value| value.0.as_str()),
                        )
                        .await
                } else {
                    store.read_provider_revocation(
                        &request_id,
                        fingerprint.as_ref().map(|value| value.0.as_str()),
                    )
                }
            }
            None => Ok(unavailable(&request_id)),
        };
    }
    let (_, config) = config?;
    let (fingerprint, configuration_stamp) =
        fingerprint.context("MCP_REVOCATION_SOURCE_UNCONFIRMED")?;
    let store = OAuthTokenStore::open_for_account(
        &profile_path.join("mcp-oauth"),
        config.policy.oauth_account.as_deref(),
    )?;
    if !oauth_configuration(&config) {
        return store
            .record_unsupported_provider_revocation(
                &request_id,
                &fingerprint,
                Reason::AuthorizationUnavailable,
            )
            .await;
    }
    let endpoint = reqwest::Url::parse(&config.url)
        .map_err(|_| anyhow::anyhow!("MCP_REVOCATION_ENDPOINT_INVALID"))?;
    let mut receipt = match params {
        Params::Prepare { .. } => {
            store
                .prepare_provider_revocation(&endpoint, &request_id, &fingerprint)
                .await?
        }
        Params::Commit { intent_ref, .. } => {
            let current = CurrentSourceRevalidator {
                factory: factory.clone(),
                selector: selector.clone(),
                profile_path: profile_path.clone(),
                profile_identity: profile.directory_identity()?,
                expected_configuration: configuration_stamp,
            };
            store
                .commit_provider_revocation_revalidated(
                    &endpoint,
                    &request_id,
                    &intent_ref,
                    &fingerprint,
                    move || current.verify(),
                )
                .await?
        }
        Params::Read { .. } | Params::Cancel { .. } => unreachable!(),
    };
    let profile_current = PrivateDirectory::open_existing(&profile_path)
        .and_then(|current| {
            current.verify_private_directory()?;
            Ok(current.directory_identity()? == profile.directory_identity()?)
        })
        .unwrap_or(false);
    let actual = resolve_snapshot(&factory, &selector)
        .ok()
        .and_then(|(settings, current)| source_fingerprint(&settings, &profile, &current).ok())
        .map(|value| value.0);
    receipt.current_source_matches =
        profile_current && actual.as_deref() == Some(fingerprint.as_str());
    receipt.source_state = if !profile_current || actual.is_none() {
        SourceState::Unavailable
    } else if receipt.current_source_matches {
        SourceState::Matches
    } else {
        SourceState::Changed
    };
    Ok(receipt)
}

#[cfg(test)]
mod live_factory_tests {
    use super::*;
    use clap::Parser;
    use std::sync::Arc;
    #[tokio::test]
    async fn actual_factory_revalidator_reloads_endpoint_account_scope_mode_and_enabled_without_oauth_reentry()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile)?;
        std::fs::create_dir(&workspace)?;
        let path = profile.join("settings.json");
        let original = serde_json::json!({"credential_store":"file","providers":{},"mcp_servers":[{"name":"actual-current","transport":"http","url":"https://original.example.test/mcp","policy":{"oauth_account":"original-account","enabled_tools":["original_scope"]}}]});
        std::fs::write(&path, serde_json::to_vec(&original)?)?;
        std::fs::write(profile.join("credentials.json"), b"{}")?;
        let base = Settings::default();
        let storage = Arc::new(kcoder_config::create_private_temp_dir_in(
            &profile,
            "provider-live-factory",
        )?);
        let services =
            kcoder_engine::WorkspaceRuntimeServices::new(&workspace, "provider-live-factory")
                .with_private_client_storage(storage);
        let factory = AppServerEngineFactory::new(
            Arc::new(crate::tui_dev_mock::MockScenarioProvider::new(
                crate::tui_dev_mock::TuiDevScenario::FullTurn,
            )),
            kcoder_tools::ToolRegistry::new(),
            kcoder_permissions::PermissionEngine::from_settings(&base),
            base,
            kcoder_memory::MemoryManager::global_only(kcoder_memory::MemoryStore::empty()),
            kcoder_skills::SkillRegistry::empty(),
            kcoder_plugins::EffectivePluginSnapshot::default(),
            workspace.clone(),
            None,
            false,
            services,
            Some(path.clone()),
            workspace.join("owned-session-ids"),
        )
        .with_session_configuration(
            kcoder_config::SettingsLoader::new(&workspace)
                .with_config_dir(&profile)
                .with_executable_dir(&workspace),
            crate::Cli::parse_from(["kcoder"]),
            false,
        )?;
        let selector = kcoder_app_protocol::McpServerParams {
            name: "actual-current".into(),
            plugin_id: None,
        };
        for change in ["endpoint", "account", "scope", "mode", "enabled"] {
            std::fs::write(&path, serde_json::to_vec(&original)?)?;
            let (snapshot, config) = resolve_snapshot(&factory, &selector)?;
            let pinned = PrivateDirectory::open_existing(&profile)?;
            let current = CurrentSourceRevalidator {
                factory: factory.clone(),
                selector: selector.clone(),
                profile_path: profile.clone(),
                profile_identity: pinned.directory_identity()?,
                expected_configuration: configuration_fingerprint(&snapshot, &pinned, &config)?,
            };
            current.verify()?;
            let mut updated = original.clone();
            match change {
                "endpoint" => {
                    updated["mcp_servers"][0]["url"] =
                        serde_json::json!("https://changed.example.test/mcp")
                }
                "account" => {
                    updated["mcp_servers"][0]["policy"]["oauth_account"] =
                        serde_json::json!("changed-account")
                }
                "scope" => {
                    updated["mcp_servers"][0]["policy"]["enabled_tools"] =
                        serde_json::json!(["changed_scope"])
                }
                "mode" => updated["credential_store"] = serde_json::json!("keyring"),
                "enabled" => {
                    updated["mcp_disabled_servers"] = serde_json::json!(["actual-current"])
                }
                _ => unreachable!(),
            }
            std::fs::write(&path, serde_json::to_vec(&updated)?)?;
            assert!(
                current.verify().is_err(),
                "Actual factory changes must invalidate the pre-dispatch proof"
            );
        }
        assert!(
            !profile.join("mcp-oauth").exists(),
            "The configuration guard must never open/acquire OAuth leases"
        );
        Ok(())
    }
}
