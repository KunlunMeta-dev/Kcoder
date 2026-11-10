use super::*;
use crate::{authorization_registration::RegistrationMethod, authorization_store::OAuthTokenStore};
use std::{collections::BTreeMap, path::Path};

fn connection() -> ConnectionAuthorization {
    let metadata:AuthorizationServerMetadata=serde_json::from_value(serde_json::json!({
        "issuer":"https://auth.example.test/","authorization_endpoint":"https://auth.example.test/authorize",
        "token_endpoint":"https://auth.example.test/token","response_types_supported":["code"],
        "code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"]
    })).unwrap();
    ConnectionAuthorization {
        binding: crate::authorization_store::CredentialBinding {
            resource: Url::parse("https://mcp.example.test/").unwrap(),
            issuer: Url::parse(&metadata.issuer).unwrap(),
            client_id: "real-configured-native-client-fixture".into(),
            token_endpoint: Url::parse(&metadata.token_endpoint).unwrap(),
        },
        metadata,
        redirect_uri: Url::parse("http://127.0.0.1:45678/callback").unwrap(),
    }
}
fn tokens(
    binding: &crate::authorization_store::CredentialBinding,
    access: &str,
    expiry: Option<u64>,
) -> OAuthTokens {
    OAuthTokens::from_store_bytes(&serde_json::to_vec(&serde_json::json!({
        "version":2,"refresh_pending":false,"resource":binding.resource.as_str(),"issuer":binding.issuer.as_str(),
        "client_id":binding.client_id,"token_endpoint":binding.token_endpoint.as_str(),"access_token":access,
        "refresh_token":"SYNTHETIC_PRIVATE_REFRESH_FIXTURE","expires_at_ms":expiry,"scope":"read"
    })).unwrap(),&binding.resource,&binding.issuer,&binding.client_id,&binding.token_endpoint).unwrap()
}
fn fixture() -> Result<(tempfile::TempDir, PrivateDirectory)> {
    let temp = tempfile::tempdir()?;
    let root = PrivateDirectory::open_or_create(temp.path())?;
    let profile = root.create_private_child(OsStr::new("profile"))?;
    Ok((temp, profile))
}
async fn install(store: &OAuthTokenStore, endpoint: &Url) -> Result<ConnectionAuthorization> {
    let saved = connection();
    let mut association = store.acquire_connection(endpoint).await?;
    association.invalidate_pending()?;
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
    store.acquire(saved.binding.clone()).await?.save(&tokens(
        &saved.binding,
        "SYNTHETIC_PRIVATE_ACCESS_FIXTURE",
        None,
    ))?;
    association.save(&saved)?;
    Ok(saved)
}
fn tree(path: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(base: &Path, path: &Path, files: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                visit(base, &path, files);
            } else {
                files.insert(
                    path.strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    std::fs::read(path).unwrap(),
                );
            }
        }
    }
    let mut files = BTreeMap::new();
    visit(path, path, &mut files);
    files
}

#[test]
fn missing_store_observation_creates_nothing_and_does_not_chmod() -> Result<()> {
    let (temp, profile) = fixture()?;
    let before = tree(temp.path());
    assert!(ExistingOAuthObservationStore::open_existing(&profile)?.is_none());
    assert_eq!(before, tree(temp.path()));
    Ok(())
}

#[tokio::test]
async fn explicit_account_slots_isolate_same_endpoint_client_tokens_and_logout() -> Result<()> {
    let (temp, profile) = fixture()?;
    let path = temp.path().join("profile/mcp-oauth");
    let endpoint = Url::parse("https://mcp.example.test/mcp")?;
    let first = OAuthTokenStore::open_for_account(&path, Some("account-a"))?;
    let second = OAuthTokenStore::open_for_account(&path, Some("account-b"))?;
    let saved = install(&first, &endpoint).await?;
    install(&second, &endpoint).await?;
    second.acquire(saved.binding.clone()).await?.save(&tokens(
        &saved.binding,
        "SYNTHETIC_SECOND_SUBJECT_ACCESS",
        None,
    ))?;
    assert_eq!(
        first
            .acquire(saved.binding.clone())
            .await?
            .load()?
            .unwrap()
            .access_token(),
        "SYNTHETIC_PRIVATE_ACCESS_FIXTURE"
    );
    assert_eq!(
        second
            .acquire(saved.binding.clone())
            .await?
            .load()?
            .unwrap()
            .access_token(),
        "SYNTHETIC_SECOND_SUBJECT_ACCESS"
    );
    let observe_a =
        ExistingOAuthObservationStore::open_existing_for_account(&profile, Some("account-a"))?
            .unwrap();
    let observe_b =
        ExistingOAuthObservationStore::open_existing_for_account(&profile, Some("account-b"))?
            .unwrap();
    let a = observe_a.observe_connection(&endpoint)?.unwrap();
    let b = observe_b.observe_connection(&endpoint)?.unwrap();
    assert_ne!(a.binding_id, b.binding_id);
    assert!(
        ExistingOAuthObservationStore::open_existing(&profile)?
            .unwrap()
            .observe_connection(&endpoint)?
            .is_none()
    );
    first.acquire(saved.binding.clone()).await?.save(&tokens(
        &saved.binding,
        "SYNTHETIC_FIRST_SUBJECT_REFRESH",
        None,
    ))?;
    assert_eq!(a, observe_a.observe_connection(&endpoint)?.unwrap());
    assert_eq!(b, observe_b.observe_connection(&endpoint)?.unwrap());
    first.logout_endpoint(&endpoint).await?;
    assert!(observe_a.observe_connection(&endpoint)?.is_none());
    assert_eq!(b, observe_b.observe_connection(&endpoint)?.unwrap());
    assert_eq!(
        second
            .acquire(saved.binding)
            .await?
            .load()?
            .unwrap()
            .access_token(),
        "SYNTHETIC_SECOND_SUBJECT_ACCESS"
    );
    let reopened = OAuthTokenStore::open_for_account(&path, Some("account-b"))?;
    assert!(
        reopened
            .acquire_connection(&endpoint)
            .await?
            .load()?
            .is_some()
    );
    Ok(())
}

