use super::*;
use crate::{
    authorization_flow::PendingAuthorization,
    authorization_registration::{RegisteredClient, RegistrationMethod},
};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ACCESS: &str = "SYNTHETIC_REVOCATION_ACCESS";
const REFRESH: &str = "SYNTHETIC_REVOCATION_REFRESH";
const SOURCE: &str = "owned-native-source-and-authorization-epoch";
type Probe = Arc<dyn Fn() + Send + Sync>;
struct Fixture {
    root: tempfile::TempDir,
    store: Arc<OAuthTokenStore>,
    endpoint: Url,
    mode: Arc<AtomicUsize>,
    posts: Arc<AtomicUsize>,
    probe: Arc<Mutex<Option<Probe>>>,
    mcp_requests: Arc<AtomicUsize>,
    token_requests: Arc<AtomicUsize>,
    hold: Arc<AtomicBool>,
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
impl Fixture {
    async fn new(advertise: bool) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}", listener.local_addr()?);
        let metadata = serde_json::json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"response_types_supported":["code"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"revocation_endpoint":if advertise { Some(format!("{base}/revoke")) } else { None },"revocation_endpoint_auth_methods_supported":["none"]});
        let mode = Arc::new(AtomicUsize::new(0));
        let posts = Arc::new(AtomicUsize::new(0));
        let probe: Arc<Mutex<Option<Probe>>> = Arc::new(Mutex::new(None));
        let (server_mode, server_posts, server_probe) =
            (mode.clone(), posts.clone(), probe.clone());
        let mcp_requests = Arc::new(AtomicUsize::new(0));
        let token_requests = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let (server_mcp, server_tokens, server_hold, server_entered, server_release) = (
            mcp_requests.clone(),
            token_requests.clone(),
            hold.clone(),
            entered.clone(),
            release.clone(),
        );
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 2048];
                let end = loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                    assert!(bytes.len() < 32 * 1024);
                    if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let headers = std::str::from_utf8(&bytes[..end]).unwrap().to_owned();
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .to_owned();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < end + length {
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    assert!(bytes.len() < 32 * 1024);
                }
                let (status, body) = if path.starts_with("/.well-known/") {
                    ("200 OK", metadata.to_string())
                } else if path.starts_with("/mcp") {
                    server_mcp.fetch_add(1, Ordering::SeqCst);
                    assert!(headers.to_ascii_lowercase().contains(&format!(
                        "authorization: bearer {}",
                        ACCESS.to_ascii_lowercase()
                    )));
                    let input: serde_json::Value = serde_json::from_slice(&bytes[end..]).unwrap();
                    if input.get("id").is_none() {
                        ("202 Accepted", String::new())
                    } else {
                        let result = match input["method"].as_str().unwrap() {
                            "initialize" => {
                                serde_json::json!({"protocolVersion":input["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"owned-provider-resource","version":"1"}})
                            }
                            "tools/list" => {
                                serde_json::json!({"tools":[{"name":"read_owned","description":"Owned source read","inputSchema":{"type":"object","additionalProperties":false}}]})
                            }
                            "tools/call" => {
                                serde_json::json!({"content":[{"type":"text","text":"Owned original source result"}]})
                            }
                            _ => panic!("Unexpected owned test RPC method"),
                        };
                        (
                            "200 OK",
                            serde_json::json!({"jsonrpc":"2.0","id":input["id"],"result":result})
                                .to_string(),
                        )
                    }
                } else if path == "/token" {
                    server_tokens.fetch_add(1, Ordering::SeqCst);
                    let form: std::collections::HashMap<_, _> = Url::parse(&format!(
                        "http://127.0.0.1/?{}",
                        std::str::from_utf8(&bytes[end..]).unwrap()
                    ))
                    .unwrap()
                    .query_pairs()
                    .into_owned()
                    .collect();
                    assert!(
                        form.get("grant_type")
                            .is_some_and(|value| value == "authorization_code")
                    );
                    ("200 OK", serde_json::json!({"access_token":ACCESS,"refresh_token":REFRESH,"token_type":"Bearer","expires_in":3600,"scope":"read"}).to_string())
                } else {
                    assert_eq!(path, "/revoke");
                    server_posts.fetch_add(1, Ordering::SeqCst);
                    let form: std::collections::HashMap<_, _> = Url::parse(&format!(
                        "http://127.0.0.1/?{}",
                        std::str::from_utf8(&bytes[end..]).unwrap()
                    ))
                    .unwrap()
                    .query_pairs()
                    .into_owned()
                    .collect();
                    assert!(form.get("token").is_some_and(|value| value == REFRESH));
                    assert!(
                        form.get("token_type_hint")
                            .is_some_and(|value| value == "refresh_token")
                    );
                    assert!(
                        form.get("client_id")
                            .is_some_and(|value| value == "owned-public-client")
                    );
                    let check = server_probe.lock().unwrap().clone();
                    if let Some(check) = check {
                        check();
                    }
                    server_entered.notify_one();
                    if server_hold.load(Ordering::SeqCst) {
                        server_release.notified().await;
                    }
                    match server_mode.load(Ordering::SeqCst) {
                        1 => continue,
                        2 => (
                            "400 Bad Request",
                            "{\"error\":\"unsupported_token_type\"}".into(),
                        ),
                        _ => ("200 OK", format!("ignored response body {ACCESS}")),
                    }
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nMcp-Session-Id: owned-original-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let root = tempfile::tempdir()?;
        kcoder_config::set_user_only_dir_permissions(root.path())?;
        let store = Arc::new(OAuthTokenStore::open_for_account(
            &root.path().join("mcp-oauth"),
            Some("original-account"),
        )?);
        let metadata =
            crate::authorization::discover_authorization_server(&Url::parse(&base)?).await?;
        let endpoint = Url::parse(&format!("{base}/mcp?original=true"))?;
        let redirect = Url::parse("http://127.0.0.1:34567/callback")?;
        let client = RegisteredClient::manual(
            &metadata,
            "owned-public-client".into(),
            None,
            RegistrationMethod::Public,
            &redirect,
        )?;
        let mut flow = PendingAuthorization::begin_for_endpoint(
            &store,
            &endpoint,
            &metadata,
            &endpoint,
            &redirect,
            &["read".into()],
            Some(client),
        )
        .await?;
        let state = flow
            .authorization_url()
            .query_pairs()
            .find(|(name, _)| name == "state")
            .unwrap()
            .1
            .into_owned();
        let mut callback = redirect;
        callback
            .query_pairs_mut()
            .append_pair("state", &state)
            .append_pair("code", "owned-private-authorization-code");
        flow.complete(&store, &callback).await?;
        Ok(Self {
            root,
            store,
            endpoint,
            mode,
            posts,
            probe,
            mcp_requests,
            token_requests,
            hold,
            entered,
            release,
            task: Some(task),
        })
    }
    async fn lease(&self) -> Result<OAuthCredentialLease> {
        let association = self.store.acquire_connection(&self.endpoint).await?;
        let saved = association.load()?.unwrap();
        self.store.acquire(saved.binding).await
    }
    async fn close(mut self) {
        let task = self.task.take().unwrap();
        task.abort();
        let _ = task.await;
    }
}

#[tokio::test]
async fn actual_provider_accepts_original_token_only_after_durable_unknown_receipt_and_credential_fence()
-> Result<()> {
    let f = Fixture::new(true).await?;
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "accepted", SOURCE)
        .await?;
    assert_eq!(prepared.phase, Phase::Prepared);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    let credential_name = f.lease().await?.name.clone();
    let store = f.store.clone();
    *f.probe.lock().unwrap() = Some(Arc::new(move || {
        let receipt = store
            .read_provider_revocation("accepted", Some(SOURCE))
            .unwrap();
        assert_eq!(receipt.phase, Phase::Unknown);
        let bytes = read_record(&store.directory, &credential_name)
            .unwrap()
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["version"], 3);
        assert_eq!(value["provider_revocation"]["request_id"], "accepted");
        assert_eq!(value["provider_revocation"]["accepted"], false);
    }));
    let accepted = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "accepted",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(accepted.phase, Phase::Accepted);
    assert!(!accepted.local_credentials_removed);
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    assert!(f.lease().await?.load().is_err());
    let reopened = OAuthTokenStore::open_for_account(
        &f.root.path().join("mcp-oauth"),
        Some("original-account"),
    )?;
    let same = reopened
        .commit_provider_revocation(
            &f.endpoint,
            "accepted",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(same, accepted);
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    let wire = serde_json::to_string(&same)?;
    assert!(!wire.contains(ACCESS) && !wire.contains(REFRESH) && !wire.contains("http"));
    let journal = read_record(&f.store.directory, &format!("{}.json", key("accepted")?))?.unwrap();
    assert!(
        !journal
            .windows(ACCESS.len())
            .any(|value| value == ACCESS.as_bytes())
    );
    assert!(
        !journal
            .windows(REFRESH.len())
            .any(|value| value == REFRESH.as_bytes())
    );
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn metadata_without_provider_endpoint_is_unsupported_without_touching_credentials_or_posting()
-> Result<()> {
    let f = Fixture::new(false).await?;
    let lease = f.lease().await?;
    let name = lease.name.clone();
    let before = read_record(&lease.directory, &name)?.unwrap();
    drop(lease);
    let unsupported = f
        .store
        .prepare_provider_revocation(&f.endpoint, "unsupported", SOURCE)
        .await?;
    assert_eq!(unsupported.phase, Phase::Unsupported);
    assert_eq!(unsupported.reason, Reason::EndpointNotAdvertised);
    assert!(!unsupported.local_credentials_removed);
    assert_eq!(
        read_record(&f.store.directory, &name)?.unwrap().as_slice(),
        before.as_slice()
    );
    assert!(f.lease().await?.load()?.is_some());
    let same = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "unsupported",
            unsupported.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(same, unsupported);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn lost_provider_ack_stays_unknown_after_reopen_and_never_replays_the_original_post()
-> Result<()> {
    let f = Fixture::new(true).await?;
    f.mode.store(1, Ordering::SeqCst);
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "lost-ack", SOURCE)
        .await?;
    let unknown = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "lost-ack",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(unknown.phase, Phase::Unknown);
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    assert!(f.lease().await?.load().is_err());
    let reopened = OAuthTokenStore::open_for_account(
        &f.root.path().join("mcp-oauth"),
        Some("original-account"),
    )?;
    assert_eq!(
        reopened.read_provider_revocation("lost-ack", Some(SOURCE))?,
        unknown
    );
    assert_eq!(
        reopened
            .commit_provider_revocation(
                &f.endpoint,
                "lost-ack",
                prepared.intent_ref.as_ref().unwrap(),
                SOURCE
            )
            .await?,
        unknown
    );
    assert_eq!(
        reopened
            .prepare_provider_revocation(&f.endpoint, "lost-ack", SOURCE)
            .await?,
        unknown
    );
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn stale_source_original_reference_and_refreshed_credentials_cannot_dispatch() -> Result<()> {
    let f = Fixture::new(true).await?;
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "source-change", SOURCE)
        .await?;
    let mut foreign = prepared.intent_ref.clone().unwrap();
    foreign.revision = "foreign".into();
    assert!(
        f.store
            .commit_provider_revocation(&f.endpoint, "source-change", &foreign, SOURCE)
            .await
            .is_err()
    );
    let rejected = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "source-change",
            prepared.intent_ref.as_ref().unwrap(),
            "different-original-account-or-endpoint",
        )
        .await?;
    assert_eq!(rejected.phase, Phase::Rejected);
    assert_eq!(rejected.reason, Reason::SourceChanged);
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "rotated-token", SOURCE)
        .await?;
    let mut lease = f.lease().await?;
    let current = lease.load()?.unwrap();
    lease.save(&current)?;
    drop(lease);
    let rejected = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "rotated-token",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(rejected.phase, Phase::Rejected);
    assert_eq!(rejected.reason, Reason::CredentialsChanged);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    assert!(f.lease().await?.load()?.is_some());
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn explicit_unsupported_token_response_preserves_credentials_without_fallback_or_replay()
-> Result<()> {
    let f = Fixture::new(true).await?;
    f.mode.store(2, Ordering::SeqCst);
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "unsupported-token", SOURCE)
        .await?;
    let unsupported = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "unsupported-token",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(unsupported.phase, Phase::Unsupported);
    assert_eq!(unsupported.reason, Reason::TokenTypeUnsupported);
    assert!(f.lease().await?.load()?.is_some());
    let same = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "unsupported-token",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(same, unsupported);
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn existing_mcp_client_session_and_contribution_snapshot_cannot_send_or_refresh_after_unknown_fence()
-> Result<()> {
    use crate::McpTool;
    use kcoder_tools::{Tool, ToolContext, ToolRegistry};
    let f = Fixture::new(true).await?;
    let config: crate::McpServerConfig = serde_json::from_value(
        serde_json::json!({"name":"owned-original-source","transport":"http","url":f.endpoint.as_str(),"policy":{"oauth_account":"original-account"}}),
    )?;
    let credentials = crate::server_policy::CredentialContext {
        config_dir: f.root.path().to_owned(),
        mode: kcoder_config::CredentialStoreMode::File,
    };
    let (handle, definitions) = crate::connect_server_with_private_values_in(
        &config,
        Some(f.store.clone()),
        Arc::new(crate::tool::PrivateValues::default()),
        Some(&credentials),
    )
    .await?;
    assert!(
        handle.lock().await.native_origin().is_some(),
        "The original initialized client must have actual native origin evidence"
    );
    assert_eq!(definitions.len(), 1);
    let tool = McpTool::new(
        "owned-original-source",
        handle.clone(),
        definitions[0].clone(),
    );
    let name = tool.name();
    let snapshot = ToolRegistry::new().register(tool);
    let contribution = snapshot.get(&name).unwrap();
    let context = ToolContext::new(kcoder_state::AppState::new(f.root.path()));
    assert!(
        !contribution
            .call(serde_json::json!({}), &context)
            .await?
            .is_error
    );
    // An expired original token would enter the real refresh branch if the
    // pending fence were skipped. Keep the pre-existing client and contribution.
    let lease = f.lease().await?;
    let bytes = read_record(&lease.directory, &lease.name)?.unwrap();
    let mut value: serde_json::Value = serde_json::from_slice(&bytes)?;
    value["expires_at_ms"] = serde_json::json!(1);
    lease
        .directory
        .atomic_replace(OsStr::new(&lease.name), &serde_json::to_vec(&value)?)?;
    drop(lease);
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "existing-session", SOURCE)
        .await?;
    let mcp_before = f.mcp_requests.load(Ordering::SeqCst);
    let tokens_before = f.token_requests.load(Ordering::SeqCst);
    f.hold.store(true, Ordering::SeqCst);
    f.mode.store(1, Ordering::SeqCst);
    let store = f.store.clone();
    let endpoint = f.endpoint.clone();
    let intent = prepared.intent_ref.unwrap();
    let committing = tokio::spawn(async move {
        store
            .commit_provider_revocation(&endpoint, "existing-session", &intent, SOURCE)
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), f.entered.notified()).await?;
    assert_eq!(
        f.store
            .read_provider_revocation("existing-session", Some(SOURCE))?
            .phase,
        Phase::Unknown
    );
    let calling =
        tokio::spawn(async move { contribution.call(serde_json::json!({}), &context).await });
    tokio::task::yield_now().await;
    f.release.notify_one();
    let original = committing.await??;
    assert_eq!(original.phase, Phase::Unknown);
    let old_call = calling.await?;
    assert!(old_call.is_err() || old_call.is_ok_and(|value| value.is_error));
    assert!(
        handle.lock().await.list_tools().await.is_err(),
        "A retained initialized session cannot rediscover with old authorization"
    );
    assert_eq!(f.mcp_requests.load(Ordering::SeqCst), mcp_before);
    assert_eq!(f.token_requests.load(Ordering::SeqCst), tokens_before);
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    // No new transport is needed for this proof; keep its actual session alive.
    handle.lock().await.close();
    drop(snapshot);
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn unknown_fence_is_observed_as_original_authorization_unavailable_and_cancel_does_not_restore_it()
-> Result<()> {
    use crate::authorization_index::observe::{
        ExistingOAuthObservationStore, OAuthObservationState,
    };
    let f = Fixture::new(true).await?;
    f.mode.store(1, Ordering::SeqCst);
    let profile = PrivateDirectory::open_existing(f.root.path())?;
    let reader = ExistingOAuthObservationStore::open_existing_for_account(
        &profile,
        Some("original-account"),
    )?
    .unwrap();
    let before = reader.observe_connection(&f.endpoint)?.unwrap();
    assert_eq!(before.state, OAuthObservationState::Authorized);
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "observe-pending", SOURCE)
        .await?;
    let pending = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "observe-pending",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(pending.phase, Phase::Unknown);
    let after = reader.observe_connection(&f.endpoint)?.unwrap();
    assert_eq!(after.state, OAuthObservationState::ReauthorizationRequired);
    assert_eq!(
        after.reason_code,
        "MCP_OAUTH_PROVIDER_REVOCATION_UNCONFIRMED"
    );
    assert_eq!(before.binding_id, after.binding_id);
    assert_eq!(before.authorization_revision, after.authorization_revision);
    let cancelled = f
        .store
        .cancel_provider_revocation(
            "observe-pending",
            prepared.intent_ref.as_ref().unwrap(),
            Some(SOURCE),
        )
        .await?;
    assert_eq!(cancelled.phase, Phase::Unknown);
    assert!(f.lease().await?.load().is_err());
    assert_eq!(f.posts.load(Ordering::SeqCst), 1);
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn foreign_account_and_changed_association_cannot_consume_an_original_prepared_reference()
-> Result<()> {
    let f = Fixture::new(true).await?;
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "foreign-account", SOURCE)
        .await?;
    let foreign =
        OAuthTokenStore::open_for_account(&f.root.path().join("mcp-oauth"), Some("other-account"))?;
    let rejected = foreign
        .commit_provider_revocation(
            &f.endpoint,
            "foreign-account",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(rejected.phase, Phase::Rejected);
    assert_eq!(rejected.reason, Reason::SourceChanged);
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "new-association", SOURCE)
        .await?;
    let mut association = f.store.acquire_connection(&f.endpoint).await?;
    association.invalidate_pending()?;
    drop(association);
    let rejected = f
        .store
        .commit_provider_revocation(
            &f.endpoint,
            "new-association",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
        )
        .await?;
    assert_eq!(rejected.phase, Phase::Rejected);
    assert_eq!(rejected.reason, Reason::SourceChanged);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn prepared_cancellation_is_terminal_without_posting_and_unsupported_auth_metadata_is_not_guessed()
-> Result<()> {
    let f = Fixture::new(true).await?;
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "cancel-prepared", SOURCE)
        .await?;
    let cancelled = f
        .store
        .cancel_provider_revocation(
            "cancel-prepared",
            prepared.intent_ref.as_ref().unwrap(),
            Some(SOURCE),
        )
        .await?;
    assert_eq!(cancelled.phase, Phase::Rejected);
    assert_eq!(cancelled.reason, Reason::PreparationCancelled);
    assert_eq!(
        f.store
            .commit_provider_revocation(
                &f.endpoint,
                "cancel-prepared",
                prepared.intent_ref.as_ref().unwrap(),
                SOURCE
            )
            .await?
            .phase,
        Phase::Rejected
    );
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    assert!(f.lease().await?.load()?.is_some());
    let mut metadata = f
        .store
        .acquire_connection(&f.endpoint)
        .await?
        .load()?
        .unwrap()
        .metadata;
    metadata.revocation_endpoint_auth_methods_supported = None;
    assert!(
        revocation_authentication(&metadata, &ClientAuthentication::Public).is_none(),
        "An omitted auth-method field defaults to Basic, never public none"
    );
    let post = ClientAuthentication::Post(Zeroizing::new("SYNTHETIC_PRIVATE_CLIENT_SECRET".into()));
    assert!(matches!(
        revocation_authentication(&metadata, &post),
        Some(ClientAuthentication::Basic(_))
    ));
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn live_configuration_after_awaited_token_lease_rejects_endpoint_account_scope_mode_and_enable_changes_before_fence()
-> Result<()> {
    // The callback is a real current-settings read, never a copied fingerprint.
    // Positive HTTP/authorization behavior is covered by the nine original cases.
    for changed in ["endpoint", "account", "scope", "mode", "enabled"] {
        let f = Fixture::new(true).await?;
        let configuration = f.root.path().join("live-source-settings.json");
        let original = serde_json::json!({"credential_store":"file","providers":{},"mcp_servers":[{"name":"owned-current","transport":"http","url":f.endpoint.as_str(),"policy":{"oauth_account":"original-account","enabled_tools":["scope_before"]}}]});
        std::fs::write(&configuration, serde_json::to_vec(&original)?)?;
        let load_path = configuration.clone();
        let observe = move || -> Result<serde_json::Value> {
            let source = std::fs::read(&load_path)?;
            let document: serde_json::Value = serde_json::from_slice(&source)?;
            let current = kcoder_config::validate_and_resolve_settings_document(&document)?;
            Ok(serde_json::json!([
                current.mcp_servers,
                current.credential_store,
                current.mcp_disabled_servers
            ]))
        };
        let expected = observe()?;
        let prepared = f
            .store
            .prepare_provider_revocation(&f.endpoint, changed, SOURCE)
            .await?;
        let held = f.lease().await?;
        let token_before = read_record(&held.directory, &held.name)?.unwrap();
        let store = f.store.clone();
        let endpoint = f.endpoint.clone();
        let intent = prepared.intent_ref.unwrap();
        let request_id = changed.to_owned();
        let pending = tokio::spawn(async move {
            store
                .commit_provider_revocation_revalidated(
                    &endpoint,
                    &request_id,
                    &intent,
                    SOURCE,
                    move || {
                        ensure!(observe()? == expected, "live current source changed");
                        Ok(())
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(
            !pending.is_finished(),
            "The original credential writer must hold the actual awaited lease"
        );
        let mut next = original;
        match changed {
            "endpoint" => {
                next["mcp_servers"][0]["url"] =
                    serde_json::json!("https://other-source.example.test/mcp")
            }
            "account" => {
                next["mcp_servers"][0]["policy"]["oauth_account"] =
                    serde_json::json!("different-account")
            }
            "scope" => {
                next["mcp_servers"][0]["policy"]["enabled_tools"] =
                    serde_json::json!(["different_scope"])
            }
            "mode" => next["credential_store"] = serde_json::json!("keyring"),
            "enabled" => next["mcp_disabled_servers"] = serde_json::json!(["owned-current"]),
            _ => unreachable!(),
        }
        std::fs::write(&configuration, serde_json::to_vec(&next)?)?;
        drop(held);
        let rejected = pending.await??;
        assert_eq!(rejected.phase, Phase::Rejected);
        assert_eq!(rejected.reason, Reason::SourceChanged);
        assert_eq!(f.posts.load(Ordering::SeqCst), 0);
        let current = f.lease().await?;
        assert!(current.load()?.is_some());
        assert_eq!(
            read_record(&current.directory, &current.name)?
                .unwrap()
                .as_slice(),
            token_before.as_slice()
        );
        drop(current);
        f.close().await;
    }
    Ok(())
}

#[tokio::test]
async fn live_change_after_unknown_and_fence_never_restores_credentials_or_replays_even_without_a_post()
-> Result<()> {
    let f = Fixture::new(true).await?;
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "after-fence", SOURCE)
        .await?;
    let checks = Arc::new(AtomicUsize::new(0));
    let observed = checks.clone();
    let unknown = f
        .store
        .commit_provider_revocation_revalidated(
            &f.endpoint,
            "after-fence",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
            move || {
                ensure!(
                    observed.fetch_add(1, Ordering::SeqCst) == 0,
                    "current source changed after fence"
                );
                Ok(())
            },
        )
        .await?;
    assert_eq!(unknown.phase, Phase::Unknown);
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    assert!(f.lease().await?.load().is_err());
    let same = f
        .store
        .commit_provider_revocation_revalidated(
            &f.endpoint,
            "after-fence",
            prepared.intent_ref.as_ref().unwrap(),
            SOURCE,
            || panic!("An unknown original intent must never redispatch"),
        )
        .await?;
    assert_eq!(same, unknown);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    assert!(f.lease().await?.load().is_err());
    f.close().await;
    Ok(())
}

#[tokio::test]
async fn oauth_scope_changed_by_original_writer_during_token_lease_wait_cannot_send_the_old_intent()
-> Result<()> {
    let f = Fixture::new(true).await?;
    let prepared = f
        .store
        .prepare_provider_revocation(&f.endpoint, "awaited-oauth-scope", SOURCE)
        .await?;
    let mut held = f.lease().await?;
    let store = f.store.clone();
    let endpoint = f.endpoint.clone();
    let intent = prepared.intent_ref.unwrap();
    let pending = tokio::spawn(async move {
        store
            .commit_provider_revocation_revalidated(
                &endpoint,
                "awaited-oauth-scope",
                &intent,
                SOURCE,
                || Ok(()),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!pending.is_finished());
    let bytes = read_record(&held.directory, &held.name)?.unwrap();
    let mut body: serde_json::Value = serde_json::from_slice(&bytes)?;
    body["scope"] = serde_json::json!("different_native_scope");
    let next = OAuthTokens::from_store_bytes(
        &serde_json::to_vec(&body)?,
        &held.binding.resource,
        &held.binding.issuer,
        &held.binding.client_id,
        &held.binding.token_endpoint,
    )?;
    held.save(&next)?;
    drop(held);
    let result = pending.await??;
    assert_eq!(result.phase, Phase::Rejected);
    assert_eq!(result.reason, Reason::CredentialsChanged);
    assert_eq!(f.posts.load(Ordering::SeqCst), 0);
    assert_eq!(
        f.lease().await?.load()?.unwrap().scope(),
        Some("different_native_scope")
    );
    f.close().await;
    Ok(())
}
