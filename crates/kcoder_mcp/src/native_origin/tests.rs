use super::*;

struct NoOs;
impl CredentialBackend for NoOs {
    fn describe(&self) -> String {
        "owned-origin-fixture".into()
    }
    fn available(&self) -> bool {
        true
    }
    fn get(&self, _: &str) -> Result<Option<String>> {
        anyhow::bail!("fixture never reads personal OS credentials")
    }
    fn set(&self, _: &str, _: &str) -> Result<()> {
        anyhow::bail!("fixture never writes OS credentials")
    }
    fn delete(&self, _: &str) -> Result<()> {
        anyhow::bail!("fixture never deletes OS credentials")
    }
}
#[test]
fn ordinary_missing_context_does_not_borrow_an_ambient_profile() {
    let config: McpServerConfig =
        serde_json::from_value(serde_json::json!({"name":"owned-origin","command":"never-launch"}))
            .unwrap();
    assert!(
        NativeMcpConnectionOrigin::capture_with_backend(&config, None, &NoOs)
            .unwrap()
            .is_none()
    );
}
#[test]
fn original_profile_and_credential_mode_are_exact_and_revocation_is_live() {
    let root = owned_private_temp();
    let other = owned_private_temp();
    let config: McpServerConfig =
        serde_json::from_value(serde_json::json!({"name":"owned-origin","command":"never-launch"}))
            .unwrap();
    let context = CredentialContext {
        config_dir: root.path().to_path_buf(),
        mode: CredentialStoreMode::File,
    };
    let origin = NativeMcpConnectionOrigin::capture_with_backend(&config, Some(&context), &NoOs)
        .unwrap()
        .unwrap();
    assert!(
        origin
            .matches_profile(&PrivateDirectory::open_existing(root.path()).unwrap())
            .unwrap()
    );
    assert!(
        !origin
            .matches_profile(&PrivateDirectory::open_existing(other.path()).unwrap())
            .unwrap()
    );
    assert_eq!(origin.credential_mode(), CredentialStoreMode::File);
    assert!(origin.still_same_credentials_with(&NoOs).unwrap());
    assert!(!root.path().join("mcp-oauth").exists());
    origin.revoke();
    assert!(!origin.is_live());
    assert!(origin.verify_owner().is_err());
}

#[test]
fn actual_private_file_reference_is_frozen_and_revocation_never_relabels_old_origin() {
    use kcoder_config::imported_credentials::{ImportedCredentialStore, mcp::McpSecretValues};
    let root = owned_private_temp();
    let original = serde_json::json!({"credential_store":"file","mcp_servers":[]});
    std::fs::write(root.path().join("settings.json"), original.to_string()).unwrap();
    let mut config: McpServerConfig = serde_json::from_value(serde_json::json!({"name":"owned-private-origin","command":"never-launch","policy":{"required_env":["TOKEN"]}})).unwrap();
    let store = ImportedCredentialStore::open(root.path()).unwrap();
    let reference = store
        .prepare_mcp(
            &config,
            &["TOKEN".into()],
            &[],
            CredentialStoreMode::File,
            &NoOs,
        )
        .unwrap();
    let values = McpSecretValues {
        env: std::collections::BTreeMap::from([(
            "TOKEN".into(),
            "synthetic-owned-native-value".into(),
        )]),
        headers: Default::default(),
    };
    store
        .stage(&reference, &values.encode().unwrap(), &NoOs)
        .unwrap();
    config.policy.credential_ref = Some(reference.mcp_reference().unwrap());
    let group = "group-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    store
        .publish_group(group, std::slice::from_ref(&reference), &NoOs, |document| {
            document["mcp_servers"] = serde_json::json!([config]);
            Ok(())
        })
        .unwrap();
    let context = CredentialContext {
        config_dir: root.path().into(),
        mode: CredentialStoreMode::File,
    };
    let origin = NativeMcpConnectionOrigin::capture_with_backend(&config, Some(&context), &NoOs)
        .unwrap()
        .unwrap();
    let before = origin.credential_revision().unwrap().to_owned();
    assert!(!before.contains("synthetic-owned-native-value"));
    assert!(origin.still_same_credentials_with(&NoOs).unwrap());
    let wrong = CredentialContext {
        config_dir: root.path().into(),
        mode: CredentialStoreMode::Keyring,
    };
    assert!(NativeMcpConnectionOrigin::capture_with_backend(&config, Some(&wrong), &NoOs).is_err());
    store
        .undo_group(group, &NoOs, |document| {
            *document = original;
            Ok(())
        })
        .unwrap();
    assert!(origin.still_same_credentials_with(&NoOs).is_err());
    assert_eq!(
        origin.credential_revision(),
        Some(before.as_str()),
        "old actual connection keeps the original immutable account version"
    );
}

fn owned_private_temp() -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    directory
}

struct NoTransportIo;
#[async_trait::async_trait]
impl crate::McpTransport for NoTransportIo {
    async fn send(&mut self, _: &str) -> Result<()> {
        anyhow::bail!("No transport operation is authorized by the origin boundary test")
    }
    async fn recv(&mut self) -> Result<Option<String>> {
        anyhow::bail!("No transport operation is authorized by the origin boundary test")
    }
}

