//! Plaintext-endpoint policy shared by validation, warnings and clients.
//!
//! A model endpoint reached over plain HTTP outside loopback exposes prompts
//! and completions to the local network, so callers warn (or ask for explicit
//! confirmation) instead of failing silently.

/// True when `endpoint` uses plain HTTP to a host other than loopback.
pub fn is_plaintext_remote_endpoint(endpoint: &str) -> bool {
    let Some(rest) = endpoint.trim().strip_prefix("http://") else {
        return false;
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = match authority.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or("").to_string(),
        None => authority
            .split(':')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase(),
    };
    !is_loopback_host(&host)
}

fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" || host == "::1" {
        return true;
    }
    match host.parse::<std::net::Ipv4Addr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_plain_http_is_allowed() {
        for endpoint in [
            "http://127.0.0.1:8000/v1",
            "http://localhost:11434/v1",
            "http://[::1]:8080/v1",
            "http://127.9.9.9/v1",
        ] {
            assert!(!is_plaintext_remote_endpoint(endpoint), "{endpoint}");
        }
    }

    #[test]
    fn plain_http_outside_loopback_is_flagged() {
        for endpoint in [
            "http://10.31.6.8",
            "http://192.168.1.5:8080/v1",
            "http://example.com/v1",
            "http://user:pass@gateway.internal:8080/v1",
        ] {
            assert!(is_plaintext_remote_endpoint(endpoint), "{endpoint}");
        }
    }

    #[test]
    fn https_and_other_schemes_are_not_flagged() {
        for endpoint in [
            "https://api.example.com/v1",
            "ftp://example.com",
            "10.31.6.8",
        ] {
            assert!(!is_plaintext_remote_endpoint(endpoint), "{endpoint}");
        }
    }
}
