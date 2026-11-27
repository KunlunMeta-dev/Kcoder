//! Read-only current-host listener discovery. An open socket is not proof of a proxy.
use crate::PluginCancellationToken;
use anyhow::{Result, ensure};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    time::{Duration, Instant},
};

const MAX_PORTS: usize = u16::MAX as usize;
const MAX_CONFIGURED_PORTS: usize = 256;
#[derive(Debug, Clone, Default)]
pub struct ProxyDetection {
    pub proxy_url: Option<String>,
    pub checked_ports: usize,
    pub timed_out: bool,
    pub limited: bool,
    /// Diagnostic origins contain no paths, query strings, or credentials.
    pub target_hosts: Vec<String>,
    pub source: &'static str,
    pub checked_candidates: usize,
    pub quick_checks: usize,
    pub cache_age_ms: Option<u64>,
    pub duration_ms: u64,
}

const CACHE_TTL: Duration = Duration::from_secs(240);
const MAX_CACHE_ENTRIES: usize = 32;

/// Owned by one target/profile's manager; never persisted or shared globally.
#[derive(Debug, Default)]
pub(crate) struct ProxyCache {
    entries: BTreeMap<ProxyCacheKey, ProxyCacheEntry>,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct ProxyCacheKey {
    origin: String,
    ports: Vec<u16>,
    configured: Option<String>,
}
#[derive(Debug, Clone)]
pub(crate) struct ProxyCacheEntry {
    pub proxy: String,
    pub verified_at: Instant,
}
impl ProxyCacheKey {
    pub(crate) fn new(probe: &str, ports: &[u16], configured: Option<&str>) -> Result<Self> {
        validate_ports(ports)?;
        let mut ports = ports.to_vec();
        ports.sort_unstable();
        ports.dedup();
        Ok(Self {
            origin: probe_origin(probe)?,
            ports,
            configured: configured.map(str::to_owned),
        })
    }
}
impl ProxyCache {
    pub(crate) fn recent(&mut self, key: &ProxyCacheKey, now: Instant) -> Option<ProxyCacheEntry> {
        self.entries
            .retain(|_, entry| now.saturating_duration_since(entry.verified_at) < CACHE_TTL);
        self.entries.get(key).cloned()
    }
    pub(crate) fn invalidate(&mut self, key: &ProxyCacheKey) {
        self.entries.remove(key);
    }
    pub(crate) fn remember(&mut self, key: ProxyCacheKey, proxy: String, now: Instant) {
        if self.entries.len() >= MAX_CACHE_ENTRIES
            && !self.entries.contains_key(&key)
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.verified_at)
                .map(|(key, _)| key.clone())
        {
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            key,
            ProxyCacheEntry {
                proxy,
                verified_at: now,
            },
        );
    }
    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Keep the actual source path for redirect validation, but never expose it in diagnostics.
pub(crate) fn probe_url(value: &str) -> Result<url::Url> {
    ensure!(value.len() <= 8192, "proxy probe URL is too long");
    let mut url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid proxy probe URL"))?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none(),
        "proxy probe requires credential-free HTTPS"
    );
    url.set_fragment(None);
    Ok(url)
}

pub(crate) fn probe_origin(value: &str) -> Result<String> {
    let mut url = probe_url(value)?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}
