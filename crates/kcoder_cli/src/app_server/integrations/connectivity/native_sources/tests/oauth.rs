use super::*;
use kcoder_mcp::{
    authorization::AuthorizationServerMetadata,
    authorization_index::ConnectionAuthorization,
    authorization_registration::{RegisteredClient, RegistrationMethod},
    authorization_store::{CredentialBinding, OAuthTokenStore},
};
use reqwest::Url;

struct OAuthFixture {
    store: OAuthTokenStore,
    saved: ConnectionAuthorization,
    directory: PrivateDirectory,
    endpoint: Url,
    token_name: String,
}

#[tokio::test]
async fn managed_plugin_root_environment_preserves_existing_oauth_store_epoch_and_logout()
-> Result<()> {
    let (temp, context) = super::super::super::lease::tests::fixture()?;
    let endpoint = Url::parse("https://mcp.example.test/managed-plugin")?;
    let oauth = OAuthFixture::install(&context, endpoint.clone()).await?;
    let source = temp.path().join("owned-oauth-plugin");
    std::fs::create_dir_all(source.join(".claude-plugin"))?;
    std::fs::write(source.join(".claude-plugin/plugin.json"), json!({"name":"owned-oauth-roots","version":"1.0.0","mcpServers":{"peer":{"type":"http","url":endpoint.as_str()}}}).to_string())?;
    let store = kcoder_plugins::PluginStore::open(&context.profile_path()?.join("plugin_store"))?;
    let installed = store.install_local(&source, "owned")?;
    let plugin = installed.plugin_id.to_string();
    let snapshot = kcoder_plugins::PluginRegistry::discover_with_store(
        &temp.path().join("workspace"),
        true,
        &store,
    )?
    .effective_snapshot();
    let config = snapshot
        .mcp_configs
        .iter()
        .zip(&snapshot.mcp_config_sources)
        .find(|(_, item)| item.plugin_id == plugin)
        .context("actual managed HTTP contribution")?
        .0;
    let settings = Settings::default();
    let mut current = fact(&context, &settings, config, Some(&plugin))?;
    current.certify_plugin_root_environment(&context, config, &snapshot)?;
    let catalog = NativeConnectivitySourceCatalog::initialize(&context, "managed-oauth-roots")?;
    catalog.register(
        &context,
        "managed-oauth-source",
        std::slice::from_ref(&current),
    )?;
    let selected = catalog
        .current_choices(&context, std::slice::from_ref(&current))?
        .remove(0);
    assert!(
        selected.account_ref.as_ref().is_some(),
        "Non-secret root paths cannot turn HTTP OAuth into a no-account source"
    );
    catalog.resolve_choice(&context, &selected, std::slice::from_ref(&current))?;
    oauth.store.logout_endpoint(&endpoint).await?;
    let mut revoked = fact(&context, &settings, config, Some(&plugin))?;
    revoked.certify_plugin_root_environment(&context, config, &snapshot)?;
    assert!(
        catalog
            .resolve_choice(&context, &selected, &[revoked])
            .is_err()
    );
    Ok(())
}
impl OAuthFixture {
    async fn install(context: &NativeIntegrationContext, endpoint: Url) -> Result<Self> {
        let metadata: AuthorizationServerMetadata = serde_json::from_value(json!({
            "issuer":"https://auth.example.test/","authorization_endpoint":"https://auth.example.test/authorize",
            "token_endpoint":"https://auth.example.test/token","response_types_supported":["code"],
            "code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"]
        }))?;
        let saved = ConnectionAuthorization {
            binding: CredentialBinding {
                resource: Url::parse("https://mcp.example.test/")?,
                issuer: Url::parse(&metadata.issuer)?,
                client_id: "owned-native-oauth-account-fixture".into(),
                token_endpoint: Url::parse(&metadata.token_endpoint)?,
            },
            metadata,
            redirect_uri: Url::parse("http://127.0.0.1:45678/callback")?,
        };
        let store = OAuthTokenStore::open(&context.profile_path()?.join("mcp-oauth"))?;
        let directory = context
            .profile()?
            .open_entry_handle(OsStr::new("mcp-oauth"))?
            .open_child_directory()?;
        let mut registration = store
            .acquire_registration(&saved.metadata, &saved.redirect_uri)
            .await?;
        registration.save(&RegisteredClient::manual(
            &saved.metadata,
            saved.binding.client_id.clone(),
            None,
            RegistrationMethod::Public,
            &saved.redirect_uri,
        )?)?;
        drop(registration);
        let token_name = format!(
            "{:x}.json",
            Sha256::digest(serde_json::to_vec(&(
                saved.binding.resource.as_str(),
                saved.binding.issuer.as_str(),
                &saved.binding.client_id,
            ))?)
        );
        let fixture = Self {
            store,
            saved,
            directory,
            endpoint,
            token_name,
        };
        fixture
            .token("SYNTHETIC_NATIVE_OAUTH_ACCESS", None, false)
            .await?;
        fixture.association(&fixture.endpoint).await?;
        Ok(fixture)
    }
    async fn association(&self, endpoint: &Url) -> Result<()> {
        let mut lease = self.store.acquire_connection(endpoint).await?;
        lease.save(&self.saved)?;
        let key = format!(
            "connection-{:x}.json.generation",
            Sha256::digest(endpoint.as_str().as_bytes())
        );
        // Explicit controlled fixture for the existing native authorization epoch.
        // The production source reader only observes it; it cannot write/repair it.
        self.directory
            .atomic_replace(OsStr::new(&key), "ab".repeat(32).as_bytes())
    }
    async fn token(&self, access: &str, expiry: Option<u64>, pending: bool) -> Result<()> {
        let _lease = self.store.acquire(self.saved.binding.clone()).await?;
        // The real MCP parser validates this isolated wire fixture. No server,
        // platform account, keyring, refresh request or external login is used.
        let body = json!({"version":2,"refresh_pending":pending,"resource":self.saved.binding.resource.as_str(),
            "issuer":self.saved.binding.issuer.as_str(),"client_id":self.saved.binding.client_id,
            "token_endpoint":self.saved.binding.token_endpoint.as_str(),"access_token":access,"refresh_token":null,
            "expires_at_ms":expiry,"scope":"read"});
        self.directory
            .atomic_replace(OsStr::new(&self.token_name), &serde_json::to_vec(&body)?)
    }
}

