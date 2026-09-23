//! Explicit, debug-only Gateway verification. Remote pages receive no native permissions.

#[derive(Clone, Default)]
pub(crate) struct GatewayVerification(pub(crate) Option<GatewaySession>);

#[derive(Clone)]
pub(crate) struct GatewaySession {
    pub(crate) origin: tauri::Url,
    control_url: String,
    token: String,
}

fn parse_loopback_origin(value: &str) -> Result<tauri::Url, String> {
    let invalid = || "Gateway verification requires a canonical loopback origin".to_string();
    let port = value
        .strip_prefix("http://127.0.0.1:")
        .filter(|port| !port.is_empty() && !port.starts_with('0'))
        .filter(|port| port.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|port| port.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .ok_or_else(invalid)?;
    tauri::Url::parse(&format!("http://127.0.0.1:{port}")).map_err(|_| invalid())
}

impl GatewayVerification {
    pub(crate) fn from_environment() -> Result<Self, String> {
        let Some(origin) = std::env::var_os("KCODER_STUDIO_AI_VERIFY_GATEWAY_ORIGIN") else {
            return Ok(Self::default());
        };
        if !cfg!(debug_assertions) {
            return Err("Gateway verification is only available in debug builds".into());
        }
        let origin = parse_loopback_origin(&origin.to_string_lossy())?;
        let control_url = std::env::var("KCODER_STUDIO_AI_VERIFY_CONTROL_URL")
            .map_err(|_| "Missing verification controller".to_string())?;
        let control = parse_loopback_origin(&control_url)?;
        if control.origin() == origin.origin() {
            return Err("Verification controller must have a separate origin".into());
        }
        let token = std::env::var("KCODER_STUDIO_AI_VERIFY_CONTROL_TOKEN")
            .map_err(|_| "Missing verification token".to_string())?;
        if token.len() < 32 || !token.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err("Invalid verification token".into());
        }
        Ok(Self(Some(GatewaySession {
            origin,
            control_url,
            token,
        })))
    }
}

impl GatewaySession {
    pub(crate) fn allows_navigation(&self, url: &tauri::Url) -> bool {
        url.origin() == self.origin.origin()
            && url.username().is_empty()
            && url.password().is_none()
    }

    pub(crate) fn initialization_script(&self) -> String {
        let config = serde_json::json!({
            "origin": self.origin.origin().ascii_serialization(),
            "controlUrl": self.control_url,
            "token": self.token,
        });
        include_str!("ai_verify_bootstrap.js").replace("__KCODER_VERIFY_CONFIG__", &config.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_external_alias_credential_and_path_origins() {
        for origin in [
            "https://127.0.0.1:1234",
            "http://localhost:1234",
            "http://127.1:1234",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:01234",
            "http://127.0.0.1:1234/",
            "http://127.0.0.1:1234?secret=token",
            "http://user@127.0.0.1:1234",
            "http://example.com:1234",
            "file:///tmp/app",
        ] {
            assert!(parse_loopback_origin(origin).is_err(), "accepted {origin}");
        }
    }

    #[test]
    fn navigation_is_locked_to_the_exact_session_origin() {
        let session = GatewaySession {
            origin: parse_loopback_origin("http://127.0.0.1:1234").unwrap(),
            control_url: "http://127.0.0.1:1235".into(),
            token: "session-token".into(),
        };
        assert!(session
            .allows_navigation(&tauri::Url::parse("http://127.0.0.1:1234/settings").unwrap()));
        for url in [
            "http://127.0.0.1:1235/",
            "http://localhost:1234/",
            "https://example.com/",
            "tauri://localhost/",
        ] {
            assert!(!session.allows_navigation(&tauri::Url::parse(url).unwrap()));
        }
        assert!(session
            .initialization_script()
            .contains("window !== window.top"));
        assert!(session
            .initialization_script()
            .contains("writable: false, configurable: false"));
    }
}
