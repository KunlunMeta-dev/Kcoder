//! Host-owned, pinned HTTP destinations shared by search and page readers.
//! Model JSON cannot create grants, choose proxies, or replace target policy.
mod proxy;
#[cfg(all(test, any(windows, target_os = "macos")))]
mod system_proxy;
#[cfg(feature = "web-network-test-fixture")]
pub mod test_fixture;
#[cfg(all(test, windows))]
mod windows_auto_proxy;

use crate::{ToolContext, ToolError};
use kcoder_config::WebFetchSettings;
#[cfg(test)]
use kcoder_config::WebProxyMode;
#[cfg(windows)]
use kcoder_web::policy::AutomaticProxy;
use kcoder_web::policy::{
    ProxySelection, ca, capture_environment, fingerprint_environment, hash_ca_files,
};
pub use kcoder_web::policy::{
    effective_environment, environment_fingerprint, requires_system_proxy_resolution,
};
use reqwest::{Method, Url, header::HeaderMap};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Revocable authority issued by the host for one session on this target.
/// The caller must obtain user permission before granting a private origin.
#[derive(Clone)]
pub struct WebNetworkAuthority(Arc<Mutex<AuthorityState>>);

struct AuthorityState {
    owner: kcoder_state::AppStateLifecycleIdentity,
    session_id: String,
    generation: u64,
    origins: HashMap<String, Instant>,
}

impl WebNetworkAuthority {
    pub fn new(state: &kcoder_state::AppState) -> Self {
        Self(Arc::new(Mutex::new(AuthorityState {
            owner: state.inspection_lifecycle_identity(),
            session_id: state.session_id(),
            generation: 0,
            origins: HashMap::new(),
        })))
    }

    /// Grant exactly one HTTP(S) origin, including its effective port.
    pub fn grant_origin(&self, origin: &str, ttl: Duration) -> Result<(), ToolError> {
        let url = validate_url(origin)?;
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || ttl.is_zero() {
            return Err(ToolError::InvalidInput(
                "A local web grant requires an exact origin and positive lifetime".into(),
            ));
        }
        let mut state = self.0.lock().map_err(|_| denied())?;
        state.generation = state.generation.wrapping_add(1);
        state.origins.insert(
            url.origin().ascii_serialization(),
            Instant::now() + ttl.min(Duration::from_secs(3600)),
        );
        Ok(())
    }

    pub fn revoke_origin(&self, origin: &str) -> Result<(), ToolError> {
        let url = validate_url(origin)?;
        let mut state = self.0.lock().map_err(|_| denied())?;
        state.generation = state.generation.wrapping_add(1);
        state.origins.remove(&url.origin().ascii_serialization());
        Ok(())
    }

    pub fn revoke(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.origins.clear();
        }
    }
}

/// Keeps page cache and private binary files alive for one actual session owner.
#[derive(Clone)]
pub struct WebSessionResources(Arc<Mutex<Arc<crate::web_resources::WebResources>>>);
impl WebSessionResources {
    pub fn new(state: &kcoder_state::AppState) -> Self {
        Self(Arc::new(Mutex::new(Arc::new(
            crate::web_resources::WebResources::new(state),
        ))))
    }
}

impl ToolContext {
    /// Host-only revocation check immediately before an actual HTTP dispatch.
    pub fn with_web_dispatch_check(
        mut self,
        check: Arc<dyn Fn() -> Result<(), ToolError> + Send + Sync>,
    ) -> Self {
        self.web_dispatch_check = Some(check);
        self
    }
    pub fn with_web_session_resources(mut self, resources: WebSessionResources) -> Self {
        if let Ok(mut current) = resources.0.lock() {
            if current.check_owner(&self.state).is_err() {
                *current = Arc::new(crate::web_resources::WebResources::new(&self.state));
            }
            self.web_resources = current.clone();
        }
        self
    }
    pub fn with_web_network_authority(mut self, authority: WebNetworkAuthority) -> Self {
        self.web_network_authority = Some(authority);
        self
    }
}

#[derive(Clone)]
pub(crate) struct PolicySnapshot {
    owner: kcoder_state::AppStateLifecycleIdentity,
    settings: WebFetchSettings,
    environment: Vec<(String, Option<String>)>,
    #[cfg(windows)]
    automatic_proxy: Option<AutomaticProxy>,
    authority_generation: Option<u64>,
    session_id: String,
    pub(crate) fingerprint: u64,
}

fn settings(ctx: &ToolContext) -> Result<WebFetchSettings, ToolError> {
    Ok(ctx.effective_web_settings()?.fetch)
}

