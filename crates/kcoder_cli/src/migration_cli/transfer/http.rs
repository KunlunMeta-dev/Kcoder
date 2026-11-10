//! Existing Gateway sessions own authentication; this transport never handles account passwords.
use anyhow::{Result, ensure};
use reqwest::{
    Client as HttpClient, Url,
    header::{AUTHORIZATION, HeaderValue},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{net::IpAddr, time::Duration};

const MAX_RESPONSE: usize = 2 * 1024 * 1024;

pub(super) struct Client {
    base: Url,
    http: HttpClient,
    access_env: String,
    authorization: HeaderValue,
}
impl Client {
    pub fn open(base: &str, access_env: &str) -> Result<Self> {
        let base = gateway_url(base)?;
        ensure!(
            !access_env.is_empty()
                && access_env.len() <= 128
                && access_env.bytes().enumerate().all(|(i, b)| b == b'_'
                    || b.is_ascii_alphabetic()
                    || i > 0 && b.is_ascii_digit()),
            "source_transfer_invalid_access_token_reference"
        );
        let token = std::env::var(access_env)
            .map_err(|_| anyhow::anyhow!("source_transfer_gateway_login_required"))?;
        ensure!(
            (32..=128).contains(&token.len())
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
            "source_transfer_gateway_login_required"
        );
        let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| anyhow::anyhow!("source_transfer_gateway_login_required"))?;
        authorization.set_sensitive(true);
        let http = HttpClient::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| anyhow::anyhow!("source_transfer_http_unavailable"))?;
        Ok(Self {
            base,
            http,
            access_env: access_env.into(),
            authorization,
        })
    }
    pub(super) fn current(&self) -> Result<()> {
        let current = std::env::var(&self.access_env)
            .map_err(|_| anyhow::anyhow!("source_transfer_authority_changed"))?;
        ensure!(
            self.authorization.as_bytes().strip_prefix(b"Bearer ") == Some(current.as_bytes()),
            "source_transfer_authority_changed"
        );
        Ok(())
    }
    pub(super) fn runtime_authority(&self) -> Result<(Url, HeaderValue)> {
        self.current()?;
        Ok((self.base.clone(), self.authorization.clone()))
    }
    pub async fn post<P: Serialize, R: DeserializeOwned>(
        &self,
        lane: &str,
        operation: &str,
        params: &P,
    ) -> Result<R> {
        let permitted = match lane {
            "source-session" => matches!(operation, "open" | "read" | "close" | "query"),
            "source-transfer/private" => matches!(
                operation,
                "candidates"
                    | "run"
                    | "read"
                    | "source-read"
                    | "prepare-status"
                    | "cancel"
                    | "resume"
                    | "prepare"
                    | "release"
            ),
            "source-transfer" => matches!(
                operation,
                "run"
                    | "read"
                    | "cancel"
                    | "target-read"
                    | "target-cancel"
                    | "target-resume"
                    | "target-finish"
                    | "received"
                    | "adoption-prepare"
                    | "adoption-read"
                    | "adoption-resume"
                    | "adoption-cancel"
            ),
            _ => false,
        };
        ensure!(permitted, "source_transfer_method_unavailable");
        let body = serde_json::to_vec(params)
            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_request"))?;
        ensure!(
            body.len()
                <= if lane == "source-transfer/private" {
                    256 * 1024
                } else {
                    64 * 1024
                },
            "source_transfer_request_budget_exceeded"
        );
        self.current()?;
        let url = self
            .base
            .join(&format!("api/migration/{lane}/{operation}"))
            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_gateway_url"))?;
        let response = self
            .http
            .post(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("source_transfer_outcome_unknown"))?;
        self.decode(response, lane == "source-transfer/private")
            .await
    }
    pub async fn servers(&self) -> Result<Value> {
        self.current()?;
        let url = self
            .base
            .join("api/servers")
            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_gateway_url"))?;
        let response = self
            .http
            .get(url)
            .header(AUTHORIZATION, self.authorization.clone())
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("source_transfer_outcome_unknown"))?;
        self.decode(response, false).await
    }
    async fn decode<R: DeserializeOwned>(
        &self,
        mut response: reqwest::Response,
        private: bool,
    ) -> Result<R> {
        self.current()?;
        let success = response.status().is_success();
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        while let Some(part) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("source_transfer_outcome_unknown"))?
        {
            self.current()?;
            ensure!(
                bytes
                    .len()
                    .checked_add(part.len())
                    .is_some_and(|length| length <= MAX_RESPONSE),
                "source_transfer_response_budget_exceeded"
            );
            bytes.extend_from_slice(&part);
        }
        self.current()?;
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_response"))?;
        if !success {
            if matches!(status, 401 | 403) {
                anyhow::bail!("source_transfer_gateway_login_or_permission_required");
            }
            if private
                && let Some(code) = value.get("error").and_then(Value::as_str)
                && serde_json::from_value::<kcoder_app_protocol::MigrationSourceCredentialError>(
                    Value::String(code.into()),
                )
                .is_ok()
            {
                anyhow::bail!("{code}");
            }
            if let Some(code) = value.get("error").and_then(Value::as_str).filter(|code| {
                code.starts_with("source_transfer_")
                    && code.len() <= 128
                    && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            }) {
                anyhow::bail!("{code}");
            }
            anyhow::bail!("source_transfer_outcome_unknown");
        }
        serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("source_transfer_invalid_response"))
    }
}

pub(super) fn rpc_marker(name: Option<&str>) -> Result<String> {
    let Some(name) = name else {
        return Ok("cookie-auth".into());
    };
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && name
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || i > 0 && b.is_ascii_digit()),
        "migration_remote_invalid_rpc_marker_reference"
    );
    let value =
        std::env::var(name).map_err(|_| anyhow::anyhow!("migration_remote_rpc_login_required"))?;
    ensure!(
        !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "migration_remote_rpc_login_required"
    );
    Ok(value)
}

fn gateway_url(value: &str) -> Result<Url> {
    let mut url =
        Url::parse(value).map_err(|_| anyhow::anyhow!("source_transfer_invalid_gateway_url"))?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    ensure!(
        (url.scheme() == "https" || url.scheme() == "http" && loopback)
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "source_transfer_secure_gateway_required"
    );
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gateway_urls_preserve_prefix_but_refuse_credentials_redirect_inputs_and_plaintext_remote_hosts()
     {
        assert_eq!(
            gateway_url("https://gateway.invalid/relay/prefix")
                .unwrap()
                .join("api/servers")
                .unwrap()
                .as_str(),
            "https://gateway.invalid/relay/prefix/api/servers"
        );
        assert!(gateway_url("http://127.0.0.1:1234").is_ok());
        assert!(gateway_url("http://[::1]:1234").is_ok());
        for url in [
            "http://remote.invalid",
            "https://user:SECRET@gateway.invalid/",
            "https://gateway.invalid/?token=SECRET",
            "https://gateway.invalid/#SECRET",
            "file:///private",
        ] {
            let error = gateway_url(url).unwrap_err().to_string();
            assert!(!error.contains("SECRET"));
        }
    }
}
