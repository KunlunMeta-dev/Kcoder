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
}

pub(crate) fn probe_origin(value: &str) -> Result<String> {
    ensure!(value.len() <= 2048, "proxy probe URL is too long");
    let mut url = url::Url::parse(value)?;
    ensure!(
        url.scheme() == "https" && url.username().is_empty() && url.password().is_none(),
        "proxy probe requires credential-free HTTPS"
    );
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
    if Instant::now() >= deadline {
        return false;
    }
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(120)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
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
    probe: &str,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<ProxyDetection> {
    validate_ports(ports)?;
    let origin = probe_origin(probe)?;
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
    scan(
        &candidates,
        deadline,
        cancel,
        |port| {
            if pending.is_empty() && batch_start < candidates.len() {
                let end = (batch_start + 8).min(candidates.len());
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
        |proxy| match crate::materialize::verify_proxy_https(proxy, &origin, deadline, cancel) {
            Ok(()) => Ok(true),
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
        },
    )
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
        assert!(MAX_PORTS >= 65535);
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
