//! Private per-query proxy decisions for the sealed search worker.
use anyhow::{Result, bail, ensure};
use kcoder_config::WebFetchSettings;
use kcoder_tools::web_search::SearchDispatchGuard;
use kcoder_types::web_search::{WebSearchErrorKind, WebSearchProvider};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

const MAX_BODY: usize = 16 * 1024;
const MAX_TICKETS: usize = 128;
const TICKET_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Startup {
    schema_version: u8,
    endpoint: String,
    token: String,
    initial_query_lease: String,
}

#[derive(Clone)]
struct Query {
    id: String,
    settings: WebFetchSettings,
    generation: u64,
    guard: Option<SearchDispatchGuard>,
    cancel: CancellationToken,
    observations: Arc<Observations>,
}

#[derive(Default)]
struct Observations {
    may_dispatch: AtomicBool,
    failure: Mutex<Option<WebSearchErrorKind>>,
}

impl Query {
    fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            self.reject(WebSearchErrorKind::Cancelled);
            bail!("Search route lease ended");
        }
        if let Some(guard) = &self.guard
            && let Err(error) = guard.check(WebSearchProvider::Searxng)
        {
            self.reject(error.kind);
            return Err(error.into());
        }
        if kcoder_tools::web_network::environment_fingerprint(&self.settings).ok()
            != Some(self.generation)
        {
            self.reject(WebSearchErrorKind::PolicyDenied);
            bail!("Search route policy changed");
        }
        Ok(())
    }
    fn reject(&self, kind: WebSearchErrorKind) {
        if let Ok(mut failure) = self.observations.failure.lock() {
            failure.get_or_insert(kind);
        }
    }
}

struct Ticket {
    query: String,
    url: reqwest::Url,
    proxy: Option<reqwest::Url>,
    expires: Instant,
}

#[derive(Default)]
struct State {
    active: Option<Query>,
    tickets: HashMap<String, Ticket>,
}

pub(super) struct ProxyRoutes {
    state: Arc<Mutex<State>>,
    endpoint: String,
    token: String,
    task: JoinHandle<()>,
}

pub(super) struct QueryLease {
    state: Arc<Mutex<State>>,
    query: Query,
}

fn random_id() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Search route authority unavailable"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl ProxyRoutes {
    pub(super) async fn start() -> Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let endpoint = format!("http://127.0.0.1:{}/route", listener.local_addr()?.port());
        let token = random_id()?;
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let secret = token.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((socket, address)) = accepted else { break };
                        if !address.ip().is_loopback() || connections.len() >= 16 { drop(socket); continue; }
                        let state = shared.clone(); let token = secret.clone();
                        connections.spawn(async move {
                            let _ = tokio::time::timeout(Duration::from_secs(35), serve(socket, state, &token)).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Ok(Self {
            state,
            endpoint,
            token,
            task,
        })
    }

    pub(super) fn activate(
        &self,
        settings: WebFetchSettings,
        guard: Option<&SearchDispatchGuard>,
    ) -> Result<QueryLease> {
        let query = Query {
            id: random_id()?,
            generation: kcoder_tools::web_network::environment_fingerprint(&settings)?,
            settings,
            guard: guard.cloned(),
            cancel: CancellationToken::new(),
            observations: Arc::new(Observations::default()),
        };
        query.check()?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Search route state unavailable"))?;
        ensure!(state.active.is_none(), "Search route query already active");
        state.tickets.clear();
        state.active = Some(query.clone());
        Ok(QueryLease {
            state: self.state.clone(),
            query,
        })
    }

    pub(super) fn startup(&self, lease: &QueryLease) -> Startup {
        Startup {
            schema_version: 1,
            endpoint: self.endpoint.clone(),
            token: self.token.clone(),
            initial_query_lease: lease.id().to_owned(),
        }
    }
}

