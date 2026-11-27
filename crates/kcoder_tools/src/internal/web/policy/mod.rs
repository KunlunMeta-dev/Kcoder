//! Target-owned web proxy and certificate policy, independent of request authorization.

use kcoder_config::{WebFetchSettings, WebProxyMode};
use kcoder_tool_error::ToolError;
use std::{
    hash::{Hash, Hasher},
    net::IpAddr,
};
use url::Url;

#[path = "../../../web_network/ca.rs"]
pub mod ca;
#[cfg(any(windows, target_os = "macos", test))]
#[path = "system_proxy.rs"]
pub mod system_proxy;
#[cfg(windows)]
#[path = "../../../web_network/windows_auto_proxy/implementation.rs"]
mod windows_auto_proxy;
#[cfg(windows)]
pub use system_proxy::AutomaticProxy;

fn cancelled() -> ToolError {
    ToolError::Execution("Web request cancelled".into())
}

const ENVIRONMENT: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "KCODER_WEB_NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "CURL_CA_BUNDLE",
];

/// Resolve the target's effective network environment without changing process
/// globals. Values can contain proxy credentials and must stay in host memory
/// or an owned worker's private environment, never diagnostics or model input.
pub fn effective_environment(
    settings: &WebFetchSettings,
) -> Result<Vec<(String, Option<String>)>, ToolError> {
    Ok(capture_environment(settings)?.values)
}

pub struct TargetEnvironment {
    pub values: Vec<(String, Option<String>)>,
    #[cfg(any(windows, target_os = "macos", test))]
    pub automatic_proxy: Option<system_proxy::AutomaticProxy>,
}

impl TargetEnvironment {
    pub fn hash_automatic_proxy(&self, hash: &mut impl Hasher) {
        #[cfg(any(windows, target_os = "macos", test))]
        self.automatic_proxy.hash(hash);
        #[cfg(not(any(windows, target_os = "macos", test)))]
        let _ = hash;
    }
}

pub fn capture_environment(settings: &WebFetchSettings) -> Result<TargetEnvironment, ToolError> {
    let mut names: Vec<String> = ENVIRONMENT.iter().map(|name| (*name).to_owned()).collect();
    if let Some(name) = &settings.proxy_env {
        names.push(name.clone());
    }
    let environment = names
        .into_iter()
        .map(|name| {
            let value = std::env::var(&name).ok();
            (name, value)
        })
        .collect::<Vec<_>>();
    if settings.proxy_mode == WebProxyMode::Configured
        && !settings.proxy_env.as_deref().is_some_and(|name| {
            environment
                .iter()
                .any(|(key, value)| key == name && value.as_deref().is_some_and(|v| !v.is_empty()))
        })
    {
        return Err(ToolError::Execution(
            "The configured web proxy reference is unavailable".into(),
        ));
    }
    #[cfg(any(windows, target_os = "macos", test))]
    let (environment, automatic_proxy) = {
        let mut environment = environment;
        let legacy_direct = environment.iter().any(|(name, value)| {
            name == "KCODER_WEB_NO_PROXY"
                && value.as_deref().is_some_and(|v| {
                    matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
                })
        });
        let automatic = if settings.proxy_mode == WebProxyMode::Inherit && !legacy_direct {
            system_proxy::apply(&mut environment)?
        } else {
            None
        };
        (environment, automatic)
    };
    Ok(TargetEnvironment {
        values: environment,
        #[cfg(any(windows, target_os = "macos", test))]
        automatic_proxy,
    })
}