#[test]
fn invalid_account_slots_cannot_create_a_store() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let path = temp.path().join("must-not-create");
    for account in ["", "../other", "account space", "a/b", "账户"] {
        assert!(OAuthTokenStore::open_for_account(&path, Some(account)).is_err());
    }
    assert!(!path.exists());
    Ok(())
}

#[tokio::test]
async fn existing_authorization_observation_is_readonly_and_contains_no_secret_digest() -> Result<()>
{
    let (temp, profile) = fixture()?;
    let store = OAuthTokenStore::open(&temp.path().join("profile/mcp-oauth"))?;
    let endpoint = Url::parse("https://mcp.example.test/mcp?tenant=owned")?;
    let saved = install(&store, &endpoint).await?;
    let observer = ExistingOAuthObservationStore::open_existing(&profile)?.unwrap();
    let before = tree(temp.path());
    let first = observer.observe_connection(&endpoint)?.unwrap();
    assert_eq!(first.state, OAuthObservationState::Authorized);
    assert_eq!(first.expires_at_ms, None);
    assert!(!format!("{first:?}").contains("SYNTHETIC_PRIVATE"));
    assert_ne!(
        first.authorization_revision,
        format!("{:x}", Sha256::digest(b"SYNTHETIC_PRIVATE_ACCESS_FIXTURE"))
    );
    assert_eq!(first, observer.observe_connection(&endpoint)?.unwrap());
    assert_eq!(before, tree(temp.path()));
    // Refresh rotates token bytes, not the stored native authorization association.
    store.acquire(saved.binding.clone()).await?.save(&tokens(
        &saved.binding,
        "SYNTHETIC_REFRESHED_ACCESS_FIXTURE",
        None,
    ))?;
    let refreshed = observer.observe_connection(&endpoint)?.unwrap();
    assert_eq!(first.binding_id, refreshed.binding_id);
    assert_eq!(
        first.authorization_revision,
        refreshed.authorization_revision
    );
    // Completing a new authorization changes actual association-file version,
    // even when the resource/issuer/client and granted scopes are unchanged.
    store.acquire_connection(&endpoint).await?.save(&saved)?;
    let reauthorized = observer.observe_connection(&endpoint)?.unwrap();
    assert_eq!(first.binding_id, reauthorized.binding_id);
    assert_ne!(
        refreshed.authorization_revision,
        reauthorized.authorization_revision
    );
    Ok(())
}

#[tokio::test]
async fn missing_connection_lock_or_generation_is_unknown_and_never_repaired() -> Result<()> {
    let (temp, profile) = fixture()?;
    let store = OAuthTokenStore::open(&temp.path().join("profile/mcp-oauth"))?;
    let endpoint = Url::parse("https://mcp.example.test/mcp")?;
    install(&store, &endpoint).await?;
    let observer = ExistingOAuthObservationStore::open_existing(&profile)?.unwrap();
    let key = format!(
        "connection-{:x}",
        Sha256::digest(endpoint.as_str().as_bytes())
    );
    std::fs::remove_file(
        temp.path()
            .join("profile/mcp-oauth")
            .join(format!("{key}.json.generation")),
    )?;
    let before = tree(temp.path());
    assert_eq!(
        observer.observe_connection(&endpoint)?.unwrap().state,
        OAuthObservationState::Unknown
    );
    assert_eq!(before, tree(temp.path()));
    std::fs::remove_file(
        temp.path()
            .join("profile/mcp-oauth")
            .join(format!("{key}.lock")),
    )?;
    let before = tree(temp.path());
    assert!(observer.observe_connection(&endpoint).is_err());
    assert_eq!(before, tree(temp.path()));
    Ok(())
}