impl Drop for ProxyRoutes {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(query) = state.active.take() {
                query.cancel.cancel();
            }
            state.tickets.clear();
        }
        self.task.abort();
    }
}

impl QueryLease {
    pub(super) fn id(&self) -> &str {
        &self.query.id
    }
    pub(super) fn may_dispatch(&self) -> bool {
        self.query.observations.may_dispatch.load(Ordering::Acquire)
    }
    pub(super) fn undispatched_failure(&self) -> Option<kcoder_tools::web_search::SearchFailure> {
        if self.may_dispatch() {
            return None;
        }
        let failure = *self.query.observations.failure.lock().ok()?;
        failure.map(|kind| kcoder_tools::web_search::SearchFailure::new(kind,
            "Bundled search could not obtain an authorized upstream route; no upstream request was dispatched", false))
    }
}
impl Drop for QueryLease {
    fn drop(&mut self) {
        self.query.cancel.cancel();
        if let Ok(mut state) = self.state.lock()
            && state
                .active
                .as_ref()
                .is_some_and(|active| active.id == self.query.id)
        {
            state.active = None;
            state.tickets.clear();
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Resolve {
        #[serde(rename = "queryLease")]
        query: String,
        url: String,
    },
    Redeem {
        #[serde(rename = "queryLease")]
        query: String,
        #[serde(rename = "routeTicket")]
        ticket: String,
        host: String,
        port: u16,
    },
    Release {
        #[serde(rename = "queryLease")]
        query: String,
        #[serde(rename = "routeTicket")]
        ticket: String,
    },
}

fn query(state: &Arc<Mutex<State>>, id: &str) -> Result<Query> {
    ensure!(id.len() == 64, "Invalid search route lease");
    let active = state
        .lock()
        .map_err(|_| anyhow::anyhow!("Search route state unavailable"))?
        .active
        .clone()
        .ok_or_else(|| anyhow::anyhow!("Search route lease ended"))?;
    ensure!(active.id == id, "Wrong search route lease");
    active.check()?;
    Ok(active)
}

async fn dispatch(state: &Arc<Mutex<State>>, request: Request) -> Result<serde_json::Value> {
    match request {
        Request::Resolve { query: id, url } => {
            let active = query(state, &id)?;
            let url = kcoder_tools::web_network::validate_url(&url)?;
            let host = url
                .host_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid search route host"))?
                .trim_matches(['[', ']']);
            let port = url
                .port_or_known_default()
                .ok_or_else(|| anyhow::anyhow!("Invalid search route port"))?;
            let addresses = tokio::select! {
                _ = active.cancel.cancelled() => bail!("Search route lease ended"),
                result = tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host((host, port))) => result??.collect::<Vec<_>>(),
            };
            ensure!(
                !addresses.is_empty()
                    && addresses.len() <= 64
                    && addresses
                        .iter()
                        .all(|address| kcoder_tools::web_network::is_public_ip(address.ip())),
                "Search route destination denied"
            );
            let proxy = {
                let resolve = kcoder_tools::web_network::resolve_proxy_for_url(
                    &active.settings,
                    &url,
                    &active.cancel,
                );
                tokio::pin!(resolve);
                let mut interval = tokio::time::interval(Duration::from_millis(50));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        biased;
                        _ = active.cancel.cancelled() => bail!("Search route lease ended"),
                        result = &mut resolve => break result.inspect_err(|_| active.reject(WebSearchErrorKind::Network))?,
                        _ = interval.tick() => active.check()?,
                    }
                }
            };
            active.check()?;
            let ticket = random_id()?;
            let mut state = state
                .lock()
                .map_err(|_| anyhow::anyhow!("Search route state unavailable"))?;
            ensure!(
                state
                    .active
                    .as_ref()
                    .is_some_and(|current| current.id == id),
                "Search route lease ended"
            );
            state
                .tickets
                .retain(|_, item| item.expires > Instant::now());
            ensure!(
                state.tickets.len() < MAX_TICKETS,
                "Search route capacity exceeded"
            );
            state.tickets.insert(
                ticket.clone(),
                Ticket {
                    query: id,
                    url,
                    proxy,
                    expires: Instant::now() + TICKET_TTL,
                },
            );
            Ok(serde_json::json!({"routeTicket":ticket}))
        }
        Request::Redeem {
            query: id,
            ticket,
            host,
            port,
        } => {
            let active = query(state, &id)?;
            let item = state
                .lock()
                .map_err(|_| anyhow::anyhow!("Search route state unavailable"))?
                .tickets
                .remove(&ticket)
                .ok_or_else(|| anyhow::anyhow!("Search route ticket unavailable"))?;
            ensure!(
                item.query == id && item.expires > Instant::now(),
                "Search route ticket ended"
            );
            ensure!(
                item.url.host_str().is_some_and(|expected| expected
                    .trim_matches(['[', ']'])
                    .eq_ignore_ascii_case(host.trim_matches(['[', ']'])))
                    && item.url.port_or_known_default() == Some(port),
                "Search route ticket destination changed"
            );
            active.check()?;
            active
                .observations
                .may_dispatch
                .store(true, Ordering::Release);
            Ok(serde_json::json!({"proxy":item.proxy.map(|proxy|proxy.to_string())}))
        }
        Request::Release { query: id, ticket } => {
            let _ = query(state, &id)?;
            let mut state = state
                .lock()
                .map_err(|_| anyhow::anyhow!("Search route state unavailable"))?;
            if state
                .tickets
                .get(&ticket)
                .is_some_and(|item| item.query == id)
            {
                state.tickets.remove(&ticket);
            }
            Ok(serde_json::json!({}))
        }
    }
}