#[tokio::test]
async fn native_oauth_account_revision_is_actual_and_refresh_stays_stable_while_reauthorization_changes_it()
-> Result<()> {
    let (_temp, context) = super::super::super::lease::tests::fixture()?;
    let endpoint = Url::parse("https://mcp.example.test/mcp?tenant=owned")?;
    let oauth = OAuthFixture::install(&context, endpoint.clone()).await?;
    let config: McpServerConfig = serde_json::from_value(
        json!({"name":"native-oauth-source","transport":"http","url":endpoint.as_str()}),
    )?;
    let settings = Settings::default();
    let facts = vec![fact(&context, &settings, &config, None)?];
    let catalog =
        NativeConnectivitySourceCatalog::initialize(&context, "oauth-native-source-opt-in")?;
    catalog.register(&context, "register-actual-oauth-account", &facts)?;
    let inventory = catalog.inventory(&context, &facts, &registry(&config.name, None))?;
    assert_eq!(
        inventory.task_sources[0].state,
        IntegrationTaskCapabilitySourceState::Ready
    );
    let selected = choice(&inventory.task_sources[0]);
    assert!(
        selected
            .account_ref
            .as_ref()
            .unwrap()
            .id
            .starts_with("native-oauth-")
    );
    assert!(!serde_json::to_string(&inventory)?.contains("SYNTHETIC_NATIVE_OAUTH_ACCESS"));
    catalog.resolve_choice(&context, &selected, &facts)?;
    oauth
        .token("SYNTHETIC_NATIVE_OAUTH_REFRESHED", None, false)
        .await?;
    let refreshed = vec![fact(&context, &settings, &config, None)?];
    assert_eq!(
        catalog
            .inventory(&context, &refreshed, &registry(&config.name, None))?
            .task_sources[0]
            .account_ref,
        selected.account_ref
    );
    catalog.resolve_choice(&context, &selected, &refreshed)?;
    oauth.association(&endpoint).await?;
    let reauthorized = vec![fact(&context, &settings, &config, None)?];
    assert!(
        catalog
            .resolve_choice(&context, &selected, &reauthorized)
            .is_err()
    );
    assert_eq!(
        catalog
            .inventory(&context, &reauthorized, &registry(&config.name, None))?
            .task_sources[0]
            .state,
        IntegrationTaskCapabilitySourceState::Unknown
    );
    catalog.register(&context, "register-new-native-authorization", &reauthorized)?;
    let next = catalog.inventory(&context, &reauthorized, &registry(&config.name, None))?;
    assert_ne!(next.task_sources[0].account_ref, selected.account_ref);
    assert_ne!(next.task_sources[0].source_ref, selected.source_ref);
    catalog.resolve_choice(&context, &choice(&next.task_sources[0]), &reauthorized)?;
    Ok(())
}

#[tokio::test]
async fn native_oauth_expiry_uncertain_refresh_and_alias_logout_block_current_registered_tools()
-> Result<()> {
    let (_temp, context) = super::super::super::lease::tests::fixture()?;
    let endpoint = Url::parse("https://mcp.example.test/mcp?alias=original")?;
    let oauth = OAuthFixture::install(&context, endpoint.clone()).await?;
    let config: McpServerConfig = serde_json::from_value(
        json!({"name":"native-oauth-source","transport":"http","url":endpoint.as_str()}),
    )?;
    let settings = Settings::default();
    let facts = vec![fact(&context, &settings, &config, None)?];
    let catalog =
        NativeConnectivitySourceCatalog::initialize(&context, "oauth-native-source-opt-in")?;
    catalog.register(&context, "register-actual-oauth-account", &facts)?;
    let selected = choice(
        &catalog
            .inventory(&context, &facts, &registry(&config.name, None))?
            .task_sources[0],
    );
    for (expiry, pending) in [(Some(1), false), (None, true)] {
        oauth
            .token("SYNTHETIC_NO_EXTERNAL_AUTHORIZATION", expiry, pending)
            .await?;
        let unavailable = vec![fact(&context, &settings, &config, None)?];
        let inventory = catalog.inventory(&context, &unavailable, &registry(&config.name, None))?;
        assert_eq!(
            inventory.task_sources[0].state,
            IntegrationTaskCapabilitySourceState::Unauthorized
        );
        assert!(inventory.tools.is_empty());
        assert!(
            catalog
                .resolve_choice(&context, &selected, &unavailable)
                .is_err()
        );
    }
    oauth
        .token("SYNTHETIC_CONTROLLED_AUTHORIZATION", None, false)
        .await?;
    let alias = Url::parse("https://mcp.example.test/mcp?alias=peer")?;
    oauth.association(&alias).await?;
    oauth.store.logout_endpoint(&alias).await?;
    let logged_out = vec![fact(&context, &settings, &config, None)?];
    assert_eq!(
        catalog
            .inventory(&context, &logged_out, &registry(&config.name, None))?
            .task_sources[0]
            .state,
        IntegrationTaskCapabilitySourceState::Unauthorized
    );
    assert!(
        catalog
            .resolve_choice(&context, &selected, &logged_out)
            .is_err()
    );
    Ok(())
}