impl PolicySnapshot {
    pub(crate) fn capture(ctx: &ToolContext) -> Result<Self, ToolError> {
        let settings = settings(ctx)?;
        let target = capture_environment(&settings)?;
        let authority_generation = ctx
            .web_network_authority
            .as_ref()
            .map(|a| {
                a.0.lock()
                    .map(|mut s| {
                        let before = s.origins.len();
                        s.origins.retain(|_, expiry| *expiry > Instant::now());
                        if s.origins.len() != before {
                            s.generation = s.generation.wrapping_add(1);
                        }
                        s.generation
                    })
                    .map_err(|_| denied())
            })
            .transpose()?;
        let session_id = ctx.state.session_id();
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        settings.hash(&mut hasher);
        target.values.hash(&mut hasher);
        target.hash_automatic_proxy(&mut hasher);
        hash_ca_files(&target.values, &mut hasher);
        authority_generation.hash(&mut hasher);
        session_id.hash(&mut hasher);
        Ok(Self {
            owner: ctx.state.inspection_lifecycle_identity(),
            settings,
            environment: target.values,
            #[cfg(windows)]
            automatic_proxy: target.automatic_proxy,
            authority_generation,
            session_id,
            fingerprint: hasher.finish(),
        })
    }

    pub(crate) fn check(&self, ctx: &ToolContext, url: &Url) -> Result<(), ToolError> {
        if !self.owner.matches(&ctx.state)
            || ctx.is_aborted()
            || Self::capture(ctx)?.fingerprint != self.fingerprint
        {
            return Err(denied());
        }
        if let Some(authority) = &ctx.web_network_authority {
            let state = authority.0.lock().map_err(|_| denied())?;
            if !state.owner.matches(&ctx.state)
                || state.session_id != self.session_id
                || Some(state.generation) != self.authority_generation
            {
                return Err(denied());
            }
        }
        // Expired private grants are checked even when a cache is used.
        if url.host().is_some_and(|h| match h {
            url::Host::Ipv4(ip) => !is_public_ip(ip.into()),
            url::Host::Ipv6(ip) => !is_public_ip(ip.into()),
            url::Host::Domain(h) => is_private_name(h),
        }) && !self.grants_private(ctx, url)?
        {
            return Err(denied());
        }
        Ok(())
    }

    fn grants_private(&self, ctx: &ToolContext, url: &Url) -> Result<bool, ToolError> {
        let Some(authority) = &ctx.web_network_authority else {
            return Ok(false);
        };
        let state = authority.0.lock().map_err(|_| denied())?;
        Ok(state.owner.matches(&ctx.state)
            && state.session_id == ctx.state.session_id()
            && Some(state.generation) == self.authority_generation
            && state
                .origins
                .get(&url.origin().ascii_serialization())
                .is_some_and(|expiry| *expiry > Instant::now()))
    }

    fn env(&self, name: &str) -> Option<&str> {
        self.environment
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.as_deref())
    }

    async fn proxy(&self, url: &Url, ctx: &ToolContext) -> Result<Option<Url>, ToolError> {
        let cancel = ctx.abort_token.clone().unwrap_or_default();
        ProxySelection {
            settings: &self.settings,
            environment: &self.environment,
            #[cfg(windows)]
            automatic_proxy: self.automatic_proxy.as_ref(),
        }
        .resolve(url, &cancel, &|| self.check(ctx, url))
        .await
    }
}