#[tokio::test]
async fn original_native_origin_attaches_after_same_authorization_refresh_but_refuses_new_epoch()
-> Result<()> {
    use crate::{
        authorization::AuthorizationServerMetadata,
        authorization_index::ConnectionAuthorization,
        authorization_registration::{RegisteredClient, RegistrationMethod},
        authorization_store::{CredentialBinding, OAuthTokenStore},
        authorization_tokens::OAuthTokens,
    };
    use reqwest::Url;
    let profile = owned_private_temp();
    let context = CredentialContext {
        config_dir: profile.path().to_owned(),
        mode: CredentialStoreMode::File,
    };
    let config: McpServerConfig = serde_json::from_value(
        serde_json::json!({"name":"original-refresh-source","transport":"http","url":"https://mcp.example.test/mcp","policy":{"oauth_account":"original-account-slot"}}),
    )?;
    let endpoint = Url::parse(&config.url)?;
    let metadata: AuthorizationServerMetadata = serde_json::from_value(
        serde_json::json!({"issuer":"https://issuer.example.test/","authorization_endpoint":"https://issuer.example.test/authorize","token_endpoint":"https://issuer.example.test/token","response_types_supported":["code"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"]}),
    )?;
    let binding = CredentialBinding {
        resource: Url::parse("https://mcp.example.test/")?,
        issuer: Url::parse(&metadata.issuer)?,
        client_id: "original-client".into(),
        token_endpoint: Url::parse(&metadata.token_endpoint)?,
    };
    let redirect = Url::parse("http://127.0.0.1:34567/callback")?;
    let store = OAuthTokenStore::open_for_account(
        &profile.path().join("mcp-oauth"),
        config.policy.oauth_account.as_deref(),
    )?;
    store
        .acquire_registration(&metadata, &redirect)
        .await?
        .save(&RegisteredClient::manual(
            &metadata,
            binding.client_id.clone(),
            None,
            RegistrationMethod::Public,
            &redirect,
        )?)?;
    let saved = ConnectionAuthorization {
        binding: binding.clone(),
        metadata,
        redirect_uri: redirect,
    };
    let mut association = store.acquire_connection(&endpoint).await?;
    association.invalidate_pending()?;
    association.save(&saved)?;
    drop(association);
    let token = |expiry| {
        OAuthTokens::from_store_bytes(
            &serde_json::to_vec(
                &serde_json::json!({"version":2,"refresh_pending":false,"resource":binding.resource.as_str(),"issuer":binding.issuer.as_str(),"client_id":binding.client_id,"token_endpoint":binding.token_endpoint.as_str(),"access_token":"SYNTHETIC_NATIVE_ORIGIN_ACCESS","refresh_token":"SYNTHETIC_NATIVE_ORIGIN_REFRESH","scope":"read","expires_at_ms":expiry}),
            )?,
            &binding.resource,
            &binding.issuer,
            &binding.client_id,
            &binding.token_endpoint,
        )
    };
    store.acquire(binding.clone()).await?.save(&token(1)?)?;
    let origin =
        NativeMcpConnectionOrigin::capture_with_backend(&config, Some(&context), &NoOs)?.unwrap();
    let original = origin.oauth_metadata().unwrap().clone();
    assert_eq!(
        original.state,
        crate::authorization_index::observe::OAuthObservationState::Expired
    );
    let future = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64
        + 60_000;
    store
        .acquire(binding.clone())
        .await?
        .save(&token(future)?)?;
    let authoritative_fresh = observe_oauth(&origin.profile, &config)?.unwrap();
    let handle = Arc::new(tokio::sync::Mutex::new(crate::McpClient::with_transport(
        Box::new(NoTransportIo),
    )));
    attach_after_connect(&handle, Some(origin.clone())).await;
    let attached = handle
        .lock()
        .await
        .native_origin()
        .expect("A known refresh of the same authorization must retain Native provenance");
    let fresh = attached.oauth_metadata().unwrap();
    assert_eq!(fresh.binding_id, original.binding_id);
    assert_eq!(
        fresh.authorization_revision,
        original.authorization_revision
    );
    assert_eq!(
        fresh.state,
        crate::authorization_index::observe::OAuthObservationState::Authorized
    );
    assert_eq!(fresh, &authoritative_fresh);
    let stale =
        NativeMcpConnectionOrigin::capture_with_backend(&config, Some(&context), &NoOs)?.unwrap();
    store.acquire_connection(&endpoint).await?.save(&saved)?;
    let other = Arc::new(tokio::sync::Mutex::new(crate::McpClient::with_transport(
        Box::new(NoTransportIo),
    )));
    attach_after_connect(&other, Some(stale.clone())).await;
    assert!(other.lock().await.native_origin().is_none());
    assert!(
        !stale.is_live(),
        "An actual new authorization epoch cannot relabel the original connection"
    );
    handle.lock().await.close();
    assert!(
        !origin.is_live(),
        "The attached observation retains the original connection owner"
    );
    Ok(())
}