/// Opaque process-local generation, including native static proxy settings and
/// the identity/mtime of configured CA resources. It contains no printable URL.
pub fn environment_fingerprint(settings: &WebFetchSettings) -> Result<u64, ToolError> {
    let target = capture_environment(settings)?;
    Ok(fingerprint_environment(settings, &target))
}
pub fn fingerprint_environment(settings: &WebFetchSettings, target: &TargetEnvironment) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    settings.hash(&mut hash);
    target.values.hash(&mut hash);
    target.hash_automatic_proxy(&mut hash);
    hash_ca_files(&target.values, &mut hash);
    hash.finish()
}
pub fn hash_ca_files(environment: &[(String, Option<String>)], hash: &mut impl Hasher) {
    fn metadata(path: &std::path::Path, hash: &mut impl Hasher) {
        path.hash(hash);
        if let Ok(meta) = std::fs::metadata(path) {
            meta.len().hash(hash);
            meta.modified().ok().hash(hash);
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                meta.dev().hash(hash);
                meta.ino().hash(hash);
            }
        }
    }
    for (name, value) in environment {
        let Some(value) = value.as_deref().filter(|v| !v.is_empty()) else {
            continue;
        };
        if matches!(name.as_str(), "SSL_CERT_FILE" | "CURL_CA_BUNDLE") {
            metadata(std::path::Path::new(value), hash);
        } else if name == "SSL_CERT_DIR" {
            for directory in std::env::split_paths(value) {
                metadata(&directory, hash);
                if let Ok(entries) = std::fs::read_dir(directory) {
                    let mut files = entries
                        .filter_map(Result::ok)
                        .map(|entry| entry.path())
                        .filter(|path| {
                            matches!(
                                path.extension().and_then(|s| s.to_str()),
                                Some("pem" | "crt")
                            )
                        })
                        .take(513)
                        .collect::<Vec<_>>();
                    files.sort();
                    for path in files {
                        metadata(&path, hash);
                    }
                }
            }
        }
    }
}

pub struct ProxySelection<'a> {
    pub settings: &'a WebFetchSettings,
    pub environment: &'a [(String, Option<String>)],
    #[cfg(windows)]
    pub automatic_proxy: Option<&'a system_proxy::AutomaticProxy>,
}
impl ProxySelection<'_> {
    fn env(&self, name: &str) -> Option<&str> {
        self.environment
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| value.as_deref())
    }
    pub async fn resolve(
        &self,
        url: &Url,
        cancel: &tokio_util::sync::CancellationToken,
        check: &(dyn Fn() -> Result<(), ToolError> + Send + Sync),
    ) -> Result<Option<Url>, ToolError> {
        if cancel.is_cancelled() {
            return Err(cancelled());
        }
        check()?;
        if self.settings.proxy_mode == WebProxyMode::Direct {
            return Ok(None);
        }
        if self.settings.proxy_mode == WebProxyMode::Inherit
            && self.env("KCODER_WEB_NO_PROXY").is_some_and(|v| {
                matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
            })
        {
            return Ok(None);
        }
        let raw = if self.settings.proxy_mode == WebProxyMode::Configured {
            self.settings
                .proxy_env
                .as_deref()
                .and_then(|name| self.env(name))
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    ToolError::Execution("The configured web proxy reference is unavailable".into())
                })?
        } else {
            if bypasses(
                url,
                self.env("no_proxy")
                    .or_else(|| self.env("NO_PROXY"))
                    .unwrap_or(""),
            ) {
                return Ok(None);
            }
            #[cfg(windows)]
            if let Some(automatic) = &self.automatic_proxy {
                return windows_auto_proxy::resolve(automatic, url, cancel, check).await;
            }
            let scheme = if url.scheme() == "https" {
                ["https_proxy", "HTTPS_PROXY"]
            } else {
                ["http_proxy", "HTTP_PROXY"]
            };
            let Some(raw) = self
                .env(scheme[0])
                .or_else(|| self.env(scheme[1]))
                .or_else(|| self.env("all_proxy"))
                .or_else(|| self.env("ALL_PROXY"))
                .filter(|v| !v.is_empty())
            else {
                return Ok(None);
            };
            raw
        };
        let parsed = Url::parse(raw)
            .map_err(|_| ToolError::Execution("The target web proxy URL is invalid".into()))?;
        if !matches!(parsed.scheme(), "http" | "socks4" | "socks5")
            || parsed.host_str().is_none()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ToolError::Execution("The target web proxy cannot pin destination addresses; supported modes are HTTP CONNECT and locally resolved SOCKS4/5".into()));
        }
        Ok(Some(parsed))
    }
}

