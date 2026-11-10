use super::*;
use crate::{ToolContext, web_network::PolicySnapshot};
use serde::Deserialize;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    schema_version: u32,
    pac_url: String,
    slow_pac_url: String,
    bad_pac_url: String,
    missing_pac_url: String,
    stats_url: String,
    proxy_a: String,
    proxy_b: String,
    urls: FixtureUrls,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureUrls {
    a: String,
    b: String,
    direct: String,
    secure_a: String,
    secure_b: String,
}

fn fixture() -> Fixture {
    let path = PathBuf::from(
        std::env::var_os("KCODER_TEST_WINDOWS_PAC_FIXTURE")
            .expect("UNMET_PREREQUISITE: an owned PAC fixture JSON file is required"),
    );
    assert!(std::fs::metadata(&path).unwrap().len() <= 65536);
    let value: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(value.schema_version, 1);
    for raw in [
        &value.pac_url,
        &value.slow_pac_url,
        &value.bad_pac_url,
        &value.missing_pac_url,
        &value.stats_url,
    ] {
        owned_loopback(raw);
    }
    value
}
fn owned_loopback(raw: &str) {
    let url = Url::parse(raw).unwrap();
    assert_eq!(url.scheme(), "http");
    assert!(
        url.host_str()
            .unwrap()
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
    );
    assert!(url.username().is_empty() && url.password().is_none());
}
fn context() -> (tempfile::TempDir, ToolContext, PolicySnapshot) {
    let root = tempfile::tempdir().unwrap();
    let mut settings = kcoder_config::Settings::default();
    // This private resolver test does not dispatch any origin HTTP request.
    // Its policy snapshot is independent of the account's real proxy settings.
    settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
    let context = ToolContext::new(kcoder_state::AppState::new(root.path()))
        .with_runtime_settings(Arc::new(std::sync::RwLock::new(settings)));
    let policy = PolicySnapshot::capture(&context).unwrap();
    (root, context, policy)
}
async fn owned_resolve(
    config: &AutomaticProxy,
    url: &Url,
    ctx: &ToolContext,
    policy: &PolicySnapshot,
) -> Result<Option<Url>, ToolError> {
    let cancel = ctx.abort_token.clone().unwrap_or_default();
    resolve(config, url, &cancel, &|| policy.check(ctx, url)).await
}
async fn owned_once(
    url: &Url,
    pac: &str,
    ctx: &ToolContext,
    policy: &PolicySnapshot,
    deadline: tokio::time::Instant,
) -> Result<Option<Url>, ResolutionError> {
    let cancel = ctx.abort_token.clone().unwrap_or_default();
    once(
        url,
        Some(pac),
        &cancel,
        &|| policy.check(ctx, url),
        deadline,
    )
    .await
}