pub(crate) fn validate_ports(ports: &[u16]) -> Result<()> {
    ensure!(
        ports.len() <= MAX_CONFIGURED_PORTS && !ports.contains(&0),
        "proxy scan ports must contain at most 256 nonzero TCP ports"
    );
    Ok(())
}
type Listeners = BTreeMap<u16, BTreeSet<IpAddr>>;
fn add_listener(listeners: &mut Listeners, port: u16, address: IpAddr) {
    if port == 0 {
        return;
    }
    if address == IpAddr::V6(Ipv6Addr::UNSPECIFIED) {
        // A dual-stack listener may accept IPv4; both local loopbacks are safe probes.
        listeners
            .entry(port)
            .or_default()
            .insert(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    let address = match address {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    listeners.entry(port).or_default().insert(address);
}
#[cfg(any(target_os = "linux", test))]
fn proc_listeners(text: &str, listeners: &mut Listeners) {
    for line in text.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.get(3) != Some(&"0A") {
            continue;
        }
        let Some((host, port)) = fields.get(1).and_then(|s| s.rsplit_once(':')) else {
            continue;
        };
        let Ok(port) = u16::from_str_radix(port, 16) else {
            continue;
        };
        if host.len() == 8 {
            if let Ok(value) = u32::from_str_radix(host, 16) {
                add_listener(
                    listeners,
                    port,
                    IpAddr::V4(Ipv4Addr::from(value.to_le_bytes())),
                );
            }
        } else if host.len() == 32 {
            let mut bytes = [0u8; 16];
            let mut valid = true;
            for index in 0..4 {
                match u32::from_str_radix(&host[index * 8..index * 8 + 8], 16) {
                    Ok(value) => {
                        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes())
                    }
                    Err(_) => {
                        valid = false;
                        break;
                    }
                }
            }
            if valid {
                add_listener(listeners, port, IpAddr::V6(Ipv6Addr::from(bytes)));
            }
        }
    }
}
#[cfg(any(not(target_os = "linux"), test))]
fn command_listeners(text: &str, listeners: &mut Listeners) {
    for line in text.lines().filter(|line| line.contains("LISTEN")) {
        // First socket column is the local bind address. Never probe foreign peers.
        for candidate in line.split_whitespace() {
            let mut parsed = false;
            for (host, port) in [candidate.rsplit_once(':'), candidate.rsplit_once('.')]
                .into_iter()
                .flatten()
            {
                let Ok(port) = port.parse::<u16>() else {
                    continue;
                };
                let ip = if host == "*" {
                    Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
                } else {
                    host.trim_matches(['[', ']']).parse::<IpAddr>().ok()
                };
                if let Some(ip) = ip {
                    add_listener(listeners, port, ip);
                    parsed = true;
                    break;
                }
            }
            if parsed {
                break;
            }
        }
    }
}
#[cfg(test)]
fn proc_ports(text: &str, ports: &mut BTreeSet<u16>) {
    let mut listeners = Listeners::new();
    proc_listeners(text, &mut listeners);
    ports.extend(listeners.into_keys());
}
#[cfg(test)]
fn command_ports(text: &str, ports: &mut BTreeSet<u16>) {
    let mut listeners = Listeners::new();
    command_listeners(text, &mut listeners);
    ports.extend(listeners.into_keys());
}
fn listening_ports(deadline: Instant, cancel: &PluginCancellationToken) -> Result<Listeners> {
    let mut ports = Listeners::new();
    #[cfg(target_os = "linux")]
    {
        let mut read_inventory = false;
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(file) = std::fs::File::open(path) {
                let mut text = String::new();
                file.take(16 * 1024 * 1024 + 1).read_to_string(&mut text)?;
                ensure!(
                    text.len() <= 16 * 1024 * 1024,
                    "local port inventory exceeds read limit"
                );
                proc_listeners(&text, &mut ports);
                read_inventory = true;
            }
        }
        ensure!(read_inventory, "cannot enumerate local listening ports");
    }
    #[cfg(not(target_os = "linux"))]
    command_listeners(
        &crate::materialize::proxy_port_inventory(deadline, cancel)?,
        &mut ports,
    );
    let _ = (deadline, cancel);
    Ok(ports)
}

