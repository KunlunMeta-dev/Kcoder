//! Network configuration is explicitly allowlisted; Git configuration and credentials
//! remain isolated from plugin materialization.
use anyhow::{Result, bail};
use std::ffi::OsString;

pub fn validate_plugin_proxy(value: &str) -> Result<()> {
    if value.is_empty() {
        return Ok(());
    }
    if value.len() > 2048 {
        bail!("invalid plugin proxy: URL is too long");
    }
    let url = url::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid plugin proxy URL"))?;
    if !matches!(url.scheme(), "http" | "https" | "socks5" | "socks5h")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        bail!("invalid plugin proxy: use a credential-free HTTP(S) or SOCKS5 endpoint");
    }
    Ok(())
}

pub(crate) fn resolve_proxy(configured: Option<&str>) -> Result<Option<OsString>> {
    let value = configured
        .filter(|value| !value.trim().is_empty())
        .map(OsString::from)
        .or_else(|| {
            [
                "KCODER_PLUGIN_GIT_PROXY",
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "HTTP_PROXY",
                "http_proxy",
            ]
            .into_iter()
            .find_map(|key| std::env::var_os(key).filter(|value| !value.is_empty()))
        });
    if let Some(value) = &value {
        validate_plugin_proxy(
            value
                .to_str()
                .ok_or_else(|| anyhow::anyhow!("plugin proxy is not UTF-8"))?,
        )?;
    }
    Ok(value)
}

/// Only certificate trust inputs cross the child environment boundary. Paths are
/// resolved on the installation target before the child enters a private cwd.
pub(crate) fn configure_target_ca(
    command: &mut std::process::Command,
    program: &str,
) -> Result<()> {
    configure_target_ca_from(command, program, &std::env::current_dir()?, |key| {
        std::env::var_os(key)
    });
    Ok(())
}

fn configure_target_ca_from(
    command: &mut std::process::Command,
    program: &str,
    cwd: &std::path::Path,
    lookup: impl Fn(&str) -> Option<OsString>,
) {
    let path = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| lookup(key).filter(|v| !v.is_empty()))
            .map(|value| {
                let value = std::path::PathBuf::from(value);
                if value.is_absolute() {
                    value
                } else {
                    cwd.join(value)
                }
            })
    };
    for key in ["SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"] {
        if let Some(value) = path(&[key]) {
            command.env(key, value);
        }
    }
    if program == "git" {
        if let Some(value) = path(&["GIT_SSL_CAINFO", "SSL_CERT_FILE", "CURL_CA_BUNDLE"]) {
            command.env("GIT_SSL_CAINFO", value);
            // Git for Windows may use Schannel; honor an explicitly supplied CA
            // instead of silently ignoring it in favor of only the native store.
            command.args(["-c", "http.schannelUseSSLCAInfo=true"]);
        }
        if let Some(value) = path(&["GIT_SSL_CAPATH", "SSL_CERT_DIR"]) {
            command.env("GIT_SSL_CAPATH", value);
        }
        if let Some(value) = path(&["GIT_PROXY_SSL_CAINFO", "SSL_CERT_FILE", "CURL_CA_BUNDLE"]) {
            command.env("GIT_PROXY_SSL_CAINFO", value);
        }
    } else if program == "npm" {
        if let Some(value) = path(&["npm_config_cafile", "NPM_CONFIG_CAFILE"]) {
            command.env("npm_config_cafile", value);
        }
        if let Some(value) = path(&["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "CURL_CA_BUNDLE"]) {
            command.env("NODE_EXTRA_CA_CERTS", value);
        }
        command.env("npm_config_strict_ssl", "true");
    }
}