#[tokio::test]
async fn shared_credential_logout_through_alias_revokes_observed_authorization() -> Result<()> {
    let (temp, profile) = fixture()?;
    let store = OAuthTokenStore::open(&temp.path().join("profile/mcp-oauth"))?;
    let first = Url::parse("https://mcp.example.test/mcp?alias=first")?;
    let second = Url::parse("https://mcp.example.test/mcp?alias=second")?;
    install(&store, &first).await?;
    install(&store, &second).await?;
    let observer = ExistingOAuthObservationStore::open_existing(&profile)?.unwrap();
    let before = observer.observe_connection(&second)?.unwrap();
    assert_eq!(before.state, OAuthObservationState::Authorized);
    store.logout_endpoint(&first).await?;
    let after = observer.observe_connection(&second)?.unwrap();
    assert_eq!(after.binding_id, before.binding_id);
    assert_eq!(after.state, OAuthObservationState::NotAuthorized);
    assert_ne!(after.authorization_revision, before.authorization_revision);
    Ok(())
}

#[tokio::test]
async fn uncertain_refresh_and_expiry_are_distinct_from_authorized() -> Result<()> {
    let (temp, profile) = fixture()?;
    let store = OAuthTokenStore::open(&temp.path().join("profile/mcp-oauth"))?;
    let endpoint = Url::parse("https://mcp.example.test/mcp")?;
    let saved = install(&store, &endpoint).await?;
    let observer = ExistingOAuthObservationStore::open_existing(&profile)?.unwrap();
    let key = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            saved.binding.resource.as_str(),
            saved.binding.issuer.as_str(),
            &saved.binding.client_id,
        ))?)
    );
    let path = temp
        .path()
        .join("profile/mcp-oauth")
        .join(format!("{key}.json"));
    let mut document: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    document["refresh_pending"] = serde_json::json!(true);
    // This explicitly owned fixture stages the actual persisted uncertain-refresh state.
    store.directory.atomic_replace(
        OsStr::new(&format!("{key}.json")),
        &serde_json::to_vec(&document)?,
    )?;
    assert_eq!(
        observer.observe_connection(&endpoint)?.unwrap().state,
        OAuthObservationState::ReauthorizationRequired
    );
    document["refresh_pending"] = serde_json::json!(false);
    document["expires_at_ms"] = serde_json::json!(1);
    store.directory.atomic_replace(
        OsStr::new(&format!("{key}.json")),
        &serde_json::to_vec(&document)?,
    )?;
    let expired = observer.observe_connection(&endpoint)?.unwrap();
    assert_eq!(expired.state, OAuthObservationState::Expired);
    assert_eq!(expired.expires_at_ms, Some(1));
    Ok(())
}

#[tokio::test]
async fn existing_writer_lock_and_replaced_store_do_not_gain_an_observation() -> Result<()> {
    let (temp, profile) = fixture()?;
    let store = OAuthTokenStore::open(&temp.path().join("profile/mcp-oauth"))?;
    let endpoint = Url::parse("https://mcp.example.test/mcp")?;
    install(&store, &endpoint).await?;
    let observer = ExistingOAuthObservationStore::open_existing(&profile)?.unwrap();
    let writer = store.acquire_connection(&endpoint).await?;
    let before = tree(temp.path());
    assert!(observer.observe_connection(&endpoint).is_err());
    assert_eq!(before, tree(temp.path()));
    drop(writer);
    std::fs::rename(
        temp.path().join("profile/mcp-oauth"),
        temp.path().join("profile/retired-original-oauth"),
    )?;
    profile.create_private_child(OsStr::new(STORE))?;
    let before = tree(temp.path());
    assert!(observer.observe_connection(&endpoint).is_err());
    assert_eq!(before, tree(temp.path()));
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn exposed_or_hard_linked_records_are_refused_without_permission_repair() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let (temp, profile) = fixture()?;
    let store = OAuthTokenStore::open(&temp.path().join("profile/mcp-oauth"))?;
    let endpoint = Url::parse("https://mcp.example.test/mcp")?;
    install(&store, &endpoint).await?;
    let observer = ExistingOAuthObservationStore::open_existing(&profile)?.unwrap();
    let key = format!(
        "connection-{:x}.json",
        Sha256::digest(endpoint.as_str().as_bytes())
    );
    let path = temp.path().join("profile/mcp-oauth").join(&key);
    std::fs::hard_link(&path, temp.path().join("owned-linked-metadata"))?;
    assert!(observer.observe_connection(&endpoint).is_err());
    std::fs::remove_file(temp.path().join("owned-linked-metadata"))?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))?;
    assert!(observer.observe_connection(&endpoint).is_err());
    assert_eq!(
        std::fs::metadata(&path)?.permissions().mode() & 0o777,
        0o644
    );
    Ok(())
}