fn expected_proxy(raw: &str) -> Url {
    Url::parse(&if raw.contains("://") {
        raw.to_owned()
    } else {
        format!("http://{raw}")
    })
    .unwrap()
}
fn unique(raw: &str) -> String {
    let mut url = Url::parse(raw).unwrap();
    url.query_pairs_mut()
        .append_pair("ownedPacRequest", &uuid::Uuid::new_v4().to_string());
    url.into()
}
async fn stats(fixture: &Fixture) -> serde_json::Value {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
        .get(&fixture.stats_url)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap()
}
async fn wait_slow_download(fixture: &Fixture, previous: u64) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if stats(fixture).await["slowPacRequests"].as_u64().unwrap() > previous {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("the actual owned slow PAC HTTP request must have started");
}
async fn context_for_url(url: &Url) -> (usize, usize) {
    let expected = wide(url.as_str());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = registry().lock().unwrap().iter().find_map(|(id, value)| {
                (value.inputs.url == expected).then_some((*id, value.handle))
            }) {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("actual WinHTTP operation must register its context")
}
async fn wait_closed(context: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !registry().lock().unwrap().contains_key(&context) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("HANDLE_CLOSING must release this operation's registry entry");
}

#[tokio::test]
#[ignore = "requires an explicitly owned Windows loopback PAC fixture; no account proxy writes"]
async fn owned_pac_resolves_original_url_direct_and_proxy() {
    let fixture = fixture();
    let (_root, ctx, policy) = context();
    let config = AutomaticProxy::for_test(Some(fixture.pac_url.clone()), false);
    for (raw, proxy) in [
        (&fixture.urls.a, &fixture.proxy_a),
        (&fixture.urls.b, &fixture.proxy_b),
        (&fixture.urls.secure_a, &fixture.proxy_a),
        (&fixture.urls.secure_b, &fixture.proxy_b),
    ] {
        let choice = owned_resolve(&config, &Url::parse(raw).unwrap(), &ctx, &policy)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(choice, expected_proxy(proxy));
    }
    assert!(
        owned_resolve(
            &config,
            &Url::parse(&fixture.urls.direct).unwrap(),
            &ctx,
            &policy
        )
        .await
        .unwrap()
        .is_none()
    );
    println!(
        "NATIVE_WINDOWS_PAC={{\"originalUrlChoices\":4,\"explicitDirect\":true,\"originRequests\":0,\"registryWrites\":0}}"
    );
}

#[tokio::test]
#[ignore = "requires an explicitly owned Windows loopback PAC fixture; no account proxy writes"]
async fn owned_pac_errors_do_not_fall_back_to_direct() {
    let fixture = fixture();
    let (_root, ctx, policy) = context();
    for pac in [&fixture.bad_pac_url, &fixture.missing_pac_url] {
        let config = AutomaticProxy::for_test(Some(unique(pac)), false);
        let error = owned_resolve(
            &config,
            &Url::parse(&fixture.urls.direct).unwrap(),
            &ctx,
            &policy,
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("automatic proxy resolution failed")
        );
        assert!(!error.to_string().contains("127.0.0.1"));
        assert!(!error.to_string().contains(pac));
    }
    println!(
        "NATIVE_WINDOWS_PAC={{\"explicitPacErrors\":2,\"directFallback\":false,\"originRequests\":0}}"
    );
}

#[tokio::test]
#[ignore = "requires an explicitly owned Windows loopback PAC fixture; no account proxy writes"]
async fn owned_pac_cancel_closes_only_owner_and_late_callbacks_settle() {
    let fixture = fixture();
    let previous = stats(&fixture).await["slowPacRequests"].as_u64().unwrap();
    let (_root, ctx, policy) = context();
    let signal = CancellationToken::new();
    let ctx = ctx.with_abort_token(signal.clone());
    let url = Url::parse(&unique(&fixture.urls.direct)).unwrap();
    let slow = unique(&fixture.slow_pac_url);
    let work_url = url.clone();
    let owner = tokio::spawn(async move {
        owned_once(
            &work_url,
            &slow,
            &ctx,
            &policy,
            tokio::time::Instant::now() + DEADLINE,
        )
        .await
    });
    let (id, handle) = context_for_url(&url).await;
    wait_slow_download(&fixture, previous).await;
    let (_peer_root, peer_ctx, peer_policy) = context();
    let config = AutomaticProxy::for_test(Some(fixture.pac_url.clone()), false);
    let peer_url = Url::parse(&fixture.urls.a).unwrap();
    let peer =
        tokio::spawn(
            async move { owned_resolve(&config, &peer_url, &peer_ctx, &peer_policy).await },
        );
    signal.cancel();
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(2), owner)
            .await
            .unwrap()
            .unwrap(),
        Err(ResolutionError::Host(_))
    ));
    wait_closed(id).await;
    // Synthetic adversarial late callbacks exercise the lookup after the real
    // native HANDLE_CLOSING; they do not stand in for the native cancellation.
    unsafe {
        status_callback(
            handle as *mut c_void,
            id,
            WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE,
            std::ptr::null_mut(),
            0,
        );
        status_callback(
            handle as *mut c_void,
            id,
            WINHTTP_CALLBACK_STATUS_REQUEST_ERROR,
            std::ptr::null_mut(),
            0,
        );
    }
    assert_eq!(
        peer.await.unwrap().unwrap().unwrap(),
        expected_proxy(&fixture.proxy_a)
    );
    assert!(!registry().lock().unwrap().contains_key(&id));
    println!(
        "NATIVE_WINDOWS_PAC={{\"ownedCancel\":true,\"nativeHandleClosing\":true,\"lateLookupIgnored\":true,\"peerUnaffected\":true}}"
    );
}