/// Resolve a host-owned proxy choice for one complete URL without creating a
/// session. The caller retains origin DNS/grant checks and its active query
/// authority; proxy/PAC configuration and the returned URL must stay private.
pub async fn resolve_proxy_for_url(
    settings: &WebFetchSettings,
    url: &Url,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Option<Url>, ToolError> {
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    let url = validate_url(url.as_str())?;
    let target = capture_environment(settings)?;
    let generation = fingerprint_environment(settings, &target);
    let check = || {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        if environment_fingerprint(settings)? != generation {
            return Err(denied());
        }
        Ok(())
    };
    let choice = ProxySelection {
        settings,
        environment: &target.values,
        #[cfg(windows)]
        automatic_proxy: target.automatic_proxy.as_ref(),
    }
    .resolve(&url, cancel, &check)
    .await?;
    check()?;
    Ok(choice)
}

/// Response owns its proxy tunnel until the body has been consumed or dropped.
pub struct WebResponse {
    pub response: reqwest::Response,
    _tunnel: Option<proxy::OwnedProxyTunnel>,
}
// Keep the response and its connection owner inseparable. Callers borrow the
// public response while streaming; moving it out would drop a live proxy early.
impl Drop for WebResponse {
    fn drop(&mut self) {}
}

/// Send one request with no automatic redirects. Every follow-up must call this
/// function again so it receives its own DNS, policy and connection checks.
pub async fn send(
    ctx: &ToolContext,
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
) -> Result<WebResponse, ToolError> {
    let policy = PolicySnapshot::capture(ctx)?;
    send_with_policy(ctx, &policy, method, url, headers, body).await
}

pub(crate) async fn send_with_policy(
    ctx: &ToolContext,
    policy: &PolicySnapshot,
    method: Method,
    url: Url,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
) -> Result<WebResponse, ToolError> {
    let url = validate_url(url.as_str())?;
    policy.check(ctx, &url)?;
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    let mut addresses = validate_destination(ctx, policy, &url).await?;
    let proxy = policy.proxy(&url, ctx).await?;
    if proxy.is_some() && addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(ToolError::Execution("Private-origin reads require a direct target connection under the current proxy bypass policy".into()));
    }
    if proxy.is_some() {
        addresses.sort_by_key(|address| address.is_ipv6());
    }
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .no_gzip()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(0)
        .resolve_to_addrs(host, &addresses);
    let mut tunnel = None;
    if let Some(proxy) = proxy {
        if matches!(proxy.scheme(), "socks4" | "socks5") {
            builder =
                builder.proxy(reqwest::Proxy::all(proxy.as_str()).map_err(|_| {
                    ToolError::Execution("The target SOCKS proxy is invalid".into())
                })?);
        } else {
            let owned = proxy::OwnedProxyTunnel::start(
                proxy,
                addresses.clone(),
                ctx.clone(),
                policy.clone(),
                url.clone(),
            )
            .await?;
            builder = builder.proxy(reqwest::Proxy::all(owned.url()).map_err(|_| {
                ToolError::Execution("The owned web proxy could not be prepared".into())
            })?);
            tunnel = Some(owned);
        }
    }
    if url.scheme() == "https" {
        builder = ca::add(
            builder,
            policy
                .env("SSL_CERT_FILE")
                .or_else(|| policy.env("CURL_CA_BUNDLE")),
            policy.env("SSL_CERT_DIR"),
        )
        .await?;
    }
    let client = builder.build().map_err(|_| {
        ToolError::Execution("The target web HTTP client could not be prepared".into())
    })?;
    policy.check(ctx, &url)?;
    let mut request = client.request(method, url.clone()).headers(headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    policy.check(ctx, &url)?;
    if let Some(check) = &ctx.web_dispatch_check {
        check()?;
    }
    let response = tokio::select! { biased; _ = ctx.cancelled() => return Err(cancelled()), result = request.send() => result.map_err(|e| ToolError::Execution(if e.is_timeout() { "The web request timed out" } else if e.is_connect() { "The web connection failed; check the target network, proxy and certificate policy" } else { "The web request failed" }.into()))? };
    Ok(WebResponse {
        response,
        _tunnel: tunnel,
    })
}

pub(crate) async fn validate_destination(
    ctx: &ToolContext,
    policy: &PolicySnapshot,
    url: &Url,
) -> Result<Vec<SocketAddr>, ToolError> {
    policy.check(ctx, url)?;
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    let port = url.port_or_known_default().unwrap();
    let lookup = async {
        #[cfg(feature = "web-network-test-fixture")]
        let addresses = match &ctx.web_network_test_dns {
            Some(fixture) => fixture.resolve(host, port)?,
            None => tokio::net::lookup_host((host, port))
                .await
                .map_err(|_| {
                    ToolError::Execution("The web destination could not be resolved".into())
                })?
                .collect::<Vec<_>>(),
        };
        #[cfg(not(feature = "web-network-test-fixture"))]
        let addresses = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| ToolError::Execution("The web destination could not be resolved".into()))?
            .collect::<Vec<_>>();
        validate_addresses(&addresses, policy.grants_private(ctx, url)?)?;
        policy.check(ctx, url)?;
        Ok::<_, ToolError>(addresses)
    };
    tokio::select! { biased; _ = ctx.cancelled() => Err(cancelled()), result = tokio::time::timeout(Duration::from_secs(10), lookup) => result.map_err(|_| ToolError::Execution("Web destination resolution timed out".into()))? }
}

pub use kcoder_web::policy::validate_url;

fn is_private_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && matches!(c, 0 | 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_public_ip(v4.into());
            }
            // Accept global unicast only; block translation, documentation and
            // transition prefixes whose embedded destination is not pinned.
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0)
        }
    }
}