/// Stable classification for the protocol/UI. Diagnostics remain available as detail.
pub fn plugin_network_error_kind(message: &str) -> Option<&'static str> {
    let message = message.to_ascii_lowercase();
    if message.contains("invalid plugin proxy") || message.contains("invalid git proxy") {
        return Some("proxy_invalid");
    }
    if message.contains("could not resolve proxy")
        || message.contains("proxy connect aborted")
        || message.contains("proxy authentication")
        || message.contains("407")
    {
        return Some("proxy_failed");
    }
    if message.contains("could not resolve host") {
        return Some("network_dns");
    }
    if message.contains("certificate") || message.contains("ssl peer") {
        return Some("network_tls");
    }
    if message.contains("authentication failed")
        || message.contains("could not read username")
        || message.contains("repository not found")
    {
        return Some("source_auth_or_missing");
    }
    if message.contains("connection reset")
        || message.contains("connection was reset")
        || message.contains("recv failure")
        || message.contains("remote end hung up")
        || message.contains("early eof")
        || message.contains("http/2")
        || message.contains("http2")
    {
        return Some("network_reset");
    }
    if message.contains("failed to connect")
        || message.contains("couldn't connect")
        || message.contains("connection refused")
    {
        return Some("network_unreachable");
    }
    if message.contains("timed out") || message.contains("operation too slow") {
        return Some("network_timeout");
    }
    None
}

pub(crate) fn transient(error: &anyhow::Error) -> bool {
    matches!(
        plugin_network_error_kind(&format!("{error:#}")),
        Some("network_reset" | "network_unreachable" | "network_timeout")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_ca_paths_are_allowlisted_and_program_specific() {
        use std::ffi::OsStr;
        let cwd = std::env::current_dir().unwrap();
        let lookup = |key: &str| match key {
            "GIT_SSL_CAINFO" => Some(OsString::from("git.pem")),
            "SSL_CERT_FILE" => Some(OsString::from("generic.pem")),
            "SSL_CERT_DIR" => Some(OsString::from("certs")),
            "NODE_EXTRA_CA_CERTS" => Some(OsString::from("node.pem")),
            "NPM_CONFIG_CAFILE" => Some(OsString::from("npm.pem")),
            "GIT_SSL_NO_VERIFY" | "NODE_TLS_REJECT_UNAUTHORIZED" | "GIT_CONFIG_GLOBAL" => {
                Some(OsString::from("unsafe"))
            }
            _ => None,
        };
        let mut git = std::process::Command::new("git");
        git.env_clear();
        configure_target_ca_from(&mut git, "git", &cwd, lookup);
        let env = git.get_envs().collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            env[OsStr::new("GIT_SSL_CAINFO")],
            Some(cwd.join("git.pem").as_os_str())
        );
        assert_eq!(
            env[OsStr::new("GIT_SSL_CAPATH")],
            Some(cwd.join("certs").as_os_str())
        );
        assert!(!env.contains_key(OsStr::new("GIT_SSL_NO_VERIFY")));
        assert!(!env.contains_key(OsStr::new("GIT_CONFIG_GLOBAL")));
        assert!(!env.contains_key(OsStr::new("NODE_EXTRA_CA_CERTS")));
        let mut npm = std::process::Command::new("npm");
        npm.env_clear();
        configure_target_ca_from(&mut npm, "npm", &cwd, lookup);
        let env = npm.get_envs().collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            env[OsStr::new("NODE_EXTRA_CA_CERTS")],
            Some(cwd.join("node.pem").as_os_str())
        );
        assert_eq!(
            env[OsStr::new("npm_config_cafile")],
            Some(cwd.join("npm.pem").as_os_str())
        );
        assert_eq!(
            env[OsStr::new("npm_config_strict_ssl")],
            Some(OsStr::new("true"))
        );
        assert!(!env.contains_key(OsStr::new("NODE_TLS_REJECT_UNAUTHORIZED")));
        assert!(!env.contains_key(OsStr::new("GIT_SSL_CAINFO")));
    }

    #[test]
    fn classifies_actionable_failures_without_treating_auth_as_transient() {
        assert_eq!(
            plugin_network_error_kind("fatal: Recv failure: Connection was reset"),
            Some("network_reset")
        );
        assert_eq!(
            plugin_network_error_kind("Could not resolve proxy: proxy"),
            Some("proxy_failed")
        );
        assert_eq!(
            plugin_network_error_kind("SSL certificate problem"),
            Some("network_tls")
        );
        assert!(!transient(&anyhow::anyhow!("Authentication failed")));
    }
    #[test]
    fn validates_proxy_without_echoing_credentials() {
        validate_plugin_proxy("socks5h://127.0.0.1:1080").unwrap();
        let error = validate_plugin_proxy("http://user:private-secret@host:8080")
            .unwrap_err()
            .to_string();
        assert!(!error.contains("private-secret"));
        assert!(validate_plugin_proxy("file:///etc/passwd").is_err());
    }
}
