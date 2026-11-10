//! Per-request SOCKS front end converts HTTP proxy CONNECT to a pinned IP.
//! The origin URL, Host header, TLS server name and certificate checks stay intact.
use super::{PolicySnapshot, denied};
use crate::{ToolContext, ToolError};
use base64::Engine;
use std::net::{IpAddr, SocketAddr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use url::Url;

pub(super) struct OwnedProxyTunnel {
    address: SocketAddr,
    task: JoinHandle<()>,
}
impl Drop for OwnedProxyTunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl OwnedProxyTunnel {
    pub(super) async fn start(
        proxy: Url,
        addresses: Vec<SocketAddr>,
        ctx: ToolContext,
        policy: PolicySnapshot,
        url: Url,
    ) -> Result<Self, ToolError> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
            ToolError::Execution("The owned web proxy listener could not start".into())
        })?;
        let address = listener.local_addr().map_err(|_| denied())?;
        let task = tokio::spawn(async move {
            // A client uses one connection for this one request. No detached
            // per-connection tasks can survive dropping the response owner.
            let work = async {
                let (mut local, _) = listener.accept().await?;
                let destination = socks_destination(&mut local).await?;
                if !addresses.contains(&destination) {
                    return Err(std::io::Error::other("destination is not pinned"));
                }
                policy.check(&ctx, &url).map_err(std::io::Error::other)?;
                let mut remote = TcpStream::connect((
                    proxy.host_str().unwrap().trim_matches(['[', ']']),
                    proxy.port().unwrap_or(80),
                ))
                .await?;
                let mut request =
                    format!("CONNECT {destination} HTTP/1.1\r\nHost: {destination}\r\n");
                if !proxy.username().is_empty() || proxy.password().is_some() {
                    let user = percent_decode(proxy.username())?;
                    let password = percent_decode(proxy.password().unwrap_or(""))?;
                    let encoded = base64::engine::general_purpose::STANDARD
                        .encode(format!("{user}:{password}"));
                    request.push_str(&format!("Proxy-Authorization: Basic {encoded}\r\n"));
                }
                request.push_str("\r\n");
                policy.check(&ctx, &url).map_err(std::io::Error::other)?;
                remote.write_all(request.as_bytes()).await?;
                let mut header = Vec::new();
                while !header.ends_with(b"\r\n\r\n") && header.len() < 8192 {
                    header.push(remote.read_u8().await?);
                }
                let line = header.split(|b| *b == b'\n').next().unwrap_or_default();
                if !header.ends_with(b"\r\n\r\n")
                    || !matches!(line.get(..12), Some(b"HTTP/1.1 200" | b"HTTP/1.0 200"))
                {
                    return Err(std::io::Error::other("proxy tunnel was refused"));
                }
                local.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await?;
                Ok::<_, std::io::Error>(())
            };
            tokio::select! { biased; _ = ctx.cancelled() => {}, _ = tokio::time::timeout(std::time::Duration::from_secs(60), work) => {} }
        });
        Ok(Self { address, task })
    }
    pub(super) fn url(&self) -> String {
        format!("socks5://{}", self.address)
    }
}

async fn socks_destination(stream: &mut TcpStream) -> std::io::Result<SocketAddr> {
    let version = stream.read_u8().await?;
    let count = stream.read_u8().await?;
    let mut methods = vec![0; count as usize];
    stream.read_exact(&mut methods).await?;
    if version != 5 || !methods.contains(&0) {
        return Err(std::io::Error::other("invalid SOCKS handshake"));
    }
    stream.write_all(&[5, 0]).await?;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    if header[..3] != [5, 1, 0] {
        return Err(std::io::Error::other("invalid SOCKS request"));
    }
    let ip = match header[3] {
        1 => {
            let mut ip = [0; 4];
            stream.read_exact(&mut ip).await?;
            IpAddr::from(ip)
        }
        4 => {
            let mut ip = [0; 16];
            stream.read_exact(&mut ip).await?;
            IpAddr::from(ip)
        }
        _ => return Err(std::io::Error::other("SOCKS remote DNS is forbidden")),
    };
    Ok(SocketAddr::new(ip, stream.read_u16().await?))
}

fn percent_decode(text: &str) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    let mut iter = text.bytes();
    while let Some(b) = iter.next() {
        if b == b'%' {
            let a = iter.next().and_then(|c| (c as char).to_digit(16));
            let b = iter.next().and_then(|c| (c as char).to_digit(16));
            bytes.push(match (a, b) {
                (Some(a), Some(b)) => (a * 16 + b) as u8,
                _ => return Err(std::io::Error::other("invalid proxy credentials")),
            });
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8(bytes).map_err(std::io::Error::other)
}

#[cfg(test)]
use kcoder_web::policy::bypasses;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_proxy_matches_label_boundaries_ports_and_cidr() {
        let url = Url::parse("https://docs.example.com:8443/path").unwrap();
        assert!(bypasses(&url, ".example.com:8443"));
        assert!(!bypasses(&url, "ample.com"));
        assert!(bypasses(&url, "*.example.com:8443"));
        assert!(bypasses(
            &Url::parse("http://owned-dev:8080").unwrap(),
            "<local>"
        ));
        assert!(!bypasses(&url, "<local>"));
        assert!(bypasses(
            &Url::parse("https://www.microsoft.example").unwrap(),
            "www.microsoft.*"
        ));
        assert!(!bypasses(
            &Url::parse("https://other.microsoft.example").unwrap(),
            "www.microsoft.*"
        ));
        assert!(!bypasses(&url, "example.com:443"));
        assert!(bypasses(
            &Url::parse("http://127.0.0.2").unwrap(),
            "127.0.0.0/8"
        ));
        assert!(bypasses(
            &Url::parse("http://[::1]:123").unwrap(),
            "[::1]:123"
        ));
    }
}

#[cfg(test)]
mod tunnel_tests {
    use super::*;
    #[tokio::test]
    async fn http_proxy_receives_only_the_pinned_ip_and_origin_host_is_preserved() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(stream.read_u8().await.unwrap());
            }
            assert!(
                String::from_utf8(header)
                    .unwrap()
                    .starts_with("CONNECT 1.1.1.1:8080 HTTP/1.1\r\n")
            );
            stream
                .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                .await
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(stream.read_u8().await.unwrap());
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /doc HTTP/1.1\r\n"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("host: pinned.example.test:8080\r\n")
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\npinned",
                )
                .await
                .unwrap();
        });
        let mut settings = kcoder_config::Settings::default();
        settings.web.fetch.proxy_mode = kcoder_config::WebProxyMode::Direct;
        let ctx = ToolContext::new(kcoder_state::AppState::new("."))
            .with_runtime_settings(std::sync::Arc::new(std::sync::RwLock::new(settings)));
        let policy = PolicySnapshot::capture(&ctx).unwrap();
        let url = Url::parse("http://pinned.example.test:8080/doc").unwrap();
        let tunnel = OwnedProxyTunnel::start(
            proxy_url,
            vec!["1.1.1.1:8080".parse().unwrap()],
            ctx,
            policy,
            url.clone(),
        )
        .await
        .unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(tunnel.url()).unwrap())
            .resolve("pinned.example.test", "1.1.1.1:8080".parse().unwrap())
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .unwrap();
        assert_eq!(
            client.get(url).send().await.unwrap().text().await.unwrap(),
            "pinned"
        );
        server.await.unwrap();
    }
}