async fn serve(mut socket: TcpStream, state: Arc<Mutex<State>>, token: &str) -> Result<()> {
    let mut data = Vec::new();
    let end = loop {
        let mut chunk = [0u8; 2048];
        let count = socket.read(&mut chunk).await?;
        ensure!(count > 0, "Search route request ended");
        data.extend_from_slice(&chunk[..count]);
        ensure!(
            data.len() <= MAX_BODY + 8192,
            "Search route request too large"
        );
        if let Some(end) = data.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        ensure!(data.len() <= 8192, "Search route headers too large");
    };
    let header = std::str::from_utf8(&data[..end])?;
    ensure!(
        header.lines().next() == Some("POST /route HTTP/1.1"),
        "Invalid search route method"
    );
    let mut length = None;
    let mut authorization = None;
    for line in header.lines().skip(1).filter(|line| !line.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| anyhow::anyhow!("Invalid search route header"))?;
        match name.to_ascii_lowercase().as_str() {
            "content-length" => {
                ensure!(length.is_none(), "Duplicate search route length");
                length = Some(value.trim().parse::<usize>()?);
            }
            "authorization" => {
                ensure!(authorization.is_none(), "Duplicate search route authority");
                authorization = Some(value.trim());
            }
            "transfer-encoding" => bail!("Unsupported search route encoding"),
            _ => {}
        }
    }
    let authorized = authorization.is_some_and(|value| {
        value
            .as_bytes()
            .ct_eq(format!("Bearer {token}").as_bytes())
            .into()
    });
    let length = length.ok_or_else(|| anyhow::anyhow!("Search route length missing"))?;
    ensure!(length <= MAX_BODY, "Search route body too large");
    while data.len() < end + length {
        let mut chunk = [0u8; 2048];
        let count = socket.read(&mut chunk).await?;
        ensure!(count > 0, "Search route body ended");
        data.extend_from_slice(&chunk[..count]);
        ensure!(data.len() <= MAX_BODY + 8192, "Search route body too large");
    }
    ensure!(
        data.len() == end + length,
        "Search route pipelining is not supported"
    );
    let result = if authorized {
        match serde_json::from_slice::<Request>(&data[end..end + length]) {
            Ok(request) => {
                let mut extra = [0u8; 1];
                tokio::select! {
                    biased;
                    _ = socket.read(&mut extra) => return Ok(()),
                    result = dispatch(&state, request) => result,
                }
            }
            Err(_) => Err(anyhow::anyhow!("Invalid search route request")),
        }
    } else {
        Err(anyhow::anyhow!("Search route authority denied"))
    };
    let (status, body) = match result {
        Ok(body) => (200, body),
        Err(_) => (403, serde_json::json!({"errorKind":"route_denied"})),
    };
    let issued = body
        .get("routeTicket")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let body = serde_json::to_vec(&body)?;
    let written = async {
        socket.write_all(format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes()).await?;
        socket.write_all(&body).await
    }.await;
    if written.is_err()
        && let Some(ticket) = issued
        && let Ok(mut state) = state.lock()
    {
        state.tickets.remove(&ticket);
    }
    written?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn direct() -> WebFetchSettings {
        WebFetchSettings {
            proxy_mode: kcoder_config::WebProxyMode::Direct,
            ..Default::default()
        }
    }

    async fn request(broker: &ProxyRoutes, body: serde_json::Value) -> reqwest::Response {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(&broker.endpoint)
            .bearer_auth(&broker.token)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn resolve(broker: &ProxyRoutes, lease: &QueryLease, url: &str) -> String {
        let response = request(
            broker,
            serde_json::json!({"op":"resolve","queryLease":lease.id(),"url":url}),
        )
        .await;
        assert_eq!(response.status(), 200);
        response.json::<serde_json::Value>().await.unwrap()["routeTicket"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    #[tokio::test]
    async fn route_tickets_require_authority_exact_destination_and_single_redemption() {
        let broker = ProxyRoutes::start().await.unwrap();
        let lease = broker.activate(direct(), None).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let denied=client.post(&broker.endpoint).json(&serde_json::json!({"op":"resolve","queryLease":lease.id(),"url":"https://93.184.216.34/a"})).send().await.unwrap();
        assert_eq!(denied.status(), 403);
        let ticket = resolve(&broker, &lease, "https://93.184.216.34/a?path=one").await;
        let redeem = serde_json::json!({"op":"redeem","queryLease":lease.id(),"routeTicket":ticket,"host":"93.184.216.34","port":443});
        let response = request(&broker, redeem.clone()).await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap(),
            serde_json::json!({"proxy":null})
        );
        assert!(lease.may_dispatch());
        assert!(lease.undispatched_failure().is_none());
        assert_eq!(request(&broker, redeem).await.status(), 403);
        let ticket = resolve(&broker, &lease, "http://93.184.216.34:443/a").await;
        assert_eq!(request(&broker,serde_json::json!({"op":"redeem","queryLease":lease.id(),"routeTicket":ticket,"host":"93.184.216.35","port":443})).await.status(),403);
        assert_eq!(request(&broker,serde_json::json!({"op":"resolve","queryLease":lease.id(),"url":"http://127.0.0.1/private"})).await.status(),403);
    }

    #[tokio::test]
    async fn old_query_and_revoked_guard_cannot_redeem_or_affect_a_new_owner() {
        let broker = ProxyRoutes::start().await.unwrap();
        let enabled = Arc::new(AtomicBool::new(true));
        let checked = enabled.clone();
        let guard = SearchDispatchGuard::new(move |_| {
            if checked.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(kcoder_tools::web_search::SearchFailure::new(
                    kcoder_types::web_search::WebSearchErrorKind::PolicyDenied,
                    "revoked fixture",
                    false,
                ))
            }
        });
        let lease = broker.activate(direct(), Some(&guard)).unwrap();
        assert!(broker.activate(direct(), None).is_err());
        let ticket = resolve(&broker, &lease, "https://93.184.216.34/a").await;
        enabled.store(false, Ordering::Release);
        assert_eq!(request(&broker,serde_json::json!({"op":"redeem","queryLease":lease.id(),"routeTicket":ticket,"host":"93.184.216.34","port":443})).await.status(),403);
        assert!(!lease.may_dispatch());
        let failure = lease.undispatched_failure().unwrap();
        assert_eq!(failure.kind, WebSearchErrorKind::PolicyDenied);
        assert!(!failure.request_sent);
        let old = lease.id().to_owned();
        drop(lease);
        let next = broker.activate(direct(), None).unwrap();
        assert_ne!(old, next.id());
        assert_eq!(
            request(
                &broker,
                serde_json::json!({"op":"resolve","queryLease":old,"url":"https://93.184.216.34/a"})
            )
            .await
            .status(),
            403
        );
        let ticket = resolve(&broker, &next, "https://93.184.216.34/a").await;
        assert_eq!(request(&broker,serde_json::json!({"op":"redeem","queryLease":next.id(),"routeTicket":ticket,"host":"93.184.216.34","port":443})).await.status(),200);
    }

    #[tokio::test]
    async fn expired_capacity_and_unknown_fields_do_not_turn_into_direct_routes() {
        let broker = ProxyRoutes::start().await.unwrap();
        let lease = broker.activate(direct(), None).unwrap();
        let ticket = resolve(&broker, &lease, "https://93.184.216.34/a").await;
        broker
            .state
            .lock()
            .unwrap()
            .tickets
            .get_mut(&ticket)
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert_eq!(request(&broker,serde_json::json!({"op":"redeem","queryLease":lease.id(),"routeTicket":ticket,"host":"93.184.216.34","port":443})).await.status(),403);
        assert_eq!(request(&broker,serde_json::json!({"op":"resolve","queryLease":lease.id(),"url":"https://93.184.216.34/a","proxy":"http://127.0.0.1:1"})).await.status(),403);
        {
            let mut state = broker.state.lock().unwrap();
            for index in 0..MAX_TICKETS {
                state.tickets.insert(
                    index.to_string(),
                    Ticket {
                        query: lease.id().to_owned(),
                        url: reqwest::Url::parse("https://93.184.216.34/").unwrap(),
                        proxy: None,
                        expires: Instant::now() + TICKET_TTL,
                    },
                );
            }
        }
        assert_eq!(request(&broker,serde_json::json!({"op":"resolve","queryLease":lease.id(),"url":"https://93.184.216.34/a"})).await.status(),403);
    }

    #[tokio::test]
    async fn a_closed_control_owner_creates_no_ticket_and_does_not_cancel_its_peer() {
        let broker = ProxyRoutes::start().await.unwrap();
        let lease = broker.activate(direct(), None).unwrap();
        let address = reqwest::Url::parse(&broker.endpoint).unwrap();
        let mut socket = TcpStream::connect(("127.0.0.1", address.port().unwrap()))
            .await
            .unwrap();
        let body=serde_json::to_vec(&serde_json::json!({"op":"resolve","queryLease":lease.id(),"url":"https://93.184.216.34/abandoned"})).unwrap();
        socket.write_all(format!("POST /route HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n",broker.token,body.len()).as_bytes()).await.unwrap();
        socket.write_all(&body).await.unwrap();
        socket.shutdown().await.unwrap();
        let mut closed = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), socket.read_to_end(&mut closed))
            .await
            .unwrap()
            .unwrap();
        assert!(closed.is_empty());
        assert!(broker.state.lock().unwrap().tickets.is_empty());
        assert!(!lease.query.cancel.is_cancelled());
        let ticket = resolve(&broker, &lease, "https://93.184.216.34/peer").await;
        assert_eq!(request(&broker,serde_json::json!({"op":"redeem","queryLease":lease.id(),"routeTicket":ticket,"host":"93.184.216.34","port":443})).await.status(),200);
    }
}