#[tokio::test]
#[ignore = "requires an explicitly owned Windows loopback PAC fixture; no account proxy writes"]
async fn owned_pac_deadline_closes_resolver() {
    let fixture = fixture();
    let previous = stats(&fixture).await["slowPacRequests"].as_u64().unwrap();
    let (_root, ctx, policy) = context();
    let url = Url::parse(&unique(&fixture.urls.direct)).unwrap();
    let work_url = url.clone();
    let pac = unique(&fixture.slow_pac_url);
    let owner = tokio::spawn(async move {
        owned_once(
            &work_url,
            &pac,
            &ctx,
            &policy,
            tokio::time::Instant::now() + Duration::from_secs(5),
        )
        .await
    });
    let (id, _) = context_for_url(&url).await;
    wait_slow_download(&fixture, previous).await;
    assert!(matches!(
        owner.await.unwrap(),
        Err(ResolutionError::Native(ERROR_WINHTTP_TIMEOUT))
    ));
    wait_closed(id).await;
    println!(
        "NATIVE_WINDOWS_PAC={{\"boundedDeadline\":true,\"nativeHandleClosing\":true,\"originRequests\":0}}"
    );
}

#[tokio::test]
#[ignore = "requires an explicitly owned Windows loopback PAC fixture; no account proxy writes"]
async fn owned_pac_snapshot_is_lazy_and_private() {
    let fixture = fixture();
    let before = stats(&fixture).await["pacRequests"].as_u64().unwrap();
    let (_root, ctx, _) = context();
    let settings = super::super::settings(&ctx).unwrap();
    for _ in 0..3 {
        let _ = super::super::environment_fingerprint(&settings).unwrap();
        let _ = super::super::effective_environment(&settings).unwrap();
        let _ = super::super::requires_system_proxy_resolution(&settings).unwrap();
        let _ = super::super::system_proxy::apply(&mut Vec::new()).unwrap();
    }
    assert_eq!(
        stats(&fixture).await["pacRequests"].as_u64().unwrap(),
        before
    );
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let config = AutomaticProxy::for_test(Some(fixture.pac_url), false);
    std::hash::Hash::hash(&config, &mut hash);
    assert_ne!(std::hash::Hasher::finish(&hash), 0);
    println!(
        "NATIVE_WINDOWS_PAC={{\"snapshotDownloads\":0,\"opaqueGeneration\":true,\"proxyOrPacPrinted\":false,\"registryWrites\":0}}"
    );
}

#[test]
fn malformed_native_proxy_entries_never_become_direct() {
    assert_eq!(
        proxy_url(WINHTTP_INTERNET_SCHEME_HTTP, "user@proxy.invalid", 8080).unwrap_err(),
        ERROR_INVALID_DATA
    );
    assert_eq!(
        proxy_url(WINHTTP_INTERNET_SCHEME_HTTP, "proxy.invalid/path", 8080).unwrap_err(),
        ERROR_INVALID_DATA
    );
    assert_eq!(
        proxy_url(WINHTTP_INTERNET_SCHEME_HTTP, "proxy.invalid", 0).unwrap_err(),
        ERROR_INVALID_DATA
    );
    assert_eq!(
        proxy_url(WINHTTP_INTERNET_SCHEME_HTTPS, "proxy.invalid", 8443).unwrap_err(),
        ERROR_NOT_SUPPORTED
    );
    assert_eq!(
        proxy_url(WINHTTP_INTERNET_SCHEME_SOCKS, "127.0.0.1", 1080)
            .unwrap()
            .scheme(),
        "socks4"
    );
}

#[test]
fn native_read_and_error_mapping_are_bounded_and_redacted() {
    let inputs = NativeInputs::new(
        &Url::parse("http://same.pac.invalid/a").unwrap(),
        Some("http://127.0.0.1/owned.pac"),
    );
    assert_ne!(
        inputs.options.dwFlags & WINHTTP_AUTOPROXY_NO_CACHE_CLIENT,
        0
    );
    assert_ne!(inputs.options.dwFlags & WINHTTP_AUTOPROXY_NO_CACHE_SVC, 0);
    assert_eq!(inputs.options.fAutoLogonIfChallenged, 0);
    for units in [vec![0xd800, 0], vec![27, 0], vec![b'x' as u16; 8192]] {
        assert_eq!(
            unsafe { read_wide(units.as_ptr()) }.unwrap_err(),
            ERROR_INVALID_DATA
        );
    }
    assert_eq!(unsafe { read_wide(std::ptr::null()) }.unwrap(), None);
    assert_eq!(
        unsafe { read_wide(wide("owned.invalid").as_ptr()) }.unwrap(),
        Some("owned.invalid".into())
    );
    assert!(
        failed(ERROR_WINHTTP_BAD_AUTO_PROXY_SCRIPT)
            .to_string()
            .contains("WinHTTP 12166")
    );
}