fn validate_addresses(addresses: &[SocketAddr], allow_private: bool) -> Result<(), ToolError> {
    if addresses.is_empty()
        || addresses.len() > 64
        || (!allow_private && addresses.iter().any(|a| !is_public_ip(a.ip())))
    {
        return Err(denied());
    }
    Ok(())
}
fn denied() -> ToolError {
    ToolError::Execution(
        "Web destination is restricted by the current target or local-origin authorization".into(),
    )
}
pub(crate) fn cancelled() -> ToolError {
    ToolError::Execution("Web request cancelled".into())
}

/// Resolve only enough to decide whether a native page reader needs explicit
/// local-origin approval. This never opens an HTTP connection or grants access.
pub async fn private_destination_origin(raw: &str) -> Result<Option<String>, ToolError> {
    let url = validate_url(raw)?;
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    if is_private_name(host) || host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip)) {
        return Ok(Some(url.origin().ascii_serialization()));
    }
    let addresses = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::net::lookup_host((host, url.port_or_known_default().unwrap())),
    )
    .await
    .map_err(|_| ToolError::Execution("Web destination resolution timed out".into()))?
    .map_err(|_| ToolError::Execution("The web destination could not be resolved".into()))?
    .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.len() > 64 {
        return Err(denied());
    }
    Ok(addresses
        .iter()
        .any(|address| !is_public_ip(address.ip()))
        .then(|| url.origin().ascii_serialization()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_proxy_api_never_creates_a_session_or_resolves_direct_mode() {
        let settings = WebFetchSettings {
            proxy_mode: WebProxyMode::Direct,
            ..WebFetchSettings::default()
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        assert!(!requires_system_proxy_resolution(&settings).unwrap());
        assert!(
            resolve_proxy_for_url(
                &settings,
                &Url::parse("https://example.com/document").unwrap(),
                &cancel
            )
            .await
            .unwrap()
            .is_none()
        );
        assert!(
            resolve_proxy_for_url(
                &settings,
                &Url::parse("file:///owned.invalid").unwrap(),
                &cancel
            )
            .await
            .is_err()
        );
        cancel.cancel();
        assert!(
            resolve_proxy_for_url(
                &settings,
                &Url::parse("https://example.com/").unwrap(),
                &cancel
            )
            .await
            .is_err()
        );
        let configured = WebFetchSettings {
            proxy_mode: WebProxyMode::Configured,
            ..settings
        };
        assert!(!requires_system_proxy_resolution(&configured).unwrap());
    }

    #[tokio::test]
    async fn shared_proxy_selection_keeps_explicit_empty_bypass_and_configured_precedence() {
        let mut settings = WebFetchSettings::default();
        let cancel = tokio_util::sync::CancellationToken::new();
        let url = Url::parse("https://docs.example.com/path").unwrap();
        let mut environment = vec![
            ("HTTPS_PROXY".into(), Some("http://127.0.0.1:8181".into())),
            ("NO_PROXY".into(), Some(".example.com".into())),
        ];
        fn choose<'a>(
            settings: &'a WebFetchSettings,
            environment: &'a [(String, Option<String>)],
        ) -> ProxySelection<'a> {
            ProxySelection {
                settings,
                environment,
                #[cfg(windows)]
                automatic_proxy: None,
            }
        }
        assert!(
            choose(&settings, &environment)
                .resolve(&url, &cancel, &|| Ok(()))
                .await
                .unwrap()
                .is_none()
        );
        environment[1].1 = Some(String::new());
        assert_eq!(
            choose(&settings, &environment)
                .resolve(&url, &cancel, &|| Ok(()))
                .await
                .unwrap()
                .unwrap()
                .port(),
            Some(8181)
        );
        environment[0].1 = Some(String::new());
        assert!(
            choose(&settings, &environment)
                .resolve(&url, &cancel, &|| Ok(()))
                .await
                .unwrap()
                .is_none()
        );
        settings.proxy_mode = WebProxyMode::Configured;
        settings.proxy_env = Some("HTTPS_PROXY".into());
        assert!(
            choose(&settings, &environment)
                .resolve(&url, &cancel, &|| Ok(()))
                .await
                .is_err()
        );
        environment[0].1 = Some("http://127.0.0.1:8181".into());
        environment[1].1 = Some("*".into());
        assert!(
            choose(&settings, &environment)
                .resolve(&url, &cancel, &|| Ok(()))
                .await
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn rejects_reserved_addresses_and_mixed_resolution() {
        for value in [
            "0.0.0.0",
            "10.0.0.1",
            "127.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.8",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2002:7f00:1::",
        ] {
            assert!(!is_public_ip(value.parse().unwrap()), "{value}");
        }
        for value in ["8.8.8.8", "1.1.1.1", "192.0.78.13", "2606:4700:4700::1111"] {
            assert!(is_public_ip(value.parse().unwrap()));
        }
        assert!(
            validate_addresses(
                &[
                    "1.1.1.1:80".parse().unwrap(),
                    "127.0.0.1:80".parse().unwrap()
                ],
                false
            )
            .is_err()
        );
    }
    fn direct_context(state: kcoder_state::AppState) -> ToolContext {
        let mut settings = kcoder_config::Settings::default();
        settings.web.fetch.proxy_mode = WebProxyMode::Direct;
        ToolContext::new(state).with_runtime_settings(Arc::new(std::sync::RwLock::new(settings)))
    }
    #[test]
    fn current_host_web_policy_revokes_an_inflight_fetch_snapshot() {
        let current = Arc::new(std::sync::RwLock::new(kcoder_config::WebSettings::default()));
        current.write().unwrap().fetch.proxy_mode = WebProxyMode::Direct;
        let source = current.clone();
        let context = ToolContext::new(kcoder_state::AppState::new("."))
            .with_web_settings_reader(Some(Arc::new(move || Ok(source.read().unwrap().clone()))));
        let snapshot = PolicySnapshot::capture(&context).unwrap();
        let url = validate_url("https://example.com/").unwrap();
        assert!(snapshot.check(&context, &url).is_ok());
        current.write().unwrap().fetch.proxy_mode = WebProxyMode::Inherit;
        assert!(snapshot.check(&context, &url).is_err());
        assert_eq!(
            settings(&context).unwrap().proxy_mode,
            WebProxyMode::Inherit
        );
        let unavailable = context.with_web_settings_reader(Some(Arc::new(|| Err(denied()))));
        assert!(PolicySnapshot::capture(&unavailable).is_err());
    }

    #[test]
    fn an_inflight_public_policy_cannot_survive_restoring_the_same_session_id() {
        let root = tempfile::tempdir().unwrap();
        let context = direct_context(kcoder_state::AppState::new(root.path()));
        let snapshot = PolicySnapshot::capture(&context).unwrap();
        let url = validate_url("https://example.com/").unwrap();
        assert!(snapshot.check(&context, &url).is_ok());
        let session_id = context.state.session_id();
        let path = root.path().join("owned-snapshot.json");
        context.state.export_snapshot(&path).unwrap();
        context.state.import_snapshot(&path).unwrap();
        assert_eq!(context.state.session_id(), session_id);
        assert!(snapshot.check(&context, &url).is_err());
    }

    #[test]
    fn replacing_ca_bytes_at_the_same_path_changes_the_network_identity() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owned-ca.pem");
        std::fs::write(&path, b"initial certificate").unwrap();
        let environment = vec![(
            "SSL_CERT_FILE".into(),
            Some(path.to_string_lossy().into_owned()),
        )];
        let mut before = std::collections::hash_map::DefaultHasher::new();
        hash_ca_files(&environment, &mut before);
        let replacement = directory.path().join("replacement.pem");
        std::fs::write(&replacement, b"different certificate bytes").unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let mut after = std::collections::hash_map::DefaultHasher::new();
        hash_ca_files(&environment, &mut after);
        assert_ne!(before.finish(), after.finish());
    }

    #[test]
    fn private_grants_are_exact_revocable_and_bound_to_the_session() {
        let ctx = direct_context(kcoder_state::AppState::new("."));
        let grant = WebNetworkAuthority::new(&ctx.state);
        grant
            .grant_origin("http://127.0.0.1:1234", Duration::from_secs(30))
            .unwrap();
        let ctx = ctx.with_web_network_authority(grant.clone());
        let snapshot = PolicySnapshot::capture(&ctx).unwrap();
        let url = validate_url("http://127.0.0.1:1234/path").unwrap();
        assert!(snapshot.check(&ctx, &url).is_ok());
        assert!(
            snapshot
                .check(&ctx, &validate_url("http://127.0.0.1:1235").unwrap())
                .is_err()
        );
        let peer = direct_context(kcoder_state::AppState::new("."))
            .with_web_network_authority(grant.clone());
        assert!(
            PolicySnapshot::capture(&peer)
                .unwrap()
                .check(&peer, &url)
                .is_err()
        );
        grant.revoke();
        assert!(snapshot.check(&ctx, &url).is_err());
        assert!(
            PolicySnapshot::capture(&ctx)
                .unwrap()
                .check(&ctx, &url)
                .is_err()
        );
    }
}