fn discover_port(
    port: u16,
    addresses: Option<&BTreeSet<IpAddr>>,
    origin: &str,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Vec<String> {
    let mut urls = Vec::new();
    let fallback = BTreeSet::from([
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]);
    for &ip in addresses.unwrap_or(&fallback) {
        for socks in [false, true] {
            if cancel.is_cancelled() {
                return urls;
            }
            let address = SocketAddr::new(ip, port);
            if handshake(address, socks, origin, deadline) {
                urls.push(format!(
                    "{}://{address}",
                    if socks { "socks5h" } else { "http" }
                ));
            }
        }
    }
    urls
}

fn handshake(address: SocketAddr, socks: bool, origin: &str, deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let Ok(mut stream) =
        TcpStream::connect_timeout(&address, remaining.min(Duration::from_millis(120)))
    else {
        return false;
    };
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    let timeout = remaining.min(Duration::from_millis(100));
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    if socks {
        if stream.write_all(&[5, 1, 0]).is_err() {
            return false;
        }
        let mut response = [0; 2];
        return stream.read_exact(&mut response).is_ok() && response == [5, 0];
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let authority = format!("{host}:{}", url.port_or_known_default().unwrap_or(443));
    let request = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let stop = deadline.min(Instant::now() + Duration::from_millis(1000));
    let mut response = Vec::new();
    let mut buffer = [0u8; 256];
    while response.len() < 512 && Instant::now() < stop {
        let n = match stream.read(&mut buffer) {
            Ok(n) => n,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue;
            }
            Err(_) => return false,
        };
        if n == 0 {
            return false;
        }
        response.extend_from_slice(&buffer[..n]);
        if response.contains(&b'\n') {
            break;
        }
    }
    let line = String::from_utf8_lossy(&response);
    (line.starts_with("HTTP/1.1 ") || line.starts_with("HTTP/1.0 "))
        && line.split_whitespace().nth(1) == Some("200")
}

pub(crate) fn detect(
    ports: &[u16],
    preferred: Option<&str>,
    failed_proxy: Option<&str>,
    probe: &str,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<ProxyDetection> {
    let started = Instant::now();
    cancel.check()?;
    validate_ports(ports)?;
    let origin = probe_origin(probe)?;
    if started >= deadline {
        return Ok(ProxyDetection {
            timed_out: true,
            target_hosts: vec![origin],
            source: "scan",
            ..Default::default()
        });
    }
    let listeners = if ports.is_empty() {
        listening_ports(deadline, cancel)?
    } else {
        // Explicit port filters still use any known local bind addresses.
        listening_ports(deadline, cancel).unwrap_or_default()
    };
    let mut candidates = if ports.is_empty() {
        listeners.keys().copied().collect()
    } else {
        ports.to_vec()
    };
    if let Some(port) = preferred
        .and_then(|p| url::Url::parse(p).ok())
        .and_then(|u| u.port())
        && candidates.contains(&port)
    {
        candidates.insert(0, port);
    }
    let mut seen = BTreeSet::new();
    candidates.retain(|p| seen.insert(*p));
    let mut pending = BTreeMap::new();
    let mut batch_start = 0;
    let mut actual_ports = 0;
    let mut checked_candidates = 0;
    let mut target_hosts = vec![origin.clone()];
    let mut result = scan(
        &candidates,
        deadline,
        cancel,
        |port| {
            if pending.is_empty() && batch_start < candidates.len() {
                let end = (batch_start + 8).min(candidates.len());
                actual_ports += end - batch_start;
                // Protocol probes are independent and bounded; HTTPS validation
                // remains ordered and stops at the first actually working proxy.
                let found = std::thread::scope(|scope| {
                    let handles: Vec<_> = candidates[batch_start..end]
                        .iter()
                        .map(|&port| {
                            let origin = &origin;
                            let addresses = listeners.get(&port);
                            scope.spawn(move || {
                                (
                                    port,
                                    discover_port(port, addresses, origin, deadline, cancel),
                                )
                            })
                        })
                        .collect();
                    handles
                        .into_iter()
                        .filter_map(|handle| handle.join().ok())
                        .collect::<Vec<_>>()
                });
                pending.extend(found);
                batch_start = end;
            }
            let mut urls = pending.remove(&port).unwrap_or_default();
            urls.sort_by_key(|url| preferred != Some(url.as_str()));
            urls
        },
        |proxy| {
            if failed_proxy == Some(proxy) {
                return Ok(false);
            }
            checked_candidates += 1;
            let verified = crate::materialize::verify_proxy_https_targets(
                proxy,
                probe,
                deadline.min(Instant::now() + Duration::from_secs(4)),
                cancel,
            );
            cancel.check()?;
            match verified {
                Ok(hosts) => {
                    target_hosts = hosts;
                    Ok(true)
                }
                Err(error)
                    if error.chain().any(|cause| {
                        cause
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                    }) =>
                {
                    Err(error)
                }
                Err(_) => Ok(false),
            }
        },
    )?;
    result.checked_ports = actual_ports;
    result.checked_candidates = checked_candidates;
    result.target_hosts = target_hosts;
    result.source = "scan";
    result.duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    cancel.check()?;
    Ok(result)
}
fn scan(
    ports: &[u16],
    deadline: Instant,
    cancel: &PluginCancellationToken,
    mut discover: impl FnMut(u16) -> Vec<String>,
    mut verify: impl FnMut(&str) -> Result<bool>,
) -> Result<ProxyDetection> {
    let mut result = ProxyDetection {
        limited: ports.len() > MAX_PORTS,
        ..Default::default()
    };
    for &port in ports.iter().take(MAX_PORTS) {
        cancel.check()?;
        if Instant::now() >= deadline {
            result.timed_out = true;
            break;
        }
        result.checked_ports += 1;
        for proxy in discover(port) {
            cancel.check()?;
            if Instant::now() >= deadline {
                result.timed_out = true;
                return Ok(result);
            }
            // Probe sequentially; a false positive / failed proxy does not win.
            if verify(&proxy)? {
                result.proxy_url = Some(proxy);
                return Ok(result);
            }
        }
    }
    result.timed_out |= Instant::now() >= deadline;
    if result.proxy_url.is_none() && Instant::now() >= deadline {
        result.timed_out = true;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tries_each_candidate_until_https_works_and_stops_at_the_first_success() {
        let mut checked = Vec::new();
        let result = scan(
            &[10001, 10002, 10003],
            Instant::now() + Duration::from_secs(2),
            &PluginCancellationToken::default(),
            |port| vec![format!("http://127.0.0.1:{port}")],
            |proxy| {
                checked.push(proxy.to_owned());
                Ok(proxy.ends_with("10002"))
            },
        )
        .unwrap();
        assert_eq!(
            checked,
            vec!["http://127.0.0.1:10001", "http://127.0.0.1:10002"]
        );
        assert_eq!(result.proxy_url.as_deref(), Some("http://127.0.0.1:10002"));
        assert_eq!(result.checked_ports, 2);
    }
    #[test]
    fn discovered_ports_are_not_limited_to_common_proxy_numbers() {
        let mut ports = BTreeSet::new();
        command_ports(
            "TCP 127.0.0.1:32123 0.0.0.0:0 LISTENING\nTCP [::1]:61234 [::]:0 LISTENING\n",
            &mut ports,
        );
        assert_eq!(ports, BTreeSet::from([32123, 61234]));
        const { assert!(MAX_PORTS >= 65535) };
    }
    #[test]
    fn inventory_uses_only_local_listening_ports_and_preserves_timeout_status() {
        let mut ports = BTreeSet::new();
        proc_ports(
            "header\n0: 0100007F:1ED2 00000000:0000 0A\n1: 0100010A:2328 00000000:0000 0A\n",
            &mut ports,
        );
        command_ports(
            "TCP 127.0.0.1:10809 0.0.0.0:0 LISTENING\nTCP 10.0.0.1:9001 0.0.0.0:0 LISTENING\n",
            &mut ports,
        );
        assert_eq!(ports, BTreeSet::from([7890, 9000, 9001, 10809]));
        let result = scan(
            &[7890],
            Instant::now(),
            &PluginCancellationToken::default(),
            |_| panic!("expired"),
            |_| Ok(true),
        )
        .unwrap();
        assert!(result.timed_out);
        assert!(result.proxy_url.is_none());
        assert!(probe_origin("https://user:secret@example.com/").is_err());
        assert_eq!(
            probe_origin("https://example.com/private?key=x").unwrap(),
            "https://example.com/"
        );
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn cache_is_scoped_by_https_origin_proxy_configuration_and_port_filter() {
        let now = Instant::now();
        let mut target = ProxyCache::default();
        let key = ProxyCacheKey::new("https://github.test/source?secret=x", &[60002, 60001], None)
            .unwrap();
        target.remember(key.clone(), "socks5h://[::1]:60001".into(), now);
        assert!(
            target
                .recent(
                    &ProxyCacheKey::new("https://github.test/other", &[60001, 60002, 60001], None)
                        .unwrap(),
                    now
                )
                .is_some()
        );
        for other in [
            ProxyCacheKey::new("https://gitee.test/", &[60001, 60002], None).unwrap(),
            ProxyCacheKey::new("https://github.test:444/", &[60001, 60002], None).unwrap(),
            ProxyCacheKey::new("https://github.test/", &[60003], None).unwrap(),
            ProxyCacheKey::new(
                "https://github.test/",
                &[60001, 60002],
                Some("http://127.0.0.1:60002"),
            )
            .unwrap(),
        ] {
            assert!(target.recent(&other, now).is_none());
        }
        assert!(
            ProxyCache::default().recent(&key, now).is_none(),
            "different target/profile manager has no shared cache"
        );
        assert!(
            target
                .recent(&key, now + CACHE_TTL - Duration::from_millis(1))
                .is_some()
        );
        assert!(target.recent(&key, now + CACHE_TTL).is_none());
        assert!(target.entries.is_empty());
    }

    #[test]
    fn cache_is_bounded_and_failure_invalidation_does_not_keep_old_success() {
        let now = Instant::now();
        let mut cache = ProxyCache::default();
        for n in 0..=MAX_CACHE_ENTRIES {
            cache.remember(
                ProxyCacheKey::new(&format!("https://host-{n}.test/"), &[], None).unwrap(),
                format!("http://127.0.0.1:{}", 50000 + n),
                now + Duration::from_millis(n as u64),
            );
        }
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        let key = ProxyCacheKey::new("https://host-0.test/", &[], None).unwrap();
        assert!(cache.recent(&key, now).is_none());
        let key = ProxyCacheKey::new("https://host-1.test/", &[], None).unwrap();
        cache.invalidate(&key);
        assert!(cache.recent(&key, now).is_none());
        cache.clear();
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn owned_ipv4_ipv6_high_port_protocol_probes_and_deadline() {
        for bind in ["127.0.0.1:0", "[::1]:0"] {
            let listener = std::net::TcpListener::bind(bind).unwrap();
            let address = listener.local_addr().unwrap();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = [0; 256];
                let count = socket.read(&mut bytes).unwrap();
                assert!(
                    std::str::from_utf8(&bytes[..count])
                        .unwrap()
                        .starts_with("CONNECT source.test:443 HTTP/1.1")
                );
                socket
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .unwrap();
            });
            assert!(handshake(
                address,
                false,
                "https://source.test/",
                Instant::now() + Duration::from_secs(2)
            ));
            worker.join().unwrap();
            // The owned listener has exited; a prior result must not prove it is alive.
            assert!(!handshake(
                address,
                false,
                "https://source.test/",
                Instant::now() + Duration::from_millis(100)
            ));
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0; 3];
            socket.read_exact(&mut bytes).unwrap();
            assert_eq!(bytes, [5, 1, 0]);
            socket.write_all(&[5, 0]).unwrap();
        });
        assert!(handshake(
            address,
            true,
            "https://source.test/",
            Instant::now() + Duration::from_secs(2)
        ));
        worker.join().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let started = Instant::now();
        assert!(!handshake(
            address,
            false,
            "https://source.test/",
            started + Duration::from_millis(40)
        ));
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn cancelled_or_expired_detection_never_enumerates_or_probes() {
        let cancellation = PluginCancellationToken::default();
        cancellation.cancel();
        assert!(
            detect(
                &[],
                None,
                None,
                "https://source.test/",
                Instant::now() + Duration::from_secs(1),
                &cancellation
            )
            .unwrap_err()
            .to_string()
            .contains("cancelled")
        );
        let result = detect(
            &[],
            None,
            None,
            "https://source.test/",
            Instant::now(),
            &PluginCancellationToken::default(),
        )
        .unwrap();
        assert!(result.timed_out);
        assert_eq!(result.checked_ports, 0);
        assert_eq!(result.checked_candidates, 0);
    }
}