/// Read-only capability selection for host workers. This does not start WPAD,
/// download PAC, or expose system URLs, and is false for explicit proxy modes.
pub fn requires_system_proxy_resolution(settings: &WebFetchSettings) -> Result<bool, ToolError> {
    if settings.proxy_mode != WebProxyMode::Inherit {
        return Ok(false);
    }
    let target = capture_environment(settings)?;
    #[cfg(windows)]
    {
        Ok(target.automatic_proxy.is_some())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Ok(false)
    }
}

fn wildcard_host(pattern: &str, host: &str) -> bool {
    let (pattern, host) = (pattern.as_bytes(), host.as_bytes());
    let (mut p, mut h, mut star, mut retry) = (0, 0, None, 0);
    while h < host.len() {
        if p < pattern.len() && pattern[p] == host[h] {
            p += 1;
            h += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = h;
        } else if let Some(previous) = star {
            retry += 1;
            h = retry;
            p = previous + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

pub fn bypasses(url: &Url, rules: &str) -> bool {
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    rules
        .split(',')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .any(|rule| {
            if rule == "*"
                || (rule == "<local>" && !host.contains('.') && host.parse::<IpAddr>().is_err())
            {
                return true;
            }
            let (name, port) = if rule.starts_with('[') {
                match rule.find(']') {
                    Some(end) => (
                        &rule[1..end],
                        rule[end + 1..]
                            .strip_prefix(':')
                            .and_then(|v| v.parse::<u16>().ok()),
                    ),
                    None => return false,
                }
            } else if rule.bytes().filter(|b| *b == b':').count() == 1 {
                let (name, port) = rule.rsplit_once(':').unwrap();
                (name, port.parse::<u16>().ok())
            } else {
                (rule, None)
            };
            if port.is_some() && port != url.port_or_known_default() {
                return false;
            }
            if let Some((network, bits)) = name.split_once('/') {
                let Ok(network) = network.parse::<IpAddr>() else {
                    return false;
                };
                let Ok(ip) = host.parse::<IpAddr>() else {
                    return false;
                };
                let Ok(bits) = bits.parse::<u32>() else {
                    return false;
                };
                return match (ip, network) {
                    (IpAddr::V4(ip), IpAddr::V4(net)) if bits <= 32 => {
                        u32::from(ip).checked_shr(32 - bits).unwrap_or(0)
                            == u32::from(net).checked_shr(32 - bits).unwrap_or(0)
                    }
                    (IpAddr::V6(ip), IpAddr::V6(net)) if bits <= 128 => {
                        u128::from(ip).checked_shr(128 - bits).unwrap_or(0)
                            == u128::from(net).checked_shr(128 - bits).unwrap_or(0)
                    }
                    _ => false,
                };
            }
            let name = name
                .trim_start_matches("*.")
                .trim_start_matches('.')
                .trim_end_matches('.')
                .to_ascii_lowercase();
            if name.contains('*') {
                return wildcard_host(&name, &host);
            }
            host == name || (host.ends_with(&format!(".{name}")) && name.parse::<IpAddr>().is_err())
        })
}

pub fn validate_url(raw: &str) -> Result<Url, ToolError> {
    if raw.len() > 8192 {
        return Err(ToolError::InvalidInput(
            "URL exceeds the 8192-byte limit".into(),
        ));
    }
    let url = Url::parse(raw).map_err(|_| {
        ToolError::InvalidInput("Invalid URL: expected an absolute HTTP(S) URL".into())
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() == Some(0)
    {
        return Err(ToolError::InvalidInput("Invalid URL: use HTTP(S), an explicit host and a nonzero port, without embedded credentials".into()));
    }
    Ok(url)
}
